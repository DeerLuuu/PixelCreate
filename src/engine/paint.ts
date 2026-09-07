// Pixel-level drawing algorithms operating directly on Cel buffers.
import { Cel } from "./cel";
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

/** cells inside a circular brush of radius r centered (x,y) */
export function dotCells(x: number, y: number, radius: number): [number, number][] {
  const out: [number, number][] = [];
  const R = Math.max(0, Math.round(radius));
  const rr = R * R;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dy * dy <= rr) out.push([x + dx, y + dy]);
    }
  }
  return out;
}

/** Exact `size` x `size` square of cells (brush size = pixel diameter). */
export function squareCells(x: number, y: number, size: number): [number, number][] {
  const s = Math.max(1, Math.round(size));
  const out: [number, number][] = [];
  const h = Math.floor(s / 2);
  for (let dy = -h; dy < s - h; dy++) for (let dx = -h; dx < s - h; dx++) out.push([x + dx, y + dy]);
  return out;
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
const stampCache = new Map<number, BrushStamp>();

export function brushStamp(size: number): BrushStamp {
  const n = Math.max(1, Math.round(size));
  const got = stampCache.get(n);
  if (got) return got;
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
  stampCache.set(n, stamp);
  return stamp;
}
