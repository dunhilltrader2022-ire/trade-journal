// Integration test: the real cockpit server against a mock Binance stream, mock Binance REST and mock Claude API.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { WebSocketServer } = require('ws');

const SERVER = path.join(__dirname, '..', '..', 'server', 'server.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const listen = (srv) => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

const klineIntervals = [];
let wss, wsPort, restPort, aiPort, port, proc, dataDir, aiCalls = [], aiMode = 'ok';
const base = () => 'http://127.0.0.1:' + port;
const j = async (p, o) => { const r = await fetch(base() + p, o); return { status: r.status, body: await r.json().catch(() => null), headers: r.headers }; };

function sendTickers(list) { for (const c of wss.clients) c.send(JSON.stringify(list.map(([s, c2]) => ({ e: '24hrMiniTicker', E: Date.now(), s, c: String(c2), o: '1', h: '1', l: '1', v: '1', q: '1' })))); }

async function startServer(extraEnv) {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-'));
  proc = spawn(process.execPath, [SERVER], {
    env: Object.assign({}, process.env, {
      PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir, NODE_NO_WARNINGS: '1',
      BINANCE_WS_URL: 'ws://127.0.0.1:' + wsPort, BINANCE_REST_URL: 'http://127.0.0.1:' + restPort,
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + aiPort, ANTHROPIC_API_KEY: 'test-key', AI_MONTHLY_CAP_USD: '10'
    }, extraEnv || {}), stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  proc.stdout.on('data', d => { out += d; });
  proc.stderr.on('data', d => { out += d; });
  for (let i = 0; i < 100; i++) { const m = out.match(/localhost:(\d+)/); if (m) { port = Number(m[1]); return out; } await sleep(50); }
  throw new Error('server did not start: ' + out);
}

test.before(async () => {
  wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(r => wss.on('listening', r));
  wsPort = wss.address().port;
  const rest = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/v3/klines') {
      klineIntervals.push(u.searchParams.get('interval'));
      const now = Math.floor(Date.now() / 60000) * 60000;
      const rows = []; for (let i = 299; i >= 1; i--) rows.push([now - i * 60000, '100', '101', '99', '100.5', '1', now - i * 60000 + 59999]);
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(rows));
    }
    res.writeHead(404); res.end();
  });
  restPort = await listen(rest);
  const aiSrv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      aiCalls.push({ headers: req.headers, body: JSON.parse(b) });
      if (aiMode === 'fail') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })); }
      const body = JSON.parse(b);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn',
        content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: '{"processGrade":"B","summary":"ok","rubric":[]}' }],
        usage: { input_tokens: 20000, output_tokens: 2000 } }));
    });
  });
  aiPort = await listen(aiSrv);
  const out = await startServer();
  assert.match(out, /Imported your test data/);
});
test.after(() => { proc && proc.kill(); wss && wss.close(); setTimeout(() => process.exit(0), 200); });

