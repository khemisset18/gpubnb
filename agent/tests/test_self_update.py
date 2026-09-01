"""Tests for gpubnb_agent.self_update - the real update logic (fetch, verify,
replace, roll back) with every side effect (HTTP, service control, sleeping,
wall-clock) injected, so this proves the actual mechanics work without a
real Windows service. See docs/QUARANTINE_DIAGNOSTICS_SYSTEM.md #14/#15 for
the incident this closes: a stale frozen Windows service binary that
silently predated the fix in this repository by two days, with no official
way for an already-installed Host to ever pick up the correction.
"""
from __future__ import annotations

import hashlib
import io
import json
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory

from gpubnb_agent.self_update import (
    PORTABLE_ASSET_NAME,
    ReleaseInfo,
    SelfUpdateError,
    _is_downgrade,
    candidate_agent_version,
    download_and_verify_agent_exe,
    fetch_release_info,
    is_update_available,
    perform_self_update,
)

FAKE_EXE_OLD = b"MZ" + b"\x00" * (262144)
FAKE_EXE_NEW = b"MZ" + b"\x01" * (262144)


def _fake_run_version_command(_candidate_path: Path) -> str:
    # The default real implementation actually executes the candidate exe -
    # these fixtures are not real executables, so every perform_self_update
    # call that reaches the version-check stage must inject this instead.
    return "0.6.2"


def _portable_zip_bytes(exe_bytes: bytes) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("gpubnb-agent.exe", exe_bytes)
        archive.writestr("gpubnb-host-tunnel.exe", b"stub")
        archive.writestr("LISEZ-MOI.txt", "stub")
    return buffer.getvalue()


def _release_payload(commit: str = "a" * 40) -> dict:
    return {
        "tag_name": "host-test-latest",
        "target_commitish": commit,
        "assets": [
            {"name": PORTABLE_ASSET_NAME, "browser_download_url": "https://example.invalid/portable.zip"},
            {"name": "SHA256SUMS.txt", "browser_download_url": "https://example.invalid/SHA256SUMS.txt"},
            {"name": "gpubnb-host-windows-x64.exe", "browser_download_url": "https://example.invalid/installer.exe"},
        ],
    }


def _fake_http(zip_bytes: bytes, release_payload: dict) -> "callable":
    sums = f"{hashlib.sha256(zip_bytes).hexdigest()}  {PORTABLE_ASSET_NAME}\n"

    def http_get(url: str) -> bytes:
        if url.endswith("/releases/tags/host-test-latest"):
            return json.dumps(release_payload).encode("utf-8")
        if url.endswith("SHA256SUMS.txt"):
            return sums.encode("utf-8")
        if url.endswith("portable.zip"):
            return zip_bytes
        raise AssertionError(f"unexpected URL in test: {url}")

    return http_get


class ReleaseInfoTests(unittest.TestCase):
    def test_fetch_release_info_parses_the_real_asset_shape(self) -> None:
        http_get = _fake_http(_portable_zip_bytes(FAKE_EXE_NEW), _release_payload("f" * 40))
        info = fetch_release_info(http_get=http_get)
        self.assertEqual(info.commit, "f" * 40)
        self.assertTrue(info.portable_zip_url.endswith("portable.zip"))
        self.assertTrue(info.sha256sums_url.endswith("SHA256SUMS.txt"))

    def test_missing_portable_asset_is_a_real_error_not_a_silent_skip(self) -> None:
        payload = _release_payload()
        payload["assets"] = [a for a in payload["assets"] if a["name"] != PORTABLE_ASSET_NAME]
        with self.assertRaises(SelfUpdateError):
            fetch_release_info(http_get=_fake_http(_portable_zip_bytes(FAKE_EXE_NEW), payload))


class UpdateAvailableTests(unittest.TestCase):
    def test_dev_build_always_considers_an_update_available(self) -> None:
        release = ReleaseInfo(tag="t", commit="a" * 40, portable_zip_url="u", sha256sums_url="s")
        self.assertTrue(is_update_available(release, current_build_commit="dev"))

    def test_matching_commit_prefix_is_already_current(self) -> None:
        full = "abc123def456" + "0" * 28
        release = ReleaseInfo(tag="t", commit=full, portable_zip_url="u", sha256sums_url="s")
        self.assertFalse(is_update_available(release, current_build_commit=full[:12]))

    def test_different_commit_is_an_update(self) -> None:
        release = ReleaseInfo(tag="t", commit="f" * 40, portable_zip_url="u", sha256sums_url="s")
        self.assertTrue(is_update_available(release, current_build_commit="a" * 12))


