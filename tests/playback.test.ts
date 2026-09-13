import {
  DEFAULT_PLAY_SPEED, PLAY_SPEEDS, isPlaySpeed, nextLoopMode, nextPlayFrame, nextPlaySpeed,
  scaledDelay, speedLabel, startPlayDir, startPlayFrame, type LoopMode,
} from "../src/app/playback";
import { Session } from "../src/app/session";
import { stubEnv } from "./session.test";
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

  // --- playback speed (0.25 / 0.5 / 1 / 1.5 / 2) ---
  eq("play.speed.list", PLAY_SPEEDS.join(","), "0.25,0.5,1,1.5,2");
  eq("play.speed.default", DEFAULT_PLAY_SPEED, 1);
  eq("play.speed.label", speedLabel(1.5), "1.5x");
  eq("play.speed.label-int", speedLabel(2), "2x");
  ok("play.speed.accepts", isPlaySpeed(0.25) && isPlaySpeed(2));
  ok("play.speed.rejects", !isPlaySpeed(0.75) && !isPlaySpeed("1") && !isPlaySpeed(NaN) && !isPlaySpeed(undefined));
  eq("play.speed.cycle.up", nextPlaySpeed(1), 1.5);
  eq("play.speed.cycle.top", nextPlaySpeed(2), 0.25);
  eq("play.speed.cycle.between", nextPlaySpeed(1.5), 2);
  eq("play.speed.cycle.unknown-falls-back", nextPlaySpeed(3), 1);

  // speed divides the authored duration: 2x = half the wait, 0.25x = four times
  eq("play.delay.1x", scaledDelay(100, 1), 100);
  eq("play.delay.2x", scaledDelay(100, 2), 50);
  eq("play.delay.1.5x", scaledDelay(100, 1.5), 67);
  eq("play.delay.0.25x", scaledDelay(100, 0.25), 400);
  // never below one browser frame: a 10ms frame at 2x is still 16ms
  eq("play.delay.floor", scaledDelay(10, 2), 16);
  eq("play.delay.floor-half", scaledDelay(20, 2), 16);
  // junk speed degrades to 1x instead of dividing by zero
  eq("play.delay.zero-speed", scaledDelay(100, 0), 100);
  eq("play.delay.nan-speed", scaledDelay(100, NaN), 100);
  eq("play.delay.rounds", scaledDelay(101, 2), 51);

  // --- Session 侧：存进 prefs、拒绝非法值、快照里带出去（时间轴的色片读它）---
  stubEnv();
  const s = new Session();
  eq("play.speed.session.default", s.playSpeed, 1);
  eq("play.speed.session.set", s.setPlaySpeed(2), 2);
  eq("play.speed.session.persisted", s.prefs.playSpeed, 2);
  eq("play.speed.session.rejects-junk", s.setPlaySpeed(0.75), 2);
  eq("play.speed.session.cycle", s.cyclePlaySpeed(), 0.25);
  eq("play.speed.session.snapshot", s.snapshot().playSpeed, 0.25);
}
