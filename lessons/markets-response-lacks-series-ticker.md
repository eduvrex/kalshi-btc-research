# The live /markets response has no series_ticker field

Market objects returned by `GET /trade-api/v2/markets?series_ticker=...` do not
include `series_ticker` (observed live 2026-08-27; the field existed when the
schema was designed against 2026-06-12 docs). First live backfill run died on
the NOT NULL constraint of `kalshi_markets.series_ticker`.

Why it mattered: every ingest path (backfill and both collector paths) feeds
`upsertMarket`, so nothing could be inserted at all.

Fix: `db.upsertMarket` now derives the series as the prefix of `event_ticker`
(fallback `ticker`) before the first `-` (e.g. `KXBTC15M-26AUG272015` →
`KXBTC15M`), and the backfill additionally forces the series it queried by.
Verified: ticker format `SERIES-DATEHOUR-STRIKE` holds across all nine
configured series.
