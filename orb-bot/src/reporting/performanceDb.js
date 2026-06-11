import { db, getOpenPositions } from '../data/database.js';
import logger from '../utils/logger.js';
import {
  toPerformanceRecord, computeStats, strategyKey,
} from './metrics.js';

/**
 * Phase 4 — analytics persistence.
 * --------------------------------
 * ADDITIVE only: creates three new tables on the SAME SQLite connection that
 * Phases 1–3 use, and never modifies their tables or logic. It reads finished
 * trades (joined with their signal context) and writes rolled-up analytics.
 *
 * Tables:
 *   strategy_performance — one row per closed trade (denormalized + enriched)
 *   daily_summary        — one row per (date, strategy_key)
 *   cumulative_stats     — one row per strategy_key, all-time, recomputed each run
 */

db.exec(`
CREATE TABLE IF NOT EXISTS strategy_performance (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id             TEXT UNIQUE,
  date                 TEXT NOT NULL,
  symbol               TEXT NOT NULL,
  direction            TEXT,
  or_timeframe         INTEGER,
  rr_ratio             REAL,
  strategy_key         TEXT,
  entry_price          REAL,
  stop_price           REAL,
  target_price         REAL,
  exit_price           REAL,
  shares               INTEGER,
  risk_amount          REAL,
  pnl                  REAL,
  r_multiple           REAL,
  exit_reason          TEXT,
  signal_quality_score REAL,
  volume_ratio         REAL,
  gap_pct              REAL,
  entry_time           TEXT,
  exit_time            TEXT,
  duration_minutes     INTEGER,
  created_at           TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS daily_summary (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  date            TEXT NOT NULL,
  strategy_key    TEXT NOT NULL,
  trades_count    INTEGER,
  wins            INTEGER,
  losses          INTEGER,
  win_rate        REAL,
  total_pnl       REAL,
  avg_win         REAL,
  avg_loss        REAL,
  profit_factor   REAL,
  expectancy      REAL,
  max_drawdown    REAL,
  avg_r_multiple  REAL,
  best_trade_pnl  REAL,
  worst_trade_pnl REAL,
  created_at      TEXT DEFAULT (datetime('now')),
  UNIQUE(date, strategy_key)
);

CREATE TABLE IF NOT EXISTS cumulative_stats (
  strategy_key    TEXT PRIMARY KEY,
  total_trades    INTEGER,
  total_wins      INTEGER,
  total_losses    INTEGER,
  cumulative_pnl  REAL,
  win_rate        REAL,
  profit_factor   REAL,
  expectancy      REAL,
  avg_r_multiple  REAL,
  max_drawdown    REAL,
  sharpe_ratio    REAL,
  last_updated    TEXT
);

CREATE TABLE IF NOT EXISTS daily_watchlist_stats (
  date                    TEXT PRIMARY KEY,
  watchlist_count         INTEGER,
  gap_down_count          INTEGER,
  gap_reversal_count      INTEGER,
  untraded_reversal_count INTEGER,
  reversal_symbols        TEXT,
  created_at              TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_strategy_perf_date ON strategy_performance(date);
CREATE INDEX IF NOT EXISTS idx_strategy_perf_key  ON strategy_performance(strategy_key);
`);

logger.info('Phase 4 analytics tables ready (strategy_performance, daily_summary, cumulative_stats, daily_watchlist_stats).');

// LEFT JOIN closed trades onto their originating signal so each performance row
// carries quality score / volume ratio / gap. Signals are keyed by
// (date, symbol, timeframe, direction) which maps to the trade's or_timeframe.
const CLOSED_TRADE_SELECT = `
  SELECT t.*,
         s.quality_score AS signal_quality_score,
         s.volume_ratio  AS signal_volume_ratio,
         s.gap_pct       AS signal_gap_pct
  FROM trades t
  LEFT JOIN signals s
    ON s.date = t.date AND s.symbol = t.symbol
   AND s.timeframe = t.or_timeframe AND s.direction = t.direction
  WHERE t.status = 'closed'`;

/** Closed trades for one date, as enriched performance records (chronological). */
export function getClosedTradeRecordsForDate(date) {
  const rows = db.prepare(`${CLOSED_TRADE_SELECT} AND t.date = ? ORDER BY t.exit_time ASC, t.opened_at ASC`).all(date);
  return rows.map(toPerformanceRecord);
}

