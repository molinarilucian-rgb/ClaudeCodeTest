import { toEt, etDateStr } from '../utils/timeUtils.js';
import {
  strategyGrid, computeStats, bestStrategy, worstStrategy,
} from './metrics.js';
import {
  getClosedTradeRecordsForRange, getSignalsForRange, getAllClosedTradeRecords,
} from './performanceDb.js';

/**
 * Phase 4 — weekly summary orchestrator (Fridays 17:00 ET).
 * Pure aggregation over the current ET week (Monday → run date). READ ONLY.
 * Returns a payload the Discord layer formats; the daily job already persisted
 * the per-day/cumulative analytics, so the weekly view does not re-write tables.
 */

/** Monday (YYYY-MM-DD ET) of the week containing `date`. */
export function weekStart(date) {
  const d = toEt(`${date}T12:00:00`); // noon ET — avoids any DST edge at midnight
  const dow = d.day(); // 0 Sun … 6 Sat
  const sinceMonday = (dow + 6) % 7; // Mon→0, Sun→6
  return d.subtract(sinceMonday, 'day').format('YYYY-MM-DD');
}

/**
 * Build the weekly summary payload.
 * @param {object} [opts]
 * @param {string} [opts.date] ET date the report is run on (defaults to today)
 */
export function generateWeeklyReport({ date = etDateStr() } = {}) {
  const start = weekStart(date);
  const end = date;

  const records = getClosedTradeRecordsForRange(start, end);
  const signals = getSignalsForRange(start, end).filter((s) => (s.status ?? 'confirmed') === 'confirmed');

  const grid = strategyGrid(records);
  const overall = computeStats(records);

  // Trading days = distinct ET dates that had any signal or any closed trade.
  const activeDates = new Set([...records.map((r) => r.date), ...signals.map((s) => s.date)]);

  // Most-traded stock by number of confirmed signals this week.
  const bySymbol = new Map();
  for (const s of signals) bySymbol.set(s.symbol, (bySymbol.get(s.symbol) ?? 0) + 1);
  let mostTradedStock = null;
  for (const [symbol, count] of bySymbol) {
    if (!mostTradedStock || count > mostTradedStock.count) mostTradedStock = { symbol, count };
  }

  const biggestWin = records.length
    ? records.reduce((a, b) => ((b.pnl ?? 0) > (a.pnl ?? 0) ? b : a))
    : null;
  const biggestLoss = records.length
    ? records.reduce((a, b) => ((b.pnl ?? 0) < (a.pnl ?? 0) ? b : a))
    : null;

  // Cumulative all-time grid (read-only; not re-persisted here).
  const cumGrid = strategyGrid(getAllClosedTradeRecords());

  return {
    weekLabel: start,
    start,
    end,
    tradingDays: activeDates.size,
    totalSignals: signals.length,
    overall,
    grid,
    top: bestStrategy(grid),
    worst: worstStrategy(grid),
    mostTradedStock,
    biggestWin: biggestWin && (biggestWin.pnl ?? 0) > 0 ? biggestWin : null,
    biggestLoss: biggestLoss && (biggestLoss.pnl ?? 0) < 0 ? biggestLoss : null,
    cumulative: {
      grid: cumGrid,
      overall: computeStats(getAllClosedTradeRecords()),
      best: bestStrategy(cumGrid),
    },
  };
}

export default { generateWeeklyReport, weekStart };
