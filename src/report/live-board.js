'use strict';

// Live Strike-vs-Settle board (PM2 app "live-board"), http://<host>:8791
//
// Serves the current KXBTC15M window in real time — live proxy price, strike,
// running 60s average ("if it settled now"), countdown, martingale fair value
// Φ(z) — plus an empirical "windows that looked like this" probability from
// window_path_prefix (path-analysis.js over 90 days of Kraken 1s bars), a
// macro tape from captured feeds, and the full time-above/weighted spread.
// Read-only; queries the research DB. All wall-clock display is Mountain Time.

const http = require('http');
const config = require('../lib/config');
const log = require('../lib/log');
const db = require('../lib/db');
const { normalCdf } = require('../research/calibration');
const { mcFair } = require('../research/mc-fair');

let mcCache = { at: 0, fair: null, se: null };

// Stale-while-revalidate cache: requests always return instantly from the
// last computed state; a refresh runs in the background at most once per TTL.
// Keeps the UI fluid even when backfills are hammering the database.
const swr = new Map(); // key -> { at, data, inflight }
async function cached(key, ttlMs, fn) {
  let c = swr.get(key);
  if (!c) { c = { at: 0, data: null, inflight: null }; swr.set(key, c); }
  const stale = Date.now() - c.at > ttlMs;
  if (stale && !c.inflight) {
    c.inflight = fn().then((d) => { c.data = d; c.at = Date.now(); c.inflight = null; })
      .catch((e) => { c.inflight = null; log.error(key + ' refresh failed', e.message); });
  }
  if (c.data === null && c.inflight) await c.inflight;
  return c.data;
}

const PORT = Number(process.env.LIVE_BOARD_PORT || 8791);
const HOST = process.env.LIVE_BOARD_HOST || '127.0.0.1';
const SETTLE_AVG_S = 60;
const SIGMA_WINDOW_S = 1800;

// ---------- sub-second book stream (collector pg_notify -> SSE) ----------
// The collector publishes top-of-book changes on channel 'book_top' straight
// from its in-memory books (~200ms cadence), bypassing the snapshot->poll
// path entirely. We relay them to browsers over Server-Sent Events.

const sseClients = new Set();
let latestSignals = { at: 0, data: {} };

function sseBroadcast(payload) {
  const msg = 'data: ' + payload + '\n\n';
  for (const res of sseClients) {
    try { res.write(msg); } catch (e) { sseClients.delete(res); }
  }
}

function startBookListener() {
  const { Client } = require('pg');
  const sub = new Client(config.pg);
  sub.connect()
    .then(() => sub.query('LISTEN book_top'))
    .then(() => sub.query('LISTEN desk_signals'))
    .then(() => log.info('listening on book_top'))
    .catch((e) => { log.error('book listener connect failed', e.message); setTimeout(startBookListener, 5000); });
  sub.on('notification', (n) => {
    if (n.channel === 'desk_signals') {
      latestSignals = { at: Date.now(), data: JSON.parse(n.payload) };
      sseBroadcast(JSON.stringify({ __signals: latestSignals.data }));
    } else {
      sseBroadcast(n.payload);
    }
  });
  sub.on('error', (e) => {
    log.error('book listener error', e.message);
    try { sub.end(); } catch (_) {}
    setTimeout(startBookListener, 5000);
  });
}
startBookListener();

async function q(sql, params) {
  return (await db.pool.query(sql, params)).rows;
}

