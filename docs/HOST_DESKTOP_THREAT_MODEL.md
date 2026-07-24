# GPUbnb Host Desktop — Threat Model

Status: authoritative security design input for PR #11.

## Security objective

A renter workload must never gain access to the host user's desktop session, personal files, credentials, browser data, network identity, devices, or long-lived secrets. A rental starts only after every mandatory control is independently verified. Missing evidence means denial.

## Trust boundaries

1. Unprivileged desktop UI.
2. Privileged signed host service.
3. Isolated guest runtime.
4. GPU assignment boundary.
5. GPUbnb control plane.
6. Local secret store.
7. Update and installer supply chain.

No component may silently cross a boundary. Every crossing requires authentication, authorization, validation, timeout handling, audit logging, and revocation.

## Primary assets

- Host personal files and user profile.
- Host credentials, cookies, SSH keys, wallet data and browser sessions.
- Host network identity and LAN access.
- GPU firmware, driver state and host stability.
- Pairing tokens, device keys and rental credentials.
- Rental images, temporary disks and renter data.
- Installer, updater and release-signing keys.
- Audit evidence used to authorize a rental.

## Adversaries

- Malicious renter workload.
- Compromised rental image.
- Compromised GPUbnb account or control-plane session.
- Local unprivileged malware.
- Malicious or compromised update dependency.
- Network attacker.
- Host operator accidentally weakening protections.
- Crash, power loss or partial cleanup leaving unsafe state.

## Non-negotiable invariants

- The UI never receives administrator privileges.
- The privileged service exposes a narrow allowlisted API only.
- No arbitrary command, path, URL, environment variable or executable supplied by the UI is executed by the service.
- Guest storage is ephemeral and never mounts host personal directories.
- Guest networking is deny-by-default and cannot reach the host LAN or metadata services.
- A rental never starts while a miner still owns the GPU.
- Failure to prove miner shutdown blocks GPU reassignment.
- Failure to prove guest destruction blocks miner restart and new rentals.
- Pairing and rental credentials are short-lived, scoped, revocable and stored only in an OS-native secret store.
- Emergency stop revokes access and terminates real guest processes, not only UI state.
- Restart after crash begins offline and requires reconciliation before any workload starts.
- Unsigned or untrusted installers, services, images or updates are rejected.

## Required controls by boundary

### Desktop UI to privileged service

- Local authenticated IPC.
- Per-installation device identity.
- Request schema validation and strict size limits.
- Method allowlist with no shell escape.
- Replay resistance for sensitive operations.
- Service-side authorization; UI state is never trusted.
- Rate limits and operation deadlines.

### Service to guest runtime

- Minimal immutable base image.
- Measured image identity before launch.
- Ephemeral writable disk.
- No host filesystem mounts.
- No clipboard, shared folders, host desktop, USB or socket passthrough by default.
- Resource limits and watchdog.
- Destruction verification after shutdown.

### Network

- Deny-by-default egress policy.
- Explicit control-plane destinations only during bootstrap.
- No access to RFC1918/link-local host networks unless a reviewed feature requires it.
- DNS policy controlled by the isolated environment.
- Network namespace or VM boundary proven by integration tests.

### GPU lifecycle

- Explicit ownership state machine.
- Miner stop request followed by bounded graceful wait.
- Forced termination only according to reviewed policy.
- Driver/process verification before guest assignment.
- Guest shutdown and GPU release verification before optional miner restart.
- On uncertainty, remain offline.

### Secrets

- Windows Credential Manager/DPAPI, macOS Keychain, Linux Secret Service or equivalent reviewed backend.
- No plaintext token files.
- No secrets in logs, crash reports, command lines or environment inherited by renter workloads.
- Rotation and revocation tested.

### Supply chain

- Dependency lockfiles committed.
- Reproducible CI installation commands.
- Minimal workflow permissions.
- Pinned release tooling and reviewed third-party actions.
- Signed installers and signed updates.
- Release provenance and checksums.

## Abuse cases that must be tested

1. Guest attempts to read the host home directory.
2. Guest attempts to reach host loopback, LAN and cloud metadata endpoints.
3. Guest attempts VM/container escape primitives.
4. Miner ignores graceful termination.
5. GPU driver remains busy after miner exit.
6. Guest crashes during GPU use.
7. Host loses power during rental cleanup.
8. UI is compromised and sends forged privileged requests.
9. Pairing token is replayed after expiration.
10. Old rental credentials are reused after termination.
11. Update package is modified or signed by an unknown key.
12. Temporary disk deletion fails.

## Merge evidence

PR #11 may leave draft status only when all production-readiness gates are backed by executable tests or independently reviewable evidence. Documentation or UI text alone is not evidence of isolation.

Any unresolved critical or high-severity issue keeps the `do-not-merge` label.