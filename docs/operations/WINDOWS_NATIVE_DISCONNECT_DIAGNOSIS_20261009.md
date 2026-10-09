# Stage 4 disconnect investigation — 9 October 2026

Status: software defects identified; physical five-minute acceptance NOT demonstrated.
Baseline: `cf7130c410d89b5e05a7549fd034126b8718994e`.
Corrected code: `fe0b1cde539abb71e289e1875b0cc9dc32f1629d`, draft PR #285.
No PC1 operation, deployment, merge, public bookability change, or DB mutation is authorized by this report.

## Evidence and limits

Read-only Render logs were retrieved from `srv-dau86i2d0e5s73elmk10`,
the private qualification service. A complete query of connection/open/close,
input rejection, pump/send failure and backpressure events returned 112 records
for the two sessions below, without pagination remaining. These events do not
contain browser decoder errors, Agent local exceptions or worker media diagnostics.
The deployed close events lack closeCode; source HEAD diagnostics therefore cannot
be assumed present in the tested installation. Exact deployed Agent/helper/DLL
hashes and browser build remain unverified.

The complete bounded event sequence is retained in
`WINDOWS_NATIVE_DISCONNECT_TIMELINE_20261009.json`; it contains only event,
time, session/channel identifiers and bounded failure metadata, not payloads,
cookies, media tokens or decoder data.

The supplied `ConnectionAbortedError`, `WinError 10058` and `409 unknown_gateway_channel`
are confirmed symptoms from the owner's tests, not independently timestamped
local evidence available to this investigation. Do not invent their position in
the physical chronology.

## Measured chronology (UTC; Paris = UTC + 2)

Session A: `cmv16b61700waju0ttaizkjn6`.

| Time UTC | Channel | Observed event |
| --- | --- | --- |
| 16:22:23.424 | 25b701f1 | Browser connection |
| 16:22:23.985 | 25b701f1 | Agent reports native media connect failure |
| 16:22:33.987 | 25b701f1 | Browser connection closed |
| 16:22:44.654 | 2a49eacc | Browser connection |
| 16:22:45.190 | 2a49eacc | Upstream opened |
| 16:22:49.132 | 2a49eacc | Closed, 3.942 s after upstream open |
| 16:25:33.518 | 21d327a1 | Upstream opened |
| 16:25:36.324 | 21d327a1 | Native input rejected: 32 bytes, frameKind=text |
| 16:25:36.390 | 21d327a1 | Closed 66 ms after input rejection |
| 16:28:18.818 | 708ed85c | Last observed upstream opening |
| 16:29:39.006 | 708ed85c | Closed, 80.188 s after upstream open |

Session B: `cmv1b7hhh000ob71bn8ziy9uy`.

| Time UTC | Channel | Observed event |
| --- | --- | --- |
| 18:40:03.550 | f7e60604 | Native connect failure |
| 18:40:24.947 | b15c3553 | Native connect failure |
| 18:40:47.432 | bc693f2c | Upstream opened |
| 18:41:02.639 | bc693f2c | Closed, 15.207 s after open |
| 18:41:03.416 | a29475c5 | Upstream opened |
| 18:41:06.518 | a29475c5 | Closed, 3.102 s after open |
| 18:41:07.017 | 4c03a332 | Upstream opened |
| 18:41:08.940 | 4c03a332 | Closed, 1.923 s after open |
| 18:41:13.320 | e14cfcd3 | Native connect failure |
| 18:41:53.742 | ff26fce4 | Upstream open timeout, 15.010 s after browser connection |
| 18:42:34.329 | 02b163bc | Upstream open timeout, 15.021 s after browser connection |
| 18:43:36.851 | 1ef2ac68 | Native connect failure |

These measurements prove repeated short-lived upstreams and subsequent handshake
failures. They do NOT prove which component initiated every closure in Session B.
No gateway pump/send/backpressure event was returned by the complete query.
Absence of an event is not proof of absence of network/decoder pressure.

## Demonstrated defects and changes

### Gateway binary opcode interpretation

