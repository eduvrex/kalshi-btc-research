'use strict';

// Calibration test: do quoted prices match realized outcome frequencies?
//
// This is the decisive coarse test for both of Eduardo's observations, and it
// needs NO external price data -- the quoted price comes from Kalshi's own
// 1-minute candles and the outcome from the settled market record. No BRTI
// licence, no Pyth key, no order-book depth, no spot feed.
//
// If contracts quoted at 10c resolve YES ~10% of the time, there is no edge no
// matter how manipulated the market is. If they resolve YES 15% of the time,
// there is a large edge no matter why.
//
// Usage: node src/research/calibration.js [series,series,...]
//        defaults to KALSHI_SERIES from .env

const fs = require('fs');
const path = require('path');
const config = require('../lib/config');
const db = require('../lib/db');
const log = require('../lib/log');

const PRICE_BUCKETS = [
  [0.00, 0.05], [0.05, 0.10], [0.10, 0.15], [0.15, 0.25], [0.25, 0.35],
  [0.35, 0.45], [0.45, 0.55], [0.55, 0.65], [0.65, 0.75], [0.75, 0.85],
  [0.85, 0.90], [0.90, 0.95], [0.95, 1.00]
];
const TAU_BUCKETS = [
  [0, 2], [2, 5], [5, 10], [10, 16]
];
const MIN_N = 100;

const lines = [];
function out(s = '') {
  lines.push(s);
}

// Kalshi taker fee, computed per 100 contracts then amortised per contract.
// fees = round_up_to_cent(0.07 * C * P * (1-P)); official schedule eff. 2026-02-05.
// The epsilon matters: 7 * 0.10 * 0.90 * 100 evaluates to 63.00000000000001 in
// IEEE754, and a naive ceil turns the official $0.63 into $0.64. Verified
// against all 15 rows of the published fee table in test/math.test.js.
function feePerContract(p) {
  if (!(p > 0) || !(p < 1)) return 0;
  const cents = 7 * p * (1 - p) * 100;
  return Math.ceil(cents - 1e-9) / 100 / 100;
}

function bucketIndex(buckets, v) {
  for (let i = 0; i < buckets.length; i++) {
    const [lo, hi] = buckets[i];
    if (v >= lo && (v < hi || (i === buckets.length - 1 && v <= hi))) return i;
  }
  return -1;
}

function fmt(v, d = 4) {
  return v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(d);
}

function wilson(k, n) {
  if (n === 0) return [null, null];
  const z = 1.96;
  const p = k / n;
  const den = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const half = z * Math.sqrt(p * (1 - p) / n + (z * z) / (4 * n * n));
  return [(centre - half) / den, (centre + half) / den];
}

function newCell() {
  return { n: 0, k: 0, sumMid: 0, sumAsk: 0, sumBid: 0 };
}

function addObs(cell, mid, ask, bid, y) {
  cell.n += 1;
  cell.k += y;
  cell.sumMid += mid;
  cell.sumAsk += ask;
  cell.sumBid += bid;
}

function summarise(cell) {
  const n = cell.n;
  const realized = cell.k / n;
  const meanMid = cell.sumMid / n;
  const meanAsk = cell.sumAsk / n;
  const meanBid = cell.sumBid / n;
  // z is tested against the null "quoted price = true probability", so the SE
  // comes from the quoted price, not the realized frequency — otherwise k=0 or
  // k=n cells (the most extreme miscalibrations, and exactly the tail buckets
  // under study) get se=0 and silently drop out of the significance count.
  const se = Math.sqrt((meanMid * (1 - meanMid)) / n);
  const gap = realized - meanMid;
  const z = se > 0 ? gap / se : null;
  // EV of taking: buy YES at the ask, or buy NO at (1 - bid).
  const evYes = realized - meanAsk - feePerContract(meanAsk);
  const noPx = 1 - meanBid;
  const evNo = (1 - realized) - noPx - feePerContract(noPx);
  return { n, realized, meanMid, meanAsk, meanBid, se, gap, z, evYes, evNo };
}

