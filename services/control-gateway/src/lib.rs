#![forbid(unsafe_code)]

pub mod admin;
pub mod config;
pub mod distributed_lab;
pub mod metrics;
pub mod production_lab;
pub mod protocol;
pub mod qualification;
pub mod quic;
pub mod registry;
pub mod store;
pub mod wire;

pub const CONTROL_GATEWAY_PROTOCOL_VERSION: u16 = 1;
pub const CONTROL_GATEWAY_ALPN: &str = "gpubnb-control/1";
