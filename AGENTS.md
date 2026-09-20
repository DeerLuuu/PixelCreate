# AGENTS.md

> 给 AI 编码代理 / 后续会话的**唯一约定来源**。动手前先读本文件；改完**先按 §5.3 同步 API 文档**，再按 §5.5 提交；**提问 / 调用 / 派活规范见 §10**。
> **一律用简体中文**（回复用户、文档、注释、提交信息、更新日志都一样，见 §10.4）。
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
| 当前版本 | `1.1.1.9`（以 `src/ui/changelog.tsx` 的 `APP_VERSION` 为准） |
| 仓库根 | `/sdcard/Download/ds文件夹/pixelcraft`（= `/storage/emulated/0/Download/ds文件夹/pixelcraft`） |

目录：

```
src/app/       Session、设置注册表、引导注册表、手势映射、历史编解码、AI（ai-doc 文档文本化 / ai-tools 工具表 /
               ai-draw 落笔适配层（笔迹·形状·填充·擦除·特效·变换）/ ai-turn 回合事务 / ai-rpc 协议路由 /
               ai-serve 本地服务生命周期 / ai-presets 厂商预设（默认 DeepSeek）/ ai-chat 应用内助手的整轮循环 /
               ai-vision 参考图（vision）的尺寸 · 体积 · 能力门控）
               —— 接口见 docs/API.md §21–§26
src/engine/    文档模型、历史栈、像素操作、调色/对称/导出编码、重采样（resample）、颜色分析（color-analysis）
src/render/    视口、合成器、脏矩形、洋葱皮
src/servers/   服务层：RenderServer（合成与缓存）、ViewportServer（视图数学）、
               InputServer / GestureController（手势策略 · 轻点序列 · 指针事件入口）—— 见 docs/ARCHITECTURE.md
src/io/        原生桥接、工程文件（.pxc）、Aseprite 读写（aseread/asewrite/zlib）、自动保存、参考图、安全区、base64
src/ui/        React 外壳、弹窗、时间线、浮动球、i18n、样式、AiPanel（应用内助手面板 + 助手小球 ChatBall）、
               AiWindow（助手浮窗，portal 到 body）
android/       MainActivity（Java 层）+ AiServer（本地 AI 端口服务，纯 JDK）+ AndroidManifest
tests/         无 DOM 的引擎/逻辑回归（**8134 条断言**，`node .ts-out/tests/run-tests.js` 末尾会打印条数）
docs/          ROADMAP.md / API.md / COMPARISON.md / COMPARISON-pixelover-pixelcomposer.md / PLAN-ai.md /
               PLAN-deer-ui.md / PLAN-isobuilder.md / ARCHITECTURE.md / UI.md / PC.md
toolchain/     自写开发脚本（devserver / make-icon / check-bundle / stress-stroke / ai-server / pc-mcp / pc-shell+pc-shell.cmd）
```

---

## 2. 环境与依赖

- **仓库内**：`package.json` + `tsconfig.json` + `scripts/`；`npm install` 后可用 `scripts/build-web.sh`、`scripts/run-tests.sh`。
- **本仓库依赖一个独立开源库 `deer-ui`**（自己的仓库：本机 `Z:\deer-ui`、远端 `github.com/DeerLuuu/deer-ui`，MIT —— **它是独立库，PixelCraft 只是它的第一个消费者**，不是本仓库的内部模块；库源码里没有任何指向本仓库的 import / 路径 / 回退）。宿主经 `vendor/deerui-0.1.0.tgz` 的 `file:` 依赖消费，装到 `node_modules/deer-ui`；`package-lock.json` 里的 `integrity` 与 `tests/ui-fork.test.ts` 的 bytes/md5/sha256 三条指纹是「装上的就是 `vendor/` 那份 tarball」的凭证。**离线环境安装需要 `--legacy-peer-deps`**（库的 peer 在离线树里解不出），这台机器上还要 `--install-strategy=nested`（lock 里 esbuild 的空壳版本会让 npm 直接报 `Invalid Version:`）；容器里出包前 `/root/pcbuild/node_modules` 也要装这份 tarball 并同步 `vendor/`，否则 APK 构建解析不到 `deer-ui/kit`。
- **样式与设计令牌的唯一来源是库**：产物 `app2/www/css/style.css` = 库段 + 应用段，由 `scripts/build-css.mjs` 拼接（库段经 `require.resolve("deer-ui/styles.css")` 取，**取不到就 exit 1**，不静默降级）；库段在前、应用段在后。所以应用 `src/ui/style.css` 里**不许**再出现 `:root` / `[data-theme=...]` 令牌块（`tests/ui-css.test.ts` 会红）。改控件 / 改令牌的链路：`Z:\deer-ui` 改 → `npm run pack:vendor` → 拷到 `vendor/deerui-0.1.0.tgz` → `npm install` → 同步 `tests/ui-fork.test.ts` 三个指纹常量（细节见 §4 的 UI 两条）。
- **容器内（实际出包环境）**：`node_modules` 在 `/root/pcbuild`（FUSE 上装不上时在容器私有区安装后回拷）；同步目录 `/root/pcbuild/app/src`、`/root/pcbuild/app/tests`。
- `aapt2` 在本容器是 Android/x86 二进制、**跑不起来**，所以打包走「`javac` + `d8` → 往模板 APK 里塞」的路线（见 §6）。
- 浏览器调试：`node toolchain/devserver.js`（`app2/www`，端口 8090；`app2/www/js/telemetry.js` 会把错误与布局信息 POST 到 `/log`）。
- `toolchain/` 只保留自写脚本（`devserver.js`、`make-icon.js`、`check-bundle.mjs`、`stress-stroke.mjs`、`ai-server.mjs`；`/toolchain/*` 被忽略，每个脚本各靠 `.gitignore` 里一条 `!` 白名单入库）：`node toolchain/make-icon.js <outdir>` 生成 Android 启动图标，`node toolchain/make-icon.js --pwa app2/www/icons` 生成 manifest 用的 192/512 图标（尺寸必须和 `manifest.webmanifest` 一致，否则 Chrome 报 “Resource size is not correct”），`node toolchain/check-bundle.mjs [bundle]` 把 Web 产物放进最小 DOM 桩里真跑一遍（**esbuild 按「源文件往上最近的 tsconfig.json」决定 JSX 变换：构建目录里多出一份没有 `"jsx": "react-jsx"` 的 tsconfig，就会打出引用全局 React 的白屏包**；`scripts/build-web.sh` 已内置这道自检），`node toolchain/stress-stroke.mjs` 量**笔迹性能基线**（每步同步耗时 + 重合成次数与耗时；改渲染或笔迹相关代码前后各跑一次，基线表在 `docs/COMPARISON.md` §三.1）；`node toolchain/ai-server.mjs` 是**本机开发 / 验证用的 Node 宿主**（本地 AI 工具服务：只绑 `127.0.0.1`，`--port` / `--tier` / `--token` / `--version` 或环境变量 `AI_PORT` / `AI_TIER` / `AI_TOKEN` 可配，`--help` 看用法；启动会打印端口与随机 token，并用 curl 示例提示怎么调）。它**不重写协议** —— 直接 require `tests/.ts-out` 里编译好的 `src/app/ai-rpc.js` / `ai-serve.js` / `session.js`（Session 靠 `tests/session.test.ts` 的 `stubEnv()` 跑起来），所以**先跑一次** `node node_modules/typescript/bin/tsc -p tests/tsconfig.json`，缺产物会打印编译提示并退出；这个宿主没有确认 UI，destructive 工具一律回 `cancelled`（与 APK 默认口径一致），协议表与口径见 `docs/API.md` §24。`.gitignore` 的 `/toolchain/*` + 逐条白名单里也加了 `!/toolchain/ai-server.mjs`（新脚本要入库必须同样加一行）；SDK 下载物已清理。
- **AI 的电脑侧入口（本轮新增，两个脚本都靠 `.gitignore` 白名单入库）**：`node toolchain/pc-mcp.mjs --port 8787 --token <hex>` 是 **C4 的 MCP 入口**（stdio 换行分隔 JSON-RPC 2.0 ↔ 本机 `POST /ai` 的薄转发，`tools/list` 现取现映射、`tools/call` 不吞错；`AI_PORT` / `AI_TOKEN` / `AI_TIMEOUT` 也可配）。**前置**：先在应用里打开本地 AI 服务（或 `node toolchain/ai-server.mjs --tier draw`）并拿到它启动时打印的 token，再把同一个 token 配给宿主；`--token` / `AI_TOKEN` 现在**真的生效**（修过一处「模块顶层求值先于 `parseArgs`，把传入的 token 静默吞掉」的顺序缺陷），token **未指定时才**随机生成 —— banner / `--help` / 文件头文案已按这条改准。`node toolchain/pc-shell.mjs` 是**电脑桌面壳**（Windows 双击 `toolchain\pc-shell.cmd`）：伺服 `app2/www` + 在同一个端口提供 `/ai` 两个入口 + 用 SSE 把请求转发进窗口页面里那张真实画布，协议与 APK 的 `AiServer.java` 一致、一行都不重写。用法、宿主配置示例与工具数口径见 `docs/API.md` §25。**`node --check` 只能验 `.mjs`**，`.cmd` 要用 `cmd /c toolchain\pc-shell.cmd --help`。
- **桌面壳的第二条通道：模型请求的同源代理（应用内助手用）**。壳会从**环境变量**读一把 provider key（`DEEPSEEK_API_KEY` → `OPENAI_API_KEY` → `PC_AI_KEY`，第一个非空即用；显式 `--provider-key` 优先级最高），并在同端口提供 `GET /provider/config`（探测，不要 token）与 `POST /provider/chat`（转发，要壳的通道 token）。页面**只**拿 `hasEnvKey` 布尔 + 公开的端点 / 模型名，**真 key 一个字节都不进页面**（内存 / DOM / console / localStorage 四处都搜不到，响应体里连尾 4 位都没有）。用法：
  ```sh
  # ① 环境变量（推荐）：设一次，然后照常起壳 —— 应用里「设置 → AI 助手」不用手填 key
  set DEEPSEEK_API_KEY=sk-xxxx     # PowerShell: $env:DEEPSEEK_API_KEY="sk-xxxx"
  node toolchain/pc-shell.mjs
  # ② 自测 / 自建网关：显式给 key（这一条**豁免** https 闸门，可以用本机 http 假 provider）
  node toolchain/pc-shell.mjs --provider-key sk-xxxx --provider-base http://127.0.0.1:9000
  node toolchain/pc-shell.mjs --help                                   # 全部参数
  curl.exe -s http://127.0.0.1:8787/provider/config                    # 看壳自报的代理配置
  ```
  · **改了环境变量要重启壳**（key 只在 `parseArgs` 时读一次）；`AI_TOKEN` 是**壳 ↔ 页面的通道 token**，与 provider key 是两件事，不得混用；
  · **上游转发超时默认 60s**（`--provider-timeout` / `PC_SHELL_PROVIDER_TIMEOUT`），与壳 ↔ 页面临时通道的 `--timeout`（10s，与 APK 同口径）**是两条、别合并**：模型请求（V4 默认带思考模式 + 61 个工具 schema）十几秒很正常，共用 10s 会让第一次真实调用必然撞 `504 provider-timeout`。**页面设置 `ai.chatTimeoutSec`（默认 60s）每次请求带 `X-Provider-Timeout` 覆盖它**（壳夹到 1s..10min，非法回退），直连时由页面的 AbortController 按同一个值兜底；
  · **安全分档**：环境变量那把 key **只发往已知 provider 主机（`api.deepseek.com` / `api.openai.com`）且必须是 `https:`**，两者有一个不满足就**直接关掉 `/provider/*` 转发**并在 banner 讲明原因（`--provider-base http://api.deepseek.com:8080` 这种也会被拒）；只有显式 `--provider-key` 才可走非白名单主机 / 明文 http；
  · 壳把自己那把 key **擦成 `…尾4`** 再写回页面（防上游在错误体里回显 `Authorization`，那会让环境 key 明文进 DOM）；不跟随跨主机重定向；banner / 日志 / 诊断里只有尾 4 位。
  接口形状、九档错误码与完整安全边界见 `docs/API.md` §26.6；环境变量优先级与「key 不进页面」的准确口径见 §26.3；**怎么自己测（三条测法 / 期望现象 / 症状排查表）见 §26.7**。
