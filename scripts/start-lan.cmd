@echo off
setlocal
cd /d "%~dp0.."

set "API_PORT=3001"
set "WEB_PORT=5173"
set "HOST=0.0.0.0"
set "PORT=%API_PORT%"
set "DATA_DIR=server/data"
set "VITE_DEV_API_TARGET=http://127.0.0.1:%API_PORT%"

set "LAN_IP="
for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /C:"IPv4"') do (
  for /f "tokens=1" %%B in ("%%A") do (
    if not "%%B"=="127.0.0.1" (
      if not "%%B"=="" (
        set "LAN_IP=%%B"
        goto :found_ip
      )
    )
  )
)

:found_ip
if "%LAN_IP%"=="" set "LAN_IP=YOUR_PC_LAN_IP"

echo.
echo LAN dev server will start in two windows.
echo PC local URL: http://localhost:%WEB_PORT%
echo Phone/LAN URL: http://%LAN_IP%:%WEB_PORT%
echo API URL: http://%LAN_IP%:%API_PORT%
echo Android App server URL: http://%LAN_IP%:%API_PORT%
echo.
echo Important:
echo - Do not use localhost on the phone. Use the Phone/LAN URL above.
echo - In the Android App login page, set the server URL to the Android App server URL above.
echo - If the phone cannot open it, allow Node.js through Windows Firewall.
echo - Keep both opened command windows running while testing.
echo.

start "telecom-photo-api" cmd /k "set HOST=%HOST%&& set PORT=%API_PORT%&& set DATA_DIR=%DATA_DIR%&& npm.cmd run server:dev"
start "telecom-photo-web" cmd /k "set VITE_DEV_API_TARGET=%VITE_DEV_API_TARGET%&& npm.cmd run client:dev"

pause
