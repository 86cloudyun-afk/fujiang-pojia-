@echo off
setlocal
cd /d "%~dp0"
echo ================================================
echo   dsh-prompt-custom installer
echo   Close DeepSeek Harness first (tray icon - Exit),
echo   then run this file again.
echo ================================================
echo.
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0install.ps1" %*
set "rc=%ERRORLEVEL%"
echo.
pause
exit /b %rc%