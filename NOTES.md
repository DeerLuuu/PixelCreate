# PixelCraft 工程状态速记（会话压缩用）

## 位置与构建（2026-09 起仓库自足，不再依赖 pc2）
- 源: /storage/emulated/0/Download/ds文件夹/pixelcraft/src（TS+React18）
- 仓库根自带构建配置：package.json + tsconfig.json + scripts/
  - npm install 后：`sh scripts/build-web.sh` → 产出 app2/www/js/app.js + css/style.css（esbuild IIFE bundle，含 react）
  - `sh scripts/run-tests.sh` → tsc 编译 tests/ + 引擎回归（history/ops/move/sym）
  - 类型检查：`node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`（noUnusedLocals 已开）
  - node_modules 在 /sdcard（FUSE）装不上时，可在容器私有区镜像安装后回拷产物
- APK 构建已可在本容器内全程完成：见下文「导出 APK 完整流程」（javac+d8 出 dex → 模板 APK 重打包 → apksigner 签名；aapt2 在本容器跑不起来，不用它）
- 浏览器测试: node toolchain/devserver.js（app2/www, 8090）
- git 已有 77+ 提交，大改动可 git 回滚

## 关键架构
- Session 单例(app/session.ts): doc/history/prefs/工具状态; changed() 驱动 React(useSyncExternalStore)
- History(engine/history.ts): record(廉价逆向)/pushPixels(像素差分)/pushStruct(全档快照,复杂操作); undo/redo/jumpTo; histMode steps(默认60)/full(完整回放)
- View(render/view.ts) 接管画布手势; 撤销前 flushStroke; 双击语义：画布边距双击=undo、双指双击=redo、画布上双击吞点等第三击、三击=2×放大
- Shape: 统一栅格 inside+border 实心/空心; Zingl 椭圆; 笔刷 brushStamp 镜像对称 (Aseprite 移植)
- 浮动球(FloatingTools): 主球/选区球/取色球(pal 扇形)/魔法球; 多球互斥 68px; dock 停靠持久化
- 调色板唯一数据源: src/data/palettes.ts（PALETTE_PACKS + defaultPalette），勿再在别处复制色表
- UI 横屏≥768px 侧栏grid; i18n zh/en 同文件 src/ui/i18n.ts（键请保持 zh/en 同步，删除键先 grep）

## 近期已做
撤销重做全量Command化、历史双模式+全量回放(HistoryModal/ReplayOverlay)、魔法球FX(描边/投影/外发光/反色/灰度/居中/智能裁剪)、图形即拖即选区、网格(off/pixel/iso)、三击缩放+loupe 取色放大镜、帧预览按钮、dock 持久化、全局长按菜单拦截、画布钳制+边缘自动平移。
代码整理（2026-09-08）：删除旧 vanilla 版 app/www 与 boot-test/eng-test 旧脚本；i18n 死键与未用导出清理；调色板数据合并到 src/data/palettes.ts；构建配置收进仓库；view/session 等未用导入/字段清理（tsc noUnusedLocals 0 错误）。

## 待办/已知缺口
- AndroidManifest versionCode/versionName 与 changelog 的 APP_VERSION 需手动同步（无自动校验，容易漏）
- view.ts(~1460)/session.ts(~1020)/App.tsx(~900) 仍偏大：手势/渲染、会话、UI 可继续拆
- 无键盘快捷键；渲染已做脏矩形增量（仍未做 overlay 笔迹层 / Web Worker，见 docs/COMPARISON.md 优先级）

## 文档入口
- [`README.md`](README.md)：项目概览、功能清单、快速开始、目录结构与架构要点。
- [`docs/API.md`](docs/API.md)：全部模块的 API 接口文档（签名 / 参数 / 返回值 / 用法），以及“新增工具 / 设置 / 导出格式 / 引导步骤”的扩展指南。
- [`docs/COMPARISON.md`](docs/COMPARISON.md)：与 Aseprite / Resprite 的对比、痛点复盘与优先级（含最新进展表）。

