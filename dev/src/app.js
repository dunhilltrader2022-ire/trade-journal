'use strict';
/* Bitfunded Trading Cockpit — TEST environment.
 * Data: the artifact's db store (falls back to this browser only when the store is unavailable).
 * Prices: simulated feed. Claude reviews: the viewer's Claude account via the sample capability. */
var R = window.Rules;
var MIN = R.MIN, HOUR = R.HOUR, DAY = R.DAY;
var QUICK = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XAU/USD'];
function dec(sym) { return R.assetInfo(sym).decimals; }
function allSyms() { return Object.keys(R.ASSETS).sort(); }
function pairSettings() { return (Store.meta.settings && Store.meta.settings.pairs) || null; }
function syncPairs() {
  var p = pairSettings();
  if (p && p.custom) Object.keys(p.custom).forEach(function (s) { R.addPair(s, Number(p.custom[s]) || 0); });
  Store.data.trades.forEach(function (t) { if (!R.ASSETS[t.symbol]) R.addPair(t.symbol, t.fills && t.fills[0] ? t.fills[0].price : 0); });
  if (Sim.started) Object.keys(R.ASSETS).forEach(ensurePrice);
}
function enabledSyms() {
  var p = pairSettings(), list = p && p.enabled ? p.enabled.filter(function (s) { return R.ASSETS[s]; }) : allSyms();
  Store.data.trades.forEach(function (t) { if (t.status === 'open' && list.indexOf(t.symbol) < 0) list.push(t.symbol); });
  return list;
}
function pairOptions(selected) {
  var list = enabledSyms();
  if (selected && list.indexOf(selected) < 0) list = list.concat([selected]);
  return ['major', 'minor', 'traditional'].map(function (cls) {
    var opts = list.filter(function (s) { return R.assetInfo(s).cls === cls; }).sort();
    return opts.length ? '<optgroup label="' + esc(R.CLASS_LABEL[cls]) + ' (' + opts.length + ')">' + opts.map(function (s) { return '<option value="' + s + '"' + (s === selected ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</optgroup>' : '';
  }).join('');
}
var FEE_RATE = 0.0004;
var SETUPS = ['Breakout retest', 'Range reclaim', 'Momentum', 'Trend pullback', 'Other'];
var MOODS = ['Calm', 'Confident', 'Impatient', 'Frustrated', 'Tired', 'FOMO'];
var LEVERAGES = [1, 2, 3, 5, 10, 15, 20];
var RUBRIC = [
  ['Rule compliance', 'Bitfunded rules: SL/TP set, leverage, exposure, positions, hold limits, 10-min minimum. Any breach caps the whole grade at D.'],
  ['Setup quality', 'Does it match a named playbook setup and its filters?'],
  ['Entry location', 'Judged ONLY on candles before entry. Was there a better-located entry visible at the time?'],
  ['Stop & risk-reward', 'Stop at a structural level; planned reward vs risk.'],
  ['Position size', 'Risk at the stop vs the account and vs room left in the daily loss limit.'],
  ['Exit & management', 'Judged on candles after entry: exits, adds (adding to winners vs averaging down), moving the stop.'],
  ['Plan adherence', 'Checklist answers, reason, mood; did they follow their own plan?']
];
var RUBRIC_VERSION = 'rubric v1.2';

/* ---------- utilities ---------- */
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function uid(p) { return p + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function money(n, d) { if (n == null || isNaN(n)) return '—'; var s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: d == null ? 0 : d, maximumFractionDigits: d == null ? 0 : d }); return (n < 0 ? '−$' : '$') + s; }
function signedMoney(n) { if (n == null || isNaN(n)) return '—'; return (n >= 0 ? '+' : '') + money(n); }
function pct(n, d) { if (n == null || isNaN(n)) return '—'; return n.toFixed(d == null ? 2 : d) + '%'; }
function px(sym, n) { if (n == null || n === '' || isNaN(n)) return '—'; return Number(n).toLocaleString('en-US', { minimumFractionDigits: dec(sym), maximumFractionDigits: dec(sym) }); }
function qty(n) { return Number(n).toLocaleString('en-US', { maximumFractionDigits: 4 }); }
function pad2(n) { return String(n).padStart(2, '0'); }
function fmtDur(ms) { var neg = ms < 0; ms = Math.abs(ms); var d = Math.floor(ms / DAY), h = Math.floor(ms % DAY / HOUR), m = Math.floor(ms % HOUR / MIN); var s = d ? d + 'd ' + h + 'h' : h ? h + 'h ' + m + 'm' : m + 'm'; return neg ? '−' + s : s; }
function hms(ms) { ms = Math.max(0, ms); return pad2(Math.floor(ms / HOUR)) + ':' + pad2(Math.floor(ms % HOUR / MIN)) + ':' + pad2(Math.floor(ms % MIN / 1000)); }
function tz(t, zone, sec) { return new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', second: sec ? '2-digit' : undefined, hour12: false }).format(new Date(t)); }
function dateShort(t) { return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(t)); }
function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } }
function gauss() { var u = 1 - Math.random(), v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

function toast(text, level) {
  var wrap = document.getElementById('toasts');
  var el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = '<span class="tag ' + (level || 'accent') + '">' + esc(level === 'good' ? 'Done' : level === 'danger' || level === 'breach' ? 'Check' : level === 'warn' ? 'Heads up' : 'Info') + '</span><span>' + esc(text) + '</span>';
  wrap.appendChild(el);
  setTimeout(function () { el.remove(); }, 6000);
}

/* ---------- app time (Test lab can shift it) ---------- */
function appNow() { return Date.now() + (Number(Store.meta.settings.offsetMs) || 0); }

/* ---------- store ---------- */
var COLLS = ['accounts', 'trades', 'levels', 'socials', 'orders', 'drawings', 'archive'];
var Store = { mode: 'connecting', db: null, data: { accounts: [], trades: [], levels: [], socials: [], orders: [], drawings: [], archive: [] }, meta: { feed: { items: [] }, settings: {}, prices: null }, got: {}, ready: false };

function onStoreChange() { if (!Store.ready) { Store.ready = COLLS.every(function (c) { return Store.got[c]; }) && Store.got.settings && Store.got.feed; if (Store.ready) boot2(); return; } scheduleRender(); }

function initStore() {
  if (typeof fetch !== 'function' || !/^https?:$/.test(location.protocol)) return initClaudeStore();
  var ctl = window.AbortController ? new AbortController() : null;
  var t = setTimeout(function () { if (ctl) ctl.abort(); }, 3000);
  fetch('api/state', { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
    .then(function (r) { if (!r.ok) throw new Error('no server'); return r.json(); })
    .then(function (st) { clearTimeout(t); if (!st || !st.data || !st.server) throw new Error('not the cockpit server'); useServer(st); })
    .catch(function () { clearTimeout(t); initClaudeStore(); });
}
function useServer(st) {
  Store.mode = 'server'; Store.clientId = uid('c'); Store.server = st.server || {};
  COLLS.forEach(function (c) { Store.data[c] = (st.data && st.data[c]) || []; });
  Store.meta = { settings: (st.meta && st.meta.settings) || {}, feed: (st.meta && st.meta.feed) || { items: [] }, prices: (st.meta && st.meta.prices) || null };
  COLLS.concat(['settings', 'feed']).forEach(function (c) { Store.got[c] = true; });
  connectEvents();
  onStoreChange();
}
function applyChange(m) {
  if (!m || m.origin === Store.clientId) return;
  if (m.coll === 'meta' && m.id === 'feed' && m.doc && m.origin === 'server') {
    var seen = (Store.meta.feed.items || []).map(function (a) { return a.id; });
    (m.doc.items || []).slice(0, 5).forEach(function (a) { if (seen.indexOf(a.id) < 0) toast(a.text, a.level || (a.lane === 'risk' ? 'warn' : 'accent')); });
  }
  if (m.coll === 'meta') { if (m.id === 'settings' || m.id === 'feed') Store.meta[m.id] = m.doc ? (function (d) { d = Object.assign({}, d); delete d.id; return d; })(m.doc) : (m.id === 'feed' ? { items: [] } : {}); }
  else if (Store.data[m.coll]) {
    var arr = Store.data[m.coll], i = arr.findIndex(function (x) { return x.id === m.id; });
    if (!m.doc) { if (i >= 0) arr.splice(i, 1); }
    else if (i >= 0) arr[i] = m.doc; else arr.push(m.doc);
  }
  scheduleRender();
}
function connectEvents() {
  if (window.EventSource) {
    var es = new EventSource('api/events');
    es.addEventListener('change', function (e) { try { applyChange(JSON.parse(e.data)); } catch (x) { /* ignore */ } });
    es.addEventListener('prices', function (e) { try { applyServerPrices(JSON.parse(e.data)); } catch (x) { /* ignore */ } });
    es.addEventListener('reload', function () { location.reload(); });
    es.onerror = function () { Store.serverDown = true; };
    es.onopen = function () { Store.serverDown = false; };
  } else {
    setInterval(function () { fetch('api/prices').then(function (r) { return r.json(); }).then(applyServerPrices).catch(function () { Store.serverDown = true; }); }, 1000);
  }
}
function applyServerPrices(snap) {
  if (!snap || !snap.prices) return;
  Store.serverDown = false;
  Feed.snap = snap;
  Object.keys(snap.prices).forEach(function (s) {
    var v = Number(snap.prices[s]); if (!(v > 0)) return;
    Sim.prev[s] = Sim.prices[s] == null ? v : Sim.prices[s];
    Sim.prices[s] = v;
    if (Sim.candles[s]) pushCandle(s, v);
  });
  Sim.src = snap.src || {};
}
var Feed = { snap: null };
function serverHeaders() { return { 'content-type': 'application/json', 'x-client-id': Store.clientId }; }
function serverCall(method, url, body) {
  return fetch(url, { method: method, headers: serverHeaders(), body: body == null ? undefined : JSON.stringify(body) })
    .then(function (r) { if (!r.ok) throw { code: 'http_' + r.status }; return r.json(); }).catch(storeError);
}
function initClaudeStore() {
  var done = false;
  var fallback = setTimeout(function () { if (!done) useLocal(); }, 11000);
  var use = window.claude && window.claude.use ? window.claude.use('db') : Promise.resolve(null);
  Promise.resolve(use).then(function (db) {
    if (done) return;
    done = true; clearTimeout(fallback);
    if (!db) return useLocal();
    Store.mode = 'db'; Store.db = db;
    COLLS.forEach(function (c) {
      db.collection(c).onSnapshot(function (snap) {
        Store.data[c] = snap.docs.map(function (d) { var o = Object.assign({}, d.data()); o.id = d.id; return o; });
        Store.got[c] = true; onStoreChange();
      }, function (e) { storeError(e); });
    });
    ['settings', 'feed'].forEach(function (name) {
      db.doc('meta/' + name).onSnapshot(function (snap) {
        Store.meta[name] = snap.exists ? Object.assign({}, snap.data()) : (name === 'feed' ? { items: [] } : {});
        Store.got[name] = true; onStoreChange();
      }, function (e) { storeError(e); });
    });
    db.doc('meta/prices').get().then(function (s) { Store.meta.prices = s.exists ? s.data() : null; }).catch(function () {});
  }).catch(function () { if (!done) { done = true; clearTimeout(fallback); useLocal(); } });
}
function useLocal() {
  Store.mode = 'local';
  var saved = lsGet('cockpit-test-data', null);
  if (saved) { Store.data = saved.data; Store.meta = saved.meta; if (!Store.data.orders) Store.data.orders = []; if (!Store.data.drawings) Store.data.drawings = []; if (!Store.data.archive) Store.data.archive = []; }
  var lp = lsGet('cockpit-prices', null); if (lp) Store.meta.prices = { p: lp };
  COLLS.concat(['settings', 'feed']).forEach(function (c) { Store.got[c] = true; });
  onStoreChange();
}
function saveLocal() { if (Store.mode === 'local') lsSet('cockpit-test-data', { data: Store.data, meta: Store.meta }); }
function storeError(e) { toast('Saving hit a problem: ' + (e && e.code ? e.code : 'unknown') + '. Changes may not be kept.', 'danger'); }

function put(coll, obj) {
  obj = clone(obj);
  var arr = Store.data[coll], i = arr.findIndex(function (x) { return x.id === obj.id; });
  if (i >= 0) arr[i] = obj; else arr.push(obj);
  if (Store.mode === 'db') { var body = clone(obj); delete body.id; scheduleRender(); return Store.db.collection(coll).doc(obj.id).set(body).catch(storeError); }
  if (Store.mode === 'server') { scheduleRender(); return serverCall('PUT', 'api/doc/' + coll + '/' + encodeURIComponent(obj.id), obj); }
  saveLocal(); scheduleRender(); return Promise.resolve();
}
function remove(coll, id) {
  Store.data[coll] = Store.data[coll].filter(function (x) { return x.id !== id; });
  if (Store.mode === 'db') { scheduleRender(); return Store.db.collection(coll).doc(id).delete().catch(storeError); }
  if (Store.mode === 'server') { scheduleRender(); return serverCall('DELETE', 'api/doc/' + coll + '/' + encodeURIComponent(id)); }
  saveLocal(); scheduleRender(); return Promise.resolve();
}
function setMeta(name, obj) {
  Store.meta[name] = clone(obj);
  if (Store.mode === 'db') { scheduleRender(); return Store.db.doc('meta/' + name).set(clone(obj)).catch(storeError); }
  if (Store.mode === 'server') { scheduleRender(); return serverCall('PUT', 'api/doc/meta/' + name, obj); }
  saveLocal(); scheduleRender(); return Promise.resolve();
}
function byId(coll, id) { return Store.data[coll].find(function (x) { return x.id === id; }); }

/* ---------- selectors ---------- */
function accounts() { return Store.data.accounts.slice().sort(function (a, b) { return (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) || a.name.localeCompare(b.name); }); }
function activeAccounts() { return accounts().filter(function (a) { return a.status === 'active'; }); }
function currentAccount() { return byId('accounts', ui.acctId) || activeAccounts()[0] || accounts()[0] || null; }
function tradesOf(accId) { return Store.data.trades.filter(function (t) { return t.accountId === accId; }); }
function openTrades(accId) { return tradesOf(accId).filter(function (t) { return t.status === 'open'; }); }
function typeOf(acc) { return acc ? R.accountType(acc) : ''; }
function typeTag(acc) { var t = typeOf(acc); return '<span class="tag ' + (t === 'Live' ? 'live' : t === 'Demo' ? 'demo' : '') + '">' + esc(t) + '</span>'; }
function metricsFor(acc) { return R.accountMetrics(acc, Store.data.trades, Sim.prices, appNow()); }

/* ---------- simulated price feed ---------- */
var Sim = { prices: {}, candles: {}, prev: {}, started: false };
function simInit() {
  Sim.saved = (Store.meta.prices && Store.meta.prices.p) || {};
  Sim.started = true;
  syncPairs();
  Object.keys(R.ASSETS).forEach(ensurePrice);
  ensureCandles(ui.sym);
}
function ensurePrice(s) { if (Sim.prices[s] == null) Sim.prices[s] = Number(Sim.saved && Sim.saved[s]) || R.assetInfo(s).start; }
function ensureCandles(s) {
  ensurePrice(s);
  if (!Sim.candles[s]) {
    if (Store.mode === 'server') {
      var t0 = Math.floor(Date.now() / MIN) * 60, p0 = Sim.prices[s];
      Sim.candles[s] = [{ time: t0, open: p0, high: p0, low: p0, close: p0 }];
      fetch('api/candles?sym=' + encodeURIComponent(s)).then(function (r) { return r.json(); }).then(function (d) {
        if (!d || !Array.isArray(d.candles) || !d.candles.length) return;
        var cur = Sim.candles[s] || [], lastT = d.candles[d.candles.length - 1].time;
        Sim.candles[s] = d.candles.map(function (c) { return { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }; }).concat(cur.filter(function (c) { return c.time > lastT; }));
        if (Chart.sym === s && Chart.series && Chart.tf === '1m') mountChart();
      }).catch(function () { /* keep building from ticks */ });
    } else buildHistory(s);
  }
  return Sim.candles[s];
}
function buildHistory(sym) {
  var now = appNow(), m0 = Math.floor(now / MIN) * MIN, p = Sim.prices[sym], out = [];
  for (var i = 0; i < 300; i++) {
    var close = p, steps = [p];
    for (var k = 0; k < 6; k++) { p = p / (1 + gauss() * R.assetInfo(sym).vol * 2.4); steps.push(p); }
    out.push({ time: (m0 - i * MIN) / 1000, open: p, high: Math.max.apply(null, steps), low: Math.min.apply(null, steps), close: close });
  }
  out.reverse();
  out[out.length - 1].close = Sim.prices[sym];
  Sim.candles[sym] = out;
}
function simTick() {
  if (Store.mode === 'server') return;
  var vm = { calm: 0.5, normal: 1, wild: 2.5 }[Store.meta.settings.volatility || 'normal'];
  Object.keys(Sim.prices).forEach(function (s) {
    Sim.prev[s] = Sim.prices[s];
    Sim.prices[s] = Sim.prices[s] * (1 + gauss() * R.assetInfo(s).vol * vm);
    if (Sim.candles[s]) pushCandle(s, Sim.prices[s]);
  });
}
function pushCandle(s, price) {
  if (!Sim.candles[s]) return;
  var arr = Sim.candles[s], t = Math.floor((Store.mode === 'server' ? Date.now() : appNow()) / MIN) * MIN / 1000, last = arr[arr.length - 1];
  if (last && t < last.time) { if (Store.mode !== 'server') buildHistory(s); return; }
  if (last && last.time === t) { last.close = price; last.high = Math.max(last.high, price); last.low = Math.min(last.low, price); }
  else { arr.push({ time: t, open: last ? last.close : price, high: price, low: price, close: price }); if (arr.length > 600) arr.shift(); onNewCandle(s); }
}
function serverMove(sym, body) {
  return fetch('api/sim', { method: 'POST', headers: serverHeaders(), body: JSON.stringify(Object.assign({ sym: sym }, body)) })
    .then(function (r) { return r.json().then(function (b) { if (!r.ok) toast(b.message || 'Couldn\u2019t move that price.', 'warn'); else { Sim.prev[sym] = Sim.prices[sym]; Sim.prices[sym] = b.price; pushCandle(sym, b.price); afterPriceMove(); } }); })
    .catch(function () { toast('The cockpit server didn\u2019t answer.', 'danger'); });
}
function nudge(sym, pctMove) {
  if (Store.mode === 'server') return serverMove(sym, { pct: pctMove });
  ensureCandles(sym);
  Sim.prev[sym] = Sim.prices[sym];
  Sim.prices[sym] = Sim.prices[sym] * (1 + pctMove / 100);
  pushCandle(sym, Sim.prices[sym]);
  afterPriceMove();
}
function moveTo(sym, price) {
  if (Store.mode === 'server') return serverMove(sym, { price: price });
  ensureCandles(sym);
  Sim.prev[sym] = Sim.prices[sym];
  Sim.prices[sym] = price;
  pushCandle(sym, price);
  afterPriceMove();
}
function candlesBetween(sym, from, to, cap) {
  var f0 = Math.floor(from / MIN) * MIN;
  var a = ensureCandles(sym).filter(function (c) { return c.time * 1000 >= f0 && c.time * 1000 <= to; });
  if (cap && a.length > cap) a = a.slice(a.length - cap);
  return a.map(function (c) { return [c.time * 1000, +c.open.toFixed(4), +c.high.toFixed(4), +c.low.toFixed(4), +c.close.toFixed(4)]; });
}

/* ---------- alerts ---------- */
var Watch = { levels: {}, flags: {}, cross: {}, rsi: {}, clockPhase: null, init: false };
function pushAlert(a) {
  a = Object.assign({ id: uid('f'), t: appNow() }, a);
  var items = [a].concat((Store.meta.feed.items || []).slice(0, 79));
  setMeta('feed', { items: items });
  toast(a.text, a.level || (a.lane === 'risk' ? 'warn' : 'accent'));
}
function checkLevels() {
  Store.data.levels.forEach(function (l) {
    if (!l.active) return;
    var prev = Sim.prev[l.symbol], cur = Sim.prices[l.symbol];
    if (prev == null) return;
    if ((prev < l.price && cur >= l.price) || (prev > l.price && cur <= l.price)) {
      put('levels', Object.assign({}, l, { active: false, triggeredAt: appNow() }));
      pushAlert({ lane: 'setup', text: l.symbol + ' crossed ' + px(l.symbol, l.price) + (l.note ? ' · ' + l.note : '') });
    }
  });
}
function checkStops() {
  Store.data.trades.forEach(function (t) {
    if (t.status !== 'open') return;
    var p = Sim.prices[t.symbol], long = t.side === 'Long';
    if (t.sl != null && t.sl !== '' && (long ? p <= t.sl : p >= t.sl)) closeTrade(t, Number(t.sl), 'Stop loss');
    else if (t.tp != null && t.tp !== '' && (long ? p >= t.tp : p <= t.tp)) closeTrade(t, Number(t.tp), 'Take profit');
  });
}
var RANK = { ok: 0, warn: 1, danger: 2, breach: 3 };
function checkRisk() {
  var now = appNow();
  activeAccounts().forEach(function (acc) {
    var m = metricsFor(acc);
    m.gauges.forEach(function (g) {
      var key = acc.id + ':' + g.key, prev = Watch.levels[key];
      Watch.levels[key] = g.level;
      if (!Watch.init || prev == null) return;
      if (RANK[g.level] > RANK[prev] && g.level !== 'ok') {
        var tail = g.level === 'breach' ? 'has reached its limit' : g.level === 'danger' ? 'is past 90% of the limit' : 'is past 60% of the limit';
        pushAlert({ lane: 'risk', level: g.level, accountId: acc.id, text: (acc.paper ? 'Paper · ' : '') + g.label + ' ' + tail + ' on ' + acc.name + ' (' + (g.unit === '%' ? pct(g.value) : g.value) + ' / ' + g.limit + g.unit + ')' });
      }
    });
    openTrades(acc.id).forEach(function (t) {
      R.positionFlags(t, acc, now).flags.forEach(function (f) {
        var key = t.id + ':' + f.code;
        if (Watch.flags[key]) return;
        Watch.flags[key] = true;
        if (!Watch.init) return;
        if (f.code === 'no_sl' || f.code === 'hold_soon' || f.code === 'hold_over' || f.code === 'leverage')
          pushAlert({ lane: 'risk', level: f.level, accountId: acc.id, text: t.symbol + ' ' + t.side + ' on ' + acc.name + ': ' + f.text });
      });
    });
  });
  var g = R.crossAccount(Store.data.accounts, Store.data.trades, now);
  g.hedges.forEach(function (h) {
    var key = 'h:' + [h.a, h.b].sort().join(':');
    if (Watch.cross[key]) return; Watch.cross[key] = true;
    if (Watch.init) pushAlert({ lane: 'risk', level: 'breach', text: 'Hedge across accounts: ' + h.symbol + ' long and short on ' + h.accounts.map(function (id) { return (byId('accounts', id) || {}).name; }).join(' and ') });
  });
  g.coordinated.forEach(function (h) {
    var key = 'c:' + [h.a, h.b].sort().join(':');
    if (Watch.cross[key]) return; Watch.cross[key] = true;
    if (Watch.init) pushAlert({ lane: 'risk', level: 'danger', text: 'Matching ' + h.symbol + ' entries on two accounts within 2 minutes (coordinated trading)' });
  });
  // Day clock
  var day = R.dayBounds(now), left = day.nominalReset - now;
  var phase = now >= day.nominalReset ? 'settle' : left < HOUR ? 'final' : 'day';
  var dayKey = day.start + ':' + phase;
  if (Watch.clockPhase && Watch.clockPhase !== dayKey) {
    if (phase === 'final') pushAlert({ lane: 'risk', level: 'warn', text: 'Final hour of the Bitfunded day. A loss now still counts against today.' });
    if (phase === 'day' && Watch.clockPhase.split(':')[0] !== String(day.start)) pushAlert({ lane: 'risk', level: 'good', text: 'New Bitfunded day started. Daily loss has reset.' });
  }
  Watch.clockPhase = dayKey;
  Watch.init = true;
}
function watched(sym) {
  return sym === ui.sym || Store.data.trades.some(function (t) { return t.status === 'open' && t.symbol === sym; }) || Store.data.levels.some(function (l) { return l.active && l.symbol === sym; });
}
function onNewCandle(sym) {
  if (Store.mode === 'server' || Store.meta.settings.rsiAlerts === false || !watched(sym)) return;
  var closes = Sim.candles[sym].slice(-60, -1).map(function (c) { return c.close; });
  var v = R.rsi(closes, 14);
  if (v == null) return;
  var zone = v < 30 ? 'low' : v > 70 ? 'high' : 'mid', prev = Watch.rsi[sym];
  Watch.rsi[sym] = zone;
  if (prev && prev !== zone && zone !== 'mid' && Watch.init)
    pushAlert({ lane: 'signal', text: sym + ' RSI(14) ' + (zone === 'low' ? 'below 30' : 'above 70') + ' on 1m (' + v.toFixed(0) + ')' });
}
/* With the cockpit server these run in server/monitor.js; pages only display and submit. They run here only as a claude.ai artifact or on local data. */
function runChecks() { if (Store.mode === 'server') return; checkOrders(); checkLevels(); checkStops(); checkRisk(); }
function afterPriceMove() { runChecks(); updateChartPrice(); renderLive(); }

/* ---------- trade actions ---------- */
function snapshotCandles(sym, from, to, cap) { return candlesBetween(sym, from, to, cap); }
function openTrade(acc, tk, price, how) {
  var now = appNow();
  how = how || 'Market';
  if (price == null) price = Sim.prices[tk.symbol];
  var fill = { t: now, price: price, size: Number(tk.size), lev: Number(tk.lev), type: how };
  var t = {
    id: uid('trd'), accountId: acc.id, symbol: tk.symbol, side: tk.side, status: 'open',
    sl: tk.sl === '' ? null : Number(tk.sl), tp: tk.tp === '' ? null : Number(tk.tp),
    fills: [fill], fees: how === 'Manual' && tk.feeTotal !== '' && tk.feeTotal != null && Number(tk.feeTotal) >= 0 ? Number(tk.feeTotal) : +(price * fill.size * FEE_RATE).toFixed(2),
    setup: tk.setup, ideaSource: tk.ideaSource, reason: tk.reason, mood: tk.mood, checklist: tk.checklist,
    verified: false, reviews: [], myReview: null, createdAt: now,
    entryCandles: snapshotCandles(tk.symbol, now - 40 * MIN, now, 40), rulesVersion: R.rulesFor(acc).version
  };
  put('trades', t);
  toast((how === 'Manual' ? 'Logged ' : how === 'Limit' ? 'Limit filled: ' : '') + tk.side + ' ' + qty(fill.size) + ' ' + tk.symbol + ' at ' + px(tk.symbol, price) + ' on ' + acc.name, 'good');
  return t;
}
function addToTrade(t, tk, price, how) {
  var now = appNow();
  how = how || 'Market';
  if (price == null) price = Sim.prices[t.symbol];
  var fill = { t: now, price: price, size: Number(tk.size), lev: Number(tk.lev), type: how };
  var nt = clone(t);
  nt.fills.push(fill);
  nt.fees = +((nt.fees || 0) + price * fill.size * FEE_RATE).toFixed(2);
  if (tk.sl !== '' && tk.sl != null) nt.sl = Number(tk.sl);
  put('trades', nt);
  toast((how === 'Limit' ? 'Limit filled: added ' : how === 'Manual' ? 'Logged add: ' : 'Added ') + qty(fill.size) + ' ' + t.symbol + ' at ' + px(t.symbol, price) + '. New average ' + px(t.symbol, R.summarize(nt).avgEntry), 'good');
}
/* Working limit orders: fill when price reaches the limit, after re-checking the rules. */
function placeLimit(acc, tk, price) {
  var o = { id: uid('ord'), accountId: acc.id, kind: tk.mode === 'add' ? 'add' : 'new', tradeId: tk.mode === 'add' && tk.target ? tk.target.id : null,
    symbol: tk.symbol, side: tk.side, type: 'Limit', price: price, size: Number(tk.size), lev: Number(tk.lev), sl: tk.sl, tp: tk.tp,
    setup: tk.setup, ideaSource: tk.ideaSource, reason: tk.reason, mood: tk.mood, checklist: tk.checklist, status: 'working', createdAt: appNow() };
  put('orders', o);
  toast('Limit ' + o.side.toLowerCase() + ' ' + qty(o.size) + ' ' + o.symbol + ' at ' + px(o.symbol, price) + ' is working.', 'good');
}
function workingOrders(accId) { return Store.data.orders.filter(function (o) { return o.status === 'working' && (!accId || o.accountId === accId); }); }
function checkOrders() {
  workingOrders().forEach(function (o) {
    var acc = byId('accounts', o.accountId), p = Sim.prices[o.symbol];
    if (p == null || !acc) return;
    var target = o.kind === 'add' ? byId('trades', o.tradeId) : null;
    if (o.kind === 'add' && (!target || target.status !== 'open')) { put('orders', Object.assign({}, o, { status: 'cancelled', note: 'Position closed before the add filled' })); return; }
    var reached = o.side === 'Long' ? p <= o.price : p >= o.price;
    if (!reached) return;
    var tk = Object.assign({}, o, { mode: o.kind, target: target, t: appNow() });
    var pre = R.preTrade(acc, metricsFor(acc), { t: tk.t, side: o.side, price: o.price, size: o.size, lev: o.lev, sl: o.sl, tp: o.tp }, target);
    if (acc.status !== 'active' || pre.blocked) {
      put('orders', Object.assign({}, o, { status: 'cancelled', cancelledAt: appNow(), note: acc.status !== 'active' ? 'Account not active' : 'Would have gone past a Bitfunded rule' }));
      pushAlert({ lane: 'risk', level: 'warn', accountId: acc.id, text: 'Limit ' + o.side.toLowerCase() + ' ' + o.symbol + ' at ' + px(o.symbol, o.price) + ' was not filled: it would have gone past a Bitfunded rule.' });
      return;
    }
    var t = o.kind === 'add' ? (addToTrade(target, tk, o.price, 'Limit'), target) : openTrade(acc, tk, o.price, 'Limit');
    put('orders', Object.assign({}, o, { status: 'filled', filledAt: appNow(), tradeId: t.id }));
  });
}
function ordersHTML() {
  var acc = currentAccount(), list = workingOrders(acc.id);
  if (!list.length) return '';
  return '<div class="panel-h" style="border-top:1px solid var(--line)"><h3>Working orders</h3><span class="small muted">Rules are checked again when an order fills</span></div><div class="scroll"><table><thead><tr><th>Pair</th><th>Side</th><th>Order</th><th class="num">Limit</th><th class="num">Size</th><th class="num">Leverage</th><th class="num">Distance</th><th><span class="sr">Actions</span></th></tr></thead><tbody>' +
    list.map(function (o) {
      var p = Sim.prices[o.symbol], dist = p ? (o.price - p) / p * 100 : null;
      return '<tr><td><strong>' + esc(o.symbol) + '</strong></td><td>' + o.side + '</td><td>' + (o.kind === 'add' ? 'Limit add' : 'Limit') + '</td><td class="num">' + px(o.symbol, o.price) + '</td><td class="num">' + qty(o.size) + '</td><td class="num">' + o.lev + 'x</td><td class="num">' + (dist == null ? '—' : (dist >= 0 ? '+' : '') + dist.toFixed(2) + '%') + '</td>' +
        '<td><button class="btn small" data-act="cancelOrder" data-id="' + esc(o.id) + '">Cancel</button></td></tr>';
    }).join('') + '</tbody></table></div>';
}
function closeTrade(t, price, reason, totalFees) {
  var now = appNow(), s = R.summarize(t), nt = clone(t);
  nt.status = 'closed';
  nt.exit = { t: now, price: price, reason: reason };
  nt.fees = totalFees != null ? totalFees : +((nt.fees || 0) + price * s.size * FEE_RATE).toFixed(2);
  nt.exitCandles = snapshotCandles(t.symbol, s.openedAt, now + 20 * MIN, 120);
  put('trades', nt);
  var r = R.realized(nt);
  if (r >= 0) toast(t.symbol + ' ' + t.side + ' closed (' + reason + ') ' + signedMoney(r) + '.', 'good');
  else toast(t.symbol + ' ' + t.side + ' closed (' + reason + ') ' + signedMoney(r) + '. Losses are part of the plan. Take a breath before the next trade.', 'accent');
  if (ui.editId === t.id) ui.editId = null;
}

/* ---------- Claude (sample capability) ---------- */
var Claude = { sample: undefined };
function serverSample(input, opts) {
  opts = opts || {};
  return fetch('api/ai', { method: 'POST', headers: serverHeaders(), signal: opts.signal, body: JSON.stringify({ input: input, modelTier: opts.modelTier || 'default' }) })
    .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { if (!r.ok) throw { code: b.code || 'upstream_error', message: b.message }; return b; }); })
    .then(function (b) { if (opts.onText) opts.onText({ text: b.text, delta: b.text }); return b; })
    .catch(function (e) { if (e && e.name === 'AbortError') throw { code: 'cancelled' }; if (e && e.code) throw e; throw { code: 'upstream_error', message: String(e && e.message || e) }; });
}
function getSample() {
  if (Store.mode === 'server') { Claude.sample = serverSample; return Promise.resolve(serverSample); }
  if (Claude.sample !== undefined) return Promise.resolve(Claude.sample);
  if (!window.claude || !window.claude.use) { Claude.sample = null; return Promise.resolve(null); }
  return Promise.resolve(window.claude.use('sample')).then(function (s) { Claude.sample = s || null; return Claude.sample; }).catch(function () { Claude.sample = null; return null; });
}
function sampleErrorText(e) {
  var c = e && e.code;
  if (Store.mode === 'server' && e && e.message && c !== 'cancelled') return e.message;
  if (c === 'not_configured') return 'Claude isn\u2019t set up yet: add your Anthropic API key to the .env file and restart the cockpit.';
  if (c === 'not_granted' || c === 'sampling_disabled' || c === 'not_declared' || c === 'capability_disabled') { Claude.blocked = true; return 'Claude isn’t allowed for this page in this view.'; }
  if (c === 'rate_limited') return 'Claude is busy or your usage limit is reached. Try again in a while.';
  if (c === 'session_expired') return 'Sign in to Claude again, then retry.';
  if (c === 'cancelled') return 'Stopped.';
  if (c === 'invalid_json') return 'Claude’s answer wasn’t in the expected format. Try again.';
  if (c === 'prompt_too_large') return 'Too much data for one request.';
  return 'Something went wrong talking to Claude. Try again.';
}
function parseJSON(text) {
  try { return JSON.parse(text); } catch (e) { /* try fences */ }
  var m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) { try { return JSON.parse(m[1]); } catch (e) { /* fallthrough */ } }
  var a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch (e) { /* fallthrough */ } }
  return null;
}
function tradeDigest(t, acc) {
  var s = R.summarize(t), f = R.positionFlags(t, acc, t.exit ? t.exit.t : appNow());
  return {
    id: t.id, account: acc.name, accountType: typeOf(acc), stage: acc.stage, accountSize: acc.size, symbol: t.symbol, side: t.side,
    fills: t.fills.map(function (x) { return { time: new Date(x.t).toISOString(), price: +x.price.toFixed(4), size: x.size, leverage: x.lev }; }),
    avgEntry: +s.avgEntry.toFixed(4), totalSize: s.size, effectiveLeverage: +s.effLeverage.toFixed(2), maxLeverageAllowed: R.rulesFor(acc).maxLeverage,
    stopLoss: t.sl, takeProfit: t.tp, riskAtStop: R.riskToStop(t), fees: t.fees,
    exit: t.exit ? { time: new Date(t.exit.t).toISOString(), price: +t.exit.price.toFixed(4), reason: t.exit.reason } : null,
    realizedPnl: t.exit ? +R.realized(t).toFixed(2) : null, rMultiple: t.exit && R.rMultiple(t) != null ? +R.rMultiple(t).toFixed(2) : null,
    heldMinutes: t.exit ? Math.round((t.exit.t - s.openedAt) / MIN) : null,
    setup: t.setup, ideaSource: t.ideaSource, reason: t.reason, mood: t.mood, checklist: t.checklist,
    ruleFlags: f.flags.map(function (x) { return x.text; })
  };
}
function behaviourContext(t) {
  var mine = tradesOf(t.accountId).filter(function (x) { return x.status === 'closed' && x.id !== t.id; }).sort(function (a, b) { return a.exit.t - b.exit.t; });
  var before = mine.filter(function (x) { return x.exit.t <= R.summarize(t).openedAt; });
  var last = before[before.length - 1];
  var minsAfterLoss = last && R.realized(last) < 0 ? Math.round((R.summarize(t).openedAt - last.exit.t) / MIN) : null;
  return {
    minutesSincePreviousLossWhenEntered: minsAfterLoss,
    recentTrades: mine.slice(-10).map(function (x) { var r = R.rMultiple(x); return { setup: x.setup, side: x.side, symbol: x.symbol, r: r == null ? null : +r.toFixed(2), exitReason: x.exit.reason, mood: x.mood }; })
  };
}
function buildReviewPrompt(t, acc) {
  var s = R.summarize(t);
  var pre = (t.entryCandles && t.entryCandles.length ? t.entryCandles : candlesBetween(t.symbol, s.openedAt - 40 * MIN, s.openedAt, 40));
  var post = t.exitCandles || [];
  return [
    'You are a strict, objective trading coach reviewing ONE trade from a Bitfunded prop-firm challenge journal. This is a TEST environment with simulated prices.',
    'Rules of the review:',
    '- Grade PROCESS, not profit. A losing trade with good process can earn an A; a winning trade with bad process can earn a D.',
    '- Every criticism must cite a data field from the payload (e.g. "stopLoss: null", "minutesSincePreviousLossWhenEntered: 25").',
    '- No filler praise. If the data is too thin to judge an item, say so in its cite and score it 5.',
    '- The trader’s mood note must not soften the grade.',
    '- Judge entry ONLY from preEntryCandles (no hindsight). Use postEntryCandles only for exit and management.',
    '- Bitfunded 2-step rules: daily loss 5%, max loss 10% (Stage 1) / 8% (Stage 2, Funded), leverage 1:5, max 5 open positions, exposure under 65% of margin, hold caps 10 days major crypto / 7 days minor / 5 days metals, trades should stay open 10+ minutes, SL and TP expected, no hedging across accounts. Any rule breach caps the whole grade at D.',
    '- If a better position was available (entry location, structural stop, size matching risk), describe it concretely and estimate its R-multiple from the candles. Label it a hypothesis. If none, set available to false.',
    '- Compare with the trader’s own review and say where you disagree, in one or two sentences.',
    '',
    'Rubric (score each 0-10):',
    RUBRIC.map(function (r, i) { return (i + 1) + '. ' + r[0] + ': ' + r[1]; }).join('\n'),
    '',
    'Reply with ONLY a JSON object of this shape:',
    '{"processGrade":"A|B|C|D|F","rubric":[{"name":"Rule compliance","score":0,"cite":"..."}, ...7 items in rubric order],"breaches":["..."],"disagreement":"...","betterPosition":{"available":true,"description":"...","altR":1.8},"patterns":["..."],"summary":"2-3 sentences","confidence":"low|medium|high"}',
    '',
    'Candle rows are [timeMs, open, high, low, close] on 1-minute bars.',
    'PAYLOAD:',
    JSON.stringify({ trade: tradeDigest(t, acc), tradersOwnReview: t.myReview, behaviour: behaviourContext(t), preEntryCandles: pre, postEntryCandles: post })
  ].join('\n');
}
function runReview(t, model) {
  var acc = byId('accounts', t.accountId);
  if (!acc) return;
  if (ui.reviewBusy[t.id]) return;
  getSample().then(function (sample) {
    if (!sample) { ui.reviewErr[t.id] = 'Claude isn’t available in this view. Open the cockpit on claude.ai to run reviews.'; renderRoute(); return; }
    var ctl = new AbortController();
    ui.reviewBusy[t.id] = { model: model, ctl: ctl, chars: 0 };
    ui.reviewErr[t.id] = null;
    renderRoute();
    sample(buildReviewPrompt(t, acc), {
      modelTier: model === 'opus' ? 'complex' : 'default', cache: false, signal: ctl.signal,
      onText: function (u) { if (ui.reviewBusy[t.id]) { ui.reviewBusy[t.id].chars = u.text.length; var el = document.getElementById('revProgress'); if (el) el.textContent = 'Writing the review… ' + u.text.length + ' characters'; } }
    }).then(function (res) {
      var data = parseJSON(res.text);
      ui.reviewBusy[t.id] = null;
      if (!data || !data.processGrade) { ui.reviewErr[t.id] = 'Claude’s answer wasn’t in the expected format. Try again.'; renderRoute(); return; }
      var fresh = byId('trades', t.id) || t, nt = clone(fresh);
      nt.reviews = (nt.reviews || []).concat([{ id: uid('rev'), model: model, modelId: res.model || null, costUsd: res.costUsd == null ? null : res.costUsd, modelTierAsked: model === 'opus' ? 'complex' : 'default', modelTierApplied: res.modelTierApplied, rubricVersion: RUBRIC_VERSION, createdAt: appNow(), truncated: !!res.truncated, result: data }]);
      put('trades', nt);
      renderRoute();
    }).catch(function (e) {
      ui.reviewBusy[t.id] = null;
      ui.reviewErr[t.id] = sampleErrorText(e);
      renderRoute();
    });
  });
}
function dataSummaryForChat() {
  var now = appNow();
  return JSON.stringify({
    now: new Date(now).toISOString(),
    accounts: accounts().map(function (a) { var m = metricsFor(a); return { name: a.name, type: typeOf(a), stage: a.stage, status: a.status, size: a.size, dailyLossPct: +m.dailyLossPct.toFixed(2), totalLossPct: +m.totalLossPct.toFixed(2), profitPct: +m.profitPct.toFixed(2), open: m.openCount }; }),
    trades: Store.data.trades.slice().sort(function (a, b) { return b.createdAt - a.createdAt; }).slice(0, 60).map(function (t) {
      var a = byId('accounts', t.accountId) || {}; var r = t.exit ? R.rMultiple(t) : null;
      return { account: a.name, type: a.id ? typeOf(a) : '', symbol: t.symbol, side: t.side, status: t.status, opened: new Date(t.createdAt).toISOString(), setup: t.setup, ideaSource: t.ideaSource, mood: t.mood, r: r == null ? null : +r.toFixed(2), pnl: t.exit ? +R.realized(t).toFixed(2) : null, exitReason: t.exit ? t.exit.reason : null, myScore: t.myReview ? t.myReview.score : null, claudeGrades: (t.reviews || []).map(function (v) { return v.result.processGrade; }) };
    })
  });
}
function sendChat(text) {
  if (!text.trim() || ui.chatBusy) return;
  getSample().then(function (sample) {
    if (!sample) { ui.chat.push({ role: 'assistant', content: 'Claude isn’t available in this view. Open the cockpit on claude.ai to chat about your data.' }); renderRoute(); return; }
    ui.chat.push({ role: 'user', content: text });
    ui.chat.push({ role: 'assistant', content: '', pending: true });
    ui.chatBusy = true; renderRoute();
    var instr = 'You answer questions about the user’s own Bitfunded trading journal (TEST environment, simulated prices). Use only the data below; say when the sample is too small (under 30 trades per setup) to conclude anything. Keep Demo, Live and Paper results separate unless asked. Be direct and specific, cite numbers. Plain text, no markdown headings.\n\nDATA:\n' + dataSummaryForChat();
    var turns = [{ role: 'user', content: instr }].concat(ui.chat.filter(function (m) { return !m.pending; }).slice(-10).map(function (m) { return { role: m.role, content: m.content }; }));
    sample(turns, { cache: false, onText: function (u) { var last = ui.chat[ui.chat.length - 1]; last.content = u.text; var el = document.getElementById('chatLast'); if (el) el.textContent = u.text; } })
      .then(function (res) { var last = ui.chat[ui.chat.length - 1]; last.content = res.text; last.pending = false; })
      .catch(function (e) { var last = ui.chat[ui.chat.length - 1]; last.content = (e.text ? e.text + '\n\n' : '') + sampleErrorText(e); last.pending = false; })
      .then(function () { ui.chatBusy = false; renderRoute(); });
  });
}
function askCoach() {
  var acc = currentAccount(); if (!acc) return;
  var tk = readTicket(), pre = ticketPreview(acc, tk);
  getSample().then(function (sample) {
    if (!sample) { ui.coach = { text: 'Claude isn’t available in this view.' }; renderTicketCoach(); return; }
    ui.coach = { text: 'Thinking…', busy: true }; renderTicketCoach();
    var m = metricsFor(acc);
    var prompt = 'You are a blunt pre-trade risk coach for a Bitfunded challenge (TEST environment). In at most 3 short sentences, say whether this trade fits the rules and the trader’s current state, and the single most important adjustment. No preamble.\n' + JSON.stringify({
      account: { name: acc.name, type: typeOf(acc), stage: acc.stage, size: acc.size, dailyLossPct: +m.dailyLossPct.toFixed(2), dailyLimitPct: m.cfg.dailyLossPct, openPositions: m.openCount, exposurePct: +m.exposurePct.toFixed(1), minutesToDailyReset: Math.round((m.day.nominalReset - appNow()) / MIN) },
      ticket: { mode: ui.ticketMode, symbol: tk.symbol, side: tk.side, price: Sim.prices[tk.symbol], size: tk.size, leverage: tk.lev, stopLoss: tk.sl, takeProfit: tk.tp, setup: tk.setup, mood: tk.mood, checklist: tk.checklist },
      ruleChecks: pre ? pre.checks.map(function (c) { return (c.ok ? 'OK: ' : 'ISSUE: ') + c.text; }) : []
    });
    sample(prompt, { modelTier: 'quick', cache: false, onText: function (u) { ui.coach = { text: u.text, busy: true }; renderTicketCoach(); } })
      .then(function (res) { ui.coach = { text: res.text }; })
      .catch(function (e) { ui.coach = { text: sampleErrorText(e) }; })
      .then(renderTicketCoach);
  });
}

