# GPUbnb Data Plane — production transport qualification

Status: **required release gate**  
Applies to: `gpubnb-dp/1`, regional Edge relays, Host bootstrap, `EDGE_QUIC` / `DIRECT_QUIC` rollout  
Related: #95, #97, #98

## Non-negotiable release rule

A production build MUST NOT enable the Host Data Plane bootstrap, `EDGE_QUIC`, `DIRECT_QUIC`, browser WebTransport, or a non-zero data-plane canary merely by setting a feature flag.

For generic deployments the API requires both:

- `GPUBNB_RELEASE_SHA=<40-hex commit SHA>`
- `GPUBNB_DATA_PLANE_QUALIFIED_SHA=<same 40-hex commit SHA>`

On Render, the release identity is taken from Render's immutable deployment metadata `RENDER_GIT_COMMIT`. If `GPUBNB_RELEASE_SHA` is also supplied, it must match `RENDER_GIT_COMMIT`. The qualified SHA must still match the actual deployed commit.

If a new transport or Host bootstrap is requested and the release identity / qualified SHA is absent, malformed, or different, configuration fails closed. Qualification is therefore release-specific and cannot be carried silently across code changes.

`render.yaml` keeps every Data Plane production flag explicitly disabled and uses `autoDeployTrigger: checksPass` for the API and worker. The dedicated `data-plane-production-qualification` workflow runs on every `main` commit, so a Render auto-deploy cannot start until the exact release's GitHub checks—including the transport qualification—have completed successfully. A later canary activation is a reviewed configuration promotion, not a dashboard-only flag flip.

The qualified SHA is promoted only after the exact release has passed E2E, chaos/security, transport-resource, deployment-readiness, and platform packaging gates. Qualification evidence is uploaded as a GitHub Actions artifact named `data-plane-production-qualification-<sha>` and contains no authority, private key, nonce, booking identifier, or renter payload.

## Reviewed QUIC resource envelope

GPUbnb uses explicit transport bounds instead of Quinn defaults:

| Resource | Default / limit | Rationale |
|---|---:|---|
| Remote bidi streams / connection | 65 | 1 authority/control stream + 64 workspace application streams |
| Workspace application bidi streams / session | 64 | Matches `EdgeRegistry.max_streams_per_session` |
| Remote uni streams | 0 | Protocol v1 does not use peer-initiated uni streams |
| Stream receive window | 2 MiB | Below the 8 MiB application per-stream buffer ceiling |
| Connection receive window | 8 MiB | Below the 16 MiB application per-session ceiling |
| Connection send window | 8 MiB | Explicit sender-side bound |
| Transport budget / connection | 16 MiB | Receive + send connection windows |
| Default max open connections | 256 | Hard admission cap |
| Default transport memory budget | 4096 MiB | `256 × 16 MiB`; startup rejects oversubscription |
| Application buffered-byte budget | 512 MiB | Existing `EdgeRegistry` global bound |
| Idle timeout | 60 s | Reclaims dead/stalled connection state |
| UDP socket buffer target | 16 MiB send + 16 MiB receive | Covers roughly the BDP of 1 Gbit/s at 100 ms RTT |

The extra QUIC bidi stream is protocol control capacity, not an extra workspace stream. After a successful Host or Renter authentication response, the Edge explicitly drops the completed one-shot control `SendStream` before entering the long-lived connection loop so control-stream handle lifetime cannot consume workspace concurrency credit. Application admission remains hard-bounded at 64 by `EdgeRegistry`; the 65th workspace attempt must reach application admission and receive an explicit `STREAM_LIMIT` rejection rather than timing out at the QUIC layer.

The transport memory figure is a conservative configuration envelope, not a claim that Quinn eagerly allocates the entire amount. Production node sizing MUST reserve the full configured transport envelope plus the 512 MiB application buffer ceiling and runtime/OS headroom. The default profile therefore requires at least 8 GiB RAM on an Edge node; larger connection caps require a correspondingly larger explicit `GPUBNB_EDGE_TRANSPORT_MEMORY_BUDGET_MIB` and node memory class.

At startup the Edge computes:

