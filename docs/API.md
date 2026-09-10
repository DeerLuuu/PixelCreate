# PixelCraft API 接口文档

> 版本：随源码更新 · 覆盖 `src/` 下全部对外导出
> 约定：坐标为文档像素（整数，左上为原点）；`RGBA = [r, g, b, a]`（0–255）；`Rect = { x, y, w, h }`（文档像素，含左上、宽高）
> 引擎层（`engine/` `app/` `tools/`）**不依赖 DOM**，可在 Node 中直接测试；`render/` `io/` `ui/` 需要浏览器环境

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
```

### 11.8 播放 / 洋葱皮 / 画布

```ts
togglePlay() / startPlayback() / stopPlayback() / cycleLoopMode(): LoopMode
toggleOnion() / setOnionOn(on) / setOnionBefore(n) / setOnionAfter(n)
setOnionAlpha(n) / setOnionTint(on) / setOnionWrap(on)
setGridMode("off"|"pixel"|"iso") / setGridSize(n)
canvasSize(w, h, ax, ay) / spriteSize(w, h) / cropSmart()
sampleComposite(x, y): RGBA | null        // 取合成后的颜色
```

### 11.9 撤销与结构变更

```ts
undo() / redo() / jumpHistory(index)
struct(label, fn)             // 结构快照式撤销
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

### 18.7b 画布空间命中测试 `app/canvas-space.ts`

纯函数，视图变换以**聚焦画布**为锚点（它的矩形恒为 `0,0..w,h`），所以屏幕点要先换算成空间坐标：

| 导出 | 签名 | 说明 |
|---|---|---|
| `canvasAtScreen` | `(docs, focusIndex, ox, oy, zoom, sx, sy) => number` | 屏幕点下的画布下标（`-1` = 空白；后画的在上，重叠时取后者） |
| `screenToCanvas` | `(…) => { index, x, y } \| null` | 同上，并给出画布内的像素坐标（`0..w-1`） |

`View.canvasAtScreen()` 与调色球拖拽都走这里，保证「这个点属于哪张画布」只有一份实现。

### 18.8 吸附设置

`canvas.snapOn`（总开关）、`canvas.snapRange`（4–48 屏幕像素）、`canvas.snapGap`（0–48 画布像素）、
`canvas.snapInColor` / `canvas.snapOutColor`（`kind: "color"`，`#rrggbb`，非法值被拒绝）。

`src/app/canvas-snap.ts` 另外导出：

| 导出 | 说明 |
|---|---|
| `SNAP_GAP` (8) | 左右并排时两张画布之间的空隙 |
| `TITLE_EXTRA` (20) | **上下叠放**时额外留出的空隙：下面那张的标题栏要放进这段空隙里 |
| `SNAP_GAP_V` (28) / `stackGap(gap)` | 叠放空隙 = 配置空隙 + `TITLE_EXTRA`（28 ≥ 标题栏 26px + 两侧各 1px） |
| `titleObstacle(self, others, lift)` | 找出「位于正上方、横向会被标题栏压到」的画布里最深的下边缘（`null` = 无遮挡） |
| `titleTop(canvasTop, obstacleBottom, lift, pad)` | 标题栏纵向位置：空闲时 `上沿 − 30`，有遮挡时落在空隙内（既不压邻居也不压自己） |
| `TITLE_H` (26) / `TITLE_LIFT` (30) | 标题栏高度与默认抬升量 |

叠放方向的两个「贴边」候选允许更大的容差（`touchOk`）：把两张画布**推开**的修正量可以比 `snapRange`
多 `TITLE_EXTRA`，否则拖到邻居身边时永远够不到更大的叠放空隙。`Session.canvasesTouch` 也用
`stackGap()` 判断，保证叠放后能正常成组。

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

### 测试

```bash
npm test        # 1108 项：引擎 / 选区 / 历史 / 播放 / 设置 / 引导 / 渲染 / 导出 / 返回手势 / UI 控件与令牌
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
