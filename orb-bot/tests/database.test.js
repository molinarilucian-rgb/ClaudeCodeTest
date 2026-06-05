import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

// Point the DB module at a throwaway file BEFORE importing it.
const TMP_DB = join(tmpdir(), `orb-test-${process.pid}-${Date.now()}.db`);
process.env.ORB_DB_PATH = TMP_DB;

let dbmod;
before(async () => { dbmod = await import('../src/data/database.js'); });
after(() => {
  for (const ext of ['', '-wal', '-shm']) {
    try { rmSync(TMP_DB + ext); } catch { /* ignore */ }
  }
});

const sampleCatalyst = {
  catalyst_type: 'earnings',
  catalyst_summary: 'Beat estimates',
  quality: 'high',
  sentiment: 'bullish',
  tradeable: true,
  confidence: 0.9,
};

test('saveWatchlistEntry persists catalyst + price/timestamp fields', () => {
  dbmod.saveWatchlistEntry('2026-06-03', {
    symbol: 'AAA', gapPct: 3.1, preMarketVolume: 12345,
    prevClose: 100.25, preMarketPrice: 103.36, fetchedAt: '2026-06-03T11:00:00.000Z',
    rankScore: 7.5, selected: true, catalyst: sampleCatalyst,
  });
  const row = dbmod.getWatchlistEntry('2026-06-03', 'AAA');
  assert.equal(row.symbol, 'AAA');
  assert.equal(row.gap_pct, 3.1);
  assert.equal(row.prev_close, 100.25);
  assert.equal(row.pre_market_price, 103.36);
  assert.equal(row.fetched_at, '2026-06-03T11:00:00.000Z');
  assert.equal(row.catalyst_type, 'earnings');
  assert.equal(row.catalyst_quality, 'high');
  assert.equal(row.catalyst_tradeable, 1); // boolean → int
  assert.equal(row.selected, 1);
});

test('saveWatchlistEntry upserts on (date, symbol) — no duplicates', () => {
  dbmod.saveWatchlistEntry('2026-06-03', {
    symbol: 'BBB', gapPct: 1.0, preMarketVolume: 1, rankScore: 1, selected: false,
    catalyst: { ...sampleCatalyst, quality: 'low' },
  });
  // second write with new values for the same key
  dbmod.saveWatchlistEntry('2026-06-03', {
    symbol: 'BBB', gapPct: 2.0, preMarketVolume: 2, rankScore: 9, selected: true,
    catalyst: { ...sampleCatalyst, quality: 'medium' },
  });
  const rows = dbmod.getWatchlist('2026-06-03').filter((r) => r.symbol === 'BBB');
  assert.equal(rows.length, 1);            // upsert, not insert
  assert.equal(rows[0].gap_pct, 2.0);      // updated
  assert.equal(rows[0].catalyst_quality, 'medium');
  assert.equal(rows[0].selected, 1);
});

test('getWatchlist returns rows ordered by rank_score desc', () => {
  dbmod.saveWatchlistEntry('2026-06-05', { symbol: 'LO', gapPct: 1, preMarketVolume: 1, rankScore: 10, selected: false, catalyst: sampleCatalyst });
  dbmod.saveWatchlistEntry('2026-06-05', { symbol: 'HI', gapPct: 1, preMarketVolume: 1, rankScore: 99, selected: true, catalyst: sampleCatalyst });
  const rows = dbmod.getWatchlist('2026-06-05');
  assert.equal(rows[0].symbol, 'HI'); // highest score first
  assert.equal(rows[1].symbol, 'LO');
});

test('saveOpeningRange upserts and returns a row id', () => {
  const id1 = dbmod.saveOpeningRange('2026-06-03', 'AAA', 5, 103.5, 97.2, '2026-06-03T13:35:00.000Z');
  assert.ok(Number.isInteger(id1));
  const row = dbmod.getOpeningRange('2026-06-03', 'AAA', 5);
  assert.equal(row.or_high, 103.5);
  assert.equal(row.or_low, 97.2);
  assert.equal(row.or_complete_time, '2026-06-03T13:35:00.000Z');

  // upsert: same (date,symbol,timeframe) updates in place, keeps the same id
  const id2 = dbmod.saveOpeningRange('2026-06-03', 'AAA', 5, 104.0, 96.0, '2026-06-03T13:35:00.000Z');
  assert.equal(id2, id1);
  assert.equal(dbmod.getOpeningRange('2026-06-03', 'AAA', 5).or_high, 104.0);

  // different timeframe → distinct row
  const id3 = dbmod.saveOpeningRange('2026-06-03', 'AAA', 15, 110, 90, null);
  assert.notEqual(id3, id1);
});

