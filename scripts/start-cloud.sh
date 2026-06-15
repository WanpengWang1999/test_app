#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export NODE_ENV="${NODE_ENV:-production}"
export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-3001}"
export DATA_DIR="${DATA_DIR:-/data/telecom-photo}"

if [ -z "${PUBLIC_BASE_URL:-}" ]; then
  echo "PUBLIC_BASE_URL is not set. Example: export PUBLIC_BASE_URL=https://photo.example.com"
  echo "The service can still start, but App diagnostics will not show the cloud URL."
fi

if [ ! -f "dist/index.html" ]; then
  echo "dist/index.html not found. Run: npm run build"
  exit 1
fi

mkdir -p "$DATA_DIR"

echo "Starting cloud service"
echo "Local backend: http://${HOST}:${PORT}"
echo "Public URL: ${PUBLIC_BASE_URL:-not configured}"
echo "Data dir: $DATA_DIR"
echo ""
echo "For web testing, open: ${PUBLIC_BASE_URL:-http://server-ip-or-domain}"
echo "For Android App testing, set server address to: ${PUBLIC_BASE_URL:-http://server-ip-or-domain:3001}"

node server/index.js
