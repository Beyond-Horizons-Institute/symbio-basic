#!/usr/bin/env bash
# Symbio Basic — Launcher
# Starts Symbio with your companion configuration.
set -e
cd "$(dirname "$0")"
echo "🤝 Starting Symbio Basic..."
npx electron-forge start