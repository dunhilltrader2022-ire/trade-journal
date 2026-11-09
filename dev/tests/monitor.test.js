// The safety loop with no page open: the real server against a mock Telegram and a mock exchange.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { WebSocketServer } = require('ws');

const SERVER = path.join(__dirname, '..', '..', 'server', 'server.js');
const TOKEN = '123456:SECRET-TOKEN-VALUE';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const HOUR = 3600000;

let tgPort, tgMessages = [], tgFailNext = 0, tgUpdates = [], tgNextUpdate = 1;
const running = new Set();

test.before(async () => {
  const tg = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      if (tgFailNext > 0) { tgFailNext--; res.writeHead(500); return res.end('{}'); }
      if (req.url === '/bot' + TOKEN + '/getUpdates') {
        const offset = (JSON.parse(b || '{}').offset) || 0;
        if (offset > 0) tgUpdates = tgUpdates.filter(u => u.update_id >= offset);   // like Telegram: asking from an offset confirms everything before it
        const reply = () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result: tgUpdates.filter(u => u.update_id >= offset) })); };
        return tgUpdates.some(u => u.update_id >= offset) ? reply() : setTimeout(reply, 200);
      }
      if (req.url === '/bot' + TOKEN + '/setMyCommands') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true,"result":true}'); }
      const ok = req.url === '/bot' + TOKEN + '/sendMessage';
      if (ok) tgMessages.push(JSON.parse(b));
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok }));
    });
  });
  await new Promise(r => tg.listen(0, '127.0.0.1', r));
  tgPort = tg.address().port;
  tg.unref();
});
test.after(() => { for (const c of running) c.kill(); setTimeout(() => process.exit(0), 200); });

