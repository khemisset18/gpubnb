import inspect
import unittest

from gpubnb_agent.client import ApiClient


class ArtifactUploadTests(unittest.TestCase):
    def test_upload_signs_route_path_but_sends_full_query_url(self):
        source = inspect.getsource(ApiClient.upload_file).replace(" ", "")

        self.assertIn('signature_path=path.split("?",1)[0]', source)
        self.assertIn(
            'signed_headers_for_body_sha256(key,machine_id,"POST",signature_path,sha256)',
            source,
        )
        self.assertIn('urllib.request.Request(self.api_url+path', source)
        self.assertIn('"content-type":"application/octet-stream"', source)


if __name__ == "__main__":
    unittest.main()
