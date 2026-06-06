import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

// Throwaway DB. ORB_DB_PATH must be set BEFORE the database module first loads,
// so config, the engine, and the DB are all imported dynamically inside before()
// (static imports are hoisted and would load database.js against the real path).
const TMP_DB = join(tmpdir(), `orb-exec-${process.pid}-${Date.now()}.db`);
process.env.ORB_DB_PATH = TMP_DB;

let config, createExecutionEngine, db;
before(async () => {
  config = (await import('../config/config.js')).default;
  ({ createExecutionEngine } = await import('../src/execution/executionEngine.js'));
  db = await import('../src/data/database.js');
});
after(() => {
  for (const ext of ['', '-wal', '-shm']) { try { rmSync(TMP_DB + ext); } catch { /* ignore */ } }
});

const silent = { info() {}, warn() {}, error() {} };

// ---- Fakes ----------------------------------------------------------------

function fakeBroker(simulationMode) {
  const calls = { entries: [], exits: [], cancels: [] };
  let pollResult = { filled: false, canceled: false, terminal: false, filledQty: 0, filledAvgPrice: null };
  let clockRef = () => Date.now();
  return {
    simulationMode, mode: simulationMode ? 'SIMULATION' : 'LIVE', calls,
    setPollResult(r) { pollResult = r; },
    setClock(fn) { clockRef = fn; },
    async placeEntry(o) { calls.entries.push(o); return { orderId: `ord-${o.clientOrderId}`, status: simulationMode ? 'accepted' : 'new', simulated: simulationMode, submittedAt: new Date(clockRef()).toISOString() }; },
    async pollOrder() { return simulationMode ? null : pollResult; },
    async cancelOrder(id) { calls.cancels.push(id); return { ok: true }; },
    async placeExit(o) { calls.exits.push(o); return { orderId: `exit-${o.clientOrderId}`, status: 'accepted', simulated: simulationMode, filledAvgPrice: null }; },
  };
}

function fakeMd({ buyingPower = 1_000_000 } = {}) {
  let price = 100;
  return {
    setPrice(p) { price = p; },
    async getAccount() { return { account_number: 'TEST', buying_power: String(buyingPower) }; },
    async getLatestPrice() { return price; },
  };
}

// A clean LONG signal: entry 101.5, stop 99 (risk $2.50), OR 99–100.
function longSignal(symbol = 'TST') {
  const entry = 101.5, stop = 99, risk = 2.5;
  return {
    symbol, timeframe: 5, direction: 'long', entryPrice: entry, stopPrice: stop,
    orHigh: 100, orLow: 99,
    targets: config.strategy.rrRatios.map((rr) => ({ rr, price: entry + risk * rr })),
  };
}

function makeEngine({ broker, md, clock } = {}) {
  return createExecutionEngine({
    cfg: config, database: db, md, broker, notify: async () => {}, log: silent,
    clock: clock || (() => Date.now()),
  });
}

beforeEach(() => {
  // Clear positions between tests so trade_ids (which include today's date) don't collide.
  db.db.exec('DELETE FROM trades;');
});

// ---- Tests ----------------------------------------------------------------

test('opens one position per RR variation, sized + filled in simulation', async () => {
  const broker = fakeBroker(true);
  const engine = makeEngine({ broker, md: fakeMd() });
  const opened = await engine.openPositionsForSignal(longSignal(), { catalyst: 'earnings' });

  assert.equal(opened.length, config.strategy.rrRatios.length); // 3 legs
  assert.equal(broker.calls.entries.length, 3);

  const open = db.getOpenPositions();
  assert.equal(open.length, 3);
  for (const p of open) {
    assert.equal(p.status, 'open');         // sim fills immediately
    assert.equal(p.shares, 400);            // $1000 risk / $2.50
    assert.equal(p.entry_price, 101.5);
    assert.equal(p.slippage, 0);            // sim fills at intended price
    assert.equal(p.stop_price, 99);
    assert.equal(p.simulated, 1);
  }
  // distinct targets per leg
  const targets = open.map((p) => p.target_price).sort((a, b) => a - b);
  assert.deepEqual(targets, [104, 105.25, 106.5]); // entry + 2.5×{1,1.5,2}
});

test('does not double-open the same signal', async () => {
  const broker = fakeBroker(true);
  const engine = makeEngine({ broker, md: fakeMd() });
  await engine.openPositionsForSignal(longSignal());
  await engine.openPositionsForSignal(longSignal()); // second call is a no-op
  assert.equal(db.getOpenPositions().length, 3);
  assert.equal(broker.calls.entries.length, 3);
});

test('closes a leg at its target with the right P&L and R multiple', async () => {
  const broker = fakeBroker(true);
  const md = fakeMd();
  const engine = makeEngine({ broker, md });
  await engine.openPositionsForSignal(longSignal());

  md.setPrice(104); // hits the 1:1 leg (target 104) only
  await engine.manageOpenPositions();

  const open = db.getOpenPositions();
  assert.equal(open.length, 2); // 1:1.5 and 1:2 still open

  const rr1 = db.getPosition(db.getTradesForDate(open[0].date).find((t) => t.rr_ratio === 1).trade_id);
  assert.equal(rr1.status, 'closed');
  assert.equal(rr1.exit_reason, 'TARGET');
  assert.equal(rr1.exit_price, 104);
  assert.equal(rr1.pnl, (104 - 101.5) * 400); // = 1000
  assert.equal(rr1.r_multiple, 1);
});

