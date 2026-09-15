// GestureServer（手势状态机）—— 见 docs/ARCHITECTURE.md §3.3 第 5 项。
//
// 这里是 `View` 的**手势状态机**，分两层：
//   · `TapMachine` —— 轻点序列（单击 / 双击边距·画布·换画布 / 三击 / 双指双击）的判定。
//     无 DOM、无 Session，`up()` 只返回一个 `TapOutcome`，动作体由调用方执行。
//   · `GestureController` —— P5 第三片：`View` 的四个指针事件入口（`onDown` / `onMove` /
//     `onUp` / `onCancel`）整体搬到这里。它通过 `GestureHost` 接口操作 `View`
//     （触点会话状态与「笔迹 / 变换 / 选区」的动作体都还在 View 上），所以这一片是
//     **搬迁而非重写**：分支顺序、阈值、副作用顺序逐字保留。
//
// 为什么这么切：`GetureController` 的判定与状态迁移可以脱离 DOM 单测（`tests/gesture-host.test.ts`
// 用假 host 驱四个入口），而 `View` 只剩覆盖层绘制与各动作体。
// `GestureHost` 的成员表就是两边的**唯一接触面** —— 想让控制器多碰一个字段，就得先在接口里声明。
//
// TabMachine 的口径（与搬家前的 `onUp` 逐个分支对齐，改之前先读这一段）：
//   · 第二次点击**落在画布内且「双击画布」没映射动作**时，这一下被吞掉但不清零计数，
//     留给三击（三击＝放大，会顺手把前一下画上去的那个点撤销掉）。
//   · 双击**边距**＝用户映射的动作；双击**另一个画布**＝聚焦并适配（与映射无关）。
//   · PC 模式不做单击连击（滚轮与快捷键替代）—— 所以 `isPc` 下永远只出 `plain`。
//   · 双指轻点序列（两指都抬起、且中途没缩放）＝两下之内算「双指双击」；
//     **中点落在画布内不算**（画画时太容易碰到）；缩放过的双指抬手不算轻点。
//   · 多指介入（第 3、4 根手指落下）与 pointercancel 都会清掉双指序列 —— 见 `clearTwoTapSeq()`。
//   · ⚠ 已知问题：单指第二下只要落在画布上就会被「双击画布 / 聚焦适配」吃掉并清零计数，
//     于是画布内攒不到第三下（`gTripleTap` 默认够不到）—— 现状由测试钉住，见 `docs/API.md` §15c2。
import type { Session } from "../app/session";
import type { GestureActionId } from "../app/gesture-ids";
import type { MoveState } from "../tools/select";
import type { ToolId } from "../tools/registry";
import type {
  AnchorId, ScreenFrame, XfBox, XfKind, XfParams,
} from "../tools/xform";
import { Sel } from "../engine/doc";
import { Stroke } from "../tools/stroke";
import { SYM_ANGLES, isSymTool } from "../tools/registry";
import { clamp } from "../engine/types";
import { isPc } from "../io/pcmode";
import {
  FOUR_MOVE_PX_DEFAULT, fourFingerArmed, longPressAllowed, mouseButtonIntent, outsideDoc,
  pinchAround, pinchBaseOf, pinchNow, type Pt,
} from "./input";

/** 单指连点的时限（ms）：超时就从「第一下」重新数 */
export const TAP_SEQ_MS = 480;
/** 单指连点的落点容差（px）：超过就不算同一串点击 */
export const TAP_SEQ_PX = 64;
/** 双指双击的落点容差（px），比特例里的单指更宽松（两指中点本来就有抖动） */
export const TWO_TAP_PX = 80;

/** `TapMachine.up()` 需要的当次上下文（都是 View 侧现成的读数，机器自己不查任何东西） */
export interface TapUpInput {
  now: number;
  pt: Pt;
  /** 这一下的像素坐标是否落在画布内 */
  overDoc: boolean;
  /** 松手处命中的画布索引（-1 = 没命中任何画布） */
  canvasIndex: number;
  /** 当前聚焦的画布索引 */
  docIndex: number;
  /** 手势期间画过（有笔迹且离开过起点）：第二次点击前拖动过就断掉连点 */
  moved: boolean;
  hasStroke: boolean;
  hasSelDrag: boolean;
  hasXf: boolean;
  /** 这一次双指手势里真的缩放过（缩放过就不是轻点） */
  pinchZoomed: boolean;
  /** 这一次双指手势里真的缩放过（缩放过就不是轻点） */
  isPc: boolean;
  /** 设置里的双击时限（`prefs.doubleTapMs`）；双指双击共用它 */
  doubleTapMs: number;
  /** 「双击画布」是否映射了动作（没映射时第二下被吞掉，留给三击） */
  canvasDoubleMapped: boolean;
  /** 双指轻点的中点是否落在画布内（落在画上不许触发重做） */
  midOverDoc: boolean;
}

/**
 * 一次抬手的结果。View 只按这个执行副作用：
 * - `plain` 照常提交笔迹 / 落一个点；
 * - 其余都表示「这一下被手势吃掉」，动作体见 `view.ts` 的 onUp。
 */
export type TapOutcome =
  /** 没被手势接管：照常落笔 / 提交 */
  | { kind: "plain" }
  /** 第二次点击落在画布内且没映射动作：吞掉（清零由下一次三击判断） */
  | { kind: "skip" }
  /** 双指轻点：中点落在画布内，整串作废 */
  | { kind: "two-finger-skip" }
  /** 双指轻点：记下第一下，等第二下 */
  | { kind: "two-finger-first" }
  /** 双指双击成立：跑设置里的动作 */
  | { kind: "two-finger-redo"; mid: Pt }
  /** 双击落在别的画布上（或当前画布没映射动作）：聚焦并适配 */
  | { kind: "focus-canvas"; index: number }
  /** 双击落在画布外的边距上 */
  | { kind: "margin-double" }
  /** 双击落在画布上（该动作已映射） */
  | { kind: "canvas-double" }
  /** 三击（落在画布内＝放大，会顺手撤销前一下画的那一个点） */
  | { kind: "triple"; overDoc: boolean; undoSingleDot: boolean };

/**
 * 轻点序列状态机。
 *
 * 持有：单指连点计数与上一次的时间/落点、双指轻点的上一次时间/中点、以及
 * 「上一次完成的单击画了什么」——三击放大时要把那一个点撤销掉，免得留下一个孤点。
 */
export class TapMachine {
  /** 单指连点计数（1 = 第一下；2 = 第二下……） */
  private n = 0;
  /** 上一次单击的时间 */
  private t = 0;
  /** 上一次单击的落点 */
  private pt: Pt | null = null;
  /** 上一次**双指轻点**的时间 */
  private two = 0;
  /** 上一次双指轻点的中点 */
  private twoPt: Pt | null = null;
  /** 这一次手势的双指中点（抬起时用来判「落在画上」与双击距离） */
  private twoMid: Pt | null = null;
  /** 这一次手势有没有出现过两根手指 */
  private hadTwo = false;
  /** 上一次完成的单击「是不是没动过就落了一笔」（点） */
  private lastWasDraw = false;
  /** 那一下是不是真的记进了历史（否则没东西可撤） */
  private lastChanged = false;

  /** 第二根手指落下：记住双指中点，这一次手势就带上「双指」标记 */
  noteSecondFinger(a: Pt, b: Pt): void {
    this.twoMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.hadTwo = true;
  }

  /** 当前手势的双指中点（没出现过双指时为 null）——View 用它算「中点是否落在画布内」 */
  twoMidPoint(): Pt | null {
    return this.twoMid;
  }

  /**
   * 清掉双指轻点序列：第 3/4 根手指落下、四指手势成立、双指长按已经触发、
   * 以及 `pointercancel` 都要调它。**不动单指连点计数** —— 单指序列不该被多指打断
   * （多指落下时早先那一下单击仍然算数，改这里会让「单击后误触两指」断掉三击）。
   */
  clearTwoTapSeq(): void {
    this.two = 0;
    this.twoPt = null;
    this.twoMid = null;
    this.hadTwo = false;
  }

  /** 一笔提交完，记下「这一下单击画了没有」给三击用 */
  noteSingleTap(painted: boolean, changed: boolean): void {
    this.lastWasDraw = painted;
    this.lastChanged = changed;
  }

