import config from '../../config/config.js';
import logger from '../utils/logger.js';

/**
 * Discord webhook notifier.
 * Sends breakout signals (and generic messages) to a Discord channel so they
 * can be monitored from a phone. Fail-safe: never throws into the trading loop;
 * returns true/false. Honors Discord's 429 rate limit with retry_after.
 */

const COLORS = { long: 0x2ecc71, short: 0xe74c3c, info: 0x3498db };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (b) => (b ? '✅' : '❌');

/** Low-level send. Returns true on success, false on failure (logged). */
export async function sendDiscord({ content, embeds }, { maxRetries = 3 } = {}) {
  const url = config.discord.webhookUrl;
  if (!url) {
    logger.warn('DISCORD_WEBHOOK_URL not set — skipping Discord notification');
    return false;
  }
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, embeds }),
      });
      if (res.status === 429) {
        const body = await res.json().catch(() => ({}));
        const waitMs = Math.ceil((body.retry_after ?? 1) * 1000);
        logger.warn(`Discord rate-limited; retrying in ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        logger.error(`Discord webhook failed ${res.status}: ${text.slice(0, 200)}`);
        return false;
      }
      return true; // 2xx (webhooks return 204 No Content)
    } catch (err) {
      logger.error(`Discord send error (attempt ${attempt + 1}): ${err.message}`);
      if (attempt === maxRetries) return false;
      await sleep(500 * (attempt + 1));
    }
  }
  return false;
}

/** Format and send a breakout-signal alert. `extra.catalyst` is optional context. */
export async function sendBreakoutAlert(signal, extra = {}) {
  const dir = signal.direction === 'long' ? '🟢 LONG' : '🔴 SHORT';
  const c = signal.confirmations;
  const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);

  const targetsStr = signal.targets
    .map((t) => `1:${t.rr} → ${money(t.price)}`)
    .join('\n');

  const checklist = [
    `${check(c.orEstablished)} OR established`,
    `${check(c.priceBreak)} Price broke OR ${signal.direction === 'long' ? 'high' : 'low'}`,
    `${check(c.candleClose)} Candle closed beyond OR`,
    `${check(c.gapAligned)} Gap aligned (${signal.gapPct != null ? signal.gapPct.toFixed(2) + '%' : 'n/a'})`,
    `${check(c.vwapAligned)} ${signal.direction === 'long' ? 'Above' : 'Below'} VWAP (${money(signal.vwap)})`,
    `${check(c.volumeSurge)} Volume surge (${signal.volumeRatio.toFixed(1)}× avg5)`,
    `${check(c.beforeCutoff)} Before 11:00 ET cutoff`,
    `${check(c.noPosition)} No open position`,
  ].join('\n');

  const fields = [
    { name: 'Entry', value: money(signal.entryPrice), inline: true },
    { name: 'Stop', value: money(signal.stopPrice), inline: true },
    { name: 'Risk/share', value: money(signal.risk), inline: true },
    { name: 'OR High', value: money(signal.orHigh), inline: true },
    { name: 'OR Low', value: money(signal.orLow), inline: true },
    { name: 'Vol ratio', value: `${signal.volumeRatio.toFixed(1)}×`, inline: true },
    { name: 'Targets', value: targetsStr, inline: false },
    { name: 'Confirmations', value: checklist, inline: false },
  ];
  if (extra.catalyst) {
    fields.push({ name: 'Catalyst', value: String(extra.catalyst), inline: false });
  }

  return sendDiscord({
    embeds: [{
      title: `${dir} breakout — ${signal.symbol} (${signal.timeframe}m ORB)`,
      description: signal.triggered
        ? '**All confirmations passed** — valid ORB signal.'
        : '⚠️ Partial setup (not all confirmations passed).',
      color: COLORS[signal.direction] ?? COLORS.info,
      fields,
      timestamp: new Date().toISOString(),
      footer: { text: 'ORB Bot · paper signal (no order placed)' },
    }],
  });
}

// CLI: `node src/notify/discord.js` sends a sample alert to verify the webhook.
if (process.argv[1]?.endsWith('discord.js')) {
  const sample = {
    symbol: 'NVDA', timeframe: 15, direction: 'long', triggered: true,
    entryPrice: 223.10, orHigh: 222.78, orLow: 218.03, stopPrice: 217.81,
    risk: 5.29, gapPct: 3.52, vwap: 220.4, breakoutVolume: 84000, avgVol5: 21000,
    volumeRatio: 4.0,
    targets: [{ rr: 1, price: 228.39 }, { rr: 1.5, price: 231.04 }, { rr: 2, price: 233.68 }],
    confirmations: {
      orEstablished: true, priceBreak: true, candleClose: true, gapAligned: true,
      vwapAligned: true, volumeSurge: true, beforeCutoff: true, noPosition: true,
    },
  };
  sendBreakoutAlert(sample, { catalyst: 'analyst_rating: PT hikes' })
    .then((ok) => { console.log(ok ? 'Test alert sent ✅' : 'Send failed (check DISCORD_WEBHOOK_URL) ❌'); process.exit(ok ? 0 : 1); });
}

export default { sendDiscord, sendBreakoutAlert };