test('closes a leg at the stop with a negative P&L', async () => {
  const broker = fakeBroker(true);
  const md = fakeMd();
  const engine = makeEngine({ broker, md });
  await engine.openPositionsForSignal(longSignal('STP'));

  md.setPrice(99); // at/through the stop
  await engine.manageOpenPositions();

  const legs = db.getTradesForDate(db.getOpenPositions()[0]?.date || todayLeg('STP').date);
  const closed = legs.filter((t) => t.status === 'closed');
  assert.ok(closed.length >= 1);
  const one = closed[0];
  assert.equal(one.exit_reason, 'STOP');
  assert.equal(one.exit_price, 99);
  assert.equal(one.pnl, (99 - 101.5) * 400); // = -1000
  assert.equal(one.r_multiple, -1);
});

test('kill switch fires on a gap past 1.5× risk', async () => {
  const broker = fakeBroker(true);
  const md = fakeMd();
  const engine = makeEngine({ broker, md });
  await engine.openPositionsForSignal(longSignal('KIL'));

  // risk $2.50; kill threshold = entry − 1.5×2.5 = 97.75. 97 is past it.
  md.setPrice(97);
  await engine.manageOpenPositions();

  const closed = db.getTradesForDate(todayLeg('KIL').date).filter((t) => t.symbol === 'KIL');
  assert.ok(closed.every((t) => t.status === 'closed'));
  assert.ok(closed.some((t) => t.exit_reason === 'KILL_SWITCH'));
});

test('skips every leg when notional exceeds buying power', async () => {
  const broker = fakeBroker(true);
  const engine = makeEngine({ broker, md: fakeMd({ buyingPower: 1000 }) });
  const opened = await engine.openPositionsForSignal(longSignal('POOR'));
  assert.equal(opened.length, 0);
  assert.equal(db.getOpenPositions().length, 0);
  assert.equal(broker.calls.entries.length, 0);
});

test('LIVE entry stays pending then cancels after the fill timeout', async () => {
  let t = Date.parse('2026-06-05T14:00:00Z');
  const clock = () => t;
  const broker = fakeBroker(false);
  broker.setClock(clock);
  broker.setPollResult({ filled: false, canceled: false, terminal: false, filledQty: 0, filledAvgPrice: null });
  const engine = makeEngine({ broker, md: fakeMd(), clock });

  await engine.openPositionsForSignal(longSignal('LIV'));
  let open = db.getOpenPositions();
  assert.equal(open.length, 3);
  assert.ok(open.every((p) => p.status === 'pending')); // live: not filled yet

  // Still inside the 2-min window → no cancel.
  await engine.manageOpenPositions();
  assert.equal(db.getOpenPositions().length, 3);

  // Advance past orderFillTimeoutSec → all pending entries cancelled.
  t += (config.strategy.orderFillTimeoutSec + 1) * 1000;
  await engine.manageOpenPositions();
  assert.equal(db.getOpenPositions().length, 0);
  const cancelled = db.getTradesForDate('2026-06-05').filter((p) => p.symbol === 'LIV');
  assert.ok(cancelled.every((p) => p.status === 'cancelled' && p.exit_reason === 'CANCELLED_UNFILLED'));
});

test('LIVE pending fills on poll, recording the avg fill price + slippage', async () => {
  const broker = fakeBroker(false);
  broker.setPollResult({ filled: true, canceled: false, terminal: true, filledQty: 400, filledAvgPrice: 101.6 });
  const engine = makeEngine({ broker, md: fakeMd() });

  await engine.openPositionsForSignal(longSignal('FIL'));
  await engine.manageOpenPositions();

  const open = db.getOpenPositions();
  assert.ok(open.length >= 1);
  for (const p of open) {
    assert.equal(p.status, 'open');
    assert.equal(p.entry_price, 101.6);
    assert.equal(p.slippage, 0.1); // 101.6 − 101.5 intended, adverse for a long
  }
});

test('forceCloseAll flattens open legs and cancels pending ones (EOD)', async () => {
  const broker = fakeBroker(true);
  const md = fakeMd();
  const engine = makeEngine({ broker, md });
  await engine.openPositionsForSignal(longSignal('EOD'));

  md.setPrice(102.25); // between entry and the first target → no auto-exit
  const res = await engine.forceCloseAll('EOD_CLOSE');
  assert.equal(res.closed, 3);
  assert.equal(db.getOpenPositions().length, 0);
  const legs = db.getTradesForDate(todayLeg('EOD').date).filter((t) => t.symbol === 'EOD');
  assert.ok(legs.every((t) => t.status === 'closed' && t.exit_reason === 'EOD_CLOSE'));
  assert.ok(legs.every((t) => t.exit_price === 102.25));
});

test('recoverOpenPositions returns the positions still being managed', async () => {
  const broker = fakeBroker(true);
  const engine = makeEngine({ broker, md: fakeMd() });
  await engine.openPositionsForSignal(longSignal('REC'));
  const recovered = await engine.recoverOpenPositions();
  assert.equal(recovered.length, 3);
});

// Helper: a deterministic trade_id stem so tests can locate today's rows.
function todayLeg(symbol) {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  return { date, symbol };
}
