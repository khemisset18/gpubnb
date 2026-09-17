from __future__ import annotations

import unittest

from gpubnb_agent.windows_native_runtime import _loopback_media_url


class WindowsNativeMediaBoundaryTests(unittest.TestCase):
    def test_accepts_literal_ipv4_loopback_with_explicit_port(self):
        value = "http://127.0.0.1:43123/session/sess-1"
        self.assertEqual(_loopback_media_url(value), value)

    def test_accepts_literal_ipv6_loopback_with_explicit_port(self):
        value = "ws://[::1]:43123/session/sess-1"
        self.assertEqual(_loopback_media_url(value), value)

    def test_rejects_localhost_name_instead_of_resolving_it(self):
        self.assertIsNone(
            _loopback_media_url("http://localhost:43123/session/sess-1")
        )

    def test_rejects_non_loopback_literal_addresses(self):
        for value in (
            "http://0.0.0.0:43123/session/sess-1",
            "http://192.168.1.20:43123/session/sess-1",
            "https://203.0.113.7:443/session/sess-1",
            "ws://[2001:db8::1]:43123/session/sess-1",
        ):
            with self.subTest(value=value):
                self.assertIsNone(_loopback_media_url(value))

    def test_rejects_implicit_port_credentials_and_fragments(self):
        for value in (
            "http://127.0.0.1/session/sess-1",
            "http://user:pass@127.0.0.1:43123/session/sess-1",
            "http://127.0.0.1:43123/session/sess-1#fragment",
        ):
            with self.subTest(value=value):
                self.assertIsNone(_loopback_media_url(value))


if __name__ == "__main__":
    unittest.main()
