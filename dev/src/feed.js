/* Default CoinGecko coin ids for the built-in pairs. Best-effort mapping, to be verified
 * against CoinGecko once the connector is connected; the user can edit any of them. */
var CG_IDS = {
  BTC: 'bitcoin', ETH: 'ethereum', BNB: 'binancecoin', XRP: 'ripple', SOL: 'solana', TRX: 'tron', HYPE: 'hyperliquid', ZEC: 'zcash', DOGE: 'dogecoin', ADA: 'cardano',
  AVAX: 'avalanche-2', LINK: 'chainlink', DOT: 'polkadot', LTC: 'litecoin', BCH: 'bitcoin-cash', NEAR: 'near', SUI: 'sui', APT: 'aptos', ARB: 'arbitrum', OP: 'optimism',
  TON: 'the-open-network', INJ: 'injective-protocol', ATOM: 'cosmos', UNI: 'uniswap', AAVE: 'aave', PEPE: 'pepe', WIF: 'dogwifcoin', SHIB: 'shiba-inu',
  ETC: 'ethereum-classic', FIL: 'filecoin', ICP: 'internet-computer', HBAR: 'hedera-hashgraph', XLM: 'stellar', VET: 'vechain', ALGO: 'algorand', EGLD: 'elrond-erd-2',
  SAND: 'the-sandbox', MANA: 'decentraland', AXS: 'axie-infinity', GALA: 'gala', IMX: 'immutable-x', RENDER: 'render-token', FET: 'fetch-ai', TAO: 'bittensor',
  WLD: 'worldcoin-wld', SEI: 'sei-network', TIA: 'celestia', JUP: 'jupiter-exchange-solana', PYTH: 'pyth-network', ONDO: 'ondo-finance', ENA: 'ethena', STRK: 'starknet',
  MKR: 'maker', LDO: 'lido-dao', CRV: 'curve-dao-token', SNX: 'havven', COMP: 'compound-governance-token', DYDX: 'dydx-chain', GMX: 'gmx', PENDLE: 'pendle',
  RUNE: 'thorchain', KAS: 'kaspa', STX: 'blockstack', ORDI: 'ordinals', BONK: 'bonk', FLOKI: 'floki', POPCAT: 'popcat', BOME: 'book-of-meme', NOT: 'notcoin',
  TRUMP: 'official-trump', JTO: 'jito-governance-token', W: 'wormhole', ZRO: 'layerzero', BLUR: 'blur', GRT: 'the-graph', THETA: 'theta-token', KAVA: 'kava',
  ROSE: 'oasis-network', MINA: 'mina-protocol', XMR: 'monero', EOS: 'eos', NEO: 'neo', IOTA: 'iota', QNT: 'quant-network', CHZ: 'chiliz', APE: 'apecoin',
  '1INCH': '1inch', ENS: 'ethereum-name-service', CAKE: 'pancakeswap-token', SUSHI: 'sushi', ZK: 'zksync', AR: 'arweave', BERA: 'berachain-bera',
  VIRTUAL: 'virtual-protocol', FARTCOIN: 'fartcoin', PENGU: 'pudgy-penguins', MOVE: 'movement', S: 'sonic-3', JASMY: 'jasmycoin', CFX: 'conflux-token',
  AEVO: 'aevo-exchange', MEME: 'memecoin-2', PEOPLE: 'constitutiondao', ID: 'space-id', CELO: 'celo', ZETA: 'zetachain', ALT: 'altlayer', MANTA: 'manta-network'
};
var FEED_SOURCES = { simulated: 'Simulated', coingecko: 'CoinGecko', binance: 'Binance', kraken: 'Kraken' };
function feedSettings() { return Object.assign({ source: 'simulated', refreshSec: 15, ids: {} }, (Store.meta.settings && Store.meta.settings.feed) || {}); }
function saveFeed(patch) { setMeta('settings', Object.assign({}, Store.meta.settings, { feed: Object.assign(feedSettings(), patch) })); }
/* The CoinGecko id for a pair: your mapping, then the built-in one, then none. Traditional instruments have no spot price there. */
function cgIdFor(sym) {
  var a = R.assetInfo(sym);
  if (a.cls === 'traditional') return { id: null, how: 'none' };
  var mine = feedSettings().ids[sym];
  if (mine) return { id: mine, how: 'yours' };
  var base = a.base.replace(/^1000+/, '');
  if (CG_IDS[base]) return { id: CG_IDS[base], how: base !== a.base ? 'scaled' : 'built-in' };
  return { id: null, how: 'missing' };
}
var CG = { connected: false };  // flips to true once the connector is wired in