function seedFile(seed) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-seed-')), 'seed.json');
  fs.writeFileSync(f, JSON.stringify(seed));
  return f;
}
async function boot(env) {
  const child = spawn(process.execPath, [SERVER], {
    env: Object.assign({}, process.env, { PORT: '0', HOST: '127.0.0.1', NODE_NO_WARNINGS: '1', PRICE_SOURCE: 'simulated', TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '42', TELEGRAM_API_URL: 'http://127.0.0.1:' + tgPort, COCKPIT_PASSWORD: '', COCKPIT_AUTH_REQUIRED: '' }, env),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  running.add(child);
  const srv = { child, log: '' };
  child.stdout.on('data', d => { srv.log += d; });
  child.stderr.on('data', d => { srv.log += d; });
  for (let i = 0; i < 100 && !srv.url; i++) { const m = srv.log.match(/localhost:(\d+)/); if (m) srv.url = 'http://127.0.0.1:' + m[1]; else await sleep(50); }
  if (!srv.url) throw new Error('server did not start: ' + srv.log);
  srv.state = async () => (await (await fetch(srv.url + '/api/state')).json());
  srv.move = (sym, price) => fetch(srv.url + '/api/sim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sym, price }) });
  srv.stop = async () => { child.kill(); running.delete(child); await sleep(150); };
  return srv;
}
async function until(fn, ms) { const end = Date.now() + (ms || 6000); while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(100); } return null; }

const account = (id, o) => Object.assign({ id, name: id, program: '2-Step', size: 10000, stage: 'Stage 1', status: 'active', maxLeverage: 5, startedAt: Date.now() - 48 * HOUR, stageStartedAt: Date.now() - 48 * HOUR }, o);
const trade = (id, accountId, symbol, price, o) => Object.assign({ id, accountId, symbol, side: 'Long', status: 'open', sl: null, tp: null, fills: [{ t: Date.now() - HOUR, price, size: 1, lev: 5, type: 'Market' }], fees: 0, createdAt: Date.now() - HOUR }, o);
const sent = re => tgMessages.filter(m => re.test(m.text));

test('with no page open: stops, limit orders and price alerts run and reach Telegram once', async () => {
  tgMessages = [];
  const seed = seedFile({
    data: {
      accounts: [account('acc-a'), account('acc-b', { size: 25000 })],
      trades: [trade('t-stop', 'acc-a', 'BTC/USDT', 100, { sl: 90, tp: 200 }), trade('t-tp', 'acc-b', 'BNB/USDT', 100, { sl: 50, tp: 110 })],
      levels: [{ id: 'l-1', symbol: 'ETH/USDT', price: 3000, note: 'Range top', active: true }],
      orders: [{ id: 'o-1', accountId: 'acc-a', kind: 'new', symbol: 'SOL/USDT', side: 'Long', type: 'Limit', price: 90, size: 1, lev: 5, sl: 80, tp: 120, status: 'working', createdAt: Date.now() }],
      socials: []
    },
    meta: { settings: {}, feed: { items: [] }, prices: { p: { 'BTC/USDT': 100, 'ETH/USDT': 2900, 'SOL/USDT': 100, 'BNB/USDT': 100 }, at: Date.now() } }
  });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-'));
  const srv = await boot({ SEED_FILE: seed, DATA_DIR: dataDir });
  await sleep(1500);
  assert.equal(tgMessages.length, 0, 'nothing is sent for the state that already existed');

  tgFailNext = 1;   // the first send fails, and has to be retried rather than lost
  await srv.move('BTC/USDT', 80);
  const closed = await until(async () => { const t = (await srv.state()).data.trades.find(x => x.id === 't-stop'); return t.status === 'closed' ? t : null; });
  assert.ok(closed, 'stop closed the position with no page open');
  assert.equal(closed.exit.price, 90);
  assert.equal(closed.exit.reason, 'Stop loss');
  assert.ok(closed.fees > 0);
  assert.ok(await until(() => sent(/BTC\/USDT Long: price hit your stop loss at .*Check your position on Bitfunded/).length === 1, 8000), 'stop reached Telegram after a retry');

  await srv.move('BNB/USDT', 120);
  const tp = await until(async () => { const t = (await srv.state()).data.trades.find(x => x.id === 't-tp'); return t.status === 'closed' ? t : null; });
  assert.equal(tp.exit.reason, 'Take profit');

  await srv.move('ETH/USDT', 3100);
  assert.ok(await until(async () => (await srv.state()).data.levels[0].active === false), 'level fired');
  assert.ok(await until(() => sent(/ETH\/USDT crossed 3,/).length === 1), 'level reached Telegram');

  await srv.move('SOL/USDT', 89);
  const filled = await until(async () => { const s = await srv.state(); return s.data.orders[0].status === 'filled' ? s : null; });
  assert.ok(filled, 'limit order filled');
  const made = filled.data.trades.find(t => t.id === filled.data.orders[0].tradeId);
  assert.equal(made.fills[0].price, 90);
  assert.equal(made.status, 'open');
  assert.equal(made.sl, 80);
  assert.ok(await until(() => sent(/Limit filled: Long 1 SOL\/USDT/).length === 1), 'fill reached Telegram');

  // a page that hasn't caught up can't reopen what the server closed
  const put = await fetch(srv.url + '/api/doc/trades/t-stop', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({}, closed, { status: 'open', exit: null })) });
  assert.equal(put.status, 409);
  assert.equal((await srv.state()).data.trades.find(t => t.id === 't-stop').status, 'closed');

  assert.ok(!srv.log.includes('SECRET-TOKEN-VALUE'), 'the token never reaches the logs');
  const body = JSON.stringify(await srv.state());
  assert.ok(!body.includes('SECRET-TOKEN-VALUE'), 'the token never reaches the page');
  await srv.stop();
});

