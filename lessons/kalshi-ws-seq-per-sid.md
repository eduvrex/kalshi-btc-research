# The Kalshi websocket seq counter is per-subscription (sid), not per-market

One `orderbook_delta` subscription covering N markets carries a single `seq`
counter across all of them: consecutive envelopes for different markets still
increment by 1. Checking `seq === lastSeqForThisMarket + 1` (the reading NOTES'
old "seq for gap detection" line invited) fails on nearly every delta once two
markets are active, turning gap detection into noise and — if each false gap
requests a snapshot — into a self-sustaining get_snapshot command flood.

Correct: track one lastSeq per sid, consume it from BOTH orderbook_snapshot and
orderbook_delta envelopes, reset it on reconnect, and on a genuine gap treat
the whole subscription as desynced (invalidate every book, re-snapshot all).

Caught by pre-flight adversarial review 2026-08-27 before the collector's first
live run (no key yet). Same review found snapshot/delta price-string width
mismatch (normalize keys numerically) and that snapshot-on-add_markets is
undocumented (always follow add_markets with an explicit get_snapshot).
