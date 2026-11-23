"""Offline regressions. Run: py -m unittest discover -s tests -v"""
import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app
from fastapi import HTTPException


class DownloadTests(unittest.TestCase):
    def test_full_duration_does_not_force_ffmpeg_range_download(self):
        opts = app._build_opts('test', 'https://youtube.com/watch?v=x', Path('.'), 'mp4', '720', 0, 60, 60)
        self.assertNotIn('download_ranges', opts)
        trimmed = app._build_opts('test', 'https://youtube.com/watch?v=x', Path('.'), 'mp4', '720', 10, 30, 60)
        self.assertIn('download_ranges', trimmed)

    def test_expired_metadata_is_refreshed(self):
        app._info_cache['https://example.org/video|'] = (app.time.monotonic() - 601, {'title': 'old'})
        with patch.object(app, '_extract_info_once', return_value={'title':'fresh'}) as extract:
            self.assertEqual(app._extract_info('https://example.org/video')['title'], 'fresh')
            self.assertEqual(app._extract_info('https://example.org/video')['title'], 'fresh')
            extract.assert_called_once()

    def test_bad_parameters_fail_before_network(self):
        async def run():
            for params in ({'quality':'oops'}, {'start':float('nan')}, {'start':20,'end':10}, {'format':'exe'}):
                with self.assertRaises(HTTPException) as error:
                    await app.api_prepare(url='https://example.org/video', **params)
                self.assertEqual(error.exception.status_code, 400)
        with patch.object(app, 'get_info') as fetch:
            asyncio.run(run())
            fetch.assert_not_called()

    def test_canceling_queued_job_never_starts_network(self):
        with tempfile.TemporaryDirectory() as folder:
            app._jobs['cancel-test'] = {'dir':folder, 'status':'canceling'}
            with patch.object(app, '_ensure_ffmpeg_on_path') as setup:
                app._run_job('cancel-test', 'https://example.org/video', 'mp4', {}, 'mp4', 0)
                setup.assert_not_called()
            self.assertEqual(app._jobs.pop('cancel-test')['status'], 'canceled')

    def test_search_coalesces_concurrent_identical_requests(self):
        async def run():
            app._search_cache.clear()
            with patch.object(app, '_search_youtube', return_value=[{'id':'one'}]) as search:
                first, second = await asyncio.gather(app.api_search(q='same'), app.api_search(q='same'))
                self.assertEqual(first, second)
                search.assert_called_once()
        asyncio.run(run())

    def test_output_is_not_a_part_file_renamed_mp4(self):
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, 'out.mp4.part').write_bytes(b'partial')
            app._jobs['partial-test'] = {'dir':folder, 'status':'running'}
            with patch.object(app, '_ensure_ffmpeg_on_path', return_value=Path('ffmpeg.exe')), patch.object(app, 'YoutubeDL'):
                app._run_job('partial-test', 'https://example.org/video', 'mp4', {}, 'mp4', 0)
            self.assertEqual(app._jobs.pop('partial-test')['status'], 'error')

    def test_empty_trim_retries_locally_before_marking_done(self):
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, 'out.mp4').write_bytes(b'empty mp4 container')
            fallback = Path(folder, 'trimmed.mp4')
            app._jobs['trim-test'] = {'dir':folder, 'status':'running'}
            with patch.object(app, '_ensure_ffmpeg_on_path', return_value=Path('ffmpeg.exe')), \
                 patch.object(app, 'YoutubeDL'), \
                 patch.object(app, '_has_media_stream', side_effect=[False, True]), \
                 patch.object(app, '_local_trim_fallback', return_value=fallback) as retry:
                app._run_job('trim-test', 'https://example.org/video', 'mp4', {'download_ranges':True}, 'mp4', 0)
                retry.assert_called_once()
            job = app._jobs.pop('trim-test')
            self.assertEqual(job['status'], 'done')
            self.assertEqual(job['path'], str(fallback))

    def test_empty_non_trim_output_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, 'out.mp4').write_bytes(b'empty mp4 container')
            app._jobs['empty-test'] = {'dir':folder, 'status':'running'}
            with patch.object(app, '_ensure_ffmpeg_on_path', return_value=Path('ffmpeg.exe')), \
                 patch.object(app, 'YoutubeDL'), patch.object(app, '_has_media_stream', return_value=False):
                app._run_job('empty-test', 'https://example.org/video', 'mp4', {}, 'mp4', 0)
            self.assertEqual(app._jobs.pop('empty-test')['status'], 'error')


if __name__ == '__main__':
    unittest.main()
