"""Bundled Wallpaper Engine projects for the animated themes."""
from __future__ import annotations

import tempfile
import threading
from pathlib import Path

import backgrounds
import wallpaper_scene
from version import APP_VERSION

DEFAULT_PROJECTS = {
    "blackhole": "2934185571",
    "minecraft": "2078716698",
    "rain": "1218076433",
}


class BundledThemes:
    def __init__(self, folder: Path, bundled: Path, log):
        self.folder = folder
        self.bundled = bundled
        self.log = log
        self.lock = threading.Lock()

    def _scene_cache(self, scene: str) -> Path:
        return self.folder / f"{scene}-bundled-{APP_VERSION}"

    def project(self, scene: str) -> tuple[Path, dict]:
        source = self.bundled / scene
        project = backgrounds.read_project(source) or {}
        kind = project.get("type")
        return (self._scene_cache(scene) if kind == "scene" else source), {
            "kind": kind,
            "title": project.get("title", scene),
            "file": project.get("file", ""),
            "preview": project.get("preview", ""),
            "properties": backgrounds.default_properties(project),
        }

    def status(self, scene: str) -> dict:
        root, project = self.project(scene)
        source = {"title": project["title"], "kind": project["kind"],
                  "url": f"https://steamcommunity.com/sharedfiles/filedetails/?id={DEFAULT_PROJECTS[scene]}"}
        file = project["file"]
        if file and (root / file).is_file():
            return {**source, "state": "ready", "file": file, "version": APP_VERSION}
        if project["kind"] == "scene" and (self.bundled / scene / "scene.pkg").is_file():
            return {**source, "state": "available"}
        return {**source, "state": "error", "message": "A háttér fájljai nem érhetők el."}

    def asset(self, scene: str, relative: str) -> tuple[Path, dict] | None:
        root, project = self.project(scene)
        root = root.resolve()
        target = (root / relative).resolve()
        if root in target.parents and target.is_file():
            return target, project
        return None

    def preview(self, scene: str) -> Path | None:
        _, project = self.project(scene)
        root = (self.bundled / scene).resolve()
        preview = (root / project["preview"]).resolve()
        return preview if root in preview.parents and preview.is_file() else None

    def ensure(self, scene: str) -> dict:
        with self.lock:
            status = self.status(scene)
            if status["state"] != "available":
                return status
            try:
                self.folder.mkdir(parents=True, exist_ok=True)
                with tempfile.TemporaryDirectory(dir=self.folder) as folder:
                    staging = Path(folder) / "scene"
                    wallpaper_scene.convert(self.bundled / scene, staging)
                    staging.rename(self._scene_cache(scene))
            except (OSError, ValueError, KeyError) as exc:
                # A second app instance may have prepared the same immutable cache.
                status = self.status(scene)
                if status["state"] == "ready":
                    return status
                self.log(f"Bundled wallpaper {scene} failed: {exc}")
                return {**status, "state": "error", "message": "A jelenetet nem sikerült előkészíteni."}
            return self.status(scene)
