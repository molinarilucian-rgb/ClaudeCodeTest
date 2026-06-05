/**
 * Diagnostic: dump today's watchlist_history rows from the SQLite DB.
 *
 *   node scripts/dump-watchlist.js            # today (ET)
 *   node scripts/dump-watchlist.js 2026-06-04 # a specific ET date
 *
 * Resolves the DB at $ORB_DB_PATH, else <project>/data/orb.db — which on Railway
 * (service root = orb-bot) is /app/data/orb.db. Read-only; safe to run anytime.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.ORB_DB_PATH || join(scriptDir, '..', 'data', 'orb.db');

// ET calendar date without pulling in config (so it runs without API creds).
function etDate(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const get = (t) => p.find((x) => x.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const date = process.argv[2] || etDate();

console.log(`\nDB:   ${DB_PATH}`);
console.log(`Date: ${date} (ET)\n`);

if (!existsSync(DB_PATH)) {
  console.error(`❌ Database file not found at ${DB_PATH}`);
  console.error('   On Railway the DB is on the ephemeral container disk and is empty');
  console.error('   until the bot has run a scan today. Run the 09:00 scan first, or');
  console.error('   `node src/bot.js --run final` to populate it.');
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH, { readOnly: true });

// Which of the requested columns actually exist in the schema?
const cols = new Set(db.prepare('PRAGMA table_info(watchlist_history)').all().map((c) => c.name));
const requested = ['symbol', 'prev_close', 'pre_market_price', 'gap_pct', 'pm_volume'];
const missing = requested.filter((c) => !cols.has(c));

const rows = db.prepare(
  'SELECT * FROM watchlist_history WHERE date = ? ORDER BY selected DESC, rank_score DESC'
).all(date);

if (rows.length === 0) {
  console.log('No watchlist_history rows for that date.');
  const dates = db.prepare(
    'SELECT DISTINCT date FROM watchlist_history ORDER BY date DESC LIMIT 10'
  ).all().map((r) => r.date);
  if (dates.length) console.log(`Dates present in the DB: ${dates.join(', ')}`);
  process.exit(0);
}

// Print the columns that exist (the schema has no prev_close / pre_market_price /
// per-value fetch timestamps — only one created_at per row).
const px = (v) => (v == null ? null : Number(v).toFixed(2));
console.table(rows.map((r) => ({
  symbol: r.symbol,
  prev_close: px(r.prev_close),
  pre_market_price: px(r.pre_market_price),
  gap_pct: r.gap_pct != null ? Number(r.gap_pct).toFixed(2) : null,
  pm_volume: r.pm_volume,
  fetched_at: r.fetched_at, // when the snapshot was pulled (UTC)
  selected: r.selected ? '★' : '',
  catalyst: r.catalyst_type,
  created_at: r.created_at, // when the row was written (UTC)
})));

console.log(`\n${rows.length} row(s); ${rows.filter((r) => r.selected).length} selected (★).`);

if (missing.length) {
  console.log('\n⚠️  Requested columns NOT stored in watchlist_history:');
  for (const c of missing) console.log(`      • ${c}`);
  console.log('   The gap scanner computes prev_close and the pre-market price but');
  console.log('   only persists the derived gap_pct. There are no per-value fetch');
  console.log('   timestamps — just one `created_at` for the whole row (shown above).');
  console.log('   Ask to extend the schema if you want those captured each scan.');
}
