@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Downloader - EXE keszites
echo ============================================
echo   Downloader - onallo EXE keszitese
echo ============================================
echo.

echo [1/3] Szukseges csomagok telepitese...
py -m pip install -q -r requirements.txt
if errorlevel 1 goto failed
py -m pip install -q --upgrade "yt-dlp[default,curl-cffi]"
if errorlevel 1 goto failed
py -m pip install -q pyinstaller
if errorlevel 1 goto failed

echo.
echo [2/3] EXE forditasa (ez par percig tarthat)...
py -m PyInstaller --clean --noconfirm downloader.spec
if errorlevel 1 goto failed

echo.
if exist "dist\Downloader.exe" (
  echo [3/3] KESZ!
  echo.
  echo   Az EXE itt van:  dist\Downloader.exe
  echo.
  echo   Ezt az egy fajlt adhatod oda barkinek - dupla kattintassal indul.
  echo   Elso inditaskor letolti az ffmpeg-et (egyszeri, ~1 perc).
) else (
  echo HIBA: nem keszult el az EXE. Nezd at a fenti uzeneteket.
)
echo.
pause
exit /b 0
:failed
echo HIBA: a build leallt. A korabbi EXE nem tekintheto friss buildnek.
pause
exit /b 1
