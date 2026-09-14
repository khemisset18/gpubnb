"""Self-update for the frozen Windows agent.

The updater is intentionally owner-triggered while public Windows artifacts are
not yet Authenticode-signed. It only follows the promoted release alias, verifies
the published SHA-256 and replaces the installed service binary transactionally.

The production/default path additionally binds the candidate and installed binary
to the release's immutable commit and performs a local runtime probe. Any failure
after replacement rolls back to the known-good backup before returning an error.
"""
from __future__ import annotations

import hashlib
import io
import json
import re
import shutil
import subprocess
import tempfile
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.request import Request, urlopen

from . import __version__ as AGENT_VERSION
from ._build_info import BUILD_COMMIT
from .update_recovery import PostUpdateChecks, rollback_reason
from .update_validation import (
    UpdateIdentityError,
    identity_matches_release,
    normalize_release_commit,
    parse_build_identity,
    require_identity_matches_release,
)

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
    try:
        commit = normalize_release_commit(str(data.get("target_commitish") or ""))
    except UpdateIdentityError as exc:
        raise SelfUpdateError(str(exc)) from exc
    return ReleaseInfo(
        tag=str(data.get("tag_name") or channel),
        commit=commit,
        portable_zip_url=assets[PORTABLE_ASSET_NAME],
        sha256sums_url=assets["SHA256SUMS.txt"],
    )


def is_update_available(release: ReleaseInfo, current_build_commit: str = BUILD_COMMIT) -> bool:
    if current_build_commit == "dev":
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
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha256):
        raise SelfUpdateError("checksum_manifest_invalid")
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


def _parse_semver(value: str) -> tuple[int, int, int] | None:
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?", value.strip())
    if not match:
        return None
    return (int(match.group(1)), int(match.group(2)), int(match.group(3)))


