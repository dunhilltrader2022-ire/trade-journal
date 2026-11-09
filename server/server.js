'use strict';
/* Bitfunded Trading Cockpit server: serves the page, stores data in SQLite, streams live prices,
 * and calls Claude with the key from .env. No npm dependencies. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const R = require('./lib/rules.js');
const store = require('./db.js');
const { buildXlsx } = require('./xlsx');
const { validateDoc, validateDump } = require('./validate');
const { Feed } = require('./feed.js');
const ai = require('./ai.js');
const { createMonitor } = require('./monitor.js');
const { createNotifier } = require('./telegram.js');
const { createBot } = require('./botcmds.js');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SEED = process.env.SEED_FILE || path.join(__dirname, 'seed', 'initial-data.json');
const WRITABLE = ['accounts', 'trades', 'levels', 'socials', 'orders', 'drawings', 'archive', 'meta'];

const db = store.open(path.join(DATA_DIR, 'cockpit.db'));
if (db.isEmpty() && fs.existsSync(SEED)) {
  db.importAll(JSON.parse(fs.readFileSync(SEED, 'utf8')));
  console.log('Imported your test data from', path.basename(SEED));
}

const feed = new Feed({
  binanceWs: process.env.BINANCE_WS_URL || undefined,
  binanceRest: process.env.BINANCE_REST_URL || undefined,
  krakenWs: process.env.KRAKEN_WS_URL || undefined
});

/* Pairs and feed source come from the saved settings. */
function settings() { return db.get('meta', 'settings') || {}; }
function syncFeed() {
  const st = settings();
  const pairs = st.pairs || {};
  if (pairs.custom) for (const [s, p] of Object.entries(pairs.custom)) R.addPair(s, Number(p) || 0);
  for (const t of db.list('trades')) if (!R.ASSETS[t.symbol]) R.addPair(t.symbol, t.fills && t.fills[0] ? t.fills[0].price : 0);
  let list = pairs.enabled && pairs.enabled.length ? pairs.enabled.slice() : Object.keys(R.ASSETS);
  for (const t of db.list('trades')) if (t.status === 'open' && !list.includes(t.symbol)) list.push(t.symbol);
  for (const o of db.list('orders')) if (o.status === 'working' && !list.includes(o.symbol)) list.push(o.symbol);
  for (const l of db.list('levels')) if (l.active && !list.includes(l.symbol)) list.push(l.symbol);   // a price alert needs its pair's price
  const saved = (db.get('meta', 'prices') || {}).p || {};
  feed.setSymbols(list, saved);
  const src = (st.feed && st.feed.source) || process.env.PRICE_SOURCE || 'binance';
  feed.setSource(['binance', 'kraken', 'simulated'].includes(src) ? src : 'binance');
}
syncFeed();
setInterval(() => db.put('meta', 'prices', { p: feed.prices, at: Date.now() }), 30000);

/* Live updates to open pages (Server-Sent Events). */
const clients = new Set();
function broadcast(event, data) {
  const line = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const res of clients) { try { res.write(line); } catch (e) { clients.delete(res); } }
}
feed.listeners.add(() => broadcast('prices', feed.snapshot()));

/* The safety loop runs here on every tick, whether or not a page is open. */
const notifier = createNotifier({ token: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID, lanes: process.env.TELEGRAM_LANES, apiUrl: process.env.TELEGRAM_API_URL,
  quietUntil: () => (db.get('meta', 'botstate') || {}).quietUntil });
const monitor = createMonitor({ db, feed, broadcast, notify: a => notifier.notify(a) });
const bot = createBot({ db, feed, notifier, token: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID, apiUrl: process.env.TELEGRAM_API_URL,
  now: () => Date.now() + (Number(settings().offsetMs) || 0), broadcast, syncFeed });
bot.start();
feed.listeners.add(() => monitor.tick());
setInterval(() => { for (const res of clients) { try { res.write(': ping\n\n'); } catch (e) { clients.delete(res); } } }, 20000);

function send(res, code, body, headers) {
  const isStr = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(code, Object.assign({ 'content-type': isStr ? 'text/plain; charset=utf-8' : 'application/json', 'cache-control': 'no-store' }, headers || {}));
  res.end(isStr ? body : JSON.stringify(body));
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > (limit || 2e6)) { reject(new Error('too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Error('bad_json')); } });
    req.on('error', reject);
  });
}
const validId = id => /^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(id);

