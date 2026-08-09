# GPUbnb — Secure Renter Workspace Beta Gate

## Why this is the next release gate

The two-machine beta proved booking -> funding bypass -> agent -> Docker -> physical GPU -> cleanup, but the executed workload was `GPU_DIAGNOSTIC`. That is infrastructure validation, not yet a usable renter workspace.

A rental MUST NOT be advertised as an interactive compute rental until the renter can open an isolated workspace from a second physical computer and use the remote GPU without receiving Windows, SSH, LAN, or host-filesystem access.

## Product contract

The renter flow is:

1. Reserve an eligible GPU.
2. Wait while the existing `WORKSPACE_PREPARE` path prepares the immutable workspace image.
3. See an explicit `PREPARING`, `READY`, `RUNNING`, `STOP_REQUESTED`, `STOPPING`, `COMPLETED`, or failure state.
4. Only when the session is `READY` and the booking time/heartbeat checks pass, receive an **Open workspace** action.
5. Enter through a short-lived, booking-bound access grant. Never expose host IP, Windows credentials, Docker socket, agent key, or host filesystem paths to the renter.
6. Work inside an isolated GPU environment.
7. Stop the session or let the booking expire.
8. Verify container/process/storage cleanup before the machine can return to `AVAILABLE`.

## Implemented Developer beta path

The branch `feat/renter-secure-workspace` now implements the first interactive runtime path using the existing `workspaces/developer` code-server image.

- The agent launches the runtime in an unprivileged Docker container.
- The project directory is a dedicated Docker volume mounted at `/workspace`; there is no host-home bind mount and no Docker socket mount.
- code-server is published only on an ephemeral `127.0.0.1` host port, never on a public host interface.
- The host-side agent makes authenticated outbound requests to the GPUbnb API to receive relay work.
- The browser never receives the local port, host IP, container ID, agent key or Windows credentials.
- HTTP and WebSocket traffic is relayed through `/workspace-gateway/:sessionId/...`.
- The bootstrap grant is random, short-lived, hash-only at rest in Redis and consumed once. It is exchanged for an HttpOnly/Secure/SameSite session cookie scoped to that workspace path.
- Every agent relay write is authenticated with the existing body-bound signed request mechanism.
- A failed cleanup quarantines the machine. Successful cleanup removes the container and workspace volume before the machine is released.

The gateway implementation is intentionally outbound-only from the owner machine so the host does not need a router port-forward or a public code-server port.

## Runtime families

For the first usable beta, Developer/AI/Data/Compute/API use the container family where compatible. Cloud Desktop/Creator/Video/CAD require the desktop VM family. Mobile and Security Lab require a stronger isolated VM family. Gaming and Audio remain latency-sensitive streaming VM work.

All runtime families share one lifecycle and one renter access contract. They must not become independent remote-access products.

## Agent protocol gate

Before public interactive beta, the API and agent must negotiate an explicit protocol version. The heartbeat/inventory payload must include `agentVersion` and `protocolVersion`. The API must reject an agent below `MIN_SUPPORTED_AGENT_PROTOCOL` with a clear incompatibility state instead of allowing a rental to fail halfway through.

Windows installation must use a versioned immutable release. Editable installs (`pip install -e`) are development-only and must not be part of the beta installation path.

Heartbeat collection must be decoupled from slow hardware probing: the signed liveness heartbeat cannot wait on Docker/NVIDIA inventory collection. The production offline threshold remains a safety margin, not the primary fix for slow heartbeat generation.

## Thermal gate

Interactive work can run much longer than `GPU_DIAGNOSTIC`. Before public beta, the agent must enforce configurable warning and shutdown temperatures. A sustained critical temperature must terminate the workload safely, report a thermal termination reason and place the machine in cooldown/quarantine until it is safe.

## Worker/deployment gate

Running reconciliation and stale/offline sweeps in the API process is acceptable only for the current free private test. Before paid/public beta, these loops must have explicit idempotency/locking and production observability, and should run in a durable worker deployment independent of HTTP process lifecycle.

Non-secret operational configuration (heartbeat intervals/thresholds, protocol minimum, thermal limits, workspace TTLs) must be represented in versioned deployment documentation/configuration rather than existing only in a provider dashboard.

## Payment gate

`BETA_TEST_DEV_BYPASS` is for free controlled beta only. No real-money/public paid rental may be enabled while `ESCROW_PROGRAM_ID=NOT_DEPLOYED_YET` or while the real settlement path has not passed Devnet end-to-end tests with evidence.

## Required two-PC acceptance test

PC A is the physical Windows host with NVIDIA GPU. PC B is the renter and must not share the host's local session.

Pass only if all of the following are observed:

1. PC B creates the booking.
2. Developer `WORKSPACE_PREPARE` completes on PC A.
3. PC A's agent starts code-server and registers the gateway without any router port-forward.
4. PC B sees `Workspace ready` without manually operating PC A.
5. PC B clicks **Open workspace** and VS Code Web loads through the GPUbnb gateway.
6. Browser WebSocket reconnects and the integrated terminal remains usable.
7. PC B can create/edit/run a small project in `/workspace`.
8. The renter cannot read host personal files, reach the Docker socket, obtain host credentials, or directly administer Windows.
9. Ending/expiring the rental revokes access.
10. Runtime/container and ephemeral credentials are removed; cleanup is verified.
11. Only after verified cleanup does the machine return to `AVAILABLE`.
12. Repeat after an agent restart and after a temporary network interruption.

## Release decision

- Private diagnostic beta: allowed with current payment bypass controls.
- Private interactive Developer beta: code path implemented; physical two-PC validation is still required before claiming it works end-to-end.
- Public beta: blocked until immutable agent distribution, protocol gating, thermal controls and durable worker operations are proven.
- Real-money beta: blocked until real escrow/settlement is deployed and proven separately.
