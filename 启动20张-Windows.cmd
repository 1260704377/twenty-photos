@echo off
cd /d "%~dp0"
where npm >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24 LTS, then run this launcher again.
  pause
  exit /b 1
)
if not exist node_modules\electron (
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
call npm start
if errorlevel 1 pause
