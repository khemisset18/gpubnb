import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from nacl.signing import SigningKey

from gpubnb_agent.client import ApiClient


class _FakeResponse:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self, _limit):
        return json.dumps({"ok": True}).encode()


class ArtifactUploadTests(unittest.TestCase):
    def test_upload_sends_query_but_signs_registered_route_path_only(self):
        payload = b"artifact-bytes"
        with tempfile.TemporaryDirectory() as tmpdir:
            artifact = Path(tmpdir) / "result.bin"
            artifact.write_bytes(payload)
            client = ApiClient("https://api.example.test")
            key = SigningKey.generate()
            path = (
                "/jobs/job-1/artifacts"
                "?machineId=cmachine123456789012345678"
                "&kind=result"
                f"&sha256={hashlib.sha256(payload).hexdigest()}"
                f"&sizeBytes={len(payload)}"
            )

            with patch("gpubnb_agent.client.signed_headers_for_body_sha256") as sign, patch(
                "gpubnb_agent.client.urllib.request.urlopen",
                return_value=_FakeResponse(),
            ) as urlopen:
                sign.return_value = {
                    "x-agent-signature": "legacy",
                    "x-agent-signature-version": "2",
                    "x-agent-signature-v2": "v2",
                }

                result = client.upload_file(
                    path,
                    "job-1",
                    str(artifact),
                    key,
                    "cmachine123456789012345678",
                )

        self.assertEqual(result, {"ok": True})
        sign.assert_called_once_with(
            key,
            "cmachine123456789012345678",
            "POST",
            "/jobs/job-1/artifacts",
            hashlib.sha256(payload).hexdigest(),
        )
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, f"https://api.example.test{path}")
        self.assertEqual(request.data, payload)
        self.assertEqual(request.get_header("Content-type"), "application/octet-stream")


if __name__ == "__main__":
    unittest.main()
