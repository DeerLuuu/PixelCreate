// Per-gesture stroke engine for drawing tools.
import type { Doc } from "../engine/doc";
import { Cel } from "../engine/cel";
import type { RGBA } from "../engine/types";
import { squareCells, brushStamp, lineCells, floodFill, floodErase, globalFill, globalErase, paintAt, eraseAt, type MaskFn } from "../engine/paint";
import { ellipseFill, ellipseOutline } from "../engine/shape";
import type { History } from "../engine/history";
import type { BrushState, SymMode } from "./registry";
import { rgba } from "../engine/color";

export type ToolKind = "pencil" | "eraser" | "bucket" | "line" | "rect" | "ellipse" | "circle" | "polygon";

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
  /** mirror-line angle (degrees, 0 = horizontal); direction unit cached */
  private readonly ux: number;
  private readonly uy: number;
  /** also mirror across the perpendicular axis (four-way symmetry) */
  private readonly symFour: boolean;
  /** bucket: fill every matching pixel in the layer instead of the connected region */
  private readonly bucketGlobal: boolean;
  color: RGBA;
  size: number;
  last: [number, number] | null = null;
  start: [number, number] | null = null;
  private everPainted = false;

  constructor(doc: Doc, li: number, fi: number, kind: ToolKind, brush: BrushState, layerLocked: boolean, sym: SymMode, shapeSides = 6, fill = true, ox = 0, oy = 0, angDeg = 90, symFour = false, bucketGlobal = false) {
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
    const rad = (angDeg * Math.PI) / 180;
    this.ux = Math.cos(rad);
    this.uy = Math.sin(rad);
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

  /** reflect one cell centre across the mirror line through (px,py) with unit direction (ux,uy) */
  private reflCell(x: number, y: number, px: number, py: number, ux: number, uy: number): [number, number] {
    const cx = x + 0.5 - px, cy = y + 0.5 - py;
    const dot = cx * ux + cy * uy;
    return [
      Math.round(px + 2 * dot * ux - cx - 0.5),
      Math.round(py + 2 * dot * uy - cy - 0.5),
    ];
  }

  /** mirror-coordinate expansion for the current mode: the axis is the line
   *  through the doc centre offset (ox,oy) rotated to angDeg; if four-way is
   *  on, the perpendicular axis through the same pivot is added (4 images) */
  private mirrorPts(x: number, y: number): [number, number][] {
    if (this.sym === "off") return [[x, y]];
    const px = this.doc.w / 2 + this.ox;
    const py = this.doc.h / 2 + this.oy;
    const out: [number, number][] = [[x, y]];
    out.push(this.reflCell(x, y, px, py, this.ux, this.uy));
    if (this.symFour) {
      const u2x = -this.uy, u2y = this.ux;
      const m2 = this.reflCell(x, y, px, py, u2x, u2y);
      out.push(m2);
      out.push(this.reflCell(m2[0], m2[1], px, py, this.ux, this.uy));
    }
    return out;
  }

  /** paint/erase a single cell plus all its symmetric partners */
  private touch(x: number, y: number): boolean {
    let any = false;
    for (const [X, Y] of this.mirrorPts(x, y)) {
      if (this.color[3] === 0 ? eraseAt(this.cel, X, Y, this.mask) : paintAt(this.cel, X, Y, this.color, this.mask)) any = true;
    }
    return any;
  }

  private touchErase(x: number, y: number): boolean {
    let any = false;
    for (const [X, Y] of this.mirrorPts(x, y)) {
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
      case "bucket":
        break;
    }
    this.last = [x, y];
  }

  private paintDot(x: number, y: number, size: number): void {
    for (const [ox, oy] of brushStamp(size).cells) {
      if (this.touch(x + ox, y + oy)) this.everPainted = true;
    }
  }
  private eraseDot(x: number, y: number, size: number): void {
    for (const [ox, oy] of brushStamp(size).cells) {
      if (this.touchErase(x + ox, y + oy)) this.everPainted = true;
    }
  }

  private resetToBefore(): void {
    if (this.before) this.cel.data.set(this.before);
    else this.cel.data.fill(0);
  }

  private redrawShape(x: number, y: number): void {
    const s = this.start!;
    const xa = Math.min(s[0], x), xb = Math.max(s[0], x);
    const ya = Math.min(s[1], y), yb = Math.max(s[1], y);
    const erase = this.color[3] === 0;
    const paint = (px: number, py: number) => {
      for (const [X, Y] of this.mirrorPts(px, py)) {
        if (erase ? eraseAt(this.cel, X, Y, this.mask) : paintAt(this.cel, X, Y, this.color, this.mask)) this.everPainted = true;
      }
    };
    // stamp the brush over a cell (lines & hollow outlines use brushSize as
    // their stroke thickness, like Aseprite's line tool)
    const stamp = (px: number, py: number) => {
      for (const [dx, dy] of squareCells(px, py, this.size)) paint(dx, dy);
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
