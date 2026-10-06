# Windows Native Stage 4 — Failure-Injection Campaign

Status: **prepared, physical execution pending**.

This campaign is deliberately separate from the already completed Stage 3 physical
qualification. Stage 3 must not be rerun. The Stage 4 purpose is to prove that an
already-working Windows-native Cloud Desktop fails and recovers safely under
controlled faults.

Qualified source baseline before this campaign:

- Stage 3 physical baseline: `6f54745bc0f558c7ce78f80643369476f3548c78`
- Stage 4 hardening head before harness: `21f3ceb8a92a373aac78303a81eac20d14c3208a`
- PR: #282
- public Windows bookability: closed

## Existing evidence that is not repeated physically

CI/source contracts already prove:

- cross-session native media paths are rejected;
- media tokens are bounded, non-URL capabilities and invalid tokens fail closed;
- reconnect grace is server-authoritative and bounded;
- native start validation failures require verified cleanup;
- stale/failed native readiness does not silently become READY;
- workspace gateway backpressure/retry is bounded;
- Agent restart recovery has an existing full E2E contract for the older Developer
  container runtime.

These remain regression gates. The physical Stage 4 campaign focuses only on faults
that require a real Windows/NVIDIA runtime.

## Harness

`scripts/windows-native-stage4-failure-qualification.ps1`

The harness currently supports:

- `Preflight`: no fault; proves the exact signed helper, one exact authority
  process for the session, helper READY status and the real GPUbnbAgent service;
- `HelperCrash`: kills only the exact authority-child PID after proving installed
  executable path + authority-child command line + exact session id, then requires
  a different authority PID and fresh READY/media proof;
- `AgentRestart`: stops/starts GPUbnbAgent through SCM, then requires the service
  and the same active native session to return to READY.

Fault scenarios require the explicit `-ArmFaults` switch.

The harness never:

- kills by image name;
- removes the GPUbnb PnP display manually;
- disables a network adapter;
- reboots Windows;
- records media tokens or renter/provider SIDs in evidence.

The HelperCrash scenario intentionally covers the virtual-display stale-readiness
case too: authority-child termination closes the owned IddCx control handle, so the
driver cleanup backstop removes the authority-owned monitor. Recovery must create a
fresh authority/runtime and regain READY only after a fresh display/capture/exact-GPU
/NVENC/media proof.

## Physical campaign order

Run only during one controlled active Cloud Desktop test rental.

### A. Preflight

PASS requires:

- helper Authenticode status valid;
- exactly one authority child for the exact WorkspaceSession;
- helper status READY;
- GPUbnbAgent service RUNNING.

No mutation occurs.

### B. Helper crash + virtual-display loss/recreation

Inject `HelperCrash`.

PASS requires all of:

- only the exact validated authority PID is terminated;
- old authority PID exits;
- stale authority cannot answer READY;
- a new authority PID appears;
- fresh status reports capture/NVENC/media READY;
- browser returns only after fresh proof;
- backend never creates a duplicate WorkspaceSession;
- billable service does not include the unavailable interval;
- provider desktop is never visible;
- final cleanup is verified.

This is the preferred virtual-display-loss test. Do **not** manually remove
`GPUbnb Isolated Virtual Display` from Device Manager/PnP.

### C. Agent restart

Inject `AgentRestart`.

PASS requires all of:

- SCM performs the service stop/start;
- restarted Agent has a non-zero live PID;
- native authority returns/remains READY;
- backend retains one authoritative WorkspaceSession and one allocation;
- browser input/video recover;
- no duplicate renter session;
- provider desktop is never visible;
- final cleanup is verified.

### D. Host network interruption

Still pending physical implementation.

This must not be implemented by blindly disabling all networking because the
operator may need the Host connection for recovery. The final injector must have:

- a narrow GPUbnb/API-specific block;
- a local-console recovery path;
- an automatic bounded rollback/watchdog;
- evidence that READY/billing is revoked appropriately;
- proof that stale media cannot silently resume.

Until those safeguards exist, the network fault remains NO-RUN.

### E. Windows reboot during active rental

Still pending physical execution.

Requirements before arming:

- local physical recovery access;
- exact active test WorkspaceSession recorded;
- post-boot Agent service health;
- stale pre-reboot session/token rejected;
- server-side reconciliation reaches one terminal state;
- no duplicate allocation/session;
- native capability only returns after fresh helper/display/GPU/NVENC proof.

## Evidence split

The local harness proves local Windows process/runtime facts.

Server-side acceptance must separately verify for the same timestamps/session:

- one WorkspaceSession only;
- no overlapping live allocation;
- billing/reconnect interval;
- no stale READY;
- terminal cleanup/reconciliation result;
- no quarantine unless fail-closed policy legitimately requires it.

Both sides are required for a Stage 4 physical PASS.

## Final promotion rule

Stage 4 physical qualification is not complete until B, C, D and E pass on the
release-candidate runtime and the evidence is attached to PR #282.

Production signing may remain deferred while GPUbnb is not yet being commercially
published, but public Windows-native bookability remains closed.