  /** 抬手：算出这次抬手算什么（**只读入参、只改自己的状态**，没有副作用） */
  up(i: TapUpInput): TapOutcome {
    // 双指序列优先：只要这一次手势出现过两根手指，且没缩放 / 没在画 / 没在选 / 没在变换
    const hadTwo = this.hadTwo;
    this.hadTwo = false;
    if (hadTwo && !i.pinchZoomed && !i.hasStroke && !i.hasSelDrag && !i.hasXf && this.twoMid) {
      const mid = this.twoMid;
      this.twoMid = null;
      if (i.midOverDoc) {
        this.two = 0;
        this.twoPt = null;
        return { kind: "two-finger-skip" };
      }
      if (this.twoPt && i.now - this.two < i.doubleTapMs &&
        Math.hypot(mid.x - this.twoPt.x, mid.y - this.twoPt.y) < TWO_TAP_PX) {
        this.two = 0;
        this.twoPt = null;
        return { kind: "two-finger-redo", mid };
      }
      this.two = i.now;
      this.twoPt = mid;
      return { kind: "two-finger-first" };
    }
    // 拖动过的第二次点击不算连点（一笔画完就断串）
    if (i.moved) {
      this.n = 0;
      return { kind: "plain" };
    }
    const cont = !i.isPc && this.n > 0 && i.now - this.t < TAP_SEQ_MS && this.pt &&
      Math.hypot(i.pt.x - this.pt.x, i.pt.y - this.pt.y) < TAP_SEQ_PX;
    this.n = cont ? this.n + 1 : 1;
    this.t = i.now;
    this.pt = { x: i.pt.x, y: i.pt.y };
    // 双击画布：换画布＝聚焦适配；当前画布只有在「双击画布」没映射动作时才走这条
    if (this.n === 2 && i.canvasIndex >= 0 && (i.canvasIndex !== i.docIndex || !i.canvasDoubleMapped)) {
      this.n = 0;
      return { kind: "focus-canvas", index: i.canvasIndex };
    }
    if (this.n === 2 && !i.overDoc) {
      this.n = 0;
      return { kind: "margin-double" };
    }
    if (this.n === 2 && i.overDoc && i.canvasDoubleMapped) {
      this.n = 0;
      return { kind: "canvas-double" };
    }
    if (this.n === 3) {
      this.n = 0;
      let undoSingleDot = false;
      if (i.overDoc) {
        // 三击＝放大：先把前一下留下的那个点撤掉（只在真的画过、且还有历史时）
        undoSingleDot = this.lastWasDraw && this.lastChanged;
        this.lastWasDraw = false;
        this.lastChanged = false;
      }
      return { kind: "triple", overDoc: i.overDoc, undoSingleDot };
    }
    if (this.n === 2 && i.overDoc) {
      // 第二下落在画布内但没映射动作：吞掉它、**不清零**，留给第三下（三击）
      return { kind: "skip" };
    }
    return { kind: "plain" };
  }
}

// ---------------------------------------------------------------------------
// 手势会话状态：这些 type 以前内联在 `view.ts` 的字段声明里（占了大半屏），
// 现在跟着状态机一起放这儿；`View` 的字段改成引用这些别名。
// ---------------------------------------------------------------------------

/** ⑦ 画布调整模式的拖动状态（`ax` / `ay` = 固定的那一侧） */
export interface ResizeDragState {
  ax: -1 | 0 | 1;
  ay: -1 | 0 | 1;
  x0: number; y0: number; w0: number; h0: number;
  w: number; h: number; moved: boolean;
}

/** 选区拖动（框选 / 套索 / 移动内容）的进行中状态 */
export interface SelDragState {
  kind: "rect" | "move" | "lasso";
  x0: number; y0: number; x1: number; y1: number;
  before: Uint8ClampedArray | null;
  b: { x: number; y: number; w: number; h: number };
  moved: boolean;
  sx: number; sy: number;
  mv?: MoveState | null;
  pts?: [number, number][];
  dx?: number; dy?: number;
  cut?: boolean;
  /** 只移动**选区边框**（贴着边线的环带起拖）：内容留在原地不动 */
  frameOnly?: boolean;
}

/** ⑧ 等距图形模式：正在拖的抓手 / 整块（含按下那一刻的形状尺寸与原点） */
export interface IsoDragState {
  kind: "move" | "top" | "right" | "bottom" | "left" | "height";
  x0: number; y0: number;
  origin0: { x: number; y: number };
  w0: number; d0: number; h0: number;
}

/** 轮廓填充：收集中的路径，松手时用当前色填充 */
export interface OutlineState {
  pts: Array<[number, number]>;
  li: number;
  fi: number;
  before: Uint8ClampedArray | null;
  dx: number; dy: number;
}

/** 多点路径（折线 / 曲线）：轻点加点，点最后一点完成、点前一点删掉它 */
export interface PathState {
  st: Stroke;
  pts: Array<[number, number]>;
  smooth: boolean;
  cur: [number, number] | null;
}

/** 多指长按（2 或 3 指按住不动）：待触发的计时器状态 */
export interface HoldState {
  n: number;
  mid: { x: number; y: number };
  starts: Map<number, { x: number; y: number }>;
  t: number;
}

/** 变换抓手的一次拖动（`xf` 槽里的交互；自由变换看 `xf.mode === "warp"`） */
export interface XfDragState {
  kind: XfKind;
  anchor?: AnchorId;
  start: Pt;
  pivot0?: Pt;
  /**
   * 按下那一刻**被抓的那个图标自己**的屏幕位置（缩放 / 旋转 / 枢轴用；`move` 时等于 `start`）。
   *
   * 解算以它为参照，而不是手指按下的那一点：命中半径有 38px（触屏），按偏的时候
   * 「手指 ↔ 图标」那一截会被冻结在整个拖动里 —— 图标只是平行跟着手指走，永远隔着那 40px
   * （用户报的「离鼠标位置估计有 40px」）。以图标为参照＝图标先贴到指针上、再 1:1 跟手。
   */
  h0?: Pt;
  /**
   * 按下那一刻的变换参数快照（`sx` / `sy` / `angle` / `skewX` / `skewY`）。
   *
   * 拖动中的解算量都是**这一次拖拽**的增量（缩放是相对倍率、旋转是增量角、斜切是增量 tan），
   * 累加必须以此为基准 —— 每次 `pointermove` 都从它重算，于是「同一次拖拽里挪几下」
   * 不会把倍率连乘（那会让内容越拖越小 / 越拖越扁），而「松手后再拖一次」才继续累加。
   */
  tp0?: { sx: number; sy: number; angle: number; skewX: number; skewY: number };
}

/**
 * 选区自由变换（移动 + 缩放 + 旋转 + 斜切 / 四点斜切透视 + 网格）的会话状态。
 * **一次会话 = 一条 undo**：松手只结束这次拖拽，事务一直开着，
 * 直到「完成」（提交）/「还原」（丢弃）/ 切工具 / 切帧 / 切图层。
 */
export interface XfSession {
  mode: "rot" | "scale" | "warp";
  axis: "xy" | "x" | "y";
  li: number; fi: number;
  st: MoveState;
  cx: number; cy: number; ax: number; ay: number;
  p0x: number; p0y: number; ang0: number;
  moved: boolean;
  cut?: boolean;
  buf?: Uint8ClampedArray;
  cells?: number[];
  /** 自由变换（斜切/透视/网格）用的控制点（画布坐标）与正在拖的那一个 */
  warpKind?: "quad" | "mesh";
  pts?: Pt[];
  drag?: number;
  /** 抓住控制点那一刻「手指 ↔ 控制点」的偏移（下标空间）。旧实现遗留字段，保留以免旧状态读到 undefined */
  grab?: Pt;
  /**
   * 「拖动整块内容」的起点：记下按下时指针的**连续**下标与该时刻的全部控制点，
   * 每次移动都从它重算位移（不累加、不漂），所有控制点一起走 —— 锚点因此跟着内容走。
   */
  move?: { x0: number; y0: number; pts: Pt[] };
  /** 变换参数（枢轴 / 角度 / 缩放 / 斜切），**绕枢轴**组成矩阵（见 xform.ts） */
  tp?: XfParams;
  /** 会话开始时的内容框（**外框口径**）/ 枢轴；`box0` 是拖动解算的固定参照 */
  box0?: XfBox;
  pivot0?: Pt;
  /** 会话开始时的屏幕框（拖动解算的固定参照：拖动过程中框会转，参照不能跟着动） */
  screen0?: ScreenFrame;
  /** 枢轴 / 锚点是不是被用户拖过（「缩放后跟位、旋转后不动」只跟用户拖过的枢轴有关） */
  pivotTouched?: boolean;
  /** 斜切的**基准点**（不动的那条线，＝被拖那条边的对面中点；`affineFrom` 的 `skewPivot`） */
  skewAnchor?: Pt;
  /** 这次会话里各语义各出现过没有（history 标签与「有没有真改过」用） */
  kinds?: { move: boolean; scale: boolean; rotate: boolean; skew: boolean };
  /** 走「像素精确通道」的落点（整数平移 / 90° 倍数旋转）：{dx, dy, steps} */
  exact?: { dx: number; dy: number; steps: number };
}

