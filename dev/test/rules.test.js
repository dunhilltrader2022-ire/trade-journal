const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/rules.js');

const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const acc = (o) => Object.assign({ id: 'a1', name: '#1', program: '2-Step', stage: 'Stage 1', size: 10000, status: 'active', startedAt: 0 }, o);
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('day resets at 00:00 UTC+8 (16:00 UTC) with a 10-minute settlement buffer', () => {
  const d = Date.UTC(2026, 10, 1, 15, 0); // 15:00 UTC, before reset
  const b = R.dayBounds(d);
  assert.equal(new Date(b.nominalReset).toISOString(), '2026-11-01T16:00:00.000Z');
  assert.equal(new Date(b.settleEnd).toISOString(), '2026-11-01T16:10:00.000Z');
  // 16:05 UTC is still the old day
  const inBuffer = R.dayBounds(Date.UTC(2026, 10, 1, 16, 5));
  assert.equal(inBuffer.start, b.start);
  assert.ok(inBuffer.inSettlement);
  // 16:10 UTC starts the new day
  const after = R.dayBounds(Date.UTC(2026, 10, 1, 16, 10));
  assert.equal(after.start, b.start + DAY);
  assert.equal(after.inSettlement, false);
});

test('stage limits follow the official 2-step rules', () => {
  assert.equal(R.rulesFor(acc()).maxLossPct, 10);
  assert.equal(R.rulesFor(acc({ stage: 'Stage 2' })).maxLossPct, 8);
  assert.equal(R.rulesFor(acc({ stage: 'Stage 2' })).targetPct, 5);
  assert.equal(R.rulesFor(acc({ stage: 'Funded' })).targetPct, null);
  assert.equal(R.accountType(acc()), 'Demo');
  assert.equal(R.accountType(acc({ stage: 'Funded' })), 'Live');
  assert.equal(R.accountType(acc({ paper: true })), 'Paper');
});

test('2-Step 20x: same limits as 2-Step with 1:20 leverage, and its own level', () => {
  for (const stage of ['Stage 1', 'Stage 2', 'Funded']) {
    const a = R.rulesFor(acc({ stage })), b = R.rulesFor(acc({ stage, program: '2-Step 20x' }));
    assert.equal(b.maxLeverage, 20);
    assert.equal(a.maxLeverage, 5);
    for (const k of ['dailyLossPct', 'maxLossPct', 'targetPct', 'maxPositions', 'maxExposurePct', 'minHoldMin', 'minClosedTrades']) assert.equal(b[k], a[k], k);
  }
  const has20x = [acc({ program: '2-Step 20x', size: 15000 })];
  assert.equal(R.canAddChallenge(has20x, { program: '2-Step', size: 15000 }).ok, true);
  assert.equal(R.canAddChallenge(has20x, { program: '2-Step 20x', size: 15000 }).ok, false);
  const both = [acc({ id: 'a', program: '2-Step 20x', size: 15000 }), acc({ id: 'b', size: 15000 })];
  assert.equal(R.crossAccount(both, [], 10 * DAY).duplicateLevels.length, 0);
});

test('position build: average entry, total size, margin, effective leverage', () => {
  const t = { side: 'Long', fills: [{ t: 0, price: 3412, size: 1, lev: 5 }, { t: 1, price: 3428, size: 0.5, lev: 5 }] };
  const s = R.summarize(t);
  near(s.size, 1.5);
  near(s.avgEntry, (3412 + 1714) / 1.5);
  near(s.margin, (3412 + 1714) / 5);
  near(s.effLeverage, 5);
});

test('risk to stop and P/L for long and short', () => {
  const long = { side: 'Long', sl: 90, fills: [{ t: 0, price: 100, size: 2, lev: 5 }] };
  near(R.riskToStop(long), 20);
  near(R.pnlAt(long, 110), 20);
  const short = { side: 'Short', sl: 110, fills: [{ t: 0, price: 100, size: 2, lev: 5 }] };
  near(R.riskToStop(short), 20);
  near(R.pnlAt(short, 90), 20);
  assert.equal(R.riskToStop({ side: 'Long', sl: null, fills: long.fills }), null);
});

