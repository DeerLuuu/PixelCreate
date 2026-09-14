# PixelCraft 架构：现状、目标与 Server 化改造

> 状态：**现状盘点 + 目标架构（Server 化 + 模块化）设计**（2026-09-14）。改造**尚未开工**：
> 分期计划见 §5，模块化（可裁剪的交付单位）见 §4，红线见 §6。
> 相关：[`docs/API.md`](API.md)（现有接口）、[`docs/PLAN-ai.md`](PLAN-ai.md)（AI 接入，依赖本文的 C 阶段地基）、
> [`AGENTS.md`](../AGENTS.md)（工程约定）、[`docs/UI.md`](UI.md)（界面规范）。
> 文中所有数字都是**在源码上实测**的（`master`，版本 `1.1.1.8` / versionCode 65）。

---

## 0. 摘要

- **现状**：一套代码、两种外壳（APK + PWA）的纯本地像素画编辑器，没有后端、账号与网络请求
  （`AndroidManifest.xml` 只有 `VIBRATE` 一个权限）。内核是"单例会话 + 命令式绘图引擎"。
- **问题**：`Session`（4506 行 / 287 个公开方法）与 `View`（4820 行）**互相 import**，业务规则
  （如填充落点）漏进视图层；`App.tsx` 2898 行、`modals.tsx` 2246 行。除这段之外，其余分层**是干净的**。
- **目标**：按 Godot 的 server 思路把业务层按**职责所有权**切开——每个 server 只管一件事
  （文档 / 历史 / 渲染 / 视口 / 输入 / 工具 / 选区 / 调色板 / 动画 / 画布空间 / IO / 设置 / UI 布局 /
  信号总线），前端只做"翻译输入 + 呈现状态"，算法抽成纯类。
- **模块化**：在 Server 之上再加一层「模块」——像 Godot 那样**把不要的模块直接不编进去**
  （`modules.config.json` 选模块 → 生成静态 import → esbuild 天然剔除；见 §4）。两件事的关系：
  **Server 是运行时的职责边界，Module 是交付时的裁剪单位**；模块化**必须排在 Server 化之后**。
- **关键结论**：**不是重写，是切边界**。`engine`（19 模块）、`tools`（5）、`io`（15）已经基本符合目标形态，
  要动的主要是 `Session` / `View` / `App` 这三个大文件里的内容。

---

## 1. 产品形态与边界

| 项 | 内容 |
|---|---|
| 形态 | Android APK（WebView 加载 `file:///android_asset/www/index.html`）+ PWA（同一套代码） |
| 技术栈 | TypeScript + React 18 + Canvas 2D，无额外运行时框架 |
| 后端 | **没有**。零网络请求（`src/` 里没有一处 `fetch`/`XMLHttpRequest`/`WebSocket`） |
| 权限 | 只有 `android.permission.VIBRATE` |
| 存储 | `localStorage`（偏好）/ IndexedDB（自动保存、参考图）/ 文件（`.pxc`、`.aseprite`、PNG、GIF） |
| 平台差异 | 唯一差异在 `src/io/`（native bridge / 安全区 / 全屏）与 `src/io/pcmode.ts`（PC 输入识别） |

---

## 2. 当前架构

### 2.1 分层与规模（实测）

| 层 | 目录 | 文件 | 行数 | 职责 |
|---|---|---|---|---|
| UI | `src/ui/` | 35 | 11,033 | React 外壳、20 个弹窗、时间轴、多画布、浮动球、控件库 `kit`、i18n、样式（`style.css` 另有 1,380 行） |
| 应用 | `src/app/` | 12 | 6,836 | `Session` 单例、设置注册表（74 条 / 9 组）、引导（54 步）、手势映射、播放、UI 布局、快捷键、画布空间 |
| 交互/工具 | `src/tools/` | 5 | 2,754 | 笔迹引擎、选区操作、自由变换（`xform`）、变形（`warp`）、工具注册表 |
| 渲染 | `src/render/` | 6 | 5,223 | `view.ts` 视口与手势、合成器、脏矩形、洋葱皮、光标、滚轮（后三个是纯函数） |
| **服务** | `src/servers/` | 2 | 394 | **RenderServer**（合成缓冲 / 合成键 / 失效区域 / 多画布缓存 / 棋盘格）、**ViewportServer**（缩放平移与坐标数学，纯函数）—— §3.3 的第 3、4 项，Server 化的第一批落地 |
| 引擎 | `src/engine/` | 19 | 4,094 | 文档模型、历史栈、结构操作、绘制算法、形状、特效、对称、标签、重采样、等距、色彩明暗、颜色分析 |
| IO | `src/io/` | 15 | 2,701 | `.pxc` 工程、Aseprite 读写、zlib、自动保存、剪贴板、导出、原生桥、参考图、安全区 |
| 数据 | `src/data/` | 2 | 203 | 调色板包与图案库（**唯一数据源**） |
| 入口 | `src/main.tsx` | 1 | 72 | 挂载 |

合计 **95 个 TS/TSX 文件 / 32,916 行**。最大的文件：`view.ts` 4,820、`session.ts` 4,506、
`App.tsx` 2,898、`modals.tsx` 2,246 —— **四个文件占了全仓 44%。**

### 2.2 核心数据模型

| 对象 | 内容 | 不变量 |
|---|---|---|
| `Doc` | `w/h`、`layers[]`、`frames[]`、`tags[]`、`palette[]`、`cels: Map<"li:fi", Cel>`、`sel`、`bg` | 画布 ≤ **1024×1024** |
| `Cel` | 一层 × 一帧的**全尺寸 RGBA 缓冲** + `pixelRev` | **cel 恒与画布等大** |
| `Sel` | 布尔掩膜 + `ver` 版本号 | 版本号是选区着色的缓存键 |
| `History` | `record` / `pushPixels` / `pushStruct`；`steps`（默认 120 条）/ `full` 两种模式 | 一次操作一条记录；可内嵌进工程文件 |
| `Prefs` | 整包 JSON → `localStorage["pc.prefs"]` | 新字段自动持久化 |

### 2.3 运行时主链路

