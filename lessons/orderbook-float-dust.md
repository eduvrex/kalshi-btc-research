# Accumulating order-book quantities as doubles leaves phantom dust levels

Kalshi delta quantities are decimal strings; summing them as JS doubles leaves
~1e-13 residue when a level empties, so a `next <= 0` delete never fires. The
level survives with qty ≈ 5.68e-14, best-bid sticks at a price nobody quotes,
and mid/spread/depth all rot — observed live within 15 minutes of the
collector's first run as *sustained negative spreads* (best YES bid + best NO
bid > 1, impossible against a matching engine).

Fix: keep book quantities as integer micro-contracts (`Math.round(qty * 1e6)`)
on both the snapshot and delta paths; convert back only when persisting.

Detection heuristic that caught it and stays useful: `spread < 0` sustained in
kalshi_book_snapshots is always a collector-state bug, never market reality.
Derived snapshot rows and dislocation events from the dust window
(2026-08-28 14:20–14:35 UTC) were deleted; raw kalshi_book_deltas rows are
wire-exact and were kept.
