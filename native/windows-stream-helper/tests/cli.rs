//! Execute the real binary: unit tests alone cannot validate exit/stdout behavior.
use std::process::Command;

fn run(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_gpubnb-windows-stream"))
        .args(args)
        .output()
        .expect("helper process starts")
}

fn assert_failure(args: &[&str], code: i32, reason: &str) {
    let output = run(args);
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

fn assert_success(args: &[&str], expected_stdout: &str) {
    let output = run(args);
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(String::from_utf8(output.stdout).unwrap().trim(), expected_stdout);
    assert_eq!(String::from_utf8(output.stderr).unwrap().trim(), "");
}

#[test]
fn self_test_never_confuses_a_crash_with_expected_unavailability() {
    let (code, reason) = if cfg!(target_os = "windows") {
        (21, "renter_session_lease_unavailable")
    } else {
        (20, "windows_required")
    };
    assert_failure(&["--self-test", "--json"], code, reason);
}

#[test]
fn start_fails_closed_without_physical_renter_context_and_stop_is_idempotent() {
    let start = [
        "--start",
        "--json",
        "--session-id",
        "sess-1",
        "--workspace",
        "cloud-desktop",
        "--gpu-uuid",
        "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a",
    ];

    if cfg!(target_os = "windows") {
        assert_failure(&start, 21, "renter_session_lease_unavailable");
        for _ in 0..2 {
            assert_success(
                &["--stop", "--json", "--session-id", "sess-1"],
                r#"{"schemaVersion":1,"sessionId":"sess-1","stopped":true}"#,
            );
        }
    } else {
        assert_failure(&start, 20, "windows_required");
        for _ in 0..2 {
            assert_failure(
                &["--stop", "--json", "--session-id", "sess-1"],
                20,
                "windows_required",
            );
        }
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
