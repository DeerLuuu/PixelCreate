// Interactive viewport: composite drawing, pan/zoom gestures, tool strokes.
import type { Doc } from "../engine/doc";
import type { RGBA, Rect} from "../engine/types";
import { clampRect, screenRectOf, unionRect, tileOffsets, tileRect, type TileMode } from "./rect";
import { Sel } from "../engine/doc";
import * as comp from "./compositor";
import { Stroke } from "../tools/stroke";
import { isSymTool, SYM_ANGLES } from "../tools/registry";
import type { SymAxis } from "../engine/symmetry";
import { lineCells, brushStamp, fillPolygon } from "../engine/paint";
import { selOps, lassoFill, beginMove, xformFloating, floatDropInto, type MoveState } from "../tools/select";
import type { Session } from "../app/session";
import type { GestureActionId } from "../app/gesture-ids";
import { clamp } from "../engine/types";
import { snapGapRect, type GapRect } from "../app/canvas-snap";
import { canvasAtScreen as spaceCanvasAt, screenToCanvas } from "../app/canvas-space";
import { wheelIntent } from "./wheel";
import { takeNotches, wheelNotches } from "../engine/scrub";
import { cursorAttr, cursorFor } from "./cursor";
import { isPc } from "../io/pcmode";
import { hexToRgba } from "../engine/color";

/** Is the composite canvas stale? `compRect === null` means "the whole canvas
 *  changed" (FX ops, selection edits, paste …) — the caller MUST rebuild it
 *  instead of blitting the old one. */
export function compositeIsStale(hasComposite: boolean, keySame: boolean, compRect: Rect | null): boolean {
  return !hasComposite || !keySame || !compRect;
}

interface PxPoint {
  x: number;
  y: number;
}

/** lock / unlock glyphs, matching the app's i-lock / i-unlock SVG symbols (24x24) */
const LOCK_D = "M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z";
const UNLOCK_D = "M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h2c0-1.66 1.34-3 3-3s3 1.34 3 3v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10z";

/** a finger must travel this far (screen px, any direction) from its own
 *  touchdown before it counts as "sliding"; two such fingers while >=4 are
 *  down = the all-frames preview gesture. Big enough to ignore the jitter of
 *  four fingers settling, small enough that any deliberate slide arms it. */
/** fallback when a caller has no session yet (never used in the app) */
const FOUR_MOVE_PX_DEFAULT = 15;
/** layer-switch flash duration in ms */
const FLASH_MS = 420;

/** Selection scale follows Aseprite's transform: free (non-integer) scale
 *  factor, anchored at the handle opposite the one being dragged, rasterised
 *  via affine inverse mapping with trunkating nearest-neighbour sampling. */

