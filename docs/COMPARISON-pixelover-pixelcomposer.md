# PixelCraft · PixelOver · Pixel Composer 三方对比（只比 2D）

> 本文对比 **PixelCraft 像素工坊（本项目）** 与两个**桌面像素画工具竞品**：**PixelOver**、**Pixel Composer**。
> 与 Aseprite / Resprite 的对比是另一份文档：[`docs/COMPARISON.md`](COMPARISON.md)（本文不重复其内容）。
> **范围：只比 2D。** 两个竞品的 3D 能力一律不进对照表，只在 §5 单列。
>
> 状态标记：`待核` = 本项目侧没能在源码或文档里确认（**不代表没有，只代表没查到**）。
> 竞品侧凡原文已标「(待核)」的，本文照抄「待核」。

---

## 0. 范围与方法

### 0.1 比谁 vs 谁

| 代号 | 对象 | 说明 |
|---|---|---|
| **本项目** | PixelCraft 像素工坊 | 仓库 `/sdcard/Download/ds文件夹/pixelcraft`，当前版本 `1.1.0.0`（`src/ui/changelog.tsx` 的 `APP_VERSION`） |
| **PixelOver** | Deakcor 的实时像素动画软件 | 资料：`/sdcard/Download/pixel-tools-features.md` §一、`/sdcard/Download/PixelOver-功能清单.md`（491 行，主依据是 Steam 官方新闻 API 的 57 条更新公告全文，来源编号 S1–S34） |
| **Pixel Composer** | MakhamDev 的节点式像素合成器 | 资料：`/sdcard/Download/pixel-tools-features.md` §二、`/sdcard/Download/PixelComposer-功能清单.md`（2553 行，924 条节点全表，来源为官方文档站导航树 + 官方 GitHub 仓库 `datasrc/Nodes/**/info.json` + 120 条更新日志） |

### 0.2 只比 2D

- **PixelOver**：3D 图层 / 3D 对象 / 3D 材质 / 3D 骨骼与 IK / 深度位移 / Normal·Depth Buffer / 3D 自动旋转导出 / 3D 文字——见该资料第 13 节（15 条），本文只在 §5 复述结论。
- **Pixel Composer**：官方文档 `nodes/3d/**` 分支共 **66 个节点** + `Rm *`（Ray Marching）全家 + `Psystem 3D *` + 3D 预览面板、骨骼蒙皮与 3D 粒子——见资料第 11 节，本文只在 §5 复述结论。
- 资料里明确标了「容易混淆、但按官方分类属 3D、故排除」的边界项（`Normal*` 系列、`Sprite Stack`、`2D Extrude`、`3D Transform Image`）在 §5 一并说明，**不进入对照表**。

### 0.3 本项目侧如何取证

1. 先读文档：`README.md`（对外功能清单）、`AGENTS.md`（§4 架构要点 / §7 已知缺口 / §8 近期已完成）、`docs/API.md`（模块接口）、`docs/UI.md`、`docs/PC.md`、`docs/COMPARISON.md`（已有对比，用于避免重复）。
2. **再回源码核实**：`src/`（`engine/` `tools/` `app/` `render/` `io/` `ui/`）与 `tests/`。本文「本项目」栏里的依据写成**文件路径 + 符号名**的形式，例如 `src/engine/effects.ts` 的 `outlineCel`、`Session.pasteAsNewCanvas`、`src/app/canvas-snap.ts` 的 `stackGap`。
   - 具体做法：按能力维度分成若干**只读**取证批次，逐条回答「有 / 部分 / 无 / 待核」并给出**文件行号或符号名**，明确要求「源码里找不到的一律记『无』，不许凭印象判『有』」；汇总时只采纳有源码或测试落点的条目，冲突项以源码为准。
   - **口径限制**：本轮只做**静态阅读**——不构建、不跑测试、不比对已发 APK 与本地 `app.js`。因此本文所有「有」都是**源码级**结论，不是运行时验证结论。
3. `README.md` / `AGENTS.md` 只作为线索；**凡结论不能落到源码或接口文档上的，一律写「待核」**，不凭印象写「已有」。

### 0.4 竞品侧资料出处与待核处理

- PixelOver 的每条结论都能追到 `PixelOver-功能清单.md` 的**来源编号 S1–S34**（例如「没有洋葱皮」的依据是 S1–S16 全站检索无命中，见该文件第 7 节末）。
- Pixel Composer 的每条结论都能追到 `PixelComposer-功能清单.md` 的**节点表行**或**小节号**（例如 `Palette Shift` 的说明在该文件 3.3 节 Filter 表内）。
- 资料里标注为 `(待核)` / `（官方文档未给出说明，待核）` 的条目，本文**照抄待核标记**，不做补全。Pixel Composer 侧约 70 个节点官方没写说明（见该文件附录 B）。

### 0.5 一句话定位差异

- **PixelCraft** ＝「把 Aseprite 那套像素算法搬到触屏」的**移动端编辑器**：单文件工程 + 多画布无限空间 + 触屏手势/浮动球，Android APK 与 PWA 同一套代码。
- **PixelOver** ＝ **场景 + 对象 + 逐对象着色器 + 骨骼动画**的实时工具，强在**像素化算法**（indexation / dithering / 描边 / 颜色循环）、**绑定动画**、把 3D 转成像素精灵。
- **Pixel Composer** ＝ **节点图 + 数据流 + 时间轴**的非破坏式合成器，强在**自动化**（数组/迭代/CLI）、**程序化生成**（噪声/图案/SDF/Pixel Builder）、**物理与流体模拟**、**海量滤镜**和**外部互操作**。

---

## 1. 三产品速览

| 项 | **PixelCraft（本项目）** | **PixelOver** | **Pixel Composer** |
|---|---|---|---|
| 一句话定位 | 手机/平板上的像素画与逐帧动画编辑器（APK + PWA 同一套代码，`README.md` §1） | 面向像素画的实时动画软件：把图像/GIF/3D 模型转成像素画并绑定动画（资料 §1.1、S1） | 基于节点图的非破坏式像素画生成器 / 编辑器 / VFX 合成器（资料 §2.1、官方原文 "A Node-based, nondestructive, pixel art generator, editor, and VFX compositor."） |
| 开发者 | 本项目（仓库 `DeerLuuu/PixelCreate`，`AGENTS.md` §5.1b） | Deakcor（个人开发者，Steam 上 developer = publisher，S1/S3） | MakhamDev（GitHub `Ttanasart-pt`，个人开发者，资料 §0） |
| 平台 | **Android APK**（`android/MainActivity.java` 单文件 WebView 壳）+ **PWA/网页**（`app2/www`）；**无原生桌面程序**（`docs/PC.md` §三「不做多窗口」） | Windows 7+ / macOS / Linux 三平台可执行程序（S5）；**要求完整 Vulkan 1.2**，部分核显不支持 | Windows 10+ 64 位（Steam 最低配置）；另有 **Linux 构建**（1.19.5 起）与 **macOS beta**（1.21.9 beta） |
| 价格 / 授权 | **免费**（`README.md`「免费、无广告、可自用移植」；仓库自带 android 打包链） | **$19.99 一次性买断含未来更新**（Steam 国区 ¥76.00）；免费试用版**全功能可用、唯独禁止导出**（S1/S2/S6） | **$15**（2026-07-01 起；历史 $5 → $10 → $15，Steam 国区 ¥59.00） |
| 是否开源 | 源码在本仓库（`src/`、`android/`），**LICENSE 文件待核** | **不开源**（闭源商业软件，EULA，S6） | **开源，MIT**（GitHub `Ttanasart-pt/Pixel-Composer`，GML 编写，资料 §0） |
| 技术栈 / 引擎 | TypeScript + React 18 + Canvas 2D，**无额外运行时框架**（`AGENTS.md` §1）；引擎层零 DOM | **Godot**（0.17 从 Godot 3.5.1 迁到 4.4，0.18.1 到 4.5→4.6，S7/S14） | **GameMaker（GML）**，源码 README 要求 GameMaker Studio IDE 2024.11（资料 §0） |
| 体量 | `src/` **85 个** TS/TSX 文件 **24881 行**（分层：ui 9109 / app 5929 / render 3647 / io 2701 / engine 2108 / tools 1251 / data 64 / main 72；最大单文件 `session.ts` 3662、`view.ts` 3244、`App.tsx` 2706）；`tests/` **35 个**文件 **7108 行**（其中 33 个是测试文件）；另有 `src/ui/style.css` 1238 行 | 未找到代码量口径 → **待核** | 官方口径 "over 300 nodes" / Steam "200+ nodes"；实测**非 3D 节点 924 条（去重 821 个唯一）**、官方仓库 **941 个 `info.json`**（资料 §0、附录 A） | — |
| 当前版本 | **1.1.0.0**（`src/ui/changelog.tsx` 的 `APP_VERSION` = `android/AndroidManifest.xml` 的 `versionName`，versionCode 56） | 稳定版 **0.19**（2026-08-11）+ 热修 0.19.0.1；最新预发布 **0.19.1 RC1**（2026-09-03）；Steam Early Access 自 2021-10-13 | 稳定版 **1.21.0**（2026-04-28）；最新 beta **1.21.9.2**（2026-08-31） |
| 界面语言 | 中英双语（`src/ui/i18n.ts`，单文件双语，`tests/i18n.test.ts` 静态校验键完整） | 8 种语言，翻译托管 Crowdin（S2/S5） | 商店标注界面语言仅 **English**；官方提供本地化管理器，社区有多语言汉化仓库（资料 §0） |
| 目标用户 | 手机/平板随手画的像素画创作者；自用 / 移植作品（`docs/COMPARISON.md` 一） | 独立游戏美术：需要把高清图/3D 转成像素精灵、做骨骼动画与导出管线 | 技术型美术 / 做程序化生成与批量管线的用户：做 VFX、模拟、精灵表自动化 |
| 无 AI 声明 | 未在仓库找到相关声明 → **待核** | 官网明确声明**不含生成式 AI**（S1/S9） | 资料未涉及 → **待核** |
| 隐私 | 数据全部本地（IndexedDB / SAF），无网络上报（`app2/www/js/telemetry.js` 只在本地 devserver 上报）；隐私政策文本 **待核** | 应用不收集/不处理/不传输/不存储个人数据（S9） | 资料未涉及 → **待核** |

---

## 2. 能力维度大对照表（2D）

> 读法：一行一个能力；「本项目」栏的依据是**文件路径 / 符号名**，`待核` = 没查到；竞品栏括号里是资料中的来源编号（PixelOver 用 S 编号，Pixel Composer 用节点名或小节号）。
> 「—」表示该产品在资料里明确**没有**这项能力；「待核」表示资料本身没给出依据。

### 2.1 文档与画布

| 能力 | PixelCraft | PixelOver | Pixel Composer | 备注 / 依据 |
|---|---|---|---|---|
| 画布尺寸设定 | 有。新建/改画布尺寸（`Session` 画布尺寸历史步 `canvas-size`、`sprite-size`），文档模型 `src/engine/doc.ts` 的 `Doc.w/h` | 有。Canvas 的 `Canvas Transform → Size`；0.19 加 x/y 交换按钮；画布最大尺寸可设（S11、S2） | 有。`Crop` / `Crop Content` / `Padding` / `Align Content`；工程级 `default dimension`；1.21.0 起最大 surface **16384px**（资料 §7） | 本项目上限：`src/io/aseread.ts` 的 `ASE_MAX_SIZE = 1024`（Aseprite 导入）；自身画布上限 **待核** |
| 多画布 / 多文档 | **有，且是特色**：同一无限空间内多个画布（`Session.docs: CanvasEntry[]`、`addCanvas` / `focusCanvas` / `closeCanvas`），每张独立位置/图层/帧（`src/app/session.ts` §18.4） | 有（不同模型）：项目页签多开，每个工程内部是「无限场景 + Canvas 页面」（S10、S11） | 有（不同模型）：可同时打开多个工程（多标签/多窗口），面板随父工程关闭（资料 §2.7） | 三者模型完全不同：本项目＝2D 空间里并排的多张画布；PixelOver＝场景树里的 Canvas 对象；Pixel Composer＝多个工程 |
| 无限空间 | 有。`clampView()` 在多画布时改为「保证包围盒至少露出一角」＝无限空间（`docs/API.md` §18.6） | 有。场景本身无限，Canvas 是其中一块页面（S11） | 有。节点图本身无限；节点内部尺寸由 surface 决定（资料 §2.2） | — |
| 画布吸附成组 | **有**。`src/app/canvas-snap.ts`（`SNAP_GAP`、`stackGap`、`titleObstacle`）+ `Session.snapPosition` / `finishCanvasDrag` / `linkCanvas` / `unlinkCanvas`；范围/留白/进出颜色可在设置里调（`canvas.snapOn/snapRange/snapGap/snapInColor/snapOutColor`） | 有网格吸附，无「画布成组」概念（S10「Grid and snap system」，iso 模式待核） | 节点图有节点吸附（按住 `Ctrl` 关闭，资料 §2.2）；无画布成组概念 | — |
| 网格显示 | 有。`canvas.grid` = off / pixel / iso（`src/app/settings.ts` 第 173 行），尺寸 `canvas.gridSize` 1–32px，可绑手势 `toggleGrid` | 有。视口 view buttons 开关，尺寸在项目设置；iso 网格模式**待核**（S10、S14） | 有。Graph 与 Preview 都有 `Grid Settings`；1.21.6 加像素网格显示（资料 §7） | 本项目网格模式与 PixelOver 一样含 iso |
| 标尺 | **无**（`grep -rn "ruler" src/` 无命中） | 未在资料中找到 → **待核** | 有。Graph 面板 1.20.7 加**标尺**（资料 §2.2） | — |
| 参考图 | 有。`src/io/refstore.ts`（`RefState{x,y,size,opacity}`，IndexedDB 上限 12MB）+ `src/ui/refimg.tsx` 浮窗 | **待核**：资料明确写「未找到官方依据的常见画笔项：…参考图（reference image）专用面板 → 标 (待核)」（S17/S14） | 有（图内）：`Background` / `Composite` / `Stack` / `Uv Blend` 等把参考层合成进节点图；无「参考图浮窗」这类说法 | 本项目的参考图是**浮在画布上的独立浮窗**（带位置/大小/不透明度） |
| 裁剪与缩放（视图） | 有。双指缩放/平移、滚轮缩放（`src/render/wheel.ts`）、双击标题适配（`View.fitAnimated`）、`clampView` | 有。Center 按钮、Zoom 输入框与预设百分比、预定义 100/200%…（S10） | 有。预览面板中键平移/滚轮缩放/`F` 居中（资料 §2.4） | — |
| 裁剪工具（内容） | 有：画布尺寸调整模式（PC `Ctrl+R` 拖四边/四角，对边固定，`docs/PC.md`）；旋转画布内容 90°（`Session.rotateCanvasContent`） | 有。Drawing tool 里的 **Crop tool**（0.16 RC2，S2）；另可改画布尺寸（快捷键 `C`，S2） | 有。`Crop` / `Crop Content` / `9Slice` / `Wrap Area`（资源 §2.10） | — |
| 画布原点 / 定位 | 画布在无限空间里的位置由用户拖动决定（`moveCanvas`），无「自定义原点」设置 | 有。自定义画布原点 + 米/像素比例（S2，0.15/0.18.1） | 有。`3D Set Origin`（3D，排除）；2D 侧有 `Offset` / `Align Content` | 本项目**待核**是否存在等价原点设置 |

### 2.2 图层与分组

