import logger from '../utils/logger.js';
import { etDateStr } from '../utils/timeUtils.js';
import { getWatchlist, getTradesForDate } from '../data/database.js';
import {
  RR_RATIOS, strategyGrid, computeStats, bestStrategy, worstStrategy,
  allStrategyVariations,
} from './metrics.js';
import {
  getClosedTradeRecordsForDate, getSignalsForDate,
  upsertStrategyPerformance, upsertDailySummary, rebuildCumulativeStats,
  countTradingDaysTracked, getDailyWatchlistStats,
} from './performanceDb.js';
import { writeReports } from './reportFiles.js';

/**
 * Phase 4 — daily report orchestrator.
 * Gathers the day's closed trades + context, persists analytics to the three
 * Phase 4 tables, writes the three report files, and returns a structured
 * payload the Discord layer formats. READ ONLY w.r.t. trading: it never touches
 * the broker or live positions. Designed to be wrapped in try/catch by callers
 * so a reporting failure can never crash the bot.
 */

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const signedMoney = (n) => (n == null ? '—' : `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`);

/** Compute the 3 RR targets a signal implied (entry ± risk × rr). */
function signalTargets(s) {
  const risk = Math.abs((s.entry_price ?? 0) - (s.stop_price ?? 0));
  return RR_RATIOS.map((rr) =>
    s.direction === 'long' ? round2(s.entry_price + risk * rr) : round2(s.entry_price - risk * rr)
  );
}

/** Summarize the outcome of a signal from its (up to 3) trade legs. */
function signalOutcome(legs) {
  const closed = legs.filter((l) => l.status === 'closed');
  const open = legs.filter((l) => l.status === 'pending' || l.status === 'open').length;
  const cancelled = legs.filter((l) => l.status === 'cancelled').length;
  const wins = closed.filter((l) => (l.pnl ?? 0) > 0).length;
  const losses = closed.filter((l) => (l.pnl ?? 0) < 0).length;
  const net = round2(closed.reduce((a, l) => a + (l.pnl ?? 0), 0));
  if (!legs.length) return 'no positions opened';
  const parts = [`${wins}W/${losses}L`];
  if (open) parts.push(`${open} open`);
  if (cancelled) parts.push(`${cancelled} unfilled`);
  parts.push(`net ${signedMoney(net)}`);
  return parts.join(' · ');
}

function describeMarket(watchlist) {
  if (!watchlist.length) return 'no qualifying gaps — empty watchlist';
  const ups = watchlist.filter((w) => (w.gapPct ?? 0) > 0).length;
  const downs = watchlist.filter((w) => (w.gapPct ?? 0) < 0).length;
  const avgAbs = watchlist.reduce((a, w) => a + Math.abs(w.gapPct ?? 0), 0) / watchlist.length;
  return `${watchlist.length} stocks monitored · ${ups} gap-up / ${downs} gap-down · avg |gap| ${avgAbs.toFixed(2)}%`;
}

/**
 * Build the report payload + persist analytics + write files.
 * @param {object} [opts]
 * @param {string} [opts.date] ET date (defaults to today)
 * @param {boolean} [opts.write=true] write the three files (false = compute only)
 * @returns {{ data: object, paths: object|null }}
 */
export function generateDailyReport({ date = etDateStr(), write = true } = {}) {
  const records = getClosedTradeRecordsForDate(date);
  const allTrades = getTradesForDate(date);
  const signalsRaw = getSignalsForDate(date);
  const watchlist = getWatchlist(date)
    .filter((r) => r.selected)
    .map((r) => ({ symbol: r.symbol, gapPct: r.gap_pct, catalyst: r.catalyst_type }));

  // Persist one strategy_performance row per closed trade (idempotent).
  for (const r of records) {
    try { upsertStrategyPerformance(r); }
    catch (err) { logger.warn(`strategy_performance upsert failed for ${r.tradeId}: ${err.message}`); }
  }

  // Today's 9-variation grid + persist per-variation daily_summary (traded keys).
  const grid = strategyGrid(records);
  for (const g of grid) {
    if (g.stats.trades > 0) {
      try { upsertDailySummary(date, g.key, g.stats); }
      catch (err) { logger.warn(`daily_summary upsert failed for ${g.key}: ${err.message}`); }
    }
  }

  const overall = computeStats(records);
  const best = bestStrategy(grid);
  const worst = worstStrategy(grid);
  const bestTrade = records.length
    ? records.reduce((a, b) => ((b.pnl ?? 0) > (a.pnl ?? 0) ? b : a))
    : null;
  const worstTrade = records.length
    ? records.reduce((a, b) => ((b.pnl ?? 0) < (a.pnl ?? 0) ? b : a))
    : null;

  // Signals with computed targets + per-signal outcome.
  const confirmed = signalsRaw.filter((s) => (s.status ?? 'confirmed') === 'confirmed');
  const signals = confirmed.map((s) => {
    const legs = allTrades.filter((t) =>
      t.symbol === s.symbol && t.or_timeframe === s.timeframe && t.direction === s.direction);
    return {
      symbol: s.symbol, timeframe: s.timeframe, direction: s.direction,
      entryPrice: s.entry_price, stopPrice: s.stop_price, targets: signalTargets(s),
      qualityScore: s.quality_score, outcome: signalOutcome(legs),
    };
  });

  const pending = allTrades.filter((t) => t.status === 'pending' || t.status === 'open').length;
  const outcomes = { wins: overall.wins, losses: overall.losses, pending };

  // Gap-reversal watchlist stats (persisted by the scan that runs just before
  // this report). Normalized to camelCase + a symbols array; null if not scanned.
  const grRow = getDailyWatchlistStats(date);
  const gapReversal = grRow ? {
    watchlistCount: grRow.watchlist_count,
    gapDownCount: grRow.gap_down_count,
    gapReversalCount: grRow.gap_reversal_count,
    untradedReversalCount: grRow.untraded_reversal_count,
    reversalSymbols: grRow.reversal_symbols ? grRow.reversal_symbols.split(',').filter(Boolean) : [],
  } : null;

  // Cumulative (all-time) — recompute from every closed trade and persist.
  // rebuildCumulativeStats returns the flat record list AND per-key stats.
  const { records: cumRecords, byKey: cumByKey } = rebuildCumulativeStats();
  const cumGrid = allStrategyVariations().map((v) => ({ ...v, stats: cumByKey[v.key] ?? computeStats([]) }));
  const cumulative = {
    tradingDays: countTradingDaysTracked(),
    overall: computeStats(cumRecords),
    grid: cumGrid,
    best: bestStrategy(cumGrid),
  };

  const data = {
    date,
    hasTrades: records.length > 0,
    marketConditions: describeMarket(watchlist),
    watchlist,
    signals,
    signalsCount: confirmed.length,
    outcomes,
    gapReversal,
    records,
    grid,
    overall,
    best,
    worst,
    bestTrade,
    worstTrade,
    cumulative,
  };

  let paths = null;
  if (write) paths = writeReports(data);
  return { data, paths };
}

export default { generateDailyReport };
