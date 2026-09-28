# GPUbnb Windows stream helper

This directory contains the native user-mode authority boundary for the Windows
Cloud Desktop backend and the fail-closed contract for Creator, CAD and Gaming.

## Current status

Cloud Desktop now has a Stage 3 candidate authority implementation:

- a real self-test reuses the signed worker, GPUbnb IddCx virtual display,
  exact NVIDIA UUID -> LUID proof, capture, NVENC, loopback media and isolated
  input path;
- `--start` launches one detached authority process per GPUbnb session;
- that authority keeps `QualifiedGraphicsRuntime` in memory and owns the worker,
  display lease, media capability and loopback listener;
- `--status`, `--suspend`, `--resume` and `--stop` use a local named pipe
  whose DACL is restricted to the authority-launching Windows identity;
- no media token or privileged runtime object is serialized to disk;
- Creator, CAD and Gaming still fail closed at the authority boundary.

This remains **not release-ready** until the physical Windows qualification
passes. Native Windows bookability must remain disabled.

The Agent contract remains authoritative:
`docs/architecture/WINDOWS_NATIVE_STREAM_HELPER_PROTOCOL_V1.md`.

## Pre-provisioned renter session lease

The v1 protocol deliberately consumes an already-provisioned interactive renter
WTS session. It does not pretend that creating a Windows logon token creates a
separate WinSta0 session.

The LocalSystem helper reads the non-secret identity lease from:

`C:\ProgramData\GPUbnb\windows-renter-lease.txt`

Exact format:

```text
schema=1
windows_session_id=<non-zero WTS session id>
renter_user_sid=<numeric SID for the dedicated renter account>
provider_user_sid=<numeric SID for the provider account>
gpu_uuid=GPU-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

The parser rejects unknown/duplicate keys, zero session IDs, system-service
renter SIDs, provider/renter identity collisions and non-canonical NVIDIA UUIDs.

The lease contains no password, media token or credential. Before any graphics
resource is armed, `WTSQueryUserToken` re-proves that the exact renter session
is the active console session and that no second interactive session is active.

## Component boundary

1. the signed GPUbnb Indirect Display Driver (IddCx / UMDF) creates the GPUbnb
   virtual display used by the renter;
2. the helper authority owns the validated renter-session runtime, exact-GPU
   binding, capture, hardware encoding, local media endpoint and lifecycle;
3. the signed renter worker performs the session-bound media/input work;
4. the Python Agent validates helper proofs and exposes only the authenticated
   GPUbnb data plane;
5. the API remains authoritative for booking, fencing, reconnect and billing.

The helper must never capture the provider personal desktop.

## Build

```powershell
cargo fmt --manifest-path native/windows-stream-helper/Cargo.toml -- --check
cargo test --locked --manifest-path native/windows-stream-helper/Cargo.toml --all-targets
cargo clippy --locked --manifest-path native/windows-stream-helper/Cargo.toml --all-targets -- -D warnings
cargo build --locked --release --manifest-path native/windows-stream-helper/Cargo.toml
```

A physical qualification build must also compile the worker/media artifacts with
the same source provenance and signing policy expected by the native runtime.

## Qualification order

On the physical Windows host:

1. install a coherent helper/worker/media artifact set;
2. provision the dedicated renter Windows session and write the identity lease;
3. make that renter session the active console session while the provider session
   is inactive;
4. run `--self-test --json`;
5. run the Agent Windows-native preflight;
6. exercise START -> STATUS -> SUSPEND -> RESUME -> STOP;
7. only then run the browser Cloud Desktop qualification.

A failure at any step is a Stage 3 failure. Do not substitute provider-desktop
capture, software encoding, a different GPU, a mixed-commit binary or a mock
session.

## Application policy boundary

Cloud Desktop rejects every application argument. Creator, CAD and Gaming keep
their explicit Program Files allowlists, but their authority/runtime promotion
is intentionally still fail-closed pending their later physical gates.
