# ORB Bot — Specification

_Opening Range Breakout (ORB) automated **paper-trading** bot for Alpaca._

This is the authoritative specification for the bot: what it does, how it is
configured, what each file is responsible for, and what is built vs. still
planned. For the engineering catch-up (bugs fixed, verifications) see
`HANDOFF.md`; for day-to-day usage and the deploy guide see `README.md`.

> **Paper trading only.** `config.alpaca.paper` is hard-locked `true`. The bot
> must never point at the live Alpaca endpoint.

---

## 1. What the bot does (strategy overview)

The bot trades the **Opening Range Breakout** pattern: the first N minutes after
the 09:30 ET open define a high/low "opening range" (OR); a decisive close beyond
that range — confirmed by gap, VWAP, and volume context — is the entry signal.

To discover *which* ORB configuration actually works, it runs **9 variations in
parallel**: **3 OR timeframes (5, 15, 30 min) × 3 reward:risk ratios (1:1, 1:1.5,
1:2)**. Each variation of each signal is opened as an **independent, individually
risk-sized position** and tracked to its own outcome, so per-variation
performance is directly comparable.

### Daily lifecycle (all times ET, scheduled in `America/New_York`)

| ET time | Job | Action | Discord |
|---------|-----|--------|---------|
| 05:00 | wake-up | connection check (retry 60s ×10), holiday stand-down, reset daily de-dup | on failure/holiday |
| 07:00 | initial scan | universe + gap scan, log ranked candidates | — |
| 08:00 | refined scan | re-scan, re-rank | — |
| 09:00 | final scan | select top 5, persist watchlist to DB | 📋 watchlist |
| 09:25 | pre-open prep | connection re-check, confirm watchlist | ⏰ all systems go |
| 09:35 | lock 5-min OR | compute + persist 5-min OR high/low | 🔒 5-min OR |
| 09:45 | lock 15-min OR | compute + persist 15-min OR | 🔒 15-min OR |
| 10:00 | lock 30-min OR | compute + persist 30-min OR, then OR-levels audit | 🔒 30-min OR |
| 09:35–11:00 | breakout monitor (30s) | detect breakouts, open positions | 🚨 signal · 📝 order |
| 09:30–15:59 | position manager (30s) | fills, stops, targets, kill switch | ✅/🏁 fill/close |
| 11:00 | entry cutoff | no new signals after this | 🚫 closed |
| 15:55 | EOD force-close | flatten all positions, cancel unfilled | 🔔 EOD summary |
| every 30 min | heartbeat | liveness log | — |

### Signal pipeline

1. **Universe scan** (`universeScanner`) — filter the seed list by exchange,
   price, and 20-day liquidity; flag criteria Alpaca can't verify (market cap,
   optionable, earnings, ETF/ADR exclusions).
2. **Gap scan** (`gapScanner`) — snapshot each candidate for pre-market gap% vs.
   prior close and pre-market volume; keep `|gap%| ≥ 1%` **and** volume ≥
   threshold.
3. **Catalyst classification** (`perplexity`) — for each survivor, Perplexity
   live-web-search identifies *why* it's gapping and how tradeable it is. Drop
   low-quality / non-tradeable / fade-prone gap-ups. **Fail-open** if Perplexity
   errors.
4. **Rank & select** — score `(|gap%| × pmVolume) ÷ ATR`, take top 5, persist.
5. **Opening range** (`openingRange`) — lock 5/15/30-min OR high/low per symbol.
   Completion is **time-based** so missing IEX minutes don't break the range.
6. **Breakout detection** (`breakoutDetector`) — find the first candle to
   **close** beyond the OR (close-based, not a wick), apply the **false-breakout
   filter** (the next candle must also close beyond), and evaluate all 8
   confirmations. A signal is `triggered` only when **all** pass. Computes
   stop/targets and a **1–10 quality score** (A+/A/B/C/D).
7. **Execution** (`executionEngine`) — open the 3 RR legs as independent
   positions, manage to exit. **Gated by `SIMULATION_MODE`** (default on: logs
   orders, sends nothing to Alpaca).

### The 8 long-entry confirmations (mirrored for shorts)

