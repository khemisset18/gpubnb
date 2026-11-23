"""Owner-controlled, machine-local consent for private Gaming qualification.

The flag is deliberately separate from server authorization. It only permits
the local Agent to honor an authenticated, server-pinned private Gaming session;
it never creates a listing, booking, GPU proof, or public eligibility.
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
from typing import Any

from .storage import _atomic_write, config_dir

CONSENT_SCHEMA_VERSION = 1
CONSENT_FILENAME = "private-gaming-consent.json"
MAX_CONSENT_BYTES = 4096


def consent_path() -> Path:
    return config_dir() / CONSENT_FILENAME


def _read_consent_record() -> dict[str, Any] | None:
    path = consent_path()
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_CONSENT_BYTES:
            return None
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    if (
        not isinstance(value, dict)
        or value.get("schemaVersion") != CONSENT_SCHEMA_VERSION
        or value.get("workspaceSlug") != "gaming"
        or not isinstance(value.get("enabled"), bool)
    ):
        return None
    consented_at = value.get("consentedAt")
    if value["enabled"] is True and (
        not isinstance(consented_at, str) or len(consented_at) > 40
    ):
        return None
    if value["enabled"] is False:
        consented_at = None
    return {"enabled": value["enabled"], "consentedAt": consented_at}


def read_private_gaming_consent() -> dict[str, Any]:
    """Return the saved local owner decision; malformed data fails closed."""
    return _read_consent_record() or {"enabled": False, "consentedAt": None}


def private_console_environment_opt_in_enabled() -> bool:
    """Read the legacy explicit opt-in used by non-Gaming console qualification."""
    return os.environ.get("GPUBNB_PRIVATE_CONSOLE_QUALIFICATION") == "true"


def private_console_local_opt_in_enabled() -> bool:
    """Read explicit test env opt-in or the persisted owner Gaming consent.

    An explicit false environment value denies the path. A persisted owner
    revocation then takes precedence over any environment opt-in.
    """
    environment = os.environ.get("GPUBNB_PRIVATE_CONSOLE_QUALIFICATION")
    if environment == "false":
        return False
    record = _read_consent_record()
    if record is not None:
        return record["enabled"] is True
    path = consent_path()
    if path.exists() or path.is_symlink():
        return False
    return environment == "true"


def private_gaming_workspace_local_opt_in_enabled() -> bool:
    """Return the local owner decision scoped to the Gaming workspace."""
    return private_console_local_opt_in_enabled()


def private_gaming_consent_status() -> dict[str, Any]:
    saved = read_private_gaming_consent()
    enabled = private_console_local_opt_in_enabled()
    return {
        "enabled": enabled,
        "consentedAt": saved["consentedAt"] if enabled else None,
        "environmentBlocked": os.environ.get("GPUBNB_PRIVATE_CONSOLE_QUALIFICATION") == "false",
    }


def set_private_gaming_consent(enabled: bool, *, confirmed: bool = False) -> dict[str, Any]:
    """Persist or revoke the owner's explicit local Gaming test decision."""
    if enabled:
        if confirmed is not True:
            raise RuntimeError("private_gaming_owner_consent_required")
        consented_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        payload = {
            "schemaVersion": CONSENT_SCHEMA_VERSION,
            "workspaceSlug": "gaming",
            "enabled": True,
            "consentedAt": consented_at,
        }
        _atomic_write(
            consent_path(),
            json.dumps(payload, ensure_ascii=True, separators=(",", ":")) + "\n",
        )
        return {"enabled": True, "consentedAt": consented_at}

    revoked_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    payload = {
        "schemaVersion": CONSENT_SCHEMA_VERSION,
        "workspaceSlug": "gaming",
        "enabled": False,
        "consentedAt": None,
        "revokedAt": revoked_at,
    }
    try:
        _atomic_write(
            consent_path(),
            json.dumps(payload, ensure_ascii=True, separators=(",", ":")) + "\n",
        )
    except OSError as exc:
        raise RuntimeError("private_gaming_consent_revoke_failed") from exc
    return {"enabled": False, "consentedAt": None}
