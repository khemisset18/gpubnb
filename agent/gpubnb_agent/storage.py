"""Private local configuration and Ed25519 key storage."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import platform
import tempfile
from pathlib import Path
from typing import Any

import base58
from nacl.signing import SigningKey


def config_dir() -> Path:
    override = os.environ.get("GPUBNB_CONFIG_DIR")
    if override:
        return Path(override).expanduser()
    if platform.system() == "Windows":
        return Path(os.environ.get("LOCALAPPDATA", Path.home())) / "GPUbnb"
    return Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "gpubnb"


def _secure_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name != "nt":
        path.chmod(0o700)


def _atomic_write(path: Path, content: str) -> None:
    _secure_directory(path.parent)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent, text=True)
    try:
        if os.name != "nt":
            os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        if os.name != "nt":
            path.chmod(0o600)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def config_path() -> Path:
    return config_dir() / "config.json"


def key_path() -> Path:
    return config_dir() / "agent.key"


def counter_path() -> Path:
    return config_dir() / "counter"


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
    if value:
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
