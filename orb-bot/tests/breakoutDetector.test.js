import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOpeningRange } from '../src/strategy/openingRange.js';
import { detectBreakout } from '../src/strategy/breakoutDetector.js';

// Minute bar `offset` minutes after the 09:30 ET open on 2026-06-03 (EDT).
function bar(offset, h, l, c, v = 1000) {
  const totalMin = 13 * 60 + 30 + offset;
  const hh = String(Math.floor(totalMin / 60)).padStart(2, '0');
  const mm = String(((totalMin % 60) + 60) % 60).padStart(2, '0');
  return { t: `2026-06-03T${hh}:${mm}:00Z`, o: (h + l) / 2, h, l, c, v };
}

// A clean LONG setup: OR high 100 / low 99, breakout candle closes 101.5 on 5× vol.
function longBars() {
  return [
    bar(0, 100, 99, 99.5), bar(1, 100, 99, 99.5), bar(2, 100, 99, 99.5),
    bar(3, 100, 99, 99.5), bar(4, 100, 99, 99.5),
    bar(5, 99.8, 99.2, 99.6),
    bar(6, 102, 99.8, 101.5, 5000), // breakout
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
  assert.equal(sig.triggered, true);
  assert.equal(sig.orHigh, 100);
  assert.equal(sig.entryPrice, 101.5);
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
  ];
  const sig = detectBreakout({
    symbol: 'TST', timeframe: 5, orState: computeOpeningRange(bars, 5),
    sessionBars: bars, gapPct: -2,
  });
  assert.equal(sig.direction, 'short');
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

test('fails when breakout candle does not CLOSE beyond the OR', () => {
  const bars = [...longBars().slice(0, 6), bar(6, 102, 99.8, 99.9, 5000)]; // wick over, close back inside
  const sig = detectLong(bars);
  assert.equal(sig.confirmations.priceBreak, true);
  assert.equal(sig.confirmations.candleClose, false);
  assert.equal(sig.triggered, false);
});

test('fails on insufficient volume surge', () => {
  const bars = [...longBars().slice(0, 6), bar(6, 102, 99.8, 101.5, 1000)]; // 1× vol
  const sig = detectLong(bars);
  assert.equal(sig.confirmations.volumeSurge, false);
  assert.equal(sig.triggered, false);
});

test('fails when gap is not aligned with direction', () => {
  const sig = detectLong(longBars(), 0); // no gap
  assert.equal(sig.confirmations.gapAligned, false);
  assert.equal(sig.triggered, false);
});

test('fails when price is on the wrong side of VWAP', () => {
  // Insert a high-price, high-volume bar AFTER the OR window to drag VWAP above
  // the breakout close, without affecting the 5-min OR (offsets 0–4).
  const bars = [
    bar(0, 100, 99, 99.5), bar(1, 100, 99, 99.5), bar(2, 100, 99, 99.5),
    bar(3, 100, 99, 99.5), bar(4, 100, 99, 99.5),
    bar(5, 300, 300, 300, 100000), // huge VWAP drag, outside OR
    bar(6, 102, 99.8, 101.5, 200000),
  ];
  const sig = detectBreakout({
    symbol: 'TST', timeframe: 5, orState: computeOpeningRange(bars, 5),
    sessionBars: bars, gapPct: 2,
  });
  assert.equal(sig.confirmations.priceBreak, true);
  assert.equal(sig.confirmations.vwapAligned, false); // VWAP (~166) above close 101.5
  assert.equal(sig.triggered, false);
});

test('fails after the 11:00 ET entry cutoff', () => {
  // breakout candle at offset 95 (10:65 → past 11:00)
  const bars = [
    bar(0, 100, 99, 99.5), bar(1, 100, 99, 99.5), bar(2, 100, 99, 99.5),
    bar(3, 100, 99, 99.5), bar(4, 100, 99, 99.5),
    bar(95, 102, 99.8, 101.5, 5000),
  ];
  const sig = detectBreakout({
    symbol: 'TST', timeframe: 5, orState: computeOpeningRange(bars, 5),
    sessionBars: bars, gapPct: 2,
  });
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
