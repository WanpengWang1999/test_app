#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export NODE_ENV="${NODE_ENV:-production}"
export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-3001}"
export DATA_DIR="${DATA_DIR:-/data/telecom-photo}"
export PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://wangwanpeng.qzz.io}"
export ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-https://wangwanpeng.qzz.io,capacitor://localhost}"

if [ ! -f "dist/index.html" ]; then
  echo "dist/index.html not found. Run: npm run build"
  exit 1
fi

mkdir -p "$DATA_DIR"

echo "Starting cloud service"
echo "Local backend: http://${HOST}:${PORT}"
echo "Public URL: ${PUBLIC_BASE_URL}"
echo "Data dir: $DATA_DIR"
echo ""
echo "For web and Android App testing, open: ${PUBLIC_BASE_URL}"
echo "Do not expose port ${PORT} to the public internet in production."

node server/index.js
