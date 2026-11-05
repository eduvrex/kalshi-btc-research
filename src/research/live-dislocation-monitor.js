'use strict';

// Live dislocation monitor -- the automated version of Eduardo watching the CF
// Benchmarks site next to the Kalshi book.
//
// Once per second it compares the index proxy against the active 15-minute
// market's strike, computes martingale fair value, and compares that to the
// quoted book from the collector. When fair and mid disagree by at least
// DISLOC_MIN_GAP for DISLOC_MIN_RUN_S consecutive seconds, it opens an event,
// tracks its peak (including size at the touch -- fill-ability), persists it to
// dislocation_events on close, and pushes a phone alert via ntfy.
//
// Runs alongside the collectors (PM2 app "dislocation-monitor"). Requires both
// collectors to be running: it reads their output, it does not talk to venues.
// It never places orders.

const config = require('../lib/config');
const log = require('../lib/log');
const db = require('../lib/db');
const { normalCdf } = require('./calibration');

const SETTLE_AVG_S = 60;
const SIGMA_WINDOW_S = 1800;
const SIGMA_REFRESH_MS = 60000;
const STALE_PROXY_MS = 10000;
const STALE_BOOK_MS = 45000;

let sigma = null;
let sigmaAt = 0;
let lastAlertMs = 0;
const openEvents = new Map(); // market_ticker -> event state
const stats = { ticks: 0, evaluations: 0, eventsOpened: 0, eventsClosed: 0 };

async function refreshSigma() {
  const res = await db.pool.query(
    `SELECT extract(epoch FROM ts)::bigint AS sec, price::float8 AS price
     FROM index_ticks
     WHERE source = 'proxy_composite' AND ts > now() - interval '${SIGMA_WINDOW_S} seconds'
     ORDER BY ts`
  );
  let sumSq = 0;
  let n = 0;
  let prev = null;
  for (const r of res.rows) {
    if (prev !== null) {
      const dt = r.sec - prev.sec;
      if (dt > 0 && dt <= 10) {
        const ret = Math.log(r.price / prev.price);
        sumSq += (ret * ret) / dt;
        n += 1;
      }
    }
    prev = r;
  }
  if (n >= SIGMA_WINDOW_S / 4) {
    sigma = Math.sqrt(sumSq / n);
    sigmaAt = Date.now();
  } else {
    sigma = null;
  }
}

async function latestProxy() {
  const res = await db.pool.query(
    `SELECT price::float8 AS price, ts
     FROM index_ticks WHERE source = 'proxy_composite'
     ORDER BY ts DESC LIMIT 1`
  );
  if (!res.rows.length) return null;
  const r = res.rows[0];
  if (Date.now() - new Date(r.ts).getTime() > STALE_PROXY_MS) return null;
  return r.price;
}

async function activeMarkets() {
  const res = await db.pool.query(
    `SELECT ticker, floor_strike::float8 AS strike,
            extract(epoch FROM close_time) AS close_sec
     FROM kalshi_markets
     WHERE series_ticker = ANY($1)
       AND floor_strike IS NOT NULL
       AND open_time <= now()
       AND close_time > now() + interval '120 seconds'`,
    // BTC series only: the proxy is a BTC composite. Evaluating commodity
    // strikes (~3-83 dollars) against a ~80k BTC proxy pins fair at 1.0 and
    // manufactures giant phantom dislocations (observed 2026-08-28). Commodity
    // series join here only once a per-series index feed exists.
    [config.kalshi.series.filter((s) => s === 'KXBTC15M')]
  );
  return res.rows;
}

async function latestBook(ticker) {
  const res = await db.pool.query(
    `SELECT ts, best_yes_bid::float8 AS bid, best_yes_ask::float8 AS ask,
            yes_bids, no_bids
     FROM kalshi_book_snapshots
     WHERE market_ticker = $1
     ORDER BY ts DESC LIMIT 1`,
    [ticker]
  );
  if (!res.rows.length) return null;
  const r = res.rows[0];
  if (Date.now() - new Date(r.ts).getTime() > STALE_BOOK_MS) return null;
  if (r.bid === null || r.ask === null || !(r.ask > r.bid)) return null;
  const yesBids = r.yes_bids || [];
  const noBids = r.no_bids || [];
  return {
    bid: r.bid,
    ask: r.ask,
    bidSize: yesBids.length ? Number(yesBids[0][1]) : 0,
    askSize: noBids.length ? Number(noBids[0][1]) : 0
  };
}

async function ntfy(message) {
  if (!config.ntfyTopic) return;
  const now = Date.now();
  if (now - lastAlertMs < config.dislocation.alertCooldownS * 1000) return;
  lastAlertMs = now;
  try {
    await fetch(`https://ntfy.sh/${config.ntfyTopic}`, {
      method: 'POST',
      headers: { Title: 'Dislocation event' },
      body: message
    });
  } catch (err) {
    log.warn('ntfy failed', err.message);
  }
}

