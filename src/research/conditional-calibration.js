'use strict';

// The targeted test for Eduardo's observation: "the index is above the strike,
// but the whole (1-tick-wide) market sits below 50c."
//
// Question it answers: among minutes where our index proxy said ABOVE the
// strike but the quoted mid said BELOW 50% (and the mirror case), how often did
// the market actually settle YES? Three explanations make three different
// predictions for that number:
//   - display latency / the book knows better  -> realized tracks the QUOTED mid
//   - correct pricing of push-decay (reversion)-> realized BELOW the model fair,
//                                                 concentrated in "fresh spike" rows
//   - stale or lazy quoting (the tradeable one)-> realized tracks the MODEL fair,
//                                                 EV of taking the index side positive
//
// Prerequisites: backfill-kalshi, download-spot-history, build-dataset (this
// reads model_rows, which by construction excludes the final 2 minutes of each
// market -- so partial-settlement-average mechanics cannot contaminate it).
//
// Usage: node src/research/conditional-calibration.js

const fs = require('fs');
const path = require('path');
const db = require('../lib/db');
const log = require('../lib/log');
const C = require('./calibration');

const Z_BUCKETS = [
  [0.00, 0.05], [0.05, 0.15], [0.15, 0.35], [0.35, 0.75], [0.75, 8]
];
const FRESH_DZ = 0.15;
const MIN_N = 30;

const lines = [];
function out(s = '') {
  lines.push(s);
}

function fmt(v, d = 3) {
  return v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(d);
}

function newCell() {
  const c = C.newCell();
  c.sumFair = 0;
  c.markets = new Set();
  return c;
}

function addObs(cell, r) {
  C.addObs(cell, r.mid, r.ask, r.bid, r.y);
  cell.sumFair += C.normalCdf(r.z);
  cell.markets.add(r.market_ticker);
}

function row(cell, label, side) {
  const s = C.summarise(cell);
  const meanFair = cell.sumFair / cell.n;
  const [lo, hi] = C.wilson(cell.k, cell.n);
  const ev = side === 'yes' ? s.evYes : s.evNo;
  return `| ${label} | ${s.n} | ${cell.markets.size} | ${fmt(s.meanMid)} | ${fmt(meanFair)} | ${fmt(s.realized)} | ` +
    `${fmt(lo)}–${fmt(hi)} | ${ev >= 0 ? '+' : ''}$${fmt(ev, 4)} |`;
}

function header() {
  out('| cell | n | markets | quoted mid | model fair Φ(z) | realized YES | 95% CI | EV taking index side |');
  out('| --- | --- | --- | --- | --- | --- | --- | --- |');
}

const SETTLE_AVG_S = 60;