function feedRowsHTML() {
  if (Store.mode === 'server') return feedPairsHTML();
  var q = (ui.feedQ || '').trim().toUpperCase(), filt = ui.feedFilter || 'all';
  var rows = enabledSyms().slice().sort().filter(function (s) {
    var m = cgIdFor(s);
    if (q && s.indexOf(q) < 0 && (m.id || '').toUpperCase().indexOf(q) < 0) return false;
    if (filt === 'check') return m.how === 'missing' || m.how === 'scaled';
    return true;
  });
  if (!rows.length) return '<div class="empty">' + (filt === 'check' ? 'Every pair in use has a coin id.' : 'No pairs match.') + '</div>';
  var label = { yours: ['accent', 'Your mapping'], 'built-in': ['', 'Built-in, to verify'], scaled: ['warn', 'Scaled pair, check units'], missing: ['danger', 'Needs a coin id'], none: ['', 'No spot price on CoinGecko, stays simulated'] };
  return '<div class="scroll" style="max-height:560px;overflow-y:auto"><table><thead><tr><th>Pair</th><th>CoinGecko coin id</th><th>Status</th></tr></thead><tbody>' + rows.map(function (s) {
    var m = cgIdFor(s), id = 'cg-' + s.replace(/[^A-Z0-9]/g, '-'), l = label[m.how];
    return '<tr><td><strong>' + s + '</strong></td><td>' + (m.how === 'none' ? '<span class="muted">—</span>' :
      '<label class="sr" for="' + id + '">CoinGecko id for ' + s + '</label><input id="' + id + '" type="text" data-fresh="1" data-cgsym="' + s + '" value="' + esc(m.id || '') + '" placeholder="e.g. bitcoin" style="min-height:34px;max-width:260px">') + '</td>' +
      '<td><span class="tag ' + l[0] + '">' + l[1] + '</span></td></tr>';
  }).join('') + '</tbody></table></div>';
}
function feedLiveHTML() {
  var snap = Feed.snap, src = snap ? snap.source : 'simulated', st = (snap && snap.status) || {};
  var srcMap = Sim.src || {}, used = enabledSyms();
  var live = used.filter(function (x) { return srcMap[x] === 'live'; }).length, stale = used.filter(function (x) { return srcMap[x] === 'stale'; }).length;
  var stateText = src === 'simulated' ? 'Simulated prices' : Store.serverDown ? 'Server not answering' : st.state === 'connected' ? 'Connected' : st.state === 'connecting' ? 'Connecting\u2026' : st.state === 'reconnecting' ? 'Reconnecting (' + (st.error || 'connection lost') + ')' : st.state === 'stale' ? 'No prices for ' + Math.round((st.lastMessageAgoMs || 0) / 1000) + ' s' : st.state || '\u2014';
  var ok = src === 'simulated' || (st.state === 'connected' && st.lastMessageAgoMs != null && st.lastMessageAgoMs < 30000);
  return '<div class="kv"><div><div class="k">Source</div><div class="v">' + esc(FEED_SOURCES[src] || src) + '</div></div>' +
    '<div><div class="k">Status</div><div class="v ' + (ok ? 'c-good' : 'c-danger') + '" style="font-size:14px">' + esc(stateText) + '</div></div>' +
    '<div><div class="k">Last price</div><div class="v">' + (src === 'simulated' ? '\u2014' : st.lastMessageAgoMs == null ? 'None yet' : (st.lastMessageAgoMs / 1000).toFixed(1) + ' s ago') + '</div></div>' +
    '<div><div class="k">Pairs live</div><div class="v">' + live + ' / ' + used.length + (stale ? ' <small>(' + stale + ' stale)</small>' : '') + '</div></div></div>';
}
function feedPairsHTML() {
  var q = (ui.feedQ || '').trim().toUpperCase(), srcMap = Sim.src || {};
  var rows = enabledSyms().slice().sort().filter(function (x) { return !q || x.indexOf(q) >= 0; });
  var lbl = { live: ['good', 'Live'], stale: ['danger', 'Stale'], sim: ['', 'Simulated'] };
  return '<div class="scroll" style="max-height:520px;overflow-y:auto"><table><thead><tr><th>Pair</th><th class="num">Price</th><th>Source</th><th>Why</th></tr></thead><tbody>' + rows.map(function (x) {
    var sv = srcMap[x] || 'sim', l = lbl[sv] || lbl.sim, a = R.assetInfo(x);
    var why = sv === 'live' ? '' : a.cls === 'traditional' ? 'Not on a crypto exchange' : (Feed.snap && Feed.snap.source !== 'simulated') ? (sv === 'stale' ? 'No update for 30 s' : 'This exchange doesn\u2019t list it') : 'Simulated source selected';
    return '<tr><td><strong>' + x + '</strong></td><td class="num">' + px(x, Sim.prices[x]) + '</td><td><span class="tag ' + l[0] + '">' + l[1] + '</span></td><td class="small muted">' + esc(why) + '</td></tr>';
  }).join('') + '</tbody></table></div>';
}
function aiStatusHTML() {
  var a = (Store.server && Store.server.ai) || {};
  if (!a.configured) return '<div class="banner warn small"><span><strong>No Anthropic API key yet.</strong> Add <span class="mono">ANTHROPIC_API_KEY</span> to the <span class="mono">.env</span> file next to <span class="mono">docker-compose.yml</span>, then restart the cockpit. Reviews, the coach and chat need it.</span></div>';
  var pctUsed = a.capUsd ? Math.min(100, a.spentUsd / a.capUsd * 100) : 0;
  return '<div class="kv"><div><div class="k">Spent in ' + esc(a.month) + '</div><div class="v">$' + Number(a.spentUsd).toFixed(2) + ' <small>/ $' + a.capUsd + '</small></div></div><div><div class="k">Requests</div><div class="v">' + a.calls + '</div></div></div>' +
    '<div class="bar ' + (pctUsed >= 90 ? 'danger' : pctUsed >= 60 ? 'warn' : 'ok') + '"><i style="width:' + pctUsed.toFixed(1) + '%"></i></div>' +
    '<p class="small muted" style="margin:0">Sonnet = ' + esc(a.models && a.models.default) + ', Opus = ' + esc(a.models && a.models.complex) + ', coach = ' + esc(a.models && a.models.quick) + '. Change the monthly cap with <span class="mono">AI_MONTHLY_CAP_USD</span> in <span class="mono">.env</span>.</p>';
}
function refreshAiStatus() { if (Store.mode !== 'server') return; fetch('api/ai/status').then(function (r) { return r.json(); }).then(function (a) { Store.server.ai = a; setHTML('aiStatus', aiStatusHTML(), true); }).catch(function () { /* offline */ }); }
function notifyStatusHTML() {
  var n = Store.server && Store.server.notify;
  if (!n || !n.configured) return '<p class="small muted" style="margin:0">Off. Add <span class="mono">TELEGRAM_BOT_TOKEN</span> and <span class="mono">TELEGRAM_CHAT_ID</span> to <span class="mono">.env</span> to turn these on.</p>';
  return '<div class="kv"><div><div class="k">Status</div><div class="v ' + (n.lastError ? 'c-danger' : 'c-good') + '" style="font-size:14px">' + (n.lastError ? 'Problem sending' : 'On') + '</div></div>' +
    '<div><div class="k">Sent since restart</div><div class="v">' + n.sent + '</div></div><div><div class="k">Waiting to send</div><div class="v">' + n.queued + '</div></div></div>' +
    (n.lastError ? '<p class="small c-danger" style="margin:0">' + esc(n.lastError) + '</p>' : '') +
    '<p class="small muted" style="margin:0">Sends: ' + esc((n.lanes || []).join(', ')) + '. Runs on the server, so it works with no page open.</p>';
}
function refreshNotifyStatus() { if (Store.mode !== 'server') return; fetch('api/notify/status').then(function (r) { return r.json(); }).then(function (n) { Store.server.notify = n; setHTML('notifyStatus', notifyStatusHTML(), true); }).catch(function () { /* offline */ }); }
function sendTelegramTest() {
  return fetch('api/notify/test', { method: 'POST', headers: serverHeaders() }).then(function (r) { return r.json(); }).then(function (b) {
    if (b.ok) toast('Test message sent. Check Telegram.', 'good'); else toast(b.message || 'Telegram didn’t accept that.', 'warn');
    refreshNotifyStatus();
  }).catch(function () { toast('The cockpit server didn’t answer.', 'danger'); });
}
function viewFeedServer() {
  var cur = Feed.snap ? Feed.snap.source : 'binance';
  setTimeout(refreshAiStatus, 0);
  setTimeout(refreshNotifyStatus, 0);
  return '<div class="inline"><h1>Data feed</h1><span class="muted">Live prices for the cockpit on this computer</span></div>' +
    '<div class="row"><section class="panel side" aria-labelledby="srcH"><div class="panel-h"><h2 id="srcH">Price source</h2></div><div class="panel-b">' +
    '<div class="seg" role="group" aria-label="Price source">' + ['binance', 'kraken', 'simulated'].map(function (v) { return '<button type="button" data-act="feedSrc" data-v="' + v + '" aria-pressed="' + (cur === v) + '">' + FEED_SOURCES[v] + '</button>'; }).join('') + '</div>' +
    '<div id="feedLive">' + feedLiveHTML() + '</div>' +
    '<p class="small muted" style="margin:0"><strong>Binance</strong> public market data: one stream with every USDT pair, plus chart history. <strong>Kraken</strong>: USD pairs, no chart history (candles build from now). Pairs an exchange doesn\u2019t list, and gold, silver and TSLA, stay simulated and are labelled. Exchange prices can differ slightly from Bitfunded\u2019s.</p>' +
    '<div class="stack" style="border-top:1px solid var(--line);padding-top:12px"><h3>Claude</h3><div id="aiStatus">' + aiStatusHTML() + '</div></div>' +
    '<div class="stack" style="border-top:1px solid var(--line);padding-top:12px"><h3>Telegram alerts</h3><div id="notifyStatus">' + notifyStatusHTML() + '</div><div class="inline"><button type="button" class="btn small" data-act="tgTest">Send a test message</button></div></div></div></section>' +
    '<section class="panel wide" aria-labelledby="fpH"><div class="panel-h"><h2 id="fpH">Pairs in use</h2><span class="grow"></span><label class="sr" for="feedSearch">Search</label><input id="feedSearch" type="text" placeholder="Search pairs" value="' + esc(ui.feedQ || '') + '" style="width:180px;min-height:36px"></div><div id="feedTable">' + feedPairsHTML() + '</div></section></div>';
}
function viewFeed() {
  if (Store.mode === 'server') return viewFeedServer();
  var f = feedSettings();
  var used = enabledSyms(), missing = used.filter(function (s) { return cgIdFor(s).how === 'missing'; }).length;
  return '<div class="inline"><h1>Data feed</h1><span class="muted">Where the cockpit gets its prices</span></div>' +
    '<div class="row"><section class="panel side" aria-labelledby="srcH"><div class="panel-h"><h2 id="srcH">Price source</h2></div><div class="panel-b">' +
    '<div class="seg" role="group" aria-label="Price source"><button type="button" data-act="feedSrc" data-v="simulated" aria-pressed="' + (f.source === 'simulated') + '">Simulated</button>' + (Store.mode === 'local' && typeof WebSocket === 'function' ? '<button type="button" data-act="feedSrc" data-v="binance" aria-pressed="' + (f.source === 'binance') + '">Binance live</button>' : '') + '<button type="button" data-act="feedSrc" data-v="coingecko" aria-pressed="' + (f.source === 'coingecko') + '"' + (CG.connected ? '' : ' disabled') + '>CoinGecko</button></div>' +
    (Store.mode === 'local' && f.source === 'binance' ? '<p class="small" style="margin:0">' + esc(BFeed.state === 'connected' ? 'Live crypto prices from Binance\u2019s public stream, straight from this browser. No login or key.' : BFeed.state === 'connecting' ? 'Connecting to Binance\u2026' : 'Binance can\u2019t be reached from here, so prices are simulated. It keeps trying.') + ' Gold, silver and TSLA stay simulated. Prices only update while this page is open.</p>' : '') +
    (CG.connected || Store.mode === 'local' ? '' : '<div class="banner info small"><span><strong>CoinGecko isn\u2019t connected yet.</strong> Add the CoinGecko connector in Claude\u2019s Settings → Connectors (free, no login), then ask Claude to switch it on. Until then prices are simulated.</span></div>') +
    '<label class="f" for="feedRefresh">Refresh every<select id="feedRefresh" data-fresh="1">' + [10, 15, 30, 60].map(function (n) { return '<option value="' + n + '"' + (Number(f.refreshSec) === n ? ' selected' : '') + '>' + n + ' seconds</option>'; }).join('') + '</select></label>' +
    '<p class="small muted" style="margin:0">Only pairs on screen, with open positions, working orders or price alerts are refreshed, to keep requests low. Gold, silver and TSLA stay simulated: CoinGecko has no spot price for them.</p>' +
    '<div class="stack" style="border-top:1px solid var(--line);padding-top:12px"><h3>Server version</h3><label class="f" for="feedKey">CoinGecko API key<input id="feedKey" type="text" disabled placeholder="Available when the cockpit runs on your own server"></label>' +
    '<p class="small muted" style="margin:0">On your own server the key is stored there, never in the browser. This page can\u2019t call outside APIs directly, so on claude.ai prices come through the connector instead.</p></div>' +
    '</div></section>' +
    '<section class="panel wide" aria-labelledby="mapH"><div class="panel-h"><h2 id="mapH">Pair to CoinGecko coin</h2><div class="chips" role="group" aria-label="Show"><button type="button" class="chip" data-act="feedFilter" data-v="all" aria-pressed="' + ((ui.feedFilter || 'all') === 'all') + '">All in use (' + used.length + ')</button><button type="button" class="chip" data-act="feedFilter" data-v="check" aria-pressed="' + (ui.feedFilter === 'check') + '">Needs attention (' + used.filter(function (s) { var h = cgIdFor(s).how; return h === 'missing' || h === 'scaled'; }).length + ')</button></div><span class="grow"></span>' +
    '<label class="sr" for="feedSearch">Search</label><input id="feedSearch" type="text" placeholder="Search pair or id" value="' + esc(ui.feedQ || '') + '" style="width:180px;min-height:36px"></div>' +
    '<div class="panel-b" style="padding-bottom:0"><p class="small muted" style="margin:0">Some tickers don\u2019t match CoinGecko\u2019s ids (two coins can share a ticker). Edit any id here; your edits are saved and override the built-in list.' + (missing ? ' <strong>' + missing + ' pair' + (missing > 1 ? 's' : '') + ' need an id.</strong>' : '') + '</p></div>' +
    '<div id="feedTable">' + feedRowsHTML() + '</div></section></div>';
}
