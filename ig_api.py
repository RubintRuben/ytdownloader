"""
ig_api.py — Instagram web-API kliens egy BEÉPÍTETT (alt-fiók) munkamenettel.

Az alkalmazás mellett szállítunk egy `ig_session_cookies.txt`-t (egy mellék/alt fiók
bejelentkezett cookie-jaival). Ezzel a web-API publikus végpontjai megbízhatóan mennek,
a felhasználónak SEMMIT nem kell beállítania:

  - web/search/topsearch    -> emberekre/fiókokra keresés (több találat)
  - users/web_profile_info  -> egy fiók publikus posztjai/reeljei
  - media/{id}/info         -> egy reel/poszt média-adatai (friss letöltési URL)

A media-URL-ek időkorlátosak, ezért letöltés ELŐTT mindig frissítjük (lásd app.py).
"""
from __future__ import annotations

import os
import re
import sys
import json
import time
import html
import threading
import difflib
import http.cookiejar
import urllib.error
import urllib.parse
import urllib.request

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
_APP_ID = "936619743392459"          # az Instagram web-kliens publikus app-id-je
_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

_lock = threading.Lock()
_session = {"opener": None, "csrf": "", "ts": 0.0}


def _cookie_path() -> str:
    """A beépített IG session-cookie MASTER fájl útja (EXE-ben a _MEIPASS-ból is).

    FONTOS: ez a master fájl SÉRTHETETLEN — a yt-dlp soha nem kapja meg közvetlenül
    (mert felülírná és kitörölné a sessionid-t). A yt-dlp-nek mindig friss MÁSOLATOT
    készítünk (lásd app.py / ig_cookie_copy)."""
    name = "ig_session_master.txt"
    for base in (getattr(sys, "_MEIPASS", None), os.path.dirname(os.path.abspath(__file__))):
        if base:
            p = os.path.join(base, name)
            if os.path.exists(p):
                return p
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), name)


def cookie_copy_for_ytdlp() -> str | None:
    """A yt-dlp-nek adandó cookies.txt — a master ÍRHATÓ MÁSOLATA egy temp helyen.
    Így ha a yt-dlp felülírja, a master sértetlen marad."""
    import tempfile
    pairs = _read_cookie_pairs()
    if not pairs.get("sessionid"):
        return None
    dst = os.path.join(tempfile.gettempdir(), "downloader_ig_cookies.txt")
    try:
        lines = ["# Netscape HTTP Cookie File", ""]
        for name, value in pairs.items():
            # domain, include_subdomains, path, secure, expiry, name, value
            lines.append("\t".join([".instagram.com", "TRUE", "/", "TRUE", "0", name, value]))
        with open(dst, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        return dst
    except Exception:
        return None


def shortcode_to_media_id(shortcode: str) -> int | None:
    """Instagram shortcode (base64-szerű) → numerikus media_id."""
    try:
        n = 0
        for ch in shortcode:
            n = n * 64 + _ALPHABET.index(ch)
        return n
    except Exception:
        return None


def _read_cookie_pairs() -> dict[str, str]:
    """A beépített Netscape cookies.txt SAJÁT, megengedő beolvasása.

    A http.cookiejar.MozillaCookieJar szigorú, és kihagyhat sorokat (pl. a `sessionid`-t,
    aminek az értéke `%3A`-kat tartalmaz) — ezért egyszerű, TAB-tagolt parserrel olvassuk,
    és minden cookie name→value párt visszaadunk. A kritikus cookie a `sessionid`."""
    pairs: dict[str, str] = {}
    try:
        with open(_cookie_path(), "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                s = line.strip()
                if not s or s.startswith("#"):
                    continue
                parts = line.rstrip("\n").split("\t")
                if len(parts) >= 7:
                    name, value = parts[5], parts[6]
                    if name:
                        pairs[name] = value
    except Exception:
        pass
    return pairs


def _build_cookiejar() -> tuple[http.cookiejar.CookieJar, dict[str, str]]:
    """CookieJar a beépített cookie-párokból (minden cookie betöltve, sessionid is)."""
    pairs = _read_cookie_pairs()
    cj = http.cookiejar.CookieJar()
    for name, value in pairs.items():
        cj.set_cookie(http.cookiejar.Cookie(
            version=0, name=name, value=value, port=None, port_specified=False,
            domain=".instagram.com", domain_specified=True, domain_initial_dot=True,
            path="/", path_specified=True, secure=True, expires=None, discard=False,
            comment=None, comment_url=None, rest={"HttpOnly": None}, rfc2109=False,
        ))
    return cj, pairs


def _new_opener() -> tuple[urllib.request.OpenerDirector, str]:
    """Munkamenet a beépített alt-fiók cookie-jaival (ha van), különben vendégként."""
    cj, pairs = _build_cookiejar()
    csrf = pairs.get("csrftoken", "")
    if not csrf:
        # nincs csrf a fájlból → vendég-munkamenet a kezdőoldalról
        try:
            with opener_for(cj).open(urllib.request.Request(
                    "https://www.instagram.com/", headers={"User-Agent": _UA}), timeout=15) as r:
                r.read(1500)
            for c in cj:
                if c.name == "csrftoken":
                    csrf = c.value or ""
        except Exception:
            pass
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj)), csrf


