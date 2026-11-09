'use strict';
/* Sends alerts to a Telegram bot chat, one at a time, retrying through network drops.
 * The token stays out of logs, responses and the database. Sending is optional and free. */
const QUEUE_MAX = 200;
const GAP_MS = 1100;   // stays under Telegram's limit of about one message a second per chat
const ICON = { breach: '🔴', danger: '🔴', warn: '🟠', good: '🔵' };

function createNotifier(opts) {
  const token = opts.token || '', chatId = opts.chatId || '', api = (opts.apiUrl || 'https://api.telegram.org').replace(/\/$/, '');
  const lanes = new Set(String(opts.lanes || 'risk,trade,setup').split(',').map(s => s.trim()).filter(Boolean));
  const enabled = !!(token && chatId);
  const queue = [];
  let running = false, failures = 0, sent = 0, dropped = 0, lastSentAt = null, lastError = null;

  async function post(text) {
    let r;
    try {
      r = await fetch(api + '/bot' + token + '/sendMessage', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
      });
    } catch (e) { return { ok: false, retry: true, error: 'Couldn’t reach Telegram' }; }
    const b = await r.json().catch(() => ({}));
    if (r.ok && b.ok !== false) return { ok: true };
    const description = String(b.description || 'HTTP ' + r.status).split(token).join('***');
    if (r.status === 429) return { ok: false, retry: true, waitMs: ((b.parameters && b.parameters.retry_after) || 5) * 1000, error: description };
    return { ok: false, retry: r.status >= 500, error: description };
  }

  const sleep = ms => new Promise(res => { const t = setTimeout(res, ms); if (t.unref) t.unref(); });
  async function pump() {
    if (running) return;
    running = true;
    while (queue.length) {
      const res = await post(queue[0]);
      if (res.ok) {
        queue.shift(); failures = 0; sent++; lastSentAt = Date.now(); lastError = null;
        await sleep(GAP_MS);
      } else if (res.retry) {
        lastError = res.error;
        if (failures === 0) console.error('Telegram: ' + res.error + '. Will keep retrying.');
        failures++;
        await sleep(res.waitMs || Math.min(60000, 1000 * Math.pow(2, failures - 1)));
      } else {
        queue.shift(); dropped++; lastError = res.error;
        console.error('Telegram refused a message: ' + res.error);
      }
    }
    running = false;
  }

  function enqueue(text) {
    if (queue.length >= QUEUE_MAX) { queue.shift(); dropped++; }
    queue.push(text);
    pump().catch(() => { running = false; });
  }

  return {
    enabled,
    notify(a) {
      if (!enabled || a.quiet || !lanes.has(a.lane)) return;
      if ((a.lane === 'setup' || a.lane === 'signal') && opts.quietUntil && Date.now() < (Number(opts.quietUntil()) || 0)) return;   // paused with /quiet
      enqueue((ICON[a.level] ? ICON[a.level] + ' ' : '') + a.text);
    },
    send(text) { if (enabled) enqueue(text); },   // a reply to the owner, whatever the alert lanes say
    async sendTest() {
      if (!enabled) return { ok: false, error: 'Add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to .env first.' };
      const res = await post('Master Bitfunded: test message. Telegram alerts are working.');
      if (res.ok) { sent++; lastSentAt = Date.now(); lastError = null; } else lastError = res.error;
      return { ok: res.ok, error: res.ok ? undefined : res.error };
    },
    status() { return { configured: enabled, lanes: Array.from(lanes), queued: queue.length, sent, dropped, lastSentAt, lastError }; }
  };
}

module.exports = { createNotifier };
