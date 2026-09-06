import React, { useEffect, useRef, useState } from "react";
import { Icon } from "./base";

export interface RefImg { w: number; h: number; px: Uint8ClampedArray; name: string }

/** A draggable / resizable floating window that shows an imported reference
 * image (separate from the sprite preview box). */
export function RefImageBox({ img, onClose }: { img: RefImg; onClose: () => void }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const cvRef = useRef<HTMLCanvasElement | null>(null);
  const srcRef = useRef<HTMLCanvasElement | null>(null);
  const grabStart = useRef<{ px: number; py: number; lx: number; ly: number } | null>(null);
  const rzStart = useRef<{ px: number; py: number; size: number } | null>(null);
  const posRef = useRef<{ x: number; y: number } | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState(() => {
    try { const n = parseInt(localStorage.getItem("pc.ref.size") || "148", 10); return n >= 90 && n <= 380 ? n : 148; } catch { return 148; }
  });
  const sizeRef = useRef(size);
  const s = size;

  const parentRect = () => {
    const p = boxRef.current?.closest(".viewport") as HTMLElement | null;
    return p ? p.getBoundingClientRect() : { width: window.innerWidth, height: window.innerHeight, left: 0, top: 0 };
  };
  const clampPos = (sz: number) => {
    const r = parentRect();
    const cur = posRef.current ?? { x: 10, y: 10 };
    const maxX = Math.max(0, Math.min(r.width - sz - 8, window.innerWidth - sz - 8));
    const maxY = Math.max(0, Math.min(r.height - sz - 8, window.innerHeight - sz - 8));
    const p = { x: Math.max(0, Math.min(maxX, cur.x)), y: Math.max(4, Math.min(maxY, cur.y)) };
    posRef.current = p; setPos(p);
  };
  const ensurePos = () => {
    if (!posRef.current) {
      const r = parentRect();
      const avail = Math.max(90, Math.min(r.width - 30, r.height - 40));
      if (sizeRef.current > avail) { sizeRef.current = avail; setSize(avail); }
      posRef.current = { x: Math.max(4, 12), y: Math.max(4, Math.min(12, r.height - sizeRef.current - 20)) };
    }
    clampPos(sizeRef.current);
  };
  const draw = () => {
    const cv = cvRef.current, src = srcRef.current;
    if (!cv || !src) return;
    ensurePos();
    const sz = sizeRef.current;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(sz * dpr)) { cv.width = Math.round(sz * dpr); cv.height = Math.round(sz * dpr); }
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, sz, sz);
    ctx.fillStyle = "#14151a"; ctx.fillRect(0, 0, sz, sz);
    const fit = Math.min(sz / img.w, sz / img.h);
    const sc = fit >= 1 ? Math.max(1, Math.floor(fit)) : fit;
    const w = img.w * sc, h = img.h * sc;
    ctx.imageSmoothingEnabled = sc < 1;
    if (sc < 1) ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, (sz - w) / 2, (sz - h) / 2, w, h);
  };
  // decode the imported pixels into an offscreen source once
  useEffect(() => {
    const c = document.createElement("canvas");
    c.width = img.w; c.height = img.h;
    const id = new ImageData(img.w, img.h);
    id.data.set(img.px);
    c.getContext("2d")!.putImageData(id, 0, 0);
    srcRef.current = c;
    ensurePos();
    const t = window.setTimeout(() => draw(), 0);
    const onResize = () => { ensurePos(); clampPos(sizeRef.current); draw(); };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => { window.clearTimeout(t); window.removeEventListener("resize", onResize); window.removeEventListener("orientationchange", onResize); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img]);
  useEffect(() => { const t = window.setTimeout(() => draw(), 0); return () => window.clearTimeout(t); }, [pos, size]);

  return (
    <div className="prevbox" ref={boxRef} style={{ left: pos ? pos.x : 12, top: pos ? pos.y : 12, width: s, height: s, padding: 0 }}>
      <canvas ref={cvRef} style={{ width: s, height: s, display: "block" }} />
      <div className="prev-grab"
        onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ } const p = posRef.current ?? { x: 12, y: 12 }; grabStart.current = { px: e.clientX, py: e.clientY, lx: p.x, ly: p.y }; }}
        onPointerMove={(e) => { const g = grabStart.current; if (!g) return; const p = { x: g.lx + (e.clientX - g.px), y: g.ly + (e.clientY - g.py) }; posRef.current = p; setPos(p); clampPos(sizeRef.current); }}
        onPointerUp={(e) => { try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ } grabStart.current = null; }}
        onPointerCancel={() => { grabStart.current = null; }}
      />
      <button className="ref-x" title="close" onClick={onClose}><Icon id="i-x" size={13} /></button>
      <div className="prev-resize"
        onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ } rzStart.current = { px: e.clientX, py: e.clientY, size: sizeRef.current }; }}
        onPointerMove={(e) => { const rz = rzStart.current; if (!rz) return; const r = parentRect(); const delta = Math.max(e.clientX - rz.px, e.clientY - rz.py); const ns = Math.max(90, Math.min(Math.min(r.width - 20, r.height - 30, 380), rz.size + delta)); sizeRef.current = ns; setSize(ns); try { localStorage.setItem("pc.ref.size", String(Math.round(ns))); } catch { /* ignore */ } clampPos(ns); }}
        onPointerUp={(e) => { try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ } rzStart.current = null; }}
        onPointerCancel={() => { rzStart.current = null; }}
      />
    </div>
  );
}