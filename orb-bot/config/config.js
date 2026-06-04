import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
// .env lives at the project root (one level up from /config)
dotenv.config({ path: join(__dir, '..', '.env') });

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  alpaca: {
    keyId: required('ALPACA_API_KEY'),
    secretKey: required('ALPACA_SECRET_KEY'),
    baseUrl: process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets',
    dataUrl: process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets',
    paper: true, // NEVER flip to live in this phase
  },

  account: {
    size: Number(process.env.ACCOUNT_SIZE || 100000),
    maxRiskPerTrade: Number(process.env.MAX_RISK_PER_TRADE || 0.01),
  },

  timezone: process.env.TIMEZONE || 'America/New_York',

  // ----- Universe filters (spec: Stock Selection Criteria) -----
  universe: {
    // Exchanges we accept. Alpaca codes: 'NYSE', 'NASDAQ', 'ARCA', 'BATS', 'AMEX'.
    exchanges: ['NYSE', 'NASDAQ'],
    minPrice: 20,
    maxPrice: 1000,
    minAvgDailyVolume: 5_000_000, // 20-day average
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
    minPreMarketVolume: 100_000, // shares before 9:30
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
