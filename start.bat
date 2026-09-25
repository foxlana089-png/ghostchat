@echo off
chcp 65001 >nul
title GhostChat
cd /d "%~dp0"
echo.
echo   GhostChat laeuft - Adresse steht unten (Strg+Klick oeffnet sie)
echo.
python server.py
if errorlevel 1 (
  echo.
  echo   [!] Fehler. Fuererst "install.bat" ausfuehren, dann nochmal starten.
  pause
)
