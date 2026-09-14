// GestureServer（轻点序列状态机）的回归 —— src/servers/gesture.ts 的 TapMachine。
//
// 这一片以前埋在 render/view.ts 的 onUp 里（一段 150 行的 if 阶梯），只能靠真机手感验证。
// 搬出来之后把**优先级与容差**逐条钉死：480ms / 64px / 80px、双击边距 vs 双击画布 vs 三击、
// 「双指轻点落在画上不算」。注意 J 组断言**记录的是当前（可疑的）行为**，见文件末尾的说明。
import { TAP_SEQ_MS, TAP_SEQ_PX, TWO_TAP_PX, TapMachine, type TapUpInput } from "../src/servers/gesture";
import { eq, ok } from "./common";

/** 「画布内、当前画布、双击画布没映射动作、非 PC」的默认上下文 */
const D: TapUpInput = {
  now: 1000, pt: { x: 100, y: 100 },
  overDoc: true, canvasIndex: 0, docIndex: 0,
  moved: false, hasStroke: false, hasSelDrag: false, hasXf: false,
  pinchZoomed: false, isPc: false, doubleTapMs: 300,
  canvasDoubleMapped: false, midOverDoc: false,
};

function ctx(o: Partial<TapUpInput> = {}): TapUpInput {
  return { ...D, ...o };
}

