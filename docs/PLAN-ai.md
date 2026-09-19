# AI 接入（应用内助手 / 本地工具服务 / MCP）· 方案与决策

> 状态：**C0–C5 已落地**（方案 2026-09-14 定稿；分期进度见 §10，落地文件见 §8，接口文档见
> [`docs/API.md`](API.md) §21–§26）。C4 = 电脑侧 MCP 入口 `toolchain/pc-mcp.mjs`（+ 桌面壳
> `toolchain/pc-shell.mjs`），C5 = 应用内助手 `src/app/ai-chat.ts` + `src/ui/AiPanel.tsx`，
> 另有一批 P1 像素级绘制工具（`draw_path` / `draw_shape` / `fill` / `erase` / `transform` / `fx_*`×8，
> 落笔在 `src/app/ai-draw.ts`）。决策点见 §7，本文只保留方案与契约。
> **P8（助手窗口化 + 浮动球 + DeepSeek 预设 + 环境 key 与同源代理）的接口契约定稿在 §3.7** ——
> 通路做了实测（2026-09-16，结论与最初的假设相反：**DeepSeek 的 API 确实回 CORS 头，页面直连是通的**，
> 代理的四条理由与实测记录见 §3.7.1）。
> **接口以代码为准**：§5.1 是「照着写代码用的」契约，落地过程中出现的偏差已逐条订正（见 §5.1 末尾
> 「落地后的订正」），改动都写了为什么。
> 本文只讨论**怎么让 AI 操作这个软件**；「AI 直接生成像素画」当作工具表里的一个工具，见 §1.1。
> 相关：`AGENTS.md`（工程约定）、`docs/API.md`（现有接口）、`docs/PLAN-isobuilder.md`（同格式的姊妹方案稿）。

---

## 0. 结论摘要

1. **能做**，而且这个项目比一般绘画软件好接：`engine/*` 全是纯函数、`Session` 是唯一改动入口、
   `Session.allActions()` 已经是一张可调用动作表、全量回归能在 Node 里跑（无 DOM）。
   「AI 调用工具」在这里就是调 `Session` 方法，**不需要模拟手指点画布**。
2. **三条路线**：**A** 应用内助手（key + 聊天窗 + function calling）、**B** 本机工具服务（外部 AI 驱动）、
   **C** 先做与 AI 无关的地基（工具表 + 文本化文档 + 回合事务）。
   **建议顺序 C → B → A**：先让「AI 能对这张画布做什么」变成一套可测试的 API，再决定 AI 跑在哪。
3. **三条硬约束先定**（§3.6）：① 加任何联网（**包括监听本地端口**）都要加 `INTERNET` 权限，
   现有 APK 的「纯离线」承诺会被打破；② 线上 PWA 绝不能内置 key（Pages 是公开页面）；
   ③ AI 改像素必须「预览 → 应用」两段 + 一轮一条可撤销历史，否则会毁图。

---

## 1. 目标与非目标

### 1.1 三件不同的事，别混在一起

| 轴 | 是什么 | 例子 | 本项目成本 | 本文定位 |
|---|---|---|---|---|
| **操作**（tool calling） | AI 调我们的工具去改画布 | 「在 (8,8) 画一个 16×16 的史莱姆轮廓」 | **低**（工具面基本已存在） | **地基**（全文主体） |
| **生成**（文/图生像素） | 模型直接产出像素 | 「生成一张 32×32 的蘑菇」 | 中（云端图像模型；手机上跑本地模型不现实） | 工具表里的 `generate_sprite` |
| **理解**（视觉问答） | 模型看图给建议 | 「这套配色的对比度够吗」 | 中（合成 PNG → 视觉模型） | 工具表里的 `render_preview` + 建议类工具 |

判断依据：**操作轴的每一条都能落到已有函数**（见 §4 映射表），另外两轴都要额外引入模型与网络。
所以先把操作轴做成「一套可测试的工具 API」，生成与理解随时能作为工具挂上去。

### 1.2 非目标（本期明确不做）

- **不把 `.pxc` 整个喂给模型**：里面有历史、有全量 cel 数据，又大又没必要（§3.2 给替代方案）。
- **不做像素级视觉回环**（截图 → 模型逐像素猜 → 再截图）：又贵又慢又不可靠，除非是验收/配色这类粗粒度问题。
- **不在 Android 里实现完整 MCP 传输层**：MCP 的传输（stdio / streamable HTTP）在电脑侧实现成本是几十行，
  在 Android 侧要重做一遍（§3.5）。
- **不做云端账号体系 / 团队协作 / 云端存储**。

---

## 2. 现状盘点（源码事实，不是设想）

| 已有能力 | 位置 | 对 AI 接入的意义 |
|---|---|---|
| 引擎全是纯函数、无 DOM、无 React | `src/engine/*`（paint / shape / effects / resample / iso / shading / color-analysis / tags / ops / history） | 「工具」＝调函数，可在 Node 里直接跑与被测试 |
| 唯一改动入口 `Session` | `src/app/session.ts`（**4,700 行 / 444 个成员 / 379 个公开成员**，按 LF 计数） | AI 只需要一个 `Session` 句柄，不需要 UI |
| 动作表 + 动作目录 | `Session.allActions()` / `actionById()` / `registerOrbCatalog()`；`src/ui/App.tsx` 里注册 **54+** 条 `{id,label,icon,group,run}` | **工具 schema 的现成来源**；`ActionSearchModal` 已经是它的 UI 壳 |
| 一切可撤销 | `engine/history.ts`：`record` / `pushPixels` / `pushStruct`；`Session.struct()` | 一轮 AI 操作可合成**一条** undo（§3.3） |
| 无 DOM 回归套件 | `tests/`（**8090 条断言**，`node .ts-out/tests/run-tests.js`） | 工具层可以像引擎一样被回归测试，不需要模拟器 |
| 文档即数据 | `Doc` / `Cel.data`（RGBA `Uint8ClampedArray`）/ `palette: RGBA[]` / `Sel.mask` | 可以给模型**文本化视图**：32×32 只有 1024 像素，token 便宜（§3.2） |
| 工程文件与图片 IO | `io/project.ts`（`.pxc`）、`io/aseread.ts` / `io/asewrite.ts`、`io/exporters.ts`（`pngBytes` / `encodeGIF`） | AI 可读写工程、导出预览图 |
| 合成器能出图 | `render/compositor.ts`（`composeRectInto` 等） | 需要「给模型看一张图」时用它合成 PNG |
| 笔迹内核 | `tools/stroke.ts`（`Stroke` 类 + `ToolKind`：pencil/eraser/bucket/airbrush/line/rect/ellipse/circle/polygon/polyline/curve） | 可无 UI 实例化，是「程序化绘制」的落点 |
| 画布上限 | 全项目 **1024×1024**（`Math.min(1024, …)` 出现在尺寸相关入口） | 决定文本化的窗口策略（§3.2） |

**现有缺口**（= 本期要补的，全部是"没有"，不是"坏了"）：

| 缺口 | 说明 |
|---|---|
| 没有任何 tool schema | 动作表有 id/label，但**没有参数签名、类型、范围、返回值** |
| 没有「文档 → 文本」与「文本 → 操作」的桥 | 模型看不见画布，也没法安全地写回 |
| 没有无 UI 的绘制入口 | 笔迹由 `View` 创建（`new Stroke(...)`，见 `render/view.ts`）；`Session.quickFill()` 还依赖 `view_`；特效走弹窗流程（只有投影有两处直调 `fxE.dropShadowCel`） |
| 没有「AI 回合」概念 | 现在是"每个操作一条历史"，AI 一轮几十个操作会灌爆 120 条历史的上限 |
| 全仓库零网络代码 | `src/` 里没有一处 `fetch` / `XMLHttpRequest` / `WebSocket`（只有注释里的链接）；`AndroidManifest.xml` **只有 `VIBRATE`** |

---

## 3. 关键设计

### 3.1 工具面（tool surface）

分三层，**默认只暴露前两层**：

| 层 | 内容 | 例子 | 给 AI？ |
|---|---|---|---|
| **L1 文档读写** | 读摘要 / 读窗口 / 应用操作 / 查询选区与图层帧 | `doc_digest`、`read_region`、`apply_ops` | 只读默认给，写入受权限控制 |
| **L2 绘制与编辑** | 笔迹与形状、填充、渐变、特效、变换与缩放、图层帧、调色板、标签 | `draw_path`、`fill`、`fx_outline`、`scale`、`add_layer` | 给（分级，见 §3.6） |
| **L3 会话与 UI** | 撤销重做、播放、导出、打开某个弹窗 | `undo`、`export_png`、`open_dialog` | 只给少数几个（撤销/导出）；**打开弹窗不暴露** |

工具粒度原则：

1. **一次调用＝一件事**，但接受数组参数（`draw_path` 收整条折线，`apply_ops` 收一串操作），
   避免几十次往返；
2. **参数越界不静默钳制**：现在 UI 会 `Math.min(1024, …)` 兜底，但工具返回里必须带上
   `clamped: true` 与最终值，否则模型会以为画在 A 处其实画在 B 处；
3. **返回结构化结果**：`{ ok, opId, changed: {pixels, rect}, docRev, warn? }`，
   其中 `docRev` 是文档版本号（`Doc.pixelRev` 一类的既有机制），模型据此判断"我的改动生效了吗"；
4. **schema 从两处生成**：`Session.allActions()`（UI 动作）+ 手写的引擎工具表（绘制类）。
   前者给 id/label/group，后者给参数与返回值 —— **两者共用同一个 `id` 命名空间**，
   这样界面定制、快捷键、AI 工具指向的是同一批动作。

schema 草案（设计示意，不是最终代码）：

```jsonc
{
  "name": "draw_path",
  "title": "画一条路径",
  "tier": "draw",                     // read | draw | destructive | ui
  "params": {
    "points":   { "type": "array", "items": "xy", "min": 1, "max": 4096 },
    "tool":     { "type": "enum", "values": ["pencil","line","rect","ellipse","bucket"] },
    "size":     { "type": "int", "min": 1, "max": 64, "default": 1 },
    "color":    { "type": "color", "default": "fg" },   // 支持 "#rrggbb" / "#rrggbbaa" / "fg" / "bg"
    "sym":      { "type": "enum", "values": ["off","h","v","both","4"], "default": "off" },
    "layer":    { "type": "int", "default": "current" },
    "frame":    { "type": "int", "default": "current" }
  },
  "returns": { "changed": "rect|null", "docRev": "int" }
}
```

### 3.2 文本化文档视图（模型怎么"看见"画布）

三个纯函数（放 `src/app/ai-doc.ts`，无 DOM，可单测）：

| 函数 | 作用 | 输出规模 |
|---|---|---|
| `docDigest(doc)` | 摘要：尺寸、图层（名/可见/锁定/不透明度）、帧、标签、调色板、内容包围盒、非空像素比例、当前选区范围 | 数百 token，恒定 |
| `readRegion(doc, {x,y,w,h}, opts)` | 一块区域的**调色板索引网格**（索引 → 调色板，透明度单列），可选 RLE | 见下表 |
| `applyOps(doc, ops)` | 把一组结构化操作写回文档（只走引擎与 `Session`，不碰 UI） | — |

格式提案（索引网格；`.` = 全透明，`a`–`z`/`A`–`Z` 循环映射调色板下标，超过 52 色时退回两字符十六进制）：

```
digest: 32x32 | layers: ["bg","sprite"] | frames: 3 | tags: [{"idle",0,2}] | colors: 12 | bbox: (6,4)-(24,20)
palette: 0=#1a1c2c 1=#5d275d 2=#b13e53 3=#ef7d57 4=#ffcd75 …
region (x=8,y=8,w=16,h=8) @frame 0, layer 1:
y= 8 ........aaabbbbb..
y= 9 .......aabbbbbccc.
…
```

**token 预算**（按 ASCII 约 3.5 字符/token 估）：

| 画布/区域 | 字符数 | 约 token | 结论 |
|---|---|---|---|
| 16×16 全图 | ~290 | ~90 | 随便读 |
| 32×32 全图 | ~1.1k | ~320 | 默认全图可读 |
| 64×64 全图 | ~4.2k | ~1.2k | 可读，但每轮都读会贵 |
| 128×128 全图 | ~16.6k | ~4.8k | **按窗口读** |
| 1024×1024 全图 | ~1.05M | ~300k | **不可能**，只能窗口 + 摘要 |

所以规则是：**≤64×64 允许全图读；更大一律走 `readRegion` 窗口 + `docDigest` 摘要**，
并且"写"优先用**命令**（画一条线、填一块）而不是"回写整个网格" —— 命令的 token 成本与画布大小无关。

### 3.3 AI 回合事务（一轮 = 一条 undo）

现状：每个操作一条历史，`prefs.histSteps` 默认 120 条 —— AI 一轮几十次调用会把用户的历史挤掉。
设计：新增一层"回合"，把 AI 的全部改动合并成一条可撤销记录（复用既有 `doc.capture()` + `History.record`）：

```ts
beginAiTurn(label: string): number      // 打开回合（返回 turnId），期间所有写操作只累积不动历史
previewTurn(): { count: number; rect: Rect | null }   // 预览：这一轮会改哪块
commitTurn(): boolean                   // 落一条历史（结构快照），关闭回合；无改动返回 false（不是失败）
rollbackTurn(): void                    // 放弃：恢复到回合开始的状态
```

> 落地订正：这里早先写的是 `commitTurn(): void`，实际返回 `boolean`（无改动 / 回合没开时是 `false`），
> 因为调用方必须能区分「落了一条」和「什么都没改」。另外新增了单一安全入口
> `runAiTurn(label, fn)`（见 §5.1 末尾），C3/C5 的复合流程用它，协议动词不要用。

- **中间不刷历史、不刷 autosave**（沿用 `docs/API.md` 里 `struct()` 的既有做法）；
- 工具报错、模型超时、用户点取消 → 一律 `rollbackTurn()`；
- 一轮的历史标签形如 `ai: 描出史莱姆轮廓并铺底色`，在历史面板里能一眼认出；
- **建议默认"预览后应用"**：AI 的改动先画在覆盖层（复用 `View.drawOverlay()` 的浮动预览通道），
  用户点"应用"才 `commitTurn()` —— 这一条能避免绝大多数"AI 把图改坏了"。

### 3.4 视觉回环：什么时候值得

| 场景 | 值得截图吗 | 理由 |
|---|---|---|
| 找像素坐标、对齐、逐像素改 | ❌ | 文本网格精确得多；视觉模型数不清像素 |
| 配色 / 对比度 / 构图评价 | ✅ | 这是视觉模型擅长且文本难以表达的 |
| 导出前的"验收" | ✅（1 次，低分辨率） | 一次调用换一次确认 |
| 生成图之后的选优 | ✅ | 图像模型出来的结果本来就得看 |

