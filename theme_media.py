"""Background videos for the animated themes.

The clips are Creative Commons (CC BY) loops from YouTube. The app downloads them
itself on first use (keeps the EXE small), drops the audio and bakes a crossfade
into the end so the file loops without a visible seam.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Callable

THEME_VIDEOS = {
    "blackhole": {"id": "EuDfbQOG0-o", "title": "Black Hole Golden Disk Loop 4K", "author": "Free Dream Vault"},
    "minecraft": {"id": None, "title": "Pixeles táj (beépített)", "author": "Downloader"},
    "rain": {"id": "DRX_f7VB56I", "title": "4K Rain Drops On Window And Bokeh Lights", "author": "orangeHDcom"},
}
FADE = 1.2          # seconds of crossfade baked into the loop point
MAX_SECONDS = 30    # longer sources are cut to keep files small
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


class ThemeVideos:
    """Backgrounds of the animated themes: the bundled default, or the user's own
    video / Wallpaper Engine (video, web, scene) wallpaper."""

    def __init__(self, folder: Path, base_opts: Callable[[], dict], ffmpeg: Callable[[], Path | None], log):
        self.folder = folder
        self.base_opts = base_opts
        self.ffmpeg = ffmpeg
        self.log = log
        self.state: dict[str, dict] = {}
        self.lock = threading.Lock()

    def path(self, scene: str) -> Path:
        return self.folder / f"{scene}.mp4"

    def marker(self, scene: str) -> Path:
        return self.folder / f"{scene}.custom"

    def asset_dir(self, scene: str, kind: str) -> Path:
        return self.folder / f"{scene}-{kind}"

    def override(self, scene: str) -> dict | None:
        """{kind: video|web|scene, title, file?} of the user's own background, if any."""
        if not self.marker(scene).is_file():
            return None
        text = self.marker(scene).read_text(encoding="utf-8").strip()
        try:
            data = json.loads(text)
            if isinstance(data, dict) and data.get("kind"):
                return data
        except ValueError:
            pass
        return {"kind": "video", "title": text or "Saját videó"}

    def status(self, scene: str) -> dict:
        meta = THEME_VIDEOS[scene]
        source = {"title": meta["title"], "author": meta["author"], "license": "CC BY" if meta["id"] else "",
                  "url": f"https://www.youtube.com/watch?v={meta['id']}" if meta["id"] else "", "custom": None}
        custom = self.override(scene)
        busy = self.state.get(scene, {})
        if busy.get("state") in ("downloading", "processing"):
            return {**busy, **source, "kind": "video"}
        if custom:
            source["custom"] = custom.get("title")
            if custom["kind"] in ("web", "scene"):
                folder = self.asset_dir(scene, custom["kind"])
                if folder.is_dir():
                    return {"state": "ready", "kind": custom["kind"], "file": custom.get("file", ""),
                            "version": int(folder.stat().st_mtime), "properties": custom.get("properties") or {}, **source}
        if self.path(scene).is_file():
            return {"state": "ready", "kind": "video", "version": int(self.path(scene).stat().st_mtime), **source}
        if not meta["id"]:
            return {"state": "ready", "kind": "procedural", **source}
        return {**self.state.get(scene, {"state": "missing"}), "kind": "video", **source}

    def _clear_override(self, scene: str) -> None:
        for kind in ("web", "scene"):
            shutil.rmtree(self.asset_dir(scene, kind), ignore_errors=True)
        self.marker(scene).unlink(missing_ok=True)

    def install_custom(self, scene: str, source: Path) -> dict:
        """Use the user's own clip for an animated theme (baked into a seamless, silent loop)."""
        with self.lock:
            if self.state.get(scene, {}).get("state") in ("downloading", "processing"):
                return self.status(scene)
            self.state[scene] = {"state": "processing", "progress": 100}

        def work():
            temporary = self.folder / f"{scene}.tmp.mp4"
            try:
                ffmpeg = self.ffmpeg()
                if not ffmpeg:
                    raise RuntimeError("ffmpeg is not available")
                self.folder.mkdir(parents=True, exist_ok=True)
                bake_loop(ffmpeg, source, temporary)
                self._clear_override(scene)
                os.replace(temporary, self.path(scene))
                self.marker(scene).write_text(json.dumps({"kind": "video", "title": source.stem}), encoding="utf-8")
                self.state[scene] = {"state": "ready"}
            except Exception as exc:  # noqa: BLE001
                temporary.unlink(missing_ok=True)
                self.log(f"Custom theme video {scene} failed: {exc}")
                self.state[scene] = {"state": "error", "message": "Ezt a videót nem sikerült átalakítani."}
        threading.Thread(target=work, daemon=True).start()
        return self.status(scene)

    def install_wallpaper(self, scene: str, project_dir: Path) -> dict:
        """A Wallpaper Engine wallpaper (video, web or scene) as this animated theme's background."""
        import wallpaper_scene
        project = json.loads((project_dir / "project.json").read_text(encoding="utf-8-sig"))
        kind = (project.get("type") or "").lower()
        title = project.get("title") or project_dir.name
        if kind == "video" and project.get("file"):
            return self.install_custom(scene, project_dir / project["file"])
        self.folder.mkdir(parents=True, exist_ok=True)
        if kind == "web" and project.get("file"):
            self._clear_override(scene)
            shutil.copytree(project_dir, self.asset_dir(scene, "web"))
            props = {k: {"value": v.get("value")} for k, v in ((project.get("general") or {}).get("properties") or {}).items()
                     if isinstance(v, dict)}
            self.marker(scene).write_text(json.dumps({"kind": "web", "title": title, "file": project["file"],
                                                      "properties": props}), encoding="utf-8")
        elif kind == "scene":
            target = self.asset_dir(scene, "scene")
            staging = self.folder / f"{scene}-scene.tmp"
            wallpaper_scene.convert(project_dir, staging)
            self._clear_override(scene)
            staging.rename(target)
            self.marker(scene).write_text(json.dumps({"kind": "scene", "title": title}), encoding="utf-8")
        else:
            raise ValueError("Ez a Wallpaper Engine háttér típusa nem támogatott.")
        return self.status(scene)

    def asset(self, scene: str, relative: str) -> Path | None:
        custom = self.override(scene)
        if not custom or custom["kind"] not in ("web", "scene"):
            return None
        root = self.asset_dir(scene, custom["kind"]).resolve()
        target = (root / relative).resolve()
        if root not in target.parents or not target.is_file():
            return None
        return target

    def ensure(self, scene: str) -> dict:
        with self.lock:
            current = self.state.get(scene, {}).get("state")
            needs_download = THEME_VIDEOS[scene]["id"] and not self.override(scene) and not self.path(scene).is_file()
            if needs_download and current not in ("downloading", "processing"):
                self.state[scene] = {"state": "downloading", "progress": 0}
                threading.Thread(target=self._prepare, args=(scene,), daemon=True).start()
        return self.status(scene)

    def reset(self, scene: str) -> dict:
        """Back to the bundled default background."""
        self._clear_override(scene)
        self.path(scene).unlink(missing_ok=True)
        self.state.pop(scene, None)
        return self.ensure(scene)

    def _prepare(self, scene: str) -> None:
        from yt_dlp import YoutubeDL
        from yt_dlp.utils import download_range_func

        work = Path(tempfile.mkdtemp(prefix=f"theme_{scene}_"))
        try:
            ffmpeg = self.ffmpeg()
            if not ffmpeg:
                raise RuntimeError("ffmpeg is not available")

            def progress(data):
                total = data.get("total_bytes") or data.get("total_bytes_estimate") or 0
                if total:
                    self.state[scene] = {"state": "downloading", "progress": round(100 * data.get("downloaded_bytes", 0) / total)}

            opts = self.base_opts()
            opts.update({
                "outtmpl": str(work / "source.%(ext)s"),
                "format": "bv[height<=1080][vcodec^=avc1]/bv[height<=1080]/b[height<=1080]",
                "progress_hooks": [progress], "noprogress": True, "ffmpeg_location": str(ffmpeg),
                "download_ranges": download_range_func(None, [(0, MAX_SECONDS)]),
            })
            with YoutubeDL(opts) as ydl:
                ydl.download([f"https://www.youtube.com/watch?v={THEME_VIDEOS[scene]['id']}"])
            sources = [p for p in work.glob("source.*") if p.suffix not in (".part", ".ytdl")]
            if not sources:
                raise RuntimeError("download produced no file")
            self.state[scene] = {"state": "processing", "progress": 100}
            self.folder.mkdir(parents=True, exist_ok=True)
            output = work / "loop.mp4"
            bake_loop(ffmpeg, sources[0], output)
            os.replace(output, self.path(scene))
            self.state[scene] = {"state": "ready"}
        except Exception as exc:  # noqa: BLE001 - the procedural scene stays as fallback
            self.log(f"Theme video {scene} failed: {type(exc).__name__}: {str(exc)[:160]}")
            self.state[scene] = {"state": "error", "message": "A háttérvideó nem tölthető le most."}
        finally:
            shutil.rmtree(work, ignore_errors=True)


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
    if length < fade * 3:
        shutil.copyfile(source, output)
        return
    graph = (f"[0:v]split[a][b];"
             f"[a]trim=start={fade}:end={length},setpts=PTS-STARTPTS[main];"
             f"[b]trim=start=0:end={fade},setpts=PTS-STARTPTS[head];"
             f"[main][head]xfade=transition=fade:duration={fade}:offset={length - 2 * fade:.3f},"
             f"scale='min(1920,iw)':-2,format=yuv420p[v]")
    command = [str(ffmpeg), "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(source),
               "-filter_complex", graph, "-map", "[v]"]
    if audio:
        command += ["-map", "0:a:0?", "-t", f"{length - fade:.3f}", "-c:a", "aac", "-b:a", "160k"]
    else:
        command += ["-an"]
    command += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-movflags", "+faststart", str(output)]
    result = subprocess.run(command, capture_output=True, text=True, errors="replace", creationflags=_NO_WINDOW)
    if result.returncode or not output.exists():
        raise RuntimeError("loop encode failed: " + result.stderr[-300:])
