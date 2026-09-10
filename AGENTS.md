# AGENTS.md

> 给 AI 编码代理 / 后续会话的**唯一约定来源**。动手前先读本文件；改完按 §5.5 提交。
> 面向用户的功能说明 → [`README.md`](README.md)；模块接口 → [`docs/API.md`](docs/API.md)；竞品对比 → [`docs/COMPARISON.md`](docs/COMPARISON.md)。

---

## 1. 项目速览

| 项 | 内容 |
|---|---|
| 名称 | PixelCraft 像素工坊 |
| 一句话 | 自研 Android 像素画编辑器（APK + PWA 同一套代码） |
| 技术栈 | TypeScript + React 18 + Canvas 2D，无额外运行时框架 |
| 源码 | `src/`（入口 `src/main.tsx`），测试 `tests/` |
| Web 产物 | `app2/www/js/app.js` + `app2/www/css/style.css`（esbuild IIFE） |
| APK 产物 | `/sdcard/Download/PixelCraft-<版本号>.apk` 与 `build/PixelCraft.apk` |
| 当前版本 | `1.0.8.1`（以 `src/ui/changelog.tsx` 的 `APP_VERSION` 为准） |
| 仓库根 | `/sdcard/Download/ds文件夹/pixelcraft`（= `/storage/emulated/0/Download/ds文件夹/pixelcraft`） |

目录：

```
src/app/       Session、设置注册表、引导注册表、手势映射、历史编解码
src/engine/    文档模型、历史栈、像素操作、调色/对称/导出编码
src/render/    视口、合成器、脏矩形、洋葱皮
src/tools/     工具注册表、笔迹、选区变换
src/io/        原生桥接、工程文件、自动保存、参考图、安全区、base64
src/ui/        React 外壳、弹窗、时间线、浮动球、i18n、样式
android/       MainActivity（Java 层）+ AndroidManifest
tests/         无 DOM 的引擎/逻辑回归（约 520 条断言）
docs/          API.md / COMPARISON.md
```

---

## 2. 环境与依赖

- **仓库内**：`package.json` + `tsconfig.json` + `scripts/`；`npm install` 后可用 `scripts/build-web.sh`、`scripts/run-tests.sh`。
- **容器内（实际出包环境）**：`node_modules` 在 `/root/pcbuild`（FUSE 上装不上时在容器私有区安装后回拷）；同步目录 `/root/pcbuild/app/src`、`/root/pcbuild/app/tests`。
- `aapt2` 在本容器是 Android/x86 二进制、**跑不起来**，所以打包走「`javac` + `d8` → 往模板 APK 里塞」的路线（见 §6）。
- 浏览器调试：`node toolchain/devserver.js`（`app2/www`，端口 8090；`app2/www/js/telemetry.js` 会把错误与布局信息 POST 到 `/log`）。
- `toolchain/` 只保留自写脚本（`devserver.js`、`make-icon.js`，后者用 `node toolchain/make-icon.js <outdir>` 重新生成启动图标）；SDK 下载物已清理。
- 大改动可用 git 回滚（仓库已有 90+ 提交）。

---

## 3. 常用命令

```sh
# 同步源码（增量覆盖，不要 rm -rf；见 §5.4）
cp -r src/. /root/pcbuild/app/src/ && cp -r tests/. /root/pcbuild/app/tests/

# 类型检查（noUnusedLocals 已开）
cd /root/pcbuild && ./node_modules/.bin/tsc -p tsconfig.json --noEmit

# 测试（期望最后一行 ALL PASS）
cd /root/pcbuild/app/tests && ../../node_modules/.bin/tsc -p tsconfig.json && node .ts-out/tests/run-tests.js

# 重建 Web 包（仓库路径含中文，必须在 ASCII 目录构建后回拷；见 §6.4）
cd /root/pcbuild/buildsrc && cp -r /root/pcbuild/app/src/. . \
  && ../node_modules/.bin/esbuild main.tsx --bundle --format=iife --platform=browser --target=es2019 \
     --define:process.env.NODE_ENV='"production"' --outfile=out-app.js --log-level=warning \
  && cp out-app.js "<repo>/app2/www/js/app.js" && cp ui/style.css "<repo>/app2/www/css/style.css"

# 出包（重打包 + 签名 + 校验 + 拷贝）
sh /root/pk/make-apk.sh <版本号> <versionCode>

# 交付前复核
python3 /root/pk/verify-apk.py /sdcard/Download/PixelCraft-<版本号>.apk "<repo>/app2/www/js/app.js"
java -jar /root/pk/apksigner.jar verify --print-certs /sdcard/Download/PixelCraft-<版本号>.apk
```

