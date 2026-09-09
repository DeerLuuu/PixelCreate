// Pixel-level drawing algorithms operating directly on Cel buffers.
import { Cel } from "./cel";
import { mirrorCells, type SymAxis } from "./symmetry";
import type { RGBA } from "./types";
import { blendOver, writePixel } from "./color";

export type MaskFn = (x: number, y: number) => boolean;

export function paintAt(cel: Cel, x: number, y: number, c: RGBA, mask?: MaskFn | null): boolean {
  if (!cel.inBounds(x, y)) return false;
  if (mask && !mask(x, y)) return false;
  const i = cel.idx(x, y);
  if (c[3] >= 255) writePixel(cel.data, i, c);
  else if (c[3] > 0) blendOver(cel.data, i, c);
  return true;
}

export function eraseAt(cel: Cel, x: number, y: number, mask?: MaskFn | null): boolean {
  if (!cel.inBounds(x, y)) return false;
  if (mask && !mask(x, y)) return false;
  const i = cel.idx(x, y);
  cel.data[i] = 0; cel.data[i + 1] = 0; cel.data[i + 2] = 0; cel.data[i + 3] = 0;
  return true;
}

/** Scanline-fill a closed polygon, calling fn(x, y) for every pixel inside.
 *  Even-odd rule; the path is closed implicitly (last → first point), so a
 *  freehand outline drawn by the user becomes the filled region. */
export function polygonCells(w: number, h: number, pts: Array<[number, number]>, fn: (x: number, y: number) => void): void {
  const n = pts.length;
  if (n < 3 || w <= 0 || h <= 0) return;
  for (let y = 0; y < h; y++) {
    const xs: number[] = [];
    for (let i = 0; i < n; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % n];
      if ((y0 <= y && y < y1) || (y1 <= y && y < y0)) {
        xs.push(x0 + ((x1 - x0) * (y - y0)) / (y1 - y0));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k]));
      const xb = Math.min(w - 1, Math.floor(xs[k + 1]));
      for (let x = xa; x <= xb; x++) fn(x, y);
    }
  }
}

/** Fill a closed freehand path into a cel: scanline raster + optional symmetry
 *  mirror + optional selection mask. Returns the bounding box of the cells the
 *  paint actually touched (null = nothing was painted). */
export function fillPolygon(cel: Cel, w: number, h: number, pts: Array<[number, number]>, color: RGBA,
                            mask?: MaskFn | null, ax?: SymAxis,
                            wrap?: { x: boolean; y: boolean }): { x: number; y: number; w: number; h: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const put = (mx: number, my: number): void => {
    if (mx < 0 || my < 0 || mx >= w || my >= h) return;
    if (!paintAt(cel, mx, my, color, mask)) return;
    if (mx < x0) x0 = mx;
    if (my < y0) y0 = my;
    if (mx > x1) x1 = mx;
    if (my > y1) y1 = my;
  };
  polygonCells(w, h, pts, (x, y) => {
    const targets = ax ? mirrorCells(x, y, w, h, ax) : [[x, y]] as Array<[number, number]>;
    for (const [mx, my] of targets) {
      put(mx, my);
      // tiled mode: the same cell also lands on the opposite edges
      if (wrap?.x) { put(mx - w, my); put(mx + w, my); }
      if (wrap?.y) { put(mx, my - h); put(mx, my + h); }
      if (wrap?.x && wrap?.y) { put(mx - w, my - h); put(mx + w, my + h); put(mx - w, my + h); put(mx + w, my - h); }
    }
  });
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Airbrush: sample `count` random specks uniformly inside a disc of `radius`
 *  centred on (cx,cy). Every speck is an axis-aligned square whose side is a
 *  random integer in [minSize, maxSize] px (the random dot-size range the
 *  airbrush settings expose). `rnd` returns [0,1) so tests can seed it; fn is
 *  called for every cell of every speck (overlaps are possible and harmless). */
export function sprayDots(cx: number, cy: number, radius: number, minSize: number, maxSize: number,
                          count: number, rnd: () => number, fn: (x: number, y: number) => void): void {
  const r = Math.max(0, radius);
  const lo = Math.max(1, Math.round(minSize));
  const hi = Math.max(lo, Math.round(maxSize));
  for (let i = 0; i < count; i++) {
    const ang = rnd() * Math.PI * 2;
    const rad = r * Math.sqrt(rnd()); // sqrt keeps the density uniform over the disc
    const px = Math.round(cx + Math.cos(ang) * rad);
    const py = Math.round(cy + Math.sin(ang) * rad);
    const s = lo + Math.floor(rnd() * (hi - lo + 1));
    const o = Math.floor(s / 2);
    for (let dy = 0; dy < s; dy++) {
      for (let dx = 0; dx < s; dx++) fn(px - o + dx, py - o + dy);
    }
  }
}

/** Bresenham line: calls fn for every cell. */
export function lineCells(x0: number, y0: number, x1: number, y1: number, fn: (x: number, y: number) => void): void {
  let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    fn(x0, y0);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

/** Bucket fill options: per-channel tolerance and gap closing (see
 *  buildBarrier). Both default to 0 = the classic exact-match, no-gap fill. */
export interface FillOpts {
  /** per-channel tolerance 0..255 (Aseprite compares every channel with <=) */
  tolerance?: number;
  /** close boundary gaps up to this many px before filling (0 = off) */
  gaps?: number;
  /** tiled mode: the fill wraps around the canvas edges (seamless tiles) */
  wrapX?: boolean;
  wrapY?: boolean;
}

/** true when the pixel at `i` is within `tol` of `base` on every channel */
function nearPixel(d: Uint8ClampedArray, i: number, base: number[], tol: number): boolean {
  return Math.abs(d[i] - base[0]) <= tol && Math.abs(d[i + 1] - base[1]) <= tol &&
    Math.abs(d[i + 2] - base[2]) <= tol && Math.abs(d[i + 3] - base[3]) <= tol;
}

/** 3x3 (8-neighbour) dilation; out-of-bounds counts as empty */
function dilate8(src: Uint8Array, w: number, h: number, out: Uint8Array): void {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let dy = -1; dy <= 1 && !v; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          if (src[yy * w + xx]) { v = 1; break; }
        }
      }
      out[y * w + x] = v;
    }
  }
}
/** 3x3 erosion; out-of-bounds counts as WALL so an outline that runs along the
 *  canvas edge survives the closing and keeps the fill inside */