test('saveSignal persists quality score + breakdown and de-dups', () => {
  const signal = {
    symbol: 'NVDA', timeframe: 15, direction: 'long', time: '2026-06-04T13:50:00Z',
    entryPrice: 223.1, stopPrice: 217.8, gapPct: 3.52, vwap: 220.4, volumeRatio: 4.0,
    qualityScore: 8.4, qualityGrade: 'A',
    scoreBreakdown: { volume: 10, gap: 7, close: 6.4, vwap: 10 },
  };
  dbmod.saveSignal('2026-06-04', signal, { catalyst: 'analyst_rating' });
  const row = dbmod.getSignal('2026-06-04', 'NVDA', 15, 'long');
  assert.equal(row.quality_score, 8.4);
  assert.equal(row.quality_grade, 'A');
  assert.equal(row.score_volume, 10);
  assert.equal(row.score_close, 6.4);
  assert.equal(row.volume_ratio, 4.0);
  assert.equal(row.catalyst_type, 'analyst_rating');

  assert.equal(row.status, 'confirmed'); // default status

  // second save of the same (date,symbol,tf,direction) is ignored (no dup, no throw)
  dbmod.saveSignal('2026-06-04', { ...signal, qualityScore: 1.0 }, {});
  const after = dbmod.db.prepare(
    "SELECT COUNT(*) n FROM signals WHERE date='2026-06-04' AND symbol='NVDA' AND timeframe=15 AND direction='long'"
  ).get();
  assert.equal(after.n, 1);
  assert.equal(dbmod.getSignal('2026-06-04', 'NVDA', 15, 'long').quality_score, 8.4); // unchanged
});

test('saveSignal records a failed breakout with status=failed', () => {
  const failed = {
    symbol: 'TSLA', timeframe: 5, direction: 'long', time: '2026-06-04T13:40:00Z',
    entryPrice: 420, stopPrice: 415, gapPct: 2, vwap: 418, volumeRatio: 2,
    qualityScore: 5.0, qualityGrade: 'C', scoreBreakdown: { volume: 5, gap: 4, close: 6, vwap: 5 },
  };
  dbmod.saveSignal('2026-06-04', failed, { catalyst: 'product_news', status: 'failed' });
  const row = dbmod.getSignal('2026-06-04', 'TSLA', 5, 'long');
  assert.equal(row.status, 'failed');
  // failed breakouts are queryable separately from valid signals
  const failedCount = dbmod.db.prepare(
    "SELECT COUNT(*) n FROM signals WHERE date='2026-06-04' AND status='failed'"
  ).get();
  assert.equal(failedCount.n, 1);
});

test('saveTrade copies catalyst from the day\'s watchlist pick', () => {
  dbmod.saveWatchlistEntry('2026-06-04', {
    symbol: 'CCC', gapPct: 4, preMarketVolume: 999, rankScore: 5, selected: true,
    catalyst: { ...sampleCatalyst, catalyst_type: 'mna', quality: 'high', sentiment: 'bullish' },
  });
  dbmod.saveTrade({
    tradeId: 'trade-1', date: '2026-06-04', symbol: 'CCC', orTimeframe: 15,
    rrRatio: 1.5, direction: 'long', entryTime: 't0', entryPrice: 100,
    stopPrice: 98, targetPrice: 103, shares: 50,
  });
  const row = dbmod.db.prepare('SELECT * FROM trades WHERE trade_id=?').get('trade-1');
  assert.equal(row.symbol, 'CCC');
  assert.equal(row.catalyst_type, 'mna');       // copied from watchlist
  assert.equal(row.catalyst_quality, 'high');
  assert.equal(row.catalyst_sentiment, 'bullish');
});

test('saveTrade does not throw when no watchlist pick exists', () => {
  assert.doesNotThrow(() => {
    dbmod.saveTrade({
      tradeId: 'trade-orphan', date: '2099-01-01', symbol: 'ZZZ', orTimeframe: 5,
      rrRatio: 1.0, direction: 'short', entryTime: 't0', entryPrice: 10,
      stopPrice: 11, targetPrice: 9, shares: 10,
    });
  });
  const row = dbmod.db.prepare('SELECT * FROM trades WHERE trade_id=?').get('trade-orphan');
  assert.equal(row.catalyst_type, null); // no pick → null catalyst, still inserts
});
