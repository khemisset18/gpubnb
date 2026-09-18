//! Security-critical state primitives for the GPUbnb Windows native backend.
//!
//! This library layer contains no Win32/WDK calls. It defines the fail-closed
//! lifecycle rules that the future service/worker/IddCx/DXGI/NVENC backend must
//! obey before the CLI is ever allowed to report a ready renter session.

pub mod lifecycle;

pub mod worker_protocol;

pub mod backend;
pub mod application_trust;
pub mod capture_policy;
