# A naive ceil() on the Kalshi fee formula overcharges by a cent at three price points

7 * 0.10 * 0.90 * 100 evaluates to 63.00000000000001 in IEEE754, so Math.ceil turns the official $0.63 per 100 contracts into $0.64. Same failure at P=0.20 and P=0.40. Fix: `Math.ceil(cents - 1e-9)`. The epsilon is safe — it is 6e-12 relative on a value that never exceeds 175.

Why it mattered: the bug was present in fit-and-backtest.js and survived an earlier hand-written test because that test happened to sample only 0.05, 0.30, 0.35, 0.50 and 0.99, all of which round correctly by luck. It was caught only when the fee function was checked against every row of the published fee table. Lesson: for anything with a published reference table, test against the whole table, not a spot check — and a rounding error of one cent per contract is 1.6% of a 63-cent-per-100 fee, which is exactly the size of effect this project measures.