function erode8(src: Uint8Array, w: number, h: number, out: Uint8Array): void {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 1;
      for (let dy = -1; dy <= 1 && v; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          if (!src[yy * w + xx]) { v = 0; break; }
        }
      }
      out[y * w + x] = v;
    }
  }
}

/**
 * The barrier a bucket fill must not cross: every pixel that is NOT within
 * `tolerance` of the seed colour (or excluded by the selection mask). With
 * `gaps > 0` the barrier is morphologically CLOSED first (dilate then erode by
 * ceil(gap/2)): small holes in an outline get sealed, while the outline itself
 * comes back to its original thickness so the fill still reaches the line.
 * Returns null when the seed is outside the cel.
 */
export function buildBarrier(cel: Cel, sx: number, sy: number, opts?: FillOpts | null, mask?: MaskFn | null): Uint8Array | null {
  const w = cel.w, h = cel.h, d = cel.data;
  if (!cel.inBounds(sx, sy)) return null;
  const tol = Math.max(0, Math.min(255, Math.round(opts?.tolerance ?? 0)));
  const bi = cel.idx(sx, sy);
  const base = [d[bi], d[bi + 1], d[bi + 2], d[bi + 3]];
  const b = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = cel.idx(x, y);
      if (!nearPixel(d, i, base, tol) || (mask && !mask(x, y))) b[y * w + x] = 1;
    }
  }
  const gap = Math.max(0, Math.min(16, Math.round(opts?.gaps ?? 0)));
  if (!gap) return b;
  const k = Math.max(1, Math.ceil(gap / 2));
  let a = b;
  let tmp = new Uint8Array(w * h);
  for (let n = 0; n < k; n++) { dilate8(a, w, h, tmp); const s = a; a = tmp; tmp = s; }
  for (let n = 0; n < k; n++) { erode8(a, w, h, tmp); const s = a; a = tmp; tmp = s; }
  return a;
}

/** 4-connected flood over the non-barrier cells (seed included). With wrapX /
 *  wrapY the canvas is treated as a torus, so a fill started in a seamless
 *  tile spills over the edge and continues on the opposite side. */
export function floodCells(cel: Cel, sx: number, sy: number, barrier: Uint8Array,
                           wrapX = false, wrapY = false): Array<[number, number]> {
  const w = cel.w, h = cel.h;
  const out: Array<[number, number]> = [];
  const seen = new Uint8Array(w * h);
  const stack: Array<[number, number]> = [[sx, sy]];
  const nx = (x: number, dx: number): number => (wrapX ? (x + dx + w) % w : x + dx);
  const ny = (y: number, dy: number): number => (wrapY ? (y + dy + h) % h : y + dy);
  while (stack.length) {
    const [x, y] = stack.pop()!;
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const vi = y * w + x;
    if (seen[vi]) continue;
    seen[vi] = 1;
    if (barrier[vi]) continue;
    out.push([x, y]);
    stack.push([nx(x, 1), y], [nx(x, -1), y], [x, ny(y, 1)], [x, ny(y, -1)]);
  }
  return out;
}


