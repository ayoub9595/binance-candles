@echo off
rem 24/7 FVG order-block scanner — top 100 USDT pairs, 15m timeframe.
rem   Double-click to start. Ctrl+C to stop.
rem   Extra flags pass through: scan.bat --direction bullish --price-poll 5
rem Auto-restarts after 10s if the scanner ever crashes.
cd /d "%~dp0"

:loop
python -u scanner.py %*
if %errorlevel%==0 goto end
echo.
echo scanner exited with code %errorlevel% - restarting in 10s (Ctrl+C to stop)
timeout /t 10 /nobreak >nul
goto loop

:end
pause
