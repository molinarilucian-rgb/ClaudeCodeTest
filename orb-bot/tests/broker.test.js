import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBroker } from '../src/execution/broker.js';

const silent = { info() {}, warn() {}, error() {} };

// A fake marketData that records calls and returns canned orders.
function fakeMd() {
  const calls = { created: [], cancelled: [], fetched: [] };
  return {
    calls,
    async createOrder(body) { calls.created.push(body); return { id: 'live-1', status: 'new', submitted_at: 'T', filled_avg_price: null }; },
    async getOrder(id) { calls.fetched.push(id); return { id, status: 'filled', filled_qty: '10', filled_avg_price: '101.55' }; },
    async cancelOrder(id) { calls.cancelled.push(id); return {}; },
  };
}

test('SIMULATION mode places nothing — returns a synthetic order', async () => {
  const md = fakeMd();
  const b = createBroker({ simulationMode: true, md, log: silent });
  const res = await b.placeEntry({ symbol: 'TST', qty: 10, side: 'buy', limitPrice: 101.5, clientOrderId: 'cid1' });
  assert.equal(res.simulated, true);
  assert.equal(res.orderId, 'sim-cid1');
  assert.equal(md.calls.created.length, 0); // nothing hit the network
});

test('SIMULATION pollOrder returns null (engine drives sim fills)', async () => {
  const b = createBroker({ simulationMode: true, md: fakeMd(), log: silent });
  assert.equal(await b.pollOrder('sim-x'), null);
});

test('SIMULATION cancel/exit are no-ops that do not touch the network', async () => {
  const md = fakeMd();
  const b = createBroker({ simulationMode: true, md, log: silent });
  await b.cancelOrder('sim-x');
  const exit = await b.placeExit({ symbol: 'TST', qty: 10, side: 'sell', type: 'market', clientOrderId: 'cidx' });
  assert.equal(exit.simulated, true);
  assert.equal(md.calls.cancelled.length, 0);
  assert.equal(md.calls.created.length, 0);
});

test('LIVE mode submits a real limit entry to Alpaca', async () => {
  const md = fakeMd();
  const b = createBroker({ simulationMode: false, md, log: silent });
  const res = await b.placeEntry({ symbol: 'TST', qty: 10, side: 'buy', limitPrice: 101.5, clientOrderId: 'cid1' });
  assert.equal(res.simulated, false);
  assert.equal(res.orderId, 'live-1');
  assert.equal(md.calls.created.length, 1);
  const body = md.calls.created[0];
  assert.equal(body.type, 'limit');
  assert.equal(body.time_in_force, 'day');
  assert.equal(body.limit_price, '101.50');
  assert.equal(body.client_order_id, 'cid1');
});

test('LIVE pollOrder reports fill state from Alpaca', async () => {
  const b = createBroker({ simulationMode: false, md: fakeMd(), log: silent });
  const od = await b.pollOrder('live-1');
  assert.equal(od.filled, true);
  assert.equal(od.filledAvgPrice, 101.55);
});

test('LIVE exit waits for and returns the average fill price', async () => {
  const md = fakeMd();
  const b = createBroker({ simulationMode: false, md, log: silent });
  const res = await b.placeExit({ symbol: 'TST', qty: 10, side: 'sell', type: 'market', clientOrderId: 'cidx' });
  assert.equal(res.simulated, false);
  assert.equal(res.filledAvgPrice, 101.55); // from the _waitForFill poll
});
