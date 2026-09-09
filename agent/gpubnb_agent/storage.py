"""Private local configuration and Ed25519 key storage."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import platform
import subprocess
import sys
import tempfile
import threading
from functools import lru_cache
from pathlib import Path
from typing import Any

import base58
from nacl.signing import SigningKey

WINDOWS_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
_SECURED_DIRECTORIES_LOCK = threading.Lock()
_SECURED_DIRECTORIES: set[str] = set()


def config_dir() -> Path:
    override = os.environ.get("GPUBNB_CONFIG_DIR")
    if override:
        return Path(override).expanduser()
    if platform.system() == "Windows":
        program_data = os.environ.get("PROGRAMDATA")
        if not program_data:
            raise RuntimeError("PROGRAMDATA_absent")
        return Path(program_data) / "GPUbnb"
    return Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "gpubnb"


def _windows_creation_flags() -> int:
    return WINDOWS_CREATE_NO_WINDOW if os.name == "nt" else 0


@lru_cache(maxsize=1)
def _windows_owner() -> str | None:
    # Process identity cannot change while the Agent service is running. Resolve it
    # once from Windows instead of spawning `whoami` for every atomic heartbeat file
    # write. Environment variables remain only a fallback for restricted contexts.
    try:
        result = subprocess.run(
            ["whoami"],
            capture_output=True,
            text=True,
            shell=False,
            check=False,
            creationflags=_windows_creation_flags(),
        )
        account = result.stdout.strip()
        if result.returncode == 0 and account:
            return account
    except OSError:
        pass
    domain = os.environ.get("USERDOMAIN", "")
    user = os.environ.get("USERNAME", "")
    if not user:
        return None
    return f"{domain}\\{user}" if domain else user


def _secure_windows_acl(path: Path) -> bool:
    # %PROGRAMDATA% inherits a default ACL that grants the local Users group read
    # access. Restrict the Agent data root to the service identity and SYSTEM. Child
    # files created inside this directory inherit the same protected ACL, so the
    # expensive icacls operation belongs on the directory boundary rather than on
    # every heartbeat counter rewrite.
    owner = _windows_owner()
    if not owner:
        print(
            "AVERTISSEMENT: impossible de déterminer l'utilisateur Windows courant "
            f"pour restreindre les permissions de {path}",
            file=sys.stderr,
        )
        return False
    rights = "(OI)(CI)F" if path.is_dir() else "F"
    result = subprocess.run(
        [
            "icacls",
            str(path),
            "/inheritance:r",
            "/grant:r",
            f"{owner}:{rights}",
            f"SYSTEM:{rights}",
        ],
        capture_output=True,
        text=True,
        shell=False,
        check=False,
        creationflags=_windows_creation_flags(),
    )
    if result.returncode != 0:
        print(
            f"AVERTISSEMENT: échec de la restriction ACL Windows sur {path}: "
            f"{result.stderr.strip()[:300]}",
            file=sys.stderr,
        )
        return False
    return True


def _directory_cache_key(path: Path) -> str:
    try:
        resolved = path.resolve()
    except OSError:
        resolved = path.absolute()
    return os.path.normcase(str(resolved))


def _secure_directory(path: Path) -> bool:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name != "nt":
        path.chmod(0o700)
        return True

    key = _directory_cache_key(path)
    with _SECURED_DIRECTORIES_LOCK:
        if key in _SECURED_DIRECTORIES:
            return True
        secured = _secure_windows_acl(path)
        if secured:
            _SECURED_DIRECTORIES.add(key)
        return secured


def _atomic_write(path: Path, content: str) -> None:
    parent_secured = _secure_directory(path.parent)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent, text=True)
    try:
        if os.name != "nt":
            os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        # The temporary file was created *after* the parent ACL was hardened and in
        # the same directory, so on Windows it inherits the protected owner/SYSTEM
        # ACL. os.replace preserves that file security descriptor. If parent ACL
        # hardening failed, make one explicit best-effort file-level attempt rather
        # than silently leaving broad inherited permissions.
        os.replace(temporary, path)
        if os.name != "nt":
            path.chmod(0o600)
        elif not parent_secured:
            _secure_windows_acl(path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def config_path() -> Path:
    return config_dir() / "config.json"


def key_path() -> Path:
    return config_dir() / "agent.key"


def counter_path() -> Path:
    return config_dir() / "counter"


def control_channel_state_path() -> Path:
    return config_dir() / "control-channel-state.json"


def log_path() -> Path:
    return config_dir() / "agent.log"


def pid_path() -> Path:
    return config_dir() / "agent.pid"


def load_config() -> dict[str, Any]:
    try:
        value = json.loads(config_path().read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Configuration invalide : {exc}") from exc


def save_config(value: dict[str, Any]) -> None:
    _atomic_write(config_path(), json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def load_control_channel_state() -> dict[str, Any]:
    try:
        value = json.loads(control_channel_state_path().read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise RuntimeError("État du canal de contrôle invalide")
        return value
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"État du canal de contrôle corrompu : {exc}") from exc


def save_control_channel_state(value: dict[str, Any]) -> None:
    _atomic_write(
        control_channel_state_path(),
        json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n",
    )


def generate_key(force: bool = False) -> SigningKey:
    path = key_path()
    if path.exists() and not force:
        return load_key()
    key = SigningKey.generate()
    _atomic_write(path, base64.b64encode(bytes(key)).decode("ascii") + "\n")
    return key


def load_key() -> SigningKey:
    try:
        raw = base64.b64decode(key_path().read_text(encoding="ascii").strip(), validate=True)
    except FileNotFoundError as exc:
        raise RuntimeError("Clé absente. Exécutez d'abord : gpubnb-agent setup") from exc
    if len(raw) != 32:
        raise RuntimeError("La clé locale est corrompue")
    return SigningKey(raw)


def public_key(key: SigningKey | None = None) -> str:
    active = key or load_key()
    return base58.b58encode(bytes(active.verify_key)).decode("ascii")


def fingerprint(key: SigningKey | None = None) -> str:
    digest = hashlib.sha256(bytes((key or load_key()).verify_key)).hexdigest().upper()
    return ":".join(digest[index:index + 4] for index in range(0, 24, 4))


def load_counter() -> int:
    try:
        return max(0, int(counter_path().read_text(encoding="ascii").strip()))
    except (FileNotFoundError, ValueError):
        return 0


def save_counter(value: int) -> None:
    _atomic_write(counter_path(), str(value))


def fingerprint_path() -> Path:
    return config_dir() / "machine.fingerprint"


def load_machine_fingerprint() -> str | None:
    try:
        return fingerprint_path().read_text(encoding="ascii").strip() or None
    except FileNotFoundError:
        return None


def save_machine_fingerprint(value: str) -> None:
    if not value:
        return
    # Avoid a second atomic write (and historically another ACL/console cascade)
    # on every successful heartbeat when the physical fingerprint is unchanged.
    if load_machine_fingerprint() == value:
        return
    _atomic_write(fingerprint_path(), value)


def detect_hardware_change(current_fingerprint: str) -> tuple[bool, str | None]:
    previous = load_machine_fingerprint()
    if not previous:
        if current_fingerprint:
            save_machine_fingerprint(current_fingerprint)
        return False, None
    if not current_fingerprint:
        return False, previous
    return previous != current_fingerprint, previous