## 协作约定（给后续会话/AI 用）
- **测试副本与输出不要每次删**：容器里的 `/root/pcbuild/app/src`、`app/tests` 用 `cp -r <repo>/src/. app/src/` 增量覆盖同步，`app/tests/.ts-out` 用 tsc 增量编译，**不要 `rm -rf`**。累积约 5 次同步后再清理一次（计数放在 `/root/pcbuild/.sync-count`），或用户明确要求时清理。
- **版本号**：`1.0.x` 的第三段由用户决定，不要自行递增；小改动只递增第四段（`1.0.6.0 → 1.0.6.1`），且只在用户要求出包时才改；`versionCode` 为覆盖安装需要可内部递增。
- **声明式优先**：设置项走 `src/app/settings.ts`，引导步骤走 `src/app/guide.ts`；新增功能 = 一条声明 + i18n 文案，界面/引擎自动适配。
- **文档同步**：新增/修改对外 API 或功能后，同步更新 `docs/API.md`（接口签名）与 `README.md`（功能表）；对比文档的“最新进展”表也一并刷新。
- **出包流程**：完整 runbook 见下文「导出 APK 完整流程」。一句话版：改源码 → 同步 `/root/pcbuild` → `tsc` + 测试 → esbuild 重建 `app2/www` → `sh /root/pk/make-apk.sh <版本号> <versionCode>`（重打包 + 签名 + 校验 + 拷贝）→ 复核 → 提交。

- **提交约定**：每完成一个功能就提交一次（不要攒着）。提交信息用中文 + `type(scope): 摘要`（type 取 feat/fix/imp/chore/docs/refactor），正文用 `-` 列出改动要点；产物不进版本库（`build/`、`app2/www/js/app.js`、`app2/www/css/style.css`、`tests/.ts-out/`、`toolchain/` 已在 `.gitignore`）。提交前至少跑一遍 `tsc --noEmit` 与 `tests` 全绿。
- **引导的“真操作演示”约定**（`src/app/guide.ts` + `src/ui/App.tsx` 的 `guideActions`）：
  - 真操作一般放 **before**（放在 `after` 的演示会被下一步的遮罩盖住，等于看不见）；只有需要在离开步骤后继续的才放 `after`（如四指步骤→真的打开帧预览）。
  - 每个演示必须**自还原**，且还原前检查当前值是否仍是演示设置的值——用户或下一步改过就不动。
  - 会盖住画面或改动内容的（设置/更新日志窗口、调色板、特效）用 `peek: true` 把遮罩调浅，或只逐个高亮而不实际应用。
  - 点控件统一用 `simulateTap()`（从 `src/ui/guide.tsx` 导出），它派发 pointerdown/up/click，和真手指一致。
  - 新增选择器后跑 `tests/guide-anchors.test.ts`：它静态扫描 `src/ui` 源码，确认引导里每个 `[data-guide="..."]` 锚点真实存在（没有浏览器也能防“步骤指向已改名的按钮”）。


## 导出 APK 完整流程（runbook）

> 2026-09 起本容器可全程出包，不再需要宿主机 build.sh。容器内 **aapt2 是 Android/x86 二进制、跑不起来**，
> 所以走「javac + d8 出 dex → 往模板 APK 里塞」的路线。

### 0. 一次性前置（都在容器里，不在仓库里）

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

### 1. 改版本号（**只有用户要求出包时才动**）

| 位置 | 字段 | 规则 |
|---|---|---|
| `android/AndroidManifest.xml` | `versionName` / `versionCode` | versionName 与 changelog 的 `APP_VERSION` **必须一致**；versionCode 每次 +1 |
| `src/ui/changelog.tsx` | `APP_VERSION` + `CHANGELOG` 顶部新条目 | 新条目写中英双语（`it(kind, zh, en)`），kind 取 add/imp/fix |

版本规则：`1.0.x` 的第三段由用户决定，不要自行递增；小改动只递增第四段（`1.0.7.9 → 1.0.7.10`）。

### 2. 同步源码到 ASCII 构建目录（**不要 rm -rf**）

