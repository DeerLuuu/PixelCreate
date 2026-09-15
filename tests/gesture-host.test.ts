// GestureController（指针事件入口）的假 host 回归 —— src/servers/gesture.ts。
//
// 四个入口从 `view.ts` 搬出来后，不再需要真 DOM 才能驱动：这里用**假 host**（只实现当前
// 场景会碰到的成员）直接调 `onDown/onMove/onUp`，把几条真机上反复调过、又最容易搬迁搬坏的
// 规则钉死：
//   · 四指手势成立时必须把视口**还原到第一根手指落下那一刻**（落地抖动不许缩放/平移画面）；
//   · 四指手势期间（fourSeen）onMove 什么都不做 —— 既不 pinch 也不 pan；
//   · 至少两根手指各自离开自己的落点超过阈值才置位 fourArmed（晚落 / 早抬不削弱判定）；
//   · 双指 pinch 以中点不动点缩放，并夹在 zoomMin..zoomMax；
//   · 单指平移按屏幕增量走，并且 `mousePan`（PC 中键拖动）在第一次移动后就交还给普通拖动。
import { GestureController, type GestureHost } from "../src/servers/gesture";
import { eq, ok } from "./common";

/** 假 host：字段用普通对象，方法用记名字的桩；没实现到的成员会在**调用时**报错（比静默更重要） */
function fakeHost(over: Record<string, unknown> = {}): { host: GestureHost; gc: GestureController; calls: string[] } {
  const calls: string[] = [];
  let o = 0;
  const stub = (name: string) => (..._a: unknown[]): unknown => { calls.push(name); void o; return undefined; };
  const base: Record<string, unknown> = {
    session: {
      prefs: {
        autoPan: false, zoomMin: 1, zoomMax: 32, doubleTapMs: 300,
        fourFingerPx: 15, gLongPress: "none", gDoubleTapCanvas: "none",
        gTwoFingerDoubleTap: "redo", gDoubleTapMargin: "undo", gTripleTap: "zoomIn",
        gThreeFingerLongPress: "menu", gTwoFingerLongPress: "menu", gFourFinger: "framePreview",
      },
      doc: { w: 32, h: 32 }, docIdx: 0, docs: [], repaint: stub("repaint"),
      setDelTarget: stub("setDelTarget"),
      // 「编辑界面」模式：**单指**按下在注册完触点后就返回（多指分支在它之前），
      // 于是假 host 不必实现整条工具动作链（起笔迹 / 长按计时器 / 选区…）
      uiEdit: true,
    },
    host: { setPointerCapture: stub("setPointerCapture") },
    ox: 0, oy: 0, zoom: 4,
    onFramePreview: null,
    // 触点会话状态（pointers / fourSeen / pinchBase / panLast …）**不在这里**：
    // 它们由 GestureController 自己持有，断言直接读 gc.*
    evPt: (e: { clientX: number; clientY: number }) => ({ x: e.clientX, y: e.clientY }),
    vpW: () => 400, vpH: () => 800,
    screenToPixel: (sx: number, sy: number) => ({ x: Math.floor(sx / 4), y: Math.floor(sy / 4) }),
    canvasAtScreen: () => 0,
    clampView: stub("clampView"),
    refresh: stub("refresh"),
    drawOverlay: stub("drawOverlay"),
    repaintStroke: stub("repaintStroke"),
    drawPathPreview: stub("drawPathPreview"),
    syncCursor: stub("syncCursor"),
    labelFor: (k: string) => k,
    toolNow: () => "pencil",
    isPathTool: () => false,
    preciseDrag: () => false,
    cancelHold: stub("cancelHold"),
    holdMoved: () => false,
    armHold: stub("armHold"),
    cancelPickTimer: stub("cancelPickTimer"),
    enterPickMode: stub("enterPickMode"),
    samplePickCell: stub("samplePickCell"),
    startSpray: stub("startSpray"),
    stopSpray: stub("stopSpray"),
    outlineDown: stub("outlineDown"), outlineMove: stub("outlineMove"), endOutline: stub("endOutline"),
    pathDown: stub("pathDown"),
    selDown: stub("selDown"), selMove: stub("selMove"),
    startSelMove: () => false, endSelDrag: stub("endSelDrag"), dropSelDragToCanvas: () => false,
    wireRedirect: stub("wireRedirect"),
    isoHitAt: () => null, isoDragTo: stub("isoDragTo"), resizeHit: () => null,
    symLockBtn: () => null, symHit: () => null,
    inXform: () => false, tryStartXf: () => false, xfHitAt: () => null,
    xfMove: stub("xfMove"), xfEndDrag: stub("xfEndDrag"), xfBreakDrag: stub("xfBreakDrag"),
    endXf: stub("endXf"), abortXf: stub("abortXf"),
    warpHandleAt: () => -1, warpStartMove: () => false,
    warpMove: stub("warpMove"), warpMoveContent: stub("warpMoveContent"),
  };
  Object.assign(base, over);
  const host = base as unknown as GestureHost;
  // 触点会话状态由控制器持有（P5 收尾），所以断言读 `gc.*`；`host.ox/oy/zoom` 仍是 View 的视口。
  // `over` 里除视口三元组以外的键按名字落到控制器上（测试要预置 panLast / mousePan 这类会话状态）。
  const gc = new GestureController(host);
  for (const [k, v] of Object.entries(over)) {
    if (k === "ox" || k === "oy" || k === "zoom") continue;
    (gc as unknown as Record<string, unknown>)[k] = v;
  }
  return { host, gc, calls };
}