def opener_for(cj):
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def _get_session() -> tuple[urllib.request.OpenerDirector, str]:
    """Munkamenet (15 percig újrahasználjuk, hogy ne hívjuk feleslegesen)."""
    with _lock:
        now = time.time()
        if _session["opener"] is None or (now - _session["ts"]) > 900:
            opener, csrf = _new_opener()
            _session.update(opener=opener, csrf=csrf, ts=now)
        return _session["opener"], _session["csrf"]


def has_session() -> bool:
    """Van-e bejelentkezett (sessionid-s) beépített cookie?"""
    return bool(_read_cookie_pairs().get("sessionid"))


def _api_get(url: str, retries: int = 2) -> dict | None:
    """Guest-API GET JSON-nal. 429 (rate-limit) esetén rövid backoff + új munkamenet."""
    for attempt in range(retries + 1):
        opener, csrf = _get_session()
        headers = {
            "User-Agent": _UA,
            "X-IG-App-ID": _APP_ID,
            "X-CSRFToken": csrf,
            "X-Requested-With": "XMLHttpRequest",
            "Referer": "https://www.instagram.com/",
            "Accept": "*/*",
        }
        req = urllib.request.Request(url, headers=headers)
        try:
            with opener.open(req, timeout=15) as r:
                raw = r.read().decode("utf-8", "ignore")
        except urllib.error.HTTPError as e:
            if e.code in (429, 401, 403) and attempt < retries:
                # rate-limit / elcsúszott session: friss munkamenet a masterből + várakozás
                with _lock:
                    _session["opener"] = None
                time.sleep((3.0 if e.code == 429 else 1.0) + attempt * 2.0)
                continue
            return None
        except Exception:
            return None
        if not raw or raw[:1] not in "{[":
            return None
        try:
            return json.loads(raw)
        except Exception:
            return None
    return None


# ---------------------------------------------------------------------------
# Emberekre keresés (topsearch) — több fiók találat
# ---------------------------------------------------------------------------

def search_users(query: str, limit: int = 12) -> list[dict]:
    """Instagram fiók-keresés név/szó alapján → több publikus fiók (topsearch API)."""
    query = (query or "").strip().lstrip("@")
    if not query:
        return []
    url = ("https://www.instagram.com/api/v1/web/search/topsearch/?context=blended&query="
           + urllib.parse.quote(query))
    data = _api_get(url)
    if not data:
        return []
    out: list[dict] = []
    for u in (data.get("users") or []):
        user = u.get("user") or {}
        uname = user.get("username")
        if not uname:
            continue
        out.append({
            "username": uname,
            "full_name": user.get("full_name") or "",
            "is_verified": bool(user.get("is_verified")),
            "is_private": bool(user.get("is_private")),
            "profile_pic_url": user.get("profile_pic_url") or "",
            "url": f"https://www.instagram.com/{uname}/",
        })
        if len(out) >= limit:
            break
    return out


