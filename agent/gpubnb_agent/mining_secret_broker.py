"""OS-backed local mining pool secret broker.

Backends are local-only:
- Windows: machine-scope DPAPI ciphertext under owner/SYSTEM ACLs.
- macOS: the current user's default Keychain via Security.framework.
- Linux: Secret Service via secret-tool, with plaintext supplied only on stdin.

The raw secret never appears in argv, logs, control-plane payloads or the
MiningConfiguration database. resolve_secret() remains an internal primitive;
the miner runtime deliberately does not import this module yet.
"""
from __future__ import annotations

import ctypes
import ctypes.util
import hashlib
import os
import platform
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .storage import config_dir, require_private_directory

LOCAL_SECRET_REF = re.compile(r"^secret://local/mining/[A-Za-z0-9][A-Za-z0-9._-]{2,95}$")
MAX_SECRET_BYTES = 1024
DPAPI_LOCAL_MACHINE = 0x4
DPAPI_ENTROPY = b"GPUbnb/mining-pool-secret/v1"
MACOS_SERVICE = b"com.gpubnb.mining.pool-secret.v1"
LINUX_SERVICE = "gpubnb-mining-pool-secret-v1"
SECRET_TOOL_TIMEOUT_SECONDS = 10

ERR_SEC_SUCCESS = 0
ERR_SEC_DUPLICATE_ITEM = -25299
ERR_SEC_ITEM_NOT_FOUND = -25300


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


def _reference_digest(reference: str) -> str:
    return hashlib.sha256(reference.encode("utf-8")).hexdigest()


def _secret_root() -> Path:
    return config_dir() / "secrets" / "mining"


def _secret_path(reference: str) -> Path:
    return _secret_root() / f"{_reference_digest(reference)}.dpapi"


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


def _decode_secret(plaintext: bytes) -> str:
    try:
        secret = plaintext.decode("utf-8")
    except UnicodeDecodeError:
        raise MiningSecretError("mining_secret_decrypt_failed") from None
    _validate_secret(secret)
    return secret


def _windows_dpapi() -> Any:
    try:
        import win32crypt  # type: ignore
    except ImportError:
        raise MiningSecretError("mining_secret_backend_unavailable") from None
    return win32crypt


def backend_name() -> str:
    system = platform.system()
    if system == "Windows":
        return "windows-dpapi-machine"
    if system == "Darwin":
        return "macos-keychain-user"
    if system == "Linux":
        return "linux-secret-service-user"
    return "unsupported"


def _protect_windows(plaintext: bytes) -> bytes:
    win32crypt = _windows_dpapi()
    failed = False
    encrypted: Any = None
    try:
        encrypted = win32crypt.CryptProtectData(
            plaintext,
            "GPUbnb mining pool secret",
            DPAPI_ENTROPY,
            None,
            None,
            DPAPI_LOCAL_MACHINE,
        )
    except Exception:
        failed = True
    if failed or not isinstance(encrypted, bytes) or not encrypted:
        raise MiningSecretError("mining_secret_encrypt_failed")
    return encrypted


def _unprotect_windows(ciphertext: bytes) -> bytes:
    win32crypt = _windows_dpapi()
    failed = False
    plaintext: Any = None
    try:
        _description, plaintext = win32crypt.CryptUnprotectData(
            ciphertext,
            DPAPI_ENTROPY,
            None,
            None,
            0,
        )
    except Exception:
        failed = True
    if failed or not isinstance(plaintext, bytes) or not plaintext:
        raise MiningSecretError("mining_secret_decrypt_failed")
    return plaintext


def _atomic_write_ciphertext(path: Path, ciphertext: bytes) -> None:
    try:
        require_private_directory(path.parent)
    except RuntimeError:
        raise MiningSecretError("mining_secret_storage_acl_failed") from None
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
    except OSError:
        raise MiningSecretError("mining_secret_storage_write_failed") from None
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def _windows_store(reference: str, plaintext: bytes) -> None:
    _atomic_write_ciphertext(_secret_path(reference), _protect_windows(plaintext))


def _windows_status(reference: str) -> bool:
    _windows_dpapi()
    return _secret_path(reference).is_file()


def _windows_resolve(reference: str) -> bytes:
    path = _secret_path(reference)
    try:
        ciphertext = path.read_bytes()
    except FileNotFoundError:
        raise MiningSecretError("mining_secret_not_found") from None
    except OSError:
        raise MiningSecretError("mining_secret_storage_read_failed") from None
    return _unprotect_windows(ciphertext)


def _windows_delete(reference: str) -> None:
    _windows_dpapi()
    try:
        _secret_path(reference).unlink()
    except FileNotFoundError:
        pass
    except OSError:
        raise MiningSecretError("mining_secret_delete_failed") from None


