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

export default { isShortBias, formatMonitorStatus, formatMonitorPending };
