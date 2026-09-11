# AGENTS.md

> 给 AI 编码代理 / 后续会话的**唯一约定来源**。动手前先读本文件；改完按 §5.5 提交；**提问 / 调用 / 派活规范见 §10**。
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
| 当前版本 | `1.0.8.7`（以 `src/ui/changelog.tsx` 的 `APP_VERSION` 为准） |
| 仓库根 | `/sdcard/Download/ds文件夹/pixelcraft`（= `/storage/emulated/0/Download/ds文件夹/pixelcraft`） |

目录：

```
src/app/       Session、设置注册表、引导注册表、手势映射、历史编解码
src/engine/    文档模型、历史栈、像素操作、调色/对称/导出编码
src/render/    视口、合成器、脏矩形、洋葱皮
src/tools/     工具注册表、笔迹、选区变换
src/io/        原生桥接、工程文件（.pxc）、Aseprite 读写（aseread/asewrite/zlib）、自动保存、参考图、安全区、base64
src/ui/        React 外壳、弹窗、时间线、浮动球、i18n、样式
android/       MainActivity（Java 层）+ AndroidManifest
tests/         无 DOM 的引擎/逻辑回归（约 1950 条断言）
docs/          API.md / COMPARISON.md
```

---

## 2. 环境与依赖

- **仓库内**：`package.json` + `tsconfig.json` + `scripts/`；`npm install` 后可用 `scripts/build-web.sh`、`scripts/run-tests.sh`。
- **容器内（实际出包环境）**：`node_modules` 在 `/root/pcbuild`（FUSE 上装不上时在容器私有区安装后回拷）；同步目录 `/root/pcbuild/app/src`、`/root/pcbuild/app/tests`。
- `aapt2` 在本容器是 Android/x86 二进制、**跑不起来**，所以打包走「`javac` + `d8` → 往模板 APK 里塞」的路线（见 §6）。
- 浏览器调试：`node toolchain/devserver.js`（`app2/www`，端口 8090；`app2/www/js/telemetry.js` 会把错误与布局信息 POST 到 `/log`）。
- `toolchain/` 只保留自写脚本（`devserver.js`、`make-icon.js`、`check-bundle.mjs`）：`node toolchain/make-icon.js <outdir>` 生成 Android 启动图标，`node toolchain/make-icon.js --pwa app2/www/icons` 生成 manifest 用的 192/512 图标（尺寸必须和 `manifest.webmanifest` 一致，否则 Chrome 报 “Resource size is not correct”），`node toolchain/check-bundle.mjs [bundle]` 把 Web 产物放进最小 DOM 桩里真跑一遍（**esbuild 按「源文件往上最近的 tsconfig.json」决定 JSX 变换：构建目录里多出一份没有 `"jsx": "react-jsx"` 的 tsconfig，就会打出引用全局 React 的白屏包**；`scripts/build-web.sh` 已内置这道自检）；SDK 下载物已清理。
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
     --define:process.env.NODE_ENV='"production"' --minify --outfile=out-app.js --log-level=warning \
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

### 5.1b 分支模型（2026-09-10 起）
- **`master`**：全部源码（APK + Web 共用），唯一的开发分支。
- **`main`**：**只放部署用的静态站点**（GitHub Pages 发布根目录），内容全部由
  `scripts/publish-web.sh` 从 `app2/www` + `web/` 生成，**不要在这个分支上手工改文件**。
- 远程：`origin = git@github.com:DeerLuuu/PixelCreate.git`（SSH，容器内密钥在 `~/.ssh/id_ed25519`）。
- 更新线上站点：`sh scripts/publish-web.sh --push`；Pages 的 Source 必须是 “GitHub Actions”。
- 部署文件（workflow / 部署分支 README / `.nojekyll`）的唯一来源是 `master` 的 `web/`。

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
  --define:process.env.NODE_ENV='"production"' --minify --outfile=out-app.js --log-level=warning
