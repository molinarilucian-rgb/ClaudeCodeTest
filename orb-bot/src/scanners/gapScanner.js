import config from '../../config/config.js';
import logger from '../utils/logger.js';
import { getSnapshots } from '../data/marketData.js';
import { scanUniverse } from './universeScanner.js';
import { classifyCatalyst, qualityRank } from '../data/perplexity.js';
import { saveWatchlistEntry } from '../data/database.js';
import { etDateStr } from '../utils/timeUtils.js';

/**
 * Pre-Market Gap Scanner (Phase 1/2 bridge)
 * -----------------------------------------
 * Pipeline:
 *   1. universe scan → liquid candidates (with ATR)
 *   2. snapshot each → gap% vs prev close + pre-market volume
 *   3. gap filters: |gap| > minAbsGapPct AND pm volume > minPreMarketVolume
 *   4. catalyst classification (Perplexity) for survivors
 *   5. quality filter: drop low-quality / non-tradeable / fade-prone gap-ups
 *   6. rank by (|gap%| × pmVolume) / ATR, take top N, persist to DB
 */

const { gap, catalyst, selection } = config;
const minQualityRank = qualityRank(catalyst.minQuality);

/** Safely read a price/volume field that may use verbose or short keys. */
const num = (obj, ...keys) => {
  for (const k of keys) if (obj && obj[k] != null) return obj[k];
  return null;
};

/** Compute gap stats for one snapshot. */
function gapStatsFor(symbol, snap) {
  if (!snap) return null;
  const price = num(snap.LatestTrade, 'Price') ?? num(snap.MinuteBar, 'ClosePrice');
  const prevClose = num(snap.PrevDailyBar, 'ClosePrice');
  const pmVolume = num(snap.DailyBar, 'Volume') ?? 0; // accumulating volume during pre-market (IEX proxy)
  if (price == null || prevClose == null || !prevClose) return null;
  const gapPct = ((price - prevClose) / prevClose) * 100;
  return { symbol, price, prevClose, pmVolume, gapPct };
}

/** Does this catalyst clear the quality bar for this gap direction? */
function passesQuality(cat, gapPct) {
  if (qualityRank(cat.quality) < minQualityRank) return false;
  if (!cat.tradeable) return false;
  // Reject fade-prone catalysts on gap UPs (e.g. dilution/offering).
  if (gapPct > 0 && catalyst.fadeProneOnGapUp.includes(cat.catalyst_type)) return false;
  return true;
}

/**
 * Run the full gap scan.
 * @param {object[]} [universe] qualified universe candidates; scans fresh if omitted
 * @returns {Promise<{selected: object[], evaluated: object[]}>}
 */
export async function scanGaps(universe) {
  const date = etDateStr();
  const qualified = universe || (await scanUniverse()).qualified;
  if (qualified.length === 0) {
    logger.warn('Gap scan: no qualified universe candidates');
    return { selected: [], evaluated: [] };
  }

  const atrBySymbol = Object.fromEntries(qualified.map((c) => [c.symbol, c.atr14]));
  const nameBySymbol = Object.fromEntries(qualified.map((c) => [c.symbol, c.name]));
  const symbols = qualified.map((c) => c.symbol);

  const snapshots = await getSnapshots(symbols);
  // Wall-clock moment the snapshot (prev close + pre-market price) was pulled —
  // one fetch per scan, since Alpaca returns both values in a single snapshot.
  const fetchedAt = new Date().toISOString();

  // Step 1: gap + volume filter.
  const gappers = [];
  for (const symbol of symbols) {
    const stats = gapStatsFor(symbol, snapshots[symbol]);
    if (!stats) { logger.debug(`gap: no snapshot data for ${symbol}`); continue; }
    const passesGap = Math.abs(stats.gapPct) >= gap.minAbsGapPct;
    const passesVol = stats.pmVolume >= gap.minPreMarketVolume;
    if (passesGap && passesVol) {
      gappers.push(stats);
    } else {
      logger.debug(`gap: ${symbol} filtered (gap=${stats.gapPct.toFixed(2)}%, pmVol=${stats.pmVolume})`);
    }
  }
  logger.info(`Gap scan: ${gappers.length}/${symbols.length} cleared gap+volume filter`);

  // Step 2: classify catalysts (parallel; small set so no throttling needed).
  const classified = await Promise.all(
    gappers.map(async (g) => {
      const cat = catalyst.enabled
        ? await classifyCatalyst({ symbol: g.symbol, name: nameBySymbol[g.symbol], gapPct: g.gapPct, prevClose: g.prevClose, price: g.price })
        : { catalyst_type: 'unknown', quality: 'none', sentiment: 'neutral', tradeable: true, confidence: 0, classified: false };
      return { ...g, catalyst: cat };
    })
  );

  // Step 3: quality filter + ranking score.
  const evaluated = classified.map((c) => {
    const atr = atrBySymbol[c.symbol] || 1;
    const rankScore = (Math.abs(c.gapPct) * c.pmVolume) / atr;
    // Fail-open: if classification didn't run/failed, keep unless config says drop.
    const qualityOk = c.catalyst.classified
      ? passesQuality(c.catalyst, c.gapPct)
      : catalyst.failOpen;
    return { ...c, rankScore, qualityOk };
  });

  const keepers = evaluated
    .filter((c) => c.qualityOk)
    .sort((a, b) => b.rankScore - a.rankScore);

  const selected = keepers.slice(0, selection.topN).map((c) => ({ ...c, selected: true }));
  const selectedSet = new Set(selected.map((c) => c.symbol));

  // Persist every evaluated candidate (selected flag set on top N).
  for (const c of evaluated) {
    saveWatchlistEntry(date, {
      symbol: c.symbol,
      gapPct: c.gapPct,
      preMarketVolume: c.pmVolume,
      prevClose: c.prevClose,
      preMarketPrice: c.price,
      fetchedAt,
      rankScore: c.rankScore,
      selected: selectedSet.has(c.symbol),
      catalyst: c.catalyst,
    });
  }

  logger.info(`Gap scan: ${keepers.length} passed quality, selected top ${selected.length}`);
  return { selected, evaluated };
}

// CLI: node src/scanners/gapScanner.js
if (process.argv[1]?.endsWith('gapScanner.js')) {
  scanGaps()
    .then(({ selected, evaluated }) => {
      console.log('\n=== EVALUATED (gap survivors) ===');
      if (evaluated.length === 0) {
        console.log('(none cleared the gap+volume filter today)');
      } else {
        console.table(evaluated.map((c) => ({
          symbol: c.symbol,
          gap: `${c.gapPct >= 0 ? '+' : ''}${c.gapPct.toFixed(2)}%`,
          pmVol: c.pmVolume,
          catalyst: c.catalyst.catalyst_type,
          quality: c.catalyst.quality,
          tradeable: c.catalyst.tradeable,
          keep: c.qualityOk,
          score: Math.round(c.rankScore),
        })));
      }
      console.log('\n=== SELECTED WATCHLIST (top 5) ===');
      console.table(selected.map((c) => ({
        symbol: c.symbol,
        gap: `${c.gapPct >= 0 ? '+' : ''}${c.gapPct.toFixed(2)}%`,
        catalyst: c.catalyst.catalyst_type,
        summary: (c.catalyst.catalyst_summary || '').slice(0, 60),
      })));
      process.exit(0);
    })
    .catch((err) => {
      logger.error(`Gap scan failed: ${err.message}`);
      process.exit(1);
    });
}

export default { scanGaps };
