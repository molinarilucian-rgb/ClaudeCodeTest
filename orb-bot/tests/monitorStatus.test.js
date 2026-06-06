import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMonitorStatus, formatMonitorPending } from '../src/monitorStatus.js';

test('short bias: price above OR low → no break (matches the spec example)', () => {
  const line = formatMonitorStatus({
    symbol: 'AVGO', timeframe: 15, price: 400.18, orHigh: 405, orLow: 400.00, gapPct: -5,
  });
  assert.equal(line, 'AVGO 15m monitor | price 400.18 | OR low 400.00 | +0.18 above (no break)');
});

test('short bias: price below OR low → BREAK', () => {
  const line = formatMonitorStatus({
    symbol: 'AVGO', timeframe: 15, price: 399.50, orHigh: 405, orLow: 400.00, gapPct: -5,
  });
  assert.equal(line, 'AVGO 15m monitor | price 399.50 | OR low 400.00 | 0.50 below (BREAK)');
});

test('long bias: price below OR high → no break', () => {
  const line = formatMonitorStatus({
    symbol: 'META', timeframe: 5, price: 622.40, orHigh: 623.00, orLow: 620, gapPct: 3.5,
  });
  assert.equal(line, 'META 5m monitor | price 622.40 | OR high 623.00 | 0.60 below (no break)');
});

test('long bias: price at/above OR high → BREAK', () => {
  const line = formatMonitorStatus({
    symbol: 'META', timeframe: 5, price: 623.25, orHigh: 623.00, orLow: 620, gapPct: 3.5,
  });
  assert.equal(line, 'META 5m monitor | price 623.25 | OR high 623.00 | +0.25 above (BREAK)');
});

test('pending line names the correct side per direction', () => {
  assert.equal(
    formatMonitorPending({ symbol: 'AVGO', timeframe: 15, direction: 'short' }),
    'AVGO 15m PENDING — closed below OR low, awaiting next-candle confirmation'
  );
  assert.equal(
    formatMonitorPending({ symbol: 'META', timeframe: 5, direction: 'long' }),
    'META 5m PENDING — closed above OR high, awaiting next-candle confirmation'
  );
});
