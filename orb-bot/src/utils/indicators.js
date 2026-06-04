// Pure technical-indicator helpers. No I/O — easy to unit test.

/** True Range for a single bar given the previous close. */
export function trueRange(high, low, prevClose) {
  return Math.max(
    high - low,
    Math.abs(high - prevClose),
    Math.abs(low - prevClose)
  );
}

/**
 * Average True Range (Wilder's smoothing).
 * @param {Array<{h:number,l:number,c:number}>} bars chronological daily bars
 * @param {number} period default 14
 * @returns {number|null} ATR, or null if not enough data
 */
export function atr(bars, period = 14) {
  if (!bars || bars.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    trs.push(trueRange(bars[i].h, bars[i].l, bars[i - 1].c));
  }
  // Seed with simple average of first `period` TRs, then Wilder-smooth.
  let atrVal = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atrVal = (atrVal * (period - 1) + trs[i]) / period;
  }
  return atrVal;
}

/** Simple moving average of a numeric series (last `period` values). */
export function sma(values, period) {
  if (!values || values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/** Average volume over the last `period` bars. */
export function avgVolume(bars, period) {
  return sma(bars.map((b) => b.v), period);
}

/**
 * Session VWAP from intraday bars.
 * @param {Array<{h:number,l:number,c:number,v:number}>} bars
 * @returns {number|null}
 */
export function vwap(bars) {
  if (!bars || bars.length === 0) return null;
  let pv = 0, vol = 0;
  for (const b of bars) {
    const typical = (b.h + b.l + b.c) / 3;
    pv += typical * b.v;
    vol += b.v;
  }
  return vol === 0 ? null : pv / vol;
}

/** Standard deviation of a numeric series (population). */
export function stdDev(values) {
  if (!values || values.length === 0) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/** Gap % of pre-market/open price vs previous close. */
export function gapPct(price, prevClose) {
  if (!prevClose) return null;
  return ((price - prevClose) / prevClose) * 100;
}

export default { trueRange, atr, sma, avgVolume, vwap, stdDev, gapPct };
