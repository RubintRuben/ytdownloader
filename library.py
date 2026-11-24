"""Download gallery: remembers saved files and hides those deleted outside the app."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path

_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


class Library:
    def __init__(self, data_dir: Path):
        self.file = data_dir / "library.json"
        self.thumbs = data_dir / "thumbs"
        self.thumbs.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._items: list[dict] | None = None
        self.rev = 0

    # --- storage -------------------------------------------------------------
    def _load(self) -> list[dict]:
        if self._items is None:
            try:
                data = json.loads(self.file.read_text(encoding="utf-8"))
                self._items = [x for x in data if isinstance(x, dict) and x.get("id") and x.get("path")]
            except (OSError, ValueError):
                self._items = []
        return self._items

    def _save(self) -> None:
        self.rev += 1
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=self.file.parent, delete=False) as handle:
            json.dump(self._items or [], handle, ensure_ascii=False)
        Path(handle.name).replace(self.file)

    # --- queries -------------------------------------------------------------
    def items(self) -> list[dict]:
        """Existing files only; entries whose file vanished are pruned."""
        with self._lock:
            items = self._load()
            alive = [x for x in items if os.path.isfile(x["path"])]
            if len(alive) != len(items):
                for gone in items:
                    if gone not in alive:
                        (self.thumbs / f"{gone['id']}.jpg").unlink(missing_ok=True)
                self._items = alive
                self._save()
            for item in alive:
                try:
                    item["size"] = os.path.getsize(item["path"])
                except OSError:
                    pass
            return sorted(alive, key=lambda x: x.get("created", 0), reverse=True)

    def get(self, item_id: str) -> dict | None:
        with self._lock:
            item = next((x for x in self._load() if x["id"] == item_id), None)
            return item if item and os.path.isfile(item["path"]) else None

    # --- mutations -----------------------------------------------------------
    def add(self, path: str, meta: dict, ffmpeg: Path | None, thumb_bytes: bytes | None = None) -> dict:
        item_id = os.urandom(6).hex()
        item = {
            "id": item_id, "path": str(path), "title": meta.get("title") or Path(path).stem,
            "url": meta.get("url") or "", "source": meta.get("source") or "other",
            "format": Path(path).suffix.lstrip(".").lower(), "duration": float(meta.get("duration") or 0),
            "created": time.time(), "size": os.path.getsize(path), "height": meta.get("height"),
            "start": meta.get("start") or 0, "end": meta.get("end") or 0,
            "thumbnail": meta.get("thumbnail") or "",
        }
        if thumb_bytes:
            (self.thumbs / f"{item_id}.jpg").write_bytes(thumb_bytes)
        elif ffmpeg and item["format"] != "mp3":
            self._frame(ffmpeg, Path(path), self.thumbs / f"{item_id}.jpg", item["duration"])
        probe = probe_media(ffmpeg, Path(path)) if ffmpeg else {}
        item["duration"] = probe.get("duration") or item["duration"]
        item["height"] = probe.get("height") or item["height"]
        with self._lock:
            self._load().append(item)
            self._save()
        return item

    def remove(self, item_ids: list[str], delete_files: bool = True) -> list[str]:
        removed = []
        with self._lock:
            items = self._load()
            for item in [x for x in items if x["id"] in item_ids]:
                if delete_files and os.path.exists(item["path"]):
                    if not recycle(item["path"]):
                        continue
                items.remove(item)
                (self.thumbs / f"{item['id']}.jpg").unlink(missing_ok=True)
                removed.append(item["id"])
            self._save()
        return removed

    def rename(self, item_id: str, title: str) -> dict | None:
        clean = re.sub(r'[\\/:*?"<>|]+', "_", title).strip()[:150]
        with self._lock:
            item = self.get(item_id)
            if not item or not clean:
                return None
            source = Path(item["path"])
            target = unique_path(source.with_name(clean + source.suffix))
            source.rename(target)
            item["path"], item["title"] = str(target), clean
            self._save()
            return item

    def thumb_path(self, item_id: str) -> Path | None:
        path = self.thumbs / f"{item_id}.jpg"
        return path if path.is_file() else None

    @staticmethod
    def _frame(ffmpeg: Path, source: Path, target: Path, duration: float) -> None:
        at = max(0.0, min(3.0, (duration or 2) * 0.2))
        subprocess.run([str(ffmpeg), "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{at:.2f}",
                        "-i", str(source), "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", str(target)],
                       capture_output=True, timeout=30, creationflags=_NO_WINDOW)


def probe_media(ffmpeg: Path | None, path: Path) -> dict:
    if not ffmpeg:
        return {}
    try:
        result = subprocess.run([str(ffmpeg), "-hide_banner", "-i", str(path)], capture_output=True, text=True,
                                errors="replace", timeout=20, creationflags=_NO_WINDOW)
    except (OSError, subprocess.SubprocessError):
        return {}
    out = {}
    match = re.search(r"Duration: (\d+):(\d+):([\d.]+)", result.stderr)
    if match:
        out["duration"] = int(match[1]) * 3600 + int(match[2]) * 60 + float(match[3])
    match = re.search(r"Stream #.*Video:.*?, (\d{2,5})x(\d{2,5})", result.stderr)
    if match:
        out["width"], out["height"] = int(match[1]), int(match[2])
    return out


def unique_path(path: Path) -> Path:
    if not path.exists():
        return path
    for index in range(2, 10_000):
        candidate = path.with_name(f"{path.stem} ({index}){path.suffix}")
        if not candidate.exists():
            return candidate
    raise OSError("No free file name")


def move_into(source: Path, folder: Path, filename: str) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    target = unique_path(folder / filename)
    shutil.move(str(source), str(target))
    return target


def recycle(path: str) -> bool:
    """Move to the Windows Recycle Bin so a deletion can be undone."""
    if os.name != "nt":
        try:
            os.remove(path)
            return True
        except OSError:
            return False
    import ctypes
    from ctypes import wintypes

    class SHFILEOPSTRUCTW(ctypes.Structure):
        _fields_ = [("hwnd", wintypes.HWND), ("wFunc", wintypes.UINT), ("pFrom", wintypes.LPCWSTR),
                    ("pTo", wintypes.LPCWSTR), ("fFlags", ctypes.c_uint16), ("fAnyOperationsAborted", wintypes.BOOL),
                    ("hNameMappings", ctypes.c_void_p), ("lpszProgressTitle", wintypes.LPCWSTR)]

    # FO_DELETE, FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI
    op = SHFILEOPSTRUCTW(None, 3, os.path.abspath(path) + "\0", None, 0x40 | 0x10 | 0x4 | 0x400, False, None, None)
    return ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op)) == 0 and not os.path.exists(path)


def reveal(path: str) -> None:
    if os.name == "nt":
        subprocess.Popen(["explorer", "/select,", os.path.normpath(path)], creationflags=_NO_WINDOW)


def open_file(path: str) -> None:
    if os.name == "nt":
        os.startfile(path)  # noqa: S606 - the user's own downloaded file