# ---------------------------------------------------------------------------
# Reelekre keresés (hashtag) — a találatok videók, a készítő profilképével
# ---------------------------------------------------------------------------

def _tag_section_items(data: dict):
    """A hashtag web_info / sections válaszból kiszedi a media-itemeket."""
    items = []
    # 1) sections szerkezet (api/v1/tags/.../sections)
    for sec in (data.get("sections") or []):
        layout = (sec.get("layout_content") or {})
        for grp in (layout.get("medias") or []):
            m = grp.get("media")
            if m:
                items.append(m)
        for one in (layout.get("one_by_two_item") or {}).get("clips", {}).get("items", []):
            if one.get("media"):
                items.append(one["media"])
    # 2) ranked/top/recent edge szerkezet (tags/web_info)
    for key in ("top", "recent"):
        edges = (((data.get("data") or {}).get(key) or {}).get("sections")) or []
        for sec in edges:
            for grp in ((sec.get("layout_content") or {}).get("medias") or []):
                if grp.get("media"):
                    items.append(grp["media"])
    return items


def _media_to_reel(m: dict) -> dict | None:
    """Egy media-item → reel-kártya dict (csak videó), a készítő profilképével."""
    code = m.get("code")
    vv = m.get("video_versions") or []
    if not code or not vv:
        return None
    user = m.get("user") or {}
    cap = ""
    if isinstance(m.get("caption"), dict):
        cap = (m["caption"].get("text") or "").strip()
    cand = (m.get("image_versions2") or {}).get("candidates") or []
    thumb = cand[0].get("url") if cand else ""
    dur = m.get("video_duration") or 0
    return {
        "id": code,
        "shortcode": code,
        "url": f"https://www.instagram.com/reel/{code}/",
        "title": (cap or "Reel")[:120],
        "is_video": True,
        "duration": int(dur) if dur else 0,
        "thumbnail": thumb,
        "uploader": "@" + (user.get("username") or ""),
        "author_pic": user.get("profile_pic_url") or "",
        "video_url": vv[0].get("url") or "",
    }


def search_reels(query: str, limit: int = 18) -> list[dict]:
    """Reelekre keresés egy téma/hashtag alapján. A találatok VIDEÓK, mindegyikhez
    a készítő profilképével. A bejelentkezett (master) cookie-val működik."""
    tag = re.sub(r"[^A-Za-z0-9_]", "", (query or "").lstrip("#"))
    if not tag:
        return []
    out: list[dict] = []
    seen = set()
    # elsődleges: a hashtag klip/reels szekciói
    for ep in (
        f"https://www.instagram.com/api/v1/tags/web_info/?tag_name={urllib.parse.quote(tag)}",
        f"https://www.instagram.com/api/v1/tags/{urllib.parse.quote(tag)}/sections/",
    ):
        data = _api_get(ep)
        if not data:
            continue
        for m in _tag_section_items(data):
            r = _media_to_reel(m)
            if r and r["id"] not in seen:
                seen.add(r["id"])
                out.append(r)
            if len(out) >= limit:
                return out
        if out:
            break
    return out


# ---------------------------------------------------------------------------
# Profil → posztok (a fiók-kártyára kattintva)
# ---------------------------------------------------------------------------

def user_profile_pic(username: str) -> str:
    """Egy fiók profilképének URL-je (a topsearchből, gyors)."""
    username = (username or "").strip().lstrip("@").lower()
    if not username:
        return ""
    d = _api_get("https://www.instagram.com/api/v1/web/search/topsearch/?context=blended&query="
                 + urllib.parse.quote(username))
    if d:
        for u in (d.get("users") or []):
            user = u.get("user") or {}
            if (user.get("username") or "").lower() == username:
                return user.get("profile_pic_url") or ""
        first = ((d.get("users") or [{}])[0].get("user") or {})
        return first.get("profile_pic_url") or ""
    return ""


