/**
 * Position sizing (Phase 3)
 * -------------------------
 * Pure, side-effect-free risk-based sizing so it can be unit-tested without a
 * broker. Risk per trade is a fixed fraction of account size; share count is
 * the most shares whose worst-case loss (entry → stop) stays within that risk.
 *
 *   riskAmount   = accountSize × maxRiskPerTrade
 *   perShareRisk = |entry − stop|
 *   shares       = floor(riskAmount ÷ perShareRisk)
 *
 * A position is SKIPPED (never silently shrunk) when it can't be sized safely:
 *   - entry == stop            (no definable risk)
 *   - shares < 1               (risk too small to afford one share)
 *   - notional > buyingPower   (would exceed available buying power)
 *
 * The returned object always carries the full math so the caller can log every
 * input and intermediate for an auditable sizing trail.
 */

/**
 * @param {object} p
 * @param {number} p.accountSize        e.g. 100000
 * @param {number} p.maxRiskPerTrade    fraction, e.g. 0.01 (=1%)
 * @param {number} p.entry              intended entry price
 * @param {number} p.stop               stop-loss price
 * @param {number} p.buyingPower        available buying power right now
 * @returns {{
 *   shares:number, riskAmount:number, perShareRisk:number, notional:number,
 *   skip:boolean, reason:(string|null), accountSize:number, maxRiskPerTrade:number,
 *   entry:number, stop:number, buyingPower:number
 * }}
 */
export function sizePosition({ accountSize, maxRiskPerTrade, entry, stop, buyingPower }) {
  const riskAmount = accountSize * maxRiskPerTrade;
  const perShareRisk = Math.abs(entry - stop);

  const base = {
    accountSize, maxRiskPerTrade, entry, stop, buyingPower,
    riskAmount, perShareRisk, shares: 0, notional: 0, skip: true, reason: null,
  };

  if (!Number.isFinite(perShareRisk) || perShareRisk <= 0) {
    return { ...base, reason: 'invalid risk: entry equals stop (no definable stop distance)' };
  }

  const shares = Math.floor(riskAmount / perShareRisk);
  if (shares < 1) {
    return { ...base, reason: `risk too small for one share (riskAmount $${riskAmount.toFixed(2)} < per-share risk $${perShareRisk.toFixed(2)})` };
  }

  const notional = shares * entry;
  if (notional > buyingPower) {
    return {
      ...base, shares, notional,
      reason: `notional $${notional.toFixed(2)} exceeds available buying power $${Number(buyingPower).toFixed(2)}`,
    };
  }

  return { ...base, shares, notional, skip: false };
}

/** One-line, human-readable dump of the sizing math for logs. */
export function describeSizing(s, { symbol = '', rr = '' } = {}) {
  const tag = symbol ? `${symbol}${rr ? ` rr${rr}` : ''} ` : '';
  return (
    `${tag}sizing | account $${s.accountSize.toLocaleString()} × ${(s.maxRiskPerTrade * 100).toFixed(2)}% ` +
    `= risk $${s.riskAmount.toFixed(2)} | entry $${s.entry.toFixed(2)} stop $${s.stop.toFixed(2)} ` +
    `→ per-share risk $${s.perShareRisk.toFixed(2)} | shares ${s.shares} | notional $${s.notional.toFixed(2)} ` +
    `(buying power $${Number(s.buyingPower).toFixed(2)})` +
    (s.skip ? ` | SKIP: ${s.reason}` : '')
  );
}

export default { sizePosition, describeSizing };
