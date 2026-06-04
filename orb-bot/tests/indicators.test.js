import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  trueRange, atr, sma, avgVolume, vwap, stdDev, gapPct,
} from '../src/utils/indicators.js';

// Helper: assert two floats are close.
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~= ${b}`);

test('trueRange picks the largest of the three ranges', () => {
  // high-low=4, |high-prevClose|=2, |low-prevClose|=2 → 4
  assert.equal(trueRange(12, 8, 10), 4);
  // gap up: prevClose far below → |high-prevClose| dominates
  assert.equal(trueRange(15, 12, 5), 10);
  // gap down: |low-prevClose| dominates
  assert.equal(trueRange(14, 10, 20), 10);
});

test('atr returns null when insufficient bars', () => {
  assert.equal(atr([{ h: 1, l: 0, c: 1 }], 14), null);
  assert.equal(atr(null, 14), null);
  assert.equal(atr([], 3), null);
});

test('atr matches hand-computed Wilder value (period 3)', () => {
  // bars chosen so TRs are [4,2,3,4]
  const bars = [
    { h: 11, l: 9, c: 10 },   // seed prevClose
    { h: 12, l: 8, c: 11 },   // TR=max(4,2,2)=4
    { h: 13, l: 11, c: 12 },  // TR=max(2,2,0)=2
    { h: 15, l: 12, c: 14 },  // TR=max(3,3,0)=3
    { h: 14, l: 10, c: 11 },  // TR=max(4,0,4)=4
  ];
  // seed = avg(4,2,3)=3 ; then (3*2 + 4)/3 = 3.33333...
  near(atr(bars, 3), 10 / 3);
});

test('atr with exactly period+1 bars returns the simple seed', () => {
  const bars = [
    { h: 11, l: 9, c: 10 },
    { h: 12, l: 8, c: 11 }, // TR=4
    { h: 13, l: 11, c: 12 }, // TR=2
  ];
  near(atr(bars, 2), 3); // avg(4,2)=3, no smoothing iterations
});

test('sma averages the last `period` values', () => {
  assert.equal(sma([1, 2, 3, 4, 5], 3), 4); // (3+4+5)/3
  assert.equal(sma([10], 1), 10);
  assert.equal(sma([1, 2], 3), null); // too few
});

test('avgVolume averages bar volumes', () => {
  const bars = [{ v: 100 }, { v: 200 }, { v: 300 }];
  assert.equal(avgVolume(bars, 3), 200);
  assert.equal(avgVolume(bars, 2), 250); // last two
});

test('vwap is volume-weighted typical price', () => {
  assert.equal(vwap([{ h: 10, l: 10, c: 10, v: 100 }]), 10);
  // typical 10 @100 and typical 20 @300 → 7000/400
  near(vwap([
    { h: 10, l: 10, c: 10, v: 100 },
    { h: 20, l: 20, c: 20, v: 300 },
  ]), 17.5);
  assert.equal(vwap([]), null);
  assert.equal(vwap([{ h: 1, l: 1, c: 1, v: 0 }]), null); // zero volume
});

test('stdDev computes population standard deviation', () => {
  // classic dataset with mean 5, variance 4 → std 2
  near(stdDev([2, 4, 4, 4, 5, 5, 7, 9]), 2);
  assert.equal(stdDev([]), null);
  assert.equal(stdDev([5, 5, 5]), 0);
});

test('gapPct computes percent change vs previous close', () => {
  near(gapPct(110, 100), 10);
  near(gapPct(95, 100), -5);
  assert.equal(gapPct(100, 0), null); // guard against /0
  assert.equal(gapPct(100, null), null);
});
