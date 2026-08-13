# GPUbnb Data Plane — QUIC stream-credit lifecycle

This note records the production invariant behind Data Plane v1 stream admission.

- Application capacity remains hard-bounded at **64 workspace streams per session** by `EdgeRegistry`.
- QUIC advertises **75 client-initiated bidirectional stream credits**: 64 workspace streams, 1 one-shot authority/control stream, and 10 bounded replenishment credits.
- The transport reserve does **not** increase renter workspace capacity. It exists so explicit over-capacity rejection and normal stream churn can continue while Quinn batches cumulative stream-credit updates.
- The 65th workspace attempt must reach application admission and receive `STREAM_LIMIT`; a transport timeout is not accepted as proof of rejection.
- After an explicit application rejection, the request side may finish normally or receive a clean transport stop with code zero because the Edge no longer needs request-body bytes. Any other stop code fails qualification.
- For accepted routed streams, application capacity is released only after both relay directions complete and the Edge response FIN is acknowledged.
- Production qualification rotates ten streams while keeping the application ceiling at 64, proving that transport credit is replenished under churn rather than relying on immediate per-stream credit updates.

These invariants are enforced by the Rust transport configuration, the real Edge/Host E2E qualification client, and `services/edge/ci/production-qualification.sh`.