// ---------- report sections ----------

function calibrationTable(series, cells, critZ) {
  out(`### ${series}`);
  out();
  out('| quoted | mins left | n | mean quoted | realized | gap | z | 95% CI on realized | EV buy YES | EV buy NO |');
  out('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  let flagged = 0;
  for (let pi = 0; pi < PRICE_BUCKETS.length; pi++) {
    for (let ti = 0; ti < TAU_BUCKETS.length; ti++) {
      const cell = cells[pi][ti];
      if (cell.n < MIN_N) continue;
      const s = summarise(cell);
      const [lo, hi] = wilson(cell.k, cell.n);
      const sig = s.z !== null && Math.abs(s.z) > critZ;
      if (sig) flagged += 1;
      const pb = PRICE_BUCKETS[pi];
      const tb = TAU_BUCKETS[ti];
      out(
        `| ${pb[0].toFixed(2)}–${pb[1].toFixed(2)} | ${tb[0]}–${tb[1]} | ${s.n} | ${fmt(s.meanMid, 3)} | ` +
        `${fmt(s.realized, 3)} | ${s.gap >= 0 ? '+' : ''}${fmt(s.gap, 3)} | ${s.z === null ? '—' : s.z.toFixed(2)}${sig ? ' **' : ''} | ` +
        `${fmt(lo, 3)}–${fmt(hi, 3)} | ${s.evYes >= 0 ? '+' : ''}$${fmt(s.evYes, 4)} | ${s.evNo >= 0 ? '+' : ''}$${fmt(s.evNo, 4)} |`
      );
    }
  }
  out();
  out(`Cells exceeding the multiple-comparison-adjusted threshold (|z| > ${critZ.toFixed(2)}): **${flagged}**. Cells with n < ${MIN_N} are omitted.`);
  out();
}

function reversalPanel(bySeries) {
  out('## Reversal panel — the specific claim about commodities');
  out();
  out('Contracts quoted at 15c or below with 2–5 minutes left. The claim under test: these resolve YES more often than the quoted price implies. Positive "EV buy YES" here is the edge; negative means the market is priced correctly and the reversals you noticed were the expected minority of cases.');
  out();
  out('| series | n | mean quoted | realized YES | gap | z | EV per contract buying YES | EV per $100 risked |');
  out('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const [series, cell] of bySeries) {
    if (cell.n < 30) {
      out(`| ${series} | ${cell.n} | — | — | — | — | _insufficient data_ | — |`);
      continue;
    }
    const s = summarise(cell);
    const perDollar = s.meanAsk > 0 ? (s.evYes / (s.meanAsk + feePerContract(s.meanAsk))) * 100 : null;
    out(
      `| ${series} | ${s.n} | ${fmt(s.meanMid, 3)} | ${fmt(s.realized, 3)} | ${s.gap >= 0 ? '+' : ''}${fmt(s.gap, 3)} | ` +
      `${s.z === null ? '—' : s.z.toFixed(2)} | ${s.evYes >= 0 ? '+' : ''}$${fmt(s.evYes, 4)} | ${perDollar === null ? '—' : (perDollar >= 0 ? '+' : '') + perDollar.toFixed(1) + '%'} |`
    );
  }
  out();
}

function hourPanel(byHour) {
  out('## By hour of day (UTC) — testing the "thin overnight session" claim');
  out();
  out('All quoted prices, all times to expiry, bucketed by the hour the candle closed. A systematic gap concentrated in particular hours is consistent with the low-liquidity mispricing thesis.');
  out();
  out('| series | hour UTC | n | mean quoted | realized | gap | z |');
  out('| --- | --- | --- | --- | --- | --- | --- |');
  for (const [key, cell] of byHour) {
    if (cell.n < MIN_N) continue;
    const s = summarise(cell);
    const [series, hour] = key.split('|');
    out(
      `| ${series} | ${String(hour).padStart(2, '0')}:00 | ${s.n} | ${fmt(s.meanMid, 3)} | ${fmt(s.realized, 3)} | ` +
      `${s.gap >= 0 ? '+' : ''}${fmt(s.gap, 3)} | ${s.z === null ? '—' : s.z.toFixed(2)} |`
    );
  }
  out();
}

async function staleSettlementScan(seriesList) {
  out('## Stale-settlement scan');
  out();
  out('Kalshi resolves against "the most recently available data" when the source feed publishes nothing. If a feed ever froze across a window, settlement would equal the strike exactly and — because strike_type is greater_or_equal — the contract would mechanically resolve YES. Any row here with a low traded price is free money that was left on the table.');
  out();
  const res = await db.pool.query(
    `SELECT series_ticker,
            count(*) AS n_total,
            count(*) FILTER (WHERE expiration_value ~ '^[0-9.]+$'
                             AND floor_strike IS NOT NULL
                             AND expiration_value::numeric = floor_strike) AS n_exact_tie,
            count(*) FILTER (WHERE expiration_value ~ '^[0-9.]+$'
                             AND floor_strike IS NOT NULL
                             AND expiration_value::numeric = floor_strike
                             AND result = 'yes') AS n_tie_yes
     FROM kalshi_markets
     WHERE series_ticker = ANY($1) AND result IN ('yes','no')
     GROUP BY series_ticker ORDER BY series_ticker`,
    [seriesList]
  );
  out('| series | settled markets | settlement == strike exactly | of those, resolved YES |');
  out('| --- | --- | --- | --- |');
  for (const r of res.rows) {
    out(`| ${r.series_ticker} | ${r.n_total} | ${r.n_exact_tie} | ${r.n_tie_yes} |`);
  }
  out();

  const detail = await db.pool.query(
    `SELECT m.ticker, m.series_ticker, m.close_time, m.floor_strike, m.expiration_value, m.result,
            (SELECT max(c.yes_ask_close) FROM (
               SELECT (raw->'yes_ask'->>'close_dollars')::float8 AS yes_ask_close, period_end
               FROM kalshi_candles_1m WHERE market_ticker = m.ticker
             ) c WHERE c.period_end > m.close_time - interval '5 minutes'
               AND c.period_end <= m.close_time) AS late_ask
     FROM kalshi_markets m
     WHERE m.series_ticker = ANY($1)
       AND m.result IN ('yes','no')
       AND m.expiration_value ~ '^[0-9.]+$'
       AND m.floor_strike IS NOT NULL
       AND m.expiration_value::numeric = m.floor_strike
     ORDER BY m.close_time DESC LIMIT 25`,
    [seriesList]
  );
  if (detail.rows.length) {
    out('Most recent exact ties (late_ask = highest YES ask in the final 5 minutes; a low value on a YES resolution is a missed free trade):');
    out();
    out('| ticker | close | strike | settle | result | late YES ask |');
    out('| --- | --- | --- | --- | --- | --- |');
    for (const r of detail.rows) {
      out(`| ${r.ticker} | ${new Date(r.close_time).toISOString()} | ${r.floor_strike} | ${r.expiration_value} | ${r.result} | ${r.late_ask === null ? '—' : fmt(r.late_ask, 3)} |`);
    }
    out();
  } else {
    out('_No exact strike/settlement ties found in the backfilled window._');
    out();
  }
}

// ---------- main ----------

async function main() {
  const seriesArg = process.argv[2];
  const seriesList = seriesArg ? seriesArg.split(',').map((s) => s.trim()).filter(Boolean) : config.kalshi.series;

  const bySeries = new Map();
  const reversal = new Map();
  const byHour = new Map();
  let used = 0;
  let skippedNoQuote = 0;
  let skippedCrossed = 0;
  let totalRows = 0;

  // Chunked accumulation: the full candle join is tens of millions of rows
  // once the KXBTC hourly universe is backfilled — far past Node's heap.
  // Per-series windows of a few days keep memory flat; the cell sums are
  // incremental so the statistics are identical.
  const CHUNK_DAYS = 3;
  const nowMs = Date.now();
  const horizonMs = nowMs - config.backfillDays * 86400000;
  for (const seriesTicker of seriesList) {
    for (let t0 = horizonMs; t0 < nowMs; t0 += CHUNK_DAYS * 86400000) {
      const res = await db.pool.query(
        `SELECT m.series_ticker,
            m.ticker,
            extract(epoch FROM (m.close_time - c.period_end)) AS secs_left,
            extract(hour FROM c.period_end AT TIME ZONE 'UTC') AS hour_utc,
            (c.raw->'yes_bid'->>'close_dollars')::float8 AS bid,
            (c.raw->'yes_ask'->>'close_dollars')::float8 AS ask,
            c.volume::float8 AS volume,
            CASE WHEN m.result = 'yes' THEN 1 ELSE 0 END AS y
     FROM kalshi_candles_1m c
     JOIN kalshi_markets m ON m.ticker = c.market_ticker
     WHERE m.series_ticker = $1
       AND m.close_time >= $2 AND m.close_time < $3
       AND m.result IN ('yes','no')
       AND c.period_end > m.open_time
       AND c.period_end <= m.close_time`,
        [seriesTicker, new Date(t0), new Date(t0 + CHUNK_DAYS * 86400000)]
      );
      totalRows += res.rows.length;

  for (const r of res.rows) {
    const secs = Number(r.secs_left);
    if (!(secs > 0)) continue;
    const bid = r.bid;
    const ask = r.ask;
    if (bid === null || ask === null) {
      skippedNoQuote += 1;
      continue;
    }
    // Require a sane two-sided market: a real bid, a real ask, ask above bid.
    if (!(ask > bid) || !(ask > 0) || !(ask < 1) || !(bid >= 0) || !(bid < 1)) {
      skippedCrossed += 1;
      continue;
    }
    const mid = (bid + ask) / 2;
    const mins = secs / 60;
    const y = Number(r.y);
    const series = r.series_ticker;

    if (!bySeries.has(series)) {
      bySeries.set(series, PRICE_BUCKETS.map(() => TAU_BUCKETS.map(() => newCell())));
    }
    const pi = bucketIndex(PRICE_BUCKETS, mid);
    const ti = bucketIndex(TAU_BUCKETS, mins);
    if (pi >= 0 && ti >= 0) {
      addObs(bySeries.get(series)[pi][ti], mid, ask, bid, y);
      used += 1;
    }

    if (mid <= 0.15 && mins >= 2 && mins <= 5) {
      if (!reversal.has(series)) reversal.set(series, newCell());
      addObs(reversal.get(series), mid, ask, bid, y);
    }

    const hourKey = `${series}|${Number(r.hour_utc)}`;
    if (!byHour.has(hourKey)) byHour.set(hourKey, newCell());
    addObs(byHour.get(hourKey), mid, ask, bid, y);
  }
    }
  }

  if (totalRows === 0) {
    log.error(`no candle rows found for series ${seriesList.join(',')}. Run src/backfill/backfill-kalshi.js first.`);
    process.exit(1);
  }

  let nCells = 0;
  for (const cells of bySeries.values()) {
    for (const row of cells) for (const c of row) if (c.n >= MIN_N) nCells += 1;
  }
  // Bonferroni-adjusted two-sided critical value for alpha = 0.05 across nCells.
  const critZ = bonferroniZ(nCells);

  out('# Calibration report — are quoted prices honest?');
  out();
  out(`Generated ${new Date().toISOString()}. Series: ${seriesList.join(', ')}.`);
  out(`Observations used: ${used} (skipped ${skippedNoQuote} with a missing quote, ${skippedCrossed} with a crossed or degenerate book).`);
  out();
  out('Each row asks one question: of all the moments when the market quoted roughly X, how often did the contract actually resolve YES? "Gap" is realized minus quoted — positive means the market was too cheap. EV columns apply Kalshi\'s exact taker fee, computed per 100 contracts and amortised per contract.');
  out();

  out('## Calibration grid');
  out();
  for (const [series, cells] of bySeries) calibrationTable(series, cells, critZ);

  reversalPanel(reversal);
  hourPanel(byHour);
  await staleSettlementScan(seriesList);

  out('## How to read this');
  out();
  out(`- **Multiple comparisons.** ${nCells} cells were tested. At the conventional |z| > 1.96 threshold roughly ${(nCells * 0.05).toFixed(1)} cells would look "significant" by pure chance, which is why the adjusted threshold |z| > ${critZ.toFixed(2)} is used and marked with **.`);
  out('- **Independence is violated.** Consecutive candles within one market share the same outcome, so effective sample size is smaller than n and the z-scores are optimistic. Treat them as a ranking device, not a p-value. A proper test would cluster standard errors by market; the reversal panel is the cleanest cell because it draws at most a few observations per market.');
  out('- **Survivorship and selection.** Only settled markets with a two-sided quote appear. Windows that never developed a real market are excluded, which biases toward the liquid regime — the opposite of the thin-market regime under investigation.');
  out('- **This test cannot see sub-minute dislocations.** It uses 1-minute candle closes. A negative result here kills the coarse thesis, not the second-scale one, which needs the live order-book collectors.');
  out('- **A flat result is a real result.** If quoted prices match realized frequencies, these markets are efficient at this granularity and the correct decision is to stop, not to search harder for a pattern.');
  out();

  const dir = path.join(__dirname, '..', '..', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `calibration-${new Date().toISOString().slice(0, 10)}.md`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  console.log(lines.join('\n'));
  log.info(`report written to ${file}`);
  await db.pool.end();
}

// Inverse standard-normal CDF (Acklam's rational approximation, |err| < 1.2e-9).
// Used for the Bonferroni-adjusted critical value; a cruder erf-inverse
// approximation is not accurate enough that far into the tail.
function normInv(p) {
  if (!(p > 0) || !(p < 1)) return NaN;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
             1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
             6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
             -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
             3.754408661907416e+00];
  const pLow = 0.02425;
  let q;
  let x;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
        ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - pLow) {
    q = p - 0.5;
    const r = q * q;
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
        (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
        ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  return x;
}

// Two-sided critical value for family-wise alpha across nTests comparisons.
function bonferroniZ(nTests, alpha = 0.05) {
  const n = Math.max(1, nTests);
  return normInv(1 - alpha / (2 * n));
}

// Standard normal CDF via Numerical Recipes' Chebyshev erfc (frac err < 1.2e-7).
function erfc(x) {
  const z = Math.abs(x);
  const t = 2 / (2 + z);
  const ty = 4 * t - 2;
  const cof = [-1.3026537197817094, 6.4196979235649026e-1, 1.9476473204185836e-2,
    -9.561514786808631e-3, -9.46595344482036e-4, 3.66839497852761e-4, 4.2523324806907e-5,
    -2.0278578112534e-5, -1.624290004647e-6, 1.303655835580e-6, 1.5626441722e-8,
    -8.5238095915e-8, 6.529054439e-9, 5.059343495e-9, -9.91364156e-10, -2.27365122e-10,
    9.6467911e-11, 2.394038e-12, -6.886027e-12, 8.94487e-13, 3.13092e-13, -1.12708e-13,
    3.81e-16, 7.106e-15];
  let d = 0;
  let dd = 0;
  for (let j = cof.length - 1; j > 0; j--) {
    const tmp = d;
    d = ty * d - dd + cof[j];
    dd = tmp;
  }
  const ans = t * Math.exp(-z * z + 0.5 * (cof[0] + ty * d) - dd);
  return x >= 0 ? ans : 2 - ans;
}

function normalCdf(z) {
  return 0.5 * erfc(-z / Math.SQRT2);
}

module.exports = { feePerContract, bucketIndex, wilson, summarise, addObs, newCell, normInv, bonferroniZ, normalCdf, PRICE_BUCKETS, TAU_BUCKETS };

if (require.main === module) {
  main().catch((err) => {
    log.error('fatal', err);
    process.exit(1);
  });
}
