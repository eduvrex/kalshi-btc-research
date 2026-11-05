'use strict';

// Monte Carlo fair value for a 15-minute up/down window, by block bootstrap
// of recent EMPIRICAL 1-second returns — no distributional assumption, fat
// tails and short-range dependence come along for free, and the 60-second
// settlement averaging is simulated exactly rather than approximated.
//
//   paths:  S_{t+1} = S_t · exp(r),  r drawn in BLOCK_S-second blocks from
//           the trailing return sample
//   settle: mean of the final SETTLE_AVG_S seconds of each path
//   fair:   share of paths with settle ≥ strike;  SE = √(p(1−p)/N)
//
// Analytic counterpart: Φ( ln(S/K) / (σ√(τ−2D/3)) ) — exact under GBM only.

const SETTLE_AVG_S = 60;
const BLOCK_S = 15;

// returns: array of per-second log returns (dt-normalized upstream if gappy).
function mcFair({ price, strike, secsLeft, returns }, nPaths = 1500) {
  if (!(price > 0) || !(strike > 0) || returns.length < 300) return null;
  const horizon = Math.max(Math.round(secsLeft), 1);
  // De-mean: a fair value is a martingale quantity. Bootstrapping raw returns
  // smuggles the sample-window drift into every path — a +16bps trend over the
  // trailing 30 min extrapolated over 850s once produced "99.5% fair" against
  // a 50c market (caught by trade audit 2026-08-28). Center to zero drift;
  // the empirical SHAPE (fat tails, clustering) is what MC is here for.
  const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
  returns = returns.map((v) => v - mean);
  const nRet = returns.length;
  let hits = 0;
  const logK = Math.log(strike / price);
  for (let p = 0; p < nPaths; p++) {
    let x = 0; // cumulative log return
    let t = 0;
    let settleSum = 0;
    let settleN = 0;
    const settleStart = horizon - Math.min(SETTLE_AVG_S, horizon);
    while (t < horizon) {
      const start = (Math.random() * nRet) | 0;
      const end = Math.min(start + BLOCK_S, nRet);
      for (let i = start; i < end && t < horizon; i++, t++) {
        x += returns[i];
        if (t >= settleStart) {
          // average in price space: accumulate exp(x) relative to strike via
          // log-sum trick is overkill; exp per settle-second only (≤60/path)
          settleSum += Math.exp(x);
          settleN += 1;
        }
      }
    }
    if (settleN > 0 && Math.log(settleSum / settleN) >= logK) hits += 1;
  }
  const p = hits / nPaths;
  return { p, se: Math.sqrt(p * (1 - p) / nPaths), nPaths };
}

module.exports = { mcFair };
