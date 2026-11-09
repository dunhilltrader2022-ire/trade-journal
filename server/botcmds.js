'use strict';
/* Answers the owner's questions in Telegram (/status, /positions, /room, /alerts, /today, /check),
 * sends a daily summary after the Bitfunded reset, and handles two small changes: /alert sets a
 * price alert and /quiet pauses non-urgent alerts. It never touches trades or orders.
 * It asks Telegram for new messages itself (long polling), so nothing needs opening on the router.
 * Only the chat in TELEGRAM_CHAT_ID gets an answer; everyone else is ignored. */
const R = require('./lib/rules.js');
const { validateDoc } = require('./validate.js');

const HOUR = 3600000, MIN = 60000, DAY = 86400000;
const QUIET_LANES = ['setup', 'signal'];   // price alerts and RSI; rule warnings, closed trades and feed problems still come through
const fmt = (n, d) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const money = n => (n < 0 ? '−$' : '$') + fmt(Math.abs(n), 0);
const signed = n => (n >= 0 ? '+' : '') + money(n);
const px = (sym, n) => fmt(n, R.assetInfo(sym).decimals);
const qty = n => Number(n).toLocaleString('en-US', { maximumFractionDigits: 4 });
const london = ms => new Date(ms).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const dur = ms => { if (ms <= 0) return 'now'; const h = Math.floor(ms / HOUR), m = Math.floor(ms % HOUR / MIN); return h >= 48 ? Math.floor(h / 24) + 'd ' + (h % 24) + 'h' : h ? h + 'h ' + m + 'm' : m + 'm'; };

const COMMANDS = [
  ['status', 'Room left and open positions on each account'],
  ['positions', 'Every open trade in detail'],
  ['room', 'Daily and total room, target and reset time'],
  ['today', 'Today so far: closed trades, P/L and limits used'],
  ['check', 'Check a trade first, e.g. /check BTC long stop 79500 risk 100'],
  ['alert', 'Set a price alert, e.g. /alert BTC 82000'],
  ['quiet', 'Pause price alerts, e.g. /quiet 1h (or /quiet off)'],
  ['alerts', 'The last 5 alerts'],
  ['help', 'What I can answer']
];
const GAUGE_NAME = { daily: 'Daily loss', total: 'Total loss', positions: 'Open positions', exposure: 'Margin exposure' };
const LEVEL_WORDS = { warn: 'past 60%', danger: 'past 90%', breach: 'reached the limit' };
const RANK = { warn: 1, danger: 2, breach: 3 };
function floorSize(s) { const d = s >= 1000 ? 0 : s >= 10 ? 2 : s >= 1 ? 3 : 6, m = Math.pow(10, d); return Math.floor(s * m) / m; }
const num = t => { const v = Number(String(t).replace(/[$,]/g, '')); return Number.isFinite(v) ? v : NaN; };