def resolve_user_pk(username: str) -> str | None:
    """A felhasználónévhez tartozó numerikus user-id (pk). Először a topsearchből
    (kevésbé rate-limitelt), tartalékként a web_profile_info-ból."""
    username = (username or "").strip().lstrip("@").lower()
    if not username:
        return None
    d = _api_get("https://www.instagram.com/api/v1/web/search/topsearch/?context=blended&query="
                 + urllib.parse.quote(username))
    if d:
        for u in (d.get("users") or []):
            user = u.get("user") or {}
            if (user.get("username") or "").lower() == username:
                pk = user.get("pk") or user.get("pk_id")
                if pk:
                    return str(pk)
        # ha nincs pontos egyezés, az első találat
        first = ((d.get("users") or [{}])[0].get("user") or {})
        if first.get("pk"):
            return str(first["pk"])
    # tartalék: web_profile_info
    d2 = _api_get("https://www.instagram.com/api/v1/users/web_profile_info/?username="
                  + urllib.parse.quote(username))
    if d2:
        user = (d2.get("data") or {}).get("user") or {}
        if user.get("id"):
            return str(user["id"])
    return None


def _feed_item(it: dict) -> dict | None:
    """A feed/user API egy eleme → egységes poszt-dict."""
    sc = it.get("code")
    if not sc:
        return None
    cap = ""
    if isinstance(it.get("caption"), dict):
        cap = (it["caption"].get("text") or "").strip()
    vv = it.get("video_versions") or []
    is_video = bool(vv) or it.get("media_type") == 2
    dur = it.get("video_duration") or 0
    thumb = ""
    cand = (it.get("image_versions2") or {}).get("candidates") or []
    if cand:
        thumb = cand[0].get("url") or ""
    return {
        "id": sc,
        "shortcode": sc,
        "url": f"https://www.instagram.com/p/{sc}/",
        "title": (cap or ("Reel" if is_video else "Poszt"))[:120],
        "is_video": is_video,
        "duration": int(dur) if dur else 0,
        "thumbnail": thumb,
        "video_url": (vv[0].get("url") if vv else "") or "",
    }


def _node_to_item(node: dict) -> dict | None:
    """A web_profile_info (GraphQL) egy node-ja → egységes poszt-dict (fallback)."""
    sc = node.get("shortcode")
    if not sc:
        return None
    caption = ""
    edges = (node.get("edge_media_to_caption") or {}).get("edges") or []
    if edges:
        caption = ((edges[0].get("node") or {}).get("text") or "").strip()
    is_video = bool(node.get("is_video"))
    dur = node.get("video_duration") or 0
    return {
        "id": sc,
        "shortcode": sc,
        "url": f"https://www.instagram.com/p/{sc}/",
        "title": (caption or ("Reel" if is_video else "Poszt"))[:120],
        "is_video": is_video,
        "duration": int(dur) if dur else 0,
        "thumbnail": node.get("display_url") or node.get("thumbnail_src") or "",
        "video_url": node.get("video_url") or "",
    }