class _MacKeychainBackend:
    def __init__(self) -> None:
        security_path = ctypes.util.find_library("Security")
        core_foundation_path = ctypes.util.find_library("CoreFoundation")
        if not security_path or not core_foundation_path:
            raise MiningSecretError("mining_secret_backend_unavailable")
        try:
            self.security = ctypes.CDLL(security_path)
            self.core_foundation = ctypes.CDLL(core_foundation_path)
        except OSError:
            raise MiningSecretError("mining_secret_backend_unavailable") from None
        self._configure()

    def _configure(self) -> None:
        self.security.SecKeychainFindGenericPassword.argtypes = [
            ctypes.c_void_p,
            ctypes.c_uint32,
            ctypes.c_char_p,
            ctypes.c_uint32,
            ctypes.c_char_p,
            ctypes.POINTER(ctypes.c_uint32),
            ctypes.POINTER(ctypes.c_void_p),
            ctypes.POINTER(ctypes.c_void_p),
        ]
        self.security.SecKeychainFindGenericPassword.restype = ctypes.c_int32
        self.security.SecKeychainAddGenericPassword.argtypes = [
            ctypes.c_void_p,
            ctypes.c_uint32,
            ctypes.c_char_p,
            ctypes.c_uint32,
            ctypes.c_char_p,
            ctypes.c_uint32,
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_void_p),
        ]
        self.security.SecKeychainAddGenericPassword.restype = ctypes.c_int32
        self.security.SecKeychainItemModifyAttributesAndData.argtypes = [
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_uint32,
            ctypes.c_void_p,
        ]
        self.security.SecKeychainItemModifyAttributesAndData.restype = ctypes.c_int32
        self.security.SecKeychainItemDelete.argtypes = [ctypes.c_void_p]
        self.security.SecKeychainItemDelete.restype = ctypes.c_int32
        self.security.SecKeychainItemFreeContent.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        self.security.SecKeychainItemFreeContent.restype = ctypes.c_int32
        self.core_foundation.CFRelease.argtypes = [ctypes.c_void_p]
        self.core_foundation.CFRelease.restype = None

    @staticmethod
    def _account(reference: str) -> bytes:
        return _reference_digest(reference).encode("ascii")

    def _find_item(self, reference: str) -> ctypes.c_void_p | None:
        account = self._account(reference)
        item = ctypes.c_void_p()
        status = self.security.SecKeychainFindGenericPassword(
            None,
            len(MACOS_SERVICE),
            MACOS_SERVICE,
            len(account),
            account,
            None,
            None,
            ctypes.byref(item),
        )
        if status == ERR_SEC_ITEM_NOT_FOUND:
            return None
        if status != ERR_SEC_SUCCESS or not item.value:
            raise MiningSecretError("mining_secret_backend_unavailable")
        return item

    def store(self, reference: str, plaintext: bytes) -> None:
        account = self._account(reference)
        item = self._find_item(reference)
        buffer = ctypes.create_string_buffer(plaintext, len(plaintext))
        pointer = ctypes.cast(buffer, ctypes.c_void_p)
        if item is not None:
            try:
                status = self.security.SecKeychainItemModifyAttributesAndData(
                    item,
                    None,
                    len(plaintext),
                    pointer,
                )
            finally:
                self.core_foundation.CFRelease(item)
            if status != ERR_SEC_SUCCESS:
                raise MiningSecretError("mining_secret_store_failed")
            return

        status = self.security.SecKeychainAddGenericPassword(
            None,
            len(MACOS_SERVICE),
            MACOS_SERVICE,
            len(account),
            account,
            len(plaintext),
            pointer,
            None,
        )
        if status == ERR_SEC_DUPLICATE_ITEM:
            # A concurrent writer won the create race; retry as an update.
            item = self._find_item(reference)
            if item is None:
                raise MiningSecretError("mining_secret_store_failed")
            try:
                status = self.security.SecKeychainItemModifyAttributesAndData(
                    item,
                    None,
                    len(plaintext),
                    pointer,
                )
            finally:
                self.core_foundation.CFRelease(item)
        if status != ERR_SEC_SUCCESS:
            raise MiningSecretError("mining_secret_store_failed")

    def status(self, reference: str) -> bool:
        item = self._find_item(reference)
        if item is None:
            return False
        self.core_foundation.CFRelease(item)
        return True

    def resolve(self, reference: str) -> bytes:
        account = self._account(reference)
        length = ctypes.c_uint32()
        data = ctypes.c_void_p()
        status = self.security.SecKeychainFindGenericPassword(
            None,
            len(MACOS_SERVICE),
            MACOS_SERVICE,
            len(account),
            account,
            ctypes.byref(length),
            ctypes.byref(data),
            None,
        )
        if status == ERR_SEC_ITEM_NOT_FOUND:
            raise MiningSecretError("mining_secret_not_found")
        if status != ERR_SEC_SUCCESS or not data.value or length.value == 0:
            raise MiningSecretError("mining_secret_backend_unavailable")
        try:
            return ctypes.string_at(data, length.value)
        finally:
            self.security.SecKeychainItemFreeContent(None, data)

    def delete(self, reference: str) -> None:
        item = self._find_item(reference)
        if item is None:
            return
        try:
            status = self.security.SecKeychainItemDelete(item)
        finally:
            self.core_foundation.CFRelease(item)
        if status not in {ERR_SEC_SUCCESS, ERR_SEC_ITEM_NOT_FOUND}:
            raise MiningSecretError("mining_secret_delete_failed")


