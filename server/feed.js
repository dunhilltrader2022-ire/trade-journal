'use strict';
/* Price feed: a live public exchange stream for crypto, simulated prices for anything the stream
 * doesn't carry (gold, silver, TSLA, unknown coins). Keeps 1-minute candles per pair. */
const R = require('./lib/rules.js');

const MIN = 60000;
const STALE_MS = 30000;

function gauss() { const u = 1 - Math.random(), v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

const TF_SECONDS = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
function aggregateCandles(bars, sec) {
  const out = [];
  for (const b of bars) {
    const t = Math.floor(b.time / sec) * sec, l = out[out.length - 1];
    if (l && l.time === t) { l.high = Math.max(l.high, b.high); l.low = Math.min(l.low, b.low); l.close = b.close; }
    else out.push({ time: t, open: b.open, high: b.high, low: b.low, close: b.close });
  }
  return out;
}

class Feed {
  constructor(opts) {
    this.opts = Object.assign({
      binanceWs: 'wss://data-stream.binance.vision/ws/!miniTicker@arr',
      binanceRest: 'https://data-api.binance.vision',
      krakenWs: 'wss://ws.kraken.com/v2'
    }, Object.fromEntries(Object.entries(opts || {}).filter(([, v]) => v != null && v !== '')));
    this.prices = {};      // sym -> number
    this.src = {};         // sym -> 'live' | 'sim'
    this.lastLive = {};    // sym -> ms
    this.candles = {};     // sym -> [{time, open, high, low, close}]
    this.tfCache = {};     // 'source|sym|tf' -> { at, candles }, longer timeframes from the exchange
    this.source = 'simulated';
    this.status = { state: 'off', since: Date.now(), lastMessageAt: null, error: null };
    this.ws = null;
    this.retry = 0;
    this.symbols = [];
    this.backfilled = {};
    this.listeners = new Set();
    this.timer = setInterval(() => this.tick(), 1000);
  }

  setSymbols(list, saved) {
    this.symbols = Array.from(new Set(list));
    for (const s of this.symbols) {
      if (this.prices[s] == null) this.prices[s] = Number(saved && saved[s]) || R.assetInfo(s).start;
      if (!this.src[s]) this.src[s] = 'sim';
    }
    if (this.source === 'kraken' && this.ws && this.ws.readyState === 1) this.krakenSubscribe();
  }

  setSource(source) {
    if (source === this.source && this.ws) return;
    this.source = source;
    this.close();
    this.retry = 0;
    for (const s of Object.keys(this.src)) this.src[s] = 'sim';
    this.backfilled = {};
    if (source === 'binance' || source === 'kraken') this.connect();
    else this.status = { state: 'off', since: Date.now(), lastMessageAt: null, error: null };
  }

  close() {
    if (this.ws) { try { this.ws.onclose = null; this.ws.close(); } catch (e) { /* closed */ } }
    this.ws = null;
    clearTimeout(this.reconnectTimer);
  }

  connect() {
    const url = this.source === 'binance' ? this.opts.binanceWs : this.opts.krakenWs;
    this.status = { state: 'connecting', since: Date.now(), lastMessageAt: this.status.lastMessageAt, error: null };
    let ws;
    try { ws = new WebSocket(url); } catch (e) { this.fail(e.message); return; }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.status.state = 'connected'; this.status.since = Date.now();
      if (this.source === 'kraken') this.krakenSubscribe();
    };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch (e) { return; }
      this.status.lastMessageAt = Date.now();
      if (this.source === 'binance') this.onBinance(msg); else this.onKraken(msg);
    };
    ws.onerror = () => { this.status.error = 'Connection error'; };
    ws.onclose = () => { this.ws = null; this.fail(this.status.error || 'Connection closed'); };
  }

  fail(reason) {
    this.status = { state: 'reconnecting', since: Date.now(), lastMessageAt: this.status.lastMessageAt, error: reason };
    const delay = Math.min(60000, 1000 * Math.pow(2, this.retry++));
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => { if (this.source === 'binance' || this.source === 'kraken') this.connect(); }, delay);
  }

  /* Map an exchange quote to our pairs. Scaled pairs (1000PEPE) multiply the underlying price. */
  applyQuote(base, price, now) {
    if (!(price > 0)) return;
    for (const s of this.symbols) {
      const a = R.assetInfo(s);
      if (a.cls === 'traditional') continue;
      const m = a.base.match(/^(1000+)(.+)$/);
      const under = m ? m[2] : a.base, mult = m ? Number(m[1]) : 1;
      if (under === base) this.setLive(s, price * mult, now);
    }
  }

  setLive(sym, price, now) {
    this.prices[sym] = price;
    this.src[sym] = 'live';
    this.lastLive[sym] = now;
    this.pushCandle(sym, price, now);
  }

  onBinance(msg) {
    const arr = Array.isArray(msg) ? msg : msg && Array.isArray(msg.data) ? msg.data : null;
    if (!arr) return;
    const now = Date.now();
    for (const t of arr) {
      if (!t || typeof t.s !== 'string' || !t.s.endsWith('USDT')) continue;
      this.applyQuote(t.s.slice(0, -4), Number(t.c), now);
    }
  }

  krakenSubscribe() {
    const pairs = this.symbols.filter(s => R.assetInfo(s).cls !== 'traditional').map(s => R.assetInfo(s).base.replace(/^1000+/, '') + '/USD');
    const uniq = Array.from(new Set(pairs));
    for (let i = 0; i < uniq.length; i += 50) {
      try { this.ws.send(JSON.stringify({ method: 'subscribe', params: { channel: 'ticker', symbol: uniq.slice(i, i + 50) } })); } catch (e) { /* closed */ }
    }
  }

  onKraken(msg) {
    if (!msg || msg.channel !== 'ticker' || !Array.isArray(msg.data)) return;
    const now = Date.now();
    for (const t of msg.data) {
      if (!t || typeof t.symbol !== 'string') continue;
      const [base, quote] = t.symbol.split('/');
      if (quote !== 'USD' && quote !== 'USDT') continue;
      this.applyQuote(base === 'XBT' ? 'BTC' : base, Number(t.last), now);
    }
  }

  pushCandle(sym, price, now) {
    const t = Math.floor(now / MIN) * 60;
    let arr = this.candles[sym];
    if (!arr) arr = this.candles[sym] = [];
    const last = arr[arr.length - 1];
    if (last && last.time === t) { last.close = price; if (price > last.high) last.high = price; if (price < last.low) last.low = price; }
    else if (!last || t > last.time) { arr.push({ time: t, open: last ? last.close : price, high: price, low: price, close: price }); if (arr.length > 720) arr.shift(); }
  }

  /* Every second: walk simulated prices; mark live pairs stale after 30 s without a quote. */
  tick() {
    const now = Date.now();
    for (const s of this.symbols) {
      const live = this.src[s] === 'live' && now - (this.lastLive[s] || 0) < STALE_MS;
      if (!live) {
        if (this.src[s] === 'live') this.src[s] = 'stale';
        if (this.source === 'simulated' || this.src[s] === 'sim') {
          this.src[s] = 'sim';
          this.prices[s] = this.prices[s] * (1 + gauss() * R.assetInfo(s).vol);
          if (this.candles[s]) this.pushCandle(s, this.prices[s], now);
        }
      }
    }
    if (this.source !== 'simulated' && this.status.lastMessageAt && now - this.status.lastMessageAt > STALE_MS && this.status.state === 'connected') this.status.state = 'stale';
    for (const fn of this.listeners) { try { fn(); } catch (e) { /* listener error */ } }
  }

  /* Simulated pairs only: move the price (Test lab). */
  move(sym, opts) {
    if (this.src[sym] === 'live') return false;
    if (this.prices[sym] == null) this.prices[sym] = R.assetInfo(sym).start;
    this.prices[sym] = opts.price > 0 ? opts.price : this.prices[sym] * (1 + (Number(opts.pct) || 0) / 100);
    this.src[sym] = 'sim';
    this.pushCandle(sym, this.prices[sym], Date.now());
    return true;
  }

  /* Candle history: Binance klines when available, otherwise a simulated history. */
  async history(sym) {
    const a = R.assetInfo(sym);
    if (!this.backfilled[sym] && this.source === 'binance' && a.cls !== 'traditional') {
      this.backfilled[sym] = true;
      try {
        const hist = await this.fetchKlines(sym, '1m', 300);
        if (hist) {
          const cur = this.candles[sym] || [];
          const lastHist = hist.length ? hist[hist.length - 1].time : 0;
          this.candles[sym] = hist.concat(cur.filter(c => c.time > lastHist));
          if (!this.prices[sym] || this.src[sym] !== 'live') { const lc = hist[hist.length - 1]; if (lc) this.prices[sym] = lc.close; }
        }
      } catch (e) { /* no history: build from live ticks */ }
    }
    if (!this.candles[sym] || this.candles[sym].length < 2) {
      if (this.src[sym] === 'live') return this.candles[sym] || [];
      this.candles[sym] = this.simHistory(sym);
    }
    return this.candles[sym];
  }

  async fetchKlines(sym, interval, limit) {
    const a = R.assetInfo(sym);
    const m = a.base.match(/^(1000+)(.+)$/), under = m ? m[2] : a.base, mult = m ? Number(m[1]) : 1;
    const r = await fetch(this.opts.binanceRest + '/api/v3/klines?symbol=' + encodeURIComponent(under + 'USDT') + '&interval=' + interval + '&limit=' + limit, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const rows = await r.json();
    return rows.map(k => ({ time: Math.floor(k[0] / 1000), open: k[1] * mult, high: k[2] * mult, low: k[3] * mult, close: k[4] * mult }));
  }

  isTimeframe(tf) { return Object.prototype.hasOwnProperty.call(TF_SECONDS, tf); }

  /* Longer timeframes: the exchange's own candles when it has them, otherwise built from the 1-minute history. */
  async historyTf(sym, tf) {
    const key = this.source + '|' + sym + '|' + tf, hit = this.tfCache[key];
    if (hit && Date.now() - hit.at < 30000) return { history: 'exchange', candles: hit.candles };
    if (this.source === 'binance' && R.assetInfo(sym).cls !== 'traditional') {
      try {
        const candles = await this.fetchKlines(sym, tf, 500);
        if (candles && candles.length) { this.tfCache[key] = { at: Date.now(), candles }; return { history: 'exchange', candles }; }
      } catch (e) { /* fall back to what we hold */ }
    }
    return { history: 'built', candles: aggregateCandles(await this.history(sym), TF_SECONDS[tf]) };
  }

  simHistory(sym) {
    let p = this.prices[sym] || R.assetInfo(sym).start;
    const vol = R.assetInfo(sym).vol, m0 = Math.floor(Date.now() / MIN) * 60, out = [];
    for (let i = 0; i < 300; i++) {
      const close = p, steps = [p];
      for (let k = 0; k < 6; k++) { p = p / (1 + gauss() * vol * 2.4); steps.push(p); }
      out.push({ time: m0 - i * 60, open: p, high: Math.max(...steps), low: Math.min(...steps), close });
    }
    return out.reverse();
  }

  snapshot() {
    const now = Date.now();
    return {
      prices: this.prices, src: this.src, source: this.source,
      status: Object.assign({}, this.status, { lastMessageAgoMs: this.status.lastMessageAt ? now - this.status.lastMessageAt : null })
    };
  }
}

module.exports = { Feed };
