# AI 接入（应用内助手 / 本地工具服务 / MCP）· 方案与决策

> 状态：**方案稿，暂不写代码**（2026-09-14 定稿待评审）。决策点见 §7，落地清单见 §8。
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
| 唯一改动入口 `Session` | `src/app/session.ts`（约 4.2k 行，公开方法 **287** 个） | AI 只需要一个 `Session` 句柄，不需要 UI |
| 动作表 + 动作目录 | `Session.allActions()` / `actionById()` / `registerOrbCatalog()`；`src/ui/App.tsx` 里注册 **54+** 条 `{id,label,icon,group,run}` | **工具 schema 的现成来源**；`ActionSearchModal` 已经是它的 UI 壳 |
| 一切可撤销 | `engine/history.ts`：`record` / `pushPixels` / `pushStruct`；`Session.struct()` | 一轮 AI 操作可合成**一条** undo（§3.3） |
| 无 DOM 回归套件 | `tests/`（**3847 条断言**，`node .ts-out/tests/run-tests.js`） | 工具层可以像引擎一样被回归测试，不需要模拟器 |
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
commitTurn(): void                      // 落一条历史（结构快照），关闭回合
rollbackTurn(): void                    // 放弃：恢复到回合开始的状态
```

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

## 4. 与现有能力的映射表（工具 → 已有实现）

| 工具 | 落到哪 | 现状 |
|---|---|---|
| `doc_digest` / `read_region` | 新写（读 `Doc` / `Cel` / `palette` / `Sel`） | 需新增（纯函数，易测） |
| `draw_path` / `draw_shape` | `tools/stroke.ts` 的 `Stroke` + `ToolKind` | 类可无 UI 实例化，但需要一层参数适配与"无 View"入口 |
| `fill`（油漆桶/渐变） | `engine/paint.ts`（区域填充与渐变）、`engine/shape.ts` | 有算法；需要文档空间的入口（`Session.quickFill` 现在依赖 `view_`） |
| `fx_*`（描边/内描边/圆角/模糊/反相/去饱和/投影/外发光） | `engine/effects.ts`（8 个函数） | 有算法；**目前只有弹窗流程**，需要无 UI 入口 |
| `transform`（移动/缩放/旋转/斜切） | `tools/xform.ts`（纯函数层）+ `tools/select.ts` 的浮动模型 | 有；需要"以参数直接给结果"的入口（现在是手势驱动） |
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
  palette: string[];              // "#rrggbb"
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
  session: Session;               // 只用它的既有入口（paint / shape / ops / 前景背景色）
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
- `ops` 为空 → `ok = true`、`applied = 0`、`changed = null`（不写像素）；
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

---

## 8. 落地文件清单（预计）

**新增**

| 文件 | 内容 | 期 |
|---|---|---|
| `src/app/ai-doc.ts` | 摘要 / 区域读 / 结构化操作应用（纯函数） | C0 |
| `src/app/ai-tools.ts` | 工具表（schema + 校验 + 分发 + tier） | C1 |
| `src/app/ai-turn.ts` | 回合事务（或并入 `session.ts`） | C2 |
| `tests/ai-doc.test.ts` / `tests/ai-tools.test.ts` / `tests/ai-turn.test.ts` | 三期的回归 | C0–C2 |
| `android/…/AiServer.java`（暂定） | 本机端口 + token + 路由（只依赖 JDK socket） | C3 |
| `src/ui/AiPanel.tsx`（暂定） | 状态/开关/token 显示（C3）、聊天窗（C5） | C3/C5 |
| `toolchain/pc-mcp.mjs`（暂定） | stdio MCP → 本地 HTTP 的薄转发 | C4 |

**改动**

| 文件 | 改什么 | 期 |
|---|---|---|
| `src/app/session.ts` | 回合事务；把"UI 弹窗流程"里的能力抽成无 UI 入口（特效/导出/变换） | C1–C2 |
| `src/ui/App.tsx` | 工具表接线（面板开关、状态提示） | C3+ |
| `android/AndroidManifest.xml` | `INTERNET`（B/A 才加） | C3+ |
| `src/app/settings.ts` + `src/ui/i18n.ts` | AI 开关、key 管理、权限分级的声明式设置项 | C3+ |
| `docs/API.md` / `README.md` / `AGENTS.md` | 新模块小节、功能表、文档地图（按 §5.3 的硬要求） | 每期 |

---

## 9. 参考与事实依据

- 本次盘点基于仓库当前提交（`master`，`1.1.1.8`，3847 条断言）的实际源码：
  `src/app/session.ts`、`src/engine/*`、`src/tools/stroke.ts`、`src/render/compositor.ts`、
  `src/io/exporters.ts`、`android/AndroidManifest.xml`（只有 `VIBRATE`）、`tests/`。
- Android 本地端口与 `INTERNET` 权限：
  [socket EPERM 的典型表现](https://codemia.io/knowledge-hub/path/javanetsocketexception_socket_failed_eperm_operation_not_permitted_1)、
  [「不用 INTERNET 权限能不能 ServerSocket」讨论](https://cloud.tencent.cn/developer/ask/sof/829926?from=16139)、
  [Android `Socket` 文档](https://developer.android.com/reference/java/net/Socket)。
- MCP（Model Context Protocol）的「宿主 → 工具服务」模型与传输方式：以官方规范为准（实现前再核一遍版本）。

---

## 10. 进度

| 期 | 状态 |
|---|---|
| 方案稿（本文） | ✅ 2026-09-14 |
| C0 文本化 | ⬜ 未开始 |
| C1 工具表 | ⬜ |
| C2 回合事务 | ⬜ |
| C3 本地工具服务 | ⬜ |
| C4 MCP 转发 | ⬜ |
| C5 应用内助手 | ⬜ |
