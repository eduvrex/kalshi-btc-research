# Calibration addendum — clustered robustness checks (2026-08-28)

The main report's caveats warn that consecutive candles within one market share
an outcome, inflating z. These checks re-run the key panels with **one unit per
market** (market's quoted = mean of its qualifying candle mids; outcome counted
once). They change the conclusions materially.

## 1. Reversal panel clustered — the commodity claim is dead

Markets that quoted mid ≤ 15¢ at any point with 2–5 minutes left:

| series | n markets | quoted | realized YES | z |
| --- | --- | --- | --- | --- |
| KXBTC15M | 2,830 | 0.048 | **0.067** | **+4.66** |
| KXGOLD15M | 681 | 0.062 | 0.060 | −0.18 |
| KXSILVER15M | 677 | 0.064 | 0.058 | −0.67 |
| KXWTI15M | 638 | 0.064 | 0.071 | +0.69 |

- **Commodities: flat.** The observation-level panel's negative gaps (gold/silver
  z ≈ −3.4/−3.7) were an artifact of weighting persistently-cheap markets by
  their many cheap minutes. Per market, quoted ≈ realized; after taker fees,
  buying cheap commodity contracts is −2 to −3¢/contract. **Eduardo's "5–15¢
  commodity contracts reverse more often than priced" is refuted either way** —
  not underpriced at obs-level, not underpriced per-market.
- **BTC15M is the live finding:** markets that *dip* to ≤15¢ resolve YES 6.7%
  vs 4.8% quoted (+1.9 pts, z = +4.7 with genuinely independent units). The
  obs-level panel hid this (+0.4 pt) because markets that *stay* cheap (and
  deservedly die) dominate the minute count. The edge, if implementable, is
  "buy the dip touch", roughly +0.5¢/contract after fees at the touch — thin,
  and it needs the look-ahead-free fill backtest before belief.

## 2. Favorites panel clustered — the grid's favorite underpricing is an artifact

Markets quoting mid 0.65–0.90 with 2–10 minutes left:

| series | n markets | quoted | realized YES | z |
| --- | --- | --- | --- | --- |
| KXBTC15M | 3,595 | 0.778 | 0.765 | −1.90 |
| KXGOLD15M | 1,070 | 0.778 | 0.762 | −1.28 |
| KXSILVER15M | 1,039 | 0.783 | 0.764 | −1.46 |
| KXWTI15M | 1,049 | 0.776 | 0.773 | −0.21 |

The grid's +3 to +6 point favorite-side gaps (incl. both Bonferroni-flagged
cells) disappear and mildly invert once clustered. No favorite edge.

Read together, panels 1–2 sketch one coherent mechanism on BTC15M:
**short-horizon quotes overshoot toward certainty** — dipped-cheap markets
resolve YES more than quoted, expensive markets slightly less. Fade-the-extreme,
not buy-the-tail. Same spirit as Eduardo's reversal observation, but it lives
in BTC, not commodities, and in quote-overshoot rather than tail underpricing.

## 3. UPDATE (same day): the fill-level backtest kills the dip finding too

The look-ahead-free backtest (src/research/dip-backtest.js, report
dip-backtest-2026-08-28.md) enters at the FIRST ≤15¢ touch, filling at the next
minute's opening ask with exact fees. Result: **BTC15M −$0.0077/contract
(−10.3% on risk, t=−1.66); frictionless −$0.0012 — flat even with zero costs.**
Commodities lose −24% to −39% on risk. Diagnosis: at the first touch the mid is
~6.8¢ and the win rate is 6.7% — the market is exactly right at the trigger.
Section 1's +1.9pt gap compared outcomes to the *average* mid across all cheap
minutes, a price no order can obtain. The finding was a conditioning artifact.

## Honest bottom line (revised)

At 1-minute granularity these markets are efficient everywhere we can actually
trade: the commodity-tail thesis is refuted, the favorite-side grid gaps are a
weighting artifact, and the BTC dip-overshoot dies at implementable fills.
Still open: the original second-scale dislocation thesis, which 1-minute candles structurally
cannot see and which waits on the order-book collector (Kalshi key ID).