/**
 * `GestureController` 操作 `View` 的**唯一接触面**：想让控制器多碰一个字段 / 方法，
 * 就得先在这里声明（编译器会拦住漏声明的访问）。
 *
 * **触点会话状态不在这个接口里** —— 它们由 `GestureController` 自己持有（见类里的字段），
 * `View` 只**读**它们来画覆盖层。所以这个接口只剩下：公共依赖（`session` / `host`）、
 * 视口三元组、以及各工具的动作体方法。
 */
export interface GestureHost {
  // ---- 公共依赖 ----
  session: Session;
  /** 画布宿主元素（`View` 的字段名就叫 `host`） */
  host: HTMLElement;

  // ---- 视口（只有读写权，所有权仍归 View：视图变换是渲染的事） ----
  ox: number; oy: number; zoom: number;

  /** 四指手势成立后要回调的开场（App 里接的帧预览） */
  onFramePreview: (() => void) | null;

  // ---- 坐标与渲染 ----
  evPt(e: PointerEvent): Pt;
  vpW(): number;
  vpH(): number;
  screenToPixel(sx: number, sy: number): { x: number; y: number };
  canvasAtScreen(sx: number, sy: number): number;
  clampView(): void;
  refresh(force: boolean): void;
  drawOverlay(rebuildTint?: boolean): void;
  repaintStroke(): void;
  drawPathPreview(): void;
  syncCursor(): void;
  labelFor(kind: string): string;
  toolNow(): ToolId;
  isPathTool(t: string): boolean;
  preciseDrag(): boolean;

  // ---- 长按 / 取色 ----
  cancelHold(): void;
  holdMoved(): boolean;
  armHold(n: number, action: GestureActionId, tag: string): void;
  cancelPickTimer(): void;
  enterPickMode(x: number, y: number): void;
  samplePickCell(x: number, y: number, strong: boolean): void;

  // ---- 喷枪 ----
  startSpray(): void;
  stopSpray(): void;

  // ---- 工具动作体 ----
  outlineDown(pp: { x: number; y: number }): void;
  outlineMove(pp: { x: number; y: number }): void;
  endOutline(commit: boolean): void;
  pathDown(pp: { x: number; y: number }): void;
  selDown(pp: { x: number; y: number }, pt: Pt, e: PointerEvent): void;
  selMove(pp: { x: number; y: number }): void;
  startSelMove(pp: { x: number; y: number }): boolean;
  endSelDrag(commit?: boolean): void;
  dropSelDragToCanvas(sx: number, sy: number): boolean;
  wireRedirect(st: Stroke, tgt: { dx: number; dy: number } | null): void;

  // ---- 等距 / 画布调整 ----
  isoHitAt(pt: Pt): "top" | "right" | "bottom" | "left" | "height" | "move" | null;
  isoDragTo(pt: Pt): void;
  resizeHit(pt: Pt): { ax: -1 | 0 | 1; ay: -1 | 0 | 1 } | null;

  // ---- 对称轴 ----
  symLockBtn(): [number, number] | null;
  symHit(pt: Pt): "mv" | "rot" | null;

  // ---- 选区自由变换 ----
  inXform(): boolean;
  tryStartXf(pt: Pt): boolean;
  xfHitAt(pt: Pt): { kind: XfKind; anchor?: AnchorId } | null;
  xfMove(pt: Pt): void;
  xfEndDrag(): void;
  xfBreakDrag(): void;
  endXf(): void;
  abortXf(): void;
  warpHandleAt(pt: Pt): number;
  warpStartMove(pt: Pt): boolean;
  warpMove(pt: Pt): void;
  warpMoveContent(pt: Pt): void;
}

/**
 * 指针事件入口。`View` 只做三件事：绑事件、把 `this` 交给控制器、在 `destroy()` 时解绑。
 * 四个方法都是**搬迁过来的原样逻辑**（`this.` 换成 `host.`），分支顺序与副作用顺序未改。
 */
export class GestureController {
  /** 轻点序列状态机（本控制器私有；`View` 不再持有） */
  private tap = new TapMachine();

  /** viewport state when the first finger landed. Restored the instant a
   *  four-finger contact is confirmed so jitter while fingers 2-4 land can
   *  never zoom/pan the canvas underneath the gesture. */
  fourView0: { ox: number; oy: number; zoom: number } | null = null;

  pinchBase: { mx: number; my: number; dist: number; ox: number; oy: number; zoom: number } | null = null;

  /** multi-finger long press (2 or 3 fingers held still): pending timer */
  hold: HoldState | null = null;

  panLast: Pt | null = null;

  /** last logical pointer position (the cross-canvas drop preview needs it) */
  lastPt: Pt | null = null;

  longT: number | null = null;

  pickAnchor: [number, number] | null = null;

  pickLast: [number, number] | null = null;

  magCenter: Pt | null = null;

  gestureStartPx: Pt | null = null;

  cursor: { x: number; y: number; size: number } | null = null;

  /** what the adjust gesture is currently holding (set while unlocked) */
  symTarget: "mv" | "rot" | null = null;

  /** ⑦ 画布调整模式的拖动状态（ax/ay = 固定的那一侧）—— 类型在 `servers/gesture.ts` */
  resizeDrag: ResizeDragState | null = null;

  /** 等距图形模式：正在拖的抓手 / 整块（含按下那一刻的形状尺寸与原点） */
  isoDrag: IsoDragState | null = null;

  /** freehand outline tool: collected path, filled with the current colour on release */
  outline: OutlineState | null = null;

  /** pending multi-point path (polyline / curve): tap adds a point, tapping
   *  the last point finishes, tapping the one before removes it */
  path: PathState | null = null;

  selDrag: SelDragState | null = null;

  /** 旋转 / 缩放 / 斜切 / 移动 / 枢轴拖动（`xf` 槽里的交互，自由变换见 xf.mode === "warp"） */
  xfDrag: XfDragState | null = null;

  /** 选区自由变换的会话状态（口径见 `servers/gesture.ts` 的 `XfSession`） */
  xf: XfSession | null;

  /** PC 鼠标悬停在哪个抓手 / 圈上（画圈提示与光标形状用；`anchor` 用于点亮那一个图标） */
  xfHover: { kind: XfKind; anchor?: AnchorId; x: number; y: number } | null = null;

  /** 最近一次命中的语义描述（测试与状态栏共用） */
  xfHint: string | null = null;

  stroke: Stroke | null = null;

  constructor(private host: GestureHost) {}

  pointers = new Map<number, Pt>();

  /** each finger's screen position at its own touchdown. Whether a finger is
   *  "sliding" is measured from ITS own start, so fingers that land at
   *  different times — or lift mid-gesture — never skew the result. */
  fourStart = new Map<number, { x: number; y: number }>();

  /** four-finger gesture tracking (opens the all-frames preview) */
  fourSeen = false;

  /** latched as soon as four fingers are down and at least two of them are
   *  sliding (each past FOUR_MOVE_PX in any direction): the preview fires on
   *  the last lift even if the hand slid back or stopped before lifting */
  fourArmed = false;

  /** viewport state when the first finger landed. Restored the instant a
   *  four-finger contact is confirmed so jitter while fingers 2-4 land can
   *  never zoom/pan the canvas underneath the gesture. */


  /** the pinch actually zoomed (else it was a two-finger tap) */
  pinchZoomed = false;

  /** multi-finger long press (2 or 3 fingers held still): pending timer */

  /** set when a hold fired, so the following lifts cannot count as taps */
  holdFired = false;


  /** last logical pointer position (the cross-canvas drop preview needs it) */

  /** PC 输入：空格键按住＝临时用另一个色槽（背景色）绘制 */
  spaceDown = false;

  /** PC 输入：Alt 按住＝下一次单击取色（光标也变成吸管） */
  altDown = false;

  /** PC 输入：这一笔用另一个颜色槽（右键绘制） */
  altPaint = false;

  /** PC 输入：中键拖动平移中 */
  mousePan = false;



  pickMode = false;


  /** pixel loupe (magnifier) shown only while picking a colour */
  mag = false;


  /** has the current stroke left its starting cell? (false = pure tap) */
  gestureMoved = false;



  /** the open stroke was redirected to a referenced canvas (no auto-select) */
  strokeRedirected = false;

