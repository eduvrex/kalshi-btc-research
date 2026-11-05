# Settlement = 60s average of BRTI before close_time, not at expiration time

All Kalshi crypto contracts settle on the simple average of the 60 per-second BRTI values in the minute before the market's close_time, rounded to the nearest 2 decimals. The market object's expected_expiration_time is ~5 minutes after close_time — that is when the determination is recorded, not when the price is measured. The 15-min series (KXBTC15M) compares the 60s average before close vs the 60s average before open (floor_strike = open reference, strike_type greater_or_equal, "at least" = ≥).

Why it mattered: fair-value models and the proxy-calibration query must window on [close_time - 60s, close_time). Using expiration time would silently shift the window 5 minutes late. Also: the averaging window means the last minute of each contract's life has a partially-known settlement value, so the effective remaining variance shrinks faster than calendar time inside that window.
