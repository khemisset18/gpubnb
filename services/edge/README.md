# GPUbnb Edge

`services/edge` is the isolated core of the regional GPUbnb data plane.

## Runtime contract

The production Edge service will expose separate listeners:

- QUIC/UDP data-plane listener using ALPN `gpubnb-dp/1`;
- HTTPS health/readiness/admin listener bound separately from renter traffic;
- browser ingress listener (WebSocket initially; WebTransport only after capability qualification).

The Edge must never use Redis as a renter-byte transport. Redis/Postgres may be consulted by the control plane for authorization/discovery, but once a session binding is accepted, byte forwarding stays inside bounded in-memory/QUIC flow control.

Each authority is signed for one `GPUBNB_EDGE_ID`. That identifier is an Edge-instance security scope, not a shared region alias. Two concurrently routable processes must not use the same Edge ID unless they also share the exact same durable replay store with filesystem semantics that preserve atomic `create_new` behavior.

## Authority replay store

Before an authenticated session can enter the Edge registry, its signed nonce is committed to a durable local replay store. The runtime requires:

- `GPUBNB_EDGE_REPLAY_DIR`: a pre-created, writable directory on storage that survives process/container restart for the lifetime of issued authorities;
- `GPUBNB_EDGE_REPLAY_CACHE_CAPACITY`: optional hard ceiling for live/quarantined markers (default `100000`, maximum `1000000`);
- one marker file per consumed nonce, created atomically and synchronized before session admission;
- expired markers reclaimed deterministically;
- malformed/partial marker contents quarantined rather than deleted, so uncertain crash state remains fail-closed;
- replay-store write/sync/cleanup failures reject new authorities instead of falling back to in-memory-only protection.

The replay directory must not be ephemeral container storage in production. Loss, replacement or rollback of this directory reopens the same-Edge replay window and therefore invalidates production readiness until all previously issued authorities have expired and the incident has been handled according to the runbook.

## Lifecycle

- `STARTING`: process is booting; not routable.
- `READY`: certificates/config/control-plane verification dependencies and the durable replay store are available.
- `DRAINING`: no new sessions; existing sessions may finish or migrate.
- `DEGRADED`: can serve existing sessions but must not be selected for new ones.
- `STOPPING`: close listeners, bounded drain, terminate.

Readiness is false while the Edge cannot verify new session authority or durably persist replay state.

## Isolation

Every connection is associated with an opaque session binding. A stream belongs to exactly one session. Session registry keys cannot be shared across renters. Closing one session releases its own stream and buffered-byte budgets without affecting other sessions.

## Required limits

The current core starts with conservative defaults and every production value is externally configurable within hard safety ceilings:

- max sessions per process;
- max streams per session;
- max buffered bytes per stream/session/process;
- handshake/control metadata size;
- authority replay-store entries;
- idle and absolute session lifetime;
- reconnect/resume window;
- connection attempts per source/identity;
- APP_PORT allow-list size.

No limit may be disabled with `0`, `-1`, `Infinity` or equivalent unbounded configuration.

## Observability

Metrics/logs use opaque identifiers and never renter payloads, signatures, authority nonces or bearer material:

- active connections/sessions/streams;
- connections accepted/rejected by reason;
- authority replay rejection, replay-store saturation and persistence failures;
- replay-store live/quarantined marker counts at startup;
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
- read-only filesystem except the explicitly mounted replay-state volume and bounded runtime scratch if required;
- replay-state volume must survive process/container replacement and must never be restored from an older snapshot while live authorities may exist;
- no Docker socket;
- no cloud metadata access from renter streams;
- minimal outbound ACL: control-plane verification/telemetry only;
- TLS key material supplied by secret manager, never committed;
- graceful drain before rollout/termination;
- at least two independent Edge instances before production canary above 5%.

## Development sequence

The crate contains the session/stream/quota state machine, authenticated QUIC adapter and authority replay protection. The next qualification layers are explicit QUIC transport resource/time-out policy, Host outbound registration/tunneling, browser ingress mapping and end-to-end Management + ExtensionHost tests. Network code must call the core rather than implementing authorization/limits independently in socket handlers.