test('changes from another website are refused; the page and scripts still work', async () => {
  const before = (await j('/api/state')).body.data.trades.length;
  const wipe = JSON.stringify({ data: { accounts: [], trades: [] }, meta: {} });
  for (const headers of [{ origin: 'https://attacker.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }]) {
    const r = await j('/api/import', { method: 'POST', headers: Object.assign({ 'content-type': 'text/plain' }, headers), body: wipe });
    assert.equal(r.status, 403, JSON.stringify(headers));
    assert.equal((await j('/api/doc/levels/x', { method: 'DELETE', headers })).status, 403);
  }
  assert.equal((await j('/api/state')).body.data.trades.length, before, 'nothing changed');
  const own = await j('/api/doc/levels/own-site', { method: 'PUT', headers: { 'content-type': 'application/json', origin: base() }, body: JSON.stringify({ symbol: 'BTC/USDT', price: 1, active: false }) });
  assert.equal(own.status, 200, 'the cockpit\u2019s own page');
  assert.equal((await j('/api/doc/levels/own-site', { method: 'DELETE' })).status, 200, 'a script with no origin');
});

test('broken records are refused, and a broken backup changes nothing', async () => {
  const put = (coll, id, doc) => j('/api/doc/' + coll + '/' + id, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) });
  const good = { accountId: 'a', symbol: 'BTC/USDT', side: 'Long', status: 'open', sl: 90, tp: 110, fees: 1, fills: [{ t: 1, price: 100, size: 1, lev: 5 }] };
  assert.equal((await put('trades', 'v-ok', good)).status, 200);
  for (const change of [{ fills: undefined }, { fills: [] }, { fills: [{ t: 1, price: 0, size: 1, lev: 5 }] }, { sl: -1.6 }, { tp: 0 }, { side: 'Up' }, { status: 'maybe' }, { symbol: '' }, { status: 'closed' }, { fees: 'lots' }]) {
    const r = await put('trades', 'v-bad', Object.assign({}, good, change));
    assert.equal(r.status, 400, JSON.stringify(change));
    assert.ok(r.body.message);
  }
  const old = Object.assign({}, good, { status: 'closed', sl: -1.6, exit: { t: 2, price: 105, reason: 'Manual' } });
  assert.equal((await put('trades', 'v-old', old)).status, 200, 'an older closed trade with an odd stop can still be saved');
  assert.equal((await put('accounts', 'v-a', { name: 'x', size: 0 })).status, 400);
  assert.equal((await put('orders', 'v-o', { accountId: 'a', symbol: 'BTC/USDT', status: 'working', side: 'Long', price: 0, size: 1, lev: 5 })).status, 400);
  assert.equal((await put('levels', 'v-l', { symbol: 'BTC/USDT', price: -1 })).status, 400);
  const dump = (await j('/api/export')).body;
  const before = dump.data.trades.length;
  dump.data.trades.push({ id: 'v-broken', accountId: 'a', symbol: 'BTC/USDT', side: 'Long', status: 'open' });
  const imp = await j('/api/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(dump) });
  assert.equal(imp.status, 400);
  assert.match(imp.body.message, /Nothing was changed.*v-broken/);
  assert.equal((await j('/api/state')).body.data.trades.length, before, 'the journal is untouched');
  for (const id of ['v-ok', 'v-old']) await j('/api/doc/trades/' + id, { method: 'DELETE' });
});

test('serves the page and the seeded test data', async () => {
  const r = await fetch(base() + '/'); const html = await r.text();
  assert.equal(r.status, 200); assert.match(html, /Master Bitfunded/);
  const st = await j('/api/state');
  assert.equal(st.body.data.accounts.length, 5);
  assert.equal(st.body.data.trades.length, 12);
  assert.equal(st.body.data.socials.length, 5);
  assert.ok(st.body.server.ai.configured);
});

test('live Binance prices replace simulated ones; gold stays simulated; scaled pairs multiply', async () => {
  for (let i = 0; i < 40 && !wss.clients.size; i++) await sleep(50);
  assert.ok(wss.clients.size >= 1, 'server connected to the mock exchange');
  // a pasted scaled pair
  const settings = (await j('/api/state')).body.meta.settings;
  await j('/api/doc/meta/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({}, settings, { pairs: { enabled: null, custom: { '1000PEPE/USDT': 0.01 } } })) });
  await sleep(100);
  sendTickers([['BTCUSDT', 70123.5], ['ETHUSDT', 3500.25], ['PEPEUSDT', 0.0000125], ['BTCEUR', 1]]);
  await sleep(300);
  const p = (await j('/api/prices')).body;
  assert.equal(p.prices['BTC/USDT'], 70123.5); assert.equal(p.src['BTC/USDT'], 'live');
  assert.equal(p.src['XAU/USD'], 'sim');
  assert.ok(Math.abs(p.prices['1000PEPE/USDT'] - 0.0125) < 1e-12, '1000PEPE = 1000 x PEPE');
  assert.equal(p.status.state, 'connected');
});

test('chart history comes from Binance klines, and simulated history for gold', async () => {
  const c = (await j('/api/candles?sym=BTC%2FUSDT')).body;
  assert.ok(c.candles.length >= 299);
  assert.equal(c.candles[0].close, 100.5);
  const g = (await j('/api/candles?sym=XAU%2FUSD')).body;
  assert.ok(g.candles.length >= 290);
  assert.equal((await j('/api/candles?sym=..%2Fetc')).status, 400);
});

test('longer timeframes come from the exchange, or are built when it has none', async () => {
  const h = (await j('/api/candles?sym=BTC%2FUSDT&tf=4h')).body;
  assert.equal(h.tf, '4h');
  assert.equal(h.history, 'exchange');
  assert.ok(klineIntervals.includes('4h'));
  const asked = klineIntervals.length;
  await j('/api/candles?sym=BTC%2FUSDT&tf=4h');
  assert.equal(klineIntervals.length, asked, 'a repeat request within 30 seconds uses the cache');
  const g = (await j('/api/candles?sym=XAU%2FUSD&tf=1h')).body;
  assert.equal(g.history, 'built');
  assert.ok(g.candles.length >= 2 && g.candles.every(c => c.time % 3600 === 0 && c.high >= c.low));
  assert.equal((await j('/api/candles?sym=BTC%2FUSDT&tf=2m')).status, 400);
  assert.equal((await j('/api/candles?sym=BTC%2FUSDT&tf=constructor')).status, 400);
});

test('drawings are saved and included in backups', async () => {
  const doc = { symbol: 'BTC/USDT', type: 'trend', points: [{ t: 1000, p: 1 }, { t: 2000, p: 2 }] };
  const saved = await j('/api/doc/drawings/drw-test', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) });
  assert.ok(saved.status < 300);
  const st = (await j('/api/state')).body;
  assert.equal(st.data.drawings.find(d => d.id === 'drw-test').type, 'trend');
  const dump = (await j('/api/export')).body;
  assert.ok(dump.data.drawings.some(d => d.id === 'drw-test'));
  assert.ok((await j('/api/doc/drawings/drw-test', { method: 'DELETE' })).status < 300);
});

