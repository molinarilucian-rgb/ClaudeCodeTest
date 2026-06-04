import config from '../../config/config.js';
import { vwap } from '../utils/indicators.js';
import { minutesFromOpen } from './openingRange.js';

/**
 * Breakout detector (Phase 2)
 * ---------------------------
 * Evaluates whether the latest candle constitutes a valid ORB entry signal for
 * a given symbol + opening-range timeframe, checking every confirmation the
 * spec requires. Returns a signal object describing the breakout and each
 * confirmation's pass/fail; `triggered` is true only when ALL pass.
 *
 * Long entry conditions (mirror for shorts):
 *   1. OR established (orComplete)
 *   2. price breaks above OR high
 *   3. breakout candle CLOSES above OR high
 *   4. pre-market gap was > +1% (gap-up confirmation)
 *   5. price is above session VWAP (institutional bias)
 *   6. breakout-candle volume > 1.5× avg of the prior 5 candles
 *   7. time is before the 11:00 ET entry cutoff
 *   8. no active position already (de-dup handled by caller)
 */

const { strategy, gap } = config;

/** Convert an ET "HH:mm" to minutes after the 09:30 open. */
function hhmmToOffset(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m - (9 * 60 + 30);
}

/** Entry cutoff as minutes-from-open (11:00 ET → 90). */
export const ENTRY_CUTOFF_OFFSET = hhmmToOffset(strategy.entryCutoffEt);

/**
 * @param {object} p
 * @param {string} p.symbol
 * @param {number} p.timeframe          OR timeframe in minutes (5/15/30)
 * @param {object} p.orState            from computeOpeningRange (needs orComplete/orHigh/orLow)
 * @param {Array}  p.sessionBars        chronological 1-min bars 09:30→now (last = breakout candle)
 * @param {number} p.gapPct             pre-market gap % for the symbol
 * @param {boolean} [p.hasPosition]     whether a position is already open
 * @returns {object|null} signal, or null if there's no directional break to evaluate
 */
export function detectBreakout({ symbol, timeframe, orState, sessionBars, gapPct, hasPosition = false }) {
  if (!orState || !orState.orComplete || orState.orHigh == null || orState.orLow == null) return null;
  if (!sessionBars || sessionBars.length === 0) return null;

  const candle = sessionBars[sessionBars.length - 1];
  const offset = minutesFromOpen(candle.t);
  if (offset < timeframe) return null; // breakout candle must come after the OR window

  const longBreak = candle.h > orState.orHigh;
  const shortBreak = candle.l < orState.orLow;
  if (!longBreak && !shortBreak) return null; // nothing broke — not a signal

  // Pick direction; if a single candle pierced both extremes, go by the close.
  let direction;
  if (longBreak && shortBreak) {
    direction = candle.c >= orState.orHigh ? 'long' : candle.c <= orState.orLow ? 'short' : 'long';
  } else {
    direction = longBreak ? 'long' : 'short';
  }
  const isLong = direction === 'long';

  const sessionVwap = vwap(sessionBars);
  // Average volume of the 5 candles immediately BEFORE the breakout candle.
  const prior = sessionBars.slice(Math.max(0, sessionBars.length - 6), sessionBars.length - 1);
  const avgVol5 = prior.length ? prior.reduce((a, b) => a + b.v, 0) / prior.length : 0;
  const volumeRatio = avgVol5 > 0 ? candle.v / avgVol5 : 0;

  const confirmations = {
    orEstablished: true,
    priceBreak: isLong ? candle.h > orState.orHigh : candle.l < orState.orLow,
    candleClose: isLong ? candle.c > orState.orHigh : candle.c < orState.orLow,
    gapAligned: isLong ? (gapPct ?? 0) >= gap.minAbsGapPct : (gapPct ?? 0) <= -gap.minAbsGapPct,
    vwapAligned: sessionVwap != null && (isLong ? candle.c > sessionVwap : candle.c < sessionVwap),
    volumeSurge: volumeRatio >= strategy.breakoutVolumeMult,
    beforeCutoff: offset < ENTRY_CUTOFF_OFFSET,
    noPosition: !hasPosition,
  };
  const triggered = Object.values(confirmations).every(Boolean);

  // Entry at the breakout candle close; stop at the opposite OR extreme + buffer.
  const entryPrice = candle.c;
  const stopPrice = isLong
    ? orState.orLow - orState.orLow * strategy.stopBufferPct
    : orState.orHigh + orState.orHigh * strategy.stopBufferPct;
  const risk = Math.abs(entryPrice - stopPrice);
  const targets = strategy.rrRatios.map((rr) => ({
    rr,
    price: isLong ? entryPrice + risk * rr : entryPrice - risk * rr,
  }));

  return {
    symbol,
    timeframe,
    direction,
    triggered,
    time: candle.t,
    offset,
    entryPrice,
    orHigh: orState.orHigh,
    orLow: orState.orLow,
    stopPrice,
    risk,
    targets,
    gapPct: gapPct ?? null,
    vwap: sessionVwap,
    breakoutVolume: candle.v,
    avgVol5,
    volumeRatio,
    confirmations,
  };
}

export default { detectBreakout, ENTRY_CUTOFF_OFFSET };
