'use strict';

// Price feeds collector:
//  - Coinbase BTC-USD ticker (spot trades + best bid/ask)  -> spot_ticks, coinbase mid
//  - Kraken BTC/USD ticker (best bid/ask)                  -> kraken mid
//  - Bitstamp BTC/USD order book top (best bid/ask)        -> bitstamp mid
//  - Gemini BTC/USD top of book (best bid/ask)             -> gemini mid
//  - composite BRTI proxy = mean of fresh exchange mids    -> index_ticks 'proxy_composite' at 1 Hz
//    (all four are BRTI constituent exchanges; BRTI is computed from these
//     books, so the composite consumes the index's own inputs directly)
//  - Polymarket RTDS relays of Binance and Chainlink BTC   -> index_ticks 'pm_binance', 'pm_chainlink'
//  - Pyth Hermes SSE (trial key): XAU/XAG spot, WTI V6/X6  -> index_ticks 'pyth_*'
//    futures, BTC — commodity settlement-index PROXIES for the strike-chain
//    validation (level basis vs the gated *.Index.* feeds cancels in changes)
//  - clock sync measurements vs Coinbase time endpoint     -> clock_sync

const WebSocket = require('ws');
const config = require('../lib/config');
const log = require('../lib/log');
const db = require('../lib/db');

const FRESH_MS = 5000;

const latest = {
  coinbase: null, // { bid, ask, t }
  kraken: null,
  bitstamp: null,
  gemini: null
};

const indexBuf = [];
const spotBuf = [];
let stats = { coinbaseMsgs: 0, krakenMsgs: 0, bitstampMsgs: 0, geminiMsgs: 0, rtdsMsgs: 0, pythMsgs: 0, samples: 0 };

// ---------- generic reconnecting websocket ----------

function makeWs({ name, url, onOpen, onMessage, pingEveryMs, pingPayload }) {
  let delay = 1000;
  let socket = null;

  function connect() {
    socket = new WebSocket(url);
    let pinger = null;

    socket.on('open', () => {
      delay = 1000;
      log.info(`${name} connected`);
      onOpen(socket);
      if (pingEveryMs) {
        pinger = setInterval(() => {
          if (socket.readyState !== WebSocket.OPEN) return;
          socket.ping();
          if (pingPayload) socket.send(pingPayload);
        }, pingEveryMs);
      }
    });

    socket.on('message', (raw) => {
      try {
        onMessage(raw, new Date(), socket);
      } catch (err) {
        log.warn(`${name} message handler error: ${err.message}`);
      }
    });

    const down = (why) => {
      if (pinger) clearInterval(pinger);
      log.warn(`${name} down (${why}), reconnect in ${delay}ms`);
      setTimeout(connect, delay);
      delay = Math.min(30000, delay * 2);
    };

    socket.on('close', (code) => down(`close ${code}`));
    socket.on('error', (err) => {
      log.error(`${name} error: ${err.message}`);
      socket.terminate();
    });
  }

  connect();
}

// ---------- coinbase ----------

makeWs({
  name: 'coinbase',
  url: 'wss://ws-feed.exchange.coinbase.com',
  pingEveryMs: 15000,
  onOpen: (socket) => {
    socket.send(JSON.stringify({
      type: 'subscribe',
      product_ids: ['BTC-USD'],
      channels: ['ticker', 'heartbeat']
    }));
  },
  onMessage: (raw, receivedAt) => {
    const m = JSON.parse(raw);
    if (m.type !== 'ticker' || !m.price) return;
    stats.coinbaseMsgs += 1;
    latest.coinbase = { bid: Number(m.best_bid), ask: Number(m.best_ask), t: receivedAt.getTime() };
    spotBuf.push([
      'coinbase',
      m.trade_id != null ? String(m.trade_id) : null,
      m.price,
      m.last_size || null,
      m.best_bid || null,
      m.best_ask || null,
      m.time ? new Date(m.time) : receivedAt,
      receivedAt
    ]);
  }
});

// ---------- kraken ----------

makeWs({
  name: 'kraken',
  url: 'wss://ws.kraken.com/v2',
  pingEveryMs: 15000,
  onOpen: (socket) => {
    socket.send(JSON.stringify({
      method: 'subscribe',
      params: { channel: 'ticker', symbol: ['BTC/USD'], event_trigger: 'bbo' }
    }));
  },
  onMessage: (raw, receivedAt) => {
    const m = JSON.parse(raw);
    if (m.channel !== 'ticker' || !Array.isArray(m.data)) return;
    const d = m.data[0];
    if (!d || d.bid == null || d.ask == null) return;
    stats.krakenMsgs += 1;
    latest.kraken = { bid: Number(d.bid), ask: Number(d.ask), t: receivedAt.getTime() };
  }
});

// ---------- bitstamp (BRTI constituent) ----------

