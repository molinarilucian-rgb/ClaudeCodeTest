import { stdDev } from '../utils/indicators.js';

/**
 * Phase 4 — performance metrics (PURE math, no I/O).
 * --------------------------------------------------
 * Turns closed-trade rows into per-variation and cumulative performance numbers.
 * Kept side-effect free so every formula is unit-testable against hand-computed
 * fixtures. The DB layer (performanceDb.js) and the report writers consume this.
 *
 * "Phase 4 is READ ONLY from the trading perspective" — nothing here ever touches
 * the broker, orders, or live positions; it only reads finished trades.
 */

export const OR_TIMEFRAMES = [5, 15, 30];
export const RR_RATIOS = [1.0, 1.5, 2.0];

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Canonical strategy key: (5,1.0)→"5m_rr1", (15,1.5)→"15m_rr15", (30,2.0)→"30m_rr2". */
export function strategyKey(timeframe, rr) {
  return `${timeframe}m_rr${String(rr).replace('.', '')}`;
}

/** Human label: (5,1.0)→"5m 1:1", (15,1.5)→"15m 1:1.5". */
export function strategyLabel(timeframe, rr) {
  return `${timeframe}m 1:${rr}`;
}

/** Fixed-width label for aligned tables: "5m  1:1  ", "15m 1:1.5", "30m 1:2  ". */
export function strategyLabelPadded(timeframe, rr) {
  return `${`${timeframe}m`.padEnd(3)} ${`1:${rr}`.padEnd(5)}`;
}

/** All 9 variations in canonical order (timeframe outer, rr inner). */
export function allStrategyVariations() {
  const out = [];
  for (const timeframe of OR_TIMEFRAMES) {
    for (const rr of RR_RATIOS) {
      out.push({
        timeframe, rr,
        key: strategyKey(timeframe, rr),
        label: strategyLabel(timeframe, rr),
        labelPadded: strategyLabelPadded(timeframe, rr),
      });
    }
  }
  return out;
}

// Engine exit reasons → the spec's reporting vocabulary.
const EXIT_REASON_MAP = {
  TARGET: 'target_hit',
  STOP: 'stop_hit',
  KILL_SWITCH: 'kill_switch',
  EOD_CLOSE: 'eod_close',
};

/** Map an engine exit_reason to the report vocabulary; unknown reasons lower-cased. */
export function normalizeExitReason(reason) {
  if (!reason) return null;
  return EXIT_REASON_MAP[reason] || String(reason).toLowerCase();
}

/**
 * Normalize a raw closed-trade DB row (trades LEFT JOIN signals) into a flat
 * strategy_performance record. `duration_minutes` is derived from entry→exit.
 */
export function toPerformanceRecord(t) {
  const entryMs = t.entry_time ? Date.parse(t.entry_time) : NaN;
  const exitMs = t.exit_time ? Date.parse(t.exit_time) : NaN;
  const durationMinutes = Number.isFinite(entryMs) && Number.isFinite(exitMs)
    ? Math.max(0, Math.round((exitMs - entryMs) / 60000))
    : null;

  return {
    tradeId: t.trade_id,
    date: t.date,
    symbol: t.symbol,
    direction: t.direction,
    orTimeframe: t.or_timeframe,
    rrRatio: t.rr_ratio,
    strategyKey: strategyKey(t.or_timeframe, t.rr_ratio),
    entryPrice: t.entry_price,
    stopPrice: t.stop_price,
    targetPrice: t.target_price,
    exitPrice: t.exit_price,
    shares: t.shares,
    riskAmount: t.risk_amount,
    pnl: t.pnl,
    rMultiple: t.r_multiple,
    exitReason: normalizeExitReason(t.exit_reason),
    // Enriched from the signals table (LEFT JOIN); fall back to the trade's own gap.
    signalQualityScore: t.signal_quality_score ?? null,
    volumeRatio: t.signal_volume_ratio ?? null,
    gapPct: t.signal_gap_pct ?? t.gap_pct ?? null,
    entryTime: t.entry_time ?? null,
    exitTime: t.exit_time ?? null,
    durationMinutes,
  };
}

/**
 * Max drawdown of the running cumulative P&L over trades in the given order.
 * Returns a positive dollar magnitude (0 when equity never dips below its peak).
 */
export function maxDrawdown(pnls) {
  let peak = 0, cum = 0, maxDd = 0;
  for (const p of pnls) {
    cum += p;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
  }
  return round2(maxDd);
}

