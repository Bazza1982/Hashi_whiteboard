@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -NonInteractive -Command "if (Get-Service -Name 'HashiWhiteboard' -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if not errorlevel 1 goto managed
if not exist node_modules\vite\package.json (
  call npm install
  if errorlevel 1 goto failed
)
if not exist dist\index.html (
  call npm run build
  if errorlevel 1 goto failed
)
call npm start
if errorlevel 1 goto failed
exit /b 0
:managed
powershell.exe -NoProfile -NonInteractive -File "%~dp0scripts\service.ps1" -Action Start
if errorlevel 1 goto failed
exit /b 0
:failed
echo Whiteboard did not start. Check the message above. Node.js 24+ is required.
pause
exit /b 1
