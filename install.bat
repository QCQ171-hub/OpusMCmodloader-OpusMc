@echo off
chcp 65001 >nul
title OpusMC Mod Loader Installer
rem Move cwd out of this folder so it can be deleted after install.
cd /d "%TEMP%"
where node >nul 2>nul || (echo [OpusMC] Node.js not found. Install from https://nodejs.org & echo. & pause & exit /b 1)
node "%~dp0install.js" %*
set "SELFDIR=%~dp0"
echo.
echo Done. This installer folder will remove itself momentarily...
rem Self-delete: detached cmd waits, then removes the OpusModLoader folder (and this bat).
start "" /min cmd /c "timeout /t 3 /nobreak >nul & rd /s /q "%SELFDIR%""
echo A new window will close on its own once the installer folder is removed.
pause
