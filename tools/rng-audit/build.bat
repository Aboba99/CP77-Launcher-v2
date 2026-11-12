@echo off
rem Builds ROB-RUN-RNG-Audit.exe on Windows. Requires Go 1.24+ (https://go.dev/dl/).
cd /d "%~dp0"
copy /y ..\..\ROB-RUN-RNG-Audit.html index.html >nul
go build -trimpath -ldflags "-H windowsgui -s -w" -o ROB-RUN-RNG-Audit.exe . || exit /b 1
echo Built %~dp0ROB-RUN-RNG-Audit.exe
