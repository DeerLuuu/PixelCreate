#!/data/data/com.dsharnessmobile.shell/files/usr/bin/bash
# PixelCraft engine regression tests (needs the pc2 typescript install)
set -e
cd "$(dirname "$0")/.."
rm -rf tests/.ts-out
node /data/data/com.dsharnessmobile.shell/files/home/pc2/node_modules/typescript/lib/tsc.js -p tests/tsconfig.json
node tests/.ts-out/tests/run-tests.js