async function liveState() {
  const out = { now: new Date().toISOString() };

  const mkt = (await q(
    `SELECT ticker, floor_strike::float8 AS strike,
            extract(epoch FROM close_time) AS close_sec, close_time
     FROM kalshi_markets
     WHERE series_ticker = 'KXBTC15M' AND floor_strike IS NOT NULL
       AND open_time <= now() AND close_time > now()
     ORDER BY close_time LIMIT 1`
  ))[0];

  const px = (await q(
    `SELECT price::float8 AS price, extract(epoch FROM ts) AS sec
     FROM index_ticks WHERE source = 'proxy_composite'
     ORDER BY ts DESC LIMIT 1`
  ))[0];
  out.price = px ? px.price : null;
  out.price_age_s = px ? Math.round(Date.now() / 1000 - Number(px.sec)) : null;

  out.running60 = (await q(
    `SELECT round(avg(price), 2)::float8 AS v FROM index_ticks
     WHERE source = 'proxy_composite' AND ts > now() - interval '60 seconds'`
  ))[0].v;

  const sig = (await q(
    `SELECT extract(epoch FROM ts)::bigint AS sec, price::float8 AS price
     FROM index_ticks
     WHERE source = 'proxy_composite' AND ts > now() - interval '${SIGMA_WINDOW_S} seconds'
     ORDER BY ts`
  ));
  let sumSq = 0;
  let n = 0;
  let prev = null;
  const returns = [];
  for (const r of sig) {
    if (prev !== null) {
      const dt = Number(r.sec) - Number(prev.sec);
      if (dt > 0 && dt <= 10) {
        const ret = Math.log(r.price / prev.price);
        sumSq += (ret * ret) / dt;
        n += 1;
        if (dt === 1) returns.push(ret);
      }
    }
    prev = r;
  }
  out.sigma = n >= SIGMA_WINDOW_S / 4 ? Math.sqrt(sumSq / n) : null;
  out._returns = returns;

  if (mkt && out.price) {
    out.ticker = mkt.ticker;
    out.strike = mkt.strike;
    out.close_time = mkt.close_time;
    const nowSec = Date.now() / 1000;
    out.secs_left = Math.max(0, Math.round(mkt.close_sec - nowSec));
    const openSec = mkt.close_sec - 900;
    out.mins_elapsed = (nowSec - openSec) / 60;
    const tauEff = Math.max(mkt.close_sec - nowSec - (2 * SETTLE_AVG_S) / 3, 1);
    out.z = out.sigma ? Math.log(out.price / mkt.strike) / (out.sigma * Math.sqrt(tauEff)) : null;
    out.fair = out.z === null ? null : normalCdf(out.z);

    // Monte Carlo fair: block bootstrap of the live empirical 1s returns,
    // recomputed at most every 5s (1,500 paths). No GBM assumption.
    if (Date.now() - mcCache.at > 5000) {
      const mc = mcFair({ price: out.price, strike: mkt.strike, secsLeft: out.secs_left, returns: out._returns });
      mcCache = { at: Date.now(), fair: mc ? mc.p : null, se: mc ? mc.se : null };
    }
    out.mc_fair = mcCache.fair;
    out.mc_se = mcCache.se;

    // Path-so-far this window, proxy anchored to its own pre-open 60s average
    // (mirrors path-analysis.js exactly, venue basis cancels).
    const path = (await q(
      `WITH anchor AS (
         SELECT avg(price)::float8 AS a FROM index_ticks
         WHERE source = 'proxy_composite'
           AND ts >= to_timestamp($1) - interval '60 seconds' AND ts < to_timestamp($1)
       )
       SELECT (SELECT a FROM anchor) AS anchor,
              count(*)::int AS n_secs,
              count(*) FILTER (WHERE i.price::float8 > (SELECT a FROM anchor))::int AS secs_above,
              avg(i.price::float8 - (SELECT a FROM anchor))::float8 AS twad
       FROM index_ticks i
       WHERE i.source = 'proxy_composite' AND i.ts >= to_timestamp($1) AND i.ts < now()`,
      [openSec]
    ))[0];
    out.path = path && path.anchor && path.n_secs > 30
      ? { n_secs: path.n_secs, secs_above: path.secs_above, frac_above: path.secs_above / path.n_secs, twad: path.twad }
      : null;

    // Empirical lookup: historical windows in a similar state at the nearest
    // completed minute mark. Band: +/-0.12 frac, twad within max($20, 60%).
    if (out.path) {
      const mark = [12, 9, 6, 3].find((m) => out.mins_elapsed >= m);
      if (mark) {
        const band = Math.max(20, Math.abs(out.path.twad) * 0.6);
        const emp = (await q(
          `SELECT count(*)::int AS n, avg((result = 'yes')::int)::float8 AS p_yes
           FROM window_path_prefix
           WHERE min_mark = $1
             AND abs(secs_above::float / n_secs - $2) <= 0.12
             AND abs(twad - $3) <= $4`,
          [mark, out.path.frac_above, out.path.twad, band]
        ))[0];
        out.empirical = { mark, n: emp.n, p_yes: emp.n >= 25 ? emp.p_yes : null };
      }
    }
  }

  // Live Kalshi order book for the active window (collector's 1s snapshots).
  if (mkt) {
    const book = (await q(
      `SELECT best_yes_bid::float8 AS bid, best_yes_ask::float8 AS ask,
              mid::float8 AS mid, spread::float8 AS spread,
              depth_yes_5c::float8 AS depth_yes, depth_no_5c::float8 AS depth_no,
              yes_bids, no_bids, extract(epoch FROM now() - ts)::int AS age_s
       FROM kalshi_book_snapshots
       WHERE market_ticker = $1 AND ts > now() - interval '2 minutes'
       ORDER BY ts DESC LIMIT 1`,
      [mkt.ticker]
    ))[0];
    if (book) {
      const asks = (book.no_bids || []).slice(0, 3).map(([p, s]) => [Number((1 - p).toFixed(4)), s]).reverse();
      const bids = (book.yes_bids || []).slice(0, 3);
      out.book = {
        bid: book.bid, ask: book.ask, mid: book.mid, spread: book.spread,
        depth_yes: book.depth_yes, depth_no: book.depth_no, age_s: book.age_s,
        asks, bids
      };
    }
  }

  // Crypto tandem radar: BTC + six alts — spot (Pyth 1s), 2-min and 15-min
  // moves, and each alt's live contract quote. The 2-min BTC move is the
  // lead-lag study's conditioning variable, watchable live.
  const spots = await q(
    `SELECT s.source,
       (SELECT price::float8 FROM index_ticks WHERE source = s.source ORDER BY ts DESC LIMIT 1) AS last,
       (SELECT price::float8 FROM index_ticks WHERE source = s.source AND ts <= now() - interval '2 minutes' ORDER BY ts DESC LIMIT 1) AS m2,
       (SELECT price::float8 FROM index_ticks WHERE source = s.source AND ts <= now() - interval '15 minutes' ORDER BY ts DESC LIMIT 1) AS m15
     FROM (VALUES ('pyth_btc'),('pyth_eth'),('pyth_sol'),('pyth_xrp'),('pyth_doge'),('pyth_bnb'),('pyth_hype')) s(source)`
  );
  const altBooks = await q(
    `SELECT m.series_ticker, m.floor_strike::float8 AS strike,
            b.mid::float8 AS mid, b.best_yes_bid::float8 AS bid, b.best_yes_ask::float8 AS ask
     FROM kalshi_markets m
     LEFT JOIN LATERAL (
       SELECT mid, best_yes_bid, best_yes_ask FROM kalshi_book_snapshots
       WHERE market_ticker = m.ticker AND ts > now() - interval '2 minutes'
       ORDER BY ts DESC LIMIT 1
     ) b ON true
     WHERE m.series_ticker = ANY($1)
       AND m.open_time <= now() AND m.close_time > now() AND m.floor_strike IS NOT NULL`,
    [['KXETH15M', 'KXSOL15M', 'KXXRP15M', 'KXDOGE15M', 'KXBNB15M', 'KXHYPE15M']]
  );
  out.tandem = { spots, contracts: altBooks };

  out.tape = await q(
    `SELECT source, (array_agg(price::float8 ORDER BY ts DESC))[1] AS last,
            (array_agg(price::float8 ORDER BY ts DESC))[count(*)] AS old
     FROM index_ticks
     WHERE source IN ('pyth_xau','pyth_xag','pyth_wtiv6','pyth_btc','pm_binance')
       AND ts > now() - interval '15 minutes'
     GROUP BY source`
  );

  out.recent = await q(
    `SELECT to_char(close_time AT TIME ZONE 'America/Denver', 'HH24:MI') AS close_mt,
            floor_strike::float8 AS strike, expiration_value::numeric::float8 AS settle, result
     FROM kalshi_markets
     WHERE series_ticker = 'KXBTC15M' AND result IN ('yes','no')
       AND expiration_value ~ '^[0-9.]+$' AND floor_strike IS NOT NULL
     ORDER BY close_time DESC LIMIT 8`
  );

  return out;
}

