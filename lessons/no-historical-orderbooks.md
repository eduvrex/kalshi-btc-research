# Order book depth cannot be backfilled — capture starts when our collector starts

Kalshi's API exposes historical trades, 1-minute candles, and settlement values, but no past order book state (verified against the live + historical endpoint docs, 2026-06-12).

Why it mattered: "thin book" labeling in Phase 2 is only possible from the day our collector started. Every day of collector downtime is a permanent hole in the research dataset — keep PM2 restart policies and heartbeat monitoring honest.
