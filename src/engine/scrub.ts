// Value scrubbing math (pure, unit tested).
//
// Two inputs change a number: a pointer drag (touch / mouse scrub) and the
// mouse wheel. Both used to move the value by ONE STEP PER EVENT, which is why
// a single light wheel flick jumped "1 -> 64" (a mouse notch is delivered as
// 10-40 wheel events with smooth scrolling, and a finger drag delivers one
// pointermove per frame). Everything here works in *accumulated travel*, so the
// value moves one step per notch / per N pixels no matter how the browser
// slices the events.

/** how much wheel travel counts as one step (one classic mouse notch) */
const NOTCH_PX = 100;
/** deltaMode 1 = lines, 2 = pages (Firefox reports lines) */
export function wheelNotches(deltaY: number, deltaMode = 0): number {
  if (deltaMode === 1) return deltaY / 3;   // ~3 lines per notch
  if (deltaMode === 2) return deltaY;       // a page is a big deliberate scroll
  return deltaY / NOTCH_PX;
}

/**
 * Consume whole notches out of an accumulator.
 * @param acc accumulated notches (sign follows deltaY: positive = scrolled down)
 * @returns `steps` whole notches (positive = down) and the `rest` to carry over
 */
export function takeNotches(acc: number): { steps: number; rest: number } {
  const steps = acc > 0 ? Math.floor(acc) : Math.ceil(acc);
  return { steps, rest: acc - steps };
}

/** pixels of pointer travel before a scrub starts changing the value */
export const SCRUB_DEAD_PX = 4;

/**
 * Value units per pixel of drag.
 *
 *  - an explicit `step` gets a comfortable 8px of travel;
 *  - otherwise the whole `min..max` range is crossed in ~600px, clamped so a
 *    small range still moves slowly (≥12px per unit) and a huge range never
 *    moves more than 1 unit per pixel.
 */
export function scrubRatePerPx(min?: number, max?: number, step?: number): number {
  if (step != null && step > 0) return step / 8;
  const span = min != null && max != null ? Math.abs(max - min) : 0;
  if (!(span > 0)) return 1 / 8;
  return Math.min(1, Math.max(1 / 12, span / 600));
}

/**
 * Value after dragging `px` pixels (up / right = positive).
 * The result is rounded to a whole step so the readout never shows 12.34.
 */
export function scrubValue(base: number, px: number, min?: number, max?: number, step?: number): number {
  const rate = scrubRatePerPx(min, max, step);
  const raw = base + px * rate;
  let q = step != null && !Number.isInteger(step) ? raw : Math.round(raw);
  if (min != null) q = Math.max(min, q);
  if (max != null) q = Math.min(max, q);
  return q;
}