---

## 4. 架构要点

**核心**
- `Session` 单例（`src/app/session.ts`）：持有 doc / history / prefs / 工具状态，`changed()` 驱动 React（`useSyncExternalStore`）；UI 状态改动都走它。
- `History`（`src/engine/history.ts`）：`record`（廉价逆向）/ `pushPixels`（像素差分）/ `pushStruct`（全档快照，复杂操作）；`undo/redo/jumpTo`；`histMode` = `steps`（默认 60 条）/ `full`（完整回放）。工程文件可内嵌历史（`src/io/historyfile.ts` + `src/app/history-io.ts`）。
- 渲染增量：`Stroke.takeDirty()` → `composeRectInto` → 视口脏矩形 blit；`Session.repaint()` 由 rAF 合并，`repaintRect(rect)` 只更新局部；洋葱皮 / 选区着色都有缓存版本号。

**工具与手势**
- `View`（`src/render/view.ts`）接管画布手势：画布边距双击 = undo、双指双击 = redo、三击 = 2× 放大；手势 → 动作映射在 `src/app/gestures.ts`，设置里可改。
- 震动统一走 `Session.hapticTick(tag, scale)`（受 `gesture.haptic` 开关与 `prefs.hapticLen` 控制）。
- 形状：统一栅格 inside+border（实心/空心），Zingl 椭圆，笔刷 `brushStamp` 镜像对称（Aseprite 移植）。

**UI**
- 浮动球 `FloatingTools`：主球 / 选区球 / 取色球（扇形）/ 魔法球，多球互斥 68px，dock 停靠持久化。
- 调色板**唯一数据源** `src/data/palettes.ts`（`PALETTE_PACKS` + `defaultPalette`），勿在别处复制色表。
- 横屏 ≥768px 走侧栏 grid；`src/ui/style.css` 的 `--sat/--sab/--sal/--sar` 是安全区变量（由 `src/io/safearea.ts` 写入）。
- i18n 中英同文件 `src/ui/i18n.ts`：**每个键 zh/en 各一条**；删键前先 grep。

---

## 5. 工程约定（必须遵守）

### 5.1 版本号
- `1.0.x` 的**第三段由用户决定**，不要自行递增。
- 小改动只递增第四段（`1.0.7.9 → 1.0.7.10`），且**只在用户要求出包时才改**；`versionCode` 每次出包 +1。
- `android/AndroidManifest.xml` 的 `versionName` 与 `src/ui/changelog.tsx` 的 `APP_VERSION` **必须一致**，并同步加一条中英双语更新日志。

### 5.2 声明式优先
- 设置项写进 `src/app/settings.ts`（一条声明 + i18n 文案），设置界面自动生成；
- 引导步骤写进 `src/app/guide.ts`；手势映射写进 `src/app/gestures.ts`；
- 新增功能优先「加一条声明」，不要在 UI 里硬编码分支。

### 5.3 文档同步
- 改了对外 API / 新功能 → 更新 `docs/API.md`（接口签名）与 `README.md`（功能表）；`docs/COMPARISON.md` 的「最新进展」表一并刷新。