- 大改动可用 git 回滚（仓库已有 90+ 提交）。

---

## 3. 常用命令

```sh
# 同步源码（增量覆盖，不要 rm -rf；见 §5.4）
cp -r src/. /root/pcbuild/app/src/ && cp -r tests/. /root/pcbuild/app/tests/
# 测试还要读仓库根的这几个目录：tests/changelog.test.ts 读 android/AndroidManifest.xml、
# tests/icons.test.ts 读 app2/www/index.html，缺了会直接 FATAL（不是「跳过」）
cp -r android/. /root/pcbuild/app/android/ && cp -r app2/. /root/pcbuild/app/app2/ && cp -r web/. /root/pcbuild/app/web/

# 对齐 Web 产物：不自己构建，取部署分支 main 上那一份（见 §5.1b）
sh scripts/sync-web.sh            # 加 --check 只比较不写入（不一致退出码 1）

# 笔迹性能基线（需要先起 devserver + 一个开着 CDP 端口的 Chromium；见 §2）
node toolchain/stress-stroke.mjs            # 最坏配置：512² · 12 图层 · 64px 笔刷 · 平铺 + 洋葱皮
node toolchain/stress-stroke.mjs --plain    # 对照组：1px 笔刷 · 1 图层

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
- `History`（`src/engine/history.ts`）：`record`（廉价逆向）/ `pushPixels`（像素差分）/ `pushStruct`（全档快照，复杂操作）；`undo/redo/jumpTo`；`histMode` = `steps`（默认 **120** 条，`prefs.histSteps`；`History.cap` 初值 60 会在 session 初始化时被 `setCap(histSteps)` 覆盖）/ `full`（完整回放）。工程文件可内嵌历史（`src/io/historyfile.ts` + `src/app/history-io.ts`）。
- 渲染增量：`Stroke.takeDirty()` → `composeRectInto` → 视口脏矩形 blit；`Session.repaint()` 由 rAF 合并，`repaintRect(rect)` 只更新局部；洋葱皮 / 选区着色都有缓存版本号。
- **渲染调试**：设置 → 显示 →「渲染调试」（或控制台 `__pcRender.text()`）能看到**每一次重绘做了什么**：
  整幅/局部/跳过、原因（`first` / `full-dirty` / `force` / `key-changed`）、脏矩形 → 屏幕重绘区域、耗时。
  排查"卡顿"与"画面不更新"先看它，别靠猜。实现与字段见 `docs/API.md` §15b.4。
- **合成所有权在 `servers/render.ts` 的 `RenderServer`**（合成缓冲、合成键、失效区域、多画布缓存、棋盘格），
  视图数学在 `servers/viewport.ts`（缩放/平移/坐标/旋转矩阵，纯函数）。`render/view.ts` 只做 blit 与覆盖层，
  别把这两件事搬回去 —— 细节与"不要改回去"清单见 `docs/API.md` §15b。

**工具与手势**
- **手势判定与触点会话状态全在两个 `src/servers/` 文件里（四片搬完，P5 收尾）**：
  · `input.ts`（`InputServer` 第一片）= 策略与算术的**纯函数**：鼠标按键意图、pinch 解算（中点不动点）、
    四指划动判定、长按策略、点击容差 —— 口径见 `docs/API.md` §15c。
  · `gesture.ts`（第二～四片）= **轻点序列状态机** `TapMachine`（单击 / 双击边距·画布·换画布 / 三击 /
    双指双击，容差 480ms·64px·80px，`up()` 返回 `TapOutcome`；口径与**一个已知问题（画布内三击够不到）**
    见 `docs/API.md` §15c2，`tests/gesture.test.ts` 钉住现状）+ **指针事件入口** `GestureController`
    （`onDown` / `onMove` / `onUp` / `onCancel` 整体搬来，约 850 行；**触点会话状态也是控制器的字段**
    —— `pointers` / `pinchBase` / `selDrag` / `xf` / `stroke` … 共 37 个，`View` 只读它们画覆盖层，
    写入只有控制器能做；`View` 只留一行转发、覆盖层绘制与各工具动作体，接口契约见 §15c3，
    假 host 回归见 `tests/gesture-host.test.ts`）。
  `render/view.ts` 里**不要再写手势判定** —— 判定进 `gesture.ts`，动作体留在 `View` / `tools`。
- `View`（`src/render/view.ts`）接管画布手势：画布边距双击 = undo、双指双击 = redo、三击 = 2× 放大；手势 → 动作映射在 `src/app/gestures.ts`，设置里可改。
- 震动统一走 `Session.hapticTick(tag, scale)`（受 `gesture.haptic` 开关与 `prefs.hapticLen` 控制）。
- 形状：统一栅格 inside+border（实心/空心），Zingl 椭圆，笔刷 `brushStamp` 镜像对称（Aseprite 移植）。

**UI**
- 浮动球 `FloatingTools`：**五个**（主球 `main` / 选区球 `sel` / 取色球 `pal` / 魔法球 `fx` / 画布球 `canv`，见 `ORB_IDS`）；触屏下多球互斥 68px、电脑模式下可同时展开，dock 停靠持久化，PC 另有装备槽 + 快捷圆盘。
- 调色板**唯一数据源** `src/data/palettes.ts`（`PALETTE_PACKS` + `defaultPalette`），勿在别处复制色表。
- 横屏 ≥768px 走侧栏 grid；`src/ui/style.css` 的 `--sat/--sab/--sal/--sar` 是安全区变量（由 `src/io/safearea.ts` 写入）。
- i18n 中英同文件 `src/ui/i18n.ts`：**每个键 zh/en 各一条**；删键前先 grep。
- **`src/ui/kit/**` 与 `src/ui/{tooltip,tabs}.tsx` 已是「薄再导出层」**（实现搬进了独立库 `deer-ui`；**样式与令牌也是库的**，`deer-ui/styles.css`）。**不要在薄层里写实现，也不要在 `src/ui/style.css` 里写控件规则或令牌块** —— `tests/ui-fork.test.ts` 与 `tests/ui-css.test.ts` 会红；要改控件 / 令牌就去 `Z:\deer-ui` 改、`npm run pack:vendor`、重打 tarball、再 `npm install`（链路见 §2）。口径、边界与执行记录见 `docs/UI.md` §1.3 与 `docs/PLAN-deer-ui.md` §10。

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
- **构建产物也在版本管理里，只是放在 `main`**：`app2/www/js/app.js`、`app2/www/css/style.css` 在 `master`
  被 `.gitignore` 忽略，`main` 上每次部署一个提交，提交信息形如
  `chore(web): 同步 Web 构建产物（源提交 bd613a7）`（记着这份产物是从哪个源码提交构建的）。
  所以 `git pull` 之后本地产物可能落后于源码 —— 用 **`sh scripts/sync-web.sh`** 从 `origin/main` 取回
  （`--check` 只比较不写入，不一致退出码 1）；想看某一版的产物就 `git show origin/main:js/app.js`。
  **不要为了「pull 一次就拿到产物」把它们提交进 `master`**：1.1MB 压成一整行的文件放进源码分支，
  diff 看不了、冲突没法解，而且每次改源码都要记得重建再提交，否则仓库里的包会静默落后于源码。
  存储不是理由：`main` 上 53 个版本的 `app.js` 加起来，整个仓库的 pack 也只有约 4 MiB。

### 5.2 声明式优先
- 设置项写进 `src/app/settings.ts`（一条声明 + i18n 文案），设置界面自动生成；
- 引导步骤写进 `src/app/guide.ts`；手势映射写进 `src/app/gestures.ts`；
- **功能图标写进 `src/ui/feature-icons.ts`**：每个功能入口一个专属 SVG（画在 `app2/www/index.html` 的 sprite 里），
  同一屏同时出现的入口不得共用图标 —— 真机反馈过「新功能借旧图标，并排时根本分不清」，
  `tests/icons.test.ts` 会校验组内唯一 + 图标真实存在；
- 新增功能优先「加一条声明」，不要在 UI 里硬编码分支。

### 5.3 文档同步（**每次改功能都必须做，不是「有空再补」**）
- **改了哪块代码，就更新 `docs/API.md` 里对应那一节** —— 这是硬要求：改完功能、跑完测试，
  **提交之前**把被改模块的签名 / 参数 / 行为约定 / 坑点写进对应小节（新增模块要新增小节，
  并在 §9 文档地图与 README 的目录结构里露面）。
  - 引擎与工具（`src/engine/*`、`src/tools/*`）：写进它已有的那一节（如变换见 §10b、变形见 §18.11、重采样见 §6a）；
  - 视图 / 会话 / UI（`src/render/view.ts`、`src/app/session.ts`、`src/ui/*`）：更新对应小节的公开面列表与状态机约定；
  - 行为变了（哪怕签名没变）也要改：口径、边界、优先级、修掉的 bug 都写一句「为什么」，
    免得下一个人照着旧注释把 bug 改回去（本仓库的注释里已经有多处这种「不要改回去」的记录）。
- 用户可见的新功能 / 行为变化 → 同时更新 `README.md` 的功能表；竞品能力有变化时刷新 `docs/COMPARISON.md` 的「最新进展」。
- 涉及界面规范 / 控件 / 覆盖层顺序 → `docs/UI.md`；新增设置项 / 引导步骤 / 手势 → 改对应声明（`src/app/*.ts`）并在这里提一句。
- **更新日志文案（`src/ui/changelog.tsx`）用纯文本渲染**（`<li>{x.zh}</li>`，没有 Markdown 解析）：
  `**加粗**`、反引号、`#` 之类会连着符号原样显示给用户，所以一律不写。文案按「以前什么样 → 现在什么样」
  写一句事实，不要感叹、不要 ①②③ 编号、不要营销腔；一条只讲一件事（一条里塞 4 件以上就拆成多条），
  数字 / 角度 / 快捷键 / 取值范围照抄不能丢；每条占一行 `      it("fix", "中文", "English"),`（拼装与测试都按行解析）。
  `tests/changelog.test.ts` 会静态校验这些（外加 `APP_VERSION` 与 `AndroidManifest.xml` 的 `versionName` 一致）。
- 提交信息正文里带一行「文档：docs/API.md §X」，方便回溯「这次改了什么、写在哪」。

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
# 测试要读的仓库根目录（§3 已解释原因），缺了 §6.3 的测试会 FATAL
cp -r android/. /root/pcbuild/app/android/
cp -r app2/. /root/pcbuild/app/app2/
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

- `AndroidManifest.xml` 版本号与 changelog 的 `APP_VERSION` 已由 `tests/changelog.test.ts` 静态校验（不一致会测试失败）；
  改版本号仍然要手动改两处 + 加一条更新日志（见 §6.1）。
- `view.ts` / `session.ts` / `App.tsx` 仍偏大：渲染覆盖层、会话、UI 可继续拆
  （手势判定与触点会话状态已经搬完：`view.ts` 4668 → 3693 行，见 §8）。
- **三击（`gTripleTap` ＝ 2× 放大）在默认设置下够不到**：单指第二下只要落在画布上，就会被
  「双击画布（映射了动作）」或「聚焦适配（没映射）」吃掉并清零连点计数，所以攒不到第三下；
  只有 `canvasIndex < 0` 才保留计数。现状由 `tests/gesture.test.ts` 的 `gesture.triple.shadowed.*`
  钉住，口径见 `docs/API.md` §15c2。修法＝改判定顺序或承认三击只在边距外有效，**两种都改用户可见行为，先问用户**。
- **笔迹 overlay 层：量过之后判定不做**（2026-09-15）。当时的理由「每移动一次都要重合成」不成立：
  512² · 12 图层 · 64px 笔刷 · 平铺 + 洋葱皮下，**合成峰值只有 0.7ms**（一帧预算 16.7ms），
  做覆盖层省不到 5%，却要为「目标图层上方有可见图层 / 擦除 / 洋葱皮 / 自动平移」加四条退回分支。
  实测数据与量法见 `docs/COMPARISON.md` §三.1 的基线表 + `node toolchain/stress-stroke.mjs`。
  **同一个基线里真正扎眼的是同步耗时峰值 7.7–9.6ms（大笔刷）**，怀疑在 `Stroke.stampCells()`
  每次移动重建笔尖图案、每格新建数组（镜像 ×2、平铺 ×9，一次移动可产生数万个小数组）→ GC 停顿。
  下一步的性能活是这条热路径去分配，不是覆盖层。
- PC 模式按**输入证据**识别（`src/io/pcmode.ts` 的 `resolvePcMode`：真实鼠标事件 > 触摸事件/触摸点否决 > 媒体查询 `(pointer: fine)` + `(hover: hover)`），**不看屏幕宽度**；设置里可强制开关；渲染已做脏矩形增量，仍未做 Web Worker 导出 / 大画布长时间压力测试（优先级见 `docs/COMPARISON.md`）。
- **AI 本地工具服务（C0–C5 + P1 已落地）**（接口见 `docs/API.md` §21–§26，方案与进度见 `docs/PLAN-ai.md`）：
  · **已落地**：C0 文本化 / C1 工具表 / C2 回合事务 / C3 本机端口服务 / **C4 电脑侧 MCP 入口（`toolchain/pc-mcp.mjs`）**
    / **C5 应用内助手（`src/app/ai-chat.ts` + `src/ui/AiPanel.tsx`，含 destructive 确认框与 key 管理）**
    / **P1 像素级绘制工具面（13 条，落笔在 `src/app/ai-draw.ts`）**。工具表 **61 条 = read 4 / draw 49 / destructive 7 / ui 1**，
    三个「工具数」口径见 `docs/API.md` §25.3（协议层 `list_tools {}` 在 `all` 档是 **60**，显式点名 `ui` 是 **61**，
    MCP 层 `tools/list` 是 **61**）。
  · **参数描述缺失**：61 个工具、176 个参数里 **52 个没有 `desc`**（只影响模型选工具 / 填参数的准确率，
    不影响正确性；MCP 层会按 `AiParamType` 自动补一句，见 `docs/API.md` §25.3）。
  · **协议层 / MCP 的 destructive 仍然默认拒绝**：应用内助手自己有确认框（`docs/API.md` §26.4），
    但 `curl` / MCP 这条路上没有宿主注入确认器（`setAiConfirmer()`）—— 想让 Claude Desktop 真去删图层，
    得先给协议层接一个真确认 UI。
  · **特效与变换走 `Session.maskOp()` 的「结构快照」**（`History.pushStruct`：整档 before / after 各一份），
    不是 `pushPixels` 的稀疏像素差分。这是**不动 `session.ts` / `history.ts` 接口**这条口径下的**有意取舍**：
    ① C1 的硬口径是「写入经 `Session` 既有方法」，`ai-draw.ts` 因此完全不 import `History`；
    ② 变换会顺手改选区掩码，只有结构快照能把它一起撤销。代价是**大画布**（1024² × 多图层）下一步要
    两份整档快照（像素画常态 64²～256² 无所谓）。**要换差分从哪里下手**：给 `Session.maskOp()` 加一个
    「只记像素」的开关，或让 `ai-draw.ts` 直接走 `History.pushPixels` —— 两条都要改 `src/app/session.ts` /
    `src/engine/history.ts` 的接口，本轮明确不做（计划见 `docs/API.md` §22.8 末尾）。
  · **`docRev` 是单调修订号，不是内容指纹**：`Doc.restore()` 自己会 `pixelRev++`，所以回滚 / undo / redo
    也让它 +1；判断「是否回到原样」要比**内容**（图层 / 调色板 / cel 字节），不能比 rev（`docs/API.md` §23.3 第 11 条）。
  · **读回口径已修（P14）**：`readRegion` 在「字节 → hex」那一步反乘（内部 `straightHexAt()`），
    所以半透明像素读回来是**直通 RGBA**，与工具入参 `#rrggbbaa`、`doc.palette` 三者一致
    （`a=255` 恒等 / `a=0` 记 `.` / `0<a<255` 允许每通道 ±1、上界 ≈ `ceil(255/(2a))` / `a=1` 不可还原；
    边界见 `docs/API.md` §21.2）。**写入 / 合成 / 渲染一行未动**，改的只是读侧解释。
  · `palette_from_canvas`（`Session.paletteFromCanvas`）与这条读回口径**同源但本轮未修**：它直接遍历
    `doc.cels` 的**原始字节**取色（存的是预乘值），没走 `straightHexAt()`，所以「从画布生成调色板」
    与 `read_region` 读同一批半透明像素时两边可能对不上。修它要动 `src/app/session.ts`，本轮明确不做
    （见 `docs/API.md` §21.4）。
  · **cel 字节的「存储语义」在本仓库里并不统一**（本轮最有价值的缺口，**别当成 bug 顺手改**）：
    `blendOver`（`src/engine/color.ts`，写半透明像素走它）把 RGB **按 alpha 缩过**再存，
    而 `resample` / `blurCel` / `compositor.celToCanvas` 都把**同一批字节当直通 RGBA**处理
    （前者乘完再除回来、后两者直接 `putImageData`）—— 同一块 cel，读法不同、结果不同。
    **统一它一定会改画面观感**（存量半透明像素的显示会变），**须先问用户**再动；本轮只把读侧解释
    （`readRegion`）修到自洽。
  · `readRegion` 的 `opts.fi` / `opts.li` 小数仍**静默截断**（`applyOps` 侧已统一成 `warnings`，两条路径口径暂时不一致）。
  · **跨画布 AI 回合的 History entry 是 payload-less**：`history.dump()` 实测返回 `[]`，会让该步与**更早步骤**
    一起从 `.pxc` 内嵌历史里消失（单画布走 `pushStruct` 可序列化；in-session 一条 undo 仍覆盖两张画布）。
  · 回合开着时**页面隐藏的同步 flush 会早退**：回合跨过「页面隐藏 + 进程被杀」时，回合开始前那几笔不落盘
    （口径 4 的固有取舍）。
  · 模块级 `lastCommitError` 在「回合没开」早退时**不清**，可能携带上一次的陈旧错误（一行加固未做）。
  · **History 层显式批量抑制开关 / 回合看门狗：本轮决定不做**（会改 `History` 语义并牵动 90+ 提交的回归面）。
  · **契约勘误（写进仓库，别让它只活在任务记录里）**：C5 那次的 inScope 把第 10 个改动文件写成
    **不存在的 `src/ui/settings.ts`**，实际改的是 **`src/app/settings.ts`**（`CHAT_SETTINGS` +
    `SETTING_SECRET_PATHS`）；运行时按 inScope 拒收越界路径，所以那次记录里只有 9 项 + 一行 output 勘误。
    以后写任务 inScope 请对着真实路径抄。
  · **完成闸门只校验「声明的」`changedPaths`（本轮实测的口子，2026-09-17）**：集成/实现的验收闸门判的是
    「声明的 changedPaths ⊆ inScope」，**未声明的**新增文件能整个溜过去 —— 本轮的 `src/ui/AiWindow.tsx`
    就是这样进来的，而当时那份实现报告还把它描述成「零新增文件 / 窗口落在 AiPanel.tsx」。
    **以后判断「这一轮到底改了哪些文件」一律以 `git status --short` 为准**，不要只信 changedPaths 或成员自述；
    复核时把 `git status --short` 的每一条与文档/报告里的文件面对一遍。
  · **「key 不进页面」这条只对环境变量来源成立**（P8/P15，`docs/API.md` §26.3）：手填的 `ai.chatKey`
    仍在本机页面的 `localStorage` 里（同源脚本读得到），本轮没改这一点。环境 key 那条路是真的一个字节都不进页面
    （壳转发、响应体里连尾 4 位都不给、回显的 key 由壳擦成 `…尾4`）。
  · **env key 的转发腿与「上游回显」这个组合没能一起端到端验**（P15/P16）：env 来源现在要过
    「白名单主机 + `https:`」两道闸，本机没有受信任证书，所以**回显型假 provider 只能配 `--provider-key`
    （豁免闸门）+ 本机 `http`** 来验擦除。两条路读同一个 `opts.providerKey`、走同一段 `forwardToProvider()` /
    `scrubProviderKey()`；env 来源的转发腿本身已用真 `https://api.deepseek.com`（假 key，401 原样透传）验过。
    **要真验这个组合，得给本机假 provider 配一张受信任证书 / 自签 + `rejectUnauthorized:false` 的口子** —— 不做。
  · **助手的状态行说明是中文常量而不是 i18n 键**（P15 新增的 `AI_CHAT_KEY_HELP_MANUAL` / `_ENV` / `_NONE`）：
    英文界面下这三句仍显示中文。要 i18n 得把同模块的 `httpError()` / `hostError()` / `chatConfigError()`
    一起搬进 `i18n.ts`（它们早就是中文常量），不在本轮。
  · **`/provider/*` 的两处加固备选**（都属「不可利用的加固」，本轮判可接受、不做）：① 壳不校验 `Host` 头
    （DNS rebinding 类风险，只绑 `127.0.0.1` + 通道 token 已经挡住了实际利用）；② `authOk()` 接受 `?token=`
    查询串（会进浏览器历史 / 日志，但只在本机 + 用户自己配的前提下）。
  · 若干**弱断言**（例如 `digest.tokens` 用同一个公式反推期望值，只保证自洽、不保证预算真实）。
  · **参考图（vision）已落地（2026-09-18，接口见 `docs/API.md` §26.8）**：助手可挂一张参考图与文本一起发
    （`content` 变 parts 数组；**无图时仍是纯字符串**，且只有 `user` 消息能带图 —— `system` / `assistant` 带图
    上游回 400）。能力位是**三态**（`AiVision = yes | no | unknown`）：`deepseek-flash` yes、`deepseek-v4-pro` no、
    其余（含自建网关与 `gpt-4o` 系）unknown = **允许发送 + 一句风险说明** —— 把 unknown 当 no 会拦死本来能用的用户。
  · **重采样调用方必须先自查源尺寸（本轮实测的坑，最容易再踩）**：`engine/resample.ts` 的约定是
    「源与目标都在 1..1024」，越界时**不抛异常**，只返回一块**等长但全透明**的缓冲区（`dimsOk()`）。
    `ai-vision.ts` 的 `refToRgba()` 早先把用户的原始尺寸直接喂了进去，于是 **1200px 以上的参考图被静默编成
    一张空白图发给模型**，而附件条上还写着「已缩到 768×768」—— 用户看到的是「发出去了」，模型收到的是空白。
    修法：源超契约时改走本模块自己的 `downscaleOutOfContract()`（盒式平均 / 抽点），**不动 `MAX_SIZE`**
    （那是全项目约定，`scaleAdvanced` / `ScaleModal` / `resampleRegion` 都按它算）。回归断言必须是**像素级**的
    （`aivision.ref.huge.*`：采样颜色数 > 2、alpha > 0）—— 原来那条只比宽高的弱断言正是漏网的原因。
  · **参考图这条路的未验项**：本机没有可用 key，所以**没有对着真 DeepSeek 端点发过带图请求**（`deepseek-flash`
    的图像理解只在官方文档层面核对过）；「选择图片文件」那条（`createObjectURL` + `<img>` 解码）没做端到端，
    只跑了与参考图**共用**的 `encodeAttachment()` 段；「真壳 + 流式 + 带图」这个组合也没跑（e2e 为确定性关掉了流式）；
    真实照片的 PNG 体积没量过（一张 1024² 低频噪声落在 709 KiB，过软线、差 60 KiB 撞硬线）。
  · **重建产物后必须核对产物本身（本轮实测的构建坑）**：`%TEMP%` 里那份 esbuild JS API 脚本曾漏掉 `entryPoints`，
    于是 `esbuild.build()` 什么都不构建、紧接着的 `fs.statSync(outfile)` 抛 ENOENT —— **看起来像「环境坑」，
    其实是脚本没打**。判「产物里到底有没有这段代码」要用 node 数**字符串字面量**
    （`s.split("ai-attach").length - 1`）；`Select-String ... .Matches.Count` 在单行大压缩文件上**不可靠**（会数出 0）。
- **UI 库 `deer-ui` 的令牌面是超集，这条缺口是现成的**（2026-09-20，详见 `docs/PLAN-deer-ui.md` §10.5 / §10.7）：
  库 `:root` 定义 **143** 个令牌，但**库自己的规则只引用 34 个**；**93 个只有宿主外壳在用**
  （`--orb-fg` / `--dock-bg` / `--sym-strong` / `--hud-*` / `--guide-shade*` / `--pie-mask` / `--set-item-*` /
  `--railw` / `--sat…`），**16 个无人引用**。这不算 bug（宿主可以直接用这批令牌），但「库真正独立」还没到位。
  **收敛时不能只搬令牌** —— 会同时踩红 `uicss.app.no-tokens`（禁应用里出现 `:root`）与
  `uitoken.count`（要求库 `:root` ≥ 100 条），两条口径必须一起改。
- **「装上的就是 vendor 那份 tarball」还缺一条直接断言**（t5 的 F1）：现在只有 lock 的 `integrity` +
  `tests/ui-fork.test.ts` 的 tarball 指纹在**间接**保证，**没有**「`node_modules/deer-ui` 逐文件 == tarball 逐文件」
  的断言；换包时靠人肉核（核法见库 README 末尾「给宿主的提醒」：比对 `node_modules/deer-ui/dist/styles.css`
  与库仓库 `dist/styles.css` 的 sha256）。
- **样式拆分的「真渲染等价」是一次性判据、不在仓库里**（2026-09-20）：`%TEMP%` 里的无头 Edge + CDP 脚本比了
  「旧 `src/ui/style.css`（HEAD）vs 新产物」在 524 个 kit 元素 + 699 个应用外壳元素上的**全量 computed style +
  布局矩形**（每元素 620 条属性 × 深色/浅色 + 强制 `:hover/:active/:focus`），差异 0；注入 1px 改动当场变红。
  **这套脚本没有入库、也没接进闸门**（容器里没有浏览器，仓库也不引 puppeteer）—— 要常态化得另立任务。

---

## 8. 附录：近期已完成（会话压缩用）

撤销重做全量 Command 化、历史双模式 + 全量回放（HistoryModal / ReplayOverlay）、魔法球 FX（描边/投影/外发光/反色/灰度/居中/智能裁剪）、图形即拖即选区、网格（off/pixel/iso）、三击缩放 + loupe 取色放大镜、帧预览、dock 持久化、全局长按菜单拦截、画布钳制 + 边缘自动平移、帧多选、洋葱皮首尾着色、导出帧范围、调色板排序/合并/去重、引导同步、设置搜索/重置/导入导出、返回手势双击确认、手势可重映射、操作历史随工程保存、震动反馈修复、设置卡片化、全面屏与安全区适配、时间线可拖动分割线。
代码整理（2026-09-08）：删除旧 vanilla 版 `app/www` 与 boot-test/eng-test 旧脚本；i18n 死键与未用导出清理；调色板数据合并到 `src/data/palettes.ts`；构建配置收进仓库；未用导入/字段清理（`tsc noUnusedLocals` 0 错误）。
死代码清理（2026-09-09）：`ts-prune` + 静态扫描删除未用导出（`squareCells`、`colorToHex6`）与 25 条旧布局 CSS（bottombar/zone/framebox/flyout/packrow/clg-v 等）、修好一个失衡的 `}`；删 `build.sh`/`tests/run.sh`/`toolchain/env.sh`/`toolchain/resolve.js` 与 696MB SDK 下载物；新增 `tests/i18n.test.ts` 静态校验 i18n 键（顺手修好 `t("loop.*")` 取错字典与 6 个缺失键）。
绘制快捷与体验（1.1.0.0 之后）：双击主球＝切回上一个工具（`Session.prevToolId` / `switchToPreviousTool`）、
把橡皮小项从工具球拖到画布＝临时橡皮（`View.beginTempStroke/moveTempStroke/endTempStroke` 转发合成指针事件，
不改 `SESSION.tool`）、动作搜索面板（`Session.allActions()` + `ActionSearchModal`，PC `Ctrl+K` / 触屏＝工具球里的「搜索动作」小项）、
一键从画布生成调色板（`Session.paletteFromCanvas`）、内描边（`effects.inlineCel`：保住最外圈原色 + 透明度混合）、
圆角化（`effects.roundCornersCel`：只削"一个象限全满"的硬直角，细线/斜线/折角安全）、
图案笔刷（`src/data/patterns.ts` + `Session` 图案库 + `Stroke.paintOne`，选区/画布可存为图案）。
PC 桌面化第 2 批（1.0.8.7）：粘贴流程重做（`ui/paste.ts` + `Session.pasteAsNewLayer/pasteAsNewCanvas/pasteIntoFrames`，修复 Ctrl+V 静默失效）、`engine/scrub.ts` 修滚轮/拖动调值跳变、空格按住＝背景色绘制 + `X` 换色、平移改画布外拖动/方向键、Alt 吸管光标、`Ctrl+F1` 快捷键一览、多球同开不拦截、画布球 PC 全展开、色球与子球同尺寸、PC 隐藏球里的复制剪切粘贴、帧图层直接拖动/双击重命名/右键帧设置/Shift 区间选帧/`Del` 全局删除/单画布标题、跨画布拖选区实时预览、浏览器手势拦截、`Ctrl+O/N/E`。
PC 桌面化（1.0.8.5 / 1.0.8.6 批）：UI 规范与 `src/ui/kit` 控件库（Dialog/Form/primitives/scrub/HoverTip）+ 设计令牌与浅色主题、18 个弹窗与全部表单行迁移；PC 模式识别（`io/pcmode.ts`）与全套桌面输入（滚轮缩放/平移、中键＝聚焦适配、右键＝背景色、Alt+单击取色、窗口拖放导入、剪贴板、快捷键、Tab 专注）；浮动球桌面几何与全展开+锁定；设置/更新日志左右分栏；帧预览面板加宽；**选区跨画布移动**（`selOps.floatDropInto`）。
Aseprite 兼容：`io/aseread.ts` / `io/asewrite.ts` / `io/zlib.ts`（自写同步 inflate；读 RGBA/灰度/索引色 + 图层/帧/链接 cel/调色板/标签，写 .aseprite 供 Aseprite 打开），打开流程按魔数识别、导出弹窗加 Aseprite 页签。
动画标签：`engine/tags.ts`（命名帧区间的纯函数，帧结构操作在 `engine/ops.ts` 里统一维护范围）+ `app/playback.ts` 的 `PlayWindow`（从标签内的帧起播＝只循环这一段，起点不在标签里＝整条时间轴）+ 时间轴标签条（`ui/timeline.tsx`，点开 `TagModal` 改名/改范围/换色/删除/播放这一段）+ `.pxc` / `.aseprite` 双向存取。
标签细节（同日追加）：循环按钮按模式换图标（`i-loop` / `i-loop-once` / `i-loop-pingpong` / `i-loop-reverse`）；**播放范围取法＝点标签永远播那个标签（`startPlayback(tag)`，重叠也不按帧优先），只有播放按钮才按当前帧推导**；播放中点其它标签的帧＝`Session.retargetPlay` 切换正在播的动画（仍在当前标签内则保持不动，点到所有标签之外＝回到整条时间轴）；重叠标签用 `tagLanes` 分层显示（每条一行，时间轴的标签区行数随之变化）；标签条手势＝轻点播放（`Session.tagPlay`）、拖左右边缘改范围（拖完才提交，一次拖动一条历史）、右键/长按打开编辑器。
高级缩放与颜色分析（1.1.1.6）：`engine/resample.ts`（nearest / bilinear / bicubic(Catmull-Rom) / area / scale2x / scale3x，统一入口
`resamplePixels` / `resampleRegion`，颜色插值一律走**预乘 alpha**，`opts.cleanTransparent` 清掉透明像素的 RGB，
`SCALE_ALGOS` + `algoSupported` / `effectiveAlgo` 让 UI 不硬编码算法分支；**scale2x 用 Mazzoleni 的四条件式
（先判两个邻居相等才改那一格）、scale3x 直译 `scale3x.c` 的 guard + `E!=对角` 形式**，画布外邻居按边缘钳制，
不满足整数倍时降级最近邻）+ `ScaleModal`（算法 chips + 说明、宽高/锁比例/2×·3×·4×·÷2、作用范围、清透明、
原图↔缩放后的对比图**单独一屏**：弹窗底部 `i-compare` 按钮 → portal 出的 `.dlg-scale-compare`，128px 并排）
+ `Session.scaleAdvanced`（三个范围口径一致：**只有「整个图像」会改画布尺寸**，
图层与选区都在画布内按左上角贴回、选区缩放后选区掩膜跟着变成新的大小；一次操作一条历史，且只在真改像素时压栈）。
面板整屏（同日）：`Overlay` 新增 `full`（`.panel.panel-full` = 铺满 + 安全区内边距），`App.tsx` 传 `full={!land && !pcMode}`
——**手机竖屏面板整屏，横屏与电脑模式才用右侧抽屉（88vw）**。
`engine/color-analysis.ts` + `ColorAnalysisModal`（颜色统计 / 近似色分组与一键合并 / 颜色替换 / 按颜色建选区 / CSV 导出，
范围＝画布·图层·选区·所有帧，面板首屏即有内容）。变形抓手手感修正（`tools/xform.ts`）：抓手贴着选区框
（缩放 6px / 旋转 30px / 斜切 30px，小选区收到 20px）并改成固定语义图标（方块＝缩放、圆箭头＝旋转、双斜线＝斜切）。
变形参考系与抓手（同日追加，真机反馈「锚点乱飞 / 变形不正确 / 点被图像盖住」）：`xform.ts` 的坐标口径统一成
**内容外框**（`contentBox(w,h)` = `0..w`，像素 `i` 占 `[i, i+1)`、屏幕 `p·z + o`），恒等变换下变换框与选中框
逐像素重合、**进入会话前后框不动**（抓手不再在按下的瞬间跳位）；旋转的解算中心改用 `View.xfPivotScreen()`
（早先漏了 `st.ox·z`，选区不在画布原点时拖着转 90° 只出 37°）；斜切基准线改到**对面那条边**
（`affineFrom()` 认 `skewPivot`，被拖的边跟手 1:1、对面一动不动，缩放 / 斜切的拖动量按当前框角投影）；
变形控制点抓取时记「手指 ↔ 控制点」偏移（不再跳到手指下），**变形期间不自动平移**；
从变换会话中途切「网格变形」先把当前预览**烘焙**进浮动内容（不再跳回原位）；覆盖层顺序改为
「浮动内容 → 选区框 + 16 个抓手 + 变形控制点 / 网格线」，抓手永远画在图像之上（见 `docs/UI.md` §3.8）。
跟手补充（同日第二轮反馈「拖动内容时锚点要跟随 / 拖锚点要跟鼠标」）：`View.xfPivotScreen()` 改成把枢轴
**过一遍当前矩阵**（枢轴＝内容上的点，拖内容 / 缩放 / 旋转时跟着走；拖枢轴时位移先过矩阵线性部分的**逆**，
1:1 跟手），缩放分支不再需要手写「跟位」；变形控制点改成**直接落在指针那一点上**（不记偏移，拖到哪就是哪），
命中半径按相邻点间距的一半自适应（下限 8px）；变形模式里按在内容上拖动＝**整块内容连控制点一起走**
（`xf.move`，从起点重算不累加）。
对比预览修正（同日第三轮反馈「两个图片都没显示任何内容」）：新增纯函数模块 `src/ui/scale-preview.ts`
（`flatFrame` / `previewSource` / `previewPatchGeometry` / `cropPatch` / `scaleFactorLabel`，有单测）——
源像素改成 **sprite 范围读当前帧可见图层的压平结果**（＝画布上看到的画面；早先只读当前 cel，画在别的图层
就是空的），取块**对准内容包围盒**（早先固定取区域正中，内容在角落就一片空白），空块给一行提示，
预览画布加透明棋盘格底；`ScalePreview` 只负责把纯函数的结果画进 canvas，高按内容宽高比自适应。
抓手参照（同日第四轮反馈「轻拖一下锚点就偏出 40px」）：解算参照从「手指按下那一点」改成
**「被抓图标自己」按下时的位置**（`View.grabIconAt()` → `xfDrag.h0`），缩放 / 旋转 / 斜切 / 枢轴四条分支
都走它 —— 触屏命中半径 38px，按偏时那一截偏移本来会被冻结在整个拖动里（无头 Edge 实测：按偏 18px 时
图标离手指一直是 18px；改后缩放到 4px、旋转到「图标与手指同一条射线」）。`tests/xformui.test.ts` 的缩放断言
改成**行为断言**（图标跟手、对角锚点不动、等比 / 吸附 / 镜像只判性质），不再钉死某次拖动的倍率数字。
画布外抓手（同日第五轮反馈「按钮不在画布内时会触发拖动相机」）：`onDown` 里「画布外按下＝平移视图」
的 `blankPan && outsideDoc` 先问 `warpHandleAt()` / `xfHitAt()` —— 旋转 / 斜切图标本来就在选区框外 30px，
选区贴边时必然落在画布外，早先无条件平移等于这些图标按不到；空白处（离所有抓手都远）照旧平移。
更新日志文案重写（1.1.1.7 之后）：47 个版本 258 条全部改写去 AI 味（星号加粗 / 反引号 / ①②③ / 感叹 /
破折号长句），**更新日志面板是纯文本渲染，`**` 会连着符号显示给用户**，所以这类标记一律不写；
258 → 381 条（一条只讲一件事）；新增 `tests/changelog.test.ts` 静态校验（含 `APP_VERSION` 与
`AndroidManifest.xml` 的 `versionName` 一致），规则写进 §5.3。
色彩明暗 / 播放速度 / 双击枢轴（1.1.1.8）：`engine/shading.ts` 移植 Aseprite 脚本 Color Shading v5.0
（六条色阶 + 互补·三角·四角；`ShadingModal` 在调色板面板与主菜单）+ `app/playback.ts` 的 `PLAY_SPEEDS` /
`scaledDelay`（时间轴速度色片，0.25x–2x；**不改帧时长**，导出仍是原时长）+ `View.resetXfPivot()`（双击枢轴
复位到内容正中，画面不动；只有「按下去没拖动」的那一下才算一次点击）。三项各自的 docs/API.md 小节：
§6c / §14 / §10b.3 + §15.4。
色彩明暗接色卡 + 下拉裁剪修复（同日追加）：基色块点开调色板挑色（`awaitColorPick` + `onOpenPalette`）、
生成色块长按＝把这格加进色卡（右键＝背景色）、每行「+」加入当前色卡 /「保存」存成新色卡
（新增 `Session.savePalettePresetOf()`，只动 `myPalettes`）；`DropMenu` 改成 **portal + `position:fixed`**
—— 时间轴控制条是 `overflow-x:auto` 的滚动容器，绝对定位的下拉被它整块裁掉，这就是「速度色片点了没反应」，
`tests/ui-kit.test.tsx` 加了三断言防止改回去。
等距图形（同日实现）：`engine/iso.ts` 的 2:1 几何 + 六个基础形状（长方体 / 楼梯 / 楔形 / 圆柱 / 金字塔 /
空心框）+ `isoRender`（只画可见面、画家顺序、三面着色、接触阴影、1px 描边、`originAt` 稳定锚点）；
`Session` 的 iso 模式（`enterIso` / `isoGenerate`，`new` 用整档快照把「新建图层 + 写像素」合成一条 undo）；
`View` 的 `drawIsoMode` 覆盖层（2:1 栅格 / 半透明预览 / 足迹虚线 / 四角 + 高度抓手 / 尺寸浮标）与
直接操作（四角改宽深、黄块调高、整块移动，全部吸附栅格，松手才落笔）；参数条 `ui/iso.tsx`；
入口按用户要求放**魔法球**（画布球不放）+ 主菜单。口径与计划见 `docs/PLAN-isobuilder.md`，
接口见 docs/API.md §6d。
等距对齐 + 功能专属图标（同日第二轮反馈「iso 生成的图形没有与网格对齐 / 新功能图标重复分不清」）：
`isoRender` 的 `originAt` 从「stamp 左上角」改成**格 (0,0) 顶面菱形的顶点**（`g0.ox + c`）——
stamp 从 `-T/2` 起画，早先的锚点比顶点偏左 `T/2`，栅格 / 足迹虚线 / 抓手就整体比图形偏左半格；
新增 `isoOnLattice()`（节点要求 x/(T/2) 与 y/(T/4) **同奇偶**）与 `isoSnapOrigin()` 的最近节点吸附
（分别取整会吸到 `(0, T/4)` 这种格子边缘中点）、`isoPlaceOrigin()`（越界只能沿等距轴挪格，
早先按 x / y 各自加减 T/2 / T/4，挪完就离开栅格）；iso 模式期间 `drawIsoGuide()`（30° 参考网格）
主动不画（30° 与 2:1 不可能重合，两套网格并存 = 「没对齐」的观感）。
新增 `src/ui/feature-icons.ts`：**每个功能入口一个专属 SVG**（`i-iso` / `i-ca` / `i-shade` /
`i-remap` / `i-skew` / `i-mesh` / `i-snap` / `i-snap-half`，画在 `app2/www/index.html` 的 sprite 里），
分组 = 同一屏同时出现的入口，组内不得重复；主菜单 / 调色板动作行 / 魔法球 / 选择球 / iso 参数条全部接线。
接口见 docs/API.md §6d + §17.5，`tests/icons.test.ts` 校验组内唯一与存在性。
手势状态机分片搬出（P5，同日）：`src/servers/input.ts`（策略与算术的纯函数，+47 断言）与
`src/servers/gesture.ts` 的 `TapMachine`（轻点序列：单击 / 双击边距·画布·换画布 / 三击 / 双指双击，
容差 480ms·64px·80px，`up()` 返回 `TapOutcome`，动作体仍在 `view.ts`，+44 断言）；
口径见 docs/API.md §15c / §15c2 / §15c3；搬的过程中发现**画布内三击够不到**（见 §7）。
手势控制器（同日第三节）：`GestureController` 接管 `onDown/onMove/onUp/onCancel` 约 850 行，
`View` 以 `GestureHost`（93 个成员）交出触点会话状态与各动作体；会话状态的结构体
（`XfSession` / `SelDragState` / `HoldState` …）从 `view.ts` 的字段声明里搬进 `servers/gesture.ts`；
`view.ts` 4668 → **3693 行**，新增 22 条假 host 断言（共 4085），`warpui.order.has-draw-overlay`
的静态扫描锚点随 `drawOverlay` 变公开而改成整行签名。
触点会话**所有权**迁移（同日第四片）：37 个会话字段（`pointers` / `fourSeen` / `pinchBase` / `hold` /
`longT` / `panLast` / `stroke` / `selDrag` / `xf` / `xfDrag` / `outline` / `path` / `isoDrag` /
`resizeDrag` / `cursor` / `mag` …）从 `View` 搬进 `GestureController`，`GestureHost` 从 93 个成员
瘦到 **54 个**（只剩方法 + `session` / `host` / 视口三元组 / `onFramePreview`）；
`View` 侧一律 `this.gesture.<字段>`（162 处），测试里的窥视改走 `v.gesture.*`（`warpui` / `xformui` /
`view` 三个白盒测试的 `VX` 类型同步扩了 `gesture`）。
数据安全收尾（自动保存多版本，同日）：`io/autosave.ts` 改成**环形槽位 + 小索引**——一个 object store 里
`index` 存版本表（新的在前）、`h0..h15` 十六个槽位装工程数据，每存一次只写一个槽位（`seq % 16`），
淘汰＝删索引尾部 + 删它占的槽位；**槽位数（16）必须大于最大保留数（12）**，否则新槽位会压到在册版本
（文件头写死的约束）；内容哈希相同时只更新「最近保存时间/原因」，不占新版本也不写大对象；
配额不足时**覆盖最旧那版占的槽位**（不新增占用），仍失败就一个旧版本都不动、回落到 localStorage；
旧版本只写的 `current` 在第一次读到时迁移成第 1 版。崩溃判定＝`pc.autosave.clean`：启动写 `0`、
切后台或 `pagehide` **同步**写 `1` 再 flush（异步 flush 在卸载时跑不完，漏标记就会误报崩溃）。
`Session` 侧新增 `checkBootCrash()`（挂 `bootRecover` → App 弹 `RecoverModal`）/ `restoreAutosaveVersion`
（面板已问过就 `{ask:false}`，避免连问两次）/ `exportAutosaveVersion`（导出 .pxc）/ `dropAutosaveVersion`；
设置项 `data.autosaveKeep`（1–12，默认 5）；UI 是 `AutosaveHistory`（设置 → 数据 内嵌、主菜单
「自动保存历史」、恢复提示三处共用）。存储布局与恢复流程见 docs/API.md §16.5 + §11，
新图标 `i-recover` 登记在 §17.5；`tests/autosave.test.ts` 用内存后端覆盖迁移 / 追加 / 去重 / 条数与字节淘汰 /
配额不足两种结局（+63 断言，共 4155）。无头 Edge 实测：3 版并存、恢复最早那版后再保存字节数一致
（内容真的换回去）、崩溃提示只在非正常退出时出现。
笔迹性能实测与基线（同日）：把「笔迹 overlay 层」列成性能最后一块**是个没验过的假设**，量完推翻 ——
新增 `toolchain/stress-stroke.mjs`（无头 Chromium + CDP，按 prefs 造最坏配置：512² 文档 / 12 图层 /
64px 笔刷 / 平铺九宫格 + 洋葱皮，包住 dispatchEvent 统计每步同步耗时，并读应用自己的渲染调试计数）。
两组数：1px·1 图层 = 每步 0.14ms / 峰值 0.5ms，重合成 35 次，合成峰值 0.6ms；
最坏配置 = 每步 0.45ms / **峰值 7.7–9.6ms**（两次可复现），重合成 39 次，合成峰值 0.7ms。
结论：**合成不是瓶颈**（overlay 省不到 5%，不做）；真正扎眼的是大笔刷的同步峰值，
怀疑在 `Stroke.stampCells()` 每步重建笔尖图案 + 每格新建数组（镜像 ×2、平铺 ×9）引发 GC。
基线表写进 `docs/COMPARISON.md` §三.1，AGENTS §7 记了「不做 overlay」的理由与下一步该做的去分配。
AI 本地工具服务（C0–C3，1.1.1.9 之后）：`src/app/ai-doc.ts`（`docDigest` / `readRegion` / `applyOps` 三个纯函数：
颜色身份 = RGBA 四通道、palette 写 `#rrggbbaa`、空 ops 恒 `ok`、cel 惰性创建、完全在画布外时 `w=h=0` 且 `x/y`
回显请求坐标）+ `src/app/ai-tools.ts`（**当时** 48 个工具 = read 4 / draw 38 / destructive 5 / ui 1；`callTool` 顺序固定
「校验 → destructive 确认 → 执行」；**tier 只决定要不要确认与 `listTools` 默认给不给，不决定能不能调**）
+ `src/app/ai-turn.ts`（一轮一条 undo + 回合期间不刷 autosave + `runAiTurn` 安全入口）+ `src/app/ai-rpc.ts`
（传输无关的协议路由，一份 `route()` 喂同步 / 异步两个入口）+ `src/app/ai-serve.ts`（JS 生命周期、`window.__pc_ai_call`、
诊断、回合收尾）+ `toolchain/ai-server.mjs`（Node 开发宿主）+ `android/java/com/pixelcraft/app/AiServer.java`
（纯 JDK 的 127.0.0.1 本地端口 + token）+ `MainActivity` 桥接。协议要点：health 由 TS 单源应答；`POST /ai` 9 个 call；
状态码 200 / 400 / 401 / 404 / 405 / 413 / 503；`Authorization: Bearer`；`envelope.body` 恒为 JSON 字符串而
health 的 body 是空串；异步挂起走空串 + `PixelBridge.aiRespond`（只认第一次）；destructive 的 `confirm` 默认
**一律拒绝**（确认 UI 属 C5）。回合三道收尾闸门：路由抛异常 / 嵌套 `turn_begin` 先 rollback（带 warn）/
空闲 300s 无请求自动 rollback。设置项 `ai.server` / `ai.port` / `ai.tier` / `ai.turnIdleSec`
（默认 `false` / `8787` / `read` / `300s`）。**APK 新增 `INTERNET` 权限**（Android 上监听本地端口也要它）：
服务默认关闭、只绑 `127.0.0.1`、应用不发起任何出站请求。接口见 `docs/API.md` §21–§24，缺口见 §7。
AI 工具面与电脑侧入口（本轮，1.1.1.9 之后）：**P1 像素级绘制工具面** —— 新适配层 `src/app/ai-draw.ts`
（组合 `Stroke` 笔迹 / 形状 / 油漆桶 / 擦除 + `engine/effects.ts` 的 8 个既有特效 + `tools/xform.ts` 纯仿射与
`tools/select.ts` 浮动模型；**不 import `History`**，历史一律由 `Stroke.commit()` / `Session.maskOp()` 压栈，
`tests/ai-draw.test.ts` 用与 `ai-tools.test.ts` 同一条静态规则盯着）把 13 条新工具（`draw_path` / `draw_shape` /
`fill` / `erase` / `transform` / `fx_outline`+`fx_inline`+`fx_shadow`+`fx_glow`+`fx_invert`+`fx_gray`+
`fx_round`+`fx_blur`）接到工具表：48 → **61 条 = read 4 / draw 49 / destructive 7 / ui 1**（`erase` / `transform`
归 destructive —— 它们删 / 移已有像素）。**C4 电脑侧 MCP 入口**：`toolchain/pc-mcp.mjs`（stdio 换行分隔
JSON-RPC 2.0 ↔ 本机 `POST /ai`，`tools/list` 现取现映射、`tools/call` 不吞错；宿主配置示例见 `docs/API.md` §25）
+ **P7 电脑桌面壳** `toolchain/pc-shell.mjs` / `pc-shell.cmd`（伺服站点 + 同端口 `/ai` + SSE 把请求转发进
窗口页面，协议与 APK 的 `AiServer.java` 一致；`--token` / `AI_TOKEN` 真正生效、banner 文案改准）。
**C5 应用内助手**：`src/app/ai-chat.ts`（OpenAI 兼容整轮循环 + 预览后应用 + 失败一律 rollback）+
`src/ui/AiPanel.tsx`（对话 / 调用摘要 / 应用·放弃 / destructive 复用 `askConfirm`）+ `CHAT_SETTINGS`
（`ai.chatOn` / `ai.chatEndpoint` / `ai.chatModel` / `ai.chatKey`：**单独一张表不并进 `SETTINGS`**、key 走
`SETTING_SECRET_PATHS` 不进导出、文本行走 `SettingDef.text` **不新增 `SettingKind`**）+ 主菜单入口与
`i-ai-chat` 图标。接口见 `docs/API.md` §22.8 / §25 / §26，缺口与取舍见 §7。
AI 助手浮窗化 + DeepSeek 预设 + 环境 key 同源代理（P8，2026-09-17）：助手从「主菜单里的整屏子面板」
改成**浮动小窗 + 可最小化为浮动球** —— 新文件 `src/ui/AiWindow.tsx`（`createPortal(document.body)` 的容器：
标题栏拖动柄 / 最小化 / 关闭 + 右下角缩放抓手），对话面板与助手小球 `ChatBall` 在 `src/ui/AiPanel.tsx`，
浮窗与小球的**纯几何与归一化**（`pc.aichat.win` / `pc.aichat.ball`、夹取、坏数据回落）在 `src/app/uibar.ts`
（有单测）；小球是**独立小球**、**没扩 `ORB_IDS`**（仍是 5 个），只与五球系统共享「触屏下收起别人的展开环」
这一条规则。状态机与 `pc-back` 全在 `src/ui/App.tsx`，**最小化 = 浮窗 DOM 真的卸载**，而「卸载时留不留这一轮」
只看 Session 实况（`aiPanelDropsTurnOnUnmount()`）—— 最小化按钮 / 双击标题栏 / 返回键 / 关窗**同语义**，
不再有第二份标志位可漂移。设置面：新文件 `src/app/ai-presets.ts`（**DeepSeek 默认预设**：`https://api.deepseek.com`
+ `deepseek-v4-pro`，可切 `deepseek-flash`；切预设只写 endpoint/model、**绝不碰 key**，切到 `custom` 一个字段都不写），
`CHAT_SETTINGS` 扩到 **14 条**（预设 / 直连地址 / 轮数 / 温度 / 补充提示词 / 流式 / `ai.protectKey` / 三条窗口状态），
`ai.chatEndpoint` / `ai.chatModel` 的默认值改成从预设表取（「开箱即用」）。电脑侧壳新增
**模型请求的同源代理** `GET /provider/config` + `POST /provider/chat`（`toolchain/pc-shell.mjs`）：key 从环境变量
（`DEEPSEEK_API_KEY` → `OPENAI_API_KEY` → `PC_AI_KEY`，或显式 `--provider-key`）读，页面只拿一个布尔与公开的
端点 / 模型名，**真 key 一个字节都不进页面**；响应原样透传（唯一例外＝壳把自己那把 key 擦成 `…尾4`），
错误码九档由页面翻成人话；env 来源只发**白名单主机 + `https:`**。**两条真浏览器缺陷**（`GET` 带 body 被抛
`TypeError` 又被 `catch` 静默吞掉、代理 URL 拿 provider 基地址拼前缀导致跨源）只有打真壳 + 无头 Edge 才暴露出来
—— 单测 7500+ 条全绿也照样漏过去，这是"必须端到端跑一次"的现成例子。断言 7527 → **7639**，产物重建后
`check-bundle` exit 0。接口见 `docs/API.md` §26（26.1–26.6），缺口见 §7。
UI 独立成库（2026-09-20，主题：`deer-ui` 成为**真正独立的开源 UI 库**，PixelCraft 只是第一个消费者）：
库仓库在 `Z:\deer-ui`（= `github.com/DeerLuuu/deer-ui`，PUBLIC，MIT，包名 `deer-ui@0.1.0`、`private: true`）。
① **库能「没有 PixelCraft 在场」装 / 测 / 构建**：真 `package-lock.json` 入库、删掉所有指向 `../pixelcraft` 的隐式回退
（`tsc-path.mjs` / `link-dev-deps.mjs` 都改成必须显式给来源）、应用侧的断言记账搬回应用、CI 恢复成真文件、
补 `prepare` 让「从 git 装」真能编出 dist；② **样式与令牌搬进库**（`src/styles/{tokens,kit}.css` →
`dist/styles.css` 17,790 B / 92 块 + `exports["./styles.css"]`），应用 `src/ui/style.css` 只剩自己的规则
（91,245 B / 784 块），产物由新脚本 `scripts/build-css.mjs` 拼成「库段在前 + 应用段在后」；
③ 应用 `src/ui/kit/**` 与 `src/ui/{tooltip,tabs}.tsx` 改为从 `deer-ui` 薄再导出，vendor tarball 换成库产物；
④ **等价判据三层**：扁平规则多重集合 sha256 全等（876 = 92 + 784）、`app.js` 逐字节未变、
**无头 Edge 真渲染**（524 + 699 元素的 computed style + 布局矩形，深色/浅色/强制 `:hover/:active/:focus` 三档）差异 0，
注入 1px 当场变红；断言 8,090 → 8,119 → **8,134**（应用）/ 61 → 123 → **134**（库），一条没消失。
缺口与待办见 §7 新增的三条，完整执行记录见 `docs/PLAN-deer-ui.md` §10。

---

## 9. 文档地图

| 文档 | 内容 |
|---|---|
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | **发展路线蓝图**：分期（立刻 / 近期 / 中期 / 远期）的 38 条可验收路线项（每条含目标 / 为什么现在 / 落点 / 验收口径 / 优先级 / 依赖 / 风险）、与既有计划的去重对齐与真冲突、文档漂移校正表 D1–D25、明确不做 21 条、必须先问用户 Q1–Q14、待验证清单、真机验证计划 —— **规划新工作时先读它**，再看下面这些细节文档 |
| [`docs/PLAN-deer-ui.md`](docs/PLAN-deer-ui.md) | **UI 独立成 `deer-ui` 库的方案 + 执行记录**：可抽取边界与分档取舍、包结构与构建发布与三端约束、分期迁移（A0/P0–P8）与可测验收、防分叉与风险登记；**§10 是本轮执行记录**（库独立安装 / 样式移库 92↔784 / 应用消费与三层等价判据 / 已知缺口与待办）—— 要动样式、令牌或 kit 控件**先读 §10** |
| [`README.md`](README.md) | 项目概览、功能清单、快速开始、目录结构与架构要点 |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | **架构现状 + Server 化 + 模块化**（盘点与目标设计）：分层与规模实测、数据模型与不变量、运行时主链路、能力域、实测依赖现状与三处硬伤、15 个 server 的职责与所有权、算法类清单、目标依赖图、信号总线；**§4 模块化**（Server 与 Module 正交、21 个可裁剪模块与 manifest 契约、`modules.config.json` → 生成静态 import → esbuild 剔除、能力位与"格式永远是超集"、四个预设、体积估算、M0–M4 分期与风险）；绞杀者迁移分期 P0–P8、红线、决策点 |
| [`docs/API.md`](docs/API.md) | 全部模块的 API 接口文档（签名 / 参数 / 返回值 / 用法）与扩展指南（新增工具 / 设置 / 导出格式 / 引导步骤） |
| [`docs/UI.md`](docs/UI.md) | **UI 规范**：设计令牌（尺寸/主题色/固定色）、`src/ui/kit` 控件 API、迁移清单、组件与令牌测试约定、演示页 |
| [`docs/PC.md`](docs/PC.md) | **电脑模式（PC）适配清单与后续建议**：已完成能力表 + 20 条待办建议（含代码位置） |
| [`docs/COMPARISON.md`](docs/COMPARISON.md) | 与 Aseprite / Resprite 的对比、痛点复盘与优先级（含最新进展表） |
| [`docs/COMPARISON-pixelover-pixelcomposer.md`](docs/COMPARISON-pixelover-pixelcomposer.md) | 与 PixelOver / Pixel Composer 的三方对比（只比 2D）：速览表 + 能力大对照表 + 差异化优势 + 缺口清单（含来源与待核清单） |
| [`docs/PLAN-isobuilder.md`](docs/PLAN-isobuilder.md) | **等距构建（三视图 → 等距像素画）的可行性方案**：上游功能拆解、视觉外壳算法、像素几何口径、与现有能力的映射、分期计划与工作量、风险与落地文件清单 |
| [`docs/PLAN-ai.md`](docs/PLAN-ai.md) | **AI 接入方案与分期进度（C0–C5 已落地）**：三个轴（操作 / 生成 / 理解）拆解、三条路线（应用内助手 / 本机工具服务 / 先做地基）与工作量、工具面与权限分级、文档文本化与 token 预算、AI 回合事务、key 与本地端口的安全模型、风险表、待决策问题、落地文件清单与实际进度表（§10）；**接口契约 §5.1 的偏差订正**（palette 含 alpha、`AiSessionLike`、空 ops 恒 ok、`commitTurn(): boolean`、`runAiTurn` 安全入口等）。实现接口见 `docs/API.md` §21–§26（ai-doc / ai-tools / ai-draw / ai-turn / AI 本地工具服务 / MCP 入口 / 应用内助手） |
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

### 10.4 语言：一律简体中文

- **和用户对话、写文档 / 注释 / 提交信息 / 更新日志，一律用简体中文**（用户点名要英文时除外）。
- **不要混繁体字**。用户明确提过：「请使用简体中文回答我」。曾经有过整段回复里出现
  「這 / 據 / 儲 / 節 / 讀 / 換 / 於 / 時 / 會」这类繁体字的记录（这一行是举例，末尾带 `zh-hans-allow` 豁免）
  —— 长段落写完**回头扫一遍**再发。zh-hans-allow
- 仓库文本由 `tests/hans.test.ts` 静态兜底：扫描源码 / 文档 / 脚本，出现**繁体专用字**就测试失败
  （两体同形的字如「件 / 置 / 存 / 息」不在表里，不会误报；表本身写在那个文件里）。
- 专有名词保持仓库既有写法（`view.ts`、`PixelCraft`、`Aseprite`、`IndexedDB`、`esbuild`），不要硬翻；
  命令、路径、代码标识符照抄（`sh scripts/publish-web.sh`、`app2/www/js/app.js`）。
- 面向用户的产品文案仍是**中英双语各一条**（见 §5.3），简体中文那条照本条规则写。
