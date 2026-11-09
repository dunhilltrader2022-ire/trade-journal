/* Bitfunded rules engine — plain code, no AI.
 * Source: Bitfunded official docs (bitfunded.gitbook.io), checked 1 Nov 2026.
 * Works in the browser (window.Rules) and in Node (module.exports). */
(function (root) {
  'use strict';
  var MIN = 60000, HOUR = 3600000, DAY = 86400000;

  var PROGRAMS = {
    '2-Step': {
      version: 'v2-step · Nov 2026',
      stages: {
        'Stage 1': { dailyLossPct: 5, maxLossPct: 10, targetPct: 8, type: 'Demo' },
        'Stage 2': { dailyLossPct: 5, maxLossPct: 8, targetPct: 5, type: 'Demo' },
        'Funded': { dailyLossPct: 5, maxLossPct: 8, targetPct: null, type: 'Live' }
      },
      maxPositions: 5,
      maxExposurePct: 65,
      maxLeverage: 5,
      minHoldMin: 10,
      minClosedTrades: 2,
      holdCapDays: { major: 10, minor: 7, traditional: 5 },
      reset: { utcOffsetHours: 8, settleMin: 10 },
      dailyLossMode: 'conservative' // realised losses only (wins don't offset) + floating losses
    }
  };
  /* New Bitfunded offer, not yet in their public docs: the owner confirms the 2-Step rules apply, with leverage up to 1:20. */
  PROGRAMS['2-Step 20x'] = Object.assign({}, PROGRAMS['2-Step'], { version: 'v2-step-20x · Nov 2026', maxLeverage: 20 });

  /* Pair catalog. Classes follow Bitfunded's Restricted Trading Practices page:
   * 10 named major cryptos, XAU/XAG/TSLA as traditional (5-day hold), every other crypto is minor.
   * The minor list is a starter set: check which ones Bitfunded's platform offers.
   * base = simulated starting price for the TEST feed only. */
  var MAJORS = ['BTC', 'ETH', 'BNB', 'XRP', 'SOL', 'TRX', 'HYPE', 'ZEC', 'DOGE', 'ADA'];
  var TRADITIONAL = { XAU: { unit: 'oz', base: 2341.5, quote: 'USD' }, XAG: { unit: 'oz', base: 29.4, quote: 'USD' }, TSLA: { unit: 'shares', base: 248.6, quote: 'USD' } };
  var CRYPTO_BASE = {
    BTC: 67400, ETH: 3420, BNB: 612, XRP: 0.62, SOL: 162.4, TRX: 0.161, HYPE: 31.5, ZEC: 54.2, DOGE: 0.158, ADA: 0.58,
    AVAX: 34.8, LINK: 17.6, DOT: 6.9, LTC: 84.2, BCH: 452, NEAR: 6.1, SUI: 1.82, APT: 9.4, ARB: 0.92, OP: 2.1,
    TON: 6.8, INJ: 24.6, ATOM: 8.1, UNI: 9.8, AAVE: 152, PEPE: 0.0000118, WIF: 2.45, SHIB: 0.0000242,
    ETC: 26, FIL: 5.2, ICP: 9.5, HBAR: 0.075, XLM: 0.11, VET: 0.025, ALGO: 0.16, EGLD: 32, SAND: 0.35, MANA: 0.33,
    AXS: 6.1, GALA: 0.025, IMX: 1.6, RENDER: 6.8, FET: 1.4, TAO: 420, WLD: 2.3, SEI: 0.42, TIA: 6.2, JUP: 0.95,
    PYTH: 0.38, ONDO: 1.05, ENA: 0.6, STRK: 0.55, MKR: 2400, LDO: 1.85, CRV: 0.38, SNX: 2.1, COMP: 52, DYDX: 1.6,
    GMX: 26, PENDLE: 4.5, RUNE: 4.8, KAS: 0.16, STX: 1.9, ORDI: 38, BONK: 0.000025, FLOKI: 0.00018, POPCAT: 0.9, BOME: 0.009,
    NOT: 0.016, TRUMP: 12, JTO: 2.8, W: 0.35, ZRO: 3.6, BLUR: 0.27, GRT: 0.21, THETA: 1.6, KAVA: 0.45, ROSE: 0.08,
    MINA: 0.6, XMR: 165, EOS: 0.65, NEO: 11, IOTA: 0.2, QNT: 70, CHZ: 0.08, APE: 1.1, '1INCH': 0.36, ENS: 21,
    CAKE: 2.3, SUSHI: 0.9, ZK: 0.17, AR: 28, BERA: 5.5, VIRTUAL: 1.6, FARTCOIN: 1.1, PENGU: 0.012, MOVE: 0.45, S: 0.55,
    JASMY: 0.025, CFX: 0.15, AEVO: 0.35, MEME: 0.011, PEOPLE: 0.06, ID: 0.35, CELO: 0.6, ZETA: 0.6, ALT: 0.12, MANTA: 0.9
  };
  var MEMES = ['DOGE', 'PEPE', 'WIF', 'SHIB', 'BONK', 'FLOKI', 'POPCAT', 'BOME', 'TRUMP', 'FARTCOIN', 'PENGU', 'MEME', 'PEOPLE', 'NOT'];
  function classify(base) { return MAJORS.indexOf(base) >= 0 ? 'major' : TRADITIONAL[base] ? 'traditional' : 'minor'; }
  function decimalsFor(p) { return p >= 1000 ? 1 : p >= 10 ? 2 : p >= 1 ? 3 : p >= 0.01 ? 4 : p >= 0.0001 ? 6 : 8; }
  var ASSETS = {};
  Object.keys(CRYPTO_BASE).forEach(function (b) {
    var cls = classify(b), meme = MEMES.indexOf(b) >= 0;
    ASSETS[b + '/USDT'] = { base: b, cls: cls, unit: b, start: CRYPTO_BASE[b], decimals: decimalsFor(CRYPTO_BASE[b]), vol: meme ? 0.002 : cls === 'major' ? 0.0008 : 0.0014 };
  });
  Object.keys(TRADITIONAL).forEach(function (b) {
    var t = TRADITIONAL[b];
    ASSETS[b + '/' + t.quote] = { base: b, cls: 'traditional', unit: t.unit, start: t.base, decimals: b === 'XAG' ? 3 : 2, vol: b === 'TSLA' ? 0.0007 : 0.0003 };
  });
  /* Turn what a platform shows ("BTCUSDT", "btc-usdt", "BTC/USDT", "BTC", "XAUUSD") into our symbol. */
  function parseSymbol(raw) {
    var t = String(raw || '').trim().toUpperCase().replace(/\s+/g, '').replace(/[-_:]/g, '/').replace(/\.P$|PERP$|\/PERP$/, '');
    if (!t) return null;
    var base, quote;
    if (t.indexOf('/') > 0) { var parts = t.split('/'); base = parts[0]; quote = parts[1] || ''; }
    else {
      var m = t.match(/^(.+?)(USDT|USDC|USD)$/);
      if (m && m[1]) { base = m[1]; quote = m[2]; } else { base = t; quote = ''; }
    }
    if (!/^[A-Z0-9]{1,15}$/.test(base)) return null;
    if (TRADITIONAL[base]) return base + '/USD';
    return base + '/' + (quote === 'USDC' ? 'USDC' : 'USDT');
  }
  /* Register a pair that isn't in the built-in list (a coin from the user's Bitfunded list). */
  function addPair(sym, start) {
    if (ASSETS[sym]) { if (start > 0) { ASSETS[sym].start = start; ASSETS[sym].decimals = decimalsFor(start); } return ASSETS[sym]; }
    var base = sym.split('/')[0], cls = classify(base), p = start > 0 ? start : 1;
    ASSETS[sym] = { base: base, cls: cls, unit: base, start: p, decimals: decimalsFor(p), vol: MEMES.indexOf(base) >= 0 ? 0.002 : cls === 'major' ? 0.0008 : 0.0014, custom: true, priceGuessed: !(start > 0) };
    return ASSETS[sym];
  }
  function assetInfo(sym) {
    if (ASSETS[sym]) return ASSETS[sym];
    var base = String(sym).split('/')[0].toUpperCase();
    return { base: base, cls: classify(base), unit: base, start: 1, decimals: 4, vol: 0.0014 };
  }
  var CLASS_LABEL = { major: 'Major crypto · 10-day hold', minor: 'Minor crypto · 7-day hold', traditional: 'Gold, silver, TSLA · 5-day hold' };

  function rulesFor(acc) {
    var p = PROGRAMS[acc.program] || PROGRAMS['2-Step'];
    var s = p.stages[acc.stage] || p.stages['Stage 1'];
    return {
      version: acc.rulesVersion || p.version,
      dailyLossPct: s.dailyLossPct, maxLossPct: s.maxLossPct, targetPct: s.targetPct,
      maxPositions: p.maxPositions, maxExposurePct: p.maxExposurePct,
      maxLeverage: acc.maxLeverage || p.maxLeverage,
      minHoldMin: p.minHoldMin, minClosedTrades: p.minClosedTrades,
      holdCapDays: p.holdCapDays, reset: p.reset, dailyLossMode: p.dailyLossMode
    };
  }

  function accountType(acc) {
    if (acc.paper) return 'Paper';
    var p = PROGRAMS[acc.program] || PROGRAMS['2-Step'];
    var s = p.stages[acc.stage] || p.stages['Stage 1'];
    return s.type;
  }

  /* The Bitfunded day. Nominal reset is 00:00 at UTC+8; settlement can land up to
   * settleMin later, so the app keeps the old day until the settlement window closes. */
  function dayBounds(now, reset) {
    reset = reset || PROGRAMS['2-Step'].reset;
    var off = reset.utcOffsetHours * HOUR, settle = reset.settleMin * MIN;
    var start = Math.floor((now - settle + off) / DAY) * DAY - off + settle;
    return {
      start: start,
      end: start + DAY,
      nominalReset: start + DAY - settle,
      settleEnd: start + DAY,
      inSettlement: now >= start + DAY - settle - 0 && now < start + DAY ? true : false
    };
  }

  function dir(t) { return t.side === 'Short' ? -1 : 1; }

  function summarize(trade) {
    var size = 0, notional = 0, margin = 0, maxLev = 0;
    (trade.fills || []).forEach(function (f) {
      size += f.size; notional += f.price * f.size; margin += f.price * f.size / f.lev;
      if (f.lev > maxLev) maxLev = f.lev;
    });
    var avg = size ? notional / size : 0;
    return {
      size: size, avgEntry: avg, notional: notional, margin: margin,
      effLeverage: margin ? notional / margin : 0, maxFillLeverage: maxLev,
      openedAt: trade.fills && trade.fills.length ? trade.fills[0].t : null
    };
  }

  function pnlAt(trade, price) {
    var s = summarize(trade);
    return dir(trade) * (price - s.avgEntry) * s.size - (trade.fees || 0);
  }

  function realized(trade) {
    if (!trade.exit) return 0;
    return pnlAt(trade, trade.exit.price);
  }

  /* Loss if the stop is hit, as a positive number. null when there is no stop. */
  function riskToStop(trade) {
    if (trade.sl == null || trade.sl === '') return null;
    var s = summarize(trade);
    return dir(trade) * (s.avgEntry - trade.sl) * s.size + (trade.fees || 0);
  }

  function rMultiple(trade) {
    var first = { side: trade.side, sl: trade.sl, fills: (trade.fills || []).slice(0, 1), fees: 0 };
    var r = riskToStop(first);
    if (!r || r <= 0 || !trade.exit) return null;
    return realized(trade) / r;
  }

  function level(ratio) {
    if (ratio >= 1) return 'breach';
    if (ratio >= 0.9) return 'danger';
    if (ratio >= 0.6) return 'warn';
    return 'ok';
  }

  function accountMetrics(acc, trades, prices, now) {
    var cfg = rulesFor(acc);
    var mine = trades.filter(function (t) { return t.accountId === acc.id; });
    var open = mine.filter(function (t) { return t.status === 'open'; });
    var closed = mine.filter(function (t) { return t.status === 'closed'; });
    var day = dayBounds(now, cfg.reset);

    var stageStart = acc.stageStartedAt || acc.startedAt || 0;
    /* Balance for the current stage: what Bitfunded showed when tracking began (priorPnl),
     * plus trades closed in this stage. A new stage starts from the account size again. */
    var realizedAll = Number(acc.priorPnl) || 0, realizedLossToday = 0, realizedNetToday = 0;
    var pdl = acc.priorDayLoss;
    if (pdl && pdl.day === day.start && pdl.amount > 0) { realizedLossToday += Number(pdl.amount); realizedNetToday -= Number(pdl.amount); }
    closed.forEach(function (t) {
      var r = realized(t);
      if (t.exit.t >= stageStart) realizedAll += r;
      if (t.exit.t >= day.start && t.exit.t < day.end) {
        realizedNetToday += r;
        if (r < 0) realizedLossToday += -r;
      }
    });
    var unrealized = 0, floatingLoss = 0, margin = 0, openRisks = [];
    open.forEach(function (t) {
      var px = prices[t.symbol];
      var u = px == null ? 0 : pnlAt(t, px);
      unrealized += u;
      if (u < 0) floatingLoss += -u;
      margin += summarize(t).margin;
      var hasStop = Number(t.sl) > 0;
      openRisks.push({ id: t.id, hasStop: hasStop, atStop: hasStop ? pnlAt(t, Number(t.sl)) : u });
    });

    var size = acc.size;
    var equity = size + realizedAll + unrealized;
    var realizedPart = cfg.dailyLossMode === 'net' ? Math.max(0, -realizedNetToday) : realizedLossToday;
    var dailyLoss = realizedPart + floatingLoss;
    var dailyLossPct = dailyLoss / size * 100;
    var totalLossPct = Math.max(0, (size - equity) / size * 100);
    var profitPct = (equity - size) / size * 100;
    var exposurePct = equity > 0 ? margin / equity * 100 : 100;
    var qualifying = (Number(acc.priorQualifying) || 0) + closed.filter(function (t) {
      var o = summarize(t).openedAt;
      return o >= stageStart && t.exit.t - o >= cfg.minHoldMin * MIN;
    }).length;

    var gauges = [
      { key: 'daily', label: 'Daily loss', value: dailyLossPct, limit: cfg.dailyLossPct, unit: '%', ratio: dailyLossPct / cfg.dailyLossPct },
      { key: 'total', label: 'Total loss', value: totalLossPct, limit: cfg.maxLossPct, unit: '%', ratio: totalLossPct / cfg.maxLossPct },
      { key: 'positions', label: 'Open positions', value: open.length, limit: cfg.maxPositions, unit: '', ratio: open.length / cfg.maxPositions },
      { key: 'exposure', label: 'Margin exposure', value: exposurePct, limit: cfg.maxExposurePct, unit: '%', ratio: exposurePct / cfg.maxExposurePct }
    ];
    gauges.forEach(function (g) { g.level = level(g.ratio); });
    // Positions: being AT the cap is allowed; only exceeding it is a breach.
    var pg = gauges[2];
    pg.level = open.length > cfg.maxPositions ? 'breach' : open.length === cfg.maxPositions ? 'danger' : pg.ratio >= 0.6 ? 'warn' : 'ok';

    return {
      cfg: cfg, day: day, equity: equity, realizedAll: realizedAll, unrealized: unrealized,
      realizedPart: realizedPart, openRisks: openRisks, dailyLoss: dailyLoss, dailyLossPct: dailyLossPct, dailyRoom: cfg.dailyLossPct / 100 * size - dailyLoss,
      totalLossPct: totalLossPct, totalRoom: equity - size * (1 - cfg.maxLossPct / 100), profitPct: profitPct, targetPct: cfg.targetPct,
      openCount: open.length, margin: margin, exposurePct: exposurePct,
      qualifyingClosed: qualifying, gauges: gauges,
      breached: gauges.some(function (g) { return g.level === 'breach'; })
    };
  }

  function positionFlags(trade, acc, now) {
    var cfg = rulesFor(acc);
    var s = summarize(trade);
    var flags = [];
    if (trade.sl == null || trade.sl === '') flags.push({ code: 'no_sl', level: 'danger', text: 'No stop loss' });
    if (trade.tp == null || trade.tp === '') flags.push({ code: 'no_tp', level: 'warn', text: 'No take profit' });
    if (s.maxFillLeverage > cfg.maxLeverage) flags.push({ code: 'leverage', level: 'danger', text: 'Leverage above 1:' + cfg.maxLeverage });
    var cls = assetInfo(trade.symbol).cls;
    var cap = cfg.holdCapDays[cls] * DAY;
    var held = now - s.openedAt;
    var holdLeft = cap - held;
    if (trade.status === 'open') {
      if (holdLeft <= 0) flags.push({ code: 'hold_over', level: 'breach', text: 'Hold limit passed' });
      else if (holdLeft < DAY) flags.push({ code: 'hold_soon', level: 'warn', text: 'Hold limit within 24h' });
      if (held < cfg.minHoldMin * MIN) flags.push({ code: 'min_hold', level: 'warn', text: 'Under 10 min: closing now won’t count for payout' });
    }
    var runSize = 0, runNotional = 0;
    (trade.fills || []).forEach(function (f, i) {
      if (i > 0) {
        var avg = runNotional / runSize;
        if (dir(trade) * (f.price - avg) < 0) flags.push({ code: 'avg_down', level: 'warn', text: 'Fill ' + (i + 1) + ' averaged down' });
      }
      runSize += f.size; runNotional += f.price * f.size;
    });
    return { flags: flags, holdLeftMs: holdLeft, heldMs: held, holdCapMs: cap };
  }

  /* Rules that apply across all your real (Demo and Live) accounts. */
  function crossAccount(accounts, trades, now) {
    var real = accounts.filter(function (a) { return !a.paper && a.status === 'active'; });
    var ids = {}; real.forEach(function (a) { ids[a.id] = a; });
    var open = trades.filter(function (t) { return t.status === 'open' && ids[t.accountId]; });

    var hedges = [];
    var bySym = {};
    open.forEach(function (t) { (bySym[t.symbol] = bySym[t.symbol] || []).push(t); });
    Object.keys(bySym).forEach(function (sym) {
      var ts = bySym[sym];
      ts.forEach(function (a, i) {
        ts.slice(i + 1).forEach(function (b) {
          if (a.side !== b.side && a.accountId !== b.accountId) hedges.push({ symbol: sym, a: a.id, b: b.id, accounts: [a.accountId, b.accountId] });
        });
      });
    });

    var coordinated = [];
    var recent = trades.filter(function (t) { return ids[t.accountId] && t.fills && t.fills.length && now - t.fills[0].t < DAY; });
    recent.forEach(function (a, i) {
      recent.slice(i + 1).forEach(function (b) {
        if (a.symbol === b.symbol && a.accountId !== b.accountId && Math.abs(a.fills[0].t - b.fills[0].t) <= 2 * MIN) {
          coordinated.push({ symbol: a.symbol, a: a.id, b: b.id, accounts: [a.accountId, b.accountId] });
        }
      });
    });

    var levels = {}, dupes = [];
    real.forEach(function (a) {
      var k = a.program + '|' + a.size;
      if (levels[k]) dupes.push(k); else levels[k] = true;
    });

    var cap = PROGRAMS['2-Step'].maxPositions;
    return {
      hedges: hedges, coordinated: coordinated, duplicateLevels: dupes,
      totalOpen: open.length, positionCap: cap,
      positionLevel: open.length > cap ? 'breach' : open.length === cap ? 'danger' : open.length / cap >= 0.6 ? 'warn' : 'ok'
    };
  }

  /* Bitfunded balance (closed P/L only) -> the opening P/L the cockpit should assume for this stage,
   * so tracked trades plus that baseline add up to the balance Bitfunded shows. */
  function baselineFromBalance(acc, trades, balance) {
    var stageStart = acc.stageStartedAt || acc.startedAt || 0, tracked = 0;
    trades.forEach(function (t) { if (t.accountId === acc.id && t.status === 'closed' && t.exit.t >= stageStart) tracked += realized(t); });
    return { priorPnl: Number(balance) - acc.size - tracked, tracked: tracked };
  }
  function canAddChallenge(accounts, draft) {
    if (draft.paper) return { ok: true };
    var clash = accounts.filter(function (a) {
      return !a.paper && a.status === 'active' && a.program === draft.program && Number(a.size) === Number(draft.size);
    });
    return clash.length ? { ok: false, reason: 'You already have an active ' + draft.program + ' ' + fmtSize(draft.size) + ' challenge (' + clash[0].name + '). Bitfunded allows one active challenge per level.' } : { ok: true };
  }

  function fmtSize(n) { return n >= 1000 ? (n / 1000) + 'K' : String(n); }

  /* Pre-trade check for a new position or an add. */
  function preTrade(acc, metrics, ticket, existing) {
    var cfg = rulesFor(acc);
    var checks = [];
    var fill = { t: ticket.t, price: Number(ticket.price), size: Number(ticket.size), lev: Number(ticket.lev) };
    var sim = existing
      ? Object.assign({}, existing, { fills: existing.fills.concat([fill]), sl: ticket.sl !== '' && ticket.sl != null ? Number(ticket.sl) : existing.sl })
      : { side: ticket.side, sl: ticket.sl === '' || ticket.sl == null ? null : Number(ticket.sl), tp: ticket.tp, fills: [fill], fees: 0 };
    var risk = riskToStop(sim);
    var currentRisk = existing ? (riskToStop(existing) || 0) : 0;
    var addedRisk = risk == null ? null : risk - currentRisk;

    /* A stop or target already past the entry can never work as one, and the safety loop would close the trade at once. */
    var long = (existing || ticket).side === 'Long', invalid = false;
    var slGiven = ticket.sl !== '' && ticket.sl != null, tpGiven = ticket.tp !== '' && ticket.tp != null;
    var slVal = Number(ticket.sl), tpVal = Number(ticket.tp);
    var slBad = slGiven && (!(slVal > 0) || (long ? slVal >= fill.price : slVal <= fill.price));
    var tpBad = tpGiven && (!(tpVal > 0) || (long ? tpVal <= fill.price : tpVal >= fill.price));
    if (sim.sl == null) checks.push({ ok: false, level: 'danger', text: 'Set a stop loss. Trading without one can be flagged at payout review.' });
    else if (slBad) { invalid = true; checks.push({ ok: false, level: 'breach', text: 'That stop is on the wrong side of your entry. A ' + (long ? 'long' : 'short') + ' needs its stop ' + (long ? 'below' : 'above') + ' the entry price.' }); }
    else checks.push({ ok: true, text: 'Stop loss set' });
    if (tpBad) { invalid = true; checks.push({ ok: false, level: 'breach', text: 'That target is on the wrong side of your entry. A ' + (long ? 'long' : 'short') + ' needs its target ' + (long ? 'above' : 'below') + ' the entry price.' }); }
    else if (!existing && !tpGiven) checks.push({ ok: false, level: 'warn', text: 'Set a take profit.' });
    if (fill.lev > cfg.maxLeverage) checks.push({ ok: false, level: 'danger', text: fill.lev + 'x is above this account’s maximum of 1:' + cfg.maxLeverage + '.' });
    else checks.push({ ok: true, text: 'Leverage within 1:' + cfg.maxLeverage });
    if (!existing) {
      if (metrics.openCount + 1 > cfg.maxPositions) checks.push({ ok: false, level: 'breach', text: 'This would be position ' + (metrics.openCount + 1) + ' of a maximum ' + cfg.maxPositions + '.' });
      else checks.push({ ok: true, text: 'Position ' + (metrics.openCount + 1) + ' of ' + cfg.maxPositions });
    }
    var newMargin = fill.price * fill.size / fill.lev;
    var expAfter = (metrics.margin + newMargin) / Math.max(metrics.equity, 1) * 100;
    if (expAfter > cfg.maxExposurePct) checks.push({ ok: false, level: 'breach', text: 'Exposure would be ' + expAfter.toFixed(0) + '% of margin (max ' + cfg.maxExposurePct + '%).' });
    else checks.push({ ok: true, text: 'Exposure after: ' + expAfter.toFixed(0) + '% of ' + cfg.maxExposurePct + '%' });

    /* The real worst case: this trade and every other open position all reach their stops. */
    var others = (metrics.openRisks || []).filter(function (x) { return !existing || x.id !== existing.id; });
    var otherLoss = 0, otherPnl = 0, noStop = 0;
    others.forEach(function (x) { otherLoss += Math.max(0, -x.atStop); otherPnl += x.atStop; if (!x.hasStop) noStop++; });
    var ifHit = others.length ? 'If every stop is hit' : 'If the stop is hit';
    var projected = null, projectedTotal = null;
    if (addedRisk != null) {
      var realizedPart = metrics.realizedPart != null ? metrics.realizedPart : metrics.dailyLoss;
      projected = (realizedPart + otherLoss + Math.max(0, risk)) / acc.size * 100;
      var lv = level(projected / cfg.dailyLossPct);
      if (lv === 'breach') checks.push({ ok: false, level: 'breach', text: ifHit + ', daily loss reaches ' + projected.toFixed(2) + '%, past the ' + cfg.dailyLossPct + '% limit.' });
      else if (lv === 'danger' || lv === 'warn') checks.push({ ok: false, level: lv, text: ifHit + ', daily loss reaches ' + projected.toFixed(2) + '% of ' + cfg.dailyLossPct + '%.' });
      else checks.push({ ok: true, text: (others.length ? 'All stops hit keeps' : 'Stop-out keeps') + ' daily loss at ' + projected.toFixed(2) + '%' });

      var realizedAll = metrics.realizedAll || 0;
      projectedTotal = Math.max(0, -(realizedAll + otherPnl - Math.max(0, risk)) / acc.size * 100);
      var lt = level(projectedTotal / cfg.maxLossPct);
      if (lt === 'breach') checks.push({ ok: false, level: 'breach', text: ifHit + ', total loss reaches ' + projectedTotal.toFixed(2) + '%, past the ' + cfg.maxLossPct + '% limit.' });
      else if (lt === 'danger' || lt === 'warn') checks.push({ ok: false, level: lt, text: ifHit + ', total loss reaches ' + projectedTotal.toFixed(2) + '% of ' + cfg.maxLossPct + '%.' });
      else checks.push({ ok: true, text: (others.length ? 'All stops hit keeps' : 'Stop-out keeps') + ' total loss at ' + projectedTotal.toFixed(2) + '%' });
    }
    if (noStop) checks.push({ ok: false, level: 'warn', text: noStop + ' other open position' + (noStop > 1 ? 's have' : ' has') + ' no stop, so the real worst case is larger than shown.' });
    if (existing) {
      var s = summarize(existing);
      if (dir(existing) * (fill.price - s.avgEntry) < 0) checks.push({ ok: false, level: 'warn', text: 'This add is ' + (existing.side === 'Long' ? 'below' : 'above') + ' your average entry: averaging down.' });
    }
    var blocked = checks.some(function (c) { return c.level === 'breach'; });
    return { checks: checks, risk: risk, addedRisk: addedRisk, projectedDailyPct: projected, projectedTotalPct: projectedTotal, after: summarize(sim), blocked: blocked, invalid: invalid, exposureAfterPct: expAfter };
  }

  function rsi(closes, period) {
    period = period || 14;
    if (closes.length <= period) return null;
    var gain = 0, loss = 0, i;
    for (i = 1; i <= period; i++) {
      var d = closes[i] - closes[i - 1];
      if (d > 0) gain += d; else loss -= d;
    }
    gain /= period; loss /= period;
    for (i = period + 1; i < closes.length; i++) {
      var d2 = closes[i] - closes[i - 1];
      gain = (gain * (period - 1) + Math.max(d2, 0)) / period;
      loss = (loss * (period - 1) + Math.max(-d2, 0)) / period;
    }
    if (loss === 0) return 100;
    return 100 - 100 / (1 + gain / loss);
  }

  var api = {
    PROGRAMS: PROGRAMS, ASSETS: ASSETS, MAJORS: MAJORS, CLASS_LABEL: CLASS_LABEL, assetInfo: assetInfo, parseSymbol: parseSymbol, addPair: addPair, MIN: MIN, HOUR: HOUR, DAY: DAY,
    rulesFor: rulesFor, accountType: accountType, dayBounds: dayBounds, summarize: summarize,
    pnlAt: pnlAt, realized: realized, riskToStop: riskToStop, rMultiple: rMultiple, level: level,
    accountMetrics: accountMetrics, positionFlags: positionFlags, crossAccount: crossAccount,
    canAddChallenge: canAddChallenge, baselineFromBalance: baselineFromBalance, preTrade: preTrade, rsi: rsi, fmtSize: fmtSize
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Rules = api;
})(typeof window !== 'undefined' ? window : globalThis);
