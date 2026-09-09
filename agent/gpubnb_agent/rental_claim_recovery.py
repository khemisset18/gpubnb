"""Fencing-safe recovery for stale local rental quarantine records.

A server-side diagnostic can legitimately clear Machine/Accelerator moderation, but
older Agent builds may still retain a local QUARANTINED rental claim after the old
lease/session is gone.  Blindly deleting that state would destroy the fencing
invariant.  This layer only supersedes such a record when a newly fetched rental
authority proves a strictly newer fence and the physical GPU is freshly quiescent.
"""
from __future__ import annotations

import logging
import time
from typing import Callable

from .execution_control import ExecutionControlError
from .gpu_rental_preemption import (
    GpuQuiescenceProof,
    RentalClaimRecord,
    RentalPreemptionSupervisor,
    RentalResourceSpec,
    _resource_transition_lock,
)
from .gpu_resource_supervisor import RuntimeRecord

_LOGGER = logging.getLogger(__name__)

PreemptFunc = Callable[
    [RentalPreemptionSupervisor, RentalResourceSpec],
    GpuQuiescenceProof,
]

# Capture the qualified implementation before this module installs its narrow
# recovery wrapper.  This remains the canonical path for every normal claim.
_ORIGINAL_PREEMPT: PreemptFunc = RentalPreemptionSupervisor.preempt_for_rental
_INSTALLED = False


def _authority_is_strictly_newer(
    previous: RentalClaimRecord,
    spec: RentalResourceSpec,
) -> bool:
    """Return true only for a server authority that can supersede the old claim."""
    return (
        previous.state == "QUARANTINED"
        and previous.resource_id == spec.resource_id
        and previous.hardware_uuid.casefold() == spec.hardware_uuid.casefold()
        and previous.holder_id == f"rental:{previous.session_id}"
        and spec.holder_id == f"rental:{spec.session_id}"
        and spec.fencing_token == str(spec.runtime_generation)
        and spec.runtime_generation > previous.runtime_generation
        and spec.lease_id != previous.lease_id
    )


def _runtime_is_recoverable(
    record: RuntimeRecord | None,
    previous: RentalClaimRecord,
    spec: RentalResourceSpec,
) -> bool:
    if record is None:
        return True
    if record.hardware_uuid.casefold() != spec.hardware_uuid.casefold():
        return False
    if record.state not in {"QUARANTINED", "STOPPED"}:
        return False
    # Any persisted process identity means the Agent cannot prove that a prior
    # owned process is gone merely from a new lease. Keep that case fail-closed.
    if record.pid is not None or record.process_creation_token is not None:
        return False
    if record.runtime_generation > spec.runtime_generation:
        return False
    # Normal first recovery: runtime generation is at/before the quarantined
    # claim. Crash recovery: this layer may already have advanced the runtime
    # to the exact new generation before persisting the new PREEMPTING claim.
    if (
        record.runtime_generation > previous.runtime_generation
        and record.runtime_generation != spec.runtime_generation
    ):
        return False
    return True


def _recover_stale_quarantined_claim(
    supervisor: RentalPreemptionSupervisor,
    spec: RentalResourceSpec,
) -> bool:
    """Promote one stale QUARANTINED record to the new PREEMPTING authority.

    No local state is changed until both physical GPU binding and quiescence have
    been freshly proven.  Returning False means the normal preemption path must
    decide the outcome and therefore preserves all existing fail-closed errors.
    """
    claims = supervisor.claims.load()
    previous = claims.get(spec.resource_id)
    if previous is None or not _authority_is_strictly_newer(previous, spec):
        return False

    records = supervisor.mining.store.load()
    current = records.get(spec.resource_id)
    if not _runtime_is_recoverable(current, previous, spec):
        return False

    # The new authority alone is not enough. Re-resolve the physical UUID and
    # prove the target GPU has no foreign compute clients / unsafe utilization.
    # Any failure happens before mutation and leaves quarantine untouched.
    supervisor.mining.binding_resolver(spec.hardware_uuid)
    proof = supervisor.probe.prove(spec.hardware_uuid)

    now_ms = int(time.time() * 1000)
    if current is None:
        current = RuntimeRecord(
            resource_id=spec.resource_id,
            hardware_uuid=spec.hardware_uuid,
            runtime_generation=spec.runtime_generation,
            state="STOPPED",
            updated_at_ms=now_ms,
        )
    else:
        current.runtime_generation = spec.runtime_generation
        current.state = "STOPPED"
        current.pid = None
        current.process_creation_token = None
        current.command_id = None
        current.updated_at_ms = now_ms
    records[spec.resource_id] = current
    supervisor.mining.store.save(records)

    # Persist the new fenced intent after the physical proof. If the process
    # crashes here, the canonical preemption implementation can resume this
    # exact PREEMPTING tuple on the next reconciliation tick.
    claims = supervisor.claims.load()
    claims[spec.resource_id] = RentalClaimRecord(
        session_id=spec.session_id,
        resource_id=spec.resource_id,
        hardware_uuid=spec.hardware_uuid,
        runtime_generation=spec.runtime_generation,
        holder_id=spec.holder_id,
        lease_id=spec.lease_id,
        fencing_token=spec.fencing_token,
        state="PREEMPTING",
        verified_at_ms=proof.verified_at_ms,
    )
    supervisor.claims.save(claims)

    _LOGGER.warning(
        "stale_quarantined_rental_claim_recovered resource=%s old_generation=%s new_generation=%s old_session=%s new_session=%s",
        spec.resource_id,
        previous.runtime_generation,
        spec.runtime_generation,
        previous.session_id,
        spec.session_id,
    )
    return True


def _preempt_with_recovery(
    supervisor: RentalPreemptionSupervisor,
    spec: RentalResourceSpec,
    original: PreemptFunc = _ORIGINAL_PREEMPT,
) -> GpuQuiescenceProof:
    # Serialize the recovery decision with mining/rental transitions. The lock is
    # an RLock, so the canonical implementation can safely acquire it again.
    with _resource_transition_lock(spec.resource_id):
        _recover_stale_quarantined_claim(supervisor, spec)
    # Always finish through the existing qualified preemption implementation.
    # It re-proves quiescence and writes QUIESCENT, preserving its crash recovery
    # and all ordinary fencing/error behavior.
    return original(supervisor, spec)


def install() -> None:
    """Install the narrow stale-quarantine recovery layer once per process."""
    global _INSTALLED
    if _INSTALLED:
        return

    def wrapped(
        self: RentalPreemptionSupervisor,
        spec: RentalResourceSpec,
    ) -> GpuQuiescenceProof:
        return _preempt_with_recovery(self, spec, _ORIGINAL_PREEMPT)

    RentalPreemptionSupervisor.preempt_for_rental = wrapped  # type: ignore[method-assign]
    _INSTALLED = True