### 5.4 测试副本与输出
- 容器里的 `/root/pcbuild/app/src`、`app/tests` 用 `cp -r <repo>/src/. app/src/` **增量覆盖**同步，`tests/.ts-out` 用 tsc 增量编译，**不要 `rm -rf`**。
- 累积约 5 次同步后清理一次陈旧文件，计数在 `/root/pcbuild/.sync-count`；用户明确要求时也可清理。

### 5.5 提交约定
- **每完成一个功能就提交一次**，不要攒着。
- 提交信息：中文 + `type(scope): 摘要`（type 取 feat/fix/imp/chore/docs/refactor），正文用 `-` 列要点。
- 提交前至少跑一遍 `tsc --noEmit` 与测试全绿。
- 产物不入库：`build/`、`app2/www/js/app.js`、`app2/www/css/style.css`、`tests/.ts-out/`、`toolchain/*`（见 `.gitignore`）。
- 不留临时文件：调试脚本、日志、一次性产物放 `/tmp` 或清理掉，仓库里只保留源码 / 文档 / 已提交的资源。

### 5.6 引导的「真操作演示」约定
`src/app/guide.ts` + `src/ui/App.tsx` 的 `guideActions`：
- 真操作一般放 **before**（放 `after` 会被下一步遮罩盖住，等于看不见）；只有需要跨步骤继续的才放 `after`（如四指步骤→真的打开帧预览）。
- 每个演示必须**自还原**，还原前检查当前值是否仍是演示设置的值——用户或下一步改过就不动。
- 会盖住画面或改动内容的（设置 / 更新日志 / 调色板 / 特效）用 `peek: true` 调浅遮罩，或只高亮不实际应用。
- 点控件统一用 `simulateTap()`（`src/ui/guide.tsx` 导出），它派发 pointerdown/up/click，与真手指一致。
- 新增选择器后跑 `tests/guide-anchors.test.ts`：静态扫描 `src/ui` 源码，确认每个 `[data-guide="..."]` 锚点真实存在。

---

## 6. 导出 APK 完整流程（runbook）

> 本容器可全程出包，不需要宿主机 build.sh。**aapt2 在本容器是 Android/x86 二进制、跑不起来**，
> 所以走「javac + d8 出 dex → 往模板 APK 里塞」的路线。

### 6.0 一次性前置（都在容器里，不在仓库里）

| 路径 | 用途 |
|---|---|
| `/root/pk/orig.apk` | 已签名模板 APK（提供 manifest / res / lib；`assets/www` 与 `classes.dex` 会被替换） |
| `/root/pk/debug.keystore` | 签名库，别名 `pixelcraft`，口令均为 `pixelcraft`（**换库会导致无法覆盖安装**） |
| `/root/pk/apksigner.jar` | 签名 / 校验 |
| `/root/apk/bt/d8.jar` | dex 编译（配合 `javac`） |
| `/root/apk/platform/android-34/android.jar` | 编译用平台（`-bootclasspath`） |
| `/root/pk/rebuild2.py` | javac+d8 出 `classes.dex` → 重打包 → 改写 AXML 版本号 |
| `/root/pk/make-apk.sh` | **一键**：rebuild2 → sign → verify → 拷贝产物 |
| `/root/pk/verify-apk.py` | 复核包内 versionName/versionCode/dex 大小/app.js 指纹 |
| `/root/pcbuild/node_modules` | `tsc` / `esbuild`（仓库里没有 node_modules） |

### 6.1 改版本号（**只有用户要求出包时才动**）

| 位置 | 字段 | 规则 |
|---|---|---|
| `android/AndroidManifest.xml` | `versionName` / `versionCode` | versionName 与 changelog 的 `APP_VERSION` **必须一致**；versionCode 每次 +1 |
| `src/ui/changelog.tsx` | `APP_VERSION` + `CHANGELOG` 顶部新条目 | 新条目写中英双语（`it(kind, zh, en)`），kind 取 add/imp/fix |

### 6.2 同步源码到 ASCII 构建目录（**不要 rm -rf**）

