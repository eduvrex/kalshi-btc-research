'use strict';

// Eduardo's cross-crypto lead-lag theory: BTC moves first, alts follow with a
// lag, and alt CONTRACT quotes are sticky — so right after a dramatic BTC
// move, the BTC-direction side of an alt contract should be underpriced.
//
// Coarse (1-min) test, two artifacts:
//  A. Conditional calibration: for alt 15M windows, at each minute mark with a
//     sane two-sided quote, bucket by BTC's move over the PRIOR 2 minutes
//     (from our Kraken 1s BTC bars, forward-filled). If alt quotes are sticky,
//     the big-BTC-up bucket shows realized YES above quoted (and mirror).
//  B. Fill-level backtest: at the FIRST mark where |BTC 2-min move| exceeds a
//     threshold, buy the BTC-direction side of the alt at the NEXT minute's
//     opening quote + exact fee, hold to settlement. One trade per window.
//     BTC15M itself runs as placebo (its quotes tested efficient already).
//
// The seconds-scale version of the theory needs the live alt books + Pyth 1s
// feeds now being captured; this is the decides-if-worth-it coarse pass.
//
// Usage: node src/research/crypto-lag-study.js

const fs = require('fs');
const path = require('path');
const db = require('../lib/db');
const log = require('../lib/log');
const { feePerContract } = require('./calibration');

const ALTS = ['KXETH15M', 'KXSOL15M', 'KXXRP15M', 'KXDOGE15M', 'KXBNB15M', 'KXHYPE15M'];
const PLACEBO = 'KXBTC15M';
const MARKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const LOOKBACK_S = 120;
const FF_CAP_S = 30;
const BPS_EDGES = [-Infinity, -40, -20, -8, 8, 20, 40, Infinity];
const BPS_LBL = ['< −40', '−40..−20', '−20..−8', '−8..8', '8..20', '20..40', '> 40'];
const THRESHOLDS_BPS = [15, 25, 40];

const lines = [];
function out(s = '') {
  lines.push(s);
}

function fmt(v, d = 3) {
  return v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(d);
}

// ---------- BTC 1s reference path (kraken bars, forward-filled) ----------

async function loadBtcDay(dayStartMs) {
  const res = await db.pool.query(
    `SELECT extract(epoch FROM ts)::bigint AS sec, close::float8 AS close
     FROM spot_bars_1s
     WHERE exchange = 'kraken'
       AND ts >= to_timestamp($1) AND ts < to_timestamp($2)`,
    [dayStartMs / 1000 - LOOKBACK_S - 120, dayStartMs / 1000 + 86400 + 120]
  );
  const m = new Map();
  for (const r of res.rows) m.set(Number(r.sec), r.close);
  return m;
}

function btcAt(bars, sec) {
  for (let i = 0; i <= FF_CAP_S; i++) {
    const v = bars.get(sec - i);
    if (v !== undefined) return v;
  }
  return null;
}

// ---------- load observations for one series ----------

async function loadSeries(series) {
  const res = await db.pool.query(
    `SELECT m.ticker, m.close_time, CASE WHEN m.result = 'yes' THEN 1 ELSE 0 END AS y,
            extract(epoch FROM c.period_end) AS mark_sec,
            round(extract(epoch FROM (c.period_end - (m.close_time - interval '900 seconds'))) / 60)::int AS mark,
            (c.raw->'yes_bid'->>'close_dollars')::float8 AS bid,
            (c.raw->'yes_ask'->>'close_dollars')::float8 AS ask,
            (cf.raw->'yes_bid'->>'open_dollars')::float8 AS fill_bid,
            (cf.raw->'yes_ask'->>'open_dollars')::float8 AS fill_ask
     FROM kalshi_markets m
     JOIN kalshi_candles_1m c ON c.market_ticker = m.ticker
       AND c.period_end > m.close_time - interval '840 seconds'
       AND c.period_end <= m.close_time - interval '180 seconds'
     LEFT JOIN kalshi_candles_1m cf ON cf.market_ticker = m.ticker
       AND cf.period_end = c.period_end + interval '60 seconds'
     WHERE m.series_ticker = $1 AND m.result IN ('yes','no')
       AND (c.raw->'yes_ask'->>'close_dollars')::float8 > (c.raw->'yes_bid'->>'close_dollars')::float8
       AND (c.raw->'yes_ask'->>'close_dollars')::float8 < 1
       AND (c.raw->'yes_bid'->>'close_dollars')::float8 >= 0
     ORDER BY m.close_time, c.period_end`,
    [series]
  );
  return res.rows;
}

function bucketOf(bps) {
  for (let i = 0; i < BPS_EDGES.length - 1; i++) {
    if (bps >= BPS_EDGES[i] && bps < BPS_EDGES[i + 1]) return i;
  }
  return -1;
}

async function attachBtcMoves(rows) {
  // Group by UTC day so the BTC bar map stays bounded.
  const byDay = new Map();
  for (const r of rows) {
    const day = new Date(r.close_time).toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(r);
  }
  const out = [];
  for (const [day, dayRows] of byDay) {
    const bars = await loadBtcDay(new Date(`${day}T00:00:00Z`).getTime());
    if (!bars.size) continue;
    for (const r of dayRows) {
      const sec = Number(r.mark_sec);
      const now = btcAt(bars, sec);
      const before = btcAt(bars, sec - LOOKBACK_S);
      if (now === null || before === null) continue;
      r.bps = Math.log(now / before) * 10000;
      out.push(r);
    }
  }
  return out;
}

