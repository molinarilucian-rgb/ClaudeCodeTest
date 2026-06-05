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

const clamp10 = (x) => Math.max(0, Math.min(10, x));
const gradeFor = (x) => (x >= 9 ? 'A+' : x >= 8 ? 'A' : x >= 6.5 ? 'B' : x >= 5 ? 'C' : 'D');

/**
 * Signal quality score (1–10) — blends four strength factors so A+ setups can
 * be separated from mediocre ones. Each factor is normalized to 0–10 at its
 * configured "full marks" threshold, then weighted (see config.strategy.scoring).
 *   - volume: breakout-candle volume ratio vs the prior 5 candles (higher = better)
 *   - gap:    absolute pre-market gap size (larger = stronger)
 *   - close:  how far price closed beyond the OR level, as a fraction of OR range
 *   - vwap:   distance from VWAP on the correct side, as a % (further = stronger)
 * @returns {{score:number, grade:string, breakdown:{volume,gap,close,vwap}}}
 */
export function scoreSignal({ direction, volumeRatio, gapPct, entryPrice, orHigh, orLow, vwap }) {
  const s = strategy.scoring;
  const isLong = direction === 'long';

  const volume = clamp10((volumeRatio / s.volumeRatioMax) * 10);
  const gap = clamp10((Math.abs(gapPct ?? 0) / s.gapPctMax) * 10);

  const orRange = Math.max(orHigh - orLow, 1e-6);
  const beyond = isLong ? entryPrice - orHigh : orLow - entryPrice;
  const close = clamp10(((Math.max(beyond, 0) / orRange) / s.closeBeyondFracMax) * 10);

  let vwapScore = 0;
  if (vwap != null && vwap > 0) {
    const distPct = ((isLong ? entryPrice - vwap : vwap - entryPrice) / vwap) * 100;
    vwapScore = clamp10((Math.max(distPct, 0) / s.vwapDistPctMax) * 10);
  }

  const w = s.weights;
  const raw = volume * w.volume + gap * w.gap + close * w.close + vwapScore * w.vwap;
  const total = Math.max(1, Math.min(10, raw)); // a triggered signal floors at 1
  return {
    score: Number(total.toFixed(1)),
    grade: gradeFor(total),
    breakdown: {
      volume: Number(volume.toFixed(1)),
      gap: Number(gap.toFixed(1)),
      close: Number(close.toFixed(1)),
      vwap: Number(vwapScore.toFixed(1)),
    },
  };
}

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

  const quality = scoreSignal({
    direction, volumeRatio, gapPct, entryPrice,
    orHigh: orState.orHigh, orLow: orState.orLow, vwap: sessionVwap,
  });

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
    qualityScore: quality.score,
    qualityGrade: quality.grade,
    scoreBreakdown: quality.breakdown,
    confirmations,
  };
}

export default { detectBreakout, scoreSignal, ENTRY_CUTOFF_OFFSET };
