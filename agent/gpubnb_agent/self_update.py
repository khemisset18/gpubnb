"""Self-update for the frozen Windows agent.

This checks the official release channel (the same `host-test-latest` alias
the public "Installer GPUbnb Host" download page and
post-publish-host-windows-verify.yml use - see
netlify/functions/host-download.mjs), verifies the published SHA-256, and
safely replaces the running Windows service's binary.

Deliberately owner-triggered (`gpubnb-agent.exe self-update`), never a
silent background updater: the published binaries are not code-signed yet
(apps/web/host-install.html shows "Signature : non signée" on every
platform), so unattended replacement of a production Windows service's
binary is not something this pass wants to do without a human in the loop.
See docs/QUARANTINE_DIAGNOSTICS_SYSTEM.md for the incident this closes and
the full flow this implements.

Every side effect (HTTP, service control, sleeping, wall-clock) is injected
so the real update logic - fetch, verify, replace, roll back on failure -
can be tested without a real Windows service. See
agent/tests/test_self_update.py.
"""
from __future__ import annotations

import hashlib
import io
import json
import shutil
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable
from urllib.request import Request, urlopen

from ._build_info import BUILD_COMMIT

GITHUB_API = "https://api.github.com"
DEFAULT_REPOSITORY = "khemisset18/gpubnb"
DEFAULT_CHANNEL = "host-test-latest"
PORTABLE_ASSET_NAME = "gpubnb-host-windows-x64-portable.zip"
AGENT_EXE_NAME_IN_ZIP = "gpubnb-agent.exe"
SERVICE_STOP_TIMEOUT_SECONDS = 30
SERVICE_START_TIMEOUT_SECONDS = 30


class SelfUpdateError(RuntimeError):
    pass


def default_http_get(url: str) -> bytes:
    request = Request(
        url,
        headers={
            "user-agent": "gpubnb-agent-self-update/1.0",
            "accept": "application/vnd.github+json",
        },
    )
    with urlopen(request, timeout=20) as response:  # noqa: S310 - fixed https GitHub host
        return response.read()


@dataclass(frozen=True)
class ReleaseInfo:
    tag: str
    commit: str
    portable_zip_url: str
    sha256sums_url: str


def fetch_release_info(
    repository: str = DEFAULT_REPOSITORY,
    channel: str = DEFAULT_CHANNEL,
    *,
    http_get: Callable[[str], bytes] = default_http_get,
) -> ReleaseInfo:
    raw = http_get(f"{GITHUB_API}/repos/{repository}/releases/tags/{channel}")
    data = json.loads(raw)
    assets = {asset["name"]: asset["browser_download_url"] for asset in data.get("assets", [])}
    if PORTABLE_ASSET_NAME not in assets:
        raise SelfUpdateError(f"release_missing_asset:{PORTABLE_ASSET_NAME}")
    if "SHA256SUMS.txt" not in assets:
        raise SelfUpdateError("release_missing_asset:SHA256SUMS.txt")
    commit = str(data.get("target_commitish") or "")
    if not commit:
        raise SelfUpdateError("release_missing_commit")
    return ReleaseInfo(
        tag=str(data.get("tag_name") or channel),
        commit=commit,
        portable_zip_url=assets[PORTABLE_ASSET_NAME],
        sha256sums_url=assets["SHA256SUMS.txt"],
    )


def is_update_available(release: ReleaseInfo, current_build_commit: str = BUILD_COMMIT) -> bool:
    if current_build_commit == "dev":
        # Never built by CI - there is no real commit to compare, so an
        # update always looks "available" rather than falsely "current".
        return True
    return not (
        release.commit.startswith(current_build_commit)
        or current_build_commit.startswith(release.commit)
    )


