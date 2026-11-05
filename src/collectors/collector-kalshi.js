'use strict';

// Kalshi collector: maintains live order books for active short-duration BTC
// markets via the authenticated websocket, persists raw deltas, 1-second book
// snapshots, and public trades. Discovers markets via REST as windows roll.

const WebSocket = require('ws');
const config = require('../lib/config');
const log = require('../lib/log');
const db = require('../lib/db');
const auth = require('../lib/kalshi-auth');
const rest = require('../lib/kalshi-rest');

if (!auth.haveCredentials()) {
  log.error('Kalshi websocket requires an API key. Set KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY_PATH in .env');
  process.exit(1);
}

// ---------- state ----------

const books = new Map(); // ticker -> { yes: Map(price->qty), no: Map(price->qty), seq, dirty, live, lastSnapshotMs }
const activeTickers = new Set(); // tickers we want subscribed
const subscribedTickers = new Set(); // tickers the server has acked
const sids = {}; // channel -> sid
let ws = null;
let wsConnected = false;
let cmdId = 1;
let reconnectDelay = 1000;
// The orderbook seq counter is per subscription (sid), shared across every
// market on it — NOT per market. See lessons/kalshi-ws-seq-per-sid.md.
let lastSeq = null;
let lastBookMsgMs = 0; // any orderbook_snapshot/delta; liveness watchdog input
let livenessStrikes = 0;
let stats = { deltas: 0, snapshots: 0, trades: 0, seqGaps: 0, reconnects: 0 };

const deltaBuf = [];
const tradeBuf = [];
const snapBuf = [];

// ---------- book maintenance ----------

function emptyBook() {
  // live=false until a fresh server snapshot builds the book; snapshotTick
  // refuses to persist non-live books (gapped, or frozen across an outage).
  return { yes: new Map(), no: new Map(), seq: null, dirty: true, live: false, lastSnapshotMs: 0 };
}

// Price strings have no guaranteed decimal width on the wire (doc examples mix
// "0.0800" and "0.960"); normalize numerically so snapshot and delta keys meet.
function pk(s) {
  return Number(s).toFixed(4);
}

// Quantities are decimal strings; accumulate them as integer micro-contracts.
// Accumulating doubles leaves ~1e-13 residue when a level empties, so the
// `<= 0` delete never fires and phantom dust bids poison best-bid/mid/spread
// (observed live 2026-08-28: top-of-book qty 5.68e-14, spread -0.23).
function microQty(s) {
  return Math.round(Number(s) * 1e6);
}

function applySnapshot(msg, seq) {
  // Ignore snapshots for markets discovery no longer wants (a delete raced an
  // in-flight snapshot) — otherwise a zombie book leaks and persists forever.
  if (!activeTickers.has(msg.market_ticker)) return;
  const book = emptyBook();
  for (const [price, qty] of msg.yes_dollars_fp || []) book.yes.set(pk(price), microQty(qty));
  for (const [price, qty] of msg.no_dollars_fp || []) book.no.set(pk(price), microQty(qty));
  book.seq = seq;
  book.dirty = true;
  book.topDirty = true;
  book.live = true;
  books.set(msg.market_ticker, book);
}

const darkSnapshotReqMs = new Map(); // ticker -> last get_snapshot request for a book-less market

function applyDelta(msg, seq, receivedAt) {
  const book = books.get(msg.market_ticker);
  if (!book) {
    // Deltas for a market we want but have no book for: its snapshot was
    // dropped or never sent. Request one, throttled per ticker.
    if (activeTickers.has(msg.market_ticker)) {
      const last = darkSnapshotReqMs.get(msg.market_ticker) || 0;
      if (Date.now() - last > 5000) {
        darkSnapshotReqMs.set(msg.market_ticker, Date.now());
        requestSnapshot([msg.market_ticker]);
      }
    }
    return;
  }
  book.seq = seq;
  const sideMap = msg.side === 'yes' ? book.yes : book.no;
  const key = pk(msg.price_dollars);
  const prev = sideMap.get(key) || 0;
  const next = prev + microQty(msg.delta_fp);
  if (next <= 0) sideMap.delete(key);
  else sideMap.set(key, next);
  book.dirty = true;
  book.topDirty = true;

  deltaBuf.push([
    msg.market_ticker,
    seq,
    msg.side,
    msg.price_dollars,
    msg.delta_fp,
    msg.ts_ms ? new Date(msg.ts_ms) : null,
    receivedAt
  ]);
  stats.deltas += 1;
}

