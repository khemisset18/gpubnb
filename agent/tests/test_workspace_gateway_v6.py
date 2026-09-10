from __future__ import annotations

import unittest

from gpubnb_agent.workspace_gateway_v6 import (
    GATEWAY_PROTOCOL_VERSION,
    with_gateway_protocol_capability,
)


class GatewayProtocolCapabilityTests(unittest.TestCase):
    def test_exact_register_request_advertises_v2_without_mutating_input(self) -> None:
        original = {
            "machineId": "machine-1",
            "runtimeId": "runtime-123",
            "localPort": 41234,
        }

        enriched = with_gateway_protocol_capability(
            "/agent/workspace-gateway/session-1/register",
            "POST",
            original,
        )

        self.assertIsNot(enriched, original)
        self.assertEqual(original.get("gatewayProtocolVersion"), None)
        self.assertEqual(enriched.get("gatewayProtocolVersion"), GATEWAY_PROTOCOL_VERSION)
        self.assertEqual(GATEWAY_PROTOCOL_VERSION, 2)

    def test_unrelated_signed_bodies_are_unchanged(self) -> None:
        body = {"machineId": "machine-1", "cleaned": True}
        self.assertIs(
            with_gateway_protocol_capability(
                "/agent/workspace-gateway/session-1/stopped",
                "POST",
                body,
            ),
            body,
        )
        self.assertIs(
            with_gateway_protocol_capability(
                "/agent/workspace-gateway/session-1/register",
                "GET",
                body,
            ),
            body,
        )

    def test_malformed_or_ambiguous_register_paths_are_not_augmented(self) -> None:
        body = {"machineId": "machine-1"}
        for path in (
            "/workspace-gateway/session-1/register",
            "/agent/workspace-gateway//register",
            "/agent/workspace-gateway/session-1/register/extra",
            "/agent/workspace-gateway/session-1/not-register",
        ):
            with self.subTest(path=path):
                self.assertIs(with_gateway_protocol_capability(path, "POST", body), body)


if __name__ == "__main__":
    unittest.main()
