import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
TAURI = ROOT / "apps/host-desktop/src-tauri"


class HostInstallerBundleContractTests(unittest.TestCase):
    def test_preflight_configuration_embeds_stage4_and_keeps_base_sidecars(self):
        base = json.loads((TAURI / "tauri.sidecar.conf.json").read_text(encoding="utf-8"))
        preflight = json.loads((TAURI / "tauri.preflight.conf.json").read_text(encoding="utf-8"))

        self.assertEqual(
            base["bundle"]["externalBin"],
            ["binaries/gpubnb-agent", "binaries/gpubnb-host-tunnel"],
        )
        self.assertEqual(preflight["bundle"]["externalBin"], base["bundle"]["externalBin"])
        self.assertEqual(
            preflight["bundle"]["resources"],
            ["stage4/*"],
        )
        self.assertEqual(
            preflight["bundle"]["windows"]["nsis"]["installerHooks"],
            "./windows/installer-hooks.preflight.nsh",
        )

    def test_preflight_installer_cannot_install_unsigned_payload_outside_github_ci(self):
        hooks = (TAURI / "windows/installer-hooks.nsh").read_text(encoding="utf-8")
        wrapper = (TAURI / "windows/installer-hooks.preflight.nsh").read_text(encoding="utf-8")
        helper = (TAURI / "installer/install-stage4-payload.ps1").read_text(encoding="utf-8")

        self.assertIn("!define GPUBNB_PREFLIGHT_INSTALLER", wrapper)
        self.assertIn('File /oname=install-stage4-payload.ps1 "${__FILEDIR__}\\\\..\\\\installer\\\\install-stage4-payload.ps1"', hooks)
        self.assertIn('SetOutPath "$INSTDIR\\\\resources\\\\installer"', hooks)
        self.assertIn('Delete "$INSTDIR\\\\resources\\\\installer\\\\install-stage4-payload.ps1"', hooks)
        self.assertIn("GPUbnbRequireDisposableCiRunner", hooks)
        self.assertIn("GPUbnbAssertNativeWorkersStopped", hooks)
        self.assertIn("$env:GITHUB_ACTIONS -cne 'true'", helper)
        self.assertIn("$env:RUNNER_ENVIRONMENT -cne 'github-hosted'", helper)
        self.assertIn("$manifest.installable -cne $false", helper)
        self.assertIn("$manifest.iddDriverIncluded -cne $false", helper)
        self.assertIn("$manifest.publicBookabilityEnabled -cne $false", helper)
        self.assertIn("$signature.Status -ne 'NotSigned'", helper)
        self.assertIn("host_native_preflight_update_requires_reviewed_rollback", helper)
        self.assertIn("host_native_preflight_remove_hash_mismatch", helper)
        self.assertIn("host_native_install_acl_broad_write_forbidden", helper)
        self.assertNotRegex(helper, r"(?i)Start-Process.*(?:stream|worker)|pnputil|InstallDriver")

    def test_ci_bundle_smoke_requires_four_file_unsigned_policy_and_uninstall_cleanup(self):
        workflow = (ROOT / ".github/workflows/host-windows-preflight.yml").read_text(encoding="utf-8")

        for required in (
            "build-stage4-unsigned-package.ps1",
            "stage4.manifest.json",
            "signatureStatus -cne 'unsigned'",
            "installable -cne $false",
            "iddDriverIncluded -cne $false",
            "--config src-tauri/tauri.preflight.conf.json",
            "Join-Path $out 'gpubnb-agent.exe'",
            "Stage verified Agent sidecar",
            "The verified Stage 4 Agent was not staged.",
            "gpubnb-windows-stream.exe",
            "gpubnb-windows-worker.exe",
            "GPUbnbWindowsMedia.dll",
            "gpubnb-host-windows-preflight-noninstallable-",
            "The uninstaller left native component",
        ):
            with self.subTest(required=required):
                self.assertIn(required, workflow)

        self.assertIn("NOT INSTALLABLE FOR PC1", workflow)
        self.assertIn("signed IddCx driver is not included", workflow)
        self.assertIn("feat/windows-host-unified-installer-*", workflow)
        self.assertEqual(workflow.count("--config"), 1)


if __name__ == "__main__":
    unittest.main()