function sortedLevels(map, descending) {
  // Map values are integer micro-contracts; persist plain contract counts.
  const arr = [...map.entries()].map(([p, q]) => [Number(p), q / 1e6]);
  arr.sort((a, b) => (descending ? b[0] - a[0] : a[0] - b[0]));
  return arr;
}

function buildSnapshotRow(ticker, book, now, forced) {
  const yes = sortedLevels(book.yes, true);
  const no = sortedLevels(book.no, true);
  const bestYesBid = yes.length ? yes[0][0] : null;
  const bestNoBid = no.length ? no[0][0] : null;
  const bestYesAsk = bestNoBid !== null ? Number((1 - bestNoBid).toFixed(4)) : null;
  let mid = null;
  let spread = null;
  if (bestYesBid !== null && bestYesAsk !== null) {
    mid = Number(((bestYesBid + bestYesAsk) / 2).toFixed(4));
    spread = Number((bestYesAsk - bestYesBid).toFixed(4));
  }
  let depthYes = null;
  let depthNo = null;
  if (mid !== null) {
    depthYes = yes.filter(([p]) => p >= mid - 0.05).reduce((s, [, q]) => s + q, 0);
    const noMid = 1 - mid;
    depthNo = no.filter(([p]) => p >= noMid - 0.05).reduce((s, [, q]) => s + q, 0);
  }
  return [
    ticker,
    now,
    book.seq,
    forced,
    JSON.stringify(yes),
    JSON.stringify(no),
    bestYesBid,
    bestYesAsk,
    mid,
    spread,
    depthYes,
    depthNo
  ];
}

// ---------- websocket ----------

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function subscribe(tickers) {
  if (tickers.length === 0) return;
  send({
    id: cmdId++,
    cmd: 'subscribe',
    params: { channels: ['orderbook_delta'], market_tickers: tickers }
  });
  send({
    id: cmdId++,
    cmd: 'subscribe',
    params: { channels: ['trade'], market_tickers: tickers }
  });
}

function updateSubscription(action, tickers) {
  const sid = sids.orderbook_delta;
  if (!sid) {
    // No subscription yet: adds become a fresh subscribe; deletes are moot
    // (the open-handler resubscribes from activeTickers, which already
    // excludes them) — falling through to subscribe would re-add dead markets.
    if (action === 'add_markets') subscribe(tickers);
    return;
  }
  send({
    id: cmdId++,
    cmd: 'update_subscription',
    params: { sids: [sid], market_tickers: tickers, action }
  });
  if (sids.trade) {
    send({
      id: cmdId++,
      cmd: 'update_subscription',
      params: { sids: [sids.trade], market_tickers: tickers, action }
    });
  }
}

function requestSnapshot(tickers) {
  const sid = sids.orderbook_delta;
  if (!sid) return;
  send({
    id: cmdId++,
    cmd: 'update_subscription',
    params: { sids: [sid], market_tickers: tickers, action: 'get_snapshot' }
  });
}

