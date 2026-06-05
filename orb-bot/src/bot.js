import cron from 'node-cron';
import config from '../config/config.js';
import logger from './utils/logger.js';
import { nowEt, etDateStr, etToIso, isTradingDay, isHoliday } from './utils/timeUtils.js';
import { getAccount, getMinuteBars } from './data/marketData.js';
import { scanGaps } from './scanners/gapScanner.js';
import { computeOpeningRange, computeAllOpeningRanges, minutesFromOpen } from './strategy/openingRange.js';
import { detectBreakout, ENTRY_CUTOFF_OFFSET } from './strategy/breakoutDetector.js';
import { sendDiscord, sendBreakoutAlert } from './notify/discord.js';
import { getWatchlist, saveOpeningRange, saveSignal, getSignal } from './data/database.js';
import { decideStartupAction } from './startupPolicy.js';

/**
 * ORB Bot — main entry / scheduler (Phase 6, morning timeline).
 * -------------------------------------------------------------
 * Long-lived worker (Railway/PM2). All jobs are scheduled in America/New_York
 * so they fire at the correct ET market time regardless of host timezone.
 *
 * IMPLEMENTED (Phases 1–2): pre-market scans → watchlist, opening-range locks
 * (5/15/30-min), breakout detection → Discord signal alerts.
 * NOT implemented (Phases 3–4): order execution, position management, EOD
 * close, P&L/reports. Those afternoon steps are intentionally OMITTED rather
 * than faked — the bot places NO trades and reports NO trade results.
 */

const TZ = config.timezone;

// De-dup: at most one breakout alert per symbol+timeframe+direction per day.
// Backed by the `signals` table too, so a mid-session restart can't re-fire.
const alertedSignals = new Set();

// Runtime state. `standDownToday` is set when the bot boots after the OR window
// (missed start) so it won't trade a partial session; reset at the 05:00 wake.
const state = { standDownToday: false };

// ---- Discord helper ----
async function notify(content) {
  const ok = await sendDiscord({ content });
  if (!ok) logger.warn('Discord message not delivered (check DISCORD_WEBHOOK_URL)');
  return ok;
}