  /** what the adjust gesture is currently holding (set while unlocked) */

  /** ⑦ 画布调整模式的拖动状态（ax/ay = 固定的那一侧）—— 类型在 `servers/gesture.ts` */

  /** 等距图形模式：正在拖的抓手 / 整块（含按下那一刻的形状尺寸与原点） */

  /** freehand outline tool: collected path, filled with the current colour on release */

  /** pending multi-point path (polyline / curve): tap adds a point, tapping
   *  the last point finishes, tapping the one before removes it */


  /** 旋转 / 缩放 / 斜切 / 移动 / 枢轴拖动（`xf` 槽里的交互，自由变换见 xf.mode === "warp"） */

  /** 选区自由变换的会话状态（口径见 `servers/gesture.ts` 的 `XfSession`） */

  /** PC 鼠标悬停在哪个抓手 / 圈上（画圈提示与光标形状用；`anchor` 用于点亮那一个图标） */

  /** 最近一次命中的语义描述（测试与状态栏共用） */

  /** 正在拖变形控制点：画布上跟手显示当前坐标（`x, y`；半像素模式带一位小数） */
  warpDragOn = false;



  /** 只被 `onUp` 用到的两个笔迹助手（搬过来当自己的私有方法，不再占 `View` 的接触面） */
  private isShapeKind(k: string): boolean {
    return k === "line" || k === "rect" || k === "rectfill" || k === "ellipse" || k === "ellipsefill" || k === "circle" || k === "polygon";
  }

