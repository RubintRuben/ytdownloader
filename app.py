"""
Downloader — YouTube + Instagram letöltő (FastAPI backend + natív ablak).

Helyben fut: a Python szerver kiszolgálja a frontendet ÉS az API-t. A felület
egy natív, keret nélküli asztali ablakban nyílik meg (pywebview / WebView2),
NEM a böngészőben. EXE-be csomagolható (PyInstaller).

Végpontok:
  GET  /                       -> a frontend (static/index.html)
  GET  /api/search             -> YouTube keresés cím alapján (több találat)
  GET  /api/info               -> cím, thumbnail, csatorna, hossz, felbontások, storyboard
  GET  /api/estimate           -> becsült fájlméret (formátum/minőség/vágás szerint)
  GET  /api/storyboard         -> a videó storyboard képének proxyja (timeline kockák)
  GET  /api/thumb              -> thumbnail proxy
  POST /api/prepare            -> letöltési job indítása (job_id-t ad)
  GET  /api/progress/{job_id}  -> SSE élő progress
  GET  /api/file/{job_id}      -> a kész fájl letöltése (utána takarít)
"""
import os
import re
import sys

if __name__ == "__main__" and "--mcp" in sys.argv[1:]:
    import mcp_bridge  # lightweight: no yt-dlp/server imports for the MCP relay
    raise SystemExit(mcp_bridge.main())
import json
import base64
import shutil
import socket
import asyncio
import tempfile
import threading
import urllib.parse
import subprocess
import time
import math
import atexit
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
from fastapi import FastAPI, Query, HTTPException, Request
from fastapi.responses import (
    StreamingResponse,
    FileResponse,
    Response,
)
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask
from yt_dlp import YoutubeDL
from yt_dlp.networking import Request as MediaRequest
from yt_dlp.networking.exceptions import HTTPError as MediaHTTPError, RequestError as MediaRequestError
from yt_dlp.networking.impersonate import ImpersonateTarget
from yt_dlp.utils import download_range_func
import backgrounds
import library as media_library
import theme_media
import mcp_server
import yt_web
from updater import DesktopUpdater
from version import APP_VERSION


if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8")


def _resource_dir() -> Path:
    """A statikus fájlok helye — EXE-ben (PyInstaller) a _MEIPASS, különben a szkript mappája."""
    if getattr(sys, "frozen", False):          # PyInstaller EXE
        return Path(sys._MEIPASS)              # type: ignore[attr-defined]
    return Path(__file__).resolve().parent