function handleMessage(raw, receivedAt) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    log.warn('unparseable ws message', String(raw).slice(0, 200));
    return;
  }
  switch (data.type) {
    case 'subscribed': {
      const channel = data.msg && data.msg.channel;
      if (channel) {
        sids[channel] = data.msg.sid;
        log.info(`subscribed channel=${channel} sid=${data.msg.sid}`);
      }
      break;
    }
    case 'orderbook_snapshot':
    case 'orderbook_delta': {
      // Snapshots and deltas share one per-sid seq counter. A gap means the
      // stream dropped messages for unknown markets: invalidate every book and
      // re-snapshot them all; books stay unpersisted until rebuilt.
      lastBookMsgMs = Date.now();
      livenessStrikes = 0;
      if (typeof data.seq === 'number') {
        if (lastSeq !== null && data.seq !== lastSeq + 1) {
          stats.seqGaps += 1;
          log.warn(`sid seq gap: had ${lastSeq}, got ${data.seq}; invalidating all books, requesting snapshots`);
          for (const book of books.values()) book.live = false;
          requestSnapshot([...activeTickers]);
        }
        lastSeq = data.seq;
      }
      if (data.type === 'orderbook_snapshot') {
        applySnapshot(data.msg, data.seq);
        subscribedTickers.add(data.msg.market_ticker);
      } else {
        applyDelta(data.msg, data.seq, receivedAt);
      }
      break;
    }
    case 'trade': {
      const m = data.msg;
      tradeBuf.push([
        m.trade_id,
        m.market_ticker,
        m.yes_price_dollars,
        m.no_price_dollars,
        m.count_fp,
        m.taker_side,
        m.ts_ms ? new Date(m.ts_ms) : null,
        receivedAt,
        'ws',
        JSON.stringify(m)
      ]);
      stats.trades += 1;
      break;
    }
    case 'market_ticker':
      break;
    case 'error': {
      log.warn('ws error message', JSON.stringify(data));
      // Code 25 = subscription buffer overflow: the documented remedy is a
      // full reconnect and re-bootstrap. Other command errors are surfaced by
      // the data-liveness watchdog rather than guessed at here.
      const code = data.msg && data.msg.code;
      if (code === 25 && ws) ws.terminate();
      break;
    }
    default:
      break;
  }
}

function connect() {
  const headers = auth.signHeaders('GET', config.kalshi.wsSignPath);
  ws = new WebSocket(config.kalshi.ws, { headers });
  let pongSeen = Date.now();

  ws.on('open', () => {
    wsConnected = true;
    reconnectDelay = 1000;
    pongSeen = Date.now();
    subscribedTickers.clear();
    for (const ch of Object.keys(sids)) delete sids[ch];
    lastSeq = null;
    lastBookMsgMs = Date.now();
    livenessStrikes = 0;
    log.info(`ws connected, subscribing ${activeTickers.size} markets`);
    subscribe([...activeTickers]);
  });

  ws.on('message', (raw) => handleMessage(raw, new Date()));
  ws.on('pong', () => {
    pongSeen = Date.now();
  });

  const pinger = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - pongSeen > 30000) {
      log.warn('no pong in 30s, terminating socket');
      ws.terminate();
      return;
    }
    // Data-liveness watchdog: the transport answering pongs proves nothing
    // about subscriptions (a rejected subscribe leaves a healthy-looking,
    // zero-data connection forever). First strike re-requests snapshots;
    // a second consecutive strike forces a full reconnect and re-bootstrap.
    if (activeTickers.size > 0 && Date.now() - lastBookMsgMs > 120000) {
      livenessStrikes += 1;
      lastBookMsgMs = Date.now();
      if (livenessStrikes === 1 && sids.orderbook_delta) {
        log.warn('no book messages in 120s, requesting fresh snapshots');
        requestSnapshot([...activeTickers]);
      } else {
        log.warn('book stream silent (or never subscribed), terminating for re-bootstrap');
        ws.terminate();
        return;
      }
    }
    ws.ping();
  }, 10000);

  const onDown = (why) => {
    clearInterval(pinger);
    if (!wsConnected && ws === null) return;
    wsConnected = false;
    ws = null;
    // Books are frozen at pre-disconnect state; forbid persisting them until
    // fresh snapshots arrive, or the outage would be recorded as a quiet book.
    for (const book of books.values()) book.live = false;
    stats.reconnects += 1;
    log.warn(`ws down (${why}), reconnecting in ${reconnectDelay}ms`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(30000, reconnectDelay * 2);
  };

  ws.on('close', (code) => onDown(`close ${code}`));
  ws.on('error', (err) => {
    log.error('ws error', err.message);
    if (ws) ws.terminate();
  });
}

