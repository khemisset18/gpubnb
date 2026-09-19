//! Security-critical state primitives for the GPUbnb Windows native backend.
//!
//! This library layer contains no Win32/WDK calls. It defines the fail-closed
//! lifecycle rules that the future service/worker/IddCx/DXGI/NVENC backend must
//! obey before the CLI is ever allowed to report a ready renter session.

pub mod browser_media_protocol;
pub mod lifecycle;
pub mod local_media_protocol;
pub mod media_protocol;

pub mod worker_protocol;

pub mod application_trust;
pub mod backend;
pub mod capture_policy;
pub mod graphics_proof;

#[cfg(target_os = "windows")]
pub mod service_runtime;
