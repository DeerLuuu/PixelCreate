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

# 产物自检：把打好的包装进最小 DOM 桩里跑一遍。esbuild 是按「源文件往上最近的
# tsconfig.json」决定 JSX 变换的，一旦我在临时构建目录里留下别的 tsconfig.json，
# 就会打出引用全局 React 的包：构建成功、体积正常、页面白屏。见 toolchain/check-bundle.mjs
if node toolchain/check-bundle.mjs app2/www/js/app.js; then
  :
else
  code=$?
  if [ "$code" = "1" ]; then
    echo "产物自检失败：这个包不能在浏览器里运行，已中止" >&2
    exit 1
  fi
  echo "提示：产物自检返回 $code（可能只是 DOM 桩不够，请人工确认）" >&2
fi
echo "web build OK -> app2/www/js/app.js ($(wc -c < app2/www/js/app.js) bytes, minify=${MINIFY:-1})"
