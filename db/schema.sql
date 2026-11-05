-- Schema for Kalshi BTC short-duration market research. PostgreSQL 16.
-- Partitioned tables get daily partitions created by src/lib/db.js ensurePartitions().

CREATE TABLE IF NOT EXISTS kalshi_markets (
  ticker                    text PRIMARY KEY,
  series_ticker             text NOT NULL,
  event_ticker              text,
  market_type               text,
  strike_type               text,
  floor_strike              numeric,
  cap_strike                numeric,
  open_time                 timestamptz,
  close_time                timestamptz,
  expected_expiration_time  timestamptz,
  expiration_value          text,
  result                    text,
  status                    text,
  raw                       jsonb NOT NULL,
  first_seen                timestamptz NOT NULL DEFAULT now(),
  last_updated              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kalshi_markets_series_close_idx
  ON kalshi_markets (series_ticker, close_time);

-- 1-second order book snapshots built from websocket deltas.
-- A row is written when the book changed in the last second, plus a forced
-- row every FORCE_SNAPSHOT_EVERY_MS for liveness, so absence of rows between
-- forced snapshots means "book unchanged", not "no data".
CREATE TABLE IF NOT EXISTS kalshi_book_snapshots (
  market_ticker  text NOT NULL,
  ts             timestamptz NOT NULL,
  seq            bigint,
  forced         boolean NOT NULL DEFAULT false,
  yes_bids       jsonb NOT NULL,
  no_bids        jsonb NOT NULL,
  best_yes_bid   numeric,
  best_yes_ask   numeric,
  mid            numeric,
  spread         numeric,
  depth_yes_5c   numeric,
  depth_no_5c    numeric,
  PRIMARY KEY (market_ticker, ts)
) PARTITION BY RANGE (ts);
CREATE INDEX IF NOT EXISTS kalshi_book_snapshots_ts_idx
  ON kalshi_book_snapshots USING brin (ts);

-- Raw websocket book deltas (sub-second resolution, venue timestamps).
CREATE TABLE IF NOT EXISTS kalshi_book_deltas (
  market_ticker  text NOT NULL,
  seq            bigint NOT NULL,
  side           text NOT NULL,
  price          numeric NOT NULL,
  delta          numeric NOT NULL,
  ts_venue       timestamptz,
  received_at    timestamptz NOT NULL
) PARTITION BY RANGE (received_at);
CREATE INDEX IF NOT EXISTS kalshi_book_deltas_mkt_idx
  ON kalshi_book_deltas (market_ticker, received_at);
CREATE INDEX IF NOT EXISTS kalshi_book_deltas_recv_idx
  ON kalshi_book_deltas USING brin (received_at);

CREATE TABLE IF NOT EXISTS kalshi_trades (
  trade_id       text PRIMARY KEY,
  market_ticker  text NOT NULL,
  yes_price      numeric,
  no_price       numeric,
  count          numeric,
  taker_side     text,
  ts_venue       timestamptz,
  received_at    timestamptz,
  source         text NOT NULL DEFAULT 'ws',
  raw            jsonb
);
CREATE INDEX IF NOT EXISTS kalshi_trades_mkt_idx
  ON kalshi_trades (market_ticker, ts_venue);

-- Backfilled 1-minute candlesticks (the finest historical granularity Kalshi offers).
CREATE TABLE IF NOT EXISTS kalshi_candles_1m (
  market_ticker  text NOT NULL,
  period_end     timestamptz NOT NULL,
  yes_open       numeric,
  yes_high       numeric,
  yes_low        numeric,
  yes_close      numeric,
  volume         numeric,
  open_interest  numeric,
  raw            jsonb,
  PRIMARY KEY (market_ticker, period_end)
);

-- Index/price feeds: 1 Hz sampled exchange mids, the composite BRTI proxy,
-- and Polymarket RTDS relays (pm_binance, pm_chainlink).
CREATE TABLE IF NOT EXISTS index_ticks (
  source       text NOT NULL,
  ts           timestamptz NOT NULL,
  price        numeric NOT NULL,
  received_at  timestamptz NOT NULL,
  detail       jsonb
) PARTITION BY RANGE (ts);
CREATE INDEX IF NOT EXISTS index_ticks_source_ts_idx
  ON index_ticks (source, ts);
CREATE INDEX IF NOT EXISTS index_ticks_ts_idx
  ON index_ticks USING brin (ts);

-- Spot trades from a major exchange (Coinbase BTC-USD), tick granularity.
CREATE TABLE IF NOT EXISTS spot_ticks (
  exchange     text NOT NULL,
  trade_id     text,
  price        numeric NOT NULL,
  size         numeric,
  best_bid     numeric,
  best_ask     numeric,
  ts_venue     timestamptz NOT NULL,
  received_at  timestamptz NOT NULL
) PARTITION BY RANGE (ts_venue);
CREATE INDEX IF NOT EXISTS spot_ticks_exch_ts_idx
  ON spot_ticks (exchange, ts_venue);
CREATE INDEX IF NOT EXISTS spot_ticks_ts_idx
  ON spot_ticks USING brin (ts_venue);

-- Historical spot BTC-USD aggregated to 1-second bars from exchange REST trade history.
CREATE TABLE IF NOT EXISTS spot_bars_1s (
  exchange  text NOT NULL,
  ts        timestamptz NOT NULL,
  open      numeric NOT NULL,
  high      numeric NOT NULL,
  low       numeric NOT NULL,
  close     numeric NOT NULL,
  vwap      numeric,
  volume    numeric,
  n_trades  integer,
  PRIMARY KEY (exchange, ts)
);
CREATE INDEX IF NOT EXISTS spot_bars_1s_ts_idx ON spot_bars_1s USING brin (ts);

-- Spot downloader resume state.
CREATE TABLE IF NOT EXISTS spot_dl_state (
  exchange    text PRIMARY KEY,
  cursor      text,
  oldest_ts   timestamptz,
  newest_ts   timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Research dataset: one row per market per minute (decision points for the model).
CREATE TABLE IF NOT EXISTS model_rows (
  market_ticker      text NOT NULL,
  ts                 timestamptz NOT NULL,
  tau_s              integer NOT NULL,
  x                  double precision,
  sigma              double precision,
  z                  double precision,
  yes_bid_close      double precision,
  yes_ask_close      double precision,
  price_close        double precision,
  next_yes_bid_open  double precision,
  next_yes_ask_open  double precision,
  volume_min         double precision,
  y                  integer NOT NULL,
  PRIMARY KEY (market_ticker, ts)
);
CREATE INDEX IF NOT EXISTS model_rows_ts_idx ON model_rows (ts);

-- Per-market settlement screens (manipulation tests): spot move into the
-- 60s settlement window and reversal after close.
CREATE TABLE IF NOT EXISTS settlement_screens (
  market_ticker  text PRIMARY KEY,
  close_time     timestamptz NOT NULL,
  strike         numeric,
  settle         numeric,
  result         text,
  r_settle       double precision,
  r_after        double precision,
  spot_at_close  double precision
);

-- Backfill resume tracking.
CREATE TABLE IF NOT EXISTS backfill_progress (
  market_ticker  text PRIMARY KEY,
  trades_done    boolean NOT NULL DEFAULT false,
  candles_done   boolean NOT NULL DEFAULT false,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Dislocation events: seconds-scale disagreements between the index proxy and
-- the quoted book, detected live by src/research/live-dislocation-monitor.js.
-- This is the event ledger: each row is one occurrence of "the screen said
-- one thing and the book said another", with enough context to price it.
CREATE TABLE IF NOT EXISTS dislocation_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  market_ticker  text NOT NULL,
  started_at     timestamptz NOT NULL,
  ended_at       timestamptz,
  duration_s     integer,
  strike         numeric,
  side           text,
  max_gap        double precision,
  mean_gap       double precision,
  d_at_max       double precision,
  z_at_max       double precision,
  fair_at_max    double precision,
  mid_at_max     double precision,
  ask_at_max     double precision,
  bid_at_max     double precision,
  ask_size_at_max  double precision,
  bid_size_at_max  double precision,
  n_seconds      integer,
  alerted        boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS dislocation_events_mkt_idx
  ON dislocation_events (market_ticker, started_at);

-- Collector liveness, one row per heartbeat.
CREATE TABLE IF NOT EXISTS collector_heartbeats (
  collector  text NOT NULL,
  ts         timestamptz NOT NULL DEFAULT now(),
  detail     jsonb
);
CREATE INDEX IF NOT EXISTS collector_heartbeats_idx
  ON collector_heartbeats (collector, ts);

-- Local clock vs reference server clock measurements.
CREATE TABLE IF NOT EXISTS clock_sync (
  source     text NOT NULL,
  ts         timestamptz NOT NULL DEFAULT now(),
  offset_ms  numeric NOT NULL,
  rtt_ms     numeric NOT NULL
);
CREATE INDEX IF NOT EXISTS clock_sync_idx ON clock_sync (source, ts);

-- Per-window index-path statistics vs strike (Eduardo's time-above/weighted
-- analysis). Path = 1s spot closes anchored to the official strike via the
-- 60s pre-open average, so venue-level basis cancels. One row per settled
-- KXBTC15M window with adequate path coverage.
CREATE TABLE IF NOT EXISTS window_path_stats (
  market_ticker  text PRIMARY KEY,
  close_time     timestamptz NOT NULL,
  strike         numeric NOT NULL,
  settle         numeric NOT NULL,
  result         text NOT NULL,
  path_source    text NOT NULL,
  n_secs         integer NOT NULL,
  secs_above     integer NOT NULL,
  avg_above      numeric,          -- mean $ distance while above
  avg_below      numeric,          -- mean $ distance while below (negative)
  twad           numeric NOT NULL  -- time-weighted avg signed distance, full window
);
CREATE INDEX IF NOT EXISTS window_path_stats_close_idx ON window_path_stats (close_time);

-- Same path measured only up to N minutes into the window (prefix state),
-- for the live "windows that looked like this" empirical lookup.
CREATE TABLE IF NOT EXISTS window_path_prefix (
  market_ticker  text NOT NULL,
  min_mark       integer NOT NULL, -- minutes elapsed since open (3, 6, 9, 12)
  n_secs         integer NOT NULL,
  secs_above     integer NOT NULL,
  twad           numeric NOT NULL,
  result         text NOT NULL,
  PRIMARY KEY (market_ticker, min_mark)
);
CREATE INDEX IF NOT EXISTS window_path_prefix_idx ON window_path_prefix (min_mark);

-- Paper trading desk (Phase 4.5): simulated fills against live captured books.
-- No live orders exist anywhere in this codebase; the engine only reads
-- market data and writes simulated trades here.
CREATE TABLE IF NOT EXISTS paper_trades (
  id             bigserial PRIMARY KEY,
  ts             timestamptz NOT NULL DEFAULT now(),
  strategy       text NOT NULL,        -- 'fade' | 'maker'
  market_ticker  text NOT NULL,
  side           text NOT NULL,        -- 'yes' | 'no'
  role           text NOT NULL,        -- 'taker' | 'maker'
  price          numeric NOT NULL,     -- per-contract cost, excl fee
  fee            numeric NOT NULL,
  contracts      numeric NOT NULL,
  cost           numeric NOT NULL,     -- total debit incl fee
  fair_at_entry  numeric,
  mid_at_entry   numeric,
  note           text,
  status         text NOT NULL DEFAULT 'open',
  result         text,
  pnl            numeric,
  settled_at     timestamptz
);
CREATE INDEX IF NOT EXISTS paper_trades_status_idx ON paper_trades (status, market_ticker);

CREATE TABLE IF NOT EXISTS paper_equity (
  ts         timestamptz PRIMARY KEY DEFAULT now(),
  cash       numeric NOT NULL,
  open_mark  numeric NOT NULL,
  equity     numeric NOT NULL
);
