/* Sample TEST data for the cockpit. Every record is marked sample: true.
 * Works in the browser (window.makeSample) and in Node (module.exports). */
(function (root) {
  'use strict';
  var R = root.Rules || (typeof require !== 'undefined' ? require('./rules.js') : null);
  var MIN = 60000, HOUR = 3600000, DAY = 86400000;

  var BASE = {};
  Object.keys(R.ASSETS).forEach(function (k) { BASE[k] = R.ASSETS[k].start; });

  function makeSample(now, prices) {
    var px = Object.assign({}, BASE, prices || {});
    var day = R.dayBounds(now);
    // Put "today" events inside the current Bitfunded day, even if it started minutes ago.
    var todayAt = function (minsAgo) { return Math.max(day.start + MIN, now - minsAgo * MIN); };
    var fee = function (n) { return Math.round(n * 0.0004 * 100) / 100; };

    var accounts = [
      { id: 'acc-0', name: '#0 · 10K', bitfundedId: 'BF-TEST-0', program: '2-Step', size: 10000, stage: 'Stage 1', status: 'failed', fee: 0, maxLeverage: 5, startedAt: now - 58 * DAY, stageStartedAt: now - 58 * DAY, outcome: 'Breached daily loss', sample: true },
      { id: 'acc-1', name: '#1 · 10K', bitfundedId: 'BF-TEST-1', program: '2-Step', size: 10000, stage: 'Funded', status: 'active', fee: 0, maxLeverage: 5, startedAt: now - 30 * DAY, stageStartedAt: now - 6 * DAY, outcome: 'Funded', sample: true },
      { id: 'acc-2', name: '#2 · 25K', bitfundedId: 'BF-TEST-2', program: '2-Step', size: 25000, stage: 'Stage 1', status: 'active', fee: 0, maxLeverage: 5, startedAt: now - 12 * DAY, stageStartedAt: now - 12 * DAY, outcome: 'In progress', sample: true },
      { id: 'acc-3', name: '#3 · 50K', bitfundedId: 'BF-TEST-3', program: '2-Step', size: 50000, stage: 'Stage 1', status: 'active', fee: 0, maxLeverage: 5, startedAt: now - 5 * DAY, stageStartedAt: now - 5 * DAY, outcome: 'In progress', sample: true },
      { id: 'acc-p', name: 'Paper · 25K', bitfundedId: '', program: '2-Step', size: 25000, stage: 'Stage 1', status: 'active', paper: true, fee: 0, maxLeverage: 5, startedAt: now - 20 * DAY, stageStartedAt: now - 20 * DAY, outcome: 'Practice', sample: true }
    ];

    var n = 0;
    function trade(o) {
      n += 1;
      var t = Object.assign({
        id: 'trd-' + String(n).padStart(3, '0'), status: 'closed', fees: 0, setup: 'Range reclaim', ideaSource: 'Own idea',
        reason: '', mood: 'Calm', checklist: { playbook: true, sltp: true, risk: true, room: true, cooldown: true },
        verified: true, reviews: [], myReview: null, sample: true, createdAt: o.fills[0].t
      }, o);
      var s = R.summarize(t);
      t.fees = fee(s.notional) + (t.exit ? fee(t.exit.price * s.size) : 0);
      return t;
    }

    var trades = [
      // Account #2 (25K, Demo, Stage 1): history plus losses today, to show the daily-loss warning.
      trade({ accountId: 'acc-2', symbol: 'ETH/USDT', side: 'Long', sl: px['ETH/USDT'] * 0.985, tp: px['ETH/USDT'] * 1.035, setup: 'Range reclaim', ideaSource: '@example_levels',
        fills: [{ t: now - 9 * DAY, price: px['ETH/USDT'] * 0.97, size: 3, lev: 5 }], exit: { t: now - 9 * DAY + 5 * HOUR, price: px['ETH/USDT'] * 0.99, reason: 'Manual' } }),
      trade({ accountId: 'acc-2', symbol: 'BTC/USDT', side: 'Long', sl: px['BTC/USDT'] * 0.982, tp: px['BTC/USDT'] * 1.03, setup: 'Breakout retest', ideaSource: 'Own idea',
        fills: [{ t: now - 6 * DAY, price: px['BTC/USDT'] * 0.99, size: 0.2, lev: 5 }], exit: { t: now - 6 * DAY + 3 * HOUR, price: px['BTC/USDT'] * 0.982, reason: 'Stop loss' } }),
      trade({ accountId: 'acc-2', symbol: 'SOL/USDT', side: 'Long', sl: px['SOL/USDT'] * 0.97, tp: px['SOL/USDT'] * 1.06, setup: 'Momentum', ideaSource: '@example_flow',
        fills: [{ t: now - 3 * DAY, price: px['SOL/USDT'] * 0.95, size: 40, lev: 5 }, { t: now - 3 * DAY + 40 * MIN, price: px['SOL/USDT'] * 0.965, size: 20, lev: 5 }],
        exit: { t: now - 3 * DAY + 4 * HOUR, price: px['SOL/USDT'] * 0.99, reason: 'Take profit' } }),
      trade({ accountId: 'acc-2', symbol: 'ETH/USDT', side: 'Short', sl: px['ETH/USDT'] * 1.01, tp: px['ETH/USDT'] * 0.97, setup: 'Range reclaim', ideaSource: '@example_levels', mood: 'Impatient',
        fills: [{ t: todayAt(150), price: px['ETH/USDT'] * 0.998, size: 14, lev: 5 }], exit: { t: todayAt(120), price: px['ETH/USDT'] * 1.0085, reason: 'Stop loss' } }),
      trade({ accountId: 'acc-2', symbol: 'BTC/USDT', side: 'Long', sl: px['BTC/USDT'] * 0.994, tp: px['BTC/USDT'] * 1.012, setup: 'Breakout retest', ideaSource: 'Own idea', mood: 'Frustrated', reason: 'Wanted to win back the ETH loss',
        checklist: { playbook: false, sltp: true, risk: true, room: true, cooldown: false },
        fills: [{ t: todayAt(95), price: px['BTC/USDT'] * 1.001, size: 0.7, lev: 5 }], exit: { t: todayAt(70), price: px['BTC/USDT'] * 0.9955, reason: 'Manual' },
        myReview: { wentWell: 'Kept the size small.', wentWrong: 'Took it 25 minutes after the ETH stop. No real setup.', followedPlan: 'No', score: 2, submittedAt: todayAt(60) } }),
      // Open on #2
      trade({ accountId: 'acc-2', symbol: 'BTC/USDT', side: 'Long', status: 'open', sl: px['BTC/USDT'] * 0.985, tp: px['BTC/USDT'] * 1.025, setup: 'Breakout retest', ideaSource: 'Own idea',
        fills: [{ t: now - 2 * DAY, price: px['BTC/USDT'] * 0.996, size: 0.15, lev: 5 }] }),
      trade({ accountId: 'acc-2', symbol: 'SOL/USDT', side: 'Short', status: 'open', sl: null, tp: px['SOL/USDT'] * 0.94, setup: 'Momentum', ideaSource: '@example_flow', verified: false,
        fills: [{ t: now - 6 * DAY - 2 * HOUR, price: px['SOL/USDT'] * 0.995, size: 30, lev: 5 }] }),
      // Account #3 (50K, Demo): a SOL long while #2 is short SOL, so the hedge check fires.
      trade({ accountId: 'acc-3', symbol: 'SOL/USDT', side: 'Long', status: 'open', sl: px['SOL/USDT'] * 0.97, tp: px['SOL/USDT'] * 1.05, setup: 'Trend pullback', ideaSource: '@example_macro',
        fills: [{ t: now - 20 * HOUR, price: px['SOL/USDT'] * 0.99, size: 60, lev: 5 }] }),
      trade({ accountId: 'acc-3', symbol: 'XAU/USD', side: 'Long', sl: px['XAU/USD'] * 0.992, tp: px['XAU/USD'] * 1.015, setup: 'Trend pullback', ideaSource: '@example_macro',
        fills: [{ t: now - 4 * DAY, price: px['XAU/USD'] * 0.985, size: 8, lev: 5 }], exit: { t: now - 4 * DAY + 7 * HOUR, price: px['XAU/USD'] * 0.997, reason: 'Manual' } }),
      // Account #1 (10K, Funded = Live)
      trade({ accountId: 'acc-1', symbol: 'ETH/USDT', side: 'Long', sl: px['ETH/USDT'] * 0.985, tp: px['ETH/USDT'] * 1.03, setup: 'Range reclaim', ideaSource: '@example_levels',
        fills: [{ t: now - 5 * DAY, price: px['ETH/USDT'] * 0.975, size: 1, lev: 5 }], exit: { t: now - 5 * DAY + 6 * HOUR, price: px['ETH/USDT'] * 1.0, reason: 'Take profit' } }),
      trade({ accountId: 'acc-1', symbol: 'ETH/USDT', side: 'Long', status: 'open', sl: px['ETH/USDT'] * 0.98, tp: px['ETH/USDT'] * 1.04, setup: 'Range reclaim', ideaSource: '@example_levels',
        fills: [{ t: now - 3 * HOUR, price: px['ETH/USDT'] * 0.995, size: 0.8, lev: 5 }, { t: now - 2 * HOUR, price: px['ETH/USDT'] * 1.002, size: 0.4, lev: 5 }] }),
      // Paper
      trade({ accountId: 'acc-p', symbol: 'XAU/USD', side: 'Long', sl: px['XAU/USD'] * 0.99, tp: px['XAU/USD'] * 1.02, setup: 'Range reclaim', ideaSource: 'Own idea', verified: false,
        fills: [{ t: now - 2 * DAY, price: px['XAU/USD'] * 0.99, size: 5, lev: 5 }], exit: { t: now - 2 * DAY + 5 * HOUR, price: px['XAU/USD'] * 1.008, reason: 'Manual' } })
    ];

    var levels = [
      { id: 'lvl-1', symbol: 'BTC/USDT', price: Math.round(px['BTC/USDT'] * 1.004), note: 'Breakout level', active: true, createdAt: now - HOUR, sample: true },
      { id: 'lvl-2', symbol: 'ETH/USDT', price: Math.round(px['ETH/USDT'] * 0.996 * 100) / 100, note: 'Range support', active: true, createdAt: now - HOUR, sample: true }
    ];

    var socials = [
      { id: 'soc-1', handle: '@example_levels', name: 'Example: levels trader', tag: 'TA', trust: 4, notes: 'Clean range levels', active: true, sample: true },
      { id: 'soc-2', handle: '@example_macro', name: 'Example: macro desk', tag: 'Macro', trust: 5, notes: 'Fed and CPI previews', active: true, sample: true },
      { id: 'soc-3', handle: '@example_flow', name: 'Example: on-chain flows', tag: 'On-chain', trust: 3, notes: 'Exchange flows', active: true, sample: true },
      { id: 'soc-4', handle: '@example_news', name: 'Example: fast headlines', tag: 'News', trust: 3, notes: 'Breaking news', active: false, sample: true }
    ];

    var feed = [
      { id: 'f-1', t: now - 20 * MIN, lane: 'risk', level: 'warn', accountId: 'acc-2', text: 'Sample: daily loss passed 60% of the limit on #2 · 25K' },
      { id: 'f-2', t: now - 70 * MIN, lane: 'setup', text: 'Sample: BTC/USDT reached your breakout level' }
    ];

    return { accounts: accounts, trades: trades, levels: levels, socials: socials, feed: feed, prices: px };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { makeSample: makeSample, BASE: BASE };
  else { root.makeSample = makeSample; root.SAMPLE_BASE = BASE; }
})(typeof window !== 'undefined' ? window : globalThis);
