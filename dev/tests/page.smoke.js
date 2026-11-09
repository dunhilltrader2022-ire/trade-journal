// Headless smoke test of dist/cockpit.html in local-storage mode (no claude runtime, no chart library).
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync(process.argv[2] || require('path').join(__dirname, '..', 'dist', 'cockpit.html'), 'utf8');
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => { if (!/Could not load script|scrollTo/.test(e.message)) errors.push('jsdomError: ' + e.message); });
vc.on('error', e => errors.push('console.error: ' + e));
const dom = new JSDOM('<!doctype html><html><head></head><body>' + html + '</body></html>', {
  runScripts: 'dangerously', resources: undefined, pretendToBeVisual: true, url: 'https://example.test/', virtualConsole: vc
});
const w = dom.window, d = w.document;
w.addEventListener('error', e => errors.push('window error: ' + e.message));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const $ = s => d.querySelector(s);
const click = el => { if (!el) throw new Error('missing element to click'); el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); };
const setVal = (sel, v) => { const el = $(sel); if (!el) throw new Error('missing ' + sel); el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); el.dispatchEvent(new w.Event('change', { bubbles: true })); };
const submit = sel => { const f = $(sel); if (!f) throw new Error('missing form ' + sel); f.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); };
const go = async h => { w.location.hash = h; await sleep(60); };
const text = () => d.getElementById('app').textContent;
const check = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) errors.push('check failed: ' + msg); };

