'use strict';

// Backfills what Kalshi's API exposes historically for the configured series:
// market metadata incl. settlement values, public trades, and 1-minute candles.
// Order book depth has no historical source; depth capture starts with the
// live collector. Resumable: progress tracked in backfill_progress.

const config = require('../lib/config');
const log = require('../lib/log');
const db = require('../lib/db');
const rest = require('../lib/kalshi-rest');

function dollars(obj, dollarsKey, centsKey) {
  if (obj == null) return null;
  if (obj[dollarsKey] != null) return Number(obj[dollarsKey]);
  if (obj[centsKey] != null) return Number(obj[centsKey]) / 100;
  return null;
}

async function backfillMarkets() {
  const minCloseTs = Math.floor(Date.now() / 1000) - config.backfillDays * 86400;
  let total = 0;
  for (const series of config.kalshi.series) {
    for (const status of ['settled', 'closed']) {
      const markets = await rest.getAllPages(
        `/markets?series_ticker=${series}&status=${status}&min_close_ts=${minCloseTs}&limit=1000`,
        'markets',
        { maxPages: 200, throttleMs: 150 }
      );
      for (const m of markets) await db.upsertMarket({ ...m, series_ticker: series });
      total += markets.length;
      log.info(`markets backfill: ${series}/${status} -> ${markets.length}`);
    }
  }
  log.info(`markets backfill complete: ${total} markets upserted`);
}

async function marketVolume(ticker) {
  const res = await db.pool.query('SELECT raw FROM kalshi_markets WHERE ticker = $1', [ticker]);
  if (!res.rows.length) return 0;
  const raw = res.rows[0].raw;
  if (raw.volume_fp != null) return Number(raw.volume_fp);
  if (raw.volume != null) return Number(raw.volume);
  return 0;
}

async function backfillTrades(ticker) {
  const trades = await rest.getAllPages(
    `/markets/trades?ticker=${encodeURIComponent(ticker)}&limit=1000`,
    'trades',
    { maxPages: 100, throttleMs: 150 }
  );
  const rows = trades.map((t) => [
    t.trade_id,
    t.ticker || ticker,
    dollars(t, 'yes_price_dollars', 'yes_price'),
    dollars(t, 'no_price_dollars', 'no_price'),
    t.count_fp != null ? Number(t.count_fp) : t.count != null ? Number(t.count) : null,
    t.taker_side || null,
    t.created_time ? new Date(t.created_time) : null,
    null,
    'backfill',
    JSON.stringify(t)
  ]);
  await db.batchInsert(
    'kalshi_trades',
    ['trade_id', 'market_ticker', 'yes_price', 'no_price', 'count', 'taker_side', 'ts_venue', 'received_at', 'source', 'raw'],
    rows,
    'ON CONFLICT (trade_id) DO NOTHING'
  );
  return rows.length;
}

async function backfillCandles(seriesTicker, market) {
  const open = market.open_time ? Math.floor(new Date(market.open_time).getTime() / 1000) : null;
  const close = market.close_time ? Math.floor(new Date(market.close_time).getTime() / 1000) : null;
  if (!open || !close) return 0;
  const path = `/series/${seriesTicker}/markets/${encodeURIComponent(market.ticker)}/candlesticks` +
    `?start_ts=${open - 60}&end_ts=${close + 60}&period_interval=1`;
  let data;
  try {
    data = await rest.get(path);
  } catch (err) {
    // null = fetch failed (do NOT mark done); 0 = market genuinely candle-less.
    log.warn(`candles failed for ${market.ticker}: ${err.message}`);
    return null;
  }
  const candles = data.candlesticks || [];
  const rows = candles.map((c) => {
    const p = c.price || {};
    return [
      market.ticker,
      new Date(Number(c.end_period_ts) * 1000),
      dollars(p, 'open_dollars', 'open'),
      dollars(p, 'high_dollars', 'high'),
      dollars(p, 'low_dollars', 'low'),
      dollars(p, 'close_dollars', 'close'),
      c.volume_fp != null ? Number(c.volume_fp) : c.volume != null ? Number(c.volume) : null,
      c.open_interest_fp != null ? Number(c.open_interest_fp) : c.open_interest != null ? Number(c.open_interest) : null,
      JSON.stringify(c)
    ];
  });
  await db.batchInsert(
    'kalshi_candles_1m',
    ['market_ticker', 'period_end', 'yes_open', 'yes_high', 'yes_low', 'yes_close', 'volume', 'open_interest', 'raw'],
    rows,
    'ON CONFLICT (market_ticker, period_end) DO NOTHING'
  );
  return rows.length;
}

