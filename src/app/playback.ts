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

/** frame playback should start from (once rewinds when parked on the last) */
export function startPlayFrame(mode: LoopMode, fi: number, n: number): number {
  return mode === "once" && n > 1 && fi >= n - 1 ? 0 : fi;
}

/** initial ping-pong direction */
export function startPlayDir(mode: LoopMode): 1 | -1 {
  return mode === "reverse" ? -1 : 1;
}

/** advance playback by one frame */
export function nextPlayFrame(mode: LoopMode, fi: number, n: number, dir: 1 | -1): PlayStep {
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