def _app_dir() -> Path:
    """Az EXE/szkript tényleges mappája (ide kerülhet a bin/ a binárisokkal)."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


BASE_DIR = _resource_dir()
APP_DIR = _app_dir()
STATIC_DIR = BASE_DIR / "static"
TMP_DIR = Path(tempfile.mkdtemp(prefix="downloader_app_"))
atexit.register(shutil.rmtree, TMP_DIR, ignore_errors=True)
USER_DATA_DIR = Path(os.environ.get("APPDATA") or APP_DIR) / "Downloader"
USER_DATA_DIR.mkdir(parents=True, exist_ok=True)
SETTINGS_FILE = USER_DATA_DIR / "settings.json"
LOG_FILE = USER_DATA_DIR / "downloader.log"
_SHORTCUT_ANSWERED_KEY = "shortcut_answered"
_SHORTCUT_CREATED_KEY = "shortcut_created"
_THEMES = {"light", "dark", "aurora", "ocean", "ember", "orchid", "graphite", "blackhole", "minecraft", "rain", "custom"}
_ICON_THEME = {"blackhole": "graphite", "minecraft": "aurora", "rain": "ocean", "custom": "dark"}
SERVER_FILE = USER_DATA_DIR / "server.json"
BACKGROUND_DIR = USER_DATA_DIR / "backgrounds"
_library = media_library.Library(USER_DATA_DIR)
_updater = DesktopUpdater(LOG_FILE)
_job_admission = threading.Lock()

# Each process owns its temporary files; a second window must not delete downloads.
_download_pool = ThreadPoolExecutor(max_workers=3, thread_name_prefix="download")


def _ensure_ffmpeg_on_path() -> Path | None:
    """Gondoskodik róla, hogy az ffmpeg elérhető legyen a PATH-on.

    Sorrend:
    1) ha az EXE/szkript melletti bin/ mappában már megvan, azt használjuk
    2) különben (Windowson) automatikusan letöltjük a bin/ mappába (egyszeri)
    A yt-dlp `download_ranges` (vágás) csak PATH-on lévő ffmpeg-et lát, ezért a PATH elejére tesszük.
    """
    from ffmpeg_setup import ensure_ffmpeg

    bin_dir = APP_DIR / "bin"
    # ha már van a melléktelt bin-ben (akár a BASE_DIR-ben), használjuk azt
    for d in (APP_DIR / "bin", BASE_DIR / "bin"):
        exe = d / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
        if exe.exists():
            os.environ["PATH"] = str(d) + os.pathsep + os.environ.get("PATH", "")
            os.environ["FFMPEG_LOCATION"] = str(exe)
            return exe

    if executable := shutil.which("ffmpeg"):
        return Path(executable)

    # nincs meg → letöltjük (Windowson)
    exe = ensure_ffmpeg(bin_dir)
    if exe:
        os.environ["PATH"] = str(bin_dir) + os.pathsep + os.environ.get("PATH", "")
        os.environ["FFMPEG_LOCATION"] = str(exe)
        return exe
    return None


app = FastAPI(title="Downloader")

# ----------------------------------------------------------------------------
# Segédfüggvények
# ----------------------------------------------------------------------------

_YT_HOSTS = {"youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}
_IG_HOSTS = {"instagram.com", "instagr.am", "ig.me"}
_TIKTOK_HOSTS = {"tiktok.com", "vm.tiktok.com", "vt.tiktok.com", "m.tiktok.com"}


def _host_of(url: str) -> str:
    try:
        u = urllib.parse.urlparse(url)
        return (u.hostname or "").lower().removeprefix("www.")
    except Exception:
        return ""


def is_valid_youtube_url(url: str) -> bool:
    return _host_of(url) in _YT_HOSTS


def is_valid_instagram_url(url: str) -> bool:
    h = _host_of(url)
    return h in _IG_HOSTS or h.endswith(".instagram.com")


def is_valid_tiktok_url(url: str) -> bool:
    return _host_of(url) in _TIKTOK_HOSTS


def _source_for_url(url: str) -> str:
    for source, matches in (("youtube", is_valid_youtube_url), ("instagram", is_valid_instagram_url),
                            ("tiktok", is_valid_tiktok_url)):
        if matches(url):
            return source
    return "other"


def is_http_url(url: str) -> bool:
    try:
        u = urllib.parse.urlparse(url)
        return u.scheme in ("http", "https") and bool(u.hostname) and not (u.username or u.password)
    except Exception:
        return False


def is_supported_url(url: str) -> bool:
    # Univerzális: bármilyen http(s) link mehet — a yt-dlp ~1800 oldalt támogat
    # (YouTube, Instagram, TikTok, X/Twitter, Facebook, Vimeo, Reddit, …).
    return is_http_url(url)


def validate_source_url(url: str, source: str = "any"):
    if not is_supported_url(url):
        raise HTTPException(400, "Érvénytelen videólink.")
    if source not in ("any", "youtube", "instagram", "tiktok"):
        raise HTTPException(400, "Ismeretlen forrás.")
    if source == "youtube" and not is_valid_youtube_url(url):
        raise HTTPException(400, "A YouTube részen csak YouTube-linket adhatsz meg.")
    if source == "instagram" and not is_valid_instagram_url(url):
        raise HTTPException(400, "Az Instagram részen csak Instagram-linket adhatsz meg.")
    if source == "tiktok" and not is_valid_tiktok_url(url):
        raise HTTPException(400, "A TikTok részen csak TikTok-linket adhatsz meg.")


def sanitize_filename(name: str) -> str:
    name = re.sub(r'[\\/:*?"<>|]+', "_", name).strip()
    return (name[:150] or "video").strip()


# Egyszerű info-cache, hogy ne hívjuk feleslegesen a yt-dlp-t.
_info_cache: dict[str, tuple[float, dict]] = {}

# Megosztott HTTP-kliens a kép-proxyhoz: újrahasznált kapcsolatok (connection pool) →
# sokkal gyorsabb sok thumbnail/profilkép egyidejű betöltésekor. Lazy-n jön létre.
_img_client: "httpx.AsyncClient | None" = None
# Letöltött képek memória-cache-e (url -> (content_type, bytes)) — azonnali ismételt kiszolgálás.
_img_cache: "dict[str, tuple[str, bytes]]" = {}
_IMG_CACHE_MAX = 400


def _get_img_client() -> "httpx.AsyncClient":
    global _img_client
    if _img_client is None:
        _img_client = httpx.AsyncClient(
            timeout=httpx.Timeout(12.0, connect=6.0),
            follow_redirects=True,
            limits=httpx.Limits(max_connections=32, max_keepalive_connections=16),
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                                   "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"},
        )
    return _img_client


def _base_opts() -> dict:
    """Közös yt-dlp opciók (helyi futtatáshoz)."""
    runtimes = {}
    for name in ("node", "deno"):
        bundled = next((p for p in (BASE_DIR / "bin" / f"{name}.exe", APP_DIR / "bin" / f"{name}.exe") if p.exists()), None)
        executable = str(bundled) if bundled else shutil.which(name)
        if executable:
            runtimes[name] = {"path": executable}
    return {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "js_runtimes": runtimes,
        "socket_timeout": 15,
        "retries": 2,
        "extractor_retries": 2,
    }


def _ig_cookiefile() -> str | None:
    """A yt-dlp-nek adandó IG cookies.txt — a beépített master ÍRHATÓ MÁSOLATA.
    (A mastert sosem adjuk a yt-dlp-nek, mert felülírná és kitörölné a sessionid-t.)"""
    import ig_api
    return ig_api.cookie_copy_for_ytdlp()


def _apply_ig_auth(opts: dict, browser: str | None) -> None:
    """Instagram autentikáció a beépített session-cookie-val."""
    cf = _ig_cookiefile()
    if cf:
        opts["cookiefile"] = cf


def _yt_master_path() -> Path | None:
    """A beépített YouTube session-cookie MASTER fájl útja (EXE-ben a _MEIPASS-ból is).

    Egy mellék/alt fiók bejelentkezett cookie-jaival — ezzel a YouTube bot-blokkját
    („a videó nem áll rendelkezésre") kerüljük meg. A mastert SOSEM adjuk a yt-dlp-nek
    közvetlenül (felülírná); mindig friss, írható MÁSOLATOT készítünk."""
    name = "yt_session_master.txt"
    for base in (getattr(sys, "_MEIPASS", None), str(BASE_DIR), str(APP_DIR)):
        if base:
            p = Path(base) / name
            if p.exists():
                return p
    return None


def _yt_cookiefile() -> str | None:
    """A yt-dlp-nek adandó YouTube cookies.txt — a beépített master ÍRHATÓ MÁSOLATA.
    (A yt-dlp menet közben frissítheti a cookie-kat, ezért nem a mastert adjuk neki.)"""
    master = _yt_master_path()
    if not master:
        return None
    dst = Path(tempfile.gettempdir()) / "downloader_yt_cookies.txt"
    try:
        # ha a master újabb vagy más méretű, mint a temp másolat → frissítjük
        if (not dst.exists()
                or dst.stat().st_size != master.stat().st_size
                or master.stat().st_mtime > dst.stat().st_mtime):
            shutil.copyfile(master, dst)
        return str(dst)
    except Exception:  # noqa: BLE001
        try:
            return str(master)  # végső esetben a master (read-only is jobb a semminél)
        except Exception:  # noqa: BLE001
            return None


def _apply_yt_auth(opts: dict) -> None:
    """YouTube autentikáció a beépített session-cookie-val (ha van), a bot-blokk ellen."""
    cf = _yt_cookiefile()
    if cf:
        opts["cookiefile"] = cf


def _is_yt_botblock(err: Exception) -> bool:
    """Igaz, ha a YouTube hibája bejelentkezést/bot-ellenőrzést kér (ekkor segít a cookie).
    A 'requested format is not available' NEM ilyen — azt épp a rossz cookie okozhatja,
    ezért arra NEM próbálunk cookie-t."""
    m = str(err).lower()
    return ("sign in to confirm" in m or "confirm you're not a bot" in m
            or "this video is not available" in m and "bot" in m
            or "use --cookies" in m or "account" in m and "bot" in m)


def _is_yt_permanent(err: Exception) -> bool:
    """Igaz, ha a videó tényleg/véglegesen nem elérhető (privát, törölt, régiózárt, DRM) —
    ezen semmilyen kliens/cookie nem segít, ne is próbálkozzunk tovább."""
    m = str(err).lower()
    return ("private video" in m or "video unavailable" in m or "removed" in m
            or "terminated" in m or "drm protected" in m or "not available in your country" in m
            or "members-only" in m or "this video has been removed" in m)


def _yt_extract_with_fallbacks(url: str) -> dict:
    """YouTube info kinyerés több módszerrel, hogy MINDEN elérhető videót felhozzon.

    A tesztek szerint az ALAPÉRTELMEZETT (web) kliens adja a legtöbb felbontást (4K-ig),
    az 'android' kliens megbízható tartalék (cookie nélkül is megy, ha a web bot-blokkot kap),
    a beépített cookie pedig csak végső esetben — és csak ha valódi bot-blokk van."""
    attempts: list[tuple[str, dict]] = [("default", {})]
    last_err: Exception | None = None
    for name, extra in attempts:
        opts = _base_opts()
        opts["skip_download"] = True
        opts.update(extra)
        try:
            with YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=False)
            if info and (info.get("formats") or info.get("url")):
                return info
        except Exception as e:  # noqa: BLE001
            last_err = e
            if _is_yt_permanent(e):
                raise           # tényleg nem elérhető — ne pörgessük tovább a klienseket
            continue

    # végső tartalék: beépített cookie (CSAK ha van és bot-blokk volt) — a rossz cookie
    # nem ronthat, mert idáig csak akkor jutunk, ha minden cookie nélküli ág elbukott
    if last_err and _is_yt_botblock(last_err) and _yt_cookiefile():
        print("[yt] bot-blokk → újrapróba beépített cookie-val", flush=True)
        opts = _base_opts()
        opts["skip_download"] = True
        _apply_yt_auth(opts)
        with YoutubeDL(opts) as ydl:
            return ydl.extract_info(url, download=False)
    raise (last_err or RuntimeError("YouTube: nem sikerült a lekérés."))


def _ig_methods(browser: str | None) -> list[tuple[str, dict]]:
    """Instagram yt-dlp fallback módszerek (a guest-API után). A beépített cookie-val
    az alap extractor megy; a graphql ág tartalék."""
    cf = _ig_cookiefile()
    auth = {"cookiefile": cf} if cf else {}
    return [
        ("default", {**auth}),
        ("graphql", {**auth, "extractor_args": {"instagram": {"api": ["graphql"]}}}),
    ]


def _ig_fresh_url(url: str) -> str | None:
    """Friss (élő) Instagram videó-URL letöltéshez — a cdninstagram link időkorlátos."""
    try:
        import ig_api
        media = ig_api.fetch_media(url)
        return (media or {}).get("video_url") or None
    except Exception:  # noqa: BLE001
        return None


def _ig_guest_info(url: str) -> dict | None:
    """Instagram reel/poszt → yt-dlp-szerű info dict a guest-API-ból (login nélkül)."""
    import ig_api
    media = ig_api.fetch_media(url)
    if not media or not media.get("video_url"):
        return None
    # yt-dlp-kompatibilis info dict, hogy a többi kód (estimate, prepare) ráilljen
    fmt = {
        "url": media["video_url"],
        "ext": "mp4",
        "vcodec": "h264",
        "acodec": "aac",
        "protocol": "https",
        "format_id": "ig-progressive",
    }
    if media.get("height"):
        fmt["height"] = media["height"]
        fmt["width"] = media.get("width") or 0
    return {
        "id": media.get("shortcode"),
        "title": media.get("title"),
        "uploader": media.get("uploader") or "",
        "duration": media.get("duration") or 0,
        "thumbnail": media.get("thumbnail") or "",
        "thumbnails": [{"url": media.get("thumbnail")}] if media.get("thumbnail") else [],
        "url": media["video_url"],
        "formats": [fmt],
        "extractor_key": "InstagramGuest",
        "webpage_url": url,
        "http_headers": {"Referer": "https://www.instagram.com/"},
    }


def _extract_info_once(url: str, browser: str | None) -> dict:
    """Egyszeri info kinyerés, a forrásnak megfelelő opciókkal.

    YouTube-nál az ALAPÉRTELMEZETT yt-dlp kliens adja a legtöbb felbontást (144p…4K).
    Instagramnál ELŐSZÖR a guest-API (login nélkül), ha az nem ad videót, yt-dlp
    fallback több módszerrel. Minden más oldalnál (univerzális) az alap yt-dlp megy."""
    base = _base_opts()
    base["skip_download"] = True

    if is_valid_youtube_url(url):
        return _yt_extract_with_fallbacks(url)

    if not is_valid_instagram_url(url):
        with YoutubeDL(base) as ydl:
            try:
                info = ydl.extract_info(url, download=False)
            except Exception as exc:
                # Some public Vimeo videos still play in the embedded player
                # when the watch-page client requires a session.
                video = re.fullmatch(r"/(\d+)/?", urllib.parse.urlparse(url).path)
                if _host_of(url) != "vimeo.com" or not video or "client only works when logged-in" not in str(exc):
                    raise
                player = f"https://player.vimeo.com/video/{video[1]}"
                info = ydl.extract_info(player, download=False)
                info["_downloader_url"] = player
        if not info or not (info.get("url") or info.get("formats")):
            raise RuntimeError("No video formats for this link. Select an individual video.")
        return info

    # 1) Instagram guest-API (cookie/login nélkül, a leggyorsabb és legmegbízhatóbb)
    try:
        guest = _ig_guest_info(url)
        if guest:
            return guest
    except Exception as e:  # noqa: BLE001
        print("[ig guest] hiba:", str(e)[:120], flush=True)

    # 2) yt-dlp fallback (cookie-val ha van, különben best-effort)
    last_err: Exception | None = None
    for _name, extra in _ig_methods(browser):
        opts = dict(base)
        opts.update(extra)
        try:
            with YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=False)
            if info:
                return info
        except Exception as e:  # noqa: BLE001
            last_err = e
            continue
    raise (last_err or RuntimeError("Instagram: nem sikerült a lekérés."))


def _extract_info(url: str, browser: str | None = None) -> dict:
    """yt-dlp info kinyerés (blokkoló — háttérszálban hívjuk), cache-elve."""
    key = f"{url}|{browser or ''}"
    cached = _info_cache.get(key)
    if cached and time.monotonic() - cached[0] < 600:
        return cached[1]
    info = _extract_info_once(url, browser)
    if len(_info_cache) >= 100:
        _info_cache.pop(next(iter(_info_cache)), None)
    _info_cache[key] = (time.monotonic(), info)
    return info


async def get_info(url: str, browser: str | None = None) -> dict:
    return await asyncio.to_thread(_extract_info, url, browser)


def best_thumbnail(info: dict) -> str | None:
    if str(info.get("extractor_key", "")).lower().startswith("youtube") and info.get("id"):
        return f"https://i.ytimg.com/vi/{info['id']}/hqdefault.jpg"
    thumbs = info.get("thumbnails") or []
    if thumbs:
        # a legnagyobb (utolsó) thumbnail
        return thumbs[-1].get("url") or info.get("thumbnail")
    return info.get("thumbnail")


def _ig_play_url(info: dict) -> str | None:
    """A video-only DASH rendition is never a complete, audible preview."""
    return _yt_progressive_url(info)


def _yt_progressive_url(info: dict) -> str | None:
    direct = _direct_preview_format(info)
    return direct["url"] if direct else None


def _preview_rank(fmt: dict) -> tuple:
    height = fmt.get("height") or 360
    return height > 480, abs(height - 360), not _has_codec(fmt, "a"), fmt.get("tbr") or 0


def _has_codec(fmt: dict, track: str) -> bool:
    codec = fmt.get(f"{track}codec")
    if track == "a" and codec is None and fmt.get("vcodec") == "none":
        return fmt.get("protocol") in {"m3u8", "m3u8_native"}
    return codec not in (None, "none")


def _browser_preview_type(fmt: dict) -> str | None:
    video, audio = fmt.get("vcodec") or "", fmt.get("acodec")
    if fmt.get("ext") == "mp4" and video.startswith(("avc1", "h264")) and audio in {"aac", "mp4a.40.2"}:
        return "video/mp4"
    if fmt.get("ext") == "webm" and video.startswith(("vp8", "vp9", "vp09")) and audio in {"opus", "vorbis"}:
        return "video/webm"
    return None


def _direct_preview_format(info: dict) -> dict | None:
    return min((fmt for fmt in [*(info.get("formats") or []), info]
                if fmt.get("protocol") in {"http", "https"}
                and is_http_url(fmt.get("url") or "")
                and not fmt.get("has_drm") and _browser_preview_type(fmt)),
               key=lambda fmt: (*_preview_rank(fmt)[:2], fmt.get("ext") != "mp4", fmt.get("tbr") or 0), default=None)


def _stream_preview_formats(info: dict, audio_lang: str | None = None) -> tuple[dict, ...]:
    formats = [fmt for fmt in [*(info.get("formats") or []), info]
               if fmt.get("protocol") in {"http", "https", "m3u8", "m3u8_native"}
               and not fmt.get("has_drm") and is_http_url(fmt.get("url") or "")]
    has_audio = any(_has_codec(fmt, "a") for fmt in [*(info.get("formats") or []), info])
    audio_only = [fmt for fmt in formats if _has_codec(fmt, "a") and not _has_codec(fmt, "v")]
    if audio_lang and any(fmt.get("language") == audio_lang for fmt in audio_only):
        audio_only = [fmt for fmt in audio_only if fmt.get("language") == audio_lang]
    elif any((fmt.get("language_preference") or -1) >= 10 for fmt in audio_only):
        audio_only = [fmt for fmt in audio_only if (fmt.get("language_preference") or -1) >= 10]
    audio = min(audio_only, key=lambda fmt: abs((fmt.get("abr") or 96) - 96), default=None)
    if audio_lang and audio:  # a muxed stream would carry the default language
        video = min((fmt for fmt in formats if _has_codec(fmt, "v") and not _has_codec(fmt, "a")),
                    key=_preview_rank, default=None)
        if video:
            return video, audio
    video = min((fmt for fmt in formats if _has_codec(fmt, "v")
                 and (_has_codec(fmt, "a") or audio or not has_audio)),
                key=_preview_rank, default=None)
    if not video:
        return ()
    return (video, audio) if audio and not _has_codec(video, "a") else (video,)


def _preview_headers(info: dict, fmt: dict) -> dict:
    headers = {**(info.get("http_headers") or {}), **(fmt.get("http_headers") or {})}
    return {key: value for key, value in headers.items()
            if key.lower() in {"user-agent", "referer", "origin", "accept", "accept-language"}
            and isinstance(value, str) and not any(c in value for c in "\r\n")}


def _open_extractor_media(info: dict, fmt: dict, headers: dict):
    # Carry forward scoped CDN cookies and the request handler used for extraction.
    downloader = YoutubeDL(_base_opts(), auto_init=False)
    try:
        downloader._load_cookies(fmt.get("cookies") or info.get("cookies"), autoscope=False)
        request = MediaRequest(fmt["url"], headers=headers)
        if str(info.get("extractor_key", "")).lower().startswith("tiktok"):
            request.extensions["impersonate"] = ImpersonateTarget()
        try:
            response = downloader.urlopen(request)
        except MediaHTTPError as exc:
            response = exc.response
    except BaseException:
        downloader.close()
        raise

    closed = False

    def close():
        nonlocal closed
        if closed:
            return
        closed = True
        try:
            response.close()
        finally:
            downloader.close()

    def chunks():
        try:
            while chunk := response.read(65536):
                yield chunk
        finally:
            close()

    return response, chunks(), close


# Media requests use short-lived IDs so only extractor-provided URLs and headers
# are usable by the streaming routes.
_preview_sources: OrderedDict = OrderedDict()


def _register_preview(info: dict) -> tuple[str | None, str | None, bool]:
    direct = _direct_preview_format(info)
    streams = _stream_preview_formats(info)
    has_audio = any(_has_codec(fmt, "a") for fmt in streams)
    if not direct and not streams:
        return None, None, False
    key = os.urandom(16).hex()
    _preview_sources[key] = (time.monotonic(), info, direct, streams)
    if len(_preview_sources) > 128:
        _preview_sources.popitem(last=False)
    return (f"/api/media/{key}" if direct else None,
            f"/api/preview/stream/{key}" if streams else None, has_audio)


def _get_preview_source(key: str):
    result = _preview_sources.get(key)
    if not result or time.monotonic() - result[0] > 3600:
        raise HTTPException(404, "Az előnézet linkje lejárt.")
    return result[1:]


def _ffmpeg_preview_command(ffmpeg: Path, info: dict, streams: tuple[dict, ...], start: float) -> list[str]:
    command = [str(ffmpeg), "-nostdin", "-hide_banner", "-loglevel", "error", "-filter_threads", "2"]
    for fmt in streams:
        command += ["-rw_timeout", "9000000", "-protocol_whitelist", "http,https,tcp,tls,crypto",
                    "-analyzeduration", "1500000", "-probesize", "524288", "-threads", "2"]
        headers = _preview_headers(info, fmt)
        if headers:
            command += ["-headers", "".join(f"{key}: {value}\r\n" for key, value in headers.items())]
        if start:
            command += ["-ss", f"{start:.3f}"]
        command += ["-i", fmt["url"]]
    return command + [
        "-map", "0:v:0", "-map", f"{len(streams) - 1}:a:0?", "-map_metadata", "-1",
        "-vf", "scale=640:640:force_original_aspect_ratio=decrease:force_divisible_by=2",
        "-r", "30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "baseline",
        "-level:v", "3.1", "-preset", "ultrafast", "-tune", "zerolatency", "-crf", "25",
        "-g", "12", "-sc_threshold", "0", "-threads", "2",
        "-c:a", "aac", "-profile:a", "aac_low", "-b:a", "96k", "-ac", "2",
        "-movflags", "+empty_moov+default_base_moof+frag_keyframe+skip_trailer",
        "-frag_duration", "400000", "-flush_packets", "1", "-f", "mp4", "pipe:1",
    ]


def storyboard_url(info: dict):
    """A storyboard (timeline mini-kockák) adatai, a LEGJOBB MINŐSÉGŰ szintet választva."""
    candidates = []
    for f in info.get("formats", []):
        fid = str(f.get("format_id", ""))
        if not fid.startswith("sb"):
            continue
        frags = f.get("fragments") or []
        urls = [fr.get("url") for fr in frags if fr.get("url")]
        if not urls and f.get("url"):
            urls = [f["url"]]
        if not urls:
            continue
        cols = f.get("columns") or 0
        rows = f.get("rows") or 0
        if not (cols and rows):
            continue
        tile_w = f.get("width") or 0   # egy kocka szélessége px-ben
        tile_h = f.get("height") or 0
        candidates.append({
            "urls": urls,            # minden sprite-lap (fragment) URL-je
            "columns": cols,         # kockák egy lapon vízszintesen
            "rows": rows,            # kockák egy lapon függőlegesen
            "fragments": len(urls),
            "tileWidth": tile_w,
            "tileHeight": tile_h,
        })

    if not candidates:
        return None

    # a legjobb minőség: a legnagyobb tile-méret (élesebb kockák a timeline-on)
    candidates.sort(key=lambda c: -(c["tileWidth"] * c["tileHeight"]))
    return candidates[0]


def estimate_bitrate_bps(info: dict, fmt: str, quality: str) -> float:
    """A választott formátum/minőség becsült össz-bitrátája (bit/mp)."""
    if fmt == "mp3":
        try:
            return (int(quality) if quality else 192) * 1000
        except ValueError:
            return 192_000

    try:
        max_h = int(quality) if quality else 1080
    except ValueError:
        max_h = 1080

    # a kiválasztott videó-formátum: a legnagyobb magasság a kért határig
    chosen_v = None
    best_a_bps = 0.0
    for f in info.get("formats", []):
        has_v = f.get("vcodec") and f.get("vcodec") != "none"
        has_a = f.get("acodec") and f.get("acodec") != "none"
        h = f.get("height") or 0
        if has_v and not has_a and h and h <= max_h:
            if chosen_v is None or h > (chosen_v.get("height") or 0) or (
                h == chosen_v.get("height") and (f.get("tbr") or 0) > (chosen_v.get("tbr") or 0)
            ):
                chosen_v = f
        if has_a and not has_v:
            best_a_bps = max(best_a_bps, (f.get("abr") or f.get("tbr") or 0) * 1000)

    if chosen_v is not None:
        v_bps = (chosen_v.get("vbr") or chosen_v.get("tbr") or 0) * 1000
    else:
        v_bps = 0.0

    if not v_bps:
        fallback = {2160: 35e6, 1440: 16e6, 1080: 8e6, 720: 5e6,
                    480: 2.5e6, 360: 1e6, 240: 0.7e6, 144: 0.3e6}
        v_bps = fallback.get(max_h, 5e6)
    if not best_a_bps:
        best_a_bps = 128_000
    return v_bps + best_a_bps


# ----------------------------------------------------------------------------
# Kereső (YouTube cím alapján)
# ----------------------------------------------------------------------------

def _search_youtube(query: str, limit: int) -> list[dict]:
    """yt-dlp `ytsearchN:` — gyors, csak metaadat (extract_flat), nincs formátum-feloldás."""
    opts = _base_opts()
    opts.update({
        "skip_download": True,
        "extract_flat": True,     # csak a találatok metaadatai, nem oldja fel a streameket → gyors
    })
    results: list[dict] = []
    with YoutubeDL(opts) as ydl:
        data = ydl.extract_info(f"ytsearch{limit}:{query}", download=False)
    for e in (data or {}).get("entries", []) or []:
        if not e:
            continue
        vid = e.get("id")
        if not vid:
            continue
        # extract_flat alatt a thumbnail néha hiányzik — az i.ytimg fallback mindig működik
        thumbs = e.get("thumbnails") or []
        thumb = (thumbs[-1].get("url") if thumbs else None) or \
            f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg"
        results.append({
            "id": vid,
            "url": f"https://www.youtube.com/watch?v={vid}",
            "title": e.get("title") or "—",
            "uploader": e.get("uploader") or e.get("channel") or "",
            "duration": e.get("duration") or 0,
            "thumbnail": thumb,
        })
    return results


def _search_youtube_channels(query: str, limit: int = 6) -> list[dict]:
    """YouTube CSATORNA-keresés (a 'csatorna' szűrővel) → kerek profilképes kártyákhoz.

    A YouTube keresés `sp=EgIQAg%3D%3D` szűrője csak csatornákat ad. Innen a profilkép,
    a név és a követőszám is megvan — pont mint az IG fiók-kereső."""
    opts = _base_opts()
    # GYORSASÁG: a csatorna-keresés sok száz találatot ad — a playlistend-del a yt-dlp
    # CSAK az első néhányat dolgozza fel (különben 15-25 mp-et is várnánk feleslegesen).
    opts.update({"skip_download": True, "extract_flat": True, "playlistend": max(limit, 6)})
    url = (f"https://www.youtube.com/results?search_query={urllib.parse.quote(query)}"
           f"&sp=EgIQAg%253D%253D")
    out: list[dict] = []
    try:
        with YoutubeDL(opts) as ydl:
            data = ydl.extract_info(url, download=False)
    except Exception as e:  # noqa: BLE001
        print("[yt channels] hiba:", repr(e), flush=True)
        return out
    for e in (data or {}).get("entries", []) or []:
        if not e or e.get("ie_key") not in ("YoutubeTab", "YoutubeChannel"):
            continue
        cid = e.get("id") or ""
        if not cid.startswith("UC"):
            continue
        thumbs = e.get("thumbnails") or []
        pic = ""
        if thumbs:
            pic = thumbs[-1].get("url") or thumbs[0].get("url") or ""
            if pic.startswith("//"):
                pic = "https:" + pic
        out.append({
            "id": cid,
            "title": e.get("title") or e.get("channel") or "—",
            "url": e.get("url") or f"https://www.youtube.com/channel/{cid}",
            "thumbnail": pic,
            "followers": e.get("channel_follower_count") or 0,
        })
        if len(out) >= limit:
            break
    return out


def _youtube_channel_url(value: str) -> str:
    """Canonicalize public YouTube channel addresses before passing them to yt-dlp."""
    if re.fullmatch(r"UC[A-Za-z0-9_-]{22}", value):
        return f"https://www.youtube.com/channel/{value}/videos"
    if value.startswith("@"):
        value = f"https://www.youtube.com/{value}"
    parsed = urllib.parse.urlsplit(value)
    path = urllib.parse.unquote(parsed.path).rstrip("/")
    match = re.fullmatch(
        r"/(@[\w.-]{2,100}|channel/UC[A-Za-z0-9_-]{22}|(?:c|user)/[\w.-]{1,100})"
        r"(?:/(?:featured|videos|shorts|streams|playlists|community|about))?",
        path,
    )
    if (parsed.scheme not in ("http", "https") or not is_valid_youtube_url(value)
            or parsed.username or parsed.password or parsed.port is not None or not match):
        raise ValueError("Invalid public YouTube channel address")
    safe_path = urllib.parse.quote(match[1], safe="/@")
    return f"https://www.youtube.com/{safe_path}/videos"


def _youtube_channel_videos(channel_url: str, limit: int = 48) -> dict:
    """Load channel metadata and flat uploads from the same Videos request."""
    opts = _base_opts()
    opts.update({"skip_download": True, "extract_flat": True, "playlistend": limit})
    with YoutubeDL(opts) as ydl:
        data = ydl.extract_info(channel_url, download=False) or {}

    thumbs = [t for t in data.get("thumbnails") or [] if t.get("url")]
    banners = [t for t in thumbs if t.get("preference") == -10]
    avatars = [t for t in thumbs if t.get("id") == "avatar_uncropped"
               or (t.get("width") and t.get("width") == t.get("height"))]
    banner = max(banners, key=lambda t: t.get("width") or 0, default={}).get("url")
    avatar = max(avatars, key=lambda t: t.get("width") or 0, default={}).get("url")
    handle = data.get("uploader_id") or ""
    channel = {
        "id": data.get("channel_id") or data.get("id"),
        "title": data.get("channel") or data.get("uploader") or data.get("title"),
        "handle": handle if handle.startswith("@") else None,
        "followers": data.get("channel_follower_count"),
        "verified": bool(data.get("channel_is_verified")),
        "description": data.get("description") or "",
        "thumbnail": avatar,
        "banner": banner,
    }
    out: list[dict] = []
    # a csatorna-lap néha tab-okba ágyazza az entry-ket → kilapítjuk
    entries = (data or {}).get("entries", []) or []
    flat: list[dict] = []
    for e in entries:
        if e and e.get("entries"):
            flat.extend(e["entries"])
        elif e:
            flat.append(e)
    for e in flat:
        if not e:
            continue
        vid = e.get("id")
        if not vid or e.get("ie_key") not in (None, "Youtube"):
            continue
        thumbs = e.get("thumbnails") or []
        thumb = (thumbs[-1].get("url") if thumbs else None) or \
            f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg"
        out.append({
            "id": vid,
            "url": f"https://www.youtube.com/watch?v={vid}",
            "title": e.get("title") or "—",
            "uploader": e.get("uploader") or e.get("channel") or "",
            "duration": e.get("duration") or 0,
            "thumbnail": thumb,
        })
        if len(out) >= limit:
            break
    return {"channel": channel, "videos": out}


_search_cache: dict = {}
_search_pending: dict = {}


async def _cached_search(kind, query, limit, worker):
    key = (kind, query if kind == "channel" else query.casefold(), limit)
    cached = _search_cache.get(key)
    if cached and time.monotonic() - cached[0] < 300:
        return cached[1]
    if key not in _search_pending:
        async def run():
            try:
                result = await asyncio.to_thread(worker, query, limit)
                if len(_search_cache) >= 64:
                    _search_cache.pop(next(iter(_search_cache)), None)
                _search_cache[key] = (time.monotonic(), result)
                return result
            finally:
                _search_pending.pop(key, None)
        _search_pending[key] = asyncio.create_task(run())
    return await asyncio.shield(_search_pending[key])


@app.get("/api/search/channels")
async def api_search_channels(q: str = Query(..., min_length=1, max_length=300)):
    return {"channels": await _cached_search("channels", q.strip(), 6, _search_youtube_channels)}


@app.get("/api/search")
async def api_search(q: str = Query(..., max_length=300), limit: int = 18, source: str = "youtube"):
    q = q.strip()
    if not q:
        raise HTTPException(400, "Üres keresés.")
    # Sok találat, mint az igazi YouTube — a frontend végtelen görgetéssel tölt többet.
    limit = max(1, min(80, limit))
    # Instagram keresés MEGSZŰNT (cookie nélkül nem megbízható). Az IG fülön már csak
    # link-beillesztés van; ha valami mégis ide jön IG forrással, üres találatot adunk.
    if source == "instagram":
        return {"results": [], "channels": [], "source": "instagram", "kind": "videos"}
    try:
        # YouTube: a videók ÉS a csatornák egyszerre (párhuzamosan) — a csatornák külön
        # sorban jelennek meg a frontenden, kerek profilképpel.
        videos = await _cached_search("videos", q, limit, _search_youtube)
    except Exception as e:  # noqa: BLE001
        print("[api_search] hiba:", repr(e), flush=True)
        raise HTTPException(500, "A keresés nem sikerült.") from e
    return {"results": videos, "channels": [], "source": source, "kind": "videos"}


_web_cache: OrderedDict = OrderedDict()


async def _web_cached(key, factory):
    hit = _web_cache.get(key)
    if hit and time.monotonic() - hit[0] < 300:
        return hit[1]
    value = await factory()
    _web_cache[key] = (time.monotonic(), value)
    while len(_web_cache) > 96:
        _web_cache.popitem(last=False)
    return value


def _flat_to_web(item: dict) -> dict:
    return {"kind": "short" if "/shorts/" in item["url"] else "video", "id": item["id"], "url": item["url"],
            "title": item["title"], "thumbnail": item["thumbnail"], "duration": item["duration"],
            "length": _fmt_clock(item["duration"]) if item["duration"] else "", "views": "", "published": "",
            "uploader": item["uploader"], "channelId": None, "avatar": "", "verified": False, "live": False}


def _fmt_clock(seconds: float) -> str:
    seconds = int(seconds or 0)
    h, m, s = seconds // 3600, seconds % 3600 // 60, seconds % 60
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


async def youtube_search(query: str, page: str | None = None, channels_only: bool = False) -> dict:
    """YouTube-like results (videos + Shorts shelf + channels) with continuation."""
    key = ("search", query.casefold(), page, channels_only)
    try:
        return await _web_cached(key, lambda: yt_web.search(query, page, channels_only))
    except Exception as exc:  # noqa: BLE001 - fall back to yt-dlp when the web API changes
        _log(f"InnerTube search failed: {type(exc).__name__}: {str(exc)[:160]}")
        if page:
            return {"videos": [], "shorts": [], "channels": [], "next": None}
        if channels_only:
            return {"videos": [], "shorts": [], "channels": [
                {**c, "kind": "channel", "subs": "", "handle": "", "verified": False}
                for c in await asyncio.to_thread(_search_youtube_channels, query, 8)], "next": None}
        items = [_flat_to_web(x) for x in await asyncio.to_thread(_search_youtube, query, 30)]
        return {"videos": [x for x in items if x["kind"] == "video"],
                "shorts": [x for x in items if x["kind"] == "short"], "channels": [], "next": None}


@app.get("/api/yt/search")
async def api_yt_search(q: str = Query("", max_length=300), page: str = Query("", max_length=4000),
                        channels: bool = False):
    if not q.strip() and not page:
        raise HTTPException(400, "Üres keresés.")
    return await youtube_search(q.strip(), page or None, channels)


async def youtube_channel(ref: str, tab: str = "videos", page: str | None = None) -> dict:
    if tab not in ("videos", "shorts", "streams"):
        tab = "videos"
    key = ("channel", ref, tab, page)
    try:
        return await _web_cached(key, lambda: yt_web.channel(ref, tab, page))
    except Exception as exc:  # noqa: BLE001
        _log(f"InnerTube channel failed: {type(exc).__name__}: {str(exc)[:160]}")
        if page:
            return {"items": [], "next": None}
        channel_url = _youtube_channel_url(ref)
        if tab == "shorts":
            channel_url = channel_url.removesuffix("/videos") + "/shorts"
        data = await _cached_search("channel", channel_url, 48, _youtube_channel_videos)
        legacy = data["channel"]
        stats = [f"{legacy['followers']:,} feliratkozó".replace(",", " ")] if legacy.get("followers") else []
        return {"channel": {**legacy, "handle": legacy.get("handle") or "", "stats": stats},
                "tabs": ["videos", "shorts"], "tab": tab, "next": None,
                "items": [_flat_to_web(x) | ({"kind": "short", "url": f"https://www.youtube.com/shorts/{x['id']}"}
                                             if tab == "shorts" else {}) for x in data["videos"]]}


@app.get("/api/yt/channel")
async def api_yt_channel(channel_id: str = Query(..., max_length=400), tab: str = "videos",
                         page: str = Query("", max_length=4000)):
    """Egy YouTube csatorna fejléce és feltöltései (Videók / Shorts / Élő), lapozással."""
    ref = channel_id.strip()
    try:
        if not re.fullmatch(r"UC[A-Za-z0-9_-]{22}", ref):
            _youtube_channel_url(ref)
    except ValueError as exc:
        raise HTTPException(400, "Érvénytelen YouTube-csatorna.") from exc
    try:
        return await youtube_channel(ref, tab, page or None)
    except Exception as exc:
        _log(f"YouTube channel failed: {type(exc).__name__}")
        raise HTTPException(502, "A csatorna adatai most nem érhetők el.") from exc


# ----------------------------------------------------------------------------
# Hangsávok és feliratok
# ----------------------------------------------------------------------------

_subtitle_sources: OrderedDict = OrderedDict()
_subtitle_cache: OrderedDict = OrderedDict()


def _audio_tracks(info: dict) -> list[dict]:
    """Dubbed/alternative audio languages (only when there is more than one)."""
    tracks: dict[str, dict] = {}
    for fmt in info.get("formats") or []:
        lang = fmt.get("language")
        if not lang or not _has_codec(fmt, "a") or _has_codec(fmt, "v"):
            continue
        note = (fmt.get("format_note") or "").split(",")[0]
        label = re.sub(r"\s*(original|\(default\)|default)\s*", " ", note).strip() or lang
        pref = fmt.get("language_preference") or -1
        current = tracks.get(lang)
        if not current or pref > current["pref"]:
            tracks[lang] = {"lang": lang, "label": label, "original": pref >= 10, "pref": pref}
    if len(tracks) < 2:
        return []
    ordered = sorted(tracks.values(), key=lambda t: (-t["pref"], t["label"]))
    return [{k: v for k, v in t.items() if k != "pref"} for t in ordered]


def _subtitle_listing(info: dict) -> dict:
    manual = [{"lang": lang, "name": (entries[0].get("name") if entries else "") or lang}
              for lang, entries in (info.get("subtitles") or {}).items()
              if lang != "live_chat" and entries]
    auto = list((info.get("automatic_captions") or {}).keys())
    original = next((k[:-5] for k in auto if k.endswith("-orig")), None)
    if not original and auto and info.get("language") in auto:
        original = info.get("language")
    return {"subtitles": manual, "captionsOrig": original,
            "translate": [k for k in auto if not k.endswith("-orig")] if original else []}


def _vtt_time(ms: float) -> str:
    ms = max(0, int(ms))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d}.{ms % 1000:03d}"


def _json3_to_vtt(data: dict) -> str:
    lines = ["WEBVTT", ""]
    for event in data.get("events") or []:
        text = "".join(seg.get("utf8", "") for seg in event.get("segs") or []).strip()
        if not text or "tStartMs" not in event:
            continue
        start = event["tStartMs"]
        end = start + (event.get("dDurationMs") or 2000)
        text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        lines += [f"{_vtt_time(start)} --> {_vtt_time(end)}", text, ""]
    return "\n".join(lines)


def _subtitle_entry(info: dict, lang: str, auto: bool) -> dict | None:
    if auto:
        table = info.get("automatic_captions") or {}
        entries = table.get(lang) or table.get(f"{lang}-orig") or []
    else:
        entries = (info.get("subtitles") or {}).get(lang) or []
    by_ext = {e.get("ext"): e for e in entries if e.get("url")}
    return by_ext.get("json3") or by_ext.get("vtt") or next(iter(by_ext.values()), None)


@app.get("/api/subs/{key}")
async def api_subs(key: str, lang: str = Query(..., max_length=40), auto: bool = False):
    source = _subtitle_sources.get(key)
    if not source:
        raise HTTPException(404, "A felirat linkje lejárt.")
    cache_key = (key, lang, auto)
    if cache_key in _subtitle_cache:
        return Response(_subtitle_cache[cache_key], media_type="text/vtt; charset=utf-8")
    entry = _subtitle_entry(source[1], lang, auto)
    if not entry or not is_http_url(entry["url"]):
        raise HTTPException(404, "Ez a felirat nem érhető el.")
    try:
        response = await _get_img_client().get(entry["url"], headers={
            k: v for k, v in (entry.get("http_headers") or {}).items() if k.lower() in ("user-agent", "referer")})
    except httpx.HTTPError as exc:
        raise HTTPException(502, "A felirat nem tölthető le.") from exc
    if response.status_code == 429:
        raise HTTPException(429, "A YouTube most korlátozza a fordított feliratokat. Próbáld kicsit később.")
    if response.status_code != 200:
        raise HTTPException(502, "A felirat nem tölthető le.")
    if entry.get("ext") == "json3":
        try:
            text = _json3_to_vtt(response.json())
        except ValueError as exc:
            raise HTTPException(502, "A felirat formátuma hibás.") from exc
    else:
        text = response.text if response.text.lstrip().startswith("WEBVTT") else "WEBVTT\n\n" + response.text
    _subtitle_cache[cache_key] = text
    while len(_subtitle_cache) > 48:
        _subtitle_cache.popitem(last=False)
    return Response(text, media_type="text/vtt; charset=utf-8")


# ----------------------------------------------------------------------------
# API végpontok
# ----------------------------------------------------------------------------

@app.get("/api/info")
async def api_info(url: str = Query(...), browser: str = "", source: str = "any", refresh: bool = False):
    validate_source_url(url, source)
    is_ig = is_valid_instagram_url(url)
    browser = browser or ("auto" if is_ig else None)
    if refresh:
        _info_cache.pop(f"{url}|{browser or ''}", None)
    try:
        info = await get_info(url, browser)
    except Exception as e:  # noqa: BLE001
        print("[api_info] yt-dlp hiba:", repr(e), flush=True)
        msg = str(e).lower()
        if is_ig and ("cookies" in msg or "empty media" in msg or "login" in msg
                      or "rate-limit" in msg or "logged-in" in msg or "not available" in msg
                      or "dpapi" in msg or "cookie database" in msg):
            detail = "Az Instagram bejelentkezést kér ehhez a tartalomhoz. Próbálj másik nyilvános linket."
        elif is_valid_youtube_url(url) and ("sign in to confirm" in msg or "bot" in msg):
            detail = ("A YouTube bot-védelmet kért. Próbáld újra kicsit később.")
        elif ("private video" in msg or "video unavailable" in msg or "removed" in msg
              or "terminated" in msg or "members-only" in msg):
            detail = "Ez a videó nem elérhető (privát, törölt, vagy csak tagoknak)."
        elif "drm" in msg:
            detail = "Ez a videó DRM-védett, nem tölthető le."
        elif "not available in your country" in msg or "geo-restricted" in msg:
            detail = "Ez a videó a te régiódban nem elérhető."
        elif is_ig:
            detail = "Nem sikerült lekérni az Instagram-tartalmat (lehet privát vagy törölt)."
        elif "unsupported url" in msg or "no video formats" in msg:
            detail = "Ezen a címen nem található letölthető videó. Illessz be közvetlen videólinket."
        elif "login" in msg or "cookies" in msg or "sign in" in msg:
            detail = "Ehhez a videóhoz a forrás bejelentkezést kér. Próbálj egy nyilvános videólinket."
        elif is_valid_tiktok_url(url):
            detail = "Nem sikerült elérni a TikTok-videót. Próbáld a teljes videólinket, vagy ellenőrizd, hogy nyilvános-e."
        else:
            detail = "Nem sikerült lekérni a videó adatait. Próbáld újra pár másodperc múlva."
        raise HTTPException(500, detail) from e

    heights = sorted(
        {f["height"] for f in info.get("formats", [])
         if f.get("vcodec") not in (None, "none") and f.get("height")},
        reverse=True,
    )
    is_yt = is_valid_youtube_url(url)
    source = _source_for_url(url)
    # storyboard csak YouTube-nál van (a többi forrásnál nincs sprite-csík → a frontend
    # ott egyszerű, kattintható idősávot rajzol storyboard-kockák nélkül).
    sb = storyboard_url(info) if is_yt else None
    direct, stream, has_audio = (None, None, False) if info.get("is_live") else _register_preview(info)
    subs_key = os.urandom(12).hex()
    _subtitle_sources[subs_key] = (time.monotonic(), info)
    while len(_subtitle_sources) > 64:
        _subtitle_sources.popitem(last=False)
    cached_preview = _preview_cache.get(url)
    return {
        "audioTracks": _audio_tracks(info),
        **_subtitle_listing(info),
        "subsKey": subs_key,
        "views": info.get("view_count"),
        "uploadDate": info.get("upload_date"),
        "id": info.get("id"),
        "source": source,
        "title": info.get("title") or info.get("description") or info.get("id") or "Videó",
        "uploader": info.get("uploader") or info.get("channel") or info.get("extractor_key") or "",
        "duration": _preview_durations.get(url) or info.get("duration") or 0,
        "durationString": info.get("duration_string") or "",
        "thumbnail": best_thumbnail(info),
        "channelId": info.get("channel_id") if source == "youtube" else None,
        "resolutions": heights,
        "storyboard": sb,
        "directUrl": direct,
        "streamUrl": stream,
        "streamHasAudio": has_audio,
        "previewUrl": "/api/preview?url=" + urllib.parse.quote(url, safe=""),
        "previewCached": bool(cached_preview and cached_preview.is_file()),
        "previewHasAudio": _preview_state.get(url, {}).get("hasAudio", True),
        "isLive": bool(info.get("is_live")),
    }


@app.get("/api/estimate")
async def api_estimate(
    url: str = Query(...),
    format: str = "mp4",
    quality: str = "",
    start: float = 0.0,
    end: float = 0.0,
    browser: str = "",
):
    if not is_supported_url(url):
        raise HTTPException(400, "Érvénytelen link.")
    is_ig = is_valid_instagram_url(url)
    info = await get_info(url, browser or ("auto" if is_ig else None))
    total = _preview_durations.get(url) or info.get("duration") or 0
    s = max(0.0, start)
    e = min(end, total) if end and total else (end or total)
    seconds = max(0.0, e - s)
    bitrate = estimate_bitrate_bps(info, format, quality)
    return {"bytes": round(bitrate / 8 * seconds), "seconds": seconds}


async def _proxy_image(url: str) -> Response:
    """Thumbnail/borítókép proxy. Univerzális (bármilyen oldal thumbnailje), de csak
    http(s) képeket enged át, content-type és méret szerint szűrve (SSRF/visszaélés ellen)."""
    try:
        u = urllib.parse.urlparse(url)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, "Érvénytelen URL.") from e
    if u.scheme not in ("http", "https") or not u.netloc:
        raise HTTPException(400, "Csak http(s) képek engedélyezettek.")
    # belső/loopback címek tiltása
    host = (u.hostname or "").lower()
    if host in ("localhost", "127.0.0.1", "0.0.0.0", "::1") or host.endswith(".local"):
        raise HTTPException(400, "Nem engedélyezett forrás.")
    # Az Instagram/Facebook képeket kiszolgáló CDN (cdninstagram / fbcdn) 403-at ad, ha a
    # Referer nem az instagram.com — ezért ott azt küldjük, máshol a kép saját hostját.
    is_ig_cdn = host.endswith(".cdninstagram.com") or host.endswith(".fbcdn.net") \
        or "cdninstagram.com" in host or "fbcdn.net" in host
    # memória-cache: ugyanazt a képet azonnal kiszolgáljuk (nincs ismételt letöltés)
    cached = _img_cache.get(url)
    if cached is not None:
        ctype, content = cached
        return Response(content=content, media_type=ctype,
                        headers={"Cache-Control": "public, max-age=86400"})

    referer = "https://www.instagram.com/" if is_ig_cdn else f"{u.scheme}://{u.netloc}/"
    headers = {
        "Referer": referer,
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    }
    try:
        # megosztott, connection-pool-os kliens → gyors sok kép egyidejű betöltésekor
        r = await _get_img_client().get(url, headers=headers)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, "Kép letöltése sikertelen.") from e
    if r.status_code == 404 and host == "i.ytimg.com":
        match = re.search(r"/(?:vi|vi_webp)/([\w-]+)/", u.path)
        if match:
            r = await _get_img_client().get(f"https://i.ytimg.com/vi/{match[1]}/hqdefault.jpg", headers=headers)
    if r.status_code != 200:
        raise HTTPException(502, "Kép letöltése sikertelen.")
    ctype = r.headers.get("content-type", "image/jpeg")
    if not ctype.startswith("image/"):
        raise HTTPException(415, "A forrás nem kép.")
    content = r.content
    if len(content) > 12 * 1024 * 1024:   # 12 MB felett biztosan nem thumbnail
        raise HTTPException(413, "Túl nagy kép.")
    # cache-be tesszük (egyszerű méret-korlát: a legrégebbit dobjuk)
    if len(_img_cache) >= _IMG_CACHE_MAX:
        try:
            _img_cache.pop(next(iter(_img_cache)))
        except StopIteration:
            pass
    _img_cache[url] = (ctype, content)
    return Response(
        content=content,
        media_type=ctype,
        headers={"Cache-Control": "public, max-age=86400"},
    )


@app.get("/api/thumb")
async def api_thumb(url: str = Query(...)):
    return await _proxy_image(url)


@app.get("/api/storyboard")
async def api_storyboard(url: str = Query(...)):
    """A timeline storyboard képének proxyja."""
    return await _proxy_image(url)


@app.get("/api/media/{key}")
async def api_media(key: str, request: Request):
    """Relay a progressive preview, including upstream byte ranges."""
    info, direct, _ = _get_preview_source(key)
    if not direct:
        raise HTTPException(404, "Nincs közvetlen előnézet.")
    headers = {**_preview_headers(info, direct), "Accept-Encoding": "identity"}
    if byte_range := request.headers.get("range"):
        headers["Range"] = byte_range

    try:
        if direct.get("cookies") or info.get("cookies") or str(info.get("extractor_key", "")).lower().startswith("tiktok"):
            response, body, close = await asyncio.to_thread(_open_extractor_media, info, direct, headers)
            status = response.status
        else:
            client = _get_img_client()
            upstream = client.build_request("GET", direct["url"], headers=headers)
            response = await client.send(upstream, stream=True)
            body, close = response.aiter_raw(), response.aclose
            status = response.status_code
    except (httpx.HTTPError, MediaRequestError) as exc:
        raise HTTPException(502, "A videó-előnézet nem érhető el.") from exc
    cleanup = BackgroundTask(close)
    if status == 416:
        await cleanup()
        return Response(status_code=416, headers={"Content-Range": response.headers.get("content-range", "bytes */*")})
    if status not in (200, 206):
        await cleanup()
        raise HTTPException(502, "A videó-előnézet nem érhető el.")
    passthrough = {key: response.headers[key] for key in ("content-length", "content-range", "accept-ranges")
                   if key in response.headers}
    passthrough["Cache-Control"] = "no-store"
    return StreamingResponse(body, status_code=status, media_type=_browser_preview_type(direct),
                             headers=passthrough, background=cleanup)


_stream_slots = asyncio.Semaphore(3)


@app.get("/api/preview/stream/{key}")
async def api_preview_stream(key: str, start: float = 0, audio: str = Query("", max_length=40)):
    info, _, streams = _get_preview_source(key)
    if audio:
        streams = _stream_preview_formats(info, audio) or streams
    if not streams:
        raise HTTPException(404, "Nincs streamelhető előnézet.")
    if not math.isfinite(start) or start < 0:
        raise HTTPException(400, "Érvénytelen kezdőpozíció.")
    ffmpeg = await asyncio.to_thread(_ensure_ffmpeg_on_path)
    if not ffmpeg:
        raise HTTPException(503, "Az FFmpeg nem érhető el.")
    command = _ffmpeg_preview_command(ffmpeg, info, streams, start)

    async def body():
        async with _stream_slots:
            with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                  creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)) as process:
                try:
                    while chunk := await asyncio.to_thread(process.stdout.read1, 65536):
                        yield chunk
                finally:
                    if process.poll() is None:
                        process.kill()

    return StreamingResponse(body(), media_type="video/mp4", headers={"Cache-Control": "no-store"})


_preview_cache = {}
_preview_durations = {}
_preview_pending = {}
_preview_state = {}
_preview_slots = asyncio.Semaphore(2)


def _create_preview(url: str) -> Path:
    _preview_state[url] = {"status": "preparing", "message": "Videó adatainak lekérése…"}
    media_info = _extract_info(url, "auto" if is_valid_instagram_url(url) else None)
    if media_info.get("is_live"):
        raise RuntimeError("Az élő adás még nem rendelkezik végleges hosszúsággal.")
    folder = Path(tempfile.mkdtemp(prefix="preview_", dir=TMP_DIR))
    ffmpeg = _ensure_ffmpeg_on_path()
    if not ffmpeg:
        raise RuntimeError("ffmpeg is not installed")
    target = media_info.get("_downloader_url") or url
    if media_info.get("extractor_key") == "InstagramGuest":
        target = _ig_fresh_url(url) or media_info["url"]
    opts = _base_opts()
    opts.update({
        "ffmpeg_location": str(ffmpeg),
        "outtmpl": str(folder / "source.%(ext)s"),
        "format": "bv[height<=480][vcodec^=avc1]+ba[ext=m4a]/b[height<=480][ext=mp4]/bv[height<=480]+ba/b/bv+ba/bv",
        "merge_output_format": "mkv",
        "concurrent_fragment_downloads": 4,
        "noprogress": True,
    })
    def preview_progress(data):
        total = data.get("total_bytes") or data.get("total_bytes_estimate") or 0
        percent = min(100, round(100 * data.get("downloaded_bytes", 0) / total)) if total else None
        _preview_state[url] = {"status": "preparing", "message": "Előnézet letöltése…" + (f" {percent}%" if percent is not None else "")}
    opts["progress_hooks"] = [preview_progress]
    if is_valid_instagram_url(url):
        if target == url:
            _apply_ig_auth(opts, None)
        opts["http_headers"] = {**(media_info.get("http_headers") or {}), "Referer": "https://www.instagram.com/"}
    try:
        with YoutubeDL(opts) as ydl:
            ydl.download([target])
        sources = [p for p in folder.glob("source.*") if p.suffix not in (".part", ".ytdl", ".temp")]
        if len(sources) != 1:
            raise RuntimeError("Preview source download did not complete")
        output = folder / "preview.mp4"
        _preview_state[url] = {"status": "preparing", "message": "Kép és hang előkészítése…"}
        # Browser/WebView2 codec support varies: HE-AAC in Instagram reels can be
        # silent even though the original has audio. Normalize to H.264 + AAC-LC.
        command = [str(ffmpeg), "-nostdin", "-hide_banner", "-y", "-i", str(sources[0]),
                   "-map", "0:v:0", "-map", "0:a:0?", "-vf",
                   "scale=640:640:force_original_aspect_ratio=decrease:force_divisible_by=2",
                   "-c:v", "libx264", "-preset", "veryfast", "-crf", "25", "-pix_fmt", "yuv420p",
                   "-c:a", "aac", "-profile:a", "aac_low", "-b:a", "128k", "-ac", "2",
                   "-threads", "2", "-movflags", "+faststart", str(output)]
        result = subprocess.run(command, capture_output=True, text=True,
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        if result.returncode or not output.exists() or not output.stat().st_size:
            raise RuntimeError("Az előnézet átalakítása sikertelen.")
        probe = subprocess.run([str(ffmpeg), "-hide_banner", "-i", str(output)], capture_output=True, text=True,
                               creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        match = re.search(r"Duration: (\d+):(\d+):([\d.]+)", probe.stderr)
        if not match or not re.search(r"Stream #.*: Video:", probe.stderr):
            raise RuntimeError("Az előnézet nem tartalmaz lejátszható videót.")
        _preview_durations[url] = int(match[1]) * 3600 + int(match[2]) * 60 + float(match[3])
        has_audio = bool(re.search(r"Stream #.*: Audio:", probe.stderr))
        expects_audio = any(f.get("acodec") not in (None, "none") for f in [media_info, *(media_info.get("formats") or [])])
        if expects_audio and not has_audio:
            raise RuntimeError("Az előnézet hangsávja nem töltődött le.")
        _preview_state[url] = {"status": "preparing", "hasAudio": has_audio}
        sources[0].unlink()
        return output
    except Exception:
        shutil.rmtree(folder, ignore_errors=True)
        raise


def _start_preview(url: str):
    cached = _preview_cache.get(url)
    if cached and not cached.is_file():
        _preview_cache.pop(url, None)
    if url in _preview_cache or url in _preview_pending:
        return
    _preview_state[url] = {"status": "preparing", "message": "Előnézet várakozik…"}
    async def prepare():
        try:
            async with _preview_slots:
                for attempt in range(2):
                    try:
                        _preview_cache[url] = await asyncio.to_thread(_create_preview, url)
                        _preview_state[url] = {**_preview_state.get(url, {}), "status": "ready", "duration": _preview_durations.get(url, 0)}
                        return
                    except Exception:
                        if attempt:
                            raise
                        for key in list(_info_cache):
                            if key.startswith(url + "|"):
                                _info_cache.pop(key, None)
                        _preview_state[url] = {"status": "preparing", "message": "Kapcsolat újrapróbálása…"}
                        await asyncio.sleep(1)
        except Exception as exc:
            _log("Preview failed: " + type(exc).__name__)
            _preview_state[url] = {"status": "error", "message": "Az előnézet nem töltődött be. Próbáld újra."}
        finally:
            _preview_pending.pop(url, None)
    _preview_pending[url] = asyncio.create_task(prepare())


@app.get("/api/preview/status")
async def api_preview_status(url: str = Query(...), retry: bool = False, wait: bool = False):
    validate_source_url(url)
    if retry and url not in _preview_pending:
        _preview_cache.pop(url, None)
        _preview_state.pop(url, None)
        for key in list(_info_cache):
            if key.startswith(url + "|"):
                _info_cache.pop(key, None)
    if _preview_state.get(url, {}).get("status") != "error":
        _start_preview(url)
    if wait and (pending := _preview_pending.get(url)):
        await asyncio.wait((pending,), timeout=1.0)
    return _preview_state.get(url, {"status": "preparing"})


@app.get("/api/preview")
async def api_preview(url: str = Query(...)):
    validate_source_url(url)
    _start_preview(url)
    pending = _preview_pending.get(url)
    if pending:
        await asyncio.shield(pending)
    if url not in _preview_cache:
        raise HTTPException(502, "Az előnézet nem tölthető be.")
    return FileResponse(_preview_cache[url], media_type="video/mp4", headers={"Cache-Control": "no-store"})


# --- Job-alapú letöltés (progress követéssel) -------------------------------
#   1) POST /api/prepare  -> elindít egy letöltési jobot, visszaad egy job_id-t
#   2) GET  /api/progress/{job_id}  (SSE) -> élő % a letöltésről/konvertálásról
#   3) GET  /api/file/{job_id}  -> a kész fájl letöltése (utána takarít)

# job_id -> állapot dict: {status, progress, stage, filename, path, dir, error, ...}
_jobs: dict[str, dict] = {}


class _Cancelled(Exception):
    """A felhasználó megszakította a letöltést."""


def _build_opts(job_id: str, url: str, job_dir: Path, fmt: str, quality: str,
                start: float, end: float, duration: float,
                browser: str | None = None, audio_lang: str | None = None) -> dict:
    out_tmpl = str(job_dir / "out.%(ext)s")
    do_trim = start > 0 or (end > 0 and (not duration or end < duration - 0.05))

    def hook(d):
        # FIGYELEM: szakaszos vágásnál (download_ranges) a yt-dlp NEM hív 'downloading'
        # eseményt — csak egy 'finished'-et a végén. Ezért a tényleges letöltési % a
        # fájlméret-figyelő watcher szálból jön (_run_job). Itt csak a hook-adatokat
        # (sebesség/eta) frissítjük, ha vannak, és jelezzük a merge/processing fázist.
        job = _jobs.get(job_id)
        if not job:
            return
        if d["status"] == "downloading":
            total = (d.get("total_bytes") or d.get("total_bytes_estimate") or 0)
            done = d.get("downloaded_bytes") or 0
            fi = d.get("fragment_index")
            fc = d.get("fragment_count")
            if fc and fi is not None:
                pct = (fi / fc) * 100
            elif total:
                pct = done / total * 100
            else:
                pct = None
            job["stage"] = "downloading"
            if pct is not None:
                # a letöltés a 2–90% sávot kapja; a watcher és a hook közül a nagyobb nyer
                job["progress"] = max(job.get("progress", 0), min(90.0, 2 + pct * 0.88))
            sp = d.get("speed")
            if sp:
                job["speed"] = sp
            eta = d.get("eta")
            if eta is not None:
                job["eta"] = eta
        elif d["status"] == "finished":
            # egy stream letöltése kész — jöhet a merge/konvertálás
            job["stage"] = "processing"
            job["progress"] = max(job.get("progress", 0), 90.0)
            job["speed"] = 0

    def pp_hook(d):
        job = _jobs.get(job_id)
        if not job:
            return
        pp = (d.get("postprocessor") or "").lower()
        if d.get("status") == "started":
            job["stage"] = "processing"
            job["progress"] = max(job.get("progress", 0), 92.0)
        elif d.get("status") == "finished":
            base = 98.0 if ("ffmpeg" in pp or "merge" in pp) else 95.0
            job["progress"] = max(job.get("progress", 0), base)

    def cancel_hook(d):
        # ha a job-ot megszakították, megszakítjuk a letöltést is (a yt-dlp ezt elkapja)
        job = _jobs.get(job_id)
        if job and job.get("status") == "canceling":
            raise _Cancelled()

    opts = _base_opts()
    opts.update({
        "outtmpl": out_tmpl,
        "progress_hooks": [hook, cancel_hook],
        "postprocessor_hooks": [pp_hook],
        # --- gyorsítás --------------------------------------------------------
        "concurrent_fragment_downloads": 6,
        "retries": 5,
        "fragment_retries": 5,
        "socket_timeout": 20,
        "buffersize": 1024 * 1024 * 4,         # 4 MB pufferméret a gyorsabb íráshoz
        # http_chunk_size NINCS beállítva → a yt-dlp az alapértelmezett (egyben/optimális)
        # módon tölt; a 0 egyes szervereknél lassítana. A fragmentált DASH-t a
        # concurrent_fragment_downloads gyorsítja.
    })

    if is_valid_instagram_url(url):
        _apply_ig_auth(opts, browser)
    elif ".cdninstagram.com" in url or ".fbcdn.net" in url:
        # direkt IG videó-URL letöltése → kellenek a megfelelő fejlécek (különben 403)
        opts["http_headers"] = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                          "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Referer": "https://www.instagram.com/",
        }

    if do_trim:
        s = start if start and start > 0 else 0.0
        e = end if end and end > 0 else (duration or 0.0)
        opts["download_ranges"] = download_range_func(None, [(s, e)])
        # force_keyframes_at_cuts SZÁNDÉKOSAN kikapcsolva: az újrakódolást váltana ki
        # (nagyon lassú, és a progress sem mozog). Enélkül a vágás a legközelebbi
        # keyframe-re esik, de a letöltés sokszorosan gyorsabb (csak remux).

    if fmt == "mp3":
        br = quality or "192"
        # az 'iamf' (új, ritkán támogatott) audio codecet kerüljük, hogy biztos legyen a konvertálás
        opts["format"] = "bestaudio[acodec!=?iamf]/bestaudio/best"
        if audio_lang:
            opts["format"] = f"bestaudio[language={audio_lang}]/" + opts["format"]
        opts["postprocessors"] = [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "mp3",
            "preferredquality": str(int(br)),
        }]
    else:
        try:
            max_h = int(quality) if quality else 1080
        except ValueError:
            max_h = 1080
        # Előnyben részesítjük az MP4-be közvetlenül illő (H.264/AAC) streameket → a
        # merge gyorsabb, és sokszor remux elég (nincs lassú újrakódolás). Az [ext=mp4]/
        # [ext=m4a] szűrés egyúttal kizárja a problémás 'iamf' audiót is.
        opts["format"] = (
            f"bestvideo[height<={max_h}][ext=mp4]+bestaudio[ext=m4a]/"
            f"bestvideo[height<={max_h}]+bestaudio[acodec!=?iamf]/"
            f"best[height<={max_h}]/best"
        )
        if audio_lang:
            opts["format"] = (f"bestvideo[height<={max_h}][ext=mp4]+bestaudio[language={audio_lang}][ext=m4a]/"
                              f"bestvideo[height<={max_h}]+bestaudio[language={audio_lang}]/" + opts["format"])
        opts["format_sort"] = ["res", "vcodec:h264", "acodec:aac"]
        opts["merge_output_format"] = "mp4"
        opts["postprocessors"] = [{"key": "FFmpegVideoRemuxer", "preferedformat": "mp4"}]

    return opts


def _dir_bytes(d: Path) -> int:
    """A munkamappa összes (rész)fájljának mérete — a valós letöltött adat."""
    total = 0
    try:
        for p in d.iterdir():
            if p.is_file():
                try:
                    total += p.stat().st_size
                except OSError:
                    pass
    except OSError:
        pass
    return total


def _watch_progress(job_id: str, job_dir: Path, est_bytes: int):
    """Fájlméret-alapú progress — működik akkor is, amikor a yt-dlp hook NEM hív vissza
    (pl. szakaszos vágásnál). 0.3 mp-enként megnézi, mennyi adat van már a lemezen, és
    a becsült mérethez viszonyít. A hook (ha van) ezzel együtt a max()-on keresztül érvényesül."""
    import time
    while True:
        job = _jobs.get(job_id)
        if not job or job["status"] != "running":
            return
        # csak amíg a letöltés tart; a 90% felett a merge/konvertálás veszi át
        if job["stage"] in ("processing", "done"):
            return
        size = _dir_bytes(job_dir)
        if est_bytes > 0:
            pct = min(100.0, size / est_bytes * 100.0)
            # a letöltés a 2–90% sávot kapja
            mapped = min(90.0, 2 + pct * 0.88)
            job["progress"] = max(job.get("progress", 0), mapped)
        elif size > 0:
            # nincs becslés → enyhén kúszó jelzés, hogy ne ragadjon (max 80%-ig)
            job["progress"] = min(80.0, max(job.get("progress", 0), 5.0) + 0.6)
        time.sleep(0.3)


def _has_media_stream(path: Path, ffmpeg: Path, fmt: str) -> bool:
    probe = subprocess.run([str(ffmpeg), "-hide_banner", "-i", str(path)],
                           capture_output=True, text=True, errors="replace",
                           creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    return bool(re.search(r"Stream #.*: " + ("Audio:" if fmt == "mp3" else "Video:"), probe.stderr))


def _local_trim_fallback(job: dict, url: str, opts: dict, ext: str, ffmpeg: Path) -> Path:
    """Some HTTP servers cannot seek; download locally before retrying the cut."""
    folder = Path(job["dir"]) / "full-source"
    folder.mkdir(exist_ok=True)
    local_opts = {**opts, "outtmpl": str(folder / "source.%(ext)s")}
    local_opts.pop("download_ranges", None)
    with YoutubeDL(local_opts) as ydl:
        ydl.download([url])
    if job.get("status") == "canceling":
        raise _Cancelled()
    sources = list(folder.glob(f"*.{ext}"))
    if len(sources) != 1:
        raise RuntimeError("Nincs kimeneti fájl a helyi vágáshoz.")
    meta = job.get("meta", {})
    start, end = float(meta.get("start") or 0), float(meta.get("end") or 0)
    output = Path(job["dir"]) / f"trimmed.{ext}"
    command = [str(ffmpeg), "-nostdin", "-hide_banner", "-y", "-ss", str(start), "-i", str(sources[0])]
    if end > start:
        command += ["-t", str(end - start)]
    if ext == "mp3":
        command += ["-map", "0:a:0", "-c:a", "libmp3lame", "-b:a", str(meta.get("quality") or "192") + "k"]
    else:
        command += ["-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "veryfast",
                    "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-profile:a", "aac_low",
                    "-b:a", "192k", "-movflags", "+faststart"]
    command += ["-threads", "2", str(output)]
    job["stage"] = "processing"
    result = subprocess.run(command, capture_output=True, text=True, errors="replace",
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    if result.returncode or not output.exists():
        raise RuntimeError("Nem sikerült a helyi vágás: " + result.stderr[-500:])
    shutil.rmtree(folder, ignore_errors=True)
    return output


def _run_job(job_id: str, url: str, fmt: str, opts: dict, ext: str, est_bytes: int):
    job = _jobs[job_id]
    job_dir = Path(job["dir"])
    try:
        if job.get("status") in ("canceling", "canceled"):
            raise _Cancelled()
        ffmpeg = _ensure_ffmpeg_on_path()
        if ffmpeg:
            os.environ["FFMPEG_LOCATION"] = str(ffmpeg)
            opts["ffmpeg_location"] = str(ffmpeg)
            try:
                from yt_dlp.downloader.external import FFmpegFD
                FFmpegFD.available = classmethod(lambda cls, path=None: True)
            except Exception as e:  # noqa: BLE001
                _log(f"ffmpeg downloader availability patch failed: {e}")
        elif os.name == "nt":
            raise RuntimeError("ffmpeg is not installed and could not be downloaded.")
        # jelezzük, hogy elindult (a letöltés-hook néha csak később hív)
        job["stage"] = "downloading"
        job["progress"] = 2.0
        # fájlméret-figyelő háttérszál (a hook hiánya ellen)
        watcher = threading.Thread(
            target=_watch_progress, args=(job_id, job_dir, est_bytes), daemon=True
        )
        watcher.start()
        try:
            with YoutubeDL(opts) as ydl:
                ydl.download([url])
        except Exception as exc:
            if job.get("status") == "canceling":
                raise _Cancelled() from exc
            if not (is_valid_youtube_url(url) and _is_yt_botblock(exc) and _yt_cookiefile()):
                raise
            _apply_yt_auth(opts)
            with YoutubeDL(opts) as ydl:
                ydl.download([url])
        if job.get("status") == "canceling":
            raise _Cancelled()
        files = [p for p in job_dir.glob(f"*.{ext}") if p.stat().st_size > 0]
        if not files:
            raise RuntimeError("Nincs kimeneti fájl.")
        output = files[0]
        if ffmpeg and not _has_media_stream(output, ffmpeg, fmt):
            if "download_ranges" not in opts:
                raise RuntimeError("A letöltött fájl nem tartalmaz lejátszható médiát.")
            output = _local_trim_fallback(job, url, opts, ext, ffmpeg)
            if not _has_media_stream(output, ffmpeg, fmt):
                raise RuntimeError("A vágott fájl nem tartalmaz lejátszható médiát.")
        if job.get("status") == "canceling":
            raise _Cancelled()
        output = _attach_subtitles(job, output, ffmpeg)
        job["path"] = str(output)
        if job.get("auto_save"):
            _auto_save(job_id, job, ffmpeg)
        job["progress"] = 100.0
        job["stage"] = "done"
        job["status"] = "done"
    except _Cancelled:
        print("[download] megszakítva:", job_id, flush=True)
        job["status"] = "canceled"
        job["stage"] = "canceled"
        job["error"] = None
        shutil.rmtree(job["dir"], ignore_errors=True)
    except Exception as e:  # noqa: BLE001
        if job.get("status") == "canceling":
            job["status"] = "canceled"
            job["stage"] = "canceled"
            shutil.rmtree(job["dir"], ignore_errors=True)
            return
        msg = str(e)
        print("[download] hiba:", msg[:300], flush=True)
        job["status"] = "error"
        job["error"] = _friendly_error(msg, url)
        shutil.rmtree(job["dir"], ignore_errors=True)


def _srt_time(ms: float) -> str:
    return _vtt_time(ms).replace(".", ",")


def _subtitle_cues(entry: dict) -> list[tuple[int, int, str]]:
    with httpx.Client(timeout=20, follow_redirects=True) as client:
        response = client.get(entry["url"])
    response.raise_for_status()
    if entry.get("ext") == "json3":
        cues = []
        for event in response.json().get("events") or []:
            text = "".join(seg.get("utf8", "") for seg in event.get("segs") or []).strip()
            if text and "tStartMs" in event:
                cues.append((event["tStartMs"], event["tStartMs"] + (event.get("dDurationMs") or 2000), text))
        return cues
    cues = []
    for block in re.split(r"\n\s*\n", response.text.replace("\r", "")):
        match = re.search(r"(\d+):(\d+):(\d+)[.,](\d+)\s*-->\s*(\d+):(\d+):(\d+)[.,](\d+)", block)
        if not match:
            continue
        v = [int(x) for x in match.groups()]
        text = re.sub(r"<[^>]+>", "", block[match.end():]).strip()
        if text:
            cues.append(((v[0] * 3600 + v[1] * 60 + v[2]) * 1000 + v[3],
                         (v[4] * 3600 + v[5] * 60 + v[6]) * 1000 + v[7], text))
    return cues


def _attach_subtitles(job: dict, output: Path, ffmpeg: Path | None) -> Path:
    """Fetch the chosen subtitle, shift it to the trimmed range, then embed it or keep an .srt."""
    meta = job.get("meta") or {}
    lang, mode = meta.get("subs"), meta.get("subs_mode") or "embed"
    if not lang or not ffmpeg:
        return output
    job["stage"] = "processing"
    try:
        entry = _subtitle_entry(_extract_info(meta["url"], None), lang, bool(meta.get("subs_auto")))
        if not entry:
            raise RuntimeError("missing subtitle")
        offset = int(float(meta.get("start") or 0) * 1000)
        limit = int(float(meta.get("end") or 0) * 1000) or None
        lines, index, shifted = [], 0, []
        for start, end, text in _subtitle_cues(entry):
            if end <= offset or (limit and start >= limit):
                continue
            index += 1
            start, end = max(0, start - offset), (min(end, limit) if limit else end) - offset
            shifted.append((start, end, text))
            lines += [str(index), f"{_srt_time(start)} --> {_srt_time(end)}", text, ""]
        if not lines:
            raise RuntimeError("empty subtitle")
        srt = output.with_suffix(f".{lang}.srt")
        srt.write_text("\n".join(lines), encoding="utf-8")
        if mode == "burn" and output.suffix == ".mp4":
            return _burn_subtitles(job, output, ffmpeg, shifted, meta.get("subs_style") or {}, srt)
        if mode == "srt" or output.suffix != ".mp4":
            job["extra_files"] = [str(srt)]
            return output
        embedded = output.with_name("subbed.mp4")
        result = subprocess.run([str(ffmpeg), "-nostdin", "-hide_banner", "-y", "-i", str(output), "-i", str(srt),
                                 "-map", "0", "-map", "1", "-c", "copy", "-c:s", "mov_text",
                                 "-metadata:s:s:0", f"language={lang[:3]}", "-movflags", "+faststart",
                                 str(embedded)], capture_output=True,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if result.returncode or not embedded.exists():
            raise RuntimeError("embed failed")
        output.unlink(missing_ok=True)
        srt.unlink(missing_ok=True)
        return embedded
    except Exception as exc:  # noqa: BLE001 - the video itself is still fine
        _log(f"Subtitle step failed: {type(exc).__name__}: {str(exc)[:120]}")
        job["warning"] = "A felirat nem került bele (a videó elkészült)."
        return output


_SUB_FONTS = {"sans": "Segoe UI", "mono": "Consolas", "serif": "Georgia", "casual": "Comic Sans MS",
              "smallcaps": "Segoe UI"}


def _ass_color(hex_color: str, opacity: float = 1.0) -> str:
    """#RRGGBB + opacity → ASS &HAABBGGRR (alpha 00 = opaque)."""
    value = hex_color.lstrip("#") if re.fullmatch(r"#?[0-9a-fA-F]{6}", hex_color or "") else "ffffff"
    alpha = round((1 - max(0.0, min(1.0, opacity))) * 255)
    return f"&H{alpha:02X}{value[4:6]}{value[2:4]}{value[0:2]}".upper()


def _ass_time(ms: float) -> str:
    cs = max(0, int(round(ms / 10)))
    return f"{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}"


def build_ass(cues: list[tuple[int, int, str]], style: dict, width: int, height: int) -> str:
    """The same look as the app's preview overlay (size, colours, box, edge, font)."""
    scale = max(0.5, min(3.0, float(style.get("size") or 100) / 100))
    font_size = max(12, round(height * 0.052 * scale))
    font = _SUB_FONTS.get(style.get("font"), "Segoe UI")
    primary = _ass_color(style.get("color") or "#ffffff")
    bg_opacity = max(0, min(100, int(style.get("bgOpacity", 75)))) / 100
    edge = style.get("edge") or "none"
    if bg_opacity > 0.02:
        box = _ass_color(style.get("bg") or "#080808", bg_opacity)
        border_style, outline_colour, back_colour = 3, box, box
        outline, shadow = round(font_size * 0.12, 1), 0
    else:
        border_style, outline_colour, back_colour = 1, "&H00000000", "&H80000000"
        outline = {"outline": 2.2, "raised": 0.6, "depressed": 0.6}.get(edge, 0)
        shadow = {"shadow": 2.5, "raised": 1.5}.get(edge, 0)
    header = [
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {width}", f"PlayResY: {height}",
        "ScaledBorderAndShadow: yes", "WrapStyle: 0", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
        "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, "
        "MarginR, MarginV, Encoding",
        f"Style: Default,{font},{font_size},{primary},{primary},{outline_colour},{back_colour},0,0,0,0,100,100,0,0,"
        f"{border_style},{outline},{shadow},2,{round(width * 0.04)},{round(width * 0.04)},{round(height * 0.07)},1",
        "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    events = []
    for start, end, text in cues:
        clean = re.sub(r"[\u200b\u200c\u200d\ufeff]", "", text).replace("{", "(").replace("}", ")")
        clean = re.sub(r"[ \t\u00a0]{2,}", " ", clean).strip().replace("\n", r"\N")
        if clean:
            events.append(f"Dialogue: 0,{_ass_time(start)},{_ass_time(end)},Default,,0,0,0,,{clean}")
    return "\n".join(header + events) + "\n"


def _burn_subtitles(job: dict, output: Path, ffmpeg: Path, cues, style: dict, srt: Path) -> Path:
    probe = media_library.probe_media(ffmpeg, output)
    width, height = probe.get("width") or 1920, probe.get("height") or 1080
    folder = output.parent
    (folder / "subs.ass").write_text(build_ass(cues, style, width, height), encoding="utf-8")
    burned = folder / "burned.mp4"
    fonts = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "Fonts").replace("\\", "/").replace(":", "\\:")
    # Relative file name and cwd: no Windows path escaping inside the filter graph.
    command = [str(ffmpeg), "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", output.name,
               "-vf", f"ass=subs.ass:fontsdir='{fonts}'", "-c:v", "libx264", "-preset", "veryfast", "-crf", "19",
               "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart", burned.name]
    result = subprocess.run(command, cwd=str(folder), capture_output=True, text=True, errors="replace",
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.returncode or not burned.exists():
        raise RuntimeError("burn failed: " + result.stderr[-200:])
    output.unlink(missing_ok=True)
    srt.unlink(missing_ok=True)
    return burned


def _auto_save(job_id: str, job: dict, ffmpeg: Path | None) -> None:
    folder = Path(_app_settings()["download_dir"])
    source = Path(job["path"])
    target = media_library.move_into(source, folder, job["filename"])
    for extra in job.get("extra_files") or []:
        extra_path = Path(extra)
        if extra_path.exists():
            media_library.move_into(extra_path, folder, target.stem + "".join(extra_path.suffixes[-2:]))
    item = _library.add(str(target), job.get("meta") or {}, ffmpeg, _thumbnail_bytes(job))
    job.update({"path": str(target), "saved_path": str(target), "library_id": item["id"]})
    shutil.rmtree(job["dir"], ignore_errors=True)


def _thumbnail_bytes(job: dict) -> bytes | None:
    """Audio files have no frame to grab; keep the source artwork instead."""
    thumb = (job.get("meta") or {}).get("thumbnail")
    if job.get("format") != "mp3" or not thumb or not is_http_url(thumb):
        return None
    try:
        with httpx.Client(timeout=10, follow_redirects=True) as client:
            response = client.get(thumb)
        if response.status_code == 200 and response.headers.get("content-type", "").startswith("image/"):
            return response.content
    except httpx.HTTPError:
        pass
    return None


def _friendly_error(msg: str, url: str) -> str:
    """Nyers yt-dlp hibából érthető magyar üzenet."""
    m = msg.lower()
    if is_valid_instagram_url(url) and ("login" in m or "cookies" in m or "rate-limit" in m
                                        or "not available" in m or "empty media" in m):
        return "Az Instagram bejelentkezést kér ehhez a tartalomhoz. Próbálj másik nyilvános linket."
    if "drm" in m or "skd://" in m:
        return "A forrás DRM-védett."
    if "requested format is not available" in m or "no video formats" in m:
        return "Ehhez a videóhoz nem érhető el a kért formátum. Próbálj másik felbontást."
    if "ffmpeg" in m and ("not installed" in m or "could not be downloaded" in m):
        return "Az ffmpeg nincs telepitve vagy nem sikerult letolteni. Inditsd ujra az appot, vagy ellenorizd az internetkapcsolatot."
    if is_valid_youtube_url(url) and ("sign in to confirm" in m or "bot" in m):
        return "A YouTube bot-védelmet kért. Próbáld újra kicsit később."
    if is_valid_tiktok_url(url):
        return "A TikTok nem adta vissza a videót. Próbáld a teljes videólinket, és ellenőrizd, hogy nyilvános-e."
    return "Nem sikerült a letöltés. Próbáld újra, vagy válassz másik minőséget."


_LANG_RE = re.compile(r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,2}")


async def start_download(url: str, format: str = "mp4", quality: str = "", start: float = 0.0, end: float = 0.0,
                         browser: str = "", source: str = "any", audio_lang: str = "", subs: str = "",
                         subs_auto: bool = False, subs_mode: str = "embed", auto_save: bool | None = None,
                         origin: str = "app", subs_style: dict | None = None) -> dict:
    validate_source_url(url, source)
    if format not in ("mp3", "mp4"):
        raise HTTPException(400, "Érvénytelen formátum.")
    if quality and (not quality.isdigit() or not 1 <= int(quality) <= (320 if format == "mp3" else 8640)):
        raise HTTPException(400, "Érvénytelen minőség.")
    if not all(math.isfinite(v) and v >= 0 for v in (start, end)) or (end and end <= start):
        raise HTTPException(400, "Érvénytelen vágási tartomány.")
    for value in (audio_lang, subs):
        if value and not _LANG_RE.fullmatch(value):
            raise HTTPException(400, "Érvénytelen nyelvkód.")
    if subs_mode not in ("embed", "srt", "burn"):
        raise HTTPException(400, "Érvénytelen feliratmód.")

    is_ig = is_valid_instagram_url(url)
    try:
        info = await get_info(url, browser or ("auto" if is_ig else None))
    except Exception as exc:
        raise HTTPException(502, _friendly_error(str(exc), url)) from exc
    title = sanitize_filename(info.get("title") or "video")
    ext = "mp3" if format == "mp3" else "mp4"
    duration = float(_preview_durations.get(url) or info.get("duration") or 0)
    if duration and (start >= duration or end > duration + 0.1):
        raise HTTPException(400, "A kijelölt rész túlér a videó hosszán.")

    # Ha az info a guest-API-ból jött (InstagramGuest), a letöltést a DIREKT videó-URL-re
    # indítjuk. FONTOS: a cdninstagram URL időkorlátos (403 lejárat után), ezért letöltés
    # ELŐTT FRISSEN újrakérjük, hogy biztosan élő linkkel induljunk.
    download_url = info.get("_downloader_url") or url
    if info.get("extractor_key") == "InstagramGuest":
        fresh = await asyncio.to_thread(_ig_fresh_url, url)
        if fresh:
            download_url = fresh
        elif info.get("url"):
            download_url = info["url"]

    # becsült végméret (a fájlméret-alapú progresshez) — a kijelölt szakaszra
    s = max(0.0, start)
    e = min(end, duration) if end and duration else (end or duration)
    seconds = max(0.0, (e - s) if (s or e) else duration)
    est_bytes = int(estimate_bitrate_bps(info, format, quality) / 8 * (seconds or duration or 1))

    source = _source_for_url(url)
    job_id = os.urandom(8).hex()
    job_dir = Path(tempfile.mkdtemp(dir=TMP_DIR))
    if auto_save is None:
        auto_save = _app_settings()["save_mode"] == "auto"
    trimmed = bool(s > 0.01 or (e and duration and e < duration - 0.05))
    job = {
        "status": "running",
        "stage": "starting",
        "progress": 0.0,
        "speed": 0,
        "eta": None,
        "filename": f"{title}.{ext}",
        "ext": ext,
        "format": format,
        "dir": str(job_dir),
        "path": None,
        "error": None,
        "created": time.time(),
        "auto_save": bool(auto_save),
        "origin": origin,
        "kind": "download",
        # a folyamatok menühöz / visszahozáshoz:
        "meta": {
            "title": info.get("title") or "video",
            "url": url,
            "source": source,
            "thumbnail": best_thumbnail(info),
            "quality": quality,
            "start": s if trimmed else 0,
            "end": e if trimmed else 0,
            "duration": duration,
            "audio_lang": audio_lang,
            "subs": subs,
            "subs_auto": subs_auto,
            "subs_mode": subs_mode,
            "subs_style": {k: v for k, v in (subs_style or {}).items()
                           if k in ("size", "color", "bg", "bgOpacity", "font", "edge")},
        },
    }

    opts = _build_opts(job_id, download_url, job_dir, format, quality, start, end, duration, browser or None,
                       audio_lang or None)
    with _job_admission:
        if _updater.status()["state"] == "restarting":
            shutil.rmtree(job_dir, ignore_errors=True)
            raise HTTPException(409, "Az alkalmazás éppen frissül.")
        _jobs[job_id] = job
        _download_pool.submit(_run_job, job_id, download_url, format, opts, ext, est_bytes)
    return {"job_id": job_id, "filename": job["filename"]}


@app.post("/api/prepare")
async def api_prepare(
    url: str = Query(...),
    format: str = "mp4",
    quality: str = "",
    start: float = 0.0,
    end: float = 0.0,
    browser: str = "",
    source: str = "any",
    audio_lang: str = "",
    subs: str = "",
    subs_auto: bool = False,
    subs_mode: str = "embed",
    subs_style: str = "",
):
    try:
        style = json.loads(subs_style) if subs_style and len(subs_style) < 600 else {}
    except ValueError:
        style = {}
    return await start_download(url, format, quality, start, end, browser, source, audio_lang, subs,
                                subs_auto, subs_mode, subs_style=style if isinstance(style, dict) else {})


@app.get("/api/progress/{job_id}")
async def api_progress(job_id: str):
    """Server-Sent Events stream a job állapotáról."""
    if job_id not in _jobs:
        raise HTTPException(404, "Ismeretlen job.")

    async def event_stream():
        import json
        while True:
            job = _jobs.get(job_id)
            if not job:
                break
            payload = {
                "status": job["status"],
                "stage": job["stage"],
                "progress": round(job["progress"], 1),
                "speed": job.get("speed") or 0,
                "eta": job.get("eta"),
                "error": job["error"],
            }
            yield f"data: {json.dumps(payload)}\n\n"
            if job["status"] in ("done", "error", "canceled"):
                break
            await asyncio.sleep(0.25)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.get("/api/jobs")
async def api_jobs():
    """Az aktuális folyamatok listája (a Folyamatok menühöz)."""
    out = []
    for jid, job in sorted(_jobs.items(), key=lambda kv: kv[1].get("created", 0), reverse=True):
        meta = job.get("meta") or {}
        out.append({
            "job_id": jid,
            "status": job["status"],
            "stage": job["stage"],
            "progress": round(job["progress"], 1),
            "speed": job.get("speed") or 0,
            "filename": job.get("filename"),
            "title": meta.get("title"),
            "thumbnail": meta.get("thumbnail"),
            "source": meta.get("source"),
            "url": meta.get("url"),
            "quality": meta.get("quality"),
            "start": meta.get("start"),
            "end": meta.get("end"),
            "format": job.get("format"),
            "error": job.get("error"),
            "eta": job.get("eta"),
            "saved": job.get("saved_path"),
            "libraryId": job.get("library_id"),
            "warning": job.get("warning"),
            "kind": job.get("kind", "download"),
            "origin": job.get("origin", "app"),
        })
    return {"jobs": out}


@app.post("/api/cancel/{job_id}")
async def api_cancel(job_id: str):
    """Letöltés/előkészítés megszakítása."""
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Ismeretlen job.")
    if job["status"] in ("running", "starting"):
        job["status"] = "canceling"
        job["stage"] = "canceling"
    return {"ok": True, "status": job["status"]}


@app.post("/api/jobs/{job_id}/dismiss")
async def api_dismiss(job_id: str):
    """Befejezett/hibás/megszakított job eltávolítása a listából."""
    job = _jobs.get(job_id)
    if job and job["status"] in ("done", "error", "canceled"):
        shutil.rmtree(job["dir"], ignore_errors=True)
        _jobs.pop(job_id, None)
    return {"ok": True}


@app.get("/api/file/{job_id}")
async def api_file(job_id: str):
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Ismeretlen job.")
    if job["status"] != "done" or not job["path"]:
        raise HTTPException(409, "A fájl még nem áll készen.")

    media_type = "audio/mpeg" if job["format"] == "mp3" else "video/mp4"
    quoted = urllib.parse.quote(job["filename"])

    def _cleanup():
        shutil.rmtree(job["dir"], ignore_errors=True)
        _jobs.pop(job_id, None)

    return FileResponse(
        path=job["path"],
        media_type=media_type,
        filename=job["filename"],
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quoted}"},
        background=BackgroundTask(_cleanup),
    )


# ----------------------------------------------------------------------------
# Frontend kiszolgálása (utolsóként, hogy az /api útvonalak elsőbbséget kapjanak)
# ----------------------------------------------------------------------------

# ----------------------------------------------------------------------------
# Helyi védelem: csak a saját ablak hívhat állapotváltoztató végpontokat
# ----------------------------------------------------------------------------

@app.middleware("http")
async def _local_guard(request: Request, call_next):
    host = (request.headers.get("host") or "").rsplit(":", 1)[0].strip("[]")
    if host not in ("127.0.0.1", "localhost", "::1", "testserver"):
        return Response("Forbidden host", status_code=403)  # DNS rebinding
    path = request.url.path
    if (request.method not in ("GET", "HEAD", "OPTIONS") and path.startswith("/api/")
            and request.headers.get("x-downloader") != "1"):
        return Response("Missing client header", status_code=403)  # cross-site form posts
    return await call_next(request)


# ----------------------------------------------------------------------------
# Alkalmazás-beállítások
# ----------------------------------------------------------------------------

_settings_lock = threading.Lock()
_DEFAULTS = {
    "save_mode": "auto",            # auto: a letöltési mappába; ask: Mentés másként
    "download_dir": str(Path.home() / "Downloads" / "Downloader"),
    "mcp_mode": "ask",              # off | ask | full
    "default_format": "mp4",
    "default_quality": "1080",
    "animations": "high",           # high | low | off
    "background_dim": 35,           # az animált témák sötétítése
    "scene_effects": True,          # kurzorra reagáló effektek az animált témákon
    "mcp_blocked": [],              # letiltott AI-k (claude, openai, gemini, kimi, grok, deepseek)
}


def _app_settings() -> dict:
    stored = _load_settings()
    merged = {**_DEFAULTS, **{k: stored[k] for k in _DEFAULTS if k in stored}}
    if merged["mcp_mode"] not in ("off", "ask", "full"):
        merged["mcp_mode"] = "ask"
    return merged


def _update_settings(changes: dict) -> dict:
    with _settings_lock:
        stored = _load_settings()
        for key, value in changes.items():
            if key not in _DEFAULTS:
                continue
            if key == "save_mode" and value not in ("auto", "ask"):
                continue
            if key == "mcp_mode" and value not in ("off", "ask", "full"):
                continue
            if key == "animations" and value not in ("high", "low", "off"):
                continue
            if key == "download_dir":
                value = str(value).strip()
                if not value or not Path(value).is_absolute():
                    continue
            if key == "background_dim":
                value = max(0, min(90, int(value)))
            if key == "scene_effects":
                value = bool(value)
            if key == "mcp_blocked":
                if not isinstance(value, list):
                    continue
                value = sorted({str(v) for v in value if str(v) in mcp_server.AI_NAMES})
            stored[key] = value
        _save_settings(stored)
    return _app_settings()


def _mcp_token() -> str:
    with _settings_lock:
        stored = _load_settings()
        if not stored.get("mcp_token"):
            stored["mcp_token"] = base64.urlsafe_b64encode(os.urandom(24)).decode().rstrip("=")
            _save_settings(stored)
        return stored["mcp_token"]


@app.get("/api/settings")
async def api_settings():
    return _app_settings()


@app.post("/api/settings")
async def api_settings_update(request: Request):
    changes = await request.json()
    if not isinstance(changes, dict):
        raise HTTPException(400, "Érvénytelen beállítás.")
    settings = await asyncio.to_thread(_update_settings, changes)
    if "mcp_blocked" in changes:
        for session in _mcp_sessions.listing():
            if session["ai"] in settings["mcp_blocked"]:
                _mcp_sessions.revoke(session["id"])
    return settings


@app.get("/api/mcp/config")
async def api_mcp_config():
    executable = sys.executable if getattr(sys, "frozen", False) else str(Path(sys.executable))
    args = ["--mcp"] if getattr(sys, "frozen", False) else [str(Path(__file__).resolve()), "--mcp"]
    url = json.loads(SERVER_FILE.read_text(encoding="utf-8"))["url"] if SERVER_FILE.exists() else ""
    return {"command": executable, "args": args, "url": url + "/mcp" if url else "", "token": _mcp_token(),
            "mode": _app_settings()["mcp_mode"], "log": _approvals.log[:20]}


@app.post("/api/mcp/token/reset")
async def api_mcp_token_reset():
    with _settings_lock:
        stored = _load_settings()
        stored.pop("mcp_token", None)
        _save_settings(stored)
    token = _mcp_token()
    _write_server_file()
    return {"token": token}


@app.post("/api/mcp/approve/{approval_id}")
async def api_mcp_approve(approval_id: str, allow: bool = False):
    return {"ok": _approvals.answer(approval_id, allow)}


@app.get("/api/pulse")
async def api_pulse():
    """Cheap poll for the UI: background jobs (e.g. started by AI) and pending approvals."""
    active = sum(1 for job in _jobs.values() if job["status"] in ("running", "starting", "canceling"))
    connected = [{"id": s["id"], "ai": s["ai"], "label": s["label"]} for s in _mcp_sessions.listing() if s["connected"]]
    return {"active": active, "jobs": len(_jobs), "approvals": _approvals.listing(), "library": _library.rev,
            "ai": connected, "mcpMode": _app_settings()["mcp_mode"]}


# ----------------------------------------------------------------------------
# Letöltési galéria
# ----------------------------------------------------------------------------

def _public_item(item: dict) -> dict:
    return {**item, "hasThumb": _library.thumb_path(item["id"]) is not None,
            "folder": str(Path(item["path"]).parent), "file": Path(item["path"]).name}


@app.get("/api/library")
async def api_library():
    items = await asyncio.to_thread(_library.items)
    return {"items": [_public_item(x) for x in items], "rev": _library.rev,
            "folder": _app_settings()["download_dir"]}


def _library_item(item_id: str) -> dict:
    item = _library.get(item_id)
    if not item:
        raise HTTPException(404, "A fájl már nem található.")
    return item


@app.get("/api/library/{item_id}/file")
async def api_library_file(item_id: str):
    item = _library_item(item_id)
    media_type = "audio/mpeg" if item["format"] == "mp3" else "video/mp4"
    return FileResponse(item["path"], media_type=media_type, headers={"Cache-Control": "no-store"})


@app.get("/api/library/{item_id}/thumb")
async def api_library_thumb(item_id: str):
    path = _library.thumb_path(item_id)
    if not path:
        raise HTTPException(404, "Nincs bélyegkép.")
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "max-age=3600"})


