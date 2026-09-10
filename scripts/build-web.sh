#!/usr/bin/env bash
# PixelCraft web bundle build (self-contained; no host pc2 required).
# Produces app2/www/js/app.js (IIFE bundle incl. react) and copies style.css.
#
# 默认压缩（--minify，体积约 1.2MB → 500KB 上下）。调试需要可读堆栈时用
#   MINIFY=0 sh scripts/build-web.sh
# 关掉即可；容器里出 APK 用的是同一份 app2/www 产物，所以线上与 APK 的 app.js 完全一致。
set -e
cd "$(dirname "$0")/.."
if [ ! -x node_modules/.bin/esbuild ]; then
  echo "missing node_modules — run: npm install" >&2
  exit 1
fi
MIN="--minify"
if [ "${MINIFY:-1}" = "0" ]; then
  MIN=""
  echo "MINIFY=0：本次不压缩（体积更大，便于调试）" >&2
fi
# shellcheck disable=SC2086
node_modules/.bin/esbuild src/main.tsx \
  --bundle --format=iife --platform=browser --target=es2019 \
  --define:process.env.NODE_ENV='"production"' \
  $MIN \
  --outfile=app2/www/js/app.js --log-level=info
cp src/ui/style.css app2/www/css/style.css
echo "web build OK -> app2/www/js/app.js ($(wc -c < app2/www/js/app.js) bytes, minify=${MINIFY:-1})"
