from __future__ import annotations

import hashlib
import io
import json
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory

from gpubnb_agent.self_update import PORTABLE_ASSET_NAME, SelfUpdateError, perform_self_update

OLD_EXE = b"MZ" + b"\x00" * 262144
NEW_EXE = b"MZ" + b"\x01" * 262144
RELEASE_COMMIT = "f" * 40


def portable_zip() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("gpubnb-agent.exe", NEW_EXE)
    return buffer.getvalue()


def fake_http():
    zip_bytes = portable_zip()
    sums = f"{hashlib.sha256(zip_bytes).hexdigest()}  {PORTABLE_ASSET_NAME}\n"
    payload = {
        "tag_name": "host-test-latest",
        "target_commitish": RELEASE_COMMIT,
        "assets": [
            {"name": PORTABLE_ASSET_NAME, "browser_download_url": "https://example.invalid/portable.zip"},
            {"name": "SHA256SUMS.txt", "browser_download_url": "https://example.invalid/SHA256SUMS.txt"},
        ],
    }

    def get(url: str) -> bytes:
        if url.endswith("/releases/tags/host-test-latest"):
            return json.dumps(payload).encode()
        if url.endswith("SHA256SUMS.txt"):
            return sums.encode()
        if url.endswith("portable.zip"):
            return zip_bytes
        raise AssertionError(url)

    return get


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


class SelfUpdateFailureMatrixTests(unittest.TestCase):
    def test_service_that_never_stops_is_never_replaced(self) -> None:
        with TemporaryDirectory() as tmp:
            path = install_dir(tmp)
            starts: list[str] = []

            with self.assertRaisesRegex(SelfUpdateError, "service_did_not_stop_in_time"):
                perform_self_update(
                    path,
                    current_build_commit="a" * 12,
                    http_get=fake_http(),
                    run_version_command=lambda _path: "0.6.6",
                    stop_service=lambda: None,
                    start_service=lambda: starts.append("start"),
                    service_running=lambda: True,
                    service_stopped=lambda: False,
                    now=advancing_clock(),
                    sleep=lambda _seconds: None,
                )

            self.assertEqual(starts, [])
            self.assertEqual((path / "gpubnb-agent.exe").read_bytes(), OLD_EXE)
            self.assertFalse((path / "gpubnb-agent.exe.new").exists())

    def test_immediate_new_service_start_failure_restores_old_binary(self) -> None:
        with TemporaryDirectory() as tmp:
            path = install_dir(tmp)
            running = {"value": True}
            starts = {"count": 0}

            def stop() -> None:
                running["value"] = False

            def start() -> None:
                starts["count"] += 1
                if starts["count"] == 1:
                    raise RuntimeError("candidate_start_failed")
                running["value"] = True

            with self.assertRaisesRegex(SelfUpdateError, "service_start_failed_after_update:.*rollback=ok"):
                perform_self_update(
                    path,
                    current_build_commit="a" * 12,
                    http_get=fake_http(),
                    run_version_command=lambda _path: "0.6.6",
                    stop_service=stop,
                    start_service=start,
                    service_running=lambda: running["value"],
                    service_stopped=lambda: not running["value"],
                    now=advancing_clock(step=1.0),
                    sleep=lambda _seconds: None,
                )

            self.assertEqual(starts["count"], 2)
            self.assertTrue(running["value"])
            self.assertEqual((path / "gpubnb-agent.exe").read_bytes(), OLD_EXE)


if __name__ == "__main__":
    unittest.main()
