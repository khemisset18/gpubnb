# GPUbnb Data Plane — SLO and Release Gates

These are engineering release criteria, not marketing promises. They apply to the dedicated data-plane rollout and are evaluated separately from booking/payment availability.

## User-facing SLIs

### Interactive connection success

A Developer attempt is successful only when all of the following occur for the same authenticated session:

1. runtime service is ready;
2. transport is established;
3. VS Code Management is established;
4. VS Code ExtensionHost is established;
5. the workbench becomes interactive.

HTML delivery alone is not success.

### Initial targets

| SLI | Canary gate | Promotion target |
|---|---:|---:|
| Interactive connection success | >= 99.0% | >= 99.5% |
| p50 time from Open Developer to INTERACTIVE | <= 1.5 s after runtime ready | <= 1.0 s |
| p95 time from Open Developer to INTERACTIVE | <= 4.0 s after runtime ready | <= 2.5 s |
| p99 time from Open Developer to INTERACTIVE | <= 8.0 s after runtime ready | <= 5.0 s |
| Abnormal transport closes during first 10 min | < 0.5% | < 0.2% |
| Frame/control corruption | 0 | 0 |
| Unauthorized stream opens | 0 | 0 |
| Unbounded queue events | 0 | 0 |
| Successful direct→edge fallback when policy permits | >= 99% | >= 99.9% |
| Edge failover within resume window | >= 99% | >= 99.9% |

Targets are revised only through an ADR with production evidence. Tests must never be weakened merely to make a release pass.

## Host admission thresholds for interactive Developer

A Host is not advertised as interactive-ready when any current network probe exceeds:

- RTT > 180 ms to all eligible Edges;
- jitter > 35 ms;
- packet loss > 1%;
- upload < 10 Mbps;
- download < 25 Mbps;
- tunnel probe uptime < 99%;
- computed quality score < 70/100.

A Host can remain eligible for non-interactive workloads even when Developer admission fails.

## Error budget behavior

- Fast burn: if the 1-hour connection failure rate exceeds 5x the allowed budget, stop increasing canary immediately.
- Critical burn: authentication bypass, cross-session routing, byte corruption, arbitrary Host/LAN access or billing activation without interactive proof triggers immediate rollback regardless of aggregate availability.
- Slow burn: repeated SLO misses across a 24-hour window block promotion to the next canary stage.

## Canary stages

`shadow telemetry → 1% → 5% → 25% → 50% → 100%`

A stage may advance only when:

- minimum sample size is reached;
- all critical invariants remain zero-failure;
- SLO gates hold for the required observation window;
- no unresolved P0/P1 transport issue exists;
- rollback has been exercised in qualification.

The control plane stores the selected transport per attempt so comparisons are attributable.

## Rollback

Rollback disables selection of the failing transport for **new stream establishments**. Existing healthy sessions may drain unless the incident is security-critical. The next safe transport is selected according to policy.

Rollback must not require:

- a Host installer downgrade;
- a renter action;
- a database migration rollback.

## Required telemetry

Per connection/session, without renter payloads:

- opaque session/machine/edge IDs;
- selected transport and selection reason;
- protocol version;
- handshake duration;
- RTT/jitter/loss probe summary;
- time to Management ready;
- time to ExtensionHost ready;
- time to INTERACTIVE;
- stream open/close code;
- reconnect/fallback count and reason;
- bytes in/out by stream class;
- current/peak buffered bytes;
- QUIC transport close category;
- legacy fallback usage.

## Qualification before production

At minimum:

- unit/property tests for parsing, limits and policy;
- repeated workspace soak with zero flakes;
- real Chrome Management + ExtensionHost smoke;
- fault injection: latency, packet loss, reorder where applicable, 429/backpressure, Edge restart, Host reconnect, control-plane temporary outage;
- 60-minute interactive soak;
- large file transfer concurrent with terminal/ExtensionHost activity;
- fresh Windows installer and service validation;
- two-machine physical test;
- rollback drill.

A release that has not completed these gates is a candidate, not a promoted release.
