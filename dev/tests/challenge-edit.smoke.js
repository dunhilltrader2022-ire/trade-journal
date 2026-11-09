const { JSDOM, VirtualConsole } = require('jsdom'); const fs = require('fs');
const vc = new VirtualConsole(); const errs = [];
vc.on('jsdomError', e => { if (!/Could not load script|scrollTo/.test(e.message)) errs.push(e.message); });
const dom = new JSDOM('<!doctype html><html><body>' + fs.readFileSync(process.argv[2] || require('path').join(__dirname, '..', 'dist', 'cockpit.html'), 'utf8') + '</body></html>', { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.test/', virtualConsole: vc });
const w = dom.window, d = w.document, sleep = ms => new Promise(r => setTimeout(r, ms)), $ = s => d.querySelector(s);
const set = (sel, v) => { const el = $(sel); el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); el.dispatchEvent(new w.Event('change', { bubbles: true })); };
const submit = () => $('#addAcc').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) errs.push(m); };
(async () => {
  await sleep(300); $('[data-act="loadSample"]').click(); await sleep(1200);
  w.location.hash = '#challenges'; await sleep(200);
  ok(d.querySelectorAll('[data-act="editAcc"]').length === 5, 'every challenge has an Edit button');
  $('[data-act="editAcc"][data-id="acc-3"]').click(); await sleep(150);
  ok(/Edit #3 · 50K/.test($('#addH').textContent) && $('#naName').value === '#3 · 50K' && $('#naSize').value === '50000', 'edit form opens prefilled');
  // fields survive a live re-render
  set('#naBalance', '51234.5'); set('#naDayLoss', '120'); set('#naQual', '2'); set('#naId', 'BF-778812'); set('#naFee', '299');
  await sleep(1200);
  ok($('#naBalance').value === '51234.5' && $('#naId').value === 'BF-778812', 'typed values survive live updates');
  submit(); await sleep(250);
  const a = w.byId('accounts', 'acc-3'); const m = w.metricsFor(a);
  ok(a.bitfundedId === 'BF-778812' && a.fee === 299 && a.priorQualifying === 2, 'ID, fee and prior trades saved');
  const closedEquity = 51234.5; // equity also includes open P/L of the SOL long
  ok(Math.abs((m.equity - m.unrealized) - closedEquity) < 0.01, 'closed balance now matches Bitfunded (' + (m.equity - m.unrealized).toFixed(2) + ')');
  ok(m.dailyLoss >= 120, 'losses already taken today count toward daily loss');
  ok(!$('#addH').textContent.startsWith('Edit'), 'form returns to Add after saving');
  // duplicate level refused when editing size
  $('[data-act="editAcc"][data-id="acc-3"]').click(); await sleep(120);
  set('#naSize', '25000'); submit(); await sleep(150);
  ok(/one active challenge per level/i.test($('#naMsg').textContent), 'editing into a duplicate level is refused');
  // marking it failed frees the level, then change is allowed
  set('#naStatus', 'failed'); submit(); await sleep(200);
  ok(w.byId('accounts', 'acc-3').status === 'failed' && w.byId('accounts', 'acc-3').size === 25000, 'a failed challenge can share a level');
  // bad balance rejected
  $('[data-act="editAcc"][data-id="acc-2"]').click(); await sleep(120);
  set('#naBalance', '9999999'); submit(); await sleep(120);
  ok(/balance looks wrong/.test($('#naMsg').textContent), 'implausible balance rejected');
  $('[data-act="cancelAccEdit"]').click(); await sleep(120);
  ok(!$('#addH').textContent.startsWith('Edit'), 'cancel closes the edit');
  // add a challenge that already started
  set('#naName', '#5 · 100K'); set('#naSize', '100000'); set('#naStage', 'Stage 2'); set('#naBalance', '102500'); set('#naQual', '1');
  submit(); await sleep(200);
  const n = w.Store.data.accounts.find(x => x.name === '#5 · 100K');
  ok(n && Math.abs(w.metricsFor(n).profitPct - 2.5) < 1e-9 && w.metricsFor(n).qualifyingClosed === 1, 'new challenge can start from an existing balance');
  // advancing a stage resets the baseline
  $('[data-act="askAcc"][data-id="' + n.id + '"][data-op="advance"]').click(); await sleep(100); $('[data-act="doAccAction"]').click(); await sleep(200);
  const n2 = w.byId('accounts', n.id);
  ok(n2.stage === 'Funded' && n2.priorPnl === 0 && w.metricsFor(n2).profitPct === 0, 'next stage starts from the account size');
  console.log('errors:', errs.length ? errs : 'none'); process.exit(errs.length ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
