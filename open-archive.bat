@echo off
setlocal

set "APP_DIR=%~dp0"
set "APP_URL=http://127.0.0.1:5190"

cd /d "%APP_DIR%"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$client = New-Object Net.Sockets.TcpClient; try { $client.Connect('127.0.0.1', 5190); exit 0 } catch { exit 1 } finally { if ($client) { $client.Close() } }" >nul 2>nul

if errorlevel 1 (
  echo Starting SanGuo Costume Archive...
  start "SanGuo Costume Archive Server" cmd /k "cd /d ""%APP_DIR%"" && npm run dev:stable"
  timeout /t 4 /nobreak >nul
) else (
  echo SanGuo Costume Archive is already running.
)

start "" "%APP_URL%"