@app.post("/api/library/delete")
async def api_library_delete(request: Request):
    ids = (await request.json()).get("ids") or []
    removed = await asyncio.to_thread(_library.remove, [str(x) for x in ids][:500])
    return {"removed": removed}


@app.post("/api/library/{item_id}/reveal")
async def api_library_reveal(item_id: str):
    media_library.reveal(_library_item(item_id)["path"])
    return {"ok": True}


@app.post("/api/library/{item_id}/open")
async def api_library_open(item_id: str):
    media_library.open_file(_library_item(item_id)["path"])
    return {"ok": True}


@app.post("/api/library/{item_id}/rename")
async def api_library_rename(item_id: str, request: Request):
    title = str((await request.json()).get("title") or "")
    try:
        item = await asyncio.to_thread(_library.rename, item_id, title)
    except OSError as exc:
        raise HTTPException(409, "Ilyen nevű fájl már létezik, vagy a fájl használatban van.") from exc
    if not item:
        raise HTTPException(400, "Érvénytelen név.")
    return _public_item(item)


@app.post("/api/library/folder/open")
async def api_library_folder_open():
    folder = Path(_app_settings()["download_dir"])
    folder.mkdir(parents=True, exist_ok=True)
    media_library.open_file(str(folder))
    return {"ok": True}


