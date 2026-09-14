import unittest

from gpubnb_agent.update_recovery import PostUpdateChecks, must_rollback, rollback_reason


class UpdateRecoveryTests(unittest.TestCase):
    def test_only_fully_healthy_candidate_is_kept(self) -> None:
        checks = PostUpdateChecks(
            service_running=True,
            identity_matches_release=True,
            version_matches_candidate=True,
            runtime_healthy=True,
        )
        self.assertFalse(must_rollback(checks))
        self.assertIsNone(rollback_reason(checks))

    def test_service_start_timeout_requires_rollback(self) -> None:
        checks = PostUpdateChecks(False, True, True, True)
        self.assertTrue(must_rollback(checks))
        self.assertEqual(rollback_reason(checks), "service_not_running")

    def test_wrong_installed_commit_requires_rollback(self) -> None:
        checks = PostUpdateChecks(True, False, True, True)
        self.assertTrue(must_rollback(checks))
        self.assertEqual(rollback_reason(checks), "installed_commit_mismatch")

    def test_wrong_installed_version_requires_rollback(self) -> None:
        checks = PostUpdateChecks(True, True, False, True)
        self.assertTrue(must_rollback(checks))
        self.assertEqual(rollback_reason(checks), "installed_version_mismatch")

    def test_failed_runtime_probe_requires_rollback(self) -> None:
        checks = PostUpdateChecks(True, True, True, False)
        self.assertTrue(must_rollback(checks))
        self.assertEqual(rollback_reason(checks), "runtime_health_failed")


if __name__ == "__main__":
    unittest.main()