```
指针/键盘
  → View（view.ts 的手势状态机：绘制 / 平移 / 双指缩放 / 长按 / 多球互斥 / PC 修饰键）
  → tools/stroke.ts（笔刷落点、对称、像素完美、图案）
  → engine/paint.ts · shape.ts（栅格化算法）
  → 写 Cel.data
  → History.record / pushPixels
  → Stroke.takeDirty() → render/rect.ts 脏矩形
  → render/compositor.ts 合成（图层混合/不透明度/洋葱皮）
  → 只 blit 脏矩形（pix 层）；覆盖层另画（ov 层：选区框/抓手/变形点/网格/放大镜）
  → Session.changed() / changedUI()（useSyncExternalStore）
  → React 重渲染 UI
```

结构类操作（图层/帧/画布尺寸/等距生成/高级缩放）走 `engine/ops.ts` 与 `pushStruct`（整档快照），同样一条 undo。

### 2.4 业务能力域

| 域 | 能力 | 实现 |
|---|---|---|
| 绘制 | 16 个工具、笔刷、像素完美、对称（含四向）、图案笔刷、索引色 | `tools/registry.ts`、`stroke.ts`、`engine/paint.ts` |
| 选区与变换 | 掩膜、魔棒、浮动选区、Aseprite 式自由变换（8 锚点 + 枢轴 + 干净角 + 斜切 ±85°）、四角透视 / 网格变形 | `tools/select.ts`、`xform.ts`、`warp.ts` |
| 颜色与调色板 | 色轮/HEX/RGB、色卡、`.gpl`、去重排序合并、由画布生成、颜色分析器、色彩明暗（Color Shading v5.0） | `engine/adjust.ts`、`color-analysis.ts`、`shading.ts`、`data/palettes.ts` |
| 图层与动画 | 图层（混合/不透明度/锁定/独奏）、帧（时长/多选）、洋葱皮、4 种循环 + 0.25x–2x 速度、动画标签与播放范围 | `engine/ops.ts`、`tags.ts`、`app/playback.ts`、`ui/timeline.tsx` |
| 特效 | 描边（外/内/居中）、圆角化、模糊、投影、外发光、反色、灰度、居中、智能裁剪 | `engine/effects.ts` |
| 等距图形 | 2:1 六种基础等距体，画布上直接拖拽、吸栅格节点 | `engine/iso.ts`、`ui/iso.tsx` |
| 多画布空间 | 无限空间、引用画布（联动图层）、画布锁、跨画布拖选区、吸附 | `app/canvas-space.ts`、`canvas-snap.ts`、`ui/canvas.tsx` |
| 导入导出 | PNG/GIF/精灵表+JSON/`.aseprite` 读写/`.pxc`/`.gpl`/分图层批量 | `io/exporters.ts`、`aseread/asewrite`、`project.ts` |
| 导入 | `.ase/.aseprite`、图片、参考图、精灵表切帧、GIF、色板 | `io/aseread.ts`、`gifread.ts` |
| 界面与输入 | 5 个浮动球 + 布局可编辑、PC 模式（按输入证据识别）、快捷键可重绑、手势可重映射、54 步引导、更新日志、主题 | `app/uibar.ts`、`io/pcmode.ts`、`app/guide.ts` |

### 2.5 IO 与持久化

自动保存（IndexedDB 优先）· `.pxc`（JSON + 逐 cel PNG，可内嵌历史）· Aseprite 读写 + 自写 `zlib.ts` ·
参考图（IndexedDB）· Android 桥 `PixelBridge`（**8 个 `@JavascriptInterface`**，`MainActivity.java` 399 行）· 安全区 → CSS 变量。

### 2.6 构建 / 测试 / 交付

| 环节 | 方式 |
|---|---|
| Web 产物 | esbuild 单文件 IIFE（约 1.1 MB minified）→ `app2/www/js/app.js` |
| 测试 | `tests/` **45 个文件 / 13,286 行 / 3,847 条断言**，零 DOM，Node 直跑 |
| APK | 无 Gradle：`javac` + `d8` → 塞进模板 APK → `apksigner` |
| Web 发布 | `scripts/publish-web.sh --push` → `main` 分支（Pages 根）；`scripts/sync-web.sh` 取回产物 |
| 一致性 | 仓库 / APK / Pages 必须是同一份 md5 |

### 2.7 实测的依赖现状

**好的部分**（这些层已经是目标形态，改造时别动）：

- `app/` **不** import `ui/` ✅
- `tools/` 只依赖 `engine/` + `data/` ✅
- `render/` 只依赖 `engine/` + `tools/` + `io/pcmode` ✅
- 纯函数模块已经很多：`render/rect·onion·cursor·wheel`、`app/canvas-space·canvas-snap·keymap·playback·gestures`、`ui/*-layout`、`engine/*`

**坏的部分**（三处硬伤）：

| # | 症状 | 证据 | 后果 |
|---|---|---|---|
| 1 | **模块级循环依赖** | `app/session.ts:27` `import type { View } from "../render/view"` 且持有 `view_`；`render/view.ts` 又 `import ... from "../app/session"` | 两个最大文件互相咬住，改动风险高 |
| 2 | **业务规则漏进视图层** | `session.ts:1273` `quickFill()` 直接转发给 `view_.quickFill()`；`view_` 在 Session 中被调 10 处（`invalidate`/`markDirty`/`refresh`…） | "填充落在哪"住在 View 里 → 无 DOM 测不到 |
| 3 | **引擎唯一的反向依赖** | `engine/history.ts:3` `import type { ScalarData } from "../app/history-io"` | 破坏了"引擎零上层依赖"这条纪律（纯类型，好修） |

**已经解决一部分**：合成状态（合成缓冲 / 合成键 / 失效区域 / 多画布缓存 / 透明棋盘格）已从 `View` 移到 `RenderServer`，
视图数学移到 `ViewportServer` —— `view.ts` 4820 → 4687 行，而且这两块从「只能靠 DOM 桩间接覆盖」变成**可单测**（+89 条断言）。
但第 1 条（`Session` ↔ `View` 互相 import）仍在，要等 P5 / P6 才能断。

### 2.8 规模与瓶颈

