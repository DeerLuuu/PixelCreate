// Hit testing in the multi-canvas space (pure, unit tested).
//
// The view keeps its transform relative to the FOCUSED canvas: its rect is
// always 0,0..w,h on screen, every other canvas is offset by (entry - focus).
// `View.canvasAtScreen` and the palette fan's drag & drop both go through here,
// so "which canvas is under this screen point" has exactly one implementation.

export interface SpaceCanvas {
  /** position in the space (canvas pixels) */
  x: number;
  y: number;
  /** size in canvas pixels */
  w: number;
  h: number;
}

export interface ScreenToCanvas {
  /** index into the canvas list */
  index: number;
  /** pixel inside that canvas (0..w-1, 0..h-1) */
  x: number;
  y: number;
}

/**
 * Index of the canvas under a screen point, or -1 for empty space.
 * Later canvases win (they are drawn on top), matching the paint order.
 */
export function canvasAtScreen(
  docs: readonly SpaceCanvas[],
  focusIndex: number,
  ox: number,
  oy: number,
  zoom: number,
  sx: number,
  sy: number,
): number {
  const hit = screenToCanvas(docs, focusIndex, ox, oy, zoom, sx, sy);
  return hit ? hit.index : -1;
}

/**
 * The canvas under a screen point plus the pixel inside it (null = empty space).
 * `ox`/`oy`/`zoom` are the view transform, anchored on `focusIndex`.
 */
export function screenToCanvas(
  docs: readonly SpaceCanvas[],
  focusIndex: number,
  ox: number,
  oy: number,
  zoom: number,
  sx: number,
  sy: number,
): ScreenToCanvas | null {
  const focus = docs[focusIndex];
  if (!focus || !(zoom > 0)) return null;
  // screen -> space (canvas pixels, origin at the focused canvas' corner)
  const wx = (sx - ox) / zoom + focus.x;
  const wy = (sy - oy) / zoom + focus.y;
  for (let i = docs.length - 1; i >= 0; i--) {
    const e = docs[i];
    if (wx >= e.x && wy >= e.y && wx < e.x + e.w && wy < e.y + e.h) {
      return { index: i, x: Math.floor(wx - e.x), y: Math.floor(wy - e.y) };
    }
  }
  return null;
}