test('saving, deleting and live change events', async () => {
  const events = [];
  const ctl = new AbortController();
  const es = fetch(base() + '/api/events', { signal: ctl.signal }).then(async r => { const rd = r.body.getReader(); const dec = new TextDecoder(); try { for (;;) { const { value, done } = await rd.read(); if (done) break; events.push(dec.decode(value)); } } catch (e) { /* aborted */ } });
  await sleep(200);
  const put = await j('/api/doc/levels/lvl-test', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-client-id': 'c1' }, body: JSON.stringify({ symbol: 'BTC/USDT', price: 71000, active: true }) });
  assert.equal(put.status, 200);
  await sleep(200);
  assert.ok(events.join('').includes('"id":"lvl-test"'), 'change broadcast to open pages');
  assert.ok(events.join('').includes('event: prices'), 'price ticks streamed');
  assert.ok((await j('/api/state')).body.data.levels.some(l => l.id === 'lvl-test'));
  await j('/api/doc/levels/lvl-test', { method: 'DELETE' });
  assert.ok(!(await j('/api/state')).body.data.levels.some(l => l.id === 'lvl-test'));
  assert.equal((await j('/api/doc/secrets/x', { method: 'PUT', body: '{}' })).status, 400);
  ctl.abort(); await es;
});

test('Claude review through the API: model mapping, text only, cost tracked', async () => {
  aiCalls = [];
  const r = await j('/api/ai', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: 'Review this', modelTier: 'complex' }) });
  assert.equal(r.status, 200);
  assert.equal(r.body.text, '{"processGrade":"B","summary":"ok","rubric":[]}');
  assert.equal(aiCalls[0].body.model, 'claude-opus-5-5');
  assert.equal(aiCalls[0].headers['x-api-key'], 'test-key');
  assert.equal(aiCalls[0].headers['anthropic-version'], '2023-06-01');
  assert.ok(Math.abs(r.body.costUsd - (20000 * 4 + 2000 * 20) / 1e6) < 1e-9, 'Opus cost $0.12');
  const q = await j('/api/ai', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: [{ role: 'user', content: 'rules' }, { role: 'user', content: 'q1' }], modelTier: 'quick' }) });
  assert.equal(aiCalls[1].body.model, 'claude-haiku-5-5');
  assert.equal(aiCalls[1].body.messages.length, 1, 'consecutive user turns merged');
  const s = (await j('/api/ai/status')).body;
  assert.equal(s.calls, 2); assert.ok(s.spentUsd > 0.12);
  aiMode = 'fail';
  const bad = await j('/api/ai', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: 'x' }) });
  assert.equal(bad.body.code, 'session_expired'); assert.match(bad.body.message, /API key was rejected/);
  aiMode = 'ok';
});

