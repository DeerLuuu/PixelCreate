# PixelCraft API 接口文档

> 版本：随源码更新 · 覆盖 `src/` 下全部对外导出
> 约定：坐标为文档像素（整数，左上为原点）；`RGBA = [r, g, b, a]`（0–255）；`Rect = { x, y, w, h }`（文档像素，含左上、宽高）
> 引擎层（`engine/` `app/` `tools/`）**不依赖 DOM**，可在 Node 中直接测试；`io/` 里的 `.pxc` / `.aseprite` / zlib 同样是纯逻辑，`render/` `ui/` 与 `io/` 的其余部分需要浏览器环境

---

## 目录

1. [基础类型 `engine/types.ts`](#1-基础类型)
2. [文档模型 `engine/doc.ts`](#2-文档模型)
3. [像素元胞 `engine/cel.ts`](#3-像素元胞)
4. [绘制算法 `engine/paint.ts`](#4-绘制算法)
5. [形状与特效](#5-形状与特效)
6. [结构操作 `engine/ops.ts`](#6-结构操作)
6a. [重采样 `engine/resample.ts`](#6a-重采样-engineresamplets高级缩放的引擎)
7. [撤销栈 `engine/history.ts`](#7-撤销栈)
8. [颜色与调整](#8-颜色与调整)
8b. [颜色分析 `engine/color-analysis.ts`](#8b-颜色分析)
9. [工具注册表与笔迹 `tools/`](#9-工具注册表与笔迹)
10. [选区与变换 `tools/select.ts`](#10-选区与变换)
11. [应用层 `app/session.ts`](#11-应用层-session)
12. [设置注册表 `app/settings.ts`](#12-设置注册表)
13. [引导注册表 `app/guide.ts`](#13-引导注册表)
14. [播放模式 `app/playback.ts`](#14-播放模式)
15. [渲染 `render/`](#15-渲染)
15b. [服务层 `servers/`（RenderServer / ViewportServer）](#15b-服务层-serversrenderserver--viewportserver)
15c. [输入服务 `servers/input.ts`（手势策略与算术）](#15c-输入服务-srcserversinputts手势策略与算术)
15c2. [手势状态机 `servers/gesture.ts`（轻点序列）](#15c2-手势状态机-srcserversgesturets轻点序列)
15c3. [手势控制器 `servers/gesture.ts`（指针事件入口）](#15c3-手势控制器-srcserversgesturets指针事件入口)
16. [IO `io/`](#16-io)
17. [UI 层与事件契约 `ui/`](#17-ui-层与事件契约)
18. [多画布空间 / 新工具与特效（1.0.7.11 追加）](#18-多画布空间--新工具与特效)
19. [扩展指南](#19-扩展指南)
20. [UI 控件库 `ui/kit/`](#20-ui-控件库-uikit)
21. [AI 文档文本化 `app/ai-doc.ts`](#21-ai-文档文本化-appai-docts)
22. [AI 工具表 `app/ai-tools.ts`](#22-ai-工具表-appai-toolsts)
23. [AI 回合事务 `app/ai-turn.ts` 与 Session 门面](#23-ai-回合事务-appai-turnts-与-session-门面)
24. [AI 本地工具服务（C3）](#24-ai-本地工具服务c3)
25. [MCP 入口 `toolchain/pc-mcp.mjs` 与电脑侧壳 `toolchain/pc-shell.mjs`](#25-mcp-入口-toolchainpc-mcpmjs-与电脑侧壳-toolchainpc-shellmjs)
26. [应用内助手 `app/ai-chat.ts` + `ui/AiPanel.tsx`](#26-应用内助手-appai-chatts--uiaipaneltsx)

---

## 1. 基础类型

`src/engine/types.ts`

```ts
type RGBA = [number, number, number, number];          // 0..255，a=0 表示透明
interface Rect { x: number; y: number; w: number; h: number }

type BlendMode = "normal" | "multiply" | "screen" | "overlay" | "darken" | "lighten"
  | "dodge" | "burn" | "hardlight" | "softlight" | "difference" | "exclusion";
const BLEND_MODES: BlendMode[];

function clamp(v: number, a: number, b: number): number;
function uid(): string;                                 // 帧/图层 id
```

---

## 2. 文档模型

`src/engine/doc.ts`

```ts
class Sel {
  readonly w: number; readonly h: number;
  mask: Uint8Array;          // w*h，1 = 选中
  ver: number;               // 掩码版本号：视图靠它判断染色缓存是否失效

  get(x, y): number;
  set(x, y, v): void;        // 自动 ver++
  hasAny(): boolean;
  clear(): void;             // ver++
  fillAll(): void;           // ver++
  clone(): Sel;
  bounds(): Rect | null;
  bump(): void;              // 直接写 mask 后手动调用
}

interface LayerMeta { id: string; name: string; visible: boolean; locked: boolean; opacity: number; blend: BlendMode;
                     ref?: string | null;      // 引用层：源画布 id
                     refLayer?: string | null } // 引用层绑定源画布的哪个图层（id；null = 整张合成）
interface FrameMeta { id: string; durationMs: number }

class Doc {
  w: number; h: number; name: string;              // 尺寸上限 1024
  layers: LayerMeta[];
  frames: FrameMeta[];
  cels: Map<string, Cel>;                          // key = "li:fi"
  bg: RGBA | null;                                 // null = 透明棋盘格
  palette: RGBA[];
  sel: Sel | null;

  key(li: number, fi: number): string;
  celAt(li: number, fi: number): Cel | undefined;
  ensureCel(li: number, fi: number): Cel;          // 不存在则创建
  selectionActive(): boolean;
  selAt(x: number, y: number): number;
}
```

> `Sel.ver` 是增量渲染的关键：视图只在版本号变化时重建选区染色图（笔迹期间不变 → 不重建）。

---

## 3. 像素元胞

`src/engine/cel.ts`

```ts
class Cel {
  readonly w: number; readonly h: number;
  data: Uint8ClampedArray;                 // RGBA，长度 w*h*4

  idx(x: number, y: number): number;       // 像素 (x,y) 的字节偏移
  inBounds(x: number, y: number): boolean;
  clone(): Cel;
  hasAnyOpaque(): boolean;
  clear(): void;
}
```

---

## 4. 绘制算法

`src/engine/paint.ts`

```ts
type MaskFn = (x: number, y: number) => boolean;      // 选区遮罩

paintAt(cel, x, y, c: RGBA, mask?): boolean;          // 画一点（受遮罩限制）
eraseAt(cel, x, y, mask?): boolean;                   // 擦一点

lineCells(x0, y0, x1, y1, fn): void;                  // Bresenham，逐点回调
polygonCells(w, h, pts, fn): void;                    // 闭合多边形扫描线填充（even-odd，自动闭合）
fillPolygon(cel, w, h, pts, color, mask?, ax?, wrap?): Rect | null
                                                      // 扫描线 + 对称镜像 + 选区遮罩，返回改动 bbox（null = 没画到）

interface FillOpts { tolerance?: number; gaps?: number; wrapX?: boolean; wrapY?: boolean }
                                                     // 逐通道容差 / 缝隙闭合 / 平铺环绕
buildBarrier(cel, sx, sy, opts?, mask?): Uint8Array | null   // 填充不能跨越的屏障（含闭运算封缝）
floodCells(cel, sx, sy, barrier, wrapX?, wrapY?): [number,number][]  // 4 连通区域
floodFill(cel, sx, sy, color, mask?, opts?): void;    // 连续区域填充（支持容差/缝隙/环绕）
floodErase(cel, sx, sy, mask?, opts?): void;
globalFill(cel, sx, sy, color, mask?, opts?): void;   // 整层同色替换
globalErase(cel, sx, sy, mask?, opts?): void;
splinePoints(pts, samples?): [number,number][]        // Catmull-Rom 采样（曲线工具）
rotateDocContent(doc, dir?)                           // 旋转整幅画布 90°（cel + 选区，宽高互换）

interface BrushStamp { size: number; cells: [number,number][]; outline: [number,number][] }
brushStamp(size: number, shape?: BrushShape): BrushStamp;  // 圆笔尖/方笔尖（带缓存）
// 锚点口径（两种形状**必须同心**，`tests/render.test.ts` 的 brush.anchor.* 钉住）：
//   奇数尺寸 = 以指针那一个像素为中心（偏移 ±(n-1)/2）
//   偶数尺寸 = 以指针所在的"四像素交点"为中心（偏移 [-n/2, n/2-1]）
// 早先方笔尖用的是 -floor((n-1)/2)，奇数尺寸看不出来、**偶数尺寸整块偏 1 像素**。
```

---

## 4b. 对称数学

`src/engine/symmetry.ts` —— 笔迹与选区共用的镜像计算（纯函数）。

```ts
interface SymAxis { on: boolean; four: boolean; ox: number; oy: number; angDeg: number }

mirrorCells(x, y, w, h, ax): Array<[number, number]>   // 一个格子映射到的所有格子（含自身）
mirrorMaskInPlace(mask, w, h, ax): boolean             // 把选区的镜像副本并回掩码，返回是否有新增
```

## 5. 形状与特效

`src/engine/shape.ts`

```ts
ellipseOutline(x0, y0, x1, y1, fn: (x, y) => void): void;         // Zingl 光栅化，Aseprite 1:1
ellipseFill(x0, y0, x1, y1, fn: (x, y, right) => void): void;
```

`src/engine/effects.ts`

```ts
outlineCel(d, w, h, width: number, color: RGBA): void;            // 外描边
invertCel(d): void;                                               // RGB 取反（保留透明）
desaturateCel(d): void;                                           // 灰度
dropShadowCel(d, w, h, dx, dy, color, keepOriginal = true): void; // 投影
outerGlowCel(d, w, h, R, color): void;                            // 外发光
```

---

## 6. 结构操作

`src/engine/ops.ts` —— 全部直接改 `doc`，撤销由调用方（`Session.struct`）负责。

```ts
addLayer(doc, index, name?): void
duplicateLayer(doc, li): void
removeLayer(doc, li): void
moveLayer(doc, from, to): void
mergeLayerDown(doc, li, blendComposite): void

addFrame(doc, index): void
duplicateFrame(doc, fi): void
removeFrame(doc, fi): void          // 至少保留 1 帧
moveFrame(doc, from, to): void      // 按帧对象身份重映射所有 cel 键

resizeDocCanvas(doc, w2, h2, ox, oy): void   // 改画布尺寸，内容按偏移保留
scaleDocSprite(doc, w2, h2, algo?, cleanTransparent?): void
                                             // 整体缩放；默认 nearest（行为与老版逐像素一致），
                                             // 采样实现已搬到 engine/resample.ts
contentBounds(doc): Rect | null              // 所有内容的包围盒（智能裁剪用）
```

### 6a. 重采样 `engine/resample.ts`（高级缩放的引擎）

纯函数、无 DOM，可在 node 里直接测。统一入口返回**新分配**的 RGBA 缓冲区（长度 `dw*dh*4`），
输入永不被修改：

```ts
type ResampleAlgo = "nearest" | "bilinear" | "bicubic" | "area" | "scale2x" | "scale3x";

interface AlgoMeta {
  id: ResampleAlgo;
  pixelArt: boolean;             // 像素画专用（scale2x / scale3x）
  onlyExactFactor: number | null; // 2 / 3；null = 任意比例都行
  nameKey: string;               // i18n 键（UI 直接 t(meta.nameKey)，不硬编码分支）
  descKey: string;
}
SCALE_ALGOS: readonly AlgoMeta[]              // 6 条元数据，供 UI 生成选项

interface ResampleOpts { cleanTransparent?: boolean }   // alpha===0 时把 RGB 清零
MAX_SIZE: 1024                                // 与全项目尺寸上限一致

resamplePixels(src, sw, sh, dw, dh, algo?: ResampleAlgo, opts?): Uint8ClampedArray
resampleRegion(src, sw, sh, sx, sy, rw, rh, dw, dh, algo?, opts?): Uint8ClampedArray
                                             // 只重采样一块矩形（选区缩放用）

algoSupported(algo, sw, sh, dw, dh): boolean // scale2x/scale3x 只接受整数 2×/3×
effectiveAlgo(algo, sw, sh, dw, dh): ResampleAlgo   // 不支持时给出真正会用的算法（nearest）
scaleFactor(sw, sh, dw, dh): { fx: number; fy: number }
```

要点：

- **颜色一律在预乘 alpha 空间插值**（`bilinear` / `bicubic` / `area`）。直接平均 RGB 会把
  透明像素的残色也算进去，透明边缘发黑/发彩；`cleanTransparent` 是额外的兜底。
- `nearest` 用 `floor(i*sn/dn)` 映射，与老版 `scaleDocSprite` 逐像素一致；
- `bicubic` 是 Catmull-Rom 样条，权重按轴归一化（纯色下逐字节恒等），越界坐标**钳到边缘**而不是补零；
- `area` 按源/目标像素的重叠长度加权（缩小＝真正的面积平均），权重放在连续区间表里，
  缩小 1024 倍也不会溢出、每像素零分配；
- `scale2x` / `scale3x` 是像素画放大算法（`scale3x.c` 的 C 实现直译）：
  `scale2x` 用 Mazzoleni 的 Scale2x 四条件式（`E0 = D==B && B!=F && D!=H ? D : E` …，
  与 Eric 的 EPX 等价）：**必须先判"两个邻居相等"才把那一格改成邻居**，否则保留自己；
  孤立像素（上下左右四色各不相同）因此原样长成 2×2 块，1 像素宽的线也不会长毛刺。
  `scale3x` 先判外层 `B!=H && D!=F`，再逐格判（`E1/E3/E5/E7` 里的 `E!=<对角>` 项不能漏）。
  两者都只做整数比较、不做任何颜色混合，画布外邻居按边缘钳制；
  比例不匹配时 `resamplePixels` **安全降级到 nearest**，UI 用 `algoSupported` / `effectiveAlgo` 提前提示。

---

## 6b. 手势映射 `app/gestures.ts`

```ts
type GestureId = "doubleTapMargin" | "doubleTapCanvas" | "twoFingerDoubleTap"
  | "twoFingerLongPress" | "threeFingerLongPress" | "tripleTap" | "fourFinger" | "longPress";
type GestureActionId = "none" | "undo" | "redo" | "zoomIn" | "zoomOut" | "fitView"
  | "togglePlay" | "toggleOnion" | "toggleGrid" | "toggleSymmetry"
  | "toggleTimeline" | "framePreview" | "nextFrame" | "prevFrame"
  | "nextLayer" | "prevLayer"
  | "openPalette" | "pickColor";

const GESTURE_ACTIONS: Array<{ id: GestureActionId; label: string }>;
const GESTURES: GestureDef[];            // id / label / desc / defaultAction / actions / field
gesturePath(id): string                  // "gesture.tripleTap"
isActionAllowed(id, action): boolean     // 校验从磁盘读回的值
```

设置面板由 `GESTURES` 自动生成（每个手势一个下拉），`Session.runGestureAction()` 执行；UI 级动作（时间轴 / 帧预览 / 调色板）通过 `pc-gesture` 事件交给 React 壳。

**多指长按**（`twoFingerLongPress` / `threeFingerLongPress`，默认都是 `nextLayer`）：2 或 3 指落下后保持不动
`prefs.longPressMs` 即触发（`View.armHold(n, action, tag)`）；任一手指位移超过 `max(8, prefs.fourFingerPx)`、
指距变化、抬指或第 4 指落下都会取消；触发后本次抬指不再计作双击/双指双击。
⚠️ 部分机型（vivo/OPPO）把「双指长按」映射成系统「识屏」，系统会先抢走手势并发 `pointercancel`——
`View.onCancel` 会用 `Session.hintOnce()` 一次性提示用户去系统设置里关闭，或改用三指长按。
`Session.cycleLayer(±1)` 循环切换图层（优先跳过隐藏层），`Session.setLayer()` 会调用 `View.flashLayer(li)`
让切到的图层在画布上闪一下（`drawFlash()` 画在叠加层，不重合成）。

## 6c. 色彩明暗 `src/engine/shading.ts`

调色板生成器，移植自 Aseprite 脚本 [Color Shading v5.0](https://github.com/GerryLCDF/Aseprite-Color-Shading-v5.0)
（v1–2 Dominick John + David Capello、v3 yashar98、v3.1 Daeyangae、v4 Manuel Hoelzl）。纯函数，无 DOM / 无 Session。

```ts
interface ShadingParams { slots; intensity; peak; sway; lowTemp; highTemp }   // 默认 7 / 40 / 60 / 60 / 215 / 50
const SHADING_DEFAULTS: ShadingParams;      // ＝ Lua 的 default_*（改这里要同步文档与 i18n 提示）
const SHADING_RANGES;                       // intensity 1..200、peak 1..100、sway 0..100、temp 0..359.99
const SHADING_SLOTS_MIN = 3; SHADING_SLOTS_MAX = 25;
const SHADING_ROWS = ["shade","light","sat","mix","nuance","hue"] as const;   // 界面顺序，标签在 i18n 的 sh.rows.*
normalizeSlots(n): number                   // 夹到 3..25 并**强制奇数**（Lua 在 UI 里把偶数 +1）
normalizeParams(p): ShadingParams           // 夹范围 + 色相取模；UI 每次改动都过一遍
shadingRamps(base, other, params): ShadingRamps        // 六条色阶，每条 slots 个 RGBA
shadingHarmonics(base): ShadingHarmonics               // 互补 / 三角 / 四角
flatRamps(ramps, rows?, dedupe = true): RGBA[]         // 摊平（「加入调色板」用）
```

`Ramps` 的六条行（`i` 为 1..slots，`mid = (slots+1)/2`）：

| 行 | 算法 | 说明 |
|---|---|---|
| `shade` | `shiftShading(shiftSat(shiftLight(base, ±peak/100·f), intensity/100·f), temp, sway/100·f)` | 明度 + 饱和度 + 温度色一起上 |
| `light` | `shiftLight(base, ±0.4·f)` | 只动明度 |
| `sat` | `shiftSat(base, ±0.75·f)` | 只动饱和度（暗端去饱和、亮端加饱和） |
| `mix` | `mix(base, other, i/(slots+1))` | 基色 → 另一基色的过渡（与色相无关） |
| `nuance` | `shiftHue(base, (mid−i)/(slots+1)·2/(slots+1))` | 极小色相偏移（近似色） |
| `hue` | `shiftHue(base, i/(slots+1))` | 色相环等距推进 |

其中 `f = ((slots−1)/2 − i + 1)/((slots−1)/2)`；**暗半侧**（`i < mid`）`f` 取正、符号 `neg = −1`、温度取
`lowTemp`；**亮半侧**（`i > mid`）`f` 取反成正、`neg = +1`、温度取 `highTemp`；正中间那格（奇数 slots）
**逐位等于基色本身**，是整套配色的锚点。

两条与 Lua 的刻意差异，都写进了实现注释，别按 Lua 改回去：
1. **alpha 一路带着走**（Lua 的 `mixColors` 只混 RGB、alpha 被重置成 255）——PixelCraft 的颜色可以是半透明的，
   `mix` 行按比例混 alpha，其余各行保留基色 alpha；
2. `slots` 的「夹范围 + 强制奇数」放进纯函数，而不是只放在界面的 `onchange` 里（测试与调用方都受益）。

`ShadingPane`（`src/ui/modals.tsx`，「颜色高级模式」的明暗页）与调色板的接线：

| 位置 | 手势 / 按钮 | 行为 |
|---|---|---|
| 基色两个色块 | 轻点 | `SESSION.awaitColorPick()` + `onOpenPalette()`（App 传 `setPanel("palette")`）→ 打开调色板挑色，选中的色成为新基色 / 新「混色」端色；App 在 `pc-color-picked` 时自动收起调色板 |
| 基色行 | 「取当前」 | 直接读当前前景 / 背景色当基色 |
| 生成色块 | 轻点 | 设为前景色 |
| 生成色块 | 长按 | **把这一格加进当前色卡**（`paletteMerge([c])`，去重、一条可撤销历史） |
| 生成色块 | 电脑右键 | 设为背景色（对应 Aseprite 的右键；触屏没有右键，背景色走基色行） |
| 每条色阶行 | 末尾「+」 | 整行加入当前色卡（`paletteMerge`） |
| 每条色阶行 | 末尾「保存」 | 整行**存成一张新色卡**（`SESSION.savePalettePresetOf()`，只往 `myPalettes` 加一条，不动用户眼下的色板） |
| 弹窗底部 | 「加入调色板」 | 六条色阶一起 `paletteMerge(flatRamps(ramps))` |

入口：调色板面板的动作行与主菜单（`openShading()` 派发 `pc-shading`，App 侧收面板再开弹窗，同 `pc-color-analysis`）。

## 6d. 等距图形 `src/engine/iso.ts`

2:1 像素几何的**基础等距体生成器**（≈26.57°，像素画惯例；**不是**真等距 30°）：
一格顶面 = `T×T/2` 像素的菱形，**1 单位高度 = `T/2` 像素**，所以 **1×1×1 立方体正好是 `T×T` 像素**。

```
sx = (x - y) * (T/2)        // 每 +1 格 x：屏幕 (+T/2, +T/4)
sy = (x + y) * (T/4) - z * (T/2)
```

```ts
const ISO_TILES = [4, 8, 16, 32];  ISO_TILE_DEFAULT = 16;   // 每格像素宽（T/4 保证整数像素）
const ISO_SHAPES = ["box","steps","wedge","cylinder","pyramid","frame"];
const ISO_MAX_VOXELS = 262144;                            // 误填 999 的护城河

interface Voxels { w; d; h; data: Uint8Array }            // 1 = 实心，下标 (z*d + y)*w + x
isoShapeVoxels(p: Partial<IsoShapeParams>): Voxels        // 六个形状，各参数化（级数 / 坡向 / 半径 / 空心 / 平顶 / 壁厚）
normalizeShapeParams(p): IsoShapeParams                   // 夹取（w/d/h ≤ 64、半径、壁厚、体素上限）
isoFaceColours(base, shade?): { top; right; left }        // 单色三档：复用 engine/shading.ts 的明暗行（默认 sway 0）
isoDiamondRows(tile) / isoHexRows(tile): number[]         // 行宽模板（顶面菱形 / 立方体轮廓），黄金值来源
isoGroundCorners(tile, w, d): { top; right; bottom; left }  // 足迹四角（相对**地面原点**的局部像素）
isoHeightHandle(tile, w, d, h): Pt                        // 顶面中心（高度抓手）
isoDeltaToCells(tile, ddx, ddy): { a; b }                 // 屏幕增量拆成两条等距轴走了几格
isoOnLattice(tile, x, y): boolean                         // 这个落点是不是正好在栅格**节点**上
isoSnapOrigin(tile, x, y): Pt                             // 吸附到最近的栅格节点
isoPlaceOrigin(tile, box, docW, docH, want): Pt           // 吸附 + 越界收紧（只沿等距轴挪格，挪完仍在栅格上）
isoRender(v, look: IsoLook): IsoRenderResult              // { px, w, h, originAt, voxels, pixels }
isoRenderShape(shape, base, look?): IsoRenderResult       // 便捷入口
```

**图块档位**（`ISO_TILES`，1×1×1 立方体正好 `T×T` 像素）：

| T | 顶面菱形 | 每单位高度 | 立方体外框 | 适用 |
|---|---|---|---|---|
| 4 | 4×2 | 2 | 4×4 px | 图标 / 迷你物件（手感靠放大画布，抓手会自动收窄半径） |
| 8 | 8×4 | 4 | 8×8 px | 小物件 |
| 16（默认） | 16×8 | 8 | 16×16 px | 通用 |
| 32 | 32×16 | 16 | 32×32 px | 大件、建筑 |

- **行宽模板**（T=16 立方体，自上而下 16 行）：`2,6,10,14,16×8,14,10,6,2`，
  顶面菱形是其中 `2,6,10,14,14,10,6,2`（面积 `T²/4`），六边形总面积 `3T²/4`；
  **相邻格的 stamp 会重叠**（等距投影本来多对一），靠画家顺序（`x+y` 递增、同深度 `z` 递增）解决，
  每个体素只画**没被遮挡**的面（顶面：上方空；右面：`+x` 空；左面：`+y` 空）。
- `originAt` 是**格 `(0,0)` 顶面菱形的顶点**（stamp 的对称轴 `c = T/2` 处；投影点 `(0,0,0)` 落在缓冲里的位置）：
  换形状 / 改尺寸时缓冲大小会变，只有拿它当锚点，画布上的预览与抓手才不会跳
  （圆柱这类 `(0,0)` 不在足迹里的形状也有稳定锚点）。
  **不要改回「stamp 左上角」**：stamp 从 `-T/2` 起画，左上角比顶点偏左 `T/2`，
  早先拿它当锚点，栅格 / 足迹虚线 / 抓手就整体比形状偏左半格 —— 真机表现就是「生成的图形没和网格对齐」。
- **栅格节点**（`isoOnLattice` / `isoSnapOrigin`）：节点 = 两条等距轴各走整数格的点
  `i·(T/2, T/4) + j·(-T/2, T/4)`，即 x 是 `T/2` 的整数倍、y 是 `T/4` 的整数倍**且两者同奇偶**。
  分别对 x / y 取整会把 `(0, T/4)` 这种「格子边缘中点」当成合法落点（形状横跨两行网格线；
  两次生成的图形也会互相错半格）。`isoSnapOrigin` 在 ±1 格候选里按像素距离取最近的合法节点。
- `isoPlaceOrigin` 用于进模式时的落点：先吸附，再保证整块缓冲落进画布；挪动只能沿等距轴
  （`+x` 一格 = `(+T/2, +T/4)`，`+y` 一格 = `(-T/2, +T/4)`），所以「往右挪一点」必然带着往下一点 ——
  早先按 x / y 各自加减 `T/2` / `T/4`，挪完就离开了栅格。形状比画布大时退到「左上不越界」的最近节点。
- `IsoLook` = `{ tile, faces{top,right,left}, shadow: "off"|"contact", shadowColor, outline, outlineColor }`；
  接触阴影 = 足迹上每个有内容的格画一块**偏移 (T/8,T/16)** 的顶面菱形，物体压在上面只露出下缘一条暗边。

**会话侧**（`src/app/session.ts`）：`isoOn`（模式）/ `isoOrigin`（画布像素里的地面原点）/
`isoLast`（上次生成的矩形）；`isoShape()` / `isoLook()` 把参数解析成引擎口径；
`setIsoPref(patch)`（夹取 + 存 `prefs.iso` + 重画覆盖层）、`enterIso()`（结束变换会话、清选区、
把外接框夹进画布居中）、`exitIso()`、`setIsoOrigin(x, y, snap)`、`isoStats()`（读数：像素尺寸 / 体素 /
是否越界）、`isoGenerate("layer" | "new")`。
**历史**：`layer` 用 `pushPixels` 一条像素差分；`new` 用 `struct()`（整档快照）把「新建图层 + 写像素」
合成**一条** undo。全在画布外时直接拒绝（`reason: "outside"`），锁定图层走 `paintBlockedNote()`。

**视图侧**（`src/render/view.ts`）：`isoPreview()`（渲染 + 按 `originAt` 摆位 + 参数签名缓存离屏画布）、
`isoHandles()`（四角 + 高度，测试直接读它）、`isoHitAt()`（半径随抓手密度收窄 `max(8, min(pc?13:24, 最近两点/2))`，
**高度抓手优先**）、`isoDragTo()`（屏幕增量 → 格数：`top` 反向长、`right` 改 W、`left` 改 D、
`bottom` 同时改 W/D、`height` 按 `T/2` 改高）、`drawIsoMode()`（2:1 栅格 → 半透明预览 → 足迹虚线 →
抓手 → 尺寸浮标）、`isoCancelDrag()`。模式期间画布手势被接管（按下不落笔迹）。
模式期间 `drawIsoGuide()`（设置里的 30° 等距参考网格）**主动让位不画** —— 30° 与 2:1 不可能重合，
两套网格同时在屏幕上只会让人以为「图形没对齐网格」。

**入口**：魔法球「等距图形」（`fxI("iso", …)`，图标 `i-iso`）+ 主菜单（`SESSION.enterIso()`）；
参数条 `IsoBar`（`src/ui/iso.tsx`）在模式期间常驻，形状 chips / 尺寸 / 图块 / 外观折叠 / 生成 / 完成。
功能图标登记在 `src/ui/feature-icons.ts`（见 §17.5）。

## 7. 撤销栈

`src/engine/history.ts`

```ts
interface PixelChange { li: number; fi: number; before: Uint8ClampedArray | null; after: Uint8ClampedArray }

class History {
  pushPixels(label: string, doc: Doc, changes: PixelChange[]): void;   // 像素级
  pushStruct(label: string, doc: Doc, fn: () => void): void;           // 结构快照（图层/帧/色板）
  record(label: string, step: { apply(): void; unapply(): void }): void; // 标量前后值

  undo(): boolean; redo(): boolean;
  jump(index: number): void;              // 跳到任意历史步（操作记录面板）
  canUndo(): boolean; canRedo(): boolean;
  list(): { labels: string[]; index: number };
  clear(): void; setCap(n: number): void; limit(): number; trimToCap(): void;

  // 工程文件用：导出/重建整个栈
  dump(): HistoryDump;                                  // 无法序列化的步骤会截断更旧的记录
  loadDump(dump: HistoryDump, host: HistoryHost): void;
}

interface HistoryDump { index: number; entries: HistoryDumpEntry[] }
interface HistoryDumpEntry {
  label: string;
  kind: "pixels" | "struct" | "scalar";
  enc?: EncChange[];                                    // 像素增量
  before?: DocSnapshot; after?: DocSnapshot;            // 结构快照
  data?: ScalarData;                                    // 标量载荷（app/history-io.ts）
}
interface HistoryHost { doc: Doc; scalarActions: (d: ScalarData) => { apply(): void; unapply(): void } }
```

> 所有破坏性操作都必须经过这三者之一，才能保证“一步撤销”。

---

## 8. 颜色与调整

`src/engine/color.ts`

```ts
clampByte(v): number
rgba(r, g, b, a = 255): RGBA
cssColor(c: RGBA): string          // "rgba(...)"
chipCss(c: RGBA): string           // 带棋盘底的色块 CSS 背景
hexToRgba(hex): RGBA
rgbaToHex(c): string
blendOver(dst, i, src: RGBA): void // 与已有像素做 source-over 混合
writePixel(data, i, c: RGBA): void
```

`src/engine/adjust.ts`

```ts
interface HslAdj { h: number; s: number; l: number }   // -100..100
rgbToHsl(r, g, b): [number, number, number]
hslToRgb(h, s, l): [number, number, number]
adjustPixel(r, g, b, a, adj): [number, number, number]
```

---

## 8b. 颜色分析

`src/engine/color-analysis.ts`

高级颜色分析器的全部逻辑（纯函数、无 DOM、可单测）：统计、近似色分组、替换、
按颜色选像素、多层压平。面板 `ui/modals.tsx` 的 `AnalysisPane`（「颜色高级模式」的分析页）只做呈现。

**距离口径（全文件唯一一个）**：RGB 空间的等权欧氏距离，比较时用平方值，
容差按 `d = sqrt(dr²+dg²+db²) ≤ tol` 解释；`rgbDistanceSq` 内部再除以 3，
所以**单通道差 v 阶 ≈ 距离 v**（与「魔棒容差 0–255」同一口径）。
选它而不是 ΔE2000 的理由：`Session.paletteSnap` / `remapToPalette` 用的就是同一
套平方 RGB 距离，分析与索引色吸附必须给出同一个"最近的板色"；像素级遍历
（百万像素）也要便宜，L\*a\*b\* 换算贵一个数量级。

```ts
type ColourScope = "all" | "layer" | "selection"

rgbDistanceSq(r0,g0,b0, r1,g1,b1): number     // (dr²+dg²+db²)/3
withinTolerance(a: RGBA, b: RGBA, tol: number): boolean
nearestPalette(r, g, b, palette): RGBA | null // 与 paletteSnap 同判据
colourKey(c: RGBA): number                    // 32 位键（每个通道各 8 位）
hueOf / saturationOf / lightnessOf(r,g,b): number
bucketCount(requested?): number               // 12..24 且为 4 的倍数

// 统计：数量降序（或色相/明度升序，平局按 RGBA 升序）
analyzeColours(data, opts?: {
  palette?: RGBA[], includeClear?: boolean,
  sort?: "count" | "hue" | "light", buckets?: number,
}): ColourAnalysis
sortColourEntries(entries, sort): ColourEntry[]  // 只重排，不重算

// 近似色分组：代表色 = 组内像素最多的颜色（并列取 RGBA 小的），
// 只返回成员 ≥ 2 的组；阈值默认 GROUP_TOLERANCE = 12（约每通道 7 阶）
groupSimilarColours(entries, tol?, maxGroups?): ColourGroup[]

// 替换：容差 / 范围掩码 / 只换不透明像素 / 保留 alpha
replaceColours(data, w, h, from, to, opts?: {
  tolerance?: number, scope?: ColourScope,
  inMask?: (x, y) => boolean, opaqueOnly?: boolean, keepAlpha?: boolean,
}): { changed: number }
selectByColour(mask, data, w, h, from, tol?, opaqueOnly?): number
flattenLayers(w, h, layers: { data, opacity? }[]): Uint8ClampedArray
colourStatsCsv(a: ColourAnalysis, opts?): string
```

`ColourAnalysis` 字段：

| 字段 | 含义 |
|---|---|
| `entries` | 每种颜色：`rgba / count / ratio / ratioOfOpaque`，以及 `palette.exact`（完全同时含 alpha）、`palette.nearest`、`palette.distance`、`nearPalette`（距离 ≤ 12） |
| `totalPixels / opaquePixels / semiPixels / clearPixels` | 总像素 / 不透明 / 半透明 / 全透明 |
| `colourCount / opaqueColours / semiColours` | 用到的颜色数（不透明 + 半透明），全透明不算颜色（`includeClear` 可开） |
| `unusedPalette / usedPaletteCount` | 调色板里没被用到的颜色（按"最近色归属"判定，所以**板色永远优先于更远的非板色**）|
| `histogram { hue, sat, light }` | 各 12/16/20/24 桶的像素数 + `max`；色相只统计饱和度 ≥ 6% 的像素，灰阶计入 `hueNeutral` |
| `entries[].ratio` | 占总像素、`ratioOfOpaque` 占不透明像素 |

**已知边界（刻意不做的）**：`flattenLayers` 只按 source-over + 图层不透明度
叠加，**不模拟混合模式**（正片叠底那套公式归渲染层 `compositor` 所有，不重写
以免两处口径分叉）。所以「画布」范围的统计结果与开了混合模式的画面可能有差异。

---

## 9. 工具注册表与笔迹

`src/tools/registry.ts`

```ts
type ToolId = "pencil" | "eraser" | "bucket" | "picker" | "outline"
  | "line" | "rect" | "rectfill" | "ellipse" | "ellipsefill" | "circle" | "polygon"
  | "select" | "wand" | "lasso";
type BrushShape = "circle" | "square";   // engine/paint.ts 导出

interface ToolDef { id: ToolId; icon: string; drawing: boolean; shape: boolean }
const CORE_TOOLS / SHAPE_TOOLS / SELECT_TOOLS: ToolDef[];
// outline = 轮廓填充：手绘闭合路径，松手后自动填充内部（View.outlineDown/Move/endOutline）
isShapeTool(id) / isSelectTool(id) / isSymTool(id): boolean;

interface BrushState { color: RGBA; size: number; alpha: number; pressure: number }

type SymMode = "off" | "on";
SYM_ANGLES = [0, 45, 90, 135];
nextSym(m) / SYM_CYCLE;
```

`src/tools/stroke.ts` —— 单次手势的笔迹引擎，直接写 cel 数据并跟踪脏矩形。

```ts
type ToolKind = "pencil" | "eraser" | "bucket" | "line" | "rect" | "ellipse" | "circle" | "polygon";

class Stroke {
  constructor(doc, li, fi, kind, brush: BrushState, layerLocked, sym: SymMode,
              shapeSides = 6, fill = true, ox = 0, oy = 0, angDeg = 90, symFour = false, bucketGlobal = false,
              brushShape: BrushShape = "circle", shapeFromCenter = false);
  // 图层锁定时构造抛错 "layer-locked"

  // 可选开关（由 View 从 prefs 设置）
  pixelPerfect = false;                      // 去掉 L 形拐角像素（Aseprite 规则）
  fillTolerance = 0; fillGaps = 0;           // 油漆桶：逐通道容差 / 缝隙闭合
  wrapX = false; wrapY = false;              // 平铺模式：笔迹跨边界环绕补画
  snapColor: ((c: RGBA) => RGBA) | null;     // 索引色：落笔颜色吸附调色板

  startAt(x, y): void;                       // 落笔
  moveTo(x, y, pressure: number): void;      // 移动（形状工具会从头重绘）
  drawPath(pts, smooth): void;               // 折线/曲线：从落笔快照重画整条路径
  takeDirty(): Rect | null;                  // 自上次调用以来改动的区域（增量渲染用）
  commit(history, label): boolean;           // 写入撤销栈，返回是否有实际改动
  cancel(): void;                            // 回滚到落笔前
}
```

**脏矩形语义**：铅笔/橡皮按笔尖单元累积；形状工具把“上一次形状包围盒 ∪ 新包围盒”计入（因为每次重绘都从原始缓冲开始）；油漆桶返回整帧。

---

## 10. 选区与变换

`src/tools/select.ts`

```ts
// 独立函数
wandSelect(doc, li, fi, x, y, tol): void
growSelection(doc, px): void
shrinkSelection(doc, px): void
outlineSelected(doc, history, li, fi, color): void
lassoFill(doc, pts: Array<[number, number]>): void

interface MoveState { /* 抓取前的像素与掩码快照 */ }
beginMove(doc, li, fi): MoveState | null
xformFloating(doc, st, angle, sx, sy, buf, cx, cy): Array<...>   // 仿射变换
floatDropInto(doc, li, fi, st, x, y, history?, label?): boolean  // 落进另一张画布
pasteRaw(doc, li, fi, clip, at?): boolean                        // 落笔 + 设选区，不记历史

// 对象形式（推荐）
const selOps = {
  setRect(doc, x0, y0, x1, y1), selectAll(doc), invert(doc), clear(doc),
  fill(doc, history, li, fi, color), eraseSelected(doc, history, li, fi),
  copy(doc, li, fi): Cel | null, cut(doc, history, li, fi): Cel | null,
  paste(doc, history, li, fi, clip: Cel, at?), flip(doc, history, li, fi, horizontal),
  move(doc, li, fi, dx, dy, st), floatCut(doc, li, fi, st), floatPaste(doc, li, fi, st, dx, dy),
  restore(doc, li, fi, st), shiftMask(doc, st, dx, dy),
};
```

`floatDropInto` 是**跨画布移动**的落笔：把浮动内容（`st.content`）原样写进另一个文档，
与 `selOps.paste` 的区别是负原点**按画布边缘裁剪**（`paste` 会把整块平移到边上），
并且是直接写 RGBA（不透明混合），与画布内浮动落笔一致。写入后把目标文档的选区设为落下的矩形，
并（给了 `history` 时）记录一条 `sel.move`；目标图层锁定或没有任何像素落进画布时返回 `false`。

> 任何改写 `mask` 的操作都要调用 `doc.sel.bump()`（或走 `set/clear/fillAll`），否则选区染色图不会刷新。


---

## 10b. 选区自由变换的几何 `src/tools/xform.ts`

Aseprite 那套「移动 + 缩放 + 旋转 + 斜切」的**纯函数层**（无 DOM、无 Session，`tests/xform.test.ts` 直接跑）。
视图层的状态机在 `src/render/view.ts`（见 §15.4），这里只放几何与解算。

**坐标口径（唯一约定，改之前先读）**：本模块的坐标是**外框口径（edge space）** ——
`w×h` 的内容占 `[0, w] × [0, h]`，像素 `i` 是 `[i, i+1)` 那一格（中心在 `i + 0.5`），
内容框就是 `contentBox(w, h)`（**不是** `indexBox(w, h)` 的 `0..w-1`）。
屏幕换算只有一条：**位置 `p` → `p·zoom + ox`**（`screenFrameOf()`）。

为什么是外框：栅格化器 `xformAffineFloating()` 采样的是「目标像素中心 `px + 0.5` 逆映射后 `floor`」，
也就是同一套外框口径；选中框（蚂蚁线）画的是 `b.x·z + ox .. (b.x+b.w)·z + ox`，
于是**恒等变换下变换框与选中框逐像素重合**、8 个锚点正落在选中框的角与边中点上。

> `warp.ts`（§18.11）用的是**另一套**：那里控制点代表「某个像素挪到哪」，下标 `i` 就是像素 `i` 的
> **中心**（画在 `(i+0.5)·z + ox`）。两者不要混：变换框是**区域边界**，网格点是**像素位置**。

`screenFrameOf()` / `View.xfScreenFrame()` / `View.xfPivotScreen()` / `screenAnchors()` / 抓手绘制
全部走这一条，所以「枢轴预设的左上角」＝「框的左上角」＝「角抓手的位置」，
而且**进入会话的前后框完全不动**（会话内外的口径相同），抓手不会在按下的瞬间跳位。

### 10b.1 锚点与命中

```ts
type AnchorId = "tl" | "tr" | "br" | "bl" | "t" | "b" | "l" | "r";
const ANCHORS: AnchorId[];                  // 上面这个顺序（角在前，边中点在后）
isCorner(id): boolean; axisOf(id): "x" | "y" | "xy";   // 边中点只改一个轴
indexBox(w, h): XfBox;                     // 像素下标框 `0..w-1`（warp / 测试口径）
contentBox(w, h): XfBox;                   // **内容外框** `0..w`（本模块的坐标口径，见上）
anchorPoint(box, id): Pt;                  // 锚点在**框上**的位置
scaleAnchor(box, id): Pt;                  // 缩放的**不动点**＝对角那个锚点（tl↔br、tr↔bl、t↔b、l↔r）
screenAnchors(frame): Pt[];                // 8 个锚点的屏幕坐标

interface ScreenFrame { corners: [Pt, Pt, Pt, Pt]; angle: number; spanX: number; spanY: number }
screenFrameOf(m: Mat3, w, h, zoom, ox, oy): ScreenFrame;   // 变换后的**外框**四角 → 屏幕

const PC_HIT = { inner: 22, outer: 34 };   // PC：两层同心圈的命中半径（px，**额外**手段，见下）
const TOUCH_HIT = { inner: 38, outer: 38 }; // 触屏基础半径（还会被 touchHitRadius 自动收窄）
const TOUCH_HIT_FLOOR = 24;                 // 收窄的下限（再小就按不准了）

// —— 贴着选区框的**固定图标**（屏幕像素常量，不随画布 zoom 变）——
const GRAB_OFF_SCALE = 6;         // 缩放抓手离框 6px（规格 ≤8px）：4 角 + 4 边中点
const GRAB_OFF_OUTER = 30;        // 旋转（角外侧沿**对角线**）/ 斜切（边中点外侧沿**法线**）30px（规格 28–34）
const GRAB_OFF_OUTER_SMALL = 20;  // 小选区收窄到 20px：**旋转 / 斜切仍在**，只是更贴框
const GRAB_SMALL_SPAN = 64;       // 「小选区」的短边阈值（屏幕 px）

grabOffsets(minSpan): { scale, rotate, skew };             // 按短边给出这一屏的外移距离
transformGrabs(frame, off?): Array<{ kind, anchor?, x, y }>; // **16 个**固定图标（两平台同一套）
minGrabGap(grabs, sameKind?): number;                      // 两两圆心距的最小值
touchHitRadius(grabs, base = 38) = clamp(min(38, 同类最小圆心距 / 2), 24, 38);
const GRAB_REACH = { scale: 1, rotate: 0.85, skew: 0.75 }; // 语义优先级（＝等效半径倍率）
const GRAB_ORDER = ["scale", "rotate", "skew"];            // 高 → 低

ringHitAt(frame, pt, radii): { kind: XfKind; anchor?: AnchorId; ring } | null;  // PC 两层圈
grabAt(grabs, pt, radius | { inner, outer }): Grab | null;                     // 图标抓手命中
edgeNormalOf(frame, id): Pt;                                                   // 边中点那条边的外法线
```

**抓手布局（2026-09 重排；原因：真机上「离框太远 / 太散」，语义靠"离框多远"不可发现）**：

| 抓手 | 数量 | 位置 | 图标 | 命中半径 |
|---|---|---|---|---|
| 缩放 | 8 | 4 角 + 4 边中点，**贴在框上**（离框 6px） | 角＝方块、边＝扁矩形 | 38（收窄后 ≥24） |
| 旋转 | 4 | 角的外侧沿**对角线**方向 30px | 圆形箭头 | 同上 |
| 斜切 | 4 | 边中点外侧沿该边**法线**方向 30px | 双向斜线 | 同上 |

- **两平台同一套**：PC 与触屏画的是同样的 16 个图标（`transformGrabs()` 一处出口，`View.xfGrabs()`）。
- **不隐藏类别**：框再小也只是把旋转 / 斜切从 30px 收窄到 20px，**不会整类消失** ——
  拖动中途消失会让「已显示的抓手」跳变、语义跟着跳档（旧版按 160/80/60 分档砍类，已删）。
- **命中半径**：基准 38px，按「**同类**抓手两两最小圆心距 / 2」收窄，下限 24px。
  按同类收窄的理由：缩放贴着框、旋转 / 斜切在 30px 外，同角那一对天然只隔 `30 − 6 = 24px`；
  若把跨类也算进最小距，半径会被永久压在 24px 上、38px 基准形同虚设。
  同类冲突（两个同语义抓手抢同一根手指）才是真问题，跨类冲突交给优先级。
- **优先级：缩放 > 旋转 > 斜切**，实现为 `GRAB_REACH` 的「等效半径倍率」：候选按各自半径筛，
  胜负按 `d / reach` 打分，于是**同一距离下缩放赢**，而每个抓手在**自己的圆心**处必定命中自己
  （`d = 0`）—— 优先级不会把内侧的旋转 / 斜切图标变成点不到的死区（做成「整类先到先得」就会）。
- **枢轴**与抓手**谁更贴手谁赢**（不再无条件抢命中）：缩放抓手贴着框，枢轴预设的四角 / 边中点
  与它几乎重合，无条件优先会让压在角上的缩放永远起不来。
- **PC 的两层同心圈**（`PC_HIT` / `ringHitAt()`）保留为**额外**的宽容命中：图标先判，图标没中才回落到
  圈（缩放 ≤22px、旋转 / 斜切 ≤34px），悬停时把那一圈点亮当提示。

### 10b.2 解算

```ts
type XfKind = "move" | "scale" | "rotate" | "skew" | "pivot";
const XF_LABEL: Record<XfKind, string>;    // 「移动 / 缩放 / 旋转 / 斜切 / 枢轴」（历史 label 用）

interface XfParams {  // 一次变换的全部参数（内容外框坐标）
  pivot: Pt; angle: number; sx: number; sy: number;
  skewX?: number; skewY?: number; shift?: Pt;
  pivot0?: Pt; pivot0Shift?: Pt;
  scalePivot?: Pt;       // 缩放的**不动点**（拖哪个抓手＝对面那个锚点，缺省＝枢轴）
  skewPivot?: Pt;        // 斜切的**基准点**（不动的那条线所在的点，见下）
  skewAnchor?: Pt;       // `skewPivot` 的旧别名（等价，保留兼容）
}
affineFrom(p: XfParams): Mat3;             // S（绕 scalePivot 缩放）→ K（绕 skewPivot 斜切）→ R（绕枢轴旋转），再叠加 shift
linearOf(p): [number, number, number, number];
pivotComp(p): Pt;                          // 枢轴挪动时的平移补偿（画面逐字节不动；数值精确，见下）

solveScale(from, to, anchor, axis, keepAspect?, gridSnap?): { sx, sy };
solveRotate(from, to, snapClean?): { angle };
solveSkew(id, from, to, span, angle?): { tan };   // 返回的 tan 直接写进 skewX / skewY
skewBaseline(box, id): Pt;                 // 斜切的**不动线**＝拖的那条边的**对面**中点
skewPivotOf(id, fixed): Pt;                // 不动线 → 剪切原点（水平剪切看 y、竖直剪切看 x）

const SCALE_MIN = 0.02, SCALE_MAX = 40;    // 极限缩放（按绝对值钳，符号保留＝允许翻转）
const TAN_SKEW_LIMIT = Math.tan((85 * Math.PI) / 180);
```

`affineFrom()` 的线性部分 `L = R · K · S`，平移
`t = c + R·(sk − c + K·(sa − sk)) − L·sa + shift + pivot0Shift`
（`c` = 枢轴、`sa` = `scalePivot`、`sk` = `skewPivot`；三者重合时退化成 `t = c − L·c`，与旧行为逐字节相同）。
注意 `K·(sa − sk)` 里的 `K` 是**斜切本身的**线性部分 `[[1, kx], [ky, 1]]`，不是合成后的 `K·S` ——
用错这一项，缩放的不动点会被整段吃掉（表现就是「拖一个抓手，对面的抓手也跟着跑」）。

`pivotComp()` 是**数值精确**的补偿：把同一组参数按「枢轴在 `pivot0`」与「枢轴在当前位置」各组装一次矩阵，
两者只差一个平移（线性部分与枢轴无关），把这个差补回 `pivot0Shift` 即可 —— 不管缩放 / 斜切的不动点
是不是枢轴都成立。视图侧改枢轴走的是增量版本（`View.pivotKeepPicture()`），可以反复调用。

**缩放的不动点＝被拖抓手对面那个锚点**（`scaleAnchor()`）：拖右下角时左上角钉住不动、
被拖的那条边跟手（`solveScale` 的 `anchor` 参数与矩阵的 `scalePivot` 必须是同一个点）。

**斜切的基准线＝被拖那条边的对面**（`skewBaseline()`，Aseprite 的行为）：
拖上边中点时下边一动不动、上边**整条跟着手指 1:1 平移**（`span` 传框的整高 / 整宽）。
早先的写法把基准线放在枢轴那条线上，被拖的边只走一半、对面那条边反向走一半 ——
手指走了 40px 边只走 20px，抓手看着「不跟手」，是这个 bug 的直接表现。
`angle`（可选）＝当前框的旋转角，拖动量按**框自身的轴**量（框转过角度之后也跟手）。

### 10b.3 枢轴、干净角、像素精确通道

**双击枢轴 = 复位到内容正中**（`View.resetXfPivot()`，真机反馈「枢轴拖出去以后拖不回来，只能一档档循环预设」）：
它等价于 `setPivotPreset("cc")`，同样过 `pivotKeepPicture()` 补平移补偿，所以**画面逐字节不动**，
只改「绕哪里转」；枢轴已经在中正时返回 `false`（不重复落历史）。
判定在 `View.tryStartXf()` 里：只有**上一次点击是「按在枢轴上且没拖动」**（由 `xfEndDrag()` 登记
`pivotTapT/pivotTapPt`）且在 `prefs.doubleTapMs` 内、落点相距 40px 以内，才算双击 ——
所以「拖完枢轴再点一下」不会被误判。触屏双击与电脑双击都走同一条路（不依赖 `isPc()`）。

```ts
type PivotPreset = "cc" | "tl" | "tc" | "tr" | "cl" | "cr" | "bl" | "bc" | "br";
const PIVOT_PRESETS: PivotPreset[];
pivotPresetPoint(box, k): Pt;  pivotPresetAt(i): PivotPreset;  pivotPresetOf(box, pt): PivotPreset;
adjustPivot(oldBox, newBox, pivot): Pt;    // 独立小工具：按归一化比例把点从旧框映射到新框
pivotInBox(box, p): boolean;

const CLEAN_ANGLES_DEG: number[];          // 0 / 26.565 / 45 / 63.435 / 90 / 116.565 / 135 / 161.565 / 180 + 负半轴
snapCleanAngle(rad): number;               // 吸附到上表（旋转吸附用；不是 15° 的倍数）
normAngle(rad): number;                    // 归一到 (-π, π]
isRightAngle(rad): boolean; rightAngleSteps(rad): number;   // 90° 的倍数

isIntegerShift(dx, dy): boolean;
isExactTransform(p: XfParams): boolean;    // 整数平移 / 90° 倍数 / ±1 翻转 → **可以**逐像素搬运
exactMove(content: { w; h; data: Uint8ClampedArray }, steps, flipX?, flipY?): ExactMove;
rotatedSize(w, h, steps): { w, h };
transformedBox(m, w, h): XfBox;            // 变换后**外框**的包围盒（`floor..ceil`，目标空间；离画布下标差一个 st.ox/oy）
outerKindOf(id): XfKind;                   // 锚点在外圈上的语义：角＝rotate、边中点＝skew（内圈恒为 scale）
// 抓手布局见 §10b.1（贴着框的固定图标：缩放 6px / 旋转 30px / 斜切 30px，小选区收窄到 20px）
distToSegment(p, a, b): number;
distToFrame(frame: ScreenFrame, pt): number;   // 点到框边的最短距离（±2px 环带用来判「只移动选区边框」）
insideFrame(frame: ScreenFrame, pt): boolean;
```

**枢轴是内容上的一个点**：它的坐标是矩阵参数（会话起点那块内容的空间），画的时候过一遍当前矩阵 ——
`View.xfPivotScreen()` ＝ `M(pivot)` 再换屏幕，所以**拖动内容 / 缩放 / 旋转 / 斜切时枢轴标记跟着内容走**，
不需要任何「跟位」逻辑（早先只画 `(p + st.ox)·z + ox`＝恒等变换，标记会呆在原地）。
反向地，**拖枢轴时**指针位移要先过矩阵线性部分的**逆**再落到参数上，标记才会 1:1 跟着手指
（否则缩放 / 旋转过的框上会走得更快或偏方向）。拖动枢轴仍然用 `pivot0Shift` 做补偿，画面逐像素不动。

**为什么角度吸附不用 15°**：像素画只有「直角」和「2:1 / 1:2 斜率」这些角度转完还在格点上
（`atan(1/2) = 26.565°`、`atan(2) = 63.435°`），15° 的倍数转完必然要重采样、像素就糊了。

**像素精确通道只给纯整数平移用**（`View.xfExactOf()`）：`isExactTransform()` 表示「这个变换本身
是逐像素搬运」，但 `exactMove()` 是「把 `w×h` 的块整体搬到 `(dx,dy)`」—— 90° 旋转会把宽高换过来、
块心跟着挪半格，只有枢轴正好在内容中心时才等价于绕枢轴转。早先的判据只看了「无斜切 + 倍率 1」，
**漏判角度**，于是「原地转 90°」也走进这条路：框转了、里面的像素一格没动（用户报的「变形不正确」）。
现在转过角度的一律交给最近邻重采样 —— 90° 倍数旋转在格点上是一一对应的，重采样本身就无损。

### 10b.4 列驱动状态机（view 侧的实现形状）

`View` 里的变换会话**不是**一堆并列的 `if`，而是一张「抓手 → 解算」的表：`xfStart()` 记下
`{ kind, anchor?, start }`，`xfMove()` 按 `kind` 分派（`pivot` / `move` / `scale` / `rotate` / `skew`），
`xfEndDrag()` 收尾（松手只结束**这一次拖拽**，会话继续开着）。这样做的原因：

- **一次会话一条 undo**：`endXf()` 只在「完成 / 还原 / 切工具 / 切帧 / 换文档」时落历史；
- **换抓手不重开会话**：`xfStart()` 遇到活着的会话只换 `xfDrag`，枢轴 / 缩放 / 角度都保留；
- **解算每次从会话起点重算**（不做增量累加），所以来回拖不会漂；
- **累加基准＝按下那一刻**：`xfDrag.tp0` 记下按下时的 `{sx, sy, angle, skewX, skewY}`，
  三个分支的解算结果都相对它累加 —— 同一次拖拽里每个 `pointermove` 都从 `tp0` 重算
  （挪几下不会连乘），松手后再拖第二次才继续累加（不会被第二次拖拽覆盖回原样）。
  早先直接赋值，等于「同一次会话里拖第二次＝把上一次的结果抹掉」。

三个分支的参考系必须与**画出来的东西**完全一致（这是最容易错的地方，逐条记下来）：

- **参照是「抓手图标自己」按下时的位置**（`xfDrag.h0`，由 `View.grabIconAt()` 取），不是手指按下的
  那一点：命中半径在触屏上有 38px，按偏一点时「手指 ↔ 图标」那一截会被冻结在整个拖动里 ——
  图标只平行跟着手指走，永远隔着那 40px（用户报的「离鼠标位置估计有 40px」）。以图标为参照＝
  图标先贴到指针上、再 1:1 跟手；缩放 / 旋转 / 斜切 / 枢轴四条分支都走这一条，「移动内容」不用
  （那是把内容整体挪走，本来就按位移算）。
- **旋转**：`from` / `to` 都相对 `View.xfPivotScreen()` 量 —— 也就是**画出来 / 命中用的那个枢轴屏幕位**。
  早先这里写的是 `(pivot + 0.5)·z + ox`，漏了 `st.ox·z`：选区不在画布原点时旋转中心整体偏
  `st.ox·z`（选区在 (100,100)、zoom 8 时偏 800px），拖着抓手转 90° 只转出 37°，
  框和全部抓手跟着甩到别处 —— 用户报的「锚点乱飞 / 变形不正确」就是这个。
- **缩放**：`from` / `to` 都用「指针在**内容外框坐标**里的位置」，且 `to` 是**指针当前位置**而不是
  「抓手起点 + 位移」——否则斜着拖时某一轴会一直差半格（被解成 0 再钳到 `0.02`，表现就是「缩放没反应」）。
  框转过角度时先把两个位置绕不动点转回框自身的轴上，再交给 `solveScale()`。
- **斜切**：基准线＝对面那条边（`skewBaseline()`），拖动量按当前框角投影（`solveSkew` 的 `angle`），
  所以被拖的边**跟着手指 1:1 走**、对面那条边一动不动（图标沿边方向的偏移也以图标自身为参照，
  只有它离框 30px 的那段法线外移是布局决定的、去不掉）。

**变形期间不自动平移**（`prefs.autoPan` 对旋转 / 缩放 / 斜切 / 枢轴 / 变形控制点的拖动一律不生效）：
视口一动，解算用的参考点（枢轴屏幕位、拖动起点）就跟着动，角度会跳、抓手会从手指下面滑走。
笔迹与普通选区拖动仍然照旧自动平移。

**「画布外按下＝平移视图」要让位给抓手**：旋转 / 斜切图标画在选区框**外** 30px（缩放 6px），
选区贴着画布边时它们必然落在画布外；`onDown` 里那条 `blankPan && outsideDoc` 必须先问
`warpHandleAt()` / `xfHitAt()`，命中就交给变形（否则这些图标一跑到画布外就按不到 ——
用户报的「按钮不在画布内时会触发拖动相机」）。空白处（离所有抓手都远）照旧平移。

---

## 11. 应用层 Session

`src/app/session.ts` —— 全局唯一状态中枢（`src/ui/singleton.ts` 导出的单例）。

### 11.1 订阅与快照

```ts
subscribe(fn: () => void): () => void     // 任何状态变化都会触发
changed(): void                           // 手动广播（rev++）
getVersion(): number
snapshot(): Snapshot                      // 缓存过的不可变快照，供 React 渲染
```

`Snapshot` 关键字段：`tool, shape, brushSize, brushAlpha, colorHex, layerIdx, frameIdx, layerCount, frameCount, canUndo, canRedo, onionOn, gridMode, gridSize, previewBg, previewGray, tileMode, selActive, docName, w, h, playing, loopMode, frameSel, frameSelOn`。

### 11.2 渲染

```ts
attachView(v: View): void
repaint(): void                 // 全帧脏 → rAF 合并后重绘
repaintRect(rect: Rect | null)  // 只重绘 rect（笔迹实时路径）
repaintAll(): void              // 立即整帧重建（结构变化）
syncAll(): void                 // 刷新 + 广播 + 预览
```

### 11.3 工具 / 颜色

```ts
setTool(t: ToolId): void
brush(): BrushState
currentColor(): RGBA
setColor(c: RGBA) / setFgColor(c) / setColorTarget("fg" | "bg") / swapColors()
setBrushSize(n) / setBrushAlpha(n) / setBucketGlobal(on)
setColorPicking(on) / colorPickedRecently(now, windowMs)
docColors(): RGBA[]            // 画面里用到的颜色
palOrbColors(): RGBA[]         // 取色球当前来源的颜色
cyclePalOrbMode(): void        // 色板 → 画布颜色 → 最近使用
```

### 11.4 对称

```ts
cycleSym(): SymMode            // 开关
setSymFour(on) / setSymLocked(on) / cycleSymAngle(): number
applySymPreset(m) / resetSymAxes()
```

### 11.5 色板

```ts
setPalette(colors)             // 整体替换（可撤销）
paletteAdd(c) / paletteRemove(idx) / recolorPaletteColor(idx, newC)
paletteDedupe(): number        // 去重，返回删除数量
paletteMerge(colors): number   // 合并并跳过已有颜色，返回新增数量
paletteSort("hue" | "light")   // 排序（只改顺序）
savePalettePreset(name?): string        // 把**当前 doc.palette** 存成一个命名色板（myPalettes）
savePalettePresetOf(colors, name?): string   // 把**任意一组颜色**存成命名色板（色彩明暗的「存为新色卡」用；
                                             // 不动 doc.palette，只往 localStorage 的 myPalettes 加一条）
deletePalettePreset(id): boolean
```

### 11.5b 颜色分析（Session）

```ts
// 口径：canvas = 当前帧所有可见图层；layer = 当前图层当前帧；
//       selection = 只统计选区内像素（范围仍是整张画布）；allFrames = 所有帧，
//       同一像素位置只算一次（先出现的帧优先，见下）
analyseCanvas(scope: "canvas" | "layer" | "selection" | "allFrames", sort?): ColourAnalysis
analysePixels(data, sort?): ColourAnalysis       // 对任意像素块直接统计
colourGroups(a, tol): ColourGroup[]              // 近似色分组（只读）

// 颜色替换：一条可撤销历史（pushPixels），返回被改动的像素数。
// 索引色模式打开时目标色先按 paletteSnap 吸附；「画布」范围作用于当前帧的
// **所有图层（含隐藏图层）**；「选区」范围没有选区时什么都不做（也不记历史）
replaceColour(from, to, {
  scope?: "canvas" | "layer" | "selection" | "allFrames",
  tolerance?: number, opaqueOnly?: boolean, keepAlpha?: boolean,
}): number

// 近似色合并：组内成员各一条按键值精确替换（同一条历史）
mergeColourGroup(rep, members: RGBA[], scope?): number

// 把某颜色的像素写进当前选区（maskOp 一条历史），返回命中像素数；
// 命中数 == 全文像素时按"全选＝没有选区"处理
selectColourPixels(from, tol?, scope: "layer" | "canvas" | "allFrames"): number

exportColourStatsCsv(a, scopeLabel): void        // 走 bridge.saveBytes
nearestPaletteColour(c): RGBA | null
```

**「所有帧」的口径**：逐帧把可见图层压平，然后**同一像素位置先到先得**
（第 0 帧先占，后续帧只补它没盖到的位置），不是 source-over 叠加 —— 叠加的话
后一帧的不透明像素会把前一帧的颜色覆盖出去，统计会凭空少掉一大半。副作用是
如果第 1 帧的每个像素都被第 0 帧占了，第 1 帧的颜色就不会进统计（面板的范围
说明里写明了这一点）。

### 11.6 选区

```ts
maskOp(label, fn)              // 把选区改动包成一条撤销记录
wandAt(x, y) / setSelectionTolerance(n) / deleteSelection()
```

### 11.7 图层 / 帧
```ts
layerAdd / layerDuplicate / layerDelete / layerUp / layerDown / layerMoveTo(from, to)
layerMergeDown / toggleLayerVisible(li) / toggleLayerLock(li) / renameLayer(li, name)
setLayerOpacity(li, o) / editLayerOpacity(li, o) / endLayerOpacity() / setLayerBlend(li, b)
setLayer(li) / curLayer()

frameAdd / frameDuplicate / frameDelete / frameMove(dir) / frameMoveTo(from, to)
setFrame(fi, record = true) / curFrame() / setFrameDuration(fi, ms)

// 帧多选（批量）
setFrameSelMode(on) / toggleFrameSel(fi) / clearFrameSel() / frameSelList(): number[]
framesSelectAll() / framesDeleteSelected(): number / framesDuplicateSelected(): number
framesSetDuration(ms): number

// 动画标签（每个改动都是一条可撤销的结构历史）
tagAt(fi): FrameTag | null / tagById(id) / activeTag(): FrameTag | null / playingTag(): FrameTag | null
tagAdd(name?, from?, to?): FrameTag | null   // 默认用选中的帧（没选就用当前帧）；名字不给就自动编号
tagRename(id, name) / tagSetRange(id, from, to) / tagSetColor(id, color) / tagRemove(id): boolean
tagSelectFrames(id)                          // 进入帧多选并选中这段
tagPlay(id)                                  // 跳到首帧并只播放这一段
```

### 11.8 播放 / 洋葱皮 / 画布

```ts
togglePlay() / startPlayback() / stopPlayback() / cycleLoopMode(): LoopMode
// startPlayback 会把「当前帧所在的标签」当作播放窗口（没有则整条时间轴），存进 playTag；
// stopPlayback 清空它。播放范围不影响手动切帧。
toggleOnion() / setOnionOn(on) / setOnionBefore(n) / setOnionAfter(n)
setOnionAlpha(n) / setOnionTint(on) / setOnionWrap(on)
setGridMode("off"|"pixel"|"iso") / setGridSize(n)
canvasSize(w, h, ax, ay) / spriteSize(w, h) / cropSmart()
scaleAdvanced(o: { w, h, algo?, scope?, cleanTransparent? }): boolean
  // 高级缩放（画布球 →「高级缩放」）。三个范围口径一致：把该范围的内容重采样成 w×h。
  //   "sprite"    整张画布（所有图层 × 所有帧），**画布尺寸变成 w×h**
  //   "layer"     只缩放当前图层（该层所有帧）：画布尺寸不变，结果以 (0,0) 为锚点贴回、超出裁掉
  //   "selection" 只缩放选区外接矩形里的内容：画布尺寸不变，结果以选区左上角为锚点贴回，
  //               并把选区更新成缩放后的矩形（没有选区时提示并返回 false）
  // 只有 "sprite" 会改画布尺寸——本工程的 cel 一律与画布等大（engine/cel.ts），
  // 图层/选区若也改画布尺寸，别的图层就会跟画布错位。
  // 目标尺寸＝源尺寸（选区＝选区尺寸）时直接当没操作，返回 false 且不压历史。
  // 一次操作只落一条历史（结构快照），且只在真的改了像素时才压栈；
  // 返回 true 表示「这次缩放执行并改动过像素」。
  // UI：ScaleModal 只放参数，**原图↔缩放后的对比图在单独的「对比预览」面板里**
  //（弹窗底部 i-compare 按钮 → portal 出去的 .dlg-scale-compare，预览块 128px），
  // 组件仍是 ScalePreview（size 可调，默认 44px 的小图）。
  // 预览的**取块与取像素**是纯函数，在 `src/ui/scale-preview.ts`（可单测）：
  //   · 源像素：sprite 范围＝当前帧**可见图层压平**（＝画布上看到的画面），
  //     layer / selection＝当前图层的那张 cel —— 早先一律只读当前 cel，
  //     内容画在别的图层上时预览全空；
  //   · 取哪一块：大小＝按缩放倍数反推（`region / k`，两侧显示同样多的内容），
  //     位置**对准内容包围盒**（空内容退回区域中心）—— 早先固定取区域正中，
  //     内容在角落时预览也是一片空白（真机反馈「两个图都没显示任何内容」）；
  //   · `empty`（这一块里没有可见像素）由组件渲染成一行提示，而不是两个空框；
  //     预览画布带透明棋盘格底，取到透明像素时看得出是「透明」而不是「坏了」。
cropToSelection(): boolean              // 画布裁切到选区外接矩形（一条结构历史）
resizeModeOn / setResizeMode(on) / toggleResizeMode()   // 拖画布四边改尺寸的模式
sampleComposite(x, y): RGBA | null        // 取合成后的颜色
```

### 11.8b 缩放对比预览的取块 `src/ui/scale-preview.ts`

`ScaleModal` 的两张预览图**不自己算**，全部走这个纯函数模块（无 React / 无 DOM，`tests/scale.test.ts` 直接跑）：

```ts
flatFrame(doc, fi): Uint8ClampedArray          // 当前帧**可见图层**压平（复用 engine/color-analysis 的 flattenLayers）
previewSource(doc, scope, li, fi): Uint8ClampedArray
                                               // sprite＝flatFrame（缩放改所有 cel，画面就是它）；
                                               // layer / selection＝当前图层那张 cel 的拷贝
contentBounds(src, docW, docH, region): { x0; y0; x1; y1 } | null   // 区域里 alpha>0 的包围盒
previewPatchGeometry(src, docW, docH, region, cw, ch): PreviewGeometry
                                               // { x, y, w, h, tw, th, empty }：
                                               // 取块大小＝按缩放倍数反推（`region / k`），位置**对准内容包围盒**
                                               // （内容为空退回区域中心），整块夹在区域内；empty＝这一块没有可见像素
cropPatch(src, docW, docH, g): Uint8ClampedArray    // 裁出那一块（画布外保持透明）
scaleFactorLabel(cw, ch, region): string       // "2×" / "2× / 1.5×"（整数不写小数、不留尾零）
```

`ScalePreview` 组件只负责把结果画进 canvas（`putImageData`），高度按取到那块内容的宽高比自适应；
`empty` 时渲染一行 `scalePreviewEmpty` 提示。**改这里之前先读**：源像素口径必须与 `scaleAdvanced()`
的作用范围一致，取块必须跟着内容走（这两条各对应一次真机反馈，见 §11.8 的注释）。

### 11.9 撤销与结构变更

```ts
undo() / redo() / jumpHistory(index)
struct(label, fn)             // 结构快照式撤销
```

### 11.9a0b 剪贴板粘贴

```ts
clip: Cel | null                       // 整个空间共用一份剪贴板
pasteAsNewLayer(clip): boolean         // 粘成新图层（插入在当前图层之上并选中），一条结构历史
pasteAsNewCanvas(clip): number         // 粘成新画布（尺寸＝剪贴板尺寸），返回画布下标
pasteIntoFrames(clip, li, frames): boolean   // 一次粘到多帧，一条结构历史
```
`src/ui/paste.ts` 把三种粘贴（`inPlace` / `layer` / `canvas`）串成一条流程，
并负责把系统剪贴板的图片转成真正的 `Cel`（以前塞的是普通对象，`pasteRaw` 调
`clip.idx()` 会抛错，导致 Ctrl+V 静默失效）。快捷键：Ctrl+V / Ctrl+Shift+V / Ctrl+Alt+V。

### 11.9a0 提示

```ts
hintOnce(key, zh, en): void   // 只提示一次（localStorage 记忆），给 OS 抢手势这类一次性说明用
note(zh, en): void            // 按当前语言弹一次 toast，不记忆（如「目标画布的该图层已锁定」）
paintBlockedNote(): void      // 当前图层不能绘制时的标准提示（锁定 / 引用层失效）
```

### 11.9a 手势与操作记录

```ts
runGestureAction(action: GestureActionId, ctx?: { x?: number; y?: number }): boolean
showFrame(fi: number): void          // 切帧但不记录历史（供恢复的历史步骤使用）
get recordHistory(): boolean         // 工程文件是否写入操作记录
serializeProject(): Promise<string>  // 文档 +（可选）操作记录
loadProjectText(text): Promise<boolean>
```

### 11.9b 记忆的工具状态

```ts
setBrushSize(n) / setBrushAlpha(n) / setBrushShape("circle" | "square")
setShapeSides(n) / setShapeFill(on) / setShapeFromCenter(on)
setCurrentShape(id) / setCurrentSelect(id)      // 形状 / 选区子环记忆
rememberSym(): void                              // 对称轴状态写盘（角度/轴心/四向/锁定）
rememberPalette(): void                          // 当前色板写盘（新文档沿用它）
scheduleSavePrefs(): void                        // 热路径防抖写盘（600ms）
setTlHeight(n): void                             // 时间线面板总高度（拖动分割线用）：140–520 夹取 + 防抖写盘
mirrorSelectionMask(): boolean                   // 对称开启时把选区按轴镜像
```

### 11.10 设置 / 持久化

```ts
settingValue(path): SettingValue
setSetting(path, value): void          // 自动持久化 + 按声明刷新
hapticTick(tag, scale = 1): boolean    // 受 gesture.haptic 开关控制，长度取 prefs.hapticLen
savePrefs(): void
scheduleAutosave() / flushAutosave(): Promise<void> / restoreAutosave(): Promise<Doc | null>
autosaveInfo() / clearAutosave()
// 多版本自动保存（§16.5）：启动自检 + 历史版本操作
checkBootCrash(): Promise<boolean>       // 上次没正常退出 → bootRecover 挂上版本表，App 弹恢复面板
bootRecover: { versions: AutosaveVersion[] } | null    // 非 null 时 App 渲染 RecoverModal
dismissBootRecover(): void
autosaveVersions() / autosaveHistorySupported()
restoreAutosaveVersion(seq): Promise<boolean>          // 走 loadProjectText（会先问过用户）
exportAutosaveVersion(seq): Promise<void>              // 导出成 .pxc
dropAutosaveVersion(seq): Promise<void>
```

---

## 12. 设置注册表

`src/app/settings.ts`

```ts
type SettingValue = boolean | number | string;
type SettingKind = "bool" | "int" | "enum";
type SettingRefresh = "none" | "changed" | "repaint" | "repaintAll";
// 分组：general | canvas | tools | gesture | onion | history | display | data

interface SettingDef {
  path: string;                 // "onion.before"
  field?: keyof Prefs;          // 直接映射到 prefs 字段
  kind: SettingKind;
  group: SettingGroupId;
  label: string; desc?: string; // i18n key
  default: SettingValue;
  options?: SettingOption[];    // enum
  min?: number; max?: number; unit?: string; reset?: SettingValue;
  visible?: (s: Session) => boolean;
  refresh?: SettingRefresh;
  get?/set?: (s, v) => ...;     // 自定义读写
  after?: (s, v) => void;       // 副作用
}

const SETTINGS: SettingDef[]; const SETTINGS_BY_PATH: Map<string, SettingDef>;
const SETTING_GROUPS: Array<{ id; label }>;   // general / canvas / screen / tools / gesture / onion / history / display / data
settingsOfGroup(s, group): SettingDef[];      // 已按 visible 过滤
normalizeSetting(def, raw): SettingValue | null;

isDefault(s, def): boolean;
resetSetting(s, def): void;
coerceSetting(def, v): SettingValue | undefined;      // 文件导入用：类型校验 + 范围裁剪
exportSettings(s): SettingsFile;                       // { app, version, savedAt, values }
importSettings(s, raw): { applied: number; skipped: number };
```

**新增一个设置**：在 `defs` 里加一条声明 + i18n 的 `label`/`desc` 文案，设置面板会自动出现（搜索、分组、恢复默认、导入导出都自动支持）。

---

## 13. 引导注册表

`src/app/guide.ts`

```ts
type GuideModule = "canvas" | "tools" | "orbs" | "timeline" | "files" | "gestures";
type GuideAction = "openTimeline" | "closeTimeline" | ... | "demoFramePick";
type GuideActionList = GuideAction | GuideAction[];
type GuideDemoKind = "tap" | "doubleTap" | "tripleTap" | "oneFingerDraw"
  | "twoFingerPinch" | "twoFingerPan" | "twoFingerDoubleTap" | "fourFingerSwipe" | "longPressDrag";

interface GuideStep {
  id: string; module: GuideModule; since: string;   // "1.0.6.1"
  title: string; body: string;                      // i18n key
  target?: string;                                  // CSS 选择器
  place?: "auto" | "top" | "bottom" | "left" | "right";
  optional?: boolean;                               // 目标不存在则静默跳过
  peek?: boolean;                                   // 浅遮罩（背后是真实窗口）
  before?: GuideActionList; after?: GuideActionList;
  demo?: GuideDemoKind;
  click?: string; closeClick?: string;              // 真实模拟点击
}

const GUIDE: GuideStep[]; const GUIDE_MODULES;
versionGte(a, b): boolean;
guideStepsFor(seen: string[], fresh: boolean): GuideStep[];
guideStepsOfModule(m): GuideStep[];
guideProgress(i, n): string;
guideActionsOf(list): GuideAction[];
```

**新增一步引导**：写一条 `GuideStep` + i18n 文案 + 在 `App.tsx` 的 `guideActions` 里实现所需动作（动作要自还原）。`tests/guide-anchors.test.ts` 会静态校验每个 `[data-guide="…"]` 锚点真实存在、每个动作都有实现。

---

## 14. 播放模式

`src/app/playback.ts`

```ts
type LoopMode = "once" | "loop" | "pingpong" | "reverse";
const LOOP_MODES: LoopMode[];
nextLoopMode(m): LoopMode;
interface PlayStep { fi: number; dir: 1 | -1; stop: boolean }
startPlayFrame(mode, fi, n): number;
startPlayDir(mode): 1 | -1;
nextPlayFrame(mode, fi, n, dir): PlayStep;

// 播放速度（时间轴上的速度色片）
const PLAY_SPEEDS = [0.25, 0.5, 1, 1.5, 2] as const;
type PlaySpeed = (typeof PLAY_SPEEDS)[number];
const DEFAULT_PLAY_SPEED: PlaySpeed;            // 1
speedLabel(s): string;                          // "0.25x" … "2x"
isPlaySpeed(v): v is PlaySpeed;
nextPlaySpeed(s): PlaySpeed;                    // 循环；未知值从 1x 起算
scaledDelay(ms, speed): number;                 // 帧时长 ÷ 速度，下限 16ms
```

`Session`：`playSpeed`（同时也是快照字段 `Snapshot.playSpeed`，时间轴的色片读它）、
`setPlaySpeed(v)`（非法值**原样忽略**，不要偷偷改成 1x）、`cyclePlaySpeed()`；存进 `prefs.playSpeed`。

播放速度**不改帧时长**（`doc.frames[].durationMs` 是作品数据，导出 GIF / Aseprite 仍按原时长）：
`tickPlay()` 用 `scaledDelay(帧时长, playSpeed)` 起定时器。播放中改速度会掐掉当前定时器**重新起一次**——
位置不变、不额外推进帧，所以不会「改速度跳一帧」。下限 16ms：10ms 的帧在 2× 下也不该排 5ms 的定时器
（浏览器会钳到 ~4ms，肉眼也看不见）。

---

## 15. 渲染

### 15.1 脏矩形工具 `src/render/rect.ts`

```ts
unionRect(a: Rect | null, b: Rect | null): Rect | null
clampRect(r: Rect, w: number, h: number): Rect | null
screenRectOf(r: Rect, ox: number, oy: number, zoom: number, pad = 2): Rect
coversAll(r: Rect, w: number, h: number): boolean
TILE_OFFSETS: ReadonlyArray<readonly [number, number]>          // 3×3 平铺偏移，中心在前
tileRect(r, w, h, dx, dy, mirror): Rect                         // 文档矩形 → 邻格副本坐标（mirror 时按共享边翻转）
```

平铺画布（`prefs.tileMode` = `off | repeat | mirror`）：`View.refresh()` 把合成结果在中心四周画 8 份只读副本
（`repeat` 直接平移，`mirror` 按 `dx/dy` 翻转），脏矩形会同时并上 8 份副本的屏幕矩形，中心格加蓝色描边；
输入坐标仍只在中心文档范围内生效，所以只有中心可编辑。

### 15.2 合成器 `src/render/compositor.ts`

```ts
canvasToBlendMode(m: BlendMode): GlobalCompositeOperation
celToCanvas(cel): HTMLCanvasElement            // 全量上传（缓存 canvas + ImageData）
celToCanvasRect(cel, rect): HTMLCanvasElement  // 只上传脏矩形
composeFrame(doc, fi, { bgOverride?, onlyLi? }): HTMLCanvasElement
composeFrameWithOnion(doc, fi, onion: OnionSpec, cache?: ComposeCache): HTMLCanvasElement
composeRectInto(doc, fi, onion, rect, target, cache?): void   // 只重合成 rect
tintCanvas(src, tint, alpha): HTMLCanvasElement
compositeOntoCel(dst, src, srcOpacity, blend): void           // 向下合并

interface OnionSpec { before; after; alpha; tint: boolean; wrap?: boolean }
const ONION_TINT = { prev, next, prevWrap, nextWrap };        // 环绕帧用独立颜色
newComposeCache(): ComposeCache                               // 幽灵帧缓存
```

### 15.3 洋葱皮布局 `src/render/onion.ts`

```ts
interface OnionGhost { f: number; k: number; prev: boolean; wrapped: boolean }
onionGhosts(fi, frameCount, before, after, wrap): OnionGhost[]   // 由远及近，自动去重/跳过自身
```

### 15.4 视口 `src/render/view.ts`

PC（鼠标）输入层在 `View` 内新增：

| 输入 | 行为 |
|---|---|
| 滚轮 | 缩放（以光标为锚点）；`Ctrl+滚轮` 改笔刷大小（按格累计，一格一步）；`Shift+滚轮` 横向平移、`Alt+滚轮` 纵向平移。意图判定是纯函数 `render/wheel.ts` 的 `wheelIntent(e)` / `wheelZoomFactor(deltaY, deltaMode)`（指数曲线、归一化 `deltaMode`） |
| 中键拖动 / 空格+左键拖动 | 平移视图（`panBy`），不动像素；光标变 `grab`/`grabbing` |
| 右键 | 用**另一个颜色槽**绘制（默认即背景色，`Session.secondaryColor()`），工具与左键完全一致 |
| 空格键 | 由 `View.onSpaceKey` 监听（输入框内不生效、按钮上仍保留空格的激活行为） |

以上都在 `isPc()` 为真时启用（见 §16.1b2；`applyPcMode("off")` 时滚轮事件完全不处理）。

其中 `quickFill(clientX, clientY, color) => number`（1.0.8.3 起）是调色球拖拽的入口：把 client 坐标换算成画布像素，
必要时先 `focusCanvas()`，然后用与真实点击完全相同的工具装配（引用层重定向、选区遮罩、相似色容差、填充缝隙、
索引色吸附、平铺环绕）执行一次「按下 + 提交」，因此只产生一条历史记录；返回被填充的画布下标，未落在画布上返回 `-1`。
`Session.quickFill(x, y, color)` 是同一件事的会话层包装。

```ts
**落点预览（白色笔尖轮廓）**：铅笔 / 橡皮的预览必须用**当前笔尖形状**的 `brushStamp(size, brushShape)`，
和真正落笔（`tools/stroke.ts` 的 `paintDot/eraseDot`）同源 —— 早先预览写死了默认的圆笔尖，切到方笔尖后
白色轮廓还是圆的、跟画出来的方块对不上，偶数尺寸下还差一格（真机反馈「预览与笔迹不符且位置偏移」）。
其它绘图工具（直线/矩形/椭圆…）的预览仍是几何包围盒，不是笔尖轮廓。

```ts
class View {
  zoom: number; ox: number; oy: number;         // 视图变换（文档像素 → 屏幕，逻辑坐标）
  rot: 0 | 90 | 180 | 270;                      // 视图旋转（内容不变）

  constructor(host: HTMLElement, session: Session);
  resize(): void; destroy(): void;
  setDoc(doc): void; setFrame(fi): void;
  fit(): void;
  zoomAt(z, cx?, cy?): void;
  screenToPixel(sx, sy): { x; y };              // 逻辑坐标 → 像素
  setRotation(deg): void;                       // 旋转视图（0/90/180/270 循环）
  toLogical(x, y) / toSurface(x, y)             // 真实画布坐标 ↔ 逻辑坐标（DOM 覆盖层用）
  surfaceDelta(dx, dy): { x; y }                // 屏幕位移 → 空间位移（旋转后拖拽方向仍正确）

  // —— 选区自由变换（会话＝一次事务，见 §10b；下面这些都是给 UI / 测试用的公开面）——
  transforming: boolean;                        // 会话是否开着（UI 据此显示「完成 / 还原 / 枢轴」）
  xfScreenFrame(): ScreenFrame | null;          // 当前变换框在屏幕上的四角（无选区 / 无会话 = null）
  xfGrabs(): Grab[];                            // 屏幕上要摆的 16 个固定图标抓手（两平台同一套）
  xfPivotScreen(): PxPoint | null;              // 枢轴的屏幕位置
  xfHitAt(pt): { kind: XfKind; anchor?: AnchorId } | null;   // 命中什么（图标 → PC 再回落两层圈 → 枢轴最近优先）
  grabOffsetsNow(): GrabOffsets | null;         // 这一屏的实际外移距离（小选区收窄、但不隐藏类别）
  beginXfMoveAt(sx, sy): boolean;               // 显式以「移动内容」开会话（小选区上没有空白点）
  grabIconAt(kind, anchor, pt): PxPoint;        // 按下时「被抓的那个图标」自己的屏幕位（解算参照，见 §10b.4）
  setXfPivotAt(lx, ly): boolean;                // 把枢轴钉到内容下标（顺手补平移补偿，画面不动）
  setPivotPreset(k: PivotPreset): boolean;      // 9 档预设（拖拽枢轴后会被判成最近的一档）
  pivotPreset(): PivotPreset | null;            // 当前枢轴落在哪一档
  cyclePivot(step = 1): void;                   // 9 档循环（选区球的「枢轴」chip）
  resetXfPivot(): boolean;                      // 双击枢轴：复位到内容正中（画面不动；已在中正返回 false）
  commitXf(): void;                             // 「完成」：落下一条历史并结束会话
  revertXf(): void;                             // 「还原」：会话整个丢掉，像素逐字节回滚（不进历史）
  xfHint: string | null;                        // PC 悬停提示（"scale:br" 这类）
  hitRadii(): HitRadii;                         // 当前该用哪套命中半径（PC / 触屏 + 自动收窄）

  // —— 四点 / 网格自由变形（会话同样是 `xf` 槽，见 §18.11）——
  beginWarp(kind: "quad" | "mesh"): boolean;    // 进入变形（不改图层）；失败原因见 `lastWarpError`
  finishWarp(revert = false): void;             // 完成＝落一条历史；revert＝还原
  lastWarpError: "noSel" | "tooThin" | "locked" | null;
  warpHandles(): Pt[];                          // 控制点的屏幕位（整数下标画在像素中心）
  warpHandleAt(pt): number;                     // 命中第几个控制点（半径 ≤ 相邻点间距一半，下限 8px）
  warpStartMove(pt): boolean;                   // 按在内容上＝拖动整块（控制点一起走），见 §18.11
  warpMoveContent(pt): void;                    // 拖动内容中：从起点重算位移、按吸附粒度取整

  markDirty(rect?: Rect | null): void;   // 标记脏区（无参 = 全帧 + 全量重绘）
  invalidate(rect?: Rect | null): void;  // 标记 + rAF 合并重绘（Session.repaint 用）
  refresh(force: boolean): void;         // 立即绘制（force = 重建合成）
  flushStroke(): boolean;                // 手势未正常结束时的兜底提交（**变换会话也会在这里收尾**）
}
```

**手势**：单指绘制、双指缩放/平移、三连击放大、边距双击撤销、双指双击重做、四指打开全部帧预览（≥4 指 + ≥2 指滑动 >15px）、长按取色。

---

## 15b. 服务层 `src/servers/`（RenderServer / ViewportServer）

按 `docs/ARCHITECTURE.md` §3.3 把「职责所有权」从 `render/view.ts` 里切出来的第一批：
**合成与缓存归 RenderServer，视图数学归 ViewportServer**。视图层只保留 blit 与覆盖层。

为什么要单独一层：这两块是纯数据变换，切出来之后可以**脱离 DOM 单测**（`tests/render-server.test.ts` /
`tests/viewport.test.ts`）——在这之前它们只能靠"DOM 桩 + 手势"间接覆盖。

### 15b.1 合成与缓存 `src/servers/render.ts`

```ts
/** 画布工厂：真机走 DOM，测试注假实现 */
interface CanvasFactory { create(w: number, h: number): HTMLCanvasElement }
const domCanvasFactory: CanvasFactory;

/** 合成内核：默认是真 compositor，测试可注入假实现来数调用形状 */
interface CompositorApi {
  composeFrame(doc, fi): HTMLCanvasElement;
  composeFrameWithOnion(doc, fi, onion, cache?): HTMLCanvasElement;
  composeRectInto(doc, fi, onion, rect, target, cache?): void;
  newComposeCache(): ComposeCache;
}
const realCompositor: CompositorApi;         // **晚绑定**包装，见下面「不要改回去」

compositeIsStale(hasComposite, keySame, compRect): boolean
onionSpecOf(prefs) / onionKeyOf(prefs)                      // 洋葱皮参数与键片段（纯）
compositeKey(doc, fi, onionKey): string                      // 尺寸/帧/图层配置/洋葱皮
otherCompositeKey(doc, fi): string                           // 额外带 pixelRev

class RenderServer {
  constructor(opts?: { factory?; compositor? });
  get canvas(): HTMLCanvasElement | null;      // 只读用途：取色 / 放大镜
  get needsCompose(): boolean;                 // 视图层据此决定要不要重绘
  get dirtyRect(): Rect | null;                // 调试 / 测试
  get compositeKeyNow(): string;               // 调试 / 测试
  invalidate(rect?: Rect | null): void;        // 不传 = 整幅失效；传则不传 rect 的并集
  compose(doc, fi, onion, onionKey, force): { rebuilt: boolean; consumed: Rect | null };
  composeOther(index, doc, fi): HTMLCanvasElement;   // 多画布合成（带缓存）
  checkerPattern(ctx): CanvasPattern | null;         // 2×2 透明棋盘格（只创建一次）
  resetDoc(): void; resetFrame(): void;
}
```

要点（每一条都对应过一次真 bug 或一次踩坑）：

- **`compositeIsStale` 里 `compRect === null` 表示"整幅都脏了，必须重建"**，不是"没有脏区域"。
  早先按"没有脏区域"处理，于是沿用旧画布 → FX / 选区编辑看起来延迟一拍才显示，
  而预览框（总是从文档合成）是对的 —— 这类"一处对一处错"的现象最容易误导排查方向。
- **部分合成只在三条同时成立时可用**：已有合成画布、合成键没变、脏区域已知；否则整幅重建。
  `force` 直接跳过部分路径。
- **`compose()` 返回消费掉的脏矩形**，调用方（`View.refresh`）据此算重绘区域（含平铺的 8 个邻居副本）；
  无效状态在返回前已清干净。
- **多画布合成键含 `pixelRev`**：别的画布可能被画到了（引用图层）而它自己的图层配置没变，
  只看配置键会漏刷新。
- **`resetDoc()` / `resetFrame()` 会顺手置脏**：合成画布既然已经丢掉就必须重新合成；
  依赖调用方记得再 `invalidate()` 是潜在的空画面 bug（所有调用点后面都跟着 `repaintAll()`，
  置脏只是把这件事写死）。**不要改回去**。
- **`realCompositor` 是晚绑定的箭头函数包装**，不是直接引用函数对象：`tests/view.test.ts` /
  `tests/session.test.ts` 会在运行时替换 `compositor.composeFrame*` 来数调用次数，
  提前绑定会把补丁挡在外面、那些计数断言静默失效。
- `View` 侧只剩 11 处委托 + `markDirty()` 里"整幅失效 → `blitFull`"这一条视图层判断
  （视图变换 / 视口尺寸变化才会强制全量 blit，与合成是否失效是两件事）。

### 15b.2 视图数学 `src/servers/viewport.ts`

```ts
type Rotation = 0 | 90 | 180 | 270;
interface Viewport { zoom: number; ox: number; oy: number }
interface SpaceEntry { x: number; y: number; w: number; h: number }   // 无限空间里的画布

SPACE_MARGIN = 60;

fitTarget(docW, docH, vpW, vpH, zoomMin, zoomMax): Viewport      // 适配 + 整数倍吸附
clampSingle(v, docW, docH, vpW, vpH): Viewport                   // 单画布夹取
clampSpace(v, focus, list, vpW, vpH): Viewport                   // 无限空间夹取（保留 60px 可见）
zoomAtPoint(v, z, cx, cy, zoomMin, zoomMax): Viewport            // 以锚点为不动点
panBy(v, dx, dy): Viewport
screenToPixel(v, sx, sy): { x; y }
rotationMatrix(rot, dpr, w, h): [a, b, c, d, e, f]               // 直接喂 ctx.setTransform
toLogical(rot, w, h, x, y) / toSurface(rot, w, h, x, y)          // 表面 ↔ 逻辑
surfaceDelta(rot, zoom, dx, dy): { x; y }                        // 表面拖拽增量 → 空间增量
```

口径（四条，各对应过一次真机问题）：

1. **屏幕坐标 = 逻辑坐标**：旋转不参与逻辑坐标，而是在画布 transform 里施加（`rotationMatrix`），
   指针坐标用 `toLogical` 转回来。
2. **以锚点为中心缩放**：`ox' = cx − (cx − ox)·k`，k = 新缩放 / 旧缩放 —— 拖拽缩放时光标下的像素不动。
3. **夹取**：单画布夹到边（画布比视口大时边缘不许进视口）；无限空间以聚焦画布为原点算外接框，
   只要还有 `SPACE_MARGIN` 可见就允许 —— 既不会把画布拖丢，也不会锁死整片空间。
4. **`screenToPixel` 用 `floor` 而不是截断**：负坐标上 `| 0` 会得到隔壁像素。
5. 适配缩放只在离整数倍 0.18 以内才吸附（否则像素画在半格相位下抖动）。

**状态暂时仍由 `View` 持有**（`zoom/ox/oy/rot` 是公开字段，`ui/canvas.tsx` 直接读 `view.zoom`），
所以这一版只搬了算术、没搬状态 —— 等 UI 改成订阅信号（§3.6）后再把字段收进 server。

---

### 15b.3 平铺重绘区域（`repaintRegion`）

```ts
interface RepaintRegionOpts { zoom; ox; oy; vpW; vpH; docW; docH; tile: TileMode }
repaintRegion(dirty: Rect, o: RepaintRegionOpts): Rect | null      // 纯函数
RenderServer.repaintScreenRegion(dirty, o): Rect | null            // 薄包装（"重绘规则属于渲染服务"）
```

把**文档空间的脏矩形**换成**要重绘的屏幕区域**：映射到屏幕（`screenRectOf` 自带 2px 余量，
避免缩放取整露边）→ **平铺模式下把 8 个邻居副本的区域一并并进来** → 裁到视口（越界交给 canvas 裁剪是浪费）。
返回 `null` 表示这块脏区域完全在视口外。

平铺那条是必须的：同样的像素在屏幕上出现 9 次，只重绘中心那一块的话，四周副本会留在旧画面上
（真机表现："开了平铺后涂画，邻居副本半拍才更新"）。这段规则原先散在 `View.refresh` 里，
现在归 server，且有断言钉住（`tests/render-server.test.ts` 的 `rr.*`）。

### 15b.4 渲染调试模式（"这一次渲染到底渲染了什么"）

设置 → 显示 → **渲染调试**（`display.renderDebug`，默认关）。打开后左上角出现一块只读 HUD：
计数（重绘 / 合成 / 整幅 / 局部 / 跳过 / 整块 blit / 上次 / 峰值耗时）+ **最近 8 次重绘**，
每行形如 `#12 f0 局部 partial 脏[8,8 4x4] 屏[78,78 44x54] 1.2ms`。

```ts
type RenderKind = "full" | "partial";
type RenderReason = "first" | "full-dirty" | "force" | "key-changed" | "partial" | "skip";

interface RenderEvent { seq; t; kind: RenderKind | "skip"; reason; fi;
  docRect: Rect | null;   // 这次合成消费的脏矩形（整幅 = null）
  screen: Rect | null;    // 实际重绘的屏幕区域（整块 = null）
  fullBlit: boolean; ms: number; w; h }

class RenderDebug {
  readonly cap = 60; readonly totals: RenderTotals;
  get enabled(); setEnabled(v); events(); clear(); subscribe(fn); when();
  note(e);                      // 关掉时第一行就 return —— **热路径零成本**
  text(limit = 20): string;      // 控制台友好的一行行文本
}
const renderDebug: RenderDebug;                       // 应用共用一份
RenderServer.noteFrame({ composed, rebuilt, reason, fi, docRect, screen, fullBlit, ms });
```

- **为什么由 server 记而不是视图层自己记**：HUD 要的是"一次重绘"的完整画像 —— 合成路径与
  脏矩形来自 server，屏幕区域来自视图变换，只有两边合起来才知道。所以视图层在 `refresh` 结束时
  调一次 `noteFrame`。
- `reason` 把"为什么走整幅重建"分细了（`first` / `full-dirty` / `force` / `key-changed`）：
  整幅重建是渲染性能的主要风险，看 HUD 就能判断"这次卡顿是不是又整幅重建了"。
- `skip` 表示这一帧**只重画了覆盖层**（像素画布没动）—— 排查"点一下没反应"时先看有没有 skip。
- 控制台入口：`__pcRender.setEnabled(true)` / `__pcRender.text()` / `__pcRender.totals` / `__pcRender.clear()`。
- **关掉时零开销**：`note()` 立即返回，视图层也先问 `debugEnabled` 才取时间戳；组件不挂载。
- 组件 `src/ui/renderdebug.tsx`（`.rdbg*` 类，`pointer-events:none`，不挡手势）。

## 15c. 输入服务 `src/servers/input.ts`（手势策略与算术）

`render/view.ts` 的手势状态机很大（`onDown/onMove/onUp/onCancel` 约 840 行），按
`docs/ARCHITECTURE.md` §3.3 第 5 项分片搬出。**这一片只搬"策略判定与算术"**（纯函数、
无 DOM、无 Session，可在 Node 里测）：

```ts
interface GestureMods { shift; ctrl; alt; space }
modsOf(e, space): GestureMods
mouseButtonIntent(button, space): "focus-fit" | "secondary" | "primary"
  // PC 鼠标：中键＝聚焦并适配当前画布；右键 / 空格+左键＝用另一个色槽（背景色）绘制

outsideDoc(p, docW, docH): boolean
longPressNeedsDoc(action): boolean              // 取色 / 放大 / 缩小必须落在画布内
longPressAllowed({ isPc, action, pickAllowed, insideDoc }): boolean

FOUR_MOVE_PX_DEFAULT = 15                        // 四指划动阈值（逻辑屏幕像素；设置可覆盖）
fourFingerArmed(pointers, starts, threshold): boolean

TAP_SLOP_PX = 24; withinTapSlop(a, b, slop?): boolean

pinchNow(a, b): { mx; my; dist }                 // dist 下限 1，避免除零
pinchBaseOf(a, b, view): PinchBase               // 起始时冻结的 { 中点, 距离, 缩放, ox, oy }
PINCH_EPS = 0.001
pinchAround(base, now, zoomMin, zoomMax): { zoom; ox; oy; zoomed }
```

口径（都是搬家前逐字保留的行为，`tests/input.test.ts` 钉住）：

- **双指缩放以两指中点为不动点**：`ox' = mx − (mx₀ − ox₀)·k`，k = 新缩放 / 起始缩放；
  缩放先夹到 `zoomMin..zoomMax` 再算平移（夹住了锚点也不会算飞）。中点整体移动＝同时平移视图。
- **四指手势要"至少两根手指各自离开自己的落点"**才置位（阈值严格大于），方向不限；
  按每根手指**自己的落点**算，所以晚落 / 早抬的手指不会削弱判定。
- **`zoomed` 用的是绝对值阈值**（`|Δzoom| > 0.001`）：`zoom = 8` 时两指距离抖 0.01px 就会置位。
  「双指双击＝重做」依赖这个标志，**真机上如果觉得重做难触发，要改的是这里的阈值口径**，
  不要在别处兜底。
- 长按策略：PC 不开长按；`pickColor / zoomIn / zoomOut` 必须落在画布内且允许取色
  （有选区、或当前是选区类工具时不允许）；其它长按动作只要落在画布内即可。

## 15c2. 手势状态机 `src/servers/gesture.ts`（轻点序列）

P5 第二片：把 `view.ts` 的 `onUp` 里那段 150 行的 if 阶梯（单击 / 双击 / 三击 / 双指双击）
收进一个有状态、但**无 DOM、无 Session** 的小机器。它有副作用只有一处：
`up()` 返回一个 `TapOutcome`，动作体（取消笔迹、发手势动作、撤销）仍由 `View` 执行。

```ts
TAP_SEQ_MS = 480          // 单指连点时限
TAP_SEQ_PX = 64           // 单指连点落点容差
TWO_TAP_PX = 80           // 双指双击落点容差（中点抖动更大，所以更宽）

interface TapUpInput {
  now; pt; overDoc; canvasIndex; docIndex;
  moved;                  // 手势期间画过且离开过起点 ⇒ 断掉连点串
  hasStroke; hasSelDrag; hasXf; pinchZoomed;
  isPc; doubleTapMs; canvasDoubleMapped; midOverDoc;
}

type TapOutcome =
  | "plain"                 // 没被手势接管：照常落笔 / 提交
  | "skip"                  // 第二下落在画布内但取不到画布矩形：吞掉、**保留计数**（留给三击）
  | "two-finger-skip"       // 双指中点落在画布内：整串作废
  | "two-finger-first"      // 记下第一下双指轻点
  | { kind:"two-finger-redo", mid }
  | { kind:"focus-canvas", index } | "margin-double" | "canvas-double"
  | { kind:"triple", overDoc, undoSingleDot };

class TapMachine {
  noteSecondFinger(a, b)          // 第二根手指落下：记中点 + 标记「这次手势带双指」
  twoMidPoint(): Pt | null
  clearTwoTapSeq()                // 多指介入 / 四指 / 双指长按已触发 / pointercancel
  noteSingleTap(painted, changed) // 给三击用：上一笔是不是「没动过就落的一个点」且进了历史
  up(input: TapUpInput): TapOutcome
}
```

口径（逐字对齐搬家前的行为，`tests/gesture.test.ts` 44 条断言钉住）：

- **优先级**：双指序列（只要这次手势出现过两根手指、没缩放 / 没在画 / 没在选 / 没在变换）
  → 单指连点 → 双击**换画布**（哪怕「双击画布」映射了动作也照样聚焦适配）
  → 双击**画布外**（边距）→ 双击**当前画布**（仅当映射了动作）→ 三击 → 第二下吞掉。
- **PC 不做单指连击**（滚轮与快捷键替代），所以 `isPc` 下永远只出 `plain`。
- **双指轻点的中点落在画布内不算**（画画时太容易碰到）；缩放过（哪怕 `PINCH_EPS` 那么小的抖动）
  或正在画 / 选 / 变换时都不算轻点。
- **三击会回滚前一下落的那个孤点**，但只在前一下「真画过、且真进了历史」时才撤
  （`undoSingleDot`）——绝不会撤销这次三击之前用户画的东西。
- ⚠ **已知问题（搬出来才发现，行为按原样保留）**：单指第二下只要落在画布上，就会被
  「双击画布」或「聚焦适配」吃掉并清零计数，于是**画布内永远攒不到第三下**，
  `gTripleTap`（三击＝2× 放大）在默认设置下够不到；只有 `canvasIndex < 0`
  （画布矩形取不到）才走 `skip` 保留计数。`tests/gesture.test.ts` 的
  `gesture.triple.shadowed.*` 记录了这个现状，**要么改判定顺序、要么承认三击只在边距外有效**，
  两种改法都会改用户可见行为，改之前先确认。

## 15c3. 手势控制器 `src/servers/gesture.ts`（指针事件入口）

P5 第三、四片：`View` 的四个指针事件入口（`onDown` / `onMove` / `onUp` / `onCancel`，
约 850 行）**整体搬进来**，触点会话**状态**（37 个字段）也一并归它所有 ——
`View` 侧只剩四行转发 + 覆盖层绘制 + 各工具的动作体。

```ts
/** 控制器持有的触点会话状态（View 只读它们来画覆盖层；写入只有控制器能做） */
class GestureController {
  // 触点：     pointers / fourStart / fourSeen / fourArmed / fourView0
  // 双指：     pinchBase / pinchZoomed
  // 长按：     hold / holdFired / longT / pickAnchor / pickMode / pickLast
  // PC 输入：  spaceDown / altDown / altPaint / mousePan
  // 手势进度：gestureMoved / gestureStartPx / panLast / lastPt / strokeRedirected / cursor
  // loupe：    mag / magCenter
  // 各工具的拖动会话：resizeDrag / isoDrag / outline / path / selDrag / symTarget
  //                   xfDrag / xf / xfHover / xfHint / warpDragOn / stroke
  private tap: TapMachine;                 // 轻点序列（§15c2）
  constructor(host: GestureHost)
  onDown(e: PointerEvent): void            // 绑定入口：View.onDown 只转发到这里
  onMove(e: PointerEvent): void
  onUp(e: PointerEvent): void
  onCancel(e: PointerEvent): void
}

/** 控制器操作 View 的接触面：54 个成员（P5 第四片后只剩方法 + 视口 + 两个依赖） */
interface GestureHost {
  session; host;                           // 公共依赖（host = 画布宿主元素）
  ox; oy; zoom;                            // 视口（所有权仍归 View：视图变换是渲染的事）
  onFramePreview;                          // 四指手势成功后回调的帧预览
  // 方法：坐标与渲染（evPt / screenToPixel / canvasAtScreen / clampView / refresh /
  //   drawOverlay / repaintStroke / drawPathPreview / syncCursor / labelFor / toolNow /
  //   isPathTool / preciseDrag / vpW / vpH）、长按（cancelHold / holdMoved / armHold /
  //   cancelPickTimer / enterPickMode / samplePickCell）、喷枪、各工具动作体
  //   （outlineDown / pathDown / selDown / startSelMove / endSelDrag / isoDragTo /
  //    resizeHit / symHit / tryStartXf / xfMove / warpStartMove / wireRedirect …）
}
```

**所有权口径（P5 第四片，2026-09-14）**：

- 触点会话状态是**控制器的字段**，不是 `View` 的：`view.gesture.xf` / `view.gesture.selDrag` 这样的
  读取是「渲染层读输入层的会话状态」（覆盖层每帧都要画它，直接读字段比造一套信号便宜）；
  **写入只允许控制器自己做**，别处要改状态就给它加方法。
- 这样 `GestureHost` 从 93 个成员瘦到 **54 个**（剩下的是 `session` / `host` / 视口三元组 /
  `onFramePreview` + 各动作体方法）—— 接口小到能一眼看完，也就真的成了「契约」而不是「字段清单」。
- 结构体类型（`XfSession` / `SelDragState` / …）与状态放在同一个文件里，改状态机时不用来回跳。

口径（**逐字搬迁，不是重写**；分支顺序、阈值、副作用顺序与搬家前一致）：

- `View` 的四个公开入口（`onDown` / `onMove` / `onUp` / `onCancel`）保留为**一行转发** ——
  `bind()` 与 `dispatchPointer()`（临时工具笔画的合成事件）都走它们，`tests/view.test.ts` 那套
  DOM 桩驱动的回归也照旧可用。
- 触点会话**状态仍留在 `View`**（覆盖层要读 `stroke` / `selDrag` / `xf` / `outline` 等来画），
  控制器通过 `GestureHost` 读写它们；**想让控制器多碰一个成员，先在接口里声明**。
- 各工具的动作体（起笔迹、开始选区拖动、变换抓手解算、等距抓手、画布调整）仍然在 `View`/`tools`，
  控制器只负责"什么时候轮到谁"。
- 会话状态的结构体（`ResizeDragState` / `SelDragState` / `IsoDragState` / `OutlineState` /
  `PathState` / `HoldState` / `XfDragState` / `XfSession`）也一并搬进本文件 —— 以前它们内联在
  `view.ts` 的字段声明里，占掉近百行。
- 假 host 回归（`tests/gesture-host.test.ts`，22 条断言）只驱动多指与视口几条契约：
  四指成立**还原视口**（第 5 片手指落下时恢复第一根手指落下那一刻的 `ox/oy/zoom`）、
  四指期间 `onMove` 不 pinch 不 pan、`fourArmed` 需要两根手指各自离开落点超过阈值、
  pinch 以中点不动点缩放并夹在 `zoomMin..zoomMax`、单指平移与 PC `mousePan` 交还。

**还没搬的（P5 收尾）**：触点会话状态本身（`pointers` / `pinchBase` / `fourSeen` …）与
`xfDrag` / `selDrag` / `outline` / `path` / `resizeDrag` / `isoDrag` 这些**状态字段的所有权**——
它们被覆盖层绘制读着，要先把 `View` 的绘制也拆出去才能一起挪走（见 `docs/ARCHITECTURE.md` P4/P5）。

---

## 16. IO

### 16.1 原生桥接 `src/io/bridge.ts`

```ts
toast(msg: string): void
vibrate(ms: number, tag = "调用"): boolean   // 先走原生桥，失败再退 navigator.vibrate；tag 进诊断环
canVibrate(): boolean | null                // null = 无法判断
hapticReport(pref?: { on: boolean; len: number }): string
hapticLog: HapticEvent[]                    // { tag, ms, ok }，最多 12 条（诊断用）
saveBytes(name, mime, bytes: Uint8Array, onDone?: (ok: boolean) => void): void
openFile(mime = "*/*"): Promise<OpenedFile | null>       // { name, mime, bytes }
b64FromBytes(bytes): string; bytesFromB64(b64): Uint8Array
```

`window.PixelBridge`（Android 注入）：`saveFile(name, mime, base64, reqId)`、`openFile(mime)`、`toast(msg)`、`vibrate(ms)`、`hasVibrator()`、`keepAwake(on)`、`insets()`、`setImmersive(on)`。
网页端自动降级：`saveBytes` → `<a download>`；`openFile` → `<input type="file">`。

震动统一走 `Session.hapticTick(tag, scale = 1)`：受设置 `gesture.haptic` 开关控制，脉冲长度取 `prefs.hapticLen`（30 / 60 / 100ms，默认 60；部分机型 30ms 以下无感）。
`Session.runGestureAction()` 会为除 `pickColor`（取色时逐像素自行震动）之外的每个手势先发一次脉冲。

### 16.1b0 PC 拖放与剪贴板

- **拖放打开**：`App.tsx` 监听窗口的 `dragover/dragenter/dragleave/drop`，拖动中显示 `.drop-hint` 提示层，
  松手后用 `File.arrayBuffer()` 取字节并交给 `modals.tsx` 新导出的 **`openFileBytes(name, bytes, mode, mime)`**
  ——它与「打开」文件选择框走的是同一套逻辑（`.pxc` 工程 / GIF 多帧 / PNG 等静图、或导入为图层）。
  `openFlow()` 现在只是 `bridge.openFile()` + `openFileBytes()` 的薄包装。
- **剪贴板**：`Ctrl+C` 把选区复制成 `Cel` 并写进系统剪贴板（`io/clipboard.ts` 的 `writeClipboardPng`）；
  `Ctrl+V` **优先读系统剪贴板**（`navigator.clipboard.read()` → `image/*` → `createImageBitmap` →
  `ImageData` → 合成 `Cel`），取不到再回退到应用内剪贴板（`SESSION.clip`），最后调用
  `selOps.paste()` 落到当前图层/帧并记一条历史。浏览器可能因权限拒绝读取，此时给 toast 提示。

### 16.1b1 键盘快捷键 `src/app/shortcuts.ts`

PC 模式的键位映射是纯函数 `shortcutFor(key, typing)`，宿主（`App.tsx` 的一个全局 keydown 监听）把它翻译成
Session/View 调用：

| 键 | 动作 |
|---|---|
| Ctrl+Z / Ctrl+Shift+Z（或 Ctrl+Y） | 撤销 / 重做 |
| Ctrl+S | 保存工程 |
| Ctrl+C / Ctrl+V | 复制选区 / 从剪贴板粘贴 |
| Delete / Backspace | 删除选区内容 |
| Esc | 取消选区（弹窗的 Esc 关闭由 Dialog 自己处理） |
| `+` / `-` / `0` | 放大 / 缩小 / 适配画布 |
| Tab | 隐藏界面（专注模式，`.app-root.chrome-off`） |
| 方向键（Shift 加速到 10px） | 平移选区框；没有选区时轻微平移视图 |
| 字母键 | 工具切换（`TOOL_KEYS`：B 铅笔、E 橡皮、G 油漆桶、I 取色、A 喷枪、L 直线、R 矩形、O 椭圆、C 圆形、P 多边形、Y 折线、U 曲线、M 选区、W 魔棒、Q 套索、H 轮廓填充） |

在输入框里只放行 Ctrl/Cmd 组合（不会打断打字）；Alt 组合一律不处理（留给浏览器）。

### 16.1b1c 导出预算 `src/io/exporters.ts`

```ts
MAX_IMAGE_PIXELS = 16 * 1024 * 1024   // 单图上限（≈4096×4096）
MAX_TOTAL_PIXELS = 48 * 1024 * 1024   // 动画/精灵表总上限
MAX_LAYER_FILES  = 12                 // 分图层导出超过这个数先确认
exportBudgetError(w, h, scale, frames, kind): string | null   // 纯函数，超限返回原因 key
yieldToUI(): Promise<void>            // 逐帧循环里让出事件循环
```
`encodeGIF` 的调色板映射用 5bit 色立方的**洪水填充查找表**（32768 格全部有值），
每像素 O(1)；旧实现表命中后仍然完整扫描调色板，百万像素就是上亿次比较。

### 16.1b1a 自定义快捷键 `app/keymap.ts`

```ts
type Keymap = Record<string, string>          // action -> "ctrl+shift+z"
REBINDABLE: readonly string[]                 // 可改键的动作（无 payload 的那些）
chordOf(e): string | null                     // 事件 -> 组合键字符串（修饰键单独按返回 null）
chordLabel(chord): string                      // "ctrl+arrowleft" -> "Ctrl+←"
defaultChordOf(action): string | null          // 默认键取自 SHORTCUT_SHEET 的 probe
chordForAction(action, keymap): string | null  // 现在生效的键（自定义优先）
actionForChord(chord, keymap): string | null   // 这个组合键归谁
bindChord(action, chord, keymap)               // 成功返回新 map，冲突返回 { ok:false, clash }
unbindChord(action, keymap) / overrides(keymap)
```
`shortcutFor(e, typing, keymap?)` 会先查自定义绑定；**被改走的动作，它的默认键同时失效**
（默认键只是兜底）。用户的覆盖存在 `prefs.keymap`，随设置一起持久化。

`pieLaunch`（按住发动快捷圆盘，默认 `f`）也在同一张表里，因此可以在同一个面板里改键。

### 16.1b1b 快捷键一览 `SHORTCUT_SHEET`

`src/app/shortcuts.ts` 里除了 `shortcutFor`，还导出面板数据 `SHORTCUT_SHEET`
（分组 + 每行 keys/中英文案；键盘行带 `probe`/`action`，测试会逐行验证它真的能
触发）。`Ctrl+F1` 或主菜单「快捷键一览」打开（`ui/modals.tsx` 的
`ShortcutHelpModal`，PC 左类别右列表、手机单列分组）。

### 16.1b2 PC 模式 `src/io/pcmode.ts`

桌面增强（滚轮缩放、悬停提示、中键/空格平移、右键背景色绘制、键盘快捷键、放大的浮动球、桌面化尺寸）
统一由这一个开关驱动，状态写在 `<html data-pc="1">`，React（`usePcMode()`）与非 React 层（`View`、CSS）读同一个答案。

| 导出 | 说明 |
|---|---|
| `resolvePcMode(mode, finePointer, hover, hints?)` | 纯函数（有测试）：`auto` 下先看真实输入证据（`seenMouse` 粘住为真 → PC；`seenTouch` 或 `navigator.maxTouchPoints > 0` → 触屏），都没有才用媒体查询的「精细指针 **且** 支持悬停」；`on` / `off` 无视一切检测 |
| `normalizePcMode(v)` | 把存储/导入的值规范成 `auto` |
| `pointerCapabilities()` | 读 `(pointer: fine)` 与 `(hover: hover)` 两个媒体查询 |
| `applyPcMode(mode)` / `isPc()` | 写 / 读 `<html data-pc>`；`applyPcMode` 返回解析后的状态 |
| `watchPcCapabilities(getMode, cb?)` | 指针能力变化（插鼠标、切换平板模式）**以及第一个真实指针事件**时重算：手机 WebView 常谎报 `hover: hover`，第一次触摸把它钉在触屏模式，第一次鼠标移动又会切回桌面模式 |
| `notePointerType(t)` / `inputHints()` | 记录 / 读取输入证据（`mouse` 粘住、`touch`·`pen` 只作否决证据） |
| `pcModeOf(prefs)` | 从 `Prefs.pcMode` 取值（`session.ts` 新增字段，默认 `auto`） |

设置项：`display.pcMode`（自动 / 强制开 / 强制关），启动时由 `main.tsx` 应用；
改设置后 `main.tsx` 会通过 `SESSION.subscribe` 重新把结果推给界面层（`setKitPcMode`），
所以浮动球尺寸 / 排布 / 悬停提示会立刻跟着切。

### 16.1c 全屏 `src/io/fullscreen.ts`

浏览器会话（网页 / 已安装 PWA）下的全屏开关；APK 里由原生壳 `setImmersive` 负责隐藏系统栏，
因此**不渲染**这个按钮。

| 导出 | 签名 | 说明 |
|---|---|---|
| `showFullscreenToggle` | `(nativeShell: boolean, supported: boolean) => boolean` | 纯函数：只有「非原生壳 **且** 浏览器支持元素级全屏」时才显示按钮 |
| `fullscreenIcon` | `(on: boolean) => string` | 纯函数：`i-full` / `i-full-exit` |
| `fullscreenSupported` | `() => boolean` | 含 `webkit*` 前缀探测；iPhone Safari 无元素级全屏 → false |
| `fullscreenElement` / `isFullscreen` | `() => Element \| null` / `() => boolean` | 兼容 `webkitFullscreenElement` |
| `fullscreenToggleVisible` | `() => boolean` | `showFullscreenToggle(isNativeShell(), fullscreenSupported())` |
| `requestFullscreen` / `exitFullscreen` / `toggleFullscreen` | `() => Promise<void>` / `Promise<void>` / `Promise<boolean>` | 需要在用户手势里调用；失败静默 |
| `watchFullscreen` | `(cb: (on: boolean) => void) => () => void` | 监听 `fullscreenchange`（含 webkit 前缀），返回取消订阅 |

`src/io/bridge.ts` 另导出 `isNativeShell()`：`window.PixelBridge` 存在即为 APK 壳（由
`MainActivity` 注入），网页端为 `false`。

### 16.1b 全面屏 / 安全区 `src/io/safearea.ts`

```ts
interface Insets { top: number; bottom: number; left: number; right: number }
detectInsets(): Insets                     // 原生 insets() 优先，退回 env(safe-area-inset-*)
applySafeArea(p: { safeArea; safeExtra; immersive }): void
watchSafeArea(get: () => SafeAreaPrefs): () => void   // resize / 旋转时重新应用
```

`applySafeArea` 把结果写成 `<html>` 上的 CSS 变量 `--sat / --sab / --sal / --sar`（px），样式表里所有贴边控件都用这四个变量留白；
`screen.safeArea` 关掉时全部置 0（并加 `.safe-off` 类），`screen.safeExtra` 在检测值上再加 0–40px。
同时它把 `immersive` 同步给原生 `setImmersive()`。

原生侧（`MainActivity`）：API ≥ 28 设 `layoutInDisplayCutoutMode = SHORT_EDGES` 让内容画进挖孔区；
`insets()` 用 `getInsetsIgnoringVisibility(systemBars|displayCutout)`（API < 30 退回 `getStableInsets` + `DisplayCutout`），
所以沉浸式隐藏系统栏后仍能拿到手势条与刘海的安全边距；数值按 density 折算成 CSS px。

### 16.2 导出 `src/io/exporters.ts`

```ts
interface ExportOpts { bg?: RGBA | null; scale?: number; li?: number | null; bounds?: RectLike | null; range?: [number, number] | null }
frameRange(o, count): { from; to; n }            // 越界裁剪 + 自动交换

exportPNG(doc, fi, o): Promise<{ bytes; name } | null>
exportGIF(doc, o): Promise<{ bytes; name }>
exportSheet(doc, o & { cols? }): Promise<{ png; json; name; jsonName } | null>
encodeGIF(frames, w, h, { transparent? }): Uint8Array
pngBytes(canvas): Promise<Uint8Array | null>
sanitizeName(n): string
```

### 16.3 参考图存储 `src/io/refstore.ts`

```ts
interface RefImg { w: number; h: number; px: Uint8ClampedArray; name: string }
interface RefState extends RefImg { x: number; y: number; size: number; opacity: number }

saveRef(state: RefState): Promise<boolean>   // IndexedDB，上限 12MB
loadRef(): Promise<RefState | null>
clearRef(): Promise<void>
```

### 16.4 操作记录编解码 `src/io/historyfile.ts`

```ts
encodeHistory(dump: HistoryDump, w: number, h: number): unknown | null   // JSON 安全（缓冲区 base64）
decodeHistory(raw: unknown): HistoryDump | null
// 依赖 src/engine/b64.ts 的 bytesToB64 / b64ToBytes（纯实现，浏览器与 Node 通用）
```

### 16.5 工程文件 / 自动保存 / GIF 读取 / 剪贴板

```ts
// src/io/project.ts
serialize(doc, history?): Promise<string>   // .pxc（JSON，history 由 historyfile 编码）
parse(text): Promise<Doc | null>
parseProject(text): Promise<{ doc: Doc; history: unknown | null } | null>

// src/io/autosave.ts —— 多版本（环形槽位 + 小索引）
saveAutosave(text, meta, reason?, keep?): Promise<"idb" | "local" | "too-big" | "fail">
loadAutosave(): Promise<AutosaveRecord | null>          // 最新一版
autosaveMeta(): Promise<AutosaveMeta | null>
autosaveVersions(): Promise<AutosaveVersion[]>          // 新的在前（没有 IDB 时是空数组）
readAutosaveVersion(seq): Promise<AutosaveRecord | null>
dropAutosaveVersion(seq): Promise<void>
historySupported(): Promise<boolean>                    // = IndexedDB 可用
clearAutosave(): Promise<void>                          // 最新一版 + 全部历史
const AUTOSAVE_MAX_BYTES = 32 * 1024 * 1024;   // 单份上限
const AUTOSAVE_HISTORY_BYTES = 64 * 1024 * 1024; // 历史总量上限（超了先淘汰最旧的）
const AUTOSAVE_KEEP_DEFAULT = 5, AUTOSAVE_KEEP_MAX = 12;
// 干净退出标记（localStorage，同步写）：启动时 markSessionRunning()，
// 切后台/卸载时 markCleanExit()；wasCleanExit() 在启动自检里读，false = 上次崩了
markSessionRunning() / markCleanExit() / wasCleanExit(): boolean
// 后端无关的版本逻辑（测试用内存后端直接驱动，见 tests/autosave.test.ts）
hashText(s): string
readIndex(kv) / pushVersion(kv, rec, reason, opts) / listVersions(kv) / readVersion(kv, seq) / dropVersion(kv, seq)
interface AutosaveKv { get(k); put(k, v); del(k) }
interface AutosaveVersion { seq; slot; savedAt; bytes; hash; name; w; h; frames; layers; reason }

// src/io/gifread.ts
interface GifData { w; h; frames: Array<{ data: Uint8ClampedArray; delayMs: number }> }
tryReadGif(bytes): GifData | null

// src/io/clipboard.ts
writeClipboardPng(canvas): Promise<boolean>
```

**多版本自动保存的存储布局与口径**（1.1.1.9，真机反馈「只有一份自动保存，改错了没得退」）：

| 项 | 口径 |
|---|---|
| 存储 | 一个 object store（`pixelcraft/autosave`）里：`index` = 版本表（新的在前，只有几十字节/条），`h0`..`h15` = 16 个**环形槽位**装工程数据 |
| 写入 | 每存一次只写**一个**槽位（`seq % 16`），不搬动旧数据；淘汰 = 从索引尾部删版本 + 删它占的槽位 |
| 为什么槽位 16 > 最大保留 12 | 新槽位序号与在册版本序号至少差 13，取模后**不可能**撞上在册版本的槽位（文件头写死的约束，改成相等就会互相覆盖） |
| 内容没变 | 哈希（`hashText`，FNV-1a + 长度）相同 → 只更新「最近保存时间/原因」，**不占新版本、不写大对象**（否则每 5 分钟的定时保存半小时就把槽位填满同一份内容） |
| 淘汰顺序 | 先按「保留版本数」（设置项 `data.autosaveKeep`，1–12）再按总字节（64MB）；**最新一版永远留着** |
| 配额不足 | 写新槽位失败时改成**覆盖最旧那版占的槽位**（它本来就要淘汰），不新增占用；仍失败就 `stored=false`，**旧版本一个都不动**（调用方回落到 localStorage，再失败才提示"存储空间不足"） |
| 崩溃判定 | `pc.autosave.clean`：启动写 `0`、切后台或 `pagehide` 时**先 flush 再写 `1`**。后台被系统杀掉不会误报（隐藏前已存过一份） |
| 兼容 | 旧版本只写 `current`：第一次读到时迁移成第 1 版并删掉它；localStorage 兜底路径仍是单槽位（`historySupported()` 为 false，面板提示"当前环境不支持历史版本"） |

### 16.6 Aseprite 文件 `src/io/aseread.ts` + `src/io/asewrite.ts` + `src/io/zlib.ts`

按官方规范实现（<https://github.com/aseprite/aseprite/blob/main/docs/ase-file-specs.md>，对照
Aseprite 自身 `src/dio/aseprite_decoder.cpp` / `aseprite_encoder.cpp` 校对）：

```ts
// ---- 读取：纯逻辑、无 DOM、同步（cel 由自写 inflate 解压，不依赖 DecompressionStream）
const ASE_MAGIC = 0xa5e0, ASE_FRAME_MAGIC = 0xf1fa, ASE_MAX_SIZE = 1024;
isAseBytes(b: Uint8Array): boolean          // 看 header 里的魔数（扩展名不对也能认出来）

parseAse(bytes): AseFile | null             // 头部 / 帧头 / 分块；不认识的块按 size 跳过
aseToDoc(file: AseFile): Doc | null         // 转成 PixelCraft 文档（>1024² 返回 null）
readAseDoc(bytes, name = "sprite"): AseImport  // 上面两步 + 文件名；失败给 i18n key
                                               // { ok, doc?, reason?: "aseBad" | "aseTooBig",
                                               //   layers?, frames?, cels?, tags? }

interface AseFile { w; h; bpp /* 32 RGBA / 16 灰度 / 8 索引 */; transparentIndex; speed;
  layers: AseLayer[]; frames: { durationMs }[]; cels: AseCel[]; palette: RGBA[] | null; tags: AseTag[] }
interface AseLayer { name; visible; editable; background; opacity /* 0-255 */; blend; group; tilemap; reference; childLevel }
interface AseCel { li; fi; x; y; w; h; opacity; rgba: Uint8ClampedArray }  // 已按索引色/灰度转成 RGBA
interface AseTag { name; from; to; direction /* 0 正向 1 反向 2 乒乓 3 反向乒乓 */; repeat; color? }

aseBlendName(code: number): BlendMode       // ASE 0-18 → PixelCraft 混合模式（不支持的落回 normal）

// ---- 写入：可被 Aseprite 直接打开（third-party 解析器交叉验证过）
celBounds(cel): Rect | null                 // 非透明像素包围盒（空 cel 返回 null）
writeAse(doc, { compress = true } = {}): Promise<Uint8Array>
// 图层顺序/名称/可见性/不透明度/锁定/混合模式、逐帧时长、调色板、动画标签都会写出；
// cel 按内容裁剪，默认 zlib 压缩（cel type 2），平台没有 CompressionStream 时自动退回未压缩（type 0）；
// 文档底色 doc.bg 会写成一个真正的 "Background" 图层（Aseprite 没有“文档底色”这个概念），保证外观一致；
// doc.tags 写成 0x2018 标签块（Aseprite 的顺序：调色板 → 标签 → 图层），方向/重复次数/颜色一起写。

// ---- zlib（io/zlib.ts）
inflateZlib(src, outSize): Uint8Array | null  // RFC1950/1951，自写 inflate（存储块/固定/动态霍夫曼）
deflateZlib(src): Promise<Uint8Array | null>  // CompressionStream("deflate")，不支持时返回 null
canDeflate(): boolean
```

打开流程（`ui/modals.tsx` 的 `openFileBytes`）先按魔数判断 Aseprite，再走 `.pxc` / GIF / 静态图；
`mode: "layer"` 时把第一帧拍平成一张图层加入当前画布（尺寸不符则提示失败）。导出侧在
`ui/modals.tsx` 的导出弹窗里是第 5 个页签（`exporters.exportASE`），缩放 / 背景 / 帧范围对它不适用。

### 16.7 动画标签 `src/engine/tags.ts`

标签 = 一段**有名字的帧范围**（0 基、含首含尾），和 `.aseprite` 的 tag 块一一对应。纯函数，无依赖：

```ts
const TAG_COLORS: string[];                       // 编辑器的 6 个标签色
tagAt(tags, fi): FrameTag | null                  // 帧落在哪个标签里
tagById(tags, id): FrameTag | null
nextTagName(tags, base): string                   // "动画 1" / "Tag 1"…取第一个没被占用的编号
clampRange(from, to, count): { from, to } | null   // 自动交换倒序、夹到帧数内；空返回 null
normalizeTags(tags, count): FrameTag[]            // 丢掉空标签、夹范围、按帧序排序
tagsAfterInsert(tags, at): void                   // 插入帧：后面的标签整体后移，跨过的标签变长
tagsAfterRemove(tags, fi, count): FrameTag[]      // 删除帧：标签缩短，只剩一帧的标签消失
tagRangeLabel({from,to}): string                  // "3–7"（1 基，跟时间轴一致）
tagLanes(tags): { lanes, laneOf: Map<id, lane> }  // 重叠的标签分层排（时间轴每条标签一行），不叠在一起
```

`Doc.tags` 参与 `capture()` / `restore()`（结构历史可撤销）、`.pxc` 的 `tags` 字段、
以及 Aseprite 的 0x2018 块。**帧的结构操作统一在 `engine/ops.ts` 里维护标签范围**
（`addFrame` / `duplicateFrame` / `removeFrame` / `moveFrame`），所以时间轴拖拽、批量删除、
历史回放都不会把标签留在一个非法范围上。

### 16.8 播放范围 `src/app/playback.ts`

```ts
interface PlayWindow { from; to }                              // 闭区间
fullWindow(count): PlayWindow                                  // 整条时间轴
windowOf(tag | null, count): PlayWindow                        // 标签 → 它的范围；null/非法 → 整条
startPlayFrameIn(mode, fi, w): number                          // once 停在窗口末帧时回到窗口首帧
nextPlayFrameIn(mode, fi, dir, w): PlayStep                    // 循环/乒乓都在窗口内绕回
// 旧签名 startPlayFrame / nextPlayFrame 保留，等价于传入整条时间轴
```

`Session.startPlayback(tag?)` 的取范围规则：**显式传入的标签永远优先**（点标签条＝播它，
即使别的标签覆盖同样的帧）；**不传**时（播放按钮）才按当前帧推：帧在某个标签里就循环那个标签，
不在任何标签里就播整条时间轴（重叠时的「第一个匹配」只在这个推导路径上出现）。
`tickPlay()` 每帧按该窗口推进，所以「从标签内的帧起播＝只循环这一段」。播放窗口只影响播放，
手动切帧/时间轴浏览不受限制。**播放中点到别的标签的帧**（`setFrame` 在 `playing` 时会调
`retargetPlay`）会把窗口换成那个标签并重新计时，也就是「切动画」；**点到当前正在播的标签内的帧则保持不动**
（重叠时不会因为「按帧优先」被悄悄换成另一个标签）；点到所有标签之外的帧回到整条时间轴。
`Snapshot` 暴露 `tags`、`activeTag`（正在播的标签优先，否则当前帧所在标签）、`playTag`（正在播放的窗口）。

时间轴上的循环按钮按模式换图标：`once` → `i-loop-once`、`loop` → `i-loop`、
`pingpong` → `i-loop-pingpong`、`reverse` → `i-loop-reverse`（都在 `app2/www/index.html` 的 symbol 里）。

标签条的手势（`ui/timeline.tsx`）：**左键/轻点 = 播放这一段**（`Session.tagPlay`）、
**拖左右边缘 = 改范围**（`Session.tagSetRange`，一次拖动只记一条历史）、
**右键 / 长按 = 打开 `TagModal`**（改名 / 颜色 / 删除 / 选中这些帧）。
边缘判定用标签条自身的 `getBoundingClientRect()`（两侧各 10px，短标签最多占 1/3 宽），
拖动时按 `.ase-numcell` 的列矩形换算目标帧（`frameAtX`），左右边不交叉、越界夹到时间轴两端。

---

## 17. UI 层与事件契约

### 17.1 组件

| 组件 | 文件 | 说明 |
|---|---|---|
| `App` | `ui/App.tsx` | 组合视口 / 工具条 / 时间轴 / 浮动球 / 弹窗 / 引导 |
| `TimelineBar` | `ui/timeline.tsx` | 图层×帧矩阵、播放控制、多选帧工具条 |
| `modals.tsx` | `ui/modals.tsx` | 调色板、菜单、尺寸、精灵表、导出、设置、帧时长、帧预览、历史 |
| `GuideOverlay` | `ui/guide.tsx` | 高亮引导引擎（含 `simulateTap`） |
| `GuideDemo` | `ui/guide-demo.tsx` | 虚拟触点动画 |
| `View` | `render/view.ts` | 画布视口（非 React 组件） |
| `HsvWheel` / `HoldAdjust` / `PreviewBox` / `RefImageBox` / `ReplayOverlay` | 各自文件 | 色轮、长按拖动数值、预览浮窗（右上角按钮 = 二级菜单：白底/黑底/格子底 + 灰度预览，灰度只作用于画面本身）、参考图、历史回放 |
| `TabBar` / `DropMenu` | `ui/tabs.tsx` | 共用选项卡与可展开下拉（色板 / 导出 / 更新日志 / 播放速度）。**下拉列表用 `createPortal` 挂到 `document.body` 并 `position:fixed`**（坐标按按钮的视口位置算）：时间轴控制条是 `overflow-x:auto` 的滚动容器，绝对定位的列表会被它整块裁掉——「播放速度色片点了没反应」就是这么来的；任何放在滚动容器里的下拉都靠这条活着 |
| `ChangelogModal` | `ui/changelog.tsx` | 更新日志：`CHANGELOG`（`ClgVersion[]`，每项 `it(kind, zh, en)`）+ `APP_VERSION` / `BUILD_TAG`；PC 竖排版本列表、触屏横向标签条，分类（add/imp/fix）可折叠。**条目文案是纯文本渲染**（`<li>{x.zh}</li>`，没有 Markdown 解析）——`**加粗**` 与反引号会原样显示，所以文案里不许出现它们，测试 `tests/changelog.test.ts` 会拦（同时校验 `APP_VERSION` 与 `AndroidManifest.xml` 的 `versionName` 一致、条目单行格式、中英一一对应） |
| `ColorAdvancedModal` | `ui/modals.tsx` | **颜色高级模式**：一个弹窗两页（`AnalysisPane` 颜色分析 / `ShadingPane` 色彩明暗），`initialTab` 决定落在哪页；两页**按需挂载**（分析页要扫画布，不该在明暗页白跑）挂上后不再卸载。入口＝调色板面板动作行的一条 + 主菜单一条（`openColorAdv()` → `pc-color-adv`；`openShading()` → `pc-shading` 直接落明暗页），App 侧只挂一个 `Keep`。算法仍然分别在 `engine/color-analysis.ts` 与 `engine/shading.ts` |
| `IsoBar` | `ui/iso.tsx` | 等距图形模式的**参数条**（常驻浮层，不是弹窗——模式的手感全在画布上）：形状 chips（6）/ 宽深高 / 图块 4·8·16·32 / 实时读数（尺寸·体素·越界）/ 折叠外观（颜色模式、三面颜色、明暗、阴影、描边、形状专属参数）/ 生成 / 生成到新图层 / 完成。入口＝魔法球「等距图形」+ 主菜单。动作图标走 `feature-icons.ts`（§17.5） |
| `AutosaveHistory` / `RecoverModal` / `AutosaveModal` | `ui/modals.tsx` | 自动保存的**多版本历史**（一列：时间 / 大小 / 工程名 + 恢复·导出·删除）与两个入口：设置 → 数据 里内嵌、主菜单「自动保存历史」（`AutosaveModal`）、以及启动时「上次没正常退出」的恢复面板（`RecoverModal`，由 `SESSION.bootRecover` 驱动）。数据在 `io/autosave.ts`（§16.5），组件只负责列出来与发指令 |
| `useBlankTap` | `ui/base.tsx` | 点容器空白处执行动作（调色板面板点击关闭） |
| 时间线分割线 | `ui/App.tsx`（`.tl-grip`） | 时间线面板顶部的拖动条：上下拖动 = `setTlHeight()`（面板总高度 140–520px，默认 200），拖动时显示 px 浮标，双击复位 200；`prefs.tlH` 是整块面板高度，矩阵 `flex:1` 填充，图层行不足时用 `.ase-fill` 单元格补底 |
| 安全区 | `io/safearea.ts` | 把原生 insets 写成 CSS 变量 `--sat/--sab/--sal/--sar`，贴边控件统一用它们留白 |

### 17.2 自定义事件

| 事件 | 方向 | 载荷 | 用途 |
|---|---|---|---|
| `pc-toast` | 任意 → UI | `string` | 显示 Toast（无原生桥接时也可用） |
| `pc-save` / `pcopen` | 原生 → JS | `{ ok, name?, mime?, data? }` | 保存 / 打开文件回调 |
| `pc-guide-tools` | 引导 → 浮动球 | `"open" \| "close" \| "shape" \| "select" \| "back" \| "closeall"` | 引导控制工具环 |
| `pc-guide-undock` / `pc-guide-redock` | 引导 → 浮动球 | – | 引导期间弹出 / 还原停靠球 |
| `pc-guide-menu-sub` | 引导 → 菜单 | `null \| "import" \| "export"` | 切换菜单二级页 |
| `pc-back` | 原生 → UI | `{ handled: boolean }` | 返回手势：监听者把 `handled` 置 true 表示已消费 |

### 17.3 引导动作实现约定

`App.tsx` 的 `guideActions` 里每个动作必须：

1. 执行**真实操作**（必要时用 `simulateTap(selector)` 派发 pointerdown/up/click）；
2. **自还原**，且还原前检查当前值是否仍是演示所设的值（用户或下一步改过就不动）；
3. 会盖住画面/改动内容的用 `peek: true` 或只做高亮；
4. 演示放 `before`（放 `after` 会被下一步遮罩盖住）。

### 17.4 i18n

`src/ui/i18n.ts` 导出 `makeT(lang)`，`Dict` 为递归结构；所有面向用户的字符串都走 key，中英各一份。新增文案 = 两个字典各加一条。

### 17.5 功能图标表 `src/ui/feature-icons.ts`

```ts
const FEATURE_ICONS = {
  menu:    { iso: "i-iso", colorAdv: "i-cadv", customise: "i-grid", … },
  palette: { remap: "i-remap", dedupe: "i-dedupe", colorAdv: "i-cadv", … },
  fxOrb:   { iso: "i-iso", outline: "i-fx-o1", … },
  selRing: { gridSnap: "i-snap", mesh: "i-mesh", quad: "i-skew", halfSnap: "i-snap-half", … },
  isoBar:  { generate: "i-plus", newLayer: "i-layers", look: "i-palette" },
} as const;
```

- **每个功能入口一个专属 SVG**，画在 `app2/www/index.html` 的 sprite 里（`<symbol id="i-…" viewBox="0 0 24 24">`，
  用 `fill/stroke="currentColor"` 跟随主题色）。真机反馈：新功能借用旧图标（等距图形曾用 `i-grid`、
  色彩明暗曾用 `i-dedupe`、颜色分析曾用 `i-search`）在菜单里并排出现，根本分不清哪个是哪个。
- 一组 = **同一屏上会同时出现**的一批入口（主菜单首屏 / 调色板动作行 / 魔法球 / 选择球 /
  等距参数条）；**组内图标不得重复**。选择球在电脑模式下四页铺成一屏，所以整组一起算。
- 确实属于同一个动作的入口（自由变换的「重置」与「还原」都走 `View.revertXf()`）用
  `FEATURE_ICONS.selRing.reset` 引用同一个值，不要各写一份字面量。
- `tests/icons.test.ts` 静态校验：组内唯一、每个 id 在 sprite 里存在、`src/` 里出现的所有
  `i-*` 字面量都存在、两个 id 不得共用同一份画稿、以及若干「含义不同必须长得不一样」的图标对。

---

## 18. 多画布空间 / 新工具与特效

### 18.1 表达式求值 `engine/expr.ts`

```ts
normalizeExpr(src: string): string          // 全角/× ÷ − 与空格千分位归一化
evalExpr(src: string): number | null        // 完整算式才返回数值，否则 null
```

文法：`expr → term (('+'|'-') term)*`、`term → unary (('*'|'/'|'%') unary)*`、
`unary → ('+'|'-') unary | pow`、`pow → primary ('^' unary)?`、`primary → 数字 | '(' expr ')'`。
`ui/base.tsx` 的 `ScrubNum` 用它实现「数字框可输入算式」（`expr={false}` 可关闭）。

### 18.2 区域填充与渐变 `engine/paint.ts`

```ts
floodRegion(cel, sx, sy, global, mask?): Array<[number, number]>
interface GradAxis { x0: number; y0: number; dx: number; dy: number }
gradientFillRegion(cel, cells, c0, c1, block, axis: GradAxis | null, mask?): Rect | null
sprayDots(cx, cy, radius, minSize, maxSize, count, rnd, fn): void
```

- `floodRegion` 只收集单元格（不落笔），`global` = 全画布同色而非连通区域。
- `gradientFillRegion` 沿 `axis`（拖动向量）做线性 RGB 渐变，投影超出两端自动钳制；
  `axis = null` 时按区域包围盒自动从上到下；`block` = 取色方块边长（1 = 逐像素）。
- `sprayDots` 在圆盘内均匀采样 `count` 个随机点，每点是一个边长 `[minSize, maxSize]` 的正方形；
  `rnd` 可注入种子，便于测试。

### 18.3 特效 `engine/effects.ts`

```ts
type OutlinePos = "outside" | "inside" | "center";
outlineCel(d, w, h, width, color, pos = "outside"): void
blurCel(d, w, h, radius): void      // 可分离 box 两遍≈高斯，alpha 预乘
dropShadowCel(d, w, h, dx, dy, color, keepOriginal = true): void
```

### 18.4 多画布 `app/session.ts`

```ts
interface CanvasEntry { doc: Doc; x: number; y: number; li: number; fi: number }
interface PreviewEntry { id: string; canvas: number; x: number | null; y: number | null; size: number }

SESSION.docs: CanvasEntry[]   // 全部打开的画布（docIdx 为聚焦项）
SESSION.docIdx: number
SESSION.previews: PreviewEntry[]
awaitColorPick(cb) / cancelColorPick() // 下一次选色改为回调（特效参数用），并派发 pc-color-picked
referenceCanvas(i, {mode}?): boolean  // 引用第 i 张画布（拒绝自引用/循环）；mode="layers"（默认）每个源图层各一条引用层，
                                       // mode="flat" 只引用整张合成画面（编辑落在源画布当前图层）
isRefLayer(li): boolean                // 该图层是否为引用层
strokeTarget(li)                       // 引用层的笔迹落点 {doc, li, fi}（按 refLayer 精确命中）；普通图层返回 null
changedUI()                            // 只推进 UI 版本（rev）；像素没变时用它，别用 changed()
rotateCanvasContent(dir?)              // 旋转当前画布内容 90°（宽高互换、选区跟随，一条历史）
rotateView(step?) / viewRotation       // 视图旋转（0/90/180/270，内容不变）
setIndexed(on) / paletteSnap(c)        // 索引色模式：就近取调色板颜色（保留 alpha）
remapToPalette(scope?)                 // 把已有像素映射到调色板（一条历史）
refSourceLayerOf(li)                   // 引用层镜像的源图层 {name, li}（整张引用时返回 null）
refPaintBlock(li)                      // 为什么画不上：源图层已锁定 "locked" / 已不存在 "gone" / 可画 null
unrefLayer(li?)                        // 解除引用：把画面烘焙进图层（居中、1:1）后断链
unrefAll(): number                     // 一次性解除当前画布的所有引用层（保留画面，一条历史）
extractLayerToCanvas(li?)              // 把图层（含所有帧）提取成独立画布（先确认）

SESSION.doc                   // getter/setter：聚焦画布的文档（旧代码无需改动）
addCanvas(doc, opts?): number         // 在空间里再开一张，返回下标
focusCanvas(i): void                  // 切换聚焦，恢复该画布的图层/帧/撤销栈
renameCanvas(i, name): void
moveCanvas(i, x, y): void             // 拖动标题栏时调用（空间坐标，单位=像素）
closeCanvas(i): boolean               // 关闭一张画布（记一条 "canvas-close" 历史步，可撤销找回；允许关到 0 张 = 空工程）
fitCanvas(): void                     // 缓动缩放视图到聚焦画布的适配大小
toggleCanvasLock(i?) / isCanvasLocked(i?)   // 锁定 / 解锁画布位置（锁定后不可拖动）
snapPosition(i, x, y, tol)            // 拖动时的吸附位置 {x, y, hit}
finishCanvasDrag(i, hit)              // 松手时若与目标贴合则成组
linkCanvas(a, b) / unlinkCanvas(i)    // 手动成组 / 解除吸附
addPreview(canvas?): string           // 每个画布最多一个预览框
closePreview(id) / movePreview(id, x, y) / resizePreview(id, size)
askConfirm(q) / askText(q)            // UI 注册的确认框 / 单行输入框
```

`Session.history` 是**整个工程共用的一条撤销栈**（`History.Entry.doc` 记录该步属于哪张画布；
关闭画布也是一条普通历史步 `canvas-close`，撤销即把该画布（含位置/锁定/吸附组/预览框）放回原位，
直到打开新工程才清空；`dump(docIdOf)` 会跳过不在文件里的画布步骤，`loadDump({docFor})` 让历史随工程存取）；
`changed()` 会把聚焦画布的 `layerIdx/frameIdx` 写回它的 entry。
`docs` 允许为空数组（默认空白工程，`doc` 返回 1×1 占位文档），此时 UI 只渲染空状态卡片。
切换聚焦时 `View.shiftFocus(dx, dy)` 会反向平移视口，保证整个空间在屏幕上不跳动。

### 18.5 工程文件 `io/project.ts`

```ts
interface SpaceEntry { id?: string; doc: Doc; x: number; y: number; li: number; fi: number; hist?: unknown }
serializeSpace(entries, focus, history?, fmt?): Promise<string>  // v3 整个工程；fmt="png"|"rle"（自动保存用 rle）
rleEncodeCel(data) / rleDecodeCel(str, w, h)         // 纯 JSON 像素载荷（自动保存不存图片）
parseSpace(text): Promise<ParsedSpace | null>    // v2 单文档 / v3 多画布都能读
```

工程是唯一的文件单位：单文档的 `serialize/parse/parseProject` 已删除，v2 文件仍可读入为一个单画布工程。
图层的 `id` 与 `refLayer` 会一起存盘（旧文件没有 id 时现场生成），所以「引用画布」的按图层绑定在重新打开工程后依然有效。

### 18.6 视口 `render/view.ts`

```ts
view.onViewChanged: (() => void) | null   // 平移/缩放/尺寸变化后回调（画布标题栏跟随）
view.shiftFocus(dxSpace, dySpace): void   // 切换聚焦画布时保持空间视觉位置
view.fitAnimated(ms = 220) / animateTo(z, ox, oy, ms)  // 缓动适配（双击标题 / 画布球适配）
```

引用层不参与合成器的特殊逻辑：`Session.syncRefLayers()` 会把源画布的画面**镜像进引用层自己的 cel**
（每帧共用同一个 cel，源画布版本号变化时才重新合成），所以渲染路径与普通图层完全一致；
非聚焦画布由
`drawOtherCanvases()` 在合成后绘制（各自缓存，存在引用层时会整体失效），聚焦画布始终画在最上层；
多画布时 `clampView()` 改为「保证包围盒至少露出一角」，即无限空间。

### 18.7 UI 新增

| 文件 | 内容 |
|---|---|
| `ui/fxparam.tsx` | `FxRun` / `FxParamDef` / `FxParamDialog`：特效参数弹窗（int / color / enum），改动即从快照重算并实时预览 |
| `ui/canvas.tsx` | `CanvasTitles`：画布标题栏（点按聚焦、拖动移动画布） |
| `ui/preview.tsx` | `PreviewBox`：按 `SESSION.previews` 渲染多个预览框，每个绑定一张画布 |
| `ui/base.tsx` | `ScrubNum` 支持算式与运算符浮条 |

### 18.6b 浮动球几何与展开锁定

`ui/orb-layout.ts` 新增纯函数 **`orbMetrics(pc)`**：一张尺寸表（主球直径、菜单项直径、内/外环半径、
调色球扇形格距与起始半径、主球避让半径）。触摸端 52/40/86/128/32/46，PC 端 62/48/103/154/38/55
（约 1.2×，排布更散）；`palChipPos(cx, cy, w, h, floaterR?)` 可传入放大的主球半径。
CSS 侧对应 `html[data-pc] .orb{62px}` 与 `html[data-pc] .orb-item{48px}`。

**展开锁定**：主球环展开时右上角出现 `.orb-lock` 小按钮（仅展开时显示，叠在主球边角），
点击后 `ringLock` 为真 —— `closeRadials()` 直接返回，外部点击与其它球的切换都不会再收起主球环；
再点一次解锁，点主球收起时也会自动解锁。锚点 `data-guide="orb-ring-lock"`。

### 18.7a 颜色拖拽填充 `ui/color-drag.tsx`

调色球扇形里的颜色小球与底栏颜色块共用同一个手势实现：按下后移动超过 8px 即为拖拽，跟手显示一枚同色幽灵球，
松手落在画布上就用该颜色执行一次油漆桶填充（`Session.quickFill`）。

| 导出 | 说明 |
|---|---|
| `useColorDragFill({ color, tip?, holdActive?, onFilled? })` | 返回 `{ ghost, dragging, begin, move, end, cancel }`；`ghost` 是要渲染的幽灵球 |
| `holdAllowed(moved, elapsed, holdMs, inside, threshold)` | 纯函数：这一次长按是否成立（时间到 + 手指仍在控件内 + 位移未超过拖拽阈值） |
| `leftRect(rect, x, y, tol)` | 纯函数：点是否已离开控件（默认 4px 容差，抖动不算离开） |
| `DRAG_START` (8) / `TIP_MS` (450) | 拖拽阈值 / 长按提示延迟 |

底栏颜色块还有长按=快捷调色盘（`hold.tsx` 的 `HOLD_MS = 330`）。两者互斥的规则是：

- 长按计时器到点时用 `holdAllowed()` 复核：**手指已移动超过 8px 或已经离开按钮 → 不呼出调色盘**，手势归填充拖拽；
- 调色盘已经打开时（`holdActive` 为真）填充拖拽不会启动，移动仍然调节色盘；
- 因此不存在「拖到一半突然弹出调色盘」或「松手后什么都没发生」的中间态。

### 18.7b1 可编辑界面 `app/uibar.ts`

```ts
interface UIAction { id: string; icon: string; label: string; desc?: string; guide?: string }
TOPBAR_ACTIONS / CBAR_ACTIONS        // 顶栏与底栏（全局按钮）的注册表
ORB_IDS                              // main / sel / pal / fx / canv
LAYOUT_KEYS / DEFAULT_LAYOUT         // top / bar / timeline / dock / orbs / titles
normalizeLayout(v) / isDefaultLayout(l)
orderedActions(all, order?, hidden?) // 应用用户顺序与隐藏
fullOrder(all, order?)               // 补全成完整 id 列表（新动作自动排到末尾）
moveId(all, order, id, delta)        // 在完整列表里上下移动（隐藏项也占位）
toggleHidden(hidden, id) / visibleCount(all, hidden)
```

存储模型：`prefs.barOrder` 保存**完整** id 顺序（含隐藏项），`prefs.barHidden` 保存被
隐藏的 id，`prefs.orbPrefs[ball]` 是每个浮动球的 `{ order, hidden }`。因此隐藏再恢复
位置不变，新版本新增的动作会自动出现在末尾而不会丢失。界面定制的入口是主菜单 →
「界面定制」（`CustomiseModal`，布局/工具栏/浮动球三个分页），面板里每一项也能用
↑↓/眼睛按钮调整。

**在界面上直接拖动**：面板里的「在界面上直接拖动排序」会打开编辑模式
（`Session.uiEdit`，不持久化，Esc 或「完成」退出）。开启后：
- 顶栏与底栏按钮出现虚框与 × 角标，**按住拖动越过邻居中点即实时换位**
  （`dropIndexAt` + `stepsBetween`，抬手时吞掉那次点击，不会误触发按钮功能）；
  末尾的 + 号列出被隐藏的按钮，点一下放回；
- 浮动球的子项同样可以拖动换位（按圆环最近槽位判定 `nearestSlotIndex`），角标 × 隐藏；
- 拖动一律基于**完整**的排序列表（含隐藏项），所以隐藏项的位置不会被打乱。

### 18.7c 快捷圆盘（Pie）`ui/pie-layout.ts`

PC 专属的 Blender 式饼菜单：浮动球存储区边的**装备槽**里装备一个球，按住发动键
（默认 **F**）时该球所有子项以圆环铺在屏幕正中、鼠标隐藏，鼠标方向决定聚焦项，
松开激活、中间死区松手即取消、Esc 取消。

| 导出 | 签名 | 说明 |
|---|---|---|
| `pieRadius` | `(vw, vh) => number` | 环半径（屏幕短边 36%，夹在 150..380） |
| `pieRadiusFor` | `(vw, vh, count, item?) => number` | 在上面的基础上保证 `count` 个子球互不重叠且不出屏 |
| `PIE_ITEM` | `58` | 一个圆盘子球的直径（与 `.pie-item` 一致） |
| `pieSlot` / `pieSlots` | `(index, count, cx, cy, radius)` | 均分槽位，第 0 项在正上方、顺时针 |
| `pieFocusIndex` | `(px, py, cx, cy, count, radius) => number` | 聚焦项下标；`-1` = 死区（0.34R 内） |
| `pieSlotGap` | `(count, radius) => number` | 相邻槽位间距（用于保证 24 项也不挤） |

`PIE_DEAD = 0.34` 是死区比例。装备状态存在 `localStorage["pc.pie.ball"]`。

子球直径与半径可以在设置里调：`display.pieItem`（36–96px，默认 58）与
`display.pieRadius`（0 = 按屏幕与数量自动适配，>0 用该像素值）。App 渲染圆盘时
把 `pieItem` 写成每个子球的 inline 尺寸、图标按 `item*0.42` 缩放，聚焦判定与绘制
共用同一个半径函数（`radiusFor`），所以「看着在球上但没聚焦」不会发生。

### 18.7b 画布空间命中测试 `app/canvas-space.ts`

纯函数，视图变换以**聚焦画布**为锚点（它的矩形恒为 `0,0..w,h`），所以屏幕点要先换算成空间坐标：

| 导出 | 签名 | 说明 |
|---|---|---|
| `canvasAtScreen` | `(docs, focusIndex, ox, oy, zoom, sx, sy) => number` | 屏幕点下的画布下标（`-1` = 空白；后画的在上，重叠时取后者） |
| `screenToCanvas` | `(…) => { index, x, y } \| null` | 同上，并给出画布内的像素坐标（`0..w-1`） |

`View.canvasAtScreen()` 与调色球拖拽都走这里，保证「这个点属于哪张画布」只有一份实现。

**跨画布移动选区**（1.0.8.6 起，PC 与触屏都支持）：`View.onUp` 收尾时若发现
「正在拖动的浮动选区块（`selDrag.kind === "move"` 且已 `floatCut`）松手点落在**别的**画布上」，
就走 `View.dropSelDragToCanvas()`：源画布留下空洞并记一条 `sel.move` 历史（`floatCut` 已经挖掉了像素），
再 `focusCanvas()` 到目标画布并用 `floatDropInto()` 落笔（同一屏幕位置，落点顶左越界按边缘裁剪）。
目标画布当前图层锁定时整个移动作废（`endSelDrag(false)` 把像素放回，并 `Session.note()` 提示）。
落点是否跨画布由 `screenToCanvas()` 判定，同画布内拖动仍走原本的原地落笔。
拖动过程中 `View.dropTargetOf()` 会算出「现在松手会落在哪」，`drawOverlay` 用它
实时画半透明落点幽灵 + 目标画布虚线框——预览与实际落笔共用同一份计算。

### 18.8 吸附设置

`canvas.snapOn`（总开关）、`canvas.snapRange`（4–48 屏幕像素）、`canvas.snapGap`（0–48 画布像素）、
`canvas.snapInColor` / `canvas.snapOutColor`（`kind: "color"`，`#rrggbb`，非法值被拒绝）。

`src/app/canvas-snap.ts` 另外导出：

| 导出 | 说明 |
|---|---|
| `SNAP_GAP` (8) | 左右并排时两张画布之间的空隙 |
| `TITLE_EXTRA` (10) | **上下叠放**时额外留出的空隙：下面那张的标题栏要放进这段空隙里 |
| `SNAP_GAP_V` (18) / `stackGap(gap)` | 叠放空隙 = 配置空隙 + `TITLE_EXTRA`（18 ≥ 紧凑标题栏 16px + 两侧各 1px） |
| `LEGACY_TITLE_EXTRA` (20) | 旧版本的这个常量（曾让叠放空隙到 28px），只给一次性迁移用 |
| `tightenLegacyStack(items, gap, delta?)` | 一次性迁移：把还停在旧叠放空隙上的**成组**画布往上收（链式/网格按层数累加），返回每个矩形的新 `y`；纯函数、幂等 |
| `titleObstacle(self, others, lift)` | 找出「位于正上方、横向会被标题栏压到」的画布里最深的下边缘（`null` = 无遮挡） |
| `titleTop(canvasTop, obstacleBottom, lift, pad, barH)` | 标题栏纵向位置：空闲时 `上沿 − 30`，有遮挡时落在空隙内（既不压邻居也不压自己） |
| `TITLE_H` (26) / `TITLE_H_TIGHT` (16) / `TITLE_LIFT` (30) | 标题栏高度（常规 / 挤进叠放空隙时的紧凑态）与默认抬升量 |

上下叠放的空隙之所以比左右大，是为了把下面那张的标题栏放进空隙里。**让位的是标题栏**：
`titleObstacle` 一旦报出上方有邻居，`CanvasTitles` 就给它加 `.tight`（16px 高、按钮 14px、图标缩小），
于是叠放空隙只需要 18px（原来是 28px）。老工程里停在旧空隙上的成组画布由 `loadProjectText` 调
`tightenLegacyStack` 收拢一次——只动成组的、且正好卡在旧空隙上的画布，手动摆的位置不碰，幂等。

叠放方向的两个「贴边」候选允许更大的容差（`touchOk`）：把两张画布**推开**的修正量可以比 `snapRange`
多 `TITLE_EXTRA`，否则拖到邻居身边时永远够不到更大的叠放空隙。`Session.canvasesTouch` 也用
`stackGap()` 判断，保证叠放后能正常成组。

叠放方向的两个「贴边」候选允许更大的容差（`touchOk`）：把两张画布**推开**的修正量可以比 `snapRange`
多 `TITLE_EXTRA`，否则拖到邻居身边时永远够不到更大的叠放空隙。`Session.canvasesTouch` 也用
`stackGap()` 判断，保证叠放后能正常成组。

### 18.11 自由变换 / 网格变形（`src/tools/warp.ts`）

| 导出 | 说明 |
|---|---|
| `Pt` / `Mat3` | 点与 3x3 矩阵（行主序，仿射与单应共用） |
| `homography(from, to)` | 四点对应解出单应矩阵（解 8x8 方程组）；退化返回 null。语义：矩阵把 `from` 空间的点映到 `to` 空间 |
| `applyMat(m, p)` | 用矩阵映一个点（含透视除法） |
| `quadArea(q)` / `skewQuad(w, h, "x"\|"y", amount)` | 四边形面积（判退化）与斜切预设（**像素下标口径**：`w×h` 的右下角是 `(w-1,h-1)`） |
| `gridLine(count, i, divs)` | 第 `i` 条网格线在 `0..count-1` 像素下标上的位置（首尾＝`0` / `count-1`，中间按 `i*(count-1)/divs` 取**最近的像素下标**）—— 这是**进入变形时的初始分布**，拖动后各点走 `snapWarpCoord()` |
| `snapWarpCoord(v, half)` | **吸附粒度**：`half=true`（默认）→ `Math.round(v*2)/2`（整数＝像素中心，`x.5`＝两格之间的边界线）；`half=false` → `Math.floor(v)`（整像素）。容差 `1e-9 × max(1, abs(v))` 用来吸掉浮点毛刺 |
| `warpPointFromScreen(sx, sy, zoom, ox, oy, half)` | 屏幕 → 控制点下标：绘制公式 `(q+0.5)*zoom+ox` 的**逆运算**。先反解连续坐标再吸附；两种模式都幂等（抓住控制点不动不跳位） |
| `warpPointRaw(sx, sy, zoom, ox, oy)` | 同上但**不做吸附**（连续下标）—— 拖动浮标 / 算「拖动整块内容」的位移时用 |
| `snapWarpIndex(v, half)` | 连续下标 → 落点：`half` 走 `snapWarpCoord(v,true)`，否则**就近取整**（不是 `floor`，见 `warpPointFromScreen()` 的说明） |
| `warpCoordLabel(p, half)` | 拖动浮标的坐标文案 `"x, y"`（半像素一位小数 `12.5`，整像素整数；`-0` 归一成 `0`） |
| `warpQuad(src, quad, outW, outH, srcQuad?, tieDown?)` | **四点自由变换（斜切 / 透视）**：目标四边形固定顺序（左上→右上→右下→左下），逐目标像素反查源像素，最近邻采样（**就近取整**），画面外保持透明。`tieDown` 见下 |
| `meshWarp(src, grid, outW, outH, divs = 2, tieDown?)` | **网格变形**：`(n+1)²` 个控制点，每个格子拆两个三角形做仿射逆映射 → 拉伸不留洞 |
| `defaultGrid(w, h, divs)` / `pixmapFromCel(data, w, h)` | 默认网格控制点（行主序，四角＝`(0,0)`..`(w-1,h-1)`）与像素块构造 |
| `selOps.warpFloating(doc, st, pts, out, mesh, divs?, halfSnap?)`（`src/tools/select.ts`） | 把浮动内容按画布坐标控制点（**像素下标**，可含 `x.5`）重排进整幅画布的 `out`，并同步 `doc.sel` 掩码，返回点亮的像素下标 |
| `selOps.floatQuad(st)` / `floatGrid(st, divs)` | 浮动内容当前的四角 / 网格控制点（画布坐标，**像素下标**：进入时是整数 `ox..ox+cw-1` / `oy..oy+ch-1`，拖动后按吸附粒度可为 `x.5`） |

**坐标口径（全项目统一，改这里之前先读）**：一律用**像素下标空间，像素中心落在整数坐标上** ——
像素 `i` 的中心就是 `i`，一块 `w×h` 的内容像素下标是 `0..w-1` / `0..h-1`，四角（控制点）就是
`(0,0)`、`(w-1,0)`、`(w-1,h-1)`、`(0,h-1)`（**不是** `w` / `h`）。
`floatQuad()` / `floatGrid()` / `defaultGrid()` / `skewQuad()`、`warpQuad()` 的 `quad` 与默认 `srcQuad`、
`gridLine()` 的网格线全是这一套，所以**进入变形时**控制点落在像素上（不是像素之间的边界上）；
绘制时 `View.warpHandles()` 把下标 `i` 画到屏幕 `(i + 0.5) * zoom + ox`
（那个 `+0.5` 只是「画在像素中心」，不参与任何数学）——**整数下标画在像素中心**，
**`x.5` 正好画在两个像素之间的边界线上**（用户要的「点显示在像素上方」）。
对应地栅格化时目标像素 `(px,py)` 的质心在下标空间里就是 `(px,py)`，反查回源下标后
**就近取整（`Math.round`）**；旧口径（四角是 `w` / `h`、采样用 `floor`）会让控制点卡在半个像素处、
屏幕上吸附到像素边界——这是上一轮报的 bug，不要改回去。

**吸附粒度**（`prefs.selWarpHalfSnap` / 设置项 `tools.selWarpHalfSnap`，默认 **开** = 半像素）：
拖动时 `View.warpMove()` 用 `warpPointFromScreen()` 把屏幕位置反解成**连续**下标（不是
`screenToPixel()` 的 `floor`，那样半个像素的位移会被整个吃掉），再按粒度落点 ——
半像素模式可以落在 `x.5`（细调能停在两格中间的边界线上、拖动浮标显示一位小数如 `12.5`），
整像素模式只落在整数（就是上一轮的行为）。两种模式的落点都是吸附幂等的：抓住控制点不动
不会跳位。半像素位移还有一个**采样约定**（`tieDown`，`warpFloating` 在 `halfSnap=true` 时传给
`warpQuad` / `meshWarp`）：位移带 `0.5` 时目标像素中心恰好压在两个源像素**正中间**，
此时按「目标像素格左沿」取样（`0.5→0`、`1.5→1`、`4.5→4`），于是四角整体挪半格是
「整块内容连边上那一列一起搬过去」——**不丢列、不留洞、像素数守恒**（不这么做时
`Math.round` 一律向上取会把最右那一列顶出源之外）。判据是半点 ± `1e-9` 相对容差，
所以整数位移、斜切、透视、网格拉伸一律走原来的 `Math.round`，行为逐字节不变。
最近邻采样的固有结果是：**恰好半个像素**的整块平移与「量化到一整格」逐字节相同
（目标像素中心正落在两格中间，必须选一边）；真正体现半像素的是**非整块**的形变
（单点拉伸 / 斜切带半点）以及**拖动的跟手程度与显示值**。
`warpFloating()` 的遍历范围仍取控制点下标的包围盒（`floor(min)..ceil(max)` 含端点），
所以恒等变换正好覆盖整个选区、不丢最右 / 最下一列（这是上一轮修的问题，同样不要改回去）。

采样一律最近邻（像素画不允许被插值糊掉）；映射一律「目标 → 源」的逆向映射，所以拉伸时不会出现空洞。
`meshWarp` 的「像素质心是否属于本格」判定放在**源空间**（把质心反查成源坐标后判定是否落在本格的源矩形里），
不在目标空间用重心符号判「在三角形内」—— 两个三角形共用一条对角线，压在对角线上的质心
在两侧权重都是 0，除法舍入误差会把它判成两侧都在外面，恒等变换时表现为丢一列 / 一行。
UI 侧：`View.beginWarp("quad"\|"mesh")` 进入变形（没有浮动选区时自动抓一份），画布上出现
可拖的控制点（四角 / 3×3 网格），拖动时每帧从手势起点那份原图重算预览（不累积误差）；
`View.finishWarp(false)` 落下（一条历史，标签 `sel.warp`）、`finishWarp(true)` 还原。

**控制点的抓取与绘制**（这一轮的修正，逐条对应真机反馈）：

- **抓住就跟手**：控制点直接落在**指针那一点**上（`warpPointFromScreen()` 反解 + 按设置吸附），
  拖到哪就是哪 —— 不记「手指↔控制点」偏移。偏移会让点只是平行跟着手指走，
  落点要靠心算，用户明确要求「它应该要跟随鼠标，而不是向某个方向平移」。
- **命中半径自适应**：默认 22px，但**不超过相邻控制点间距的一半**（下限 8px）——
  小选区上 3×3 网格点只隔十几像素，半径盖满就既保证不了「抓的是最近那个点」，
  也腾不出「按在内容上＝拖动整块」的地方。
- **拖动内容＝整块连控制点一起走**：没抓到控制点、但按在控制点的包围盒内时，
  记下起点的连续下标与当时的全部控制点（`xf.move`），之后每次移动都从起点重算位移
  （不累加、不漂），所有控制点一起平移 —— 于是**锚点跟着内容走**，而不是呆在原地。
  按在包围盒之外仍然是平移视图。
- **拖动期间不自动平移**（见 §10b.4）：视口一动，手指与被抓点之间就多出一段位移，
  点会从手指下面滑走。
- **从变换会话切过来时先烘焙**：已经在「移动 / 缩放 / 旋转 / 斜切」里改了画面时点「网格变形」，
  先把当前的浮动结果（`buf` + `cells` 的包围盒）**烘焙成新的浮动内容**（`st.content` / `st.ox` /
  `st.oy` 就地更新，`st.before` 仍是最初那份、撤销照旧），控制点按**当前**位置重新分布 ——
  否则网格点会落在**变换前**那块内容上，一按就预览回原位（内容「跳回去」）。
- **画在浮动预览之上**：`drawOverlay()` 里浮动内容（`selDrag` 的移动副本、`xf` 的变换 / 变形预览）
  先画，**选区框 / 16 个抓手 / 变形控制点与网格线后画**（见 `docs/UI.md` 的覆盖层顺序）——
  早先控制点画在预览之前，一拖动就被自己变出来的像素盖住，看不见抓手。

入口在**选区球**：手机端分三页 —— 常用（全选 / 反选 / 清空 / 填充 / 复制 / 剪切 / 粘贴 / 粘为新图层 / 粘为新画布）
→ 变形（`sel-more`：斜切 / 透视、网格变形、完成、还原、**半像素吸附开关**、裁切到选区）
→ 工具（`sel-more-tools`：翻转 / 扩展 / 收缩 / 描边 / 删除）；每页最多 8 项
（再多 `ringLayout` 会把半径撑出屏幕）。变形页那个开关就是设置项 `tools.selWarpHalfSnap`
的快捷入口：点一下就地切换，当前状态由 `Item.active` 走 `.orb-item.on` 高亮，`desc` 说明当前是哪一档。
PC 模式一次铺开三页的并集（去掉「返回 / 更多」这两个纯导航项），饼菜单同样过滤导航项。
`SESSION.registerOrbCatalog("sel", …)` 登记的是三页的并集（`selCatalog`），
所以界面定制面板与动作搜索能列到翻页后面的条目。收起选区球会把当前页复位回第一页。

**状态机约定**（改这里之前先读）：
- 变形是**常驻模式**（`xf.mode === "warp"`）：`pointerup` 只结束当前这一次拖拽（清 `xf.drag` / `xf.move`），
  **不落笔**；画布球里的「完成 / 还原」提交或放弃。切工具 / 切图层 / 撤销 / 重做 / 跳历史之前，
  `View.flushStroke()` 会先 `finishWarp(false)` 把它落下来（浮动内容只活在内存里，
  而图层已经被 `floatCut` 清空 —— 不能让它跨过这些操作）。`onMove` / `onDown` / `onUp`
  里凡是走 `rotate/scale` 的分支都必须先排除 warp，否则指针一动就会被当成缩放。
- **进入变形不改图层**：`floatCut` 推迟到第一次真正拖动（`warpMove` → `applyWarp`），
  因此「进去看一眼再退出」不会留下被清空的图层，也不产生历史。
- **会话可以「升级」成变形**：`beginWarp()` 遇到活着的变换会话（`mode !== "warp"`）会复用同一个
  `xf`（`li` / `fi` / `st.before` / `st.mask` 都不变，仍然只落一条历史），但会先把当前预览**烘焙**
  进 `st`（见上「从变换会话切过来时先烘焙」）。
- 移动过（`xf.moved`）但没有浮动结果（四角被拖成一条线 / 内容全拖出画布）时提交＝把原像素还回去。
- 宽或高只有 1 像素的选区被 `beginWarp` 拒绝（`View.lastWarpError = "tooThin"`；没有选区是
  `"noSel"`、图层锁定是 `"locked"`），UI 据此给不同提示。

### 18.10 图案笔刷（`src/data/patterns.ts`）

| 导出 | 说明 |
|---|---|
| `PATTERN_MAX` (64) | 图案最大边长（选区/画布抓图案超过它会被拒绝） |
| `PatternDef` | `{ id, name, w, h, data, tint?, builtin? }`；`data` = RGBA 原始字节的 base64 |
| `BUILTIN_PATTERNS` / `BUILTIN_PATTERN_ZH` | 10 个内置 8x8 图案（tint 遮罩）与它们的中文名 |
| `patternBytes(def)` | 解出字节（长度/尺寸不对返回 null） |
| `patternColorAt(bytes, w, h, x, y)` | 按画布坐标**取模平铺**取样；透明处返回 null |
| `patternFromBytes(src, w, h, trim?)` | 从一块像素抓图案（默认裁掉四周全透明），全透明返回 null |
| `patternPreview(bytes, w, h, size)` | 面板缩略图用的一维采样 |

Session 侧：`patternDefs()`（内置 + 用户）、`activePattern()`、`brushPatternData()`（交给 Stroke 的数据）、
`setPattern(id|null)`、`addPattern(name, bytes, w, h)`、`removePattern(id)`（内置删不掉）、`renamePattern(id, name)`、
`patternFromSelection()`（只收选区内像素，返回 `ok|empty|toolarge|nosel`）、`patternFromCanvas()`（可见图层叠加后按内容裁剪）。

Stroke 侧：`BrushState.pattern` 一填，落笔统一走 `paintOne()`——图案 alpha=0 处**不落笔**（既不上色也不擦除），
`tint` 图案用当前画笔颜色着色（画笔不透明度仍生效）；**橡皮工具完全不吃图案**（`kind === "eraser"` 时按普通橡皮整片擦除）。

### 18.9 新增设置项

`tools.bucketGrad` / `tools.bucketGradMode`（油漆桶渐变与颗粒）、
`tools.airbrushMin` / `tools.airbrushMax` / `tools.airbrushRate`（喷枪）。

---

## 19. 扩展指南

### 新增一个绘制工具

1. `tools/registry.ts` 的 `CORE_TOOLS` / `SHAPE_TOOLS` / `SELECT_TOOLS` 加一条 `ToolDef`。
2. 若是笔迹类，在 `tools/stroke.ts` 的 `startAt/moveTo` 加分支，并保证 `markCell/markBox` 覆盖改动区域。
3. `engine/paint.ts` 补算法（纯函数，便于测试）。
4. i18n 加 `tools.<id>` 文案；必要时在 `app/guide.ts` 加一步引导。

### 新增一个设置

`app/settings.ts` 加一条 `SettingDef` + i18n 的 `label`/`desc`。若要参与导入导出，确保 `kind` 与 `min/max/options` 正确（`coerceSetting` 依赖它们）。

### 新增一个导出格式

1. `io/exporters.ts` 写 `exportXxx(doc, o: ExportOpts)`，复用 `frameRange` 与 `rawExportCanvas`。
2. `ui/modals.tsx` 的 `ExportModal` 加页签与选项。
3. `io/bridge.ts` 的 `saveBytes` 落盘。

### 新增一个导入格式

1. `io/` 下加一个纯逻辑解析器（**不要依赖 DOM**，这样 `tests/` 里能直接跑）。
2. `ui/modals.tsx` 的 `openFileBytes` 加一条按魔数判断的分支（扩展名不可靠），返回 `Doc`；
   `mode === "layer"` 时用 `compose.composeFrame` 拍平后调 `addAsLayer`。
3. 失败分支要给 i18n key，别静默 return（`.aseprite` 见 16.6 的 `aseBad` / `aseTooBig`）。

### 测试

```bash
npm test        # 7655 条断言：引擎 / 选区 / 历史 / 播放 / 设置 / 引导 / 渲染 / 导出 / Aseprite 读写 / 返回手势 / UI 控件与令牌 / AI（ai-doc / tools / draw / turn / rpc / chat / presets / 浮窗与球）（末尾打印 assertions: N）
```

新增纯逻辑（算法、布局、解析、决策）时，优先抽成无 DOM 依赖的函数再补一条 `tests/*.test.ts` 断言——这是本项目保持可回归的主要手段。


---

## 20. UI 控件库 `ui/kit/`

> 规范见 [`docs/UI.md`](UI.md)：令牌表、控件 DOM 契约、迁移与测试约定。本节只列接口。
> 依赖边界：`ui/kit/**` 只允许 import `react` / `react-dom` / `../tooltip` / `../../engine/expr` 与同目录模块，
> **不得**引用 `singleton`(Session)、`i18n`、`app/`、`io/`（由 `tests/ui-kit.test.tsx` 强制）。

### 20.1 `ui/kit/Dialog.tsx`

```ts
interface DialogProps {
  title?: React.ReactNode;        // 头部标题；纯字符串时自动作为 aria-label
  onClose?: () => void;           // 遮罩点击 / × 按钮 / Esc
  children?: React.ReactNode;     // 正文（.dlg-body）
  footer?: React.ReactNode;       // 页脚（.dlg-foot）；省略则不渲染页脚
  top?: React.ReactNode;          // 头部与正文之间（历史模式说明、引用模式选择）
  extra?: React.ReactNode;        // 正文与页脚之间（回放按钮行）
  className?: string;             // 追加到 .dlg（fxdlg / tile-dlg / clg-dlg / dlg-top …）
  bodyClass?: string;             // 追加到 .dlg-body（col / hist-body / fp-grid …）
  bodyStyle?: React.CSSProperties;
  bodyProps?: React.HTMLAttributes<HTMLDivElement>;  // 正文的额外 DOM 属性（帧预览的双指缩放）
  guide?: string;                 // 引导锚点 → data-guide
  closeBtn?: boolean;             // 默认 true（无 onClose 时不渲染）
  maskClose?: boolean;            // 默认 true
  escClose?: boolean;             // 默认 true
  closeLabel?: string;            // × 的 aria-label（默认 "close"）
  label?: string;                 // title 非字符串时的 aria-label
}
```

渲染 `<div class="dlg-mask">` + `<div class="dlg" role="dialog" aria-modal="true">`（fragment，不负责挂载/卸载；
进出场动画由调用方套 `<Keep on={…} el={<Dialog …/>} />`）。DOM 顺序：head → top → body → extra → foot。

### 20.2 `ui/kit/Form.tsx`

| 组件 | 签名要点 | 渲染 |
|---|---|---|
| `Row` | `{ label?, hint?, className?, children? }` | `<label class="rowlabel">` + children + 可选 `<div class="row-note">` |
| `RowActions` | `{ className?, children? }` | `<div class="row-actions">` |
| `ChipGroup<T>` | `{ value: T, options: ChipOption<T>[], onChange, className? }`，`ChipOption = { id, label, guide?, hidden? }` | `<div class="chips">` + `.chip[.on]` |
| `Segmented<T>` | 同上 | `<div class="tabs">` + `.tab[.on]` |
| `Switch` | `{ checked, onChange, label?, disabled? }` | `<button class="sw[.on]" role="switch" aria-checked>` |
| `NumberField` | `ScrubNumProps & { label?, hint? }` | `Row` + `ScrubNum` |
| `ColorField` | `{ value, onChange, label?, hint? }` | `Row` + `<input type="color">` + `.set-hex` |

`ChipGroup`/`Segmented` 的 `T` 用 `NoInfer` 从 `value` 推断：`value` 传联合类型的 state，
选项数组直接写字面量即可；条件项用 `hidden: !cond`（调用点 `.filter()` 会把 `T` 拓宽成 `string`）。

### 20.3 `ui/kit/primitives.tsx` / `ui/kit/scrub.tsx`

`Icon`、`Btn`、`Keep`、`Overlay`、`TipHost`、`useBlankTap`、`useLandscape`、`ScrubNum`（同既有签名；
`ScrubNum` 新增可选 `padTitle`，由 `ui/base.tsx` 注入译文；**`Overlay` 新增可选 `full`**：为真时面板加
`.panel-full` 铺满整屏，`App.tsx` 传 `full={!land && !pcMode}`——手机竖屏整屏、横屏与电脑模式仍是右侧抽屉）。
`ui/base.tsx` 继续导出全部这些名字，并额外提供 `useSession()` 与带译文的 `ScrubNum` 包装。

### 20.4 设计令牌与主题

`style.css` 顶部 `:root` 定义尺寸令牌与主题色/固定色令牌，`[data-theme="light"]` 覆盖全部主题色令牌；
`io/theme.ts` 的 `applyTheme(mode)` / `themeMode(v)` 写 `<html data-theme>` 与 `<meta name="theme-color">`，
设置项为 `display.theme`（`Prefs.theme`，默认 `dark`）。

---

## 21. AI 文档文本化 `src/app/ai-doc.ts`

> C0（[`docs/PLAN-ai.md`](PLAN-ai.md) §3.2 / §5.1）：把画布变成模型能读的文本，把结构化操作安全地写回文档。
> **纯函数 + 无 DOM**：不 import `Session`（只用结构类型 `AiSessionLike`），不碰 history、不碰 autosave
> —— 那两件事属于 §23 的回合事务。所以它能在 Node 里直接跑（`tests/ai-doc.test.ts` 就是这么测的）；
> 也**不产生兆级字符串**（`readRegion` 的 `maxPixels` 就是这条约束）。

```ts
const AI_INDEX_ALPHABET: string;      // "a…zA…Z"：0–51 号索引字符
const AI_MAX_REGION_PIXELS = 65536;   // 一次 readRegion 的像素上限（256×256），token 预算的硬闸门
const AI_MAX_BRUSH = 64;              // 笔迹尺寸上限，与 UI 的笔刷上限一致
const AI_TOKENS_PER_CHAR = 3.5;       // token 估算：ASCII 约 3.5 字符 / token
```

### 21.1 `docDigest(doc, opts?)`

```ts
interface AiDigestLayer { li: number; name: string; visible: boolean; locked: boolean; opacity: number; blend: BlendMode }
interface AiDigestFrame { fi: number; ms: number; cels: number }   // cels = 该帧有 cel 对象的图层数（空 cel 也算「有」）
interface AiDigestTag { name: string; from: number; to: number }
interface AiDigest {
  docRev: number;                   // doc.pixelRev 快照：模型据此判断"我的改动生效了吗"
  w: number; h: number;
  layers: AiDigestLayer[];
  frames: AiDigestFrame[];
  tags: AiDigestTag[];
  palette: string[];                // "#rrggbb"；alpha < 255 时是 "#rrggbbaa"（与 readRegion 同一口径）
  sel: { x: number; y: number; w: number; h: number; pixels: number } | null;
  bbox: { x: number; y: number; w: number; h: number } | null;   // 当前帧可见图层的非空包围盒（含端点）
  inkRatio: number;                 // 非透明像素占比，0..1，3 位小数
  text: string;                     // 单行摘要（恒定长度）
  tokens: number;                   // ceil(text.length / 3.5)
}
docDigest(doc: Doc, opts?: { fi?: number }): AiDigest
```

`opts.fi` 先 `Math.trunc` 再夹到 `0..frames.length-1`（非数字当 0），**不记警告、不抛异常**。
`text` 形如：

```
digest: 32x32 | rev: 12 | layers: ["bg","sprite"](hidden) | frames: 3 | tags: [{"idle",0,2}] | colors: 12 | sel: (2,3)+(4x4) 16px | bbox: (6,4)-(24,20) | ink: 0.412
```

`sel` 只在掩膜真的选中像素时才不是 `null`（`Sel.hasAny()`），`pixels` 是掩膜里的选中像素数；
`bbox` 只统计**可见且 `opacity > 0`** 的图层（隐藏图层不参与，与「看见的画面」同口径）；
`inkRatio` 是「至少一层可见图层不透明」的像素占画布总像素的比例。

### 21.2 `readRegion(doc, rect, opts?)`

```ts
interface AiRegion {
  x: number; y: number; w: number; h: number;   // 实际读取到的区域（见「口径 5 的例外」）
  fi: number; li: number;
  rows: string[];                   // 每行一个字符串：`.` = 全透明，其余是 palette 的下标字符
  palette: string[];                // rows 用到的颜色（先按文档调色板顺序取子集，再按首次出现顺序追加新颜色）
  clipped: boolean;                 // 请求区域被画布边界或 maxPixels 裁剪过
  text: string;                     // 带 y= 行号与 palette 行的排版文本
  tokens: number;
}
interface AiReadOpts { fi?: number; li?: number; rle?: boolean; maxPixels?: number }
readRegion(doc: Doc, rect: Rect, opts?: AiReadOpts): AiRegion
```

**五条边界口径**（每条都有单测）：

1. `rect` 部分越界 → 裁剪进画布并置 `clipped = true`，`x/y/w/h` 报**实际读到**的区域；
2. `li` / `fi` 越界 → 夹到 `0..len-1`，`text` 里带一行 `warn:`（例如 `warn: li 3 超出图层范围 0..1，已回退到 1`），不静默；
3. 目标图层在这一帧没有 cel → 全 `.` 行、`palette` 为空（不是错误，`readRegion` 没有 `ok` 字段）；
4. 颜色身份按 **RGBA 四通道**：同一 RGB 不同 alpha 是**两个**索引，`palette` 里写成 `#rrggbbaa`
   —— **这是对 `docs/PLAN-ai.md` §5.1 早先「`palette: string[]; // "#rrggbb"`」的修正**（实际含 alpha），
   `alpha === 0` 一律记 `.`，不需要另开「透明度表」；
5. `maxPixels` 默认 65536（256×256）：超出时保留**左上角、整行保留**、截断行数并置 `clipped = true`
   —— 这是 §3.2 token 预算的落地（1024×1024 全图约 30 万 token，不可能整图发给模型）。

**口径 5 的例外（请求区域完全在画布外，口径①）**：请求矩形与画布**没有交集**时返回
`w = h = 0`、`rows = []`、`palette = []`、`clipped = true`，而 `x/y` **回显请求坐标**（不是裁剪后的 0），
`text` 首行为 `region requested (x=10,y=10,w=4,h=4) → 完全在画布外 @frame 0, layer 0:`。
理由：`x/y` 的语义是「实际读到的区域」，而 `w = h = 0` 时「实际读到」就是空，此时请求矩形才是
「读的是哪块」的真相；否则同一件事会给出两种形状（`x=10` 回 10、`x=-10` 回 0），模型会误判起点。

**颜色口径（读侧反乘，t14 定稿）**：`palette` 里的颜色是**直通 RGBA**（`#rrggbb` / `#rrggbbaa`），
**不是预乘值**，与工具入参的颜色字面量、`doc.palette` 三者同口径 ——「AI 写进去什么颜色，读回来就是什么颜色」。
为什么需要这一步：写入路径（`engine/paint.ts` → `engine/color.ts` 的 `blendOver`）存进 cel 的字节是
**按 alpha 缩过**的（透明底上写 `#ff000080`，字节是 `[128,0,0,128]`），所以 `readRegion` 在
**字节 → hex 那一步**做反乘（内部函数 `straightHexAt(data, i, a)`：`round(rgb * 255 / a)`）。
**写入 / 合成 / 渲染一行未动**，改的只是读侧解释。

- `a === 255`：**恒等**（预乘与直通在 alpha=255 时数值相同；与加这个反乘之前逐字节一致）；
- `a === 0`：一律记 `.`（全透明，不进 `palette`），不会走到反乘分支；
- `0 < a < 255`：允许**每通道 ±1 的取整误差**，上界 ≈ `ceil(255 / (2a))`（a≥128 时 ≤±1、a=64 ±2、
  a=8 ±16）—— 根源是写入那一步已经把 RGB 量化成 `round(rgb*a/255)`，**信息不可逆**，不是读回 bug；
- `a = 1`：写入时只剩 1 个色阶，原始色**不可还原**（同上，写入侧的取舍）；
- `digest` 只输出 `doc.palette`（不含 cel 字节），本来就直通，不受这条影响。

排版：调色板 ≤ 52 色时索引用 `AI_INDEX_ALPHABET` 的单字符（`rle: true` 且不超 52 色时行内 RLE 成 `2a3b`，
单次省略次数）；超过 52 色退回**定宽十六进制**索引并自动关闭 RLE。`text` 末尾的 `note:` 行会说明 RLE 开启、
定宽回退、半透明像素数（`N 个半透明像素按 RGBA 单独占索引，alpha 见 palette 的 #rrggbbaa`）与 `clipped`。

### 21.3 `applyOps(doc, ops, ctx)`

```ts
type AiColor = string;   // "#rgb" / "#rrggbb" / "#rrggbbaa" / "fg" / "bg"
type AiOp =
  | { op: "pixels"; x: number; y: number; rgba: [number, number, number, number] }
  | { op: "line"; x0: number; y0: number; x1: number; y1: number; color: AiColor; size?: number }
  | { op: "rect"; x: number; y: number; w: number; h: number; color: AiColor; fill?: boolean }
  | { op: "erase"; x: number; y: number; w: number; h: number }
  | { op: "fill"; x: number; y: number; color: AiColor; tolerance?: number };

/** applyOps 只需要 Session 的这几个字段：结构类型而不是 `Session`（见下面的「为什么」） */
interface AiSessionLike { fg: RGBA; bg: RGBA; li: number; fi: number }
interface AiApplyCtx {
  session: AiSessionLike;
  fi?: number; li?: number;
  /** 给了就**完全接管**颜色解析（返回 null 走错误口径，不再回落到 fg/bg） */
  resolveColor?: (c: AiColor) => RGBA | null;
}
interface AiApplyResult {
  ok: boolean;                    // 没有任何 op 失败（部分成功是常态）
  applied: number;                // 成功执行的 op 数（画同色也算执行成功）
  changed: Rect | null;           // 实际碰到的像素并集包围盒（没碰到像素为 null）
  docRev: number;                 // 写入后的文档版本号；只有像素字节真的变了才前进
  warnings: string[];             // 含 "clamped: <字段> <原值> → <最终值>"
  errors: Array<{ index: number; reason: string }>;
}
applyOps(doc: Doc, ops: AiOp[], ctx: AiApplyCtx): AiApplyResult
```

口径（**不要改回去**）：

- **空 `ops` 恒为 `ok: true`**（`applied = 0`、`changed = null`、`docRev` 不动），
  **与目标图层锁没锁无关** ——「没有 op 可失败」不是失败。这条早退**必须排在锁定检查前面**，
  否则「锁定图层 + 空 ops」会给出 `ok:false` 且 `errors` 空。`ops` 不是数组时按空处理并记一条 warn。
- 单个 op 非法 → 记进 `errors`（带 `index`）并跳过，其余照常执行；`ok = errors.length === 0`。
- **越界坐标不钳制也不搬位置**：画到画布外就是没画（`changed` 会说真话）。只有
  `size` / `tolerance` / rgba 通道值 / `li` / `fi` 这类「会被悄悄改小」的参数才进 `warnings`，
  形如 `clamped: size 999 → 64`、`clamped: li 0.4 → 0`；小数与越界各报一条，**互不遮蔽**。
- **cel 只在真要写像素时才建**：`put` / `wipe` 先拿 `doc.w/h` 判越界、先问选区掩膜，再 `ensureCel`；
  `fill` 的种子越界先记 error（文案 `fill 起点 (x,y) 在画布外`）再决定建不建 cel。全程落在画布外的 op
  一个字节没写，就不会在 `doc.cels` 里留下一条空 Cel（空 cel 会污染 §21.1 的 `frames[].cels` 计数）。
- `resolveColor` 省略时：`"fg"` / `"bg"` 取 `ctx.session.fg` / `bg`，其余按 `#rgb` / `#rrggbb` / `#rrggbbaa` 解析
  （`hexToRgba`），不认识就记 `无法解析颜色: …`。
- **一次调用 = 一条事务边界，但只写像素**：不碰 history、不碰 autosave、不动图层 / 帧 / 调色板的结构
  （那些是 §22 的工具）；`doc.pixelRev` 只在真的改到字节时前进一次。
- `changed` 是**像素并集包围盒**，不是「有改动吗」的判据 —— 判生效一律看 `docRev`。

**为什么 `ctx.session` 是结构类型而不是 `Session`**：`session.ts` 有 4.2k 行且依赖 prefs / DOM 桩，
把它拉进这一层就没法在 Node 里单测了。`applyOps` 实际只读 `fg` / `bg` / `li` / `fi` 四个字段
（`docs/PLAN-ai.md` §5.1 早先写的是 `session: Session`，已按代码改成 `AiSessionLike`）。

### 21.4 token 预算与 `maxPixels` 的由来

| 区域 | 字符数 | 约 token | 结论 |
|---|---|---|---|
| 16×16 全图 | ~290 | ~90 | 随便读 |
| 32×32 全图 | ~1.1k | ~320 | 默认全图可读 |
| 64×64 全图 | ~4.2k | ~1.2k | 可读，但每轮都读会贵 |
| 128×128 全图 | ~16.6k | ~4.8k | 按窗口读 |
| 1024×1024 全图 | ~1.05M | ~300k | 不可能，只能窗口 + 摘要 |

所以默认上限定在 256×256 像素（65536），`docDigest` 的 `text` 是恒定长度的一行；写操作优先用**命令**
（画一条线、填一块）而不是回写整个网格 —— 命令的 token 成本与画布大小无关。

**已知缺口**：

- **`Session.paletteFromCanvas`（工具 `palette_from_canvas`）与 §21.2 的读回口径同源、本轮未修**：
  它直接遍历 `doc.cels` 的**原始字节**取色（`session.ts` 的 `paletteFromCanvas`），拿到的半透明颜色是
  **预乘值**，没走 `straightHexAt()` —— 于是「从画布生成调色板」与 `read_region` 读同一批半透明像素时，
  两边给出的颜色可能对不上。修它要动 `src/app/session.ts`，本轮明确不做（记在 `AGENTS.md` §7）。
- `readRegion` 的 `opts.fi` / `opts.li` 小数仍是**静默截断**（`intOr` 里的 `Math.trunc`），没走 `warnings`；
  `applyOps` 侧已经统一成 `warnings`（`clamped: li 0.4 → 0`），两条路径口径暂时不一致。
- `tests/ai-doc.test.ts` 里少数断言偏弱（例如 `digest.tokens` 用同一个公式反推期望值），
  只能保证「自洽」，不能保证「预算真实」。

---

## 22. AI 工具表 `src/app/ai-tools.ts`

> C1（`docs/PLAN-ai.md` §3.1 工具面 / §3.6 权限分级 / §5.1 C1 契约）。这一层只做一件事：
> **把模型给的 JSON 翻译成既有 `Session` 方法的一次调用**。每条 handler 只做参数适配
> （解析 fg/bg、把 `"current"` 换成当前图层/帧、把枚举串换成既有方法的联合类型），
> **绝不新增写入路径** —— 不直接改 doc/cel/palette，不绕过 history。
> `tests/ai-tools.test.ts` 静态扫源文件里所有 `s.<方法>(` 调用，逐个断言它真的存在于 `Session.prototype` 上。
> **P1 像素级工具面（后来补的 13 条：`draw_path` / `draw_shape` / `fill` / `erase` / `transform` / `fx_*`×8）**
> 的落笔逻辑放在适配层 `src/app/ai-draw.ts`（只组合 `tools/stroke.ts` 的 `Stroke`、
> `engine/effects.ts` 的 8 个既有特效、`tools/xform.ts` 的纯仿射与 `tools/select.ts` 的浮动模型），
> 表里这 13 条 handler 仍只做参数适配 —— 见 §22.8。

### 22.1 类型与常量

```ts
type AiTier = "read" | "draw" | "destructive" | "ui";
type AiParamType = "int" | "num" | "bool" | "string" | "enum" | "color" | "xy" | "rect" | "array";

interface AiToolParam {
  type: AiParamType;
  values?: string[];          // type === "enum" 的取值表
  min?: number; max?: number; // int/num = 数值范围（闭区间）；string = 字符数；array = 元素个数
  default?: unknown;          // 省略该参数时用的值；int 参数可以用 AI_ARG_CURRENT（= 当前图层/帧）
  optional?: boolean;         // 可以省略、且省略时**不进** value（见 22.5）
  items?: AiParamType;        // type === "array" 的元素类型
  desc?: string;              // 纯文本说明（工具表这一层不翻译，UI 再查 i18n）
}
interface AiToolResult {
  ok: boolean;
  changed?: Rect | null;      // 实际碰到的像素并集矩形；拿不到矩形的方法省掉这个字段（**不可依赖**，见 22.6）
  docRev?: number;            // 写入后的 `Doc.pixelRev`
  warn?: string[];
  error?: string;
  data?: unknown;             // 输出负载（见 22.5；读类工具的摘要 / 区域对象放这里）
}
interface AiToolCtx {
  session: Session;
  confirm: (req: { tool: string; tier: AiTier; summary: string }) => Promise<boolean>;  // false = 用户取消
  turn: { isOpen(): boolean; mark(): void } | null;   // C2 的回合（§23）；开着的成功写操作 mark 一次
}
interface AiTool {
  id: string;                 // 与 Session.allActions() 同一命名空间
  title: string;              // 纯文本
  tier: AiTier;
  params: Record<string, AiToolParam>;
  returns: Record<string, string>;
  handler: (args: Record<string, unknown>, ctx: AiToolCtx) => AiToolResult | Promise<AiToolResult>;
}

const AI_ARG_CURRENT = "current";
const AI_TIER_ORDER: readonly AiTier[] = ["read", "draw", "destructive", "ui"];
const AI_TOOL_ACTION_IDS: readonly string[] = ["undo", "redo"];   // 复用动作表里真的有的两条
const AI_TOOL_ID_WHITELIST: readonly string[] = [ /* 59 条自己新造的 id */ ];
```

### 22.2 对外接口

```ts
listTools(opts?: { tiers?: AiTier[] }): AiTool[]
getTool(id: string): AiTool | null
validateArgs(tool: AiTool, args: unknown):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: string }
callTool(id: string, args: unknown, ctx: AiToolCtx): Promise<AiToolResult>
summarizeToolCall(tool: AiTool, value: Record<string, unknown>): string      // 确认框里给用户看的一句话
allToolIds(): string[]
idRegistrationDiff(): { missingFromTable: string[]; missingFromWhitelist: string[] }   // 自检，正常为空
```

- `listTools` 顺序**稳定**：tier 分组（`read → draw → destructive → ui`），组内按 id 字典序；
  `opts.tiers` 只筛掉不要的档，传入的档序不影响输出顺序；**默认不含 `ui`**（§3.6）。
- `validateArgs` 返回**新对象**，不改调用方给的那个；口径是**严格**：多给字段、类型不符、越界、
  枚举不认识、数组长度越界，一律 `{ok:false, reason}` 并带上允许范围，**不静默钳制**
  —— 宁可让模型重发一次，也不要把「画在 A 处」悄悄变成「画在 B 处」。
  缺参且 `default === undefined` 且 `optional !== true` → `缺少必填参数 <name>（<type>，允许 …）`。

### 22.3 `callTool` 的固定顺序

1. `getTool(id)` 找不到 → `{ok:false, error:"unknown tool: <id>"}`；
2. `validateArgs` 不合格 → `{ok:false, error:"invalid args: <reason>"}`，**不执行、不确认**；
3. `tier === "destructive"` → `await ctx.confirm({tool, tier, summary})`；返回 false（或抛异常）
   → `{ok:false, error:"cancelled"}` / `"confirm failed: …"`，**文档一个字节不动**；
4. 执行 handler（抛异常只转成 `{ok:false, error:"handler failed: …"}`），结果**原样返回**；
5. `res.ok !== false` 且 `tier !== "read"` 且 `ctx.turn?.isOpen()` → `ctx.turn.mark()` 记一次
   （读类工具不 mark；回合没开时 `mark()` 不会凭空造出回合）。

**`tier` 只决定「要不要确认」与 `listTools` 默认给不给，不决定能不能调** —— 「放行开关」在
C3 的服务层（设置项 `ai.tier`，见 §24.3）。

### 22.4 工具清单与 `tier` 分布（61 = 4 + 49 + 7 + 1）

| tier | 数 | id |
|---|---|---|
| `read` | 4 | `color_analyse`、`color_groups`、`doc_digest`、`read_region` |
| `draw` | 49 | `color_merge_group`、`color_replace`、`color_select`、`draw_path`、`draw_shape`、`fill`、`frame_add`、`frame_duplicate`、`frame_duration`、`frame_move`、`frame_move_to`、`frame_select`、`fx_blur`、`fx_glow`、`fx_gray`、`fx_inline`、`fx_invert`、`fx_outline`、`fx_round`、`fx_shadow`、`iso_generate`、`iso_origin`、`iso_set`、`layer_add`、`layer_blend`、`layer_down`、`layer_duplicate`、`layer_move_to`、`layer_opacity`、`layer_rename`、`layer_select`、`layer_toggle_lock`、`layer_toggle_solo`、`layer_toggle_visible`、`layer_up`、`palette_add`、`palette_dedupe`、`palette_from_canvas`、`palette_merge`、`palette_remap`、`palette_remove`、`palette_sort`、`redo`、`tag_add`、`tag_remove`、`tag_rename`、`tag_set_color`、`tag_set_range`、`undo` |
| `destructive` | 7 | `canvas_clear`、`erase`、`frame_delete`、`layer_delete`、`layer_merge_down`、`scale`、`transform` |
| `ui` | 1 | `set_tool` |

`destructive` 的判定理由（对照 §3.6 举的「删图层 / 帧、清空画布、缩放画布、替换文档」）：
`layer_delete`（删整层）、`layer_merge_down`（一层被并入另一层后消失，层数 -1）、`frame_delete`（删整帧）、
`canvas_clear`（清空当前帧全部图层）、`scale`（改画布尺寸 + 重采样，唯一会改 `doc.w/h` 的工具）；
P1 新增的 `erase`（把一块内容清成透明）与 `transform`（移走像素、可能把内容推出画布、缩放 / 旋转还会重采样）
与 `scale` 同一类，也归这一档。
`palette_remap` 与 `color_replace`（`scope = canvas`）是**画布级批量像素改写**，但它们
① 不改画布尺寸、② 不动图层 / 帧 / 标签结构、③ 一条历史可整条撤销，按 §3.1 的分档留在 `draw`。

### 22.5 两处「只加可选字段」的扩展

- `AiToolResult.data`：§5.1 只留了 `ok/changed/docRev/warn/error`，读类工具的结果（摘要 / 区域对象）
  没有地方放，所以加一个**可选** `data` —— 既有字段语义一个都没改。
- `AiToolParam.optional`：§5.1 只有 `default`，而 `default` 会把「没说」变成「显式设成这个值」；
  补丁类工具（`iso_set` 只改想改的参数）需要**省略 = 不动这一项**，所以加一个可选的 `optional`：
  `optional: true` 且调用方没给值时，这个键**不进** `value`，handler 靠 `a.x !== undefined` 判断。

### 22.6 坑点：`AiToolResult.changed` 与 `data.changed` 同名不同义

- 56 个写类工具（49 `draw` + 7 `destructive`）里只有 **15 条**给了矩形 `changed`：
  P1 的 13 条（`draw_path` / `draw_shape` / `fill` / `erase` / `fx_*`×8 / `transform`）+
  `iso_generate` + `scale`；其余（图层 / 帧 / 标签 / 调色板 / 结构类）`changed === undefined`，
  **拿到它不是错误**；
- **`data.changed` 有两套语义**，看工具自己的 `returns` 描述区分：
  · `color_replace` / `palette_remap` 这类是**数字**（这次改了几个像素）；
  · P1 那 13 条是**布尔**（这一次真的改了没有），像素数在 **`data.pixels`**；
- 判定「改动生效了吗」一律用 **`docRev`**（前后比对 `result.docRev`）；需要脏矩形就用
  §23 的 `previewTurn()` / §24 的 `turn_preview`。
  **`docRev` 是单调修订号不是内容指纹**：`Doc.restore()` 自己会 `pixelRev++`，所以
  **回滚也会让它 +1**（§23.3 第 11 条）；判断「是否回到原样」要比**内容**
  （图层 / 调色板 / cel 字节），不能比 rev。

### 22.7 工具 id 与 `Session.allActions()` 的对齐

界面按钮、快捷键、动作搜索面板、AI 工具必须指向**同一批 id**（§3.1 原则 4），否则「AI 说它撤销了」
与「用户看到的撤销按钮」会漂成两套名字。能对上的直接复用 → `AI_TOOL_ACTION_IDS`
（`undo` / `redo` 是动作表里真的有的两条）；对不上的新 id 一律登记进 `AI_TOOL_ID_WHITELIST`。
测试断言的是**相等**：`AI_TOOL_ACTION_IDS ∪ AI_TOOL_ID_WHITELIST === 工具表 id 集合`（两个集合互不相交），
所以加 / 删工具必须同时改白名单，白名单不会变成垃圾桶。

**已知缺口**：176 个参数里 **52 个没有 `desc`**（只影响模型选工具 / 填参数的准确率，不影响正确性）；
`list_tools` 报出去的就是这份 schema（§24.1），所以模型看到的是「一部分参数只有类型与范围」
（MCP 层会按 `AiParamType` 给这 52 个自动补一句说明，见 §25.3）。

### 22.8 P1 像素级工具面（13 条，落笔在 `src/app/ai-draw.ts`）

> 这一批是「让 AI 真的能画任意东西」的主体：`ai-tools.ts` 里这 13 条 handler 只做参数适配，
> 调用落在**新适配层** `src/app/ai-draw.ts` —— 它组合 `tools/stroke.ts` 的 `Stroke`
> （笔迹 / 形状 / 油漆桶 / 擦除）、`engine/effects.ts` 的 8 个既有特效、`tools/xform.ts` 的纯仿射
> 与 `tools/select.ts` 的浮动模型。**两边都没有新增写入路径**：`ai-draw.ts` 不 import `History`、
> 不调用 `history.*`，历史一律由 `Stroke.commit()`（`pushPixels`，无改动不压栈）或
> `Session.maskOp()`（`pushStruct`）压栈；`tests/ai-draw.test.ts` 用与 `ai-tools.test.ts` 同一条
> 静态规则盯着它。

| id | tier | 关键参数 | 返回 | 落地 |
|---|---|---|---|---|
| `draw_path` | `draw` | `points`（`[x,y][]`，1..4096）、`tool`（`pencil`/`eraser`/`line`/`rect`/`ellipse`/`bucket`）、`size` 1..64、`color`（`#rgb`/`#rrggbb`/`#rrggbbaa`/`fg`/`bg`）、`sym`（`off`/`h`/`v`/`both`/`4`）、`fill`、`brush`?、`layer`/`frame` | `ok` / `changed`（并集矩形）/ `data.changed`（布尔）/ `docRev` | `Stroke`（`runStroke`）；`line`/`rect`/`ellipse` 要**恰好 2 个点**、`bucket` 恰好 1 个 |
| `draw_shape` | `draw` | `shape`（`line`/`rect`/`ellipse`）、`from`/`to`、`fill`、`size`、`color`、`sym`、`brush`?、`layer`/`frame` | 同上 | `runStroke`（`from → to` 外接框；**不吃**「从中心绘制」开关） |
| `fill` | `draw` | `at`（种子，必须在画布内）、`color`（`alpha=0` ＝ 擦掉这片区域）、`tolerance` 0..255、`gaps` 0..16、`global`、`gradient`/`gradientTo`/`gradientBlock`/`gradientAt`?、`sym`、`layer`/`frame` | 同上 | `runStroke(kind="bucket")`；`gradientAt` 只在 `gradient=true` 时有意义（否则报错） |
| `fx_outline` | `draw` | `width` 1..16、`pos`（`outside`/`inside`/`center`）、`color` | `ok` / `changed` / `data.changed`（布尔）/ `data.pixels` / `docRev` | `effects.outlineCel` |
| `fx_inline` | `draw` | `width` 1..8、`alpha` 0..100、`color` | 同上 | `effects.inlineCel` |
| `fx_shadow` | `draw` | `dx`/`dy` -64..64、`color`、`alpha` 0..100 | 同上 | `effects.dropShadowCel` |
| `fx_glow` | `draw` | `radius` 1..16、`color` | 同上 | `effects.outerGlowCel` |
| `fx_invert` | `draw` | （无独有参数） | 同上 | `effects.invertCel` |
| `fx_gray` | `draw` | （无独有参数） | 同上 | `effects.desaturateCel` |
| `fx_round` | `draw` | `radius` 1..8、`mode`（`outer`/`both`） | 同上 | `effects.roundCornersCel` |
| `fx_blur` | `draw` | `radius` 1..32 | 同上 | `effects.blurCel` |
| `erase` | `destructive` | `rect`、`shape`（`rect`/`ellipse`）、`fill`、`sym`、`layer`/`frame` | 同上 | `runStroke`（色固定 `[0,0,0,0]`；有选区时只擦选区内，与橡皮工具一致） |
| `transform` | `destructive` | `mode`（`move`/`scale`/`rotate`）、`scope`（`selection`/`layer`）、`dx`/`dy`、`sx`/`sy`（\|0.02..40\|，负值＝镜像）、`angle`、`snap`、`pivot`（9 档）、`layer`/`frame` | 同上 | `tools/select.ts` 浮动模型 + `tools/xform.ts` 纯仿射（口径与 `View.endXf()` 对齐） |

8 条 `fx_*` 共用 `scope`（`layer` / `selection`）+ `layer` / `frame` 三个参数；
其余共同口径：

- **参数越界一律拒绝**（不静默钳制）；`transform` 里**与 mode 无关的参数是报错**而不是忽略
  （模型按别的 mode 填了一组参数时，静默成功会得到「看起来对、其实没动」的结果）；
- **没有真实改动就不动一个字节、也不压历史**：`fx_*` 先在 cel 副本上试跑一次拿差异
  （`applyFx`），差值包围盒为空 → 直接返回 `ok:true, changed:false`；
  `Stroke.commit()` 自己也不压空步、并删掉白建的 cel；
- 失败都带可读原因：图层锁定 / 图层下标或帧下标不存在 / `scope=selection` 但没有选区 /
  参考图层（只镜像别处像素，得去源画布做）。

调用示例（协议层 `POST /ai` 的 `call_tool`；`layer` / `frame` 省略 = 当前）：

```json
{"call":"call_tool","args":{"id":"draw_path","args":{"points":[[2,2],[30,2],[30,30]],"tool":"pencil","size":2,"color":"#ff0000"}}}
{"call":"call_tool","args":{"id":"transform","args":{"mode":"rotate","scope":"layer","angle":90,"pivot":"cc"}}}
```

**已知代价（有意取舍，不要当 bug 修）**：`fx_*` 与 `transform` 压的是 `Session.maskOp()`
的**结构快照**（`History.pushStruct`：整档 before / after 各一份），而不是 `pushPixels`
的稀疏像素差分。选它的理由有两条：① C1 的硬口径是「写入经 `Session` 既有方法」，
`ai-draw.ts` 因此完全不 import `History`；② 变换会顺手改选区掩码，只有结构快照能把它
一起撤销。代价是**大画布**下一步要两份整档快照（像素画常态 64²～256² 无所谓，
1024² × 多图层时明显比稀疏差分贵）。**要换成差分从哪里下手**：给 `Session.maskOp()`
加一个「只记像素」的开关，或让 `ai-draw.ts` 走 `History.pushPixels` —— 两条都要动
`src/app/session.ts` / `src/engine/history.ts` 的接口，本轮明确不做（见 `AGENTS.md` §7）。

---

## 23. AI 回合事务 `src/app/ai-turn.ts` 与 Session 门面

> C2（`docs/PLAN-ai.md` §3.3「一轮 = 一条 undo」/ §5.1 C2 契约）：把 AI 一轮里的几十次写操作合成
> **一条**可撤销历史，并在回合中间一个字节都不写盘。为什么：`prefs.histSteps` 默认 120 条，
> 而一轮 AI 动辄几十次调用 —— 逐次压栈会把用户自己的撤销挤掉。

### 23.1 类型与常量

```ts
interface AiTurnPreview { count: number; rect: Rect | null }   // count = 这一轮被 mark() 记的操作数
interface AiTurnHandle { isOpen(): boolean; mark(): void }     // C1 的 AiToolCtx.turn 形状（定死）
interface AiTurnRunResult<T> { ok: boolean; result?: T; error?: unknown }
interface AiTurnSession {                                      // 回合宿主 = Session 的公开面（结构类型）
  docs: CanvasEntry[]; docIdx: number; layerIdx: number; frameIdx: number;
  readonly doc: Doc; history: History;
  readonly view: { flushStroke(): boolean } | null;
  curLayer(): number; curFrame(): number;
  syncAll(): void; syncAfterDocChange(): void;
  aiTurnAutosaveSuppressed(on: boolean): void;                 // 幂等
}
const AI_TURN_LABEL_PREFIX = "ai: ";
const AI_TURN_LABEL_MAX = 80;
const AI_TURN_LABEL_FALLBACK = "未命名回合";
```

### 23.2 对外接口

```ts
bindTurnHost(s: AiTurnSession | null): void
beginAiTurn(label: string): number              // 返回 turnId（≥1）；没有宿主返回 0 且回合不打开
runAiTurn<T>(label: string, fn: () => T | Promise<T>): Promise<AiTurnRunResult<T>>   // 单一安全入口
previewTurn(): AiTurnPreview                    // 只算不改文档；回合没开 → {count:0, rect:null}
commitTurn(): boolean                           // 一条历史 + 补一次 autosave；无改动 / 回合没开 → false
rollbackTurn(): void                            // 恢复到回合开始（逐字节一致）；回合没开 → no-op
isTurnOpen(): boolean
turnHandle(): AiTurnHandle                      // 交给 C1 的 AiToolCtx.turn
```

`Session` 的门面（每次调用都 `bindTurnHost(this)`，所以谁先调都能用）：
`beginAiTurn(label)` / `previewAiTurn()` / `commitAiTurn()` / `rollbackAiTurn()` / `aiTurnOpen()` /
`aiTurnHandle()` / `runAiTurn(label, fn)` / `aiTurnAutosaveSuppressed(on)`。

**`runAiTurn` 是推荐入口**（C3/C5 的「一次调用 = 一整轮」）：`begin → await fn() → commitTurn()`；
`fn` 抛异常 → `rollbackTurn()` 并把异常装进 `error` 返回（**不重抛**）；`finally` 里只要回合还开着
就再 rollback 一次。`ok: true` 表示「正常收尾」，**不**表示「一定落了一条历史」：无改动时
`commitTurn()` 返回 false、`ok` 仍是 true；收尾真的出错（压栈 / 同步出错）会转成 `ok:false`
（内部记 `lastCommitError`）。**不要用它实现协议动词** `turn_begin` / `turn_commit` / `turn_rollback`
—— 它在 `fn` 成功后会自动 commit，拿它实现 `turn_begin` 会在「只有 begin」的请求里就把回合提交掉（§24.4）。

### 23.3 口径（**不要改回去**）

1. 历史标签固定加前缀 `ai: `（调用方自己带了不会重复）；正文归一化空白并截断到 80 字符，空标签用兜底正文。
2. 失败口径**一律不抛异常**：回合没开时 commit → `false`、rollback → no-op、preview → `{count:0,rect:null}`、
   isTurnOpen → `false`。
3. `commitTurn()` 只在**文档内容**真的变了才压栈（cel 字节 / 调色板 / 图层帧标签 / 选区 / 画布尺寸）；
   只有画布位置或焦点变了 → `false` 且不压栈（历史里不该有内容相同的空步）。
4. commit 前与 rollback 前都先 `view.flushStroke()`（未落定的笔迹 / 浮动变形先落定；这时历史还关着，
   不会多出历史步骤）。
5. **单画布回合**用 `History.pushStruct`（带 before/after 快照，能进 `.pxc` 的内嵌历史）；
   **跨画布回合**用 `History.record` 的闭包（一条 undo 覆盖所有画布）。
6. `pixelRev` 不在「逐字节一致」的比较口径里（`Doc.restore()` 自己会 `pixelRev++`，它只是渲染缓存键）。
7. `mark()` 只累计操作数并让脏矩形缓存失效；脏矩形由 `previewTurn()` 现算（逐字节比对，不在每次 mark 里重扫）。
8. 回合只挡「AI 的写操作落历史」：用户在回合中间按撤销 / 重做动的仍是既有历史
   —— **回合开着时用户的写入会被回滚吞掉**，所以回合期间不要放行用户 / UI 的写入（服务层负责这道门）。
9. `beginTurn` **先发布回合再挂闸门 / 压 autosave**，任何一步抛错都在 catch 里把闸门与抑制还原后重抛
   —— 不留「闸门挂着但 `activeTurn` 为 null」的不可恢复窗口。
10. 回合的「不动历史」是**临时影子掉** `History` 的三个压栈入口（`record` / `pushPixels` / `pushStruct`）
    实现的；影子残留在身后 = 用户此后的正常绘制**静默不进历史**（丢撤销），所以任何失败路径都必须 rollback。
11. **`docRev`（`Doc.pixelRev`）是单调修订号，不是内容指纹**：`Doc.restore()` 自己会 `pixelRev++`，
    所以 `rollbackTurn()` / undo / redo **都会让它 +1** —— 「rev 变了」只说明「有人写过或者被恢复过」，
    不代表内容真的变了。判断「是否回到原样」要比**内容**（图层 / 帧 / 标签 / 调色板 / cel 字节）；
    `previewTurn()` 的脏矩形就是这么算的（逐字节比对，见口径 7）。

### 23.4 回合期间的自动保存

- 独立字段 `Session.aiTurnAutosaveHeld` 与回放查看器的 `replayActive` **互不覆盖**：三处守卫统一按
  `replayActive || aiTurnAutosaveHeld` 早退（`scheduleAutosave` / `flushAutosave` / 非强制的 `writeAutosave`）；
  `aiTurnAutosaveSuppressed(on)` 只置 / 清自己那一面旗（幂等）。
- 挂抑制时还会 `clearTimeout` **已经排定**的那次自动保存 —— 否则回合拖过 `autosaveMin` 时，
  那次计时器会在回合中间触发，把一份可能马上被 rollback 掉的半成品写进磁盘。
- `commitTurn()` 之后补一次；`flushAutosave(force)` 会先查旗，**`writeAutosave(true)` 是逃生门**
  （只有 force 路径会用得到）。

### 23.5 已知缺口（本轮不做）

- **跨画布回合的 History entry 是 payload-less**：`History.dump()` 实测返回 `[]`，会让该步与**更早步骤**
  一起从 `.pxc` 的内嵌历史里消失（单画布走 `pushStruct` 可序列化；in-session 一条 undo 仍覆盖两张画布）。
- **回合开着时页面隐藏的同步 flush 会早退**（口径 4 的固有取舍）：回合跨过「页面隐藏 + 进程被杀」时，
  回合开始前那几笔不落盘。
- 模块级 `lastCommitError` 在「回合没开」早退时**不清**，可能携带上一次的陈旧错误（一行加固未做）。
- **History 层显式批量抑制开关 / 回合看门狗：本轮决定不做**（会改 `History` 语义并牵动 90+ 提交的回归面）。

---

## 24. AI 本地工具服务（C3）

> 传输有两条，**协议只有一份**：`src/app/ai-rpc.ts`（纯函数路由：无 DOM、无网络、无定时器）
> 定义状态码 / 鉴权 / tier 判定与全部 call；APK 里由 `AiServer.java` + `src/app/ai-serve.ts` 搬运，
> 开发机上由 `toolchain/ai-server.mjs` 搬运。两条路调**同一份** `handleAiRequest` / `handleAiRequestAsync`。
> 默认**关闭**：设置里打开才起服务，只绑 `127.0.0.1`，默认档位 `read`（什么都改不了）。

### 24.1 协议表（队长定稿 v4）

| 项 | 内容 |
|---|---|
| 监听 | 只绑 `127.0.0.1`（绝不 `0.0.0.0`，也不用 IPv6 回环）；端口来自设置 `ai.port`（默认 8787）；默认关闭 |
| 鉴权 | 请求头 `Authorization: Bearer <token>`；token 每次启动随机生成（16 字节 → 32 位十六进制），APK 里由 Java 生成并交回 JS，Node 宿主自己生成；**不持久化**（重启即换） |
| Java→JS 桥 | envelope `{"method":"POST","path":"/ai","body":"<原始 body 文本>"}` 调 `window.__pc_ai_call(envelopeJson, requestId)`（**两个参数**） |
| envelope 契约 | `body` **恒为 JSON 字符串**，要 `JSON.parse(envelope.body)` 才拿到 `{call,args}`；**例外：`GET /ai/health` 的 body 是空串**（路径分流必须在解析之前，否则对空串 `JSON.parse` 会炸成 400，真机上表现为「健康检查永远失败」） |
| `GET /ai/health` | 200 `{"ok":true,"result":{"version":"<APP_VERSION>","docRev":<int>,"tier":"read\|draw\|all"}}`，**由 TS 单源应答**（Java 不得自己回 health：`version` / `docRev` / `tier` 只存在于 TS 层） |
| `POST /ai` | body 为单行 JSON `{"call":"<name>","args":{…}}`；响应恒为单行 JSON：成功 `{"ok":true,"result":…}`，失败 `{"ok":false,"error":"<原因>"}` |
| 状态码 | 200（**含工具自身失败**，body 是 `{"ok":false,…}`）/ 400（call 不存在、参数形状不对、非法 JSON）/ 401（token 不匹配）/ 404（未知路径）/ 405（路径对、方法不对）/ 413（body 超限）/ 503（Session 没就绪，或路由内部抛异常） |
| `PixelBridge` | `aiServerStart(port) -> token 字符串`（绑定失败为 `""`）、`aiServerStop()`、`aiServerStatus() -> '{"running":bool,"port":N,"token":"…"}'`、`aiRespond(requestId, json) -> boolean` |

`POST /ai` 的 9 个 call：

| call | args | 结果 |
|---|---|---|
| `list_tools` | `{tiers?}` | `{tier, allowed, count, tools:[{id,title,tier,params,returns}]}`（**不含 handler**，函数没法序列化） |
| `digest` | `{fi?}` | §21 的 `AiDigest` |
| `read_region` | `{x,y,w,h,fi?,li?,rle?}` | §21 的 `AiRegion` |
| `call_tool` | `{id,args}` | §22 的 `AiToolResult`；**只有它可能异步** |
| `turn_begin` | `{label}` | `{turnId, label, warn?}`（`warn: "previous turn rolled back"`，见 24.4） |
| `turn_preview` | — | `{count, rect}` |
| `turn_commit` | — | `{committed: boolean}` |
| `turn_rollback` | — | `{rolledBack: boolean}` |
| `status` | — | 版本 / `docRev` / `tier` / `allowed` / 各档工具计数 / 回合与空闲收尾口径 / `confirm` 口径 / 宿主信息 |

**两处容易踩的坑**：

- **协议层 `read_region` 是扁平 args `{x,y,w,h,fi?,li?,rle?}`**，而 `list_tools` 里同名工具的 schema 是
  `rect: {x,y,w,h}` + `maxPixels`（那是给模型看的**工具表**形状）。照 `list_tools` 的 schema 去调协议层的
  `read_region` 会 **400**（缺 `x`）。两者是不同层的入口，别混用。
- **413 有两个闸门**：TS 路由按**字符数**卡 `AI_RPC_MAX_BODY = 262144`；Java 侧 `AiServer.MAX_BODY_BYTES`
  按**字节数**卡 1 MiB（先挡住超大 body 再交给路由）。Node 宿主比路由宽 4 倍地先挡一次
  （UTF-8 一个字符最多 4 字节）。413 没列在上面那行的「协议状态码」清单里，但两端都已实现。

### 24.2 双返回形态（同步 / 挂起）

- `window.__pc_ai_call(envelopeJson, requestId)` 先走**同步快路径**：所有纯同步的 call 与全部错误路径
  都在这里回一行 JSON 字符串；
- `call_tool` 在同步入口回一个哨兵体 `AI_RPC_ASYNC_BODY = '{"ok":false,"error":"needs-async"}'`
  （C1 的 handler 允许返回 Promise，`callTool` 本身也是 async，同步路径等不了）；
- `ai-serve` 见到哨兵就**返回空串**表示「挂起」，过一会儿用 `PixelBridge.aiRespond(requestId, json)` 交付。
  **绝不能把 Promise 直接返回给 Java** —— Java 拿到 Promise 的字符串形式会判 `js-async-unsupported`；
- `aiRespond` 返回 `false`（10s 超时 / 已经交付过）**只记诊断，不重试**：Java 侧已经放弃了，
  重发只会把同一个 requestId 的第二次交付丢掉。**只认第一次**；
- Java 侧失败码（形状均为 `{"ok":false,"error":"…"}`）：`js-not-ready`（页面还没注入桥，回 **503**）、
  `timeout`（10s）、`js-error`、`js-async-unsupported`、`empty-response`、`shutdown`；
- `ai-serve.ts` 导出：`installAiServe(deps)` / `uninstallAiServe()` / `applyAiServe()` / `stopAiServe()` /
  `setAiConfirmer(fn | null)` / `aiServeHandleCall(envelopeJson, requestId)` / `aiServeStatus()` /
  `aiServeStatusText()` / `randomToken()`，以及 `AiServeDeps` / `AiServeStatus` / `AiServeReason`。
  诊断入口 `window.__pcAi`：`status()` / `text()` / `start()` / `stop()` / `setConfirmer(fn)` /
  `setTurnIdleSec(n)`。无桥接（浏览器 / PWA / Node 开发宿主）时**全部降级为 no-op 且不抛**。

### 24.3 权限档（放行开关）与确认器

| `ai.tier` | 放行 | 说明 |
|---|---|---|
| `read`（默认） | §22 的 4 个 `read` 档工具 | 只读 |
| `draw` | 再放开 49 个 `draw` 档 | 可以改画面 |
| `all` | 再放开 7 个 `destructive` + 1 个 `ui` | destructive 每一项仍要确认 |

**工具数的两个口径别混写**（MCP 层是第三个，见 §25.3）：本表的档位记的是**能调**的集合，
而 `list_tools` 报的是**能列**的集合 —— `ui` 档（`set_tool`）默认不列，所以档位 `all` 下
`list_tools {}` 返回 **60** 条（4 + 49 + 7），**显式**在 `args.tiers` 里点名 `ui` 才 **61** 条。

**tier 判据（与 `src/app/ai-tools.ts` 文件头逐条一致）**：

- **`draw` ＝ 用画笔能画出的任何效果**：笔迹、形状、油漆桶、橡皮笔刷 —— 也包括**以透明色填充**
  （`fill{color:"#00000000"}`）与**用橡皮画笔擦**（`draw_path{tool:"eraser"}`）：它们与界面里同一支笔
  （油漆桶的「擦」、橡皮工具）逐字节同源，不因为「擦」这个字就换档。
  ⚠ 这不等于 `draw` 档「无害」：`fill` 的 `tolerance=255` 配透明色一次就能擦掉整层像素
  （t5 实测 4096 → 0）。这类工具能留在 `draw` 档，靠的是助手路线的兜底 ——「预览后应用 + 一轮一条 undo」
  （§26 / `docs/PLAN-ai.md` §3.3），不是 tier 本身。
- **`destructive` ＝ 清空 / 替换 / 删除整块画布（整帧全图层）级操作**，外加**按 rect / scope 删掉或搬走
  一整块已有像素**：`canvas_clear`、`layer_delete` / `layer_merge_down` / `frame_delete`、
  `scale`（重采样整张画布或整层）、`erase`（把 rect 里的内容清成透明）、`transform`（按 scope 平移 /
  缩放 / 旋转，可能把像素推出画布）。未确认时**逐字节不动**。

- `aiTierAllows(tier, toolTier)` 是**放行开关**（在 §24.1 的路由里）；被拒时 HTTP 仍是 200，body 形如
  `{"ok":false,"error":"tier \"read\" 不放行 draw 档工具 xxx（当前允许：read；改设置 ai.tier 或先 list_tools 看可用清单）"}`；
- `ui` 档（`set_tool`）**默认不列**：只有服务档位是 `all` 且调用方**显式**在 `args.tiers` 里要了 `ui` 才列；
- **`ctx.confirm` 默认必须拒绝**：C3 没有确认 UI（那是 C5），省略 `ctx.confirm` 时用 `AI_CONFIRM_DENY`
  （恒 false），destructive 工具回 `{"ok":false,"error":"cancelled"}` 且文档一个字节不动。
  confirmer **可注入**（`setAiConfirmer` / `installAiServe({confirm})`），C5 或宿主接真弹框时才换
  —— **禁止**为了「让工具能用」把默认值改成 true（一次 `canvas_clear` 就能毁掉用户的作品）。

### 24.4 回合收尾守卫（影子不能残留）

C2 的「回合期间不动历史」是临时影子掉 `History` 三个压栈入口实现的（§23.3 第 10 条），
影子残留在身后 = 用户此后正常绘制**静默不进历史**，下一次 `turn_begin` 还会把用户这段时间的工作静默回滚。
所以协议层有三道闸门：

1. **路由抛异常** → `rollbackIfTurnOpen()`；
2. **嵌套回合先收尾**：`turn_begin` 时已有回合开着 → 先 rollback 上一个，结果带
   `warn: "previous turn rolled back"`（不报错、不叠加 —— 外部 agent 断线重连是正常结局）；
3. **空闲收尾**：默认 300s 没有任何请求就自动 rollback，`status` 里能看到 `turnIdleSec` /
   `turnIdleLeftSec` / `turnIdleRollbacks` 与口径文本；`setAiTurnIdleSeconds()` / 设置项可配（0 = 关掉）。

另有：`aiServerStop()`、`uninstallAiServe()`、页面 `pagehide`、`applyAiServe` 的「设置里关掉服务」分支
都会**先收尾回合并清守卫，再停端口**；Node 宿主在 SIGINT / SIGTERM 时同样先 rollback。

**空闲守卫的语义（别把 0 当成默认）**：

- **省略 `turnIdleSec` / `undefined`** = 用设置项 `ai.turnIdleSec`（默认 300s），守卫**会**武装；
- **显式 `0`** = 用户主动关掉这条兜底，守卫**不**武装，诊断写「∞s（已关闭）」；
- 三处诊断**同源**：`ai-rpc` 的 `status.turnIdleSec` / `ai-serve` 的 `turnGuard` 文案 / 实际定时器读的
  是同一个 `turnIdleMs`（`ai-serve` 不留第二份记账）；
- `idleGuardArmed` **只在 `window.__pcAi.status()` 里暴露**；协议 `status` 的等价信息在 `turnGuard`
  文本的「守卫已武装 / 未武装」里；
- `__pcAi.setTurnIdleSec(n)` 是**非粘性**的：下一次任何设置变更都会按 `ai.turnIdleSec` 重算并覆盖它；
- 设置项 `ai.turnIdleSec` 是**整数秒、0 = 关闭**：程序化写 `0.1` 会被归一化成 0（= 关闭）而不是夹到 1s
  （UI 是 `min: 0` 的整数滑块，用户路径碰不到）。

### 24.5 设置项与 Node 开发宿主

| 设置项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `ai.server` | bool | `false` | 打开才起本地端口服务 |
| `ai.port` | int（1024–65535） | `8787` | 只绑 `127.0.0.1` |
| `ai.tier` | enum `read` / `draw` / `all` | `read` | 放行档位 |
| `ai.turnIdleSec` | int（0–3600，单位 s） | `300` | 回合空闲收尾；0 = 关闭 |

这四个值**不在 `Session.prefs` 里**：Node 开发宿主没有 Session、也没有 DOM，仍要读到同一份声明，
所以它们自带一个极小存储（内存缓存 + `localStorage["pc.ai"]`），读不到（Node / 隐私模式 / 坏数据）
就退回默认值、**不抛异常**。`ai.port` / `ai.tier` / `ai.turnIdleSec` 只在 `ai.server` 打开时可见；
用户改设置会**即时起停**（`onAiServeSettingsChange` 订阅，不重启同一端口时只换档位、不轮换 token）。

Node 开发宿主 `toolchain/ai-server.mjs`（本机开发 / 验证用，**不重新实现协议**）：

```sh
# 先有编译产物：node node_modules/typescript/bin/tsc -p tests/tsconfig.json
node toolchain/ai-server.mjs                            # 只绑 127.0.0.1:8787 · 档位 read
node toolchain/ai-server.mjs --port 8788 --tier draw    # 换端口 / 放开写类工具
AI_TOKEN=xxx AI_TIER=all node toolchain/ai-server.mjs   # 环境变量也行
node toolchain/ai-server.mjs --help
```

它只做三件事：起 http 服务器、把请求规约成 `AiRpcRequest`、调 `tests/.ts-out` 里编译好的
`handleAiRequestAsync`；Session 在 Node 里靠 `tests/session.test.ts` 的 `stubEnv()`（编译产物）跑起来。
这个宿主**没有确认 UI**，所以 destructive 一律被拒（与 C3 的默认口径一致）。

### 24.6 Android 侧

`android/java/com/pixelcraft/app/AiServer.java`（**纯 JDK**，没有 `import android.*`，可在容器里单独 `javac` 验证）：

```java
public interface Handler { String handle(String method, String path, String authHeader, String body); }
public static String newToken();                                          // 16 字节 → 32 位十六进制
public synchronized String start(int port, String givenToken, Handler h) throws IOException;   // 返回生效 token
public synchronized void stop();                                          // 关监听 + 中断池 + 关在飞连接，端口立刻释放
public boolean isRunning();  public int port();  public String token();
public static final int MAX_BODY_BYTES = 1024 * 1024;
public static final String ERR_JS_NOT_READY = "{\"ok\":false,\"error\":\"js-not-ready\"}";
```

- 常量：`MAX_HEADER_BYTES` 16 KiB / `MAX_HEADERS` 100 / `READ_TIMEOUT_MS` 10000 / `BACKLOG` 16 /
  线程池 `CORE 2 · MAX 4 · QUEUE 32 · keepAlive 30s` —— **有界**队列：无界「每连接一线程」会让任何本机
  进程开满 socket 把 App 拖死；
- `GET /ai/health` 与 `POST /ai` **都转发**给 handler（Java 只做路由与鉴权，不看 call 名 / 工具表 / tier）；
  `GET /ai`、`POST /ai/health` 是 405（方法允许表是 Java 侧唯一的逐路径差别），其余路径 404；
  handler 返回 `ERR_JS_NOT_READY` 时回 **503**（那是「页面还没起来」的传输条件，不是工具结果）；
- 每个请求先按 `Authorization: Bearer` 用**常量时间比较**校验 token，失败回 401（带 `WWW-Authenticate: Bearer`）；
- **异步挂起占一个 worker**：一次 `call_tool` 要等到 `aiRespond` 或 10s 超时才腾出线程，所以 destructive
  的确认必须在 **10s** 内完成（`MainActivity.AI_CALL_TIMEOUT_MS = 10000`）。

`MainActivity` 的 `PixelBridge` 方法面：`aiServerStart(port)`（绑定成功才回非空 token）/ `aiServerStop()` /
`aiServerStatus()`（`{"running":bool,"port":N,"token":"…"}`）/ `aiRespond(requestId, json)`；桥接实现把 envelope
交给 `window.__pc_ai_call(envelopeJson, requestId)` 并在 worker 线程上等 `ArrayBlockingQueue`，
`onDestroy` 会 `aiServer.stop()`。失败码与 §24.2 一致。

### 24.7 数据安全与默认不出网

- **APK 现在声明 `INTERNET` 权限**：Android 上**监听本地端口也要它**（socket 创建受该权限门控）。
  这条权限只用于「开本机端口」；**服务默认关闭**，打开后也只绑 `127.0.0.1`（局域网访问不到），
  应用本身**不发起任何出站请求**（`src/` 里没有 `fetch` / `XMLHttpRequest` / `WebSocket`）；
- token 每次启动重新生成、不落盘；`aiServerStop()` / 页面卸载 / 关闭设置都会收尾回合并释放端口；
- `status` 属于诊断，token 只给诊断用（`aiServeStatusText()` 也只打印末 4 位），**别塞进对外响应**。

### 24.8 已知缺口（C3 之后）

- **C4（电脑侧 MCP 转发）与 C5（应用内助手）已落地**：见 §25 与 §26；协议层本身（状态码 / call 表 /
  回合收尾守卫）没有变；
- **协议层的 destructive 仍然默认拒绝**：应用内助手自己有确认框（§26.4），但 MCP / curl 走的是
  `ai-rpc` 这条路 —— 没有宿主注入确认器（`setAiConfirmer()`，或宿主自己实现 `aiRespond` 的确认 UI）时，
  destructive 一律回 `{"ok":false,"error":"cancelled"}`。想让 Claude Desktop 真去删图层，得先给协议层
  接一个真确认器；
- 档位开关是**粗粒度**的：`draw` 一档同时包含「批量像素改写」（`palette_remap` / `color_replace`）与
  「图层 / 帧 / 调色板结构操作」，关掉 `draw` 会连带失去后者（设置页文案已写清）；
- 协议层 `read_region` 与工具表 `read_region` 的入参形状不同（§24.1），容易误用；
- 61 个工具的 176 个参数里 **52 个没有 `desc`**（§22.7）；
- `palette_from_canvas`（`Session.paletteFromCanvas`）与 §21.2 的读回口径**同源但本轮未修**：它取的是
  cel **原始字节**（预乘值），没走 `straightHexAt()`，与 `read_region` 读同一批半透明像素时两边可能对不上
  —— 详见 §21.4 与 `AGENTS.md` §7 的已知缺口；
- 跨画布回合的 History entry 是 payload-less、回合开着时页面隐藏的同步 flush 会早退、
  `lastCommitError` 会带陈旧值：见 §23.5。

---

## 25. MCP 入口 `toolchain/pc-mcp.mjs` 与电脑侧壳 `toolchain/pc-shell.mjs`

> C4（`docs/PLAN-ai.md` §3.5）：MCP 是「宿主 → 工具服务」的方向，要让 AI 操作**我们的**软件，
> **我们必须当 server**。这两条工具链是那个 server 的电脑侧部分，**协议一行都不重写**：
> 业务仍在页面的 `ai-rpc` / `Session` 里，它们只搬传输。
>
> ```
> Claude Desktop / 任意 MCP 宿主 ──stdio MCP──> pc-mcp.mjs
>                                                  │ HTTP + Bearer（127.0.0.1:8787）
>                                                  ▼
>                      B 路线服务：pc-shell.mjs（电脑壳，转发进窗口页面）或 APK 的 AiServer.java
> ```

### 25.1 用法与前置（`toolchain/pc-mcp.mjs`）

```sh
# 前置（必须）：① 先把本机 AI 工具服务跑起来 ② 拿到它启动时打印的 token
node toolchain/ai-server.mjs --port 8787 --tier all      # 电脑侧开发宿主（最省事的起法）
#   手机上：设置 → AI → 打开本地服务；要连手机先在电脑上 adb reverse tcp:8787 tcp:8787

# 宿主拉起 pc-mcp（stdio MCP）；手工调试时也可以在终端里手打 JSON-RPC 行
node toolchain/pc-mcp.mjs --port 8787 --token <hex>
node toolchain/pc-mcp.mjs --help
```

| 参数 / 环境变量 | 默认 | 说明 |
|---|---|---|
| `--port` / `-p`、`AI_PORT` | `8787` | 本机服务端口（只连 `127.0.0.1`，绝不连别处） |
| `--token` / `-t`、`AI_TOKEN` | 空 | **必须由用户显式给出**（服务启动时打印的那串十六进制）；空 token 时启动会 warn：一定会 401 |
| `--timeout`、`AI_TIMEOUT` | `10000` | 单次 HTTP 调用超时（ms，允许 1000..600000） |
| `--verbose` / `-v` | 关 | 把转发细节打到 **stderr** |

命令行参数优先于环境变量。**`stdout` 只许出现协议行**（换行分隔的 JSON-RPC 2.0），日志一律走
`stderr` —— 往 stdout 多打一行，宿主就收到一行解不开的「JSON」，表现是「一接上就断线」。

它只说三件事：`initialize`（回协议版本 / `capabilities.tools` / `serverInfo` / `instructions`）、
`tools/list`、`tools/call`；`notifications/*` 一律不回。`tools/call` 把工具自身的失败转成
**`isError: true` 且正文带原因**（不吞错）；路由层拒绝（工具不存在 / 档位不放行）同样是可读的
MCP 错误；连不上 / 401 / 超时这类连接层问题才转 JSON-RPC error。启动时会做一次**非阻塞探活**
（连不上也只打一句 warn，不影响 MCP 握手）。

MCP 宿主配置示例（Claude Desktop 的 `claude_desktop_config.json`）：

```json
{ "mcpServers": { "pixelcraft": {
    "command": "node",
    "args": ["<仓库绝对路径>\\toolchain\\pc-mcp.mjs", "--port", "8787"],
    "env": { "AI_TOKEN": "<服务启动时打印的 token>" } } } }
```

token 由用户/宿主自己保管：这一层**不加也不减权限** —— 档位由本机服务的设置（`ai.tier`）决定，
清单原样报给宿主，`cancelled` 原样透传（不重试）。

### 25.2 电脑侧壳 `toolchain/pc-shell.mjs`（+ Windows 双击入口 `pc-shell.cmd`）

```sh
node toolchain/pc-shell.mjs                       # 起壳 + 自动开应用窗口（默认 127.0.0.1:8787）
node toolchain/pc-shell.mjs --port 8790 --no-open # 换端口 / 只起服务不开窗（自测用）
node toolchain/pc-shell.mjs --help
cmd /c toolchain\pc-shell.cmd --help              # Windows 双击入口；.cmd 不能用 node --check
```

一个进程干三件事：伺服 `app2/www` 静态站点、在**同一个端口**上提供 AI 工具服务的两个入口
（`GET /ai/health` + `POST /ai`）、把 AI 请求**转发进窗口里那个页面**。为什么必须转发进页面：
浏览器页面不能监听端口，壳自己跑一份独立文档的话，AI 画的是另一个进程里的空画布。
分工与 APK 完全一致（壳顶替 Java 的 socket 与桥两个位置）：

```
MCP 宿主 / curl ──HTTP(127.0.0.1:8787)──> 壳（只做传输 + 鉴权 + 状态码）
                                            │ SSE 推 envelope + requestId
                                            ▼
                  窗口页面 window.__pc_ai_call(envelopeJson, requestId)   （= ai-serve.ts）
   壳把结果写回那个 HTTP 响应 <── POST /shell/reply（或页面稍后 aiRespond）
```

- 通道是 **SSE**：页面刷新 = `EventSource` 自动重连（壳据此判 `js-not-ready` → 503）；
  壳 → 页面只有这一条流，页面 → 壳只有 `POST /shell/reply`（带 requestId）；
- 另有 `POST /shell/handshake`（页面运行时现取 token，**不写进 HTML**）、
  `GET /shell/status`、`POST /shell/shutdown`；`/ai` 的 Bearer 校验用常量时间比较；
- **服务默认关闭**：页面里的设置 `ai.server` 没打开时壳回 503 `ai-off`，壳不会替用户打开 AI；
- **「Pages 不背 AI」的注入口径**：壳桥只在**被这个壳伺服**的 index.html 里注入（内联脚本），
  GitHub Pages / `devserver.js` / 任何普通静态服务都不注入 → `window.PixelBridge` 不存在 →
  线上永远没有 AI，也没有监听端口的可能；
- 安全口径与 §24 一致：只绑 `127.0.0.1`；token **未指定时才**随机生成（16 字节 → 32 位十六进制）
  并打印，给了 `--token` / `AI_TOKEN` **就用给的那个**（两条来源都生效），只在内存里。
- `node --check toolchain/pc-shell.mjs` 可以；`.cmd` 是批处理，只能 `cmd /c toolchain\pc-shell.cmd --help` 验。

**同一个壳上还有第二条通道：模型请求的同源代理 `/provider/*`**（应用内助手用，与上面 `/ai` 那条是两件事）：
壳从**环境变量**读一把 provider key（`DEEPSEEK_API_KEY` → `OPENAI_API_KEY` → `PC_AI_KEY`，或显式
`--provider-key`），页面只拿 `hasEnvKey` 布尔与公开的端点 / 模型名，真 key 一个字节都不进页面。

```sh
# 电脑侧最省事的起法：环境里给一把 key，壳自动带上转发
set DEEPSEEK_API_KEY=sk-xxxx            # Windows（PowerShell: $env:DEEPSEEK_API_KEY="sk-xxxx"）
node toolchain/pc-shell.mjs             # → 应用里「设置 → AI 助手」不用手填 key 就能用
node toolchain/pc-shell.mjs --provider-key sk-xxxx --provider-base http://127.0.0.1:9000   # 自测 / 自建网关
curl.exe -s http://127.0.0.1:8787/provider/config
```

接口形状、错误码九档、安全边界与「key 不进页面」的准确口径见 **§26.6**；环境变量优先级与三态显示见 §26.3。

### 25.3 工具表 → MCP schema 的映射口径

工具表**不在这层复制**，唯一源是 `src/app/ai-tools.ts`：`tools/list` 现取现映射
（先调本机 `list_tools {}`，若档位放行了 `ui` 再**显式点名**要一次全量清单）。

**工具数的三个口径**（同一个东西的三层，别混写）：

| 层 | 口径 | tier=all | tier=draw | tier=read |
|---|---|---|---|---|
| 工具表（§22.4） | 表里一共多少条 | **61**（4 + 49 + 7 + 1） | — | — |
| 协议层 `list_tools` | `{}`＝**能列**的（`ui` 默认不列） | **60** | 53 | 4 |
| 协议层 `list_tools` | 显式 `tiers` 点名 `ui` | **61** | — | — |
| MCP 层 `tools/list` | 宿主看到的清单（会再问一次全量） | **61** | 53 | 4 |

映射规则（`AiParamType` → JSON Schema）：

| `AiParamType` | JSON Schema | 备注 |
|---|---|---|
| `int` | `integer` + `minimum`/`maximum` | `validateArgs` 对小数**拒绝**，所以不是 `number` |
| `num` | `number` + 范围 | |
| `bool` / `string` | `boolean` / `string`（+ `minLength`/`maxLength`） | |
| `enum` | `string` + `enum: [...]` | 取值表原样搬 |
| `color` | `string` | `#rgb` / `#rrggbb` / `#rrggbbaa` / `fg` / `bg` |
| `xy` | `array` + `items:{integer}` + `minItems/maxItems: 2` | |
| `rect` | `object` + 四个 integer + `required` | |
| `array` | `array` + `minItems`/`maxItems`；`items` 按 `list_tools` 里同名参数的 `items` 递归 | **元素类型靠 `aiToolInfo()` 原样透传字符串**；下游拿不到就退成放开的 `{}`，不瞎猜（猜 `number` 会让颜色数组自相矛盾） |

- `required` = **既没有 `default` 也不是 `optional`** 的参数 —— 与 `validateArgs` 判「缺少必填参数」
  的那一条完全一致（两处口径必须一样，否则模型会漏参数然后拿到一条报错）；
- `AI_ARG_CURRENT`（`"current"`）这种哨兵**不写进 `default`**（它是个字符串，会让 `integer` 的
  schema 自相矛盾），改为在 `description` 里说明「省略 = 当前帧 / 当前图层」；
- **`desc` 缺失的参数**（52 个）由这一层按 `AiParamType` 自动补一句「类型 + 范围 / 取值」，
  另外 `color` 补「fg / bg」、`array` 且元素类型未知时补一句怎么填；
- 每条工具的 `description` 头一行带 **tier + tier 提示**（只读 / 能改画面 / 每次确认 / 只切界面），
  非 `read` 档追加「改完用 `read_region` / `doc_digest` 读回复核（docRev 变了才算生效）」；
- `annotations`（MCP 2025-06-18）：`title` / `readOnlyHint`（`tier === "read"`）/
  `destructiveHint`（`tier === "destructive"`）。

---

## 26. 应用内助手 `src/app/ai-chat.ts` + `src/ui/AiWindow.tsx` + `src/ui/AiPanel.tsx`

> C5（A 路线，`docs/PLAN-ai.md` §3.3「一轮 = 一条 undo」/ §3.5 / §3.6 key 与安全模型）：
> 在应用里说一句话 → 模型 function calling → **预览后应用** → 一轮一条撤销。
> 逻辑层 `ai-chat.ts` 与平台无关（不 import `window`、不直接调 `fetch`，`fetchFn` 由调用方注入），
> 所以能在没有 DOM 的测试里用假端点把整轮跑完（`tests/ai-chat.test.ts`）；UI 只负责显示与两个按钮。
>
> P8 把助手从「主菜单里的一个整屏子面板」改成 **浮动小窗 + 可最小化为浮动球**，并补上
> **DeepSeek 默认预设**、**更完善的设置项**与**环境 key 的同源代理**。三个落点：
>
> | 文件 | 管什么 |
> |---|---|
> | `src/ui/AiWindow.tsx`（**新文件**） | 浮窗容器：`createPortal` 到 `document.body`、标题栏（拖动柄 + 最小化 + 关闭）、右下角缩放抓手、`pc.aichat.win` 的读写 |
> | `src/ui/AiPanel.tsx` | 对话面板 `AiPanel`（消息流 / 调用摘要 / 应用·放弃 / 输入框）+ 助手小球 `ChatBall` + 跨卸载的会话存储 `aiWinStore` + 通路探测 `chatTransport()` |
> | `src/app/ai-presets.ts`（**新文件**） | 厂商预设表（DeepSeek / OpenAI / 自定义）与 `normalizePresetId`；**没有 key 字段**（切预设碰不到 key 是结构保证） |
> | `src/app/uibar.ts` | 浮窗 / 小球的**纯几何与存储归一化**（`AI_CHAT_WIN_KEY` / `AI_CHAT_BALL_KEY` / `clampAiWinLayout` / `normalizeAiWinLayout` / `aiWinDragFrom` / `clampAiBallPos`），有单测 |
> | `src/app/settings.ts` | `CHAT_SETTINGS`（14 条）+ `SETTINGS` 里的 5 条 AI 高级项 + `applyAiChatPreset()` + `SETTING_SECRET_PATHS` |
> | `toolchain/pc-shell.mjs` | 同源代理 `GET /provider/config` + `POST /provider/chat`、环境变量 key、key 擦除、错误码九档 |

### 26.1 平台门与入口

- **只有 `isNativeShell()`（APK / 桌面壳的 `window.PixelBridge`）为真才有助手**：
  主菜单那一行（`ui/modals.tsx`）、浮窗（`AiWindow`）、助手小球（`ChatBall`）、设置行
  （`chatRowsVisible()`）四处各判一次；普通浏览器 / GitHub Pages 里
  **一个 DOM 都不挂、不连端点、不发任何请求**（面板只显示一句说明，绝不出现「点了没反应」）。
  线上 PWA 不背 AI（§3.6 红线）。
- 入口：主菜单 → 「AI 助手」（图标见 `src/ui/feature-icons.ts`，`i-ai-chat`）→ **打开浮窗**
  （不再是 `MenuModal` 的 `setSub("ai")` 子面板；菜单项锚点 `data-guide="menu-ai-chat"` 不变）。
  打开动作也接受 `window` 上的 `pc-ai-window` 事件（引导与外部触发用同一个入口）。
- **窗口状态不是用户在设置页里调的值**：开 / 最小化两条声明 `visible` 恒为 false，只有
  `ai.chatBall`（最小化后画不画球）在 `ai.chatOn` 打开后露出来。

### 26.2 设置项（`CHAT_SETTINGS`，`src/app/settings.ts`）

助手那一组是**单独一张声明表**，走同一个设置页渲染器，但**不参与设置文件导出**（原因见下）。
逐项清单（`ai.chatOn` 关着时，设置页只剩第一条开关）：

| 路径 | 类型 | 默认值 | 进设置导出？ | 机密？ | 说明 |
|---|---|---|---|---|---|
| `ai.chatOn` | `bool` | `false` | 否 | 否 | 助手总开关；关着时下面各条都不显示 |
| `ai.chatPreset` | `enum`（3 项 → chips） | `deepseek` | 否 | 否 | 厂商预设：`deepseek` / `openai` / `custom`；切它只写 endpoint + model，**不碰 key** |
| `ai.chatEndpoint` | `text:"plain"` | `https://api.deepseek.com` | 否 | 否 | OpenAI 兼容基地址；留空会提示，末尾自动补 `/chat/completions` |
| `ai.chatModel` | `text:"plain"` | `deepseek-v4-pro` | 否 | 否 | 模型名；**永远是自由文本**，预设只提供快捷 chips |
| `ai.chatKey` | `text:"password"` | `""` | **否**（`SETTING_SECRET_PATHS`） | **是** | 用户手填的 key，只存本机；`action` = 一键清除（清空后自动落回环境 key） |
| `ai.providerBase` | `text:"plain"` | `""` | 否 | 否 | **手填 key 时**的直连地址；留空 = 用 `ai.chatEndpoint`。代理模式不看它 |
| `ai.chatMaxRounds` | `int` | `12`（`1..24`） | 否 | 否 | 一轮最多问几次模型 |
| `ai.chatTemp` | `int` | `0`（`0..20`，单位 `×0.1`） | 否 | 否 | `temperature` = 值 × 0.1；`0` = **不发这个字段**（用端点默认）；**思考模式下不发**（见下一行） |
| `ai.chatThinking` | `enum` | `default` | 否 | 否 | 思考强度：`default` = **一个思考字段都不发**（对任何 OpenAI 兼容端点最安全）；`off` = `{"thinking":{"type":"disabled"}}`；`low`/`high`/`max` = `{"thinking":{"type":"enabled"},"reasoning_effort":<档位>}`（DeepSeek 口径）。⚠️ 打开思考后 **`temperature` 不生效**（官方文档明说），且**带 `tools` 时后续每一轮必须回传 `reasoning_content`**（否则 400）—— 后者由 `assistantMessage()` 把 `choices[].message.reasoning_content` 记进 assistant 消息实现 |
| `ai.chatTimeoutSec` | `int` | `60`（`5..600`，单位秒） | 否 | 否 | **等模型回话**的秒数：发请求时 ×1000 → 请求头 `X-Provider-Timeout`（壳按它等上游，见 §26.6）；直连时由页面的 `AbortController` 按同一个值中止 |
| `ai.chatSystemPrompt` | `text:"plain"` | `""` | 否 | 否 | 非空则**追加**在内置提示词之后 |
| `ai.chatStream` | `bool` | `false` | 否 | 否 | 本轮固定关闭：代理对 `stream:true` 直接回 400 |
| `ai.protectKey` | `bool` | `true` | 否 | 否 | 决定状态行**要不要附那句与 key 有关的说明**（见 26.3） |
| `ai.chatWinOpen` | `bool` | `false` | 否 | 否 | 浮窗当前是否打开（`visible` 恒 false：这是状态不是可调值） |
| `ai.chatWinMin` | `bool` | `false` | 否 | 否 | 是否已最小化成球（`visible` 恒 false） |
| `ai.chatBall` | `bool` | `true` | 否 | 否 | 最小化后画不画助手球；**唯一可见的窗口相关开关** |

**一处实现偏差（P1 §3.7.7 的清单 vs 最终实现）**：设计稿把 `ai.protectKey` / `ai.chatMaxRounds` /
`ai.chatTemp` / `ai.chatSystemPrompt` / `ai.chatStream` 五条放在 `SETTINGS`（组 `ai`，因此**进导出**），
实现时**五条全部落在 `CHAT_SETTINGS`（组 `chat`，**不进导出**）**，所以上表那一列全是「否」。
理由是 `tests/ai-rpc.test.ts:950` 的 `settings.visible.on` 钉死了 `ai` 组的可见路径**恰好四条**
（`ai.server` / `ai.port` / `ai.tier` / `ai.turnIdleSec`）—— 往 `ai` 组加任何一条都会红，
而 P1 §3.7.8 只授权改两条既有断言（`aichat.setting.default-endpoint` / `aichat.setting.visible-on`），
不含这一条。代价：这五条**不进设置文件导出**，跨机器迁移时要重填；理由与代价都记在
`src/app/settings.ts` 的 `CHAT_SETTINGS` 段注释里。

**预设的权威数据**（`src/app/ai-presets.ts`，2026-09-16 核 `api-docs.deepseek.com`）：

| 预设 | `baseUrl` | `defaultModel` | 可切模型 chips |
|---|---|---|---|
| **`deepseek`（默认）** | `https://api.deepseek.com` | `deepseek-v4-pro` | `deepseek-v4-pro` / `deepseek-flash` |
| `openai` | `https://api.openai.com/v1` | `gpt-4o-mini` | `gpt-4o-mini` / `gpt-4o` |
| `custom` | `""`（**一个字段都不写**） | `""` | 无（纯自由文本） |

- **默认预设 = `deepseek`**，且 `ai.chatEndpoint` / `ai.chatModel` 的**声明默认值直接从它取**
  （`aiChatPresetOf(AI_CHAT_DEFAULT_PRESET).baseUrl` / `.defaultModel`，不是抄一遍字符串）：
  第一次打开助手就已经指着 DeepSeek，用户只需要「有 key」这一件事。
- 预设里**只有公开的 base URL 与公开的模型名**，没有任何凭据（§3.6 的红线针对的是 key）。
- **切预设的三条语义**：① 只写 `preset` + `endpoint` + `model` 三个字段，**key 连读都不读**；
  ② 切到 `custom` **一个字段都不写**（它的 baseUrl / defaultModel 是空串，写下去会把用户手填的抹掉）；
  ③ 模型清单是**会过期的数据** —— 它只是快捷 chips，`ai.chatModel` 永远是自由文本，
  改清单是普通代码改动、不涉及设置迁移（旧名 `deepseek-chat` / `deepseek-reasoner` **不写进清单**）。
- 坏数据一律回默认：`normalizePresetId()` 只认三个字面量。

四条**不要改回去**的实现口径：

1. **`CHAT_SETTINGS` 是单独一张表，不并进 `SETTINGS`**：`tests/session.test.ts` 钉住
   「导出的取值条数 === `SETTINGS.length`」「导入的 applied === `SETTINGS.length`」，
   而 key 必须一个字节都不进导出 —— 两者不能同时成立，所以助手这一组单独一张表
   （照样是声明式的、走同一个设置页渲染器；`SETTINGS_BY_PATH` 两个表都收）。
   钉子断言：`settings.export.all-paths` / `settings.import.applied`。
2. **`SettingKind` 保持四个字面量**，文本行不新增 kind，而是走 `SettingDef.text`
   （`"plain"` / `"password"`，见 `ui/modals.tsx` 的文本行分支）。
   钉子断言：`settings.no-new-kind` / `settings.kind.count`。
3. **全部不进 `Session.prefs`**：自带极小存储（内存缓存 + `localStorage["pc.aichat"]`，
   键 `AI_CHAT_SETTINGS_KEY`），读不到（Node / 隐私模式 / 坏 JSON）就退回默认值、不抛异常；
   文本长度上限 `AI_CHAT_MAX_TEXT`（2048）。
   `prefs` 会随工程 / 设置导出走，而「这台机器这个屏幕上窗口开在哪」不属于工程。
4. **归一化是「全量比较」而不是子集**：`normalizeAiChatSettings()` 现在有 **14 个字段**
   （`on` / `preset` / `endpoint` / `model` / `key` / `providerBase` / `maxRounds` / `temp` /
   `systemPrompt` / `stream` / `protectKey` / `winOpen` / `winMin` / `ball`），
   `aichat.setting.normalize-junk` + `aichat.setting.normalize-keys` + `...is-tight` 三条整对象钉死；
   加新字段忘了同步，断言会红。
   `endpoint` / `model` 的**空串不填默认值**（空串 = 用户主动清空）；「从没配过」那一步由
   `loadAiChatSettings()` 落一次声明默认值并写盘 —— 否则代理一坏，设置页两行就永远是空的。

### 26.3 key 的安全口径（**key 只存本机，线上 PWA 不内置**）

**key 的两个来源与优先级**（判定顺序决定「谁在花钱」，必须按这个顺序）：

```
① 用户在设置里手填的 ai.chatKey（非空即生效）→ 页面**直连**（走 ai.providerBase ?? ai.chatEndpoint），
   key 只在本机页面的 localStorage 里
        ↓（手填为空）
② 宿主环境变量 / CLI 提供的 key → **同源代理**，key 只在壳进程内存里，页面拿一个哨兵常量
        ↓（两者都没有）
③ 无 key → 面板显示提示条，**一个请求都不发**
```

**环境变量名与优先级**（`toolchain/pc-shell.mjs` 的 `PROVIDER_KEY_ENV`，第一个非空即用）：

| 顺序 | 名字 | 为什么是这个顺序 |
|---|---|---|
| 1 | `DEEPSEEK_API_KEY` | DeepSeek 官方文档给的用法就是它，而默认预设也是 DeepSeek |
| 2 | `OPENAI_API_KEY` | 换 OpenAI / 兼容网关时最通用的名字 |
| 3 | `PC_AI_KEY` | 本项目自有名：给「不想污染全局环境变量」的场景兜底 |

显式 `--provider-key <k>` **优先级最高**（argv 覆盖 env）。读一次发生在**壳启动时**，之后不再重读
—— 改了环境变量要**重启壳**（`--help` 与面板提示里都写了）。

> ⚠️ **`AI_TOKEN` 不是 provider 的 key**：它是**壳 ↔ 页面的通道 token**（§25.2 的 `/ai` 那条路），
> 两者**不得混用**，`--provider-key` 也不接受 `AI_TOKEN` 作别名。页面调 `/provider/chat` 时
> 用通道 token 做鉴权（`Authorization: Bearer <通道token>` 或 `X-Shell-Token: <通道token>`），
> 真 provider key 由壳在转发那一刻补上。

**面板顶部状态行的三态**（`aiChatStatusText(cfg, hostKey, t, protectKey)`，**只拼「有无」**，
key 的值一个字符都不进这段文本）：

| 状态 | 状态行末尾 | 触发条件 |
|---|---|---|
| 手填 | `已手填 key` | `ai.chatKey` 非空（输入框本身是 `password`，不回显） |
| 环境 key | `本机环境变量已提供 key（key 不在页面里）` + 一条 `ai-key-source` 说明行 | 手填空 且 `/provider/config.hasEnvKey` |
| 无 key | `没有可用的 key` + 一条 `ai-no-key` 警告条（提示设 `DEEPSEEK_API_KEY` 或手填） | 两者都无 |

**`ai.protectKey` 的最终语义（P15 起它真的接上了效果）**：它决定上面那行状态文本**要不要再附一句
与 key 有关的操作说明**，三态各一句常量（`AI_CHAT_KEY_HELP_MANUAL` / `_ENV` / `_NONE`）：

- 开（默认）= 状态行 + `（这把 key 只存在本机页面存储里，不进设置导出与日志）`（环境态则是
  `（由桌面壳从环境变量提供并同源转发，页面拿不到它；换 key 要重启壳）`）；关 = 只留状态行本身。
- 两种取值产出**不同文本**，所以这个开关是可测的（`proxy.status.protect-key.changes-text` /
  `...prefix` / `...help-text` / `...no-key-text` / `...default-protected`）。
- **关掉它绝不意味着 key 可以进任何文本**：key 不进导出 / 不进 `.pxc` / 不进 toast / 不进错误文案
  这几条与它无关，由 `SETTING_SECRET_PATHS` 与「状态文本只拼有无」两处代码保证。
- 这三句是**中文常量而不是 i18n 键**（同模块的 `httpError()` / `hostError()` / `chatConfigError()`
  早就是中文常量）⇒ 英文界面下这三句仍显示中文，记在 `AGENTS.md` §7 的缺口里。

其余四条口径不变：

- `SETTING_SECRET_PATHS = ["ai.chatKey"]`：`exportSettings()` / `importSettings()` 显式跳过它 ——
  key **不进设置文件、不进 `.pxc`、不进诊断文本、不进 toast**，也不出现在面板的任何提示里；
- 手填 key 走请求的 `Authorization: Bearer <key>` 头（`ai-chat.ts` 的 `requestModel`）；
  代理模式**去掉** `Authorization`、改带 `X-Provider-Key: host` 哨兵头（非哨兵路径逐字不变，
  `aichat.http.auth` 仍钉着它）；
- 设置页提供**一键清除**（`clearAiChatKey()`，设置项的 `action`；清完落回环境 key）；
- 端点 / 模型 / key 三项都要求非空才发请求（`chatConfigError()`），缺项时**连回合都不开**。

**诚实边界（不许把它说成「任何 key 都不在页面里」）**：`ai.chatKey` 是**用户自己手填**的，
按 §3.6 的存储模型它就在本机页面的 `localStorage` 里，同源脚本读得到 —— 这一点本轮**没有改**。
所以「key 不进页面」这条**只对环境变量来源（②）成立**：那把 key 由壳持有，
页面内存 / DOM / console / localStorage 四处都搜不到（`GET /provider/config` 的响应里也没有它，
连尾 4 位都不给）。

### 26.4 一轮的流程与「预览后应用」

`runChatTurn(opts)`：请求模型 → 有 `tool_calls` 就按数组顺序 `callTool` 并把结果回灌 → 再请求，
直到模型只回文本（或到 `maxRounds` / `maxCalls` 上限）。

每次发送时 system 消息都**重新拼**一条：`docDigest()` 的当前帧摘要（§21.1 的 `AiDigest`，
上限 `AI_CHAT_MAX_DIGEST_CHARS = 6000`）+ 用户在 `ai.chatSystemPrompt` 里补的那句
（追加在内置提示词 `AI_CHAT_SYSTEM_PROMPT` 之后，不改内置那份）。

| 常量 | 值 | 说明 |
|---|---|---|
| `AI_CHAT_DEFAULT_MAX_ROUNDS` | 12 | 「模型 → 工具 → 模型」默认轮数 |
| `AI_CHAT_MAX_ROUNDS` | 24 | 硬上限（调用方给再大也不超） |
| `AI_CHAT_MAX_CALLS` | 80 | 一整轮最多真的执行多少次工具调用 |
| `AI_CHAT_MAX_RESULT_CHARS` | 4000 | 单条工具结果回灌给模型的字符上限（超了截断并写明） |
| `AI_CHAT_TOOL_TIERS` | `read` / `draw` / `destructive` | 默认给模型的档（`ui` 不暴露，与 `listTools()` 同口径） |

- **一轮 = 一条 undo**：整轮包在 ai-turn 的回合里（预览模式也一样），任何失败路径都
  `rollbackTurn()` ——「模型中途报错、文档已经被改了一半」不允许出现；
- **`commit: true`（默认）** 走 `runAiTurn()` 一步落定；
  **`commit: false`（面板用的预览模式）** 回合**留开着**（结果里 `turnOpen: true`、不落历史、
  不刷 autosave），用户点「应用」才 `SESSION.commitAiTurn()`（一轮一条撤销）、点「放弃」才
  `SESSION.rollbackAiTurn()`（逐字节回到这一轮开始，并把模型那半轮从对话里忘掉）；
- **面板卸载时回合还开着 → 立刻放弃**（`AiPanel` 的卸载钩子）：回合开着时用户自己的写入会被
  下一次 rollback 吞掉，绝不能把这个状态留下来；
- **destructive 每次都弹确认框**：面板把 `SESSION.askConfirm()` 接成 `AiToolCtx.confirm`
  （文案 `aiChatConfirm` + `summarizeToolCall()` 的一句话摘要）；用户拒绝 → `cancelled`，
  文档一个字节不动。**协议层 / MCP 没有这个确认器**（§24.8），别把两者混为一谈；
- 工具的 OpenAI schema 由 `toOpenAiTools()` 映射（`src/app/ai-chat.ts`）：`required` 与
  `validateArgs` 同口径、`int` → `integer`、`xy` → `[integer, integer]`、`rect` → 四个整数、
  `AI_ARG_CURRENT` 哨兵不进 `default` 而是写进 description；
- 失败一律说人话（缺 key / 端点不是 http(s) / 网络挂了 / HTTP 4xx-5xx / 返回不是 JSON /
  工具参数不是合法 JSON），不静默失败、也不把异常抛给 UI；
- `ChatTurnResult` 里带 `docRevBefore` / `docRev` / `recorded` / `turnOpen` / `stop`
  （`"text"` / `"maxRounds"` / `"maxCalls"`）与每次调用的 `ChatCallLog`（`revDelta > 0` = 真的改了画面）；
  面板用 `previewAiTurn()` 拿 `{count, rect}` 显示「这一轮改了哪块」。
- 相关导出：`chatConfigError` / `formatCallLog` / `changedCount` / `defaultTurnLabel` /
  `buildSystemPrompt` / `systemMessage` / `userMessage` / `assistantMessage` / `toolResultContent` /
  `appendToolResult` / `parseToolCalls` / `responseText` / `toOpenAiTools` /
  `chatCompletionsUrl` / `AI_CHAT_HOST_KEY_SENTINEL` / `chatProxyUrl` / `detectChatProxy` /
  `readHostProviderConfig` / `proxyChatFetch` / `aiChatStatusText` / `message`。

### 26.5 浮窗与浮动球（`src/ui/AiWindow.tsx` + `src/ui/AiPanel.tsx` 的 `ChatBall`）

**容器**：`AiWindow` 是一个 `createPortal(document.body)` 的浮窗，自带标题栏（拖动柄 + 最小化 + 关闭）、
正文（`AiPanel`）与**右下角唯一一个缩放抓手**（不做八向：收益低、触屏易误触）。
`App.tsx` 的挂载条件是 `isNativeShell() && aiChatSettings().winOpen && !winMin`；
`AiWindow` 自己再判一次 `isNativeShell()`，为假时**一个 DOM 都不渲染**。

**状态机**（落点全在 `App.tsx`，事件表见 `docs/PLAN-ai.md` §3.7.6）：

| 事件 | 状态变化 | 副作用 |
|---|---|---|
| 菜单「AI 助手」/ `pc-ai-window` 事件 | 关闭 → 开窗 | `saveAiChatSettings({ winOpen: true, winMin: false })` |
| 最小化按钮 / **双击标题栏** | 开窗 → 球 | 先把几何（含 `min:true`）落盘，再 `winMin = true` → 浮窗 DOM **真的卸载** |
| 点球（位移 < 8px） | 球 → 开窗 | `winMin = false`；几何取自 `pc.aichat.win`；对话与 thread 留着 |
| 拖球（位移 ≥ 8px） | 球 | 只记位置（`pc.aichat.ball`），**不回窗**；触屏下顺带收起别的球的展开环 |
| 关闭按钮 / 面板的返回键 | 任意 → 关闭 | `saveAiChatSettings({ winOpen: false, winMin: false })` |
| Android 返回键（`pc-back`） | 开窗 → 球 | 与最小化按钮**同一个入口**（`minimizeAiWin()`），只是最小化、不关窗 |
| 拖动标题栏 / 拖缩放抓手 | 开窗 | 每一帧跑夹取，**松手那一下才写盘** |
| 窗口 resize / 旋屏 | 开窗 | 重跑一次夹取并写盘（窗口不许留在屏幕外） |

- **回合不变式（P9 定稿，别改回去）**：**最小化 = 浮窗 DOM 真的卸载**（`display:none` 不算，
  `AiPanel` 的卸载钩子必须跑），而「卸载时留不留这一轮」只看 **Session 的实况**：
  `aiPanelDropsTurnOnUnmount(session) = session.aiTurnOpen()` —— 卸载时回合还开着就
  `SESSION.rollbackAiTurn()` + 在对话里补一行说明（`noteAiWinClosed()`）。
  最小化按钮 / 双击标题栏 / `pc-back` / 关窗 / 被别处卸掉**五条路径同语义**。
  早先有一个 `aiWinStore.mode` 标志位，于是「记得在最小化时设它」成了调用点义务，
  结果窗口按钮那条路径漏了、两边语义相反 —— 现在**没有第二份状态可漂移**。
- **写入点唯一**：`winMin` / `winOpen` 只由 `App.tsx` 的 `minimizeAiWin()` / `closeAiWin()` /
  `openAiWin()` / `restoreAiWin()` 四处写。`AiWindow` **自己不碰设置、不碰回合**，它只收
  `onMinimize` / `onClose` 两个 prop。**不要把浮窗包进 `Keep`**（那会让它不卸载）。
- **对话跨卸载保留**：模型侧 `thread` / 用户可见的 `entries` / 调用摘要 `logs` / 输入框草稿
  放在**模块作用域**的 `aiWinStore`（进程内保留、**不落盘**）。而「预览中 → 应用 / 放弃」
  这套 UI 由 `aiPanelShowsPreview(cfg, session, hasPending)` 判 —— 它同时要求
  「面板看得见（`winOpen && !winMin`）」与「Session 里真有一轮开着」，所以最小化后
  不会留一套点了没反应的假预览（`data-guide="ai-pending"`）。
- **拖动 / 缩放只用指针事件**（`pointerdown/move/up` + capture），不用鼠标专属事件，
  所以触屏与电脑模式是**同一条**代码路径；拖动**从不累加**（每帧从按下那一刻的几何重算），
  否则夹取会把位置一点点往回挤。

**几何持久化键**（口径与纯函数在 `src/app/uibar.ts`，有单测；组件只负责接到 DOM 上）：

| 键 | 形状 | 默认 | 坏数据口径 |
|---|---|---|---|
| `pc.aichat.win`（`AI_CHAT_WIN_KEY`） | `{ "v": 1, "x": n, "y": n, "w": n, "h": n, "min": bool }` | `w=380 h=460`、贴右下角（`innerWidth - w - 16` / `innerHeight - h - 16`） | `x/y/w/h` 任一不是有限数字、或 `v` 不认识 → **整份丢弃**回默认值（不做逐字段修补）；`min` **只认 `true`** |
| `pc.aichat.ball`（`AI_CHAT_BALL_KEY`） | `{ "x": n, "y": n }` | 贴右下角、**抬高 32px** 让开底栏 | 坏数据回默认位 |

- 夹取：`x ∈ [8, innerWidth - w - 8]`、`y ∈ [8, innerHeight - h - 8]`；尺寸
  `min 260×200`、`max 视口 - 16`（视口小于最小尺寸时以最小尺寸为准）。
- `localStorage` 读写**一律包在 `try` 里**：隐私模式 / 坏 JSON 都不该让窗口打不开。
- 版本号 `AI_WIN_STORE_V = 1`：**换口径时整份丢弃，不做迁移**。

**与既有 5 个浮动球的关系**：助手球 `ChatBall` 是**独立小球**（`CHAT_BALL_ID = "ai"`，
`data-orb-ball="ai"` / `data-guide="orb-ai"`），**没有扩 `ORB_IDS`**（仍是 5 个：
`main` / `sel` / `pal` / `fx` / `canv`）。
理由与代价：五球那套（dock 拖动 / 展开环 / 饼菜单 / 界面定制顺序）是全仓库回归面最密的一块，
而助手球**没有任何子项**要被搬运或排序 —— 它就是一个开关按钮。选独立组件换零回归面：
既有断言 `uibar.orbs`、`guide.orbs.*`、`icons.*` 一条都不用改。
它与五球系统只共享**一条**规则：触屏下点/拖它会收起别的球已经展开的环
（`pc-ai-ball-tap` → `closeRadials()`；PC 模式不互斥）。它不参与
`prefs.dockPos` / `ringSlots` / `pieEquip` / `prefs.orbPrefs`，
外观**复用 `.orb` 类名与 `orbMetrics(pcMode).orb`** 的尺寸（不新造球样式）。

### 26.6 通路与同源代理（`toolchain/pc-shell.mjs` 的 `/provider/*`）

**四条硬理由**（都写进壳的注释里）：① 环境变量那把 key 一个字节都不进页面；② 用户不用手填 key；
③ 错误能翻成一句人话；④ 不再依赖对端 CORS 配置。
**不是**为了绕 CORS —— 实测证明 DeepSeek 会回 CORS 头、`file://` 源也被放行
（`docs/PLAN-ai.md` §3.7.1 的实测记录），别照着错误假设去「修」一个不存在的 CORS 问题。

**页面判定顺序**（`AiPanel.detectTransport()`，进程级缓存一次）：手填 key → 直连；
否则探 `GET /provider/config`，`proxy && hasEnvKey` → 代理；否则 → 不发请求。

| 项 | 定稿 |
|---|---|
| 路径 / 方法 | `GET /provider/config`（探测，**不要 token**，不泄漏任何机密）；`POST /provider/chat`（模型请求，要壳的通道 token）；`OPTIONS /provider/*` → `204` + CORS 头；其它方法 `405` |
| 页面 → 壳的地址 | **恒为同源相对路径 `/provider/chat`**（`chatProxyUrl()`）。⚠️ 早先写成 `<壳报的 providerBase>/provider/chat`，于是请求被发去 `https://api.deepseek.com/provider/chat`（生产）或假 provider 的地址（跨源，必然 `Failed to fetch`）—— **P8 修掉的真缺陷**，别改回去 |
| 页面怎么拿通道 token | 复用 §25.2 的既有桥：`window.PixelBridge.aiServerStatus()` 回的 `{"running","port","token"}`（**不新增桥方法**），只放内存、**绝不写 localStorage**；取不到就按「代理不可用」回落直连 |
| 探测的 GET | **不能带 body**（真浏览器对 `GET` 带 body 直接抛 `TypeError`，而当时的 `catch { return null }` 把它静默吞成「这台机器没有代理」）—— 这是 **P8 修掉的第二个真缺陷**；测试那边配了一个按真浏览器规则校验的假 fetch（`strictFetch`）盯着它 |
| 请求体 | OpenAI 兼容**原样转发**：`{ model, messages, tools?, tool_choice?, temperature?, max_tokens? }`。壳**只补** `Authorization`，不改其它字段；`model` 缺省时用壳的默认模型；`stream:true` 直接回 `400`。**请求体里没有 URL 字段** —— 目标地址只由壳的启动参数决定，这从结构上堵死「拿代理当任意 URL 转发器」 |
| 鉴权（对页面） | `POST /provider/chat`：优先 `Authorization: Bearer <通道token>`，兼容 `X-Shell-Token`；常量时间比较。页面在代理模式下**去掉** `Authorization`、改带 `X-Provider-Key: host`，并把通道 token 放 `X-Shell-Token`（通道 token 只放内存、绝不写 localStorage） |
| 响应 | 把 provider 的 **HTTP 状态码与 body 原样透传**（3xx 也照透，**不跟随重定向**）。页面侧的 `httpError()` 按状态分档的文案因此一行都不用改 |
| 超时 / 体积 | **超时有三层，别混**：① 页面设置 `ai.chatTimeoutSec`（默认 **60s**）→ 每次请求带 `X-Provider-Timeout`（毫秒，壳**夹到 1s..10min**）；② 壳的上游转发用「该头优先，否则 `--provider-timeout`（默认 **60000ms**，env `PC_SHELL_PROVIDER_TIMEOUT`）」→ 超时回 `504`；③ 壳 ↔ 页面的临时通道仍用 `--timeout`（默认 10000ms，与 `MainActivity.AI_CALL_TIMEOUT_MS` 同口径）。**别再让模型请求共用 10s**：V4 默认带思考模式，一次带 61 个工具 schema 的请求十几秒很正常（实测：假 provider 延迟 12s，旧默认 10s → 504；新默认 60s → 200；壳默认 2s + 请求头 8s、provider 延迟 3.5s → 200，去掉头 → 2s 时 504）。上游响应体上限 8 MiB（`MAX_PROVIDER_BYTES`，超了截断）；页面 → 壳的请求体上限 1 MiB（`MAX_BODY_BYTES`）→ `413` |

**`GET /provider/config` 响应**（**绝不含 key 的任何片段，连尾 4 位都不给**）：

```json
{ "ok": true, "proxy": true, "baseUrl": "https://api.deepseek.com",
  "defaultModel": "deepseek-v4-pro", "models": ["deepseek-v4-pro", "deepseek-flash"],
  "hasEnvKey": true, "keySource": "env" }
```

`keySource` 取 `"env" | "cli" | "none"`；页面**只**读 `proxy` / `baseUrl` / `defaultModel` /
`models` / `hasEnvKey`（`readHostProviderConfig()`）—— 缺 `baseUrl` 或 `defaultModel` 一律回
`null`（= 当没有代理，回落直连），**宁可当「没有代理」也不瞎猜**。

**壳自己的错误码 → 页面文案**（九档；壳的 body 形状恒为
`{"ok":false,"error":"<code>","detail":"…"}`，`detail` 里**绝不放 key**）：

| 状态 | `error` | 页面文案 |
|---|---|---|
| `409` | `no-key` | 本机壳里没有可用的 API key：设 `DEEPSEEK_API_KEY`（或 `OPENAI_API_KEY` / `PC_AI_KEY`）后重启桌面壳，或在设置里手填 |
| `401` | `unauthorized` | 本机壳的通道 token 不对（重启壳后刷新页面） |
| `403` | `proxy-off` | 本机壳拒绝了这次转发（<detail>，例如 `--no-provider-proxy` / 目标不是已知 provider） |
| `413` | `body-too-large` | 请求太大（上限 1 MiB）：对话太长，清一下会话 |
| `502` | `provider-unreachable` | 连不上端点（<detail>）：检查这台设备的网络 |
| `504` | `provider-timeout` | 端点没在超时时间内回：<detail>（本机壳的上游超时，可用 `--provider-timeout` 调大） |
| `400` | `bad-request` | 端点返回 HTTP 400：<detail>（体不是 JSON / `stream:true` / `no-model`） |
| `404` | `not-found` | **页面静默回落直连**（老壳没有这个端点），不弹错 |
| 其它 4xx/5xx | 原样透传 provider 的 | 走 `httpError()` 四档（401/403、404、429、其它） |

**「这一条到底是壳发的还是 provider 发的」怎么判**（P10 修掉的误报根源）：只看**响应形状** ——
壳自己产生的每个错误体都有 `ok === false`，provider 的错误体是 OpenAI 形状（没有 `ok` 字段）。
不能反过来用「有没有 `error` 字符串」判：OpenAI 兼容端点也常回 `{"error":"insufficient_quota"}`。
分不出来的**一律退回 `httpError()` 并把 provider 原话带上**（不吞错、也不替 provider 背锅）。
其中 **provider 的 403 单独说清方向**：`模型服务商拒绝了这个请求（HTTP 403）：<provider 原话前 120 字>`
—— 壳拒绝要用户查本机配置 / 端口 / token，provider 拒绝要他去服务商那边查 key 权限 / 余额 / 模型授权。
（这一档是 **P10 修掉的误报**：早先 provider 的 403 被算成「本机壳拒绝了这次转发」。）

**安全边界与分档**（逐条可核）：

- **环境 key 只发往已知 provider 主机 + 必须是 https**：白名单是 `ENV_KEY_HOSTS =
  api.deepseek.com / api.openai.com`；`--provider-base` 落在这两者之外、**或者协议不是 `https:`**，
  都**直接关掉 `/provider/*` 转发**并在 banner 里讲明原因（`协议不是 https，key 会明文出网` /
  `主机不在白名单`）。**为什么 env 来源额外要求 https**：只判主机的话
  `--provider-base http://api.deepseek.com:8080` 会通过主机检查、然后把环境 key 明文发到那个
  明文端口上，等于白名单形同虚设（P15 第 4 项）。
- **显式 `--provider-key` 不受这道闸门限制**：那把 key 是用户自己敲的、他自己担责的转发行
  （本机假 provider / 自建网关的自测都靠它）。
- **不跟跨主机重定向**：上游 3xx 原样透传（带 `location`），绝不替页面去追。
- **key 只发往已知 provider**：`ENV_KEY_HOSTS` 之外的目标在有 key 时直接关掉转发（同上）。
- 只绑 `127.0.0.1`；banner / 日志 / 诊断文本里**只有 `providerKeyTail()` 的尾 4 位**
  （形态 `…abcd`），没有 key 明文。

**壳回写前会把自己那把 key 擦掉（透传的「唯一例外」）**：`scrubProviderKey()` 在写回页面之前把
`opts.providerKey` 打成 `…` + 尾 4 位，覆盖三种形态（都大小写不敏感、容忍空格）：
① `Bearer <key>`；② JSON 同形（`"authorization":"Bearer <key>"` 由 ① 覆盖）；③ 裸 key
（例如 `api key: <key> is invalid`）。**其余字节一字不改**，并按新字节长度重写 `content-length`。
为什么必须有：壳原本对 provider 响应是**原样透传**，而 provider 完全可能在错误体里把收到的
`Authorization` **回显出来**，页面又会把 4xx body 前 120 字拼进错误行 ⇒ 环境 key 明文进了页面 DOM，
直接打破本轮核心承诺（评审的对抗实测命中过 `Bearer sk-fake-env-7777`）。打码形态与 banner /
诊断一致，所以「页面能看到的」与「日志能看到的」严格相同，不多泄漏一位。
（页面在回显场景下看到的是 `…尾4` 掩码 —— 与壳的 banner 惯例一致，判可接受。）

**APK 侧（本轮明确不做）**：Android 上**没有「宿主环境变量」这种给应用进程用的一等机制**
（`System.getenv` 在应用进程里读不到用户设的 shell 变量），所以「环境 key」这条路在 APK 上不存在；
APK 今天的行为仍是「手填 key + 直连」（`INTERNET` 权限已在）。**它能不能连上真 provider 存疑**
（桌面 Edge 的实测表明 `Origin: file://` 对 DeepSeek 放行，但那**不是** Android WebView 的行为：
`MainActivity` 没有开 `setAllowUniversalAccessFromFileURLs`，WebView 默认对 `file://` 页面的跨源
请求是拦的，而本机没有 Android 设备可验证）⇒ 记进 `AGENTS.md` §7 的缺口，要做代理就照抄 §26.6 的
路径与错误码，Java 侧多回一个 `Access-Control-Allow-Origin: file://`。

**自测 / 验证口径**（`toolchain/pc-shell.mjs`）：

```sh
# env 来源（转发腿）：真 https 上游 + 假 key ⇒ 上游 401 原样透传，页面显示 provider 档文案
set DEEPSEEK_API_KEY=sk-fake-env-7777 && node toolchain/pc-shell.mjs --port 8911 --no-open
# 回显 / 擦除：显式 --provider-key（豁免 https 闸门）+ 本机 http 假 provider
node toolchain/pc-shell.mjs --port 8914 --no-open --provider-key sk-cli-probe-8888 --provider-base http://127.0.0.1:8913
# env 闸门：白名单主机 + http ⇒ 转发被关（banner 讲明原因）
node toolchain/pc-shell.mjs --port 8915 --no-open --provider-base http://api.deepseek.com
```

### 26.7 测试手册（本机怎么验助手与代理）

**先对齐两个基准**（对不上就别往下测）：

```powershell
node toolchain/check-bundle.mjs app2/www/js/app.js      # 期望：✓ 产物自检通过…（exit 0）
# 更严的一条（推荐）：按 §6.4 在 %TEMP% 里用同一套 esbuild 口径重建一份，
# md5 必须与 app2/www/js/app.js **逐字节相同** —— check-bundle 只证「能加载」，不证「等于 src」。
node tests\.ts-out\tests\run-tests.js | Select-Object -Last 1   # 期望：ALL PASS（当前 7642 条）
```

壳伺服的就是 `app2/www/js/app.js`（§5.1b）：md5 或自检不对，说明产物落后于源码，先在仓库根重建（§6.4），
否则你测到的是旧包 —— **`check-bundle` 只证「能加载」，不证「等于 src」**，所以两个都看。

**测法 A：零成本 + 离线（本地 OpenAI 兼容服务）** —— 不需要任何真 key，最适合先把流程跑通：

```powershell
node toolchain/pc-shell.mjs --port 8911 --provider-key local --provider-base http://127.0.0.1:11434/v1
```

`--provider-key` 显式给出的通道**豁免「白名单主机 + https」闸门**（§26.6），所以本机 `http` 端点可用
（Ollama 默认 `11434`、LM Studio 默认 `1234`，端点要带 `/v1`）。设置里选「自定义」，把端点填成同一个地址。

**测法 B：手填 key 直连**（最快看到真回答）：起壳后进「设置 → AI 助手」，在 key 那一行粘上你的 key，
端点保持 DeepSeek 默认值即可。这条路是**页面直连** provider（实测 DeepSeek 会回 CORS 头，§3.7.1），
key 存在页面 `localStorage` 里 —— 这是 §26.3 写明的那条边界。

**测法 C：环境变量 key + 同源代理**（推荐，key 不进页面）：

```powershell
$env:DEEPSEEK_API_KEY = "sk-你的key"    # 只对当前 PowerShell 窗口有效
node toolchain/pc-shell.mjs             # 默认会自己打开浏览器
# 想长期有效（新窗口才生效）：setx DEEPSEEK_API_KEY "sk-你的key"
```

⚠️ **双击 `toolchain\pc-shell.cmd` 读不到你刚在 PowerShell 里 `$env:` 设的变量**（那是当前窗口的环境）；
要么就用 `setx` 设成用户级变量再双击，要么在同一个 PowerShell 窗口里 `node toolchain/pc-shell.mjs`。

**UI 五步**：① 菜单 →「AI 助手」→ 浮窗出现；② 拖标题栏移动、右下角缩放、点「最小化」变成一颗小球、
点球还原（几何按机器记住，刷新后不变）；③ 设置里确认厂商预设**默认选中 DeepSeek**、端点与模型已预填；
④ 在输入框说「在画布中心画一只猫」→ 看「调用摘要」；⑤ 点「应用」落一条可撤销的操作，或点「放弃」逐字节回滚。

**自己验「key 不进页面」**（F12 → Console，三行都应为 `false`）：

```js
const k = "sk-";                                        // 用你 key 的前 3 位就够
document.documentElement.outerHTML.includes(k);
JSON.stringify(localStorage).includes(k);
performance.getEntriesByType("resource").some(r => r.name.includes(k));
```

环境变量那条路下，设置页的状态行会写「本机环境变量已提供 key（key 不在页面里）（由桌面壳从环境变量提供并
同源转发，页面拿不到它；换 key 要重启壳）」。

**自己验「回显防护」**（provider 把收到的 `Authorization` 回显时，页面只应看到掩码）：

```js
// 存成 %TEMP%\fake-provider.mjs：任何请求都回 401，并把 Authorization 回显进错误体
import http from "node:http";
http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c));
  req.on("end", () => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "bad key: " + (req.headers.authorization || "") } }));
  });
}).listen(8913, "127.0.0.1", () => console.log("fake provider: http://127.0.0.1:8913"));
```

```powershell
node $env:TEMP\fake-provider.mjs
node toolchain/pc-shell.mjs --port 8914 --provider-key sk-cli-probe-8888 --provider-base http://127.0.0.1:8913
```

设置里选「自定义」+ 端点 `http://127.0.0.1:8913`，随便发一句：错误行应显示 `Bearer …8888`（**掩码**），
**不应**出现 `sk-cli-probe-8888` 明文；`document.documentElement.outerHTML.includes("sk-cli-probe-8888")` 必须是 `false`。

**正常时应该看到什么**：

| 观察点 | 期望 |
|---|---|
| `curl.exe -s http://127.0.0.1:8911/provider/config` | `{"ok":true,"proxy":true,"baseUrl":"https://api.deepseek.com","defaultModel":"deepseek-v4-pro","models":[…],"hasEnvKey":<bool>,"keySource":"env"\|"cli"\|"none"}`，**不含任何 `sk-` 形状串、连尾 4 位都没有** |
| 无 token 调 `/ai/health` | `401`（服务默认关闭时会是 `503 ai-off`，都对） |
| 壳的 banner | 只打 key 的**尾 4 位**（`…abcd`）；有闸门拦截时会写原因（`协议不是 https，key 会明文出网` / `主机不在白名单`） |
| 无桥接的普通浏览器（devserver / Pages） | 菜单里**没有**「AI 助手」、控制台**零** AI 请求（平台门，不是 bug） |

**症状 → 排查**：

| 症状 | 原因 / 处理 |
|---|---|
| 菜单里没有「AI 助手」 | 当前页面没有 `window.PixelBridge`（普通浏览器 / Pages）：用桌面壳或 APK 打开 |
| 状态行「没有可用的 key」 | 三种来源都没有：设置里手填，或设环境变量后**重启壳**（key 只在启动时读一次） |
| 「本机壳拒绝了这次转发（目标不是已知 provider）」 | env key + 非白名单主机或非 https：换白名单 https，或改用显式 `--provider-key` |
| 「本机壳的通道 token 不对」 | 重启过壳 → 刷新页面（token 每次启动随机，除非 `--token` 固定） |
| 「端点没在超时时间内回：…ms」 | 上游（模型）在这段时间内没回：**先在「设置 → AI 助手 → 模型响应超时」调大**（默认 60 秒，5..600），或起壳时给 `--provider-timeout 120000`；「连不上端点」先查这台设备的网络；首字慢通常是想模式所致，把「思考强度」调低 / 关闭会快很多 |
| 面板里出现 `端点返回 HTTP 504：{"ok":false,…}` 这种**原始信封** | 那是页面按「直连档」选文案的旧行为（已修）：壳的信封现在**无论走哪条分支**都按 `ok:false` 形状翻成人话 |
| 请求发去奇怪地址后 `Failed to fetch` | 检查是不是把端点写成了 `<providerBase>/provider/chat`（§26.6：页面必须发**同源** `/provider/chat`） |
| 页面白屏 | 产物坏了：在仓库根重建（§6.4 的 tsconfig 坑），再 `check-bundle` |

**清场**：Ctrl+C，或

```powershell
curl.exe -s -X POST -H "Authorization: Bearer <壳启动时打印的 token>" http://127.0.0.1:8911/shell/shutdown
Get-NetTCPConnection -LocalPort 8911 -State Listen   # 期望：无输出（端口已释放）
```

