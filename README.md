# Downloader

Windowsos videó- és hangletöltő helyi előnézettel, vágással és letöltési listával.

## Használat

1. Indítsd el a [GitHub-kiadásoknál](https://github.com/RubintRuben/ytdownloader/releases) elérhető **Downloader.exe** fájlt egy saját, írható mappából. A gépen a Microsoft Edge WebView2 futtatókörnyezet szükséges. Az első indításkor az alkalmazás telepíti az FFmpeg-et, ha még nem érhető el.
2. A **Bármely oldal** nézetbe illessz be közvetlen videólinket. A külön **TikTok** fül rövid megosztási linkeket is fogad, a **YouTube** fülön cím alapján is kereshetsz.
3. Az előnézetnél válassz **MP4** videót vagy **MP3** hangot, állítsd be a minőséget, majd jelöld ki a menteni kívánt részt. A vágás a kulcsképkockához igazodik.
4. A **Letöltések** panelen követheted a folyamatot és mentheted az elkészült fájlokat. Az előkészített videókat a **Lista** panelen is gyűjtheted és szerkesztheted.

A **Beállítások** menüben hét alkalmazástéma van. A választás a következő indításkor is megmarad. A keresőmező gyorsbillentyűje **Ctrl+K**.

Az előnézet először a forrás kis felbontású, közvetlenül tekerhető streamjét használja. Külön videó- és hangsáv vagy csak HLS esetén fragmentált MP4-et játszik le már az átalakítás közben. Egyes forrásokhoz teljes helyi előkészítés szükséges. Az első képkockáig eltelt idő és a támogatott felbontások a szolgáltatótól függenek.

## Alkalmazásfrissítések

Az EXE indításkor ellenőrzi a GitHub legújabb stabil kiadását. Ha van újabb verzió, megjelenik a **Frissítés** gomb. A Downloader letölti és SHA-256-tal ellenőrzi a fájlt. A futó letöltések befejezése és mentése után lecseréli a futtatható fájlt, majd újraindítja az alkalmazást.

Privát GitHub-tárolónál a **Beállítások → Hozzáférés privát GitHub-tárolóhoz** részen állíts be egy [finomhangolt személyes tokent](https://github.com/settings/personal-access-tokens/new). A jogosultságot a `RubintRuben/ytdownloader` tárolóra korlátozd, **Contents → Read-only** hozzáféréssel. A tokent az alkalmazás az aktuális Windows-fiókhoz kötve, titkosítva tárolja. Fejlesztéshez a `DOWNLOADER_GITHUB_TOKEN` környezeti változó is használható.

## Fejlesztés és kiadás

Szükséges a **Python 3.10+**, **Node.js 22+** és a **WebView2**. A Node.js a YouTube videóadatainak lekéréséhez szükséges, a csomagolt EXE a build gépen elérhető Node.js futtatókörnyezetet tartalmazza.

- Futtatás forrásból a `START.bat` fájllal vagy a `py -m pip install -r requirements.txt` és `py app.py` parancsokkal.
- Windows EXE készítése a `BUILD_EXE.bat` fájllal. Az eredmény a `dist/Downloader.exe`.
- Tesztek futtatása a `py -m unittest discover -s tests -v` és a `node --test "tests/*.cjs"` parancsokkal.
- Kiadáshoz módosítsd a `version.py` fájlban az `APP_VERSION` értékét, majd küldd fel az egyező `vX.Y.Z` taget. A GitHub Actions teszteli és felépíti az EXE-t, ellenőrzi a csomagban a lejátszáshoz és a TikTokhoz szükséges összetevőket, aztán feltölti a `Downloader.exe` fájlt a kiadáshoz.

Az alkalmazás a `yt-dlp` által támogatott oldalak nyilvános videóit tudja megnyitni. Egyes tartalmakhoz a forrás bejelentkezést igényel. A helyi munkamenetfájlok és cookie-k a verziókövetésen és a csomagolt EXE-n kívül maradnak.
