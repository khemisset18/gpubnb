# PC A ↔ PC B final qualification

Last updated: 2026-09-07.

This runbook defines the evidence required before GPUbnb's real two-machine rental path may be called qualified. CI can prove control-plane behavior with real PostgreSQL/Redis and isolated agents, but it **cannot substitute for the final physical GTX/NVIDIA/Docker/browser run**.

## Release identity

Record before the test:

- exact Git commit deployed to the API/worker;
- frontend build commit shown by `GPUBNB_BUILD`;
- PC A agent `build-info` commit;
- public API origin and workspace gateway origin;
- PostgreSQL/Supabase project/environment identifier (never credentials);
- Redis environment identifier (never credentials);
- artifact storage backend/bucket identifier (never access keys).

If any component changes during the run, restart qualification from the beginning and record the new release identity.

## Preconditions

PC A must show:

- real GPU detected and UUID stable;
- Docker available;
- NVIDIA container runtime available;
- CUDA probe healthy;
- machine `ONLINE`, moderation `CLEAR`, not quarantined;
- listing active and visible to PC B;
- fresh signed heartbeat;
- agent build commit matches the release under qualification.

Control plane must show:

- `/ready` healthy for PostgreSQL and Redis;
- Prisma migrations fully applied;
- API and `delivery-worker` both running from the same qualified release image;
- no provider hardcode fallback in the frontend build;
- workspace gateway health endpoint healthy;
- no open P0/P1 incident for the release.

PC B must use a separate renter identity from the host owner.

## Happy-path proof

Use a short real rental (15 minutes is sufficient for beta qualification) and preserve identifiers/timestamps.

1. PC B opens the real marketplace and books PC A's real listing.
2. Record `bookingId` and the renter request id.
3. Booking reaches the funded/startable state through the currently configured Devnet/beta payment path.
4. PC A claims the GPU proof job; record `jobId`, attempt id and machine id.
5. GPU Proof completes from the real GPU, not a mocked result.
6. PC B requests Developer Workspace.
7. Record the Developer `workspaceSessionId` and WORKSPACE_PREPARE `jobId`.
8. PC A starts the real Docker workspace with NVIDIA runtime.
9. Agent registers the gateway; `gatewayLastSeenAt` becomes fresh.
10. PC B status reports `canOpen=true`. It must never become true before both workspace readiness and fresh gateway registration exist.
11. PC B clicks **Ouvrir mon espace**. Record the returned `x-request-id` as `accessRequestId`.
12. Follow the correlated logs using `bookingId`, `jobId`, `workspaceSessionId`, `machineId`, `channelId`, and `openRequestId`.
13. code-server loads in PC B through the GPUbnb gateway; no direct PC A endpoint is exposed.
14. In the real workspace terminal run `nvidia-smi` and preserve output proving the expected GPU/driver is visible inside the rented container.
15. Confirm the commercial workspace timer starts only from real interactive activation, not from booking, GPU Proof, container readiness or gateway registration.
16. Stop the workspace from PC B.
17. Confirm the agent removes/stops the real container and gateway channel.
18. Confirm job/session reach terminal clean states, leases are released, and no unfinished JobAttempt remains.
19. Confirm machine/GPU allocation is released and the listing becomes available again.
20. Confirm no unexpected quarantine event was created.

## Mandatory fault injections

Run these independently; restore healthy state between them.

### A. One-time grant replay

After obtaining a workspace access grant, consume it once and attempt the exact same grant again. Expected: first bootstrap succeeds, second returns `invalid_workspace_grant`; no second browser session is minted.

### B. Gateway liveness loss

Make gateway registration stale without changing the durable workspace READY state. Expected: `canOpen=false`, `blockedReason=GATEWAY_STALE`, access minting fails. Let the authenticated agent re-register. Expected: `canOpen=true` again without creating a second workspace session or resetting the booking clock.

### C. Host heartbeat loss

Stop/suppress PC A heartbeat long enough to exceed `WORKSPACE_ACCESS_HEARTBEAT_MAX_AGE_SECONDS` but not long enough to manufacture an unrelated test condition. Expected: access is revoked with `HEARTBEAT_STALE`. Restore a valid signed heartbeat. Expected: access eligibility returns if every other invariant is still healthy.

### D. Brief API/network interruption

Exercise an interruption shorter than the claimed job lease window (the existing regression uses 30 seconds against a 90-second lease). Expected: a legitimately running claimed job is neither reclaimed nor quarantined solely because of that interruption.

### E. Agent/gateway reconnect

Restart the real PC A agent while a prepared workspace exists. Expected: gateway registration is refreshed, stale prior connection ownership cannot act as current, and the existing session can recover without duplicate workspace/job creation.

### F. Browser disconnect/backpressure

Close PC B or force a slow/stalled browser channel. Expected: bounded queues/backpressure prevent unbounded Redis/process memory growth; channel cleanup is attempted and later opens use a fresh channel/grant.

### G. Stop/cleanup failure

Only in a controlled qualification environment, simulate a cleanup that cannot be proven. Expected: fail closed, payment/workspace safety path is taken, and host quarantine/history records the failure rather than silently declaring the GPU reusable.

## Automated evidence already required by CI

The repository should keep automated coverage for:

- gateway not-ready before registration and openable after registration;
- idempotent agent re-registration;
- one-time grant replay;
- stale gateway revocation/recovery;
- stale heartbeat revocation/recovery;
- 30-second interruption surviving the 90-second job lease;
- workspace gateway liveness expiry;
- bounded Redis gateway queues and backpressure;
- retry-safe Serializable lifecycle transactions;
- scheduler/resource fencing;
- correlated, secret-free workspace logs;
- repeated workspace API and agent soak suites.

These tests are necessary but do not certify physical GPU access.

## Evidence to save

For each final physical run, save a small text/JSON report (no secrets) containing:

- timestamp and release commits;
- PC A GPU model + UUID (mask only if operational policy requires it);
- `bookingId`, GPU proof `jobId`, workspace job id, `workspaceSessionId`, `machineId`;
- `accessRequestId`, `channelId`, `openRequestId` from correlated logs;
- key state transitions and timestamps;
- `nvidia-smi` output from inside the rented workspace;
- stop/cleanup outcome;
- allocation/listing state after cleanup;
- fault scenarios executed and pass/fail;
- any incident/issue links.

Never store session cookies, bearer grants, agent signatures/private keys, Redis URLs with credentials, database credentials or S3 secrets in qualification evidence.

## Pass criteria

The core PC A ↔ PC B path is qualified only when:

- the happy path succeeds on the exact release candidate;
- all mandatory safety/fault scenarios relevant to that topology pass;
- there is no unresolved P0/P1 finding;
- cleanup returns the real GPU to a provably reusable state;
- logs allow the entire workspace-open attempt to be reconstructed from correlation identifiers;
- the result is documented against the exact deployed commits.

A green CI run alone must never be reported as the final physical qualification.