async function pathAggregates() {
  const out = {};
  out.full = await q(
    `SELECT width_bucket(secs_above::float / n_secs, 0, 1.0001, 5) AS b,
            count(*)::int AS n, avg((result = 'yes')::int)::float8 AS p_yes,
            avg(twad)::float8 AS avg_twad
     FROM window_path_stats GROUP BY 1 ORDER BY 1`
  );
  out.prefix = await q(
    `SELECT min_mark, width_bucket(secs_above::float / n_secs, 0, 1.0001, 5) AS b,
            count(*)::int AS n, avg((result = 'yes')::int)::float8 AS p_yes
     FROM window_path_prefix GROUP BY 1, 2 ORDER BY 1, 2`
  );
  out.reversal = (await q(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE result = 'no')::int AS settled_no,
            avg(twad) FILTER (WHERE result = 'no')::float8 AS twad_no,
            avg(twad) FILTER (WHERE result = 'yes')::float8 AS twad_yes
     FROM window_path_stats WHERE secs_above >= 720`
  ))[0];
  out.thin = await q(
    `SELECT width_bucket(twad, 0, 150.0001, 3) AS b, count(*)::int AS n,
            avg((result = 'no')::int)::float8 AS p_no
     FROM window_path_stats
     WHERE secs_above >= 720 AND twad >= 0 AND twad <= 150
     GROUP BY 1 ORDER BY 1`
  );
  out.windows = (await q(`SELECT count(*)::int AS n, min(close_time) AS first FROM window_path_stats`))[0];
  return out;
}

async function systemState() {
  const out = {};
  out.ages = (await q(
    `SELECT
       extract(epoch FROM now() - (SELECT max(ts) FROM kalshi_book_snapshots))::int AS books_s,
       extract(epoch FROM now() - (SELECT max(ts) FROM index_ticks WHERE source='proxy_composite'))::int AS proxy_s,
       extract(epoch FROM now() - (SELECT max(ts) FROM index_ticks WHERE source='pyth_xau'))::int AS pyth_s,
       (SELECT count(*) FROM kalshi_book_deltas WHERE received_at > now() - interval '10 minutes')::int AS deltas_10m,
       (SELECT count(*) FROM index_ticks WHERE ts > now() - interval '10 minutes')::int AS idx_10m`
  ))[0];
  // Big tables use autovacuum estimates (n_live_tup) — exact counts over tens
  // of millions of rows are multi-second scans, far too slow for a status tile.
  out.holdings = (await q(
    `SELECT (SELECT pg_size_pretty(pg_database_size(current_database()))) AS db,
       (SELECT count(*) FROM kalshi_markets)::bigint AS markets,
       (SELECT coalesce(sum(n_live_tup), 0)::bigint FROM pg_stat_user_tables WHERE relname LIKE 'kalshi_trades%') AS trades,
       (SELECT count(*) FROM kalshi_candles_1m)::bigint AS candles,
       (SELECT coalesce(sum(n_live_tup), 0)::bigint FROM pg_stat_user_tables WHERE relname LIKE 'kalshi_book_deltas%') AS deltas,
       (SELECT coalesce(sum(n_live_tup), 0)::bigint FROM pg_stat_user_tables WHERE relname LIKE 'kalshi_book_snapshots%') AS snapshots,
       (SELECT coalesce(sum(n_live_tup), 0)::bigint FROM pg_stat_user_tables WHERE relname LIKE 'spot_bars_1s%') AS spot_bars,
       (SELECT count(*) FROM dislocation_events)::int AS events`
  ))[0];
  const ALT_SERIES = ['KXETH15M', 'KXSOL15M', 'KXXRP15M', 'KXDOGE15M', 'KXBNB15M', 'KXHYPE15M'];
  out.backfill = (await q(
    `SELECT
      (SELECT count(*) FROM kalshi_markets m JOIN backfill_progress p ON p.market_ticker=m.ticker
        WHERE m.series_ticker != 'KXBTC' AND NOT (m.series_ticker = ANY($1)) AND p.candles_done)::int AS m15_done,
      (SELECT count(*) FROM kalshi_markets WHERE series_ticker != 'KXBTC' AND NOT (series_ticker = ANY($1))
        AND close_time < now() AND close_time > now() - interval '90 days')::int AS m15_total,
      (SELECT count(*) FROM kalshi_markets m JOIN backfill_progress p ON p.market_ticker=m.ticker
        WHERE m.series_ticker = ANY($1) AND p.candles_done)::int AS alt_done,
      (SELECT count(*) FROM kalshi_markets WHERE series_ticker = ANY($1)
        AND close_time < now() AND close_time > now() - interval '90 days')::int AS alt_total,
      (SELECT count(*) FROM kalshi_markets m JOIN backfill_progress p ON p.market_ticker=m.ticker
        WHERE m.series_ticker = 'KXBTC' AND p.candles_done)::int AS btc_done,
      (SELECT count(*) FROM kalshi_markets WHERE series_ticker='KXBTC'
        AND close_time < now() AND close_time > now() - interval '90 days')::int AS btc_total`,
    [ALT_SERIES]
  ))[0];
  out.continuity = await q(
    `SELECT date_trunc('hour', ts) AS hour, count(*)::int AS n
     FROM index_ticks
     WHERE source = 'proxy_composite' AND ts > now() - interval '24 hours'
     GROUP BY 1 ORDER BY 1`
  );
  try {
    const nar = JSON.parse(require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'scripts', 'dashboard-narrative.json'), 'utf8'));
    out.findings = nar.findings;
  } catch (e) { out.findings = []; }
  return out;
}

async function history24h() {
  return q(
    `SELECT to_char(close_time AT TIME ZONE 'America/Denver', 'MM-DD HH24:MI') AS close_mt,
            floor_strike::float8 AS strike, expiration_value::numeric::float8 AS settle, result
     FROM kalshi_markets
     WHERE series_ticker='KXBTC15M' AND result IN ('yes','no')
       AND expiration_value ~ '^[0-9.]+$' AND floor_strike IS NOT NULL
       AND close_time > now() - interval '24 hours' AND close_time <= now()
     ORDER BY close_time`
  );
}

async function paperState() {
  const out = {};
  out.trades = await q(
    `SELECT id, to_char(ts AT TIME ZONE 'America/Denver', 'MM-DD HH24:MI:SS') AS ts_mt,
            strategy, market_ticker, side, role, price::float8 AS price, fee::float8 AS fee,
            contracts::float8 AS contracts, cost::float8 AS cost,
            fair_at_entry::float8 AS fair, mid_at_entry::float8 AS mid, note, status, result, pnl::float8 AS pnl
     FROM paper_trades ORDER BY ts DESC LIMIT 40`
  );
  out.stats = await q(
    `SELECT strategy, count(*)::int AS n,
            count(*) FILTER (WHERE status='settled')::int AS settled,
            count(*) FILTER (WHERE status='settled' AND pnl > 0)::int AS wins,
            coalesce(sum(pnl) FILTER (WHERE status='settled'), 0)::float8 AS pnl
     FROM paper_trades GROUP BY strategy ORDER BY strategy`
  );
  // Live mark of every open position at the current book mid (side-adjusted;
  // falls back to cost basis when the book is momentarily dark).
  const openMarks = await q(
    `SELECT t.strategy, count(*)::int AS n_open,
            sum(t.cost)::float8 AS open_cost,
            sum(CASE WHEN b.mid IS NULL THEN t.cost
                     WHEN t.side = 'yes' THEN t.contracts * b.mid
                     ELSE t.contracts * (1 - b.mid) END)::float8 AS open_mark
     FROM paper_trades t
     LEFT JOIN LATERAL (
       SELECT mid::float8 AS mid FROM kalshi_book_snapshots b
       WHERE b.market_ticker = t.market_ticker AND b.ts > now() - interval '2 minutes'
       ORDER BY b.ts DESC LIMIT 1
     ) b ON true
     WHERE t.status = 'open' GROUP BY t.strategy`
  );
  out.openByStrategy = {};
  for (const r of openMarks) out.openByStrategy[r.strategy] = { n: r.n_open, cost: r.open_cost, mark: r.open_mark };
  out.equity = await q(
    `SELECT extract(epoch FROM ts) AS sec, equity::float8 AS equity FROM paper_equity ORDER BY ts`
  );
  // Open positions with live per-position marks: side-adjusted current price
  // from the freshest book snapshot, marked value, and unrealized P&L.
  out.open = await q(
    `SELECT t.id, to_char(t.ts AT TIME ZONE 'America/Denver', 'HH24:MI:SS') AS ts_mt,
            t.strategy, t.market_ticker, t.side, t.role,
            t.price::float8 AS entry, t.contracts::float8 AS contracts, t.cost::float8 AS cost,
            CASE WHEN b.mid IS NULL THEN NULL
                 WHEN t.side = 'yes' THEN b.mid ELSE 1 - b.mid END AS px_now,
            extract(epoch FROM m.close_time - now())::int AS secs_to_close
     FROM paper_trades t
     JOIN kalshi_markets m ON m.ticker = t.market_ticker
     LEFT JOIN LATERAL (
       SELECT mid::float8 AS mid FROM kalshi_book_snapshots b
       WHERE b.market_ticker = t.market_ticker AND b.ts > now() - interval '2 minutes'
       ORDER BY b.ts DESC LIMIT 1
     ) b ON true
     WHERE t.status = 'open'
     ORDER BY t.strategy, t.ts`
  );
  for (const p of out.open) {
    p.value = p.px_now === null ? p.cost : p.contracts * p.px_now;
    p.upnl = p.value - p.cost;
  }
  const last = out.equity[out.equity.length - 1];
  out.signals = latestSignals;
  out.now = { equity: last ? last.equity : 500, stopped: require('fs').existsSync(require('path').join(__dirname, '..', '..', '.paper-stop')) };

  // Monte Carlo panel per strategy: bootstrap CI on EV/trade + 14-day
  // survival simulation drawing from that strategy's own settled P&L.
  const pnlRows = await q(
    `SELECT strategy, array_agg(pnl::float8 ORDER BY settled_at) AS pnls,
            extract(epoch FROM now() - min(ts)) / 86400 AS days
     FROM paper_trades WHERE status = 'settled' GROUP BY strategy`
  );
  out.mc = {};
  for (const r of pnlRows) {
    const pnls = r.pnls;
    const nT = pnls.length;
    if (nT < 10) {
      out.mc[r.strategy] = { n: nT, ready: false };
      continue;
    }
    const B = 2000;
    const means = [];
    for (let b = 0; b < B; b++) {
      let s = 0;
      for (let i = 0; i < nT; i++) s += pnls[(Math.random() * nT) | 0];
      means.push(s / nT);
    }
    means.sort((a, b) => a - b);
    const rate = Math.max(1, nT / Math.max(r.days, 0.05));
    const horizonTrades = Math.round(rate * 14);
    const SIM = 2000;
    let survive = 0;
    let profit = 0;
    for (let s = 0; s < SIM; s++) {
      let eq = 100;
      let stopped = false;
      for (let t = 0; t < horizonTrades; t++) {
        eq += pnls[(Math.random() * nT) | 0];
        if (eq < 70) { stopped = true; break; }
      }
      if (!stopped) survive += 1;
      if (eq > 100) profit += 1;
    }
    out.mc[r.strategy] = {
      n: nT,
      ready: true,
      ev: pnls.reduce((s, v) => s + v, 0) / nT,
      ci_lo: means[(B * 0.05) | 0],
      ci_hi: means[(B * 0.95) | 0],
      trades_per_day: rate,
      p_survive_14d: survive / SIM,
      p_profit_14d: profit / SIM
    };
  }
  return out;
}

const html = require('fs').readFileSync(require('path').join(__dirname, 'live-board.html'), 'utf8');
const paperHtml = require('fs').readFileSync(require('path').join(__dirname, 'paper-desk.html'), 'utf8');
const rulesHtml = require('fs').readFileSync(require('path').join(__dirname, 'rules.html'), 'utf8');

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/api/live') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(await cached('live', 1000, liveState)));
    } else if (req.url === '/api/path') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(await cached('path', 300000, pathAggregates)));
    } else if (req.url === '/api/system') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(await cached('system', 60000, systemState)));
    } else if (req.url === '/api/history') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(await cached('history', 120000, history24h)));
    } else if (req.url === '/api/paper') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(await cached('paper', 2000, paperState)));
    } else if (req.url === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (e) {} }, 15000);
      req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
    } else if (req.url === '/rules') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(rulesHtml);
    } else if (req.url === '/paper') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(paperHtml);
    } else if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  } catch (err) {
    log.error('live-board request failed', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, HOST, () => log.info(`live-board on http://${HOST}:${PORT}`));
