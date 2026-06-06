import config from '../../config/config.js';
import logger from '../utils/logger.js';
import * as db from '../data/database.js';
import * as marketData from '../data/marketData.js';
import { broker as defaultBroker } from './broker.js';
import { sizePosition, describeSizing } from './positionSizer.js';
import { etDateStr } from '../utils/timeUtils.js';
import { sendOrderNotification } from '../notify/discord.js';

/**
 * Execution engine (Phase 3)
 * --------------------------
 * Turns confirmed breakout SIGNALS into managed POSITIONS, gated behind the
 * SIMULATION_MODE safety flag (enforced in the broker layer).
 *
 * Per signal we open the THREE reward:risk variations (1:1, 1:1.5, 1:2) as
 * INDEPENDENT positions — each risk-sized on its own, each tracked to its own
 * outcome — so we can compare which RR performs best. Stop is the opposite OR
 * extreme; targets are entry ± risk × rr.
 *
 * Lifecycle (all state in the `trades` table, so a restart resumes cleanly):
 *   pending  → entry limit placed, awaiting fill (cancelled after 2 min)
 *   open     → filled; managed each tick for target / stop / kill-switch / EOD
 *   closed   → exited (records exit price, reason, realized P&L, R multiple)
 *   cancelled→ entry never filled
 *
 * Exits are managed by polling (the bot is REST/poll-based): each tick compares
 * the latest price to the leg's stop/target and flattens when breached.
 */

const round2 = (n) => Math.round(n * 100) / 100;
const EOD_REASON = 'EOD_CLOSE';

