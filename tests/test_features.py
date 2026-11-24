"""Offline tests for search parsing, subtitles, audio tracks, gallery and MCP."""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

import app
import library
import mcp_server
import yt_web


class SearchParsingTests(unittest.TestCase):
    def test_videos_shorts_channels_and_continuation_are_collected(self):
        data = {"contents": [
            {"videoRenderer": {
                "videoId": "abc", "title": {"runs": [{"text": "Cím"}]}, "lengthText": {"simpleText": "1:02:03"},
                "shortViewCountText": {"simpleText": "9,7 E megtekintés"}, "publishedTimeText": {"simpleText": "1 napja"},
                "ownerText": {"runs": [{"text": "Csatorna", "navigationEndpoint": {"browseEndpoint": {"browseId": "UC1"}}}]},
                "ownerBadges": [{"metadataBadgeRenderer": {"style": "BADGE_STYLE_TYPE_VERIFIED"}}],
                "channelThumbnailSupportedRenderers": {"channelThumbnailWithLinkRenderer": {
                    "thumbnail": {"thumbnails": [{"url": "//yt3/a.jpg", "width": 68}]}}},
                "thumbnail": {"thumbnails": [{"url": "https://i/1.jpg", "width": 1}, {"url": "https://i/2.jpg", "width": 9}]}}},
            {"gridShelfViewModel": {"contents": [{"shortsLockupViewModel": {
                "onTap": {"innertubeCommand": {"reelWatchEndpoint": {"videoId": "s1"}}},
                "overlayMetadata": {"primaryText": {"content": "Short"}, "secondaryText": {"content": "5 E"}}}}]}},
            {"channelRenderer": {"channelId": "UC2", "title": {"simpleText": "Ch"},
                                 "subscriberCountText": {"simpleText": "@ch"}, "videoCountText": {"simpleText": "1 M"}}},
            {"continuationItemRenderer": {"continuationEndpoint": {"continuationCommand": {"token": "NEXT"}}}},
        ]}
        page = yt_web._collect(data)
        video = page["videos"][0]
        self.assertEqual((video["duration"], video["verified"], video["avatar"]), (3723, True, "https://yt3/a.jpg"))
        self.assertEqual(video["thumbnail"], "https://i/2.jpg")
        self.assertEqual(page["shorts"][0]["url"], "https://www.youtube.com/shorts/s1")
        self.assertEqual((page["channels"][0]["handle"], page["channels"][0]["subs"]), ("@ch", "1 M"))
        self.assertEqual(page["next"], "NEXT")


class MediaOptionTests(unittest.TestCase):
    info = {"formats": [
        {"format_id": "a1", "acodec": "mp4a", "vcodec": "none", "language": "en", "language_preference": 10,
         "format_note": "English original (default), low"},
        {"format_id": "a2", "acodec": "mp4a", "vcodec": "none", "language": "de", "language_preference": -1},
        {"format_id": "v", "acodec": "none", "vcodec": "avc1", "height": 720},
    ], "subtitles": {"en": [{"ext": "vtt", "url": "https://x/en", "name": "English"}], "live_chat": [{}]},
        "automatic_captions": {"en-orig": [{"ext": "json3", "url": "https://x/a"}], "hu": [{"ext": "json3", "url": "https://x/h"}]}}

    def test_audio_tracks_put_the_original_first(self):
        tracks = app._audio_tracks(self.info)
        self.assertEqual([(t["lang"], t["original"]) for t in tracks], [("en", True), ("de", False)])

    def test_subtitle_listing_skips_live_chat_and_finds_original_captions(self):
        listing = app._subtitle_listing(self.info)
        self.assertEqual([s["lang"] for s in listing["subtitles"]], ["en"])
        self.assertEqual(listing["captionsOrig"], "en")
        self.assertEqual(listing["translate"], ["hu"])
        self.assertEqual(app._subtitle_entry(self.info, "en", True)["url"], "https://x/a")

    def test_json3_becomes_escaped_webvtt(self):
        vtt = app._json3_to_vtt({"events": [{"tStartMs": 1500, "dDurationMs": 2000, "segs": [{"utf8": "a < b"}]},
                                            {"tStartMs": 2000, "segs": [{"utf8": "\n"}]}]})
        self.assertEqual(vtt, "WEBVTT\n\n00:00:01.500 --> 00:00:03.500\na &lt; b\n")

    def test_dubbed_audio_language_is_requested_first(self):
        opts = app._build_opts("t", "https://youtube.com/watch?v=x", Path("."), "mp4", "720", 0, 0, 60, None, "de")
        self.assertTrue(opts["format"].startswith("bestvideo[height<=720][ext=mp4]+bestaudio[language=de]"))

    def test_language_codes_are_validated(self):
        with self.assertRaises(app.HTTPException):
            asyncio.run(app.start_download("https://youtube.com/watch?v=x", audio_lang="en]+best"))


class LibraryTests(unittest.TestCase):
    def test_missing_files_disappear_and_deletion_goes_to_recycle_bin(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            lib = library.Library(root / "data")
            kept, gone = root / "a.mp4", root / "b.mp4"
            kept.write_bytes(b"1")
            gone.write_bytes(b"22")
            first = lib.add(str(kept), {"title": "A"}, None)
            lib.add(str(gone), {"title": "B"}, None)
            gone.unlink()
            self.assertEqual([x["title"] for x in lib.items()], ["A"])
            with patch.object(library, "recycle", return_value=True) as recycle:
                self.assertEqual(lib.remove([first["id"]]), [first["id"]])
            recycle.assert_called_once_with(str(kept))
            self.assertEqual(lib.items(), [])

    def test_unique_names_never_overwrite(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "x.mp4"
            path.write_bytes(b"")
            self.assertEqual(library.unique_path(path).name, "x (2).mp4")


class McpTests(unittest.TestCase):
    def call(self, mode, tool, answer=None):
        async def run():
            calls = []

            async def handler(args):
                calls.append(args)
                return "done"

            router, approvals = mcp_server.create_router(
                {tool: handler}, lambda name, args: asyncio.sleep(0, "summary"), lambda: mode, lambda: "tok", "1")
            from fastapi import FastAPI
            api = FastAPI()
            api.include_router(router)
            transport = httpx.ASGITransport(app=api)
            async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1") as client:
                request = client.post("/mcp", headers={"Authorization": "Bearer tok"}, json={
                    "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": {}}})
                task = asyncio.create_task(request)
                if answer is not None:
                    while not approvals.pending:
                        await asyncio.sleep(0.01)
                    approvals.answer(next(iter(approvals.pending)), answer)
                response = await task
                unauthorized = await client.post("/mcp", json={"jsonrpc": "2.0", "id": 2, "method": "ping"})
            return response.json()["result"], calls, unauthorized.status_code
        return asyncio.run(run())

    def test_ask_mode_waits_for_approval(self):
        result, calls, unauthorized = self.call("ask", "download", answer=False)
        self.assertTrue(result["isError"])
        self.assertEqual(calls, [])
        self.assertEqual(unauthorized, 401)
        result, calls, _ = self.call("ask", "download", answer=True)
        self.assertEqual((result["content"][0]["text"], len(calls)), ("done", 1))

    def test_full_mode_runs_and_off_mode_refuses(self):
        self.assertEqual(self.call("full", "delete")[0]["content"][0]["text"], "done")
        self.assertTrue(self.call("off", "search")[0]["isError"])

    def test_tool_definitions_stay_compact(self):
        self.assertLess(len(json.dumps(mcp_server.TOOLS)), 3000)


if __name__ == "__main__":
    unittest.main()
