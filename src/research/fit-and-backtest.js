'use strict';

// Fits a calibrated fair-value model on model_rows and runs a coarse,
// look-ahead-free backtest against Kalshi quotes with real fee math.
//
// Model: P(up) = sigmoid(a + b*z), z = normalized spot distance to strike.
// Split: first TRAIN_FRAC of calendar days = train, remainder = test.
// Fills: positions decided at minute t fill at minute t+1's OPENING quotes
//        (next_yes_ask_open / next_yes_bid_open) -- never same-minute data.
// Fees:  ceil-to-cent(0.07 * 100 * p * (1-p)) per 100 contracts (taker).
// Output: reports/backtest-v0-YYYY-MM-DD.md
//
// Usage: node src/research/fit-and-backtest.js

const fs = require('fs');
const path = require('path');
const db = require('../lib/db');
const log = require('../lib/log');

const TRAIN_FRAC = 0.7;
const THRESHOLDS = [0.0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.075, 0.1];

const lines = [];
function out(s = '') {
  lines.push(s);
}

function sigmoid(v) {
  return 1 / (1 + Math.exp(-v));
}

// Kalshi's taker fee is ceil-to-cent PER ORDER, so the per-contract cost
// depends on order size: a literal 1-lot pays the $0.01 minimum, which at tail
// prices is 1.6-14x the amortised figure. ORDER_SIZE makes the assumption
// explicit; every PnL label below is per contract at this order size.
// See test/math.test.js: the epsilon is required because 7*0.10*0.90*100
// evaluates to 63.00000000000001, which a naive ceil turns into $0.64.
const ORDER_SIZE = 100;

function feePerContract(p) {
  if (!(p > 0) || !(p < 1)) return 0;
  const feeDollars = Math.ceil(7 * p * (1 - p) * ORDER_SIZE - 1e-9) / 100;
  return feeDollars / ORDER_SIZE;
}

function fitLogistic(rows) {
  let a = 0;
  let b = 1;
  const n = rows.length;
  const lr = 0.5;
  for (let epoch = 0; epoch < 2000; epoch++) {
    let ga = 0;
    let gb = 0;
    for (const r of rows) {
      const e = sigmoid(a + b * r.z) - r.y;
      ga += e;
      gb += e * r.z;
    }
    a -= (lr * ga) / n;
    b -= (lr * gb) / n;
  }
  return { a, b };
}

function logLoss(rows, probOf) {
  let s = 0;
  let n = 0;
  for (const r of rows) {
    const p = Math.min(1 - 1e-6, Math.max(1e-6, probOf(r)));
    s += r.y ? -Math.log(p) : -Math.log(1 - p);
    n += 1;
  }
  return n ? s / n : null;
}

function brier(rows, probOf) {
  let s = 0;
  let n = 0;
  for (const r of rows) {
    const p = probOf(r);
    if (p === null) continue;
    s += (p - r.y) ** 2;
    n += 1;
  }
  return n ? s / n : null;
}

function pct(v, d = 4) {
  return v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(d);
}

function maxDrawdown(pnls) {
  let cum = 0;
  let peak = 0;
  let mdd = 0;
  for (const p of pnls) {
    cum += p;
    if (cum > peak) peak = cum;
    if (peak - cum > mdd) mdd = peak - cum;
  }
  return mdd;
}

function backtest(testByMarket, model, threshold) {
  const trades = [];
  for (const rows of testByMarket.values()) {
    for (const r of rows) {
      if (r.next_yes_ask_open === null || r.next_yes_bid_open === null) continue;
      const ask = r.next_yes_ask_open;
      const bid = r.next_yes_bid_open;
      if (!(ask > 0 && ask < 1 && bid >= 0 && bid < 1 && ask > bid)) continue;
      const fair = sigmoid(model.a + model.b * r.z);
      const longEdge = fair - ask - feePerContract(ask);
      const shortEdge = bid - fair - feePerContract(1 - bid);
      if (longEdge > threshold) {
        const fee = feePerContract(ask);
        trades.push({ ticker: r.market_ticker, side: 'yes', px: ask, fee, edge: longEdge, pnl: r.y ? 1 - ask - fee : -ask - fee, ts: r.ts });
        break;
      }
      if (shortEdge > threshold) {
        const fee = feePerContract(1 - bid);
        trades.push({ ticker: r.market_ticker, side: 'no', px: 1 - bid, fee, edge: shortEdge, pnl: r.y ? -(1 - bid) - fee : bid - fee, ts: r.ts });
        break;
      }
    }
  }
  trades.sort((x, y) => x.ts - y.ts);
  const pnls = trades.map((t) => t.pnl);
  const n = pnls.length;
  const mean = n ? pnls.reduce((s, v) => s + v, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) : 0;
  return {
    n,
    hit: n ? pnls.filter((v) => v > 0).length / n : null,
    mean,
    total: mean * n,
    tstat: n > 1 && sd > 0 ? (mean / sd) * Math.sqrt(n) : null,
    mdd: maxDrawdown(pnls),
    fees: trades.reduce((s, t) => s + t.fee, 0)
  };
}

