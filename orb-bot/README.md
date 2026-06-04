# ORB Bot — Opening Range Breakout Paper Trading Bot

Automated **paper-trading** bot for the Alpaca API implementing an Opening Range
Breakout (ORB) strategy. Tests 3 OR timeframes × 3 risk/reward ratios = 9 strategy
variations in parallel. See `orb_strategy_spec.md` for the full specification.

> **Paper trading only.** This project must never point at the live Alpaca endpoint.

## Status

| Phase | Scope | State |
|-------|-------|-------|
| **1. Foundation** | Project setup, Alpaca connection, universe scanner | ✅ built |
| **2. Strategy logic** | Opening range ✅ · breakout detection ✅ · VWAP ✅ · gap validation ✅ | ✅ built |
| 3. Execution | Sizing, limit orders, stops/targets, EOD close | ⬜ |
| 4. Multi-strategy | 9 variations in parallel, independent P&L | ⬜ |
| 5. Backtesting | Historical replay + metrics | ⬜ |
| **6. Live paper** | node-cron schedule ✅ · cloud deploy ✅ · alerts ⬜ · reports ⬜ | 🔨 partial |
| 7. Dashboard (opt) | Express + WebSocket | ⬜ |

## Setup

```bash
cd orb-bot
npm install
```

For **local dev**, copy `.env.example` to `.env` and fill in real values
(`.env` is git-ignored). For **cloud deploy**, set the same variables in the
Railway dashboard instead — see "Deploying to Railway.app" below.

```bash
cp .env.example .env   # then edit .env with your keys
```

## Commands

```bash
npm run check    # verify Alpaca connection + account
npm run scan     # run the universe scanner (liquidity/price/exchange filters)
npm run gapscan  # full pre-market scan: gaps + Perplexity catalyst filter → DB
npm run or       # compute opening ranges for a recent session (demo + persist)
node src/notify/discord.js   # send a sample Discord alert (verify your webhook)
npm test         # 62 offline unit tests (indicators, time, catalyst, DB, OR, breakout, discord)
npm run smoke    # live end-to-end checks against real Alpaca + Perplexity APIs
```

## Testing

- **`npm test`** — deterministic, offline. Covers indicator math (ATR/VWAP/SMA/
  stdDev against hand-computed values), ET timezone & holiday logic, Perplexity
  JSON parsing + response normalization (clamps confidence, maps invalid enums,
  fails safe on HTTP errors / network failure / unparseable output), and the
  SQLite layer (catalyst persistence, upsert, trade→watchlist catalyst copy).
- **`npm run smoke`** — hits the real APIs: Alpaca account, asset lookup, a bogus
  ticker (must reject without crashing), the universe scan, a live Perplexity
  classification, and the full gap-scan pipeline.

## Project structure

```
orb-bot/
  config/config.js        # all strategy params — nothing hardcoded
  src/
    data/
      marketData.js        # Alpaca SDK wrapper (account, assets, bars, snapshots) + backoff
      perplexity.js        # catalyst classifier (Perplexity live web search)
      database.js          # node:sqlite persistence (watchlist/trades + catalyst)
    scanners/
      universeScanner.js   # universe filters → qualified candidates  [Phase 1]
      gapScanner.js        # gaps → catalyst classify → quality filter → DB
    strategy/
      openingRange.js      # 5/15/30-min OR calc (batch + live tracker)  [Phase 2]
      breakoutDetector.js  # ORB entry signal + all confirmations (VWAP/gap/vol)
    notify/
      discord.js           # Discord webhook alerts for breakout signals
    utils/
      logger.js            # winston (console + daily file)
      timeUtils.js         # dayjs ET timezone, trading-day/holiday helpers
      indicators.js        # ATR, VWAP, SMA, avg volume, gap %, stddev
  logs/                   # generated, git-ignored
  reports/                # generated, git-ignored
```

## Catalyst classification (Perplexity)

The gap scanner sends each gapping stock to Perplexity (live web search) to
identify *why* it's moving, then filters out low-quality gaps. For each survivor
it returns a structured record:

```json
{
  "catalyst_type": "earnings | guidance | mna | analyst_rating | product_news | ...",
  "catalyst_summary": "one factual sentence with the specific news",
  "quality": "high | medium | low | none",
  "sentiment": "bullish | bearish | neutral",
  "tradeable": true,
  "confidence": 0.0-1.0
}
```

**Filtering rules** (config `catalyst`):
- Drop gaps with quality below `minQuality` (default `medium`).
- Drop `tradeable: false` (e.g. pure low-float pumps, no news).
- Drop fade-prone catalysts on gap-UPs (e.g. `offering_dilution`).
- **Fail-open**: if Perplexity errors/times out, the gap is kept and marked
  `unknown` (set `catalyst.failOpen=false` to drop instead).

The classification is **persisted on every watchlist row** and copied onto each
`trades` row (`catalyst_type`, `catalyst_quality`, `catalyst_sentiment`) when a
trade fires in Phase 3 — so you can later answer "which catalyst types actually
produced winning ORB trades?"

