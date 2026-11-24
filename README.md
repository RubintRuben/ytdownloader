# Downloader

Windowsos videó- és hangletöltő helyi előnézettel, vágással, galériával és AI-hozzáféréssel (MCP).

## Használat

1. Indítsd el a [GitHub-kiadásoknál](https://github.com/RubintRuben/ytdownloader/releases) elérhető **Downloader.exe** fájlt egy saját, írható mappából. A gépen a Microsoft Edge WebView2 futtatókörnyezet szükséges. Az első indításkor az alkalmazás telepíti az FFmpeg-et, ha még nem érhető el.
2. A **Bármely oldal** nézetbe illessz be közvetlen videólinket. A **TikTok** fül rövid megosztási linkeket is fogad, a **YouTube** fülön cím alapján is kereshetsz. Linket az ablakba húzva is megnyithatsz, és ha a vágólapon videólink van, az app felajánlja a megnyitását.
3. A szerkesztőben válassz **Videó (MP4)** vagy **Csak hang (MP3)** formátumot, felbontást vagy bitrátát, és jelöld ki a menteni kívánt részt az idősávon vagy az időpontok beírásával.
4. A kész fájlok alapból a **Letöltések\Downloader** mappába kerülnek, és megjelennek a **Galériában**. A Beállításokban kérheted, hogy minden letöltésnél rákérdezzen a helyre.

### YouTube

- A keresés a YouTube-oldalhoz hasonló rácsot mutat: bélyegkép, hossz, csatornakép, megtekintések, feltöltés ideje, **Shorts-polc** és csatornatalálatok. Görgetéssel újabb találatok töltődnek be.
- A csatornára kattintva a YouTube-hoz hasonló csatornaoldal nyílik (borítókép, profilkép, feliratkozók, leírás, **Videók / Shorts / Élő** fülek). A **Feliratkozás** gomb a YouTube-on nyitja meg a feliratkozást.
- A kártyák ⋮ menüjéből közvetlenül is letölthetsz MP4-ben vagy MP3-ban, listához adhatsz, és linket másolhatsz.
- Szinkronizált videóknál **választható a hangsáv nyelve** az előnézetben és a letöltésnél is.
- **Feliratok**: kézi, automatikus és gépi fordítású feliratok. Az előnézetben a YouTube-hoz hasonlóan állítható a felirat nyelve, mérete, színe, betűtípusa, háttere és szegélye (`C` billentyű: be/ki). A letöltött videóba beágyazható a felirat, vagy külön `.srt` fájlba menthető; vágásnál a felirat is a kijelölt részhez igazodik.

### Galéria

A letöltött fájlok rácsban jelennek meg; a már törölt fájlok eltűnnek. Kattintással lejátszod, a ⋮ menüben megnyithatod külső lejátszóban, megmutathatod a mappában, átnevezheted, vághatod, átméretezheted, MP3-ba alakíthatod vagy törölheted. A sarokban lévő körrel több fájl jelölhető ki (Shift-kattintás: tartomány, Ctrl+A: mind, Delete: törlés). A törlés a Lomtárba helyez, onnan visszaállítható.

### Megjelenés

A beállítások a címsor **fogaskerék** ikonjával nyílnak. A klasszikus témák mellett három élő, animált téma van — **Fekete lyuk** (gravitációs fénygörbülés, akkréciós korong), **Mélytenger** (fénysugarak, buborékok, moszat) és **Eső** (cseppek az ablakon, villámlás) —, amelyekre a felület fényei is reagálnak. Saját kép vagy videó is beállítható háttérnek; a videó finom átúsztatással ismétlődik, és a felület színe követi. Az animáció minősége (Magas / Energiatakarékos / Ki) állítható.

Az ablak a Windows saját mozgatását és átméretezését használja: a képernyő tetejére húzva teljes méretű lesz, onnan lehúzva visszaáll, és működik az Aero Snap (oldalra húzás, Win+nyilak).

## AI-hozzáférés (MCP)

Az app beépített MCP-szervert futtat, így Claude és más MCP-képes asszisztensek kereshetnek, letölthetnek, vághatnak, átalakíthatnak, megnyithatnak és törölhetnek fájlokat a Galériában. A **Beállítások → AI · MCP** részen választható:

- **Kikapcsolva** — az AI semmit sem érhet el.
- **Engedélyt kér** (alapértelmezett) — keresni szabadon, de letöltés, szerkesztés, törlés és megnyitás előtt az appban jóvá kell hagyni.
- **Teljes hozzáférés** — minden kérdés nélkül lefut.

Csatlakoztatás (a pontos parancs a beállításokból másolható):

```powershell
claude mcp add downloader -- "C:\Út\Downloader.exe" --mcp
```

Claude Desktopban a `claude_desktop_config.json` fájlba:

```json
{ "mcpServers": { "downloader": { "command": "C:\\Út\\Downloader.exe", "args": ["--mcp"] } } }
```

Ha az app nem fut, a `--mcp` híd elindítja. HTTP-t támogató kliensek közvetlenül a `http://127.0.0.1:<port>/mcp` címre is csatlakozhatnak a beállításokban látható Bearer tokennel. Az eszközök: `search`, `info`, `download`, `jobs`, `cancel`, `library`, `edit`, `delete`, `open` — tömör, kevés tokent használó szöveges válaszokkal.

## Alkalmazásfrissítések

Az EXE indításkor ellenőrzi a GitHub legújabb stabil kiadását. Ha van újabb verzió, megjelenik a **Frissítés** gomb. A Downloader letölti és SHA-256-tal ellenőrzi a fájlt. A futó letöltések befejezése és mentése után lecseréli a futtatható fájlt, majd újraindítja az alkalmazást.

Ha a privát GitHub-tárolóhoz még nincs frissítési hozzáférés, a **Beállítások → Frissítés → Hozzáférés privát GitHub-tárolóhoz** részen állíts be egy [finomhangolt személyes tokent](https://github.com/settings/personal-access-tokens/new). A jogosultságot a `RubintRuben/ytdownloader` tárolóra korlátozd, **Contents → Read-only** hozzáféréssel. A tokent az alkalmazás az aktuális Windows-fiókhoz kötve, titkosítva tárolja. Fejlesztéshez a `DOWNLOADER_GITHUB_TOKEN` környezeti változó is használható.

## Fejlesztés és kiadás

Szükséges a **Python 3.10+**, **Node.js 22+** és a **WebView2**. A Node.js a YouTube videóadatainak lekéréséhez szükséges, a csomagolt EXE a build gépen elérhető Node.js futtatókörnyezetet tartalmazza.

- Futtatás forrásból a `START.bat` fájllal vagy a `py -m pip install -r requirements.txt` és `py app.py` parancsokkal.
- Windows EXE készítése a `BUILD_EXE.bat` fájllal. Az eredmény a `dist/Downloader.exe`.
- Tesztek futtatása a `py -m unittest discover -s tests -v` és a `node --test "tests/*.cjs"` parancsokkal.
- Kiadáshoz módosítsd a `version.py` fájlban az `APP_VERSION` értékét, majd küldd fel az egyező `vX.Y.Z` taget. A GitHub Actions teszteli és felépíti az EXE-t, ellenőrzi a csomagban a lejátszáshoz és a TikTokhoz szükséges összetevőket, aztán feltölti a `Downloader.exe` fájlt a kiadáshoz.

Az alkalmazás a `yt-dlp` által támogatott oldalak nyilvános videóit tudja megnyitni. Egyes tartalmakhoz a forrás bejelentkezést igényel. A helyi munkamenetfájlok és cookie-k a verziókövetésen és a csomagolt EXE-n kívül maradnak. A helyi szerver csak a saját ablak kéréseit fogadja el állapotváltoztató műveleteknél.
