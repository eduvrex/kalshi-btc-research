# Conditional calibration — index says one thing, quotes say another

Generated 2026-08-29T00:17:35.189Z. Usable rows: 82669. Final 2 minutes of each market excluded by construction of model_rows.

z = proxy distance above strike in remaining-volatility units. Φ(z) = martingale fair value. "Disagreement" cells are the exact state Eduardo described: z > 0 while the quoted mid is below 0.50 (and the mirror). "EV taking index side" = buy YES at the quoted ask (or NO at 1 − bid) with exact taker fees.

Disagreement states found: **3592** of 82669 rows (4.3%). If this number is near zero, the phenomenon is rarer than remembered — that is itself a finding.

## Panel 1 — index above strike, market below 50c (buy-YES candidate)

Reading: if "realized" tracks "quoted mid", the book knew better (latency or reversion — no edge buying YES). If "realized" tracks "model fair Φ(z)", the quotes were wrong and EV should be positive.

| cell | n | markets | quoted mid | model fair Φ(z) | realized YES | 95% CI | EV taking index side |
| --- | --- | --- | --- | --- | --- | --- | --- |
| z 0–0.05 (within proxy noise) | 630 | 550 | 0.467 | 0.509 | 0.467 | 0.428–0.506 | $-0.0230 |
| z 0.05–0.15 | 525 | 451 | 0.464 | 0.536 | 0.493 | 0.451–0.536 | +$0.0071 |
| z 0.15–0.35 | 335 | 270 | 0.450 | 0.591 | 0.457 | 0.404–0.510 | $-0.0161 |
| z 0.35–0.75 | 135 | 88 | 0.440 | 0.689 | 0.422 | 0.342–0.507 | $-0.0398 |
| z 0.75–8 | 51 | 33 | 0.397 | 0.868 | 0.627 | 0.490–0.747 | +$0.2082 |

## Panel 2 — mirror: index below strike, market above 50c (buy-NO candidate)

| cell | n | markets | quoted mid | model fair Φ(z) | realized YES | 95% CI | EV taking index side |
| --- | --- | --- | --- | --- | --- | --- | --- |
| z −0.05–−0 | 648 | 559 | 0.533 | 0.491 | 0.477 | 0.439–0.515 | +$0.0336 |
| z −0.15–−0.05 | 693 | 566 | 0.534 | 0.463 | 0.505 | 0.468–0.542 | +$0.0065 |
| z −0.35–−0.15 | 369 | 292 | 0.545 | 0.411 | 0.558 | 0.507–0.608 | $-0.0361 |
| z −0.75–−0.35 | 153 | 109 | 0.562 | 0.316 | 0.608 | 0.529–0.682 | $-0.0680 |
| z −8–−0.75 | 53 | 26 | 0.641 | 0.172 | 0.774 | 0.645–0.865 | $-0.1532 |

## Panel 3 — agreement baseline (index above strike, market 50–60c)

Sanity check: in the normal state, realized should sit close to both the quoted mid and Φ(z). If it does not, the proxy or the pipeline is broken and Panels 1–2 should not be trusted.

| cell | n | markets | quoted mid | model fair Φ(z) | realized YES | 95% CI | EV taking index side |
| --- | --- | --- | --- | --- | --- | --- | --- |
| z 0–0.05 | 923 | 787 | 0.532 | 0.510 | 0.504 | 0.472–0.536 | $-0.0505 |
| z 0.05–0.15 | 2196 | 1675 | 0.542 | 0.540 | 0.556 | 0.536–0.577 | $-0.0085 |
| z 0.15–0.35 | 3163 | 2133 | 0.561 | 0.593 | 0.575 | 0.558–0.592 | $-0.0087 |
| z 0.35–0.75 | 1158 | 864 | 0.570 | 0.680 | 0.599 | 0.571–0.627 | +$0.0072 |
| z 0.75–8 | 147 | 108 | 0.569 | 0.832 | 0.748 | 0.672–0.812 | +$0.1569 |

## Panel 4 — freshness split inside Panel 1 (isolates the reversion explanation)

"Fresh" = the index moved up by ≥ 0.15 remaining-volatility units over the prior exactly-2 minutes, measured at the current horizon so pure time decay never counts as a spike; "drift" = it did not. If manipulation-decay is what the market is pricing, realized should be markedly lower in the fresh rows than the drift rows.

| cell | n | markets | quoted mid | model fair Φ(z) | realized YES | 95% CI | EV taking index side |
| --- | --- | --- | --- | --- | --- | --- | --- |
| fresh spike into above | 262 | 229 | 0.454 | 0.587 | 0.500 | 0.440–0.560 | +$0.0236 |
| drifted above | 581 | 416 | 0.445 | 0.603 | 0.461 | 0.421–0.502 | $-0.0063 |

## Caveats

- The proxy is Coinbase+Kraken spot, not BRTI itself. The z 0.00–0.05 bucket is labelled "within proxy noise" and should be ignored; check the data-quality report's proxy-vs-settlement residuals to know how far up the z scale noise reaches.
- Historical quotes are 1-minute candle closes. The book state and the index state are aligned only to the minute; a fast dislocation that appeared and vanished within a minute is invisible here. Live collectors close this gap.
- Rows within one market share an outcome, so n overstates the effective sample; the "markets" column is the honest denominator for significance judgements.
- One-tick books (Eduardo's observation) cannot be confirmed here — candle bid/ask closes may straddle more than the instantaneous spread. The live book collector records the actual spread.

