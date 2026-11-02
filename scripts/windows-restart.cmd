@echo off
rem WINDOWS RESTART: stops and restarts the "Email Assistant" scheduled task.
rem   windows-restart.cmd          restart the server
rem   windows-restart.cmd build    rebuild (npm run build) first, then restart
rem   windows-restart.cmd stop     stop it and leave it stopped
rem Ending the task only stops the hidden launcher (windows-start.vbs), not
rem node itself, so this also stops whatever is listening on PORT from .env.
setlocal
cd /d "%~dp0.."
set PORT=8787
for /f "tokens=1,* delims==" %%a in ('findstr /b "PORT=" .env 2^>nul') do set PORT=%%b

if /i "%~1"=="build" (
  echo Building...
  call npm run build || (echo Build failed, server left as it was. & exit /b 1)
)

echo Stopping the server...
schtasks /end /tn "Email Assistant" >nul 2>&1
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do taskkill /pid %%p /f >nul 2>&1
ping -n 3 127.0.0.1 >nul

if /i "%~1"=="stop" (echo Stopped. & exit /b 0)

echo Starting the server...
schtasks /run /tn "Email Assistant" >nul || (echo Could not start the "Email Assistant" task. & exit /b 1)
for /l %%i in (1,1,30) do (
  netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul && (echo Running. Log: data\server.log & exit /b 0)
  ping -n 2 127.0.0.1 >nul
)
echo Server did not start within 30 seconds. Check data\server.log
exit /b 1
