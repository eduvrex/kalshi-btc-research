'use strict';

// Does the market misprice path states? The decisive follow-up to
// path-analysis.js, prompted by the live board showing martingale, history,
// and the quote disagreeing on one window.
//
// Two artifacts:
//  A. Conditional calibration by path state: at each minute mark, in each
//     time-above bucket, what did the market QUOTE vs what REALIZED?
//  B. An implementable backtest of the disagreement trade: when the
//     empirical similar-windows rate (built on TRAIN days only) differs from
//     the quoted mid by more than a threshold, take the empirical side at the
//     NEXT minute's opening quote with exact taker fees, hold to settlement.
//     Evaluated on TEST days only — the lookup never sees a test window.
//
// Quote-at-mark = the 1-min candle CLOSING exactly at open+m minutes (its
// close state is the book at that instant); fill = the following candle's
// OPEN quote. Strictly look-ahead-free; one trade max per window.
//
// Usage: node src/research/prefix-quote-study.js

const fs = require('fs');
const path = require('path');
const db = require('../lib/db');
const log = require('../lib/log');
const { feePerContract, wilson } = require('./calibration');

const TRAIN_FRAC = 0.6;
const MARKS = [3, 6, 9, 12];
const THRESHOLDS = [0.03, 0.05, 0.08, 0.12];
const MIN_NEIGHBORS = 50;

const lines = [];
function out(s = '') {
  lines.push(s);
}

function fmt(v, d = 3) {
  return v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(d);
}

async function loadRows() {
  const res = await db.pool.query(
    `SELECT p.market_ticker, p.min_mark, p.n_secs, p.secs_above, p.twad::float8 AS twad,
            CASE WHEN p.result = 'yes' THEN 1 ELSE 0 END AS y,
            m.close_time,
            (cs.raw->'yes_bid'->>'close_dollars')::float8 AS bid,
            (cs.raw->'yes_ask'->>'close_dollars')::float8 AS ask,
            (cf.raw->'yes_bid'->>'open_dollars')::float8 AS fill_bid,
            (cf.raw->'yes_ask'->>'open_dollars')::float8 AS fill_ask
     FROM window_path_prefix p
     JOIN kalshi_markets m ON m.ticker = p.market_ticker
     JOIN kalshi_candles_1m cs ON cs.market_ticker = p.market_ticker
       AND cs.period_end = m.close_time - interval '900 seconds' + p.min_mark * interval '60 seconds'
     LEFT JOIN kalshi_candles_1m cf ON cf.market_ticker = p.market_ticker
       AND cf.period_end = m.close_time - interval '900 seconds' + (p.min_mark + 1) * interval '60 seconds'
     WHERE (cs.raw->'yes_ask'->>'close_dollars')::float8 > (cs.raw->'yes_bid'->>'close_dollars')::float8
       AND (cs.raw->'yes_ask'->>'close_dollars')::float8 < 1
       AND (cs.raw->'yes_bid'->>'close_dollars')::float8 >= 0`
  );
  return res.rows.map((r) => ({
    ticker: r.market_ticker,
    mark: r.min_mark,
    f: r.secs_above / r.n_secs,
    w: r.twad,
    y: Number(r.y),
    day: new Date(r.close_time).toISOString().slice(0, 10),
    close_time: r.close_time,
    mid: (r.bid + r.ask) / 2,
    fill_bid: r.fill_bid,
    fill_ask: r.fill_ask
  }));
}

function empiricalLookup(trainByMark, mark, f, w) {
  const band = Math.max(20, Math.abs(w) * 0.6);
  let n = 0;
  let k = 0;
  for (const t of trainByMark[mark]) {
    if (Math.abs(t.f - f) <= 0.12 && Math.abs(t.w - w) <= band) {
      n += 1;
      k += t.y;
    }
  }
  return { n, p: n ? k / n : null };
}

function summarise(trades) {
  const n = trades.length;
  if (!n) return null;
  const pnls = trades.map((t) => t.pnl);
  const mean = pnls.reduce((s, v) => s + v, 0) / n;
  const sd = n > 1 ? Math.sqrt(pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) : 0;
  const meanCost = trades.reduce((s, t) => s + t.cost, 0) / n;
  return {
    n,
    wins: trades.filter((t) => t.won).length,
    meanCost,
    mean,
    total: mean * n,
    tstat: sd > 0 ? (mean / sd) * Math.sqrt(n) : null,
    retOnRisk: mean / meanCost
  };
}