- 四个大文件占全仓 44%（§2.1）；`Session` 有 **287 个公开方法**，职责覆盖文档/工具/调色板/图层/帧/画布/IO/UI 偏好。
- 渲染只做脏矩形增量，**没有 overlay 笔迹层、没有 Worker**（大画布 + 大笔刷吃主线程）。
- 失效通知是**全量** `changed()`：任何改动都触发整棵 React 树重算，没有分域订阅。
- 交互层几乎测不到（无 DOM；`tests/view.test.ts` 用 DOM 桩，覆盖有限）。

---

## 3. 目标架构：Server 化

### 3.1 从 Godot 取什么、不取什么

Godot 4 的 server（`RenderingServer` / `DisplayServer` / `PhysicsServer2D` / `NavigationServer` / `TextServer`）
是**低层后端**，节点是前端，把命令推给 server；RID 是不透明句柄；server 命令可跨线程。

| Godot 的特征 | 它解决的问题 | 我们取不取 |
|---|---|---|
| 节点（前端）薄、server（后端）厚 | 业务规则不散落在前端 | ✅ **取**：这是核心 |
| server 之间不读对方字段，只通过接口/RID | 解耦、可替换 | ✅ **取原则**（用方法 + 信号，不用 RID） |
| 有明确的所有权（谁能创建/销毁什么） | 避免全局可变状态 | ✅ **取**：`DocumentServer` 独占 `Doc` |
| RID 句柄抽象 | 后端可换、跨线程 | ❌ 不取（TS 单人项目，只会多一层间接） |
| 命令队列 / 多线程提交 | 渲染线程解耦 | ❌ 不取（浏览器单线程，等于白加延迟） |
| 后端可替换（Vulkan/GL） | 多平台后端 | ❌ 不取（只有 Canvas 2D） |

### 3.2 五条设计原则

1. **一个 server 拥有一种状态**：别人只能通过方法读写它；**server 之间不得读对方字段**。
2. **依赖只向下**：`ui → facade → servers → domain(engine) → data`；反向通信**只走信号**。
3. **server 要小**：单个目标 300–600 行，超了继续拆——防止造出第二个 `Session`。
4. **前端薄**：`View` 与 React 组件只做"翻译输入"与"呈现状态"，不放业务规则。
5. **纯算法不进 server**：算法保持纯函数/纯类（可 Node 测），server 只编排状态与流程。

### 3.3 Server 清单

| # | Server | 单一职责 | 拥有的状态 | 依赖 | 明确不负责 |
|---|---|---|---|---|---|
| 1 | **DocumentServer** | 文档结构唯一所有权：画布尺寸、图层、帧、标签、cel 缓冲 | `Doc` | `engine/doc·ops·tags` | 不改历史、不渲染 |
| 2 | **HistoryServer** | 撤销栈与"回合"合并 | `History` 栈、cap、模式 | DocumentServer（回滚时） | 不知道谁调它 |
| 3 | **RenderServer** ✅ 已抽出 `src/servers/render.ts` | 合成与缓存：图层合成、脏矩形、洋葱皮、导出位图 | 离屏 canvas 池、缓存版本 | `engine/compositor·rect·onion` | 不下发输入、不管视图变换 |
| 4 | **ViewportServer** ✅ 已抽出 `src/servers/viewport.ts`（算术已搬，状态暂留 `View`） | 视图数学：scale/offset、适配、聚焦、屏幕↔文档坐标 | 视口参数 | — | 不画东西 |
| 5 | **InputServer** | 手势状态机：指针生命周期、双指、长按、PC 修饰键 | 当前手势会话 | Tool/Selection/Viewport、`app/gestures` | 不碰像素 |
| 6 | **ToolServer** | 工具与笔刷参数；"落点序列 → 像素命令"的纯计算 | 当前工具/笔刷/对称/图案 | `tools/stroke`、`engine/symmetry`、`data/patterns` | 不写 doc（产出命令） |
| 7 | **SelectionServer** | 掩膜 + 浮动选区 + 变换/变形/缩放 | `Sel`、浮动会话 | `tools/select·xform·warp`、`engine/resample` | 不画抓手（View 的事） |
| 8 | **PaletteServer** | 调色板/色卡/索引色/色彩明暗/颜色分析 | 调色板与预设 | `data/palettes`、`engine/adjust·color-analysis·shading` | 不画笔迹 |
| 9 | **AnimationServer** | 帧时长、播放循环、播放范围、标签、洋葱皮设置 | 播放状态、`PlayWindow` | `engine/tags`、`app/playback` | 不改帧结构（DocumentServer） |
| 10 | **CanvasSpaceServer** | 多画布空间、聚焦、引用画布、吸附 | 画布列表与布局 | `app/canvas-space·canvas-snap` | 不管单画布内容 |
| 11 | **IosServer** | 打开/保存/自动保存/导出/剪贴板/参考图 | 无状态服务 | `io/*` | 不做用户确认（UI 的事） |
| 12 | **SettingsServer** | 设置注册表、持久化、导入导出、重置 | `prefs` | `app/settings` | 不管业务 |
| 13 | **UiLayoutServer** | 浮动球/栏位/快捷键/手势映射/图标表 | UI 布局偏好 | `app/uibar·keymap·gestures`、`ui/feature-icons` | 不画 UI |
| 14 | **SignalHub** | 分域失效通知 | 订阅表 | — | 不持有业务状态 |
| 15 | **AiServer**（可选，见 `PLAN-ai.md`） | 把 1–7、11 的能力包成工具表 + 回合事务 | 回合状态 | 上面所有 | 不直接改 doc |

现状映射：第 2、8、9、10、11、12、13 项**已有半独立原型**（`History`、调色板模块、`playback`、
`canvas-space`、`io/*`、`settings`、`uibar/keymap`）；真正要新切的是 **3、4、5、6、7、1**，也就是
`Session` 与 `View` 里那 9,300 行的内容。

> **与模块化的关系**：server 是运行时的职责边界，**module 是交付时的裁剪单位**（§4.1）。
> 其中 `SelectionServer`（§3.3 第 7 项）、`AnimationServer`（第 9 项）、`CanvasSpaceServer`（第 10 项）、
> `AiServer`（第 15 项）分别属于可裁剪模块 `selection` / `animation` / `multicanvas` / `ai`。

### 3.4 算法类（抽成纯类，但不做 server）

规则：**只 import `core`/`engine` 类型，绝不 import 任何 server**，可 100% 在 Node 里测。