test('daily loss = today’s realised losses + floating losses; wins do not offset', () => {
  const now = Date.UTC(2026, 10, 1, 12, 0);
  const a = acc();
  const trades = [
    { id: 't1', accountId: 'a1', symbol: 'BTC/USDT', side: 'Long', status: 'closed', fills: [{ t: now - 3 * HOUR, price: 100, size: 1, lev: 5 }], exit: { t: now - 2 * HOUR, price: 80 } }, // -20 today
    { id: 't2', accountId: 'a1', symbol: 'BTC/USDT', side: 'Long', status: 'closed', fills: [{ t: now - 3 * HOUR, price: 100, size: 1, lev: 5 }], exit: { t: now - 2 * HOUR, price: 150 } }, // +50 today
    { id: 't3', accountId: 'a1', symbol: 'ETH/USDT', side: 'Long', status: 'open', fills: [{ t: now - HOUR, price: 100, size: 1, lev: 5 }] },
    { id: 't4', accountId: 'a1', symbol: 'BTC/USDT', side: 'Long', status: 'closed', fills: [{ t: now - 3 * DAY, price: 100, size: 1, lev: 5 }], exit: { t: now - 2 * DAY, price: 0 } } // -100, older day
  ];
  const m = R.accountMetrics(a, trades, { 'ETH/USDT': 70, 'BTC/USDT': 100 }, now);
  near(m.dailyLoss, 20 + 30);
  near(m.dailyLossPct, 0.5);
  near(m.equity, 10000 - 20 + 50 - 100 - 30);
  near(m.totalLossPct, 1.0);
});

test('room left: today against the daily limit, total against the equity floor', () => {
  const now = Date.UTC(2026, 10, 1, 12, 0);
  const lost = [{ id: 't1', accountId: 'a1', symbol: 'BTC/USDT', side: 'Long', status: 'closed', fills: [{ t: now - 3 * HOUR, price: 100, size: 1, lev: 5 }], exit: { t: now - 2 * HOUR, price: 0 } }]; // -100 today
  const m = R.accountMetrics(acc(), lost, { 'BTC/USDT': 100 }, now);
  near(m.dailyRoom, 500 - 100);
  near(m.totalRoom, 1000 - 100);
  const won = [{ id: 't2', accountId: 'a1', symbol: 'BTC/USDT', side: 'Long', status: 'closed', fills: [{ t: now - 3 * DAY, price: 100, size: 1, lev: 5 }], exit: { t: now - 2 * DAY, price: 300 } }]; // +200 on an older day
  near(R.accountMetrics(acc(), won, { 'BTC/USDT': 100 }, now).totalRoom, 1000 + 200);
});

test('gauge levels: 60% warn, 90% danger, 100% breach', () => {
  assert.equal(R.level(0.59), 'ok');
  assert.equal(R.level(0.6), 'warn');
  assert.equal(R.level(0.9), 'danger');
  assert.equal(R.level(1), 'breach');
});

test('five positions is allowed, six is a breach', () => {
  const now = 10 * DAY;
  const mk = (i) => ({ id: 't' + i, accountId: 'a1', symbol: 'BTC/USDT', side: 'Long', status: 'open', sl: 1, fills: [{ t: now - HOUR, price: 10, size: 1, lev: 5 }] });
  const five = R.accountMetrics(acc(), [1, 2, 3, 4, 5].map(mk), { 'BTC/USDT': 10 }, now);
  assert.equal(five.gauges.find(g => g.key === 'positions').level, 'danger');
  const six = R.accountMetrics(acc(), [1, 2, 3, 4, 5, 6].map(mk), { 'BTC/USDT': 10 }, now);
  assert.equal(six.gauges.find(g => g.key === 'positions').level, 'breach');
});

test('position flags: no SL, leverage over 1:5, hold limits, min hold, averaging down', () => {
  const now = 20 * DAY;
  const t = { side: 'Long', symbol: 'AVAX/USDT', status: 'open', sl: null, tp: 200, fills: [{ t: now - 6.5 * DAY, price: 100, size: 1, lev: 10 }, { t: now - DAY, price: 90, size: 1, lev: 5 }] };
  const codes = R.positionFlags(t, acc(), now).flags.map(f => f.code);
  assert.ok(codes.includes('no_sl'));
  assert.ok(codes.includes('leverage'));
  assert.ok(codes.includes('hold_soon')); // minor crypto (AVAX) cap is 7 days
  assert.ok(codes.includes('avg_down'));
  const fresh = { side: 'Long', symbol: 'BTC/USDT', status: 'open', sl: 90, tp: 120, fills: [{ t: now - 5 * MIN, price: 100, size: 1, lev: 5 }] };
  assert.ok(R.positionFlags(fresh, acc(), now).flags.some(f => f.code === 'min_hold'));
  const gold = { side: 'Long', symbol: 'XAU/USD', status: 'open', sl: 1, tp: 2, fills: [{ t: now - 5.1 * DAY, price: 100, size: 1, lev: 5 }] };
  assert.ok(R.positionFlags(gold, acc(), now).flags.some(f => f.code === 'hold_over'));
});