/** 合成一个触摸 pointer 事件（只带手势用到的字段） */
function ev(pointerId: number, clientX: number, clientY: number, type = "touch"): PointerEvent {
  return {
    pointerId, pointerType: type, clientX, clientY, button: 0, buttons: 1,
    altKey: false, shiftKey: false, ctrlKey: false,
    preventDefault: () => { /* noop */ },
  } as unknown as PointerEvent;
}

export function testGestureHost(): void {
  // ------------------------------------------------- 1. 四指成立＝还原视口
  {
    const { host, gc, calls } = fakeHost();
    gc.onDown(ev(1, 100, 100));
    eq("ghost.first.down", gc.pointers.size, 1);
    eq("ghost.first.view0", gc.fourView0, { ox: 0, oy: 0, zoom: 4 });
    gc.onDown(ev(2, 160, 100));
    eq("ghost.pinch.base-set", !!gc.pinchBase, true);
    // 手指落地的抖动把视口挪走（模拟 pinch）
    host.ox = 99;
    host.oy = -12;
    host.zoom = 9;
    gc.onDown(ev(3, 100, 160));
    gc.onDown(ev(4, 160, 160));
    eq("ghost.four.seen", gc.fourSeen, true);
    ok("ghost.four.view-restored", host.ox === 0 && host.oy === 0 && host.zoom === 4,
      `${host.ox},${host.oy},${host.zoom}`);
    ok("ghost.four.clamped", calls.includes("clampView") && calls.includes("refresh"));
    eq("ghost.four.pinch-cleared", gc.pinchBase, null);
    ok("ghost.four.armed-hold", calls.includes("armHold"));   // 第 3 指落下时挂了「三指长按」
  }

  // ------------------------------------- 2. 四指手势期间不 pinch / 不 pan
  {
    const { host, gc } = fakeHost();
    gc.onDown(ev(1, 100, 100));
    gc.onDown(ev(2, 160, 100));
    gc.onDown(ev(3, 100, 160));
    gc.onDown(ev(4, 160, 160));
    host.ox = 0; host.oy = 0; host.zoom = 4;
    // 四指都在，且两根各自离开落点 > 15px：只置位 fourArmed，画面一动不动
    gc.onMove(ev(1, 140, 140));
    gc.onMove(ev(2, 200, 100));
    eq("ghost.four.armed", gc.fourArmed, true);
    eq("ghost.four.no-pan", [host.ox, host.oy], [0, 0]);
    eq("ghost.four.zoom-untouched", host.zoom, 4);
  }

  // ------------------------------------------------------- 3. 双指 pinch
  {
    const { host, gc } = fakeHost();
    gc.onDown(ev(1, 100, 100));
    host.ox = 10; host.oy = 20;      // 第二根手指落下时冻结的基准（中点 150,100 / 距离 100 / zoom 4）
    gc.onDown(ev(2, 200, 100));
    // 中点不动、两指距离翻倍 ⇒ 缩放翻倍，中点盯着的那处画面不动：
    // ox' = mx − (mx₀ − ox₀)·k（k = 8/4 = 2）
    gc.onMove(ev(1, 50, 100));
    gc.onMove(ev(2, 250, 100));
    eq("ghost.pinch.zoom", host.zoom, 8);
    eq("ghost.pinch.anchor", [host.ox, host.oy],
      [150 - (150 - 10) * 2, 100 - (100 - 20) * 2]);
    eq("ghost.pinch.zoomed-flag", gc.pinchZoomed, true);
    // 缩放夹在上限：继续拉开也只到 zoomMax
    gc.onMove(ev(1, -500, 100));
    gc.onMove(ev(2, 900, 100));
    eq("ghost.pinch.clamped-max", host.zoom, 32);
  }

  // --------------------------------------------------------- 4. 单指平移
  {
    const { host, gc, calls } = fakeHost({ ox: 5, oy: 7, panLast: { x: 100, y: 100 } });
    gc.onMove(ev(1, 130, 90));
    eq("ghost.pan.delta", [host.ox, host.oy], [35, -3]);
    eq("ghost.pan.last", gc.panLast, { x: 130, y: 90 });
    ok("ghost.pan.clamped", calls.includes("clampView"));
  }
  {
    // PC 中键：第一次移动之后交还给普通拖动（mousePan 复位、panLast 清空）
    const { host, gc } = fakeHost({ ox: 5, oy: 7, panLast: { x: 100, y: 100 }, mousePan: true });
    gc.onMove(ev(1, 130, 90));
    eq("ghost.mouse-pan.released", [gc.mousePan, gc.panLast], [false, null]);
    eq("ghost.mouse-pan.delta", [host.ox, host.oy], [35, -3]);
  }

  // ------------------------------------- 5. 抬手：指针清空、panLast 复位
  //
  // 这里**不**走 `onDown`：单指按下会一路落到工具动作体（`session.setDelTarget` / 长按计时器 /
  // 起笔迹），假 host 只有多指与视口那几条契约。手势状态直接铺好再抬手，测的是「抬手要清干净」。
  {
    const { host, gc } = fakeHost({ panLast: { x: 100, y: 100 } });
    gc.pointers.set(1, { x: 100, y: 100 });
    gc.onUp(ev(1, 100, 100));
    eq("ghost.up.cleared", gc.pointers.size, 0);
    eq("ghost.up.pan-last", gc.panLast, null);
  }
}
