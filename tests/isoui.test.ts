// 等距图形**交互层**回归：进入模式、生成一条历史、抓手拖动改尺寸 / 高度、整块移动与栅格吸附。
//
// 全部走无头 View（`stubEnv()` + `stubViewDom()` + 指针事件注入），不依赖真 DOM，
// 与 tests/xformui.test.ts 同一套打法。
import { Session } from "../src/app/session";
import { View } from "../src/render/view";
import { isoGroundCorners, isoHeightHandle, isoRender, isoShapeVoxels } from "../src/engine/iso";
import { applyPcMode } from "../src/io/pcmode";
import { stubEnv } from "./session.test";
import { stubViewDom } from "./view.test";
import { eq, ok } from "./common";

interface VX {
  ox: number; oy: number; zoom: number;
  isoHandles(): Array<{ kind: string; x: number; y: number }>;
  onDown(e: PointerEvent): void; onMove(e: PointerEvent): void; onUp(e: PointerEvent): void;
  session: Session;
}

export function testIsoUi(): void {
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

  const mk = (pc = false): { s: Session; v: VX } => {
    applyPcMode(pc ? "on" : "off");
    const s = new Session();
    s.doc.w = 64; s.doc.h = 64;
    const v = new View(host, s) as unknown as VX;
    s.attachView(v as unknown as View);
    (v as unknown as { fit(): void }).fit();
    v.zoom = 4; v.ox = 8; v.oy = 8;
    (v as unknown as { lastView: unknown }).lastView = { ox: 8, oy: 8, zoom: 4, w: 320, h: 240 };
    dom.flush();
    return { s, v };
  };
  const handle = (v: VX, kind: string): { x: number; y: number } => {
    const h = v.isoHandles().find((x) => x.kind === kind);
    if (!h) throw new Error("没有抓手 " + kind);
    return { x: h.x, y: h.y };
  };
  const alphaAt = (s: Session, x: number, y: number): number => {
    const cel = s.doc.celAt(s.curLayer(), s.curFrame());
    return cel ? cel.data[cel.idx(x, y) + 3] : -1;
  };
  const painted = (s: Session): number => {
    const cel = s.doc.celAt(s.curLayer(), s.curFrame());
    if (!cel) return 0;
    let n = 0;
    for (let i = 3; i < cel.data.length; i += 4) if (cel.data[i] > 0) n++;
    return n;
  };

  // --- 进出模式：进模式不改像素、不改历史；退出后画布手势交还工具 ---
  {
    const { s, v } = mk();
    eq("isoui.mode.off", s.isoOn, false);
    s.enterIso();
    eq("isoui.mode.on", s.isoOn, true);
    eq("isoui.mode.snapshot", s.snapshot().isoOn, true);
    ok("isoui.mode.origin-set", !!s.isoOrigin, JSON.stringify(s.isoOrigin));
    eq("isoui.mode.no-pixels", painted(s), 0);
    eq("isoui.mode.no-history", s.history.canUndo(), false);
    eq("isoui.mode.origin-snapped", [s.isoOrigin!.x % (s.prefs.iso.tile / 2), s.isoOrigin!.y % (s.prefs.iso.tile / 4)], [0, 0]);
    s.exitIso();
    eq("isoui.mode.exit", s.isoOn, false);
    void v;
  }

  // --- 生成：写进当前图层、**一条**历史、undo 回到干净状态 ---
  {
    const { s } = mk();
    s.setIsoPref({ shape: "box", w: 2, d: 2, h: 2, tile: 16, shadow: "off", outline: false });
    s.enterIso();
    s.setIsoOrigin(16, 16);
    const r = s.isoGenerate("layer");
    ok("isoui.gen.ok", r.ok && r.pixels > 0, JSON.stringify(r));
    ok("isoui.gen.pixels-range", r.pixels > 200 && r.pixels < 2000, "px=" + r.pixels);
    eq("isoui.gen.voxels", r.voxels, 8);
    eq("isoui.gen.painted", painted(s), r.pixels);
    ok("isoui.gen.last", !!s.isoLast);
    eq("isoui.gen.hist-label", s.history.undo(), "iso-shape");
    eq("isoui.gen.undo", painted(s), 0);
    eq("isoui.gen.single-step", s.history.canUndo(), false);   // 一次生成只压一条
  }

  // --- 抓手拖动：右角改宽、下角同时改宽深、黄块改高度、拖内部整块移动（全部吸附栅格）---
  {
    const { s, v } = mk(false);
    s.setIsoPref({ shape: "box", w: 2, d: 2, h: 2, tile: 16, shadow: "off", outline: false });
    s.enterIso();
    s.setIsoOrigin(24, 24);
    const T = s.prefs.iso.tile;
    // 右角：沿 +x 方向拖 2 格 = 屏幕 (+T/2, +T/4)*2 乘 zoom
    const right = handle(v, "right");
    const stepX = { x: (T / 2) * v.zoom, y: (T / 4) * v.zoom };
    v.onDown(ev(right.x, right.y));
    v.onMove(ev(right.x + stepX.x * 2, right.y + stepX.y * 2));
    v.onUp(ev(right.x + stepX.x * 2, right.y + stepX.y * 2));
    dom.flush();
    eq("isoui.drag.right-w", s.prefs.iso.w, 4);
    eq("isoui.drag.right-d", s.prefs.iso.d, 2);
    // 下角（前角）：沿 +y 拖 1 格
    const stepY = { x: -(T / 2) * v.zoom, y: (T / 4) * v.zoom };
    const bottom = handle(v, "bottom");
    v.onDown(ev(bottom.x, bottom.y));
    v.onMove(ev(bottom.x + stepY.x, bottom.y + stepY.y));
    v.onUp(ev(bottom.x + stepY.x, bottom.y + stepY.y));
    dom.flush();
    eq("isoui.drag.bottom-d", s.prefs.iso.d, 3);
    eq("isoui.drag.bottom-w", s.prefs.iso.w, 4);
    // 高度抓手：向上拖 2 个单位高度 → h + 2
    const hh = handle(v, "height");
    v.onDown(ev(hh.x, hh.y));
    v.onMove(ev(hh.x, hh.y - (T / 2) * v.zoom * 2));
    v.onUp(ev(hh.x, hh.y - (T / 2) * v.zoom * 2));
    dom.flush();
    eq("isoui.drag.height", s.prefs.iso.h, 4);
    // 整块移动：从**足迹中心**抓起（离所有抓手都够远），拖一点点也吸附到栅格
    const org0 = { ...s.isoOrigin! };
    const ctr = {
      x: handle(v, "top").x + ((s.prefs.iso.w - s.prefs.iso.d) * T) / 4 * v.zoom,
      y: handle(v, "top").y + ((s.prefs.iso.w + s.prefs.iso.d) * T) / 8 * v.zoom,
    };
    v.onDown(ev(ctr.x, ctr.y));
    v.onMove(ev(ctr.x + v.zoom * 1.5, ctr.y + v.zoom * 1.5));
    v.onUp(ev(ctr.x + v.zoom * 1.5, ctr.y + v.zoom * 1.5));
    dom.flush();
    eq("isoui.drag.move-shape", [s.prefs.iso.w, s.prefs.iso.d, s.prefs.iso.h], [4, 3, 4]);
    ok("isoui.drag.move-origin", s.isoOrigin!.x !== org0.x || s.isoOrigin!.y !== org0.y,
      JSON.stringify([org0, s.isoOrigin]));
    eq("isoui.drag.move-snapped", [s.isoOrigin!.x % (T / 2), s.isoOrigin!.y % (T / 4)], [0, 0]);
    // 抓手坐标与引擎口径一致：地面原点 + 局部角坐标 × zoom
    const c = isoGroundCorners(T, s.prefs.iso.w, s.prefs.iso.d);
    const anchor = handle(v, "top");
    ok("isoui.handles.right", Math.abs(handle(v, "right").x - (anchor.x + c.right.x * v.zoom)) < 0.001);
    ok("isoui.handles.height", Math.abs(handle(v, "height").y - (anchor.y + isoHeightHandle(T, s.prefs.iso.w, s.prefs.iso.d, s.prefs.iso.h).y * v.zoom)) < 0.001);
    eq("isoui.gen.new-layer-history", s.history.canUndo(), false);   // 拖动只改参数，不写像素
  }

  // --- 越界与上限：形状全在画布外时不写像素，改参数夹在范围内 ---
  {
    const { s } = mk();
    s.enterIso();
    s.setIsoPref({ shape: "box", w: 2, d: 2, h: 2, tile: 16 });
    s.setIsoOrigin(200, 200);       // 画布只有 64×64
    const r = s.isoGenerate("layer");
    eq("isoui.outside.refused", r.ok, false);
    eq("isoui.outside.reason", r.reason, "outside");
    eq("isoui.outside.painted", painted(s), 0);
    s.setIsoPref({ w: 999, d: -5, h: 0 });
    eq("isoui.clamp.w", s.prefs.iso.w, 64);
    eq("isoui.clamp.d", s.prefs.iso.d, 1);
    eq("isoui.clamp.h", s.prefs.iso.h, 1);
    // 锁定图层：拒绝并提示（不写像素）
    s.setIsoOrigin(8, 8);
    s.doc.layers[s.curLayer()].locked = true;
    const r2 = s.isoGenerate("layer");
    eq("isoui.locked.refused", [r2.ok, r2.reason], [false, "locked"]);
    eq("isoui.locked.painted", painted(s), 0);
  }

  // --- 生成到新图层：图层 +1，像素在新层上，撤销一次回到原状 ---
  {
    const { s } = mk();
    s.setIsoPref({ shape: "box", w: 1, d: 1, h: 1, tile: 16, shadow: "off", outline: false });
    s.enterIso();
    s.setIsoOrigin(16, 16);
    const layers0 = s.doc.layers.length;
    const r = s.isoGenerate("new");
    ok("isoui.newlayer.ok", r.ok, JSON.stringify(r));
    eq("isoui.newlayer.count", s.doc.layers.length, layers0 + 1);
    const li = s.curLayer();
    ok("isoui.newlayer.painted", s.doc.celAt(li, s.curFrame())!.data.some((v, i) => i % 4 === 3 && v > 0));
    ok("isoui.newlayer.name", /iso/i.test(s.doc.layers[li].name), s.doc.layers[li].name);
    s.history.undo();
    eq("isoui.newlayer.undo-layers", s.doc.layers.length, layers0);
  }

  // --- 参数持久化：改完写进 prefs，新 Session 读得回来 ---
  {
    const { s } = mk();
    s.setIsoPref({ shape: "cylinder", w: 7, d: 7, h: 3, tile: 32, colorMode: "custom", faceTop: "#112233", outline: false, shadow: "off" });
    ok("isoui.persist.saved", !!JSON.parse(localStorage.getItem("pc.prefs") || "{}").iso);
    const s2 = new Session();
    eq("isoui.persist.shape", s2.prefs.iso.shape, "cylinder");
    eq("isoui.persist.tile", s2.prefs.iso.tile, 32);
    eq("isoui.persist.colorMode", s2.prefs.iso.colorMode, "custom");
    eq("isoui.persist.faceTop", s2.prefs.iso.faceTop, "#112233");
    eq("isoui.persist.outline", s2.prefs.iso.outline, false);
  }

  // --- 三面颜色：单色三档 / 前景色三档 / 三面自定 ---
  {
    const { s } = mk();
    s.setColor([10, 20, 30, 255]);
    s.setIsoPref({ colorMode: "mono", faceRight: "#c88c5a" });
    const mono = s.isoLook().faces;
    eq("isoui.look.mono-right", mono.right.join(","), "200,140,90,255");
    s.setIsoPref({ colorMode: "fg" });
    eq("isoui.look.fg-right", s.isoLook().faces.right.join(","), "10,20,30,255");
    s.setIsoPref({ colorMode: "custom", faceTop: "#010203", faceRight: "#040506", faceLeft: "#070809" });
    const cu = s.isoLook().faces;
    eq("isoui.look.custom", [cu.top.join(","), cu.right.join(","), cu.left.join(",")],
      ["1,2,3,255", "4,5,6,255", "7,8,9,255"]);
  }

  // --- 模式期间画布手势被接管：按下不会画出笔迹 ---
  {
    const { s, v } = mk(false);
    s.setTool("pencil");
    s.enterIso();
    v.onDown(ev(60, 60));
    v.onMove(ev(70, 70));
    v.onUp(ev(70, 70));
    dom.flush();
    eq("isoui.gesture.no-stroke", painted(s), 0);
    s.exitIso();
  }

  // --- alpha 读数：新图层上的生成物确实落在预览位置（原点 + originAt 的反推）---
  {
    const { s } = mk();
    s.enterIso();
    s.setIsoPref({ shape: "box", w: 1, d: 1, h: 1, tile: 16, shadow: "off", outline: false });
    s.setIsoOrigin(16, 16);
    const r = s.isoGenerate("layer");
    ok("isoui.place.ok", r.ok);
    const res = isoRender(isoShapeVoxels(s.isoShape()), s.isoLook());
    const ox = 16 - res.originAt.x, oy = 16 - res.originAt.y;
    // 缓冲左上角那一点（顶面最上面一格）应该被写上
    ok("isoui.place.top-pixel", alphaAt(s, ox + Math.floor(res.w / 2), oy) === 255 || alphaAt(s, ox + res.originAt.x, oy) === 255,
      JSON.stringify([ox, oy, res.w, res.h]));
    eq("isoui.place.bbox", s.isoLast, { x: Math.max(0, ox), y: Math.max(0, oy), w: res.w, h: res.h });
  }
}