export class View {
  private host: HTMLElement;
  private pix: HTMLCanvasElement;
  private ov: HTMLCanvasElement;
  private session: Session;
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
    const d = this.dpr, w = this.host.clientWidth, h = this.host.clientHeight;
    if (this.rot === 90) ctx.setTransform(0, d, -d, 0, w * d, 0);
    else if (this.rot === 180) ctx.setTransform(-d, 0, 0, -d, w * d, h * d);
    else if (this.rot === 270) ctx.setTransform(0, -d, d, 0, 0, h * d);
    else ctx.setTransform(d, 0, 0, d, 0, 0);
  }
  /** surface (pointer / DOM) point -> logical point */
  toLogical(x: number, y: number): { x: number; y: number } {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (this.rot === 90) return { x: y, y: w - x };
    if (this.rot === 180) return { x: w - x, y: h - y };
    if (this.rot === 270) return { x: h - y, y: x };
    return { x, y };
  }
  /** logical point -> surface point (DOM overlays sit in surface space) */
  toSurface(x: number, y: number): { x: number; y: number } {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (this.rot === 90) return { x: w - y, y: x };
    if (this.rot === 180) return { x: w - x, y: h - y };
    if (this.rot === 270) return { x: y, y: h - x };
    return { x, y };
  }
  /** a surface drag delta expressed in space units (rotation aware) */
  surfaceDelta(dx: number, dy: number): { x: number; y: number } {
    const z = this.zoom;
    if (this.rot === 90) return { x: dy / z, y: -dx / z };
    if (this.rot === 180) return { x: -dx / z, y: -dy / z };
    if (this.rot === 270) return { x: -dy / z, y: dx / z };
    return { x: dx / z, y: dy / z };
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

  private composite: HTMLCanvasElement | null = null;
  private compKey = "";
  private compDirty = true;
  /** when compDirty: the stale region in doc space (null = the whole frame) */
  private compRect: Rect | null = null;
  /** the whole pix canvas has to be redrawn (view transform / viewport change) */
  private blitFull = true;
  /** pending animation frame of a coalesced repaint */
  private raf = 0;
  private composeCache = comp.newComposeCache();
  /** cached composites of the OTHER canvases in the space (index -> canvas) */
  private otherComps = new Map<number, { key: string; doc: Doc; cv: HTMLCanvasElement }>();
  /** identity + version of the selection the cached tint image belongs to */
  private selTintSel: unknown = null;
  private selTintVer = -1;
  /** view transform of the last blit (a change forces a full redraw) */
  private lastView = { ox: NaN, oy: NaN, zoom: NaN, w: 0, h: 0 };
  /** first layout handled: later resizes (orientation/panels) preserve pan+zoom */
  private firstFit = false;
  private cursor: { x: number; y: number; size: number } | null = null;
  /** pixel loupe (magnifier) shown only while picking a colour */
  private mag = false;
  private magCenter: PxPoint | null = null;
  private isoCache: HTMLCanvasElement | null = null;
  private isoKey = "";
  /** what the adjust gesture is currently holding (set while unlocked) */
  private symTarget: "mv" | "rot" | null = null;
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
  /** reuses the module-level checker pattern instead of making a new 2x2 canvas */
  private static checker: HTMLCanvasElement | null = null;
  /** read one composited pixel cheaply from the cached composite (no recompose) */
  samplePixel(x: number, y: number): [number, number, number, number] | null {
    const c = this.composite;
    if (!c) return null;
    if (x < 0 || y < 0 || x >= c.width || y >= c.height) return null;
    try {
      const d = c.getContext("2d")!.getImageData(x, y, 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    } catch {
      return null;
    }
  }

  private pointers = new Map<number, PxPoint>();
  private pinchBase: { mx: number; my: number; dist: number; ox: number; oy: number; zoom: number } | null = null;
  private stroke: Stroke | null = null;
  private panLast: PxPoint | null = null;
  /** PC 输入：空格键按住＝临时用另一个色槽（背景色）绘制 */
  private spaceDown = false;
  /** PC 输入：Alt 按住＝下一次单击取色（光标也变成吸管） */
  private altDown = false;
  /** PC 输入：中键拖动平移中 */
  private mousePan = false;
  /** PC 输入：这一笔用另一个颜色槽（右键绘制） */
  private altPaint = false;
  /** last logical pointer position (the cross-canvas drop preview needs it) */
  private lastPt: PxPoint | null = null;
  /** Ctrl+滚轮改笔刷大小的滚轮累计（一格 = 一步） */
  private wheelBrushAcc = 0;
  /** ⑦ 画布调整模式的拖动状态（ax/ay = 固定的那一侧） */
  private resizeDrag: {
    ax: -1 | 0 | 1; ay: -1 | 0 | 1;
    x0: number; y0: number; w0: number; h0: number;
    w: number; h: number; moved: boolean;
  } | null = null;
  /** 浮动选区内容的离屏缓存（拖动时一次 drawImage 代替逐像素 fillRect） */
  private floatCv: HTMLCanvasElement | null = null;
  private floatKey = "";
  private selDrag: { kind: "rect" | "move" | "lasso"; x0: number; y0: number; x1: number; y1: number; before: Uint8ClampedArray | null; b: { x: number; y: number; w: number; h: number }; moved: boolean; sx: number; sy: number; mv?: MoveState | null; pts?: [number, number][]; dx?: number; dy?: number; cut?: boolean } | null = null;
  private longT: number | null = null;
  /** freehand outline tool: collected path, filled with the current colour on release */
  private outline: { pts: Array<[number, number]>; li: number; fi: number; before: Uint8ClampedArray | null; dx: number; dy: number } | null = null;
  /** pending multi-point path (polyline / curve): tap adds a point, tapping
   *  the last point finishes, tapping the one before removes it */
  private path: { st: Stroke; pts: Array<[number, number]>; smooth: boolean; cur: [number, number] | null } | null = null;
  /** multi-finger long press (2 or 3 fingers held still): pending timer */
  private hold: { n: number; mid: { x: number; y: number }; starts: Map<number, { x: number; y: number }>; t: number } | null = null;
  /** set when a hold fired, so the following lifts cannot count as taps */
  private holdFired = false;
  /** the open stroke was redirected to a referenced canvas (no auto-select) */
  private strokeRedirected = false;
  /** airbrush: interval that keeps spraying while the finger is held down */
  private sprayT: number | null = null;
  /** fractional specks owed to the next spray tick */
  private sprayAcc = 0;
  /** layer-switch flash: layer index + start time, drawn in the overlay */
  private flash: { li: number; t0: number } | null = null;
  private flashRaf = 0;
  private pickAnchor: [number, number] | null = null;
  private pickMode = false;
  private pickLast: [number, number] | null = null;
  /** has the current stroke left its starting cell? (false = pure tap) */
  private gestureMoved = false;
  private gestureStartPx: PxPoint | null = null;
  /** the previous finished gesture was a no-move draw tap (dot) */
  private lastTapWasDraw = false;
  /** and that tap actually recorded a history step (so it can be rolled back) */
  private lastTapChanged = false;
  /** the gesture involved 2+ fingers (two-finger double-tap -> redo) */
  private gestureHadTwo = false;
  /** four-finger gesture tracking (opens the all-frames preview) */
  private fourSeen = false;
  /** each finger's screen position at its own touchdown. Whether a finger is
   *  "sliding" is measured from ITS own start, so fingers that land at
   *  different times — or lift mid-gesture — never skew the result. */
  private fourStart = new Map<number, { x: number; y: number }>();
  /** latched as soon as four fingers are down and at least two of them are
   *  sliding (each past FOUR_MOVE_PX in any direction): the preview fires on
   *  the last lift even if the hand slid back or stopped before lifting */
  private fourArmed = false;
  /** viewport state when the first finger landed. Restored the instant a
   *  four-finger contact is confirmed so jitter while fingers 2-4 land can
   *  never zoom/pan the canvas underneath the gesture. */
  private fourView0: { ox: number; oy: number; zoom: number } | null = null;
  /** invoked after a clean four-finger gesture (wired up by the app shell) */
  onFramePreview: (() => void) | null = null;
  /** invoked whenever the view transform changed (canvas title bars follow it) */
  onViewChanged: (() => void) | null = null;
  /** the pinch actually zoomed (else it was a two-finger tap) */
  private pinchZoomed = false;
  /** midpoint of a two-finger tap, for double-tap detection */
  private twoTapMid: PxPoint | null = null;
  private twoTap = 0;
  private twoTapPt: PxPoint | null = null;
  /** single-finger tap sequence counter (triple-tap on the doc = zoom) */
  private tapN = 0;
  private tapT = 0;
  private tapPt: PxPoint | null = null;
  /** rotate / scale gesture started on a selection frame handle */
  private xf: { mode: "rot" | "scale"; axis: "xy" | "x" | "y"; li: number; fi: number; st: MoveState; cx: number; cy: number; ax: number; ay: number; p0x: number; p0y: number; ang0: number; moved: boolean; cut?: boolean; buf?: Uint8ClampedArray; cells?: number[] } | null = null;

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
    if (!isPc() || this.pointers.size > 0) return;
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
    this.ox += dx;
    this.oy += dy;
    this.clampView();
    this.refresh(false);
  }

  /** 统一同步鼠标光标（工具 / 锁定 / 平移 / 取色） */
  private syncCursor(): void {
    const host = this.host as HTMLElement;
    const id = cursorFor({
      tool: this.session.tool,
      locked: this.session.layerLocked(),
      panning: this.mousePan,
      altPick: this.altDown,
      picking: this.pickMode,
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
      if (this.altDown === down) return;
      this.altDown = down;
      if (down) e.preventDefault();              // 别让浏览器把焦点抢到菜单栏
      if (this.pointers.size === 0) this.syncCursor();
      return;
    }
    if (e.code !== "Space" && e.key !== " ") return;
    if (typing) return;
    if (down && t && t.tagName === "BUTTON") return;   // 空格仍然激活聚焦的按钮
    if (this.spaceDown === down) return;
    this.spaceDown = down;
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
    this.composite = null;
    this.compKey = "";
    this.composeCache.ghosts.clear();
    this.otherComps.clear();
  }
  setFrame(fi: number): void {
    void fi;
    this.composite = null;
    this.compKey = "";
    this.composeCache.ghosts.clear();
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
    const doc = this.session.doc;
    const aw = Math.max(24, this.vpW() - 20);
    const ah = Math.max(24, this.vpH() - 20);
    let z = Math.min(aw / doc.w, ah / doc.h);
    const zi = Math.floor(z);
    if (zi >= 1 && Math.abs(z - zi) < 0.18) z = zi;
    z = clamp(z, this.session.prefs.zoomMin, this.session.prefs.zoomMax);
    return {
      zoom: z,
      ox: (this.vpW() - doc.w * z) / 2,
      oy: (this.vpH() - doc.h * z) / 2,
    };
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
    const doc = this.session.doc;
    const aw = Math.max(24, this.vpW() - 20);
    const ah = Math.max(24, this.vpH() - 20);
    let z = Math.min(aw / doc.w, ah / doc.h);
    const zi = Math.floor(z);
    if (zi >= 1 && Math.abs(z - zi) < 0.18) z = zi;
    this.zoom = clamp(z, this.session.prefs.zoomMin, this.session.prefs.zoomMax);
    this.ox = (this.vpW() - doc.w * this.zoom) / 2;
    this.oy = (this.vpH() - doc.h * this.zoom) / 2;
  }

  /** Keep the canvas in view: stop panning when a canvas edge reaches the
   *  viewport edge, so the artwork can never be dragged off-screen. */
  private clampView(): void {
    const s = this.session;
    const w = this.vpW(), h = this.vpH();
    if (s.docs.length > 1) {
      // infinite space: keep a slice of the canvas bounding box on screen so
      // the artwork can never be panned away forever
      const focus = s.docs[s.docIdx];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const e of s.docs) {
        const rx = (e.x - focus.x) * this.zoom, ry = (e.y - focus.y) * this.zoom;
        x0 = Math.min(x0, rx); y0 = Math.min(y0, ry);
        x1 = Math.max(x1, rx + e.doc.w * this.zoom); y1 = Math.max(y1, ry + e.doc.h * this.zoom);
      }
      const M = 60;
      this.ox = clamp(this.ox, M - x1, w - M - x0);
      this.oy = clamp(this.oy, M - y1, h - M - y0);
      return;
    }
    const doc = s.doc;
    const dw = doc.w * this.zoom, dh = doc.h * this.zoom;
    this.ox = dw >= w ? clamp(this.ox, w - dw, 0) : clamp(this.ox, 0, Math.max(0, w - dw));
    this.oy = dh >= h ? clamp(this.oy, h - dh, 0) : clamp(this.oy, 0, Math.max(0, h - dh));
  }

  zoomAt(z: number, cx?: number, cy?: number): void {
    const vpW = this.vpW(), vpH = this.vpH();
    const mx = cx === undefined ? vpW / 2 : cx;
    const my = cy === undefined ? vpH / 2 : cy;
    z = clamp(z, this.session.prefs.zoomMin, this.session.prefs.zoomMax);
    const k = z / this.zoom;
    this.ox = mx - (mx - this.ox) * k;
    this.oy = my - (my - this.oy) * k;
    this.zoom = z;
    this.clampView();
    this.refresh(false);
  }

  screenToPixel(sx: number, sy: number): { x: number; y: number } {
    return { x: Math.floor((sx - this.ox) / this.zoom), y: Math.floor((sy - this.oy) / this.zoom) };
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

  // ---------------------------------------------------------------- render
  /** Mark the composite stale. `rect` (doc space) limits the work to the region
   *  a live stroke touched; omit it for a full rebuild + full redraw. */
  markDirty(rect?: Rect | null): void {
    if (!rect) {
      this.compDirty = true;
      this.compRect = null;
      this.blitFull = true;
      return;
    }
    if (!this.compDirty) {
      this.compDirty = true;
      this.compRect = rect;
      return;
    }
    if (this.compRect) this.compRect = unionRect(this.compRect, rect);
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
  private repaintStroke(): void {
    const st = this.stroke;
    if (!st) return;
    const d = st.takeDirty();
    if (!d) return;
    // a redirected stroke painted into ANOTHER canvas: mirror it into the
    // reference layer's own cel and repaint the whole canvas (the dirty rect
    // lives in the other document's coordinates, so it cannot be mapped)
    if (this.strokeRedirected) this.session.repaint();
    else this.session.repaintRect(d);
  }

  /** commit a still-open gesture (e.g. bucket fill whose pointerup was lost) as its own history step */
  flushStroke(): boolean {
    if (this.path) this.endPath(true);
    if (!this.stroke) return false;
    this.stopSpray();
    const rec = this.stroke.commit(this.session.history, this.labelFor(this.stroke.kind));
    this.stroke = null;
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
    const need = force || this.compDirty;
    if (!need && !this.blitFull) {
      // nothing changed on the pixel canvas (e.g. only the overlay moved)
      this.drawOverlay(false);
      return;
    }
    const tileMode = s.prefs.tileMode as TileMode;
    const tile = tileMode !== "off";
    let region: Rect | null = null;
    if (need) {
      const full = this.buildComposite(force);
      if (!full && !this.blitFull && this.compRect) {
        let u = screenRectOf(this.compRect, this.ox, this.oy, this.zoom);
        if (tile) {
          // the same pixels show up in the 8 neighbour copies: their screen
          // rects have to be repainted as well
          for (const [dx, dy] of tileOffsets(tileMode)) {
            if (dx === 0 && dy === 0) continue;
            u = unionRect(u, screenRectOf(tileRect(this.compRect, doc.w, doc.h, dx, dy), this.ox, this.oy, this.zoom))!;
          }
        }
        region = clampRect(u, vw, vh);
      }
      this.compDirty = false;
      this.compRect = null;
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
    let chkPat: CanvasPattern | null = null;
    if (!doc.bg) {
      let chk = View.checker;
      if (!chk) {
        chk = document.createElement("canvas");
        chk.width = 2; chk.height = 2;
        const cc = chk.getContext("2d")!;
        cc.fillStyle = "#9aa0b0"; cc.fillRect(0, 0, 1, 1);
        cc.fillStyle = "#b9bec9"; cc.fillRect(1, 0, 1, 1);
        cc.fillStyle = "#b9bec9"; cc.fillRect(0, 1, 1, 1);
        cc.fillStyle = "#9aa0b0"; cc.fillRect(1, 1, 1, 1);
        View.checker = chk;
      }
      chkPat = ctx.createPattern(chk, "repeat");
    }
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
      if (!this.composite) return;
      if (dx === 0 && dy === 0) {
        ctx.drawImage(this.composite, tx, ty, wpx, hpx);
        return;
      }
      // neighbour copy: a plain translation (no mirroring)
      ctx.drawImage(this.composite, tx, ty, wpx, hpx);
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
    this.drawOverlay(need);
    if (this.onViewChanged) this.onViewChanged();
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
        const chk = this.checkerPattern(ctx);
        if (chk) {
          ctx.save();
          ctx.fillStyle = chk;
          ctx.translate(sx, sy);
          ctx.scale(z, z);
          ctx.fillRect(0, 0, e.doc.w, e.doc.h);
          ctx.restore();
        }
      }
      const cv = this.otherComposite(i, e.doc, e.fi);
      if (cv) ctx.drawImage(cv, sx, sy, w, h);
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(255,255,255,.22)";
      ctx.strokeRect(sx - 0.5, sy - 0.5, w + 1, h + 1);
      ctx.restore();
    }
  }
  /** composite of a non-focused canvas, cached until its config changes */
  private otherComposite(i: number, doc: Doc, fi: number): HTMLCanvasElement | null {
    // pixelRev is part of the key: another canvas may have changed without its
    // own layer configuration changing (a reference layer being painted, etc.)
    const key = doc.w + "x" + doc.h + "|" + fi + "|" + doc.pixelRev + "|" + doc.layers.map((l) => (l.visible ? 1 : 0) + ":" + l.opacity + ":" + l.blend + ":" + (l.ref ?? "") + (doc.bg ? "B" : "T")).join();
    const got = this.otherComps.get(i);
    if (got && got.key === key && got.doc === doc) return got.cv;
    const cv = comp.composeFrame(doc, fi);
    this.otherComps.set(i, { key, doc, cv });
    return cv;
  }
  /** the 2x2 transparency checker, reused as a canvas pattern */
  private checkerPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
    let chk = View.checker;
    if (!chk) {
      chk = document.createElement("canvas");
      chk.width = 2; chk.height = 2;
      const cc = chk.getContext("2d")!;
      cc.fillStyle = "#9aa0b0"; cc.fillRect(0, 0, 1, 1);
      cc.fillStyle = "#b9bec9"; cc.fillRect(1, 0, 1, 1);
      cc.fillStyle = "#b9bec9"; cc.fillRect(0, 1, 1, 1);
      cc.fillStyle = "#9aa0b0"; cc.fillRect(1, 1, 1, 1);
      View.checker = chk;
    }
    return ctx.createPattern(chk, "repeat");
  }

  /** returns true when the whole composite had to be rebuilt */
  private buildComposite(force: boolean): boolean {
    const s = this.session;
    const doc = s.doc;
    const fi = s.curFrame();
    const p = s.prefs;
    const onionKey = p.onionOn ? "1:" + p.onionBefore + ":" + p.onionAfter + ":" + p.onionAlpha + ":" + (p.onionTint ? 1 : 0) + ":" + (p.onionWrap ? 1 : 0) : "0";
    const key = doc.w + "x" + doc.h + "|" + fi + "|" + doc.layers.map((l) => (l.visible ? 1 : 0) + ":" + l.opacity + ":" + l.blend + ":" + (l.ref ?? "") + (doc.bg ? "B" : "T")).join() + "|on" + onionKey;
    const onion = {
      before: p.onionOn ? p.onionBefore : 0,
      after: p.onionOn ? p.onionAfter : 0,
      alpha: p.onionAlpha / 100,
      tint: p.onionTint,
      wrap: p.onionWrap,
    };
    // A partial update is only valid when the composite exists, the frame /
    // layer config is unchanged AND the dirty region is known (compRect).
    // Anything else — including a full dirty (compRect === null) — must really
    // rebuild: returning "full" while keeping the old canvas made the view blit
    // stale pixels (FX / selection edits looked delayed, the preview box was
    // correct because it always composites from the doc).
    if (!force && !compositeIsStale(!!this.composite, this.compKey === key, this.compRect)) {
      comp.composeRectInto(doc, fi, onion, this.compRect!, this.composite!, this.composeCache);
      return false;
    }
    this.compKey = key;
    this.composeCache.ghosts.clear(); // frame or layer config changed
    this.composite = comp.composeFrameWithOnion(doc, fi, onion, this.composeCache);
    return true;
  }

  private drawOverlay(rebuildTint = false): void {
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
    const lasso = this.selDrag;
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
    // ⑦ 画布调整模式：四条边 + 四个角的把手，拖动时显示新尺寸
    if (this.session.resizeModeOn) {
      const doc = this.session.doc;
      const g = this.resizeDrag;
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
    this.drawSelTransform();
    this.drawFlash(ctx);
    this.drawOutlinePreview(ctx);
    this.drawGradPreview(ctx);
    // floating selection content: pixels held above the layer during a drag
    const fg = this.selDrag;
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
    const xfg = this.xf;
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
    this.drawSymGuides(ctx);
    // footprint marker: pencil/eraser show the exact Aseprite circle-brush
    // outline (transparent centre); other drawing tools keep the square bounds
    const cu = this.cursor;
    if (cu) {
      const tool = this.session.tool;
      if (tool === "pencil" || tool === "eraser") {
        const st = brushStamp(cu.size);
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
    if (!this.mag || !this.magCenter) return;
    const doc = this.session.doc;
    const CELL = Math.max(8, Math.round(this.session.prefs.magZoom));
    const L = 132;
    const half = Math.floor(L / CELL / 2);
    const cx = this.magCenter.x, cy = this.magCenter.y;
    const sx0 = Math.round(cx - half), sy0 = Math.round(cy - half);
    // fixed at the bottom-left corner of the viewport
    const x = 10, y = this.vpH() - L - 10;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#1d2129";
    ctx.fillRect(x - 2, y - 2, L + 4, L + 4);
    ctx.fillStyle = "#2a2f3d";
    ctx.fillRect(x, y, L, L);
    const comp = this.composite;
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
  private symLockBtn(): [number, number] | null {
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
  private symHit(pt: PxPoint): "mv" | "rot" | null {
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
        // tolerant: a group snapped with an older gap still shows its gap
        const g = snapGapRect(
          { x: a.x, y: a.y, w: a.doc.w, h: a.doc.h },
          { x: b.x, y: b.y, w: b.doc.w, h: b.doc.h },
          gapPx, 8);
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
        const g = a && b ? snapGapRect({ x: a.x, y: a.y, w: a.doc.w, h: a.doc.h }, { x: b.x, y: b.y, w: b.doc.w, h: b.doc.h }, gapPx, 8) : null;
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
    const st = this.stroke;
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
    const o = this.outline;
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
      if (this.pointers.size === 0) {
        this.cursor = null;
        this.drawOverlay();
      }
    });
    // ---- PC（鼠标 / 触控板）：滚轮缩放、Shift 横向、Alt 纵向平移
    host.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    window.addEventListener("keydown", this.onSpaceKey);
    window.addEventListener("keyup", this.onSpaceKey);
  }

  private evPt(e: PointerEvent): PxPoint {
    const r = this.host.getBoundingClientRect();
    return this.toLogical(e.clientX - r.left, e.clientY - r.top);
  }


  // ----- long-press eyedropper mode (0.3s stationary inside one pixel) -----
  private cancelPickTimer(): void {
    if (this.longT !== null) {
      window.clearTimeout(this.longT);
      this.longT = null;
    }
    this.pickAnchor = null;
  }
  private cancelHold(): void {
    if (this.hold) {
      window.clearTimeout(this.hold.t);
      this.hold = null;
    }
  }
  /** true when any finger of the pending hold moved past the jitter threshold */
  private holdMoved(): boolean {
    const h = this.hold;
    if (!h) return false;
    const tol = Math.max(8, this.session.prefs.fourFingerPx || FOUR_MOVE_PX_DEFAULT);
    for (const [pid, p] of this.pointers) {
      const st = h.starts.get(pid);
      if (st && Math.hypot(p.x - st.x, p.y - st.y) > tol) return true;
    }
    return false;
  }
  /** arm the n-finger long press (the action is read when it fires) */
  private armHold(n: number, action: GestureActionId, tag: string): void {
    this.cancelHold();
    if (this.pointers.size !== n) return;
    const pts = [...this.pointers.entries()];
    let mx = 0, my = 0;
    const starts = new Map<number, { x: number; y: number }>();
    for (const [pid, p] of pts) {
      mx += p.x; my += p.y;
      starts.set(pid, { x: p.x, y: p.y });
    }
    this.holdFired = false;
    const t = window.setTimeout(() => {
      const h = this.hold;
      if (!h) return;
      this.hold = null;
      // every finger still down, and nobody slid in the meantime
      if (this.pointers.size !== h.n || this.pinchZoomed) return;
      this.holdFired = true;
      this.session.hapticTick(tag);
      this.session.runGestureAction(action, { x: h.mid.x, y: h.mid.y });
    }, this.session.prefs.longPressMs);
    this.hold = { n, mid: { x: mx / n, y: my / n }, starts, t };
  }

  private samplePickCell(x: number, y: number, strong: boolean): void {
    const c = this.session.sampleComposite(x, y);
    if (c) {
      const changed = this.pickLast == null || this.pickLast[0] !== x || this.pickLast[1] !== y;
      if (changed) {
        this.session.setFgColor(c);
        this.session.hapticTick("取色", strong ? 1.2 : 0.5);
        this.session.repaint();
      }
    }
    this.pickLast = [x, y];
  }
  private enterPickMode(x: number, y: number): void {
    this.pickMode = true;
    this.pickLast = null;
    this.pickAnchor = null;
    // drop any in-progress stroke / pan / selection drag
    if (this.stroke) {
      this.stroke.cancel();
      this.stroke = null;
    }
    this.panLast = null;
    this.selDrag = null;
    this.samplePickCell(x, y, true);
  }

  /** ⑦ 画布调整模式：命中哪条边/哪个角（返回固定的那一侧 ax/ay，null = 没命中） */
  private resizeHit(pt: PxPoint): { ax: -1 | 0 | 1; ay: -1 | 0 | 1 } | null {
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

  private onDown(e: PointerEvent): void {
    e.preventDefault();
    this.lastPt = this.evPt(e);
    try {
      this.host.setPointerCapture && this.host.setPointerCapture(e.pointerId);
    } catch { /* ignore */ }
    const pt = this.evPt(e);
    // ---- PC 鼠标：中键＝聚焦适配，右键 / 空格+左键＝用另一个色槽绘制
    this.altPaint = false;
    if (e.pointerType === "mouse") {
      // 中键：等价于触屏的双击画布（聚焦并适配），不再用于平移
      if (e.button === 1) {
        const hitIdx = this.canvasAtScreen(pt.x, pt.y);
        if (hitIdx >= 0) {
          if (hitIdx !== this.session.docIdx) this.session.focusCanvas(hitIdx);
          this.session.fitCanvas();
          this.session.hapticTick("聚焦", 0.7);
        }
        return;
      }
      this.mousePan = false;
      // 右键，或按住空格＋左键：用另一个色槽（默认背景色）绘制
      this.altPaint = e.button === 2 || (e.button === 0 && this.spaceDown);
      if (e.button === 2 || this.altPaint) this.pointers.set(e.pointerId, pt);
    }
    this.pointers.set(e.pointerId, pt);
    // remember each finger's touchdown point — a finger counts as "sliding"
    // from its OWN start — and freeze the view state as soon as the first
    // finger lands so a confirmed 4-finger gesture can restore it
    if (!this.fourStart.has(e.pointerId)) this.fourStart.set(e.pointerId, { x: pt.x, y: pt.y });
    if (this.pointers.size === 1) this.fourView0 = { ox: this.ox, oy: this.oy, zoom: this.zoom };
    this.cancelPickTimer();
    this.pickMode = false;
    if (this.pointers.size >= 4) {
      // a four-finger gesture is never a two-finger tap sequence. Reset any
      // pinch/pan state built up while fingers 2-4 were landing: setup jitter
      // must never latch pinchZoomed (it would silently block the preview).
      this.fourSeen = true;
      this.fourArmed = false;
      this.cancelHold();
      this.pinchBase = null;
      this.pinchZoomed = false;
      this.gestureHadTwo = false;
      this.twoTap = 0;
      this.twoTapPt = null;
      this.twoTapMid = null;
      this.panLast = null;
      if (this.outline) this.endOutline(false);
      this.stopSpray();
      if (this.stroke) { this.stroke.cancel(); this.stroke = null; }
      if (this.selDrag) {
        if (this.selDrag.kind === "move" && this.selDrag.cut) this.endSelDrag(false);
        else this.selDrag = null;
      }
      this.gestureMoved = false;
      // undo any zoom/pan the first fingers caused while landing: from the
      // 4th finger down the canvas must stay perfectly still mid-swipe
      if (this.fourView0 &&
        (this.fourView0.ox !== this.ox || this.fourView0.oy !== this.oy || this.fourView0.zoom !== this.zoom)) {
        this.ox = this.fourView0.ox;
        this.oy = this.fourView0.oy;
        this.zoom = this.fourView0.zoom;
        this.clampView();
        this.refresh(false);
      }
      return;
    }
    // a third contact is no longer a two-finger pinch: in practice it means
    // the hand is going for the 4-finger swipe, so anything the first two
    // fingers started is dropped and the gesture waits quietly for the 4th
    if (this.pointers.size >= 3) {
      if (this.outline) this.endOutline(false);
      this.stopSpray();
      if (this.stroke) { this.stroke.cancel(); this.stroke = null; }
      if (this.selDrag) {
        if (this.selDrag.kind === "move" && this.selDrag.cut) this.endSelDrag(false);
        else this.selDrag = null;
      }
      this.panLast = null;
      this.gestureMoved = false;
      this.cancelHold();
      this.pinchBase = null;
      this.pinchZoomed = false;
      this.gestureHadTwo = false;
      this.twoTap = 0;
      this.twoTapPt = null;
      this.twoTapMid = null;
      // three fingers held still = three-finger long press (no system conflict)
      this.armHold(3, this.session.prefs.gThreeFingerLongPress, "三指长按");
      return;
    }
    if (this.pointers.size >= 2) {
      if (this.outline) this.endOutline(false); // 2nd finger = navigation, not a fill
      this.stopSpray();
      if (this.stroke) {
        // a second contact means navigation (pinch / multi-finger gesture),
        // never drawing: roll the half-drawn stroke back entirely instead of
        // committing it, or every pinch / 4-finger swipe would leave the
        // stroke started by the first finger behind as stray pixels
        this.stroke.cancel();
        this.session.repaint();
        this.stroke = null;
        this.gestureMoved = false;
      }
      if (this.xf) this.endXf();
      const [a, b] = [...this.pointers.values()];
      this.pinchBase = {
        mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2,
        dist: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
        ox: this.ox, oy: this.oy, zoom: this.zoom,
      };
      this.gestureHadTwo = true;
      this.pinchZoomed = false;
      this.twoTapMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      // two fingers held still = two-finger long press (some phones map this
      // to the system screen-recognition gesture — 三指长按 is the alternative)
      this.armHold(2, this.session.prefs.gTwoFingerLongPress, "双指长按");
      return;
    }
    // flush an unfinished gesture left by a lost pointerup (e.g. rapid bucket taps)
    if (this.stroke) {
      const rec = this.stroke.commit(this.session.history, this.labelFor(this.stroke.kind));
      this.stroke = null;
      this.session.repaint();
      if (rec) this.session.changedUI();
    }
    // symmetry axis (brush tools): the lock button is always tappable, and
    // while unlocked the dashed line/knob are directly draggable
    if (this.session.sym !== "off" && isSymTool(this.session.tool)) {
      const lb = this.symLockBtn();
      if (lb && Math.hypot(pt.x - lb[0], pt.y - lb[1]) <= 24) {
        this.session.setSymLocked(!this.session.symLocked);
        return;
      }
      if (!this.session.symLocked) {
        const t = this.symHit(pt);
        if (t) {
          this.cursor = null;
          this.symTarget = t;
          this.drawOverlay();
          return;
        }
      }
      // unlocked but off the line, or locked: painting / panning proceed normally
    }
    const s = this.session;
    const tool = s.tool;
    const pp = this.screenToPixel(pt.x, pt.y);
    const doc = s.doc;
    // 点画布＝Delete 键重新作用于选区内容（而不是上次点的标题 / 图层 / 帧）
    s.setDelTarget("selection");
    // 「编辑界面」模式：画布完全不接受操作（拖动排序时不会误画）
    if (s.uiEdit) return;
    // ⑦ 画布调整模式：按下即接管，拖动四条边/四个角改尺寸（不绘制、不选择）
    if (s.resizeModeOn) {
      const hit = this.resizeHit(pt);
      if (hit) {
        this.resizeDrag = {
          ...hit, x0: pt.x, y0: pt.y,
          w0: doc.w, h0: doc.h, w: doc.w, h: doc.h, moved: false,
        };
      }
      return;
    }
    // Alt+单击：快速取色（与触屏长按取色等价，PC 上更顺手）
    if (e.altKey && e.pointerType === "mouse" && e.button === 0) {
      const c = s.sampleComposite(pp.x, pp.y);
      if (c) { s.setFgColor(c); s.hapticTick("取色", 0.8); s.repaint(); }
      return;
    }
    // ① 选区类工具（框选 / 套索 / 魔棒 / 轮廓填充）在画布外的空白处按下＝平移视图，
    //    与画笔工具一致：不用先切工具就能拖着看画布
    const outsideDoc = pp.x < 0 || pp.y < 0 || pp.x >= doc.w || pp.y >= doc.h;
    const blankPan = isPc() && e.pointerType === "mouse" &&
      (tool === "select" || tool === "lasso" || tool === "wand" || tool === "outline");
    if (blankPan && outsideDoc) {
      this.panLast = pt;
      this.gestureMoved = false;
      this.syncCursor();
      return;
    }
    if (tool === "outline") {
      this.outlineDown(pp);
      return;
    }
    const selOn = !!doc.sel && doc.sel.hasAny();
    // long-press eyedropper: disabled while a selection is shown or a selection
    // tool is active (holds there mean marquee/transform, not colour picking)
    const pickAllowed = !selOn && tool !== "select" && tool !== "lasso" && tool !== "wand";
    const longAction = this.session.prefs.gLongPress;
    const longWantsDoc = longAction === "pickColor" || longAction === "zoomIn" || longAction === "zoomOut";
    if (!isPc() && (!longWantsDoc || pickAllowed) && pp.x >= 0 && pp.y >= 0 && pp.x < doc.w && pp.y < doc.h) {
      this.pickAnchor = [pp.x, pp.y];
      this.longT = window.setTimeout(() => {
        this.longT = null;
        if (longAction === "pickColor") this.enterPickMode(pp.x, pp.y);
        else if (longAction !== "none") this.session.runGestureAction(longAction, { x: pt.x, y: pt.y });
      }, this.session.prefs.longPressMs);
    }
    // grab a transform handle (rotate / scale) of an existing selection frame
    if (selOn && this.tryStartXf(pt)) return;
    // pressing inside an existing selection moves its content directly;
    // it never restarts a marquee / reselects (empty area still does)
    if (selOn && (tool === "select" || tool === "lasso" || tool === "wand") && this.startSelMove(pp)) return;
    if (tool === "select") {
      this.selDown(pp, pt, e);
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
      this.mag = this.session.prefs.loupe;
      this.magCenter = { x: pp.x, y: pp.y };
      const c = s.sampleComposite(pp.x, pp.y);
      if (c) s.setFgColor(c);
      this.drawOverlay();
      return;
    }
    if (tool === "wand") {
      s.wandAt(pp.x, pp.y);
      return;
    }
    this.gestureMoved = false;
    this.gestureStartPx = pp;
    if (this.isPathTool(tool)) {
      this.pathDown(pp);
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
      this.wireRedirect(this.stroke, tgt);
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
      this.startSpray();
    }
    this.stroke.startAt(pp.x, pp.y);
    this.repaintStroke();
  }

  private onMove(e: PointerEvent): void {
    const pt = this.evPt(e);
    this.lastPt = pt;
    const wasDown = this.pointers.has(e.pointerId);
    if (wasDown) this.pointers.set(e.pointerId, pt);
    // ⑦ 画布调整模式拖动中：换算成画布像素后预览新尺寸
    if (this.resizeDrag) {
      const g = this.resizeDrag;
      const z = Math.max(0.01, this.zoom);
      const dx = (pt.x - g.x0) / z, dy = (pt.y - g.y0) / z;
      const nw = Math.max(1, Math.min(1024, Math.round(g.w0 + (g.ax === 1 ? -dx : g.ax === -1 ? dx : 0))));
      const nh = Math.max(1, Math.min(1024, Math.round(g.h0 + (g.ay === 1 ? -dy : g.ay === -1 ? dy : 0))));
      if (nw !== g.w || nh !== g.h) { g.w = nw; g.h = nh; g.moved = true; }
      this.drawOverlay();
      return;
    }
    // Alt 按住＝取色模式：光标跟着换成吸管（鼠标没有别的提示手段）
    if (e.pointerType === "mouse" && this.altDown !== e.altKey) {
      this.altDown = e.altKey;
      this.syncCursor();
    }
    // a pending multi-finger long press dies the moment a finger slides
    if (this.hold && this.holdMoved()) this.cancelHold();
    // auto-pan the viewport while a draw/transform/selection drag nears the edge.
    // Speed scales with how deep into the edge zone the pointer is, but is capped
    // per event so the scroll stays slow, smooth and controllable.
    if (this.session.prefs.autoPan && wasDown && this.pointers.size === 1 && (this.stroke || this.xf || this.selDrag)) {
      const M = this.session.prefs.autoPanMargin, w = this.vpW(), h = this.vpH();
      const MAX = this.session.prefs.autoPanSpeed; // px per event, 1..6
      const SPEED = 0.28 * (MAX / 3);
      let panx = 0, pany = 0;
      if (pt.x < M) panx = (pt.x - M) * SPEED; else if (pt.x > w - M) panx = (pt.x - (w - M)) * SPEED;
      if (pt.y < M) pany = (pt.y - M) * SPEED; else if (pt.y > h - M) pany = (pt.y - (h - M)) * SPEED;
      panx = clamp(panx, -MAX, MAX);
      pany = clamp(pany, -MAX, MAX);
      if (panx || pany) { this.ox -= panx; this.oy -= pany; this.clampView(); }
    }
    const ppx = this.screenToPixel(pt.x, pt.y);
    // pending pick: cancels only when the finger moves to another pixel cell
    if (wasDown && this.longT !== null && this.pickAnchor) {
      if (ppx.x !== this.pickAnchor[0] || ppx.y !== this.pickAnchor[1]) this.cancelPickTimer();
    }
    // pick mode: sample whatever cell the finger is over until release
    if (this.pickMode && wasDown && this.pointers.size === 1) {
      this.mag = this.session.prefs.loupe;
      this.magCenter = { x: ppx.x, y: ppx.y };
      this.samplePickCell(ppx.x, ppx.y, false);
      this.drawOverlay();
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
      let moving = 0;
      for (const [pid, p] of this.pointers) {
        const s = this.fourStart.get(pid);
        if (s && Math.hypot(p.x - s.x, p.y - s.y) > (this.session.prefs.fourFingerPx || FOUR_MOVE_PX_DEFAULT)) moving++;
      }
      if (moving >= 2) this.fourArmed = true;
      return;
    }
    // pinch
    if (this.pointers.size >= 2 && this.pinchBase) {
      const [a, b] = [...this.pointers.values()];
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const dist = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
      // (a pending multi-finger long press was already cancelled in onMove)

      const k = dist / this.pinchBase.dist;
      const z = clamp(this.pinchBase.zoom * k, this.session.prefs.zoomMin, this.session.prefs.zoomMax);
      const sc = z / this.pinchBase.zoom;
      this.ox = mx - (this.pinchBase.mx - this.pinchBase.ox) * sc;
      this.oy = my - (this.pinchBase.my - this.pinchBase.oy) * sc;
      this.zoom = z;
      if (Math.abs(z - this.pinchBase.zoom) > 0.001) this.pinchZoomed = true;
      this.refresh(false);
      return;
    }
    // axis-adjust drag: translate the axis (grab the line) or rotate it (grab the knob)
    if (this.symTarget) {
      const doc = this.session.doc;
      const s = this.session;
      if (this.symTarget === "rot") {
        const cx = this.ox + (doc.w / 2 + s.symOx) * this.zoom;
        const cy = this.oy + (doc.h / 2 + s.symOy) * this.zoom;
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
        const vx0 = Math.min(-this.ox, this.vpW() - this.ox) / this.zoom;
        const vx1 = Math.max(-this.ox, this.vpW() - this.ox) / this.zoom;
        const vy0 = Math.min(-this.oy, this.vpH() - this.oy) / this.zoom;
        const vy1 = Math.max(-this.oy, this.vpH() - this.oy) / this.zoom;
        const pxa = Math.round(clamp((pt.x - this.ox) / this.zoom, vx0, vx1) * 2) / 2;
        const pya = Math.round(clamp((pt.y - this.oy) / this.zoom, vy0, vy1) * 2) / 2;
        s.symOx = pxa - doc.w / 2;
        s.symOy = pya - doc.h / 2;
        s.symTweaked = true;
        s.rememberSym();
      }
      this.drawOverlay();
      return;
    }
    if (this.panLast) {
      this.ox += pt.x - this.panLast.x;
      this.oy += pt.y - this.panLast.y;
      this.clampView();
      this.panLast = pt;
      this.refresh(false);
      if (this.mousePan) { this.mousePan = false; this.panLast = null; this.syncCursor(); }
      return;
    }
    if (this.xf) {
      this.xfMove(pt);
      return;
    }
    if (this.path) {
      // rubber band from the last committed point to the finger
      if (wasDown && this.pointers.size === 1) {
        const p = this.path;
        if (!p.cur || p.cur[0] !== ppx.x || p.cur[1] !== ppx.y) {
          p.cur = [ppx.x, ppx.y];
          this.drawPathPreview();
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
      const inView = pt.x >= 0 && pt.y >= 0 && pt.x <= this.vpW() && pt.y <= this.vpH();
      this.cursor = inView ? { x: pp.x, y: pp.y, size: this.session.brushSize } : null;
      this.stroke.moveTo(pp.x, pp.y, e.pointerType === "pen" ? e.pressure : 1);
      // only the pixels this move touched need recompositing and repainting
      this.repaintStroke();
      return;
    }
    if (this.outline) {
      this.outlineMove(this.screenToPixel(pt.x, pt.y));
      return;
    }
    if (this.selDrag) {
      const pp = this.screenToPixel(pt.x, pt.y);
      this.selMove(pp);
      return;
    }
    // hover: footprint marker follows the pointer across the whole drawing
    // area too (marks still clip to the canvas); it hides only off the view or
    // while the axis-adjust mode is on (painting is suspended there)
    const drawing = ["pencil", "eraser", "bucket", "line", "rect", "ellipse", "circle", "polygon", "polyline", "curve"].includes(this.session.tool);
    const inView = pt.x >= 0 && pt.y >= 0 && pt.x <= this.vpW() && pt.y <= this.vpH();
    this.cursor = drawing && inView
      ? { x: ppx.x, y: ppx.y, size: this.session.brushSize }
      : null;
    if (e.pointerType === "mouse") this.syncCursor();
    // PC：把光标下的像素与颜色发布给状态栏读数（只在真正换像素时更新）
    if (isPc()) {
      const inside = ppx.x >= 0 && ppx.y >= 0 && ppx.x < this.session.doc.w && ppx.y < this.session.doc.h;
      const h = this.session.hover;
      if (!inside) {
        if (h) this.session.setHover(null);
      } else if (!h || h.x !== ppx.x || h.y !== ppx.y) {
        const c = this.session.sampleComposite(ppx.x, ppx.y);
        this.session.setHover({ x: ppx.x, y: ppx.y, color: c ? [c[0], c[1], c[2], c[3]] : null });
      }
    }
    this.drawOverlay();
  }

  private onUp(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0) this.stopSpray();
    if (this.symTarget) {
      this.symTarget = null;
      this.session.changedUI(); // refresh the angle readout in the UI chips
      this.drawOverlay();
    }
    if (this.pointers.size < 2) this.pinchBase = null;
    if (this.hold && this.pointers.size < this.hold.n) this.cancelHold();
    if (this.pointers.size === 0 && this.resizeDrag) {
      const g = this.resizeDrag;
      this.resizeDrag = null;
      if (g.moved) {
        // 一条历史：canvasSize 用「固定哪一侧」的锚点语义
        this.session.canvasSize(g.w, g.h, g.ax, g.ay);
        this.session.hapticTick("画布尺寸", 0.7);
      }
      this.session.repaintAll();
      return;
    }
    if (this.pointers.size === 0 && this.path) {
      // a tap added a point: drop the rubber band, keep the path pending
      this.path.cur = null;
      this.gestureMoved = false;
      this.drawPathPreview();
      return;
    }
    if (this.pointers.size === 0 && this.outline) {
      this.endOutline(true);
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
      if (this.xf) this.endXf();
      const pt = this.evPt(e);
      const now = Date.now();
      // two-finger tap (no zoom): a double two-finger tap = redo
      const hadTwo = this.gestureHadTwo, pinchZoomed = this.pinchZoomed;
      const firedTwoLong = this.holdFired;
      this.gestureHadTwo = false;
      this.pinchZoomed = false;
      this.holdFired = false;
      if (this.fourSeen) {
        // four-finger gesture: it opened the all-frames preview as soon as
        // four fingers were down with >=2 of them sliding; the preview opens
        // when the last finger lifts. Anything else is swallowed so it can
        // never redo/tap/paint.
        this.fourSeen = false;
        this.pinchBase = null;
        this.twoTap = 0;
        this.twoTapPt = null;
        const armed = this.fourArmed;
        this.fourArmed = false;
        this.fourStart.clear();
        this.fourView0 = null;
        if (this.stroke) { this.stroke.cancel(); this.stroke = null; }
        if (this.selDrag) {
          if (this.selDrag.kind === "move" && this.selDrag.cut) this.endSelDrag(false);
          else this.selDrag = null;
        }
        this.panLast = null;
        this.gestureMoved = false;
        this.session.repaint();
        if (armed) {
          const fourAct = this.session.prefs.gFourFinger;
          this.session.hapticTick("四指"); // tactile confirmation before it fires
          if (fourAct === "framePreview" && this.onFramePreview) this.onFramePreview();
          else this.session.runGestureAction(fourAct, { x: pt.x, y: pt.y });
        }
        return;
      }
      if (firedTwoLong) {
        // the two-finger long press already ran its action while the fingers
        // were down: swallow the lifts so they can never count as a tap / redo
        this.twoTap = 0;
        this.twoTapPt = null;
        this.twoTapMid = null;
        this.panLast = null;
        this.gestureMoved = false;
        this.cancelHold();
        return;
      }
      if (hadTwo && !pinchZoomed && !this.stroke && !this.selDrag && !this.xf && this.twoTapMid) {
        const mid = this.twoTapMid;
        this.twoTapMid = null;
        // the redo shortcut only fires outside the canvas: two-finger double
        // taps over the artwork must never redo (too easy to hit while drawing)
        const mpp = this.screenToPixel(mid.x, mid.y);
        const midOverDoc = mpp.x >= 0 && mpp.y >= 0 && mpp.x < this.session.doc.w && mpp.y < this.session.doc.h;
        this.gestureMoved = false;
        this.panLast = null;
        if (midOverDoc) { this.twoTap = 0; this.twoTapPt = null; return; }
        if (this.twoTapPt && now - this.twoTap < this.session.prefs.doubleTapMs && Math.hypot(mid.x - this.twoTapPt.x, mid.y - this.twoTapPt.y) < 80) {
          this.twoTap = 0;
          this.twoTapPt = null;
          this.session.runGestureAction(this.session.prefs.gTwoFingerDoubleTap, { x: mid.x, y: mid.y });
          this.session.repaint();
        } else {
          this.twoTap = now;
          this.twoTapPt = mid;
        }
        return;
      }
      const secondTapMoved = this.stroke ? this.gestureMoved : false;
      if (secondTapMoved) {
        this.tapN = 0; // a drag breaks the tap sequence
      } else {
        // single-finger tap sequence: double-tap on the margin = undo,
        // triple-tap on the doc = zoom (double-tap on the doc does nothing)
        // PC：双击/三击这类触控快捷手势全部关闭（滚轮与快捷键替代它们）
        const contSeq = !isPc() && this.tapN > 0 && now - this.tapT < 480 && this.tapPt &&
          Math.hypot(pt.x - this.tapPt.x, pt.y - this.tapPt.y) < 64;
        this.tapN = contSeq ? this.tapN + 1 : 1;
        this.tapT = now;
        this.tapPt = pt;
        const ppc = this.screenToPixel(pt.x, pt.y);
        const overDoc = ppc.x >= 0 && ppc.y >= 0 && ppc.x < this.session.doc.w && ppc.y < this.session.doc.h;
        // double-tap ON a canvas: focus it (when it is not the focused one) and
        // smoothly zoom it to fit. On the focused canvas this only fits, and
        // only while the canvas double-tap is unmapped, so a user mapping of
        // "double tap on canvas" keeps working.
        const hitCanvas = this.canvasAtScreen(pt.x, pt.y);
        const focusTap = this.tapN === 2 && hitCanvas >= 0 &&
          (hitCanvas !== this.session.docIdx || this.session.prefs.gDoubleTapCanvas === "none");
        if (focusTap) {
          this.tapN = 0;
          if (this.stroke) { this.stroke.cancel(); this.stroke = null; }
          if (this.selDrag) this.endSelDrag();
          this.panLast = null; this.gestureMoved = false;
          this.session.hapticTick("双击画布", 0.8);
          if (hitCanvas !== this.session.docIdx) this.session.focusCanvas(hitCanvas);
          this.session.fitCanvas();
          return;
        }
        if (this.tapN === 2 && !overDoc) {
          // double-tap on the canvas margin -> whatever the user mapped
          this.tapN = 0;
          if (this.stroke) { this.stroke.cancel(); this.stroke = null; }
          if (this.selDrag) this.endSelDrag();
          this.panLast = null; this.gestureMoved = false;
          this.session.runGestureAction(this.session.prefs.gDoubleTapMargin, { x: pt.x, y: pt.y });
          this.session.repaint();
          return;
        }
        if (this.tapN === 2 && overDoc && this.session.prefs.gDoubleTapCanvas !== "none") {
          // double-tap on the canvas itself (only when it is mapped to something;
          // otherwise the second tap is swallowed so a triple tap can follow)
          this.tapN = 0;
          if (this.stroke) { this.stroke.cancel(); this.stroke = null; }
          this.panLast = null; this.gestureMoved = false;
          this.session.runGestureAction(this.session.prefs.gDoubleTapCanvas, { x: pt.x, y: pt.y });
          this.session.repaint();
          return;
        }
        if (this.tapN === 3) {
          // triple-tap on the doc -> zoom. Roll back the single swallowed tap
          // dot (if there was one) so zooming leaves no stray pixel — but never
          // undo anything the user painted before this gesture.
          this.tapN = 0;
          if (this.stroke) { this.stroke.cancel(); this.stroke = null; }
          if (this.selDrag) this.endSelDrag();
          this.panLast = null; this.gestureMoved = false;
          if (overDoc) {
            if (this.lastTapWasDraw && this.lastTapChanged && this.session.history.canUndo()) this.session.undo();
            this.lastTapWasDraw = false;
            this.lastTapChanged = false;
            this.session.repaint();
            this.session.runGestureAction(this.session.prefs.gTripleTap, { x: pt.x, y: pt.y });
          } else this.session.repaint();
          return;
        }
        if (this.tapN === 2 && overDoc) {
          // second tap over the doc: swallow it and wait for a possible third
          // tap (zoom). No undo here — undo belongs to the canvas margin only.
          if (this.stroke) { this.stroke.cancel(); this.stroke = null; }
          this.gestureMoved = false; this.panLast = null;
          this.session.repaint();
          return;
        }
        // single / otherwise-unhandled tap: fall through to commit the dot normally
      }
      if (this.stroke) {
        const doneStroke = this.stroke;
        const doneMoved = this.gestureMoved;
        const rec = this.stroke.commit(this.session.history, this.labelFor(this.stroke.kind));
        this.stroke = null;
        this.session.repaint();
        if (rec) this.session.changedUI();
        // shapes become an immediate selection of EXACTLY the pixels this stroke
        // painted (a pixel mask, not a rectangle) so only the shape moves;
        // neighbouring artwork that falls under the marquee stays untouched
        if (doneMoved && doneStroke.start && doneStroke.last && this.isShapeKind(doneStroke.kind)) {
          this.selectStrokePixels(doneStroke);
          this.session.setTool("select");
        }
        this.lastTapWasDraw = !this.gestureMoved;
        this.lastTapChanged = !!rec;
      } else {
        this.lastTapWasDraw = false;
        this.lastTapChanged = false;
      }
      this.gestureMoved = false;
      this.panLast = null;
      // a floating selection dropped on another canvas moves there (see
      // dropSelDragToCanvas); everything else drops in place
      if (this.selDrag && !this.dropSelDragToCanvas(pt.x, pt.y)) this.endSelDrag();
    }
  }

  /** true for the freehand shape tools that auto-select after drawing */
  private isShapeKind(k: string): boolean {
    return k === "line" || k === "rect" || k === "rectfill" || k === "ellipse" || k === "ellipsefill" || k === "circle" || k === "polygon";
  }

  /** select exactly the pixels this stroke painted: compare the cel against the
   * stroke's pre-draw buffer. The selection is a true pixel mask, so the shared
   * selection-move/transform logic only carries the shape itself - artwork that
   * happens to sit inside the marquee bounds is never grabbed or moved. */
  private selectStrokePixels(st: Stroke): void {
    const doc = this.session.doc;
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
    this.session.repaint();
    this.session.changedUI();
  }

  private onCancel(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    if (this.resizeDrag) { this.resizeDrag = null; this.drawOverlay(); }
    if (this.outline) this.endOutline(false);
    // a stationary two-finger hold cancelled by the OS usually means the phone
    // claimed the gesture for its own screen recognition: tell the user once
    if (this.hold && this.hold.n === 2 && this.pointers.size < 2) {
      this.session.hintOnce("twoFingerLongPress",
        "双指长按被系统的「识屏」抢走了：在系统设置里搜索「识屏」并关闭它，或改用三指长按",
        "The system's screen recognition grabbed the two-finger long press. Search for 'screen recognition' in the system settings and turn it off, or use the three-finger long press.");
    }
    this.cancelHold();
    this.stopSpray();
    this.holdFired = false;
    this.gestureHadTwo = false;
    this.pinchZoomed = false;
    this.twoTapMid = null;
    this.twoTap = 0;
    this.twoTapPt = null;
    this.fourSeen = false;
    this.fourArmed = false;
    this.fourView0 = null;
    this.fourStart.clear();
    this.mag = false;
    this.magCenter = null;
    if (this.symTarget) this.symTarget = null;
    if (this.stroke) {
      if (this.gestureMoved) {
        const rec = this.stroke.commit(this.session.history, this.labelFor(this.stroke.kind));
        if (rec) this.session.changedUI();
      } else {
        this.stroke.cancel();
      }
      this.stroke = null;
      this.gestureMoved = false;
      this.session.repaint();
    }
    if (this.xf) this.abortXf();
    // a cancelled floating drag puts the cut pixels back untouched
    if (this.selDrag) {
      if (this.selDrag.kind === "move" && this.selDrag.cut) this.endSelDrag(false);
      else this.selDrag = null;
    }
    this.panLast = null;
    this.pinchBase = null;
    this.pickMode = false;
    this.pickAnchor = null;
    this.cancelPickTimer();
  }

  // ------------------------------------------- selection transform box
  /** screen-space anchors of the transform frame (8 handles + rotate dot) */
  private selFramePts(): { x: number; y: number; id: string }[] | null {
    const doc = this.session.doc;
    if (!doc.sel || !doc.sel.hasAny()) return null;
    const b = doc.sel.bounds();
    if (!b) return null;
    const z = this.zoom;
    const x0 = b.x * z + this.ox, y0 = b.y * z + this.oy;
    const x1 = (b.x + b.w) * z + this.ox, y1 = (b.y + b.h) * z + this.oy;
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    return [
      { x: x0, y: y0, id: "tl" }, { x: mx, y: y0, id: "t" }, { x: x1, y: y0, id: "tr" },
      { x: x1, y: my, id: "r" }, { x: x1, y: y1, id: "br" }, { x: mx, y: y1, id: "b" },
      { x: x0, y: y1, id: "bl" }, { x: x0, y: my, id: "l" },
      { x: mx, y: Math.max(14, y0 - 30), id: "rot" },
    ];
  }

  private handleAt(pt: PxPoint): string | null {
    const pts = this.selFramePts();
    if (!pts) return null;
    for (const p of pts) {
      const r = p.id === "rot" ? 26 : 20;
      if (Math.hypot(pt.x - p.x, pt.y - p.y) <= r) return p.id;
    }
    return null;
  }

  /** pointer-down landed on a selection frame handle -> start rotate/scale */
  private tryStartXf(pt: PxPoint): boolean {
    const s = this.session;
    const tool = s.tool;
    if (tool !== "select" && tool !== "lasso" && tool !== "wand") return false;
    if (this.selDrag) return false;
    const id = this.handleAt(pt);
    if (!id) return false;
    const doc = s.doc;
    const li = s.curLayer(), fi = s.curFrame();
    const st = beginMove(doc, li, fi);
    if (!st) return false;
    const cw = st.content.w, ch = st.content.h;
    const cx = st.ox + cw / 2, cy = st.oy + ch / 2;
    const dx = (pt.x - this.ox) / this.zoom, dy = (pt.y - this.oy) / this.zoom;
    let mode: "rot" | "scale" = "scale";
    let axis: "xy" | "x" | "y" = "xy";
    if (id === "rot") mode = "rot";
    else if (id === "t" || id === "b") axis = "y";
    else if (id === "l" || id === "r") axis = "x";
    // scale anchor = the handle opposite the one being grabbed, so the box
    // grows from a fixed corner/edge (content extends) instead of around centre
    let ax = cx, ay = cy;
    if (mode === "scale") {
      if (id === "tl") { ax = st.ox + cw; ay = st.oy + ch; }
      else if (id === "tr") { ax = st.ox; ay = st.oy + ch; }
      else if (id === "br") { ax = st.ox; ay = st.oy; }
      else if (id === "bl") { ax = st.ox + cw; ay = st.oy; }
      else if (id === "t") { ax = cx; ay = st.oy + ch; }
      else if (id === "b") { ax = cx; ay = st.oy; }
      else if (id === "l") { ax = st.ox + cw; ay = cy; }
      else if (id === "r") { ax = st.ox; ay = cy; }
    }
    this.xf = { mode, axis, li, fi, st, cx, cy, ax, ay, p0x: dx, p0y: dy, ang0: 0, moved: false, cut: false, buf: new Uint8ClampedArray(doc.w * doc.h * 4), cells: [] };
    if (mode === "rot") this.xf.ang0 = Math.atan2(dy - cy, dx - cx);
    return true;
  }

  private xfMove(pt: PxPoint): void {
    const g = this.xf;
    if (!g) return;
    const doc = this.session.doc;
    const px = (pt.x - this.ox) / this.zoom, py = (pt.y - this.oy) / this.zoom;
    let angle = 0, sx = 1, sy = 1;
    if (g.mode === "rot") {
      angle = Math.atan2(py - g.cy, px - g.cx) - g.ang0;
      if (Math.abs(angle) > 0.004) g.moved = true;
    } else if (g.axis === "x") {
      const base = Math.max(0.5, Math.abs(g.p0x - g.ax));
      sx = clamp(Math.abs(px - g.ax) / base, 0.02, 40);
    } else if (g.axis === "y") {
      const base = Math.max(0.5, Math.abs(g.p0y - g.ay));
      sy = clamp(Math.abs(py - g.ay) / base, 0.02, 40);
    } else {
      const d0 = Math.max(1, Math.hypot(g.p0x - g.ax, g.p0y - g.ay));
      const f = clamp(Math.hypot(px - g.ax, py - g.ay) / d0, 0.02, 40);
      sx = f; sy = f;
    }
    if (g.mode !== "rot" && (sx !== 1 || sy !== 1)) g.moved = true;
    if (!g.moved) return;
    if (!g.cut) { g.cut = true; selOps.floatCut(doc, g.li, g.fi, g.st); }
    if (g.buf) g.cells = xformFloating(doc, g.st, angle, sx, sy, g.buf, g.mode === "rot" ? g.cx : g.ax, g.mode === "rot" ? g.cy : g.ay);
    this.session.repaint();
  }

  /** transform ended: commit one undo step (or nothing when it never moved) */
  private endXf(): void {
    const g = this.xf;
    this.xf = null;
    if (!g) return;
    const s = this.session;
    const doc = s.doc;
    const cel = doc.celAt(g.li, g.fi);
    if (!cel) return;
    if (!g.moved) return;
    if (g.cut && g.buf && g.cells) {
      // drop: the cel still holds "pre-gesture minus content", write the final
      // floating pixels once and record a single history step
      const data = cel.data;
      const buf = g.buf;
      for (const di of g.cells) {
        const o = di * 4;
        data[o] = buf[o]; data[o + 1] = buf[o + 1]; data[o + 2] = buf[o + 2]; data[o + 3] = buf[o + 3];
      }
      let changed = false;
      for (let i = 0; i < data.length; i++) if (data[i] !== g.st.before[i]) { changed = true; break; }
      if (changed) {
        s.history.pushPixels(g.mode === "rot" ? "sel.rotate" : "sel.scale", doc, [
          { li: g.li, fi: g.fi, before: g.st.before, after: new Uint8ClampedArray(data) },
        ]);
        s.changed();
      }
    }
    s.repaint();
  }

  /** gesture cancelled (pointercancel / lost): roll the layer back to drag start */
  private abortXf(): void {
    const g = this.xf;
    this.xf = null;
    if (!g) return;
    const doc = this.session.doc;
    const cel = doc.celAt(g.li, g.fi);
    if (cel) cel.data.set(g.st.before);
    if (doc.sel) { doc.sel.mask.set(g.st.mask); doc.sel.bump(); }
    this.session.repaint();
  }

  /** dashed selection frame + white handles + rotate dot above the top edge */
  private drawSelTransform(): void {
    if (this.selDrag) return;
    const tool = this.session.tool;
    if (!this.xf && tool !== "select" && tool !== "lasso" && tool !== "wand") return;
    const doc = this.session.doc;
    if (!doc.sel || !doc.sel.hasAny()) return;
    const b = doc.sel.bounds();
    if (!b) return;
    const pts = this.selFramePts();
    if (!pts) return;
    const ctx = this.ov.getContext("2d")!;
    const z = this.zoom;
    const x0 = b.x * z + this.ox, y0 = b.y * z + this.oy;
    const x1 = (b.x + b.w) * z + this.ox, y1 = (b.y + b.h) * z + this.oy;
    const rot = pts[8];
    ctx.save();
    // frame: dark underlay then white line
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = "rgba(0,0,0,.6)";
    ctx.strokeRect(x0 - 0.5, y0 - 0.5, x1 - x0 + 1, y1 - y0 + 1);
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = "rgba(255,255,255,.92)";
    ctx.strokeRect(x0 - 1, y0 - 1, x1 - x0 + 2, y1 - y0 + 2);
    // connector up to the rotate dot
    ctx.strokeStyle = "rgba(255,255,255,.9)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo((x0 + x1) / 2, y0);
    ctx.lineTo(rot.x, rot.y + 13);
    ctx.stroke();
    // 8 scale handles
    for (let i = 0; i < 8; i++) {
      const p = pts[i];
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#20242f";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.rect(p.x - 4.5, p.y - 4.5, 9, 9);
      ctx.fill();
      ctx.stroke();
    }
    // rotate dot
    ctx.beginPath();
    ctx.fillStyle = "#aed1ff";
    ctx.strokeStyle = "#1b2a44";
    ctx.lineWidth = 1.4;
    ctx.arc(rot.x, rot.y, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#14202e";
    ctx.font = "bold 14px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("\u21bb", rot.x, rot.y + 0.5);
    ctx.restore();
  }


  /** airbrush: keep spraying every 50 ms while the pointer stays down */
  private startSpray(): void {
    this.stopSpray();
    const rate = Math.max(5, Math.min(60, this.session.prefs.airbrushRate));
    const period = 50;
    this.sprayT = window.setInterval(() => {
      const st = this.stroke;
      if (!st) { this.stopSpray(); return; }
      this.sprayAcc += (rate * period) / 1000;
      const n = Math.floor(this.sprayAcc);
      if (n < 1) return;
      this.sprayAcc -= n;
      st.sprayBurst(n);
      const d = st.takeDirty();
      if (d) {
        if (this.strokeRedirected) this.session.repaint();
        else this.session.repaintRect(d);
      }
    }, period);
  }
  private stopSpray(): void {
    if (this.sprayT !== null) { window.clearInterval(this.sprayT); this.sprayT = null; }
    this.sprayAcc = 0;
  }

  private labelFor(kind: string): string {
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
  private outlineDown(pp: { x: number; y: number }): void {
    const s = this.session;
    if (s.layerLocked()) { s.paintBlockedNote(); return; }
    // redirect onto the referenced canvas, exactly like a brush stroke
    const tgt = s.strokeTarget(s.curLayer());
    const doc = tgt ? tgt.doc : s.doc;
    const li = tgt ? tgt.li : s.curLayer();
    const fi = tgt ? tgt.fi : s.curFrame();
    const cel = doc.celAt(li, fi);
    this.outline = {
      pts: [[pp.x, pp.y]], li, fi,
      before: cel ? new Uint8ClampedArray(cel.data) : null,
      dx: tgt ? tgt.dx : 0, dy: tgt ? tgt.dy : 0,
    };
    this.cursor = null;
    this.drawOverlay();
  }
  private outlineMove(pp: { x: number; y: number }): void {
    const o = this.outline;
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
  private wireRedirect(st: Stroke, tgt: { dx: number; dy: number } | null): void {
    if (!tgt) return;
    st.refDx = tgt.dx;
    st.refDy = tgt.dy;
    st.setGeometry(this.session.doc.w, this.session.doc.h);
    const sel = this.session.doc.sel;
    if (sel && sel.hasAny()) {
      st.mask = (sx: number, sy: number) => sel.get(sx + tgt.dx, sy + tgt.dy) === 1;
    }
  }
  private isPathTool(t: string): boolean {
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
    const p = this.path;
    this.path = null;
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
  private drawPathPreview(): void {
    const p = this.path;
    if (!p) return;
    const pts = p.cur ? [...p.pts, p.cur] : p.pts;
    p.st.drawPath(pts, p.smooth);
    const d = p.st.takeDirty();
    if (d) this.session.repaintRect(d);
    else this.session.repaint();
    this.drawOverlay();
  }
  private pathDown(pp: { x: number; y: number }): void {
    const s = this.session;
    const tool = s.tool;
    if (s.layerLocked()) { s.paintBlockedNote(); return; }
    const tgt = this.pathTarget();
    if (this.path) {
      const p = this.path;
      // a different tool / layer / frame: finish what we have first
      if (p.st.kind !== tool || p.st.doc !== tgt.doc || p.st.li !== tgt.li || p.st.fi !== tgt.fi) this.endPath(true);
    }
    if (!this.path) {
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
      this.path = { st, pts: [[pp.x, pp.y]], smooth: tool === "curve", cur: null };
      this.drawPathPreview();
      return;
    }
    const p = this.path;
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
  private endOutline(commit: boolean): void {
    const o = this.outline;
    this.outline = null;
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
  private startSelMove(pp: { x: number; y: number }): boolean {
    const s = this.session;
    const doc = s.doc;
    if (!doc.sel || doc.sel.get(pp.x, pp.y) !== 1) return false;
    const li = s.curLayer(), fi = s.curFrame();
    const cel = doc.celAt(li, fi);
    if (!cel) return false;
    const mv = beginMove(doc, li, fi);
    const b = doc.sel.bounds();
    if (!mv || !b) return false;
    this.selDrag = {
      kind: "move", x0: pp.x, y0: pp.y, x1: pp.x, y1: pp.y,
      before: mv.before, b, moved: false, sx: pp.x, sy: pp.y, mv,
    };
    return true;
  }

  private selDown(pp: { x: number; y: number }, pt: PxPoint, e: PointerEvent): void {
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
        this.selDrag = {
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
        this.selDrag = {
          kind: "move", x0: pp.x, y0: pp.y, x1: pp.x, y1: pp.y,
          before: cel ? new Uint8ClampedArray(cel.data) : null,
          b, moved: false, sx: pp.x, sy: pp.y, mv,
        };
        return;
      }
    }
    this.selDrag = { kind: "rect", x0: pp.x, y0: pp.y, x1: pp.x, y1: pp.y, before: null, b: { x: 0, y: 0, w: 0, h: 0 }, moved: false, sx: pp.x, sy: pp.y };
  }

  private selMove(pp: { x: number; y: number }): void {
    const g = this.selDrag;
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
    const dx = pp.x - g.sx, dy = pp.y - g.sy;
    if (dx || dy) g.moved = true;
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
    const pt = this.lastPt;
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
  private dropSelDragToCanvas(sx: number, sy: number): boolean {
    const g = this.selDrag;
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
    this.selDrag = null; // drops the floating overlay of the source canvas
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

  private endSelDrag(commit = true): void {
    const g = this.selDrag;
    this.selDrag = null;
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
