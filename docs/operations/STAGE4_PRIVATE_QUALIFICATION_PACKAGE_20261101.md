# Stage 4 — scoped private qualification package (preparation only)

Status: **DRAFT CODE / NOT APPROVED FOR INSTALLATION**. This does not unquarantine PC1, qualify the GPU, or allow public booking. Its current purpose is to construct and independently verify a *new* machine/GPU-scoped signed candidate **from the original externally authenticated unsigned four-component CI artifact**.

## What this fixes

The older `LOCAL_TEST_ONLY_NOT_RELEASE` folder has `installable=false`, was signed for archival/private-test inspection only, and must **never be relabeled, edited or installed**. The production-signing entrypoint rejects `LOCAL PHYSICAL TEST ONLY` certificates. Do not bypass either behavior.

This PR introduces a **separate private-qualification policy** and new signing entrypoint, keeping that old folder untouched. The result has `kind=GPUBNB_STAGE4_PRIVATE_QUALIFICATION_INSTALLER_CANDIDATE`, `installable=true`, **`installationReviewRequired=true`**, `installationPerformed=false`, `privateQualificationOnly=true`, and `publicBookabilityEnabled=false`. **Being a signed candidate is not permission to install**; no installer or `-Install` operation is provided by this PR.

## Constructing a new candidate, after software/physical readiness review

The operator must be on PC1 with the local signing key, never share a private key or paste secrets, and use verified *external* provenance values (not hashes computed from a downloaded manifest to be blindly trusted). The protected key remains in the original Windows certificate store. The private certificate currently recorded for the PC1 test expires 2026-11-13 UTC and these signatures are not timestamped.

Use the exact identity already independently checked on PC1:
- Source: `32ffdc72ec7041310c4b07e286ac4c4c2818906c`.
- Original unsigned manifest: `9e25aff21920615ff5d09686c2658cec74efd36c0d0428cf214495747fccc1ba`.
- Test publisher certificate SHA-256: `3060de709bd0db7fa8588b7480a8a04f94b2a7df005ee48361cbdcd39b0e9619`.
- Scope: machine `cmsiggruy0004df0tn669f6bn`, GPU `GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a`, local renter account `gpubnb-renter-qual`.

The private candidate command defaults to **read only**. It cannot install, stop a service, launch capture, create Windows sessions, trust a certificate or alter quarantine. Only an explicit `-CreateInstallablePrivateQualificationPackage` can produce signed **copies in a new non-system folder**, and it must be followed by the independent verifier with the new candidate's externally recorded SHA-256. The verifier accepts *only* the new scoped manifest type, matching exact scope/provenance and four signed AMD64 components. It rejects the existing signed test-only package.

No commands need to be run on PC1 while the development PR is in draft.

## Separate physical installation gate (not shipped here)

Before any `Stop-Service` or file replacement is designed, reviewed and independently approved:

1. Approve the exact candidate manifest hash and the private physical-test window; ensure no active rentals, no public listing and no capture of the provider's screen.
2. Verify **LocalSystem and renter context trust** of the signer, and exact PE hash/identity on the actual machine; private CurrentUser trust alone is insufficient.
3. Verify the saved backup's pinned manifest SHA-256 `77095e5b23b2aa7b985e6c71b5ac8d36ed7ab987d39cd946aebc042996de44bd`, its four files, service identity/path and ACL; prove that rollback is viable and signer validity has not expired.
4. Provide a separate reviewed maintenance script/operator process with bounded stop/restart, no blind PID kill, no stale rental-state rewrites, and a fully tested rollback.
5. Match the exact reviewed backend SHA on the private Render service after verifying health, RLS, migration and rollout compatibility. A branch-default `trigger_deploy` is not an exact-SHA release.
6. Use the normal new owner/admin signed `DiagnosticRun` for the existing `QUARANTINED` old workspace, demanding Helper STOP/monitor absence, server fence and physical NVIDIA quiescence before any state transition.
7. Only after cleanup, validate exact WTS renter console, protected SID/session/GPU lease and real PC2 video 300 s + input and lock/switch revocation negative tests. Never expose `hicha`.

A missing prerequisite means **NO GO**. The staged package and existing PC1 service remain intact.


## Read-only Windows installation readiness audit

Only **after** a separately signed scoped private candidate has been produced and independently verified, the local operator may use `scripts/stage4-private-install-readiness.ps1` to gather Windows-PC1 evidence **without** stopping a process or editing Windows. This operation is not an installer and cannot authorize itself.

The script requires these **external** pins, which must be independently recorded before invocation:

- Candidate manifest SHA-256 as printed by the separate private packaging run (not a value guessed from an untrusted downloaded manifest)
- Exact underlying source commit (for the current original unsigned source, `32ffdc72ec7041310c4b07e286ac4c4c2818906c`)
- Publisher certificate SHA-256 `3060de709bd0db7fa8588b7480a8a04f94b2a7df005ee48361cbdcd39b0e9619`
- Machine ID `cmsiggruy0004df0tn669f6bn`, NVIDIA UUID `GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a` and renter `gpubnb-renter-qual`
- Existing verified backup folder and its separately recorded manifest SHA-256 `77095e5b23b2aa7b985e6c71b5ac8d36ed7ab987d39cd946aebc042996de44bd`

It checks, read only, the independent new candidate verifier, old installed and backed-up 4-file hashes and ACL, backup signer validity, the machine-context signer chain (only a proxy for real `LocalSystem` trust), exact old service process topology and no active Helper/Worker process, and the physical NVIDIA GPU UUID inventory. The JSON report intentionally marks `installAuthorized=false`, `installationPerformed=false`, `backendReleaseAligned=false`, `renterConsoleQualified=false`, and `physicalCleanupProven=false` **even when every local check passes**.

**A successful local report must never be treated as a green light to start streaming, overwrite files, deploy Render or change quarantine.** Actual signed LocalSystem execution, rollback under the live Windows conditions, a compatible backend rollout and the canonical signed owner cleanup diagnostic remain separate gates. If the certificate chain is not trusted in machine context, stop and address an approved publisher/trust policy separately; never add a root CA silently or disable Windows signature checks.