def _run_agent_command(exe_path: Path, command: str, *, timeout: int = 15) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(  # noqa: S603 - fixed argv, candidate is checksum-verified
        [str(exe_path), command],
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    if result.returncode != 0:
        raise SelfUpdateError(
            f"candidate_command_failed:{command}:exit={result.returncode}:stderr={result.stderr.strip()[:200]}"
        )
    return result


def default_run_version_command(exe_path: Path) -> str:
    value = _run_agent_command(exe_path, "version").stdout.strip()
    if not value:
        raise SelfUpdateError("candidate_version_empty")
    return value


def default_run_build_info_command(exe_path: Path) -> dict[str, Any]:
    raw = _run_agent_command(exe_path, "build-info").stdout.strip()
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SelfUpdateError("candidate_build_info_invalid_json") from exc
    if not isinstance(value, dict):
        raise SelfUpdateError("candidate_build_info_invalid_shape")
    return value


def default_run_runtime_check(exe_path: Path) -> bool:
    try:
        raw = _run_agent_command(exe_path, "runtime-check").stdout.strip()
        value = json.loads(raw)
    except (SelfUpdateError, json.JSONDecodeError):
        return False
    return bool(
        isinstance(value, dict)
        and value.get("idnaCodec") is True
        and value.get("dnsResolution") is True
        and value.get("tlsContext") is True
    )


def candidate_agent_version(
    exe_bytes: bytes,
    *,
    run_version_command: Callable[[Path], str] = default_run_version_command,
) -> str:
    """Read a checksum-verified candidate's version from a throwaway path."""
    with tempfile.TemporaryDirectory(prefix="gpubnb-self-update-") as tmp:
        candidate_path = Path(tmp) / "gpubnb-agent-candidate.exe"
        candidate_path.write_bytes(exe_bytes)
        return run_version_command(candidate_path)


def _is_downgrade(current_version: str, candidate_version: str) -> bool:
    current = _parse_semver(current_version)
    candidate = _parse_semver(candidate_version)
    if current is None or candidate is None:
        # Compatibility for low-level injected tests. The production/default
        # path below fails closed when either value is not valid semver.
        return False
    return candidate < current


@dataclass(frozen=True)
class UpdateResult:
    updated: bool
    previous_commit: str
    new_commit: str | None
    release_tag: str | None
    backup_path: str | None
    detail: str


CandidateValidator = Callable[[bytes, ReleaseInfo, str], None]
PostUpdateValidator = Callable[[Path, ReleaseInfo, str], None]


def _wait_for(
    predicate: Callable[[], bool],
    timeout_seconds: int,
    *,
    now: Callable[[], float],
    sleep: Callable[[float], None],
) -> bool:
    deadline = now() + timeout_seconds
    while not predicate() and now() < deadline:
        sleep(0.5)
    return predicate()


def _rollback_to_backup(
    target: Path,
    backup: Path,
    *,
    stop_service: Callable[[], None],
    start_service: Callable[[], None],
    service_running: Callable[[], bool],
    is_stopped: Callable[[], bool],
    now: Callable[[], float],
    sleep: Callable[[float], None],
) -> str | None:
    errors: list[str] = []
    try:
        if not is_stopped():
            stop_service()
        if not _wait_for(is_stopped, SERVICE_STOP_TIMEOUT_SECONDS, now=now, sleep=sleep):
            return "rollback_service_did_not_stop"
    except Exception as exc:
        return f"rollback_service_stop_failed:{exc}"

    try:
        if not backup.exists():
            return "rollback_backup_missing"
        target.unlink(missing_ok=True)
        shutil.move(str(backup), str(target))
    except OSError as exc:
        return f"rollback_binary_restore_failed:{exc}"

    try:
        start_service()
    except Exception as exc:
        errors.append(f"rollback_service_start_failed:{exc}")
    if not _wait_for(service_running, SERVICE_START_TIMEOUT_SECONDS, now=now, sleep=sleep):
        errors.append("rollback_service_did_not_start")
    return ";".join(errors) or None


def _strict_validators(
    *,
    current_agent_version: str,
    service_running: Callable[[], bool],
    run_version_command: Callable[[Path], str],
    run_build_info_command: Callable[[Path], dict[str, Any]],
    run_runtime_check: Callable[[Path], bool],
) -> tuple[CandidateValidator, PostUpdateValidator]:
    if _parse_semver(current_agent_version) is None:
        raise SelfUpdateError("current_agent_version_invalid")

    def validate_candidate(exe_bytes: bytes, release: ReleaseInfo, candidate_version: str) -> None:
        if _parse_semver(candidate_version) is None:
            raise SelfUpdateError("candidate_version_invalid")
        with tempfile.TemporaryDirectory(prefix="gpubnb-self-update-identity-") as tmp:
            candidate_path = Path(tmp) / "gpubnb-agent-candidate.exe"
            candidate_path.write_bytes(exe_bytes)
            build_info = run_build_info_command(candidate_path)
        try:
            identity = parse_build_identity(candidate_version, build_info)
            require_identity_matches_release(identity, release.commit, stage="candidate")
        except UpdateIdentityError as exc:
            raise SelfUpdateError(str(exc)) from exc

    def validate_installed(target: Path, release: ReleaseInfo, candidate_version: str) -> None:
        installed_version = run_version_command(target)
        installed_info = run_build_info_command(target)
        try:
            identity = parse_build_identity(installed_version, installed_info)
        except UpdateIdentityError as exc:
            raise SelfUpdateError(f"installed_identity_invalid:{exc}") from exc
        checks = PostUpdateChecks(
            service_running=service_running(),
            identity_matches_release=identity_matches_release(identity, release.commit),
            version_matches_candidate=installed_version == candidate_version,
            runtime_healthy=bool(run_runtime_check(target)),
        )
        reason = rollback_reason(checks)
        if reason is not None:
            raise SelfUpdateError(reason)

    return validate_candidate, validate_installed


def perform_self_update(
    install_dir: Path,
    *,
    repository: str = DEFAULT_REPOSITORY,
    channel: str = DEFAULT_CHANNEL,
    current_build_commit: str = BUILD_COMMIT,
    current_agent_version: str = AGENT_VERSION,
    dry_run: bool = False,
    http_get: Callable[[str], bytes] = default_http_get,
    run_version_command: Callable[[Path], str] = default_run_version_command,
    candidate_validator: CandidateValidator | None = None,
    post_update_validator: PostUpdateValidator | None = None,
    stop_service: Callable[[], None],
    start_service: Callable[[], None],
    service_running: Callable[[], bool],
    service_stopped: Callable[[], bool] | None = None,
    now: Callable[[], float] = time.time,
    sleep: Callable[[float], None] = time.sleep,
) -> UpdateResult:
    # A Windows service can be STOP_PENDING while service_running()==False.
    # Never swap the executable until the SCM reports fully STOPPED.
    is_stopped = service_stopped or (lambda: not service_running())

    # The installed CLI calls this function with the default runner. In that
    # production path, strict candidate + post-install validation is mandatory.
    # Tests with deliberately fake PE fixtures may inject a runner and explicit
    # validators to exercise the low-level transaction mechanics independently.
    if (
        candidate_validator is None
        and post_update_validator is None
        and run_version_command is default_run_version_command
    ):
        candidate_validator, post_update_validator = _strict_validators(
            current_agent_version=current_agent_version,
            service_running=service_running,
            run_version_command=run_version_command,
            run_build_info_command=default_run_build_info_command,
            run_runtime_check=default_run_runtime_check,
        )

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
    candidate_version = candidate_agent_version(exe_bytes, run_version_command=run_version_command)
    if _is_downgrade(current_agent_version, candidate_version):
        raise SelfUpdateError(
            f"downgrade_refused:current={current_agent_version}:candidate={candidate_version}"
        )
    if candidate_validator is not None:
        candidate_validator(exe_bytes, release, candidate_version)
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
    if not _wait_for(is_stopped, SERVICE_STOP_TIMEOUT_SECONDS, now=now, sleep=sleep):
        staged.unlink(missing_ok=True)
        raise SelfUpdateError("service_did_not_stop_in_time")

    try:
        shutil.move(str(target), str(backup))
        shutil.move(str(staged), str(target))
    except OSError as exc:
        if backup.exists() and not target.exists():
            shutil.move(str(backup), str(target))
        staged.unlink(missing_ok=True)
        raise SelfUpdateError(f"binary_replace_failed:{exc}") from exc

    try:
        start_service()
    except Exception as exc:
        rollback_error = _rollback_to_backup(
            target,
            backup,
            stop_service=stop_service,
            start_service=start_service,
            service_running=service_running,
            is_stopped=is_stopped,
            now=now,
            sleep=sleep,
        )
        suffix = f":rollback={rollback_error}" if rollback_error else ":rollback=ok"
        raise SelfUpdateError(f"service_start_failed_after_update:{exc}{suffix}") from exc

    if not _wait_for(service_running, SERVICE_START_TIMEOUT_SECONDS, now=now, sleep=sleep):
        rollback_error = _rollback_to_backup(
            target,
            backup,
            stop_service=stop_service,
            start_service=start_service,
            service_running=service_running,
            is_stopped=is_stopped,
            now=now,
            sleep=sleep,
        )
        suffix = f":rollback={rollback_error}" if rollback_error else ":rollback=ok"
        raise SelfUpdateError(f"service_did_not_start_after_update{suffix}")

    if post_update_validator is not None:
        try:
            post_update_validator(target, release, candidate_version)
        except Exception as exc:
            rollback_error = _rollback_to_backup(
                target,
                backup,
                stop_service=stop_service,
                start_service=start_service,
                service_running=service_running,
                is_stopped=is_stopped,
                now=now,
                sleep=sleep,
            )
            suffix = f":rollback={rollback_error}" if rollback_error else ":rollback=ok"
            raise SelfUpdateError(f"post_update_validation_failed:{exc}{suffix}") from exc

    return UpdateResult(
        updated=True,
        previous_commit=current_build_commit,
        new_commit=release.commit,
        release_tag=release.tag,
        backup_path=str(backup),
        detail=f"updated_to:{release.tag}",
    )


def perform_verified_self_update(
    install_dir: Path,
    *,
    repository: str = DEFAULT_REPOSITORY,
    channel: str = DEFAULT_CHANNEL,
    current_build_commit: str = BUILD_COMMIT,
    current_agent_version: str = AGENT_VERSION,
    dry_run: bool = False,
    http_get: Callable[[str], bytes] = default_http_get,
    run_version_command: Callable[[Path], str] = default_run_version_command,
    run_build_info_command: Callable[[Path], dict[str, Any]] = default_run_build_info_command,
    run_runtime_check: Callable[[Path], bool] = default_run_runtime_check,
    stop_service: Callable[[], None],
    start_service: Callable[[], None],
    service_running: Callable[[], bool],
    service_stopped: Callable[[], bool] | None = None,
    now: Callable[[], float] = time.time,
    sleep: Callable[[float], None] = time.sleep,
) -> UpdateResult:
    """Explicit strict update API for tests/other trusted callers."""
    candidate_validator, post_update_validator = _strict_validators(
        current_agent_version=current_agent_version,
        service_running=service_running,
        run_version_command=run_version_command,
        run_build_info_command=run_build_info_command,
        run_runtime_check=run_runtime_check,
    )
    return perform_self_update(
        install_dir,
        repository=repository,
        channel=channel,
        current_build_commit=current_build_commit,
        current_agent_version=current_agent_version,
        dry_run=dry_run,
        http_get=http_get,
        run_version_command=run_version_command,
        candidate_validator=candidate_validator,
        post_update_validator=post_update_validator,
        stop_service=stop_service,
        start_service=start_service,
        service_running=service_running,
        service_stopped=service_stopped,
        now=now,
        sleep=sleep,
    )
