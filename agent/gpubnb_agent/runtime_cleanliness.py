"""Read-only Docker runtime inventory for quarantine diagnostics.

This module never deletes or mutates Docker state. It compares the resources
that physically exist on the Host with the canonical resource names derived
from workspace session ids that the authenticated API says are still allowed.
The same naming helpers as workspace_gateway.py are reused deliberately so the
diagnostic cannot invent a second naming convention.
"""
from __future__ import annotations

import subprocess
from dataclasses import dataclass
from typing import Callable

from .workspace_gateway import (
    CONTAINER_PREFIX,
    INTERNAL_NETWORK_PREFIX,
    PROXY_PREFIX,
    VOLUME_PREFIX,
    names_for_session,
    network_name_for_session,
    proxy_name_for_session,
)

DockerRun = Callable[[list[str]], subprocess.CompletedProcess[str]]


@dataclass(frozen=True)
class RuntimeCleanlinessReport:
    unexpected_containers: tuple[str, ...]
    unexpected_volumes: tuple[str, ...]
    unexpected_networks: tuple[str, ...]

    @property
    def clean(self) -> bool:
        return not (
            self.unexpected_containers
            or self.unexpected_volumes
            or self.unexpected_networks
        )

    def to_api_payload(self) -> dict[str, object]:
        # Do not send a trusted-looking `clean` boolean. The API derives the
        # outcome itself from these bounded evidence lists so an inconsistent
        # client payload can never claim clean=true while also reporting leaks.
        return {
            "unexpectedContainers": list(self.unexpected_containers),
            "unexpectedVolumes": list(self.unexpected_volumes),
            "unexpectedNetworks": list(self.unexpected_networks),
        }


def _real_docker(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["docker", *args],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
        shell=False,
    )


def _checked_lines(result: subprocess.CompletedProcess[str], operation: str) -> set[str]:
    if result.returncode != 0:
        raise RuntimeError(
            f"runtime_cleanliness_docker_failed:{operation[:48]}:{result.returncode}:"
            f"{result.stderr[:240].strip()}"
        )
    return {line.strip() for line in result.stdout.splitlines() if line.strip()}


def inspect_runtime_cleanliness(
    expected_session_ids: list[str] | tuple[str, ...] | set[str],
    docker_run: DockerRun | None = None,
) -> RuntimeCleanlinessReport:
    """Return only unexpected GPUbnb-owned per-session Docker resources.

    `expected_session_ids` comes from the signed API diagnostic assignment.
    The shared `gpubnb-workspace-gateway` network is intentionally excluded:
    it is infrastructure shared by sessions and the existing gateway lifecycle
    deliberately keeps it around. Only per-session resources are evidence of
    a leaked renter runtime.
    """
    run = docker_run or _real_docker
    session_ids = {
        value for value in expected_session_ids
        if isinstance(value, str) and value
    }

    expected_containers: set[str] = set()
    expected_volumes: set[str] = set()
    expected_networks: set[str] = set()
    for session_id in session_ids:
        container, volume = names_for_session(session_id)
        expected_containers.add(container)
        expected_containers.add(proxy_name_for_session(session_id))
        expected_volumes.add(volume)
        expected_networks.add(network_name_for_session(session_id))

    containers = _checked_lines(
        run(["ps", "-a", "--format", "{{.Names}}"]),
        "ps-a",
    )
    volumes = _checked_lines(
        run(["volume", "ls", "--format", "{{.Name}}"]),
        "volume-ls",
    )
    networks = _checked_lines(
        run(["network", "ls", "--format", "{{.Name}}"]),
        "network-ls",
    )

    owned_containers = {
        name for name in containers
        if name.startswith(CONTAINER_PREFIX) or name.startswith(PROXY_PREFIX)
    }
    owned_volumes = {name for name in volumes if name.startswith(VOLUME_PREFIX)}
    owned_networks = {
        name for name in networks if name.startswith(INTERNAL_NETWORK_PREFIX)
    }

    return RuntimeCleanlinessReport(
        unexpected_containers=tuple(sorted(owned_containers - expected_containers)),
        unexpected_volumes=tuple(sorted(owned_volumes - expected_volumes)),
        unexpected_networks=tuple(sorted(owned_networks - expected_networks)),
    )
