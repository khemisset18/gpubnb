# Windows Native Desktop — Stage 4 Production Hardening

Status: **Stage 3 physical qualification PASS; Stage 4 production promotion OPEN**.

This document is the production-hardening authority for the Windows-native desktop
runtime after the physical qualification recorded in PR #281.

The Stage 3 result is a frozen baseline. Stage 4 must not turn qualification-only
shortcuts into production features, weaken CI/security gates, or make Windows
workspaces publicly bookable before every release blocker below is closed.

## Qualified baseline

Physical Cloud Desktop qualification on the Windows/NVIDIA Host proved:

- LocalSystem Agent -> exact renter WTS session -> worker;
- GPUbnb-owned isolated virtual display;
- exact leased NVIDIA GPU UUID;
- real capture + NVENC;
- authenticated local media and browser delivery;
- isolated keyboard/mouse input;
- one browser refresh with same-WorkspaceSession reconnect;
- normal WorkspaceSession `COMPLETED` termination;
- cleanup without final machine quarantine;
- native capability restored after cleanup.

Qualification source baseline:

`6f54745bc0f558c7ce78f80643369476f3548c78`

The full evidence record is in PR #281.

## Security architecture already verified in source

The current qualified source already contains strong fail-closed controls:

### Renter process boundary

- renter token must match the expected WTS session and renter SID;
- provider/system identities are rejected;
- the worker is created suspended with no inherited service handles;
- environment is created from the renter token;
- the suspended worker image is re-identified before execution;
- the worker is assigned to a kill-on-close Job Object before `ResumeThread`;
- token/environment/process/thread/job handles are owned and closed deterministically.

### Local IPC

- named pipes use explicit protected DACLs instead of Windows defaults;
- only LocalSystem plus the exact renter logon SID are admitted;
- `PIPE_REJECT_REMOTE_CLIENTS` keeps the endpoint local;
- `FILE_FLAG_FIRST_PIPE_INSTANCE` prevents a pre-created spoof endpoint;
- peer PID and token SID are independently verified.

### Native runtime secrets

- opaque media tokens are generated using the Windows system RNG;
- token comparison is constant-time;
- secret buffers are zeroed on drop;
- media tokens are not placed in URLs.

### GPU/display proof

- canonical NVIDIA GPU UUID is resolved to the exact Windows adapter LUID;
- virtual-display proof and capture proof bind the same renter generation/session;
- the IddCx control interface remains SYSTEM-only;
- device/capture/display loss clears readiness rather than preserving stale READY.

These controls are mandatory invariants and must not regress during packaging or
promotion.

## P0 release blockers

No public Windows Native bookability until every P0 item is closed.

### P0-1 — Reproducible clean-host native installer

The current public Host publication path historically packaged:

- Host Desktop;
- GPUbnb Agent;
- Host tunnel;
- installer.

That is not sufficient to reproduce the physically-qualified native desktop
runtime on a clean Host.

A promoted Windows-native installer must include and verify the coherent set:

- `gpubnb-agent.exe`;
- `gpubnb-host-tunnel.exe`;
- `gpubnb-host-desktop.exe`;
- `gpubnb-windows-stream.exe`;
- `gpubnb-windows-worker.exe`;
- `GPUbnbWindowsMedia.dll`;
- GPUbnb IddCx driver package (INF/CAT/driver payload as applicable);
- final NSIS installer.

The installer must install fixed-path privileged/native components under protected
Program Files / ProgramData boundaries and must pass install, upgrade, repair,
restart and uninstall smoke tests on Windows.

### P0-2 — Production signing and publisher policy

Qualification certificates are not production publisher identity.

Production release order must be:

1. build media/driver/native binaries from the exact release commit;
2. production-sign the media DLL;
3. build the worker with the approved media signer policy;
4. production-sign the worker;
5. build the stream helper with approved worker/media publisher policy;
6. production-sign the helper and other user-mode binaries;
7. build/package the Host installer from the signed payload;
8. production-sign and RFC3161-timestamp the installer;
9. verify Authenticode/publisher policy for every expected user-mode executable;
10. verify the driver package with the applicable Microsoft production driver
    signing path;
11. compute final SHA-256 hashes after signing;
12. publish an immutable candidate with SBOM/provenance;
13. independently verify the published bytes before promotion.

No warn-and-continue path is allowed when production signing is required.

### P0-3 — Separate production gate from physical-qualification feature

The real IddCx monitor mutation is still explicitly guarded by
`physical-qualification` / `GPUBNB_PHYSICAL_QUALIFICATION_BUILD`.

Do not ship a public release merely by enabling the qualification flag.

Stage 4 must create an explicit release-candidate/promotion authority whose default
remains disabled and whose enablement is tied to a recorded release manifest and
completed failure-injection evidence. Public bookability remains separately
closed until final promotion.

### P0-4 — Controlled failure-injection qualification

The following must be tested on the release-candidate native runtime:

- browser disconnect/reconnect;
- helper crash/restart;
- Agent restart;
- Host network interruption;
- DXGI access loss / display mode or desktop transition;
- virtual display loss/recreation;
- stale media/cross-session token rejection;
- Windows reboot during an active test rental.

For every fault:

- READY/billing must be revoked when required;
- no provider desktop may be exposed;
- no duplicate renter session may appear;
- no free-compute interval may appear;
- no double billing may appear;
- stale capture/media/display proof may not re-arm the session;
- cleanup/recovery must converge or fail closed/quarantine according to policy.