Both package locks pin `ws@7.5.13`. Its `receiverOnMessage(data)` emits one argument.
Its receiver emits binary as Buffer/ArrayBuffer/Buffer[] (binaryType), and text as
string. The gateway used the ws 8 callback `(data, isBinary)` and passed the absent
second argument into a binary-only native input gate. A valid 32-byte binary input
was thus rejected and the gateway initiated close code 1003. Session A's
16:25:36 event directly matches this defect. The browser sends input as Blob.

The fix interprets the installed library's message representation when explicit
opcode metadata is absent. Explicit boolean metadata, when supplied, wins,
including Buffer-backed text. Text bytes remain supported for container sessions
and remain rejected for native sessions. No content-based binary inference occurs.

The new test uses actual ws TCP peers and native input policy: repeated binary
messages accepted, equal-length text rejected, then another binary message accepted.
The old absent-metadata assumption makes this regression test fail.

### Helper partial TCP delivery stalls the media loop

The helper peeked only two header bytes and then called blocking read_exact for
mask/payload. A split TCP frame could hold the single input/media thread for its
15-second socket timeout, without producing video or checking the connection epoch.
The fix peeks the complete bounded input/control frame (maximum 133 bytes), consumes
only complete frames, and rejects an incomplete frame after the existing 15-second
deadline. All masking, size, opcode, token and epoch checks remain enforced.

New Windows helper tests cover byte-by-byte delivery without discarding bytes,
incomplete-frame expiry, malformed headers, and EOF followed by new loopback peers.
This defect is independently reproducible; attribution to a physical test still
requires the local trace. The helper's server module is Windows-only: Linux unit
test success alone does not execute these new tests.

### Meaning of cf7130c

Peer resets at peek can terminate the listener before the earlier `5cad78df` fix.
`cf7130c` additionally classifies peer write errors as StaleConnection and adds
BrokenPipe handling. However, both Response and StaleConnection already continue
the outer accept loop. That write classification alone is not proof of a changed
reconnect outcome or a fix for the initial closure.

The baseline Windows/Ubuntu workflow `37976213660` built and tested successfully,
then failed rustfmt on qualification_server.rs. The formatting is corrected here;
the gate is retained. Baseline artifact `11639720902` is linked to cf7130c, but
later Windows platform/worker/candidate checks were skipped after the style failure.

## Capture, NVENC, queues and lifecycle review

- Capture uses Windows Graphics Capture CreateFreeThreaded, not DXGI duplication.
  The acquired frame object remains alive through texture copy. Empty polls are
  bounded to 250 ms in the worker; no-frame is accepted only with exact GPU mapping.
  Capture loss, adapter mismatch and NVENC failure remain terminal diagnostics.
- NVENC uses synchronous encode/LockBitstream with low-latency configuration and
  a forced first IDR plus SPS/PPS. It runs in the renter worker. No NVENC diagnostic
  from the failed physical runs is available; neither GPU nor codec failure is
  established as root cause. Do not change driver/API compatibility speculatively.
- Browser reassembly requires contiguous frame/chunk sequence, 8 MiB frame limit,
  1 MiB chunk limit and 2 s partial-frame timeout. decodeQueueSize >= 4 closes
  the client. Burst decode pressure remains a hypothesis requiring the browser's
  exact error, frame timing and queue observation.
- Agent transport has 256-item/12 MiB outbound budget and a 2 s queue wait; signed
  HTTPS micro-batches traverse Render/Redis. Native socket connect timeout is
  10 s and removed after connection. Reader/sender teardown can generate late
  frames after gateway channel deletion; 409 is then a downstream symptom.
- Gateway upstream ACK timeout is 15 s. Browser pressure has an 8 MiB high-water
  mark and a 30 s deadline. Runtime mutex spans capture/read and socket write to
  serialize suspension with delivery; this invariant is preserved.
- Fresh proof, capability rotation, GPU identity, renter session, lease and billing
  activation remain unchanged. No reconnect delay, queue budget or security gate
  is relaxed by the patch.

## Applicable primary documentation

