#!/usr/bin/env bash
# 把 main（部署分支）上的构建产物取回 app2/www —— 本地不用自己构建，也能和线上 / APK 用同一份包。
#
# 背景（见 AGENTS.md §5.1b）：master = 全部源码，但构建产物（app2/www/js/app.js、
# app2/www/css/style.css）在 master 被 .gitignore 忽略，由 scripts/publish-web.sh 提交到 main。
# 所以 `git pull` 之后本地产物可能还是旧的，用本脚本一条命令对齐：
#
#   sh scripts/sync-web.sh              # 取回产物（先 git fetch origin main）
#   sh scripts/sync-web.sh --check      # 只比较不写入；不一致时退出码 1（可放进 CI / 前置检查）
#   sh scripts/sync-web.sh --rev HEAD   # 换来源 ref（默认 origin/main）
#   sh scripts/sync-web.sh --no-fetch   # 不联网，直接用本地已有的 origin/main
#
# 产物字节与部署分支完全一致，所以 md5 可以直接拿来和线上 CDN 对（见 AGENTS.md §6.6）。
set -e
cd "$(dirname "$0")/.."

REV=origin/main
CHECK=0
FETCH=1
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1 ;;
    --rev) shift; REV="${1:?--rev 后面要跟一个 ref}" ;;
    --no-fetch) FETCH=0 ;;
    -h|--help) awk 'NR==1{next} /^#/{print; next} {exit}' "$0"; exit 0 ;;
    *) echo "未知参数：$1（可用 --check / --rev <ref> / --no-fetch）" >&2; exit 2 ;;
  esac
  shift
done

# /bin/sh 在本项目是 dash：不用 bash 的 ${var:0:8}，统一走 cut（与 publish-web.sh 同口径）
short() { printf '%s' "$1" | cut -c1-8; }

if [ "$FETCH" = "1" ]; then
  git fetch origin main --quiet
fi

# 本地路径:部署分支里的路径（部署根 = app2/www 的内容）
PAIRS="app2/www/js/app.js:js/app.js app2/www/css/style.css:css/style.css"

changed=0
for pair in $PAIRS; do
  local_path="${pair%%:*}"
  remote_path="${pair#*:}"
  remote_md5="$(git show "$REV:$remote_path" 2>/dev/null | md5sum | cut -d' ' -f1)"
  if [ -z "$remote_md5" ]; then
    echo "在 $REV 里找不到 $remote_path —— 确认分支名（部署分支是 main）" >&2
    exit 1
  fi
  if [ -f "$local_path" ]; then
    local_md5="$(md5sum "$local_path" | cut -d' ' -f1)"
  else
    local_md5="(缺失)"
  fi
  # 产物正常应当在 .gitignore 里；真被 master 跟踪了就先说一声，免得顺手改脏工作区
  if git ls-files --error-unmatch "$local_path" >/dev/null 2>&1; then
    echo "警告：$local_path 已被 master 跟踪，同步会改动工作区（见 AGENTS.md §5.1b）" >&2
  fi
  if [ "$local_md5" = "$remote_md5" ]; then
    printf '  %-24s %s  已是最新\n' "$local_path" "$(short "$remote_md5")"
    continue
  fi
  changed=1
  if [ "$CHECK" = "1" ]; then
    printf '  %-24s 本地 %s ≠ 部署分支 %s  需要同步\n' "$local_path" "$(short "$local_md5")" "$(short "$remote_md5")"
    continue
  fi
  tmp="$(mktemp)"
  git show "$REV:$remote_path" > "$tmp"
  mv "$tmp" "$local_path"
  printf '  %-24s %s → %s  已写入\n' "$local_path" "$(short "$local_md5")" "$(short "$remote_md5")"
done

echo
echo "来源：$REV  $(git log -1 --format=%s "$REV")"

# 顺带对齐版本号：产物是「源码构建出来的」，如果两者版本不同，说明源码比线上新
SRC_VER="$(sed -n 's/.*APP_VERSION = "\([0-9.]*\)".*/\1/p' src/ui/changelog.tsx | head -1)"
if [ -n "$SRC_VER" ] && [ -f app2/www/js/app.js ]; then
  if grep -qa "$SRC_VER" app2/www/js/app.js; then
    echo "版本：产物内含 $SRC_VER，与当前源码一致"
  else
    echo "提示：本地产物里没有当前源码的版本号 $SRC_VER —— 产物比源码旧（本地构建 + scripts/publish-web.sh 发布后才会一致）" >&2
  fi
fi

if [ "$CHECK" = "1" ] && [ "$changed" = "1" ]; then
  echo "产物不是最新（--check 模式不写入）" >&2
  exit 1
fi
exit 0
