# Prefix-quote study — does the market misprice path states? (2026-08-28)

Observations: 24958 (window × minute-mark) with a sane two-sided quote at the mark. Quote-at-mark = candle closing at open+m; fill = next candle's open; exact taker fees; one trade max per window. Path state from path-analysis.js (Kraken 1s, strike-anchored, no look-ahead).

## A. What the market quoted vs what realized, by path state

One row per (minute mark × time-above bucket): mean quoted mid at that moment vs realized YES frequency. Gap = realized − quoted; positive means YES was quoted too cheap in that state.

| mark | time above | n | mean quoted mid | realized | gap | z |
| --- | --- | --- | --- | --- | --- | --- |
| 3 | 0–20% | 2015 | 0.354 | 0.345 | -0.009 | -0.80 |
| 3 | 20–40% | 774 | 0.432 | 0.403 | -0.028 | -1.60 |
| 3 | 40–60% | 706 | 0.496 | 0.484 | -0.011 | -0.59 |
| 3 | 60–80% | 777 | 0.561 | 0.596 | +0.035 | 1.98 |
| 3 | 80–100% | 1968 | 0.648 | 0.667 | +0.020 | 1.83 |
| 6 | 0–20% | 1996 | 0.281 | 0.266 | -0.016 | -1.55 |
| 6 | 20–40% | 834 | 0.406 | 0.403 | -0.003 | -0.16 |
| 6 | 40–60% | 736 | 0.492 | 0.480 | -0.012 | -0.67 |
| 6 | 60–80% | 793 | 0.596 | 0.618 | +0.021 | 1.23 |
| 6 | 80–100% | 1892 | 0.731 | 0.750 | +0.019 | 1.83 |
| 9 | 0–20% | 1960 | 0.199 | 0.196 | -0.003 | -0.36 |
| 9 | 20–40% | 863 | 0.367 | 0.382 | +0.016 | 0.96 |
| 9 | 40–60% | 771 | 0.505 | 0.485 | -0.020 | -1.11 |
| 9 | 60–80% | 784 | 0.619 | 0.652 | +0.033 | 1.89 |
| 9 | 80–100% | 1874 | 0.804 | 0.816 | +0.013 | 1.39 |
| 12 | 0–20% | 1950 | 0.129 | 0.130 | +0.001 | 0.18 |
| 12 | 20–40% | 865 | 0.338 | 0.348 | +0.010 | 0.64 |
| 12 | 40–60% | 776 | 0.510 | 0.509 | -0.001 | -0.04 |
| 12 | 60–80% | 801 | 0.665 | 0.683 | +0.018 | 1.07 |
| 12 | 80–100% | 1823 | 0.871 | 0.875 | +0.004 | 0.55 |

## B. The disagreement trade, out of sample

Lookup built on train days only (2026-06-22..2026-08-01, 14859 obs); trades evaluated on test days (2026-08-01..2026-08-28, 10099 obs). Rule: at the first mark where |empirical − quoted mid| > threshold (and the lookup has ≥ 50 neighbours), take the empirical side at the next minute's opening quote + fee, hold to settlement.

| threshold | trades | buy-YES / buy-NO | win rate | mean cost | EV/contract | total PnL | t-stat | return on risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.03 | 2516 | 1243 / 1273 | 36.2% | $0.400 | $-0.0373 | $-93.85 | -4.17 | -9.3% |
| 0.05 | 2491 | 1244 / 1247 | 34.7% | $0.387 | $-0.0399 | $-99.37 | -4.51 | -10.3% |
| 0.08 | 2382 | 1174 / 1208 | 32.9% | $0.365 | $-0.0361 | $-85.95 | -4.07 | -9.9% |
| 0.12 | 2161 | 1060 / 1101 | 29.6% | $0.337 | $-0.0409 | $-88.29 | -4.48 | -12.1% |

## How to read this

- Section A is the direct answer: a |z| well past ~3.6 (Bonferroni for 20 cells) in some state row means the market misquotes that path shape; small z everywhere means path information is already in the price.
- Section B is the only number that can justify believing a live gap chip: the empirical-vs-market disagreement traded at real next-minute fills, out of sample. Negative EV here means the disagreement is the lookup being wrong, not the market.
- Same candle-granularity caveats as always: fills assume next-minute opening quotes were accessible; depth unknown pre-book-capture; z treats windows as independent (marks within a window are not — one trade per window keeps section B honest).

