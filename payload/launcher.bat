@echo off
chcp 65001 >nul
title OpusMC Modded - local server
cd /d "%~dp0"
where node >nul 2>nul || (echo [OpusMC] Node.js not found. Install from https://nodejs.org & echo. & pause & exit /b 1)
echo [OpusMC] Starting modded OpusMC (borderless + mods). Browser URL uses 127.0.0.1.
echo [OpusMC] Closing this console window stops the server.
echo.
node "%~dp0_opus\server.js"
echo.
echo [OpusMC] Server exited.
pause