/* ---------- UI state ---------- */
var ui = {
  phoneView: 'home', tkMore: false, sizeFrom: 'size', acctId: lsGet('cockpit-acct', null), sym: 'BTC/USDT', tf: lsGet('cockpit-tf', '1m'), levelMode: lsGet('cockpit-level-mode', 'price'), drawTool: null, drawSel: null, ticketMode: 'new', side: 'Long', lev: 5, addTarget: null,
  editId: null, confirm: null, journalType: 'All', journalAcct: 'all', journalStatus: 'all',
  reviewBusy: {}, reviewErr: {}, reviewModel: {}, chat: [], chatBusy: false, coach: null, socialEdit: null
};
function setAccount(id) { ui.acctId = id; lsSet('cockpit-acct', id); ui.addTarget = null; focusOpenPosition(); renderTopbar(); renderRoute(); }

/* ---------- rendering infrastructure ---------- */
var renderQueued = false;
function scheduleRender() { if (renderQueued) return; renderQueued = true; requestAnimationFrame(function () { renderQueued = false; renderTopbar(); renderRoute(); }); }
function preserveForm(fn) {
  var root = document.getElementById('app');
  var vals = {}, active = document.activeElement, activeId = active && active.id, selS, selE;
  root.querySelectorAll('input[id], select[id], textarea[id]').forEach(function (el) { vals[el.id] = el.type === 'checkbox' ? el.checked : el.value; });
  if (active && 'selectionStart' in active) { try { selS = active.selectionStart; selE = active.selectionEnd; } catch (e) { /* not a text input */ } }
  var y = window.scrollY;
  fn();
  Object.keys(vals).forEach(function (id) { var el = document.getElementById(id); if (!el || el.dataset.fresh) return; if (el.type === 'checkbox') el.checked = vals[id]; else el.value = vals[id]; });
  if (activeId) { var a = document.getElementById(activeId); if (a) { a.focus({ preventScroll: true }); try { if (selS != null) a.setSelectionRange(selS, selE); } catch (e) { /* ignore */ } } }
  window.scrollTo(0, y);
}
function route() { var h = (location.hash || '#dashboard').slice(1); return h || 'dashboard'; }
function renderTopbar() {
  var sel = document.getElementById('acctSel');
  var cur = currentAccount();
  sel.innerHTML = accounts().map(function (a) { return '<option value="' + esc(a.id) + '"' + (cur && a.id === cur.id ? ' selected' : '') + '>' + esc(a.name + ' · ' + a.stage + (a.status !== 'active' ? ' · ' + a.status : ' · ' + typeOf(a))) + '</option>'; }).join('');
  var r = route();
  document.querySelectorAll('#nav a').forEach(function (a) { var on = a.getAttribute('href') === '#' + r || (r.indexOf('t-') === 0 && a.getAttribute('href') === '#journal'); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  var more = document.getElementById('navMore');
  if (more) more.classList.toggle('on', !!more.querySelector('a[aria-current="page"]'));
  applyPhoneView();
}
/* On a phone the dashboard is three screens: summary, chart and new trade. Larger screens show all of them, so this changes nothing there. */
function applyPhoneView() {
  document.body.dataset.pv = ui.phoneView || 'home';
  var onDash = route() === 'dashboard', chart = onDash && ui.phoneView === 'chart';
  var btn = document.getElementById('navChart'), home = document.querySelector('#nav a[href="#dashboard"]');
  if (btn) { if (chart) btn.setAttribute('aria-current', 'page'); else btn.removeAttribute('aria-current'); }
  if (home && chart) home.removeAttribute('aria-current');
}
function renderRoute() {
  if (!Store.ready) return;
  if (Sim.started) syncPairs();
  var r = route();
  var app = document.getElementById('app');
  var acc = currentAccount();
  var key = r + '|' + (acc ? acc.id : '') + '|' + ui.sym + '|' + ui.tf + '|' + Store.data.accounts.length;
  if (r === 'dashboard' && acc && app.dataset.key === key && Chart.chart) {
    preserveForm(function () {
      setHTML('dbTicket', ticketHTML(), true);
      setHTML('dbEdit', editHTML(), true);
      setHTML('dbLevels', levelsListHTML(), true);
      syncDrawUI();
      setHTML('dbPositions', positionsHTML(), true);
      setHTML('dbOrders', ordersHTML(), true);
    });
    renderTicketCoach();
    renderLive();
    return;
  }
  app.dataset.key = key;
  preserveForm(function () {
    var html;
    if (!Store.data.accounts.length) html = viewEmpty();
    else if (r === 'challenges') html = viewChallenges();
    else if (r === 'journal') html = viewJournal();
    else if (r.indexOf('t-') === 0) html = viewTrade(r.slice(2));
    else if (r === 'socials') html = viewSocials();
    else if (r === 'pairs') html = viewPairs();
    else if (r === 'feed') html = viewFeed();
    else if (r === 'lab') html = viewLab();
    else html = viewDashboard();
    destroyChart();
    app.innerHTML = html;
    if (r === 'dashboard' && Store.data.accounts.length) mountChart();
  });
  renderTicketCoach();
  renderLive();
}
function renderLive() {
  if (!Store.ready) return;
  updateLevelHints();
  var now = appNow(), day = R.dayBounds(now);
  var mc = document.getElementById('miniClock');
  var r = route();
  var ls = document.getElementById('liveStatus');
  if (ls) {
    var fh = feedHealth(), simulated = Store.mode !== 'server' || !Feed.snap || Feed.snap.source === 'simulated';
    var lsText = simulated ? 'Simulated prices' : fh ? 'Live prices · interrupted' : 'Live prices · connected';
    if (ls.textContent !== lsText) ls.textContent = lsText;
    ls.classList.toggle('bad', !!fh);
  }
  if (mc) { mc.hidden = r === 'dashboard' && Store.data.accounts.length > 0; mc.innerHTML = 'Day resets in <b>' + hms(day.nominalReset - now) + '</b>'; }
  if (!Store.data.accounts.length) return;
  if (r === 'dashboard') {
    setHTML('dbClock', clockHTML());
    setHTML('dbBanners', bannersHTML());
    setHTML('dbGauges', gaugesHTML());
    setHTML('dbPositions', positionsHTML());
    setHTML('dbPosNote', posNoteHTML());
    setHTML('dbOrders', ordersHTML());
    setHTML('dbFeed', feedHTML());
    setHTML('dbPrice', priceHeadHTML());
    setHTML('dbSrc', 'Price source: ' + esc(priceSourceLabel(ui.sym)));
    renderTicketPreview();
  } else if (r === 'challenges') {
    setHTML('chGuard', guardHTML()); setHTML('chCards', cardsHTML());
  } else if (r === 'feed' && Store.mode === 'server') {
    setHTML('feedLive', feedLiveHTML());
    if (!Interacting) setHTML('feedTable', feedRowsHTML());
  } else if (r === 'lab') {
    setHTML('labClock', labClockHTML()); setHTML('labPositions', labPositionsHTML());
  }
}
var Interacting = false, interactTimer = null;
document.addEventListener('pointerdown', function () { Interacting = true; clearTimeout(interactTimer); }, true);
document.addEventListener('pointerup', function () { clearTimeout(interactTimer); interactTimer = setTimeout(function () { Interacting = false; }, 350); }, true);
function setHTML(id, html, force) {
  var el = document.getElementById(id);
  if (!el || el._last === html) return;
  if (Interacting && !force) return;
  var a = document.activeElement, key = a && el.contains(a) ? (a.id ? '#' + a.id : a.dataset && a.dataset.act ? '[data-act="' + a.dataset.act + '"]' + (a.dataset.id ? '[data-id="' + a.dataset.id + '"]' : '') : null) : null;
  el.innerHTML = html; el._last = html;
  if (key) { try { var n = el.querySelector(key); if (n) n.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
}

/* ---------- views: empty ---------- */
function viewEmpty() {
  return '<section class="panel"><div class="panel-b" style="align-items:flex-start;gap:14px;padding:28px 24px">' +
    '<h1>No test data yet</h1><p class="muted" style="max-width:60ch;margin:0">This is the test cockpit. Load the sample set to get four Bitfunded challenges (one failed, one funded, two in Stage 1), a paper account, open positions, today’s losses and a few price alerts. Every sample record is marked as sample data.</p>' +
    '<div class="inline"><button class="btn primary" data-act="loadSample">Load sample test data</button><button class="btn" data-act="startBlank">Start blank</button></div>' +
    '<p class="small muted" style="margin:0">' + storeNote() + '</p></div></section>';
}
function storeNote() { if (Store.mode === 'server') return 'Saved on this computer in the cockpit\u2019s Docker volume. A backup is written every night and the last 14 are kept.'; return Store.mode === 'db' ? 'Your data is saved to this cockpit’s store and survives reloads.' : 'Saving to this cockpit’s store isn’t available in this view, so data stays in this browser only.'; }

/* ---------- views: dashboard ---------- */
function viewDashboard() {
  var acc = currentAccount(), cfg = R.rulesFor(acc);
  return '<div id="dbBanners" class="stack">' + bannersHTML() + '</div>' +
    '<section aria-label="Risk summary" class="risk-strip"><div id="dbGauges" style="display:contents">' + gaugesHTML() + '</div>' +
    '<section class="gauge" id="dbClockWrap" aria-labelledby="clockH"><div id="dbClock" style="display:contents">' + clockHTML() + '</div></section></section>' +
    '<div class="rules-line">' + typeTag(acc) + '<span>Bitfunded rules · ' + esc(acc.name) + ' · ' + esc(acc.program) + ' ' + esc(acc.stage) + ' · ' + esc(cfg.version) + (acc.paper ? ' · shadow rules, not counted' : '') + '</span></div>' +
    '<div class="dash-grid"><div class="dash-main"><section class="panel" id="dbChartPanel" aria-labelledby="chartH">' + chartPanelHTML() + '</section>' +
    '<section class="panel" id="dbPosPanel" aria-labelledby="posH"><div class="panel-h"><h2 id="posH" style="font-size:15px">Open positions</h2><span class="grow"></span><span class="small muted" id="dbPosNote">' + posNoteHTML() + '</span></div><div id="dbPositions">' + positionsHTML() + '</div><div id="dbEdit">' + editHTML() + '</div><div id="dbOrders">' + ordersHTML() + '</div></section></div>' +
    '<div class="dash-side"><section class="panel" aria-labelledby="tkH" id="dbTicket">' + ticketHTML() + '</section>' +
    '<section class="panel" id="dbFeedPanel" aria-labelledby="feedH"><div class="panel-h"><h2 id="feedH" style="font-size:15px">Alerts</h2></div><ul class="feed" id="dbFeed">' + feedHTML() + '</ul></section></div>' +
    '<button type="button" class="btn primary phone-only" id="phoneNew" data-act="phoneView" data-v="trade">New trade</button></div>';
}
function posNoteHTML() {
  var acc = currentAccount(), m = metricsFor(acc), n = m.openCount;
  return (n ? 'Net floating ' + signedMoney(m.unrealized) + ' · ' : '') + n + ' of ' + m.cfg.maxPositions;
}
function clockHTML() {
  var now = appNow(), day = R.dayBounds(now), left = day.nominalReset - now, settling = now >= day.nominalReset;
  var late = !settling && left < HOUR;
  var wrap = document.getElementById('dbClockWrap'); if (wrap) wrap.classList.toggle('late', late);
  var note = settling ? 'Bitfunded settles the reset within 10 minutes. Treat this as the old day.' : late ? 'Final hour: a loss now still counts against today\u2019s limit.' : '';
  var acc = currentAccount(), m = metricsFor(acc), pos = m.gauges[2], exp = m.gauges[3];
  return '<div class="tile-h"><h2 id="clockH">' + (settling ? 'Old day until' : 'Day resets in') + '</h2></div>' +
    '<div class="big">' + (settling ? tz(day.settleEnd, 'Europe/London') : hms(left)) + '</div>' +
    '<div class="note">' + (note || '00:00 UTC+8 · ' + tz(day.nominalReset, 'Europe/London') + ' London') + '</div>' +
    '<div class="note"><span class="' + (pos.level === 'ok' ? '' : 'c-' + pos.level) + '">' + pos.value + ' of ' + pos.limit + ' positions</span> · <span class="' + (exp.level === 'ok' ? '' : 'c-' + exp.level) + '">' + exp.value.toFixed(0) + '% exposure</span></div>' +
    '<div class="note">Leverage max 1:' + m.cfg.maxLeverage + '</div>';
}
function feedHealth() {
  if (Store.mode !== 'server') return null;
  if (Store.serverDown) return { level: 'breach', text: 'The cockpit server isn\u2019t answering. Prices and saving are paused until it\u2019s back.' };
  var snap = Feed.snap; if (!snap || snap.source === 'simulated') return null;
  var st = snap.status || {}, ago = st.lastMessageAgoMs;
  if (st.state === 'connected' && ago != null && ago < 30000) return null;
  var name = FEED_SOURCES[snap.source] || snap.source;
  return { level: 'breach', text: ago == null ? 'Waiting for the first live price from ' + name + '. Until it arrives, prices are simulated.' : 'Live prices from ' + name + ' stopped ' + Math.round(ago / 1000) + ' s ago (' + (st.error || st.state) + '). The gauges may be out of date.' };
}
function bannersHTML() {
  var acc = currentAccount(); if (!acc) return '';
  var m = metricsFor(acc), out = [];
  var fh = feedHealth(); if (fh) out.push('<div class="banner ' + fh.level + '" role="alert"><strong>Prices:</strong><span>' + esc(fh.text) + '</span><a href="#feed">Data feed</a></div>');
  var worst = m.gauges.slice().sort(function (a, b) { return RANK[b.level] - RANK[a.level]; })[0];
  if (acc.status !== 'active') out.push('<div class="banner info"><strong>' + esc(acc.name) + ' is ' + esc(acc.status) + '.</strong><span>Trading is off for this account. Pick an active one in the top bar.</span></div>');
  else if (worst.level !== 'ok') {
    var g = worst;
    var text = g.level === 'breach' ? g.label + ' has reached the limit on ' + acc.name + '. In a real challenge this would end the account. Step away for now; the next opportunity can wait.' :
      g.key === 'daily' ? 'Daily loss is at ' + pct(g.value) + ' of the ' + g.limit + '% limit (' + (g.ratio * 100).toFixed(0) + '%). Room left: ' + money(m.dailyRoom) + '.' :
      g.label + ' is at ' + (g.unit === '%' ? pct(g.value, 1) : g.value) + ' of ' + g.limit + g.unit + '.';
    out.push('<div class="banner ' + g.level + '" role="alert"><strong>' + (g.level === 'breach' ? 'Limit reached:' : 'Heads up:') + '</strong><span>' + esc(text) + '</span>' + (g.level === 'breach' && !acc.paper ? '<button class="btn small danger" data-act="failAcc" data-id="' + esc(acc.id) + '">Mark challenge failed</button>' : '') + '</div>');
  }
  var cross = R.crossAccount(Store.data.accounts, Store.data.trades, appNow());
  if (cross.hedges.length) out.push('<div class="banner breach"><strong>Hedge across accounts:</strong><span>' + cross.hedges.map(function (h) { return esc(h.symbol + ' (' + h.accounts.map(function (id) { return (byId('accounts', id) || {}).name; }).join(' vs ') + ')'); }).join(', ') + '. Bitfunded bans this.</span><a href="#challenges">See guard</a></div>');
  return out.join('');
}
function gaugesHTML() {
  var acc = currentAccount(), m = metricsFor(acc), daily = m.gauges[0], total = m.gauges[1];
  var floor = acc.size * (1 - m.cfg.maxLossPct / 100);
  var qual = 'Qualifying trades ' + m.qualifyingClosed + ' of ' + m.cfg.minClosedTrades;
  var target;
  if (m.targetPct != null) {
    var goal = acc.size * m.targetPct / 100, done = Math.max(0, m.realizedAll) / goal, met = done >= 1;
    target = '<div class="gauge"><div class="tile-h"><span>Profit target</span>' + (met ? '<span class="c-good" style="font-weight:600">Met</span>' : '') + '</div><div class="big">' + esc(money(m.realizedAll)) + '</div>' +
      '<div class="bar ' + (met ? 'good' : '') + '" role="img" aria-label="' + (done * 100).toFixed(0) + '% of the profit target reached"><i style="width:' + Math.min(100, done * 100).toFixed(1) + '%"></i></div>' +
      '<div class="note">Closed trades, of ' + esc(money(goal)) + ' (' + m.targetPct + '%)</div><div class="note desk-note">' + qual + '</div></div>';
  } else {
    target = '<div class="gauge"><div class="tile-h"><span>Funded P/L</span></div><div class="big">' + esc(signedMoney(m.realizedAll)) + '</div><div class="note">Closed trades</div><div class="note desk-note">' + qual + '</div></div>';
  }
  return roomTile(daily, m) +
    '<div class="gauge ' + total.level + '"><div class="tile-h"><span>Room left in total</span>' + statusTag(total.level, true) + '</div><div class="big' + (total.level === 'ok' ? '' : ' c-' + total.level) + '">' + esc(money(Math.max(0, m.totalRoom))) + '</div>' +
    '<div class="note">Above your ' + esc(money(floor)) + ' floor (' + m.cfg.maxLossPct + '%)</div><div class="note desk-note">Equity ' + esc(money(m.equity)) + '</div></div>' +
    target;
}
function statusTag(level, onlyIfNotOk) {
  if (onlyIfNotOk && level === 'ok') return '';
  return '<span class="c-' + (level === 'ok' ? 'good' : level) + '" style="font-weight:600">' + { ok: 'Clear', warn: 'Watch', danger: 'Slow down', breach: 'Limit reached' }[level] + '</span>';
}
function roomTile(g, m) {
  var fill = Math.min(100, g.ratio * 100), max = m.dailyRoom + m.dailyLoss, floating = Math.max(0, m.dailyLoss - m.realizedPart);
  var now = appNow(), left = R.dayBounds(now).nominalReset - now;
  return '<div class="gauge hero ' + g.level + '"><div class="tile-h"><span>Room left today</span>' + statusTag(g.level) + '</div>' +
    '<div class="room"><span class="v' + (g.level === 'ok' ? '' : ' c-' + g.level) + '">' + esc(money(Math.max(0, m.dailyRoom))) + '</span><span class="muted">of <strong>' + esc(money(max)) + '</strong> max daily loss (' + g.limit + '%)</span></div>' +
    '<div class="bar ' + g.level + '" role="img" aria-label="' + esc(fill.toFixed(0) + '% of the daily limit used') + '"><i style="width:' + fill.toFixed(1) + '%"></i><span class="tick" style="left:60%"></span><span class="tick" style="left:90%"></span></div>' +
    '<div class="note">' + esc(money(m.dailyLoss)) + ' used: ' + esc(money(m.realizedPart)) + ' realised, ' + esc(money(floating)) + ' floating</div>' +
    '<div class="note phone-only">Resets in <span class="mono" style="color:var(--fg)">' + (left > 0 ? hms(left) : 'settling') + '</span></div></div>';
}
function chartPanelHTML() {
  return '<div class="chart-head"><h2 id="chartH" class="sr">Chart</h2><label class="sr" for="chartSym">Pair</label><select id="chartSym" class="chart-sym" data-fresh="1">' + pairOptions(ui.sym) + '</select>' +
    '<span id="dbPrice" class="inline">' + priceHeadHTML() + '</span><div id="dbChartTools" class="chart-tools">' + chartToolsHTML() + '</div></div>' +
    '<div class="chart-wrap"><div id="dbChartHint" class="chart-hint">' + chartHintHTML() + '</div><div id="chart"></div></div>' +
    '<div class="chart-foot"><div class="seg" role="group" aria-label="Quick pairs">' + QUICK.map(function (s) { return '<button type="button" data-act="sym" data-sym="' + s + '" aria-pressed="' + (ui.sym === s) + '">' + s.split('/')[0] + '</button>'; }).join('') + '</div><span style="flex:1 1 auto"></span>' +
    '<form class="inline" id="levelForm" style="gap:6px"><label class="sr" for="lvlPrice">Alert price</label><input id="lvlPrice" type="number" step="any" placeholder="Alert price" style="width:150px;min-height:36px"><label class="sr" for="lvlNote">Note</label><input id="lvlNote" type="text" placeholder="Note" style="width:120px;min-height:36px"><button class="btn small warn" type="submit">+ Price alert</button></form></div>' +
    '<div id="dbLevels">' + levelsListHTML() + '</div>' +
    '<div class="small muted" style="padding:8px 16px;border-top:1px solid var(--line)"><a href="#feed" id="dbSrc">Price source: ' + esc(priceSourceLabel(ui.sym)) + '</a> · ' + tfInfo(ui.tf).name + ' candles<span id="dbTfNote"></span> · lines show entries, stops, targets and alerts for ' + esc(currentAccount().name) + '</div>';
}
function priceSourceLabel(sym) {
  if (Store.mode !== 'server') return FEED_SOURCES[feedSettings().source] || 'Simulated';
  var src = Feed.snap ? Feed.snap.source : 'simulated', s = (Sim.src || {})[sym];
  return src === 'simulated' ? 'Simulated' : (FEED_SOURCES[src] || src) + (s === 'live' ? ' · live' : s === 'stale' ? ' · stale' : ' · simulated for this pair');
}
function priceHeadHTML() {
  var cs = ensureCandles(ui.sym), p = Sim.prices[ui.sym], back = cs[Math.max(0, cs.length - 61)];
  var change = back && back.close > 0 ? (p / back.close - 1) * 100 : null;
  return '<span class="num" style="font-size:18px;font-weight:600">' + px(ui.sym, p) + '</span>' +
    (change == null ? '' : '<span class="small num ' + (change >= 0 ? 'c-good' : 'c-loss') + '" title="Change over the last hour">' + (change >= 0 ? '+' : '\u2212') + Math.abs(change).toFixed(2) + '% 1h</span>');
}
function levelsListHTML() {
  var ls = Store.data.levels.filter(function (l) { return l.active && l.symbol === ui.sym; });
  if (!ls.length) return '';
  return '<div class="inline small" style="padding:8px 16px;border-top:1px solid var(--line)"><span class="muted">Active alerts:</span>' + ls.map(function (l) { return '<span class="tag warn">' + esc(px(l.symbol, l.price)) + (l.note ? ' · ' + esc(l.note) : '') + ' <button class="btn small" style="min-height:24px;padding:0 6px" data-act="delLevel" data-id="' + esc(l.id) + '" aria-label="Delete alert at ' + esc(px(l.symbol, l.price)) + '">×</button></span>'; }).join('') + '</div>';
}
function feedHTML() {
  var items = mergeAlerts(Store.meta.feed.items || []).slice(0, 40);
  if (!items.length) return '<li class="muted">No alerts yet. Set a price alert to get started.</li>';
  var cur = currentAccount();
  return items.map(function (a) {
    var cls = a.lane === 'risk' ? (a.level === 'good' ? 'good' : a.level === 'breach' || a.level === 'danger' ? 'danger' : 'warn') : a.lane === 'trade' && a.level === 'good' ? 'good' : a.lane === 'signal' ? 'good' : '';
    var other = a.accountId && cur && a.accountId !== cur.id ? byId('accounts', a.accountId) : null;
    return '<li style="font-size:13px"><span class="dot ' + cls + '" aria-hidden="true"></span><span class="sr">' + esc(a.lane) + ': </span><div style="min-width:0;flex:1 1 auto"><div>' + esc(a.text) + '</div>' + (a.count > 1 || other ? '<div class="small muted">' + (a.count > 1 ? a.count + ' times, first ' + esc(dateShort(a.first)) : '') + (a.count > 1 && other ? ' · ' : '') + (other ? 'other account: ' + esc(other.name) : '') + '</div>' : '') + '</div><span class="feed-time">' + esc(dateShort(a.t)) + '</span></li>';
  }).join('');
}
/* Display only: repeats of one alert in the same Bitfunded day show as one line. Stored alerts are left as they are. */
function mergeAlerts(items) {
  var seen = {}, out = [];
  items.forEach(function (a) {
    var key = [a.lane, a.accountId || '', String(a.text).replace(/\s*\([^)]*\)/g, ''), R.dayBounds(a.t).nominalReset].join('|');
    var s = seen[key];
    if (!s) { seen[key] = Object.assign({}, a, { count: 1, first: a.t }); out.push(seen[key]); return; }
    s.count++; s.first = Math.min(s.first, a.t);
    if (a.t > s.t) { s.t = a.t; s.text = a.text; s.level = a.level; }
  });
  return out.sort(function (x, y) { return y.t - x.t; });
}
/* Closing by hand: the exit price is yours to set, because a Bitfunded fill can differ from the cockpit's feed. */
function closeFeesEstimate(t, price) { return +((t.fees || 0) + price * R.summarize(t).size * FEE_RATE).toFixed(2); }
function closeEstimate(t, price, fees) {
  return R.realized(Object.assign({}, t, { exit: { price: price }, fees: fees == null ? closeFeesEstimate(t, price) : fees }));
}
function closeEstHTML(t) {
  var typed = Number(document.getElementById('closePrice').value), raw = document.getElementById('closeFee').value;
  if (!(typed > 0)) return 'Enter a price';
  return (raw === '' ? 'Estimated after fees: ' : 'After your fees: ') + signedMoney(closeEstimate(t, typed, raw === '' ? null : Number(raw)));
}
function closeFormHTML(t, price) {
  return '<form class="inline" id="closeForm" data-id="' + esc(t.id) + '" style="padding:12px 16px;border-top:1px solid var(--line);align-items:flex-end"><strong style="flex:1 1 100%">Close ' + esc(t.symbol + ' ' + t.side) + '</strong>' +
    '<p class="small muted" style="flex:1 1 100%;margin:0">Enter the exit price from Bitfunded. It starts at the current feed price, which can differ.</p>' +
    '<label class="f" for="closePrice">Exit price<input id="closePrice" type="number" step="any" min="0" value="' + price + '"></label>' +
    '<label class="f" for="closeFee">Total fees and costs ($)<input id="closeFee" type="number" step="any" min="0" placeholder="Estimate: ' + closeFeesEstimate(t, price) + '"></label>' +
    '<span class="small" id="closeEst" style="align-self:center">Estimated after fees: ' + signedMoney(closeEstimate(t, price)) + '</span>' +
    '<button class="btn danger" type="submit">Close position</button><button class="btn" type="button" data-act="cancelConfirm">Keep open</button></form>';
}
function editHTML() {
  var c = ui.confirm && ui.confirm.kind === 'close' ? byId('trades', ui.confirm.id) : null;
  if (c && c.status === 'open') return closeFormHTML(c, ui.confirm.price);
  var t = ui.editId && byId('trades', ui.editId);
  if (!t || t.status !== 'open') return '';
  return '<form class="inline" id="slForm" data-id="' + esc(t.id) + '" style="padding:12px 16px;border-top:1px solid var(--line);align-items:flex-end"><strong style="flex:1 1 100%">Edit stop and target · ' + esc(t.symbol + ' ' + t.side) + '</strong>' + levelModeHTML() + levelFieldHTML('slEdit', 'sl', 'Stop loss', levelShown(t.sl, 'sl', t.side, R.summarize(t).avgEntry), true) + levelFieldHTML('tpEdit', 'tp', 'Take profit', levelShown(t.tp, 'tp', t.side, R.summarize(t).avgEntry), true) + '<button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-act="cancelEdit">Cancel</button><a class="btn" href="#t-' + esc(t.id) + '" data-act="fixOpen" data-id="' + esc(t.id) + '">Edit full trade</a></form>';
}
function positionsHTML() {
  var acc = currentAccount(), list = openTrades(acc.id), now = appNow();
  if (!list.length) return '<div class="empty">No open positions on ' + esc(acc.name) + '. Use the new trade form to log one.</div>';
  return '<div class="scroll"><table class="pos-table"><thead><tr><th>Position</th><th class="num">Entry</th><th class="num">Now</th><th class="num">P/L</th><th class="num">If stopped</th><th class="num">Fees</th><th class="num">Stop / target</th><th class="num">Actions</th></tr></thead><tbody>' +
    list.map(function (t) {
      var s = R.summarize(t), p = Sim.prices[t.symbol], pl = R.pnlAt(t, p), f = R.positionFlags(t, acc, now);
      var flags = f.flags.filter(function (x) { return x.code !== 'avg_down'; });
      if (noLivePrice(t.symbol)) flags.push({ level: 'warn', text: 'No live price: stop not watched, P/L approximate' });
      var stopped = Number(t.sl) > 0 ? R.pnlAt(t, Number(t.sl)) : null;
      return '<tr><td class="pos-name"><a href="#t-' + esc(t.id) + '" style="color:var(--fg);text-decoration:none"><strong>' + esc(t.symbol) + '</strong></a> <span class="sub">' + esc(t.side) + ' · ' + qty(s.size) + (t.fills.length > 1 ? ' · ' + t.fills.length + ' fills' : '') + ' · ' + fmtDur(f.holdLeftMs) + ' left</span>' +
        (flags.length ? '<div class="inline" style="gap:4px">' + flags.map(function (x) { return '<span class="tag ' + x.level + '">' + esc(x.text) + '</span>'; }).join('') + '</div>' : '') + '</td>' +
        '<td class="num pos-entry">' + px(t.symbol, s.avgEntry) + '</td><td class="num pos-now">' + px(t.symbol, p) + '</td>' +
        '<td class="num pos-pl ' + (pl >= 0 ? 'c-good' : 'c-loss') + '" style="font-weight:600">' + signedMoney(pl) + '</td>' +
        '<td class="num pos-risk">' + (stopped == null ? '<span class="c-danger">No stop</span>' : signedMoney(stopped)) + '</td>' +
        '<td class="num pos-fees">' + money(t.fees || 0, 2) + '</td>' +
        '<td class="num mono pos-levels">' + (t.sl == null ? '<span class="c-danger">No SL</span>' : px(t.symbol, t.sl)) + ' / ' + (t.tp == null ? '<span class="c-warn">No TP</span>' : px(t.symbol, t.tp)) + '</td>' +
        '<td class="pos-act"><div class="inline" style="flex-wrap:nowrap;justify-content:flex-end;gap:4px"><button class="btn small" data-act="sym" data-sym="' + esc(t.symbol) + '">Chart</button><button class="btn small" data-act="addTo" data-id="' + esc(t.id) + '">Add</button><button class="btn small" data-act="editSL" data-id="' + esc(t.id) + '">SL/TP</button><button class="btn small danger" data-act="askClose" data-id="' + esc(t.id) + '">Close</button></div></td></tr>';
    }).join('') + '</tbody></table></div>';
}
/* ---------- trade ticket ---------- */
function ticketHTML() {
  var acc = currentAccount();
  if (acc.status !== 'active') return '<div class="panel-h"><h2 id="tkH" style="font-size:15px">New trade</h2></div><div class="empty">' + esc(acc.name) + ' is ' + esc(acc.status) + '.</div>';
  var opens = openTrades(acc.id);
  var socials = Store.data.socials.filter(function (s) { return s.active !== false; });
  var add = ui.ticketMode === 'add';
  var target = add ? (opens.find(function (x) { return x.id === ui.addTarget; }) || opens[0]) : null;
  if (add && target) ui.addTarget = target.id;
  var lastLoss = tradesOf(acc.id).filter(function (t) { return t.status === 'closed' && R.realized(t) < 0; }).sort(function (a, b) { return b.exit.t - a.exit.t; })[0];
  var since = lastLoss ? appNow() - lastLoss.exit.t : null;
  var cool = since != null && since >= 0 && since < 30 * MIN ? '<div class="banner info small"><span>Your last trade closed at a loss ' + Math.max(1, Math.round(since / MIN)) + ' min ago. A short pause before the next one helps you trade your plan, not the loss.</span></div>' : '';
  var h = '<div class="panel-h"><h2 id="tkH" style="font-size:15px">' + (add ? 'Add to a position' : 'New trade') + '</h2><span class="grow"></span><div class="seg" role="group" aria-label="Ticket mode"><button type="button" data-act="tkMode" data-mode="new" aria-pressed="' + !add + '">New</button><button type="button" data-act="tkMode" data-mode="add" aria-pressed="' + add + '">Add</button></div></div><form class="panel-b" id="ticket" novalidate>' + cool;
  if (add) {
    if (!opens.length) return h + '<p class="muted" style="margin:0">No open positions on ' + esc(acc.name) + ' to add to.</p></form>';
    h += '<label class="f" for="tkTarget">Position<select id="tkTarget" data-fresh="1">' + opens.map(function (t) { var s = R.summarize(t); return '<option value="' + esc(t.id) + '"' + (t.id === ui.addTarget ? ' selected' : '') + '>' + esc(t.symbol + ' ' + t.side + ' · ' + qty(s.size) + ' @ avg ' + px(t.symbol, s.avgEntry)) + '</option>'; }).join('') + '</select></label>';
  } else {
    h += '<div class="side-toggle" role="group" aria-label="Side"><button type="button" data-act="tkSide" data-side="Long" aria-pressed="' + (ui.side === 'Long') + '">Long</button><button type="button" data-act="tkSide" data-side="Short" aria-pressed="' + (ui.side === 'Short') + '">Short</button></div>';
  }
  var unit = add && target ? R.assetInfo(target.symbol).unit : R.assetInfo(ui.sym).unit;
  var ot = ui.orderType || 'Market', tsym = add && target ? target.symbol : ui.sym, tside = add && target ? target.side : ui.side;
  h += '<div class="tk-grid">' + (add ? '' : '<label class="f" for="tkSym">Pair<select id="tkSym" data-fresh="1">' + pairOptions(ui.sym) + '</select></label>') +
    '<label class="f' + (add ? ' tk-wide' : '') + '" for="tkOrder">Order type<select id="tkOrder" data-fresh="1">' + ['Market', 'Limit', 'Manual'].map(function (x) { return '<option' + (ot === x ? ' selected' : '') + '>' + x + '</option>'; }).join('') + '</select></label>' +
    (ot === 'Market' ? '<div class="small muted tk-wide">Records a fill now at <span class="num" id="tkMkt">' + px(tsym, Sim.prices[tsym]) + '</span></div>' :
      '<label class="f tk-wide" for="tkPrice">' + (ot === 'Limit' ? 'Limit price' : 'Your fill price') + '<input id="tkPrice" type="number" step="any" placeholder="' + px(tsym, Sim.prices[tsym]).replace(/,/g, '') + '"></label>') +
    (ot === 'Limit' ? '<div class="small muted tk-wide">A ' + tside.toLowerCase() + ' limit fills when price ' + (tside === 'Long' ? 'falls to' : 'rises to') + ' your price. If it\u2019s already there, it fills now at market.</div>' : ot === 'Manual' ? '<div class="small muted tk-wide">Logs a trade you already took, at the price you enter. It\u2019s marked unverified until matched to a Bitfunded fill.</div>' : '') +
    '<div class="tk-wide">' + levelModeHTML() + '</div>' +
    levelFieldHTML('tkSL', 'sl', add ? 'Move stop to (optional)' : 'Stop loss') + (add ? '' : levelFieldHTML('tkTP', 'tp', 'Take profit')) +
    (add ? '' : '<label class="f" for="tkRisk">Risk ($)<input id="tkRisk" type="number" step="any" min="0" placeholder="Sets the size"></label>') +
    '<label class="f" for="tkSize">Size (' + esc(unit) + ')<input id="tkSize" type="number" step="any" min="0" placeholder="0.00"></label>' +
    (ot === 'Manual' && !add ? '<label class="f tk-wide" for="tkFee">Fees so far ($)<input id="tkFee" type="number" step="any" min="0" placeholder="Estimate"></label>' : '') + '</div>' +
    '<div class="f"><span id="levLbl">Leverage for this fill</span><div class="chips" role="group" aria-labelledby="levLbl">' + LEVERAGES.map(function (l) { return '<button type="button" class="chip' + (l > R.rulesFor(acc).maxLeverage ? ' over' : '') + '" data-act="tkLev" data-lev="' + l + '" aria-pressed="' + (ui.lev === l) + '">' + l + 'x</button>'; }).join('') + '</div></div>';
  h += '<div id="tkPreview" class="stack"></div><div id="tkCoach"></div>' +
    '<button class="btn primary tk-submit" type="submit" id="tkSubmit">' + (ot === 'Manual' ? (add ? 'Log the add' : 'Log ' + ui.side.toLowerCase()) : ot === 'Limit' ? (add ? 'Set limit add' : 'Set limit ' + ui.side.toLowerCase()) : (add ? 'Log add at market' : 'Log ' + ui.side.toLowerCase() + ' at market')) + '</button>';
  h += '<button type="button" class="tk-more-btn" data-act="tkMore" aria-expanded="' + !!ui.tkMore + '" aria-controls="tkMoreBox">' + (ui.tkMore ? 'Hide details' : (add ? 'Ask the coach' : 'Add setup, mood and checklist')) + '</button>' +
    '<div id="tkMoreBox" class="stack"' + (ui.tkMore ? '' : ' hidden') + '>';
  if (!add) {
    h += '<div class="small muted">' + esc(R.CLASS_LABEL[R.assetInfo(ui.sym).cls]) + '</div><div class="inline"><label class="f" for="tkSetup">Setup<select id="tkSetup">' + SETUPS.map(function (s) { return '<option>' + s + '</option>'; }).join('') + '</select></label>' +
      '<label class="f" for="tkIdea">Idea source<select id="tkIdea"><option>Own idea</option>' + socials.map(function (s) { return '<option>' + esc(s.handle) + '</option>'; }).join('') + '</select></label>' +
      '<label class="f" for="tkMood">Mood<select id="tkMood">' + MOODS.map(function (s) { return '<option>' + s + '</option>'; }).join('') + '</select></label></div>' +
      '<label class="f" for="tkReason">Reason for the trade<input id="tkReason" type="text" placeholder="What you see and why now"></label>' +
      '<fieldset style="border:0;padding:0;margin:0"><legend class="label" style="margin-bottom:4px">Pre-trade checklist</legend>' +
      [['ckPlaybook', 'Setup matches a playbook'], ['ckSltp', 'Stop loss and take profit set'], ['ckRisk', 'Risk within my planned %'], ['ckRoom', 'Daily loss room after a full stop-out'], ['ckCool', 'Not within 30 min of a loss']].map(function (c) { return '<label class="check" for="' + c[0] + '"><input type="checkbox" id="' + c[0] + '"> ' + c[1] + '</label>'; }).join('') + '</fieldset>';
  }
  return h + '<button class="btn" type="button" data-act="coach">Ask coach</button></div></form>';
}
/* Risk and size are two ways to say one thing: whichever you typed last sets the other, using the distance to the stop. */
function floorSize(s) { var d = s >= 1000 ? 0 : s >= 10 ? 2 : s >= 1 ? 3 : 6, m = Math.pow(10, d); return Math.floor(s * m) / m; }
function syncRiskSize(src) {
  var rEl = document.getElementById('tkRisk'), sEl = document.getElementById('tkSize');
  if (!rEl || !sEl) return;
  if (src === 'tkRisk') ui.sizeFrom = 'risk';
  if (src === 'tkSize') ui.sizeFrom = 'size';
  var tk = readTicket(), p = ticketPrice(tk), sl = Number(tk.sl), dist = p && p.price > 0 && sl > 0 ? Math.abs(p.price - sl) : 0;
  if (!dist) { if (ui.sizeFrom !== 'risk') rEl.value = ''; return; }
  if (ui.sizeFrom === 'risk') { var rk = Number(rEl.value); if (rk > 0) sEl.value = floorSize(rk / dist); }
  else { var s = Number(sEl.value); rEl.value = s > 0 ? (s * dist).toFixed(2) : ''; }
}
function readTicket() {
  return Object.assign(rawTicket(), { sl: levelPriceOf('tkSL'), tp: levelPriceOf('tkTP') });
}
function rawTicket() {
  var v = function (id) { var el = document.getElementById(id); return el ? el.value : ''; };
  var c = function (id) { var el = document.getElementById(id); return !!(el && el.checked); };
  var add = ui.ticketMode === 'add';
  var target = add ? byId('trades', v('tkTarget') || ui.addTarget) : null;
  return {
    mode: ui.ticketMode, target: target, symbol: add && target ? target.symbol : (v('tkSym') || ui.sym), side: add && target ? target.side : ui.side,
    orderType: ui.orderType || 'Market', limitPrice: v('tkPrice'), feeTotal: v('tkFee'),
    size: v('tkSize'), lev: ui.lev, sl: v('tkSL'), tp: v('tkTP'), setup: v('tkSetup'), ideaSource: v('tkIdea'), mood: v('tkMood'), reason: v('tkReason'),
    checklist: { playbook: c('ckPlaybook'), sltp: c('ckSltp'), risk: c('ckRisk'), room: c('ckRoom'), cooldown: c('ckCool') }, t: appNow()
  };
}
/* The price the order would fill at, and whether it fills now. */
function ticketPrice(tk) {
  var mkt = Sim.prices[tk.symbol];
  if (tk.orderType === 'Market') return { price: mkt, now: true, how: 'Market' };
  var p = Number(tk.limitPrice);
  if (!(p > 0)) return null;
  if (tk.orderType === 'Manual') return { price: p, now: true, how: 'Manual', offPct: (p - mkt) / mkt * 100 };
  var marketable = tk.side === 'Long' ? mkt <= p : mkt >= p;
  return marketable ? { price: mkt, now: true, how: 'Market', marketable: true } : { price: p, now: false, how: 'Limit' };
}
function ticketPreview(acc, tk) {
  if (!tk.size || Number(tk.size) <= 0) return null;
  var tp = ticketPrice(tk); if (!tp) return null;
  var m = metricsFor(acc);
  var pre = R.preTrade(acc, m, { t: tk.t, side: tk.side, price: tp.price, size: tk.size, lev: tk.lev, sl: tk.sl, tp: tk.tp }, tk.mode === 'add' ? tk.target : null);
  pre.fill = tp;
  if (tp.now && !pre.invalid) {
    var numLevel = function (v) { return v === '' || v == null ? null : Number(v); };
    var past = levelProblem(tk.side, numLevel(tk.sl), numLevel(tk.tp), noLivePrice(tk.symbol) ? null : Sim.prices[tk.symbol]);
    if (past) { pre.checks.unshift({ ok: false, level: 'breach', text: past }); pre.blocked = true; pre.invalid = true; }
  }
  /* A Manual entry records a fill you already have, so a rule problem warns rather than hides a real position. */
  if (tp.how === 'Manual' && pre.blocked && !pre.invalid) { pre.blocked = false; pre.logOnly = true; }
  return pre;
}
function renderTicketPreview() {
  var box = document.getElementById('tkPreview'); if (!box) return;
  var acc = currentAccount(), tk = readTicket(), pre = ticketPreview(acc, tk);
  var btn = document.getElementById('tkSubmit');
  var mk = document.getElementById('tkMkt'); if (mk) mk.textContent = px(tk.symbol, Sim.prices[tk.symbol]);
  if (!pre) { setHTML('tkPreview', '<p class="small muted" style="margin:0">' + (tk.orderType !== 'Market' && !(Number(tk.limitPrice) > 0) ? 'Enter ' + (tk.orderType === 'Limit' ? 'a limit price' : 'your fill price') + ' and a size to see the rule checks.' : 'Enter a size or your risk to see the rule checks.') + '</p>'); if (btn) btn.disabled = true; return; }
  var a = pre.after, fp = pre.fill, notional = fp.price * Number(tk.size), cfg = R.rulesFor(acc), m = metricsFor(acc), others = m.openRisks.filter(function (x) { return !tk.target || x.id !== tk.target.id; }).length;
  var note = fp.marketable ? '<div class="banner warn small">Your limit is already past the market, so this fills now at ' + px(tk.symbol, fp.price) + '.</div>' :
    fp.how === 'Limit' ? '<div class="banner info small">Working order at ' + px(tk.symbol, fp.price) + ', ' + Math.abs((fp.price - Sim.prices[tk.symbol]) / Sim.prices[tk.symbol] * 100).toFixed(2) + '% from market. Rules are checked again when it fills.</div>' :
    fp.how === 'Manual' && Math.abs(fp.offPct) > 2 ? '<div class="banner warn small">Your price is ' + Math.abs(fp.offPct).toFixed(1) + '% from the market. Check it matches your Bitfunded fill.</div>' : '';
  var row = function (k, v, cls) { return '<div class="tk-row"><span>' + k + '</span><span' + (cls ? ' class="' + cls + '"' : '') + '>' + v + '</span></div>'; };
  var lvl = function (v, lim) { var l = R.level(v / lim); return l === 'ok' ? '' : 'c-' + l; };
  var reward = !tk.target && Number(tk.sl) > 0 && Number(tk.tp) > 0 && !pre.invalid ? Math.abs(Number(tk.tp) - fp.price) / Math.abs(fp.price - Number(tk.sl)) : null;
  var html = note + '<div class="tk-sum"><strong style="font-weight:600">' + (others ? 'If every stop is hit' : 'If the stop is hit') + '</strong>' +
    (pre.projectedDailyPct == null ? row('Risk to stop', 'No stop', 'c-danger') :
      row('Daily loss', pre.projectedDailyPct.toFixed(2) + '% of ' + cfg.dailyLossPct + '%', lvl(pre.projectedDailyPct, cfg.dailyLossPct)) +
      row('Total loss', pre.projectedTotalPct.toFixed(2) + '% of ' + cfg.maxLossPct + '%', lvl(pre.projectedTotalPct, cfg.maxLossPct)) +
      row(tk.mode === 'add' ? 'Risk to stop after' : 'Risk to stop', money(pre.risk))) +
    (reward == null ? '' : row('Reward to risk', reward.toFixed(1) + ' : 1')) +
    (tk.mode === 'add' ? row('New avg entry', px(tk.symbol, a.avgEntry)) + row('Total size', qty(a.size)) + row('Effective leverage', a.effLeverage.toFixed(1) + 'x', a.effLeverage > cfg.maxLeverage ? 'c-danger' : '') : row('Positions after', (m.openCount + 1) + ' of ' + cfg.maxPositions) + row('Notional', money(notional))) +
    row('Margin for this fill', money(notional / tk.lev)) +
    row('Exposure after', pre.exposureAfterPct.toFixed(0) + '% of ' + cfg.maxExposurePct + '%', lvl(pre.exposureAfterPct, cfg.maxExposurePct)) + '</div>' +
    '<ul class="checks">' + pre.checks.filter(function (c) { return !c.ok; }).map(function (c) { return '<li class="' + c.level + '">' + esc(c.text) + '</li>'; }).join('') + '</ul>' +
    (noLivePrice(tk.symbol) ? '<div class="banner warn small"><strong>No live price for this pair.</strong> The cockpit won\u2019t fill limit orders or watch stops here. Close it yourself when Bitfunded does.</div>' : '') +
    (pre.logOnly ? '<div class="banner breach small"><strong>Past a Bitfunded rule.</strong> You can still log this because it\u2019s a fill you already have. Check your position on Bitfunded.</div>' : '') +
    (pre.blocked ? '<div class="banner breach small"><strong>Paused.</strong> ' + (pre.invalid ? 'Fix the stop or target above to continue.' : 'This trade would go past a Bitfunded rule, so the cockpit won\u2019t log it.') + '</div>' : '');
  setHTML('tkPreview', html);
  if (btn) btn.disabled = pre.blocked;
}
function renderTicketCoach() {
  var el = document.getElementById('tkCoach'); if (!el) return;
  el.innerHTML = ui.coach ? '<div class="banner info small" style="white-space:pre-wrap"><strong>Coach:</strong> <span>' + esc(ui.coach.text) + '</span></div>' : '';
}

/* ---------- chart (Lightweight Charts) ---------- */
var Chart = { chart: null, series: null, lines: [], sym: null, ro: null, tf: '1m', bars: [], prim: null, draft: null, drag: null };
function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
function mountChart() {
  var el = document.getElementById('chart'); if (!el) return;
  if (!window.LightweightCharts) { el.innerHTML = '<div class="chart-fallback muted">The chart library didn’t load. Prices, alerts and the rules engine still work.</div>'; return; }
  destroyChart();
  var c = LightweightCharts.createChart(el, {
    autoSize: true, layout: { background: { color: 'transparent' }, textColor: cssVar('--muted'), fontFamily: 'IBM Plex Mono, monospace' },
    grid: { vertLines: { color: cssVar('--line') }, horzLines: { color: cssVar('--line') } },
    rightPriceScale: { borderColor: cssVar('--line') }, timeScale: { borderColor: cssVar('--line'), timeVisible: ui.tf !== '1d', secondsVisible: false },
    localization: { timeFormatter: function (t) { return chartTimeLabel(t * 1000); } }
  });
  var s = c.addCandlestickSeries({ autoscaleInfoProvider: chartAutoscale, upColor: cssVar('--candle-up'), downColor: cssVar('--candle-down'), wickUpColor: cssVar('--candle-up'), wickDownColor: cssVar('--candle-down-edge'), borderVisible: true, borderUpColor: cssVar('--candle-up'), borderDownColor: cssVar('--candle-down-edge'), priceFormat: { type: 'price', precision: dec(ui.sym), minMove: Math.pow(10, -dec(ui.sym)) } });
  Chart.tf = ui.tf; Chart.sym = ui.sym; Chart.bars = chartBars(ui.sym, ui.tf);
  s.setData(barsForChart(Chart.bars));
  Chart.chart = c; Chart.series = s;
  drawLines();
  attachDrawings(s);
  c.timeScale().scrollToRealTime();
  syncDrawUI();
}
function destroyChart() { if (Chart.chart) { try { Chart.chart.remove(); } catch (e) { /* gone */ } } Chart.chart = null; Chart.series = null; Chart.lines = []; Chart.prim = null; Chart.draft = null; Chart.drag = null; }
function drawLines() {
  if (!Chart.series) return;
  Chart.lines.forEach(function (l) { try { Chart.series.removePriceLine(l); } catch (e) { /* gone */ } });
  Chart.lines = [];
  var acc = currentAccount(), sym = Chart.sym;
  var add = function (price, color, title, style) { Chart.lines.push(Chart.series.createPriceLine({ price: Number(price), color: color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title: title })); };
  openTrades(acc.id).filter(function (t) { return t.symbol === sym; }).forEach(function (t) {
    add(R.summarize(t).avgEntry, cssVar('--accent'), t.side + ' avg', 0);
    if (t.sl != null) add(t.sl, cssVar('--danger'), 'SL', 2);
    if (t.tp != null) add(t.tp, cssVar('--good'), 'TP', 2);
  });
  Store.data.levels.filter(function (l) { return l.active && l.symbol === sym; }).forEach(function (l) { add(l.price, cssVar('--warn'), 'Alert', 1); });
  workingOrders(acc.id).filter(function (o) { return o.symbol === sym; }).forEach(function (o) { add(o.price, cssVar('--accent'), 'Limit ' + o.side.toLowerCase(), 3); });
}
var linesSig = '';
function updateChartPrice() {
  if (!Chart.series || Chart.sym !== ui.sym) return;
  var arr = Sim.candles[ui.sym], last = arr[arr.length - 1];
  if (Chart.tf !== '1m') last = mergeLiveBar(Chart.bars, last, tfInfo(Chart.tf).sec);
  try { Chart.series.update({ time: last.time, open: last.open, high: last.high, low: last.low, close: last.close }); } catch (e) { mountChart(); }
  var sig = JSON.stringify([currentAccount().id, openTrades(currentAccount().id).map(function (t) { return [t.id, t.sl, t.tp, t.fills.length]; }), Store.data.levels.filter(function (l) { return l.active; }).map(function (l) { return l.id; }), workingOrders().map(function (o) { return o.id; })]);
  if (sig !== linesSig) { linesSig = sig; drawLines(); }
}

/* ---------- stop and target: by value or by % from entry ---------- */
function levelSign(kind, side) { return (kind === 'sl') === (side === 'Long') ? -1 : 1; }
function pctToPrice(pct, kind, side, entry) { return Number((entry * (1 + levelSign(kind, side) * pct / 100)).toPrecision(10)); }
function priceToPct(price, kind, side, entry) { return Number(((price / entry - 1) * 100 * levelSign(kind, side)).toFixed(3)); }
function levelModeHTML() {
  return '<div class="f" style="flex:0 0 auto"><span id="lvlModeLbl">Set SL and TP by</span><div class="seg" role="group" aria-labelledby="lvlModeLbl">' + [['price', 'Value'], ['pct', '%']].map(function (m) { return '<button type="button" data-act="levelMode" data-v="' + m[0] + '" aria-pressed="' + (ui.levelMode === m[0]) + '">' + m[1] + '</button>'; }).join('') + '</div></div>';
}
function levelFieldHTML(id, kind, label, shown, fresh) {
  return '<label class="f" for="' + id + '">' + label + (ui.levelMode === 'pct' ? ' (% from entry)' : '') + '<input id="' + id + '" type="number" step="any" data-level="' + kind + '"' + (ui.levelMode === 'pct' ? ' min="0"' : '') + (shown == null ? '' : ' value="' + esc(shown) + '"') + (fresh ? ' data-fresh="1"' : '') + '><span class="small muted lvl-hint"></span></label>';
}
function levelShown(price, kind, side, entry) { return price == null || price === '' ? '' : ui.levelMode === 'pct' ? priceToPct(price, kind, side, entry) : price; }
function levelCtx(el) {
  var f = el.closest('form'); if (!f) return null;
  if (f.id === 'ticket') { var tk = rawTicket(), p = ticketPrice(tk); return { symbol: tk.symbol, side: tk.side, entry: p ? p.price : null, size: Number(tk.size) || 0 }; }
  var t = byId('trades', f.dataset.id); if (!t) return null;
  if (f.id === 'fixForm') {
    var size = 0, cost = 0;
    t.fills.forEach(function (x, i) { var fp = Number(document.getElementById('fixP' + i).value), fs = Number(document.getElementById('fixS' + i).value); if (fp > 0 && fs > 0) { size += fs; cost += fp * fs; } });
    return { symbol: document.getElementById('fixSym').value, side: document.getElementById('fixSide').value, entry: size ? cost / size : null, size: size };
  }
  var s = R.summarize(t);
  return { symbol: t.symbol, side: t.side, entry: s.avgEntry, size: s.size };
}
/* What the box means as a price. A percentage needs an entry to measure from. */
function levelPrice(el) {
  var raw = el.value;
  if (raw === '' || ui.levelMode !== 'pct') return raw;
  var n = Number(raw), c = levelCtx(el);
  return n > 0 && c && c.entry ? pctToPrice(n, el.dataset.level, c.side, c.entry) : '';
}
function levelPriceOf(id) { var el = document.getElementById(id); return el ? levelPrice(el) : ''; }
function updateLevelHints() {
  document.querySelectorAll('input[data-level]').forEach(function (el) {
    var hint = el.parentNode.querySelector('.lvl-hint'); if (!hint) return;
    var text = '';
    if (el.value !== '') {
      var c = levelCtx(el), price = Number(levelPrice(el));
      if (!c || !c.entry) text = 'Enter the entry price first';
      else if (price > 0) {
        var value = (c.side === 'Long' ? 1 : -1) * (price - c.entry) * c.size, move = (price / c.entry - 1) * 100;
        text = (ui.levelMode === 'pct' ? '= ' + px(c.symbol, price) : (move >= 0 ? '+' : '−') + Math.abs(move).toFixed(2) + '%') + (c.size ? ' · ' + (value >= 0 ? '+' : '−') + money(Math.abs(value), 2) + ' if hit' : '');
      }
    }
    if (hint.textContent !== text) hint.textContent = text;
  });
}
/* The safety loop closes a position when price is through its stop or target, so a level on the wrong side would close it straight away. */
function noLivePrice(sym) { return Store.mode === 'server' && !!Feed.snap && Feed.snap.source !== 'simulated' && (Sim.src || {})[sym] === 'sim'; }
function levelProblem(side, sl, tp, mkt) {
  if (sl != null && !(sl > 0)) return 'A stop loss should be a price above zero.';
  if (tp != null && !(tp > 0)) return 'A take profit should be a price above zero.';
  if (!(mkt > 0)) return null;
  var long = side === 'Long';
  if (sl != null && (long ? sl >= mkt : sl <= mkt)) return 'That stop is ' + (long ? 'at or above' : 'at or below') + ' the current price, so this trade would close straight away.';
  if (tp != null && (long ? tp <= mkt : tp >= mkt)) return 'That target is ' + (long ? 'at or below' : 'at or above') + ' the current price, so this trade would close straight away.';
  return null;
}
function chartAutoscale(original) {
  var r = original();
  if (!r || !r.priceRange || !Chart.sym || !Store.ready) return r;
  var acc = currentAccount(); if (!acc) return r;
  openTrades(acc.id).filter(function (t) { return t.symbol === Chart.sym; }).forEach(function (t) {
    [R.summarize(t).avgEntry, t.sl, t.tp].forEach(function (p) {
      if (p == null || !(Number(p) > 0)) return;
      r.priceRange.minValue = Math.min(r.priceRange.minValue, Number(p));
      r.priceRange.maxValue = Math.max(r.priceRange.maxValue, Number(p));
    });
  });
  return r;
}
function focusOpenPosition() {
  var acc = currentAccount(); if (!acc) return;
  var list = openTrades(acc.id);
  if (list.length && !list.some(function (t) { return t.symbol === ui.sym; })) ui.sym = list[0].symbol;
}
function exportQuery() { return 'type=' + encodeURIComponent(ui.journalType) + '&account=' + encodeURIComponent(ui.journalAcct) + '&status=' + encodeURIComponent(ui.journalStatus); }

/* ---------- chart timeframes ---------- */
var TIMEFRAMES = [{ id: '1m', label: '1m', sec: 60, name: '1-minute' }, { id: '5m', label: '5m', sec: 300, name: '5-minute' }, { id: '15m', label: '15m', sec: 900, name: '15-minute' }, { id: '1h', label: '1h', sec: 3600, name: '1-hour' }, { id: '4h', label: '4h', sec: 14400, name: '4-hour' }, { id: '1d', label: '1D', sec: 86400, name: 'Daily' }];
var TFData = {};
function tfInfo(tf) { return TIMEFRAMES.filter(function (x) { return x.id === tf; })[0] || TIMEFRAMES[0]; }
function aggregateBars(bars, sec) {
  var out = [];
  bars.forEach(function (b) {
    var t = Math.floor(b.time / sec) * sec, l = out[out.length - 1];
    if (l && l.time === t) { l.high = Math.max(l.high, b.high); l.low = Math.min(l.low, b.low); l.close = b.close; }
    else out.push({ time: t, open: b.open, high: b.high, low: b.low, close: b.close });
  });
  return out;
}
function mergeLiveBar(bars, m1, sec) {
  var t = Math.floor(m1.time / sec) * sec, tail = bars[bars.length - 1];
  if (!tail || t > tail.time) { tail = { time: t, open: m1.open, high: m1.high, low: m1.low, close: m1.close }; bars.push(tail); return tail; }
  if (t === tail.time) { tail.high = Math.max(tail.high, m1.close); tail.low = Math.min(tail.low, m1.close); tail.close = m1.close; }
  return tail;
}
function barsForChart(bars) { return bars.map(function (x) { return { time: x.time, open: x.open, high: x.high, low: x.low, close: x.close }; }); }
function chartBars(sym, tf) {
  if (tf === '1m') return ensureCandles(sym);
  var sec = tfInfo(tf).sec;
  if (Store.mode !== 'server') return aggregateBars(ensureCandles(sym), sec);
  var key = sym + '|' + tf, c = TFData[key];
  if (!c) c = TFData[key] = { bars: aggregateBars(ensureCandles(sym), sec), at: 0, built: false, loading: false };
  if (!c.loading && Date.now() - c.at > 60000) fetchTfBars(sym, tf, c);
  return c.bars;
}
function fetchTfBars(sym, tf, c) {
  c.loading = true;
  var first = !c.at;
  fetch('api/candles?sym=' + encodeURIComponent(sym) + '&tf=' + tf).then(function (r) { return r.json(); }).then(function (d) {
    c.loading = false;
    if (!d || !Array.isArray(d.candles) || !d.candles.length) return;
    c.bars = barsForChart(d.candles); c.at = Date.now(); c.built = d.history === 'built';
    if (Chart.sym !== sym || Chart.tf !== tf || !Chart.series) return;
    Chart.bars = c.bars;
    Chart.series.setData(barsForChart(c.bars));
    if (first) Chart.chart.timeScale().scrollToRealTime();
    setHTML('dbTfNote', c.built ? ' (short history: this pair has no exchange candles here)' : '', true);
    redrawDrawings();
  }).catch(function () { c.loading = false; });
}
function chartTimeLabel(ms) {
  if (ui.tf === '1d') return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(ms));
  return dateShort(ms);
}

/* ---------- chart drawing tools ---------- */
var DRAW_TOOLS = [
  { id: 'hline', label: 'Level', name: 'Horizontal line', hint: 'Click the chart to place the line.' },
  { id: 'trend', label: 'Trend', name: 'Trend line', hint: 'Click two points on the chart.' },
  { id: 'rect', label: 'Box', name: 'Rectangle', hint: 'Click two opposite corners on the chart.' },
  { id: 'fib', label: 'Fib', name: 'Fibonacci retracement', hint: 'Click two points on the chart, start to end of the move.' }
];
var FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
function fibLevels(p1, p2) { return FIB_LEVELS.map(function (l) { return { level: l, price: p2 + (p1 - p2) * l }; }); }
function symbolDrawings(sym) { return (Store.data.drawings || []).filter(function (x) { return x.symbol === sym; }); }
/* Positions are worked out from each drawing's time, so it stays put on every timeframe, even outside the candles loaded. */
function timeToIdx(bars, t, sec) {
  var n = bars.length; if (!n) return null;
  if (t <= bars[0].time) return (t - bars[0].time) / sec;
  if (t >= bars[n - 1].time) return n - 1 + (t - bars[n - 1].time) / sec;
  var lo = 0, hi = n - 1;
  while (hi - lo > 1) { var m = (lo + hi) >> 1; if (bars[m].time <= t) lo = m; else hi = m; }
  return lo + (t - bars[lo].time) / (bars[hi].time - bars[lo].time);
}
function idxToTime(bars, idx, sec) {
  var n = bars.length; if (!n) return null;
  if (idx <= 0) return bars[0].time + idx * sec;
  if (idx >= n - 1) return bars[n - 1].time + (idx - (n - 1)) * sec;
  var i = Math.floor(idx);
  return bars[i].time + (idx - i) * (bars[i + 1].time - bars[i].time);
}
function chartToolsHTML() {
  return '<div class="seg" role="group" aria-label="Timeframe">' + TIMEFRAMES.map(function (x) { return '<button type="button" data-act="tf" data-tf="' + x.id + '" aria-label="' + x.name + ' candles" aria-pressed="' + (ui.tf === x.id) + '">' + x.label + '</button>'; }).join('') + '</div>' +
    '<div class="seg tool-btns" role="group" aria-label="Drawing tools">' + DRAW_TOOLS.map(function (x) { return '<button type="button" data-act="drawTool" data-tool="' + x.id + '" title="' + x.name + '" aria-label="' + x.name + '" aria-pressed="' + (ui.drawTool === x.id) + '">' + (TOOL_ICONS[x.id] || x.label) + '</button>'; }).join('') + '</div>';
}
var TOOL_ICONS = {
  hline: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 12h18"></path></svg>',
  trend: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 19L20 5"></path></svg>',
  rect: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="4" y="6" width="16" height="12" rx="1"></rect></svg>',
  fib: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 5h16M4 10h16M4 15h16M4 20h16"></path></svg>'
};
function chartHintHTML() {
  var tool = DRAW_TOOLS.filter(function (x) { return x.id === ui.drawTool; })[0];
  var count = symbolDrawings(ui.sym).length, picked = ui.drawSel && byId('drawings', ui.drawSel);
  var clear = ui.confirm && ui.confirm.kind === 'drawClear';
  return (tool ? '<span class="small muted">' + tool.hint + ' Press it again to cancel.</span>' : '') +
    (picked ? '<button type="button" class="btn small" data-act="drawDelete">Delete drawing</button>' : '') +
    (clear ? '<span class="small">Remove all ' + count + ' drawing' + (count === 1 ? '' : 's') + ' on ' + esc(ui.sym) + '?</span><button type="button" class="btn small" data-act="doDrawClear">Remove</button><button type="button" class="btn small" data-act="cancelDrawClear">Keep</button>'
      : count ? '<button type="button" class="btn small" data-act="askDrawClear">Clear drawings (' + count + ')</button>' : '');
}
function syncDrawUI() {
  if (ui.drawSel && !byId('drawings', ui.drawSel)) ui.drawSel = null;
  setHTML('dbChartTools', chartToolsHTML(), true);
  setHTML('dbChartHint', chartHintHTML(), true);
  var el = document.getElementById('chart');
  if (el) { el.classList.toggle('armed', !!ui.drawTool); el.classList.toggle('picked', !!ui.drawSel); }
  lockChart(!!ui.drawTool || !!Chart.drag);
  redrawDrawings();
}
function lockChart(on) { if (Chart.chart) Chart.chart.applyOptions({ handleScroll: !on, handleScale: !on }); }
function redrawDrawings() { if (Chart.prim && Chart.prim.req) Chart.prim.req(); }
function attachDrawings(series) {
  if (!series.attachPrimitive) return;
  var renderer = { draw: function (target) { target.useMediaCoordinateSpace(function (s) { paintDrawings(s.context, s.mediaSize); }); } };
  var view = { zOrder: function () { return 'top'; }, renderer: function () { return renderer; } };
  var prim = { attached: function (p) { prim.req = p.requestUpdate; }, detached: function () { prim.req = null; }, updateAllViews: function () {}, paneViews: function () { return [view]; } };
  Chart.prim = prim;
  series.attachPrimitive(prim);
}
/* The chart only places whole candle positions, so a time between candles is placed between them here. */
function idxToX(ts, idx) {
  var i = Math.floor(idx), a = ts.logicalToCoordinate(i);
  if (idx === i || a == null) return a;
  var b = ts.logicalToCoordinate(i + 1);
  return b == null ? null : a + (b - a) * (idx - i);
}
function drawingScreen(x) {
  var sec = tfInfo(Chart.tf).sec, ts = Chart.chart.timeScale();
  return x.points.map(function (q) {
    var idx = timeToIdx(Chart.bars, q.t, sec);
    return { x: idx == null ? null : idxToX(ts, idx), y: Chart.series.priceToCoordinate(q.p) };
  });
}
function paintDrawings(ctx, size) {
  if (!Chart.series || !Chart.chart) return;
  var list = symbolDrawings(Chart.sym).map(function (x) { return Chart.drag && Chart.drag.doc.id === x.id ? Chart.drag.doc : x; });
  if (Chart.draft) list = list.concat([Chart.draft]);
  var fg = cssVar('--fg'), accent = cssVar('--accent'), fmt = Chart.series.priceFormatter();
  ctx.save();
  ctx.font = '11px IBM Plex Mono, monospace';
  ctx.lineWidth = 1.5;
  list.forEach(function (x) {
    var pts = drawingScreen(x), a = pts[0], b = pts[1], picked = x.id === ui.drawSel;
    if (a.y == null || (x.type !== 'hline' && (a.x == null || !b || b.x == null || b.y == null))) return;
    ctx.strokeStyle = picked ? accent : fg;
    ctx.fillStyle = picked ? accent : fg;
    ctx.globalAlpha = 1;
    if (x.type === 'hline') {
      ctx.beginPath(); ctx.moveTo(0, a.y); ctx.lineTo(size.width, a.y); ctx.stroke();
      ctx.fillText(fmt.format(x.points[0].p), 6, a.y - 4);
    } else if (x.type === 'trend') {
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    } else if (x.type === 'rect') {
      ctx.strokeStyle = accent; ctx.fillStyle = accent;
      ctx.globalAlpha = 0.14; ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.globalAlpha = 1; ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    } else if (x.type === 'fib') {
      var left = Math.min(a.x, b.x), right = Math.max(a.x, b.x);
      fibLevels(x.points[0].p, x.points[1].p).forEach(function (f) {
        var y = Chart.series.priceToCoordinate(f.price); if (y == null) return;
        ctx.strokeStyle = accent; ctx.fillStyle = fg;
        ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
        ctx.fillText(f.level + ' · ' + fmt.format(f.price), left + 4, y - 3);
      });
    }
    if (picked) {
      ctx.fillStyle = accent; ctx.strokeStyle = cssVar('--bg');
      pts.forEach(function (q) { var hx = x.type === 'hline' ? size.width / 2 : q.x; if (q.y == null || hx == null) return; ctx.beginPath(); ctx.arc(hx, q.y, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); });
    }
  });
  ctx.restore();
}
function segDist(px, py, a, b) {
  var dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy, t = l ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l)) : 0;
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}
function hitDrawing(px, py, reach) {
  var list = symbolDrawings(Chart.sym);
  for (var n = list.length - 1; n >= 0; n--) {
    var x = list[n], pts = drawingScreen(x), a = pts[0], b = pts[1], picked = x.id === ui.drawSel;
    if (a.y == null || (x.type !== 'hline' && (a.x == null || b.x == null || b.y == null))) continue;
    if (x.type === 'hline') { if (Math.abs(py - a.y) <= reach) return { doc: x, point: picked && Math.abs(px - Chart.chart.timeScale().width() / 2) <= reach ? 0 : -1 }; continue; }
    if (picked) for (var i = 0; i < pts.length; i++) if (Math.hypot(px - pts[i].x, py - pts[i].y) <= reach + 3) return { doc: x, point: i };
    var c = { x: a.x, y: b.y }, d = { x: b.x, y: a.y };
    if (x.type === 'trend' && segDist(px, py, a, b) <= reach) return { doc: x, point: -1 };
    if (x.type === 'rect') {
      if ([[a, c], [c, b], [b, d], [d, a]].some(function (e) { return segDist(px, py, e[0], e[1]) <= reach; })) return { doc: x, point: -1 };
      if (picked && px > Math.min(a.x, b.x) && px < Math.max(a.x, b.x) && py > Math.min(a.y, b.y) && py < Math.max(a.y, b.y)) return { doc: x, point: -1 };
    }
    if (x.type === 'fib') {
      var hit = fibLevels(x.points[0].p, x.points[1].p).some(function (f) { var y = Chart.series.priceToCoordinate(f.price); return y != null && px >= Math.min(a.x, b.x) - reach && px <= Math.max(a.x, b.x) + reach && Math.abs(py - y) <= reach; });
      if (hit) return { doc: x, point: -1 };
    }
  }
  return null;
}
function chartPointer(ev) {
  var el = document.getElementById('chart'); if (!el || !Chart.chart) return null;
  var r = el.getBoundingClientRect(), ts = Chart.chart.timeScale(), x = ev.clientX - r.left, y = ev.clientY - r.top;
  var w = ts.width(), h = el.clientHeight - ts.height();
  return { x: x, y: y, w: w, h: h, inPane: x >= 0 && y >= 0 && x <= w && y <= h };
}
function chartPoint(x, y) {
  var idx = Chart.chart.timeScale().coordinateToLogical(x), p = Chart.series.coordinateToPrice(y);
  if (idx == null || p == null) return null;
  return { t: idxToTime(Chart.bars, idx, tfInfo(Chart.tf).sec), p: p };
}
function finishDraft() {
  var dr = Chart.draft; Chart.draft = null;
  var doc = { id: uid('drw'), symbol: Chart.sym, type: dr.type, points: dr.points, createdAt: appNow() };
  ui.drawTool = null; ui.drawSel = doc.id;
  put('drawings', doc);
  syncDrawUI();
}
function dragDrawing(c) {
  var dr = Chart.drag, sec = tfInfo(Chart.tf).sec;
  if (Math.hypot(c.x - dr.x, c.y - dr.y) > 2) dr.moved = true;
  if (!dr.moved) return;
  if (dr.point >= 0) { var q = chartPoint(Math.max(0, Math.min(c.w, c.x)), Math.max(0, Math.min(c.h, c.y))); if (q) dr.doc.points[dr.point] = q; }
  else {
    var now = Chart.chart.timeScale().coordinateToLogical(c.x); if (now == null) return;
    var di = now - dr.idx, dy = c.y - dr.y;
    dr.doc.points = dr.base.map(function (b) {
      var p = Chart.series.coordinateToPrice(b.y + dy);
      return { t: idxToTime(Chart.bars, b.idx + di, sec), p: p == null ? b.p : p };
    });
  }
  redrawDrawings();
}
document.addEventListener('pointerdown', function (ev) {
  if (!Chart.chart || !ev.target.closest || !ev.target.closest('#chart') || ev.button > 0) return;
  var c = chartPointer(ev); if (!c || !c.inPane) return;
  if (ui.drawTool) {
    var q = chartPoint(c.x, c.y); if (!q) return;
    if (ui.drawTool === 'hline') { Chart.draft = { type: 'hline', points: [q] }; return finishDraft(); }
    if (!Chart.draft) Chart.draft = { type: ui.drawTool, points: [q, { t: q.t, p: q.p }], x: c.x, y: c.y, second: false };
    else { if (Math.hypot(c.x - Chart.draft.x, c.y - Chart.draft.y) <= 6) return; Chart.draft.points[1] = q; return finishDraft(); }
    return redrawDrawings();
  }
  var hit = hitDrawing(c.x, c.y, ev.pointerType === 'touch' ? 14 : 7);
  if (!hit) { if (ui.drawSel) { ui.drawSel = null; syncDrawUI(); } return; }
  ui.drawSel = hit.doc.id;
  var ts = Chart.chart.timeScale(), sec = tfInfo(Chart.tf).sec;
  Chart.drag = {
    doc: clone(hit.doc), point: hit.point, x: c.x, y: c.y, moved: false, idx: ts.coordinateToLogical(c.x),
    base: hit.doc.points.map(function (b) { return { idx: timeToIdx(Chart.bars, b.t, sec), y: Chart.series.priceToCoordinate(b.p), p: b.p }; })
  };
  syncDrawUI();
}, true);
document.addEventListener('pointermove', function (ev) {
  if (!Chart.chart) return;
  var c = chartPointer(ev); if (!c) return;
  if (Chart.drag) return dragDrawing(c);
  if (Chart.draft) { if (c.inPane) { var q = chartPoint(c.x, c.y); if (q) { Chart.draft.points[1] = q; redrawDrawings(); } } return; }
  if (ev.pointerType === 'mouse' && !ui.drawTool) {
    var el = document.getElementById('chart'), over = c.inPane && !!hitDrawing(c.x, c.y, 7);
    if (el) el.classList.toggle('over', over);
  }
}, true);
document.addEventListener('pointerup', function (ev) {
  if (!Chart.chart) return;
  if (Chart.drag) {
    var dr = Chart.drag; Chart.drag = null;
    if (dr.moved) put('drawings', dr.doc);
    return syncDrawUI();
  }
  if (Chart.draft) {
    var c = chartPointer(ev);
    if (c && Math.hypot(c.x - Chart.draft.x, c.y - Chart.draft.y) > 6) finishDraft();
  }
}, true);
document.addEventListener('pointercancel', function () { if (Chart.drag) { Chart.drag = null; syncDrawUI(); } }, true);
document.addEventListener('keydown', function (ev) {
  var tag = ev.target && ev.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (ev.key === 'Escape' && (ui.drawTool || Chart.draft)) { ui.drawTool = null; Chart.draft = null; syncDrawUI(); }
  else if ((ev.key === 'Delete' || ev.key === 'Backspace') && ui.drawSel && route() === 'dashboard') { ev.preventDefault(); actions.drawDelete(); }
});

