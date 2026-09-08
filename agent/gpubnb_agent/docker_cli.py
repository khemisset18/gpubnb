"""Resolve the Docker CLI without assuming the service account inherits a user PATH.

Docker Desktop on Windows may be installed per-user or for all users. The GPUbnb
Agent can run as a Windows service, so `shutil.which("docker")` alone is not a
reliable discovery mechanism: a service can have a much smaller PATH than the
interactive account that installed Docker Desktop.

Keep the resolver deliberately narrow. It honors an explicit operator override,
then PATH, then only Docker Desktop's documented install roots with the standard
`resources/bin/docker.exe` layout. It never searches arbitrary writable folders.
"""
from __future__ import annotations

import os
import platform
import shutil
from pathlib import Path


DOCKER_ENV = "GPUBNB_DOCKER"


def docker_cli_candidates() -> list[Path]:
    values: list[Path] = []
    explicit = os.environ.get(DOCKER_ENV)
    if explicit:
        values.append(Path(explicit))

    discovered = shutil.which("docker")
    if discovered:
        values.append(Path(discovered))

    if platform.system() == "Windows":
        program_files = os.environ.get("ProgramFiles") or r"C:\Program Files"
        local_app_data = os.environ.get("LOCALAPPDATA")
        values.append(Path(program_files) / "Docker" / "Docker" / "resources" / "bin" / "docker.exe")
        if local_app_data:
            values.append(Path(local_app_data) / "Programs" / "DockerDesktop" / "resources" / "bin" / "docker.exe")

    # Stable order, no duplicate filesystem probes.
    unique: list[Path] = []
    seen: set[str] = set()
    for candidate in values:
        key = os.path.normcase(os.path.abspath(str(candidate)))
        if key not in seen:
            seen.add(key)
            unique.append(candidate)
    return unique


def find_docker_cli() -> str | None:
    for candidate in docker_cli_candidates():
        try:
            if candidate.is_file():
                return str(candidate.resolve())
        except OSError:
            continue
    return None


def docker_command(arguments: list[str]) -> list[str]:
    executable = find_docker_cli()
    if executable is None:
        raise FileNotFoundError("docker_cli_not_found")
    return [executable, *arguments]
