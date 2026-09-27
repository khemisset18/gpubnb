"""Ephemeral lolMiner credential configuration.

This is the only mining-runtime module allowed to resolve a local secret
reference. It returns only a private configuration path to the GPU supervisor;
the plaintext is never returned to control-channel or supervisor code.
"""
from __future__ import annotations

import hashlib
import os
import re
import stat
import subprocess
import tempfile
import threading
from pathlib import Path

from .mining_secret_broker import MiningSecretError, resolve_secret
from .storage import config_dir, require_private_directory

SAFE_LOLMINER_PASSWORD = re.compile(
    r"^[A-Za-z0-9._~!$&()*+,/:@%?=\-]{1,256}$"
)
MAX_GENERATION = 9_223_372_036_854_775_807
_RESOURCE_LOCKS_GUARD = threading.Lock()
_RESOURCE_LOCKS: dict[str, threading.RLock] = {}

_WINDOWS_BROAD_ALLOW_SIDS = (
    "S-1-5-32-544",  # BUILTIN\\Administrators
    "S-1-5-32-545",  # BUILTIN\\Users
    "S-1-5-11",      # Authenticated Users
    "S-1-1-0",       # Everyone
    "S-1-3-0",       # CREATOR OWNER
)


class MiningSecretRuntimeError(RuntimeError):
    pass


def _resource_lock(resource_id: str) -> threading.RLock:
    # The Agent is a single process, but mining START, reconciliation, watchdog,
    # and rental preemption can execute on different threads. Serialize all
    # credential-file mutations for one resource so an older cleanup cannot race
    # a newer generation's atomic publish.
    key = _resource_prefix(resource_id)
    with _RESOURCE_LOCKS_GUARD:
        lock = _RESOURCE_LOCKS.get(key)
        if lock is None:
            lock = threading.RLock()
            _RESOURCE_LOCKS[key] = lock
        return lock


def _resource_prefix(resource_id: str) -> str:
    return hashlib.sha256(resource_id.encode("utf-8")).hexdigest()[:24]


def _runtime_secret_root() -> Path:
    return config_dir() / "mining-runtime-secrets"


def _is_link_or_reparse_point(path: Path) -> bool:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return False
    except OSError:
        raise MiningSecretRuntimeError("miner_secret_config_security_unavailable") from None
    if path.is_symlink():
        return True
    attributes = getattr(metadata, "st_file_attributes", 0)
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(attributes & reparse_flag)


def _remove_windows_broad_allow_aces(path: Path) -> None:
    if os.name != "nt":
        return
    try:
        result = subprocess.run(
            [
                "icacls",
                str(path),
                "/remove:g",
                *(f"*{sid}" for sid in _WINDOWS_BROAD_ALLOW_SIDS),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            shell=False,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000),
        )
    except OSError:
        raise OSError("runtime_credential_acl_hardening_failed") from None
    if result.returncode != 0:
        raise OSError("runtime_credential_acl_hardening_failed")


def _validated_runtime_secret_root(*, create: bool) -> Path | None:
    base_entry = config_dir()
    root = base_entry / "mining-runtime-secrets"
    # Neither the Agent config root nor the credential directory may be redirected.
    # This check happens before chmod/ACL operations because chmod follows POSIX
    # symlinks and Windows junctions/reparse points can redirect secret writes.
    if _is_link_or_reparse_point(base_entry):
        raise MiningSecretRuntimeError("miner_secret_config_path_unsafe")
    if _is_link_or_reparse_point(root):
        raise MiningSecretRuntimeError("miner_secret_config_path_unsafe")
    if not os.path.lexists(root):
        if not create:
            return None
        try:
            require_private_directory(root)
        except RuntimeError:
            raise MiningSecretRuntimeError("miner_secret_config_security_unavailable") from None
    else:
        try:
            require_private_directory(root)
        except RuntimeError:
            raise MiningSecretRuntimeError("miner_secret_config_security_unavailable") from None
    if _is_link_or_reparse_point(root):
        raise MiningSecretRuntimeError("miner_secret_config_path_unsafe")
    try:
        _remove_windows_broad_allow_aces(root)
    except OSError:
        raise MiningSecretRuntimeError("miner_secret_config_security_unavailable") from None
    try:
        base = base_entry.resolve(strict=True)
        resolved = root.resolve(strict=True)
    except OSError:
        raise MiningSecretRuntimeError("miner_secret_config_security_unavailable") from None
    if resolved.parent != base:
        raise MiningSecretRuntimeError("miner_secret_config_path_unsafe")
    return root


