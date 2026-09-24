@echo off
setlocal
chcp 1251 > nul

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
echo   exit / quit / stop - stop server
echo Press Ctrl+C to stop the server.
echo.

:: --- Find Python ---
set "PYTHON_EXE="

:: 1. Try the 'py.exe' launcher first, it's the most reliable
where py.exe >nul 2>nul
if %ERRORLEVEL% == 0 (
    set "PYTHON_EXE=py -3"
)

:: 2. If not found, search common installation paths
if not defined PYTHON_EXE (
    for /f "delims=" %%P in ('dir /b /s "%ProgramFiles%\Python*\python.exe" "%LOCALAPPDATA%\Programs\Python\python-*\python.exe" 2^>nul') do (
        if not defined PYTHON_EXE set "PYTHON_EXE=%%P"
    )
)

:: 3. Fallback to just 'python' in PATH
if not defined PYTHON_EXE set "PYTHON_EXE=python"

echo Using: %PYTHON_EXE%
%PYTHON_EXE% -u server.py %PORT%

set "SERVER_EXIT=%ERRORLEVEL%"
if "%SERVER_EXIT%"=="77" exit /b 0

echo.
pause