/**
 * Core performance stats for a set of records (assumed chronological for
 * drawdown). A win is pnl>0, a loss pnl<0; pnl==0 is a breakeven (counted in
 * trades but neither win nor loss).
 *
 * profitFactor: grossProfit / grossLoss. `null` means "no losing trades" (an
 * undefined/infinite ratio) — reports render it as "∞". 0 means no trades.
 * sharpeRatio: mean / stdev of the per-trade R-multiple series (per-trade, not
 * annualized); `null` when there are <2 trades or zero variance.
 */
export function computeStats(records) {
  const n = records.length;
  if (n === 0) {
    return {
      trades: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0,
      avgWin: 0, avgLoss: 0, profitFactor: 0, expectancy: 0,
      avgRMultiple: 0, maxDrawdown: 0, sharpeRatio: null,
      bestTradePnl: 0, worstTradePnl: 0,
    };
  }
  const pnls = records.map((r) => r.pnl ?? 0);
  const rs = records.map((r) => r.rMultiple ?? 0);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);

  const totalPnl = round2(pnls.reduce((a, b) => a + b, 0));
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));

  const winRate = round2((wins.length / n) * 100);
  const avgWin = wins.length ? round2(grossProfit / wins.length) : 0;
  const avgLoss = losses.length ? round2(grossLoss / losses.length) : 0; // positive magnitude
  const profitFactor = grossLoss > 0
    ? round2(grossProfit / grossLoss)
    : (grossProfit > 0 ? null : 0); // null = no losses (infinite PF)
  const expectancy = round2(totalPnl / n); // avg P&L per trade
  const avgRMultiple = round2(rs.reduce((a, b) => a + b, 0) / n);

  const sd = n > 1 ? stdDev(rs) : null;
  const sharpeRatio = sd && sd > 0 ? round2(avgRMultiple / sd) : null;

  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    winRate,
    totalPnl,
    avgWin,
    avgLoss,
    profitFactor,
    expectancy,
    avgRMultiple,
    maxDrawdown: maxDrawdown(pnls),
    sharpeRatio,
    bestTradePnl: round2(Math.max(...pnls)),
    worstTradePnl: round2(Math.min(...pnls)),
  };
}

/** Group records by strategyKey → computeStats per key. Returns { key: stats }. */
export function summarizeByStrategy(records) {
  const groups = new Map();
  for (const r of records) {
    if (!groups.has(r.strategyKey)) groups.set(r.strategyKey, []);
    groups.get(r.strategyKey).push(r);
  }
  const out = {};
  for (const [key, list] of groups) out[key] = computeStats(list);
  return out;
}

/**
 * The full 9-row variation grid: every variation, with its stats (zeroed when it
 * had no trades). Always returns 9 rows in canonical order — the display/report
 * side-by-side comparison renders this directly.
 */
export function strategyGrid(records) {
  const byKey = summarizeByStrategy(records);
  return allStrategyVariations().map((v) => ({
    ...v,
    stats: byKey[v.key] ?? computeStats([]),
  }));
}

/**
 * Pick the best-performing variation among those with ≥1 trade. Primary sort by
 * total P&L, tie-break by win rate then trade count. Returns null when nothing
 * traded.
 */
export function bestStrategy(grid) {
  const traded = grid.filter((g) => g.stats.trades > 0);
  if (!traded.length) return null;
  return traded.sort((a, b) =>
    b.stats.totalPnl - a.stats.totalPnl ||
    b.stats.winRate - a.stats.winRate ||
    b.stats.trades - a.stats.trades
  )[0];
}

/** Worst-performing traded variation (mirror of bestStrategy). */
export function worstStrategy(grid) {
  const traded = grid.filter((g) => g.stats.trades > 0);
  if (!traded.length) return null;
  return traded.sort((a, b) =>
    a.stats.totalPnl - b.stats.totalPnl ||
    a.stats.winRate - b.stats.winRate ||
    b.stats.trades - a.stats.trades
  )[0];
}

export default {
  OR_TIMEFRAMES, RR_RATIOS,
  strategyKey, strategyLabel, strategyLabelPadded, allStrategyVariations,
  normalizeExitReason, toPerformanceRecord,
  maxDrawdown, computeStats, summarizeByStrategy, strategyGrid,
  bestStrategy, worstStrategy,
};
