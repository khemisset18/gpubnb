"""Guards the real agent daemon's entrypoint against a silent regression.

`agent/gpubnb_agent/__init__.py` layers v2 -> v3 -> v4 -> v5 onto the base
`workspace_gateway.GatewaySupervisor` by monkey-patching the module-level
name at package-import time (each `install()` does
`legacy.GatewaySupervisor = GatewaySupervisor`). `run_workspace_gateway_forever()`
(the function `cli.py`'s real daemon actually calls) resolves `GatewaySupervisor`
late, at call time - so it only picks up v5's exact-leased-GPU-UUID binding,
post-launch verification, and hardened HTTP/WS transport because this chain
ran first. Every other test in this suite imports `workspace_gateway_v5`
directly and would stay green even if this wiring silently broke (e.g. a
reordered import, a deleted `install()` call) - on a real multi-GPU host
that would mean every workspace silently falls back to `--gpus=device=0`
instead of the actually-leased GPU. This test is the only one that proves
the wiring itself, not just each layer's own logic in isolation.
"""
from __future__ import annotations

import unittest


class AgentPackageWiringTests(unittest.TestCase):
    def test_real_daemon_entrypoint_resolves_to_the_latest_gateway_supervisor(self) -> None:
        import gpubnb_agent  # noqa: F401 - triggers __init__.py's install() chain
        from gpubnb_agent import workspace_gateway, workspace_gateway_v5

        self.assertIs(
            workspace_gateway.GatewaySupervisor,
            workspace_gateway_v5.GatewaySupervisor,
            "workspace_gateway.GatewaySupervisor must be monkey-patched to "
            "workspace_gateway_v5.GatewaySupervisor by package import time - "
            "otherwise the real agent daemon (run_workspace_gateway_forever, "
            "which resolves this name late) silently runs the base class "
            "instead, losing exact-leased-GPU-UUID binding for every "
            "GPU-attached workspace.",
        )

    def test_the_resolved_class_is_a_real_subclass_not_a_coincidental_alias(self) -> None:
        import gpubnb_agent  # noqa: F401
        from gpubnb_agent import workspace_gateway, workspace_gateway_v4, workspace_gateway_v3, workspace_gateway_v2

        # Confirms the whole chain (not just the last link) is intact: v5
        # subclasses v4 subclasses v3 subclasses v2 subclasses the base
        # class, so the wired class must be an instance of every layer.
        self.assertTrue(issubclass(workspace_gateway.GatewaySupervisor, workspace_gateway_v4.GatewaySupervisor))
        self.assertTrue(issubclass(workspace_gateway.GatewaySupervisor, workspace_gateway_v3.GatewaySupervisor))
        self.assertTrue(issubclass(workspace_gateway.GatewaySupervisor, workspace_gateway_v2.GatewaySupervisor))


if __name__ == "__main__":
    unittest.main()
