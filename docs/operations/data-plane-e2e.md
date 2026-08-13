# Data-plane QUIC E2E gate

The `data-plane-edge` workflow includes a loopback E2E test that exercises the real TypeScript authority issuer and the real Rust QUIC Edge process.

The gate proves, in order:

1. a freshly signed Edge-scoped authority is accepted over QUIC/TLS using ALPN `gpubnb-dp/1`;
2. immediate reuse of that same authority is rejected;
3. reconnect with a newly issued authority succeeds;
4. the Edge process is stopped and restarted using the same durable replay directory;
5. an authority consumed before restart is still rejected after restart;
6. another freshly issued authority succeeds after restart;
7. a replay-rejection security event is emitted without persisting bearer material.

All keys, certificates, authority envelopes and replay state are generated inside the CI runner and removed at job exit. This test is a production-routing gate only; it does not enable `DIRECT_QUIC` or `EDGE_QUIC` traffic.