async function manipulationScreen() {
  const res = await db.pool.query(
    `SELECT r_settle, r_after, result, strike::float8 AS strike, settle::float8 AS settle
     FROM settlement_screens
     WHERE r_settle IS NOT NULL AND r_after IS NOT NULL`
  );
  const rows = res.rows.map((r) => ({ rs: Number(r.r_settle), ra: Number(r.r_after), strike: r.strike, settle: r.settle }));
  out('## Manipulation screen: settlement-window push and post-close reversal');
  out();
  out(`Markets with both measurements: ${rows.length}`);
  out();
  if (rows.length < 30) {
    out('_Too few markets to say anything yet._');
    out();
    return;
  }
  const mrs = rows.reduce((s, r) => s + r.rs, 0) / rows.length;
  const mra = rows.reduce((s, r) => s + r.ra, 0) / rows.length;
  let cov = 0;
  let vrs = 0;
  let vra = 0;
  for (const r of rows) {
    cov += (r.rs - mrs) * (r.ra - mra);
    vrs += (r.rs - mrs) ** 2;
    vra += (r.ra - mra) ** 2;
  }
  const corr = cov / Math.sqrt(vrs * vra);
  out(`Correlation(settlement-window move, post-close reversal): **${corr.toFixed(3)}**`);
  out('Systematically negative = pushes into the settlement window tend to revert after close — consistent with (but not proof of) manipulation or transient pressure. Near zero = no signature.');
  out();
  const absRs = rows.map((r) => Math.abs(r.rs)).sort((x, y) => x - y);
  const bigCut = absRs[Math.floor(absRs.length * 0.9)];
  const big = rows.filter((r) => Math.abs(r.rs) >= bigCut);
  const bigRevert = big.filter((r) => r.rs * r.ra < 0).length;
  out(`Top-decile settlement-window moves (|move| >= ${(bigCut * 10000).toFixed(1)} bps): ${big.length}; reversed sign after close: ${bigRevert} (${((bigRevert / big.length) * 100).toFixed(0)}%; 50% = noise).`);
  const decided = rows.filter((r) => r.strike && r.settle && Math.abs(Math.log(r.settle / r.strike)) < Math.abs(r.rs));
  out(`Markets where the settlement-window move exceeded the final settle-vs-strike margin (the push could have decided the outcome): ${decided.length}`);
  out();
}

