@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Downloader
echo ============================================
echo   Downloader - inditas
echo ============================================
echo.

py -c "import fastapi, uvicorn, webview, yt_dlp_ejs, curl_cffi; from yt_dlp.version import __version__; assert tuple(map(int,__version__.split('.'))) >= (2026,10,26)" >nul 2>&1
if errorlevel 1 (
  echo [1/2] Elso inditas - fuggosegek telepitese...
  py -m pip install -q -r requirements.txt
  if errorlevel 1 goto failed
  echo done> .deps_ok
) else (
  echo [1/2] Fuggosegek rendben.
)

echo [2/2] Alkalmazas inditasa...
echo.
echo   Az app sajat ablakban nyilik meg (nem a bongeszoben).
echo.

py app.py

pause
exit /b 0
:failed
echo Nem sikerult a fuggosegek telepitese. Ellenorizd a fenti hibauzenetet.
pause
exit /b 1