async function main() {
  // Usage: node backfill-kalshi.js [both|candles|trades] [--skip-markets]
  // Candles + settlements alone feed the decisive calibration report; trades
  // are ~10x the request volume and feed nothing in the current research
  // pipeline, so a candles-first pass gets calibration hours earlier.
  const args = process.argv.slice(2);
  const mode = ['both', 'candles', 'trades'].includes((args[0] || '').toLowerCase())
    ? args[0].toLowerCase()
    : 'both';
  const doTrades = mode !== 'candles';
  const doCandles = mode !== 'trades';

  await db.ensurePartitions(1, 2);
  if (!args.includes('--skip-markets')) await backfillMarkets();

  const needClause = mode === 'both'
    ? '(p.market_ticker IS NULL OR p.trades_done = false OR p.candles_done = false)'
    : mode === 'candles'
      ? '(p.market_ticker IS NULL OR p.candles_done = false)'
      : '(p.market_ticker IS NULL OR p.trades_done = false)';
  const res = await db.pool.query(
    `SELECT m.ticker, m.series_ticker, m.open_time, m.close_time,
            coalesce(p.trades_done, false) AS trades_done,
            coalesce(p.candles_done, false) AS candles_done
     FROM kalshi_markets m
     LEFT JOIN backfill_progress p ON p.market_ticker = m.ticker
     WHERE m.close_time > now() - ($1 || ' days')::interval
       AND m.close_time < now()
       AND ${needClause}
     -- 15-min series first: they carry the decisive calibration test; the huge
     -- KXBTC hourly universe (200k markets, page-capped) grinds afterwards.
     ORDER BY (m.series_ticker = 'KXBTC'), m.close_time DESC`,
    [String(config.backfillDays)]
  );
  log.info(`backfill mode=${mode}: ${res.rows.length} markets pending`);

  let done = 0;
  let tradeCount = 0;
  let candleCount = 0;
  let consecFails = 0;
  for (const m of res.rows) {
    let gotTrades = false;
    let gotCandles = false;
    if (doTrades && !m.trades_done) {
      const vol = await marketVolume(m.ticker);
      tradeCount += vol > 0 ? await backfillTrades(m.ticker) : 0;
      gotTrades = true;
    }
    if (doCandles && !m.candles_done) {
      const n = await backfillCandles(m.series_ticker, m);
      if (n === null) {
        // Fetch failed: leave the market unmarked for a later pass, and back
        // off hard when failures streak — that is a network outage, not data.
        consecFails += 1;
        if (consecFails >= 20) {
          log.warn(`${consecFails} consecutive candle failures — Kalshi unreachable? sleeping 60s`);
          await rest.sleep(60000);
        }
      } else {
        consecFails = 0;
        candleCount += n;
        gotCandles = true;
      }
    }
    await db.pool.query(
      `INSERT INTO backfill_progress (market_ticker, trades_done, candles_done)
       VALUES ($1, $2, $3)
       ON CONFLICT (market_ticker) DO UPDATE SET
         trades_done = backfill_progress.trades_done OR EXCLUDED.trades_done,
         candles_done = backfill_progress.candles_done OR EXCLUDED.candles_done,
         updated_at = now()`,
      [m.ticker, gotTrades, gotCandles]
    );
    done += 1;
    // Pace candle-only markets: one bare request per market otherwise runs
    // straight into per-IP 429s and doubles traffic on retries.
    if (gotTrades || gotCandles) await rest.sleep(100);
    if (done % 100 === 0) {
      log.info(`progress (${mode}): ${done}/${res.rows.length} markets, ${tradeCount} trades, ${candleCount} candles`);
    }
  }
  log.info(`backfill ${mode} complete: ${done} markets, ${tradeCount} trades, ${candleCount} candles`);
  await db.pool.end();
}

main().catch((err) => {
  log.error('fatal', err);
  process.exit(1);
});
