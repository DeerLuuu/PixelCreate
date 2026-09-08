#!/usr/bin/env bash
# PixelCraft engine regression tests (self-contained tsc; no host pc2 required).
set -e
cd "$(dirname "$0")/.."
if [ ! -f node_modules/typescript/bin/tsc.js ]; then
  echo "missing node_modules — run: npm install" >&2
  exit 1
fi
rm -rf tests/.ts-out
node node_modules/typescript/bin/tsc.js -p tests/tsconfig.json
node tests/.ts-out/tests/run-tests.js
