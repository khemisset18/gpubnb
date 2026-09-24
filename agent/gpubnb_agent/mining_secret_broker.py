"""OS-backed local mining pool secret broker.

Windows uses machine-scope DPAPI so both the interactive Host owner and the
always-running SYSTEM Agent can access the same encrypted blob. Access to the
blob itself is restricted to the current owner and SYSTEM by storage.py.

No operation in this module logs or returns the plaintext secret except
resolve_secret(), which is deliberately an internal runtime primitive.
"""
from __future__ import annotations

import hashlib
import os
import platform
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .storage import config_dir, require_private_directory

LOCAL_SECRET_REF = re.compile(r"^secret://local/mining/[A-Za-z0-9][A-Za-z0-9._-]{2,95}$")
MAX_SECRET_BYTES = 1024
DPAPI_LOCAL_MACHINE = 0x4
DPAPI_ENTROPY = b"GPUbnb/mining-pool-secret/v1"


class MiningSecretError(RuntimeError):
    pass


@dataclass(frozen=True)
class MiningSecretStatus:
    reference: str
    backend: str
    present: bool


def _validate_reference(reference: str) -> str:
    if not isinstance(reference, str) or LOCAL_SECRET_REF.fullmatch(reference) is None:
        raise MiningSecretError("mining_secret_reference_invalid")
    return reference


def _secret_root() -> Path:
    return config_dir() / "secrets" / "mining"


def _secret_path(reference: str) -> Path:
    digest = hashlib.sha256(reference.encode("utf-8")).hexdigest()
    return _secret_root() / f"{digest}.dpapi"


def _validate_secret(secret: str) -> bytes:
    if not isinstance(secret, str):
        raise MiningSecretError("mining_secret_invalid")
    encoded = secret.encode("utf-8")
    if (
        not encoded
        or len(encoded) > MAX_SECRET_BYTES
        or any(byte in {0, 10, 13} for byte in encoded)
    ):
        raise MiningSecretError("mining_secret_invalid")
    return encoded


def _windows_dpapi() -> Any:
    try:
        import win32crypt  # type: ignore
    except ImportError as exc:
        raise MiningSecretError("mining_secret_backend_unavailable") from exc
    return win32crypt


def backend_name() -> str:
    if platform.system() == "Windows":
        return "windows-dpapi-machine"
    return "unsupported"


def _require_supported_backend() -> None:
    if platform.system() != "Windows":
        raise MiningSecretError("mining_secret_backend_unsupported")


def _protect(plaintext: bytes) -> bytes:
    _require_supported_backend()
    win32crypt = _windows_dpapi()
    try:
        _description, encrypted = win32crypt.CryptProtectData(
            plaintext,
            "GPUbnb mining pool secret",
            DPAPI_ENTROPY,
            None,
            None,
            DPAPI_LOCAL_MACHINE,
        )
    except Exception as exc:
        raise MiningSecretError("mining_secret_encrypt_failed") from exc
    if not isinstance(encrypted, bytes) or not encrypted:
        raise MiningSecretError("mining_secret_encrypt_failed")
    return encrypted


def _unprotect(ciphertext: bytes) -> bytes:
    _require_supported_backend()
    win32crypt = _windows_dpapi()
    try:
        _description, plaintext = win32crypt.CryptUnprotectData(
            ciphertext,
            DPAPI_ENTROPY,
            None,
            None,
            0,
        )
    except Exception as exc:
        raise MiningSecretError("mining_secret_decrypt_failed") from exc
    if not isinstance(plaintext, bytes) or not plaintext:
        raise MiningSecretError("mining_secret_decrypt_failed")
    return plaintext


def _atomic_write_ciphertext(path: Path, ciphertext: bytes) -> None:
    try:
        require_private_directory(path.parent)
    except RuntimeError as exc:
        raise MiningSecretError("mining_secret_storage_acl_failed") from exc
    fd, temporary = tempfile.mkstemp(prefix=".pool-secret-", dir=path.parent)
    try:
        if os.name != "nt":
            os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(ciphertext)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        if os.name != "nt":
            path.chmod(0o600)
    except OSError as exc:
        raise MiningSecretError("mining_secret_storage_write_failed") from exc
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def store_secret(reference: str, secret: str) -> MiningSecretStatus:
    reference = _validate_reference(reference)
    plaintext = _validate_secret(secret)
    ciphertext = _protect(plaintext)
    _atomic_write_ciphertext(_secret_path(reference), ciphertext)
    return MiningSecretStatus(reference, backend_name(), True)


def secret_status(reference: str) -> MiningSecretStatus:
    reference = _validate_reference(reference)
    _require_supported_backend()
    return MiningSecretStatus(reference, backend_name(), _secret_path(reference).is_file())


def resolve_secret(reference: str) -> str:
    """Resolve plaintext for a local trusted runtime only.

    Callers must never put the returned value in logs, control-channel payloads,
    process command lines or environment inherited by renter workloads.
    """
    reference = _validate_reference(reference)
    _require_supported_backend()
    path = _secret_path(reference)
    try:
        ciphertext = path.read_bytes()
    except FileNotFoundError as exc:
        raise MiningSecretError("mining_secret_not_found") from exc
    except OSError as exc:
        raise MiningSecretError("mining_secret_storage_read_failed") from exc
    plaintext = _unprotect(ciphertext)
    try:
        secret = plaintext.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise MiningSecretError("mining_secret_decrypt_failed") from exc
    _validate_secret(secret)
    return secret


def delete_secret(reference: str) -> MiningSecretStatus:
    reference = _validate_reference(reference)
    _require_supported_backend()
    path = _secret_path(reference)
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    except OSError as exc:
        raise MiningSecretError("mining_secret_delete_failed") from exc
    return MiningSecretStatus(reference, backend_name(), False)