1. OR established (`orComplete`)
2. Price breaks beyond the OR level (intrabar high/low)
3. Breakout candle **closes** beyond the OR level
4. Confirmation candle — the next candle also closes beyond (false-breakout filter)
5. Gap aligned — pre-market gap ≥ +1% for longs (≤ −1% for shorts)
6. VWAP aligned — price above session VWAP for longs (below for shorts)
7. Volume surge — breakout-candle volume ≥ 1.5× the prior 5 candles' average
8. Before the 11:00 ET entry cutoff (and no open position — de-dup handled by caller)

### Position management

- **Sizing** (`positionSizer`): `shares = floor(accountSize × maxRiskPerTrade ÷
  |entry − stop|)`. A leg is **skipped** (never silently shrunk) if entry == stop,
  shares < 1, or notional > buying power.
- **Entry**: DAY **limit** at the breakout-candle close, nudged ≥ 1¢ beyond the
  OR. Unfilled after 2 min → cancelled (`CANCELLED_UNFILLED`). Slippage recorded
  on fill.
- **Stop**: opposite OR extreme ± a 0.1% buffer.
- **Exits** (poll-based, every 30s), in protective order:
  - **Kill switch** — price moved > 1.5× planned risk against entry (`KILL_SWITCH`)
  - **Stop** — OR extreme breached, market exit (`STOP`)
  - **Target** — limit exit at entry ± risk × rr (`TARGET`)
  - **EOD** — all positions force-closed at 15:55 ET (`EOD_CLOSE`)
- Realized P&L, R-multiple, and % are computed and stored on close.

### Safety & restart invariants

- `config.alpaca.paper` hard-locked `true`; `SIMULATION_MODE` defaults `true`.
- **All state lives in SQLite.** Every scheduled step reads the watchlist and open
  positions from the DB each tick — never in-memory state — so a mid-session
  restart (e.g. a Railway redeploy) resumes cleanly.
- **Startup policy** (`startupPolicy.decideStartupAction`): before 09:00 → wait
  for the 09:00 scan; 09:00–09:35 → recover the DB watchlist (or rebuild if
  empty); at/after 09:35 → **stand down** for the day (no partial session).
- Signal de-dup is enforced both in memory (`alertedSignals` Set) **and** against
  the `signals` table, so a restart can't re-fire an alert.

---

## 2. Environment variables

Set in a local `.env` (git-ignored) for dev, or the Railway dashboard for cloud.
Only the two Alpaca credentials are required to boot; everything else has a safe
default and degrades gracefully when unset.

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `ALPACA_API_KEY` | **yes** | — | Alpaca **paper** account key. Boot fails (clean message) if missing. |
| `ALPACA_SECRET_KEY` | **yes** | — | Alpaca paper account secret. Boot fails if missing. |
| `ALPACA_BASE_URL` | no | `https://paper-api.alpaca.markets` | Trading API host. **Never** the live endpoint. |
| `ALPACA_DATA_URL` | no | `https://data.alpaca.markets` | Market-data host. |
| `ALPACA_DATA_FEED` | no | `iex` | Data feed: `iex` (free, ~2–3% of volume) or `sip` (paid, consolidated). |
| `ACCOUNT_SIZE` | no | `100000` | Risk-sizing base (dollars). |
| `MAX_RISK_PER_TRADE` | no | `0.01` | Fraction of account risked per trade (1%). |
| `TIMEZONE` | no | `America/New_York` | All cron jobs + log timestamps use this TZ. |
| `SIMULATION_MODE` | no | `true` | **Master safety flag.** `true` = log orders, send nothing. `false` = submit real paper orders. Any value other than the string `false` is treated as `true`. |
| `SCHEDULE_ENABLED` | no | `true` | `false` disables all cron jobs (worker stays idle — for testing). |
| `PERPLEXITY_API_KEY` | no | _(empty)_ | Catalyst classification. If unset, classification is skipped and the gap is kept (fail-open). |
| `DISCORD_WEBHOOK_URL` | no | _(empty)_ | Signal + order-lifecycle alerts. Degrades gracefully (logs a warning) if unset. |
| `LOG_TO_FILE` | no | `false` | `true` also writes `logs/YYYY-MM-DD.log` (ephemeral on Railway). |
| `LOG_LEVEL` | no | `info` | winston level: `debug` \| `info` \| `warn` \| `error`. |
| `ORB_DB_PATH` | no | _(see below)_ | Explicit SQLite path override (used by tests). |
| `RAILWAY_VOLUME_MOUNT_PATH` | no | _(set by Railway)_ | When a Volume is attached, the DB is stored at `$RAILWAY_VOLUME_MOUNT_PATH/orb.db` to survive redeploys. |
| `NIXPACKS_NODE_VERSION` | no | — | Only if Railway picks the wrong Node (need ≥ 22.5 for `node:sqlite`); set `24`. |

