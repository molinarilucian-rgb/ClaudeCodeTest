/**
 * Pure formatters for the periodic breakout-monitor audit logs.
 * Kept I/O-free so they're unit-testable and so the wording stays consistent.
 *
 * The "relevant" OR level depends on the trade bias: a gap-up stock is watched
 * for a break ABOVE the OR high (long); a gap-down stock for a break BELOW the
 * OR low (short).
 */

/** True if this symbol is a short bias (gapped down). */
export function isShortBias(gapPct) {
  return (gapPct ?? 0) < 0;
}

/**
 * One-line status: current price vs the relevant OR level + distance to break.
 * e.g. "AVGO 15m monitor | price 400.18 | OR low 400.00 | +0.18 above (no break)"
 */
export function formatMonitorStatus({ symbol, timeframe, price, orHigh, orLow, gapPct }) {
  const short = isShortBias(gapPct);
  const level = short ? orLow : orHigh;
  const label = short ? 'OR low' : 'OR high';
  const diff = price - level;
  // Long breaks when price reaches/exceeds OR high; short when it reaches/breaches OR low.
  const broken = short ? price <= level : price >= level;
  const rel = diff >= 0 ? `+${diff.toFixed(2)} above` : `${Math.abs(diff).toFixed(2)} below`;
  return `${symbol} ${timeframe}m monitor | price ${price.toFixed(2)} | ${label} ${level.toFixed(2)} | ${rel} (${broken ? 'BREAK' : 'no break'})`;
}

/**
 * Pending-confirmation line: a candle closed beyond the OR, awaiting the
 * next-candle confirmation (false-breakout filter).
 * e.g. "AVGO 15m PENDING — closed below OR low, awaiting next-candle confirmation"
 */
export function formatMonitorPending({ symbol, timeframe, direction }) {
  const side = direction === 'short' ? 'below OR low' : 'above OR high';
  return `${symbol} ${timeframe}m PENDING — closed ${side}, awaiting next-candle confirmation`;
}

/**
 * Explain why a structurally-valid breakout did NOT become a signal. Inspects the
 * signal's confirmation flags and returns one human-readable reason per failed
 * check, so every otherwise-silent rejection in the monitor becomes auditable.
 *
 * 'pending' and 'failed' (false-breakout) states are handled separately by the
 * caller and are intentionally not covered here.
 *
 * @param {object} signal a detectBreakout() result (needs confirmations/direction/…)
 * @param {object} [thresholds] optional { volumeMult } for richer wording
 * @returns {string[]} reasons (empty when the signal actually triggered)
 */
export function formatRejectionReasons(signal, thresholds = {}) {
  if (!signal || signal.triggered) return [];
  const c = signal.confirmations || {};
  const isLong = signal.direction === 'long';
  const gapTxt = signal.gapPct == null
    ? 'n/a'
    : `${signal.gapPct >= 0 ? '+' : ''}${signal.gapPct.toFixed(2)}%`;
  const reasons = [];

  if (c.noPosition === false) {
    reasons.push('existing position already open');
  }
  if (c.gapAligned === false) {
    const gapDir = (signal.gapPct ?? 0) >= 0 ? 'gap up' : 'gap down';
    reasons.push(`gap direction mismatch (${gapDir} ${gapTxt}, ${signal.direction} breakout blocked)`);
  }
  if (c.vwapAligned === false) {
    const vwapTxt = signal.vwap != null ? signal.vwap.toFixed(2) : 'n/a';
    reasons.push(isLong
      ? `price below VWAP on a long breakout (entry ${signal.entryPrice.toFixed(2)} ≤ VWAP ${vwapTxt})`
      : `price above VWAP on a short breakout (entry ${signal.entryPrice.toFixed(2)} ≥ VWAP ${vwapTxt})`);
  }
  if (c.volumeSurge === false) {
    const need = thresholds.volumeMult != null ? ` < ${thresholds.volumeMult}×` : '';
    reasons.push(`volume surge insufficient (${signal.volumeRatio.toFixed(1)}×${need})`);
  }
  if (c.beforeCutoff === false) {
    reasons.push('past the 11:00 ET entry cutoff');
  }
  if (c.priceBreak === false) {
    reasons.push('no price break beyond the OR level');
  }
  if (c.candleClose === false) {
    reasons.push('breakout candle did not close beyond the OR level');
  }
  return reasons;
}

/**
 * Single-line blocking reason for a BREAK that hasn't become a signal yet. Covers
 * every "stuck" state the monitor can sit in, so a lingering BREAK can always be
 * explained in one log line:
 *   - no signal object       → price is beyond the OR only intrabar (no close beyond)
 *   - confirmation 'pending' → a candle closed beyond, awaiting next-candle confirmation
 *   - signal not triggered   → a confirmation filter failed (gap/VWAP/volume/cutoff/…)
 *
 * @param {object|null} signal a detectBreakout() result, or null when nothing closed beyond
 * @param {object} [thresholds] optional { volumeMult }, passed to formatRejectionReasons
 * @returns {string} one human-readable reason (filter failures joined with "; ")
 */
export function describeBreakBlock(signal, thresholds = {}) {
  if (!signal) {
    return 'no candle has CLOSED beyond the OR yet (price is beyond the level intrabar only)';
  }
  if (signal.confirmation === 'pending') {
    return 'breakout candle closed beyond the OR; awaiting next-candle confirmation (false-breakout filter pending)';
  }
  const reasons = formatRejectionReasons(signal, thresholds);
  return reasons.length ? reasons.join('; ') : 'one or more confirmation filters not met';
}

export default { isShortBias, formatMonitorStatus, formatMonitorPending, formatRejectionReasons, describeBreakBlock };
