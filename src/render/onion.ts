// Onion-skin ghost layout (pure, unit tested).
//
// Which neighbouring frames are drawn as ghosts, how far away they are and
// whether they come from the wrapped-around end of the animation. The
// compositor turns this into tinted layers; keeping the decision here makes
// the loop behaviour (and its special colouring) testable without a canvas.
export interface OnionGhost {
  /** frame index to draw */
  f: number;
  /** distance from the current frame (1 = nearest) */
  k: number;
  /** true = a "before" ghost, false = an "after" ghost */
  prev: boolean;
  /** true when the ghost wrapped around the first/last frame */
  wrapped: boolean;
}

/**
 * @param fi current frame
 * @param frameCount total frames
 * @param before how many frames before the current one (0..3)
 * @param after how many frames after the current one (0..3)
 * @param wrap loop the animation: the frame before the first is the last one
 * @returns ghosts far-to-near (so the nearest neighbour stays readable)
 */
export function onionGhosts(fi: number, frameCount: number, before: number, after: number, wrap: boolean): OnionGhost[] {
  const n = Math.max(1, frameCount);
  const best = new Map<number, OnionGhost>();
  const consider = (f: number, k: number, prev: boolean, wrapped: boolean): void => {
    if (f === fi || f < 0 || f >= n) return;
    const cur = best.get(f);
    if (!cur || k < cur.k) best.set(f, { f, k, prev, wrapped });
  };
  for (let k = 1; k <= before; k++) {
    const raw = fi - k;
    if (raw >= 0) consider(raw, k, true, false);
    else if (wrap && n > 1) consider(((raw % n) + n) % n, k, true, true);
  }
  for (let k = 1; k <= after; k++) {
    const raw = fi + k;
    if (raw < n) consider(raw, k, false, false);
    else if (wrap && n > 1) consider(raw % n, k, false, true);
  }
  return [...best.values()].sort((a, b) => b.k - a.k || a.f - b.f);
}