export function testGesture(): void {
  // ------------------------------------------------------------ 常量口径
  {
    eq("gesture.const.seq-ms", TAP_SEQ_MS, 480);
    eq("gesture.const.seq-px", TAP_SEQ_PX, 64);
    eq("gesture.const.two-px", TWO_TAP_PX, 80);
  }

  // --------------------------------------------------- 单击：照常落笔
  {
    const m = new TapMachine();
    eq("gesture.single.first", m.up(ctx()).kind, "plain");
    // 超过时限＝重新数第一下，不连点
    eq("gesture.single.timeout", m.up(ctx({ now: 1000 + TAP_SEQ_MS + 1 })).kind, "plain");
  }

  // ------------------------------------------- 双击：按落点分流（单指）
  {
    const m = new TapMachine();
    m.up(ctx());
    eq("gesture.double.canvas-mapped",
      m.up(ctx({ now: 1200, pt: { x: 110, y: 110 }, canvasDoubleMapped: true })).kind, "canvas-double");
  }
  {
    const m = new TapMachine();
    m.up(ctx());
    // 默认档「双击画布」＝none：当前画布也走聚焦适配（会 fit 一下）
    const r = m.up(ctx({ now: 1200 }));
    eq("gesture.double.canvas-unmapped", r.kind, "focus-canvas");
    eq("gesture.double.canvas-unmapped.index", r.kind === "focus-canvas" ? r.index : -1, 0);
  }
  {
    const m = new TapMachine();
    m.up(ctx());
    // 双击另一个画布＝聚焦它，与「双击画布」的映射无关
    const r = m.up(ctx({ now: 1200, canvasIndex: 1 }));
    eq("gesture.double.other-canvas", r.kind, "focus-canvas");
    eq("gesture.double.other-canvas.index", r.kind === "focus-canvas" ? r.index : -1, 1);
  }
  {
    const m = new TapMachine();
    m.up(ctx());
    eq("gesture.double.margin",
      m.up(ctx({ now: 1200, overDoc: false, canvasIndex: -1 })).kind, "margin-double");
  }

  // ------------------------------------------------- 连点窗口的两个容差
  {
    const m = new TapMachine();
    m.up(ctx());
    eq("gesture.window.timeout",
      m.up(ctx({ now: 1000 + TAP_SEQ_MS, canvasDoubleMapped: true })).kind, "plain");
  }
  {
    const m = new TapMachine();
    m.up(ctx());
    eq("gesture.window.far",
      m.up(ctx({ now: 1200, pt: { x: 100 + TAP_SEQ_PX, y: 100 }, canvasDoubleMapped: true })).kind, "plain");
  }
  {
    const m = new TapMachine();
    m.up(ctx());
    // 贴着容差内侧仍然算连点
    eq("gesture.window.near",
      m.up(ctx({ now: 1200, pt: { x: 100 + TAP_SEQ_PX - 1, y: 100 }, canvasDoubleMapped: true })).kind,
      "canvas-double");
  }

  // ------------------------------------------------- PC 不做单击连击
  {
    const m = new TapMachine();
    m.up(ctx({ isPc: true }));
    eq("gesture.pc.second-tap",
      m.up(ctx({ isPc: true, now: 1200, canvasDoubleMapped: true })).kind, "plain");
  }

  // ------------------------------------- 拖动过的第二下断串（一笔画完）
  {
    const m = new TapMachine();
    m.up(ctx());
    eq("gesture.moved.plain",
      m.up(ctx({ now: 1200, moved: true, canvasDoubleMapped: true })).kind, "plain");
    // 断串之后再点一下＝重新算第一下
    eq("gesture.moved.restart",
      m.up(ctx({ now: 1300, canvasDoubleMapped: true })).kind, "plain");
  }

  // ------------------------------------------------- 双指轻点（双击＝重做）
  {
    const m = new TapMachine();
    m.noteSecondFinger({ x: 80, y: 100 }, { x: 120, y: 100 });
    eq("gesture.two.mid", m.twoMidPoint(), { x: 100, y: 100 });
    eq("gesture.two.first", m.up(ctx()).kind, "two-finger-first");
    eq("gesture.two.consumed", m.twoMidPoint(), null);
    m.noteSecondFinger({ x: 80, y: 100 }, { x: 120, y: 100 });
    const r = m.up(ctx({ now: 1200 }));
    eq("gesture.two.redo", r.kind, "two-finger-redo");
    eq("gesture.two.redo.mid", r.kind === "two-finger-redo" ? r.mid : null, { x: 100, y: 100 });
  }
  {
    // 中点落在画布内＝不算（画画时太容易碰到）
    const m = new TapMachine();
    m.noteSecondFinger({ x: 80, y: 100 }, { x: 120, y: 100 });
    eq("gesture.two.over-doc", m.up(ctx({ midOverDoc: true })).kind, "two-finger-skip");
    // 而且整串作废：下一对双指仍然从「第一下」重新数
    m.noteSecondFinger({ x: 80, y: 100 }, { x: 120, y: 100 });
    eq("gesture.two.over-doc.reset", m.up(ctx({ now: 1200 })).kind, "two-finger-first");
  }
  {
    // 超时 / 超距都不算双击
    const m = new TapMachine();
    m.noteSecondFinger({ x: 80, y: 100 }, { x: 120, y: 100 });
    m.up(ctx({ doubleTapMs: 300 }));
    m.noteSecondFinger({ x: 80, y: 100 }, { x: 120, y: 100 });
    eq("gesture.two.timeout", m.up(ctx({ now: 1400, doubleTapMs: 300 })).kind, "two-finger-first");
    m.noteSecondFinger({ x: 200, y: 300 }, { x: 200, y: 300 });
    eq("gesture.two.far", m.up(ctx({ now: 1500, doubleTapMs: 300 })).kind, "two-finger-first");
  }
  {
    // 缩放过的手势不是轻点；正在画 / 选 / 变换时也不走双指分支
    const cases: Array<[string, Partial<TapUpInput>]> = [
      ["pinch", { pinchZoomed: true }],
      ["stroke", { hasStroke: true }],
      ["sel", { hasSelDrag: true }],
      ["xf", { hasXf: true }],
    ];
    for (const [tag, patch] of cases) {
      const m = new TapMachine();
      m.noteSecondFinger({ x: 80, y: 100 }, { x: 120, y: 100 });
      eq("gesture.two.blocked." + tag, m.up(ctx(patch)).kind, "plain");
    }
  }
  {
    // 多指介入 / pointercancel 会清掉双指序列
    const m = new TapMachine();
    m.noteSecondFinger({ x: 80, y: 100 }, { x: 120, y: 100 });
    m.up(ctx());
    m.clearTwoTapSeq();
    m.noteSecondFinger({ x: 80, y: 100 }, { x: 120, y: 100 });
    eq("gesture.two.cleared", m.up(ctx({ now: 1200 })).kind, "two-finger-first");
  }
  {
    // 没出现过两指的手势：不吃双指分支
    const m = new TapMachine();
    eq("gesture.two.never", m.up(ctx()).kind, "plain");
  }

  // 三击回滚「前一下落的那个点」：只在前一下真画过、且真进了历史时才撤
  {
    const m = new TapMachine();
    m.noteSingleTap(true, true);
    // 画布内 + 取不到画布矩形 ⇒ 第二下被吞掉但保留计数（见本文件末尾的说明）
    eq("gesture.triple.skip", m.up(ctx({ canvasIndex: -1 })).kind, "plain");
    eq("gesture.triple.skip2", m.up(ctx({ now: 1100, canvasIndex: -1 })).kind, "skip");
    const r = m.up(ctx({ now: 1200, canvasIndex: -1 }));
    eq("gesture.triple.kind", r.kind, "triple");
    ok("gesture.triple.over-doc", r.kind === "triple" && r.overDoc);
    ok("gesture.triple.undo-dot", r.kind === "triple" && r.undoSingleDot);
    // 三击之后计数清零：下一串从第一下重新数
    eq("gesture.triple.reset", m.up(ctx({ now: 1300, canvasIndex: -1 })).kind, "plain");
  }
  {
    const m = new TapMachine();
    m.noteSingleTap(true, false);   // 画了但没进历史（例如落在锁住 / 空操作上）
    m.up(ctx({ canvasIndex: -1 }));
    m.up(ctx({ now: 1100, canvasIndex: -1 }));
    const r = m.up(ctx({ now: 1200, canvasIndex: -1 }));
    ok("gesture.triple.no-history", r.kind === "triple" && !r.undoSingleDot);
  }
  {
    const m = new TapMachine();
    m.noteSingleTap(false, true);   // 没画（拖过 / 只点了一下空处）
    m.up(ctx({ canvasIndex: -1 }));
    m.up(ctx({ now: 1100, canvasIndex: -1 }));
    const r = m.up(ctx({ now: 1200, canvasIndex: -1 }));
    ok("gesture.triple.not-a-dot", r.kind === "triple" && !r.undoSingleDot);
  }

  // --------------------------------------- J. 三击在画布内「够不到」的现状
  //
  // 现状（**可疑，先记下来**）：单指第二下只要落在画布上，就会被
  // 「双击画布（映射了动作）」或「聚焦适配（没映射）」吃掉并把计数清零，
  // 于是画布内永远攒不到第三下 —— 只有 `canvasIndex < 0`（画布矩形取不到）才走 skip 保留计数。
  {
    const m = new TapMachine();
    m.up(ctx());
    eq("gesture.triple.shadowed.unmapped", m.up(ctx({ now: 1100 })).kind, "focus-canvas");
    eq("gesture.triple.shadowed.reset", m.up(ctx({ now: 1200 })).kind, "plain");
  }
  {
    const m = new TapMachine();
    m.up(ctx());
    eq("gesture.triple.shadowed.mapped",
      m.up(ctx({ now: 1100, canvasDoubleMapped: true })).kind, "canvas-double");
    eq("gesture.triple.shadowed.mapped-reset",
      m.up(ctx({ now: 1200, canvasDoubleMapped: true })).kind, "plain");
  }
}
