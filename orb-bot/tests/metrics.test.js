import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  strategyKey, strategyLabel, allStrategyVariations, normalizeExitReason,
  toPerformanceRecord, maxDrawdown, computeStats, summarizeByStrategy,
  strategyGrid, bestStrategy, worstStrategy,
} from '../src/reporting/metrics.js';

// A minimal closed-trade DB row (trades LEFT JOIN signals shape).
const row = (o = {}) => ({
  trade_id: 't1', date: '2026-06-08', symbol: 'NVDA', direction: 'long',
  or_timeframe: 5, rr_ratio: 1.0, entry_price: 100, stop_price: 98, target_price: 102,
  exit_price: 102, shares: 500, risk_amount: 1000, pnl: 1000, r_multiple: 1.0,
  exit_reason: 'TARGET', signal_quality_score: 8.4, signal_volume_ratio: 3.2,
  signal_gap_pct: 3.5, entry_time: '2026-06-08T13:40:00Z', exit_time: '2026-06-08T14:10:00Z',
  ...o,
});

test('strategyKey / strategyLabel map (timeframe, rr) per spec', () => {
  assert.equal(strategyKey(5, 1.0), '5m_rr1');
  assert.equal(strategyKey(15, 1.5), '15m_rr15');
  assert.equal(strategyKey(30, 2.0), '30m_rr2');
  assert.equal(strategyLabel(15, 1.5), '15m 1:1.5');
});

test('allStrategyVariations returns the 9 combos in canonical order', () => {
  const keys = allStrategyVariations().map((v) => v.key);
  assert.deepEqual(keys, [
    '5m_rr1', '5m_rr15', '5m_rr2',
    '15m_rr1', '15m_rr15', '15m_rr2',
    '30m_rr1', '30m_rr15', '30m_rr2',
  ]);
});

test('normalizeExitReason maps engine reasons to report vocabulary', () => {
  assert.equal(normalizeExitReason('TARGET'), 'target_hit');
  assert.equal(normalizeExitReason('STOP'), 'stop_hit');
  assert.equal(normalizeExitReason('KILL_SWITCH'), 'kill_switch');
  assert.equal(normalizeExitReason('EOD_CLOSE'), 'eod_close');
  assert.equal(normalizeExitReason(null), null);
});

test('toPerformanceRecord enriches + derives duration_minutes', () => {
  const r = toPerformanceRecord(row());
  assert.equal(r.strategyKey, '5m_rr1');
  assert.equal(r.exitReason, 'target_hit');
  assert.equal(r.signalQualityScore, 8.4);
  assert.equal(r.volumeRatio, 3.2);
  assert.equal(r.gapPct, 3.5);
  assert.equal(r.durationMinutes, 30); // 13:40 → 14:10
});

test('toPerformanceRecord falls back to trade gap when no signal joined', () => {
  const r = toPerformanceRecord(row({ signal_gap_pct: null, gap_pct: 2.1, signal_quality_score: null }));
  assert.equal(r.gapPct, 2.1);
  assert.equal(r.signalQualityScore, null);
});

test('maxDrawdown tracks peak-to-trough of cumulative P&L', () => {
  // equity path: +100 → +60 (dd 40) → +160 (peak) → +110 (dd 50) → +130
  assert.equal(maxDrawdown([100, -40, 100, -50, 20]), 50);
  assert.equal(maxDrawdown([100, 50, 25]), 0);   // never dips below 0 baseline... peak rises
  assert.equal(maxDrawdown([-30, -20, 40]), 50); // 0 → -30 → -50 (dd 50) → -10
  assert.equal(maxDrawdown([]), 0);
});

