@echo off
rem Starts the app and opens it. Double-click, or run from a terminal.
setlocal enabledelayedexpansion
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found on this computer.
  echo.
  echo   This app needs Node 18 or newer. Install it and run this again:
  echo       winget install OpenJS.NodeJS.LTS
  echo   Or download it from https://nodejs.org/
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]"') do set NODE_MAJOR=%%v
if !NODE_MAJOR! LSS 18 (
  echo.
  echo   Node !NODE_MAJOR! is too old. This app needs Node 18 or newer.
  echo   Update it with: winget upgrade OpenJS.NodeJS.LTS
  echo.
  pause
  exit /b 1
)

rem Prefer 3000, but do not fail if something already holds it.
for /f "delims=" %%p in ('node scripts\free-port.js') do set APP_PORT=%%p

echo.
echo   AI Social Content Agent
echo   http://localhost:!APP_PORT!
echo.
echo   Press Ctrl+C to stop.
echo.

start "" "http://localhost:!APP_PORT!"
set PORT=!APP_PORT!
node src/server.js

echo.
echo   The server stopped.
pause