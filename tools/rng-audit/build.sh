#!/usr/bin/env bash
# Builds ROB-RUN-RNG-Audit.exe (Windows x64) from any OS with Go 1.24+.
set -euo pipefail
cd "$(dirname "$0")"
cp ../../ROB-RUN-RNG-Audit.html index.html
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-H windowsgui -s -w" -o ROB-RUN-RNG-Audit.exe .
echo "Built $(pwd)/ROB-RUN-RNG-Audit.exe"
