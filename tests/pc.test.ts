// PC mode detection (src/io/pcmode.ts) — the pure decision plus the
// "which environment am I in" rules behind the desktop extras.
import { normalizePcMode, resolvePcMode } from "../src/io/pcmode";
import { normalizeWheelDelta, wheelIntent, wheelZoomFactor } from "../src/render/wheel";
import { fanRadius, orbMetrics, ringLayout } from "../src/ui/orb-layout";
import { cursorFor } from "../src/render/cursor";
import { NUDGE_STEP, NUDGE_STEP_FAST, TOOL_KEYS, shortcutFor } from "../src/app/shortcuts";
import { eq, ok } from "./common";
import { CORE_TOOLS, SHAPE_TOOLS, SELECT_TOOLS } from "../src/tools/registry";

const CORE_IDS: Set<string> = new Set<string>([...CORE_TOOLS, ...SHAPE_TOOLS, ...SELECT_TOOLS].map((t) => t.id as string));

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

  // ---- 鼠标光标：按工具 / 状态（纯函数）----
  {
    eq("cursor.pencil", cursorFor({ tool: "pencil", locked: false }), "draw");
    eq("cursor.bucket", cursorFor({ tool: "bucket", locked: false }), "draw");
    eq("cursor.curve", cursorFor({ tool: "curve", locked: false }), "draw");
    eq("cursor.picker", cursorFor({ tool: "picker", locked: false }), "pick");
    eq("cursor.other-tool", cursorFor({ tool: "unknown-tool", locked: false }), "move");
    // 平移优先于一切
    eq("cursor.panning-beats-tool", cursorFor({ tool: "pencil", locked: false, panning: true }), "grabbing");
    eq("cursor.space-beats-lock", cursorFor({ tool: "pencil", locked: true, spaceHeld: true }), "grab");
    // 锁定图层：禁止（但仍比平移低一级）
    eq("cursor.locked", cursorFor({ tool: "pencil", locked: true }), "lock");
    // 长按取色模式也有吸管
    eq("cursor.picking-mode", cursorFor({ tool: "pencil", locked: false, picking: true }), "pick");
  }

  // ---- 键盘快捷键映射（纯函数）----
  {
    const K = (key: string, mods: Record<string, boolean> = {}) => shortcutFor({ key, ...mods });
    eq("key.undo", K("z", { ctrlKey: true })?.action, "undo");
    eq("key.redo.shift", K("Z", { ctrlKey: true, shiftKey: true })?.action, "redo");
    eq("key.redo.y", K("y", { ctrlKey: true })?.action, "redo");
    eq("key.save", K("s", { ctrlKey: true })?.action, "save");
    eq("key.copy", K("c", { ctrlKey: true })?.action, "copy");
    eq("key.paste", K("v", { ctrlKey: true })?.action, "paste");
    eq("key.cut", K("x", { ctrlKey: true })?.action, "cut");
    // Ctrl+方向键：左右切帧、上下切图层
    eq("key.frame.prev", K("ArrowLeft", { ctrlKey: true })?.action, "framePrev");
    eq("key.frame.next", K("ArrowRight", { ctrlKey: true })?.action, "frameNext");
    eq("key.layer.prev", K("ArrowUp", { ctrlKey: true })?.action, "layerPrev");
    eq("key.layer.next", K("ArrowDown", { ctrlKey: true })?.action, "layerNext");
    // 不带 Ctrl 的方向键仍是选区微移（不冲突）
    eq("key.arrow.plain.nudge", K("ArrowLeft")?.action, "nudge");
    // 大写（Shift 按下）也能识别 Ctrl 组合
    eq("key.undo.uppercase", K("Z", { ctrlKey: true })?.action, "undo");
    // 纯 Ctrl 组合在输入框里仍然生效，普通按键不抢
    eq("key.typing.undo", shortcutFor({ key: "z", ctrlKey: true }, true)?.action, "undo");
    eq("key.typing.plain-b", shortcutFor({ key: "b" }, true), null);
    eq("key.typing.delete", shortcutFor({ key: "Delete" }, true), null);

    eq("key.delete", K("Delete")?.action, "delete");
    eq("key.backspace", K("Backspace")?.action, "delete");
    eq("key.escape", K("Escape")?.action, "escape");
    eq("key.zoom.in", K("+")?.action, "zoomIn");
    eq("key.zoom.in.equals", K("=")?.action, "zoomIn");
    eq("key.zoom.out", K("-")?.action, "zoomOut");
    eq("key.fit", K("0")?.action, "fit");
    eq("key.tab", K("Tab")?.action, "toggleUI");

    // 方向键微移：1px，Shift 10px
    eq("key.nudge.left", [K("ArrowLeft")?.dx, K("ArrowLeft")?.dy], [-NUDGE_STEP, 0]);
    eq("key.nudge.down.fast", [K("ArrowDown", { shiftKey: true })?.dx, K("ArrowDown", { shiftKey: true })?.dy], [0, NUDGE_STEP_FAST]);
    eq("key.nudge.up", K("ArrowUp")?.dy, -NUDGE_STEP);

    // 工具键
    eq("key.tool.b", K("b")?.tool, "pencil");
    eq("key.tool.e", K("e")?.tool, "eraser");
    eq("key.tool.g", K("g")?.tool, "bucket");
    eq("key.tool.i", K("i")?.tool, "picker");
    eq("key.tool.m", K("m")?.tool, "select");
    eq("key.tool.w", K("w")?.tool, "wand");
    eq("key.tool.uppercase", K("B")?.tool, "pencil");
    ok("key.tool.table", Object.keys(TOOL_KEYS).length >= 12, "keys=" + Object.keys(TOOL_KEYS).length);
    // 每个工具键都指向真实存在的工具 id（与 registry 对齐）
    for (const id of Object.values(TOOL_KEYS)) {
      ok("key.tool.exists." + id, CORE_IDS.has(id), "tool=" + id);
    }
    // Alt/未知键不产生动作
    eq("key.alt.ignored", K("b", { altKey: true }), null);
    eq("key.unknown", K("F5"), null);
    eq("key.ctrl.unknown", K("q", { ctrlKey: true }), null);
  }

  // ---- 浮动球尺寸：PC 模式 1.2× 且排布更散（纯函数）----
  {
    const t = orbMetrics(false);
    const pc = orbMetrics(true);
    eq("orb.touch.orb", t.orb, 52);
    eq("orb.touch.item", t.item, 40);
    eq("orb.pc.orb", pc.orb, 62);
    eq("orb.pc.item", pc.item, 48);
    // 主球 1.2× 左右（±1px 允许取整）
    ok("orb.pc.orb-ratio", Math.abs(pc.orb / t.orb - 1.2) < 0.03, "ratio=" + (pc.orb / t.orb));
    ok("orb.pc.item-ratio", Math.abs(pc.item / t.item - 1.2) < 0.03, "ratio=" + (pc.item / t.item));
    // 环形排布也更散（半径按 1.2 放大）
    ok("orb.pc.r1-spread", pc.r1 > t.r1 * 1.15, "r1 " + t.r1 + " -> " + pc.r1);
    ok("orb.pc.r2-spread", pc.r2 > t.r2 * 1.15, "r2 " + t.r2 + " -> " + pc.r2);
    ok("orb.pc.rings-apart", pc.r2 - pc.r1 > t.r2 - t.r1, "gap " + (t.r2 - t.r1) + " -> " + (pc.r2 - pc.r1));
    // 调色球扇形格距更松、主球避让半径同步放大
    ok("orb.pc.fan-gap", pc.fanGap > t.fanGap && pc.fanR0 > t.fanR0);
    ok("orb.pc.floater", pc.floaterR > t.floaterR, "floater " + t.floaterR + " -> " + pc.floaterR);
    // 内环半径必须大于主球半径，否则菜单项会压在球上
    ok("orb.touch.ring-clears-ball", t.r1 > t.orb, "r1=" + t.r1 + " orb=" + t.orb);
    ok("orb.pc.ring-clears-ball", pc.r1 > pc.orb, "r1=" + pc.r1 + " orb=" + pc.orb);
  }

  // ---- ④ 展开落点零重叠（纯函数）----
  {
    const item = 48, gap = 8;
    const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
    // 同环相邻间距 ≥ 项直径 + 间隙
    const inner = fanRadius(3, 90, item, gap, 103);
    const step = (90 * Math.PI) / 180 / 2;
    ok("ring.fan-radius.min", inner >= (item + gap) / (2 * Math.sin(step / 2)) - 1e-6, "r=" + inner);
    // 项数越多，半径越大（否则必然重叠）
    ok("ring.fan-radius.grows", fanRadius(5, 90, item, gap) > fanRadius(2, 90, item, gap));
    // 单个项：半径只需容下自己
    eq("ring.fan-radius.single", fanRadius(1, 90, item, gap), item);
    // 两环布局：跨环与同环都不重叠
    for (const n of [2, 3, 4, 5, 6, 7, 8, 9, 10, 12]) {
      const pts = ringLayout({ count: n, cx: 0, cy: 0, spanDeg: 90, r1: 103, r2: 154, item, gap });
      eq("ring.count." + n, pts.length, n);
      let minD = Infinity;
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) minD = Math.min(minD, dist(pts[i], pts[j]));
      }
      ok("ring.no-overlap." + n, minD >= item + gap - 1e-6, "min=" + minD.toFixed(1) + " need=" + (item + gap));
    }
    // 触摸端的球更小：也不重叠
    {
      const pts = ringLayout({ count: 12, cx: 0, cy: 0, spanDeg: 90, r1: 86, r2: 128, item: 40, gap: 6 });
      let minD = Infinity;
      for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) minD = Math.min(minD, dist(pts[i], pts[j]));
      ok("ring.touch.no-overlap", minD >= 46, "min=" + minD.toFixed(1));
    }
  }
}
