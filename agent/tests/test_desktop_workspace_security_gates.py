"""Read-only source-contract tests for the four unqualified desktop workspaces.

These tests deliberately do not launch Docker, contact production, or enable
bookings. They guard against accidental exposure before physical qualification.
Run: python -m unittest discover -s agent/tests -p 'test_desktop_workspace_security_gates.py' -v
"""
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
SLUGS = ("cloud-desktop", "creator", "cad", "gaming")


class DesktopWorkspaceSecurityGates(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.gateway = (ROOT / "agent/gpubnb_agent/workspace_gateway.py").read_text(encoding="utf-8")
        cls.catalog = (ROOT / "apps/api/src/machine-workspace-catalog.ts").read_text(encoding="utf-8")
        cls.manifests = (ROOT / "apps/api/src/workspace-manifests.ts").read_text(encoding="utf-8")
        cls.platform = (ROOT / "agent/gpubnb_agent/platform_info.py").read_text(encoding="utf-8")

    def test_all_four_remain_non_bookable(self):
        match = re.search(r"export const executableWorkspaceSlugs\s*=\s*\[([^\]]*)\]", self.catalog)
        self.assertIsNotNone(match, "Cannot inspect booking allowlist; fail closed")
        allowed = re.findall(r"['\"]([^'\"]+)['\"]", match.group(1))
        for slug in SLUGS:
            with self.subTest(slug=slug):
                self.assertNotIn(slug, allowed)

    def test_all_four_remain_outside_gateway_launch_allowlist(self):
        match = re.search(r"GATEWAY_WORKSPACE_SLUGS\s*=\s*frozenset\(\{([^}]*)\}\)", self.gateway)
        self.assertIsNotNone(match, "Cannot inspect gateway allowlist; fail closed")
        allowed = re.findall(r"['\"]([^'\"]+)['\"]", match.group(1))
        for slug in SLUGS:
            with self.subTest(slug=slug):
                self.assertNotIn(slug, allowed)

    def test_gpu_passthrough_prepared_for_each_desktop(self):
        match = re.search(r"GPU_ATTACHED_WORKSPACE_SLUGS\s*=\s*frozenset\(\{([^}]*)\}\)", self.gateway)
        self.assertIsNotNone(match)
        attached = re.findall(r"['\"]([^'\"]+)['\"]", match.group(1))
        for slug in SLUGS:
            with self.subTest(slug=slug):
                self.assertIn(slug, attached)

    def test_desktop_gpu_capability_is_not_inferred_from_cuda(self):
        self.assertIn('def desktop_gpu_rendering_available()', self.platform)
        self.assertIn('Path("/dev/dri").glob("render*")', self.platform)
        self.assertIn('docker_info()["nvidiaRuntime"]', self.platform)
        for slug in SLUGS:
            with self.subTest(slug=slug):
                entry = next((line for line in self.manifests.splitlines() if "slug:'" + slug + "'" in line), "")
                self.assertIn("desktopGpuRendering:true", entry)
                self.assertIn("nvidiaRuntime:true", entry)

    def test_base_images_are_digest_pinned_and_not_marked_working(self):
        bases = []
        for slug in SLUGS:
            with self.subTest(slug=slug):
                dockerfile = (ROOT / "workspaces" / slug / "Dockerfile").read_text(encoding="utf-8")
                match = re.search(r"^FROM\s+(linuxserver/webtop@sha256:[a-f0-9]{64})\s*$", dockerfile, re.M)
                self.assertIsNotNone(match, "Desktop base must remain digest-pinned")
                bases.append(match.group(1))
                note = (ROOT / "workspaces" / slug / "NOT_YET_WORKING.md").read_text(encoding="utf-8")
                self.assertIn("NOT", note)
        self.assertEqual(len(set(bases)), 1, "Shared base must be reviewed as one family")

    def test_healthchecks_do_not_pretend_to_prove_gpu(self):
        for slug in SLUGS:
            with self.subTest(slug=slug):
                script = (ROOT / "workspaces" / slug / "healthcheck.sh").read_text(encoding="utf-8")
                self.assertIn("127.0.0.1:3000", script)
                self.assertIn("Does NOT", script)
                self.assertNotIn("exit 0 # GPU", script)

    def test_preflight_remains_explicitly_non_authorizing(self):
        script = (ROOT / "scripts/preflight-linux-gpu-desktop.sh").read_text(encoding="utf-8")
        self.assertIn("This does NOT yet prove", script)
        self.assertIn("llvmpipe", script)
        self.assertIn("NVIDIA_DRIVER_CAPABILITIES", script)


if __name__ == "__main__":
    unittest.main()
