# Path analysis — time above strike vs settlement (2026-08-28)

Eduardo's question: how long does the index spend above/below the strike during
a 15-minute window, at what average distance, and does that predict settlement?
Implementation: src/research/path-analysis.js — Kraken 1s bars (30s forward-
fill), anchored to the official strike via the 60s pre-open average so venue
basis cancels; 6,322 KXBTC15M windows over 90 days (84 skipped for coverage).
Tables: window_path_stats (full window), window_path_prefix (state at minutes
3/6/9/12 — strictly no look-ahead).

## Full-window spread

| time above strike | n | settled YES |
| --- | --- | --- |
| 0–20% | 1,995 | 6.7% |
| 20–40% | 834 | 29.7% |
| 40–60% | 760 | 53.3% |
| 60–80% | 834 | 72.3% |
| 80–100% | 1,899 | 93.4% |

## The reversal profile (Eduardo's remembered case)

1,865 windows spent ≥12 of 15 minutes above the strike; **118 (6.3%) settled
NO anyway** — and they hovered thin: weighted distance averaged **+$31** vs
+$77 for those that settled YES. Conditioned on hover depth (≥12 min above):

| weighted distance above | n | settled NO |
| --- | --- | --- |
| $0–50 | 875 | **11.3%** |
| $50–100 | 572 | 2.6% |
| $100–150 | 220 | 1.4% |

"Spent 12 minutes ~$20–30 above and then settled below" is a real, quantified
phenomenon: roughly 1-in-9 at thin hover. Whether the MARKET misprices those
states is the next question — it needs the quote joined in (candles or books
at the prefix marks vs the empirical rates below).

## Mid-window empirical rates (the live lookup model)

Share of history settling YES given (time-above fraction, minute mark):

| time above ↓ / at minute → | 3 | 6 | 9 | 12 |
| --- | --- | --- | --- | --- |
| 0–20% | 35% | 27% | 19% | 13% |
| 20–40% | 40% | 40% | 38% | 35% |
| 40–60% | 48% | 48% | 49% | 51% |
| 60–80% | 59% | 62% | 65% | 68% |
| 80–100% | 67% | 75% | 82% | 88% |

Serves live on the Live Board (src/report/live-board.js, port 8791) as
"similar windows settled YES x%" — a banded nearest-neighbor lookup on
(mark, fraction ±0.12, weighted distance band), n always displayed. First live
comparison was instructive: martingale Φ(z) said 98.3% while the lookup said
87.8% (n=437) for a 100%-above/+$145 state at minute 6 — history tempers the
martingale exactly where the reversal profile lives.

Maintenance: `node src/research/path-analysis.js` is incremental (only new
windows); re-run when refreshing analyses.
