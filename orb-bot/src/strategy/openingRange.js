import config from '../../config/config.js';
import { toEt } from '../utils/timeUtils.js';

/**
 * Opening Range calculation (Phase 2)
 * -----------------------------------
 * The Opening Range (OR) is the high/low during the first N minutes after the
 * 9:30 AM ET open. We track three windows in parallel:
 *   - 5-min:  09:30–09:35
 *   - 15-min: 09:30–09:45
 *   - 30-min: 09:30–10:00
 *
 * Two entry points:
 *   - computeAllOpeningRanges(bars, tfs)  → batch (backtest / after-the-fact)
 *   - new OpeningRangeTracker(symbol)     → live, fed bars as they stream in
 *
 * Bars are { t, o, h, l, c, v } with `t` an ISO/UTC timestamp (Alpaca bars are
 * stamped at the START of the minute). Completion is time-based, so missing
 * minutes (common on the IEX feed) don't break the range.
 */

const OPEN_MINUTES = 9 * 60 + 30; // 09:30 ET as minutes-from-midnight

/** Minutes a bar's start sits after the 09:30 ET open (negative = pre-market). */
export function minutesFromOpen(barTs) {
  const et = toEt(barTs);
  return et.hour() * 60 + et.minute() - OPEN_MINUTES;
}

/** ISO timestamp (UTC) of a timeframe's window end, derived from an in-window bar. */
function windowEndIso(anyInWindowBar, timeframeMin) {
  const openEt = toEt(anyInWindowBar.t).hour(9).minute(30).second(0).millisecond(0);
  return openEt.add(timeframeMin, 'minute').toDate().toISOString();
}

const emptyState = (tf) => ({
  timeframe: tf,
  orHigh: null,
  orLow: null,
  orComplete: false,
  orCompleteTime: null,
  barCount: 0,
});

/**
 * Compute the opening range for ONE timeframe from a set of minute bars.
 * `orComplete` is true once trading is observed at/after the window end
 * (a bar with offset >= timeframe), proving the window fully elapsed.
 */
export function computeOpeningRange(bars, timeframeMin) {
  const state = emptyState(timeframeMin);
  if (!bars || bars.length === 0) return state;

  const inWindow = [];
  let maxOffset = -Infinity;
  for (const b of bars) {
    const off = minutesFromOpen(b.t);
    if (off > maxOffset) maxOffset = off;
    if (off >= 0 && off < timeframeMin) inWindow.push(b);
  }
  if (inWindow.length === 0) return state;

  state.orHigh = Math.max(...inWindow.map((b) => b.h));
  state.orLow = Math.min(...inWindow.map((b) => b.l));
  state.barCount = inWindow.length;
  state.orComplete = maxOffset >= timeframeMin;
  state.orCompleteTime = state.orComplete ? windowEndIso(inWindow[0], timeframeMin) : null;
  return state;
}

/**
 * Compute opening ranges for all configured timeframes.
 * @returns {Object<number, ReturnType<typeof computeOpeningRange>>} keyed by timeframe
 */
export function computeAllOpeningRanges(bars, timeframes = config.strategy.orTimeframes) {
  const out = {};
  for (const tf of timeframes) out[tf] = computeOpeningRange(bars, tf);
  return out;
}

/**
 * Live opening-range tracker — feed it minute bars as they arrive.
 * Maintains running high/low per timeframe and finalizes each window by time.
 */
export class OpeningRangeTracker {
  constructor(symbol, timeframes = config.strategy.orTimeframes) {
    this.symbol = symbol;
    this.timeframes = [...timeframes];
    this.state = Object.fromEntries(this.timeframes.map((tf) => [tf, emptyState(tf)]));
  }

