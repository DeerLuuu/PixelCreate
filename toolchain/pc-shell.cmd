@echo off
rem PixelCraft PC desktop shell - Windows double-click entry point.
rem Runs pc-shell.mjs (next to this file) with Node and forwards every argument,
rem e.g.  pc-shell.cmd --port 8790 --no-open
rem
rem This file is deliberately ASCII-only: cmd.exe re-reads a .bat/.cmd by byte offset
rem while executing it, so mixing a codepage switch (chcp 65001 below) with non-ASCII
rem text makes cmd execute fragments of the file ("'ASCII' is not recognized ...").
rem The codepage switch is still needed - Node prints the shell banner as UTF-8 Chinese.
chcp 65001 >nul
setlocal
set "DIR=%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [pc-shell] Node.js not found. Install it from https://nodejs.org and retry.
  pause
  exit /b 1
)

echo [pc-shell] node "%DIR%pc-shell.mjs" %*
node "%DIR%pc-shell.mjs" %*
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" (
  echo.
  echo [pc-shell] exited with code %CODE% - see the messages above.
  pause
)
endlocal
