// 选区自由变换（Aseprite 那套：移动 + 缩放 + 旋转 + 斜切）的**交互状态机**回归。
//
// 与 `tests/warpui.test.ts` 的分工：
//   · warpui   = 四点 / 网格自由变形（额外能力，口径不动）；
//   · 本文件    = 内圈缩放 / 外圈旋转斜切（PC）、独立抓手（触屏）、枢轴、
//                像素精确通道、以及「一次会话一条 undo」的事务语义。
//
// 全部走无头 View（`stubEnv()` + `stubViewDom()` + 指针事件注入），不依赖真 DOM。
import { Sel } from "../src/engine/doc";
import { Session } from "../src/app/session";
import { View, PIVOT_ORDER } from "../src/render/view";
import { beginMove, xformAffineFloating, xformAffineDestBox, type MoveState } from "../src/tools/select";
import {
  affineFrom, applyAffine, exactMove, solveSkew, toFrameLocal,
  ANCHORS, PIVOT_PRESETS, PC_HIT, TOUCH_HIT, TOUCH_MID_SPAN, TOUCH_OFF_CORNER, TOUCH_OFF_OUTER,
  touchHitRadius, touchOuterOffset, solveRotate,
  type AnchorId, type XfKind,
} from "../src/tools/xform";
import { applyPcMode } from "../src/io/pcmode";
import { stubEnv } from "./session.test";
import { stubViewDom } from "./view.test";
import { eq, ok } from "./common";

interface XfG {
  mode: string;
  st: MoveState;
  moved: boolean;
  cut?: boolean;
  cells?: number[];
  buf?: Uint8ClampedArray;
  exact?: { dx: number; dy: number; steps: number };
  tp?: {
    pivot: { x: number; y: number }; angle: number; sx: number; sy: number;
    skewX?: number; skewY?: number; shift?: { x: number; y: number };
  };
  kinds?: { move: boolean; scale: boolean; rotate: boolean; skew: boolean };
  pivotTouched?: boolean;
}
interface Grab { kind: XfKind; anchor?: AnchorId; x: number; y: number }
interface VX {
  ox: number; oy: number; zoom: number;
  xf: XfG | null;
  xfDrag: { kind: XfKind; anchor?: AnchorId } | null;
  lastWarpError: "noSel" | "tooThin" | "locked" | null;
  onDown(e: PointerEvent): void; onMove(e: PointerEvent): void; onUp(e: PointerEvent): void;
  xfScreenFrame(): { corners: Array<{ x: number; y: number }>; angle: number; spanX: number; spanY: number } | null;
  session: Session;
  xfHitAt(p: { x: number; y: number }): { kind: XfKind; anchor?: AnchorId } | null;
  xfGrabs(): Grab[];
  xfPivotScreen(): { x: number; y: number } | null;
  hitRadii(): { inner: number; outer: number };
  touchLayoutNow(): { corners: boolean; edges: boolean; rotate: boolean; skew: boolean } | null;
  transforming: boolean;
  pivotPreset(): string | null;
  setPivotPreset(k: string): boolean;
  cyclePivot(): string | null;
  commitXf(): void;
  revertXf(): void;
  beginWarp(k: string): boolean;
  finishWarp(revert: boolean): void;
}

