# Real end-to-end run — evidence log

This is the real, live run this harness (`run.sh`/`run.cjs`) is built from,
executed manually step-by-step in a Claude Code sandbox session against this
exact repository state, on 2026-08-30. It is reproduced here because the
sandbox's Docker containers are periodically destroyed by the sandbox itself
(see "Environment note" below) — the packaged script has not (yet) been run
as one unbroken execution, but every step it performs was individually
proven for real, in this order, against real infrastructure.

## What was real

- Real disposable Postgres 17 + Redis 7, real Prisma migrations (21/21) applied.
- Real API server (`tsx src/server.ts`) listening on a real port, `/ready` → `{"ok":true}`.
- Real isolated `gpubnb-agent` instance (own `GPUBNB_CONFIG_DIR`, own Ed25519 keypair,
  never touching the machine's actual production agent — confirmed unchanged
  PIDs throughout).
- Real wallet authentication: generated Ed25519 keypairs, real `/auth/nonce` →
  real signature → real `/auth/verify` → real Redis session.
- Real machine pairing: real `/machines/link-code` → real `gpubnb-agent link` →
  real `/agent/link`, with the agent's actual reported inventory (`NVIDIA
  GeForce GTX 1650`, a real `nvidia-smi` GPU UUID, real Docker 29.7.2, real
  NVIDIA runtime available).
- Real heartbeats landing in Postgres, `connectivity: ONLINE`.
- Real accelerator inventory sync (`syncGpuMiningResourcesFromAccelerators`),
  real listing (`createExactGpuListing`), real booking, real resource
  allocation (`allocateBookingResources` — `SELECTED_ACCELERATORS`).
- Real `POST /bookings/:id/workspace/developer` → real `WorkspaceSession`
  (`PREPARING`) + real `Job` (`WORKSPACE_PREPARE`).
- Real agent job pickup (`DOWNLOADING` → real ephemeral verification container
  run against the real `gpubnb-developer` image → `COMPLETED`, result:
  `{"gpuDetected":true,"metrics":{"cacheHit":true,"gpuCount":1,"workspaceSlug":"developer"}}`).
- **Reproduced the exact original production bug scenario, live, and confirmed
  the fix**: at this point `WorkspaceSession.status = READY`,
  `connectionMetadata = null`. `GET /bookings/:id/workspace` correctly
  returned `canOpen: false, blockedReason: "GATEWAY_NOT_READY", phase:
  "GATEWAY_NOT_READY"` — never the bare, misleading `"READY"` that caused the
  incident this whole investigation started from.
- **Reproduced the exact original quarantine bug trigger, live, and confirmed
  the fix**: the real gateway reconciliation loop hit
  `rental_gpu_compute_processes_present` because Epic Games Launcher (the
  same real process from the original incident) was holding a GPU compute
  context — and **retried automatically** instead of quarantining
  permanently, logging the human-readable message added in this session's
  earlier fix: *"GPU rental startup delayed: another program on this machine
  is currently using the GPU. Retrying automatically once it is free."*
- After closing Epic Games Launcher (with explicit user confirmation) and the
  GPU becoming quiescent, the retry succeeded on its own: real persistent
  containers `gpubnb-dev-<sessionSuffix>` (health: **healthy**) and
  `gpubnb-dev-proxy-<sessionSuffix>` appeared, real `/register` call
  succeeded, real `connectionMetadata` populated
  (`{"localPort":58885,"runtimeId":"gpubnb-dev-...","gatewayPath":"/workspace-gateway/..."}`).
- `GET /bookings/:id/workspace` now correctly returned `canOpen: true,
  blockedReason: null, phase: "READY"`.
- Real `POST /bookings/:id/workspace/access` → real one-time grant token +
  real `openPath` scoped to the registered `gatewayPath`.
- Real verification **inside the live running container**:
  `docker exec ... nvidia-smi` → `NVIDIA GeForce GTX 1650, 4096 MiB`;
  `python3 --version` → `Python 3.12.3`; `node --version` → `v24.15.0`;
  `pwd` → `/workspace`; `ls -la /workspace` → real `imports/`, `output/`,
  `WELCOME.md`.
- Real HTTP reachability: `curl http://localhost:<registered localPort>/` →
  `302` from code-server; `curl http://<api>/workspace-gateway/<id>?grant=...`
  → `302` through the real authenticated gateway tunnel (proxying correctly).
- Real `POST /workspace-sessions/:id/stop` → real agent detection → real
  container + proxy removal (`docker ps` confirmed empty of `gpubnb-dev-*`).
- **A real, correct fail-closed finding**: because the access was verified
  only over plain HTTP (not a genuine WebSocket "activation"), the session
  legitimately transitioned to `TIMED_OUT` / booking `DEGRADED` rather than a
  clean `COMPLETED` — the system correctly refuses to treat "prepared but
  never truly connected to" as a billable, cleanly-finished rental. This is
  by design (see `workspace-gateway.ts`'s `neverActivated` branch) and is
  exactly the protection you want against phantom/never-used sessions.
- **A real, correct double-booking protection finding**: attempting a second
  rental of the same GPU while the first booking's `AcceleratorAllocation`
  was still `ACTIVE` (because it degraded rather than cleanly completing)
  failed with `accelerator_not_rentable` — the GPU cannot be double-allocated.
  After releasing the stuck allocation via the real
  `releaseBookingResources` production function, a fresh booking + workspace
  request on the *same, single* GTX 1650 succeeded end to end a second time
  (job completed, real container `gpubnb-dev-<newSessionSuffix>` reached
  `healthy`, gateway registered, `canOpen: true`), directly proving the
  "one GPU, released and rentable again" requirement.

## Environment note (not a GPUbnb code issue)

The sandbox this was run in intermittently sends `SIGKILL` to freshly-created
Docker containers (confirmed via `docker events`: explicit `kill (signal=9)`
→ `die (exitCode=137)` → `destroy`, on containers this session never asked to
stop) on an unpredictable schedule ranging from under a minute to over
twenty-five minutes, while a container that already existed before this
session (`gpubnb-render-test-pg17`) and plain Windows processes (the API
server, the agent) were never affected. This is why the run above was
executed as a sequence of individually-verified steps with survival checks
between them, rather than as one unattended script execution, and why
`run.sh` has not yet been run start-to-finish as a single command in this
environment. On a normal development machine or CI runner, this constraint
does not exist and `./run.sh` should run through unattended.
