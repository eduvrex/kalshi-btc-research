# Gemini feed froze at connection values and poisoned the composite

Two compounding bugs in the Gemini leg of collector-prices: (1) with
`top_of_book=true`, ongoing updates arrive as plain `change` events, but the
handler only accepted `reason === 'initial'` (plus a nonexistent
`type === 'top-of-book'`), so the quote froze at whatever the connection saw
first; (2) `latest.gemini` was re-stamped with a fresh timestamp on every
incoming message even when no event updated a price, so the FRESH_MS staleness
guard never tripped. Result: a tight-spread, plausible-looking, hours-stale
quote silently averaged into proxy_composite.

Why it mattered: first proxy-vs-settlement residuals read mean +$74 / p95 $145
(≈0.5σ of a 15-min window — the monitor would have been blind to small
dislocations and alarmed on phantom ones).

How it was caught — keep this diagnostic: decompose the composite residual
**per venue** against strike-chain official settlements. Gemini read +$85 to
+$603 while every other source sat within ±$15; frozen-to-the-cent values
across seconds confirmed staleness rather than a wide book.

Fixes: accept all `change` events; stamp freshness only when an event updated
a side. Historic proxy_composite rebuilt from coinbase+kraken+bitstamp (rows
carry `{"rebuilt": true, "n": 3}`); post-fix composite is 4-venue again, so a
small membership basis step exists at 2026-08-28 17:03 UTC. Corrected
residuals: **mean $3.94 / p95 $8.48 (n=5)**.

General rule: a feed's freshness timestamp must move only on actual data
updates, never on message receipt.
