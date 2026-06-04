import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load .env manually (no dotenv dependency needed)
const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dir, '.env');
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const [key, ...rest] = line.split('=');
  if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
}

const BASE_URL = process.env.ALPACA_BASE_URL;
const HEADERS = {
  'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
  'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
  'Content-Type': 'application/json',
};

async function request(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: HEADERS,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Alpaca error ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

export const alpaca = {
  // Account
  getAccount: () => request('GET', '/v2/account'),

  // Positions
  getPositions: () => request('GET', '/v2/positions'),
  getPosition: (symbol) => request('GET', `/v2/positions/${symbol}`),
  closePosition: (symbol) => request('DELETE', `/v2/positions/${symbol}`),

  // Orders
  getOrders: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request('GET', `/v2/orders${qs ? '?' + qs : ''}`);
  },
  placeOrder: ({ symbol, qty, side, type = 'market', time_in_force = 'day', limit_price }) =>
    request('POST', '/v2/orders', { symbol, qty, side, type, time_in_force, limit_price }),
  cancelOrder: (orderId) => request('DELETE', `/v2/orders/${orderId}`),
  cancelAllOrders: () => request('DELETE', '/v2/orders'),

  // Market data
  getLatestQuote: async (symbol) => {
    const res = await fetch(
      `https://data.alpaca.markets/v2/stocks/${symbol}/quotes/latest`,
      { headers: HEADERS }
    );
    const data = await res.json();
    if (!res.ok) throw new Error(`Alpaca error ${res.status}: ${JSON.stringify(data)}`);
    return data.quote;
  },
};

// CLI runner — node alpaca.js <command> [args...]
const [,, cmd, ...args] = process.argv;

const commands = {
  account:    () => alpaca.getAccount(),
  positions:  () => alpaca.getPositions(),
  orders:     () => alpaca.getOrders({ status: 'open' }),
  quote:      ([sym]) => alpaca.getLatestQuote(sym),
  buy:        ([sym, qty]) => alpaca.placeOrder({ symbol: sym, qty: Number(qty), side: 'buy' }),
  sell:       ([sym, qty]) => alpaca.placeOrder({ symbol: sym, qty: Number(qty), side: 'sell' }),
  close:      ([sym]) => alpaca.closePosition(sym),
  cancel_all: () => alpaca.cancelAllOrders(),
};

if (cmd && commands[cmd]) {
  commands[cmd](args)
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch(e => { console.error(e.message); process.exit(1); });
} else {
  console.log(`Usage: node alpaca.js <command> [args]

Commands:
  account              Show account info & buying power
  positions            List open positions
  orders               List open orders
  quote   <SYMBOL>     Get latest bid/ask for a stock
  buy     <SYMBOL> <QTY>   Place a market buy order
  sell    <SYMBOL> <QTY>   Place a market sell order
  close   <SYMBOL>     Close a position
  cancel_all           Cancel all open orders
`);
}