### P0-5 — Security and dependency gates green

Required release checks include at minimum:

- dependency audit HIGH/CRITICAL gate;
- Trivy HIGH/CRITICAL gate;
- CodeQL Python and JavaScript/TypeScript;
- secret scanning;
- API complete test suite;
- Windows native Rust tests/clippy/rustfmt;
- Windows installer smoke/recovery tests;
- deployment-readiness/provider-neutral routing;
- Windows native browser/client security contracts.

Known Stage 4 remediation already applied:

- Fastify raised to a patched 5.12.x release;
- `brace-expansion` raised to a patched 5.0.x release;
- private Render same-origin routing removed from active production config.

### P0-6 — Release-publisher enforcement at runtime

A valid Authenticode signature is necessary but not sufficient.

Privileged/launchable GPUbnb native components must be authorized by an explicit
GPUbnb production publisher/certificate policy. Qualification signer fingerprints
must never silently become production trust roots.

## P1 hardening

### Windows Service

The service is a high-value LocalSystem authority.

Required/desired controls:

- SCM executable path fixed to the installed GPUbnb Agent;
- service configuration/control permissions reviewed and restricted;
- restart/recovery policy remains bounded;
- installer fallback may terminate only the exact SCM-owned PID after executable
  path verification;
- evaluate service SID isolation;
- evaluate a required-privilege list only after proving the exact privileges
  needed by WTS token acquisition, `CreateProcessAsUserW`, and pipe
  impersonation. Do not remove privileges speculatively and break the trusted
  boundary.

### Application control

For managed Hosts, Windows App Control can be used as defense in depth to allow
only approved GPUbnb publishers/binaries in privileged paths. This should be
canary-tested before broad enforcement because a bad policy can block legitimate
Host recovery/update flows.

### Logging / secrets

- never log bearer media tokens, renter credentials or provider data;
- keep bounded correlation identifiers;
- keep credential-bearing paths out of URLs;
- preserve redaction in diagnostics and support bundles.

## NVIDIA/driver compatibility policy

Do not force a Host onto the newest NVIDIA driver solely because a newer SDK exists.

The currently qualified Host proved CUDA 13.1 / NVIDIA driver 592.82 physically.
The media build is intentionally pinned to NVENC API 13.0 headers for this
compatibility baseline.

Before raising the minimum driver/API floor:

1. record the exact NVENC header/API version used by the release build;
2. consult NVIDIA Video Codec SDK system requirements for that API;
3. consult CUDA minor-version compatibility for the CUDA runtime actually used;
4. test the new floor on physical supported hardware;
5. only then update compatibility policy.

## Additional workspace promotion

Cloud Desktop qualification does not automatically qualify other products.

Creator additionally requires real Blender exact-GPU render proof.
CAD additionally requires real FreeCAD 3D viewport/input proof.
Gaming additionally requires Steam renter isolation, audio, controller input,
explicit egress policy and measured latency/jitter.

Each workload must inherit the shared Cloud Desktop security gates and pass its
own physical evidence gate before public exposure.

## GO criteria

Windows Native Cloud Desktop may move from private qualification toward controlled
bookability only when:

- all P0 blockers are closed;
- clean-host installer reproduces the coherent native runtime;
- production signing/publisher verification passes;
- failure-injection/reboot recovery evidence passes;
- CI/security/release gates are green;
- exact-GPU binding remains server-authoritative;
- rollback target is immutable and independently verifiable;
- canary deployment is monitored before wider exposure.

## NO-GO triggers

Any of the following is an immediate NO-GO:

- provider desktop exposure or ambiguity;
- unsigned/untrusted privileged native component;
- qualification signer used as production authority;
- helper/worker/media/driver provenance mismatch;
- stale READY after display/GPU/capture loss;
- cleanup uncertainty reported as success;
- active HIGH/CRITICAL release vulnerability;
- installer cannot reproduce the qualified runtime on a clean Host;
- public bookability enabled before the promotion gate is explicitly opened.

## Primary vendor references

Microsoft:

- WTSQueryUserToken:
  https://learn.microsoft.com/windows/win32/api/wtsapi32/nf-wtsapi32-wtsqueryusertoken
- CreateProcessAsUserW:
  https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw
- Named Pipe Security and Access Rights:
  https://learn.microsoft.com/windows/win32/ipc/named-pipe-security-and-access-rights
- Job Objects:
  https://learn.microsoft.com/windows/win32/procthread/job-objects
- Service Security and Access Rights:
  https://learn.microsoft.com/windows/win32/services/service-security-and-access-rights
- SignTool:
  https://learn.microsoft.com/windows-hardware/drivers/devtest/signtool
- Windows driver signing:
  https://learn.microsoft.com/windows-hardware/drivers/install/driver-signing
- App Control for Business:
  https://learn.microsoft.com/windows/security/application-security/application-control/app-control-for-business/

NVIDIA:

- NVIDIA Video Codec SDK:
  https://developer.nvidia.com/video-codec-sdk
- NVIDIA Video Codec SDK documentation:
  https://docs.nvidia.com/video-technologies/video-codec-sdk/
- CUDA compatibility:
  https://docs.nvidia.com/deploy/cuda-compatibility/