`max_connections × (connection_receive_window + connection_send_window)`

and refuses to start if the result exceeds `GPUBNB_EDGE_TRANSPORT_MEMORY_BUDGET_MIB`.

## UDP socket buffers

A single Edge endpoint uses one UDP socket. GPUbnb requests and then reads back both `SO_RCVBUF` and `SO_SNDBUF` before handing the socket to Quinn, so production never silently assumes an OS buffer size.

Production nodes MUST run with:

```text
GPUBNB_EDGE_UDP_BUFFER_BYTES=16777216
GPUBNB_EDGE_UDP_BUFFER_STRICT=true
```

Strict mode refuses startup if the effective send or receive buffer is below the requested target.

Recommended Linux host baseline (set by node provisioning, not by the Edge process):

```text
net.core.rmem_max=33554432
net.core.wmem_max=33554432
```

The larger kernel ceiling leaves room for platform-specific socket-buffer accounting around a 16 MiB requested target. Node qualification must verify the values after boot and after image/kernel upgrades.

## Address validation and abuse policy

- Below 75% of the configured connection cap, normal validated/unvalidated handshakes are accepted to avoid unnecessary RTT.
- At or above 75%, new unvalidated addresses receive QUIC Retry, forcing address validation before connection state is committed.
- At the hard connection cap, new attempts are refused.
- If Retry cannot be issued, the Edge fails closed and refuses the attempt.
- TLS/QUIC 0-RTT remains disabled.
- Peer-initiated unidirectional streams remain disabled.

## Required chaos/security matrix

The dedicated qualification job must prove, against the real Edge and Host binaries:

1. **Idle/stalled pre-auth:** a completed QUIC/TLS handshake that sends no authority is reclaimed by the configured idle timeout.
2. **Connection flood:** concurrent pre-auth handshakes hit Retry/capacity protection without process death or unbounded memory growth.
3. **Stream pressure:** all 64 workspace application streams can be admitted concurrently after the authority/control stream, a 65th workspace stream receives an explicit application-level `STREAM_LIMIT` rejection, and a fully closed workspace stream makes capacity reusable within the bounded qualification deadline.
4. **Slow path / backpressure:** a routed file-transfer remains byte-identical under injected delay, jitter, packet loss and reordering with bounded QUIC windows.
5. **Replay + crash/corruption:** consumed authorities remain rejected after restart and corrupted replay state quarantines/fails closed.
6. **Drain:** Edge shutdown stops new admission and terminates existing QUIC state inside the qualification deadline.
7. **Resource bound:** the test profile remains inside its declared transport-memory formula and measured process RSS remains below the qualification ceiling during stream and connection pressure.
8. **Evidence:** effective socket buffers, memory observations and security/transport events are retained for the exact commit SHA.

No test may treat TLS failure, inability to reach the Edge, or client timeout before application authentication as proof of a security rejection.

## Observability required before canary

`edge_ready` exposes the effective policy, transport-memory reservation and socket-buffer values. `edge_metrics` periodically reports:

- active QUIC connections;
- active authenticated sessions;
- active routed streams;
- application buffered bytes;
- accepted/refused/ignored handshake counters.

Per-connection close metrics report RTT, congestion window, congestion events, packet/byte loss, path black-hole detections, current MTU, and QUIC `DATA_BLOCKED` / `STREAM_DATA_BLOCKED` / `STREAMS_BLOCKED_BIDI` frame counters. Security events separately expose capacity refusals, Retry decisions, handshake failures, replay rejection, replay-store saturation/persistence failure, and routed-stream failures. Raw renter payloads, authority nonces, signatures, booking IDs, and renter IDs are never part of these metrics.

## Canary sequence

After the exact release SHA is qualified and the qualification artifact has been reviewed:

1. internal sessions only;
2. 1%;
3. 5%;
4. 25%;
5. 50%;
6. 100%.

Promotion stops immediately on SLO/error-budget regression, elevated replay/persistence failures, capacity saturation, rising congestion/loss, or workspace `INTERACTIVE` readiness failures. `LEGACY_GATEWAY` remains the rollback path until the full qualification window completes without rollback.
