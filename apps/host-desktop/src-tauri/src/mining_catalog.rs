#[path = "mining_catalog/operational_runtime.rs"]
pub mod operational_runtime;
#[path = "mining_catalog/process_manager.rs"]
pub mod process_manager;
#[path = "mining_catalog/secure_launcher.rs"]
pub mod secure_launcher;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GpuVendor {
    Nvidia,
    Amd,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MiningProfile {
    pub id: &'static str,
    pub symbol: &'static str,
    pub algorithm: &'static str,
    pub miner: &'static str,
    pub vendors: &'static [GpuVendor],
    pub enabled: bool,
}

const NVIDIA_ONLY: &[GpuVendor] = &[GpuVendor::Nvidia];
const AMD_AND_NVIDIA: &[GpuVendor] = &[GpuVendor::Amd, GpuVendor::Nvidia];

pub const MINING_PROFILES: &[MiningProfile] = &[
    MiningProfile {
        id: "lolminer_blake3",
        symbol: "ALPH",
        algorithm: "blake3",
        miner: "lolminer",
        vendors: AMD_AND_NVIDIA,
        enabled: true,
    },
    MiningProfile {
        id: "lolminer_etchash",
        symbol: "ETC",
        algorithm: "etchash",
        miner: "lolminer",
        vendors: AMD_AND_NVIDIA,
        enabled: true,
    },
    MiningProfile {
        id: "lolminer_octopus",
        symbol: "CFX",
        algorithm: "octopus",
        miner: "lolminer",
        vendors: AMD_AND_NVIDIA,
        enabled: true,
    },
    MiningProfile {
        id: "trex_rvn_kawpow",
        symbol: "RVN",
        algorithm: "kawpow",
        miner: "t-rex",
        vendors: NVIDIA_ONLY,
        enabled: false,
    },
    MiningProfile {
        id: "teamredminer_rvn_kawpow",
        symbol: "RVN",
        algorithm: "kawpow",
        miner: "teamredminer",
        vendors: &[GpuVendor::Amd],
        enabled: false,
    },
    MiningProfile {
        id: "lolminer_etc_etchash",
        symbol: "ETC",
        algorithm: "etchash",
        miner: "lolminer",
        vendors: AMD_AND_NVIDIA,
        enabled: false,
    },
    MiningProfile {
        id: "lolminer_erg_autolykos2",
        symbol: "ERG",
        algorithm: "autolykos2",
        miner: "lolminer",
        vendors: AMD_AND_NVIDIA,
        enabled: false,
    },
    MiningProfile {
        id: "lolminer_flux_zelhash",
        symbol: "FLUX",
        algorithm: "zelhash",
        miner: "lolminer",
        vendors: AMD_AND_NVIDIA,
        enabled: false,
    },
    MiningProfile {
        id: "lolminer_beam_beamhashiii",
        symbol: "BEAM",
        algorithm: "beamhashiii",
        miner: "lolminer",
        vendors: AMD_AND_NVIDIA,
        enabled: false,
    },
    MiningProfile {
        id: "lolminer_ctxc_cuckatoo32",
        symbol: "CTXC",
        algorithm: "cuckatoo32",
        miner: "lolminer",
        vendors: AMD_AND_NVIDIA,
        enabled: false,
    },
];

pub fn profile_by_id(id: &str) -> Option<&'static MiningProfile> {
    MINING_PROFILES.iter().find(|profile| profile.id == id)
}

pub fn approved_for_vendor(id: &str, vendor: GpuVendor) -> bool {
    profile_by_id(id).is_some_and(|profile| profile.enabled && profile.vendors.contains(&vendor))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_pinned_runtime_profiles_are_approved() {
        assert!(approved_for_vendor("lolminer_etchash", GpuVendor::Nvidia));
        assert!(approved_for_vendor("lolminer_etchash", GpuVendor::Amd));
        assert!(!approved_for_vendor("trex_rvn_kawpow", GpuVendor::Nvidia));
        assert!(!approved_for_vendor(
            "lolminer_beam_beamhashiii",
            GpuVendor::Nvidia
        ));
    }
}
