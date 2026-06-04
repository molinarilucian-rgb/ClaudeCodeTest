import cron from 'node-cron';
import config from '../config/config.js';
import logger from './utils/logger.js';
import { nowEt, etDateStr, etToIso, isTradingDay } from './utils/timeUtils.js';
import { getAccount, getMinuteBars } from './data/marketData.js';
import { scanGaps } from './scanners/gapScanner.js';
import { computeAllOpeningRanges, minutesFromOpen } from './strategy/openingRange.js';
import { detectBreakout, ENTRY_CUTOFF_OFFSET } from './strategy/breakoutDetector.js';
import { sendBreakoutAlert } from './notify/discord.js';
import { getWatchlist, saveOpeningRange } from './data/database.js';

/**
 * ORB Bot — main entry point / scheduler (Phase 6, partial).
 * -----------------------------------------------------------
 * Runs as a long-lived worker (e.g. on Railway). All jobs are scheduled in the
 * America/New_York timezone so they fire at the correct ET market times no
 * matter what timezone the host/container runs in.
 *
 * IMPLEMENTED today: pre-market scan → watchlist, opening-range capture.
 * NOT YET implemented: breakout detection & order execution (Phases 3–4).
 * The bot therefore does NOT place any trades yet — it builds and logs the
 * daily watchlist and opening ranges so you can watch it run in the cloud.
 */

const TZ = config.timezone;

// ---- Jobs ----

async function jobWakeUp() {
  alertedSignals.clear(); // reset daily de-dup
  const acct = await getAccount();
  logger.info(`Awake. Account ${acct.account_number} | status=${acct.status} | buying_power=$${acct.buying_power} | cash=$${acct.cash}`);
}

async function jobGapScan() {
  const { selected, evaluated } = await scanGaps();
  logger.info(`Pre-market scan: ${evaluated.length} evaluated → ${selected.length} selected`);
  for (const s of selected) {
    logger.info(`  • ${s.symbol}  gap ${s.gapPct >= 0 ? '+' : ''}${s.gapPct.toFixed(2)}%  [${s.catalyst.catalyst_type}/${s.catalyst.quality}]  ${(s.catalyst.catalyst_summary || '').slice(0, 70)}`);
  }
  if (!selected.length) logger.warn('  (no symbols passed the gap + catalyst filters today)');
}

async function jobOpeningRangeCapture() {
  const date = etDateStr();
  const watchlist = getWatchlist(date).filter((r) => r.selected);
  if (!watchlist.length) {
    logger.warn('OR capture: no selected watchlist for today — did the pre-market scan run?');
    return;
  }
  const startIso = etToIso(date, '09:30');
  const endIso = etToIso(date, '10:05');
  for (const row of watchlist) {
    const bars = await getMinuteBars(row.symbol, startIso, endIso);
    const ranges = computeAllOpeningRanges(bars);
    for (const r of Object.values(ranges)) {
      if (r.orComplete) {
        saveOpeningRange(date, row.symbol, r.timeframe, r.orHigh, r.orLow, r.orCompleteTime);
        logger.info(`OR ${row.symbol} ${r.timeframe}m: ${r.orLow?.toFixed(2)}–${r.orHigh?.toFixed(2)} (range ${(r.orHigh - r.orLow).toFixed(2)})`);
      } else {
        logger.warn(`OR ${row.symbol} ${r.timeframe}m incomplete (${bars.length} bars)`);
      }
    }
  }
  logger.info('Opening ranges captured. Breakout detection & execution: NOT yet implemented (Phases 3–4).');
}

// De-dup: at most one alert per symbol+timeframe+direction per day.
// Cleared each morning by the wake-up job.
const alertedSignals = new Set();