/* Trade screenshots: files in the data volume, listed on the trade as shots.before / shots.after.
 * The type comes from the file's own bytes, and the server picks the filename. */
const SHOTS_DIR = path.join(DATA_DIR, 'shots');
const SHOT_MAX_BYTES = 10 * 1024 * 1024;
const SHOT_MAX_PER_KIND = 6;
const SHOT_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
function imageExt(b) {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const shotTradeId = id => /^[A-Za-z0-9_-]{1,100}$/.test(id);
function saveTrade(trade) {
  db.put('trades', trade.id, trade);
  broadcast('change', { coll: 'trades', id: trade.id, doc: trade, origin: 'server' });
}

/* Browser login for LAN access. COCKPIT_AUTH_REQUIRED stops the site opening at all if the password is missing. */
const PASSWORD = process.env.COCKPIT_PASSWORD || '';
const AUTH_REQUIRED = process.env.COCKPIT_AUTH_REQUIRED === '1';
const sha = s => crypto.createHash('sha256').update(s).digest();
function passwordOk(req) {
  const m = /^Basic (.+)$/i.exec(req.headers.authorization || '');
  if (!m) return false;
  const pair = Buffer.from(m[1], 'base64').toString('utf8');
  return crypto.timingSafeEqual(sha(pair.slice(pair.indexOf(':') + 1)), sha(PASSWORD));
}

/* Your browser sends the saved password to this site even when another website asks it to, so changes must come from the cockpit's own page. */
function fromAnotherSite(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return true;
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host !== req.headers.host; } catch (e) { return true; }
}

