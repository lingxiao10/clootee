@echo off
chcp 65001 >nul
setlocal
title claude-hub

REM ============================================================================
REM  claude-hub launcher (Windows)
REM    1) resolve Node (bundled portable -> system 18+ -> auto-download)
REM    2) preflight: install/repair dependencies + rebuild backend\dist if stale
REM       (same engine as install.bat - see backend\scripts\setup.js)
REM    3) if port 8970 is taken, run stop.bat automatically to free it, then go on
REM    4) run the COMPILED backend (dist) - TypeScript is only needed at build time
REM ============================================================================

set "ROOT=%~dp0"
set "HUB=%ROOT%projects\claude_hub"
set "PORT=8970"

call "%ROOT%scripts\node-env.bat"
if errorlevel 1 goto :fail

REM ---------------------------------------------------------------------------
REM  Preflight. Exit codes: 0 = ready (dist)  2 = degraded (run from source)  1 = broken
REM ---------------------------------------------------------------------------
"%NODE_EXE%" "%HUB%\backend\scripts\setup.js" --quiet
set "SETUP=%ERRORLEVEL%"
if "%SETUP%"=="1" goto :setupfail
set "USE_TSNODE="
if "%SETUP%"=="2" set "USE_TSNODE=1"

REM ---------------------------------------------------------------------------
REM  Port check: if the port is taken, run stop.bat to free it, then carry on.
REM  Only give up (with the window kept open) if it is STILL taken afterwards.
REM ---------------------------------------------------------------------------
call :checkport
if not defined PORTPID goto :portfree

echo.
echo [warn] Port %PORT% is already in use ^(PID %PORTPID%^) - running stop.bat to free it ...
echo.
call "%ROOT%stop.bat" --no-pause
echo.
call :checkport
if defined PORTPID goto :portbusy
echo     [OK] port %PORT% is free now, continuing startup

:portfree
cd /d "%HUB%\backend"

echo.
echo ==^> Starting claude-hub on http://localhost:%PORT%
echo ==^> Your browser opens automatically once the server is listening
echo ==^> First run walks you through: set password -^> pick engine -^> pick model provider

REM Open the browser only after the port really accepts connections
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 120;$i++){try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('127.0.0.1',%PORT%);$c.Close();Start-Process 'http://localhost:%PORT%';break}catch{Start-Sleep -Milliseconds 500}}"

if defined USE_TSNODE goto :runsource
"%NODE_EXE%" dist\index.js
goto :stopped

:runsource
echo [warn] running from source via ts-node (the compiled build was not usable)
"%NODE_EXE%" node_modules\ts-node\dist\bin.js src\index.ts

:stopped
set "EXITCODE=%ERRORLEVEL%"
echo.
if not "%EXITCODE%"=="0" (
  echo [ERROR] Server exited abnormally, exit code = %EXITCODE%
  echo         The log above shows the reason. Do not close this window yet.
) else (
  echo ==^> Server stopped
)
pause
exit /b %EXITCODE%

:portbusy
echo.
echo [ERROR] Port %PORT% is STILL in use after running stop.bat.
echo         Offending process PID = %PORTPID%
for /f "tokens=1,2 delims=," %%a in ('tasklist /fi "PID eq %PORTPID%" /fo csv /nh 2^>nul') do echo         image = %%~a
echo.
echo         Something is respawning it, or the kill needs more rights:
echo           1^) close any other open start.bat window
echo           2^) check pm2:  pm2 list   ^(then: pm2 delete claude-hub ^&^& pm2 save --force^)
echo           3^) or kill it manually from an admin prompt: taskkill /F /PID %PORTPID%
echo.
pause
exit /b 1

:setupfail
echo.
echo [ERROR] Preflight failed - the app is not ready to start.
echo         Run install.bat in this folder for a full install with detailed output.
pause
exit /b 1

:fail
echo.
echo [ERROR] Could not prepare a Node.js runtime - see the message above.
pause
exit /b 1

REM ---------------------------------------------------------------------------
REM  :checkport - sets PORTPID to the first PID listening on %PORT%, or clears it
REM ---------------------------------------------------------------------------
:checkport
set "PORTPID="
for /f "tokens=5" %%p in ('netstat -ano -p TCP ^| findstr /R /C:"LISTENING" ^| findstr /C:":%PORT% "') do (
  if not defined PORTPID if not "%%p"=="0" set "PORTPID=%%p"
)
exit /b 0