| 能力 | PixelCraft | PixelOver | Pixel Composer | 备注 / 依据 |
|---|---|---|---|---|
| 图层类型 | 单一栅格图层（`src/engine/doc.ts` 的 Layer + cel）；另有**引用图层**（引用另一张画布，见下） | 多种对象类型：Layer / 2D Layer + Shape / Image / Animated Image / Gradient / Bone / Text2D / Bezier Shape / Bezier Line / 2D Light（S11、S2） | 节点即图层：`Project Layer` / `Layer Output` / `Project Output`；tileset/tilemap 图层自 1.20.4 起支持（资料 §2.2、§8.3） | 生态位差异最大的一项：本项目＝像素图层；PixelOver＝对象层级；Pixel Composer＝节点图 |
| 混合模式 | 有 **12 种**：`src/engine/types.ts` 的 `BLEND_MODES` = normal/multiply/screen/overlay/darken/lighten/dodge/burn/hardlight/softlight/difference/exclusion | 有。0.17 起图层与 **2D 对象都能设**混合模式（S2） | 有。`Blend` 节点（含 `Blend Depth/Height`，后者属 3D 线） | 本项目的 12 种与 Aseprite 对齐 |
| 不透明度 | 有。图层 `opacity`（历史步 `layer-opacity`） | 有。图层与 2D 对象均可调（S2） | 有。`Multiply Alpha` / blend 节点参数 | — |
| 锁定 | 有。图层锁定（历史步 `layer-lock`），引用图层另有一套「源图层已锁定」判定（`Session.refPaintBlock`） | 有。视口左侧可按类别开关「可否被点选锁定」（S10） | 有。**Node Locking**（把 inspector 锁在当前节点，资料 §2.3）——语义不同 | 本项目的锁定＝像素不可写；PixelOver＝不可选中；Pixel Composer＝锁面板 |
| 蒙版 / 剪切蒙版 | **无图层蒙版、无剪切蒙版**（`src/engine/doc.ts` 里唯一的 `mask` 是**选区**掩码：`Doc.mask` + `Selection.isEmpty/fill/all`） | 有。图层可作为另一层的 **clipping mask**（0.8 加入；0.17 起**多个图层**可同时作为某层的剪切蒙版，S11、S2） | 有。多节点带 mask 输入；`Mask` 类节点（资料 §6） | 本项目缺口项 |
| 图层组 / 文件夹 | **无**（`LayerMeta` 无组字段，`Doc.layers` 是扁平数组，无 `LayerGroup` 类型、无折叠展开、无组级不透明度/混合模式；`tests/ase.test.ts` 的 `ase.group-flattened` 记录 Aseprite 组块被展平） | 有。0.17 起图层可父子嵌套（S2）；动画也可放进文件夹（S12） | 有。`Ctrl+G` 编组 / `Shift+G` 取消 / 双击进组；Group / Feedback / Iteration / 各类 inline group（资料 §1、§2.2） | 本项目缺口项 |
| 图层缩略图 / 时间轴缩略图 | **无**（`docs/COMPARISON.md` 三.4 明确列为缺口；`src/ui/timeline.tsx` 的图层行只有名字与开关） | 有。Scene / Z Order / Animations 三棵树 + 图标（S10） | 有。`Group Thumbnail`、预览面板缩略、节点缩略（资料 §2.4/§3.17） | 本项目缺口项 |
| 父层嵌套 / 父子变换 | **无**：`LayerMeta` 字段只有 `id/name/visible/opacity/blend/locked/ref/refLayer`，**没有 parent/children，也没有任何变换字段**（无 x/y/scale/rotation），所以「变换相对父级」没有载体；结构操作是 `ops.moveLayer()` 的一维重排，UI 是平铺列表（无缩进/折叠）。**别混淆**：项目里唯一的「组」是**画布吸附组**（`CanvasEntry.group`），属多画布空间概念 | 有。对象变换相对父级求值；图层之间可嵌套（0.17）（S11/S2） | 有。Group / inline group / cache group + Context 层级导航（资料 §1） | 本项目缺口项 |
| 引用图层 / 引用画布 | **有**。数据在 `LayerMeta.ref`（被引用画布 id）+ `LayerMeta.refLayer`（该画布的某一图层 id），镜像层自身不存像素；`Session.referenceCanvas(i,{mode})` 两种粒度（`mode="layers"` 每源图层一条实时图层 / `mode="flat"` 一条镜像整张，UI 在 `CanvasRefModal` 顶部切换）；**双向同步**靠 `Session.syncRefLayers()`（按源画布版本戳拉像素进镜像层）+ `pushMirrorEdits()`（镜像层上的直接改动**回写源画布**，笔迹落点由 `strokeTarget()` 精确命中）；`refReaches()` 拒绝 A→B→A 循环引用；`splitRefLayer`（整张引用拆成按图层）、`unrefLayer` / `unrefAll`（解除并保留像素） | 有（对象级）：对象可**跨项目复制粘贴**、材质有 linked material 共享实例（后者 3D，S2/S20） | 有（数据流级）：`Feedback` 反馈环、`Tunnel In/Out`、`Pin`、`Cache`；`Pxc` 节点可读其它 `.pxc` 工程 | 本项目的引用画布是**图层级、双向实时**的：两边任意一侧编辑都同步 |
| 多预览框 | 有。`PreviewEntry {id,canvas,x,y,size}` + `addPreview` / `togglePreview` / `closePreview` / `movePreview` / `resizePreview`（90–380，持久化）；每个窗绑定**各自的画布**并渲染该画布当前帧；可拖动、右下角缩放手柄、**双指捏合缩放**、背景白/黑/棋盘 + 灰度菜单、自动错位摆放。**限制：同一画布最多一个预览窗**（重复添加会复用现有窗） | 有 Comparison 对比视图（把视口分屏左右两半，各自用各自 View Type，S10/S2） | 有。预览面板 **Split View**（水平/垂直分割，可同时预览 2 个节点）+ **Tile View**（水平/垂直/双向平铺）+ Array Preview（资料 §2.4） | 本项目的「多预览框」＝多张**不同画布**各开一个浮动预览窗 |
| 图层可见性 | 有。含**长按眼睛＝只显示该图层**（历史步 `layer-visible` / `layer-solo`） | 有。多数可视对象有 visibility，可按类别批量开关（S10、S11） | 有。节点可禁用/隐藏 junction（资料 §2.3「可见性开关」） | — |
| 图层重排 / 复制 / 合并 | 有。上下移、拖拽重排（`layer-move`）、复制、向下合并、删除 | 有。拖拽重排、Cut/Paste 换父级、Add/删除/复制/粘贴（跨项目可用）、重命名（S2、S14） | 有。节点可自由摆放，顺序由数据流决定；`Composite` / `Stack` / `Weld` 控制合成 | — |

### 2.3 绘制工具

| 能力 | PixelCraft | PixelOver | Pixel Composer | 备注 / 依据 |
|---|---|---|---|---|
| 铅笔 | 有。`src/tools/registry.ts` `{id:"pencil"}` | 有。**Pencil**（S17） | 没有「画笔」概念，用 `Canvas` / `Tile Drawer` / `Pixel Builder` 等**节点**绘制（资料 §3.4） | 范式差异：Pixel Composer 不做手绘笔刷，做程序化生成 |
| 橡皮 | 有。`{id:"eraser"}` | 有。**Eraser**（S17） | `Active Canvas` 的 eraser 参数（资料 §7） | — |
| 油漆桶 | 有。`{id:"bucket"}`；`engine/paint.ts` 的 `floodRegion(cel,sx,sy,global,mask)`（**连续 / 全局**）+ `gradientFillRegion`（**渐变**，颗粒 1/2×2/4×4/8×8）+ 容差与**填充缝隙**（`README.md` §1） | 有。**Bucket fill**（S17） | `Flood Fill` / `Region Fill` 节点（资料 §6） | 本项目的「渐变桶 + 缝隙填充」是相对 Aseprite 也偏多的选项 |
| 渐变 | 有，但**只作为油漆桶的一种模式**（`gradientFillRegion` 沿拖动向量做线性 RGB 渐变） | **没有渐变工具**：官方用 Gradient 对象 / shader 参数实现（S17 明确标注） | 极强：`Gradient` / `Gradient Cos/Cube/Grid/Path/Points/Sky` 等 9 种渐变节点 + Gradient 数据类型 + `Gradient Shift` / `Gradient Replace Color`（资料 §3.4、§3.5） | — |
| 直线 | 有。`{id:"line"}`（`SHAPE_TOOLS`） | 无独立直线工具（用 Bezier Line 或 Shape） | `Line` / `Line 2Points` / `Path` 系列 / `Pb Draw Line`（资料 §3.4、§3.14） | — |
| 矩形 / 椭圆 / 圆 | 有。`rect` / `ellipse` / `circle`；形状统一 inside+border（实心/空心），椭圆用 **Zingl 算法**（`AGENTS.md` §4） | 有。Shape（矩形，圆角可调到正圆）；Bezier Shape（0.19，S2/S11） | `Shape` / `Shape Fast` / `Shape Ellipse` / `Shape Rectangle` / `Shape Half` / `Shape Polygon` / `Pb Draw *` 系列（资料 §3.4、§3.14） | — |
| 多边形 | 有。`polygon`（正 n 边形顶点 + 射线奇偶判定），边数 `tools.shapeSides` **3–32**，可**从中心**绘制（`tools.shapeFromCenter`）。**已知文案不一致**：`src/ui/i18n.ts` 的工具提示仍写「3–12」 | 无独立多边形工具（Bezier Shape 可代替） | `Shape Polygon` / `Pb Draw Polygon`（含正多边形）（资料 §3.4、§3.14） | — |
| 折线 / 曲线 | 有。`polyline`（多点折线，点击加点／点最后一点结束／点倒数第二撤销）、`curve`（**Catmull-Rom 样条**，端点重复，默认每段 12 采样后取整去重） | Bezier Line（0.19）：可带 width curve / Closed / 沿线渐变，**1px 线用 Bresenham 保证像素观感**（S2） | `Path` 全家（Builder / Smooth / Spiral / Wave / Morph…约 40 个节点）、`Pb Draw Curve`（资料 §3.7、§3.14） | 本项目＝手绘折线/样条；PixelOver＝贝塞尔；Pixel Composer＝矢量路径数据流 |
| 套索 | 有。`{id:"lasso"}` | 有。**Lasso**（S17） | 有。freeform 多边形选区工具、Freeform scanline 算法（资料 §6） | — |
| 魔棒 | 有。`{id:"wand"}`（容差可调） | 有。**Magic Wand**（S17） | `Path From Mask` / `Flood Fill` / `Region Fill`（资料 §6） | — |
| 形状选区 | 有。`{id:"select"}` 矩形选区 | 有。**Selection Shape**（S17） | 有。`Selection` 相关工具 + `Extract`（把画布内容剪切到新节点）（资料 §6） | — |
| 描边工具（画轮廓线） | 有。`{id:"outline"}`（**1px 边框的绘制工具**，与「描边特效」是两个东西），且在 `SYM_TOOLS` 里支持对称 | 无对应工具（用 Lines 的 Outline 着色器，S8） | `Outline` 节点（属性 width / position / start / color / anti aliasing）（资料 3.3 节 Filter 表） | 注意区分：本项目 `outline` 工具 ≠ `fx-outline` 特效 |
| 文字 | **无文字工具**（`ToolId` 联合类型里没有 text，工具注册表也没有；`font` / `glyph` / `文字` 在 `src/engine`、`src/tools` 零命中，无字形渲染、无字体选择与字号参数） | 有。**Text2D 对象**（0.18），字体可设、**可见字符百分比可动画**（打字机效果）（S2） | 有。`Text` 节点（把文本绘制到 surface）（资料 3.4 节）；Text 数据类型的 Creator/Operator/Regex 共约 30 个节点 | 本项目缺口项 |
| 喷枪 | 有。`{id:"airbrush"}`；`engine/paint.ts` 的 `sprayDots(cx,cy,radius,minSize,maxSize,count,rnd,fn)`，参数 `tools.airbrushMin/Max/Rate` | 资料未提 → **待核**（S17/S14 未列出） | 无对应概念（可用粒子/`Scatter`） | — |
| 取色器 | 有。`{id:"picker"}`；PC 上 `Alt`+单击取色；放大镜取色（loupe）；「三击缩放 + loupe 取色放大镜」在 `AGENTS.md` §8 | 有主/次颜色（左键主色、右键次色），取色方式未明说 → **待核** | 有。预览面板按住 `Ctrl` 采样颜色、右键复制 hex（资料 §2.4）；`Find Pixel` / `Pixel Extract` / `Sampler` 节点 | — |
| 笔刷大小 / 不透明度 / 笔尖 | 有。笔刷 **1–64**（`tools.brushSize`，min 1 / max 64）、不透明度 `tools.brushAlpha`（0–255）、圆/方笔尖 `tools.brushShape`（`src/engine/paint.ts` 的 `BrushShape` / `brushStamp`：circle 用 Aseprite 半径栅格、square 用 n×n 块） | 有笔刷大小快捷键（0.16 RC2，S2）；不透明度等细节未找到 → **待核** | 无手绘笔刷（`Active Canvas` 有参数化 brush，资料 §7） | — |
| 压感（数位板/笔） | **部分**：接线存在且只对铅笔生效 —— `View` 里 `this.stroke.moveTo(pp.x, pp.y, e.pointerType === "pen" ? e.pressure : 1)`，`Stroke` 仅铅笔分支用它（`size = round(size*(0.35 + pressure*0.9))`）；**橡皮、形状、喷枪都不吃压力**，`BrushState.pressure` 实际恒为 1 | 有。0.17 修过「用数位板绘制时光标位置错误」，说明支持数位板（S2） | 有。支持笔压；**独立窗口不支持笔压**（资料 §2.7） | — |
| 像素完美线条 | 有，且默认开（`tools.pixelPerfect` 默认 true）。算法全在 `src/tools/stroke.ts`：`ppClean`（判据＝L 形拐角丢弃）、配套 `ppStart` / `ppAppend` / `ppStamp`（保存被覆盖字节）/ `ppRestore` / `ppSegment` / `ppFlush`，注释标明移植 Aseprite `IntertwineAsPixelPerfect`；`tests/render.test.ts` 覆盖拐角开/关、阶梯、held-back、橡皮 | 有。`Lines` 的像素完美线条渲染（`only-lines` 开关 + 线条颜色是否索引化，S8） | 无同名机制；有 `Symmetric Nn` / `Line Match` 等**待核**节点（官方未给说明） | — |
| 自定义笔刷 / 图案笔刷 / 抖动笔刷 | **未找到**（`grep "pattern\|customBrush"` 无命中）→ 判定为**无**（`待核` 是否计划中） | **待核**（S17/S14 未列出镜像/对称绘制、纹理笔刷等） | 无笔刷概念；`Repeat` / `Repeat Texture` / `Scatter` / `Tile Drawer` 承担「图案化」 | 三项都存在缺口（各自程度不同） |
| 镜像 / 对称绘制 | 有，且**比常规更灵活**：可旋转对称轴 **0/45/90/135** + 四向对称 + 轴锁定；**开启后选区工具也会镜像**（`README.md` §1、「对称线锁定」、「开启后选区工具也会镜像」） | **待核**（S17/S14 明确说未找到镜像/对称绘制的官方依据） | `Pb Box Mirror` / `Pb Filter Mirror` / `Mirror` / `Mirror Polar` / `Mirror Path`（结果镜像，非绘制时镜像） | 本项目的可旋转对称轴是差异化项 |
| 笔刷 / 绘制快捷键 | 有。`src/app/shortcuts.ts` 的 `TOOL_KEYS`（b/e/g/i/a/l/r/o/c/p/y/u/m/w/q/h），PC 可改键 | 有。绘制子工具（Drawing Subtool）快捷键分类（S17）；调整笔刷大小的快捷键（S2） | 有。完整可自定义快捷键体系、一个动作可绑多键（弹 pie menu）、`Alt` 常显快捷键（资料 §2.7） | — |

