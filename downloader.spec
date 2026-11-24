# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec — Downloader önálló EXE.
#
# Kis méret: az ffmpeg-et NEM csomagoljuk be (azt az app első indításkor letölti),
# és a natív ablakot a Windows beépített WebView2 (Edge) motorja adja a pywebview-n
# keresztül, így nincs benne teljes Chromium. A static/ mappa és a yt-dlp belekerül.

from PyInstaller.utils.hooks import collect_submodules, collect_data_files, collect_dynamic_libs, copy_metadata
from PyInstaller.utils.win32.versioninfo import (
    FixedFileInfo, StringFileInfo, StringStruct, StringTable, VarFileInfo, VarStruct, VSVersionInfo,
)
from pathlib import Path
from runpy import run_path

version = run_path(str(Path(SPECPATH) / "version.py"))["APP_VERSION"]
version_parts = (*map(int, version.split(".")), 0)
version_info = VSVersionInfo(
    ffi=FixedFileInfo(filevers=version_parts, prodvers=version_parts),
    kids=[
        StringFileInfo([StringTable("040904B0", [
            StringStruct("FileDescription", "Downloader"),
            StringStruct("FileVersion", version),
            StringStruct("OriginalFilename", "Downloader.exe"),
            StringStruct("ProductName", "Downloader"),
            StringStruct("ProductVersion", version),
        ])]),
        VarFileInfo([VarStruct("Translation", [1033, 1200])]),
    ],
)

# A yt-dlp sok extractort dinamikusan tölt — ezeket explicit be kell húzni.
hidden = collect_submodules("yt_dlp")
hidden += collect_submodules("yt_dlp_ejs")
hidden += collect_submodules("curl_cffi")
hidden += [
    "ffmpeg_setup",             # a saját ffmpeg-letöltő modulunk
    "ig_api",                   # az Instagram guest-API kliensünk
    "yt_web", "library", "native_window", "mcp_server", "mcp_bridge",
    "uvicorn.logging", "uvicorn.loops", "uvicorn.loops.auto",
    "uvicorn.protocols", "uvicorn.protocols.http", "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl", "h11",
    "uvicorn.protocols.websockets", "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan", "uvicorn.lifespan.on",
]
# pywebview Windows-motor (WinForms + WebView2) — ezeket dinamikusan tölti
hidden += collect_submodules("webview")
hidden += ["clr_loader", "pythonnet"]

import os as _os

datas = [
    ("static", "static"),               # a frontend
    ("wallpapers", "wallpapers"),       # bundled animated theme projects
    ("icon.ico", "."),                  # az app ikonja (a natív ablakhoz, futásidőben)
]
# a session-cookie MASTER fájlok csak akkor, ha léteznek (érzékeny, nincs verziókövetésben)
# Session files stay beside the app; do not embed expiring account sessions.
datas += collect_data_files("yt_dlp")
datas += collect_data_files("yt_dlp_ejs")
datas += copy_metadata("yt-dlp-ejs")
datas += copy_metadata("curl-cffi")
datas += collect_data_files("certifi")

# A standalone build needs its own JS runtime for YouTube signature challenges.
import shutil as _shutil
_node = _shutil.which("node")
if not _node:
    raise RuntimeError("Install Node.js 22+ before building; the runtime is bundled in the EXE.")
datas.append((_node, "bin"))
# pywebview adatfájljai (pl. a WebView2 loader js)
datas += collect_data_files("webview")

a = Analysis(
    ["app.py"],
    pathex=[],
    binaries=collect_dynamic_libs("curl_cffi"),
    datas=datas,
    hiddenimports=hidden,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "numpy", "PIL", "test"],  # méret-csökkentés
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="Downloader",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,                   # tömörítés (ha az UPX elérhető)
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,              # natív app: NINCS konzolablak (saját ablakban nyílik)
    disable_windowed_traceback=False,
    icon="icon.ico",
    version=version_info,
)