test('cross-account guard: hedge, coordinated entries, duplicate levels, paper excluded', () => {
  const now = 30 * DAY;
  const accounts = [acc({ id: 'a1' }), acc({ id: 'a2', size: 25000 }), acc({ id: 'p', paper: true, size: 10000 })];
  const trades = [
    { id: 'x', accountId: 'a1', symbol: 'SOL/USDT', side: 'Long', status: 'open', fills: [{ t: now - HOUR, price: 1, size: 1, lev: 5 }] },
    { id: 'y', accountId: 'a2', symbol: 'SOL/USDT', side: 'Short', status: 'open', fills: [{ t: now - HOUR + MIN, price: 1, size: 1, lev: 5 }] },
    { id: 'z', accountId: 'p', symbol: 'SOL/USDT', side: 'Short', status: 'open', fills: [{ t: now - HOUR, price: 1, size: 1, lev: 5 }] }
  ];
  const g = R.crossAccount(accounts, trades, now);
  assert.equal(g.hedges.length, 1);
  assert.equal(g.coordinated.length, 1);
  assert.equal(g.totalOpen, 2);
  assert.deepEqual(g.duplicateLevels, []);
  const dup = R.crossAccount([acc({ id: 'a1' }), acc({ id: 'a3' })], [], now);
  assert.equal(dup.duplicateLevels.length, 1);
});

test('one active challenge per level (size + program)', () => {
  const accounts = [acc({ id: 'a1', size: 10000 }), acc({ id: 'a2', size: 25000, status: 'failed' })];
  assert.equal(R.canAddChallenge(accounts, { program: '2-Step', size: 10000 }).ok, false);
  assert.equal(R.canAddChallenge(accounts, { program: '2-Step', size: 25000 }).ok, true); // failed one doesn't count
  assert.equal(R.canAddChallenge(accounts, { program: '2-Step', size: 50000 }).ok, true);
  assert.equal(R.canAddChallenge(accounts, { program: '2-Step', size: 10000, paper: true }).ok, true);
});

test('pre-trade check blocks a stop-out that would breach daily loss', () => {
  const now = Date.UTC(2026, 10, 1, 12);
  const a = acc({ size: 10000 });
  const trades = [{ id: 't1', accountId: 'a1', symbol: 'BTC/USDT', side: 'Long', status: 'closed', fills: [{ t: now - HOUR, price: 100, size: 4, lev: 5 }], exit: { t: now - 30 * MIN, price: 0 } }]; // -400 today
  const m = R.accountMetrics(a, trades, {}, now);
  const ok = R.preTrade(a, m, { t: now, side: 'Long', price: 100, size: 1, lev: 5, sl: 90, tp: 120 }, null);
  assert.equal(ok.blocked, false);
  near(ok.projectedDailyPct, 4.1);
  const bad = R.preTrade(a, m, { t: now, side: 'Long', price: 100, size: 20, lev: 5, sl: 90, tp: 120 }, null);
  assert.equal(bad.blocked, true); // 400 + 200 = 6%
});

test('pre-trade check counts the total loss limit', () => {
  const now = Date.UTC(2026, 10, 1, 12);
  const a = acc({ size: 10000, priorPnl: -950 });   // $50 of the 10% total limit left
  const m = R.accountMetrics(a, [], {}, now);
  const res = R.preTrade(a, m, { t: now, side: 'Long', price: 100, size: 30, lev: 5, sl: 90, tp: 120 }, null);   // risks $300, daily is quiet
  assert.equal(res.blocked, true);
  near(res.projectedTotalPct, 12.5);
  assert.ok(res.checks.some(c => /total loss reaches 12\.50%, past the 10% limit/.test(c.text)));
  assert.equal(R.preTrade(a, m, { t: now, side: 'Long', price: 100, size: 1, lev: 5, sl: 99, tp: 120 }, null).blocked, false);
});

