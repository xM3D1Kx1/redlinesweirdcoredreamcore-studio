@echo off
chcp 65001 >nul
title DREZZDON Studio - local site
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

if not exist "pwa\drezzdon_studio.html" goto noproject

echo.
echo  Starting DREZZDON local site... keep this window open.
echo.
node "%~dp0serve.js"
set "CODE=%ERRORLEVEL%"
echo.
echo  Server stopped (exit code %CODE%).
if not "%CODE%"=="0" echo  Details: startup.log in this folder.
echo.
pause
exit /b 0

:nonode
echo.
echo  Node.js not found.
echo  Install LTS version from https://nodejs.org , then run this file again.
echo.
pause
exit /b 1

:noproject
echo.
echo  pwa\drezzdon_studio.html not found next to this file.
echo  Put serve.js and this .cmd into the project root folder.
echo.
pause
exit /b 1