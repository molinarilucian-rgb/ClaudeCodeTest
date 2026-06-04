import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Ensure a webhook URL exists before the module (and config) load.
process.env.DISCORD_WEBHOOK_URL = 'https://discord.test/api/webhooks/xxx';

let discord, config;
before(async () => {
  discord = await import('../src/notify/discord.js');
  config = (await import('../config/config.js')).default;
});

const realFetch = globalThis.fetch;
let calls;
beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

const sampleSignal = {
  symbol: 'NVDA', timeframe: 15, direction: 'long', triggered: true,
  entryPrice: 223.1, orHigh: 222.78, orLow: 218.03, stopPrice: 217.8, risk: 5.3,
  gapPct: 3.52, vwap: 220.4, breakoutVolume: 84000, avgVol5: 21000, volumeRatio: 4.0,
  targets: [{ rr: 1, price: 228.4 }, { rr: 1.5, price: 231 }, { rr: 2, price: 233.7 }],
  confirmations: {
    orEstablished: true, priceBreak: true, candleClose: true, gapAligned: true,
    vwapAligned: true, volumeSurge: true, beforeCutoff: true, noPosition: true,
  },
};

test('sendDiscord posts JSON and returns true on 2xx', async () => {
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 204 }; };
  const ok = await discord.sendDiscord({ content: 'hi' });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, config.discord.webhookUrl);
  assert.equal(calls[0].opts.method, 'POST');
  assert.match(calls[0].opts.headers['Content-Type'], /application\/json/);
  assert.equal(JSON.parse(calls[0].opts.body).content, 'hi');
});

test('sendDiscord returns false (and does not throw) when no URL configured', async () => {
  const saved = config.discord.webhookUrl;
  config.discord.webhookUrl = '';
  try {
    globalThis.fetch = async () => { throw new Error('should not be called'); };
    const ok = await discord.sendDiscord({ content: 'x' });
    assert.equal(ok, false);
  } finally { config.discord.webhookUrl = saved; }
});

test('sendDiscord honors a 429 then succeeds on retry', async () => {
  let n = 0;
  globalThis.fetch = async () => {
    n += 1;
    if (n === 1) return { status: 429, json: async () => ({ retry_after: 0 }) };
    return { ok: true, status: 204 };
  };
  const ok = await discord.sendDiscord({ content: 'retry me' });
  assert.equal(ok, true);
  assert.equal(n, 2);
});

test('sendDiscord returns false on a non-retryable error status', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => 'bad request' });
  const ok = await discord.sendDiscord({ content: 'x' });
  assert.equal(ok, false);
});

test('sendBreakoutAlert builds an embed with symbol, direction, and checklist', async () => {
  globalThis.fetch = async (url, opts) => { calls.push(JSON.parse(opts.body)); return { ok: true, status: 204 }; };
  const ok = await discord.sendBreakoutAlert(sampleSignal, { catalyst: 'analyst_rating' });
  assert.equal(ok, true);

  const payload = calls[0];
  assert.equal(payload.embeds.length, 1);
  const embed = payload.embeds[0];
  assert.match(embed.title, /LONG/);
  assert.match(embed.title, /NVDA/);
  assert.match(embed.title, /15m/);
  assert.equal(embed.color, 0x2ecc71); // green for long

  const fieldNames = embed.fields.map((f) => f.name);
  assert.ok(fieldNames.includes('Entry'));
  assert.ok(fieldNames.includes('Confirmations'));
  assert.ok(fieldNames.includes('Catalyst'));
  const checklist = embed.fields.find((f) => f.name === 'Confirmations').value;
  assert.match(checklist, /✅/); // all confirmations passed
});

test('sendBreakoutAlert uses red color for shorts', async () => {
  globalThis.fetch = async (url, opts) => { calls.push(JSON.parse(opts.body)); return { ok: true, status: 204 }; };
  await discord.sendBreakoutAlert({ ...sampleSignal, direction: 'short' });
  assert.equal(calls[0].embeds[0].color, 0xe74c3c);
});
