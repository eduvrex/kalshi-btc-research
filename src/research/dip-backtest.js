'use strict';

// Look-ahead-free backtest of the calibration addendum's surviving finding:
// markets whose quoted mid DIPS to <= 15c with 2-5 minutes left resolve YES
// more often than the quote implies (BTC15M: 6.7% realized vs 4.8% quoted,
// z=+4.7 clustered). This tests whether the gap survives real fills.
//
// Rule, one trade max per market:
//   - signal: first 1-min candle whose CLOSE state has a sane two-sided book,
//     mid <= DIP_MID, and 2..5 minutes to market close;
//   - fill: buy YES at the NEXT candle's opening ask (never the signal candle),
//     exact taker fee; hold to settlement.
// A frictionless twin (fill at signal mid, no fee) separates edge from cost.
//
// Uses only Kalshi candles + settled results -- no spot data required.
//
// Usage: node src/research/dip-backtest.js [series,series,...]

const fs = require('fs');
const path = require('path');
const config = require('../lib/config');
const db = require('../lib/db');
const log = require('../lib/log');
const { feePerContract, wilson } = require('./calibration');

const DIP_MID = 0.15;
const MIN_LEFT = 2;
const MAX_LEFT = 5;

const lines = [];
function out(s = '') {
  lines.push(s);
}

function fmt(v, d = 4) {
  return v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(d);
}

function summariseTrades(trades) {
  const n = trades.length;
  if (!n) return null;
  const pnls = trades.map((t) => t.pnl);
  const mean = pnls.reduce((s, v) => s + v, 0) / n;
  const sd = n > 1 ? Math.sqrt(pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) : 0;
  const wins = trades.filter((t) => t.y === 1).length;
  const meanCost = trades.reduce((s, t) => s + t.cost, 0) / n;
  const [lo, hi] = wilson(wins, n);
  return {
    n,
    winRate: wins / n,
    ciLo: lo,
    ciHi: hi,
    meanCost,
    mean,
    total: mean * n,
    tstat: sd > 0 ? (mean / sd) * Math.sqrt(n) : null,
    retOnRisk: mean / meanCost
  };
}

function tradeLine(label, s) {
  if (!s) return `| ${label} | 0 | — | — | — | — | — | — | — |`;
  return (
    `| ${label} | ${s.n} | ${fmt(s.meanCost, 3)} | ${(s.winRate * 100).toFixed(1)}% | ` +
    `${fmt(s.ciLo, 3)}–${fmt(s.ciHi, 3)} | ${s.mean >= 0 ? '+' : ''}$${fmt(s.mean)} | ` +
    `${s.total >= 0 ? '+' : ''}$${fmt(s.total, 2)} | ${s.tstat === null ? '—' : s.tstat.toFixed(2)} | ` +
    `${(s.retOnRisk * 100).toFixed(1)}% |`
  );
}

