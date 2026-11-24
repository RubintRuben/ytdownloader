import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from webview.util import parse_file_type

from app import _NativeApi

from theme_media import BundledThemes


class ThemeMediaTests(unittest.TestCase):
    def test_bundled_workshop_projects_are_the_defaults(self):
        bundled = Path(__file__).resolve().parents[1] / "wallpapers"
        with tempfile.TemporaryDirectory() as folder:
            cache = Path(folder)
            (cache / "rain.mp4").write_bytes(b"old cached download")
            themes = BundledThemes(cache, bundled, self.fail)
            for scene, kind in (("rain", "web"), ("minecraft", "scene"), ("blackhole", "scene")):
                with self.subTest(scene=scene):
                    status = themes.ensure(scene)
                    self.assertEqual((status["state"], status["kind"]), ("ready", kind))
                    self.assertTrue(themes.asset(scene, status["file"]))
                    self.assertTrue(themes.preview(scene))

    def test_legacy_override_does_not_replace_the_bundled_wallpaper(self):
        bundled = Path(__file__).resolve().parents[1] / "wallpapers"
        with tempfile.TemporaryDirectory() as folder:
            cache = Path(folder)
            (cache / "rain.mp4").write_bytes(b"legacy custom clip")
            (cache / "rain.custom").write_text("My video", encoding="utf-8")
            themes = BundledThemes(cache, bundled, self.fail)
            self.assertEqual(themes.ensure("rain")["kind"], "web")
            self.assertEqual(themes.asset("rain", "index.html")[0], bundled / "rain" / "index.html")
            self.assertEqual((cache / "rain.mp4").read_bytes(), b"legacy custom clip")


class BackgroundPickerTests(unittest.TestCase):
    def test_native_picker_uses_webview_compatible_filters(self):
        api = _NativeApi()
        window = Mock()
        window.create_file_dialog.return_value = None
        api._window = window
        for project, expected in ((False, {".jpg", ".mp4", ".webm"}), (True, {".json"})):
            with self.subTest(project=project):
                self.assertEqual(api.pick_background(project), {"ok": False})
                filters = window.create_file_dialog.call_args.kwargs["file_types"]
                extensions = {pattern[1:] for f in filters for pattern in parse_file_type(f)[1].split(";")}
                self.assertLessEqual(expected, extensions)
