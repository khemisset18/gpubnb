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
            "reviewedSourceBuiltSignedOrInstalled",
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

    def test_workflow_pins_observed_render_sha_and_current_review_head(self) -> None:
        import re
        workflow = (
            Path(__file__).resolve().parents[2]
            / ".github/workflows/stage4-private-backend-source-delta.yml"
        ).read_text(encoding="utf-8")
        pins = re.findall(r"--private-render-commit\s+([^\s\\]+)", workflow)
        self.assertEqual(pins, ["23a7a2950ecf365866f3531ddbf76920d9fcb295"])
        self.assertIn("REVIEWED_SHA: " + "$"+"{{ github.event.pull_request.head.sha || github.sha }}", workflow)
        self.assertIn('--pc1-candidate-commit "$REVIEWED_SHA"', workflow)
        self.assertIn("--expect-api-source-changed", workflow)
        self.assertNotIn("--expect-api-source-unchanged", workflow)
        self.assertIn("--expect-web-source-changed", workflow)
        self.assertIn("--expect-web-source-unchanged", workflow)
        self.assertIn('CANDIDATE_BRANCH" = "feat/gaming-end-to-end-20261122"', workflow)
        self.assertIn('CANDIDATE_BRANCH" = "feat/gaming-workspace-rebuild-20261123"', workflow)
        self.assertNotIn("32ffdc72ec7041310c4b07e286ac4c4c2818906c", workflow)
        self.assertEqual(len(pins[0]), 40)

    def test_identical_source_pins_are_valid_and_do_not_hide_changes(self) -> None:
        self.assertEqual(source_delta(self.repo, self.base, self.base), [])
        report = make_report(self.repo, self.base, self.base)
        self.assertTrue(report["apiRuntimeInputsIdenticalAtSource"])
        self.assertTrue(report["webAssetsIdenticalAtSource"])
        self.assertEqual(report["changedPathCount"], 0)

    def test_cli_accepts_identical_pins_with_unchanged_expectations(self) -> None:
        script = Path(__file__).resolve().parents[1] / "stage4_private_backend_delta.py"
        result = subprocess.run(
            [
                sys.executable, str(script), "--repo", str(self.repo),
                "--private-render-commit", self.base,
                "--pc1-candidate-commit", self.base,
                "--expect-api-source-unchanged",
                "--expect-web-source-unchanged",
            ],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_cli_detects_api_or_browser_changes_against_live_source(self) -> None:
        script = Path(__file__).resolve().parents[1] / "stage4_private_backend_delta.py"
        for changed_path, expected in (
            ("apps/api/src/server.ts", "stage4_delta_api_runtime_inputs_changed_review_required"),
            ("apps/web/index.js", "stage4_delta_web_source_changed_review_required"),
        ):
            with self.subTest(changed_path=changed_path):
                self._write(changed_path, "changed source\\n")
                candidate = self._commit("changed " + changed_path)
                result = subprocess.run(
                    [
                        sys.executable, str(script), "--repo", str(self.repo),
                        "--private-render-commit", self.base,
                        "--pc1-candidate-commit", candidate,
                        "--expect-api-source-unchanged",
                        "--expect-web-source-unchanged",
                    ],
                    capture_output=True, text=True, check=False,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(expected, result.stderr)
                self._git("reset", "--hard", self.base)

    def test_cli_rejects_contradictory_expectations(self) -> None:
        script = Path(__file__).resolve().parents[1] / "stage4_private_backend_delta.py"
        for flags, expected in (
            (("--expect-api-source-changed", "--expect-api-source-unchanged"), "stage4_delta_conflicting_api_expectations"),
            (("--expect-web-source-changed", "--expect-web-source-unchanged"), "stage4_delta_conflicting_web_expectations"),
        ):
            with self.subTest(flags=flags):
                result = subprocess.run(
                    [
                        sys.executable, str(script), "--repo", str(self.repo),
                        "--private-render-commit", self.base,
                        "--pc1-candidate-commit", self.base, *flags,
                    ],
                    capture_output=True, text=True, check=False,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(expected, result.stderr)

    def test_cli_reports_expected_api_drift_with_unchanged_browser(self) -> None:
        self._write("apps/api/src/server.ts", "export const protocol = 2;\\n")
        head = self._commit("candidate API changed but browser did not")
        script = Path(__file__).resolve().parents[1] / "stage4_private_backend_delta.py"
        result = subprocess.run(
            [
                sys.executable, str(script), "--repo", str(self.repo),
                "--private-render-commit", self.base,
                "--pc1-candidate-commit", head,
                "--expect-api-source-changed",
                "--expect-web-source-unchanged",
            ],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('"apiRuntimeInputsIdenticalAtSource": false', result.stdout)
        self.assertIn('"webAssetsIdenticalAtSource": true', result.stdout)
        self.assertIn('"renderRunningImageCommitIndependentlyAttested": false', result.stdout)

    def test_wrong_pins_and_non_ancestor_fail_closed(self) -> None:
        self._write("apps/web/index.js", "changed\n")
        head = self._commit("later")
        for base, candidate in (
            ("f" * 40, head),
            (self.base.upper(), head),
            (self.base, "0" * 40),
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
