# NOTES.md — Verified API facts (researched 2026-06-12)

Everything below was verified against official documentation or live API responses on 2026-06-12.
Items marked **[unverified]** could not be confirmed from a primary source.

---

## 1. Kalshi

### REST API
- Base URL: `https://api.elections.kalshi.com/trade-api/v2` ([API environments](https://docs.kalshi.com/getting_started/api_environments))
- Market data endpoints (markets, orderbook, trades, candlesticks) work **without authentication** — confirmed by live unauthenticated requests to `/series/KXBTC15M`, `/markets?series_ticker=KXBTC15M`, and `/markets/{ticker}/orderbook` during this research session.
- Orderbook: `GET /markets/{ticker}/orderbook` returns `orderbook_fp: {yes_dollars, no_dollars}` — **bids only on both sides** (a YES bid at $p$ is an implicit NO ask at $1-p$). Full depth, no level cap parameter needed. [Orderbook docs](https://docs.kalshi.com/getting_started/orderbook_responses), [endpoint](https://docs.kalshi.com/api-reference/market/get-market-orderbook)
- Batch orderbooks: `GET /markets/orderbooks?tickers=...` ([docs](https://docs.kalshi.com/api-reference/market/get-multiple-market-orderbooks)) — but each market in a batch is billed separately for rate-limit tokens.
- Fixed-point migration in progress: prefer `*_dollars` / `*_fp` fields. Legacy cent-based order endpoints deprecated no earlier than May 6, 2026. ([Fixed-point](https://docs.kalshi.com/getting_started/fixed_point_migration), [Create Order V2](https://docs.kalshi.com/api-reference/orders/create-order-v2))

### WebSocket
- URL: `wss://api.elections.kalshi.com/trade-api/ws/v2` ([Quick Start: WebSockets](https://docs.kalshi.com/getting_started/quick_start_websockets))
- **Authentication is required to establish the connection**, even for public market-data channels. Headers at handshake: `KALSHI-ACCESS-KEY`, `KALSHI-ACCESS-SIGNATURE`, `KALSHI-ACCESS-TIMESTAMP` (ms). Signature = RSA-PSS-SHA256 (salt length = digest length) over `timestamp + "GET" + "/trade-api/ws/v2"`. **⇒ Live collection needs a Kalshi API key.**
- Channels used: `orderbook_delta` (sends `orderbook_snapshot` then `orderbook_delta`; `seq` for gap detection — **the counter is per-subscription/sid, shared across all markets on it, NOT per-market**, see lessons/kalshi-ws-seq-per-sid.md; deltas carry venue `ts_ms`), `trade` (public trades), `ticker`, `market_lifecycle_v2`. ([orderbook channel](https://docs.kalshi.com/websockets/orderbook-updates), [trades](https://docs.kalshi.com/websockets/public-trades))
- `update_subscription` supports `add_markets`/`delete_markets`/`get_snapshot` — needed to roll subscriptions as 15-min markets expire every 15 minutes.
- Note: the AsyncAPI spec for `orderbook_delta` lists host `external-api-ws.kalshi.com` while the connection guide says `api.elections.kalshi.com`. Using the documented connection-guide URL; the other is recorded as a fallback.

### Rate limits ([docs](https://docs.kalshi.com/getting_started/rate_limits))
- Token-based. Basic tier: **200 read tokens/s, 100 write tokens/s**; most calls cost 10 tokens ⇒ ~20 reads/s. Advanced tier (free application): 300/300.
- 429 has no `Retry-After` header; exponential backoff required. Write bucket holds 2s of budget for bursts (except Basic: 1s).

### Markets and settlement
- **15-min series: `KXBTC15M`** ("Bitcoin price up down", frequency `fifteen_min`). Live response: settlement source CF Benchmarks; contract terms [CRYPTO15M.pdf](https://kalshi-public-docs.s3.amazonaws.com/contract_terms/CRYPTO15M.pdf).
  - Structure (from live market object): "BTC price up in next 15 mins?" — resolves YES if the 60-second simple average of BRTI before window close ≥ the 60-second simple average of BRTI before window open. `floor_strike` = the open reference price, `strike_type: greater_or_equal`. The strike is unknown until the window opens ("Target price: TBD" before open).
- **Hourly series: `KXBTC`** ("Bitcoin range", frequency `hourly`): above/below/between strikes, settles on the same 60s-average BRTI rule. Settlement source link in live response points to [BRTI](https://www.cfbenchmarks.com/data/indices/BRTI).
- **Settlement rule (both)**: simple average of the 60 per-second BRTI values in the last minute before expiration, **rounded to the nearest 2 decimal places** (from live `rules_secondary` and [Kalshi Help: Crypto Markets](https://help.kalshi.com/en/articles/13823838-crypto-markets)). "Above X" = strictly greater; "at least X" = ≥ (contract terms PDF).
  - If no/incomplete data at expiration: affected strikes resolve **No** (CRYPTO15M.pdf).
  - Settled markets expose `expiration_value` via the API ⇒ usable as ground truth to calibrate our BRTI proxy.
- Pricing: min tick $0.001 in price ranges 0–0.10 and 0.90–1.00, $0.01 between (`price_level_structure: tapered_deci_cent`, live response). Fractional contracts enabled.
- Position accountability level: $25,000 per strike per member (CRYPTO15M.pdf).

### Fees ([official fee schedule PDF, effective Feb 5, 2026](https://kalshi.com/docs/kalshi-fee-schedule.pdf))
- Taker: `fee = ceil_to_cent(0.07 × C × P × (1−P))`. At P=$0.50: $1.75 per 100 contracts (3.5% of the 50¢ at-risk... i.e. large relative to short-horizon edges — round-trip at mid prices costs ~3.5¢ per contract pair).
- Both `KXBTC15M` and `KXBTC` have `fee_type: "quadratic", fee_multiplier: 1` (live API) ⇒ standard 0.07 formula, **no maker fee** on these series today (maker fees only apply to `quadratic_with_maker_fees` series; maker formula would be 0.0175). Monitor [`GET /series/fee_changes`](https://docs.kalshi.com/api-reference/exchange/get-series-fee-changes) for scheduled changes.
- No settlement fee. Resting orders that never fill cost nothing.
- **Strategy implication**: maker fills are free; taker fills at mid-prices cost ~2¢/contract (per-order ceil rounding makes small orders proportionally worse: 1 contract at $0.50 → 2¢, i.e. 4% of capital at risk).

### Historical data / backfill ([docs](https://docs.kalshi.com/getting_started/historical_data))
- Live API window target: ~3 months; older data via `GET /historical/*` (markets, trades, candlesticks). Cutoffs from `GET /historical/cutoff`.
- Backfillable: **trades** (`GET /markets/trades`, public), **1-minute candlesticks** (yes-price OHLC, volume, OI), settled market metadata incl. `expiration_value`.
- **Order book depth is NOT available historically** — neither live nor historical endpoints expose past books. Depth capture starts the day our collector starts. This bounds how fast Phase 2 can have data: thin-book labeling needs our own captured books.

---

## 2. CF Benchmarks BRTI

- **BRTI = CME CF Bitcoin Real-Time Index**: published once per second, 24/7, calculated from the aggregated order books (not trades) of the constituent exchanges. UK BMR Registered Benchmark. [Index page](https://www.cfbenchmarks.com/data/indices/BRTI), [methodology PDF](https://docs.cfbenchmarks.com/CME%20CF%20Real%20Time%20Indices%20Methodology.pdf)
- Constituent exchanges (per CF Benchmarks): Bitstamp, Coinbase, Gemini, itBit, Kraken, LMAX Digital, Bullish, Crypto.com. **[verify current list in methodology PDF Annex when building the proxy]**
- Official API: REST + WebSocket (`value` channel, `PER_SECOND` default, `PER_200MS` available) — **requires a commercial license / credentials** ([API docs](https://docs.cfbenchmarks.com/api/websocket/value/)). No free or delayed public feed is documented.
- **Plan**: build a 1 Hz BRTI **proxy** from constituent-exchange order-book mids (Coinbase + Kraken to start, both constituents, free public websockets), then calibrate the proxy against (a) settled-market `expiration_value` ground truth from Kalshi and (b) the displayed BRTI on the CF Benchmarks site for spot checks. Measure and report proxy↔settlement residuals in the data-quality report. If the proxy is too loose, licensing BRTI is the fallback (cost unknown; contact CF Benchmarks).

---

## 3. Polymarket (secondary venue)

- Docs: https://docs.polymarket.com. Market data is public, no auth ([overview](https://docs.polymarket.com/market-data/overview)).
- APIs: Gamma (`gamma-api.polymarket.com`, market discovery), CLOB (`clob.polymarket.com`, books/prices/trades), CLOB market WebSocket (real-time book), and **RTDS** `wss://ws-live-data.polymarket.com` ([docs](https://docs.polymarket.com/market-data/websocket/rtds)) which streams **free, no-auth BTC prices from two sources: Binance (`btcusdt`) and Chainlink (`btc/usd`)** — useful both as Polymarket's own settlement-adjacent feed and as an extra spot cross-reference for us.
- Crypto market resolution: hourly "Bitcoin Up or Down" resolves on the **Binance BTCUSDT 1-hour candle** open vs close ([example event](https://polymarket.com/event/bitcoin-up-or-down-june-12-2026-1pm-et)); 15-minute crypto markets resolve on **Chainlink** data streams (per [RTDS docs](https://docs.polymarket.com/market-data/websocket/rtds) tip). **Different settlement index than Kalshi (BRTI)** — a cross-venue strategy must model both indices.
- Fees ([docs](https://docs.polymarket.com/trading/fees)): Crypto category taker fee `0.07 × C × p × (1−p)` (same shape as Kalshi), **maker fee 0**, rounded to 5 decimals (no per-order ceil — slightly cheaper than Kalshi for small orders). Trading requires onchain setup (Polygon wallet, pUSD); deferred until Kalshi edge is proven.

---

## 4. Sandbox/environment constraints found during research

- The original research sandbox could not reach `api.elections.kalshi.com` directly (curl exit 56); the research fetches above went through a fetch tool. **Collectors must run on a host with direct network access to the venues (`<collector-host>`)** — the code is written for a small always-on Linux or macOS server.
- Live BTC market activity observed today is thin: a recent KXBTC15M market showed total volume of ~101 contracts and an empty book after close. Thin books are the premise of the hypothesis, but they also mean episode counts may accumulate slowly — Phase 2 sample-size math will matter.

## 5. Hypothesis correction and historical-data sourcing (added 2026-06-12, same day)

**Refined research question:** "thin book" refers to the *BRTI constituent exchanges'* spot order books, not Kalshi's contract books. Thesis: thin spot liquidity lets BRTI jump or be pushed (possibly deliberately, since pushing thin spot books moves the settlement index), and Kalshi contract prices misprice during/after such moves. Observed Kalshi-side volume supports this reframing: a single 15-min market on 2026-06-05 traded ~564k contracts — Kalshi books are not the bottleneck.

**Free BRTI ground truth discovered:** each settled KXBTC15M market exposes `expiration_value` (official 60s-avg BRTI at close) and `floor_strike` (official 60s-avg BRTI at open), and consecutive windows chain — verified live: market closing 13:00 had strike 61955.16 = the 12:45 market's expiration_value. So the backfill yields an official BRTI series at 15-minute cadence ~90 days back, free. Strike and settlement are exact; only the intra-window path needs a proxy.

**Verified response shapes (live API, 2026-06-12):** 1-min candlesticks carry `price`, `yes_bid`, `yes_ask` OHLC as `*_dollars` strings plus `volume_fp`/`open_interest_fp`; trades carry `yes_price_dollars`, `count_fp`, `created_time` (µs ISO), `taker_side`. The backfill parsers match these.

**Historical spot/BRTI sourcing options:**

| Source | What | Cost | Notes |
| --- | --- | --- | --- |
| Exchange REST trade history (Coinbase, Kraken) | tick trades → our 1s bars, ~90 days | free | implemented: `src/backfill/download-spot-history.js`; no depth |
| [Tardis.dev](https://docs.tardis.dev/) | full historical L2 depth + trades for Kraken, Bitstamp, Gemini (Spot plan); **Coinbase only in All Exchanges plan**; monthly billing incl. 4 months history | paid; pricing via order form; **free trials on request** | the only practical source of historical *depth* for the thinness leg |
| CF Benchmarks API | official BRTI 1s (and 200ms) history | commercial license | `STREAM_HISTORICAL_VALUES` authorization; [REST historical values](https://docs.cfbenchmarks.com/api/rest/historical-values/) |
| Coinbase WS `level2` (live) | real-time depth | free but **requires auth since 2023-08-01** | for collector upgrade; Kraken/Bitstamp/Gemini depth feeds are public |

**Research pipeline implemented (runs on the collector host):** backfill-kalshi → download-spot-history → build-dataset (model_rows: per-minute normalized distance-to-strike z, quote bounds, outcomes; settlement_screens: settlement-window push vs post-close reversal) → fit-and-backtest (logistic calibration, look-ahead-free next-minute-open fills, exact taker fee math, threshold sweep, manipulation screen, honest caveats).

## 6. Commodity markets and Pyth (added 2026-08-27)

Verified against live API responses and contract terms on 2026-08-27.

**Kalshi commodity 15-minute series exist and are liquid.** `KXGOLD15M` ("Gold 15-minute") and `KXSILVER15M`, category Commodities, `frequency: fifteen_min`, `fee_type: quadratic`, `fee_multiplier: 1` (same 0.07 taker formula, maker fee zero). Settlement sources: `Pyth - Gold` / `Pyth - Silver`, linked to `app.pyth.com/explore/Metal.Index.GOLD%2FUSD`. Contract terms: [COMMOD15M.pdf](https://assets.kalshi.com/contract_terms/COMMOD15M.pdf). Gold windows on 2026-08-24 traded 84k–255k contracts each. WTI 15-min ticker **[unverified]** — query `GET /series?category=Commodities`.

**The settlement mechanic differs fundamentally from crypto.** Live `rules_primary` on a settled gold market: *"If the close price of the 1-minute candlestick for Gold at 11:15 AM EDT is at least the close price of the 1-minute Pyth GOLD candlestick at 11:00 AM EDT…"* — a **single 1-minute candle close**, not a 60-second average. `rules_secondary` clarifies the candle timestamped 4:59 PM covers 4:59:00–4:59:59 and closes at 5:00:00. Rounded to 2 decimals (`custom_strike.round_digits: "2"`), `strike_type: greater_or_equal`, minimum tick $0.01 per the PDF (vs $0.001 tapered on crypto — note the live response still reports `tapered_deci_cent` price ranges, so trust the API over the PDF here).

Modelling consequence: a point-in-time settlement does not lock in progressively the way a 60-second average does, so its outcome distribution narrows differently as expiry approaches. Any fair-value model must branch on which settlement rule applies; the calibration study measures how quoted prices behave under each rule.

**Strike chaining works for commodities too**, so official Pyth settlement values are free at 15-minute cadence from settled markets. Verified 2026-08-24 gold: strike 4672.05 → settled 4670.66; next strike 4670.66. Same trick as BRTI.

**Pyth access, verified live 2026-08-28 with a 14-day trial key.** Auth mechanism is `Authorization: Bearer $PYTH_API_KEY` (x-api-key / query-param forms are rejected). The old TradingView shim (`/v1/shims/tradingview/*`) is **gone — 404** even authenticated. Working endpoints: `hermes.pyth.network/v2/price_feeds?query=…` (metadata; works with key), `hermes.pyth.network/v2/updates/price/latest|stream` and `benchmarks.pyth.network/v1/updates/price/{ts}` (price data; per-feed entitlement enforced).

**The index feeds are entitlement-gated and the trial does NOT include them.** Price requests for any `*.Index.*` feed return 403 `Not entitled … requires access to one of the following groups: ["pyth-indices"]`. Standard feeds (`Crypto.BTC/USD`, `Metal.XAU/USD`) work fine on the same key. ⇒ To read the actual Kalshi settlement feeds, the account needs the **Pyth Indices** group added (app.pyth.com).

**Trial contents (2026-08-28): 25 feeds, zero `*.Index.*`.** Relevant: `Metal.XAU/USD`, `Metal.XAG/USD`, `Commodities.WTIV6/X6/Z6/F7` (WTI futures months), `Crypto.BTC/USD`. Observed level basis vs settlement indices is LARGE (XAU 4563 vs gold-index settles ~4670 — different products), so these are usable only as *change* proxies anchored to the strike (same identity as the BRTI proxy). collector-prices now streams all five via Hermes SSE into `index_ticks` as `pyth_xau/xag/wtiv6/wtix6/btc`; validation = per-window Δproxy vs Δsettle from the strike chain, decides whether these proxies are usable without paying for pyth-indices.

**Symbol discrepancy RESOLVED (2026-08-28).** `Metal.Index.GOLD/USD` and `Metal.XAU/USD` are **different products**: the `.Index.` feeds are 24/7 synthetic indices ("PYTH PRICE IN USD FOR GOLD 24/7", schedule all-open) — these are what Kalshi settles on; `Metal.XAU/USD` is spot gold with market hours. Do not proxy one with the other. Feed IDs (hermes v2, verified):

| Kalshi series | Pyth symbol | feed id |
| --- | --- | --- |
| KXGOLD15M | Metal.Index.GOLD/USD | `fa0f57505be633c026896e15afef2c7ce2cf8ff9a45349d1da737f4f01266b01` |
| KXSILVER15M | Metal.Index.SILVER/USD | `6afca47e1c79ecd0d2844327efb463478417a9d498dfb0915ce5e88ae6d952d3` |
| KXWTI15M | Commodities.Index.PYTHOIL/USD | `67784f72e95ac01337edb7d7bd5bbd1c03669101b7068a620df228ed4e52ef14` |
| KXNATGAS15M | Commodities.Index.NATGAS/USD | `45f95717fbe158e896415d1cea33814d73e54169022a8f7bcbb815ebef92f71c` |
| KXCOPPER15M | Commodities.Index.CU/USD | `b2b238aeb6ef5a722c5cf278595bf40434e174cac4f88c8ad5b6f5009b548c59` |

(Beware: `Commodities.Index.COPPER/USD` also exists but Kalshi's settlement source URL cites `CU/USD`. BRENT and TGAS index feeds exist too.)

**Calibration is the decisive test and needs none of the above.** `src/research/calibration.js` measures realized outcome frequency against quoted price using only Kalshi candles and settled results — no Pyth key, no BRTI licence, no depth, no spot feed. Math verified in `test/math.test.js` (22 checks, including all 21 rows of the official fee table).
