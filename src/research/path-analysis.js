'use strict';

// Eduardo's path question: how long did the index spend above/below the strike
// during each 15-minute window, at what average distance, and how did the
// window settle? Populates window_path_stats (full window) and
// window_path_prefix (state at minute marks 3/6/9/12 — no look-ahead: a
// prefix row uses only seconds <= its mark).
//
// Path = Kraken 1s bar closes (full 90d coverage, 24/7), anchored to the
// official strike via the 60s pre-open Kraken average: dist_t = k_t - kAvgOpen.
// dist > 0 <=> index above strike, in the same sense the settlement average
// resolves it, with the Kraken-vs-BRTI level basis cancelled by the anchor.
//
// Usage: node src/research/path-analysis.js [--rebuild]

const config = require('../lib/config');
const log = require('../lib/log');
const db = require('../lib/db');

const MARKS = [3, 6, 9, 12];
const MIN_COVERAGE = 750; // of 900 seconds
const MIN_ANCHOR = 30;    // of 60 pre-open seconds

function dayKey(d) {
  return d.toISOString().slice(0, 10);
}

async function loadKrakenDay(dayStartMs, dayEndMs) {
  const res = await db.pool.query(
    `SELECT extract(epoch FROM ts)::bigint AS sec, close::float8 AS close
     FROM spot_bars_1s
     WHERE exchange = 'kraken' AND ts >= to_timestamp($1) AND ts < to_timestamp($2)`,
    [dayStartMs / 1000 - 1000, dayEndMs / 1000 + 60]
  );
  const m = new Map();
  for (const r of res.rows) m.set(Number(r.sec), r.close);
  return m;
}

const FF_CAP_S = 30; // Kraken bars are trade-driven and sparse; no trade = price unchanged

function processWindow(m, bars) {
  const closeSec = Math.floor(new Date(m.close_time).getTime() / 1000);
  const openSec = closeSec - 900;

  // One forward-filled walk over anchor window + trading window.
  let lastVal;
  let lastSec = -Infinity;
  const sample = (s) => {
    const v = bars.get(s);
    if (v !== undefined) {
      lastVal = v;
      lastSec = s;
    }
    return s - lastSec <= FF_CAP_S ? lastVal : undefined;
  };

  let aSum = 0;
  let aN = 0;
  for (let s = openSec - 60; s < openSec; s++) {
    const v = sample(s);
    if (v !== undefined) {
      aSum += v;
      aN += 1;
    }
  }
  if (aN < MIN_ANCHOR) return null;
  const anchor = aSum / aN;

  let nSecs = 0;
  let secsAbove = 0;
  let sumAbove = 0;
  let sumBelow = 0;
  let sumAll = 0;
  const prefixes = [];
  let mi = 0;
  for (let s = openSec; s < closeSec; s++) {
    if (mi < MARKS.length && s === openSec + MARKS[mi] * 60) {
      prefixes.push({ min_mark: MARKS[mi], n_secs: nSecs, secs_above: secsAbove, twad: nSecs ? sumAll / nSecs : 0 });
      mi += 1;
    }
    const v = sample(s);
    if (v === undefined) continue;
    const dist = v - anchor;
    nSecs += 1;
    sumAll += dist;
    if (dist > 0) {
      secsAbove += 1;
      sumAbove += dist;
    } else {
      sumBelow += dist;
    }
  }
  if (nSecs < MIN_COVERAGE) return null;

  return {
    stats: [
      m.ticker,
      m.close_time,
      m.floor_strike,
      m.expiration_value,
      m.result,
      'kraken',
      nSecs,
      secsAbove,
      secsAbove ? sumAbove / secsAbove : null,
      nSecs - secsAbove ? sumBelow / (nSecs - secsAbove) : null,
      sumAll / nSecs
    ],
    prefixes: prefixes
      .filter((p) => p.n_secs >= (p.min_mark * 60) * 0.8)
      .map((p) => [m.ticker, p.min_mark, p.n_secs, p.secs_above, p.twad, m.result])
  };
}

async function main() {
  if (process.argv.includes('--rebuild')) {
    await db.pool.query('TRUNCATE window_path_stats');
    await db.pool.query('TRUNCATE window_path_prefix');
    log.info('rebuild: truncated path tables');
  }

  const markets = (
    await db.pool.query(
      `SELECT m.ticker, m.close_time, m.floor_strike, m.expiration_value, m.result
       FROM kalshi_markets m
       LEFT JOIN window_path_stats w ON w.market_ticker = m.ticker
       WHERE m.series_ticker = 'KXBTC15M'
         AND m.result IN ('yes','no')
         AND m.expiration_value ~ '^[0-9.]+$'
         AND m.floor_strike IS NOT NULL
         AND m.close_time > now() - ($1 || ' days')::interval
         AND w.market_ticker IS NULL
       ORDER BY m.close_time`,
      [String(config.backfillDays)]
    )
  ).rows;
  log.info(`path analysis: ${markets.length} windows to process`);

  const byDay = new Map();
  for (const m of markets) {
    const k = dayKey(new Date(m.close_time));
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(m);
  }

  let done = 0;
  let skipped = 0;
  for (const [day, dayMarkets] of byDay) {
    const dayStartMs = new Date(`${day}T00:00:00Z`).getTime();
    const bars = await loadKrakenDay(dayStartMs, dayStartMs + 86400000);
    const statBuf = [];
    const prefBuf = [];
    for (const m of dayMarkets) {
      const out = bars.size ? processWindow(m, bars) : null;
      if (!out) {
        skipped += 1;
        continue;
      }
      statBuf.push(out.stats);
      prefBuf.push(...out.prefixes);
      done += 1;
    }
    await db.batchInsert(
      'window_path_stats',
      ['market_ticker', 'close_time', 'strike', 'settle', 'result', 'path_source', 'n_secs', 'secs_above', 'avg_above', 'avg_below', 'twad'],
      statBuf,
      'ON CONFLICT (market_ticker) DO NOTHING'
    );
    await db.batchInsert(
      'window_path_prefix',
      ['market_ticker', 'min_mark', 'n_secs', 'secs_above', 'twad', 'result'],
      prefBuf,
      'ON CONFLICT (market_ticker, min_mark) DO NOTHING'
    );
  }
  log.info(`path analysis complete: ${done} windows, ${skipped} skipped (coverage)`);
  await db.pool.end();
}

main().catch((err) => {
  log.error('fatal', err);
  process.exit(1);
});
