# Product E2E attempt — 2026-08-17

## Scope

This record supplements `P2P_PHYSICAL_QUALIFICATION_2026-08-17.md` with the first private-beta product-level booking attempt performed after the successful physical P2P and physical GPU runner qualifications.

No private signing key, TLS private key, raw peer endpoint list, session cookie, payment credential, or other secret is recorded here.

## Previously proven physical evidence

The following evidence remains valid and is not changed by the failed product-level attempt:

- same-network authenticated direct QUIC: success, direct path, no relay;
- two physical machines on different Internet access networks: authenticated `DIRECT_HOST` success, no relay fallback;
- PC A physical NVIDIA GeForce GTX 1650: the real GPUbnb `run_gpu_proof_workspace()` runner completed the official immutable GPU proof image for 30 seconds with `gpuDetected=true`, `iterations=7441`, and `containerCleaned=true`.

These proofs are separate. They do not by themselves prove a complete marketplace booking flow, and they do not prove that GPU workload payload bytes traverse the direct P2P QUIC path.

## Product-level attempt result

**Result: NOT QUALIFIED / INCONCLUSIVE.**

A real renter booking was created from PC B against the real PC A listing. The product UI reached a `PREPARING` state, but the attempt did not produce sufficient evidence that the intended `GPU_PROOF` job had been created, claimed, executed, finalized, and reflected back to the renter UI. The test was stopped and both physical PCs were shut down. No success claim is made for the product E2E.

## Host evidence observed during the attempt

The source Agent on PC A continued to report healthy signed heartbeats with:

```text
ok=true
publishable=true
agentUpgradeRequired=false
acceleratorSecurity.severity=NONE
```

Earlier in the same Agent log, the product attempt exposed two resource-authority failures:

```text
rental_resource_authority_missing_for_session
rental_gpu_resource_mapping_missing
```

A prior `job_completed` event was also present, but its type was not identified. It must not be represented as a completed `GPU_PROOF`.

## Resource-authority integration defect

The modern accelerator heartbeat path synchronized `MachineAccelerator` inventory, while rental resource authority still resolves a GPU through the legacy `Accelerator -> MiningResource` mapping. A host could therefore be healthy, online and publishable while the rental authority had no GPU resource mapping for the same physical GPU.

Commit `81e9cd6d7007b9ad18d595fc229e5fe138ba2259` adds `syncGpuMiningResourcesFromAccelerators()` to the same heartbeat transaction. The bridge:

- derives stable GPU resource keys from the hardware/device UUID;
- upserts the legacy `Accelerator` row;
- upserts/enables the corresponding `MiningResource`;
- disables stale GPU resources for the same machine;
- preserves CPU resource handling.

Before deployment, the targeted mining-resource stability tests passed `2/2` and the API TypeScript build completed successfully. After the exact commit was deployed, recent Agent log tails showed healthy heartbeats and no new `rental_gpu_resource_mapping_missing` entry. Historical errors remained in the log and must not be confused with post-deploy failures.

This stopped one observed blocker, but it did not prove that the existing pre-fix reservation recovered or that a new `GPU_PROOF` executed.

## Product-routing defects found after the physical attempt was stopped

A full source-path review found two additional integration defects that should have been checked before asking for another physical run.

### 1. Marketplace exposed an unregistered Developer renter flow

`compatibleWorkspaceChoices()` exposed both `developer` and `compute` as executable beta choices. However, the main `server.ts` did not import or call `registerWorkspaceRenterRoutes()` from `workspace-renter-routes.ts`.

Consequently, the UI could offer `Developer Workspace` even though its renter routes were not registered in the running main API process. Source-presence tests had verified the separate module by reading its file, but did not verify route registration in the real server.

### 2. Bookings UI followed Developer instead of Compute/GPU_PROOF

`apps/web/workspace-bookings.js` queried the Developer-specific `/bookings/:bookingId/workspace` endpoint for every booking. On a 404 it displayed `Préparer Developer` and called `/bookings/:bookingId/workspace/developer`.

This meant a valid Compute/GPU_PROOF booking could be presented as if no workspace existed, and the recovery UI could steer the renter toward the unrelated Developer path.

The registered Compute route itself is correct: `POST /bookings/:bookingId/workspace-sessions` accepts `{"workspaceSlug":"compute"}` and `ensureComputePreparation()` creates a `GPU_PROOF` job.

## Corrective private-beta routing changes

The private-beta marketplace is now fail-closed to the path that is actually registered and tied to the qualified GPU proof runtime:

- public workspace discovery exposes only `compute`;
- the workspace chooser refuses any non-`compute` slug;
- the bookings page follows `GPU_PROOF` jobs returned by `/dashboard`;
- the bookings page prepares Compute through `POST /bookings/:bookingId/workspace-sessions` with `{"workspaceSlug":"compute"}`;
- it no longer falls back to `Developer` when a Compute booking has no Developer-specific workspace response;
- regression tests assert that the private-beta marketplace exposes only Compute, that the server Compute route creates `GPU_PROOF`, and that the bookings UI never uses the Developer fallback.

Developer code remains in the repository but is intentionally not offered in the private-beta marketplace until its renter route module is explicitly registered in the main server and covered by a real route-level integration test.

## Agent GPU_PROOF orchestration qualification

The earlier physical GTX 1650 qualification proved the GPU runner itself, but not the complete Agent job orchestration around that runner. A dedicated Agent regression now exercises the full `GPU_PROOF` control flow without requiring a physical machine.

The test verifies:

- the official pinned Compute/GPU proof image is selected;
- Agent job state advances through `DOWNLOADING -> PREPARING -> RUNNING -> UPLOADING_RESULTS`;
- signed workspace-session metrics are emitted with `workloadProof=true` and five-second intervals;
- `complete` carries the fenced `attemptId` and `leaseToken` and contains `gpuDetected=true` and `containerCleaned=true`;
- `complete` occurs before `finalize-proof`;
- finalization carries the same fenced credentials;
- the Agent emits `job_completed` and does not emit `job_failed` on the success path.

A second regression simulates a lost terminal HTTP response. `agent_request()` retries the same terminal body with a new anti-replay nonce and signature, allowing the server's idempotent terminal handling to return the already-completed result safely.

At the qualified runtime head, the Agent suite completed with:

```text
217 tests
OK
skipped=1
```

Both new GPU proof orchestration tests were observed executing successfully in the CI log; they were not skipped.

## Qualified Agent version boundary

The runtime fixes originally remained labeled `0.6.0`, which was unsafe because the already published Host release also contains an older Agent `0.6.0`. Heartbeat/job policy therefore could not distinguish an older installer from the corrected runtime using version alone.

The corrected runtime is now explicitly versioned **Agent `0.6.1`** in both package metadata and runtime code. The API job-lease protocol minimum is also `0.6.1`.

The job claim endpoint fails closed before claim: an Agent below the minimum receives HTTP `426` with `agent_upgrade_required` and cannot acquire a rental job. Regression coverage explicitly rejects `0.5.5` and `0.6.0`, while accepting `0.6.1` and newer compatible versions.

The public `host-test-latest` release inspected during this qualification still targets commit:

```text
aad1c905eea7d2404f998f479ca0280fd9c2163e
```

That commit packages Agent `0.6.0`. Therefore the currently published Host installer is **not** the qualified `0.6.1` build and must not be used as evidence for the corrected product flow.

## Host download contract defects and corrections

The website download function expected `gpubnb-host-windows-x64.zip`, but the published release contains the installable `gpubnb-host-windows-x64.exe` and a separately named portable archive. The expected ZIP therefore did not exist.

The Windows download contract now points to the installable:

```text
gpubnb-host-windows-x64.exe
```

The Host install page was also inconsistent: it still instructed Windows users to extract a ZIP and launch a portable executable. It now describes the EXE installer, and it visibly exposes the release's immutable target commit and SHA-256 checksum before download.

Regression tests lock the web download filename to the installer asset produced by the publication workflow and reject the obsolete ZIP/portable instructions.

## Windows installer software qualification

The release and PR preflight checks were strengthened to compare the embedded Agent version against `agent/pyproject.toml`, rather than merely checking that `gpubnb-agent version` exits successfully.

The PR Windows preflight verifies the exact version at three boundaries:

1. source-installed Agent CLI;
2. standalone PyInstaller `gpubnb-agent.exe`;
3. `gpubnb-agent.exe` installed by the final NSIS package.

### Qualified runtime head

The runtime/software head qualified by the Windows preflight is:

```text
78f62043e067cce131659364ebd60081506710d7
```

The pull-request workflow checked the synthetic merge commit `e327787ae6159cf42697fbd9328c80c9bb23f839`, explicitly recorded by GitHub as the merge of head `78f62043e067cce131659364ebd60081506710d7` into the stacked PR #124 base `b6a453a9c8240091b3179746f7d117c9db9c8ece`. This is CI merge-ref qualification only; no PR was merged.