**SQLite DB path priority:** `ORB_DB_PATH` → `RAILWAY_VOLUME_MOUNT_PATH/orb.db` →
`<project>/data/orb.db` (local dev). Without a Railway Volume the DB is on
ephemeral disk and resets every redeploy.

---

## 3. File structure

```
orb-bot/
  config/
    config.js              # single source of truth for ALL params + env validation
  src/
    bot.js                 # main entry / cron scheduler / startup catch-up / --run, --check
    startupPolicy.js       # pure decideStartupAction() — recover/rebuild/stand-down on boot
    monitorStatus.js       # pure log formatters (monitor status, pending, rejection reasons)
    data/
      marketData.js        # Alpaca SDK wrapper (account, assets, bars, snapshots, orders) + retry/backoff
      perplexity.js        # catalyst classifier via Perplexity live web search (fail-safe)
      database.js          # node:sqlite persistence (5 tables) + additive ALTER migrations
    scanners/
      universeScanner.js   # universe filters → qualified candidates (with ATR/avgVol); flags unverifiable criteria
      gapScanner.js        # gaps → catalyst classify → quality filter → rank → top N → DB
    strategy/
      openingRange.js      # 5/15/30-min OR calc (batch computeAll* + live OpeningRangeTracker)
      breakoutDetector.js  # ORB entry signal: breakout, confirmations, stop/targets, quality score
    execution/
      positionSizer.js     # pure risk-based share sizing + buying-power cap (skip, never shrink)
      broker.js            # the ONE SIMULATION_MODE gate: sim logs vs. live paper orders
      executionEngine.js   # open 3 RR legs, manage fills/stops/targets/kill-switch/EOD, restart recovery
    notify/
      discord.js           # Discord webhook alerts: signals + order lifecycle + restart summary
    utils/
      logger.js            # winston (console always; daily file if LOG_TO_FILE), ET timestamps
      timeUtils.js         # dayjs ET helpers, trading-day/holiday calendar, ET↔ISO conversion
      indicators.js        # ATR (Wilder), VWAP, SMA, avg volume, gap %, stdDev — pure math
    test-phase1.js         # ad-hoc Phase 1 smoke script
    test-phase2.js         # ad-hoc Phase 2 smoke script
    backtest.js            # ⬜ NOT YET BUILT (referenced by `npm run backtest`)
  scripts/
    dump-watchlist.js      # print accumulated watchlist history (verify DB persistence)
    persist-test.js        # DB persistence sanity check
  tests/                   # node --test suites (offline unit tests) + live-smoke.js
  logs/                    # generated, git-ignored (only if LOG_TO_FILE=true)
  reports/                 # generated, git-ignored
  data/                    # local SQLite DB (orb.db), git-ignored
  config files             # package.json, Procfile, railway.json, .nvmrc, .env.example, .gitignore
  HANDOFF.md               # engineering catch-up (bugs, verifications, deploy config)
  README.md                # usage + deploy guide
  SPEC.md                  # this document
```

### Per-file responsibilities

- **`config/config.js`** — Loads `.env` (dev) without overriding dashboard vars
  (cloud). Validates required Alpaca creds and exits cleanly listing any missing.
  Exports the single `config` object every other module reads — **nothing is
  hardcoded elsewhere.**
