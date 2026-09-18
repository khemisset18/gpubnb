//! Execute the real binary: unit tests alone cannot validate exit/stdout behavior.
use std::process::Command;

fn assert_failure(args: &[&str], code: i32, reason: &str) {
    let output = Command::new(env!("CARGO_BIN_EXE_gpubnb-windows-stream"))
        .args(args)
        .output()
        .expect("helper process starts");
    assert_eq!(output.status.code(), Some(code));
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        format!(r#"{{"ok":false,"error":"{reason}"}}"#)
    );
    assert_eq!(
        String::from_utf8(output.stderr).unwrap().trim(),
        format!("error:{reason}")
    );
}

#[test]
fn self_test_never_confuses_a_crash_with_expected_unavailability() {
    let (code, reason) = if cfg!(target_os = "windows") {
        (21, "native_backend_not_implemented")
    } else {
        (20, "windows_required")
    };
    assert_failure(&["--self-test", "--json"], code, reason);
}

#[test]
fn start_and_repeated_stop_remain_unverified_without_a_backend() {
    assert_failure(
        &[
            "--start",
            "--json",
            "--session-id",
            "sess-1",
            "--workspace",
            "cloud-desktop",
            "--gpu-uuid",
            "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a",
        ],
        21,
        "native_backend_not_implemented",
    );
    for _ in 0..2 {
        assert_failure(
            &["--stop", "--json", "--session-id", "sess-1"],
            21,
            "native_backend_not_implemented",
        );
    }
}

#[test]
fn untrusted_arguments_are_never_echoed_in_errors() {
    assert_failure(
        &["--stop", "--json", "--session-id", "private/secret"],
        2,
        "invalid_session_id",
    );
    assert_failure(
        &[
            "--start",
            "--json",
            "--session-id",
            "sess-1",
            "--workspace",
            "creator",
            "--gpu-uuid",
            "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a",
            "--application",
            r"C:\Private\secret.exe",
        ],
        2,
        "application_not_qualified",
    );
}