// ---------- market discovery ----------

function parseTs(s) {
  return s ? new Date(s) : null;
}

async function discoverMarkets() {
  const now = Date.now();
  const desired = new Set();
  const failedSeries = new Set();
  for (const series of config.kalshi.series) {
    for (const status of ['open', 'unopened']) {
      let markets;
      try {
        markets = await rest.getAllPages(
          `/markets?series_ticker=${series}&status=${status}&limit=200`,
          'markets',
          { maxPages: 5 }
        );
      } catch (err) {
        // A transient fetch failure must not read as "this series has no
        // markets" — that would unsubscribe and delete its live books.
        failedSeries.add(series);
        log.warn(`discovery failed for ${series}/${status}: ${err.message}`);
        continue;
      }
      for (const m of markets) {
        await db.upsertMarket(m);
        const close = parseTs(m.close_time);
        const open = parseTs(m.open_time);
        const closesInFuture = close && close.getTime() > now - 120000;
        const opensSoon = open && open.getTime() < now + 20 * 60000;
        if (closesInFuture && opensSoon) desired.add(m.ticker);
      }
    }
  }

  const toAdd = [...desired].filter((t) => !activeTickers.has(t));
  // Remove only markets whose series was fetched cleanly this run AND that are
  // genuinely past close per our own records — status-filtered listings are
  // unreliable (lessons/kalshi-status-filter-unreliable.md).
  const removeCandidates = [...activeTickers].filter((t) => {
    const dash = t.indexOf('-');
    const series = dash > 0 ? t.slice(0, dash) : t;
    return !desired.has(t) && !failedSeries.has(series);
  });
  let toRemove = [];
  if (removeCandidates.length) {
    const res = await db.pool.query(
      'SELECT ticker FROM kalshi_markets WHERE ticker = ANY($1) AND close_time > now()',
      [removeCandidates]
    );
    const stillOpen = new Set(res.rows.map((r) => r.ticker));
    toRemove = removeCandidates.filter((t) => !stillOpen.has(t));
  }
  for (const t of toAdd) activeTickers.add(t);
  for (const t of toRemove) {
    activeTickers.delete(t);
    subscribedTickers.delete(t);
    books.delete(t);
  }
  if (wsConnected && toAdd.length) {
    updateSubscription('add_markets', toAdd);
    // Snapshot-on-add is undocumented; without one an added market has no book
    // and its deltas are dropped. Explicit get_snapshot is documented and
    // harmless if the server also sends its own.
    requestSnapshot(toAdd);
  }
  if (wsConnected && toRemove.length) updateSubscription('delete_markets', toRemove);
  if (toAdd.length || toRemove.length) {
    log.info(`discovery: +${toAdd.length} -${toRemove.length}, active=${activeTickers.size}`);
  }
}

// Refresh recently closed markets until settlement data (expiration_value) lands.
async function refreshSettlements() {
  const res = await db.pool.query(
    `SELECT ticker FROM kalshi_markets
     WHERE expiration_value IS NULL
       AND close_time < now() AND close_time > now() - interval '6 hours'`
  );
  for (const row of res.rows) {
    try {
      const data = await rest.get(`/markets/${row.ticker}`);
      if (data.market) await db.upsertMarket(data.market);
    } catch (err) {
      log.warn(`settlement refresh failed for ${row.ticker}: ${err.message}`);
    }
    await rest.sleep(150);
  }
}

// ---------- persistence loops ----------

// ---------- low-latency top-of-book publisher ----------
// Every 200ms, compute tops for books whose state changed and pg_notify them.
// This feeds the live board's SSE stream so position values track the book in
// ~sub-second time instead of waiting for the 1s snapshot -> poll path.

