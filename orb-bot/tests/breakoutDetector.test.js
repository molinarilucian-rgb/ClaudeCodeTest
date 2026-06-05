import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOpeningRange } from '../src/strategy/openingRange.js';
import { detectBreakout, scoreSignal } from '../src/strategy/breakoutDetector.js';

// Minute bar `offset` minutes after the 09:30 ET open on 2026-06-03 (EDT).
function bar(offset, h, l, c, v = 1000) {
  const totalMin = 13 * 60 + 30 + offset;
  const hh = String(Math.floor(totalMin / 60)).padStart(2, '0');
  const mm = String(((totalMin % 60) + 60) % 60).padStart(2, '0');
  return { t: `2026-06-03T${hh}:${mm}:00Z`, o: (h + l) / 2, h, l, c, v };
}

// A clean LONG setup: OR high 100 / low 99, breakout candle closes 101.5 on 5× vol,
// and the NEXT candle also closes beyond (so the false-breakout filter confirms).
function longBars() {
  return [
    bar(0, 100, 99, 99.5), bar(1, 100, 99, 99.5), bar(2, 100, 99, 99.5),
    bar(3, 100, 99, 99.5), bar(4, 100, 99, 99.5),
    bar(5, 99.8, 99.2, 99.6),
    bar(6, 102, 99.8, 101.5, 5000), // breakout candle (closes > OR high 100)
    bar(7, 102, 100.5, 101.8, 5000), // confirmation candle (also closes beyond)
  ];
}

function detectLong(bars, gapPct = 2) {
  return detectBreakout({
    symbol: 'TST', timeframe: 5,
    orState: computeOpeningRange(bars, 5),
    sessionBars: bars, gapPct,
  });
}

test('valid LONG breakout triggers with all confirmations', () => {
  const sig = detectLong(longBars());
  assert.equal(sig.direction, 'long');
  assert.equal(sig.confirmation, 'confirmed');
  assert.equal(sig.triggered, true);
  assert.equal(sig.orHigh, 100);
  assert.equal(sig.entryPrice, 101.5); // breakout candle close, not the confirmation
  for (const [k, v] of Object.entries(sig.confirmations)) {
    assert.equal(v, true, `confirmation ${k} should pass`);
  }
  // stop at OR low minus buffer; risk and targets derived
  assert.ok(sig.stopPrice < 99);
  assert.equal(sig.targets.length, 3);
  assert.ok(sig.targets[2].price > sig.targets[0].price); // 1:2 above 1:1
});

test('valid SHORT breakout triggers with all confirmations', () => {
  const bars = [
    bar(0, 101, 100, 100.5), bar(1, 101, 100, 100.5), bar(2, 101, 100, 100.5),
    bar(3, 101, 100, 100.5), bar(4, 101, 100, 100.5),
    bar(6, 100.2, 98, 98.5, 5000), // breakout below OR low 100
    bar(7, 100.2, 98, 98.3, 5000), // confirmation (also closes below)
  ];
  const sig = detectBreakout({
    symbol: 'TST', timeframe: 5, orState: computeOpeningRange(bars, 5),
    sessionBars: bars, gapPct: -2,
  });
  assert.equal(sig.direction, 'short');
  assert.equal(sig.confirmation, 'confirmed');
  assert.equal(sig.triggered, true);
  assert.equal(sig.orLow, 100);
  assert.ok(sig.stopPrice > 101); // stop above OR high + buffer
});

test('no break inside the range returns null', () => {
  const bars = [...longBars().slice(0, 6), bar(6, 99.9, 99.1, 99.5)];
  assert.equal(detectLong(bars), null);
});

test('OR not yet complete returns null', () => {
  // only bars within the 5-min window → not complete
  const bars = [bar(0, 100, 99, 99.5), bar(1, 102, 99, 101.5, 5000)];
  assert.equal(detectLong(bars), null);
});

test('breakout candle inside the OR window returns null', () => {
  // last bar at offset 4 (< timeframe 5) even though it breaks
  const bars = [bar(0, 100, 99, 99.5), bar(1, 100, 99, 99.5), bar(2, 100, 99, 99.5),
    bar(3, 100, 99, 99.5), bar(4, 102, 99, 101.5, 5000)];
  assert.equal(detectLong(bars), null);
});

test('a wick that breaks but closes back inside is not a breakout (null)', () => {
  // close-based detection: a candle that only wicks over the OR isn't a breakout
  const bars = [...longBars().slice(0, 6), bar(6, 102, 99.8, 99.9, 5000)];
  assert.equal(detectLong(bars), null);
});

test('fails on insufficient volume surge', () => {
  const bars = [...longBars().slice(0, 6),
    bar(6, 102, 99.8, 101.5, 1000),   // breakout on only 1× vol
    bar(7, 102, 100.5, 101.8, 1000)]; // confirmation (isolates the volume failure)
  const sig = detectLong(bars);
  assert.equal(sig.confirmation, 'confirmed');
  assert.equal(sig.confirmations.volumeSurge, false);
  assert.equal(sig.triggered, false);
});

test('fails when gap is not aligned with direction', () => {
  const sig = detectLong(longBars(), 0); // no gap
  assert.equal(sig.confirmations.gapAligned, false);
  assert.equal(sig.triggered, false);
});

