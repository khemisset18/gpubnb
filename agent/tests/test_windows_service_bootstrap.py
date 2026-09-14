from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import gpubnb_agent
from gpubnb_agent import entrypoint


class WindowsServiceBootstrapTests(unittest.TestCase):
    def test_hidden_service_mode_is_detected_without_platform_state(self) -> None:
        argv = ["gpubnb-agent.exe", "_service"]
        self.assertTrue(gpubnb_agent._service_bootstrap_requested(argv))
        self.assertTrue(entrypoint._service_bootstrap_requested(argv))
        self.assertFalse(gpubnb_agent._service_bootstrap_requested(["gpubnb-agent.exe", "status"]))
        self.assertFalse(entrypoint._service_bootstrap_requested(["gpubnb-agent.exe", "status"]))

    def test_package_init_defers_heavy_runtime_layers_for_service_bootstrap(self) -> None:
        package_init = Path(gpubnb_agent.__file__).resolve()
        spec = importlib.util.spec_from_file_location(
            "gpubnb_agent_bootstrap_probe",
            package_init,
            submodule_search_locations=[str(package_init.parent)],
        )
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)

        with patch.object(sys, "argv", ["gpubnb-agent.exe", "_service"]):
            spec.loader.exec_module(module)

        self.assertFalse(module._runtime_layers_installed)

    def test_entrypoint_dispatches_service_before_process_runtime_install(self) -> None:
        with (
            patch.object(entrypoint, "_service_bootstrap_requested", return_value=True),
            patch("gpubnb_agent.windows_service.dispatch_service", return_value=17) as dispatch,
            patch.object(entrypoint, "install_process_runtime") as install_runtime,
        ):
            result = entrypoint.main()

        self.assertEqual(result, 17)
        dispatch.assert_called_once_with()
        install_runtime.assert_not_called()


if __name__ == "__main__":
    unittest.main()
