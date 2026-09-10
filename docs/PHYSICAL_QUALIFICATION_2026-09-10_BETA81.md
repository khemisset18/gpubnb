# Physical qualification result — Host beta.81 / Agent 0.6.5 — 2026-09-10

Status: **FAILED / PARTIAL PHYSICAL PASS — release gate remains NOT PASSED**.

This record captures the latest real PC A ↔ PC B qualification attempt and the exact remaining blocker. It is intentionally strict: loading the code-server browser shell is progress, but it is not enough to mark the physical qualification gate as passed.

## Release identity under test

- Repository base commit: `427827122608dec64c069beb61b91c6664ce9412` (merge of PR #184).
- Published Host release: `host-v0.2.0-beta.81`.
- Agent source version at that commit: `0.6.5`.
- Windows installer asset: `gpubnb-host-windows-x64.exe`.
- Windows installer SHA-256: `e24520605ce82efc4e39507fe9e981fefd7d765e287390d0338b1739335769e2`.
- Public workspace path observed from PC B: `https://gpubnb.onrender.com/workspace-gateway/...`.
- Exact PC A `build-info` for the beta.81 install still needs to be captured in the final passing qualification record; do not infer it only from the release that was downloaded.

## What has been completed before this attempt

### Host / Agent reliability

- PR #183 increased the normal heartbeat/offline tolerance so ordinary heartbeat jitter does not prematurely invalidate a healthy rental.
- PR #184 added fail-closed stale quarantined rental-claim recovery. A quarantined local claim is superseded only when a newly fetched authority has a strictly newer fence, a different lease, matching resource/hardware identity, no live conflicting runtime identity, and a fresh physical GPU quiescence proof.
- Recovery does not delete `C:\ProgramData\GPUbnb`, does not force-clear quarantine, and does not transfer business authority to local state.
- Agent version was advanced to `0.6.5` and published in Host beta.81.

### Thermal safety / quarantine behavior

- Server thermal quarantine threshold is `>= 98 °C`.
- Temperature below 98 °C alone does not create a thermal server quarantine.
- Local Host protection may stop workload earlier at 85 °C; that protective stop is not a Machine quarantine.
- Thermal recovery requires cooling proof (<= 90 °C) and then a real diagnostic before quarantine can clear.
- Owner UI exposes the durable quarantine cause and a safe automatic-resolution path rather than requiring ProgramData deletion or a force clear.
- The physical qualification must not intentionally heat real hardware to 98 °C. Boundary behavior is covered by automated tests/simulation; physical qualification validates normal safe operation and telemetry.

### Build / publication qualification

- Exact-head PR #184 CI was green before merge.
- The beta.81 publish completed.
- `post-publish-host-windows-verify` completed successfully for commit `427827122608dec64c069beb61b91c6664ce9412`.

## Real physical progress observed on 2026-09-10

PC B reached the real public Developer Workspace route and received the code-server workbench UI. This proves substantially more of the real path than the earlier failure where no persistent Developer workspace could be opened:

1. the renter reached the public GPUbnb workspace gateway;
2. authenticated workspace bootstrap/HTTP routing was sufficient to deliver the code-server shell;
3. the Explorer/workbench/chat UI rendered in the browser;
4. the flow progressed past the historical stale local rental-claim blocker that previously prevented the Developer runtime path from reaching the browser at all.

This is a **partial physical success only**. It does not prove a usable remote filesystem or stable interactive channel.

## First real failure in the latest attempt

Browser-side code-server logs show the first significant failure after the initial page is delivered:

- connection token resolves immediately;
- the browser creates the Management socket successfully;
- the initial `WebSocket(gpubnb.onrender.com:443)` handshake then times out;
- retries repeat at roughly ten-second intervals;
- after the remote connection fails, the browser reports errors such as `Unable to resolve resource vscode-remote://gpubnb.onrender.com/workspace`, `ENOPRO: No file system provider found`, and editor-open failures.

The visible workbench can therefore appear even though the VS Code remote Management/ExtensionHost transport is not fully established. The white page / delayed workbench / later UI is consistent with startup assets arriving over HTTP while the remote interactive WebSocket path is still failing or retrying.

### Primary blocker

**Developer Workspace WebSocket opening/ack/first-frame path is not yet physically qualified.**

The current server code allows an upstream-open acknowledgement window of 15 seconds (`WS_UPSTREAM_OPEN_TIMEOUT_MS = 15_000`). The Host local WebSocket connect path uses a 10-second connection timeout. The browser trace itself is timing out on a similar order of magnitude. These deadlines are not proof of the root cause by themselves, but they create a fragile budget and must be correlated with the Host/API traces instead of being increased blindly.

The next diagnostic must determine the first missing event in this exact chain:

`browser upgrade -> API gateway queue -> Agent receives ws_open -> Agent opens local code-server WS -> Agent posts 101/open ack -> browser channel accepted -> first browser frame relayed -> first upstream frame returned`

### Secondary confirmed defect

The browser also reports a Service Worker registration failure because the requested scope is `/workspace-gateway/<session>/` while the service worker script is served below `/_static/out/browser/serviceWorker.js`, and the response does not currently grant the wider scope with `Service-Worker-Allowed`.

This is a real gateway/browser compatibility defect and should be fixed, but it is not sufficient evidence for the Management WebSocket timeout root cause.

### Secondary symptoms after remote-channel failure

The following errors appear after or alongside the failed remote channel and must not be mistaken for the first root cause:

- `Unable to resolve resource vscode-remote://.../workspace`;
- `ENOPRO: No file system provider found` for workspace, chat, Copilot/Claude/GitHub instruction locations and workspace storage;
- GitHub authentication-provider registration timeout;
- ChatSessionStore / chat editing-session persistence failures.

Most of these depend on a functioning remote filesystem/provider and should be re-evaluated after the Management/ExtensionHost channel is fixed.

## Professional fix plan

### Phase 1 — Correlate one failed browser open end-to-end

Before changing timeout values, collect one correlation timeline from the exact same workspace-open attempt:

1. PC B browser timestamp for the first Management WebSocket creation and timeout.
2. API gateway events for the same access request/session/channel, including `workspace_gateway_*` open/failed events and request/channel correlation IDs.
3. PC A Agent `workspace_trace:*` events, especially:
   - `ws_open_received`;
   - `ws_local_connected`;
   - `ws_open_failed`;
   - open-ack timing;
   - `ws_first_browser_frame_relayed`;
   - upstream frame/close/backpressure errors.
4. Local code-server/container liveness at the same timestamps.

The first absent or late event is the root-cause boundary. Do not patch downstream symptoms before this is known.

### Phase 2 — Fix transport behavior, not only symptoms

Depending on the Phase 1 boundary:

- If Agent receipt is late: fix API/Redis queue polling/wakeup latency and ensure the control loop is never blocked by slow HTTP or reconciliation work.
- If local WS connect is late/failing: prove code-server readiness before advertising `canOpen`, tighten readiness to the real WS endpoint, and keep local connect diagnostics explicit.
- If the 101/open acknowledgement is late: make the open-ack path independent from long-running frame readers and slow unrelated control-plane requests.
- If the browser sends frames but Host does not relay promptly: fix browser-frame queueing/backpressure while preserving frame order/idempotence.
- If Host returns frames but browser never receives them: fix the API WebSocket outbound path / buffering / close handling and prove first-frame delivery.

Timeouts should then be aligned as a safety margin around measured normal latency. A healthy local Developer channel should normally open far below the hard timeout; raising all deadlines without fixing the delayed stage is not an acceptable qualification fix.

### Phase 3 — Fix browser gateway compatibility

- Add an authenticated workspace-scoped `Service-Worker-Allowed` response header that permits the session gateway root required by code-server.
- Add a regression test proving the header is present only on workspace browser responses and does not weaken unrelated API routes.
- Re-test code-server service worker registration through the real prefixed `/workspace-gateway/<session>/` path.

### Phase 4 — Add regression coverage for the exact physical failure

Add automated tests that would fail on the current behavior or on future regressions:

- API contract/integration test for WebSocket open acknowledgement timing and correlation.
- Agent test proving local WS connect, immediate 101/open ack, and first-frame relay are not blocked by concurrent HTTP startup bursts.
- Browser/gateway test for the prefixed Service Worker scope/header.
- E2E test that does more than establish a WebSocket: open the real code-server workspace, resolve `/workspace`, create/read a small file, open a terminal command, and keep the channel alive across a realistic idle period.
- Preserve bounded queues, payload limits, auth/session isolation, fencing, and fail-closed behavior while making the transport reliable.

### Phase 5 — Repeat the clean physical PC A ↔ PC B qualification

A final passing run must still prove every item in `docs/CURRENT_PHYSICAL_QUALIFICATION.md`, including:

1. exact beta/release identities captured on both machines/server;
2. real booking and exact GPU allocation;
3. successful `GPU_PROOF` on the leased hardware UUID;
4. persistent Developer runtime and gateway registration;
5. PC B opens a genuinely usable remote `/workspace` with no Management/ExtensionHost handshake timeout;
6. `nvidia-smi` inside PC B's renter workspace shows the exact leased GPU;
7. stable interactive use long enough to prove no heartbeat/gateway flap;
8. normal stop without manual container deletion or database mutation;
9. container/proxy/volume/per-session-network cleanup;
10. claim/resource/listing release and immediate safe GPU reuse.

Only after all ten are proven in one coherent current-release lifecycle may `docs/CURRENT_PHYSICAL_QUALIFICATION.md` be changed to `PASSED`.

## Definition of done for the next fix PR

The next Workspace transport PR is ready to merge only when:

- the root-cause boundary is backed by timestamped browser + API + Agent evidence;
- the fix is targeted to that boundary;
- Service Worker scope compatibility is fixed separately but in the same qualification campaign if appropriate;
- new regression tests cover the exact failure mode;
- existing workspace security, fencing, quarantine, resource cleanup and payload-bound tests stay green;
- Windows Host CI and post-publish verification stay green;
- a new exact release is published;
- one fresh PC A ↔ PC B physical run passes the complete gate.

## Current project statement

> Host beta.81 / Agent 0.6.5 reaches the real public code-server workbench and has eliminated the previously observed stale local rental-claim blocker, but the latest physical PC A ↔ PC B attempt still fails the release gate because the VS Code remote Management/ExtensionHost WebSocket path times out before the remote filesystem is reliably available. The next work is a correlated transport fix, browser Service Worker scope fix, regression coverage, and then one clean full physical requalification.
