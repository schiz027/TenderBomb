@echo off
setlocal

cd /d "%~dp0"
set "PORT=8080"

echo.
echo TenderBomb server
echo =================
echo.
echo Open on this computer:
echo   http://localhost:%PORT%/
echo.
echo Share one of these LAN links with colleagues:
for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /C:"IPv4"') do (
  for /f "tokens=* delims= " %%B in ("%%A") do echo   http://%%B:%PORT%/
)
echo.
echo This launch serves the game and permanent leaderboards.
echo Nicknames are remembered by local IP.
echo Records are separated by difficulty:
echo   Express / Goszakaz / Importozameshchenie
echo.
echo Keep this window open while colleagues are playing.
echo Commands in this window:
echo   god ^<nick^>   - toggle tank god mode for this nick
echo   ungod ^<nick^> - disable tank god mode for this nick
echo   stealth       - move server to tray mode
echo   restart      - restart server and warn users
echo   exit / quit  - stop server
echo Press Ctrl+C to stop the server.
echo.

set "PYTHON_EXE="
for /f "delims=" %%P in ('dir /b /s "%LOCALAPPDATA%\Python\pythoncore-*\python.exe" 2^>nul') do set "PYTHON_EXE=%%P"
if not defined PYTHON_EXE if exist "%LOCALAPPDATA%\Python\bin\python.exe" set "PYTHON_EXE=%LOCALAPPDATA%\Python\bin\python.exe"

if defined PYTHON_EXE (
  "%PYTHON_EXE%" -u server.py %PORT%
) else (
  python -u server.py %PORT%
)

set "SERVER_EXIT=%ERRORLEVEL%"
if "%SERVER_EXIT%"=="77" exit /b 0

echo.
pause