class DowngradeProtectionTests(unittest.TestCase):
    def test_a_strictly_older_semver_is_a_downgrade(self) -> None:
        self.assertTrue(_is_downgrade("0.7.0", "0.6.2"))

    def test_an_equal_or_newer_semver_is_never_a_downgrade(self) -> None:
        self.assertFalse(_is_downgrade("0.6.2", "0.6.2"))
        self.assertFalse(_is_downgrade("0.6.2", "0.6.3"))
        self.assertFalse(_is_downgrade("0.6.2", "1.0.0"))

    def test_an_unparseable_version_never_blocks_since_it_cannot_prove_a_downgrade(self) -> None:
        self.assertFalse(_is_downgrade("0.6.2", "not-a-version"))
        self.assertFalse(_is_downgrade("not-a-version", "0.6.2"))

    def test_candidate_agent_version_runs_the_downloaded_exe_in_a_throwaway_temp_path(self) -> None:
        seen_paths: list[Path] = []

        def fake_run(path: Path) -> str:
            seen_paths.append(path)
            self.assertTrue(path.exists())
            self.assertEqual(path.read_bytes(), b"fake-exe-bytes")
            return "0.6.2"

        result = candidate_agent_version(b"fake-exe-bytes", run_version_command=fake_run)
        self.assertEqual(result, "0.6.2")
        self.assertEqual(len(seen_paths), 1)
        # The temp file must be cleaned up afterward - never left behind.
        self.assertFalse(seen_paths[0].exists())


class DownloadAndVerifyTests(unittest.TestCase):
    def test_correct_checksum_extracts_the_real_agent_exe(self) -> None:
        zip_bytes = _portable_zip_bytes(FAKE_EXE_NEW)
        release = fetch_release_info(http_get=_fake_http(zip_bytes, _release_payload()))
        extracted = download_and_verify_agent_exe(release, http_get=_fake_http(zip_bytes, _release_payload()))
        self.assertEqual(extracted, FAKE_EXE_NEW)

    def test_tampered_zip_is_rejected_never_installed(self) -> None:
        good_zip = _portable_zip_bytes(FAKE_EXE_NEW)
        release = fetch_release_info(http_get=_fake_http(good_zip, _release_payload()))
        tampered_zip = _portable_zip_bytes(b"MZ" + b"\xff" * 262144)

        def http_get(url: str) -> bytes:
            if url.endswith("portable.zip"):
                return tampered_zip  # checksum in SHA256SUMS.txt still matches the ORIGINAL zip
            return _fake_http(good_zip, _release_payload())(url)

        with self.assertRaises(SelfUpdateError) as ctx:
            download_and_verify_agent_exe(release, http_get=http_get)
        self.assertIn("checksum_mismatch", str(ctx.exception))

    def test_a_non_pe_file_inside_a_correctly_checksummed_zip_is_still_rejected(self) -> None:
        zip_bytes = _portable_zip_bytes(b"not-an-exe-but-262144-bytes-padded" + b"\x00" * 262144)
        release = fetch_release_info(http_get=_fake_http(zip_bytes, _release_payload()))
        with self.assertRaises(SelfUpdateError) as ctx:
            download_and_verify_agent_exe(release, http_get=_fake_http(zip_bytes, _release_payload()))
        self.assertIn("not_a_valid_pe", str(ctx.exception))


