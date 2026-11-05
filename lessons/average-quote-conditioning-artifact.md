# Comparing outcomes to an AVERAGE quote manufactures phantom edges

A calibration cell that pools many quote observations per market and compares
realized frequency to the mean quoted price can show a large, "clustered,
z=4.7" gap that no trade can capture — because the average of a market's quotes
over a state window is not a price anyone was ever offered.

How it bit (2026-08-28): BTC15M markets that dipped to ≤15¢ with 2–5 min left
showed realized 6.7% vs mean quoted 4.8% across 2,830 independent markets. The
implementable rule — buy at the FIRST touch, filled at the next minute's open
ask — showed mean cost 6.8¢ vs the same 6.7% win rate: exactly priced at the
trigger, −10% on risk after spread+fees. Markets that later dipped deeper
dragged the *average* down; the outcome never had to beat the average, only
the first touch.

Rule: any candidate edge from calibration-style aggregation must be restated as
an executable trigger (entry at a specific quote that existed at decision time,
next-tick fill, exact fees) before it is reported as an edge. The clustered
z-score ranks candidates; only the fill-level backtest declares one real.