### 2.4 选区与变形

| 能力 | PixelCraft | PixelOver | Pixel Composer | 备注 / 依据 |
|---|---|---|---|---|
| 矩形 / 套索 / 魔棒选区 | 有。`select` / `lasso` / `wand` | 有。Selection Shape / Lasso / Magic Wand（S17） | 有。`Path From Mask`、freeform 选区工具（资料 §6） | — |
| 选区加减选 | **无（加选/减选/交集都没有）**：选区模型 `Sel`（`src/engine/doc.ts` 46–99）只有 `get/set/bump/hasAny/clear/fillAll/clone/bounds`，没有并/差/交运算；三条选区路径都是**先 clear 再写入**（`src/tools/select.ts` 的 `setRectFn` / `lassoFill` / `wandSelect`）。`View.selDown` 里 Shift+点选区内部是「开始移动内容」而非加选 | 有（部分）：**用同一选区工具右键 = 从选区中减去**（0.18.1，S2） | 有。`Path` 的 Combine 组（`Path Array/Blend/Bridge/Join/Flatten/Repeat/Scatter`）、`Array Boolean Opr`、`Logic` | 本项目缺口项 |
| 全选 / 反选 / 清空 | 有。`select.ts` 的 `selectAll` / `invert` / `clear`，菜单在 `App.tsx`；`tests/sel.test.ts` 覆盖「空选区反选＝全选、反选两次复原、全选后反选＝空」 | 未在资料中明确 → **待核** | 有。`Boolean` / `Logic` / `Path From Mask` 组合实现 | — |
| 扩展 / 收缩 / 描边 | 有。`select.ts` 的 `growSelection(px)` / `shrinkSelection(px)` / `outlineSelected`（选区 4 邻边界，带 `locked` 保护 + 单步历史）；**注意 UI 写死 ±1**（`App.tsx` 的 `sel.grow` / `sel.shrink` 按钮），引擎侧是参数化的 | 未在资料中明确 → **待核** | 有。`Dilate` / `Erode`（按 width 收缩，属性 width/preserve border/use alpha）/ `Gap Contract` / `De Corner` / `De Stray` | — |
| 羽化 feather | **无**（`feather` / `羽化` 在 `src`、`tests`、`i18n`、文档里 **0 命中**） | 未见依据 → **待核** | 有。`Blur*` 家族 18 个节点、`Blur Shape` / `Kuwahara` / `Bokeh` | 本项目缺口项 |
| 选区内容：复制/剪切/粘贴 | 有。`src/io/clipboard.ts`（`writeClipboardPng`）+ `src/ui/paste.ts` + `Session.pasteAsNewLayer` / `pasteAsNewCanvas` / `pasteIntoFrames`；PC `Ctrl+C/V/X`，`Ctrl+Shift+V` 粘成新图层、`Ctrl+Alt+V` 粘成新画布 | 有。框选 `Ctrl+X` → 选目标对象 `Ctrl+V` = **粘贴成新 Image 对象**（官方推荐的「拆件」流程，S17）；**支持粘贴外部剪贴板图像**（0.8.2/0.14.4，S2） | 有。`Extract` 把画布内容剪切到新节点；粘贴自动切到选区工具（资料 §6） | 本项目跨画布剪切粘贴（画布 1 剪切 → 画布 2 粘贴）是差异化项 |
| 翻转 / 旋转 / 缩放（选区内容） | 有。水平·垂直翻转、移动 / 旋转 / 缩放（仿射），历史步 `sel.move` / `sel.rotate` / `sel.scale` | 有。选区菜单含 **flip 与 rotation**（0.18.1）；平面翻转（0.6.1）；变换可加**重采样滤镜**（S2、S11） | 有。`Flip` / `Mirror` / `Skew` / `Scale` / `Rotate` 类节点与 `Transform` 节点 | — |
| 自由变换（斜切/透视/网格变形） | **无斜切、无透视、无网格变形**（`skew` 只出现在注释措辞里，`perspective` 只在第三方 `omggif.js` 里；`docs/COMPARISON.md` 三.4「变换：无透视、无浮层独立编辑、松手即落盘」）。旋转/缩放的实现方式值得记一笔：**不是矩阵对象，而是逐目标像素逆映射** —— `src/tools/select.ts` 的 `xformFloating(doc,st,angleRad,sx,sy,…)`（旋转用 cos/sin、缩放用 sxn/syn，先算 4 角变换后包围盒，再对每个目标像素反算源坐标采样）；手柄在 `View.selFramePts`（8 手柄 + 旋转点）/ `handleAt` / `tryStartXf` / `xfMove` / `endXf`，缩放锚点＝对侧手柄，等比范围 `clamp(0.02, 40)` | 有。斜切、**网格变形 mesh deformation**（0.12 起，含网格点关键帧、smooth 工具、CDT 三角化）；**像素完美缩放与倾斜**（0.7）（S2/S20） | 有。`Mesh Warp` / `Grid Warp`（2D，明确保留）/ `Bend` / `Polar` / `Straighten`（反透视）/ `Stretch` / `Warp`；`Mesh Create Lattice/Create Path/Transform`（资料 §6/§7） | 本项目缺口项 |
| 跨画布搬运 | **有（特色）**：`View.dropSelDragToCanvas` + `selOps.floatDropInto`（`docs/API.md` §18.7b）；拖动时实时预览落点幽灵 + 目标画布虚线框；目标图层锁定时整个移动作废并提示 | 有（对象级）：把对象剪切粘贴到别的层级/骨骼下，或跨项目粘贴（S2/S18） | 有：节点连线的数据流本身跨画布；`Tunnel In/Out` 跨上下文传值 | 本项目是「拖一个浮动选区到另一张画布松手」的连续操作 |
| 选区存为图层 / 存为画布 | **无专用入口**（没有 `selToLayer` / `canvasFromSelection` 之类符号）；**等价路径**：复制 + 粘贴为新图层 / 新画布（`Session.pasteAsNewLayer` / `pasteAsNewCanvas`），以及与此无关的「图层提取为画布」（`Session.extractLayerToCanvas`） | 有。选区可转成新 Image 对象（S17）；shape → image/animated image bake（0.19，S2） | 有。`Extract` / `Separate` / `Seperate Shape` / `Region Fill`（资料 §6） | 用户侧效果接近，但本项目要绕一步剪贴板 |
| 图形即拖即选区 | 有。`View` 松手 commit 后若 `doneMoved && isShapeKind(kind)` 就 `selectStrokePixels(doneStroke)` 并自动切到 `select` 工具；判定表 `isShapeKind`（line/rect/rectfill/ellipse/ellipsefill/circle/polygon）；`selectStrokePixels` 拿 `stroke.before` 与当前 cel **逐像素比较**得到掩码（不是外接矩形），参考图层还会把坐标映射回本画布；`tests/view.test.ts` 覆盖普通与引用图层两条路径 | 未见依据 → **待核** | 无此概念（`Pb Output` 输出 surface） | — |

### 2.5 颜色与调色板

| 能力 | PixelCraft | PixelOver | Pixel Composer | 备注 / 依据 |
|---|---|---|---|---|
| 调色板来源 | 有。预设色板 **5 包**（`src/data/palettes.ts` 的 `PALETTE_PACKS`：default / db16 / pico8 / sweetie16 / gray，`defaultPalette()`）、自定义色板（`Session.savePalettePreset` / `deletePalettePreset`，localStorage `pc.palettes.mine`）、**最近使用颜色**（`Session.recentColors` / `pushRecentColor`，上限 `display.recentColors` 4–64）、**画布颜色**（`Session.docColors()` 扫全部 cel 去重，上限 512）三种来源；色源切换 `palSession.palOrbMode`（palette / doc / recent） | 有。Palette input：Create（从零新建）/ **Generate with adjustments**（从当前图层生成，可指定颜色数）/ 从图像文件导入（S14/S15） | 有。`Palette` / `Palette Extract`（从图像生成）/ `Palette Replace` / `Palette Shrink` / `Palette Sort` 节点；`.hex/.gpl/.pal` 拖入 + **Lospec** 联动 + 1.21.5 按色相自动分组子调色板（资料 3.5 节、§2.6） | 本项目的「**从图像生成调色板**」缺失 |
| 调色板导入 / 导出格式 | **部分**：导出只有 **`.gpl`**（`src/ui/modals.tsx` 的 `exportGplPalette()`，第 320–325 行，"GIMP Palette" 头）；导入**没有专属解析器**——`parsePaletteBytes()`（同文件第 326–338 行）逐行同时接受 `#RRGGBB`/`#RGB` 十六进制行与 `R G B` 行，上限 512 色，**不校验扩展名/格式**，因此纯 hex 列表也能用，但没有 `.pal` / `.act` / `.ase` 调色板解析 | 官方只写 "Load and Save palette files"，**具体扩展名待核**（S14） | 明确 **`.hex` / `.gpl` / `.pal`** + Lospec（资料 §2.6） | — |
| 调色板编辑 | 有。HSV 色轮 + HEX（`src/ui/HsvWheel.tsx`）；去重 / 按色相·明度排序 / 合并预设色板 / 长按色块全局换色（`README.md` §1） | 有。排序、框选/Shift/Ctrl 多选、拖拽重排、右键新建/复制/粘贴/删除、点击改色；**颜色选择器属性在同一调色板不同颜色间保持**（S14/S2）；上限 **256 色**（S2） | 有。Palette Selector（`+`/`-`、拖动重排、preset 存 `%DIRR%/Palettes`）（资料 §2.6） | — |
| 索引色 indexation | 有（**功能子集**）：`Session.setIndexed(on)` + `paletteSnap(c)`（画笔就近吸附）+ `Session.remapToPalette(scope)`（把已有像素映射到调色板，一条历史）；`docs/API.md` §18.4 | 有（完整）：Indexation 把图层颜色收敛到有限调色板，**在所有颜色调整之后执行**；调色板的三个来源与颜色数控制（S8/S15） | 有。`Posterize`（把每个像素映射到给定调色板最接近的颜色）、`Palette Replace` / `Palette Shrink` / `Palette Extract`（资料 3.3/3.5 节） | 本项目无「颜色数」控制 |
| 匹配索引色 Match Indexation | **无**（按位替换到另一个调色板的概念未实现） | 有：按**相对位置**替换索引色（原调色板第 n 色 → 匹配调色板第 n 色），带 `Shift` 参数（S8/S15） | 近似：`Palette Replace`（通过匹配来修改颜色）、`Markov Gradient`（把颜色替换为调色板中的下一个颜色） | 本项目缺口项 |
| 抖动 dithering | **无**（`grep -rn "dither" src/` 无命中） | 有。Dithering 在索引色之间按**可配置阈值**抖动；dithering pattern 可分开编辑（0.10）（S8/S2） | 有。`Dither`（mode/pattern/contrast/contrast map）+ `Dither Diffuse`（**误差扩散**）（资料 3.3 节） | 本项目缺口项，两项竞品都有 |
| 颜色循环 color cycling | **无**（无 match indexation、无调色板关键帧） | 有，且官方给了完整五步流程（生成调色板 → 排序 → 复制为 match 调色板 → 给 Shift 打关键帧 → 开循环），**不改像素、轻量、逐帧一致**（S16） | 有。`Palette Shift` 节点（把 surface 与 palette 匹配后让颜色循环，属性 palette/shift）+ `Gradient Shift`（资料 3.3/3.5 节） | 本项目缺口项 |
| 取色器 / 颜色历史 | 取色器有（`{id:"picker"}`）；**颜色历史有**（「最近使用颜色」列表：`Session.recentColors` / `pushRecentColor` / `trimRecentColors`，设置 `display.recentColors` 4–64 默认 16，UI 面板「最近」页签），但**没有独立的「颜色历史条」控件、也没有颜色级回退（颜色 undo）** | 有颜色选择器（S14）；历史条未见依据 → 待核 | 有 Color Selector / Palette Selector / Gradient Editor 三个面板（资料 §2.6） | — |
| 二值透明 | **无**（未见阈值化 alpha 的实现） | 有。Opacity = **二值透明**（高于阈值全不透明、低于全透明，S8） | 有 `Alpha Cutoff`（移除 alpha 小于阈值的像素）、`Threshold`（按亮度或 alpha 裁剪）、`Multiply Alpha`（资料 3.3 节） | 本项目缺口项 |
| 拖动颜色球填充 / 底栏色块 | 有（特色）。`src/ui/color-drag.tsx` 的 `useColorDragFill`（拖动 = 油漆桶填充、原地松手 = 取色、长按 = 快捷调色盘），落在非聚焦画布上先聚焦再填（`docs/API.md` §18.7a） | 无对应概念 | 无对应概念（节点式） | 本项目的触屏专属交互 |

### 2.6 像素画专用算法与特效

