'use strict';

// Autonomous PAPER trading engine v2 (PM2 "paper-engine"). SIMULATED fills
// only — reads market data, writes paper_* tables; no order-placement code
// exists in this repository (project hard rule).
//
// v2: per-strategy virtual books of $100 each (clean science — strategies
// never starve each other), six strategies across BTC + six alts:
//
//   fade      BTC taker: analytic fair Φ(z) vs mid ≥ FADE_GAP for FADE_RUN_S
//   mcfade    BTC taker: same trigger, MONTE CARLO fair (block bootstrap of
//             live empirical 1s returns, exact 60s-average settlement)
//   maker     BTC maker: rest bids MAKER_EDGE behind fair/mid blend, $0 fees,
//             fill only when a captured trade prints STRICTLY THROUGH
//   lag       alts taker: |BTC 2-min move| ≥ LAG_BPS ⇒ buy the BTC-direction
//             side of each alt window at the ask (Eduardo's lead-lag theory)
//   altmaker  alts maker: rest both sides MAKER_EDGE behind mid, trade-through
//   All positions hold to settlement; auto-settled from market results.
//
// Risk per strategy: ≤ min($5, 5% of that book) per entry, ≤ MAX_OPEN open,
// entries stop below $70 book equity or if .paper-stop exists (global).

const fs = require('fs');
const path = require('path');
const log = require('../lib/log');
const db = require('../lib/db');
const { normalCdf } = require('./calibration');
const { mcFair } = require('./mc-fair');

// ---- hypothesis parameters (made-up variables, tune freely) ----
const BOOK0 = 100;
const STAKE_FRAC = 0.05;
const MAX_STAKE = 5;
const MAX_OPEN = 6;
const MAX_DRAWDOWN = 0.30;
const FADE_GAP = 0.05;
const FADE_RUN_S = 3;
const CUTOFF_S = 120;        // no entries / cancel quotes in final 2 min
const MAKER_EDGE = 0.03;
const LAG_BPS = 20;          // BTC 2-min move that arms the lag strategy
const LAG_MAX_MID = 0.80;    // don't chase alts already priced through
const SETTLE_AVG_S = 60;
const SIGMA_WINDOW_S = 1800;

const ALT_SERIES = ['KXETH15M', 'KXSOL15M', 'KXXRP15M', 'KXDOGE15M', 'KXBNB15M', 'KXHYPE15M'];
const ALT_PYTH = {
  KXETH15M: 'pyth_eth', KXSOL15M: 'pyth_sol', KXXRP15M: 'pyth_xrp',
  KXDOGE15M: 'pyth_doge', KXBNB15M: 'pyth_bnb', KXHYPE15M: 'pyth_hype'
};
const STRATEGIES = ['fade', 'mcfade', 'maker', 'lag', 'altmaker', 'altfade', 'altmakerfv'];
const STOP_FILE = path.join(__dirname, '..', '..', '.paper-stop');

const state = {
  streak: { fade: { n: 0, side: null }, mcfade: { n: 0, side: null } },
  altStreak: new Map(),   // ticker -> { n, side } for altfade
  makerQuotes: new Map(), // ticker|strategy -> { yesBid, noBid, lastTradeTs }
  altSigma: new Map(),    // series -> { at, sigma }
  altAnchor: new Map(),   // ticker -> anchor price (official-strike-equivalent)
  lastEquityMin: null,
  mc: null // cached { at, fair } — MC is recomputed at most every 5s
};

async function q(sql, params) {
  return (await db.pool.query(sql, params)).rows;
}

function feePerContract(p) {
  if (!(p > 0) || !(p < 1)) return 0;
  return Math.ceil(7 * p * (1 - p) * 100 - 1e-9) / 100 / 100;
}

async function bookCash(strategy) {
  const r = (await q(
    `SELECT ${BOOK0}
       - coalesce(sum(cost) FILTER (WHERE status = 'open'), 0)
       + coalesce(sum(cost + pnl) FILTER (WHERE status = 'settled'), 0) AS cash
     FROM paper_trades WHERE strategy = $1`,
    [strategy]
  ))[0];
  return Number(r.cash);
}

