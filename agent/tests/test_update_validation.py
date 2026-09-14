import unittest

from gpubnb_agent.update_validation import (
    AgentBuildIdentity,
    UpdateIdentityError,
    identity_matches_release,
    normalize_release_commit,
    parse_build_identity,
    require_identity_matches_release,
)


class UpdateIdentityTests(unittest.TestCase):
    def test_valid_frozen_identity_matches_promoted_full_commit(self) -> None:
        full = "abcdef123456" + "0" * 28
        identity = parse_build_identity(
            "0.6.6",
            {
                "agentVersion": "0.6.6",
                "buildCommit": full[:12],
                "frozen": True,
            },
        )
        self.assertTrue(identity_matches_release(identity, full))
        require_identity_matches_release(identity, full, stage="candidate")

    def test_dev_build_is_never_accepted_as_a_promoted_candidate(self) -> None:
        with self.assertRaisesRegex(UpdateIdentityError, "candidate_build_commit_invalid"):
            parse_build_identity(
                "0.6.6",
                {
                    "agentVersion": "0.6.6",
                    "buildCommit": "dev",
                    "frozen": True,
                },
            )

    def test_non_frozen_candidate_is_rejected(self) -> None:
        with self.assertRaisesRegex(UpdateIdentityError, "candidate_not_frozen"):
            parse_build_identity(
                "0.6.6",
                {
                    "agentVersion": "0.6.6",
                    "buildCommit": "abcdef123456",
                    "frozen": False,
                },
            )

    def test_version_command_and_build_info_must_agree(self) -> None:
        with self.assertRaisesRegex(UpdateIdentityError, "candidate_version_identity_mismatch"):
            parse_build_identity(
                "0.6.7",
                {
                    "agentVersion": "0.6.6",
                    "buildCommit": "abcdef123456",
                    "frozen": True,
                },
            )

    def test_candidate_from_different_commit_is_rejected(self) -> None:
        identity = AgentBuildIdentity(
            version="0.6.6",
            build_commit="111111111111",
            frozen=True,
        )
        with self.assertRaisesRegex(UpdateIdentityError, "candidate_commit_mismatch"):
            require_identity_matches_release(
                identity,
                "2222222222222222222222222222222222222222",
                stage="candidate",
            )

    def test_post_install_identity_uses_same_release_check(self) -> None:
        identity = AgentBuildIdentity(
            version="0.6.6",
            build_commit="333333333333",
            frozen=True,
        )
        with self.assertRaisesRegex(UpdateIdentityError, "installed_commit_mismatch"):
            require_identity_matches_release(
                identity,
                "4444444444444444444444444444444444444444",
                stage="installed",
            )

    def test_release_commit_must_be_exact_full_sha(self) -> None:
        with self.assertRaisesRegex(UpdateIdentityError, "release_commit_invalid"):
            normalize_release_commit("abcdef123456")


if __name__ == "__main__":
    unittest.main()
