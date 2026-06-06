/**
 * Diagnostic: dump watchlist_history from the SQLite DB.
 *
 *   node scripts/dump-watchlist.js            # ALL rows grouped by date, oldest first
 *   node scripts/dump-watchlist.js 2026-06-04 # detailed rows for one ET date
 *
 * The no-argument form shows how many days of history the DB actually contains.
 * Resolves the DB the same way the app does: $ORB_DB_PATH, else a mounted
 * Railway volume ($RAILWAY_VOLUME_MOUNT_PATH), else <project>/data/orb.db.
 * Read-only.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || join(scriptDir, '..', 'data');
const DB_PATH = process.env.ORB_DB_PATH || join(defaultDir, 'orb.db');
const dateArg = process.argv[2];

console.log(`\nDB: ${DB_PATH}\n`);

if (!existsSync(DB_PATH)) {
  console.error(`❌ Database file not found at ${DB_PATH}`);
  console.error('   On Railway the DB is on the ephemeral container disk and is empty');
  console.error('   until the bot has run a scan. Run `node src/bot.js --run final`');
  console.error('   to populate it, or wait for the 09:00 ET scan.');
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const px = (v) => (v == null ? null : Number(v).toFixed(2));

const rowView = (r) => ({
  symbol: r.symbol,
  prev_close: px(r.prev_close),
  pre_market_price: px(r.pre_market_price),
  gap_pct: r.gap_pct != null ? Number(r.gap_pct).toFixed(2) : null,
  pm_volume: r.pm_volume,
  fetched_at: r.fetched_at,
  selected: r.selected ? '★' : '',
  catalyst: r.catalyst_type,
});

// ---- Detailed single-date view (when a date arg is given) ----
if (dateArg) {
  const rows = db.prepare(
    'SELECT * FROM watchlist_history WHERE date = ? ORDER BY selected DESC, rank_score DESC'
  ).all(dateArg);
  console.log(`Date: ${dateArg} (ET)\n`);
  if (rows.length === 0) {
    console.log('No watchlist_history rows for that date.');
    const dates = db.prepare('SELECT DISTINCT date FROM watchlist_history ORDER BY date DESC LIMIT 10')
      .all().map((r) => r.date);
    if (dates.length) console.log(`Dates present in the DB: ${dates.join(', ')}`);
    process.exit(0);
  }
  console.table(rows.map(rowView));
  console.log(`\n${rows.length} row(s); ${rows.filter((r) => r.selected).length} selected (★).`);
  process.exit(0);
}

// ---- All history, grouped by date, oldest first (default) ----
const days = db.prepare(`
  SELECT date, COUNT(*) AS n, SUM(CASE WHEN selected THEN 1 ELSE 0 END) AS sel
  FROM watchlist_history GROUP BY date ORDER BY date ASC
`).all();

if (days.length === 0) {
  console.log('watchlist_history is empty (no scans recorded yet).');
  process.exit(0);
}

const totalRows = days.reduce((a, d) => a + d.n, 0);
console.log(`watchlist_history: ${totalRows} rows across ${days.length} day(s)\n`);

for (const d of days) {
  const rows = db.prepare(
    'SELECT * FROM watchlist_history WHERE date = ? ORDER BY selected DESC, rank_score DESC'
  ).all(d.date);
  console.log(`═══ ${d.date} — ${d.n} rows, ${d.sel || 0} selected ═══`);
  console.table(rows.map(rowView));
}

console.log(`\n${days.length} day(s) of history: ${days[0].date} → ${days[days.length - 1].date}`);
console.log('(Railway\'s DB is ephemeral — if you only see one day, a redeploy wiped earlier history.)');
