from __future__ import annotations

import unittest

from gpubnb_agent.windows_native_private_console import selected_capture_backend


COMMIT = "f664a07ec500c57bf9a508838f51b7c0305ba92d"


def desired(**overrides):
    value = {
        "runtimeBackend": "WINDOWS_NATIVE",
        "workspaceSlug": "cloud-desktop",
        "captureBackend": "console-dedicated",
        "consoleAgentCommit": COMMIT,
    }
    value.update(overrides)
    return value


class PrivateConsolePolicyTests(unittest.TestCase):
    def test_legacy_absent_marker_stays_iddcx(self):
        self.assertEqual(selected_capture_backend(
            {"runtimeBackend": "WINDOWS_NATIVE", "workspaceSlug": "cloud-desktop"},
            local_opt_in=True, build_commit=COMMIT,
        ), "iddcx")

    def test_console_requires_both_server_pin_and_local_opt_in(self):
        self.assertEqual(selected_capture_backend(
            desired(), local_opt_in=True, build_commit=COMMIT,
        ), "console-dedicated")
        with self.assertRaisesRegex(RuntimeError, "native_console_local_opt_in_required"):
            selected_capture_backend(desired(), local_opt_in=False, build_commit=COMMIT)

    def test_wrong_commit_or_malformed_pin_never_select_console(self):
        for pin in (None, "", COMMIT.upper(), "a" * 40, "f664a07", 123):
            with self.subTest(pin=pin), self.assertRaisesRegex(
                RuntimeError, "native_console_release_mismatch"
            ):
                selected_capture_backend(
                    desired(consoleAgentCommit=pin),
                    local_opt_in=True, build_commit=COMMIT,
                )

    def test_wrong_backend_workspace_or_runtime_fails_closed(self):
        scenarios = [
            ({"captureBackend": "console-authorization-invalid"}, "native_capture_backend_unsupported"),
            ({"captureBackend": "unknown"}, "native_capture_backend_unsupported"),
            ({"workspaceSlug": "gaming"}, "native_console_workspace_invalid"),
            ({"runtimeBackend": "CONTAINER"}, "native_console_runtime_backend_invalid"),
            ({"consoleAgentCommit": None}, "native_console_release_mismatch"),
        ]
        for overrides, failure in scenarios:
            with self.subTest(overrides=overrides), self.assertRaisesRegex(RuntimeError, failure):
                selected_capture_backend(
                    desired(**overrides), local_opt_in=True, build_commit=COMMIT,
                )

    def test_legacy_does_not_accept_stray_console_pin(self):
        for backend in (None, "iddcx"):
            with self.subTest(backend=backend), self.assertRaisesRegex(
                RuntimeError, "native_console_authority_malformed"
            ):
                selected_capture_backend(
                    {"captureBackend": backend, "consoleAgentCommit": COMMIT},
                    local_opt_in=True, build_commit=COMMIT,
                )
