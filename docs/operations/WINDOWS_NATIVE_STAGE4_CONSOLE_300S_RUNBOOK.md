# GPUbnb Stage 4 — Windows Home dedicated-console 300 s qualification

**Status: PREPARED ONLY — NOT EXECUTED, NOT PHYSICALLY QUALIFIED, NOT BOOKABLE.**

Scope: `console-dedicated` private backend from PR #316, based on the
Windows-native qualification lineage `40e9ef5991ab13753130121fd321c60c84b4a297`.
PC1 = dedicated Windows 11 Home NVIDIA host. PC2 = **browser only**.
Do not install anything on PC2. No RDP server, TermService modification, test
signing, Secure Boot disablement, EV certificate purchase or trust-store edit.
No production API/Render changes, no crypto-exchange changes, no PR merge.
No execution on the generation-90 quarantined GPU.

## STOP before touching a physical host

The software is integrated for *private qualification*; CI and an unsigned
build do **not** authorize installing or running the software on PC1.

The operator must establish these independent prerequisites:

1. **Approved, complete, exact-commit Windows host package**: Helper, worker,
   media DLL and their dependencies; provenance, SHA-256 and Authenticode
   signer are all accepted by the existing fixed publisher/worker/media
   policies. The old PC1 signed build and the new PR must **not** be mixed.
   An unsigned CI artifact, untrusted self-signed test driver, or partially
   assembled IddCx package does not pass.
2. **Quarantine:** the target GPU UUID is explicitly eligible, non-quarantined,
   and matches NVIDIA UUID/LUID in the signed package and renter lease.
   Never use generation-90 for this experiment or clear its quarantine.
3. **Dedicated local console:** one renter session, Windows **standard user**,
   one unique active connected display (real device eligibility to be proved),
   separate maintenance/provider identity signed out, provider account data
   absent, and no administrator token exposed to the renter.
4. **Signed authority/provenance and accessible transport**: Windows helper
   running under its intended protected LocalSystem service/pipe policy. Browser
   and server session authorization and **matching release provenance** must
   be established before attempting E2E. An older Render release is not
   equivalent to the current source branch; do not deploy just to bypass it.
5. **Local rollback and witnesses**: console operator with physical access,
   a ready way to stop the session and restore the known-good state, and a
   separate observer watching provider and renter screens.
6. **Explicit isolated test window**: no billable booking, no real renter, no
   personal files, no external clients and no live provider activity.

If any prerequisite is absent, outcome is **NO-GO** for active capture and
remote input. *Never* replace a missing proof with `virtualDisplay: true`,
`nvencReady: true`, a fake video frame or a manually altered evidence JSON.

## Phase A — preflight inventory (read-only, safe before installation)

Use `scripts/stage4-console-readonly-preflight.ps1` **only when the script is
already available in an inspected checkout**; running it is observational,
not a driver or service installation.

```powershell
# On PC1 only, from the reviewed checked-out source. Powershell x64.
# Supply approved hashes from a separately verified complete release manifest.
# Execute the inspected local script only if the current script execution
# policy already permits it; do not change a machine/user policy.
.\scripts\stage4-console-readonly-preflight.ps1 `
  -ExpectedGpuUuid 'GPU-REPLACE-WITH-ACTUAL-CANONICAL-UUID' `
  -RenterAccount 'gpubnb-renter-qual' `
  -ExpectedHelperSha256 'REPLACE-WITH-VERIFIED-64-HEX-HASH' `
  -ExpectedPublisherSha256 'REPLACE-WITH-APPROVED-64-HEX-PIN'
```

Never paste placeholder values into a real qualification report. The inventory
does **not** start the Helper, inject input, open capture, enable Remote Desktop
or modify certificates. It intentionally always records
`physicalQualificationPassed: false`, `publicBookabilityAllowed: false`,
and `localConsoleSessionProven: false`. Its active-monitor count is merely a
candidate, not proof of trustworthy physical routing. The existing
`stage4-pc1-inventory.ps1` is IddCx/GTX1650-specific and cannot qualify this
console backend.

## Phase B — LOCAL signed console proof (requires host access)

Only after Gate A and the complete signed package:

1. Check one exact renter **SID**, active WTS console, unlocked
   `WinSta0\\Default`, no other interactive/provider session and exact leased
   NVIDIA UUID -> LUID. Do not test while logged in as the provider.
