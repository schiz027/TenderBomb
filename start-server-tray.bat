@echo off
setlocal
chcp 65001 > nul

cd /d "%~dp0"
start "TenderBomb Tray" powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$scriptContent = Get-Content -LiteralPath 'server-tray.ps1' -Raw -Encoding UTF8; Invoke-Expression $scriptContent"