export function floodErase(cel: Cel, sx: number, sy: number, mask?: MaskFn | null, opts?: FillOpts): void {
  if (!cel.inBounds(sx, sy)) return;
  if (cel.data[cel.idx(sx, sy) + 3] === 0) return;
  const b = buildBarrier(cel, sx, sy, opts, mask);
  if (!b || b[sy * cel.w + sx]) return;
  for (const [x, y] of floodCells(cel, sx, sy, b, !!opts?.wrapX, !!opts?.wrapY)) {
    const i = (y * cel.w + x) * 4;
    cel.data[i] = 0; cel.data[i + 1] = 0; cel.data[i + 2] = 0; cel.data[i + 3] = 0;
  }
}

/** Flood fill with optional tolerance and gap closing, optional selection mask. */
export function floodFill(cel: Cel, sx: number, sy: number, color: RGBA, mask?: MaskFn | null, opts?: FillOpts): void {
  if (!cel.inBounds(sx, sy)) return;
  const b = buildBarrier(cel, sx, sy, opts, mask);
  if (!b || b[sy * cel.w + sx]) return;
  for (const [x, y] of floodCells(cel, sx, sy, b, !!opts?.wrapX, !!opts?.wrapY)) paintAt(cel, x, y, color, null);
}

/** Collect the cells a bucket fill would cover: the connected same-colour
 *  region (global = false) or every matching cell in the layer (global = true),
 *  honouring an optional selection mask, tolerance and gap closing. Pure. */
export function floodRegion(cel: Cel, sx: number, sy: number, global: boolean, mask?: MaskFn | null, opts?: FillOpts): Array<[number, number]> {
  if (!cel.inBounds(sx, sy)) return [];
  const b = buildBarrier(cel, sx, sy, opts, mask);
  if (!b) return [];
  if (global) {
    const out: Array<[number, number]> = [];
    for (let y = 0; y < cel.h; y++) for (let x = 0; x < cel.w; x++) if (!b[y * cel.w + x]) out.push([x, y]);
    return out;
  }
  if (b[sy * cel.w + sx]) return [];
  return floodCells(cel, sx, sy, b, !!opts?.wrapX, !!opts?.wrapY);
}

/** gradient direction: from (x0,y0) along (dx,dy). A null axis = automatic
 *  top-to-bottom ramp over the region's bounding box. */
export interface GradAxis { x0: number; y0: number; dx: number; dy: number }

/** Paint a region with a linear RGB ramp: `c0` at the start of the axis, `c1`
 *  at its end (Aseprite-style: the drag defines direction AND length; cells
 *  beyond either end clamp to c0 / c1). `block` snaps the ramp to block x block
 *  tiles (1 = smooth per-pixel), so 2/4/8 give chunky pixel-art gradients.
 *  Returns the bbox touched. */
export function gradientFillRegion(cel: Cel, cells: Array<[number, number]>,
                                   c0: RGBA, c1: RGBA, block: number, axis: GradAxis | null,
                                   mask?: MaskFn | null): { x: number; y: number; w: number; h: number } | null {
  if (!cells.length) return null;
  const b = Math.max(1, Math.round(block));
  // each tile shares one colour, sampled at the tile centre
  const anchor = (v: number): number => Math.floor(v / b) * b + (b - 1) / 2;
  let ax = axis;
  if (!ax) {
    // no drag: a vertical ramp over the region's bounding box
    let ymin = Infinity, ymax = -Infinity;
    for (const [, y] of cells) {
      const a = anchor(y);
      if (a < ymin) ymin = a;
      if (a > ymax) ymax = a;
    }
    ax = { x0: 0, y0: ymin, dx: 0, dy: ymax - ymin };
  }
  const len2 = ax.dx * ax.dx + ax.dy * ax.dy;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of cells) {
    const t = len2 > 0
      ? Math.max(0, Math.min(1, ((anchor(x) - ax.x0) * ax.dx + (anchor(y) - ax.y0) * ax.dy) / len2))
      : 0;
    const c: RGBA = [
      Math.round(c0[0] + (c1[0] - c0[0]) * t),
      Math.round(c0[1] + (c1[1] - c0[1]) * t),
      Math.round(c0[2] + (c1[2] - c0[2]) * t),
      Math.round(c0[3] + (c1[3] - c0[3]) * t),
    ];
    if (!paintAt(cel, x, y, c, mask)) continue;
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Non-contiguous fill: replace EVERY pixel of the cel within `tolerance` of
 *  the seed colour, honouring an optional selection mask. Unlike floodFill this
 *  ignores connectivity, so all matching pixels anywhere in the layer are
 *  filled in one go. */
export function globalFill(cel: Cel, sx: number, sy: number, color: RGBA, mask?: MaskFn | null, opts?: FillOpts): void {
  const w = cel.w, h = cel.h, d = cel.data;
  if (!cel.inBounds(sx, sy)) return;
  const bi = cel.idx(sx, sy);
  const base = [d[bi], d[bi + 1], d[bi + 2], d[bi + 3]];
  // filling with the colour that is already there would be a no-op
  if (color[0] === base[0] && color[1] === base[1] && color[2] === base[2] && color[3] === base[3]) return;
  const tol = Math.max(0, Math.min(255, Math.round(opts?.tolerance ?? 0)));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = cel.idx(x, y);
      if (!nearPixel(d, i, base, tol)) continue;
      if (mask && !mask(x, y)) continue;
      paintAt(cel, x, y, color, null);
    }
  }
}

