import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';

/**
 * Phase 4 — report file writers (summary.txt / data.json / trades.csv).
 * Formatting is pure (string/object builders, unit-testable); only writeReports
 * touches the filesystem, and it creates the dated directory if missing.
 */

const __dir = dirname(fileURLToPath(import.meta.url));

// Reports live beside the SQLite DB so a mounted Railway volume persists them:
//   ORB_DB_PATH override → next to that file (tests)
//   RAILWAY_VOLUME_MOUNT_PATH → $VOL/reports  (→ /app/data/reports in prod)
//   else <project>/data/reports (local dev)
const dataDir = process.env.ORB_DB_PATH
  ? dirname(process.env.ORB_DB_PATH)
  : (process.env.RAILWAY_VOLUME_MOUNT_PATH || join(__dir, '..', '..', 'data'));
export const REPORTS_DIR = join(dataDir, 'reports');

// ---- formatting helpers ----
const signedMoney = (n) => {
  if (n == null || Number.isNaN(n)) return '—';
  const v = Number(n);
  return `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
};
const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);
const pf = (v) => (v === null ? '∞' : (v == null ? '—' : Number(v).toFixed(2)));
const wr = (stats) => (stats.trades ? `${Math.round(stats.winRate)}%` : '—');

/** The aligned 9-variation comparison block (shared by summary.txt + Discord). */
export function formatGridLines(grid) {
  return grid.map((g) =>
    `${g.labelPadded} → ${g.stats.trades} trades | ${wr(g.stats).padStart(4)} WR | ${signedMoney(g.stats.totalPnl)} P&L`
  );
}

/** Human-readable summary.txt body. */
export function formatSummaryText(d) {
  const L = [];
  L.push('═══════════════════════════════════════════════════════');
  L.push(`  ORB BOT — DAILY REPORT — ${d.date}`);
  L.push('═══════════════════════════════════════════════════════');
  L.push('');
  L.push(`Market conditions: ${d.marketConditions}`);
  L.push('');

  // Watchlist
  L.push('── WATCHLIST ──');
  if (d.watchlist.length) {
    for (const w of d.watchlist) {
      const gap = w.gapPct == null ? 'n/a' : `${w.gapPct >= 0 ? '+' : ''}${w.gapPct.toFixed(2)}%`;
      L.push(`  ${w.symbol.padEnd(6)} gap ${gap.padStart(8)} | ${w.catalyst || 'no catalyst'}`);
    }
  } else {
    L.push('  (empty — no symbols passed the gap + catalyst filters)');
  }
  L.push('');

  // Signals + outcomes
  L.push('── SIGNALS FIRED ──');
  if (d.signals.length) {
    for (const s of d.signals) {
      L.push(`  ${s.symbol} ${s.timeframe}m ${s.direction.toUpperCase()} | entry ${money(s.entryPrice)} | stop ${money(s.stopPrice)} | targets ${s.targets.map(money).join(' / ')}`);
      L.push(`      quality ${s.qualityScore ?? '—'}/10 | outcome: ${s.outcome}`);
    }
  } else {
    L.push('  No breakout signals fired today.');
  }
  L.push('');

  // Best / worst trade
  L.push('── BEST / WORST TRADE ──');
  if (d.bestTrade) {
    L.push(`  Best:  ${d.bestTrade.symbol} ${d.bestTrade.strategyKey} ${d.bestTrade.direction} → ${signedMoney(d.bestTrade.pnl)} (${d.bestTrade.rMultiple}R, ${d.bestTrade.exitReason})`);
    L.push(`  Worst: ${d.worstTrade.symbol} ${d.worstTrade.strategyKey} ${d.worstTrade.direction} → ${signedMoney(d.worstTrade.pnl)} (${d.worstTrade.rMultiple}R, ${d.worstTrade.exitReason})`);
  } else {
    L.push('  No closed trades today.');
  }
  L.push('');

  // 9-variation comparison
  L.push('── STRATEGY VARIATIONS (today) ──');
  for (const line of formatGridLines(d.grid)) L.push(`  ${line}`);
  L.push('');
  if (d.best) {
    L.push(`  ★ Best variation today: ${d.best.label} → ${Math.round(d.best.stats.winRate)}% WR | ${signedMoney(d.best.stats.totalPnl)} P&L | PF ${pf(d.best.stats.profitFactor)} | exp ${signedMoney(d.best.stats.expectancy)}`);
  } else {
    L.push('  ★ Best variation today: — (no trades)');
  }
  L.push('');

  // Cumulative
  L.push('── CUMULATIVE (all-time, since bot started) ──');
  L.push(`  Trading days tracked: ${d.cumulative.tradingDays}`);
  L.push(`  Total trades: ${d.cumulative.overall.trades} | Win rate: ${Math.round(d.cumulative.overall.winRate)}% | P&L: ${signedMoney(d.cumulative.overall.totalPnl)} | PF ${pf(d.cumulative.overall.profitFactor)}`);
  for (const line of formatGridLines(d.cumulative.grid)) L.push(`  ${line}`);
  if (d.cumulative.best) {
    L.push('');
    L.push(`  ★ Best variation all-time: ${d.cumulative.best.label} → ${Math.round(d.cumulative.best.stats.winRate)}% WR | ${signedMoney(d.cumulative.best.stats.totalPnl)} P&L`);
  }
  L.push('');
  L.push(`Generated ${new Date().toISOString()} · SIMULATION/paper performance.`);
  return L.join('\n');
}

/** Machine-readable structured payload mirroring the analytics tables. */
export function buildDataJson(d) {
  return {
    date: d.date,
    generatedAt: new Date().toISOString(),
    marketConditions: d.marketConditions,
    watchlist: d.watchlist,
    signals: d.signals,
    outcomes: d.outcomes,
    strategyPerformance: d.records, // one entry per closed trade (strategy_performance shape)
    dailySummary: d.grid.map((g) => ({ strategyKey: g.key, label: g.label, ...g.stats })),
    bestStrategyToday: d.best ? { strategyKey: d.best.key, label: d.best.label, ...d.best.stats } : null,
    cumulative: {
      tradingDays: d.cumulative.tradingDays,
      overall: d.cumulative.overall,
      byStrategy: d.cumulative.grid.map((g) => ({ strategyKey: g.key, label: g.label, ...g.stats })),
      bestStrategy: d.cumulative.best ? { strategyKey: d.cumulative.best.key, label: d.cumulative.best.label, ...d.cumulative.best.stats } : null,
    },
  };
}

const CSV_COLUMNS = [
  ['trade_id', 'tradeId'], ['date', 'date'], ['symbol', 'symbol'], ['direction', 'direction'],
  ['or_timeframe', 'orTimeframe'], ['rr_ratio', 'rrRatio'], ['strategy_key', 'strategyKey'],
  ['entry_price', 'entryPrice'], ['stop_price', 'stopPrice'], ['target_price', 'targetPrice'],
  ['exit_price', 'exitPrice'], ['shares', 'shares'], ['risk_amount', 'riskAmount'],
  ['pnl', 'pnl'], ['r_multiple', 'rMultiple'], ['exit_reason', 'exitReason'],
  ['signal_quality_score', 'signalQualityScore'], ['volume_ratio', 'volumeRatio'],
  ['gap_pct', 'gapPct'], ['entry_time', 'entryTime'], ['exit_time', 'exitTime'],
  ['duration_minutes', 'durationMinutes'],
];

const csvCell = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per closed trade — all strategy_performance fields. */
export function buildTradesCsv(records) {
  const header = CSV_COLUMNS.map(([h]) => h).join(',');
  const rows = records.map((r) => CSV_COLUMNS.map(([, k]) => csvCell(r[k])).join(','));
  return [header, ...rows].join('\n') + '\n';
}

/**
 * Write summary.txt, data.json, trades.csv into <REPORTS_DIR>/<date>/.
 * Creates the directory if missing. Returns the paths written.
 */
export function writeReports(d) {
  const dir = join(REPORTS_DIR, d.date);
  mkdirSync(dir, { recursive: true });
  const paths = {
    dir,
    summary: join(dir, 'summary.txt'),
    json: join(dir, 'data.json'),
    csv: join(dir, 'trades.csv'),
  };
  writeFileSync(paths.summary, formatSummaryText(d), 'utf8');
  writeFileSync(paths.json, JSON.stringify(buildDataJson(d), null, 2), 'utf8');
  writeFileSync(paths.csv, buildTradesCsv(d.records), 'utf8');
  return paths;
}

export default {
  REPORTS_DIR, formatGridLines, formatSummaryText, buildDataJson, buildTradesCsv, writeReports,
};
