"""Offline behavioral tests; never invoke apt, Docker or a release binary."""
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parent
HELPER = ROOT / "focal-kernel-cohort.sh"


class FocalKernelCohortTests(unittest.TestCase):
    def run_shell(self, code):
        return subprocess.run(["bash", "-c", 'source "$1"\n' + code,
                               "test", str(HELPER)], text=True, capture_output=True)

    def test_source_has_no_side_effects(self):
        result = self.run_shell(":")
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))

    def test_requirements_match_target_kunnwon_manifest(self):
        result = self.run_shell('check() { printf "%s_%s_amd64.deb\\n" "$1" "$2"; }\ncheck_focal_kernel_cohort check')
        self.assertEqual(result.returncode, 0, result.stderr)
        packages = result.stdout.splitlines()
        self.assertEqual(len(set(packages)), 5)
        for variant in ("KunNw0n",):
            manifest = (ROOT / f"official-focal-amd64-{variant}.manifest").read_text()
            filenames = {line.split()[1] for line in manifest.splitlines()}
            for package in packages:
                self.assertIn(package, filenames)

    def test_each_failed_check_stops_even_inside_conditional(self):
        # Bash disables errexit in an if-condition: explicit propagation matters.
        for failure in range(1, 6):
            with self.subTest(failure=failure):
                result = self.run_shell(f'''set -euo pipefail
count=0
check() {{ count=$((count + 1)); test "$count" -ne {failure}; }}
if check_focal_kernel_cohort check; then exit 99; fi
printf '%s' "$count"
''')
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, str(failure))

    def test_old_kernel_is_rejected(self):
        result = self.run_shell('check() { test "$2" = "5.4.0.200.196"; }\ncheck_focal_kernel_cohort check')
        self.assertNotEqual(result.returncode, 0)

    def test_official_variants_must_not_be_mixed(self):
        manifests = {}
        for variant in ("KunNw0n", "slightlyskepticalpotat"):
            manifests[variant] = {
                line.split()[1] for line in
                (ROOT / f"official-focal-amd64-{variant}.manifest").read_text().splitlines()
            }
        # Run #33 mixed the older kernel with the newer microcode and expat.
        old_kernel = "linux-image-generic_5.4.0.200.196_amd64.deb"
        new_microcode = "intel-microcode_3.20241112.0ubuntu0.20.04.1_amd64.deb"
        new_expat = "libexpat1_2.2.9-1ubuntu0.8_amd64.deb"
        mixed = {old_kernel, new_microcode, new_expat}
        self.assertIn(old_kernel, manifests["slightlyskepticalpotat"])
        self.assertIn(new_microcode, manifests["KunNw0n"])
        self.assertIn(new_expat, manifests["KunNw0n"])
        for filenames in manifests.values():
            self.assertFalse(mixed.issubset(filenames))

    def test_missing_checker_is_rejected(self):
        self.assertNotEqual(self.run_shell("check_focal_kernel_cohort nonexistent_checker").returncode, 0)


if __name__ == "__main__":
    unittest.main()
