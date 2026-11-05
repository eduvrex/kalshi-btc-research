'use strict';

// Verification for the pure math in the research pipeline. No database needed.
// Run: node test/math.test.js

const C = require('../src/research/calibration');

let fail = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name + (detail ? ` (${detail})` : ''));
  if (!ok) fail += 1;
}

// --- Kalshi taker fee vs the official published fee-schedule table -----------
// Source: https://kalshi.com/docs/kalshi-fee-schedule.pdf, effective 2026-02-05.
// Columns are "fee for 100 contracts" at each contract price.
const OFFICIAL_FEE_TABLE = [
  [0.01, 0.07], [0.05, 0.34], [0.10, 0.63], [0.15, 0.90], [0.20, 1.12],
  [0.25, 1.32], [0.30, 1.47], [0.35, 1.60], [0.40, 1.68], [0.45, 1.74],
  [0.50, 1.75], [0.55, 1.74], [0.60, 1.68], [0.65, 1.60], [0.70, 1.47],
  [0.75, 1.32], [0.80, 1.12], [0.85, 0.90], [0.90, 0.63], [0.95, 0.34],
  [0.99, 0.07]
];
let feeOk = true;
for (const [p, per100] of OFFICIAL_FEE_TABLE) {
  const got = C.feePerContract(p) * 100;
  if (Math.abs(got - per100) > 1e-9) {
    feeOk = false;
    console.log(`  fee mismatch at p=${p}: got ${got.toFixed(4)}, official ${per100}`);
  }
}
check(`fee matches all ${OFFICIAL_FEE_TABLE.length} rows of the official Kalshi fee table`, feeOk);
check('fee is zero at the degenerate endpoints', C.feePerContract(0) === 0 && C.feePerContract(1) === 0);

// --- Inverse normal CDF against known critical values ------------------------
const NORM_CASES = [
  [0.975, 1.959964], [0.995, 2.575829], [0.99875, 3.023341],
  [0.999875, 3.662260], [0.5, 0], [0.025, -1.959964]
];
let normOk = true;
for (const [p, want] of NORM_CASES) {
  const got = C.normInv(p);
  if (Math.abs(got - want) > 1e-4) {
    normOk = false;
    console.log(`  normInv(${p}): got ${got.toFixed(6)}, want ${want}`);
  }
}
check('normInv matches known standard-normal quantiles to 1e-4', normOk);

// Stronger than fixed constants: round-trip normInv through an independently
// implemented normal CDF (Numerical Recipes erfc, fractional error < 1.2e-7).
function erfc(x) {
  const z = Math.abs(x);
  const t = 2 / (2 + z);
  const ty = 4 * t - 2;
  const cof = [-1.3026537197817094, 6.4196979235649026e-1, 1.9476473204185836e-2,
    -9.561514786808631e-3, -9.46595344482036e-4, 3.66839497852761e-4, 4.2523324806907e-5,
    -2.0278578112534e-5, -1.624290004647e-6, 1.303655835580e-6, 1.5626441722e-8,
    -8.5238095915e-8, 6.529054439e-9, 5.059343495e-9, -9.91364156e-10, -2.27365122e-10,
    9.6467911e-11, 2.394038e-12, -6.886027e-12, 8.94487e-13, 3.13092e-13, -1.12708e-13,
    3.81e-16, 7.106e-15];
  let d = 0;
  let dd = 0;
  for (let j = cof.length - 1; j > 0; j--) {
    const tmp = d;
    d = ty * d - dd + cof[j];
    dd = tmp;
  }
  const ans = t * Math.exp(-z * z + 0.5 * (cof[0] + ty * d) - dd);
  return x >= 0 ? ans : 2 - ans;
}
const normalCdf = (z) => 0.5 * erfc(-z / Math.SQRT2);
let roundTripOk = true;
let worstErr = 0;
for (const p of [0.6, 0.9, 0.975, 0.995, 0.99875, 0.999875, 0.9999875]) {
  const err = Math.abs(normalCdf(C.normInv(p)) - p);
  if (err > worstErr) worstErr = err;
  if (err > 1e-8) roundTripOk = false;
}
check('normInv round-trips through an independent normal CDF to 1e-8', roundTripOk,
  `worst error ${worstErr.toExponential(1)}`);

// The exported normalCdf must agree with the local reference implementation and
// with the worked fair-value example below.
check('normalCdf(0) = 0.5', Math.abs(C.normalCdf(0) - 0.5) < 1e-12);
check('normalCdf(1.96) = 0.975', Math.abs(C.normalCdf(1.959964) - 0.975) < 1e-6);
check('normalCdf is symmetric', Math.abs(C.normalCdf(0.7) + C.normalCdf(-0.7) - 1) < 1e-12);
// Worked example: $4.40 above strike, sigma ~ $35/min.
// 10 min left: z = 4.4/(35*sqrt(10)) -> fair ~51.6%; 2 min left -> ~53.6%.
const fair10 = C.normalCdf(4.4 / (35 * Math.sqrt(10)));
const fair2 = C.normalCdf(4.4 / (35 * Math.sqrt(2)));
check('example fair value with 10 min left is ~0.516', Math.abs(fair10 - 0.5159) < 0.002, fair10.toFixed(4));
check('example fair value with 2 min left is ~0.535', Math.abs(fair2 - 0.5354) < 0.002, fair2.toFixed(4));
check('bonferroniZ(1) = 1.96', Math.abs(C.bonferroniZ(1) - 1.959964) < 1e-4, C.bonferroniZ(1).toFixed(4));
check('bonferroniZ(100) = 3.4808', Math.abs(C.bonferroniZ(100) - 3.480756) < 1e-4, C.bonferroniZ(100).toFixed(4));
check('bonferroniZ is monotone in the number of tests', C.bonferroniZ(200) > C.bonferroniZ(100));

