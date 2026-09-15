// 自由变换（斜切/透视 + 网格）的交互状态机回归。
//
// 背景：变形模式是「常驻」的（靠选区球里的「完成 / 还原」结束），却被塞进了
// rotate/scale 用的 `xf` 槽里。之前 onMove / onUp 不区分 mode，导致：
//   · 没抓住控制点的 pointermove 会被当成缩放，把变形预览顶掉；
//   · 一松手就 endXf() 提交并退出模式，手柄消失、还原按钮失效；
//   · 进入变形时立刻 floatCut，没拖过也会留下「被清空的图层」。
// 这里用无头 View（stubEnv + stubViewDom）把这几条钉死。
import { Doc, Sel } from "../src/engine/doc";
import { Session } from "../src/app/session";
import { View } from "../src/render/view";
import { beginMove, warpFloating, type MoveState } from "../src/tools/select";
import { snapWarpCoord, warpCoordLabel } from "../src/tools/warp";
import * as compMod from "../src/render/compositor";
import { stubEnv } from "./session.test";
import { stubViewDom } from "./view.test";
import { eq, ok } from "./common";

interface VX {
  ox: number; oy: number; zoom: number;
  /** 手势控制器：触点会话状态（`xf` / `xfDrag` / `selDrag` / `path` …）由它持有 */
  gesture: {
    xf: null | {
      mode: string; moved: boolean; cut?: boolean; cells?: number[]; buf?: Uint8ClampedArray; pts?: Pt[];
      warpKind?: string; drag?: number; grab?: Pt; move?: { x0: number; y0: number; pts: Pt[] }; st: MoveState; li: number; fi: number;
    };
    xfDrag: unknown; selDrag: unknown;
  };
  lastWarpError: "noSel" | "tooThin" | "locked" | null;
  onDown(e: PointerEvent): void; onMove(e: PointerEvent): void; onUp(e: PointerEvent): void;
  warpHandles(): Array<{ x: number; y: number }>;
  xfScreenFrame(): { corners: Array<{ x: number; y: number }> } | null;
  beginXfMoveAt(sx: number, sy: number): boolean;
}
interface Pt { x: number; y: number }

declare const require: (m: string) => any;
declare const __dirname: string;
const fs = require("fs");
const path = require("path");

