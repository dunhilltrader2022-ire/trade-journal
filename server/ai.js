'use strict';
/* Claude through the Anthropic API, with a monthly spending cap. The key stays on the server. */
const MODELS = {
  quick: process.env.CLAUDE_MODEL_QUICK || 'claude-haiku-5-5',
  default: process.env.CLAUDE_MODEL_DEFAULT || 'claude-sonnet-5-5',
  complex: process.env.CLAUDE_MODEL_COMPLEX || 'claude-opus-5-5'
};
// USD per million tokens [input, output] (Claude Platform pricing page, Nov 2026). Override with CLAUDE_PRICES as JSON.
const PRICES = Object.assign({
  'claude-haiku-5-5': [0.10, 0.50],
  'claude-sonnet-5-5': [2, 10],
  'claude-opus-5-5': [4, 20]
}, process.env.CLAUDE_PRICES ? JSON.parse(process.env.CLAUDE_PRICES) : {});
const MAX_TOKENS = { quick: 1024, default: 8000, complex: 16000 };

function monthKey(d) { const t = new Date(d || Date.now()); return t.getUTCFullYear() + '-' + String(t.getUTCMonth() + 1).padStart(2, '0'); }
function cap() { return Number(process.env.AI_MONTHLY_CAP_USD || 10); }
function configured() { return !!process.env.ANTHROPIC_API_KEY; }

function status(db) {
  const m = db.get('ai', monthKey()) || { cost: 0, calls: 0 };
  return { configured: configured(), month: monthKey(), spentUsd: +m.cost.toFixed(4), calls: m.calls, capUsd: cap(), models: MODELS };
}

class AIError extends Error { constructor(code, message, http) { super(message); this.code = code; this.http = http || 400; } }

async function ask(db, body, signal) {
  if (!configured()) throw new AIError('not_configured', 'Add ANTHROPIC_API_KEY to the .env file and restart the cockpit.', 503);
  const tier = ['quick', 'default', 'complex'].includes(body.modelTier) ? body.modelTier : 'default';
  const model = MODELS[tier];
  const st = status(db);
  if (st.spentUsd >= st.capUsd) throw new AIError('rate_limited', 'This month’s Claude budget of $' + st.capUsd + ' is used up. Raise AI_MONTHLY_CAP_USD in .env to continue.', 429);
  let messages;
  if (typeof body.input === 'string') messages = [{ role: 'user', content: body.input }];
  else if (Array.isArray(body.input)) messages = body.input.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim());
  if (!messages || !messages.length) throw new AIError('invalid_request', 'Nothing to send.');
  // The API needs alternating roles starting with user: merge consecutive same-role turns.
  const merged = [];
  for (const m of messages) { const last = merged[merged.length - 1]; if (last && last.role === m.role) last.content += '\n\n' + m.content; else merged.push({ role: m.role, content: m.content }); }
  if (merged[0].role !== 'user' || merged[merged.length - 1].role !== 'user') throw new AIError('invalid_request', 'The conversation must start and end with your message.');
  const base = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  let r;
  try {
    r = await fetch(base + '/v1/messages', {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: MAX_TOKENS[tier], messages: merged })
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new AIError('cancelled', 'Stopped.', 499);
    throw new AIError('upstream_error', 'Couldn’t reach the Claude API: ' + e.message, 502);
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (data.error && data.error.message) || ('HTTP ' + r.status);
    if (r.status === 401) throw new AIError('session_expired', 'The API key was rejected. Check ANTHROPIC_API_KEY in .env.', 502);
    if (r.status === 429 || r.status === 529) throw new AIError('rate_limited', 'Claude is busy right now. Try again in a minute.', 429);
    throw new AIError('upstream_error', msg, 502);
  }
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  if (!text.trim()) throw new AIError('empty_completion', 'Claude returned no text.', 502);
  const u = data.usage || {};
  const p = PRICES[data.model] || PRICES[model] || [0, 0];
  const cost = ((u.input_tokens || 0) * p[0] + (u.output_tokens || 0) * p[1]) / 1e6;
  const key = monthKey(), m = db.get('ai', key) || { cost: 0, calls: 0 };
  db.put('ai', key, { cost: m.cost + cost, calls: m.calls + 1 });
  return { text, truncated: data.stop_reason === 'max_tokens', modelTierApplied: tier, model: data.model || model, usage: u, costUsd: +cost.toFixed(5) };
}

module.exports = { ask, status, AIError, MODELS, PRICES };
