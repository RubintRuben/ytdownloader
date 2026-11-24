import asyncio
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch, AsyncMock
import app


class UniversalPreviewTests(unittest.TestCase):
    def test_source_restrictions_run_before_extraction(self):
        from fastapi import HTTPException
        async def run():
            with patch.object(app, 'get_info', new=AsyncMock()) as fetch:
                for url, source in [('https://instagram.com/reel/x', 'youtube'), ('https://youtube.com/watch?v=x', 'instagram'), ('https://youtube.com.evil.test/', 'youtube')]:
                    with self.assertRaises(HTTPException):
                        await app.api_info(url=url, source=source)
                fetch.assert_not_called()
        asyncio.run(run())

    def test_preview_status_coalesces_and_recovers_failed_attempt(self):
        async def run():
            url = 'https://example.org/retry-test'
            with tempfile.TemporaryDirectory() as folder:
                output = Path(folder, 'preview.mp4'); output.write_bytes(b'fixture')
                with patch.object(app, '_preview_slots', asyncio.Semaphore(2)), patch.object(app, '_create_preview', side_effect=[RuntimeError('expired URL'), output]) as create:
                    first = await app.api_preview_status(url=url)
                    self.assertEqual(first['status'], 'preparing')
                    task = app._preview_pending[url]
                    await app.api_preview_status(url=url)
                    self.assertIs(app._preview_pending[url], task)
                    await task
                    self.assertEqual((await app.api_preview_status(url=url))['status'], 'ready')
                    self.assertEqual(create.call_count, 2)
                output.unlink()
                with patch.object(app, '_preview_slots', asyncio.Semaphore(2)), patch.object(app, '_create_preview', return_value=output) as create:
                    self.assertEqual((await app.api_preview_status(url=url))['status'], 'preparing')
                    await app._preview_pending[url]
                    create.assert_called_once()
            for cache in (app._preview_cache, app._preview_state, app._preview_durations): cache.pop(url, None)
        asyncio.run(run())

    def test_error_requires_explicit_retry(self):
        async def run():
            url='https://example.org/failed-test'
            app._preview_state[url]={'status':'error','message':'failed'}
            with patch.object(app, '_start_preview') as start:
                self.assertEqual((await app.api_preview_status(url=url))['status'],'error')
                start.assert_not_called()
                await app.api_preview_status(url=url,retry=True)
                start.assert_called_once_with(url)
            app._preview_state.pop(url,None)
        asyncio.run(run())

    def test_video_only_and_hls_are_not_selected_as_audible_direct_preview(self):
        silent = {'url':'https://cdn.example/silent.mp4', 'height':1080, 'vcodec':'h264', 'acodec':'none', 'protocol':'https', 'ext':'mp4'}
        audible = {**silent, 'url':'https://cdn.example/audible.mp4', 'height':360, 'acodec':'aac'}
        self.assertIsNone(app._ig_play_url({'formats':[silent]}))
        self.assertEqual(app._ig_play_url({'formats':[silent, audible]}), audible['url'])
        self.assertIsNone(app._ig_play_url({'formats':[{**audible, 'protocol':'m3u8_native'}]}))

    def test_browser_compatible_webm_can_play_without_transcoding(self):
        fmt = {"url": "https://cdn.example/movie.webm", "height": 360, "protocol": "https",
               "ext": "webm", "vcodec": "vp9", "acodec": "opus"}
        self.assertEqual(app._direct_preview_format({"formats": [fmt]}), fmt)
        self.assertEqual(app._browser_preview_type(fmt), "video/webm")
        self.assertIsNone(app._direct_preview_format({"formats": [{**fmt, "acodec": "none"}]}))

    def test_metadata_prefers_an_existing_compatible_preview(self):
        async def run():
            url = "https://example.org/cached-preview"
            with tempfile.TemporaryDirectory() as folder:
                output = Path(folder) / "preview.mp4"
                output.touch()
                with patch.dict(app._preview_cache, {url: output}), patch.dict(app._preview_state, {url: {"hasAudio": False}}):
                    with patch.object(app, "get_info", new=AsyncMock(return_value={"duration": 1})):
                        data = await app.api_info(url)
                        self.assertTrue(data["previewCached"])
                        self.assertFalse(data["previewHasAudio"])
                        output.unlink()
                        self.assertFalse((await app.api_info(url))["previewCached"])
        asyncio.run(run())

    def test_all_sources_get_fallback_even_without_duration(self):
        async def run():
            for url, source in [('https://www.instagram.com/reels/example/', 'instagram'), ('https://vimeo.com/123', 'other'), ('https://www.youtube.com/watch?v=test', 'youtube')]:
                with patch.object(app, 'get_info', new=AsyncMock(return_value={'id':'test','duration':0,'formats':[]})):
                    data = await app.api_info(url=url)
                self.assertEqual(data['source'], source)
                self.assertTrue(data['previewUrl'].startswith('/api/preview?url='))
                self.assertEqual(data['duration'], 0)
        asyncio.run(run())

    def test_actual_preview_duration_replaces_missing_extractor_duration(self):
        url = 'https://example.org/video'
        async def run():
            with patch.dict(app._preview_durations, {url:10.17}), patch.object(app, 'get_info', new=AsyncMock(return_value={'duration':0})):
                self.assertEqual((await app.api_info(url=url))['duration'], 10.17)
                estimate = await app.api_estimate(url=url, start=2, end=5)
                self.assertEqual(estimate['seconds'], 3)
        asyncio.run(run())