| 算法族 | 现在的落点 | 建议形态 |
|---|---|---|
| 线段/圆/椭圆栅格化 | `engine/shape.ts`、`tools/stroke.ts` | `BresenhamPath`、`ZinglEllipse` |
| 区域填充 / 渐变 | `engine/paint.ts` | `ScanlineFill`、`BucketFill`、`GradientRamp` |
| 颜色数学 | `engine/color.ts`、`color-analysis.ts` | `ColourDistance`（含板色吸附）、`ColourGroups`、`Histogram` |
| 重采样 | `engine/resample.ts`（巨型 `switch`） | `Resampler` 基类 + `Nearest/Bilinear/Bicubic/Area/Scale2x/Scale3x` 六个子类 |
| 变换解算 | `tools/xform.ts`、`warp.ts` | `AffineSolver`、`HomographySolver`、`MeshWarp` |
| 等距投影 | `engine/iso.ts` | `IsoProjection21`（几何）+ `IsoVoxels`（体素） |
| 色阶生成 | `engine/shading.ts` | `ShadingRamps` + `Harmonics` |
| 编解码 | `io/zlib.ts`、`engine/b64.ts` | `Inflate`、`Deflate`、`Base64` |

### 3.5 目标依赖图

```
              ┌──────────────────────── ui/ (React) ────────────────────────┐
              │ App.tsx / modals / timeline / canvas / 浮动球 / kit          │
              └───────────────┬──────────────────────────────▲──────────────┘
                              │ 调用                          │ 订阅（分域）
              ┌───────────────▼──────────────────────────────┴──────────────┐
              │ AppFacade（原 Session 的壳：只转发与组装，目标 ≤600 行）      │
              └──┬─────┬──────┬──────┬──────┬──────┬──────┬───────┬─────────┘
                 │     │      │      │      │      │      │       │
        ┌────────▼─┐ ┌─▼────┐ ┌▼────┐ ┌▼─────┐ ┌▼─────┐ ┌▼────┐ ┌▼──────┐ ┌▼────────┐
        │Document  │ │History│ │Tool │ │Select│ │Palette│ │Anim │ │Ios    │ │CanvasSp │
        │Render    │ │       │ │Input│ │      │ │Shade  │ │Tags │ │Setting│ │UiLayout │
        │SignalHub │ └───┬───┘ └──┬──┘ └───┬──┘ └───┬──┘ └──┬───┘ └───┬───┘ └────┬────┘
        └────┬─────┘     │        │        │        │       │         │          │
             ▼           ▼        ▼        ▼        ▼       ▼         ▼          ▼
     ┌──────────────────────────────────────────────────────────────────────────────┐
     │ domain：engine/*（纯函数）· algorithms（纯类）· tools/*（纯计算）              │
     └──────────────────────────────────────────────────────────────────────────────┘
                                         ▼
                              data/palettes · data/patterns
```

**唯一允许的"向上"通道是 SignalHub。**

### 3.6 信号总线与分域订阅

现状：任何改动都 `changed()` → 整棵 React 树重算。目标：分域信号 + 细粒度订阅。

```ts
// 频道（示例）
"doc.changed"      { rect: Rect | null }   // null = 全量
"doc.structure"    { kind: "layer"|"frame"|"size"|"tag" }
"history.changed"  { canUndo: boolean; canRedo: boolean; depth: number }
"render.painted"   { rect: Rect }
"selection.changed"{ bounds: Rect | null }
"palette.changed"  { }
"playback.tick"    { frame: number }
"io.saved"         { path: string | null }
```

React 侧用一个极小的适配层订阅需要的频道（保留 `useSyncExternalStore` 语义），
`App.tsx` 的 `snapshot` 拆成若干个按域的快照——**这是砍掉 `App.tsx` 复杂度的关键一步**。

### 3.7 三条链路在新架构下的样子

**① 一次落笔**
`InputServer.onPointerDown` → 判定手势 → `ToolServer.beginStroke(...)` → 产出像素命令 →
`DocumentServer.applyPixels(cmd)` → `HistoryServer.record(...)` → `SignalHub.emit("doc.changed", rect)` →
`RenderServer.composeRect(rect)` → `View` 只 blit 脏矩形。

**② 一次撤销**
`HistoryServer.undo()` → `DocumentServer.restore(snapshot)` → `emit("doc.changed", null)` → `RenderServer` 全量失效。

**③ 一次 AI 工具调用**（`PLAN-ai.md` C1）
`AiServer.callTool("draw_path", …)` → `HistoryServer.beginTurn()` → **复用 ① 的同一条链路** →
`RenderServer` 出预览 → 用户确认 → `HistoryServer.commitTurn()`（一轮 = 一条 undo）。
**AI 与手指走完全相同的 server API，不新增特权通道。**

### 3.8 分层规则速查

| 从 \ 到 | core/engine | algorithms | tools | servers | facade | ui |
|---|---|---|---|---|---|---|
| core/engine | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| algorithms | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| tools | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| servers | ✅ | ✅ | ✅ | ✅（只经方法/信号） | ❌ | ❌ |
| facade | ✅ | ✅ | ✅ | ✅ | — | ❌ |
| ui | ✅（只读类型/枚举） | ❌ | ❌ | ❌（只经 facade 与信号） | ✅ | ✅ |

---

---

## 4. 模块化：可裁剪的交付单位

> 目标：像 Godot 那样「**不要的模块直接不编进去**」——产出更小的包、更少的界面噪音、更清晰的所有权，
> 同时**绝不破坏"打开旧工程不丢数据"**。
> 一句话分工：**Server 回答"运行时谁负责什么"，Module 回答"这一版要不要这个功能"**。

### 4.1 Server 与 Module 是两个正交维度

| 维度 | 回答的问题 | 单位 | 例子 |
|---|---|---|---|
| **Server**（§3） | 运行时的**职责与所有权**：谁持有状态、谁能改它 | 常驻单例 | DocumentServer、RenderServer |
| **Module**（本节） | 交付时的**打包与裁剪**：这个功能编不编进这一版 | 可裁剪包 | `iso`、`aseprite-io`、`guide` |