async function settleResolved() {
  const rows = await q(
    `SELECT t.id, t.side, t.contracts::float8 AS contracts, t.cost::float8 AS cost, m.result
     FROM paper_trades t JOIN kalshi_markets m ON m.ticker = t.market_ticker
     WHERE t.status = 'open' AND m.result IN ('yes','no')`
  );
  for (const r of rows) {
    const pnl = (r.result === r.side ? r.contracts : 0) - r.cost;
    await q(`UPDATE paper_trades SET status='settled', result=$2, pnl=$3, settled_at=now() WHERE id=$1`, [r.id, r.result, pnl]);
    log.info(`settled #${r.id} ${r.side} -> ${r.result}, pnl ${pnl.toFixed(2)}`);
  }
}

async function btcState() {
  const mkt = (await q(
    `SELECT ticker, floor_strike::float8 AS strike, extract(epoch FROM close_time) AS close_sec
     FROM kalshi_markets
     WHERE series_ticker = 'KXBTC15M' AND floor_strike IS NOT NULL
       AND open_time <= now() AND close_time > now() ORDER BY close_time LIMIT 1`
  ))[0];
  if (!mkt) return null;
  const px = (await q(
    `SELECT price::float8 AS price, extract(epoch FROM now() - ts) AS age
     FROM index_ticks WHERE source='proxy_composite' ORDER BY ts DESC LIMIT 1`
  ))[0];
  const book = await latestBook(mkt.ticker);
  if (!px || px.age > 10 || !book) return null;

  const sig = await q(
    `SELECT extract(epoch FROM ts)::bigint AS sec, price::float8 AS price
     FROM index_ticks WHERE source='proxy_composite' AND ts > now() - interval '${SIGMA_WINDOW_S} seconds' ORDER BY ts`
  );
  const returns = [];
  let sumSq = 0, n = 0, prev = null;
  for (const r of sig) {
    if (prev) {
      const dt = Number(r.sec) - Number(prev.sec);
      if (dt > 0 && dt <= 10) {
        const ret = Math.log(r.price / prev.price);
        sumSq += ret * ret / dt;
        n += 1;
        if (dt === 1) returns.push(ret);
      }
    }
    prev = r;
  }
  if (n < SIGMA_WINDOW_S / 4) return null;
  const sigma = Math.sqrt(sumSq / n);
  const nowSec = Date.now() / 1000;
  const secsLeft = mkt.close_sec - nowSec;
  const tauEff = Math.max(secsLeft - (2 * SETTLE_AVG_S) / 3, 1);
  const fair = normalCdf(Math.log(px.price / mkt.strike) / (sigma * Math.sqrt(tauEff)));

  // BTC 2-min move for the lag strategy
  const before = (await q(
    `SELECT price::float8 AS price FROM index_ticks
     WHERE source='proxy_composite' AND ts <= now() - interval '120 seconds'
     ORDER BY ts DESC LIMIT 1`
  ))[0];
  const bps2 = before ? Math.log(px.price / before.price) * 10000 : null;

  return { ...mkt, price: px.price, book, fair, sigma, secsLeft, returns, bps2 };
}

async function latestBook(ticker) {
  const b = (await q(
    `SELECT best_yes_bid::float8 AS bid, best_yes_ask::float8 AS ask, mid::float8 AS mid,
            extract(epoch FROM now() - ts) AS age
     FROM kalshi_book_snapshots
     WHERE market_ticker = $1 AND ts > now() - interval '30 seconds'
     ORDER BY ts DESC LIMIT 1`,
    [ticker]
  ))[0];
  return b && b.age <= 10 && b.mid !== null ? b : null;
}

async function altStates() {
  const mkts = await q(
    `SELECT ticker, series_ticker, extract(epoch FROM close_time) AS close_sec
     FROM kalshi_markets
     WHERE series_ticker = ANY($1) AND floor_strike IS NOT NULL
       AND open_time <= now() AND close_time > now()`,
    [ALT_SERIES]
  );
  const out = [];
  for (const m of mkts) {
    const book = await latestBook(m.ticker);
    if (book) out.push({ ...m, book, secsLeft: m.close_sec - Date.now() / 1000 });
  }
  return out;
}

