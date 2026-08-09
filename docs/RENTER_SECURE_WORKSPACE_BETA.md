# GPUbnb — Secure Renter Workspace Beta Gate

## Why this is the next release gate

The two-machine beta proved booking -> funding bypass -> agent -> Docker -> physical GPU -> cleanup, but the executed workload was `GPU_DIAGNOSTIC`. That is infrastructure validation, not yet a usable renter workspace.

A rental MUST NOT be advertised as an interactive compute rental until the renter can open an isolated workspace from a second physical computer and use the remote GPU without receiving Windows, SSH, LAN, or host-filesystem access.

## Product contract

The renter flow is:

1. Reserve an eligible GPU.
2. Wait while the existing `WORKSPACE_PREPARE` path prepares the immutable workspace image.
3. See an explicit `PREPARING`, `READY`, `ACTIVE`, `STOPPING`, `TERMINATED`, or `FAILED` state.
4. Only when the session is `READY` and the booking time/heartbeat checks pass, receive an **Open workspace** action.
5. Enter through a short-lived, booking-bound access grant. Never expose host IP, Windows credentials, Docker socket, agent key, or host filesystem paths to the renter.
6. Work inside an isolated GPU environment.
7. Stop the session or let the booking expire.
8. Verify container/process/storage cleanup before the machine can return to `AVAILABLE`.

## Beta workspace implementation

For the first usable beta, the interactive surface should be a browser workspace (JupyterLab or code-server) running inside the rental sandbox. Do not expose a raw host SSH service.

The workspace runtime must have:

- GPU assignment limited to the accelerator allocated to the booking;
- non-root user;
- no Docker socket;
- no host home-directory mounts;
- no access to Windows named pipes or host service credentials;
- read-only base filesystem where practical;
- dedicated ephemeral writable volume for `/workspace`;
- CPU, RAM, PID and disk quotas;
- network disabled by default; if package egress is later enabled, it must use an explicit policy and must not expose the host LAN;
- an immutable image reference pinned by digest;
- a random per-session runtime identifier that is not a secret;
- a short-lived access token stored hashed server-side and scoped to exactly one renter + booking + workspace session;
- access-token rotation/revocation on stop, expiry, renter logout, or booking cancellation;
- cleanup verification before machine availability is restored.

## API contract to implement

The API surface should expose renter-safe data only:

- `GET /bookings/:bookingId/workspace` — renter/owner status view. Renter response contains session state, safe GPU metadata, start/end time and whether opening is allowed. It must not contain host address, agent key, internal container ID or host paths.
- `POST /bookings/:bookingId/workspace/access` — renter only. Allowed only for the renter who owns the booking, a funded/active booking, a `READY` or `ACTIVE` session, fresh heartbeat, non-quarantined machine and current booking time. Returns a very short-lived one-time access grant or gateway URL.
- `POST /bookings/:bookingId/workspace/stop` — renter or host emergency stop; idempotent.

The access endpoint must be rate limited and auditable. Access grants must be random high-entropy values, persisted only as hashes, single-session scoped, short lived, and never logged.

## Agent protocol gate

Before interactive beta, the API and agent must negotiate an explicit protocol version. The heartbeat/inventory payload must include `agentVersion` and `protocolVersion`. The API must reject an agent below `MIN_SUPPORTED_AGENT_PROTOCOL` with a clear incompatibility state instead of allowing a rental to fail halfway through.

Windows installation must use a versioned immutable release. Editable installs (`pip install -e`) are development-only and must not be part of the beta installation path.

Heartbeat collection must be decoupled from slow hardware probing: the signed liveness heartbeat cannot wait on Docker/NVIDIA inventory collection. The production offline threshold remains a safety margin, not the primary fix for slow heartbeat generation.

## Thermal gate

Interactive work can run much longer than `GPU_DIAGNOSTIC`. Before beta, the agent must enforce configurable warning and shutdown temperatures. A sustained critical temperature must terminate the workload safely, report a thermal termination reason and place the machine in cooldown/quarantine until it is safe.

## Worker/deployment gate

Running reconciliation and stale/offline sweeps in the API process is acceptable only for the current free private test. Before paid/public beta, these loops must have explicit idempotency/locking and production observability, and should run in a durable worker deployment independent of HTTP process lifecycle.

Non-secret operational configuration (heartbeat intervals/thresholds, protocol minimum, thermal limits, workspace TTLs) must be represented in versioned deployment documentation/configuration rather than existing only in a provider dashboard.

## Payment gate

`BETA_TEST_DEV_BYPASS` is for free controlled beta only. No real-money/public paid rental may be enabled while `ESCROW_PROGRAM_ID=NOT_DEPLOYED_YET` or while the real settlement path has not passed Devnet end-to-end tests with evidence.

## Required two-PC acceptance test

PC A is the physical Windows host with NVIDIA GPU. PC B is the renter and must not share the host's local session.

Pass only if all of the following are observed:

1. PC B creates the booking.
2. `WORKSPACE_PREPARE` completes on PC A.
3. PC B sees `Workspace ready` without manually operating PC A.
4. PC B opens the workspace through the renter application/web UI.
5. Inside the workspace, `nvidia-smi` (or equivalent approved diagnostic) sees only the allocated GPU.
6. A small CUDA/PyTorch workload runs successfully.
7. The renter can create a file in `/workspace` and retrieve an allowed output artifact.
8. The renter cannot read host personal files, reach the Docker socket, obtain host credentials, or directly administer Windows.
9. Ending/expiring the rental revokes access immediately.
10. Runtime/container/process and ephemeral credentials are removed; cleanup is verified.
11. Only after verified cleanup does the machine return to `AVAILABLE`.
12. Repeat after an agent restart and after a temporary network interruption.

## Release decision

- Private diagnostic beta: allowed with current payment bypass controls.
- Private interactive beta: blocked until the two-PC acceptance test above passes.
- Public beta: blocked until immutable agent distribution, protocol gating, thermal controls and durable worker operations are proven.
- Real-money beta: blocked until real escrow/settlement is deployed and proven separately.