关系：**一个模块 = 若干 server 的能力 + 贡献点（工具 / 设置 / 引导 / 图标 / 文案 / 导出器）+ 自己的测试**；
server 是模块的运行时骨架，模块是 server 的可选装配。core 永远包含最小 server 集。

| 模块 | 提供的 server / 能力 |
|---|---|
| `core`（不可裁剪） | DocumentServer、HistoryServer、RenderServer、ViewportServer、InputServer（基础）、ToolServer（基础）、PaletteServer（基础）、SettingsServer、UiLayoutServer、IosServer（PNG + `.pxc`）、SignalHub |
| `selection` | SelectionServer（掩膜 + 浮动模型） |
| `animation` / `tags` | AnimationServer（播放 / 洋葱皮 / 标签） |
| `multicanvas` | CanvasSpaceServer |
| `color-analysis` / `shading` | PaletteServer 的进阶能力（统计 / 替换 / 色阶生成） |
| `ai` | AiServer（见 `docs/PLAN-ai.md`） |

### 4.2 模块清单

**core（不可裁剪）**：文档与历史、合成与视口、基础输入、基础绘制工具（铅笔/橡皮/油漆桶/直线/矩形/椭圆/吸管）、
基础调色板与取色、PNG 导出与 `.pxc` 工程、设置与 i18n 核心、主题与安全区、原生桥。

**可选模块**（可关；行数是本文实测的源码行数）：

| 模块 | 提供 | 依赖 | 现状落点（行） |
|---|---|---|---|
| `selection` | 框选/魔棒/套索、掩膜运算、浮动选区 | core | `tools/select.ts` 739 |
| `xform` | Aseprite 式自由变换（8 锚点 + 枢轴 + 干净角 + 斜切） | selection | `tools/xform.ts` 925 |
| `warp` | 四角透视与网格变形 | selection | `tools/warp.ts` 359 |
| `resample` | 高级缩放六算法 + 对比预览 | core | `engine/resample.ts` 514 + `ui/scale-preview.ts` 126 |
| `effects` | 描边/内描边/圆角/模糊/投影/外发光/反色/灰度/居中/裁剪 | core | `engine/effects.ts` 439 |
| `color-analysis` | 颜色统计、近似色分组、替换、按色建选区、CSV | palette | `engine/color-analysis.ts` 519 |
| `shading` | 色彩明暗（六条色阶 + 互补·三角·四角） | palette | `engine/shading.ts` 209 |
| `animation` | 帧、时长、播放循环与速度、洋葱皮 | core | `app/playback.ts` 127 + `ui/timeline.tsx` 609 |
| `tags` | 动画标签与播放范围 | animation | `engine/tags.ts` 105 |
| `iso` | 2:1 等距图形生成器与参数条 | core+input | `engine/iso.ts` 529 + `ui/iso.tsx` 171 |
| `aseprite-io` | `.ase` / `.aseprite` 读写 | core.io | `io/aseread.ts` 523 + `asewrite.ts` 357 + `zlib.ts` 262 |
| `gif` | GIF 导出（+ 读帧导入） | resample? | `io/exporters.ts` 的 `encodeGIF` + `io/gifread.ts` 43 + omggif |
| `spritesheet` | 精灵表导出与按格切帧导入 | core.io | `ui/modals.tsx` 的 Sheet 部分（需拆分） |
| `patterns` | 图案库与图案笔刷 | core.tools | `data/patterns.ts` 139 |
| `multicanvas` | 无限画布空间、引用画布、画布锁、吸附 | core | `app/canvas-space.ts` 67 + `canvas-snap.ts` 290 + `ui/canvas.tsx` 193 |
| `pc-mode` | 电脑模式：键鼠输入、快捷键、饼菜单、拖放 | core.input | `io/pcmode.ts` 143 + `app/keymap.ts` 141 + `shortcuts.ts` 236 |
| `guide` | 54 步引导（真操作演示） | core.ui | `app/guide.ts` 408 + `ui/guide*.tsx` 386 |
| `changelog` | 更新日志面板 | core.ui | `ui/changelog.tsx` 796 |
| `refimage` | 参考图浮窗 | core | `io/refstore.ts` 91 + `ui/refimg.tsx` 152 |
| `history-replay` | 历史面板与回放 | core.history | `ui/replay.tsx` 160 + `modals.tsx` 的 History 部分 |
| `frame-preview` | 帧预览浮窗 | animation | `ui/preview.tsx` 168 |
| `ai`（未实现） | 应用内助手 / 本机工具服务 | 按 `PLAN-ai.md` | — |

### 4.3 模块契约（manifest）

```ts
export interface ModuleManifest {
  id: string;                  // "iso"
  titleKey: string;            // i18n 键（模块名）
  deps?: string[];             // 依赖的模块 id：未启用则构建**报错**（不是静默降级）
  provides: {                  // 只允许"贡献"，不允许改核心逻辑
    servers?: string[]; tools?: ToolId[]; settings?: string[]; orbItems?: string[];
    actions?: string[]; modals?: string[]; guideSteps?: string[]; gestures?: string[];
    icons?: string[]; exporters?: string[]; shortcuts?: string[];
  };
  register(ctx: ModuleCtx): void;   // 唯一入口：把上面的东西"投递"进注册表
  onDocOpen?(doc: Doc): void;       // 可选：打开工程时的兼容处理
  i18n: { zh: Dict; en: Dict };     // 模块自带的文案片段（zh/en 成对）
}

// ctx 由核心提供，是模块能碰到的**全部**东西
interface ModuleCtx {
  addSetting(def: SettingDef): void;   addOrbItem(ball: BallId, item: Item): void;
  addTool(t: ToolDef): void;           addAction(id: string, a: Action): void;
  addModal(id: ModalId, c: ComponentType): void;   addGuideStep(step: GuideStep): void;
  addGesture(id: string): void;        addExporter(fmt: ExporterDef): void;
  addShortcut(k: KeyBinding): void;    use<T>(server: ServerName): T;   // 取依赖模块暴露的 API
}
```

**五条模块红线**（违反即 CI 失败，脚本 + 测试双重拦截）：

1. **模块只能贡献，不能分支**：核心代码里不许出现 `if (moduleId === "iso")` 这种判断；
   只有 §4.5 那 5 个能力位例外（新增能力位要过评审）。
