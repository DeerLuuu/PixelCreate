// Floating preview windows (multi-canvas).
//
// There is no global preview button any more: a window appears only when the
// canvas orb's 预览 action is used, and each window is bound to ONE canvas of
// the space (so several canvases can be previewed side by side).
import React, { useRef, useState } from "react";
import { SESSION } from "./singleton";
import { makeT } from "./i18n";
import type { Lang } from "./i18n";
import { Icon, useSession } from "./base";
import * as compositor from "../render/compositor";

export function PreviewBox() {
  useSession(); // re-render when windows are added / moved / closed
  return <>{SESSION.previews.map((p, i) => <OnePreview key={p.id} id={p.id} slot={i} />)}</>;
}

function OnePreview({ id, slot }: { id: string; slot: number }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const cvRef = useRef<HTMLCanvasElement | null>(null);
  const [menu, setMenu] = useState(false);
  const grabStart = useRef<{ px: number; py: number; lx: number; ly: number } | null>(null);
  const rzStart = useRef<{ px: number; py: number; size: number } | null>(null);
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d0: number; s0: number } | null>(null);
  const tp = makeT(SESSION.prefs.lang as Lang);

  const entry = SESSION.previews.find((p) => p.id === id);
  if (!entry) return null;
  const target = SESSION.docs[entry.canvas];
  if (!target) return null;

  const parentRect = () => {
    const p = boxRef.current?.closest(".viewport") as HTMLElement | null;
    return p ? p.getBoundingClientRect() : { width: window.innerWidth, height: window.innerHeight, left: 0, top: 0 };
  };
  /** auto placement: cascade from the top-right corner, one slot per window */
  const autoPos = (sz: number) => {
    const r = parentRect();
    const step = 24;
    return {
      x: Math.max(4, Math.min(r.width - sz - 8, r.width - sz - 14 - slot * step)),
      y: Math.max(4, Math.min(r.height - sz - 8, 46 + slot * step)),
    };
  };
  const size = entry.size;
  const pos = entry.x === null || entry.y === null ? autoPos(size) : { x: entry.x, y: entry.y };
  const clampTo = (x: number, y: number) => {
    const r = parentRect();
    return {
      x: Math.max(0, Math.min(Math.min(r.width - size - 8, window.innerWidth - size - 8), x)),
      y: Math.max(4, Math.min(Math.min(r.height - size - 8, window.innerHeight - size - 8), y)),
    };
  };

  const draw = () => {
    const cv = cvRef.current;
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(size * dpr)) { cv.width = Math.round(size * dpr); cv.height = Math.round(size * dpr); }
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const mode = SESSION.prefs.previewBg || "white";
    const doc = target.doc;
    const fit = Math.min(size / doc.w, size / doc.h);
    const sc = fit >= 1 ? Math.max(1, Math.floor(fit)) : fit;
    const w = doc.w * sc, h = doc.h * sc;
    const ox = (size - w) / 2, oy = (size - h) / 2;
    if (mode === "white") { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, size, size); }
    else { ctx.fillStyle = mode === "black" ? "#101116" : "#9aa0b0"; ctx.fillRect(0, 0, size, size); }
    try {
      const c = compositor.composeFrame(doc, target.fi, { bgOverride: null });
      const down = sc < 1;
      ctx.imageSmoothingEnabled = down;
      if (down) ctx.imageSmoothingQuality = "high";
      // greyscale preview: filter only the artwork so the backdrop keeps its own colour
      const gray = SESSION.prefs.previewGray === true;
      if (gray) ctx.filter = "grayscale(1)";
      ctx.drawImage(c, ox, oy, w, h);
      if (gray) ctx.filter = "none";
    } catch { /* ignore */ }
  };

  React.useEffect(() => {
    const un = SESSION.registerPreview(draw);
    const un2 = SESSION.subscribe(() => draw());
    const t = window.setTimeout(draw, 30);
    window.addEventListener("resize", draw);
    window.addEventListener("orientationchange", draw);
    return () => {
      un(); un2();
      window.clearTimeout(t);
      window.removeEventListener("resize", draw);
      window.removeEventListener("orientationchange", draw);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, entry.canvas, target.fi, target.doc]);

  const bgMode = SESSION.prefs.previewBg || "white";
  const gray = SESSION.prefs.previewGray === true;
  const bgCss = bgMode === "white" ? "#fff"
    : bgMode === "black" ? "#101116"
    : "repeating-conic-gradient(#9aa0b0 0% 25%, #b9bec9 0% 50%)";
  const pinchDist = () => { const [a, b] = [...pts.current.values()]; return Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)); };

  return (
    <>
      <div className="prevbox" ref={boxRef} style={{ left: pos.x, top: pos.y, width: size, height: size, padding: 0 }}
        onPointerDown={(e) => {
          pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pts.current.size === 2) { pinch.current = { d0: pinchDist(), s0: size }; grabStart.current = null; }
        }}
        onPointerMove={(e) => {
          if (!pts.current.has(e.pointerId)) return;
          pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          const p = pinch.current;
          if (!p || pts.current.size < 2) return;
          e.preventDefault();
          const r = parentRect();
          const ns = Math.max(90, Math.min(Math.min(r.width - 20, r.height - 30, 380), Math.round(p.s0 * (pinchDist() / p.d0))));
          if (ns !== size) SESSION.resizePreview(id, ns);
        }}
        onPointerUp={(e) => { pts.current.delete(e.pointerId); if (pts.current.size < 2) pinch.current = null; }}
        onPointerCancel={(e) => { pts.current.delete(e.pointerId); if (pts.current.size < 2) pinch.current = null; }}>
        <canvas ref={cvRef} style={{ width: size, height: size, display: "block" }} />
        <div className="prev-grab" title={tp("canvasPreviewDrag")}
          onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ } grabStart.current = { px: e.clientX, py: e.clientY, lx: pos.x, ly: pos.y }; }}
          onPointerMove={(e) => { const g = grabStart.current; if (!g || pts.current.size > 1) return; const p = clampTo(g.lx + (e.clientX - g.px), g.ly + (e.clientY - g.py)); SESSION.movePreview(id, p.x, p.y); }}
          onPointerUp={(e) => { try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ } grabStart.current = null; }}
          onPointerCancel={() => { grabStart.current = null; }} />
        <div className="prev-resize"
          onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ } rzStart.current = { px: e.clientX, py: e.clientY, size }; }}
          onPointerMove={(e) => { const rz = rzStart.current; if (!rz) return; const r = parentRect(); const delta = Math.max(e.clientX - rz.px, e.clientY - rz.py); SESSION.resizePreview(id, Math.max(90, Math.min(Math.min(r.width - 20, r.height - 30, 380), rz.size + delta))); }}
          onPointerUp={(e) => { try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ } rzStart.current = null; }}
          onPointerCancel={() => { rzStart.current = null; }} />
        <button className="prev-close" title={tp("close")} onClick={() => SESSION.closePreview(id)}><Icon id="i-x" size={13} /></button>
      </div>
      <button className={"prev-bg" + (gray ? " gray" : "")} title={tp("previewBgHint")}
        onClick={() => setMenu(!menu)}
        style={{ left: pos.x + size - 24, top: pos.y - 8, background: bgCss }} />
      {menu && (
        <>
          <div className="dropmenu-back" onClick={() => setMenu(false)} />
          <div className="prev-menu" style={{
            left: Math.max(6, Math.min(window.innerWidth - 168, pos.x + size - 162)),
            top: Math.min(window.innerHeight - 190, pos.y + 22),
          }}>
            <div className="prev-menu-head">{tp("previewBg")}</div>
            {(["white", "black", "checker"] as const).map((m) => (
              <button key={m} type="button"
                className={"dropmenu-item" + ((SESSION.prefs.previewBg || "white") === m ? " on" : "")}
                onClick={() => { SESSION.setPreviewBg(m); setMenu(false); window.setTimeout(draw, 0); }}>
                {tp(m === "white" ? "previewWhite" : m === "black" ? "previewBlack" : "previewChecker")}
              </button>
            ))}
            <div className="prev-menu-sep" />
            <button type="button"
              className={"dropmenu-item" + (gray ? " on" : "")}
              onClick={() => { SESSION.setPreviewGray(!gray); setMenu(false); window.setTimeout(draw, 0); }}>
              {tp("previewGray")}
            </button>
          </div>
        </>
      )}
    </>
  );
}