def _run_edit_job(job_id: str, item: dict, start: float, end: float, height: int, fmt: str, replace: bool):
    job = _jobs[job_id]
    try:
        ffmpeg = _ensure_ffmpeg_on_path()
        if not ffmpeg:
            raise RuntimeError("ffmpeg is not installed")
        source = Path(item["path"])
        ext = "mp3" if fmt == "mp3" else "mp4"
        output = Path(job["dir"]) / f"edit.{ext}"
        length = (end - start) if end > start else max(0.0, (item.get("duration") or 0) - start)
        command = [str(ffmpeg), "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-progress", "pipe:1"]
        if start > 0:
            command += ["-ss", f"{start:.3f}"]
        command += ["-i", str(source)]
        if end > start:
            command += ["-t", f"{end - start:.3f}"]
        if ext == "mp3":
            command += ["-vn", "-c:a", "libmp3lame", "-b:a", "192k"]
        else:
            command += ["-map", "0:v:0?", "-map", "0:a:0?", "-map", "0:s?", "-c:s", "mov_text",
                        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
                        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]
            if height:
                command += ["-vf", f"scale=-2:{int(height)}"]
        command.append(str(output))
        job["stage"] = "processing"
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        for line in process.stdout:
            if job.get("status") == "canceling":
                process.kill()
                raise _Cancelled()
            if line.startswith("out_time_ms=") and length:
                try:
                    done = int(line.split("=", 1)[1]) / 1_000_000
                    job["progress"] = max(job["progress"], min(98.0, done / length * 100))
                except ValueError:
                    pass
        stderr = process.stderr.read()
        if process.wait() or not output.exists():
            raise RuntimeError("ffmpeg: " + stderr[-300:])
        meta = {**item, "title": item["title"] if replace else f"{item['title']} (szerkesztett)",
                "start": 0, "end": 0, "duration": length or item.get("duration")}
        if replace:
            if not media_library.recycle(str(source)):
                raise RuntimeError("Az eredeti fájl nem törölhető (használatban van?).")
            target = media_library.move_into(output, source.parent, source.stem + "." + ext)
            _library.remove([item["id"]], delete_files=False)
        else:
            target = media_library.move_into(output, source.parent, sanitize_filename(meta["title"]) + "." + ext)
        thumb = _library.thumb_path(item["id"])
        new_item = _library.add(str(target), meta, ffmpeg,
                                thumb.read_bytes() if thumb and ext == "mp3" else None)
        job.update({"path": str(target), "saved_path": str(target), "library_id": new_item["id"],
                    "progress": 100.0, "stage": "done", "status": "done"})
    except _Cancelled:
        job.update({"status": "canceled", "stage": "canceled"})
    except Exception as exc:  # noqa: BLE001
        _log(f"Edit failed: {exc}")
        job.update({"status": "error", "error": "A szerkesztés nem sikerült: " + str(exc)[:160]})
    finally:
        shutil.rmtree(job["dir"], ignore_errors=True)


