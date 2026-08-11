import os
import logging
import threading
import unittest
from unittest.mock import MagicMock, patch

from gpubnb_agent import windows_service


class WindowsServiceTests(unittest.TestCase):
    def test_service_management_fails_closed_off_windows(self) -> None:
        if os.name == "nt":
            self.skipTest("non-Windows contract test")
        with self.assertRaisesRegex(RuntimeError, "not_supported"):
            windows_service.manage_service("install")

    def test_service_identity_is_stable(self) -> None:
        self.assertEqual(windows_service.SERVICE_NAME, "GPUbnbAgent")
        self.assertNotIn(" ", windows_service.SERVICE_NAME)

    def test_missing_runtime_is_not_reported_as_success(self) -> None:
        with (
            patch.object(windows_service.os, "name", "nt"),
            patch.dict("sys.modules", {"servicemanager": None}),
        ):
            with self.assertRaisesRegex(RuntimeError, "runtime_missing"):
                windows_service._require_windows()

    def test_supervisor_retries_worker_failure_and_stops_cleanly(self) -> None:
        stop_event = threading.Event()
        heartbeat = MagicMock(side_effect=[RuntimeError("configuration_missing"), 0])
        logger = MagicMock(spec=logging.Logger)

        def stop_after_first_wait(_: float) -> bool:
            stop_event.set()
            return True

        with patch.object(stop_event, "wait", side_effect=stop_after_first_wait):
            windows_service.supervise_heartbeat(stop_event, heartbeat, logger)

        heartbeat.assert_called_once()
        args, kwargs = heartbeat.call_args
        self.assertEqual(args, (stop_event,))
        self.assertEqual(kwargs["process_mode"], "_service")
        self.assertTrue(callable(kwargs["event_sink"]))
        logger.exception.assert_called_once()

    def test_service_event_sink_persists_structured_agent_events(self) -> None:
        logger = MagicMock(spec=logging.Logger)
        sink = windows_service._service_event_sink(logger)

        sink({"event": "job_failed", "jobId": "job-1", "message": "échec"})

        logger.info.assert_called_once()
        template, payload = logger.info.call_args.args
        self.assertEqual(template, "agent_event %s")
        self.assertIn('"event":"job_failed"', payload)
        self.assertIn('"jobId":"job-1"', payload)
        self.assertIn("échec", payload)

    def test_service_status_reports_running_only_from_scm_evidence(self) -> None:
        win32service = MagicMock(SERVICE_RUNNING=4)
        win32service.error = OSError
        win32serviceutil = MagicMock()
        win32serviceutil.QueryServiceStatus.return_value = (0, 4, 0, 0, 0, 0, 0)
        with patch.object(
            windows_service,
            "_require_windows",
            return_value=(MagicMock(), MagicMock(), win32service, win32serviceutil),
        ):
            self.assertEqual(
                windows_service.service_status(),
                {"installed": True, "running": True},
            )


if __name__ == "__main__":
    unittest.main()
