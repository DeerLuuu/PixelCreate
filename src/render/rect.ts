// Pure rectangle helpers for the incremental renderer.
//
// The live-stroke path recomposites and repaints only the region a stroke
// touched, so every coordinate transform here has to be exact and is unit
// tested (no DOM needed).
import type { Rect } from "../engine/types";

/** smallest rectangle covering both (null = "nothing") */
export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b ? { x: b.x, y: b.y, w: b.w, h: b.h } : null;
  if (!b) return { x: a.x, y: a.y, w: a.w, h: a.h };
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** clip to a w×h frame; null when nothing is left */
export function clampRect(r: Rect, w: number, h: number): Rect | null {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(w, Math.ceil(r.x + r.w));
  const y1 = Math.min(h, Math.ceil(r.y + r.h));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** document rect -> screen rect (CSS px, origin = viewport top-left), padded
 *  by `pad` so the anti-aliased border of the blit is repainted too */
export function screenRectOf(r: Rect, ox: number, oy: number, zoom: number, pad = 2): Rect {
  const x0 = ox + r.x * zoom - pad;
  const y0 = oy + r.y * zoom - pad;
  const x1 = ox + (r.x + r.w) * zoom + pad;
  const y1 = oy + (r.y + r.h) * zoom + pad;
  return { x: Math.floor(x0), y: Math.floor(y0), w: Math.ceil(x1 - x0), h: Math.ceil(y1 - y0) };
}

/** true when the rect covers the whole frame (no point in a partial update) */
export function coversAll(r: Rect, w: number, h: number): boolean {
  const c = clampRect(r, w, h);
  return !!c && c.x === 0 && c.y === 0 && c.w === w && c.h === h;
}