> **After-hours caveat:** `gap_pct` and `pm_volume` come from the snapshot
> (latest price vs. previous close; today's accumulating daily volume). During
> the bot's real 7–9 AM ET scan these are true pre-market figures. Run outside
> pre-market (e.g. testing at night) they reflect the just-closed session, so
> treat the *pipeline* as validated, not the specific gap numbers.

## Running the bot

```bash
npm start                 # start the scheduler/worker (what Railway runs)
node src/bot.js --check   # validate startup + connection + schedule, then exit
```

The worker schedules everything in **America/New_York** (so jobs fire at the
right ET market time regardless of host timezone): wake-up/account check 04:00,
pre-market gap scan 09:00, opening-range capture 10:05, heartbeat every 30 min.

> **What it does today:** builds & logs the daily watchlist and opening ranges.
> **What it does NOT do yet:** breakout detection & order execution (Phases 3–4),
> so it places **no trades**. The logs say so explicitly on every startup.

## Breakout signal notifications (Discord)

During the entry window (after the 5-min OR closes, before 11:00 ET) the bot's
**breakout monitor** runs every 2 minutes: it pulls each watchlist symbol's
session bars, computes the opening ranges, and runs the breakout detector for
all three timeframes. When a signal passes **all** confirmations it sends a
Discord webhook alert with the symbol, direction, OR timeframe, entry/stop/
targets, and a ✅/❌ checklist of every confirmation (price break, candle close,
gap alignment, VWAP bias, volume surge, cutoff, position). Alerts are
de-duplicated to one per symbol+timeframe+direction per day.

Set up:
1. Discord: **Channel → Edit Channel → Integrations → Webhooks → New Webhook → Copy URL**
2. Add `DISCORD_WEBHOOK_URL` to `.env` (local) or the Railway dashboard (cloud).
3. Verify it: `node src/notify/discord.js` sends a sample alert to the channel.

> These are **signal notifications only** — the bot still places no orders
> (execution is Phase 3). It tells you what it *would* trade.

## Deploying to Railway.app

The bot runs as a long-lived **worker** (no web port needed). Config files:
`Procfile`, `railway.json`, `.nvmrc` (pins Node 24 — required for the built-in
`node:sqlite`).

1. **Push to GitHub** (already done if you're reading this in the repo).
2. In Railway: **New Project → Deploy from GitHub repo**, pick this repo. Set the
   service **root directory** to `orb-bot` (the app isn't at the repo root).
3. **Add environment variables** in the service's **Variables** tab — do NOT use
   a `.env` file (it's git-ignored and never deployed). Copy the keys from
   `.env.example`:
   - `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`
   - `ALPACA_BASE_URL=https://paper-api.alpaca.markets`
   - `ALPACA_DATA_URL=https://data.alpaca.markets`
   - `ACCOUNT_SIZE`, `MAX_RISK_PER_TRADE`, `TIMEZONE=America/New_York`
   - `PERPLEXITY_API_KEY`
4. Railway builds with Nixpacks and runs `node src/bot.js` (from `railway.json`).
   If it picks the wrong Node version, set `NIXPACKS_NODE_VERSION=24` as a variable.
5. **Monitor from your phone:** open the service in the Railway app/website → the
   **Deploy Logs / Logs** tab streams console output live (timestamps are in ET).
   You'll see the startup banner, the scheduled-jobs list, heartbeats every 30
   min, and each morning's scan + opening ranges.

**Notes**
- A persistent worker bills continuously on Railway (it sleeps between jobs but
  stays resident). That's expected for a cron-style scheduler.
- The SQLite DB lives on the container's **ephemeral** disk and resets on every
  redeploy. Fine for now (state rebuilds each morning); attach a Railway **Volume**
  at `orb-bot/data` later if you want trade history to persist across deploys.
- Credentials live only in Railway's dashboard, never in git.

## ⚠️ Data Limitations (read before trusting scan output)

The spec's stock-selection criteria assume institutional-grade data. The **free
Alpaca plan has real gaps** that affect this bot. These are flagged in code, not
silently worked around:

### 1. IEX feed understates volume (~30–50×)
The free data plan only provides the **IEX** feed, which represents roughly 2–3%
of consolidated US market volume. So the scanner sees AAPL at ~1.4M avg volume
when real volume is ~50M. **Consequence:** the `> 5M avg volume` filter rejects
everything.
**Options:**
- **(a)** Subscribe to Alpaca's paid data plan for the **SIP** (consolidated)
  feed, then set `ALPACA_DATA_FEED=sip`. Filters work as specified.
- **(b)** Keep IEX and lower `minAvgDailyVolume` to an IEX-scaled threshold
  (e.g. ~150K) as a liquidity proxy. Less accurate but free.

### 2. No market-cap data
Alpaca's asset API has no market-cap field. The `> $2B` filter is **flagged, not
enforced**. Needs an external source (e.g. a fundamentals API or Perplexity).

### 3. No reliable "optionable" flag
Not exposed per-asset. **Flagged, not enforced.**

### 4. No earnings calendar
The "no earnings today/tomorrow" rule needs an earnings-date source. **Flagged,
not enforced.** We have a Perplexity key wired in the parent project that could
fill this in.

### 5. ETF / ADR / leveraged / recent-IPO exclusions
Not classified by Alpaca's standard asset API. **Flagged, not enforced.**

Each qualified candidate carries a `flags` object recording exactly which
criteria were verified vs. assumed, so downstream phases (and you) can decide how
much to trust a pick.

## Assumptions logged (spec note #8)

- Universe is seeded from the spec's pre-validated list and is expandable via
  `config.universe.seedSymbols`. A full-market scan would require pulling all
  ~11k Alpaca assets and snapshotting them — feasible, but rate-limit heavy and
  gated on the data-feed issue above.
- `prevClose` in Phase 1 uses the most recent daily bar's close. Pre-market gap
  computation (Phase 2) will use the live snapshot vs. prior session close.
- SQLite uses Node's built-in `node:sqlite` (Node 22.5+) instead of
  `better-sqlite3`, which needs native compilation unavailable on this Windows
  machine (no Python/build tools).
