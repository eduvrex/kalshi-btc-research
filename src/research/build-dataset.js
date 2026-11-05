'use strict';

// Builds the research dataset from backfilled Kalshi data + downloaded spot bars.
//
// For every settled KXBTC15M market, emits one model_rows row per minute mark:
//   x     = ln(spot_now / spot_60s_avg_before_open)   -- estimated log distance to strike
//   sigma = realized per-second vol of composite 1s log returns, trailing 30 min
//   z     = x / (sigma * sqrt(tau_eff))               -- normalized distance
//   plus the Kalshi quote/price candle state at that minute, the next minute's
//   opening quotes (for look-ahead-free fills), and the settled outcome y.
//
// Key identity making this work without licensed BRTI data: the strike of each
// 15-min market IS the official BRTI 60s average at open, and the settlement IS
// the official BRTI 60s average at close. Spot enters only as a *relative* path
// (S_t vs S_open_avg), so constant spot-vs-BRTI level offsets cancel.
//
// Also writes settlement_screens: per-market spot move during the 60s settlement
// window vs the reversal after close (manipulation signature screen).
//
// Usage: node src/research/build-dataset.js [--rebuild]

const config = require('../lib/config');
const log = require('../lib/log');
const db = require('../lib/db');

const SIGMA_WINDOW_S = 1800;
const SETTLE_AVG_S = 60;

function dayKey(d) {
  return d.toISOString().slice(0, 10);
}

// ---------- spot series for one day (with margins) ----------

// Composite membership must be stable: averaging whichever venues happen to
// have a trade that second steps the series by the cross-venue basis at every
// membership change, inflating realized sigma and breaking the header's
// offset-cancellation identity. Forward-fill each venue up to FF_CAP_S, and
// emit a composite second only when EVERY venue is fresh.
const FF_CAP_S = 60;

async function loadSpotDay(dayStartMs, dayEndMs) {
  const res = await db.pool.query(
    `SELECT extract(epoch FROM ts)::bigint AS sec, exchange, close::float8 AS close
     FROM spot_bars_1s
     WHERE ts >= to_timestamp($1) AND ts < to_timestamp($2)`,
    [dayStartMs / 1000 - SIGMA_WINDOW_S - 600, dayEndMs / 1000 + 600]
  );
  const perExch = new Map();
  let minSec = Infinity;
  let maxSec = -Infinity;
  for (const row of res.rows) {
    const sec = Number(row.sec);
    if (sec < minSec) minSec = sec;
    if (sec > maxSec) maxSec = sec;
    let m = perExch.get(row.exchange);
    if (!m) {
      m = new Map();
      perExch.set(row.exchange, m);
    }
    m.set(sec, row.close);
  }
  const composite = new Map();
  if (perExch.size === 0) return composite;
  const last = new Map(); // exchange -> { v, s }
  for (let s = minSec; s <= maxSec; s++) {
    let sum = 0;
    let n = 0;
    for (const [exch, m] of perExch) {
      const v = m.get(s);
      if (v !== undefined) last.set(exch, { v, s });
      const l = last.get(exch);
      if (l && s - l.s <= FF_CAP_S) {
        sum += l.v;
        n += 1;
      }
    }
    if (n === perExch.size) composite.set(s, sum / n);
  }
  return composite;
}

function spotAt(composite, sec, maxLookback = 10) {
  for (let i = 0; i <= maxLookback; i++) {
    const v = composite.get(sec - i);
    if (v !== undefined) return v;
  }
  return null;
}

function spotAvg(composite, fromSec, toSec) {
  let sum = 0;
  let n = 0;
  for (let s = fromSec; s < toSec; s++) {
    const v = composite.get(s);
    if (v !== undefined) {
      sum += v;
      n += 1;
    }
  }
  return n >= (toSec - fromSec) / 2 ? sum / n : null;
}

function realizedSigma(composite, endSec, windowS) {
  let sumSq = 0;
  let n = 0;
  let prev = null;
  for (let s = endSec - windowS; s <= endSec; s++) {
    const v = composite.get(s);
    if (v === undefined) continue;
    if (prev !== null) {
      const r = Math.log(v / prev.v);
      const dt = s - prev.s;
      sumSq += (r * r) / dt;
      n += 1;
    }
    prev = { v, s };
  }
  if (n < windowS / 4) return null;
  return Math.sqrt(sumSq / n);
}

// ---------- per-market processing ----------

function num(v) {
  return v === null || v === undefined ? null : Number(v);
}

