// Interactive viewport: composite drawing, pan/zoom gestures, tool strokes.
import type { Doc } from "../engine/doc";
import { Sel } from "../engine/doc";
import * as comp from "./compositor";
import * as bridge from "../io/bridge";
import { Stroke } from "../tools/stroke";
import { isSymTool, SYM_ANGLES } from "../tools/registry";
import { lineCells, brushStamp } from "../engine/paint";
import { selOps, lassoFill, beginMove, xformFloating, type MoveState } from "../tools/select";
import type { Session } from "../app/session";
import { clamp } from "../engine/types";

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
const FOUR_MOVE_PX = 15;

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

  private composite: HTMLCanvasElement | null = null;
  private compKey = "";
  private compDirty = true;
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
  private antTimer: number | null = null;
  /** cached selection tint layer (rebuilt only when the doc changes) */
  private selTint: HTMLCanvasElement | null = null;
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
  private selDrag: { kind: "rect" | "move" | "lasso"; x0: number; y0: number; x1: number; y1: number; before: Uint8ClampedArray | null; b: { x: number; y: number; w: number; h: number }; moved: boolean; sx: number; sy: number; mv?: MoveState | null; pts?: [number, number][]; dx?: number; dy?: number; cut?: boolean } | null = null;
  private longT: number | null = null;
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
    this.ro?.disconnect();
    this.stopAnts();
    this.host.replaceChildren();
  }

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
  }
  setFrame(fi: number): void {
    void fi;
    this.composite = null;
    this.compKey = "";
  }

  fit(): void {
    const doc = this.session.doc;
    const aw = Math.max(24, this.host.clientWidth - 20);
    const ah = Math.max(24, this.host.clientHeight - 20);
    let z = Math.min(aw / doc.w, ah / doc.h);
    const zi = Math.floor(z);
    if (zi >= 1 && Math.abs(z - zi) < 0.18) z = zi;
    this.zoom = clamp(z, 0.05, 32);
    this.ox = (this.host.clientWidth - doc.w * this.zoom) / 2;
    this.oy = (this.host.clientHeight - doc.h * this.zoom) / 2;
  }

  /** Keep the canvas in view: stop panning when a canvas edge reaches the
   *  viewport edge, so the artwork can never be dragged off-screen. */
  private clampView(): void {
    const doc = this.session.doc;
    const w = this.host.clientWidth, h = this.host.clientHeight;
    const dw = doc.w * this.zoom, dh = doc.h * this.zoom;
    this.ox = dw >= w ? clamp(this.ox, w - dw, 0) : clamp(this.ox, 0, Math.max(0, w - dw));
    this.oy = dh >= h ? clamp(this.oy, h - dh, 0) : clamp(this.oy, 0, Math.max(0, h - dh));
  }

  zoomAt(z: number, cx?: number, cy?: number): void {
    const vpW = this.host.clientWidth, vpH = this.host.clientHeight;
    const mx = cx === undefined ? vpW / 2 : cx;
    const my = cy === undefined ? vpH / 2 : cy;
    z = clamp(z, 0.05, 32);
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

  // ---------------------------------------------------------------- render
  /** mark composite stale (pixels changed) */
  markDirty(): void {
    this.compDirty = true;
  }

  /** commit a still-open gesture (e.g. bucket fill whose pointerup was lost) as its own history step */
  flushStroke(): boolean {
    if (!this.stroke) return false;
    const rec = this.stroke.commit(this.session.history, this.labelFor(this.stroke.kind));
    this.stroke = null;
    this.session.repaint();
    if (rec) this.session.changed();
    return rec;
  }

  refresh(force: boolean): void {
    const s = this.session;
    const doc = s.doc;
    if (!doc) return;
    const need = force || this.compDirty;
    this.buildComposite(need);
    if (need) this.compDirty = false;
    const ctx = this.pix.getContext("2d")!;
    const dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.host.clientWidth, this.host.clientHeight);
    ctx.imageSmoothingEnabled = false;
    const z = this.zoom;
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
      const pat = ctx.createPattern(chk, "repeat")!;
      ctx.fillStyle = pat;
      ctx.save();
      ctx.translate(this.ox, this.oy);
      ctx.scale(z, z);
      ctx.fillRect(0, 0, doc.w, doc.h);
      ctx.restore();
    }
    if (this.composite) {
      ctx.drawImage(this.composite, this.ox, this.oy, doc.w * z, doc.h * z);
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
    this.drawOverlay(need);
  }

  private buildComposite(force: boolean): void {
    const s = this.session;
    const doc = s.doc;
    const fi = s.curFrame();
    const p = s.prefs;
    const onionKey = p.onionOn ? "1:" + p.onionBefore + ":" + p.onionAfter + ":" + p.onionAlpha + ":" + (p.onionTint ? 1 : 0) : "0";
    const key = fi + "|" + doc.layers.map((l) => (l.visible ? 1 : 0) + ":" + l.opacity + ":" + l.blend + (doc.bg ? "B" : "T")).join() + "|on" + onionKey;
    if (!force && this.composite && this.compKey === key) return;
    this.compKey = key;
    const onion = {
      before: p.onionOn ? p.onionBefore : 0,
      after: p.onionOn ? p.onionAfter : 0,
      alpha: p.onionAlpha / 100,
      tint: p.onionTint,
    };
    this.composite = comp.composeFrameWithOnion(doc, fi, onion);
  }

  private drawOverlay(rebuildTint = false): void {
    const ctx = this.ov.getContext("2d")!;
    const dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.host.clientWidth, this.host.clientHeight);
    const s = this.session;
    const doc = s.doc;
    if (!doc) return;
    const z = this.zoom;
    this.drawIsoGuide(ctx);
    // selection tint + ants
    if (doc.sel && doc.sel.hasAny()) {
      if (rebuildTint || !this.selTint || this.selTint.width !== doc.w || this.selTint.height !== doc.h) {
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
    this.drawSelTransform();
    // floating selection content: pixels held above the layer during a drag
    const fg = this.selDrag;
    if (fg && fg.kind === "move" && fg.mv && fg.cut && fg.moved) {
      const mv = fg.mv, content = mv.content;
      const gox = mv.ox + (fg.dx || 0), goy = mv.oy + (fg.dy || 0);
      const zz = Math.max(1, z);
      ctx.save();
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
      ctx.restore();
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
    const x = 10, y = this.host.clientHeight - L - 10;
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
    const K = Math.hypot(this.host.clientWidth, this.host.clientHeight) + 8;
    ctx.beginPath();
    ctx.moveTo(px - ux * K, py - uy * K);
    ctx.lineTo(px + ux * K, py + uy * K);
    ctx.stroke();
  }
  /** rotation knob sits on the primary axis opposite the lock button; hidden when locked */
  private symRotKnob(): [number, number] | null {
    const a = this.symAxis();
    if (!a || this.session.symLocked) return null;
    const w = this.host.clientWidth, h = this.host.clientHeight;
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
    const w = this.host.clientWidth, h = this.host.clientHeight;
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
  }

  private evPt(e: PointerEvent): PxPoint {
    const r = this.host.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }


  // ----- long-press eyedropper mode (0.3s stationary inside one pixel) -----
  private cancelPickTimer(): void {
    if (this.longT !== null) {
      window.clearTimeout(this.longT);
      this.longT = null;
    }
    this.pickAnchor = null;
  }
  private samplePickCell(x: number, y: number, strong: boolean): void {
    const c = this.session.sampleComposite(x, y);
    if (c) {
      const changed = this.pickLast == null || this.pickLast[0] !== x || this.pickLast[1] !== y;
      if (changed) {
        this.session.setFgColor(c);
        if (strong) bridge.vibrate(26);
        else bridge.vibrate(10);
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

  private onDown(e: PointerEvent): void {
    e.preventDefault();
    try {
      this.host.setPointerCapture && this.host.setPointerCapture(e.pointerId);
    } catch { /* ignore */ }
    const pt = this.evPt(e);
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
      this.pinchBase = null;
      this.pinchZoomed = false;
      this.gestureHadTwo = false;
      this.twoTap = 0;
      this.twoTapPt = null;
      this.twoTapMid = null;
      this.panLast = null;
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
      if (this.stroke) { this.stroke.cancel(); this.stroke = null; }
      if (this.selDrag) {
        if (this.selDrag.kind === "move" && this.selDrag.cut) this.endSelDrag(false);
        else this.selDrag = null;
      }
      this.panLast = null;
      this.gestureMoved = false;
      this.pinchBase = null;
      this.pinchZoomed = false;
      this.gestureHadTwo = false;
      this.twoTap = 0;
      this.twoTapPt = null;
      this.twoTapMid = null;
      return;
    }
    if (this.pointers.size >= 2) {
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
      return;
    }
    // flush an unfinished gesture left by a lost pointerup (e.g. rapid bucket taps)
    if (this.stroke) {
      const rec = this.stroke.commit(this.session.history, this.labelFor(this.stroke.kind));
      this.stroke = null;
      this.session.repaint();
      if (rec) this.session.changed();
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
    const selOn = !!doc.sel && doc.sel.hasAny();
    // long-press eyedropper: disabled while a selection is shown or a selection
    // tool is active (holds there mean marquee/transform, not colour picking)
    const pickAllowed = !selOn && tool !== "select" && tool !== "lasso" && tool !== "wand";
    if (pickAllowed && pp.x >= 0 && pp.y >= 0 && pp.x < doc.w && pp.y < doc.h) {
      this.pickAnchor = [pp.x, pp.y];
      this.longT = window.setTimeout(() => {
        this.longT = null;
        this.enterPickMode(pp.x, pp.y);
      }, 300);
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
    try {
      this.stroke = new Stroke(doc, s.curLayer(), s.curFrame(), tool as never, s.brush(), s.layerLocked(), s.sym, s.shapeSides, s.shapeFill,
        s.symOx, s.symOy, s.symAng, s.symFour, s.prefs.bucketGlobal);
    } catch {
      this.stroke = null;
      return;
    }
    this.stroke.startAt(pp.x, pp.y);
    s.repaint();
  }

  private onMove(e: PointerEvent): void {
    const pt = this.evPt(e);
    const wasDown = this.pointers.has(e.pointerId);
    if (wasDown) this.pointers.set(e.pointerId, pt);
    // auto-pan the viewport while a draw/transform/selection drag nears the edge.
    // Speed scales with how deep into the edge zone the pointer is, but is capped
    // per event so the scroll stays slow, smooth and controllable.
    if (this.session.prefs.autoPan && wasDown && this.pointers.size === 1 && (this.stroke || this.xf || this.selDrag)) {
      const M = 34, w = this.host.clientWidth, h = this.host.clientHeight;
      const SPEED = 0.28, MAX = 3; // px per event
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
        if (s && Math.hypot(p.x - s.x, p.y - s.y) > FOUR_MOVE_PX) moving++;
      }
      if (moving >= 2) this.fourArmed = true;
      return;
    }
    // pinch
    if (this.pointers.size >= 2 && this.pinchBase) {
      const [a, b] = [...this.pointers.values()];
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const dist = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
      const k = dist / this.pinchBase.dist;
      const z = clamp(this.pinchBase.zoom * k, 0.05, 32);
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
      } else {
        // the axis passes through the finger; clamp to the visible viewport
        // (so it follows into the margins) and snap to the half-cell grid so
        // it moves in whole pixels instead of drifting continuously
        const vx0 = Math.min(-this.ox, this.host.clientWidth - this.ox) / this.zoom;
        const vx1 = Math.max(-this.ox, this.host.clientWidth - this.ox) / this.zoom;
        const vy0 = Math.min(-this.oy, this.host.clientHeight - this.oy) / this.zoom;
        const vy1 = Math.max(-this.oy, this.host.clientHeight - this.oy) / this.zoom;
        const pxa = Math.round(clamp((pt.x - this.ox) / this.zoom, vx0, vx1) * 2) / 2;
        const pya = Math.round(clamp((pt.y - this.oy) / this.zoom, vy0, vy1) * 2) / 2;
        s.symOx = pxa - doc.w / 2;
        s.symOy = pya - doc.h / 2;
        s.symTweaked = true;
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
      return;
    }
    if (this.xf) {
      this.xfMove(pt);
      return;
    }
    if (this.stroke) {
      const pp = ppx;
      if (!this.gestureMoved && this.gestureStartPx && (pp.x !== this.gestureStartPx.x || pp.y !== this.gestureStartPx.y)) this.gestureMoved = true;
      // keep the erase/draw footprint marker glued to the finger while stroking;
      // it follows the pointer even past the image border (marks are clipped to
      // the canvas), so it never freezes at the edge while the hand keeps moving
      const inView = pt.x >= 0 && pt.y >= 0 && pt.x <= this.host.clientWidth && pt.y <= this.host.clientHeight;
      this.cursor = inView ? { x: pp.x, y: pp.y, size: this.session.brushSize } : null;
      this.stroke.moveTo(pp.x, pp.y, e.pointerType === "pen" ? e.pressure : 1);
      this.session.repaint();
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
    const drawing = ["pencil", "eraser", "bucket", "line", "rect", "ellipse", "circle", "polygon"].includes(this.session.tool);
    const inView = pt.x >= 0 && pt.y >= 0 && pt.x <= this.host.clientWidth && pt.y <= this.host.clientHeight;
    this.cursor = drawing && inView
      ? { x: ppx.x, y: ppx.y, size: this.session.brushSize }
      : null;
    this.drawOverlay();
  }

  private onUp(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    if (this.symTarget) {
      this.symTarget = null;
      this.session.changed(); // refresh the angle readout in the UI chips
      this.drawOverlay();
    }
    if (this.pointers.size < 2) this.pinchBase = null;
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
      this.gestureHadTwo = false;
      this.pinchZoomed = false;
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
        if (armed && this.onFramePreview) {
          bridge.vibrate(24); // tactile confirmation before the sheet opens
          this.onFramePreview();
        }
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
        if (this.twoTapPt && now - this.twoTap < 420 && Math.hypot(mid.x - this.twoTapPt.x, mid.y - this.twoTapPt.y) < 80) {
          this.twoTap = 0;
          this.twoTapPt = null;
          if (this.session.history.canRedo()) this.session.redo(); else this.session.repaint();
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
        const contSeq = this.tapN > 0 && now - this.tapT < 480 && this.tapPt &&
          Math.hypot(pt.x - this.tapPt.x, pt.y - this.tapPt.y) < 64;
        this.tapN = contSeq ? this.tapN + 1 : 1;
        this.tapT = now;
        this.tapPt = pt;
        const ppc = this.screenToPixel(pt.x, pt.y);
        const overDoc = ppc.x >= 0 && ppc.y >= 0 && ppc.x < this.session.doc.w && ppc.y < this.session.doc.h;
        if (this.tapN === 2 && !overDoc) {
          // double-tap on the canvas margin -> quick undo
          this.tapN = 0;
          if (this.stroke) { this.stroke.cancel(); this.stroke = null; }
          if (this.selDrag) this.endSelDrag();
          this.panLast = null; this.gestureMoved = false;
          if (this.session.history.canUndo()) this.session.undo(); else this.session.repaint();
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
            this.zoomAt(this.zoom * 2, pt.x, pt.y);
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
        if (rec) this.session.changed();
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
      if (this.selDrag) this.endSelDrag();
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
    const cel = doc.celAt(st.li, st.fi);
    const w = doc.w, h = doc.h;
    if (!cel) return;
    const before = st.before ? st.before : new Uint8ClampedArray(w * h * 4);
    const d = cel.data;
    if (!doc.sel) doc.sel = new Sel(w, h);
    const sel = doc.sel;
    sel.clear();
    const n = Math.min(before.length, d.length);
    for (let i = 0; i < n; i += 4) {
      if (before[i] !== d[i] || before[i + 1] !== d[i + 1] || before[i + 2] !== d[i + 2] || before[i + 3] !== d[i + 3]) {
        const p = i >> 2;
        sel.set(p % w, Math.floor(p / w), 1);
      }
    }
    this.session.repaint();
    this.session.changed();
  }

  private onCancel(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
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
        if (rec) this.session.changed();
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
    if (doc.sel) doc.sel.mask.set(g.st.mask);
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


  private labelFor(kind: string): string {
    const map: Record<string, string> = {
      pencil: "tools.pencil", eraser: "tools.eraser", bucket: "tools.bucket",
      line: "tools.line", rect: "tools.rect", rectfill: "tools.rectfill",
      ellipse: "tools.ellipse", ellipsefill: "tools.ellipsefill",
      circle: "tools.circle", polygon: "tools.polygon",
    };
    return map[kind] ?? kind;
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
      this.session.repaint();
      this.startAnts();
      return;
    }
    if (g.kind === "rect") {
      if (pp.x !== g.x0 || pp.y !== g.y0) g.moved = true;
      g.x1 = pp.x;
      g.y1 = pp.y;
      selOps.setRect(this.session.doc, g.x0, g.y0, g.x1, g.y1);
      this.session.repaint();
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
      if (!g.cut) { g.cut = true; selOps.floatCut(s.doc, s.curLayer(), s.curFrame(), g.mv); }
      g.dx = dx; g.dy = dy;
      selOps.shiftMask(s.doc, g.mv, dx, dy);
      this.session.repaint();
    }
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
        s.maskOp("sel.lasso", () => lassoFill(doc, pts));
      } else if (doc.sel) {
        doc.sel.clear();
        s.repaint();
        s.changed();
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
      this.session.changed();
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
    this.session.changed();
  }

}
