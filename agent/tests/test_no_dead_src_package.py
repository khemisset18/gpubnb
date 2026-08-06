"""C18: agent/src, agent/__init__.py and agent/setup.py were a second, broken,
never-installed duplicate of the real gpubnb_agent package (agent/__init__.py
imported .src.api, which did not exist — ModuleNotFoundError on any use).
pyproject.toml only ever declared packages = ["gpubnb_agent"]; nothing else in
the repo referenced the dead files. Guards against them quietly coming back.
"""
import unittest
from pathlib import Path

AGENT_ROOT = Path(__file__).resolve().parent.parent


class NoDeadSourcePackageTests(unittest.TestCase):
    def test_dead_src_package_and_wrappers_stay_removed(self):
        for stale in ("src", "__init__.py", "setup.py"):
            path = AGENT_ROOT / stale
            self.assertFalse(path.exists(), f"{path} should not exist (dead duplicate package)")

    def test_real_package_is_still_the_only_one_declared(self):
        pyproject = (AGENT_ROOT / "pyproject.toml").read_text(encoding="utf-8")
        self.assertIn('packages = ["gpubnb_agent"]', pyproject)


if __name__ == "__main__":
    unittest.main()
