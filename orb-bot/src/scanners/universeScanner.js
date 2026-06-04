import config from '../../config/config.js';
import logger from '../utils/logger.js';
import { getAsset, getDailyBars } from '../data/marketData.js';
import { atr, avgVolume } from '../utils/indicators.js';

/**
 * Universe Scanner (Phase 1)
 * --------------------------
 * Applies the spec's "Universe Filters" to a seed list and returns qualified
 * candidates enriched with the metrics later phases need (prevClose, avgVol,
 * ATR). Each candidate carries a `flags` object recording which spec criteria
 * could NOT be verified from Alpaca's standard API (see README "Data Limitations").
 *
 * Enforced here (Alpaca-backed):
 *   - Exchange ∈ {NYSE, NASDAQ}
 *   - Price ∈ [minPrice, maxPrice]
 *   - 20-day avg volume > minAvgDailyVolume
 *   - Tradable / active
 *
 * Flagged-only (needs external data, wired up in later phases):
 *   - Market cap > $2B
 *   - Optionable
 *   - No earnings today/tomorrow
 *   - ETF/ADR/leveraged/recent-IPO exclusions
 */

const { universe } = config;

/** Map Alpaca exchange codes to our accepted set. */
function exchangeAccepted(exchange) {
  return universe.exchanges.includes(exchange);
}

/** Evaluate one symbol; returns an enriched candidate or a rejection record. */
async function evaluateSymbol(symbol) {
  const reject = (reason) => ({ symbol, qualified: false, reason });

  let asset;
  try {
    asset = await getAsset(symbol);
  } catch {
    return reject('asset lookup failed');
  }

  if (asset.status !== 'active' || !asset.tradable) return reject('not active/tradable');
  if (!exchangeAccepted(asset.exchange)) return reject(`exchange ${asset.exchange} not in ${universe.exchanges.join('/')}`);

  // Need enough daily history for ATR(14) and 20-day avg volume.
  const lookback = Math.max(universe.avgVolumeLookbackDays, config.strategy.atrPeriod) + 15;
  let bars;
  try {
    bars = await getDailyBars(symbol, lookback);
  } catch {
    return reject('daily bars failed');
  }
  if (bars.length < universe.avgVolumeLookbackDays + 1) return reject(`insufficient history (${bars.length} bars)`);

  const last = bars[bars.length - 1];
  const prevClose = last.c;
  const price = last.c;
  const avgVol20d = avgVolume(bars, universe.avgVolumeLookbackDays);
  const atr14 = atr(bars, config.strategy.atrPeriod);

  // --- Enforceable filters ---
  if (price < universe.minPrice || price > universe.maxPrice) {
    return reject(`price $${price.toFixed(2)} outside [$${universe.minPrice}, $${universe.maxPrice}]`);
  }
  if (avgVol20d < universe.minAvgDailyVolume) {
    return reject(`avgVol ${(avgVol20d / 1e6).toFixed(1)}M < ${(universe.minAvgDailyVolume / 1e6)}M`);
  }

  // --- Flagged-only criteria (not verifiable from Alpaca standard API) ---
  const attributes = asset.attributes || [];
  const flags = {
    marketCapVerified: false,        // no market-cap field in Alpaca
    optionableVerified: false,       // no reliable optionable flag
    earningsChecked: false,          // needs earnings calendar source
    exclusionsChecked: false,        // ETF/ADR/leveraged/IPO age
    fractionable: asset.fractionable,
    shortable: asset.shortable,
    easyToBorrow: asset.easy_to_borrow,
    alpacaAttributes: attributes,
  };

  return {
    symbol,
    qualified: true,
    exchange: asset.exchange,
    name: asset.name,
    price,
    prevClose,
    avgVol20d: Math.round(avgVol20d),
    atr14: atr14 != null ? Number(atr14.toFixed(4)) : null,
    flags,
  };
}

/**
 * Scan the configured seed universe (or a provided symbol list).
 * @returns {Promise<{qualified: object[], rejected: object[]}>}
 */
export async function scanUniverse(symbols = universe.seedSymbols) {
  logger.info(`Universe scan: evaluating ${symbols.length} symbols`);
  const results = await Promise.all(symbols.map(evaluateSymbol));

  const qualified = results.filter((r) => r.qualified);
  const rejected = results.filter((r) => !r.qualified);

  logger.info(`Universe scan complete: ${qualified.length} qualified, ${rejected.length} rejected`);
  for (const r of rejected) logger.debug(`  rejected ${r.symbol}: ${r.reason}`);

  return { qualified, rejected };
}

// CLI: `node src/scanners/universeScanner.js`
if (process.argv[1]?.endsWith('universeScanner.js')) {
  scanUniverse()
    .then(({ qualified, rejected }) => {
      console.log('\n=== QUALIFIED ===');
      console.table(
        qualified.map((c) => ({
          symbol: c.symbol,
          exch: c.exchange,
          price: `$${c.price.toFixed(2)}`,
          avgVol20d: `${(c.avgVol20d / 1e6).toFixed(1)}M`,
          atr14: c.atr14,
        }))
      );
      if (rejected.length) {
        console.log('\n=== REJECTED ===');
        console.table(rejected.map((r) => ({ symbol: r.symbol, reason: r.reason })));
      }
      console.log('\nNote: market-cap, optionable, earnings & exclusion filters are FLAGGED ');
      console.log('only — not enforced (Alpaca standard API lacks this data). See README.');
    })
    .catch((err) => {
      logger.error(`Scan failed: ${err.message}`);
      process.exit(1);
    });
}

export default { scanUniverse };
