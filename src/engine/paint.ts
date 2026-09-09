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
                            mask?: MaskFn | null, ax?: SymAxis): { x: number; y: number; w: number; h: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  polygonCells(w, h, pts, (x, y) => {
    const targets = ax ? mirrorCells(x, y, w, h, ax) : [[x, y]] as Array<[number, number]>;
    for (const [mx, my] of targets) {
      if (mx < 0 || my < 0 || mx >= w || my >= h) continue;
      if (!paintAt(cel, mx, my, color, mask)) continue;
      if (mx < x0) x0 = mx;
      if (my < y0) y0 = my;
      if (mx > x1) x1 = mx;
      if (my > y1) y1 = my;
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

/** Erase-flood: clear the connected region matching the seed color. */
export function floodErase(cel: Cel, sx: number, sy: number, mask?: MaskFn | null): void {
  const w = cel.w, h = cel.h, d = cel.data;
  if (!cel.inBounds(sx, sy)) return;
  const bi = cel.idx(sx, sy);
  const baseR = d[bi], baseG = d[bi + 1], baseB = d[bi + 2], baseA = d[bi + 3];
  if (baseA === 0) return;
  const match = (x: number, y: number): boolean => {
    const i = cel.idx(x, y);
    return d[i] === baseR && d[i + 1] === baseG && d[i + 2] === baseB && d[i + 3] === baseA;
  };
  const visited = new Uint8Array(w * h);
  const stack: [number, number][] = [[sx, sy]];
  while (stack.length) {
    const [x, y] = stack.pop()!;
    if (!cel.inBounds(x, y)) continue;
    const vi = y * w + x;
    if (visited[vi]) continue;
    visited[vi] = 1;
    if (!match(x, y)) continue;
    if (mask && !mask(x, y)) continue;
    const i = vi * 4;
    d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = 0;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
}

/** Flood fill with tolerance=0, optional selection mask. */
export function floodFill(cel: Cel, sx: number, sy: number, color: RGBA, mask?: MaskFn | null): void {
  const w = cel.w, h = cel.h, d = cel.data;
  if (!cel.inBounds(sx, sy)) return;
  const bi = cel.idx(sx, sy);
  const baseR = d[bi], baseG = d[bi + 1], baseB = d[bi + 2], baseA = d[bi + 3];
  const match = (x: number, y: number): boolean => {
    const i = cel.idx(x, y);
    return d[i] === baseR && d[i + 1] === baseG && d[i + 2] === baseB && d[i + 3] === baseA;
  };
  if (!match(sx, sy)) return;
  const visited = new Uint8Array(w * h);
  const stack: [number, number][] = [[sx, sy]];
  while (stack.length) {
    const [x, y] = stack.pop()!;
    if (!cel.inBounds(x, y)) continue;
    const vi = y * w + x;
    if (visited[vi]) continue;
    visited[vi] = 1;
    if (!match(x, y)) continue;
    if (mask && !mask(x, y)) continue;
    paintAt(cel, x, y, color, null);
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
}

/** Collect the cells a bucket fill would cover: the connected same-colour
 *  region (global = false) or every matching cell in the layer (global = true),
 *  honouring an optional selection mask. Pure: nothing is painted. */
export function floodRegion(cel: Cel, sx: number, sy: number, global: boolean, mask?: MaskFn | null): Array<[number, number]> {
  const w = cel.w, h = cel.h, d = cel.data;
  const out: Array<[number, number]> = [];
  if (!cel.inBounds(sx, sy)) return out;
  const bi = cel.idx(sx, sy);
  const b0 = d[bi], b1 = d[bi + 1], b2 = d[bi + 2], b3 = d[bi + 3];
  const match = (x: number, y: number): boolean => {
    const i = cel.idx(x, y);
    return d[i] === b0 && d[i + 1] === b1 && d[i + 2] === b2 && d[i + 3] === b3;
  };
  if (global) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!match(x, y)) continue;
        if (mask && !mask(x, y)) continue;
        out.push([x, y]);
      }
    }
    return out;
  }
  const seen = new Uint8Array(w * h);
  const stack: Array<[number, number]> = [[sx, sy]];
  while (stack.length) {
    const [x, y] = stack.pop()!;
    if (!cel.inBounds(x, y)) continue;
    const vi = y * w + x;
    if (seen[vi]) continue;
    seen[vi] = 1;
    if (!match(x, y)) continue;
    if (mask && !mask(x, y)) continue;
    out.push([x, y]);
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  return out;
}

/** Paint a region with a radial RGB ramp: `c0` at the seed, `c1` at the farthest
 *  cell. `block` snaps the ramp to block x block tiles (1 = smooth per-pixel),
 *  so 2/4/8 give the chunky pixel-art gradients. Returns the bbox touched. */
export function gradientFillRegion(cel: Cel, cells: Array<[number, number]>, sx: number, sy: number,
                                   c0: RGBA, c1: RGBA, block: number, mask?: MaskFn | null): { x: number; y: number; w: number; h: number } | null {
  if (!cells.length) return null;
  const b = Math.max(1, Math.round(block));
  // each tile shares one colour, sampled at the tile centre
  const anchor = (v: number): number => Math.floor(v / b) * b + (b - 1) / 2;
  let maxD = 0;
  for (const [x, y] of cells) {
    const dd = Math.hypot(anchor(x) - sx, anchor(y) - sy);
    if (dd > maxD) maxD = dd;
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of cells) {
    const t = maxD > 0 ? Math.min(1, Math.hypot(anchor(x) - sx, anchor(y) - sy) / maxD) : 0;
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

/** Non-contiguous fill: replace EVERY pixel of the cel matching the seed
 *  colour (tolerance 0), honouring an optional selection mask. Unlike
 *  floodFill this ignores connectivity, so all identical pixels anywhere in
 *  the layer are filled in one go. */
export function globalFill(cel: Cel, sx: number, sy: number, color: RGBA, mask?: MaskFn | null): void {
  const w = cel.w, h = cel.h, d = cel.data;
  if (!cel.inBounds(sx, sy)) return;
  const bi = cel.idx(sx, sy);
  const baseR = d[bi], baseG = d[bi + 1], baseB = d[bi + 2], baseA = d[bi + 3];
  // filling with the colour that is already there would be a no-op
  if (color[0] === baseR && color[1] === baseG && color[2] === baseB && color[3] === baseA) return;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = cel.idx(x, y);
      if (d[i] !== baseR || d[i + 1] !== baseG || d[i + 2] !== baseB || d[i + 3] !== baseA) continue;
      if (mask && !mask(x, y)) continue;
      paintAt(cel, x, y, color, null);
    }
  }
}

/** Non-contiguous erase: clear every pixel matching the seed colour. */
export function globalErase(cel: Cel, sx: number, sy: number, mask?: MaskFn | null): void {
  const w = cel.w, h = cel.h, d = cel.data;
  if (!cel.inBounds(sx, sy)) return;
  const bi = cel.idx(sx, sy);
  const baseR = d[bi], baseG = d[bi + 1], baseB = d[bi + 2], baseA = d[bi + 3];
  if (baseA === 0) return;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = cel.idx(x, y);
      if (d[i] !== baseR || d[i + 1] !== baseG || d[i + 2] !== baseB || d[i + 3] !== baseA) continue;
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
