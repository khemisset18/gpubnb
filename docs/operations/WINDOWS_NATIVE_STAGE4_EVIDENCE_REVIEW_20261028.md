# Stage 4 evidence continuation — 2026-10-28

Physical qualification: **BLOCKED**. Baseline is PR #307 merged at
`40e9ef5991ab13753130121fd321c60c84b4a297`, not the RDP feasibility branch.
This review performs repository/software work only: no PC1/PC2 access, signing,
certificate creation, trust/pin/boot/HVCI change, installation, Render operation,
reservation, quarantine mutation, physical probe or PR merge.

## Evidence reused, not rediagnosed

Read [PR #307](https://github.com/khemisset18/gpubnb/pull/307) and its
[correction](https://github.com/khemisset18/gpubnb/pull/307#issuecomment-6450709341).
The API run collection for the exact baseline still records all 15 original PR
workflows successful. Later CI entries include a cancelled run; that does not
invalidate those original successful checks. No old run was rerun.
Installed `oem176.inf` is 2026-09-28 / 9.3.32.4, rank 00FF0000; the exported
backup exists according to owner evidence. Candidate source is 2026-09-18 /
0.1.0.0, not installed. The expired September certificate and October certificate's
`/pa` success / `/kp` untrusted-root failure are established, not unknowns.
Avast's normal exit and a subsequent empty NVIDIA inventory do not establish
complete cleanup. Generation 90 remains quarantined.

## Exact virtual_display path and correction

1. `native/windows-idd/Driver.cpp`, `GPUbnbEvtIoDeviceControl`: validate fixed
   request, distinguish ValidateOnly, AssertNoMonitor, compile-time mutation gate,
   owner handle and monitor/adapter state. ValidateOnly success does **not** prove
   the mutation gate. `STATUS_NOT_SUPPORTED` at the gate is one possible cause.
2. `native/windows-platform/src/idd_control.rs`: interface discovery requires one
   exact interface, control open and DeviceIoControl map bounded Win32 classes.
   Access denied, contention, not-ready, invalid request, missing/ambiguous
   interface and gate refusal remain distinct. No raw path/error is forwarded.
3. `native/windows-stream-helper/src/service_runtime.rs`: the privileged Helper
   activates the display lease and maps PlatformError with
   `classify_virtual_display_failure`. The Worker receives the bound display
   specification for capture/NVENC; it is not the display-control authority.
4. `authority.rs`: bounded runtime codes survive self-test and control responses;
   `main.rs` emits `{"ok":false,"error":"<constant>"}`. Generic fallback remains
   valid for unmapped errors. Cleanup failure can take precedence.
5. `windows_native_workspace.py`: preflight already retains the precise code.
   **Fixed here:** `windows_native_runtime.py` previously discarded a nonzero
   START's structured error and omitted the new display classes for lifecycle
   commands. It now shares the existing constant allowlist and preserves
   `native_workspace_start_failed:<code>`. Unknown text still collapses. STOP of
   the exact session is still mandatory; failed proof appends
   `_cleanup_unverified`, retaining the gateway's claim-release fence.
6. `workspace_gateway_v10.py`: `_native_error_code` retains the bounded code in
   `native_helper_start_failed` and the runtime error callback. `cli.py` emits
   `workspace_gateway_error` and the already measured capability snapshot locally.
   **API boundary limitation:** `platform_info.py` intentionally projects the
   capability to boolean + GPU UUID; `client.py`/`server.ts` heartbeat and
   `windows-native-capability.ts` validate/store that projection, not the precise
   Helper reason. There is no detailed lifecycle-error API report in this path.
   An API false flag or cleanup reason cannot diagnose an IddCx failure. Do not
   invent a server receipt of a local code. A future diagnostic transport needs
   its own bounded authenticated schema; it is not required to change authority.

The historical generic `virtual_display` cannot be attributed to an old component
merely because current code has subcodes. Missing correlation is: incident-time
Helper/Agent executable SHA-256 and source/build identity; the exact installed
IddCx DLL/CAT/INF hashes and catalog membership; compiled mutation authority and
control ABI; and the timestamp-correlated bounded Agent/Helper failure. Worker
and media identities are also required for package coherence, but neither proves
the IddCx gate. FileVersion, INF extension, a valid Authenticode signature, a
current rebuild or an empty Code Integrity log subset cannot fill these gaps.
No `--self-test` is requested; it creates graphics resources.

## Package provenance and promotion verdict

Existing [package job](https://github.com/khemisset18/gpubnb/actions/runs/40513525078/job/122221263311)
was read, not rerun. Its manifest records these unsigned AMD64 payload hashes:

| Component | SHA-256 |
| --- | --- |
| Agent | `09557ef6939bcde0bf0482bb5b0e6f3b8a02e1797384cceeaca27e244590a666` |
| Helper | `c004f3ce3e818be6dcc4d9fde7bb7e6b44e8772398dfa7a5e4dedb0303012a4b` |
| Worker | `da98aee4f3a2923ec792064f9ddb8403dc100014e3fd63e22b6b3c117a9bae9e` |
| Media DLL | `1fd2ca37e24f882e230d812e6e1f521b8272fb7dc532f69d4cb5c6aab101b9a6` |

Manifest SHA-256: `545c794c4ed7de0e5963da016e964b3d0e92fcb23f343269c96245cf8f876b2b`.
Build-identities SHA-256: `34988de4a54c8fb0c38298b7355972edd656c5cb40db98c1ecccc8362a46bbbe`.
Inner package ZIP (job log): `0054a79e706109a9b32e7fba013b8b56fc9bf842cb4404ad03a9093077759065`.
Actions artifact 12737519266 outer ZIP digest (artifact API):
`d5b57c498ea9c884e7f29cc93a1ab9773608fa1406770892e29eba446ff85854`.
These ZIP hashes identify different layers; do not interchange them. The artifact
was subsequently downloaded and both ZIP digests independently matched. The
non-executing Python verifier passed on the extracted payload: 4/4 files, unsigned,
Authenticode not verified, hardwareQualified=false. This resolves archive integrity,
not signer or installation authority.

The publisher policy pin is
`88662fb76d4237aa3842ad1ad8d0378a17ffb82d022f860b297ed85e2c08c99a`.
For unsigned files it is a configured expected signer, **not an observed signer**.
The verifier checks exact commit, hashes, PE architecture/imports, embedded
Helper→Worker and Worker→media pins, Helper release-candidate authority, Agent
0.6.6/short commit, worker protocol 1, media transport 2, browser media/input 1,
media ABI 2 and NVENC API 13.0. CI executes inert identities; none is host proof.

**Promotion refused:** that four-component package excludes API and IddCx and
predates this Agent fix. It is explicitly non-installable and unqualified. No
complete six-component signed release exists in the evidence. For a future
candidate use the resulting review commit as the single source revision for API,
Agent, Helper, Worker, media and driver; record final signed payload hashes,
unchanged pin match, build flags, driver ABI/CAT membership and independently
obtained manifest hash. API deployment identity must be proved from deployment
provenance; `/health` alone does not expose an exact revision. No deployment is
authorized here. Do not relabel the baseline ZIP as containing this correction.

PnP compares rank first, then date, then version. At equal rank the candidate's
older date loses; a future signed candidate's rank is unknown. Never force it or
edit a signed INF. Export success is not rollback qualification: retain the
original package, verify catalog/payload hashes and policy acceptance, document
the exact restoration procedure and obtain authorization before any installation
or rollback. Do not delete either package to manipulate selection.

## Windows 11 / Secure Boot and zero-euro gate

Official Microsoft documentation rechecked on 2026-10-28:
[signing options](https://learn.microsoft.com/en-us/windows-hardware/drivers/dashboard/driver-signing-offerings),
[attestation](https://learn.microsoft.com/en-us/windows-hardware/drivers/dashboard/code-signing-attestation),
[EV requirements](https://learn.microsoft.com/en-us/windows-hardware/drivers/dashboard/code-signing-reqs),
[ranking](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/overview-of-the-driver-selection-process),
[PnPUtil](https://learn.microsoft.com/en-us/windows-hardware/drivers/devtest/pnputil-command-syntax).
WHCP/HLK is the certification route; attestation has testing limitations and
requires an EV-associated Hardware Developer account. Documentation does not
establish that the owner already has those prerequisites at zero incremental cost.
Preproduction/CoDev/registry provisioning is not an acceptable workaround under
the instruction to leave trust and code-integrity configuration unchanged.
No certificate, signature, submission, account contact or purchase was performed.

Authorized engineering work here: **0 € incremental spend**. A deployable native
driver-signing route at **0 € is unproven**, so none is proposed as available.
Do not price an unknown certificate/account/submission path at zero, assume a
local `/pa` signature satisfies `/kp`, rotate pins, or disable Secure Boot/HVCI.
An already available accepted package would still need exact provenance and
policy verification. A signed unrelated display driver does not implement this ABI.

The [separate RDP study](https://github.com/khemisset18/gpubnb/blob/codex/stage4-rdp-feasibility/docs/architecture/WINDOWS_NATIVE_RDP_ALTERNATIVE_FEASIBILITY_20261028.md)
is not the Stage 4 base. Its Windows edition, isolated renter identity, browser
client, private relay, actual NVIDIA encoding and total 0 € cost remain unproven.
No RDP implementation or new infrastructure is justified by current evidence.
An RDP pass cannot qualify IddCx/GBNM/GBNI GPUbnb Native.

## Quarantine protocol review

`NativeQuarantineRecovery` retains PHYSICAL_GPU_LOCK, exact diagnostic/session/
resource/GPU scope, holder/fence consistency, absence of retained process identity,
and server v2 body-signed authorization. API authority rejects live allocations,
leases, workspaces/mining, unknown native obligations, lost/regressed Redis fence,
stale scope and replay. Preparation does STOP/AssertNoMonitor and canonical
three-sample NVIDIA proof without rewriting stores. The normal Docker/GPU
diagnostic remains mandatory. Finish repeats server/physical proofs, retains the
existing authoritative floor in a STOPPED tombstone, and only then releases via
`release_after_cleanup`. Interrupted recovery is reproved. Docker-only evidence,
QUIET snapshots and empty PID fields cannot retire quarantine. No recovery path,
lock, fence or evidence record was modified in this change.

## Final PC1 → PC2 campaign, not executed

1. Before host action: coherent six-component provenance, accepted driver/pins,
   ABI/compile authority, PnP decision and verified rollback. Keep listing paused.
   Installation and physical operations require separate authorization.
2. Use the existing fresh owner/admin DiagnosticRun recovery, not a new booking.
   Signed exact scope + STOP/monitor absence + canonical NVIDIA proof + normal
   Docker/GPU diagnostic + repeated proofs must retire generation 90 canonically.
   Any failure stops the campaign with fences retained.
3. Only after those gates, use the existing free private qualification flow with
   exact GPU/session/generation authorization. Prove nonce-bound isolated display
   and exclusion of all provider outputs. Capture actual pixels, NVIDIA adapter
   UUID/LUID and NVENC H.264 output; browser decode must advance. No software
   encoder, policy setting, timer or still image substitutes for those proofs.
4. Record visible keyboard **and** mouse effects in the renter session. Capture
   300 uninterrupted seconds with the existing 3-second continuity gap bound;
   measure decoded frames. Test reconnect separately with fresh media capability
   and reproof; a reconnect inside the measured window restarts continuity.
5. STOP: prove exact worker/helper exit, absent monitor, capture/encoder/input and
   listener release, no outstanding local/server lease/allocation, canonical GPU
   quiescence. Keep signed scoped evidence and retained fence/tombstone. Refuse
   readiness on missing cleanup. Neither successful billing release nor an RDP
   connection establishes these results.

## Software validation for this correction

Local Linux, mocked helper/host boundaries, no PC1/PC2 commands:
- `PYTHONPATH=../test-deps:agent python -m unittest discover -s agent/tests -p test_windows_native_runtime.py -q`: 43 passed.
- `PYTHONPATH=../test-deps:agent python -m unittest discover -s agent/tests -p 'test_windows_native_*.py' -q`: 126 passed (includes the 43).
- Existing baseline package downloaded, outer/inner SHA-256 matched; `verify_stage4_package.py verify` with the independently read baseline commit, manifest hash and publisher pin: 4/4 passed, no binary executed. This check addressed package provenance rather than rerunning old CI.
- `git diff --check`: passed.
The first test import needed websocket-client installed in an isolated scratch
dependency directory; after installation the above tests passed. No Windows
build, signing, API deployment or physical qualification is claimed.
