"""Custom background themes: images, videos and Wallpaper Engine wallpapers.

Each theme keeps its own media, UI colours, dimming and sound settings. Wallpaper
Engine video and web projects keep their original media. Scene imports convert the
original layers and supported effects for the app's renderer.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path

IMAGE = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
VIDEO = {".mp4", ".webm", ".mov", ".m4v", ".mkv"}
MAX_BYTES = 600 * 1024 * 1024
WE_APP_ID = "431960"
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
_COLOR = re.compile(r"#[0-9a-fA-F]{6}")


class Backgrounds:
    def __init__(self, folder: Path, load_settings, save_settings, ffmpeg, lock: threading.Lock):
        self.folder = folder
        self.load = load_settings
        self.save = save_settings
        self.ffmpeg = ffmpeg
        self.lock = lock

    # --- storage ---------------------------------------------------------------
    def themes(self) -> list[dict]:
        stored = self.load()
        themes = [t for t in stored.get("custom_themes") or [] if isinstance(t, dict) and t.get("id")]
        # migrate the single background of v2.3.0
        if stored.get("background") and not any(t.get("legacy") for t in themes):
            legacy = self.folder / stored["background"]
            if legacy.is_file():
                themes.append(self._entry(os.urandom(5).hex(), "Saját háttér", stored.get("background_kind") or "image",
                                          legacy.name, dim=stored.get("background_dim", 55), legacy=True))
                with self.lock:
                    current = self.load()
                    current["custom_themes"] = themes
                    current.pop("background", None)
                    if current.get("theme") == "custom":
                        current["theme"] = "custom:" + themes[-1]["id"]
                    self.save(current)
        return themes

    def get(self, theme_id: str) -> dict | None:
        return next((t for t in self.themes() if t["id"] == theme_id), None)

    def _write(self, themes: list[dict]) -> None:
        with self.lock:
            current = self.load()
            current["custom_themes"] = themes
            self.save(current)

    @staticmethod
    def _entry(theme_id, name, kind, file, **extra) -> dict:
        return {"id": theme_id, "name": name[:60], "kind": kind, "file": file, "accent": "", "surface": "",
                "dim": 45, "sound": False, "volume": 60, "created": time.time(), **extra}

    # --- adding ------------------------------------------------------------------
    def add_file(self, path: str, name: str | None = None, source: str = "") -> dict:
        src = Path(path)
        ext = src.suffix.lower()
        if ext not in IMAGE | VIDEO or not src.is_file():
            raise ValueError("Csak kép (jpg, png, webp, gif) vagy videó (mp4, webm, mov, mkv) lehet.")
        if src.stat().st_size > MAX_BYTES:
            raise ValueError("A fájl túl nagy (legfeljebb 600 MB).")
        theme_id = os.urandom(5).hex()
        self.folder.mkdir(parents=True, exist_ok=True)
        target = self.folder / f"{theme_id}{ext}"
        shutil.copyfile(src, target)
        kind = "video" if ext in VIDEO else "image"
        entry = self._entry(theme_id, name or src.stem, kind, target.name, source=source)
        self._thumbnail(entry)
        self._write(self.themes() + [entry])
        return entry

    def add_wallpaper_engine(self, project_dir: str) -> dict:
        folder = Path(project_dir)
        if folder.is_file():
            folder = folder.parent
        project = read_project(folder)
        if not project:
            raise ValueError("Ebben a mappában nincs Wallpaper Engine project.json.")
        kind = (project.get("type") or "").lower()
        title = project.get("title") or folder.name
        if kind == "video" and project.get("file"):
            return self.add_file(str(folder / project["file"]), title, source="Wallpaper Engine")
        if kind == "web" and project.get("file"):
            size = sum(p.stat().st_size for p in folder.rglob("*") if p.is_file())
            if size > MAX_BYTES:
                raise ValueError("Ez a web-háttér túl nagy (legfeljebb 600 MB).")
            theme_id = os.urandom(5).hex()
            target = self.folder / f"{theme_id}-web"
            shutil.copytree(folder, target)
            entry = self._entry(theme_id, title, "web", project["file"], folder=target.name, source="Wallpaper Engine",
                                properties=default_properties(project))
            self._thumbnail(entry, preview=target / (project.get("preview") or "preview.jpg"))
            self._write(self.themes() + [entry])
            return entry
        if kind == "scene":
            import wallpaper_scene
            theme_id = os.urandom(5).hex()
            target = self.folder / f"{theme_id}-scene"
            try:
                wallpaper_scene.convert(folder, target)
            except Exception as exc:
                shutil.rmtree(target, ignore_errors=True)
                raise ValueError("Ezt a 3D scene hátteret nem sikerült átalakítani.") from exc
            entry = self._entry(theme_id, title, "scene", "scene.json", folder=target.name, source="Wallpaper Engine")
            self._thumbnail(entry, preview=next(iter(sorted(target.glob("layer0.*"))), None))
            self._write(self.themes() + [entry])
            return entry
        raise ValueError("Ez a Wallpaper Engine háttér típusa nem támogatott.")

    # --- editing -------------------------------------------------------------------
    def update(self, theme_id: str, changes: dict) -> dict:
        themes = self.themes()
        theme = next((t for t in themes if t["id"] == theme_id), None)
        if not theme:
            raise KeyError(theme_id)
        if "name" in changes and str(changes["name"]).strip():
            theme["name"] = str(changes["name"]).strip()[:60]
        for key in ("accent", "surface"):
            if key in changes:
                value = str(changes[key] or "")
                theme[key] = value if _COLOR.fullmatch(value) else ""
        if "dim" in changes:
            theme["dim"] = max(0, min(90, int(changes["dim"])))
        if "volume" in changes:
            theme["volume"] = max(0, min(100, int(changes["volume"])))
        if "sound" in changes:
            theme["sound"] = bool(changes["sound"])
        if isinstance(changes.get("properties"), dict) and theme["kind"] == "web":
            theme["properties"] = {str(k)[:60]: v for k, v in list(changes["properties"].items())[:80]}
        self._write(themes)
        return theme

    def delete(self, theme_id: str) -> bool:
        themes = self.themes()
        theme = next((t for t in themes if t["id"] == theme_id), None)
        if not theme:
            return False
        if theme["kind"] in ("web", "scene"):
            shutil.rmtree(self.folder / theme.get("folder", "-missing-"), ignore_errors=True)
        else:
            (self.folder / theme["file"]).unlink(missing_ok=True)
        (self.folder / f"{theme_id}.thumb.jpg").unlink(missing_ok=True)
        self._write([t for t in themes if t["id"] != theme_id])
        with self.lock:
            current = self.load()
            if current.get("theme") == "custom:" + theme_id:
                current["theme"] = "dark"
                self.save(current)
        return True

    # --- files ---------------------------------------------------------------------
    def media_path(self, theme: dict) -> Path | None:
        path = self.folder / theme["file"] if theme["kind"] in ("image", "video") else None
        return path if path and path.is_file() else None

    def web_file(self, theme: dict, relative: str) -> Path | None:
        root = (self.folder / theme.get("folder", "-missing-")).resolve()
        target = (root / relative).resolve()
        if root not in target.parents and target != root:
            return None
        return target if target.is_file() else None

    def thumb_path(self, theme_id: str) -> Path | None:
        path = self.folder / f"{theme_id}.thumb.jpg"
        return path if path.is_file() else None

    def _thumbnail(self, theme: dict, preview: Path | None = None) -> None:
        ffmpeg = self.ffmpeg()
        source = preview if preview and preview.is_file() else self.media_path(theme)
        if not ffmpeg or not source:
            return
        command = [str(ffmpeg), "-nostdin", "-loglevel", "error", "-y"]
        if source.suffix.lower() in VIDEO:
            command += ["-ss", "1"]
        command += ["-i", str(source), "-frames:v", "1", "-vf", "scale=360:-2", "-q:v", "4",
                    str(self.folder / f"{theme['id']}.thumb.jpg")]
        subprocess.run(command, capture_output=True, timeout=30, creationflags=_NO_WINDOW)


# --- Wallpaper Engine discovery ----------------------------------------------------

def read_project(folder: Path) -> dict | None:
    try:
        return json.loads((folder / "project.json").read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None


def default_properties(project: dict) -> dict:
    props = (project.get("general") or {}).get("properties") or {}
    return {key: {"value": value.get("value")} for key, value in props.items() if isinstance(value, dict)}


def steam_libraries() -> list[Path]:
    roots: list[Path] = []
    if os.name == "nt":
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam") as key:
                roots.append(Path(winreg.QueryValueEx(key, "SteamPath")[0]))
        except OSError:
            pass
    roots.append(Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Steam")
    libraries: list[Path] = []
    for root in roots:
        vdf = root / "steamapps" / "libraryfolders.vdf"
        try:
            for match in re.finditer(r'"path"\s+"([^"]+)"', vdf.read_text(encoding="utf-8", errors="replace")):
                libraries.append(Path(match[1].replace("\\\\", "\\")))
        except OSError:
            pass
        libraries.append(root)
    unique = []
    for path in libraries:
        if path.exists() and path.resolve() not in [p.resolve() for p in unique]:
            unique.append(path)
    return unique


def discover_wallpapers() -> list[dict]:
    """Installed Wallpaper Engine items (Workshop subscriptions and the app's own projects)."""
    found = []
    folders: list[Path] = []
    for library in steam_libraries():
        folders += [p for p in (library / "steamapps" / "workshop" / "content" / WE_APP_ID).glob("*") if p.is_dir()]
        folders += [p for p in (library / "steamapps" / "common" / "wallpaper_engine" / "projects" / "myprojects").glob("*")
                    if p.is_dir()]
    for folder in folders:
        project = read_project(folder)
        if not project:
            continue
        kind = (project.get("type") or "").lower()
        preview = folder / (project.get("preview") or "")
        found.append({
            "path": str(folder), "title": project.get("title") or folder.name, "type": kind,
            "supported": kind in ("video", "web", "scene"),
            "preview": str(preview) if project.get("preview") and preview.is_file() else "",
        })
    return sorted(found, key=lambda x: (not x["supported"], x["title"].casefold()))


WEB_BRIDGE = """<script>
(() => {
  // Downloader bridge: Wallpaper Engine-style properties, mouse forwarding and mute control.
  const props = __PROPS__;
  const folder = new URL("./", location.href);
  const imageSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  // Local textures must be loaded with CORS so they can be uploaded to WebGL from this opaque origin.
  Object.defineProperty(HTMLImageElement.prototype, "src", { ...imageSrc, set(value) {
    const url = new URL(value, document.baseURI);
    if (url.origin === folder.origin && url.pathname.startsWith(folder.pathname)) this.crossOrigin = "anonymous";
    imageSrc.set.call(this, value);
  } });
  const apply = () => { try { window.wallpaperPropertyListener?.applyUserProperties?.(props); } catch (e) {} };
  window.addEventListener("load", () => setTimeout(apply, 50));
  window.wallpaperRegisterAudioListener = window.wallpaperRegisterAudioListener || (() => {});
  let muted = __MUTED__;
  const setMuted = (value) => { muted = value; document.querySelectorAll("audio,video").forEach(m => { m.muted = muted; }); };
  new MutationObserver(() => setMuted(muted)).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const data = event.data || {};
    if (data.type === "dl-mouse") {
      const x = data.x * innerWidth, y = data.y * innerHeight;
      const target = document.elementFromPoint(x, y) || document.body;
      for (const name of ["pointermove", "mousemove"]) {
        target.dispatchEvent(new (name === "pointermove" ? PointerEvent : MouseEvent)(name, { clientX: x, clientY: y, bubbles: true }));
      }
    } else if (data.type === "dl-mute") setMuted(!!data.muted);
    else if (data.type === "dl-volume") document.querySelectorAll("audio,video").forEach(m => { m.volume = data.volume; });
  });
})();
</script>"""


def inject_bridge(html: str, properties: dict, muted: bool) -> str:
    props = json.dumps(properties or {}).replace("<", r"\u003c")
    script = WEB_BRIDGE.replace("__MUTED__", "true" if muted else "false").replace("__PROPS__", props)
    match = re.search(r"<head[^>]*>", html, re.IGNORECASE)
    if match:
        return html[:match.end()] + script + html[match.end():]
    return script + html