// ---- Connection helper: retry every 60s for up to 10 min ----
async function verifyConnection({ maxMs = 10 * 60 * 1000, intervalMs = 60 * 1000 } = {}) {
  const deadline = Date.now() + maxMs;
  for (;;) {
    try {
      return await getAccount();
    } catch (err) {
      if (Date.now() + intervalMs > deadline) throw err;
      logger.warn(`Connection check failed, retrying in ${intervalMs / 1000}s: ${err.message}`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

// ---- Jobs ----

// 05:00 — wake up, verify connection (with retry), holiday stand-down.
async function jobWakeUp() {
  alertedSignals.clear(); // reset daily de-dup
  state.standDownToday = false; // new day — clear any prior late-boot stand-down
  if (isHoliday()) {
    logger.info('Market holiday today — standing down.');
    await notify('📅 Market closed today. Bot standing down.');
    return;
  }
  try {
    const acct = await verifyConnection();
    logger.info(`Bot awake. Connection verified. Market open today. Account ${acct.account_number} | buying_power $${acct.buying_power}`);
  } catch (err) {
    logger.error(`API connection FAILED after retry window: ${err.message}`);
    await notify('🚨 ORB BOT — API CONNECTION FAILED. Manual check required.');
  }
}

// 07:00 / 08:00 — scan and log the full ranked candidate list (no Discord).
async function jobScanPreview(label) {
  const { selected, evaluated } = await scanGaps();
  const ranked = [...evaluated].sort((a, b) => b.rankScore - a.rankScore);
  logger.info(`${label}: ${evaluated.length} candidates evaluated, top picks: ${selected.map((s) => s.symbol).join(', ') || 'none'}`);
  for (const c of ranked) {
    logger.info(`   ${c.symbol.padEnd(6)} gap ${(c.gapPct >= 0 ? '+' : '') + c.gapPct.toFixed(2)}%  pmVol ${Number(c.pmVolume).toLocaleString()}  score ${Math.round(c.rankScore).toLocaleString()}  ${c.catalyst.catalyst_type}/${c.catalyst.quality}  keep=${c.qualityOk}`);
  }
}

// 09:00 — final scan, select top 5, persist, Discord watchlist.
async function jobFinalScan() {
  const { selected } = await scanGaps();
  if (!selected.length) {
    logger.warn('Final scan: no symbols passed the gap + catalyst filters.');
    await notify('📋 TODAY\'S WATCHLIST\nNo symbols passed the gap + catalyst filters today.');
    return;
  }
  const lines = selected.map((s, i) =>
    `${i + 1}. ${s.symbol} | Gap: ${s.gapPct >= 0 ? '+' : ''}${s.gapPct.toFixed(1)}% | PM Vol: ${Number(s.pmVolume).toLocaleString()} | Score: ${Math.round(s.rankScore).toLocaleString()} | ${s.catalyst.catalyst_type}`
  );
  for (const s of selected) logger.info(`watchlist: ${s.symbol} gap ${s.gapPct.toFixed(2)}% [${s.catalyst.catalyst_type}/${s.catalyst.quality}]`);
  await notify(`📋 TODAY'S WATCHLIST\n${lines.join('\n')}\nMarket opens in 30 minutes.`);
}

// 09:25 — pre-open prep: connection re-check, confirm watchlist, reset state.
async function jobPreOpen() {
  const acct = await getAccount();
  const date = etDateStr();
  const wl = getWatchlist(date).filter((r) => r.selected);
  logger.info(`Pre-open: connection OK (${acct.account_number}). Watchlist (${wl.length}): ${wl.map((r) => r.symbol).join(', ') || 'EMPTY'}`);
  logger.info('Note: bars are polled via REST (no websocket stream yet); OR locks use 1-min bars.');
  alertedSignals.clear();
  if (!wl.length) {
    await notify('⚠️ Market opens in 5 minutes — but the watchlist is EMPTY (no qualifying gaps). No signals expected today.');
    return;
  }
  await notify('⏰ Market opens in 5 minutes. All systems go.');
}

// 09:35 / 09:45 / 10:00 — lock the OR for one timeframe and Discord it.
async function lockOpeningRange(tf, headerSuffix = '') {
  if (state.standDownToday) {
    logger.info(`OR ${tf}m lock skipped — standing down today (booted after the OR window).`);
    return;
  }
  const date = etDateStr();
  const wl = getWatchlist(date).filter((r) => r.selected); // always from DB, never memory
  if (!wl.length) {
    logger.warn(`OR ${tf}m lock: no watchlist — skipping.`);
    return;
  }
  const startIso = etToIso(date, '09:30');
  const nowIso = new Date().toISOString();
  const lines = [];
  for (const row of wl) {
    const bars = await getMinuteBars(row.symbol, startIso, nowIso);
    const or = computeOpeningRange(bars, tf);
    if (or.orComplete && or.orHigh != null) {
      saveOpeningRange(date, row.symbol, tf, or.orHigh, or.orLow, or.orCompleteTime);
      lines.push(`${row.symbol}: High $${or.orHigh.toFixed(2)} | Low $${or.orLow.toFixed(2)} | Range: $${(or.orHigh - or.orLow).toFixed(2)}`);
      logger.info(`OR ${row.symbol} ${tf}m locked: $${or.orLow.toFixed(2)}–$${or.orHigh.toFixed(2)}`);
    } else {
      lines.push(`${row.symbol}: OR ${tf}m incomplete (${bars.length} bars)`);
      logger.warn(`OR ${row.symbol} ${tf}m incomplete (${bars.length} bars)`);
    }
  }
  await notify(`🔒 ${tf}-MIN OR LOCKED${headerSuffix}\n${lines.join('\n')}`);
}

// Every 30s in the entry window — detect breakouts, fire Discord alerts.
async function jobMonitorBreakouts() {
  if (state.standDownToday) return; // booted too late — no partial session
  const nowOff = minutesFromOpen(new Date().toISOString());
  if (nowOff < Math.min(...config.strategy.orTimeframes) || nowOff >= ENTRY_CUTOFF_OFFSET) return;

  const date = etDateStr();
  const watchlist = getWatchlist(date).filter((r) => r.selected); // always from DB
  if (!watchlist.length) return;

  const startIso = etToIso(date, '09:30');
  const nowIso = new Date().toISOString();

  for (const row of watchlist) {
    const bars = await getMinuteBars(row.symbol, startIso, nowIso);
    if (!bars.length) continue;
    const ranges = computeAllOpeningRanges(bars);

    for (const tf of config.strategy.orTimeframes) {
      const signal = detectBreakout({
        symbol: row.symbol, timeframe: tf, orState: ranges[tf],
        sessionBars: bars, gapPct: row.gap_pct,
      });
      if (!signal) continue;
      if (signal.confirmation === 'pending') continue; // breakout seen — wait for the next candle

      // De-dup across both memory and DB so a mid-session restart can't re-handle.
      const key = `${date}|${row.symbol}|${tf}|${signal.direction}`;
      if (alertedSignals.has(key) || getSignal(date, row.symbol, tf, signal.direction)) continue;

      // False breakout: next candle closed back inside the OR. Log separately,
      // record it, and do NOT count it as a valid signal (no Discord alert).
      if (signal.failedBreakout) {
        alertedSignals.add(key);
        saveSignal(date, signal, { catalyst: row.catalyst_type, status: 'failed' });
        logger.warn(`❌ FAILED BREAKOUT ${row.symbol} ${tf}m ${signal.direction.toUpperCase()} — next candle closed back inside the OR (no signal)`);
        continue;
      }

      // Confirmed structurally but other filters not met → not a valid signal.
      if (!signal.triggered) continue;

      alertedSignals.add(key);
      saveSignal(date, signal, { catalyst: row.catalyst_type, status: 'confirmed' });
      logger.info(`🔔 BREAKOUT ${row.symbol} ${tf}m ${signal.direction.toUpperCase()} @ $${signal.entryPrice.toFixed(2)} | quality ${signal.qualityScore}/10 (${signal.qualityGrade}) | vol ${signal.volumeRatio.toFixed(1)}×`);
      const sent = await sendBreakoutAlert(signal, { catalyst: row.catalyst_type });
      if (!sent) logger.warn(`Discord alert not delivered for ${row.symbol} ${tf}m`);
    }
  }
}

// 11:00 — close the entry window.
async function jobEntryClose() {
  logger.info('Entry window closed (11:00 ET). No new signals will be sent today.');
  await notify('🚫 Entry window closed (11:00 ET). No new breakout signals today.');
}

function jobHeartbeat() {
  logger.info(`heartbeat — ${nowEt().format('YYYY-MM-DD HH:mm')} ET | trading_day=${isTradingDay()}`);
}

// ---- Schedule (cron evaluated in ET; weekday 1-5) ----
const JOBS = [
  // 5-field: min hour day month weekday
  { expr: '0 5 * * 1-5',  name: '05:00 wake-up / connection',  fn: jobWakeUp,                       tradingDayOnly: false },
  { expr: '0 7 * * 1-5',  name: '07:00 initial scan',          fn: () => jobScanPreview('07:00 initial scan'), tradingDayOnly: true },
  { expr: '0 8 * * 1-5',  name: '08:00 refined scan',          fn: () => jobScanPreview('08:00 refined scan'), tradingDayOnly: true },
  { expr: '0 9 * * 1-5',  name: '09:00 final scan + watchlist', fn: jobFinalScan,                   tradingDayOnly: true },
  { expr: '25 9 * * 1-5', name: '09:25 pre-open prep',         fn: jobPreOpen,                      tradingDayOnly: true },
  { expr: '35 9 * * 1-5', name: '09:35 lock 5-min OR',         fn: () => lockOpeningRange(5),       tradingDayOnly: true },
  { expr: '45 9 * * 1-5', name: '09:45 lock 15-min OR',        fn: () => lockOpeningRange(15),      tradingDayOnly: true },
  { expr: '0 10 * * 1-5', name: '10:00 lock 30-min OR',        fn: () => lockOpeningRange(30, ' — all timeframes active, breakout detection live'), tradingDayOnly: true },
  { expr: '0 11 * * 1-5', name: '11:00 entry window close',    fn: jobEntryClose,                   tradingDayOnly: true },
  // 6-field (with seconds): every 30s during the 9:xx and 10:xx ET hours
  { expr: '*/30 * 9,10 * * 1-5', name: 'breakout monitor (30s)', fn: jobMonitorBreakouts,           tradingDayOnly: true, quiet: true },
  { expr: '*/30 * * * *', name: 'heartbeat',                   fn: jobHeartbeat,                    tradingDayOnly: false },
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
      // Alert on failure — but not for the high-frequency quiet monitor, to
      // avoid spamming Discord every 30s if something stays broken.
      if (!job.quiet) {
        try { await sendDiscord({ content: `🚨 ORB BOT — task "${job.name}" failed: ${err.message}` }); } catch { /* ignore */ }
      }
    }
  }, { timezone: TZ });
}

// On boot, recover or rebuild today's state from the DB (restart safety).
async function startupCatchUp() {
  const bootStr = `${nowEt().format('YYYY-MM-DD HH:mm:ss')} ET`;
  const nowOff = minutesFromOpen(new Date().toISOString());
  const date = etDateStr();
  const watchlistCount = getWatchlist(date).filter((r) => r.selected).length;
  const orFirstOff = Math.min(...config.strategy.orTimeframes); // 5 → 09:35

  const action = decideStartupAction({
    nowOff, tradingDay: isTradingDay(), watchlistCount, orFirstOff,
  });

  switch (action) {
    case 'closed':
      logger.info(`Booted at ${bootStr} — market closed today; standing down.`);
      break;
    case 'pre_market':
      logger.info(`Booted at ${bootStr} — pre-market; the 09:00 scan will build today's watchlist.`);
      break;
    case 'recover':
      logger.info(`Booted at ${bootStr} — recovered watchlist of ${watchlistCount} stocks from the database.`);
      break;
    case 'rebuild':
      logger.info(`Booted at ${bootStr} — empty watchlist inside the entry window; rebuilding now…`);
      await jobFinalScan(); // scan → select → persist → Discord watchlist
      logger.info(`Booted at ${bootStr} — rebuilt watchlist of ${getWatchlist(date).filter((r) => r.selected).length} stocks.`);
      break;
    case 'stand_down':
      state.standDownToday = true;
      logger.warn(`Booted at ${bootStr} — Missed OR window — standing down for today (will not trade a partial session).`);
      // Only ping Discord if we booted during the active window (≤ 11:00 cutoff);
      // a routine evening/overnight restart shouldn't spam the channel.
      if (nowOff < ENTRY_CUTOFF_OFFSET) {
        await notify('⚠️ ORB BOT booted after the 9:35 ET opening-range window — standing down for today (no partial session).');
      }
      break;
  }
}

// Manual triggers for verification: `node src/bot.js --run <key>`
const RUNNERS = {
  wake: jobWakeUp,
  scan: () => jobScanPreview('manual scan'),
  final: jobFinalScan,
  preopen: jobPreOpen,
  or5: () => lockOpeningRange(5),
  or15: () => lockOpeningRange(15),
  or30: () => lockOpeningRange(30, ' — all timeframes active, breakout detection live'),
  monitor: jobMonitorBreakouts,
  close: jobEntryClose,
};

async function main() {
  const check = process.argv.includes('--check');
  const runIdx = process.argv.indexOf('--run');
  logger.info(`ORB bot starting — mode=${config.alpaca.paper ? 'PAPER' : 'LIVE'} | tz=${TZ} | node=${process.version}`);

  if (runIdx !== -1) {
    const key = process.argv[runIdx + 1];
    const fn = RUNNERS[key];
    if (!fn) {
      logger.error(`Unknown --run job "${key}". Options: ${Object.keys(RUNNERS).join(', ')}`);
      process.exit(1);
    }
    logger.info(`Manually running job: ${key}`);
    try {
      await fn();
      logger.info(`✓ manual job "${key}" complete`);
      process.exit(0);
    } catch (err) {
      logger.error(`✗ manual job "${key}" failed: ${err.stack || err.message}`);
      process.exit(1);
    }
  }

  try {
    const acct = await getAccount();
    logger.info(`Alpaca connected: account ${acct.account_number}, buying power $${acct.buying_power}`);
  } catch (err) {
    logger.error(`FATAL: Alpaca connection failed at startup — check env vars. ${err.message}`);
    process.exit(1);
  }

  if (!config.scheduleEnabled) {
    logger.warn('SCHEDULE_ENABLED=false — cron jobs NOT registered. Worker idle.');
    if (check) process.exit(0);
    setInterval(() => {}, 1 << 30); // keep process alive
    return;
  }

  // Validate every cron expression up front (incl. the 6-field seconds one),
  // so --check catches a malformed schedule before deploy.
  for (const j of JOBS) {
    if (!cron.validate(j.expr)) {
      logger.error(`FATAL: invalid cron expression for "${j.name}": ${j.expr}`);
      process.exit(1);
    }
  }

  logger.info('Scheduled jobs (ET):');
  for (const j of JOBS) logger.info(`  ${j.expr.padEnd(16)} ${j.name}`);
  logger.warn('Phases 1–2 only: scans, OR locks & breakout SIGNALS. No orders are placed (Phase 3 pending).');

  if (check) {
    logger.info('--check OK: startup + connection + schedule validated. Exiting.');
    process.exit(0);
  }

  for (const j of JOBS) register(j);

  // Restart safety: figure out where in the day we booted and recover/rebuild
  // today's watchlist from the DB, or stand down if we missed the OR window.
  await startupCatchUp();

  logger.info('Scheduler armed. Worker idle until next job. (Ctrl-C / SIGTERM to stop.)');
}

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
