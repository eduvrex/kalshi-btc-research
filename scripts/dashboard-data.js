'use strict';

// Emits the JSON snapshot behind the visual HQ dashboard: inventory, coverage,
// backfill progress, live rates. Rerun any time; output goes to stdout.

const db = require('../src/lib/db');

async function q(sql, params) {
  return (await db.pool.query(sql, params)).rows;
}

async function main() {
  const out = { generated_at: new Date().toISOString() };

  out.markets = await q(`
    SELECT series_ticker, count(*)::int AS total,
           count(*) FILTER (WHERE result IN ('yes','no'))::int AS settled,
           min(close_time) AS first_close, max(close_time) AS last_close
    FROM kalshi_markets GROUP BY 1 ORDER BY 1`);

  out.candles = (await q(`
    SELECT count(*)::bigint AS n, min(period_end) AS first, max(period_end) AS last
    FROM kalshi_candles_1m`))[0];

  out.trades = await q(`
    SELECT source, count(*)::bigint AS n, min(ts_venue) AS first, max(ts_venue) AS last
    FROM kalshi_trades GROUP BY 1`);

  out.books = (await q(`
    SELECT (SELECT count(*) FROM kalshi_book_snapshots)::bigint AS snapshots,
           (SELECT count(*) FROM kalshi_book_deltas)::bigint AS deltas,
           (SELECT min(ts) FROM kalshi_book_snapshots) AS first_snap,
           (SELECT count(DISTINCT market_ticker) FROM kalshi_book_snapshots) AS markets`))[0];

  out.index_sources = await q(`
    SELECT source, count(*)::bigint AS n, min(ts) AS first, max(ts) AS last
    FROM index_ticks GROUP BY 1 ORDER BY 1`);

  out.continuity = await q(`
    SELECT date_trunc('hour', ts) AS hour, count(*)::int AS n
    FROM index_ticks
    WHERE source = 'proxy_composite' AND ts > now() - interval '48 hours'
    GROUP BY 1 ORDER BY 1`);

  out.book_hours = await q(`
    SELECT date_trunc('hour', ts) AS hour, count(*)::int AS n
    FROM kalshi_book_snapshots GROUP BY 1 ORDER BY 1`);

  out.backfill = (await q(`
    SELECT
      (SELECT count(*) FROM kalshi_markets m JOIN backfill_progress p ON p.market_ticker=m.ticker
        WHERE m.series_ticker != 'KXBTC' AND p.candles_done)::int AS m15_candles_done,
      (SELECT count(*) FROM kalshi_markets WHERE series_ticker != 'KXBTC'
        AND close_time < now() AND close_time > now() - interval '90 days')::int AS m15_total,
      (SELECT count(*) FROM kalshi_markets m JOIN backfill_progress p ON p.market_ticker=m.ticker
        WHERE m.series_ticker = 'KXBTC' AND p.candles_done)::int AS btc_candles_done,
      (SELECT count(*) FROM kalshi_markets m JOIN backfill_progress p ON p.market_ticker=m.ticker
        WHERE p.trades_done)::int AS trades_done,
      (SELECT count(*) FROM kalshi_markets WHERE series_ticker='KXBTC'
        AND close_time < now() AND close_time > now() - interval '90 days')::int AS btc_total`))[0];

  out.spot = await q(`SELECT exchange, cursor IS NOT NULL AS has_cursor, oldest_ts, newest_ts FROM spot_dl_state`);
  out.spot_bars = await q(`
    SELECT exchange, count(*)::bigint AS n, min(ts) AS first, max(ts) AS last
    FROM spot_bars_1s GROUP BY 1`);

  out.events = (await q(`
    SELECT count(*)::int AS n, coalesce(max(max_gap), 0)::float8 AS max_gap,
           min(started_at) AS first, max(started_at) AS last
    FROM dislocation_events`))[0];
  out.recent_events = await q(`
    SELECT market_ticker, side, round(max_gap::numeric,3)::float8 AS max_gap,
           round(fair_at_max::numeric,3)::float8 AS fair, round(mid_at_max::numeric,3)::float8 AS mid,
           duration_s, started_at
    FROM dislocation_events ORDER BY started_at DESC LIMIT 8`);

  out.heartbeats = await q(`
    SELECT DISTINCT ON (collector) collector, ts, detail
    FROM collector_heartbeats ORDER BY collector, ts DESC`);

  out.rates = (await q(`
    SELECT
      (SELECT count(*) FROM kalshi_book_deltas WHERE received_at > now() - interval '10 minutes')::int AS deltas_10m,
      (SELECT count(*) FROM index_ticks WHERE ts > now() - interval '10 minutes')::int AS idx_10m,
      (SELECT count(*) FROM kalshi_trades WHERE source='ws' AND received_at > now() - interval '10 minutes')::int AS trades_10m`))[0];

  out.db_size = (await q(`SELECT pg_size_pretty(pg_database_size(current_database())) AS size,
    pg_database_size(current_database())::bigint AS bytes`))[0];

  console.log(JSON.stringify(out));
  await db.pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
