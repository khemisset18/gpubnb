"""Guards the real agent daemon's entrypoint against a silent wiring regression.

`agent/gpubnb_agent/__init__.py` installs the Developer Workspace layers in order
(v2 -> v3 -> v4 -> v5), then the stale-claim recovery layer, then v6. Every
`install()` replaces the module-level `workspace_gateway.GatewaySupervisor`.
`run_workspace_gateway_forever()` resolves that name late, at call time, so the
class wired by package import is the class the real service actually runs.

This matters for security and correctness: v5 owns exact leased-GPU binding and
post-launch verification, the recovery layer keeps stale local rental claims
fail-closed, and v6 adds the signed gateway protocol-v2 capability used to keep
the renter browser handshake behind real upstream code-server readiness.
Testing the leaf modules independently would not catch a reordered or missing
install() call, so these assertions cover the package wiring itself.
"""
from __future__ import annotations

import unittest


class AgentPackageWiringTests(unittest.TestCase):
    def test_real_daemon_entrypoint_resolves_to_the_latest_gateway_supervisor(self) -> None:
        import gpubnb_agent  # noqa: F401 - triggers __init__.py's install() chain
        from gpubnb_agent import workspace_gateway, workspace_gateway_v6

        self.assertIs(
            workspace_gateway.GatewaySupervisor,
            workspace_gateway_v6.GatewaySupervisor,
            "workspace_gateway.GatewaySupervisor must be monkey-patched to "
            "workspace_gateway_v6.GatewaySupervisor by package import time - "
            "otherwise the real daemon silently loses the latest signed "
            "gateway-handshake capability and may also bypass behavior inherited "
            "from the v5 exact-leased-GPU and recovery layers.",
        )

    def test_the_resolved_class_preserves_the_qualified_transport_and_gpu_layers(self) -> None:
        import gpubnb_agent  # noqa: F401
        from gpubnb_agent import (
            workspace_gateway,
            workspace_gateway_v2,
            workspace_gateway_v3,
            workspace_gateway_v4,
            workspace_gateway_v5,
            workspace_gateway_v6,
        )

        resolved = workspace_gateway.GatewaySupervisor
        self.assertIs(resolved, workspace_gateway_v6.GatewaySupervisor)
        # v6 snapshots and subclasses the fully-installed supervisor that existed
        # immediately before it. These assertions prove the exact-GPU v5 layer and
        # every hardened transport layer below it remain in the real daemon MRO.
        self.assertTrue(issubclass(resolved, workspace_gateway_v5.GatewaySupervisor))
        self.assertTrue(issubclass(resolved, workspace_gateway_v4.GatewaySupervisor))
        self.assertTrue(issubclass(resolved, workspace_gateway_v3.GatewaySupervisor))
        self.assertTrue(issubclass(resolved, workspace_gateway_v2.GatewaySupervisor))


if __name__ == "__main__":
    unittest.main()