function updatePeak(ev, obs) {
  ev.nSeconds += 1;
  ev.gapSum += Math.abs(obs.gap);
  if (Math.abs(obs.gap) > Math.abs(ev.maxGap)) {
    ev.maxGap = obs.gap;
    ev.dAtMax = obs.d;
    ev.zAtMax = obs.z;
    ev.fairAtMax = obs.fair;
    ev.midAtMax = obs.mid;
    ev.askAtMax = obs.ask;
    ev.bidAtMax = obs.bid;
    ev.askSizeAtMax = obs.askSize;
    ev.bidSizeAtMax = obs.bidSize;
  }
}

async function closeEvent(ticker, ev) {
  openEvents.delete(ticker);
  if (ev.nSeconds < config.dislocation.minRunS) return;
  stats.eventsClosed += 1;
  try {
    await db.pool.query(
      `INSERT INTO dislocation_events
         (market_ticker, started_at, ended_at, duration_s, strike, side,
          max_gap, mean_gap, d_at_max, z_at_max, fair_at_max, mid_at_max,
          ask_at_max, bid_at_max, ask_size_at_max, bid_size_at_max, n_seconds, alerted)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        ticker, ev.startedAt, new Date(),
        Math.round((Date.now() - ev.startedAt.getTime()) / 1000),
        ev.strike, ev.side, ev.maxGap, ev.gapSum / ev.nSeconds,
        ev.dAtMax, ev.zAtMax, ev.fairAtMax, ev.midAtMax,
        ev.askAtMax, ev.bidAtMax, ev.askSizeAtMax, ev.bidSizeAtMax,
        ev.nSeconds, ev.alerted
      ]
    );
  } catch (err) {
    log.error('event insert failed', err.message);
  }
}

async function tick() {
  stats.ticks += 1;
  if (Date.now() - sigmaAt > SIGMA_REFRESH_MS) await refreshSigma();
  if (sigma === null) return;
  const proxy = await latestProxy();
  if (proxy === null) return;
  const markets = await activeMarkets();
  const seen = new Set();

  for (const m of markets) {
    const book = await latestBook(m.ticker);
    if (!book) continue;
    stats.evaluations += 1;
    seen.add(m.ticker);

    // Var(60s settlement avg - now) = sigma^2 * (tau - 2D/3); see build-dataset.
    const tauEff = Math.max(m.close_sec - Date.now() / 1000 - (2 * SETTLE_AVG_S) / 3, 1);
    const d = proxy - m.strike;
    const z = Math.log(proxy / m.strike) / (sigma * Math.sqrt(tauEff));
    const fair = normalCdf(z);
    const mid = (book.bid + book.ask) / 2;
    const gap = fair - mid;
    const obs = { d, z, fair, mid, gap, ask: book.ask, bid: book.bid, askSize: book.askSize, bidSize: book.bidSize };

    const active = Math.abs(gap) >= config.dislocation.minGap;
    const ev = openEvents.get(m.ticker);

    if (active && !ev) {
      openEvents.set(m.ticker, {
        startedAt: new Date(),
        strike: m.strike,
        side: gap > 0 ? 'yes_cheap' : 'no_cheap',
        nSeconds: 0,
        gapSum: 0,
        maxGap: 0,
        alerted: false
      });
      updatePeak(openEvents.get(m.ticker), obs);
      stats.eventsOpened += 1;
    } else if (active && ev) {
      updatePeak(ev, obs);
      if (!ev.alerted && ev.nSeconds >= config.dislocation.minRunS) {
        ev.alerted = true;
        const dir = gap > 0 ? 'YES cheap' : 'NO cheap';
        await ntfy(
          `${m.ticker} ${dir} ${ev.nSeconds}s: index ${d >= 0 ? '+' : ''}${d.toFixed(2)} vs strike, ` +
          `fair ${(fair * 100).toFixed(1)} vs mid ${(mid * 100).toFixed(1)}, ` +
          `ask ${(book.ask * 100).toFixed(1)}c x ${book.askSize.toFixed(0)}`
        );
      }
    } else if (!active && ev) {
      await closeEvent(m.ticker, ev);
    }
  }

  for (const [ticker, ev] of openEvents) {
    if (!seen.has(ticker)) await closeEvent(ticker, ev);
  }
}

async function main() {
  await refreshSigma();
  setInterval(() => {
    tick().catch((err) => log.error('tick error', err.message));
  }, 1000);
  setInterval(() => {
    db.heartbeat('dislocation-monitor', { ...stats, open: openEvents.size, sigma })
      .catch((err) => log.error('heartbeat error', err.message));
  }, 10000);
  log.info('dislocation monitor started', config.dislocation);
}

main().catch((err) => {
  log.error('fatal', err);
  process.exit(1);
});
