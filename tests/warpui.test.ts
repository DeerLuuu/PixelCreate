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
import * as compMod from "../src/render/compositor";
import { stubEnv } from "./session.test";
import { stubViewDom } from "./view.test";
import { eq, ok } from "./common";

interface VX {
  ox: number; oy: number; zoom: number;
  xf: null | {
    mode: string; moved: boolean; cut?: boolean; cells?: number[]; buf?: Uint8ClampedArray; pts?: Pt[];
    warpKind?: string; drag?: number; st: MoveState; li: number; fi: number;
  };
  lastWarpError: "noSel" | "tooThin" | "locked" | null;
  onDown(e: PointerEvent): void; onMove(e: PointerEvent): void; onUp(e: PointerEvent): void;
  warpHandles(): Array<{ x: number; y: number }>;
}
interface Pt { x: number; y: number }

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
    eq("warpui.enter.mode", v.xf!.mode, "warp");
    eq("warpui.enter.cells-empty", v.xf!.cells === undefined, true);
    eq("warpui.enter.layer-untouched", diffBytes(celData(s), pristine), 0);
    eq("warpui.enter.mask-untouched", diffBytes(s.doc.sel!.mask, mask0), 0);
    eq("warpui.enter.no-history", s.history.list().labels.length, 0);
    eq("warpui.enter.not-moved", v.xf!.moved, false);
    ok("warpui.enter.handles-4", v.warpHandles().length === 4);
    eq("warpui.enter.alpha-intact", alpha(s, 10, 10), 255);
  }

  // ---- 一次没有抓住手柄的 pointermove：不许改模式、不许顶掉预览、不许切图层 ----
  {
    const { s, v } = mk();
    paint(s, 10, 10, 20, 14);
    const pristine = new Uint8ClampedArray(celData(s));
    ok("warpui.stray.enter", warp(v, "quad"));
    const pts0 = JSON.stringify(v.xf!.pts);
    const cells0 = JSON.stringify(v.xf!.cells ?? null);
    const hover = sc(v, 19, 17);                 // 选区内部，离四个角都 > 22 屏幕像素
    v.onMove(ev(hover.x, hover.y));
    dom.flush();
    ok("warpui.stray.keeps-mode", !!v.xf && v.xf.mode === "warp");
    eq("warpui.stray.keeps-points", JSON.stringify(v.xf!.pts), pts0);
    eq("warpui.stray.keeps-cells", JSON.stringify(v.xf!.cells ?? null), cells0);
    eq("warpui.stray.not-moved", v.xf!.moved, false);
    eq("warpui.stray.no-cut", alpha(s, 12, 12), 255);
    eq("warpui.stray.pixels", diffBytes(celData(s), pristine), 0);
    eq("warpui.stray.no-history", s.history.list().labels.length, 0);
    // 网格模式同样：9 个控制点、悬停不动
    eq("warpui.stray.mesh-mismatch", warp(v, "mesh"), true);
    ok("warpui.stray.mesh-9-points", (v.xf!.pts || []).length === 9);
    v.onMove(ev(sc(v, 29, 19).x, sc(v, 29, 19).y));
    dom.flush();
    ok("warpui.stray.mesh-keeps-mode", !!v.xf && v.xf.mode === "warp" && v.xf!.warpKind === "mesh");
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
    ok("warpui.hold.drag1-applied", v.xf!.pts![0].x === 7 && v.xf!.pts![0].y === 7);
    v.onUp(ev(d1.x, d1.y));
    dom.flush();
    ok("warpui.hold.mode-after-up", !!v.xf && v.xf.mode === "warp");
    eq("warpui.hold.drag-cleared", v.xf!.drag === undefined, true);
    eq("warpui.hold.handles-alive", v.warpHandles().length, 4);
    eq("warpui.hold.no-history-yet", s.history.list().labels.length, 0);
    // 第二个控制点：把右下角往外拉
    const h2 = v.warpHandles()[2];
    v.onDown(ev(h2.x, h2.y));
    const d2 = sc(v, 19, 17);
    v.onMove(ev(d2.x, d2.y));
    dom.flush();
    ok("warpui.hold.drag2-applied", v.xf!.pts![2].x === 19 && v.xf!.pts![2].y === 17);
    eq("warpui.hold.two-points-changed", v.xf!.pts![0].x === 7 && v.xf!.pts![2].x === 19, true);
    v.onUp(ev(d2.x, d2.y));
    dom.flush();
    ok("warpui.hold.still-warp", !!v.xf && v.xf.mode === "warp");
    // 还原（此时还没落笔）→ 像素与掩码都逐字节回到进入前
    finish(v, true);
    eq("warpui.hold.revert-exits", v.xf === null, true);
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
    eq("warpui.idle.no-sel-drag", (v as unknown as { selDrag: unknown }).selDrag, null);
    v.onUp(ev(tap.x, tap.y));
    dom.flush();
    ok("warpui.idle.tap-keeps-mode", !!v.xf && v.xf.mode === "warp");
    eq("warpui.idle.tap-pixels", diffBytes(celData(s), pristine), 0);
    eq("warpui.idle.tap-no-history", s.history.list().labels.length, 0);
    finish(v, false);                            // 「完成」：没拖过＝什么都不做
    eq("warpui.idle.done-exits", v.xf === null, true);
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
      eq("warpui.thin." + tag + ".no-xf", v.xf === null, true);
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
    const g = v.xf!;
    eq("warpui.commit.first-drag-cuts", alpha(s, 10, 10), 0);
    eq("warpui.commit.moved", g.moved, true);
    // 预览＝warpFloating 的结果（重叠区也一致）
    const expect = new Uint8ClampedArray(s.doc.w * s.doc.h * 4);
    const expCells = warpFloating(s.doc, st, g.pts!, expect, false);
    eq("warpui.commit.preview-matches", JSON.stringify(g.cells), JSON.stringify(expCells));
    v.onUp(ev(dest.x, dest.y));
    dom.flush();
    ok("warpui.commit.mode-after-up", !!v.xf && v.xf.mode === "warp");
    finish(v, false);
    eq("warpui.commit.exits", v.xf === null, true);
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
    eq("warpui.empty.preview-empty", (v.xf!.cells || []).length, 0);
    finish(v, false);
    eq("warpui.empty.exits", v.xf === null, true);
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
      ok("warpui.flush." + how + ".pending", !!v.xf && v.xf.mode === "warp");
      const g = v.xf!;
      const cells = (g.cells || []).slice();
      const buf = g.buf!;
      ok("warpui.flush." + how + ".has-float", cells.length > 0 && alpha(s, 10, 10) === 0);
      if (how === "tool") s.setTool("pencil");
      else if (how === "layer") s.setLayer(0);
      else s.undo();
      dom.flush();
      eq("warpui.flush." + how + ".no-pending", v.xf, null);
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
    eq("warpui.corners.pixel-index", v.xf!.pts!.map((p) => [p.x, p.y]), cornerPts);
    // 绘制位置＝像素中心，容差 1e-6（screenToPixel 的反函数）
    let offCentre = 0;
    for (let i = 0; i < 4; i++) {
      const p = v.xf!.pts![i];
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
    eq("warpui.corners.mesh-pixel-index", [v.xf!.pts![0], v.xf!.pts![2], v.xf!.pts![8]],
      [{ x: b.x, y: b.y }, { x: b.x + b.w - 1, y: b.y }, { x: b.x + b.w - 1, y: b.y + b.h - 1 }]);
    eq("warpui.corners.mesh-integers", v.xf!.pts!.filter((p) => !Number.isInteger(p.x) || !Number.isInteger(p.y)).length, 0);
    // 恒等（把左上角拖回它自己画出来的那个屏幕点、不挪位置）：预览里选区每一个像素都还在（含最右 / 最下一列）
    const h0 = v.warpHandles()[0];
    v.onDown(ev(h0.x, h0.y));
    v.onMove(ev(h0.x, h0.y));
    v.onUp(ev(h0.x, h0.y));
    dom.flush();
    eq("warpui.corners.identity-point", [v.xf!.pts![0].x, v.xf!.pts![0].y], [b.x, b.y]);
    let lost = 0;
    for (let y = 10; y < 14; y++) for (let x = 10; x < 16; x++) if (alpha(s, x, y) !== 255) lost++;
    eq("warpui.corners.identity-covers-all", lost, 0);
    finish(v, true);
    eq("warpui.corners.revert-exits", v.xf, null);
  }

  // ---- 拖到任意小数屏幕坐标：写回的控制点永远是整数像素下标（不许出现 x.5） ----
  {
    const { s, v } = mk();
    paint(s, 10, 10, 7, 5);
    ok("warpui.drag-int.enter", warp(v, "quad"));
    const fracs: number[][] = [[12.37, 9.84], [13.5, 11.5], [20.999, 16.001], [10.5, 10.5], [6.2, 7.8]];
    let nonInteger = 0, notFloored = 0;
    for (const [fx, fy] of fracs) {
      const h = v.warpHandles()[1];                 // 右上角
      const dest = sc(v, fx, fy);                   // 任意小数屏幕坐标
      v.onDown(ev(h.x, h.y));
      v.onMove(ev(dest.x, dest.y));
      v.onUp(ev(dest.x, dest.y));
      dom.flush();
      const p = v.xf!.pts![1];
      if (!Number.isInteger(p.x) || !Number.isInteger(p.y)) nonInteger++;
      if (p.x !== Math.floor(fx) || p.y !== Math.floor(fy)) notFloored++;
    }
    eq("warpui.drag-int.integers", nonInteger, 0);
    eq("warpui.drag-int.floor", notFloored, 0);
    // 网格也一样：拖中心点到小数坐标后仍是整数下标
    ok("warpui.drag-int.mesh-enter", warp(v, "mesh"));
    const mh = v.warpHandles()[4];
    const mdest = sc(v, 14.63, 12.21);
    v.onDown(ev(mh.x, mh.y));
    v.onMove(ev(mdest.x, mdest.y));
    v.onUp(ev(mdest.x, mdest.y));
    dom.flush();
    eq("warpui.drag-int.mesh-point", [v.xf!.pts![4].x, v.xf!.pts![4].y], [14, 12]);
    eq("warpui.drag-int.mesh-integers", v.xf!.pts!.filter((p) => !Number.isInteger(p.x) || !Number.isInteger(p.y)).length, 0);
    finish(v, true);
  }
}