def start_edit(item_id: str, start: float = 0, end: float = 0, height: int = 0, fmt: str = "",
               replace: bool = False, origin: str = "app") -> dict:
    item = _library_item(item_id)
    fmt = fmt or ("mp3" if item["format"] == "mp3" else "mp4")
    if fmt not in ("mp3", "mp4") or not all(math.isfinite(v) and v >= 0 for v in (start, end)) \
            or (end and end <= start) or not 0 <= int(height or 0) <= 4320:
        raise HTTPException(400, "Érvénytelen szerkesztési beállítás.")
    job_id = os.urandom(8).hex()
    job = {"status": "running", "stage": "processing", "progress": 0.0, "speed": 0, "eta": None,
           "filename": Path(item["path"]).stem + "." + fmt, "ext": fmt, "format": fmt,
           "dir": tempfile.mkdtemp(dir=TMP_DIR), "path": None, "error": None, "created": time.time(),
           "kind": "edit", "origin": origin, "auto_save": True,
           "meta": {"title": item["title"], "url": item.get("url"), "source": item.get("source"),
                    "thumbnail": item.get("thumbnail"), "quality": str(height or ""), "start": start, "end": end,
                    "duration": item.get("duration")}}
    _jobs[job_id] = job
    _download_pool.submit(_run_edit_job, job_id, item, float(start), float(end), int(height or 0), fmt, replace)
    return {"job_id": job_id}


