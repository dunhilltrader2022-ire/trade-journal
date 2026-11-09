// The cockpit page running from the server (polling fallback, since jsdom has no EventSource).
const http = require('node:http'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { spawn } = require('node:child_process');
const { WebSocketServer } = require('ws');
const { JSDOM, VirtualConsole } = require('jsdom');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const errs = []; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) errs.push(m); };
(async () => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await new Promise(r => wss.on('listening', r));
  const rest = http.createServer((q, s) => { s.writeHead(404); s.end(); }); const restPort = await listen(rest);
  const aiSrv = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => {
    const body = JSON.parse(b); res.writeHead(200, { 'content-type': 'application/json' });
    const review = { processGrade: 'C', rubric: [{ name: 'Rule compliance', score: 9, cite: 'stopLoss set' }], breaches: [], disagreement: 'You scored 2/5; agreed.', betterPosition: { available: false }, patterns: ['Entered 25 min after a loss'], summary: 'Revenge-style entry.', confidence: 'medium' };
    res.end(JSON.stringify({ model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(review) }], usage: { input_tokens: 9000, output_tokens: 800 } })); }); });
  const aiPort = await listen(aiSrv);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-ui-'));
  const proc = spawn(process.execPath, [path.join(__dirname, '..', '..', 'server', 'server.js')], { env: Object.assign({}, process.env, { PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir, NODE_NO_WARNINGS: '1', BINANCE_WS_URL: 'ws://127.0.0.1:' + wss.address().port, BINANCE_REST_URL: 'http://127.0.0.1:' + restPort, ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + aiPort, ANTHROPIC_API_KEY: 'k' }) });
  let out = ''; proc.stdout.on('data', d => out += d); proc.stderr.on('data', d => out += d);
  let port; for (let i = 0; i < 100 && !port; i++) { const m = out.match(/localhost:(\d+)/); if (m) port = Number(m[1]); else await sleep(50); }
  const base = 'http://127.0.0.1:' + port + '/';
  const tick = (px) => { for (const c of wss.clients) c.send(JSON.stringify([{ s: 'BTCUSDT', c: String(px) }, { s: 'ETHUSDT', c: '3500' }])); };
  for (let i = 0; i < 40 && !wss.clients.size; i++) await sleep(50);
  tick(70000);
  const html = await (await fetch(base)).text();
  const vc = new VirtualConsole(); vc.on('jsdomError', e => { if (!/Could not load script|scrollTo|Could not parse CSS/.test(e.message)) errs.push('jsdom: ' + e.message); });
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: base, virtualConsole: vc, beforeParse(w) { w.fetch = (u, o) => fetch(new URL(u, base), o); } });
  const w = dom.window, d = w.document, $ = s => d.querySelector(s);
  const set = (sel, v) => { const el = $(sel); el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); el.dispatchEvent(new w.Event('change', { bubbles: true })); };
  await sleep(2500); tick(70000); await sleep(1300);
  ok(w.Store.mode === 'server', 'page detects the server');
  ok(w.Store.data.trades.length === 12, 'page loads data from the server');
  d.querySelector('.seg [data-act="sym"][data-sym="BTC/USDT"]').click(); await sleep(200);
  ok(/70,000\.0/.test(d.getElementById('dbPrice').textContent), 'live BTC price shown (' + d.getElementById('dbPrice').textContent.trim() + ')');
  ok(/Binance · live/.test(d.getElementById('app').textContent), 'chart labels the live source');
  // place a market trade and check it reached the server
  set('#tkSize', '0.01'); set('#tkSL', '69000'); set('#tkTP', '72000'); await sleep(1200);
  $('#ticket').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); await sleep(400);
  const st = await (await fetch(base + 'api/state')).json();
  const placed = st.data.trades.find(t => t.symbol === 'BTC/USDT' && t.status === 'open' && t.fills[0].price === 70000);
  ok(!!placed, 'market trade saved on the server at the live price');
  // stop hit by the live feed closes it
  tick(68900); await sleep(2300);
  const st2 = await (await fetch(base + 'api/state')).json();
  ok(st2.data.trades.find(t => t.id === placed.id).status === 'closed', 'live price through the stop closes the position');
  // Claude review via the server
  w.location.hash = '#t-trd-005'; await sleep(300);
  ok(!!$('#shotFile-before') && !!$('#shotFile-after'), 'trade page offers before and after screenshots');
  $('[data-act="runReview"]').click(); await sleep(1500);
  const rv = (await (await fetch(base + 'api/state')).json()).data.trades.find(t => t.id === 'trd-005').reviews;
  ok(rv.length === 1 && rv[0].modelId === 'claude-sonnet-5-5' && rv[0].costUsd > 0, 'Sonnet review saved with model and cost');
  ok(/claude-sonnet-5-5 · \$0\.026/.test(d.getElementById('app').textContent), 'review shows model and cost');
  // Data feed page
  w.location.hash = '#feed'; await sleep(1300);
  const ft = d.getElementById('app').textContent;
  ok(/Connected/.test(ft) && /Pairs live/.test(ft), 'feed page shows connection status');
  ok(/\$0\.0[0-9]+/.test(ft) && /claude-opus-5-5/.test(ft), 'feed page shows Claude spend and models');
  // stale feed banner
  for (const c of wss.clients) c.terminate(); wss.close();
  w.location.hash = '#dashboard'; await sleep(2500);
  ok(/Prices:/.test(d.getElementById('app').textContent), 'dashboard warns when live prices stop');
  w.location.hash = '#lab'; await sleep(300);
  ok(!!$('a[href="api/export"]') && !!$('a[href="api/export/trades.csv"]') && !!$('#restoreFile'), 'lab has backup, CSV and restore');
  console.log('errors:', errs.length ? errs : 'none'); proc.kill(); process.exit(errs.length ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