def runtime_secret_config_path(resource_id: str, runtime_generation: int) -> Path:
    if (
        isinstance(runtime_generation, bool)
        or not isinstance(runtime_generation, int)
        or not 1 <= runtime_generation <= MAX_GENERATION
    ):
        raise MiningSecretRuntimeError("mining_runtime_generation_invalid")
    return _runtime_secret_root() / f"{_resource_prefix(resource_id)}-{runtime_generation}.cfg"


def _render_lolminer_secret_config(secret: str) -> str:
    if not isinstance(secret, str) or SAFE_LOLMINER_PASSWORD.fullmatch(secret) is None:
        raise MiningSecretRuntimeError("miner_secret_value_unsupported")
    return f"pass={secret}\n"


def _private_atomic_write(path: Path, content: str) -> None:
    root = _validated_runtime_secret_root(create=True)
    if root is None or path.parent != root:
        raise MiningSecretRuntimeError("miner_secret_config_path_unsafe")

    fd, temporary = tempfile.mkstemp(
        prefix=".pool-credential-",
        suffix=".cfg",
        dir=path.parent,
        text=True,
    )
    published = False
    try:
        if os.name != "nt":
            os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        published = True
        if os.name != "nt":
            path.chmod(0o600)
        else:
            _remove_windows_broad_allow_aces(path)
    except OSError:
        if published:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
        raise MiningSecretRuntimeError("miner_secret_config_write_failed") from None
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        except OSError:
            pass


def cleanup_lolminer_secret_configs(
    resource_id: str,
    *,
    keep_generation: int | None = None,
) -> None:
    with _resource_lock(resource_id):
        root = _validated_runtime_secret_root(create=False)
        if root is None:
            return
        keep = (
            runtime_secret_config_path(resource_id, keep_generation)
            if keep_generation is not None
            else None
        )
        prefix = f"{_resource_prefix(resource_id)}-"
        try:
            for candidate in root.glob(f"{prefix}*.cfg"):
                if keep is not None and candidate == keep:
                    continue
                candidate.unlink(missing_ok=True)
        except OSError:
            raise MiningSecretRuntimeError("miner_secret_config_cleanup_failed") from None


def prepare_lolminer_secret_config(
    reference: str,
    resource_id: str,
    runtime_generation: int,
) -> Path:
    with _resource_lock(resource_id):
        path = runtime_secret_config_path(resource_id, runtime_generation)
        cleanup_lolminer_secret_configs(resource_id)
        try:
            secret = resolve_secret(reference)
        except MiningSecretError as exc:
            raise MiningSecretRuntimeError(str(exc)) from None
        content = _render_lolminer_secret_config(secret)
        try:
            _private_atomic_write(path, content)
        except MiningSecretRuntimeError as exc:
            if str(exc) != "miner_secret_config_write_failed":
                raise
            # Atomic publish can fail after os.replace (for example while
            # tightening final POSIX permissions). _private_atomic_write makes
            # one best-effort removal; perform a second resource-scoped cleanup
            # before returning failure so a transient unlink error cannot leave
            # plaintext behind. If cleanup itself is unavailable, surface that
            # stronger fail-closed condition so the START is quarantinable.
            try:
                cleanup_lolminer_secret_configs(resource_id)
            except MiningSecretRuntimeError:
                raise MiningSecretRuntimeError(
                    "miner_secret_config_cleanup_failed"
                ) from None
            raise
        return path