2. **id 全局唯一**：设置 `path`、球条目 id、动作 id、工具 id、图标 id、手势 id、弹窗 id、引导步骤 id 都不许撞车。
3. **模块之间不得 import 实现文件**：只允许 `import type`（类型）与 `ctx.use()`（依赖模块暴露的 API）。
4. **模块不得直接改 `Doc`**：一律经 DocumentServer（§6 红线 2）。
5. **模块自带测试**：`tests/modules/<id>.test.ts`；模块未启用时它的测试**一起跳过**（不报"缺失"）。

### 4.4 构建机制（Godot 的对应物）

| Godot | 本项目 |
|---|---|
| `modules/*/config.py` 的 `can_build()` / `is_enabled()` | `src/modules/*/module.ts` 的 manifest + `scripts/modules.mjs` 校验 |
| scons 参数 `module_x_enabled=no` / `disable_3d=yes` | 仓库根 `modules.config.json`（`preset` + `enable` / `disable`） |
| 生成的 `modules_enabled.gen.h`（`MODULE_X_ENABLED` 宏） | 生成的 `src/modules/_generated.ts`（**只静态 import 启用的模块** + `ENABLED` 常量表） |
| `#ifdef MODULE_X_ENABLED` 守卫 | `ENABLED.x` 常量分支（核心刻意少用，见红线 1） |
| 不编的模块根本不进二进制 | esbuild 静态可达性：没被 import 的模块**根本不在依赖图里**，天然被剔除 |
| `Engine.has_singleton()` / 编辑器隐藏入口 | 注册表查询：没注册的入口**不存在**（不是灰掉） |
| GDExtension（运行期动态加载） | **不做**：APK/PWA 离线、无插件市场，动态加载只会带来异步与失败路径 |

**为什么必须是"生成的静态 import"**：只有静态可达才能让 esbuild 丢掉整棵子树；
`import()` 在"单文件 IIFE + `file://` 离线"的形态里做不到真剔除。构建流程：

```
modules.config.json ──> scripts/modules.mjs ──> src/modules/_generated.ts ──> esbuild ──> app.js
   （选模块）          （校验依赖/环/唯一性）      （只有启用的模块被 import）      （剔除未引用的模块）
```

### 4.5 缺省时的优雅降级（能力位）

绝大多数情况核心**不需要知道**模块是否存在（入口/设置/工具都来自注册表）。只有少数"核心必须适配"的地方
用 `_generated.ts` 里的编译期常量：

| 能力位 | 谁需要 | 关掉时的行为 |
|---|---|---|
| `ENABLED.animation` | 底栏 / 时间轴 | 不渲染时间轴，帧相关快捷键不注册 |
| `ENABLED.tags` | 时间轴标签条 | 标签条消失；工程里已有的标签**原样保留** |
| `ENABLED.selection` | 底栏 / 选择球 | 选择球不存在，"全选/反选"等动作不注册 |
| `ENABLED.multicanvas` | 画布球 / 标题栏 | 退回单画布形态 |
| `ENABLED.pcMode` | 输入层 | 只走触摸分支，`(pointer:fine)` 相关代码不编译 |

**数据格式永远是超集**（最重要的一条不变量）：`.pxc` / `.aseprite` 的读写**不随裁剪变化**——
关掉 `tags` 也要能读写标签字段、关掉 `animation` 也要能保存多帧、关掉 `refimage` 也不能丢参考图记录。
**裁剪只影响"能不能编辑/显示"，绝不影响"打开 → 保存"的数据完整性**，并且要有测试兜住。

### 4.6 i18n / 设置 / 引导 / 图标 / 测试 的模块化

| 项 | 现在 | 模块化后 |
|---|---|---|
| i18n | 一个 833 行的巨型字典（中英各一份） | 每模块自带 `i18n.ts` 片段，构建时合并；`tests/i18n.test.ts` **按启用模块**校验，关掉模块不报"键缺失" |
| 设置 | 74 条集中在 `app/settings.ts` | 模块走 `ctx.addSetting()`；关掉模块设置项自然消失 |
| 引导 | 54 步全量注册 | 模块贡献自己的步骤；`guide-anchors.test.ts` 只校验启用模块的锚点 |
| 图标 | `feature-icons.ts` 全量、同屏唯一 | 分组按**启用模块**计算（现在是一次性全量） |
| 测试 | 45 个文件全量跑 | 每模块 `tests/modules/<id>.test.ts`；未启用即跳过；清单由 `tests/modules.test.ts` 校验 |
| 静态扫描测试 | 扫 `src/ui` 全部 | 扫「core + 启用模块」，并新增断言：**核心不得出现可选模块的字面量**（如关掉 iso 后 `App.tsx` 里不得有 `i-iso`） |

### 4.7 变体与预设

| 预设 | 含模块 | 用途 | 产物 |
|---|---|---|---|
| `pixel-core` | 只有 core | 极致精简（绘制 + PNG + `.pxc`） | 最小 APK / Web |
| `lite` | core + selection + effects + resample + palette 增强 | 手机日常 | 中等 |
| `full`（默认） | 全部可选模块 | 与今天一致 | 现在这个包 |
| `studio` | full + `ai` | 未来带 AI | — |

产线：`MODULES=full sh /root/pk/make-apk.sh <版本> <code>`（APK 文件名带变体后缀）、
`MODULES=lite sh scripts/build-web.sh`（Web 产物带变体名）；**每个预设都要跑 tsc + 测试 + `check-bundle`**。

### 4.8 体积收益（诚实估算）

方法：线上实测 bundle = **1,130,178 字节**（minified，含 React）；`src` 总量 32,916 行，
§4.2 列出的可选模块合计约 **9,900 行**（本文逐文件实测，占 `src` 的 30%）。
按"每行 ≈ 34 字节（含共享 React 摊销）"粗估：

- **全开 → core-only：bundle 约省 25–35%（300–400 KB，gzip 后约 90–120 KB）**；
- APK 从约 **575 KB** 降到约 **520 KB** 量级。

**但请把预期放在别处**：真正的收益是 ①**一个仓库出多种产品形态** ②交付与界面的复杂度上限
③新人 / AI 只需读懂启用模块 ④"这个功能是不是漏进核心了"有了可执行的判据。
**不要为了省 50 KB 做这件事。**

