"""RAM-only PRL/DOGE *synthetic draft* lifecycle for security qualification.

This is NOT an API, public exchange listing, authentication system, custody,
transaction/settlement service, or durable order book. No I/O and no network.
"""
from __future__ import annotations

import re
import threading
from dataclasses import dataclass
from offline_preflight import parse_public_request, inspect_public_request, Refused

_MAX_TOTAL = 128
_MAX_OWNER = 4
_MAX_LIFETIME = 1440
_MAX_TICK = 1_000_000_000
_OWNER_RE = re.compile(r"lab_[a-z0-9]{3,16}\\Z", re.ASCII)
_COMMAND_RE = re.compile(r"cmd_[a-z0-9_-]{6,32}\\Z", re.ASCII)
_RECORD_RE = re.compile(r"prl-lab-[0-9]{8}\\Z", re.ASCII)


class DraftRefused(ValueError):
    """Fail closed on malformed, stale, ambiguous or unauthorised test input."""


def _label(value: object, pattern: re.Pattern[str], name: str) -> str:
    if type(value) is not str or pattern.fullmatch(value) is None:
        raise DraftRefused(f"{name}: only synthetic ASCII labels allowed")
    return value


def _tick(value: object, name: str) -> int:
    if type(value) is not int or not 0 <= value <= _MAX_TICK:
        raise DraftRefused(f"{name}: invalid logical tick")
    return value


@dataclass(frozen=True)
class _Record:
    identifier: str
    owner: str
    intent_digest: str
    offered_grains: str
    requested_atoms: str
    created_tick: int
    expires_tick: int
    revision: int
    cancelled: bool


class SyntheticDraftLedger:
    """Small thread-safe fake store, not production persistence or identity.

    actor_label is UNAUTHENTICATED simulator input. Owner checks here
    only exercise expected authorization logic, NOT a login/session proof.
    Predictable IDs are never authorization credentials.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._records: dict[str, _Record] = {}
        # (actor_label, command_id) -> (operation, record_id, binding)
        self._commands: dict[tuple[str, str], tuple[str, str, str]] = {}
        self._counter = 0

    @staticmethod
    def _render(record: _Record, now_tick: int) -> dict:
        if record.cancelled:
            status = "CANCELLED_PREVIEW_ONLY"
        elif now_tick >= record.expires_tick:
            status = "EXPIRED_PREVIEW_ONLY"
        else:
            status = "DRAFT_PREVIEW_ONLY"
        return {
            "classification": "PRL_SYNTHETIC_MARKETPLACE_DRAFT_NO_PUBLICATION",
            "draftId": record.identifier,
            "ownerLabel": record.owner,
            "intentSha256": record.intent_digest,
            "offeredGrains": record.offered_grains,
            "requestedAsset": "DOGE",
            "requestedAtoms": record.requested_atoms,
            "status": status,
            "revision": record.revision,
            "createdTick": record.created_tick,
            "expiresTick": record.expires_tick,
            "actorAuthenticated": False,
            "networkIdentityVerified": False,
            "realExchangeListingCreated": False,
            "qualified": False,
            "canPostOffer": False,
            "canTakeOffer": False,
            "canFund": False,
            "canSign": False,
            "canBroadcast": False,
            "canSettle": False,
            "automaticSettlementSupported": False,
        }

    @staticmethod
    def _clock_for(record: _Record, now_tick: object) -> int:
        tick = _tick(now_tick, "now_tick")
        if tick < record.created_tick:
            raise DraftRefused("logical clock moved before draft creation")
        return tick

    def create(self, *, actor_label: str, command_id: str, raw_request: bytes,
               now_tick: int, expires_tick: int) -> dict:
        actor = _label(actor_label, _OWNER_RE, "actor_label")
        command = _label(command_id, _COMMAND_RE, "command_id")
        now = _tick(now_tick, "now_tick")
        expiry = _tick(expires_tick, "expires_tick")
        if not now < expiry <= now + _MAX_LIFETIME:
            raise DraftRefused("invalid synthetic expiry window")
        try:
            request = parse_public_request(raw_request)
            review = inspect_public_request(request)
        except (Refused, TypeError, ValueError) as exc:
            raise DraftRefused("synthetic PRL offer failed preflight") from exc
        digest = review["requestSha256"]
        binding = f"{digest}:{expiry}"
        command_key = (actor, command)
        with self._lock:
            old_command = self._commands.get(command_key)
            if old_command is not None:
                if old_command[0] != "create" or old_command[2] != binding:
                    raise DraftRefused("idempotency key reused for different intent")
                record = self._records[old_command[1]]
                return self._render(record, self._clock_for(record, now))
            if len(self._records) >= _MAX_TOTAL:
                raise DraftRefused("fake store global quota exceeded")
            if sum(r.owner == actor for r in self._records.values()) >= _MAX_OWNER:
                raise DraftRefused("fake owner quota exceeded")
            self._counter += 1
            identifier = f"prl-lab-{self._counter:08d}"
            record = _Record(
                identifier, actor, digest,
                request["offer"]["offeredGrains"],
                request["offer"]["requestedAtoms"],
                now, expiry, 1, False,
            )
            self._records[identifier] = record
            self._commands[command_key] = ("create", identifier, binding)
            return self._render(record, now)

    def view(self, *, actor_label: str, draft_id: str, now_tick: int) -> dict:
        actor = _label(actor_label, _OWNER_RE, "actor_label")
        identifier = _label(draft_id, _RECORD_RE, "draft_id")
        with self._lock:
            record = self._records.get(identifier)
            if record is None or record.owner != actor:
                # Uniform response: don't disclose existence to other labels.
                raise DraftRefused("draft unavailable")
            return self._render(record, self._clock_for(record, now_tick))

    def cancel(self, *, actor_label: str, draft_id: str, command_id: str,
               expected_revision: int, now_tick: int) -> dict:
        actor = _label(actor_label, _OWNER_RE, "actor_label")
        identifier = _label(draft_id, _RECORD_RE, "draft_id")
        command = _label(command_id, _COMMAND_RE, "command_id")
        if type(expected_revision) is not int or expected_revision < 1:
            raise DraftRefused("invalid expected revision")
        now = _tick(now_tick, "now_tick")
        binding = f"{identifier}:{expected_revision}"
        key = (actor, command)
        with self._lock:
            record = self._records.get(identifier)
            if record is None or record.owner != actor:
                raise DraftRefused("draft unavailable")
            now = self._clock_for(record, now)
            old_command = self._commands.get(key)
            if old_command is not None:
                if old_command != ("cancel", identifier, binding):
                    raise DraftRefused("idempotency key reused for different intent")
                return self._render(record, now)
            if record.cancelled or now >= record.expires_tick:
                raise DraftRefused("draft cannot be cancelled in this state")
            if record.revision != expected_revision:
                raise DraftRefused("stale expected revision")
            new_record = _Record(
                record.identifier, record.owner, record.intent_digest,
                record.offered_grains, record.requested_atoms,
                record.created_tick, record.expires_tick,
                record.revision + 1, True,
            )
            self._records[identifier] = new_record
            self._commands[key] = ("cancel", identifier, binding)
            return self._render(new_record, now)

    def list_own(self, *, actor_label: str, now_tick: int) -> list[dict]:
        actor = _label(actor_label, _OWNER_RE, "actor_label")
        now = _tick(now_tick, "now_tick")
        with self._lock:
            records = [r for r in self._records.values() if r.owner == actor]
            if any(now < r.created_tick for r in records):
                raise DraftRefused("logical clock moved before draft creation")
            return [self._render(r, now) for r in records]
