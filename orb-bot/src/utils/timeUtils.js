import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import config from '../../config/config.js';

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = config.timezone;

// US market holidays (NYSE) — extend yearly. Dates are ET calendar days.
const MARKET_HOLIDAYS_2026 = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
]);

/** Current time in market timezone (America/New_York). */
export const nowEt = () => dayjs().tz(TZ);

/** Convert any input (UTC string, Date, dayjs) to ET. */
export const toEt = (t) => dayjs(t).tz(TZ);

/** "HH:mm" ET string for a given moment (default: now). */
export const etTimeStr = (t = nowEt()) => toEt(t).format('HH:mm');

/** "YYYY-MM-DD" ET date string. */
export const etDateStr = (t = nowEt()) => toEt(t).format('YYYY-MM-DD');

/** Build a dayjs at a specific ET "HH:mm" for today's ET date. */
export const etTimeToday = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return nowEt().hour(h).minute(m).second(0).millisecond(0);
};

/** True if `hhmm` (ET) has passed for today. */
export const isPastEt = (hhmm) => nowEt().isAfter(etTimeToday(hhmm));

/** Weekend check in ET. */
export const isWeekend = (t = nowEt()) => {
  const d = toEt(t).day();
  return d === 0 || d === 6;
};

/** NYSE holiday check in ET. */
export const isHoliday = (t = nowEt()) => MARKET_HOLIDAYS_2026.has(etDateStr(t));

/** True if today is a normal trading day (not weekend/holiday). */
export const isTradingDay = (t = nowEt()) => !isWeekend(t) && !isHoliday(t);

/** True if ET now is within regular session 09:30–16:00. */
export const isMarketHours = (t = nowEt()) => {
  if (!isTradingDay(t)) return false;
  const mins = toEt(t).hour() * 60 + toEt(t).minute();
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
};

export default {
  nowEt, toEt, etTimeStr, etDateStr, etTimeToday, isPastEt,
  isWeekend, isHoliday, isTradingDay, isMarketHours,
};
