"""Fast YouTube search and channel pages through the public InnerTube web API.

One HTTP request per page instead of a full yt-dlp extraction. Results look like
the YouTube website: videos with channel avatars, a Shorts shelf, channel rows and
a continuation token for infinite scrolling. Callers fall back to yt-dlp on errors.
"""
from __future__ import annotations

import re
import urllib.parse

import httpx

_API = "https://www.youtube.com/youtubei/v1/"
_TAB_PARAMS = {
    "videos": "EgZ2aWRlb3PyBgQKAjoA",
    "shorts": "EgZzaG9ydHPyBgUKA5oBAA%3D%3D",
    "streams": "EgdzdHJlYW1z8gYECgJ6AA%3D%3D",
}
_client: httpx.AsyncClient | None = None


def _client_version() -> str:
    try:  # follow yt-dlp updates so the web client version stays current
        from yt_dlp.extractor.youtube._base import INNERTUBE_CLIENTS
        return INNERTUBE_CLIENTS["web"]["INNERTUBE_CONTEXT"]["client"]["clientVersion"]
    except Exception:  # noqa: BLE001
        return "2.20251120.01.00"


_CONTEXT = {"client": {"clientName": "WEB", "clientVersion": _client_version(), "hl": "hu", "gl": "HU"}}


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(12.0, connect=6.0), http2=False,
            limits=httpx.Limits(max_connections=12, max_keepalive_connections=6),
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                                   "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                     "Origin": "https://www.youtube.com", "Accept-Language": "hu-HU,hu;q=0.9"})
    return _client


async def _post(endpoint: str, body: dict) -> dict:
    response = await _http().post(_API + endpoint + "?prettyPrint=false", json={"context": _CONTEXT, **body})
    response.raise_for_status()
    return response.json()


# --- small helpers ---------------------------------------------------------

def _text(node) -> str:
    if not node:
        return ""
    if isinstance(node, str):
        return node
    if "simpleText" in node:
        return node["simpleText"]
    if "content" in node:
        return node["content"]
    return "".join(run.get("text", "") for run in node.get("runs", []))


def _https(url: str) -> str:
    return "https:" + url if url.startswith("//") else url


def _best(sources) -> str:
    sources = [s for s in sources or [] if s.get("url")]
    return _https(max(sources, key=lambda s: s.get("width") or 0)["url"]) if sources else ""


def _seconds(value: str) -> int:
    if not value or not re.fullmatch(r"[\d:]+", value):
        return 0
    total = 0
    for part in value.split(":"):
        total = total * 60 + int(part)
    return total


def _walk(node, visit):
    """Depth-first walk; `visit(key, value)` returns True to stop descending."""
    stack = [node]
    while stack:
        current = stack.pop()
        if isinstance(current, dict):
            for key, value in reversed(list(current.items())):
                if not visit(key, value):
                    stack.append(value)
        elif isinstance(current, list):
            stack.extend(reversed(current))


def _verified(badges) -> bool:
    return any("VERIFIED" in (b.get("metadataBadgeRenderer", {}).get("style") or "") for b in badges or [])


# --- renderer parsers --------------------------------------------------------

def _video(r: dict) -> dict | None:
    vid = r.get("videoId")
    if not vid:
        return None
    owner = (r.get("ownerText") or r.get("longBylineText") or {}).get("runs") or [{}]
    browse = owner[0].get("navigationEndpoint", {}).get("browseEndpoint", {})
    avatar = r.get("channelThumbnailSupportedRenderers", {}).get("channelThumbnailWithLinkRenderer", {})
    length = _text(r.get("lengthText"))
    live = any("LIVE" in (b.get("metadataBadgeRenderer", {}).get("style") or "") for b in r.get("badges") or [])
    return {
        "kind": "video", "id": vid, "url": f"https://www.youtube.com/watch?v={vid}",
        "title": _text(r.get("title")), "thumbnail": _best(r.get("thumbnail", {}).get("thumbnails")),
        "length": length, "duration": _seconds(length), "live": live,
        "views": _text(r.get("shortViewCountText")) or _text(r.get("viewCountText")),
        "published": _text(r.get("publishedTimeText")),
        "uploader": owner[0].get("text", ""), "channelId": browse.get("browseId"),
        "channelUrl": browse.get("canonicalBaseUrl"),
        "avatar": _best(avatar.get("thumbnail", {}).get("thumbnails")),
        "verified": _verified(r.get("ownerBadges")),
    }


