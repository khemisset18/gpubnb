from __future__ import annotations

import unittest

from gpubnb_agent.windows_native_runtime import _loopback_media_url, media_token_matches


class WindowsNativeMediaBoundaryTests(unittest.TestCase):
    SESSION_ID = "sess-1"

    def test_accepts_literal_ipv4_loopback_with_explicit_port(self):
        value = "http://127.0.0.1:43123/session/sess-1"
        self.assertEqual(_loopback_media_url(value, self.SESSION_ID), value)

    def test_accepts_literal_ipv6_loopback_with_explicit_port(self):
        value = "ws://[::1]:43123/session/sess-1"
        self.assertEqual(_loopback_media_url(value, self.SESSION_ID), value)

    def test_rejects_localhost_name_instead_of_resolving_it(self):
        self.assertIsNone(
            _loopback_media_url(
                "http://localhost:43123/session/sess-1",
                self.SESSION_ID,
            )
        )

    def test_rejects_non_loopback_literal_addresses(self):
        for value in (
            "http://0.0.0.0:43123/session/sess-1",
            "http://192.168.1.20:43123/session/sess-1",
            "https://203.0.113.7:443/session/sess-1",
            "ws://[2001:db8::1]:43123/session/sess-1",
        ):
            with self.subTest(value=value):
                self.assertIsNone(_loopback_media_url(value, self.SESSION_ID))

    def test_rejects_implicit_port_credentials_query_and_fragments(self):
        for value in (
            "http://127.0.0.1/session/sess-1",
            "http://user:pass@127.0.0.1:43123/session/sess-1",
            "http://127.0.0.1:43123/session/sess-1?token=secret",
            "http://127.0.0.1:43123/session/sess-1#fragment",
        ):
            with self.subTest(value=value):
                self.assertIsNone(_loopback_media_url(value, self.SESSION_ID))

    def test_rejects_malformed_and_normalized_urls_without_raising(self):
        for value in (
            None, 123, [], {},
            "http://[::1:43123/session/sess-1",
            "http://[invalid]:43123/session/sess-1",
            "http://127.0.0.1:bad/session/sess-1",
            "http://127.0.0.1:0/session/sess-1",
            "http://127.0.0.1:65536/session/sess-1",
            "http://@127.0.0.1:43123/session/sess-1",
            "http://127.0.0.1:43123/session/sess-1?",
            "http://127.0.0.1:43123/session/sess-1#",
            "http://127.0.0.1:43123/session/sess-1;params",
            "http://127.0.0.1:43123/session/sess-1;",
            "http://[::1%25scope]:43123/session/sess-1",
            "http://127.0.0.1:043123/session/sess-1",
            " http://127.0.0.1:43123/session/sess-1",
            "http://127.0.0.1:43123/session/sess-1\n",
            "http://127.0.0.1:43123/ses\tsion/sess-1",
        ):
            with self.subTest(value=value):
                self.assertIsNone(_loopback_media_url(value, self.SESSION_ID))

    def test_rejects_cross_session_path(self):
        self.assertIsNone(
            _loopback_media_url(
                "http://127.0.0.1:43123/session/sess-2",
                self.SESSION_ID,
            )
        )

    def test_media_token_comparison_is_strict_and_type_safe(self):
        token = "A" * 32 + "-_"
        self.assertTrue(media_token_matches(token, token))
        for presented in (
            "B" + token[1:],
            token[:-1],
            token + "A",
            token.lower(),
            None,
            123,
            True,
            [],
            {},
            "A" * 31,
            "A" * 201,
            "A" * 32 + "=",
        ):
            with self.subTest(presented=presented):
                self.assertFalse(media_token_matches(token, presented))

    def test_rejects_near_match_or_extra_path_segments(self):
        for value in (
            "http://127.0.0.1:43123/session/sess-1/",
            "http://127.0.0.1:43123/session/sess-1/control",
            "http://127.0.0.1:43123/session/sess-10",
        ):
            with self.subTest(value=value):
                self.assertIsNone(_loopback_media_url(value, self.SESSION_ID))


if __name__ == "__main__":
    unittest.main()