/** Non-contiguous erase: clear every pixel within `tolerance` of the seed. */
export function globalErase(cel: Cel, sx: number, sy: number, mask?: MaskFn | null, opts?: FillOpts): void {
  const w = cel.w, h = cel.h, d = cel.data;
  if (!cel.inBounds(sx, sy)) return;
  const bi = cel.idx(sx, sy);
  const base = [d[bi], d[bi + 1], d[bi + 2], d[bi + 3]];
  if (base[3] === 0) return;
  const tol = Math.max(0, Math.min(255, Math.round(opts?.tolerance ?? 0)));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = cel.idx(x, y);
      if (!nearPixel(d, i, base, tol)) continue;
      if (mask && !mask(x, y)) continue;
      d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = 0;
    }
  }
}

/**
 * Aseprite-style dot brush stamp, ported from aseprite source
 * (src/doc/brush.cpp Brush::regenerate + src/doc/algo.cpp algo_ellipsefill,
 * MIT-licensed). Aseprite's default brush is a CIRCLE whose diameter in
 * pixels equals the brush size: the ellipse is inscribed in a size x size
 * box anchored so the box's top-left sits at (cursor - floor(size/2)).
 * Returns centred offsets (relative to the cursor cell) that are painted,
 * plus the outline offsets (cells having an unpainted 4-neighbour).
 */
export interface BrushStamp { size: number; cells: [number, number][]; outline: [number, number][] }
/** brush tip shapes: round disc (default) or a square block */
export type BrushShape = "circle" | "square";
const stampCache = new Map<string, BrushStamp>();

export function brushStamp(size: number, shape: BrushShape = "circle"): BrushStamp {
  const n = Math.max(1, Math.round(size));
  const cacheKey = n + (shape === "square" ? "s" : "c");
  const got = stampCache.get(cacheKey);
  if (got) return got;
  if (shape === "square") {
    // full n×n block; the outline is its border ring
    const cells: [number, number][] = [];
    const outline: [number, number][] = [];
    const o = -Math.floor((n - 1) / 2);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        cells.push([o + x, o + y]);
        if (x === 0 || y === 0 || x === n - 1 || y === n - 1) outline.push([o + x, o + y]);
      }
    }
    const st: BrushStamp = { size: n, cells, outline };
    stampCache.set(cacheKey, st);
    return st;
  }
  const half = Math.floor(n / 2);
  const grid: Uint8Array = new Uint8Array(n * n);
  // Symmetric circle raster: D/E are twice each pixel-centre's distance from
  // the shape centre (pixel grid centred between the middle pixels for even
  // sizes, on the middle pixel for odd sizes). Threshold N*N (even) and
  // N*(N-1) (odd) reproduces the classic silhouettes (1px, 2x2, plus, 12px,
  // 21px, 37px ...) while even sizes stay mirror-symmetric - no flat
  // right/bottom chords caused by off-centre rasterisation.
  const T = n % 2 === 0 ? n * n : n * (n - 1);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const D = 2 * x + 1 - n;
      const E = 2 * y + 1 - n;
      if (D * D + E * E <= T) grid[y * n + x] = 1;
    }
  }

  const cells: [number, number][] = [];
  const outline: [number, number][] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!grid[y * n + x]) continue;
      const cx = x - half, cy = y - half;
      cells.push([cx, cy]);
      const isEdge = x === 0 || y === 0 || x === n - 1 || y === n - 1 ||
        !grid[y * n + (x - 1)] || !grid[y * n + (x + 1)] ||
        !grid[(y - 1) * n + x] || !grid[(y + 1) * n + x];
      if (isEdge) outline.push([cx, cy]);
    }
  }
  const stamp: BrushStamp = { size: n, cells, outline };
  stampCache.set(cacheKey, stamp);
  return stamp;
}
