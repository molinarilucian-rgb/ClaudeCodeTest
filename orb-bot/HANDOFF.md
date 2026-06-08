# ORB Bot — Engineering Handoff

_Last updated: 2026-06-08_

This document is the catch-up read for anyone (human or agent) picking up the
ORB bot. It summarizes what's built, every bug fixed, every verification done,
the deploy configuration, and exactly what Phase 4 still needs. For day-to-day
usage and the morning schedule, see `README.md`; for the strategy, see
`orb_strategy_spec.md`.

**Golden rules**
- **Paper trading only.** `config.alpaca.paper` is hard-locked `true`. Never
  point at the live Alpaca endpoint.
- **`SIMULATION_MODE=true` is the master safety flag** (default). It runs the
  full Phase 3 execution lifecycle but submits *nothing* to Alpaca — orders are
  logged only. Flip to `false` only after watching the simulated logs.
- **Commit + push after every logical change** (see root `CLAUDE.md`).

---

## 1. What Phases 1–3 built

| Phase | Scope | State |
|-------|-------|-------|
| 1. Foundation | Project setup, Alpaca connection, universe + gap scanning, catalyst filter, SQLite persistence | ✅ built |
| 2. Strategy logic | Opening-range calc, breakout detection, VWAP/gap/volume confirmations, signal quality score | ✅ built |
| 3. Execution | Position sizing, limit entries, stop/target/kill-switch management, EOD close, restart recovery | ✅ built (SIMULATION_MODE-gated) |
| 6. Live paper | node-cron ET schedule, Railway deploy, Discord alerts, restart safety, monitor/rejection audit logs | 🔨 partial |
| 4. Multi-strategy | 9 variations aggregated, independent P&L, daily reports | ⬜ **next** |
| 5. Backtesting | Historical replay + metrics | ⬜ |
| 7. Dashboard | Express + WebSocket | ⬜ (optional) |

### Phase 1 — Foundation

| File | Responsibility |
|------|----------------|
| `config/config.js` | Single source of truth for **all** strategy params (nothing hardcoded elsewhere). Validates required env vars on boot and exits cleanly listing any missing. |
| `src/data/marketData.js` | Alpaca SDK wrapper — account, asset lookup, minute bars, snapshots — with retry/backoff. `npm run check` entry point. |
| `src/data/perplexity.js` | Catalyst classifier via Perplexity live web search; normalizes/clamps the JSON response, fails safe on HTTP/network/parse errors. |
| `src/data/database.js` | `node:sqlite` (built-in, Node 22.5+) persistence. Tables: `watchlist_history`, `opening_ranges`, `signals`, `trades`, `daily_performance`. Lightweight ALTER migrations for additive columns. |
| `src/scanners/universeScanner.js` | Applies universe filters (exchange, price, liquidity proxy) → qualified candidates. Flags criteria it can't enforce on the free plan (market cap, optionable, earnings). |
| `src/scanners/gapScanner.js` | Pre-market gaps → Perplexity catalyst classify → quality filter → persist top picks to the watchlist. |
| `src/utils/{logger,timeUtils,indicators}.js` | winston logging (console + optional daily file); dayjs ET timezone + trading-day/holiday helpers; ATR/VWAP/SMA/avg-volume/gap%/stddev math. |

### Phase 2 — Strategy logic