### 4.9 前置条件与分期

**硬前置**：模块的贡献点（浮动球条目、弹窗、动作）今天**硬编码在 `App.tsx`（2,898 行）与 `modals.tsx`（2,246 行）里**，
所以模块化**必须排在 Server 化之后**（至少完成 P3 收拢 Selection、P4 拆 `view.ts`、P7 注册表与信号）。
否则"搬模块"就得改那两个大文件，等于没模块化。

| 期 | 内容 | 前置 | 验收 |
|---|---|---|---|
| **M0** | `scripts/modules.mjs` + `_generated.ts` + `tests/modules.test.ts`（此刻只有 core，**行为零变化**） | 无（可与 P0–P2 并行） | 构建与测试全绿；清单校验能拦住"依赖缺失 / 成环 / id 重复" |
| **M1** | 搬最独立的三个：`aseprite-io`、`iso`、`color-analysis`+`shading` | P3 / P4 | 全开时 bundle 与行为不变；关掉后**无悬空入口**，tsc / 测试 / `check-bundle` 全绿 |
| **M2** | `animation`+`tags`、`effects`、`resample`、`patterns`、`frame-preview` | M1 | 同上 + `.pxc` **数据完整性测试**通过 |
| **M3** | `multicanvas`、`pc-mode`、`guide`、`changelog`、`refimage`、`gif`、`spritesheet`、`history-replay` | P5–P7 | 三个预设各自全绿 |
| **M4** | `ai`（新功能**直接按模块写**）+ APK / Web 两条产线 + CI 三预设矩阵 | M3 | `pixel-core` 与 `studio` 都能出包 |

### 4.10 风险与代价

| 风险 | 说明 | 对策 |
|---|---|---|
| **ifdef 地狱** | 模块一旦开始"让核心适配"，`ENABLED.x` 会到处蔓延，可读性反而下降 | 红线 1：只能贡献；能力位限定在 §4.5 的 5 个，新增要过评审 |
| **组合爆炸** | N 个模块 → 2^N 种配置无法全测 | 只保证三个预设（`pixel-core` / `full` / `studio`）进 CI 全测；单模块关闭由"关掉后 tsc + 冒烟"覆盖 |
| **体积收益有限** | 见 §4.8 | 目标定在交付变体与复杂度，不是 KB |
| **裁剪导致丢数据** | 关掉模块后保存旧工程丢字段 | §4.5"格式永远是超集" + 完整性测试 |
| **测试工具要改** | i18n / 图标 / 引导锚点测试现在全量扫描 | M0 一并改成"按启用模块扫描" |
| **UI 悬空入口** | 关掉模块后菜单留下死入口 | 入口一律来自注册表 + 新增静态断言（核心不得出现可选模块字面量） |
| **文档与文案分叉** | 每模块各写一份 README？ | 对外仍只有一份 `README.md`（功能表标注模块），`docs/API.md` 按模块加小节标题 |

---

## 5. 迁移计划（绞杀者模式）

### 5.1 总策略

1. **`Session` 保留为门面 + 兼容层**：方法体逐步改成一行转发（`this.history.undo()`），**UI 一行不改**。
2. 每期只搬一个域，搬完立刻跑全量回归；**任何一期都可以停下**，停在中间也是可用状态。
3. 先修三处硬伤中的第 3 条（`engine/history.ts` 的类型泄漏），它是零风险的顺手活。

### 5.2 分期

| 期 | 拆什么 | 为什么这个顺序 | 验收 |
|---|---|---|---|
| **P0** | `HistoryServer` | 最小、最纯、独立性强，先证明模式可行 | 断言只增不减；`histMode`/cap/回合行为逐条一致 |
| **P1** | `PaletteServer` | 自成一体，只依赖 engine + data | 调色板/色卡/索引色/色彩明暗行为不变 |
| **P2** | `AnimationServer` | 播放与标签已是纯逻辑 | 播放范围、循环模式、速度用例全绿 |
| **P3** | `SelectionServer` | 收拢 `xform/warp/resample`，**切断 View 里的选区业务分支** | `tests/xformui.test.ts` 那套行为断言全绿 |
| **P4** | `RenderServer` + `ViewportServer` | 拆 `view.ts`（4,820） | 同一文档合成结果**逐字节一致**；脏矩形面积不退化 |
| ↳ | **状态：🟡 部分完成**（2026-09-14）：`RenderServer` / `ViewportServer` 已落地（`src/servers/`），`View` 只剩 11 处委托；继续拆的是手势状态机（P5）与 `View` 持有的视口字段 | — | 全量测试 3936 条 ALL PASS；`check-bundle` 通过 |
| **P5** | `InputServer` | 手势状态机真正搬出 View | 手势 / PC 模式 / 多球互斥用例全绿 |
| **P6** | `DocumentServer` | **最后动**（所有人依赖它） | "cel 与画布等大"等不变量由类型与断言守住 |
| **P7** | `SignalHub` | 分域订阅替换全量 `changed()` | React 重渲染次数下降；UI 无视觉回归 |
| **P8** | `AiServer` | 纯增量，前七期完成后自然长出 | 按 `docs/PLAN-ai.md` 的 C1 验收 |

**模块期（M0–M4）**：见 §4.9。两条线的关系是**交错**的——M0（模块工具链与清单校验）可以与 P0–P2 并行，
M1–M2 必须在 P3/P4（收拢 Selection、拆 `view.ts`）之后，M3–M4 在 P5–P7（输入、文档、注册表与信号）之后。
简图：

```
Server 化： P0 ─ P1 ─ P2 ─ P3 ─ P4 ─ P5 ─ P6 ─ P7 ────────── P8(AiServer)
模块化：    M0 ────────────────┴──── M1 ─ M2 ────────┴── M3 ─ M4
            （工具链，可并行）         （最独立的模块）      （UI 类模块与变体）
```

### 5.3 每期统一验收口径

- `tsc --noEmit` 0 错误；全量测试 **ASSERTIONS 只增不减**、末尾 `ALL PASS`；
- **行为回归**：同一串操作前后，文档像素与等效输出逐字节一致（关键路径可以留"黄金 md5"测试）；
- UI 零改动（除信号订阅那一期）；
- 按 `AGENTS.md` §5.3 同步 `docs/API.md` 对应小节；一次提交一个域。

