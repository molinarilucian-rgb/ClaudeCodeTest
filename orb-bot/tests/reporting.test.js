import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync, readFileSync } from 'node:fs';

// Throwaway DB + reports dir (reports land next to ORB_DB_PATH) BEFORE imports.
const TMP_DIR = join(tmpdir(), `orb-report-${process.pid}-${Date.now()}`);
const TMP_DB = join(TMP_DIR, 'orb.db');
process.env.ORB_DB_PATH = TMP_DB;
process.env.DISCORD_WEBHOOK_URL = ''; // keep Discord sends inert/fail-safe

let database, perfDb, daily, weekly, files, discord;

after(() => {
  try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

const DATE = '2026-06-08'; // a Monday

// Insert a closed trade row directly (mirrors what the execution engine writes).
function insertClosedTrade(t) {
  database.db.prepare(`
    INSERT INTO trades
      (trade_id, date, symbol, or_timeframe, rr_ratio, direction, status,
       entry_time, entry_price, stop_price, target_price, shares,
       exit_time, exit_price, exit_reason, pnl, pnl_pct, risk_amount, r_multiple, opened_at)
    VALUES (?,?,?,?,?,?,'closed',?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    t.trade_id, DATE, t.symbol, t.tf, t.rr, t.dir,
    t.entry_time, t.entry, t.stop, t.target, t.shares,
    t.exit_time, t.exit, t.reason, t.pnl, t.pnlPct ?? 0, t.risk ?? 1000, t.r, t.opened_at ?? t.entry_time
  );
}

before(async () => {
  database = await import('../src/data/database.js');
  perfDb = await import('../src/reporting/performanceDb.js');
  daily = await import('../src/reporting/dailyReport.js');
  weekly = await import('../src/reporting/weeklyReport.js');
  files = await import('../src/reporting/reportFiles.js');
  discord = await import('../src/reporting/discordReport.js');

  // Watchlist + a fired signal so the join enriches the trades.
  database.saveWatchlistEntry(DATE, {
    symbol: 'NVDA', gapPct: 3.5, selected: true,
    catalyst: { catalyst_type: 'analyst_rating', quality: 'high', sentiment: 'bullish', tradeable: true, confidence: 0.9 },
  });
  database.saveSignal(DATE, {
    symbol: 'NVDA', timeframe: 5, direction: 'long', time: `${DATE}T13:35:00Z`,
    entryPrice: 100, stopPrice: 98, gapPct: 3.5, vwap: 99.5, volumeRatio: 3.2,
    qualityScore: 8.4, qualityGrade: 'A', scoreBreakdown: { volume: 10, gap: 7, close: 6, vwap: 8 },
  }, { status: 'confirmed', catalyst: 'analyst_rating' });

  // 3 legs of the one signal: rr1 win, rr15 loss, rr2 win.
  insertClosedTrade({ trade_id: `${DATE}_NVDA_5_long_rr1`, symbol: 'NVDA', tf: 5, rr: 1.0, dir: 'long',
    entry_time: `${DATE}T13:40:00Z`, exit_time: `${DATE}T14:10:00Z`, entry: 100, stop: 98, target: 102,
    shares: 500, exit: 102, reason: 'TARGET', pnl: 1000, r: 1.0 });
  insertClosedTrade({ trade_id: `${DATE}_NVDA_5_long_rr15`, symbol: 'NVDA', tf: 5, rr: 1.5, dir: 'long',
    entry_time: `${DATE}T13:40:00Z`, exit_time: `${DATE}T13:55:00Z`, entry: 100, stop: 98, target: 103,
    shares: 500, exit: 98, reason: 'STOP', pnl: -1000, r: -1.0 });
  insertClosedTrade({ trade_id: `${DATE}_NVDA_5_long_rr2`, symbol: 'NVDA', tf: 5, rr: 2.0, dir: 'long',
    entry_time: `${DATE}T13:40:00Z`, exit_time: `${DATE}T14:30:00Z`, entry: 100, stop: 98, target: 104,
    shares: 500, exit: 104, reason: 'TARGET', pnl: 2000, r: 2.0 });
});

test('generateDailyReport populates strategy_performance with enriched rows', () => {
  daily.generateDailyReport({ date: DATE });
  const rows = database.db.prepare('SELECT * FROM strategy_performance WHERE date=? ORDER BY rr_ratio').all(DATE);
  assert.equal(rows.length, 3);
  const rr1 = rows.find((r) => r.strategy_key === '5m_rr1');
  assert.equal(rr1.exit_reason, 'target_hit');        // mapped from TARGET
  assert.equal(rr1.signal_quality_score, 8.4);        // joined from signals
  assert.equal(rr1.volume_ratio, 3.2);
  assert.equal(rr1.gap_pct, 3.5);
  assert.equal(rr1.duration_minutes, 30);
});

test('daily_summary rows written per traded variation', () => {
  const sums = perfDb.getDailySummaries(DATE);
  // all 3 legs are distinct strategy_keys (rr1/rr15/rr2), each 1 trade
  const keys = sums.map((s) => s.strategy_key).sort();
  assert.deepEqual(keys, ['5m_rr1', '5m_rr15', '5m_rr2']);
  const rr2 = sums.find((s) => s.strategy_key === '5m_rr2');
  assert.equal(rr2.trades_count, 1);
  assert.equal(rr2.total_pnl, 2000);
  assert.equal(rr2.wins, 1);
});

test('cumulative_stats recomputed and persisted', () => {
  const cum = perfDb.getCumulativeStats();
  const byKey = Object.fromEntries(cum.map((c) => [c.strategy_key, c]));
  assert.equal(byKey['5m_rr1'].cumulative_pnl, 1000);
  assert.equal(byKey['5m_rr15'].cumulative_pnl, -1000);
  assert.equal(byKey['5m_rr2'].cumulative_pnl, 2000);
  assert.ok(byKey['5m_rr1'].last_updated);
});

test('report payload: overall + best variation + best/worst trade', () => {
  const { data } = daily.generateDailyReport({ date: DATE, write: false });
  assert.equal(data.overall.trades, 3);
  assert.equal(data.overall.totalPnl, 2000);   // +1000 -1000 +2000
  assert.equal(data.signalsCount, 1);
  assert.equal(data.outcomes.wins, 2);
  assert.equal(data.outcomes.losses, 1);
  assert.equal(data.grid.length, 9);
  assert.equal(data.best.key, '5m_rr2');        // biggest P&L variation
  assert.equal(data.bestTrade.pnl, 2000);
  assert.equal(data.worstTrade.pnl, -1000);
});

test('writeReports creates the three files with correct content', () => {
  const { paths } = daily.generateDailyReport({ date: DATE, write: true });
  assert.ok(existsSync(paths.summary));
  assert.ok(existsSync(paths.json));
  assert.ok(existsSync(paths.csv));

  const json = JSON.parse(readFileSync(paths.json, 'utf8'));
  assert.equal(json.date, DATE);
  assert.equal(json.strategyPerformance.length, 3);
  assert.equal(json.dailySummary.length, 9); // full grid in JSON

  const csv = readFileSync(paths.csv, 'utf8').trim().split('\n');
  assert.equal(csv.length, 4); // header + 3 trades
  assert.ok(csv[0].startsWith('trade_id,date,symbol'));

  const summary = readFileSync(paths.summary, 'utf8');
  assert.match(summary, /DAILY REPORT — 2026-06-08/);
  assert.match(summary, /STRATEGY VARIATIONS/);
});

test('Discord daily message has the required sections', () => {
  const { data } = daily.generateDailyReport({ date: DATE, write: false });
  const msg = discord.formatDailyDiscord(data);
  assert.match(msg, /📊 DAILY REPORT — 2026-06-08/);
  assert.match(msg, /SIGNALS TODAY: 1/);
  assert.match(msg, /✅ Wins: 2 \| ❌ Losses: 1 \| ⏳ Pending: 0/);
  assert.match(msg, /ALL 9 VARIATIONS:/);
  assert.match(msg, /CUMULATIVE \(all-time\):/);
  assert.match(msg, /Best variation so far: 5m OR \| 1:2 RR/);
});

test('Discord daily message: no-signals branch for an empty day', () => {
  const EMPTY = '2026-06-09';
  database.saveWatchlistEntry(EMPTY, { symbol: 'AMD', gapPct: -2.1, selected: true, catalyst: { catalyst_type: 'news', quality: 'medium' } });
  const { data } = daily.generateDailyReport({ date: EMPTY, write: false });
  const msg = discord.formatDailyDiscord(data);
  assert.match(msg, /No signals fired today\. Bot monitored 1 stocks\./);
  assert.match(msg, /AMD -2\.1%/);
});

test('weekly report aggregates the week and finds extremes', () => {
  const w = weekly.generateWeeklyReport({ date: DATE });
  assert.equal(w.weekLabel, '2026-06-08'); // Monday
  assert.equal(w.overall.trades, 3);
  assert.equal(w.totalSignals, 1);
  assert.equal(w.tradingDays, 1);
  assert.equal(w.top.key, '5m_rr2');
  assert.equal(w.worst.key, '5m_rr15');
  assert.equal(w.biggestWin.pnl, 2000);
  assert.equal(w.biggestLoss.pnl, -1000);
  assert.equal(w.mostTradedStock.symbol, 'NVDA');

  const msg = discord.formatWeeklyDiscord(w);
  assert.match(msg, /📈 WEEKLY SUMMARY — Week of 2026-06-08/);
  assert.match(msg, /MOST TRADED STOCK: NVDA \(1 signals\)/);
  assert.match(msg, /BIGGEST WIN: \+\$2000\.00 \(NVDA long\)/);
});

test('idempotent: re-running the daily report does not duplicate rows', () => {
  daily.generateDailyReport({ date: DATE, write: false });
  daily.generateDailyReport({ date: DATE, write: false });
  const n = database.db.prepare('SELECT COUNT(*) AS n FROM strategy_performance WHERE date=?').get(DATE).n;
  assert.equal(n, 3); // still 3, not 9
});
