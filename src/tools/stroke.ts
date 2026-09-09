// Per-gesture stroke engine for drawing tools.
import type { Doc } from "../engine/doc";
import { Cel } from "../engine/cel";
import type { RGBA, Rect } from "../engine/types";
import { brushStamp, lineCells, floodFill, floodErase, globalFill, globalErase, paintAt, eraseAt, sprayDots, type BrushShape, type MaskFn } from "../engine/paint";
import { mirrorCells, type SymAxis } from "../engine/symmetry";
import { ellipseFill, ellipseOutline } from "../engine/shape";
import type { History } from "../engine/history";
import type { BrushState, SymMode } from "./registry";
import { rgba } from "../engine/color";

export type ToolKind = "pencil" | "eraser" | "bucket" | "airbrush" | "line" | "rect" | "ellipse" | "circle" | "polygon";

export class Stroke {
  readonly doc: Doc;
  readonly li: number;
  readonly fi: number;
  readonly kind: ToolKind;
  readonly cel: Cel;
  readonly before: Uint8ClampedArray | null;
  readonly mask: MaskFn | null;
  readonly sym: SymMode;
  readonly shapeSides: number;
  readonly fill: boolean;
  /** mirror-axis pivot offsets from the doc centre (doc gridline units) */
  readonly ox: number;
  readonly oy: number;
  /** mirror-line angle (degrees, 0 = horizontal) */
  private readonly angDeg: number;
  /** also mirror across the perpendicular axis (four-way symmetry) */
  private readonly symFour: boolean;
  /** bucket: fill every matching pixel in the layer instead of the connected region */
  private readonly bucketGlobal: boolean;
  /** round disc or square block brush tip */
  readonly brushShape: BrushShape;
  /** shapes grow outwards from the touch point instead of the corner */
  readonly shapeFromCenter: boolean;
  /** airbrush: random speck size range in px (set by the view from prefs) */
  sprayMin = 1;
  sprayMax = 3;
  color: RGBA;
  size: number;
  last: [number, number] | null = null;
  start: [number, number] | null = null;
  private everPainted = false;
  /** bounding box of everything touched since the last takeDirty() (doc space) */
  private dty: { x0: number; y0: number; x1: number; y1: number } | null = null;
  /** the whole frame changed (flood fill / shape reset): no useful box */
  private dtyAll = false;
  /** bounding box of the shape drawn so far (a shape redraws from scratch, so
   *  the previous outline has to be repainted as well) */
  private shapeBox: { x0: number; y0: number; x1: number; y1: number } | null = null;

  constructor(doc: Doc, li: number, fi: number, kind: ToolKind, brush: BrushState, layerLocked: boolean, sym: SymMode, shapeSides = 6, fill = true, ox = 0, oy = 0, angDeg = 90, symFour = false, bucketGlobal = false,
              brushShape: BrushShape = "circle", shapeFromCenter = false) {
    this.doc = doc;
    this.li = li;
    this.fi = fi;
    this.kind = kind;
    this.sym = sym;
    this.shapeSides = Math.max(3, Math.min(32, Math.round(shapeSides) || 6));
    this.fill = fill;
    this.ox = ox;
    this.oy = oy;
    this.symFour = symFour;
    this.bucketGlobal = bucketGlobal;
    this.brushShape = brushShape;
    this.shapeFromCenter = shapeFromCenter;
    this.angDeg = angDeg;
    if (layerLocked) throw new Error("layer-locked");
    const cel = doc.celAt(li, fi);
    this.before = cel ? new Uint8ClampedArray(cel.data) : null;
    if (!cel) doc.ensureCel(li, fi);
    this.cel = doc.celAt(li, fi)!;
    const a = brush.color[3] === undefined ? 255 : Math.max(0, Math.min(255, Math.round(brush.color[3])));
    this.color = rgba(brush.color[0], brush.color[1], brush.color[2], a);
    this.size = Math.max(1, Math.round(brush.size));
    this.mask = doc.selectionActive() ? (x: number, y: number) => doc.selAt(x, y) === 1 : null;
  }

