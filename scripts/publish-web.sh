#!/usr/bin/env bash
# 把 Web 构建产物同步到 main 分支（main = 只放部署用的静态站点）。
#
# 约定：master = 全部源码（APK + Web 共用）；main = 部署分支，内容由本脚本生成。
# 生成 main 时用「临时索引 + commit-tree」的 plumbing 方式，不切分支、不碰工作区，
# 也不用 git worktree（仓库在 FUSE 路径上时 worktree add 会卡住）。
#
#   sh scripts/publish-web.sh            # 构建 + 生成 main 的新提交（不推送）
#   sh scripts/publish-web.sh --push     # 再多一步 git push origin main
set -e
cd "$(dirname "$0")/.."
ROOT="$PWD"
STAGE="${PCB_WEB_STAGE:-/tmp/pcb-web-stage}"
IDX="${PCB_WEB_INDEX:-/tmp/pcb-web-index}"
PUSH=0
[ "$1" = "--push" ] && PUSH=1

# ------------------------------------------------------------------ 1) 构建
if [ -x node_modules/.bin/esbuild ]; then
  sh scripts/build-web.sh
else
  echo "提示：仓库内没有 node_modules，跳过构建，直接使用 app2/www 里现成的产物" >&2
fi
for f in app2/www/index.html app2/www/js/app.js app2/www/css/style.css; do
  [ -f "$f" ] || { echo "缺少 $f —— 请先在能构建的环境里跑一次 npm run build" >&2; exit 1; }
done

# --------------------------------------------- 2) 组装 main 的目录内容
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -r app2/www/. "$STAGE/"
rm -f "$STAGE/ui-demo.html" "$STAGE/js/ui-demo.js"      # 开发用演示页不进部署分支
mkdir -p "$STAGE/.github/workflows"
cp web/pages.yml "$STAGE/.github/workflows/pages.yml"
cp web/README.md "$STAGE/README.md"
cp web/.nojekyll "$STAGE/.nojekyll"

# ------------------- 2b) 给资源加「版本-内容指纹」后缀，绕过 Pages 的缓存
# GitHub Pages 对 html/js/css 一律发 Cache-Control: max-age=600，而 index.html 里
# 引用的是固定文件名，所以发新版后的 10 分钟内浏览器还在跑旧代码（用户会以为没更新）。
# 这里把 index.html 里的资源地址改写成 app.js?v=<版本>-<md5前8位>：
# 内容没变 -> 地址不变（下面的「无变化」检查仍然有效）；内容变了 -> 地址立刻变，
# 浏览器必定重新下载。只改部署分支的副本，仓库里的 app2/www 与 APK 保持原样
# （APK 走 file://，带查询串可能影响 WebView 取本地文件）。
VER="$(sed -n 's/.*APP_VERSION = "\([0-9.]*\)".*/\1/p' src/ui/changelog.tsx | head -1)"
HASH="$(md5sum "$STAGE/js/app.js" | cut -c1-8)"
CSSHASH="$(md5sum "$STAGE/css/style.css" | cut -c1-8)"
[ -n "$VER" ] || VER="0"
PCB_VER="$VER" PCB_JS="$HASH" PCB_CSS="$CSSHASH" python3 - "$STAGE/index.html" <<'PY'
import os, sys
path = sys.argv[1]
v = os.environ["PCB_VER"]
js = os.environ["PCB_JS"]
css = os.environ["PCB_CSS"]
s = open(path, encoding="utf-8").read()
for f, tag in (("js/app.js", js), ("js/telemetry.js", js), ("js/lib/omggif.js", js), ("css/style.css", css)):
    s = s.replace('"' + f + '"', '"' + f + "?v=" + v + "-" + tag + '"')
open(path, "w", encoding="utf-8").write(s)
PY
echo "资源指纹：app.js?v=$VER-$HASH  style.css?v=$VER-$CSSHASH"

# ------------------------------------- 3) 用临时索引写成一次提交（不动工作区）
rm -f "$IDX"
GIT_DIR="$ROOT/.git" GIT_WORK_TREE="$STAGE" GIT_INDEX_FILE="$IDX" git add -A -f
TREE="$(GIT_DIR="$ROOT/.git" GIT_INDEX_FILE="$IDX" git write-tree)"
SRC="$(git rev-parse --short HEAD)"
MSG="chore(web): 同步 Web 构建产物（源提交 $SRC）

- 由 master 的 scripts/publish-web.sh 生成，源提交 $SRC
- 静态站点：index.html + js/ + css/ + icons/ + manifest.webmanifest（不含开发用 ui-demo）
- index.html 里的资源带 ?v=<版本>-<内容指纹>，绕开 Pages 的 10 分钟缓存
- app.js $(wc -c < "$STAGE/js/app.js") bytes · style.css $(wc -c < "$STAGE/css/style.css") bytes"
OLD="$(git rev-parse --verify --quiet refs/heads/main || true)"
if [ -n "$OLD" ]; then
  NEW="$(git commit-tree "$TREE" -p "$OLD" -m "$MSG")"
  if [ "$OLD" = "$(git rev-parse --verify --quiet refs/heads/main)" ] && [ "$(git diff-tree --no-commit-id --name-only -r "$OLD" "$NEW" | wc -l)" = "0" ]; then
    echo "main 分支内容无变化（产物与上次一致）"
    exit 0
  fi
else
  NEW="$(git commit-tree "$TREE" -m "$MSG")"
fi
git update-ref refs/heads/main "$NEW" ${OLD:+"$OLD"}
echo "main 已更新："
git --no-pager log --oneline -1 main
git --no-pager show --stat --oneline main | head -20

# ------------------------------------------------------------------ 4) 推送
if [ "$PUSH" = "1" ]; then
  git push origin main
fi