  onDown(e: PointerEvent): void {
    const host = this.host;   // 接触面（见 GestureHost）
    e.preventDefault();
    this.lastPt = host.evPt(e);
    try {
      host.host.setPointerCapture && host.host.setPointerCapture(e.pointerId);
    } catch { /* ignore */ }
    const pt = host.evPt(e);
    // ---- PC 鼠标：中键＝聚焦适配，右键 / 空格+左键＝用另一个色槽绘制
    this.altPaint = false;
    if (e.pointerType === "mouse") {
      const intent = mouseButtonIntent(e.button, this.spaceDown);
      // 中键：等价于触屏的双击画布（聚焦并适配），不再用于平移
      if (intent === "focus-fit") {
        const hitIdx = host.canvasAtScreen(pt.x, pt.y);
        if (hitIdx >= 0) {
          if (hitIdx !== host.session.docIdx) host.session.focusCanvas(hitIdx);
          host.session.fitCanvas();
          host.session.hapticTick("聚焦", 0.7);
        }
        return;
      }
      this.mousePan = false;
      // 右键，或按住空格＋左键：用另一个色槽（默认背景色）绘制
      this.altPaint = intent === "secondary";
      if (intent === "secondary") this.pointers.set(e.pointerId, pt);
    }
    this.pointers.set(e.pointerId, pt);
    // remember each finger's touchdown point — a finger counts as "sliding"
    // from its OWN start — and freeze the view state as soon as the first
    // finger lands so a confirmed 4-finger gesture can restore it
    if (!this.fourStart.has(e.pointerId)) this.fourStart.set(e.pointerId, { x: pt.x, y: pt.y });
    if (this.pointers.size === 1) this.fourView0 = { ox: host.ox, oy: host.oy, zoom: host.zoom };
    host.cancelPickTimer();
    this.pickMode = false;
    if (this.pointers.size >= 4) {
      // a four-finger gesture is never a two-finger tap sequence. Reset any
      // pinch/pan state built up while fingers 2-4 were landing: setup jitter
      // must never latch pinchZoomed (it would silently block the preview).
      this.fourSeen = true;
      this.fourArmed = false;
      host.cancelHold();
      this.pinchBase = null;
      this.pinchZoomed = false;
      this.tap.clearTwoTapSeq();
      this.panLast = null;
      if (this.outline) host.endOutline(false);
      host.stopSpray();
      if (this.stroke) { this.stroke.cancel(); this.stroke = null; }
      if (this.selDrag) {
        if (this.selDrag.kind === "move" && this.selDrag.cut) host.endSelDrag(false);
        else this.selDrag = null;
      }
      this.gestureMoved = false;
      // undo any zoom/pan the first fingers caused while landing: from the
      // 4th finger down the canvas must stay perfectly still mid-swipe
      if (this.fourView0 &&
        (this.fourView0.ox !== host.ox || this.fourView0.oy !== host.oy || this.fourView0.zoom !== host.zoom)) {
        host.ox = this.fourView0.ox;
        host.oy = this.fourView0.oy;
        host.zoom = this.fourView0.zoom;
        host.clampView();
        host.refresh(false);
      }
      return;
    }
    // a third contact is no longer a two-finger pinch: in practice it means
    // the hand is going for the 4-finger swipe, so anything the first two
    // fingers started is dropped and the gesture waits quietly for the 4th
    if (this.pointers.size >= 3) {
      if (this.outline) host.endOutline(false);
      host.stopSpray();
      if (this.stroke) { this.stroke.cancel(); this.stroke = null; }
      if (this.selDrag) {
        if (this.selDrag.kind === "move" && this.selDrag.cut) host.endSelDrag(false);
        else this.selDrag = null;
      }
      this.panLast = null;
      this.gestureMoved = false;
      host.cancelHold();
      this.pinchBase = null;
      this.pinchZoomed = false;
      this.tap.clearTwoTapSeq();
      // three fingers held still = three-finger long press (no system conflict)
      host.armHold(3, host.session.prefs.gThreeFingerLongPress, "三指长按");
      return;
    }
    if (this.pointers.size >= 2) {
      if (this.outline) host.endOutline(false); // 2nd finger = navigation, not a fill
      host.stopSpray();
      if (this.stroke) {
        // a second contact means navigation (pinch / multi-finger gesture),
        // never drawing: roll the half-drawn stroke back entirely instead of
        // committing it, or every pinch / 4-finger swipe would leave the
        // stroke started by the first finger behind as stray pixels
        this.stroke.cancel();
        host.session.repaint();
        this.stroke = null;
        this.gestureMoved = false;
      }
      if (this.xf && this.xf.mode === "warp" && this.xf.drag !== undefined) this.xf.drag = undefined;
      else if (host.inXform()) host.xfBreakDrag();
      else if (this.xf) host.endXf();
      const [a, b] = [...this.pointers.values()];
      this.pinchBase = pinchBaseOf(a, b, { zoom: host.zoom, ox: host.ox, oy: host.oy });
      this.pinchZoomed = false;
      this.tap.noteSecondFinger(a, b);
      // two fingers held still = two-finger long press (some phones map this
      // to the system screen-recognition gesture — 三指长按 is the alternative)
      host.armHold(2, host.session.prefs.gTwoFingerLongPress, "双指长按");
      return;
    }
    // flush an unfinished gesture left by a lost pointerup (e.g. rapid bucket taps)
    if (this.stroke) {
      const rec = this.stroke.commit(host.session.history, host.labelFor(this.stroke.kind));
      this.stroke = null;
      host.session.repaint();
      if (rec) host.session.changedUI();
    }
    // symmetry axis (brush tools): the lock button is always tappable, and
    // while unlocked the dashed line/knob are directly draggable
    if (host.session.sym !== "off" && isSymTool(host.session.tool)) {
      const lb = host.symLockBtn();
      if (lb && Math.hypot(pt.x - lb[0], pt.y - lb[1]) <= 24) {
        host.session.setSymLocked(!host.session.symLocked);
        return;
      }
      if (!host.session.symLocked) {
        const t = host.symHit(pt);
        if (t) {
          this.cursor = null;
          this.symTarget = t;
          host.drawOverlay();
          return;
        }
      }
      // unlocked but off the line, or locked: painting / panning proceed normally
    }
    const s = host.session;
    const tool = host.toolNow();   // 临时工具（拖动橡皮小项）优先
    const pp = host.screenToPixel(pt.x, pt.y);
    const doc = s.doc;
    // 点画布＝Delete 键重新作用于选区内容（而不是上次点的标题 / 图层 / 帧）
    s.setDelTarget("selection");
    // 「编辑界面」模式：画布完全不接受操作（拖动排序时不会误画）
    if (s.uiEdit) return;
    // ⑦ 画布调整模式：按下即接管，拖动四条边/四个角改尺寸（不绘制、不选择）
    if (s.resizeModeOn) {
      const hit = host.resizeHit(pt);
      if (hit) {
        this.resizeDrag = {
          ...hit, x0: pt.x, y0: pt.y,
          w0: doc.w, h0: doc.h, w: doc.w, h: doc.h, moved: false,
        };
      }
      return;
    }
    // ⑧ 等距图形模式：按下即接管 —— 抓手改尺寸/高度，其它地方拖动＝整块移动（都吸附栅格）
    if (s.isoOn) {
      const kind = host.isoHitAt(pt) ?? "move";
      const p = s.prefs.iso;
      this.isoDrag = {
        kind, x0: pt.x, y0: pt.y,
        origin0: { ...(s.isoOrigin ?? { x: 0, y: 0 }) },
        w0: p.w, d0: p.d, h0: p.h,
      };
      s.hapticTick("等距", 0.35);
      host.drawOverlay();
      return;
    }
    // Alt+单击：快速取色（与触屏长按取色等价，PC 上更顺手）
    if (e.altKey && e.pointerType === "mouse" && e.button === 0) {
      const c = s.sampleComposite(pp.x, pp.y);
      if (c) { s.setFgColor(c); s.hapticTick("取色", 0.8); s.repaint(); }
      return;
    }
    // ① 选区类工具（框选 / 套索 / 魔棒 / 轮廓填充）在画布外的空白处按下＝平移视图，
    //    与画笔工具一致：不用先切工具就能拖着看画布。
    //    **但抓手优先**：旋转 / 斜切的图标画在选区框**外** 30px（缩放 6px），选区贴着画布边时
    //    它们必然落在画布外 —— 早先这里无条件平移，等于这些图标一跑到画布外就按不到
    //    （用户报的「按钮不在画布内时触发拖动相机」）。变形模式的控制点同理。
    const outside = outsideDoc(pp, doc.w, doc.h);
    const blankPan = isPc() && e.pointerType === "mouse" &&
      (tool === "select" || tool === "lasso" || tool === "wand" || tool === "outline");
    const onGrab = blankPan && outside && (host.warpHandleAt(pt) >= 0 || !!host.xfHitAt(pt));
    if (blankPan && outside && !onGrab) {
      this.panLast = pt;
      this.gestureMoved = false;
      host.syncCursor();
      return;
    }
    if (tool === "outline") {
      host.outlineDown(pp);
      return;
    }
    const selOn = !!doc.sel && doc.sel.hasAny();
    // long-press eyedropper: disabled while a selection is shown or a selection
    // tool is active (holds there mean marquee/transform, not colour picking)
    const pickAllowed = !selOn && tool !== "select" && tool !== "lasso" && tool !== "wand";
    const longAction = host.session.prefs.gLongPress;
    const insideDoc = !outsideDoc;
    if (longPressAllowed({ isPc: isPc(), action: longAction, pickAllowed, insideDoc })) {
      this.pickAnchor = [pp.x, pp.y];
      this.longT = window.setTimeout(() => {
        this.longT = null;
        if (longAction === "pickColor") host.enterPickMode(pp.x, pp.y);
        else if (longAction !== "none") host.session.runGestureAction(longAction, { x: pt.x, y: pt.y });
      }, host.session.prefs.longPressMs);
    }
    // 自由变换（四点 / 网格）：控制点命中即开始拖；命中时顺手取消待触发的长按取色，
    // 免得慢速的精细拖动被长按抢走。
    // 抓住之后控制点**跟着指针走**（每次 `pointermove` 直接落在指针那一点上，不记偏移）——
    // 像素画里要的是「点被我拖到哪就是哪」，记偏移会让它只是平行跟着手指、落点算不准。
    if (this.xf && this.xf.mode === "warp") {
      const h = host.warpHandleAt(pt);
      if (h >= 0) {
        host.cancelPickTimer();
        this.xf.drag = h;
        this.xf.move = undefined;
        return;
      }
    }
    // 自由变换（四点 / 网格）是常驻模式：画布上除了控制点没有别的手势
    if (this.xf && this.xf.mode === "warp") {
      // 没抓到控制点、但按在内容上＝**拖动整块内容**：所有控制点一起平移，
      // 于是锚点跟着内容走；按在内容之外才是平移视图。
      if (host.warpStartMove(pt)) { host.cancelPickTimer(); return; }
      if (outside) this.panLast = pt;
      host.cancelPickTimer();   // 这次按下属于变形，别让它顺带起一次长按取色
      return;
    }
    // 自由变换的**会话中**：画布上除了抓手没有别的手势 —— 工具的按下分支
    // （selDown 的选区拖动 / 套索 / 重新框选 / 直接绘制）都会和「浮动内容」叠加，
    // 提交时历史 before 也会对不上，所以只留「拖到画布外＝平移视图」。
    // 变换会话里的「移动」仍然算抓手（点框内任何地方拖动＝移动内容）。
    if (host.inXform()) {
      // 会话里每一次按下都**重新判抓手**：再抓一次缩放 / 旋转 / 斜切 / 枢轴都要能用，
      // 只有「命中不了任何抓手、但落在框内」才算移动内容
      this.xfHover = null;
      if (host.tryStartXf(pt)) { host.cancelPickTimer(); return; }
      if (outside) this.panLast = pt;
      host.cancelPickTimer();
      return;
    }
    // 常规自由变换（Aseprite 那套：贴着框的固定图标抓手 / 枢轴 / 移动；PC 另有双层圈兜底）：
    // 先让变换框抢命中（它压在选区上面），命中不了才落到选区手势
    if (!this.xfDrag && selOn && host.tryStartXf(pt)) { host.cancelPickTimer(); return; }
    // pressing inside an existing selection moves its content directly;
    // it never restarts a marquee / reselects (empty area still does)
    if (!this.xf && selOn && (tool === "select" || tool === "lasso" || tool === "wand") && host.startSelMove(pp)) return;
    if (tool === "select") {
      host.selDown(pp, pt, e);
      return;
    }
    if (tool === "lasso") {
      this.selDrag = {
        kind: "lasso", x0: pp.x, y0: pp.y, x1: pp.x, y1: pp.y,
        before: null, b: { x: 0, y: 0, w: 0, h: 0 }, moved: false,
        sx: pp.x, sy: pp.y, pts: [[pp.x, pp.y]],
      };
      return;
    }
    // drawing tools: outside doc -> pan
    if (pp.x < 0 || pp.y < 0 || pp.x >= doc.w || pp.y >= doc.h) {
      this.panLast = pt;
      return;
    }
    if (tool === "picker") {
      this.mag = host.session.prefs.loupe;
      this.magCenter = { x: pp.x, y: pp.y };
      const c = s.sampleComposite(pp.x, pp.y);
      if (c) s.setFgColor(c);
      host.drawOverlay();
      return;
    }
    if (tool === "wand") {
      s.wandAt(pp.x, pp.y);
      return;
    }
    this.gestureMoved = false;
    this.gestureStartPx = pp;
    if (host.isPathTool(tool)) {
      host.pathDown(pp);
      return;
    }
    try {
      // a reference layer is not painted in place: the stroke is redirected to
      // the referenced canvas' own current layer/frame (and recorded in THIS
      // canvas' history, so undo works right here)
      const tgt = s.strokeTarget(s.curLayer());
      this.strokeRedirected = !!tgt;
      // 右键＝另一个颜色槽（默认就是背景色），其余工具行为完全一致
      const brush = this.altPaint ? { ...s.brush(), color: s.secondaryColor() } : s.brush();
      this.stroke = new Stroke(tgt ? tgt.doc : doc, tgt ? tgt.li : s.curLayer(), tgt ? tgt.fi : s.curFrame(),
        tool as never, brush, s.layerLocked(), s.sym, s.shapeSides, s.shapeFill,
        s.symOx, s.symOy, s.symAng, s.symFour, s.prefs.bucketGlobal, s.brushShape, s.shapeFromCenter);
      this.stroke.pixelPerfect = s.pixelPerfect;
      host.wireRedirect(this.stroke, tgt);
      // the bucket's colour tolerance / gap closing (similar-colour mode)
      this.stroke.fillTolerance = s.prefs.fillSimilar ? s.prefs.fillTolerance : 0;
      this.stroke.fillGaps = s.prefs.fillGaps;
      // indexed colour mode: paint colours snap to the palette
      this.stroke.snapColor = (c) => s.paletteSnap(c);
      // tiled preview: strokes wrap around the edges (seamless tiles)
      const tm = s.prefs.tileMode;
      this.stroke.wrapX = tm === "row" || tm === "grid";
      this.stroke.wrapY = tm === "col" || tm === "grid";
    } catch {
      // the layer is locked (or a reference whose source layer is locked/gone)
      this.stroke = null;
      s.paintBlockedNote();
      return;
    }
    if (tool === "bucket" && s.prefs.bucketGrad) {
      this.stroke.gradEnd = [s.bg[0], s.bg[1], s.bg[2], s.bg[3]];
      this.stroke.gradBlock = s.prefs.bucketGradMode === "2" ? 2 : s.prefs.bucketGradMode === "4" ? 4 : s.prefs.bucketGradMode === "8" ? 8 : 1;
    }
    if (tool === "airbrush") {
      this.stroke.sprayMin = s.prefs.airbrushMin;
      this.stroke.sprayMax = s.prefs.airbrushMax;
      host.startSpray();
    }
    this.stroke.startAt(pp.x, pp.y);
    host.repaintStroke();
  }