  /** the axis description handed to the shared symmetry helper */
  private symAxis(): SymAxis {
    return { on: this.sym !== "off", four: this.symFour, ox: this.ox, oy: this.oy, angDeg: this.angDeg };
  }

  /** mirror-coordinate expansion for the current mode (shared with the
   *  selection tools so a symmetric selection matches a symmetric stroke) */
  private mirrorPts(x: number, y: number): Array<[number, number]> {
    return mirrorCells(x, y, this.doc.w, this.doc.h, this.symAxis());
  }

  private markCell(x: number, y: number): void {
    if (x < 0 || y < 0 || x >= this.doc.w || y >= this.doc.h) return;
    const d = this.dty;
    if (!d) this.dty = { x0: x, y0: y, x1: x, y1: y };
    else {
      if (x < d.x0) d.x0 = x;
      if (x > d.x1) d.x1 = x;
      if (y < d.y0) d.y0 = y;
      if (y > d.y1) d.y1 = y;
    }
  }
  /** mark a bounding box (corners are clamped: a shape may extend past the
   *  frame, and a dropped corner would silently shrink the dirty region) */
  private markBox(b: { x0: number; y0: number; x1: number; y1: number } | null): void {
    if (!b) return;
    const cx = (v: number, n: number): number => Math.max(0, Math.min(n - 1, v));
    this.markCell(cx(b.x0, this.doc.w), cx(b.y0, this.doc.h));
    this.markCell(cx(b.x1, this.doc.w), cx(b.y1, this.doc.h));
  }

  /** Take the changed region since the previous call (null = nothing painted).
   *  The view uses it to recomposite and repaint only that part of the screen. */
  takeDirty(): Rect | null {
    if (this.dtyAll) {
      this.dtyAll = false;
      this.dty = null;
      return { x: 0, y: 0, w: this.doc.w, h: this.doc.h };
    }
    const d = this.dty;
    this.dty = null;
    if (!d) return null;
    return { x: d.x0, y: d.y0, w: d.x1 - d.x0 + 1, h: d.y1 - d.y0 + 1 };
  }

  /** paint/erase a single cell plus all its symmetric partners */
  private touch(x: number, y: number): boolean {
    let any = false;
    for (const [X, Y] of this.mirrorPts(x, y)) {
      this.markCell(X, Y);
      if (this.color[3] === 0 ? eraseAt(this.cel, X, Y, this.mask) : paintAt(this.cel, X, Y, this.color, this.mask)) any = true;
    }
    return any;
  }

  private touchErase(x: number, y: number): boolean {
    let any = false;
    for (const [X, Y] of this.mirrorPts(x, y)) {
      this.markCell(X, Y);
      if (eraseAt(this.cel, X, Y, this.mask)) any = true;
    }
    return any;
  }

  /** Place starting dot (or fill/pick behavior for single-shot tools). */
  startAt(x: number, y: number): void {
    this.start = [x, y];
    this.last = [x, y];
    switch (this.kind) {
      case "pencil":
        this.paintDot(x, y, this.size);
        break;
      case "eraser":
        this.eraseDot(x, y, this.size);
        break;
      case "airbrush":
        this.sprayBurst(1); // one speck right away, so a tap leaves a mark
        break;
      case "bucket":
        // contiguous (default) or global: every matching pixel in the layer
        if (this.color[3] === 0) {
          if (this.bucketGlobal) globalErase(this.cel, x, y, this.mask);
          else floodErase(this.cel, x, y, this.mask);
        } else {
          if (this.bucketGlobal) globalFill(this.cel, x, y, this.color, this.mask);
          else floodFill(this.cel, x, y, this.color, this.mask);
        }
        this.everPainted = true; // flood fill writes pixels directly
        this.dtyAll = true; // the filled region can be the whole layer
        break;
      default:
        this.redrawShape(x, y);
    }
  }