makeWs({
  name: 'bitstamp',
  url: 'wss://ws.bitstamp.net',
  pingEveryMs: 15000,
  onOpen: (socket) => {
    socket.send(JSON.stringify({
      event: 'bts:subscribe',
      data: { channel: 'order_book_btcusd' }
    }));
  },
  onMessage: (raw, receivedAt, socket) => {
    const m = JSON.parse(raw);
    if (m.event === 'bts:request_reconnect') {
      log.warn('bitstamp requested reconnect, cycling socket');
      socket.terminate();
      return;
    }
    if (m.event !== 'data' || !m.data || !m.data.bids || !m.data.asks) return;
    const bid = Number(m.data.bids[0] && m.data.bids[0][0]);
    const ask = Number(m.data.asks[0] && m.data.asks[0][0]);
    if (!(bid > 0) || !(ask > 0)) return;
    stats.bitstampMsgs += 1;
    latest.bitstamp = { bid, ask, t: receivedAt.getTime() };
  }
});

// ---------- gemini (BRTI constituent) ----------

const geminiTop = { bid: null, ask: null };

makeWs({
  name: 'gemini',
  url: 'wss://api.gemini.com/v1/marketdata/btcusd?top_of_book=true&heartbeat=true',
  pingEveryMs: 15000,
  onOpen: () => {
    geminiTop.bid = null;
    geminiTop.ask = null;
  },
  onMessage: (raw, receivedAt) => {
    const m = JSON.parse(raw);
    if (m.type !== 'update' || !Array.isArray(m.events)) return;
    // With top_of_book=true every change event IS a top-of-book change; the
    // old reason/type filter dropped all post-initial updates, freezing the
    // quote — and the unconditional stamp below kept marking it fresh. The
    // stamp now moves only when an event actually updated a side.
    let updated = false;
    for (const e of m.events) {
      if (e.type === 'change') {
        const price = Number(e.price);
        if (!(price > 0)) continue;
        if (e.side === 'bid') { geminiTop.bid = price; updated = true; }
        else if (e.side === 'ask') { geminiTop.ask = price; updated = true; }
      }
    }
    if (updated && geminiTop.bid !== null && geminiTop.ask !== null) {
      stats.geminiMsgs += 1;
      latest.gemini = { bid: geminiTop.bid, ask: geminiTop.ask, t: receivedAt.getTime() };
    }
  }
});

// ---------- polymarket RTDS (Binance + Chainlink BTC relays) ----------

makeWs({
  name: 'rtds',
  url: 'wss://ws-live-data.polymarket.com',
  pingEveryMs: 5000,
  pingPayload: 'PING',
  onOpen: (socket) => {
    socket.send(JSON.stringify({
      action: 'subscribe',
      subscriptions: [
        { topic: 'crypto_prices', type: 'update', filters: '{"symbol":"btcusdt"}' },
        { topic: 'crypto_prices_chainlink', type: '*', filters: '{"symbol":"btc/usd"}' }
      ]
    }));
  },
  onMessage: (raw, receivedAt) => {
    const text = String(raw);
    // RTDS sends one empty text frame on connect, plus PING/PONG keep-alives.
    if (text === '' || text === 'PONG' || text === 'PING') return;
    const m = JSON.parse(text);
    if (!m.payload || m.payload.value == null) return;
    const source = m.topic === 'crypto_prices_chainlink' ? 'pm_chainlink' : 'pm_binance';
    stats.rtdsMsgs += 1;
    indexBuf.push([
      source,
      new Date(m.payload.timestamp || m.timestamp || Date.now()),
      m.payload.value,
      receivedAt,
      JSON.stringify({ symbol: m.payload.symbol })
    ]);
  }
});

// ---------- Pyth Hermes SSE (commodity settlement-index proxies) ----------
//
// The Kalshi commodity series settle on gated *.Index.* Pyth feeds the trial
// key is not entitled to. These entitled feeds are proxies; the strike chain
// (official settle every 15 min, free) will measure how well their CHANGES
// track the index. Metals/WTI halt 17:00-18:00 NY and weekends — gaps there
// are the venue's, not ours. Each price is persisted once per publish_time.

const PYTH_FEEDS = {
  '765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2': 'pyth_xau',
  'f2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e': 'pyth_xag',
  '9526e04755ebaed86733913b84fe14db4ea165da8f40f97710014cd877fe545b': 'pyth_wtiv6',
  'f8c2191e76f7f4d5335e7f4e8f81ab0df6360d54ee020874222841894203e9d7': 'pyth_wtix6',
  'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43': 'pyth_btc',
  // Alt cryptos for the cross-crypto lead-lag study (live 1s leg).
  'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace': 'pyth_eth',
  'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d': 'pyth_sol',
  'ec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8': 'pyth_xrp',
  'dcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c': 'pyth_doge',
  '2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f': 'pyth_bnb',
  '4279e31cc369bbcc2faf022b382b080e32a8e689ff20fbc530d2a603eb6cd98b': 'pyth_hype'
};
const pythLastPublish = new Map(); // source -> publish_time (s)

