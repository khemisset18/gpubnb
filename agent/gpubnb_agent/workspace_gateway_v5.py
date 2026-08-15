"""Resource-scoped GPU rental lifecycle for Developer Workspace sessions.

v5 layers on top of the hardened v4 relay.  When the API exposes a signed rental
resource authority, only the GPUs allocated to that session are preempted and
passed to Docker by NVIDIA UUID.  Older API deployments keep the proven legacy
machine-wide mining guard until the server side of this protocol is available.
"""
from __future__ import annotations

import json
from typing import Any

from . import workspace_gateway as legacy
from . import workspace_gateway_v4 as strict_http
from .execution_control import ExecutionControlError
from .gpu_rental_preemption import (
    RentalPreemptionSupervisor,
    RentalResourceSpec,
    install_rental_mining_guard,
    parse_rental_resource,
)

RENTAL_AUTHORITY_PROTOCOL_VERSION = 1


class GatewaySupervisor(strict_http.GatewaySupervisor):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.rental_preemption = RentalPreemptionSupervisor()
        self._rental_authority_available = False
        self._rental_authority: dict[str, dict[str, Any]] = {}
        self._resource_start_context: list[RentalResourceSpec] | None = None

    def _refresh_rental_authority(self) -> None:
        try:
            payload = self._request(f"/agent/mining/{self.machine_id}/rental-authority")
        except Exception as exc:
            # Compatibility during staggered API/Agent deployment.  Absence of the
            # authority never enables resource mode: the inherited machine-wide
            # mining guard remains in force until the signed endpoint is available.
            self._rental_authority_available = False
            self._rental_authority = {}
            self._report_error(exc)
            return
        protocol_version = payload.get("protocolVersion")
        if protocol_version is None:
            # Older API deployments (and the historical gateway contract) have no
            # rental-authority protocol at all. Missing protocol is therefore an
            # explicit compatibility signal, not permission to infer ownership.
            # Keep the more conservative legacy machine-wide mining guard active.
            self._rental_authority_available = False
            self._rental_authority = {}
            return
        if protocol_version != RENTAL_AUTHORITY_PROTOCOL_VERSION:
            # Once a server advertises this protocol, an unexpected version is a
            # real contract violation and must fail closed rather than downgrade.
            raise RuntimeError("rental_resource_authority_protocol_invalid")
        raw_sessions = payload.get("sessions")
        if not isinstance(raw_sessions, list) or len(raw_sessions) > 32:
            raise RuntimeError("rental_resource_authority_sessions_invalid")
        authority: dict[str, dict[str, Any]] = {}
        resource_owners: dict[str, str] = {}
        for raw in raw_sessions:
            if not isinstance(raw, dict):
                raise RuntimeError("rental_resource_authority_session_invalid")
            session_id = str(raw.get("sessionId") or "")
            if not session_id or session_id in authority:
                raise RuntimeError("rental_resource_authority_session_duplicate")
            resources = raw.get("resources")
            if not isinstance(resources, list) or len(resources) > 16:
                raise RuntimeError("rental_resource_authority_resources_invalid")
            parsed = [parse_rental_resource(session_id, resource) for resource in resources]
            for spec in parsed:
                previous = resource_owners.get(spec.resource_id)
                if previous is not None and previous != session_id:
                    raise RuntimeError("rental_resource_authority_overlap")
                resource_owners[spec.resource_id] = session_id
            authority[session_id] = {
                "status": str(raw.get("status") or ""),
                "blockedReason": str(raw.get("blockedReason") or ""),
                "resources": parsed,
            }
        self._rental_authority_available = True
        self._rental_authority = authority

    def _session_specs(self, session_id: str) -> list[RentalResourceSpec] | None:
        if not self._rental_authority_available:
            return None
        entry = self._rental_authority.get(session_id)
        if entry is None:
            raise RuntimeError("rental_resource_authority_missing_for_session")
        blocked = str(entry.get("blockedReason") or "")
        if blocked:
            raise RuntimeError(blocked)
        specs = entry.get("resources")
        if not isinstance(specs, list) or not specs:
            raise RuntimeError("rental_resource_authority_empty")
        return list(specs)

    def _reconcile_sessions(self) -> None:
        self._refresh_rental_authority()
        return super()._reconcile_sessions()

    def _stop_mining_and_verify(self) -> bool:
        if self._resource_start_context is not None:
            # The resource-scoped preemption proof already ran before the inherited
            # workspace lifecycle reached this legacy machine-wide hook.
            return True
        return super()._stop_mining_and_verify()

    @staticmethod
    def _expected_gpu_uuids(specs: list[RentalResourceSpec]) -> list[str]:
        values = sorted({spec.hardware_uuid for spec in specs}, key=str.casefold)
        if len(values) != len(specs):
            raise RuntimeError("rental_workspace_gpu_uuid_duplicate")
        return values

    def _launch_workspace_container(
        self, container: str, volume: str, internal_network: str, image: str
    ) -> None:
        specs = self._resource_start_context
        if specs is None:
            return super()._launch_workspace_container(container, volume, internal_network, image)
        gpu_uuids = self._expected_gpu_uuids(specs)
        self._docker([
            "run", "-d", "--name", container,
            "--network", internal_network,
            "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
            "--pids-limit=512", "--memory=4g", "--cpus=2",
            "--tmpfs=/tmp:rw,noexec,nosuid,size=256m",
            legacy.DEVELOPER_HOME_TMPFS,
            "--mount", f"type=volume,source={volume},target=/workspace",
            "--gpus", f"device={','.join(gpu_uuids)}",
            "--env=NVIDIA_DRIVER_CAPABILITIES=compute,utility",
            "--entrypoint", "code-server", image,
            "--bind-addr", "0.0.0.0:3000", "--auth", "none", "/workspace",
        ], timeout=legacy.START_TIMEOUT_SECONDS)

    def _container_gpu_uuids(self, container: str) -> set[str] | None:
        result = self._docker(
            ["inspect", "--format", "{{json .HostConfig.DeviceRequests}}", container],
            check=False,
        )
        if result.returncode != 0:
            return None
        try:
            requests = json.loads(result.stdout)
        except json.JSONDecodeError:
            return None
        if not isinstance(requests, list):
            return None
        device_ids: set[str] = set()
        for request in requests:
            if not isinstance(request, dict):
                continue
            driver = str(request.get("Driver") or "")
            if driver and driver.casefold() != "nvidia":
                continue
            ids = request.get("DeviceIDs")
            if isinstance(ids, list):
                device_ids.update(str(value) for value in ids if isinstance(value, str))
        return device_ids

    def _start_runtime(self, session_id: str) -> legacy.Runtime:
        specs = self._session_specs(session_id)
        if specs is None:
            return super()._start_runtime(session_id)
        for spec in specs:
            self.rental_preemption.preempt_for_rental(spec)
        self._resource_start_context = specs
        try:
            runtime = super()._start_runtime(session_id)
        finally:
            self._resource_start_context = None
        try:
            actual = self._container_gpu_uuids(runtime.container_name)
            expected = set(self._expected_gpu_uuids(specs))
            if actual != expected:
                raise RuntimeError("rental_workspace_gpu_binding_mismatch")
            for spec in specs:
                self.rental_preemption.mark_rental_active(spec)
        except Exception:
            super()._stop_runtime(session_id)
            raise
        return runtime

    def _adopt_or_start_runtime(self, session_id: str) -> legacy.Runtime:
        specs = self._session_specs(session_id)
        if specs is None:
            return super()._adopt_or_start_runtime(session_id)
        container, volume = legacy.names_for_session(session_id)
        proxy = legacy.proxy_name_for_session(session_id)
        if self._container_running(container) and self._container_running(proxy):
            expected = set(self._expected_gpu_uuids(specs))
            actual = self._container_gpu_uuids(container)
            if actual == expected and self.rental_preemption.can_adopt_active(specs):
                return super()._adopt_or_start_runtime(session_id)
        # Ambiguous adoption after an Agent crash is deliberately not trusted.
        # Remove stale workspace resources first. A persisted PREEMPTING claim is
        # not cleanup state: it is resumed under the same lease/fence by
        # preempt_for_rental(). QUIESCENT/ACTIVE claims are reproved and dropped
        # locally before a clean rebuild; the server lease remains held.
        self._cleanup_names(container, volume)
        claims = self.rental_preemption.claims_for_session(session_id)
        if claims and not any(claim.state == "PREEMPTING" for claim in claims):
            self.rental_preemption.release_after_cleanup(session_id)
        return self._start_runtime(session_id)

    def _release_server_leases(self, session_id: str, claims: list[Any]) -> None:
        if not claims:
            return
        body = {
            "leases": [
                {
                    "resourceId": claim.resource_id,
                    "holderId": claim.holder_id,
                    "leaseId": claim.lease_id,
                    "fencingToken": claim.fencing_token,
                }
                for claim in claims
            ]
        }
        try:
            self._request(
                f"/agent/mining/{self.machine_id}/rental-authority/{session_id}/release",
                "POST",
                body,
            )
        except Exception as exc:
            # Safe failure: the server lease remains fenced until TTL expiry. The
            # workspace is already gone and local cleanup proof already succeeded.
            self._report_error(exc)

    def _stop_runtime(self, session_id: str) -> bool:
        cleaned = super()._stop_runtime(session_id)
        if not cleaned:
            return False
        claims = self.rental_preemption.claims_for_session(session_id)
        if not claims:
            return True
        try:
            released = self.rental_preemption.release_after_cleanup(session_id)
        except ExecutionControlError:
            return False
        self._release_server_leases(session_id, released)
        return True


def install() -> None:
    install_rental_mining_guard()
    legacy.GatewaySupervisor = GatewaySupervisor