def fetch_user_posts(username: str, limit: int = 12, pk: str | None = None) -> list[dict]:
    """Egy fiók publikus posztjai/reeljei. A feed/user/{pk} végpont stabilabb, mint a
    web_profile_info (kevésbé rate-limitelt).

    FONTOS: a frontend csak a VIDEÓKAT (reeleket) mutatja. Sok fióknál a legfrissebb
    posztok képek, ezért LAPOZUNK (max_id) néhány oldalt, hogy biztosan találjunk videót
    is — különben „nincs videó" üzenet jönne, pedig a fióknak vannak reeljei.

    GYORSASÁG: ha a `pk` (user-id) már ismert (a kereső-kártyáról jön), átugorjuk a
    feloldó hálózati hívást → azonnal a feedet kérjük."""
    username = (username or "").strip().lstrip("@")
    if not username:
        return []
    pk = (pk or "").strip() or resolve_user_pk(username)
    if pk:
        out: list[dict] = []
        videos: list[dict] = []
        seen: set[str] = set()
        next_max_id = ""
        # GYORSASÁG: csak addig lapozunk, amíg össze nem jön elég videó. A legtöbb fióknál
        # az 1. oldal (33 poszt) már bőven elég → 1 hálózati hívás. Max 3 oldal, hogy a
        # ritka, sok-kép-kevés-videó fióknál se akadjon be, de ne is tartson sokáig.
        for _page in range(3):
            ep = f"https://www.instagram.com/api/v1/feed/user/{pk}/?count=33"
            if next_max_id:
                ep += "&max_id=" + urllib.parse.quote(next_max_id)
            data = _api_get(ep)
            if not data or not data.get("items"):
                break
            for it in data["items"]:
                item = _feed_item(it)
                if not item or item["id"] in seen:
                    continue
                seen.add(item["id"])
                out.append(item)
                if item.get("is_video"):
                    videos.append(item)
            # elég videó gyűlt össze, vagy nincs több oldal → megállunk (ne lapozzunk feleslegesen)
            if len(videos) >= limit or not data.get("more_available"):
                break
            next_max_id = data.get("next_max_id") or ""
            if not next_max_id:
                break
        if videos or out:
            # a videók előre (a frontend úgyis ezeket mutatja), de a képeket is visszaadjuk
            ordered = videos + [p for p in out if not p.get("is_video")]
            return ordered[:max(limit, len(videos))]

    # tartalék: web_profile_info GraphQL-szerű szerkezet
    data = _api_get("https://www.instagram.com/api/v1/users/web_profile_info/?username="
                    + urllib.parse.quote(username))
    if not data:
        return []
    user = (data.get("data") or {}).get("user") or {}
    media = (user.get("edge_owner_to_timeline_media") or {}).get("edges") or []
    out = []
    for ed in media:
        item = _node_to_item(ed.get("node") or {})
        if item:
            out.append(item)
        if len(out) >= limit:
            break
    # videók előre itt is
    return sorted(out, key=lambda p: not p.get("is_video"))[:limit]


# ---------------------------------------------------------------------------
# Egy reel/poszt → letölthető videó-URL (guest media-info API)
# ---------------------------------------------------------------------------

def _shortcode_from_url(url: str) -> str | None:
    import re
    m = re.search(r"instagram\.com/(?:p|reel|reels|tv)/([A-Za-z0-9_-]+)", url)
    return m.group(1) if m else None


def fetch_media(url: str) -> dict | None:
    """Egy reel/poszt média-adatai a guest media-info API-ból (cookie/login nélkül).

    Visszaad: {title, thumbnail, duration, video_url, width, height} vagy None.
    """
    sc = _shortcode_from_url(url)
    if not sc:
        return None
    mid = shortcode_to_media_id(sc)
    if mid is None:
        return None
    data = _api_get(f"https://www.instagram.com/api/v1/media/{mid}/info/")
    if not data:
        return None
    items = data.get("items") or []
    if not items:
        return None
    it = items[0]
    # cím (caption)
    cap = ""
    if isinstance(it.get("caption"), dict):
        cap = (it["caption"].get("text") or "").strip()
    # legjobb videó-verzió
    vv = it.get("video_versions") or []
    video_url, w, h = "", 0, 0
    if vv:
        best = max(vv, key=lambda v: (v.get("width") or 0) * (v.get("height") or 0))
        video_url = best.get("url") or ""
        w, h = best.get("width") or 0, best.get("height") or 0
    # thumbnail
    thumb = ""
    cand = (it.get("image_versions2") or {}).get("candidates") or []
    if cand:
        thumb = cand[0].get("url") or ""
    dur = it.get("video_duration") or 0
    return {
        "shortcode": sc,
        "title": (cap or "Instagram videó")[:120],
        "thumbnail": thumb,
        "duration": int(dur) if dur else 0,
        "video_url": video_url,
        "width": w,
        "height": h,
        "uploader": "@" + ((it.get("user") or {}).get("username") or ""),
    }