async function main() {
  const res = await db.pool.query(
    `SELECT market_ticker, extract(epoch FROM ts) AS ts, tau_s, z,
            yes_bid_close, yes_ask_close, price_close,
            next_yes_bid_open, next_yes_ask_open, y
     FROM model_rows
     WHERE z IS NOT NULL AND abs(z) < 50
     ORDER BY ts`
  );
  const rows = res.rows.map((r) => ({
    market_ticker: r.market_ticker,
    ts: Number(r.ts),
    tau_s: Number(r.tau_s),
    z: Number(r.z),
    yes_bid_close: r.yes_bid_close === null ? null : Number(r.yes_bid_close),
    yes_ask_close: r.yes_ask_close === null ? null : Number(r.yes_ask_close),
    price_close: r.price_close === null ? null : Number(r.price_close),
    next_yes_bid_open: r.next_yes_bid_open === null ? null : Number(r.next_yes_bid_open),
    next_yes_ask_open: r.next_yes_ask_open === null ? null : Number(r.next_yes_ask_open),
    y: Number(r.y)
  }));
  if (rows.length < 1000) {
    log.error(`only ${rows.length} model rows; need backfill + spot download + build-dataset first`);
    process.exit(1);
  }

  const days = [...new Set(rows.map((r) => new Date(r.ts * 1000).toISOString().slice(0, 10)))].sort();
  const cutDay = days[Math.floor(days.length * TRAIN_FRAC)];
  const train = rows.filter((r) => new Date(r.ts * 1000).toISOString().slice(0, 10) < cutDay);
  const test = rows.filter((r) => new Date(r.ts * 1000).toISOString().slice(0, 10) >= cutDay);
  if (train.length === 0 || test.length === 0) {
    log.error(`day-based split needs at least 2 distinct days of model rows (have ${days.length}); an empty train set would fit NaN coefficients`);
    process.exit(1);
  }

  out('# Coarse backtest v0 — KXBTC15M fair value vs quotes');
  out();
  out(`Generated ${new Date().toISOString()}. Rows: ${rows.length} (${train.length} train / ${test.length} test), days ${days[0]}..${days[days.length - 1]}, split at ${cutDay}.`);
  out();

  const model = fitLogistic(train);
  out(`## Model`);
  out();
  out(`P(up) = sigmoid(${model.a.toFixed(4)} + ${model.b.toFixed(4)} * z), fit on train only.`);
  out();

  const marketMid = (r) =>
    r.yes_bid_close !== null && r.yes_ask_close !== null && r.yes_ask_close > r.yes_bid_close
      ? (r.yes_bid_close + r.yes_ask_close) / 2
      : null;
  // Model-vs-market comparisons are only meaningful over the SAME rows; the
  // market mid is undefined wherever candle quotes are missing or crossed, so
  // both sides of the comparison are restricted to that common subset.
  const cmp = test.filter((r) => marketMid(r) !== null);
  out('## Calibration (lower is better)');
  out();
  out('| metric | train model | test model | test market mid |');
  out('| --- | --- | --- | --- |');
  out(`| log loss | ${pct(logLoss(train, (r) => sigmoid(model.a + model.b * r.z)))} | ${pct(logLoss(test, (r) => sigmoid(model.a + model.b * r.z)))} | — |`);
  out(`| Brier (quoted rows only) | ${pct(brier(train, (r) => sigmoid(model.a + model.b * r.z)))} | ${pct(brier(cmp, (r) => sigmoid(model.a + model.b * r.z)))} | ${pct(brier(cmp, marketMid))} |`);
  out();
  out(`Model-vs-market Brier compared over the ${cmp.length} of ${test.length} test rows with a usable two-sided quote (train column is full-sample). If the market mid Brier is lower than the model Brier, the market already knows more than this model — expect no edge from it alone.`);
  out();

  const testByMarket = new Map();
  for (const r of test) {
    if (!testByMarket.has(r.market_ticker)) testByMarket.set(r.market_ticker, []);
    testByMarket.get(r.market_ticker).push(r);
  }
  for (const arr of testByMarket.values()) arr.sort((a, b) => a.ts - b.ts);

  out('## Backtest on test period (one trade max per market, hold to settlement, taker fees)');
  out();
  out('| net-edge threshold | trades | hit rate | avg PnL/contract | total PnL (1/trade) | t-stat | max drawdown | fees paid |');
  out('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const th of THRESHOLDS) {
    const b = backtest(testByMarket, model, th);
    out(`| ${th.toFixed(3)} | ${b.n} | ${b.hit === null ? '—' : (b.hit * 100).toFixed(1)}% | $${pct(b.mean)} | $${pct(b.total, 2)} | ${b.tstat === null ? '—' : b.tstat.toFixed(2)} | $${pct(b.mdd, 2)} | $${pct(b.fees, 2)} |`);
  }
  out();
  out(`PnL is per contract assuming ${ORDER_SIZE}-contract taker orders (Kalshi's per-order ceil-to-cent fee amortised over the order). Multiply by intended size mentally only after reading the caveats.`);
  out();

  await manipulationScreen();

  out('## Caveats (read before believing any number above)');
  out();
  out('- Fills assume the next minute\'s opening quote had enough size for the position. We have no historical Kalshi depth — this is unverifiable until the live collector accumulates book data. Thin quotes make these fills optimistic.');
  out('- Decision granularity is 1 minute (candle data). The hypothesis is about second-scale dislocations; this backtest structurally cannot see most of them. A negative here does not kill the second-scale thesis; a positive here is encouraging but inflated by the caveat above.');
  out('- The spot composite (Coinbase+Kraken trades) is a proxy for BRTI inside the window. Strike and settlement values are official BRTI, so outcomes are exact, but intra-window x/z carry proxy noise.');
  out(`- Fees are amortised over ${ORDER_SIZE}-contract orders. A literal 1-lot order pays the $0.01 per-order minimum ceil — at tail prices (the thesis regime) that is 1.6–14× the amortised figure, enough to flip thin edges negative at small size.`);
  out('- Threshold sweep = multiple comparisons. Judge the pattern across thresholds, not the best row.');
  out('- t-stat assumes independent trades; overlapping volatility regimes violate this somewhat.');
  out();

  const dir = path.join(__dirname, '..', '..', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `backtest-v0-${new Date().toISOString().slice(0, 10)}.md`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  console.log(lines.join('\n'));
  log.info(`report written to ${file}`);
  await db.pool.end();
}

main().catch((err) => {
  log.error('fatal', err);
  process.exit(1);
});