// Anchored fair value for an alt window from its own Pyth 1s feed. The strike
// IS the official index at open, so with A = the feed's 60s pre-open average,
// predicted-index/strike = P_t/A and the feed-vs-index level basis cancels:
//   z = ln(P_t / A) / (σ √τ_eff),  fair = Φ(z)
async function altFair(a) {
  const src = ALT_PYTH[a.series_ticker];
  if (!src) return null;

  let sig = state.altSigma.get(a.series_ticker);
  if (!sig || Date.now() - sig.at > 30000) {
    const rows = await q(
      `SELECT extract(epoch FROM ts)::bigint AS sec, price::float8 AS price
       FROM index_ticks WHERE source = $1 AND ts > now() - interval '${SIGMA_WINDOW_S} seconds' ORDER BY ts`,
      [src]
    );
    let sumSq = 0, n = 0, prev = null;
    for (const r of rows) {
      if (prev) {
        const dt = Number(r.sec) - Number(prev.sec);
        if (dt > 0 && dt <= 30) { const ret = Math.log(r.price / prev.price); sumSq += ret * ret / dt; n += 1; }
      }
      prev = r;
    }
    sig = { at: Date.now(), sigma: n >= 40 ? Math.sqrt(sumSq / n) : null };
    state.altSigma.set(a.series_ticker, sig);
  }
  if (!sig.sigma) return null;

  let anchor = state.altAnchor.get(a.ticker);
  if (anchor === undefined) {
    const openSec = a.close_sec - 900;
    const r = (await q(
      `SELECT avg(price)::float8 AS a, count(*)::int AS n FROM index_ticks
       WHERE source = $1 AND ts >= to_timestamp($2) - interval '60 seconds' AND ts < to_timestamp($2)`,
      [src, openSec]
    ))[0];
    anchor = r && r.n >= 3 ? r.a : null;
    state.altAnchor.set(a.ticker, anchor);
    if (state.altAnchor.size > 200) state.altAnchor.clear();
  }
  if (anchor === null) return null;

  const px = (await q(
    `SELECT price::float8 AS price, extract(epoch FROM now() - ts) AS age
     FROM index_ticks WHERE source = $1 ORDER BY ts DESC LIMIT 1`,
    [src]
  ))[0];
  if (!px || px.age > 20) return null;

  const tauEff = Math.max(a.secsLeft - (2 * SETTLE_AVG_S) / 3, 1);
  return normalCdf(Math.log(px.price / anchor) / (sig.sigma * Math.sqrt(tauEff)));
}

async function altFadeStrategy(a, fair, openTrades) {
  const gap = fair - a.book.mid;
  const side = gap > 0 ? 'yes' : 'no';
  let st = state.altStreak.get(a.ticker);
  if (!st) { st = { n: 0, side: null }; state.altStreak.set(a.ticker, st); }
  if (Math.abs(gap) >= FADE_GAP && a.secsLeft > CUTOFF_S) {
    st.n = st.side === side ? st.n + 1 : 1;
    st.side = side;
  } else { st.n = 0; st.side = null; return; }
  if (st.n < FADE_RUN_S) return;
  const mine = openTrades.filter((t) => t.strategy === 'altfade');
  if (mine.length >= MAX_OPEN || mine.some((t) => t.market_ticker === a.ticker)) return;
  let ok = false;
  if (side === 'yes' && a.book.ask > 0 && a.book.ask < 1) {
    ok = await enter('altfade', 'taker', a.ticker, 'yes', a.book.ask, feePerContract(a.book.ask), fair, a.book.mid, `gap ${gap.toFixed(3)}`);
  } else if (side === 'no' && a.book.bid >= 0.01) {
    const px = 1 - a.book.bid;
    if (px > 0 && px < 1) ok = await enter('altfade', 'taker', a.ticker, 'no', px, feePerContract(px), fair, a.book.mid, `gap ${gap.toFixed(3)}`);
  }
  if (ok) st.n = 0;
}

function entriesAllowed(equityByStrategy, strategy) {
  if (fs.existsSync(STOP_FILE)) return false;
  return equityByStrategy >= BOOK0 * (1 - MAX_DRAWDOWN);
}

