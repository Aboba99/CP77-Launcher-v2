@echo off
chcp 65001 >nul
cd /d "%~dp0"
set CSC_IDENTITY_AUTO_DISCOVERY=false
call npm install
call npm run dist
echo.
echo Готово: установщик cp-77-v2-setup-2.0.0.exe лежит в папке dist
start "" dist
pause
