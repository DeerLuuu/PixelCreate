// Interactive viewport: composite drawing, pan/zoom gestures, tool strokes.
import type { Doc } from "../engine/doc";
import { Sel } from "../engine/doc";
import type { RGBA } from "../engine/types";
import { cssColor, hexToRgba } from "../engine/color";
import * as comp from "./compositor";
import * as bridge from "../io/bridge";
import { rgbaToHex } from "../engine/color";
import { Stroke } from "../tools/stroke";
import { lineCells } from "../engine/paint";
import { selOps, lassoFill, beginMove, xformSelection, type MoveState } from "../tools/select";
import type { Session } from "../app/session";
import { clamp } from "../engine/types";

interface PxPoint {
  x: number;
  y: number;
}

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
  private cursor: { x: number; y: number; size: number } | null = null;
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
  private selDrag: { kind: "rect" | "move" | "lasso"; x0: number; y0: number; x1: number; y1: number; before: Uint8ClampedArray | null; b: { x: number; y: number; w: number; h: number }; moved: boolean; sx: number; sy: number; mv?: MoveState | null; pts?: [number, number][] } | null = null;
  private longT: number | null = null;
  private pickAnchor: [number, number] | null = null;
  private pickMode = false;
  private pickLast: [number, number] | null = null;
  private lastTap = 0;
  private lastTapPt: PxPoint | null = null;
  /** has the current stroke left its starting cell? (false = pure tap) */
  private gestureMoved = false;
  private gestureStartPx: PxPoint | null = null;
  /** the previous finished gesture was a no-move draw tap (dot) */
  private lastTapWasDraw = false;
  /** and that tap actually recorded a history step (so it can be rolled back) */
  private lastTapChanged = false;
  /** rotate / scale gesture started on a selection frame handle */
  private xf: { mode: "rot" | "scale"; axis: "xy" | "x" | "y"; li: number; fi: number; st: MoveState; cx: number; cy: number; p0x: number; p0y: number; ang0: number; moved: boolean } | null = null;

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
    this.fit();
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

  zoomAt(z: number, cx?: number, cy?: number): void {
    const vpW = this.host.clientWidth, vpH = this.host.clientHeight;
    const mx = cx === undefined ? vpW / 2 : cx;
    const my = cy === undefined ? vpH / 2 : cy;
    z = clamp(z, 0.05, 32);
    const k = z / this.zoom;
    this.ox = mx - (mx - this.ox) * k;
    this.oy = my - (my - this.oy) * k;
    this.zoom = z;
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
    if (s.prefs.grid && z >= 6) {
      ctx.save();
      ctx.translate(this.ox, this.oy);
      ctx.scale(z, z);
      ctx.beginPath();
      ctx.lineWidth = (1 / (z * dpr)) * (z >= 16 ? 2 : 1);
      ctx.strokeStyle = z >= 16 ? "rgba(70,74,96,0.55)" : "rgba(96,102,130,0.4)";
      for (let x = 0; x <= doc.w; x++) { ctx.moveTo(x, 0); ctx.lineTo(x, doc.h); }
      for (let y = 0; y <= doc.h; y++) { ctx.moveTo(0, y); ctx.lineTo(doc.w, y); }
      ctx.stroke();
      ctx.restore();
    }
    this.drawOverlay(need);
  }

  private buildComposite(force: boolean): void {
    const s = this.session;
    const doc = s.doc;
    const fi = s.curFrame();
    const key = fi + "|" + doc.layers.map((l) => (l.visible ? 1 : 0) + ":" + l.opacity + ":" + l.blend + (doc.bg ? "B" : "T")).join() + "|on" + s.prefs.onion;
    if (!force && this.composite && this.compKey === key) return;
    this.compKey = key;
    const onion = { mode: s.prefs.onion, max: 3 } as const;
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
    // hover cursor: outline with a transparent centre; the eraser shares the
    // same square-footprint marker as the pencil (identical brush algorithm)
    const cu = this.cursor;
    if (cu) {
      const sz = Math.max(2, cu.size * z);
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 1.2;
      ctx.strokeRect(this.ox + cu.x * z, this.oy + cu.y * z, sz, sz);
    }
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
    this.cancelPickTimer();
    this.pickMode = false;
    if (this.pointers.size >= 2) {
      if (this.stroke) {
        // second finger = pinch zoom: a stroke that only placed its start dot
        // must be rolled back, or every pinch would leave a stray pixel
        if (this.gestureMoved) {
          const rec = this.stroke.commit(this.session.history, this.labelFor(this.stroke.kind));
          this.session.repaint();
          if (rec) this.session.changed();
        } else {
          this.stroke.cancel();
          this.session.repaint();
        }
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
      return;
    }
    // flush an unfinished gesture left by a lost pointerup (e.g. rapid bucket taps)
    if (this.stroke) {
      const rec = this.stroke.commit(this.session.history, this.labelFor(this.stroke.kind));
      this.stroke = null;
      this.session.repaint();
      if (rec) this.session.changed();
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
      const c = s.sampleComposite(pp.x, pp.y);
      if (c) s.setFgColor(c);
      return;
    }
    if (tool === "wand") {
      s.wandAt(pp.x, pp.y);
      return;
    }
    this.gestureMoved = false;
    this.gestureStartPx = pp;
    try {
      this.stroke = new Stroke(doc, s.curLayer(), s.curFrame(), tool as never, s.brush(), s.layerLocked(), s.sym, s.shapeSides, s.shapeFill);
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
    const ppx = this.screenToPixel(pt.x, pt.y);
    // pending pick: cancels only when the finger moves to another pixel cell
    if (wasDown && this.longT !== null && this.pickAnchor) {
      if (ppx.x !== this.pickAnchor[0] || ppx.y !== this.pickAnchor[1]) this.cancelPickTimer();
    }
    // pick mode: sample whatever cell the finger is over until release
    if (this.pickMode && wasDown && this.pointers.size === 1) {
      this.samplePickCell(ppx.x, ppx.y, false);
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
      this.refresh(false);
      return;
    }
    if (this.panLast) {
      this.ox += pt.x - this.panLast.x;
      this.oy += pt.y - this.panLast.y;
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
      // keep the erase/draw footprint marker glued to the finger while stroking
      if (pp.x >= 0 && pp.y >= 0 && pp.x < this.session.doc.w && pp.y < this.session.doc.h) {
        this.cursor = { x: pp.x, y: pp.y, size: this.session.brushSize };
      }
      this.stroke.moveTo(pp.x, pp.y, e.pointerType === "pen" ? e.pressure : 1);
      this.session.repaint();
      return;
    }
    if (this.selDrag) {
      const pp = this.screenToPixel(pt.x, pt.y);
      this.selMove(pp);
      return;
    }
    // hover
    const drawing = ["pencil", "eraser", "bucket", "line", "rect", "ellipse", "circle", "polygon"].includes(this.session.tool);
    this.cursor = drawing && ppx.x >= 0 && ppx.y >= 0 && ppx.x < this.session.doc.w && ppx.y < this.session.doc.h
      ? { x: ppx.x, y: ppx.y, size: this.session.brushSize }
      : null;
    this.drawOverlay();
  }

  private onUp(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinchBase = null;
    if (this.pointers.size === 0) {
      if (this.longT !== null) {
        window.clearTimeout(this.longT);
        this.longT = null;
      }
      this.pickMode = false;
      this.pickAnchor = null;
      this.pickLast = null;
      if (this.xf) this.endXf();
      const pt = this.evPt(e);
      const now = Date.now();
      const secondTapMoved = this.stroke ? this.gestureMoved : false;
      const isDouble = this.lastTapPt !== null && now - this.lastTap < 300 &&
        Math.hypot(pt.x - this.lastTapPt.x, pt.y - this.lastTapPt.y) < 48;
      if (isDouble && !secondTapMoved) {
        // double-tap zoom must not paint: roll back the first tap's dot
        // (its history entry is still on top) and cancel the second tap's stroke
        if (this.stroke) {
          this.stroke.cancel();
          this.stroke = null;
        }
        if (this.lastTapWasDraw && this.lastTapChanged && this.session.history.canUndo()) {
          this.session.undo();
        } else {
          this.session.repaint();
        }
        if (this.selDrag) this.endSelDrag();
        this.panLast = null;
        this.gestureMoved = false;
        this.lastTap = 0;
        this.lastTapPt = null;
        this.zoomAt(this.zoom * 2, pt.x, pt.y);
        return;
      }
      if (this.stroke) {
        const rec = this.stroke.commit(this.session.history, this.labelFor(this.stroke.kind));
        this.stroke = null;
        this.session.repaint();
        if (rec) this.session.changed();
        this.lastTapWasDraw = !this.gestureMoved;
        this.lastTapChanged = !!rec;
      } else {
        this.lastTapWasDraw = false;
        this.lastTapChanged = false;
      }
      this.gestureMoved = false;
      this.panLast = null;
      if (this.selDrag) this.endSelDrag();
      this.lastTap = now;
      this.lastTapPt = pt;
    }
  }

  private onCancel(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
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
    this.selDrag = null;
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
    const cx = st.ox + st.content.w / 2, cy = st.oy + st.content.h / 2;
    const dx = (pt.x - this.ox) / this.zoom, dy = (pt.y - this.oy) / this.zoom;
    let mode: "rot" | "scale" = "scale";
    let axis: "xy" | "x" | "y" = "xy";
    if (id === "rot") mode = "rot";
    else if (id === "t" || id === "b") axis = "y";
    else if (id === "l" || id === "r") axis = "x";
    this.xf = { mode, axis, li, fi, st, cx, cy, p0x: dx, p0y: dy, ang0: 0, moved: false };
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
      const base = Math.max(0.5, Math.abs(g.p0x - g.cx));
      sx = clamp(Math.abs(px - g.cx) / base, 0.02, 40);
      if (Math.abs(sx - 1) > 0.004) g.moved = true;
    } else if (g.axis === "y") {
      const base = Math.max(0.5, Math.abs(g.p0y - g.cy));
      sy = clamp(Math.abs(py - g.cy) / base, 0.02, 40);
      if (Math.abs(sy - 1) > 0.004) g.moved = true;
    } else {
      const d0 = Math.max(1, Math.hypot(g.p0x - g.cx, g.p0y - g.cy));
      const f = clamp(Math.hypot(px - g.cx, py - g.cy) / d0, 0.02, 40);
      sx = f; sy = f;
      if (Math.abs(f - 1) > 0.004) g.moved = true;
    }
    if (!g.moved) return;
    xformSelection(doc, g.li, g.fi, g.st, angle, sx, sy);
    this.session.repaint();
  }

  /** transform ended: commit one undo step (or restore when nothing moved) */
  private endXf(): void {
    const g = this.xf;
    this.xf = null;
    if (!g) return;
    const s = this.session;
    const doc = s.doc;
    const cel = doc.celAt(g.li, g.fi);
    if (!cel) return;
    if (!g.moved) {
      cel.data.set(g.st.before);
      if (doc.sel) doc.sel.mask.set(g.st.mask);
      s.repaint();
      return;
    }
    let changed = false;
    const a = cel.data, b = g.st.before;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { changed = true; break; }
    if (changed) {
      s.history.pushPixels(g.mode === "rot" ? "sel.rotate" : "sel.scale", doc, [
        { li: g.li, fi: g.fi, before: g.st.before, after: new Uint8ClampedArray(cel.data) },
      ]);
      s.changed();
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
      const self = this;
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
    // move content (absolute offset from the grab origin, idempotent per step)
    const dx = pp.x - g.sx, dy = pp.y - g.sy;
    if (dx || dy) g.moved = true;
    if (g.moved && g.mv) {
      selOps.move(this.session.doc, this.session.curLayer(), this.session.curFrame(), dx, dy, g.mv);
      this.session.repaint();
    }
  }

  private endSelDrag(): void {
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
    // move commit
    const li = s.curLayer(), fi = s.curFrame();
    const cel = doc.celAt(li, fi);
    if (g.moved && cel && g.before) {
      let changed = false;
      const a = cel.data, b = g.before;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { changed = true; break; }
      if (changed) {
        s.history.pushPixels("sel.move", doc, [
          { li, fi, before: g.before, after: new Uint8ClampedArray(cel.data) },
        ]);
      }
    }
    this.session.repaint();
    this.session.changed();
  }

  // quick color helper (export convenience)
  static hexToRgbaStatic(hex: string): RGBA {
    return hexToRgba(hex);
  }
}
