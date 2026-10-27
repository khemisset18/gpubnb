# Windows native Stage 4: secure recovery and physical blockers

Status on 2026-10-27: **physical qualification BLOCKED**. No PC1/PC2 remote
shell or desktop is available in the engineering conversation. Repository tests
are software evidence only. No driver installation, quarantine reset, paid
reservation or physical streaming test was performed.

## Evidence carried forward

The [PR #307 handoff](https://github.com/khemisset18/gpubnb/pull/307#issuecomment-6441234543)
records the failed 2026-10-26 trial: `virtual_display`, then
`rental_gpu_compute_processes_present`, local claim/runtime QUARANTINED at
generation 90. The booking was refunded and its GPU allocation released; this is
not proof of physical cleanup or server quarantine clearance.

PC1 has an exported backup of `oem176.inf`, installed version `9.3.32.4` for
`Root\GPUbnbVirtualDisplay`, instance `ROOT\DISPLAY\0000`. The separately built
qualification package is not installed. Its source INF is dated 2026-09-18,
version `0.1.0.0`. Secure Boot is enabled. The local October 18 certificate
passes Authenticode `/pa` checks but the reported `/kp` checks fail with an
untrusted root. Its reported expiry is November 1. These facts must not be
replaced by a guessed new inventory.

## Software changes

- Both npm production lockfiles use patched Zod 4.6.7. Diagnostic metrics use an
  explicit record key schema. Validation regression tests assert structured
  issue bounds rather than version-dependent English wording. No audit or
  Trivy threshold, exclusion or ignore policy was weakened.
- The Windows physical probe reads durable rental and GPU runtime stores before
  consulting a cached READY result. Every persisted claim, runtime quarantine,
  active miner or retained process identity blocks a new physical self-test.
  Corrupt/unreadable evidence also blocks it. Windows mining/rental transitions
  share the probe mutex. A busy mutex returns an unavailable heartbeat snapshot
  immediately instead of waiting through a helper startup deadline.
- Generic Windows quarantine recovery cannot rely on GPU quiescence alone. The
  native gateway first requires signed server confirmation that the old native
  session is terminal without a live allocation, plus an exact, strictly newer
  successor lease. It then requires the helper's idempotent STOP/monitor absence
  proof and fresh quiescence before advancing persistent state. Runtime process
  identity, an equal/older fence, server denial or failed physical proof keeps
  quarantine intact. The existing crash-safe runtime-then-claim ordering remains.
- A fresh owner/admin `DiagnosticRun` can now retire a terminal native quarantine
  without creating a successor booking. Its v2 body-signed authority checks the
  unresolved native cleanup scope, terminal session, absence of live allocations,
  workspaces, mining and Redis lease, and the existing persistent resource fence.
  The Agent proves helper STOP/monitor absence and canonical NVIDIA quiescence
  before the normal Docker/GPU diagnostic, then repeats those physical and server
  proofs afterwards. Only then does it retain/advance the local STOPPED tombstone
  to the **existing** authoritative fence floor and release the exact old claim
  through `release_after_cleanup`. It never invents, increments or resets a fence.
  Equal-generation rental replay is rejected after retirement; exact persisted
  PREEMPTING crash recovery still works. A crash or failed proof retains a fence
  and requires fresh proofs on retry. Missing process identities are necessary
  for this bounded path, not evidence of physical cleanup by themselves.
- Native cleanup evidence is mandatory in addition to the existing Docker and
  allocation gates. An old Agent's Docker-only result cannot clear an unresolved
  native cleanup, even if another failed diagnostic changes the primary reason
  or a later Docker stop is recorded. Multiple/unknown native obligations remain
  blocked. The physical mutex covers preparation, the diagnostic, retirement and
  signed submission, excluding a competing heartbeat self-test throughout.
- Control-handle opening now distinguishes access denial, exclusive-handle
  contention and a device/adapter that is not ready. The same bounded classes
  survive IOCTL, helper and Agent boundaries without raw paths or kernel text.
  A self-test cleanup error takes precedence over a concurrent media/input
  failure. A failed launch preflight needs a STOP proof before claims can release.

These fixes do not establish the physical root cause of the original generic
`virtual_display` error. The installed binary's mutation gate, control ABI,
LocalSystem execution and adapter readiness still require actual evidence.

## Supported driver path with Secure Boot retained

Microsoft documents attestation signing for **testing** on Windows Desktop 10
and later, including user-mode drivers. It requires Hardware Developer Program
registration and an EV certificate for submission. HLK/WHCP dashboard signing is
the recommended certification path. Access to that account and certificate has
not been established here; no purchase or submission has been made.

The local qualification certificate must not be used as an assumed substitute
for an accepted Windows driver signature. `/pa` and `/kp` apply different trust
policies; neither a DLL's Authenticode validity nor a CAT check alone proves
UMDF/IddCx loadability on PC1. An installable candidate needs the applicable
Microsoft-signed package, intact catalog membership and actual target policy
acceptance. Keep Secure Boot and the existing trust/boot policy unchanged.

Before any replacement:

1. Correlate the installed INF's provider, original name, date, version, service,
   catalog and payload hash with its actual PnP device. Matching the hardware ID
   alone does not establish that `9.3.32.4` implements GPUbnb's control ABI.
2. Keep the exported rollback package and verify its catalog/payload integrity.
   Do not delete the installed package or force a downgrade to improve ranking.
3. Build all four components from one recorded revision with the intended compile
   authority, and record the actual build flags and final signed hashes. A new
   Agent build is also needed for the Python guard/recovery changes. Existing
   signed binaries and unsigned Actions packages are not this new coherent set.
4. Confirm Windows build, UMDF availability, IddCx requirements and the exact
   read-only control protocol before attempting monitor mutation. The project
   targets Windows 11 build 22000+, UMDF 2.25, IddCx 1.4. `UmdfExtensions=IddCx0102`
   also appears in Microsoft's current sample; it is not by itself evidence of
   an erroneous 1.2/1.4 mismatch. Do not rename the extension to guess a fix.
5. Compare signature/ID rank first, then INF date and version for tied candidates.
   `0.1.0.0 < 9.3.32.4` alone cannot predict selection without the other fields.
   PnPUtil's normal install/update preserves Windows ranking. If the signed
   candidate loses, inspect the ranking and installation log; do not force it,
   arbitrarily inflate its version or modify its already signed INF.

Only after those conditions and cleanup are proven should the existing bounded
installer or normal PnPUtil update be considered. No install command is authorized
by a CI pass in this procedure.

## One read-only host evidence command

The entrypoint is `scripts/stage4-pc1-incident-evidence.ps1`. It reads only the two
canonical resource files, the tail of `agent.log`, the known PnP instance's
metadata, and Secure Boot status. Resource/session/GPU identifiers are hashed;
logs emit an allowlist of lifecycle codes. It never reads configuration secrets,
executes a GPUbnb binary, installs a driver, stops a process, edits a lock/claim,
changes a service or clears quarantine. Its output is evidence for private review,
not a declaration of cleanliness. Missing/unreadable data remains unverified.

After reviewing those results and installing the coherently signed updated
Agent/Helper set with the matching API revision, use the existing owner
`DiagnosticRun` workflow. It performs the bounded recovery above while quarantine
remains in force. No successor rental is required to break the previous circular
dependency (quarantine blocked the very successor needed to recover). Docker,
GPU, allocation and signature checks remain mandatory. An unsupported/busy
driver, failed STOP, occupied GPU, missing persistent Redis fence or unknown
resource scope blocks recovery; do not edit local records or bypass that refusal.
The API itself does not STOP host processes or clear local evidence. Keep the
private listing paused until the end-to-end physical evidence is complete.

## Physical acceptance, still outstanding

Use the existing private Stage 3 browser flow and Stage 4 failure campaign only
after signing, installation, lease isolation and cleanup prerequisites pass.
Record the virtual monitor's nonce-bound identity and provider-output exclusion,
real capture on the exact NVIDIA adapter, NVENC H.264 output and browser decoded
frames. Video continuity must measure at least 300 seconds of advancing decoded
frames, with no interruption under the existing 3-second gap criterion. A timer
or a still image is insufficient. Confirm visible keyboard **and** mouse effects
inside the renter boundary separately; the continuity tracker deliberately does
not assert input effects. After STOP, prove worker/helper absence, monitor/capture/
encoder/input/listener release and local/server lease cleanup. Preserve evidence
of reconnect and failure behavior. No readiness claim is valid before this pass.

## Official references reviewed

- [Driver signing offerings: attestation and HLK](https://learn.microsoft.com/en-us/windows-hardware/drivers/dashboard/driver-signing-offerings)
- [Attestation submission prerequisites and returned packages](https://learn.microsoft.com/en-us/windows-hardware/drivers/dashboard/code-signing-attestation)
- [Certificate deprecation and production signatures](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/deprecation-of-software-publisher-certificates-and-commercial-release-certificates)
- [IddCx versions shipped by Windows](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/iddcx-versions)
- [Microsoft IDD sample INF](https://github.com/microsoft/Windows-driver-samples/blob/main/video/IndirectDisplay/IddSampleDriver/IddSampleDriver.inf)
- [PnPUtil ranking behavior](https://learn.microsoft.com/en-us/windows-hardware/drivers/devtest/pnputil-command-syntax)
- [Driver ranking, date and version](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/overview-of-the-driver-selection-process)
