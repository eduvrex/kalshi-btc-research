# Settled 15-min markets leak official BRTI values — free ground truth every 15 minutes

Each settled KXBTC15M market carries expiration_value (official 60s-avg BRTI at close) and floor_strike (official 60s-avg BRTI at open), and they chain: window N's strike equals window N−1's settlement. Verified live 2026-06-12 (13:00 market strike 61955.16 = 12:45 market's expiration_value). Backfilling settled markets therefore yields an official BRTI series at 15-min cadence ~90 days back at zero cost.

Why it mattered: backtest outcomes and strikes are exact official numbers — proxy error only affects intra-window features, not labels. Also calibrates our live composite proxy. Don't pay for historical BRTI until proven necessary.
