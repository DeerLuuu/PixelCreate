# PixelCraft 工程状态速记（会话压缩用）

## 位置与构建（2026-09 起仓库自足，不再依赖 pc2）
- 源: /storage/emulated/0/Download/ds文件夹/pixelcraft/src（TS+React18）
- 仓库根自带构建配置：package.json + tsconfig.json + scripts/
  - npm install 后：`sh scripts/build-web.sh` → 产出 app2/www/js/app.js + css/style.css（esbuild IIFE bundle，含 react）
  - `sh scripts/run-tests.sh` → tsc 编译 tests/ + 引擎回归（history/ops/move/sym）
  - 类型检查：`node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`（noUnusedLocals 已开）
  - node_modules 在 /sdcard（FUSE）装不上时，可在容器私有区镜像安装后回拷产物
- APK 构建仍在宿主机真机跑 build.sh（aapt2/javac/d8/apksigner 离线链，需 java+android-sdk；本仓库只产出 web assets）
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
- APK 打包只能在宿主机（本仓库无 java/android-sdk）；AndroidManifest versionCode/versionName 与 changelog 需手动同步
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
- **出包流程**：改源码 → tsc → 引擎/逻辑测试 → `app2/www` 重建（esbuild，注意仓库中文路径需在 ASCII 目录构建后回拷）→ 打包 → apksigner 签名 → 解析包内 manifest 复核。
  - 只改了 Web 层（TS/TSX/CSS）：`/root/pk/rebuild.py`（换 assets + 改写 AXML 版本）即可。
  - **改了 Java 层（android/java）**：本容器里 aapt2 是 Android/x86 二进制跑不起来，但 `javac` + `d8.jar` 可用，所以用 `sh /root/pk/make-apk.sh <版本号> <versionCode>`（如 `sh /root/pk/make-apk.sh 1.0.7.7 29`）：它先跑 `rebuild2.py`（javac+d8 编出 `classes.dex`，从模板 APK 重打包，替换 assets/www + classes.dex + 改写 AXML 版本），**再 apksigner 签名并 `verify` 复核**，最后拷到 `/sdcard/Download/PixelCraft-<版本号>.apk` 和仓库 `build/PixelCraft.apk`。**只用 rebuild.py 的话 Java 改动不会进包**（模板里的 classes.dex 是旧的）。
  - ⚠️ `rebuild2.py` 的产物 `repack.apk` 是**未签名**的，直接发出去会提示「缺少开发者证书」而装不上——必须走 `make-apk.sh`（或手动补 apksigner 那一步），发包前用 `apksigner verify --print-certs` 确认 `Verifies` 且证书 SHA-256 为 `745beeceeda9f891c04e7aae584a0a8a3e27f0023075044d2f55adb6bb442f1f`。
  - 复核：解包 `classes.dex` 里 grep 关键字符串（如 `__pc_back()===true`）、解析 AXML 的 versionName/versionCode、检查 `assets/www/js/app.js` 是否含新代码。
- **提交约定**：每完成一个功能就提交一次（不要攒着）。提交信息用中文 + `type(scope): 摘要`（type 取 feat/fix/imp/chore/docs/refactor），正文用 `-` 列出改动要点；产物不进版本库（`build/`、`app2/www/js/app.js`、`app2/www/css/style.css`、`tests/.ts-out/`、`toolchain/` 已在 `.gitignore`）。提交前至少跑一遍 `tsc --noEmit` 与 `tests` 全绿。
- **引导的“真操作演示”约定**（`src/app/guide.ts` + `src/ui/App.tsx` 的 `guideActions`）：
  - 真操作一般放 **before**（放在 `after` 的演示会被下一步的遮罩盖住，等于看不见）；只有需要在离开步骤后继续的才放 `after`（如四指步骤→真的打开帧预览）。
  - 每个演示必须**自还原**，且还原前检查当前值是否仍是演示设置的值——用户或下一步改过就不动。
  - 会盖住画面或改动内容的（设置/更新日志窗口、调色板、特效）用 `peek: true` 把遮罩调浅，或只逐个高亮而不实际应用。
  - 点控件统一用 `simulateTap()`（从 `src/ui/guide.tsx` 导出），它派发 pointerdown/up/click，和真手指一致。
  - 新增选择器后跑 `tests/guide-anchors.test.ts`：它静态扫描 `src/ui` 源码，确认引导里每个 `[data-guide="..."]` 锚点真实存在（没有浏览器也能防“步骤指向已改名的按钮”）。

