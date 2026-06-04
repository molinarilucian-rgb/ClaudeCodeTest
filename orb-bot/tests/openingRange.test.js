import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  minutesFromOpen, computeOpeningRange, computeAllOpeningRanges, OpeningRangeTracker,
} from '../src/strategy/openingRange.js';

// Build a minute bar `offset` minutes after the 09:30 ET open on 2026-06-03
// (EDT = UTC-4, so 09:30 ET = 13:30Z). Negative offsets are pre-market.
function bar(offset, h, l, v = 1000) {
  const totalMin = 13 * 60 + 30 + offset; // UTC minutes-from-midnight
  const hh = String(Math.floor(totalMin / 60)).padStart(2, '0');
  const mm = String(((totalMin % 60) + 60) % 60).padStart(2, '0');
  return { t: `2026-06-03T${hh}:${mm}:00Z`, o: (h + l) / 2, h, l, c: (h + l) / 2, v };
}

// Shared dataset with bars straddling all three window boundaries.
const BARS = [
  bar(0, 100, 99),
  bar(1, 101, 98),
  bar(2, 102, 99),
  bar(3, 100, 97),   // lowest low within 5-min
  bar(4, 103, 99),   // highest high within 5-min
  bar(5, 110, 90),   // OUTSIDE 5-min; inside 15/30; marks 5-min complete
  bar(10, 104, 96),
  bar(14, 105, 95),
  bar(15, 120, 80),  // OUTSIDE 15-min; inside 30; marks 15-min complete
  bar(29, 106, 94),
  bar(30, 130, 70),  // OUTSIDE 30-min; marks 30-min complete
];

test('minutesFromOpen measures offset from the 09:30 ET open', () => {
  assert.equal(minutesFromOpen('2026-06-03T13:30:00Z'), 0);
  assert.equal(minutesFromOpen('2026-06-03T13:45:00Z'), 15);
  assert.equal(minutesFromOpen('2026-06-03T13:00:00Z'), -30); // pre-market
});

test('5-min OR uses only bars 09:30–09:35 and excludes the boundary bar', () => {
  const or = computeOpeningRange(BARS, 5);
  assert.equal(or.orHigh, 103);   // NOT 110 (offset-5 bar excluded)
  assert.equal(or.orLow, 97);     // NOT 90
  assert.equal(or.barCount, 5);
  assert.equal(or.orComplete, true);
  assert.equal(or.orCompleteTime, '2026-06-03T13:35:00.000Z');
});

test('15-min OR includes the offset-5 bar but excludes offset-15', () => {
  const or = computeOpeningRange(BARS, 15);
  assert.equal(or.orHigh, 110);  // offset-5 high included; offset-15 (120) excluded
  assert.equal(or.orLow, 90);
  assert.equal(or.barCount, 8);
  assert.equal(or.orComplete, true);
  assert.equal(or.orCompleteTime, '2026-06-03T13:45:00.000Z');
});

test('30-min OR spans 09:30–10:00 and excludes offset-30', () => {
  const or = computeOpeningRange(BARS, 30);
  assert.equal(or.orHigh, 120);  // offset-15 included; offset-30 (130) excluded
  assert.equal(or.orLow, 80);
  assert.equal(or.barCount, 10);
  assert.equal(or.orComplete, true);
  assert.equal(or.orCompleteTime, '2026-06-03T14:00:00.000Z');
});

test('computeAllOpeningRanges returns all three configured timeframes', () => {
  const all = computeAllOpeningRanges(BARS);
  assert.deepEqual(Object.keys(all).map(Number), [5, 15, 30]);
  assert.equal(all[5].orHigh, 103);
  assert.equal(all[15].orHigh, 110);
  assert.equal(all[30].orHigh, 120);
});

test('pre-market bars are ignored', () => {
  const withPremarket = [bar(-5, 999, 1), ...BARS];
  const or = computeOpeningRange(withPremarket, 5);
  assert.equal(or.orHigh, 103); // pre-market 999 excluded
  assert.equal(or.orLow, 97);   // pre-market 1 excluded
});

test('incomplete window: no bar past the window end → not complete', () => {
  const partial = [bar(0, 100, 99), bar(1, 101, 98), bar(2, 102, 100)];
  const or = computeOpeningRange(partial, 5);
  assert.equal(or.orHigh, 102);
  assert.equal(or.orLow, 98);
  assert.equal(or.orComplete, false);     // window 09:35 not yet observed
  assert.equal(or.orCompleteTime, null);
});

test('missing minutes (gaps) still produce a valid range', () => {
  const gappy = [bar(0, 100, 99), bar(2, 105, 95), bar(4, 101, 98), bar(7, 110, 90)];
  const or = computeOpeningRange(gappy, 5);
  assert.equal(or.orHigh, 105); // from the bars that exist (0,2,4)
  assert.equal(or.orLow, 95);
  assert.equal(or.barCount, 3);
  assert.equal(or.orComplete, true); // offset-7 bar proves window elapsed
});

test('empty input yields an empty, incomplete state', () => {
  const or = computeOpeningRange([], 5);
  assert.equal(or.orHigh, null);
  assert.equal(or.orLow, null);
  assert.equal(or.barCount, 0);
  assert.equal(or.orComplete, false);
});

test('OpeningRangeTracker builds ranges incrementally and completes by boundary bar', () => {
  const t = new OpeningRangeTracker('AAPL');
  for (const b of [bar(0, 100, 99), bar(1, 101, 98), bar(2, 102, 99), bar(3, 100, 97), bar(4, 103, 99)]) {
    t.addBar(b);
  }
  // window not yet closed — no bar at/after offset 5
  assert.equal(t.getState(5).orComplete, false);
  assert.equal(t.getState(5).orHigh, 103);
  assert.equal(t.getState(5).orLow, 97);

  t.addBar(bar(5, 110, 90)); // boundary bar closes the 5-min window
  assert.equal(t.getState(5).orComplete, true);
  assert.equal(t.getState(5).orHigh, 103);  // boundary bar NOT added to range
  assert.equal(t.getState(15).orHigh, 110); // but it IS in the 15-min range
  assert.equal(t.getState(15).orComplete, false);
});

test('OpeningRangeTracker.finalizeDue completes windows by time without a later bar', () => {
  const t = new OpeningRangeTracker('AAPL');
  // All bars sit inside the 5-min window, so addBar never auto-completes —
  // isolating the time-based finalize path.
  for (const b of [bar(0, 100, 99), bar(2, 102, 97), bar(4, 105, 95)]) t.addBar(b);
  assert.equal(t.getState(5).orComplete, false);
  assert.equal(t.getState(15).orComplete, false);

  t.finalizeDue('2026-06-03T13:50:00Z'); // 20 min after open
  assert.equal(t.getState(5).orComplete, true);   // 5-min window long past
  assert.equal(t.getState(15).orComplete, true);  // 15-min past (20 >= 15)
  assert.equal(t.getState(30).orComplete, false); // 30-min not yet (20 < 30)
  // Range values come only from the in-window bars.
  assert.equal(t.getState(5).orHigh, 105);
  assert.equal(t.getState(5).orLow, 95);
});

test('OpeningRangeTracker ignores pre-market bars', () => {
  const t = new OpeningRangeTracker('AAPL');
  t.addBar(bar(-10, 999, 1));
  assert.equal(t.getState(5).barCount, 0);
  assert.equal(t.getState(5).orHigh, null);
});
