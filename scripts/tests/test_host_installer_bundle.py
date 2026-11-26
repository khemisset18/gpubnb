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
        self.assertLess(
            helper.index("if (($rights -band $writeRights) -eq 0) { continue }"),
            helper.index("$rule.IdentityReference.Translate"),
        )
        self.assertNotRegex(helper, r"(?i)Start-Process.*(?:stream|worker)|pnputil|InstallDriver")

    def test_preflight_runs_on_integration_contract_changes(self):
        workflow = (ROOT / ".github/workflows/host-windows-preflight.yml").read_text(encoding="utf-8")
        pull_request = workflow.split("  pull_request:\n", 1)[1].split("  workflow_dispatch:", 1)[0]
        for path in (
            "apps/api/**",
            "apps/web/**",
            "scripts/stage4_private_backend_delta.py",
            "scripts/tests/test_stage4_private_backend_delta.py",
            ".github/workflows/stage4-private-backend-source-delta.yml",
            "apps/host-desktop/**",
            "native/windows-media/**",
            "native/windows-worker/**",
            "native/windows-stream-helper/**",
        ):
            with self.subTest(path=path):
                self.assertIn(f"      - {path}\n", pull_request)
        self.assertIn("ref: " + "$" + "{{ github.event.pull_request.head.sha || github.sha }}", workflow)
        self.assertIn("persist-credentials: false", workflow)

    def test_signing_handoff_remains_unsigned_and_manual_publisher_is_explicit(self):
        workflow = (ROOT / ".github/workflows/host-windows-preflight.yml").read_text(encoding="utf-8")
        dispatch = workflow.split("  workflow_dispatch:\n", 1)[1].split("\npermissions:", 1)[0]
        self.assertIn("publisher_sha256:", dispatch)
        self.assertIn("required: true", dispatch)
        self.assertNotIn("default:", dispatch)
        self.assertIn("PREFLIGHT_PUBLISHER_SHA256: " + "$" + "{{ inputs.publisher_sha256 || '' }}", workflow)
        self.assertIn("if ($env:PREFLIGHT_EVENT_NAME -ceq 'workflow_dispatch')", workflow)
        self.assertIn("$publisher.Length -ne 64", workflow)
        self.assertIn("$publisher = $env:GPUBNB_PREFLIGHT_BUILD_PUBLISHER", workflow)
        self.assertIn("$manifest.publisherSha256 -cne $publisher", workflow)
        handoff = workflow.split("- name: Prepare exact unsigned signing handoff (not an installer)", 1)[1]
        prepare, upload = handoff.split("- name: Upload unsigned signing handoff", 1)
        for required in (
            "verify-stage4-package.ps1",
            "verify_stage4_package.py verify",
            "host_handoff_expected_unsigned_component",
            "HOST_UNSIGNED_HANDOFF.json",
            "HOST_UNSIGNED_HANDOFF_SHA256",
            "signatureStatus = 'unsigned'",
            "installable = $false",
            "hardwareQualified = $false",
            "publicBookabilityEnabled = $false",
            "DO-NOT-INSTALL.txt",
        ):
            with self.subTest(required=required):
                self.assertIn(required, prepare)
        self.assertNotIn("sign-windows-authenticode.ps1", prepare)
        self.assertNotIn("Start-Process", prepare)
        self.assertIn("if: github.event_name == 'workflow_dispatch'", upload)
        self.assertIn("host-unsigned-signing-handoff-not-installable-", upload)

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
            "Installed manifest or build identities differ from the exact staged payload.",
            "Installed Agent hash differs from the staged manifest or build.",
            "Installed Host tunnel hash differs from the staged build.",
            "The uninstaller left bundled payload file",
            "The uninstaller left the payload helper behind.",
            "Installer bytes changed during the smoke test.",
            "HOST_PREFLIGHT_EVIDENCE.json",
            "hardwareQualified = $false",
            "nativeComponentsVerified = 4",
        ):
            with self.subTest(required=required):
                self.assertIn(required, workflow)

        self.assertIn("NOT INSTALLABLE FOR PC1", workflow)
        self.assertIn("signed IddCx driver is not included", workflow)
        self.assertIn("feat/windows-host-unified-installer-*", workflow)
        self.assertEqual(workflow.count("--config"), 1)


if __name__ == "__main__":
    unittest.main()
