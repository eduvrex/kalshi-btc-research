'use strict';

const { Pool } = require('pg');
const config = require('./config');
const log = require('./log');

const pool = new Pool(config.pg);

pool.on('error', (err) => {
  log.error('pg pool error', err.message);
});

const PARTITIONED_TABLES = [
  { table: 'kalshi_book_snapshots', column: 'ts' },
  { table: 'kalshi_book_deltas', column: 'received_at' },
  { table: 'index_ticks', column: 'ts' },
  { table: 'spot_ticks', column: 'ts_venue' }
];

function dayStr(d) {
  return d.toISOString().slice(0, 10);
}

async function ensurePartitions(daysBack, daysAhead) {
  const client = await pool.connect();
  try {
    for (const { table } of PARTITIONED_TABLES) {
      for (let i = -daysBack; i <= daysAhead; i++) {
        const day = new Date(Date.now() + i * 86400000);
        const from = dayStr(day);
        const to = dayStr(new Date(day.getTime() + 86400000));
        const name = `${table}_${from.replace(/-/g, '')}`;
        await client.query(
          `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF ${table}
           FOR VALUES FROM ('${from}') TO ('${to}')`
        );
      }
    }
  } finally {
    client.release();
  }
}

// Multi-row insert: rows is an array of arrays matching columns order.
// Chunked: the PG wire protocol caps bind parameters at 65535 per statement
// (the count is a uint16 and silently wraps past that — hit live 2026-08-27).
async function batchInsert(table, columns, rows, conflictClause) {
  if (rows.length === 0) return 0;
  const rowsPerChunk = Math.max(1, Math.floor(60000 / columns.length));
  let count = 0;
  for (let start = 0; start < rows.length; start += rowsPerChunk) {
    const chunk = rows.slice(start, start + rowsPerChunk);
    const params = [];
    const tuples = chunk.map((row, r) => {
      const ph = row.map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      return `(${ph.join(',')})`;
    });
    const sql = `INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')} ${conflictClause || ''}`;
    const res = await pool.query(sql, params);
    count += res.rowCount;
  }
  return count;
}

async function heartbeat(collector, detail) {
  await pool.query(
    'INSERT INTO collector_heartbeats (collector, detail) VALUES ($1, $2)',
    [collector, detail ? JSON.stringify(detail) : null]
  );
}

// The live /markets response stopped including series_ticker (observed
// 2026-08-27); derive it from the event_ticker/ticker prefix when absent.
function seriesTickerOf(m) {
  if (m.series_ticker) return m.series_ticker;
  const src = m.event_ticker || m.ticker || '';
  const i = src.indexOf('-');
  return i > 0 ? src.slice(0, i) : src || null;
}

async function upsertMarket(m) {
  await pool.query(
    `INSERT INTO kalshi_markets
       (ticker, series_ticker, event_ticker, market_type, strike_type,
        floor_strike, cap_strike, open_time, close_time,
        expected_expiration_time, expiration_value, result, status, raw, last_updated)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
     ON CONFLICT (ticker) DO UPDATE SET
       expiration_value = EXCLUDED.expiration_value,
       result = EXCLUDED.result,
       status = EXCLUDED.status,
       floor_strike = EXCLUDED.floor_strike,
       cap_strike = EXCLUDED.cap_strike,
       close_time = EXCLUDED.close_time,
       expected_expiration_time = EXCLUDED.expected_expiration_time,
       raw = EXCLUDED.raw,
       last_updated = now()`,
    [
      m.ticker,
      seriesTickerOf(m),
      m.event_ticker || null,
      m.market_type || null,
      m.strike_type || null,
      m.floor_strike == null ? null : m.floor_strike,
      m.cap_strike == null ? null : m.cap_strike,
      m.open_time || null,
      m.close_time || null,
      m.expected_expiration_time || null,
      m.expiration_value === '' ? null : m.expiration_value || null,
      m.result === '' ? null : m.result || null,
      m.status || null,
      JSON.stringify(m)
    ]
  );
}

module.exports = { pool, ensurePartitions, batchInsert, heartbeat, upsertMarket };