async function jobMonitorBreakouts() {
  const nowOff = minutesFromOpen(new Date().toISOString());
  // Only during the entry window: after the first (5-min) OR closes, before cutoff.
  if (nowOff < Math.min(...config.strategy.orTimeframes) || nowOff >= ENTRY_CUTOFF_OFFSET) return;

  const date = etDateStr();
  const watchlist = getWatchlist(date).filter((r) => r.selected);
  if (!watchlist.length) return;

  const startIso = etToIso(date, '09:30');
  const nowIso = new Date().toISOString();

  for (const row of watchlist) {
    const bars = await getMinuteBars(row.symbol, startIso, nowIso);
    if (!bars.length) continue;
    const ranges = computeAllOpeningRanges(bars);

    for (const tf of config.strategy.orTimeframes) {
      const signal = detectBreakout({
        symbol: row.symbol,
        timeframe: tf,
        orState: ranges[tf],
        sessionBars: bars,
        gapPct: row.gap_pct,
      });
      if (!signal || !signal.triggered) continue;

      const key = `${date}|${row.symbol}|${tf}|${signal.direction}`;
      if (alertedSignals.has(key)) continue;
      alertedSignals.add(key);

      logger.info(`🔔 BREAKOUT ${row.symbol} ${tf}m ${signal.direction.toUpperCase()} @ $${signal.entryPrice.toFixed(2)} (vol ${signal.volumeRatio.toFixed(1)}×)`);
      const sent = await sendBreakoutAlert(signal, { catalyst: row.catalyst_type });
      if (!sent) logger.warn(`Discord alert not delivered for ${row.symbol} ${tf}m`);
    }
  }
}

function jobHeartbeat() {
  logger.info(`heartbeat — ${nowEt().format('YYYY-MM-DD HH:mm')} ET | trading_day=${isTradingDay()}`);
}

// ---- Schedule (cron expressions evaluated in ET) ----
// min hour day month weekday   (1-5 = Mon–Fri)
const JOBS = [
  { expr: '0 4 * * 1-5',    name: 'wake-up / account check',  fn: jobWakeUp,              tradingDayOnly: true },
  { expr: '0 9 * * 1-5',    name: 'pre-market gap scan',      fn: jobGapScan,             tradingDayOnly: true },
  { expr: '5 10 * * 1-5',   name: 'opening-range capture',    fn: jobOpeningRangeCapture, tradingDayOnly: true },
  { expr: '*/2 9,10 * * 1-5', name: 'breakout monitor',       fn: jobMonitorBreakouts,    tradingDayOnly: true, quiet: true },
  { expr: '*/30 * * * *',   name: 'heartbeat',                fn: jobHeartbeat,           tradingDayOnly: false },
];

function register(job) {
  cron.schedule(job.expr, async () => {
    if (job.tradingDayOnly && !isTradingDay()) {
      if (!job.quiet) logger.info(`Skip "${job.name}" — not a trading day (weekend/holiday)`);
      return;
    }
    if (!job.quiet) logger.info(`▶ ${job.name}`);
    try {
      await job.fn();
      if (!job.quiet) logger.info(`✓ ${job.name}`);
    } catch (err) {
      logger.error(`✗ ${job.name}: ${err.stack || err.message}`);
    }
  }, { timezone: TZ });
}

async function main() {
  const check = process.argv.includes('--check');
  logger.info(`ORB bot starting — mode=${config.alpaca.paper ? 'PAPER' : 'LIVE'} | tz=${TZ} | node=${process.version}`);

  // Fail fast if credentials/connection are bad (surfaces clearly in Railway logs).
  try {
    const acct = await getAccount();
    logger.info(`Alpaca connected: account ${acct.account_number}, buying power $${acct.buying_power}`);
  } catch (err) {
    logger.error(`FATAL: Alpaca connection failed at startup — check env vars. ${err.message}`);
    process.exit(1);
  }

  logger.info('Scheduled jobs (ET):');
  for (const j of JOBS) logger.info(`  ${j.expr.padEnd(14)} ${j.name}`);
  logger.warn('Execution is NOT implemented yet — bot will scan & capture ranges only, no orders.');

  if (check) {
    logger.info('--check OK: startup + connection + schedule validated. Exiting.');
    process.exit(0);
  }

  for (const j of JOBS) register(j);
  logger.info('Scheduler armed. Worker idle until next job. (Ctrl-C / SIGTERM to stop.)');
}

// Graceful shutdown so Railway redeploys don't leave a half-dead process.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    logger.info(`${sig} received — shutting down cleanly.`);
    process.exit(0);
  });
}
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled promise rejection: ${reason?.stack || reason}`);
});

main().catch((err) => {
  logger.error(`FATAL during startup: ${err.stack || err.message}`);
  process.exit(1);
});