def _lockup(r: dict) -> dict | None:
    if r.get("contentType") != "LOCKUP_CONTENT_TYPE_VIDEO" or not r.get("contentId"):
        return None
    vid = r["contentId"]
    meta = r.get("metadata", {}).get("lockupMetadataViewModel", {})
    image = r.get("contentImage", {}).get("thumbnailViewModel", {})
    length = ""
    for overlay in image.get("overlays") or []:
        for badge in overlay.get("thumbnailBottomOverlayViewModel", {}).get("badges") or []:
            length = length or badge.get("thumbnailBadgeViewModel", {}).get("text", "")
    parts = [_text(p.get("text")) for row in meta.get("metadata", {}).get("contentMetadataViewModel", {})
             .get("metadataRows") or [] for p in row.get("metadataParts") or []]
    views = next((p for p in parts if "megtekint" in p or "néz" in p), "")
    published = next((p for p in parts if "ezelőtt" in p or "ago" in p), "")
    avatar = meta.get("image", {}).get("decoratedAvatarViewModel", {}).get("avatar", {}) \
        .get("avatarViewModel", {}).get("image", {}).get("sources")
    return {
        "kind": "video", "id": vid, "url": f"https://www.youtube.com/watch?v={vid}",
        "title": _text(meta.get("title")).strip("⠀ ") or "—",
        "thumbnail": _best(image.get("image", {}).get("sources")),
        "length": length, "duration": _seconds(length), "live": length.upper() in ("LIVE", "ÉLŐ"),
        "views": views, "published": published, "uploader": "", "channelId": None, "channelUrl": None,
        "avatar": _best(avatar), "verified": False,
    }


def _short(r: dict) -> dict | None:
    endpoint = r.get("onTap", {}).get("innertubeCommand", {}).get("reelWatchEndpoint", {})
    vid = endpoint.get("videoId") or (r.get("entityId") or "").removeprefix("shorts-shelf-item-")
    if not vid:
        return None
    overlay = r.get("overlayMetadata", {})
    thumb = _best(r.get("thumbnail", {}).get("sources")) or \
        _best(r.get("thumbnailViewModel", {}).get("thumbnailViewModel", {}).get("image", {}).get("sources")) or \
        f"https://i.ytimg.com/vi/{vid}/oar2.jpg"
    return {
        "kind": "short", "id": vid, "url": f"https://www.youtube.com/shorts/{vid}",
        "title": _text(overlay.get("primaryText")), "views": _text(overlay.get("secondaryText")),
        "thumbnail": thumb,
    }


def _reel_item(r: dict) -> dict | None:
    vid = r.get("videoId")
    if not vid:
        return None
    return {"kind": "short", "id": vid, "url": f"https://www.youtube.com/shorts/{vid}",
            "title": _text(r.get("headline")), "views": _text(r.get("viewCountText")),
            "thumbnail": _best(r.get("thumbnail", {}).get("thumbnails"))}


def _channel(r: dict) -> dict | None:
    cid = r.get("channelId")
    if not cid:
        return None
    handle = _text(r.get("subscriberCountText"))
    subs = _text(r.get("videoCountText"))
    if not handle.startswith("@"):  # older layout: subscriber count in subscriberCountText
        handle, subs = "", handle or subs
    return {"kind": "channel", "id": cid, "title": _text(r.get("title")),
            "thumbnail": _best(r.get("thumbnail", {}).get("thumbnails")), "handle": handle,
            "subs": subs, "verified": _verified(r.get("ownerBadges")),
            "description": _text(r.get("descriptionSnippet"))}


def _collect(data) -> dict:
    videos, shorts, channels, token = [], [], [], None
    seen = set()

    def add(target, item):
        if item and (item["kind"], item["id"]) not in seen:
            seen.add((item["kind"], item["id"]))
            target.append(item)

    def visit(key, value):
        nonlocal token
        if key == "videoRenderer":
            add(videos, _video(value)); return True
        if key == "lockupViewModel":
            add(videos, _lockup(value)); return True
        if key == "shortsLockupViewModel":
            add(shorts, _short(value)); return True
        if key == "reelItemRenderer":
            add(shorts, _reel_item(value)); return True
        if key == "channelRenderer":
            add(channels, _channel(value)); return True
        if key == "continuationCommand":
            token = token or value.get("token")
            return True
        if key in ("secondarySearchContainerRenderer", "universalWatchCardRenderer", "menu", "menuOnTap"):
            return True
        return False

    _walk(data, visit)
    return {"videos": videos, "shorts": shorts, "channels": channels, "next": token}


# --- public API ------------------------------------------------------------

async def search(query: str, continuation: str | None = None, channels_only: bool = False) -> dict:
    body = {"continuation": continuation} if continuation else {"query": query}
    if channels_only and not continuation:
        body["params"] = "EgIQAg=="
    data = await _post("search", body)
    root = data.get("onResponseReceivedCommands") if continuation else data.get("contents")
    return _collect(root or {})