cp out-app.js "<repo>/app2/www/js/app.js"
cp ui/style.css "<repo>/app2/www/css/style.css"
```

- **默认带 `--minify`**（1.2MB → 约 730KB，Pages 上 gzip 后约 180KB）；`scripts/build-web.sh` 用 `MINIFY=0` 关闭，
  仅在需要可读堆栈时使用。仓库、APK、Pages 三处必须是**同一份产物**，否则 md5 校验会对不上。
- 仓库路径含中文：esbuild 的输出目录必须在 ASCII 路径（`buildsrc` 内构建后回拷），否则报 `mkdir /root: read-only file system` 之类的错。
- esbuild 默认把非 ASCII 转义成 `\uXXXX`，所以 `grep 中文` 查不到属正常；用 `grep -a "u9707u52a8"` 或直接搜英文标识符验证。
- **压缩后标识符会被改名**：验证包内是否含某功能时搜**字符串字面量**（类名 `pal-drag`、i18n 键 `palDragHint`、
  版本号 `1.0.8.4`、`aria-modal` 等），别搜函数名（`holdAllowed` 这类会被压掉）。
- `app2/www/js/telemetry.js` 只在本地上报（localhost / 127.0.0.1 / 局域网 IP / `*.local`），
  Pages 与 APK（`file://`）里完全静默，避免线上站点出现 `/log` 404。

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
| 页面白屏、控制台 `React is not defined` | 构建目录里（或其上层）多出一份没有 `"jsx": "react-jsx"` 的 tsconfig.json，esbuild 就近采用它、退回经典 JSX 变换 | 在仓库根构建（`scripts/build-web.sh`），它内置 `toolchain/check-bundle.mjs` 自检，会把这种包判为构建失败 |
| 控制台 `Manifest: Resource size is not correct` | `app2/www/icons/*.png` 的实际尺寸与 `manifest.webmanifest` 声明不一致 | `node toolchain/make-icon.js --pwa app2/www/icons` 按声明尺寸重新生成 |

---

## 7. 已知缺口 / 待办

- `AndroidManifest.xml` 版本号与 changelog 的 `APP_VERSION` 需手动同步（无自动校验，容易漏）。
- `view.ts` / `session.ts` / `App.tsx` 仍偏大：手势/渲染、会话、UI 可继续拆。
- PC 模式仅按「鼠标 + 宽屏」启发式识别（`src/io/pcmode.ts`，可在设置里强制开关）；渲染已做脏矩形增量，仍未做 overlay 笔迹层 / Web Worker（优先级见 `docs/COMPARISON.md`）。

---

## 8. 附录：近期已完成（会话压缩用）

撤销重做全量 Command 化、历史双模式 + 全量回放（HistoryModal / ReplayOverlay）、魔法球 FX（描边/投影/外发光/反色/灰度/居中/智能裁剪）、图形即拖即选区、网格（off/pixel/iso）、三击缩放 + loupe 取色放大镜、帧预览、dock 持久化、全局长按菜单拦截、画布钳制 + 边缘自动平移、帧多选、洋葱皮首尾着色、导出帧范围、调色板排序/合并/去重、引导同步、设置搜索/重置/导入导出、返回手势双击确认、手势可重映射、操作历史随工程保存、震动反馈修复、设置卡片化、全面屏与安全区适配、时间线可拖动分割线。
代码整理（2026-09-08）：删除旧 vanilla 版 `app/www` 与 boot-test/eng-test 旧脚本；i18n 死键与未用导出清理；调色板数据合并到 `src/data/palettes.ts`；构建配置收进仓库；未用导入/字段清理（`tsc noUnusedLocals` 0 错误）。
死代码清理（2026-09-09）：`ts-prune` + 静态扫描删除未用导出（`squareCells`、`colorToHex6`）与 25 条旧布局 CSS（bottombar/zone/framebox/flyout/packrow/clg-v 等）、修好一个失衡的 `}`；删 `build.sh`/`tests/run.sh`/`toolchain/env.sh`/`toolchain/resolve.js` 与 696MB SDK 下载物；新增 `tests/i18n.test.ts` 静态校验 i18n 键（顺手修好 `t("loop.*")` 取错字典与 6 个缺失键）。
PC 桌面化第 2 批（1.0.8.7）：粘贴流程重做（`ui/paste.ts` + `Session.pasteAsNewLayer/pasteAsNewCanvas/pasteIntoFrames`，修复 Ctrl+V 静默失效）、`engine/scrub.ts` 修滚轮/拖动调值跳变、空格按住＝背景色绘制 + `X` 换色、平移改画布外拖动/方向键、Alt 吸管光标、`Ctrl+F1` 快捷键一览、多球同开不拦截、画布球 PC 全展开、色球与子球同尺寸、PC 隐藏球里的复制剪切粘贴、帧图层直接拖动/双击重命名/右键帧设置/Shift 区间选帧/`Del` 全局删除/单画布标题、跨画布拖选区实时预览、浏览器手势拦截、`Ctrl+O/N/E`。
PC 桌面化（1.0.8.5 / 1.0.8.6 批）：UI 规范与 `src/ui/kit` 控件库（Dialog/Form/primitives/scrub/HoverTip）+ 设计令牌与浅色主题、18 个弹窗与全部表单行迁移；PC 模式识别（`io/pcmode.ts`）与全套桌面输入（滚轮缩放/平移、中键＝聚焦适配、右键＝背景色、Alt+单击取色、窗口拖放导入、剪贴板、快捷键、Tab 专注）；浮动球桌面几何与全展开+锁定；设置/更新日志左右分栏；帧预览面板加宽；**选区跨画布移动**（`selOps.floatDropInto`）。
Aseprite 兼容：`io/aseread.ts` / `io/asewrite.ts` / `io/zlib.ts`（自写同步 inflate；读 RGBA/灰度/索引色 + 图层/帧/链接 cel/调色板/标签，写 .aseprite 供 Aseprite 打开），打开流程按魔数识别、导出弹窗加 Aseprite 页签。
动画标签：`engine/tags.ts`（命名帧区间的纯函数，帧结构操作在 `engine/ops.ts` 里统一维护范围）+ `app/playback.ts` 的 `PlayWindow`（从标签内的帧起播＝只循环这一段，起点不在标签里＝整条时间轴）+ 时间轴标签条（`ui/timeline.tsx`，点开 `TagModal` 改名/改范围/换色/删除/播放这一段）+ `.pxc` / `.aseprite` 双向存取。
标签细节（同日追加）：循环按钮按模式换图标（`i-loop` / `i-loop-once` / `i-loop-pingpong` / `i-loop-reverse`）；**播放范围取法＝点标签永远播那个标签（`startPlayback(tag)`，重叠也不按帧优先），只有播放按钮才按当前帧推导**；播放中点其它标签的帧＝`Session.retargetPlay` 切换正在播的动画（仍在当前标签内则保持不动，点到所有标签之外＝回到整条时间轴）；重叠标签用 `tagLanes` 分层显示（每条一行，时间轴的标签区行数随之变化）；标签条手势＝轻点播放（`Session.tagPlay`）、拖左右边缘改范围（拖完才提交，一次拖动一条历史）、右键/长按打开编辑器。

