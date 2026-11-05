# Commodities settle on ONE candle close; crypto settles on a 60-second average

Kalshi KXGOLD15M/KXSILVER15M resolve on the close price of a single 1-minute Pyth candle. KXBTC15M/KXBTC resolve on the simple average of 60 per-second BRTI values. Verified from live rules_primary text on settled markets, 2026-08-27.

Why it mattered: a point-in-time settlement stays uncertain until the final second, so probabilities do not converge toward 0/1 near expiry the way an averaged contract's do. Any fair-value model must branch on which settlement rule applies; using one formula for both is a modelling error, not a simplification.