test('a rule level alerts once a day, however often the price hovers, and a restart does not repeat it', async () => {
  tgMessages = [];
  const seed = seedFile({
    data: { accounts: [account('acc-r')], trades: [trade('t-r', 'acc-r', 'XRP/USDT', 1, { sl: 0.001, tp: 10, fills: [{ t: Date.now() - HOUR, price: 1, size: 1000, lev: 5, type: 'Market' }] })], levels: [], orders: [], socials: [] },
    meta: { settings: {}, feed: { items: [] }, prices: { p: { 'XRP/USDT': 1 }, at: Date.now() } }
  });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-'));
  let srv = await boot({ SEED_FILE: seed, DATA_DIR: dataDir });
  await sleep(1500);
  for (const p of [0.65, 1, 0.65, 1, 0.65]) { await srv.move('XRP/USDT', p); await sleep(1200); }   // 3.5% floating loss = 70% of the daily limit
  assert.ok(await until(() => sent(/Daily loss is past 60%/).length >= 1), 'warned');
  assert.equal(sent(/Daily loss is past 60%/).length, 1, 'warned only once while hovering');
  await srv.stop();

  srv = await boot({ SEED_FILE: seed, DATA_DIR: dataDir });
  await sleep(2500);
  assert.equal(sent(/Daily loss is past 60%/).length, 1, 'a restart does not repeat it');
  await srv.move('XRP/USDT', 0.45);   // 5.5% is past the limit
  assert.ok(await until(() => sent(/Daily loss has reached its limit/).length === 1), 'a worse level still alerts');
  await srv.stop();
});