| 能力 | PixelCraft | PixelOver | Pixel Composer | 备注 / 依据 |
|---|---|---|---|---|
| 外描边 outline | 有。`src/engine/effects.ts` 的 `outlineCel(d,w,h,width,color,pos)`，`OutlinePos = "outside" \| "inside" \| "center"`；参数弹窗 + 实时预览（`src/ui/fxparam.tsx`） | 有。**Outline** 外描边（需透明背景）、**Inline** 内描边（可带 alpha 与底色混合）、`Colors Line`（两色交界处画线）（S8） | 有。`Outline` 节点（属性 width / position / start / color / **anti aliasing**）+ `Glow` / `Shadow` / `Bloom` / `Edge Detect`（资料 3.3 节） | 本项目内/外/居中三档齐；PixelOver 另有「两色交界线」 |
| 内描边 | 有（**作为描边的一个选项，没有独立按钮**）：`OutlinePos` 含 `"inside"`，判定「距透明像素 Chebyshev ≤ width 的不透明像素改色」且外形尺寸不变；`tests/effects.test.ts` 覆盖「1px 单像素内描边不破洞」 | 有（Inline，可带 alpha 与底色混合，S8） | 有（`Outline` 的 position 参数） | — |
| 投影 / 外发光 / 模糊 | 有。`dropShadowCel`（dx/dy/color/keepOriginal，UI 参数 dx/dy −64..64 + 颜色 + 不透明度，可选写当前图层或新建 `shadow` 图层）、`outerGlowCel`（按 R 逐环 4 邻域扩张、alpha 线性衰减）、`blurCel`（可分离 box 两遍≈高斯、预乘 alpha、radius 1–32）（`src/engine/effects.ts`）。**注意**：外发光是**唯一没有参数弹窗**的特效——调用处固定 R=2、用当前前景色 | 有（着色器体系）：`Water` / `Shockwave` / `Tiled Mode` / `Mask` 等 Effects 组（S8）；无独立「投影」条目 | 有。`Shadow` / `Shadow Cast` / `Bloom` / `Glow` / `Vignette` / `Chromatic Aberration` / `Grain` / `Jpeg` / `Convolution` / `Emboss` 等 **35 个 effect 类节点**（资料 §2.9） | 本项目特效是「一次性落到图层」的，不是实时着色器 |
| 反色 / 灰度 | 有。`invertCel`（只反 alpha>0 的 RGB）/ `desaturateCel`（0.299/0.587/0.114 亮度）；另有独立的**预览灰度开关**（CSS filter，显示层，与像素处理无关） | 有颜色调整（饱和度/色相/对比度/亮度/gamma，S8）；**反色/灰度是否有独立项待核** | 有。`Invert` / `Greyscale` / `Bw` / `Color Blind` / `Hue/Sat` 相关节点（资料 3.3 节） | — |
| 居中 / 智能裁剪 | 有。居中：内联在 FX 项里算不透明包围盒 → 画布居中（有选区时居中到选区，放不下时该轴不动以免裁切）；智能裁剪：`Session.cropSmart()` → `src/engine/ops.ts` 的 `contentBounds()`（跨全部图层/帧）→ `resizeDocCanvas()` 收缩，一条 `auto-crop` 历史 | 无对应概念（有 Exported Area 划定导出区，S11） | 有。`Align Content` / `Crop Content` / `Scale Content Aware`（内容感知缩放，1.21.6）（资料 §7） | — |
| 特效参数弹窗 + 实时预览 | 有。`src/ui/fxparam.tsx` 的 `FxRun` / `FxParamDef` / `FxParamDialog`（int → `ScrubNum`、enum → `ChipGroup`、color → 色块 + `input[type=color]` + hex）；实时预览**每次都从原始快照重算、不叠加**；取消恢复快照、无变化不记历史、有变化记一条 `pushPixels`；颜色参数点色块会走 `Session.awaitColorPick` 打开调色板，取到的颜色**只喂给参数、不改画笔色** | 有（着色器参数可实时调、可动画，S8） | 有（节点参数即面板属性，改动即重算） | — |
| 去毛刺 polish | **无**（无对应实现） | 有。**Polish** 移除短于指定最小长度的像素边缘（0.8.3）；0.8.3 同时加入「内边缘」（S8/S2） | 有。`De Corner` / `De Stray` / `Deblur` / `Gap Contract`（资料 §2.9「修边」4 个） | 本项目缺口项 |
| 降噪 denoise | **无** | 有。**Denoising** 平滑孤立/不规则像素（S8） | 有。`De Stray` / `Grain` / `Blur Simple` / `Kuwahara` 等 | 本项目缺口项 |
| 色阶 / 曲线 | **无**（`src/engine/adjust.ts` 只导出 `rgbToHsl` / `hslToRgb` / `adjustPixel(HslAdj)` 与 `HslAdj`，没有 levels/curves） | Color 分类官方只列 Adjustments / Indexation / Match Indexation / Dithering / Opacity 五组；**「色阶」未找到原文 → 待核**（S8） | 有。`Level` / `Level Selector` / `Gamma Map` / `Curve` / `Curve Hsv` / `Lut` / `Normalize` / `Tonemap Ace` / `Xdog Threshold`（资料 3.3 节） | 本项目缺口项 |
| 色相 / 饱和 / 明度调整 | 有。`adjustPixel` + `HslAdj`（`src/engine/adjust.ts`）；画布球「色相调整」（`README.md` §1） | 有。Adjustments：饱和度 / 色相 / 对比度 / 亮度 / gamma（S8） | 有。`Color Adjust` / `Color Hsv` / `Color Oklch` / `Color Math` / `Color Mix`、OKLCH/HSV/RGB 互转（资料 3.3/3.5 节） | — |
| 量化 / 降色 | **部分**：nearest 映射见 `Session.paletteSnap`（RGB 平方距离，保留 alpha）与 `remapToPalette` 内部的 `nearest()`；**GIF 导出内部有中位切分量化**（`src/io/exporters.ts` 的 `medianCut`，上限 255/256 色 + 5bit 色立方查找表）。**没有用户可用的「量化到 N 色 / 降色」命令** | 有。Indexation 可指定颜色数（S8/S15） | 有。`Posterize` / `Palette Shrink` / `Bit Reduce` / `Threshold`（资料 3.3/3.5 节） | — |
| 像素排序 pixel sort | **无** | **无**（未找到） | 有。`Pixel Sort`（同一水平/垂直轴上按阈值排序，属性 iteration/threshold/direction）（资料 3.3 节） | — |
| 每对象着色器 | **无**（特效是应用到图层的一次性算法） | 有。0.17 起**每对象着色器**（例如给骨骼链每个部件单独描边）；shader 可存成 `.poshader` 资源跨工程复用（S8/S14） | 有。`Hlsl` 节点（自定义 GPU fragment，自动编译，**仅 Windows 可用**）（资料 9.2） | 本项目缺口项 |
| 粒子系统 | **无** | 有（**2D 部分**）：Image / Animated Image / Shape 可开粒子；General（Lifetime/Max particles/Random seed）、Emission、Velocity（Linear/Angular/Orbital + 曲线）、Acceleration（Gravity/Linear/Radial/Tangential）、Transformation offset、Color modulate、Static mode（S21） | 有：`Psystem *`（约 33 个 2D 节点）+ `Vfx *` 组节点（资料 3.10） | 本项目缺口项 |
| 2D 灯光 | **无** | 有。**2D light 对象**（0.18.2）+ Image/Animated Image 的 **normal map** + **light occluder 遮光体** + ambient color（S2） | 有。`2D Light` 节点（官方分类在 filter 下）（资料 2.9/3.3 节） | 本项目缺口项 |
| 模拟（物理 / 流体 / 烟雾） | **无** | 路线图待做（Fluids simulation / Physical bodies and bones，S1） | 有：RigidSim / SmokeSim / FLIP Fluid / StrandSim / VerletSim 共 **66 个节点**（资料 3.9） | Pixel Composer 独占 |
| 程序化生成（噪声 / 图案） | **无** | **无** | 有：噪声约 25 种（Cellular/Perlin/Simplex/Gabor/Honeycomb…）、图案约 24 种（Checker/Stripe/Zigzag/Grid/Tile/Weave…）、`Mk *` 宏特效 34 个、`Mk Tree` 29 个（资料 3.4/3.11/3.12） | Pixel Composer 独占 |

### 2.7 动画与时间轴

| 能力 | PixelCraft | PixelOver | Pixel Composer | 备注 / 依据 |
|---|---|---|---|---|
| 帧（增删改 / 重排 / 时长） | 有。`src/engine/ops.ts` 的 `addFrame` / `duplicateFrame` / `removeFrame` / `moveFrame`；`Doc` 每帧 `durationMs`；拖拽重排、帧设置弹窗 | 帧概念不同：动画由**关键帧驱动对象属性**，`Animated Image` 对象的 `Frame` 输入可被动画驱动（S11/S12） | 有。时间轴 keyframe + `Alt+N` 加帧；帧计时类型 "Duration"（按每帧毫秒，1.21.6）（资料 §5.1/§5.3） | — |
| 帧多选 / 批量操作 | 有。Shift 区间选帧（`Session.frameAnchor` / `pickFrameRange`），批量复制/删除/统一时长（`README.md` §1、`docs/COMPARISON.md` 〇） | 有。Shift/Ctrl 多选、框选、分组修改输入（S2）；关键帧多选形成高级选区（S12） | 有。关键帧多选、复制、移动、缩放选区、翻转选区（S12 对应物在资料 §5.2） | — |
| 循环模式 | 有 4 种：单次 / 循环 / 乒乓 / 倒流，**按钮图标随模式变化**（`src/app/playback.ts`；图标 `i-loop` / `i-loop-once` / `i-loop-pingpong` / `i-loop-reverse`，`docs/API.md` §16.8） | **没有**乒乓等播放循环模式（S1–S16 检索无命中，S13 节判定不存在）；只有轨道级 `Wrap` + 播放条 Loop 开关（第 7 节） | 有 4 种：Hold（默认）/ Loop / Pingpong / Wrap + `Limited Loop`（按住 looping mode 图标拖到 dopesheet 上限定循环范围）（资料 §5.4） | 本项目与 Pixel Composer 都支持乒乓；PixelOver 无 |
| 洋葱皮 onion skin | 有，且较完整：前后帧数（0–3，`onion.before`/`onion.after`）、不透明度（`onion.alpha` 10–100%，越远越淡）、着色（前帧红 `prev`、后帧绿 `next`）、**循环环绕**（开关 `onion.wrap`，环绕帧改用 `prevWrap` 蓝 / `nextWrap` 琥珀）；布局纯函数 `src/render/onion.ts` 的 `onionGhosts()`（返回 `wrapped` 标记），着色常量在 `src/render/compositor.ts` 的 `ONION_TINT` / `ghostTint`；**幽灵帧有缓存**（`ComposeCache.ghosts`，键＝帧号+着色，换文档/换层配置/切帧时清空）。**注意两点**：环绕是按**整条时间轴**首末帧（不按标签区间）；四个着色值是内置常量，UI 不可配 | **没有**洋葱皮（S1–S16 检索无命中，第 7 节/§1.13 判定不存在） | 有。预览面板的 **Onion Skin**（叠加前后帧，可调颜色、不透明度、叠加帧数）（资料 §2.4） | 本项目明显强于 PixelOver |
| 帧标签 tag | 有，且是近期主力功能（1.1.0.0）：`src/engine/tags.ts`（`tagAt` / `clampRange` / `normalizeTags` / `tagsAfterInsert` / `tagsAfterRemove` / `tagLanes` / `TAG_COLORS`）+ 时间轴标签条（`src/ui/timeline.tsx`）+ `TagModal` | **没有帧标签系统**（第 7 节判定不存在）；PixelOver 的循环概念是**轨道级 Wrap** + Loop 开关 | **有（1.21.3 Region 系统）**：「支持动画区域，**可把标签（tag）导入为动画区域**」（资料 §5.3）；另 `Composite Tag` / `Surface Tag` 节点读 tag | 三者里本项目与 Pixel Composer 有 tag；PixelOver 没有 |
| 标签语义（方向 / 重复次数） | **无（数据落地、功能未落地）**：字段在 `src/engine/doc.ts` 的 `FrameTag.dir` / `repeat`（注释即自述 "file metadata"）；`src/io/aseread.ts` 读、`src/io/asewrite.ts` 写、`src/io/project.ts` 的 `.pxc` 也带 —— **存取保真**；但 `src/app/playback.ts` 的 `windowOf(tag,count)` **只用 from/to**，`startPlayback` / `tickPlay` 也不读它，`TagModal` 里没有方向/重复控件；`tests/tags.test.ts` 只断言 round-trip 保真 | 无 tag 概念 | 关键帧循环模式含 Pingpong / Wrap（§5.4）；`Ase Tag` 节点读 Aseprite 标签 | 本项目缺口项（这是 Aseprite tag 的 direction/repeat 语义） |
| 关键帧系统 | **无**（无属性关键帧、无插值、无曲线） | 有，且是核心：关键帧几乎覆盖所有属性（变换/绘制/着色器参数/资源）；轨道与子轨道、缓动函数、`Step`/`Wrap`/`Modulo` 轨道属性、Snap、**动画图编辑器**（0.18.1）、Rest/Pose 双模式（S12） | 有，且是核心：Inspector 打关键帧、`Linear/Smooth/Hold/step/Clean Edge` 插值、**小数帧 subframe**（按住 `Alt` 拖时间轴）、曲线视图、Separate Axis、Driver（Linear/Wiggle/Sine/Snap/bounce/elastic/curve）、Stagger、关键帧动作 Align/Repeat/Distribute/Envelope（资料 §5.1/§5.2/§5.4） | 本项目缺口项；两个竞品都以此为骨架 |
| 曲线编辑器 | **无** | 有。**Graph editor**（0.18.1），可视化关键帧过渡，输入子轨道（vector、color）可单独编辑（S12） | 有。**Curve view**（点曲线图标开启）+ `Anim Curve` / `Fn Ease` / `Fn Math` / `Fn Smoothstep` / `Fn Wavetable` 节点（资料 §5.2、3.8 节） | 本项目缺口项 |
| 播放范围 | 有（**本项目特色语义**）：`src/app/playback.ts` 的 `PlayWindow` / `windowOf` / `startPlayFrameIn` / `nextPlayFrameIn`；**显式传入的标签永远优先**，不传时按当前帧推导；播放中点到别的标签＝`retargetPlay` 切动画（`docs/API.md` §16.8）。**但没有像 Pixel Composer 那样独立、可手工设定的 working range**（`workingRange` / `工作范围` 全仓零命中）——范围只能由「整条时间轴」或「某个标签」推出 | 有。`Length` + `Scale`（按比例重排关键帧）、时间轴 Snap、可为轨道设 Wrap/Modulo（S12） | 有。**Working range**（播放与导出生效的帧范围，**可以不同于 animation range**）+ project working range + Region 动画区域（资料 §5.3） | 本项目缺口项 |
| 导出帧范围 | 有，但**与播放范围是两套东西**（别混）：导出弹窗里的 `range` 状态提供「全部 / 选中帧 / 标签」三种，落点 `src/io/exporters.ts` 的 `frameRange()`（越界裁剪 + 自动交换），被 GIF 与精灵表使用 | 有。导出动画可选**当前 / 全部 / 选定**动画；动画可分文件夹或合并成单文件（S22） | 有。`frame range` / `frame step`（每 n 帧导 1 帧）/ `loop` 等动画参数（资料 §8.2） | — |
| 动画片段存读（跨工程复用） | **无**（`README.md` 与 `src/` 里没有「把一段动画存成文件」的实现）→ 无 | 有。`.poanimation`（含文件夹层级，跨工程复用，打开时弹出 Import animations 窗口并支持 **rebind 到别的对象**）（0.18.1，S12/S14） | 有。`Collection`（节点集合跨工程复用、Steam Workshop 分享）、Preset（`_default`）、`.pxc` / `.cpxc` 工程、`Pxc` 节点读别的工程（资料 §1、§2.5、§8.3） | 本项目缺口项 |
| 音频驱动动画 | **无** | 路线图待做：Animation → **audio tracks**（S12 第 11 节） | 有。`Wav File Read/Write` / `Audio Loudness` / `Audio Window` / `Fft` / `Plot Linear`（资料 §5.5） | — |
| 帧预览 / 时间轴细节 | 有。帧预览面板（`FramePreviewModal`，**单实例对话框**，缩略图可双指捏合缩放并持久化）、时间线可拖动分割线（pointer capture + 实时改高，夹 140–520 并防抖存盘）、标签条行数随 `tagRows` 变化（横屏行高 grow 计算也把它算进去） | 有。时间轴刻度、ruler/dope sheet 可读性改进（S2） | 有。迷你时间轴（1.20.2）、marker（1.20.8）、帧可视化（1.21.6）、导出进度显示在时间轴（资料 §5.1） | 本项目「帧预览面板」与「画布预览框」是两回事 |

### 2.8 绑定与形变

