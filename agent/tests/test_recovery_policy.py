import unittest

from gpubnb_agent.recovery_policy import (
    OWNER_ACTION_FAILURES,
    PLATFORM_ACTION_FAILURES,
    RECOVERABLE_FAILURES,
    STOP_FAILURES,
    bounded_backoff_seconds,
    classify_supervisor_exception,
    recovery_decision,
)


class RecoveryPolicyTests(unittest.TestCase):
    def test_transient_network_failure_retries_with_bounded_backoff(self) -> None:
        first = recovery_decision("network_unreachable", 0)
        later = recovery_decision("network_unreachable", 99)
        self.assertEqual(first.mode, "retry")
        self.assertEqual(first.retry_after_seconds, 5)
        self.assertEqual(later.retry_after_seconds, 300)

    def test_docker_starting_is_recoverable_but_missing_install_requires_owner(self) -> None:
        self.assertEqual(recovery_decision("docker_starting").mode, "retry")
        self.assertEqual(recovery_decision("docker_not_installed").mode, "owner_action")

    def test_revoked_identity_or_quarantine_never_self_clears(self) -> None:
        self.assertEqual(recovery_decision("agent_key_revoked").mode, "platform_action")
        self.assertEqual(recovery_decision("machine_quarantined").mode, "platform_action")
        self.assertEqual(recovery_decision("agent_auth_rejected").mode, "platform_action")

    def test_security_ambiguity_stops_instead_of_retrying_destructively(self) -> None:
        self.assertEqual(recovery_decision("invalid_server_signature").mode, "stop")
        self.assertEqual(recovery_decision("unsafe_runtime_state").mode, "stop")

    def test_unknown_failure_requires_owner_action(self) -> None:
        decision = recovery_decision("brand_new_failure")
        self.assertEqual(decision.mode, "owner_action")
        self.assertIsNone(decision.retry_after_seconds)
        empty = recovery_decision("   ")
        self.assertEqual(empty.mode, "owner_action")
        self.assertEqual(empty.reason, "unknown_failure")

    def test_backoff_never_exceeds_five_minutes(self) -> None:
        self.assertEqual(
            [bounded_backoff_seconds(i) for i in range(8)],
            [5, 10, 20, 40, 80, 160, 300, 300],
        )

    def test_every_known_reason_has_exactly_one_recovery_class(self) -> None:
        groups = [
            RECOVERABLE_FAILURES,
            OWNER_ACTION_FAILURES,
            PLATFORM_ACTION_FAILURES,
            STOP_FAILURES,
        ]
        for index, group in enumerate(groups):
            for other in groups[index + 1 :]:
                self.assertTrue(group.isdisjoint(other), f"overlapping recovery reasons: {group & other}")

    def test_all_recoverable_failures_retry_with_bounded_backoff(self) -> None:
        for reason in sorted(RECOVERABLE_FAILURES):
            with self.subTest(reason=reason):
                decision = recovery_decision(reason, 50)
                self.assertEqual(decision.mode, "retry")
                self.assertEqual(decision.reason, reason)
                self.assertEqual(decision.retry_after_seconds, 300)
                self.assertIsNone(decision.max_attempts)

    def test_all_owner_action_failures_never_retry_automatically(self) -> None:
        for reason in sorted(OWNER_ACTION_FAILURES):
            with self.subTest(reason=reason):
                decision = recovery_decision(reason)
                self.assertEqual(decision.mode, "owner_action")
                self.assertIsNone(decision.retry_after_seconds)

    def test_all_platform_action_failures_never_retry_destructively(self) -> None:
        for reason in sorted(PLATFORM_ACTION_FAILURES):
            with self.subTest(reason=reason):
                decision = recovery_decision(reason)
                self.assertEqual(decision.mode, "platform_action")
                self.assertIsNone(decision.retry_after_seconds)

    def test_all_security_stop_failures_are_fail_closed(self) -> None:
        for reason in sorted(STOP_FAILURES):
            with self.subTest(reason=reason):
                decision = recovery_decision(reason)
                self.assertEqual(decision.mode, "stop")
                self.assertIsNone(decision.retry_after_seconds)

    def test_runtime_classifier_only_retries_unambiguous_transient_failures(self) -> None:
        cases = [
            (TimeoutError("API timed out"), "heartbeat", "api_timeout"),
            (RuntimeError("API HTTP 503: unavailable"), "gateway", "api_unavailable"),
            (
                RuntimeError("workspace_docker_failed:info:1:Docker Desktop is starting"),
                "gateway",
                "docker_starting",
            ),
            (
                RuntimeError("workspace_docker_failed:info:1:error during connect to docker daemon"),
                "gateway",
                "docker_daemon_unreachable",
            ),
            (
                RuntimeError("rental_gpu_compute_processes_present"),
                "gateway",
                "rental_gpu_compute_processes_present",
            ),
        ]
        for exc, subsystem, expected in cases:
            with self.subTest(exc=str(exc)):
                self.assertEqual(
                    classify_supervisor_exception(exc, subsystem=subsystem),
                    expected,
                )
                self.assertEqual(recovery_decision(expected).mode, "retry")

    def test_runtime_classifier_parks_unknown_and_sensitive_failures(self) -> None:
        self.assertEqual(
            classify_supervisor_exception(
                RuntimeError("brand_new_runtime_fault"), subsystem="gateway"
            ),
            "unknown_failure",
        )
        self.assertEqual(
            recovery_decision("unknown_failure").mode,
            "owner_action",
        )
        self.assertEqual(
            classify_supervisor_exception(
                RuntimeError('API HTTP 401: {"error":"invalid_agent_request"}'),
                subsystem="gateway",
            ),
            "agent_auth_rejected",
        )
        self.assertEqual(
            classify_supervisor_exception(
                RuntimeError("host_tunnel_bootstrap_session_scope_mismatch"),
                subsystem="tunnel",
            ),
            "unsafe_runtime_state",
        )

    def test_missing_docker_binary_is_only_inferred_in_runtime_context(self) -> None:
        missing = FileNotFoundError("docker.exe")
        self.assertEqual(
            classify_supervisor_exception(missing, subsystem="gateway"),
            "docker_not_installed",
        )
        self.assertEqual(
            classify_supervisor_exception(missing, subsystem="heartbeat"),
            "unknown_failure",
        )


if __name__ == "__main__":
    unittest.main()