test('pre-trade check counts the stops on every open position', () => {
  const now = Date.UTC(2026, 10, 1, 12);
  const a = acc({ size: 10000 });
  const open = { id: 'o1', accountId: 'a1', symbol: 'BTC/USDT', side: 'Long', status: 'open', sl: 90, tp: 130, fees: 0, fills: [{ t: now - HOUR, price: 100, size: 40, lev: 5 }] };   // flat now, risks 4%
  const m = R.accountMetrics(a, [open], { 'BTC/USDT': 100 }, now);
  const res = R.preTrade(a, m, { t: now, side: 'Long', price: 100, size: 40, lev: 5, sl: 90, tp: 120 }, null);
  near(res.projectedDailyPct, 8);
  assert.equal(res.blocked, true);
  assert.ok(res.checks.some(c => /If every stop is hit, daily loss reaches 8\.00%/.test(c.text)));
  // a stop locked in profit adds no loss
  const safe = Object.assign({}, open, { sl: 105 });
  const m2 = R.accountMetrics(a, [safe], { 'BTC/USDT': 110 }, now);
  near(R.preTrade(a, m2, { t: now, side: 'Long', price: 100, size: 40, lev: 5, sl: 90, tp: 120 }, null).projectedDailyPct, 4);
  // a position with no stop is called out
  const bare = Object.assign({}, open, { sl: null });
  const m3 = R.accountMetrics(a, [bare], { 'BTC/USDT': 100 }, now);
  assert.ok(R.preTrade(a, m3, { t: now, side: 'Long', price: 100, size: 1, lev: 5, sl: 90, tp: 120 }, null).checks.some(c => /no stop, so the real worst case/.test(c.text)));
  // an add replaces the position's own risk rather than counting it twice
  const add = R.preTrade(a, m, { t: now, price: 100, size: 1, lev: 5, sl: '' }, open);
  near(add.projectedDailyPct, 4.1);
});

test('pre-trade check refuses a stop or target on the wrong side of the entry', () => {
  const now = Date.UTC(2026, 10, 1, 12);
  const a = acc({ size: 10000 }), m = R.accountMetrics(a, [], {}, now);
  const t = o => R.preTrade(a, m, Object.assign({ t: now, side: 'Long', price: 100, size: 1, lev: 5, sl: 90, tp: 120 }, o), null);
  assert.equal(t({}).invalid, false);
  for (const bad of [{ sl: 110 }, { sl: 100 }, { sl: -1.6 }, { tp: 90 }, { side: 'Short', sl: 90, tp: 80 }, { side: 'Short', sl: 110, tp: 120 }]) {
    assert.equal(t(bad).invalid, true, JSON.stringify(bad));
    assert.equal(t(bad).blocked, true, JSON.stringify(bad));
  }
  assert.equal(t({ side: 'Short', sl: 110, tp: 80 }).invalid, false);
});

test('a record with no fills doesn\u2019t crash the rules', () => {
  const now = Date.UTC(2026, 10, 1, 12), a = acc();
  const broken = { id: 'b', accountId: 'a1', symbol: 'BTC/USDT', side: 'Long', status: 'open' };
  assert.doesNotThrow(() => R.positionFlags(broken, a, now));
  assert.doesNotThrow(() => R.crossAccount([a], [broken], now));
  assert.equal(R.rMultiple(broken), null);
});

test('pre-trade check on an add: new average, added risk, averaging-down warning', () => {
  const now = 50 * DAY;
  const a = acc();
  const existing = { id: 'e', accountId: 'a1', symbol: 'ETH/USDT', side: 'Long', status: 'open', sl: 90, tp: 130, fills: [{ t: now - HOUR, price: 100, size: 1, lev: 5 }] };
  const m = R.accountMetrics(a, [existing], { 'ETH/USDT': 95 }, now);
  const res = R.preTrade(a, m, { t: now, price: 95, size: 1, lev: 5, sl: '' }, existing);
  near(res.after.avgEntry, 97.5);
  near(res.after.size, 2);
  near(res.risk, 15);          // (97.5 - 90) * 2
  near(res.addedRisk, 5);      // was 10
  assert.ok(res.checks.some(c => /averaging down/.test(c.text)));
});

test('R-multiple uses the initial stop and first fill', () => {
  const t = { side: 'Long', sl: 90, fees: 0, fills: [{ t: 0, price: 100, size: 1, lev: 5 }], exit: { t: 1, price: 125 } };
  near(R.rMultiple(t), 2.5);
});

test('RSI on a steadily rising series is 100', () => {
  assert.equal(R.rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], 14), 100);
});

