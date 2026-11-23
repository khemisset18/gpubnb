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
        self.assertNotIn("resources", preflight["bundle"])
        self.assertEqual(
            preflight["bundle"]["windows"]["nsis"]["installerHooks"],
            "./windows/installer-hooks.preflight.nsh",
        )

    def test_preflight_installer_cannot_install_unsigned_payload_outside_github_ci(self):
        hooks = (TAURI / "windows/installer-hooks.nsh").read_text(encoding="utf-8")
        wrapper = (TAURI / "windows/installer-hooks.preflight.nsh").read_text(encoding="utf-8")
        helper = (TAURI / "installer/install-stage4-payload.ps1").read_text(encoding="utf-8")

        self.assertIn("!define GPUBNB_PREFLIGHT_INSTALLER", wrapper)
        self.assertIn(r'File /oname=install-stage4-payload.ps1 "${__FILEDIR__}\..\..\..\..\apps\host-desktop\src-tauri\installer\install-stage4-payload.ps1"', hooks)
        self.assertIn(r'SetOutPath "$INSTDIR\resources\installer"', hooks)
        self.assertIn(r'Delete "$INSTDIR\resources\installer\install-stage4-payload.ps1"', hooks)
        stage4_source_root = r'${__FILEDIR__}\..\..\..\..\apps\host-desktop\src-tauri\stage4'
        stage4_files = (
            "gpubnb-windows-stream.exe",
            "gpubnb-windows-worker.exe",
            "GPUbnbWindowsMedia.dll",
            "build-identities.json",
            "stage4.manifest.json",
        )
        for name in stage4_files:
            with self.subTest(stage4_file=name):
                self.assertIn(f'File "{stage4_source_root}\\{name}"', hooks)
                self.assertIn(f'Delete "$INSTDIR\\resources\\stage4\\{name}"', hooks)
        self.assertIn(r'RMDir "$INSTDIR\resources\stage4"', hooks)
        self.assertIn("GPUbnbRequireDisposableCiRunner", hooks)
        self.assertIn("GPUbnbAssertNativeWorkersStopped", hooks)
        self.assertIn("$env:GITHUB_ACTIONS -cne 'true'", helper)
        self.assertIn("$env:RUNNER_ENVIRONMENT -cne 'github-hosted'", helper)
        self.assertIn("function Get-Sha256Hex", helper)
        self.assertIn("$algorithm.ComputeHash($stream)", helper)
        self.assertNotIn("Get-FileHash", helper)
        self.assertIn("X509Certificate2]::CreateFromSignedFile($Path)", helper)
        self.assertNotIn("Get-AuthenticodeSignature", helper)
        self.assertIn("[IO.Directory]::GetAccessControl($Path)", helper)
        self.assertIn("[Security.AccessControl.FileSystemRights]::WriteData", helper)
        self.assertIn("[Security.AccessControl.FileSystemRights]::CreateDirectories", helper)
        self.assertIn("[Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles", helper)
        self.assertNotIn("[Security.AccessControl.FileSystemRights]::FullControl", helper)
        self.assertNotIn("[Security.AccessControl.FileSystemRights]::Modify", helper)
        self.assertNotIn("Get-Acl", helper)
        self.assertIn("$manifest.installable -cne $false", helper)
        self.assertIn("$manifest.iddDriverIncluded -cne $false", helper)
        self.assertIn("$manifest.publicBookabilityEnabled -cne $false", helper)
        self.assertIn("Test-HasEmbeddedAuthenticodeSignature", helper)
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
