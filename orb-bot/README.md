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
    execution/
      positionSizer.js     # risk-based share sizing + buying-power cap  [Phase 3]
      broker.js            # SIMULATION_MODE-gated order ops (sim vs live paper)
      executionEngine.js   # open/manage/exit positions, EOD close, recovery
    notify/
      discord.js           # Discord webhook alerts for signals + order lifecycle
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
right ET market time regardless of host timezone):

| ET time | Job | Discord |
|---------|-----|---------|
| 05:00 | connection check (retry 60s ×10), holiday stand-down | on failure/holiday |
| 07:00 | initial universe + gap scan, log ranked candidates | — |
| 08:00 | refined scan, re-rank | — |
| 09:00 | final scan → select top 5 → persist watchlist | 📋 watchlist |
| 09:25 | pre-open prep, connection re-check | ⏰ all systems go |
| 09:35 | lock 5-min opening range | 🔒 5-min OR |
| 09:45 | lock 15-min opening range | 🔒 15-min OR |
| 10:00 | lock 30-min opening range | 🔒 30-min OR |
| 09:35–11:00 | breakout monitor, **every 30s** → opens positions | 🚨 on signal · 📝 on order |
| 09:30–15:59 | position manager, **every 30s** (fills, stops, targets, kill switch) | ✅/🏁 on fill/close |
| 11:00 | close entry window (no new signals) | 🚫 closed |
| 15:55 | EOD force-close all open positions, cancel unfilled | 🔔 EOD summary |
| every 30 min | heartbeat | — |

Set `SCHEDULE_ENABLED=false` to disable all cron jobs (for testing). Trigger any
job on demand for verification: `node src/bot.js --run <wake|scan|final|preopen|
or5|or15|or30|monitor|close|manage|eod>`.

