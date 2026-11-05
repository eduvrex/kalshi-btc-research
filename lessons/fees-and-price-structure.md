# Fee and tick-structure facts that bound any edge

Kalshi BTC series (both KXBTC15M and KXBTC) are fee_type quadratic, multiplier 1: taker fee = ceil_to_cent(0.07 × C × P × (1−P)) per order; maker fee is zero; no settlement fee. At P≈0.50 a taker pays ~1.75¢/contract (2¢ for a single contract due to per-order ceiling — small orders are proportionally worse). Round-trip taker-taker near mid costs ~3.5¢, so a signal must move the fair value ≥4¢ to clear costs taker-style; maker entry halves that but adds queue/adverse-selection risk. Price levels are tapered: $0.001 ticks in 0–10¢ and 90¢–100¢, $0.01 between. Polymarket crypto uses the same 0.07 quadratic taker formula but rounds to 5dp (no ceiling) and has zero maker fee with rebates.

Why it mattered: fee math decides whether any observed dislocation is tradeable; record it once, correctly, with sources (kalshi.com/docs/kalshi-fee-schedule.pdf, effective 2026-02-05; docs.polymarket.com/trading/fees).
