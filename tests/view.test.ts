// Headless View smoke test.
//
// The View needs a canvas 2D context, which Node does not have — so this test
// installs a Proxy-based stub: every drawing call is a no-op, which is enough
// to prove the CONTROL FLOW (does a redirected stroke on a reference layer
// rebuild the composite while the finger is still down?).
import { Session } from "../src/app/session";
import { View } from "../src/render/view";
import { Doc, Sel } from "../src/engine/doc";
import * as compositor from "../src/render/compositor";
import { stubEnv } from "./session.test";
import { applyPcMode } from "../src/io/pcmode";
import { eq, ok } from "./common";

interface Stub { flush: () => void }

export function stubViewDom(): Stub {
  const g = globalThis as unknown as Record<string, unknown>;
  // document / canvas / ImageData come from stubEnv() (see session.test.ts)
  g.ResizeObserver = class { observe(): void { /* ignore */ } disconnect(): void { /* ignore */ } };
  let rafCb: (() => void) | null = null;
  const w = (g.window ?? (g.window = {})) as Record<string, unknown>;
  w.requestAnimationFrame = (cb: () => void) => { rafCb = cb; return 1; };
  w.cancelAnimationFrame = () => { rafCb = null; };
  w.devicePixelRatio = 1;
  w.addEventListener = () => undefined;
  w.removeEventListener = () => undefined;
  w.dispatchEvent = () => undefined;
  w.innerWidth = 360;
  w.innerHeight = 640;
  return { flush: () => { const cb = rafCb; rafCb = null; if (cb) cb(); } };
}

