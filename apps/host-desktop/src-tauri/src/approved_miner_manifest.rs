use super::secure_launcher::MinerBinaryManifest;

pub const XMRIG_VERSION: &str = "6.26.0";
const XMRIG_RELEASE_BASE_URL: &str =
    "https://github.com/xmrig/xmrig/releases/download/v6.26.0";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ApprovedMinerRelease {
    pub profile_id: &'static str,
    pub version: &'static str,
    pub archive_name: &'static str,
    pub archive_sha256: &'static str,
    pub binary_file_name: &'static str,
    pub binary_sha256: &'static str,
    pub source_url: &'static str,
}

impl ApprovedMinerRelease {
    pub fn binary_manifest(self) -> MinerBinaryManifest {
        MinerBinaryManifest {
            profile_id: self.profile_id,
            file_name: self.binary_file_name,
            sha256: self.binary_sha256,
        }
    }
}

pub fn approved_miner_release(profile_id: &str) -> Result<ApprovedMinerRelease, &'static str> {
    if profile_id != "xmrig_randomx" {
        return Err("approved_miner_manifest_missing");
    }
    platform_xmrig_release().ok_or("approved_miner_platform_unsupported")
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn platform_xmrig_release() -> Option<ApprovedMinerRelease> {
    Some(ApprovedMinerRelease {
        profile_id: "xmrig_randomx",
        version: XMRIG_VERSION,
        archive_name: "xmrig-6.26.0-linux-static-x64.tar.gz",
        archive_sha256: "fc6f8ae5f64e4f17481f7e3be29a1c56949f216a998414188003eae1db20c9e5",
        binary_file_name: "xmrig",
        binary_sha256: "b20f39fc00d242e706b6c30367ad811c676e0575050a4ec2f30104b696944b49",
        source_url: concat!(
            "https://github.com/xmrig/xmrig/releases/download/v6.26.0/",
            "xmrig-6.26.0-linux-static-x64.tar.gz"
        ),
    })
}

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
fn platform_xmrig_release() -> Option<ApprovedMinerRelease> {
    Some(ApprovedMinerRelease {
        profile_id: "xmrig_randomx",
        version: XMRIG_VERSION,
        archive_name: "xmrig-6.26.0-macos-x64.tar.gz",
        archive_sha256: "1da924b358c0089e361540c4a9e6f8b09538b29efeafa2379590e0f6db358ff4",
        binary_file_name: "xmrig",
        binary_sha256: "3bf7a353daa4af0f4d2aa4c5a0294fd14d3a330b0abf2e2e4dd23e14650aa527",
        source_url: concat!(
            "https://github.com/xmrig/xmrig/releases/download/v6.26.0/",
            "xmrig-6.26.0-macos-x64.tar.gz"
        ),
    })
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn platform_xmrig_release() -> Option<ApprovedMinerRelease> {
    Some(ApprovedMinerRelease {
        profile_id: "xmrig_randomx",
        version: XMRIG_VERSION,
        archive_name: "xmrig-6.26.0-macos-arm64.tar.gz",
        archive_sha256: "6ae4eb4216e99a201ae9a3d2c3a7c275207c5165cfc25da1f3d735d6c4829c18",
        binary_file_name: "xmrig",
        binary_sha256: "c66f9881bed79a550e18d54b9ae5cf03b91a0e881efdbf7962db2e58de0b4f7b",
        source_url: concat!(
            "https://github.com/xmrig/xmrig/releases/download/v6.26.0/",
            "xmrig-6.26.0-macos-arm64.tar.gz"
        ),
    })
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn platform_xmrig_release() -> Option<ApprovedMinerRelease> {
    Some(ApprovedMinerRelease {
        profile_id: "xmrig_randomx",
        version: XMRIG_VERSION,
        archive_name: "xmrig-6.26.0-windows-x64.zip",
        archive_sha256: "bba8097cb37d9b458a1cb1137876b27cde6740d17fe4ccbc086ba07d87d9e147",
        binary_file_name: "xmrig.exe",
        binary_sha256: "6fa80698d7268f6e88aa88c06fb27ee99e1bcee747c2e76911e6206a5b1aeeb3",
        source_url: concat!(
            "https://github.com/xmrig/xmrig/releases/download/v6.26.0/",
            "xmrig-6.26.0-windows-x64.zip"
        ),
    })
}

#[cfg(not(any(
    all(target_os = "linux", target_arch = "x86_64"),
    all(target_os = "macos", target_arch = "x86_64"),
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "windows", target_arch = "x86_64")
)))]
fn platform_xmrig_release() -> Option<ApprovedMinerRelease> {
    None
}

pub fn validate_release_metadata(release: &ApprovedMinerRelease) -> Result<(), &'static str> {
    if release.version != XMRIG_VERSION
        || release.archive_name.is_empty()
        || release.archive_sha256.len() != 64
        || release.binary_sha256.len() != 64
        || !release
            .archive_sha256
            .bytes()
            .chain(release.binary_sha256.bytes())
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || !release.source_url.starts_with(XMRIG_RELEASE_BASE_URL)
        || !release.source_url.ends_with(release.archive_name)
    {
        return Err("approved_miner_release_invalid");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_platform_release_has_complete_pinned_provenance() {
        let release = approved_miner_release("xmrig_randomx").unwrap();
        assert_eq!(release.version, "6.26.0");
        assert!(validate_release_metadata(&release).is_ok());
    }

    #[test]
    fn unverified_profiles_remain_blocked() {
        assert_eq!(
            approved_miner_release("lolminer_kaspa"),
            Err("approved_miner_manifest_missing")
        );
        assert_eq!(
            approved_miner_release("trex_kawpow"),
            Err("approved_miner_manifest_missing")
        );
    }
}
