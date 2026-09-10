#!/usr/bin/env bash
# 把 Web 构建产物同步到 main 分支并提交。
#
# 约定：master = 全部源码（APK + Web 共用）；main = 只放部署用的静态站点，
# 由本脚本从 master 的 app2/www 生成，不要手工编辑 main 上的文件。
#
#   sh scripts/publish-web.sh            # 构建 + 同步 + 提交（不推送）
#   sh scripts/publish-web.sh --push     # 再多一步 git push origin main
set -e
cd "$(dirname "$0")/.."
ROOT="$PWD"
WT="${PCB_WEB_WORKTREE:-/tmp/pcb-web}"
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

# ------------------------------------------------------- 2) main 的工作树
if git show-ref --verify --quiet refs/heads/main; then
  if [ -d "$WT/.git" ] || [ -f "$WT/.git" ]; then git worktree remove --force "$WT" >/dev/null 2>&1 || true; fi
  rm -rf "$WT"
  git worktree add --force --detach "$WT" main >/dev/null
  cd "$WT" && git checkout --quiet main
else
  rm -rf "$WT"
  git worktree add --force --detach "$WT" >/dev/null
  cd "$WT"
  git checkout --quiet --orphan main
fi

# ------------------------------------------------- 3) 同步站点（保留 Pages 配置）
# 保留：.github/（Pages workflow）、README.md、.nojekyll；其余按 app2/www 重建
find . -mindepth 1 -maxdepth 1 \
  ! -name .git ! -name .github ! -name README.md ! -name .nojekyll \
  -exec rm -rf {} +
cp -r "$ROOT/app2/www/." .
rm -f ui-demo.html js/ui-demo.js          # 开发用演示页不进部署分支
[ -f .nojekyll ] || : > .nojekyll

# ------------------------------------------------------------------ 4) 提交
git add -A
if git diff --cached --quiet; then
  echo "main 分支没有变化（产物与上次一致）"
else
  git commit --quiet -m "chore(web): 同步 Web 构建产物 $(date +%Y-%m-%d\ %H:%M)

- 由 master 的 scripts/publish-web.sh 生成，源提交 $(git -C "$ROOT" rev-parse --short HEAD)
- 静态站点：index.html + js/ + css/ + icons/ + manifest.webmanifest（不含开发用 ui-demo）
- app.js $(wc -c < js/app.js) bytes · style.css $(wc -c < css/style.css) bytes"
  echo "main 分支已提交：$(git log --oneline -1)"
fi
cd "$ROOT"

# ------------------------------------------------------------------ 5) 推送
if [ "$PUSH" = "1" ]; then
  git push origin main
fi