test('fails when price is on the wrong side of VWAP', () => {
  // A high-price, high-volume bar INSIDE the OR window (offset 4) drags session
  // VWAP above the breakout close without being a breakout candidate itself.
  // OR levels passed explicitly so that bar doesn't redefine the range.
  const orState = { timeframe: 5, orHigh: 100, orLow: 99, orComplete: true, orCompleteTime: 'x', barCount: 5 };
  const bars = [
    bar(0, 100, 99, 99.5, 1000), bar(1, 100, 99, 99.5, 1000), bar(2, 100, 99, 99.5, 1000),
    bar(3, 100, 99, 99.5, 1000), bar(4, 300, 300, 300, 100000), // VWAP drag, still in OR window
    bar(5, 102, 99.8, 101.5, 200000), // breakout
    bar(6, 102, 100.5, 101.8, 200000), // confirmation
  ];
  const sig = detectBreakout({ symbol: 'TST', timeframe: 5, orState, sessionBars: bars, gapPct: 2 });
  assert.equal(sig.confirmation, 'confirmed');
  assert.equal(sig.confirmations.volumeSurge, true);   // isolate VWAP as the failure
  assert.equal(sig.confirmations.vwapAligned, false);  // VWAP dragged well above close
  assert.equal(sig.triggered, false);
});

test('fails after the 11:00 ET entry cutoff', () => {
  // breakout + confirmation past 11:00 ET (offsets 95/96)
  const bars = [
    bar(0, 100, 99, 99.5), bar(1, 100, 99, 99.5), bar(2, 100, 99, 99.5),
    bar(3, 100, 99, 99.5), bar(4, 100, 99, 99.5),
    bar(95, 102, 99.8, 101.5, 5000),
    bar(96, 102, 100.5, 101.8, 5000),
  ];
  const sig = detectBreakout({
    symbol: 'TST', timeframe: 5, orState: computeOpeningRange(bars, 5),
    sessionBars: bars, gapPct: 2,
  });
  assert.equal(sig.confirmation, 'confirmed');
  assert.equal(sig.confirmations.beforeCutoff, false);
  assert.equal(sig.triggered, false);
});

test('hasPosition suppresses the signal via noPosition check', () => {
  const sig = detectBreakout({
    symbol: 'TST', timeframe: 5, orState: computeOpeningRange(longBars(), 5),
    sessionBars: longBars(), gapPct: 2, hasPosition: true,
  });
  assert.equal(sig.confirmations.noPosition, false);
  assert.equal(sig.triggered, false);
});

// ---- False-breakout (confirmation candle) filter ----

test('pending: breakout with no confirmation candle yet does not trigger', () => {
  const bars = longBars().slice(0, 7); // breakout at offset 6, no offset-7 candle yet
  const sig = detectLong(bars);
  assert.equal(sig.confirmation, 'pending');
  assert.equal(sig.confirmations.confirmationCandle, false);
  assert.equal(sig.failedBreakout, false);
  assert.equal(sig.triggered, false);
});

test('failed breakout: next candle closes back inside the OR', () => {
  const bars = [...longBars().slice(0, 7), bar(7, 101, 99.5, 99.8, 5000)]; // closes 99.8 < OR high
  const sig = detectLong(bars);
  assert.equal(sig.confirmation, 'failed');
  assert.equal(sig.failedBreakout, true);
  assert.equal(sig.confirmations.confirmationCandle, false);
  assert.equal(sig.triggered, false); // never counts as a valid signal
});

test('confirmed breakout: next candle also closes beyond → confirmationCandle passes', () => {
  const sig = detectLong(longBars());
  assert.equal(sig.confirmation, 'confirmed');
  assert.equal(sig.confirmations.confirmationCandle, true);
  assert.equal(sig.failedBreakout, false);
  assert.equal(sig.triggered, true);
});

// ---- Signal quality score ----

test('every signal carries a quality score, grade, and breakdown', () => {
  const sig = detectLong(longBars());
  assert.equal(typeof sig.qualityScore, 'number');
  assert.ok(sig.qualityScore >= 1 && sig.qualityScore <= 10);
  assert.ok(['A+', 'A', 'B', 'C', 'D'].includes(sig.qualityGrade));
  for (const k of ['volume', 'gap', 'close', 'vwap']) {
    assert.ok(sig.scoreBreakdown[k] >= 0 && sig.scoreBreakdown[k] <= 10, `${k} in 0..10`);
  }
});

test('scoreSignal stays within 1..10 even at extremes', () => {
  const hi = scoreSignal({ direction: 'long', volumeRatio: 99, gapPct: 50, entryPrice: 200, orHigh: 100, orLow: 90, vwap: 50 });
  assert.ok(hi.score <= 10);
  const lo = scoreSignal({ direction: 'long', volumeRatio: 0, gapPct: 0, entryPrice: 100.0001, orHigh: 100, orLow: 99, vwap: 100 });
  assert.ok(lo.score >= 1);
});

test('quality score is monotonic in volume ratio (more volume → higher)', () => {
  const base = { direction: 'long', gapPct: 2, entryPrice: 101.5, orHigh: 100, orLow: 99, vwap: 100 };
  const weak = scoreSignal({ ...base, volumeRatio: 1.5 });
  const strong = scoreSignal({ ...base, volumeRatio: 4 });
  assert.ok(strong.breakdown.volume > weak.breakdown.volume);
  assert.ok(strong.score > weak.score);
});

test('A+ setup scores higher than a mediocre one', () => {
  // Strong: huge volume, big gap, closes well beyond OR, far above VWAP
  const aplus = scoreSignal({ direction: 'long', volumeRatio: 4, gapPct: 5, entryPrice: 102, orHigh: 100, orLow: 99, vwap: 99.5 });
  // Mediocre: just-barely volume, tiny gap, scrapes over OR, barely above VWAP
  const meh = scoreSignal({ direction: 'long', volumeRatio: 1.5, gapPct: 1, entryPrice: 100.05, orHigh: 100, orLow: 99, vwap: 100.0 });
  assert.ok(aplus.score > meh.score);
  assert.ok(aplus.score >= 8, `expected A-grade, got ${aplus.score}`);
});