@app.post("/api/library/{item_id}/edit")
async def api_library_edit(item_id: str, request: Request):
    body = await request.json()
    return start_edit(item_id, float(body.get("start") or 0), float(body.get("end") or 0),
                      int(body.get("height") or 0), str(body.get("format") or ""), bool(body.get("replace")))


# ----------------------------------------------------------------------------
# Saját hátterek (kép, videó, Wallpaper Engine) és beépített animált témák
# ----------------------------------------------------------------------------

_backgrounds = backgrounds.Backgrounds(BACKGROUND_DIR, lambda: _load_settings(), lambda s: _save_settings(s),
                                       lambda: _ensure_ffmpeg_on_path(), _settings_lock)
_bundled_themes = theme_media.BundledThemes(USER_DATA_DIR / "theme-videos", BASE_DIR / "wallpapers", lambda message: _log(message))


def _valid_theme(theme) -> bool:
    if not isinstance(theme, str):
        return False
    if theme.startswith("custom:"):
        return _backgrounds.get(theme[7:]) is not None
    return theme in (_THEMES | {"auto"})


def _public_theme(theme: dict) -> dict:
    return {**{k: v for k, v in theme.items() if k not in ("properties",)},
            "hasThumb": _backgrounds.thumb_path(theme["id"]) is not None}


@app.get("/api/custom-themes")
async def api_custom_themes():
    themes = await asyncio.to_thread(_backgrounds.themes)
    return {"themes": [_public_theme(t) for t in themes]}


@app.post("/api/custom-themes/{theme_id}")
async def api_custom_theme_update(theme_id: str, request: Request):
    try:
        return _public_theme(await asyncio.to_thread(_backgrounds.update, theme_id, await request.json()))
    except KeyError as exc:
        raise HTTPException(404, "Nincs ilyen saját téma.") from exc


@app.post("/api/custom-themes/{theme_id}/delete")
async def api_custom_theme_delete(theme_id: str):
    return {"ok": await asyncio.to_thread(_backgrounds.delete, theme_id)}


@app.get("/api/custom-themes/{theme_id}/media")
async def api_custom_theme_media(theme_id: str):
    theme = _backgrounds.get(theme_id)
    path = _backgrounds.media_path(theme) if theme else None
    if not path:
        raise HTTPException(404, "A háttérfájl nem található.")
    return FileResponse(path, headers={"Cache-Control": "max-age=3600"})


@app.get("/api/custom-themes/{theme_id}/thumb")
async def api_custom_theme_thumb(theme_id: str):
    path = _backgrounds.thumb_path(theme_id)
    if not path:
        raise HTTPException(404, "Nincs előnézet.")
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "max-age=600"})


def _wallpaper_file(path: Path, project: dict, relative: str, muted: bool):
    headers = {"Cache-Control": "no-store", "Content-Security-Policy": "frame-ancestors 'self'"}
    if project.get("kind") == "web":
        suffix = path.suffix.lower()
        if suffix in (".html", ".htm", ".svg", ".xml", ".xhtml"):
            headers["Content-Security-Policy"] += "; sandbox allow-scripts"
        if suffix in backgrounds.IMAGE | backgrounds.VIDEO | {".svg", ".woff", ".woff2", ".ttf"}:
            headers["Access-Control-Allow-Origin"] = "*"
        if suffix in (".html", ".htm") and Path(relative) == Path(project.get("file", "")):
            html = path.read_text(encoding="utf-8", errors="replace")
            return Response(backgrounds.inject_bridge(html, project.get("properties") or {}, muted),
                            media_type="text/html; charset=utf-8", headers=headers)
    return FileResponse(path, headers=headers)


@app.get("/api/custom-themes/{theme_id}/files/{relative:path}")
async def api_custom_theme_files(theme_id: str, relative: str):
    """Wallpaper Engine web/scene files; web pages run in a sandboxed iframe."""
    theme = _backgrounds.get(theme_id)
    if not theme or theme["kind"] not in ("web", "scene"):
        raise HTTPException(404, "Nincs ilyen háttér.")
    path = _backgrounds.web_file(theme, relative or theme["file"])
    if not path:
        raise HTTPException(404, "A fájl nem található.")
    return _wallpaper_file(path, theme, relative, not theme.get("sound"))


@app.get("/api/theme-video/{scene}/files/{relative:path}")
async def api_theme_files(scene: str, relative: str):
    if scene not in theme_media.DEFAULT_PROJECTS:
        raise HTTPException(404, "Ismeretlen téma.")
    asset = await asyncio.to_thread(_bundled_themes.asset, scene, relative)
    if not asset:
        raise HTTPException(404, "A fájl nem található.")
    path, project = asset
    return _wallpaper_file(path, project, relative, True)


@app.get("/api/wallpaper-engine")
async def api_wallpaper_engine():
    return {"items": await asyncio.to_thread(backgrounds.discover_wallpapers)}


@app.get("/api/wallpaper-engine/preview")
async def api_wallpaper_engine_preview(path: str = Query(..., max_length=1000)):
    target = Path(path)
    allowed = any(root.resolve() in target.resolve().parents for root in backgrounds.steam_libraries())
    if not allowed or target.suffix.lower() not in (".gif", ".jpg", ".jpeg", ".png", ".webp") or not target.is_file():
        raise HTTPException(404, "Nincs előnézet.")
    return FileResponse(target, headers={"Cache-Control": "max-age=3600"})


