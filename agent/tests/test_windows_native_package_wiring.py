"""Regression guard for the Windows-native runtime package wiring."""
from __future__ import annotations

from pathlib import Path
import unittest


class WindowsNativePackageWiringTests(unittest.TestCase):
    def test_runtime_bootstrap_installs_v10_after_v9(self) -> None:
        source = (
            Path(__file__).resolve().parents[1]
            / "gpubnb_agent"
            / "__init__.py"
        ).read_text(encoding="utf-8")

        v9_import = source.index(
            "from .workspace_gateway_v9 import install as install_workspace_gateway_v9"
        )
        v9_call = source.index("install_workspace_gateway_v9()", v9_import)
        v10_import = source.index(
            "from .workspace_gateway_v10 import install as install_workspace_gateway_v10"
        )
        v10_call = source.index("install_workspace_gateway_v10()", v10_import)
        installed_flag = source.index("_runtime_layers_installed = True", v10_call)

        self.assertLess(v9_call, v10_import)
        self.assertLess(v10_import, v10_call)
        self.assertLess(v10_call, installed_flag)


if __name__ == "__main__":
    unittest.main()