/** Closed trades within [start, end] inclusive (for the weekly report). */
export function getClosedTradeRecordsForRange(startDate, endDate) {
  const rows = db.prepare(`${CLOSED_TRADE_SELECT} AND t.date BETWEEN ? AND ? ORDER BY t.date ASC, t.exit_time ASC`).all(startDate, endDate);
  return rows.map(toPerformanceRecord);
}

/** All closed trades ever, chronological — basis for cumulative stats. */
export function getAllClosedTradeRecords() {
  const rows = db.prepare(`${CLOSED_TRADE_SELECT} ORDER BY t.date ASC, t.exit_time ASC, t.opened_at ASC`).all();
  return rows.map(toPerformanceRecord);
}

/** Upsert one strategy_performance row (idempotent on trade_id). */
export function upsertStrategyPerformance(r) {
  db.prepare(`
    INSERT INTO strategy_performance
      (trade_id, date, symbol, direction, or_timeframe, rr_ratio, strategy_key,
       entry_price, stop_price, target_price, exit_price, shares, risk_amount,
       pnl, r_multiple, exit_reason, signal_quality_score, volume_ratio, gap_pct,
       entry_time, exit_time, duration_minutes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(trade_id) DO UPDATE SET
      exit_price=excluded.exit_price, pnl=excluded.pnl, r_multiple=excluded.r_multiple,
      exit_reason=excluded.exit_reason, exit_time=excluded.exit_time,
      duration_minutes=excluded.duration_minutes,
      signal_quality_score=excluded.signal_quality_score,
      volume_ratio=excluded.volume_ratio, gap_pct=excluded.gap_pct
  `).run(
    r.tradeId, r.date, r.symbol, r.direction, r.orTimeframe, r.rrRatio, r.strategyKey,
    r.entryPrice ?? null, r.stopPrice ?? null, r.targetPrice ?? null, r.exitPrice ?? null,
    r.shares ?? null, r.riskAmount ?? null, r.pnl ?? null, r.rMultiple ?? null,
    r.exitReason ?? null, r.signalQualityScore ?? null, r.volumeRatio ?? null, r.gapPct ?? null,
    r.entryTime ?? null, r.exitTime ?? null, r.durationMinutes ?? null
  );
}

/** Upsert one daily_summary row for (date, strategy_key). */
export function upsertDailySummary(date, key, s) {
  db.prepare(`
    INSERT INTO daily_summary
      (date, strategy_key, trades_count, wins, losses, win_rate, total_pnl,
       avg_win, avg_loss, profit_factor, expectancy, max_drawdown, avg_r_multiple,
       best_trade_pnl, worst_trade_pnl)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(date, strategy_key) DO UPDATE SET
      trades_count=excluded.trades_count, wins=excluded.wins, losses=excluded.losses,
      win_rate=excluded.win_rate, total_pnl=excluded.total_pnl, avg_win=excluded.avg_win,
      avg_loss=excluded.avg_loss, profit_factor=excluded.profit_factor,
      expectancy=excluded.expectancy, max_drawdown=excluded.max_drawdown,
      avg_r_multiple=excluded.avg_r_multiple, best_trade_pnl=excluded.best_trade_pnl,
      worst_trade_pnl=excluded.worst_trade_pnl
  `).run(
    date, key, s.trades, s.wins, s.losses, s.winRate, s.totalPnl,
    s.avgWin, s.avgLoss, s.profitFactor, s.expectancy, s.maxDrawdown, s.avgRMultiple,
    s.bestTradePnl, s.worstTradePnl
  );
}

/** Upsert one cumulative_stats row for a strategy_key. */
export function upsertCumulativeStat(key, s, lastUpdated) {
  db.prepare(`
    INSERT INTO cumulative_stats
      (strategy_key, total_trades, total_wins, total_losses, cumulative_pnl,
       win_rate, profit_factor, expectancy, avg_r_multiple, max_drawdown,
       sharpe_ratio, last_updated)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(strategy_key) DO UPDATE SET
      total_trades=excluded.total_trades, total_wins=excluded.total_wins,
      total_losses=excluded.total_losses, cumulative_pnl=excluded.cumulative_pnl,
      win_rate=excluded.win_rate, profit_factor=excluded.profit_factor,
      expectancy=excluded.expectancy, avg_r_multiple=excluded.avg_r_multiple,
      max_drawdown=excluded.max_drawdown, sharpe_ratio=excluded.sharpe_ratio,
      last_updated=excluded.last_updated
  `).run(
    key, s.trades, s.wins, s.losses, s.totalPnl, s.winRate, s.profitFactor,
    s.expectancy, s.avgRMultiple, s.maxDrawdown, s.sharpeRatio,
    lastUpdated ?? new Date().toISOString()
  );
}

