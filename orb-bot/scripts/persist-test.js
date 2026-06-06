/**
 * Persistence marker test — write a timestamped row, redeploy, then read it
 * back to confirm the DB survived (i.e. a Railway volume is working).
 *
 *   node scripts/persist-test.js write   # insert a marker, print "WROTE: <ts>"
 *   node scripts/persist-test.js read    # list markers oldest first, "FOUND N ROWS"
 *
 * Resolves the DB the same way the app does: $ORB_DB_PATH, else a mounted
 * Railway volume ($RAILWAY_VOLUME_MOUNT_PATH), else <project>/data/orb.db.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || join(scriptDir, '..', 'data');
const DB_PATH = process.env.ORB_DB_PATH || join(defaultDir, 'orb.db');

const mode = process.argv[2];
if (mode !== 'write' && mode !== 'read') {
  console.error('Usage: node scripts/persist-test.js <write|read>');
  process.exit(1);
}

console.log(`DB: ${DB_PATH}`);

if (mode === 'write') {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`CREATE TABLE IF NOT EXISTS persist_test (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL
  )`);
  const ts = new Date().toISOString();
  db.prepare('INSERT INTO persist_test (ts) VALUES (?)').run(ts);
  console.log(`WROTE: ${ts}`);
  process.exit(0);
}

// mode === 'read'
if (!existsSync(DB_PATH)) {
  console.log('FOUND 0 ROWS (database file does not exist yet)');
  process.exit(0);
}
const db = new DatabaseSync(DB_PATH, { readOnly: true });
const tableExists = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='persist_test'"
).get();
if (!tableExists) {
  console.log('FOUND 0 ROWS (persist_test table does not exist — run `write` first)');
  process.exit(0);
}
const rows = db.prepare('SELECT id, ts FROM persist_test ORDER BY id ASC').all();
console.log(`FOUND ${rows.length} ROWS`);
for (const r of rows) console.log(`  ${r.ts}`);