  onMove(e: PointerEvent): void {
    const host = this.host;   // 接触面（见 GestureHost）
    const pt = host.evPt(e);
    this.lastPt = pt;
    const wasDown = this.pointers.has(e.pointerId);
    if (wasDown) this.pointers.set(e.pointerId, pt);
    // ⑦ 画布调整模式拖动中：换算成画布像素后预览新尺寸
    if (this.resizeDrag) {
      const g = this.resizeDrag;
      const z = Math.max(0.01, host.zoom);
      const dx = (pt.x - g.x0) / z, dy = (pt.y - g.y0) / z;
      const nw = Math.max(1, Math.min(1024, Math.round(g.w0 + (g.ax === 1 ? -dx : g.ax === -1 ? dx : 0))));
      const nh = Math.max(1, Math.min(1024, Math.round(g.h0 + (g.ay === 1 ? -dy : g.ay === -1 ? dy : 0))));
      if (nw !== g.w || nh !== g.h) { g.w = nw; g.h = nh; g.moved = true; }
      host.drawOverlay();
      return;
    }
    // ⑧ 等距图形模式拖动中：抓手改尺寸 / 高度，其它地方拖动＝整块移动（都按栅格吸附）
    if (this.isoDrag) {
      host.isoDragTo(pt);
      host.drawOverlay();
      return;
    }
    // Alt 按住＝取色模式：光标跟着换成吸管（鼠标没有别的提示手段）
    if (e.pointerType === "mouse" && this.altDown !== e.altKey) {
      this.altDown = e.altKey;
      host.syncCursor();
    }
    // a pending multi-finger long press dies the moment a finger slides
    if (this.hold && host.holdMoved()) host.cancelHold();
    // auto-pan the viewport while a draw/transform/selection drag nears the edge.
    // Speed scales with how deep into the edge zone the pointer is, but is capped
    // per event so the scroll stays slow, smooth and controllable.
    //
    // **精调拖动期间不自动平移**（旋转 / 缩放 / 斜切 / 枢轴 / 变形控制点）：视口一动，
    // 解算用的参考点（枢轴屏幕位、按下时的起点）就跟着动 —— 角度会跳、抓手会从手指下面
    // 滑走，用户看到的就是「锚点乱飞」。笔迹与普通选区/内容拖动照旧。
    if (host.session.prefs.autoPan && wasDown && this.pointers.size === 1 && !host.preciseDrag() &&
      (this.stroke || this.xf || this.selDrag)) {
      const M = host.session.prefs.autoPanMargin, w = host.vpW(), h = host.vpH();
      const MAX = host.session.prefs.autoPanSpeed; // px per event, 1..6
      const SPEED = 0.28 * (MAX / 3);
      let panx = 0, pany = 0;
      if (pt.x < M) panx = (pt.x - M) * SPEED; else if (pt.x > w - M) panx = (pt.x - (w - M)) * SPEED;
      if (pt.y < M) pany = (pt.y - M) * SPEED; else if (pt.y > h - M) pany = (pt.y - (h - M)) * SPEED;
      panx = clamp(panx, -MAX, MAX);
      pany = clamp(pany, -MAX, MAX);
      if (panx || pany) { host.ox -= panx; host.oy -= pany; host.clampView(); }
    }
    const ppx = host.screenToPixel(pt.x, pt.y);
    // pending pick: cancels only when the finger moves to another pixel cell
    if (wasDown && this.longT !== null && this.pickAnchor) {
      if (ppx.x !== this.pickAnchor[0] || ppx.y !== this.pickAnchor[1]) host.cancelPickTimer();
    }
    // pick mode: sample whatever cell the finger is over until release
    if (this.pickMode && wasDown && this.pointers.size === 1) {
      this.mag = host.session.prefs.loupe;
      this.magCenter = { x: ppx.x, y: ppx.y };
      host.samplePickCell(ppx.x, ppx.y, false);
      host.drawOverlay();
      return;
    }
    // four-finger gesture: once a contact ever reached 4 fingers it stays a
    // frame-preview gesture until every finger lifts — never pan/zoom. It
    // keeps watching while >=2 fingers stay down, so losing one finger
    // mid-gesture no longer aborts it. It arms as soon as at least TWO of the
    // fingers are sliding (each moved > FOUR_MOVE_PX from its own touchdown,
    // in ANY direction — no upward swipe required): the preview fires on the
    // last lift. Per-finger travel means fingers that land late or lift early
    // never weaken the detection.
    if (this.fourSeen && this.pointers.size >= 2) {
      if (fourFingerArmed(this.pointers, this.fourStart, host.session.prefs.fourFingerPx || FOUR_MOVE_PX_DEFAULT)) {
        this.fourArmed = true;
      }
      return;
    }
    // pinch
    if (this.pointers.size >= 2 && this.pinchBase) {
      const [a, b] = [...this.pointers.values()];
      // (a pending multi-finger long press was already cancelled in onMove)
      // 解算口径（中点是不动点、缩放夹取）都在 InputServer 里，见 servers/input.ts
      const r = pinchAround(this.pinchBase, pinchNow(a, b), host.session.prefs.zoomMin, host.session.prefs.zoomMax);
      host.ox = r.ox;
      host.oy = r.oy;
      host.zoom = r.zoom;
      if (r.zoomed) this.pinchZoomed = true;
      host.refresh(false);
      return;
    }
    // axis-adjust drag: translate the axis (grab the line) or rotate it (grab the knob)
    if (this.symTarget) {
      const doc = host.session.doc;
      const s = host.session;
      if (this.symTarget === "rot") {
        const cx = host.ox + (doc.w / 2 + s.symOx) * host.zoom;
        const cy = host.oy + (doc.h / 2 + s.symOy) * host.zoom;
        let deg = (Math.atan2(pt.y - cy, pt.x - cx) * 180) / Math.PI;
        deg = ((deg % 180) + 180) % 180; // lines are 180-periodic
        // snap to the nearest of 0/45/90/135
        let best = 0, bd = Infinity;
        for (const a of SYM_ANGLES) {
          const d2 = Math.abs(deg - a);
          if (d2 < bd) { bd = d2; best = a; }
        }
        s.symAng = best;
        s.symTweaked = true;
        s.rememberSym();
      } else {
        // the axis passes through the finger; clamp to the visible viewport
        // (so it follows into the margins) and snap to the half-cell grid so
        // it moves in whole pixels instead of drifting continuously
        const vx0 = Math.min(-host.ox, host.vpW() - host.ox) / host.zoom;
        const vx1 = Math.max(-host.ox, host.vpW() - host.ox) / host.zoom;
        const vy0 = Math.min(-host.oy, host.vpH() - host.oy) / host.zoom;
        const vy1 = Math.max(-host.oy, host.vpH() - host.oy) / host.zoom;
        const pxa = Math.round(clamp((pt.x - host.ox) / host.zoom, vx0, vx1) * 2) / 2;
        const pya = Math.round(clamp((pt.y - host.oy) / host.zoom, vy0, vy1) * 2) / 2;
        s.symOx = pxa - doc.w / 2;
        s.symOy = pya - doc.h / 2;
        s.symTweaked = true;
        s.rememberSym();
      }
      host.drawOverlay();
      return;
    }
    if (this.panLast) {
      host.ox += pt.x - this.panLast.x;
      host.oy += pt.y - this.panLast.y;
      host.clampView();
      this.panLast = pt;
      host.refresh(false);
      if (this.mousePan) { this.mousePan = false; this.panLast = null; host.syncCursor(); }
      return;
    }
    // 自由变换是常驻模式：没抓住控制点时指针移动什么都不做，
    // 绝不能落到下面的 xfMove（那是旋转 / 缩放，会把变形预览顶成缩放结果）
    if (this.xf && this.xf.mode === "warp") {
      if (this.xf.move) host.warpMoveContent(pt);
      else if (this.xf.drag !== undefined) host.warpMove(pt);
      return;
    }
    // 变换中：抓住抓手就拖；没抓住时在 PC 上发布悬停提示（点亮那个固定图标 + 外圈提示）
    if (host.inXform()) {
      if (this.xfDrag) { host.xfMove(pt); return; }
      if (isPc() && e.pointerType === "mouse") {
        const h = host.xfHitAt(pt);
        const next = h && h.kind !== "move" ? { kind: h.kind, anchor: h.anchor, x: pt.x, y: pt.y } : null;
        // 换了抓手（或换了锚点）才重画：同 kind 的不同锚点也要重画，否则高亮留在上一个图标上
        const same = (this.xfHover?.kind ?? null) === (next?.kind ?? null)
          && (this.xfHover?.anchor ?? null) === (next?.anchor ?? null);
        this.xfHover = next;
        if (!same) {
          this.xfHint = h ? h.kind + (h.anchor ? ":" + h.anchor : "") : null;
          host.drawOverlay();
        }
        return;
      }
      this.xfHint = null;
      return;
    }
    // PC 上没进会话时也发布一次悬停提示（点亮图标 / 外圈），但不要拦着下面的选区手势
    if (isPc() && e.pointerType === "mouse") {
      const h = host.xfHitAt(pt);
      this.xfHover = h && h.kind !== "move" ? { kind: h.kind, anchor: h.anchor, x: pt.x, y: pt.y } : null;
      this.xfHint = h ? h.kind + (h.anchor ? ":" + h.anchor : "") : null;
    }
    if (this.xf) {
      host.xfMove(pt);
      return;
    }
    if (this.path) {
      // rubber band from the last committed point to the finger
      if (wasDown && this.pointers.size === 1) {
        const p = this.path;
        if (!p.cur || p.cur[0] !== ppx.x || p.cur[1] !== ppx.y) {
          p.cur = [ppx.x, ppx.y];
          host.drawPathPreview();
        }
      }
      return;
    }
    if (this.stroke) {
      const pp = ppx;
      if (!this.gestureMoved && this.gestureStartPx && (pp.x !== this.gestureStartPx.x || pp.y !== this.gestureStartPx.y)) this.gestureMoved = true;
      // keep the erase/draw footprint marker glued to the finger while stroking;
      // it follows the pointer even past the image border (marks are clipped to
      // the canvas), so it never freezes at the edge while the hand keeps moving
      const inView = pt.x >= 0 && pt.y >= 0 && pt.x <= host.vpW() && pt.y <= host.vpH();
      this.cursor = inView ? { x: pp.x, y: pp.y, size: host.session.brushSize } : null;
      this.stroke.moveTo(pp.x, pp.y, e.pointerType === "pen" ? e.pressure : 1);
      // only the pixels this move touched need recompositing and repainting
      host.repaintStroke();
      return;
    }
    if (this.outline) {
      host.outlineMove(host.screenToPixel(pt.x, pt.y));
      return;
    }
    if (this.selDrag) {
      const pp = host.screenToPixel(pt.x, pt.y);
      host.selMove(pp);
      return;
    }
    // hover: footprint marker follows the pointer across the whole drawing
    // area too (marks still clip to the canvas); it hides only off the view or
    // while the axis-adjust mode is on (painting is suspended there)
    const drawing = ["pencil", "eraser", "bucket", "line", "rect", "ellipse", "circle", "polygon", "polyline", "curve"].includes(host.session.tool);
    const inView = pt.x >= 0 && pt.y >= 0 && pt.x <= host.vpW() && pt.y <= host.vpH();
    this.cursor = drawing && inView
      ? { x: ppx.x, y: ppx.y, size: host.session.brushSize }
      : null;
    if (e.pointerType === "mouse") host.syncCursor();
    // PC：把光标下的像素与颜色发布给状态栏读数（只在真正换像素时更新）
    if (isPc()) {
      const inside = ppx.x >= 0 && ppx.y >= 0 && ppx.x < host.session.doc.w && ppx.y < host.session.doc.h;
      const h = host.session.hover;
      if (!inside) {
        if (h) host.session.setHover(null);
      } else if (!h || h.x !== ppx.x || h.y !== ppx.y) {
        const c = host.session.sampleComposite(ppx.x, ppx.y);
        host.session.setHover({ x: ppx.x, y: ppx.y, color: c ? [c[0], c[1], c[2], c[3]] : null });
      }
    }
    host.drawOverlay();
  }