def _macos_backend() -> _MacKeychainBackend:
    return _MacKeychainBackend()


def _linux_secret_tool() -> str:
    candidate = shutil.which("secret-tool")
    if not candidate:
        raise MiningSecretError("mining_secret_backend_unavailable")
    try:
        resolved = Path(candidate).resolve(strict=True)
    except OSError:
        raise MiningSecretError("mining_secret_backend_unavailable") from None
    if not resolved.is_file():
        raise MiningSecretError("mining_secret_backend_unavailable")
    return str(resolved)


def _linux_args(reference: str) -> list[str]:
    return [
        "service",
        LINUX_SERVICE,
        "account",
        _reference_digest(reference),
    ]


def _run_secret_tool(
    action: str,
    reference: str,
    *,
    plaintext: bytes | None = None,
) -> subprocess.CompletedProcess[bytes]:
    executable = _linux_secret_tool()
    args = [executable, action]
    if action == "store":
        args.append("--label=GPUbnb mining pool secret")
    args.extend(_linux_args(reference))
    failed = False
    result: subprocess.CompletedProcess[bytes] | None = None
    try:
        result = subprocess.run(
            args,
            input=plaintext,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=SECRET_TOOL_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        failed = True
    if failed or result is None:
        raise MiningSecretError("mining_secret_backend_unavailable")
    return result


def _linux_store(reference: str, plaintext: bytes) -> None:
    result = _run_secret_tool("store", reference, plaintext=plaintext)
    if result.returncode != 0:
        raise MiningSecretError("mining_secret_store_failed")


def _linux_lookup(reference: str) -> bytes | None:
    result = _run_secret_tool("lookup", reference)
    if result.returncode == 0:
        return result.stdout if result.stdout else None
    if not result.stderr:
        return None
    raise MiningSecretError("mining_secret_backend_unavailable")


def _linux_status(reference: str) -> bool:
    return _linux_lookup(reference) is not None


def _linux_resolve(reference: str) -> bytes:
    plaintext = _linux_lookup(reference)
    if plaintext is None:
        raise MiningSecretError("mining_secret_not_found")
    return plaintext


def _linux_delete(reference: str) -> None:
    result = _run_secret_tool("clear", reference)
    if result.returncode != 0 and result.stderr:
        raise MiningSecretError("mining_secret_delete_failed")


def store_secret(reference: str, secret: str) -> MiningSecretStatus:
    reference = _validate_reference(reference)
    plaintext = _validate_secret(secret)
    system = platform.system()
    if system == "Windows":
        _windows_store(reference, plaintext)
    elif system == "Darwin":
        _macos_backend().store(reference, plaintext)
    elif system == "Linux":
        _linux_store(reference, plaintext)
    else:
        raise MiningSecretError("mining_secret_backend_unsupported")
    return MiningSecretStatus(reference, backend_name(), True)


def secret_status(reference: str) -> MiningSecretStatus:
    reference = _validate_reference(reference)
    system = platform.system()
    if system == "Windows":
        present = _windows_status(reference)
    elif system == "Darwin":
        present = _macos_backend().status(reference)
    elif system == "Linux":
        present = _linux_status(reference)
    else:
        raise MiningSecretError("mining_secret_backend_unsupported")
    return MiningSecretStatus(reference, backend_name(), present)


def resolve_secret(reference: str) -> str:
    """Resolve plaintext for a local trusted runtime only.

    Callers must never put the returned value in logs, control-channel payloads,
    process command lines or environment inherited by renter workloads.
    """
    reference = _validate_reference(reference)
    system = platform.system()
    if system == "Windows":
        plaintext = _windows_resolve(reference)
    elif system == "Darwin":
        plaintext = _macos_backend().resolve(reference)
    elif system == "Linux":
        plaintext = _linux_resolve(reference)
    else:
        raise MiningSecretError("mining_secret_backend_unsupported")
    return _decode_secret(plaintext)


def rotate_secret(reference: str, secret: str) -> MiningSecretStatus:
    reference = _validate_reference(reference)
    if not secret_status(reference).present:
        raise MiningSecretError("mining_secret_not_found")
    return store_secret(reference, secret)


def delete_secret(reference: str) -> MiningSecretStatus:
    reference = _validate_reference(reference)
    system = platform.system()
    if system == "Windows":
        _windows_delete(reference)
    elif system == "Darwin":
        _macos_backend().delete(reference)
    elif system == "Linux":
        _linux_delete(reference)
    else:
        raise MiningSecretError("mining_secret_backend_unsupported")
    return MiningSecretStatus(reference, backend_name(), False)
