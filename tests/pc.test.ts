// PC mode detection (src/io/pcmode.ts) — the pure decision plus the
// "which environment am I in" rules behind the desktop extras.
import { normalizePcMode, resolvePcMode } from "../src/io/pcmode";
import { normalizeWheelDelta, wheelIntent, wheelZoomFactor } from "../src/render/wheel";
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

  // ---- 滚轮：纯函数（滚动方向、修饰键、deltaMode 归一化）----
  {
    // 向上滚（deltaY < 0）＝放大，向下滚＝缩小
    ok("wheel.zoom.in", wheelZoomFactor(-100) > 1);
    ok("wheel.zoom.out", wheelZoomFactor(100) < 1);
    eq("wheel.zoom.zero", wheelZoomFactor(0), 1);
    // 行模式（Firefox）与 100px 像素模式量级接近
    ok("wheel.zoom.lines", wheelZoomFactor(-3, 1) > wheelZoomFactor(-3, 0));
    eq("wheel.norm.pixels", normalizeWheelDelta(120, 0), 120);
    eq("wheel.norm.lines", normalizeWheelDelta(3, 1), 48);
    eq("wheel.norm.pages", normalizeWheelDelta(1, 2), 400);
    // 结合律：两步 50px 与一步 100px 的缩放倍率一致（指数曲线）
    ok("wheel.zoom.exp-additive",
      Math.abs(wheelZoomFactor(-100) - wheelZoomFactor(-50) * wheelZoomFactor(-50)) < 1e-9);

    eq("wheel.intent.zoom", wheelIntent({ deltaY: -100 }).kind, "zoom");
    const hx = wheelIntent({ deltaY: 60, shiftKey: true });
    eq("wheel.intent.shift-axis", hx.kind, "pan");
    eq("wheel.intent.shift-dx", hx.kind === "pan" ? hx.dx : 0, -60);
    const vy = wheelIntent({ deltaY: 60, altKey: true });
    eq("wheel.intent.alt-axis", vy.kind === "pan" ? [vy.dx, vy.dy] : null, [0, -60]);
    // 横向滚动事件（触控板）在 shift 下会叠加 deltaX
    const both = wheelIntent({ deltaY: 40, deltaX: 25, shiftKey: true });
    eq("wheel.intent.shift-with-deltax", both.kind === "pan" ? both.dx : 0, -65);
  }
}