- [Microsoft: Graphics Capture CreateFreeThreaded](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.direct3d11captureframepool.createfreethreaded)
- [Microsoft: TryGetNextFrame](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.direct3d11captureframepool.trygetnextframe)
- [Microsoft: Winsock error codes](https://learn.microsoft.com/en-us/windows/win32/winsock/windows-sockets-error-codes-2)
  WSAESHUTDOWN 10058 means an operation after shutdown; it does not explain why
  the shutdown occurred. WSAECONNABORTED 10053 can follow timeout or protocol error.
- [NVIDIA NVENC 13.0 programming guide](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/)
  Blocking output retrieval belongs outside the main submission thread. The
  current worker serializes one frame per command; latency needs physical measurement.
- [ws 7.5.13 receiver source](https://github.com/websockets/ws/blob/7.5.13/lib/receiver.js)
- [ws 7.5.13 message forwarding](https://github.com/websockets/ws/blob/7.5.13/lib/websocket.js)

## Validation and remaining acceptance gate

Local: API TypeScript build passed; 66 targeted API tests passed (1 skipped);
25 browser tests passed; 626 Agent tests passed (3 skipped); 96 Linux helper
tests, 49 platform tests and 9 worker tests passed. A supplemental local harness
compiled the actual qualification_server module with a stub graphics runtime:
14 transport tests passed; restoring the baseline TCP reader makes the split-frame
test fail after the 100 ms test socket deadline. This harness proves socket
behavior, not graphics integration. The restored ws7 metadata assumption also
makes the new real-peer regression fail (undefined instead of true).
Clippy was run through clippy-driver because this environment lacks /proc/self/exe.
Full local API execution requires PostgreSQL/Redis; its unavailable-DB failures
are not claimed as passing CI. The additional local serializable-guard script
reports six pre-existing call sites outside this patch.

All seven workflows triggered for corrected code commit `fe0b1cde` completed
SUCCESS. No failed check was disabled or skipped to obtain this result.

| Workflow | Run |
| --- | --- |
| CI | 37978709771 |
| windows-native-stream-helper | 37978709636 |
| workspace-reliability | 37978709862 |
| prephysical-qualification | 37978709857 |
| deployment-readiness | 37978709924 |
| code-security | 37978709847 |
| api-mining-ci | 37978709821 |

The Windows helper job directly ran all four new socket tests successfully:
104 library + 10 CLI unit + 3 CLI integration tests; platform 58 tests;
worker 11 tests; qualification harness 1 test. Both helper jobs passed the
retained fmt/Clippy gates. The Windows candidate build and missing-lease
fail-closed self-test also passed. CI runs exercise their configured scope;
untriggered workflows are not falsely reported as rerun.

Artifact verification is retained in `WINDOWS_NATIVE_CANDIDATE_FE0B1CDE.json`.
Artifact `11639950809` is bound to code commit `fe0b1cde`; the downloaded archive
SHA-256 matches GitHub's recorded digest. It contains exactly the AMD64 PE32+
helper (465408 bytes), file SHA-256
`6957c09bfe2afea15718a8740b8ea738236a3274dfa9b9da1fcb0d573fbb905c`.
Its PE certificate table is empty: this CI binary is UNSIGNED and is not an
installable/promoted candidate. No worker or media DLL was replaced. The later
release-candidate compilation validates that feature's build, but the uploaded
artifact was produced earlier under physical-qualification; do not confuse them.
Any controlled signing requires the owner's authorized qualification identity
and recording the resulting signed file hash and signer before installation.

Before any approved PC1 intervention, record candidate commit, all required CI
results, Windows artifact archive/file hashes, PE architecture, signer/provenance,
and coherent Agent/helper/worker/media DLL versions. CI artifacts are not proof
of production signing or real GPU execution.

Require explicit owner approval for any private backend deployment or PC1 helper
replacement. Then collect synchronized browser, gateway, Agent and helper/worker
logs for one controlled rental. Require at least 300 seconds of visible video
and repeated keyboard/mouse interaction, without repeated reconnects. Check
suspension/revocation, accounting, cleanup and absence of quarantine through the
normal authorized lifecycle. Stop and preserve first-failure evidence if it fails.

Without that authorized physical run, status remains NOT QUALIFIED. Existing
blocked PRs remain blocked and public Windows Native reservations remain closed.
