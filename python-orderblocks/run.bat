@echo off
rem FVG-based order block detector (Binance 15m).
rem   Double-click        -> BTCUSDT, 15m, last 1000 candles
rem   run.bat ETHUSDT     -> another symbol
rem   run.bat BTCUSDT --direction bullish --fresh-only
cd /d "%~dp0"

if "%~1"=="" (
    python main.py BTCUSDT
) else (
    python main.py %*
)

echo.
pause
