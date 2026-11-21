@echo off
setlocal
rem One-click uninstaller. Double-click, or run: uninstall.cmd -Purge
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
set "RC=%ERRORLEVEL%"
echo.
echo %cmdcmdline% | find /i "%~nx0" >nul && pause
exit /b %RC%
