#![allow(dead_code)]

#[path = "../src/installation_identity.rs"]
mod installation_identity;

use installation_identity::{InstallationIdentity, InstallationIdentityStore};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn unique_path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "gpubnb-{name}-{}-{}.json",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

#[test]
fn generated_identity_never_uses_operational_placeholders() {
    let identity = InstallationIdentity::generate().unwrap();
    assert_ne!(identity.installation_id, "unpaired_installation");
    assert_ne!(identity.local_machine_id, "unpaired_machine");
    assert!(identity.validate().is_ok());
}

#[test]
fn identity_survives_application_restart() {
    let path = unique_path("installation-restart");
    let first_store = InstallationIdentityStore::from_path(path.clone());
    let first = first_store.load_or_create().unwrap();

    let restarted_store = InstallationIdentityStore::from_path(path.clone());
    let after_restart = restarted_store.load_or_create().unwrap();
    assert_eq!(first, after_restart);
    assert_eq!(restarted_store.path(), path.as_path());

    let _ = fs::remove_file(path);
}

#[test]
fn malformed_or_placeholder_identity_is_rejected() {
    let path = unique_path("installation-placeholder");
    fs::write(
        &path,
        r#"{"schemaVersion":1,"installationId":"unpaired_installation","localMachineId":"unpaired_machine","createdAtUnixSeconds":1}"#,
    )
    .unwrap();

    let store = InstallationIdentityStore::from_path(path.clone());
    assert!(store.load_or_create().is_err());

    let _ = fs::remove_file(path);
}
