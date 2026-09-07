# GPUbnb — real end-to-end harness (local, single real GPU)

This harness drives the **real rental path** through a disposable local GPUbnb
stack: real API, real Postgres, real Redis, a real isolated `gpubnb-agent`, real
Docker and a real NVIDIA GPU.

```
wallet auth (real Ed25519) → machine pairing (real agent) → heartbeat →
local onboarding bootstrap → listing → booking/allocation →
POST /workspace-sessions {workspaceSlug:compute} → real GPU_PROOF job →
server-side proof finalization → booking remains STARTING/reserved →
POST /workspace/developer → real WORKSPACE_PREPARE job →
real Docker container (gpubnb-developer image) → real gateway register →
READY (canOpen:true) → real access grant → real code-server gateway activation →
stop → real cleanup → GPU released → a second rental proven possible
```

The rental portion does not fabricate GPU proof or workspace state. Compute
preparation goes through the authenticated production route, the real Agent must
complete `GPU_PROOF` with `gpuDetected=true` and verified container cleanup, and
the API must finalize the booking to `STARTING` before Developer preparation is
allowed.

There is one deliberately narrow local-harness shortcut **before the rental is
created**: after the first anti-spoofing inventory heartbeat, the disposable
machine row is bootstrapped to the publishable onboarding state so the harness
can create its own test listing. That shortcut is not rental evidence and must
never be described as physical release qualification. The current release gate
is `docs/CURRENT_PHYSICAL_QUALIFICATION.md`.

`RESULTS.md` records historical real runs of the harness, including unattended
runs on a physical GTX 1650. Those runs predate the GPU_PROOF-before-Developer
strengthening described above, so they are valuable historical evidence but do
**not** prove that the strengthened current harness has itself been rerun. A new
real run must be recorded before claiming that additional step as physically
executed.

A second, separate harness, `recovery-agent-restart.sh`, proves a real
recovery scenario: it gets a workspace to the same `READY`/gateway-registered
state, then genuinely kills the real agent OS process (simulating a crash)
and verifies the system recovers - real heartbeats resume after restart, no
GPU double-booking, and a normal stop/cleanup still completes.

## Prerequisites

- Docker Desktop with the NVIDIA Container Toolkit enabled, and a real
  NVIDIA GPU (developed and historically proven against a single GTX 1650).
- `gpubnb-agent` installed (`pip install -e agent` from the repo root, or the
  packaged Host installer) and on `PATH`.
- Node 18+, `npm install` already run in `apps/api`.
- **Do not** run this against your production database, your production
  Redis, or the real installed agent's config directory. The script creates
  fully isolated, disposable infrastructure for exactly that reason.

## What the rental path proves

- The renter requests Compute through the real
  `POST /bookings/:bookingId/workspace-sessions` route.
- The real Agent claims and executes the resulting `GPU_PROOF` job.
- The harness requires verified GPU use and proof-container cleanup before it
  accepts the proof as successful.
- It waits for `/agent/jobs/:id/finalize-proof` to finish its server-side
  booking transition rather than racing the preceding job-completion request.
- Developer preparation is requested only after the proof is finalized.
- It never writes Developer `status: READY` itself — that transition only
  happens because the real `/agent/jobs/:id/complete` and
  `/agent/workspace-gateway/:sessionId/register` handlers run.
- It never invents Developer `connectionMetadata`; it reads what the real
  Agent's real `docker run` and gateway registration produced.
- It never mocks Docker or the gateway — `docker ps`/`docker exec` independently
  confirm the created container is real and has `nvidia-smi`/`python3`/`node`.

The current harness still does **not** replace a real PC B browser qualification.
Its WebSocket activation proves the authenticated gateway path, but it is not a
full browser/code-server interaction producing the final physical release
proof. See `docs/CURRENT_PHYSICAL_QUALIFICATION.md`.

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

Two real, non-bug timing windows matter if you add long pauses between steps:

1. **`PREPARATION_LEAD_MS`** (`apps/api/src/agent-job-claim.ts`): a booking's
   `startsAt` must be within this lead window for its jobs to become claimable.
   The script creates bookings starting at `now` and runs straight through.
2. **`INTERACTIVE_CONNECT_TIMEOUT_SECONDS`** (`apps/api/src/workspace-gateway.ts`):
   once the gateway registers, the renter has a bounded window to actually
   connect before the session is marked `TIMED_OUT` and the booking `DEGRADED`.
   This is a deliberate fail-closed protection against billing an unused
   session, not a timeout to weaken for the harness.

If you interrupt the script and replay steps manually, a timeout can therefore
be a legitimate product outcome rather than a harness bug. Inspect the state
transition and gateway evidence before changing any production timeout.
