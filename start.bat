@echo off
setlocal

cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Please install Node.js, then run this file again.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-stable-services.ps1" -OpenBrowser
if errorlevel 1 (
  echo.
  echo Failed to start SanGuo Costume Archive.
  pause
  exit /b 1
)

echo.
echo SanGuo Costume Archive is starting:
echo http://127.0.0.1:5190/art_archive/
echo.
echo Logs are in: .archive-data\logs
timeout /t 3 >nul

endlocal
