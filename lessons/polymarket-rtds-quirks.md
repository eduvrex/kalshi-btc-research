# Polymarket RTDS: filter format is a JSON string, and connect sends an empty frame

Two first-contact fixes to the RTDS leg of collector-prices (verified by
standalone probe 2026-08-27, three live connections):

1. `crypto_prices` subscriptions need `filters: '{"symbol":"btcusdt"}'` (a JSON
   object serialized as a string, same as the chainlink topic). The bare-string
   `filters: 'btcusdt'` form is accepted silently — you get the subscribe ack
   with a history snapshot — but **zero update frames ever arrive**. Silent
   partial failure: chainlink flowed, binance did not.
2. The server sends exactly one empty text frame (`""`) right after connect.
   JSON.parse on it throws "Unexpected end of JSON input". Skip empty frames
   alongside PING/PONG.

Also observed: the `subscribe` ack for crypto_prices carries `payload.data` =
~60s of per-second history (timestamp/value pairs) — harmlessly ignored today,
usable for gap-fill after reconnects if we ever care.