| 能力 | PixelCraft | PixelOver | Pixel Composer | 备注 / 依据 |
|---|---|---|---|---|
| 骨骼 bones | **无** | 有。Bone 是专用变换工具对象；点击/拖拽建链、父子层级、可设 0px 长度作参考点、快捷键移动（S18/S19/S11） | 有。`Armature` / `Armature Bone` / `Armature Mirror` / `Armature Subdivide` / `Armature From Path` / `Armature Path` / `Armature Sample`（资料 3.6 节） | 本项目缺口项 |
| IK 反向动力学 | **无** | 有。2D IK（0.11）：约束加在链首骨骼、Target 可复用对象、**角度约束**（正/负）、**pole target**、仅 Pose 模式生效、可动画化（S19） | 有。`Armature Ik`（资料 3.6 节）；骨骼蒙皮相关能力在 3D 线也有（§11.1） | 本项目缺口项 |
| 权重 / 蒙皮 | **无** | 有。自动权重（0.17.1 重写）+ **手动编辑权重**（滑动 + 数值对话框 + 多选）；骨骼须为网格对象的子对象（S20） | 有。`Armature Skin` / `Armature Mesh Rig` / `Armature Bind`（资料 3.6 节） | 本项目缺口项 |
| 网格变形 | **无**（选区仿射变换 ≠ 网格变形） | 有。0.12 起支持任意 Image/Animated Image；Shape generation / Rectangle generation 两种生成；点编辑（插点/内部点/合并/删除）、Deform/Reset、网格点关键帧、smooth 工具、CDT 三角化（S20/S2） | 有。`Mesh Warp` / `Grid Warp`（2D，明确保留）/ `Mesh Create Lattice` / `Mesh Create Path` / `Mesh Transform` / `Warp` / `Bend` / `Polar` / `Straighten` / `Stretch`（资料 §6/§7、§11.2） | 本项目缺口项；资料 §11.2 特别说明 Mesh 系列属 2D、保留 |
| 父子层级 / 嵌套 | 图层是平铺列表（无嵌套）；另有**引用图层**做跨画布联动 | 有。对象变换相对父级求值；图层之间可嵌套（0.17）（S11/S2） | 有。节点组（Group / inline group / cache group）+ Context 层级导航（资料 §1） | 三者模型不同 |

### 2.9 特效与扩展（自动化）

| 能力 | PixelCraft | PixelOver | Pixel Composer | 备注 / 依据 |
|---|---|---|---|---|
| 脚本语言 | **无**（`node:fs` / `child_process` / `require(` 在 `src/` 零命中；无任何表达式/脚本引擎，`src/engine/expr.ts` 只是**数字输入框的算式求值**，不构成脚本语言） | **没有脚本系统**（S1/S6/S14 全站未见，第 2 节判定不存在） | 有 **PCX 表达式语言**（自定义语法 + 内置函数签名 + `Project.frame` 等全局结构体）+ **Lua** 三节点（Global/Compute/Surface）+ **HLSL** 节点（资料 9.1/9.2/9.3） | 本项目缺口项 |
| CLI / 无界面运行 | **无**（`src/` 里没有任何命令行入口；仓库里的 `scripts/` 与 `toolchain/` 是构建/开发脚本，不是产品 CLI） | **没有命令行**（第 2 节判定不存在） | 有。`-h/--headless`、`-t/--trusted`、`-p/--persist`、`-s/--server`、`-sl/--skiplua`、`-output`，外加 PXC-cli wrapper 与控制台命令（资料 §8.4） | 本项目缺口项 |
| 批处理 | **无**（分图层批量导出是导出窗口里的一个选项，不是批处理引擎） | **没有批量处理**（官网把它列进 2026+ 待做项，S1/S32） | 有。Array Processor（4 种模式 Loop/Hold/Expand/Expand Inverse）+ `Array *` 33 个运算 + Iteration 族 + CLI headless（资料 §4.2/§5/§8.4） | — |
| 插件 / 扩展 | **无** | **没有插件系统**（第 2 节判定不存在） | 有。**Addon 自定义节点**（把节点文件夹拖进界面即可添加）、Custom Panel 系统（1.20.4）、脚本库、多 pass 着色器（资料 9.4） | 本项目缺口项 |
| 节点图 | **无** | **无** | **有，且是产品本体**：924 条 2D 节点、34 种 junction 数据类型与兼容表、Group/Feedback/Iteration/inline group、Tunnel、Junction、Cache、Minimap、命令面板（资料 §1/§4） | Pixel Composer 独占 |
| 模板 / 预设 / 宏 | 有**设置与引导**的导入导出（`README.md` §1「设置文件导入导出」）；**工程模板 / 动作宏无** | 有。Shader 预设 `.poshader`、动画片段 `.poanimation`、示例项目（S14/S6） | 有。节点 Preset（含 `_default`）、Collection、Node Action creator、Steam Workshop 分享（资料 §1/§2.5） | — |
| Steam Workshop | 无（非 Steam 发布） | 无 | 有（合集与工程可分享，资料 §2.5） | — |

### 2.10 文件与互操作

| 能力 | PixelCraft | PixelOver | Pixel Composer | 备注 / 依据 |
|---|---|---|---|---|
| 工程格式 | `.pxc`（v3 整个工程，`src/io/project.ts` 的 `serializeSpace` / `parseSpace`：全部画布 + 每画布位置/帧/图层 + 工程级历史 + `refLayer` 绑定）；另有 RLE 纯 JSON 载荷供自动保存（`rleEncodeCel` / `rleDecodeCel`） | `.pixelover`（**默认内嵌全部资源**，可改为只存路径）、`.poshader`、`.poanimation`（S14/S10） | `.pxc` + 压缩 `.cpxc`（内容不可人工阅读）；另有工程 metadata 与 Global Variables（资料 §1） | — |
| 图像导出 | 有：PNG（整帧 / 图层 / 选区 + 倍率 + 背景）、GIF（帧范围、逐帧时长、透明）、精灵表 + JSON、**Aseprite `.aseprite`**、调色板 `.gpl`、分图层批量导出（`src/io/exporters.ts` 的 `exportPNG` / `exportGIF` / `exportSheet` / `exportASE` / `encodeGIF`）。**没有 APNG / 动画 WebP / 视频（mp4/webm）**——`apng` / `webm` / `mp4` / `image/webp` 在 `src/io/` 与导出弹窗里零命中 | 有：**PNG（图/精灵表）、GIF、`.aseprite`** 三种（付费版才能导出）；含 Advanced file name、图层分离导出、Views、Area/缩放、动画范围与合并、精灵表 margin/padding/cell 约束与 **JSON 元数据**（S22） | 有：`.png` / `.jpg` / `.webp`（静态，PNG 有 PNG32/INDEX4/INDEX8 subformat）；`.gif` / `.apng` / `.mp4` / `.webm`（动画）；`.exr` / `.bmp` / `.ico` / `.txt` / `.csv` / GameMaker room file（资料 §8.2） | **本项目没有 APNG / 动画 WebP / 视频导出** |
| 精灵表 JSON 元数据 | 有。`exportSheet` 产出 `_sheet.png` + `_sheet.json`（`JSON.stringify(meta, null, 1)`）。实际结构已核对：`frames[] = { filename, frame:{x,y,w,h}, duration }`，`meta = { app:"PixelCraft", version:"2.0", image, size:{w,h}, scale }` | 有，且结构官方完整给出：`frames[].frame{x,y,w,h}` + `duration`，`meta.app/version/filepath/frameAnimations[]{name,fps,speed_scale,from,to}/size/view/layer/direction`（S22） | 有：`Render Sprite Sheet` / `Pack Sprites`（不同算法打包不等尺寸图像）/ `Image Grid` / `Image Sheet` / `Sequence Anim`（资料 §8.3） | 结构对比：本项目**没有** `frameAnimations`（动画名/fps/区间）与 `direction` 这两个字段层次 |
| tilemap / tileset 导出 | **无**（仅 `src/io/aseread.ts` 里**按规范跳过** tilemap 块） | **无** | 有：`Tile Convert` / `Tile Drawer` / `Tile Rule` / `Tile Tileset` / `Tile Render` / **`Tile Tilemap Export`**（导出 `.csv` 或 GameMaker room file）；1.20.4 起支持 tileset/tilemap 图层（资料 §8.3） | 本项目缺口项 |
| 导入 Aseprite | 有，且是**双向**：`src/io/aseread.ts`（`parseAse` / `aseToDoc` / `readAseDoc` / `ASE_MAGIC` / `ASE_MAX_SIZE = 1024`）+ `src/io/asewrite.ts`（`writeAse`，cel 按内容裁剪 + zlib 压缩，无 CompressionStream 时退回未压缩 cel）+ `src/io/zlib.ts`（自写 inflate）；读 RGBA/16 位灰度/8 位索引色、图层/帧/链接 cel/调色板/帧时长/混合模式/标签 | **不能导入 Aseprite**（只在路线图里列为计划，S1/S13 节）；但**能导出** `.aseprite`（S22） | **只读方向**：`Ase File Read`（支持 layers/tags/palette 索引模式，**不支持 tilemap**）+ `Ase Layer` / `Ase Tag` / `Ase Tileset`；资料未找到写回 `.aseprite` 的依据（资料 §8.3） | **本项目是三者里唯一能读也能写 Aseprite 的**（PixelOver 只能写、Pixel Composer 只能读） |
| 导入 Krita / ORA / PSD | **无** | **不能导入 PDS/Aseprite**（PSD 在路线图待做，S13 节） | 有。`Krita File Read` / `Krita Layer`、`Ora File Read` / `Ora Layer`（1.19.9）；**PSD 未找到依据**（资料 §8.3） | — |
| 图像导入 | 有。打开流程先按**魔数**判断 Aseprite（扩展名不对也能认），再走 `tryReadGif`，最后 `decodeStill` 交给浏览器解码（PNG/JPEG/WebP/BMP 等取决于平台解码能力）；可新建文档或作为图层、精灵表按单元格切帧、参考图、色板文件（`src/ui/modals.tsx` 的 `openFileBytes`） | 有。`.png/.jpg/.jpeg/.bmp/.webp`、精灵表（自动切分，高级选项带 margin/padding/cell size/cell 数量）、**动画图仅 GIF**（S14/S2） | 有。`Image` / `Image Animated` / `Image Gif`（含 Loop modes / Start Frame / Animation Speed / Custom Frame Order）/ `Image Sequence` / **`Image Mp4`**（1.21.0 视频导入）/ `Svg`（资料 §8.3） | 本项目的静态图格式清单取决于浏览器解码能力（见 §6.2 待核第 9 条）；**APNG 导入未找到依据** |
| 剪贴板 | 有（能读也能写）。系统剪贴板写入 `src/io/clipboard.ts` 的 `writeClipboardPng`（Web Clipboard API，`file://` 下自动退化为内部剪贴板），读取 `src/ui/paste.ts` 的 `readClipboardImage()`（返回 `{clip, fromSystem}`）；内部剪切跨画布共用 `Session.clip`；三分支粘贴 `pasteClipboard`（`Ctrl+Shift+V` 粘成新图层 / `Ctrl+Alt+V` 粘成新画布） | 有。粘贴外部图像（0.8.2 Windows/Mac、0.14.4 Linux）、粘贴图片/资源到 palette 输入（0.15）（S2） | 资料未给独立章节 → **待核** | — |
| 拖放 | 有。窗口拖放导入 `.pxc` / PNG / GIF（`App.tsx` 的拖放 effect）；**拖放只按「整窗打开文件」处理**（`docs/PC.md` P1-10，按落点导入仍是待办） | 有，且语义细腻：拖到**项目标签页上方**＝新建工程，拖到**标签页下方**＝导入到当前工程（S14） | 有。节点文件可拖入；**独立窗口不支持文件拖放**（资料 §2.1） | — |
| 外部设备 / 网络通道 | **无** | **无** | 有。`Midi In`、`Spout Send`、`Http Request` / `Http Request File`、`Websocket Receiver` / `Sender`、`Monitor Capture`、`Shell` / `Terminal Trigger`、`Gmroom`（资料 §8.3） | — |

### 2.11 交互与外壳

