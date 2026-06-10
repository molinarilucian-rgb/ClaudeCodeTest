import { sendDiscord } from '../notify/discord.js';
import { formatGridLines } from './reportFiles.js';

/**
 * Phase 4 — Discord report messages (daily + weekly).
 * Formatting is pure (returns a string); sending is a thin wrapper over the
 * existing fail-safe sendDiscord. Never throws into the caller.
 */

const signedMoney = (n) => (n == null ? '—' : `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`);
const pf = (v) => (v === null ? '∞' : (v == null ? '—' : Number(v).toFixed(2)));
const pct = (n) => `${Math.round(n)}%`;

/** "5m OR | 1:1 RR" from a grid/variation entry. */
function variationLabel(g) {
  return `${g.timeframe}m OR | 1:${g.rr} RR`;
}

/** Daily summary message text (PART 3 format). */
export function formatDailyDiscord(d) {
  // No-signals branch — say so clearly rather than printing a wall of zeros.
  if (d.signalsCount === 0) {
    const wl = d.watchlist.length
      ? d.watchlist.map((w) => `${w.symbol} ${w.gapPct >= 0 ? '+' : ''}${(w.gapPct ?? 0).toFixed(1)}%`).join(' | ')
      : 'none (no qualifying gaps)';
    return [
      `📊 DAILY REPORT — ${d.date}`,
      `No signals fired today. Bot monitored ${d.watchlist.length} stocks.`,
      `Watchlist: ${wl}`,
    ].join('\n');
  }

  const wl = d.watchlist
    .map((w) => `${w.symbol} ${w.gapPct >= 0 ? '+' : ''}${(w.gapPct ?? 0).toFixed(1)}%`)
    .join(' | ') || 'none';
  const best = d.best
    ? `${variationLabel(d.best)} → ${pct(d.best.stats.winRate)} WR | ${signedMoney(d.best.stats.totalPnl)} P&L`
    : '— (no closed trades)';
  const cumBest = d.cumulative.best ? variationLabel(d.cumulative.best) : '—';

  return [
    `📊 DAILY REPORT — ${d.date}`,
    '',
    `WATCHLIST: ${wl}`,
    '',
    `SIGNALS TODAY: ${d.signalsCount}`,
    `✅ Wins: ${d.outcomes.wins} | ❌ Losses: ${d.outcomes.losses} | ⏳ Pending: ${d.outcomes.pending}`,
    '',
    'BEST STRATEGY TODAY:',
    best,
    '',
    'ALL 9 VARIATIONS:',
    '```',
    ...formatGridLines(d.grid),
    '```',
    'CUMULATIVE (all-time):',
    `Total trades: ${d.cumulative.overall.trades} | Win rate: ${pct(d.cumulative.overall.winRate)} | P&L: ${signedMoney(d.cumulative.overall.totalPnl)}`,
    `Best variation so far: ${cumBest}`,
  ].join('\n');
}

/** Weekly summary message text (PART 4 format). */
export function formatWeeklyDiscord(w) {
  const top = w.top
    ? `${variationLabel(w.top)} — ${pct(w.top.stats.winRate)} WR | ${signedMoney(w.top.stats.totalPnl)} P&L`
    : '— (no trades this week)';
  const worst = w.worst
    ? `${variationLabel(w.worst)} — ${pct(w.worst.stats.winRate)} WR | ${signedMoney(w.worst.stats.totalPnl)} P&L`
    : '— (no trades this week)';
  const mostTraded = w.mostTradedStock
    ? `${w.mostTradedStock.symbol} (${w.mostTradedStock.count} signals)`
    : '—';
  const bigWin = w.biggestWin
    ? `${signedMoney(w.biggestWin.pnl)} (${w.biggestWin.symbol} ${w.biggestWin.direction})`
    : '—';
  const bigLoss = w.biggestLoss
    ? `${signedMoney(w.biggestLoss.pnl)} (${w.biggestLoss.symbol} ${w.biggestLoss.direction})`
    : '—';

  return [
    `📈 WEEKLY SUMMARY — Week of ${w.weekLabel}`,
    '',
    `TRADING DAYS: ${w.tradingDays}`,
    `TOTAL SIGNALS: ${w.totalSignals}`,
    `WIN RATE: ${pct(w.overall.winRate)}`,
    `TOTAL P&L: ${signedMoney(w.overall.totalPnl)}`,
    `PROFIT FACTOR: ${pf(w.overall.profitFactor)}`,
    '',
    'TOP PERFORMER THIS WEEK:',
    top,
    '',
    'WORST PERFORMER THIS WEEK:',
    worst,
    '',
    `MOST TRADED STOCK: ${mostTraded}`,
    `BIGGEST WIN: ${bigWin}`,
    `BIGGEST LOSS: ${bigLoss}`,
    '',
    'CUMULATIVE ALL-TIME:',
    '```',
    ...formatGridLines(w.cumulative.grid),
    '```',
  ].join('\n');
}

export async function sendDailyDiscord(d) {
  return sendDiscord({ content: formatDailyDiscord(d) });
}

export async function sendWeeklyDiscord(w) {
  return sendDiscord({ content: formatWeeklyDiscord(w) });
}

export default { formatDailyDiscord, formatWeeklyDiscord, sendDailyDiscord, sendWeeklyDiscord };