async function runSeries(seriesTicker) {
  const res = await db.pool.query(
    `SELECT c.market_ticker,
            extract(epoch FROM (m.close_time - c.period_end)) / 60 AS mins_left,
            (c.raw->'yes_bid'->>'close_dollars')::float8 AS bid_close,
            (c.raw->'yes_ask'->>'close_dollars')::float8 AS ask_close,
            (c.raw->'yes_ask'->>'open_dollars')::float8 AS ask_open,
            extract(epoch FROM c.period_end) AS pe,
            CASE WHEN m.result = 'yes' THEN 1 ELSE 0 END AS y
     FROM kalshi_candles_1m c
     JOIN kalshi_markets m ON m.ticker = c.market_ticker
     WHERE m.series_ticker = $1
       AND m.result IN ('yes','no')
       AND c.period_end > m.open_time
       AND c.period_end <= m.close_time
     ORDER BY c.market_ticker, c.period_end`,
    [seriesTicker]
  );

  const filled = [];
  const frictionless = [];
  let signals = 0;
  let unfillable = 0;
  let slippageSum = 0;

  let curMarket = null;
  let rows = [];
  const processMarket = () => {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const mins = Number(r.mins_left);
      if (mins < MIN_LEFT || mins > MAX_LEFT) continue;
      const bid = r.bid_close;
      const ask = r.ask_close;
      if (bid === null || ask === null) continue;
      if (!(ask > bid) || !(ask > 0) || !(ask < 1) || !(bid >= 0)) continue;
      const mid = (bid + ask) / 2;
      if (mid > DIP_MID) continue;
      // Signal at candle close i; one trade per market, then stop.
      signals += 1;
      frictionless.push({ y: r.y, cost: mid, pnl: r.y ? 1 - mid : -mid });
      const next = rows[i + 1];
      const nextIsAdjacent = next && Number(next.pe) - Number(r.pe) === 60;
      const fillAsk = nextIsAdjacent ? next.ask_open : null;
      if (fillAsk === null || !(fillAsk > 0) || !(fillAsk < 1)) {
        unfillable += 1;
      } else {
        const fee = feePerContract(fillAsk);
        const cost = fillAsk + fee;
        filled.push({ y: r.y, cost, pnl: r.y ? 1 - cost : -cost });
        slippageSum += fillAsk - mid;
      }
      return;
    }
  };
  for (const r of res.rows) {
    if (r.market_ticker !== curMarket) {
      if (curMarket !== null) processMarket();
      curMarket = r.market_ticker;
      rows = [];
    }
    rows.push(r);
  }
  if (curMarket !== null) processMarket();

  return { signals, unfillable, filled, frictionless, slippageSum };
}

async function main() {
  const seriesArg = process.argv[2];
  const seriesList = seriesArg
    ? seriesArg.split(',').map((s) => s.trim()).filter(Boolean)
    : config.kalshi.series.filter((s) => s !== 'KXBTC');

  out('# Dip backtest — buy YES at the next-minute ask after a ≤15¢ dip (2–5 min left)');
  out();
  out(`Generated ${new Date().toISOString()}. One trade max per market; fill at the NEXT candle's opening ask + exact taker fee; hold to settlement. "Frictionless" fills at the signal mid with no fee — the difference is what spread+fees eat.`);
  out();
  out('| series / variant | trades | mean cost | win rate | 95% CI | EV/contract | total PnL | t-stat | return on risk |');
  out('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');

  for (const s of seriesList) {
    const r = await runSeries(s);
    const f = summariseTrades(r.filled);
    const fl = summariseTrades(r.frictionless);
    out(tradeLine(`${s} — filled`, f));
    out(tradeLine(`${s} — frictionless`, fl));
    const avgSlip = r.filled.length ? r.slippageSum / r.filled.length : null;
    out(`| ${s} — notes | signals ${r.signals}, unfillable ${r.unfillable} | avg slip vs mid ${avgSlip === null ? '—' : '$' + fmt(avgSlip)} | | | | | | |`);
  }
  out();
  out('## How to read this');
  out();
  out('- The clustered calibration gap (+1.9 pts on BTC15M) is the ceiling; fills at the ask plus the per-order fee must clear it for the edge to be real.');
  out('- "Unfillable" = no adjacent next candle or degenerate next-open ask — those signals are dropped from the filled variant but kept in frictionless; a large gap between the two trade counts is itself evidence the dip state is fleeting.');
  out('- One trade per market keeps units independent; the t-stat is honest at market granularity but adjacent 15-min windows still share volatility regimes.');
  out('- Candle opens are the first trade/quote state of the minute, not a guaranteed resting quote; live fills could be worse. Depth is unknown until the order-book collector runs.');
  out();

  const dir = path.join(__dirname, '..', '..', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `dip-backtest-${new Date().toISOString().slice(0, 10)}.md`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  console.log(lines.join('\n'));
  log.info(`report written to ${file}`);
  await db.pool.end();
}

main().catch((err) => {
  log.error('fatal', err);
  process.exit(1);
});
