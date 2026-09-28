# Windows Native Desktop — Security Threat Model

Status: pre-qualification, fail-closed. This document is normative for PR #220 and later promotion work.

## Security objective

A renter may receive pixels, audio and input control only for the GPUbnb-owned renter session and GPUbnb-owned virtual display attached to the exact leased NVIDIA GPU. The provider's interactive desktop, credentials, files, displays and input session must remain outside the renter trust boundary.

No native Windows workspace is bookable or billable until the complete runtime proof chain succeeds. Unknown, stale, partial or contradictory evidence is treated as unavailable.

## Trust boundaries

1. **GPUbnb privileged service** — trusted control-plane component. It may obtain an explicitly qualified renter WTS token, create the secure worker pipe, launch the signed worker suspended, own the IddCx control handle and perform cleanup. It must not render or capture the provider desktop.
2. **Renter worker** — unprivileged code executing in the dedicated renter WTS/logon session. It receives only typed finite commands. It is not trusted to authorize itself, select a different GPU, alter billing state or widen the capture target.
3. **IddCx driver** — GPUbnb-owned virtual-display boundary. Its control device is SYSTEM-only. Monitor mutation stays compile-time disabled until physical qualification.
4. **Browser/media client** — remote renter-controlled endpoint. It receives only authenticated media produced by the qualified renter session. Media credentials are bearer secrets and must not appear in URLs, logs or repr/debug output.
5. **Provider interactive session** — explicitly out of scope for capture/input and treated as protected data.

## Mandatory security invariants

### Session and process isolation

- The renter primary token must belong to the expected WTS session and expected renter user SID.
- LocalSystem, LocalService, NetworkService and the provider identity are forbidden renter identities.
- A second unexpected interactive session causes launch to fail closed.
- The worker is created suspended with no inherited service handles and with a renter-owned environment.
- A kill-on-close Job Object is assigned before the worker's initial thread is resumed.
- The worker executable is re-identified while still suspended. Its Windows FILE_ID_INFO must exactly match the file identity retained during verification.
- Worker IPC is accepted only from the exact launched PID and exact renter logon SID.

### Executable provenance

- Native application paths must be absolute local-drive paths and pass the workspace path policy.
- UNC/network paths, device namespaces, ADS syntax, dot/dotdot ambiguity and trailing-dot/space ambiguity are rejected.
- The executable file itself must not be a reparse point.
- Every parent path component is opened without following reparse points and must itself be non-reparse.
- The verification handle remains held so the qualified executable cannot be replaced through ordinary rename/delete replacement during launch.
- Authenticode trust is mandatory.
- Publisher policy remains mandatory before production promotion. A valid signature alone is not sufficient publisher authorization.

### Worker protocol

- The pipe is local-only and has an explicit ACL for the service plus the exact renter logon SID.
- The pipe peer PID and token SID are independently verified.
- Worker hello binds protocol version, booking session, exact GPU UUID, workspace, generation, WTS session and PID.
- Control messages are binary, bounded, typed and sequence-fenced.
- There is no arbitrary shell command or arbitrary executable command in the protocol.
- Generation or sequence mismatch is fatal for the runtime connection.

### Exact GPU binding

- The booking identity is a canonical NVIDIA GPU UUID.
- CUDA driver enumeration is used to resolve that UUID to the Windows graphics adapter LUID for the same physical device.
- IddCx monitor activation must refuse a request whose render-adapter LUID does not equal the LUID resolved from the leased GPU UUID.
- NVENC readiness must later prove a hardware encode from the same leased GPU and the exact captured frame. Driver/API presence alone is not readiness.

### Display and capture isolation

- Only a GPUbnb-owned virtual display can qualify.
- Display proof binds generation, renter WTS session, unique display nonce, exact adapter LUID, width, height and refresh rate.
- Capture proof must bind the same display nonce, generation, WTS session, LUID and dimensions.
- Provider-desktop exclusion is a mandatory independent proof.
- A frame from another output, adapter, session or generation must fail qualification.
- DXGI access loss, device removal, worker disconnect or display loss revokes READY immediately and requires a completely fresh proof chain before resume.

### Media and secrets

- Media endpoints are literal loopback IP URLs with an explicit port and exact session path.
- Credentials, query strings, fragments, ambiguous userinfo and parser-normalized spellings are rejected.
- Media tokens are bounded opaque strings and must never be embedded in the media URL or logged.
- Disconnect does not imply continued readiness; recovery requires the lifecycle's fresh-proof rules.

### Cleanup

- Any failure after partial setup runs cleanup.
- Cleanup failure is itself a hard failure and must never preserve READY/billable state.
- Closing the IddCx owner handle is a backstop for virtual-monitor cleanup.
- Closing the worker Job Object terminates the worker process tree.
- Repeated stop/cleanup must be safe and must not create a new session.

## Threats explicitly covered

- Provider desktop capture through output confusion.
- Cross-GPU or ordinal-based GPU substitution.
- Multi-GPU LUID/UUID mismatch.
- Renter worker spoofing through another PID or logon session.
- Named-pipe remote access or weak default ACLs.
- Protocol replay across booking generations.
- Shell/command injection through worker control messages.
- Executable replacement between verification and execution.
- Junction/symlink/reparse path redirection.
- DLL search-path substitution for NVIDIA driver libraries.
- False READY from capability probes, empty NVENC output or a mismatched frame.
- Stale READY after DXGI/device/session degradation.

## Required before production promotion

The following remain release blockers until implemented and physically verified:

- Real publisher identity extraction and an explicit GPUbnb publisher policy for every privileged/launchable binary.
- Real IddCx monitor mutation in a qualification-only build, then explicit promotion after physical tests.
- Real graphical frame transport/capture tied to the GPUbnb virtual display.
- Real NVENC D3D11 encode on the exact leased GPU, with non-empty encoded output tied to the exact captured frame.
- Authenticated loopback media delivery, isolated input, renter-session audio and controller handling where required.
- Crash/restart, access-lost, device-removed, worker-death, browser-disconnect and cleanup stress qualification.
- Physical Cloud Desktop qualification at 1920x1080@60 on supported hardware.
- Creator/CAD/Gaming qualification only on hardware meeting their existing RAM/disk/VRAM minima.

## Promotion rule

CI compilation, unit tests and synthetic proofs are necessary but not sufficient. The compile-time IddCx mutation gate and API bookability gate must remain closed until a recorded physical qualification demonstrates the complete proof chain on the intended Windows host class.
