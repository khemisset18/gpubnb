"""Adversarial tests for Stage 4 pinned private backend source-delta evidence."""
from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from stage4_private_backend_delta import analyze_source_delta, make_report, source_delta


class Stage4PrivateBackendDeltaTests(unittest.TestCase):
    def _git(self, *args: str) -> str:
        result = subprocess.run(
            ["git", "-C", str(self.repo), *args],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )
        return result.stdout.decode("utf-8").strip()

    def _write(self, name: str, content: str) -> None:
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def _commit(self, message: str) -> str:
        self._git("add", "-A")
        self._git("commit", "-qm", message)
        return self._git("rev-parse", "HEAD")

    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory(prefix="stage4-delta-")
        self.repo = Path(self.directory.name)
        self._git("init", "-q")
        self._git("config", "user.name", "Stage 4 CI")
        self._git("config", "user.email", "ci@example.invalid")
        self._write("apps/api/Dockerfile", "COPY apps/web /app/web\n")
        self._write("apps/api/src/server.ts", "export const protocol = 1;\n")
        self._write("apps/web/index.js", "console.log('old')\n")
        self._write("agent/runtime.py", "old recovery\n")
        self.base = self._commit("base")

    def tearDown(self) -> None:
        self.directory.cleanup()

    def test_exact_source_diff_api_identical_web_changed_fails_closed(self) -> None:
        self._write("apps/web/index.js", "console.log('new')\n")
        self._write("agent/runtime.py", "new recovery\n")
        head = self._commit("browser and agent")
        report = make_report(self.repo, self.base, head)
        self.assertTrue(report["apiRuntimeInputsIdenticalAtSource"])
        self.assertFalse(report["webAssetsIdenticalAtSource"])
        self.assertFalse(report["agentCodeIdenticalAtSource"])
        self.assertTrue(report["nativeCodeIdenticalAtSource"])
        self.assertEqual(report["changedPathCount"], 2)
        for flag in (
            "renderRunningImageCommitIndependentlyAttested",
            "browserSessionProtocolCompatibilityAttested",
            "signedOwnerCleanupEvidenceReceived",
            "pc1ServiceTransactionalRollbackTested",
            "installationAuthorized",
            "quarantineModified",
            "publicBookabilityEnabled",
        ):
            self.assertIs(report[flag], False, flag)

    def test_changed_server_runtime_file_blocks_same_source_claim(self) -> None:
        self._write("apps/api/src/server.ts", "export const protocol = 2;\n")
        head = self._commit("unsafe api change")
        report = make_report(self.repo, self.base, head)
        self.assertFalse(report["apiRuntimeInputsIdenticalAtSource"])
        self.assertIn("apps/api/src/server.ts", report["apiRuntimeInputChanges"])

    def test_changed_dockerfile_is_runtime_change_even_if_web_copy_remains(self) -> None:
        self._write("apps/api/Dockerfile", "FROM node:24\nCOPY apps/web /app/web\n")
        head = self._commit("new runtime")
        report = make_report(self.repo, self.base, head)
        self.assertFalse(report["apiRuntimeInputsIdenticalAtSource"])

    def test_dockerfile_that_omits_browser_inclusion_is_rejected(self) -> None:
        self._write("apps/api/Dockerfile", "FROM node:24\n")
        head = self._commit("missing browser context")
        with self.assertRaisesRegex(ValueError, "web_copy_missing"):
            make_report(self.repo, self.base, head)

    def test_unrelated_tests_do_not_change_runtime_input_classification(self) -> None:
        self._write("apps/api/test/smoke.test.ts", "it('ok')\n")
        head = self._commit("tests only")
        report = make_report(self.repo, self.base, head)
        self.assertTrue(report["apiRuntimeInputsIdenticalAtSource"])
        self.assertTrue(report["webAssetsIdenticalAtSource"])

    def test_wrong_pins_and_non_ancestor_fail_closed(self) -> None:
        self._write("apps/web/index.js", "changed\n")
        head = self._commit("later")
        for base, candidate in (
            ("f" * 40, head),
            (self.base.upper(), head),
            (self.base, "0" * 40),
            (self.base, self.base),
            (head, self.base),
        ):
            with self.subTest(base=base, candidate=candidate):
                with self.assertRaises((ValueError, subprocess.CalledProcessError)):
                    source_delta(self.repo, base, candidate)

    def test_api_sources_and_native_sources_detected_independently(self) -> None:
        report = analyze_source_delta(
            [
                "apps/api/prisma/schema.prisma",
                "apps/api/package-lock.json",
                "apps/web/index.js",
                "native/windows-worker/src/main.rs",
                "agent/runtime.py",
            ]
        )
        self.assertFalse(report["apiRuntimeInputsIdenticalAtSource"])
        self.assertFalse(report["webAssetsIdenticalAtSource"])
        self.assertFalse(report["nativeCodeIdenticalAtSource"])
        self.assertFalse(report["agentCodeIdenticalAtSource"])


if __name__ == "__main__":
    unittest.main()