@app.post("/api/wallpaper-engine/import")
async def api_wallpaper_engine_import(request: Request):
    path = str((await request.json()).get("path") or "")
    target = Path(path)
    if not any(root.resolve() in target.resolve().parents for root in backgrounds.steam_libraries()):
        raise HTTPException(400, "Csak a Steam-könyvtárban lévő hátterek importálhatók innen.")
    try:
        return _public_theme(await asyncio.to_thread(_backgrounds.add_wallpaper_engine, path))
    except (OSError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc


@app.get("/api/theme-video/{scene}/status")
async def api_theme_video_status(scene: str, prepare: bool = False):
    if scene not in theme_media.DEFAULT_PROJECTS:
        raise HTTPException(404, "Ismeretlen téma.")
    return await asyncio.to_thread(_bundled_themes.ensure if prepare else _bundled_themes.status, scene)


@app.get("/api/theme-video/{scene}/preview")
async def api_theme_preview(scene: str):
    path = await asyncio.to_thread(_bundled_themes.preview, scene) if scene in theme_media.DEFAULT_PROJECTS else None
    if not path:
        raise HTTPException(404, "A téma előnézete nem található.")
    return FileResponse(path, headers={"Cache-Control": "no-store"})


# ----------------------------------------------------------------------------
# MCP: az AI-asszisztensek eszközei (tömör, kevés tokenes kimenet)
# ----------------------------------------------------------------------------

def _size(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f}{unit}" if unit in ("B", "KB") else f"{n:.1f}{unit}"
        n /= 1024
    return ""


def _clean(value) -> str:
    return str(value or "").replace("|", "/").replace("\n", " ").strip()


async def _mcp_search(args: dict) -> str:
    page = args.get("page") or None
    if args.get("channel"):
        data = await youtube_channel(str(args["channel"]), "shorts" if args.get("type") == "short" else "videos", page)
        items, head = data["items"], ""
        if data.get("channel"):
            c = data["channel"]
            head = f"channel {_clean(c['title'])} {c.get('handle', '')} {' '.join(c.get('stats', []))}\n"
    else:
        query = str(args.get("q") or "").strip()
        if not query and not page:
            raise ValueError("q or channel is required")
        data = await youtube_search(query, page, args.get("type") == "channel")
        kind = args.get("type")
        if kind == "channel":
            lines = [f"{c['id']}|{_clean(c['title'])}|{c.get('handle', '')}|{_clean(c.get('subs'))}"
                     for c in data["channels"]]
            return "\n".join(lines) or "no channels"
        items = data["shorts"] if kind == "short" else data["videos"] + ([] if kind else data["shorts"])
        head = ""
    lines = [f"{x['url']}|{_clean(x['title'])}|{_clean(x.get('uploader'))}|{x.get('length', '')}|{_clean(x.get('views'))}"
             for x in items]
    if data.get("next"):
        lines.append(f"page={data['next']}")
    return head + ("\n".join(lines) or "no results")


async def _mcp_info(args: dict) -> str:
    url = str(args.get("url") or "")
    validate_source_url(url)
    info = await get_info(url, "auto" if is_valid_instagram_url(url) else None)
    heights = sorted({f["height"] for f in info.get("formats", []) if f.get("height") and _has_codec(f, "v")},
                     reverse=True)
    subs = _subtitle_listing(info)
    parts = [f"title: {_clean(info.get('title'))}", f"channel: {_clean(info.get('uploader') or info.get('channel'))}",
             f"duration: {int(info.get('duration') or 0)}s", f"heights: {','.join(map(str, heights)) or '-'}"]
    tracks = _audio_tracks(info)
    if tracks:
        parts.append("audio: " + ",".join(t["lang"] + ("*" if t["original"] else "") for t in tracks))
    if subs["subtitles"]:
        parts.append("subs: " + ",".join(s["lang"] for s in subs["subtitles"]))
    if subs["captionsOrig"]:
        parts.append(f"auto subs: {subs['captionsOrig']} (+translations)")
    return "\n".join(parts)


async def _mcp_wait(job_id: str, timeout: float = 1800) -> str:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = _jobs.get(job_id)
        if not job:
            return f"job {job_id} gone"
        if job["status"] in ("done", "error", "canceled"):
            return _job_line(job_id, job)
        await asyncio.sleep(0.5)
    return f"job {job_id} still running; check jobs"


def _job_line(job_id: str, job: dict) -> str:
    meta = job.get("meta") or {}
    status = job["status"] if job["status"] != "running" else f"running {job['progress']:.0f}%"
    extra = f"|lib={job['library_id']}|{job.get('saved_path')}" if job.get("library_id") else ""
    error = f"|{job['error']}" if job.get("error") else ""
    return f"{job_id}|{job.get('kind', 'download')}|{status}|{_clean(meta.get('title'))}{extra}{error}"


async def _mcp_download(args: dict) -> str:
    quality = args.get("quality")
    sub = str(args.get("subs") or "")
    info = None
    subs_auto = False
    if sub:
        info = await get_info(str(args["url"]))
        listing = _subtitle_listing(info)
        subs_auto = sub not in {s["lang"] for s in listing["subtitles"]}
    result = await start_download(
        str(args["url"]), str(args.get("format") or "mp4"), str(int(quality)) if quality else "",
        float(args.get("start") or 0), float(args.get("end") or 0), audio_lang=str(args.get("audio_lang") or ""),
        subs=sub, subs_auto=subs_auto, subs_mode=str(args.get("subs_mode") or "embed"), auto_save=True,
        origin="ai")
    if args.get("wait"):
        return await _mcp_wait(result["job_id"])
    return f"started job {result['job_id']} ({result['filename']}); poll with jobs"


async def _mcp_jobs(_args: dict) -> str:
    lines = [_job_line(jid, job) for jid, job in sorted(_jobs.items(), key=lambda kv: -kv[1].get("created", 0))[:20]]
    return "\n".join(lines) or "no jobs"


async def _mcp_cancel(args: dict) -> str:
    await api_cancel(str(args["id"]))
    return "canceling"


async def _mcp_library(args: dict) -> str:
    query = str(args.get("q") or "").casefold()
    limit = max(1, min(200, int(args.get("limit") or 25)))
    items = [x for x in await asyncio.to_thread(_library.items) if not query or query in x["title"].casefold()]
    lines = [f"{x['id']}|{_clean(x['title'])}|{x['format']}|{_size(x.get('size') or 0)}|"
             f"{_fmt_clock(x.get('duration') or 0)}|{x['path']}" for x in items[:limit]]
    more = f"\n(+{len(items) - limit} more)" if len(items) > limit else ""
    return ("\n".join(lines) or "library empty") + more


async def _mcp_edit(args: dict) -> str:
    result = start_edit(str(args["id"]), float(args.get("start") or 0), float(args.get("end") or 0),
                        int(args.get("height") or 0), str(args.get("format") or ""), bool(args.get("replace")),
                        origin="ai")
    if args.get("wait"):
        return await _mcp_wait(result["job_id"])
    return f"started job {result['job_id']}"


async def _mcp_delete(args: dict) -> str:
    ids = [str(x) for x in args.get("ids") or []]
    removed = await asyncio.to_thread(_library.remove, ids)
    return f"moved to Recycle Bin: {len(removed)}/{len(ids)}"


async def _mcp_open(args: dict) -> str:
    item = _library_item(str(args["id"]))
    (media_library.reveal if args.get("how") == "folder" else media_library.open_file)(item["path"])
    return "opened"


async def _mcp_describe(tool: str, args: dict) -> str:
    """Human-readable line for the approval dialog."""
    if tool == "download":
        cut = f", {args.get('start', 0)}–{args.get('end') or 'vége'} mp" if args.get("start") or args.get("end") else ""
        quality = f" {int(args['quality'])}{'k' if args.get('format') == 'mp3' else 'p'}" if args.get("quality") else ""
        title = ""
        try:
            info = await asyncio.wait_for(get_info(str(args.get("url"))), 20)
            title = f"„{info.get('title')}” "
        except Exception:  # noqa: BLE001
            pass
        return f"Letöltés: {title}{args.get('url')} → {str(args.get('format') or 'mp4').upper()}{quality}{cut}"
    if tool in ("delete", "edit", "open"):
        ids = args.get("ids") or [args.get("id")]
        names = [(_library.get(str(i)) or {}).get("title") or str(i) for i in ids]
        label = {"delete": "Törlés (Lomtárba)", "edit": "Szerkesztés", "open": "Megnyitás"}[tool]
        detail = ""
        if tool == "edit":
            detail = " · " + ", ".join(f"{k}={args[k]}" for k in ("start", "end", "height", "format", "replace")
                                        if args.get(k) not in (None, "", 0, False))
        return f"{label}: " + ", ".join(names[:6]) + (f" és még {len(names) - 6}" if len(names) > 6 else "") + detail
    return tool


_mcp_router, _approvals = mcp_server.create_router(
    {"search": _mcp_search, "info": _mcp_info, "download": _mcp_download, "jobs": _mcp_jobs,
     "cancel": _mcp_cancel, "library": _mcp_library, "edit": _mcp_edit, "delete": _mcp_delete,
     "open": _mcp_open},
    _mcp_describe, lambda: _app_settings()["mcp_mode"], _mcp_token, APP_VERSION,
    blocked=lambda: _app_settings()["mcp_blocked"])
app.include_router(_mcp_router)
_mcp_sessions = _mcp_router.sessions


@app.get("/api/mcp/sessions")
async def api_mcp_sessions():
    settings = _app_settings()
    return {"sessions": _mcp_sessions.listing(), "mode": settings["mcp_mode"], "blocked": settings["mcp_blocked"],
            "log": _approvals.log[:30], "names": mcp_server.AI_NAMES}


@app.post("/api/mcp/sessions/{session_id}/disconnect")
async def api_mcp_disconnect(session_id: str):
    return {"ok": _mcp_sessions.revoke(session_id)}


def _write_server_file(url: str | None = None) -> None:
    try:
        if url is None:
            url = json.loads(SERVER_FILE.read_text(encoding="utf-8"))["url"]
        SERVER_FILE.write_text(json.dumps({"url": url, "token": _mcp_token(), "pid": os.getpid()}), encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        _log(f"server file write failed: {exc}")


@app.get("/api/version")
async def api_version():
    return {"version": APP_VERSION}


class NoCacheStaticFiles(StaticFiles):
    """StaticFiles, ami megtiltja a böngésző cache-elését — így a frissítések
    azonnal látszanak, nem ragad be régi HTML/CSS/JS."""

    def is_not_modified(self, *args, **kwargs) -> bool:
        return False  # soha ne válaszoljunk 304-gyel

    async def get_response(self, path, scope):
        resp = await super().get_response(path, scope)
        resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
        return resp


app.mount("/", NoCacheStaticFiles(directory=str(STATIC_DIR), html=True), name="static")


# ----------------------------------------------------------------------------
# Indítás: szerver háttérszálon + natív ablak (pywebview / WebView2)
# ----------------------------------------------------------------------------

def _log(msg: str) -> None:
    try:
        import time
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n")
    except Exception:
        pass


def _message_box(title: str, message: str, flags: int) -> int:
    if os.name != "nt":
        return 0
    try:
        import ctypes
        return ctypes.windll.user32.MessageBoxW(None, message, title, flags)
    except Exception as e:  # noqa: BLE001
        _log(f"message box error: {e}")
        return 0


def _ask_yes_no(title: str, message: str) -> bool:
    # MB_YESNO | MB_ICONQUESTION | MB_SETFOREGROUND | MB_TOPMOST
    return _message_box(title, message, 0x00000004 | 0x00000020 | 0x00010000 | 0x00040000) == 6


def _show_error(title: str, message: str) -> None:
    # MB_OK | MB_ICONERROR | MB_SETFOREGROUND | MB_TOPMOST
    _message_box(title, message, 0x00000000 | 0x00000010 | 0x00010000 | 0x00040000)


def _load_settings() -> dict:
    try:
        if SETTINGS_FILE.exists():
            with open(SETTINGS_FILE, "r", encoding="utf-8-sig") as f:
                settings = json.load(f)
                return settings if isinstance(settings, dict) else {}
    except Exception as e:  # noqa: BLE001
        _log(f"settings load error: {e}")
    return {}


def _save_settings(settings: dict) -> None:
    try:
        USER_DATA_DIR.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=USER_DATA_DIR, delete=False) as f:
            json.dump(settings, f, ensure_ascii=False, indent=2)
        temporary = Path(f.name)
        try:
            temporary.replace(SETTINGS_FILE)
        finally:
            temporary.unlink(missing_ok=True)
    except Exception as e:  # noqa: BLE001
        _log(f"settings save error: {e}")


def _ffmpeg_exists() -> bool:
    exe_name = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    return bool(shutil.which("ffmpeg")) or any((d / exe_name).exists() for d in (APP_DIR / "bin", BASE_DIR / "bin"))


def _needs_first_run_setup() -> bool:
    if os.name != "nt" or not getattr(sys, "frozen", False):
        return False
    settings = _load_settings()
    return (
        not settings.get("setup_v3_completed")
        or not _ffmpeg_exists()
    )


def _create_desktop_shortcut() -> bool:
    if os.name != "nt" or not getattr(sys, "frozen", False):
        return False

    script = r"""
$ErrorActionPreference = 'Stop'
$desktop = [Environment]::GetFolderPath('DesktopDirectory')
$shortcutPath = Join-Path $desktop 'Downloader.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $env:DOWNLOADER_TARGET
$shortcut.WorkingDirectory = $env:DOWNLOADER_WORKDIR
$shortcut.IconLocation = $env:DOWNLOADER_ICON
$shortcut.Save()
"""
    env = os.environ.copy()
    env["DOWNLOADER_TARGET"] = str(sys.executable)
    env["DOWNLOADER_WORKDIR"] = str(APP_DIR)
    env["DOWNLOADER_ICON"] = f"{sys.executable},0"
    try:
        startupinfo = None
        creationflags = 0
        if os.name == "nt":
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startupinfo.wShowWindow = 0
            creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        result = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
            env=env,
            capture_output=True,
            text=True,
            timeout=20,
            startupinfo=startupinfo,
            creationflags=creationflags,
        )
        if result.returncode != 0:
            _log(f"shortcut error: {result.stderr.strip() or result.stdout.strip()}")
            return False
        return True
    except Exception as e:  # noqa: BLE001
        _log(f"shortcut exception: {e}")
        return False


def _setup_icon_uri() -> str:
    icon = STATIC_DIR / "icon.png"
    if icon.exists():
        try:
            data = base64.b64encode(icon.read_bytes()).decode("ascii")
            return f"data:image/png;base64,{data}"
        except Exception as e:  # noqa: BLE001
            _log(f"setup icon load error: {e}")
            return ""
    return ""


def _setup_html() -> str:
    icon_uri = _setup_icon_uri()
    icon_html = f'<img class="brand-mark" src="{icon_uri}" alt="">' if icon_uri else (
        '<div class="brand-mark">D</div>'
    )
    return f"""<!doctype html>
<html lang="hu">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Downloader</title>
  <style>
    :root {{
      --bg: #0b0d12;
      --panel: #151821;
      --panel-2: #1b1f2a;
      --line: rgba(255,255,255,0.11);
      --text: #f8fafc;
      --muted: #9aa4b2;
      --accent: #21c7a8;
      --accent-2: #4f8cff;
      --danger: #f43f5e;
      --ease: cubic-bezier(.2,.8,.2,1);
    }}
    * {{ box-sizing: border-box; }}
    html, body {{ height: 100%; }}
    body {{
      margin: 0;
      font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--text);
      background: var(--bg);
      display: flex;
      overflow: hidden;
    }}
    .shell {{
      width: 100%;
      height: 100%;
      background: color-mix(in srgb, var(--panel) 92%, transparent);
      border: 1px solid var(--line);
      padding: 24px;
      display: flex;
      flex-direction: column;
      justify-content: center;
    }}
    .brand {{ display: flex; align-items: center; gap: 12px; margin-bottom: 24px; }}
    .brand-mark {{
      width: 44px; height: 44px; border-radius: 12px; object-fit: cover;
      display: grid; place-items: center; font-weight: 800;
      background: linear-gradient(135deg, var(--accent), var(--accent-2));
      overflow: hidden;
      flex: 0 0 auto;
    }}
    .brand-name {{ font-weight: 800; font-size: 1.22rem; }}
    .eyebrow {{ color: var(--accent); font-size: .76rem; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 8px; }}
    h1 {{ margin: 0; font-size: 1.68rem; line-height: 1.15; letter-spacing: 0; }}
    p {{ margin: 12px 0 0; color: var(--muted); line-height: 1.55; font-size: .96rem; }}
    .actions {{ display: flex; gap: 10px; margin-top: 24px; }}
    button {{
      border: 1px solid var(--line); border-radius: 10px; padding: 11px 15px;
      font: inherit; font-weight: 750; cursor: pointer; color: var(--text);
      background: var(--panel-2); min-height: 44px;
      transition: transform .08s, border-color .16s, background .16s;
    }}
    button:hover {{ border-color: color-mix(in srgb, var(--accent) 65%, var(--line)); }}
    button:active {{ transform: translateY(1px); }}
    .primary {{ border: none; background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: #fff; flex: 1.1; }}
    .secondary {{ flex: .9; }}
    button:disabled {{ opacity: .62; cursor: progress; }}
    .progress-wrap {{ margin-top: 24px; }}
    .track {{ height: 10px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel-2); overflow: hidden; }}
    .fill {{
      width: 0%; height: 100%; border-radius: inherit;
      background: linear-gradient(90deg, var(--accent), var(--accent-2));
      transition: width .24s var(--ease);
      position: relative;
      overflow: hidden;
    }}
    .fill::after {{
      content: ""; position: absolute; top: 0; bottom: 0; left: -45%; width: 45%;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,.28), transparent);
      animation: sheen 1.1s linear infinite;
    }}
    @keyframes sheen {{ from {{ left: -45%; }} to {{ left: 100%; }} }}
    .meta {{ display: flex; justify-content: space-between; gap: 16px; color: var(--muted); font-size: .82rem; margin-top: 9px; }}
    .pct {{ color: var(--text); font-weight: 800; font-variant-numeric: tabular-nums; }}
    .error {{ color: #fda4af; margin-top: 14px; font-size: .88rem; }}
    .hidden {{ display: none; }}
  </style>
</head>
<body>
  <header style="position:fixed;inset:0 0 auto;height:36px;display:flex;background:#1c1d1f;z-index:10;color:#a0a5a5;font:11px 'Segoe UI';border-bottom:1px solid #303335">
    <div class="pywebview-drag-region" style="flex:1;padding:10px 16px">Downloader / Első indítás</div>
    <button aria-label="Bezárás" onclick="window.pywebview.api.window_action('close')" style="width:42px;border:0;background:transparent;color:inherit;cursor:pointer">✕</button>
  </header>
  <main class="shell">
    <div class="brand">{icon_html}<div class="brand-name">Downloader</div></div>

    <section id="shortcutStep" class="hidden">
      <div class="eyebrow">Első indítás</div>
      <h1>Kerüljön parancsikon az Asztalra?</h1>
      <p>Így később közvetlenül indíthatod a Downloadert az EXE keresése nélkül.</p>
      <div class="actions">
        <button class="primary" id="yesBtn">Parancsikon létrehozása</button>
        <button class="secondary" id="noBtn">Most nem</button>
      </div>
    </section>

    <section id="installStep" class="hidden">
      <div class="eyebrow">Előkészítés</div>
      <h1>ffmpeg letöltése</h1>
      <p>Az első indításkor letöltjük a videó- és hangfeldolgozáshoz szükséges komponenst.</p>
      <div class="progress-wrap">
        <div class="track"><div id="fill" class="fill"></div></div>
        <div class="meta"><span id="status">Indítás</span><span id="pct" class="pct">0%</span></div>
      </div>
      <div id="error" class="error hidden"></div>
      <div id="retryWrap" class="actions hidden">
        <button class="primary" id="retryBtn">Újrapróbálás</button>
      </div>
    </section>
  </main>

  <script>
    const qs = (s) => document.querySelector(s);
    const shortcutStep = qs('#shortcutStep');
    const installStep = qs('#installStep');
    const yesBtn = qs('#yesBtn');
    const noBtn = qs('#noBtn');
    const retryBtn = qs('#retryBtn');
    const fill = qs('#fill');
    const pct = qs('#pct');
    const statusEl = qs('#status');
    const errorEl = qs('#error');
    const retryWrap = qs('#retryWrap');

    function show(el) {{
      shortcutStep.classList.add('hidden');
      installStep.classList.add('hidden');
      el.classList.remove('hidden');
    }}
    function setBusy(busy) {{
      yesBtn.disabled = busy;
      noBtn.disabled = busy;
      retryBtn.disabled = busy;
    }}
    function apiReady() {{
      if (window.pywebview && window.pywebview.api) return Promise.resolve();
      return new Promise(resolve => window.addEventListener('pywebviewready', resolve, {{ once: true }}));
    }}
    async function boot() {{
      await apiReady();
      const state = await window.pywebview.api.setup_state();
      if (state.askShortcut) show(shortcutStep);
      else startInstall();
    }}
    async function chooseShortcut(create) {{
      setBusy(true);
      await window.pywebview.api.choose_shortcut(create);
      startInstall();
    }}
    async function startInstall() {{
      setBusy(false);
      errorEl.classList.add('hidden');
      retryWrap.classList.add('hidden');
      show(installStep);
      window.setupProgress('Indítás', 0);
      await window.pywebview.api.start_first_run_install();
    }}
    window.setupProgress = (message, value) => {{
      statusEl.textContent = message || 'Folyamatban';
      if (typeof value === 'number') {{
        const safe = Math.max(0, Math.min(100, value));
        fill.style.width = safe + '%';
        pct.textContent = Math.round(safe) + '%';
      }} else {{
        pct.textContent = '';
      }}
    }};
    window.setupError = (message) => {{
      errorEl.textContent = message || 'Nem sikerült az előkészítés.';
      errorEl.classList.remove('hidden');
      retryWrap.classList.remove('hidden');
      setBusy(false);
    }};
    yesBtn.addEventListener('click', () => chooseShortcut(true));
    noBtn.addEventListener('click', () => chooseShortcut(false));
    retryBtn.addEventListener('click', startInstall);
    boot();
  </script>
</body>
</html>"""


