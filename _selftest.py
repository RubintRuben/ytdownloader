"""Gyors önteszt: IG keresés/profilkép/posztok + YouTube info, a friss cookie-kkal.

Futtatás:  py _selftest.py
A backend végpontjait hívja, pont mint a frontend. Ha az IG 400/401-et ad,
az IP-alapú rate-limit/lejárt cookie — várj pár percet, vagy frissítsd a cookie-t.
"""
import sys, io, threading, time
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
import app, httpx, uvicorn

PORT = 7868
cfg = uvicorn.Config(app.app, host="127.0.0.1", port=PORT, log_level="error", access_log=False)
server = uvicorn.Server(cfg)
threading.Thread(target=server.run, daemon=True).start()
base = f"http://127.0.0.1:{PORT}"
for _ in range(80):
    try:
        httpx.get(base + "/api/jobs", timeout=1); break
    except Exception:
        time.sleep(0.2)

ok = True

print("\n[1] IG fiók-keresés 'nasa'")
r = httpx.get(base + "/api/search", params={"q": "nasa", "source": "instagram", "limit": 6}, timeout=40)
users = r.json().get("results", []) if r.status_code == 200 else []
pics = sum(1 for u in users if u.get("thumbnail"))
print(f"    {len(users)} fiók, {pics} profilképpel")
ok &= pics > 0

if users:
    u0 = next((u for u in users if u.get("thumbnail")), users[0])
    print(f"\n[2] Profilkép proxy (@{u0['username']})")
    if u0.get("thumbnail"):
        r = httpx.get(base + "/api/thumb", params={"url": u0["thumbnail"]}, timeout=30)
        print(f"    HTTP {r.status_code}, {r.headers.get('content-type')}, {len(r.content)} byte")
        ok &= r.status_code == 200

    print(f"\n[3] Fiók videói (@{u0['username']})")
    r = httpx.get(base + "/api/ig/posts", params={"username": u0["username"], "limit": 30}, timeout=60)
    posts = r.json().get("posts", []) if r.status_code == 200 else []
    vids = [p for p in posts if p.get("isVideo")]
    print(f"    {len(posts)} poszt, {len(vids)} videó")
    ok &= len(vids) > 0

print("\n[4] YouTube info (cookie-val)")
r = httpx.get(base + "/api/info", params={"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}, timeout=60)
if r.status_code == 200:
    d = r.json()
    print(f"    OK: {d.get('title')} | felbontások: {d.get('resolutions')[:6]}")
else:
    print(f"    HIBA {r.status_code}: {r.json().get('detail')}")
    ok = False

print("\n" + ("MINDEN ZÖLD ✅" if ok else "VAN HIBA ⚠️ (lehet átmeneti IG rate-limit)"))
