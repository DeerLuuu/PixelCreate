// Canvas snapping in the infinite space.
//
// Dragging a canvas near another one magnetically aligns their edges; once the
// drag ends while aligned, the two canvases are grouped so moving either moves
// both (the title bar offers a manual un-snap button).
//
// Pure and unit-tested: the host passes the proposed position and the other
// canvases, and gets back the adjusted position plus the canvas it snapped to.

/** empty space kept between two snapped canvases (doc pixels) */
export const SNAP_GAP = 8;

export interface SnapRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SnapTarget<T> extends SnapRect {
  id: T;
}

/** the empty space between two adjacent canvases */
export interface GapRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** one candidate: where `moving` would land if it snapped to this target */
export interface SnapCandidate<T> {
  id: T;
  x: number;
  y: number;
}

export interface SnapResult<T> {
  x: number;
  y: number;
  /** the canvas the position snapped to (null = no snap) */
  hit: T | null;
}

/** distance between two 1D intervals (0 when they touch or overlap) */
function axisGap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.max(a0 - b1, b0 - a1));
}

/** the snap gap rect between two rects (null = not adjacent with exactly `gap`) */
export function snapGapRect(a: SnapRect, b: SnapRect, gap = SNAP_GAP): GapRect | null {
  const ax1 = a.x + a.w, ay1 = a.y + a.h;
  const bx1 = b.x + b.w, by1 = b.y + b.h;
  if (ax1 + gap === b.x && a.y < by1 && b.y < ay1) return { x0: ax1, y0: Math.max(a.y, b.y), x1: b.x, y1: Math.min(ay1, by1) };
  if (bx1 + gap === a.x && a.y < by1 && b.y < ay1) return { x0: bx1, y0: Math.max(a.y, b.y), x1: a.x, y1: Math.min(ay1, by1) };
  if (ay1 + gap === b.y && a.x < bx1 && b.x < ax1) return { x0: Math.max(a.x, b.x), y0: ay1, x1: Math.min(ax1, bx1), y1: b.y };
  if (by1 + gap === a.y && a.x < bx1 && b.x < ax1) return { x0: Math.max(a.x, b.x), y0: by1, x1: Math.min(ax1, bx1), y1: a.y };
  return null;
}

/** per-target snap deltas: the best x and y candidate of ONE target */
function bestDeltas<T>(moving: SnapRect, t: SnapTarget<T>, tol: number, gap: number): { dx: number; dy: number; any: boolean } {
  const mx1 = moving.x + moving.w;
  const my1 = moving.y + moving.h;
  const tx1 = t.x + t.w;
  const ty1 = t.y + t.h;
  const vGap = axisGap(moving.y, my1, t.y, ty1);
  const hGap = axisGap(moving.x, mx1, t.x, tx1);
  let dx = 0, dy = 0, any = false;
  if (vGap <= tol * 2) {
    for (const d of [t.x - gap - mx1, tx1 + gap - moving.x, t.x - moving.x, tx1 - mx1]) {
      if (Math.abs(d) > tol) continue;
      if (!any || Math.abs(d) < Math.abs(dx)) dx = d;
      any = true;
    }
  }
  if (hGap <= tol * 2) {
    for (const d of [t.y - gap - my1, ty1 + gap - moving.y, t.y - moving.y, ty1 - my1]) {
      if (Math.abs(d) > tol) continue;
      if (!any || Math.abs(d) < Math.abs(dy)) dy = d;
      any = true;
    }
  }
  return { dx, dy, any };
}

/**
 * Every target the moving rect could snap to, with the position it would take
 * for that target alone. Used to light up ALL satisfied snap zones at once
 * (the actually applied position may combine two of them).
 */
export function snapCandidates<T>(moving: SnapRect, targets: Array<SnapTarget<T>>, tol: number, gap = SNAP_GAP): Array<SnapCandidate<T>> {
  const out: Array<SnapCandidate<T>> = [];
  if (tol <= 0) return out;
  for (const t of targets) {
    const d = bestDeltas(moving, t, tol, gap);
    if (!d.any) continue;
    out.push({ id: t.id, x: moving.x + d.dx, y: moving.y + d.dy });
  }
  return out;
}

/**
 * Align `moving` with the nearest edge of any target.
 *
 * Per axis the four classic candidates are tried (touch from either side,
 * leading-edge alignment, trailing-edge alignment). A candidate only counts
 * when it is within `tol` AND the two rectangles are close on the OTHER axis
 * (within `tol * 2`), so distant canvases never snap just because their left
 * edges happen to line up.
 */
export function snapToTargets<T>(moving: SnapRect, targets: Array<SnapTarget<T>>, tol: number, gap = SNAP_GAP): SnapResult<T> {
  if (tol <= 0 || !targets.length) return { x: moving.x, y: moving.y, hit: null };
  const mx1 = moving.x + moving.w;
  const my1 = moving.y + moving.h;
  let bestX: { d: number; id: T } | null = null;
  let bestY: { d: number; id: T } | null = null;
  for (const t of targets) {
    const tx1 = t.x + t.w;
    const ty1 = t.y + t.h;
    const vGap = axisGap(moving.y, my1, t.y, ty1); // vertical distance between them
    const hGap = axisGap(moving.x, mx1, t.x, tx1);
    if (vGap <= tol * 2) {
      const cands: number[] = [
        t.x - gap - mx1,        // our right edge sits `gap` left of their left edge
        tx1 + gap - moving.x,   // our left edge sits `gap` right of their right edge
        t.x - moving.x,         // left edges aligned
        tx1 - mx1,              // right edges aligned
      ];
      for (const d of cands) {
        if (Math.abs(d) > tol) continue;
        if (!bestX || Math.abs(d) < Math.abs(bestX.d)) bestX = { d, id: t.id };
      }
    }
    if (hGap <= tol * 2) {
      const cands: number[] = [
        t.y - gap - my1,        // our bottom edge sits `gap` above their top edge
        ty1 + gap - moving.y,   // our top edge sits `gap` below their bottom edge
        t.y - moving.y,         // top edges aligned
        ty1 - my1,              // bottom edges aligned
      ];
      for (const d of cands) {
        if (Math.abs(d) > tol) continue;
        if (!bestY || Math.abs(d) < Math.abs(bestY.d)) bestY = { d, id: t.id };
      }
    }
  }
  const dx = bestX ? bestX.d : 0;
  const dy = bestY ? bestY.d : 0;
  let hit: T | null = null;
  if (bestX && bestY) hit = Math.abs(bestX.d) <= Math.abs(bestY.d) ? bestX.id : bestY.id;
  else if (bestX) hit = bestX.id;
  else if (bestY) hit = bestY.id;
  // an axis that was already aligned moves nothing: that is not a snap
  if (dx === 0 && dy === 0) hit = null;
  return { x: moving.x + dx, y: moving.y + dy, hit };
}
