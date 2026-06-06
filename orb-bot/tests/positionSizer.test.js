import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sizePosition } from '../src/execution/positionSizer.js';

const base = { accountSize: 100000, maxRiskPerTrade: 0.01, buyingPower: 1_000_000 };

test('sizes shares as floor(risk / per-share risk)', () => {
  const s = sizePosition({ ...base, entry: 101.5, stop: 99 }); // risk $1000, per-share $2.50
  assert.equal(s.skip, false);
  assert.equal(s.riskAmount, 1000);
  assert.equal(s.perShareRisk, 2.5);
  assert.equal(s.shares, 400);          // 1000 / 2.5
  assert.equal(s.notional, 400 * 101.5);
});

test('floors fractional share counts', () => {
  const s = sizePosition({ ...base, entry: 50, stop: 47 }); // risk $1000, per-share $3 → 333.33
  assert.equal(s.shares, 333);
});

test('short side uses absolute stop distance', () => {
  const s = sizePosition({ ...base, entry: 99, stop: 101.5 }); // short: stop above entry
  assert.equal(s.perShareRisk, 2.5);
  assert.equal(s.shares, 400);
});

test('skips when entry equals stop (no definable risk)', () => {
  const s = sizePosition({ ...base, entry: 100, stop: 100 });
  assert.equal(s.skip, true);
  assert.match(s.reason, /entry equals stop/);
  assert.equal(s.shares, 0);
});

test('skips when risk is too small to afford one share', () => {
  // tiny account, huge per-share risk → 0 shares
  const s = sizePosition({ accountSize: 100, maxRiskPerTrade: 0.01, buyingPower: 1e9, entry: 500, stop: 400 });
  assert.equal(s.skip, true);
  assert.match(s.reason, /too small for one share/);
});

test('skips (does not shrink) when notional exceeds buying power', () => {
  const s = sizePosition({ ...base, entry: 101.5, stop: 99, buyingPower: 1000 });
  assert.equal(s.skip, true);
  assert.match(s.reason, /exceeds available buying power/);
  assert.equal(s.shares, 400);   // computed share count is reported…
  assert.ok(s.notional > 1000);  // …but the trade is skipped, not resized
});

test('carries full math for the audit log', () => {
  const s = sizePosition({ ...base, entry: 101.5, stop: 99 });
  for (const k of ['accountSize', 'maxRiskPerTrade', 'entry', 'stop', 'buyingPower', 'riskAmount', 'perShareRisk', 'shares', 'notional']) {
    assert.ok(k in s, `sizing result should include ${k}`);
  }
});
