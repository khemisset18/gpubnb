# GPUbnb — Current Project Status

_Last updated: 2026-09-10._

## Release qualification

The current automated qualification path on `main` exercises the real rental lifecycle rather than the old Developer-only shortcut: production `GPU_PROOF` runs before Developer preparation; activation requires genuine upstream code-server WebSocket traffic; recovery covers a real Agent restart while preserving a single runtime/allocation; post-stop verification proves per-session Docker cleanup and GPU reuse; and the live Developer container is required to expose exactly the `Accelerator.hardwareUuid` leased to the booking.

PR #183 was merged as `f92b6a8bf9742070c8d06b9d42c051cf878a4482` and qualified Host/Agent `0.6.4` improvements including the heartbeat/offline-grace work used by the current rental path.

PR #184 was merged as `427827122608dec64c069beb61b91c6664ce9412`. It adds fail-closed stale quarantined rental-claim recovery with strictly newer server authority/fencing, Agent `0.6.5`, thermal quarantine behavior at `>=98 °C`, local protective workload stop at 85 °C without calling that a Machine quarantine, diagnostic-owned thermal recovery, and owner-facing safe automatic quarantine resolution.

The corresponding Host prerelease `host-v0.2.0-beta.81` was published successfully, including `gpubnb-host-windows-x64.exe`; the post-publish Windows verification workflow completed successfully on the exact merge commit.

## Latest real PC A ↔ PC B attempt

The current-release physical PC A ↔ PC B qualification is still **NOT YET PASSED**. `docs/CURRENT_PHYSICAL_QUALIFICATION.md` remains the release-gate source of truth. The latest real attempt is recorded in `docs/PHYSICAL_QUALIFICATION_2026-09-10_BETA81.md`.

That attempt made material progress: PC B reached the real public `/workspace-gateway/...` route and rendered the code-server workbench, which is beyond the earlier stale local rental-claim failure where no usable Developer path reached the browser.

However, the attempt still fails the release gate. The first significant browser-side failure is the VS Code remote Management WebSocket handshake timing out repeatedly. After that, `vscode-remote://.../workspace` cannot be resolved and the editor/remote filesystem provider fails. A separate Service Worker scope/header compatibility defect is also confirmed. These are now the primary qualification blockers.

Until a clean current-release two-machine run records all required evidence, the correct project statement is:

> Automated qualification and Host publication are green, and the real public code-server shell now reaches PC B, but current-release physical PC A ↔ PC B qualification is still pending because the interactive VS Code remote WebSocket path is not yet stable.

## Current engineering priority

Do not hide the failure by only increasing timeouts. Correlate one failed open attempt across PC B browser timestamps, API `workspace_gateway_*` events, PC A `workspace_trace:*` events, and local code-server/container liveness. Identify the first missing or late event in:

`browser upgrade -> API gateway queue -> Agent ws_open -> local code-server WS -> 101/open ack -> first browser frame -> first upstream frame`

Then fix that exact boundary, add regression coverage for the observed failure, fix the workspace Service Worker scope/header compatibility, publish a new exact Host release if Host code changes, and repeat the complete physical gate.

## Historical status snapshot

The previous `PROJECT_STATUS.md` was a 2026-08-30 mission snapshot. It has been preserved unchanged at `docs/history/PROJECT_STATUS_2026-08-30.md` for audit/history purposes. Its statements about then-current branch state, test counts, limitations, or the harness shortcutting the real `GPU_PROOF` path are historical and must not be used as current release evidence.

## Next release action

1. Collect correlated browser/API/Agent traces from one failed Workspace open.
2. Fix the first proven WebSocket transport latency/failure boundary without weakening auth, fencing, queue bounds or cleanup invariants.
3. Add `Service-Worker-Allowed` handling scoped to authenticated workspace-browser responses and regression-test the prefixed code-server scope.
4. Extend E2E coverage to prove remote `/workspace` resolution, a small file read/write, terminal execution and sustained channel liveness — not merely page rendering or a raw WebSocket upgrade.
5. Publish and install the exact new release identity.
6. Execute one clean physical qualification using `docs/CURRENT_PHYSICAL_QUALIFICATION.md`: PC A hosts the real GPU/Agent, PC B books and opens the workspace through the configured public path, `nvidia-smi` inside the renter workspace proves the exact leased GPU, normal stop removes all per-session runtime resources, and the GPU/listing becomes available again.
7. Run the documented fault campaign only after that clean pass.