  onUp(e: PointerEvent): void {
    const host = this.host;   // 接触面（见 GestureHost）
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0) host.stopSpray();
    if (this.symTarget) {
      this.symTarget = null;
      host.session.changedUI(); // refresh the angle readout in the UI chips
      host.drawOverlay();
    }
    if (this.pointers.size < 2) this.pinchBase = null;
    if (this.hold && this.pointers.size < this.hold.n) host.cancelHold();
    if (this.pointers.size === 0 && this.isoDrag) {
      this.isoDrag = null;
      host.session.changedUI();   // 参数条上的读数刷新
      host.drawOverlay();
      return;
    }
    if (this.pointers.size === 0 && this.resizeDrag) {
      const g = this.resizeDrag;
      this.resizeDrag = null;
      if (g.moved) {
        // 一条历史：canvasSize 用「固定哪一侧」的锚点语义
        host.session.canvasSize(g.w, g.h, g.ax, g.ay);
        host.session.hapticTick("画布尺寸", 0.7);
      }
      host.session.repaintAll();
      return;
    }
    if (this.pointers.size === 0 && this.path) {
      // a tap added a point: drop the rubber band, keep the path pending
      this.path.cur = null;
      this.gestureMoved = false;
      host.drawPathPreview();
      return;
    }
    if (this.pointers.size === 0 && this.outline) {
      host.endOutline(true);
      return;
    }
    if (this.pointers.size === 0) {
      if (this.longT !== null) {
        window.clearTimeout(this.longT);
        this.longT = null;
      }
      this.pickMode = false;
      this.pickAnchor = null;
      this.pickLast = null;
      this.mag = false;
      this.magCenter = null;
      // 旋转 / 缩放 / 斜切 / 移动：松手只结束这次拖拽，会话继续开着
      // （一次会话一条 undo，靠「完成 / 还原 / 切工具」结束）。
      // 自由变换（四点 / 网格）是常驻模式：松手同样只结束这一次拖拽。
      if (this.xf && this.xf.mode === "warp") { this.xf.drag = undefined; this.xf.grab = undefined; this.warpDragOn = false; }
      else if (host.inXform()) host.xfEndDrag();
      else if (this.xf) host.endXf();
      const pt = host.evPt(e);
      const now = Date.now();
      // 抬手时先取走「这次手势的两指状态」与「双指长按是否已经触发过」：下面两个拦截分支
      // 都要据此吞掉这次抬手，而它们在结束前就会把状态清零。
      const firedTwoLong = this.holdFired;
      const pinchZoomed = this.pinchZoomed;
      this.pinchZoomed = false;
      this.holdFired = false;
      if (this.fourSeen) {
        // four-finger gesture: it opened the all-frames preview as soon as
        // four fingers were down with >=2 of them sliding; the preview opens
        // when the last finger lifts. Anything else is swallowed so it can
        // never redo/tap/paint.
        this.fourSeen = false;
        this.pinchBase = null;
        this.tap.clearTwoTapSeq();   // 四指手势绝不是双指轻点序列
        const armed = this.fourArmed;
        this.fourArmed = false;
        this.fourStart.clear();
        this.fourView0 = null;
        if (this.stroke) { this.stroke.cancel(); this.stroke = null; }
        if (this.selDrag) {
          if (this.selDrag.kind === "move" && this.selDrag.cut) host.endSelDrag(false);
          else this.selDrag = null;
        }
        this.panLast = null;
        this.gestureMoved = false;
        host.session.repaint();
        if (armed) {
          const fourAct = host.session.prefs.gFourFinger;
          host.session.hapticTick("四指"); // tactile confirmation before it fires
          if (fourAct === "framePreview" && host.onFramePreview) host.onFramePreview();
          else host.session.runGestureAction(fourAct, { x: pt.x, y: pt.y });
        }
        return;
      }
      if (firedTwoLong) {
        // the two-finger long press already ran its action while the fingers
        // were down: swallow the lifts so they can never count as a tap / redo
        this.tap.clearTwoTapSeq();
        this.panLast = null;
        this.gestureMoved = false;
        host.cancelHold();
        return;
      }
      // 这一次抬手算什么：**轻点序列状态机在 servers/gesture.ts**（单指连点的 480ms / 64px、
      // 双指双击的 80px、以及「双击边距 / 双击画布 / 三击」的优先级都在那儿，
      // 单测见 tests/gesture.test.ts）。这里只按它给出的结果执行副作用。
      const docW = host.session.doc.w, docH = host.session.doc.h;
      const inDoc = (p: Pt) => !outsideDoc(p, docW, docH);
      const ppc = host.screenToPixel(pt.x, pt.y);
      const mid = this.tap.twoMidPoint();
      const mpp = mid ? host.screenToPixel(mid.x, mid.y) : null;
      const out = this.tap.up({
        now, pt,
        overDoc: inDoc(ppc),
        canvasIndex: host.canvasAtScreen(pt.x, pt.y),
        docIndex: host.session.docIdx,
        moved: this.stroke ? this.gestureMoved : false,   // 拖动过就断掉连点串
        hasStroke: !!this.stroke, hasSelDrag: !!this.selDrag, hasXf: !!this.xf,
        pinchZoomed, isPc: isPc(),
        doubleTapMs: host.session.prefs.doubleTapMs,
        canvasDoubleMapped: host.session.prefs.gDoubleTapCanvas !== "none",
        midOverDoc: !!mpp && inDoc(mpp),
      });
      // 被手势吃掉的那一下：笔迹作废（绝不提交，免得留下一个孤点）
      const dropStroke = () => { if (this.stroke) { this.stroke.cancel(); this.stroke = null; } };
      switch (out.kind) {
        case "two-finger-redo":
          // the redo shortcut only fires outside the canvas: two-finger double
          // taps over the artwork must never redo (too easy to hit while drawing)
          this.gestureMoved = false;
          this.panLast = null;
          host.session.runGestureAction(host.session.prefs.gTwoFingerDoubleTap, { x: out.mid.x, y: out.mid.y });
          host.session.repaint();
          return;
        case "two-finger-skip":
        case "two-finger-first":
          this.gestureMoved = false;
          this.panLast = null;
          return;
        case "focus-canvas":
          // double-tap ON a canvas: focus it (when it is not the focused one) and
          // smoothly zoom it to fit
          dropStroke();
          if (this.selDrag) host.endSelDrag();
          this.panLast = null; this.gestureMoved = false;
          host.session.hapticTick("双击画布", 0.8);
          if (out.index !== host.session.docIdx) host.session.focusCanvas(out.index);
          host.session.fitCanvas();
          return;
        case "margin-double":
          // double-tap on the canvas margin -> whatever the user mapped
          dropStroke();
          if (this.selDrag) host.endSelDrag();
          this.panLast = null; this.gestureMoved = false;
          host.session.runGestureAction(host.session.prefs.gDoubleTapMargin, { x: pt.x, y: pt.y });
          host.session.repaint();
          return;
        case "canvas-double":
          // double-tap on the canvas itself（状态机只在「映射了动作」时报这个，
          // 没映射时第二下被吞掉，留给三击）
          dropStroke();
          this.panLast = null; this.gestureMoved = false;
          host.session.runGestureAction(host.session.prefs.gDoubleTapCanvas, { x: pt.x, y: pt.y });
          host.session.repaint();
          return;
        case "triple":
          // triple-tap on the doc -> zoom. Roll back the single swallowed tap
          // dot (if there was one) so zooming leaves no stray pixel — but never
          // undo anything the user painted before this gesture.
          dropStroke();
          if (this.selDrag) host.endSelDrag();
          this.panLast = null; this.gestureMoved = false;
          if (out.overDoc) {
            if (out.undoSingleDot && host.session.history.canUndo()) host.session.undo();
            host.session.repaint();
            host.session.runGestureAction(host.session.prefs.gTripleTap, { x: pt.x, y: pt.y });
          } else host.session.repaint();
          return;
        case "skip":
          // second tap over the doc: swallow it and wait for a possible third
          // tap (zoom). No undo here — undo belongs to the canvas margin only.
          dropStroke();
          this.gestureMoved = false; this.panLast = null;
          host.session.repaint();
          return;
        case "plain":
          // 没被手势接管：落到下面照常提交这一笔（单点）
          break;
      }
      if (this.stroke) {
        const doneStroke = this.stroke;
        const doneMoved = this.gestureMoved;
        const rec = this.stroke.commit(host.session.history, host.labelFor(this.stroke.kind));
        this.stroke = null;
        host.session.repaint();
        if (rec) host.session.changedUI();
        // shapes become an immediate selection of EXACTLY the pixels this stroke
        // painted (a pixel mask, not a rectangle) so only the shape moves;
        // neighbouring artwork that falls under the marquee stays untouched
        if (doneMoved && doneStroke.start && doneStroke.last && this.isShapeKind(doneStroke.kind)) {
          this.selectStrokePixels(doneStroke);
          host.session.setTool("select");
        }
        // 记下这一下单击「是不是没动过就落了一个点、且真的进了历史」——
        // 三击放大时要把那个孤点撤销掉（判定在 TapMachine 里）
        this.tap.noteSingleTap(!this.gestureMoved, !!rec);
      } else {
        this.tap.noteSingleTap(false, false);
      }
      this.gestureMoved = false;
      this.panLast = null;
      // a floating selection dropped on another canvas moves there (see
      // dropSelDragToCanvas); everything else drops in place
      if (this.selDrag && !host.dropSelDragToCanvas(pt.x, pt.y)) host.endSelDrag();
    }
  }

  /** true for the freehand shape tools that auto-select after drawing */
  private selectStrokePixels(st: Stroke): void {
    const host = this.host;   // 接触面（见 GestureHost）
    const doc = host.session.doc;
    const w = doc.w, h = doc.h;
    // the stroke may have been redirected into a referenced canvas: read the
    // cel it really painted into and map its pixels back into this canvas
    // (reference layers are mirrored 1:1, centred when the sizes differ)
    const cel = st.doc.celAt(st.li, st.fi);
    if (!cel) return;
    const sw = st.doc.w;
    const ox = st.doc === doc ? 0 : Math.round((w - sw) / 2);
    const oy = st.doc === doc ? 0 : Math.round((h - st.doc.h) / 2);
    const before = st.before ? st.before : new Uint8ClampedArray(cel.data.length);
    const d = cel.data;
    if (!doc.sel) doc.sel = new Sel(w, h);
    const sel = doc.sel;
    sel.clear();
    const n = Math.min(before.length, d.length);
    for (let i = 0; i < n; i += 4) {
      if (before[i] === d[i] && before[i + 1] === d[i + 1] && before[i + 2] === d[i + 2] && before[i + 3] === d[i + 3]) continue;
      const p = i >> 2;
      const x = (p % sw) + ox, y = Math.floor(p / sw) + oy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      sel.set(x, y, 1);
    }
    host.session.repaint();
    host.session.changedUI();
  }

  onCancel(e: PointerEvent): void {
    const host = this.host;   // 接触面（见 GestureHost）
    this.pointers.delete(e.pointerId);
    if (this.resizeDrag) { this.resizeDrag = null; host.drawOverlay(); }
    if (this.outline) host.endOutline(false);
    // a stationary two-finger hold cancelled by the OS usually means the phone
    // claimed the gesture for its own screen recognition: tell the user once
    if (this.hold && this.hold.n === 2 && this.pointers.size < 2) {
      host.session.hintOnce("twoFingerLongPress",
        "双指长按被系统的「识屏」抢走了：在系统设置里搜索「识屏」并关闭它，或改用三指长按",
        "The system's screen recognition grabbed the two-finger long press. Search for 'screen recognition' in the system settings and turn it off, or use the three-finger long press.");
    }
    host.cancelHold();
    host.stopSpray();
    this.holdFired = false;
    this.pinchZoomed = false;
    // 双指轻点序列作废（单指连点计数不动，与多指落下时同一口径）
    this.tap.clearTwoTapSeq();
    this.fourSeen = false;
    this.fourArmed = false;
    this.fourView0 = null;
    this.fourStart.clear();
    this.mag = false;
    this.magCenter = null;
    if (this.symTarget) this.symTarget = null;
    if (this.stroke) {
      if (this.gestureMoved) {
        const rec = this.stroke.commit(host.session.history, host.labelFor(this.stroke.kind));
        if (rec) host.session.changedUI();
      } else {
        this.stroke.cancel();
      }
      this.stroke = null;
      this.gestureMoved = false;
      host.session.repaint();
    }
    if (this.xf) host.abortXf();
    // a cancelled floating drag puts the cut pixels back untouched
    if (this.selDrag) {
      if (this.selDrag.kind === "move" && this.selDrag.cut) host.endSelDrag(false);
      else this.selDrag = null;
    }
    this.panLast = null;
    this.pinchBase = null;
    this.pickMode = false;
    this.pickAnchor = null;
    host.cancelPickTimer();
  }
}