```sh
cp -r src/. /root/pcbuild/app/src/
cp -r tests/. /root/pcbuild/app/tests/
```

### 6.3 类型检查 + 测试（必须全绿）

```sh
cd /root/pcbuild && ./node_modules/.bin/tsc -p tsconfig.json --noEmit
cd /root/pcbuild/app/tests && ../../node_modules/.bin/tsc -p tsconfig.json && node .ts-out/tests/run-tests.js
```

### 6.4 重建 Web 包（esbuild）

```sh
cd /root/pcbuild/buildsrc && cp -r /root/pcbuild/app/src/. .
../node_modules/.bin/esbuild main.tsx --bundle --format=iife --platform=browser --target=es2019 \
  --define:process.env.NODE_ENV='"production"' --outfile=out-app.js --log-level=warning
cp out-app.js "<repo>/app2/www/js/app.js"
cp ui/style.css "<repo>/app2/www/css/style.css"
```

- 仓库路径含中文：esbuild 的输出目录必须在 ASCII 路径（`buildsrc` 内构建后回拷），否则报 `mkdir /root: read-only file system` 之类的错。
- esbuild 默认把非 ASCII 转义成 `\uXXXX`，所以 `grep 中文` 查不到属正常；用 `grep -a "u9707u52a8"` 或直接搜英文标识符验证。

### 6.5 打包 + 签名（一条命令）

```sh
sh /root/pk/make-apk.sh <版本号> <versionCode>      # 例：sh /root/pk/make-apk.sh 1.0.7.10 32
```

它依次做四件事：
1. `rebuild2.py`：`javac -encoding UTF-8 -bootclasspath android.jar` + `d8.jar` 编出 `classes.dex`，从模板 APK 重打包（替换 `assets/www` + `classes.dex` + 改写 AXML 的 versionName/versionCode）；
2. `apksigner sign`（v2+v3）；
3. `apksigner verify`——**失败即退出**，不会产出成品；
4. 拷贝到 `/sdcard/Download/PixelCraft-<版本号>.apk` 与仓库 `build/PixelCraft.apk`。

> 只改了 Web 层也可以用 `/root/pk/rebuild.py`（只换 assets + 改版本号），但它**不会**更新 Java 层；
> 只要 `android/java` 动过，就必须走 `make-apk.sh` / `rebuild2.py`。

### 6.6 交付前复核（必做）

```sh
python3 /root/pk/verify-apk.py /sdcard/Download/PixelCraft-<版本号>.apk "<repo>/app2/www/js/app.js"
java -jar /root/pk/apksigner.jar verify --print-certs /sdcard/Download/PixelCraft-<版本号>.apk
```

- `verify-apk.py` 输出：package / versionName / versionCode / min,targetSdk / VIBRATE / dex 大小 / app.js 大小与 md5 / **app.js 是否与本地构建一致**。
- `apksigner verify` 无输出即通过；证书 SHA-256 必须是 `745beeceeda9f891c04e7aae584a0a8a3e27f0023075044d2f55adb6bb442f1f`（否则覆盖安装会失败）。
- 改了 Java 时再 grep 一下 dex 里的新字符串，例如 `grep -c setImmersive <(unzip -p ... classes.dex)`。
- 最后把 `/sdcard/Download/PixelCraft-<版本号>.apk` 路径告诉用户，并可选发通知：
  `curl "http://127.0.0.1:3090/app/notify?token=$(cat /root/.dsh/.bridge_token)&title=...&text=..."`（常返回 `FOREGROUND_SKIP`，正常）。

### 6.7 提交

见 §5.5。

### 6.8 常见坑

