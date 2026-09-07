from __future__ import annotations

import subprocess
import unittest

from gpubnb_agent.runtime_cleanliness import inspect_runtime_cleanliness
from gpubnb_agent.workspace_gateway import (
    names_for_session,
    network_name_for_session,
    proxy_name_for_session,
)


class FakeDocker:
    def __init__(self, *, containers=(), volumes=(), networks=(), fail_on: tuple[str, ...] | None = None):
        self.containers = list(containers)
        self.volumes = list(volumes)
        self.networks = list(networks)
        self.fail_on = fail_on
        self.calls: list[tuple[str, ...]] = []

    def __call__(self, args: list[str]) -> subprocess.CompletedProcess[str]:
        call = tuple(args)
        self.calls.append(call)
        if self.fail_on and call[:len(self.fail_on)] == self.fail_on:
            return subprocess.CompletedProcess(args, 1, stdout="", stderr="docker unavailable")
        if call[:2] == ("ps", "-a"):
            values = self.containers
        elif call[:2] == ("volume", "ls"):
            values = self.volumes
        elif call[:2] == ("network", "ls"):
            values = self.networks
        else:
            raise AssertionError(f"unexpected docker command: {args}")
        return subprocess.CompletedProcess(args, 0, stdout="\n".join(values) + ("\n" if values else ""), stderr="")


class RuntimeCleanlinessTests(unittest.TestCase):
    def test_expected_session_resources_are_clean(self) -> None:
        session_id = "cm1234567890abcdef"
        container, volume = names_for_session(session_id)
        docker = FakeDocker(
            containers=[container, proxy_name_for_session(session_id), "postgres"],
            volumes=[volume, "unrelated-volume"],
            networks=[network_name_for_session(session_id), "bridge", "gpubnb-workspace-gateway"],
        )

        report = inspect_runtime_cleanliness([session_id], docker)

        self.assertTrue(report.clean)
        self.assertEqual(report.unexpected_containers, ())
        self.assertEqual(report.unexpected_volumes, ())
        self.assertEqual(report.unexpected_networks, ())

    def test_orphaned_workspace_proxy_volume_and_network_are_reported(self) -> None:
        expected_id = "cmexpected1234567890"
        orphan_id = "cmorphaned1234567890"
        expected_container, expected_volume = names_for_session(expected_id)
        orphan_container, orphan_volume = names_for_session(orphan_id)
        docker = FakeDocker(
            containers=[
                expected_container,
                proxy_name_for_session(expected_id),
                orphan_container,
                proxy_name_for_session(orphan_id),
            ],
            volumes=[expected_volume, orphan_volume],
            networks=[network_name_for_session(expected_id), network_name_for_session(orphan_id)],
        )

        report = inspect_runtime_cleanliness([expected_id], docker)

        self.assertFalse(report.clean)
        self.assertEqual(
            set(report.unexpected_containers),
            {orphan_container, proxy_name_for_session(orphan_id)},
        )
        self.assertEqual(report.unexpected_volumes, (orphan_volume,))
        self.assertEqual(report.unexpected_networks, (network_name_for_session(orphan_id),))
        payload = report.to_api_payload()
        self.assertEqual(payload["clean"], False)

    def test_empty_expected_set_detects_every_per_session_resource(self) -> None:
        orphan_id = "cmleftover1234567890"
        container, volume = names_for_session(orphan_id)
        docker = FakeDocker(
            containers=[container],
            volumes=[volume],
            networks=[network_name_for_session(orphan_id)],
        )

        report = inspect_runtime_cleanliness([], docker)

        self.assertFalse(report.clean)
        self.assertEqual(report.unexpected_containers, (container,))
        self.assertEqual(report.unexpected_volumes, (volume,))
        self.assertEqual(report.unexpected_networks, (network_name_for_session(orphan_id),))

    def test_non_gpubnb_resources_and_shared_gateway_network_are_ignored(self) -> None:
        docker = FakeDocker(
            containers=["postgres", "redis", "my-app"],
            volumes=["postgres-data"],
            networks=["bridge", "host", "gpubnb-workspace-gateway"],
        )

        report = inspect_runtime_cleanliness([], docker)

        self.assertTrue(report.clean)

    def test_docker_inventory_failure_fails_closed(self) -> None:
        docker = FakeDocker(fail_on=("volume", "ls"))
        with self.assertRaisesRegex(RuntimeError, "runtime_cleanliness_docker_failed"):
            inspect_runtime_cleanliness([], docker)


if __name__ == "__main__":
    unittest.main()
