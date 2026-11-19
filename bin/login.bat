@echo off
setlocal
set "LOGINJS=%~dp0login.js"

set "NODEexe="
where node >nul 2>&1 && set "NODEexe=node"
if not defined NODEexe if exist "%ProgramFiles%\nodejs\node.exe" set "NODEexe=%ProgramFiles%\nodejs\node.exe"
if not defined NODEexe if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODEexe=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODEexe (
  echo Node.js not found. Install it from https://nodejs.org  ^(needs 22 or newer^).
  pause
  exit /b 1
)

if not exist "%LOGINJS%" (
  echo login.js not found next to this file.
  pause
  exit /b 1
)

echo Opening the Doubao sign-in page...
echo Scan the QR with the DOUYIN app ^(not the Doubao app^).
echo.
"%NODEexe%" "%LOGINJS%" %*
echo.
pause
endlocal
