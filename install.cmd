@echo off
setlocal
rem One-click installer. Double-click this file, or run: install.cmd -DryRun
set "PS=powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1""
%PS% %*
set "RC=%ERRORLEVEL%"
echo.
rem Keep the window open only when double-clicked (cmdcmdline contains the script name)
echo %cmdcmdline% | find /i "%~nx0" >nul && pause
exit /b %RC%