def _run_server(server, listener: socket.socket) -> None:
    try:
        with listener:
            server.run(sockets=[listener])
    except (Exception, SystemExit):
        import traceback
        _log(f"Local server stopped: {traceback.format_exc()}")


def _wait_until_up(url: str, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    with httpx.Client(timeout=0.7, trust_env=False) as client:
        while time.monotonic() < deadline:
            try:
                response = client.get(url)
                if response.status_code == 200 and "text/html" in response.headers.get("content-type", ""):
                    _log(f"server ready: {url}")
                    return True
            except httpx.HTTPError:
                pass
            time.sleep(0.12)
    _log(f"server readiness timeout: {url}")
    return False


def _start_local_server(preferred: int) -> str | None:
    """Keep the port bound from selection through Uvicorn startup."""
    import uvicorn

    for candidate in dict.fromkeys((preferred, 0)):
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            if os.name == "nt":
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            listener.bind(("127.0.0.1", candidate))
            listener.listen(socket.SOMAXCONN)
        except OSError as exc:
            _log(f"Local port {candidate} could not be reserved: {exc}")
            listener.close()
            continue

        port = listener.getsockname()[1]
        url = f"http://127.0.0.1:{port}"
        _log(f"starting server on {url}")
        config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning",
                                access_log=False, loop="asyncio", http="h11", log_config=None)
        server = uvicorn.Server(config)
        threading.Thread(target=_run_server, args=(server, listener), daemon=True).start()
        if _wait_until_up(url, timeout=12.0 if candidate else 16.0):
            return url
        server.should_exit = True
    return None


def _app_icon_path(theme: str | None = None) -> str | None:
    if theme in _THEMES:
        themed = STATIC_DIR / "theme-icons" / f"{theme}.ico"
        if themed.is_file():
            return str(themed)
    for directory in (BASE_DIR, APP_DIR):
        icon = directory / "icon.ico"
        if icon.is_file():
            return str(icon)
    return None

def _open_main_app_in_window(window) -> bool:
    url = _start_local_server(int(os.environ.get("PORT", "7860")))
    if not url:
        return False
    _write_server_file(url)
    try:
        if hasattr(window, "resize"):
            window.resize(1180, 820)
        if hasattr(window, "load_url"):
            window.load_url(url)
        else:
            window.evaluate_js(f"window.location.href = {json.dumps(url)}")
        return True
    except Exception as e:  # noqa: BLE001
        _log(f"main window navigation error: {e}")
        return False


class _NativeApi:
    """A frontend a pywebview hídon (`window.pywebview.api.*`) hívja ezeket.

    A natív "Mentés másként" párbeszéddel mentjük a kész fájlt — így a felhasználó
    látja és megválasztja, hova kerül (nincs néma, ismeretlen helyre mentés)."""

    def __init__(self):
        self._window = None
        self._installing = False
        self._theme_lock = threading.Lock()
        self._theme_icon = None

    def set_window(self, w, native_frame: bool = False):
        self._window = w
        self._maximized = False
        self._frame = None
        self._native_frame = native_frame
        w.events.shown += self._on_shown

    def _on_shown(self, *args):
        if os.name != "nt" or not self._window:
            return
        try:
            import ctypes
            handle = int(self._window.native.Handle.ToInt64())
            preference = ctypes.c_int(2)  # DWMWCP_ROUND: Windows 11 rounded corners and shadow
            ctypes.windll.dwmapi.DwmSetWindowAttribute(
                ctypes.c_void_p(handle), 33, ctypes.byref(preference), 4)
            if self._native_frame:
                from System import Action
                import native_window

                def install():
                    self._frame = native_window.NativeFrame(handle)
                self._window.native.Invoke(Action(install))
        except Exception as exc:
            _log(f"Native window styling unavailable: {exc}")

    def clipboard_text(self) -> str:
        if os.name != "nt" or not self._window:
            return ""
        from System import Func, String
        from System.Windows.Forms import Clipboard
        return str(self._window.native.Invoke(Func[String](lambda: Clipboard.GetText())))

    def _on_ui(self, func):
        from System import Action
        self._window.native.Invoke(Action(func))

    def begin_drag(self, kind: str = "caption"):
        """Hand the pressed mouse to Windows: native move (Aero Snap) or edge resize."""
        if self._frame and isinstance(kind, str):
            self._on_ui(lambda: self._frame.begin(kind))

    def window_action(self, action: str):
        if not self._window:
            return
        if action == "minimize":
            if self._frame:
                self._on_ui(self._frame.minimize)
            else:
                self._window.minimize()
        elif action == "maximize":
            if self._frame:
                self._on_ui(self._frame.toggle_maximize)
            elif self._maximized:
                self._maximized = False
                self._window.restore()
            else:
                self._maximized = True
                self._window.maximize()
        elif action == "close":
            self._window.destroy()
        return self.window_state()

    def window_state(self) -> dict:
        return {"maximized": self._frame.maximized if self._frame else self._maximized,
                "native": bool(self._frame)}

    def resize_window(self, width: int, height: int):
        if self._window and not self._maximized:
            self._window.resize(max(900, min(3840, int(width))), max(640, min(2160, int(height))))

    def open_url(self, url: str) -> bool:
        """Open YouTube pages (subscribe, channel) in the user's browser."""
        if not isinstance(url, str) or not re.match(r"https://(www\.)?youtube\.com/", url):
            return False
        import webbrowser
        return webbrowser.open(url)

    def flash_window(self) -> None:
        """Flash the taskbar button when an AI approval waits in the background."""
        if os.name != "nt" or not self._window:
            return
        try:
            import ctypes
            ctypes.windll.user32.FlashWindow(ctypes.c_void_p(int(self._window.native.Handle.ToInt64())), True)
        except Exception:  # noqa: BLE001
            pass

    def pick_folder(self) -> str:
        import webview
        dialog = getattr(webview, "FileDialog", None)
        result = self._window.create_file_dialog(dialog.FOLDER if dialog else webview.FOLDER_DIALOG,
                                                 directory=_app_settings()["download_dir"])
        if not result:
            return ""
        folder = result if isinstance(result, str) else result[0]
        _update_settings({"download_dir": folder})
        return folder

    def pick_background(self, project: bool = False) -> dict:
        """Add a custom theme using the Windows file picker."""
        if project:
            file_types = ("Wallpaper Engine projekt (*.json)",)
        else:
            file_types = tuple(
                f"{name} ({';'.join('*' + extension for extension in sorted(extensions))})"
                for name, extensions in (("Képek és videók", backgrounds.IMAGE | backgrounds.VIDEO),
                                         ("Képek", backgrounds.IMAGE), ("Videók", backgrounds.VIDEO))
            )
        try:
            result = self._window.create_file_dialog(self._open_dialog_type(), file_types=file_types)
            if not result:
                return {"ok": False}
            path = result if isinstance(result, str) else result[0]
            if project:
                if Path(path).name.lower() != "project.json":
                    raise ValueError("Válaszd ki a háttér project.json fájlját.")
                theme = _backgrounds.add_wallpaper_engine(path)
            else:
                theme = _backgrounds.add_file(path)
            return {"ok": True, "theme": _public_theme(theme)}
        except (OSError, ValueError) as exc:
            return {"ok": False, "error": str(exc)}

    def setup_state(self) -> dict:
        settings = _load_settings()
        answered = settings.get(_SHORTCUT_ANSWERED_KEY) or any(
            value for key, value in settings.items() if key.startswith("shortcut_answered_"))
        created = settings.get(_SHORTCUT_CREATED_KEY, any(
            value for key, value in settings.items() if key.startswith("shortcut_created_")))
        return {
            "askShortcut": not answered,
            "hasFfmpeg": _ffmpeg_exists(),
            "shortcutCreated": bool(created),
        }

    def theme(self) -> str | None:
        theme = _load_settings().get("theme")
        theme = "minecraft" if theme == "deepsea" else theme
        return theme if _valid_theme(theme) else None

    def set_theme(self, theme: str) -> None:
        if _valid_theme(theme):
            with self._theme_lock:
                settings = _load_settings()
                settings["theme"] = theme
                _save_settings(settings)

    def set_theme_icon(self, theme: str) -> None:
        if os.name != "nt" or not self._window or not isinstance(theme, str) or theme not in _THEMES:
            return
        icon_path = _app_icon_path(_ICON_THEME.get(theme, theme))
        if not icon_path:
            return
        from System import Action
        from System.Drawing import Icon
        form = self._window.native

        def apply_icon():
            icon = Icon(icon_path)
            previous = self._theme_icon
            form.Icon = icon
            self._theme_icon = icon
            if previous:
                previous.Dispose()

        form.Invoke(Action(apply_icon))

    def update_status(self) -> dict:
        return _updater.status()

    def check_update(self) -> dict:
        _updater.check()
        return _updater.status()

    def start_update(self) -> dict:
        _updater.start()
        return _updater.status()

    def save_update_token(self, value: str) -> bool:
        return _updater.save_token(value)

    def finish_update(self) -> dict:
        with _job_admission:
            if not any(job["status"] in {"running", "starting", "canceling"}
                       or (job["status"] == "done" and not job.get("saved_path"))
                       for job in _jobs.copy().values()):
                _updater.finish(self._window.destroy)
        return _updater.status()

    def choose_shortcut(self, create: bool) -> dict:
        settings = _load_settings()
        settings[_SHORTCUT_ANSWERED_KEY] = True
        settings[_SHORTCUT_CREATED_KEY] = False
        if create:
            settings[_SHORTCUT_CREATED_KEY] = _create_desktop_shortcut()
        _save_settings(settings)
        return {
            "ok": True,
            "created": bool(settings[_SHORTCUT_CREATED_KEY]),
        }

    def start_first_run_install(self) -> dict:
        if self._installing:
            return {"ok": True, "running": True}
        self._installing = True
        threading.Thread(target=self._first_run_install_worker, daemon=True).start()
        return {"ok": True, "running": True}

    def _first_run_install_worker(self) -> None:
        try:
            if not _ffmpeg_exists():
                from ffmpeg_setup import ensure_ffmpeg
                exe = ensure_ffmpeg(APP_DIR / "bin", progress=self._setup_progress)
                if not exe or not _ffmpeg_exists():
                    self._setup_error(f"Nem sikerult letolteni az ffmpeg-et.\nNaplo: {LOG_FILE}")
                    return
            else:
                self._setup_progress("ffmpeg mar keszen all", 100)

            settings = _load_settings()
            settings["setup_v3_completed"] = True
            _save_settings(settings)

            self._setup_progress("Alkalmazas inditasa", 100)
            import time
            time.sleep(0.45)
            if not _open_main_app_in_window(self._window):
                self._setup_error(f"Nem sikerult elinditani a helyi szervert.\nNaplo: {LOG_FILE}")
        except Exception as e:  # noqa: BLE001
            import traceback
            _log(f"setup install crashed: {e}\n{traceback.format_exc()}")
            self._setup_error(f"Nem sikerult az elso inditas elokeszitese.\nNaplo: {LOG_FILE}")
        finally:
            self._installing = False

    def _setup_progress(self, message: str, pct: int | None = None) -> None:
        if not self._window:
            return
        try:
            self._window.evaluate_js(
                f"window.setupProgress({json.dumps(message)}, {json.dumps(pct)})"
            )
        except Exception as e:  # noqa: BLE001
            _log(f"setup progress js error: {e}")

    def _setup_error(self, message: str) -> None:
        if not self._window:
            return
        try:
            self._window.evaluate_js(f"window.setupError({json.dumps(message)})")
        except Exception as e:  # noqa: BLE001
            _log(f"setup error js error: {e}")

    @staticmethod
    def _save_dialog_type():
        import webview
        # pywebview 6.x: FileDialog.SAVE; régebbi: SAVE_DIALOG
        fd = getattr(webview, "FileDialog", None)
        return fd.SAVE if fd else webview.SAVE_DIALOG

    @staticmethod
    def _open_dialog_type():
        import webview
        fd = getattr(webview, "FileDialog", None)
        return fd.OPEN if fd else webview.OPEN_DIALOG

    def save_file(self, job_id: str) -> dict:
        """A kész job fájljának mentése a felhasználó által választott helyre."""
        job = _jobs.get(job_id)
        if not job or job.get("status") != "done" or not job.get("path"):
            return {"ok": False, "error": "A fájl még nem áll készen."}
        src = job["path"]
        suggested = job["filename"]
        try:
            result = self._window.create_file_dialog(
                self._save_dialog_type(), save_filename=suggested
            )
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": f"Mentési párbeszéd hiba: {e}"}
        if not result:
            return {"ok": False, "canceled": True}
        dest = result if isinstance(result, str) else result[0]
        # FONTOS: a felhasználó a mentés-párbeszédben elhagyhatja/elronthatja a kiterjesztést,
        # ekkor a Windows nem tudja megnyitni. Mindig a tényleges kiterjesztést tesszük rá.
        ext = (job.get("ext") or "").lstrip(".").lower()
        if ext and not dest.lower().endswith("." + ext):
            dest = dest + "." + ext
        try:
            shutil.copyfile(src, dest)
            for extra in job.get("extra_files") or []:
                extra_path = Path(extra)
                if extra_path.exists():
                    shutil.copyfile(extra_path, Path(dest).with_suffix("".join(extra_path.suffixes[-2:])))
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": f"Mentés sikertelen: {e}"}
        try:
            _library.add(dest, job.get("meta") or {}, _ensure_ffmpeg_on_path(), _thumbnail_bytes(job))
        except Exception as exc:  # noqa: BLE001 - the file is saved even if the gallery entry fails
            _log(f"Library add failed: {exc}")
        # sikeres mentés után takarítunk
        shutil.rmtree(job["dir"], ignore_errors=True)
        _jobs.pop(job_id, None)
        return {"ok": True, "path": dest}


def _start_webview(webview):
    webview.start(gui="edgechromium", icon=_app_icon_path(), private_mode=False,
                  storage_path=str(USER_DATA_DIR / "WebView"))


def main():
    if _needs_first_run_setup():
        try:
            import webview
            native = _NativeApi()
            window = webview.create_window(
                "Downloader",
                html=_setup_html(),
                width=520,
                height=390,
                min_size=(520, 390),
                frameless=True,
                easy_drag=False,
                shadow=True,
                background_color="#0b0d12",
                js_api=native,
            )
            native.set_window(window, native_frame=True)
            _start_webview(webview)
            return
        except Exception as e:  # noqa: BLE001
            _log(f"setup window failed: {e}")
            _show_error("Downloader", f"Nem sikerult elinditani a setup ablakot.\n\nNaplo: {LOG_FILE}")
            return

    url = _start_local_server(int(os.environ.get("PORT", "7860")))
    if not url:
        _show_error(
            "Downloader",
            f"Nem sikerult elinditani a helyi szervert.\n\nNaplo: {LOG_FILE}",
        )
        return

    _write_server_file(url)
    print("=" * 52)
    print("  Downloader — YouTube + Instagram letöltő")
    print("=" * 52)
    print(f"\n  Fut itt: {url}")

    # --- Natív, önálló ablak (nem böngésző) ---
    try:
        import webview
        native = _NativeApi()
        window = webview.create_window(
            "Downloader",
            url,
            width=1180,
            height=820,
            min_size=(900, 640),
            background_color="#0e0d16",
            frameless=True,
            easy_drag=False,
            shadow=True,
            js_api=native,
        )
        native.set_window(window, native_frame=True)
        _start_webview(webview)
    except Exception as e:  # noqa: BLE001
        # ha valamiért nincs natív motor, essünk vissza böngészőre, hogy ne haljon meg az app
        print("  (natív ablak nem indult, böngésző tartalék):", e, flush=True)
        import webbrowser
        webbrowser.open(url)
        try:
            import time
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    if "--verify-package" in sys.argv[1:]:
        with YoutubeDL(_base_opts()) as downloader:
            if (not downloader._impersonate_target_available(ImpersonateTarget())
                    or "node" not in downloader.params["js_runtimes"]
                    or not (STATIC_DIR / "settings.js").is_file()):
                raise SystemExit(1)
        with tempfile.TemporaryDirectory() as cache:
            themes = theme_media.BundledThemes(Path(cache), BASE_DIR / "wallpapers", _log)
            for scene in theme_media.DEFAULT_PROJECTS:
                status = themes.ensure(scene)
                if status["state"] != "ready" or not themes.asset(scene, status["file"]) or not themes.preview(scene):
                    raise SystemExit(1)
        if not _start_local_server(0):
            raise SystemExit(1)
    else:
        main()
