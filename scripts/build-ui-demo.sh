#!/usr/bin/env bash
# PixelCraft UI-kit demo page build (docs/UI.md §6).
#
# Bundles src/ui/kit/demo.tsx into app2/www/js/ui-demo.js and writes
# app2/www/ui-demo.html, which links the app stylesheet and inlines the icon
# sprite taken from index.html. Both outputs are gitignored build artefacts.
#
#   sh scripts/build-ui-demo.sh
#   node toolchain/devserver.js          # then open /ui-demo.html
set -e
cd "$(dirname "$0")/.."
if [ ! -x node_modules/.bin/esbuild ]; then
  echo "missing node_modules — run: npm install" >&2
  exit 1
fi
node_modules/.bin/esbuild src/ui/kit/demo.tsx \
  --bundle --format=iife --platform=browser --target=es2019 \
  --define:process.env.NODE_ENV='"development"' \
  --outfile=app2/www/js/ui-demo.js --log-level=info
cp src/ui/style.css app2/www/css/style.css

# the demo renders the same icons as the app: reuse the sprite from index.html
python3 - <<'PY'
import re
src = open("app2/www/index.html", encoding="utf-8").read()
m = re.search(r'<svg width="0"[\s\S]*?</svg>', src)
sprite = m.group(0) if m else ""
html = """<!DOCTYPE html>
<html lang="zh-CN" data-theme="">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>PixelCraft UI Kit</title>
<link rel="stylesheet" href="css/style.css">
<style>body{overflow:auto;padding:16px}#root{height:auto}.demo-sec{margin:0 0 20px}
.demo-h{font-weight:800;font-size:15px;margin:14px 0 8px;color:var(--text)}
.demo-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px}</style>
</head>
<body>
__SPRITE__
<div id="root"></div>
<script src="js/ui-demo.js"></script>
</body>
</html>
"""
open("app2/www/ui-demo.html", "w", encoding="utf-8").write(html.replace("__SPRITE__", sprite))
print("demo html OK -> app2/www/ui-demo.html (%d bytes sprite)" % len(sprite))
PY
echo "demo build OK -> app2/www/js/ui-demo.js ($(wc -c < app2/www/js/ui-demo.js) bytes)"