# Later definition intentionally overrides the simple topsearch helper above.
def search_users(query: str, limit: int = 20) -> list[dict]:
    """Instagram account search with query variants and fuzzy ranking."""
    raw = (query or "").strip().lstrip("@")
    if not raw:
        return []

    wanted = max(1, min(30, limit))
    found: dict[str, dict] = {}
    for idx, q in enumerate(_search_query_variants(raw)):
        url = ("https://www.instagram.com/api/v1/web/search/topsearch/?context=blended&query="
               + urllib.parse.quote(q))
        # az ELSŐ (legrelevánsabb) lekérdezés kapjon retryt — ez adja a profilképeket;
        # rate-limit esetén ne essünk rögtön a kép nélküli web-fallbackre
        data = _api_get(url, retries=(2 if idx == 0 else 0))
        if not data:
            continue
        for item in (data.get("users") or []):
            user = item.get("user") or {}
            uname = user.get("username")
            if not uname or uname in found:
                continue
            pic = (user.get("profile_pic_url_hd") or user.get("profile_pic_url") or "")
            found[uname] = {
                "username": uname,
                "full_name": user.get("full_name") or "",
                "is_verified": bool(user.get("is_verified")),
                "is_private": bool(user.get("is_private")),
                "profile_pic_url": pic,
                # a pk-t (user-id) is eltesszük — így a fiókra kattintáskor NEM kell újra
                # feloldani (egy hálózati körrel gyorsabb a videók betöltése)
                "pk": str(user.get("pk") or user.get("pk_id") or ""),
                "url": f"https://www.instagram.com/{uname}/",
                "_rank": _user_match_score(raw, uname, user.get("full_name") or ""),
            }
        # GYORSASÁG: ha az első lekérdezés már elég fiókot adott, ne pörgessünk több
        # query-variánst (az csak lassítana). A web-fallbackre csak akkor megyünk, ha
        # tényleg kevés van.
        if len(found) >= wanted:
            break

    if len(found) < wanted:
        for q in _search_query_variants(raw)[:3]:
            for user in _search_users_web(q, wanted * 2):
                uname = user["username"]
                if uname not in found:
                    user["_rank"] = _user_match_score(raw, uname, user.get("full_name") or "")
                    found[uname] = user
            if len(found) >= wanted:
                break

    if len(found) < wanted:
        for uname in _username_guesses(raw):
            if uname not in found:
                found[uname] = {
                    "username": uname,
                    "full_name": "",
                    "is_verified": False,
                    "is_private": False,
                    "profile_pic_url": "",
                    "url": f"https://www.instagram.com/{uname}/",
                    "_rank": _user_match_score(raw, uname, "") - 8,
                }

    ranked = sorted(
        found.values(),
        key=lambda u: (-u["_rank"], not u["is_verified"], u["is_private"], len(u["username"]), u["username"]),
    )
    for user in ranked:
        user.pop("_rank", None)
    return ranked[:wanted]


def _search_query_variants(query: str) -> list[str]:
    simple = re.sub(r"\s+", " ", query.strip().lstrip("@"))
    compact = re.sub(r"[\s._-]+", "", simple)
    dotted = re.sub(r"[\s_-]+", ".", simple)
    underscored = re.sub(r"[\s.-]+", "_", simple)
    tokens = [t for t in re.split(r"[\s._-]+", simple) if len(t) >= 2]
    candidates = [simple, compact, dotted, underscored, *tokens, " ".join(tokens[:2]), "".join(tokens[:2])]

    variants: list[str] = []
    seen: set[str] = set()
    for item in candidates:
        item = item.strip(" ._-\t\r\n")
        key = item.casefold()
        if item and key not in seen:
            seen.add(key)
            variants.append(item)
    return variants[:8]


def _search_users_brave(query: str, limit: int) -> list[dict]:
    return _search_users_from_url(
        "https://search.brave.com/search?q="
        + urllib.parse.quote(f"site:instagram.com {query} instagram profile"),
        query,
        limit,
    )