const TRADE_COLUMNS = ['id', 'account', 'type', 'stage', 'symbol', 'side', 'status', 'opened', 'closed', 'fills', 'avg_entry', 'size', 'stop_loss', 'take_profit', 'exit_price', 'exit_reason', 'pnl', 'r_multiple', 'fees', 'setup', 'idea_source', 'mood', 'reason', 'my_score', 'claude_grades', 'verified'];
function tradeRows(filter) {
  const accs = Object.fromEntries(db.list('accounts').map(a => [a.id, a]));
  const f = filter || {};
  return db.list('trades').filter(t => {
    const a = accs[t.accountId];
    if (f.status && f.status !== 'all' && t.status !== f.status) return false;
    if (f.account && f.account !== 'all' && t.accountId !== f.account) return false;
    if (f.type && f.type !== 'All' && (!a || R.accountType(a) !== f.type)) return false;
    return true;
  }).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).map(t => {
    const a = accs[t.accountId] || {}, s = R.summarize(t), r = t.exit ? R.rMultiple(t) : null;
    return [t.id, a.name, a.id ? R.accountType(a) : '', a.stage, t.symbol, t.side, t.status, s.openedAt ? new Date(s.openedAt) : '', t.exit ? new Date(t.exit.t) : '',
      (t.fills || []).length, s.avgEntry, s.size, t.sl, t.tp, t.exit ? t.exit.price : '', t.exit ? t.exit.reason : '', t.exit ? Number(R.realized(t).toFixed(2)) : '', r == null ? '' : Number(r.toFixed(2)), t.fees,
      t.setup, t.ideaSource, t.mood, t.reason, t.myReview ? t.myReview.score : '', (t.reviews || []).map(v => v.result && v.result.processGrade).join(' '), t.verified ? 'yes' : 'no'];
  });
}
function csvTrades(filter) {
  const q = v => {
    if (v instanceof Date) return v.toISOString();
    let s = v == null ? '' : String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;   // spreadsheets would run these as formulas
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [TRADE_COLUMNS.join(',')].concat(tradeRows(filter).map(r => r.map(q).join(','))).join('\n') + '\n';
}
function xlsxTrades(filter) {
  const titles = TRADE_COLUMNS.map(c => ({ opened: 'Opened (UTC)', closed: 'Closed (UTC)', pnl: 'P/L ($)', fees: 'Total fees ($)', r_multiple: 'R', id: 'ID' }[c] || c.charAt(0).toUpperCase() + c.slice(1).replace(/_/g, ' ')));
  return buildXlsx('Trades', titles, tradeRows(filter));
}
const exportFilter = url => ({ type: url.searchParams.get('type'), account: url.searchParams.get('account'), status: url.searchParams.get('status') });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;
  try {
    if (fromAnotherSite(req)) return send(res, 403, { code: 'other_site', message: 'Changes can only come from the cockpit\u2019s own page.' });
    if (p !== '/api/health') {
      if (!PASSWORD && AUTH_REQUIRED) return send(res, 503, 'Set COCKPIT_PASSWORD in .env, then run: docker compose up -d');
      if (PASSWORD && !passwordOk(req)) return send(res, 401, 'Password required', { 'www-authenticate': 'Basic realm="Master Bitfunded", charset="UTF-8"' });
    }
    if (p === '/' || p === '/index.html') {
      return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, 'index.html')), { 'content-type': 'text/html; charset=utf-8' });
    }
    if (p === '/api/health') return send(res, 200, { ok: true, feed: feed.snapshot().status, source: feed.source });
    if (p === '/api/state' && req.method === 'GET') return send(res, 200, Object.assign(db.snapshot(), { server: { version: 1, ai: ai.status(db), notify: notifier.status() } }));
    if (p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      clients.add(res);
      res.write('event: prices\ndata: ' + JSON.stringify(feed.snapshot()) + '\n\n');
      req.on('close', () => clients.delete(res));
      return;
    }
    if (p === '/api/prices') return send(res, 200, feed.snapshot());
    let m = p.match(/^\/api\/doc\/([a-z]+)\/([^/]+)$/);
    if (m) {
      const coll = m[1], id = decodeURIComponent(m[2]);
      if (!WRITABLE.includes(coll) || !validId(id)) return send(res, 400, { code: 'invalid_argument' });
      const origin = req.headers['x-client-id'] || '';
      if (req.method === 'PUT') {
        const body = await readBody(req, 1e6);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { code: 'invalid_argument' });
        const invalid = validateDoc(coll, body);
        if (invalid) return send(res, 400, { code: 'invalid_record', message: invalid });
        /* A page that hasn't caught up yet must not undo what the safety loop just did. */
        if (coll === 'trades' && db.get('archive', id)) return send(res, 409, { code: 'archived', message: 'This trade was archived. Restore it from the journal first.' });
        const existing = coll === 'trades' || coll === 'orders' ? db.get(coll, id) : null;
        if (existing && ((coll === 'trades' && existing.status === 'closed' && body.status === 'open') || (coll === 'orders' && existing.status !== 'working' && body.status === 'working'))) {
          broadcast('change', { coll, id, doc: Object.assign({}, existing, { id }), origin: 'server' });
          return send(res, 409, { code: 'already_done', message: 'The server already closed this.' });
        }
        if (coll === 'trades') { delete body.shots; if (existing && existing.shots) body.shots = existing.shots; }   // only the screenshot routes change these
        db.put(coll, id, body);
        broadcast('change', { coll, id, doc: Object.assign({}, body, { id }), origin });
        if (coll === 'meta' && id === 'settings' || coll === 'trades' || coll === 'orders') syncFeed();
        return send(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') {
        db.del(coll, id);
        if ((coll === 'trades' && !db.get('archive', id) || coll === 'archive' && !db.get('trades', id)) && shotTradeId(id)) fs.rmSync(path.join(SHOTS_DIR, id), { recursive: true, force: true });
        broadcast('change', { coll, id, doc: null, origin });
        return send(res, 200, { ok: true });
      }
      return send(res, 405, { code: 'method' });
    }
    /* Archive: an invalid entry leaves the journal, limits, stats, alerts and the safety loop, but can be restored. One step, so it's never in both or neither. */
    m = p.match(/^\/api\/(trades|archive)\/([^/]+)\/(archive|restore)$/);
    if (m && req.method === 'POST' && (m[1] === 'trades') === (m[3] === 'archive')) {
      const id = decodeURIComponent(m[2]);
      if (!validId(id)) return send(res, 400, { code: 'invalid_argument' });
      let doc, out;
      if (m[3] === 'archive') {
        const t = db.get('trades', id);
        if (!t) return send(res, 404, { code: 'not_found', message: 'That trade isn’t in the journal.' });
        doc = { trade: Object.assign(t, { id }), archivedAt: Date.now() };
        out = ['archive', 'trades'];
      } else {
        const a = db.get('archive', id);
        if (!a || !a.trade) return send(res, 404, { code: 'not_found', message: 'That trade isn’t in the archive.' });
        if (db.get('trades', id)) return send(res, 409, { code: 'exists', message: 'A trade with this id is already in the journal.' });
        const bad = validateDoc('trades', a.trade);
        if (bad) return send(res, 400, { code: 'invalid_record', message: bad });
        doc = a.trade;
        out = ['trades', 'archive'];
      }
      db.raw.exec('BEGIN');
      try { db.put(out[0], id, doc); db.del(out[1], id); db.raw.exec('COMMIT'); }
      catch (e) { db.raw.exec('ROLLBACK'); throw e; }
      broadcast('change', { coll: out[0], id, doc: Object.assign({}, doc, { id }), origin: 'server' });
      broadcast('change', { coll: out[1], id, doc: null, origin: 'server' });
      syncFeed();
      return send(res, 200, { ok: true });
    }
    m = p.match(/^\/api\/trades\/([^/]+)\/shots\/(before|after)$/);
    if (m && req.method === 'POST') {
      const id = decodeURIComponent(m[1]), kind = m[2];
      const trade = shotTradeId(id) ? db.get('trades', id) : null;
      if (!trade) return send(res, 404, { code: 'not_found', message: 'That trade isn’t in the journal.' });
      trade.id = id;
      const shots = Object.assign({ before: [], after: [] }, trade.shots);
      if (shots[kind].length >= SHOT_MAX_PER_KIND) return send(res, 409, { code: 'too_many', message: 'That trade already has ' + SHOT_MAX_PER_KIND + ' screenshots here. Delete one first.' });
      let bytes;
      try { bytes = await readRaw(req, SHOT_MAX_BYTES); }
      catch (e) { return send(res, 413, { code: 'too_large', message: 'That image is over 10 MB.' }); }
      const ext = imageExt(bytes);
      if (!ext) return send(res, 415, { code: 'not_an_image', message: 'Use a PNG, JPEG or WebP image.' });
      const shotId = crypto.randomBytes(8).toString('hex') + '.' + ext;
      fs.mkdirSync(path.join(SHOTS_DIR, id), { recursive: true });
      fs.writeFileSync(path.join(SHOTS_DIR, id, shotId), bytes);
      let name = '';
      try { name = decodeURIComponent(String(req.headers['x-file-name'] || '')).slice(0, 120); } catch (e) { /* keep it blank */ }
      shots[kind] = shots[kind].concat([{ id: shotId, name, t: Date.now(), size: bytes.length }]);
      saveTrade(Object.assign(trade, { shots }));
      return send(res, 200, { ok: true, id: shotId });
    }
    m = p.match(/^\/api\/shots\/([^/]+)\/([a-f0-9]{16}\.(png|jpg|webp))$/);
    if (m) {
      const id = decodeURIComponent(m[1]), file = m[2], ext = m[3];
      if (!shotTradeId(id)) return send(res, 400, { code: 'invalid_argument' });
      const full = path.join(SHOTS_DIR, id, file);
      if (req.method === 'GET') {
        if (!fs.existsSync(full)) return send(res, 404, { code: 'not_found' });
        return send(res, 200, fs.readFileSync(full), { 'content-type': SHOT_TYPES[ext], 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" });
      }
      if (req.method === 'DELETE') {
        const trade = db.get('trades', id);
        if (trade && trade.shots) {
          trade.id = id;
          for (const k of ['before', 'after']) trade.shots[k] = (trade.shots[k] || []).filter(s => s.id !== file);
          saveTrade(trade);
        }
        fs.rmSync(full, { force: true });
        return send(res, 200, { ok: true });
      }
      return send(res, 405, { code: 'method' });
    }
    if (p === '/api/notify/status') return send(res, 200, Object.assign(notifier.status(), { commands: bot.status() }));
    if (p === '/api/notify/test' && req.method === 'POST') {
      const r = await notifier.sendTest();
      return send(res, r.ok ? 200 : 502, r.ok ? { ok: true } : { code: 'notify_failed', message: r.error });
    }
    if (p === '/api/candles') {
      const sym = url.searchParams.get('sym') || '';
      const tf = url.searchParams.get('tf') || '1m';
      if (!/^[A-Z0-9]{1,15}\/(USDT|USDC|USD)$/.test(sym) || (tf !== '1m' && !feed.isTimeframe(tf))) return send(res, 400, { code: 'invalid_argument' });
      if (!R.ASSETS[sym]) R.addPair(sym, 0);
      if (!feed.symbols.includes(sym)) feed.setSymbols(feed.symbols.concat([sym]), {});
      if (tf !== '1m') { const h = await feed.historyTf(sym, tf); return send(res, 200, { sym, tf, src: feed.src[sym] || 'sim', history: h.history, candles: h.candles }); }
      return send(res, 200, { sym, tf, src: feed.src[sym] || 'sim', candles: await feed.history(sym) });
    }
    if (p === '/api/sim' && req.method === 'POST') {
      const b = await readBody(req, 1e4);
      const ok = feed.move(String(b.sym || ''), { pct: b.pct, price: Number(b.price) });
      return send(res, ok ? 200 : 409, ok ? { ok: true, price: feed.prices[b.sym] } : { code: 'live', message: 'This pair has live prices. Switch the Data feed to Simulated to move it.' });
    }
    if (p === '/api/ai/status') return send(res, 200, ai.status(db));
    if (p === '/api/ai' && req.method === 'POST') {
      const b = await readBody(req, 7e4);
      const ctl = new AbortController();
      res.on('close', () => { if (!res.writableEnded) ctl.abort(); });
      try { return send(res, 200, await ai.ask(db, b, ctl.signal)); }
      catch (e) { return send(res, e.http || 500, { code: e.code || 'upstream_error', message: e.message }); }
    }
    if (p === '/api/export') {
      const stamp = new Date().toISOString().slice(0, 10);
      return send(res, 200, JSON.stringify(Object.assign(db.snapshot(), { exportedAt: new Date().toISOString(), app: 'bitfunded-cockpit', version: 1 }), null, 1), { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="cockpit-backup-' + stamp + '.json"' });
    }
    if (p === '/api/export/trades.csv') {
      return send(res, 200, csvTrades(exportFilter(url)), { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="cockpit-trades-' + new Date().toISOString().slice(0, 10) + '.csv"' });
    }
    if (p === '/api/export/trades.xlsx') {
      const file = xlsxTrades(exportFilter(url));
      res.writeHead(200, { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-length': file.length, 'content-disposition': 'attachment; filename="cockpit-trades-' + new Date().toISOString().slice(0, 10) + '.xlsx"' });
      return res.end(file);
    }
    if (p === '/api/import' && req.method === 'POST') {
      const b = await readBody(req, 50e6);
      if (!b || !b.data || !Array.isArray(b.data.accounts)) return send(res, 400, { code: 'invalid_argument', message: 'That file isn’t a cockpit backup.' });
      const unsound = validateDump(b);
      if (unsound) return send(res, 400, { code: 'invalid_record', message: 'Nothing was changed. That backup has a broken record: ' + unsound });
      const safety = path.join(DATA_DIR, 'before-restore-' + Date.now() + '.json');
      fs.writeFileSync(safety, JSON.stringify(db.snapshot()));
      db.importAll(b);
      syncFeed();
      monitor.reset();
      broadcast('reload', {});
      return send(res, 200, { ok: true, safetyCopy: path.basename(safety) });
    }
    return send(res, 404, { code: 'not_found' });
  } catch (e) {
    console.error(e);
    return send(res, 500, { code: 'server_error', message: String(e.message || e) });
  }
});

/* Nightly backup inside the data folder, keeping the last 14. */
function nightlyBackup() {
  const dir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'cockpit-' + new Date().toISOString().slice(0, 10) + '.json');
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(db.snapshot()));
  const all = fs.readdirSync(dir).filter(f => f.startsWith('cockpit-')).sort();
  for (const f of all.slice(0, Math.max(0, all.length - 14))) fs.unlinkSync(path.join(dir, f));
}
nightlyBackup();
setInterval(nightlyBackup, 3600000);

/* After an update, reload open pages so no tab keeps running an older version of the page. */
const build = crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'))).digest('hex').slice(0, 16);
if ((db.get('meta', 'build') || {}).hash !== build) {
  db.put('meta', 'build', { hash: build });
  for (const ms of [6000, 20000]) setTimeout(() => broadcast('reload', {}), ms).unref();
}

server.listen(PORT, HOST, () => console.log('Cockpit running on http://localhost:' + server.address().port + ' · prices: ' + feed.source + ' · Claude: ' + (ai.status(db).configured ? 'API key set' : 'no API key') + ' · Telegram: ' + (notifier.enabled ? 'on' + (bot.enabled ? ', commands on' : '') : 'off')));
process.on('SIGTERM', () => { db.put('meta', 'prices', { p: feed.prices, at: Date.now() }); process.exit(0); });
module.exports = { server, feed, db };