**Restart safety (catch-up on boot).** If the worker restarts mid-morning (e.g.
a Railway redeploy), it recovers gracefully — it never relies on in-memory state,
reading the watchlist from the DB on every step. On boot it logs
`Booted at <time> — <recovered N stocks | rebuilt watchlist | standing down>` and:
- before 09:00 → waits for the normal 09:00 scan;
- 09:00–09:35 → reuses the DB watchlist, or rebuilds it immediately if empty;
- at/after 09:35 → **stands down for the day** (won't trade a partial session).
Fired signals are de-duplicated against the `signals` table, so a restart can't
re-send an alert that already went out.

> **Phase 3 execution is live (gated by `SIMULATION_MODE`).** Confirmed breakouts
> are sized, opened, and managed to exit, with a 3:55 PM ET force-close. With
> `SIMULATION_MODE=true` (the default) every order is **logged only** — nothing
> is sent to Alpaca — so you can watch the full lifecycle before risking a cent.
> Only the Phase 4 daily P&L **reports/aggregation** (4:00/4:30 PM, 5:00 PM reset)
> remain unbuilt.

> **What it does today:** builds the daily watchlist + opening ranges, detects
> breakouts, and (Phase 3) sizes/opens/manages positions for each RR variation.
> **What it does NOT do yet:** Phase 4 multi-strategy aggregation & daily reports.

## Breakout signal notifications (Discord)

During the entry window (after the 5-min OR closes, before 11:00 ET) the bot's
**breakout monitor** runs every 2 minutes: it pulls each watchlist symbol's
session bars, computes the opening ranges, and runs the breakout detector for
all three timeframes. When a signal passes **all** confirmations it sends a
Discord webhook alert with the symbol, direction, OR timeframe, entry/stop/
targets, a **quality score (1–10)**, and a ✅/❌ checklist of every confirmation
(price break, candle close, gap alignment, VWAP bias, volume surge, cutoff,
position). Alerts are de-duplicated to one per symbol+timeframe+direction per day.

**Monitor audit log:** once per minute per watchlist stock/timeframe (while the
OR is established), the monitor logs price vs the relevant OR level and the
distance to break — e.g. `AVGO 15m monitor | price 400.18 | OR low 400.00 |
+0.18 above (no break)`. When a candle closes beyond the OR but awaits its
confirmation candle it logs `… PENDING — closed below OR low, awaiting
next-candle confirmation`. This makes it possible to reconstruct exactly when
price approached, touched, and broke the level. Toggle via
`config.strategy.logMonitorStatus`.

**False-breakout filter:** after a candle closes beyond the OR level, the bot
waits for the **next 1-minute candle to also close beyond** before confirming.
If the next candle closes back inside the OR, the attempt is marked **FAILED
BREAKOUT**, logged separately, and recorded in the `signals` table with
`status='failed'` — it never counts as a valid signal and sends no alert.
(Toggle via `config.strategy.requireConfirmation`.)

**Signal quality score (1–10):** every signal is graded (A+/A/B/C/D) by a
weighted blend of four strength factors — volume ratio, gap size, how far price
closed beyond the OR level (as a fraction of the OR range), and distance from
VWAP. Weights/thresholds are tunable in `config.strategy.scoring`. The score and
its per-factor breakdown are shown in Discord and stored on every row of the
`signals` table, so you can later filter A+ setups from mediocre ones.

Set up:
1. Discord: **Channel → Edit Channel → Integrations → Webhooks → New Webhook → Copy URL**
2. Add `DISCORD_WEBHOOK_URL` to `.env` (local) or the Railway dashboard (cloud).
3. Verify it: `node src/notify/discord.js` sends a sample alert to the channel.

In `SIMULATION_MODE` these stay **signal + simulated-order** notifications — the
bot tells you exactly what it *would* trade (sizing, fills, exits, P&L) without
sending anything to Alpaca.

## Order execution & position management (Phase 3)

When a breakout passes all confirmations, the execution engine takes over —
**gated behind the `SIMULATION_MODE` safety flag** (default `true`):

- **`SIMULATION_MODE=true`** — logs every order the bot *would* place (full
  details) and manages a virtual position end-to-end, but submits **nothing** to
  Alpaca. The mode is printed on startup and on every order decision.
- **`SIMULATION_MODE=false`** — submits real **paper** orders to Alpaca.

**Position sizing.** Risk per trade = `ACCOUNT_SIZE × MAX_RISK_PER_TRADE`. Shares
= `floor(risk ÷ (entry − stop))`. A trade is **skipped** (never silently shrunk)
if it can't be sized — entry == stop, < 1 share, or notional > available buying
power. The full math is logged for every signal:
`sizing | account $100,000 × 1.00% = risk $1000.00 | entry $101.50 stop $99.00 →
per-share risk $2.50 | shares 400 | notional $40,600.00`.

**Three RR variations per signal.** Each signal opens the 1:1, 1:1.5, and 1:2
reward:risk targets as **independent positions** (each risk-sized on its own,
each tracked to its own outcome) so you can compare which RR performs best. Stop
is the opposite OR extreme; entry is a **limit** at the breakout candle close.

**Entry.** A DAY limit order at the breakout close. Unfilled after 2 minutes →
cancelled and logged `CANCELLED_UNFILLED`. On fill, the actual price and
**slippage** vs the intended price are recorded.

**Exit management (poll-based, every 30s).** Each open leg is checked against:
- **Target** → limit exit at the target price (`TARGET`).
- **Stop** → market exit at the OR extreme (`STOP`).
- **Kill switch** → if price moves > `1.5×` planned risk against entry, close
  immediately (`KILL_SWITCH`) — catches a gap clean through the stop.
- **EOD** → all positions force-closed at **3:55 PM ET** (`EOD_CLOSE`).

Realized P&L, R-multiple, and % are computed and stored on close.

**Persistence & restart recovery.** Every position is written to the SQLite DB
(`trades` table) the instant it opens — symbol, direction, entry, stop, all
targets, shares, RR variation, timestamps, and Alpaca order IDs — and updated on
every fill, cancel, and exit. The manager reads open positions from the DB on
**every** tick, so a mid-session restart (e.g. a Railway redeploy) reloads and
resumes managing every open trade without forgetting any. On boot the bot logs
the recovered positions and pings Discord with a summary.

**Notifications.** Discord message on every order **placed**, **filled**, and
**closed** (with close reason and realized P&L), plus cancelled entries and the
restart-recovery summary. Everything is also logged to the console with ET
timestamps (visible in Railway logs).

> ⚠️ **Going live:** flip `SIMULATION_MODE=false` only after watching the
> simulated logs and confirming sizing/behaviour. It still uses the **paper**
> Alpaca endpoint (`config.alpaca.paper` is hard-locked `true`).

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
   - `SIMULATION_MODE=true` (keep `true` until you've watched the simulated logs)
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
- **Persisting history across redeploys (Railway Volume).** By default the
  SQLite DB is on the container's ephemeral disk and resets on every redeploy.
  To keep watchlist/signal/trade history, add a Railway **Volume**:
  1. Railway → your service → **Settings → Volumes → + New Volume** (or
     `railway volume add` via CLI).
  2. Set the **mount path** to **`/app/data`** (matches the app's data dir).
  3. Redeploy. Railway sets `RAILWAY_VOLUME_MOUNT_PATH`, which the bot uses for
     the DB automatically (`RAILWAY_VOLUME_MOUNT_PATH/orb.db`) — no code change
     needed. The DB now survives redeploys; verify with
     `node scripts/dump-watchlist.js` (it should accumulate days over time).
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
