import config from '../../config/config.js';
import logger from '../utils/logger.js';
import * as marketData from '../data/marketData.js';

/**
 * Broker abstraction (Phase 3)
 * ----------------------------
 * The ONE place where the SIMULATION_MODE safety flag is enforced.
 *
 *   simulationMode = true  → log the order the bot WOULD place, return a
 *                            synthetic order object, submit NOTHING to Alpaca.
 *   simulationMode = false → submit a real (paper) order to Alpaca.
 *
 * The execution engine talks only to this layer, so it never needs to know
 * whether it's simulating or trading for real — the behaviour is identical
 * apart from the network call. Sim fills are decided by the engine (it knows
 * the intended/observed price); the broker just acknowledges them.
 *
 * `createBroker()` takes its dependencies so it can be unit-tested with fakes;
 * the default export is a singleton wired to the real Alpaca client + config.
 */

const TERMINAL = new Set(['filled', 'canceled', 'cancelled', 'expired', 'rejected', 'done_for_day']);

export function createBroker({
  simulationMode,
  md = marketData,
  log = logger,
} = {}) {
  const mode = simulationMode ? 'SIMULATION' : 'LIVE';
  const tag = simulationMode ? '[SIM]' : '[LIVE]';

  return {
    simulationMode,
    mode,

    /**
     * Place an entry order (always a DAY limit).
     * @returns {{orderId, status, simulated, submittedAt}}
     */
    async placeEntry({ symbol, qty, side, limitPrice, clientOrderId }) {
      const desc = `${side.toUpperCase()} ${qty} ${symbol} LIMIT $${Number(limitPrice).toFixed(2)} (DAY)`;
      if (simulationMode) {
        log.info(`${tag} WOULD PLACE ENTRY — ${desc} [client_order_id=${clientOrderId}]`);
        return { orderId: `sim-${clientOrderId}`, status: 'accepted', simulated: true, submittedAt: new Date().toISOString() };
      }
      const order = await md.createOrder({
        symbol, qty, side, type: 'limit', time_in_force: 'day',
        limit_price: Number(limitPrice).toFixed(2), client_order_id: clientOrderId,
      });
      log.info(`${tag} ENTRY SUBMITTED — ${desc} [id=${order.id}]`);
      return { orderId: order.id, status: order.status, simulated: false, submittedAt: order.submitted_at };
    },

    /**
     * Poll a live order's status. Returns null in simulation (sim fills are
     * driven by the engine, not by polling a non-existent order).
     * @returns {null | {status, filled, canceled, filledQty, filledAvgPrice}}
     */
    async pollOrder(orderId) {
      if (simulationMode) return null;
      const o = await md.getOrder(orderId);
      const status = o.status;
      return {
        status,
        filled: status === 'filled',
        canceled: ['canceled', 'cancelled', 'expired', 'rejected'].includes(status),
        terminal: TERMINAL.has(status),
        filledQty: Number(o.filled_qty || 0),
        filledAvgPrice: o.filled_avg_price != null ? Number(o.filled_avg_price) : null,
      };
    },

    /** Cancel an open order. No-op (logged) in simulation. */
    async cancelOrder(orderId) {
      if (simulationMode) {
        log.info(`${tag} WOULD CANCEL order ${orderId}`);
        return { ok: true, simulated: true };
      }
      try {
        await md.cancelOrder(orderId);
        log.info(`${tag} cancelled order ${orderId}`);
        return { ok: true, simulated: false };
      } catch (err) {
        // 404 / already-filled → treat as benign; caller reconciles via pollOrder.
        log.warn(`${tag} cancel order ${orderId} failed: ${err.message}`);
        return { ok: false, error: err.message };
      }
    },

    /**
     * Place an exit order to flatten `qty` shares. Type is 'limit' for targets,
     * 'market' for stops/kill-switch/EOD (we only fire once the level is already
     * breached, so a market fill is the reliable choice).
     * @returns {{orderId, status, simulated, filledAvgPrice}}
     */
    async placeExit({ symbol, qty, side, type = 'market', limitPrice, clientOrderId }) {
      const priceStr = type === 'limit' ? ` $${Number(limitPrice).toFixed(2)}` : '';
      const desc = `${side.toUpperCase()} ${qty} ${symbol} ${type.toUpperCase()}${priceStr}`;
      if (simulationMode) {
        log.info(`${tag} WOULD PLACE EXIT — ${desc} [client_order_id=${clientOrderId}]`);
        return { orderId: `sim-${clientOrderId}`, status: 'accepted', simulated: true, filledAvgPrice: null };
      }
      const body = {
        symbol, qty, side, type, time_in_force: 'day', client_order_id: clientOrderId,
        ...(type === 'limit' ? { limit_price: Number(limitPrice).toFixed(2) } : {}),
      };
      const order = await md.createOrder(body);
      log.info(`${tag} EXIT SUBMITTED — ${desc} [id=${order.id}]`);
      // Best-effort fill price: poll briefly for the average fill on a market exit.
      let filledAvgPrice = order.filled_avg_price != null ? Number(order.filled_avg_price) : null;
      if (filledAvgPrice == null) filledAvgPrice = await this._waitForFill(order.id);
      return { orderId: order.id, status: order.status, simulated: false, filledAvgPrice };
    },

    /** Poll a just-submitted order a few times for its average fill price. */
    async _waitForFill(orderId, { tries = 5, intervalMs = 600 } = {}) {
      for (let i = 0; i < tries; i++) {
        try {
          const o = await md.getOrder(orderId);
          if (o.filled_avg_price != null) return Number(o.filled_avg_price);
          if (['canceled', 'cancelled', 'expired', 'rejected'].includes(o.status)) return null;
        } catch (err) {
          log.warn(`_waitForFill(${orderId}) poll failed: ${err.message}`);
        }
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      return null; // fall back to the engine's intended price
    },
  };
}

// Default singleton wired to the real config + Alpaca market-data client.
export const broker = createBroker({ simulationMode: config.execution.simulationMode });

export default broker;