test('pair classes follow Bitfunded: 10 named majors, XAU/XAG/TSLA traditional, the rest minor', () => {
  for (const b of ['BTC', 'ETH', 'BNB', 'XRP', 'SOL', 'TRX', 'HYPE', 'ZEC', 'DOGE', 'ADA']) assert.equal(R.assetInfo(b + '/USDT').cls, 'major', b);
  assert.equal(R.assetInfo('AVAX/USDT').cls, 'minor');
  assert.equal(R.assetInfo('PEPE/USDT').cls, 'minor');
  assert.equal(R.assetInfo('NEWCOIN/USDT').cls, 'minor');
  for (const s of ['XAU/USD', 'XAG/USD', 'TSLA/USD']) assert.equal(R.assetInfo(s).cls, 'traditional', s);
  assert.ok(Object.keys(R.ASSETS).length >= 30);
  const now = 20 * DAY;
  const sol = { side: 'Long', symbol: 'SOL/USDT', status: 'open', sl: 1, tp: 2, fills: [{ t: now - 7.5 * DAY, price: 100, size: 1, lev: 5 }] };
  assert.ok(!R.positionFlags(sol, acc(), now).flags.some(f => f.code === 'hold_over' || f.code === 'hold_soon')); // SOL is major: 10 days
  const tsla = { side: 'Long', symbol: 'TSLA/USD', status: 'open', sl: 1, tp: 2, fills: [{ t: now - 5.2 * DAY, price: 100, size: 1, lev: 5 }] };
  assert.ok(R.positionFlags(tsla, acc(), now).flags.some(f => f.code === 'hold_over'));
});

test('symbols pasted from a platform are normalised and classified', () => {
  assert.equal(R.parseSymbol('BTCUSDT'), 'BTC/USDT');
  assert.equal(R.parseSymbol(' btc-usdt '), 'BTC/USDT');
  assert.equal(R.parseSymbol('WLD/USDT'), 'WLD/USDT');
  assert.equal(R.parseSymbol('hype'), 'HYPE/USDT');
  assert.equal(R.parseSymbol('XAUUSD'), 'XAU/USD');
  assert.equal(R.parseSymbol('TSLA'), 'TSLA/USD');
  assert.equal(R.parseSymbol('1000PEPEUSDT'), '1000PEPE/USDT');
  assert.equal(R.parseSymbol('ETHUSDT.P'), 'ETH/USDT');
  assert.equal(R.parseSymbol('not a coin!'), null);
  const a = R.addPair('NEWCOIN/USDT', 0.42);
  assert.equal(a.cls, 'minor'); assert.equal(a.start, 0.42); assert.equal(a.decimals, 4);
  assert.ok(Object.keys(R.ASSETS).length >= 110);
});

test('challenge already started: opening balance, losses already taken today, prior qualifying trades', () => {
  const now = Date.UTC(2026, 10, 2, 12);
  const a = acc({ id: 'a1', size: 25000, stageStartedAt: now - 5 * DAY });
  const trades = [
    { id: 'old', accountId: 'a1', symbol: 'BTC/USDT', side: 'Long', status: 'closed', fills: [{ t: now - 9 * DAY, price: 100, size: 10, lev: 5 }], exit: { t: now - 8 * DAY, price: 50 } }, // previous stage: ignored
    { id: 't1', accountId: 'a1', symbol: 'BTC/USDT', side: 'Long', status: 'closed', fills: [{ t: now - 2 * DAY, price: 100, size: 10, lev: 5 }], exit: { t: now - 2 * DAY + HOUR, price: 120 } } // +200 this stage
  ];
  const base = R.baselineFromBalance(a, trades, 25750);
  near(base.tracked, 200); near(base.priorPnl, 550);
  const b = Object.assign({}, a, { priorPnl: base.priorPnl, priorDayLoss: { day: R.dayBounds(now).start, amount: 300 }, priorQualifying: 3 });
  const m = R.accountMetrics(b, trades, {}, now);
  near(m.equity, 25750);                      // matches the balance on Bitfunded
  near(m.profitPct, 3);
  near(m.dailyLoss, 300);                     // losses already taken today count
  assert.equal(m.qualifyingClosed, 4);        // 3 before tracking + 1 tracked
  const tomorrow = R.accountMetrics(b, trades, {}, now + DAY);
  near(tomorrow.dailyLoss, 0);                // yesterday's carried loss drops off at the reset
});
