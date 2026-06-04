import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCatalystJson, qualityRank, classifyCatalyst,
} from '../src/data/perplexity.js';

test('qualityRank orders quality labels', () => {
  assert.equal(qualityRank('high'), 3);
  assert.equal(qualityRank('medium'), 2);
  assert.equal(qualityRank('low'), 1);
  assert.equal(qualityRank('none'), 0);
  assert.equal(qualityRank('garbage'), 0); // unknown → 0
  assert.equal(qualityRank(undefined), 0);
});

test('parseCatalystJson reads a plain JSON object', () => {
  const o = parseCatalystJson('{"catalyst_type":"earnings","quality":"high"}');
  assert.equal(o.catalyst_type, 'earnings');
  assert.equal(o.quality, 'high');
});

test('parseCatalystJson strips ```json fences', () => {
  const o = parseCatalystJson('```json\n{"quality":"medium"}\n```');
  assert.equal(o.quality, 'medium');
});

test('parseCatalystJson extracts JSON embedded in prose', () => {
  const o = parseCatalystJson('Here is the result: {"quality":"low"} hope that helps');
  assert.equal(o.quality, 'low');
});

test('parseCatalystJson returns null on garbage', () => {
  assert.equal(parseCatalystJson('not json at all'), null);
  assert.equal(parseCatalystJson(''), null);
  assert.equal(parseCatalystJson(null), null);
});

// --- classifyCatalyst with a stubbed global.fetch ---

function stubFetch(impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => { globalThis.fetch = original; };
}

const okResponse = (content) => async () => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content } }] }),
});

test('classifyCatalyst normalizes and clamps a valid response', async () => {
  const restore = stubFetch(okResponse(JSON.stringify({
    catalyst_type: 'earnings',
    catalyst_summary: 'Beat on EPS and revenue.',
    quality: 'high',
    sentiment: 'bullish',
    tradeable: true,
    confidence: 1.5, // out of range → clamp to 1
  })));
  try {
    const r = await classifyCatalyst({ symbol: 'TST', gapPct: 5, prevClose: 100, price: 105 });
    assert.equal(r.catalyst_type, 'earnings');
    assert.equal(r.quality, 'high');
    assert.equal(r.tradeable, true);
    assert.equal(r.confidence, 1); // clamped
    assert.equal(r.classified, true);
  } finally { restore(); }
});

test('classifyCatalyst maps unknown enum values to safe defaults', async () => {
  const restore = stubFetch(okResponse(JSON.stringify({
    catalyst_type: 'aliens_landed',   // invalid → unknown
    quality: 'spectacular',           // invalid → none
    sentiment: 'vibes',               // invalid → neutral
    tradeable: 'yes',                 // truthy → true
    confidence: -3,                   // clamp to 0
  })));
  try {
    const r = await classifyCatalyst({ symbol: 'TST', gapPct: 2, prevClose: 50, price: 51 });
    assert.equal(r.catalyst_type, 'unknown');
    assert.equal(r.quality, 'none');
    assert.equal(r.sentiment, 'neutral');
    assert.equal(r.confidence, 0);
    assert.equal(r.classified, true);
  } finally { restore(); }
});

test('classifyCatalyst fails safe on non-OK HTTP status', async () => {
  const restore = stubFetch(async () => ({
    ok: false, status: 429, text: async () => 'rate limited',
  }));
  try {
    const r = await classifyCatalyst({ symbol: 'TST', gapPct: 2, prevClose: 50, price: 51 });
    assert.equal(r.classified, false);
    assert.equal(r.tradeable, false);
    assert.equal(r.quality, 'none');
    assert.match(r.catalyst_summary, /429/);
  } finally { restore(); }
});

test('classifyCatalyst fails safe when fetch throws', async () => {
  const restore = stubFetch(async () => { throw new Error('network down'); });
  try {
    const r = await classifyCatalyst({ symbol: 'TST', gapPct: 2, prevClose: 50, price: 51 });
    assert.equal(r.classified, false);
    assert.equal(r.tradeable, false);
  } finally { restore(); }
});

test('classifyCatalyst fails safe on unparseable content', async () => {
  const restore = stubFetch(okResponse('the stock went up because reasons'));
  try {
    const r = await classifyCatalyst({ symbol: 'TST', gapPct: 2, prevClose: 50, price: 51 });
    assert.equal(r.classified, false);
    assert.match(r.catalyst_summary, /unparseable/);
  } finally { restore(); }
});