def download_and_verify_agent_exe(
    release: ReleaseInfo,
    *,
    http_get: Callable[[str], bytes] = default_http_get,
) -> bytes:
    sums_text = http_get(release.sha256sums_url).decode("utf-8", errors="replace")
    zip_line = next(
        (line for line in sums_text.splitlines() if line.strip().endswith(PORTABLE_ASSET_NAME)),
        None,
    )
    if not zip_line:
        raise SelfUpdateError("checksum_missing_for_portable_zip")
    expected_sha256 = zip_line.strip().split()[0].lower()
    zip_bytes = http_get(release.portable_zip_url)
    actual_sha256 = hashlib.sha256(zip_bytes).hexdigest()
    if actual_sha256 != expected_sha256:
        raise SelfUpdateError(
            f"checksum_mismatch:expected={expected_sha256}:actual={actual_sha256}"
        )
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
        try:
            exe_bytes = archive.read(AGENT_EXE_NAME_IN_ZIP)
        except KeyError as exc:
            raise SelfUpdateError("agent_exe_missing_in_portable_zip") from exc
    if len(exe_bytes) < 262144 or exe_bytes[:2] != b"MZ":
        raise SelfUpdateError("agent_exe_not_a_valid_pe")
    return exe_bytes


@dataclass(frozen=True)
class UpdateResult:
    updated: bool
    previous_commit: str
    new_commit: str | None
    release_tag: str | None
    backup_path: str | None
    detail: str


def perform_self_update(
    install_dir: Path,
    *,
    repository: str = DEFAULT_REPOSITORY,
    channel: str = DEFAULT_CHANNEL,
    current_build_commit: str = BUILD_COMMIT,
    dry_run: bool = False,
    http_get: Callable[[str], bytes] = default_http_get,
    stop_service: Callable[[], None],
    start_service: Callable[[], None],
    service_running: Callable[[], bool],
    now: Callable[[], float] = time.time,
    sleep: Callable[[float], None] = time.sleep,
) -> UpdateResult:
    release = fetch_release_info(repository, channel, http_get=http_get)
    if not is_update_available(release, current_build_commit):
        return UpdateResult(
            updated=False,
            previous_commit=current_build_commit,
            new_commit=None,
            release_tag=release.tag,
            backup_path=None,
            detail=f"already_current:{release.tag}",
        )

    exe_bytes = download_and_verify_agent_exe(release, http_get=http_get)
    if dry_run:
        return UpdateResult(
            updated=False,
            previous_commit=current_build_commit,
            new_commit=release.commit,
            release_tag=release.tag,
            backup_path=None,
            detail=f"update_available_dry_run:{release.tag}",
        )

    target = install_dir / "gpubnb-agent.exe"
    if not target.exists():
        raise SelfUpdateError(f"install_target_missing:{target}")
    backup = install_dir / f"gpubnb-agent.exe.bak-{int(now())}"
    staged = install_dir / "gpubnb-agent.exe.new"
    staged.write_bytes(exe_bytes)

    stop_service()
    deadline = now() + SERVICE_STOP_TIMEOUT_SECONDS
    while service_running() and now() < deadline:
        sleep(0.5)
    if service_running():
        staged.unlink(missing_ok=True)
        raise SelfUpdateError("service_did_not_stop_in_time")

    try:
        shutil.move(str(target), str(backup))
        shutil.move(str(staged), str(target))
    except OSError as exc:
        # Best-effort rollback before giving up: never leave the install
        # directory without a gpubnb-agent.exe at all.
        if backup.exists() and not target.exists():
            shutil.move(str(backup), str(target))
        raise SelfUpdateError(f"binary_replace_failed:{exc}") from exc

    try:
        start_service()
    except Exception as exc:
        target.unlink(missing_ok=True)
        shutil.move(str(backup), str(target))
        try:
            start_service()
        except Exception:
            pass
        raise SelfUpdateError(f"service_start_failed_after_update:{exc}") from exc

    deadline = now() + SERVICE_START_TIMEOUT_SECONDS
    while not service_running() and now() < deadline:
        sleep(0.5)
    if not service_running():
        raise SelfUpdateError("service_did_not_start_after_update")

    return UpdateResult(
        updated=True,
        previous_commit=current_build_commit,
        new_commit=release.commit,
        release_tag=release.tag,
        backup_path=str(backup),
        detail=f"updated_to:{release.tag}",
    )
