# GPUbnb Data Plane — Threat Model v1

## Security objective

A renter may reach only the runtime resources explicitly granted by an active booking. A Host must not expose its LAN, Docker daemon, filesystem, credentials or arbitrary ports. A relay must be unable to forge booking authority. A compromised or slow peer must not exhaust shared infrastructure.

## Trust boundaries

1. Browser/native renter client — untrusted.
2. GPUbnb control plane — trusted issuer of short-lived session authority.
3. Regional Edge relay — trusted to enforce routing/limits, not trusted with long-lived Host secrets.
4. Host Agent/Host Desktop — trusted execution boundary on provider machine.
5. Workspace container/code-server — isolated workload boundary; not trusted with Host privileges.
6. Redis/Postgres — control metadata only; renter byte transport must not depend on Redis once Edge QUIC is selected.

## Mandatory controls

### Authentication and authorization

- Session bindings are short-lived, scoped to `sessionId + machineId + bookingId + renterUserId + protocolVersion`.
- Bindings are cryptographically authenticated by the control plane.
- Every stream open is authorized against the session policy.
- `APP_PORT` requires an explicit allow-list; loopback/container destinations only in v1.
- No raw Host IP or LAN address is returned to browser clients unless a direct-mode policy explicitly permits it.
- Expired/revoked sessions fail closed.

### Replay and confused-deputy resistance

- High-entropy per-binding nonce.
- Control commands use monotonic stream/session sequence numbers where replay has side effects.
- Resume never replays an unauthenticated control mutation.
- Edge cannot widen the booking scope supplied by the control plane.

### Resource exhaustion

- Connection, session, stream, frame, control-message, buffered-byte and reconnect budgets are finite.
- Per-session quotas are enforced before allocation where possible.
- Backpressure propagates to the producer; no unbounded Promise, Redis or socket queue.
- Authentication failures and malformed frames are rate-limited and cheap to reject.
- File-transfer bandwidth can be deprioritized relative to interactive streams.

### Host isolation

- Host tunnel is outbound by default.
- Workspace runtime remains loopback/container scoped.
- No Docker socket bind mount into renter workloads.
- No direct Host filesystem mounts by default.
- Arbitrary LAN RFC1918/ULA/link-local targets are forbidden.
- DNS rebinding is avoided by resolving and validating destinations at the Host boundary when hostname support is introduced.

### Confidentiality and integrity

- Host↔Edge QUIC uses TLS 1.3.
- Direct mode uses authenticated QUIC as well.
- Long-lived private keys are not embedded in session tokens.
- Logs never contain renter terminal/file/workspace payloads, bearer tokens or raw session secrets.

### Availability and abuse containment

- A bad session can be closed independently without dropping unrelated sessions.
- An Edge may drain before maintenance; new sessions stop selecting it before existing sessions are terminated.
- Circuit breakers prevent retry storms against failed edges/control-plane endpoints.
- Reconnect uses exponential backoff with jitter and an upper bound.

## Threat scenarios and required behavior

| Scenario | Required behavior |
|---|---|
| Stolen expired session binding | Reject before stream allocation |
| Renter requests Host port 2375/2376 | Reject `APP_PORT` unless explicitly policy-allowed; never expose Docker daemon |
| Client sends oversized stream metadata | Reject connection/stream without allocation growth |
| Browser stops reading | Apply backpressure, then close only that stream/session at bounded thresholds |
| Edge receives duplicate resume/control message | Idempotent result; no duplicated billing/control side effect |
| Host changes IP/NAT mapping | Re-establish outbound tunnel; direct mode may fall back to Edge |
| Edge disappears | Select healthy secondary; preserve booking identity; resume only within bounded window |
| Redis outage | Existing Edge data streams continue; control-plane operations degrade independently |
| Control plane outage | Existing authorized streams survive only within token/session policy; no new authority minted |
| Workspace container compromised | No Host/LAN/Docker access beyond explicit proxy targets |

## Release blockers

A data-plane release cannot be promoted when any of the following are unresolved:

- unbounded queue or allocation path;
- unauthenticated stream open;
- arbitrary Host/LAN dial path;
- replayable billing/control transition;
- raw session secret or renter payload in logs;
- missing rollback/circuit-breaker path;
- transport selection that can silently bypass policy;
- failure to prove Management + ExtensionHost readiness for Developer.
