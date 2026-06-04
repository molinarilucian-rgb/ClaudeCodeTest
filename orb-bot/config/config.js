import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const __dir = dirname(fileURLToPath(import.meta.url));
// Local dev loads a .env file; in the cloud (Railway) the variables are injected
// straight into process.env from the dashboard, so a missing .env is expected.
// dotenv never overrides vars already present in process.env, so dashboard wins.
const envPath = join(__dir, '..', '.env');
if (existsSync(envPath)) dotenv.config({ path: envPath });

// Only the Alpaca credentials are strictly required to boot; everything else
// has a safe default (Perplexity/Discord degrade gracefully when unset).
// Collect ALL missing required vars and report them together with a clear,
// actionable message — then exit cleanly instead of throwing a raw stack trace.
const REQUIRED = ['ALPACA_API_KEY', 'ALPACA_SECRET_KEY'];
const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length) {
  console.error('\n========================================================');
  console.error(' ORB Bot cannot start — missing environment variable(s):');
  for (const name of missing) console.error(`   • ${name}`);
  console.error('');
  console.error(' Set these in Railway → your service → Variables tab');
  console.error(' (or in a local .env file for local runs).');
  console.error(' Full list of variables is in .env.example.');
  console.error('========================================================\n');
  process.exit(1);
}

export const config = {
  alpaca: {
    keyId: process.env.ALPACA_API_KEY,
    secretKey: process.env.ALPACA_SECRET_KEY,
    baseUrl: process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets',
    dataUrl: process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets',
    paper: true, // NEVER flip to live in this phase
  },

  account: {
    size: Number(process.env.ACCOUNT_SIZE || 100000),
    maxRiskPerTrade: Number(process.env.MAX_RISK_PER_TRADE || 0.01),
  },

  perplexity: {
    apiKey: process.env.PERPLEXITY_API_KEY || '',
    baseUrl: 'https://api.perplexity.ai/chat/completions',
  },

  discord: {
    // Webhook URL from Discord: Channel → Edit → Integrations → Webhooks.
    webhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
  },

  // Master switch for the cron schedule. Set SCHEDULE_ENABLED=false to disable
  // all scheduled jobs (useful for local testing). Defaults to enabled.
  scheduleEnabled: (process.env.SCHEDULE_ENABLED ?? 'true') !== 'false',

  timezone: process.env.TIMEZONE || 'America/New_York',

  // ----- Universe filters (spec: Stock Selection Criteria) -----
  universe: {
    // Exchanges we accept. Alpaca codes: 'NYSE', 'NASDAQ', 'ARCA', 'BATS', 'AMEX'.
    exchanges: ['NYSE', 'NASDAQ'],
    minPrice: 20,
    maxPrice: 1000,
    // Spec target is 5,000,000 (consolidated/SIP). On the free IEX feed, volume
    // is only ~2-3% of consolidated, so we use an IEX-scaled proxy (~150K) as a
    // liquidity filter. RESTORE to 5_000_000 when upgrading to ALPACA_DATA_FEED=sip.
    minAvgDailyVolume: 150_000, // IEX-scaled proxy (spec: 5_000_000 on SIP)
    minAvgDailyVolumeSip: 5_000_000, // the real target once on SIP feed
    avgVolumeLookbackDays: 20,
    // Filters Alpaca's standard API can't satisfy directly — see README "Data Limitations".
    // Enforced via external data when wired up (Phase 2+). Flagged on each candidate for now.
    minMarketCap: 2_000_000_000,
    requireOptionable: true,
    excludeEarningsWithinDays: 2,
    // Seed universe to scan. Spec's pre-validated starting list; expandable.
    seedSymbols: [
      'AAPL', 'TSLA', 'NVDA', 'AMD', 'META', 'MSFT', 'GOOGL', 'AMZN',
      'NFLX', 'COIN', 'PLTR', 'MARA', 'RIOT', 'SMCI', 'AVGO',
    ],
  },

  // ----- Pre-market gap filter -----
  gap: {
    minAbsGapPct: 1.0, // |pre-market change| > 1%
    // Spec target 100K consolidated; IEX feed sees a fraction, so scaled down.
    // Restore to 100_000 on SIP feed (see README data limitations).
    minPreMarketVolume: 3_000, // IEX-scaled proxy (spec: 100_000 on SIP)
    minPreMarketVolumeSip: 100_000,
  },

  // ----- Catalyst classification (Perplexity) -----
  catalyst: {
    enabled: true,
    model: 'sonar',
    // Catalyst types we ask Perplexity to bucket into.
    types: [
      'earnings', 'guidance', 'mna', 'analyst_rating', 'product_news',
      'regulatory', 'legal', 'offering_dilution', 'macro_sector',
      'insider_activity', 'no_catalyst', 'unknown',
    ],
    // Drop gaps whose catalyst quality is at/below this rank.
    // quality scale: high > medium > low > none
    minQuality: 'medium',
    // Catalyst types that make a gap UP fade-prone (reject even if news exists).
    fadeProneOnGapUp: ['offering_dilution'],
    // If Perplexity fails/timeouts, keep the gap but mark catalyst unknown
    // (true) vs. drop it (false). Fail-open by default so data issues don't
    // silently shrink the watchlist.
    failOpen: true,
    requestTimeoutMs: 25_000,
  },

  // ----- Final selection -----
  selection: {
    topN: 5,
  },

  // ----- Strategy variations -----
  strategy: {
    orTimeframes: [5, 15, 30], // minutes
    rrRatios: [1.0, 1.5, 2.0],
    entryCutoffEt: '11:00', // no entries after
    eodCloseEt: '15:55',
    stopBufferPct: 0.001, // 0.1% beyond OR level
    breakoutVolumeMult: 1.5, // vs avg of last 5 candles
    orderFillTimeoutSec: 120, // cancel unfilled limit after 2 min
    killSwitchRiskMult: 1.5, // close if moves >1.5x planned risk against
    atrPeriod: 14,
  },

  // ----- Safety / risk controls -----
  risk: {
    dailyLossLimitPct: 0.03, // -3% halts trading for the day
    maxConcurrentPositions: 15,
    apiMaxRetries: 5,
  },

  // ----- Daily schedule (ET) -----
  schedule: {
    wakeUp: '04:00',
    initialScan: '07:00',
    refinedScan: '08:00',
    finalWatchlist: '09:00',
    preOpenPrep: '09:25',
    marketOpen: '09:30',
    entryCutoff: '11:00',
    forceClose: '15:55',
    marketClose: '16:00',
    dailyReport: '16:30',
    cleanup: '17:00',
  },
};

export default config;
