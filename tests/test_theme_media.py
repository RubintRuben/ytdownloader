import tempfile
import unittest
from pathlib import Path

from theme_media import ThemeVideos


class ThemeMediaTests(unittest.TestCase):
    def test_bundled_workshop_projects_are_the_defaults(self):
        bundled = Path(__file__).resolve().parents[1] / "wallpapers"
        with tempfile.TemporaryDirectory() as folder:
            cache = Path(folder)
            (cache / "rain.mp4").write_bytes(b"old cached download")
            themes = ThemeVideos(cache, bundled, lambda: None, self.fail)
            for scene, kind in (("rain", "web"), ("minecraft", "scene"), ("blackhole", "scene")):
                with self.subTest(scene=scene):
                    status = themes.ensure(scene)
                    self.assertEqual((status["state"], status["kind"], status["custom"]), ("ready", kind, None))
                    self.assertTrue(themes.asset(scene, status["file"]))
                    self.assertTrue(themes.preview(scene))
                    self.assertIsNone(themes.video_path(scene))

    def test_reset_restores_the_bundled_wallpaper_after_a_legacy_video_override(self):
        bundled = Path(__file__).resolve().parents[1] / "wallpapers"
        with tempfile.TemporaryDirectory() as folder:
            cache = Path(folder)
            (cache / "rain.mp4").write_bytes(b"legacy custom clip")
            (cache / "rain.custom").write_text("My video", encoding="utf-8")
            themes = ThemeVideos(cache, bundled, lambda: None, self.fail)
            self.assertEqual(themes.status("rain")["kind"], "video")
            self.assertEqual(themes.reset("rain")["kind"], "web")
            self.assertIsNone(themes.video_path("rain"))
