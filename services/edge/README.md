# GPUbnb Edge

`services/edge` is the isolated core of the regional GPUbnb data plane.

## Runtime contract

The production Edge service will expose separate listeners:

- QUIC/UDP data-plane listener using ALPN `gpubnb-dp/1`;
- HTTPS health/readiness/admin listener bound separately from renter traffic;
- browser ingress listener (WebSocket initially; WebTransport only after capability qualification).

The Edge must never use Redis as a renter-byte transport. Redis/Postgres may be consulted by the control plane for authorization/discovery, but once a session binding is accepted, byte forwarding stays inside bounded in-memory/QUIC flow control.

## Lifecycle

- `STARTING`: process is booting; not routable.
- `READY`: certificates/config/control-plane verification dependencies are available.
- `DRAINING`: no new sessions; existing sessions may finish or migrate.
- `DEGRADED`: can serve existing sessions but must not be selected for new ones.
- `STOPPING`: close listeners, bounded drain, terminate.

Readiness is false while the Edge cannot verify new session authority.

## Isolation

Every connection is associated with an opaque session binding. A stream belongs to exactly one session. Session registry keys cannot be shared across renters. Closing one session releases its own stream and buffered-byte budgets without affecting other sessions.

## Required limits

The current core starts with conservative defaults and every production value is externally configurable within hard safety ceilings:

- max sessions per process;
- max streams per session;
- max buffered bytes per stream/session/process;
- handshake/control metadata size;
- idle and absolute session lifetime;
- reconnect/resume window;
- connection attempts per source/identity;
- APP_PORT allow-list size.

No limit may be disabled with `0`, `-1`, `Infinity` or equivalent unbounded configuration.

## Observability

Metrics/logs use opaque identifiers and never renter payloads:

- active connections/sessions/streams;
- connections accepted/rejected by reason;
- handshake latency;
- RTT and congestion statistics;
- bytes by stream kind;
- current/peak buffered bytes;
- backpressure events;
- reconnect/resume/fallback events;
- Management/ExtensionHost readiness latency;
- abnormal close categories;
- per-region capacity and drain state.

## Deployment requirements

- run as non-root;
- read-only filesystem except explicit runtime scratch if required;
- no Docker socket;
- no cloud metadata access from renter streams;
- minimal outbound ACL: control-plane verification/telemetry only;
- TLS key material supplied by secret manager, never committed;
- graceful drain before rollout/termination;
- at least two independent Edge instances before production canary above 5%.

## Development sequence

The crate currently contains the session/stream/quota state machine. The network adapter is intentionally the next layer. QUIC code must call this core rather than implementing authorization/limits independently in socket handlers.
