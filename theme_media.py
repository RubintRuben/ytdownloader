"""Bundled Wallpaper Engine projects and user overrides for the animated themes."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
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

FADE = 1.2
MAX_SECONDS = 30
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


class ThemeVideos:
    def __init__(self, folder: Path, bundled: Path, ffmpeg, log):
        self.folder = folder
        self.bundled = bundled
        self.ffmpeg = ffmpeg
        self.log = log
        self.state: dict[str, dict] = {}
        self.lock = threading.RLock()

    def marker(self, scene: str) -> Path:
        return self.folder / f"{scene}.custom"

    def override(self, scene: str) -> dict | None:
        try:
            text = self.marker(scene).read_text(encoding="utf-8").strip()
        except FileNotFoundError:
            return None
        try:
            data = json.loads(text)
            if isinstance(data, dict) and data.get("kind") in ("video", "web", "scene"):
                return data
        except ValueError:
            pass
        return {"kind": "video", "title": text or "Saját videó"}

    def _override_folder(self, scene: str, custom: dict) -> Path:
        return self.folder / custom.get("folder", f"{scene}-{custom['kind']}")

    def video_path(self, scene: str) -> Path | None:
        custom = self.override(scene)
        if custom and custom["kind"] == "video":
            path = self._override_folder(scene, custom) / "loop.mp4" if custom.get("folder") else self.folder / f"{scene}.mp4"
            return path if path.is_file() else None
        return None

    def _bundled_scene(self, scene: str) -> Path:
        return self.folder / f"{scene}-bundled-{APP_VERSION}"

    def project(self, scene: str) -> tuple[Path, dict]:
        custom = self.override(scene)
        if custom:
            return self._override_folder(scene, custom), custom
        source = self.bundled / scene
        project = backgrounds.read_project(source) or {}
        kind = project.get("type")
        return (self._bundled_scene(scene) if kind == "scene" else source), {
            "kind": kind,
            "title": project.get("title", scene),
            "file": project.get("file", ""),
            "preview": project.get("preview", ""),
            "properties": backgrounds.default_properties(project),
        }

    def status(self, scene: str) -> dict:
        with self.lock:
            root, project = self.project(scene)
            custom = self.override(scene)
            source = {"title": project["title"], "kind": project["kind"], "custom": custom and custom["title"],
                      "url": "" if custom else f"https://steamcommunity.com/sharedfiles/filedetails/?id={DEFAULT_PROJECTS[scene]}"}
            busy = self.state.get(scene)
            if busy and busy["state"] == "processing":
                return {**source, **busy}
            kind = project["kind"]
            file = project.get("file") or "scene.json"
            path = self.video_path(scene) if kind == "video" else root / file
            if path and path.is_file():
                return {**source, "state": "ready", "file": file, "version": path.stat().st_mtime_ns // 1000000,
                        **({"message": busy["message"]} if busy else {})}
            if not custom and kind == "scene" and (self.bundled / scene / "scene.pkg").is_file():
                return {**source, "state": "available", **({"message": busy["message"]} if busy else {})}
            return {**source, "state": "error", "message": "A háttér fájljai nem érhetők el."}

    def asset(self, scene: str, relative: str) -> tuple[Path, dict] | None:
        with self.lock:
            root, project = self.project(scene)
            if project["kind"] not in ("web", "scene"):
                return None
            root = root.resolve()
            target = (root / relative).resolve()
            if root in target.parents and target.is_file():
                return target, project
            return None

    def preview(self, scene: str) -> Path | None:
        with self.lock:
            root, project = self.project(scene)
            if not self.override(scene):
                root = self.bundled / scene
            root = root.resolve()
            preview = (root / project["preview"]).resolve() if project.get("preview") else None
            if not preview and project["kind"] == "scene":
                preview = next(iter(root.glob("layer0.*")), None)
            return preview if preview and root in preview.parents and preview.is_file() else None

    def ensure(self, scene: str) -> dict:
        with self.lock:
            if self.status(scene)["state"] == "available":
                try:
                    self.folder.mkdir(parents=True, exist_ok=True)
                    with tempfile.TemporaryDirectory(dir=self.folder) as folder:
                        staging = Path(folder) / "scene"
                        wallpaper_scene.convert(self.bundled / scene, staging)
                        staging.rename(self._bundled_scene(scene))
                except (OSError, ValueError, KeyError) as exc:
                    self.log(f"Bundled wallpaper {scene} failed: {exc}")
                    return {**self.status(scene), "state": "error", "message": "A jelenetet nem sikerült előkészíteni."}
            return self.status(scene)

    def _publish(self, scene: str, folder: Path, metadata: dict) -> None:
        previous = self.override(scene)
        temporary_marker = folder / "theme.custom"
        temporary_marker.write_text(json.dumps({**metadata, "folder": folder.name}), encoding="utf-8")
        os.replace(temporary_marker, self.marker(scene))
        if previous and (previous["kind"] in ("web", "scene") or previous.get("folder")):
            shutil.rmtree(self._override_folder(scene, previous), ignore_errors=True)

    def install_custom(self, scene: str, source: Path) -> dict:
        """Bake a user-supplied video into a silent loop in the background."""
        with self.lock:
            if self.state.get(scene, {}).get("state") == "processing":
                raise ValueError("Ennek a témának a háttere már készül.")
            self.folder.mkdir(parents=True, exist_ok=True)
            self.state[scene] = {"state": "processing"}

        def work():
            folder = None
            try:
                ffmpeg = self.ffmpeg()
                if not ffmpeg:
                    raise RuntimeError("ffmpeg is not available")
                folder = Path(tempfile.mkdtemp(prefix=f"{scene}-video-", dir=self.folder))
                bake_loop(ffmpeg, source, folder / "loop.mp4")
                with self.lock:
                    self._publish(scene, folder, {"kind": "video", "title": source.stem})
                    self.state.pop(scene, None)
            except Exception as exc:
                if folder:
                    shutil.rmtree(folder, ignore_errors=True)
                self.log(f"Custom theme video {scene} failed: {exc}")
                with self.lock:
                    self.state[scene] = {"state": "error", "message": "Ezt a videót nem sikerült átalakítani."}

        threading.Thread(target=work, daemon=True).start()
        return self.status(scene)

    def install_wallpaper(self, scene: str, project_dir: Path) -> dict:
        project = backgrounds.read_project(project_dir)
        if not project:
            raise ValueError("Ebben a mappában nincs Wallpaper Engine project.json.")
        kind = (project.get("type") or "").lower()
        file = project.get("file", "")
        title = project.get("title") or project_dir.name
        if kind == "video" and file:
            return self.install_custom(scene, project_dir / file)
        if kind not in ("scene", "web"):
            raise ValueError("Ez a Wallpaper Engine háttér típusa nem támogatott.")
        with self.lock:
            if self.state.get(scene, {}).get("state") == "processing":
                raise ValueError("Ennek a témának a háttere már készül.")
            self.folder.mkdir(parents=True, exist_ok=True)
            folder = Path(tempfile.mkdtemp(prefix=f"{scene}-{kind}-", dir=self.folder))
            try:
                metadata = {"kind": kind, "title": title}
                if kind == "web":
                    if not file or not (project_dir / file).is_file():
                        raise ValueError("A web-háttér indítófájlja hiányzik.")
                    shutil.copytree(project_dir, folder, dirs_exist_ok=True)
                    metadata.update(file=file, preview=project.get("preview", ""), properties=backgrounds.default_properties(project))
                else:
                    try:
                        wallpaper_scene.convert(project_dir, folder)
                    except (OSError, ValueError, KeyError) as exc:
                        raise ValueError("Ezt a 3D scene hátteret nem sikerült átalakítani.") from exc
                self._publish(scene, folder, metadata)
                self.state.pop(scene, None)
            except Exception:
                shutil.rmtree(folder, ignore_errors=True)
                raise
            return self.status(scene)

    def reset(self, scene: str) -> dict:
        with self.lock:
            if self.state.get(scene, {}).get("state") == "processing":
                raise ValueError("Ennek a témának a háttere már készül.")
            previous = self.override(scene)
            self.marker(scene).unlink(missing_ok=True)
            if previous and (previous["kind"] in ("web", "scene") or previous.get("folder")):
                shutil.rmtree(self._override_folder(scene, previous), ignore_errors=True)
            self.state.pop(scene, None)
            return self.ensure(scene)


def probe_duration(ffmpeg: Path, path: Path) -> float:
    result = subprocess.run([str(ffmpeg), "-hide_banner", "-i", str(path)], capture_output=True, text=True,
                            errors="replace", creationflags=_NO_WINDOW)
    import re
    match = re.search(r"Duration: (\d+):(\d+):([\d.]+)", result.stderr)
    return int(match[1]) * 3600 + int(match[2]) * 60 + float(match[3]) if match else 0.0


def bake_loop(ffmpeg: Path, source: Path, output: Path, fade: float = FADE, audio: bool = False) -> None:
    """Make the end crossfade into the start: playing with `loop` then shows no jump.

    The result starts at `fade`, and its last `fade` seconds blend the original end
    into the original start, which continues exactly where the file begins again.
    """
    length = min(probe_duration(ffmpeg, source), float(MAX_SECONDS))
    command = [str(ffmpeg), "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(source)]
    if length < fade * 3:
        command += ["-map", "0:v:0", "-vf", "scale='min(1920,iw)':-2,format=yuv420p"]
    else:
        graph = (f"[0:v]fps=30,split[a][b];"
                 f"[a]trim=start={fade}:end={length},setpts=PTS-STARTPTS[main];"
                 f"[b]trim=start=0:end={fade},setpts=PTS-STARTPTS[head];"
                 f"[main][head]xfade=transition=fade:duration={fade}:offset={length - 2 * fade:.3f},"
                 f"scale='min(1920,iw)':-2,format=yuv420p[v]")
        command += ["-filter_complex", graph, "-map", "[v]"]
    if audio:
        command += ["-map", "0:a:0?", "-shortest", "-c:a", "aac", "-b:a", "160k"]
    else:
        command += ["-an"]
    command += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-movflags", "+faststart", str(output)]
    result = subprocess.run(command, capture_output=True, text=True, errors="replace", creationflags=_NO_WINDOW)
    if result.returncode or not output.exists():
        raise RuntimeError("loop encode failed: " + result.stderr[-300:])