| 能力 | PixelCraft | PixelOver | Pixel Composer | 备注 / 依据 |
|---|---|---|---|---|
| 触屏手势 | 有，且是产品核心。`src/app/gestures.ts` 定义 **8 个手势位 × 18 个可选动作**：画布边距双击（默认 undo）、画布内双击（默认 none）、双指双击（默认 redo）、双指长按（默认 nextLayer）、三指长按（默认 nextLayer，为规避国产 ROM「识屏」抢双指长按而新增）、三击（默认 zoomIn）、四指滑动（默认 framePreview）、长按（默认 pickColor）；另有双指缩放/平移与边缘自动平移。**已知细节**：连击判定窗口硬编码 480ms，而设置项 `gesture.doubleTapMs`（默认 420）只被双指双击使用；PC 模式下整条连击序列关闭（画布聚焦改由中键承担） | 有基础触控板支持（MacBook 触控板缩放与平移手势，S2）；无手机端产品 | 无触屏优先设计（桌面节点图） | 本项目最强项 |
| 手势可重映射 | 有。`src/app/gestures.ts` 的 `GESTURE_ACTIONS`（none/undo/redo/zoomIn/zoomOut/fitView/togglePlay/toggleOnion/toggleGrid/toggleSymmetry/toggleTimeline/framePreview/nextFrame/prevFrame/nextLayer/prevLayer/openPalette/pickColor）+ `GESTURE_DEFS` 8 个手势位，设置里可改（`gesture.*` 11 项设置） | 有快捷键管理（Shortcuts 标签，S10）；手势重映射未见依据 → 待核 | 有。快捷键可自定义、一个动作可绑多键（多键弹 **Pie menu**）、可从右键菜单改键（资料 §2.7） | — |
| PC 鼠标 / 键盘 | 有，且是近两批主力（`docs/PC.md`）：滚轮缩放（以光标为中心）、`Shift`/`Alt` 滚轮平移、中键聚焦适配、空格长按换色、右键用另一色槽、`Alt` 单击取色、`Tab` 专注、方向键平移/微移、悬停滚轮调值、快捷圆盘（按住 `F`）、浏览器手势拦截。**识别口径要说清**：PC 模式**只看「鼠标/精确指针 + 输入证据」**（`src/io/pcmode.ts` 的 `resolvePcMode()`：`seenMouse` → 真、`seenTouch`/`touchPoints>0` → 假，最后才退到媒体查询 `(pointer: fine) && (hover: hover)`），**源码里没有任何窗口宽度或分辨率判定** —— `AGENTS.md` §7 与 `docs/PC.md` 里「鼠标 + 宽屏启发式」的说法中「宽屏」那一半不成立（宽屏只影响 CSS 布局层） | 有。鼠标左/右键主次色、中键、滚轮、**移动或旋转视图时鼠标环绕（mouse wrap）**（S2/S17） | 有。节点图鼠标体系 + 数位板 + 笔压；`Ctrl/Shift/Alt` 组合极多（资料 §2.7） | — |
| 快捷键可重映射 | 有。`src/app/keymap.ts` 自定义快捷键 + `src/app/shortcuts.ts`（`ShortcutAction` 联合类型含 undo/redo/save/openFile/newDoc/exportFile/copy/cut/paste/delete/escape/pasteLayer/pasteCanvas/swapColors/shortcutHelp/resizeMode/pieLaunch/framePrev…）；`Ctrl+F1` 一览面板可点按键改键、冲突提示、恢复默认 | 有。Settings → **Shortcuts** 完整列表可查看与管理绑定；重复快捷键会弹警告（S10/S2） | 有。集中管理的热键页 + 工具快捷键可在偏好里改 + `Direct Key Capture`（1.21.7）（资料 §2.7） | — |
| 浮动球 / dock | **有（特色）**。实为 **5 个球**（`OrbId = "main" \| "sel" \| "pal" \| "fx" \| "canv"`，即主球 / 选区球 / 取色球（扇形）/ 魔法球 / 画布球）。**「互斥」与「可同开」两条都真，区别在模式**：触屏模式点开一个球会收起其它球；**PC 模式**多个球可同时展开且不拦画布操作（Esc 收球）。球间距 `ORB + 16 = 68px`；dock 停靠持久化（`pc.orb.dock`、`prefs.dockPos`）、逐球展开锁定 `ringLock`（`src/ui/orb-layout.ts` 的 `orbMetrics`、`src/ui/pie-layout.ts`、`docs/API.md` §18.6b） | 无（桌面 dock 面板体系：0.19.1 RC1 起面板可移动、可浮动成独立窗口、布局随项目保存）（S10/S2） | 无浮动球；有 Panels / Dialogs 双体系 + Workspaces + 面板可成独立窗口（仅 Windows）（资料 §2.1） | 各家的「外壳哲学」不同：触屏球 vs 桌面 dock |
| 面板与弹窗 | 有。`src/ui/modals.tsx` 的 `ModalId` **15 个**（menu / changelog / newdoc / newproject / export / adjust / settings / frame / framePrev / size / sheet / history / canvasRef / shortcuts / customise）+ 另外两个不在 `ModalId` 里的面板（调色板面板 `PalettePanel`、标签编辑器 `TagModal`），共用 `Dialog` 组件库。**返回手势逐层关闭**：`MainActivity.onBackPressed` 先问 Web 的 `window.__pc_back()` —— 引导层最优先 → 有遮罩的浮层直接 `.click()` 关闭 → 派发 `pc-back` 事件让 React 认领（**一次把所有展开的球环全收掉**）→ 无人认领才进 `backAction()`；**二次确认退出**：首次 toast 提示、**2 秒内**再按才退出。**注意 `src/ui/back.ts` 里并没有「层栈」结构**，「逐层」是上面三处松散拼装 | 有。Project 页由面板组成，每个面板可含多页签（View/Scene/Z Order/Animations/Selected Object/Materials/Particles/Shader/Project settings/Animation）（S10） | 有。首次打开 5 个面板 + Nodes/Tunnels/Collection/Randomizer/Custom/Histogram/Console 等；对话框可钉住、可成独立窗口（资料 §2.1） | — |
| 界面定制 | 有，且做得较深。`src/app/uibar.ts`（`TOPBAR_ACTIONS` / `CBAR_ACTIONS` / `ORB_IDS` / `LAYOUT_KEYS` / `DEFAULT_LAYOUT` / `moveId` / `toggleHidden`）+ `CustomiseModal`（布局/工具栏/浮动球三个分页）+ **在界面上直接拖动排序/隐藏**（`Session.uiEdit`）（`docs/API.md` §18.7b1） | 有（0.19.1 RC1）：面板可拖到别的 dock、可 Make Floating、dock 空了自动隐藏、布局随项目保存并对新项目复用（S2） | 有。Workspaces 存布局 + `__default` 兜底 + 主题/UI 缩放（资料 §2.1/§2.7） | — |
| 撤销栈与历史回放 | 有。`src/engine/history.ts` 的 `record`（廉价逆向）/ `pushPixels`（像素差分：稀疏 `idx/pre/post` 与稠密 `fullB/fullA` 自动二选一）/ `pushStruct`（结构快照）；**`histMode` = steps（默认）/ full（完整回放）**，步数设置 `history.steps` 范围 10–500、**默认 120**（`History` 类内初值 `cap = 60` 在启动时会被 `Session.applyHistoryLimit()` 覆盖，**实际默认 120**）；`undo/redo/jumpTo`/`list`；**整个工程共用一条栈**，跨画布可撤销；**历史随工程保存**（`src/io/historyfile.ts` 的 `encodeHistory`/`decodeHistory`，受 `data.recordHistory` 控制，**自动保存从不存历史**）；`src/ui/replay.tsx` 做操作记录与回放（可暂停/三档速度，退出回到进入前的 index） | 有。撤销/重做贯穿全局（0.11.1 专门改进），含多选、绘制选区、锁定、关键帧位置；**撤销步数上限未找到官方数值 → 待核**（S10/S2） | 有。全流程可撤销（含缓动编辑、文件夹创建、驱动修改、动画长度缩放、帧范围、选区操作）+ **独立历史面板**（默认 `Ctrl+Alt+Z`）（资料 §2.7） | 本项目的「历史随工程保存 + 可回放」是差异化项 |
| 自动保存与备份 | 有。`src/io/autosave.ts`（IndexedDB，`AUTOSAVE_MAX_BYTES = 32MB`，后台立即落盘，可手动保存/清除）+ `.pxc` 按间隔自动保存（默认 5 分钟，可调 1–60）；设置可整体导出/导入 JSON；**无多版本备份 / 崩溃恢复提示 / 最近工程列表**（`docs/COMPARISON.md` 三.5 列为缺口） | 有。自动备份（Settings → General）+ 备份系统抢救上次会话 + 异常退出恢复对话框（S10） | 有。文件自动保存（按工程设置，`.pxc` 后缀）+ 备份存档（默认 1 份，可调）+ 硬崩溃后高亮自动保存目录图标（资料 §10） | 本项目在「多版本备份/崩溃恢复」上弱于两家 |
| 引导教程 | 有。`src/app/guide.ts` 的 `GUIDE` 实测 **46 步**（`GUIDE_MODULES` 6 个模块：canvas / tools / orbs / timeline / files / gestures）+ `src/ui/guide.tsx` / `guide-demo.tsx` / `guide-layout.ts`：模块化高亮引导 + **真操作演示**（`simulateTap` 派发 pointerdown/up/click，演示自还原）+ `tests/guide-anchors.test.ts` 静态扫描 `src/ui` 源码校验每个 `data-guide` 锚点真实存在。**注意**：`docs/COMPARISON.md` 正文另一处仍写「41 步」（旧值） | 无（无新手引导相关记载） | 无引导教程（有 `Slideshow` 节点，是给教程工程用的演示工具，资料 §3.19） | 本项目明显强于两家 |
| i18n | 有。中英双语同文件 `src/ui/i18n.ts`（588 行），**叶子键 zh / en 各 730 个、差集为 0**，顶层键 588 个；`makeT()` 查不到键时回显 key 本身，这正是静态测试能工作的原因。`tests/i18n.test.ts` 四道检查：源码里所有字面量 `t("...")` 键两种语言都能解析、点号字面量首段可解析、动态拼接 prefix 必须是嵌套字典、zh/en 顶层键完全一致 | 有。8 种语言，Crowdin 托管（S2/S5） | 界面语言仅 English；有本地化管理器 `words.json`/`nodes.json`（资料 9.4） | 口径提醒：「键数」按不同数法差别很大（叶子 730 / 顶层 588 / 测试里的行正则口径只有 220） |
| 主题 | 有。`src/io/theme.ts` 刻意最小（只有 `ThemeMode = "dark"` / `"light"`、`themeMode()`、`applyTheme()` 三件事：给 `<html>` 加/删 `data-theme`、设 `colorScheme`、改 `<meta name="theme-color">`），真实配色在 `src/ui/style.css`；`docs/UI.md` §0 的 `ui.theme` 设置项；`tests/ui-tokens.test.ts` 定义 **40 个尺寸令牌 + 77 个主题令牌 = 117 个契约令牌**并静态断言：尺寸/主题令牌都在 `:root` 存在、浅色块必须覆盖每一个主题令牌、app-shell 不得硬编码颜色、所有 `var(--x)` 引用都已定义 | 有。Blue / Dark / Light 三种主题 + 自定义颜色（0.9.2，S2） | 有。主题由 `meta.json`/`graphic.json` 定义，1.21.0 起改动即时生效（资料 §2.7） | — |
| 安全区适配 | 有。`src/io/safearea.ts` 写入 CSS 变量 `--sat/--sab/--sal/--sar`；全面屏与安全区适配在 `AGENTS.md` §8 | 未见依据 → 待核 | 未见依据 → 待核（桌面软件） | — |
| 震动 / 触觉反馈 | 有。`Session.hapticTick(tag, scale)`（受 `gesture.haptic` 开关与 `prefs.hapticLen` 控制），`android/AndroidManifest.xml` 含 VIBRATE 权限 | 无 | 无 | 触屏专属 |

### 2.12 平台与工程

| 能力 | PixelCraft | PixelOver | Pixel Composer | 备注 / 依据 |
|---|---|---|---|---|
| Android APK | 有。自研无 Gradle 打包链（`javac` + `d8` → 往模板 APK 塞 dex 与 www）；`android/AndroidManifest.xml`：`com.pixelcraft.app`、minSdk 24 / targetSdk 34、**权限只有 `android.permission.VIBRATE`**（无 INTERNET ⇒ 天然全离线）、versionCode 56 / versionName `1.1.0.0`；`MainActivity.java` 399 行、JS 桥 `PixelBridge` 8 个 `@JavascriptInterface` 方法（saveFile / openFile / toast / hasVibrator / vibrate / insets / setImmersive / keepAwake），加载 `file:///android_asset/www/index.html`。**注意**：仓库内**没有** apk 产物（`build/` 为空且在 `.gitignore` 里）、也**没有**出包脚本（`scripts/` 4 个全是 Web / 测试 / 部署），真正的打包链在容器 `/root/pk/`（`AGENTS.md` §6） | 无 | 无 | — |
| PWA / 网页版 | 有。`app2/www` + `manifest.webmanifest`；GitHub Pages 部署（`README.md` §5）；**无 service worker**（`app2/www/` 目录里没有 `sw.js`，源码里 `serviceWorker` 零命中；离线请装 APK） | 无 | 无 | — |
| 桌面原生程序 | **无**（`docs/PC.md` §三「不做多窗口」；PC 模式只是 Web 界面的桌面化） | 有（Win/macOS/Linux） | 有（Win + Linux 构建 + macOS beta） | — |
| 硬件要求 | 低（WebView / 浏览器；无 GPU 特性要求） | 高：**必须完整 Vulkan 1.2**，部分核显不支持；RAM 4GB（建议 8GB）（S5） | 中：Win10+ / 64 位 / 8GB / OpenGL / DX11 / 500MB（资料 §0） | 本项目门槛最低 |
| 性能与增量渲染 | 有：`Stroke.takeDirty()` → `composeRectInto` → 视口脏矩形 blit；`Session.repaint()` 由 rAF 合并；`repaintRect(rect)` 局部更新；洋葱皮幽灵帧与选区染色按版本号缓存（`AGENTS.md` §4、`docs/API.md` §15）。**未做**：overlay 笔迹层、Web Worker、大画布压力测试（`AGENTS.md` §7） | 有：架构重写（0.10.1）、少用 CPU/GPU 的选项、compatibility mode（S2） | 有：局部图渲染、多帧异步渲染、partial processing、pure function group、全节点可开缓存、GPU 网格渲染、surface 上限 16384px（资料 §10） | — |
| 导出保护 / 预算 | 有。`src/io/exporters.ts` 的 `MAX_IMAGE_PIXELS = 16M`、`MAX_TOTAL_PIXELS = 48M`、`MAX_LAYER_FILES = 12`、`exportBudgetError` | 有导出进度对话框（可取消）（S22） | 有导出前目标文件校验、路径 token、外部编码器（ImageMagick/WebP/Gifski/FFmpeg）（资料 §8.2） | 本项目的像素预算限制是移动端的取舍 |
| 测试规模 | 有。`tests/` **33 个测试文件**（`*.test.ts` 32 + `*.test.tsx` 1）+ `common.ts` / `run-tests.ts`，**无 DOM 依赖**（Node 直接跑；33 个测试文件共 6970 行）。**口径**：`tests/common.ts` 的 `eq`/`ok` 现在会累计条数，`finish()` 在 `ALL PASS` 之前打印 `assertions: N`，所以这个数字是**可复现**的——本次实测 **2060 条**。写这份文档时它还没有计数器，当时只能静态数断言调用点（1781 处）；随后已补上计数器并把 `README.md` / `AGENTS.md` / `docs/API.md` / `docs/UI.md` 里的旧口径（540+ / 约 1950 / 1949 项 / 1053 条 / 1108 项）统一改成 2060 | 未见测试口径 → 待核 | 官方开源仓库存在，但资料未给测试规模 → 待核 | 本项目是三者里唯一有公开可跑的无 DOM 回归套件的 |
| 测试覆盖边界 | **有明确空白**：`tests/` 覆盖 `exporters.ts` 的纯函数（`frameRange` / `exportBudgetError` / `encodeGIF` 真编解码）、`aseread` / `asewrite` / `zlib`、`Session.pasteAs*`；但 `src/ui/modals.tsx` 的 `openFileBytes` / `decodeStill` / `SheetModal` / `ExportModal` 因依赖 DOM **零覆盖** ⇒ **整条导入/导出 UI 流程没有自动化测试**；`tests/view.test.ts` 里 `gesture` 零命中（画布手势的**触发**逻辑无单测，只有会话层的映射测试）；`jumpTo` 无测试；`safearea` / 主题无独立单测 | 未评估 | 未评估 | 这也是本文对「导入 / 导出」的结论只能停在源码级的原因之一 |
| 版本号一致性 | `APP_VERSION`（`src/ui/changelog.tsx` = `1.1.0.0`）与 `android/AndroidManifest.xml` 的 `versionName` 一致，versionCode 56；已知缺口：**需手动同步、无自动校验**（`AGENTS.md` §7） | 不适用 | 不适用 | — |
| 代码可维护性（已知缺口） | `view.ts` / `session.ts` / `App.tsx` 仍偏大（`AGENTS.md` §7）；`session.ts` 被自家文档称为「上帝对象」（`docs/COMPARISON.md` 三.6，该评价写在早期版本，参考时注意时效） | 未评估 | 未评估 | — |

---

## 3. 本项目已有的差异化优势

> 每条都给出代码/文档依据，并说明对用户的**实际价值**。

1. **无限空间多画布 + 共用一条撤销栈**
   - 依据：`Session.docs: CanvasEntry[]` / `addCanvas` / `focusCanvas` / `closeCanvas`（`docs/API.md` §18.4）；`clampView()` 在多画布时「保证包围盒至少露出一角」＝无限空间（§18.6）；`Session.history` 是**整个工程共用的一条栈**，每条记录带自己的文档引用；关闭画布也是一条可撤销的 `canvas-close` 历史步。
   - 价值：一个角色 + 道具 + UI 图集可以并排摆在一个工程里，互相参考；跨画布撤销/重做不会错乱；误关画布可撤销找回。两个竞品都是「一个工程一份文档（或多标签窗口）」的桌面模型，没有这种空间式画布。

2. **画布吸附成组（真·几何吸附）**
   - 依据：`src/app/canvas-snap.ts` 的 `SNAP_GAP` / `TITLE_EXTRA` / `SNAP_GAP_V` / `stackGap` / `titleObstacle` / `titleTop` + `Session.snapPosition` / `finishCanvasDrag` / `linkCanvas` / `unlinkCanvas`；范围、留白、进出颜色可配（`canvas.snapOn/snapRange/snapGap/snapInColor/snapOutColor`）；叠放时标题栏自动「让位」进空隙（`.tight`，16px）。
   - 价值：多画布从此不是「散落一地」——拖动时自动贴合成组、整组移动、留白统一；这是触屏小屏上管理多张画布的关键手感。

3. **引用画布（跨画布实时双向联动）**
   - 依据：`Session.referenceCanvas(i,{mode})`（`mode="layers"` 每源图层一条引用层 / `mode="flat"` 整张）、`isRefLayer` / `strokeTarget` / `refSourceLayerOf` / `refPaintBlock` / `unrefLayer` / `unrefAll`（`docs/API.md` §18.4）；`Session.syncRefLayers()` 按源画布版本号镜像，渲染路径与普通图层一致（§18.6）；用「引用图层改动」历史步记录。
   - 价值：把一张画布当「素材源」，别的画布引用它——改源画布，所有引用处同步更新（双向可画）。这是桌面软件里要靠「外部链接 / 智能对象」才能做到的事，本项目做成了图层级操作。

