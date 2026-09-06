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
