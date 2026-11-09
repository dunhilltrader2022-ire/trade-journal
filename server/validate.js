'use strict';
/* Checks saved records, so one broken record can't upset the safety loop or the page. Returns what's wrong, or null. */
const pos = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
const time = v => typeof v === 'number' && Number.isFinite(v);
const text = v => typeof v === 'string' && v.length > 0;
const blank = v => v == null || v === '';
const side = v => v === 'Long' || v === 'Short';

function level(v, name) {
  if (blank(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? null : name + ' should be above zero, or blank.';
}
function trade(t) {
  if (!text(t.accountId) || !text(t.symbol)) return 'A trade needs an account and a pair.';
  if (!side(t.side)) return 'A trade needs a side.';
  if (t.status !== 'open' && t.status !== 'closed') return 'A trade must be open or closed.';
  if (!Array.isArray(t.fills) || !t.fills.length) return 'A trade needs at least one fill.';
  for (const f of t.fills) {
    if (!f || !pos(f.price) || !pos(f.size) || !pos(f.lev) || !time(f.t)) return 'Each fill needs a price, size, leverage and time.';
  }
  if (t.fees != null && !(typeof t.fees === 'number' && Number.isFinite(t.fees))) return 'Fees should be a number.';
  if (t.status === 'closed') return t.exit && pos(t.exit.price) && time(t.exit.t) ? null : 'A closed trade needs an exit price and time.';
  return level(t.sl, 'Stop loss') || level(t.tp, 'Take profit');   // older closed trades may hold odd levels, and those can't trigger
}
function order(o) {
  if (!text(o.accountId) || !text(o.symbol) || !text(o.status)) return 'An order needs an account, a pair and a status.';
  if (o.status !== 'working') return null;
  if (!side(o.side) || !pos(Number(o.price)) || !pos(Number(o.size)) || !pos(Number(o.lev))) return 'A working order needs a side, price, size and leverage.';
  return level(o.sl, 'Stop loss') || level(o.tp, 'Take profit');
}
function account(a) {
  if (!text(a.name)) return 'An account needs a name.';
  return pos(Number(a.size)) ? null : 'An account needs a size above zero.';
}
function alertLevel(l) { return text(l.symbol) && pos(Number(l.price)) ? null : 'A price alert needs a pair and a price.'; }

function archived(a) { return a.trade && typeof a.trade === 'object' && text(a.trade.accountId) && text(a.trade.symbol) ? null : 'An archived trade needs its trade record.'; }

const CHECKS = { trades: trade, orders: order, accounts: account, levels: alertLevel, archive: archived };

function validateDoc(coll, doc) { return CHECKS[coll] ? CHECKS[coll](doc) : null; }

/* A backup is all or nothing: nothing is replaced unless every record is sound. */
function validateDump(dump) {
  for (const coll of Object.keys(CHECKS)) {
    const rows = (dump.data || {})[coll];
    if (rows == null) continue;
    if (!Array.isArray(rows)) return coll + ' isn’t a list.';
    for (const r of rows) {
      const bad = r && typeof r === 'object' ? validateDoc(coll, r) : 'Empty record.';
      if (bad) return bad + ' (' + coll + (r && r.id ? ' ' + r.id : '') + ')';
    }
  }
  return null;
}

module.exports = { validateDoc, validateDump };
