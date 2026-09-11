// Playback loop modes as pure functions (no timers / DOM) so they can be
// unit-tested directly. `dir` is the ping-pong direction (+1 forward).
export type LoopMode = "once" | "loop" | "pingpong" | "reverse";

/** cycle order used by the loop button */
export const LOOP_MODES: LoopMode[] = ["once", "loop", "pingpong", "reverse"];

export const nextLoopMode = (m: LoopMode): LoopMode =>
  LOOP_MODES[(LOOP_MODES.indexOf(m) + 1) % LOOP_MODES.length];

export interface PlayStep {
  fi: number;
  dir: 1 | -1;
  stop: boolean;
}

/** inclusive window of frames playback is allowed to visit */
export interface PlayWindow {
  from: number;
  to: number;
}

/** the whole timeline */
export function fullWindow(count: number): PlayWindow {
  return { from: 0, to: Math.max(0, count - 1) };
}

/**
 * The window a tag plays. `tag` is the tag holding the frame playback started
 * from — playback started OUTSIDE every tag plays the whole timeline.
 */
export function windowOf(tag: { from: number; to: number } | null | undefined, count: number): PlayWindow {
  const full = fullWindow(count);
  if (!tag) return full;
  const from = Math.max(0, Math.min(full.to, Math.round(tag.from)));
  const to = Math.max(0, Math.min(full.to, Math.round(tag.to)));
  return from <= to ? { from, to } : full;
}

/** frame playback should start from (once rewinds when parked on the last) */
export function startPlayFrame(mode: LoopMode, fi: number, n: number): number {
  return startPlayFrameIn(mode, fi, fullWindow(n));
}

/** same, but stays inside `w` (a tag range) */
export function startPlayFrameIn(mode: LoopMode, fi: number, w: PlayWindow): number {
  const cur = Math.max(0, Math.min(w.to, Math.round(fi)));
  if (cur < w.from) return w.from; // parked before the window: start at its first frame
  return mode === "once" && w.to > w.from && cur >= w.to ? w.from : cur;
}

/** initial ping-pong direction */
export function startPlayDir(mode: LoopMode): 1 | -1 {
  return mode === "reverse" ? -1 : 1;
}

/** advance playback by one frame */
export function nextPlayFrame(mode: LoopMode, fi: number, n: number, dir: 1 | -1): PlayStep {
  return nextPlayFrameIn(mode, fi, dir, fullWindow(n));
}

/** same, but wraps/bounces inside `w` (a tag range) */
export function nextPlayFrameIn(mode: LoopMode, fi: number, dir: 1 | -1, w: PlayWindow): PlayStep {
  const n = w.to - w.from + 1;
  const local = Math.max(0, Math.min(n - 1, Math.round(fi) - w.from));
  const step = nextPlayFrameLocal(mode, local, n, dir);
  return { fi: step.fi + w.from, dir: step.dir, stop: step.stop };
}

function nextPlayFrameLocal(mode: LoopMode, fi: number, n: number, dir: 1 | -1): PlayStep {
  if (n <= 1) return { fi, dir, stop: true };
  switch (mode) {
    case "once": {
      const nf = fi + 1;
      return nf >= n ? { fi, dir, stop: true } : { fi: nf, dir, stop: false };
    }
    case "loop":
      return { fi: (fi + 1) % n, dir: 1, stop: false };
    case "reverse": {
      const nf = fi - 1;
      return { fi: nf < 0 ? n - 1 : nf, dir: -1, stop: false };
    }
    case "pingpong": {
      let d: 1 | -1 = dir;
      let nf = fi + d;
      if (nf >= n) { d = -1; nf = Math.max(0, n - 2); }      // bounce off the end
      else if (nf < 0) { d = 1; nf = Math.min(n - 1, 1); }   // bounce off the start
      return { fi: nf, dir: d, stop: false };
    }
  }
}
