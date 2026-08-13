# ADR-001 — GPUbnb Data Plane v1

Status: **Accepted for staged implementation**  
Owner: Platform / Networking  
Protocol version: `gpubnb-dp/1`

## Decision

GPUbnb separates the **control plane** (identity, booking, billing, policy, orchestration) from a dedicated **data plane** (interactive byte transport).

The existing HTTP/Redis workspace gateway remains a migration fallback only. New interactive traffic is introduced behind capability flags and follows this preference order:

1. `DIRECT_QUIC` — native client to Host when recent reachability verification proves a safe direct path.
2. `EDGE_QUIC` — client/edge + one persistent outbound Host/edge tunnel; default production target.
3. `LEGACY_GATEWAY` — bounded rollback path during migration.

No mode is silently selected when the Host network fails Developer admission thresholds.

## Why QUIC for Host ↔ Edge

The data plane needs independent ordered streams, encryption, congestion control, RTT visibility, connection migration primitives and avoidance of application-level Base64/HTTP polling for each interactive frame. QUIC supplies independent streams over one encrypted connection. The Rust Host will use a mature QUIC implementation behind an internal transport trait so the protocol is not coupled to one library API.

Browser WebTransport is deliberately **not** the initial dependency. It remains capability-gated until browser support and GPUbnb's own compatibility matrix meet release criteria. Initial browser traffic may terminate at the regional Edge over WebSocket while Edge↔Host already uses QUIC, eliminating Redis/HTTP from the byte path first.

## Topology

```text
                          CONTROL PLANE
 Browser / Native  ───►  API / Auth / Booking / Billing
                               │
                               │ short-lived signed session binding
                               ▼
                  ┌──────────────────────────┐
                  │   REGIONAL DATA PLANE    │
                  │                          │
 Client ─────────►│ Edge Relay EU/US/...     │◄──────── Host outbound QUIC
                  └──────────────────────────┘
                               │
                               └──── fallback only ─── Legacy Gateway
```

Direct mode removes the relay when policy and fresh reachability proof allow it.

## Stream model

One authenticated session can multiplex bounded streams:

- `CONTROL`
- `VSCODE_MANAGEMENT`
- `VSCODE_EXTENSION_HOST`
- `TERMINAL`
- `FILE_TRANSFER`
- `JUPYTER`
- `APP_PORT`

Each logical stream has independent flow control. Large file transfer traffic must never be allowed to consume the interactive control budget.

`APP_PORT` is the only stream kind that accepts an arbitrary target port. The target must still be authorized by session policy before the Host dials loopback/container networking.

## Session security

The control plane issues a short-lived session binding containing:

- protocol version;
- session ID;
- machine ID;
- booking ID;
- renter user ID;
- issue/expiry times;
- high-entropy nonce.

The binding is authenticated by the control plane and presented during data-plane establishment. Edge and Host must verify scope, expiry, protocol version and one-session ownership. A valid booking must never grant arbitrary Host network access.

Raw renter payloads are not logged. Data-plane logs contain only event name, opaque IDs, sizes, sequence counters, timing and short non-reversible diagnostic hashes when strictly necessary.

## Interactive readiness

`READY` does not mean billable or interactive.

The lifecycle is:

```text
ALLOCATED
IMAGE_PULLING
CONTAINER_STARTING
SERVICE_READY
TUNNEL_READY
MANAGEMENT_READY
EXTENSION_HOST_READY
INTERACTIVE
```

The session becomes `INTERACTIVE` only after both VS Code Management and ExtensionHost streams are healthy. Interactive billing remains tied to proven interactive traffic, never HTML delivery alone.

## Reliability model

- Host keeps an outbound persistent tunnel to at least one preferred Edge and may maintain a warm secondary Edge.
- Client transport selection is policy-driven and observable.
- Direct path failure may fall back to Edge without changing the booking identity.
- Edge failure may reconnect to another healthy Edge within the bounded resume window.
- Resume uses stream sequence information; duplicated control actions are idempotent.
- Per-session and per-stream byte/item budgets are mandatory.
- Backpressure slows producers; it must not create unbounded queues.

## Explicit non-goals for v1

- global anycast;
- arbitrary public inbound ports on residential Hosts;
- making WebTransport mandatory for browsers;
- removing the legacy gateway before canary evidence exists;
- zero-copy GPU networking.

## Migration sequence

1. Land protocol/policy contracts and test gates.
2. Build regional Edge relay prototype with Host outbound QUIC.
3. Add Host tunnel client behind `edgeQuicEnabled=false` default.
4. Mirror production connection telemetry without carrying renter bytes.
5. Canary internal sessions at 1%, then 5%, 25%, 50%, 100% only while SLO/error budgets hold.
6. Add native direct QUIC after reachability/NAT verification is mature.
7. Evaluate browser WebTransport independently.
8. Retire legacy data transport only after rollback has not been needed for a full qualification window.

## Rollback

Every new mode is capability- and server-flagged. Rollback is a control-plane decision: stop selecting the failing transport for new streams and route new sessions to the next safe mode. No installer downgrade is required to disable a new transport.
