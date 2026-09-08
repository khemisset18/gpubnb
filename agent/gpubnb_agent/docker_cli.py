"""Resolve the Docker CLI without assuming a Windows service inherits a user PATH.

Docker Desktop on Windows may be installed per-user or for all users. GPUbnb can
run its Agent as a Windows service, whose PATH is not the interactive user's PATH.
The resolver therefore checks only an explicit override, PATH, and Docker
Desktop's supported installation roots with the standard resources/bin layout.
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


def ensure_docker_on_path() -> str | None:
    """Make a found Docker CLI visible to every subprocess launched by the Agent."""
    executable = find_docker_cli()
    if executable is None:
        return None
    parent = str(Path(executable).parent)
    entries = [entry for entry in os.environ.get("PATH", "").split(os.pathsep) if entry]
    normalized_parent = os.path.normcase(os.path.abspath(parent))
    if not any(os.path.normcase(os.path.abspath(entry)) == normalized_parent for entry in entries):
        os.environ["PATH"] = parent + (os.pathsep + os.environ["PATH"] if os.environ.get("PATH") else "")
    return executable


def docker_command(arguments: list[str]) -> list[str]:
    executable = find_docker_cli()
    if executable is None:
        raise FileNotFoundError("docker_cli_not_found")
    return [executable, *arguments]