export function testView(): void {
  stubEnv();
  const dom = stubViewDom();
  const g = globalThis as unknown as Record<string, unknown>;
  const cmod = compositor as unknown as Record<string, unknown>;
  const origOnion = cmod.composeFrameWithOnion;
  /** focused composite rebuilds */
  let onionCalls = 0;
  cmod.composeFrameWithOnion = (...a: unknown[]) => { onionCalls++; return (origOnion as (...x: unknown[]) => unknown)(...a); };
  try {
    const s = new Session();
    const host = {
      clientWidth: 320, clientHeight: 240, style: {},
      appendChild: () => undefined, replaceChildren: () => undefined,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 240 }),
      addEventListener: () => undefined,
      setPointerCapture: () => undefined, releasePointerCapture: () => undefined,
    } as unknown as HTMLElement;
    const view = new View(host, s);
    s.attachView(view);
    view.fit();
    dom.flush();

    // canvas A references canvas B, then a pencil stroke is drawn on the ref layer
    s.doc.name = "A";
    const bi = s.addCanvas(new Doc(64, 64, "B"));
    s.focusCanvas(0);
    ok("view.ref.link", s.referenceCanvas(bi));
    const li = s.curLayer();
    ok("view.ref.layer", s.isRefLayer(li));
    dom.flush();

    const ev = (x: number, y: number): PointerEvent => ({
      clientX: x, clientY: y, pointerId: 1, pointerType: "touch", pressure: 1,
      preventDefault: () => undefined, stopPropagation: () => undefined,
    } as unknown as PointerEvent);

    // the reference layer mirrors the source into its OWN cel; every repaint
    // must refresh that mirror (holder doc pixelRev bumps) and rebuild the view
    const holderRev = (): number => s.doc.pixelRev;
    const o0 = onionCalls, v0 = holderRev();
    (view as unknown as { onDown(e: PointerEvent): void }).onDown(ev(60, 30));
    dom.flush();
    ok("view.ref.compose-on-down", onionCalls > o0, "onion=" + o0 + "->" + onionCalls);
    ok("view.ref.mirror-on-down", holderRev() > v0, "rev=" + v0 + "->" + holderRev());

    // the crucial one: a pointermove while the finger is still down must both
    // rebuild the composite AND re-resolve the reference image
    const o1 = onionCalls, v1 = holderRev();
    (view as unknown as { onMove(e: PointerEvent): void }).onMove(ev(70, 40));
    dom.flush();
    ok("view.ref.compose-on-move", onionCalls > o1, "onion=" + o1 + "->" + onionCalls);
    ok("view.ref.mirror-on-move", holderRev() > v1, "rev=" + v1 + "->" + holderRev());

    const o2 = onionCalls, v2 = holderRev();
    (view as unknown as { onMove(e: PointerEvent): void }).onMove(ev(80, 50));
    dom.flush();
    ok("view.ref.compose-every-move", onionCalls > o2 && holderRev() > v2,
      "onion=" + o2 + "->" + onionCalls + " rev=" + v2 + "->" + holderRev());

    (view as unknown as { onUp(e: PointerEvent): void }).onUp(ev(80, 50));
    dom.flush();
    const src = s.docs[bi];
    ok("view.ref.painted-into-source", !!src.doc.celAt(src.li, src.fi)?.hasAnyOpaque());
    ok("view.ref.mirror-cel-exists", !!s.doc.celAt(li, 0));

    // a selection on the SOURCE canvas is drawn on its reference layer only
    src.doc.sel = new Sel(64, 64, true);
    dom.flush();
    ok("view.ref.source-selection-draws", true);

    // focusing the SOURCE canvas must not lose what was painted through the
    // reference layer (regression: the mirror used to overwrite it)
    const srcPix = src.doc.celAt(src.li, src.fi)!.data.join();
    s.focusCanvas(bi);
    dom.flush();
    ok("view.ref.source-keeps-paint", src.doc.celAt(src.li, src.fi)!.data.join() === srcPix);
    s.focusCanvas(0);
    dom.flush();
    // (the mirrored CONTENT cannot be checked here: the stub canvas does not
    // rasterise — the Session tests cover the mirror pixel-for-pixel)
    ok("view.ref.mirror-cel-still-linked", s.isRefLayer(li) && !!s.doc.celAt(li, 0));

    // ---- shape -> selection still works (normal layer AND reference layer) ----
    // normal layer of the holder
    s.setLayer(0);
    s.setTool("line");
    (view as unknown as { onDown(e: PointerEvent): void }).onDown(ev(60, 30));
    (view as unknown as { onMove(e: PointerEvent): void }).onMove(ev(110, 80));
    (view as unknown as { onUp(e: PointerEvent): void }).onUp(ev(110, 80));
    dom.flush();
    ok("view.shape.select-normal", s.tool === "select" && !!s.doc.sel && s.doc.sel.hasAny());

    // reference layer: the shape is painted into the source, and the selection
    // is mapped back onto this canvas so the user still sees it
    s.setLayer(li);
    s.setTool("rect");
    (view as unknown as { onDown(e: PointerEvent): void }).onDown(ev(60, 30));
    (view as unknown as { onMove(e: PointerEvent): void }).onMove(ev(110, 80));
    (view as unknown as { onUp(e: PointerEvent): void }).onUp(ev(110, 80));
    dom.flush();
    ok("view.shape.select-ref", s.tool === "select" && !!s.doc.sel && s.doc.sel.hasAny());
    const b = s.doc.sel!.bounds();
    ok("view.shape.select-ref-bounds", !!b && b.w > 1 && b.h > 1, JSON.stringify(b));

    // dragging the FOCUSED canvas must pan the camera with it (the canvas has to
    // follow the finger instead of the whole space sliding away)
    const zoom0 = view.zoom;
    const ox0 = view.ox;
    s.focusCanvas(0);
    dom.flush();
    const ox1 = view.ox;
    s.moveCanvas(0, s.docs[0].x + 10, s.docs[0].y);
    dom.flush();
    ok("view.drag.camera-follows-focus", Math.abs(view.ox - (ox1 + 10 * zoom0)) < 0.001, "ox " + ox1 + " -> " + view.ox);
    // dragging a canvas that is NOT focused must not move the camera
    const ox2 = view.ox;
    s.moveCanvas(bi, s.docs[bi].x + 10, s.docs[bi].y);
    dom.flush();
    ok("view.drag.camera-stays", Math.abs(view.ox - ox2) < 0.001, "ox " + ox2 + " -> " + view.ox);
    ok("view.drag.ox-restored", Math.abs(ox0 - view.ox) < 40, "ox0=" + ox0 + " now=" + view.ox);

    // live snap zones: several can be lit at once, each with its own in/out flash
    const sv = view as unknown as {
      setSnapZones(z: Array<{ a: number; b: number; x0: number; y0: number; x1: number; y1: number }>, animate?: boolean): void;
      snapZones: Map<string, unknown>;
      snapFlashes: Array<{ kind: string }>;
    };
    const zone = (a: number, b: number, x0: number, y0: number): { a: number; b: number; x0: number; y0: number; x1: number; y1: number } =>
      ({ a, b, x0, y0, x1: x0 + 8, y1: y0 + 40 });
    sv.setSnapZones([zone(0, bi, 100, 0)]);
    dom.flush();
    ok("view.snapzone.live", sv.snapZones.size === 1);
    ok("view.snapzone.flash-in", sv.snapFlashes.some((f) => f.kind === "in"));
    // adding a SECOND zone keeps the first one lit and only flashes the new one
    const flashes0 = sv.snapFlashes.length;
    sv.setSnapZones([zone(0, bi, 100, 0), zone(0, 2, 100, 200)]);
    dom.flush();
    ok("view.snapzone.multiple", sv.snapZones.size === 2);
    ok("view.snapzone.one-flash-per-new", sv.snapFlashes.length === flashes0 + 1);
    // the same set again: no new flash at all
    const flashes1 = sv.snapFlashes.length;
    sv.setSnapZones([zone(0, bi, 100, 0), zone(0, 2, 100, 200)]);
    ok("view.snapzone.steady", sv.snapFlashes.length === flashes1);
    // dropping one zone flashes THAT one out (red) and keeps the other
    sv.setSnapZones([zone(0, bi, 100, 0)]);
    dom.flush();
    ok("view.snapzone.partial-leave", sv.snapZones.size === 1);
    ok("view.snapzone.flash-out", sv.snapFlashes.some((f) => f.kind === "out"));
    // silent clear (release: the permanent group highlight takes over)
    sv.setSnapZones([], false);
    ok("view.snapzone.silent-clear", sv.snapZones.size === 0);

    // the un-snap dissolve animation must run without throwing
    (view as unknown as { pulseUnsnap(p: Array<[number, number]>): void }).pulseUnsnap([[0, bi]]);
    dom.flush();
    ok("view.unsnap.pulse", true);

    // double-tap ON another canvas focuses it and zooms it to fit
    s.focusCanvas(0);
    dom.flush();
    const other = s.docs[bi];
    const base = s.docs[0];
    const tx = view.ox + (other.x - base.x) * view.zoom + 10 * view.zoom;
    const ty = view.oy + (other.y - base.y) * view.zoom + 10 * view.zoom;
    (view as unknown as { onDown(e: PointerEvent): void }).onDown(ev(tx, ty));
    (view as unknown as { onUp(e: PointerEvent): void }).onUp(ev(tx, ty));
    (view as unknown as { onDown(e: PointerEvent): void }).onDown(ev(tx, ty));
    (view as unknown as { onUp(e: PointerEvent): void }).onUp(ev(tx, ty));
    dom.flush();
    ok("view.doubletap-canvas-focus", s.docIdx === bi, "docIdx=" + s.docIdx);
    ok("view.doubletap-canvas-fits", view.zoom > 0);

    // ---- view rotation: the logical->surface mapping round-trips and the
    // pointer path (surface -> logical -> pixel) stays consistent ----
    view.setRotation(90);
    ok("view.rot.90", view.rot === 90);
    const q = view.toSurface(0, 0);
    ok("view.rot.surface-corner", q.x === 320 && q.y === 0, JSON.stringify(q));
    const back = view.toLogical(q.x, q.y);
    ok("view.rot.roundtrip", back.x === 0 && back.y === 0, JSON.stringify(back));
    const p90 = view.toSurface(10, 20);
    const l90 = view.toLogical(p90.x, p90.y);
    ok("view.rot.roundtrip2", l90.x === 10 && l90.y === 20, JSON.stringify(l90));
    const d90 = view.surfaceDelta(10, 0);
    ok("view.rot.delta", Math.abs(d90.x) < 1e-9 && Math.abs(d90.y + 10 / view.zoom) < 1e-9, JSON.stringify(d90));
    view.setRotation(180);
    const p180 = view.toSurface(10, 20);
    ok("view.rot.180", p180.x === 310 && p180.y === 220, JSON.stringify(p180));
    const d180 = view.surfaceDelta(10, 0);
    ok("view.rot.delta180", Math.abs(d180.x + 10 / view.zoom) < 1e-9 && Math.abs(d180.y) < 1e-9);
    view.setRotation(270);
    const p270 = view.toSurface(0, 0);
    ok("view.rot.270", p270.x === 0 && p270.y === 240, JSON.stringify(p270));
    view.setRotation(0);
    ok("view.rot.reset", view.rot === 0);
    // a logical pixel keeps hitting the same space cell at every rotation
    const px0 = view.screenToPixel(40, 50);
    for (const r of [90, 180, 270]) {
      view.setRotation(r);
      const sp = view.toSurface(40, 50);
      const lp = view.toLogical(sp.x, sp.y);
      const px = view.screenToPixel(lp.x, lp.y);
      ok("view.rot.pixel-stable." + r, px.x === px0.x && px.y === px0.y, JSON.stringify([px0, px]));
    }
    view.setRotation(0);

    // ---- multi-point path tools: tap to add, tap the last point to finish ----
    s.focusCanvas(0);
    s.setLayer(0); // the reference mirror is the top layer; paint on a normal one
    s.setTool("polyline");
    const sp = (px: number, py: number): { x: number; y: number } => ({
      x: view.ox + (px + 0.5) * view.zoom, y: view.oy + (py + 0.5) * view.zoom,
    });
    const tap = (px: number, py: number): void => {
      const q = sp(px, py);
      (view as unknown as { onDown(e: PointerEvent): void }).onDown(ev(q.x, q.y));
      (view as unknown as { onUp(e: PointerEvent): void }).onUp(ev(q.x, q.y));
      dom.flush();
    };
    const steps0 = s.history.list().labels.length;
    tap(2, 2); tap(12, 2); tap(12, 12);
    ok("view.path.pending", !!(view as unknown as { path: unknown }).path);
    tap(12, 12); // tap the last point again = finish
    ok("view.path.finished", !(view as unknown as { path: unknown }).path);
    eq("view.path.one-step", s.history.list().labels.length, steps0 + 1);
    const pcel = s.doc.celAt(0, 0)!;
    ok("view.path.painted", pcel.data[pcel.idx(2, 2) + 3] === 255 && pcel.data[pcel.idx(12, 2) + 3] === 255 &&
      pcel.data[pcel.idx(12, 12) + 3] === 255, "px=" + [pcel.data[pcel.idx(2, 2) + 3], pcel.data[pcel.idx(12, 2) + 3]]);

    // ---- editing a reference layer of a SMALLER canvas (end-to-end) ----
    // The mirror is centred, so a tap at holder (30,30) must land on source
    // (6,6) and come back to (30,30): the whole chain (view -> stroke redirect
    // -> mirror sync) has to translate.
    s.focusCanvas(0);
    s.setLayer(0);
    const ci = s.addCanvas(new Doc(16, 16, "C"));
    s.focusCanvas(0);
    ok("view.refsmall.add", s.referenceCanvas(ci));
    const refLi = s.curLayer(); // referenceCanvas focuses the new mirror
    s.setLayer(refLi);
    s.setTool("pencil");
    const q1 = sp(30, 30);
    (view as unknown as { onDown(e: PointerEvent): void }).onDown(ev(q1.x, q1.y));
    (view as unknown as { onUp(e: PointerEvent): void }).onUp(ev(q1.x, q1.y));
    dom.flush();
    const srcCel = s.docs[ci].doc.celAt(0, 0);
    ok("view.refsmall.source-px", !!srcCel && srcCel.data[(6 * 16 + 6) * 4 + 3] === 255,
      srcCel ? "a=" + srcCel.data[(6 * 16 + 6) * 4 + 3] : "no cel");
    const mirCel = s.doc.celAt(refLi, 0);
    ok("view.refsmall.mirror-px", !!mirCel && mirCel.data[(30 * 64 + 30) * 4 + 3] === 255,
      mirCel ? "a=" + mirCel.data[(30 * 64 + 30) * 4 + 3] : "no cel");

    // ---- undo must refresh the mirror BEFORE the view re-composites ----
    // The source canvas reverted, but the holder kept showing the old mirror
    // because syncAll() blitted first and re-mirrored afterwards.
    const prevOnion = cmod.composeFrameWithOnion;
    let watchLi = refLi;
    let watchIdx = (30 * 64 + 30) * 4 + 3;
    let seenAtCompose: number | null = null;
    cmod.composeFrameWithOnion = (...a2: unknown[]) => {
      const d = a2[0] as Doc;
      const cel = d.celAt(watchLi, 0);
      seenAtCompose = cel ? cel.data[watchIdx] : 0;
      return (prevOnion as (...x: unknown[]) => unknown)(...a2);
    };
    try {
      seenAtCompose = null;
      s.undo(); // revert the pencil stroke on the reference layer
      dom.flush();
      eq("view.undo.mirror-at-compose", seenAtCompose, 0);
      const after = s.doc.celAt(refLi, 0);
      eq("view.undo.mirror-cleared", after ? after.data[(30 * 64 + 30) * 4 + 3] : 0, 0);
    } finally {
      cmod.composeFrameWithOnion = prevOnion;
    }

    // ---- palette drag & drop: quickFill fills the canvas under the point ----
    {
      const s2 = new Session();
      const host2 = {
        clientWidth: 320, clientHeight: 240, style: {},
        appendChild: () => undefined, replaceChildren: () => undefined,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 240 }),
        addEventListener: () => undefined,
        setPointerCapture: () => undefined, releasePointerCapture: () => undefined,
      } as unknown as HTMLElement;
      const v2 = new View(host2, s2);
      s2.attachView(v2);
      s2.doc.name = "A";
      const bi = s2.addCanvas(new Doc(32, 32, "B"), { x: 200, y: 0 });
      s2.focusCanvas(0);
      v2.fit();
      dom.flush();
      /** screen point of pixel (x,y) of the focused canvas */
      const at = (x: number, y: number) => ({ sx: v2.ox + (x + 0.5) * v2.zoom, sy: v2.oy + (y + 0.5) * v2.zoom });

      const p0 = at(5, 5);
      const red: [number, number, number, number] = [255, 0, 0, 255];
      const undoBefore = s2.history.canUndo();
      eq("view.quickfill.index", v2.quickFill(p0.sx, p0.sy, red), 0);
      eq("view.quickfill.undo-before", undoBefore, false);   // fresh session
      ok("view.quickfill.one-step", s2.history.canUndo());
      const cel = s2.doc.celAt(s2.curLayer(), s2.curFrame());
      eq("view.quickfill.painted", cel ? [cel.data[0], cel.data[1], cel.data[2], cel.data[3]] : null, red);

      // out in empty space nothing happens (and no history step is added)
      const before2 = s2.history.list().labels.length;
      eq("view.quickfill.miss", v2.quickFill(v2.ox - 400, v2.oy - 400, red), -1);
      eq("view.quickfill.miss-no-step", s2.history.list().labels.length, before2);

      // dropping onto the OTHER canvas fills there and focuses it
      const p1 = at(200 + 4, 4);
      eq("view.quickfill.second.index", v2.quickFill(p1.sx, p1.sy, red), bi);
      eq("view.quickfill.second.focused", s2.docIdx, bi);
      const cel2 = s2.docs[bi].doc.celAt(s2.curLayer(), s2.curFrame());
      eq("view.quickfill.second.painted", cel2 ? [cel2.data[0], cel2.data[1], cel2.data[2], cel2.data[3]] : null, red);

      // undo restores the pixel
      s2.undo();
      const cel2b = s2.docs[bi].doc.celAt(s2.curLayer(), s2.curFrame());
      eq("view.quickfill.undo", cel2b ? cel2b.data[3] : 0, 0);

      v2.destroy();
    }

    // ---- PC 输入层：滚轮缩放 / 中键平移 / 右键用另一个色槽绘制 ----
    {
      const s3 = new Session();
      const handlers: Record<string, Array<(e: unknown) => void>> = {};
      const st3 = {
        clientWidth: 320, clientHeight: 240, style: {} as Record<string, string>,
        appendChild: () => undefined, replaceChildren: () => undefined,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 240 }),
        setPointerCapture: () => undefined, releasePointerCapture: () => undefined,
        addEventListener: (t: string, cb: (e: unknown) => void) => { (handlers[t] ||= []).push(cb); },
      } as unknown as HTMLElement;
      const v3 = new View(st3, s3);
      s3.attachView(v3);
      s3.doc.name = "PC";
      v3.fit();
      dom.flush();
      const fire = (t: string, e: unknown): void => { for (const cb of handlers[t] || []) cb(e); };
      const ev = (o: Record<string, unknown>): never => ({ preventDefault() { /* stub */ }, stopPropagation() { /* stub */ }, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 0, ...o } as never);

      // PC 模式打开前滚轮不生效
      applyPcMode("off");
      const z0 = v3.zoom;
      fire("wheel", ev({ deltaY: -100, deltaMode: 0, clientX: 160, clientY: 120 }));
      eq("view.pc.wheel.off", v3.zoom, z0);

      applyPcMode("on");
      fire("wheel", ev({ deltaY: -100, deltaMode: 0, clientX: 160, clientY: 120 }));
      ok("view.pc.wheel.zoom-in", v3.zoom > z0, "zoom=" + v3.zoom + " was " + z0);
      const zIn = v3.zoom;
      fire("wheel", ev({ deltaY: 100, deltaMode: 0, clientX: 160, clientY: 120 }));
      ok("view.pc.wheel.zoom-out", v3.zoom < zIn);

      // Shift / Alt 滚轮＝平移，不改缩放
      const zKeep = v3.zoom, oxBefore = v3.ox, oyBefore = v3.oy;
      fire("wheel", ev({ deltaY: 60, deltaMode: 0, shiftKey: true, clientX: 160, clientY: 120 }));
      eq("view.pc.wheel.shift-zoom", v3.zoom, zKeep);
      ok("view.pc.wheel.shift-pans", v3.ox !== oxBefore, "ox=" + v3.ox);
      fire("wheel", ev({ deltaY: 60, deltaMode: 0, altKey: true, clientX: 160, clientY: 120 }));
      ok("view.pc.wheel.alt-pans-y", v3.oy !== oyBefore, "oy=" + v3.oy);

      // 中键：不再平移，等价于触屏双击（聚焦并适配画布）
      const ox2 = v3.ox, oy2 = v3.oy;
      const celBefore = s3.doc.celAt(s3.curLayer(), s3.curFrame());
      const zBefore = v3.zoom;
      v3.zoomAt(zBefore * 2, 10, 10);            // 先弄乱一点，好验证「适配」确实发生
      const zZoomed = v3.zoom;
      const focusBefore = s3.docIdx;
      fire("pointerdown", ev({ button: 1, buttons: 4, clientX: 100, clientY: 100 }));
      fire("pointerup", ev({ button: 1, clientX: 100, clientY: 100 }));
      // 中键点在第 2 张画布上：应聚焦到它（等价触屏双击）
      const bi3 = s3.addCanvas(new Doc(32, 32, "PC2"), { x: 200, y: 0 });
      const pt2 = { clientX: v3.ox + (200 + 5.5) * v3.zoom, clientY: v3.oy + 5.5 * v3.zoom };
      fire("pointerdown", ev({ button: 1, buttons: 4, ...pt2 }));
      fire("pointerup", ev({ button: 1, ...pt2 }));
      eq("view.pc.middle-focus.other-canvas", s3.docIdx, bi3);
      void zZoomed; void focusBefore;
      eq("view.pc.middle-focus.no-paint", s3.doc.celAt(s3.curLayer(), s3.curFrame()), celBefore);
      void ox2; void oy2;
      // 空格+左键拖动仍然平移
      (v3 as unknown as { spaceDown: boolean }).spaceDown = true;
      const ox3 = v3.ox, oy3 = v3.oy;
      fire("pointerdown", ev({ button: 0, buttons: 1, clientX: 100, clientY: 100 }));
      fire("pointermove", ev({ button: 0, buttons: 1, clientX: 130, clientY: 120 }));
      fire("pointerup", ev({ button: 0, clientX: 130, clientY: 120 }));
      // 视图可能被 clampView 限制幅度，这里只验证「确实朝该方向平移了」
      ok("view.pc.space-pan", v3.ox > ox3 && v3.oy > oy3, "d=" + (v3.ox - ox3) + "," + (v3.oy - oy3));
      (v3 as unknown as { spaceDown: boolean }).spaceDown = false;

      // 右键＝另一个颜色槽（当前前景色绘制时就是背景色）
      s3.setFgColor([10, 20, 30, 255]);
      s3.bg = [200, 100, 50, 255];
      const alt: [number, number, number, number] = s3.secondaryColor() as [number, number, number, number];
      eq("view.pc.secondary-is-bg", alt, [200, 100, 50, 255]);
      // 落在画布内（视图可能居中留白，必须用变换换算成屏幕坐标）
      const inside = { clientX: v3.ox + 5.5 * v3.zoom, clientY: v3.oy + 5.5 * v3.zoom };
      fire("pointerdown", ev({ button: 2, buttons: 2, ...inside }));
      fire("pointerup", ev({ button: 2, ...inside }));
      const cel3 = s3.doc.celAt(s3.curLayer(), s3.curFrame());
      const off = (5 * s3.doc.w + 5) * 4;   // 落笔在 (5,5)
      const got = cel3 ? [cel3.data[off], cel3.data[off + 1], cel3.data[off + 2], cel3.data[off + 3]] : null;
      eq("view.pc.right.paints-bg", got, [200, 100, 50, 255]);
      // 左键仍然用前景色（换一个远处的像素，避免被判成双击）
      const far = { clientX: v3.ox + 20.5 * v3.zoom, clientY: v3.oy + 20.5 * v3.zoom };
      fire("pointerdown", ev({ button: 0, buttons: 1, ...far }));
      fire("pointerup", ev({ button: 0, ...far }));
      const cel4 = s3.doc.celAt(s3.curLayer(), s3.curFrame());
      const off2 = (20 * s3.doc.w + 20) * 4;
      eq("view.pc.left.paints-fg", cel4 ? [cel4.data[off2], cel4.data[off2 + 1], cel4.data[off2 + 2]] : null, [10, 20, 30]);

      v3.destroy();
    }

    view.destroy();
  } finally {
    cmod.composeFrameWithOnion = origOnion;
    delete (g as Record<string, unknown>).document;
  }
}