4. **能读也能写 Aseprite（`.ase` / `.aseprite`）**
   - 依据：`src/io/aseread.ts`（`parseAse` / `aseToDoc` / `readAseDoc`，魔数 `ASE_MAGIC`，上限 `ASE_MAX_SIZE = 1024`）+ `src/io/asewrite.ts`（`writeAse`，cel 按内容裁剪、zlib 压缩 + 无压缩退回）+ `src/io/zlib.ts`（自写 inflate）；读写涵盖 RGBA / 16 位灰度 / 8 位索引色、多图层、多帧、链接 cel、调色板、帧时长、混合模式、动画标签（`docs/API.md` §16.6）。
   - 价值：这是三者唯一的**双向** Aseprite 通道——PixelOver 只能导出、Pixel Composer 只能导入（资料 §13 节 / §8.3）。手机上画的图可以直接落到 Aseprite 管线里，也可以把 Aseprite 工程带到手机上继续画。

5. **动画标签（tag）的交互密度**
   - 依据：`src/engine/tags.ts`（`tagAt` / `clampRange` / `normalizeTags` / `tagsAfterInsert` / `tagsAfterRemove` / `tagLanes` / `TAG_COLORS`）+ `src/app/playback.ts` 的 `PlayWindow`；**点哪个标签就播哪个**（`startPlayback(tag)`，重叠也不按帧优先）、播放中点别的标签＝**切换正在播的动画**（`retargetPlay`）、重叠标签**自动分层显示**、拖标签边缘直接改范围（一次拖动一条历史）、右键/长按打开 `TagModal`；标签随 `.pxc` 与 `.aseprite` 双向存取。
   - 价值：手机上没有键盘与右键菜单，本项目把「标签 = 可点的播放区 + 可拖的范围手柄」这一套做成了触屏手势，这是 PixelOver（**根本没有 tag 系统**）与 Pixel Composer（只有 1.21.3 的 Region/标签导入）都不具备的交互形态。

6. **触屏手势体系 + 可重映射 + 浮动球外壳**
   - 依据：`src/app/gestures.ts`（17 个动作 × 8 个手势位可配）；`FloatingTools`（主球/选区球/取色球/魔法球，多球互斥 68px、可同开、dock 持久化、展开锁定，`src/ui/orb-layout.ts` 的 `orbMetrics`）；边缘自动平移；画布边距双击＝undo、双指双击＝redo、三击＝2× 放大（`AGENTS.md` §4）。
   - 价值：单手可完成「撤销/重做/切帧/切图层/开网格/开对称」等高频操作，且每个手势都能改成自己顺手的动作——两个桌面竞品都没有对应物。

7. **一键界面定制（顶栏/底栏/浮动球都能重排与隐藏）**
   - 依据：`src/app/uibar.ts`（`TOPBAR_ACTIONS` / `CBAR_ACTIONS` / `ORB_IDS` / `LAYOUT_KEYS` / `DEFAULT_LAYOUT` / `moveId` / `toggleHidden` / `orderedActions`）+ `CustomiseModal`（布局/工具栏/浮动球三个分页）+ **在界面上直接拖动排序/隐藏**（`Session.uiEdit`），隐藏再恢复位置不变（`docs/API.md` §18.7b1）。
   - 价值：小屏上「什么按钮放在哪」是刚需；本项目把它做成可拖动的编辑模式，而不是配置文件。

8. **无 DOM 依赖的回归测试规模**
   - 依据：`tests/` **33 个测试文件**，全部在 Node 下直接跑纯数据（`tests/common.ts` 计数 → 实测 **2060 条断言**，`node .ts-out/tests/run-tests.js` 末尾打印 `assertions: 2060`）；`tests/guide-anchors.test.ts` 静态扫描 `data-guide` 锚点、`tests/i18n.test.ts` 静态校验 i18n 键、`tests/ui-tokens.test.ts` 校验令牌、`tests/ui-kit.test.tsx` 强制 `ui/kit` 的 import 边界。
   - 价值：引擎、布局、解析、决策这类「容易改坏」的逻辑都有回归网；对长期自用/移植项目来说这是最实际的资产。（写这份文档时各文档口径不一，现已统一到 2060 并让 runner 打印条数。）

9. **参考图浮窗（带位置 / 大小 / 不透明度）**
   - 依据：`src/io/refstore.ts`（`RefState{x,y,size,opacity}`，IndexedDB 12MB 上限）+ `src/ui/refimg.tsx`。
   - 价值：手机临摹时参考图能压在画布上方按需要缩放/淡出；PixelOver 侧「参考图专用面板」在资料里是**待核**项（未找到官方依据）。

---

## 4. 明显缺口

> 只陈述**事实与影响**，不给实现方案（实现建议由另一位负责）。
> 排序按「对像素画创作用户的影响」从高到低。

| # | 缺口 | 对用户的影响 | PixelOver 对应的能力 | Pixel Composer 对应的能力 |
|---|---|---|---|---|
| 1 | **无图层组、无图层蒙版/剪切蒙版**（`src/engine/doc.ts` 无 group 字段；唯一的 `mask` 是选区掩码） | 复杂作品的图层列表只能平铺，几十个图层后无法折叠管理；做「只影响某个区域的调整」只能靠选区反复重做 | 图层可父子嵌套（0.17）+ 图层/多图层作 **clipping mask**（0.8/0.17，S2/S11） | Group / inline group / cache group（`Ctrl+G`，双击进组）+ 多节点 mask 输入（资料 §1、§6） |
| 2 | **无关键帧 / 曲线编辑器**：动画只有逐帧 + 帧时长，没有任何属性动画 | 想做「移动/缩放的平滑动画」只能一帧一帧画；没有缓动、没有 subframe、没有曲线视图 | 关键帧几乎覆盖所有属性 + 缓动 + **动画图编辑器** + Rest/Pose + `.poanimation`（S12） | 关键帧 + `Linear/Smooth/Hold/step/Clean Edge` 插值 + **小数帧 subframe** + Curve view + Driver（资料 §5.1–§5.4） |
| 3 | **无抖动 dithering、无匹配索引色、无颜色循环、无二值透明** | 像素画最典型的「16 色 + 抖动」工作流做不了；做渐变过渡只能手工点像素；做流水/火焰一类循环动画无法只改调色板 | Dithering（可配阈值）+ Match Indexation（带可动画 Shift＝**color cycling** 五步流程）+ 二值透明（S8/S15/S16） | `Dither` / `Dither Diffuse`（误差扩散）/ `Palette Shift`（颜色循环）/ `Alpha Cutoff` / `Threshold` / `Posterize`（资料 3.3/3.5 节） |
| 4 | **无骨骼 / IK / 网格变形 / 权重**（`src/` 里没有任何骨骼或网格变形实现） | 角色动画只能逐帧重画；做「换个姿势 / 换个角度」没有变形工具支撑 | 骨骼链 + 2D IK（角度约束、pole target）+ 网格变形（点编辑、网格点关键帧、smooth、自动/手动权重）（S18/S19/S20） | `Armature` 全家（Bone/Ik/Pose/Bind/Skin/Mesh Rig…）+ `Mesh Warp` / `Grid Warp` / `Bend` / `Polar` / `Straighten`（资料 3.6/§7） |
| 5 | **无音频驱动、无动画片段存读、无标签方向/重复语义落地** | 音画对不上（做节奏动画只能数帧）；一段动画没法单独存下来复用到别的工程；Aseprite 的 tag 方向/重复次数读进来后播放不生效 | `.poanimation` 可跨工程复用并 **rebind**（S12/S14） | 音频节点（`Audio Loudness` / `Fft` / `Audio Window`）+ Collection/Preset 跨工程复用（资料 §5.5、§2.5） |
| 6 | **导出格式单薄**：无 APNG、无动画 WebP、无视频（mp4/webm）、无 tilemap（`.csv`/GameMaker room）、无 `.bmp`/`.ico`/`.txt` | 做游戏时若引擎要 APNG/WebP/视频，只能先导 GIF 再转，画质与体积都吃亏；做 tile 游戏没有 tilemap 导出通道 | 也只有 PNG/GIF/Aseprite 三种（S22）——**这一项 PixelOver 并不比本项目强** | `.png/.jpg/.webp` + `.gif/.apng/.mp4/.webm` + `.exr/.bmp/.ico/.txt/.csv` + GameMaker room（资料 §8.2） |
| 7 | **无文字工具** | 游戏里要写字只能外部做好再导入；没有打字机效果一类文字动画 | **Text2D 对象** + 可动画的「可见字符百分比」（打字机效果）（S2） | `Text` 节点 + Text 数据类型约 30 个节点（Format/Regex/Join/Split…）（资料 3.4/3.7 节） |
| 8 | **无脚本 / CLI / 批处理 / 插件** | 重复性工作（几十张图的同一套处理、批量导出）只能手动重复；无法接入自动化管线 | **同样没有**（判定为不存在，S1/S6/S14） | PCX 表达式 + Lua + HLSL + **CLI headless** + Array Processor + Addon 自定义节点（资料 §4.2、§8.4、§9） |
| 9 | **无去毛刺 polish、无降噪 denoise、无色阶/曲线** | 从别的来源导入的图（或 AI 生成的图）没法用像素画专业修边工具清理；`src/engine/adjust.ts` 只提供 HSL 三通道调整，没有 levels/curves | Polish（清理短边缘）+ Denoising（S8）；**「色阶」在 PixelOver 官方资料里是待核** | `De Corner` / `De Stray` / `Deblur` / `Gap Contract` + `Level` / `Curve` / `Gamma Map` / `Lut` / `Normalize`（资料 3.3 节） |
| 10 | **无粒子、无 2D 灯光、无逐对象着色器** | 做火花/烟尘/光照氛围只能在帧里手绘；没有「改一个参数就换效果」的实时层 | 粒子系统（0.13）+ 2D 灯光（normal map + 遮光体，0.18.2）+ **每对象着色器**（0.17）（S21/S2/S8） | `Psystem *` 33 个 2D 节点 + `Vfx *` + `2D Light` + `Hlsl` 自定义着色器（资料 3.3/3.10、9.2） |
| 11 | **无参考图层 / 裁剪层、无图层缩略图**（`docs/COMPARISON.md` 三.4 明确列为缺口） | 描线时无法把草稿层锁成不可编辑的参考；图层多了之后没有缩略图，只能靠名字认 | 对象可见性/可选性分类开关；图层作 clipping mask（S10/S11） | Group Thumbnail、预览面板、节点缩略图（资料 §2.4/§3.17） |
| 12 | **无多版本备份 / 崩溃恢复提示 / 最近工程列表** | 误删或崩溃后只有一份自动保存可用，没有「回到昨天的版本」这条路 | 自动备份 + 备份系统 + 异常退出恢复对话框（S10） | 自动保存 + 备份存档（默认 1 份）+ 崩溃后高亮自动保存目录（资料 §10） |
| 13 | **无 WebP / APNG 导入、精灵表 JSON 不能再导入**（`docs/COMPARISON.md` 三.2 明确列为缺口） | 别人给的 WebP/APNG 素材要先转格式；导出的精灵表 JSON 只能给别人用，自己回不来 | 动画图**仅支持 GIF**；支持 `.webp` 静态导入与精灵表导入（S14） | 静态 `.webp`、`Image Gif`、`Image Sequence`、`Svg`、`Image Mp4`（资料 §8.3） |
| 14 | **无参考图专用面板以外的「导入外部图像为浮层并同步」的能力**（本项目有参考图浮窗，但没有「外部文件改动后自动同步」） | 素材在电脑上更新后，手机上要重新导入一次 | 资源可内嵌或只存路径，**外部同步**（在别的程序里改图，项目内会反映）（S14/S2） | `Directory Search` / 文件 IO 节点族 + 库路径编辑器（递归子目录）（资料 §8.3/§10） |
| 15 | **无硬件性能上限文档与大画布压力测试**（`AGENTS.md` §7：未做 overlay 笔迹层 / Web Worker；`docs/COMPARISON.md` 三.1） | 1024² 以上、多图层多帧时帧率下降的边界不明确 | 架构重写 + compatibility mode + 少用 CPU/GPU 选项（S2） | 局部图渲染、多帧异步渲染、partial processing、surface 上限 16384px（资料 §10） |
| 16 | **「文档 ↔ 源码」不一致与死代码残留**（本文件发现后已修掉大部分，剩下的都在这行注明）：**已修**——断言数各文档口径不一（现统一 2060，runner 会打印条数）、`AGENTS.md` §4 `histMode` 默认值（60 → 120）、`AGENTS.md` §4 浮动球写成 4 个（实为 5 个：加画布球）、多边形边数提示写「3–12」（实为 3–32）、`App.tsx` 的 `PanelId` 有一个无实现的 `"layers"` 变体、`tests/ui-tokens.test.ts.tmp` 0 字节残留（已删）；**仍待核**——`docs/API.md` 里 5 个签名与源码不符（需逐条核）、`.fly-mask` 是死选择器（`src/main.tsx` 里仍在查）、空的 `build/`（gitignore 产物目录，无害） | 会误导读文档的人与后续接手的人（本文已尽量按源码为准） | — | — | 这是「文档卫生」问题，与功能无关 |

### 4.1 只在两个竞品之一存在的缺口（便于排期时区分「行业标配」与「差异化补齐」）

- **行业标配（两家都有，本项目缺）**：抖动 dithering、匹配索引色/颜色循环、二值透明、文字对象、去毛刺/降噪类修边、色阶曲线类调整、图层缩略图、自动备份与崩溃恢复、外部文件同步。
- **只有 Pixel Composer 有（本项目缺）**：节点图、脚本三件套（PCX/Lua/HLSL）、CLI headless、批处理/数组迭代、程序化生成（噪声/图案/SDF/Pixel Builder）、物理与流体模拟、tilemap 导出、音频驱动、Krita/ORA 导入、Spout/MIDI/HTTP 等外部通道。
- **只有 PixelOver 有（本项目缺）**：骨骼 + IK + 权重 + 网格变形、每对象着色器与 `.poshader` 资源、粒子系统、2D 灯光（normal map + 遮光体）、关键帧动画图编辑器、`.poanimation` 动画片段 rebind。
- **反过来看（两家都缺、本项目有）**：无限空间多画布与画布成组、引用画布实时双向联动、动画标签的触屏交互形态、手势重映射、浮动球外壳与界面定制、无 DOM 依赖的回归测试规模。**注意**：PixelOver **完全没有洋葱皮与帧标签**（第 7 节判定），而本项目两者都有且较完整。

---

## 5. 不参与对比的 3D 能力

> 本节只做**边界说明**，不进入上表，也不用于任何结论。

### 5.1 PixelOver 的 3D 能力（资料第 13 节，15 条）

3D Layer（相机/投影/环境与阳光，只接受 3D 对象）；3D 对象类型（3D Container / 3D Shape / 3D Model / 3D Scene / 3D Bone）；3D Image 与 Animated Image（shaded/unshaded、billboard，细节待核）；3D 导入格式（`.obj`/`.vox` 单网格；`.gltf`/`.glb`/`.fbx`/`.dae`/`.blend` 多模型场景；`.mtl` 材质与 linked material 共享实例）；3D 材质编辑（ORM maps、材质级着色器可按材质套 indexation 与 dithering、材质属性可逐个打关键帧含 UV 动画）；3D 相机与视图（Perspective/Orthographic、FOV、相机预设、Camera 可进动画轨道）；3D 环境与光照（point/spot/directional 灯光及其 Z 范围）；3D 骨骼与 3D IK（0.15/0.15.1，含 IK 链约束与 pole target）；**3D 自动旋转导出**（绕 Y 轴多方向精灵，0.18.4 起最多 3 轴、轴名入文件名）；3D 专用视图（**Normal Buffer** / **Depth Buffer**）与基于法线/深度的 `Normal Line` / `Depth Line`；3D 粒子；**深度位移 depth displacement**（对 3D 图像/动画图用深度贴图做顶点位移，可自动生成法线与深度图）；3D Text 对象；以及路线图里 3D 相关的待做项（流体、物理刚体与骨骼、路径约束）。