async function enter(strategy, role, ticker, side, price, fee, fair, mid, note) {
  const c = await bookCash(strategy);
  if (!entriesAllowed(c, strategy)) return false;
  const stake = Math.min(MAX_STAKE, STAKE_FRAC * Math.max(c, 0));
  const perContract = price + fee;
  if (perContract <= 0 || stake < perContract) return false;
  const contracts = Math.floor((stake / perContract) * 100) / 100;
  if (contracts <= 0) return false;
  const cost = contracts * perContract;
  if (cost > c) return false;
  await q(
    `INSERT INTO paper_trades (strategy, market_ticker, side, role, price, fee, contracts, cost, fair_at_entry, mid_at_entry, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [strategy, ticker, side, role, price, fee, contracts, cost, fair, mid, note]
  );
  log.info(`ENTER ${strategy} ${side} ${ticker} @ ${price} x${contracts} (${note})`);
  return true;
}

async function takerFade(strategy, fairValue, m, openTrades) {
  const gap = fairValue - m.book.mid;
  const side = gap > 0 ? 'yes' : 'no';
  const st = state.streak[strategy];
  if (Math.abs(gap) >= FADE_GAP && m.secsLeft > CUTOFF_S) {
    st.n = st.side === side ? st.n + 1 : 1;
    st.side = side;
  } else {
    st.n = 0;
    st.side = null;
    return;
  }
  if (st.n < FADE_RUN_S) return;
  const mine = openTrades.filter((t) => t.strategy === strategy);
  if (mine.length >= MAX_OPEN || mine.some((t) => t.market_ticker === m.ticker)) return;
  let ok = false;
  if (side === 'yes' && m.book.ask > 0 && m.book.ask < 1) {
    ok = await enter(strategy, 'taker', m.ticker, 'yes', m.book.ask, feePerContract(m.book.ask), fairValue, m.book.mid, `gap ${gap.toFixed(3)}`);
  } else if (side === 'no' && m.book.bid >= 0.01) {
    const px = 1 - m.book.bid;
    if (px > 0 && px < 1) ok = await enter(strategy, 'taker', m.ticker, 'no', px, feePerContract(px), fairValue, m.book.mid, `gap ${gap.toFixed(3)}`);
  }
  if (ok) st.n = 0;
}

async function makerStrategy(strategy, m, blendYes, blendNo, openTrades) {
  let qs = state.makerQuotes.get(m.ticker + '|' + strategy);
  if (!qs) {
    qs = { lastTradeTs: new Date(), yesBid: null, noBid: null };
    state.makerQuotes.set(m.ticker + '|' + strategy, qs);
  }
  if (m.secsLeft <= CUTOFF_S) {
    qs.yesBid = null;
    qs.noBid = null;
    return;
  }
  // Floor (never round up: rounding 0.605 -> 0.61 silently shrinks the edge),
  // and refuse to quote a side worth < 2c pre-clamp — the old Math.max(0.01,..)
  // clamp turned near-certain markets into degenerate 1c bids that only fill
  // via adverse selection (audit 2026-08-28: five such fills, -$22).
  const rawYes = blendYes - MAKER_EDGE;
  const rawNo = blendNo - MAKER_EDGE;
  qs.yesBid = rawYes >= 0.02 ? Math.min(0.97, Math.floor(rawYes * 100) / 100) : null;
  qs.noBid = rawNo >= 0.02 ? Math.min(0.97, Math.floor(rawNo * 100) / 100) : null;
  const trades = await q(
    `SELECT yes_price::float8 AS yp FROM kalshi_trades
     WHERE market_ticker = $1 AND source = 'ws' AND received_at > $2 ORDER BY received_at`,
    [m.ticker, qs.lastTradeTs]
  );
  if (trades.length) qs.lastTradeTs = new Date();
  const mine = openTrades.filter((t) => t.strategy === strategy);
  if (mine.length >= MAX_OPEN) return;
  const haveYes = mine.some((t) => t.market_ticker === m.ticker && t.side === 'yes');
  const haveNo = mine.some((t) => t.market_ticker === m.ticker && t.side === 'no');
  for (const t of trades) {
    if (!haveYes && qs.yesBid !== null && t.yp < qs.yesBid) {
      await enter(strategy, 'maker', m.ticker, 'yes', qs.yesBid, 0, null, m.book.mid, `through @ ${t.yp}`);
      break;
    }
    if (!haveNo && qs.noBid !== null && t.yp > 1 - qs.noBid) {
      await enter(strategy, 'maker', m.ticker, 'no', qs.noBid, 0, null, m.book.mid, `through @ ${t.yp}`);
      break;
    }
  }
}

async function lagStrategy(btc, alts, openTrades) {
  if (btc.bps2 === null || Math.abs(btc.bps2) < LAG_BPS) return;
  const side = btc.bps2 > 0 ? 'yes' : 'no';
  const mine = openTrades.filter((t) => t.strategy === 'lag');
  for (const a of alts) {
    if (a.secsLeft <= CUTOFF_S) continue;
    if (mine.length >= MAX_OPEN) break;
    if (mine.some((t) => t.market_ticker === a.ticker)) continue;
    const already = side === 'yes' ? a.book.mid : 1 - a.book.mid;
    if (already >= LAG_MAX_MID) continue;
    if (side === 'yes' && a.book.ask > 0 && a.book.ask < 1) {
      await enter('lag', 'taker', a.ticker, 'yes', a.book.ask, feePerContract(a.book.ask), null, a.book.mid, `btc ${btc.bps2.toFixed(1)}bps`);
    } else if (side === 'no' && a.book.bid >= 0.01) {
      const px = 1 - a.book.bid;
      if (px > 0 && px < 1) await enter('lag', 'taker', a.ticker, 'no', px, feePerContract(px), null, a.book.mid, `btc ${btc.bps2.toFixed(1)}bps`);
    }
  }
}

async function equitySnapshot() {
  const min = new Date().toISOString().slice(0, 16);
  if (state.lastEquityMin === min) return;
  state.lastEquityMin = min;
  const open = await q(
    `SELECT t.side, t.contracts::float8 AS contracts, t.cost::float8 AS cost,
            (SELECT mid::float8 FROM kalshi_book_snapshots b
             WHERE b.market_ticker = t.market_ticker AND b.ts > now() - interval '2 minutes'
             ORDER BY ts DESC LIMIT 1) AS mid
     FROM paper_trades t WHERE t.status = 'open'`
  );
  let mark = 0;
  for (const t of open) {
    const m = t.mid === null || t.mid === undefined ? null : t.side === 'yes' ? t.mid : 1 - t.mid;
    mark += m === null ? t.cost : t.contracts * m;
  }
  const settled = (await q(`SELECT coalesce(sum(pnl),0)::float8 AS pnl, count(DISTINCT strategy)::int AS ns FROM paper_trades WHERE status='settled'`))[0];
  const nStrategies = STRATEGIES.length;
  const openCost = open.reduce((s, t) => s + t.cost, 0);
  const cash = nStrategies * BOOK0 + settled.pnl - openCost;
  await q(`INSERT INTO paper_equity (cash, open_mark, equity) VALUES ($1,$2,$3) ON CONFLICT (ts) DO NOTHING`, [cash, mark, cash + mark]);
}

// Live signal telemetry: what every strategy sees/would do RIGHT NOW,
// published each tick for the dashboard's Signals panel. Display-only —
// nothing in this repository places orders.
const signals = {};

function setSignal(strategy, state, detail) {
  signals[strategy] = { state, detail, at: Date.now() };
}

async function publishSignals() {
  try {
    await db.pool.query('SELECT pg_notify($1, $2)', ['desk_signals', JSON.stringify(signals)]);
  } catch (e) { /* non-fatal */ }
}

async function tick() {
  await settleResolved();
  await equitySnapshot();
  const btc = await btcState();
  const openTrades = await q(`SELECT market_ticker, strategy, side FROM paper_trades WHERE status = 'open'`);
  if (btc) {
    await takerFade('fade', btc.fair, btc, openTrades);
    const fadeGap = btc.fair - btc.book.mid;
    setSignal('fade', Math.abs(fadeGap) >= FADE_GAP && btc.secsLeft > CUTOFF_S ? 'TRIGGERED' : 'watching',
      `BTC gap ${(fadeGap * 100).toFixed(1)}¢ (fair ${(btc.fair * 100).toFixed(1)} vs mid ${(btc.book.mid * 100).toFixed(1)}) · streak ${state.streak.fade.n}s · would buy ${fadeGap > 0 ? 'YES @ ' + (btc.book.ask * 100).toFixed(1) + '¢' : 'NO @ ' + ((1 - btc.book.bid) * 100).toFixed(1) + '¢'}`);

    // MC fair recomputed at most every 5s (block bootstrap, 1500 paths)
    if (!state.mc || Date.now() - state.mc.at > 5000) {
      const mc = mcFair({ price: btc.price, strike: btc.strike, secsLeft: btc.secsLeft, returns: btc.returns });
      state.mc = { at: Date.now(), fair: mc ? mc.p : null };
    }
    if (state.mc.fair !== null) {
      await takerFade('mcfade', state.mc.fair, btc, openTrades);
      const mcGap = state.mc.fair - btc.book.mid;
      setSignal('mcfade', Math.abs(mcGap) >= FADE_GAP && btc.secsLeft > CUTOFF_S ? 'TRIGGERED' : 'watching',
        `BTC gap ${(mcGap * 100).toFixed(1)}¢ (MC fair ${(state.mc.fair * 100).toFixed(1)}) · streak ${state.streak.mcfade.n}s`);
    }
    const blendYes = Math.min(btc.fair, btc.book.mid);
    await makerStrategy('maker', btc, blendYes, Math.min(1 - btc.fair, 1 - btc.book.mid), openTrades);
    const mq = state.makerQuotes.get(btc.ticker + '|maker');
    setSignal('maker', mq && (mq.yesBid !== null || mq.noBid !== null) ? 'QUOTING' : 'idle',
      mq ? `BTC resting: YES bid ${mq.yesBid !== null ? (mq.yesBid * 100).toFixed(0) + '¢' : '—'} / NO bid ${mq.noBid !== null ? (mq.noBid * 100).toFixed(0) + '¢' : '—'} (fills on trade-through)` : 'no quotes');

    const alts = await altStates();
    await lagStrategy(btc, alts, openTrades);
    setSignal('lag', btc.bps2 !== null && Math.abs(btc.bps2) >= LAG_BPS ? 'TRIGGERED' : 'watching',
      `BTC 2-min move ${btc.bps2 === null ? '—' : (btc.bps2 >= 0 ? '+' : '') + btc.bps2.toFixed(1) + 'bps'} (arms at ±${LAG_BPS}) · would buy ${btc.bps2 >= 0 ? 'YES' : 'NO'} on ${alts.length} alt windows`);

    let afTrig = [];
    let amQ = 0;
    for (const a of alts) {
      await makerStrategy('altmaker', a, a.book.mid, 1 - a.book.mid, openTrades);
      if (state.makerQuotes.get(a.ticker + '|altmaker')) amQ += 1;
      const fair = await altFair(a);
      if (fair !== null) {
        await altFadeStrategy(a, fair, openTrades);
        const g = fair - a.book.mid;
        if (Math.abs(g) >= FADE_GAP && a.secsLeft > CUTOFF_S) {
          afTrig.push(`${a.series_ticker.replace('KX', '').replace('15M', '')} ${g > 0 ? 'YES' : 'NO'} gap ${(g * 100).toFixed(1)}¢`);
        }
        await makerStrategy('altmakerfv', a, Math.min(fair, a.book.mid), Math.min(1 - fair, 1 - a.book.mid), openTrades);
      }
    }
    setSignal('altfade', afTrig.length ? 'TRIGGERED' : 'watching',
      afTrig.length ? afTrig.join(' · ') : 'no alt gap ≥ 5¢ right now');
    setSignal('altmaker', amQ ? 'QUOTING' : 'idle', `mid-only quotes on ${amQ} alt windows`);
    setSignal('altmakerfv', amQ ? 'QUOTING' : 'idle', `fair-blended quotes on the same windows`);
    await publishSignals();
  }
}

async function main() {
  log.info('paper engine v2 started (SIMULATED; per-strategy books of $' + BOOK0 + ': fade, mcfade, maker, lag, altmaker)');
  setInterval(() => {
    tick().catch((err) => log.error('tick error', err.message));
  }, 1000);
  setInterval(() => {
    db.heartbeat('paper-engine', { stop: fs.existsSync(STOP_FILE), mcFair: state.mc && state.mc.fair }).catch(() => {});
  }, 30000);
}

main().catch((err) => {
  log.error('fatal', err);
  process.exit(1);
});
