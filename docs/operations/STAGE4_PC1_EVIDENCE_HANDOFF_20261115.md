# GPUbnb Stage 4 — PC1 evidence handoff, 2026-11-15

**Status: PREPARATION / NO GO for installation or capture.** This is a factual
handoff of operator-reported Windows PowerShell 5.1 results and read-only
backend observations, **not** a remote attestation of PC1 or a security review.
No local service, production backend, certificate trust or rental state is
modified by this document.

## Provenance and private signing (operator-reported)

- The original unsigned CI source was the exact PR #333 SHA
  `23a7a2950ecf365866f3531ddbf76920d9fcb295`, with unsigned manifest
  SHA-256 `b29ce1730fadfb6bab2a4361636909232190edd6a5062c08d78237be2381dd49`.
- Publisher certificate SHA-256
  `d16110d7bf758b416ce3c874974bd862038570348dc1ebb02b4b5a1a176cb218`
  is a non-production self-signed local test certificate with private key held
  on PC1. It expires **2026-12-14T19:21:04Z** and the test signatures are
  **not timestamped**.
- The operator successfully invoked
  `stage4-private-test-sign-copies.ps1 -SignCopiesForPrivateTest`. Output:
  `kind=LOCAL_TEST_ONLY_NOT_RELEASE`, `filesVerified=4`,
  `installationPerformed=false`, signed test-only manifest SHA-256
  `1b784db35a17044cdcb735df81dbe477efebdb3364e48ed5e99f16dc64ff2a1f`.
- Signed test-only PE SHA-256 (in manifest file order):
  - `gpubnb-agent.exe`: `6d9e45ad2daf7643d11d9b533712ef6c725944a88c48b15bb2bf2464e05824cd`
  - `gpubnb-windows-stream.exe`: `15b63fcdcdfea3f28470a5e5cafaa8fda8419efcc4e78205812641260ad722ef`
  - `gpubnb-windows-worker.exe`: `239d8d8bca458cd0434cef635c6f750c6d22d1858fed9e26affbddafca89a063`
  - `GPUbnbWindowsMedia.dll`: `c3e860757a2317f21beb978af88bae1b31f2f84c22efc7c5a4adfdc4bdccd7fd`
- Authenticode for all four signed copies: `Valid`, expected public pin:
  `True`, machine-store chain: `True`, empty chain errors (as observed on
  PC1). The operator reported the precise public certificate installed in
  `LocalMachine\Root`; this is **machine-wide trust** and must be tracked
  as a security-sensitive, temporary change. It is **not** a test executed
  under the `LocalSystem` token and must not be described as such.

## Installed PC1 service and backup (operator-reported)

- `GPUbnbAgent` was `Running` as `LocalSystem`; binary path
  `C:\Program Files\GPUbnb\gpubnb-agent.exe` with argument `_service`.
- Zero `gpubnb-windows-stream.exe` or `gpubnb-windows-worker.exe`
  processes were observed during the read-only inventory.
- The real standard renter account is `gpubnb-renter-qual` (not `Renter`);
  its local profile exists but was not loaded at the time.
- All four **installed** PE files were different from the signed test copies
  and reported `Get-AuthenticodeSignature.Status=UnknownError` with a clear
  Windows message: certificate no longer in its validity period. Their signer
  was the older private test certificate expiring **2026-11-13 00:20:59Z**
  (local displayed time 01:20:59).
- The installed four-component backup succeeded with
  `filesVerified=4`, `installationPerformed=false`,
  `restorableWithoutFurtherChecks=false`, and backup manifest SHA-256
  `5709859c25a3983b54c7ebe83d3102a9abaee775a46d2eb4e02ab8d8af7b4307`.
  The saved files are `GPUbnb-sauvegarde-20261115-141617` under the
  operator's Downloads directory.

**CRITICAL BACKUP LIMITATION:** The backup has verified bytes but its
Authenticode chain is expired. The existing
`stage4-private-install-readiness.ps1` intentionally rejects a backup when
its installed/saved signatures are no longer `Valid` or the old signer has
less than 24 hours of remaining validity. Do **not** relax that check,
re-label the test-only package or treat `filesVerified=4` as proof of a viable
rollback. A separately tested recovery/rollback path is required before
any physical four-file replacement.

## Local rental claim: NOT VERIFIED

A prior read-only query of
`%ProgramData%\GPUbnb\gpu-resource-rental-v1.json` and
`gpu-resource-runtime-v1.json` looked up the historical resource key
`e9ab8452-0349-4d3b-a209-868c633834a3` under `resources`.
At least one lookup returned null and the operator's script reported
`Ressource GPU introuvable dans les fichiers locaux`. The code **did not
enumerate the actual keys or validate the current schema**. This result
does not prove that local claims are clean, nor does it authorize deleting,
creating, repairing or clearing a state file. The older maintenance code
expects a specific claim/session ID that may now be stale; any mismatch must
fail closed before STOP/service mutation.

The private database was inspected read-only on 2026-11-15. It reported
the machine available/online without a machine quarantine reason; the GPU
resource was `quarantined=false`, `runtimeState=IDLE`,
`activeRentalId=null`. These server observations **do not replace**
physical PC1 claim and NVIDIA/WTS evidence, and are not an authorization
to stream.

## Packaging regression and non-interchangeable source versions

The **original CI ZIP at source 23a7** omitted
`support/stage4-windows-path-policy.ps1`, a dependency of
`stage4-package-common.ps1`. An operator first saw
`CommandNotFoundException`. After a separately SHA-256-verified
support-only repair (same script from the original commit), the operator's
four-file test-only signing completed successfully.

PR #367 corrects the missing path-policy script and adds the private
qualification creator, its policy and independent verifier to the support
bundle, with dependency-closure regression tests. These are **packaging**
fixes on a **different source SHA**. New CI artifacts on that SHA are not the
same code/provenance as the original four signed PC1 copies. Do not mix
`ExpectedCommit`, embedded publisher pins, manifests or file hashes
between different builds. No package of kind `LOCAL_TEST_ONLY_NOT_RELEASE`
may be installed. Only a separately generated, externally pinned,
machine/GPU/renter-scoped candidate can enter read-only installation
readiness review.

## Remaining independent gates (all NO GO until proven)

1. Demonstrate a **viable and verified rollback**, including signer validity
   and service startup, that does not depend on the expired backup alone.
2. Verify exact current local claim/runtime **schema and identifiers** read
   only; no stale hard-coded Gen90/session assumption may be used to alter
   local state. Confirm physical NVIDIA quiescence and WTS restrictions.
3. Complete independent candidate manifest + source/publisher + machine/GPU +
   renter pin checks and read-only service/path/ACL/backup checks.
4. Independently attest and review actual Render release/source compatibility
   before any backend mutation. Existing GitHub green CI is not a proof of
   private Render alignment.
5. Obtain the required **formal independent security review on exact code**
   and separate physical test preconditions before any maintenance or PC2
   capture. Owner participation by itself is not an independent code review.
6. After the permitted private test window, review/remediate temporary
   `LocalMachine\Root` trust added for the local test certificate. No
   automatic root removal or trust-store changes are performed here.

There has been **no** four-file installation, Render deploy, local-state
reset, public booking or PC1-to-PC2 streaming demonstrated by this handoff.
Do not issue further trial-and-error PC1 commands until the recovery policy
and packaged tooling have been validated in CI and reviewed.