成本控制：`render_preview` 只合成合成图（`compositor`）→ 缩放到 256–512px 再编码，**不要**发原图。

### 3.5 三条路线与传输层

| | A 应用内助手 | B 本机工具服务 | C 地基（本期建议先做） |
|---|---|---|---|
| 谁在驱动 | 应用自己（应用内聊天窗） | 外部 AI（手机上的 agent / 电脑 / Claude Desktop） | — |
| 网络 | 出网调模型 API | 只开 `127.0.0.1` 监听 | 无 |
| 权限 | 需要 `INTERNET` | **同样需要 `INTERNET`**（见下） | 不需要 |
| 工作量（估） | ~1 周（含 UI、key、错误处理） | 3–4 天 | 2–3 天 |
| 主要风险 | key 泄漏、离线承诺、成本 | 端口安全、驱动方需要环境 | 做完还"看不见效果" |

**关于权限的一个硬事实**：Android 上**监听本地端口也要 `INTERNET`** —— socket 创建受该权限门控
（[socket EPERM 的典型表现](https://codemia.io/knowledge-hub/path/javanetsocketexception_socket_failed_eperm_operation_not_permitted_1)、
[「不用 INTERNET 权限能不能 ServerSocket」的讨论](https://cloud.tencent.cn/developer/ask/sof/829926?from=16139)）。
若一定要保持"零联网权限"，只剩 Android 的 `LocalSocket`（unix domain socket，同机 App 之间），
但**电脑端就连不进来了**，而且需要另找驱动方。所以 B 路线也要在 manifest 里加 `INTERNET`，
只是**可以不真的出网**（默认不调任何外部 API）。

**MCP 的方向性**：MCP 是「宿主 → 工具服务」。要让 AI 操作**我们的软件**，我们必须当 **server**。
应用内助手是 client，只能连别人的 server —— 这跟"让 AI 画我们的画"是两件事。
最省力的 MCP 落地方式：

```
Claude Desktop / 你的 agent ──stdio MCP──> pc-mcp（电脑侧，几十行转发）
                                              │  HTTP + token（127.0.0.1 或 adb reverse）
                                              ▼
                                   PixelCraft（Android，B 路线的工具服务）
```

电脑侧用 `adb reverse tcp:8787 tcp:8787` 把手机的 127.0.0.1 端口映射到电脑本地，
不用暴露局域网，也不用改手机网络。

### 3.6 安全与隐私模型

**key 存哪**：

| 形态 | 方案 | 风险 |
|---|---|---|
| APK | `EncryptedSharedPreferences`（或至少 `SharedPreferences` + 明示） | 被 root 设备读取；设置页要能一键清除 |
| PWA（本地打开） | 用户自填，存 `localStorage`，仅在用户自己的浏览器里 | 中（同源的脚本都能读） |
| **PWA（Pages 线上）** | **绝不内置 key**，也不建议填 | 页面公开，任何访问者都能拿到；这是红线 |
| 推荐形态 | key 只放在**用户自建网关**（一个小代理），应用只连网关 | 最低：手机上没有 key |

**本地工具服务的门禁**（B 路线）：

1. 只绑 `127.0.0.1`，端口随机（写进设置页可见，可关闭）；
2. 每次启动生成 token（对端要带 `Authorization`），token 在界面上显示/重置；
3. **权限分级**并在界面上常驻提示"外部正在控制"：

| tier | 例子 | 默认 |
|---|---|---|
| `read` | 摘要、读区域、读调色板 | 允许 |
| `draw` | 画线、填充、加图层、改调色板 | 允许（可关） |
| `destructive` | 删图层/帧、清空画布、缩放画布、替换文档 | **每次弹确认**（复用现有确认框机制） |
| `ui` | 打开弹窗、切工具 | 默认**不暴露** |

4. **数据外发清单**要写在设置页里（用户能看清会发什么）：只发文本网格 / 摘要；缩略图仅在你按"让 AI 看看"时发；
   工程文件与原始像素默认不上传。

---

### 3.7 助手窗口化 + 浮动球 + DeepSeek 预设 + 环境 key 与同源代理（P8，接口契约定稿）

> 本节是**接口定稿**，不写实现。三期之外的三个实现任务（W1 通路与 key / W2 设置模型 / W3 窗口与球）
> 一律以本节为唯一契约：签名、路径、持久化键、可测口径都写死在这里；实现者不要自己另立口径，
> 发现本节与代码事实冲突时**先改本节**再改代码（与 §5.1 末尾的"订正"同一个做法）。
>
> ## ⚠️ 实施结果与本节的三处偏差（P8 落地后补记，**以代码为准**）
>
> P8 已落地（`✅` 见 §10）。落地时有三处改了做法、另有两条**真浏览器缺陷**是本节没预见到的，
> 全部记在这里，免得下一个人照着定稿把已经修好的东西"改回去"：
>
> | 定稿 | 实现 | 为什么 |
> |---|---|---|
> | 新建 `src/ui/ChatBall.tsx`（小球单独一个文件） | 小球 `ChatBall` **落在 `src/ui/AiPanel.tsx`** | 小球与面板共用一个交互闭环（点球还原 → 面板要显示），拆成两个文件要多开一层 prop 传递；`src/ui/AiWindow.tsx` 确实被拆出来了（它是容器 + 几何） |
> | 窗口状态放 `SESSION.prefs.aiWinOn` / `aiMin`；几何由 `SESSION.aiWinLayout()` / `setAiWinLayout()` 管 | 状态放 `CHAT_SETTINGS`（`localStorage["pc.aichat"]` 的 `winOpen` / `winMin` / `ball`）；几何由 **`AiWindow` 自己读写 `pc.aichat.win`**，纯函数在 `src/app/uibar.ts` | `prefs` 会随工程 / 设置导出走，而"这台机器这个屏幕上的窗口"不该跟着走；几何规则要能单测，所以抽成 `uibar.ts` 的纯函数而不是 Session 上的两个 getter（也就没动 `session.ts`） |
> | `ai.protectKey` 等五条高级项放 `SETTINGS`（组 `ai`） | 五条全落 `CHAT_SETTINGS`（组 `chat`） | `tests/ai-rpc.test.ts` 的 `settings.visible.on` 把 `ai` 组钉成恰好四条，而 §3.7.8 只授权改两条断言。代价：这五条**不进设置导出**（详见 §3.7.7 的偏差说明） |
>
> **两条真浏览器缺陷**（单测 7500+ 条全绿也照样漏过去，是 P8 复验时打真壳 + 无头 Edge 才暴露的；
> 两条都只在本节的口径上"看起来对"，实际把整条代理打死）：
>
> 1. `detectChatProxy()` 探 `GET /provider/config` 时带了 `body: ""` —— 真浏览器对 `GET`/`HEAD`
>    带 body 直接抛 `TypeError`，而当时外面那层 `catch { return null }` 把它**静默**吞成
>    「这台机器没有代理」。于是整条同源代理在真浏览器里从来没通过，页面上只是悄悄回落直连；
>    假 fetch（单测用的）不校验 method/body 组合，所以 7527 条断言照样全绿。**修法**：不 body，
>    并在 `tests/ai-chat.test.ts` 配一个按真浏览器规则校验的假 fetch（`strictFetch`）盯住它。
> 2. 代理 URL 写成 `<壳报回来的 providerBase>/provider/chat` —— `providerBase` 是**上游**地址
>    （`https://api.deepseek.com`），于是请求被发去 `https://api.deepseek.com/provider/chat`
>    （生产）或假 provider 的地址（自测），全是**跨源**、必然 `Failed to fetch`。
>    定稿 §3.7.3 要的一直是**同源**；**修法**：`chatProxyUrl()` 恒返回相对路径 `/provider/chat`。


#### 3.7.1 通路：先证伪，再定方案（附实测记录）

任务书给的假设是"页面直连 provider 行不通，所以必须代理"。**实测结论：这条假设不成立**
（DeepSeek 的 API 确实回 CORS 头），所以本期的代理**不是**为绕 CORS 而做，理由换成下面四条硬理由。
两件事都要写进代码注释，免得下一个人照着错误的假设去"修"一个不存在的 CORS 问题。

实测环境：`node toolchain/pc-shell.mjs --port 8901 --no-open`（真壳，含 `window.PixelBridge` 注入）+
`msedge --headless=new --remote-debugging-port=<port>`（Edge 153）+ CDP `Network.enable` 记录全部请求。
探针页面从**壳自己的源**加载（`http://127.0.0.1:8901/_probe_cors.html`，用完即删）：

| 场景 | 浏览器看到的请求序列 | 结果 |
|---|---|---|
| **同源**（页面 → 壳） | `POST http://127.0.0.1:8901/shell/handshake`，**无 preflight** | `200`，回 `{"ok":true,"token":"…","port":8901,"ai":false}` |
| **跨源 → DeepSeek** | `POST https://api.deepseek.com/v1/chat/completions` → `OPTIONS`（`Origin: http://127.0.0.1:8901`、`Access-Control-Request-Headers: authorization,content-type`） | `OPTIONS 200`，回 `access-control-allow-origin: http://127.0.0.1:8901` + `access-control-allow-headers: authorization,content-type` + `access-control-allow-methods: POST` + `access-control-allow-credentials: true`；随后 `POST 401`（假 key）——**fetch 拿到了响应体，没有 CORS 报错** |
| **跨源 → 无 CORS 头的端点**（`api.anthropic.com`） | `OPTIONS` → 响应 `403`，**无 `access-control-allow-origin`** | `fetch` 抛 `Failed to fetch`；CDP：`net::ERR_FAILED` + `corsErrorStatus.corsError = "PreflightMissingAllowOriginHeader"` |
| **`file://` 源 → 本机回环**（模拟 APK） | `OPTIONS http://127.0.0.1:8901/shell/handshake`，`Origin: file://` | `405` 且无 CORS 头 → `PreflightMissingAllowOriginHeader`；而且**回环目标会先收到一次 preflight**，等于"本机服务被动收到跨源探测" |
| **`file://` 源 → DeepSeek** | `OPTIONS` → `access-control-allow-origin: file://` | `POST 401`，**读得到响应体**（DeepSeek 对 `Origin: file://` 也放行） |

四条由此得出的结论（都写进实现注释）：

1. **"跨源一定被拦"是错的**：能不能直连完全取决于**对端有没有回 CORS 头**。同一个浏览器里
   DeepSeek 能直连、Anthropic 不能。所以"直连"是一条**随对端配置而变**的路，不能作为默认通路。
2. **写超时/错误文案必须区分**：直连失败时 `fetch` 抛的是笼统的 `Failed to fetch`（拿到 `status` 的机会都没有），
   端点 4xx/5xx 才有状态码 —— 这正是 `ai-chat.ts` 现在把两者分开写文案的原因，别合并。
3. **代理的四条硬理由**（与 CORS 无关）：
   · **key 不出现在页面里**（环境变量那份 key 一个字节都不进页面，§3.7.4）；
   · **用户不用手填 key**（电脑侧只要环境里有 key 就能用）；
   · **错误信息可控**（壳能把 409/502/504 翻译成一句人话，直连只剩"连不上端点"）；
   · **对端 CORS 不再是变量**（页面只连自己的源）。
4. **`file://` 不是天然屏障**：APK 页面的源是 `file://`，DeepSeek 照样放行。所以
   `MainActivity.java` 目前**没有**开 `setAllowUniversalAccessFromFileURLs`（L88–101 只有
   `setJavaScriptEnabled` + `setAllowFileAccess`）并不妨碍 APK 直连 provider；
   它的作用是"拦住对**其它**站点/本机其他服务的跨源访问"，不是拦 provider。这一条直接决定 §3.7.5 的范围。

#### 3.7.2 同源代理：壳体新增端点（壳侧，`toolchain/pc-shell.mjs`）

**放在哪一层**：放在**壳体**（`pc-shell.mjs` 的 `handler()` 路由表），**不**放进 `src/app/ai-serve.ts`、也
**不**套用现有的 `POST /ai` 通道。理由：现有通道的协议是 `ai-rpc`（9 个 call、状态码口径、tier 门禁全在
`docs/API.md` §24），往里加一个"转发模型请求"的 call 会把两件事糅在一起；壳体的转发是**纯传输**，
与它现在转发 `/ai` 进页面是同一类工作，放这里不需要动页面里的业务层。

| 项 | 定稿 |
|---|---|
| 路径 / 方法 | `POST /provider/chat`（模型请求）；`GET /provider/config`（页面探测配置）；`OPTIONS /provider/*`（回 `204` + CORS 头，只在壳端口上，供同源/`file://` 双端） |
| 请求体 | OpenAI 兼容原样转发：`{ model, messages, tools?, tool_choice?, temperature?, max_tokens?, stream:false }`。壳**只**补 `Authorization`，不改其它字段；`stream:true` 直接回 `400`（本期不做流式） |
| 壳补充的字段 | `Authorization: Bearer <壳侧 key>`；`model` 缺省时用壳的默认模型（§3.7.4） |
| 响应 | 把 provider 的 **HTTP 状态码与 body 原样透传**（2xx/4xx/5xx 都一样）。这样页面侧的 `httpError()` 按状态分档的文案**一行不用改**；`{"error":{"message":…}}` 那条分支也照旧命中。**唯一例外 = 把自己那把 key 擦掉**（见下） |
| 鉴权（对页面） | `POST /provider/chat` 要壳的通道 token：优先 `Authorization: Bearer <通道token>`，**兼容** `X-Shell-Token: <通道token>`（`ai-chat.ts` 永远会写 `Authorization`，加个自定义头更干净）。`GET /provider/config` **不要 token**（它不泄漏任何机密，见下），拿它当"这个壳有没有代理"的探测点 |
| 页面怎么拿通道 token | `window.PixelBridge.aiServerStatus()` 已经回了 `{"running","port","token"}`（`pc-shell.mjs` L413）。代理模式**复用**它，**不新增桥方法**；页面把结果缓存进内存（进程级 `let`，**不写 localStorage**）。未握手 / 取不到 token 时按"代理不可用"处理，回落到直连（见 3.7.3） |
| 超时 | 复用壳的 `--timeout` / `PC_SHELL_TIMEOUT`（默认 10000ms），超时回 `504` |
| 体积上限 | 复用 `MAX_BODY_BYTES`（1 MiB），超了 `413` |
| 其他 | `OPTIONS` 之外的非 GET/POST 一律 `405`；路径不认识按现有口径 `404`；`/provider/*` 与 `/ai*`、`/shell/*` 一样**不落静态文件分支** |

**`GET /provider/config` 响应**（**绝不含 key 的任何片段**，连尾 4 位都不给）：

```json
{ "ok": true, "proxy": true, "baseUrl": "https://api.deepseek.com",
  "defaultModel": "deepseek-v4-pro", "models": ["deepseek-v4-pro","deepseek-flash"],
  "hasEnvKey": true, "keySource": "env" }
```

`keySource` 取 `"env" | "cli" | "none"`；`hasEnvKey` 就是 `keySource !== "none"` 的布尔。页面**只**读
`baseUrl` / `defaultModel` / `models` / `hasEnvKey` 这四个字段 —— 这正是"页面只拿同源 URL + 一个布尔"的口径。

**错误码 → 文案映射**（左列是壳回的状态码，右列是页面最终显示的那句话；壳的 body 用
`{"ok":false,"error":"<code>","detail":"…"}`，`detail` 里**绝不放 key**）：

| 状态 | `error` | 页面文案（落点是 `ai-chat.ts` 的 `httpError()`） |
|---|---|---|
| `409` | `no-key` | 端点拒绝了这个 key（HTTP 409）：本机壳里没有可用的 API key：设 `DEEPSEEK_API_KEY` 后重启壳，或在设置里手填 |
| `400` | `bad-request` / `no-model` | 端点返回 HTTP 400：<detail> |
| `401` | `unauthorized` | 本机壳的通道 token 不对（重启壳后刷新页面） |
| `403` | `forbidden` | 本机壳拒绝了这次转发（<detail>） |
| `404` | `not-found` | 老版本壳没有代理端点 → 页面**静默回落直连**（见 3.7.3），不弹错 |
| `413` | `body-too-large` | 请求太大（上限 1 MiB）：对话太长，清一下会话 |
| `502` | `provider-unreachable` | 连不上端点（<detail>）：检查这台设备的网络 |
| `504` | `provider-timeout` | 端点没在 N 秒内回：<detail> |
| 其它 4xx/5xx | 原样透传 provider 的 | 走 `httpError()` 现有四档（401/403、404、429、其它） |

**CLI / 环境变量新增**（`pc-shell.mjs` 的 `parseArgs`，argv 覆盖 env，与现有 `AI_PORT` 等同一风格）：

| 名字 | 默认 | 说明 |
|---|---|---|
| `--provider-key <k>` | 空 | 显式给转发用的 key（**最高优先级**；不入日志、不入 banner 全文，只打印尾 4 位） |
| `--provider-base <url>` | `https://api.deepseek.com` | 转发目标基地址 |
| `--provider-model <m>` | `deepseek-v4-pro` | 壳的默认模型（页面没给 `model` 时用） |
| `--no-provider-proxy` | 关 | 关掉 `/provider/*`（`/provider/config` 回 `{"ok":true,"proxy":false}`） |

**落地补记（P15 第 2、4 项）——透传的例外与 env 的闸门**：

1. **壳回写前必须把自己那把 key 擦掉**（`scrubProviderKey()`）：provider 完全可能在错误体里把收到的
   `Authorization` 回显出来，而页面会把 4xx body 前 120 字拼进错误行 ⇒ 环境 key 明文进页面 DOM
   （评审的对抗实测命中过 `Bearer sk-fake-env-7777`）。所以透传**唯一**的例外是把
   `opts.providerKey` 打成 `…` + 尾 4 位（覆盖 `Bearer <key>` / JSON 同形 / 裸 key，大小写不敏感），
   其余字节一字不改，并按新长度重写 `content-length`。打码形态与 banner / 诊断一致。
2. **环境变量来源必须同时过「白名单主机 + `https:`」两道闸**：只判主机的话
   `--provider-base http://api.deepseek.com:8080` 会通过主机检查、然后把环境 key 明文发到那个
   明文端口上。被拒时 banner 讲明原因（`协议不是 https，key 会明文出网` / `主机不在白名单`）。
   **显式 `--provider-key` 不受这道闸门限制**（本机假 provider / 自建网关的自测通道）。

#### 3.7.3 页面侧怎么用代理：**零改动面**的口子

设计目标：`src/app/ai-chat.ts` 的 214 条既有断言**一条都不动**（`aichat.http.auth` 钉死了
`Authorization: "Bearer <key>"`，所以不能改成"永远不带 Authorization"）。做法是**只加一个哨兵常量**，
把"谁负责真 key"这件事交给注入的 `fetchFn`：

```ts
// src/app/ai-chat.ts 新增（唯一改动）
/** 代理模式哨兵：key 由本机壳持有，页面不拿。传它 = requestModel 不发 Authorization，改发 X-Provider-Key */
export const AI_CHAT_HOST_KEY_SENTINEL = "__pc-host-key__";
```

`requestModel()` 的头拼装改成（**非哨兵路径逐字不变**，所以既有断言不受影响）：

```ts
headers: opts.key === AI_CHAT_HOST_KEY_SENTINEL
  ? { "Content-Type": "application/json", "X-Provider-Key": "host" }
  : { "Content-Type": "application/json", Authorization: "Bearer " + opts.key },
```

`src/ui/AiPanel.tsx` 的 `platformFetch()` 扩成两态（**这是本设计里页面侧唯一的"通路开关"**）：

```ts
// 探针：GET 同源 /provider/config（壳不在 → fetch 抛 → 直连；老壳没有端点 → 404 → 直连）
type ChatTransport = { mode: "proxy"; base: string; hasEnvKey: boolean } | { mode: "direct" };
async function detectTransport(): Promise<ChatTransport | null>   // null = 配置探测都没做完
function proxyFetch(base: string, shellToken: string): ChatFetch  // 把 url 重写成 base + "/provider/chat"，带壳 token
```

判定顺序（**决定"谁在花钱"**，必须是这个顺序）：

1. 用户在设置里**手填了 key**（`ai.chatKey` 非空）→ **直连**（用户的 key 用户自己管，行为与今天完全一致）；
2. 没有手填 key，且 `/provider/config` 可用且 `hasEnvKey` → **代理**（`key: AI_CHAT_HOST_KEY_SENTINEL`）；
3. 没有手填 key，也没有代理 → 在面板顶部显示 3.7.4 的三态提示条，**不发请求**。

**页面侧的信息面**（只允许这些进页面）：同源 `baseUrl` 字符串、`defaultModel` 字符串、`models` 字符串数组、
`hasEnvKey` 布尔、壳的通道 token（内存）。**永远不进页面的**：环境变量里的 API key；
`/provider/config` 的响应体里也不含它，所以"页面内存、DOM、console 都不出现环境 key"这条是可测的。

#### 3.7.4 key 来源：优先级、环境变量名、页面显示

**优先级（定稿）**：

```
① 用户在设置里手填的 ai.chatKey（非空即生效）→ 页面直连，key 只在本机页面的 localStorage
        ↓（手填为空）
② 宿主环境 / CLI 提供的 key → 同源代理，key 只在壳进程内存里
        ↓（两者都没有）
③ 无 key → 面板显示提示条，不发起任何请求
```

- **判定时机**：②在**壳启动时**读一次（`parseArgs`，argv 覆盖 env），之后**不再重读** ——
  改了环境变量要**重启壳**。这句写进 `--help` 与设置页提示（否则用户会以为改了就生效）。
- 页面**每次打开面板**探一次 `/provider/config`（不轮询、不缓存跨会话）。
- 手填 key 是**清空**不是"删除标记"：清空后自动落回②（环境 key）——设置页的 `aiChatKeyClear`
  按钮文案后要补一句"（清空后会改用本机环境变量里的 key）"。

**环境变量名清单与优先级**（`pc-shell.mjs` 的读取顺序，第一个非空即用）：

| 顺序 | 名字 | 为什么是这个顺序 |
|---|---|---|
| 1 | `DEEPSEEK_API_KEY` | DeepSeek 官方文档给的用法就是它（`-H "Authorization: Bearer ${DEEPSEEK_API_KEY}"`），预设也是 DeepSeek |
| 2 | `OPENAI_API_KEY` | 换 OpenAI / 兼容网关时最通用的那个名字 |
| 3 | `PC_AI_KEY` | 本项目自有名：给"不想污染全局环境变量"的场景兜底 |

注意与**已有**的 `AI_TOKEN` 区分：`AI_TOKEN` 是**壳 ↔ 页面的通道 token**，不是 provider 的 key，两者
**不得混用**；`--provider-key` 也不接受 `AI_TOKEN` 作为别名。

**页面显示的三态**（不能显示假 key，也不能说"没配"）：

| 状态 | 设置页 / 面板显示 | 触发条件 |
|---|---|---|
| 手填 | `手填 key ✔` | `ai.chatKey` 非空（**只显示有无，不回显内容**；输入框本身是 `password`） |
| 环境 key | `本机环境变量 ✔` + 端点显示壳报的 `baseUrl`；**没有回显字段，没有"清除"按钮** | 手填空 + `/provider/config.hasEnvKey` |
| 无 key | 提示条：`没有可用的 API key：设 DEEPSEEK_API_KEY（或 OPENAI_API_KEY / PC_AI_KEY）后重启桌面壳，或在下面手填` | 两者都无 |

**诚实边界（写进设置页与 §7 缺口）**：`ai.chatKey` 是**用户自己手填**的，按 §3.6 的存储模型它就在页面的
`localStorage` 里，同源脚本读得到 —— 本轮**不**改这一点。所以"key 不进页面"这条**只对②（环境变量来源）成立**。
UI 文案不许把它说成"任何 key 都不在页面里"。

**落地补记（P8 + P15）**：

- 三态文案的最终形态见 `docs/API.md` §26.3（i18n 键 `aiChatKeyManual` / `aiChatKeyEnv` / `aiChatKeyNone` +
  警告条 `aiChatKeyNoneHint` + 说明行 `aiChatKeyEnvHint`），比定稿的 `手填 key ✔` 说得更准
  （"本机环境变量已提供 key（key 不在页面里）"）。
- ②的**闸门收紧了**：env 来源要求「白名单主机 **且** `https:`」两道都过（见 §3.7.2 的落地补记第 2 条），
  所以「换一个 `--provider-base` 就自动关掉转发」这句要按 §3.7.2 的细则读。

#### 3.7.5 APK 侧范围：本轮只做电脑侧

**结论**：本轮**只做电脑侧**（`pc-shell.mjs` 的代理 + 环境变量 key），Android 侧只把协议口子留好，
**不写 Java 代理**。

- 事实一：**Android 没有环境变量**这种给宿主进程用的一等机制（`System.getenv` 在应用进程里只读得到
  系统属性，做不到"用户设一次就生效"），所以"环境 key"这条路在 APK 上不存在。
- 事实二：APK 的页面源是 `file://`。**桌面 Edge 的实测**（3.7.1 最后一行）说明 `Origin: file://`
  对 DeepSeek 放行 —— 但**那不等于 Android WebView 的行为**：`MainActivity` 没有开
  `setAllowUniversalAccessFromFileURLs` / `setAllowFileAccessFromFileURLs`，而 WebView 默认
  对 `file://` 页面的**跨源 XHR/fetch 是拦的**。本机没有 Android 设备 / 模拟器，这一点**无法验证**
  ⇒ 按"没验证过的东西不进本轮"，**不能**再把「APK 直连是通的」当既成事实（P14 的范围订正）。
- 事实三：APK **已有** `INTERNET` 权限（`android/AndroidManifest.xml:13`，C3 加的），出站请求不受限。
- 因此 APK 今天仍是「手填 key + 直连」，**本轮不动它**；但**不能再说它「一定能用」**
  —— env 来源在 APK 上不存在，而直连能不能通取决于 WebView 对 `file://` 跨源的策略（事实二，未验证）。
  **结论（P14 订正）**：APK 里的助手**仍连不上（或至少未能确认能连上）真 provider，需要 Java 侧代理**
  —— 这正是 §7 缺口表里"Android 侧的模型请求同源代理"那一条的准确口径。
- 若以后要在 APK 上做同源代理（把 key 收进 `MainActivity` + `EncryptedSharedPreferences`，
  由 Java 转发模型请求），协议**照抄 §3.7.2**（同一路径、同一错误码、同一响应透传口径），
  Java 侧只需要多回一个 `Access-Control-Allow-Origin: file://`（它自己控制响应头，`file://` 源可达回环服务）。
  **为什么在 Windows 上无法真机验证**：本轮的开发与验证环境是 Windows + 桌面壳 + 无头 Edge，
  **没有 Android 设备 / 模拟器**（见 §7 的既有缺口），Java 侧那几十行属于"写完等于没测"的代码；
  按"没验证过的东西不进本轮"的口径，**明确不做**，记进 §7。
- 页面侧的降级路径是自动的：APK 里 `/provider/config` 探测失败（`file://` 上同源请求直接抛）→
  回落直连 → 与今天行为一致，**不会出现"点了没反应"**。

#### 3.7.6 窗口与球：容器、状态机、持久化

**容器（定稿）**：新建 `src/ui/AiWindow.tsx` —— 一个 **`createPortal` 到 `document.body`** 的浮窗，
自带标题栏（拖动柄 + 最小化 + 关闭）。**不再挂在 `MenuModal` 里**：

- `src/ui/modals.tsx:435-437` 的菜单项从 `setSub("ai")` 改为 `onOpenAiWindow()`（打开浮窗），
  菜单里**保留入口**（`guide="menu-ai-chat"` 不动 —— `aichat.menu.gated` 钉着这个串）；
- `src/ui/AiPanel.tsx` 保持"只做对话区"（消息流 / 调用摘要 / 应用·放弃 / 输入框），
  **原样搬进浮窗**，`onBack` 变成窗口的关闭按钮；`AiPanel` 自己的平台门（`if (!native)`）**不动**
  （`aichat.panel.gate` 钉着 `ai-no-bridge`）；
- 挂载点在 `src/ui/App.tsx`：`SESSION.prefs.aiWinOn === true` 且 `bridge.isNativeShell()` 时渲染
  `<AiWindow>`（与 `FloatingTools` 同层，`App.tsx:694` 附近）。

**状态机（定稿）**：

| 事件 | 从 | 到 | 副作用 |
|---|---|---|---|
| 菜单「AI 助手」/ `BallClick` | 关闭 | `win` | 写 `aiWinOn = true`；探一次 transport |
| 最小化按钮 / 标题栏双击 / `Esc` | `win` | `ball` | 写 `aiMin = true`；浮窗 DOM **卸载**（`display:none` 不算，`AiPanel` 的卸载钩子要跑：回合还开着就 rollback） |
| 点球（单击） | `ball` | `win` | 写 `aiMin = false`；**保留**对话与 `thread`（用 `SESSION` 侧或 App 层 state，不要因为卸载丢掉） |
| 关闭按钮 / `Esc`（在 `ball` 态） | `win` / `ball` | 关闭 | 写 `aiWinOn = false`；回合开着 → rollback；对话**保留**到下次打开（本轮不持久化对话，进程内保留即可） |
| 拖动标题栏 | `win` | `win` | 见下 |
| Android 返回键 | `win` | `ball` | 接 `pc-back` 事件（与 `FloatingTools` 同做法，`App.tsx:1153-1169`），**只是最小化**不关闭 |

- **拖动**：标题栏上 pointerdown → pointermove 跟手（`dx/dy` 偏移），pointerup 提交并写盘；
  松手前跑一次夹取：`x ∈ [8, innerWidth - w - 8]`、`y ∈ [8, innerHeight - h - 8]`。
- **缩放**：**可缩放，但只做"右下角一个抓手"**（双向缩放，`min 260×200`、`max = 视口 - 16`）；
  不做边/角八向抓手（收益低、触屏上易误触）。移动端（非 PC 模式）下浮窗宽度按 `min(w, 92vw)` 夹取。
- **持久化键（定稿）**：`localStorage["pc.aichat.win"]`，一个 JSON 对象：
  `{ "v": 1, "x": number, "y": number, "w": number, "h": number, "min": boolean }`。
  - **跨会话恢复口径**：启动时读一次；`x/y/w/h` 任一不是有限数字、或 `w/h` 超界 → 整份丢弃用默认值
    （默认：`w = 380`、`h = 460`、贴右下角 `x = innerWidth - w - 16`、`y = innerHeight - h - 16`）；`min` 只认 `true`；
  - **每次变化都写**（拖动结束 / 缩放结束 / 最小化切换），与 `pc.orb.pos` 的写法一致；
  - 布局由 `Session` 侧给两个 getter/setter：`SESSION.aiWinLayout()` / `SESSION.setAiWinLayout(patch)`
    —— **不塞进 `prefs`**（`prefs` 会随工程/设置导出走；窗口位置是"这台机器这个屏幕"的事，
    与 `pc.aichat`、`pc.orb.pos` 同一类）。**不新增 `SettingDef`**（没有用户要调的"值"）。

**浮球：独立小球组件（定稿选择）**

**不扩展 `ORB_IDS`。** 理由与代价都写在这里：

| 维度 | 方案 A：扩 `ORB_IDS` 到 6 个 | **方案 B：独立小球（选定）** |
|---|---|---|
| 连带改动 | `uibar.ts:43` 加一项；`tests/uibar.test.ts:25` 计数 5→6；`modals.tsx:1630` 遍历、`:1661` 类别导航；`App.tsx:1917 pieItemsFor`、`:1908 registerOrbCatalog`、球渲染分支；`guide-anchors.test.ts:44` 锚点清单 | 新增 `src/ui/ChatBall.tsx`（自持 localStorage 键、自持拖动/夹取/吸附）+ `uibar.ts` 加 `CHAT_BALL_ID` 常量 + `App.tsx` 挂载 |
| 既有断言 | 至少 `uibar.orbs`、`guide.orbs.*`、`icons.*` 三组要跟着改 | **一条都不用改** |
| 语义 | 新球会自动进**停靠/展开环/饼菜单/界面定制**那套系统，得逐个回答"它参与不参与"，每答一个都是一处特殊分支 | 只与五球系统共享**一条**规则：触屏下 68px 互斥。不参与停靠/环/饼 |
| 代价 | 五球系统的契约面被撬开 | 界面定制面板里**没有**它的球页（它没有子项，也不需要搬运）；`docs/UI.md` 要加一节 |

选 B 的核心理由：**五球（尤其 dock 拖动 + 展开环 + 饼菜单）是全仓库回归面最密的一块，
而助手球没有任何"子项"要被搬运或排序**——它就是一个"开关按钮"。用最小面积换零回归面，值。

**球的定稿口径**：

| 项 | 定稿 |
|---|---|
| 存在条件 | `bridge.isNativeShell()` && `SESSION.prefs.aiWinOn` && `SESSION.prefs.aiMin`（三者全真才画球） |
| 位置持久化键 | `localStorage["pc.aichat.ball"]` = `{ "x": number, "y": number }`，默认贴右下角（`innerWidth - ORB - 16, innerHeight - ORB - 32`——抬 32px 让开底栏） |
| 夹取 | 与 `FloatingTools` 同款：`x ∈ [8, innerWidth - ORB - 8]`，`y ∈ [8, innerHeight - ORB - 8]`；窗口 resize 后重跑一次夹取 |
| 尺寸 / 外观 | 复用 `.orb` 的类名与 `orbMetrics(pcMode)` 的 `M.orb`，**不新造球样式**；图标 `i-ai-chat`（`FEATURE_ICONS.menu.aiChat` 已有，`aichat.menu.icon` 钉着它） |
| 互斥 | 触屏模式：球落在别的球 68px 内时**只在"展开状态"上互斥**（点球 B 时收起其它球的**展开环**，球本身不动）——与 `FloatingTools` 的现有规则一致；PC 模式：不互斥 |
| 拖 vs 点 | 按下后位移 < 8px 视为**点击**（还原浮窗），否则视为拖动（松手不回窗）；复刻 `FloatingTools` 的 `moved` 标记做法 |
| 提示 | 长按/悬停 title = `aiChatOpen`（复用现有 i18n 键），不新增文案 |
| 引导锚点 | `data-guide="orb-ai"`。**`tests/guide-anchors.test.ts` 不用改**：`:44` 那行是白名单，但 `:40` 的正则 `/["']((?:btn\|menu\|orb\|tool\|pal-mode\|dlg)-[A-Za-z0-9_-]+)["']/g` 会把源码里的字面量 `"orb-ai"` 自动收进 anchors —— 只要字符串在源码里原样出现即可 |

**与既有 5 个球的关系（一句话）**：助手球是**第 6 个球的视觉邻居**，不是第 6 个"浮动球成员" ——
不参与停靠（`prefs.dockPos`）、不参与展开环（`ringSlots`）、不参与饼菜单（`pieEquip`）、
不参与 `prefs.orbPrefs`（顺序/隐藏）。

**新增设置/状态项（窗口与球相关的全部）**：

| 落点 | 名字 | 形态 | 默认 | 说明 |
|---|---|---|---|---|
| `src/app/uibar.ts` | `export const CHAT_BALL_ID = "ai"` | 常量 | — | 只做 id 与 `ballLabel` 的单一来源 |
| `src/app/settings.ts`（`CHAT_SETTINGS`） | `ai.chatWinOpen` | `bool` row | `false` | 浮窗开着没有；`visible` 同 `ai.chatOn` |
| 同上 | `ai.chatWinMin` | `bool` row | `false` | 是否已最小化成球 |
| 同上 | `ai.chatBall` | `bool` row | `true` | 是否允许显示浮动球（关掉 = 只能用菜单打开窗口） |

这三条**照旧不进 `SETTINGS`**（只进 `CHAT_SETTINGS`），**不新增 `SettingText` 之外的控件形态**、
**不新增 `SettingKind`**（否则 `aichat.setting.kind-pinned` 会红）。位置/尺寸走 `pc.aichat.win`，不做设置行。

**落地补记（as-built，逐条对着代码核过）**：

| 定稿 | 实现 | 说明 |
|---|---|---|
| 事件表含 `Esc`（开窗态 → 最小化；球态 → 关闭） | **没做**：`App.tsx` 没有为助手窗口挂 `Esc`（全应用只有「编辑界面模式退出」与「PC 收球」两处 Esc 处理器） | 浮窗是 `role="dialog"` 但**不是** `ui/kit` 的 `Dialog`（那个自带 Esc 关闭，而它会把浮窗包成遮罩弹窗，与"小窗"语义冲突）。已知偏差，记在这里 |
| 标题栏双击 —— 未提 | **双击标题栏 = 最小化**（与最小化按钮走同一个 `minimize()`） | 多出来的一条路径，语义一致 |
| 最小化只写状态 | 最小化**先把几何（含 `min:true`）落盘**再写状态 | 还原时要按同一份几何回来 |
| 拖动「松手提交并写盘」 | 每一帧跑夹取、**松手那一下才写盘**（与 `pc.orb.pos` 一致） | 拖动**从不累加**：每帧从按下那一刻的几何重算，否则夹取会把位置一点点往回挤 |
| `ai.chatWinOpen` / `ai.chatWinMin` 的 `visible` 同 `ai.chatOn` | 两条 `visible` **恒 false**；只有 `ai.chatBall` 可见 | 它们是**状态**不是用户要调的值，给一个「窗口开着吗」的开关没有意义（`aichat.setting.visible-on` 因此只列 `ai.chatBall`） |
| `ChatBall` 单独一个文件 | 落在 `src/ui/AiPanel.tsx`（见 §3.7 开头的偏差表） | 既有断言 `uibar.orbs`（仍 5）不用改 |

#### 3.7.7 设置模型：DeepSeek 默认预设 + 更完善的设置项

**DeepSeek 预设的权威事实**（2026-09-16 查 [api-docs.deepseek.com](https://api-docs.deepseek.com/) 与
[Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)，两者互相印证）：

| 项 | 值 |
|---|---|
| OpenAI 兼容 base_url | `https://api.deepseek.com`（**不带 `/v1`** 也是官方口径；带 `/v1` 同样可用，`chatCompletionsUrl()` 会补 `/chat/completions`） |
| 当前模型名 | `deepseek-flash`（DeepSeek-V4.1-Flash）、`deepseek-v4-pro`（DeepSeek-V4-Pro-0813）；**旧的 `deepseek-chat` / `deepseek-reasoner` 已不在官方文档里** |
| 官方示例里的 key 变量 | `DEEPSEEK_API_KEY` |
| Tool calls | 两个模型都支持（本助手整轮循环依赖它） |
| 思考模式 | 默认开启，`thinking: {type:"enabled"}` 显式开；本轮**不**发这个字段（保持 OpenAI 兼容最小面） |
| 是否存在 `/models` 列表端点 | 官方文档**没有**记载 → 预设的模型清单**写死在代码里**，不动态拉取 |

**预设 schema**（`src/app/settings.ts` 新增，与 `CHAT_SETTINGS` 同一张表）：

```ts
// 预设就是"一组默认值 + 一个可切模型清单"，不是新的存储层：切预设 = 一次 saveAiChatSettings(patch)
export interface AiChatPreset {
  id: "deepseek" | "openai" | "custom";
  label: string;              // i18n key
  baseUrl: string;            // 写进 ai.chatEndpoint 的值
  defaultModel: string;       // 写进 ai.chatModel 的值
  models: readonly string[];  // 可切模型清单（chips 用）；空数组 = 自由文本
}
export const AI_CHAT_PRESETS: readonly AiChatPreset[] = [
  { id: "deepseek", label: "aiChatPresetDeepseek", baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-v4-pro", models: ["deepseek-v4-pro", "deepseek-flash"] },
  { id: "openai",   label: "aiChatPresetOpenai",   baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini", models: ["gpt-4o-mini", "gpt-4o"] },
  { id: "custom",   label: "aiChatPresetCustom",   baseUrl: "", defaultModel: "", models: [] },
];
export const AI_CHAT_DEFAULT_PRESET = "deepseek";   // 默认预设 = DeepSeek
```

> 模型清单是**会过期的数据**（本仓库的历史上模型名换过至少一次）。所以：
> ①清单只放**当前官方文档里有**的名字；②`ai.chatModel` 永远是**自由文本**，清单只是快捷 chips，
> 用户可以填任何模型名；③改清单是普通代码改动，不涉及迁移。

**预设切换语义（定稿，逐条可测）**：

1. 设置页新增 `ai.chatPreset`（`enum`，默认 `"deepseek"`，`options = AI_CHAT_PRESETS`）。
2. **切预设 = 写 endpoint + model 两个值**（取该预设的 `baseUrl` / `defaultModel`），并记住 `ai.chatPreset`。
3. **切预设绝不碰 `ai.chatKey`**：既不覆盖、也不清空。断言：切换前后 `aiChatSettings().key` 与
   `localStorage["pc.aichat"]` 里的 `key` 一字不变。
4. **切到 `custom` 不清空** endpoint/model（`custom` 的 `baseUrl`/`defaultModel` 是空串，直接写会把用户
   填的东西抹掉）——`custom` 的语义是"别动这两个值，我去手填"。
5. **已有用户的首启迁移**：`ai.chatEndpoint` 为空且 `ai.chatModel` 为空时，首次读到设置就把
   `ai.chatPreset` 落成 `"deepseek"` 并**只在那一刻**写默认 endpoint/model（不是每次启动都写，
   否则用户手改成别的端点后会被反复覆盖）。判据：`localStorage` 里没有 `pc.aichat` 这个键 =
   从未配过 → 写预设；键存在但两个字段都空 = 用户主动清空的 → **只在 UI 上把预设 chips 高亮成
   `custom`**，不写盘。
6. **`ai.chatEndpoint` 的默认值从 `""` 改成 `AI_CHAT_PRESETS[deepseek].baseUrl`** ——
   这一条会动到既有断言 `aichat.setting.default-endpoint`（现在钉 `""`），**必须同步改这条断言**
   （改成 `"https://api.deepseek.com"`），并在测试里加一条"默认预设 = deepseek"的新断言。
   这是本期**唯一**需要改既有断言名的地方，明确写在这里以免实现者以为"不能改测试"。
7. 端点/模型仍是**自由文本行**（`text: "plain"`），chips 只是快捷入口：`aichat.setting.endpoint-text` /
   `aichat.setting.key-password` / `aichat.setting.no-new-kind` 三条断言全部保持。

**"更完善的 AI 设置"逐项清单**（全部落 `CHAT_SETTINGS`，**不并进 `SETTINGS`**）：

| path | kind/text | 默认值 | 选项 / 范围 | 进导出？ | 机密？ | 说明 |
|---|---|---|---|---|---|---|
| `ai.chatOn` | `bool` | `false` | — | 否（不在 `SETTINGS` 里） | 否 | 已有，不动 |
| `ai.chatPreset` | `enum` | `"deepseek"` | `deepseek` / `openai` / `custom` | 否 | 否 | **新增**；切换写 endpoint+model，不碰 key |
| `ai.chatEndpoint` | `text:"plain"` | `https://api.deepseek.com` | ≤2048 字符 | 否 | 否 | **默认值改了**（见上条第 6 点） |
| `ai.chatModel` | `text:"plain"` | `deepseek-v4-pro` | ≤2048 字符 | 否 | 否 | **默认值改了**（原 `""`，无断言钉它） |
| `ai.chatKey` | `text:"password"` | `""` | ≤2048 字符；`action` 清除 | **否**（`SETTING_SECRET_PATHS`） | **是** | 已有，不动；清除按钮文案补一句"清空后会改用本机环境变量里的 key" |
| `ai.providerBase` | `text:"plain"` | `""` | ≤2048 字符 | 否 | 否 | **新增**：手填 key 时的直连地址，留空 = 用 `ai.chatEndpoint`（给"key 走网关、地址又不同"的场景） |
| `ai.protectKey` | `bool` | `true` | — | ~~是（`SETTINGS`，组 `ai`）~~ → **否**（实现落在组 `chat`） | 否 | **新增**：决定状态行**要不要附那句与 key 有关的说明**（见下） |
| `ai.chatMaxRounds` | `int` | `12` | `1..24`（`AI_CHAT_MAX_ROUNDS`） | ~~是~~ → **否** | 否 | **新增**（组 `chat`）：整轮最多问几次模型，对应 `runChatTurn({maxRounds})` |
| `ai.chatTemp` | `int` | `0` ×0.1 | `0..20`（= 0.0–2.0） | ~~是~~ → **否** | 否 | **新增**：`temperature`；`0` 表示"不发送这个字段"（用端点默认） |
| `ai.chatSystemPrompt` | `text:"plain"` | `""` | ≤2048 字符 | ~~是~~ → **否** | 否 | **新增**：非空则**追加**到 `AI_CHAT_SYSTEM_PROMPT` 之后（不改内置提示词） |
| `ai.chatStream` | `bool` | **`true`** | — | ~~是~~ → **否** | 否 | **新增**：默认**开**（归一化 `o.stream !== false`）。**本行原写「固定 false（代理回 400）」已作废（2026-09 流式落地）**：壳走 `forwardToProviderStream()` 按 SSE 事件边界擦 key，页面逐块渲染，非 SSE 端点自动降级为整包且不重发（口径见 `docs/API.md` §26.6.1） |
| `ai.chatWinOpen` | `bool` | `false` | — | 否 | 否 | **新增**（见 3.7.6） |
| `ai.chatWinMin` | `bool` | `false` | — | 否 | 否 | **新增**（见 3.7.6） |
| `ai.chatBall` | `bool` | `true` | — | 否 | 否 | **新增**（见 3.7.6） |

关于"进导出"那两列的**来源**：只有写进 `src/app/settings.ts` 的 `defs`（`SETTINGS`）才会被
`exportSettings` 遍历；`CHAT_SETTINGS` 不参与导出（见 `settings.ts:240-244` 的注释与
`aichat.export.all-paths`）。所以"否"那几行的口径**天然成立**，不需要额外代码 ——
包括上面被划掉的五条（它们最终都在 `CHAT_SETTINGS` 里，因此都不导出）。

**`ai.protectKey` 的可测口径（P15 起它真的接上了效果）**：它**只**影响 `AiPanel` 顶部那行状态文本
`aiChatStatusText(cfg, hostKey, t, protectKey)` 里要不要**再附一句与 key 有关的操作说明**
（三态各一句常量 `AI_CHAT_KEY_HELP_MANUAL` / `_ENV` / `_NONE`）；开 = 附，关 = 只留状态行本身。
**两种取值产出不同文本**，所以这个开关是可测的（`proxy.status.protect-key.changes-text` /
`...prefix` / `...help-text` / `...no-key-text` / `...default-protected`）。

> **落地补记（P15 第 1 项）**：定稿把它的语义写成"禁止把 key 写进诊断 / toast / 日志文本"，
> 但那条**本来就由代码保证**（状态文本只拼"有无"，key 也从不进导出 / toast），于是它一度是个
> 「可见可改但零效果」的摆设。现在的语义是**上面这一句**（决定要不要附说明），
> 而「key 不进任何文本」这件事与它**无关**、任何取值下都成立：
> 把 `ai.chatKey = "sk-local-only"` 设上，跑一次 `aiChatStatusText()` 与 `exportSettings()`，
> 两边文本里都**不含** `sk-local-only`；把 `ai.protectKey` 设成 `false` 后**仍然不含**。
> `exportSettings` 里 `isSecretSettingPath` 那条守卫**不依赖**它（那是 `SETTING_SECRET_PATHS` 保证的），
> 两者别混。另外这三句是**中文常量而不是 i18n 键** ⇒ 英文界面下仍显示中文（记在 `AGENTS.md` §7）。

**落地补记（组归属的偏差）**：定稿把 `ai.protectKey` / `ai.chatMaxRounds` / `ai.chatTemp` /
`ai.chatSystemPrompt` / `ai.chatStream` 五条写在 `SETTINGS`（组 `ai`，因此**进导出**）；
实现时**五条全落 `CHAT_SETTINGS`（组 `chat`，不进导出）** —— `tests/ai-rpc.test.ts` 的
`settings.visible.on` 把 `ai` 组钉成恰好四条（`ai.server` / `ai.port` / `ai.tier` / `ai.turnIdleSec`），
而本节只授权改两条断言。代价：这五条不进设置文件导出，跨机器迁移要重填。


#### 3.7.8 不能回归的既有约束（逐条对应断言名）

| 约束 | 断言名（`tests/ai-chat.test.ts` 等） |
|---|---|
| `CHAT_SETTINGS` **不并进** `SETTINGS`：导出条数恒等于 `SETTINGS.length` | `aichat.export.all-paths`、`aichat.import.applied` |
| `SETTING_SECRET_PATHS` 含 `ai.chatKey`，且只有 1 条 | `aichat.import.secret-paths`（`[true,false,1]`） |
| 导出文件里没有 key 的路径、也没有 key 的文本 | `aichat.export.no-key-path`、`aichat.export.no-key-text` |
| `exportSettings` / `importSettings` 里的跳过守卫仍在 | `aichat.export.secret-guard` |
| `SettingKind` 仍只有四个字面量（文本行走 `SettingDef.text`） | `aichat.setting.kind-pinned`、`aichat.setting.no-new-kind` |
| key 行是 `text:"password"`，端点/模型是 `text:"plain"` | `aichat.setting.key-password`、`aichat.setting.endpoint-text` |
| 关着时 chat 组只显示 `ai.chatOn` 一行 | `aichat.setting.visible-off` |
| 打开后 chat 组的可见路径序列 | `aichat.setting.visible-on`（**新增设置项后必须显式列全**；as-built 是 **14 条**：`ai.chatOn` / `ai.chatPreset` / `ai.chatEndpoint` / `ai.chatModel` / `ai.chatKey` / `ai.providerBase` / `ai.chatMaxRounds` / `ai.chatTemp` / `ai.chatSystemPrompt` / `ai.chatStream` / `ai.chatThinking` / `ai.chatTimeoutSec` / `ai.protectKey` / `ai.chatBall` —— 两条窗口状态项 `visible` 恒 false，**不在**这一列里；**以 `tests/ai-chat.test.ts` 的 `aichat.setting.visible-on` 为准**） |
| 面板文本里不出现 key、不回显 key | `aichat.panel.no-key-in-text`、`aichat.native.hides-key` |
| 预览后应用（`commit:false` + 三个 Session 调用） | `aichat.panel.preview-then-apply`、`aichat.panel.commit-false`、`aichat.panel.unmount-rollback` |
| 平台门：普通浏览器里没有入口、没有输入框、不发请求 | `aichat.gate.*`（`menu-no-entry` / `no-input` / `no-pending` / `no-request` / `settings-no-key`） |
| 菜单项锚点与图标 | `aichat.menu.gated`、`aichat.menu.icon`、`aichat.panel.mounted` |
| 请求头仍是 `Authorization: Bearer <key>`（非哨兵路径） | `aichat.http.auth`、`aichat.http.ctype`、`aichat.http.url` |
| 缺 key / 缺端点时一个请求都不发、回合不开 | `aichat.nokey.calls`、`aichat.nokey.turn` |
| 401 文案里不含 key 明文 | `aichat.fail401.no-key` |
| 浮动球数量仍是 5（独立小球方案下**不用改**） | `uibar.orbs` |
| 引导锚点自动收集 + 球锚点白名单 | `tests/guide-anchors.test.ts:40/44` |
| 图标真实存在、组内唯一 | `icons.table.menu.unique` / `icons.table.menu.exists` / `icons.all-referenced-defined` |

**唯一需要改的既有断言**：`aichat.setting.default-endpoint`（`"" → "https://api.deepseek.com"`），
以及 `aichat.setting.visible-on`（把新设置项列全）。除这两条外，上面表里的断言**一个字都不许改**。

#### 3.7.9 落点文件清单（三个实现任务共用）

| 文件 | 改什么 | 归属 |
|---|---|---|
| `toolchain/pc-shell.mjs` | 环境变量/CLI 读取（`DEEPSEEK_API_KEY`→`OPENAI_API_KEY`→`PC_AI_KEY`、`--provider-*`）；`/provider/chat` + `/provider/config` + `OPTIONS`；错误码映射；banner 只打 key 尾 4 位 | W1 |
| `src/app/ai-chat.ts` | **只加** `AI_CHAT_HOST_KEY_SENTINEL` 常量 + 请求头三分支（哨兵走 `X-Provider-Key`）；`httpError()` 增加 409/502/504 三档文案 | W1 |
| `src/ui/AiPanel.tsx` | `detectTransport()` + `proxyFetch()`；顶部三态 key 提示条；`ai.protectKey` 生效 | W1 |
| `src/app/settings.ts` | `AiChatSettings` 扩字段、`normalizeAiChatSettings` 扩容、`AI_CHAT_PRESETS`、`CHAT_SETTINGS` 新增行（含预设行）、`ai.chatEndpoint` 默认值改 | W2 |
| `src/app/settings.ts`（`defs`） | ~~`ai.protectKey` / `ai.chatMaxRounds` / `ai.chatTemp` / `ai.chatSystemPrompt` / `ai.chatStream` 五条（进导出）~~ → **as-built 五条全在 `CHAT_SETTINGS`（不进导出）** | W2 |
| `src/ui/i18n.ts` | 上表每条新设置行的 `label` + `desc`，中英各一条 | W2 |
| `src/ui/AiWindow.tsx`（新） | 浮窗容器、拖动/缩放/夹取、`pc.aichat.win` 读写、最小化/关闭 | W3 |
| ~~`src/ui/ChatBall.tsx`（新）~~ → `src/ui/AiPanel.tsx`（as-built） | 独立小球、`pc.aichat.ball` 读写、点击还原、触屏互斥 | W3 |
| `src/ui/App.tsx` | 挂 `AiWindow`（`FloatingTools` 同层）；`pc-back` 最小化；`guideActions` 视需要加一步 | W3 |
| `src/ui/modals.tsx` | 菜单项 `setSub("ai")` → 打开浮窗；`ai.chatBall` 行（设置页自动生成，无需改渲染器） | W3 |
| `src/app/uibar.ts` | `CHAT_BALL_ID` 常量 + **浮窗/小球的纯几何与存储归一化**（as-built 都落在这里） | W3 |
| `src/app/ai-presets.ts`（**as-built 新增**） | 厂商预设表（DeepSeek / OpenAI / 自定义）+ `normalizePresetId` | W2 |
| `src/ui/style.css` | `.ai-win` / `.ai-win-head` / `.ai-win-grip` / 小球复用 `.orb` | W3 |
| `docs/API.md` §26（**as-built 没有新开 §27**，全部扩写在 §26 的 26.1–26.6） | 接口同步（§5.3 硬要求） | 集成任务 |
| `README.md` / `AGENTS.md` §2/§7/§8 | 功能表 + 桌面壳用法 + 缺口 | 集成任务 |

#### 3.7.10 给实现任务的可测验收口径（断言级）

1. **通路**：在壳里起无头浏览器，页面调 `GET /provider/config` → 200 且 body 里**没有** key 的字符；
   `POST /provider/chat` 带假 body → 壳按 provider 状态码透传；壳没设任何环境变量时 → `409 no-key`。
2. **key 不进页面**：把 `DEEPSEEK_API_KEY=sk-env-probe` 设给壳，页面里
   `JSON.stringify(localStorage)`、`document.body.innerHTML`、`console` 记录三处**都搜不到** `sk-env-probe`；
   同时 `GET /provider/config` 的响应文本里也搜不到。
3. **预设**：切 `deepseek` → `endpoint === "https://api.deepseek.com"` 且 `model === "deepseek-v4-pro"`；
   先填一把 key 再切三个预设 → key 一字不变；切到 `custom` → endpoint/model 保持切换前的值。
4. **窗口状态机**：`aiWinOn=true` 渲染浮窗、`aiMin=true` 只渲染球、点球后 `aiMin=false` 且浮窗内容还在；
   关窗后再开，对话还在（进程内）；`pc.aichat.win` 写入的值能在刷新后恢复；
   把 `localStorage["pc.aichat.win"]` 改成 `{"v":1,"x":"nope"}` → 用默认值，不抛异常。
5. **小球**：`ORB_IDS.length === 5` 仍然成立（`uibar.orbs` 不动）；源码里存在字面量 `"orb-ai"`
   （`guide-anchors` 自动收集通过）；`pc.aichat.ball` 的坏数据 → 回落默认位。
6. **不回归**：`tsc --noEmit` 0 错误；`node .ts-out/tests/run-tests.js` 末尾 `ALL PASS`；
   §3.7.8 表里的断言名**逐条**核对无改动（除 `aichat.setting.default-endpoint` /
   `aichat.setting.visible-on` 两条）。

**as-built 验证记录（P8 落地后，最终树上的实测）**：上面 6 条逐条跑过 —— 单测 `assertions: 7639 /
ALL PASS`；另有真壳 + 无头 Edge/CDP 的 43 条端到端断言全绿（浮窗开 / 拖 / 最小化为球 / 点球还原 /
刷新后几何复原；设置页 12 行 + DeepSeek chips 选中 + 端点与模型预填；env 来源经同源代理打到
真 `https://api.deepseek.com`（假 key）→ 上游 401 原样透传、页面显示 provider 档文案、页面四处
（localStorage / body / head / console）都搜不到那把 key；`--provider-key` + 回显型假 provider →
页面只看到 `…尾4`；无桥接静态页 → 无入口 / 无面板 / 无球 / **零** `/provider/*` 请求；
env + 白名单主机 + `http:` → 转发被关）。

---

## 4. 与现有能力的映射表（工具 → 已有实现）

| 工具 | 落到哪 | 现状 |
|---|---|---|
| `doc_digest` / `read_region` | 新写（读 `Doc` / `Cel` / `palette` / `Sel`） | 需新增（纯函数，易测） |
| `draw_path` / `draw_shape` | `tools/stroke.ts` 的 `Stroke` + `ToolKind` | **已落地**（`src/app/ai-draw.ts`）：`Stroke` 无 UI 实例化 + 参数适配层 |
| `fill`（油漆桶/渐变） | `engine/paint.ts`（区域填充与渐变）、`engine/shape.ts` | **已落地**（`src/app/ai-draw.ts`）：走 `Stroke(kind="bucket")`，含相似色容差 / 封口 / 渐变 / 全局填充 |
| `fx_*`（描边/内描边/圆角/模糊/反相/去饱和/投影/外发光） | `engine/effects.ts`（8 个函数） | **已落地**（`src/app/ai-draw.ts`）：8 个既有函数全给（`fx_outline` / `fx_inline` / `fx_shadow` / `fx_glow` / `fx_invert` / `fx_gray` / `fx_round` / `fx_blur`），作用范围 = 整个图层或当前选区 |
| `transform`（移动/缩放/旋转/斜切） | `tools/xform.ts`（纯函数层）+ `tools/select.ts` 的浮动模型 | **已落地**（`src/app/ai-draw.ts`）：`move` / `scale`（可镜像）/ `rotate`（带干净角吸附）三种 mode，口径与 `View.endXf()` 对齐；斜切仍只在 UI 里 |
| `warp`（四角/网格变形） | `tools/warp.ts` | 同上 |
| `scale`（高级缩放） | `engine/resample.ts` + `Session.scaleAdvanced()` | **已经是纯参数入口**，可直接暴露 |
| `iso_*`（等距体） | `engine/iso.ts` + `Session.isoGenerate()` | **已经是参数入口**，可直接暴露 |
| `shading`（色彩明暗） | `engine/shading.ts`（纯函数） | 有算法；需要面板之外的入口（`ShadingModal` 是 UI 壳） |
| `palette_*`（加/删/排序/合并/映射/由画布生成） | `Session.paletteMerge/paletteAdd/paletteSort/remapToPalette/paletteFromCanvas` | **已有方法**，直接暴露 |
| `color_*`（统计/近似色/替换/按色建选区） | `engine/color-analysis.ts` + `Session.analyseCanvas/replaceColour/selectColourPixels` | **已有方法**，直接暴露 |
| `layer_*` / `frame_*` / `tag_*` | `Session.layerAdd/frameAdd/tagAdd/…`、`engine/ops.ts` | **已有方法**，直接暴露（`destructive` 分级） |
| `selection_*`（框选/魔棒/取反/扩展/按色） | `tools/select.ts` + `Session.maskOp/wandAt/selectColourPixels` | **已有方法**（部分依赖屏幕坐标，需要文档空间包装） |
| `undo/redo` / `history` | `Session.undo/redo/jumpHistory` | 直接暴露 |
| `export_png` / `export_gif` / `export_aseprite` | `io/exporters.ts`、`io/project.ts`、`io/asewrite.ts` | 需要无 UI 入口（现在是导出弹窗流程） |
| `render_preview` | `render/compositor.ts` 合成 → `pngBytes` | 需要新写（合成 + 缩放 + 编码） |

结论（粗估，按上表逐条数的）：**约 2/3 的工具是「已有方法，缺 schema」，剩下 1/3 是「有算法，缺无 UI 入口」**。
这也是为什么 C 路线的工作量主要在"适配层 + 文本化 + 事务"，而不是重新实现功能。

---

## 5. 分期计划与验收

| 期 | 交付物 | 验收标准 | 影响面 |
|---|---|---|---|
| **C0** | `src/app/ai-doc.ts`：`docDigest` / `readRegion` / `applyOps`（纯函数） | `tests/ai-doc.test.ts`：摘要稳定、区域读取边界（贴边/越界/空图层）、索引↔RGB 往返、RLE 解析回环；断言数只增不减 | 不碰 UI、不碰权限 |
| **C1** | 工具表：`src/app/ai-tools.ts`（schema + 校验 + 调用分发 + 权限 tier） | `tests/ai-tools.test.ts`：每个工具的 schema 与实现一一对应、非法参数被拒且带原因、`destructive` 必须走确认回调；工具覆盖"§4 映射表"里标 "已有方法" 的全部条目 | 不碰 UI、不碰权限 |
| **C2** | 回合事务：`beginAiTurn/previewTurn/commitTurn/rollbackTurn` | 一轮 30 个操作后历史只多 1 条、rollback 后 `doc` 与新开时逐字节一致、autosave 只在 commit 后触发 | `session.ts` 小改 |
| **C3** | 本地工具服务（B）：Java 侧 `127.0.0.1` 端口 + token；JS 侧注册 handler；设置页开关与状态 | 真机上用 `curl` 能：读摘要、画一条线、撤销；关闭后端口立刻释放；`destructive` 工具触发确认框 | **manifest + INTERNET**、`MainActivity.java` |
| **C4** | 电脑侧 `pc-mcp`（stdio MCP 转发，几十行） | Claude Desktop / 任意 MCP 宿主能列出工具并画出东西 | 仓库外（或 `toolchain/`） |
| **C5** | 应用内助手（A）：设置页填 key、聊天窗、function calling 循环、预览后应用 | 一句话"画个史莱姆"→ 预览 → 应用 → 一条 undo | 新增 UI 面板；`INTERNET` |
| **P8** | 助手浮窗 + 可最小化为浮动球、DeepSeek 默认预设与更完善的设置项、电脑侧从环境变量读 key 并经**同源代理**转发模型请求（接口见 §3.7） | §3.7.10 的六条断言级口径；`ORB_IDS.length === 5` 与 §3.7.8 表里的断言名逐条不改 | `toolchain/pc-shell.mjs`、`src/app/settings.ts`、`src/app/ai-chat.ts`、`src/ui/AiPanel.tsx`、新增 `AiWindow.tsx` / `ChatBall.tsx` |

每期都保持「`tsc` 0 错误 + 全量测试 ALL PASS + 文档同步（§5.3）」的既有节奏；
C0/C1/C2 **完全不碰权限与网络**，即使后面改主意也不浪费。

### 5.1 接口契约（C0–C2 落地用）

这一节是**照着写代码用的**：签名、字段、失败口径都定死。改这一节等于改接口，必须先改文档再改代码。

#### C0 `src/app/ai-doc.ts`（纯函数，无 DOM、无网络）

```ts
interface AiDigest {
  docRev: number;                 // doc.pixelRev 快照：模型据此判断"我的改动生效了吗"
  w: number; h: number;
  layers: Array<{ li: number; name: string; visible: boolean; locked: boolean; opacity: number; blend: BlendMode }>;
  frames: Array<{ fi: number; ms: number; cels: number }>;
  tags: Array<{ name: string; from: number; to: number }>;
  palette: string[];              // "#rrggbb"；alpha < 255 时是 "#rrggbbaa"（C0 落地订正，见 §5.1 末尾）
  sel: { x: number; y: number; w: number; h: number; pixels: number } | null;
  bbox: { x: number; y: number; w: number; h: number } | null;   // 当前帧可见图层的非空包围盒
  inkRatio: number;               // 非透明像素占比，0..1，3 位小数
  text: string;                   // 单行摘要（§3.2 的格式）
  tokens: number;                 // ceil(text.length / 3.5)
}
docDigest(doc: Doc, opts?: { fi?: number }): AiDigest

interface AiRegion {
  x: number; y: number; w: number; h: number; fi: number; li: number;
  rows: string[];                 // 每行一个字符串：`.` = 透明，a-z/A-Z 循环映射调色板下标，>52 色回退两位十六进制
  palette: string[];              // rows 用到的颜色（子集），顺序 = 索引顺序
  clipped: boolean;               // 请求区域被文档边界裁剪过
  text: string;                   // 带 y= 行号的排版文本
  tokens: number;
}
readRegion(doc: Doc, rect: Rect, opts?: { fi?: number; li?: number; rle?: boolean; maxPixels?: number }): AiRegion
```

边界口径（每条都要有单测）：

1. `rect` 部分越界 → 裁剪并把 `clipped = true`；完全在文档外 → `rows` 为空数组 + `clipped = true`，**不抛异常**；
2. `li` / `fi` 越界 → 落到当前值并在 `text` 里带一行 `warn:`，不静默；
3. 空 cel / 该层该帧没有 cel → 全 `.` 行、`palette` 为空；
4. 索引色模式按文档调色板取索引；非索引模式按精确 RGB 匹配，未命中就追加到 `palette` 尾部；
5. `maxPixels` 默认 65536（256×256），超出时返回**最大可读窗口**并 `clipped = true` —— 绝不产生兆级字符串（§3.2 的 token 预算就是这条约束）。

```ts
type AiColor = string;            // "#rrggbb" / "#rrggbbaa" / "fg" / "bg"
type AiOp =
  | { op: "pixels"; x: number; y: number; rgba: [number, number, number, number] }
  | { op: "line"; x0: number; y0: number; x1: number; y1: number; color: AiColor; size?: number }
  | { op: "rect"; x: number; y: number; w: number; h: number; color: AiColor; fill?: boolean }
  | { op: "erase"; x: number; y: number; w: number; h: number }
  | { op: "fill"; x: number; y: number; color: AiColor; tolerance?: number };

interface AiApplyCtx {
  session: AiSessionLike;         // 只读 fg/bg/li/fi 四个字段；不是 `Session`（C0 落地订正，见 §5.1 末尾）
  fi?: number; li?: number;
  resolveColor?: (c: AiColor) => RGBA | null;
}
interface AiApplyResult {
  ok: boolean;
  applied: number;
  changed: { x: number; y: number; w: number; h: number } | null;
  docRev: number;
  warnings: string[];             // 含 "clamped: <字段> → <最终值>"（§3.1 原则 2）
  errors: Array<{ index: number; reason: string }>;
}
applyOps(doc: Doc, ops: AiOp[], ctx: AiApplyCtx): AiApplyResult
```

`applyOps` 的口径：

- **一次调用 = 一条事务边界**：只写像素（经 `engine/paint.ts`、`engine/shape.ts` 等既有函数），
  **不碰 history、不碰 autosave** —— 那是 C2 的事；
- 单个 op 非法 → 记进 `errors` 并跳过，其余照常执行（**部分成功是常态**，与 UI 的"空状态 toast"口径一致）；
- `ops` 为空 → `ok = true`、`applied = 0`、`changed = null`（不写像素），
  **与目标图层锁没锁无关**：「没有 op 可失败」不是失败，所以这条早退排在锁定检查前面
  （否则「锁定图层 + 空 `ops`」会给出 `ok:false` 且 `errors` 为空）；
- 写了但值没变（画同色）→ `applied` 计入、`changed` 仍返回矩形（调用方靠 `docRev` 判断）；
- 不直接改 `Doc` / `Cel` 之外的状态（图层、帧、调色板的增删属于 C1 的工具，不在这里）。

#### C1 `src/app/ai-tools.ts`

```ts
type AiTier = "read" | "draw" | "destructive" | "ui";
type AiParamType = "int" | "num" | "bool" | "string" | "enum" | "color" | "xy" | "rect" | "array";
interface AiToolParam { type: AiParamType; values?: string[]; min?: number; max?: number; default?: unknown; items?: AiParamType; desc?: string }
interface AiTool {
  id: string;                     // 与 Session.allActions() 同一命名空间
  title: string;                  // 纯文本（工具表这一层不翻译，UI 再查 i18n）
  tier: AiTier;
  params: Record<string, AiToolParam>;
  returns: Record<string, string>;
  handler: (args: Record<string, unknown>, ctx: AiToolCtx) => AiToolResult | Promise<AiToolResult>;
}
interface AiToolCtx {
  session: Session;
  confirm: (req: { tool: string; tier: AiTier; summary: string }) => Promise<boolean>;
  turn: { isOpen(): boolean; mark(): void } | null;
}
interface AiToolResult { ok: boolean; changed?: { x: number; y: number; w: number; h: number } | null; docRev?: number; warn?: string[]; error?: string }

listTools(opts?: { tiers?: AiTier[] }): AiTool[]          // 稳定顺序：tier 分组，组内按 id 字典序；默认不含 "ui"
getTool(id: string): AiTool | null
validateArgs(tool: AiTool, args: unknown):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: string }
callTool(id: string, args: unknown, ctx: AiToolCtx): Promise<AiToolResult>
```

`callTool` 的**固定顺序**：① 校验参数（不合格直接返回 `{ok:false, error}`，**不执行、不确认**）
→ ② `tier === "destructive"` 必须先 `await ctx.confirm(...)`，返回 false 就 `{ok:false, error:"cancelled"}`
→ ③ 执行 handler，把结果原样返回。

覆盖范围：§4 映射表里标「已有方法」的条目**全部要有工具**
（`palette_*` / `color_*` / `layer_*` / `frame_*` / `tag_*` / `undo` / `redo` / `scale` / `iso_*`），
每条 handler 只做「参数适配 + 调既有 Session 方法」，**不新增写入路径**。
工具 id 与 `Session.allActions()` 对齐：能对上的直接复用，对不上的新增 id 并在测试里维护白名单
（测试会断言"清单里的 id 全都在工具表里"）。

#### C2 回合事务 `src/app/ai-turn.ts`（必要时在 `Session` 上加薄门面）

```ts
beginAiTurn(label: string): number                        // 返回 turnId；期间写操作不动历史、不触发 autosave
previewTurn(): { count: number; rect: Rect | null }        // 这一轮会改哪块（不改文档）
commitTurn(): boolean                                      // 一条历史（结构快照）+ 一次 autosave；无改动返回 false
rollbackTurn(): void                                       // 恢复到回合开始（逐字节一致）
isTurnOpen(): boolean
```

- 实现沿用既有 `struct()` 的做法：`begin` 时 `doc.capture()` 快照（**全部画布**，不只当前那张），
  `commit` 用 `History.pushStruct(label, …)` 合成**一条**记录；
- 回合标签固定前缀 `ai: `（例如 `ai: 描出史莱姆轮廓并铺底色`），历史面板里一眼认出；
- 回合进行中抑制 `Session.scheduleAutosave()`（等价于 `replayActive` 的处理），`commitTurn()` 后补一次；
- 任何异常 / 取消 / 工具报错 → `rollbackTurn()`，并走与 `View.flushStroke()` 相同的路径把
  未落定的笔迹与浮动变形落定/清掉，保证"回滚后与新开时逐字节一致"；
- **默认「预览后应用」**（§3.3）：`previewTurn` 只画覆盖层、`commitTurn` 才落盘。C0–C2 只提供 API，
  按钮与确认文案属于 C5。

#### 落地后的订正（C0–C3 实现与本文的差异，一律以代码为准）

| 位置 | 本文原写法 | 实际实现 | 为什么 |
|---|---|---|---|
| C0 `AiDigest.palette` / `AiRegion.palette` | `"#rrggbb"` | 半透明项是 **`#rrggbbaa`** | 颜色身份按 RGBA 四通道，不用另开「透明度表」；文档化时漏了 alpha（`docs/API.md` §21.1 / §21.2） |
| C0 `AiApplyCtx.session` | `session: Session` | **`session: AiSessionLike`**（`{fg,bg,li,fi}`） | `applyOps` 只读这四个字段；用结构类型才能不 import 4.2k 行、依赖 DOM 桩的 `session.ts`，于是 C0 能在 Node 里单测 |
| C0 `applyOps` 空 `ops` | `ok = true`（未说图层状态） | `ok = true`，**且与图层锁定无关** | 「没有 op 可失败」不是失败；早退排在锁定检查前面，否则「锁定图层 + 空 ops」会 `ok:false` 且 `errors` 空 |
| C0 `readRegion` 完全在画布外 | 只说 `rows` 为空 + `clipped` | `w = h = 0`，**`x/y` 回显请求坐标**（口径①） | `w = h = 0` 时「实际读到」就是空，请求矩形才是「读的是哪块」的真相；否则 `x=10` 回 10、`x=-10` 回 0，同一件事两种形状 |
| C2 `commitTurn(): void` | 无返回值 | **`boolean`**（无改动 / 回合没开 → `false`） | 调用方必须能区分「落了一条」与「什么都没改」 |
| C2 新增入口 | 无 | `runAiTurn(label, fn)`（`src/app/ai-turn.ts` + `Session` 门面） | 手写 begin/try/commit 漏掉任何一条失败路径都会留下「回合一直开着」的残留：历史不落、autosave 被永久压住、用户此后的写入会被下一次 rollback 吞掉 |
| §3.1 L1 的 `apply_ops` 工具 | 列在工具面里 | C1 **没有**这条工具（`applyOps` 只是 C0 的纯函数） | 工具表这一层只做「参数适配 + 调既有 Session 方法」，不新增写入路径；`applyOps` 留给 C2/C5 的批量入口（`docs/API.md` §22.1） |
| §3.1 原则 2「返回里带 `clamped: true`」 | 布尔标记 | 引擎侧是 **`warnings: string[]`**（`"clamped: size 999 → 64"`），工具表侧是**直接拒绝**非法参数 | 两种口径各管一层：真的会被悄悄改小的参数记字符串警告（带原值 → 最终值，模型可读）；参数形状不对一律 `{ok:false, reason}`，宁可让模型重发 |
| C3 协议状态码 | 只列了 200 / 400 / 401 / 404 / 405 / 503 | 另有 **413**（TS 按字符上限 262144、Java 按字节上限 1 MiB，两档都先挡再交给路由） | body 超限需要一个明确的状态码，而不是被解析成 400（`docs/API.md` §24.1） |

另有两条**实现层面的约定**（本节没写、但下游必须知道）：
`AiToolResult.changed` **不可依赖**（43 个写类工具只有 2 个给矩形），判生效一律用 `docRev`；
`ctx.confirm` 省略时**一律拒绝**（C3 没有确认 UI，那是 C5），禁止为了「让工具能用」默认放行。

#### §7 的五个决策对本期的约束（只列影响面，不替用户拍板）

| 决策 | 影响本期哪里 |
|---|---|
| Q1 离线承诺（加不加 `INTERNET`） | 决定 C3 能不能做；**本期 C0–C2 一行网络代码都没有**，怎么答都不浪费 |
| Q2 key 策略（自建网关 / 应用内直填） | 只影响 C5 的设置页与文档措辞 |
| Q3 AI 默认行为（预览后应用 / 直接应用） | 只影响 C5 的默认按钮；API 层两种都已留出（`previewTurn` / `commitTurn`） |
| Q4 C 路线是否现在做 | 正是本期内容 |
| Q5 生成轴（文生像素图） | 与本期无关；将来加 `image_*` 工具时复用同一套 tier 与回合事务 |

---

## 6. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 离线承诺被打破（现在是纯离线、只有 VIBRATE） | 用户对"这软件不联网"的信任 | `INTERNET` 只为 B/A 加，且设置里默认**关闭**；界面上明示"当前未联网"；README/更新日志写清 |
| key 泄漏 | 用户的账号余额 | 线上 PWA 不提供填 key（§3.6）；APK 用加密存储；推荐自建网关 |
| 模型幻觉 → 改坏图 | 作品被毁 | 回合事务 + **预览后应用** + 一条 undo；`destructive` 每次确认 |
| 上下文爆掉 | 大画布无法读 | `docDigest` + 窗口读；写操作用命令而非整图回写（§3.2） |
| token 成本/延迟 | 体验差、花钱 | 不默认走视觉回环；工具返回值只回"改了什么"（rect + 计数），不回整图 |
| 工具面失控（几十个工具 + 参数） | 模型选错工具 | 工具分组 + 常用工具前置；`allActions` 与引擎工具共用 id；提供 `search_tools` |
| 外部控制的安全面 | 恶意 App 连本地端口 | 只绑 `127.0.0.1` + token + 可关闭 + 界面上常驻"正在被控制" |
| 历史被 AI 灌爆 | 用户自己的撤销没了 | 回合事务（C2）；历史面板给 AI 回合单独的标签与颜色 |
| 平台差异（WebView/无头） | 有的能力浏览器里没有 | C0/C1/C2 全在引擎层、可测；C3 起才碰平台 |

---

## 7. 待决策问题（需要拍板）

1. **离线承诺**：接受为 B/A 加 `INTERNET` 吗？（若不接受，只剩 `LocalSocket` 同机方案或不做 B/A）
2. **key 策略**：只支持"用户自建网关"，还是也允许应用内直填 key？（影响 UI 与文档写法）
3. **AI 的默认行为**：默认"预览后应用"（更安全），还是"直接应用 + 一条 undo"（更顺手）？
4. **C 路线是否现在就做**（纯 TS、不碰权限、随时可停），还是等 B/A 的方案再细化？
5. **生成轴**要不要一起规划（文生像素图）：它需要选定模型与计费方式，和操作轴是两套东西。
6. **P8 留下的两个口子**（§3.7 已给可行做法，等用户拍板要不要做）：
   ①**手填 key 要不要也搬出页面**（今天 `ai.chatKey` 存在页面 `localStorage`，同源脚本读得到；
   要堵上就得把它挪进壳的存储、页面只拿哨兵 —— 会牺牲"换浏览器还在"的便利）；
   ②**流式输出**：~~代理现在对 `stream:true` 直接回 400~~ → **已落地（2026-09）**：壳的 `forwardToProviderStream()` 按 SSE 事件边界擦 key，页面逐块渲染，非 SSE 端点自动降级为整包解析（不重发）。
7. **Android 侧要不要做同源代理**：本轮**明确不做**（§3.7.5 的三条事实 + 本机没有 Android 设备可验证），
   APK 今天维持"手填 key + 直连"。**缺口口径已订正（P14）**：APK 上既没有"宿主环境变量"这条路，
   直连能不能通又取决于 WebView 对 `file://` 跨源的策略（`MainActivity` 没开
   `setAllowUniversalAccessFromFileURLs`，**未验证**）⇒ **APK 里的助手仍连不上真 provider，需要 Java 侧代理**。
   要做的话协议照抄 §3.7.2 / `docs/API.md` §26.6，但必须先在真机 / 模拟器上验一次。
8. **本轮新增的两条诚实边界**（都记进 `AGENTS.md` §7，不在这轮修）：
   - **"env key + 上游回显"这个组合本身没能端到端验**：env 来源现在只许 `https:`，本机没有受信任证书，
     所以回显型假 provider 只能在 `--provider-key`（豁免闸门）+ `http` 本机这条路上验。
     两条路读的是同一个 `opts.providerKey`、走同一个 `forwardToProvider()` / `scrubProviderKey()`，
     且 env 来源的转发腿已用真 `https://api.deepseek.com`（假 key）端到端验过（上游 401 原样透传）。
   - **新增的三句 key help 是中文常量而不是 i18n 键** ⇒ 英文界面下这三句仍显示中文；
     要 i18n 得把同模块的 `httpError()` / `hostError()` / `chatConfigError()` 一起做，不在本轮。

---

## 8. 落地文件清单

**已落地（新增）**

| 文件 | 内容 | 期 |
|---|---|---|
| `src/app/ai-doc.ts` | 摘要 / 区域读 / 结构化操作应用（纯函数，无 DOM） | C0 |
| `src/app/ai-tools.ts` | 工具表（schema + 校验 + 分发 + tier），48 → **61 个工具**（P1 补了 13 条） | C1 / P1 |
| `src/app/ai-draw.ts` | **P1 适配层**：把 `draw_path` / `draw_shape` / `fill` / `erase` / `transform` / `fx_*`×8 翻成 `Stroke`、`engine/effects.ts`、`tools/xform.ts` + 浮动模型的一次调用（不 import `History`） | P1 |
| `src/app/ai-turn.ts` | 回合事务（一轮一条 undo + 回合期间不刷 autosave） | C2 |
| `src/app/ai-rpc.ts` | 传输无关的协议路由（一份 `route()` 喂同步 / 异步两个入口） | C3 |
| `src/app/ai-serve.ts` | JS 生命周期：读设置起停、`window.__pc_ai_call`、诊断、回合收尾 | C3 |
| `src/app/ai-chat.ts` | **C5 助手逻辑层**：OpenAI 兼容的整轮循环（function calling）+ 预览后应用（不 import `window`，`fetch` 注入，可单测） | C5 |
| `src/ui/AiPanel.tsx` | **C5 助手面板**：对话 / 调用摘要 / 「应用 · 放弃」；`isNativeShell()` 门控 | C5 |
| `android/java/com/pixelcraft/app/AiServer.java` | 本机端口 + token + 只转发（纯 JDK socket，无 `import android.*`） | C3 |
| `toolchain/ai-server.mjs` | Node 开发宿主（只绑 `127.0.0.1`，复用编译产物，不重写协议） | C3 |
| `toolchain/pc-mcp.mjs` | **C4 电脑侧 MCP 入口**：stdio（换行分隔 JSON-RPC 2.0）↔ 本机 HTTP 工具的薄转发，工具表现取现映射 | C4 |
| `toolchain/pc-shell.mjs` + `pc-shell.cmd` | **电脑侧壳**：伺服 `app2/www` + 同端口 `/ai` 入口 + SSE 把请求转发进窗口页面（协议与 APK 一致，不重写）；**P8 起还提供模型请求的同源代理 `GET /provider/config` + `POST /provider/chat`**（环境变量 key、key 擦除、env 闸门、九档错误码）；`.cmd` 是 Windows 双击入口 | P7 / P8 |
| `tests/ai-doc.test.ts` / `ai-tools.test.ts` / `ai-turn.test.ts` / `ai-rpc.test.ts` | 四期的回归 | C0–C3 |
| `tests/ai-draw.test.ts` / `ai-chat.test.ts` | P1 适配层（同一条「无新增写入路径」静态规则）与 C5 整轮循环的回归 | P1 / C5 |
| `src/app/ai-presets.ts` | **P8 厂商预设表**（DeepSeek / OpenAI / 自定义）+ `aiChatPresetOf()` / `normalizePresetId()`；预设里**没有 key 字段** | P8 |
| `src/ui/AiWindow.tsx` | **P8 助手浮窗**：`createPortal(document.body)` 的容器（标题栏 + 拖动 + 缩放抓手 + 最小化/关闭），只做容器与几何持久化 | P8 |
| `tests/uiback.test.ts` | `App.tsx` 返回键/裸读那类既有缺陷的静态钉子（P8 复验时顺手修掉的 `st.sel.open`） | P8 复验 |

**已落地（改动）**

| 文件 | 改了什么 | 期 |
|---|---|---|
| `src/app/session.ts` | 回合门面（`beginAiTurn` / `previewAiTurn` / `commitAiTurn` / `rollbackAiTurn` / `aiTurnOpen` / `aiTurnHandle` / `runAiTurn` / `aiTurnAutosaveSuppressed`、`aiTurnAutosaveHeld` 旗） | C2 |
| `src/app/settings.ts` + `src/ui/i18n.ts` | 四个声明式设置项 `ai.server` / `ai.port` / `ai.tier` / `ai.turnIdleSec`（自成极小存储，不进 `Session.prefs`）；C5 又加了 `CHAT_SETTINGS` 那一组（`ai.chatOn` / `ai.chatEndpoint` / `ai.chatModel` / `ai.chatKey`，**单独一张表不并进 `SETTINGS`**，key 走 `SETTING_SECRET_PATHS`）；**P8 扩到 14 条**（+ 预设 / 直连地址 / 轮数 / 温度 / 补充提示词 / 流式 / protectKey / 三条窗口状态） | C3 / C5 / P8 |
| `src/app/uibar.ts` | **P8 浮窗与助手球的纯几何**：`AI_CHAT_WIN_KEY` / `AI_CHAT_BALL_KEY` / `CHAT_BALL_ID` / `AI_WIN_*` 常量 + `aiWinDefaultLayout()` / `clampAiWinLayout()` / `normalizeAiWinLayout()` / `aiWinDragFrom()` / `clampAiBallPos()` / `normalizeAiBallPos()`（有单测）；`ORB_IDS` **仍是 5 个** | P8 |
| `src/app/ai-chat.ts` | **P8**：`AI_CHAT_HOST_KEY_SENTINEL` 哨兵头、`chatProxyUrl()` / `detectChatProxy()` / `readHostProviderConfig()` / `proxyChatFetch()`、`aiChatStatusText()`（三态 + `protectKey` 那句）、`hostError()` 九档人话（含 `isShellError()` 分壳/上游） | P8 |
| `src/ui/modals.tsx` | 设置页的**文本行**（`SettingDef.text`，`"password"` 走密文输入，不新增 `SettingKind`）+ 主菜单「AI 助手」入口（`isNativeShell()` 门控）；**P8 起这一行改为打开浮窗**（不再是 `setSub("ai")` 子面板） | C5 / P8 |
| `src/ui/App.tsx` | **P8**：挂 `AiWindow` / `ChatBall`、四个写入点（开/最小化/还原/关窗）、`pc-back` 只最小化、`pc-ai-ball-tap` 触屏互斥；顺手修掉裸读 `st.sel.open` 的 `TypeError` | P8 |
| `src/ui/style.css` | **P8**：`.ai-win` / `.ai-win-head` / `.ai-win-grip` / `.ai-thread`（助手球复用既有 `.orb`） | P8 |
| `src/app/settings.ts` + `src/ui/i18n.ts` | 四个声明式设置项 `ai.server` / `ai.port` / `ai.tier` / `ai.turnIdleSec`（自成极小存储，不进 `Session.prefs`）；C5 又加了 `CHAT_SETTINGS` 那一组（`ai.chatOn` / `ai.chatEndpoint` / `ai.chatModel` / `ai.chatKey`，**单独一张表不并进 `SETTINGS`**，key 走 `SETTING_SECRET_PATHS`） | C3 / C5 |
| `src/ui/modals.tsx` | 设置页的**文本行**（`SettingDef.text`，`"password"` 走密文输入，不新增 `SettingKind`）+ 主菜单「AI 助手」入口（`isNativeShell()` 门控）+ 面板挂载 | C5 |
| `src/ui/feature-icons.ts` + `app2/www/index.html` | 助手入口的专属图标 `i-ai-chat`（`tests/icons.test.ts` 校验组内唯一） | C5 |
| `src/io/bridge.ts` | `aiServerStart` / `aiServerStop` / `aiServerStatus` / `aiRespond` / `__pc_ai_call` 声明与桥接（`isNativeShell()` 也是 C5 的助手平台门） | C3 / C5 |
| `src/main.tsx` | `installAiServe(...)` 接线（起停提示、回合空闲秒数现读设置） | C3 |
| `android/java/com/pixelcraft/app/MainActivity.java` | `PixelBridge` 加 4 个 AI 方法，桥接 `window.__pc_ai_call` 与 `aiRespond` | C3 |
| `android/AndroidManifest.xml` | 加 `INTERNET`（**只为开本机端口**，服务默认关闭） | C3 |
| `.gitignore` | `toolchain/*` 白名单加 `!/toolchain/ai-server.mjs`、`!/toolchain/pc-mcp.mjs`、`!/toolchain/pc-shell.mjs`、`!/toolchain/pc-shell.cmd` | C3 / C4 / P7 |
| `tests/run-tests.ts` + `tests/tsconfig.json` | 新测试文件与 `--- ai doc/tools/draw/turn/rpc/chat ---` 段落 | C0–C5 |
| `docs/API.md` / `README.md` / `AGENTS.md` / 本文 | 新模块小节（API §21–§26；P8 把 §26 扩写成 26.1–26.6）、功能表、文档地图、已知缺口 | 每期 |

**未落地（后续期，本轮明确不做）**

| 项 | 内容 | 为什么不在这轮 |
|---|---|---|
| 协议层 / MCP 的 destructive 确认器 | 让外部宿主（`curl` / Claude Desktop）也能确认删图层、清空画布这类操作 | 需要宿主侧的真确认 UI（`setAiConfirmer()` 的接线）；**应用内助手已经有确认框**（API §26.4），两条路别混为一谈 |
| `warp` / `shading` / `export_*` / `render_preview` / `generate_sprite` 工具 | §4 映射表里剩下的条目（网格变形、色彩明暗、无 UI 导出、视觉回环、文生像素） | 与「操作轴地基」无关，属生成 / 理解轴，或需要额外的无 UI 入口 |
| `apply_ops` 批量入口 | 一次调用应用一串结构化操作 | C1 起就没做：工具表只做「参数适配 + 调 `Session` 既有方法」，`applyOps` 只是 C0 的纯函数 |
| `search_tools` / 常用工具前置 | 工具面变大后的「选工具」辅助 | 61 条工具仍在模型的上下文预算内（§3.2 的 token 估算） |
| **Android 侧的模型请求同源代理** | 把 key 收进 `MainActivity` + `EncryptedSharedPreferences`，由 Java 转发模型请求（协议照抄 §3.7.2） | **没有 Android 设备 / 模拟器可验证**（开发环境是 Windows + 桌面壳 + 无头 Edge），写完等于没测；APK 今天"手填 key + 直连"是可用的（`INTERNET` 已在，`file://` 并不拦 provider，见 §3.7.5） |
| ~~**流式输出**~~ **已落地（2026-09）** | `/provider/chat` 的 `stream:true`（壳侧 SSE 解析 + 页面逐块渲染） | 已实现，不再是未落地项：见 `docs/API.md` §26.6.1（含自动降级与按事件边界擦 key）。原判「要动壳与页面两处协议」正是这次做完的事 |
| **把手填 key 也搬出页面** | `ai.chatKey` 从页面 `localStorage` 挪进壳的存储，页面只拿哨兵 | 属于"安全加固"而不是本轮目标；代价是"换个浏览器就没了"，见 §7 第 6 条 |

---

## 9. 参考与事实依据

- 本次盘点基于方案定稿时的仓库（`master`，`1.1.1.8`，3847 条断言）的实际源码：
  `src/app/session.ts`、`src/engine/*`、`src/tools/stroke.ts`、`src/render/compositor.ts`、
  `src/io/exporters.ts`、`android/AndroidManifest.xml`（当时只有 `VIBRATE`）、`tests/`。
  C0–C3 落地后本仓库的断言数已增至 6000+（`node .ts-out/tests/run-tests.js` 末行会打印条数）。
- Android 本地端口与 `INTERNET` 权限：
  [socket EPERM 的典型表现](https://codemia.io/knowledge-hub/path/javanetsocketexception_socket_failed_eperm_operation_not_permitted_1)、
  [「不用 INTERNET 权限能不能 ServerSocket」讨论](https://cloud.tencent.cn/developer/ask/sof/829926?from=16139)、
  [Android `Socket` 文档](https://developer.android.com/reference/java/net/Socket)。
- MCP（Model Context Protocol）的「宿主 → 工具服务」模型与传输方式：以官方规范为准（实现前再核一遍版本）。

---

## 10. 进度

| 期 | 状态 | 落地 |
|---|---|---|
| 方案稿（本文） | ✅ 2026-09-14 | 本文 |
| C0 文本化 | ✅ 完成 | `src/app/ai-doc.ts` + `tests/ai-doc.test.ts`（`aidoc` 段落 195 条断言）；边界口径与 token 预算见 §5.1 与 `docs/API.md` §21 |
| C1 工具表 | ✅ 完成 | `src/app/ai-tools.ts` + `tests/ai-tools.test.ts`（`aitools` 段落 1138 条断言）：**当时** 48 个工具 = read 4 / draw 38 / destructive 5 / ui 1（P1 之后是 61 条，见下表）；`docs/API.md` §22 |
| C2 回合事务 | ✅ 完成 | `src/app/ai-turn.ts` + `src/app/session.ts` 门面 + `tests/ai-turn.test.ts`（`aiturn` 段落 206 条断言）：一轮一条历史、回合期间不刷 autosave、`runAiTurn` 安全入口；`docs/API.md` §23 |
| C3 本地工具服务 | ✅ 完成 | `src/app/ai-rpc.ts` + `src/app/ai-serve.ts` + `toolchain/ai-server.mjs` + `android/…/AiServer.java` + `MainActivity` 桥接 + `INTERNET` + 四个设置项（默认关闭 / 只绑 `127.0.0.1` / 默认 `read`）：协议表、状态码、回合收尾守卫见 `docs/API.md` §24 |
| P1 像素级工具面 | ✅ 完成 | 13 条新工具（`draw_path` / `draw_shape` / `fill` / `erase` / `transform` / `fx_*`×8）：工具表 48 → **61**（read 4 / draw 49 / destructive 7 / ui 1）；落笔在 `src/app/ai-draw.ts`（只组合既有写入通道，**不新增写入路径**），回归 `tests/ai-draw.test.ts`；接口与 tier 判据见 `docs/API.md` §22.8 |
| C4 MCP 转发 | ✅ 完成 | `toolchain/pc-mcp.mjs`：stdio（换行分隔 JSON-RPC 2.0）↔ 本机 `POST /ai` 的薄转发，`tools/list` 现取现映射、`tools/call` 不吞错；配套电脑侧壳 `toolchain/pc-shell.mjs` + `pc-shell.cmd`（伺服站点 + 同端口 `/ai` + SSE 转发进窗口页面）。用法、环境变量、宿主配置与三个工具数口径见 `docs/API.md` §25 |
| C5 应用内助手 | ✅ 完成 | `src/app/ai-chat.ts`（OpenAI 兼容整轮循环 + **预览后应用** + 失败一律 rollback）+ `src/ui/AiPanel.tsx`（对话 / 调用摘要 / 应用·放弃 / destructive 确认框）+ `CHAT_SETTINGS`（`ai.chatOn` / `ai.chatEndpoint` / `ai.chatModel` / `ai.chatKey`，**key 只存本机、不进设置导出**）+ `tests/ai-chat.test.ts`；接口与安全口径见 `docs/API.md` §26 |
| **P8 通路 / 窗口 / 预设** | ✅ **完成**（2026-09-16 定稿 → 同日落地；as-built 见 §3.7 开头的偏差表） | 接口契约在 **§3.7**（同源代理 `/provider/chat` + `/provider/config`、环境变量 `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `PC_AI_KEY`、key 优先级、浮窗与独立小球的持久化键 `pc.aichat.win` / `pc.aichat.ball`、DeepSeek 预设 schema、新增设置项清单、不回归断言名清单、验收口径）。**通路结论与最初假设相反**：实测证明 DeepSeek 的 API 回 CORS 头、页面直连是通的（§3.7.1），代理改按"key 不进页面 + 免手填 key + 错误可控 + 不依赖对端 CORS"四条理由落地。落点：`toolchain/pc-shell.mjs`（`/provider/*` + env key）、`src/app/ai-chat.ts`（哨兵头 + 壳错误码人话 + `aiChatStatusText`）、`src/app/ai-presets.ts`（**新文件**）、`src/app/settings.ts`（预设 + 14 字段）、`src/app/uibar.ts`（浮窗/球纯几何）、`src/ui/AiWindow.tsx`（**新文件**，portal 浮窗）、`src/ui/AiPanel.tsx`（`ChatBall` + `aiWinStore` + `detectTransport`）、`src/ui/App.tsx`（状态机与 `pc-back`）、`src/ui/style.css`（`.ai-win*`）；断言 7527 → 7639 |
| P8 复验（P9–P11 修复） | ✅ 完成 | **两个真浏览器缺陷**（详见 §3.7 开头）：`GET /provider/config` 带 body 被真浏览器抛 `TypeError` 又被 `catch` 静默吞掉；代理 URL 拿 provider 基地址拼前缀导致跨源。修完才真正跑通同源代理。**最小化丢回合**（HIGH）与**假预览态**改成「只看 Session 实况」的纯函数 `aiPanelDropsTurnOnUnmount()` / `aiPanelShowsPreview()`；**provider 403 文案**拆成「本机壳拒绝」/「模型服务商拒绝」两档（`isShellError()`）；另修掉一条既有缺陷（`App.tsx` 裸读 `st.sel.open` 的 `TypeError`，加 `tests/uiback.test.ts` 静态钉子） |
| P12–P16（评审 findings 闭环 + 产物重建） | ✅ 完成 | 四条评审 findings 的落点：① `ai.protectKey` **真的有消费者**（状态行三态各一句说明）；② 壳 `scrubProviderKey()` 把回显的 key 擦成 `…尾4`；③ 断言恢复**全量比较**（14 字段整对象 + 键集 + `is-tight`）；④ env 来源的转发闸门额外要求 `https:`（白名单主机 + `http:` 也拒）。Web 产物按当前 src 重建（`app2/www/js/app.js` 1,300,116 字节 / md5 `b51a0a94fbf7c892de405a8e4097e059`），`check-bundle` exit 0 |
| P7 文档同步 + 最终全量验证（集成） | ✅ 完成 | `docs/API.md` §26 扩写成 26.1–26.6（浮窗与球 / 设置逐项清单 / key 与诚实边界 / 同源代理九档 + 安全分档）、§25.2 补 `/provider/*` 用法、§19 数字改齐；本文 §3.7 补三处偏差与两条真浏览器缺陷、§10 补本轮；`AGENTS.md` §1/§2/§7/§8 与 `README.md` 功能表同步。最终树上：`tsc`(src) 0、`tsc`(tests) 0、`run-tests` `assertions: 7639 / ALL PASS`、`check-bundle` exit 0，另加真壳 + 无头 Edge 的 43 条端到端断言全绿 |
| **P17 参考图（vision）** | ✅ **完成**（2026-09-18） | 助手可挂**一张**参考图与文本一起发出去（`content` 变 OpenAI 兼容的 parts 数组；**无图时仍是纯字符串**、只有 `user` 消息能带图）。新增 `src/app/ai-vision.ts`：尺寸夹取（最长边 768、只缩不放）、体积判定（软 512 KiB / 硬 768 KiB，由壳的 1 MiB 请求体上限推出）、三态能力门控，全是纯函数（`tests/ai-vision.test.ts`）；`ai-chat` 侧 `userContentParts()` / `contentText()` / `ChatTurnOpts.imageDataUrl`；`AiPanel` 的附件条（用当前参考图 / 选择图片文件，发送后与跨最小化都保留）；`ai-presets` 的能力位（`deepseek-flash` yes / `deepseek-v4-pro` no / 其余 unknown = 放行 + 一句提示）。接口见 `docs/API.md` §26.8 |
| P18 参考图缺陷修复（实测） | ✅ 完成 | 探针量出：源图任一边 > 1024 时 `engine/resample.ts` **静默返回全透明缓冲区**（全项目 1024 约定 + `dimsOk()` 兜底），于是 1200px 以上的参考图被编成**空白图**发给模型，附件条上还写着「已缩到 768×768」。改为源超契约时走自家 `downscaleOutOfContract()`（盒式平均 / 抽点），**不动 `MAX_SIZE`**；回归断言是像素级的（`aivision.ref.huge.*`：颜色数 > 2、alpha > 0）。断言 8051 → **8090**，产物 1,334,285 字节 / md5 `a15d5b1e626edfaf526c28694bed4b86` |
| P19 补齐 §10 缺的四个批次（文档口径纠偏） | ✅ 完成（2026-09-18） | 此前这四个批次只在 `docs/API.md` 里以 **B1/B2** 标签出现、本文 §10 没有行，而 B1/B2 在任何计划文档里都没定义。四个批次是：思考强度与模型响应超时（`e47a28c`）、上游超时拆分 + 错误信封翻人话（`ac65969`）、流式输出 + 思考过程折叠（`3157485`）、调用记录细化 + 预览回合内按步撤回（`be99ff8`）。口径现已写进 `docs/API.md` §26.6.1（流式与降级）与 §23.4（按步撤回）。**以后新增批次请直接在本表加行，不要只留标签** |
