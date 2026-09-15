// Interactive viewport: composite drawing, pan/zoom gestures, tool strokes.
import type { Doc } from "../engine/doc";
import type { RGBA, Rect} from "../engine/types";
import { tileOffsets, type TileMode } from "./rect";
import { Cel } from "../engine/cel";
import * as comp from "./compositor";
import { Stroke } from "../tools/stroke";
import { isSymTool, type ToolId } from "../tools/registry";
import type { SymAxis } from "../engine/symmetry";
import { lineCells, brushStamp, fillPolygon } from "../engine/paint";
import { selOps, lassoFill, beginMove, xformAffineFloating, xformAffineDestBox, warpFloating, floatQuad, floatGrid, floatDropInto, type MoveState } from "../tools/select";
import {
  affineFrom, applyAffine, axisOf, boxCenter, clampScale, clampTan, contentBox, distToFrame, exactMove, grabAt,
  insideFrame, isExactTransform, isIntegerShift, linearOf, normAngle, pivotPresetAt, pivotPresetPoint,
  scaleAnchor, screenAnchors, screenFrameOf, snapCleanAngle, solveRotate, solveScale, solveSkew,
  skewBaseline, skewPivotOf, toFrameLocal, anchorPoint, rightAngleSteps, ringHitAt, transformGrabs, grabOffsets, touchHitRadius,
  edgeNormalOf, XF_LABEL, XF_LABEL_ORDER, PIVOT_PRESETS, ANCHORS,
  PC_HIT, TOUCH_HIT, type AnchorId, type ScreenFrame, type XfBox,
  type XfKind, type XfParams, type PivotPreset, type Grab, type GrabOffsets, type HitRadii,
} from "../tools/xform";
import type { Mat3 } from "../tools/warp";
import { isoDeltaToCells, isoGroundCorners, isoHeightHandle, isoRender, isoShapeVoxels } from "../engine/iso";
import type { Session } from "../app/session";
import type { GestureActionId } from "../app/gesture-ids";
import type { Pt } from "../tools/warp";
import { warpCoordLabel, warpPointFromScreen, warpPointRaw } from "../tools/warp";
import { clamp } from "../engine/types";
import { LEGACY_TITLE_EXTRA, TITLE_EXTRA, snapGapRect, type GapRect } from "../app/canvas-snap";
import { canvasAtScreen as spaceCanvasAt, screenToCanvas } from "../app/canvas-space";
import { wheelIntent } from "./wheel";
import { takeNotches, wheelNotches } from "../engine/scrub";
import { cursorAttr, cursorFor } from "./cursor";
import { isPc } from "../io/pcmode";
import * as Vp from "../servers/viewport";
import { RenderServer, onionKeyOf, onionSpecOf, type RenderReason } from "../servers/render";
import { FOUR_MOVE_PX_DEFAULT } from "../servers/input";
import { GestureController, type GestureHost, type XfSession } from "../servers/gesture";
import { hexToRgba } from "../engine/color";

interface PxPoint {
  x: number;
  y: number;
}

/**
 * 把浮动像素**叠**到图层上（source-over），「复制」模式落笔时用：
 * 图层没有被挖空，所以副本要叠在原件上面，而不是整块覆盖。
 * 与引擎里的 `blendOver()` 同一套公式，这里就地做是为了少拷一份中间数组。
 */
function blendInto(dst: Uint8ClampedArray, o: number, src: Uint8ClampedArray, so: number): void {
  const a = src[so + 3];
  if (a === 0) return;
  if (a === 255) {
    dst[o] = src[so]; dst[o + 1] = src[so + 1]; dst[o + 2] = src[so + 2]; dst[o + 3] = 255;
    return;
  }
  const da = dst[o + 3];
  const sa = a / 255;
  const outA = sa + (da / 255) * (1 - sa);
  if (outA <= 0) { dst[o] = dst[o + 1] = dst[o + 2] = dst[o + 3] = 0; return; }
  for (let k = 0; k < 3; k++) {
    dst[o + k] = Math.round((src[so + k] * sa + dst[o + k] * (da / 255) * (1 - sa)) / outA);
  }
  dst[o + 3] = Math.round(outA * 255);
}

/** 枢轴 9 档的行主序（`src/tools/xform.ts` 的 `PIVOT_PRESETS` 的镜像，
 *  导出给 React 层用 —— App.tsx 不必 import 引擎模块就能循环这 9 档）。 */
export const PIVOT_ORDER = ["tl", "tc", "tr", "cl", "cc", "cr", "bl", "bc", "br"] as const;

/**
 * 会话里「枢轴的 9 档预设」用的框 ＝ **内容外框**（`contentBox()`）。
 *
 * 外框口径（见 `xform.ts` 文件头）：`0..cw` / `0..ch`，屏幕上 `0` 就是选中框的左上角、
 * `cw` 是右下角 —— 于是「枢轴预设的左上」＝「框的左上」＝「角抓手的位置」，
 * 与命中判定 / 抓手绘制用的是同一套坐标（不会有半格偏差）。
 */
function pivotBoxOf(g: NonNullable<XfSession>): XfBox {
  return contentBox(g.st.content.w, g.st.content.h);
}

/** 一组控制点的下标包围盒（`warpStartMove()` 判「按在内容上」用） */
function warpBounds(pts: Pt[]): { x0: number; y0: number; x1: number; y1: number } | null {
  if (!pts.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1 };
}

/** 按下那一刻的变换参数快照（拖动解算的**累加基准**，见 `View.xfDrag.tp0`） */
function tp0Of(tp: XfParams | undefined): { sx: number; sy: number; angle: number; skewX: number; skewY: number } {
  return {
    sx: tp?.sx ?? 1, sy: tp?.sy ?? 1, angle: tp?.angle ?? 0,
    skewX: tp?.skewX ?? 0, skewY: tp?.skewY ?? 0,
  };
}

// 选区变换框上「固定图标抓手」的配色：与同文件选区框 / 手柄的现有画法同一套
// （白底深边＝缩放，蓝＝旋转，橙＝斜切，暖黄＝悬停高亮），不引入新色板。
const XF_ICON_FILL = "#ffffff";
const XF_ICON_EDGE = "#20242f";
const XF_ICON_ROT = "#aed1ff";
const XF_ICON_ROT_EDGE = "#1b2a44";
const XF_ICON_ROT_INK = "#14202e";
const XF_ICON_SKEW = "#ffd8a8";
const XF_ICON_SKEW_EDGE = "#3a2a12";
const XF_ICON_HOT = "#ffd166";

/** 缩放抓手：角＝方块、边中点＝沿边方向的扁矩形（中心都贴在选区框上） */
const XF_SQ = 12;          // 角方块边长
const XF_FLAT_L = 18;      // 边中点扁矩形的长（沿边）
const XF_FLAT_W = 8;       // 边中点扁矩形的宽（沿法线）
/** 旋转 / 斜切图标的外接半径（画出来约 22px，比两者 24px 的圆心距略小，肉眼分得开） */
const XF_ROT_R = 11;

/**
 * 画一个抓手图标（两平台同一套固定图标，靠**形状**区分语义）：
 *   · 缩放＝方块 / 扁矩形（白底深边）；
 *   · 旋转＝圆形箭头（蓝底 + 深色箭头）；
 *   · 斜切＝双向斜线（橙，带深色描边当底衬，任何底色上都看得清）。
 * `hot` 为真时把该抓手点亮成暖黄（PC 悬停提示用）。
 */
