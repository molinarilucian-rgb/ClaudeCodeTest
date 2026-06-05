/**
 * Startup catch-up policy (pure, testable — no I/O).
 * Decides what a freshly-booted bot should do based on the current time and
 * whether a watchlist already exists in the DB. Kept separate from bot.js so it
 * can be unit-tested without booting the scheduler.
 *
 * Offsets are minutes from the 09:30 ET open: 09:00 = -30, 09:35 = +5.
 */

export const NINE_AM_OFFSET = -30; // 09:00 ET

/**
 * @param {object} p
 * @param {number} p.nowOff         minutes from the 09:30 ET open (negative = pre-open)
 * @param {boolean} p.tradingDay    is today a trading day (not weekend/holiday)
 * @param {number} p.watchlistCount selected watchlist rows already in the DB for today
 * @param {number} p.orFirstOff     offset of the earliest OR close (5 → 09:35)
 * @param {number} [p.nineAmOff]    offset of the 09:00 scan (default -30)
 * @returns {'closed'|'pre_market'|'recover'|'rebuild'|'stand_down'}
 */
export function decideStartupAction({ nowOff, tradingDay, watchlistCount, orFirstOff, nineAmOff = NINE_AM_OFFSET }) {
  if (!tradingDay) return 'closed';
  if (nowOff < nineAmOff) return 'pre_market';     // before 09:00 — cron will scan at 09:00
  if (nowOff >= orFirstOff) return 'stand_down';   // 09:35 or later — missed the OR window
  // In the 09:00–09:35 window: reuse a watchlist if present, else rebuild it now.
  return watchlistCount > 0 ? 'recover' : 'rebuild';
}

export default { decideStartupAction, NINE_AM_OFFSET };
