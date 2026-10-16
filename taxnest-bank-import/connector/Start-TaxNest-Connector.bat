@echo off
title TaxNest Tally Connector
cd /d "%~dp0"
echo Starting TaxNest Tally Connector...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0TaxNest-Connector.ps1"
echo.
echo The connector has stopped. Press any key to close this window.
pause >nul