function drawXfGrab(ctx: CanvasRenderingContext2D, g: Grab, tangent: { x: number; y: number },
  normal: { x: number; y: number }, hot: boolean): void {
  ctx.save();
  if (g.kind === "scale") {
    ctx.fillStyle = hot ? XF_ICON_HOT : XF_ICON_FILL;
    ctx.strokeStyle = XF_ICON_EDGE;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    if (g.anchor === "tl" || g.anchor === "tr" || g.anchor === "br" || g.anchor === "bl") {
      // 角：方块
      ctx.rect(g.x - XF_SQ / 2, g.y - XF_SQ / 2, XF_SQ, XF_SQ);
    } else {
      // 边中点：扁矩形，长边顺着那条边（框转过角度 / 斜切也照样贴着边）
      ctx.translate(g.x, g.y);
      ctx.rotate(Math.atan2(tangent.y, tangent.x));
      ctx.rect(-XF_FLAT_L / 2, -XF_FLAT_W / 2, XF_FLAT_L, XF_FLAT_W);
    }
    ctx.fill();
    ctx.stroke();
  } else if (g.kind === "rotate") {
    // 底盘 + 圆形箭头
    ctx.beginPath();
    ctx.fillStyle = hot ? XF_ICON_HOT : XF_ICON_ROT;
    ctx.strokeStyle = XF_ICON_ROT_EDGE;
    ctx.lineWidth = 1.4;
    ctx.arc(g.x, g.y, XF_ROT_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    const r = XF_ROT_R * 0.56;
    const a0 = -Math.PI * 0.35, a1 = Math.PI * 1.15;
    ctx.strokeStyle = XF_ICON_ROT_INK;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(g.x, g.y, r, a0, a1);
    ctx.stroke();
    // 箭尾的小三角（缺了它只是一个圆弧，看不出方向）
    const tip = { x: g.x + Math.cos(a1) * r, y: g.y + Math.sin(a1) * r };
    const tx = -Math.sin(a1), ty = Math.cos(a1);
    const nx = Math.cos(a1), ny = Math.sin(a1);
    ctx.fillStyle = XF_ICON_ROT_INK;
    ctx.beginPath();
    ctx.moveTo(tip.x + tx * 4.4, tip.y + ty * 4.4);
    ctx.lineTo(tip.x + nx * 3.2, tip.y + ny * 3.2);
    ctx.lineTo(tip.x - nx * 3.2, tip.y - ny * 3.2);
    ctx.closePath();
    ctx.fill();
  } else {
    // 斜切：双向斜线（两条平行斜杠，方向＝边方向稍微偏法线，读起来就是「沿边推」）
    const sx = tangent.x + normal.x * 0.55, sy = tangent.y + normal.y * 0.55;
    const sl = Math.hypot(sx, sy) || 1;
    const ux = sx / sl, uy = sy / sl;        // 斜杠方向
    const px = -uy, py = ux;                 // 两条斜杠之间的错开方向
    ctx.lineCap = "round";
    for (const pass of [0, 1]) {
      ctx.strokeStyle = pass === 0 ? XF_ICON_SKEW_EDGE : (hot ? XF_ICON_HOT : XF_ICON_SKEW);
      ctx.lineWidth = pass === 0 ? 4.4 : 2.2;
      ctx.beginPath();
      for (const sgn of [1, -1]) {
        const cx = g.x + px * 4.2 * sgn, cy = g.y + py * 4.2 * sgn;
        ctx.moveTo(cx - ux * 6, cy - uy * 6);
        ctx.lineTo(cx + ux * 6, cy + uy * 6);
      }
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** 边中点抓手的**边方向**（单位向量）：法线顺时针转 90°，与 `xform.ts` 的 `edgeNormalOf()` 互逆 */
function grabTangent(normal: { x: number; y: number }): { x: number; y: number } {
  const l = Math.hypot(normal.x, normal.y) || 1;
  return { x: -normal.y / l, y: normal.x / l };
}

/** lock / unlock glyphs, matching the app's i-lock / i-unlock SVG symbols (24x24) */
const LOCK_D = "M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z";
const UNLOCK_D = "M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h2c0-1.66 1.34-3 3-3s3 1.34 3 3v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10z";

/** a finger must travel this far (screen px, any direction) from its own
 *  touchdown before it counts as "sliding"; two such fingers while >=4 are
 *  down = the all-frames preview gesture. Big enough to ignore the jitter of
 *  four fingers settling, small enough that any deliberate slide arms it. */
/** fallback when a caller has no session yet (never used in the app) */
// 四指划动阈值默认值搬到了 servers/input.ts（FOUR_MOVE_PX_DEFAULT），这里只 import
/** layer-switch flash duration in ms */
const FLASH_MS = 420;
/** 临时工具笔画用的合成 pointerId（与真实手指的 id 区分开） */
const TEMP_POINTER_ID = 9001;
/** how far the gap tint tolerates an off-canonical gap: pairs snapped by an
 *  older build keep the wider stacked gap (LEGACY_TITLE_EXTRA 20 vs 10) and
 *  must still light up as snapped */
const LEGACY_TOL = LEGACY_TITLE_EXTRA - TITLE_EXTRA + 2;
/** Selection scale follows Aseprite's transform: free (non-integer) scale
 *  factor, anchored at the handle opposite the one being dragged, rasterised
 *  via affine inverse mapping with trunkating nearest-neighbour sampling. */

export class View implements GestureHost {
  host: HTMLElement;
  private pix: HTMLCanvasElement;
  private ov: HTMLCanvasElement;
  session: Session;
  private ro: ResizeObserver | null = null;
  private dpr = 1;

  zoom = 8;
  ox = 0;
  oy = 0;
  /** view rotation in degrees clockwise: 0 / 90 / 180 / 270. Everything inside
   *  the view keeps working in "logical" (unrotated) screen coordinates; the
   *  canvas transform rotates on the way out and pointer events rotate back. */
  rot: 0 | 90 | 180 | 270 = 0;

  /** logical viewport width (swaps with the height when rotated by 90/270) */
  vpW(): number {
    return this.rot % 180 ? this.host.clientHeight : this.host.clientWidth;
  }
  vpH(): number {
    return this.rot % 180 ? this.host.clientWidth : this.host.clientHeight;
  }
  /** canvas transform: logical viewport rect -> the real (surface) canvas */
  private applyTransform(ctx: CanvasRenderingContext2D): void {
    const m = Vp.rotationMatrix(this.rot, this.dpr, this.host.clientWidth, this.host.clientHeight);
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  }
  /** surface (pointer / DOM) point -> logical point */
  toLogical(x: number, y: number): { x: number; y: number } {
    return Vp.toLogical(this.rot, this.host.clientWidth, this.host.clientHeight, x, y);
  }
  /** logical point -> surface point (DOM overlays sit in surface space) */
  toSurface(x: number, y: number): { x: number; y: number } {
    return Vp.toSurface(this.rot, this.host.clientWidth, this.host.clientHeight, x, y);
  }
  /** a surface drag delta expressed in space units (rotation aware) */
  surfaceDelta(dx: number, dy: number): { x: number; y: number } {
    return Vp.surfaceDelta(this.rot, this.zoom, dx, dy);
  }
  /** rotate the view by `deg` (any multiple of 90) and redraw everything */
  setRotation(deg: number): void {
    const n = (((Math.round(deg / 90) * 90) % 360) + 360) % 360;
    const r = (n === 90 || n === 180 || n === 270 ? n : 0) as 0 | 90 | 180 | 270;
    if (r === this.rot) return;
    this.rot = r;
    this.clampView();
    this.blitFull = true;
    this.refresh(true);
    this.drawOverlay(true);
  }

  /** 合成缓冲、合成键、失效区域、多画布缓存、棋盘格 —— 全部所有权在 RenderServer
   *  （见 docs/ARCHITECTURE.md §3.3）；视图层只负责 blit 与覆盖层绘制 */
  private render = new RenderServer();
  /** the whole pix canvas has to be redrawn (view transform / viewport change) */
  private blitFull = true;
  /** pending animation frame of a coalesced repaint */
  private raf = 0;
  /** identity + version of the selection the cached tint image belongs to */
  private selTintSel: unknown = null;
  private selTintVer = -1;
  /** view transform of the last blit (a change forces a full redraw) */
  private lastView = { ox: NaN, oy: NaN, zoom: NaN, w: 0, h: 0 };
  /** first layout handled: later resizes (orientation/panels) preserve pan+zoom */
  private firstFit = false;
  private isoCache: HTMLCanvasElement | null = null;
  private isoKey = "";
  private ants = 0;
  /** running view animation (fit / double-tap zoom) */
  private anim = 0;
  private antTimer: number | null = null;
  /** cached selection tint layer (rebuilt only when the doc changes) */
  private selTint: HTMLCanvasElement | null = null;
  /** every snap zone satisfied right now (steady green), keyed by "a:b" */
  private snapZones = new Map<string, { a: number; b: number; rect: GapRect }>();
  /** one-shot flashes when a zone appears ("in") or is left ("out"); the rect is
   *  SNAPSHOTTED, because a left zone no longer exists to measure */
  private snapFlashes: Array<{ rect: GapRect; t0: number; kind: "in" | "out" }> = [];
  private snapRaf = 0;
  /** red dissolving links of just-released snaps (pairs of canvas indices) */
  private unsnapPulse: { pairs: Array<[number, number]>; t0: number } | null = null;
  private unsnapRaf = 0;
  /** tints of the SELECTIONS of referenced canvases, keyed by layer id */
  private refSelTint = new Map<string, { sel: unknown; ver: number; cv: HTMLCanvasElement }>();
  private selTintBounds: { x: number; y: number; w: number; h: number } | null = null;
  /** read one composited pixel cheaply from the cached composite (no recompose) */
  samplePixel(x: number, y: number): [number, number, number, number] | null {
    const c = this.render.canvas;
    if (!c) return null;
    if (x < 0 || y < 0 || x >= c.width || y >= c.height) return null;
    try {
      const d = c.getContext("2d")!.getImageData(x, y, 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    } catch {
      return null;
    }
  }

  /** PC：Shift＝等比缩放 / 干净角吸附；Ctrl＝拖动＝复制（触屏用选区球里的 sticky 开关） */
  private shiftDown = false;
  private ctrlDown = false;
  /** Ctrl+滚轮改笔刷大小的滚轮累计（一格 = 一步） */
  private wheelBrushAcc = 0;
  /** 浮动选区内容的离屏缓存（拖动时一次 drawImage 代替逐像素 fillRect） */
  private floatCv: HTMLCanvasElement | null = null;
  private floatKey = "";
  /** airbrush: interval that keeps spraying while the finger is held down */
  private sprayT: number | null = null;
  /** fractional specks owed to the next spray tick */
  private sprayAcc = 0;
  /** layer-switch flash: layer index + start time, drawn in the overlay */
  private flash: { li: number; t0: number } | null = null;
  private flashRaf = 0;
  /** 预览离屏画布的缓存（键 = 参数签名） */
  private isoPrevCv: HTMLCanvasElement | null = null;
  private isoPrevKey = "";
  /** 上一次「按在枢轴上」的时间与位置：双击枢轴＝把它复位到内容正中 */
  private pivotTapT = 0;
  private pivotTapPt: PxPoint | null = null;
  /** invoked after a clean four-finger gesture (wired up by the app shell) */
  onFramePreview: (() => void) | null = null;
  /** invoked whenever the view transform changed (canvas title bars follow it) */
  onViewChanged: (() => void) | null = null;
  /** 上一次 `beginWarp` 被拒的原因（UI 据此给不同提示；"locked" 已由 paintBlockedNote 说过） */
  lastWarpError: "noSel" | "tooThin" | "locked" | null = null;

  constructor(host: HTMLElement, session: Session) {
    this.host = host;
    this.session = session;
    this.pix = document.createElement("canvas");
    this.ov = document.createElement("canvas");
    this.pix.style.position = "absolute";
    this.ov.style.position = "absolute";
    this.pix.style.left = "0";
    this.pix.style.top = "0";
    this.ov.style.left = "0";
    this.ov.style.top = "0";
    this.pix.style.imageRendering = "pixelated";
    host.appendChild(this.pix);
    host.appendChild(this.ov);
    this.dpr = Math.min(2.5, window.devicePixelRatio || 1);
    this.gesture.xf = null;              // 显式初始化（可选字段声明只给类型、不给默认值）
    this.gesture.xfDrag = null;
    this.bind();
  }

  destroy(): void {
    this.endPath(true); // never lose a half-finished polyline
    this.ro?.disconnect();
    this.stopAnts();
    this.stopSpray();
    if (this.anim) window.cancelAnimationFrame(this.anim);
    this.anim = 0;
    if (this.raf) window.cancelAnimationFrame(this.raf);
    this.raf = 0;
    window.removeEventListener("keydown", this.onSpaceKey);
    window.removeEventListener("keyup", this.onSpaceKey);
    this.host.replaceChildren();
  }

  /** 滚轮：缩放（以光标为锚点）/ Shift 横向 / Alt 纵向；只在 PC 模式生效 */
  private onWheel(e: WheelEvent): void {
    if (!isPc() || this.gesture.pointers.size > 0) return;
    if (this.session.uiEdit) return;   // 编辑界面时不缩放画布
    e.preventDefault();
    const r = this.host.getBoundingClientRect();
    const pt = this.toLogical(e.clientX - r.left, e.clientY - r.top);
    // Ctrl+滚轮＝快速改笔刷大小（按「格」累计，一格一步，跟调值那套一致）
    if (e.ctrlKey || e.metaKey) {
      const { steps, rest } = takeNotches(this.wheelBrushAcc + wheelNotches(e.deltaY, e.deltaMode));
      this.wheelBrushAcc = rest;
      if (steps) {
        // setBrushSize 自己夹在 1..64
        const next = this.session.brushSize - steps;
        if (next !== this.session.brushSize) {
          this.session.setBrushSize(next);
          this.session.hapticTick("笔刷", 0.4);
          this.drawOverlay();
        }
      }
      return;
    }
    const it = wheelIntent(e);
    if (it.kind === "pan") this.panBy(it.dx, it.dy);
    else this.zoomAt(this.zoom * it.factor, pt.x, pt.y);
  }

  /** 平移视图（滚轮 / 画布外拖动 / 方向键共用） */
  panBy(dx: number, dy: number): void {
    const v = Vp.panBy({ zoom: this.zoom, ox: this.ox, oy: this.oy }, dx, dy);
    this.ox = v.ox;
    this.oy = v.oy;
    this.clampView();
    this.refresh(false);
  }

  /** 统一同步鼠标光标（工具 / 锁定 / 平移 / 取色） */
  syncCursor(): void {
    const host = this.host as HTMLElement;
    const id = cursorFor({
      tool: this.session.tool,
      locked: this.session.layerLocked(),
      panning: this.gesture.mousePan,
      altPick: this.gesture.altDown,
      picking: this.gesture.pickMode,
    });
    // 测试环境里的 host 是精简桩，dataset / style 可能不存在
    const ds = (host as unknown as { dataset?: Record<string, string> }).dataset;
    if (ds) ds.cursor = cursorAttr(id);
    if (host.style) host.style.cursor = "";   // 交给 CSS 规则（data-cursor）
  }

  /**
   * PC 修饰键：空格按住＝临时用另一个色槽（默认背景色）绘制；Alt 按住＝下一次
   * 单击取色（光标换成吸管）。平移不再占用空格：画布外左键拖动或方向键即可。
   */
  private onSpaceKey = (e: KeyboardEvent): void => {
    if (!isPc()) return;
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    const down = e.type === "keydown";
    if (e.key === "Alt" || e.code === "AltLeft" || e.code === "AltRight") {
      if (this.gesture.altDown === down) return;
      this.gesture.altDown = down;
      if (down) e.preventDefault();              // 别让浏览器把焦点抢到菜单栏
      if (this.gesture.pointers.size === 0) this.syncCursor();
      return;
    }
    // Shift：等比缩放 / 干净角吸附（触屏上是选区球里的 sticky 开关）；Ctrl：拖动＝复制
    if (e.key === "Shift" || e.code === "ShiftLeft" || e.code === "ShiftRight") {
      this.shiftDown = down;
      return;
    }
    if (e.key === "Control" || e.code === "ControlLeft" || e.code === "ControlRight") {
      this.ctrlDown = down;
      return;
    }
    if (e.code !== "Space" && e.key !== " ") return;
    if (typing) return;
    if (down && t && t.tagName === "BUTTON") return;   // 空格仍然激活聚焦的按钮
    if (this.gesture.spaceDown === down) return;
    this.gesture.spaceDown = down;
    if (down) e.preventDefault();
  };

  // ---------------------------------------------------------------- sizing
  resize(): void {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (w <= 0 || h <= 0) return;
    for (const c of [this.pix, this.ov]) {
      c.style.width = w + "px";
      c.style.height = h + "px";
      c.width = Math.round(w * this.dpr);
      c.height = Math.round(h * this.dpr);
    }
    // keep the user's pan/zoom across orientation / panel changes; only the
    // very first layout fits the canvas to the viewport
    if (!this.firstFit) { this.fit(); this.firstFit = true; }
    this.clampView();
    this.refresh(true);
  }

  setDoc(doc: Doc): void {
    void doc;
    this.render.resetDoc();
  }
  setFrame(fi: number): void {
    void fi;
    this.render.resetFrame();
  }

  /** animate the view to a new transform (fit / double-tap a canvas title) */
  animateTo(z1: number, ox1: number, oy1: number, ms = 220): void {
    if (this.anim) window.cancelAnimationFrame(this.anim);
    const z0 = this.zoom, ox0 = this.ox, oy0 = this.oy;
    const t0 = performance.now();
    const step = (now: number): void => {
      const k = Math.min(1, (now - t0) / Math.max(1, ms));
      const e = 1 - Math.pow(1 - k, 3); // ease-out cubic
      this.zoom = z0 + (z1 - z0) * e;
      this.ox = ox0 + (ox1 - ox0) * e;
      this.oy = oy0 + (oy1 - oy0) * e;
      this.clampView();
      this.refresh(false);
      if (k < 1) this.anim = window.requestAnimationFrame(step);
      else { this.anim = 0; this.zoom = z1; this.ox = ox1; this.oy = oy1; this.clampView(); this.refresh(false); }
    };
    this.anim = window.requestAnimationFrame(step);
  }

  /** the transform that fits the focused canvas into the viewport */
  fitTarget(): { zoom: number; ox: number; oy: number } {
    const s = this.session;
    return Vp.fitTarget(s.doc.w, s.doc.h, this.vpW(), this.vpH(), s.prefs.zoomMin, s.prefs.zoomMax);
  }

  /** smooth zoom-to-fit of the focused canvas (double-tap a title) */
  fitAnimated(ms = 220): void {
    const t = this.fitTarget();
    this.animateTo(t.zoom, t.ox, t.oy, ms);
  }

  /** keep the space visually still when the focused canvas changes: the new
   *  focused document must stay exactly where it already is on screen */
  shiftFocus(dxSpace: number, dySpace: number): void {
    this.ox += dxSpace * this.zoom;
    this.oy += dySpace * this.zoom;
    this.clampView();
    this.refresh(false);
  }

  fit(): void {
    const t = this.fitTarget();
    this.zoom = t.zoom;
    this.ox = t.ox;
    this.oy = t.oy;
  }

  /** Keep the canvas in view: stop panning when a canvas edge reaches the
   *  viewport edge, so the artwork can never be dragged off-screen. */
  clampView(): void {
    const s = this.session;
    const w = this.vpW(), h = this.vpH();
    const v = { zoom: this.zoom, ox: this.ox, oy: this.oy };
    if (s.docs.length > 1) {
      // infinite space: keep a slice of the canvas bounding box on screen so
      // the artwork can never be panned away forever
      const focus = s.docs[s.docIdx];
      const box = { x: focus.x, y: focus.y, w: focus.doc.w, h: focus.doc.h };
      const list = s.docs.map((e) => ({ x: e.x, y: e.y, w: e.doc.w, h: e.doc.h }));
      const c = Vp.clampSpace(v, box, list, w, h);
      this.ox = c.ox;
      this.oy = c.oy;
      return;
    }
    const c = Vp.clampSingle(v, s.doc.w, s.doc.h, w, h);
    this.ox = c.ox;
    this.oy = c.oy;
  }

  zoomAt(z: number, cx?: number, cy?: number): void {
    const s = this.session;
    const vpW = this.vpW(), vpH = this.vpH();
    const mx = cx === undefined ? vpW / 2 : cx;
    const my = cy === undefined ? vpH / 2 : cy;
    const v = Vp.zoomAtPoint({ zoom: this.zoom, ox: this.ox, oy: this.oy }, z, mx, my, s.prefs.zoomMin, s.prefs.zoomMax);
    this.zoom = v.zoom;
    this.ox = v.ox;
    this.oy = v.oy;
    this.clampView();
    this.refresh(false);
  }

  screenToPixel(sx: number, sy: number): { x: number; y: number } {
    return Vp.screenToPixel({ zoom: this.zoom, ox: this.ox, oy: this.oy }, sx, sy);
  }

  /** the canvases as plain rects (pure hit testing lives in app/canvas-space) */
  private spaceRects(): Array<{ x: number; y: number; w: number; h: number }> {
    return this.session.docs.map((e) => ({ x: e.x, y: e.y, w: e.doc.w, h: e.doc.h }));
  }

  /** index of the canvas under a screen point (-1 = empty space). The focused
   *  document's coordinates are the view anchor, so its rect is 0,0..w,h. */
  canvasAtScreen(sx: number, sy: number): number {
    return spaceCanvasAt(this.spaceRects(), this.session.docIdx, this.ox, this.oy, this.zoom, sx, sy);
  }

  /**
   * One-shot bucket fill at a screen point — the palette fan's drag & drop.
   *
   * Runs the same tool wiring as a real tap (redirect through reference layers,
   * selection mask, tolerance / gap closing, indexed colours, tiled wrap) but as
   * a single down+commit, so it lands as one history step. Focuses the canvas
   * under the point first when it is not the focused one. `clientX`/`clientY`
   * are viewport coordinates (what pointer events carry).
   *
   * @returns the index of the canvas that was filled, or -1 (empty space /
   *          locked layer / no canvas)
   */
  quickFill(clientX: number, clientY: number, color: RGBA): number {
    const s = this.session;
    // the same conversion the pointer path uses: client -> element -> logical
    const r = this.host.getBoundingClientRect();
    const pt = this.toLogical(clientX - r.left, clientY - r.top);
    const hit = screenToCanvas(this.spaceRects(), s.docIdx, this.ox, this.oy, this.zoom, pt.x, pt.y);
    if (!hit) return -1;
    if (hit.index !== s.docIdx) s.focusCanvas(hit.index);
    const e = s.docs[hit.index];
    if (!e) return -1;
    if (s.layerLocked()) { s.paintBlockedNote(); return -1; }
    const tgt = s.strokeTarget(s.curLayer());
    let st: Stroke;
    try {
      st = new Stroke(tgt ? tgt.doc : e.doc, tgt ? tgt.li : s.curLayer(), tgt ? tgt.fi : s.curFrame(),
        "bucket", { ...s.brush(), color }, s.layerLocked(), s.sym, s.shapeSides, s.shapeFill,
        s.symOx, s.symOy, s.symAng, s.symFour, s.prefs.bucketGlobal, s.brushShape, s.shapeFromCenter);
    } catch {
      s.paintBlockedNote();
      return -1;
    }
    this.wireRedirect(st, tgt);
    st.fillTolerance = s.prefs.fillSimilar ? s.prefs.fillTolerance : 0;
    st.fillGaps = s.prefs.fillGaps;
    st.snapColor = (c) => s.paletteSnap(c);
    const tm = s.prefs.tileMode;
    st.wrapX = tm === "row" || tm === "grid";
    st.wrapY = tm === "col" || tm === "grid";
    st.startAt(hit.x, hit.y);
    const rec = st.commit(s.history, this.labelFor("bucket"));
    s.repaint();
    if (rec) s.changedUI();
    return hit.index;
  }

  // ---------- 临时工具笔画（把工具球里的子项拖到画布上直接用） ----------
  /** 拖「橡皮小项」出去时临时顶替当前工具：只影响这一次笔画，不改 SESSION.tool，
   *  因此工具球上的高亮与之后画的东西都不变。 */
  private tempTool: ToolId | null = null;
  /** 当前这次笔画应该用哪个工具（临时工具优先） */
  toolNow(): ToolId {
    return this.tempTool ?? this.session.tool;
  }
  /** 把合成的指针事件交给画布自己的处理链：笔画/脏矩形/历史/震动全部复用 */
  private dispatchPointer(type: string, clientX: number, clientY: number): void {
    const host = this.host as unknown as { dispatchEvent?: (e: Event) => boolean };
    if (!host || typeof host.dispatchEvent !== "function") return;
    const Ctor = (globalThis as { PointerEvent?: typeof PointerEvent }).PointerEvent
      ?? (globalThis as { MouseEvent?: typeof MouseEvent }).MouseEvent;
    if (!Ctor) return;                 // 无 DOM 事件构造器（node 测试）：安全跳过
    const init: PointerEventInit = {
      pointerId: TEMP_POINTER_ID,
      pointerType: "touch",
      isPrimary: true,
      clientX, clientY,
      bubbles: true, cancelable: true,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
    };
    host.dispatchEvent(new Ctor(type, init as MouseEventInit));
  }
  /** 开始一次临时工具笔画（如拖动橡皮小项） */
  beginTempStroke(tool: ToolId, clientX: number, clientY: number): boolean {
    if (!this.host || this.tempTool) return false;
    this.tempTool = tool;
    this.dispatchPointer("pointerdown", clientX, clientY);
    if (!this.gesture.stroke) {         // 没画出笔画（画布外 / 图层锁定）：干脆别接管
      this.tempTool = null;
      return false;
    }
    return true;
  }
  /** 临时笔画的移动（跟手擦除/绘制） */
  moveTempStroke(clientX: number, clientY: number): void {
    if (!this.tempTool) return;
    this.dispatchPointer("pointermove", clientX, clientY);
  }
  /** 结束临时笔画：落下一条历史步，并**不改**当前工具 */
  endTempStroke(): void {
    if (!this.tempTool) return;
    this.dispatchPointer("pointerup", this.gesture.lastPt.x, this.gesture.lastPt.y);
    this.tempTool = null;
  }

  // ---------------------------------------------------------------- render
  /** Mark the composite stale. `rect` (doc space) limits the work to the region
   *  a live stroke touched; omit it for a full rebuild + full redraw. */
  markDirty(rect?: Rect | null): void {
    // 整幅失效同时意味着"整个 pix 画布要重画"（视图变换 / 尺寸变化由调用方另置）
    if (!rect) this.blitFull = true;
    this.render.invalidate(rect);
  }

  /** Coalesce paints into one per animation frame: a stroke fires dozens of
   *  pointermove events per second and each one used to repaint immediately. */
  invalidate(rect?: Rect | null): void {
    this.markDirty(rect ?? null);
    if (this.raf) return;
    this.raf = window.requestAnimationFrame(() => {
      this.raf = 0;
      this.refresh(false);
    });
  }

  /** repaint after a live stroke: a stroke redirected onto a referenced canvas
   *  changes pixels in ANOTHER document, so the dirty rect cannot be mapped —
   *  repaint everything instead (otherwise the preview only appears on release) */
  repaintStroke(): void {
    const st = this.gesture.stroke;
    if (!st) return;
    const d = st.takeDirty();
    if (!d) return;
    // a redirected stroke painted into ANOTHER canvas: mirror it into the
    // reference layer's own cel and repaint the whole canvas (the dirty rect
    // lives in the other document's coordinates, so it cannot be mapped)
    if (this.gesture.strokeRedirected) this.session.repaint();
    else this.session.repaintRect(d);
  }

  /** commit a still-open gesture (e.g. bucket fill whose pointerup was lost) as its own history step */
  flushStroke(): boolean {
    // 变换会话也是「没落笔的手势」：切工具 / 切图层 / 切帧 / 撤销 / 存盘之前都要先落下来，
    // 否则浮动内容只活在内存里、而图层已经被 floatCut 清空（自动保存会存成缺内容的样子）。
    // **两种模式都要落**：`warp`（四点 / 网格）与「移动 + 缩放 + 旋转 + 斜切」那套
    // （`mode` 是 `"scale"` / `"rot"`）—— 只判 `warp` 会让后者跨工具 / 跨帧漏掉（实现 bug）。
    if (this.gesture.xf) this.endXf();
    if (this.gesture.path) this.endPath(true);
    if (!this.gesture.stroke) return false;
    this.stopSpray();
    const rec = this.gesture.stroke.commit(this.session.history, this.labelFor(this.gesture.stroke.kind));
    this.gesture.stroke = null;
    this.session.repaint();
    if (rec) this.session.changedUI();
    return rec;
  }

  refresh(force: boolean): void {
    const s = this.session;
    const doc = s.doc;
    if (!doc) return;
    const vw = this.vpW(), vh = this.vpH();
    // pan/zoom/resize invalidate the whole blit, not just the changed pixels
    const lv = this.lastView;
    if (lv.ox !== this.ox || lv.oy !== this.oy || lv.zoom !== this.zoom || lv.w !== vw || lv.h !== vh) this.blitFull = true;
    this.lastView = { ox: this.ox, oy: this.oy, zoom: this.zoom, w: vw, h: vh };
    const t0 = this.render.debugEnabled ? this.render.nowMs() : 0;
    const need = force || this.render.needsCompose;
    if (!need && !this.blitFull) {
      // nothing changed on the pixel canvas (e.g. only the overlay moved)
      this.drawOverlay(false);
      this.noteFrame(false, false, "skip", null, null, false, t0);
      return;
    }
    const tileMode = s.prefs.tileMode as TileMode;
    const tile = tileMode !== "off";
    let region: Rect | null = null;
    let reason: RenderReason = "skip";
    let docRect: Rect | null = null;
    let rebuilt = false;
    let wasFull = this.blitFull;
    if (need) {
      const p = s.prefs;
      const res = this.render.compose(doc, s.curFrame(), onionSpecOf(p), onionKeyOf(p), force);
      reason = res.reason;
      rebuilt = res.rebuilt;
      docRect = res.consumed;
      wasFull = this.blitFull;
      if (!res.rebuilt && !wasFull && docRect) {
        // 屏幕重绘区域（含平铺的 8 个邻居副本）由 RenderServer 算：它就是"重绘什么"的规则
        region = this.render.repaintScreenRegion(docRect, {
          zoom: this.zoom, ox: this.ox, oy: this.oy, vpW: vw, vpH: vh, docW: doc.w, docH: doc.h, tile: tileMode,
        });
      }
    }
    const ctx = this.pix.getContext("2d")!;
    const dpr = this.dpr;
    this.applyTransform(ctx);
    if (region) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(region.x, region.y, region.w, region.h);
      ctx.clip();
      ctx.clearRect(region.x, region.y, region.w, region.h);
    } else {
      ctx.clearRect(0, 0, vw, vh);
    }
    ctx.imageSmoothingEnabled = false;
    const z = this.zoom;
    const chkPat: CanvasPattern | null = doc.bg ? null : this.render.checkerPattern(ctx);
    // every other canvas of the space first, so the focused one stays on top
    this.drawOtherCanvases(ctx, z, vw, vh);
    const wpx = doc.w * z, hpx = doc.h * z;
    // one tile = checker backdrop + the composite; the centre one is the only
    // editable canvas, the 8 neighbours are read-only preview copies
    const drawTile = (dx: number, dy: number): void => {
      const tx = this.ox + dx * wpx;
      const ty = this.oy + dy * hpx;
      if (chkPat) {
        ctx.save();
        ctx.fillStyle = chkPat;
        ctx.translate(tx, ty);
        ctx.scale(z, z);
        ctx.fillRect(0, 0, doc.w, doc.h);
        ctx.restore();
      }
      const cv = this.render.canvas;
      if (!cv) return;
      // the centre tile is the editable canvas, the neighbours are read-only
      // preview copies — a plain translation (no mirroring) in both cases
      ctx.drawImage(cv, tx, ty, wpx, hpx);
    };
    if (tile) {
      for (const [dx, dy] of tileOffsets(tileMode)) drawTile(dx, dy);
      // mark the editable tile so it is obvious which copy you paint on
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(90,162,240,.65)";
      ctx.strokeRect(this.ox - 0.5, this.oy - 0.5, wpx + 1, hpx + 1);
      ctx.restore();
    } else {
      drawTile(0, 0);
    }
    if (s.prefs.gridMode === "pixel" && z >= 6) {
      const step = Math.max(1, Math.round(s.prefs.gridSize));
      ctx.save();
      ctx.translate(this.ox, this.oy);
      ctx.scale(z, z);
      ctx.beginPath();
      ctx.lineWidth = (1 / (z * dpr)) * (z >= 16 ? 2 : 1);
      ctx.strokeStyle = z >= 16 ? "rgba(70,74,96,0.55)" : "rgba(96,102,130,0.4)";
      for (let x = 0; x <= doc.w; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, doc.h); }
      for (let y = 0; y <= doc.h; y += step) { ctx.moveTo(0, y); ctx.lineTo(doc.w, y); }
      ctx.stroke();
      ctx.restore();
    }
    if (region) ctx.restore(); // end the dirty-rect clip
    this.blitFull = false;
    this.noteFrame(need, rebuilt, reason, docRect, region, wasFull, t0);
    this.drawOverlay(need);
    if (this.onViewChanged) this.onViewChanged();
  }

  /** 把"这一帧渲染了什么"回报给 RenderServer 的调试记录（关掉调试时零成本） */
  private noteFrame(
    composed: boolean, rebuilt: boolean, reason: RenderReason,
    docRect: Rect | null, screen: Rect | null, fullBlit: boolean, t0: number,
  ): void {
    if (!this.render.debugEnabled) return;
    this.render.noteFrame({
      composed, rebuilt, reason, fi: this.session.curFrame(),
      docRect, screen, fullBlit, ms: t0 ? this.render.nowMs() - t0 : 0,
    });
  }

  /** draw every non-focused canvas at its place in the infinite space */
  private drawOtherCanvases(ctx: CanvasRenderingContext2D, z: number, vw: number, vh: number): void {
    const s = this.session;
    if (s.docs.length <= 1) return;
    const focus = s.docs[s.docIdx];
    if (!focus) return;
    for (let i = 0; i < s.docs.length; i++) {
      if (i === s.docIdx) continue;
      const e = s.docs[i];
      const sx = this.ox + (e.x - focus.x) * z;
      const sy = this.oy + (e.y - focus.y) * z;
      const w = e.doc.w * z, h = e.doc.h * z;
      if (sx > vw || sy > vh || sx + w < 0 || sy + h < 0) continue; // off screen
      if (!e.doc.bg) {
        const chk = this.render.checkerPattern(ctx);
        if (chk) {
          ctx.save();
          ctx.fillStyle = chk;
          ctx.translate(sx, sy);
          ctx.scale(z, z);
          ctx.fillRect(0, 0, e.doc.w, e.doc.h);
          ctx.restore();
        }
      }
      const cv = this.render.composeOther(i, e.doc, e.fi);
      if (cv) ctx.drawImage(cv, sx, sy, w, h);
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(255,255,255,.22)";
      ctx.strokeRect(sx - 0.5, sy - 0.5, w + 1, h + 1);
      ctx.restore();
    }
  }
  drawOverlay(rebuildTint = false): void {
    const ctx = this.ov.getContext("2d")!;
    this.applyTransform(ctx);
    ctx.clearRect(0, 0, this.vpW(), this.vpH());
    const s = this.session;
    const doc = s.doc;
    if (!doc) return;
    const z = this.zoom;
    this.drawIsoGuide(ctx);
    // green gaps between snapped canvases
    this.drawSnapGaps(ctx, z);
    // selections of referenced canvases: only on their reference layer
    this.drawRefSelections(ctx, z);
    // selection tint + ants
    if (doc.sel && doc.sel.hasAny()) {
      // the tint only depends on the mask, so it is cached on the mask version:
      // a live stroke (mask unchanged) never rebuilds it
      if (rebuildTint || !this.selTint || this.selTintSel !== doc.sel || this.selTintVer !== doc.sel.ver ||
        this.selTint.width !== doc.w || this.selTint.height !== doc.h) {
        const sc = document.createElement("canvas");
        sc.width = doc.w; sc.height = doc.h;
        const sctx = sc.getContext("2d")!;
        const img = sctx.createImageData(doc.w, doc.h);
        const m = doc.sel.mask;
        for (let i = 0; i < m.length; i++) {
          if (m[i]) {
            img.data[i * 4] = 90;
            img.data[i * 4 + 1] = 160;
            img.data[i * 4 + 2] = 245;
            img.data[i * 4 + 3] = 80;
          }
        }
        sctx.putImageData(img, 0, 0);
        this.selTint = sc;
        this.selTintBounds = doc.sel.bounds();
        this.selTintSel = doc.sel;
        this.selTintVer = doc.sel.ver;
      }
      const b = this.selTintBounds;
      ctx.save();
      ctx.translate(this.ox, this.oy);
      ctx.scale(z, z);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.selTint!, 0, 0);
      ctx.restore();
      if (b) {
        ctx.save();
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#eaf0ff";
        ctx.setLineDash([10, 8]);
        ctx.lineDashOffset = -(this.ants % 16);
        ctx.strokeRect(this.ox + b.x * z, this.oy + b.y * z, b.w * z, b.h * z);
        ctx.restore();
      }
    }
    // in-progress lasso trajectory
    const lasso = this.gesture.selDrag;
    if (lasso && lasso.kind === "lasso" && lasso.pts && lasso.pts.length > 0) {
      ctx.save();
      ctx.strokeStyle = "#63f5c5";
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.shadowColor = "rgba(0,0,0,.4)";
      ctx.shadowBlur = 3;
      ctx.beginPath();
      const p0 = lasso.pts[0];
      ctx.moveTo(this.ox + p0[0] * this.zoom, this.oy + p0[1] * this.zoom);
      for (let i = 1; i < lasso.pts.length; i++) {
        const p = lasso.pts[i];
        ctx.lineTo(this.ox + p[0] * this.zoom, this.oy + p[1] * this.zoom);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
      // start anchor
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(this.ox + p0[0] * this.zoom, this.oy + p0[1] * this.zoom, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    // ⑧ 等距图形模式：地面栅格 + 半透明预览 + 抓手 + 尺寸浮标
    if (this.session.isoOn) this.drawIsoMode(ctx);
    // ⑦ 画布调整模式：四条边 + 四个角的把手，拖动时显示新尺寸
    if (this.session.resizeModeOn) {
      const doc = this.session.doc;
      const g = this.gesture.resizeDrag;
      const pvW = (g ? g.w : doc.w) * z, pvH = (g ? g.h : doc.h) * z;
      ctx.save();
      // 边框 + 四角
      ctx.strokeStyle = "#63f5c5";
      ctx.lineWidth = 2;
      ctx.setLineDash(g ? [8, 6] : [6, 5]);
      ctx.strokeRect(this.ox - 0.5, this.oy - 0.5, pvW + 1, pvH + 1);
      ctx.setLineDash([]);
      ctx.fillStyle = "#63f5c5";
      const hs = 9;
      const xs = [this.ox, this.ox + pvW / 2, this.ox + pvW];
      const ys = [this.oy, this.oy + pvH / 2, this.oy + pvH];
      for (const hx of xs) {
        for (const hy of ys) {
          if (hx === xs[1] && hy === ys[1]) continue;   // 中间不画
          ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
        }
      }
      // 尺寸读数
      ctx.font = "600 13px system-ui, sans-serif";
      ctx.fillStyle = "rgba(0,0,0,.65)";
      const label = (g ? g.w : doc.w) + " × " + (g ? g.h : doc.h);
      const tw = ctx.measureText(label).width + 14;
      const lx2 = this.ox + pvW / 2 - tw / 2, ly2 = this.oy + pvH + 10;
      ctx.fillRect(lx2, ly2, tw, 22);
      ctx.fillStyle = "#eaf0ff";
      ctx.fillText(label, lx2 + 7, ly2 + 16);
      ctx.restore();
    }
    this.drawFlash(ctx);
    this.drawOutlinePreview(ctx);
    this.drawGradPreview(ctx);
    // floating selection content: pixels held above the layer during a drag
    const fg = this.gesture.selDrag;
    if (fg && fg.kind === "move" && fg.mv && fg.cut && fg.moved) {
      const mv = fg.mv, content = mv.content;
      const gox = mv.ox + (fg.dx || 0), goy = mv.oy + (fg.dy || 0);
      const zz = Math.max(1, z);
      const dropNow = fg.mv ? this.dropTargetOf({ mv: fg.mv, dx: fg.dx, dy: fg.dy }) : null;
      const srcDoc = this.session.doc;
      const cv = this.floatImage(srcDoc, content);
      ctx.save();
      // 有跨画布落点时把「原位」那份裁在源画布内，免得内容糊在画布之间的空白上
      if (dropNow) {
        ctx.beginPath();
        ctx.rect(this.ox, this.oy, srcDoc.w * z, srcDoc.h * z);
        ctx.clip();
      }
      if (cv) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(cv, this.ox + gox * z, this.oy + goy * z, content.w * z, content.h * z);
      } else {
        for (let y = 0; y < content.h; y++) {
          for (let x = 0; x < content.w; x++) {
            const si = content.idx(x, y);
            const a = content.data[si + 3];
            if (a === 0) continue;
            ctx.globalAlpha = a / 255;
            ctx.fillStyle = "rgb(" + content.data[si] + "," + content.data[si + 1] + "," + content.data[si + 2] + ")";
            ctx.fillRect(this.ox + (gox + x) * z, this.oy + (goy + y) * z, zz, zz);
          }
        }
      }
      ctx.restore();
      // ① 拖到别的画布上时：实时把内容画在那个位置（半透明幽灵），并给目标画布
      //    描一圈虚线，松手前就看得到落点
      const drop = fg.mv ? this.dropTargetOf({ mv: fg.mv, dx: fg.dx, dy: fg.dy }) : null;
      const srcDocRef = this.session.doc;
      if (drop) {
        const dstE = this.session.docs[drop.index];
        const focusE = this.session.docs[this.session.docIdx];
        if (dstE && focusE) {
          const zz2 = Math.max(1, z);
          const ox = this.ox, oy = this.oy;
          ctx.save();
          ctx.beginPath();
          ctx.rect(ox + (dstE.x - focusE.x) * z, oy + (dstE.y - focusE.y) * z, dstE.doc.w * z, dstE.doc.h * z);
          ctx.clip();
          ctx.globalAlpha = 0.72;
          const ghost = this.floatImage(srcDocRef, content);
          if (ghost) {
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(ghost,
              ox + (dstE.x - focusE.x + drop.x) * z, oy + (dstE.y - focusE.y + drop.y) * z,
              content.w * z, content.h * z);
          } else {
            for (let y = 0; y < content.h; y++) {
              for (let x = 0; x < content.w; x++) {
                const si = content.idx(x, y);
                const a = content.data[si + 3];
                if (a === 0) continue;
                ctx.globalAlpha = (a / 255) * 0.72;
                ctx.fillStyle = "rgb(" + content.data[si] + "," + content.data[si + 1] + "," + content.data[si + 2] + ")";
                ctx.fillRect(
                  ox + (dstE.x - focusE.x + drop.x + x) * z,
                  oy + (dstE.y - focusE.y + drop.y + y) * z, zz2, zz2);
              }
            }
          }
          ctx.restore();
          // dashed frame around the target canvas
          ctx.save();
          ctx.strokeStyle = "#63f5c5";
          ctx.lineWidth = 2;
          ctx.setLineDash([8, 6]);
          ctx.strokeRect(ox + (dstE.x - focusE.x) * z - 1, oy + (dstE.y - focusE.y) * z - 1,
            dstE.doc.w * z + 2, dstE.doc.h * z + 2);
          ctx.restore();
        }
      }
    }
    // floating rotate/scale content: pixels rasterised off-layer during a transform
    const xfg = this.gesture.xf;
    if (xfg && xfg.cut && xfg.buf && xfg.cells && xfg.cells.length) {
      const wdoc = this.session.doc.w;
      const buf = xfg.buf;
      const zz = Math.max(1, z);
      ctx.save();
      for (const di of xfg.cells) {
        const o = di * 4;
        const a = buf[o + 3];
        if (a === 0) continue;
        ctx.globalAlpha = a / 255;
        ctx.fillStyle = "rgb(" + buf[o] + "," + buf[o + 1] + "," + buf[o + 2] + ")";
        const cx2 = di % wdoc, cy2 = (di / wdoc) | 0;
        ctx.fillRect(this.ox + cx2 * z, this.oy + cy2 * z, zz, zz);
      }
      ctx.restore();
    }
    // 选区框 / 16 个抓手 / 变形控制点与网格线：**必须画在浮动内容之后**（＝图像之上）。
    // 早先它们排在浮动内容之前，一拖动就被自己变出来的像素盖住 —— 用户报的
    // 「工具点、框框应该渲染在图像画面之上」就是这个（顺序也记在 `docs/UI.md` §3.8）。
    this.drawSelTransform();
    this.drawSymGuides(ctx);
    // footprint marker: pencil/eraser show the exact outline of the brush that
    // will actually paint; other drawing tools keep the square bounds.
    //
    // **必须带上当前笔尖形状**：落笔走的是 `brushStamp(size, brushShape)`（见 tools/stroke.ts），
    // 预览早先写死默认的圆笔尖 —— 换成方笔尖后，白色轮廓还是圆的，跟画出来的方块对不上，
    // 而且偶数尺寸下两种笔尖的偏移范围差一格，看起来就是"预览位置跑偏"（真机反馈）。
    const cu = this.gesture.cursor;
    if (cu) {
      const tool = this.session.tool;
      if (tool === "pencil" || tool === "eraser") {
        const st = brushStamp(cu.size, this.session.brushShape);
        const cw = Math.max(1, z);
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        for (const [cx, cy] of st.outline) {
          ctx.fillRect(this.ox + (cu.x + cx) * z, this.oy + (cu.y + cy) * z, cw, cw);
        }
      } else {
        const s = Math.max(1, Math.round(cu.size));
        const h = Math.floor(s / 2);
        const dw = this.session.doc.w, dh = this.session.doc.h;
        const x1 = Math.max(0, cu.x - h), y1 = Math.max(0, cu.y - h);
        const x2 = Math.min(dw, cu.x - h + s), y2 = Math.min(dh, cu.y - h + s);
        if (x2 > x1 && y2 > y1) {
          ctx.strokeStyle = "rgba(255,255,255,0.9)";
          ctx.lineWidth = 1.2;
          ctx.strokeRect(this.ox + x1 * z, this.oy + y1 * z, (x2 - x1) * z, (y2 - y1) * z);
        }
      }
    }
    this.drawMag(ctx);
  }

  /** pixel loupe: magnified square around the brush while drawing */
  private drawMag(ctx: CanvasRenderingContext2D): void {
    if (!this.gesture.mag || !this.gesture.magCenter) return;
    const doc = this.session.doc;
    const CELL = Math.max(8, Math.round(this.session.prefs.magZoom));
    const L = 132;
    const half = Math.floor(L / CELL / 2);
    const cx = this.gesture.magCenter.x, cy = this.gesture.magCenter.y;
    const sx0 = Math.round(cx - half), sy0 = Math.round(cy - half);
    // fixed at the bottom-left corner of the viewport
    const x = 10, y = this.vpH() - L - 10;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#1d2129";
    ctx.fillRect(x - 2, y - 2, L + 4, L + 4);
    ctx.fillStyle = "#2a2f3d";
    ctx.fillRect(x, y, L, L);
    const comp = this.render.canvas;
    const sX = Math.max(0, sx0), sY = Math.max(0, sy0);
    const eX = Math.min(doc.w, sx0 + half * 2), eY = Math.min(doc.h, sy0 + half * 2);
    if (comp && eX > sX && eY > sY) {
      ctx.drawImage(comp, sX, sY, eX - sX, eY - sY, x + (sX - sx0) * CELL, y + (sY - sy0) * CELL, (eX - sX) * CELL, (eY - sY) * CELL);
    }
    // pixel grid inside the loupe
    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= half * 2; i++) {
      const gx = x + i * CELL + 0.5, gy = y + i * CELL + 0.5;
      ctx.moveTo(gx, y); ctx.lineTo(gx, y + half * 2 * CELL);
      ctx.moveTo(x, gy); ctx.lineTo(x + half * 2 * CELL, gy);
    }
    ctx.stroke();
    // crosshair at the sampled pixel centre
    const bx = x + (cx - sx0) * CELL, by = y + (cy - sy0) * CELL;
    ctx.strokeStyle = "rgba(126,255,214,0.9)";
    ctx.lineWidth = 1.6;
    ctx.strokeRect(bx + 0.5, by + 0.5, CELL - 1, CELL - 1);
    ctx.strokeStyle = "rgba(255,255,255,0.65)";
    ctx.lineWidth = 2;
    ctx.strokeRect(x - 2, y - 2, L + 4, L + 4);
    ctx.restore();
  }

  /** toggle the symmetry-axis adjust mode (drag dashed lines to move axes) */
  /** mirror-axis geometry in css space, or null when symmetric drawing is off */
  private symAxis(): { px: number; py: number; ux: number; uy: number; perp: boolean } | null {
    const s = this.session;
    if (s.sym === "off" || !isSymTool(s.tool)) return null;
    const doc = s.doc;
    const rad = (s.symAng * Math.PI) / 180;
    return {
      px: this.ox + (doc.w / 2 + s.symOx) * this.zoom,
      py: this.oy + (doc.h / 2 + s.symOy) * this.zoom,
      ux: Math.cos(rad), uy: Math.sin(rad),
      perp: s.symFour,
    };
  }
  /** stroke one infinite symmetry line: the overlay canvas clips it to the
   *  viewport, so it visibly runs past the canvas edges into the margins */
  private symStrokeSeg(ctx: CanvasRenderingContext2D, px: number, py: number, ux: number, uy: number): void {
    const K = Math.hypot(this.vpW(), this.vpH()) + 8;
    ctx.beginPath();
    ctx.moveTo(px - ux * K, py - uy * K);
    ctx.lineTo(px + ux * K, py + uy * K);
    ctx.stroke();
  }
  /** rotation knob sits on the primary axis opposite the lock button; hidden when locked */
  private symRotKnob(): [number, number] | null {
    const a = this.symAxis();
    if (!a || this.session.symLocked) return null;
    const w = this.vpW(), h = this.vpH();
    const L = Math.min(92, Math.max(48, Math.min(w, h) * 0.24));
    for (const sgn of [-1, 1]) {
      const kx = a.px + a.ux * L * sgn, ky = a.py + a.uy * L * sgn;
      if (kx >= 10 && ky >= 10 && kx <= w - 10 && ky <= h - 10) return [kx, ky];
    }
    return [clamp(a.px + a.ux * L, 10, w - 10), clamp(a.py + a.uy * L, 10, h - 10)];
  }
  private ptNearAxis(pt: PxPoint, px: number, py: number, ux: number, uy: number, band: number): boolean {
    const dx = pt.x - px, dy = pt.y - py;
    return Math.abs(dx * uy - dy * ux) <= band;
  }

  /** lock-axis button sits on the line at the FAR viewport edge (as far from
   *  the canvas as the layout allows), so it never sits on top of the artwork. */
  symLockBtn(): [number, number] | null {
    const a = this.symAxis();
    if (!a) return null;
    const w = this.vpW(), h = this.vpH();
    const { px, py, ux, uy } = a;
    const tests: number[] = [];
    const test = (t: number): void => {
      const X = px + ux * t, Y = py + uy * t;
      if (X >= -0.5 && X <= w + 0.5 && Y >= -0.5 && Y <= h + 0.5) tests.push(t);
    };
    if (Math.abs(ux) > 1e-6) { test((0 - px) / ux); test((w - px) / ux); }
    if (Math.abs(uy) > 1e-6) { test((0 - py) / uy); test((h - py) / uy); }
    const pos = tests.filter((t) => t > 0.01).sort((x, y) => x - y);
    const tExit = pos.length ? pos[pos.length - 1] : pos.length ? pos[0] : 0;
    const INSET = 22;
    return [
      clamp(px + ux * (tExit - INSET), 15, w - 15),
      clamp(py + uy * (tExit - INSET), 15, h - 15),
    ];
  }

  /** dashed symmetry guides (extend across the whole area) + handles + lock button */
  private drawSymGuides(ctx: CanvasRenderingContext2D): void {
    const a = this.symAxis();
    if (!a) return;
    const locked = this.session.symLocked;
    ctx.save();
    ctx.lineWidth = locked ? 1.2 : 2;
    ctx.strokeStyle = locked ? "rgba(255,255,255,0.4)" : "rgba(126,255,214,0.95)";
    ctx.setLineDash([8, 5]);
    this.symStrokeSeg(ctx, a.px, a.py, a.ux, a.uy);
    if (a.perp) this.symStrokeSeg(ctx, a.px, a.py, -a.uy, a.ux);
    ctx.setLineDash([]);
    if (!locked) {
      // pivot / cross intersection marker (draggable in four-way mode)
      ctx.beginPath();
      ctx.arc(a.px, a.py, 5, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.fill();
      ctx.strokeStyle = "rgba(126,255,214,0.9)";
      ctx.lineWidth = 1.8;
      ctx.stroke();
      // rotation knob opposite the lock button
      const knob = this.symRotKnob();
      if (knob) {
        ctx.beginPath();
        ctx.arc(knob[0], knob[1], 10, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(126,255,214,0.35)";
        ctx.fill();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2.4;
        ctx.stroke();
      }
    }
    // lock button on the line outside the canvas (always tappable)
    const lb = this.symLockBtn();
    if (lb) {
      ctx.beginPath();
      ctx.arc(lb[0], lb[1], 12, 0, Math.PI * 2);
      ctx.fillStyle = locked ? "rgba(126,255,214,0.28)" : "rgba(21,23,32,0.9)";
      ctx.fill();
      ctx.strokeStyle = locked ? "#7effd6" : "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();
      // lock glyph drawn as the same SVG paths used by the app's i-lock / i-unlock icons
      const icon = new Path2D(locked ? LOCK_D : UNLOCK_D);
      const IC = 18, s = IC / 24;
      ctx.save();
      ctx.translate(lb[0] - IC / 2, lb[1] - IC / 2);
      ctx.scale(s, s);
      ctx.fillStyle = locked ? "#7effd6" : "#ffffff";
      ctx.fill(icon);
      ctx.restore();
    }
    ctx.restore();
  }

  /** what an unlocked axis grab is holding: the line (translate) or the knob (rotate) */
  symHit(pt: PxPoint): "mv" | "rot" | null {
    if (this.session.symLocked) return null;
    const a = this.symAxis();
    if (!a) return null;
    const knob = this.symRotKnob();
    if (knob && Math.hypot(pt.x - knob[0], pt.y - knob[1]) <= 26) return "rot";
    const B = 22;
    if (this.ptNearAxis(pt, a.px, a.py, a.ux, a.uy, B)) return "mv";
    if (a.perp && this.ptNearAxis(pt, a.px, a.py, -a.uy, a.ux, B)) return "mv";
    return null;
  }

  /** cached isometric guide grid (true 30° line families), non-pixel lines */
  private drawIsoGuide(ctx: CanvasRenderingContext2D): void {
    if (this.session.prefs.gridMode !== "iso") return;
    // 等距图形模式下由 `drawIsoMode` 铺 2:1 栅格，这里必须让位：
    // 30° 与 2:1 不可能重合，两套网格同时出现在屏幕上，用户只会看到「图形没对齐网格」
    if (this.session.isoOn) return;
    const doc = this.session.doc;
    const step = Math.max(2, Math.round(this.session.prefs.gridSize));
    const key = doc.w + "x" + doc.h + "|" + step;
    if (!this.isoCache || this.isoKey !== key) {
      const c = document.createElement("canvas");
      c.width = doc.w; c.height = doc.h;
      const g = c.getContext("2d")!;
      const sx = doc.h * Math.sqrt(3); // horizontal run of a 30° line over the doc height
      const k0 = Math.floor((-sx - step) / step) - 1;
      const k1 = Math.ceil((doc.w + sx) / step) + 1;
      g.lineWidth = 1;
      for (let k = k0; k <= k1; k++) {
        const major = ((k % 4) + 4) % 4 === 0;
        g.strokeStyle = major ? "rgba(120,140,184,0.45)" : "rgba(120,140,184,0.16)";
        g.beginPath();
        g.moveTo(k * step, 0);
        g.lineTo(k * step + sx, doc.h);
        g.stroke();
        g.beginPath();
        g.moveTo(k * step, 0);
        g.lineTo(k * step - sx, doc.h);
        g.stroke();
      }
      this.isoCache = c;
      this.isoKey = key;
    }
    ctx.save();
    ctx.translate(this.ox, this.oy);
    ctx.scale(this.zoom, this.zoom);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.isoCache, 0, 0);
    ctx.restore();
  }

  /** Pulse one layer for a moment (layer-switch feedback). The layer's pixels
   *  flash white and fade out; an empty layer flashes its bounding frame so the
   *  switch is visible even with nothing drawn on it. */
  flashLayer(li: number): void {
    if (li < 0 || li >= this.session.doc.layers.length) return;
    this.flash = { li, t0: Date.now() };
    this.stepFlash();
  }
  private stepFlash(): void {
    if (this.flashRaf) return;
    this.flashRaf = window.requestAnimationFrame(() => {
      this.flashRaf = 0;
      if (!this.flash) return;
      if (Date.now() - this.flash.t0 >= FLASH_MS) {
        this.flash = null;
        this.drawOverlay();
        return;
      }
      this.drawOverlay();
      this.stepFlash();
    });
  }
  /** freehand outline preview: the same trail as the lasso selection, plus a
   *  light preview of the region that will be filled (auto-closed to the start) */
  /**
   * Live snap feedback while a title bar is dragged: the first time a zone is
   * entered it flashes, then it STAYS visible for as long as the finger keeps
   * the canvases in range, and flashes once more when it is left again.
   * `animate = false` clears it silently (used on release, where the permanent
   * grouped highlight takes over).
   */
  setSnapZones(zones: Array<{ a: number; b: number } & GapRect>, animate = true): void {
    const next = new Map<string, { a: number; b: number; rect: GapRect }>();
    for (const z of zones) {
      next.set(z.a + ":" + z.b, { a: z.a, b: z.b, rect: { x0: z.x0, y0: z.y0, x1: z.x1, y1: z.y1 } });
    }
    const now = performance.now();
    if (animate) {
      for (const [k, z] of next) if (!this.snapZones.has(k)) this.snapFlashes.push({ rect: z.rect, t0: now, kind: "in" });
      for (const [k, z] of this.snapZones) if (!next.has(k)) this.snapFlashes.push({ rect: z.rect, t0: now, kind: "out" });
    }
    this.snapZones = next;
    this.startSnapAnim();
  }
  private startSnapAnim(): void {
    if (this.snapRaf) return;
    const step = (): void => {
      this.snapRaf = 0;
      this.drawOverlay();
      this.snapFlashes = this.snapFlashes.filter((f) => performance.now() - f.t0 < 420);
      if (this.snapFlashes.length) this.snapRaf = window.requestAnimationFrame(step);
      else this.drawOverlay();
    };
    this.snapRaf = window.requestAnimationFrame(step);
  }

  /** a released snap dissolves: a red translucent link fading out */
  pulseUnsnap(pairs: Array<[number, number]>): void {
    if (!pairs.length) return;
    this.unsnapPulse = { pairs, t0: performance.now() };
    if (this.unsnapRaf) return;
    const step = (): void => {
      this.unsnapRaf = 0;
      const p = this.unsnapPulse;
      if (!p) return;
      const k = (performance.now() - p.t0) / 520;
      this.drawOverlay();
      if (k < 1) this.unsnapRaf = window.requestAnimationFrame(step);
      else { this.unsnapPulse = null; this.drawOverlay(); }
    };
    this.unsnapRaf = window.requestAnimationFrame(step);
  }

  /** rgba() string of a "#rrggbb" setting colour at the given alpha */
  private tint(hex: string, alpha: number): string {
    const c = hexToRgba(hex);
    return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + alpha.toFixed(3) + ")";
  }

  /** the empty space between two snapped canvases is tinted green */
  private drawSnapGaps(ctx: CanvasRenderingContext2D, z: number): void {
    const s = this.session;
    const docs = s.docs;
    if (docs.length < 2) return;
    const focus = docs[s.docIdx];
    if (!focus) return;
    const sx = (v: number): number => this.ox + (v - focus.x) * z;
    const sy = (v: number): number => this.oy + (v - focus.y) * z;
    const gapPx = Math.max(0, Math.round(s.prefs.snapGap));
    const inCol = s.prefs.snapInColor || "#78ffb4";
    const outCol = s.prefs.snapOutColor || "#ff6464";
    ctx.save();
    ctx.fillStyle = this.tint(inCol, 0.30);
    for (let i = 0; i < docs.length; i++) {
      const a = docs[i];
      if (!a.group) continue;
      for (let j = i + 1; j < docs.length; j++) {
        const b = docs[j];
        if (b.group !== a.group) continue;
        // tolerant: a group snapped with an older (wider) stacked gap still shows
        // its gap — LEGACY_TITLE_EXTRA was 20, the current extra is 10
        const g = snapGapRect(
          { x: a.x, y: a.y, w: a.doc.w, h: a.doc.h },
          { x: b.x, y: b.y, w: b.doc.w, h: b.doc.h },
          gapPx, LEGACY_TOL);
        if (!g) continue;
        const x0 = g.x0, y0 = g.y0, x1 = g.x1, y1 = g.y1;
        ctx.fillRect(sx(x0), sy(y0), (x1 - x0) * z, (y1 - y0) * z);
      }
    }
    // every satisfied zone stays lit while the finger keeps it in range
    for (const zn of this.snapZones.values()) {
      const g = zn.rect;
      ctx.fillStyle = this.tint(inCol, 0.45);
      ctx.fillRect(sx(g.x0), sy(g.y0), (g.x1 - g.x0) * z, (g.y1 - g.y0) * z);
    }
    // one-shot flashes: green when a zone is entered, red when it is left
    for (const f of this.snapFlashes) {
      const k = Math.min(1, (performance.now() - f.t0) / 420);
      const fade = 1 - k;
      const g = f.rect;
      const x = sx(g.x0), y = sy(g.y0);
      const w = (g.x1 - g.x0) * z, h = (g.y1 - g.y0) * z;
      const green = f.kind === "in";
      ctx.fillStyle = this.tint(green ? inCol : outCol, (green ? 0.55 : 0.45) * fade);
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = this.tint(green ? inCol : outCol, 0.95 * fade);
      ctx.lineWidth = green ? 2 + 3 * fade : 2 + 9 * k;
      const grow = green ? 0 : 8 * k;
      ctx.beginPath();
      if (w >= h) {
        const cy = y + h / 2;
        ctx.moveTo(x - grow, cy);
        ctx.lineTo(x + w + grow, cy);
      } else {
        const cx = x + w / 2;
        ctx.moveTo(cx, y - grow);
        ctx.lineTo(cx, y + h + grow);
      }
      ctx.stroke();
    }
    // a released snap: red translucent link that spreads and fades away
    const u = this.unsnapPulse;
    if (u) {
      const k = Math.min(1, (performance.now() - u.t0) / 520);
      const fade = 1 - k;
      for (const [ia, ib] of u.pairs) {
        const a = this.docsAt(ia), b = this.docsAt(ib);
        const g = a && b ? snapGapRect({ x: a.x, y: a.y, w: a.doc.w, h: a.doc.h }, { x: b.x, y: b.y, w: b.doc.w, h: b.doc.h }, gapPx, LEGACY_TOL) : null;
        if (!g) continue;
        const x = sx(g.x0), y = sy(g.y0);
        const w = (g.x1 - g.x0) * z, h = (g.y1 - g.y0) * z;
        ctx.fillStyle = this.tint(outCol, 0.45 * fade);
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = this.tint(outCol, 0.95 * fade);
        ctx.lineWidth = 2 + 9 * k;
        const grow = 8 * k;
        ctx.beginPath();
        if (w >= h) {
          const cy = y + h / 2;
          ctx.moveTo(x - grow, cy);
          ctx.lineTo(x + w + grow, cy);
        } else {
          const cx = x + w / 2;
          ctx.moveTo(cx, y - grow);
          ctx.lineTo(cx, y + h + grow);
        }
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private docsAt(i: number): { x: number; y: number; doc: { w: number; h: number } } | null {
    const e = this.session.docs[i];
    return e ? { x: e.x, y: e.y, doc: e.doc } : null;
  }

  /**
   * A referenced canvas may have its own selection. Show it on the reference
   * layer that mirrors it (faint violet tint + dashed frame), so it is clear
   * which canvas it belongs to and it never masquerades as this canvas' own
   * selection (which clips painting).
   */
  private drawRefSelections(ctx: CanvasRenderingContext2D, z: number): void {
    const s = this.session;
    const doc = s.doc;
    if (!doc) return;
    for (let li = 0; li < doc.layers.length; li++) {
      const L = doc.layers[li];
      if (!L?.ref || !L.visible) continue;
      const src = s.refSourceOf(li);
      if (!src || !src.doc.sel || !src.doc.sel.hasAny()) continue;
      const { ox, oy } = s.refOffset(li);
      // tint of the source mask, cached on its version
      let e = this.refSelTint.get(L.id);
      if (!e || e.sel !== src.doc.sel || e.ver !== src.doc.sel.ver ||
        e.cv.width !== src.doc.w || e.cv.height !== src.doc.h) {
        const cv = document.createElement("canvas");
        cv.width = src.doc.w;
        cv.height = src.doc.h;
        const c = cv.getContext("2d")!;
        const img = c.createImageData(src.doc.w, src.doc.h);
        const m = src.doc.sel.mask;
        for (let i = 0; i < m.length; i++) {
          if (!m[i]) continue;
          img.data[i * 4] = 190;
          img.data[i * 4 + 1] = 130;
          img.data[i * 4 + 2] = 255;
          img.data[i * 4 + 3] = 70;
        }
        c.putImageData(img, 0, 0);
        e = { sel: src.doc.sel, ver: src.doc.sel.ver, cv };
        this.refSelTint.set(L.id, e);
      }
      ctx.save();
      ctx.translate(this.ox + ox * z, this.oy + oy * z);
      ctx.scale(z, z);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(e.cv, 0, 0);
      ctx.restore();
      const b = src.doc.sel.bounds();
      if (b) {
        ctx.save();
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#be82ff";
        ctx.setLineDash([8, 6]);
        ctx.strokeRect(this.ox + (ox + b.x) * z, this.oy + (oy + b.y) * z, b.w * z, b.h * z);
        ctx.restore();
      }
    }
  }

  /** gradient drag indicator: a line from the anchor to the finger plus the
   *  two end ticks, so the direction/length of the ramp is obvious */
  private drawGradPreview(ctx: CanvasRenderingContext2D): void {
    const st = this.gesture.stroke;
    if (!st || st.kind !== "bucket") return;
    const line = st.gradLine();
    if (!line) return;
    const z = this.zoom;
    const x0 = this.ox + line.x0 * z, y0 = this.oy + line.y0 * z;
    const x1 = this.ox + line.x1 * z, y1 = this.oy + line.y1 * z;
    if (Math.hypot(x1 - x0, y1 - y0) < 2) return;
    const a = Math.atan2(y1 - y0, x1 - x0);
    const tick = 9;
    const nx = Math.cos(a + Math.PI / 2) * tick;
    const ny = Math.sin(a + Math.PI / 2) * tick;
    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = "#ffd166";
    ctx.lineWidth = 2;
    ctx.shadowColor = "rgba(0,0,0,.5)";
    ctx.shadowBlur = 3;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.moveTo(x0 - nx, y0 - ny);
    ctx.lineTo(x0 + nx, y0 + ny);
    ctx.moveTo(x1 - nx, y1 - ny);
    ctx.lineTo(x1 + nx, y1 + ny);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x0, y0, 4, 0, Math.PI * 2);
    ctx.fillStyle = "#ffd166";
    ctx.fill();
    ctx.restore();
  }

  private drawOutlinePreview(ctx: CanvasRenderingContext2D): void {
    const o = this.gesture.outline;
    if (!o || o.pts.length < 2) return;
    const z = this.zoom;
    const sx = (x: number) => this.ox + x * z;
    const sy = (y: number) => this.oy + y * z;
    const pts = o.pts;
    const first = pts[0], last = pts[pts.length - 1];
    const path = (): void => {
      ctx.beginPath();
      ctx.moveTo(sx(first[0]), sy(first[1]));
      for (let i = 1; i < pts.length; i++) ctx.lineTo(sx(pts[i][0]), sy(pts[i][1]));
    };
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    // the fill preview sits under the trail, kept faint so the line stays clear
    if (pts.length >= 3) {
      const c = this.session.color;
      path();
      ctx.closePath();
      ctx.fillStyle = "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + Math.min(0.34, Math.max(0.12, (c[3] / 255) * 0.3)) + ")";
      ctx.fill();
    }
    // trail: identical style to the lasso selection
    ctx.strokeStyle = "#63f5c5";
    ctx.lineWidth = 2;
    ctx.shadowColor = "rgba(0,0,0,.4)";
    ctx.shadowBlur = 3;
    path();
    ctx.stroke();
    ctx.shadowBlur = 0;
    // the segment that will be added automatically to close the shape
    if (pts.length >= 3 && (last[0] !== first[0] || last[1] !== first[1])) {
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = "rgba(99,245,197,.75)";
      ctx.beginPath();
      ctx.moveTo(sx(last[0]), sy(last[1]));
      ctx.lineTo(sx(first[0]), sy(first[1]));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // start anchor
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(sx(first[0]), sy(first[1]), 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** the layer-switch pulse, drawn into the overlay (no composite work) */
  private drawFlash(ctx: CanvasRenderingContext2D): void {
    const f = this.flash;
    if (!f) return;
    const s = this.session;
    const doc = s.doc;
    const z = this.zoom;
    const p = clamp((Date.now() - f.t0) / FLASH_MS, 0, 1);
    const a = 1 - p; // fade out
    const cel = doc.celAt(f.li, s.curFrame());
    let any = false;
    if (cel) {
      for (let i = 3; i < cel.data.length; i += 4) if (cel.data[i] !== 0) { any = true; break; }
    }
    ctx.save();
    if (any && cel) {
      // white silhouette pulse: brightness(0) makes every opaque pixel black,
      // invert(1) turns it white — alpha stays, so only the artwork flashes
      ctx.globalAlpha = a * 0.9;
      ctx.filter = "brightness(0) invert(1)";
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(comp.celToCanvas(cel), this.ox, this.oy, doc.w * z, doc.h * z);
      ctx.filter = "none";
      ctx.globalAlpha = 1;
    }
    // frame pulse: always visible, and marks the editable canvas edges
    ctx.globalAlpha = 0.25 + 0.55 * a;
    ctx.strokeStyle = "#7effd6";
    ctx.lineWidth = any ? 2 : 3;
    ctx.strokeRect(this.ox - 1, this.oy - 1, doc.w * z + 2, doc.h * z + 2);
    ctx.restore();
  }

  private startAnts(): void {
    if (this.antTimer) return;
    this.antTimer = window.setInterval(() => {
      this.ants++;
      this.drawOverlay();
    }, 140);
  }
  private stopAnts(): void {
    if (this.antTimer) {
      window.clearInterval(this.antTimer);
      this.antTimer = null;
    }
  }

  // ---------------------------------------------------------------- gestures
  private bind(): void {
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.host);

    const host = this.host;
    host.addEventListener("contextmenu", (e) => e.preventDefault());
    host.addEventListener("pointerdown", (e) => this.onDown(e));
    host.addEventListener("pointermove", (e) => this.onMove(e));
    host.addEventListener("pointerup", (e) => this.onUp(e));
    host.addEventListener("pointercancel", (e) => this.onCancel(e));
    host.addEventListener("pointerleave", () => {
      if (this.gesture.pointers.size === 0) {
        this.gesture.cursor = null;
        this.drawOverlay();
      }
    });
    // ---- PC（鼠标 / 触控板）：滚轮缩放、Shift 横向、Alt 纵向平移
    host.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    window.addEventListener("keydown", this.onSpaceKey);
    window.addEventListener("keyup", this.onSpaceKey);
  }

  evPt(e: PointerEvent): PxPoint {
    const r = this.host.getBoundingClientRect();
    return this.toLogical(e.clientX - r.left, e.clientY - r.top);
  }


  // ----- long-press eyedropper mode (0.3s stationary inside one pixel) -----
  cancelPickTimer(): void {
    if (this.gesture.longT !== null) {
      window.clearTimeout(this.gesture.longT);
      this.gesture.longT = null;
    }
    this.gesture.pickAnchor = null;
  }
  cancelHold(): void {
    if (this.gesture.hold) {
      window.clearTimeout(this.gesture.hold.t);
      this.gesture.hold = null;
    }
  }
  /** true when any finger of the pending hold moved past the jitter threshold */
  holdMoved(): boolean {
    const h = this.gesture.hold;
    if (!h) return false;
    const tol = Math.max(8, this.session.prefs.fourFingerPx || FOUR_MOVE_PX_DEFAULT);
    for (const [pid, p] of this.gesture.pointers) {
      const st = h.starts.get(pid);
      if (st && Math.hypot(p.x - st.x, p.y - st.y) > tol) return true;
    }
    return false;
  }
  /** arm the n-finger long press (the action is read when it fires) */
  armHold(n: number, action: GestureActionId, tag: string): void {
    this.cancelHold();
    if (this.gesture.pointers.size !== n) return;
    const pts = [...this.gesture.pointers.entries()];
    let mx = 0, my = 0;
    const starts = new Map<number, { x: number; y: number }>();
    for (const [pid, p] of pts) {
      mx += p.x; my += p.y;
      starts.set(pid, { x: p.x, y: p.y });
    }
    this.gesture.holdFired = false;
    const t = window.setTimeout(() => {
      const h = this.gesture.hold;
      if (!h) return;
      this.gesture.hold = null;
      // every finger still down, and nobody slid in the meantime
      if (this.gesture.pointers.size !== h.n || this.gesture.pinchZoomed) return;
      this.gesture.holdFired = true;
      this.session.hapticTick(tag);
      this.session.runGestureAction(action, { x: h.mid.x, y: h.mid.y });
    }, this.session.prefs.longPressMs);
    this.gesture.hold = { n, mid: { x: mx / n, y: my / n }, starts, t };
  }

  samplePickCell(x: number, y: number, strong: boolean): void {
    const c = this.session.sampleComposite(x, y);
    if (c) {
      const changed = this.gesture.pickLast == null || this.gesture.pickLast[0] !== x || this.gesture.pickLast[1] !== y;
      if (changed) {
        this.session.setFgColor(c);
        this.session.hapticTick("取色", strong ? 1.2 : 0.5);
        this.session.repaint();
      }
    }
    this.gesture.pickLast = [x, y];
  }
  enterPickMode(x: number, y: number): void {
    this.gesture.pickMode = true;
    this.gesture.pickLast = null;
    this.gesture.pickAnchor = null;
    // drop any in-progress stroke / pan / selection drag
    if (this.gesture.stroke) {
      this.gesture.stroke.cancel();
      this.gesture.stroke = null;
    }
    this.gesture.panLast = null;
    this.gesture.selDrag = null;
    this.samplePickCell(x, y, true);
  }

  // ---------------- 等距图形模式（iso）----------------
  /**
   * 预览：渲染当前参数 + 原点，返回缓冲与它在屏幕上的左上角。
   *
   * 摆位靠引擎给的 `originAt`（地面原点在缓冲里的位置）—— 换形状 / 改尺寸时
   * 缓冲大小会变，只有锚在地面原点上预览才不会跳。
   */
  private isoPreview(): { r: import("../engine/iso").IsoRenderResult; ax: number; ay: number; key: string } | null {
    const s = this.session;
    if (!s.isoOn) return null;
    const p = s.prefs.iso;
    const shape = s.isoShape();
    const look = s.isoLook();
    const r = isoRender(isoShapeVoxels(shape), look);
    if (!r.w || !r.h) return null;
    const org = s.isoOrigin ?? { x: 0, y: 0 };
    const ax = this.ox + (org.x - r.originAt.x) * this.zoom;
    const ay = this.oy + (org.y - r.originAt.y) * this.zoom;
    const key = [shape.shape, shape.w, shape.d, shape.h, shape.steps, shape.axis, shape.dir, shape.radius,
      shape.hollow, shape.topW, shape.topD, shape.thickness, p.tile, p.colorMode, p.faceTop, p.faceRight, p.faceLeft,
      p.intensity, p.peak, p.sway, p.shadow, p.outline, r.w, r.h].join("|");
    return { r, ax, ay, key };
  }

  /** 地面原点的屏幕位置（抓手、栅格都以它为准） */
  private isoAnchorScreen(): { x: number; y: number } {
    const pv = this.isoPreview();
    if (!pv) return { x: 0, y: 0 };
    return { x: pv.ax + pv.r.originAt.x * this.zoom, y: pv.ay + pv.r.originAt.y * this.zoom };
  }

  /** 五个抓手 + 整块移动的屏幕位置（测试直接读它，交互与绘制共用同一套坐标） */
  isoHandles(): Array<{ kind: "top" | "right" | "bottom" | "left" | "height"; x: number; y: number }> {
    const s = this.session;
    const p = s.prefs.iso;
    const a = this.isoAnchorScreen();
    const z = this.zoom;
    const c = isoGroundCorners(p.tile, p.w, p.d);
    const h = isoHeightHandle(p.tile, p.w, p.d, p.h);
    return [
      { kind: "top", x: a.x + c.top.x * z, y: a.y + c.top.y * z },
      { kind: "right", x: a.x + c.right.x * z, y: a.y + c.right.y * z },
      { kind: "bottom", x: a.x + c.bottom.x * z, y: a.y + c.bottom.y * z },
      { kind: "left", x: a.x + c.left.x * z, y: a.y + c.left.y * z },
      { kind: "height", x: a.x + h.x * z, y: a.y + h.y * z },
    ];
  }

  /** 命中哪个抓手 / 是否落在预览里（null = 落在预览外，仍然按「移动」处理） */
  isoHitAt(pt: PxPoint): "top" | "right" | "bottom" | "left" | "height" | "move" | null {
    const s = this.session;
    if (!s.isoOn) return null;
    const hs = this.isoHandles();
    // 半径随抓手密度收窄：小图块（4px）下四个角会挤在一起，固定 24px 会让「高度」抓手永远点不到
    let minPair = Infinity;
    for (let i = 0; i < hs.length; i++) {
      for (let j = i + 1; j < hs.length; j++) {
        const d = Math.hypot(hs[i].x - hs[j].x, hs[i].y - hs[j].y);
        if (d < minPair) minPair = d;
      }
    }
    const R = Math.max(6, Math.min(isPc() ? 13 : 24, minPair / 2));
    // 命中最近的那个（挤在一起时「先匹配到谁」会变得不可预测）；
    // 高度抓手给 1.5 倍半径的优待 —— 它悬在顶面上方，最容易被别的抓手盖住，也是唯一调高的入口
    let best: typeof hs[number]["kind"] | null = null;
    let bestD = Infinity;
    for (const h of hs) {
      const d = Math.hypot(pt.x - h.x, pt.y - h.y);
      const lim = h.kind === "height" ? R * 1.5 : R;
      if (d <= lim && d < bestD) { best = h.kind; bestD = d; }
    }
    if (best) return best;
    const pv = this.isoPreview();
    if (!pv) return "move";
    const inside = pt.x >= pv.ax && pt.y >= pv.ay && pt.x < pv.ax + pv.r.w * this.zoom && pt.y < pv.ay + pv.r.h * this.zoom;
    return inside ? "move" : null;
  }

  /** iso 拖动的每一步：把屏幕增量换算成格数 / 像素，写回 Session（预览实时跟手） */
  isoDragTo(pt: PxPoint): void {
    const s = this.session;
    const g = this.gesture.isoDrag;
    if (!g) return;
    const T = s.prefs.iso.tile;
    const z = Math.max(0.01, this.zoom);
    const ddx = (pt.x - g.x0) / z, ddy = (pt.y - g.y0) / z;     // doc 像素
    if (g.kind === "height") {
      s.setIsoPref({ h: g.h0 - Math.round(ddy / (T / 2)) });
      return;
    }
    if (g.kind === "move") {
      s.setIsoOrigin(g.origin0.x + ddx, g.origin0.y + ddy);
      return;
    }
    const { a, b } = isoDeltaToCells(T, ddx, ddy);
    if (g.kind === "right") s.setIsoPref({ w: g.w0 + Math.round(a) });
    else if (g.kind === "left") s.setIsoPref({ d: g.d0 + Math.round(b) });
    else if (g.kind === "bottom") s.setIsoPref({ w: g.w0 + Math.round(a), d: g.d0 + Math.round(b) });
    else s.setIsoPref({ w: g.w0 - Math.round(a), d: g.d0 - Math.round(b) });   // top：背面角，往外长
  }

  /** 抓手的图标：足迹四角画实心菱形，高度抓手画一个方块 */
  private drawIsoMode(ctx: CanvasRenderingContext2D): void {
    const s = this.session;
    const p = s.prefs.iso;
    const z = this.zoom;
    const pv = this.isoPreview();
    if (!pv) return;
    const { r, ax, ay, key } = pv;
    const a = this.isoAnchorScreen();
    const T = p.tile;
    ctx.save();
    // ① 地面栅格：两条等距轴方向、过地面原点的线族（只铺在预览外扩一格的范围里）
    if ((T / 4) * z >= 3) {
      const stepX = { x: (T / 2) * z, y: (T / 4) * z };
      const stepY = { x: -(T / 2) * z, y: (T / 4) * z };
      const clipX = ax - T * z, clipY = ay - T * z, clipW = r.w + 2 * T * z, clipH = r.h + 2 * T * z;
      ctx.beginPath();
      ctx.rect(clipX, clipY, clipW, clipH);
      ctx.clip();
      ctx.strokeStyle = "rgba(120,165,225,.32)";
      ctx.lineWidth = 1;
      const span = Math.hypot(clipW, clipH);
      const n = Math.ceil(span / Math.max(1, (T / 4) * z)) + 2;
      const len = span + 40;
      const nx = stepX.x / Math.hypot(stepX.x, stepX.y), ny = stepX.y / Math.hypot(stepX.x, stepX.y);
      const mx = stepY.x / Math.hypot(stepY.x, stepY.y), my = stepY.y / Math.hypot(stepY.x, stepY.y);
      ctx.beginPath();
      for (let k = -n; k <= n; k++) {
        const px1 = a.x + k * stepY.x, py1 = a.y + k * stepY.y;
        ctx.moveTo(px1 - nx * len, py1 - ny * len);
        ctx.lineTo(px1 + nx * len, py1 + ny * len);
        const px2 = a.x + k * stepX.x, py2 = a.y + k * stepX.y;
        ctx.moveTo(px2 - mx * len, py2 - my * len);
        ctx.lineTo(px2 + mx * len, py2 + my * len);
      }
      ctx.stroke();
      ctx.restore();
      ctx.save();
    }
    // ② 半透明预览（拖动时就是「所见即所得」，松手才落笔）
    const cv = this.isoPreviewCanvas(r, key);
    if (cv) {
      ctx.globalAlpha = 0.72;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(cv, ax, ay, r.w * z, r.h * z);
      ctx.globalAlpha = 1;
    }
    // ③ 足迹外框（预览的落地轮廓）
    const c = isoGroundCorners(T, p.w, p.d);
    ctx.beginPath();
    ctx.moveTo(a.x + c.top.x * z, a.y + c.top.y * z);
    ctx.lineTo(a.x + c.right.x * z, a.y + c.right.y * z);
    ctx.lineTo(a.x + c.bottom.x * z, a.y + c.bottom.y * z);
    ctx.lineTo(a.x + c.left.x * z, a.y + c.left.y * z);
    ctx.closePath();
    ctx.strokeStyle = "rgba(99,245,197,.85)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    // ④ 抓手
    for (const h of this.isoHandles()) {
      ctx.beginPath();
      if (h.kind === "height") {
        ctx.rect(h.x - 5, h.y - 5, 10, 10);
        ctx.fillStyle = "#ffd166";
      } else {
        ctx.moveTo(h.x, h.y - 7); ctx.lineTo(h.x + 7, h.y); ctx.lineTo(h.x, h.y + 7); ctx.lineTo(h.x - 7, h.y);
        ctx.closePath();
        ctx.fillStyle = h.kind === "top" || h.kind === "bottom" ? "#63f5c5" : "#8fd0ff";
      }
      ctx.fill();
      ctx.strokeStyle = "rgba(10,14,22,.85)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    // ⑤ 尺寸浮标
    const label = p.w + "×" + p.d + "×" + p.h + " · " + r.w + "×" + r.h + " px";
    ctx.font = "600 13px system-ui, sans-serif";
    const tw = ctx.measureText(label).width + 14;
    const lx = Math.round(ax + (r.w * z) / 2 - tw / 2);
    const ly = Math.max(4, Math.round(ay - 30));
    ctx.fillStyle = "rgba(0,0,0,.65)";
    ctx.fillRect(lx, ly, tw, 22);
    ctx.fillStyle = "#eaf0ff";
    ctx.fillText(label, lx + 7, ly + 16);
    ctx.restore();
  }

  /** 预览用的离屏画布（按参数签名缓存，参数一变就重画） */
  private isoPreviewCanvas(r: import("../engine/iso").IsoRenderResult, key: string): HTMLCanvasElement | null {
    if (this.isoPrevCv && this.isoPrevKey === key) return this.isoPrevCv;
    if (typeof ImageData === "undefined" || typeof document === "undefined") return null;
    try {
      const cv = document.createElement("canvas");
      cv.width = r.w;
      cv.height = r.h;
      const cx = cv.getContext("2d");
      if (!cx) return null;
      cx.putImageData(new ImageData(new Uint8ClampedArray(r.px), r.w, r.h), 0, 0);
      this.isoPrevCv = cv;
      this.isoPrevKey = key;
      return cv;
    } catch {
      return null;
    }
  }

  /** ⑦ 画布调整模式：命中哪条边/哪个角（返回固定的那一侧 ax/ay，null = 没命中） */
  resizeHit(pt: PxPoint): { ax: -1 | 0 | 1; ay: -1 | 0 | 1 } | null {
    const doc = this.session.doc;
    if (!this.session.resizeModeOn) return null;
    const z = this.zoom;
    const W = doc.w * z, H = doc.h * z;
    const TOL = 12;
    // 画布在逻辑坐标里的矩形是 (ox, oy, W, H)：先换成以画布左上角为原点的局部坐标
    const lx = pt.x - this.ox, ly = pt.y - this.oy;
    const nearL = lx >= -TOL && lx <= TOL;
    const nearR = lx >= W - TOL && lx <= W + TOL;
    const nearT = ly >= -TOL && ly <= TOL;
    const nearB = ly >= H - TOL && ly <= H + TOL;
    const inX = lx >= -TOL && lx <= W + TOL;
    const inY = ly >= -TOL && ly <= H + TOL;
    if (!inX || !inY) return null;
    const ax: -1 | 0 | 1 = nearL ? 1 : nearR ? -1 : 0;   // 拖左边＝右边固定
    const ay: -1 | 0 | 1 = nearT ? 1 : nearB ? -1 : 0;
    if (ax === 0 && ay === 0) return null;
    return { ax, ay };
  }

  // 指针事件的**判定与状态迁移**整体搬到了 `servers/gesture.ts` 的 `GestureController`
  // （可用假 host 单测），`View` 这边只留覆盖层绘制与各工具的动作体。
  // 触点会话状态仍然在 `View` 上（覆盖层要画它），通过 `GestureHost` 接口交给控制器 ——
  // 想在控制器里多碰一个字段，先在 `GestureHost` 里声明（编译器会拦住漏声明的访问）。
  /** 手势控制器（触点会话状态的**唯一写者**；下面这些绘制 / 动作体只读它的字段） */
  readonly gesture = new GestureController(this);

  /** 指针按下：转发给手势控制器（判定与顺序见 `servers/gesture.ts`） */
  onDown(e: PointerEvent): void { this.gesture.onDown(e); }
  onMove(e: PointerEvent): void { this.gesture.onMove(e); }
  onUp(e: PointerEvent): void { this.gesture.onUp(e); }
  onCancel(e: PointerEvent): void { this.gesture.onCancel(e); }

  // ------------------------------------------- selection transform box
  // ------------------------- 选区自由变换（Aseprite 那套：移动 / 缩放 / 旋转 / 斜切）---------
  //
  // 交互模型（与 `warp` 模式的「常驻控制点」不同；两平台共用同一套**贴着选区框的固定图标**）：
  //   · 抓手：16 个固定图标 —— 缩放 ×8（4 角＝方块、4 边中点＝扁矩形，离框 6px）、
  //     旋转 ×4（角外侧沿对角线 30px，圆形箭头）、斜切 ×4（边中点外侧沿法线 30px，双向斜线）；
  //     形状固定 ⇒ 语义一眼可辨，不再靠「离框多远」区分；框变小只把旋转 / 斜切收窄到 20px，
  //     **不隐藏类别**（隐藏会让拖动中途抓手消失、语义跳档）。见 `xform.ts` 的 `transformGrabs()`。
  //   · 命中：图标先判（触屏半径 38 起、按同类间距收窄到 24 下限；PC 缩放 22 / 旋转斜切 34），
  //     冲突时按 `GRAB_REACH` 的优先级（缩放 > 旋转 > 斜切）+ 最近优先；PC 图标没中再回落「双层圈」。
  //   · 框内拖动＝移动内容；贴着选区边框 ±2px 的环带＝只移动选区边框；
  //   · 枢轴可拖，另有 8 向 + 中心共 9 档预设；缩放后按归一化比例跟位、旋转后不动。
  //
  // 状态机由 `xf`（会话）+ `xfDrag`（本次拖拽）两层组成：**一次会话 = 一条 undo**。

  /** 当前是 PC（鼠标 + 键盘）还是触屏 —— 只影响命中半径 / 圈提示，图标两平台一致 */
  private xfPc(): boolean {
    return isPc();
  }

  /** 变换会话是不是「移动 + 缩放 + 旋转 + 斜切」模式（`warp` 是另一套） */
  inXform(): boolean {
    return !!this.gesture.xf && this.gesture.xf.mode !== "warp";
  }

  /**
   * 现在是不是一次**精调拖动**（旋转 / 缩放 / 斜切 / 枢轴 / 变形控制点）？
   *
   * 这类拖动的解算全部相对「枢轴屏幕位」「按下时的起点」这些**屏幕参照**，视口一平移，
   * 参照就跟着动：旋转角会跳、抓手会从手指下面滑走。所以自动平移对它们一律不生效
   * （`prefs.autoPan` 只作用于笔迹与普通选区 / 内容拖动）。
   *
   * 「移动内容」不算精调：它本来就是「把内容拖到别处」，边缘自动平移正是要的能力。
   */
  preciseDrag(): boolean {
    const g = this.gesture.xf;
    if (!g) return false;
    if (g.mode === "warp") return g.drag !== undefined;
    if (!this.gesture.xfDrag) return false;
    return this.gesture.xfDrag.kind !== "move";
  }

  /** 变换矩阵（枢轴拖动 / 斜切基准线的补偿都折在 `affineFrom()` 里） */
  private xfMat(g: NonNullable<XfSession>): Mat3 {
    return affineFrom(this.xfParams(g));
  }

  /** 会话的变换参数（`View` 内部与预览共用一处组装，避免两处口径漂移） */
  private xfParams(g: NonNullable<XfSession>): XfParams {
    const tp = g.tp!;
    return {
      pivot: tp.pivot,
      angle: tp.angle,
      sx: tp.sx,
      sy: tp.sy,
      skewX: tp.skewX ?? 0,
      skewY: tp.skewY ?? 0,
      // 缩放的不动点（拖哪个抓手就钉住对面那个锚点）与斜切的基准线（对面那条边）
      scalePivot: tp.scalePivot,
      skewPivot: tp.skewAnchor,
      shift: tp.shift,
      pivot0Shift: tp.pivot0Shift,
    };
  }

  /**
   * 选区框在屏幕上的样子（画与命中共用）。
   * 会话中＝按当前矩阵变换后的框（含旋转 / 缩放 / 斜切）；
   * 没有会话时＝按选区包围盒的轴对齐矩形（仅选区工具下显示，与旧版一致）。
   */
  private xfScreenFrame(): ScreenFrame | null {
    const doc = this.session.doc;
    if (!doc.sel || !doc.sel.hasAny()) return null;
    const b = doc.sel.bounds();
    if (!b) return null;
    const g = this.gesture.xf;
    const z = this.zoom;
    // 会话中：按当前矩阵变换后的框（含旋转 / 缩放 / 斜切）；否则：轴对齐的选区矩形。
    // 两种情况的**画法口径一致**：选区占下标 `b.x .. b.x+b.w-1`，屏幕上是
    // `(b.x * z + ox, b.y * z + oy)` 到 `((b.x+b.w) * z + ox, (b.y+b.h) * z + oy)`。
    if (g && g.mode !== "warp" && g.tp) {
      // 会话里也用**选区框口径**（左上角 = `(b.x·z + ox, b.y·z + oy)`，与上面那条完全一致），
      // 只是把矩形换成「按当前矩阵变换后的四角」：
      //   · 内容局部下标 `i` 占屏幕 `[i·z, (i+1)·z)`（左上角口径），所以内容原点要**加上**
      //     `st.ox·z` 才是画布上那一格；换算里不再有 0.5 的半格补偿；
      //   · 以前这里差了半格（`(st.ox - 0.5)`）：枢轴预设的左上角不落在角抓手上、
      //     旋转中心与抓手整体偏半格 —— 这是实现 bug。
      // 会话里把内容原点平移到画布下标 `(st.ox, st.oy)`：两侧都走
      // 「下标 → 屏幕 `i·z + o`」这一条口径，所以恒等变换下与选中框逐像素重合。
      const f = screenFrameOf(this.xfMat(g), g.st.content.w, g.st.content.h, z, this.ox, this.oy);
      const dx = g.st.ox * z, dy = g.st.oy * z;
      return {
        corners: f.corners.map((p) => ({ x: p.x + dx, y: p.y + dy })),
        angle: f.angle, spanX: f.spanX, spanY: f.spanY,
      };
    }
    const x0 = b.x * z + this.ox, y0 = b.y * z + this.oy;
    const x1 = (b.x + b.w) * z + this.ox, y1 = (b.y + b.h) * z + this.oy;
    return {
      corners: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
      angle: 0, spanX: x1 - x0, spanY: y1 - y0,
    };
  }

  /** 屏幕上要摆的**固定图标抓手**（16 个：8 缩放 + 4 旋转 + 4 斜切；两平台同一套） */
  private xfGrabs(): Grab[] {
    // 四点 / 网格自由变形（warp）是**另一套控制点**，不摆常规变换框的图标
    if (this.gesture.xf && this.gesture.xf.mode === "warp") return [];
    const f = this.xfScreenFrame();
    if (!f) return [];
    return transformGrabs(f);
  }

  /**
   * 枢轴标记在屏幕上的位置（没有会话＝null）。
   *
   * 枢轴是**内容上的一个点**（参数坐标在会话起点那块内容上），所以屏幕位＝把它的参数坐标
   * 过一遍当前矩阵，再加画布原点与视口偏移。于是拖动内容 / 缩放 / 旋转 / 斜切时，
   * 枢轴标记**跟着内容一起走** —— 早先这里只算 `(p + st.ox)·z + ox`（等价于恒等变换），
   * 枢轴会呆在原地不动（用户报的「拖动选取内容时锚点应该跟随」）。
   */
  private xfPivotScreen(): PxPoint | null {
    const g = this.gesture.xf;
    if (!g || g.mode === "warp" || !g.tp) return null;
    const p = applyAffine(this.xfMat(g), g.tp.pivot);
    return {
      x: (p.x + g.st.ox) * this.zoom + this.ox,
      y: (p.y + g.st.oy) * this.zoom + this.oy,
    };
  }

  /**
   * 命中判定：**固定图标抓手**（两平台共用）优先，PC 再叠加双层圈作为额外宽容；
   * 枢轴与抓手**谁更贴手谁赢**。
   *
   * 枢轴不再无条件抢命中：新布局里缩放抓手贴着框，枢轴预设的四角 / 边中点与它几乎重合，
   * 若枢轴仍在「按下第一下」时无条件优先，压在角上的缩放就永远起不来（实现 bug）。
   */
  xfHitAt(pt: PxPoint): { kind: XfKind; anchor?: AnchorId } | null {
    const f = this.xfScreenFrame();
    if (!f) return null;
    const pc = this.xfPc();
    const grabs = this.xfGrabs();
    // 抓手：触屏＝收窄后的统一半径；PC＝按语义分层（缩放内圈 22 / 旋转斜切外圈 34）
    let hit: { kind: XfKind; anchor?: AnchorId } | null = null;
    let hd = Infinity;
    const g = pc ? grabAt(grabs, pt, PC_HIT) : grabAt(grabs, pt, touchHitRadius(grabs));
    if (g) { hit = { kind: g.kind, anchor: g.anchor }; hd = Math.hypot(pt.x - g.x, pt.y - g.y); }
    if (!hit && pc) {
      // 双层圈是 PC 上的**额外**手段：图标没中才回落（小框上「再往外一点」仍然好按）
      const r = ringHitAt(f, pt, PC_HIT);
      if (r) {
        const a = screenAnchors(f)[ANCHORS.indexOf(r.anchor)];
        hit = { kind: r.kind, anchor: r.anchor };
        hd = Math.hypot(pt.x - a.x, pt.y - a.y);
      }
    }
    // 枢轴：可拖，但**只在比抓手更贴手时**才赢（拖动中不再抢，交给本次拖拽）
    const pivotR = pc ? 14 : 26;
    const pv = this.xfPivotScreen();
    if (pv && !this.gesture.xfDrag) {
      const pd = Math.hypot(pt.x - pv.x, pt.y - pv.y);
      if (pd <= pivotR && pd <= hd) return { kind: "pivot" };
    }
    return hit;
  }

  /**
   * 按下那一刻「被抓的那个图标」自己的屏幕位置（见 `xfDrag.h0`）。
   * 缩放 / 旋转取画出来的那个固定图标；枢轴取标记本身；移动 / 没找到时退回指针位置。
   */
  private grabIconAt(kind: XfKind, anchor: AnchorId | undefined, pt: PxPoint): PxPoint {
    if (kind === "pivot") return this.xfPivotScreen() ?? pt;
    if (kind === "move" || !anchor) return pt;
    const g = this.xfGrabs().find((q) => q.kind === kind && q.anchor === anchor);
    return g ? { x: g.x, y: g.y } : pt;
  }


  /** 命中半径（屏幕像素常量；导出给测试与文档） */
  hitRadii(): HitRadii {
    return this.xfPc() ? PC_HIT : TOUCH_HIT;
  }

  /** 抓手的实际外移距离（导出给测试：小选区收窄、但旋转 / 斜切不隐藏就看它） */
  grabOffsetsNow(): GrabOffsets | null {
    const f = this.xfScreenFrame();
    return f ? grabOffsets(Math.min(f.spanX, f.spanY)) : null;
  }

  /**
   * 开始一条变换会话（点内圈 / 外圈 / 抓手时调用）。
   *
   * 进入会话**不动图层**：`floatCut()` 要等真正拖动的那一步才做（见 `xfApply`），
   * 所以「点一下手柄又放开」= 零改动零历史。
   */
  private xfStart(pt: PxPoint, kind: XfKind, anchor?: AnchorId): boolean {
    const s = this.session;
    const doc = s.doc;
    // 已经在会话里：**复用**同一次会话，只把「这次拖的是哪个抓手」记下来。
    // 一次会话一条 undo 靠的就是这里 —— 换个抓手（缩放 → 旋转 → 斜切）不该重开会话，
    // 更不该把已经调好的枢轴 / 缩放 / 角度丢掉。
    const live = this.gesture.xf;
    if (live && live.mode !== "warp" && live.tp) {
      this.gesture.xfDrag = { kind, anchor, start: pt, pivot0: { ...live.tp.pivot }, tp0: tp0Of(live.tp), h0: this.grabIconAt(kind, anchor, pt) };
      s.hapticTick("变换", 0.4);
      this.drawOverlay();
      return true;
    }
    if (s.layerLocked()) { s.paintBlockedNote(); return false; }
    if (!doc.sel || !doc.sel.hasAny()) return false;
    const li = s.curLayer(), fi = s.curFrame();
    const st = beginMove(doc, li, fi);
    if (!st) return false;
    // 宽或高只有 1 像素的选区：变换后必成一条线、内容会被切没，直接拒绝
    // （此时 `xf` 还没写进去，图层与掩码也都没被碰过）
    if (st.content.w < 2 || st.content.h < 2) { this.lastWarpError = "tooThin"; return false; }
    // 复制开关（选区球的 sticky chip，PC 上等价 Ctrl+拖动）：
    // 内容不从图层挖走，松手时把副本贴上去
    st.copy = kind === "move" && (this.session.prefs.selXformCopy || this.ctrlDown);
    // 会话框＝**内容外框**（`contentBox()`：`0..w` / `0..h`），与栅格化器、选中框、抓手同一套口径
    const box = contentBox(st.content.w, st.content.h);
    const center = boxCenter(box);
    const screenBox = screenFrameOf(affineFrom({ pivot: center, angle: 0, sx: 1, sy: 1 }), st.content.w, st.content.h, this.zoom, this.ox, this.oy);
    const px = (pt.x - this.ox) / this.zoom - 0.5, py = (pt.y - this.oy) / this.zoom - 0.5;
    this.gesture.xf = {
      mode: kind === "rotate" ? "rot" : "scale",   // 兼容字段；真正的语义看 this.gesture.xfDrag
      axis: "xy", li, fi, st,
      cx: center.x, cy: center.y, ax: center.x, ay: center.y,
      p0x: px, p0y: py, ang0: Math.atan2(py - center.y, px - center.x),
      moved: false, cut: false, buf: new Uint8ClampedArray(doc.w * doc.h * 4), cells: [],
      tp: { pivot: { x: center.x, y: center.y }, angle: 0, sx: 1, sy: 1, skewX: 0, skewY: 0 },
      box0: box, pivot0: { x: center.x, y: center.y }, screen0: screenBox,
      pivotTouched: false,
      kinds: { move: false, scale: false, rotate: false, skew: false },
    };
    this.gesture.xfDrag = { kind, anchor, start: pt, pivot0: { x: center.x, y: center.y }, tp0: tp0Of(this.gesture.xf.tp), h0: this.grabIconAt(kind, anchor, pt) };
    s.hapticTick("变换", 0.5);
    this.drawOverlay();
    return true;
  }

  /**
   * 拖动中：把指针位置解算成变换参数并刷新预览。
   * 拖动量统一在**框自身的坐标系**里量（框可能已经转过角度），且每次都从
   * 「会话起点的参照框 + 手势起点」重算总计，不做增量累加（不会漂）。
   *
   * 三个分支的参考点必须与**画出来的东西**一致，否则抓手会从手指下面滑走：
   *  · 旋转用 `xfPivotScreen()`（画出来 / 命中用的那个枢轴屏幕位，含 `st.ox`）；
   *  · 缩放 / 斜切用**当前框的旋转角**把拖动量投影到框自身的轴上（框转过也跟手）。
   */
  xfMove(pt: PxPoint): void {
    const g = this.gesture.xf;
    const d = this.gesture.xfDrag;
    if (!g || g.mode === "warp" || !d || !g.tp || !g.screen0 || !g.box0) return;
    const z = this.zoom || 1;
    const tp = g.tp;
    // 屏幕像素 → 外框坐标；再投影到框自身的轴上（框转过角度时拖动方向要跟着转）
    const local = toFrameLocal((pt.x - d.start.x) / z, (pt.y - d.start.y) / z, g.screen0.angle);
    // **抓手自己的参照**：按下时那个图标的屏幕位（`d.h0`）。缩放 / 旋转 / 斜切 / 枢轴都用它，
    // 而不是手指按下的那一点 —— 见 `xfDrag.h0` 的说明（按偏时图标会先贴到指针上）。
    const ref0 = d.h0 ?? d.start;
    const localRef = { x: (pt.x - ref0.x) / z, y: (pt.y - ref0.y) / z };
    // 当前框的旋转角（拖动中框一直在变，用**当前**的：抓手就在眼前那个框上）
    const frameAng = this.xfScreenFrame()?.angle ?? g.screen0.angle;
    const prefs = this.session.prefs;
    if (d.kind === "pivot") {
      // 枢轴：**贴到指针上**再跟着走（参照是按下时枢轴标记自己的位置 `d.h0`，不是手指按下的
      // 那一点）—— 命中半径内按偏一点也不会一直隔着一截。位移换算回枢轴的**参数空间**：
      // 标记画在 `M(pivot)` 上，所以屏幕位移得先过一次矩阵线性部分的逆。
      const b = g.box0;
      const from0 = d.h0 ?? d.start;
      const lin = linearOf(tp);
      const det = lin[0] * lin[3] - lin[1] * lin[2];
      const dx = (pt.x - from0.x) / z, dy = (pt.y - from0.y) / z;
      const bx = Math.abs(det) > 1e-12 ? (lin[3] * dx - lin[1] * dy) / det : dx;
      const by = Math.abs(det) > 1e-12 ? (lin[0] * dy - lin[2] * dx) / det : dy;
      const base = d.pivot0 ?? tp.pivot;
      const p = {
        x: clamp(base.x + bx, b.x0 - 2, b.x1 + 2),
        y: clamp(base.y + by, b.y0 - 2, b.y1 + 2),
      };
      // 枢轴一挪画面必须**逐像素不动**：把矩阵平移分量的差补回去（见 `pivotKeepPicture()`）。
      this.pivotKeepPicture(g, p);
      g.pivotTouched = true;
      g.moved = true;
      this.xfApply();
      return;
    }
    if (d.kind === "move") {
      tp.shift = { x: local.x, y: local.y };
      g.kinds!.move = true;
      g.moved = true;
      this.xfApply();
      return;
    }
    const anchorId = d.anchor ?? "br";
    if (d.kind === "scale") {
      const b = g.box0;
      // 缩放的**不动点**＝对角那个锚点：拖哪个抓手，对面那个就钉住不动、被拖的边跟手
      // （见 `xform.ts` 的 `affineFrom()` / `scaleAnchor()`），而不是绕枢轴两边一起长。
      const a = scaleAnchor(b, anchorId);
      // 参照＝**抓手图标自己**按下时的位置（`d.h0`），不是手指按下的那一点：
      //   命中半径有 38px（触屏），按偏一点时「手指↔图标」那一段会在整个拖动过程里一直保留
      //   —— 用户看到的就是「图标离开我的鼠标 40px、怎么都拖不准」。以图标为参照，
      //   图标会先贴到指针上、再 1:1 跟着走。
      // 「抓手现在在哪」＝**指针现在落在哪**（外框坐标），而不是「抓手起点 + 位移」：
      //   用位移累计会让某一轴一直差半格（斜着拖时那一轴被解成 0 再被钳到 0.02，
      //   看起来就是「缩放没反应」）。起点与终点都用同一条屏幕→外框换算，
      //   于是「按住不动」解出来正好是 1×，不会自己长出去。
      const ref0 = d.h0 ?? d.start;
      const from = { x: (ref0.x - this.ox) / z, y: (ref0.y - this.oy) / z };
      const to = { x: (pt.x - this.ox) / z, y: (pt.y - this.oy) / z };
      // 解与不动点必须在**同一个坐标系**里：`box0`（以及 `scaleAnchor`）是内容外框
      // （内容左上角＝`st.ox`），上面两行却是画布坐标。会话里内容原点固定在
      // `(st.ox, st.oy)`（`beginMove` 之后不再变），减掉它就是内容外框坐标 ——
      // 少了这一步收敛点整体偏移 `st.ox`，拖到「枢轴那一侧」时倍率翻不了号
      // （镜像拖不出来），抓手跟手也会在某一轴上差一截，都是实现 bug。
      from.x -= g.st.ox; from.y -= g.st.oy;
      to.x -= g.st.ox; to.y -= g.st.oy;
      // 框转过角度时：把握手位置绕不动点转回框自身的轴上再解（否则拖对角会被当成斜着缩）
      if (frameAng) {
        const f0 = toFrameLocal(from.x - a.x, from.y - a.y, frameAng);
        const f1 = toFrameLocal(to.x - a.x, to.y - a.y, frameAng);
        from.x = a.x + f0.x; from.y = a.y + f0.y;
        to.x = a.x + f1.x; to.y = a.y + f1.y;
      }
      const ratio = solveScale(
        from, to, a, axisOf(anchorId),
        prefs.selXformAspect || this.shiftDown,      // 「等比」chip（PC 上等价 Shift）
        false,                                       // 吸附在下面按**总倍率**做
      );
      // **倍率以「按下那一刻」为基准累加**：一次会话里可以反复拖同一个抓手，第二次拖是
      // 「在上一次的结果上再放大」；但同一次拖拽里的每个 `pointermove` 都从 `d.tp0` 重算，
      // 所以挪几下也不会连乘（那会让内容越拖越小 —— 用户报的「变形不正确」）。
      const base = d.tp0 ?? tp0Of(tp);
      let nx = base.sx * ratio.sx, ny = base.sy * ratio.sy;
      // 「网格吸附」chip：PC 上 Alt 取反。**必须用 `!!` 归一化**：`altDown` 在没按过
      // Alt 键时是 `undefined`，`false !== undefined` 会把吸附**意外打开**，
      // 于是缩放被吸到整数倍（拖 400px 也只放大 3 倍）—— 看起来就是「缩放坏了」。
      if (!!prefs.selXformGridSnap !== !!this.gesture.altDown) {
        nx = Math.round(nx) || (nx < 0 ? -1 : 1);
        ny = Math.round(ny) || (ny < 0 ? -1 : 1);
      }
      tp.sx = clampScale(nx); tp.sy = clampScale(ny);
      tp.scalePivot = a;
      // 枢轴**不需要**手动跟位：它是内容上的一个点（参数坐标），画的时候过一次矩阵
      // （见 `xfPivotScreen()`），所以缩放时标记自然跟着内容走到新位置。
      g.kinds!.scale = true;
      g.moved = true;
      this.xfApply();
      return;
    }
    if (d.kind === "rotate") {
      // 量的是「从起点指向当前点」的方向，两个向量都从**枢轴**出发 ——
      // 而且必须是**画出来 / 命中用的那个枢轴屏幕位**（`xfPivotScreen()` 含 `st.ox`）。
      // 早先写成 `(pivot + 0.5)·z + ox`（漏了 `st.ox·z`）：选区不在画布原点时旋转中心整体偏移，
      // 拖着抓手转 90° 只出 37°，框与全部抓手跟着甩走 —— 用户报的「锚点乱飞」就是它。
      const pv = this.xfPivotScreen();
      if (!pv) return;
      // 参照同样用**图标按下时的位置**（`d.h0`）：图标先转到手指所在的那条射线上，再跟着走
      // —— 按偏（命中半径内）时不会留下一个固定的角度差，抓手看着才「抓得住」。
      const ref0 = d.h0 ?? d.start;
      const delta = solveRotate(
        { x: ref0.x - pv.x, y: ref0.y - pv.y },
        { x: pt.x - pv.x, y: pt.y - pv.y },
        false,                                            // 吸附在下面按**总角度**做
      ).angle;
      // 角度同样以「按下那一刻」为基准累加（每次拖拽量的是这次拖出来的增量）
      const total = normAngle(((d.tp0 ?? tp0Of(tp)).angle) + delta);
      tp.angle = prefs.selXformAngleSnap || this.shiftDown ? snapCleanAngle(total) : total;
      g.kinds!.rotate = true;
      g.moved = true;
      this.xfApply();
      return;
    }
    if (d.kind === "skew") {
      const b = g.box0;
      // 不动线＝**被拖那条边的对面**（`skewBaseline()`），于是被拖的边整条跟着手指 1:1 平移、
      // 对面那条边一动不动（Aseprite 的行为）。力臂就是框在拖动方向上的整跨度。
      const horiz = anchorId === "t" || anchorId === "b";
      const fixed = skewBaseline(b, anchorId);
      const span = horiz ? Math.abs(b.y1 - b.y0) : Math.abs(b.x1 - b.x0);
      const p0 = anchorPoint(b, anchorId);
      // 参照＝图标按下时的位置（同缩放 / 旋转）：被拖的那条边跟着**图标**走，
      // 按偏时不会一直隔着一截（图标的 30px 法线外移是布局决定的，去不掉；
      // 沿边方向那一份偏移以图标为准，所以它能贴到手指所在的那条线上）。
      const add = solveSkew(anchorId, p0, { x: p0.x + localRef.x, y: p0.y + localRef.y }, span, frameAng).tan;
      // 斜切同样以「按下那一刻」为基准累加（`solveSkew` 返回的是这次拖动量折算的 tan 增量）
      const base = d.tp0 ?? tp0Of(tp);
      if (horiz) tp.skewX = clampTan(base.skewX + add);
      else tp.skewY = clampTan(base.skewY + add);
      // 基准点交给矩阵（`affineFrom()` 认 `skewPivot`）：枢轴本身**不动**，
      // 早先那句「把枢轴挪到不动线上」是个 no-op（`0 || x` 把 0 吃掉了），别再写回去。
      tp.skewAnchor = skewPivotOf(anchorId, fixed);
      tp.pivot0Shift = { x: 0, y: 0 };
      g.kinds!.skew = true;
      g.moved = true;
      this.xfApply();
    }
  }

  /**
   * 把框 `b` 绕 `a` 缩放 `sx` / `sy` 之后的框（负倍率＝翻转，两端重新排序）。
   * 与 `scaleAnchor()` 用的是同一套**外框**算法（视图侧枢轴跟位用）。
   */
  private pivotKeepPicture(g: NonNullable<XfSession>, next: Pt): void {
    const tp = g.tp;
    if (!tp) return;
    if (tp.pivot.x === next.x && tp.pivot.y === next.y) return;
    const before = affineFrom(this.xfParams(g));
    tp.pivot = next;
    tp.pivot0Shift = { x: 0, y: 0 };
    const after = affineFrom(this.xfParams(g));
    tp.pivot0Shift = { x: before[2] - after[2], y: before[5] - after[5] };
  }

  /**
   * 真正刷新预览：算矩阵 → 目标包围盒 → 像素精确通道或最近邻重采样 → 重绘。
   * 第一次调用才 `floatCut()`（把浮动内容从图层上切下来）—— 所以「只进来看看」不改图层。
   */
  private xfApply(): void {
    const g = this.gesture.xf;
    if (!g || g.mode === "warp" || !g.tp) return;
    const s = this.session;
    const doc = s.doc;
    const cw = g.st.content.w, ch = g.st.content.h;
    const m = this.xfMat(g);
    if (!g.cut) {
      g.cut = true;
      selOps.floatCut(doc, g.li, g.fi, g.st);
    }
    if (!g.buf) g.buf = new Uint8ClampedArray(doc.w * doc.h * 4);
    g.exact = this.xfExactOf(g);
    if (g.exact) this.xfApplyExact(m, cw, ch);
    else g.cells = xformAffineFloating(doc, g.st, m, g.buf, xformAffineDestBox(m, cw, ch, g.st.ox, g.st.oy));
    // 图层只在原地被清空（或原地不动），重绘范围＝内容原来那块
    s.repaintRect({ x: g.st.ox, y: g.st.oy, w: g.st.content.w, h: g.st.content.h });
  }

  /**
   * 这次变换能不能走**像素精确通道**（逐像素整数搬运，不重采样）？
   *
   * 只有**纯整数平移**走这条路（`isExactTransform()` ＋ 角度是 0 的整数倍 ＋ 位移是整数格）。
   * 这是最高频的操作，一定要逐字节精确。
   *
   * 旋转 / 翻转**不走**：`exactMove()` 是「把 w×h 的块整体搬到 (dx,dy)」，而 90° 旋转会把宽高
   * 换过来 —— 块的中心会跟着挪半格，只有「枢轴正好在内容中心」时才等价于绕枢轴转，
   * 而且枢轴一旦被拖过就完全不成立。早先这里只判了「无斜切 + 倍率 1」，**漏判角度**，
   * 于是「原地转 90°」也走进这条路：框转了 90°、里面的像素却一格没动（用户报的
   * 「变形不正确」）。现在一律交给最近邻重采样 —— 90° 倍数旋转在格点上是一一对应的，
   * 重采样本身就是无损的（`tests/xformui.test.ts` 有断言钉住）。
   */
  private xfExactOf(g: NonNullable<XfSession>): { dx: number; dy: number; steps: number } | undefined {
    const tp = g.tp!;
    const params = this.xfParams(g);
    if (!isExactTransform(params)) return undefined;
    if (rightAngleSteps(params.angle) !== 0) return undefined;      // 转过角度：走重采样
    const dx = tp.shift?.x ?? 0, dy = tp.shift?.y ?? 0;
    if (!isIntegerShift(dx) || !isIntegerShift(dy)) return undefined;
    return { dx: Math.round(dx), dy: Math.round(dy), steps: 0 };
  }

  /**
   * 像素精确通道的预览：把 `exactMove()` 的结果搬进 `buf` / `cells`（不重采样、不插值）。
   * 结果左上角＝内容原点 + 整数位移（90° 旋转时 `exactMove()` 已经把宽高换过来）。
   */
  private xfApplyExact(_m: Mat3, _cw: number, _ch: number): void {
    const g = this.gesture.xf!;
    const doc = this.session.doc;
    const ex = g.exact!;
    const em = exactMove(g.st.content, ex.steps);
    const tx = g.st.ox + ex.dx, ty = g.st.oy + ex.dy;
    const cells: number[] = [];
    const buf = g.buf!;
    buf.fill(0);
    if (doc.sel) { doc.sel.mask.fill(0); doc.sel.bump(); }
    for (let y = 0; y < em.h; y++) {
      const py = ty + y;
      if (py < 0 || py >= doc.h) continue;
      for (let x = 0; x < em.w; x++) {
        const px = tx + x;
        if (px < 0 || px >= doc.w) continue;
        const si = (y * em.w + x) * 4;
        if (em.dst[si + 3] === 0) continue;
        const di = py * doc.w + px, o = di * 4;
        buf[o] = em.dst[si]; buf[o + 1] = em.dst[si + 1];
        buf[o + 2] = em.dst[si + 2]; buf[o + 3] = em.dst[si + 3];
        cells.push(di);
        if (doc.sel) doc.sel.mask[di] = 1;
      }
    }
    g.cells = cells;
  }

  // ---------- 自由变换：斜切 / 透视（四角）与网格变形 ----------
  /** 控制点在屏幕上的位置（命中判定与绘制共用）。
   *  `pts` 是**像素下标**（恒等时＝选区内容的像素下标），下标 `i` 的像素中心在屏幕上
   *  是 `(i + 0.5) * zoom + ox` —— 那个 `+0.5` 只是「画在像素中心上」，不参与任何数学。
   *  于是整数下标画在像素中心、半像素下标（`x.5`，见 `snapWarpCoord()`）正好画在
   *  两个像素之间的**边界线**上：用户要的「点显示在像素上方」就是这个口径。 */
  private warpHandles(): Array<{ x: number; y: number }> {
    const g = this.gesture.xf;
    if (!g || g.mode !== "warp" || !g.pts) return [];
    const z = this.zoom;
    return g.pts.map((p) => ({ x: (p.x + 0.5) * z + this.ox, y: (p.y + 0.5) * z + this.oy }));
  }

  /** 手指/鼠标落在哪个控制点上。
   *
   *  命中半径默认 22 屏幕像素，但**不超过相邻控制点间距的一半**：小选区上 3×3 网格点很密
   *  （可能只隔十几像素），半径盖满的话「按在内容上＝拖动整块内容」就没有立足之地了，
   *  也没法保证抓住的确实是最近那个点。半径下限 8px，保证点本身仍然好按。 */
  warpHandleAt(pt: PxPoint): number {
    const hs = this.warpHandles();
    if (!hs.length) return -1;
    let pitch = Infinity;
    for (let i = 0; i < hs.length; i++) {
      for (let j = i + 1; j < hs.length; j++) {
        const d = Math.hypot(hs[i].x - hs[j].x, hs[i].y - hs[j].y);
        if (d < pitch) pitch = d;
      }
    }
    const r = Number.isFinite(pitch) ? Math.max(8, Math.min(22, pitch / 2)) : 22;
    let best = -1, bestD = r;
    for (let i = 0; i < hs.length; i++) {
      const d = Math.hypot(pt.x - hs[i].x, pt.y - hs[i].y);
      if (d <= bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /** 按当前控制点重算浮动预览（每次都从手势起点抓下来的原图重算，不累积误差）。
   *  第一次调用时才把浮动内容从图层上切下来（`floatCut`）——进入变形本身不改图层。 */
  private applyWarp(): void {
    const g = this.gesture.xf;
    if (!g || g.mode !== "warp" || !g.pts) return;
    const s = this.session;
    const doc = s.doc;
    if (!g.cut) { g.cut = true; selOps.floatCut(doc, g.li, g.fi, g.st); }
    if (!g.buf) g.buf = new Uint8ClampedArray(doc.w * doc.h * 4);
    g.cells = warpFloating(doc, g.st, g.pts, g.buf, g.warpKind === "mesh", 2, this.session.selWarpHalfSnap);
    // 图层只在原地被清空，重绘范围＝浮动内容原来那块；overlay 由 refresh 统一画
    s.repaintRect({ x: g.st.ox, y: g.st.oy, w: g.st.content.w, h: g.st.content.h });
  }

  /** 进入自由变换：`kind = "quad"` 拖四角（斜切/透视），`kind = "mesh"` 拖 3x3 网格点。
   *  进入时**不动图层**（只画控制点），失败原因见 `lastWarpError`。 */
  beginWarp(kind: "quad" | "mesh"): boolean {
    const s = this.session;
    const doc = s.doc;
    this.lastWarpError = null;
    if (!doc.sel || !doc.sel.hasAny()) { this.lastWarpError = "noSel"; return false; }
    if (s.layerLocked()) { this.lastWarpError = "locked"; s.paintBlockedNote(); return false; }
    let g = this.gesture.xf;
    if (!g) {
      const li = s.curLayer(), fi = s.curFrame();
      const st = beginMove(doc, li, fi);
      if (!st) { this.lastWarpError = "noSel"; return false; }
      // 宽或高只有 1 像素的选区：四点会压成一条线，变形结果必为空 ——
      // 进去只会把内容切没了，所以直接拒绝（此时图层与掩码都还没被碰过）
      if (st.content.w < 2 || st.content.h < 2) { this.lastWarpError = "tooThin"; return false; }
      const b = doc.sel.bounds();
      const cx = b ? b.x + b.w / 2 : 0, cy = b ? b.y + b.h / 2 : 0;
      g = { mode: "warp", axis: "xy", li, fi, st, cx, cy, ax: cx, ay: cy, p0x: cx, p0y: cy, ang0: 0, moved: false };
      this.gesture.xf = g;
    }
    g.mode = "warp";
    g.warpKind = kind;
    // 已经在「移动 / 缩放 / 旋转 / 斜切」里改过画面：先把当前结果**烘焙**成新的浮动内容，
    // 控制点才会落在**现在**这块内容上（不烘焙的话网格点停在变换前的位置，一按预览就
    // 跳回原处 —— 用户报的「网格点乱飘 / 变形不正确」）。
    this.bakeXfIntoContent(g);
    g.pts = kind === "mesh" ? floatGrid(g.st, 2) : floatQuad(g.st);
    g.drag = undefined;
    g.grab = undefined;
    // 已经在变形中（图层切过了）就重算预览；否则只把控制点画出来
    if (g.cut) this.applyWarp();
    else s.repaint();
    s.hapticTick("变形", 0.7);
    return true;
  }

  /**
   * 把当前变换预览（`buf` + `cells`）**烘焙**成新的浮动内容：`st.content` / `st.ox` / `st.oy`
   * 就地更新成「现在画在画布上的那一块」，并把变换参数清零（矩阵回到单位阵）。
   *
   * 用途：从「移动 / 缩放 / 旋转 / 斜切」会话中途切进四点 / 网格变形。`st.before`
   * （会话起点的图层字节）与 `st.mask` 都**不动**，所以撤销与「还原」照旧回到会话开始那一刻。
   * 没有浮动结果（没真拖过）时什么都不做。
   */
  private bakeXfIntoContent(g: NonNullable<XfSession>): void {
    const doc = this.session.doc;
    const buf = g.buf, cells = g.cells;
    if (!g.cut || !buf || !cells || !cells.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (const di of cells) {
      const x = di % doc.w, y = (di / doc.w) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    if (x1 < 0) return;
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const content = new Cel(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const si = ((y0 + y) * doc.w + (x0 + x)) * 4, di = (y * w + x) * 4;
        content.data[di] = buf[si];
        content.data[di + 1] = buf[si + 1];
        content.data[di + 2] = buf[si + 2];
        content.data[di + 3] = buf[si + 3];
      }
    }
    g.st.content = content;
    g.st.ox = x0;
    g.st.oy = y0;
    // 变换参数清零：矩阵回到单位阵，新的几何完全由控制点决定
    const box = contentBox(w, h);
    const c = boxCenter(box);
    g.box0 = box;
    g.pivot0 = { x: c.x, y: c.y };
    g.tp = { pivot: { x: c.x, y: c.y }, angle: 0, sx: 1, sy: 1, skewX: 0, skewY: 0 };
    g.screen0 = screenFrameOf(affineFrom({ pivot: c, angle: 0, sx: 1, sy: 1 }), w, h, this.zoom, this.ox, this.oy);
    g.exact = undefined;
    g.moved = true;          // 画面确实与 st.before 不同了，提交时要落历史
  }

  /** 拖控制点中：把逻辑坐标写回控制点并重算预览。
   *
   *  坐标取自屏幕位置的**连续**反解（`warpPointRaw()`，不是 `screenToPixel()` 的 `floor`
   *  —— 那样半个像素的位移会被吃掉），再按设置项的吸附粒度落点：半像素模式（默认）可以落在
   *  `x.5`，整像素模式落在整数。落点**就是指针所在的那一点**（不记偏移），所以「拖到哪就是哪」，
   *  想精确移动控制点时手感与指针完全一致。 */
  warpMove(pt: PxPoint): void {
    const g = this.gesture.xf;
    if (!g || g.mode !== "warp" || !g.pts || g.drag === undefined) return;
    const half = this.session.selWarpHalfSnap;
    const p = warpPointFromScreen(pt.x, pt.y, this.zoom, this.ox, this.oy, half);
    const q = g.pts[g.drag];
    this.gesture.warpDragOn = true;        // 拖动中：浮标显示当前坐标（见 drawWarpHandles）
    if (q.x === p.x && q.y === p.y) return;
    q.x = Math.max(-4096, Math.min(4096, p.x));
    q.y = Math.max(-4096, Math.min(4096, p.y));
    g.moved = true;   // 真拖过才算「改过」：只进来看手柄不落历史
    this.applyWarp();
  }

  /**
   * 变形模式里「拖动内容」：按在内容上（不在任何控制点上）时，**所有控制点一起平移** ——
   * 锚点因此跟着内容走，而不是呆在原地。返回 false 表示这一下不落在内容上（交给平移视图）。
   *
   * 起点记在 `xf.move` 里，每次移动都从起点重算（不累加、不漂）；位移按吸附粒度取整，
   * 于是整像素 / 半像素两种粒度下拖出来的位移都是干净的。
   */
  warpStartMove(pt: PxPoint): boolean {
    const g = this.gesture.xf;
    if (!g || g.mode !== "warp" || !g.pts) return false;
    const bb = warpBounds(g.pts);
    if (!bb) return false;
    const raw = warpPointRaw(pt.x, pt.y, this.zoom, this.ox, this.oy);
    if (raw.x < bb.x0 - 1 || raw.x > bb.x1 + 1 || raw.y < bb.y0 - 1 || raw.y > bb.y1 + 1) return false;
    g.move = { x0: raw.x, y0: raw.y, pts: g.pts.map((p) => ({ x: p.x, y: p.y })) };
    g.drag = undefined;
    g.grab = undefined;
    return true;
  }

  /** 拖动内容中：把所有控制点按（吸附后的）位移整体搬走 */
  warpMoveContent(pt: PxPoint): void {
    const g = this.gesture.xf;
    if (!g || g.mode !== "warp" || !g.pts || !g.move) return;
    const step = this.session.selWarpHalfSnap ? 0.5 : 1;
    const raw = warpPointRaw(pt.x, pt.y, this.zoom, this.ox, this.oy);
    const dx = Math.round((raw.x - g.move.x0) / step) * step;
    const dy = Math.round((raw.y - g.move.y0) / step) * step;
    let changed = false;
    for (let i = 0; i < g.pts.length; i++) {
      const p0 = g.move.pts[i];
      if (!p0) continue;
      const nx = Math.max(-4096, Math.min(4096, p0.x + dx));
      const ny = Math.max(-4096, Math.min(4096, p0.y + dy));
      if (g.pts[i].x !== nx || g.pts[i].y !== ny) changed = true;
      g.pts[i].x = nx;
      g.pts[i].y = ny;
    }
    if (!changed) return;
    this.gesture.warpDragOn = false;      // 拖内容不显示坐标浮标
    g.moved = true;
    this.applyWarp();
  }

  /** 退出自由变换：把当前结果落下（一条历史），`revert = true` 时还原原像素 */
  finishWarp(revert = false): void {
    const g = this.gesture.xf;
    if (!g || g.mode !== "warp") return;
    if (revert) { this.abortXf(); return; }
    this.endXf();
  }

  /**
   * 「还原」：把变换会话丢掉，图层 / 掩码逐字节回到会话开始时。
   * **不进历史**（与「完成」相对）—— 自由变换的「还原」与 Esc 是同一条路。
   */
  revertXf(): void {
    if (!this.gesture.xf) return;
    this.abortXf();
  }

  /** 「完成」：把会话落成一条历史并结束（没有会话时什么都不做） */
  commitXf(): void {
    if (!this.gesture.xf) return;
    this.endXf();
  }

  /** 变换会话是不是开着（UI 据此显示「完成 / 还原 / 枢轴」这些项） */
  get transforming(): boolean {
    return this.inXform();
  }

  /**
   * 把枢轴钉到**内容下标** `(lx, ly)`（内容第 0 格中心＝`(0,0)`）。
   * 与拖动枢轴同款：顺手补平移补偿，画面逐字节不动；返回是否真的改到了。
   *
   * 存在的理由与 `beginXfMoveAt()` 类似：小选区上枢轴会被内外圈抓手压住，测试无法
   * 用屏幕坐标精确点中它；交互侧不受影响（拖动枢轴走的还是 `xfHitAt()` 那条路）。
   */
  setXfPivotAt(lx: number, ly: number): boolean {
    const g = this.gesture.xf;
    if (!g || g.mode === "warp" || !g.tp) return false;
    if (g.tp.pivot.x === lx && g.tp.pivot.y === ly) return false;
    this.pivotKeepPicture(g, { x: lx, y: ly });
    g.pivotTouched = true;
    g.moved = true;
    this.xfApply();
    return true;
  }

  /**
   * 以「移动内容」语义开始一次变换（选中框正中的拖动通常就是这个）。
   *
   * 为什么要有这个入口：按住内圈 / 外圈会分别进入缩放 / 旋转 / 斜切，`onDown` 会**优先**
   * 判这些抓手；只有「离所有抓手都超过外圈半径」的空白处拖动才算移动。小选区上
   * （框中点到上下边的距离永远小于外圈半径 34px）不存在这样的空白点，测试也就无法
   * 用「屏幕坐标」构造出移动手势 —— 所以给一条显式的语义入口。
   * 交互侧没有任何变化：它只走 `xfStart(pt, "move")` 这一条既有路径。
   */
  beginXfMoveAt(sx: number, sy: number): boolean {
    return this.xfStart({ x: sx, y: sy }, "move");
  }

  /**
   * 双击枢轴 = 把它复位到**内容正中**（9 档预设里的 `cc`），返回是否真的挪了位置。
   *
   * 与拖动枢轴、`setPivotPreset()` 同款：`pivotKeepPicture()` 会补平移补偿，
   * 所以复位枢轴**画面逐像素不动** —— 它只改「绕哪里转」。
   */
  resetXfPivot(): boolean {
    const g = this.gesture.xf;
    if (!g || g.mode === "warp" || !g.tp) return false;
    const p = pivotPresetPoint(pivotBoxOf(g), "cc");
    if (g.tp.pivot.x === p.x && g.tp.pivot.y === p.y) return false;
    this.pivotKeepPicture(g, p);
    g.pivotTouched = true;
    g.moved = true;
    this.xfApply();
    return true;
  }

  /** 当前枢轴落在哪一档预设（9 档循环 / 高亮用；没有会话返回 null） */
  pivotPreset(): PivotPreset | null {
    const g = this.gesture.xf;
    if (!g || g.mode === "warp" || !g.tp) return null;
    const b = pivotBoxOf(g);
    let best: PivotPreset = "cc", bd = Infinity;
    for (let i = 0; i < 9; i++) {
      const k = pivotPresetAt(i);
      const q = pivotPresetPoint(b, k);
      const d = Math.hypot(q.x - g.tp.pivot.x, q.y - g.tp.pivot.y);
      if (d < bd) { bd = d; best = k; }
    }
    return best;
  }

  /**
   * 把枢轴设到某一档预设（选区球里的「枢轴」条目循环 9 档用）。
   * 与拖动枢轴同款：**画面不能动**，所以顺手补上平移补偿。
   * 没在会话里时返回 false（此时没有枢轴可言）。
   */
  setPivotPreset(k: PivotPreset): boolean {
    const g = this.gesture.xf;
    if (!g || g.mode === "warp" || !g.tp) return false;
    const b = pivotBoxOf(g);
    const p = pivotPresetPoint(b, k);
    this.pivotKeepPicture(g, p);
    g.pivotTouched = true;
    g.moved = true;
    this.xfApply();
    return true;
  }

  /** 枢轴按 9 档循环（「枢轴」条目点一下换下一档） */
  cyclePivot(): PivotPreset | null {
    const cur = this.pivotPreset();
    if (!cur) return null;
    const i = (PIVOT_PRESETS.indexOf(cur) + 1) % PIVOT_PRESETS.length;
    const next = PIVOT_PRESETS[i];
    return this.setPivotPreset(next) ? next : null;
  }

  /** 退出等距模式时清掉进行中的拖动（Session 调它，免得抓手状态留在下一次会话里） */
  isoCancelDrag(): void {
    this.gesture.isoDrag = null;
    this.isoPrevCv = null;
    this.isoPrevKey = "";
  }

  /** 只让「视图」重画一次覆盖层（滑块 / 设置改动后调用） */
  refreshOverlay(): void {
    this.drawOverlay();
  }

  /** 指针落在选区变换框上 → 开始 / 继续一次变换会话。
   *  语义表见 `xfHitAt()`：内圈缩放、外圈旋转（角）/ 斜切（边中点）、枢轴、框内移动、
   *  贴着边线的环带＝只移动选区边框。命中后**顺手取消待触发的长按取色**。 */
  tryStartXf(pt: PxPoint): boolean {
    const s = this.session;
    const tool = s.tool;
    if (tool !== "select" && tool !== "lasso" && tool !== "wand") return false;
    if (this.gesture.selDrag || this.gesture.xfDrag) return false;
    const doc = s.doc;
    if (!doc.sel || !doc.sel.hasAny()) return false;
    const f = this.xfScreenFrame();
    if (!f) return false;
    // 贴着选区边线的**环带**（±2px）优先：那一下是「只移动选区边框」，不是抓手
    const band = distToFrame(f, pt) <= 2;
    const inside = insideFrame(f, pt);
    if (band && inside && !this.inXform()) {
      const pp = this.screenToPixel(pt.x, pt.y);
      this.startSelMove(pp);
      if (this.gesture.selDrag) { this.gesture.selDrag.frameOnly = true; return true; }
    }
    const hit = this.xfHitAt(pt);
    if (hit) {
      // 双击枢轴＝复位到内容正中（真机反馈：枢轴拖到别处后拖不回来，只能一档档循环预设）。
      // 「前一次点击」由 `xfEndDrag()` 登记（必须是**按下去没拖动**的那一下），
      // 所以「拖完枢轴又点一下」不会被误判成双击。
      if (hit.kind === "pivot") {
        const near = !!this.pivotTapPt && Math.hypot(pt.x - this.pivotTapPt.x, pt.y - this.pivotTapPt.y) < 40;
        if (this.pivotTapT > 0 && Date.now() - this.pivotTapT < s.prefs.doubleTapMs && near) {
          this.pivotTapT = 0;
          this.pivotTapPt = null;
          if (this.resetXfPivot()) {
            s.hapticTick("复位枢轴", 0.7);
            this.drawOverlay();
          }
          return true;
        }
      }
      return this.xfStart(pt, hit.kind, hit.anchor);
    }
    // 会话里：没命中抓手但落在框内 = 接着移动内容
    if (this.inXform()) {
      if (!insideFrame(f, pt)) return false;
      return this.xfStart(pt, "move");
    }
    // 会话外：框内非边线交给「移动内容」；贴着边线的环带＝只移动选区边框
    const b = doc.sel.bounds();
    if (!b) return false;
    if (inside && !band) return false;
    if (!inside && !band) return false;
    const pp = this.screenToPixel(pt.x, pt.y);
    if (!this.startSelMove(pp)) return false;
    if (band && inside && this.gesture.selDrag) this.gesture.selDrag.frameOnly = true;
    return true;
  }

  /**
   * 松手：只结束**这一次拖拽**，会话（事务）继续开着 —— 这是 Aseprite 的语义，
   * 「一次会话一条 undo」靠它成立。落历史在 `endXf()`（完成 / 切工具 / 切帧时）。
   */
  xfEndDrag(): void {
    const g = this.gesture.xf;
    const d = this.gesture.xfDrag;
    this.gesture.xfDrag = null;
    if (!g || g.mode === "warp" || !d || !g.tp) return;
    // 双击枢轴的「第一次点击」在这里登记：只有**按下去没拖动**（枢轴还在按下处）
    // 才算一次点击，真正拖过枢轴的不算 —— 否则「拖完再点一下」会被当成双击复位。
    if (d.kind === "pivot" && d.pivot0) {
      const still = Math.hypot(g.tp.pivot.x - d.pivot0.x, g.tp.pivot.y - d.pivot0.y) < 1e-6;
      if (still) {
        this.pivotTapT = Date.now();
        this.pivotTapPt = this.xfPivotScreen();
      } else {
        this.pivotTapT = 0;
        this.pivotTapPt = null;
      }
    }
    // 枢轴的跟位（缩放后按归一化比例跟位、旋转后不动）已经**在拖动过程中实时做了**，
    // 见 `xfMove()` 的 scale 分支 + `pivotKeepPicture()`：实时做才不会在松手的一瞬间
    // 让枢轴标记跳一下（这里再算一次会变成「跟位两次」，是错的）。
    this.drawOverlay();
  }

  /** 中断拖拽但不结束会话（第二根手指落下 / 指针丢失）：画面保持现状，等下一次拖 */
  xfBreakDrag(): void {
    this.gesture.xfDrag = null;
    if (this.gesture.xf) this.drawOverlay();
  }

  /** transform ended: commit one undo step (or nothing when it never moved) */
  endXf(): void {
    this.gesture.warpDragOn = false;
    this.gesture.xfDrag = null;
    const g = this.gesture.xf;
    this.gesture.xf = null;
    if (!g) return;
    const s = this.session;
    const doc = s.doc;
    const cel = doc.celAt(g.li, g.fi);
    if (!cel) return;
    if (!g.moved) {
      // 没真拖过（只进去看了一眼，或只切了模式）：图层必须原样还回去，
      // 否则 floatCut 过的内容就永远留在「被清空」的状态里
      if (g.cut) cel.data.set(g.st.before);
      s.repaint();
      return;
    }
    if (g.cut && g.buf && g.cells && g.cells.length) {
      // drop: the cel still holds "pre-gesture minus content", write the final
      // floating pixels once and record a single history step。
      // `st.copy`（复制模式）：图层根本没被挖过，所以浮动的副本要**叠**上去而不是覆盖。
      const data = cel.data;
      const buf = g.buf;
      for (const di of g.cells) {
        const o = di * 4;
        if (g.st.copy) blendInto(data, o, buf, o);
        else { data[o] = buf[o]; data[o + 1] = buf[o + 1]; data[o + 2] = buf[o + 2]; data[o + 3] = buf[o + 3]; }
      }
      let changed = false;
      for (let i = 0; i < data.length; i++) if (data[i] !== g.st.before[i]) { changed = true; break; }
      if (changed) {
        s.history.pushPixels(this.xfLabel(g), doc, [
          { li: g.li, fi: g.fi, before: g.st.before, after: new Uint8ClampedArray(data) },
        ]);
        s.changed();
      }
    } else if (g.cut && g.mode === "warp") {
      // 变形结果为空（四角被拖成一条线 / 内容整体拖出画布）：不要落一条「把内容清空」的
      // 历史，把原样还回去 —— 想删内容有专门的删除按钮，这里宁可什么都不做
      cel.data.set(g.st.before);
    } else if (g.cut && g.cells && g.cells.length === 0 && !g.st.copy) {
      // 移动 / 缩放 / 旋转 / 斜切把内容整个推出了画布：同上，不落「清空内容」的历史
      cel.data.set(g.st.before);
    }
    s.repaint();
  }

  /** 这次会话该记成哪一条历史（多种语义混着用时取优先级最高的那个） */
  private xfLabel(g: NonNullable<XfSession>): string {
    if (g.mode === "warp") return "sel.warp";
    const k = g.kinds;
    if (!k) return "sel.transform";
    for (const kind of XF_LABEL_ORDER) {
      if (kind === "move" ? k.move : kind === "scale" ? k.scale : kind === "rotate" ? k.rotate : k.skew) {
        return XF_LABEL[kind];
      }
    }
    return "sel.transform";
  }

  /** gesture cancelled (pointercancel / lost): roll the layer back to drag start */
  abortXf(): void {
    const g = this.gesture.xf;
    this.gesture.xf = null;
    this.gesture.xfDrag = null;
    this.gesture.warpDragOn = false;
    if (!g) return;
    const doc = this.session.doc;
    const cel = doc.celAt(g.li, g.fi);
    if (cel) cel.data.set(g.st.before);
    if (doc.sel) { doc.sel.mask.set(g.st.mask); doc.sel.bump(); }
    this.session.repaint();
  }

  /** 自由变换的控制点：四角（斜切/透视）或 3x3 网格，外加连成的多边形 */
  private drawWarpHandles(): void {
    const ctx = this.ov.getContext("2d");
    const hs = this.warpHandles();
    if (!ctx || !hs.length) return;
    const mesh = this.gesture.xf?.warpKind === "mesh";
    const n = mesh ? 3 : 2;
    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.beginPath();
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const a = hs[r * n + c];
        const b = r * n + c + 1 < (r + 1) * n ? hs[r * n + c + 1] : null;
        const d = r + 1 < n ? hs[(r + 1) * n + c] : null;
        if (b) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
        if (d) { ctx.moveTo(a.x, a.y); ctx.lineTo(d.x, d.y); }
      }
    }
    ctx.stroke();
    for (const h of hs) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(h.x - 4, h.y - 4, 8, 8);
      ctx.strokeStyle = "rgba(0,0,0,0.65)";
      ctx.strokeRect(h.x - 4, h.y - 4, 8, 8);
    }
    // 拖动中的坐标浮标：`x, y`（半像素模式显示一位小数，如 `12.5`）。
    // 贴着被拖的那个控制点画，松手即消失（onUp / 退出变形都会清 warpDragOn）。
    const drag = this.gesture.xf?.drag;
    const q = drag !== undefined ? this.gesture.xf?.pts?.[drag] : undefined;
    const dragH = drag !== undefined ? hs[drag] : undefined;
    if (this.gesture.warpDragOn && q && dragH) {
      const label = warpCoordLabel(q, this.session.selWarpHalfSnap);
      const h = dragH;
      ctx.font = "600 13px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const tw = ctx.measureText(label).width;
      // 默认画在控制点右上方；顶到上边就翻到下面，顶到右边就翻到左侧
      const w = tw + 14, hh = 22;
      let lx = h.x + 12, ly = h.y - 14 - hh / 2;
      if (lx + w > this.vpW() - 4) lx = h.x - 12 - w;
      if (ly < 4) ly = h.y + 14;
      lx = Math.max(2, Math.min(this.vpW() - w - 2, lx));
      ly = Math.max(2, Math.min(this.vpH() - hh - 2, ly));
      ctx.fillStyle = "rgba(20,24,32,0.86)";
      ctx.beginPath();
      ctx.rect(lx, ly, w, hh);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.7)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.fillText(label, lx + 7, ly + hh / 2 + 0.5);
    }
    ctx.restore();
  }

  /** dashed selection frame + white handles + rotate dot above the top edge */
  private drawSelTransform(): void {
    if (this.gesture.selDrag) return;
    const tool = this.session.tool;
    if (this.gesture.xf && this.gesture.xf.mode === "warp") { this.drawWarpHandles(); return; }
    if (!this.gesture.xf && tool !== "select" && tool !== "lasso" && tool !== "wand") return;
    const f = this.xfScreenFrame();
    if (!f) return;
    const ctx = this.ov.getContext("2d")!;
    const pc = this.xfPc();
    const active = this.inXform();
    // 会话里 `xfScreenFrame()` 的坐标系原点＝内容第 0 格的**中心**，而选中框要画在
    // 选区左上角上，所以整体平移 `(+0.5 * zoom, +0.5 * zoom)`
    ctx.save();
    // 框：深色打底 + 白色描边（会话中跟着矩阵旋转 / 缩放 / 斜切）
    ctx.beginPath();
    ctx.moveTo(f.corners[0].x, f.corners[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(f.corners[i].x, f.corners[i].y);
    ctx.closePath();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = "rgba(0,0,0,.6)";
    ctx.stroke();
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = "rgba(255,255,255,.92)";
    ctx.stroke();
    // 抓手：**两平台同一套固定图标**（贴在选区框上的方块 / 扁矩形＝缩放，角外侧对角线方向的
    // 圆形箭头＝旋转，边中点外侧法线方向的双向斜线＝斜切）。三种图标形状不同、位置固定，
    // 靠形状一眼区分语义，不再依赖「离框多远」；框变小只是把旋转 / 斜切收窄，**不会整类消失**。
    const grabs = this.xfGrabs();
    const hover = this.gesture.xfHover;
    for (const g of grabs) {
      const hot = !!hover && hover.kind === g.kind && hover.anchor === g.anchor;
      // 角图标（方块 / 圆）无方向；边中点图标要顺着那条边摆（扁矩形）或沿法线偏（双向斜线）
      const corner = g.anchor === "tl" || g.anchor === "tr" || g.anchor === "br" || g.anchor === "bl";
      const n = corner ? { x: 0, y: -1 } : edgeNormalOf(f, g.anchor!);
      drawXfGrab(ctx, g, grabTangent(n), n, hot);
    }
    if (pc && hover && hover.kind !== "move" && hover.kind !== "pivot" && hover.anchor) {
      // PC 的双层圈是**额外**的命中宽容（图标没中才回落，见 `xfHitAt()`）：
      // 悬停到哪个锚点就把那一层圈点亮，告诉用户「图标外面一点也还算它」
      const p = screenAnchors(f)[ANCHORS.indexOf(hover.anchor)];
      ctx.beginPath();
      ctx.strokeStyle = "rgba(174,209,255,.55)";
      ctx.lineWidth = 1;
      ctx.arc(p.x, p.y, PC_HIT.outer, 0, Math.PI * 2);
      ctx.stroke();
    }
    // 枢轴：小圆点 + 十字（可拖；只有会话里才有意义）
    const pv = this.xfPivotScreen();
    if (pv && active) {
      const hot = this.gesture.xfHover?.kind === "pivot";
      ctx.beginPath();
      ctx.strokeStyle = hot ? "#ffd166" : "rgba(255,255,255,.9)";
      ctx.lineWidth = 1.4;
      ctx.arc(pv.x, pv.y, 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(pv.x - 12, pv.y); ctx.lineTo(pv.x + 12, pv.y);
      ctx.moveTo(pv.x, pv.y - 12); ctx.lineTo(pv.x, pv.y + 12);
      ctx.stroke();
      ctx.beginPath();
      ctx.fillStyle = hot ? "#ffd166" : "#aed1ff";
      ctx.arc(pv.x, pv.y, 3.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }


  /** airbrush: keep spraying every 50 ms while the pointer stays down */
  startSpray(): void {
    this.stopSpray();
    const rate = Math.max(5, Math.min(60, this.session.prefs.airbrushRate));
    const period = 50;
    this.sprayT = window.setInterval(() => {
      const st = this.gesture.stroke;
      if (!st) { this.stopSpray(); return; }
      this.sprayAcc += (rate * period) / 1000;
      const n = Math.floor(this.sprayAcc);
      if (n < 1) return;
      this.sprayAcc -= n;
      st.sprayBurst(n);
      const d = st.takeDirty();
      if (d) {
        if (this.gesture.strokeRedirected) this.session.repaint();
        else this.session.repaintRect(d);
      }
    }, period);
  }
  stopSpray(): void {
    if (this.sprayT !== null) { window.clearInterval(this.sprayT); this.sprayT = null; }
    this.sprayAcc = 0;
  }

  labelFor(kind: string): string {
    const map: Record<string, string> = {
      pencil: "tools.pencil", eraser: "tools.eraser", bucket: "tools.bucket", airbrush: "tools.airbrush",
      line: "tools.line", rect: "tools.rect", rectfill: "tools.rectfill",
      ellipse: "tools.ellipse", ellipsefill: "tools.ellipsefill",
      circle: "tools.circle", polygon: "tools.polygon",
      polyline: "tools.polyline", curve: "tools.curve",
    };
    return map[kind] ?? kind;
  }

  // ---- freehand outline tool (draw a closed shape → fill it) ----
  /** pointer down: start collecting the freehand path (nothing is painted yet) */
  outlineDown(pp: { x: number; y: number }): void {
    const s = this.session;
    if (s.layerLocked()) { s.paintBlockedNote(); return; }
    // redirect onto the referenced canvas, exactly like a brush stroke
    const tgt = s.strokeTarget(s.curLayer());
    const doc = tgt ? tgt.doc : s.doc;
    const li = tgt ? tgt.li : s.curLayer();
    const fi = tgt ? tgt.fi : s.curFrame();
    const cel = doc.celAt(li, fi);
    this.gesture.outline = {
      pts: [[pp.x, pp.y]], li, fi,
      before: cel ? new Uint8ClampedArray(cel.data) : null,
      dx: tgt ? tgt.dx : 0, dy: tgt ? tgt.dy : 0,
    };
    this.gesture.cursor = null;
    this.drawOverlay();
  }
  outlineMove(pp: { x: number; y: number }): void {
    const o = this.gesture.outline;
    if (!o) return;
    const last = o.pts[o.pts.length - 1];
    if (last[0] === pp.x && last[1] === pp.y) return;
    // keep the path contiguous so the scanline fill has no gaps
    lineCells(last[0], last[1], pp.x, pp.y, (x, y) => {
      const l = o.pts[o.pts.length - 1];
      if (l[0] !== x || l[1] !== y) {
        if (o.pts.length < 4000) o.pts.push([x, y]);
      }
    });
    this.drawOverlay();
  }
  // ---- multi-point path tools (polyline / curve) --------------------------
  /**
   * Point a redirected (reference) stroke at the source canvas: the mirror is
   * CENTRED inside this canvas, so every cell has to be translated, the
   * symmetry/tiling geometry is THIS canvas, and the selection mask is this
   * canvas' selection mapped into the source.
   */
  wireRedirect(st: Stroke, tgt: { dx: number; dy: number } | null): void {
    if (!tgt) return;
    st.refDx = tgt.dx;
    st.refDy = tgt.dy;
    st.setGeometry(this.session.doc.w, this.session.doc.h);
    const sel = this.session.doc.sel;
    if (sel && sel.hasAny()) {
      st.mask = (sx: number, sy: number) => sel.get(sx + tgt.dx, sy + tgt.dy) === 1;
    }
  }
  isPathTool(t: string): boolean {
    return t === "polyline" || t === "curve";
  }
  /** where a new path stroke would land (reference layers redirect) */
  private pathTarget(): { doc: Doc; li: number; fi: number; dx: number; dy: number } {
    const s = this.session;
    const tgt = s.strokeTarget(s.curLayer());
    return tgt
      ? { doc: tgt.doc, li: tgt.li, fi: tgt.fi, dx: tgt.dx, dy: tgt.dy }
      : { doc: s.doc, li: s.curLayer(), fi: s.curFrame(), dx: 0, dy: 0 };
  }
  /** commit (or drop) the pending path */
  private endPath(commit: boolean): void {
    const p = this.gesture.path;
    this.gesture.path = null;
    if (!p) return;
    if (commit) {
      const rec = p.st.commit(this.session.history, this.labelFor(p.st.kind));
      if (rec) this.session.changedUI();
    } else {
      p.st.cancel();
    }
    this.session.repaint();
    this.drawOverlay();
  }
  /** repaint the pending path into the cel (with the rubber band if any) */
  drawPathPreview(): void {
    const p = this.gesture.path;
    if (!p) return;
    const pts = p.cur ? [...p.pts, p.cur] : p.pts;
    p.st.drawPath(pts, p.smooth);
    const d = p.st.takeDirty();
    if (d) this.session.repaintRect(d);
    else this.session.repaint();
    this.drawOverlay();
  }
  pathDown(pp: { x: number; y: number }): void {
    const s = this.session;
    const tool = s.tool;
    if (s.layerLocked()) { s.paintBlockedNote(); return; }
    const tgt = this.pathTarget();
    if (this.gesture.path) {
      const p = this.gesture.path;
      // a different tool / layer / frame: finish what we have first
      if (p.st.kind !== tool || p.st.doc !== tgt.doc || p.st.li !== tgt.li || p.st.fi !== tgt.fi) this.endPath(true);
    }
    if (!this.gesture.path) {
      let st: Stroke;
      try {
        st = new Stroke(tgt.doc, tgt.li, tgt.fi, tool as never, s.brush(), s.layerLocked(), s.sym,
          s.shapeSides, s.shapeFill, s.symOx, s.symOy, s.symAng, s.symFour, s.prefs.bucketGlobal,
          s.brushShape, s.shapeFromCenter);
      } catch {
        s.paintBlockedNote();
        return;
      }
      st.snapColor = (c) => s.paletteSnap(c);
      this.wireRedirect(st, tgt);
      const tm = s.prefs.tileMode;
      st.wrapX = tm === "row" || tm === "grid";
      st.wrapY = tm === "col" || tm === "grid";
      st.startAt(pp.x, pp.y);
      this.gesture.path = { st, pts: [[pp.x, pp.y]], smooth: tool === "curve", cur: null };
      this.drawPathPreview();
      return;
    }
    const p = this.gesture.path;
    const last = p.pts[p.pts.length - 1];
    const prev = p.pts.length >= 2 ? p.pts[p.pts.length - 2] : null;
    if (last[0] === pp.x && last[1] === pp.y) { this.endPath(true); return; } // tap the last point = finish
    if (prev && prev[0] === pp.x && prev[1] === pp.y) {                        // tap the one before = remove it
      p.pts.pop();
      this.drawPathPreview();
      return;
    }
    p.pts.push([pp.x, pp.y]);
    this.drawPathPreview();
  }

  /** release: close the path and fill the enclosed region in one history step */
  endOutline(commit: boolean): void {
    const o = this.gesture.outline;
    this.gesture.outline = null;
    if (!o) return;
    const s = this.session;
    // the outline was collected for the layer it will fill: resolve it again so
    // a reference layer keeps writing into its source canvas
    const tgt = s.strokeTarget(s.curLayer());
    const doc = tgt ? tgt.doc : s.doc;
    // an empty layer has no cel yet: create it only when we are really filling
    const keep = commit && o.pts.length >= 3;
    let cel = doc.celAt(o.li, o.fi);
    if (keep && !cel) {
      doc.ensureCel(o.li, o.fi);
      cel = doc.celAt(o.li, o.fi);
    }
    if (!keep || !cel) {
      // nothing enclosed: drop a cel that was created for nothing
      if (!o.before && cel && !cel.hasAnyOpaque()) doc.cels.delete(doc.key(o.li, o.fi));
      this.drawOverlay();
      return;
    }
    // polygonCells closes the path implicitly (last → first point), so a
    // shape the user left open is closed automatically here.
    // A redirected (reference) fill works in the SOURCE canvas' coordinates:
    // the collected path and the symmetry axis are translated by the mirror
    // offset, and the mask follows this canvas' selection.
    const pts = o.dx || o.dy ? o.pts.map(([x, y]) => [x - o.dx, y - o.dy] as [number, number]) : o.pts;
    const ax: SymAxis = {
      on: s.sym !== "off", four: s.symFour,
      ox: s.symOx - o.dx, oy: s.symOy - o.dy, angDeg: s.symAng,
    };
    const holder = s.doc;
    const mask = holder.selectionActive()
      ? (x: number, y: number) => holder.selAt(x + o.dx, y + o.dy) === 1
      : null;
    const color = s.paletteSnap(s.color); // indexed mode: palette colour
    const tm = s.prefs.tileMode;
    const wrap = { x: tm === "row" || tm === "grid", y: tm === "col" || tm === "grid" };
    fillPolygon(cel, doc.w, doc.h, pts, color, mask, ax, wrap);
    const after = new Uint8ClampedArray(cel.data);
    // a fresh cel counts as changed; otherwise compare pixel by pixel
    const changed = o.before === null || after.some((v, i) => v !== o.before![i]);
    if (!changed) {
      if (!o.before && !cel.hasAnyOpaque()) doc.cels.delete(doc.key(o.li, o.fi));
      this.drawOverlay();
      return;
    }
    s.history.pushPixels("outline-fill", doc, [{ li: o.li, fi: o.fi, before: o.before, after }]);
    s.repaint();
    s.changedUI();
  }

  // ---- selection gestures ----
  /** begin dragging the existing selection's content (mask + grabbed pixels) */
  startSelMove(pp: { x: number; y: number }): boolean {
    const s = this.session;
    const doc = s.doc;
    if (!doc.sel || doc.sel.get(pp.x, pp.y) !== 1) return false;
    const li = s.curLayer(), fi = s.curFrame();
    const cel = doc.celAt(li, fi);
    if (!cel) return false;
    const mv = beginMove(doc, li, fi);
    const b = doc.sel.bounds();
    if (!mv || !b) return false;
    this.gesture.selDrag = {
      kind: "move", x0: pp.x, y0: pp.y, x1: pp.x, y1: pp.y,
      before: mv.before, b, moved: false, sx: pp.x, sy: pp.y, mv,
    };
    return true;
  }

  selDown(pp: { x: number; y: number }, pt: PxPoint, e: PointerEvent): void {
    const s = this.session;
    const doc = s.doc;
    const li = s.curLayer();
    const cel = doc.celAt(li, s.curFrame());
    const inside = doc.sel && doc.sel.get(pp.x, pp.y) === 1;
    const hasAlpha = inside && !!cel && cel.data[cel.idx(pp.x, pp.y) + 3] > 0;
    if (inside && hasAlpha) {
      const b = doc.sel!.bounds();
      if (b) {
        const mv = beginMove(doc, li, s.curFrame());
        this.gesture.selDrag = {
          kind: "move", x0: pp.x, y0: pp.y, x1: pp.x, y1: pp.y,
          before: new Uint8ClampedArray(cel.data),
          b, moved: false, sx: pp.x, sy: pp.y, mv,
        };
        return;
      }
    }
    if (e.shiftKey && inside) {
      const b = doc.sel!.bounds();
      if (b) {
        const mv = beginMove(doc, li, s.curFrame());
        this.gesture.selDrag = {
          kind: "move", x0: pp.x, y0: pp.y, x1: pp.x, y1: pp.y,
          before: cel ? new Uint8ClampedArray(cel.data) : null,
          b, moved: false, sx: pp.x, sy: pp.y, mv,
        };
        return;
      }
    }
    this.gesture.selDrag = { kind: "rect", x0: pp.x, y0: pp.y, x1: pp.x, y1: pp.y, before: null, b: { x: 0, y: 0, w: 0, h: 0 }, moved: false, sx: pp.x, sy: pp.y };
  }

  selMove(pp: { x: number; y: number }): void {
    const g = this.gesture.selDrag;
    if (!g) return;
    if (g.kind === "lasso") {
      if (!g.pts || g.pts.length === 0) { g.pts = [[pp.x, pp.y]]; g.sx = pp.x; g.sy = pp.y; return; }
      const lastp = g.pts[g.pts.length - 1];
      if (lastp[0] === pp.x && lastp[1] === pp.y) return;
      g.moved = true;
      // keep path contiguous via line cells
      lineCells(lastp[0], lastp[1], pp.x, pp.y, (x, y) => {
        const lp = g.pts![g.pts!.length - 1];
        if (lp[0] !== x || lp[1] !== y) {
          if (g.pts!.length < 4000) g.pts!.push([x, y]);
        }
      });
      this.drawOverlay(); // mask only: the composite is untouched
      this.startAnts();
      return;
    }
    if (g.kind === "rect") {
      if (pp.x !== g.x0 || pp.y !== g.y0) g.moved = true;
      g.x1 = pp.x;
      g.y1 = pp.y;
      selOps.setRect(this.session.doc, g.x0, g.y0, g.x1, g.y1);
      this.session.mirrorSelectionMask();
      this.drawOverlay(); // mask only: the composite is untouched
      this.startAnts();
      return;
    }
    // Aseprite-style floating move: the cel is never edited while dragging.
    // On the first real step the grabbed pixels are cut out of the layer and
    // float above it (drawn by drawOverlay); only the selection outline moves.
    // `frameOnly`（贴着边线的环带起拖）＝只搬选区边框，内容一动不动。
    const dx = pp.x - g.sx, dy = pp.y - g.sy;
    if (dx || dy) g.moved = true;
    if (g.frameOnly) {
      if (g.moved && g.mv) {
        g.dx = dx; g.dy = dy;
        selOps.shiftMask(this.session.doc, g.mv, dx, dy);
        this.drawOverlay();
      }
      return;
    }
    if (g.moved && g.mv) {
      const s = this.session;
      const firstCut = !g.cut;
      if (firstCut) { g.cut = true; selOps.floatCut(s.doc, s.curLayer(), s.curFrame(), g.mv); }
      g.dx = dx; g.dy = dy;
      selOps.shiftMask(s.doc, g.mv, dx, dy);
      // the cut changes pixels once; after that only the floating overlay moves
      if (firstCut) this.session.repaint();
      else this.drawOverlay();
    }
  }

  /**
   * 把浮动选区内容缓存成一张离屏画布：拖动时只做一次 drawImage。
   * （以前每帧都要对选区里的每个不透明像素来一次 fillRect —— 全画布选区
   *   一秒就是几十万次调用，这正是「跨画布拖动很卡」的原因。）
   * 环境不支持 ImageData 时返回 null，调用方回退到逐像素绘制。
   */
  private floatImage(doc: Doc, content: { w: number; h: number; data: Uint8ClampedArray }): HTMLCanvasElement | null {
    const key = doc.key(0, 0) + "|" + content.w + "x" + content.h + "|" + content.data.length + "|" + content.data[3] + "|" + content.data[content.data.length - 1];
    if (this.floatCv && this.floatKey === key) return this.floatCv;
    if (typeof ImageData === "undefined" || typeof document === "undefined") return null;
    try {
      const cv = document.createElement("canvas");
      cv.width = content.w;
      cv.height = content.h;
      const cx = cv.getContext("2d");
      if (!cx) return null;
      cx.putImageData(new ImageData(new Uint8ClampedArray(content.data), content.w, content.h), 0, 0);
      this.floatCv = cv;
      this.floatKey = key;
      return cv;
    } catch {
      return null;
    }
  }

  /**
   * Where a floating selection drag would land right now: the canvas under the
   * pointer (null when that is still the source canvas). Used for the LIVE
   * preview while dragging and for the drop itself, so both agree pixel for
   * pixel. `x`/`y` are the clip's top-left inside the target canvas.
   */
  private dropTargetOf(g: { mv: MoveState; dx?: number; dy?: number }): { index: number; x: number; y: number } | null {
    const s = this.session;
    const pt = this.gesture.lastPt;
    if (!pt) return null;
    const hit = screenToCanvas(this.spaceRects(), s.docIdx, this.ox, this.oy, this.zoom, pt.x, pt.y);
    if (!hit || hit.index === s.docIdx) return null;
    const srcE = s.docs[s.docIdx], dstE = s.docs[hit.index];
    if (!srcE || !dstE) return null;
    return {
      index: hit.index,
      x: g.mv.ox + (g.dx || 0) + srcE.x - dstE.x,
      y: g.mv.oy + (g.dy || 0) + srcE.y - dstE.y,
    };
  }

  /**
   * Finish a selection-move drag that ended on ANOTHER canvas: the grabbed
   * pixels are already cut out of the source layer, so the source only needs
   * its history step, and the floating content is stamped into the canvas under
   * the pointer (which becomes the focused one, keeping its own layer/frame).
   * The clip keeps its SCREEN position, so a drop lands where the eye sees it.
   * Works with a mouse and with touch, in both layout modes.
   *
   * @returns true when the drop was handled (the caller must skip endSelDrag)
   */
  dropSelDragToCanvas(sx: number, sy: number): boolean {
    const g = this.gesture.selDrag;
    if (!g || g.kind !== "move" || !g.mv || !g.cut || !g.moved) return false;
    const s = this.session;
    const hit = screenToCanvas(this.spaceRects(), s.docIdx, this.ox, this.oy, this.zoom, sx, sy);
    if (!hit || hit.index === s.docIdx) return false;
    const srcE = s.docs[s.docIdx];
    const dstE = s.docs[hit.index];
    if (!srcE || !dstE) return false;
    // the target keeps its own remembered layer / frame (what focusCanvas will
    // restore): a locked target aborts the whole move, pixels go back
    const dli = Math.max(0, Math.min(dstE.doc.layers.length - 1, dstE.li));
    if (dstE.doc.layers[dli]?.locked) {
      this.endSelDrag(false);
      s.note("目标画布的该图层已锁定", "That layer is locked in the target canvas");
      return true;
    }
    this.gesture.selDrag = null; // drops the floating overlay of the source canvas
    const li = s.curLayer(), fi = s.curFrame();
    const cel = s.doc.celAt(li, fi);
    // the source keeps the hole (floatCut already removed the pixels)
    if (cel) {
      let changed = false;
      const a = cel.data, b = g.mv.before;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { changed = true; break; }
      if (changed) {
        s.history.pushPixels("sel.move", s.doc, [
          { li, fi, before: g.mv.before, after: new Uint8ClampedArray(cel.data) },
        ]);
        // the source stops being the focused canvas right below, so its own
        // composite cache (keyed on pixelRev) has to be invalidated by hand
        s.doc.pixelRev++;
      }
    }
    // space position -> pixel inside the target canvas
    const at = {
      x: g.mv.ox + (g.dx || 0) + srcE.x - dstE.x,
      y: g.mv.oy + (g.dy || 0) + srcE.y - dstE.y,
    };
    s.focusCanvas(hit.index);
    const ok = floatDropInto(s.doc, s.curLayer(), s.curFrame(), g.mv, at.x, at.y, s.history, "sel.move");
    s.hapticTick("跨画布移动", 0.9);
    if (ok) {
      // 内容的合成缓存必须**立刻**重建：只 changed() 只会通知 React，
      // 蚂蚁线动画自己会把选区框画出来，像素层却还是旧缓存 —— 那就会出现
      // 「框在、内容空，点一下才出现」。
      s.repaintAll();
      s.changed();
    } else {
      s.repaint();
      s.changedUI();
    }
    this.drawOverlay();
    return true;
  }

  endSelDrag(commit = true): void {
    const g = this.gesture.selDrag;
    this.gesture.selDrag = null;
    const s = this.session;
    const doc = s.doc;
    if (!g) return;
    if (g.kind === "lasso") {
      if (g.moved && g.pts && g.pts.length >= 3) {
        const pts = g.pts;
        s.maskOp("sel.lasso", () => { lassoFill(doc, pts); s.mirrorSelectionMask(); });
      } else if (doc.sel) {
        doc.sel.clear();
        s.repaint();
        s.changedUI();
      }
      this.stopAnts();
      return;
    }
    if (g.kind === "rect") {
      if (!g.moved) {
        // a tap: tap on empty space clears selection
        if (doc.sel && doc.sel.hasAny() && g.x0 >= 0 && g.y0 >= 0 && doc.sel.get(g.x0, g.y0) !== 1) {
          selOps.clear(doc);
        } else if (doc.sel) {
          doc.sel.clear();
        }
        this.stopAnts();
      }
      this.session.repaint();
      this.session.changedUI();
      return;
    }
    // 只移动选区边框（贴着边线的环带起拖）：内容与图层一动不动，也没有历史
    if (g.frameOnly) {
      this.session.repaint();
      this.session.changedUI();
      return;
    }
    // floating move finish: drop pastes once; cancel puts everything back
    const li = s.curLayer(), fi = s.curFrame();
    const cel = doc.celAt(li, fi);
    if (g.mv && g.cut && cel) {
      if (commit && g.moved) {
        selOps.floatPaste(doc, li, fi, g.mv, g.dx || 0, g.dy || 0);
        let changed = false;
        const a = cel.data, b = g.mv.before;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { changed = true; break; }
        if (changed) {
          s.history.pushPixels("sel.move", doc, [
            { li, fi, before: g.mv.before, after: new Uint8ClampedArray(cel.data) },
          ]);
        }
      } else {
        selOps.restore(doc, li, fi, g.mv);
        selOps.shiftMask(doc, g.mv, 0, 0);
        s.repaint();
      }
    }
    this.session.repaint();
    this.session.changedUI();
  }

}
