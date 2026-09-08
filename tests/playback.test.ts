import { nextLoopMode, nextPlayFrame, startPlayDir, startPlayFrame, type LoopMode } from "../src/app/playback";
import { eq, ok } from "./common";

/** walk the playback a fixed number of steps and return the visited frames */
function walk(mode: LoopMode, start: number, n: number, steps: number): number[] {
  const out = [start];
  let fi = start;
  let dir = startPlayDir(mode);
  for (let i = 0; i < steps; i++) {
    const s = nextPlayFrame(mode, fi, n, dir);
    if (s.stop) break;
    fi = s.fi;
    dir = s.dir;
    out.push(fi);
  }
  return out;
}

export function testPlayback(): void {
  // --- the loop button cycles through the four modes ---
  eq("play.cycle.once", nextLoopMode("once"), "loop");
  eq("play.cycle.loop", nextLoopMode("loop"), "pingpong");
  eq("play.cycle.pingpong", nextLoopMode("pingpong"), "reverse");
  eq("play.cycle.reverse", nextLoopMode("reverse"), "once");

  // --- once: plays to the end then stops ---
  eq("play.once.sequence", walk("once", 0, 3, 6), [0, 1, 2]);
  ok("play.once.stops", nextPlayFrame("once", 2, 3, 1).stop);
  eq("play.once.rewind", startPlayFrame("once", 2, 3), 0);
  eq("play.once.no-rewind-mid", startPlayFrame("once", 1, 3), 1);

  // --- loop: wraps around ---
  eq("play.loop.sequence", walk("loop", 0, 3, 7), [0, 1, 2, 0, 1, 2, 0, 1]);
  ok("play.loop.never-stops", !nextPlayFrame("loop", 2, 3, 1).stop);
  eq("play.loop.no-rewind", startPlayFrame("loop", 2, 3), 2);

  // --- reverse: runs backwards and wraps to the last frame ---
  eq("play.reverse.sequence", walk("reverse", 0, 3, 6), [0, 2, 1, 0, 2, 1, 0]);
  eq("play.reverse.dir", startPlayDir("reverse"), -1);
  eq("play.reverse.start", startPlayFrame("reverse", 0, 3), 0);

  // --- ping-pong: bounces off both ends ---
  eq("play.pingpong.sequence", walk("pingpong", 0, 3, 8), [0, 1, 2, 1, 0, 1, 2, 1, 0]);
  eq("play.pingpong.dir", startPlayDir("pingpong"), 1);
  // two frames: 0,1,0,1 ... (never gets stuck)
  eq("play.pingpong.two", walk("pingpong", 0, 2, 6), [0, 1, 0, 1, 0, 1, 0]);

  // --- single frame never advances ---
  ok("play.single.stop", nextPlayFrame("loop", 0, 1, 1).stop);
  ok("play.single.reverse.stop", nextPlayFrame("reverse", 0, 1, -1).stop);

  // --- starting from a middle frame keeps position (except once-on-last) ---
  eq("play.mid.loop", startPlayFrame("loop", 1, 4), 1);
  eq("play.mid.pingpong", startPlayFrame("pingpong", 1, 4), 1);
  eq("play.mid.once", startPlayFrame("once", 1, 4), 1);
  eq("play.mid.once-last", startPlayFrame("once", 3, 4), 0);
}
