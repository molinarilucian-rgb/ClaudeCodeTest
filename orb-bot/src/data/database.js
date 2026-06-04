import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';
import logger from '../utils/logger.js';

/**
 * SQLite persistence via Node's built-in node:sqlite (no native deps).
 * Schema follows the spec's "Database Schema" section, extended with catalyst
 * columns so each watchlist pick and each trade carries its classified gap
 * catalyst for later analysis.
 */

const __dir = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dir, '..', '..', 'data');
mkdirSync(dataDir, { recursive: true });
const DB_PATH = process.env.ORB_DB_PATH || join(dataDir, 'orb.db');

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS watchlist_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  date            TEXT NOT NULL,
  symbol          TEXT NOT NULL,
  gap_pct         REAL,
  pm_volume       INTEGER,
  rank_score      REAL,
  selected        INTEGER DEFAULT 0,
  -- catalyst classification (Perplexity)
  catalyst_type     TEXT,
  catalyst_summary  TEXT,
  catalyst_quality  TEXT,
  catalyst_sentiment TEXT,
  catalyst_tradeable INTEGER,
  catalyst_confidence REAL,
  created_at      TEXT DEFAULT (datetime('now')),
  UNIQUE(date, symbol)
);

CREATE TABLE IF NOT EXISTS opening_ranges (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  date            TEXT NOT NULL,
  symbol          TEXT NOT NULL,
  timeframe       INTEGER NOT NULL,
  or_high         REAL,
  or_low          REAL,
  or_complete_time TEXT,
  UNIQUE(date, symbol, timeframe)
);

CREATE TABLE IF NOT EXISTS trades (
  trade_id        TEXT PRIMARY KEY,
  date            TEXT NOT NULL,
  symbol          TEXT NOT NULL,
  or_timeframe    INTEGER,
  rr_ratio        REAL,
  direction       TEXT,
  entry_time      TEXT,
  entry_price     REAL,
  stop_price      REAL,
  target_price    REAL,
  shares          INTEGER,
  exit_time       TEXT,
  exit_price      REAL,
  exit_reason     TEXT,
  pnl             REAL,
  pnl_pct         REAL,
  risk_amount     REAL,
  r_multiple      REAL,
  -- catalyst carried over from the watchlist pick for analysis
  catalyst_type     TEXT,
  catalyst_quality  TEXT,
  catalyst_sentiment TEXT,
  opening_range_id INTEGER REFERENCES opening_ranges(id)
);

CREATE TABLE IF NOT EXISTS daily_performance (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  date            TEXT NOT NULL,
  strategy_variation TEXT NOT NULL,
  trades_count    INTEGER,
  wins            INTEGER,
  losses          INTEGER,
  win_rate        REAL,
  total_pnl       REAL,
  profit_factor   REAL,
  UNIQUE(date, strategy_variation)
);

CREATE INDEX IF NOT EXISTS idx_trades_catalyst ON trades(catalyst_type, catalyst_quality);
CREATE INDEX IF NOT EXISTS idx_watchlist_date ON watchlist_history(date);
`);

logger.info(`Database ready at ${DB_PATH}`);

/** Upsert a watchlist entry (with catalyst) for a given date. */
export function saveWatchlistEntry(date, entry) {
  const stmt = db.prepare(`
    INSERT INTO watchlist_history
      (date, symbol, gap_pct, pm_volume, rank_score, selected,
       catalyst_type, catalyst_summary, catalyst_quality,
       catalyst_sentiment, catalyst_tradeable, catalyst_confidence)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(date, symbol) DO UPDATE SET
      gap_pct=excluded.gap_pct, pm_volume=excluded.pm_volume,
      rank_score=excluded.rank_score, selected=excluded.selected,
      catalyst_type=excluded.catalyst_type, catalyst_summary=excluded.catalyst_summary,
      catalyst_quality=excluded.catalyst_quality, catalyst_sentiment=excluded.catalyst_sentiment,
      catalyst_tradeable=excluded.catalyst_tradeable, catalyst_confidence=excluded.catalyst_confidence
  `);
  const c = entry.catalyst || {};
  stmt.run(
    date, entry.symbol, entry.gapPct ?? null, entry.preMarketVolume ?? null,
    entry.rankScore ?? null, entry.selected ? 1 : 0,
    c.catalyst_type ?? null, c.catalyst_summary ?? null, c.quality ?? null,
    c.sentiment ?? null, c.tradeable ? 1 : 0, c.confidence ?? null
  );
}

/** Fetch a saved watchlist entry (used by Phase 3 to attach catalyst to trades). */
export function getWatchlistEntry(date, symbol) {
  return db.prepare('SELECT * FROM watchlist_history WHERE date=? AND symbol=?').get(date, symbol);
}

/** All watchlist rows for a date. */
export function getWatchlist(date) {
  return db.prepare('SELECT * FROM watchlist_history WHERE date=? ORDER BY rank_score DESC').all(date);
}

/** Upsert an opening range; returns the row id (for trade foreign keys). */
export function saveOpeningRange(date, symbol, timeframe, orHigh, orLow, orCompleteTime) {
  db.prepare(`
    INSERT INTO opening_ranges (date, symbol, timeframe, or_high, or_low, or_complete_time)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(date, symbol, timeframe) DO UPDATE SET
      or_high=excluded.or_high, or_low=excluded.or_low,
      or_complete_time=excluded.or_complete_time
  `).run(date, symbol, timeframe, orHigh ?? null, orLow ?? null, orCompleteTime ?? null);
  return db.prepare(
    'SELECT id FROM opening_ranges WHERE date=? AND symbol=? AND timeframe=?'
  ).get(date, symbol, timeframe).id;
}

/** Fetch a stored opening range. */
export function getOpeningRange(date, symbol, timeframe) {
  return db.prepare(
    'SELECT * FROM opening_ranges WHERE date=? AND symbol=? AND timeframe=?'
  ).get(date, symbol, timeframe);
}

/** Insert a completed trade record, copying catalyst from its watchlist pick. */
export function saveTrade(trade) {
  const wl = getWatchlistEntry(trade.date, trade.symbol) || {};
  const stmt = db.prepare(`
    INSERT INTO trades
      (trade_id, date, symbol, or_timeframe, rr_ratio, direction, entry_time,
       entry_price, stop_price, target_price, shares, exit_time, exit_price,
       exit_reason, pnl, pnl_pct, risk_amount, r_multiple,
       catalyst_type, catalyst_quality, catalyst_sentiment, opening_range_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  stmt.run(
    trade.tradeId, trade.date, trade.symbol, trade.orTimeframe, trade.rrRatio,
    trade.direction, trade.entryTime, trade.entryPrice, trade.stopPrice,
    trade.targetPrice, trade.shares, trade.exitTime ?? null, trade.exitPrice ?? null,
    trade.exitReason ?? null, trade.pnl ?? null, trade.pnlPct ?? null,
    trade.riskAmount ?? null, trade.rMultiple ?? null,
    wl.catalyst_type ?? null, wl.catalyst_quality ?? null, wl.catalyst_sentiment ?? null,
    trade.openingRangeId ?? null
  );
}

export default {
  db, saveWatchlistEntry, getWatchlistEntry, getWatchlist,
  saveOpeningRange, getOpeningRange, saveTrade,
};
