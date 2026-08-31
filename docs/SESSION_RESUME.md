# Session Resume — read this first if you are a new Claude Code session

**Purpose**: continuity note across sessions on this machine. Read top to
bottom before doing anything else.

**Do not push anything until the user explicitly authorizes it.** Commits are
authorized and have been made (see section 1); pushing is not.

---

## 1. Git state

Branch `fix/windows-agent-quiescence-and-e2e-harness`. `origin/...` is behind
by these commits (local only, not pushed):

- `7005c54` fix(agent): give docker_info's NVIDIA runtime probe a longer timeout
- `be31781` feat(host-desktop,agent): add real Détecter et libérer le GPU workflow
- `5b595fe` feat(agent,api,web): real Data Workspace runtime + full 13-workspace catalogue

Working tree is otherwise clean except this file. `main`/`origin/main` is
untouched (PR #133's merge commit). PR #134 (this branch → main) is still
open, not merged — see `docs/MISSION_HISTORY.md` / `docs/PROJECT_STATUS.md`
for its original history if needed; not reproduced here.

## 2. What's real and working right now

- **GPU quiescence + release button**: `agent/gpubnb_agent/gpu_process_release.py`
  (`gpubnb-agent gpu-processes list|close`), Tauri bridge, and the actual UI
  on the Host page. Live-validated against a real EpicGamesLauncher.exe
  holding the GPU on this machine — correctly classified, correctly refused
  to force-close it (no window).
- **Workspace catalogue**: `GET /rental/listings/:id/workspace-catalogue`
  returns a real per-machine verdict for all 13 manifests
  (`apps/api/src/machine-workspace-catalog.ts`'s `allWorkspaceCompatibility`),
  shown on `choose-workspace.html`. Booking availability
  (`compatibleWorkspaceChoices`) stays a separate, deliberately-restricted
  list.
- **Executable workspaces** (`executableWorkspaceSlugs` in
  `machine-workspace-catalog.ts` — the one gate the whole system checks):
  `compute`, `developer`, `data`. All three have a real runtime behind them.
- **Data Workspace** (new this session): real JupyterLab container
  (`quay.io/jupyter/datascience-notebook`, official image, pinned by its real
  quay.io digest — no GPUbnb-built image, no registry push was needed or
  done), reusing the Developer workspace's exact gateway/proxy/gpu-rental-
  authority architecture with `workspace_slug` threaded through it. Real
  booking/status/access routes on `apps/web/workspace-bookings.js`
  ("Créer mon espace Data" / "Ouvrir JupyterLab").
  - **Known gap, not silently overclaimed**: no PostgreSQL client tooling
    (psycopg2/psql) — the official image doesn't ship it, and adding it
    would mean building+publishing a custom GPUbnb image, which this session
    has no registry credentials for. `technologies` in the manifest was
    updated to not claim PostgreSQL.
  - **Verified live, end-to-end, real Docker, real `GatewaySupervisor` code**
    (not FakeDocker): launch → real HTTP health check through the real
    loopback proxy → register → idempotent adoption on a second reconcile →
    stop → full cleanup confirmed (container/proxy/volume/network all
    genuinely gone). Script used for this is not part of the repo (ad hoc,
    scratchpad) — rerun it from scratch if you need to re-verify; the
    permanent regression coverage is in `agent/tests/test_workspace_gateway.py`
    (`DataWorkspaceLaunchTests`) and `test_workspace_gateway_v5.py`.
  - **Real bug found and fixed via that live test, not by any prior unit
    test**: `_real_health_check` in `workspace_gateway.py` used plain
    `urlopen()`, which raises `HTTPError` for any non-2xx/3xx response
    instead of returning it — so its documented "200 ≤ status < 500 counts
    as healthy" contract silently never worked for a real 4xx. Never
    surfaced against Developer (code-server apparently never 404s
    `/healthz`); Jupyter's Tornado router genuinely does, which is exactly
    what caught it. Fixed by catching `HTTPError` and checking its `.code`
    in the same range. Regression tests: `RealHealthCheckTests` in
    `test_workspace_gateway.py`.

## 3. Test status (all re-run and green as of this commit)

- `pytest agent/tests` → 279 passed, 2 skipped.
- `npm test` in `apps/api` → 468 passed, 0 failed, 10 skipped (need a local
  Postgres/Redis this machine doesn't have running — environmental, not a
  defect).
- `cargo test --features desktop-runtime` in `apps/host-desktop/src-tauri` →
  106 passed, 1 pre-existing failure (`tests::status_never_claims_ready_by_default`)
  unrelated to anything in this session — see git blame (2026-07/08, long
  before this branch) and section 4.
- `docker ps -a` / `docker volume ls` / `docker network ls` checked clean
  after all live testing — no orphaned `gpubnb-dev-*`/`gpubnb-workspace-*`
  resources.

## 4. Known pre-existing issue — do not "fix" by touching production state

`tests::status_never_claims_ready_by_default` (host-desktop Rust) fails only
on this specific machine because `build_status()` shells out to the real,
genuinely-linked, running production `gpubnb-agent`. Pre-dates this branch.
Do not unlink/reconfigure the production agent to make this pass.

## 5. What must NOT be done

- No push without explicit authorization.
- Do not touch the production `gpubnb-agent` service/config/keys.
- Do not fabricate a "bookable" workspace slug without a real runtime behind
  it — `executableWorkspaceSlugs` is the one gate; every entry in it must
  have real agent-side launch code and passing tests, per this session's
  precedent for Data.
- Do not build/publish a custom GPUbnb container image without the user's
  explicit go-ahead (registry credentials, CI trigger) — this session
  deliberately avoided that for Data Workspace by using an official image
  directly.

## NEXT ACTION

Continue Workspace-by-workspace per the mission's own stated priority order
(Compute, Developer, Data all done → AI next is the natural continuation,
being architecturally closest to Data: same CONTAINER/NOTEBOOK runtime
profile in `workspace-runtime-profiles.ts`, but needs a real
CUDA/PyTorch-capable image and real GPU passthrough, unlike Data). For each
new workspace: same rigor as Data — real image (official/pinned or a
justified reason to build one), real agent-side launch code, real API
routes, real tests, live-verified against real Docker, `executableWorkspaceSlugs`
updated only as the last step. Do not commit without re-running the full
three test suites first. Do not push without explicit authorization.