test('simulated pairs can be moved in the Test lab; live ones cannot', async () => {
  const g = await j('/api/sim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sym: 'XAU/USD', price: 2400 }) });
  assert.equal(g.status, 200); assert.equal(g.body.price, 2400);
  const b = await j('/api/sim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sym: 'BTC/USDT', pct: 1 }) });
  assert.equal(b.status, 409); assert.match(b.body.message, /live prices/);
});

test('backup, CSV export and restore with a safety copy', async () => {
  const r = await fetch(base() + '/api/export'); const dump = await r.json();
  assert.match(r.headers.get('content-disposition'), /cockpit-backup-/);
  assert.equal(dump.data.trades.length, 12);
  const csv = await (await fetch(base() + '/api/export/trades.csv')).text();
  assert.equal(csv.trim().split('\n').length, 13);
  assert.match(csv.split('\n')[0], /^id,account,type,stage,symbol/);
  const open = await (await fetch(base() + '/api/export/trades.csv?status=open')).text();
  const closed = await (await fetch(base() + '/api/export/trades.csv?status=closed')).text();
  assert.equal(open.trim().split('\n').length + closed.trim().split('\n').length - 2, 12, 'status filter splits the journal');
  assert.equal((await (await fetch(base() + '/api/export/trades.csv?account=nobody')).text()).trim().split('\n').length, 1, 'account filter');
  const xl = await fetch(base() + '/api/export/trades.xlsx?status=closed');
  assert.match(xl.headers.get('content-type'), /spreadsheetml/);
  assert.match(xl.headers.get('content-disposition'), /cockpit-trades-.*\.xlsx/);
  const xlBytes = Buffer.from(await xl.arrayBuffer());
  assert.equal(xlBytes.subarray(0, 2).toString(), 'PK');
  assert.ok(xlBytes.includes('xl/worksheets/sheet1.xml'));
  const smaller = JSON.parse(JSON.stringify(dump)); smaller.data.socials = smaller.data.socials.slice(0, 2);
  const imp = await j('/api/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(smaller) });
  assert.equal(imp.status, 200); assert.match(imp.body.safetyCopy, /^before-restore-/);
  assert.equal((await j('/api/state')).body.data.socials.length, 2);
  assert.ok(fs.existsSync(path.join(dataDir, imp.body.safetyCopy)));
  assert.equal((await j('/api/import', { method: 'POST', body: '{"hello":1}' })).status, 400);
  assert.ok(fs.readdirSync(path.join(dataDir, 'backups')).length >= 1, 'nightly backup written');
});

test('reconnects after the exchange drops, and reports the outage', async () => {
  for (const c of wss.clients) c.terminate();
  await sleep(300);
  const during = (await j('/api/prices')).body.status.state;
  assert.ok(['reconnecting', 'connecting'].includes(during), 'state while down: ' + during);
  for (let i = 0; i < 60 && !wss.clients.size; i++) await sleep(100);
  assert.ok(wss.clients.size >= 1, 'reconnected');
  sendTickers([['BTCUSDT', 70500]]); await sleep(200);
  assert.equal((await j('/api/prices')).body.prices['BTC/USDT'], 70500);
});

test('switching the source to Simulated stops using the exchange', async () => {
  const st = (await j('/api/state')).body.meta.settings;
  await j('/api/doc/meta/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({}, st, { feed: { source: 'simulated' } })) });
  await sleep(1200);
  const p = (await j('/api/prices')).body;
  assert.equal(p.source, 'simulated'); assert.equal(p.src['BTC/USDT'], 'sim');
  const b = await j('/api/sim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sym: 'BTC/USDT', pct: 1 }) });
  assert.equal(b.status, 200);
});

test('trade screenshots: before and after upload, only real images, kept through saves, removed with the trade', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 9)]);
  const up = (id, kind, body, name) => fetch(base() + '/api/trades/' + id + '/shots/' + kind, { method: 'POST', headers: { 'content-type': 'image/png', 'x-file-name': encodeURIComponent(name || 'a.png') }, body });
  const trade = (await j('/api/state')).body.data.trades[0];
  assert.equal((await up(trade.id, 'before', png, 'entry <b>.png')).status, 200);
  assert.equal((await up(trade.id, 'after', jpg, 'exit.jpg')).status, 200);
  let t = (await j('/api/state')).body.data.trades.find(x => x.id === trade.id);
  assert.equal(t.shots.before.length, 1);
  assert.equal(t.shots.after.length, 1);
  assert.match(t.shots.before[0].id, /^[a-f0-9]{16}\.png$/);
  const got = await fetch(base() + '/api/shots/' + trade.id + '/' + t.shots.before[0].id);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(Buffer.from(await got.arrayBuffer()).equals(png));
  // not images, even when labelled as one
  assert.equal((await up(trade.id, 'before', '<svg onload="alert(1)"></svg>')).status, 415);
  assert.equal((await up(trade.id, 'before', '<html><script>alert(1)</script></html>')).status, 415);
  assert.equal((await up('no-such-trade', 'before', png)).status, 404);
  assert.equal((await up(trade.id, 'during', png)).status, 404);
  assert.equal((await fetch(base() + '/api/shots/..%2F..%2Fcockpit.db/0123456789abcdef.png')).status, 400);
  assert.equal((await fetch(base() + '/api/shots/' + trade.id + '/cockpit.db')).status, 404);
  const big = await up(trade.id, 'before', Buffer.concat([png, Buffer.alloc(10 * 1024 * 1024 + 1)])).catch(() => null);
  assert.ok(!big || big.status === 413, 'over 10 MB is refused');
  // a page saving an older copy of the trade can't lose or change the screenshot list
  const stale = Object.assign({}, t); delete stale.shots;
  assert.equal((await j('/api/doc/trades/' + trade.id, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(stale) })).status, 200);
  t = (await j('/api/state')).body.data.trades.find(x => x.id === trade.id);
  assert.equal(t.shots.before.length, 1);
  // delete one
  const gone = t.shots.after[0].id;
  assert.equal((await fetch(base() + '/api/shots/' + trade.id + '/' + gone, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(base() + '/api/shots/' + trade.id + '/' + gone)).status, 404);
  t = (await j('/api/state')).body.data.trades.find(x => x.id === trade.id);
  assert.equal(t.shots.after.length, 0);
  // six at most per side
  const extra = (await j('/api/state')).body.data.trades[1];
  for (let i = 0; i < 6; i++) assert.equal((await up(extra.id, 'before', png)).status, 200);
  assert.equal((await up(extra.id, 'before', png)).status, 409);
  // deleting the trade removes its files
  assert.ok(fs.existsSync(path.join(dataDir, 'shots', extra.id)));
  assert.equal((await fetch(base() + '/api/doc/trades/' + extra.id, { method: 'DELETE' })).status, 200);
  assert.ok(!fs.existsSync(path.join(dataDir, 'shots', extra.id)));
});

test('archive & delete: an archived trade leaves the journal, comes back on restore, and delete is for good', async () => {
  const post = p => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 3)]);
  let st = (await j('/api/state')).body;
  const t = st.data.trades.find(x => !x.shots), count = st.data.trades.length;
  assert.equal((await fetch(base() + '/api/trades/' + t.id + '/shots/before', { method: 'POST', headers: { 'content-type': 'image/png' }, body: png })).status, 200);
  assert.equal((await post('/api/trades/' + t.id + '/archive')).status, 200);
  st = (await j('/api/state')).body;
  assert.equal(st.data.trades.length, count - 1, 'gone from the journal');
  assert.ok(!st.data.trades.some(x => x.id === t.id));
  const a = st.data.archive.find(x => x.id === t.id);
  assert.ok(a && a.trade.symbol === t.symbol && a.archivedAt > 0 && a.trade.shots.before.length === 1, 'kept whole in the archive, screenshots too');
  assert.ok(fs.existsSync(path.join(dataDir, 'shots', t.id)), 'screenshot files kept for a restore');
  const csv = await (await fetch(base() + '/api/export/trades.csv')).text();
  assert.ok(!csv.includes(t.id), 'left out of exports');
  assert.equal((await j('/api/doc/trades/' + t.id, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(t) })).status, 409, 'an old page can’t bring it back by saving');
  assert.equal((await post('/api/trades/' + t.id + '/archive')).status, 404);
  assert.equal((await post('/api/archive/no-such/restore')).status, 404);
  assert.equal((await post('/api/archive/' + t.id + '/archive')).status, 404, 'only the two real steps exist');
  const backup = (await j('/api/export')).body;
  assert.ok(backup.data.archive.some(x => x.id === t.id), 'archived trades are in backups');
  assert.equal((await post('/api/archive/' + t.id + '/restore')).status, 200);
  st = (await j('/api/state')).body;
  assert.equal(st.data.trades.length, count, 'restored');
  assert.equal(st.data.trades.find(x => x.id === t.id).shots.before.length, 1);
  assert.ok(!st.data.archive.some(x => x.id === t.id));
  // archive then delete for good: the record and its files go
  assert.equal((await post('/api/trades/' + t.id + '/archive')).status, 200);
  assert.equal((await fetch(base() + '/api/doc/archive/' + t.id, { method: 'DELETE' })).status, 200);
  st = (await j('/api/state')).body;
  assert.ok(!st.data.trades.some(x => x.id === t.id) && !st.data.archive.some(x => x.id === t.id));
  assert.ok(!fs.existsSync(path.join(dataDir, 'shots', t.id)), 'screenshots deleted with it');
  assert.equal((await j('/api/doc/archive/bad', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"trade":null}' })).status, 400, 'broken archive records refused');
});

