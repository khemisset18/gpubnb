"""Guards the real agent daemon's entrypoint against a silent regression.

`agent/gpubnb_agent/__init__.py` layers v2 -> v3 -> v4 -> v5 -> v6 onto the
base `workspace_gateway.GatewaySupervisor` by monkey-patching the module-level
name at package-import time (each `install()` does
`legacy.GatewaySupervisor = GatewaySupervisor`). `run_workspace_gateway_forever()`
(the function `cli.py`'s real daemon actually calls) resolves
`GatewaySupervisor` late, at call time.

The final wired class must therefore be v6 while retaining v5's exact-leased-
GPU-UUID/resource-scoped behavior and every earlier transport/security layer.
These tests prove the package wiring itself, not just each layer in isolation.
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
            "workspace_gateway.GatewaySupervisor must resolve to the final v6 "
            "supervisor by package import time; otherwise the real daemon can "
            "silently lose the bounded concurrent WebSocket-open scheduler.",
        )

    def test_the_resolved_class_preserves_every_qualified_parent_layer(self) -> None:
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
        self.assertTrue(issubclass(resolved, workspace_gateway_v6.GatewaySupervisor))
        self.assertTrue(issubclass(resolved, workspace_gateway_v5.GatewaySupervisor))
        self.assertTrue(issubclass(resolved, workspace_gateway_v4.GatewaySupervisor))
        self.assertTrue(issubclass(resolved, workspace_gateway_v3.GatewaySupervisor))
        self.assertTrue(issubclass(resolved, workspace_gateway_v2.GatewaySupervisor))


if __name__ == "__main__":
    unittest.main()
