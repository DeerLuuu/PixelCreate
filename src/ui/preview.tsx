import React, { useRef, useState } from "react";
import { SESSION } from "./singleton";
import { makeT } from "./i18n";
import type { Lang } from "./i18n";
import { Icon } from "./base";
import * as compositor from "../render/compositor";
export function PreviewBox() {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const cvRef = useRef<HTMLCanvasElement | null>(null);
  const [show, setShow] = useState(() => { try { return localStorage.getItem("pc.preview") === "1"; } catch { return false; } });
  const [size, setSize] = useState(() => { try { const n = parseInt(localStorage.getItem("pc.prev.size") || "148", 10); return n >= 90 && n <= 380 ? n : 148; } catch { return 148; } });
  const sizeRef = useRef(size);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const posRef = useRef<{ x: number; y: number } | null>(null);
  const grabStart = useRef<{ px: number; py: number; lx: number; ly: number } | null>(null);
  const rzStart = useRef<{ px: number; py: number; size: number } | null>(null);
  const [closing, setClosing] = useState(false);
  /** two-finger pinch on the box resizes it (same range as the corner handle) */
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d0: number; s0: number } | null>(null);
  const pinchDist = () => {
    const [a, b] = [...pts.current.values()];
    return Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
  };
  /** the single "display" button opens this second-level menu (bg + greyscale) */
  const [menu, setMenu] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const tp = makeT(SESSION.prefs.lang as Lang);

  const parentRect = () => { const p = boxRef.current?.closest(".viewport") as HTMLElement | null; return p ? p.getBoundingClientRect() : { width: window.innerWidth, height: window.innerHeight, left: 0, top: 0 }; };
  const clampPos = (s: number) => {
    const r = parentRect();
    const cur = posRef.current ?? { x: 0, y: 10 };
    const maxX = Math.max(0, Math.min(r.width - s - 8, window.innerWidth - s - 8));
    const maxY = Math.max(0, Math.min(r.height - s - 8, window.innerHeight - s - 8));
    const p = { x: Math.max(0, Math.min(maxX, cur.x)), y: Math.max(4, Math.min(maxY, cur.y)) };
    posRef.current = p; setPos(p);
  };
  const ensurePos = () => {
    if (!posRef.current) {
      const r = parentRect();
      const avail = Math.max(90, Math.min(r.width - 30, r.height - 40));
      if (sizeRef.current > avail) { sizeRef.current = avail; setSize(avail); }
      posRef.current = { x: Math.max(4, r.width - sizeRef.current - 14), y: Math.max(52, Math.min(r.height - sizeRef.current - 20, 62)) };
    }
    clampPos(sizeRef.current);
  };

  const draw = () => {
    const cv = cvRef.current;
    if (!cv || !show) return;
    ensurePos();
    const s = sizeRef.current;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(s * dpr)) { cv.width = Math.round(s * dpr); cv.height = Math.round(s * dpr); }
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, s, s);
    const mode = SESSION.prefs.previewBg || "white";
    const doc = SESSION.doc;
    const fit = Math.min(s / doc.w, s / doc.h);
    const sc = fit >= 1 ? Math.max(1, Math.floor(fit)) : fit;
    const w = doc.w * sc, h = doc.h * sc;
    const ox = (s - w) / 2, oy = (s - h) / 2;
    if (mode === "white") { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, s, s); }
    else { ctx.fillStyle = mode === "black" ? "#101116" : "#9aa0b0"; ctx.fillRect(0, 0, s, s); }
    try {
      const c = compositor.composeFrame(doc, SESSION.curFrame(), { bgOverride: null });
      const down = sc < 1;
      ctx.imageSmoothingEnabled = down;
      if (down) ctx.imageSmoothingQuality = "high";
      // greyscale preview: filter only the artwork, so the chosen backdrop
      // keeps its own colour (white / black / checker stay readable)
      const gray = SESSION.prefs.previewGray === true;
      if (gray) ctx.filter = "grayscale(1)";
      ctx.drawImage(c, ox, oy, w, h);
      if (gray) ctx.filter = "none";
    } catch { /* ignore */ }
  };

  React.useEffect(() => {
    if (!show) return;
    const un = SESSION.registerPreview(draw);
    const un2 = SESSION.subscribe(() => draw());
    const t = window.setTimeout(() => { ensurePos(); draw(); }, 60);
    const onResize = () => { ensurePos(); clampPos(sizeRef.current); draw(); };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => { un(); un2(); window.clearTimeout(t); window.removeEventListener("resize", onResize); window.removeEventListener("orientationchange", onResize); };
  }, [show]);

  // redraw once the box is actually mounted (first frame may have been missed
  // when the preview was already enabled from a previous session)
  React.useEffect(() => {
    if (!show || !pos) return;
    const t = window.setTimeout(() => draw(), 0);
    return () => window.clearTimeout(t);
  }, [show, pos, size]);

  const s = size;
  const bgMode = SESSION.prefs.previewBg || "white";
  const gray = SESSION.prefs.previewGray === true;
  const bgCss = bgMode === "white" ? "#fff"
    : bgMode === "black" ? "#101116"
    : "repeating-conic-gradient(#9aa0b0 0% 25%, #b9bec9 0% 50%)";
  return (
    <>
      <button className="prev-toggle" title={tp("preview")} onClick={() => {
        if (show) {
          if (closeTimer.current !== null) {
            window.clearTimeout(closeTimer.current);
            closeTimer.current = null;
            setClosing(false);
            return;
          }
          setClosing(true);
          closeTimer.current = window.setTimeout(() => {
            closeTimer.current = null;
            setClosing(false);
            setShow(false);
            try { localStorage.setItem("pc.preview", "0"); } catch { /* ignore */ }
          }, 190);
        } else {
          setShow(true);
          try { localStorage.setItem("pc.preview", "1"); } catch { /* ignore */ }
          window.setTimeout(() => { ensurePos(); draw(); }, 0);
        }
      }}><Icon id="i-eye" size={16} /></button>
      {show && pos && (
        <>
        <div className={"prevbox" + (closing ? " closing" : "")} ref={boxRef} style={{ left: pos.x, top: pos.y, width: s, height: s, padding: 0 }}
          onPointerDown={(e) => {
            pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pts.current.size === 2) { pinch.current = { d0: pinchDist(), s0: sizeRef.current }; grabStart.current = null; }
          }}
          onPointerMove={(e) => {
            if (!pts.current.has(e.pointerId)) return;
            pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
            const p = pinch.current;
            if (!p || pts.current.size < 2) return;
            e.preventDefault();
            const r = parentRect();
            const ns = Math.max(90, Math.min(Math.min(r.width - 20, r.height - 30, 380), Math.round(p.s0 * (pinchDist() / p.d0))));
            if (ns === sizeRef.current) return;
            sizeRef.current = ns;
            setSize(ns);
            try { localStorage.setItem("pc.prev.size", String(ns)); } catch { /* ignore */ }
            clampPos(ns);
          }}
          onPointerUp={(e) => { pts.current.delete(e.pointerId); if (pts.current.size < 2) pinch.current = null; }}
          onPointerCancel={(e) => { pts.current.delete(e.pointerId); if (pts.current.size < 2) pinch.current = null; }}>
          <canvas ref={cvRef} style={{ width: s, height: s, display: "block" }} />
          <div className="prev-grab"
            onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ } const p = posRef.current ?? { x: 0, y: 10 }; grabStart.current = { px: e.clientX, py: e.clientY, lx: p.x, ly: p.y }; }}
            onPointerMove={(e) => { const g = grabStart.current; if (!g || pts.current.size > 1) return; const p = { x: g.lx + (e.clientX - g.px), y: g.ly + (e.clientY - g.py) }; posRef.current = p; setPos(p); clampPos(sizeRef.current); }}
            onPointerUp={(e) => { try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ } grabStart.current = null; }}
            onPointerCancel={() => { grabStart.current = null; }}
          />

          <div className="prev-resize"
            onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ } rzStart.current = { px: e.clientX, py: e.clientY, size: sizeRef.current }; }}
            onPointerMove={(e) => { const rz = rzStart.current; if (!rz) return; const r = parentRect(); const delta = Math.max(e.clientX - rz.px, e.clientY - rz.py); const ns = Math.max(90, Math.min(Math.min(r.width - 20, r.height - 30, 380), rz.size + delta)); sizeRef.current = ns; setSize(ns); try { localStorage.setItem("pc.prev.size", String(Math.round(ns))); } catch { /* ignore */ } clampPos(ns); }}
            onPointerUp={(e) => { try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ } rzStart.current = null; }}
            onPointerCancel={() => { rzStart.current = null; }}
          />
        </div>
        <button className={"prev-bg" + (gray ? " gray" : "")} title={tp("previewBgHint")}
          onClick={() => setMenu(!menu)}
          style={{ left: pos.x + s - 24, top: pos.y - 8, background: bgCss }} />
        {menu && (
          <>
            <div className="dropmenu-back" onClick={() => setMenu(false)} />
            <div className="prev-menu" style={{
              left: Math.max(6, Math.min(window.innerWidth - 168, pos.x + s - 162)),
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
      )}
    </>
  );
}