### Windows preflight evidence

GitHub Actions run `31997916417`, job `windows-installer`, completed successfully on a Windows Server 2025 runner.

The successful workflow covered:

- language-independent installer ACL validation;
- Agent `0.6.1` package installation and exact CLI version check;
- standalone PyInstaller Agent build and exact version check;
- standalone Agent runtime check (`idnaCodec=true`, `dnsResolution=true`, `tlsContext=true`);
- release build of the Windows Host tunnel sidecar;
- Host desktop TypeScript/build checks;
- native Rust format/tests/Clippy gates;
- final Tauri/NSIS installer build;
- silent installation of the real NSIS package;
- presence of both installed sidecars;
- exact installed Agent version check against `0.6.1` source metadata;
- Windows service registration, automatic start policy and executable path;
- service data-directory ACL checks;
- service recovery policy checks;
- real `GPUbnbAgent` service restart;
- silent uninstallation;
- verification that Agent/tunnel sidecars and the Windows service were removed after uninstall.

The NSIS bundle produced during the run was:

```text
GPUbnb Host_0.1.0_x64-setup.exe
```

The preflight artifact was uploaded successfully with:

```text
artifact id: 9277573603
size: 40671007 bytes
sha256: e3247afc34d1e89c71f5f9fdcbbf2bc37c0a1b98a5352655bd82698946970bad
```

GitHub's artifact metadata independently reports the same artifact ID, size and SHA-256 digest and associates it with branch head `78f62043e067cce131659364ebd60081506710d7`.

## Automated validation summary for the qualified runtime head

The corrected runtime head passed the relevant automated gates, including:

- main CI;
- API tests and build;
- strict TypeScript check;
- Agent suite;
- deployment readiness;
- API/mining CI;
- GPU supervisor checks;
- workspace reliability;
- Agent control-channel checks;
- rental/mining presence and preemption checks;
- Windows Host preflight with real installer/service lifecycle.

The API suite observed before the final preflight workflow change completed with `380/380` tests passing. The subsequent Host-preflight-only workflow change did not modify API runtime behavior. The final Windows preflight itself completed successfully on the qualified runtime head.

## Deployment status and required order

**No new public Host release was promoted and no corrected API/site deployment was performed as part of this qualification section.**

Because the current public Host release still contains Agent `0.6.0` while the corrected API rejects pre-`0.6.1` job claims, rollout must be ordered deliberately:

1. publish and independently verify the corrected Host `0.6.1` installer first;
2. confirm the public Host download metadata points to the intended immutable release target and checksum;
3. deploy the corrected API and site from the intended exact commit;
4. verify the live site's build identity and Compute-only renter path;
5. enable the bounded private-beta payment bypass only for the controlled physical qualification window;
6. perform one fresh physical renter-to-host product E2E;
7. disable the beta bypass immediately after the controlled test.

Deploying the API minimum-version gate before a qualified `0.6.1` Host is available would intentionally make the old public `0.6.0` Agent unable to claim jobs.

## Current product qualification status

Despite the substantially stronger software and installer evidence above, the marketplace product E2E remains:

**NOT QUALIFIED / INCONCLUSIVE.**

No new two-PC product run was performed after these corrections. The successful Windows CI runner install/service lifecycle does not substitute for a physical renter booking executing `GPU_PROOF` on the real GTX 1650.

A fresh physical qualification must still capture, for one new reservation created after the corrected rollout:

1. listing/booking creation on the renter side;
2. beta funding transition for the controlled test;
3. Compute session creation;
4. explicit `GPU_PROOF` job creation;
5. claim by Agent `0.6.1` with fenced attempt/lease credentials;
6. physical CUDA execution on the Host GPU;
7. signed `workloadProof=true` metrics accepted by the API;
8. successful `complete` and `finalize-proof`;
9. booking transition to `COMPLETED`;
10. allocation release and machine return to available state;
11. renter UI reflecting the terminal result.

Until that physical evidence is captured, no claim of a fully functioning marketplace rental flow is made. The direct P2P transport qualification and the physical GPU runner qualification remain valid but separate evidence.

## Pull-request state

The runtime/software qualification described above applies to commit `78f62043e067cce131659364ebd60081506710d7`. The first documentation-only commit after that runtime head was verified by compare to modify only this qualification document. Later documentation-only heads do not change the qualified runtime bytes.

PR #125 remains stacked on PR #124, open, draft and intentionally unmerged. No PR in the #122-#125 qualification stack was merged as part of this work.
