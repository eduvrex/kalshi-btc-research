# Pre-flight code review — 2026-08-28

Five parallel reviewers audited the never-run code (research scripts, Kalshi WS
collector, spot downloader) against the live schema, NOTES.md, and official API
docs; every finding was then adversarially verified by an independent agent
told to refute it. 22 raw findings → **21 confirmed, 1 refuted**. All 21
confirmed defects are fixed; `node --check` passes on every touched file and
`test/math.test.js` passes (now 27 checks, two new ones covering the tauEff
formula). None of these had corrupted any collected data: the collector had
never run, spot download and dataset builds had not started, and calibration
had only produced throwaway smoke output.

## Fixed — would have corrupted or crashed the decisive artifacts

| where | defect | consequence if unfixed |
| --- | --- | --- |
| calibration.js | hour panel used session-TZ hours labeled as UTC | "which session misprices" off by 6–7h |
| calibration.js | full candle join materialized in memory | OOM crash once KXBTC candles land (~20M rows) — now chunked per series×3 days |
| calibration.js | late_ask included the post-close 1.00 placeholder candle | late-ask column always 1.000 (dead) |
| calibration.js | z from realized-frequency SE | k=0/k=n cells — the strongest tail miscalibrations — never flagged |
| collector-kalshi | seq gap check per market; counter is per sid | false-gap storm + get_snapshot flood; real gaps invisible |
| collector-kalshi | book keyed by raw price strings | width mismatch snapshot-vs-delta silently corrupts books |
| collector-kalshi | gapped/disconnected books kept persisting | outages recorded as "quiet book" with live timestamps |
| collector-kalshi | delete_markets fallback re-subscribed dead markets | zombie books persisted forever |
| collector-kalshi | one failed discovery fetch tore down a whole series | multi-30s capture holes in volatile periods |
| collector-kalshi | add_markets given no snapshot request | rolled 15-min markets could collect zero data silently |
| spot downloader | boundary seconds written partial + DO NOTHING | permanently wrong 1s bars feeding settlement math — now second-aligned cursors + replace-on-conflict |
| spot downloader | Coinbase newest_ts stamped Date.now(), no forward path | permanent multi-hour hole at the newest end — now honest stamps + top-up mode |
| build-dataset.js | composite averaged whichever venues had a trade | venue-basis square waves inflate sigma — now forward-filled, full-membership only |
| build-dataset.js + monitor | tauEff = τ−D/2 | correct variance is τ−2D/3; z understated up to ~6% at short τ (test added) |
| conditional-calibration.js | freshness = z − lag(z,2) | pure time decay classified as "fresh spike", biasing Panel 4 against the manipulation-decay signature — now actual index movement at fixed horizon, exact-120s aligned |
| fit-and-backtest.js | model-vs-market Brier over different row subsets | headline comparison could point the wrong way |
| fit-and-backtest.js | amortised fee labeled "per single contract" | tail-price fees understated 1.6–14× at 1-lot — order-size now explicit |
| fit-and-backtest.js | single-day dataset → empty train set | all-NaN report passing the row-count guard |
| data-quality.js | proxy residual joined every series + all hourly strikes | commodity rows (~10^5 error) + 188× pseudo-replication destroying the acceptance metric — now KXBTC15M only |

## Refuted (no change made)

- "Server error replies leave a connected-but-dataless state" — the verifier
  judged the failure path not reachable as claimed; the defensive liveness
  watchdog and code-25 reconnect were kept anyway (harmless, cover adjacent
  real stall modes).
