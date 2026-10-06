# Windows Native Stage 4 — Failure-Injection Campaign

Status: **prepared, physical execution pending**.

This campaign is separate from the completed Stage 3 physical qualification. Stage
3 must not be rerun. Stage 4 proves that an already-working Windows-native Cloud
Desktop either recovers with fresh proof or terminates fail-closed under controlled
faults.

## Qualified baseline

- Stage 3 physical baseline: `6f54745bc0f558c7ce78f80643369476f3548c78`
- Stage 4 hardening baseline before failure harness:
  `21f3ceb8a92a373aac78303a81eac20d14c3208a`
- PR: #282
- public Windows bookability: closed

## Existing evidence not repeated physically

CI/source contracts already prove:

- cross-session native media paths are rejected;
- malformed/stale media capabilities fail closed;
- reconnect grace is server-authoritative and bounded;
- native start validation failures require verified cleanup;
- workspace gateway backpressure/retry is bounded;
- exact-GPU/native readiness is required before usage is reported.

The physical campaign focuses on faults that require real Windows/NVIDIA state.

## Harness

`scripts/windows-native-stage4-failure-qualification.ps1`

Scenarios:

- `Preflight`
- `HelperCrash`
- `AgentRestart`
- `NetworkInterruption`
- `RebootPrepare`
- `RebootVerify`

Fault-capable scenarios require explicit `-ArmFaults`.

The authority control pipe is intentionally private to the identity that launched
the native authority. In production that identity is `LocalSystem` via
`GPUbnbAgent`. Therefore an administrator-launched harness first relays itself
through a temporary on-demand Task Scheduler task running as `SYSTEM`, waits for
the result, and removes the temporary task/runner files. The pipe ACL is not
weakened and no broad administrator ACE is added.

The harness never:

- kills a process by image name;
- manually removes the GPUbnb PnP display;
- disables a network adapter;
- disables Windows Firewall profiles;
- automatically reboots or shuts down Windows;
- records media tokens or renter/provider SIDs in evidence.

## Acceptance model

A fault does **not** have to preserve the same native session to pass local safety.

The only acceptable local outcomes are:

1. **recovered** — a live native authority exists and every real readiness proof is
   fresh/true; or
2. **fail_closed** — no native authority and no READY helper status remain.

The local harness never upgrades this into overall Stage 4 PASS by itself. Server
evidence for the same WorkspaceSession/timestamps must separately prove billing,
fencing, allocation uniqueness and terminal/recovery state.

This matches the production Agent behavior: loss of a live native proof may trigger
cleanup and a server `stopped` report instead of reconstructing the same helper
authority.

## Campaign order

### A. Preflight

No mutation. Require:

- valid Authenticode on installed helper;
- exactly one authority child for the exact WorkspaceSession;
- helper READY with capture + exact GPU + NVENC + media + input;
- GPUbnbAgent service RUNNING and signed.

### B. Helper crash

The harness kills only the exact authority-child PID selected by all of:

- installed helper canonical path;
- `--authority-child`;
- exact `--session-id`.

PASS locally only if stale READY disappears and the outcome converges to either
`recovered` or `fail_closed`.

Do **not** remove `GPUbnb Isolated Virtual Display` manually. Authority termination
naturally exercises loss of its owned runtime/display state.

### C. Agent restart

The service is stopped/started through SCM. PASS locally if:

- GPUbnbAgent returns RUNNING with a live PID;
- native state converges to `recovered` or `fail_closed`;
- no ambiguous third state persists.

### D. GPUbnb-scoped network interruption

The harness does **not** disable Wi-Fi/Ethernet.

It creates temporary outbound TCP/443 block rules only for the exact signed:

- `gpubnb-agent.exe`
- `gpubnb-host-tunnel.exe`

A separate PowerShell watchdog is launched before the rules are created. It removes
the exact rules automatically after the bounded test window even if the main harness
is interrupted. The main harness also removes them in `finally`.

The default 75-second window exceeds the workspace-access heartbeat freshness
threshold while remaining far below the general five-minute machine-offline sweep.

Server acceptance must prove the browser/control path becomes unavailable as
expected, billable availability is not falsely extended, and post-unblock recovery
or termination is authoritative.

### E. Reboot

The harness never issues a reboot command.

`RebootPrepare` records:

- session id;
- exact helper/Agent hashes;
- pre-reboot authority/Agent PIDs;
- UTC preparation timestamp.

The operator then performs one manual Windows reboot.

After boot, `RebootVerify` requires:

- Windows boot time is newer than the preparation marker;
- exact helper/Agent files are unchanged;
- GPUbnbAgent service is RUNNING;
- no authority process exists for the old WorkspaceSession;
- the old helper session cannot report READY.

Server evidence must then prove the old rental reconciled to one authoritative
terminal state with no duplicate live allocation/session.

A subsequent new rental may be used to prove native capability can return only from
a fresh helper/display/exact-GPU/NVENC proof; the pre-reboot session itself must not
silently resurrect.

## Server-side acceptance for every physical fault

For the same WorkspaceSession and timestamps verify:

- exactly one WorkspaceSession identity;
- at most one live accelerator allocation;
- no provider desktop exposure;
- no stale READY;
- no billable/free-compute overlap outside policy;
- no double billing;
- cleanup/recovery converges or fails closed;
- quarantine remains absent unless a real fail-closed policy legitimately requires
  it.

## Final promotion rule

Cloud Desktop Stage 4 is technically complete only after the physical campaign and
server evidence pass on the exact release-candidate commit.

Production certificate/Microsoft retail driver signing may remain deferred until
commercial publication, and public Windows-native bookability remains closed.