async function main() {
  // The 2-minute lag is computed over the FULL per-market minute grid (inner
  // subquery, before any filtering) — a lag over the filtered set silently
  // stretches "2 rows" into 3+ minutes wherever quotes or spot were missing.
  const res = await db.pool.query(
    `SELECT market_ticker, extract(epoch FROM ts) AS ts, tau_s, z, x, sigma,
            yes_bid_close AS bid, yes_ask_close AS ask, y,
            prev_x, extract(epoch FROM prev_ts) AS prev_ts
     FROM (
       SELECT market_ticker, ts, tau_s, z, x, sigma, yes_bid_close, yes_ask_close, y,
              lag(x, 2)  OVER w AS prev_x,
              lag(ts, 2) OVER w AS prev_ts
       FROM model_rows
       WINDOW w AS (PARTITION BY market_ticker ORDER BY ts)
     ) t
     WHERE z IS NOT NULL AND abs(z) < 50
       AND yes_bid_close IS NOT NULL AND yes_ask_close IS NOT NULL
     ORDER BY market_ticker, ts`
  );

  const rows = [];
  for (const r of res.rows) {
    const bid = Number(r.bid);
    const ask = Number(r.ask);
    if (!(ask > bid) || !(ask > 0) || !(ask < 1) || !(bid >= 0)) continue;
    // Freshness = actual index movement over the prior 2 minutes, normalized
    // at the CURRENT remaining-variance horizon: (x_t - x_{t-120}) / (sigma_t
    // * sqrt(tauEff_t)). The naive z_t - z_{t-2rows} grows mechanically as tau
    // shrinks even with the index frozen, so time decay would masquerade as a
    // "fresh spike". Requires the lagged row to be exactly 120s back.
    const tauEff = Math.max(Number(r.tau_s) - (2 * SETTLE_AVG_S) / 3, 1);
    const aligned = r.prev_ts !== null && Math.abs(Number(r.ts) - Number(r.prev_ts) - 120) < 1e-6;
    const dz2 = aligned && r.prev_x !== null && r.sigma
      ? (Number(r.x) - Number(r.prev_x)) / (Number(r.sigma) * Math.sqrt(tauEff))
      : null;
    rows.push({
      market_ticker: r.market_ticker,
      z: Number(r.z),
      dz2,
      bid,
      ask,
      mid: (bid + ask) / 2,
      y: Number(r.y)
    });
  }
  if (rows.length < 500) {
    log.error(`only ${rows.length} usable model rows; run backfill + spot-history + build-dataset first`);
    process.exit(1);
  }

  out('# Conditional calibration — index says one thing, quotes say another');
  out();
  out(`Generated ${new Date().toISOString()}. Usable rows: ${rows.length}. Final 2 minutes of each market excluded by construction of model_rows.`);
  out();
  out('z = proxy distance above strike in remaining-volatility units. Φ(z) = martingale fair value. "Disagreement" cells are the exact state Eduardo described: z > 0 while the quoted mid is below 0.50 (and the mirror). "EV taking index side" = buy YES at the quoted ask (or NO at 1 − bid) with exact taker fees.');
  out();

  const disagreeYes = Z_BUCKETS.map(() => newCell());
  const disagreeNo = Z_BUCKETS.map(() => newCell());
  const agreeYes = Z_BUCKETS.map(() => newCell());
  const freshCell = newCell();
  const driftCell = newCell();
  let disagreeCount = 0;

  for (const r of rows) {
    const az = Math.abs(r.z);
    const zi = C.bucketIndex(Z_BUCKETS, az);
    if (zi < 0) continue;
    if (r.z > 0 && r.mid < 0.5) {
      addObs(disagreeYes[zi], r);
      disagreeCount += 1;
      if (az >= 0.05 && r.dz2 !== null) {
        addObs(r.dz2 >= FRESH_DZ ? freshCell : driftCell, r);
      }
    } else if (r.z < 0 && r.mid > 0.5) {
      addObs(disagreeNo[zi], r);
      disagreeCount += 1;
    } else if (r.z > 0 && r.mid >= 0.5 && r.mid < 0.6) {
      addObs(agreeYes[zi], r);
    }
  }

  out(`Disagreement states found: **${disagreeCount}** of ${rows.length} rows (${((disagreeCount / rows.length) * 100).toFixed(1)}%). If this number is near zero, the phenomenon is rarer than remembered — that is itself a finding.`);
  out();

  out('## Panel 1 — index above strike, market below 50c (buy-YES candidate)');
  out();
  out('Reading: if "realized" tracks "quoted mid", the book knew better (latency or reversion — no edge buying YES). If "realized" tracks "model fair Φ(z)", the quotes were wrong and EV should be positive.');
  out();
  header();
  for (let i = 0; i < Z_BUCKETS.length; i++) {
    const cell = disagreeYes[i];
    if (cell.n < MIN_N) continue;
    const [zl, zh] = Z_BUCKETS[i];
    const label = i === 0 ? `z ${zl}–${zh} (within proxy noise)` : `z ${zl}–${zh}`;
    out(row(cell, label, 'yes'));
  }
  out();

  out('## Panel 2 — mirror: index below strike, market above 50c (buy-NO candidate)');
  out();
  header();
  for (let i = 0; i < Z_BUCKETS.length; i++) {
    const cell = disagreeNo[i];
    if (cell.n < MIN_N) continue;
    const [zl, zh] = Z_BUCKETS[i];
    out(row(cell, `z −${zh}–−${zl}`, 'no'));
  }
  out();

  out('## Panel 3 — agreement baseline (index above strike, market 50–60c)');
  out();
  out('Sanity check: in the normal state, realized should sit close to both the quoted mid and Φ(z). If it does not, the proxy or the pipeline is broken and Panels 1–2 should not be trusted.');
  out();
  header();
  for (let i = 0; i < Z_BUCKETS.length; i++) {
    const cell = agreeYes[i];
    if (cell.n < MIN_N) continue;
    const [zl, zh] = Z_BUCKETS[i];
    out(row(cell, `z ${zl}–${zh}`, 'yes'));
  }
  out();

  out('## Panel 4 — freshness split inside Panel 1 (isolates the reversion explanation)');
  out();
  out(`"Fresh" = the index moved up by ≥ ${FRESH_DZ} remaining-volatility units over the prior exactly-2 minutes, measured at the current horizon so pure time decay never counts as a spike; "drift" = it did not. If manipulation-decay is what the market is pricing, realized should be markedly lower in the fresh rows than the drift rows.`);
  out();
  header();
  if (freshCell.n >= MIN_N) out(row(freshCell, 'fresh spike into above', 'yes'));
  else out(`| fresh spike into above | ${freshCell.n} | — | _insufficient_ | | | | |`);
  if (driftCell.n >= MIN_N) out(row(driftCell, 'drifted above', 'yes'));
  else out(`| drifted above | ${driftCell.n} | — | _insufficient_ | | | | |`);
  out();

  out('## Caveats');
  out();
  out('- The proxy is Coinbase+Kraken spot, not BRTI itself. The z 0.00–0.05 bucket is labelled "within proxy noise" and should be ignored; check the data-quality report\'s proxy-vs-settlement residuals to know how far up the z scale noise reaches.');
  out('- Historical quotes are 1-minute candle closes. The book state and the index state are aligned only to the minute; a fast dislocation that appeared and vanished within a minute is invisible here. Live collectors close this gap.');
  out('- Rows within one market share an outcome, so n overstates the effective sample; the "markets" column is the honest denominator for significance judgements.');
  out('- One-tick books (Eduardo\'s observation) cannot be confirmed here — candle bid/ask closes may straddle more than the instantaneous spread. The live book collector records the actual spread.');
  out();

  const dir = path.join(__dirname, '..', '..', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `conditional-calibration-${new Date().toISOString().slice(0, 10)}.md`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  console.log(lines.join('\n'));
  log.info(`report written to ${file}`);
  await db.pool.end();
}

main().catch((err) => {
  log.error('fatal', err);
  process.exit(1);
});
