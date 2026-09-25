@echo off
chcp 65001 >nul
title GhostChat - Installation
cd /d "%~dp0"
echo.
echo   ============================================
echo      GhostChat - Installation
echo   ============================================
echo.

where python >nul 2>nul
if errorlevel 1 (
  echo   [!] Python nicht gefunden.
  echo       Bitte installieren: https://www.python.org/downloads/
  echo       "Add Python to PATH" beim Setup aktivieren.
  echo.
  pause
  exit /b 1
)

echo   [1/3] Pakete werden installiert ...
python -m pip install --disable-pip-version-check -q -r "%~dp0requirements.txt"
if errorlevel 1 (
  echo   [!] pip ist fehlgeschlagen.
  pause
  exit /b 1
)

echo   [2/3] Desktop-Verknuepfung wird erstellt ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$sh=New-Object -ComObject WScript.Shell; $l=$sh.CreateShortcut([Environment]::GetFolderPath('Desktop')+'\GhostChat.lnk'); $l.TargetPath='%~dp0start.bat'; $l.WorkingDirectory='%~dp0'; $l.IconLocation='%SystemRoot%\System32\SHELL32.dll,27'; $l.Save()"

echo   [3/3] Fertig.
echo.
echo   ---------------------------------------------
echo     Doppelklick auf "GhostChat" im Desktop,
echo     dann im Browser oeffnen:
echo        http://127.0.0.1:8080
echo.
echo     Nickname + Passwort waehlen - fertig.
echo   ---------------------------------------------
echo.
pause