/** 两个字节数组差了几个字节（失败信息里只打印数字，不打印整幅画布） */
function diffBytes(a: Uint8ClampedArray | Uint8Array, b: Uint8ClampedArray | Uint8Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

export function testWarpUi(): void {
  stubEnv();
  const dom = stubViewDom();
  const host = {
    clientWidth: 320, clientHeight: 240, style: {},
    appendChild: () => undefined, replaceChildren: () => undefined,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 240 }),
    addEventListener: () => undefined,
    setPointerCapture: () => undefined, releasePointerCapture: () => undefined,
  } as unknown as HTMLElement;
  const ev = (x: number, y: number): PointerEvent => ({
    clientX: x, clientY: y, pointerId: 1, pointerType: "touch", pressure: 1,
    preventDefault: () => undefined, stopPropagation: () => undefined,
  } as unknown as PointerEvent);

  const mk = (): { s: Session; v: VX } => {
    const s = new Session();
    s.setTool("select");        // 变形入口在选区球里，正常就是配选区工具用
    const v = new View(host, s) as unknown as VX;
    s.attachView(v as unknown as View);
    (v as unknown as { fit(): void }).fit();
    dom.flush();
    return { s, v };
  };
  /** 画一块 w×h 的实心块并把选区设成它 */
  const paint = (s: Session, x0: number, y0: number, w: number, h: number): void => {
    const doc = s.doc;
    const cel = doc.ensureCel(s.curLayer(), s.curFrame());
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
      const i = cel.idx(x, y);
      cel.data[i] = 10 + x - x0; cel.data[i + 1] = 100 + y - y0; cel.data[i + 2] = 200; cel.data[i + 3] = 255;
    }
    doc.sel = new Sel(doc.w, doc.h);
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) doc.sel.set(x, y, 1);
  };
  const celData = (s: Session): Uint8ClampedArray => s.doc.celAt(s.curLayer(), s.curFrame())!.data;
  const alpha = (s: Session, x: number, y: number): number => {
    const cel = s.doc.celAt(s.curLayer(), s.curFrame());
    return cel ? cel.data[cel.idx(x, y) + 3] : -1;
  };
  const sc = (v: VX, px: number, py: number): { x: number; y: number } => ({ x: px * v.zoom + v.ox, y: py * v.zoom + v.oy });
  const warp = (v: VX, kind: string): boolean => (v as unknown as { beginWarp(k: string): boolean }).beginWarp(kind);
  const finish = (v: VX, revert: boolean): void => (v as unknown as { finishWarp(r: boolean): void }).finishWarp(revert);

  // ---- 进入变形本身不改图层，也不产生历史 ----
  {
    const { s, v } = mk();
    paint(s, 10, 10, 6, 4);
    const pristine = new Uint8ClampedArray(celData(s));
    const mask0 = new Uint8Array(s.doc.sel!.mask);
    ok("warpui.enter.quad", warp(v, "quad"));
    eq("warpui.enter.mode", v.gesture.xf!.mode, "warp");
    eq("warpui.enter.cells-empty", v.gesture.xf!.cells === undefined, true);
    eq("warpui.enter.layer-untouched", diffBytes(celData(s), pristine), 0);
    eq("warpui.enter.mask-untouched", diffBytes(s.doc.sel!.mask, mask0), 0);
    eq("warpui.enter.no-history", s.history.list().labels.length, 0);
    eq("warpui.enter.not-moved", v.gesture.xf!.moved, false);
    ok("warpui.enter.handles-4", v.warpHandles().length === 4);
    eq("warpui.enter.alpha-intact", alpha(s, 10, 10), 255);
  }

  // ---- 一次没有抓住手柄的 pointermove：不许改模式、不许顶掉预览、不许切图层 ----
  {
    const { s, v } = mk();
    paint(s, 10, 10, 20, 14);
    const pristine = new Uint8ClampedArray(celData(s));
    ok("warpui.stray.enter", warp(v, "quad"));
    const pts0 = JSON.stringify(v.gesture.xf!.pts);
    const cells0 = JSON.stringify(v.gesture.xf!.cells ?? null);
    const hover = sc(v, 19, 17);                 // 选区内部，离四个角都 > 22 屏幕像素
    v.onMove(ev(hover.x, hover.y));
    dom.flush();
    ok("warpui.stray.keeps-mode", !!v.gesture.xf && v.gesture.xf.mode === "warp");
    eq("warpui.stray.keeps-points", JSON.stringify(v.gesture.xf!.pts), pts0);
    eq("warpui.stray.keeps-cells", JSON.stringify(v.gesture.xf!.cells ?? null), cells0);
    eq("warpui.stray.not-moved", v.gesture.xf!.moved, false);
    eq("warpui.stray.no-cut", alpha(s, 12, 12), 255);
    eq("warpui.stray.pixels", diffBytes(celData(s), pristine), 0);
    eq("warpui.stray.no-history", s.history.list().labels.length, 0);
    // 网格模式同样：9 个控制点、悬停不动
    eq("warpui.stray.mesh-mismatch", warp(v, "mesh"), true);
    ok("warpui.stray.mesh-9-points", (v.gesture.xf!.pts || []).length === 9);
    v.onMove(ev(sc(v, 29, 19).x, sc(v, 29, 19).y));
    dom.flush();
    ok("warpui.stray.mesh-keeps-mode", !!v.gesture.xf && v.gesture.xf.mode === "warp" && v.gesture.xf!.warpKind === "mesh");
    eq("warpui.stray.mesh-no-cut", alpha(s, 12, 12), 255);
  }

  // ---- 松手不落笔：停在变形模式，可以接着拖第二个点；还原逐字节复原 ----
  {
    const { s, v } = mk();
    paint(s, 10, 10, 6, 4);
    const pristine = new Uint8ClampedArray(celData(s));
    const mask0 = new Uint8Array(s.doc.sel!.mask);
    ok("warpui.hold.enter", warp(v, "quad"));
    const h0 = v.warpHandles()[0];
    v.onDown(ev(h0.x, h0.y));
    const d1 = sc(v, 7, 7);
    v.onMove(ev(d1.x, d1.y));
    dom.flush();
    // 半像素吸附（默认开）：`(7,7)` 的像素中心反解回连续下标是 6.5 → 落点 6.5
    // （半点吸附是幂等的：抓住控制点不动不会跳位）
    eq("warpui.hold.drag1-applied", [v.gesture.xf!.pts![0].x, v.gesture.xf!.pts![0].y], [6.5, 6.5]);
    // 再往外拖一格：连续下标落在 (7, 7) 与 (8, 8) 之间 → 半像素模式停在 `x.5`
    {
      const h = v.warpHandles()[0];
      const dest = sc(v, 7.75, 7.75);
      v.onDown(ev(h.x, h.y));
      v.onMove(ev(dest.x, dest.y));
      v.onUp(ev(dest.x, dest.y));
      dom.flush();
      eq("warpui.hold.drag1-half", [v.gesture.xf!.pts![0].x, v.gesture.xf!.pts![0].y], [7.5, 7.5]);
    }
    v.onUp(ev(d1.x, d1.y));
    dom.flush();
    ok("warpui.hold.mode-after-up", !!v.gesture.xf && v.gesture.xf.mode === "warp");
    eq("warpui.hold.drag-cleared", v.gesture.xf!.drag === undefined, true);
    eq("warpui.hold.handles-alive", v.warpHandles().length, 4);
    eq("warpui.hold.no-history-yet", s.history.list().labels.length, 0);
    // 第二个控制点：把右下角往外拉
    const h2 = v.warpHandles()[2];
    v.onDown(ev(h2.x, h2.y));
    const d2 = sc(v, 19, 17);
    v.onMove(ev(d2.x, d2.y));
    dom.flush();
    eq("warpui.hold.drag2-applied", [v.gesture.xf!.pts![2].x, v.gesture.xf!.pts![2].y], [18.5, 16.5]);
    // 两个控制点各自落在自己那一格：一个半点、一个整点（互不干扰）
    eq("warpui.hold.two-points-changed", [v.gesture.xf!.pts![0].x, v.gesture.xf!.pts![2].x], [7.5, 18.5]);
    v.onUp(ev(d2.x, d2.y));
    dom.flush();
    ok("warpui.hold.still-warp", !!v.gesture.xf && v.gesture.xf.mode === "warp");
    // 还原（此时还没落笔）→ 像素与掩码都逐字节回到进入前
    finish(v, true);
    eq("warpui.hold.revert-exits", v.gesture.xf === null, true);
    eq("warpui.hold.revert-pixels", diffBytes(celData(s), pristine), 0);
    eq("warpui.hold.revert-mask", diffBytes(s.doc.sel!.mask, mask0), 0);
    eq("warpui.hold.revert-no-history", s.history.list().labels.length, 0);
  }

  // ---- 进入后一次都没拖就退出：像素逐字节一致、零历史 ----
  {
    const { s, v } = mk();
    paint(s, 10, 10, 20, 14);
    const pristine = new Uint8ClampedArray(celData(s));
    ok("warpui.idle.enter", warp(v, "quad"));
    // 一次点按（按下 + 抬起，点位避开所有手柄）
    const tap = sc(v, 19, 17);
    v.onDown(ev(tap.x, tap.y));
    dom.flush();
    eq("warpui.idle.tap-keeps-layer", alpha(s, 12, 12), 255);
    // 变形期间按下选区内部不得再起一次选区拖动
    eq("warpui.idle.no-sel-drag", (v.gesture as unknown as { selDrag: unknown }).selDrag, null);
    v.onUp(ev(tap.x, tap.y));
    dom.flush();
    ok("warpui.idle.tap-keeps-mode", !!v.gesture.xf && v.gesture.xf.mode === "warp");
    eq("warpui.idle.tap-pixels", diffBytes(celData(s), pristine), 0);
    eq("warpui.idle.tap-no-history", s.history.list().labels.length, 0);
    finish(v, false);                            // 「完成」：没拖过＝什么都不做
    eq("warpui.idle.done-exits", v.gesture.xf === null, true);
    eq("warpui.idle.done-pixels", diffBytes(celData(s), pristine), 0);
    eq("warpui.idle.done-no-history", s.history.list().labels.length, 0);
  }

  // ---- 1×N / N×1 的选区：直接拒绝，且图层与掩码都没被碰 ----
  {
    for (const vertical of [true, false]) {
      const { s, v } = mk();
      const doc = s.doc;
      const cel = doc.ensureCel(s.curLayer(), s.curFrame());
      doc.sel = new Sel(doc.w, doc.h);
      for (let k = 0; k < 5; k++) {
        const x = vertical ? 20 : 20 + k, y = vertical ? 10 + k : 10;
        const i = cel.idx(x, y);
        cel.data[i] = 30; cel.data[i + 1] = 60; cel.data[i + 2] = 90; cel.data[i + 3] = 255;
        doc.sel.set(x, y, 1);
      }
      const before = new Uint8ClampedArray(cel.data);
      const mask0 = new Uint8Array(doc.sel.mask);
      const tag = vertical ? "col" : "row";
      eq("warpui.thin." + tag + ".refused", warp(v, "quad"), false);
      eq("warpui.thin." + tag + ".reason", v.lastWarpError, "tooThin");
      eq("warpui.thin." + tag + ".no-xf", v.gesture.xf === null, true);
      eq("warpui.thin." + tag + ".pixels", diffBytes(cel.data, before), 0);
      eq("warpui.thin." + tag + ".mask", diffBytes(doc.sel.mask, mask0), 0);
      // 网格入口同样拒绝
      eq("warpui.thin." + tag + ".mesh-refused", warp(v, "mesh"), false);
      eq("warpui.thin." + tag + ".mesh-pixels", diffBytes(cel.data, before), 0);
    }
    // 没有选区时是另一种原因（UI 提示要能区分）
    {
      const { s, v } = mk();
      s.doc.sel = null;
      eq("warpui.noSel.refused", warp(v, "quad"), false);
      eq("warpui.noSel.reason", v.lastWarpError, "noSel");
    }
  }

  // ---- 真拖一次后「完成」：落一条历史（sel.warp）、undo 回到进入前 ----
  {
    const { s, v } = mk();
    paint(s, 10, 10, 6, 4);
    const pristine = new Uint8ClampedArray(celData(s));
    ok("warpui.commit.enter", warp(v, "quad"));
    const st = beginMove(s.doc, s.curLayer(), s.curFrame())!;
    const h0 = v.warpHandles()[0];
    v.onDown(ev(h0.x, h0.y));
    const dest = sc(v, 7, 7);
    v.onMove(ev(dest.x, dest.y));
    dom.flush();
    const g = v.gesture.xf!;
    eq("warpui.commit.first-drag-cuts", alpha(s, 10, 10), 0);
    eq("warpui.commit.moved", g.moved, true);
    // 预览＝warpFloating 的结果（重叠区也一致）
    const expect = new Uint8ClampedArray(s.doc.w * s.doc.h * 4);
    const expCells = warpFloating(s.doc, st, g.pts!, expect, false);
    eq("warpui.commit.preview-matches", JSON.stringify(g.cells), JSON.stringify(expCells));
    v.onUp(ev(dest.x, dest.y));
    dom.flush();
    ok("warpui.commit.mode-after-up", !!v.gesture.xf && v.gesture.xf.mode === "warp");
    finish(v, false);
    eq("warpui.commit.exits", v.gesture.xf === null, true);
    // 落下来的像素＝预览的像素
    let wrong = 0;
    const data = celData(s);
    for (const di of expCells) {
      const o = di * 4;
      if (data[o] !== expect[o] || data[o + 3] !== expect[o + 3]) wrong++;
    }
    eq("warpui.commit.lands-preview", wrong, 0);
    const labels = s.history.list().labels;
    eq("warpui.commit.history-count", labels.length, 1);
    eq("warpui.commit.history-label", labels[0], "sel.warp");
    ok("warpui.commit.pixels-changed", diffBytes(data, pristine) > 0);
    // 内容确实往左上挪了：左上角新位置有像素（原来在 (10,10)，柄拖到 (7,7)）
    eq("warpui.commit.moved-up-left", alpha(s, 7, 7) > 0, true);
    s.undo();
    dom.flush();
    eq("warpui.commit.undo-restores", diffBytes(celData(s), pristine), 0);
    eq("warpui.commit.undo-history", s.history.list().index, 0);
  }

  // ---- 把四角拖成一条线（结果为空）后「完成」：不许把内容吞掉 ----
  {
    const { s, v } = mk();
    paint(s, 10, 10, 6, 4);
    const pristine = new Uint8ClampedArray(celData(s));
    ok("warpui.empty.enter", warp(v, "quad"));
    // 上边两点重合、下边两点重合 -> 四边形退化成一条线
    const h = v.warpHandles();
    v.onDown(ev(h[0].x, h[0].y));
    const onto1 = sc(v, 15, 10);
    v.onMove(ev(onto1.x, onto1.y));
    v.onUp(ev(onto1.x, onto1.y));
    dom.flush();
    const h2 = v.warpHandles();
    v.onDown(ev(h2[2].x, h2[2].y));
    const onto3 = sc(v, 10, 13);
    v.onMove(ev(onto3.x, onto3.y));
    v.onUp(ev(onto3.x, onto3.y));
    dom.flush();
    eq("warpui.empty.preview-empty", (v.gesture.xf!.cells || []).length, 0);
    finish(v, false);
    eq("warpui.empty.exits", v.gesture.xf === null, true);
    eq("warpui.empty.pixels-kept", diffBytes(celData(s), pristine), 0);
    eq("warpui.empty.no-history", s.history.list().labels.length, 0);
  }

  // ---- 变形还没落笔时切工具 / 切图层 / 撤销：先落下来，别让浮动内容只活在内存里 ----
  {
    for (const how of ["tool", "layer", "undo"]) {
      const { s, v } = mk();
      paint(s, 10, 10, 6, 4);
      const pristine = new Uint8ClampedArray(celData(s));
      ok("warpui.flush." + how + ".enter", warp(v, "quad"));
      const h0 = v.warpHandles()[0];
      v.onDown(ev(h0.x, h0.y));
      const dest = sc(v, 7, 7);
      v.onMove(ev(dest.x, dest.y));
      v.onUp(ev(dest.x, dest.y));
      dom.flush();
      ok("warpui.flush." + how + ".pending", !!v.gesture.xf && v.gesture.xf.mode === "warp");
      const g = v.gesture.xf!;
      const cells = (g.cells || []).slice();
      const buf = g.buf!;
      ok("warpui.flush." + how + ".has-float", cells.length > 0 && alpha(s, 10, 10) === 0);
      if (how === "tool") s.setTool("pencil");
      else if (how === "layer") s.setLayer(0);
      else s.undo();
      dom.flush();
      eq("warpui.flush." + how + ".no-pending", v.gesture.xf, null);
      if (how === "undo") {
        // 先落下（一条历史）再撤销 -> 逐字节回到进入前
        eq("warpui.flush.undo.pixels", diffBytes(celData(s), pristine), 0);
        eq("warpui.flush.undo.index", s.history.list().index, 0);
      } else {
        // 浮动内容被真正落到图层上（不是只活在内存里），一条 sel.warp 历史
        let wrong = 0;
        const data2 = celData(s);
        for (const di of cells) {
          const o = di * 4;
          if (data2[o] !== buf[o] || data2[o + 3] !== buf[o + 3]) wrong++;
        }
        eq("warpui.flush." + how + ".landed-float", wrong, 0);
        eq("warpui.flush." + how + ".one-history", s.history.list().index, 1);
        eq("warpui.flush." + how + ".label", s.history.list().labels[0], "sel.warp");
      }
    }
  }

  // ---- 拖动走 rAF 合并的重绘（不再每次 move 同步整帧重合成）----
  {
    const { s, v } = mk();
    paint(s, 10, 10, 6, 4);
    ok("warpui.redraw.enter", warp(v, "quad"));
    const cmod = compMod as unknown as Record<string, unknown>;
    const orig = cmod.composeFrameWithOnion;
    let n = 0;
    cmod.composeFrameWithOnion = (...a: unknown[]) => { n++; return (orig as (...x: unknown[]) => unknown)(...a); };
    try {
      const h0 = v.warpHandles()[0];
      v.onDown(ev(h0.x, h0.y));
      n = 0;
      const dest = sc(v, 8, 8);
      v.onMove(ev(dest.x, dest.y));
      eq("warpui.redraw.deferred", n, 0);          // move 当场不重合成，等 rAF
      dom.flush();
      ok("warpui.redraw.after-rAF", n > 0, String(n));
      v.onUp(ev(dest.x, dest.y));
      dom.flush();
      finish(v, true);
    } finally { cmod.composeFrameWithOnion = orig; }
  }

  // ---- 口径统一：控制点＝像素下标（整数），屏幕位置＝像素中心 `(i + 0.5) * zoom + ox` ----
  // 旧口径（边框 / 像素角）下四角是 `b.x + b.w`，控制点落在像素之间的边界上（用户报的
  // 「变形点吸附半个像素」）；现在改成像素下标 `b.x + b.w - 1`，并把下标画在像素中心。
  {
    const { s, v } = mk();
    paint(s, 10, 10, 6, 4);                  // 内容像素下标 x 10..15 / y 10..13
    const sel = s.doc.sel!;
    ok("warpui.corners.enter", warp(v, "quad"));
    const b = sel.bounds()!;
    const cornerPts = [[b.x, b.y], [b.x + b.w - 1, b.y], [b.x + b.w - 1, b.y + b.h - 1], [b.x, b.y + b.h - 1]];
    const hs = v.warpHandles();
    eq("warpui.corners.count", hs.length, 4);
    eq("warpui.corners.pixel-index", v.gesture.xf!.pts!.map((p) => [p.x, p.y]), cornerPts);
    // 绘制位置＝像素中心，容差 1e-6（screenToPixel 的反函数）
    let offCentre = 0;
    for (let i = 0; i < 4; i++) {
      const p = v.gesture.xf!.pts![i];
      if (Math.abs(hs[i].x - ((p.x + 0.5) * v.zoom + v.ox)) > 1e-6) offCentre++;
      if (Math.abs(hs[i].y - ((p.y + 0.5) * v.zoom + v.oy)) > 1e-6) offCentre++;
      // 反解回下标也必须是整数（半点偏移只活在绘制里）
      const ix = (hs[i].x - v.ox) / v.zoom - 0.5, iy = (hs[i].y - v.oy) / v.zoom - 0.5;
      if (Math.abs(ix - Math.round(ix)) > 1e-6 || Math.abs(iy - Math.round(iy)) > 1e-6) offCentre++;
    }
    eq("warpui.corners.screen-centre", offCentre, 0);
    // 网格模式的控制点同样是像素下标（9 个点，四角与上面一致）
    ok("warpui.corners.mesh-enter", warp(v, "mesh"));
    const mh = v.warpHandles();
    eq("warpui.corners.mesh-count", mh.length, 9);
    eq("warpui.corners.mesh-pixel-index", [v.gesture.xf!.pts![0], v.gesture.xf!.pts![2], v.gesture.xf!.pts![8]],
      [{ x: b.x, y: b.y }, { x: b.x + b.w - 1, y: b.y }, { x: b.x + b.w - 1, y: b.y + b.h - 1 }]);
    eq("warpui.corners.mesh-integers", v.gesture.xf!.pts!.filter((p) => !Number.isInteger(p.x) || !Number.isInteger(p.y)).length, 0);
    // 恒等（把左上角拖回它自己画出来的那个屏幕点、不挪位置）：预览里选区每一个像素都还在（含最右 / 最下一列）
    const h0 = v.warpHandles()[0];
    v.onDown(ev(h0.x, h0.y));
    v.onMove(ev(h0.x, h0.y));
    v.onUp(ev(h0.x, h0.y));
    dom.flush();
    eq("warpui.corners.identity-point", [v.gesture.xf!.pts![0].x, v.gesture.xf!.pts![0].y], [b.x, b.y]);
    let lost = 0;
    for (let y = 10; y < 14; y++) for (let x = 10; x < 16; x++) if (alpha(s, x, y) !== 255) lost++;
    eq("warpui.corners.identity-covers-all", lost, 0);
    finish(v, true);
    eq("warpui.corners.revert-exits", v.gesture.xf, null);
  }

  // ---- 拖到任意小数屏幕坐标：落点粒度跟随设置（半像素＝整数或 x.5 / 整像素＝只有整数） ----
  //
  // 上一轮把落点写死成整数（`screenToPixel()` 的 floor），半像素位移被整个吃掉、
  // 屏幕落点还整体错半格（反解用的是「像素中心」坐标）。现在改成：
  //   连续坐标 = (屏幕 - ox) / zoom - 0.5   ← 绘制公式 (q + 0.5) * zoom + ox 的逆运算
  //   半像素模式：snapWarpCoord(连续, true) = Math.round(v * 2) / 2  → 整数或 x.5
  //   整像素模式：Math.round(连续)                                   → 只有整数
  // 抓住控制点不动时反解回来就是它自己，两种模式都幂等（下面都钉住）。
  {
    const { s, v } = mk();
    paint(s, 10, 10, 7, 5);
    ok("warpui.drag-int.enter", warp(v, "quad"));
    /** 落点：与 View.warpMove 用同一条公式（连续反解 + 吸附） */
    const land = (fx: number, fy: number, half: boolean): { x: number; y: number } => {
      const one = (v0: number) => (half ? snapWarpCoord(v0, true) : Math.round(v0));
      return { x: one(fx - 0.5), y: one(fy - 0.5) };
    };
    /** 拖右上角到任意小数屏幕坐标（fx, fy 是在「像素中心」坐标里说的位置） */
    const dragCorner = (fx: number, fy: number): void => {
      const h = v.warpHandles()[1];
      const dest = sc(v, fx, fy);
      v.onDown(ev(h.x, h.y));
      v.onMove(ev(dest.x, dest.y));
      v.onUp(ev(dest.x, dest.y));
      dom.flush();
    };
    const fracs: number[][] = [[12.37, 9.84], [13.5, 11.5], [20.999, 16.001], [10.5, 10.5], [6.2, 7.8]];

    // 半像素模式（默认）：横竖各一轮「整数 → 非整数 → 半像素」，每次都核对落点
    eq("warpui.drag-half.default", s.prefs.selWarpHalfSnap, true);
    let halfWrong = 0, offGranule = 0;
    for (const [fx, fy] of fracs) {
      dragCorner(fx, fy);
      const want = land(fx, fy, true);
      const p = v.gesture.xf!.pts![1];
      if (p.x !== want.x || p.y !== want.y) halfWrong++;
      if (Math.abs(p.x * 2 - Math.round(p.x * 2)) > 1e-9 || Math.abs(p.y * 2 - Math.round(p.y * 2)) > 1e-9) offGranule++;
    }
    eq("warpui.drag-half.landing", halfWrong, 0);
    eq("warpui.drag-half.granule", offGranule, 0);
    // 至少有一次真的落在 `x.5` 上（不然「半像素」只是个说法）——
    // 落在「中心与下一条边界线之间」的位置，两种取整都不会把它抹成整数
    dragCorner(13.8, 11.2);
    eq("warpui.drag-half.has-half", [v.gesture.xf!.pts![1].x, v.gesture.xf!.pts![1].y], [13.5, 10.5]);

    // 网格模式：中心点也能落在 `x.5`（9 个点同一个粒度）
    ok("warpui.drag-half.mesh-enter", warp(v, "mesh"));
    const mh = v.warpHandles()[4];
    const mdest = sc(v, 14.63, 12.21);
    v.onDown(ev(mh.x, mh.y));
    v.onMove(ev(mdest.x, mdest.y));
    v.onUp(ev(mdest.x, mdest.y));
    dom.flush();
    eq("warpui.drag-half.mesh-point", [v.gesture.xf!.pts![4].x, v.gesture.xf!.pts![4].y], [land(14.63, 12.21, true).x, land(14.63, 12.21, true).y]);
    eq("warpui.drag-half.mesh-granule",
      v.gesture.xf!.pts!.filter((p) => Math.abs(p.x * 2 - Math.round(p.x * 2)) > 1e-9 || Math.abs(p.y * 2 - Math.round(p.y * 2)) > 1e-9).length, 0);

    // 关掉半像素吸附（设置项 tools.selWarpHalfSnap 的 Session setter）：同一次拖动只落整数
    s.setSelWarpHalfSnap(false);
    eq("warpui.drag-int.prefs", s.prefs.selWarpHalfSnap, false);
    ok("warpui.drag-int.quad-enter", warp(v, "quad"));
    let intWrong = 0, nonInteger = 0;
    for (const [fx, fy] of fracs) {
      dragCorner(fx, fy);
      const want = land(fx, fy, false);
      const p = v.gesture.xf!.pts![1];
      if (p.x !== want.x || p.y !== want.y) intWrong++;
      if (!Number.isInteger(p.x) || !Number.isInteger(p.y)) nonInteger++;
    }
    eq("warpui.drag-int.landing", intWrong, 0);
    eq("warpui.drag-int.integers", nonInteger, 0);
    // 整像素模式下拖到「像素中心之间」的位置：不再出现 x.5，而是吸到最近整数
    dragCorner(13.5, 11.5);
    eq("warpui.drag-int.no-half", [v.gesture.xf!.pts![1].x, v.gesture.xf!.pts![1].y], [13, 11]);
    // 网格也一样：整像素模式下落点全是整数
    ok("warpui.drag-int.mesh-enter", warp(v, "mesh"));
    const mh2 = v.warpHandles()[4];
    const md2 = sc(v, 14.63, 12.21);
    v.onDown(ev(mh2.x, mh2.y));
    v.onMove(ev(md2.x, md2.y));
    v.onUp(ev(md2.x, md2.y));
    dom.flush();
    eq("warpui.drag-int.mesh-point", [v.gesture.xf!.pts![4].x, v.gesture.xf!.pts![4].y], [land(14.63, 12.21, false).x, land(14.63, 12.21, false).y]);
    eq("warpui.drag-int.mesh-integers", v.gesture.xf!.pts!.filter((p) => !Number.isInteger(p.x) || !Number.isInteger(p.y)).length, 0);
    // 切回半像素：粒度立刻跟着回来（同一个拖动重新落 `x.5`）
    s.setSelWarpHalfSnap(true);
    ok("warpui.drag-int.back-enter", warp(v, "quad"));
    dragCorner(13.5, 11.5);
    eq("warpui.drag-int.back-to-half", [v.gesture.xf!.pts![1].x, v.gesture.xf!.pts![1].y], [land(13.5, 11.5, true).x, land(13.5, 11.5, true).y]);
    eq("warpui.drag-int.back-prefs", s.prefs.selWarpHalfSnap, true);
    finish(v, true);
  }

  // ---- 拖动浮标：半像素模式显示一位小数，整像素模式显示整数 ----
  {
    const { s, v } = mk();
    paint(s, 10, 10, 7, 5);
    ok("warpui.label.enter", warp(v, "quad"));
    const h = v.warpHandles()[1];
    const dest = sc(v, 13.5, 11.5);
    v.onDown(ev(h.x, h.y));
    v.onMove(ev(dest.x, dest.y));
    dom.flush();
    const p = v.gesture.xf!.pts![1];
    eq("warpui.label.half", warpCoordLabel(p, true), p.x.toFixed(1) + ", " + p.y.toFixed(1));
    eq("warpui.label.whole", warpCoordLabel(p, false), Math.round(p.x) + ", " + Math.round(p.y));
    v.onUp(ev(dest.x, dest.y));
    dom.flush();
    finish(v, true);
  }

  // ---- 抓取跟手：控制点直接落在指针那一点上（拖到哪就是哪），别的点一动不动 ----
  {
    const { s, v } = mk();
    paint(s, 10, 10, 8, 6);
    /** 与 `View.warpMove()` 同一条落点公式：屏幕 → 连续下标 → 按设置吸附 */
    const landTo = (sx: number, sy: number): { x: number; y: number } => {
      const half = (v as unknown as { session: { prefs: { selWarpHalfSnap: boolean } } }).session.prefs.selWarpHalfSnap;
      const one = (n: number): number => (half ? snapWarpCoord(n, true) : Math.round(n));
      return { x: one((sx - v.ox) / v.zoom - 0.5), y: one((sy - v.oy) / v.zoom - 0.5) };
    };
    ok("warpui.grab.mesh-enter", warp(v, "mesh"));
    const h = v.warpHandles()[4];
    const p0 = { x: v.gesture.xf!.pts![4].x, y: v.gesture.xf!.pts![4].y };
    const others = JSON.stringify(v.gesture.xf!.pts!.filter((_, i) => i !== 4).map((p) => [p.x, p.y]));
    // 按在离手柄中心 (3, -2)px 处（命中半径内）：还没移动，控制点不许动
    const off = { x: 3, y: -2 };
    v.onDown(ev(h.x + off.x, h.y + off.y));
    dom.flush();
    eq("warpui.grab.point-still", [v.gesture.xf!.pts![4].x, v.gesture.xf!.pts![4].y], [p0.x, p0.y]);
    eq("warpui.grab.held", v.gesture.xf!.drag, 4);
    // 拖 2 格（＝2·zoom 屏幕像素）：控制点**跟着指针**落在指针那一点上（不是平行偏移）
    const step = 2 * v.zoom;
    const to = { x: h.x + off.x + step, y: h.y + off.y };
    v.onMove(ev(to.x, to.y));
    dom.flush();
    const want = landTo(to.x, to.y);
    eq("warpui.grab.follows-pointer", [v.gesture.xf!.pts![4].x, v.gesture.xf!.pts![4].y], [want.x, want.y]);
    v.onUp(ev(to.x, to.y));
    dom.flush();
    eq("warpui.grab.others-untouched",
      JSON.stringify(v.gesture.xf!.pts!.filter((_, i) => i !== 4).map((p) => [p.x, p.y])), others);
    finish(v, true);
  }

  // ---- 拖动内容：所有控制点跟着一起走（锚点跟着内容，而不是呆在原地） ----
  {
    const { s, v } = mk();
    paint(s, 10, 10, 8, 6);
    ok("warpui.move.enter", warp(v, "mesh"));
    const before = v.gesture.xf!.pts!.map((p) => [p.x, p.y]);
    const hs = v.warpHandles();
    // 按在一个**网格格子的中心**（离四个角都最远，不会命中任何控制点）
    const cell = {
      x: (hs[0].x + hs[1].x + hs[3].x + hs[4].x) / 4,
      y: (hs[0].y + hs[1].y + hs[3].y + hs[4].y) / 4,
    };
    v.onDown(ev(cell.x, cell.y));
    dom.flush();
    ok("warpui.move.started", !!v.gesture.xf!.move, JSON.stringify(v.gesture.xf!.move));
    eq("warpui.move.no-handle", v.gesture.xf!.drag === undefined, true);
    const step = 2 * v.zoom;                       // 2 格
    v.onMove(ev(cell.x + step, cell.y + step * 0));
    v.onUp(ev(cell.x + step, cell.y));
    dom.flush();
    eq("warpui.move.all-shifted",
      v.gesture.xf!.pts!.map((p) => [p.x, p.y]),
      before.map(([x, y]) => [x + 2, y]));
    eq("warpui.move.layer-cut", alpha(s, 12, 12), 0);   // 已经切成浮动内容
    // 完成 → 一条历史；撤销回原样
    finish(v, false);
    eq("warpui.move.history", s.history.list().labels, ["sel.warp"]);
    s.undo();
    eq("warpui.move.undo", alpha(s, 10, 10), 255);
  }

  // ---- 变换会话中途切网格变形：先把当前预览烘焙进浮动内容，控制点落在**现在**这块上 ----
  {
    const { s, v } = mk();
    paint(s, 10, 10, 8, 6);
    const f0 = v.xfScreenFrame()!;
    const c = { x: (f0.corners[0].x + f0.corners[2].x) / 2, y: (f0.corners[0].y + f0.corners[2].y) / 2 };
    ok("warpui.bake.move-session", v.beginXfMoveAt(c.x, c.y), "会话");
    const step = 4 * v.zoom;                      // 右移 4 格
    v.onMove(ev(c.x + step, c.y));
    v.onUp(ev(c.x + step, c.y));
    dom.flush();
    const moved = (v.gesture.xf as unknown as { cells?: number[] }).cells ?? [];
    ok("warpui.bake.moved-preview", moved.length > 0, String(moved.length));
    ok("warpui.bake.enter", warp(v, "mesh"));
    // 控制点应当落在**移动后**的位置（内容 10..17 → 14..21）
    eq("warpui.bake.points-follow", v.gesture.xf!.pts![0].x, 14);
    eq("warpui.bake.layer-origin", v.gesture.xf!.st.ox, 14);
    // 预览没有跳回原位：画布上亮的像素仍在右移后的那一块
    const seen = new Set<number>();
    for (const di of (v.gesture.xf!.cells ?? [])) seen.add(di % s.doc.w);
    const xs = [...seen].sort((a, b) => a - b);
    eq("warpui.bake.preview-not-reset", [xs[0], xs[xs.length - 1]], [14, 21]);
    // 撤销仍然回到会话开始那一刻（烘焙只改浮动内容，`st.before` 不动）
    finish(v, false);
    eq("warpui.bake.one-history", s.history.list().labels, ["sel.warp"]);
    s.undo();
    eq("warpui.bake.undo-restores", alpha(s, 10, 10), 255);
  }

  // ---- 覆盖层顺序：选区框 / 抓手 / 变形控制点必须画在浮动内容**之后**（＝图像之上） ----
  {
    const src = fs.readFileSync(path.resolve(__dirname, "../../../src/render/view.ts"), "utf8");
    // 声明锚点用整行签名（`drawOverlay` 现在是 `GestureHost` 的接触面之一，不再带 `private`；
    // 只搜 "drawOverlay(" 会命中 `refresh()` 里的调用点，所以锚到声明那一段）
    const i = src.indexOf("  drawOverlay(rebuildTint = false): void {");
    ok("warpui.order.has-draw-overlay", i > 0, "drawOverlay()");
    const body = src.slice(i, src.indexOf("\n  }", i));
    const floatAt = body.indexOf("if (xfg && xfg.cut && xfg.buf && xfg.cells");
    const frameAt = body.indexOf("this.drawSelTransform();");
    ok("warpui.order.float-before-frame", floatAt > 0 && frameAt > floatAt,
      JSON.stringify({ floatAt, frameAt }));
  }
}
