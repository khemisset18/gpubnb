from __future__ import annotations

import unittest

from gpubnb_agent.windows_native_protocol import json_object, schema_v1, valid_gpu_uuid


class WindowsNativeProtocolTests(unittest.TestCase):
    def test_rejects_duplicate_proofs_and_non_json_constants(self):
        for payload in (
            '{"captureReady":false,"captureReady":true}',
            '{"nested":{"gpuUuid":"a","gpuUuid":"b"}}',
            '{"value":NaN}', '{"value":Infinity}', '{"value":-Infinity}',
            '{}{}', '[]', 'null', '{"x":"' + "a" * 65536 + '"}',
            "[" * 2000 + "]" * 2000,
        ):
            with self.subTest(payload=payload[:80]):
                self.assertIsNone(json_object(payload))
        self.assertEqual(json_object('{"captureReady":true}'), {"captureReady": True})

    def test_schema_requires_json_integer_one(self):
        self.assertTrue(schema_v1(1))
        for value in (True, False, 1.0, "1", None, 0, 2):
            with self.subTest(value=value):
                self.assertFalse(schema_v1(value))

    def test_gpu_uuid_cannot_be_an_alias_or_normalized_input(self):
        uuid = "GPU-e8301c16-2a14-2b3f-f057-b21f3b00524a"
        self.assertTrue(valid_gpu_uuid(uuid))
        self.assertTrue(valid_gpu_uuid(uuid.upper()))
        for value in ("GPU-EXACT", "", None, 123, uuid + " ", uuid + "\n", " " + uuid,
                      uuid.replace("GPU-", "AMD-"), uuid[:-1] + "z"):
            with self.subTest(value=value):
                self.assertFalse(valid_gpu_uuid(value))