export function createExecutionEngine({
  cfg = config,
  database = db,
  md = marketData,
  broker = defaultBroker,
  notify = sendOrderNotification,
  log = logger,
  clock = () => Date.now(),
} = {}) {
  const { rrRatios, orderFillTimeoutSec, killSwitchRiskMult } = cfg.strategy;
  const { size: accountSize, maxRiskPerTrade } = cfg.account;
  const maxConcurrent = cfg.risk.maxConcurrentPositions;

  /** Banner describing the active mode — logged on every decision point. */
  function modeBanner() {
    return broker.simulationMode
      ? 'SIMULATION_MODE=ON — orders are logged only, nothing is sent to Alpaca'
      : 'SIMULATION_MODE=OFF — LIVE: real paper orders WILL be submitted to Alpaca';
  }

  /** A short, filesystem/order-id-safe client id for an order. */
  function clientId(tradeId, kind) {
    return `${tradeId}_${kind}_${clock()}`.replace(/[^a-zA-Z0-9._-]/g, '');
  }

  /**
   * Open the three RR-variation positions for a confirmed signal.
   * @param {object} signal  from detectBreakout (entryPrice/stopPrice/orHigh/orLow/targets…)
   * @param {object} [meta]   { catalyst, openingRangeId }
   */
  async function openPositionsForSignal(signal, meta = {}) {
    const date = etDateStr();
    const { symbol, timeframe, direction } = signal;
    const isLong = direction === 'long';
    const side = isLong ? 'buy' : 'sell';

    log.info(`⚙️  EXECUTION — ${symbol} ${timeframe}m ${direction.toUpperCase()} confirmed. ${modeBanner()}`);

    // Entry limit: breakout candle close, nudged to at least 1 cent beyond the OR.
    const rawEntry = isLong
      ? Math.max(signal.entryPrice, signal.orHigh + 0.01)
      : Math.min(signal.entryPrice, signal.orLow - 0.01);
    const entry = round2(rawEntry);
    const stop = round2(signal.stopPrice);

    // One buying-power snapshot, decremented as each leg reserves its notional.
    let buyingPower;
    try {
      const acct = await md.getAccount();
      buyingPower = Number(acct.buying_power);
    } catch (err) {
      log.error(`Execution aborted for ${symbol}: could not read account buying power: ${err.message}`);
      return [];
    }

    const opened = [];
    for (const rr of rrRatios) {
      const tradeId = `${date}_${symbol}_${timeframe}_${direction}_rr${rr}`;

      if (database.getPosition(tradeId)) {
        log.info(`Skip ${tradeId} — position already exists (no double-open).`);
        continue;
      }
      if (database.getOpenPositions().length >= maxConcurrent) {
        log.warn(`Max concurrent positions (${maxConcurrent}) reached — skipping remaining legs for ${symbol}.`);
        break;
      }

      const targetFromSignal = signal.targets?.find((t) => t.rr === rr);
      const targetPrice = round2(
        targetFromSignal ? targetFromSignal.price
          : (isLong ? entry + Math.abs(entry - stop) * rr : entry - Math.abs(entry - stop) * rr)
      );

      const sizing = sizePosition({ accountSize, maxRiskPerTrade, entry, stop, buyingPower });
      log.info(describeSizing(sizing, { symbol, rr }));
      if (sizing.skip) {
        log.warn(`Skip ${symbol} rr${rr}: ${sizing.reason}`);
        continue;
      }

      const cid = clientId(tradeId, 'e');
      let order;
      try {
        order = await broker.placeEntry({ symbol, qty: sizing.shares, side, limitPrice: entry, clientOrderId: cid });
      } catch (err) {
        log.error(`Entry order failed for ${tradeId}: ${err.message}`);
        continue;
      }

      const pos = database.savePosition({
        tradeId, date, symbol, orTimeframe: timeframe, rrRatio: rr, direction,
        status: 'pending', intendedEntry: entry, stopPrice: stop, targetPrice,
        shares: sizing.shares, riskAmount: round2(sizing.riskAmount),
        entryOrderId: order.orderId, simulated: order.simulated,
        openedAt: order.submittedAt || new Date().toISOString(),
        openingRangeId: meta.openingRangeId,
      });
      buyingPower -= sizing.notional; // reserve so sibling legs don't oversubscribe
      opened.push(tradeId);

      log.info(`📝 POSITION OPENED ${tradeId} | ${side} ${sizing.shares} @ limit $${entry.toFixed(2)} | stop $${stop.toFixed(2)} | target $${targetPrice.toFixed(2)} | risk $${round2(sizing.riskAmount)}`);
      await safeNotify('placed', pos, { catalyst: meta.catalyst });

      // In simulation, the limit fills instantly at the intended price so the
      // rest of the lifecycle (management/exits) can be observed end-to-end.
      if (broker.simulationMode) await markFilled(pos, entry, order.orderId, { simulated: true });
    }

    if (!opened.length) log.warn(`No positions opened for ${symbol} ${timeframe}m ${direction} (all legs skipped).`);
    return opened;
  }

  /** Transition a pending leg to open, recording fill price + slippage. */
  async function markFilled(pos, fillPrice, orderId, { simulated = false } = {}) {
    const isLong = pos.direction === 'long';
    const intended = pos.intended_entry ?? pos.entry_price ?? fillPrice;
    const slippage = round2(isLong ? fillPrice - intended : intended - fillPrice);
    const updated = database.updatePosition(pos.trade_id, {
      status: 'open', entry_price: round2(fillPrice), slippage,
      entry_time: new Date().toISOString(), entry_order_id: orderId,
    });
    log.info(`✅ FILLED ${pos.trade_id} @ $${round2(fillPrice).toFixed(2)} | intended $${Number(intended).toFixed(2)} | slippage $${slippage.toFixed(2)}${simulated ? ' (sim)' : ''}`);
    await safeNotify('filled', updated, { slippage });
    return updated;
  }

  /** Close an open leg, compute realized P&L, and record the outcome. */
  async function closePosition(pos, intendedExitPrice, reason, { exitType = 'market' } = {}) {
    const isLong = pos.direction === 'long';
    const exitSide = isLong ? 'sell' : 'buy';
    const cid = clientId(pos.trade_id, 'x');

    let res;
    try {
      res = await broker.placeExit({
        symbol: pos.symbol, qty: pos.shares, side: exitSide,
        type: exitType, limitPrice: intendedExitPrice, clientOrderId: cid,
      });
    } catch (err) {
      log.error(`Exit order FAILED for ${pos.trade_id} (${reason}): ${err.message} — will retry next tick.`);
      return null;
    }

    const exitPrice = round2(res.filledAvgPrice != null ? res.filledAvgPrice : intendedExitPrice);
    const entry = pos.entry_price;
    const risk = Math.abs(entry - pos.stop_price);
    const perShare = isLong ? exitPrice - entry : entry - exitPrice;
    const pnl = round2(perShare * pos.shares);
    const rMultiple = risk > 0 ? round2(perShare / risk) : 0;
    const pnlPct = entry > 0 ? round2((perShare / entry) * 100) : 0;

    const updated = database.updatePosition(pos.trade_id, {
      status: 'closed', exit_time: new Date().toISOString(), exit_price: exitPrice,
      exit_reason: reason, exit_order_id: res.orderId, pnl, pnl_pct: pnlPct, r_multiple: rMultiple,
    });
    const sign = pnl >= 0 ? '+' : '';
    log.info(`🏁 CLOSED ${pos.trade_id} | ${reason} | exit $${exitPrice.toFixed(2)} | P&L ${sign}$${pnl.toFixed(2)} (${sign}${rMultiple}R, ${sign}${pnlPct}%)`);
    await safeNotify('closed', updated, { reason, pnl, rMultiple, pnlPct, exitPrice });
    return updated;
  }

  /** Cancel a pending entry that never filled. */
  async function cancelPending(pos, reason) {
    if (pos.entry_order_id) await broker.cancelOrder(pos.entry_order_id);
    const updated = database.updatePosition(pos.trade_id, {
      status: 'cancelled', exit_reason: reason, exit_time: new Date().toISOString(),
    });
    log.warn(`🚫 ${reason} ${pos.trade_id} — entry never filled, order cancelled.`);
    await safeNotify('cancelled', updated, { reason });
    return updated;
  }

  /** One management pass over every pending/open position. */
  async function manageOpenPositions() {
    const positions = database.getOpenPositions();
    if (!positions.length) return { managed: 0 };
    let managed = 0;

    for (const pos of positions) {
      try {
        if (pos.status === 'pending') {
          await managePending(pos);
        } else if (pos.status === 'open') {
          await manageOpen(pos);
        }
        managed++;
      } catch (err) {
        log.error(`manageOpenPositions: ${pos.trade_id} failed this tick: ${err.message}`);
      }
    }
    return { managed };
  }

  /** Resolve a pending entry: detect fill, or cancel after the 2-min timeout. */
  async function managePending(pos) {
    // Simulated entries are filled at open; this only guards a stray sim pending.
    if (pos.simulated) {
      await markFilled(pos, pos.intended_entry ?? pos.entry_price, pos.entry_order_id, { simulated: true });
      return;
    }
    const od = await broker.pollOrder(pos.entry_order_id);
    if (od?.filled) {
      await markFilled(pos, od.filledAvgPrice ?? pos.intended_entry, pos.entry_order_id);
      return;
    }
    if (od?.canceled) {
      await cancelPending(pos, 'CANCELLED_UNFILLED');
      return;
    }
    const ageSec = (clock() - new Date(pos.opened_at).getTime()) / 1000;
    if (ageSec >= orderFillTimeoutSec) await cancelPending(pos, 'CANCELLED_UNFILLED');
  }

  /** Manage an open leg: kill-switch → stop → target, in protective order. */
  async function manageOpen(pos) {
    const price = await md.getLatestPrice(pos.symbol);
    if (price == null) {
      log.warn(`No price for ${pos.symbol} this tick — cannot manage ${pos.trade_id}.`);
      return;
    }
    const isLong = pos.direction === 'long';
    const risk = Math.abs(pos.entry_price - pos.stop_price);
    const adverse = isLong ? pos.entry_price - price : price - pos.entry_price;

    // Kill switch first — catches a gap that jumps clean past the stop level.
    if (risk > 0 && adverse >= killSwitchRiskMult * risk) {
      await closePosition(pos, price, 'KILL_SWITCH', { exitType: 'market' });
      return;
    }
    const stopHit = isLong ? price <= pos.stop_price : price >= pos.stop_price;
    if (stopHit) {
      await closePosition(pos, pos.stop_price, 'STOP', { exitType: 'market' });
      return;
    }
    const targetHit = isLong ? price >= pos.target_price : price <= pos.target_price;
    if (targetHit) {
      await closePosition(pos, pos.target_price, 'TARGET', { exitType: 'limit' });
    }
  }

  /** Force-close everything (3:55 PM ET EOD, or manual). Cancels pending entries. */
  async function forceCloseAll(reason = EOD_REASON) {
    const positions = database.getOpenPositions();
    if (!positions.length) {
      log.info(`${reason}: no open positions to close.`);
      return { closed: 0, cancelled: 0 };
    }
    log.info(`${reason}: flattening ${positions.length} position(s). ${modeBanner()}`);
    let closed = 0, cancelled = 0;
    for (const pos of positions) {
      try {
        if (pos.status === 'pending') {
          await cancelPending(pos, reason);
          cancelled++;
        } else {
          const price = await md.getLatestPrice(pos.symbol);
          await closePosition(pos, price ?? pos.entry_price, reason, { exitType: 'market' });
          closed++;
        }
      } catch (err) {
        log.error(`${reason}: failed to flatten ${pos.trade_id}: ${err.message}`);
      }
    }
    log.info(`${reason}: ${closed} closed, ${cancelled} cancelled.`);
    return { closed, cancelled };
  }

  /**
   * On startup, reload open positions from the DB so management resumes after a
   * restart. The manage loop reads the DB every tick, so recovery is just a
   * reconciliation log + a Discord summary — no in-memory state to rebuild.
   */
  async function recoverOpenPositions() {
    const positions = database.getOpenPositions();
    if (!positions.length) {
      log.info('Position recovery: no open positions in the DB.');
      return [];
    }
    log.info(`Position recovery: resuming management of ${positions.length} open position(s). ${modeBanner()}`);
    for (const p of positions) {
      log.info(`   ↳ ${p.trade_id} | ${p.status} | ${p.direction} ${p.shares} ${p.symbol} | entry $${(p.entry_price ?? p.intended_entry ?? 0).toFixed?.(2) ?? p.entry_price} | stop $${p.stop_price} | target $${p.target_price}`);
    }
    await safeNotify('recovered', null, { positions });
    return positions;
  }

  /** Notifications must never break the trading loop. */
  async function safeNotify(kind, pos, extra) {
    try {
      await notify(kind, pos, extra);
    } catch (err) {
      log.warn(`Discord ${kind} notification failed: ${err.message}`);
    }
  }

  return {
    openPositionsForSignal, manageOpenPositions, forceCloseAll, recoverOpenPositions,
    // exposed for tests / manual reconciliation
    markFilled, closePosition, cancelPending, modeBanner,
  };
}

// Default singleton wired to the real dependencies.
export const executionEngine = createExecutionEngine();

export default executionEngine;