### 5.2 Pixel Composer 的 3D 能力（资料第 11 节）

官方文档 `nodes/3d/**` 分支共 **66 个 3D 节点**：3D → 2D Operation / Filter（`Ambient Occlusion`、`Bevel`、`Normal`、`Normal Adjust`、`Normal Blend`、`Normal Light`、`Normal To Height`、`Pb Fx Bevel`、`Sprite Stack`）、Projectors（`Heightmap Project 3D`、`Surface Project 3D`、`Surface Project Cylinder 3D`、`Surface Project Volume 3D`）、Simple 3D（`3D Transform Image`、`Shape 3D`）、3D Light（Directional/Point）、3D Material、3D Mesh（Creator 6 / Exporter 3 / Importer 2 / Primitive 7）、Modify（Instance / Material 2 / Mesh 8）、3D Point（4）、**Ray Marching `Rm *`（9）**、Scene（2）与 Scene Camera（2）、3D Vfx（`3D Instancer`、`3D Particle`）；另有 `Psystem 3D *` 全系列、3D 预览模式、3D 网格设置、深度输出与深度混合、骨骼蒙皮与顶点权重着色、1.21.4+ 的 Projector 节点组。

### 5.3 边界提示（容易混淆但在本文口径下已排除）

- Pixel Composer：`Normal` / `Adjust Normal` / `Blend Normal` / `Normal to Height` / `Sprite Stack` / `2D Extrude` / `3D Transform Image` 在官方导航里位于 `3d` 分支之下，因此**按官方分类归入 3D、已排除**（资料附录 B 第 7 条）；但 `Mesh Warp` / `Mesh Create Lattice` / `Mesh Create Path` / `Mesh Transform` 与 `Mesh` 数据类型、`Camera`（2D 相机 + 景深 + 视差）**属 2D、已计入**上表（资料 §11.2）。
- PixelOver：2D 网格变形、2D Bone/IK、2D 灯光（Lit 2D + normal map + light occluder）**已计入 2D**（资料第 13 节第 14 条）；只有 Normal/Depth Line、Normal/Depth Buffer 视图、深度位移按 3D 排除。
- 本项目：无 3D 能力。

---

## 6. 来源与待核清单

### 6.1 实际读过的文件（含行数 / 小节）

**竞品资料（`/sdcard/Download/`）**

| 文件 | 行数 | 用到的小节 |
|---|---|---|
| `pixel-tools-features.md` | 527 | §1.1–§1.14（PixelOver 全部）、§2.1–§2.14（Pixel Composer 全部，含 894 条 2D 节点页清单） |
| `PixelOver-功能清单.md` | 491 | §0 产品身份、§1 画布与文档、§2 界面与工作流、§3 绘制工具、§4 图层与场景、§5 调色板与颜色、§6 线条与滤镜、§7 时间轴与动画、§8 骨骼/IK/网格/权重、§9 粒子、§10 2D 光照与文字、§11 导入导出、§12 设置与性能、§13 3D 排除、§14 社区反馈、文末「来源 S1–S34」与「未能核实」清单 |
| `PixelComposer-功能清单.md` | 2553 | §0 产品身份、§1 节点图与工程、§2 界面与交互、§3.3 Filter / §3.4 Generate / §3.5 Color / §3.6 Compose / §3.7 Values / §3.14 Pixel Builder、§4 节点系统基础、§5 动画与时间线、§6 遮罩/选区/路径/SDF、§7 相机与采样、§8 导出与集成（含 §8.4 CLI）、§9 脚本与扩展、§10 工程性能与缓存、§11 3D 边界（含 §11.2）、§12 来源、附录 A 统计、附录 B 待核 |

**本项目仓库（`/sdcard/Download/ds文件夹/pixelcraft/`）**

| 文件 | 用途 |
|---|---|
| `README.md`（139 行） | 对外功能清单（§1 功能一览、§5 平台说明），用作**线索** |
| `AGENTS.md`（311 行） | §1 项目速览、§4 架构要点、§7 已知缺口、§8 近期已完成、§9 文档地图 |
| `docs/API.md`（1415 行） | §16.2 导出、§16.5 工程/自动保存/GIF/剪贴板、§16.6 Aseprite 读写、§16.7 动画标签、§16.8 播放范围、§18.1–§18.9 多画布/特效/吸附/浮动球/颜色拖拽/界面定制/快捷圆盘/画布空间命中测试、§19 扩展指南（含 2060 条断言口径）、§20 UI 控件库 |
| `docs/COMPARISON.md`（133 行） | 已有 Aseprite / Resprite 对比：用于**避免重复**与复用「最新进展」口径 |
| `docs/UI.md`（502 行） | 设计令牌、`ui/kit` 依赖边界与测试约定 |
| `docs/PC.md`（102 行） | PC 模式已完成清单与 20 条待办（含「不做多窗口」等取舍） |
| `src/tools/registry.ts` | 工具 id 表与分组（`CORE_TOOLS` / `SHAPE_TOOLS` / `SELECT_TOOLS` / `SYM_TOOLS`） |
| `src/engine/types.ts` | `BLEND_MODES`（12 种）、`Rect` |
| `src/engine/doc.ts` | `Doc` / `Layer` / `Cel` / `Selection.mask`（确认无图层组、无图层蒙版） |
| `src/engine/history.ts` | `record` / `pushPixels` / `pushStruct`、`cap`（类内初值 60，启动后被 `applyHistoryLimit()` 覆盖为设置值，**默认 120**）、steps/full 双模式、`dump` / `loadDump` |
| `src/engine/effects.ts` | `outlineCel` / `blurCel` / `invertCel` / `desaturateCel` / `dropShadowCel` / `outerGlowCel` |
| `src/engine/adjust.ts` | `HslAdj` / `rgbToHsl` / `hslToRgb` / `adjustPixel`（确认无 levels/curves） |
| `src/engine/paint.ts` | `floodRegion` / `gradientFillRegion` / `sprayDots` |
| `src/engine/tags.ts` | `tagAt` / `clampRange` / `normalizeTags` / `tagsAfterInsert` / `tagsAfterRemove` / `tagLanes` |
| `src/app/session.ts` | 多画布、引用画布、`setIndexed` / `paletteSnap` / `remapToPalette`、`pasteAsNewLayer` / `pasteAsNewCanvas` / `pasteIntoFrames`、`extractLayerToCanvas`、`rotateCanvasContent`、`snapPosition` |
| `src/app/settings.ts` | 设置注册表（69 条 `path`），分组 canvas/data/display/general/gesture/history/onion/screen/tools |
| `src/app/gestures.ts` | `GESTURE_ACTIONS`（17 个动作）与 `GESTURE_DEFS`（8 个手势位） |
| `src/app/shortcuts.ts` | `ShortcutAction` 联合类型、`TOOL_KEYS`、`NUDGE_STEP` |
| `src/app/canvas-space.ts` | `canvasAtScreen` / `screenToCanvas` |
| `src/app/canvas-snap.ts` | `SNAP_GAP` / `TITLE_EXTRA` / `stackGap` / `titleObstacle` / `titleTop` |
| `src/app/playback.ts` | `PlayWindow` / `fullWindow` / `windowOf` / `startPlayFrameIn` / `nextPlayFrameIn` |
| `src/io/exporters.ts` | `exportPNG` / `exportGIF` / `exportSheet` / `exportASE` / `encodeGIF` / `frameRange` / `MAX_IMAGE_PIXELS` / `MAX_TOTAL_PIXELS` / `MAX_LAYER_FILES` |
| `src/io/aseread.ts` / `asewrite.ts` / `zlib.ts` | Aseprite 双向读写与自写 inflate |
| `src/io/project.ts` / `autosave.ts` / `historyfile.ts` / `clipboard.ts` / `refstore.ts` | `.pxc` 序列化、自动保存（32MB）、历史编解码、剪贴板、参考图存储 |
| `src/io/theme.ts` / `safearea.ts` / `pcmode.ts` | 主题、安全区、PC 模式识别 |
| `src/data/palettes.ts` | `PALETTE_PACKS` / `defaultPalette` |
| `src/ui/modals.tsx` | 弹窗清单、`H_ZH`/`H_EN` 历史动作名表、`.gpl` 导出入口 |
| `src/ui/orb-layout.ts` / `pie-layout.ts` / `color-drag.tsx` / `refimg.tsx` / `fxparam.tsx` / `replay.tsx` / `uibar.ts`（经 `docs/API.md` §18） | 浮动球几何、快捷圆盘、颜色拖拽、参考图、特效参数、历史回放、界面定制 |
| `src/ui/changelog.tsx` / `android/AndroidManifest.xml` | `APP_VERSION = 1.1.0.0` / `versionName 1.1.0.0` + `versionCode 56`（一致） |
| `src/ui/i18n.ts` | 中英双语 440 条键 |
| `tests/`（33 个 `*.test.ts(x)`） | 测试文件计数；`tests/guide-anchors.test.ts` / `i18n.test.ts` / `ui-tokens.test.ts` / `ui-kit.test.tsx` 的静态校验机制 |

### 6.2 「待核」清单（本文所有待核条目，集中列出）

**A. 本项目侧（没能在源码/文档里确认，不代表没有）**

| # | 待核项 | 为什么标待核 |
|---|---|---|
| 1 | 仓库的 **LICENSE 文件**（是否开源、何种许可） | 仓库根目录列表里没有 LICENSE，本文速览表的「是否开源」只写了「源码在本仓库」 |
| 2 | 本项目的**隐私政策 / 无 AI 声明** | 仓库里没有对应文档 |
| 3 | **画布尺寸上限**（`ASE_MAX_SIZE = 1024` 只约束 Aseprite 导入） | 自身画布没有明确的硬上限常量 |
| 4 | **是否存在「画布原点 / 坐标定位」设置** | 只找到画布位置由拖动决定的 `moveCanvas` |
| 5 | **把选区直接存为图层/画布**（不经剪贴板） | 只确认了 `pasteAsNewLayer` / `pasteAsNewCanvas` / `extractLayerToCanvas`，没有 `selToLayer` 之类专用入口 |
| 6 | **自定义笔刷 / 图案笔刷 / 抖动笔刷** | 源码零命中（判定为无）；**是否有排期未知** |
| 7 | **选区「扩展/收缩」的 UI 参数边界** | 引擎侧是参数化的（`growSelection(px)` / `shrinkSelection(px)`），UI 只给了 ±1 按钮 |
| 8 | **调色板导入的格式边界** | `parsePaletteBytes` 只支持 `.gpl` 风格 `R G B` 行与纯 hex 行，且不校验扩展名；是否还吃得下别的格式未穷举 |
| 9 | **图片导入的全部格式**（WebP / BMP 等是否可用） | 解析依赖浏览器解码能力，未逐格式确认 |
| 10 | **引导教程的真实步数** | `README.md` 写 46 步，源码条目计数未逐条核对 |
| 11 | ~~测试断言的真实口径~~ | **已解决**：`tests/common.ts` 增加了运行时计数器（`finish()` 打印 `assertions: N`），本次实测 **2060 条**，四个文档的旧口径已统一改过来 |
| 12 | **手机里实际运行的那份产物是否与当前源码一致** | 本文只做静态阅读，未构建、未比对 `app2/www/js/app.js` 与已发 APK；所有「有」都是源码级结论 |

**B. 竞品侧（照抄原资料的待核标记）**

| # | 待核项 | 出处 |
|---|---|---|
| 13 | PixelOver 的**调色板文件扩展名**（`.gpl/.pal/.ase`？） | `PixelOver-功能清单.md` §5 |
| 14 | PixelOver 的**撤销步数上限** | `PixelOver-功能清单.md` §1 |
| 15 | PixelOver 的**画布尺寸上限数值** | `PixelOver-功能清单.md` §1 |
| 16 | PixelOver 的 **iso 网格模式**（多来源提及但未在官方页面找到原文） | `PixelOver-功能清单.md` §1 |
| 17 | PixelOver 的**色阶 levels / 颜色替换** | `PixelOver-功能清单.md` §5（S8 未找到原文） |
| 18 | PixelOver 的**镜像/对称绘制、颜色替换、涂抹/模糊、渐变工具、参考图专用面板** | `PixelOver-功能清单.md` §3（S17/S14 未找到官方依据） |
| 19 | PixelOver 的**权重笔刷大小 / 衰减曲线**等蒙皮细节 | `PixelOver-功能清单.md` §8.3 |
| 20 | PixelOver 的 **3D Image 细节**（shaded/unshaded、billboard） | `PixelOver-功能清单.md` §13 第 3 条（本文 §5.1 已注明） |
| 21 | PixelOver 的**代码量 / 测试规模** | 资料未给 |
| 22 | PixelOver 的 **itch.io 商店页原文**（价格/标签/描述） | `PixelOver-功能清单.md` 文末「未能核实/未能访问」 |
| 23 | Pixel Composer **约 70 个节点官方文档未给说明**（`Emboss`、`Hough Transform`、`Line Match`、`Linearize`、`Symmetric Nn`、`Shape Ellipse/Half/Rectangle`、`Dotted`、`Kisrhombille`、`Hilbert`、`Blend Height`、`Gmroom`、`Image Mp4`、`Pb Fx Bevel/Extrude/Highlight/Shine`、PCX 函数节点等） | `PixelComposer-功能清单.md` 附录 B 第 2 条 |
| 24 | Pixel Composer 与 **Blender / Photoshop 的互操作** | `PixelComposer-功能清单.md` 附录 B 第 3 条（官方资料未找到依据） |
| 25 | Pixel Composer 的 **PCX 是否支持用户自定义函数** | `PixelComposer-功能清单.md` 附录 B 第 4 条（官方未给语法，**不能断定**） |
| 26 | Pixel Composer 的**测试规模 / 代码量** | 资料未给 |
| 27 | Steam **appid 口径冲突**：`Pixel Composer-功能清单.md` §0 写 **2299510**，`PixelOver-功能清单.md` §0 写 **1964480** | 两份资料互相矛盾 → 标待核，本文不写具体 appid |
| 28 | Pixel Composer 的**剪贴板能力**（有无独立的剪贴板节点/通道） | 资料未给独立章节 |
| 29 | 两家竞品的**无障碍 / 安全区适配 / 震动反馈** | 桌面软件，资料未涉及 |
| 30 | **多遮罩并存时返回键会不会关错层** | `main.tsx` 用 `querySelector(".dlg-mask, .panel-mask, .fly-mask")` 取的是 **DOM 顺序第一个**而非层级最高的遮罩，且 `.fly-mask` 在 CSS 里没有定义（死选择器）→ 需实机验证 |
| 31 | **连击窗口 480ms 硬编码与 `gesture.doubleTapMs` 脱节在实机上是否可感** | 连击判定写死 `< 480`，设置项只被双指双击读取 |

> 说明：上表 A 组是**本项目侧**的待核，B 组是**竞品资料侧**的待核；两组的处理方式一致——**不补全、不推测**。
