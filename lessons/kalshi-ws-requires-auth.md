# Kalshi websocket requires authentication even for public market data

The REST market-data endpoints work unauthenticated, but the websocket handshake itself requires the RSA-signed headers — there is no anonymous stream. Verified in the official docs (Quick Start: WebSockets) on 2026-06-12.

Why it mattered: Phase 1 live depth collection cannot start without a Kalshi API key; REST polling is the only keyless fallback and burns rate-limit budget (~20 reads/s on Basic) for worse granularity.
