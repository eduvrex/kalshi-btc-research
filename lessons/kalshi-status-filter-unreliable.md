# GET /markets?status=open can return long-dead markets

A markets query with status=open for KXBTC15M on 2026-06-12 returned a market whose close_time was two weeks past, still marked status "active" (likely stuck pending settlement review). Filter by close_time/open_time, never trust the status field alone for "currently tradeable".

Why it mattered: the collector's discovery loop would otherwise subscribe to dead markets and count them as active coverage.
