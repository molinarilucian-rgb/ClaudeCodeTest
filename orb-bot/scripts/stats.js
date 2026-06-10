import {
  strategyGrid, computeStats, bestStrategy, worstStrategy,
} from '../src/reporting/metrics.js';
import {
  getAllClosedTradeRecords, getRecentPerformance, getOpenPositions,
  countTradingDaysTracked,
} from '../src/reporting/performanceDb.js';

/**
 * On-demand performance stats — `node scripts/stats.js`.
 * Read-only snapshot of all-time performance, so you can query from Railway's
 * shell anytime without waiting for the 4:30 PM report. Never places orders.
 */

const signedMoney = (n) => (n == null ? '—' : `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`);
const pf = (v) => (v === null ? '∞ (no losses)' : (v == null ? '—' : Number(v).toFixed(2)));
const pfShort = (v) => (v === null ? '∞' : (v == null ? '—' : Number(v).toFixed(2))); // compact, for aligned tables
const pct = (n) => `${Math.round(n)}%`;
const sharpe = (v) => (v == null ? '—' : Number(v).toFixed(2));

function main() {
  const records = getAllClosedTradeRecords();
  const grid = strategyGrid(records);
  const overall = computeStats(records);
  const best = bestStrategy(grid);
  const worst = worstStrategy(grid);
  const days = countTradingDaysTracked();

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  ORB BOT — ALL-TIME PERFORMANCE  (simulation/paper)');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`  Trading days tracked: ${days}`);
  console.log(`  Total trades: ${overall.trades} | Win rate: ${pct(overall.winRate)} | P&L: ${signedMoney(overall.totalPnl)} | PF: ${pf(overall.profitFactor)}`);

  if (overall.trades === 0) {
    console.log('\n  No closed trades recorded yet — run the bot through a session first.\n');
    printOpenPositions();
    return;
  }

  console.log('\n  STRATEGY VARIATIONS (all 9):');
  console.log('  ' + '-'.repeat(70));
  console.log(`  ${'variation'.padEnd(11)} ${'trades'.padStart(6)} ${'WR'.padStart(5)} ${'P&L'.padStart(11)} ${'PF'.padStart(7)} ${'avgR'.padStart(6)} ${'maxDD'.padStart(9)} ${'sharpe'.padStart(7)}`);
  for (const g of grid) {
    const s = g.stats;
    console.log(`  ${g.labelPadded} ${String(s.trades).padStart(6)} ${(s.trades ? pct(s.winRate) : '—').padStart(5)} ${signedMoney(s.totalPnl).padStart(11)} ${pfShort(s.profitFactor).padStart(7)} ${String(s.avgRMultiple).padStart(6)} ${signedMoney(-s.maxDrawdown).padStart(9)} ${sharpe(s.sharpeRatio).padStart(7)}`);
  }
  console.log('  ' + '-'.repeat(70));

  if (best) console.log(`  ★ Best variation:  ${best.label} → ${pct(best.stats.winRate)} WR | ${signedMoney(best.stats.totalPnl)} P&L | PF ${pf(best.stats.profitFactor)}`);
  if (worst) console.log(`  ▼ Worst variation: ${worst.label} → ${pct(worst.stats.winRate)} WR | ${signedMoney(worst.stats.totalPnl)} P&L | PF ${pf(worst.stats.profitFactor)}`);

  console.log('\n  LAST 5 TRADES:');
  const recent = getRecentPerformance(5);
  if (!recent.length) {
    console.log('    (none)');
  } else {
    for (const t of recent) {
      const outcome = (t.pnl ?? 0) > 0 ? 'WIN ' : (t.pnl ?? 0) < 0 ? 'LOSS' : 'B/E ';
      console.log(`    ${t.date} ${t.symbol.padEnd(6)} ${t.strategy_key.padEnd(9)} ${t.direction.padEnd(5)} ${outcome} ${signedMoney(t.pnl).padStart(10)} (${t.r_multiple}R, ${t.exit_reason})`);
    }
  }

  printOpenPositions();
}

function printOpenPositions() {
  const open = getOpenPositions();
  console.log(`\n  OPEN POSITIONS: ${open.length}`);
  for (const p of open) {
    console.log(`    ${p.symbol.padEnd(6)} ${p.or_timeframe}m rr${p.rr_ratio} ${p.direction} ×${p.shares} | status ${p.status} | entry ${p.entry_price ?? p.intended_entry} | stop ${p.stop_price} | target ${p.target_price}`);
  }
  console.log('');
}

main();
