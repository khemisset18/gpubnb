from __future__ import annotations

import re
import unittest
from pathlib import Path

import gpubnb_agent


class AgentVersionConsistencyTests(unittest.TestCase):
    def test_runtime_and_package_versions_match(self) -> None:
        pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
        match = re.search(
            r'^version\s*=\s*"([^"]+)"\s*$',
            pyproject.read_text(encoding="utf-8"),
            re.MULTILINE,
        )
        self.assertIsNotNone(match, "agent/pyproject.toml has no project version")
        self.assertEqual(match.group(1), gpubnb_agent.__version__)
        self.assertEqual(gpubnb_agent.__version__, "0.6.1")


if __name__ == "__main__":
    unittest.main()
