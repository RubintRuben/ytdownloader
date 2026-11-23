import asyncio,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import app
from fastapi import HTTPException

class PreviewRecoveryTests(unittest.TestCase):
    def test_source_rules(self):
        for source,url in [('youtube','https://www.youtube.com/watch?v=a'),('instagram','https://www.instagram.com/reels/a/'),('any','https://vimeo.com/1'),('any','https://youtube.com/watch?v=a')]:
            app.validate_source_url(url,source)
        for source,url in [('youtube','https://instagram.com/reels/a/'),('instagram','https://youtube.com/watch?v=a'),('youtube','https://youtube.com.evil.test/v'),('youtube','https://notwww.youtube.com/v'),('instagram','https://instagram.com.evil.test/v')]:
            with self.assertRaises(HTTPException):app.validate_source_url(url,source)

    def test_status_coalesces_then_recovers_missing_cache(self):
        async def run():
            url='https://example.test/coalesced'
            with tempfile.TemporaryDirectory() as tmp:
                out=Path(tmp)/'preview.mp4';out.write_bytes(b'fixture')
                with patch.object(app,'_create_preview',return_value=out) as create:
                    first=await app.api_preview_status(url=url)
                    await app.api_preview_status(url=url)
                    await app._preview_pending[url]
                    self.assertEqual(create.call_count,1)
                    self.assertEqual((await app.api_preview_status(url=url))['status'],'ready')
                    out.unlink()
                    self.assertEqual((await app.api_preview_status(url=url))['status'],'preparing')
                    await app._preview_pending[url]
            app._preview_cache.pop(url,None);app._preview_state.pop(url,None)
        asyncio.run(run())

    def test_transient_download_failure_retries_once(self):
        async def run():
            url='https://example.test/retry'
            with tempfile.TemporaryDirectory() as tmp:
                out=Path(tmp)/'preview.mp4';out.write_bytes(b'fixture')
                with patch.object(app,'_create_preview',side_effect=[RuntimeError('expired URL'),out]) as create:
                    await app.api_preview_status(url=url)
                    await app._preview_pending[url]
                    self.assertEqual(create.call_count,2)
                    self.assertEqual(app._preview_state[url]['status'],'ready')
            app._preview_cache.pop(url,None);app._preview_state.pop(url,None)
        asyncio.run(run())

    def test_persistent_error_waits_for_explicit_retry(self):
        async def run():
            url='https://example.test/error'
            with patch.object(app,'_create_preview',side_effect=RuntimeError('offline')) as create:
                await app.api_preview_status(url=url)
                await app._preview_pending[url]
                self.assertEqual((await app.api_preview_status(url=url))['status'],'error')
                self.assertEqual(create.call_count,2)
                self.assertEqual((await app.api_preview_status(url=url,retry=True))['status'],'preparing')
                await app._preview_pending[url]
                self.assertEqual(create.call_count,4)
            app._preview_state.pop(url,None)
        asyncio.run(run())