function handlePythParsed(parsed, receivedAt) {
  for (const p of parsed || []) {
    const source = PYTH_FEEDS[p.id];
    if (!source || !p.price) continue;
    const pt = Number(p.price.publish_time);
    if (pythLastPublish.get(source) === pt) continue;
    pythLastPublish.set(source, pt);
    const value = Number(p.price.price) * 10 ** Number(p.price.expo);
    if (!(value > 0)) continue;
    stats.pythMsgs += 1;
    indexBuf.push([
      source,
      new Date(pt * 1000),
      value.toFixed(8),
      receivedAt,
      JSON.stringify({ conf: Number(p.price.conf) * 10 ** Number(p.price.expo) })
    ]);
  }
}

async function pythStream() {
  if (!config.pythApiKey) {
    log.info('pyth: no PYTH_API_KEY set, skipping');
    return;
  }
  const qs = Object.keys(PYTH_FEEDS).map((id) => 'ids[]=' + id).join('&');
  const url = `https://hermes.pyth.network/v2/updates/price/stream?${qs}&parsed=true`;
  let backoff = 1000;
  for (;;) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${config.pythApiKey}` } });
      if (!res.ok) {
        log.warn(`pyth stream HTTP ${res.status}; retry in ${Math.max(backoff, 30000)}ms`);
        await new Promise((r) => setTimeout(r, Math.max(backoff, 30000)));
        backoff = Math.min(300000, backoff * 2);
        continue;
      }
      log.info('pyth stream connected');
      backoff = 1000;
      let buf = '';
      for await (const chunk of res.body) {
        buf += Buffer.from(chunk).toString('utf8');
        let sep;
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const event = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          for (const line of event.split('\n')) {
            if (!line.startsWith('data:')) continue;
            try {
              const msg = JSON.parse(line.slice(5));
              handlePythParsed(msg.parsed, new Date());
            } catch (err) {
              log.warn('pyth parse error:', err.message);
            }
          }
        }
      }
      log.warn('pyth stream ended, reconnecting');
    } catch (err) {
      log.warn(`pyth stream error: ${err.message}; retry in ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(300000, backoff * 2);
    }
  }
}

pythStream();

// ---------- 1 Hz sampling of mids and composite proxy ----------

function sampleTick() {
  const now = new Date();
  const nowMs = now.getTime();
  const mids = {};
  for (const [name, q] of Object.entries(latest)) {
    if (!q || nowMs - q.t > FRESH_MS) continue;
    if (!(q.bid > 0) || !(q.ask > 0) || q.ask < q.bid) continue;
    mids[name] = (q.bid + q.ask) / 2;
    indexBuf.push([
      `${name}_mid`,
      now,
      mids[name].toFixed(2),
      now,
      JSON.stringify({ bid: q.bid, ask: q.ask, age_ms: nowMs - q.t })
    ]);
  }
  const values = Object.values(mids);
  if (values.length > 0) {
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    indexBuf.push([
      'proxy_composite',
      now,
      mean.toFixed(2),
      now,
      JSON.stringify({ components: mids, n: values.length })
    ]);
  }
  stats.samples += 1;
}

// ---------- clock sync vs Coinbase time endpoint ----------

async function clockSync() {
  const t0 = Date.now();
  let data;
  try {
    const res = await fetch('https://api.exchange.coinbase.com/time');
    if (!res.ok) return;
    data = await res.json();
  } catch {
    return;
  }
  const t1 = Date.now();
  if (!data || data.epoch == null) return;
  const serverMs = Number(data.epoch) * 1000;
  const offset = serverMs - (t0 + t1) / 2;
  await db.pool.query(
    'INSERT INTO clock_sync (source, offset_ms, rtt_ms) VALUES ($1, $2, $3)',
    ['coinbase_time', offset.toFixed(1), (t1 - t0).toFixed(1)]
  );
}

// ---------- persistence ----------

async function flush() {
  const idx = indexBuf.splice(0);
  const spot = spotBuf.splice(0);
  try {
    await db.batchInsert('index_ticks', ['source', 'ts', 'price', 'received_at', 'detail'], idx);
    await db.batchInsert(
      'spot_ticks',
      ['exchange', 'trade_id', 'price', 'size', 'best_bid', 'best_ask', 'ts_venue', 'received_at'],
      spot
    );
  } catch (err) {
    log.error('flush failed, data dropped for this batch:', err.message);
  }
}

async function main() {
  await db.ensurePartitions(1, 2);
  setInterval(sampleTick, 1000);
  setInterval(flush, 1000);
  setInterval(() => {
    clockSync().catch((err) => log.error('clock sync error', err.message));
  }, 60000);
  setInterval(() => {
    db.heartbeat('collector-prices', stats).catch((err) => log.error('heartbeat error', err.message));
  }, 10000);
  setInterval(() => {
    db.ensurePartitions(0, 2).catch((err) => log.error('partition error', err.message));
  }, 3600000);
  log.info('collector-prices started');
}

main().catch((err) => {
  log.error('fatal', err);
  process.exit(1);
});