(async () => {
  await sleep(300);
  check(/No test data yet/.test(text()), 'empty state shows');
  click($('[data-act="loadSample"]'));
  await sleep(1300);
  check(/Bitfunded rules/.test(text()), 'dashboard renders after loading sample');
  check(/Heads up:/.test(text()), 'daily-loss early warning banner on #2');
  check(/Hedge across accounts/.test(text()), 'cross-account hedge banner');
  check(/Day resets in|Old day until/.test(text()), 'day clock renders');
  check(d.querySelectorAll('.risk-strip .gauge').length === 4, 'four risk tiles');
  check(/No SL/.test(d.getElementById('dbPositions').textContent), 'missing SL flagged in positions');

  // Chart timeframes and drawing tools
  check(d.querySelectorAll('[data-act="tf"]').length === 6, 'six timeframe buttons');
  click($('[data-act="tf"][data-tf="4h"]')); await sleep(80);
  check($('[data-act="tf"][data-tf="4h"]').getAttribute('aria-pressed') === 'true' && /4-hour candles/.test(text()), 'timeframe switches and is labelled');
  check(w.localStorage.getItem('cockpit-tf') === '"4h"', 'timeframe is remembered');
  click($('[data-act="tf"][data-tf="1m"]')); await sleep(80);
  check(!!$('#dbChartTools [aria-label="Trend line"]') && !!$('#dbChartTools [aria-label="Fibonacci retracement"]'), 'drawing tools are offered');
  click($('[data-act="drawTool"][data-tool="fib"]')); await sleep(30);
  check(/Click two points/.test($('#dbChartHint').textContent), 'a chosen tool explains itself');
  click($('[data-act="drawTool"][data-tool="fib"]')); await sleep(30);
  check(!/Click two points/.test($('#dbChartHint').textContent), 'pressing the tool again cancels it');
  const bars = [{ time: 600, open: 1, high: 2, low: 1, close: 2 }, { time: 660, open: 2, high: 4, low: 1.5, close: 3 }, { time: 900, open: 3, high: 3, low: 2, close: 2.5 }];
  const agg = w.aggregateBars(bars, 300);
  check(agg.length === 2 && agg[0].high === 4 && agg[0].low === 1 && agg[0].close === 3 && agg[1].time === 900, 'candles combine into longer timeframes');
  const live = [{ time: 600, open: 1, high: 2, low: 1, close: 2 }];
  w.mergeLiveBar(live, { time: 700, open: 5, high: 5, low: 5, close: 5 }, 300);
  check(live.length === 1 && live[0].high === 5 && live[0].close === 5, 'a live price updates the current candle');
  w.mergeLiveBar(live, { time: 900, open: 6, high: 6, low: 6, close: 6 }, 300);
  check(live.length === 2 && live[1].time === 900 && live[1].open === 6, 'a live price starts the next candle on time');
  check(w.timeToIdx(bars, 660, 60) === 1 && w.timeToIdx(bars, 780, 60) === 1.5 && w.timeToIdx(bars, 540, 60) === -1 && w.timeToIdx(bars, 960, 60) === 3, 'drawings stay at the right time on any timeframe');
  [-1, 0, 1, 1.5, 2, 3].forEach(i => { if (w.timeToIdx(bars, w.idxToTime(bars, i, 60), 60) !== i) check(false, 'time and position disagree at ' + i); });
  const fib = w.fibLevels(100, 200);
  check(fib.length === 7 && fib[0].price === 200 && fib[6].price === 100 && fib[3].price === 150, 'fibonacci levels between two points');
  w.put('drawings', { id: 'drw-a', symbol: 'BTC/USDT', type: 'hline', points: [{ t: 600, p: 70000 }], createdAt: 1 });
  w.put('drawings', { id: 'drw-b', symbol: 'ETH/USDT', type: 'hline', points: [{ t: 600, p: 3000 }], createdAt: 1 });
  await sleep(120);
  click($('[data-act="askDrawClear"]')); await sleep(30);
  click($('[data-act="doDrawClear"]')); await sleep(60);
  check(!w.byId('drawings', 'drw-a') && !!w.byId('drawings', 'drw-b'), 'clear removes drawings on this pair only');
  w.remove('drawings', 'drw-b'); await sleep(60);

  // Ticket: new position with too-big size is blocked
  setVal('#tkSize', '50'); setVal('#tkSL', String(Number(w.Sim.prices['BTC/USDT']) * 0.98));
  await sleep(1100);
  check(/Paused/.test(d.getElementById('tkPreview').textContent), 'oversized trade is blocked');
  check($('#tkSubmit').disabled, 'submit disabled when blocked');
  // Sensible trade
  setVal('#tkSize', '0.05');
  setVal('#tkTP', String(Number(w.Sim.prices['BTC/USDT']) * 1.03));
  await sleep(1100);
  check(!$('#tkSubmit').disabled, 'submit enabled for a sensible trade');
  const before = w.Store.data.trades.length;
  submit('#ticket'); await sleep(200);
  check(w.Store.data.trades.length === before + 1, 'new trade saved');
  const newT = w.Store.data.trades[w.Store.data.trades.length - 1];
  check(newT.entryCandles && newT.entryCandles.length > 10, 'entry candles captured for review');

  // Stop and target by % from entry
  const mkt = w.Sim.prices['BTC/USDT'];
  click($('[data-act="levelMode"][data-v="pct"]')); await sleep(60);
  setVal('#tkSL', '2'); setVal('#tkTP', '4'); await sleep(30);
  const pctTk = w.readTicket();
  check(Math.abs(Number(pctTk.sl) / mkt - 0.98) < 0.01 && Math.abs(Number(pctTk.tp) / mkt - 1.04) < 0.01, '% from entry becomes the right prices on a long');
  check(/= /.test($('#tkSL').parentNode.querySelector('.lvl-hint').textContent), '% shows the price it means');
  click($('[data-act="levelMode"][data-v="price"]')); await sleep(60);
  check(Math.abs(Number($('#tkSL').value) / mkt - 0.98) < 0.01, 'switching to value keeps the same level');
  check(w.priceToPct(w.pctToPrice(2, 'sl', 'Short', 100), 'sl', 'Short', 100) === 2 && w.pctToPrice(2, 'sl', 'Short', 100) === 102 && w.pctToPrice(2, 'tp', 'Short', 100) === 98, '% levels flip on a short');
  setVal('#tkSL', ''); setVal('#tkTP', '');

  // Leverage over the max is blocked
  click($('[data-act="tkLev"][data-lev="20"]')); await sleep(80);
  setVal('#tkSize', '0.01'); await sleep(1100);
  check(/above this account/.test(d.getElementById('tkPreview').textContent), '20x leverage flagged');
  click($('[data-act="tkLev"][data-lev="5"]')); await sleep(80);

  // Add to existing
  click($('[data-act="tkMode"][data-mode="add"]')); await sleep(100);
  check(!!$('#tkTarget'), 'add mode shows position picker');
  setVal('#tkTarget', newT.id); await sleep(100);
  setVal('#tkSize', '0.02'); await sleep(1100);
  check(/New avg entry/.test(d.getElementById('tkPreview').textContent), 'add preview shows new average');
  submit('#ticket'); await sleep(200);
  check(w.Store.data.trades.find(t => t.id === newT.id).fills.length === 2, 'add saved as second fill');

  // Price alert fires
  const p = w.Sim.prices['BTC/USDT'];
  setVal('#lvlPrice', String(p * 1.001)); submit('#levelForm'); await sleep(100);
  w.nudge('BTC/USDT', 0.5); await sleep(200);
  check(/crossed/.test(JSON.stringify(w.Store.meta.feed.items)), 'price alert fired into feed');

  // Edit SL then hit stop via lab
  click($('[data-act="editSL"][data-id="' + newT.id + '"]')); await sleep(100);
  check(!!$('#slForm'), 'SL edit form opens');
  const slWas = w.byId('trades', newT.id).sl;
  setVal('#slEdit', String(w.Sim.prices['BTC/USDT'] * 1.5)); submit('#slForm'); await sleep(60);
  check(w.byId('trades', newT.id).sl === slWas, 'a stop that would close the trade straight away is refused');
  click($('[data-act="cancelEdit"]')); await sleep(80);

  await go('#lab');
  check(/Test lab/.test(text()), 'lab renders');
  click($('[data-act="hit"][data-id="' + newT.id + '"][data-w="sl"]')); await sleep(200);
  const closed = w.Store.data.trades.find(t => t.id === newT.id);
  check(closed.status === 'closed' && closed.exit.reason === 'Stop loss', 'hit stop closes at SL');
  check(closed.exitCandles && closed.exitCandles.length > 0, 'exit candles captured');
  click($('[data-act="jumpReset"]')); await sleep(1200);
  check(/0?0:0[12]:\d\d|00:01|00:02/.test(d.getElementById('labClock').textContent), 'jump to 2 min before reset');
  click($('[data-act="shiftReset"]')); await sleep(100);

  // Challenges: duplicate level refused, new one accepted
  // closing by hand takes your exit price, and past figures can be corrected
  await go('#dashboard');
  const toClose = w.Store.data.trades.find(t => t.status === 'open' && w.byId('accounts', t.accountId).status === 'active');
  w.setAccount(toClose.accountId); await sleep(100);
  click($('[data-act="askClose"][data-id="' + toClose.id + '"]')); await sleep(60);
  check(Number($('#closePrice').value) > 0, 'close form starts at the current price');
  setVal('#closePrice', '0'); submit('#closeForm'); await sleep(60);
  check(w.byId('trades', toClose.id).status === 'open', 'a zero exit price is refused');
  const exitAt = +(toClose.fills[0].price * 1.01).toFixed(4);
  setVal('#closePrice', String(exitAt)); await sleep(30);
  check(/Estimated after fees/.test($('#closeEst').textContent), 'close form shows the estimate');
  submit('#closeForm'); await sleep(100);
  const closedByHand = w.byId('trades', toClose.id);
  check(closedByHand.status === 'closed' && closedByHand.exit.price === exitAt && closedByHand.exit.reason === 'Manual', 'closed at the exit price you entered');
  await go('#t-' + toClose.id);
  click($('[data-act="fixTrade"]')); await sleep(60);
  check(!!$('#fixForm') && Number($('#fixXP').value) === exitAt, 'correction form opens with the current figures');
  const openedBefore = closedByHand.fills[0].t, closedBefore = closedByHand.exit.t;
  setVal('#fixXP', '-1'); submit('#fixForm'); await sleep(60);
  check(w.byId('trades', toClose.id).exit.price === exitAt, 'a bad exit price is refused');
  setVal('#fixXP', String(exitAt * 2)); setVal('#fixP0', String(toClose.fills[0].price * 1.5)); setVal('#fixFee', '12.34'); submit('#fixForm'); await sleep(100);
  const corrected = w.byId('trades', toClose.id);
  check(corrected.exit.price === exitAt * 2 && corrected.fills[0].price === toClose.fills[0].price * 1.5 && corrected.fees === 12.34 && corrected.correctedAt > 0, 'corrections are saved');
  check(corrected.fills[0].t === openedBefore && corrected.exit.t === closedBefore, 'times stay exact unless you change them');
  const expected = (toClose.side === 'Long' ? 1 : -1) * (exitAt * 2 - toClose.fills[0].price * 1.5) * corrected.fills[0].size - 12.34;
  check(Math.abs(w.R.realized(corrected) - expected) < 1e-6, 'P/L follows the corrected figures');
  check(/Edited/.test(text()), 'the trade shows it was edited');
  // the whole trade can be edited
  click($('[data-act="fixTrade"]')); await sleep(60);
  const otherAcc = w.Store.data.accounts.find(a => a.id !== corrected.accountId);
  setVal('#fixAcct', otherAcc.id); setVal('#fixSide', corrected.side === 'Long' ? 'Short' : 'Long'); setVal('#fixSym', 'ETH/USDT'); setVal('#fixL0', '3');
  setVal('#fixSL', '1234'); setVal('#fixTP', ''); setVal('#fixMood', 'Tired'); setVal('#fixReason', 'Edited reason'); setVal('#fixXR', 'Stop loss');
  submit('#fixForm'); await sleep(100);
  const full = w.byId('trades', toClose.id);
  check(full.accountId === otherAcc.id && full.symbol === 'ETH/USDT' && full.side !== corrected.side && full.sl === 1234 && full.tp === null && full.mood === 'Tired' && full.reason === 'Edited reason' && full.fills[0].lev === 3 && full.exit.reason === 'Stop loss', 'account, pair, side, leverage, SL, TP, notes and reason all save');
  // total fees when closing
  await go('#dashboard');
  const feeT = w.Store.data.trades.find(t => t.status === 'open' && w.byId('accounts', t.accountId).status === 'active');
  w.setAccount(feeT.accountId); await sleep(100);
  click($('[data-act="askClose"][data-id="' + feeT.id + '"]')); await sleep(60);
  setVal('#closeFee', '9.99'); await sleep(30);
  check(/After your fees/.test($('#closeEst').textContent), 'close form uses the fees you enter');
  submit('#closeForm'); await sleep(100);
  check(w.byId('trades', feeT.id).fees === 9.99, 'total fees entered when closing replace the estimate');
  // the room-left tile shows the daily limit in dollars
  await go('#dashboard');
  { const ra = w.currentAccount(), rm = w.metricsFor(ra), lim = ra.size * rm.cfg.dailyLossPct / 100;
    check($('#app').textContent.includes('of ' + w.money(lim) + ' max daily loss (' + rm.cfg.dailyLossPct + '%)'), 'the room-left tile shows the max daily loss'); }
  // the menu keeps every page, and the phone screens switch
  for (const h of ['#dashboard', '#journal', '#challenges', '#socials', '#pairs', '#feed', '#lab']) check(!!d.querySelector('#nav a[href="' + h + '"]'), 'menu links to ' + h);
  check(!!d.querySelector('#nav a[href*="vela.luxalgo.com"]'), 'menu links to LuxAlgo Vela');
  click($('#phoneNew')); await sleep(60);
  check(d.body.dataset.pv === 'trade', 'New trade opens the trade screen on a phone');
  click($('#navChart')); await sleep(60);
  check(d.body.dataset.pv === 'chart', 'Chart opens the chart screen on a phone');
  click($('#nav a[href="#dashboard"]')); await sleep(60);
  check(d.body.dataset.pv === 'home', 'Dashboard returns to the summary on a phone');
  // risk sets the size, and size sets the risk
  { const ra = w.Store.data.accounts.find(a => a.status === 'active' && !a.paper);
    w.setAccount(ra.id); await sleep(100);
    w.ui.ticketMode = 'new'; w.ui.side = 'Long'; w.ui.levelMode = 'price'; w.ui.orderType = 'Market'; w.renderRoute(); await sleep(60);
    const mk = Number(w.Sim.prices[w.ui.sym]), stop = mk * 0.99;
    setVal('#tkSL', String(stop)); setVal('#tkRisk', '100'); await sleep(50);
    const sized = Number($('#tkSize').value);
    check(sized > 0 && Math.abs(sized * (Number(w.Sim.prices[w.ui.sym]) - stop) - 100) < 3, 'typing a risk sets the size');
    setVal('#tkSize', String(sized * 2)); await sleep(50);
    check(Math.abs(Number($('#tkRisk').value) - sized * 2 * (Number(w.Sim.prices[w.ui.sym]) - stop)) < 6, 'typing a size updates the risk');
    check(/If (every|the) stop is hit/.test($('#tkPreview').textContent) && /Reward to risk|Daily loss/.test($('#tkPreview').textContent), 'the preview shows the worst case');
    check(!$('#tkMoreBox') || $('#tkMoreBox').hidden, 'setup, mood and checklist start folded');
    click($('[data-act="tkMore"]')); await sleep(60);
    check(!$('#tkMoreBox').hidden && !!$('#tkSetup'), 'and open when asked');
    setVal('#tkMood', 'Tired'); w.renderRoute(); await sleep(60);
    check($('#tkMood').value === 'Tired', 'details keep what you typed');
    click($('[data-act="tkMore"]')); await sleep(30);
    setVal('#tkRisk', ''); setVal('#tkSize', ''); setVal('#tkSL', ''); w.ui.sizeFrom = 'size'; await sleep(30); }
  // the ticket refuses a stop or target that can't work, and a Manual fill is logged even past a rule
  await go('#dashboard');
  const tkAcc = w.Store.data.accounts.find(a => a.status === 'active' && !a.paper);
  w.setAccount(tkAcc.id); await sleep(100);
  w.ui.ticketMode = 'new'; w.ui.side = 'Long'; w.ui.levelMode = 'price'; w.ui.orderType = 'Market'; w.renderRoute(); await sleep(60);
  const tkMkt = Number(w.Sim.prices[w.ui.sym]);
  setVal('#tkSize', '0.0001'); setVal('#tkSL', String(tkMkt * 1.05)); setVal('#tkTP', String(tkMkt * 1.1)); await sleep(50);
  w.renderTicketPreview();
  check($('#tkSubmit').disabled && /wrong side/.test($('#tkPreview').textContent), 'the ticket refuses a stop on the wrong side');
  setVal('#tkSL', ''); setVal('#tkTP', ''); setVal('#tkSize', ''); await sleep(30);
  const preM = w.R.preTrade(tkAcc, w.metricsFor(tkAcc), { t: Date.now(), side: 'Long', price: 100, size: 100000, lev: 5, sl: 50, tp: 120 }, null);
  check(preM.blocked === true && preM.invalid === false, 'a huge risk is a rule block, not a bad stop');
  w.ui.orderType = 'Manual'; w.renderRoute(); await sleep(60);
  setVal('#tkPrice', String(tkMkt)); setVal('#tkSize', '100000'); setVal('#tkSL', String(tkMkt * (w.ui.side === 'Long' ? 0.5 : 1.5))); setVal('#tkTP', String(tkMkt * (w.ui.side === 'Long' ? 1.1 : 0.9))); await sleep(50);
  w.renderTicketPreview();
  check(!$('#tkSubmit').disabled && /Past a Bitfunded rule/.test($('#tkPreview').textContent), 'a Manual fill past a rule warns but can still be logged');
  setVal('#tkSL', String(tkMkt * (w.ui.side === 'Long' ? 1.5 : 0.5))); await sleep(50);
  w.renderTicketPreview();
  check($('#tkSubmit').disabled, 'a Manual fill with a stop on the wrong side is still refused');
  setVal('#tkSL', ''); setVal('#tkTP', ''); setVal('#tkSize', ''); setVal('#tkPrice', ''); w.ui.orderType = 'Market'; w.renderRoute(); await sleep(60);
  // closing from the trade page, the way the journal reaches it
  const reopen = id => { const c = JSON.parse(JSON.stringify(w.byId('trades', feeT.id))); c.id = id; c.status = 'open'; delete c.exit; delete c.correctedAt; c.fees = 3; c.sl = null; c.tp = null; c.exitCandles = []; w.put('trades', c); return c; };
  reopen('trd-close-page'); await go('#t-trd-close-page');
  click($('[data-act="askClose"][data-id="trd-close-page"]')); await sleep(60);
  check(w.location.hash === '#t-trd-close-page' && !!$('#closeForm') && Number($('#closePrice').value) > 0, 'Close position on a trade opens the form there, with the price filled in');
  setVal('#closePrice', '123'); submit('#closeForm'); await sleep(100);
  const closedPage = w.byId('trades', 'trd-close-page');
  check(closedPage.status === 'closed' && closedPage.exit.price === 123 && !$('#closeForm'), 'Close position on a trade really closes it');
  reopen('trd-edit-close'); await go('#t-trd-edit-close');
  click($('[data-act="fixTrade"]')); await sleep(60);
  check($('#fixXP').value === '', 'editing an open trade starts with no exit price');
  submit('#fixForm'); await sleep(100);
  check(w.byId('trades', 'trd-edit-close').status === 'open', 'saving an edit without an exit price keeps it open');
  click($('[data-act="fixTrade"]')); await sleep(60);
  setVal('#fixXT', '2020-01-01T00:00'); submit('#fixForm'); await sleep(60);
  check(w.byId('trades', 'trd-edit-close').status === 'open', 'a closed time without an exit price is refused');
  setVal('#fixXT', ''); setVal('#fixXP', '-1'); submit('#fixForm'); await sleep(60);
  check(w.byId('trades', 'trd-edit-close').status === 'open', 'a bad exit price on an open trade is refused');
  setVal('#fixXP', '150'); setVal('#fixXT', '2020-01-01T00:00'); submit('#fixForm'); await sleep(60);
  check(w.byId('trades', 'trd-edit-close').status === 'open', 'closing before it opened is refused');
  setVal('#fixXT', ''); setVal('#fixXR', 'Take profit'); submit('#fixForm'); await sleep(100);
  const editClosed = w.byId('trades', 'trd-edit-close');
  check(editClosed.status === 'closed' && editClosed.exit.price === 150 && editClosed.exit.reason === 'Take profit' && editClosed.exit.t > 0 && editClosed.correctedAt > 0, 'an exit price in Edit trade closes the position');
  check(editClosed.fees > 3, 'closing through Edit trade adds the closing fee when fees are left alone');
  check(!w.openTrades(editClosed.accountId).some(t => t.id === editClosed.id), 'it leaves the open positions list');
  reopen('trd-edit-fee'); await go('#t-trd-edit-fee');
  click($('[data-act="fixTrade"]')); await sleep(60);
  setVal('#fixXP', '150'); setVal('#fixFee', '7.5'); submit('#fixForm'); await sleep(100);
  check(w.byId('trades', 'trd-edit-fee').fees === 7.5, 'total fees typed while closing through Edit trade are kept');

  await go('#challenges');
  check(/Cross-account guard/.test(text()), 'challenges renders');
  setVal('#naSize', '25000'); submit('#addAcc'); await sleep(100);
  check(/one active challenge per level/i.test($('#naMsg').textContent), 'duplicate 25K refused');
  setVal('#naSize', '100000'); submit('#addAcc'); await sleep(200);
  check(w.Store.data.accounts.some(a => a.size === 100000), '100K challenge added');
  setVal('#naSize', '15000'); submit('#addAcc'); await sleep(200);
  check(w.Store.data.accounts.some(a => a.size === 15000), '15K challenge added');
  setVal('#naProg', '2-Step 20x'); setVal('#naSize', '15000'); submit('#addAcc'); await sleep(200);
  const acc20x = w.Store.data.accounts.find(a => a.program === '2-Step 20x' && a.size === 15000);
  check(!!acc20x && acc20x.maxLeverage === 20, 'second 15K added on 2-Step 20x with 1:20 leverage');
  setVal('#naProg', '2-Step 20x'); setVal('#naSize', '15000'); submit('#addAcc'); await sleep(100);
  check(/one active challenge per level/i.test($('#naMsg').textContent), 'duplicate 15K on 2-Step 20x refused');
  const adv = $('[data-act="askAcc"][data-op="advance"]'); click(adv); await sleep(100);
  click($('[data-act="doAccAction"]')); await sleep(200);
  check(w.Store.data.accounts.some(a => a.stage === 'Stage 2'), 'advance stage works');

  // Journal + trade detail + my review
  await go('#journal');
  check(/Ask Claude about your trades/.test(text()), 'journal renders with chat');
  click($('[data-act="jType"][data-v="Paper"]')); await sleep(80);
  check(d.querySelectorAll('tbody tr').length >= 1 && !/Demo/.test(d.querySelector('tbody').textContent.replace(/Demo\b(?= )/g, '')), 'paper filter');
  click($('[data-act="jType"][data-v="All"]')); await sleep(80);
  await go('#t-' + newT.id);
  check(/Position build/.test(text()) && /Averaging down|Adding to a winner/.test(text()), 'trade detail shows fills');
  check($('[data-act="runReview"]').disabled, 'Claude review locked before my review');
  setVal('#mrWell', 'Entered on plan'); setVal('#mrWrong', 'Stop too tight'); submit('#myReview'); await sleep(200);
  check(!!w.Store.data.trades.find(t => t.id === newT.id).myReview, 'my review saved');
  check(!$('[data-act="runReview"]').disabled, 'Claude review unlocks after my review');
  click($('[data-act="runReview"]')); await sleep(200);
  check(/isn.t available in this view/.test(text()), 'review explains Claude unavailable outside claude.ai');

  // Archive & delete
  await go('#journal');
  const victim = w.Store.data.trades.find(t => t.status === 'open');
  const openBefore = w.openTrades(victim.accountId).length;
  const vMenu = '[data-tmenu="' + victim.id + '"]';
  check(!!$(vMenu) && /Archive & delete/.test($(vMenu).textContent) && d.querySelectorAll('[data-tmenu]').length === w.Store.data.trades.length, 'each journal row has an Archive & delete menu');
  setVal(vMenu, 'archive'); await sleep(80);
  check(/stops watching its stop and target/.test(text()) && w.location.hash === '#journal' && !!w.byId('trades', victim.id), 'archiving asks first and explains');
  click($('[data-act="doArchive"]')); await sleep(150);
  check(!w.byId('trades', victim.id) && !!w.byId('archive', victim.id) && w.openTrades(victim.accountId).length === openBefore - 1, 'an archived trade leaves the journal and the limits');
  setVal('#jStatus', 'archived'); await sleep(80);
  check(/Archived \(1\)/.test($('#jStatus').textContent) && !!$('[data-act="doUnarchive"][data-id="' + victim.id + '"]'), 'the Archived view lists it');
  click($('[data-act="doUnarchive"][data-id="' + victim.id + '"]')); await sleep(150);
  check(!!w.byId('trades', victim.id) && !w.byId('archive', victim.id) && w.openTrades(victim.accountId).length === openBefore, 'Restore puts it back');
  setVal('#jStatus', 'all'); await sleep(80);
  setVal(vMenu, 'delete'); await sleep(80);
  check(/can.t be undone/.test(text()), 'Delete for good warns first');
  click($('[data-act="cancelConfirm"]')); await sleep(80);
  check(!!w.byId('trades', victim.id), 'Keep leaves it alone');
  await go('#t-' + victim.id);
  setVal(vMenu, 'delete'); await sleep(80);
  click($('[data-act="doDelTrade"]')); await sleep(150);
  check(!w.byId('trades', victim.id) && !w.byId('archive', victim.id) && w.location.hash === '#journal', 'Delete for good from the trade page');

  // Socials
  await go('#socials');
  setVal('#soHandle', '@test_handle'); submit('#socialForm'); await sleep(150);
  check(w.Store.data.socials.some(s => s.handle === '@test_handle'), 'social added');
  setVal('#soHandle', 'bad handle!!'); submit('#socialForm'); await sleep(100);
  check(/valid X handle/.test($('#soMsg').textContent), 'invalid handle rejected');

  // Reset
  await go('#lab');
  click($('[data-act="askReset"]')); await sleep(80); click($('[data-act="doReset"]')); await sleep(400);
  check(w.Store.data.accounts.length === 5 && !w.Store.data.socials.some(s => s.handle === '@test_handle'), 'reset reloads sample set');

  await go('#dashboard'); await sleep(1500);
  console.log('\nErrors:', errors.length ? errors.join('\n') : 'none');
  process.exit(errors.length ? 1 : 0);
})().catch(e => { console.error('SMOKE CRASH', e); console.log(errors.join('\n')); process.exit(2); });
