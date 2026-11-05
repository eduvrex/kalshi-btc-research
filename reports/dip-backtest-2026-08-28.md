# Dip backtest — buy YES at the next-minute ask after a ≤15¢ dip (2–5 min left)

Generated 2026-08-28T13:51:11.919Z. One trade max per market; fill at the NEXT candle's opening ask + exact taker fee; hold to settlement. "Frictionless" fills at the signal mid with no fee — the difference is what spread+fees eat.

| series / variant | trades | mean cost | win rate | 95% CI | EV/contract | total PnL | t-stat | return on risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| KXBTC15M — filled | 2830 | 0.074 | 6.7% | 0.058–0.077 | $-0.0077 | $-21.77 | -1.66 | -10.3% |
| KXBTC15M — frictionless | 2830 | 0.068 | 6.7% | 0.058–0.077 | $-0.0012 | $-3.27 | -0.25 | -1.7% |
| KXBTC15M — notes | signals 2830, unfillable 0 | avg slip vs mid $0.0021 | | | | | | |
| KXGOLD15M — filled | 680 | 0.091 | 6.0% | 0.045–0.081 | $-0.0312 | $-21.21 | -3.45 | -34.1% |
| KXGOLD15M — frictionless | 681 | 0.079 | 6.0% | 0.045–0.081 | $-0.0188 | $-12.80 | -2.09 | -23.8% |
| KXGOLD15M — notes | signals 681, unfillable 1 | avg slip vs mid $0.0070 | | | | | | |
| KXSILVER15M — filled | 676 | 0.094 | 5.8% | 0.042–0.078 | $-0.0366 | $-24.73 | -4.11 | -38.8% |
| KXSILVER15M — frictionless | 677 | 0.081 | 5.8% | 0.042–0.078 | $-0.0231 | $-15.63 | -2.59 | -28.6% |
| KXSILVER15M — notes | signals 677, unfillable 1 | avg slip vs mid $0.0079 | | | | | | |
| KXWTI15M — filled | 637 | 0.093 | 7.1% | 0.053–0.093 | $-0.0224 | $-14.30 | -2.25 | -24.1% |
| KXWTI15M — frictionless | 638 | 0.079 | 7.1% | 0.053–0.093 | $-0.0083 | $-5.28 | -0.83 | -10.5% |
| KXWTI15M — notes | signals 638, unfillable 1 | avg slip vs mid $0.0087 | | | | | | |

## How to read this

- The clustered calibration gap (+1.9 pts on BTC15M) is the ceiling; fills at the ask plus the per-order fee must clear it for the edge to be real.
- "Unfillable" = no adjacent next candle or degenerate next-open ask — those signals are dropped from the filled variant but kept in frictionless; a large gap between the two trade counts is itself evidence the dip state is fleeting.
- One trade per market keeps units independent; the t-stat is honest at market granularity but adjacent 15-min windows still share volatility regimes.
- Candle opens are the first trade/quote state of the minute, not a guaranteed resting quote; live fills could be worse. Depth is unknown until the order-book collector runs.

