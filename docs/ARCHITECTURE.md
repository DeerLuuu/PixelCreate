# PixelCraft 架构：现状、目标与 Server 化改造

> 状态：**现状盘点 + 目标架构设计**（2026-09-14）。改造**尚未开工**，分期计划见 §4，红线见 §5。
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
| 3 | **RenderServer** | 合成与缓存：图层合成、脏矩形、洋葱皮、导出位图 | 离屏 canvas 池、缓存版本 | `engine/compositor·rect·onion` | 不下发输入、不管视图变换 |
| 4 | **ViewportServer** | 视图数学：scale/offset、适配、聚焦、屏幕↔文档坐标 | 视口参数 | — | 不画东西 |
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

## 4. 迁移计划（绞杀者模式）

### 4.1 总策略

1. **`Session` 保留为门面 + 兼容层**：方法体逐步改成一行转发（`this.history.undo()`），**UI 一行不改**。
2. 每期只搬一个域，搬完立刻跑全量回归；**任何一期都可以停下**，停在中间也是可用状态。
3. 先修三处硬伤中的第 3 条（`engine/history.ts` 的类型泄漏），它是零风险的顺手活。

### 4.2 分期

| 期 | 拆什么 | 为什么这个顺序 | 验收 |
|---|---|---|---|
| **P0** | `HistoryServer` | 最小、最纯、独立性强，先证明模式可行 | 断言只增不减；`histMode`/cap/回合行为逐条一致 |
| **P1** | `PaletteServer` | 自成一体，只依赖 engine + data | 调色板/色卡/索引色/色彩明暗行为不变 |
| **P2** | `AnimationServer` | 播放与标签已是纯逻辑 | 播放范围、循环模式、速度用例全绿 |
| **P3** | `SelectionServer` | 收拢 `xform/warp/resample`，**切断 View 里的选区业务分支** | `tests/xformui.test.ts` 那套行为断言全绿 |
| **P4** | `RenderServer` + `ViewportServer` | 拆 `view.ts`（4,820） | 同一文档合成结果**逐字节一致**；脏矩形面积不退化 |
| **P5** | `InputServer` | 手势状态机真正搬出 View | 手势 / PC 模式 / 多球互斥用例全绿 |
| **P6** | `DocumentServer` | **最后动**（所有人依赖它） | "cel 与画布等大"等不变量由类型与断言守住 |
| **P7** | `SignalHub` | 分域订阅替换全量 `changed()` | React 重渲染次数下降；UI 无视觉回归 |
| **P8** | `AiServer` | 纯增量，前七期完成后自然长出 | 按 `docs/PLAN-ai.md` 的 C1 验收 |

### 4.3 每期统一验收口径

- `tsc --noEmit` 0 错误；全量测试 **ASSERTIONS 只增不减**、末尾 `ALL PASS`；
- **行为回归**：同一串操作前后，文档像素与等效输出逐字节一致（关键路径可以留"黄金 md5"测试）；
- UI 零改动（除信号订阅那一期）；
- 按 `AGENTS.md` §5.3 同步 `docs/API.md` 对应小节；一次提交一个域。

### 4.4 风险与回滚

| 风险 | 对策 |
|---|---|
| 拆一半卡住 | 绞杀者模式：旧路径始终可用，`Session` 门面同时支持新旧实现 |
| 顺手把行为改了 | 每期先补"行为断言"再搬代码（测试先行） |
| 造出新的上帝（如 locator 单例表） | 见 §5 红线 |
| 收益看不见 | 每期记录：文件行数、断言数、React 重渲染次数（用一个计数器统计） |

### 4.5 量化目标

| 指标 | 现在 | 目标 |
|---|---|---|
| `view.ts` | 4,820 行 | ≤ 1,200 行（拆成 4 个模块） |
| `session.ts` | 4,506 行 | ≤ 600 行门面 |
| `App.tsx` | 2,898 行 | ≤ 1,800 行（分域订阅后拆出面板） |
| 四个最大文件占比 | 44% | ≤ 25% |
| 可测面 | 引擎 / 纯函数 | 引擎 + servers + 交互状态机 |

---

## 5. 红线（防止造出新的上帝）

1. **Server 之间只走方法/信号**：禁止 `locator.get("doc").cels.set(...)` 式的穿透。
2. **`DocumentServer` 是唯一能改 `Doc` 的地方**——今天"谁都能改 cel"正是纠缠的根因。
3. **不搞全局 ServiceLocator 单例表**（换汤不换药）：显式构造注入，只在 UI 边界保留 `SESSION` 门面。
4. **不做 RID / 句柄 / 命令队列**：除非真要换渲染后端或上多线程，那是过度设计。
5. **不为分层而分层**：纯算法不进 server；`ui/kit` 这类呈现组件不进 server；设置注册表这类声明式数据表保持现状。
6. **不动已经干净的三层**（`engine`/`tools`/`io` 的内部结构），只在必要时把它们包进 server。

---

## 6. 不变量与工程约定

改代码前必须知道（全文见 `AGENTS.md`）：

1. **cel 恒与画布等大**；只有"整个图像"类操作才改画布尺寸。
2. **引擎零 DOM**：`engine/`、`tools/`、纯逻辑必须能在 Node 下测。
3. **一条操作一条 undo**；结构变更用 `pushStruct`，像素改动用 `pushPixels`。
4. **`Session` 是 UI 的唯一入口**（改造后是 `AppFacade`），UI 不得直接写 `Doc`/`Cel`。
5. **加功能＝加声明**（settings / guide / gestures / feature-icons）+ **同步 `docs/API.md`**。
6. **版本号三处一致**（`AndroidManifest.xml` / `APP_VERSION` / 更新日志），已有测试拦截。

---

## 7. 决策点

1. 是否按本文的**目标分层**推进（绞杀者模式），还是只做"算法类提取"这类低风险局部改造？
2. 分期顺序是否调整（比如把 P4「拆 view.ts」提前，因为它是最痛的点，但改动面也最大）？
3. `SignalHub` 的粒度：先做 5–6 个频道，还是一次性把所有域都信号化？
4. 是否引入**依赖方向检查**（一个脚本扫描 import，违反 §3.8 即失败）来守住新架构？（推荐做，成本低）

---

## 8. 进度

| 期 | 状态 |
|---|---|
| 现状盘点 + 目标架构（本文） | ✅ 2026-09-14 |
| 修 `engine/history.ts` 的类型反向依赖 | ⬜ |
| P0 HistoryServer | ⬜ |
| P1 PaletteServer | ⬜ |
| P2 AnimationServer | ⬜ |
| P3 SelectionServer | ⬜ |
| P4 RenderServer + ViewportServer | ⬜ |
| P5 InputServer | ⬜ |
| P6 DocumentServer | ⬜ |
| P7 SignalHub | ⬜ |
| P8 AiServer | ⬜ |