def _search_users_web(query: str, limit: int) -> list[dict]:
    searches = [
        "https://search.yahoo.com/search?p="
        + urllib.parse.quote(f"site:instagram.com {query} instagram profile"),
        "https://search.yahoo.com/search?p="
        + urllib.parse.quote(f"{query} instagram"),
        "https://search.brave.com/search?q="
        + urllib.parse.quote(f"site:instagram.com {query} instagram profile"),
    ]
    users: dict[str, dict] = {}
    for url in searches:
        for user in _search_users_from_url(url, query, limit):
            users.setdefault(user["username"], user)
        if len(users) >= limit:
            break
    return sorted(users.values(), key=lambda u: (-u["_rank"], len(u["username"]), u["username"]))[:limit]


def _search_users_from_url(url: str, query: str, limit: int) -> list[dict]:
    headers = {"User-Agent": _UA, "Accept": "text/html,*/*"}
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=5) as r:
            page = r.read().decode("utf-8", "ignore")
    except Exception:
        return []

    return _extract_usernames_from_search_page(page, query, limit)


def _extract_usernames_from_search_page(page: str, query: str, limit: int) -> list[dict]:
    blocked = {
        "p", "reel", "reels", "tv", "explore", "accounts", "direct", "stories",
        "about", "developer", "challenge", "oauth", "legal", "privacy", "api",
        "graphql", "web", "static", "download",
    }
    decoded = page
    for _ in range(2):
        decoded = urllib.parse.unquote(html.unescape(decoded)).replace("\\/", "/")

    users: dict[str, dict] = {}
    patterns = [
        r"(?<![A-Za-z0-9_.-])(?:https?:)?//(?:www\.)?instagram\.com/([A-Za-z0-9_.]{2,30})(?:[/?#&\"'<>\s]|$)",
        r"(?<![A-Za-z0-9_.-])instagram\.com/([A-Za-z0-9_.]{2,30})(?:[/?#&\"'<>\s]|$)",
    ]
    for pattern in patterns:
        for raw in re.findall(pattern, decoded, flags=re.I):
            uname = raw.strip(" ./").lower()
            if not uname or uname in blocked or len(uname) < 2:
                continue
            if not re.fullmatch(r"[a-z0-9_.]{2,30}", uname):
                continue
            rank = _user_match_score(query, uname, "")
            if rank < 18 and not any(part and part in uname for part in _norm_search(query).split()):
                continue
            if uname not in users:
                users[uname] = {
                    "username": uname,
                    "full_name": "",
                    "is_verified": False,
                    "is_private": False,
                    "profile_pic_url": "",
                    "url": f"https://www.instagram.com/{uname}/",
                    "_rank": rank,
                }
            if len(users) >= limit * 3:
                break
        if len(users) >= limit * 3:
            break
    return sorted(users.values(), key=lambda u: (-u["_rank"], len(u["username"]), u["username"]))[:limit]


def _username_guesses(query: str) -> list[str]:
    simple = re.sub(r"\s+", " ", query.strip().lstrip("@").casefold())
    tokens = [t for t in re.split(r"[\s._-]+", simple) if t]
    candidates = [
        re.sub(r"[^a-z0-9_.]+", "", simple),
        "".join(tokens),
        ".".join(tokens),
        "_".join(tokens),
    ]
    if len(tokens) >= 2:
        candidates.extend([
            tokens[0] + tokens[-1],
            tokens[0] + "." + tokens[-1],
            tokens[0] + "_" + tokens[-1],
        ])
    out: list[str] = []
    seen: set[str] = set()
    for c in candidates:
        c = c.strip("._")
        if re.fullmatch(r"[a-z0-9_.]{2,30}", c or "") and c not in seen:
            seen.add(c)
            out.append(c)
    return out


def _user_match_score(query: str, username: str, full_name: str) -> float:
    q = _norm_search(query)
    u = _norm_search(username)
    f = _norm_search(full_name)
    if not q:
        return 0.0
    score = 0.0
    if u == q:
        score += 100
    if u.startswith(q):
        score += 55
    if q in u:
        score += 35
    if f.startswith(q):
        score += 28
    if q in f:
        score += 22
    score += difflib.SequenceMatcher(None, q, u).ratio() * 30
    if f:
        score += difflib.SequenceMatcher(None, q, f).ratio() * 18
    return score


def _norm_search(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (s or "").casefold())
