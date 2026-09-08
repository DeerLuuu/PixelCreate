#!/usr/bin/env bash
# PixelCraft web bundle build (self-contained; no host pc2 required).
# Produces app2/www/js/app.js (IIFE bundle incl. react) and copies style.css.
set -e
cd "$(dirname "$0")/.."
if [ ! -x node_modules/.bin/esbuild ]; then
  echo "missing node_modules — run: npm install" >&2
  exit 1
fi
node_modules/.bin/esbuild src/main.tsx \
  --bundle --format=iife --platform=browser --target=es2019 \
  --define:process.env.NODE_ENV='"production"' \
  --outfile=app2/www/js/app.js --log-level=info
cp src/ui/style.css app2/www/css/style.css
echo "web build OK -> app2/www/js/app.js ($(wc -c < app2/www/js/app.js) bytes)"