async function processMarket(m, composite, candles) {
  const openSec = Math.floor(new Date(m.open_time).getTime() / 1000);
  const closeSec = Math.floor(new Date(m.close_time).getTime() / 1000);
  const y = m.result === 'yes' ? 1 : 0;

  const sOpenAvg = spotAvg(composite, openSec - SETTLE_AVG_S, openSec);
  if (sOpenAvg === null) return { rows: [], screen: null, skipped: 'no_open_avg' };

  const byEnd = new Map();
  for (const c of candles) byEnd.set(Number(c.period_end_sec), c);

  const rows = [];
  for (let t = openSec + 60; t <= closeSec - 120; t += 60) {
    const cur = byEnd.get(t);
    const next = byEnd.get(t + 60);
    const sNow = spotAt(composite, t);
    if (sNow === null) continue;
    const x = Math.log(sNow / sOpenAvg);
    const sigma = realizedSigma(composite, t, SIGMA_WINDOW_S);
    // Settlement is a 60s average: Var(avg - now) = sigma^2 * (tau - 2D/3),
    // not the centroid heuristic's tau - D/2. See test/math.test.js.
    const tauEff = Math.max(closeSec - t - (2 * SETTLE_AVG_S) / 3, 1);
    const z = sigma ? x / (sigma * Math.sqrt(tauEff)) : null;
    rows.push([
      m.ticker,
      new Date(t * 1000),
      closeSec - t,
      x,
      sigma,
      z,
      cur ? num(cur.yes_bid_close) : null,
      cur ? num(cur.yes_ask_close) : null,
      cur ? num(cur.price_close) : null,
      next ? num(next.yes_bid_open) : null,
      next ? num(next.yes_ask_open) : null,
      cur ? num(cur.volume) : null,
      y
    ]);
  }

  const settleAvg = spotAvg(composite, closeSec - SETTLE_AVG_S, closeSec);
  const priorAvg = spotAvg(composite, closeSec - 2 * SETTLE_AVG_S, closeSec - SETTLE_AVG_S);
  const afterAvg = spotAvg(composite, closeSec + SETTLE_AVG_S, closeSec + 2 * SETTLE_AVG_S);
  const screen = settleAvg && priorAvg
    ? [
        m.ticker,
        m.close_time,
        m.floor_strike,
        m.expiration_value,
        m.result,
        Math.log(settleAvg / priorAvg),
        afterAvg ? Math.log(afterAvg / settleAvg) : null,
        spotAt(composite, closeSec)
      ]
    : null;

  return { rows, screen, skipped: null };
}

// ---------- main ----------

async function main() {
  if (process.argv.includes('--rebuild')) {
    await db.pool.query('TRUNCATE model_rows');
    await db.pool.query('TRUNCATE settlement_screens');
    log.info('rebuild: truncated model_rows and settlement_screens');
  }

  const markets = (
    await db.pool.query(
      `SELECT ticker, open_time, close_time, result, floor_strike, expiration_value
       FROM kalshi_markets
       WHERE series_ticker = 'KXBTC15M'
         AND result IN ('yes', 'no')
         AND floor_strike IS NOT NULL
         AND open_time IS NOT NULL
         AND close_time > now() - ($1 || ' days')::interval
       ORDER BY close_time`,
      [String(config.backfillDays)]
    )
  ).rows;
  log.info(`dataset: ${markets.length} settled KXBTC15M markets to process`);

  const byDay = new Map();
  for (const m of markets) {
    const k = dayKey(new Date(m.close_time));
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(m);
  }

  let totalRows = 0;
  let totalScreens = 0;
  const skipReasons = {};
  for (const [day, dayMarkets] of byDay) {
    const dayStartMs = new Date(`${day}T00:00:00Z`).getTime();
    const composite = await loadSpotDay(dayStartMs, dayStartMs + 86400000);
    if (composite.size === 0) {
      skipReasons.no_spot_data = (skipReasons.no_spot_data || 0) + dayMarkets.length;
      continue;
    }
    const tickers = dayMarkets.map((m) => m.ticker);
    const candleRes = await db.pool.query(
      `SELECT market_ticker,
              extract(epoch FROM period_end)::bigint AS period_end_sec,
              (raw->'yes_bid'->>'close_dollars')::float8 AS yes_bid_close,
              (raw->'yes_ask'->>'close_dollars')::float8 AS yes_ask_close,
              (raw->'yes_bid'->>'open_dollars')::float8  AS yes_bid_open,
              (raw->'yes_ask'->>'open_dollars')::float8  AS yes_ask_open,
              yes_close::float8 AS price_close,
              volume::float8 AS volume
       FROM kalshi_candles_1m
       WHERE market_ticker = ANY($1)`,
      [tickers]
    );
    const candlesByTicker = new Map();
    for (const c of candleRes.rows) {
      if (!candlesByTicker.has(c.market_ticker)) candlesByTicker.set(c.market_ticker, []);
      candlesByTicker.get(c.market_ticker).push(c);
    }

    const rowBuf = [];
    const screenBuf = [];
    for (const m of dayMarkets) {
      const out = await processMarket(m, composite, candlesByTicker.get(m.ticker) || []);
      if (out.skipped) skipReasons[out.skipped] = (skipReasons[out.skipped] || 0) + 1;
      rowBuf.push(...out.rows);
      if (out.screen) screenBuf.push(out.screen);
    }
    totalRows += await db.batchInsert(
      'model_rows',
      ['market_ticker', 'ts', 'tau_s', 'x', 'sigma', 'z', 'yes_bid_close', 'yes_ask_close', 'price_close', 'next_yes_bid_open', 'next_yes_ask_open', 'volume_min', 'y'],
      rowBuf,
      'ON CONFLICT (market_ticker, ts) DO NOTHING'
    );
    totalScreens += await db.batchInsert(
      'settlement_screens',
      ['market_ticker', 'close_time', 'strike', 'settle', 'result', 'r_settle', 'r_after', 'spot_at_close'],
      screenBuf,
      'ON CONFLICT (market_ticker) DO NOTHING'
    );
    log.info(`dataset: ${day} done (${dayMarkets.length} markets)`);
  }

  log.info(`dataset complete: ${totalRows} model rows, ${totalScreens} screens inserted, skips: ${JSON.stringify(skipReasons)}`);
  await db.pool.end();
}

main().catch((err) => {
  log.error('fatal', err);
  process.exit(1);
});