/* ---------- views: challenges ---------- */
function viewChallenges() {
  var accs = accounts().filter(function (a) { return !a.paper; });
  return '<div class="inline"><h1>Challenges</h1><span class="muted">' + accs.length + ' accounts · ' + accs.filter(function (a) { return a.status === 'active' && typeOf(a) === 'Live'; }).length + ' Live · ' + accs.filter(function (a) { return a.status === 'active' && typeOf(a) === 'Demo'; }).length + ' Demo · ' + accs.filter(function (a) { return a.status === 'failed'; }).length + ' failed</span></div>' +
    '<section class="panel" aria-labelledby="guardH"><div class="panel-h"><h2 id="guardH">Cross-account guard</h2><span class="small muted">Rules that apply across all your real accounts</span></div><div class="panel-b"><div class="grid-auto" id="chGuard">' + guardHTML() + '</div></div></section>' +
    '<section aria-labelledby="cardsH" class="stack"><h2 id="cardsH" class="sr">Accounts</h2><div class="grid-auto" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr))" id="chCards">' + cardsHTML() + '</div></section>' +
    accFormHTML(ui.editAcc ? byId('accounts', ui.editAcc) : null);
}
function dateVal(ms) { if (!ms) return ''; var d = new Date(ms); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function dateMs(v, fallback) { if (!v) return fallback; var t = new Date(v + 'T12:00:00').getTime(); return isNaN(t) ? fallback : t; }
function accFormHTML(a) {
  var e = !!a, v = function (x, d) { return x == null ? (d == null ? '' : d) : x; };
  var sizes = [5000, 10000, 15000, 25000, 50000, 100000, 200000];
  if (e && sizes.indexOf(a.size) < 0) sizes.push(a.size);
  var m = e ? metricsFor(a) : null, day = R.dayBounds(appNow());
  var todayLoss = e && a.priorDayLoss && a.priorDayLoss.day === day.start ? a.priorDayLoss.amount : '';
  var sync = e && a.balanceSync ? 'Last set to ' + money(a.balanceSync.balance, 2) + ' on ' + dateShort(a.balanceSync.at) + '.' : '';
  return '<section class="panel" aria-labelledby="addH" id="accForm"' + (e ? ' style="border-color:var(--accent)"' : '') + '><div class="panel-h"><h2 id="addH">' + (e ? 'Edit ' + esc(a.name) : 'Add a challenge') + '</h2><span class="small muted">One active challenge per level (size + program)</span><span class="grow"></span>' + (e ? '<button class="btn small" type="button" data-act="cancelAccEdit">Cancel</button>' : '') + '</div>' +
    '<form class="panel-b" id="addAcc" data-id="' + (e ? esc(a.id) : '') + '"><div class="inline">' +
    '<label class="f" for="naName">Name<input id="naName" type="text" data-fresh="1" placeholder="#4 · 100K" value="' + esc(e ? a.name : '') + '"></label>' +
    '<label class="f" for="naId">Bitfunded ID<input id="naId" type="text" data-fresh="1" placeholder="BF-…" value="' + esc(e ? a.bitfundedId || '' : '') + '"></label>' +
    '<label class="f" for="naProg">Program<select id="naProg" data-fresh="1">' + Object.keys(R.PROGRAMS).map(function (p) { return '<option' + (e && a.program === p ? ' selected' : '') + '>' + esc(p) + '</option>'; }).join('') + '</select></label>' +
    '<label class="f" for="naSize">Size<select id="naSize" data-fresh="1">' + sizes.map(function (s) { return '<option value="' + s + '"' + (e && a.size === s ? ' selected' : '') + '>' + R.fmtSize(s) + '</option>'; }).join('') + '</select></label>' +
    '<label class="f" for="naStage">Stage<select id="naStage" data-fresh="1">' + ['Stage 1', 'Stage 2', 'Funded'].map(function (s) { return '<option' + (e && a.stage === s ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select></label>' +
    (e ? '<label class="f" for="naStatus">Status<select id="naStatus" data-fresh="1">' + [['active', 'Active'], ['passed', 'Passed'], ['failed', 'Failed']].map(function (s) { return '<option value="' + s[0] + '"' + (a.status === s[0] ? ' selected' : '') + '>' + s[1] + '</option>'; }).join('') + '</select></label>' : '') +
    '</div><div class="inline">' +
    '<label class="f" for="naStart">Challenge started<input id="naStart" type="date" data-fresh="1" value="' + dateVal(e ? a.startedAt : appNow()) + '"></label>' +
    '<label class="f" for="naStageStart">Current stage started<input id="naStageStart" type="date" data-fresh="1" value="' + dateVal(e ? (a.stageStartedAt || a.startedAt) : appNow()) + '"></label>' +
    '<label class="f" for="naFee">Fee paid ($)<input id="naFee" type="number" step="any" min="0" data-fresh="1" value="' + (e ? v(a.fee, '') : '') + '"></label>' +
    '<label class="f" for="naLev">Max leverage (1:x)<input id="naLev" type="number" step="1" min="1" max="100" data-fresh="1" placeholder="Program default" value="' + (e ? v(a.maxLeverage, 5) : '') + '"></label></div>' +
    '<fieldset class="stack" style="border:1px solid var(--line);border-radius:8px;padding:12px;margin:0"><legend class="label" style="padding:0 6px">Already trading on Bitfunded?</legend>' +
    '<p class="small muted" style="margin:0">Copy these from your Bitfunded dashboard so the gauges start from where your account really is. Leave blank for a fresh challenge.' + (sync ? ' ' + esc(sync) : '') + '</p><div class="inline">' +
    '<label class="f" for="naBalance">Balance now ($, closed trades only)<input id="naBalance" type="number" step="any" data-fresh="1" placeholder="e.g. ' + (e ? a.size : 25000) + '"></label>' +
    '<label class="f" for="naDayLoss">Losses already closed today ($)<input id="naDayLoss" type="number" step="any" min="0" data-fresh="1" value="' + esc(todayLoss) + '" placeholder="0"></label>' +
    '<label class="f" for="naQual">Closed trades this stage, held 10+ min<input id="naQual" type="number" step="1" min="0" data-fresh="1" value="' + (e && a.priorQualifying ? a.priorQualifying : '') + '" placeholder="0"></label></div>' +
    (e ? '<p class="small muted" style="margin:0">Trades already in the cockpit for this stage: ' + signedMoney(R.baselineFromBalance(a, Store.data.trades, a.size).tracked) + '. The balance you enter replaces the opening P/L, not these trades. Equity now: ' + money(m.equity, 2) + '.</p>' : '') +
    '</fieldset>' +
    (e ? '' : '<label class="check" for="naPaper"><input type="checkbox" id="naPaper"> Paper account (not on Bitfunded, shadow rules only)</label>') +
    '<div id="naMsg">' + (ui.accMsg ? '<div class="banner breach small">' + esc(ui.accMsg) + '</div>' : '') + '</div>' +
    '<div class="inline"><button class="btn primary" type="submit">' + (e ? 'Save changes' : 'Add challenge') + '</button>' + (e ? '<button class="btn" type="button" data-act="cancelAccEdit">Cancel</button>' : '') + '</div></form></section>';
}
function guardHTML() {
  var g = R.crossAccount(Store.data.accounts, Store.data.trades, appNow());
  var nm = function (id) { return (byId('accounts', id) || {}).name || id; };
  var tile = function (label, value, cls, note) { return '<div class="gauge ' + (cls === 'good' ? '' : cls) + '"><div class="small muted">' + label + '</div><div class="v c-' + cls + '" style="font-size:18px">' + value + '</div><div class="small">' + note + '</div></div>'; };
  return tile('Opposite positions, same asset', g.hedges.length ? g.hedges.length + ' conflict' + (g.hedges.length > 1 ? 's' : '') : 'None', g.hedges.length ? 'breach' : 'good', g.hedges.length ? g.hedges.map(function (h) { return esc(h.symbol + ': ' + nm(h.accounts[0]) + ' vs ' + nm(h.accounts[1])); }).join('<br>') + ' · counts as hedging' : 'Long and short on the same asset across accounts is banned') +
    tile('Open positions, all accounts', g.totalOpen + ' / ' + g.positionCap, g.positionLevel === 'ok' ? 'good' : g.positionLevel, 'Counted across accounts until Bitfunded confirms the cap is per account') +
    tile('Same trade on several accounts', g.coordinated.length ? g.coordinated.length + ' in last 24h' : 'None in last 24h', g.coordinated.length ? 'danger' : 'good', 'Matching entries within 2 minutes look like coordinated trading') +
    tile('One active challenge per level', g.duplicateLevels.length ? 'Duplicate level' : 'OK', g.duplicateLevels.length ? 'breach' : 'good', activeAccounts().filter(function (a) { return !a.paper; }).map(function (a) { return esc(a.program + ' ' + R.fmtSize(a.size)); }).join(', ') || 'No active challenges');
}
function cardsHTML() {
  return accounts().map(function (a) {
    var m = metricsFor(a), st = a.status;
    var worst = m.gauges.slice().sort(function (x, y) { return RANK[y.level] - RANK[x.level]; })[0];
    var status = st !== 'active' ? st.toUpperCase() : worst.level === 'ok' ? 'ON TRACK' : worst.level === 'breach' ? 'LIMIT REACHED' : 'WATCH';
    var cls = st === 'failed' ? 'danger' : st === 'passed' ? 'good' : worst.level === 'ok' ? 'good' : worst.level;
    var bar = function (label, v, lim, lv) { return '<div><div class="inline small" style="justify-content:space-between"><span class="muted">' + label + '</span><span class="num">' + v + '</span></div><div class="bar ' + lv + '"><i style="width:' + Math.min(100, Math.max(0, lim)).toFixed(1) + '%"></i></div></div>'; };
    var g = function (k) { return m.gauges.find(function (x) { return x.key === k; }); };
    var trades = tradesOf(a.id), closed = trades.filter(function (t) { return t.status === 'closed'; });
    var conf = ui.confirm && ui.confirm.id === a.id ? ui.confirm : null;
    var next = a.stage === 'Stage 1' ? 'Stage 2' : a.stage === 'Stage 2' ? 'Funded' : null;
    return '<article class="panel" style="' + (st === 'failed' ? 'opacity:.8' : '') + '"><div class="panel-b">' +
      '<div class="inline"><h3 style="font-size:17px">' + esc(a.name) + '</h3>' + typeTag(a) + '<span class="tag ' + cls + '">' + status + '</span>' + (a.sample ? '<span class="tag">Sample</span>' : '') + '</div>' +
      '<div class="small muted">' + esc(a.program + ' · ' + a.stage + ' · ' + R.fmtSize(a.size) + ' · started ' + dateShort(a.startedAt) + (a.bitfundedId ? ' · ' + a.bitfundedId : '')) + '</div>' +
      bar('Daily loss', pct(g('daily').value) + ' / ' + g('daily').limit + '%', g('daily').ratio * 100, g('daily').level) +
      bar('Total loss', pct(g('total').value) + ' / ' + g('total').limit + '%', g('total').ratio * 100, g('total').level) +
      (m.targetPct != null ? bar('Profit target', pct(m.profitPct) + ' / ' + m.targetPct + '%', Math.max(0, m.profitPct) / m.targetPct * 100, 'good') : bar('Funded P/L', pct(m.profitPct), 0, 'good')) +
      '<div class="grid-auto small" style="grid-template-columns:repeat(4,minmax(0,1fr));border-top:1px solid var(--line);padding-top:10px">' +
      '<div><div class="muted">Open</div><strong>' + m.openCount + ' / 5</strong></div><div><div class="muted">Closed</div><strong>' + closed.length + '</strong></div><div><div class="muted">Net P/L</div><strong class="' + (m.equity - a.size >= 0 ? 'c-good' : 'c-loss') + '">' + signedMoney(m.equity - a.size) + '</strong></div><div><div class="muted">Fee</div><strong>' + money(a.fee || 0) + '</strong></div></div>' +
      (conf ? '<div class="confirm"><span>' + esc(conf.label) + '?</span><button class="btn small primary" data-act="doAccAction" data-id="' + esc(a.id) + '">Confirm</button><button class="btn small" data-act="cancelConfirm">Cancel</button></div>' : '') +
      '<div class="inline"><button class="btn small" data-act="openAcc" data-id="' + esc(a.id) + '">Open dashboard</button><button class="btn small" data-act="editAcc" data-id="' + esc(a.id) + '">Edit</button>' +
      (st === 'active' && next && !a.paper ? '<button class="btn small" data-act="askAcc" data-id="' + esc(a.id) + '" data-op="advance" data-label="Move ' + esc(a.name) + ' to ' + next + '">' + (next === 'Funded' ? 'Mark funded' : 'Passed → ' + next) + '</button>' : '') +
      (st === 'active' && !a.paper ? '<button class="btn small danger" data-act="askAcc" data-id="' + esc(a.id) + '" data-op="fail" data-label="Mark ' + esc(a.name) + ' as failed">Mark failed</button>' : '') +
      (st !== 'active' ? '<button class="btn small" data-act="askAcc" data-id="' + esc(a.id) + '" data-op="reactivate" data-label="Reactivate ' + esc(a.name) + '">Reactivate</button>' : '') + '</div></div></article>';
  }).join('');
}

/* ---------- views: journal ---------- */
function journalRows() {
  return Store.data.trades.filter(function (t) {
    var a = byId('accounts', t.accountId); if (!a) return false;
    if (ui.journalType !== 'All' && typeOf(a) !== ui.journalType) return false;
    if (ui.journalAcct !== 'all' && a.id !== ui.journalAcct) return false;
    if (ui.journalStatus !== 'all' && t.status !== ui.journalStatus) return false;
    return true;
  }).sort(function (a, b) { return b.createdAt - a.createdAt; });
}
function statsFor(type) {
  var ts = Store.data.trades.filter(function (t) { var a = byId('accounts', t.accountId); return a && t.status === 'closed' && typeOf(a) === type; });
  var rs = ts.map(R.rMultiple).filter(function (r) { return r != null; });
  var wins = ts.filter(function (t) { return R.realized(t) > 0; }).length;
  return { n: ts.length, win: ts.length ? wins / ts.length * 100 : null, avgR: rs.length ? rs.reduce(function (a, b) { return a + b; }, 0) / rs.length : null, net: ts.reduce(function (s, t) { return s + R.realized(t); }, 0) };
}
/* Archive & delete: an invalid entry can be archived (hidden from everything, can be restored) or deleted for good. */
function tradeMenuHTML(t, label) {
  return '<label class="sr" for="tm-' + esc(t.id) + '">' + esc(label || 'Archive & delete') + '</label><select class="row-menu" id="tm-' + esc(t.id) + '" data-tmenu="' + esc(t.id) + '"><option value="">Archive & delete</option><option value="archive">Archive</option><option value="delete">Delete for good</option></select>';
}
function tradeConfirmHTML(t) {
  var c = ui.confirm; if (!c || c.id !== t.id || (c.kind !== 'archiveTrade' && c.kind !== 'delTrade')) return '';
  var name = t.symbol + ' ' + t.side + ' (' + dateShort(t.createdAt) + ')';
  if (c.kind === 'archiveTrade') return '<div class="confirm"><span>Archive ' + esc(name) + '? It leaves the journal and stops counting toward your limits, stats and Telegram summaries' + (t.status === 'open' ? ', and the cockpit stops watching its stop and target' : '') + '. You can restore it from <strong>Archived</strong>.</span><button class="btn small primary" data-act="doArchive" data-id="' + esc(t.id) + '">Archive</button><button class="btn small" data-act="cancelConfirm">Cancel</button></div>';
  return '<div class="confirm"><span>Delete ' + esc(name) + ' for good? This can’t be undone' + (t.shots && ((t.shots.before || []).length || (t.shots.after || []).length) ? ', and its screenshots are deleted too' : '') + '. If you might want it back, archive it instead.' + (t.status === 'open' ? ' The cockpit stops watching its stop and target.' : '') + '</span><button class="btn small danger" data-act="doDelTrade" data-id="' + esc(t.id) + '">Delete for good</button><button class="btn small" data-act="cancelConfirm">Keep</button></div>';
}
function archivedHTML() {
  var list = Store.data.archive.filter(function (d) { return d.trade; }).filter(function (d) { var a = byId('accounts', d.trade.accountId); if (ui.journalAcct !== 'all' && d.trade.accountId !== ui.journalAcct) return false; return ui.journalType === 'All' || (a && typeOf(a) === ui.journalType); }).sort(function (a, b) { return (b.archivedAt || 0) - (a.archivedAt || 0); });
  if (!list.length) return '<div class="empty">No archived trades. Archived trades don’t count toward limits, stats or alerts.</div>';
  return '<p class="small muted" style="margin:0 16px 8px">These don’t count toward your limits, stats or alerts. Restore one to put it back in the journal.</p><div class="scroll"><table><thead><tr><th>Trade</th><th>Account</th><th class="num">P/L</th><th>Archived</th><th><span class="sr">Actions</span></th></tr></thead><tbody>' + list.map(function (d) {
    var t = d.trade, a = byId('accounts', t.accountId), c = ui.confirm && ui.confirm.kind === 'delArchived' && ui.confirm.id === d.id;
    return '<tr><td><strong>' + esc(t.symbol) + '</strong> ' + esc(t.side) + '<div class="small muted">' + esc(dateShort(t.createdAt)) + (t.status === 'open' ? ' · was open' : '') + '</div></td><td>' + esc(a ? a.name : 'Account removed') + '</td><td class="num">' + (t.exit ? signedMoney(R.realized(t)) : '—') + '</td><td>' + esc(dateShort(d.archivedAt)) + '</td>' +
      '<td><div class="inline" style="flex-wrap:nowrap">' + (c ? '<span class="small">Delete for good? This can’t be undone.</span><button class="btn small danger" data-act="doDelArchived" data-id="' + esc(d.id) + '">Delete for good</button><button class="btn small" data-act="cancelConfirm">Keep</button>'
        : '<button class="btn small" data-act="doUnarchive" data-id="' + esc(d.id) + '">Restore</button><button class="btn small" data-act="askDelArchived" data-id="' + esc(d.id) + '">Delete for good</button>') + '</div></td></tr>';
  }).join('') + '</tbody></table></div>';
}
function archiveTrade(id) {
  var t = byId('trades', id); if (!t) return Promise.resolve();
  var doc = { id: id, trade: clone(t), archivedAt: appNow() };
  if (ui.fixId === id) ui.fixId = null;
  if (Store.mode === 'server') {
    Store.data.trades = Store.data.trades.filter(function (x) { return x.id !== id; }); Store.data.archive.push(doc); scheduleRender();
    return serverCall('POST', 'api/trades/' + encodeURIComponent(id) + '/archive', {});
  }
  return Promise.resolve(put('archive', doc)).then(function () { return remove('trades', id); });
}
function unarchiveTrade(id) {
  var d = byId('archive', id); if (!d || !d.trade) return Promise.resolve();
  if (byId('trades', id)) { toast('A trade with this id is already in the journal.', 'warn'); return Promise.resolve(); }
  var t = clone(d.trade); t.id = id;
  if (Store.mode === 'server') {
    Store.data.archive = Store.data.archive.filter(function (x) { return x.id !== id; }); Store.data.trades.push(t); scheduleRender();
    return serverCall('POST', 'api/archive/' + encodeURIComponent(id) + '/restore', {});
  }
  return Promise.resolve(put('trades', t)).then(function () { return remove('archive', id); });
}
function viewJournal() {
  var rows = journalRows(), arch = ui.journalStatus === 'archived';
  var stat = function (type) { var s = statsFor(type); return '<div class="gauge"><div class="inline small" style="justify-content:space-between"><span class="tag ' + type.toLowerCase() + '">' + type + '</span><span class="muted">' + s.n + ' closed' + (s.n < 30 ? ' · small sample' : '') + '</span></div><div class="v" style="font-size:20px">' + (s.avgR == null ? '—' : (s.avgR >= 0 ? '+' : '') + s.avgR.toFixed(2) + 'R') + ' <small>avg</small></div><div class="small muted">Win rate ' + (s.win == null ? '—' : s.win.toFixed(0) + '%') + ' · Net ' + signedMoney(s.net) + '</div></div>'; };
  return '<div class="inline"><h1>Journal</h1><span class="muted">Demo, Live and Paper are reported separately</span></div>' +
    '<div class="grid-auto">' + stat('Live') + stat('Demo') + stat('Paper') + '</div>' +
    '<section class="panel" aria-labelledby="jH"><div class="panel-h"><h2 id="jH">Trades</h2><div class="chips" role="group" aria-label="Type">' + ['All', 'Live', 'Demo', 'Paper'].map(function (t) { return '<button type="button" class="chip" data-act="jType" data-v="' + t + '" aria-pressed="' + (ui.journalType === t) + '">' + t + '</button>'; }).join('') + '</div><span class="grow"></span>' +
    '<label class="sr" for="jAcct">Account</label><select id="jAcct" data-fresh="1" style="width:auto;min-height:36px"><option value="all">All accounts</option>' + accounts().map(function (a) { return '<option value="' + esc(a.id) + '"' + (ui.journalAcct === a.id ? ' selected' : '') + '>' + esc(a.name) + '</option>'; }).join('') + '</select>' +
    '<label class="sr" for="jStatus">Status</label><select id="jStatus" data-fresh="1" style="width:auto;min-height:36px"><option value="all">Open and closed</option><option value="open"' + (ui.journalStatus === 'open' ? ' selected' : '') + '>Open</option><option value="closed"' + (ui.journalStatus === 'closed' ? ' selected' : '') + '>Closed</option><option value="archived"' + (arch ? ' selected' : '') + '>Archived (' + Store.data.archive.length + ')</option></select>' + (Store.mode === 'server' && !arch ? '<a class="btn small" href="api/export/trades.xlsx?' + exportQuery() + '" download>Export Excel</a><a class="btn small" href="api/export/trades.csv?' + exportQuery() + '" download>Export CSV</a>' : '') + '</div>' +
    (arch ? archivedHTML() : rows.length ? '<div class="scroll"><table><thead><tr><th>Trade</th><th>Account</th><th>Type</th><th>Setup</th><th>Idea source</th><th class="num">Outcome</th><th class="num">P/L</th><th class="num">Fees</th><th>Your score</th><th>Claude grade</th><th>Verified</th><th><span class="sr">Archive & delete</span></th></tr></thead><tbody>' + rows.map(function (t) {
      var a = byId('accounts', t.accountId), r = t.exit ? R.rMultiple(t) : null, rv = t.reviews || [], last = rv[rv.length - 1];
      return '<tr class="click" data-act="goTrade" data-id="' + esc(t.id) + '"><td><a href="#t-' + esc(t.id) + '"><strong>' + esc(t.symbol) + '</strong> ' + t.side + '</a><div class="small muted">' + esc(dateShort(t.createdAt)) + (t.status === 'open' ? ' · open' : '') + '</div></td><td>' + esc(a.name) + '</td><td>' + typeTag(a) + '</td><td>' + esc(t.setup) + '</td><td class="muted">' + esc(t.ideaSource) + '</td>' +
        '<td class="num ' + (t.exit ? (R.realized(t) >= 0 ? 'c-good' : 'c-loss') : '') + '">' + (t.exit ? (r == null ? signedMoney(R.realized(t)) : (r >= 0 ? '+' : '') + r.toFixed(2) + 'R') : '—') + '</td><td class="num">' + (t.exit ? signedMoney(R.realized(t)) : '—') + '</td><td class="num">' + money(t.fees || 0, 2) + '</td>' +
        '<td class="num">' + (t.myReview ? t.myReview.score + ' / 5' : '<span class="muted">—</span>') + '</td><td><strong>' + (last ? esc(last.result.processGrade) + '</strong> <span class="small muted">' + (last.model === 'opus' ? 'Opus' : 'Sonnet') + '</span>' : '<span class="muted">—</span></strong>') + '</td>' +
        '<td>' + (t.verified ? '<span class="tag good">Verified</span>' : '<span class="tag warn">Unverified</span>') + '</td><td>' + tradeMenuHTML(t, 'Archive & delete ' + t.symbol + ' ' + t.side) + '</td></tr>' +
        (tradeConfirmHTML(t) ? '<tr><td colspan="12">' + tradeConfirmHTML(t) + '</td></tr>' : '');
    }).join('') + '</tbody></table></div>' : '<div class="empty">No trades match these filters.</div>') + '</section>' +
    chatHTML();
}
function chatHTML() {
  return '<section class="panel ai-box" aria-labelledby="chatH"><div class="panel-h"><h2 id="chatH">Ask Claude about your trades</h2><span class="grow"></span><span class="small muted">Uses your Claude account · reads only this journal</span></div><div class="panel-b">' +
    (ui.chat.length ? '<div class="chat" id="chatLog">' + ui.chat.map(function (m, i) { return '<div class="msg ' + (m.role === 'user' ? 'me' : 'ai') + '"' + (i === ui.chat.length - 1 && m.role !== 'user' ? ' id="chatLast"' : '') + '>' + esc(m.content || (m.pending ? 'Thinking…' : '')) + '</div>'; }).join('') + '</div>' : '<div class="chips">' + ['Which setup is working best on Demo?', 'Am I trading worse after a loss?', 'Which idea sources lead to my best trades?'].map(function (q) { return '<button class="chip" data-act="chatQ" data-q="' + esc(q) + '">' + esc(q) + '</button>'; }).join('') + '</div>') +
    '<form class="inline" id="chatForm"><label class="sr" for="chatIn">Question</label><input id="chatIn" type="text" placeholder="Ask about your journal" style="flex:1 1 260px"><button class="btn primary" type="submit"' + (ui.chatBusy ? ' disabled' : '') + '>' + (ui.chatBusy ? 'Answering…' : 'Ask') + '</button></form></div></section>';
}

/* ---------- views: trade detail ---------- */
/* Correcting a trade from Bitfunded's history. Bitfunded is the source of truth. */
function dtVal(ms) { var d = new Date(ms); return dateVal(ms) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
function fixHTML(t) {
  if (ui.fixId !== t.id) return '';
  var field = function (id, label, value, type) { return '<label class="f" for="' + id + '">' + label + '<input id="' + id + '" type="' + (type || 'number') + '"' + (type ? '' : ' step="any" min="0"') + ' value="' + esc(value) + '"></label>'; };
  var pick = function (id, label, list, cur) { var opts = cur && list.indexOf(cur) < 0 ? list.concat([cur]) : list; return '<label class="f" for="' + id + '">' + label + '<select id="' + id + '">' + opts.map(function (x) { return '<option' + (x === cur ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join('') + '</select></label>'; };
  var s = R.summarize(t), socials = Store.data.socials.map(function (x) { return x.handle; });
  return '<section class="panel" aria-labelledby="fixH" style="border-color:var(--accent)"><div class="panel-h"><h2 id="fixH">Edit trade</h2><span class="small muted">Copy the figures from your Bitfunded trade history. P/L, balance and limits update when you save.</span></div>' +
    '<form class="panel-b stack" id="fixForm" data-id="' + esc(t.id) + '">' +
    '<div class="inline"><label class="f" for="fixAcct">Account<select id="fixAcct">' + accounts().map(function (a) { return '<option value="' + esc(a.id) + '"' + (a.id === t.accountId ? ' selected' : '') + '>' + esc(a.name) + '</option>'; }).join('') + '</select></label>' +
    '<label class="f" for="fixSym">Pair<select id="fixSym">' + pairOptions(t.symbol) + '</select></label>' + pick('fixSide', 'Side', ['Long', 'Short'], t.side) + '</div>' +
    t.fills.map(function (f, i) { return '<div class="inline">' + field('fixP' + i, (t.fills.length > 1 ? 'Fill ' + (i + 1) + ' entry price' : 'Entry price'), f.price) + field('fixS' + i, 'Size (' + esc(R.assetInfo(t.symbol).unit) + ')', f.size) + field('fixL' + i, 'Leverage (x)', f.lev) + field('fixT' + i, 'Opened', dtVal(f.t), 'datetime-local') + '</div>'; }).join('') +
    '<div class="inline" style="align-items:flex-start">' + levelModeHTML() + levelFieldHTML('fixSL', 'sl', 'Stop loss', levelShown(t.sl, 'sl', t.side, s.avgEntry)) + levelFieldHTML('fixTP', 'tp', 'Take profit', levelShown(t.tp, 'tp', t.side, s.avgEntry)) + '</div>' +
    '<div class="inline">' + (t.exit ? field('fixXP', 'Exit price', t.exit.price) + field('fixXT', 'Closed', dtVal(t.exit.t), 'datetime-local') + pick('fixXR', 'Closed by', ['Manual', 'Stop loss', 'Take profit'], t.exit.reason) : field('fixXP', 'Exit price (fill in to close)', '') + field('fixXT', 'Closed (blank means now)', '', 'datetime-local') + pick('fixXR', 'Closed by', ['Manual', 'Stop loss', 'Take profit'], 'Manual')) + field('fixFee', 'Total fees and costs ($)', t.fees || 0) + '</div>' +
    (t.exit ? '' : '<p class="small muted" style="margin:0">This position is open. Enter an exit price to close it when you save, or leave it blank to keep it open.</p>') +
    '<div class="inline">' + pick('fixSetup', 'Setup', SETUPS, t.setup) + pick('fixIdea', 'Idea source', ['Own idea'].concat(socials), t.ideaSource) + pick('fixMood', 'Mood', MOODS, t.mood) + '</div>' +
    '<label class="f" for="fixReason">Reason for the trade<input id="fixReason" type="text" value="' + esc(t.reason || '') + '"></label>' +
    '<div class="inline"><button class="btn primary" type="submit">Save changes</button><button class="btn" type="button" data-act="cancelFix">Cancel</button></div></form></section>';
}
function fixFromForm(t) {
  var g = function (id) { return document.getElementById(id).value; };
  var when = function (id, old) { var v = g(id); if (v === dtVal(old)) return old; var ms = new Date(v).getTime(); return isNaN(ms) ? null : ms; };
  var nt = clone(t), now = appNow();
  for (var i = 0; i < nt.fills.length; i++) {
    var price = Number(g('fixP' + i)), size = Number(g('fixS' + i)), at = when('fixT' + i, nt.fills[i].t);
    if (!(price > 0)) return { error: 'Entry price should be above zero.' };
    if (!(size > 0)) return { error: 'Size should be above zero.' };
    if (at == null || at > now + MIN) return { error: 'Check the opened time. It can’t be in the future.' };
    var lev = Number(g('fixL' + i));
    if (!(lev >= 1)) return { error: 'Leverage should be 1 or more.' };
    nt.fills[i] = Object.assign({}, nt.fills[i], { price: price, size: size, lev: lev, t: at });
  }
  var fee = Number(g('fixFee'));
  if (g('fixFee') === '' || !(fee >= 0)) return { error: 'Fees should be zero or more.' };
  nt.fees = fee;
  var symbol = g('fixSym'), side = g('fixSide');
  if (symbol !== nt.symbol) { nt.entryCandles = []; nt.exitCandles = []; ensurePrice(symbol); }
  nt.accountId = g('fixAcct'); nt.symbol = symbol; nt.side = side;
  nt.setup = g('fixSetup'); nt.ideaSource = g('fixIdea'); nt.mood = g('fixMood'); nt.reason = g('fixReason').trim();
  var slv = levelPriceOf('fixSL'), tpv = levelPriceOf('fixTP');
  if (slv !== '' && !(Number(slv) > 0)) return { error: 'Stop loss should be above zero, or blank.' };
  if (tpv !== '' && !(Number(tpv) > 0)) return { error: 'Take profit should be above zero, or blank.' };
  nt.sl = slv === '' ? null : Number(slv); nt.tp = tpv === '' ? null : Number(tpv);
  var closing = !nt.exit && g('fixXP') !== '';
  if (nt.status === 'open' && !closing) {
    if (g('fixXT') !== '') return { error: 'Enter the exit price too, or clear the closed time.' };
    var bad = levelProblem(side, nt.sl, nt.tp, Sim.prices[symbol]); if (bad) return { error: bad };
  }
  if (closing) {
    var cxp = Number(g('fixXP')), cxt = g('fixXT') === '' ? now : new Date(g('fixXT')).getTime(), opened = R.summarize(nt).openedAt;
    if (!(cxp > 0)) return { error: 'Exit price should be above zero.' };
    if (isNaN(cxt) || cxt > now + MIN) return { error: 'Check the closed time. It can\u2019t be in the future.' };
    if (cxt < opened) return { error: 'A trade can\u2019t close before it opened.' };
    if (fee === (t.fees || 0)) nt.fees = closeFeesEstimate(nt, cxp);   // left as it was: add the closing fee, as a normal close does
    nt.status = 'closed';
    nt.exit = { t: cxt, price: cxp, reason: g('fixXR') };
    nt.exitCandles = snapshotCandles(symbol, opened, cxt + 20 * MIN, 120);
    if (ui.editId === t.id) ui.editId = null;
  } else if (nt.exit) {
    var xp = Number(g('fixXP')), xt = when('fixXT', nt.exit.t);
    if (!(xp > 0)) return { error: 'Exit price should be above zero.' };
    if (xt == null || xt > now + MIN) return { error: 'Check the closed time. It can’t be in the future.' };
    if (xt < R.summarize(nt).openedAt) return { error: 'A trade can’t close before it opened.' };
    nt.exit = Object.assign({}, nt.exit, { price: xp, t: xt, reason: g('fixXR') });
  }
  nt.correctedAt = now;
  return { trade: nt };
}
/* Before and after screenshots, stored by the cockpit server. */
function shotsHTML(t) {
  if (Store.mode !== 'server') return '';
  var shots = t.shots || {};
  return '<section class="panel" aria-labelledby="shotsH"><div class="panel-h"><h2 id="shotsH">Screenshots</h2><span class="small muted">PNG, JPEG or WebP, up to 10 MB. On a computer you can also paste one.</span></div><div class="panel-b"><div class="shots">' +
    [['before', 'Before the trade'], ['after', 'After the trade']].map(function (k) {
      var list = shots[k[0]] || [];
      return '<div class="stack" id="shots-' + k[0] + '"><div class="inline" style="justify-content:space-between"><h3>' + k[1] + '</h3>' +
        '<label class="btn small" style="display:inline-flex;align-items:center" for="shotFile-' + k[0] + '">Add screenshot<input class="sr" id="shotFile-' + k[0] + '" type="file" accept="image/png,image/jpeg,image/webp" multiple data-shot="' + k[0] + '" data-id="' + esc(t.id) + '"></label></div>' +
        (list.length ? '<div class="shot-list">' + list.map(function (s) {
          var url = 'api/shots/' + encodeURIComponent(t.id) + '/' + encodeURIComponent(s.id), conf = ui.confirm && ui.confirm.kind === 'delShot' && ui.confirm.id === s.id;
          return '<figure class="shot" style="margin:0"><a href="' + url + '" target="_blank" rel="noopener"><img src="' + url + '" loading="lazy" alt="' + esc(k[1] + ' screenshot' + (s.name ? ': ' + s.name : '')) + '"></a>' +
            '<figcaption class="inline small muted" style="justify-content:space-between"><span>' + esc(dateShort(s.t)) + '</span>' +
            (conf ? '<span class="inline"><button class="btn small danger" data-act="doDelShot" data-trade="' + esc(t.id) + '" data-id="' + esc(s.id) + '">Delete screenshot</button><button class="btn small" data-act="cancelConfirm">Keep</button></span>'
              : '<button class="btn small" data-act="askDelShot" data-id="' + esc(s.id) + '">Delete</button>') + '</figcaption></figure>';
        }).join('') + '</div>' : '<div class="small muted">None yet.</div>') + '</div>';
    }).join('') + '</div></div></section>';
}
function uploadShots(tradeId, kind, files) {
  return Array.prototype.reduce.call(files, function (chain, file) {
    return chain.then(function () {
      if (file.size > 10 * 1024 * 1024) { toast(file.name + ' is over 10 MB.', 'warn'); return; }
      return fetch('api/trades/' + encodeURIComponent(tradeId) + '/shots/' + kind, { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name || '') }, body: file })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { if (r.ok) toast((kind === 'before' ? 'Before' : 'After') + ' screenshot added.', 'good'); else toast(b.message || 'That screenshot didn’t upload.', 'warn'); }); })
        .catch(function () { toast('The screenshot didn’t upload. Check your connection.', 'danger'); });
    });
  }, Promise.resolve());
}
function viewTrade(id) {
  var t = byId('trades', id);
  if (!t) return '<div class="empty">' + (byId('archive', id) ? 'This trade is archived. Restore it from <strong>Archived</strong> in the journal to see it here.' : 'That trade isn’t in the journal.') + ' <a href="#journal">Back to journal</a></div>';
  var a = byId('accounts', t.accountId) || { name: '?', stage: '', size: 1 };
  var s = R.summarize(t), now = appNow(), r = t.exit ? R.rMultiple(t) : null, pl = t.exit ? R.realized(t) : R.pnlAt(t, Sim.prices[t.symbol]);
  var flags = R.positionFlags(t, a, t.exit ? t.exit.t : now).flags;
  var h = '<div class="inline"><a href="#journal" class="small">← Journal</a></div>' +
    '<section class="panel" aria-labelledby="trH"><div class="panel-b"><div class="inline"><h1 id="trH">' + esc(t.symbol + ' · ' + t.side) + '</h1>' + typeTag(a) + '<span class="tag">' + esc(a.name + ' · ' + a.stage) + '</span>' + (t.verified ? '<span class="tag good">Verified</span>' : '<span class="tag warn">Unverified</span>') + '<span class="tag">' + esc(t.setup) + '</span>' + (t.status === 'open' ? '<span class="tag accent">Open</span>' : '') + (t.sample ? '<span class="tag">Sample</span>' : '') + '</div>' +
    '<div class="small muted">' + esc(dateShort(s.openedAt)) + (t.exit ? ' → ' + esc(dateShort(t.exit.t)) + ' · held ' + fmtDur(t.exit.t - s.openedAt) + ' · ' + esc(t.exit.reason) : ' · open ' + fmtDur(now - s.openedAt)) + ' · ' + esc(t.rulesVersion || R.rulesFor(a).version) + '</div>' +
    '<div class="kv"><div><div class="k">Avg entry</div><div class="v">' + px(t.symbol, s.avgEntry) + '</div></div><div><div class="k">Total size</div><div class="v">' + qty(s.size) + ' ' + esc(R.assetInfo(t.symbol).unit) + '</div></div>' +
    '<div><div class="k">Stop loss</div><div class="v ' + (t.sl == null ? 'c-danger' : '') + '">' + (t.sl == null ? 'None' : px(t.symbol, t.sl)) + '</div></div><div><div class="k">Take profit</div><div class="v">' + (t.tp == null ? 'None' : px(t.symbol, t.tp)) + '</div></div>' +
    '<div><div class="k">' + (t.exit ? 'Exit' : 'Price now') + '</div><div class="v">' + px(t.symbol, t.exit ? t.exit.price : Sim.prices[t.symbol]) + '</div></div>' +
    '<div><div class="k">' + (t.exit ? 'Outcome' : 'Unrealised') + '</div><div class="v ' + (pl >= 0 ? 'c-good' : 'c-loss') + '">' + signedMoney(pl) + (r != null ? ' · ' + (r >= 0 ? '+' : '') + r.toFixed(2) + 'R' : '') + '</div></div>' +
    '<div><div class="k">Effective leverage</div><div class="v ' + (s.effLeverage > R.rulesFor(a).maxLeverage ? 'c-danger' : '') + '">' + s.effLeverage.toFixed(1) + 'x</div></div><div><div class="k">Total fees</div><div class="v">' + money(t.fees || 0, 2) + '</div></div></div>' +
    '<div class="inline small"><span><span class="muted">Idea source:</span> ' + esc(t.ideaSource) + '</span><span><span class="muted">Mood:</span> ' + esc(t.mood) + '</span><span><span class="muted">Checklist:</span> ' + Object.values(t.checklist || {}).filter(Boolean).length + ' / 5</span>' + (t.reason ? '<span><span class="muted">Reason:</span> ' + esc(t.reason) + '</span>' : '') + '</div>' +
    (flags.length ? '<div class="inline">' + flags.map(function (f) { return '<span class="tag ' + f.level + '">' + esc(f.text) + '</span>'; }).join('') + '</div>' : '') +
    '<div class="inline"><button class="btn small" data-act="fixTrade" data-id="' + esc(t.id) + '">Edit trade</button>' + (t.correctedAt ? '<span class="tag">Edited ' + esc(dateShort(t.correctedAt)) + '</span>' : '') + (t.verified ? '' : '<button class="btn small" data-act="verify" data-id="' + esc(t.id) + '">Mark matched to a Bitfunded fill</button>') + (t.status === 'open' ? '<button class="btn small" data-act="addFromTrade" data-id="' + esc(t.id) + '">Add to this position</button><button class="btn small danger" data-act="askClose" data-id="' + esc(t.id) + '">Close position</button>' : '') + tradeMenuHTML(t) + '</div>' + tradeConfirmHTML(t) + '</div></section>';

  if (t.status === 'open' && ui.confirm && ui.confirm.kind === 'close' && ui.confirm.id === t.id) h += '<section class="panel" aria-label="Close this position">' + closeFormHTML(t, ui.confirm.price) + '</section>';

  h += '<section class="panel" aria-labelledby="fillsH"><div class="panel-h"><h2 id="fillsH">Position build</h2><span class="small muted">' + t.fills.length + ' fill' + (t.fills.length > 1 ? 's' : '') + '</span></div><div class="scroll"><table><thead><tr><th>#</th><th>Time</th><th>Type</th><th class="num">Price</th><th class="num">Position size</th><th class="num">Leverage</th><th class="num">Notional</th><th class="num">Margin</th><th>Note</th></tr></thead><tbody>';
  var runS = 0, runN = 0;
  t.fills.forEach(function (f, i) {
    var avg = runS ? runN / runS : null, down = avg != null && (t.side === 'Long' ? f.price < avg : f.price > avg);
    h += '<tr><td class="muted">' + (i + 1) + '</td><td>' + esc(dateShort(f.t)) + '</td><td>' + (i ? 'Add' : 'Initial') + (f.type && f.type !== 'Market' ? ' · ' + esc(f.type) : '') + '</td><td class="num">' + px(t.symbol, f.price) + '</td><td class="num">' + qty(f.size) + '</td><td class="num ' + (f.lev > R.rulesFor(a).maxLeverage ? 'c-danger' : '') + '">' + f.lev + 'x</td><td class="num">' + money(f.price * f.size) + '</td><td class="num">' + money(f.price * f.size / f.lev) + '</td><td class="' + (i ? (down ? 'c-warn' : 'c-good') : 'muted') + '">' + (i ? (down ? 'Averaging down' : 'Adding to a winner') : 'Planned entry') + '</td></tr>';
    runS += f.size; runN += f.price * f.size;
  });
  h += '</tbody></table></div></section>';

  h += fixHTML(t) + shotsHTML(t);

  h += '<div class="row"><section class="panel side" aria-labelledby="myH"><div class="panel-h"><h2 id="myH">1 · Your review</h2><span class="grow"></span>' + (t.myReview ? '<span class="small c-good">Submitted ' + esc(dateShort(t.myReview.submittedAt)) + '</span>' : '') + '</div><div class="panel-b">';
  if (t.myReview) {
    var mr = t.myReview;
    h += '<div><div class="label">What went well</div><p style="margin:4px 0 0">' + esc(mr.wentWell || '—') + '</p></div><div><div class="label">What went wrong</div><p style="margin:4px 0 0">' + esc(mr.wentWrong || '—') + '</p></div><div class="inline"><span><span class="muted">Followed plan:</span> <strong>' + esc(mr.followedPlan) + '</strong></span><span><span class="muted">Execution score:</span> <strong>' + mr.score + ' / 5</strong></span></div>';
  } else {
    h += '<form class="stack" id="myReview" data-id="' + esc(t.id) + '"><label class="f" for="mrWell">What went well<textarea id="mrWell"></textarea></label><label class="f" for="mrWrong">What went wrong<textarea id="mrWrong"></textarea></label>' +
      '<div class="inline"><label class="f" for="mrPlan">Followed your plan?<select id="mrPlan"><option>Yes</option><option>Mostly</option><option>No</option></select></label><label class="f" for="mrScore">Execution score (1–5)<select id="mrScore"><option>1</option><option>2</option><option selected>3</option><option>4</option><option>5</option></select></label></div>' +
      '<button class="btn primary" type="submit">Submit my review</button><p class="small muted" style="margin:0">Claude’s review unlocks after you submit yours, so your own judgement isn’t anchored by it.</p></form>';
  }
  h += '</div></section>';

  var busy = ui.reviewBusy[t.id], model = ui.reviewModel[t.id] || ((t.reviews || []).length ? (t.reviews[t.reviews.length - 1].model === 'opus' ? 'sonnet' : 'opus') : 'sonnet');
  var canRun = !!t.myReview && t.status === 'closed' && !busy;
  h += '<section class="panel wide ai-box" aria-labelledby="clH"><div class="panel-h"><h2 id="clH">2 · Claude’s review</h2><div class="seg" role="group" aria-label="Review model"><button type="button" data-act="revModel" data-id="' + esc(t.id) + '" data-m="sonnet" aria-pressed="' + (model === 'sonnet') + '">Sonnet</button><button type="button" data-act="revModel" data-id="' + esc(t.id) + '" data-m="opus" aria-pressed="' + (model === 'opus') + '">Opus</button></div>' +
    '<span class="small muted">' + RUBRIC_VERSION + '</span><span class="grow"></span>' +
    (busy ? '<button class="btn small" data-act="stopReview" data-id="' + esc(t.id) + '">Stop</button>' : '<button class="btn primary small" data-act="runReview" data-id="' + esc(t.id) + '"' + (canRun ? '' : ' disabled') + '>' + ((t.reviews || []).length ? 'Run another review' : 'Run review') + '</button>') + '</div><div class="panel-b">';
  if (!t.myReview) h += '<p class="muted" style="margin:0">Submit your review first.</p>';
  else if (t.status !== 'closed') h += '<p class="muted" style="margin:0">Claude reviews the trade once it’s closed.</p>';
  if (busy) h += '<div class="banner info" id="revProgress">' + (busy.chars ? 'Writing the review… ' + busy.chars + ' characters' : 'Thinking… ' + (busy.model === 'opus' ? 'Opus can take a minute or two.' : 'This usually takes under a minute.')) + '</div>';
  if (ui.reviewErr[t.id]) h += '<div class="banner warn">' + esc(ui.reviewErr[t.id]) + '</div>';
  var revs = (t.reviews || []).slice().reverse();
  if (revs.length > 1) {
    var gs = revs.map(function (v) { return 'ABCDF'.indexOf(String(v.result.processGrade).charAt(0)); });
    var spread = Math.max.apply(null, gs) - Math.min.apply(null, gs);
    h += '<div class="banner ' + (spread > 1 ? 'warn' : 'info') + ' small">' + revs.length + ' reviews on this trade. ' + (spread > 1 ? 'Grades differ by more than one step, so read both.' : 'Grades agree within one step.') + '</div>';
  }
  revs.forEach(function (v) { h += reviewCardHTML(v); });
  h += '</div></section></div>';
  return h;
}
function reviewCardHTML(v) {
  var d = v.result || {}, gColor = { A: 'good', B: 'good', C: 'warn', D: 'danger', F: 'danger' }[String(d.processGrade).charAt(0)] || 'ok';
  var bp = d.betterPosition || {};
  return '<article class="stack" style="border-top:1px solid var(--line);padding-top:14px"><div class="inline small muted"><span class="tag accent">' + (v.model === 'opus' ? 'Opus' : 'Sonnet') + '</span>' + (v.modelId ? '<span>' + esc(v.modelId) + (v.costUsd != null ? ' · $' + Number(v.costUsd).toFixed(3) : '') + '</span>' : '<span>tier asked: ' + esc(v.modelTierAsked) + ' · answered: ' + esc(v.modelTierApplied || '?') + '</span>') + '<span>' + esc(v.rubricVersion) + '</span><span>' + esc(dateShort(v.createdAt)) + '</span>' + (d.confidence ? '<span>confidence ' + esc(d.confidence) + '</span>' : '') + '</div>' +
    '<div class="inline" style="align-items:flex-start;gap:20px"><div><div class="small muted">Process grade</div><div class="grade c-' + gColor + '">' + esc(d.processGrade) + '</div></div><p class="review-text" style="margin:0;flex:1 1 320px;min-width:0">' + esc(d.summary || '') + '</p></div>' +
    (d.breaches && d.breaches.length ? '<div class="banner breach small"><strong>Rule issues:</strong> ' + d.breaches.map(esc).join('; ') + '</div>' : '') +
    '<div class="rubric">' + (d.rubric || []).map(function (it) { var sc = Number(it.score) || 0; return '<span class="small">' + esc(it.name) + '</span><div class="bar ' + (sc >= 8 ? 'good' : sc >= 6 ? 'ok' : 'warn') + '"><i style="width:' + sc * 10 + '%"></i></div><span class="num" style="text-align:right;font-weight:600">' + sc + '</span><span class="cite">' + esc(it.cite || '') + '</span>'; }).join('') + '</div>' +
    (d.disagreement ? '<div class="banner info small"><strong>Where you and Claude differ:</strong> <span>' + esc(d.disagreement) + '</span></div>' : '') +
    (bp.available ? '<div class="banner warn small"><strong>Better position available</strong><span class="tag warn">Hypothesis</span><span>' + esc(bp.description || '') + (bp.altR != null ? ' Estimated ' + esc(bp.altR) + 'R.' : '') + '</span></div>' : '') +
    (d.patterns && d.patterns.length ? '<div><div class="label">Patterns</div><ul style="margin:4px 0 0;padding-left:18px">' + d.patterns.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul></div>' : '') + '</article>';
}

/* ---------- views: socials ---------- */
function socialScore(handle) {
  var ts = Store.data.trades.filter(function (t) { var a = byId('accounts', t.accountId); return a && !a.paper && t.status === 'closed' && t.ideaSource === handle; });
  var rs = ts.map(R.rMultiple).filter(function (r) { return r != null; });
  return { n: ts.length, avgR: rs.length ? rs.reduce(function (a, b) { return a + b; }, 0) / rs.length : null };
}
function viewSocials() {
  var list = Store.data.socials.slice().map(function (s) { return Object.assign({ score: socialScore(s.handle) }, s); }).sort(function (a, b) { return (b.score.avgR == null ? -99 : b.score.avgR) - (a.score.avgR == null ? -99 : a.score.avgR); });
  return '<div class="inline"><h1>Socials</h1><span class="muted">Accounts you follow, scored only on your Demo and Live trades from their ideas</span></div>' +
    '<div class="row"><section class="panel wide" aria-labelledby="soH"><div class="panel-h"><h2 id="soH">Accounts I follow</h2></div>' +
    (list.length ? '<div class="scroll"><table><thead><tr><th>Account</th><th>Tag</th><th>My trust</th><th class="num">Trades from idea</th><th class="num">Avg R</th><th>Notes</th><th>Active</th><th><span class="sr">Actions</span></th></tr></thead><tbody>' + list.map(function (s) {
      var conf = ui.confirm && ui.confirm.kind === 'delSocial' && ui.confirm.id === s.id;
      return '<tr><td><strong>' + esc(s.handle) + '</strong><div class="small muted">' + esc(s.name || '') + '</div></td><td><span class="tag">' + esc(s.tag) + '</span></td>' +
        '<td><label class="sr" for="tr-' + esc(s.id) + '">Trust for ' + esc(s.handle) + '</label><select id="tr-' + esc(s.id) + '" data-social="' + esc(s.id) + '" data-field="trust" data-fresh="1" style="width:auto;min-height:34px">' + [1, 2, 3, 4, 5].map(function (n) { return '<option' + (Number(s.trust) === n ? ' selected' : '') + '>' + n + '</option>'; }).join('') + '</select></td>' +
        '<td class="num">' + s.score.n + (s.score.n && s.score.n < 30 ? ' <span class="small muted">low sample</span>' : '') + '</td><td class="num ' + (s.score.avgR == null ? '' : s.score.avgR >= 0 ? 'c-good' : 'c-loss') + '">' + (s.score.avgR == null ? '—' : (s.score.avgR >= 0 ? '+' : '') + s.score.avgR.toFixed(2) + 'R') + '</td>' +
        '<td class="muted">' + esc(s.notes || '') + '</td><td><label class="check" for="ac-' + esc(s.id) + '"><input type="checkbox" id="ac-' + esc(s.id) + '" data-social="' + esc(s.id) + '" data-field="active" data-fresh="1"' + (s.active !== false ? ' checked' : '') + '><span class="sr">Active</span></label></td>' +
        '<td><div class="inline" style="flex-wrap:nowrap"><a class="btn small" href="https://x.com/' + esc(String(s.handle).replace(/^@/, '')) + '" target="_blank" rel="noopener">Open on X</a>' + (conf ? '<button class="btn small danger" data-act="doDelSocial" data-id="' + esc(s.id) + '">Remove</button><button class="btn small" data-act="cancelConfirm">Keep</button>' : '<button class="btn small" data-act="askDelSocial" data-id="' + esc(s.id) + '" aria-label="Remove ' + esc(s.handle) + '">Remove</button>') + '</div></td></tr>';
    }).join('') + '</tbody></table></div>' : '<div class="empty">No accounts yet. Add one with the form.</div>') + '</section>' +
    '<section class="panel side" aria-labelledby="cfgH"><div class="panel-h"><h2 id="cfgH">Config · add accounts</h2></div><form class="panel-b" id="socialForm">' +
    '<label class="f" for="soHandle">X handle<input id="soHandle" type="text" placeholder="@handle"></label><label class="f" for="soBulk">Or paste many, one per line<textarea id="soBulk" placeholder="@one&#10;@two"></textarea></label>' +
    '<div class="inline"><label class="f" for="soTag">Tag<select id="soTag"><option>Macro</option><option>TA</option><option>On-chain</option><option>News</option></select></label><label class="f" for="soTrust">My trust (1–5)<select id="soTrust"><option>1</option><option>2</option><option selected>3</option><option>4</option><option>5</option></select></label></div>' +
    '<label class="f" for="soNotes">Notes<input id="soNotes" type="text" placeholder="Why you follow them"></label><div id="soMsg">' + (ui.socialMsg ? '<div class="banner warn small">' + esc(ui.socialMsg) + '</div>' : '') + '</div><button class="btn primary" type="submit">Add to table</button>' +
    '<p class="small muted" style="margin:0">Manual mode: no X API calls, no cost. Pick the handle as the idea source on the trade ticket to score it.</p></form></section></div>';
}

/* ---------- views: test lab ---------- */
function viewLab() {
  var st = Store.meta.settings, vol = st.volatility || 'normal';
  var conf = ui.confirm && ui.confirm.kind === 'reset';
  return '<div class="inline"><h1>Test lab</h1><span class="muted">Controls for testing the cockpit. Nothing here touches a real Bitfunded account.</span></div>' +
    '<div class="row"><section class="panel wide" aria-labelledby="tH"><div class="panel-h"><h2 id="tH">Time</h2><span class="small muted">Shift the app clock to test the daily reset</span></div><div class="panel-b"><div id="labClock">' + labClockHTML() + '</div>' +
    '<div class="inline"><button class="btn" data-act="shift" data-ms="' + (-HOUR) + '">−1 hour</button><button class="btn" data-act="shift" data-ms="' + HOUR + '">+1 hour</button><button class="btn" data-act="shift" data-ms="' + 6 * HOUR + '">+6 hours</button><button class="btn warn" data-act="jumpReset">Jump to 2 min before reset</button><button class="btn" data-act="shiftReset">Back to real time</button></div></div></section>' +
    '<section class="panel side" aria-labelledby="vH"><div class="panel-h"><h2 id="vH">Price feed</h2></div><div class="panel-b">' + (Store.mode === 'server' ? '<p class="small muted" style="margin:0">Price moves here only work for simulated pairs. Live pairs follow the exchange. Switch the source on the <a href="#feed">Data feed</a> page.</p>' : '') + '<div class="seg" role="group" aria-label="Volatility">' + ['calm', 'normal', 'wild'].map(function (v) { return '<button type="button" data-act="vol" data-v="' + v + '" aria-pressed="' + (vol === v) + '">' + v[0].toUpperCase() + v.slice(1) + '</button>'; }).join('') + '</div>' +
    '<label class="check" for="rsiTog"><input type="checkbox" id="rsiTog" data-fresh="1"' + (st.rsiAlerts === false ? '' : ' checked') + '> RSI(14) signal alerts on 1m candles (charted pair, open positions and pairs with alerts)</label>' +
    '<label class="f" for="labSym">Move a price<select id="labSym" data-fresh="1">' + pairOptions(ui.labSym || ui.sym) + '</select></label>' +
    '<div class="inline"><span class="num" style="font-weight:600;min-width:110px">' + px(ui.labSym || ui.sym, Sim.prices[ui.labSym || ui.sym]) + '</span>' + [-2, -0.5, 0.5, 2].map(function (p) { return '<button class="btn small" data-act="nudge" data-sym="' + (ui.labSym || ui.sym) + '" data-p="' + p + '">' + (p > 0 ? '+' : '') + p + '%</button>'; }).join('') + '</div></div></section></div>' +
    '<section class="panel" aria-labelledby="lpH"><div class="panel-h"><h2 id="lpH">Push open positions to their stop or target</h2></div><div id="labPositions">' + labPositionsHTML() + '</div></section>' +
    '<div class="row"><section class="panel wide" aria-labelledby="rlH"><div class="panel-h"><h2 id="rlH">Rules in force</h2><span class="small muted">From Bitfunded’s official 2-step pages, versioned per challenge</span></div><div class="scroll"><table><thead><tr><th>Rule</th><th>Stage 1</th><th>Stage 2</th><th>Funded</th></tr></thead><tbody>' +
    '<tr><td>Daily loss</td><td>5%</td><td>5%</td><td>5%</td></tr><tr><td>Max total loss</td><td>10%</td><td>8%</td><td>8%</td></tr><tr><td>Profit target</td><td>8%</td><td>5%</td><td>—</td></tr><tr><td>Leverage</td><td colspan="3">1:5</td></tr><tr><td>Open positions</td><td colspan="3">5 at once</td></tr><tr><td>Exposure</td><td colspan="3">Under 65% of available margin</td></tr><tr><td>Hold caps</td><td colspan="3">10 days major crypto (' + R.MAJORS.join(', ') + ') · 7 days other crypto · 5 days XAU, XAG, TSLA</td></tr><tr><td>Payout trades</td><td colspan="3">2+ closed per stage, each open 10+ minutes</td></tr><tr><td>Daily reset</td><td colspan="3">00:00 UTC+8, settles within 10 minutes</td></tr><tr><td>Daily loss measure</td><td colspan="3">Realised losses today (wins don’t offset, a conservative assumption) + floating losses</td></tr></tbody></table></div></section>' +
    '<section class="panel side" aria-labelledby="sysH"><div class="panel-h"><h2 id="sysH">Environment</h2></div><div class="panel-b">' +
    (Store.mode === 'server' ? '<div class="stack"><div class="label">Backups</div><div class="inline"><a class="btn small" href="api/export" download>Download full backup</a><a class="btn small" href="api/export/trades.csv" download>Download trades (CSV)</a></div><p class="small muted" style="margin:0">Trade screenshots aren’t in these files. See SETUP.md for how to back them up.</p>' +
      '<label class="f" for="restoreFile">Restore from a backup file<input id="restoreFile" type="file" accept="application/json,.json"></label>' +
      (ui.confirm && ui.confirm.kind === 'restore' ? '<div class="confirm small"><span>Replace everything with ' + esc(ui.confirm.name) + '? A safety copy of the current data is saved first.</span><button class="btn small danger" data-act="doRestore">Restore</button><button class="btn small" data-act="cancelConfirm">Cancel</button></div>' : '') + '</div>' : '') + '<div class="small"><strong>Storage:</strong> ' + storeNote() + '</div><div class="small"><strong>Claude:</strong> ' + (Claude.sample === null || Claude.blocked ? 'Not available in this view.' : 'Reviews, coach and chat use your Claude account and ask permission on first use.') + '</div>' +
    '<div class="small"><strong>Prices:</strong> Simulated random walk, not a live exchange.</div>' +
    (conf ? '<div class="confirm"><span>Delete all test data and load a fresh sample set?</span><button class="btn small danger" data-act="doReset">Reset test data</button><button class="btn small" data-act="cancelConfirm">Cancel</button></div>' : '<button class="btn danger" data-act="askReset">Reset test data…</button>') + '</div></section></div>' +
    '<section class="panel" aria-labelledby="tryH"><div class="panel-h"><h2 id="tryH">Things to test</h2></div><div class="panel-b"><ul style="margin:0;padding-left:18px;line-height:1.8">' +
    '<li>Dashboard: open a trade with no stop and watch the ticket block nothing but flag it; then try a size whose stop-out would breach daily loss, and see it blocked.</li>' +
    '<li>Add to existing: pick a position, add size below the average and read the averaging-down warning and new risk.</li>' +
    '<li>Set a price alert just above the market, then nudge the price here and check the feed.</li>' +
    '<li>Jump to 2 minutes before the reset and watch the clock turn red, then the daily loss gauge reset after the settlement window.</li>' +
    '<li>Open opposite positions on the same pair in two challenges and check the cross-account guard.</li>' +
    '<li>Journal: open the BTC trade from today on #2, read your sample review, and run a Sonnet then an Opus review.</li>' +
    '<li>Challenges: try adding a second active 25K 2-Step challenge and see it refused.</li></ul></div></section>';
}
function labClockHTML() {
  var now = appNow(), off = Number(Store.meta.settings.offsetMs) || 0, day = R.dayBounds(now);
  return '<div class="kv"><div><div class="k">App time (London)</div><div class="v">' + tz(now, 'Europe/London', true) + '</div></div><div><div class="k">Offset from real time</div><div class="v">' + (off === 0 ? 'None' : (off > 0 ? '+' : '−') + fmtDur(Math.abs(off))) + '</div></div><div><div class="k">Next reset</div><div class="v">' + hms(day.nominalReset - now) + '</div></div></div>';
}
function labPositionsHTML() {
  var rows = Store.data.trades.filter(function (t) { return t.status === 'open'; });
  if (!rows.length) return '<div class="empty">No open positions.</div>';
  return '<div class="scroll"><table><thead><tr><th>Position</th><th>Account</th><th class="num">Price</th><th class="num">SL</th><th class="num">TP</th><th><span class="sr">Actions</span></th></tr></thead><tbody>' + rows.map(function (t) {
    var a = byId('accounts', t.accountId) || {};
    return '<tr><td><strong>' + esc(t.symbol) + '</strong> ' + t.side + '</td><td>' + esc(a.name) + '</td><td class="num">' + px(t.symbol, Sim.prices[t.symbol]) + '</td><td class="num">' + px(t.symbol, t.sl) + '</td><td class="num">' + px(t.symbol, t.tp) + '</td><td><div class="inline" style="flex-wrap:nowrap"><button class="btn small danger" data-act="hit" data-id="' + esc(t.id) + '" data-w="sl"' + (t.sl == null ? ' disabled' : '') + '>Hit stop</button><button class="btn small" data-act="hit" data-id="' + esc(t.id) + '" data-w="tp"' + (t.tp == null ? ' disabled' : '') + '>Hit target</button></div></td></tr>';
  }).join('') + '</tbody></table></div>';
}

/* ---------- views: pairs ---------- */
function savePairs(p) { setMeta('settings', Object.assign({}, Store.meta.settings, { pairs: p })); }
function togglePair(sym, on) {
  var p = Object.assign({ custom: {} }, pairSettings() || {});
  var list = p.enabled ? p.enabled.slice() : allSyms();
  if (on && list.indexOf(sym) < 0) list.push(sym);
  if (!on) list = list.filter(function (x) { return x !== sym; });
  p.enabled = list; savePairs(p);
}
function parsePairText(text) {
  var out = [], bad = [];
  String(text || '').split(/[\n,;\t]+/).forEach(function (chunk) {
    var parts = chunk.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return;
    var priceTok = parts.length > 1 && /^[0-9]*\.?[0-9]+(e-?\d+)?$/i.test(parts[parts.length - 1]) ? parts.pop() : null;
    var sym = R.parseSymbol(parts.join(''));
    if (!sym) { bad.push(chunk.trim()); return; }
    out.push({ sym: sym, price: priceTok ? Number(priceTok) : null });
  });
  return { pairs: out, bad: bad };
}
function importPairs(mode) {
  var el = document.getElementById('pairImport');
  var res = parsePairText(el ? el.value : '');
  if (!res.pairs.length) { ui.pairMsg = res.bad.length ? 'None of those looked like pairs: ' + res.bad.slice(0, 8).join(', ') : 'Paste at least one pair.'; return renderRoute(); }
  var p = Object.assign({ custom: {} }, pairSettings() || {});
  p.custom = Object.assign({}, p.custom || {});
  var fresh = 0, guessed = 0, seen = {};
  var syms = [];
  res.pairs.forEach(function (x) {
    if (seen[x.sym]) return; seen[x.sym] = true; syms.push(x.sym);
    var known = !!R.ASSETS[x.sym] && !R.ASSETS[x.sym].custom;
    if (!known) { fresh += 1; if (!(x.price > 0) && !(p.custom[x.sym] > 0)) guessed += 1; p.custom[x.sym] = x.price > 0 ? x.price : (p.custom[x.sym] || 0); R.addPair(x.sym, p.custom[x.sym]); }
    else if (x.price > 0) { p.custom[x.sym] = x.price; R.addPair(x.sym, x.price); Sim.prices[x.sym] = x.price; delete Sim.candles[x.sym]; }
    ensurePrice(x.sym);
  });
  var current = p.enabled ? p.enabled.slice() : allSyms();
  p.enabled = mode === 'add' ? current.concat(syms.filter(function (s) { return current.indexOf(s) < 0; })) : syms;
  var counts = { major: 0, minor: 0, traditional: 0 };
  syms.forEach(function (s) { counts[R.assetInfo(s).cls] += 1; });
  ui.pairMsg = (mode === 'add' ? 'Added ' : 'Your list is now ') + syms.length + ' pairs: ' + counts.major + ' major, ' + counts.minor + ' minor, ' + counts.traditional + ' traditional.' +
    (fresh ? ' ' + fresh + ' new to the cockpit' + (guessed ? ', ' + guessed + ' without a price (starting at 1.00 on the simulated feed; add a price after the symbol to fix it)' : '') + '.' : '') +
    (res.bad.length ? ' Skipped: ' + res.bad.slice(0, 8).join(', ') + (res.bad.length > 8 ? '…' : '') + '.' : '');
  if (el) el.value = '';
  savePairs(p);
}
function pairTableHTML() {
  var on = enabledSyms(), q = (ui.pairQ || '').trim().toUpperCase(), cls = ui.pairCls || 'all';
  var rows = allSyms().filter(function (s) { var a = R.assetInfo(s); return (cls === 'all' || a.cls === cls) && (!q || s.indexOf(q) >= 0); });
  if (!rows.length) return '<div class="empty">No pairs match.</div>';
  var caps = { major: '10 days', minor: '7 days', traditional: '5 days' };
  return '<div class="scroll" style="max-height:560px;overflow-y:auto"><table><thead><tr><th>Use</th><th>Pair</th><th>Class</th><th>Hold limit</th><th class="num">Simulated price</th><th>Source</th></tr></thead><tbody>' + rows.map(function (s) {
    var a = R.assetInfo(s), id = 'pr-' + s.replace(/[^A-Z0-9]/g, '-');
    var held = Store.data.trades.some(function (t) { return t.status === 'open' && t.symbol === s; });
    return '<tr><td><label class="check" for="' + id + '"><input type="checkbox" id="' + id + '" data-fresh="1" data-pair="' + s + '"' + (on.indexOf(s) >= 0 ? ' checked' : '') + (held ? ' disabled' : '') + '><span class="sr">Use ' + s + '</span></label></td><td><strong>' + s + '</strong>' + (held ? '<div class="small muted">Open position, stays listed</div>' : '') + '</td>' +
      '<td><span class="tag ' + (a.cls === 'major' ? 'accent' : a.cls === 'traditional' ? 'warn' : '') + '">' + a.cls + '</span></td><td>' + caps[a.cls] + '</td><td class="num">' + px(s, Sim.prices[s]) + '</td>' +
      '<td class="small ' + (a.priceGuessed ? 'c-warn' : 'muted') + '">' + (a.custom ? (a.priceGuessed ? 'Your list · price not set' : 'Your list') : 'Built-in') + '</td></tr>';
  }).join('') + '</tbody></table></div>';
}
function viewPairs() {
  var total = allSyms().length, on = enabledSyms().length, p = pairSettings();
  var conf = ui.confirm && ui.confirm.kind === 'pairsReset';
  return '<div class="inline"><h1>Pairs</h1><span class="muted">' + on + ' of ' + total + ' in use' + (p && p.enabled ? ' · your list' : ' · built-in list') + '</span></div>' +
    '<div class="banner info small"><span>Bitfunded doesn\u2019t publish its full instrument list. Copy it from their trading platform and paste it below, and the cockpit will match it exactly. Classes come from Bitfunded\u2019s rules: 10 named majors (' + esc(R.MAJORS.join(', ') + ') hold 10 days, XAU, XAG and TSLA hold 5 days, every other crypto is minor and holds 7 days.') + '</span></div>' +
    '<div class="row"><section class="panel side" aria-labelledby="impH"><div class="panel-h"><h2 id="impH">Paste Bitfunded\u2019s list</h2></div><form class="panel-b" id="pairForm">' +
    '<label class="f" for="pairImport">One pair per line, or separated by commas. Formats like BTCUSDT, BTC/USDT, btc-usdt or just BTC all work. Add a price after the symbol to set its simulated starting price.<textarea id="pairImport" rows="9" placeholder="BTCUSDT&#10;ETHUSDT&#10;WLDUSDT 2.35&#10;XAUUSD"></textarea></label>' +
    (ui.pairMsg ? '<div class="banner info small">' + esc(ui.pairMsg) + '</div>' : '') +
    '<div class="inline"><button class="btn primary" type="button" data-act="pairImport" data-mode="replace">Use exactly this list</button><button class="btn" type="button" data-act="pairImport" data-mode="add">Add to my list</button></div></form></section>' +
    '<section class="panel wide" aria-labelledby="plH"><div class="panel-h"><h2 id="plH">All pairs</h2><div class="chips" role="group" aria-label="Class">' + [['all', 'All'], ['major', 'Major'], ['minor', 'Minor'], ['traditional', 'Traditional']].map(function (c) { return '<button type="button" class="chip" data-act="pairCls" data-v="' + c[0] + '" aria-pressed="' + ((ui.pairCls || 'all') === c[0]) + '">' + c[1] + '</button>'; }).join('') + '</div><span class="grow"></span>' +
    '<label class="sr" for="pairSearch">Search pairs</label><input id="pairSearch" type="text" placeholder="Search, e.g. WLD" style="width:180px;min-height:36px" value="' + esc(ui.pairQ || '') + '">' +
    (conf ? '<span class="confirm small">Turn every pair back on?<button class="btn small danger" data-act="doPairsReset">Use all pairs</button><button class="btn small" data-act="cancelConfirm">Cancel</button></span>' : '<button class="btn small" data-act="askPairsReset">Use all pairs</button>') + '</div>' +
    '<div id="pairTable">' + pairTableHTML() + '</div></section></div>';
}

/* ---------- events ---------- */
var actions = {
  loadSample: function () { loadSample(); },
  startBlank: function () { put('accounts', { id: uid('acc'), name: '#1 · 10K', bitfundedId: '', program: '2-Step', size: 10000, stage: 'Stage 1', status: 'active', fee: 0, maxLeverage: 5, startedAt: appNow(), stageStartedAt: appNow(), outcome: 'In progress' }); },
  sym: function (d) { ui.sym = d.sym; if (activeActEl && activeActEl.closest('#dbPositions')) ui.phoneView = 'chart'; renderRoute(); },
  phoneView: function (d) { ui.phoneView = d.v; if (route() !== 'dashboard') location.hash = '#dashboard'; else renderRoute(); applyPhoneView(); window.scrollTo(0, 0); },
  tkMore: function () { ui.tkMore = !ui.tkMore; renderRoute(); },
  tf: function (d) { if (d.tf === ui.tf) return; ui.tf = d.tf; lsSet('cockpit-tf', d.tf); renderRoute(); },
  drawTool: function (d) { ui.drawTool = ui.drawTool === d.tool ? null : d.tool; ui.drawSel = null; ui.confirm = null; Chart.draft = null; syncDrawUI(); },
  drawDelete: function () { if (ui.drawSel) remove('drawings', ui.drawSel); ui.drawSel = null; syncDrawUI(); },
  askDrawClear: function () { ui.confirm = { kind: 'drawClear' }; syncDrawUI(); },
  cancelDrawClear: function () { ui.confirm = null; syncDrawUI(); },
  doDrawClear: function () { ui.confirm = null; ui.drawSel = null; symbolDrawings(ui.sym).forEach(function (x) { remove('drawings', x.id); }); syncDrawUI(); },
  tkMode: function (d) { ui.ticketMode = d.mode; ui.coach = null; renderRoute(); },
  tkSide: function (d) { ui.side = d.side; renderRoute(); },
  tkLev: function (d) { ui.lev = Number(d.lev); renderRoute(); },
  cancelOrder: function (d) { var o = byId('orders', d.id); if (o) { put('orders', Object.assign({}, o, { status: 'cancelled', cancelledAt: appNow(), note: 'Cancelled by you' })); toast('Order cancelled.', 'accent'); } },
  coach: function () { askCoach(); },
  addTo: function (d) { ui.ticketMode = 'add'; ui.addTarget = d.id; ui.phoneView = 'trade'; renderRoute(); applyPhoneView(); var el = document.getElementById('tkSize'); if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); } },
  editSL: function (d) { ui.editId = ui.editId === d.id ? null : d.id; renderRoute(); },
  cancelEdit: function () { ui.editId = null; renderRoute(); },
  askClose: function (d) { var t = byId('trades', d.id); if (!t) return; ui.editId = null; ui.confirm = { kind: 'close', id: d.id, price: Number(Number(Sim.prices[t.symbol]).toFixed(dec(t.symbol))) }; renderRoute(); },
  levelMode: function (d) {
    if (d.v === ui.levelMode) return;
    var saved = [];
    document.querySelectorAll('input[data-level]').forEach(function (el) { saved.push({ id: el.id, price: levelPrice(el), kind: el.dataset.level }); });
    ui.levelMode = d.v; lsSet('cockpit-level-mode', d.v);
    renderRoute();
    saved.forEach(function (x) {
      var el = document.getElementById(x.id); if (!el) return;
      var c = levelCtx(el);
      el.value = x.price === '' || !c || !c.entry ? '' : levelShown(Number(x.price), x.kind, c.side, c.entry);
    });
    updateLevelHints();
    if (document.getElementById('ticket')) renderTicketPreview();
  },
  fixOpen: function (d) { ui.fixId = d.id; ui.editId = null; },
  fixTrade: function (d) { ui.fixId = ui.fixId === d.id ? null : d.id; renderRoute(); },
  cancelFix: function () { ui.fixId = null; renderRoute(); },
  cancelConfirm: function () { ui.confirm = null; renderRoute(); },
  delLevel: function (d) { remove('levels', d.id); },
  failAcc: function (d) { var a = byId('accounts', d.id); if (a) put('accounts', Object.assign({}, a, { status: 'failed', outcome: 'Limit reached' })); },
  openAcc: function (d) { setAccount(d.id); location.hash = '#dashboard'; },
  editAcc: function (d) { ui.editAcc = d.id; ui.accMsg = ''; renderRoute(); var f = document.getElementById('accForm'); if (f && f.scrollIntoView) f.scrollIntoView({ block: 'start' }); var n = document.getElementById('naName'); if (n) n.focus({ preventScroll: true }); },
  cancelAccEdit: function () { ui.editAcc = null; ui.accMsg = ''; renderRoute(); },
  askAcc: function (d) { ui.confirm = { kind: 'acc', id: d.id, op: d.op, label: d.label }; renderRoute(); },
  doAccAction: function (d) {
    var a = byId('accounts', d.id), c = ui.confirm; ui.confirm = null; if (!a || !c) return renderRoute();
    var n = Object.assign({}, a);
    if (c.op === 'advance') { n.stage = a.stage === 'Stage 1' ? 'Stage 2' : 'Funded'; n.stageStartedAt = appNow(); n.outcome = n.stage === 'Funded' ? 'Funded' : 'Stage 1 passed'; n.priorPnl = 0; n.priorQualifying = 0; n.priorDayLoss = null; n.balanceSync = null; }
    if (c.op === 'fail') { n.status = 'failed'; n.outcome = 'Failed'; }
    if (c.op === 'reactivate') { var chk = R.canAddChallenge(Store.data.accounts.filter(function (x) { return x.id !== a.id; }), a); if (!chk.ok) { toast(chk.reason, 'warn'); return renderRoute(); } n.status = 'active'; n.outcome = 'In progress'; }
    put('accounts', n); toast(c.label + ': done.', 'good');
  },
  jType: function (d) { ui.journalType = d.v; renderRoute(); },
  goTrade: function (d, el, ev) { if (ev && ev.target.closest('a, select, label, .confirm')) return; location.hash = '#t-' + d.id; },
  doArchive: function (d) { ui.confirm = null; archiveTrade(d.id).then(function () { toast('Archived. It no longer counts toward your limits or stats.', 'good'); }); if (location.hash === '#t-' + d.id) location.hash = '#journal'; else renderRoute(); },
  doDelTrade: function (d) { ui.confirm = null; if (ui.fixId === d.id) ui.fixId = null; remove('trades', d.id); toast('Trade deleted.', 'good'); if (location.hash === '#t-' + d.id) location.hash = '#journal'; else renderRoute(); },
  doUnarchive: function (d) { unarchiveTrade(d.id).then(function () { toast('Restored to the journal. It counts toward your limits again.', 'good'); }); renderRoute(); },
  askDelArchived: function (d) { ui.confirm = { kind: 'delArchived', id: d.id }; renderRoute(); },
  doDelArchived: function (d) { ui.confirm = null; remove('archive', d.id); toast('Archived trade deleted.', 'good'); },
  verify: function (d) { var t = byId('trades', d.id); if (t) put('trades', Object.assign({}, t, { verified: true, verifiedAt: appNow() })); },
  addFromTrade: function (d) { var t = byId('trades', d.id); if (!t) return; setAccount(t.accountId); ui.ticketMode = 'add'; ui.addTarget = t.id; location.hash = '#dashboard'; },
  revModel: function (d) { ui.reviewModel[d.id] = d.m; renderRoute(); },
  tgTest: function () { sendTelegramTest(); },
  askDelShot: function (d) { ui.confirm = { kind: 'delShot', id: d.id }; renderRoute(); },
  doDelShot: function (d) {
    ui.confirm = null; renderRoute();
    fetch('api/shots/' + encodeURIComponent(d.trade) + '/' + encodeURIComponent(d.id), { method: 'DELETE' }).then(function (r) { if (!r.ok) throw new Error('failed'); toast('Screenshot deleted.', 'good'); }).catch(function () { toast('That screenshot wasn’t deleted. Try again.', 'danger'); });
  },
  runReview: function (d) { var t = byId('trades', d.id); if (t) runReview(t, ui.reviewModel[d.id] || ((t.reviews || []).length ? (t.reviews[t.reviews.length - 1].model === 'opus' ? 'sonnet' : 'opus') : 'sonnet')); },
  stopReview: function (d) { var b = ui.reviewBusy[d.id]; if (b) b.ctl.abort(); },
  chatQ: function (d) { sendChat(d.q); },
  askDelSocial: function (d) { ui.confirm = { kind: 'delSocial', id: d.id }; renderRoute(); },
  doDelSocial: function (d) { ui.confirm = null; remove('socials', d.id); },
  shift: function (d) { setOffset((Number(Store.meta.settings.offsetMs) || 0) + Number(d.ms)); },
  jumpReset: function () { var now = Date.now(), day = R.dayBounds(now); var target = day.nominalReset - 2 * MIN; if (target <= now) target += DAY; setOffset(target - now); },
  shiftReset: function () { setOffset(0); },
  vol: function (d) { setMeta('settings', Object.assign({}, Store.meta.settings, { volatility: d.v })); },
  nudge: function (d) { nudge(d.sym, Number(d.p)); renderRoute(); },
  hit: function (d) { var t = byId('trades', d.id); if (!t) return; var target = d.w === 'sl' ? Number(t.sl) : Number(t.tp); var long = t.side === 'Long'; var beyond = d.w === 'sl' ? (long ? -1 : 1) : (long ? 1 : -1); moveTo(t.symbol, target * (1 + beyond * 0.0002)); renderRoute(); },
  askReset: function () { ui.confirm = { kind: 'reset' }; renderRoute(); },
  doReset: function () { ui.confirm = null; resetData(); },
  doRestore: function () {
    var c = ui.confirm; ui.confirm = null; if (!c || !c.text) return renderRoute();
    fetch('api/import', { method: 'POST', headers: serverHeaders(), body: c.text }).then(function (r) { return r.json().then(function (b) { if (!r.ok) throw b; toast('Restored. Safety copy saved as ' + b.safetyCopy + '.', 'good'); }); })
      .catch(function (e) { toast((e && e.message) || 'Restore failed.', 'danger'); renderRoute(); });
  },
  feedSrc: function (d) { if (d.v === 'coingecko' && !CG.connected) return; saveFeed({ source: d.v }); if (Store.mode === 'server') { Sim.candles = {}; TFData = {}; toast('Price source: ' + FEED_SOURCES[d.v] + '.', 'good'); setTimeout(function () { if (Chart.chart) mountChart(); }, 1500); } },
  feedFilter: function (d) { ui.feedFilter = d.v; renderRoute(); },
  pairImport: function (d) { importPairs(d.mode === 'add' ? 'add' : 'replace'); },
  pairCls: function (d) { ui.pairCls = d.v; setHTML('pairTable', pairTableHTML(), true); renderRoute(); },
  pairsAll: function () { var p = Object.assign({}, pairSettings() || {}); p.enabled = null; savePairs(p); },
  askPairsReset: function () { ui.confirm = { kind: 'pairsReset' }; renderRoute(); },
  doPairsReset: function () { ui.confirm = null; ui.pairMsg = 'Using every pair again, including any you added.'; var p = pairSettings() || {}; savePairs({ enabled: null, custom: p.custom || {} }); }
};
function setOffset(ms) {
  setMeta('settings', Object.assign({}, Store.meta.settings, { offsetMs: ms }));
  if (Store.mode !== 'server') Object.keys(Sim.candles).forEach(buildHistory);
  Watch.clockPhase = null;
  if (Chart.series) mountChart();
  renderRoute();
}
var activeActEl = null;
document.addEventListener('click', function (ev) {
  var navLink = ev.target.closest('#nav a'), more = document.getElementById('navMore');
  if (navLink && navLink.getAttribute('href') === '#dashboard') { ui.phoneView = 'home'; applyPhoneView(); }
  if (more && more.open && (navLink || !ev.target.closest('#navMore'))) more.open = false;
  var el = ev.target.closest('[data-act]');
  activeActEl = el;
  if (!el || el.tagName === 'INPUT') return;
  var fn = actions[el.dataset.act];
  if (fn) { if (el.tagName === 'BUTTON' && el.type !== 'submit') ev.preventDefault(); fn(el.dataset, el, ev); }
});
document.addEventListener('change', function (ev) {
  if (ev.target.id === 'tkOrder') { ui.orderType = ev.target.value; renderRoute(); return; }
  var el = ev.target;
  if (el.id === 'acctSel') return setAccount(el.value);
  if (el.id === 'jAcct') { ui.journalAcct = el.value; return renderRoute(); }
  if (el.id === 'jStatus') { ui.journalStatus = el.value; ui.confirm = null; return renderRoute(); }
  if (el.dataset.tmenu) { var tv = el.value; el.value = ''; if (tv) ui.confirm = { kind: tv === 'archive' ? 'archiveTrade' : 'delTrade', id: el.dataset.tmenu }; return renderRoute(); }
  if (el.id === 'tkTarget') { ui.addTarget = el.value; return renderRoute(); }
  if (el.id === 'tkSym' || el.id === 'chartSym') { ui.sym = el.value; return renderRoute(); }
  if (el.id === 'labSym') { ui.labSym = el.value; ensureCandles(el.value); return renderRoute(); }
  if (el.dataset.pair) return togglePair(el.dataset.pair, el.checked);
  if (el.dataset.shot && el.files && el.files.length) return uploadShots(el.dataset.id, el.dataset.shot, el.files);
  if (el.id === 'restoreFile' && el.files && el.files[0]) {
    var file = el.files[0], rd = new FileReader();
    rd.onload = function () { ui.confirm = { kind: 'restore', name: file.name, text: String(rd.result) }; renderRoute(); };
    rd.readAsText(file); return;
  }
  if (el.id === 'feedRefresh') return saveFeed({ refreshSec: Number(el.value) });
  if (el.dataset.cgsym) { var ids = Object.assign({}, feedSettings().ids); var v = el.value.trim().toLowerCase(); if (v) ids[el.dataset.cgsym] = v; else delete ids[el.dataset.cgsym]; toast(v ? el.dataset.cgsym + ' → ' + v : el.dataset.cgsym + ' back to the built-in id', 'good'); return saveFeed({ ids: ids }); }
  if (el.id === 'rsiTog') return setMeta('settings', Object.assign({}, Store.meta.settings, { rsiAlerts: el.checked }));
  if (el.dataset.social) {
    var s = byId('socials', el.dataset.social); if (!s) return;
    var patch = {}; patch[el.dataset.field] = el.type === 'checkbox' ? el.checked : Number(el.value);
    return put('socials', Object.assign({}, s, patch));
  }
  if (el.closest('#ticket')) renderTicketPreview();
});
document.addEventListener('input', function (ev) {
  if (['tkRisk', 'tkSize', 'tkSL', 'tkPrice'].indexOf(ev.target.id) >= 0) syncRiskSize(ev.target.id);
  if (ev.target.closest('#ticket')) renderTicketPreview();
  if (ev.target.id === 'closePrice' || ev.target.id === 'closeFee') {
    var closing = ui.confirm && byId('trades', ui.confirm.id);
    if (closing) setHTML('closeEst', closeEstHTML(closing), true);
  }
  updateLevelHints();
  if (ev.target.id === 'feedSearch') { ui.feedQ = ev.target.value; setHTML('feedTable', feedRowsHTML(), true); }
  if (ev.target.id === 'pairSearch') { ui.pairQ = ev.target.value; setHTML('pairTable', pairTableHTML(), true); }
});
document.addEventListener('submit', function (ev) {
  var f = ev.target; ev.preventDefault();
  if (f.id === 'ticket') return submitTicket();
  if (f.id === 'levelForm') {
    var p = Number(document.getElementById('lvlPrice').value);
    if (!p) return toast('Enter a price for the alert.', 'warn');
    put('levels', { id: uid('lvl'), symbol: ui.sym, price: p, note: document.getElementById('lvlNote').value.trim(), active: true, createdAt: appNow() });
    document.getElementById('lvlPrice').value = ''; document.getElementById('lvlNote').value = '';
    return toast('Alert set: ' + ui.sym + ' at ' + px(ui.sym, p), 'good');
  }
  if (f.id === 'closeForm') {
    var ct = byId('trades', f.dataset.id), cp = Number(document.getElementById('closePrice').value);
    if (!(cp > 0)) return toast('Enter the exit price from Bitfunded.', 'warn');
    var cfRaw = document.getElementById('closeFee').value, cf = cfRaw === '' ? null : Number(cfRaw);
    if (cf != null && !(cf >= 0)) return toast('Fees should be zero or more.', 'warn');
    ui.confirm = null;
    if (ct && ct.status === 'open') closeTrade(ct, cp, 'Manual', cf); else toast('That position is already closed.', 'warn');
    return renderRoute();
  }
  if (f.id === 'fixForm') {
    var ft = byId('trades', f.dataset.id); if (!ft) return;
    var fixed = fixFromForm(ft);
    if (fixed.error) return toast(fixed.error, 'warn');
    ui.fixId = null;
    put('trades', fixed.trade);
    toast(ft.status === 'closed' ? 'Trade saved. P/L, balance and limits are updated.' : fixed.trade.status === 'closed' ? 'Position closed and saved. P/L, balance and limits are updated.' : 'Trade saved. The position is still open.', 'good');
    return renderRoute();
  }
  if (f.id === 'slForm') {
    var t = byId('trades', f.dataset.id); if (!t) return;
    var sl = levelPriceOf('slEdit'), tp = levelPriceOf('tpEdit');
    sl = sl === '' ? null : Number(sl); tp = tp === '' ? null : Number(tp);
    var slBad = levelProblem(t.side, sl, tp, Sim.prices[t.symbol]);
    if (slBad) return toast(slBad, 'warn');
    ui.editId = null;
    return put('trades', Object.assign({}, t, { sl: sl, tp: tp }));
  }
  if (f.id === 'myReview') {
    var tr = byId('trades', f.dataset.id); if (!tr) return;
    return put('trades', Object.assign({}, tr, { myReview: { wentWell: document.getElementById('mrWell').value.trim(), wentWrong: document.getElementById('mrWrong').value.trim(), followedPlan: document.getElementById('mrPlan').value, score: Number(document.getElementById('mrScore').value), submittedAt: appNow() } }));
  }
  if (f.id === 'chatForm') { var inp = document.getElementById('chatIn'); var q = inp.value; inp.value = ''; return sendChat(q); }
  if (f.id === 'addAcc') return submitAccount();
  if (f.id === 'socialForm') return submitSocial();
  if (f.id === 'pairForm') return;
});
function submitTicket() {
  var acc = currentAccount(), tk = readTicket(), pre = ticketPreview(acc, tk);
  if (!pre) return toast(tk.orderType !== 'Market' && !(Number(tk.limitPrice) > 0) ? 'Enter a price.' : 'Enter a position size.', 'warn');
  if (pre.blocked) return toast('Paused: this trade would go past a Bitfunded rule.', 'warn');
  if (tk.mode === 'add' && !tk.target) return;
  var fp = pre.fill;
  if (!fp.now) placeLimit(acc, tk, fp.price);
  else if (tk.mode === 'add') addToTrade(tk.target, tk, fp.price, fp.how);
  else openTrade(acc, tk, fp.price, fp.how);
  ui.sizeFrom = 'size';
  ['tkRisk', 'tkSize', 'tkSL', 'tkTP', 'tkReason', 'tkPrice', 'tkFee'].forEach(function (id) { var el = document.getElementById(id); if (el) el.value = ''; });
  ['ckPlaybook', 'ckSltp', 'ckRisk', 'ckRoom', 'ckCool'].forEach(function (id) { var el = document.getElementById(id); if (el) el.checked = false; });
  ui.coach = null;
}
function submitAccount() {
  var g = function (id) { return document.getElementById(id); };
  var editId = g('addAcc').dataset.id, old = editId ? byId('accounts', editId) : null;
  var num = function (id) { var x = g(id); return x && x.value !== '' ? Number(x.value) : null; };
  var fail = function (text) { ui.accMsg = text; g('naMsg').innerHTML = '<div class="banner breach small">' + esc(text) + '</div>'; };
  var draft = { program: g('naProg').value, size: Number(g('naSize').value), stage: g('naStage').value, paper: old ? !!old.paper : g('naPaper').checked, status: old ? g('naStatus').value : 'active' };
  if (draft.status === 'active') {
    var chk = R.canAddChallenge(Store.data.accounts.filter(function (x) { return !old || x.id !== old.id; }), draft);
    if (!chk.ok) return fail(chk.reason);
  }
  var now = appNow();
  var startedAt = dateMs(g('naStart').value, old ? old.startedAt : now);
  var stageStartedAt = dateMs(g('naStageStart').value, old ? old.stageStartedAt : now);
  if (startedAt > now + DAY || stageStartedAt > now + DAY) return fail('Dates can\u2019t be in the future.');
  if (stageStartedAt < startedAt - DAY) return fail('The current stage can\u2019t start before the challenge did.');
  var balance = num('naBalance'), dayLoss = num('naDayLoss'), qual = num('naQual'), lev = num('naLev');
  if (balance != null && (balance <= 0 || balance > draft.size * 3)) return fail('That balance looks wrong for a ' + R.fmtSize(draft.size) + ' account. Enter the balance from your Bitfunded dashboard in dollars.');
  if (dayLoss != null && dayLoss < 0) return fail('Enter today\u2019s losses as a positive number.');
  if (lev != null && (lev < 1 || lev > 100)) return fail('Max leverage should be between 1 and 100.');
  var a = Object.assign({}, old || { id: uid('acc'), outcome: 'In progress', rulesVersion: R.PROGRAMS[draft.program].version }, {
    name: g('naName').value.trim() || (old ? old.name : (draft.paper ? 'Paper · ' : '#' + (Store.data.accounts.filter(function (x) { return !x.paper; }).length) + ' · ') + R.fmtSize(draft.size)),
    bitfundedId: g('naId').value.trim(), program: draft.program, size: draft.size, stage: draft.stage, paper: draft.paper, status: draft.status,
    fee: num('naFee') || 0, maxLeverage: lev || R.PROGRAMS[draft.program].maxLeverage, startedAt: startedAt, stageStartedAt: stageStartedAt
  });
  if (old && old.program !== a.program) a.rulesVersion = R.PROGRAMS[a.program].version;
  if (old && old.status !== a.status) a.outcome = a.status === 'failed' ? 'Failed' : a.status === 'passed' ? 'Passed' : 'In progress';
  if (balance != null) {
    a.priorPnl = R.baselineFromBalance(a, Store.data.trades, balance).priorPnl;
    a.balanceSync = { balance: balance, at: now };
  }
  a.priorDayLoss = dayLoss ? { day: R.dayBounds(now).start, amount: dayLoss } : null;
  a.priorQualifying = qual || 0;
  ui.accMsg = ''; ui.editAcc = null;
  put('accounts', a);
  toast((old ? 'Saved ' : 'Added ') + a.name + '.' + (balance != null ? ' Gauges now start from a ' + money(balance, 2) + ' balance.' : ''), 'good');
}
function submitSocial() {
  var g = function (id) { return document.getElementById(id); };
  var handles = (g('soHandle').value + '\n' + g('soBulk').value).split(/[\n,\s]+/).map(function (h) { h = h.trim(); return h ? (h[0] === '@' ? h : '@' + h) : ''; }).filter(Boolean);
  var existing = Store.data.socials.map(function (s) { return s.handle.toLowerCase(); });
  var valid = function (h) { return /^@[A-Za-z0-9_]{1,15}$/.test(h); };
  var bad = handles.filter(function (h) { return !valid(h); });
  var fresh = handles.filter(function (h, i) { return handles.indexOf(h) === i && existing.indexOf(h.toLowerCase()) < 0 && valid(h); });
  ui.socialMsg = bad.length ? 'Skipped ' + bad.join(', ') + ': not a valid X handle (letters, numbers, underscore; up to 15 characters).' : !fresh.length ? 'Those accounts are already in the table.' : '';
  g('soMsg').innerHTML = ui.socialMsg ? '<div class="banner warn small">' + esc(ui.socialMsg) + '</div>' : '';
  if (!fresh.length) return;
  fresh.forEach(function (h) { put('socials', { id: uid('soc'), handle: h, name: '', tag: g('soTag').value, trust: Number(g('soTrust').value), notes: g('soNotes').value.trim(), active: true, createdAt: appNow() }); });
  ['soHandle', 'soBulk', 'soNotes'].forEach(function (id) { g(id).value = ''; });
  toast('Added ' + fresh.length + ' account' + (fresh.length > 1 ? 's' : '') + '.', 'good');
}

/* ---------- data seeding / reset ---------- */
function loadSample() {
  var s = window.makeSample(appNow(), Sim.prices);
  s.accounts.forEach(function (a) { put('accounts', a); });
  s.trades.forEach(function (t) { put('trades', t); });
  s.levels.forEach(function (l) { put('levels', l); });
  s.socials.forEach(function (x) { put('socials', x); });
  setMeta('feed', { items: s.feed });
  ui.acctId = 'acc-2'; lsSet('cockpit-acct', 'acc-2');
  Watch.init = false; Watch.levels = {}; Watch.flags = {}; Watch.cross = {};
  toast('Sample test data loaded.', 'good');
}
function resetData() {
  var all = [];
  COLLS.forEach(function (c) { Store.data[c].slice().forEach(function (x) { all.push(remove(c, x.id)); }); });
  setMeta('feed', { items: [] });
  Promise.all(all).then(function () { loadSample(); });
}

/* ---------- boot ---------- */
var booted = false;
function boot2() {
  if (booted) return; booted = true;
  simInit();
  if (!byId('accounts', ui.acctId)) ui.acctId = (activeAccounts()[0] || {}).id || null;
  focusOpenPosition();
  renderTopbar(); renderRoute();
  setInterval(function () {
    simTick(); runChecks(); updateChartPrice(); renderLive();
  }, 1000);
  setInterval(function () { if (Store.mode === 'db') Store.db.doc('meta/prices').set({ p: clone(Sim.prices), at: Date.now() }).catch(function () {}); else lsSet('cockpit-prices', Sim.prices); }, 30000);
  getSample();
}
document.addEventListener('paste', function (ev) {
  var r = route();
  if (Store.mode !== 'server' || r.indexOf('t-') !== 0) return;
  var t = byId('trades', r.slice(2)), items = (ev.clipboardData && ev.clipboardData.files) || [];
  var imgs = Array.prototype.filter.call(items, function (f) { return /^image\//.test(f.type); });
  if (!t || !imgs.length) return;
  ev.preventDefault();
  uploadShots(t.id, t.status === 'open' ? 'before' : 'after', imgs);   // open trades are still "before"; closed trades are "after"
});
window.addEventListener('hashchange', function () { ui.confirm = null; ui.socialMsg = ''; ui.accMsg = ''; ui.pairMsg = ''; ui.editAcc = null; renderTopbar(); renderRoute(); window.scrollTo(0, 0); });
if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { if (Chart.chart) mountChart(); });
initStore();
