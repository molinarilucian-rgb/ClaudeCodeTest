import { getWatchlist, getOpeningRange, getTradesForDate } from '../data/database.js';
import { getMinuteBars } from '../data/marketData.js';
import { etToIso } from '../utils/timeUtils.js';
import logger from '../utils/logger.js';

/**
 * Phase 4 — gap-reversal scan.
 * ----------------------------
 * A "gap reversal" is a watchlist stock that gapped DOWN pre-market but, by
 * 10:00 ET, is trading ABOVE its 30-minute opening-range low — i.e. it reversed
 * up instead of breaking down (the short bias the strategy would have played).
 * Tracking how often the watchlist surfaces these, and how many went UNTRADED,
 * tells us how much edge the gap-down side is leaving on the table.
 *
 * READ ONLY: reads stored ORs + minute bars, never touches the broker. The 10:00
 * price is pulled retroactively during the daily report, so no extra scheduled
 * job is needed.
 */

const REVERSAL_TF = 30;        // OR timeframe whose low defines the reversal (window 09:30–10:00)
const CUTOFF_HHMM = '10:00';   // "trading above OR low by 10:00 ET"

/**
 * Compute gap-reversal stats for a date. Pure of persistence — the caller decides
 * where to store the result.
 * @param {string} date ET date "YYYY-MM-DD"
 * @returns {Promise<{watchlistCount:number, gapDownCount:number,
 *   gapReversalCount:number, untradedReversalCount:number, reversalSymbols:string[]}>}
 */
export async function computeGapReversals(date) {
  const selected = getWatchlist(date).filter((r) => r.selected);
  const gapDown = selected.filter((r) => (r.gap_pct ?? 0) < 0);
  const tradedSymbols = new Set(getTradesForDate(date).map((t) => t.symbol));

  // Pull a few minutes around the cutoff; take the last bar at/under 10:00 ET.
  const start = etToIso(date, '09:55');
  const end = etToIso(date, '10:01');
  const cutoffMs = Date.parse(etToIso(date, CUTOFF_HHMM));

  const reversalSymbols = [];
  let untradedReversalCount = 0;

  for (const row of gapDown) {
    const or = getOpeningRange(date, row.symbol, REVERSAL_TF);
    if (!or || or.or_low == null) continue; // no 30m OR locked → can't classify

    let price = null;
    try {
      const bars = await getMinuteBars(row.symbol, start, end);
      for (const b of bars) {
        if (Date.parse(b.t) <= cutoffMs) price = b.c; // bars are chronological
      }
    } catch (err) {
      logger.warn(`gap-reversal: minute bars failed for ${row.symbol}: ${err.message}`);
      continue;
    }
    if (price == null) continue; // no 10:00 price (feed gap) → can't classify

    if (price > or.or_low) {
      reversalSymbols.push(row.symbol);
      if (!tradedSymbols.has(row.symbol)) untradedReversalCount += 1;
    }
  }

  return {
    watchlistCount: selected.length,
    gapDownCount: gapDown.length,
    gapReversalCount: reversalSymbols.length,
    untradedReversalCount,
    reversalSymbols,
  };
}

export default { computeGapReversals };
