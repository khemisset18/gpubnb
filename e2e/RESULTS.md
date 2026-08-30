# Real end-to-end run — evidence log

## Update, 2026-08-30 (second mission): `run.sh` now runs unattended, end to end

The original run below (see "What was real") was executed manually, step by
step, because of a sandbox constraint described in the old "Environment note"
further down. In a later, separate mission on the same day, `./e2e/run.sh`
was run **as one unattended, unbroken script** (no manual steps) and
completed successfully, twice in a row, on the same real single GTX 1650.
Getting there required finding and fixing 7 real bugs — 2 in product code
(`agent/gpubnb_agent/cli.py`'s daemon-start confirmation timing, and a
GPU-quiescence false positive caused by Windows reporting its own desktop
compositor as a "foreign compute process") and 5 in the harness itself
(Windows process-tree cleanup, `gpubnb-agent setup`'s expected exit code, a
machine-publishability shortcut, the WebSocket activation flow, and a cleanup
status-check race) — all described in detail in `docs/PROJECT_STATUS.md`
("Bugs Fixed" #4-#5 and "Harness-only fixes") and `docs/MISSION_HISTORY.md`.
No sandbox constraint was hit during this second mission; the failures were
all real and reproducible, and are now fixed.

**Real output of a full unattended run** (step numbering per `run.cjs`):

```
[e2e] 1. real owner wallet session
[e2e] 2. real pairing code + real agent link
[e2e]    machineId "cmtfoev3l..."
[e2e] 3. real agent start (real heartbeats begin)
[e2e] 4. waiting for a real, stable (non-changing) inventory heartbeat
[e2e] 5. real accelerator sync (real hardwareUuid from the real GPU)
[e2e] 6. real listing (production createExactGpuListing)
[e2e] 7. real renter wallet session + real booking + real allocation
[e2e] 8. real POST /bookings/:id/workspace/developer
[e2e]    sessionId "cmtfoev3l..."
[e2e] 9. waiting for the real agent to run the real WORKSPACE_PREPARE job
[e2e] 10. waiting for the real gateway to register
[e2e]     status poll {"canOpen":true,"blockedReason":null,"phase":"READY"}
[e2e]    real gatewayPath "/workspace-gateway/...?grant=..."
[e2e] 11. independently verifying the real container Docker just created
[e2e]     nvidia-smi "NVIDIA GeForce GTX 1650, 4096 MiB"
[e2e]     python3 "Python 3.12.3"
[e2e]     node "v24.15.0"
[e2e]     /workspace "... imports/ output/ WELCOME.md ..."
[e2e] 12. real WebSocket activation through the real gateway
[e2e] 13. real stop
[e2e] 14. waiting for the real agent to clean up the real containers
[e2e] 15. verifying real cleanup: session terminal, allocation released
[e2e]     final session status "TIMED_OUT"
[e2e] 16. proving the machine is available for a second, independent rental
[e2e]     second allocation succeeded ["..."]
[e2e] DONE — full real lifecycle proven: booking -> GPU assignment -> real
agent -> real Docker -> real GPU -> real code-server -> real gateway
register -> real READY -> real access -> real activation -> real stop ->
real cleanup -> GPU available for a second rental.
```

`final session status "TIMED_OUT"` (not `COMPLETED`) is expected, not a bug:
the harness opens and cleanly closes a WebSocket to prove the tunnel and
cookie-based auth genuinely work, but never exchanges a real code-server data
frame, and `workspace-gateway.ts` only starts paid time (and allows a clean
`COMPLETED`) after a genuine first upstream frame - a real browser exchanging
real frames would reach `COMPLETED` instead. This is the same fail-closed
protection documented below for the original manual run.

### Real agent-crash recovery, proven separately (`recovery-agent-restart.sh`)

A second, permanent harness reuses the same real production functions to get
a workspace to `READY` + gateway-registered + `canOpen: true`, then genuinely
kills the real agent OS process (`taskkill /F /T`, not `gpubnb-agent stop` -
the point was to simulate an actual crash). Real, observed sequence:

```
[recovery] 8. REAL FAULT INJECTION: killing the real agent process
[recovery]    killing real agent pid 159960
[recovery] 9. observing the container during the outage
[recovery]    container alive during agent outage true
[recovery] 10. observing the booking/session/accelerator state while the agent is down
[recovery]    session status while agent is down "READY"
[recovery] 11. REAL RECOVERY: restarting the real agent process
[recovery]    restart output "Agent démarré en arrière-plan (PID 170456)."
[recovery] 12. waiting for the restarted agent to resume real heartbeats
[recovery] 13. verifying the restarted agent reconciles WITHOUT double-booking
[recovery]    all gpubnb-dev-* containers after restart ["gpubnb-dev-proxy-...","gpubnb-dev-..."]
[recovery]    live allocations for this booking after restart {"count":1,"all":[{"status":"CONFIRMED","releasedAt":null}]}
[recovery] 14. real stop, cleanup, and re-verifying the machine is rentable again after recovery
[recovery]     final session status "TIMED_OUT"
[recovery]     GPU rentable again after recovery, second allocation succeeded ["..."]
[recovery] DONE — real agent crash/restart recovery proven.
```

Ran twice; both times exactly 2 containers (runtime + proxy, no duplicate)
and exactly 1 live allocation (no double-booking) after the restart. Docker
daemon restart and gateway/API crash scenarios were **not** tested this
mission (only one scenario was in scope) - see `docs/PROJECT_STATUS.md`'s
Known Limitations / Next Mission.

---

## Original run — evidence log (manual, step-by-step)

This is the real, live run this harness (`run.sh`/`run.cjs`) was originally built from,
executed manually step-by-step in a Claude Code sandbox session against this
exact repository state, on 2026-08-30 (an earlier mission on the same day as
the update above). It is reproduced here because the sandbox's Docker
containers were periodically destroyed by the sandbox itself at the time
(see "Environment note" below) — every step it performs was individually
proven for real, in this order, against real infrastructure. **As of the
update above, `run.sh` now also runs unattended, end to end** - this section
is kept as the original, still-accurate evidence for the two bug fixes it
was built to reproduce (see `docs/PROJECT_STATUS.md`'s Bugs Fixed #1-#2).

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

## Environment note (not a GPUbnb code issue; no longer blocking)

The sandbox this original run was executed in intermittently sent `SIGKILL`
to freshly-created Docker containers (confirmed via `docker events`: explicit
`kill (signal=9)` → `die (exitCode=137)` → `destroy`, on containers this
session never asked to stop) on an unpredictable schedule ranging from under
a minute to over twenty-five minutes, while a container that already existed
before this session (`gpubnb-render-test-pg17`) and plain Windows processes
(the API server, the agent) were never affected. This is why the original run
above was executed as a sequence of individually-verified steps with survival
checks between them, rather than as one unattended script execution.

**Update**: in the later mission (see the top of this file), `./e2e/run.sh`
was run unattended on the same physical machine and completed successfully,
twice in a row - this sandbox-container-killing behavior either did not
recur or was not the actual blocker on that occasion. The real blockers that
*were* found and fixed that time were unrelated to the sandbox (see above).
If a future run does hit unexplained container destruction again, treat it
the same way this investigation did originally: check `docker events`,
`docker logs`, and process ownership before concluding it's environmental,
and never accept "impossible here" as proof the code is correct.
