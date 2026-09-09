from __future__ import annotations

import unittest

from gpubnb_agent.windows_subprocess import (
    WINDOWS_CREATE_NEW_CONSOLE,
    WINDOWS_CREATE_NO_WINDOW,
    WINDOWS_DETACHED_PROCESS,
    background_creationflags,
)


class WindowsSubprocessPolicyTests(unittest.TestCase):
    def test_adds_no_window_without_dropping_existing_flags(self) -> None:
        create_new_process_group = 0x00000200
        flags = background_creationflags(create_new_process_group)
        self.assertEqual(flags & create_new_process_group, create_new_process_group)
        self.assertEqual(flags & WINDOWS_CREATE_NO_WINDOW, WINDOWS_CREATE_NO_WINDOW)

    def test_preserves_explicit_new_console_policy(self) -> None:
        self.assertEqual(
            background_creationflags(WINDOWS_CREATE_NEW_CONSOLE),
            WINDOWS_CREATE_NEW_CONSOLE,
        )

    def test_preserves_explicit_detached_process_policy(self) -> None:
        self.assertEqual(
            background_creationflags(WINDOWS_DETACHED_PROCESS),
            WINDOWS_DETACHED_PROCESS,
        )


if __name__ == "__main__":
    unittest.main()