  moveTo(x: number, y: number, pressure: number): void {
    switch (this.kind) {
      case "pencil": {
        let size = this.size;
        if (pressure > 0 && pressure < 1) size = Math.max(1, Math.round(this.size * (0.35 + pressure * 0.9)));
        const self = this;
        if (this.last) lineCells(this.last[0], this.last[1], x, y, (px, py) => self.paintDot(px, py, size));
        else this.paintDot(x, y, size);
        break;
      }
      case "eraser": {
        const self = this;
        if (this.last) lineCells(this.last[0], this.last[1], x, y, (px, py) => self.eraseDot(px, py, this.size));
        else this.eraseDot(x, y, this.size);
        break;
      }
      case "line":
      case "rect":
      case "ellipse":
      case "circle":
      case "polygon":
        // shapes redraw from pristine start
        this.resetToBefore();
        this.redrawShape(x, y);
        break;
      case "airbrush":
        // the spray is time-driven (see View's interval): moving only retargets it
        break;
      case "bucket":
        break;
    }
    this.last = [x, y];
  }

  /** Airbrush burst at the last pointer position: `count` random specks whose
   *  size is drawn from [sprayMin, sprayMax] inside the brush-size disc. */
  sprayBurst(count: number): void {
    const p = this.last;
    if (!p) return;
    const self = this;
    // brush size is a diameter: a 1px brush sprays exactly under the finger
    sprayDots(p[0], p[1], Math.max(0, (this.size - 1) / 2), this.sprayMin, this.sprayMax, count, Math.random,
      (x, y) => { if (self.touch(x, y)) self.everPainted = true; });
  }

  private paintDot(x: number, y: number, size: number): void {
    for (const [ox, oy] of brushStamp(size, this.brushShape).cells) {
      if (this.touch(x + ox, y + oy)) this.everPainted = true;
    }
  }
  private eraseDot(x: number, y: number, size: number): void {
    for (const [ox, oy] of brushStamp(size, this.brushShape).cells) {
      if (this.touchErase(x + ox, y + oy)) this.everPainted = true;
    }
  }

  private resetToBefore(): void {
    if (this.before) this.cel.data.set(this.before);
    else this.cel.data.fill(0);
    // the previous outline of the same shape has to be repainted too
    this.markBox(this.shapeBox);
  }

