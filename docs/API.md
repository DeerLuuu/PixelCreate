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
7. [撤销栈 `engine/history.ts`](#7-撤销栈)
8. [颜色与调整](#8-颜色与调整)
9. [工具注册表与笔迹 `tools/`](#9-工具注册表与笔迹)
10. [选区与变换 `tools/select.ts`](#10-选区与变换)
11. [应用层 `app/session.ts`](#11-应用层-session)
12. [设置注册表 `app/settings.ts`](#12-设置注册表)
13. [引导注册表 `app/guide.ts`](#13-引导注册表)
14. [播放模式 `app/playback.ts`](#14-播放模式)
15. [渲染 `render/`](#15-渲染)
16. [IO `io/`](#16-io)
17. [UI 层与事件契约 `ui/`](#17-ui-层与事件契约)
18. [多画布空间 / 新工具与特效（1.0.7.11 追加）](#18-多画布空间--新工具与特效)
19. [扩展指南](#19-扩展指南)
20. [UI 控件库 `ui/kit/`](#20-ui-控件库-uikit)

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
scaleDocSprite(doc, w2, h2): void            // 整体缩放（最近邻）
contentBounds(doc): Rect | null              // 所有内容的包围盒（智能裁剪用）
```

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
```

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
cropToSelection(): boolean              // 画布裁切到选区外接矩形（一条结构历史）
resizeModeOn / setResizeMode(on) / toggleResizeMode()   // 拖画布四边改尺寸的模式
sampleComposite(x, y): RGBA | null        // 取合成后的颜色
```

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
```

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

  markDirty(rect?: Rect | null): void;   // 标记脏区（无参 = 全帧 + 全量重绘）
  invalidate(rect?: Rect | null): void;  // 标记 + rAF 合并重绘（Session.repaint 用）
  refresh(force: boolean): void;         // 立即绘制（force = 重建合成）
  flushStroke(): boolean;                // 手势未正常结束时的兜底提交
}
```

**手势**：单指绘制、双指缩放/平移、三连击放大、边距双击撤销、双指双击重做、四指打开全部帧预览（≥4 指 + ≥2 指滑动 >15px）、长按取色。

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

// src/io/autosave.ts
saveAutosave(text, meta): Promise<"idb" | "local" | "too-big" | "fail">
loadAutosave(): Promise<AutosaveRecord | null>
autosaveMeta(): Promise<AutosaveMeta | null>
clearAutosave(): Promise<void>
const AUTOSAVE_MAX_BYTES = 32 * 1024 * 1024;

// src/io/gifread.ts
interface GifData { w; h; frames: Array<{ data: Uint8ClampedArray; delayMs: number }> }
tryReadGif(bytes): GifData | null

// src/io/clipboard.ts
writeClipboardPng(canvas): Promise<boolean>
```

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
| `TabBar` / `DropMenu` | `ui/tabs.tsx` | 共用选项卡与可展开下拉（色板 / 导出 / 更新日志） |
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
| `quadArea(q)` / `skewQuad(w, h, "x"\|"y", amount)` | 四边形面积（判退化）与斜切预设 |
| `warpQuad(src, quad, outW, outH, srcQuad?)` | **四点自由变换（斜切 / 透视）**：目标四边形固定顺序（左上→右上→右下→左下），逐目标像素反查源像素，最近邻采样，画面外保持透明 |
| `meshWarp(src, grid, outW, outH, divs = 2)` | **网格变形**：`(n+1)²` 个控制点，每个格子拆两个三角形做仿射逆映射 → 拉伸不留洞 |
| `defaultGrid(w, h, divs)` / `pixmapFromCel(data, w, h)` | 默认网格控制点与像素块构造 |
| `selOps.warpFloating(doc, st, pts, out, mesh, divs?)`（`src/tools/select.ts`） | 把浮动内容按画布坐标控制点重排进整幅画布的 `out`，并同步 `doc.sel` 掩码，返回点亮的像素下标 |
| `selOps.floatQuad(st)` / `floatGrid(st, divs)` | 浮动内容当前的四角 / 网格控制点（画布坐标） |

**坐标口径（全项目统一，改这里之前先读）**：一律用**边框 / 像素角口径** —— 像素 `i` 覆盖 `[i, i+1)`，
一块 `w×h` 的区域四角是 `(0,0)`、`(w,0)`、`(w,h)`、`(0,h)`（**不是** `w-1` / `h-1`）。
选区框 `View.selFramePts()`、`floatQuad()` / `floatGrid()`、`defaultGrid()`、`skewQuad()`、
`warpQuad()` 的 `quad` 与默认 `srcQuad` 全是这一套，所以变形控制点正好落在选区框的四个角上。
对应地采样用 **`Math.floor`**（像素 i 的中心 0.5 落在 `[i, i+1)` 里）而不是 `Math.round`，
目标最右 / 最下一格反查回来的源坐标（如 `w-0.5`）才会落到 `w-1` 而不是被挤到 `w` 外面。
历史上 `floatQuad()` 用「像素下标」口径（`ox+cw-1`）与选区框口径差 1 像素，导致变形区域
比选区小一圈、最右 / 最下一列像素在预览里直接丢失。

采样一律最近邻（像素画不允许被插值糊掉）；映射一律「目标 → 源」的逆向映射，所以拉伸时不会出现空洞。
`meshWarp` 的「像素质心是否属于本格」判定放在**源空间**（把质心反查成源坐标后判定是否落在本格的源矩形里），
不在目标空间用重心符号判「在三角形内」—— 两个三角形共用一条对角线，压在对角线上的质心
在两侧权重都是 0，除法舍入误差会把它判成两侧都在外面，恒等变换时表现为丢一列 / 一行。
UI 侧：`View.beginWarp("quad"\|"mesh")` 进入变形（没有浮动选区时自动抓一份），画布上出现
可拖的控制点（四角 / 3×3 网格），拖动时每帧从手势起点那份原图重算预览（不累积误差）；
`View.finishWarp(false)` 落下（一条历史，标签 `sel.warp`）、`finishWarp(true)` 还原。
入口在**选区球**：手机端分三页 —— 常用（全选 / 反选 / 清空 / 填充 / 复制 / 剪切 / 粘贴 / 粘为新图层 / 粘为新画布）
→ 变形（`sel-more`：斜切 / 透视、网格变形、完成、还原、裁切到选区）→ 工具（`sel-more-tools`：
翻转 / 扩展 / 收缩 / 描边 / 删除）；每页最多 7 项（再多 `ringLayout` 会把半径撑出屏幕）。
PC 模式一次铺开三页的并集（去掉「返回 / 更多」这两个纯导航项），饼菜单同样过滤导航项。
`SESSION.registerOrbCatalog("sel", …)` 登记的是三页的并集（`selCatalog`），
所以界面定制面板与动作搜索能列到翻页后面的条目。收起选区球会把当前页复位回第一页。

**状态机约定**（改这里之前先读）：
- 变形是**常驻模式**（`xf.mode === "warp"`）：`pointerup` 只结束当前这一次拖拽（清 `xf.drag`），
  **不落笔**；画布球里的「完成 / 还原」提交或放弃。切工具 / 切图层 / 撤销 / 重做 / 跳历史之前，
  `View.flushStroke()` 会先 `finishWarp(false)` 把它落下来（浮动内容只活在内存里，
  而图层已经被 `floatCut` 清空 —— 不能让它跨过这些操作）。`onMove` / `onDown` / `onUp`
  里凡是走 `rotate/scale` 的分支都必须先排除 warp，否则指针一动就会被当成缩放。
- **进入变形不改图层**：`floatCut` 推迟到第一次真正拖动（`warpMove` → `applyWarp`），
  因此「进去看一眼再退出」不会留下被清空的图层，也不产生历史。
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
npm test        # 2060 条断言：引擎 / 选区 / 历史 / 播放 / 设置 / 引导 / 渲染 / 导出 / Aseprite 读写 / 返回手势 / UI 控件与令牌（末尾打印 assertions: N）
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
`ScrubNum` 新增可选 `padTitle`，由 `ui/base.tsx` 注入译文）。`ui/base.tsx` 继续导出全部这些名字，
并额外提供 `useSession()` 与带译文的 `ScrubNum` 包装。

### 20.4 设计令牌与主题

`style.css` 顶部 `:root` 定义尺寸令牌与主题色/固定色令牌，`[data-theme="light"]` 覆盖全部主题色令牌；
`io/theme.ts` 的 `applyTheme(mode)` / `themeMode(v)` 写 `<html data-theme>` 与 `<meta name="theme-color">`，
设置项为 `display.theme`（`Prefs.theme`，默认 `dark`）。
