/**
 * Phase 2 test runner — strategy logic.
 * Runs the offline unit tests for the opening-range module (all 3 timeframes,
 * window boundaries, gaps, live tracker) and its database persistence.
 *
 *   node src/test-phase2.js          (unit tests only)
 *   node src/test-phase2.js --demo   (also compute ORs on a recent live session)
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'tests/openingRange.test.js',
  'tests/database.test.js',
];

console.log('▶ Phase 2 unit tests (opening range + persistence)\n');
let status = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' }).status ?? 1;

if (process.argv.includes('--demo')) {
  console.log('\n▶ Phase 2 live demo (opening ranges on a recent session)\n');
  const s = spawnSync(process.execPath, ['src/strategy/openingRange.js', 'NVDA', 'AAPL', 'TSLA'],
    { cwd: root, stdio: 'inherit' }).status ?? 1;
  status = status || s;
}

process.exit(status);
