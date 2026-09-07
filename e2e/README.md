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
READY (canOpen:true) → real access grant → real code-server Management +
ExtensionHost upstream frames → ACTIVE → stop → COMPLETED → real cleanup →
GPU released → a second rental proven possible
```

The rental portion does not fabricate GPU proof or workspace state. Compute
preparation goes through the authenticated production route, the real Agent must
complete `GPU_PROOF` with `gpuDetected=true` and verified container cleanup, and
the API must finalize the booking to `STARTING` before Developer preparation is
allowed. Activation also requires genuine upstream data from code-server through
the authenticated gateway; an HTTP 101/WebSocket handshake by itself is not
accepted as proof of an interactive rental.

There is one deliberately narrow local-harness shortcut **before the rental is
created**: after the first anti-spoofing inventory heartbeat, the disposable
machine row is bootstrapped to the publishable onboarding state so the harness
can create its own test listing. That shortcut is not rental evidence and must
never be described as physical release qualification. The current release gate
is `docs/CURRENT_PHYSICAL_QUALIFICATION.md`.

`RESULTS.md` records historical real runs of the harness, including unattended
runs on a physical GTX 1650. Those recorded runs predate the current
GPU_PROOF-before-Developer and genuine-code-server-traffic strengthening, so
they remain useful historical evidence but do **not** prove that the current
strengthened harness has itself been rerun. A new real run must be recorded
before claiming those additional steps as physically executed.

A second, separate harness, `recovery-agent-restart.sh`, now uses the same
current rental contract before injecting its fault: real `GPU_PROOF`, real
Developer preparation, real Management + ExtensionHost upstream frames, and a
booking that is genuinely `ACTIVE`. It then kills the real Agent OS process,
requires the exact container/proxy/volume/network to survive, restarts the
Agent, requires the same runtime identity and exactly one live GPU allocation,
proves authenticated code-server traffic again after recovery, and accepts the
stop only if the session reaches `COMPLETED` and all four per-session Docker
resources are gone. This is still a local single-host recovery harness, not the
public PC A ↔ PC B browser qualification.

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
- It consumes the one-time renter grant as a browser would, carries the returned
  workspace cookie into code-server's Management and ExtensionHost WebSockets,
  and waits for a genuine upstream frame from each channel before accepting
  billing activation.
- It requires an activated Developer session to terminate as `COMPLETED`; a
  `FAILED`, `TIMED_OUT`, or `CANCELLED` result is a harness failure.

The current harness still does **not** replace a real PC B browser qualification.
Its authenticated WebSocket traffic proves the gateway/data path, but it is not
a full browser interaction producing the final physical release evidence. See
`docs/CURRENT_PHYSICAL_QUALIFICATION.md`.

## Running it

```bash
cd e2e
./run.sh
```

The script is idempotent to re-run: it tears down and recreates its own
disposable Postgres/Redis containers and isolated agent config directory
each time.

To run the recovery scenario instead (uses its own disposable infrastructure,
prefixed `gpubnb-recovery-`, so it can run independently of `run.sh`):

```bash
cd e2e
./recovery-agent-restart.sh
```

## Known environment-specific timing notes

Two real, non-bug timing windows matter if you add long pauses between steps:

1. **`PREPARATION_LEAD_MS`** (`apps/api/src/agent-job-claim.ts`): a booking's
   `startsAt` must be within this lead window for its jobs to become claimable.
   The scripts create bookings starting at `now` and run straight through.
2. **`INTERACTIVE_CONNECT_TIMEOUT_SECONDS`** (`apps/api/src/workspace-gateway.ts`):
   once the gateway registers, the renter has a bounded window to actually
   connect before the session is marked `TIMED_OUT` and the booking `DEGRADED`.
   This is a deliberate fail-closed protection against billing an unused
   session, not a timeout to weaken for the harness.

If you interrupt a script and replay steps manually, a timeout can therefore be
a legitimate product outcome rather than a harness bug. Inspect the state
transition and gateway evidence before changing any production timeout.