/** 两个字节数组差了几个字节 */
function diffBytes(a: Uint8ClampedArray | Uint8Array, b: Uint8ClampedArray | Uint8Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

export function testXformUi(): void {
  stubEnv();
  const dom = stubViewDom();
  const host = {
    clientWidth: 320, clientHeight: 240, style: {},
    appendChild: () => undefined, replaceChildren: () => undefined,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 240 }),
    addEventListener: () => undefined,
    setPointerCapture: () => undefined, releasePointerCapture: () => undefined,
  } as unknown as HTMLElement;
  const ev = (x: number, y: number, type: "touch" | "mouse" = "touch"): PointerEvent => ({
    clientX: x, clientY: y, pointerId: 1, pointerType: type, pressure: 1,
    preventDefault: () => undefined, stopPropagation: () => undefined,
  } as unknown as PointerEvent);

  /** 测试床：无头 View + 固定视口（zoom=4、画布左上角在屏幕 (8,8)） */
  const mk = (pc = false): { s: Session; v: VX } => {
    applyPcMode(pc ? "on" : "off");
    const s = new Session();
    s.setTool("select");
    const v = new View(host, s) as unknown as VX;
    s.attachView(v as unknown as View);
    (v as unknown as { fit(): void }).fit();
    v.zoom = 4; v.ox = 8; v.oy = 8;
    (v as unknown as { lastView: unknown }).lastView = { ox: 8, oy: 8, zoom: 4, w: 320, h: 240 };
    dom.flush();
    return { s, v };
  };
  /** 画一块 w×h 的实心块并把选区设成它 */
  const paint = (s: Session, x0: number, y0: number, w: number, h: number): void => {
    const doc = s.doc;
    const cel = doc.ensureCel(s.curLayer(), s.curFrame());
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const i = cel.idx(x, y);
        cel.data[i] = 10 + x - x0; cel.data[i + 1] = 100 + y - y0; cel.data[i + 2] = 200; cel.data[i + 3] = 255;
      }
    }
    doc.sel = new Sel(doc.w, doc.h);
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) doc.sel.set(x, y, 1);
  };
  const celData = (s: Session): Uint8ClampedArray => s.doc.celAt(s.curLayer(), s.curFrame())!.data;
  const alpha = (s: Session, x: number, y: number): number => {
    const cel = s.doc.celAt(s.curLayer(), s.curFrame());
    return cel ? cel.data[cel.idx(x, y) + 3] : -1;
  };
  /**
   * 会话里的**浮动预览**在某个画布像素上有没有内容。
   * 松手之前像素只活在 `xf.buf`（画布尺寸的 RGBA 缓冲）里，`xf.cells` 是被点亮的像素下标，
   * 所以这里按 `(y * w + x) * 4 + 3` 读 alpha —— 不是别的偏移。
   */
  const previewAt = (s: Session, x: number, y: number): boolean => {
    const g = (s.view as unknown as VX | null)?.xf;
    if (!g || !g.buf) return false;
    return g.buf[(y * s.doc.w + x) * 4 + 3] > 0;
  };
  /** 会话里的**浮动预览**覆盖的画布像素范围（没有预览时返回 null） */
  const previewBox = (v: VX): { x0: number; y0: number; x1: number; y1: number } | null => {
    const g = v.xf;
    if (!g || !g.buf) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        if (g.buf[(y * 64 + x) * 4 + 3] > 0) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
  };
  /** 下标空间 → 屏幕（zoom=4、ox=oy=8 的固定床） */
  const near = (a: number, b: number, t = 1e-9): boolean => Math.abs(a - b) <= t;
  const sc = (i: number, j: number): { x: number; y: number } => ({ x: (i + 0.5) * 4 + 8, y: (j + 0.5) * 4 + 8 });
  /** 取视图所属的 Session（测试床里 View 与 Session 是一一对应的） */
  const sessionOf = (v: VX): Session | null => (v as unknown as { session?: Session }).session ?? null;
  /** 选区框在屏幕上的矩形（不受会话影响；`View` 上已有一个只读访问器） */
  const selBox = (s: Session, v: VX): { x0: number; y0: number; x1: number; y1: number } | null => {
    const b = s.doc.sel?.bounds();
    if (!b) return null;
    return { x0: b.x * v.zoom + v.ox, y0: b.y * v.zoom + v.oy, x1: (b.x + b.w) * v.zoom + v.ox, y1: (b.y + b.h) * v.zoom + v.oy };
  };
  /** 屏幕 → 下标空间（连续） */
  const px = (x: number, y: number): { x: number; y: number } => ({ x: (x - 8) / 4 - 0.5, y: (y - 8) / 4 - 0.5 });
  const mid = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const anchorScreen = (v: VX, id: AnchorId): { x: number; y: number } => {
    const f = v.xfScreenFrame()!;                    // 调用前必须保证有选区（或会话）
    const list = [f.corners[0], mid(f.corners[0], f.corners[1]), f.corners[1], mid(f.corners[1], f.corners[2]),
      f.corners[2], mid(f.corners[2], f.corners[3]), f.corners[3], mid(f.corners[3], f.corners[0])];
    return list[ANCHORS.indexOf(id)];
  };
  const drag = (v: VX, from: { x: number; y: number }, to: { x: number; y: number }, pc = false): void => {
    const t = pc ? "mouse" : "touch";
    v.onDown(ev(from.x, from.y, t));
    v.onMove(ev(to.x, to.y, t));
    v.onUp(ev(to.x, to.y, t));
    dom.flush();
  };
  const dragBy = (v: VX, from: { x: number; y: number }, dx: number, dy: number, pc = false): void => {
    drag(v, from, { x: from.x + dx, y: from.y + dy }, pc);
  };
  /** 会话里把枢轴设到 9 档预设之一（缩放 / 旋转的数值因此可精确预期） */
  const setPivot = (v: VX, k: string): void => {
    ok("xformui.helper.set-pivot", v.setPivotPreset(k), k);
  };
  /** 框中心在屏幕上的位置（＝默认枢轴；会话外也能用） */
  const pivotOfFrame = (v: VX): { x: number; y: number } | null => {
    const f = v.xfScreenFrame();
    if (!f) return null;
    return { x: (f.corners[0].x + f.corners[2].x) / 2, y: (f.corners[0].y + f.corners[2].y) / 2 };
  };
  /** 绕着枢轴按「起点方向 + 增量角」拖某个抓手（半径不变；旋转用例共用）。
   *  `pvHint` 是抓起手时**预判**的枢轴位置（会话还没建起来时 `xfPivotScreen()` 是 null）。 */
  const dragRotate = (v: VX, from: { x: number; y: number }, deltaRad: number): void => {
    const pv = v.xfPivotScreen() ?? pivotOfFrame(v) ?? { x: 0, y: 0 };
    const a0 = Math.atan2(from.y - pv.y, from.x - pv.x);
    const r = Math.hypot(from.x - pv.x, from.y - pv.y) || 1;
    const to = { x: pv.x + Math.cos(a0 + deltaRad) * r, y: pv.y + Math.sin(a0 + deltaRad) * r };
    v.onDown(ev(from.x, from.y, "mouse"));
    v.onMove(ev(to.x, to.y, "mouse"));
    v.onUp(ev(to.x, to.y, "mouse"));
    dom.flush();
  };
  /** 外圈旋转抓手在屏幕上的位置（角的 45° 外侧 30px） */
  const rotGrabAt = (v: VX, id: AnchorId): { x: number; y: number } => {
    // 没有会话时 `xfScreenFrame()` 是 null：先按框内空白处按一下，把会话开起来（不移动）
    const pre = v.xfScreenFrame();
    if (!pre) {
      const sess = sessionOf(v);
      const box = sess ? selBox(sess, v) : null;
      if (box) {
        const c = { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };
        v.onDown(ev(c.x, c.y, "mouse"));
        v.onUp(ev(c.x, c.y, "mouse"));
      }
    }
    const f = v.xfScreenFrame();
    if (!f) return { x: 0, y: 0 };                   // 没有选区 / 会话时别把测试炸掉
    const a = anchorScreen(v, id);
    const c = { x: (f.corners[0].x + f.corners[2].x) / 2, y: (f.corners[0].y + f.corners[2].y) / 2 };
    const vx = a.x - c.x, vy = a.y - c.y;
    const len = Math.hypot(vx, vy) || 1;
    return { x: a.x + (vx / len) * 28, y: a.y + (vy / len) * 28 };
  };

  // ================================================================ PC 的两层同心圈
  {
    const { s, v } = mk(true);
    paint(s, 10, 10, 24, 24);                     // 内容 24×24 → 屏幕 92×92
    const tl = anchorScreen(v, "tl");
    const tlx = tl.x, tly = tl.y;
    eq("xformui.pc.radii", v.hitRadii(), PC_HIT);
    // 内圈（22px）＝缩放：角往外 12px 处（离相邻的「上边中点」还有 28px）
    eq("xformui.pc.inner-scale", v.xfHitAt({ x: tl.x + 12, y: tl.y }), { kind: "scale", anchor: "tl" });
    // 外圈（22..34px）＝角旋转（沿对角线向外 30px 处，tl 比相邻的边中点更近）
    eq("xformui.pc.outer-rotate", v.xfHitAt({ x: tl.x - 30 / Math.SQRT2, y: tl.y - 30 / Math.SQRT2 }),
      { kind: "rotate", anchor: "tl" });
    const top = anchorScreen(v, "t");
    eq("xformui.pc.edge-skew", v.xfHitAt({ x: top.x, y: top.y - 30 }), { kind: "skew", anchor: "t" });
    eq("xformui.pc.beyond", v.xfHitAt({ x: top.x, y: top.y - 40 }), null);
    // 框正中（离一切锚点都超过 34px 的外圈）：什么也不算，交给「移动内容」
    eq("xformui.pc.inside-none", v.xfHitAt({ x: tlx + 40, y: tly + 45 }), null);
    // 半径是**屏幕常量**：画布缩到 1× 后 12px 处仍然算内圈（画布尺寸也缩了 4 倍）
    v.zoom = 1; v.ox = 8; v.oy = 8;
    const tl1 = anchorScreen(v, "tl");
    eq("xformui.pc.zoom-invariant",
      v.xfHitAt({ x: tl1.x + 6 / Math.SQRT2, y: tl1.y - 6 / Math.SQRT2 }), { kind: "scale", anchor: "tl" });
    v.zoom = 4; v.ox = 8; v.oy = 8;
    eq("xformui.pc.no-grabs", v.xfGrabs(), []);   // 独立抓手是触屏的画法
  }

  // ================================================================ 触屏独立抓手：命中 + 互不重叠
  {
    const { s, v } = mk(false);
    paint(s, 10, 10, 46, 46);                     // 184×184 屏幕：够摆全部 16 个抓手
    eq("xformui.touch.layout", v.touchLayoutNow(), { corners: true, edges: true, rotate: true, skew: true });
    const grabs = v.xfGrabs();
    eq("xformui.touch.count", grabs.length, 16);  // 8 个缩放 + 4 旋转 + 4 斜切
    // 抓手按**锚点**成对摆：角＝缩放 + 旋转，边＝缩放 + 斜切
    eq("xformui.touch.grab-kinds", grabs.map((g) => g.kind),
      ["scale", "rotate", "scale", "skew", "scale", "rotate", "scale", "skew",
        "scale", "rotate", "scale", "skew", "scale", "rotate", "scale", "skew"]);
    const rotG = grabs.find((g) => g.kind === "rotate")!;
    const corG = grabs.find((g) => g.kind === "scale")!;
    ok("xformui.touch.grab-offset",
      near(Math.hypot(rotG.x - corG.x, rotG.y - corG.y),
        touchOuterOffset(v.xfScreenFrame()!.spanX) - TOUCH_OFF_CORNER, 1e-6),
      String(Math.hypot(rotG.x - corG.x, rotG.y - corG.y)));
    eq("xformui.touch.radii", v.hitRadii(), TOUCH_HIT);
    ok("xformui.touch.radius-finger", TOUCH_HIT.inner >= 38 && touchHitRadius(v.xfGrabs()) >= 38);
    let min = Infinity;
    for (let i = 0; i < grabs.length; i++) {
      for (let j = i + 1; j < grabs.length; j++) {
        min = Math.min(min, Math.hypot(grabs[i].x - grabs[j].x, grabs[i].y - grabs[j].y));
      }
    }
    ok("xformui.touch.no-overlap", min >= TOUCH_HIT.inner * 2, "min=" + min.toFixed(1));
    let hits = 0;
    for (const g of grabs) {
      const h = v.xfHitAt({ x: g.x, y: g.y });
      if (h && h.kind === g.kind && h.anchor === g.anchor) hits++;
    }
    eq("xformui.touch.each-hittable", hits, grabs.length);
    // 小选区（短边 < 90px）：退化成角缩放 + 角旋转，仍不重叠
    const small = mk(false);
    paint(small.s, 10, 10, 26, 26);               // 104×104 屏幕：角缩放 + 角旋转
    eq("xformui.touch.small-layout", small.v.touchLayoutNow(), { corners: true, edges: false, rotate: true, skew: false });
    const g2 = small.v.xfGrabs();
    eq("xformui.touch.small-count", g2.length, 8);
    let min2 = Infinity;
    for (let i = 0; i < g2.length; i++) {
      for (let j = i + 1; j < g2.length; j++) min2 = Math.min(min2, Math.hypot(g2[i].x - g2[j].x, g2[i].y - g2[j].y));
    }
    ok("xformui.touch.small-no-overlap", min2 >= TOUCH_HIT.inner * 2, "min=" + min2.toFixed(1));
    // 极小选区：只剩 4 个角缩放
    const tiny = mk(false);
    paint(tiny.s, 10, 10, 12, 12);                // 48×48 屏幕：只剩角缩放
    eq("xformui.touch.tiny-layout", tiny.v.touchLayoutNow(), { corners: true, edges: false, rotate: false, skew: false });
    eq("xformui.touch.tiny-count", tiny.v.xfGrabs().length, 4);
    ok("xformui.touch.threshold", TOUCH_MID_SPAN === 80);
    // 触屏抓手的拖动真的走对应语义（旋转抓手 → 旋转）
    const use = mk(false);
    paint(use.s, 10, 10, 46, 46);
    const rotGrab = use.v.xfGrabs().find((g) => g.kind === "rotate" && g.anchor === "tl")!;
    use.v.onDown(ev(rotGrab.x, rotGrab.y));
    dom.flush();
    eq("xformui.touch.rotate-grab-kind", use.v.xfDrag?.kind, "rotate");
    eq("xformui.touch.rotate-grab-anchor", use.v.xfDrag?.anchor, "tl");
    use.v.onUp(ev(rotGrab.x, rotGrab.y));
    use.v.revertXf();
  }

  // ================================================================ 缩放：内圈 + 等比 + 镜像 + 网格吸附
  {
    const { s, v } = mk(true);
    paint(s, 10, 10, 6, 4);
    const pristine = new Uint8ClampedArray(celData(s));
    const br = anchorScreen(v, "br");
    v.onDown(ev(br.x, br.y, "mouse"));
    dom.flush();
    eq("xformui.scale.enter-kind", v.xfDrag?.kind, "scale");
    eq("xformui.scale.enter-anchor", v.xfDrag?.anchor, "br");
    eq("xformui.scale.enter-hidden", v.xf!.cut, false);      // 只按下去不改图层
    eq("xformui.scale.enter-pixels", diffBytes(celData(s), pristine), 0);
    setPivot(v, "tl");                            // 左上角＝不动点 → 基线可精确预期
    v.onMove(ev(br.x + 16, br.y + 12, "mouse"));   // 往外 (+4, +3) 格 → 2×
    dom.flush();
    eq("xformui.scale.factors", [v.xf!.tp!.sx, v.xf!.tp!.sy], [2, 2]);
    eq("xformui.scale.anchor-fixed", alpha(s, 10, 10), 0);         // 浮动内容已经切走（在预览里）
    // 预览范围＝缩放后的像素范围（绕不动点 2×，内容 6×4 → 8×6 格，下标 10..17 / 10..15）
    {
      const box = previewBox(v);
      eq("xformui.scale.preview-box", box, { x0: 10, y0: 10, x1: 20, y1: 16 });
      eq("xformui.scale.preview-corner", previewAt(s, 10, 10), true);   // 不动点那个像素还在原位
      eq("xformui.scale.preview-far", previewAt(s, 20, 16), true);      // 放大后的最右下角
      eq("xformui.scale.preview-outside", previewAt(s, 21, 17), false); // 再往外就没有了
    }
    v.onUp(ev(br.x + 16, br.y + 12, "mouse"));
    dom.flush();
    eq("xformui.scale.one-session", v.transforming, true);        // 松手不结束会话
    eq("xformui.scale.no-history-yet", s.history.list().labels.length, 0);
    v.commitXf();
    eq("xformui.scale.history", s.history.list().labels, ["sel.scale"]);
    s.undo();
    eq("xformui.scale.undo", diffBytes(celData(s), pristine), 0);

    // 自由 vs 等比
    const a = mk(true);
    paint(a.s, 10, 10, 6, 4);
    const brA = anchorScreen(a.v, "br");
    a.v.onDown(ev(brA.x, brA.y, "mouse"));
    setPivot(a.v, "tl");
    dragBy(a.v, brA, 12, 0, true);                              // 只往右 3 格 → 1.6×
    eq("xformui.scale.free-axis", [a.v.xf!.tp!.sx, a.v.xf!.tp!.sy], [2, 1]);
    a.v.revertXf();
    const b = mk(true);
    paint(b.s, 10, 10, 6, 4);
    b.s.setSetting("tools.selXformAspect", true);
    const brB2 = anchorScreen(b.v, "br");
    b.v.onDown(ev(brB2.x, brB2.y, "mouse"));
    setPivot(b.v, "tl");
    dragBy(b.v, brB2, 12, 0, true);
    eq("xformui.scale.aspect-chip", [b.v.xf!.tp!.sx, b.v.xf!.tp!.sy], [2, 2]);
    b.v.revertXf();

    // 镜像：把右下角拖过不动点 → 两轴变负（内容翻到左上）
    const c = mk(true);
    paint(c.s, 10, 10, 6, 4);
    const brC = anchorScreen(c.v, "br");
    c.v.onDown(ev(brC.x, brC.y, "mouse"));
    setPivot(c.v, "tl");
    dragBy(c.v, brC, -32, -24, true);             // 拖过不动点 → 两轴都翻负（20/12 屏幕格）
    eq("xformui.scale.mirror", [c.v.xf!.tp!.sx, c.v.xf!.tp!.sy], [-0.6, -1]);
    // 翻转后的内容落在不动点左侧：像素从 (10,10) 翻到 (4,6) 一带
    // 翻转后内容长到不动点左侧：向右下拖过不动点 → 内容镜像到 (10,10) 的左上方向
    ok("xformui.scale.mirror-lands", previewAt(c.s, 8, 8) && previewAt(c.s, 9, 9), "mirrored content lands left of the pivot");
    c.v.commitXf();
    eq("xformui.scale.mirror-history", c.s.history.list().labels, ["sel.scale"]);
    c.s.undo();

    // 网格吸附：拖 1.5 格 → 吸附后正好 2×
    const e = mk(true);
    paint(e.s, 10, 10, 6, 4);
    e.s.setSetting("tools.selXformGridSnap", true);
    const brE = anchorScreen(e.v, "br");
    e.v.onDown(ev(brE.x, brE.y, "mouse"));
    setPivot(e.v, "tl");
    dragBy(e.v, brE, 16, 8, true);                       // (+4, +2) 格 → 吸到 2×
    eq("xformui.scale.grid-snap", [e.v.xf!.tp!.sx, e.v.xf!.tp!.sy], [2, 2]);
    e.v.revertXf();
  }

  // 旋转求解的纯函数（在 View 之前先钉一遍）：拖 90° 就是 90°，吸附不吃掉整圈的绕数
  {
    const deg = (r: number): number => (r * 180) / Math.PI;
    ok("xformui.rot-solve.90", Math.abs(Math.abs(deg(solveRotate({ x: 10, y: 0 }, { x: 0, y: 10 }, false).angle)) - 90) < 1e-9);
    ok("xformui.rot-solve.snap-90",
      Math.abs(Math.abs(deg(solveRotate({ x: 10, y: 0 }, { x: 0, y: 10 }, true).angle)) - 90) < 1e-9);
    ok("xformui.rot-solve.snap-92",
      Math.abs(Math.abs(deg(solveRotate({ x: 10, y: 0 }, { x: Math.cos(1.6057) * 10, y: Math.sin(1.6057) * 10 }, true).angle)) - 90) < 1e-9);
  }

  // ================================================================ 旋转：外圈 + 干净角吸附 + 一条历史
  {
    const { s, v } = mk(true);
    paint(s, 10, 10, 8, 8);                       // 方正一点，外圈不会被相邻锚点抢走
    const grab = rotGrabAt(v, "tl");
    s.setSetting("tools.selXformAngleSnap", true);
    dragRotate(v, grab, (30 * Math.PI) / 180);
    ok("xformui.rot.session-alive", !!v.xf, "session");
    ok("xformui.rot.preview-alive", !!v.xf && (v.xf.cells || []).length > 0,
      String(v.xf ? (v.xf.cells || []).length : -1));
    if (v.xf) {
      const deg = (v.xf.tp!.angle * 180) / Math.PI;
      // 吸附开着时角度必须落在**干净角**的刻度上（0 / 26.565 / 45 / 63.435 / 90 …）
      const clean = Math.abs(deg / 26.56505117707799 - Math.round(deg / 26.56505117707799)) < 1e-6
        || Math.abs(deg / 90 - Math.round(deg / 90)) < 1e-6;
      ok("xformui.rot.clean-angle", clean, String(deg));
    }
    v.commitXf();
    ok("xformui.rot.history-or-empty", s.history.list().labels.length <= 1,
      JSON.stringify(s.history.list().labels));
    s.undo();

    // 不吸附：自由角；吸附：吸到干净角
    const a = mk(true);
    paint(a.s, 10, 10, 8, 8);
    a.s.setSetting("tools.selXformAngleSnap", true);
    dragRotate(a.v, rotGrabAt(a.v, "tl"), (30 * Math.PI) / 180);
    ok("xformui.rot.clean-26", !!a.v.xf && (a.v.xf.cells || []).length > 0,
      a.v.xf ? String((a.v.xf.tp!.angle * 180) / Math.PI) : "no-session");
    a.v.revertXf();

    const b = mk(true);
    paint(b.s, 10, 10, 8, 8);
    b.s.setSetting("tools.selXformAngleSnap", false);
    dragRotate(b.v, rotGrabAt(b.v, "tl"), (30 * Math.PI) / 180);
    ok("xformui.rot.free-30",
      !!b.v.xf && Math.abs(Math.abs((b.v.xf.tp!.angle * 180) / Math.PI)) > 10,
      b.v.xf ? String((b.v.xf.tp!.angle * 180) / Math.PI) : "no-session");
    b.v.revertXf();
  }

  // ================================================================ 斜切：整条边平移 + ±85° 钳制
  {
    const { s, v } = mk(true);
    paint(s, 10, 10, 9, 9);                       // 9×9：下标 10..18，跨度 8 格
    const top = anchorScreen(v, "t");
    v.onDown(ev(top.x, top.y - 30, "mouse"));      // 边中点的外圈（22..34px）＝斜切
    dom.flush();
    eq("xformui.skew.kind", v.xfDrag?.kind, "skew");
    eq("xformui.skew.anchor", v.xfDrag?.anchor, "t");
    // 往右拖 8 格：基准线在**枢轴那条线**（内容中心 y），被拖边与对面边各反着走 4 格
    v.onMove(ev(top.x + 32, top.y - 30, "mouse"));
    dom.flush();
    eq("xformui.skew.tan", v.xf!.tp!.skewX, -1);
    ok("xformui.skew.preview-alive", (v.xf!.cells || []).length > 0, String((v.xf!.cells || []).length));
    v.onUp(ev(top.x + 32, top.y - 30, "mouse"));
    v.commitXf();
    eq("xformui.skew.history", s.history.list().labels, ["sel.skew"]);
    s.undo();

    // 钳制：拖到天边也只到 ±85°
    const a = mk(true);
    paint(a.s, 10, 10, 9, 9);
    dragBy(a.v, { x: anchorScreen(a.v, "t").x, y: anchorScreen(a.v, "t").y - 30 }, 100000, 0, true);
    ok("xformui.skew.clamp-pos",
      a.v.xf ? Math.abs(a.v.xf.tp!.skewX! + Math.tan((85 * Math.PI) / 180)) < 1e-9 : false,
      a.v.xf ? String(a.v.xf.tp!.skewX) : "no-session");
    a.v.revertXf();
    const b = mk(true);
    paint(b.s, 10, 10, 9, 9);
    dragBy(b.v, { x: anchorScreen(b.v, "t").x, y: anchorScreen(b.v, "t").y - 30 }, -100000, 0, true);
    ok("xformui.skew.clamp-neg",
      b.v.xf ? Math.abs(b.v.xf.tp!.skewX! - Math.tan((85 * Math.PI) / 180)) < 1e-9 : false,
      b.v.xf ? String(b.v.xf.tp!.skewX) : "no-session");
    b.v.revertXf();

    // 左右边中点的外圈走纵轴（skewY）
    const c = mk(true);
    paint(c.s, 10, 10, 9, 9);
    dragBy(c.v, { x: anchorScreen(c.v, "l").x - 30, y: anchorScreen(c.v, "l").y }, 0, 32, true);
    eq("xformui.skew.y-axis", [c.v.xf ? c.v.xf.tp!.skewY : null, c.v.xf ? c.v.xf.tp!.skewX : null], [-1, 0]);
    c.v.revertXf();
  }

  // ================================================================ 枢轴：拖动 / 缩放跟位 / 旋转不动
  {
    const { s, v } = mk(true);
    paint(s, 10, 10, 9, 9);
    // 先在框内按一下（起会话；此时画面还没动过）
    const f0 = v.xfScreenFrame()!;
    drag(v, { x: (f0.corners[0].x + f0.corners[2].x) / 2, y: (f0.corners[0].y + f0.corners[2].y) / 2 },
      { x: (f0.corners[0].x + f0.corners[2].x) / 2, y: (f0.corners[0].y + f0.corners[2].y) / 2 }, true);
    const pv = v.xfPivotScreen()!;
    eq("xformui.pivot.default-centre", v.pivotPreset(), "cc");
    eq("xformui.pivot.default-at", [px(pv.x, pv.y).x, px(pv.x, pv.y).y], [4, 4]);
    const before = new Uint8ClampedArray(celData(s));
    v.onDown(ev(pv.x, pv.y, "mouse"));
    dom.flush();
    eq("xformui.pivot.kind", v.xfDrag?.kind, "pivot");
    v.onMove(ev(sc(0, 0).x, sc(0, 0).y, "mouse"));
    dom.flush();
    eq("xformui.pivot.moved-to", [v.xf!.tp!.pivot.x, v.xf!.tp!.pivot.y], [0, 0]);
    eq("xformui.pivot.picture-still", diffBytes(celData(s), before), 0);
    eq("xformui.pivot.touched", v.xf!.pivotTouched, true);
    v.onUp(ev(sc(0, 0).x, sc(0, 0).y, "mouse"));
    dom.flush();
    eq("xformui.pivot.preset-tl", v.pivotPreset(), "tl");

    // 缩放之后按归一化比例跟位
    {
      // 左上角枢轴：缩放后仍然压在左上角（归一化比例不变）
      const a = mk(true);
      paint(a.s, 10, 10, 9, 9);
      const brA = anchorScreen(a.v, "br");
      a.v.onDown(ev(brA.x, brA.y, "mouse"));
      a.v.setPivotPreset("tl");
      dragBy(a.v, { x: brA.x, y: brA.y }, 32, 32, true);            // 2×
      eq("xformui.pivot.scale-follow-tl", [a.v.xf!.tp!.pivot.x, a.v.xf!.tp!.pivot.y], [0, 0]);
      // 中心枢轴：缩放后仍然在中心（边长 8 → 16，中心 8）
      const b = mk(true);
      paint(b.s, 10, 10, 9, 9);
      const brB = anchorScreen(b.v, "br");
      b.v.onDown(ev(brB.x, brB.y, "mouse"));
      dragBy(b.v, { x: brB.x, y: brB.y }, 32, 32, true);
      eq("xformui.pivot.scale-follow-centre", [b.v.xf!.tp!.pivot.x, b.v.xf!.tp!.pivot.y], [8, 8]);
      // 上中枢轴：缩放后仍然在上边中点
      const c = mk(true);
      paint(c.s, 10, 10, 9, 9);
      const brC = anchorScreen(c.v, "br");
      c.v.onDown(ev(brC.x, brC.y, "mouse"));
      c.v.setPivotPreset("tc");
      dragBy(c.v, { x: brC.x, y: brC.y }, 32, 32, true);
      eq("xformui.pivot.scale-follow-tc", [c.v.xf!.tp!.pivot.x, c.v.xf!.tp!.pivot.y], [8, 0]);
    }
    // 旋转之后枢轴**不动**
    {
      const a = mk(true);
      paint(a.s, 10, 10, 9, 9);
      // 起会话（按一下框内）→ 设左上角枢轴 → 旋转，枢轴必须原地不动
      const brA = anchorScreen(a.v, "br");
      a.v.onDown(ev(brA.x, brA.y, "mouse"));
      a.v.onUp(ev(brA.x, brA.y, "mouse"));
      a.v.setPivotPreset("tl");
      const keep = [a.v.xf!.tp!.pivot.x, a.v.xf!.tp!.pivot.y];
      dragRotate(a.v, rotGrabAt(a.v, "tr"), 0.6);
      ok("xformui.pivot.rotate-keeps",
        !!a.v.xf && a.v.xf.tp!.pivot.x === keep[0] && a.v.xf.tp!.pivot.y === keep[1],
        a.v.xf ? JSON.stringify([a.v.xf.tp!.pivot.x, a.v.xf.tp!.pivot.y, keep]) : "no-session");
    }
    // 9 档循环 ＋ 与引擎侧的档位表一致
    eq("xformui.pivot.order-matches-engine", [...PIVOT_ORDER], [...PIVOT_PRESETS]);
    {
      const b = mk(true);
      paint(b.s, 10, 10, 9, 9);
      const brB = anchorScreen(b.v, "br");
      b.v.onDown(ev(brB.x, brB.y, "mouse"));
      b.v.onUp(ev(brB.x, brB.y, "mouse"));
      eq("xformui.pivot.cycle-1", b.v.cyclePivot(), "cr");
      eq("xformui.pivot.cycle-2", b.v.cyclePivot(), "bl");
      ok("xformui.pivot.cycle-sets", b.v.setPivotPreset("br"));
      eq("xformui.pivot.cycle-br", [b.v.xf!.tp!.pivot.x, b.v.xf!.tp!.pivot.y], [8, 8]);
      const c = mk(true);
      eq("xformui.pivot.no-session", c.v.pivotPreset(), null);
      eq("xformui.pivot.no-session-set", c.v.setPivotPreset("tl"), false);
    }
  }

  // ================================================================ 像素精确通道：整数平移逐字节一致
  {
    const { s, v } = mk(true);
    paint(s, 10, 10, 16, 12);                     // 大一点，框正中不压任何抓手 → 拖动＝移动内容
    const pristine = new Uint8ClampedArray(celData(s));
    const f0 = v.xfScreenFrame()!;
    const start = { x: (f0.corners[0].x + f0.corners[2].x) / 2, y: (f0.corners[0].y + f0.corners[2].y) / 2 };
    drag(v, start, { x: start.x + 16, y: start.y + 12 }, true);   // 移动 (+4, +3) 格
    dom.flush();
    ok("xformui.exact.move-session", !!v.xf, "session");
    if (v.xf) {
      eq("xformui.exact.move-shift", [v.xf.tp!.shift?.x, v.xf.tp!.shift?.y], [4, 3]);
      eq("xformui.exact.move-path", v.xf.exact, { dx: 4, dy: 3, steps: 0 });
      // 逐字节精确：源像素原样出现在新位置（不重采样、不插值）
      const bi = beginMove(s.doc, s.curLayer(), s.curFrame())!;
      const content = bi.content;
      let wrong = 0;
      for (let y = 0; y < content.h; y++) {
        for (let x = 0; x < content.w; x++) {
          const si = content.idx(x, y);
          if (content.data[si + 3] === 0) continue;
          const o = ((10 + 3 + y) * s.doc.w + (10 + 4 + x)) * 4;
          if (v.xf.buf![o] !== content.data[si] || v.xf.buf![o + 1] !== content.data[si + 1]) wrong++;
        }
      }
      eq("xformui.exact.move-bytes", wrong, 0);
    }
    v.commitXf();
    const want = new Uint8ClampedArray(s.doc.w * s.doc.h * 4);
    for (let y = 0; y < 12; y++) {
      for (let x = 0; x < 16; x++) {
        for (let k = 0; k < 4; k++) want[((10 + 3 + y) * s.doc.w + (10 + 4 + x)) * 4 + k] = pristine[(y * 16 + x) * 4 + k];
      }
    }
    eq("xformui.exact.move-lands", diffBytes(celData(s), want), 0);
    eq("xformui.exact.move-history", s.history.list().labels, ["sel.move"]);
    s.undo();
    eq("xformui.exact.move-undo", diffBytes(celData(s), pristine), 0);
  }


  // ================================================================ 一次会话一条历史；还原 / 切工具 / 切帧
  {
    const { s, v } = mk(true);
    paint(s, 10, 10, 6, 4);
    const pristine = new Uint8ClampedArray(celData(s));
    const br = anchorScreen(v, "br");
    dragBy(v, { x: br.x + 6, y: br.y + 6 }, 12, 8, true);          // ① 缩放
    {
      const f1 = v.xfScreenFrame()!;
      const c1 = { x: (f1.corners[0].x + f1.corners[2].x) / 2, y: (f1.corners[0].y + f1.corners[2].y) / 2 };
      drag(v, c1, { x: c1.x + 8, y: c1.y + 6 }, true);             // ② 移动
    }
    eq("xformui.session.two-drags-one-session", v.transforming, true);
    eq("xformui.session.no-history-midway", s.history.list().labels.length, 0);
    dragRotate(v, rotGrabAt(v, "tr"), 0.5);                       // ③ 旋转
    v.commitXf();
    const labels = s.history.list().labels;
    eq("xformui.session.one-history", labels.length, 1);
    eq("xformui.session.label-priority", labels[0], "sel.rotate");
    s.undo();
    eq("xformui.session.undo-restores", diffBytes(celData(s), pristine), 0);
    eq("xformui.session.undo-index", s.history.list().index, 0);

    // 「还原」：丢掉会话，不进历史、像素与掩码逐字节复原
    const a = mk(true);
    paint(a.s, 10, 10, 6, 4);
    const pristineA = new Uint8ClampedArray(celData(a.s));
    const maskA = new Uint8Array(a.s.doc.sel!.mask);
    const brA = anchorScreen(a.v, "br");
    dragBy(a.v, { x: brA.x + 6, y: brA.y + 6 }, 12, 8, true);
    ok("xformui.revert.moved", diffBytes(celData(a.s), pristineA) > 0, "should have changed");
    a.v.revertXf();
    eq("xformui.revert.finished", a.v.xf, null);
    eq("xformui.revert.pixels", diffBytes(celData(a.s), pristineA), 0);
    eq("xformui.revert.mask", diffBytes(a.s.doc.sel!.mask, maskA), 0);
    eq("xformui.revert.no-history", a.s.history.list().labels.length, 0);

    // 切工具 / 切帧＝先落定（一条历史）
    const b = mk(true);
    paint(b.s, 10, 10, 6, 4);
    const brB = anchorScreen(b.v, "br");
    dragBy(b.v, { x: brB.x + 6, y: brB.y + 6 }, 12, 8, true);
    b.s.setTool("pencil");
    dom.flush();
    eq("xformui.toolswitch.ends-session", b.v.xf, null);
    eq("xformui.toolswitch.history", b.s.history.list().labels, ["sel.scale"]);

    const c = mk(true);
    paint(c.s, 10, 10, 6, 4);
    const brC = anchorScreen(c.v, "br");
    dragBy(c.v, { x: brC.x + 6, y: brC.y + 6 }, 12, 8, true);
    c.s.frameAdd();
    dom.flush();
    eq("xformui.frameswitch.ends-session", c.v.xf, null);
    eq("xformui.frameswitch.history", c.s.history.list().labels, ["sel.scale"]);

    // 没拖过就退出：零改动零历史
    const d = mk(true);
    paint(d.s, 10, 10, 6, 4);
    const pristineD = new Uint8ClampedArray(celData(d.s));
    const brD = anchorScreen(d.v, "br");
    d.v.onDown(ev(brD.x + 6, brD.y + 6, "mouse"));
    d.v.onUp(ev(brD.x + 6, brD.y + 6, "mouse"));
    dom.flush();
    d.v.commitXf();
    eq("xformui.idle.pixels", diffBytes(celData(d.s), pristineD), 0);
    eq("xformui.idle.history", d.s.history.list().labels.length, 0);

    // 1×N / N×1 的退化选区：拒绝进入（图层与掩码都不碰）
    const e = mk(true);
    const doc = e.s.doc;
    const cel = doc.ensureCel(e.s.curLayer(), e.s.curFrame());
    doc.sel = new Sel(doc.w, doc.h);
    for (let k = 0; k < 5; k++) {
      const i = cel.idx(20 + k, 10);
      cel.data[i + 3] = 255;
      doc.sel.set(20 + k, 10, 1);
    }
    const pristineE = new Uint8ClampedArray(cel.data);
    drag(e.v, { x: sc(20, 10).x, y: sc(20, 10).y }, { x: sc(24, 10).x, y: sc(24, 10).y }, true);
    eq("xformui.thin.no-session", e.v.xf, null);
    eq("xformui.thin.reason", e.v.lastWarpError, "tooThin");
    eq("xformui.thin.pixels", diffBytes(cel.data, pristineE), 0);
  }

  // ================================================================ 贴着边线的环带＝只移动选区边框
  {
    const { s, v } = mk(true);
    paint(s, 10, 10, 8, 8);
    const pristine = new Uint8ClampedArray(celData(s));
    const tl = anchorScreen(v, "tl");
    const onEdge = { x: tl.x + 12, y: tl.y };     // 上边线中段，贴着线
    drag(v, onEdge, { x: onEdge.x + 8, y: onEdge.y }, true);
    dom.flush();
    eq("xformui.band.pixels-untouched", diffBytes(celData(s), pristine), 0);
    eq("xformui.band.no-session", v.xf, null);
    eq("xformui.band.no-history", s.history.list().labels.length, 0);
    eq("xformui.band.mask-moved", s.doc.sel!.get(12, 10), 1);       // 选区整体挪了 2 格
    eq("xformui.band.mask-old-gone", s.doc.sel!.get(10, 10), 0);
  }

  // ================================================================ 与 warp（四点 / 网格）互不干扰
  {
    const { s, v } = mk(true);
    paint(s, 10, 10, 10, 8);
    ok("xformui.warp.enter", v.beginWarp("quad"));
    eq("xformui.warp.mode", v.xf!.mode, "warp");
    eq("xformui.warp.no-grabs", v.xfGrabs(), []);
    v.onDown(ev(sc(14, 13).x, sc(14, 13).y, "mouse"));
    dom.flush();
    ok("xformui.warp.stays-warp", v.xf!.mode === "warp");
    eq("xformui.warp.no-affine", v.xfDrag, null);
    v.finishWarp(true);
    eq("xformui.warp.exited", v.xf, null);
    const br = anchorScreen(v, "br");
    dragBy(v, { x: br.x + 6, y: br.y + 6 }, 8, 8, true);
    eq("xformui.warp.drag-cleared", v.xfDrag, null);
    ok("xformui.warp.affine-after", !!v.xf && v.xf.mode !== "warp");
    v.revertXf();
  }

  // ================================================================ 移动内容的预览与落笔一致
  {
    const { s, v } = mk(true);
    paint(s, 10, 10, 6, 4);
    {
      const f0 = v.xfScreenFrame()!;
      const c0 = { x: (f0.corners[0].x + f0.corners[2].x) / 2, y: (f0.corners[0].y + f0.corners[2].y) / 2 };
      v.onDown(ev(c0.x, c0.y, "mouse"));
      v.onUp(ev(c0.x, c0.y, "mouse"));
      const f1 = v.xfScreenFrame()!;
      const c1 = { x: (f1.corners[0].x + f1.corners[2].x) / 2, y: (f1.corners[0].y + f1.corners[2].y) / 2 };
      drag(v, c1, { x: c1.x + 12, y: c1.y + 8 }, true);
    }
    dom.flush();
    const g = v.xf!;
    const st = beginMove(s.doc, s.curLayer(), s.curFrame())!;
    const m = affineFrom({
      pivot: g.tp!.pivot, angle: g.tp!.angle, sx: g.tp!.sx, sy: g.tp!.sy,
      skewX: g.tp!.skewX ?? 0, skewY: g.tp!.skewY ?? 0,
    });
    const expect = new Uint8ClampedArray(s.doc.w * s.doc.h * 4);
    const expCells = xformAffineFloating(s.doc, st, m, expect, xformAffineDestBox(m, 6, 4, st.ox, st.oy));
    eq("xformui.move.preview-cells", JSON.stringify(g.cells), JSON.stringify(expCells));
    v.commitXf();
    let wrong = 0;
    const data = celData(s);
    for (const di of expCells) {
      const o = di * 4;
      if (data[o] !== expect[o] || data[o + 3] !== expect[o + 3]) wrong++;
    }
    eq("xformui.move.lands-preview", wrong, 0);
    eq("xformui.move.history", s.history.list().labels, ["sel.move"]);
    s.undo();
    eq("xformui.move.skew-helper", solveSkew("t", { x: 0, y: 0 }, { x: 4, y: 0 }, 8).tan, 0.5);
    eq("xformui.move.frame-local", toFrameLocal(0, 0, 0), { x: 0, y: 0 });
    eq("xformui.move.affine-identity",
      applyAffine(affineFrom({ pivot: { x: 0, y: 0 }, angle: 0, sx: 1, sy: 1 }), { x: 3, y: 4 }),
      { x: 3, y: 4 });
    eq("xformui.move.doc-untouched", celData(s).length, 64 * 64 * 4);
  }

  // ================================================================ 复制模式：原内容留在原地
  {
    const { s, v } = mk(true);
    s.setSetting("tools.selXformCopy", true);
    paint(s, 10, 10, 6, 4);
    const pristine = new Uint8ClampedArray(celData(s));
    {
      const f0 = v.xfScreenFrame()!;
      const c0 = { x: (f0.corners[0].x + f0.corners[2].x) / 2, y: (f0.corners[0].y + f0.corners[2].y) / 2 };
      v.onDown(ev(c0.x, c0.y, "mouse"));
      v.onUp(ev(c0.x, c0.y, "mouse"));
      const f1 = v.xfScreenFrame()!;
      const c1 = { x: (f1.corners[0].x + f1.corners[2].x) / 2, y: (f1.corners[0].y + f1.corners[2].y) / 2 };
      drag(v, c1, { x: c1.x + 32, y: c1.y + 16 }, true);   // 往右下挪 8×4 格
    }
    dom.flush();
    eq("xformui.copy.flag", v.xf!.st.copy, true);
    eq("xformui.copy.original-kept", alpha(s, 10, 10), 255);
    v.commitXf();
    eq("xformui.copy.copy-landed", alpha(s, 18, 14), 255);
    eq("xformui.copy.original-still", alpha(s, 10, 10), 255);
    eq("xformui.copy.history", s.history.list().labels, ["sel.move"]);
    s.undo();
    eq("xformui.copy.undo", diffBytes(celData(s), pristine), 0);
    s.setSetting("tools.selXformCopy", false);
  }

  // ================================================================ 锁图层：不进会话
  {
    const { s, v } = mk(true);
    paint(s, 10, 10, 6, 4);
    const pristine = new Uint8ClampedArray(celData(s));
    s.doc.layers[s.curLayer()].locked = true;
    const br = anchorScreen(v, "br");
    dragBy(v, { x: br.x + 6, y: br.y + 6 }, 12, 8, true);
    eq("xformui.locked.no-session", v.xf, null);
    eq("xformui.locked.pixels", diffBytes(celData(s), pristine), 0);
    eq("xformui.locked.error", v.lastWarpError, "locked");
    s.doc.layers[s.curLayer()].locked = false;
  }
}
