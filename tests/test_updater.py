import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import httpx

import updater


class UpdaterTests(unittest.TestCase):
    def test_release_requires_newer_version_and_verified_windows_asset(self):
        payload = {
            "tag_name": "v2.1.0",
            "assets": [{"name": "Downloader.exe", "id": 19, "size": 100, "state": "uploaded",
                        "digest": "sha256:" + "a" * 64}],
        }
        with patch.object(updater, "APP_VERSION", "2.0.0"):
            for version, expected in [("v2.1.0", "2.1.0"), ("v2.0.0", None), ("v2.2.0-beta", None)]:
                with patch.object(httpx, "get", return_value=httpx.Response(200, json={**payload, "tag_name": version},
                                                                            request=httpx.Request("GET", "https://api.github.com"))):
                    found = updater._latest_release()
                    self.assertEqual(found["version"] if found else None, expected)
            payload["assets"][0]["digest"] = ""
            with patch.object(httpx, "get", return_value=httpx.Response(200, json=payload,
                                                                        request=httpx.Request("GET", "https://api.github.com"))):
                self.assertIsNone(updater._latest_release())

    def test_download_validates_content_and_drops_auth_on_redirect(self):
        image = b"MZ" + b"test Windows download" * 500
        release = {"id": 19, "size": len(image), "sha256": hashlib.sha256(image).hexdigest()}
        client = httpx.Client

        def handle(request):
            if request.url.host == "api.github.com":
                self.assertEqual(request.headers.get("authorization"), "Bearer sample")
                return httpx.Response(302, headers={"location": "https://release-assets.githubusercontent.com/file"})
            self.assertNotIn("authorization", request.headers)
            return httpx.Response(200, content=image)

        with tempfile.TemporaryDirectory() as folder:
            with patch.object(updater.httpx, "Client",
                              side_effect=lambda **kwargs: client(transport=httpx.MockTransport(handle), **kwargs)):
                output = Path(folder) / "update.exe"
                progress = []
                updater._download_asset(release, output, progress.append, "sample")
                self.assertEqual(output.read_bytes(), image)
                self.assertEqual(progress[-1], 100)
                with self.assertRaises(ValueError):
                    updater._download_asset({**release, "sha256": "0" * 64}, Path(folder) / "invalid.exe",
                                            lambda progress: None, "sample")


if __name__ == "__main__":
    unittest.main()
