/**
 * Live smoke test — exercises the REAL Alpaca + Perplexity APIs.
 * Not part of `npm test` (which is deterministic/offline). Run explicitly:
 *   npm run smoke
 *
 * Exits non-zero if any check fails.
 */
import { getAccount, getAsset } from '../src/data/marketData.js';
import { scanUniverse } from '../src/scanners/universeScanner.js';
import { classifyCatalyst } from '../src/data/perplexity.js';
import { scanGaps } from '../src/scanners/gapScanner.js';

let passed = 0, failed = 0;
const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push(`✔ ${name}${detail ? ` — ${detail}` : ''}`);
    passed++;
  } catch (err) {
    results.push(`✘ ${name} — ${err.message}`);
    failed++;
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

await check('Alpaca: account reachable & active', async () => {
  const a = await getAccount();
  assert(a.status === 'ACTIVE', `status=${a.status}`);
  assert(Number(a.buying_power) > 0, 'no buying power');
  return `buying_power=$${a.buying_power}`;
});

await check('Alpaca: getAsset returns metadata for AAPL', async () => {
  const asset = await getAsset('AAPL');
  assert(asset.symbol === 'AAPL', 'wrong symbol');
  assert(asset.exchange, 'no exchange');
  return `exchange=${asset.exchange}`;
});

await check('Alpaca: bogus ticker rejected gracefully (no crash)', async () => {
  // universeScanner should classify a nonexistent symbol as rejected, not throw.
  const { qualified, rejected } = await scanUniverse(['ZZZZQQ']);
  assert(qualified.length === 0, 'bogus symbol should not qualify');
  assert(rejected.length === 1, 'bogus symbol should be rejected');
  return `rejected: ${rejected[0].reason}`;
});

await check('Universe scan: seed list returns qualified candidates', async () => {
  const { qualified } = await scanUniverse();
  assert(qualified.length > 0, 'no qualified candidates');
  for (const c of qualified) {
    assert(typeof c.atr14 === 'number' || c.atr14 === null, `${c.symbol} bad atr`);
    assert(c.price >= 20 && c.price <= 1000, `${c.symbol} price out of band`);
  }
  return `${qualified.length} qualified`;
});

await check('Perplexity: live catalyst classification returns structured data', async () => {
  const r = await classifyCatalyst({ symbol: 'NVDA', gapPct: 3.5, prevClose: 100, price: 103.5 });
  assert(r.classified === true, 'classification did not run');
  assert(['high', 'medium', 'low', 'none'].includes(r.quality), `bad quality ${r.quality}`);
  assert(typeof r.tradeable === 'boolean', 'tradeable not boolean');
  assert(r.confidence >= 0 && r.confidence <= 1, 'confidence out of range');
  return `${r.catalyst_type}/${r.quality} (conf ${r.confidence})`;
});

await check('Gap scan: full pipeline runs and persists', async () => {
  const { selected, evaluated } = await scanGaps();
  assert(Array.isArray(selected) && Array.isArray(evaluated), 'bad shape');
  assert(selected.length <= 5, 'selected more than topN');
  // every selected must have a classified catalyst and pass quality
  for (const s of selected) {
    assert(s.catalyst, `${s.symbol} missing catalyst`);
    assert(s.qualityOk, `${s.symbol} selected but failed quality`);
  }
  return `${evaluated.length} evaluated, ${selected.length} selected`;
});

console.log('\n──────── LIVE SMOKE RESULTS ────────');
for (const r of results) console.log(r);
console.log(`────────────────────────────────────\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
