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
    SelfUpdateError,
    fetch_release_info,
    perform_self_update,
    perform_verified_self_update,
)

OLD_EXE = b"MZ" + b"\x00" * 262144
NEW_EXE = b"MZ" + b"\x01" * 262144
RELEASE_COMMIT = "f" * 40


def portable_zip(exe: bytes = NEW_EXE) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("gpubnb-agent.exe", exe)
    return buffer.getvalue()


def release_payload(commit: str = RELEASE_COMMIT) -> dict:
    return {
        "tag_name": "host-test-latest",
        "target_commitish": commit,
        "assets": [
            {"name": PORTABLE_ASSET_NAME, "browser_download_url": "https://example.invalid/portable.zip"},
            {"name": "SHA256SUMS.txt", "browser_download_url": "https://example.invalid/SHA256SUMS.txt"},
        ],
    }


def fake_http(zip_bytes: bytes, payload: dict | None = None):
    payload = payload or release_payload()
    sums = f"{hashlib.sha256(zip_bytes).hexdigest()}  {PORTABLE_ASSET_NAME}\n"

    def get(url: str) -> bytes:
        if url.endswith("/releases/tags/host-test-latest"):
            return json.dumps(payload).encode()
        if url.endswith("SHA256SUMS.txt"):
            return sums.encode()
        if url.endswith("portable.zip"):
            return zip_bytes
        raise AssertionError(url)

    return get


def build_info(commit: str = RELEASE_COMMIT[:12]) -> dict:
    return {
        "agentVersion": "0.6.6",
        "buildCommit": commit,
        "frozen": True,
        "executable": "ignored-by-validator",
    }


def install_dir(tmp: str) -> Path:
    path = Path(tmp)
    (path / "gpubnb-agent.exe").write_bytes(OLD_EXE)
    return path


def advancing_clock(step: float = 10.0):
    state = {"value": 0.0}

    def now() -> float:
        state["value"] += step
        return state["value"]

    return now


class VerifiedReleaseIdentityTests(unittest.TestCase):
    def test_release_target_must_be_an_exact_immutable_commit(self) -> None:
        with self.assertRaisesRegex(SelfUpdateError, "release_commit_invalid"):
            fetch_release_info(
                http_get=fake_http(portable_zip(), release_payload("main")),
            )

    def test_candidate_from_wrong_commit_is_refused_before_service_stop(self) -> None:
        with TemporaryDirectory() as tmp:
            calls: list[str] = []
            with self.assertRaisesRegex(SelfUpdateError, "candidate_commit_mismatch"):
                perform_verified_self_update(
                    install_dir(tmp),
                    current_build_commit="a" * 12,
                    dry_run=True,
                    http_get=fake_http(portable_zip()),
                    run_version_command=lambda _path: "0.6.6",
                    run_build_info_command=lambda _path: build_info("b" * 12),
                    run_runtime_check=lambda _path: True,
                    stop_service=lambda: calls.append("stop"),
                    start_service=lambda: calls.append("start"),
                    service_running=lambda: True,
                )
            self.assertEqual(calls, [])
            self.assertEqual((Path(tmp) / "gpubnb-agent.exe").read_bytes(), OLD_EXE)

    def test_verified_update_checks_candidate_installed_identity_and_runtime(self) -> None:
        with TemporaryDirectory() as tmp:
            path = install_dir(tmp)
            running = {"value": True}
            calls: list[str] = []

            def stop() -> None:
                calls.append("stop")
                running["value"] = False

            def start() -> None:
                calls.append("start")
                running["value"] = True

            result = perform_verified_self_update(
                path,
                current_build_commit="a" * 12,
                http_get=fake_http(portable_zip()),
                run_version_command=lambda _path: "0.6.6",
                run_build_info_command=lambda _path: build_info(),
                run_runtime_check=lambda _path: True,
                stop_service=stop,
                start_service=start,
                service_running=lambda: running["value"],
                sleep=lambda _seconds: None,
            )
            self.assertTrue(result.updated)
            self.assertEqual(calls, ["stop", "start"])
            self.assertEqual((path / "gpubnb-agent.exe").read_bytes(), NEW_EXE)
            self.assertIsNotNone(result.backup_path)
            self.assertEqual(Path(result.backup_path).read_bytes(), OLD_EXE)

    def test_failed_runtime_probe_rolls_back_to_known_good_binary(self) -> None:
        with TemporaryDirectory() as tmp:
            path = install_dir(tmp)
            running = {"value": True}
            calls: list[str] = []

            def stop() -> None:
                calls.append("stop")
                running["value"] = False

            def start() -> None:
                calls.append("start")
                running["value"] = True

            with self.assertRaisesRegex(SelfUpdateError, "runtime_health_failed"):
                perform_verified_self_update(
                    path,
                    current_build_commit="a" * 12,
                    http_get=fake_http(portable_zip()),
                    run_version_command=lambda _path: "0.6.6",
                    run_build_info_command=lambda _path: build_info(),
                    run_runtime_check=lambda _path: False,
                    stop_service=stop,
                    start_service=start,
                    service_running=lambda: running["value"],
                    sleep=lambda _seconds: None,
                )
            self.assertEqual((path / "gpubnb-agent.exe").read_bytes(), OLD_EXE)
            self.assertEqual(calls, ["stop", "start", "stop", "start"])

    def test_installed_commit_mismatch_rolls_back(self) -> None:
        with TemporaryDirectory() as tmp:
            path = install_dir(tmp)
            running = {"value": True}

            def stop() -> None:
                running["value"] = False

            def start() -> None:
                running["value"] = True

            def info(exe_path: Path) -> dict:
                if exe_path.name == "gpubnb-agent.exe":
                    return build_info("e" * 12)
                return build_info()

            with self.assertRaisesRegex(SelfUpdateError, "installed_commit_mismatch"):
                perform_verified_self_update(
                    path,
                    current_build_commit="a" * 12,
                    http_get=fake_http(portable_zip()),
                    run_version_command=lambda _path: "0.6.6",
                    run_build_info_command=info,
                    run_runtime_check=lambda _path: True,
                    stop_service=stop,
                    start_service=start,
                    service_running=lambda: running["value"],
                    sleep=lambda _seconds: None,
                )
            self.assertEqual((path / "gpubnb-agent.exe").read_bytes(), OLD_EXE)


class TransactionRollbackTests(unittest.TestCase):
    def test_start_timeout_restores_old_binary_and_restarts_it(self) -> None:
        with TemporaryDirectory() as tmp:
            path = install_dir(tmp)
            running = {"value": True}
            starts = {"count": 0}

            def stop() -> None:
                running["value"] = False

            def start() -> None:
                starts["count"] += 1
                # New candidate never reaches RUNNING. Once rollback restores
                # the old binary, the second start succeeds.
                if starts["count"] >= 2:
                    running["value"] = True

            with self.assertRaisesRegex(SelfUpdateError, "service_did_not_start_after_update"):
                perform_self_update(
                    path,
                    current_build_commit="a" * 12,
                    http_get=fake_http(portable_zip()),
                    run_version_command=lambda _path: "0.6.6",
                    stop_service=stop,
                    start_service=start,
                    service_running=lambda: running["value"],
                    now=advancing_clock(),
                    sleep=lambda _seconds: None,
                )
            self.assertEqual(starts["count"], 2)
            self.assertEqual((path / "gpubnb-agent.exe").read_bytes(), OLD_EXE)


if __name__ == "__main__":
    unittest.main()