---

## 9. 文档地图

| 文档 | 内容 |
|---|---|
| [`README.md`](README.md) | 项目概览、功能清单、快速开始、目录结构与架构要点 |
| [`docs/API.md`](docs/API.md) | 全部模块的 API 接口文档（签名 / 参数 / 返回值 / 用法）与扩展指南（新增工具 / 设置 / 导出格式 / 引导步骤） |
| [`docs/UI.md`](docs/UI.md) | **UI 规范**：设计令牌（尺寸/主题色/固定色）、`src/ui/kit` 控件 API、迁移清单、组件与令牌测试约定、演示页 |
| [`docs/PC.md`](docs/PC.md) | **电脑模式（PC）适配清单与后续建议**：已完成能力表 + 20 条待办建议（含代码位置） |
| [`docs/COMPARISON.md`](docs/COMPARISON.md) | 与 Aseprite / Resprite 的对比、痛点复盘与优先级（含最新进展表） |
| `AGENTS.md`（本文件） | AI 代理约定：环境、命令、架构、工程约定、出包 runbook、已知缺口、交互与派活规则（§10） |

---

## 10. 代理交互规则（提问 / 调用 / 派活）

> 工具名按**能力**理解：不同 harness 叫法不同（本仓库常见对应见每节末尾的「本环境」行），照同类能力执行即可。

### 10.1 该问就问

- 请求**真的含糊**（有多种理解 / 缺关键细节 / 选择会改变结果）时，先问**一个**短澄清问题；
- 问题里列出最可能的选项，让用户一句话能答（推荐项放第一个并标「(推荐)」，可多选时说明）；
- **意图清楚就直接做，别瞎猜**——不要为了「稳妥」把能判断的事也拿去问。

### 10.2 调用规范

- 参数给**完整合法 JSON**；编辑文件前先读，用读到的**原文原样**作为 `oldText`（不要凭记忆重写）；
- 命令失败先**读报错**，修**深层原因**（最小修复），别原样重试；
- 工具返回后**先看结果**再决定下一步；
- **直接发函数调用**，不要在正文里写工具 JSON；
- 有依赖的调用等上一步结果；**互不依赖的调用放在同一条消息里一起发**；
- 后台命令结束或被用户杀掉会**自动通知**你，不必反复轮询。

> 本环境：读文件 `read` → 编辑 `edit`（`old_string` 必须与原文一字不差）；后台命令用 `bash` 的 `run_in_background`，取结果用 `job_output`。

### 10.3 分工（什么时候该派活）

- 任务能拆成**互不依赖、各自要大量阅读**的几块 → **并行派只读子代理**，各自报结论，你只汇总冲突项；
  几个文件就能答完的**不要派**；
- 回忆之前聊过什么（含本会话其他分支、子代理报告全文）→ 会话检索（`search_transcripts`）；看本会话的分支结构 → `list_nodes`；
- **长时间的命令用后台模式**（`exec_command` 后台 / 本环境 `bash` 后台），别干等着；
- 需要**干净上下文**、中途不需你介入的长任务 → 换会话（`hop_session`）/ 派子代理；
- 例：「把这 30 个文件的一致性审一遍」→ 分 4 批各派一个只读子代理，各自报差异，你只汇总冲突项。

> 本环境：单次委派用 `subagent`（需要本会话上下文时 `subagent_fork`），大批量 fan-out（审计 / 迁移 / 多角度核查）用 `workflow`；长目标用 goal 工具。