test('password login: wrong or missing passwords are refused, and a missing password blocks the site when required', async () => {
  const boot = async (env) => {
    const child = spawn(process.execPath, [SERVER], { env: Object.assign({}, process.env, { PORT: '0', HOST: '127.0.0.1', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-')), NODE_NO_WARNINGS: '1', BINANCE_WS_URL: 'ws://127.0.0.1:' + wsPort, BINANCE_REST_URL: 'http://127.0.0.1:' + restPort, COCKPIT_PASSWORD: '', COCKPIT_AUTH_REQUIRED: '' }, env), stdio: ['ignore', 'pipe', 'ignore'] });
    let out = ''; child.stdout.on('data', d => { out += d; });
    for (let i = 0; i < 100; i++) { const m = out.match(/localhost:(\d+)/); if (m) return { child, url: 'http://127.0.0.1:' + m[1] }; await sleep(50); }
    throw new Error('server did not start');
  };
  const basic = (pw) => ({ authorization: 'Basic ' + Buffer.from('me:' + pw).toString('base64') });
  const a = await boot({ COCKPIT_PASSWORD: 'right:pass' });
  try {
    const none = await fetch(a.url + '/api/state');
    assert.equal(none.status, 401);
    assert.match(none.headers.get('www-authenticate'), /^Basic /);
    assert.equal((await fetch(a.url + '/', { headers: basic('wrong') })).status, 401);
    assert.equal((await fetch(a.url + '/api/doc/trades/x', { method: 'DELETE', headers: basic('wrong') })).status, 401);
    assert.equal((await fetch(a.url + '/api/shots/trd-001/0123456789abcdef.png')).status, 401);
    assert.equal((await fetch(a.url + '/api/trades/trd-001/shots/before', { method: 'POST', body: 'x' })).status, 401);
    assert.equal((await fetch(a.url + '/', { headers: basic('right:pass') })).status, 200);
    assert.equal((await fetch(a.url + '/api/state', { headers: basic('right:pass') })).status, 200);
    assert.equal((await fetch(a.url + '/api/health')).status, 200);
  } finally { a.child.kill(); }
  const b = await boot({ COCKPIT_AUTH_REQUIRED: '1' });
  try {
    assert.equal((await fetch(b.url + '/')).status, 503);
    assert.equal((await fetch(b.url + '/api/state')).status, 503);
    assert.equal((await fetch(b.url + '/api/health')).status, 200);
  } finally { b.child.kill(); }
});

test('default exchange addresses are used when no override is set', () => {
  const { Feed } = require(path.join(__dirname, '..', '..', 'server', 'feed.js'));
  const f = new Feed({ binanceWs: undefined, binanceRest: '', krakenWs: null });
  assert.equal(f.opts.binanceWs, 'wss://data-stream.binance.vision/ws/!miniTicker@arr');
  assert.equal(f.opts.binanceRest, 'https://data-api.binance.vision');
  assert.equal(f.opts.krakenWs, 'wss://ws.kraken.com/v2');
  clearInterval(f.timer);
});
