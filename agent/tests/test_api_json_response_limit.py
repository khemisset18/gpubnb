from __future__ import annotations

import io
import unittest

from gpubnb_agent.client import _read_json_response


class ApiJsonResponseLimitTests(unittest.TestCase):
    def test_valid_response_at_limit_is_decoded(self) -> None:
        payload = b'{"ok":true}'
        self.assertEqual(_read_json_response(io.BytesIO(payload), len(payload)), {"ok": True})

    def test_oversized_response_is_rejected_instead_of_truncated(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "API response too large"):
            _read_json_response(io.BytesIO(b'{"x":"1234567890"}'), 8)

    def test_non_object_json_is_rejected(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "must be an object"):
            _read_json_response(io.BytesIO(b'[]'), 8)


if __name__ == "__main__":
    unittest.main()
