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

test('saveWatchlistEntry persists catalyst fields', () => {
  dbmod.saveWatchlistEntry('2026-06-03', {
    symbol: 'AAA', gapPct: 3.1, preMarketVolume: 12345, rankScore: 7.5,
    selected: true, catalyst: sampleCatalyst,
  });
  const row = dbmod.getWatchlistEntry('2026-06-03', 'AAA');
  assert.equal(row.symbol, 'AAA');
  assert.equal(row.gap_pct, 3.1);
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
