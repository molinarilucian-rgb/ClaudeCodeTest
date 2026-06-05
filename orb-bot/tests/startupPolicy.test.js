import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideStartupAction } from '../src/startupPolicy.js';

const ORF = 5; // earliest OR close = 09:35 (offset +5)
const decide = (nowOff, watchlistCount = 0, tradingDay = true) =>
  decideStartupAction({ nowOff, tradingDay, watchlistCount, orFirstOff: ORF });

test('non-trading day → closed regardless of time', () => {
  assert.equal(decide(-10, 5, false), 'closed');
  assert.equal(decide(0, 0, false), 'closed');
});

test('before 09:00 → pre_market (cron will scan at 09:00)', () => {
  assert.equal(decide(-60), 'pre_market'); // 08:30
  assert.equal(decide(-31), 'pre_market'); // 08:59
});

test('09:00–09:35 with empty watchlist → rebuild', () => {
  assert.equal(decide(-30, 0), 'rebuild'); // exactly 09:00
  assert.equal(decide(-10, 0), 'rebuild'); // 09:20
  assert.equal(decide(4, 0), 'rebuild');   // 09:34
});

test('09:00–09:35 with an existing watchlist → recover', () => {
  assert.equal(decide(-30, 5), 'recover');
  assert.equal(decide(4, 3), 'recover');
});

test('at/after 09:35 → stand_down (no partial session)', () => {
  assert.equal(decide(5, 0), 'stand_down');  // exactly 09:35
  assert.equal(decide(5, 5), 'stand_down');  // even with a watchlist
  assert.equal(decide(40, 5), 'stand_down'); // 10:10
  assert.equal(decide(200, 5), 'stand_down'); // afternoon
});

test('the 09:35 boundary is exclusive of trading (stand down at the edge)', () => {
  assert.equal(decide(4, 0), 'rebuild');     // 09:34 still participates
  assert.equal(decide(5, 0), 'stand_down');  // 09:35 stands down
});
