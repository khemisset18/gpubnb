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
    parse_rental_authority_sessions,
    resolve_session_resources,
)


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
        if payload.get("protocolVersion") is None:
            # Older API deployments (and the historical gateway contract) have no
            # rental-authority protocol at all. Missing protocol is therefore an
            # explicit compatibility signal, not permission to infer ownership.
            # Keep the more conservative legacy machine-wide mining guard active.
            self._rental_authority_available = False
            self._rental_authority = {}
            return
        # parse_rental_authority_sessions fails closed (raises) on an unexpected
        # protocol version or any structural violation - a real contract breach
        # once the server advertises this protocol, not a downgrade signal.
        self._rental_authority = parse_rental_authority_sessions(payload)
        self._rental_authority_available = True

    def _session_specs(self, session_id: str) -> list[RentalResourceSpec] | None:
        if not self._rental_authority_available:
            return None
        return resolve_session_resources(self._rental_authority, session_id)

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
        self, container: str, volume: str, internal_network: str, image: str,
        workspace_slug: str = "developer",
    ) -> None:
        specs = self._resource_start_context
        # Data Workspace never attaches --gpus, even when a GPU is nominally
        # reserved for this session's exclusivity/billing (see
        # rental-resource-authority.ts: every executable workspace routes
        # through the same authority now, not just GPU-attaching ones) -
        # only Developer's and AI's containers actually need the device
        # passed through (legacy.GPU_ATTACHED_WORKSPACE_SLUGS).
        if specs is None or workspace_slug not in legacy.GPU_ATTACHED_WORKSPACE_SLUGS:
            return super()._launch_workspace_container(container, volume, internal_network, image, workspace_slug)
        gpu_uuids = self._expected_gpu_uuids(specs)
        if workspace_slug in ("ai", "video"):
            # NVENC needs the "video" driver capability in addition to
            # compute,utility - confirmed live it fails closed
            # ("Cannot load libnvidia-encode.so.1") without it, not a silent
            # software fallback.
            capabilities = "compute,utility,video" if workspace_slug == "video" else "compute,utility"
            self._docker([
                "run", "-d", "--name", container,
                "--network", internal_network,
                "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
                "--pids-limit=512", "--memory=8g", "--cpus=2",
                "--tmpfs=/tmp:rw,noexec,nosuid,size=256m",
                legacy.DATA_HOME_TMPFS,
                "--mount", f"type=volume,source={volume},target=/home/jovyan/work",
                "--gpus", f"device={','.join(gpu_uuids)}",
                f"--env=NVIDIA_DRIVER_CAPABILITIES={capabilities}",
                image,
                "start-notebook.py",
                "--ServerApp.ip=0.0.0.0", f"--ServerApp.port={legacy.WORKSPACE_ENTRY_PORT}",
                "--ServerApp.token=", "--ServerApp.password=",
                "--ServerApp.root_dir=/home/jovyan/work",
                "--ServerApp.allow_remote_access=True",
            ], timeout=legacy.START_TIMEOUT_SECONDS)
            return
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
            "--bind-addr", f"0.0.0.0:{legacy.WORKSPACE_ENTRY_PORT}", "--auth", "none", "/workspace",
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

    def _start_runtime(self, session_id: str, workspace_slug: str = "developer") -> legacy.Runtime:
        specs = self._session_specs(session_id)
        if specs is None:
            return super()._start_runtime(session_id, workspace_slug)
        for spec in specs:
            self.rental_preemption.preempt_for_rental(spec)
        self._resource_start_context = specs
        try:
            runtime = super()._start_runtime(session_id, workspace_slug)
        finally:
            self._resource_start_context = None
        try:
            # The GPU-device-request binding proof only applies to workspaces
            # that actually attach the GPU (legacy.GPU_ATTACHED_WORKSPACE_SLUGS):
            # Data's container deliberately carries no device requests at all
            # (see _launch_workspace_container), so `actual` would never equal
            # `expected` there even on a perfectly correct launch.
            if workspace_slug in legacy.GPU_ATTACHED_WORKSPACE_SLUGS:
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

    def _adopt_or_start_runtime(self, session_id: str, workspace_slug: str = "developer") -> legacy.Runtime:
        specs = self._session_specs(session_id)
        if specs is None:
            return super()._adopt_or_start_runtime(session_id, workspace_slug)
        container, volume = legacy.names_for_session(session_id)
        proxy = legacy.proxy_name_for_session(session_id)
        if self._container_running(container) and self._container_running(proxy):
            adoptable = self.rental_preemption.can_adopt_active(specs)
            if workspace_slug in legacy.GPU_ATTACHED_WORKSPACE_SLUGS:
                expected = set(self._expected_gpu_uuids(specs))
                actual = self._container_gpu_uuids(container)
                adoptable = adoptable and actual == expected
            if adoptable:
                return super()._adopt_or_start_runtime(session_id, workspace_slug)
        # Ambiguous adoption after an Agent crash is deliberately not trusted.
        # Remove stale workspace resources first. A persisted PREEMPTING claim is
        # not cleanup state: it is resumed under the same lease/fence by
        # preempt_for_rental(). QUIESCENT/ACTIVE claims are reproved and dropped
        # locally before a clean rebuild; the server lease remains held.
        self._cleanup_names(container, volume)
        claims = self.rental_preemption.claims_for_session(session_id)
        if claims and not any(claim.state == "PREEMPTING" for claim in claims):
            self.rental_preemption.release_after_cleanup(session_id)
        return self._start_runtime(session_id, workspace_slug)

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
