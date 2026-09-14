@echo off
REM ---------------------------------------------------------------
REM  SINGULARITY - play in your browser without installing anything.
REM
REM  Serves www/ over http://localhost:8000 instead of opening the
REM  file directly. Some browsers refuse localStorage and service
REM  workers on file:// origins, which is the usual cause of a
REM  black screen when you double-click index.html.
REM ---------------------------------------------------------------
cd /d "%~dp0www"

where python >nul 2>nul
if %errorlevel%==0 goto runpython

where py >nul 2>nul
if %errorlevel%==0 goto runpy

echo Python was not found on your PATH.
echo Either install Python, or open www\index.html directly in Chrome.
echo.
pause
exit /b

:runpython
start "" http://localhost:8000
python -m http.server 8000
goto end

:runpy
start "" http://localhost:8000
py -3 -m http.server 8000

:end
