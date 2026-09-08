# GPUbnb — Current Project Status

_Last updated: 2026-09-08._

## Release qualification

The current automated qualification path on `main` exercises the real rental lifecycle rather than the old Developer-only shortcut: production `GPU_PROOF` runs before Developer preparation; activation requires genuine upstream code-server WebSocket traffic; recovery covers a real Agent restart while preserving a single runtime/allocation; post-stop verification proves per-session Docker cleanup and GPU reuse; and the live Developer container is required to expose exactly the `Accelerator.hardwareUuid` leased to the booking.

PR #170 (`test(e2e): prove Developer workspace sees exact leased GPU UUID`) was merged into `main` as `e2d092c595d0c635ecbbdd1ae163c92853b6e1e5` after `CI`, `api-mining-ci`, and `deployment-readiness` all passed.

The current-release physical PC A ↔ PC B qualification is still **NOT YET PASSED**. `docs/CURRENT_PHYSICAL_QUALIFICATION.md` is the release-gate source of truth. Automated CI/E2E evidence, historical physical runs, simulators, and older diagnostic results do not by themselves satisfy that gate.

Until a clean current-release two-machine run records all required evidence, the correct project statement is:

> Automated qualification is green, but current-release physical PC A ↔ PC B qualification is pending.

## Historical status snapshot

The previous `PROJECT_STATUS.md` was a 2026-08-30 mission snapshot. It has been preserved unchanged at `docs/history/PROJECT_STATUS_2026-08-30.md` for audit/history purposes. Its statements about then-current branch state, test counts, limitations, or the harness shortcutting the real `GPU_PROOF` path are historical and must not be used as current release evidence.

## Next release action

Execute one clean physical qualification using `docs/CURRENT_PHYSICAL_QUALIFICATION.md` on the exact release identity: PC A hosts the real GPU/Agent, PC B books and opens the workspace through the configured public path, `nvidia-smi` inside the renter workspace proves the exact leased GPU, normal stop removes all per-session runtime resources, and the GPU/listing becomes available again. Run the documented fault campaign only after that clean pass.