  private redrawShape(x: number, y: number): void {
    const s = this.start!;
    // "from centre": the touch point is the middle, the drag defines the radius
    const sym = this.shapeFromCenter && this.kind !== "line";
    const xa = sym ? s[0] - Math.abs(x - s[0]) : Math.min(s[0], x);
    const xb = sym ? s[0] + Math.abs(x - s[0]) : Math.max(s[0], x);
    const ya = sym ? s[1] - Math.abs(y - s[1]) : Math.min(s[1], y);
    const yb = sym ? s[1] + Math.abs(y - s[1]) : Math.max(s[1], y);
    const erase = this.color[3] === 0;
    // the brush stamp widens every drawn cell by half the brush size
    const pad = Math.max(1, Math.ceil(this.size / 2));
    const box = { x0: xa - pad, y0: ya - pad, x1: xb + pad, y1: yb + pad };
    this.markBox(this.shapeBox);
    this.shapeBox = box;
    const paint = (px: number, py: number) => {
      for (const [X, Y] of this.mirrorPts(px, py)) {
        this.markCell(X, Y);
        if (erase ? eraseAt(this.cel, X, Y, this.mask) : paintAt(this.cel, X, Y, this.color, this.mask)) this.everPainted = true;
      }
    };
    // stamp the brush over a cell (lines & hollow outlines use brushSize as
    // their stroke thickness, like Aseprite's line tool)
    const stamp = (px: number, py: number) => {
      for (const [dx, dy] of brushStamp(this.size, this.brushShape).cells) paint(px + dx, py + dy);
    };
    if (this.kind === "line") {
      lineCells(s[0], s[1], x, y, stamp);
      return;
    }
    // ---- Aseprite-synced ellipse / circle (Zingl raster, ported 1:1 from
    // aseprite/src/doc/algo.cpp) ----
    if (this.kind === "ellipse" || this.kind === "circle") {
      let ex0 = xa, ex1 = xb, ey0 = ya, ey1 = yb;
      if (this.kind === "circle") {
        const cxc = Math.round((xa + xb) / 2);
        const cyc = Math.round((ya + yb) / 2);
        const R = Math.max(1, Math.floor(Math.min(Math.abs(xb - xa), Math.abs(yb - ya)) / 2));
        ex0 = cxc - R; ex1 = cxc + R; ey0 = cyc - R; ey1 = cyc + R;
      }
      if (this.fill) {
        ellipseFill(ex0, ey0, ex1, ey1, (l, yy, r) => {
          for (let xx = l; xx <= r; xx++) paint(xx, yy);
        });
      } else {
        ellipseOutline(ex0, ey0, ex1, ey1, stamp);
      }
      return;
    }

    // ---- rect / polygon: unified scan; outline = 1px border of the filled set ----
    let inside: (px: number, py: number) => boolean;
    if (this.kind === "rect") {
      inside = (px, py) => px >= xa && px <= xb && py >= ya && py <= yb;
    } else {
      // regular polygon (n sides) inside a square-ish box
      const n = this.shapeSides;
      const cxp = Math.round((xa + xb) / 2);
      const cyp = Math.round((ya + yb) / 2);
      const rp = Math.max(1, Math.floor(Math.min(Math.abs(xb - xa), Math.abs(yb - ya)) / 2));
      const pts: Array<[number, number]> = [];
      for (let k = 0; k < n; k++) {
        const ang = -Math.PI / 2 + (k * 2 * Math.PI) / n;
        pts.push([cxp + rp * Math.cos(ang), cyp + rp * Math.sin(ang)]);
      }
      inside = (px, py) => {
        let inP = false;
        for (let i = 0, j = n - 1; i < n; j = i++) {
          const a = pts[i], b = pts[j];
          if (a[1] > py !== b[1] > py && px < ((b[0] - a[0]) * (py - a[1])) / (b[1] - a[1]) + a[0]) inP = !inP;
        }
        return inP;
      };
    }
    const filled = this.fill;
    for (let yy = ya; yy <= yb; yy++) {
      for (let xx = xa; xx <= xb; xx++) {
        if (!inside(xx, yy)) continue;
        if (filled) { paint(xx, yy); continue; }
        const border =
          !inside(xx + 1, yy) || !inside(xx - 1, yy) ||
          !inside(xx, yy + 1) || !inside(xx, yy - 1);
        if (border) stamp(xx, yy);
      }
    }
  }

  private changed(): boolean {
    if (!this.everPainted) return false;
    const d = this.cel.data;
    if (this.before) {
      const b = this.before;
      for (let i = 0; i < d.length; i++) if (d[i] !== b[i]) return true;
      return false;
    }
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
    return false;
  }

  /** Commit into history; returns true when an undo step was recorded. */
  commit(history: History, label: string): boolean {
    if (!this.changed()) {
      // no real change -> remove a cel we created in vain
      if (!this.before && this.cel && !this.cel.hasAnyOpaque()) {
        this.doc.cels.delete(this.doc.key(this.li, this.fi));
      }
      return false;
    }
    history.pushPixels(label, this.doc, [
      { li: this.li, fi: this.fi, before: this.before, after: new Uint8ClampedArray(this.cel.data) },
    ]);
    return true;
  }

  cancel(): void {
    if (this.before) this.cel.data.set(this.before);
    else this.doc.cels.delete(this.doc.key(this.li, this.fi));
  }
}
