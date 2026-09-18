# GPUbnb Windows stream helper

This directory contains the native user-mode authority boundary for the Windows
Cloud Desktop, Creator, CAD and Gaming backends.

## Current status

**Bootstrap / fail-closed.** The binary intentionally returns non-zero for
`--self-test`, `--start` and `--stop` because the IddCx virtual display,
capture, NVENC and renter-input backend is not implemented in this crate yet.
It must never emit a success-shaped JSON response just because Windows, CUDA or
an NVIDIA GPU exists.

The Agent contract remains authoritative:
`docs/architecture/WINDOWS_NATIVE_STREAM_HELPER_PROTOCOL_V1.md`.

## Component boundary

The final Windows implementation is split deliberately:

1. a signed GPUbnb Indirect Display Driver (IddCx / UMDF) creates the GPUbnb
   virtual display used by the renter;
2. this helper owns the renter-session lifecycle, exact-GPU binding, capture,
   hardware encoding and loopback media endpoint;
3. the Python Agent verifies every helper proof and exposes only the
   authenticated GPUbnb data plane;
4. the API remains authoritative for booking, fencing, reconnect and billing.

The helper must not capture the provider's physical/personal desktop.

## Build

```powershell
cargo fmt --manifest-path native/windows-stream-helper/Cargo.toml -- --check
cargo test --locked --manifest-path native/windows-stream-helper/Cargo.toml --all-targets
cargo clippy --locked --manifest-path native/windows-stream-helper/Cargo.toml --all-targets -- -D warnings
cargo build --locked --release --manifest-path native/windows-stream-helper/Cargo.toml
```

Until the native backend is implemented and physically qualified, running:

```powershell
.\native\windows-stream-helper\target\release\gpubnb-windows-stream.exe --self-test --json
```

must return non-zero.