/**
 * Recompute cumulative_stats from ALL closed trades and persist one row per
 * strategy_key that has traded. Returns { records, byKey } for callers/reports.
 */
export function rebuildCumulativeStats(lastUpdated) {
  const records = getAllClosedTradeRecords();
  const groups = new Map();
  for (const r of records) {
    if (!groups.has(r.strategyKey)) groups.set(r.strategyKey, []);
    groups.get(r.strategyKey).push(r);
  }
  const byKey = {};
  for (const [key, list] of groups) {
    const stats = computeStats(list);
    byKey[key] = stats;
    upsertCumulativeStat(key, stats, lastUpdated);
  }
  return { records, byKey };
}

/** Read all cumulative_stats rows (for stats.js / Discord), keyed by strategy_key. */
export function getCumulativeStats() {
  return db.prepare('SELECT * FROM cumulative_stats').all();
}

/** Read daily_summary rows for a date. */
export function getDailySummaries(date) {
  return db.prepare('SELECT * FROM daily_summary WHERE date = ? ORDER BY strategy_key').all(date);
}

/**
 * Upsert the day-level watchlist stats (gap-reversal tracking). One row per date
 * — a watchlist-wide metric, NOT per strategy_key, which is why it lives in its
 * own table rather than daily_summary. `reversalSymbols` is stored comma-joined.
 */
export function upsertDailyWatchlistStats(date, s) {
  db.prepare(`
    INSERT INTO daily_watchlist_stats
      (date, watchlist_count, gap_down_count, gap_reversal_count,
       untraded_reversal_count, reversal_symbols)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(date) DO UPDATE SET
      watchlist_count=excluded.watchlist_count, gap_down_count=excluded.gap_down_count,
      gap_reversal_count=excluded.gap_reversal_count,
      untraded_reversal_count=excluded.untraded_reversal_count,
      reversal_symbols=excluded.reversal_symbols
  `).run(
    date, s.watchlistCount ?? null, s.gapDownCount ?? null, s.gapReversalCount ?? null,
    s.untradedReversalCount ?? null, (s.reversalSymbols ?? []).join(',')
  );
}

/** Read the day-level watchlist stats row for a date (or undefined). */
export function getDailyWatchlistStats(date) {
  return db.prepare('SELECT * FROM daily_watchlist_stats WHERE date = ?').get(date);
}

/** Fired signals for a date (read-only on the Phase 2 signals table). */
export function getSignalsForDate(date) {
  return db.prepare('SELECT * FROM signals WHERE date = ? ORDER BY fired_at ASC').all(date);
}

/** Fired signals within [start, end] inclusive (read-only). */
export function getSignalsForRange(startDate, endDate) {
  return db.prepare('SELECT * FROM signals WHERE date BETWEEN ? AND ? ORDER BY date ASC, fired_at ASC').all(startDate, endDate);
}

/** Distinct trading days that have any recorded performance. */
export function countTradingDaysTracked() {
  return db.prepare('SELECT COUNT(DISTINCT date) AS n FROM strategy_performance').get().n;
}

/** Most recent N closed trades (for the stats command), newest first. */
export function getRecentPerformance(limit = 5) {
  return db.prepare(
    'SELECT * FROM strategy_performance ORDER BY exit_time DESC, id DESC LIMIT ?'
  ).all(limit);
}

export { getOpenPositions, strategyKey };

export default {
  getClosedTradeRecordsForDate, getClosedTradeRecordsForRange, getAllClosedTradeRecords,
  upsertStrategyPerformance, upsertDailySummary, upsertCumulativeStat,
  rebuildCumulativeStats, getCumulativeStats, getDailySummaries,
  upsertDailyWatchlistStats, getDailyWatchlistStats,
  getSignalsForDate, getSignalsForRange,
  countTradingDaysTracked, getRecentPerformance, getOpenPositions,
};