test('computeStats — hand-computed fixture (3 wins, 2 losses)', () => {
  // pnl: +200, -100, +300, -50, +150  → total +500, n=5
  // wins 3 (gross 650), losses 2 (gross 150), winRate 60%
  // avgWin 650/3=216.67, avgLoss 150/2=75, PF 650/150=4.33, expectancy 500/5=100
  const recs = [
    { pnl: 200, rMultiple: 2 }, { pnl: -100, rMultiple: -1 }, { pnl: 300, rMultiple: 3 },
    { pnl: -50, rMultiple: -0.5 }, { pnl: 150, rMultiple: 1.5 },
  ];
  const s = computeStats(recs);
  assert.equal(s.trades, 5);
  assert.equal(s.wins, 3);
  assert.equal(s.losses, 2);
  assert.equal(s.winRate, 60);
  assert.equal(s.totalPnl, 500);
  assert.equal(s.avgWin, 216.67);
  assert.equal(s.avgLoss, 75);
  assert.equal(s.profitFactor, 4.33);
  assert.equal(s.expectancy, 100);
  assert.equal(s.avgRMultiple, 1); // (2-1+3-0.5+1.5)/5 = 5/5
  assert.equal(s.bestTradePnl, 300);
  assert.equal(s.worstTradePnl, -100);
  // maxDrawdown over [200,-100,300,-50,150]: peak 200→100(dd100)→400→350(dd50)→500 → 100
  assert.equal(s.maxDrawdown, 100);
});

test('computeStats — no losses → profitFactor null (infinite)', () => {
  const s = computeStats([{ pnl: 100, rMultiple: 1 }, { pnl: 50, rMultiple: 0.5 }]);
  assert.equal(s.profitFactor, null);
  assert.equal(s.losses, 0);
  assert.equal(s.winRate, 100);
});

test('computeStats — empty set is all zeros, sharpe null', () => {
  const s = computeStats([]);
  assert.equal(s.trades, 0);
  assert.equal(s.totalPnl, 0);
  assert.equal(s.profitFactor, 0);
  assert.equal(s.sharpeRatio, null);
});

test('computeStats — sharpe = mean(R)/stdev(R)', () => {
  // R series [1, -1, 1, -1]: mean 0 → sharpe 0
  assert.equal(computeStats([
    { pnl: 1, rMultiple: 1 }, { pnl: -1, rMultiple: -1 },
    { pnl: 1, rMultiple: 1 }, { pnl: -1, rMultiple: -1 },
  ]).sharpeRatio, 0);
  // R series [2, 2, 2]: stdev 0 → sharpe null (guard against /0)
  assert.equal(computeStats([
    { pnl: 2, rMultiple: 2 }, { pnl: 2, rMultiple: 2 }, { pnl: 2, rMultiple: 2 },
  ]).sharpeRatio, null);
});

test('summarizeByStrategy groups by key', () => {
  const recs = [
    { strategyKey: '5m_rr1', pnl: 100, rMultiple: 1 },
    { strategyKey: '5m_rr1', pnl: -50, rMultiple: -0.5 },
    { strategyKey: '15m_rr2', pnl: 300, rMultiple: 2 },
  ];
  const by = summarizeByStrategy(recs);
  assert.equal(by['5m_rr1'].trades, 2);
  assert.equal(by['5m_rr1'].totalPnl, 50);
  assert.equal(by['15m_rr2'].trades, 1);
});

test('strategyGrid always returns 9 rows; untraded keys zeroed', () => {
  const grid = strategyGrid([{ strategyKey: '30m_rr2', pnl: 100, rMultiple: 1 }]);
  assert.equal(grid.length, 9);
  const traded = grid.find((g) => g.key === '30m_rr2');
  const empty = grid.find((g) => g.key === '5m_rr1');
  assert.equal(traded.stats.trades, 1);
  assert.equal(empty.stats.trades, 0);
});

test('bestStrategy / worstStrategy pick by total P&L among traded', () => {
  const grid = strategyGrid([
    { strategyKey: '5m_rr1', pnl: 100, rMultiple: 1 },
    { strategyKey: '15m_rr2', pnl: -200, rMultiple: -2 },
    { strategyKey: '30m_rr1', pnl: 500, rMultiple: 1 },
  ]);
  assert.equal(bestStrategy(grid).key, '30m_rr1');
  assert.equal(worstStrategy(grid).key, '15m_rr2');
  assert.equal(bestStrategy(strategyGrid([])), null); // nothing traded
});
