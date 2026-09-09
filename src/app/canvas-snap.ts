// Canvas snapping in the infinite space.
//
// Dragging a canvas near another one magnetically aligns their edges; once the
// drag ends while aligned, the two canvases are grouped so moving either moves
// both (the title bar offers a manual un-snap button).
//
// Pure and unit-tested: the host passes the proposed position and the other
// canvases, and gets back the adjusted position plus the canvas it snapped to.

export interface SnapRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SnapTarget<T> extends SnapRect {
  id: T;
}

export interface SnapResult<T> {
  x: number;
  y: number;
  /** the canvas the position snapped to (null = no snap) */
  hit: T | null;
}

/** gap between two 1D intervals (0 when they touch or overlap) */
function gap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.max(a0 - b1, b0 - a1));
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
export function snapToTargets<T>(moving: SnapRect, targets: Array<SnapTarget<T>>, tol: number): SnapResult<T> {
  if (tol <= 0 || !targets.length) return { x: moving.x, y: moving.y, hit: null };
  const mx1 = moving.x + moving.w;
  const my1 = moving.y + moving.h;
  let bestX: { d: number; id: T } | null = null;
  let bestY: { d: number; id: T } | null = null;
  for (const t of targets) {
    const tx1 = t.x + t.w;
    const ty1 = t.y + t.h;
    const vGap = gap(moving.y, my1, t.y, ty1); // vertical distance between them
    const hGap = gap(moving.x, mx1, t.x, tx1);
    if (vGap <= tol * 2) {
      const cands: number[] = [
        t.x - mx1,        // our right edge touches their left edge
        tx1 - moving.x,   // our left edge touches their right edge
        t.x - moving.x,   // left edges aligned
        tx1 - mx1,        // right edges aligned
      ];
      for (const d of cands) {
        if (Math.abs(d) > tol) continue;
        if (!bestX || Math.abs(d) < Math.abs(bestX.d)) bestX = { d, id: t.id };
      }
    }
    if (hGap <= tol * 2) {
      const cands: number[] = [
        t.y - my1,        // our bottom edge touches their top edge
        ty1 - moving.y,   // our top edge touches their bottom edge
        t.y - moving.y,   // top edges aligned
        ty1 - my1,        // bottom edges aligned
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