const lastTop = new Map(); // ticker -> "bid|ask"

function bestOf(map, pick) {
  let best = null;
  for (const k of map.keys()) {
    const p = Number(k);
    if (best === null || pick(p, best)) best = p;
  }
  return best;
}

function topTick() {
  const changed = [];
  for (const [ticker, book] of books) {
    if (!book.live || !book.topDirty) continue;
    book.topDirty = false;
    const bid = bestOf(book.yes, (p, b) => p > b);
    const noBid = bestOf(book.no, (p, b) => p > b);
    const ask = noBid === null ? null : Number((1 - noBid).toFixed(4));
    const key = bid + '|' + ask;
    if (lastTop.get(ticker) === key) continue;
    lastTop.set(ticker, key);
    if (lastTop.size > 600) lastTop.clear();
    changed.push({ t: ticker, b: bid, a: ask, ts: Date.now() });
  }
  while (changed.length) {
    const chunk = changed.splice(0, 25);
    db.pool.query('SELECT pg_notify($1, $2)', ['book_top', JSON.stringify(chunk)])
      .catch((err) => log.warn('book_top notify failed: ' + err.message));
  }
}

function snapshotTick() {
  const nowMs = Date.now();
  const now = new Date(nowMs);
  for (const [ticker, book] of books) {
    if (!book.live) continue; // gapped or disconnected: state unknown, do not persist
    const stale = nowMs - book.lastSnapshotMs >= config.forceSnapshotEveryMs;
    if (!book.dirty && !stale) continue;
    snapBuf.push(buildSnapshotRow(ticker, book, now, !book.dirty && stale));
    book.dirty = false;
    book.lastSnapshotMs = nowMs;
    stats.snapshots += 1;
  }
}

async function flush() {
  const deltas = deltaBuf.splice(0);
  const trades = tradeBuf.splice(0);
  const snaps = snapBuf.splice(0);
  try {
    await db.batchInsert(
      'kalshi_book_deltas',
      ['market_ticker', 'seq', 'side', 'price', 'delta', 'ts_venue', 'received_at'],
      deltas
    );
    await db.batchInsert(
      'kalshi_trades',
      ['trade_id', 'market_ticker', 'yes_price', 'no_price', 'count', 'taker_side', 'ts_venue', 'received_at', 'source', 'raw'],
      trades,
      'ON CONFLICT (trade_id) DO NOTHING'
    );
    await db.batchInsert(
      'kalshi_book_snapshots',
      ['market_ticker', 'ts', 'seq', 'forced', 'yes_bids', 'no_bids', 'best_yes_bid', 'best_yes_ask', 'mid', 'spread', 'depth_yes_5c', 'depth_no_5c'],
      snaps,
      'ON CONFLICT (market_ticker, ts) DO NOTHING'
    );
  } catch (err) {
    log.error('flush failed, data dropped for this batch:', err.message);
  }
}

// ---------- main ----------

async function main() {
  await db.ensurePartitions(1, 2);
  await discoverMarkets();
  connect();

  setInterval(snapshotTick, config.snapshotIntervalMs);
  setInterval(topTick, 200);
  setInterval(flush, 500);
  setInterval(() => {
    discoverMarkets().catch((err) => log.error('discovery loop error', err.message));
  }, config.discoveryIntervalMs);
  setInterval(() => {
    refreshSettlements().catch((err) => log.error('settlement loop error', err.message));
  }, 60000);
  setInterval(() => {
    db.heartbeat('collector-kalshi', { ...stats, active: activeTickers.size, connected: wsConnected })
      .catch((err) => log.error('heartbeat error', err.message));
  }, 10000);
  setInterval(() => {
    db.ensurePartitions(0, 2).catch((err) => log.error('partition error', err.message));
  }, 3600000);

  log.info('collector-kalshi started', { series: config.kalshi.series });
}

main().catch((err) => {
  log.error('fatal', err);
  process.exit(1);
});
