// Mouse wheel → view intent (pure, unit tested).
//
// PC mode: plain wheel zooms around the cursor, Shift+wheel scrolls horizontally
// and Alt+wheel scrolls vertically (the user's mapping). The zoom factor is
// exponential so the wheel feels linear at every zoom level, and `deltaMode` is
// normalised because Firefox reports lines (1) or pages (2) instead of pixels.

export type WheelIntent =
  | { kind: "zoom"; factor: number }
  | { kind: "pan"; dx: number; dy: number };

/** one wheel notch ≈ 100px in pixels mode; lines are ~16px, pages a screenful */
export function normalizeWheelDelta(delta: number, deltaMode: number): number {
  if (deltaMode === 1) return delta * 16;
  if (deltaMode === 2) return delta * 400;
  return delta;
}

/** how much the zoom changes for one wheel event (1 = no change) */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const px = normalizeWheelDelta(deltaY, deltaMode);
  return Math.exp(-px / 400);
}

export function wheelIntent(e: {
  deltaX?: number;
  deltaY: number;
  deltaMode?: number;
  shiftKey?: boolean;
  altKey?: boolean;
}): WheelIntent {
  const d = normalizeWheelDelta(e.deltaY, e.deltaMode ?? 0);
  // Shift+wheel: most browsers already swap the axes, so add deltaX when present
  if (e.shiftKey) return { kind: "pan", dx: -d - normalizeWheelDelta(e.deltaX ?? 0, e.deltaMode ?? 0), dy: 0 };
  if (e.altKey) return { kind: "pan", dx: 0, dy: -d };
  return { kind: "zoom", factor: wheelZoomFactor(e.deltaY, e.deltaMode ?? 0) };
}
