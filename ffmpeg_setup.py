"""
ffmpeg_setup.py - downloads ffmpeg.exe into bin/ when it is missing.

The packaged EXE stays small; ffmpeg is downloaded once on first run.
"""
import os
import sys
import zipfile
import tempfile
from pathlib import Path

import httpx

_GH_API = "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest"


def _resolve_ffmpeg_url() -> str:
    """Return the latest BtbN win64 static GPL ffmpeg ZIP URL."""
    r = httpx.get(
        _GH_API,
        follow_redirects=True,
        timeout=30,
        headers={"Accept": "application/vnd.github+json"},
    )
    r.raise_for_status()
    assets = r.json().get("assets", [])
    for asset in assets:
        name = asset.get("name", "")
        if "win64-gpl" in name and "shared" not in name and name.endswith(".zip"):
            return asset["browser_download_url"]
    for asset in assets:
        name = asset.get("name", "")
        if "win64" in name and name.endswith(".zip"):
            return asset["browser_download_url"]
    raise RuntimeError("No downloadable ffmpeg build was found.")


def ensure_ffmpeg(bin_dir: Path, progress=None) -> Path | None:
    """Return ffmpeg.exe path; download it on Windows when missing.

    progress can be callback(message: str) or callback(message: str, pct: int | None).
    """
    bin_dir.mkdir(parents=True, exist_ok=True)
    exe_name = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    exe_path = bin_dir / exe_name

    if exe_path.exists():
        return exe_path

    if os.name != "nt":
        _emit(progress, "Install ffmpeg with your system package manager.", None)
        return None

    tmp_zip = Path(tempfile.gettempdir()) / "downloader_ffmpeg.zip"

    try:
        _emit(progress, "Letoltesi link keresese", 5)
        url = _resolve_ffmpeg_url()

        _emit(progress, "ffmpeg letoltese", 8)
        with httpx.stream("GET", url, follow_redirects=True, timeout=60) as r:
            r.raise_for_status()
            total = int(r.headers.get("Content-Length", 0))
            done = 0
            with open(tmp_zip, "wb") as f:
                for chunk in r.iter_bytes(chunk_size=1 << 16):
                    if not chunk:
                        continue
                    f.write(chunk)
                    done += len(chunk)
                    if total:
                        pct = min(88, 8 + done * 80 // total)
                        _emit(progress, "ffmpeg letoltese", pct)
                    elif progress:
                        _emit(progress, "ffmpeg letoltese", None)
                    else:
                        sys.stdout.write(".")
                        sys.stdout.flush()

        if not progress:
            print()
        _emit(progress, "Kicsomagolas", 92)

        with zipfile.ZipFile(tmp_zip) as z:
            ff_member = next(
                (m for m in z.namelist() if m.lower().endswith("/bin/ffmpeg.exe")),
                None,
            )
            if not ff_member:
                ff_member = next(
                    (m for m in z.namelist() if m.lower().endswith("ffmpeg.exe")),
                    None,
                )
            if not ff_member:
                raise RuntimeError("ffmpeg.exe was not found in the archive.")
            with z.open(ff_member) as src, open(exe_path, "wb") as dst:
                dst.write(src.read())

        _emit(progress, "ffmpeg kesz", 100)
        return exe_path
    except Exception as e:  # noqa: BLE001
        _emit(progress, f"HIBA az ffmpeg letoltesekor: {e}", None)
        return None
    finally:
        try:
            tmp_zip.unlink(missing_ok=True)
        except Exception:
            pass


def _emit(progress, message: str, pct: int | None = None) -> None:
    if progress:
        try:
            progress(message, pct)
        except TypeError:
            progress(message)
    else:
        print(message, flush=True)
