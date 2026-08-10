"""Regression test for a real crash found running `gpubnb-agent workspaces list`
from an actual Windows console (French locale, cp1252): the workspace catalog's
emoji icons made print_json() raise UnicodeEncodeError and crash the whole CLI,
reproducible from both Git Bash and a native PowerShell console.
"""
import io
import json
import sys
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

from gpubnb_agent import cli


class PrintJsonEncodingTests(unittest.TestCase):
    def test_non_ascii_content_does_not_crash_on_a_legacy_console_codepage(self) -> None:
        raw = io.BytesIO()
        # Mirrors a real Windows console's sys.stdout: a TextIOWrapper whose
        # encoding is the legacy console codepage, not UTF-8.
        fake_stdout = io.TextIOWrapper(raw, encoding="cp1252", write_through=True)
        payload = {"icon": "\U0001f916", "label": "espace développeur"}

        with patch.object(sys, "stdout", fake_stdout):
            cli.print_json(payload)

        raw.seek(0)
        decoded = json.loads(raw.getvalue().decode("utf-8"))
        self.assertEqual(decoded, payload)

    def test_still_works_when_stdout_is_redirected_to_a_plain_stringio(self) -> None:
        # The io.StringIO() pattern used by other CLI tests (e.g.
        # test_process_lifecycle.py) has no .buffer attribute at all.
        output = io.StringIO()
        with redirect_stdout(output):
            cli.print_json({"ok": True, "label": "équipement"})
        self.assertEqual(json.loads(output.getvalue()), {"ok": True, "label": "équipement"})


if __name__ == "__main__":
    unittest.main()