function createBot({ db, feed, notifier, token, chatId, apiUrl, now, broadcast, syncFeed }) {
  const api = (apiUrl || 'https://api.telegram.org').replace(/\/$/, '');
  const pollSeconds = Number(process.env.TELEGRAM_POLL_SECONDS) || 25;
  const enabled = !!(token && chatId) && process.env.TELEGRAM_COMMANDS !== 'off';
  let offset = 0, failures = 0, answered = 0, lastError = null, stopped = false;
  const startedAt = Date.now();

  const clock = () => (now ? now() : Date.now());
  const accounts = () => db.list('accounts').filter(a => a.status === 'active').sort((a, b) => (a.paper ? 1 : 0) - (b.paper ? 1 : 0) || String(a.name).localeCompare(String(b.name)));
  const trades = () => db.list('trades');
  const live = sym => feed.source === 'simulated' || feed.src[sym] === 'live';
  function priceLine() {
    if (feed.source === 'simulated') return 'Prices: simulated';
    const st = feed.status, fresh = st.state === 'connected' && st.lastMessageAt && Date.now() - st.lastMessageAt < 30000;
    return fresh ? 'Prices: live' : 'Prices: NOT live right now, so these figures may be out of date';
  }
  function head(title) {
    const t = clock(), day = R.dayBounds(t);
    return 'Master Bitfunded · ' + title + '\n' + london(t) + ' London · ' + priceLine() + '\nDay resets in ' + dur(day.nominalReset - t);
  }
  const label = a => a.name + ' · ' + (a.paper ? 'Paper' : a.stage);

  function status() {
    const list = accounts(), all = trades(), t = clock();
    if (!list.length) return head('Status') + '\n\nNo active accounts.';
    return head('Status') + '\n\n' + list.map(a => {
      const m = R.accountMetrics(a, all, feed.prices, t), open = all.filter(x => x.accountId === a.id && x.status === 'open');
      const daily = m.gauges[0];
      const lines = [label(a),
        'Room today ' + money(Math.max(0, m.dailyRoom)) + ' of ' + money(m.dailyRoom + m.dailyLoss) + (daily.level === 'ok' ? '' : ' (' + { warn: 'watch', danger: 'slow down', breach: 'limit reached' }[daily.level] + ')') + ' · Total room ' + money(Math.max(0, m.totalRoom)),
        open.length ? 'Open ' + open.length + ' of ' + m.cfg.maxPositions + ' · floating ' + signed(m.unrealized) + ' · exposure ' + m.exposurePct.toFixed(0) + '%' : 'No open positions'];
      for (const x of open) {
        const stop = Number(x.sl) > 0 ? R.pnlAt(x, Number(x.sl)) : null;
        lines.push('  ' + x.symbol + ' ' + x.side + ' ' + signed(R.pnlAt(x, feed.prices[x.symbol])) + (stop == null ? ' · NO STOP' : ' · ' + signed(stop) + ' if stopped') + (live(x.symbol) ? '' : ' · no live price'));
      }
      return lines.join('\n');
    }).join('\n\n');
  }

  function positions() {
    const list = accounts(), all = trades(), t = clock(), out = [head('Positions')];
    let any = false;
    for (const a of list) {
      const open = all.filter(x => x.accountId === a.id && x.status === 'open');
      if (!open.length) continue;
      any = true;
      out.push('', label(a));
      for (const x of open) {
        const s = R.summarize(x), p = feed.prices[x.symbol], f = R.positionFlags(x, a, t);
        const stop = Number(x.sl) > 0 ? R.pnlAt(x, Number(x.sl)) : null, target = Number(x.tp) > 0 ? R.pnlAt(x, Number(x.tp)) : null;
        out.push(x.symbol + ' ' + x.side + ' ' + qty(s.size) + ' @ ' + px(x.symbol, s.avgEntry) + (x.fills.length > 1 ? ' (' + x.fills.length + ' fills)' : ''),
          '  Now ' + (p > 0 ? px(x.symbol, p) : '—') + ' · P/L ' + signed(R.pnlAt(x, p)) + (live(x.symbol) ? '' : ' (no live price)'),
          '  Stop ' + (stop == null ? 'NONE' : px(x.symbol, Number(x.sl)) + ' (' + signed(stop) + ')') + ' · Target ' + (target == null ? 'none' : px(x.symbol, Number(x.tp)) + ' (' + signed(target) + ')'),
          '  Hold limit in ' + dur(f.holdLeftMs) + ' · fees ' + money(x.fees || 0));
      }
    }
    if (!any) out.push('', 'No open positions.');
    return out.join('\n');
  }

  function room() {
    const list = accounts(), all = trades(), t = clock();
    if (!list.length) return head('Room') + '\n\nNo active accounts.';
    return head('Room') + '\n\n' + list.map(a => {
      const m = R.accountMetrics(a, all, feed.prices, t), floor = a.size * (1 - m.cfg.maxLossPct / 100);
      const floating = Math.max(0, m.dailyLoss - m.realizedPart);
      const lines = [label(a),
        'Today: ' + money(Math.max(0, m.dailyRoom)) + ' left of ' + money(m.dailyRoom + m.dailyLoss) + ' (' + m.cfg.dailyLossPct + '%). Used ' + money(m.dailyLoss) + ': ' + money(m.realizedPart) + ' realised, ' + money(floating) + ' floating',
        'Total: ' + money(Math.max(0, m.totalRoom)) + ' above your ' + money(floor) + ' floor (' + m.cfg.maxLossPct + '%) · equity ' + money(m.equity)];
      if (m.targetPct != null) lines.push('Target: ' + money(m.realizedAll) + ' of ' + money(a.size * m.targetPct / 100) + ' from closed trades · qualifying trades ' + m.qualifyingClosed + ' of ' + m.cfg.minClosedTrades);
      else lines.push('Funded P/L: ' + signed(m.realizedAll) + ' from closed trades');
      return lines.join('\n');
    }).join('\n\n');
  }

  function alerts() {
    const items = ((db.get('meta', 'feed') || {}).items || []).slice(0, 5);
    if (!items.length) return 'Master Bitfunded · Alerts\n\nNo alerts yet.';
    return 'Master Bitfunded · Alerts\n\n' + items.map(a => london(a.t) + ' · ' + a.text).join('\n\n');
  }

  function help() {
    return 'Master Bitfunded · what I can answer\n\n' + COMMANDS.map(c => '/' + c[0] + ' · ' + c[1]).join('\n') +
      '\n\nYou can also write a few words, like "what’s my position status". I can set a price alert and pause alerts, but I can’t place, close or change a trade. Check Bitfunded for the real account.';
  }

  /* ---------- the bot's own small state: last summary sent, quiet time ---------- */
  const botState = () => db.get('meta', 'botstate') || {};
  function saveState(changes) {
    const doc = Object.assign({}, botState(), changes);
    db.put('meta', 'botstate', doc);
    if (broadcast) broadcast('change', { coll: 'meta', id: 'botstate', doc: Object.assign({ id: 'botstate' }, doc), origin: 'server' });
  }

  /* ---------- a day's summary, for /today and after each reset ---------- */
  function summary(start, end, final) {
    const list = accounts(), all = trades(), t = clock(), watch = db.get('meta', 'watch') || {}, fired = watch.fired || {};
    const title = final ? 'Daily summary\nBitfunded day ' + london(start) + ' to ' + london(end) + ' London' : 'Today so far\n' + london(t) + ' London · ' + priceLine() + '\nDay resets in ' + dur(R.dayBounds(t).nominalReset - t);
    if (!list.length) return 'Master Bitfunded · ' + title + '\n\nNo active accounts.';
    return 'Master Bitfunded · ' + title + '\n\n' + list.map(a => {
      const cfg = R.rulesFor(a), m = R.accountMetrics(a, all, feed.prices, t), limit = a.size * cfg.dailyLossPct / 100;
      const closed = all.filter(x => x.accountId === a.id && x.status === 'closed' && x.exit && x.exit.t >= start && x.exit.t < end).sort((x, y) => x.exit.t - y.exit.t);
      const pnl = closed.reduce((s, x) => s + R.realized(x), 0);
      let losses = closed.reduce((s, x) => s + Math.max(0, -R.realized(x)), 0);
      if (a.priorDayLoss && a.priorDayLoss.day === start && a.priorDayLoss.amount > 0) losses += Number(a.priorDayLoss.amount);
      const used = final ? losses : m.dailyLoss;
      const lines = [label(a),
        closed.length ? 'Closed ' + closed.length + ' trade' + (closed.length === 1 ? '' : 's') + ' · P/L ' + signed(pnl) : 'No trades closed',
        'Daily loss used ' + money(used) + ' of ' + money(limit) + ' (' + (used / limit * 100).toFixed(0) + '%)' + (final ? ', realised' : ', with floating')];
      for (const x of closed.slice(0, 8)) lines.push('  ' + x.symbol + ' ' + x.side + ' ' + signed(R.realized(x)) + ' (' + x.exit.reason + ')');
      if (closed.length > 8) lines.push('  and ' + (closed.length - 8) + ' more');
      const hit = {};
      for (const k of Object.keys(fired)) {
        const p = k.split(':');   // account:gauge:level:dayStart
        if (p.length !== 4 || p[0] !== a.id || Number(p[3]) !== start || !RANK[p[2]]) continue;
        if (!hit[p[1]] || RANK[p[2]] > RANK[hit[p[1]]]) hit[p[1]] = p[2];
      }
      const warned = Object.keys(hit).map(g => (GAUGE_NAME[g] || g) + ' ' + LEVEL_WORDS[hit[g]]);
      if (warned.length) lines.push('Warnings: ' + warned.join('; '));
      const open = all.filter(x => x.accountId === a.id && x.status === 'open').length;
      lines.push('Now: total room ' + money(Math.max(0, m.totalRoom)) + (m.targetPct != null ? ' · target ' + money(m.realizedAll) + ' of ' + money(a.size * m.targetPct / 100) : '') + ' · ' + (open ? open + ' open, floating ' + signed(m.unrealized) : 'no open positions'));
      return lines.join('\n');
    }).join('\n\n');
  }
  function today() { const t = clock(), d = R.dayBounds(t); return summary(d.start, t + 1, false); }

  /* After each Bitfunded reset (once settlement has passed), one summary of the day that ended. */
  function checkDaily() {
    if (process.env.TELEGRAM_DAILY === 'off') return;
    try {
      const d = R.dayBounds(clock()), st = botState();
      if (!st.summaryDay) return saveState({ summaryDay: d.start });   // first run: start from the next reset
      if (st.summaryDay >= d.start) return;
      saveState({ summaryDay: d.start });
      notifier.send(summary(d.start - DAY, d.start, true));
    } catch (e) { console.error('Telegram daily summary failed:', String(e && e.message || e)); }
  }

  /* ---------- /check: the trade form's rule check, from the chat ---------- */
  function check(original) {
    const usage = 'Check a trade before you enter it on Bitfunded:\n/check BTC long stop 79500 risk 100\n/check ETH short 2450 stop 2480 tp 2380 size 2 lev 10 on 15K\n\nThe price is optional (it uses the price now). Give risk ($) or size, and add "on" and part of an account name to pick one.';
    const words = String(original).replace(/^\/check(@\S+)?/i, '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return usage;
    const o = {};
    for (let i = 0; i < words.length; i++) {
      const w = words[i].toLowerCase(), next = () => num(words[++i]);
      if (w === 'long' || w === 'buy') o.side = 'Long';
      else if (w === 'short' || w === 'sell') o.side = 'Short';
      else if (w === 'stop' || w === 'sl') o.sl = next();
      else if (w === 'tp' || w === 'target') o.tp = next();
      else if (w === 'risk') o.risk = next();
      else if (w === 'size' || w === 'qty') o.size = next();
      else if (w === 'lev' || w === 'leverage') o.lev = next();
      else if (/^\d+(\.\d+)?x$/.test(w)) o.lev = Number(w.slice(0, -1));
      else if (w === 'on' || w === 'acct' || w === 'account') { o.acct = words.slice(i + 1).join(' ').toLowerCase(); break; }
      else if (w === '@' || w === 'at') continue;
      else if (!Number.isNaN(num(w)) && o.entry == null) o.entry = num(w);
      else if (!o.symbol) o.symbol = R.parseSymbol(words[i]);
    }
    if (!o.symbol || !R.ASSETS[o.symbol]) return 'I don’t know that pair.\n\n' + usage;
    if (!o.side) return 'Say long or short.\n\n' + usage;
    if (!(o.sl > 0)) return 'Give a stop, like "stop 79500".\n\n' + usage;
    const market = feed.prices[o.symbol], entry = o.entry > 0 ? o.entry : market;
    if (!(entry > 0)) return 'I don’t have a price for ' + o.symbol + ' yet. Add your entry price.';
    const dist = Math.abs(entry - o.sl);
    if (!(o.size > 0) && !(o.risk > 0)) return 'Give your risk in dollars or a size, like "risk 100".\n\n' + usage;
    let list = accounts().filter(a => !a.paper);
    if (!list.length) list = accounts();
    if (o.acct) { const want = list.filter(a => String(a.name).toLowerCase().includes(o.acct) || String(a.size / 1000 + 'k') === o.acct.replace(/\s/g, '')); if (!want.length) return 'No active account matches "' + o.acct + '". Your accounts: ' + list.map(a => a.name).join(', ') + '.'; list = want; }
    const t = clock(), all = trades();
    const out = ['Master Bitfunded · Check', o.symbol + ' ' + o.side + ' at ' + px(o.symbol, entry) + (o.entry > 0 ? ' (your price)' : ' (price now)') + ' · stop ' + px(o.symbol, o.sl) + (o.tp > 0 ? ' · target ' + px(o.symbol, o.tp) : '')];
    if (!live(o.symbol)) out.push('No live price for this pair: the cockpit won’t watch its stop.');
    for (const a of list.slice(0, 4)) {
      const cfg = R.rulesFor(a), m = R.accountMetrics(a, all, feed.prices, t);
      const lev = o.lev > 0 ? o.lev : Math.min(5, cfg.maxLeverage);
      const size = o.size > 0 ? o.size : (dist > 0 ? floorSize(o.risk / dist) : 0);
      if (!(size > 0)) { out.push('', label(a), 'That stop is at the entry price, so I can’t size it.'); continue; }
      const pre = R.preTrade(a, m, { t, side: o.side, price: entry, size, lev, sl: o.sl, tp: o.tp > 0 ? o.tp : '' }, null);
      const notional = entry * size, lines = ['', label(a),
        'Size ' + qty(size) + ' ' + R.assetInfo(o.symbol).unit + ' · notional ' + money(notional) + ' · margin ' + money(notional / lev) + ' at ' + lev + 'x',
        'Risk to stop ' + (pre.risk == null ? 'none' : pre.invalid ? 'not valid with this stop' : money(pre.risk)) + (o.tp > 0 && !pre.invalid && dist > 0 ? ' · reward ' + money(Math.abs(o.tp - entry) * size) + ' · ' + (Math.abs(o.tp - entry) / dist).toFixed(1) + ' : 1' : '')];
      if (pre.projectedDailyPct != null) lines.push((m.openRisks.length ? 'If every stop is hit' : 'If the stop is hit') + ': daily ' + pre.projectedDailyPct.toFixed(2) + '% of ' + cfg.dailyLossPct + '% · total ' + pre.projectedTotalPct.toFixed(2) + '% of ' + cfg.maxLossPct + '%');
      lines.push('Exposure after ' + pre.exposureAfterPct.toFixed(0) + '% of ' + cfg.maxExposurePct + '% · position ' + (m.openCount + 1) + ' of ' + cfg.maxPositions);
      for (const c of pre.checks) if (!c.ok) lines.push('• ' + c.text);
      lines.push(pre.blocked ? (pre.invalid ? 'Fix the stop or target first.' : 'The cockpit would pause this: it goes past a Bitfunded rule.') : 'Within your Bitfunded limits.');
      out.push.apply(out, lines);
    }
    out.push('', 'Nothing was logged. This checks the rules only; it isn’t advice.');
    return out.join('\n');
  }

  /* ---------- /alert: set a price alert ---------- */
  function alert(original) {
    const words = String(original).replace(/^\/alert(@\S+)?/i, '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      const act = db.list('levels').filter(l => l.active).sort((x, y) => String(x.symbol).localeCompare(String(y.symbol)) || x.price - y.price);
      return 'Master Bitfunded · Price alerts\n\n' + (act.length ? act.map(l => l.symbol + ' at ' + px(l.symbol, l.price) + (l.note ? ' · ' + l.note : '')).join('\n') : 'None set.') +
        '\n\nTo add one: /alert BTC 82000 breakout level\nRemove alerts on the site.';
    }
    const symbol = R.parseSymbol(words[0]), price = num(words[1]);
    if (!symbol || !R.ASSETS[symbol]) return 'I don’t know that pair. Try: /alert BTC 82000';
    if (!(price > 0)) return 'Give a price above zero. Try: /alert ' + symbol.split('/')[0] + ' 82000';
    const note = words.slice(2).join(' ').slice(0, 80);
    const doc = { id: 'lvl-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), symbol, price, note, active: true, createdAt: clock(), via: 'telegram' };
    const bad = validateDoc('levels', doc);
    if (bad) return bad;
    db.put('levels', doc.id, doc);
    if (broadcast) broadcast('change', { coll: 'levels', id: doc.id, doc, origin: 'server' });
    if (syncFeed) syncFeed();
    const p = feed.prices[symbol];
    return 'Price alert set: ' + symbol + ' at ' + px(symbol, price) + (note ? ' · ' + note : '') +
      (p > 0 ? '\nNow ' + px(symbol, p) + ', ' + (Math.abs(price / p - 1) * 100).toFixed(2) + '% away.' : '') +
      (live(symbol) ? '\nI’ll message you when the price crosses it.' : '\nThere’s no live price for this pair, so this alert won’t fire.') +
      (quietUntil() > Date.now() ? '\nAlerts are paused until ' + london(quietUntil()) + ', so it will only show on the site until then.' : '') +
      '\nRemove it on the site if you change your mind.';
  }

  /* ---------- /quiet: pause price alerts and RSI signals ---------- */
  function quietUntil() { return Number(botState().quietUntil) || 0; }
  function quiet(original) {
    const arg = String(original).replace(/^\/quiet(@\S+)?/i, '').trim().toLowerCase();
    if (arg === 'off' || arg === 'stop' || arg === 'end') { saveState({ quietUntil: 0 }); return 'Alerts are back on.'; }
    const m = arg.match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?)?$/);
    if (arg && !m) return 'Try /quiet 30m, /quiet 2h or /quiet off.';
    let ms = m ? Number(m[1]) * (/^m/.test(m[2] || 'h') ? MIN : HOUR) : HOUR;
    ms = Math.min(Math.max(ms, MIN), 24 * HOUR);
    const until = Date.now() + ms;
    saveState({ quietUntil: until });
    return 'Price alerts and RSI signals are paused until ' + london(until) + ' London.\nRule warnings, closed trades, the daily summary and price-feed problems still come through. Everything still shows on the site.\nSend /quiet off to undo.';
  }

  /* Commands, plus a few everyday words so a short question works too. */
  function answer(text) {
    const original = String(text || '').trim(), raw = original.toLowerCase();
    const cmd = raw.startsWith('/') ? raw.slice(1).split(/[\s@]/)[0] : '';
    const pick = cmd || (/\b(today|so far)\b/.test(raw) ? 'today' : /\balert/.test(raw) ? 'alerts' : /\b(room|limit|left|target|drawdown)/.test(raw) ? 'room' : /\b(trade|position)s?\b.*\b(detail|all|list)|\bdetail/.test(raw) ? 'positions' : /\b(status|position|positions|open|how|doing|p\/?l|balance)\b/.test(raw) ? 'status' : 'help');
    const fns = { status, positions, room, alerts, today, help, start: help, check: () => check(original), alert: () => alert(original), quiet: () => quiet(original) };
    const out = (fns[pick] || help)();
    return out.length > 4000 ? out.slice(0, 3990) + '\n…' : out;
  }

  function handle(update) {
    const msg = update && (update.message || update.edited_message);
    if (!msg || !msg.chat || String(msg.chat.id) !== String(chatId) || typeof msg.text !== 'string') return;
    if (msg.date && msg.date * 1000 < startedAt - 5 * MIN) return;   // old messages waiting from before the cockpit started
    let reply;
    try { reply = answer(msg.text); } catch (e) { reply = 'Sorry, I couldn’t work that out just now. Check the cockpit page.'; console.error('Telegram command failed:', String(e && e.message || e)); }
    notifier.send(reply);
    answered++;
  }

  const sleep = ms => new Promise(res => { const t = setTimeout(res, ms); if (t.unref) t.unref(); });
  const clean = s => String(s).split(token).join('***');
  async function call(method, body, waitMs) {
    const r = await fetch(api + '/bot' + token + '/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(waitMs) });
    const b = await r.json().catch(() => ({}));
    return { status: r.status, ok: r.ok && b.ok !== false, body: b };
  }
  async function loop() {
    try { await call('setMyCommands', { commands: COMMANDS.map(c => ({ command: c[0], description: c[1] })) }, 15000); } catch (e) { /* the menu is a nicety */ }
    while (!stopped) {
      try {
        const r = await call('getUpdates', { offset, timeout: pollSeconds, allowed_updates: ['message', 'edited_message'] }, (pollSeconds + 15) * 1000);
        if (!r.ok) {
          lastError = clean(r.body.description || 'HTTP ' + r.status);
          if (failures === 0) console.error('Telegram commands: ' + lastError + (r.status === 409 ? ' (another app is reading this bot’s messages)' : '') + '. Will keep trying.');
          failures++;
          await sleep(r.status === 409 || r.status === 401 ? 60000 : Math.min(60000, 1000 * Math.pow(2, failures)));
          continue;
        }
        failures = 0; lastError = null;
        for (const u of r.body.result || []) { offset = Math.max(offset, u.update_id + 1); handle(u); }
      } catch (e) {
        lastError = 'Couldn’t reach Telegram';
        if (failures === 0) console.error('Telegram commands: ' + lastError + '. Will keep trying.');
        failures++;
        await sleep(Math.min(60000, 1000 * Math.pow(2, failures)));
      }
    }
  }

  return {
    enabled,
    start() {
      if (token && chatId) { const d = setTimeout(checkDaily, 3000), i = setInterval(checkDaily, MIN); if (d.unref) d.unref(); if (i.unref) i.unref(); }
      if (enabled) loop().catch(e => console.error('Telegram commands stopped:', clean(e && e.message || e)));
    },
    stop() { stopped = true; },
    answer,
    quietUntil,
    status() { return { enabled, answered, lastError, quietUntil: quietUntil() || null, summaryDay: botState().summaryDay || null }; }
  };
}

module.exports = { createBot, COMMANDS };