| 症状 | 原因 | 处理 |
|---|---|---|
| 安装提示「缺少开发者证书」 | 把 `rebuild2.py` 的 **未签名** 中间产物 `repack.apk` 当成品发了 | 走 `make-apk.sh`；发前 `apksigner verify` |
| Java 改动没生效 | 只用了 `rebuild.py` | 用 `make-apk.sh` / `rebuild2.py` |
| `javac` 报 `unmappable character` | Java 源里出现中文且未指定编码 | Java 注释保持英文；`rebuild2.py` 已加 `-encoding UTF-8` |
| `esbuild` 报 `mkdir /root: read-only file system` | 输出路径落在中文仓库路径 | 在 `/root/pcbuild/buildsrc` 构建后回拷 |
| 新包体积和上一版一模一样 | 签名块按 4096 对齐，压缩差值被吸收 | **用 app.js 的 md5 判断**，别凭体积判断是否打进新代码 |
| 覆盖安装失败 / 签名冲突 | 换了 keystore | 必须用 `/root/pk/debug.keystore` |
| 装完版本号没变 | 忘同步 `AndroidManifest.xml` 与 `APP_VERSION` | 见 §6.1 |

---

## 7. 已知缺口 / 待办

- `AndroidManifest.xml` 版本号与 changelog 的 `APP_VERSION` 需手动同步（无自动校验，容易漏）。
- `view.ts` / `session.ts` / `App.tsx` 仍偏大：手势/渲染、会话、UI 可继续拆。
- 无键盘快捷键；渲染已做脏矩形增量，仍未做 overlay 笔迹层 / Web Worker（优先级见 `docs/COMPARISON.md`）。

---

## 8. 附录：近期已完成（会话压缩用）

撤销重做全量 Command 化、历史双模式 + 全量回放（HistoryModal / ReplayOverlay）、魔法球 FX（描边/投影/外发光/反色/灰度/居中/智能裁剪）、图形即拖即选区、网格（off/pixel/iso）、三击缩放 + loupe 取色放大镜、帧预览、dock 持久化、全局长按菜单拦截、画布钳制 + 边缘自动平移、帧多选、洋葱皮首尾着色、导出帧范围、调色板排序/合并/去重、引导同步、设置搜索/重置/导入导出、返回手势双击确认、手势可重映射、操作历史随工程保存、震动反馈修复、设置卡片化、全面屏与安全区适配、时间线可拖动分割线。
代码整理（2026-09-08）：删除旧 vanilla 版 `app/www` 与 boot-test/eng-test 旧脚本；i18n 死键与未用导出清理；调色板数据合并到 `src/data/palettes.ts`；构建配置收进仓库；未用导入/字段清理（`tsc noUnusedLocals` 0 错误）。
死代码清理（2026-09-09）：`ts-prune` + 静态扫描删除未用导出（`squareCells`、`colorToHex6`）与 25 条旧布局 CSS（bottombar/zone/framebox/flyout/packrow/clg-v 等）、修好一个失衡的 `}`；删 `build.sh`/`tests/run.sh`/`toolchain/env.sh`/`toolchain/resolve.js` 与 696MB SDK 下载物；新增 `tests/i18n.test.ts` 静态校验 i18n 键（顺手修好 `t("loop.*")` 取错字典与 6 个缺失键）。

---

## 9. 文档地图

| 文档 | 内容 |
|---|---|
| [`README.md`](README.md) | 项目概览、功能清单、快速开始、目录结构与架构要点 |
| [`docs/API.md`](docs/API.md) | 全部模块的 API 接口文档（签名 / 参数 / 返回值 / 用法）与扩展指南（新增工具 / 设置 / 导出格式 / 引导步骤） |
| [`docs/UI.md`](docs/UI.md) | **UI 规范**：设计令牌（尺寸/主题色/固定色）、`src/ui/kit` 控件 API、迁移清单、组件与令牌测试约定、演示页 |
| [`docs/COMPARISON.md`](docs/COMPARISON.md) | 与 Aseprite / Resprite 的对比、痛点复盘与优先级（含最新进展表） |
| `AGENTS.md`（本文件） | AI 代理约定：环境、命令、架构、工程约定、出包 runbook、已知缺口 |