```sh
cp -r src/. /root/pcbuild/app/src/
cp -r tests/. /root/pcbuild/app/tests/
```
增量覆盖；累计约 5 次清理一次陈旧文件，计数在 `/root/pcbuild/.sync-count`。

### 3. 类型检查 + 测试（必须全绿）

```sh
cd /root/pcbuild && ./node_modules/.bin/tsc -p tsconfig.json --noEmit
cd /root/pcbuild/app/tests && ../../node_modules/.bin/tsc -p tsconfig.json && node .ts-out/tests/run-tests.js   # 期望 ALL PASS
```

### 4. 重建 Web 包（esbuild）

```sh
cd /root/pcbuild/buildsrc && cp -r /root/pcbuild/app/src/. .
../node_modules/.bin/esbuild main.tsx --bundle --format=iife --platform=browser --target=es2019 \
  --define:process.env.NODE_ENV='"production"' --outfile=out-app.js --log-level=warning
cp out-app.js "<repo>/app2/www/js/app.js"
cp ui/style.css "<repo>/app2/www/css/style.css"
```
- 仓库路径含中文：esbuild 的输出目录必须在 ASCII 路径（`buildsrc` 内构建后回拷），否则报 `mkdir /root: read-only file system` 之类的错。
- esbuild 默认把非 ASCII 转义成 `\uXXXX`，所以 `grep 中文` 查不到属正常；用 `grep -a "u9707u52a8"` 或直接搜英文标识符验证。

### 5. 打包 + 签名（一条命令）

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

### 6. 交付前复核（必做）

```sh
python3 /root/pk/verify-apk.py /sdcard/Download/PixelCraft-<版本号>.apk <repo>/app2/www/js/app.js
java -jar /root/pk/apksigner.jar verify --print-certs /sdcard/Download/PixelCraft-<版本号>.apk
```
- `verify-apk.py` 输出：package / versionName / versionCode / min,targetSdk / VIBRATE / dex 大小 / app.js 大小与 md5 / **app.js 是否与本地构建一致**。
- `apksigner verify` 无输出即通过；证书 SHA-256 必须是
  `745beeceeda9f891c04e7aae584a0a8a3e27f0023075044d2f55adb6bb442f1f`（否则覆盖安装会失败）。
- 改了 Java 时再 grep 一下 dex 里的新字符串，例如 `grep -c setImmersive <(unzip -p ... classes.dex)`。
- 最后把 `/sdcard/Download/PixelCraft-<版本号>.apk` 路径告诉用户，并用
  `curl "http://127.0.0.1:3090/app/notify?token=$(cat /root/.dsh/.bridge_token)&title=...&text=..."` 发个通知（常返回 `FOREGROUND_SKIP`，正常）。

### 7. 提交

中文提交信息 `type(scope): 摘要` + 正文要点；产物不入库（`build/`、`app2/www/js/app.js`、`app2/www/css/style.css`、`tests/.ts-out/`、`toolchain/` 已在 `.gitignore`）。

### 8. 常见坑

| 症状 | 原因 | 处理 |
|---|---|---|
| 安装提示「缺少开发者证书」 | 把 `rebuild2.py` 的 **未签名** 中间产物 `repack.apk` 当成品发了 | 走 `make-apk.sh`；发前 `apksigner verify` |
| Java 改动没生效 | 只用了 `rebuild.py` | 用 `make-apk.sh` / `rebuild2.py` |
| `javac` 报 `unmappable character` | Java 源里出现中文且未指定编码 | Java 注释保持英文；`rebuild2.py` 已加 `-encoding UTF-8` |
| `esbuild` 报 `mkdir /root: read-only file system` | 输出路径落在中文仓库路径 | 在 `/root/pcbuild/buildsrc` 构建后回拷 |
| 新包体积和上一版一模一样 | 签名块按 4096 对齐，压缩差值被吸收 | **用 app.js 的 md5 判断**，别凭体积判断是否打进新代码 |
| 覆盖安装失败 / 签名冲突 | 换了 keystore | 必须用 `/root/pk/debug.keystore` |
| 装完版本号没变 | 忘同步 `AndroidManifest.xml` 与 `APP_VERSION` | 见第 1 步 |
