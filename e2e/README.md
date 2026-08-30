# GPUbnb — real end-to-end harness (local, single real GPU)

This harness drives the **real** GPUbnb chain — real API, real Postgres, real
Redis, a real isolated `gpubnb-agent` instance, real Docker, and your real GPU
— through one full rental lifecycle:

```
wallet auth (real Ed25519) → machine pairing (real agent) → heartbeat →
listing → booking → POST /workspace/developer → real WORKSPACE_PREPARE job →
real Docker container (gpubnb-developer image) → real gateway register →
READY (canOpen:true) → real access grant → real code-server over HTTP →
stop → real cleanup → GPU released → a second rental proven possible
```

Nothing here is mocked or simulated: every step calls the actual production
route or the actual production service function, over real HTTP or a real
Prisma connection. `./run.sh` has been run **unattended, end to end, twice in
a row** against this exact repository state — see `RESULTS.md` for the full
evidence, including the real bugs found and fixed to get there.

A second, separate harness, `recovery-agent-restart.sh`, proves a real
recovery scenario: it gets a workspace to the same `READY`/gateway-registered
state, then genuinely kills the real agent OS process (simulating a crash)
and verifies the system recovers - real heartbeats resume after restart, no
GPU double-booking, and a normal stop/cleanup still completes.

## Prerequisites

- Docker Desktop with the NVIDIA Container Toolkit enabled, and a real
  NVIDIA GPU (developed and proven against a single GTX 1650 — the whole
  point of this harness is that **one GPU is a fully supported case**, not a
  degraded one).
- `gpubnb-agent` installed (`pip install -e agent` from the repo root, or the
  packaged Host installer) and on `PATH`.
- Node 18+, `npm install` already run in `apps/api`.
- **Do not** run this against your production database, your production
  Redis, or the real installed agent's config directory. The script below
  creates fully isolated, disposable infrastructure for exactly that reason.

## What it does *not* fake

- It never writes `status: READY` itself — that transition only happens
  because the real `/agent/jobs/:id/complete` and
  `/agent/workspace-gateway/:sessionId/register` handlers ran for real.
- It never invents a `connectionMetadata` value — it reads back whatever the
  real agent's real `docker run` actually produced (`runtimeId`, `localPort`).
- It never mocks Docker or the gateway — `docker ps`/`docker exec` are used
  to independently confirm the container the agent created is real, healthy,
  and has `nvidia-smi`/`python3`/`node` working inside it.

## Running it

```bash
cd e2e
./run.sh
```

The script is idempotent to re-run: it tears down and recreates its own
disposable Postgres/Redis containers and isolated agent config directory
each time, and never touches anything outside of names prefixed
`gpubnb-e2e-`.

To run the recovery scenario instead (uses its own disposable resources,
prefixed `gpubnb-recovery-`, so it can run independently of `run.sh`):

```bash
cd e2e
./recovery-agent-restart.sh
```

## Known environment-specific timing notes

Two real, non-bug timing windows you may hit if you add long pauses between
steps (e.g. while debugging interactively rather than running the script
straight through):

1. **`PREPARATION_LEAD_MS`** (`apps/api/src/agent-job-claim.ts`): a booking's
   `startsAt` must be within this lead window of "now" for its
   `WORKSPACE_PREPARE` job to become claimable. The script creates bookings
   starting at `now`, so this is a non-issue when run straight through.
2. **`INTERACTIVE_CONNECT_TIMEOUT_SECONDS`** (`apps/api/src/workspace-gateway.ts`):
   once the gateway registers, the renter has a bounded window to actually
   open a WebSocket connection before the session is marked `TIMED_OUT` and
   the booking `DEGRADED` (a deliberate fail-closed protection against
   billing a session nobody ever used — do not "fix" this, it is correct).
   The harness's activation step runs immediately after confirming
   `canOpen: true` for exactly this reason.

If you interrupt the script and re-run steps by hand, budget on the order of
a minute between "register" and "activate" or you will legitimately
reproduce this fail-closed path (which is itself worth seeing once).
