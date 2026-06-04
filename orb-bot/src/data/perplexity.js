import config from '../../config/config.js';
import logger from '../utils/logger.js';

/**
 * Perplexity catalyst classifier
 * ------------------------------
 * Given a gapping stock, asks Perplexity (live web search) to identify WHY it's
 * gapping and how tradeable that catalyst is. Returns a structured object the
 * gap scanner uses to filter low-quality gaps and that we persist with trades.
 *
 * Quality scale: high > medium > low > none.
 */

const { perplexity, catalyst } = config;

const QUALITY_RANK = { high: 3, medium: 2, low: 1, none: 0 };

/** Numeric rank for a quality label (defaults to 0/none). */
export function qualityRank(q) {
  return QUALITY_RANK[q] ?? 0;
}

const SYSTEM_PROMPT = `You are a pre-market equity catalyst analyst for a day-trading bot.
Given a stock that is gapping pre-market, identify the SINGLE most likely catalyst
driving the move using current news (last 48 hours). Be factual and concise.

Respond with ONLY a JSON object, no prose, no markdown fences:
{
  "catalyst_type": one of [${catalyst.types.join(', ')}],
  "catalyst_summary": "one factual sentence citing the specific news, or 'No identifiable catalyst found'",
  "quality": "high" | "medium" | "low" | "none",
  "sentiment": "bullish" | "bearish" | "neutral",
  "tradeable": true | false,
  "confidence": 0.0-1.0
}

Quality guidance:
- high: clear, material, fresh fundamental catalyst (earnings beat/miss, M&A, FDA, major guidance, big analyst action with price target)
- medium: real but lesser news (minor upgrade, product announcement, sector sympathy move with a named driver)
- low: vague/rumor/thin news, or a move not well explained by news
- none: no identifiable catalyst (likely technical/low-float noise)
Set tradeable=false for: offering/dilution on a gap up, pure low-float pumps with no news, or quality "none".`;

/** Build the user prompt for one candidate. */
function userPrompt({ symbol, name, gapPct, prevClose, price }) {
  const dir = gapPct >= 0 ? 'UP' : 'DOWN';
  return `Stock: ${symbol}${name ? ` (${name})` : ''}
Gapping ${dir} ${Math.abs(gapPct).toFixed(2)}% pre-market (prev close $${prevClose?.toFixed?.(2)}, pre-market ~$${price?.toFixed?.(2)}).
What is the catalyst? Return the JSON object only.`;
}

/** Parse a JSON object out of a model response that may include stray text/fences. */
export function parseCatalystJson(content) {
  if (!content) return null;
  let text = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  // Grab the first {...} block if there's surrounding prose.
  const match = text.match(/\{[\s\S]*\}/);
  if (match) text = match[0];
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const UNKNOWN = (reason) => ({
  catalyst_type: 'unknown',
  catalyst_summary: reason,
  quality: 'none',
  sentiment: 'neutral',
  tradeable: false,
  confidence: 0,
  classified: false,
});

/**
 * Classify the catalyst for one gapping candidate.
 * Returns a normalized object; never throws (fails to an UNKNOWN record).
 */
export async function classifyCatalyst(candidate) {
  if (!perplexity.apiKey) {
    logger.warn('No PERPLEXITY_API_KEY set; skipping catalyst classification');
    return UNKNOWN('no api key');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), catalyst.requestTimeoutMs);
  try {
    const res = await fetch(perplexity.baseUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${perplexity.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: catalyst.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt(candidate) },
        ],
        temperature: 0.1,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error(`Perplexity ${res.status} for ${candidate.symbol}: ${body.slice(0, 200)}`);
      return UNKNOWN(`api error ${res.status}`);
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    const parsed = parseCatalystJson(content);
    if (!parsed) {
      logger.warn(`Could not parse catalyst JSON for ${candidate.symbol}`);
      return UNKNOWN('unparseable response');
    }

    // Normalize / clamp fields.
    const type = catalyst.types.includes(parsed.catalyst_type) ? parsed.catalyst_type : 'unknown';
    const quality = ['high', 'medium', 'low', 'none'].includes(parsed.quality) ? parsed.quality : 'none';
    return {
      catalyst_type: type,
      catalyst_summary: String(parsed.catalyst_summary || '').slice(0, 500),
      quality,
      sentiment: ['bullish', 'bearish', 'neutral'].includes(parsed.sentiment) ? parsed.sentiment : 'neutral',
      tradeable: Boolean(parsed.tradeable),
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
      classified: true,
    };
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'timeout' : err.message;
    logger.error(`Catalyst classification failed for ${candidate.symbol}: ${reason}`);
    return UNKNOWN(reason);
  } finally {
    clearTimeout(timer);
  }
}

// CLI: node src/data/perplexity.js TSLA 4.2
if (process.argv[1]?.endsWith('perplexity.js')) {
  const [, , sym = 'NVDA', gap = '3.5'] = process.argv;
  classifyCatalyst({ symbol: sym, gapPct: Number(gap), prevClose: 100, price: 100 * (1 + Number(gap) / 100) })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error(e.message); process.exit(1); });
}

export default { classifyCatalyst, qualityRank };