async def resolve_channel(ref: str) -> str:
    """UC… id, @handle or channel URL → browse id."""
    ref = ref.strip()
    if re.fullmatch(r"UC[A-Za-z0-9_-]{22}", ref):
        return ref
    if ref.startswith("@"):
        ref = "https://www.youtube.com/" + urllib.parse.quote(ref, safe="@")
    match = re.search(r"/channel/(UC[A-Za-z0-9_-]{22})", ref)
    if match:
        return match[1]
    parsed = urllib.parse.urlsplit(ref)
    path = re.sub(r"/(featured|videos|shorts|streams|playlists|community|about)/?$", "", parsed.path)
    data = await _post("navigation/resolve_url", {"url": f"https://www.youtube.com{path}"})
    browse_id = data.get("endpoint", {}).get("browseEndpoint", {}).get("browseId", "")
    if not browse_id.startswith("UC"):
        raise ValueError("Unknown channel")
    return browse_id


def _channel_header(data: dict, browse_id: str) -> dict:
    header = data.get("header", {})
    view = header.get("pageHeaderRenderer", {}).get("content", {}).get("pageHeaderViewModel", {})
    meta = data.get("metadata", {}).get("channelMetadataRenderer", {})
    if view:
        rows = view.get("metadata", {}).get("contentMetadataViewModel", {}).get("metadataRows") or []
        parts = [_text(p.get("text")) for row in rows for p in row.get("metadataParts") or []]
        title_node = view.get("title", {}).get("dynamicTextViewModel", {}).get("text", {})
        verified = any("CHECK_CIRCLE" in str(run) for run in title_node.get("attachmentRuns") or [])
        avatar = view.get("image", {}).get("decoratedAvatarViewModel", {}).get("avatar", {}) \
            .get("avatarViewModel", {}).get("image", {}).get("sources")
        banner = view.get("banner", {}).get("imageBannerViewModel", {}).get("image", {}).get("sources")
        description = view.get("description", {}).get("descriptionPreviewViewModel", {}).get("description", {})
        handle = next((p for p in parts if p.startswith("@")), "")
        stats = [p for p in parts if p and not p.startswith("@")]
        return {"id": browse_id, "title": _text(title_node) or meta.get("title", ""), "verified": verified,
                "handle": handle, "stats": stats, "thumbnail": _best(avatar), "banner": _best(banner),
                "description": _text(description) or meta.get("description", "")}
    c4 = header.get("c4TabbedHeaderRenderer", {})
    return {"id": browse_id, "title": c4.get("title") or meta.get("title", ""),
            "verified": _verified(c4.get("badges")), "handle": _text(c4.get("channelHandleText")),
            "stats": [s for s in (_text(c4.get("subscriberCountText")), _text(c4.get("videosCountText"))) if s],
            "thumbnail": _best(c4.get("avatar", {}).get("thumbnails")),
            "banner": _best(c4.get("banner", {}).get("thumbnails")), "description": meta.get("description", "")}


async def channel(ref: str, tab: str = "videos", continuation: str | None = None) -> dict:
    if continuation:
        data = await _post("browse", {"continuation": continuation})
        page = _collect(data.get("onResponseReceivedActions") or {})
        return {"items": page["shorts"] if tab == "shorts" else page["videos"], "next": page["next"]}
    browse_id = await resolve_channel(ref)
    params = _TAB_PARAMS.get(tab, _TAB_PARAMS["videos"])
    data = await _post("browse", {"browseId": browse_id, "params": urllib.parse.unquote(params)})
    tabs = data.get("contents", {}).get("twoColumnBrowseResultsRenderer", {}).get("tabs") or []
    available = []
    content = {}
    for entry in tabs:
        renderer = entry.get("tabRenderer") or {}
        url = renderer.get("endpoint", {}).get("commandMetadata", {}).get("webCommandMetadata", {}).get("url", "")
        name = url.rsplit("/", 1)[-1]
        if name in _TAB_PARAMS:
            available.append(name)
        if renderer.get("selected"):
            content = renderer.get("content") or {}
    page = _collect(content)
    info = _channel_header(data, browse_id)
    for item in page["videos"]:
        item["uploader"] = item["uploader"] or info["title"]
        item["channelId"] = item["channelId"] or browse_id
        item["verified"] = item["verified"] or info["verified"]
        item["avatar"] = item["avatar"] or info["thumbnail"]
    return {"channel": info, "tabs": available or ["videos"], "tab": tab,
            "items": page["shorts"] if tab == "shorts" else page["videos"], "next": page["next"]}
