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

  const fields = [];
  if (signal.qualityScore != null) {
    fields.push({ name: 'Quality', value: `${signal.qualityScore}/10 (${signal.qualityGrade})`, inline: true });
  }
  fields.push(
    { name: 'Entry', value: money(signal.entryPrice), inline: true },
    { name: 'Stop', value: money(signal.stopPrice), inline: true },
    { name: 'Risk/share', value: money(signal.risk), inline: true },
    { name: 'OR High', value: money(signal.orHigh), inline: true },
    { name: 'OR Low', value: money(signal.orLow), inline: true },
    { name: 'Vol ratio', value: `${signal.volumeRatio.toFixed(1)}×`, inline: true },
  );
  if (signal.scoreBreakdown) {
    const b = signal.scoreBreakdown;
    fields.push({ name: 'Score breakdown', value: `Vol ${b.volume} · Gap ${b.gap} · Close ${b.close} · VWAP ${b.vwap}  (each /10)`, inline: false });
  }
  fields.push(
    { name: 'Targets', value: targetsStr, inline: false },
    { name: 'Confirmations', value: checklist, inline: false },
  );
  if (extra.catalyst) {
    fields.push({ name: 'Catalyst', value: String(extra.catalyst), inline: false });
  }

  return sendDiscord({
    embeds: [{
      title: `${dir} breakout — ${signal.symbol} (${signal.timeframe}m ORB)${signal.qualityScore != null ? ` · ${signal.qualityScore}/10 ${signal.qualityGrade}` : ''}`,
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

/**
 * Order/position lifecycle notification (Phase 3). One Discord message per
 * order placed, filled, and closed (with reason + realized P&L), plus
 * cancelled entries and a restart recovery summary.
 *
 * @param {'placed'|'filled'|'closed'|'cancelled'|'recovered'} kind
 * @param {object|null} pos  a `trades` row (the position), or null for 'recovered'
 * @param {object} [extra]   { catalyst, reason, pnl, rMultiple, pnlPct, slippage, positions }
 */
export async function sendOrderNotification(kind, pos, extra = {}) {
  const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);
  const simTag = pos?.simulated ? ' · SIM (no real order)' : '';

  if (kind === 'recovered') {
    const list = (extra.positions || [])
      .map((p) => `• ${p.symbol} ${p.direction} ×${p.shares} (${p.or_timeframe}m rr${p.rr_ratio}) — ${p.status}`)
      .join('\n') || 'none';
    return sendDiscord({
      embeds: [{
        title: `🔄 Positions recovered on restart (${(extra.positions || []).length})`,
        description: 'Resuming management of open positions from the database.',
        color: COLORS.info,
        fields: [{ name: 'Positions', value: list, inline: false }],
        timestamp: new Date().toISOString(),
        footer: { text: 'ORB Bot · Phase 3 execution' },
      }],
    });
  }

  if (!pos) return false;
  const dirIcon = pos.direction === 'long' ? '🟢 LONG' : '🔴 SHORT';
  const tag = `${pos.symbol} ${pos.or_timeframe}m rr${pos.rr_ratio}`;

  const meta = {
    placed: { icon: '📝', verb: 'ENTRY PLACED', color: COLORS[pos.direction] ?? COLORS.info },
    filled: { icon: '✅', verb: 'FILLED', color: COLORS[pos.direction] ?? COLORS.info },
    closed: { icon: '🏁', verb: `CLOSED · ${extra.reason || pos.exit_reason || ''}`.trim(), color: (extra.pnl ?? 0) >= 0 ? COLORS.long : COLORS.short },
    cancelled: { icon: '🚫', verb: `CANCELLED · ${extra.reason || pos.exit_reason || ''}`.trim(), color: COLORS.short },
  }[kind];
  if (!meta) return false;

  const fields = [
    { name: 'Direction', value: dirIcon, inline: true },
    { name: 'Shares', value: String(pos.shares), inline: true },
    { name: 'Entry', value: money(pos.entry_price ?? pos.intended_entry), inline: true },
  ];
  if (kind === 'filled' && extra.slippage != null) {
    fields.push({ name: 'Slippage', value: money(extra.slippage), inline: true });
  }
  if (kind === 'placed' || kind === 'filled') {
    fields.push(
      { name: 'Stop', value: money(pos.stop_price), inline: true },
      { name: 'Target', value: money(pos.target_price), inline: true },
    );
    if (extra.catalyst) fields.push({ name: 'Catalyst', value: String(extra.catalyst), inline: false });
  }
  if (kind === 'closed') {
    const pnl = extra.pnl ?? pos.pnl ?? 0;
    const sign = pnl >= 0 ? '+' : '';
    fields.push(
      { name: 'Exit', value: money(extra.exitPrice ?? pos.exit_price), inline: true },
      { name: 'Realized P&L', value: `${sign}${money(pnl).slice(1)}`, inline: true },
      { name: 'R / %', value: `${sign}${extra.rMultiple ?? pos.r_multiple ?? 0}R · ${sign}${extra.pnlPct ?? pos.pnl_pct ?? 0}%`, inline: true },
    );
  }

  return sendDiscord({
    embeds: [{
      title: `${meta.icon} ${meta.verb} — ${tag}${simTag}`,
      color: meta.color,
      fields,
      timestamp: new Date().toISOString(),
      footer: { text: `ORB Bot · Phase 3 ${pos.simulated ? 'simulation' : 'paper'} execution` },
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
    qualityScore: 8.4, qualityGrade: 'A',
    scoreBreakdown: { volume: 10, gap: 7, close: 6.4, vwap: 10 },
    targets: [{ rr: 1, price: 228.39 }, { rr: 1.5, price: 231.04 }, { rr: 2, price: 233.68 }],
    confirmations: {
      orEstablished: true, priceBreak: true, candleClose: true, gapAligned: true,
      vwapAligned: true, volumeSurge: true, beforeCutoff: true, noPosition: true,
    },
  };
  sendBreakoutAlert(sample, { catalyst: 'analyst_rating: PT hikes' })
    .then((ok) => { console.log(ok ? 'Test alert sent ✅' : 'Send failed (check DISCORD_WEBHOOK_URL) ❌'); process.exit(ok ? 0 : 1); });
}

export default { sendDiscord, sendBreakoutAlert, sendOrderNotification };
