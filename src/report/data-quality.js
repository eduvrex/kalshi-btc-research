'use strict';

// Data-quality report: feed coverage, gaps, inter-feed latency, clock sync,
// and BRTI-proxy calibration against settled-market ground truth.
// Usage: node src/report/data-quality.js [hours]   (default: last 24h)

const fs = require('fs');
const path = require('path');
const db = require('../lib/db');
const log = require('../lib/log');

const hours = Number(process.argv[2] || 24);
if (!(hours > 0)) {
  log.error('usage: node src/report/data-quality.js [hours>0]');
  process.exit(1);
}

const lines = [];
function out(s = '') {
  lines.push(s);
}

async function q(sql, params) {
  const res = await db.pool.query(sql, params);
  return res.rows;
}

function fmt(v) {
  if (v === null || v === undefined) return '—';
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function table(rows, cols) {
  if (!rows.length) {
    out('_no data_');
    out();
    return;
  }
  out(`| ${cols.join(' | ')} |`);
  out(`| ${cols.map(() => '---').join(' | ')} |`);
  for (const r of rows) out(`| ${cols.map((c) => fmt(r[c])).join(' | ')} |`);
  out();
}

async function coverage(since) {
  out('## Feed coverage');
  out();
  const rows = await q(
    `SELECT 'kalshi_book_snapshots' AS feed, count(*) AS rows, min(ts) AS first, max(ts) AS last
       FROM kalshi_book_snapshots WHERE ts >= $1
     UNION ALL
     SELECT 'kalshi_book_deltas', count(*), min(received_at), max(received_at)
       FROM kalshi_book_deltas WHERE received_at >= $1
     UNION ALL
     SELECT 'kalshi_trades(ws)', count(*), min(received_at), max(received_at)
       FROM kalshi_trades WHERE source = 'ws' AND received_at >= $1
     UNION ALL
     SELECT 'spot_ticks', count(*), min(ts_venue), max(ts_venue)
       FROM spot_ticks WHERE ts_venue >= $1`,
    [since]
  );
  const idx = await q(
    `SELECT 'index:' || source AS feed, count(*) AS rows, min(ts) AS first, max(ts) AS last
     FROM index_ticks WHERE ts >= $1 GROUP BY source ORDER BY source`,
    [since]
  );
  table(rows.concat(idx), ['feed', 'rows', 'first', 'last']);
}

async function gaps(since) {
  out('## Gaps (1 Hz index feeds, interval > 5s)');
  out();
  for (const source of ['proxy_composite', 'coinbase_mid', 'kraken_mid', 'bitstamp_mid', 'gemini_mid', 'pm_binance', 'pm_chainlink']) {
    const rows = await q(
      `WITH t AS (
         SELECT ts, ts - lag(ts) OVER (ORDER BY ts) AS gap
         FROM index_ticks WHERE source = $1 AND ts >= $2
       )
       SELECT count(*) FILTER (WHERE gap > interval '5 seconds') AS n_gaps,
              max(gap) AS worst,
              sum(extract(epoch FROM gap)) FILTER (WHERE gap > interval '5 seconds') AS seconds_missing
       FROM t`,
      [source, since]
    );
    const r = rows[0] || {};
    out(`- **${source}**: ${fmt(r.n_gaps)} gaps > 5s, worst ${fmt(r.worst)}, ~${fmt(r.seconds_missing)}s missing`);
  }
  out();
  out('## Collector heartbeat gaps (> 30s)');
  out();
  const hb = await q(
    `WITH t AS (
       SELECT collector, ts, ts - lag(ts) OVER (PARTITION BY collector ORDER BY ts) AS gap
       FROM collector_heartbeats WHERE ts >= $1
     )
     SELECT collector, count(*) FILTER (WHERE gap > interval '30 seconds') AS n_gaps, max(gap) AS worst
     FROM t GROUP BY collector ORDER BY collector`,
    [since]
  );
  table(hb, ['collector', 'n_gaps', 'worst']);
}

async function latency(since) {
  out('## Inter-feed latency (venue timestamp -> local receive, ms)');
  out();
  const defs = [
    ['kalshi book deltas', `SELECT extract(epoch FROM (received_at - ts_venue)) * 1000 AS ms
       FROM kalshi_book_deltas WHERE received_at >= $1 AND ts_venue IS NOT NULL`],
    ['kalshi trades (ws)', `SELECT extract(epoch FROM (received_at - ts_venue)) * 1000 AS ms
       FROM kalshi_trades WHERE source = 'ws' AND received_at >= $1 AND ts_venue IS NOT NULL`],
    ['coinbase spot', `SELECT extract(epoch FROM (received_at - ts_venue)) * 1000 AS ms
       FROM spot_ticks WHERE exchange = 'coinbase' AND received_at >= $1`],
    ['pm_binance', `SELECT extract(epoch FROM (received_at - ts)) * 1000 AS ms
       FROM index_ticks WHERE source = 'pm_binance' AND received_at >= $1`],
    ['pm_chainlink', `SELECT extract(epoch FROM (received_at - ts)) * 1000 AS ms
       FROM index_ticks WHERE source = 'pm_chainlink' AND received_at >= $1`]
  ];
  const rows = [];
  for (const [name, sub] of defs) {
    const r = await q(
      `SELECT count(*) AS n,
              percentile_cont(0.5)  WITHIN GROUP (ORDER BY ms) AS p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY ms) AS p95,
              percentile_cont(0.99) WITHIN GROUP (ORDER BY ms) AS p99
       FROM (${sub}) s`,
      [since]
    );
    const row = r[0] || {};
    rows.push({
      feed: name,
      n: row.n,
      p50: row.p50 == null ? null : Number(row.p50).toFixed(0),
      p95: row.p95 == null ? null : Number(row.p95).toFixed(0),
      p99: row.p99 == null ? null : Number(row.p99).toFixed(0)
    });
  }
  table(rows, ['feed', 'n', 'p50', 'p95', 'p99']);
  out('Caveat: these mix true network latency with venue-side timestamping and any local clock error; see clock sync below.');
  out();
}

async function clock(since) {
  out('## Clock sync (local vs Coinbase time endpoint)');
  out();
  const rows = await q(
    `SELECT count(*) AS n,
            round(avg(offset_ms), 1) AS avg_offset_ms,
            round(min(offset_ms), 1) AS min_offset_ms,
            round(max(offset_ms), 1) AS max_offset_ms,
            round(avg(rtt_ms), 1) AS avg_rtt_ms
     FROM clock_sync WHERE source = 'coinbase_time' AND ts >= $1`,
    [since]
  );
  table(rows, ['n', 'avg_offset_ms', 'min_offset_ms', 'max_offset_ms', 'avg_rtt_ms']);
  out('Run chrony or ntpd on the host; this measurement is a cross-check, not a substitute.');
  out();
}

async function proxyCalibration(since) {
  out('## BRTI proxy calibration vs settled markets');
  out();
  out('Settlement = 60s average of BRTI before close_time (rounded to 2dp).');
  out('Comparison below: our proxy_composite averaged over [close_time - 60s, close_time) vs official expiration_value, for KXBTC15M markets settled during the capture window. BTC15M only: the proxy tracks BTC (commodity settlements are a different index entirely), and the 15-min series has exactly one market per settlement instant, so no settlement is pseudo-replicated across strikes.');
  out();
  const rows = await q(
    `SELECT m.ticker,
            m.close_time,
            m.expiration_value::numeric AS official,
            round(avg(i.price), 2) AS proxy_avg,
            count(i.price) AS n_ticks,
            round(avg(i.price) - m.expiration_value::numeric, 2) AS residual
     FROM kalshi_markets m
     JOIN index_ticks i
       ON i.source = 'proxy_composite'
      AND i.ts >= m.close_time - interval '60 seconds'
      AND i.ts <  m.close_time
     WHERE m.series_ticker = 'KXBTC15M'
       AND m.expiration_value ~ '^[0-9.]+$'
       AND m.close_time >= $1
     GROUP BY m.ticker, m.close_time, m.expiration_value
     ORDER BY m.close_time DESC
     LIMIT 50`,
    [since]
  );
  table(rows, ['ticker', 'close_time', 'official', 'proxy_avg', 'n_ticks', 'residual']);
  if (rows.length) {
    const resid = await q(
      `SELECT count(*) AS n,
              round(avg(abs(r)), 2) AS mean_abs_residual,
              round(percentile_cont(0.95) WITHIN GROUP (ORDER BY abs(r))::numeric, 2) AS p95_abs_residual
       FROM (
         SELECT avg(i.price) - m.expiration_value::numeric AS r
         FROM kalshi_markets m
         JOIN index_ticks i
           ON i.source = 'proxy_composite'
          AND i.ts >= m.close_time - interval '60 seconds'
          AND i.ts <  m.close_time
         WHERE m.series_ticker = 'KXBTC15M'
           AND m.expiration_value ~ '^[0-9.]+$'
           AND m.close_time >= $1
         GROUP BY m.ticker, m.close_time, m.expiration_value
       ) s`,
      [since]
    );
    table(resid, ['n', 'mean_abs_residual', 'p95_abs_residual']);
  }
}

async function snapshotActivity(since) {
  out('## Kalshi book snapshot activity by market (top 20 by rows)');
  out();
  const rows = await q(
    `SELECT market_ticker, count(*) AS rows,
            count(*) FILTER (WHERE forced) AS forced_rows,
            min(ts) AS first, max(ts) AS last
     FROM kalshi_book_snapshots WHERE ts >= $1
     GROUP BY market_ticker ORDER BY count(*) DESC LIMIT 20`,
    [since]
  );
  table(rows, ['market_ticker', 'rows', 'forced_rows', 'first', 'last']);
  out('Snapshots are change-driven: a quiet second writes no row; a forced row every 30s proves liveness.');
  out();
}

async function main() {
  const since = new Date(Date.now() - hours * 3600000);
  out(`# Data quality report`);
  out();
  out(`Window: last ${hours}h (since ${since.toISOString()}), generated ${new Date().toISOString()}`);
  out();
  await coverage(since);
  await snapshotActivity(since);
  await gaps(since);
  await latency(since);
  await clock(since);
  await proxyCalibration(since);

  const dir = path.join(__dirname, '..', '..', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `dq-${new Date().toISOString().slice(0, 10)}.md`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  console.log(lines.join('\n'));
  log.info(`report written to ${file}`);
  await db.pool.end();
}

main().catch((err) => {
  log.error('fatal', err);
  process.exit(1);
});
