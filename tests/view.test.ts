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
import { ok } from "./common";

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

    // live snap preview: entering a zone, holding it, then leaving it
    const sv = view as unknown as { setSnapPreview(a: number | null, b: number | null, animate?: boolean): void; snapLive: unknown; snapFlash: unknown };
    sv.setSnapPreview(0, bi);
    dom.flush();
    ok("view.snapzone.live", !!sv.snapLive);
    ok("view.snapzone.flash-in", !!sv.snapFlash && (sv.snapFlash as { kind: string }).kind === "in");
    // the same pair again must NOT restart the flash (single drag, one flash)
    const flash0 = sv.snapFlash;
    sv.setSnapPreview(0, bi);
    ok("view.snapzone.steady", sv.snapFlash === flash0);
    // leaving the zone: one flash, then the zone is gone
    sv.setSnapPreview(null, null);
    dom.flush();
    ok("view.snapzone.cleared", !sv.snapLive);
    ok("view.snapzone.flash-out", !!sv.snapFlash && (sv.snapFlash as { kind: string }).kind === "out");
    // silent clear (release: the permanent group highlight takes over)
    sv.setSnapPreview(0, bi);
    sv.setSnapPreview(null, null, false);
    ok("view.snapzone.silent-clear", !sv.snapLive);

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

    view.destroy();
  } finally {
    cmod.composeFrameWithOnion = origOnion;
    delete (g as Record<string, unknown>).document;
  }
}
