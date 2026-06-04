/**
 * Phase 1 test runner — foundation + Perplexity integration.
 * Runs the offline unit tests covering indicators, time/holiday logic,
 * the Perplexity catalyst classifier, and the SQLite layer.
 *
 *   node src/test-phase1.js          (unit tests only)
 *   node src/test-phase1.js --smoke  (also hit the real Alpaca + Perplexity APIs)
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'tests/indicators.test.js',
  'tests/timeUtils.test.js',
  'tests/perplexity.test.js',
  'tests/database.test.js',
];

console.log('▶ Phase 1 unit tests (indicators, time, Perplexity, database)\n');
let status = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' }).status ?? 1;

if (process.argv.includes('--smoke')) {
  console.log('\n▶ Phase 1 live smoke (real Alpaca + Perplexity APIs)\n');
  const s = spawnSync(process.execPath, ['tests/live-smoke.js'], { cwd: root, stdio: 'inherit' }).status ?? 1;
  status = status || s;
}

process.exit(status);