class PerformSelfUpdateTests(unittest.TestCase):
    def _install_dir(self, tmp: str, exe_bytes: bytes = FAKE_EXE_OLD) -> Path:
        directory = Path(tmp)
        (directory / "gpubnb-agent.exe").write_bytes(exe_bytes)
        return directory

    def test_already_current_makes_no_service_calls_and_touches_no_file(self) -> None:
        with TemporaryDirectory() as tmp:
            install_dir = self._install_dir(tmp)
            original = (install_dir / "gpubnb-agent.exe").read_bytes()
            zip_bytes = _portable_zip_bytes(FAKE_EXE_NEW)
            calls: list[str] = []
            result = perform_self_update(
                install_dir,
                current_build_commit="f" * 12,
                http_get=_fake_http(zip_bytes, _release_payload("f" * 40)),
                stop_service=lambda: calls.append("stop"),
                start_service=lambda: calls.append("start"),
                service_running=lambda: True,
            )
            self.assertFalse(result.updated)
            self.assertEqual(calls, [])
            self.assertEqual((install_dir / "gpubnb-agent.exe").read_bytes(), original)

    def test_dry_run_reports_an_available_update_but_replaces_nothing(self) -> None:
        with TemporaryDirectory() as tmp:
            install_dir = self._install_dir(tmp)
            original = (install_dir / "gpubnb-agent.exe").read_bytes()
            zip_bytes = _portable_zip_bytes(FAKE_EXE_NEW)
            calls: list[str] = []
            result = perform_self_update(
                install_dir,
                current_build_commit="a" * 12,
                dry_run=True,
                http_get=_fake_http(zip_bytes, _release_payload("f" * 40)),
                run_version_command=_fake_run_version_command,
                stop_service=lambda: calls.append("stop"),
                start_service=lambda: calls.append("start"),
                service_running=lambda: True,
            )
            self.assertFalse(result.updated)
            self.assertEqual(result.new_commit, "f" * 40)
            self.assertEqual(calls, [])
            self.assertEqual((install_dir / "gpubnb-agent.exe").read_bytes(), original)

    def test_a_real_update_stops_replaces_restarts_and_keeps_a_real_backup(self) -> None:
        with TemporaryDirectory() as tmp:
            install_dir = self._install_dir(tmp)
            zip_bytes = _portable_zip_bytes(FAKE_EXE_NEW)
            calls: list[str] = []
            running = {"value": True}

            def stop_service() -> None:
                calls.append("stop")
                running["value"] = False

            def start_service() -> None:
                calls.append("start")
                running["value"] = True

            result = perform_self_update(
                install_dir,
                current_build_commit="a" * 12,
                http_get=_fake_http(zip_bytes, _release_payload("f" * 40)),
                run_version_command=_fake_run_version_command,
                stop_service=stop_service,
                start_service=start_service,
                service_running=lambda: running["value"],
                sleep=lambda _seconds: None,
            )
            self.assertTrue(result.updated)
            self.assertEqual(calls, ["stop", "start"])
            self.assertEqual((install_dir / "gpubnb-agent.exe").read_bytes(), FAKE_EXE_NEW)
            self.assertIsNotNone(result.backup_path)
            self.assertEqual(Path(result.backup_path).read_bytes(), FAKE_EXE_OLD)

    def test_stop_pending_is_never_mistaken_for_fully_stopped(self) -> None:
        # Real bug found by testing against a real (disposable) Windows
        # service: after `stop`, a service reports running=False while
        # STOP_PENDING for several real seconds before reaching STOPPED.
        # Restarting as soon as running() goes false (without a distinct
        # "is it actually STOPPED" check) races the real SCM and fails with
        # "StartService failed: 1056, an instance of the service is already
        # running". service_stopped must be consulted, not service_running,
        # to decide when it is safe to swap the binary and restart.
        with TemporaryDirectory() as tmp:
            install_dir = self._install_dir(tmp)
            zip_bytes = _portable_zip_bytes(FAKE_EXE_NEW)
            state = {"phase": "running"}  # running -> stop_pending -> stopped -> running
            calls: list[str] = []

            def stop_service() -> None:
                calls.append("stop")
                state["phase"] = "stop_pending"

            def start_service() -> None:
                calls.append("start")
                if state["phase"] != "stopped":
                    raise RuntimeError("service_control_failed:start:1056:already running")
                state["phase"] = "running"

            ticks = {"n": 0}

            def service_running() -> bool:
                return state["phase"] == "running"

            def service_stopped() -> bool:
                # Stays STOP_PENDING for a few polls before settling, exactly
                # like the real SCM did in the reproduction above.
                if state["phase"] == "stop_pending":
                    ticks["n"] += 1
                    if ticks["n"] >= 3:
                        state["phase"] = "stopped"
                return state["phase"] == "stopped"

            result = perform_self_update(
                install_dir,
                current_build_commit="a" * 12,
                http_get=_fake_http(zip_bytes, _release_payload("f" * 40)),
                run_version_command=_fake_run_version_command,
                stop_service=stop_service,
                start_service=start_service,
                service_running=service_running,
                service_stopped=service_stopped,
                sleep=lambda _seconds: None,
            )
            self.assertTrue(result.updated)
            self.assertEqual(calls, ["stop", "start"])
            self.assertEqual((install_dir / "gpubnb-agent.exe").read_bytes(), FAKE_EXE_NEW)

    def test_a_service_that_never_stops_is_never_touched(self) -> None:
        # Real risk this guards against: a hung stop leaving the install
        # directory with neither a working old binary nor a working new one.
        with TemporaryDirectory() as tmp:
            install_dir = self._install_dir(tmp)
            zip_bytes = _portable_zip_bytes(FAKE_EXE_NEW)
            with self.assertRaises(SelfUpdateError) as ctx:
                perform_self_update(
                    install_dir,
                    current_build_commit="a" * 12,
                    http_get=_fake_http(zip_bytes, _release_payload("f" * 40)),
                    run_version_command=_fake_run_version_command,
                    stop_service=lambda: None,
                    start_service=lambda: self.fail("must not start before stop is confirmed"),
                    service_running=lambda: True,  # never actually stops
                    now=_incrementing_clock(),
                    sleep=lambda _seconds: None,
                )
            self.assertIn("service_did_not_stop_in_time", str(ctx.exception))
            self.assertEqual((install_dir / "gpubnb-agent.exe").read_bytes(), FAKE_EXE_OLD)
            self.assertEqual(list(install_dir.glob("gpubnb-agent.exe.new")), [])

    def test_a_release_reporting_an_older_agent_version_is_refused_never_installed(self) -> None:
        # Real protection requested: if host-test-latest ever pointed at an
        # older release (bad promotion, rollback, compromised channel), the
        # agent must never silently downgrade itself just because the commit
        # differs from what is currently installed.
        with TemporaryDirectory() as tmp:
            install_dir = self._install_dir(tmp)
            zip_bytes = _portable_zip_bytes(FAKE_EXE_NEW)
            calls: list[str] = []
            with self.assertRaises(SelfUpdateError) as ctx:
                perform_self_update(
                    install_dir,
                    current_build_commit="a" * 12,
                    current_agent_version="0.9.0",
                    http_get=_fake_http(zip_bytes, _release_payload("f" * 40)),
                    run_version_command=lambda _path: "0.6.2",  # older than 0.9.0
                    stop_service=lambda: calls.append("stop"),
                    start_service=lambda: calls.append("start"),
                    service_running=lambda: True,
                )
            self.assertIn("downgrade_refused", str(ctx.exception))
            self.assertEqual(calls, [], "must never touch the service on a refused downgrade")
            self.assertEqual((install_dir / "gpubnb-agent.exe").read_bytes(), FAKE_EXE_OLD)

    def test_a_service_that_fails_to_start_is_rolled_back_to_the_known_good_binary(self) -> None:
        with TemporaryDirectory() as tmp:
            install_dir = self._install_dir(tmp)
            zip_bytes = _portable_zip_bytes(FAKE_EXE_NEW)
            start_attempts: list[int] = []

            def start_service() -> None:
                start_attempts.append(1)
                raise RuntimeError("service_control_failed:start:boom")

            with self.assertRaises(SelfUpdateError) as ctx:
                perform_self_update(
                    install_dir,
                    current_build_commit="a" * 12,
                    http_get=_fake_http(zip_bytes, _release_payload("f" * 40)),
                    run_version_command=_fake_run_version_command,
                    stop_service=lambda: None,
                    start_service=start_service,
                    service_running=lambda: False,
                    sleep=lambda _seconds: None,
                )
            self.assertIn("service_start_failed_after_update", str(ctx.exception))
            # Rolled back: the install directory has its ORIGINAL binary back,
            # not the new (unstartable) one, and a restart was attempted.
            self.assertEqual((install_dir / "gpubnb-agent.exe").read_bytes(), FAKE_EXE_OLD)
            self.assertGreaterEqual(len(start_attempts), 2)


def _incrementing_clock():
    state = {"value": 0.0}

    def now() -> float:
        state["value"] += 1.0
        return state["value"]

    return now


if __name__ == "__main__":
    unittest.main()