  /** Incorporate one minute bar. Bars before the open are ignored. */
  addBar(bar) {
    const off = minutesFromOpen(bar.t);
    if (off < 0) return; // pre-market bar — not part of any OR
    for (const tf of this.timeframes) {
      const s = this.state[tf];
      if (off < tf) {
        s.orHigh = s.orHigh == null ? bar.h : Math.max(s.orHigh, bar.h);
        s.orLow = s.orLow == null ? bar.l : Math.min(s.orLow, bar.l);
        s.barCount += 1;
      } else if (!s.orComplete && s.barCount > 0) {
        // A bar at/after the window end proves the window closed.
        s.orComplete = true;
        s.orCompleteTime = windowEndIso(bar, tf);
      }
    }
  }

  /**
   * Time-based finalize: mark any window whose end has passed as complete,
   * even if no later bar arrived (e.g. thin stock, missing minutes).
   * @param {string|Date|dayjs} nowTs current time
   */
  finalizeDue(nowTs) {
    const nowOff = minutesFromOpen(nowTs);
    for (const tf of this.timeframes) {
      const s = this.state[tf];
      if (!s.orComplete && s.barCount > 0 && nowOff >= tf) {
        s.orComplete = true;
        s.orCompleteTime = windowEndIso({ t: nowTs }, tf);
      }
    }
  }

  getState(timeframe) {
    return this.state[timeframe];
  }

  /** All timeframe states as an array. */
  all() {
    return this.timeframes.map((tf) => this.state[tf]);
  }
}

export default { minutesFromOpen, computeOpeningRange, computeAllOpeningRanges, OpeningRangeTracker };

// CLI demo: fetch a real session's first 35 minutes and compute the 3 ORs.
//   node src/strategy/openingRange.js [YYYY-MM-DD] [SYM ...]
// Defaults: most recent weekday, symbols NVDA AAPL TSLA. Persists to DB.
if (process.argv[1]?.endsWith('openingRange.js')) {
  const run = async () => {
    const dayjs = (await import('dayjs')).default;
    const tz = (await import('dayjs/plugin/timezone.js')).default;
    const utc = (await import('dayjs/plugin/utc.js')).default;
    dayjs.extend(utc); dayjs.extend(tz);
    const { getMinuteBars } = await import('../data/marketData.js');
    const { saveOpeningRange } = await import('../data/database.js');
    const logger = (await import('../utils/logger.js')).default;

    const args = process.argv.slice(2);
    let date = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
    if (!date) {
      // most recent weekday in ET
      let d = dayjs().tz(config.timezone);
      do { d = d.subtract(1, 'day'); } while (d.day() === 0 || d.day() === 6);
      date = d.format('YYYY-MM-DD');
    }
    const symbols = args.filter((a) => !/^\d{4}-\d{2}-\d{2}$/.test(a));
    if (symbols.length === 0) symbols.push('NVDA', 'AAPL', 'TSLA');

    // 09:30–10:05 ET window for the session, as UTC ISO.
    const startIso = dayjs.tz(`${date} 09:30`, config.timezone).toDate().toISOString();
    const endIso = dayjs.tz(`${date} 10:05`, config.timezone).toDate().toISOString();
    logger.info(`Opening ranges for ${date} (${symbols.join(', ')})`);

    for (const symbol of symbols) {
      const bars = await getMinuteBars(symbol, startIso, endIso);
      const ranges = computeAllOpeningRanges(bars);
      const rows = Object.values(ranges).map((r) => {
        if (r.orComplete) saveOpeningRange(date, symbol, r.timeframe, r.orHigh, r.orLow, r.orCompleteTime);
        return {
          tf: `${r.timeframe}m`,
          high: r.orHigh != null ? r.orHigh.toFixed(2) : '—',
          low: r.orLow != null ? r.orLow.toFixed(2) : '—',
          range: r.orHigh != null ? (r.orHigh - r.orLow).toFixed(2) : '—',
          bars: r.barCount,
          complete: r.orComplete,
        };
      });
      console.log(`\n${symbol}  (${bars.length} bars in 09:30–10:05 window)`);
      console.table(rows);
    }
    process.exit(0);
  };
  run().catch((e) => { console.error(e.message); process.exit(1); });
}