function summarise(trades) {
  const n = trades.length;
  if (!n) return null;
  const pnls = trades.map((t) => t.pnl);
  const mean = pnls.reduce((s, v) => s + v, 0) / n;
  const sd = n > 1 ? Math.sqrt(pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) : 0;
  const meanCost = trades.reduce((s, t) => s + t.cost, 0) / n;
  return { n, wins: trades.filter((t) => t.won).length, meanCost, mean, total: mean * n, tstat: sd > 0 ? (mean / sd) * Math.sqrt(n) : null, retOnRisk: mean / meanCost };
}

function backtest(rows, thresholdBps) {
  const byTicker = new Map();
  for (const r of rows) {
    if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, []);
    byTicker.get(r.ticker).push(r);
  }
  const trades = [];
  for (const arr of byTicker.values()) {
    arr.sort((a, b) => a.mark - b.mark);
    for (const r of arr) {
      if (Math.abs(r.bps) < thresholdBps) continue;
      if (r.bps > 0) {
        if (r.fill_ask === null || !(r.fill_ask > 0 && r.fill_ask < 1)) break;
        const cost = r.fill_ask + feePerContract(r.fill_ask);
        trades.push({ cost, won: r.y === 1, pnl: r.y ? 1 - cost : -cost });
      } else {
        if (r.fill_bid === null || !(r.fill_bid >= 0 && r.fill_bid < 1)) break;
        const px = 1 - r.fill_bid;
        const cost = px + feePerContract(px);
        trades.push({ cost, won: r.y === 0, pnl: r.y ? -cost : 1 - cost });
      }
      break;
    }
  }
  return summarise(trades);
}

async function main() {
  out('# Cross-crypto lead-lag study — sticky alt quotes after BTC moves? (' + new Date().toISOString().slice(0, 10) + ')');
  out();
  out(`Theory under test: BTC leads, alts follow with a lag, and alt contract quotes are sticky. Conditioning variable: BTC's log move over the prior ${LOOKBACK_S}s from Kraken 1s bars. Quote-at-mark = candle closing at that minute; fill = next candle's open + exact taker fee; one trade per window; marks 2–12 (final 3 minutes excluded). KXBTC15M runs as placebo.`);
  out();

  const perSeries = {};
  for (const s of [PLACEBO, ...ALTS]) {
    const raw = await loadSeries(s);
    perSeries[s] = await attachBtcMoves(raw);
    log.info(`${s}: ${perSeries[s].length} observations`);
  }

  out('## A. Conditional calibration: alt quotes vs outcomes, by BTC prior-2-min move');
  out();
  out('Gap = realized YES − quoted mid. Sticky quotes predict positive gap after BTC up-moves, negative after down-moves. z uses the null SE √(q(1−q)/n); marks within a window are correlated, so treat |z| as a ranking, not a p-value — the pooled row is the headline.');
  out();
  out('| series | BTC move (bps) | n | quoted | realized | gap | z |');
  out('| --- | --- | --- | --- | --- | --- | --- |');
  const pooled = ALTS.flatMap((s) => perSeries[s]);
  const groups = [...ALTS.map((s) => [s, perSeries[s]]), ['ALL ALTS', pooled], [PLACEBO + ' (placebo)', perSeries[PLACEBO]]];
  for (const [name, rows] of groups) {
    for (let b = 0; b < BPS_LBL.length; b++) {
      const cell = rows.filter((r) => bucketOf(r.bps) === b);
      if (cell.length < 150) continue;
      const n = cell.length;
      const realized = cell.reduce((s, r) => s + r.y, 0) / n;
      const quoted = cell.reduce((s, r) => s + (r.bid + r.ask) / 2, 0) / n;
      const se = Math.sqrt(quoted * (1 - quoted) / n);
      const gap = realized - quoted;
      out(`| ${name} | ${BPS_LBL[b]} | ${n} | ${fmt(quoted)} | ${fmt(realized)} | ${gap >= 0 ? '+' : ''}${fmt(gap)} | ${fmt(gap / se, 2)} |`);
    }
  }
  out();

  out('## B. Fill-level backtest: buy the BTC-direction side after a big BTC move');
  out();
  out('| series | threshold (bps) | trades | win rate | mean cost | EV/contract | total PnL | t-stat | return on risk |');
  out('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const [name, rows] of groups) {
    for (const th of THRESHOLDS_BPS) {
      const s = backtest(rows, th);
      if (!s) {
        out(`| ${name} | ${th} | 0 | — | — | — | — | — | — |`);
        continue;
      }
      out(`| ${name} | ${th} | ${s.n} | ${(s.wins / s.n * 100).toFixed(1)}% | $${fmt(s.meanCost)} | ${s.mean >= 0 ? '+' : ''}$${fmt(s.mean, 4)} | ${s.total >= 0 ? '+' : ''}$${fmt(s.total, 2)} | ${fmt(s.tstat, 2)} | ${(s.retOnRisk * 100).toFixed(1)}% |`);
    }
  }
  out();
  out('## Caveats');
  out();
  out('- 1-minute granularity: a lag of seconds is invisible here. A flat result kills the minute-scale version only; the seconds-scale version needs the live alt books + Pyth 1s feeds (capturing since 2026-08-28).');
  out('- Threshold sweep and seven buckets × eight groups = multiple comparisons; judge patterns, not single cells.');
  out('- BTC reference is Kraken spot, not the CF index the alts settle against; 2-min moves are robust to that basis.');
  out('- Alt series are younger than BTC15M — n varies; HYPE/BNB may be thin.');
  out();

  const dir = path.join(__dirname, '..', '..', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `crypto-lag-study-${new Date().toISOString().slice(0, 10)}.md`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  console.log(lines.join('\n'));
  log.info(`report written to ${file}`);
  await db.pool.end();
}

main().catch((err) => {
  log.error('fatal', err);
  process.exit(1);
});