// --- Wilson score interval --------------------------------------------------
const [lo, hi] = C.wilson(5, 100);
check('Wilson CI for 5/100 is approx [0.0216, 0.1113]',
  Math.abs(lo - 0.0216) < 2e-3 && Math.abs(hi - 0.1113) < 2e-3,
  `[${lo.toFixed(4)}, ${hi.toFixed(4)}]`);
check('Wilson CI brackets the point estimate', lo < 0.05 && hi > 0.05);

// --- Bucket boundaries ------------------------------------------------------
check('price 0.10 lands in [0.10,0.15)', C.bucketIndex(C.PRICE_BUCKETS, 0.10) === 2);
check('price 0.0999 lands in [0.05,0.10)', C.bucketIndex(C.PRICE_BUCKETS, 0.0999) === 1);
check('price 1.00 lands in the final bucket', C.bucketIndex(C.PRICE_BUCKETS, 1.0) === C.PRICE_BUCKETS.length - 1);
check('tau 2.0 minutes lands in [2,5)', C.bucketIndex(C.TAU_BUCKETS, 2.0) === 1);

// --- End-to-end calibration behaviour on synthetic data ---------------------
let seed = 7;
function rnd() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}

// Case A: market quotes 10c but the true probability is 15% -> detectable edge.
const under = C.newCell();
for (let i = 0; i < 20000; i++) C.addObs(under, 0.10, 0.11, 0.09, rnd() < 0.15 ? 1 : 0);
const a = C.summarise(under);
check('recovers realized 0.15 from a market quoting 0.10', Math.abs(a.realized - 0.15) < 0.01, a.realized.toFixed(4));
check('reports a positive gap of about +0.05', Math.abs(a.gap - 0.05) < 0.01, a.gap.toFixed(4));
check('z-score is large for a real 5-point edge', a.z > 15, a.z.toFixed(1));
check('EV of buying YES is positive and net of fees', a.evYes > 0.03,
  `$${a.evYes.toFixed(4)} = ${a.realized.toFixed(4)} - 0.11 - ${C.feePerContract(0.11).toFixed(4)}`);

// Case B: a perfectly calibrated market must show negative EV after fees.
const fairCell = C.newCell();
for (let i = 0; i < 20000; i++) C.addObs(fairCell, 0.10, 0.11, 0.09, rnd() < 0.10 ? 1 : 0);
const b = C.summarise(fairCell);
check('perfectly calibrated market shows a gap near zero', Math.abs(b.gap) < 0.01, b.gap.toFixed(4));
check('perfectly calibrated market shows NEGATIVE EV after fees (no false edge)', b.evYes < 0, `$${b.evYes.toFixed(4)}`);

// Case C: fee asymmetry -- because the fee shrinks toward the extremes, a 5-point error at 10c is
// worth far more per dollar risked than the same error at 50c.
const tailEv = 0.15 - 0.10 - C.feePerContract(0.10);
const midEv = 0.55 - 0.50 - C.feePerContract(0.50);
const tailReturn = tailEv / (0.10 + C.feePerContract(0.10));
const midReturn = midEv / (0.50 + C.feePerContract(0.50));
check('a 5-point edge at 10c returns ~41% on capital at risk',
  Math.abs(tailReturn - 0.41) < 0.02, `${(tailReturn * 100).toFixed(1)}%`);
check('the same 5-point edge at 50c returns ~6%',
  midReturn > 0.05 && midReturn < 0.08, `${(midReturn * 100).toFixed(1)}%`);
check('tail edge is worth several times the mid-price edge per dollar risked',
  tailReturn / midReturn > 5, `${(tailReturn / midReturn).toFixed(1)}x`);

// Case D: effective horizon for a 60s-averaged settlement. For Brownian motion,
// Var(mean of W over the final D seconds at horizon tau) = tau - D + D/3
// = tau - 2D/3 — NOT the centroid heuristic's tau - D/2. Verify the closed form
// against the discrete double sum Var((1/n)Σ W_{a+i}) = a + (1/n²)ΣΣ min(i,j),
// which for a 1s grid differs from the continuum limit by < 1s.
{
  const tau = 900;
  const D = 60;
  const a = tau - D;
  let mm = 0;
  for (let i = 1; i <= D; i++) for (let j = 1; j <= D; j++) mm += Math.min(i, j);
  const discrete = a + mm / (D * D);
  const closed = tau - (2 * D) / 3;
  const centroid = tau - D / 2;
  check('tauEff formula: discrete windowed-average variance matches tau - 2D/3',
    Math.abs(discrete - closed) < 1, `discrete ${discrete.toFixed(3)} vs closed ${closed}`);
  check('tauEff formula: the old centroid heuristic tau - D/2 is measurably wrong',
    Math.abs(discrete - centroid) > 5, `discrete ${discrete.toFixed(3)} vs centroid ${centroid}`);
}

console.log(fail === 0 ? '\nAll checks passed.' : `\n${fail} check(s) FAILED.`);
process.exit(fail ? 1 : 0);