| File | Responsibility |
|------|----------------|
| `src/strategy/openingRange.js` | Computes the 5/15/30-min opening range (high/low) per symbol. Batch (`computeAllOpeningRanges`) and live (`OpeningRangeTracker`) paths. Time-based completion via the `asOf` arg so a lock at the window boundary completes correctly. |
| `src/strategy/breakoutDetector.js` | The ORB entry signal. Finds the first candle to **close** beyond the OR, applies the false-breakout (next-candle) filter, and evaluates every confirmation: price break, candle close, confirmation candle, gap alignment, VWAP bias, volume surge, before-cutoff, no-position. `triggered` is true only when **all** pass. Also computes stop/targets and the 1–10 quality score. |
| `src/monitorStatus.js` | Pure, testable log formatters: `formatMonitorStatus` (price vs relevant OR level), `formatMonitorPending` (awaiting confirmation), `formatRejectionReasons` (why a BREAK didn't fire). |

### Phase 3 — Execution (SIMULATION_MODE-gated)

| File | Responsibility |
|------|----------------|
| `src/execution/positionSizer.js` | Pure risk-based sizing. `shares = floor(accountSize × maxRiskPerTrade ÷ |entry − stop|)`. **Skips** (never silently shrinks) when entry==stop, <1 share, or notional > buying power. Returns full math for an auditable log line. |
| `src/execution/broker.js` | SIMULATION/LIVE-gated order ops (entry/exit/cancel/poll). In simulation, logs the intended order and returns a virtual fill; in live, submits real **paper** orders. |
| `src/execution/executionEngine.js` | Orchestrates everything: opens the 3 RR variations per signal as independent positions, manages fills/stops/targets/kill-switch, 15:55 ET force-close, and DB-backed restart recovery. Reads open positions from the DB every tick (never memory). |
| `src/notify/discord.js` | Webhook alerts for signals and the order lifecycle (placed/filled/closed with P&L) + restart-recovery summary. |
| `src/bot.js` | The long-lived worker. Registers all cron jobs in `America/New_York`, runs the 30s breakout monitor + position manager, handles startup catch-up, and exposes `--run <job>` / `--check` for manual verification. |

**Execution model:** each confirmed breakout opens **3 independent positions**
(1:1, 1:1.5, 1:2 reward:risk), each risk-sized on its own. Entry is a DAY limit
at the breakout-candle close (cancelled if unfilled after 2 min). Stop is the
opposite OR extreme ± a 0.1% buffer. Exits: target limit, stop market, kill
switch (>1.5× planned risk against), or 15:55 EOD force-close. Realized P&L,
R-multiple, and % are stored on close.

---

## 2. Bugs found and fixed

### a) OR completeness off-by-one — `f2f1c5e`
**Symptom:** an OR lock firing exactly at the window end (e.g. 09:35 for the
5-min OR, with bars at offsets 0–4) was flagged `incomplete (5 bars)`.
**Cause:** completion required a bar at offset ≥ `timeframe` — i.e. a bar *past*
the window, which doesn't exist yet at the boundary.
**Fix:** the window covers offsets `[0, tf)`; it's complete once the final
window minute is observed (`maxOffset >= tf-1`) **or** the window-end time has
passed (new optional `asOf` arg, which the lock/monitor jobs now pass as `now`).
**Impact:** the OR high/low were always computed from the full in-window bars;
the incomplete flag only *delayed* detection by ~1 min — no partial-range signal
was ever generated. The fix removes that delay. (+5 boundary tests.)

### b) Watchlist persistence gap — `4a6eede`
**Symptom:** gap math couldn't be audited after the fact.
**Cause:** the scanner computed `prev_close` and the pre-market price but
discarded them after deriving `gap_pct`.
**Fix:** persist `prev_close`, `pre_market_price`, and `fetched_at` (snapshot
timestamp) on every `watchlist_history` row, with an ALTER migration for
existing DBs. Gap math is now fully auditable for correctness/staleness.

### c) Restart / catch-up logic — `f1befe1`
**Symptom:** a mid-morning restart (Railway redeploy) risked trading a partial
session or losing the day's watchlist.
**Fix:** `src/startupPolicy.js` — pure `decideStartupAction()` that, on boot:
- before 09:00 → wait for the normal 09:00 scan;
- 09:00–09:35 → recover the DB watchlist, or rebuild it now if empty;
- at/after 09:35 → **stand down** for the day (no partial session).
Every scheduled step reads the watchlist from the DB (never memory), and signal
de-dup checks the `signals` table so a restart can't re-alert. (+6 unit tests.)

### d) High/low "swap"/inheritance investigation — `20a5fd6` (NOT a bug)
**Report:** NVDA's 5m and 15m OR lows both showed an identical value (e.g.
208.21) — suspected the 15m level was inheriting the 5m level.
**Finding:** **not a bug.** Each timeframe is computed independently as a
`min`/`max` over its own bar window in `computeOpeningRange`. The 15m window is a
strict **superset** of the 5m window, so the 15m low can never be *higher* than
the 5m low — identical values are expected whenever the relevant extreme printed
in the first 5 minutes and held. The decisive tell that there's no inheritance:
highs and lows move **independently** across timeframes (verified on real
2026-06-04 data — e.g. NVDA's 15m high rose above its 5m high while its low
stayed flat; PLTR was identical across all three because both extremes set
early). A 15m low *above* the 5m low would be the real red flag and is
mathematically impossible here.
**Hardening added:** `logOrLevelsAudit()` prints every watchlist stock's
high/low/range across all timeframes side by side after the 30m lock (and via
`--run audit`), plus explicit rejection logging (see §3e below).

---

## 3. Verifications completed

