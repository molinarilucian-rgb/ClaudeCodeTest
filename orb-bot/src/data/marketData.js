import Alpaca from '@alpacahq/alpaca-trade-api';
import config from '../../config/config.js';
import logger from '../utils/logger.js';

// Single shared Alpaca client (paper trading only).
export const alpaca = new Alpaca({
  keyId: config.alpaca.keyId,
  secretKey: config.alpaca.secretKey,
  paper: config.alpaca.paper,
  baseUrl: config.alpaca.baseUrl,
});

// Free Alpaca data plans only include the IEX feed (SIP requires a paid plan).
const DATA_FEED = process.env.ALPACA_DATA_FEED || 'iex';

/** Exponential-backoff wrapper for transient errors / rate limits (HTTP 429). */
async function withRetry(fn, label, maxRetries = config.risk.apiMaxRetries) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.statusCode || err?.response?.status;
      const retriable = status === 429 || status >= 500 || err.code === 'ECONNRESET';
      if (!retriable || attempt >= maxRetries) {
        logger.error(`${label} failed (attempt ${attempt + 1}): ${err.message}`);
        throw err;
      }
      const waitMs = Math.min(1000 * 2 ** attempt, 16000);
      logger.warn(`${label} retriable error (${status}); backing off ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
      attempt++;
    }
  }
}

/** Verify connection and return account snapshot. */
export async function getAccount() {
  return withRetry(() => alpaca.getAccount(), 'getAccount');
}

/** All active, tradable US equity assets. */
export async function getTradableAssets() {
  const assets = await withRetry(
    () => alpaca.getAssets({ status: 'active', asset_class: 'us_equity' }),
    'getAssets'
  );
  return assets.filter((a) => a.tradable);
}

/** Single asset metadata (exchange, tradable, fractionable, etc.). */
export async function getAsset(symbol) {
  return withRetry(() => alpaca.getAsset(symbol), `getAsset ${symbol}`);
}

/**
 * Daily bars for a symbol over the last `lookbackDays` calendar days.
 * Returns chronological array of { t, o, h, l, c, v }.
 */
export async function getDailyBars(symbol, lookbackDays = 30) {
  const end = new Date();
  const start = new Date(end.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  return withRetry(async () => {
    const bars = [];
    const iter = alpaca.getBarsV2(symbol, {
      start: start.toISOString(),
      end: end.toISOString(),
      timeframe: '1Day',
      feed: DATA_FEED,
      adjustment: 'split',
    });
    for await (const b of iter) {
      bars.push({ t: b.Timestamp, o: b.OpenPrice, h: b.HighPrice, l: b.LowPrice, c: b.ClosePrice, v: b.Volume });
    }
    return bars;
  }, `getDailyBars ${symbol}`);
}

/**
 * Intraday minute bars for a symbol between ISO `start` and `end`.
 * Returns chronological array of { t, o, h, l, c, v }.
 */
export async function getMinuteBars(symbol, startIso, endIso) {
  return withRetry(async () => {
    const bars = [];
    const iter = alpaca.getBarsV2(symbol, {
      start: startIso,
      end: endIso,
      timeframe: '1Min',
      feed: DATA_FEED,
    });
    for await (const b of iter) {
      bars.push({ t: b.Timestamp, o: b.OpenPrice, h: b.HighPrice, l: b.LowPrice, c: b.ClosePrice, v: b.Volume });
    }
    return bars;
  }, `getMinuteBars ${symbol}`);
}

/**
 * Snapshot (latest trade/quote, daily & prev-daily bar) for many symbols.
 * Note: the snapshots endpoint has no feed param in this SDK — it serves the
 * account's default feed (IEX on the free plan), which is what we want here.
 */
export async function getSnapshots(symbols) {
  const list = await withRetry(
    () => alpaca.getSnapshots(symbols),
    `getSnapshots(${symbols.length})`
  );
  // SDK returns an array of snapshot entities keyed by .symbol — index by symbol.
  return Object.fromEntries(list.map((s) => [s.symbol, s]));
}

/** Market calendar entries (for holiday/half-day awareness). */
export async function getCalendar(start, end) {
  return withRetry(() => alpaca.getCalendar({ start, end }), 'getCalendar');
}

// ---- Order execution (Phase 3) ----
// Thin wrappers over the Alpaca trading API. The SIMULATION_MODE gate lives in
// the broker layer (src/execution/broker.js); these only hit the network when
// the broker is in LIVE mode, so they always perform real (paper) order ops.

/** Submit an order. `params` is the raw Alpaca order body (snake_case fields). */
export async function createOrder(params) {
  return withRetry(() => alpaca.createOrder(params), `createOrder ${params.symbol}`);
}

/** Fetch a single order by Alpaca order id. */
export async function getOrder(orderId) {
  return withRetry(() => alpaca.getOrder(orderId), `getOrder ${orderId}`);
}

/** Cancel an open order by id. */
export async function cancelOrder(orderId) {
  return withRetry(() => alpaca.cancelOrder(orderId), `cancelOrder ${orderId}`);
}

/** Open position for a symbol, or null if Alpaca reports none (404). */
export async function getPosition(symbol) {
  try {
    return await withRetry(() => alpaca.getPosition(symbol), `getPosition ${symbol}`);
  } catch (err) {
    if ((err?.statusCode || err?.response?.status) === 404) return null;
    throw err;
  }
}

/**
 * Latest trade price for a symbol. Falls back to the most recent 1-min bar
 * close if the latest-trade endpoint is empty (thin IEX names can lag).
 */
export async function getLatestPrice(symbol) {
  try {
    const t = await withRetry(() => alpaca.getLatestTrade(symbol), `getLatestTrade ${symbol}`);
    const p = t?.Price ?? t?.price ?? t?.p;
    if (p != null && Number.isFinite(Number(p))) return Number(p);
  } catch (err) {
    logger.warn(`getLatestPrice(${symbol}) latest-trade failed, falling back to bars: ${err.message}`);
  }
  // Fallback: last close in the trailing ~30 minutes.
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 60 * 1000);
  const bars = await getMinuteBars(symbol, start.toISOString(), end.toISOString());
  return bars.length ? bars[bars.length - 1].c : null;
}

// CLI: `node src/data/marketData.js` → connection smoke test.
if (import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/') ||
    process.argv[1]?.endsWith('marketData.js')) {
  getAccount()
    .then((acct) => {
      logger.info('Alpaca connection OK');
      logger.info(`Account ${acct.account_number} | status=${acct.status} | buying_power=$${acct.buying_power} | cash=$${acct.cash}`);
    })
    .catch((err) => {
      logger.error(`Connection test failed: ${err.message}`);
      process.exit(1);
    });
}

export default {
  alpaca, getAccount, getTradableAssets, getAsset,
  getDailyBars, getMinuteBars, getSnapshots, getCalendar,
  createOrder, getOrder, cancelOrder, getPosition, getLatestPrice,
};
