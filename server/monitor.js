'use strict';
/* The safety loop: fills limit orders, fires price alerts, closes positions at SL / TP and watches the
 * Bitfunded rules on every price tick, so none of it needs an open page. Plain code, never AI.
 * It only records and warns; it never places anything on Bitfunded. */
const R = require('./lib/rules.js');

const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const FEE_RATE = 0.0004;
const FEED_MAX = 80;
const GRACE_MS = Number(process.env.PRICE_GRACE_MS) || 60000;   // how long a live source gets to quote a pair before we say it has no price
const RANK = { ok: 0, warn: 1, danger: 2, breach: 3 };
const LEVELS = ['warn', 'danger', 'breach'];

const uid = p => p + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const fmt = (n, d) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const px = (sym, n) => fmt(n, R.assetInfo(sym).decimals);
const qty = n => Number(n).toLocaleString('en-US', { maximumFractionDigits: 4 });
const money = n => (n < 0 ? '−$' : '$') + fmt(Math.abs(n), 0);
const signedMoney = n => (n >= 0 ? '+' : '') + money(n);

function createMonitor({ db, feed, broadcast, notify }) {
  let state, baseline, dirty, prev, rsiZone, candleSeen, downSince, ticks = 0;
  const reportedErrors = new Set();

  function reset() {
    const saved = db.get('meta', 'watch');
    baseline = !saved;   // first run: note what's already true without alerting about it
    state = Object.assign({ fired: {}, flags: {}, cross: {}, clockPhase: null, feedDown: false }, saved || {});
    delete state.id;
    dirty = false; prev = {}; rsiZone = {}; candleSeen = {}; downSince = null;
    const prices = db.get('meta', 'prices');
    if (prices && prices.p && Date.now() - (prices.at || 0) < DAY) prev = Object.assign({}, prices.p);  // catches levels crossed during a restart
  }

  function appNow() { return Date.now() + (Number((db.get('meta', 'settings') || {}).offsetMs) || 0); }

  function save(coll, doc) {
    db.put(coll, doc.id, doc);
    broadcast('change', { coll, id: doc.id, doc, origin: 'server' });
  }
  function pushAlert(a, now) {
    a = Object.assign({ id: uid('f'), t: now }, a);
    const items = [a].concat(((db.get('meta', 'feed') || {}).items || []).slice(0, FEED_MAX - 1));
    db.put('meta', 'feed', { items });
    broadcast('change', { coll: 'meta', id: 'feed', doc: { items, id: 'feed' }, origin: 'server' });
    if (notify) notify(a);
  }

  /* Never act on a price we can't trust. On a live source that means a current quote: a made-up
   * price must not close a position, fill an order or fire an alert. */
  function actionable(sym) {
    if (!(feed.prices[sym] > 0)) return false;
    if (feed.source === 'simulated') return true;
    return feed.src[sym] === 'live';
  }

  /* One broken record must not stop the checks for everything else, and a failing check must not stay silent. */
  function guard(name, fn) {
    try { return fn(); }
    catch (e) {
      const msg = name + ': ' + String(e && e.message || e);
      if (reportedErrors.has(msg)) return;
      reportedErrors.add(msg);
      console.error('Monitor error:', msg);
      try { pushAlert({ lane: 'risk', level: 'danger', text: 'A safety check hit an error (' + name + ') and may not be running fully. Check your positions on Bitfunded.' }, Date.now()); }
      catch (e2) { console.error('Monitor error:', String(e2 && e2.message || e2)); }
    }
  }

  /* Positions and orders on pairs with no live price aren't watched, so say so once. */
  function checkUnpriced(now) {
    const st = feed.status;
    if (feed.source === 'simulated' || st.state !== 'connected' || Date.now() - st.since <= GRACE_MS) return;
    const unpriced = s => feed.src[s] === 'sim';
    for (const t of db.list('trades')) {
      const key = t.id + ':no_price';
      if (t.status !== 'open' || !unpriced(t.symbol) || state.flags[key]) continue;
      state.flags[key] = now; dirty = true;
      if (!baseline) pushAlert({ lane: 'risk', level: 'warn', accountId: t.accountId, text: t.symbol + ' ' + t.side + ' has no live price, so the cockpit isn\u2019t watching its stop or target. Close it yourself when Bitfunded does.' }, now);
    }
    for (const o of db.list('orders')) {
      const key = 'o:' + o.id;
      if (o.status !== 'working' || !unpriced(o.symbol) || state.cross[key]) continue;
      state.cross[key] = now; dirty = true;
      if (!baseline) pushAlert({ lane: 'risk', level: 'warn', accountId: o.accountId, text: 'Limit ' + o.side.toLowerCase() + ' ' + o.symbol + ' has no live price, so the cockpit can\u2019t fill it.' }, now);
    }
  }

  function candlesBetween(sym, from, to, cap) {
    const f0 = Math.floor(from / MIN) * MIN;
    let a = (feed.candles[sym] || []).filter(c => c.time * 1000 >= f0 && c.time * 1000 <= to);
    if (cap && a.length > cap) a = a.slice(a.length - cap);
    return a.map(c => [c.time * 1000, +c.open.toFixed(4), +c.high.toFixed(4), +c.low.toFixed(4), +c.close.toFixed(4)]);
  }

  function metricsFor(acc, trades, now) { return R.accountMetrics(acc, trades, feed.prices, now); }

  function fillNew(o, acc, now) {
    const t = {
      id: uid('trd'), accountId: acc.id, symbol: o.symbol, side: o.side, status: 'open',
      sl: o.sl === '' || o.sl == null ? null : Number(o.sl), tp: o.tp === '' || o.tp == null ? null : Number(o.tp),
      fills: [{ t: now, price: o.price, size: Number(o.size), lev: Number(o.lev), type: 'Limit' }],
      fees: +(o.price * o.size * FEE_RATE).toFixed(2),
      setup: o.setup, ideaSource: o.ideaSource, reason: o.reason, mood: o.mood, checklist: o.checklist,
      verified: false, reviews: [], myReview: null, createdAt: now,
      entryCandles: candlesBetween(o.symbol, now - 40 * MIN, now, 40), rulesVersion: R.rulesFor(acc).version
    };
    save('trades', t);
    pushAlert({ lane: 'trade', level: 'good', accountId: acc.id, text: 'Limit filled: ' + o.side + ' ' + qty(o.size) + ' ' + o.symbol + ' at ' + px(o.symbol, o.price) + ' on ' + acc.name }, now);
    return t;
  }
  function fillAdd(o, target, acc, now) {
    const t = JSON.parse(JSON.stringify(target));
    t.fills.push({ t: now, price: o.price, size: Number(o.size), lev: Number(o.lev), type: 'Limit' });
    t.fees = +((t.fees || 0) + o.price * o.size * FEE_RATE).toFixed(2);
    if (o.sl !== '' && o.sl != null) t.sl = Number(o.sl);
    save('trades', t);
    pushAlert({ lane: 'trade', level: 'good', accountId: acc.id, text: 'Limit filled: added ' + qty(o.size) + ' ' + o.symbol + ' at ' + px(o.symbol, o.price) + ' on ' + acc.name + '. New average ' + px(o.symbol, R.summarize(t).avgEntry) }, now);
    return t;
  }

  function checkOrders(now) {
    for (const o of db.list('orders')) {
      if (o.status !== 'working') continue;
      const acc = db.get('accounts', o.accountId);
      if (!acc) continue;
      acc.id = o.accountId;
      const target = o.kind === 'add' ? db.get('trades', o.tradeId) : null;
      if (target) target.id = o.tradeId;
      if (o.kind === 'add' && (!target || target.status !== 'open')) { save('orders', Object.assign({}, o, { status: 'cancelled', note: 'Position closed before the add filled' })); continue; }
      if (!actionable(o.symbol)) continue;
      const p = feed.prices[o.symbol];
      if (!(o.side === 'Long' ? p <= o.price : p >= o.price)) continue;
      const trades = db.list('trades');
      const pre = R.preTrade(acc, metricsFor(acc, trades, now), { t: now, side: o.side, price: o.price, size: o.size, lev: o.lev, sl: o.sl, tp: o.tp }, target);
      if (acc.status !== 'active' || pre.blocked) {
        save('orders', Object.assign({}, o, { status: 'cancelled', cancelledAt: now, note: acc.status !== 'active' ? 'Account not active' : 'Would have gone past a Bitfunded rule' }));
        pushAlert({ lane: 'risk', level: 'warn', accountId: acc.id, text: 'Limit ' + o.side.toLowerCase() + ' ' + o.symbol + ' at ' + px(o.symbol, o.price) + ' was not filled: it would have gone past a Bitfunded rule.' }, now);
        continue;
      }
      const t = o.kind === 'add' ? fillAdd(o, target, acc, now) : fillNew(o, acc, now);
      save('orders', Object.assign({}, o, { status: 'filled', filledAt: now, tradeId: t.id }));
    }
  }

  function checkLevels(now) {
    for (const l of db.list('levels')) {
      if (!l.active || !actionable(l.symbol)) continue;
      const before = prev[l.symbol], cur = feed.prices[l.symbol];
      if (before == null) continue;
      if ((before < l.price && cur >= l.price) || (before > l.price && cur <= l.price)) {
        save('levels', Object.assign({}, l, { active: false, triggeredAt: now }));
        pushAlert({ lane: 'setup', text: l.symbol + ' crossed ' + px(l.symbol, l.price) + (l.note ? ' · ' + l.note : '') }, now);
      }
    }
  }

  function closeTrade(t, price, reason, now) {
    const s = R.summarize(t), nt = JSON.parse(JSON.stringify(t));
    nt.status = 'closed';
    nt.exit = { t: now, price, reason };
    nt.fees = +((nt.fees || 0) + price * s.size * FEE_RATE).toFixed(2);
    nt.exitCandles = candlesBetween(t.symbol, s.openedAt, now + 20 * MIN, 120);
    save('trades', nt);
    const r = R.realized(nt), acc = db.get('accounts', t.accountId);
    pushAlert({ lane: 'trade', level: r >= 0 ? 'good' : 'accent', accountId: t.accountId, text: t.symbol + ' ' + t.side + ': price hit your ' + reason.toLowerCase() + ' at ' + px(t.symbol, price) + '. Closed in your journal, ' + signedMoney(r) + (acc ? ' on ' + acc.name : '') + '. Check your position on Bitfunded.' + (r < 0 ? ' Losses are part of the plan. Take a breath before the next trade.' : '') }, now);
  }
  function checkStops(now) {
    for (const t of db.list('trades')) {
      if (t.status !== 'open' || !actionable(t.symbol)) continue;
      guard('stops', () => {
        const p = feed.prices[t.symbol], long = t.side === 'Long';
        if (Number(t.sl) > 0 && (long ? p <= t.sl : p >= t.sl)) closeTrade(t, Number(t.sl), 'Stop loss', now);
        else if (Number(t.tp) > 0 && (long ? p >= t.tp : p <= t.tp)) closeTrade(t, Number(t.tp), 'Take profit', now);
      });
    }
  }

  /* A rule level alerts once per Bitfunded day, so a price hovering around 90% can't flood you. */
  function checkRisk(now) {
    const trades = db.list('trades'), accounts = db.list('accounts'), day = R.dayBounds(now);
    for (const acc of accounts) {
      if (acc.status !== 'active') continue;
      guard('rule limits', () => {
      const m = metricsFor(acc, trades, now);
      for (const g of m.gauges) {
        if (g.level === 'ok') continue;
        const key = l => acc.id + ':' + g.key + ':' + l + ':' + day.start;
        if (state.fired[key(g.level)]) continue;
        for (const l of LEVELS) if (RANK[l] <= RANK[g.level]) state.fired[key(l)] = now;
        dirty = true;
        if (baseline) continue;
        const tail = g.level === 'breach' ? 'has reached its limit' : g.level === 'danger' ? 'is past 90% of the limit' : 'is past 60% of the limit';
        pushAlert({ lane: 'risk', level: g.level, accountId: acc.id, text: (acc.paper ? 'Paper · ' : '') + g.label + ' ' + tail + ' on ' + acc.name + ' (' + (g.unit === '%' ? g.value.toFixed(2) + '%' : g.value) + ' / ' + g.limit + g.unit + ')' }, now);
      }
      for (const t of trades) {
        if (t.status !== 'open' || t.accountId !== acc.id) continue;
        for (const f of R.positionFlags(t, acc, now).flags) {
          const key = t.id + ':' + f.code;
          if (state.flags[key]) continue;
          state.flags[key] = now; dirty = true;
          if (!baseline && ['no_sl', 'hold_soon', 'hold_over', 'leverage'].includes(f.code))
            pushAlert({ lane: 'risk', level: f.level, accountId: acc.id, text: t.symbol + ' ' + t.side + ' on ' + acc.name + ': ' + f.text }, now);
        }
      }
      });
    }
    const nameOf = id => (accounts.find(a => a.id === id) || {}).name;
    const g = R.crossAccount(accounts, trades, now);
    for (const h of g.hedges) {
      const key = 'h:' + [h.a, h.b].sort().join(':');
      if (state.cross[key]) continue;
      state.cross[key] = now; dirty = true;
      if (!baseline) pushAlert({ lane: 'risk', level: 'breach', text: 'Hedge across accounts: ' + h.symbol + ' long and short on ' + h.accounts.map(nameOf).join(' and ') }, now);
    }
    for (const h of g.coordinated) {
      const key = 'c:' + [h.a, h.b].sort().join(':');
      if (state.cross[key]) continue;
      state.cross[key] = now; dirty = true;
      if (!baseline) pushAlert({ lane: 'risk', level: 'danger', text: 'Matching ' + h.symbol + ' entries on two accounts within 2 minutes (coordinated trading)' }, now);
    }
    const left = day.nominalReset - now, phase = now >= day.nominalReset ? 'settle' : left < HOUR ? 'final' : 'day', dayKey = day.start + ':' + phase;
    if (state.clockPhase !== dayKey) {
      const was = state.clockPhase, quiet = !trades.some(t => t.status === 'open');  // the feed always shows these; Telegram only with positions open
      if (was && !baseline) {
        if (phase === 'final') pushAlert({ lane: 'risk', level: 'warn', quiet, text: 'Final hour of the Bitfunded day. A loss now still counts against today.' }, now);
        if (phase === 'day' && was.split(':')[0] !== String(day.start)) pushAlert({ lane: 'risk', level: 'good', quiet, text: 'New Bitfunded day started. Daily loss has reset.' }, now);
      }
      state.clockPhase = dayKey; dirty = true;
    }
  }

  function watchedSymbols() {
    const set = new Set();
    for (const t of db.list('trades')) if (t.status === 'open') set.add(t.symbol);
    for (const l of db.list('levels')) if (l.active) set.add(l.symbol);
    return Array.from(set);
  }
  function checkRsi(now) {
    if ((db.get('meta', 'settings') || {}).rsiAlerts === false) return;
    for (const sym of watchedSymbols()) {
      const arr = feed.candles[sym];
      if (!arr || !arr.length || !actionable(sym)) continue;
      const last = arr[arr.length - 1].time;
      if (candleSeen[sym] === last) continue;
      candleSeen[sym] = last;
      const v = R.rsi(arr.slice(-60, -1).map(c => c.close), 14);
      if (v == null) continue;
      const zone = v < 30 ? 'low' : v > 70 ? 'high' : 'mid', before = rsiZone[sym];
      rsiZone[sym] = zone;
      if (before && before !== zone && zone !== 'mid')
        pushAlert({ lane: 'signal', text: sym + ' RSI(14) ' + (zone === 'low' ? 'below 30' : 'above 70') + ' on 1m (' + v.toFixed(0) + ')' }, now);
    }
  }

  /* If live prices stop, every check above pauses, and that silence must not look like all clear. */
  function checkFeed(now) {
    const st = feed.status, live = feed.source !== 'simulated';
    const down = live && !(st.state === 'connected' && st.lastMessageAt && Date.now() - st.lastMessageAt < 30000);
    if (!down) {
      downSince = null;
      if (state.feedDown) {
        state.feedDown = false; dirty = true;
        pushAlert({ lane: 'risk', level: 'good', text: 'Live prices are back. Stops, limit orders and alerts are running again.' }, now);
      }
      return;
    }
    if (downSince == null) downSince = Date.now();
    if (!state.feedDown && Date.now() - downSince >= GRACE_MS) {
      state.feedDown = true; dirty = true;
      pushAlert({ lane: 'risk', level: 'danger', text: 'Live prices have stopped. Stops, limit orders and price alerts are paused until they return. Check your positions on Bitfunded.' }, now);
    }
  }

  function prune(now) {
    const cut = now - 3 * DAY;
    for (const k of Object.keys(state.fired)) if (state.fired[k] < cut) { delete state.fired[k]; dirty = true; }
    const open = new Set(db.list('trades').filter(t => t.status === 'open').map(t => t.id));
    for (const k of Object.keys(state.flags)) if (!open.has(k.split(':')[0])) { delete state.flags[k]; dirty = true; }
  }

  function tick() {
    const now = appNow();
    guard('limit orders', () => checkOrders(now));
    guard('price alerts', () => checkLevels(now));
    guard('stops', () => checkStops(now));
    guard('rule limits', () => checkRisk(now));
    guard('unpriced pairs', () => checkUnpriced(now));
    guard('RSI', () => checkRsi(now));
    guard('price feed', () => checkFeed(now));
    guard('housekeeping', () => {
      for (const s of Object.keys(feed.prices)) if (actionable(s)) prev[s] = feed.prices[s];
      if (++ticks % 60 === 1) {
        prune(now);
        for (const s of watchedSymbols()) if (actionable(s)) feed.history(s).catch(() => {});  // candle history for reviews and RSI
      }
      if (baseline || dirty) { db.put('meta', 'watch', state); dirty = false; baseline = false; }
    });
  }

  reset();
  return { tick, reset, actionable };
}

module.exports = { createMonitor };