async function main() {
  const rows = await loadRows();
  log.info(`prefix-quote study: ${rows.length} state/quote observations`);
  if (rows.length < 2000) {
    log.error('too few joined rows; is the candle backfill complete for KXBTC15M?');
    process.exit(1);
  }

  out('# Prefix-quote study — does the market misprice path states? (2026-08-28)');
  out();
  out(`Observations: ${rows.length} (window × minute-mark) with a sane two-sided quote at the mark. Quote-at-mark = candle closing at open+m; fill = next candle's open; exact taker fees; one trade max per window. Path state from path-analysis.js (Kraken 1s, strike-anchored, no look-ahead).`);
  out();

  // ---- A. Conditional calibration by path state ----
  out('## A. What the market quoted vs what realized, by path state');
  out();
  out('One row per (minute mark × time-above bucket): mean quoted mid at that moment vs realized YES frequency. Gap = realized − quoted; positive means YES was quoted too cheap in that state.');
  out();
  out('| mark | time above | n | mean quoted mid | realized | gap | z |');
  out('| --- | --- | --- | --- | --- | --- | --- |');
  const FB_EDGES = [0, 0.2, 0.4, 0.6, 0.8, 1.0001];
  const FB_LBL = ['0–20%', '20–40%', '40–60%', '60–80%', '80–100%'];
  for (const mark of MARKS) {
    for (let b = 0; b < 5; b++) {
      const cell = rows.filter((r) => r.mark === mark && r.f >= FB_EDGES[b] && r.f < FB_EDGES[b + 1]);
      if (cell.length < 100) continue;
      const n = cell.length;
      const realized = cell.reduce((s, r) => s + r.y, 0) / n;
      const quoted = cell.reduce((s, r) => s + r.mid, 0) / n;
      const se = Math.sqrt(quoted * (1 - quoted) / n);
      const gap = realized - quoted;
      out(`| ${mark} | ${FB_LBL[b]} | ${n} | ${fmt(quoted)} | ${fmt(realized)} | ${gap >= 0 ? '+' : ''}${fmt(gap)} | ${fmt(gap / se, 2)} |`);
    }
  }
  out();

  // ---- B. Train/test disagreement backtest ----
  const days = [...new Set(rows.map((r) => r.day))].sort();
  const cutDay = days[Math.floor(days.length * TRAIN_FRAC)];
  const train = rows.filter((r) => r.day < cutDay);
  const test = rows.filter((r) => r.day >= cutDay);
  const trainByMark = {};
  for (const m of MARKS) trainByMark[m] = train.filter((r) => r.mark === m);

  out('## B. The disagreement trade, out of sample');
  out();
  out(`Lookup built on train days only (${days[0]}..${cutDay}, ${train.length} obs); trades evaluated on test days (${cutDay}..${days[days.length - 1]}, ${test.length} obs). Rule: at the first mark where |empirical − quoted mid| > threshold (and the lookup has ≥ ${MIN_NEIGHBORS} neighbours), take the empirical side at the next minute's opening quote + fee, hold to settlement.`);
  out();
  out('| threshold | trades | buy-YES / buy-NO | win rate | mean cost | EV/contract | total PnL | t-stat | return on risk |');
  out('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');

  const testByTicker = new Map();
  for (const r of test) {
    if (!testByTicker.has(r.ticker)) testByTicker.set(r.ticker, []);
    testByTicker.get(r.ticker).push(r);
  }
  for (const arr of testByTicker.values()) arr.sort((a, b) => a.mark - b.mark);

  for (const th of THRESHOLDS) {
    const trades = [];
    for (const arr of testByTicker.values()) {
      for (const r of arr) {
        const emp = empiricalLookup(trainByMark, r.mark, r.f, r.w);
        if (emp.n < MIN_NEIGHBORS || emp.p === null) continue;
        const gap = emp.p - r.mid;
        if (Math.abs(gap) <= th) continue;
        if (gap > 0) {
          if (r.fill_ask === null || !(r.fill_ask > 0 && r.fill_ask < 1)) break;
          const cost = r.fill_ask + feePerContract(r.fill_ask);
          trades.push({ side: 'yes', cost, won: r.y === 1, pnl: r.y ? 1 - cost : -cost });
        } else {
          if (r.fill_bid === null || !(r.fill_bid >= 0 && r.fill_bid < 1)) break;
          const px = 1 - r.fill_bid;
          const cost = px + feePerContract(px);
          trades.push({ side: 'no', cost, won: r.y === 0, pnl: r.y ? -cost : 1 - cost });
        }
        break; // one trade max per window
      }
    }
    const s = summarise(trades);
    if (!s) {
      out(`| ${th.toFixed(2)} | 0 | — | — | — | — | — | — | — |`);
      continue;
    }
    const nYes = trades.filter((t) => t.side === 'yes').length;
    out(
      `| ${th.toFixed(2)} | ${s.n} | ${nYes} / ${s.n - nYes} | ${(s.wins / s.n * 100).toFixed(1)}% | $${fmt(s.meanCost)} | ` +
      `${s.mean >= 0 ? '+' : ''}$${fmt(s.mean, 4)} | ${s.total >= 0 ? '+' : ''}$${fmt(s.total, 2)} | ${fmt(s.tstat, 2)} | ${(s.retOnRisk * 100).toFixed(1)}% |`
    );
  }
  out();
  out('## How to read this');
  out();
  out('- Section A is the direct answer: a |z| well past ~3.6 (Bonferroni for 20 cells) in some state row means the market misquotes that path shape; small z everywhere means path information is already in the price.');
  out('- Section B is the only number that can justify believing a live gap chip: the empirical-vs-market disagreement traded at real next-minute fills, out of sample. Negative EV here means the disagreement is the lookup being wrong, not the market.');
  out('- Same candle-granularity caveats as always: fills assume next-minute opening quotes were accessible; depth unknown pre-book-capture; z treats windows as independent (marks within a window are not — one trade per window keeps section B honest).');
  out();

  const dir = path.join(__dirname, '..', '..', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `prefix-quote-study-${new Date().toISOString().slice(0, 10)}.md`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  console.log(lines.join('\n'));
  log.info(`report written to ${file}`);
  await db.pool.end();
}

main().catch((err) => {
  log.error('fatal', err);
  process.exit(1);
});
