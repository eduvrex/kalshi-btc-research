'use strict';

// Downloads historical BTC-USD trades from Coinbase and Kraken public REST
// APIs (both BRTI constituent exchanges) and aggregates them into 1-second
// bars in spot_bars_1s. Free, no API keys. Resumable via spot_dl_state.
//
// Usage:
//   node src/backfill/download-spot-history.js            (both exchanges)
//   node src/backfill/download-spot-history.js coinbase
//   node src/backfill/download-spot-history.js kraken
//
// Coinbase walks backwards from now using trade-id pagination.
// Kraken walks forward from the cutoff using its `since` nanosecond cursor.

const config = require('../lib/config');
const log = require('../lib/log');
const db = require('../lib/db');

const CUTOFF_MS = Date.now() - config.backfillDays * 86400000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url, headers, maxRetries = 8) {
  let attempt = 0;
  for (;;) {
    let res;
    try {
      res = await fetch(url, { headers });
    } catch (err) {
      if (attempt >= maxRetries) throw err;
      attempt += 1;
      await sleep(Math.min(60000, 1000 * 2 ** attempt));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= maxRetries) throw new Error(`HTTP ${res.status} for ${url}`);
      attempt += 1;
      await sleep(Math.min(60000, 1000 * 2 ** attempt));
      continue;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status} for ${url}: ${body.slice(0, 200)}`);
    }
    return { json: await res.json(), headers: res.headers };
  }
}

// ---------- bar accumulation ----------

function makeBarMap() {
  return new Map(); // epochSec -> bar
}

function addTrade(bars, tsMs, price, size, seqKey) {
  const sec = Math.floor(tsMs / 1000);
  let bar = bars.get(sec);
  if (!bar) {
    bar = { open: price, high: price, low: price, close: price, pv: price * size, v: size, n: 1, firstKey: seqKey, lastKey: seqKey };
    bars.set(sec, bar);
    return;
  }
  if (price > bar.high) bar.high = price;
  if (price < bar.low) bar.low = price;
  bar.pv += price * size;
  bar.v += size;
  bar.n += 1;
  if (seqKey >= bar.lastKey) {
    bar.close = price;
    bar.lastKey = seqKey;
  }
  if (seqKey < bar.firstKey) {
    bar.open = price;
    bar.firstKey = seqKey;
  }
}

async function flushBars(exchange, bars, secs) {
  if (secs.length === 0) return 0;
  const rows = secs.map((sec) => {
    const b = bars.get(sec);
    return [
      exchange,
      new Date(sec * 1000),
      b.open,
      b.high,
      b.low,
      b.close,
      b.v > 0 ? b.pv / b.v : b.close,
      b.v,
      b.n
    ];
  });
  for (const sec of secs) bars.delete(sec);
  // Replace on conflict: a bar is only ever flushed once its second has been
  // observed in full (cursors are second-aligned below), so the incoming row
  // supersedes any stale partial bar left by an interrupted earlier run.
  return db.batchInsert(
    'spot_bars_1s',
    ['exchange', 'ts', 'open', 'high', 'low', 'close', 'vwap', 'volume', 'n_trades'],
    rows,
    `ON CONFLICT (exchange, ts) DO UPDATE SET
       open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
       close = EXCLUDED.close, vwap = EXCLUDED.vwap,
       volume = EXCLUDED.volume, n_trades = EXCLUDED.n_trades`
  );
}

async function saveState(exchange, cursor, oldestTs, newestTs) {
  await db.pool.query(
    `INSERT INTO spot_dl_state (exchange, cursor, oldest_ts, newest_ts, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (exchange) DO UPDATE SET
       cursor = EXCLUDED.cursor,
       oldest_ts = LEAST(coalesce(spot_dl_state.oldest_ts, EXCLUDED.oldest_ts), EXCLUDED.oldest_ts),
       newest_ts = GREATEST(coalesce(spot_dl_state.newest_ts, EXCLUDED.newest_ts), EXCLUDED.newest_ts),
       updated_at = now()`,
    [exchange, cursor, oldestTs ? new Date(oldestTs) : null, newestTs ? new Date(newestTs) : null]
  );
}

async function loadState(exchange) {
  const res = await db.pool.query('SELECT * FROM spot_dl_state WHERE exchange = $1', [exchange]);
  return res.rows[0] || null;
}

// ---------- coinbase: backwards via trade-id pagination ----------

async function downloadCoinbase() {
  const state = await loadState('coinbase');
  const backfillDone = Boolean(state && state.oldest_ts && new Date(state.oldest_ts).getTime() <= CUTOFF_MS);
  // Top-up mode: the backwards backfill reached the cutoff on an earlier run.
  // Coinbase pagination only walks backwards, so extending coverage forward to
  // now is a short backwards walk that stops at previously covered ground —
  // overlapping one second so the old run's in-progress boundary second is
  // rebuilt in full (flushBars replaces it).
  const stopMs = backfillDone
    ? (state.newest_ts ? new Date(state.newest_ts).getTime() : CUTOFF_MS) - 1000
    : CUTOFF_MS;
  const skipSec = backfillDone ? Math.floor(stopMs / 1000) : null;
  let after = backfillDone ? null : state && state.cursor ? state.cursor : null;
  const bars = makeBarMap();
  let pages = 0;
  let oldestMs = !backfillDone && state && state.oldest_ts ? new Date(state.oldest_ts).getTime() : Date.now();
  let newestMs = !backfillDone && state && state.newest_ts ? new Date(state.newest_ts).getTime() : 0;
  for (;;) {
    const url = 'https://api.exchange.coinbase.com/products/BTC-USD/trades?limit=1000' + (after ? `&after=${after}` : '');
    const { json: trades, headers } = await fetchJson(url, { 'User-Agent': 'btc-research/0.1' });
    if (!Array.isArray(trades) || trades.length === 0) break;
    let pageMinMs = Infinity;
    for (const t of trades) {
      const ms = new Date(t.time).getTime();
      if (ms < pageMinMs) pageMinMs = ms;
      if (ms > newestMs) newestMs = ms;
      if (ms < CUTOFF_MS) continue;
      // Top-up: whole seconds at or below the stop boundary are already
      // complete in the DB; a partial recompute must not replace them.
      if (skipSec !== null && Math.floor(ms / 1000) <= skipSec) continue;
      addTrade(bars, ms, Number(t.price), Number(t.size), Number(t.trade_id));
    }
    if (pageMinMs < oldestMs) oldestMs = pageMinMs;
    const completeSecs = [...bars.keys()].filter((s) => s * 1000 > pageMinMs);
    await flushBars('coinbase', bars, completeSecs);
    after = headers.get('cb-after') || String(trades[trades.length - 1].trade_id);
    pages += 1;
    if (pages % 50 === 0) {
      // Checkpoint a cursor aligned to the oldest unflushed second, so a
      // crash-resume refetches that second in full instead of rebuilding it
      // from only its older half (bar keys are trade ids; after=N returns
      // ids strictly below N).
      const pending = [...bars.keys()];
      const alignedAfter = pending.length
        ? String(bars.get(Math.min(...pending)).lastKey + 1)
        : after;
      await saveState('coinbase', backfillDone ? state.cursor : alignedAfter, oldestMs, newestMs);
      log.info(`coinbase: ${pages} pages, oldest ${new Date(oldestMs).toISOString()}`);
    }
    if (pageMinMs <= stopMs) break;
    await sleep(120);
  }
  await flushBars('coinbase', bars, [...bars.keys()]);
  await saveState(
    'coinbase',
    backfillDone ? state.cursor : after,
    Math.max(oldestMs, CUTOFF_MS),
    newestMs
  );
  log.info(`coinbase: ${backfillDone ? 'top-up' : 'backfill'} done, ${pages} pages, newest ${newestMs ? new Date(newestMs).toISOString() : 'n/a'}`);
}

// ---------- kraken: forward via since-cursor ----------

async function downloadKraken() {
  const state = await loadState('kraken');
  let since = state && state.cursor ? state.cursor : String(CUTOFF_MS * 1e6);
  const bars = makeBarMap();
  let pages = 0;
  let newestMs = 0;
  for (;;) {
    const url = `https://api.kraken.com/0/public/Trades?pair=XXBTZUSD&since=${since}`;
    const { json } = await fetchJson(url, {});
    if (json.error && json.error.length) {
      if (String(json.error[0]).includes('Too many')) {
        await sleep(5000);
        continue;
      }
      throw new Error(`kraken error: ${json.error.join(',')}`);
    }
    const result = json.result || {};
    const pairKey = Object.keys(result).find((k) => k !== 'last');
    const trades = pairKey ? result[pairKey] : [];
    if (!trades || trades.length === 0) break;
    let pageMaxMs = 0;
    for (const t of trades) {
      const ms = Number(t[2]) * 1000;
      if (ms > pageMaxMs) pageMaxMs = ms;
      addTrade(bars, ms, Number(t[0]), Number(t[1]), ms);
    }
    if (pageMaxMs > newestMs) newestMs = pageMaxMs;
    const completeSecs = [...bars.keys()].filter((s) => (s + 1) * 1000 <= pageMaxMs);
    await flushBars('kraken', bars, completeSecs);
    since = result.last;
    pages += 1;
    if (pages % 50 === 0) {
      // Checkpoint a cursor aligned to the start of the oldest unflushed
      // second (ns, exclusive) — a crash-resume then refetches that second in
      // full instead of rebuilding it from only the trades after result.last.
      await saveState('kraken', alignedSince(bars, since), CUTOFF_MS, newestMs);
      log.info(`kraken: ${pages} pages, reached ${new Date(newestMs).toISOString()}`);
    }
    if (newestMs > Date.now() - 60000) break;
    await sleep(1100);
  }
  // The still-in-progress boundary second is deliberately NOT flushed; the
  // aligned cursor makes the next run refetch it in full (flushBars replaces).
  const finalSince = alignedSince(bars, since);
  await saveState('kraken', finalSince, CUTOFF_MS, newestMs);
  log.info(`kraken: done, ${pages} pages, reached ${new Date(newestMs).toISOString()}`);
}

// Kraken since-cursor for the start of the oldest unflushed second, exclusive
// of nothing in that second. BigInt: epochSec * 1e9 exceeds 2^53.
function alignedSince(bars, fallback) {
  const pending = [...bars.keys()];
  if (!pending.length) return fallback;
  return String(BigInt(Math.min(...pending)) * 1000000000n - 1n);
}

// ---------- main ----------

async function main() {
  const which = (process.argv[2] || 'both').toLowerCase();
  if (!['both', 'coinbase', 'kraken'].includes(which)) {
    log.error('usage: node src/backfill/download-spot-history.js [coinbase|kraken|both]');
    process.exit(1);
  }
  if (which === 'both' || which === 'coinbase') await downloadCoinbase();
  if (which === 'both' || which === 'kraken') await downloadKraken();
  await db.pool.end();
}

main().catch((err) => {
  log.error('fatal', err);
  process.exit(1);
});