2. In the existing protected LocalSystem authority (not arbitrary elevated
   terminal), run the separately gated `--self-test-console --json` using the
   exact signed Helper. It must report `captureBackend: console-dedicated`,
   `consoleDisplay: true`, `virtualDisplay: false`, exact GPU, real WGC
   captured frame + real NVENC H.264 and **verified STOP cleanup**.
3. Attempt `--self-test --json` (legacy IddCx) only if independently authorized
   for its own qualified package. Do not substitute its result for console.
4. Deliberately reject mismatch cases: wrong session ID, wrong GPU UUID/LUID,
   missing monitor, multiple displays, locked console, signature/hash failure,
   unexpected proof v1/v2, bogus sequence, malformed H.264 or disconnected user.

If any check fails: **STOP, revoke media/input capability and retain
non-bookable/quarantined state.** No repeated blind start retries.

## Phase C — PC1 → PC2 browser-only 300 s (requires exact server matching)

From PC2, open only the authorized GPUbnb HTTPS page in a normal Chromium
browser with the existing WebCodecs functionality. No Moonlight installation,
browser extension, native receiver, RDP, local trust-root edit, remote desktop
service or arbitrary file upload.

Verify privately and record:

| Gate | Real pass condition |
| --- | --- |
| Server/source | Same authorized release SHA, exact GPU/session claim and renter boundary; no stale gateway/Render build |
| Stream | H.264 hardware NVENC bitstream with valid SPS/PPS + IDR and advancing worker sequence |
| Duration | **>= 300,000 ms** of browser-decoded **and rendered** advancing frames |
| Continuity | No recorded decoded/rendered-frame observation gap **> 3,000 ms** |
| Input | Both keyboard and mouse produce independently witnessed effects in the renter account |
| Privacy | No provider/test-maintenance desktop pixels even during lock/switch/restart |
| Network | No RDP port or unauthenticated media listener; exact ephemeral media token never logged |
| Close | STOP or disconnect revokes media/input, ends worker tree and leaves no active rental/usage claim |

Record redacted evidence **without** raw session tokens, Windows SIDs, keyboard
contents, personal pixels, authentication cookies or full system inventory.
Never mark the 300-second test successful based on CI, a timer, a static image,
an unverified H.264 mock or the preflight CLI JSON alone.

## Phase D — mandatory fault and isolation campaign

Using only synthetic/test accounts and non-sensitive visual markers:

- Lock renter screen during a live stream: immediate blackout/abort/revocation,
  zero new decoded provider frames and zero accepted input.
- Fast-switch to an otherwise empty provider/test-maintenance account:
  **no image of the other account may reach PC2**.
- Disconnect/logoff renter, disconnect browser, temporarily interrupt the
  authorized gateway path and reconnect: old token and stream epoch must fail;
  fresh token/proofs only for the still-authorized renter.
- Change screen resolution, unplug/replug the unique physical display, add a
  second display: abort, not capture a fallback monitor.
- Stop/kill the signed helper under a separately authorized recovery harness:
  follow established STOP/tombstone/Job Object cleanup and billing rules.
- Attempt a wrong-GPU UUID, stale worker media sequence and non-keyframe
  resume: all reject. No replay acceptance or provider input leakage.
- Reboot recovery is a separate, explicitly prepared window. No unattended
  reboot to “try again”.

The current polling-based WTS rechecks **cannot establish a mathematical
zero-leak guarantee during a concurrent session switch**. Event-driven
revocation and test observations are still mandatory before security signoff.

## Evidence record and final gate

A future independent test report should bind: approved release SHA and signed
package hashes, binary signer pin, platform edition/build, non-quarantined
NVIDIA UUID/LUID, monitor path fingerprint (redacted), renter console authority
result, FPS/sequence and H.264 proof, 300-second window and max-gap, witnessed
keyboard/mouse result, negative WTS fault outcomes, exact STOP cleanup, and
server-side usage/claim reconciliation.

**GO = all gates independently passed, including signing/provenance and
hardware. Anything else = NO-GO.** The PR remains draft; public bookings stay
blocked. A successful Windows CI/unsigned package alone never authorizes
installing the new console build on PC1 or enabling GPUbnb rental availability.
