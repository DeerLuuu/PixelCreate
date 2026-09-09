import React, { useEffect, useRef, useState } from "react";
import { SESSION } from "./singleton";
import { makeT } from "./i18n";
import type { Lang } from "./i18n";
import * as bridge from "../io/bridge";
import { Icon } from "./base";

import type { RefImg } from "../io/refstore";
export type { RefImg };

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
    const n = SESSION.refBox.size;
    return n >= 90 && n <= 380 ? n : 148;
  });
  const [opacity, setOpacity] = useState(() => Math.max(10, Math.min(100, SESSION.refBox.opacity || 100)));
  const sizeRef = useRef(size);
  const s = size;
  const [picking, setPicking] = useState(false);
  const pickingRef = useRef(false);
  const scanRef = useRef(false);
  const lastSamp = useRef(-1);
  const tp = makeT(SESSION.prefs.lang as Lang);

  /** sample the ORIGINAL source pixel under the pointer (exact, incl. alpha) */
  const sampleAt = (e: React.PointerEvent<HTMLDivElement>) => {
    const cv = cvRef.current;
    if (!cv) return;
    const r = cv.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const sz = sizeRef.current;
    const fit = Math.min(sz / img.w, sz / img.h);
    const sc = fit >= 1 ? Math.max(1, Math.floor(fit)) : fit;
    const w = img.w * sc, h = img.h * sc;
    const ox = (sz - w) / 2, oy = (sz - h) / 2;
    if (mx < ox || my < oy || mx >= ox + w || my >= oy + h) return;
    const sx = Math.min(img.w - 1, Math.max(0, Math.floor((mx - ox) / sc)));
    const sy = Math.min(img.h - 1, Math.max(0, Math.floor((my - oy) / sc)));
    const li = (sy * img.w + sx) * 4;
    if (li === lastSamp.current) return;
    lastSamp.current = li;
    SESSION.setFgColor([img.px[li], img.px[li + 1], img.px[li + 2], img.px[li + 3]]);
    try { SESSION.hapticTick("参考图", 0.5); } catch { /* ignore */ }
  };
  const togglePick = () => {
    const nv = !pickingRef.current;
    pickingRef.current = nv;
    setPicking(nv);
    if (nv) bridge.toast(tp("refPickHint"));
  };

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
      // the remembered position wins; fall back to the top-left corner
      const rx = SESSION.refBox.x, ry = SESSION.refBox.y;
      posRef.current = { x: Math.max(4, rx || 12), y: Math.max(4, ry || 12) };
    }
    clampPos(sizeRef.current);
  };
  /** remember the window geometry (debounced inside the session) */
  const remember = (p?: { x: number; y: number }, sz?: number, op?: number) => {
    SESSION.setRefBox({
      ...(p ? { x: Math.round(p.x), y: Math.round(p.y) } : {}),
      ...(sz ? { size: Math.round(sz) } : {}),
      ...(op !== undefined ? { opacity: Math.round(op) } : {}),
    });
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
    ctx.globalAlpha = Math.max(0.1, Math.min(1, opacity / 100));
    ctx.drawImage(src, (sz - w) / 2, (sz - h) / 2, w, h);
    ctx.globalAlpha = 1;
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
  useEffect(() => { const t = window.setTimeout(() => draw(), 0); return () => window.clearTimeout(t); }, [pos, size, opacity]);

  return (
    <div className={"prevbox" + (picking ? " picking" : "")} ref={boxRef} style={{ left: pos ? pos.x : 12, top: pos ? pos.y : 12, width: s, height: s, padding: 0 }}>
      <canvas ref={cvRef} style={{ width: s, height: s, display: "block" }} />
      <div className="prev-grab"
        onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
          if (pickingRef.current) { scanRef.current = true; lastSamp.current = -1; sampleAt(e); }
          else { const p = posRef.current ?? { x: 12, y: 12 }; grabStart.current = { px: e.clientX, py: e.clientY, lx: p.x, ly: p.y }; } }}
        onPointerMove={(e) => { if (scanRef.current) { sampleAt(e); return; } const g = grabStart.current; if (!g) return; const p = { x: g.lx + (e.clientX - g.px), y: g.ly + (e.clientY - g.py) }; posRef.current = p; setPos(p); clampPos(sizeRef.current); remember(p); }}
        onPointerUp={(e) => { try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ } if (scanRef.current) { scanRef.current = false; return; } grabStart.current = null; }}
        onPointerCancel={() => { scanRef.current = false; grabStart.current = null; }}
      />
      <button className="ref-x" title="close" onClick={onClose}><Icon id="i-x" size={13} /></button>
      <button className={"ref-pick" + (picking ? " on" : "")} title={tp("refPickTitle")} aria-label={tp("refPickTitle")} onClick={togglePick}><Icon id="i-picker" size={13} /></button>
      <input className="ref-op" type="range" min={10} max={100} step={5} value={opacity} title={tp("refOpacity")}
        onChange={(e) => { const v = Number(e.target.value) || 100; setOpacity(v); remember(undefined, undefined, v); }} />
      <div className="prev-resize"
        onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ } rzStart.current = { px: e.clientX, py: e.clientY, size: sizeRef.current }; }}
        onPointerMove={(e) => { const rz = rzStart.current; if (!rz) return; const r = parentRect(); const delta = Math.max(e.clientX - rz.px, e.clientY - rz.py); const ns = Math.max(90, Math.min(Math.min(r.width - 20, r.height - 30, 380), rz.size + delta)); sizeRef.current = ns; setSize(ns); clampPos(ns); remember(undefined, ns); }}
        onPointerUp={(e) => { try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ } rzStart.current = null; }}
        onPointerCancel={() => { rzStart.current = null; }}
      />
    </div>
  );
}