- **`src/bot.js`** — The long-lived worker. Registers all cron jobs in ET, runs
  the 30s breakout monitor + position manager, handles startup catch-up, and
  exposes `--run <job>` and `--check` for manual verification. Validates every
  cron expression up front.
- **`src/startupPolicy.js`** — Pure `decideStartupAction()` returning
  `closed | pre_market | recover | rebuild | stand_down`. No I/O, fully testable.
- **`src/monitorStatus.js`** — Pure formatters: `formatMonitorStatus` (price vs.
  relevant OR level), `formatMonitorPending` (awaiting confirmation),
  `formatRejectionReasons` (why a BREAK didn't fire). `isShortBias` helper.
- **`src/data/marketData.js`** — All Alpaca calls (account, assets, daily/minute
  bars, snapshots, calendar, order create/get/cancel, position, latest price)
  behind an exponential-backoff `withRetry` wrapper. `npm run check` entry point.
- **`src/data/perplexity.js`** — `classifyCatalyst()` (never throws — fails to an
  UNKNOWN record), `parseCatalystJson()` (extracts JSON from messy output),
  `qualityRank()`. Clamps/normalizes the model response.
- **`src/data/database.js`** — `node:sqlite` (built-in, Node 22.5+). Creates 5
  tables, runs lightweight additive `ALTER` migrations, and exports the
  save/get helpers. The `trades` table doubles as the live-position store.
- **`src/scanners/universeScanner.js`** — `scanUniverse()` evaluates each seed
  symbol (exchange/price/liquidity enforced; market-cap/optionable/earnings
  flagged-only) and returns `{ qualified, rejected }` enriched with ATR/avgVol.
- **`src/scanners/gapScanner.js`** — `scanGaps()` runs the full pipeline:
  universe → snapshot gap stats → gap+volume filter → catalyst classify →
  quality filter → rank → top N → persist; returns `{ selected, evaluated }`.
- **`src/strategy/openingRange.js`** — `computeOpeningRange` /
  `computeAllOpeningRanges` (batch) and `OpeningRangeTracker` (live). Time-based
  completion via the `asOf` arg. `minutesFromOpen` helper.
- **`src/strategy/breakoutDetector.js`** — `detectBreakout()` (the signal) and
  `scoreSignal()` (1–10 quality score). Exports `ENTRY_CUTOFF_OFFSET`.
- **`src/execution/positionSizer.js`** — `sizePosition()` (pure) and
  `describeSizing()` (audit log line).
- **`src/execution/broker.js`** — `createBroker()` (DI-friendly) + a `broker`
  singleton. The single place the `SIMULATION_MODE` flag is enforced:
  `placeEntry`, `pollOrder`, `cancelOrder`, `placeExit`.
- **`src/execution/executionEngine.js`** — `createExecutionEngine()` +
  `executionEngine` singleton: `openPositionsForSignal`, `manageOpenPositions`,
  `forceCloseAll`, `recoverOpenPositions` (plus `markFilled`/`closePosition`/
  `cancelPending` exposed for tests).
- **`src/notify/discord.js`** — `sendDiscord` (low-level, 429-aware),
  `sendBreakoutAlert` (signal embed + ✅/❌ checklist), `sendOrderNotification`
  (placed/filled/closed/cancelled/recovered).
- **`src/utils/logger.js`** — winston logger, ET-stamped, console always + opt-in
  daily file.
- **`src/utils/timeUtils.js`** — ET timezone helpers, NYSE 2026 holiday set,
  `isTradingDay`/`isMarketHours`, `etToIso`.
- **`src/utils/indicators.js`** — Pure indicator math (ATR/VWAP/SMA/avgVolume/
  gapPct/stdDev/trueRange).

---

## 4. What has been built (Phases 1–3)

| Phase | Scope | State |
|-------|-------|-------|
| **1. Foundation** | Project setup, Alpaca connection, universe + gap scanning, catalyst filter, SQLite persistence | ✅ built |
| **2. Strategy logic** | Opening-range calc, breakout detection, VWAP/gap/volume confirmations, 1–10 quality score | ✅ built |
| **3. Execution** | Position sizing, limit entries, stop/target/kill-switch management, EOD close, restart recovery | ✅ built (SIMULATION_MODE-gated) |
| **6. Live paper** | node-cron ET schedule, Railway deploy, Discord alerts, restart safety, monitor/rejection audit logs | 🔨 partial |

**Phase 1 — Foundation:** `config.js`, `marketData.js`, `perplexity.js`,
`database.js`, `universeScanner.js`, `gapScanner.js`, and the `utils/`.
Validates env on boot; flags free-plan data limitations rather than silently
working around them.

**Phase 2 — Strategy logic:** `openingRange.js` (off-by-one boundary completion
fixed), `breakoutDetector.js` (close-based breakout + false-breakout filter + all
confirmations + quality score), `monitorStatus.js` (auditable monitor/rejection
logging).

**Phase 3 — Execution (gated by `SIMULATION_MODE`):** `positionSizer.js`,
`broker.js`, `executionEngine.js`, plus the order-lifecycle half of `discord.js`.
Opens 3 RR legs per signal as independent positions, manages them to exit, and
recovers open positions from the DB on restart.

**Phase 6 — Live paper (partial):** the ET cron schedule, Railway deploy config,
Discord alerts, restart safety, and the OR-levels/rejection audit logs are done.
The daily **reports/aggregation** half belongs to Phase 4 and is unbuilt.

> Test suite: **115 offline unit tests** pass via `npm test`
> (`node --test tests/*.test.js`). _(The README's "62" figure is stale.)_

---

## 5. What still needs to be built (Phases 4–7)

| Phase | Scope | State |
|-------|-------|-------|
| **4. Multi-strategy** | 9 variations aggregated, independent P&L, daily reports | ⬜ **next** |
| **5. Backtesting** | Historical replay + metrics | ⬜ |
| **7. Dashboard** | Express + WebSocket | ⬜ (optional) |

### Phase 4 — Multi-strategy aggregation & daily P&L reporting (NEXT)

The raw material already exists — every `trades` row stores its OR timeframe, RR
ratio, catalyst type/quality, quality score, and realized P&L/R-multiple; the
`daily_performance` table and the `dailyReport` (16:30) / `cleanup` (17:00)
schedule slots are defined in config but **not yet wired into `bot.js`.** To do:

1. **Aggregate the 9 variations** (3 OR timeframes × 3 RR) — roll up `trades` per
   `(timeframe, rr)`: win rate, avg R, total P&L, expectancy, trade count. _This
   is the project's core question: which variation actually works._
2. **Daily P&L report (~16:00 / 16:30 ET)** — after EOD close, compute realized
   P&L overall and per variation, write to `daily_performance`, send a Discord
   summary. Add the cron jobs to `bot.js`.
3. **Performance-by-catalyst breakdown** — catalyst fields are already on each
   trade; answer "which catalyst types produced winning ORB trades?"
4. **End-of-day reset (17:00)** — clear daily de-dup, roll logs.
5. **Tests** for the aggregation math (hand-computed expectancy/R fixtures), in
   the existing `node --test tests/*.test.js` style.

### Phase 5 — Backtesting

Historical replay + metrics. `src/backtest.js` is referenced by
`npm run backtest` but **does not exist yet.** Out of scope until Phase 4 lands.

### Phase 7 — Dashboard (optional)

Express + WebSocket live view. Out of scope until Phase 4 lands.

### Known limitations / open items (carry into later phases)

- **Free IEX feed understates volume ~30–50×.** Volume thresholds are scaled to
  IEX proxies; restore SIP thresholds and set `ALPACA_DATA_FEED=sip` on the paid
  plan. Affects gap/volume filters, the volume-surge confirmation, and OR-vs-
  TradingView parity.
- **Unenforced selection criteria** (flagged, not enforced): market cap > $2B,
  optionable, earnings-calendar exclusion, ETF/ADR/leveraged/recent-IPO. Needs an
  external fundamentals/earnings source.
- **REST polling, no websocket** — bars polled every 30s; fine for the current
  cadence, tighter latency would need a stream.
- **`noPosition` confirmation isn't wired into the monitor** — `detectBreakout`
  is called without `hasPosition`; signal-level de-dup prevents re-entry instead.

---

## 6. Configuration values & defaults

All values live in `config/config.js`. Env-overridable values are noted; the rest
are code constants.

### Alpaca / account / execution

| Key | Default | Env | Purpose |
|-----|---------|-----|---------|
| `alpaca.baseUrl` | `https://paper-api.alpaca.markets` | `ALPACA_BASE_URL` | Trading API host |
| `alpaca.dataUrl` | `https://data.alpaca.markets` | `ALPACA_DATA_URL` | Data host |
| `alpaca.paper` | `true` | — | **Hard-locked.** Never live. |
| `account.size` | `100000` | `ACCOUNT_SIZE` | Sizing base |
| `account.maxRiskPerTrade` | `0.01` | `MAX_RISK_PER_TRADE` | 1% risk per trade |
| `execution.simulationMode` | `true` | `SIMULATION_MODE` | Master safety flag |
| `scheduleEnabled` | `true` | `SCHEDULE_ENABLED` | Cron master switch |
| `timezone` | `America/New_York` | `TIMEZONE` | All scheduling/timestamps |

### Universe filters (`universe`)

| Key | Default | Purpose |
|-----|---------|---------|
| `exchanges` | `['NYSE', 'NASDAQ']` | Accepted exchanges |
| `minPrice` / `maxPrice` | `20` / `1000` | Price band |
| `minAvgDailyVolume` | `150_000` | IEX-scaled liquidity proxy (SIP target `5_000_000`) |
| `minAvgDailyVolumeSip` | `5_000_000` | Real target once on SIP |
| `avgVolumeLookbackDays` | `20` | Avg-volume window |
| `minMarketCap` | `2_000_000_000` | **Flagged-only** (no Alpaca field) |
| `requireOptionable` | `true` | **Flagged-only** |
| `excludeEarningsWithinDays` | `2` | **Flagged-only** |
| `seedSymbols` | 15 large caps (AAPL, TSLA, NVDA, AMD, META, MSFT, GOOGL, AMZN, NFLX, COIN, PLTR, MARA, RIOT, SMCI, AVGO) | Seed universe (expandable) |

### Pre-market gap filter (`gap`)

| Key | Default | Purpose |
|-----|---------|---------|
| `minAbsGapPct` | `1.0` | `|pre-market change|` > 1% |
| `minPreMarketVolume` | `3_000` | IEX-scaled proxy (SIP target `100_000`) |
| `minPreMarketVolumeSip` | `100_000` | Real target once on SIP |

### Catalyst classification (`catalyst`)

| Key | Default | Purpose |
|-----|---------|---------|
| `enabled` | `true` | Run Perplexity classification |
| `model` | `sonar` | Perplexity model |
| `types` | 12 buckets (earnings, guidance, mna, analyst_rating, product_news, regulatory, legal, offering_dilution, macro_sector, insider_activity, no_catalyst, unknown) | Allowed catalyst types |
| `minQuality` | `medium` | Drop gaps at/below this (scale: high>medium>low>none) |
| `fadeProneOnGapUp` | `['offering_dilution']` | Reject these on gap-ups even with news |
| `failOpen` | `true` | Keep the gap (mark unknown) when Perplexity fails |
| `requestTimeoutMs` | `25_000` | Per-call timeout |

### Final selection (`selection`)

| Key | Default | Purpose |
|-----|---------|---------|
| `topN` | `5` | Watchlist size |

### Strategy variations (`strategy`)

| Key | Default | Purpose |
|-----|---------|---------|
| `orTimeframes` | `[5, 15, 30]` | OR windows (minutes) |
| `rrRatios` | `[1.0, 1.5, 2.0]` | Reward:risk targets |
| `entryCutoffEt` | `'11:00'` | No entries after |
| `eodCloseEt` | `'15:55'` | EOD force-close time |
| `stopBufferPct` | `0.001` | 0.1% beyond the OR level for the stop |
| `breakoutVolumeMult` | `1.5` | Volume-surge threshold vs. avg of last 5 candles |
| `requireConfirmation` | `true` | False-breakout filter (next candle must also close beyond) |
| `logMonitorStatus` | `true` | Periodic monitor audit log |
| `orderFillTimeoutSec` | `120` | Cancel unfilled limit after 2 min |
| `killSwitchRiskMult` | `1.5` | Close if price moves > 1.5× planned risk against |
| `atrPeriod` | `14` | ATR period |
| `scoring.weights` | `{ volume: 0.30, gap: 0.25, close: 0.25, vwap: 0.20 }` | Quality-score blend |
| `scoring.volumeRatioMax` | `4.0` | Volume ratio at which that factor = 10 |
| `scoring.gapPctMax` | `5.0` | `|gap%|` at which that factor = 10 |
| `scoring.closeBeyondFracMax` | `0.5` | (close beyond OR)/OR-range at which that factor = 10 |
| `scoring.vwapDistPctMax` | `1.0` | % distance from VWAP at which that factor = 10 |

### Safety / risk (`risk`)

| Key | Default | Purpose |
|-----|---------|---------|
| `dailyLossLimitPct` | `0.03` | −3% halts trading for the day _(defined; enforcement is a later item)_ |
| `maxConcurrentPositions` | `15` | Cap on simultaneous open positions |
| `apiMaxRetries` | `5` | Alpaca retry/backoff ceiling |

### Daily schedule (`schedule`, all ET)

| Key | Default | Key | Default |
|-----|---------|-----|---------|
| `wakeUp` | `04:00` | `marketOpen` | `09:30` |
| `initialScan` | `07:00` | `entryCutoff` | `11:00` |
| `refinedScan` | `08:00` | `forceClose` | `15:55` |
| `finalWatchlist` | `09:00` | `marketClose` | `16:00` |
| `preOpenPrep` | `09:25` | `dailyReport` | `16:30` _(Phase 4)_ |
| | | `cleanup` | `17:00` _(Phase 4)_ |

> Note: the `wakeUp` config value is `04:00`, but the registered cron wake-up job
> in `bot.js` fires at **05:00**. The cron schedule in `bot.js` is the operative
> one for live behaviour.

---

## 7. Database schema (`data/orb.db`)

| Table | Purpose |
|-------|---------|
| `watchlist_history` | One row per evaluated candidate per day: gap%, pm volume, prev close, pre-market price, fetched_at, rank score, `selected` flag, and the full Perplexity catalyst classification. `UNIQUE(date, symbol)`. |
| `opening_ranges` | Locked OR high/low/complete-time per `(date, symbol, timeframe)`. |
| `signals` | Every fired/failed breakout signal with entry/stop, gap, VWAP, volume ratio, quality score + per-factor breakdown, `status` (`confirmed`/`failed`). `UNIQUE(date, symbol, timeframe, direction)` for de-dup. |
| `trades` | **Doubles as the live-position store.** One row per RR leg: status (`pending`/`open`/`closed`/`cancelled`), entry/stop/target, shares, order IDs, slippage, `simulated` flag, realized P&L/R-multiple/%, and copied catalyst fields. |
| `daily_performance` | Per-variation daily rollup (trades, wins/losses, win rate, total P&L, profit factor). `UNIQUE(date, strategy_variation)`. **Populated by Phase 4.** |

Additive `ALTER` migrations bring older DBs up to date without dropping data.

---

## 8. Commands

```bash
npm start                      # run the scheduler/worker (what Railway runs)
npm test                       # 115 offline unit tests (node --test tests/*.test.js)
npm run check                  # verify Alpaca connection + account, exit
npm run scan                   # universe scanner only
npm run gapscan                # full pre-market gap + catalyst scan → DB
npm run or [YYYY-MM-DD] [SYM…] # compute + persist a session's opening ranges
npm run smoke                  # live end-to-end checks vs real Alpaca/Perplexity
npm run backtest               # ⬜ Phase 5 — src/backtest.js not yet built

node src/bot.js --check        # validate startup + connection + schedule, exit
node src/bot.js --run <job>    # run one job: wake|scan|final|preopen|or5|or15|or30|
                               #   audit|monitor|close|manage|eod
node src/notify/discord.js     # send a sample Discord alert (verify webhook)
```
