import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dir, '.env');
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const [key, ...rest] = line.split('=');
  if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
}

const API_KEY = process.env.PERPLEXITY_API_KEY;

export async function ask(prompt, { model = 'sonar', systemPrompt } = {}) {
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`Perplexity error ${res.status}: ${JSON.stringify(data)}`);
  return data.choices[0].message.content;
}

export async function stockResearch(symbols) {
  const list = Array.isArray(symbols) ? symbols.join(', ') : symbols;
  return ask(
    `Give me a brief pre-market summary for these stocks: ${list}.
     For each: recent news (last 24h), analyst sentiment, any earnings/events today, and a one-line trade outlook.
     Be concise and factual.`,
    {
      model: 'sonar',
      systemPrompt: 'You are a financial research assistant. Provide factual, concise pre-market briefings for traders. No disclaimers.',
    }
  );
}

// CLI — node perplexity.js "your question"  OR  node perplexity.js research AAPL TSLA NVDA
const [,, cmd, ...args] = process.argv;

if (cmd === 'research') {
  stockResearch(args)
    .then(r => console.log(r))
    .catch(e => { console.error(e.message); process.exit(1); });
} else if (cmd) {
  ask([cmd, ...args].join(' '))
    .then(r => console.log(r))
    .catch(e => { console.error(e.message); process.exit(1); });
} else {
  console.log(`Usage:
  node perplexity.js research AAPL TSLA NVDA     Pre-market stock research
  node perplexity.js "your question here"         Ask anything (live web search)
`);
}
