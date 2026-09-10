// PC mode detection (src/io/pcmode.ts) — the pure decision plus the
// "which environment am I in" rules behind the desktop extras.
import { normalizePcMode, resolvePcMode } from "../src/io/pcmode";
import { eq, ok } from "./common";

export function testPcMode(): void {
  // auto: only a pointer that is both precise AND able to hover counts as a PC
  eq("pc.auto.mouse", resolvePcMode("auto", true, true), true);
  eq("pc.auto.touch", resolvePcMode("auto", false, false), false);
  // touch-screen laptops report both: hover+fine wins, the user can force it off
  eq("pc.auto.hybrid", resolvePcMode("auto", true, true), true);
  // a stylus-only device: fine pointer but no hover -> not a PC by default
  eq("pc.auto.pen-only", resolvePcMode("auto", true, false), false);
  eq("pc.auto.coarse-with-hover", resolvePcMode("auto", false, true), false);

  // forced modes ignore the detection entirely
  eq("pc.on.touch", resolvePcMode("on", false, false), true);
  eq("pc.off.mouse", resolvePcMode("off", true, true), false);
  eq("pc.off.hybrid", resolvePcMode("off", true, false), false);

  // stored/imported values are normalised (anything unknown = auto)
  eq("pc.norm.auto", normalizePcMode("auto"), "auto");
  eq("pc.norm.on", normalizePcMode("on"), "on");
  eq("pc.norm.off", normalizePcMode("off"), "off");
  eq("pc.norm.undefined", normalizePcMode(undefined), "auto");
  eq("pc.norm.garbage", normalizePcMode("yes"), "auto");
  ok("pc.norm.boolean", normalizePcMode(true) === "auto");
}
