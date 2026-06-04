import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toEt, etDateStr, etTimeStr, isWeekend, isHoliday, isTradingDay, isMarketHours,
} from '../src/utils/timeUtils.js';

// All inputs are explicit UTC instants so tests are deterministic regardless of
// the machine's local timezone. ET in June is EDT (UTC-4).

test('toEt / etDateStr convert UTC to the ET calendar day', () => {
  // 01:00Z on Jun 4 is 21:00 EDT on Jun 3
  assert.equal(etDateStr('2026-06-04T01:00:00Z'), '2026-06-03');
  // 13:00Z on Jun 3 is 09:00 EDT on Jun 3
  assert.equal(etDateStr('2026-06-03T13:00:00Z'), '2026-06-03');
});

test('etTimeStr formats ET wall-clock time', () => {
  assert.equal(etTimeStr('2026-06-03T13:30:00Z'), '09:30'); // EDT open
  assert.equal(etTimeStr('2026-06-03T20:00:00Z'), '16:00'); // EDT close
});

test('isWeekend detects Saturday and Sunday in ET', () => {
  assert.equal(isWeekend('2026-06-06T16:00:00Z'), true);  // Saturday
  assert.equal(isWeekend('2026-06-07T16:00:00Z'), true);  // Sunday
  assert.equal(isWeekend('2026-06-05T16:00:00Z'), false); // Friday
});

test('isWeekend respects ET boundary, not UTC', () => {
  // Sat 03:00Z = Fri 23:00 EDT → still a weekday in ET
  assert.equal(isWeekend('2026-06-06T03:00:00Z'), false);
});

test('isHoliday matches the NYSE holiday calendar', () => {
  assert.equal(isHoliday('2026-12-25T17:00:00Z'), true);  // Christmas
  assert.equal(isHoliday('2026-01-01T17:00:00Z'), true);  // New Year
  assert.equal(isHoliday('2026-06-19T17:00:00Z'), true);  // Juneteenth
  assert.equal(isHoliday('2026-06-03T17:00:00Z'), false); // normal Wed
});

test('isTradingDay is false on weekends and holidays', () => {
  assert.equal(isTradingDay('2026-06-03T17:00:00Z'), true);  // Wed
  assert.equal(isTradingDay('2026-06-06T17:00:00Z'), false); // Sat
  assert.equal(isTradingDay('2026-12-25T17:00:00Z'), false); // holiday
});

test('isMarketHours brackets the 09:30–16:00 ET session', () => {
  assert.equal(isMarketHours('2026-06-03T13:29:00Z'), false); // 09:29 ET pre-open
  assert.equal(isMarketHours('2026-06-03T13:30:00Z'), true);  // 09:30 ET open
  assert.equal(isMarketHours('2026-06-03T18:00:00Z'), true);  // 14:00 ET
  assert.equal(isMarketHours('2026-06-03T20:00:00Z'), false); // 16:00 ET close (exclusive)
  assert.equal(isMarketHours('2026-06-03T11:00:00Z'), false); // 07:00 ET pre-market
});

test('isMarketHours is false on a non-trading day even at midday', () => {
  assert.equal(isMarketHours('2026-06-06T17:00:00Z'), false); // Saturday 13:00 ET
});