test('never acts on a price it cannot trust: waits for a real quote on a live source', async () => {
  tgMessages = [];
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(r => wss.on('listening', r));
  const rest = http.createServer((q, s) => { s.writeHead(404); s.end(); });
  await new Promise(r => rest.listen(0, '127.0.0.1', r));
  const seed = seedFile({
    data: { accounts: [account('acc-s')], trades: [trade('t-s', 'acc-s', 'BTC/USDT', 100, { sl: 90, tp: 200 })], levels: [], orders: [], socials: [] },
    meta: { settings: {}, feed: { items: [] }, prices: { p: { 'BTC/USDT': 50 }, at: Date.now() } }   // saved price is already through the stop
  });
  const srv = await boot({ SEED_FILE: seed, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-')), PRICE_SOURCE: 'binance', BINANCE_WS_URL: 'ws://127.0.0.1:' + wss.address().port, BINANCE_REST_URL: 'http://127.0.0.1:' + rest.address().port });
  await sleep(3000);
  assert.equal((await srv.state()).data.trades[0].status, 'open', 'a saved price alone does not close the position');
  for (const c of wss.clients) c.send(JSON.stringify([{ s: 'BTCUSDT', c: '150' }]));
  await sleep(1500);
  assert.equal((await srv.state()).data.trades[0].status, 'open', 'a live quote inside the range leaves it open');
  for (const c of wss.clients) c.send(JSON.stringify([{ s: 'BTCUSDT', c: '85' }]));
  assert.ok(await until(async () => (await srv.state()).data.trades[0].status === 'closed'), 'a live quote through the stop closes it');
  await srv.stop();
  wss.close(); rest.close();
});

test('a made-up price never closes a position or fills an order while the source is live', async () => {
  tgMessages = [];
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(r => wss.on('listening', r));
  const rest = http.createServer((q, s) => { s.writeHead(404); s.end(); });
  await new Promise(r => rest.listen(0, '127.0.0.1', r));
  const seed = seedFile({
    data: { accounts: [account('acc-g')], trades: [trade('t-g', 'acc-g', 'XAU/USD', 2000, { sl: 1990, tp: 2010 })], levels: [{ id: 'l-g', symbol: 'XAU/USD', price: 1950, active: true }], orders: [{ id: 'o-g', accountId: 'acc-g', kind: 'new', symbol: 'XAG/USD', side: 'Long', type: 'Limit', price: 25, size: 1, lev: 5, sl: 20, tp: 30, status: 'working', createdAt: Date.now() }], socials: [] },
    meta: { settings: {}, feed: { items: [] }, prices: { p: { 'XAU/USD': 2000, 'XAG/USD': 30 }, at: Date.now() } }
  });
  const srv = await boot({ SEED_FILE: seed, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-')), PRICE_SOURCE: 'binance', PRICE_GRACE_MS: '1500', BINANCE_WS_URL: 'ws://127.0.0.1:' + wss.address().port, BINANCE_REST_URL: 'http://127.0.0.1:' + rest.address().port });
  const beat = setInterval(() => { for (const c of wss.clients) c.send(JSON.stringify([{ s: 'BTCUSDT', c: '100' }])); }, 200);
  await sleep(2000);
  await srv.move('XAU/USD', 1000);
  await srv.move('XAG/USD', 10);
  await sleep(2500);
  const s = await srv.state();
  assert.equal(s.data.trades[0].status, 'open', 'gold below the stop on a made-up price stays open');
  assert.equal(s.data.orders[0].status, 'working', 'a limit on a made-up price stays working');
  assert.equal(s.data.levels[0].active, true, 'a price alert on a made-up price stays armed');
  assert.ok(await until(() => sent(/XAU\/USD Long has no live price/).length === 1), 'it says the position is not being watched');
  assert.ok(await until(() => sent(/XAG\/USD has no live price/).length === 1), 'it says the order cannot fill');
  await sleep(1200);
  assert.equal(sent(/XAU\/USD Long has no live price/).length, 1, 'and says so only once');
  clearInterval(beat);
  await srv.stop();
  wss.close(); rest.close();
});

test('one broken record can\u2019t stop the checks for everything else, and the error is reported', async () => {
  tgMessages = [];
  const seed = seedFile({
    data: {
      accounts: [account('acc-a'), account('acc-b')],
      trades: [{ id: 't-broken', accountId: 'acc-a', symbol: 'BTC/USDT', side: 'Long', status: 'open', sl: 1, fills: 'none' }, trade('t-b', 'acc-b', 'BNB/USDT', 100, { sl: 50, tp: 500, fills: [{ t: Date.now() - HOUR, price: 100, size: 10, lev: 5, type: 'Market' }] })],
      levels: [], orders: [], socials: []
    },
    meta: { settings: {}, feed: { items: [] }, prices: { p: { 'BTC/USDT': 100, 'BNB/USDT': 100 }, at: Date.now() } }
  });
  const srv = await boot({ SEED_FILE: seed, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-')) });
  await sleep(1500);
  assert.ok(await until(() => sent(/A safety check hit an error/).length >= 1), 'the error reaches Telegram');
  const count = sent(/A safety check hit an error/).length;
  await srv.move('BNB/USDT', 60);   // a 4% loss on the other account
  assert.ok(await until(() => sent(/Daily loss .*acc-b/).length >= 1), 'the other account is still watched');
  await srv.move('BNB/USDT', 40);
  assert.ok(await until(async () => (await srv.state()).data.trades.find(t => t.id === 't-b').status === 'closed'), 'its stop still works');
  assert.equal(sent(/A safety check hit an error/).length, count, 'the same error isn\u2019t repeated every second');
  await srv.stop();
});

test('the bot answers the owner\u2019s commands, only the owner, and changes nothing', async () => {
  tgMessages = [];
  const seed = seedFile({
    data: { accounts: [account('acc-c', { name: 'Test 10K' })], trades: [trade('t-c', 'acc-c', 'BTC/USDT', 100, { sl: 90, tp: 130, fills: [{ t: Date.now() - HOUR, price: 100, size: 10, lev: 5, type: 'Market' }] })], levels: [], orders: [], socials: [] },
    meta: { settings: {}, feed: { items: [{ id: 'f1', t: Date.now(), lane: 'trade', text: 'An earlier alert' }] }, prices: { p: { 'BTC/USDT': 95 }, at: Date.now() } }
  });
  const srv = await boot({ SEED_FILE: seed, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-')), TELEGRAM_POLL_SECONDS: '1' });
  await srv.move('BTC/USDT', 95);
  const before = JSON.stringify((await srv.state()).data);
  const say = (text, chat) => tgUpdates.push({ update_id: tgNextUpdate++, message: { message_id: tgNextUpdate, date: Math.floor(Date.now() / 1000), chat: { id: chat || 42 }, text } });
  const reply = async re => { const ok = await until(() => tgMessages.some(m => re.test(m.text)), 8000); if (!ok) console.log('LAST REPLIES', JSON.stringify(tgMessages.slice(-3).map(m => m.text))); return ok; };
  say('/status');
  assert.ok(await reply(/Master Bitfunded · Status[\s\S]*Test 10K[\s\S]*Room today \$4\d\d of \$500[\s\S]*BTC\/USDT Long [+−]\$\d+ · −\$100 if stopped/), 'status');
  say('/positions');
  assert.ok(await reply(/Positions[\s\S]*BTC\/USDT Long 10 @ 100[\s\S]*Stop 90[\s\S]*Target 130/), 'positions');
  say('/room');
  assert.ok(await reply(/Today: \$\d+ left of \$500 \(5%\)[\s\S]*Total: .*floor/), 'room');
  say('/alerts');
  assert.ok(await reply(/An earlier alert/), 'alerts');
  say('Whats my current position status');
  assert.ok(await until(() => tgMessages.filter(m => /Master Bitfunded · Status/.test(m.text)).length === 2, 8000), 'everyday words work');
  say('/nonsense');
  assert.ok(await reply(/what I can answer[\s\S]*\/status/), 'help for anything else');
  const count = tgMessages.length;
  say('/status', 999);
  await sleep(2500);
  assert.equal(tgMessages.length, count, 'someone else gets no answer');
  assert.ok(tgMessages.every(m => String(m.chat_id) === '42'), 'every reply goes to the owner');
  say('/today');
  assert.ok(await reply(/Today so far[\s\S]*Test 10K[\s\S]*No trades closed[\s\S]*Daily loss used \$\d+ of \$500/), 'today so far');
  say('/check BTC long 95 stop 90 risk 100');
  assert.ok(await reply(/Check[\s\S]*BTC\/USDT Long at 95\.0 \(your price\)[\s\S]*Size 20 BTC[\s\S]*Risk to stop \$100[\s\S]*If every stop is hit: daily 2\.00%[\s\S]*Within your Bitfunded limits[\s\S]*Nothing was logged/), 'check sizes from risk');
  say('/check BTC long 95 stop 90 risk 1000');
  assert.ok(await reply(/daily 11\.00% of 5%[\s\S]*would pause this/), 'check says when a rule would pause it');
  say('/check BTC long 95 stop 99 risk 10');
  assert.ok(await reply(/wrong side[\s\S]*Fix the stop/), 'check catches a wrong-side stop');
  say('/check BTC sideways');
  assert.ok(await reply(/Say long or short/), 'check explains what it needs');
  assert.equal(JSON.stringify((await srv.state()).data), before, 'answering and checking change nothing');
  // the two small changes the bot may make
  say('/alert ETH 3100 range top');
  assert.ok(await reply(/Price alert set: ETH\/USDT at 3,100\.0 · range top/), 'alert set');
  const lv = await until(async () => (await srv.state()).data.levels.find(l => l.symbol === 'ETH/USDT' && l.price === 3100 && l.active && l.note === 'range top'), 4000);
  assert.ok(lv, 'the alert is saved like one made on the site');
  say('/alert');
  assert.ok(await reply(/Price alerts\n\nETH\/USDT at 3,100\.0 · range top/), 'alerts listed');
  say('/alert DOGECOINX 1');
  assert.ok(await reply(/don\u2019t know that pair/), 'an unknown pair is refused');
  say('/quiet 30m');
  assert.ok(await reply(/paused until[\s\S]*Rule warnings, closed trades/), 'quiet');
  const quietCount = tgMessages.length;
  await srv.move('ETH/USDT', 2900); await sleep(1200); await srv.move('ETH/USDT', 3200);
  assert.ok(await until(async () => (await srv.state()).data.levels.find(l => l.id === lv.id).active === false, 6000), 'the alert still fires on the site');
  await sleep(2000);
  assert.ok(!tgMessages.slice(quietCount).some(m => /ETH\/USDT crossed/.test(m.text)), 'but stays out of Telegram while quiet');
  await srv.move('BTC/USDT', 85);
  assert.ok(await reply(/price hit your stop loss/), 'a stop still comes through while quiet');
  say('/quiet off');
  assert.ok(await reply(/Alerts are back on/), 'quiet off');
  assert.ok(!srv.log.includes('SECRET-TOKEN-VALUE'), 'the token never reaches the logs');
  await srv.stop();
});

test('after each Bitfunded reset the bot sends one summary of the day that ended', async () => {
  tgMessages = [];
  const R = require('../../server/lib/rules.js');
  const day = R.dayBounds(Date.now()), prev = day.start - 24 * HOUR;
  const closedTrade = trade('t-d', 'acc-d', 'BTC/USDT', 100, { status: 'closed', sl: 90, tp: 130, exit: { t: prev + HOUR, price: 90, reason: 'Stop loss' }, fills: [{ t: prev + 30 * 60000, price: 100, size: 10, lev: 5, type: 'Market' }] });
  const seed = seedFile({
    data: { accounts: [account('acc-d', { name: 'Day 10K', startedAt: prev - 48 * HOUR, stageStartedAt: prev - 48 * HOUR })], trades: [closedTrade], levels: [], orders: [], socials: [] },
    meta: { settings: {}, feed: { items: [] }, prices: { p: { 'BTC/USDT': 100 }, at: Date.now() }, botstate: { summaryDay: prev }, watch: { fired: { ['acc-d:daily:warn:' + prev]: prev + HOUR, ['acc-d:daily:danger:' + prev]: prev + HOUR }, flags: {}, cross: {} } }
  });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-'));
  let srv = await boot({ SEED_FILE: seed, DATA_DIR: dataDir, TELEGRAM_POLL_SECONDS: '1' });
  const seen = await until(() => tgMessages.some(m => /Daily summary[\s\S]*Day 10K[\s\S]*Closed 1 trade · P\/L −\$100[\s\S]*Daily loss used \$100 of \$500 \(20%\), realised[\s\S]*BTC\/USDT Long −\$100 \(Stop loss\)[\s\S]*Warnings: Daily loss past 90%/.test(m.text)), 9000);
  if (!seen) { console.log('SUMMARY SEEN', JSON.stringify(tgMessages.map(m => m.text))); await srv.stop(); }
  assert.ok(seen, 'summary of the day that ended');
  await sleep(1500);
  assert.equal(tgMessages.filter(m => /Daily summary/.test(m.text)).length, 1, 'sent once');
  await srv.stop();
  srv = await boot({ SEED_FILE: seed, DATA_DIR: dataDir, TELEGRAM_POLL_SECONDS: '1' });
  await sleep(5000);
  assert.equal(tgMessages.filter(m => /Daily summary/.test(m.text)).length, 1, 'a restart doesn\u2019t send it again');
  await srv.stop();
});

test('Telegram stays off without a token, and the safety loop still runs', async () => {
  tgMessages = [];
  const seed = seedFile({
    data: { accounts: [account('acc-o')], trades: [trade('t-o', 'acc-o', 'BTC/USDT', 100, { sl: 90 })], levels: [], orders: [], socials: [] },
    meta: { settings: {}, feed: { items: [] }, prices: { p: { 'BTC/USDT': 100 }, at: Date.now() } }
  });
  const srv = await boot({ SEED_FILE: seed, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-')), TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' });
  await sleep(1200);
  const s = await srv.state();
  assert.equal(s.server.notify.configured, false);
  assert.equal((await fetch(srv.url + '/api/notify/test', { method: 'POST' })).status, 502);
  await srv.move('BTC/USDT', 80);
  assert.ok(await until(async () => (await srv.state()).data.trades[0].status === 'closed'));
  assert.equal(tgMessages.length, 0);
  assert.match(JSON.stringify((await srv.state()).meta.feed.items), /price hit your stop loss/);
  await srv.stop();
});