> Items (a)–(c) are encoded as regression tests and/or commit-verified on real
> data. Items (d)–(e) were checked against the live calculations; the specific
> session figures are not stored as fixtures in-repo, so re-run the noted command
> to reproduce exact numbers.

### a) AVGO breakout signal — end-to-end confirmation path
The breakout monitor and confirmation checklist were exercised on AVGO session
bars: the monitor audit line tracks price vs the relevant OR level
(`AVGO 15m monitor | price 400.18 | OR low 400.00 | +0.18 above (no break)`),
the PENDING state logs when a candle closes beyond the OR awaiting its
confirmation candle, and a fully-confirmed break fires the Discord alert with the
✅/❌ confirmation checklist + quality score. The false-breakout filter was also
verified on real data (AAPL 5m broke 09:36 then FAILED 09:37 when the next candle
closed back inside — `496bc22`).

### b) Position sizing / fill math (the "SMCI" check)
`sizePosition()` was verified against hand-computed expectations and has 23 Phase
3 tests covering the lifecycle. The math:
`riskAmount = accountSize × maxRiskPerTrade`; `shares = floor(riskAmount ÷
|entry − stop|)`; `notional = shares × entry`. A trade is **skipped** (not
shrunk) on entry==stop, <1 share, or notional > buying power. Every signal logs
the full trail, e.g. `sizing | account $100,000 × 1.00% = risk $1000.00 | entry
$101.50 stop $99.00 → per-share risk $2.50 | shares 400 | notional $40,600.00`.
Fills also record actual price + **slippage** vs the intended limit.
_To reproduce a specific symbol's numbers, run the monitor/execution against that
session and read the `sizing |` log line._

### c) Stop buffer
Stop is placed at the opposite OR extreme ± `config.strategy.stopBufferPct`
(**0.1%**, i.e. `0.001`): long stop = `orLow − orLow×0.001`; short stop =
`orHigh + orHigh×0.001`. Confirmed against the `breakoutDetector` stop/target
computation and its tests.

### d) OR levels vs TradingView
The computed 5/15/30-min OR highs/lows were cross-checked against TradingView for
the same session and matched. _Reproduce with `node src/bot.js --run audit`
(during/after a session with a populated watchlist) or `npm run or [YYYY-MM-DD]
[SYM…]`, then compare to a TradingView session chart._ Caveat: on the free
**IEX** feed, individual minute bars can differ slightly from consolidated/SIP
data, so expect minor discrepancies until `ALPACA_DATA_FEED=sip` (see §6).

### e) OR-levels audit + rejection logging — `20a5fd6`
Ran `--run audit` against the 2026-06-04 session: all watchlist stocks printed
correct, independently-moving OR levels across timeframes (confirming §2d). The
new `formatRejectionReasons` has 6 unit tests; every BREAK that doesn't become a
signal now logs **why** (gap mismatch, VWAP, volume surge, cutoff, position, or
"no candle has CLOSED beyond the OR yet — wick only"), throttled to once per bar.

**Test suite: 115 offline unit tests passing** (`npm test`).

---

## 4. Railway environment variables

Set in the Railway service **Variables** tab (service root directory =
`orb-bot`). Secrets are **not** in the repo — values below marked _(secret)_ live
only in the Railway dashboard.

| Variable | Value | Notes |
|----------|-------|-------|
| `ALPACA_API_KEY` | _(secret)_ | Paper-account key |
| `ALPACA_SECRET_KEY` | _(secret)_ | Paper-account secret |
| `ALPACA_BASE_URL` | `https://paper-api.alpaca.markets` | **Never** the live endpoint |
| `ALPACA_DATA_URL` | `https://data.alpaca.markets` | Market data host |
| `ACCOUNT_SIZE` | `100000` | Sizing base |
| `MAX_RISK_PER_TRADE` | `0.01` | 1% risk per trade |
| `TIMEZONE` | `America/New_York` | All cron jobs fire in ET |
| `SIMULATION_MODE` | `true` | **Keep `true`** until live-trading is intended |
| `PERPLEXITY_API_KEY` | _(secret)_ | Catalyst classification; fail-open if unset |
| `DISCORD_WEBHOOK_URL` | _(secret)_ | Signal + order alerts; degrades gracefully if unset |
| `SCHEDULE_ENABLED` | `true` (default) | Set `false` to disable all cron jobs |
| `ALPACA_DATA_FEED` | `iex` (default) | `sip` once on the paid data plan |
| `NIXPACKS_NODE_VERSION` | `24` | Only if Railway picks the wrong Node (need ≥22.5 for `node:sqlite`) |
| `RAILWAY_VOLUME_MOUNT_PATH` | set by Railway when a Volume is attached | Bot stores the DB at `$RAILWAY_VOLUME_MOUNT_PATH/orb.db` — mount a Volume at `/app/data` to persist history across redeploys |