### 5.4 风险与回滚

| 风险 | 对策 |
|---|---|
| 拆一半卡住 | 绞杀者模式：旧路径始终可用，`Session` 门面同时支持新旧实现 |
| 顺手把行为改了 | 每期先补"行为断言"再搬代码（测试先行） |
| 造出新的上帝（如 locator 单例表） | 见 §6 红线 |
| 收益看不见 | 每期记录：文件行数、断言数、React 重渲染次数（用一个计数器统计） |

### 5.5 量化目标

| 指标 | 现在 | 目标 |
|---|---|---|
| `view.ts` | 4,820 行 | ≤ 1,200 行（拆成 4 个模块） |
| `session.ts` | 4,506 行 | ≤ 600 行门面 |
| `App.tsx` | 2,898 行 | ≤ 1,800 行（分域订阅后拆出面板） |
| 四个最大文件占比 | 44% | ≤ 25% |
| 可测面 | 引擎 / 纯函数 | 引擎 + servers + 交互状态机 |
| 可裁剪模块 | 0（全部编进同一个包） | 21 个可选模块（另有未实现的 `ai`），3–4 个预设（§4.7） |
| core-only bundle | 1,130,178 字节（全开） | 约 750–830 KB（§4.8 估算） |

---

## 6. 红线（防止造出新的上帝）

1. **Server 之间只走方法/信号**：禁止 `locator.get("doc").cels.set(...)` 式的穿透。
2. **`DocumentServer` 是唯一能改 `Doc` 的地方**——今天"谁都能改 cel"正是纠缠的根因。
3. **不搞全局 ServiceLocator 单例表**（换汤不换药）：显式构造注入，只在 UI 边界保留 `SESSION` 门面。
4. **不做 RID / 句柄 / 命令队列**：除非真要换渲染后端或上多线程，那是过度设计。
5. **不为分层而分层**：纯算法不进 server；`ui/kit` 这类呈现组件不进 server；设置注册表这类声明式数据表保持现状。
6. **不动已经干净的三层**（`engine`/`tools`/`io` 的内部结构），只在必要时把它们包进 server。
7. **模块只能贡献，不能分支**：核心代码里不得出现 `if (模块 id)`；能力位只限 §4.5 那 5 个（§4.3 红线 1）。
8. **模块之间不得 import 实现文件**：只允许 `import type` 与 `ctx.use()`（§4.3 红线 3）。
9. **数据格式永远是超集**：裁剪不得影响 `.pxc` / `.aseprite` 的读写完整性（§4.5）。

---

## 7. 不变量与工程约定

改代码前必须知道（全文见 `AGENTS.md`）：

1. **cel 恒与画布等大**；只有"整个图像"类操作才改画布尺寸。
2. **引擎零 DOM**：`engine/`、`tools/`、纯逻辑必须能在 Node 下测。
3. **一条操作一条 undo**；结构变更用 `pushStruct`，像素改动用 `pushPixels`。
4. **`Session` 是 UI 的唯一入口**（改造后是 `AppFacade`），UI 不得直接写 `Doc`/`Cel`。
5. **加功能＝加声明**（settings / guide / gestures / feature-icons）+ **同步 `docs/API.md`**。
6. **版本号三处一致**（`AndroidManifest.xml` / `APP_VERSION` / 更新日志），已有测试拦截。
7. **文档格式是超集**：`.pxc` / `.aseprite` 的字段读写不随模块裁剪变化；关掉一个模块不能导致保存时丢字段。

---

## 8. 决策点

1. 是否按本文的**目标分层**推进（绞杀者模式），还是只做"算法类提取"这类低风险局部改造？
2. 分期顺序是否调整（比如把 P4「拆 view.ts」提前，因为它是最痛的点，但改动面也最大）？
3. `SignalHub` 的粒度：先做 5–6 个频道，还是一次性把所有域都信号化？
4. 是否引入**依赖方向检查**（一个脚本扫描 import，违反 §3.8 即失败）来守住新架构？（推荐做，成本低）
5. **模块粒度的取舍**：`selection` / `xform` / `warp` 要不要拆成三个模块，还是合成一个 `transform` 模块？
   （拆得细 = 裁剪更灵活，但依赖图与界面分组的维护成本更高）
6. **要不要运行期开关**（除了编译期裁剪）：比如"模块已编进来但用户在设置里关掉"——
   好处是同一个包能试不同组合，坏处是与编译期能力位形成两套机制，容易混乱。建议：**只做编译期裁剪**。
7. **预设的取舍**：只维护 `full` + `pixel-core` 两个，还是四个预设都要（§4.7）？
8. **Android 侧裁剪**：Java 桥（`PixelBridge` 8 个方法）是否也按模块裁剪？建议**不裁**——
   Java 层保持"最小且通用"，模块不放 Java 代码，避免 dex 与 Web 资源两套裁剪逻辑打架。

---

## 9. 进度

| 期 | 状态 |
|---|---|
| 现状盘点 + 目标架构（本文） | ✅ 2026-09-14 |
| 修 `engine/history.ts` 的类型反向依赖 | ⬜ |
| P0 HistoryServer | ⬜ |
| P4 RenderServer + ViewportServer | 🟡 部分完成（`src/servers/`：合成状态与视图数学已抽出，+89 条断言） |
| P1 PaletteServer | ⬜ |
| P2 AnimationServer | ⬜ |
| P3 SelectionServer | ⬜ |
| P4 RenderServer + ViewportServer | ⬜ |
| P5 InputServer | ⬜ |
| P6 DocumentServer | ⬜ |
| P7 SignalHub | ⬜ |
| P8 AiServer | ⬜ |
| M0 模块工具链（`scripts/modules.mjs` + `_generated.ts` + 清单测试） | ⬜ |
| M1 搬 `aseprite-io` / `iso` / `color-analysis`+`shading` | ⬜ |
| M2 搬 `animation`+`tags` / `effects` / `resample` / `patterns` | ⬜ |
| M3 搬 `multicanvas` / `pc-mode` / `guide` / `changelog` / `refimage` / `gif` / `spritesheet` | ⬜ |
| M4 `ai` 模块 + 两条产线 + CI 三预设矩阵 | ⬜ |
