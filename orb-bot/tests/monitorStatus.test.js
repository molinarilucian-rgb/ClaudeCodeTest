import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMonitorStatus, formatMonitorPending, formatRejectionReasons } from '../src/monitorStatus.js';

// Build a non-triggered signal whose confirmations all pass except `conf` overrides.
const sig = (conf = {}, top = {}) => ({
  direction: 'long', triggered: false, gapPct: 2.5, entryPrice: 100, vwap: 101, volumeRatio: 0.8,
  confirmations: {
    orEstablished: true, priceBreak: true, candleClose: true, confirmationCandle: true,
    gapAligned: true, vwapAligned: true, volumeSurge: true, beforeCutoff: true, noPosition: true,
    ...conf,
  },
  ...top,
});

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

test('rejection: a triggered signal yields no reasons', () => {
  assert.deepEqual(formatRejectionReasons({ triggered: true, confirmations: {} }), []);
  assert.deepEqual(formatRejectionReasons(null), []);
});

test('rejection: gap direction mismatch names the gap and blocked direction', () => {
  const [r] = formatRejectionReasons(sig({ gapAligned: false }));
  assert.equal(r, 'gap direction mismatch (gap up +2.50%, long breakout blocked)');
});

test('rejection: VWAP miss is phrased per direction', () => {
  const [rLong] = formatRejectionReasons(sig({ vwapAligned: false }));
  assert.equal(rLong, 'price below VWAP on a long breakout (entry 100.00 ≤ VWAP 101.00)');
  const [rShort] = formatRejectionReasons(sig({ vwapAligned: false }, { direction: 'short' }));
  assert.equal(rShort, 'price above VWAP on a short breakout (entry 100.00 ≥ VWAP 101.00)');
});

test('rejection: volume surge includes the threshold when supplied', () => {
  const [r] = formatRejectionReasons(sig({ volumeSurge: false }), { volumeMult: 1.5 });
  assert.equal(r, 'volume surge insufficient (0.8× < 1.5×)');
});

test('rejection: existing position is reported first', () => {
  const reasons = formatRejectionReasons(sig({ noPosition: false, gapAligned: false }));
  assert.equal(reasons[0], 'existing position already open');
  assert.equal(reasons.length, 2);
});

test('rejection: past entry cutoff', () => {
  assert.deepEqual(
    formatRejectionReasons(sig({ beforeCutoff: false })),
    ['past the 11:00 ET entry cutoff']
  );
});