> **DB persistence:** without a Railway Volume the SQLite DB is on ephemeral disk
> and resets every redeploy. Attach a Volume at `/app/data` to retain
> watchlist/signal/trade history.

---

## 5. What Phase 4 needs to build

Phase 4 = **multi-strategy aggregation & daily P&L reporting.** The raw material
already exists — every signal/trade row stores its OR timeframe, RR variation,
catalyst type/quality, quality score, and realized P&L/R-multiple. Phase 4 turns
that into per-variation performance and a daily summary.

1. **Aggregate the 9 variations (3 OR timeframes × 3 RR ratios).** Roll up the
   `trades` table per `(timeframe, rr)` combo: win rate, avg R, total P&L, expectancy,
   trade count. This is the project's core question — *which variation actually works.*
2. **Daily P&L report (≈16:00 / 16:30 ET).** After EOD close, compute the day's
   realized P&L overall and per variation, write it to `daily_performance`, and
   send a Discord summary. Add the cron jobs to `src/bot.js` (schedule slots
   `dailyReport: '16:30'` and `cleanup: '17:00'` already exist in
   `config.schedule`).
3. **Performance-by-catalyst breakdown.** The catalyst fields are already copied
   onto each trade — answer "which catalyst types produced winning ORB trades?"
4. **End-of-day reset.** A 17:00 cleanup/reset job (clear daily de-dup, roll logs).
5. **Tests** for the aggregation math (hand-computed expectancy/R fixtures), in
   the existing `node --test tests/*.test.js` style.

Phase 5 (backtesting) and Phase 7 (dashboard) remain out of scope until Phase 4
lands. `src/backtest.js` is referenced by `npm run backtest` but not yet built.

---

## 6. Open questions & known issues

- **Free IEX data feed understates volume ~30–50×.** The spec's `>5M avg volume`
  and `>100K pre-market volume` filters are scaled down to IEX proxies
  (`150K` / `3K`). Real fix: subscribe to Alpaca SIP and set
  `ALPACA_DATA_FEED=sip`, then restore the SIP thresholds in `config`. Until
  then, treat the scan *pipeline* as validated, not the absolute volume numbers.
  This also affects the volume-surge confirmation and OR-vs-TradingView parity.
- **Unenforced selection criteria (flagged, not enforced):** market cap (>$2B),
  optionable flag, earnings-calendar exclusion, and ETF/ADR/leveraged/recent-IPO
  exclusions — Alpaca's standard asset API doesn't expose these. Each candidate
  carries a `flags` object recording verified-vs-assumed. A fundamentals/earnings
  source (or Perplexity) could fill these in.
- **REST polling, no websocket.** Bars are polled via REST every 30s; OR locks
  and the monitor use 1-min bars. A websocket stream would tighten latency but
  isn't required for the current cadence.
- **After-hours `gap_pct` / `pm_volume` caveat.** Outside the real 7–9 AM ET
  scan window, snapshot-derived gap/volume reflect the just-closed session, not
  true pre-market figures. Validate logic, not specific numbers, when testing at
  night.
- **`noPosition` confirmation isn't wired in the monitor.** `detectBreakout` is
  called without `hasPosition`, so signal-level de-dup (`alertedSignals` + the
  `signals` table) is what prevents re-entry, not the `noPosition` confirmation.
  `formatRejectionReasons` already handles the `noPosition` case for when it's
  wired through later.
- **Going live is a deliberate, one-line flip** (`SIMULATION_MODE=false`) — still
  on the paper endpoint. Do it only after watching simulated logs confirm
  sizing/behaviour.

---

## Quick reference

```bash
npm test                       # 115 offline unit tests
npm start                      # run the scheduler/worker (what Railway runs)
node src/bot.js --check        # validate startup + connection + schedule, exit
node src/bot.js --run audit    # OR-levels audit for today's session
node src/bot.js --run <wake|scan|final|preopen|or5|or15|or30|monitor|close|manage|eod|audit>
npm run or [YYYY-MM-DD] [SYM…] # compute + persist a session's opening ranges
npm run smoke                  # live end-to-end checks vs real Alpaca/Perplexity
```
