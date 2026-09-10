// HoverTip — a mouse-following tooltip panel for PC sessions.
//
// Behaviour asked for on desktop: the panel appears IMMEDIATELY (no delay) next
// to the cursor and disappears the moment the pointer leaves the control. Touch
// keeps the existing long-press tip (src/ui/tooltip.ts) — a finger has no hover.
//
// The kit must stay free of app imports (docs/UI.md §1.1), so the PC flag is
// pushed in from the app layer: main.tsx calls setHoverTipsEnabled() whenever
// pcmode.ts re-resolves the mode.
import React, { useEffect, useState } from "react";
import { useKitPcMode } from "./pcmode";

// PC 开关见 ./pcmode（kit 自有的最小状态，由应用层写入）
export { setKitPcMode, kitPcOn, useKitPcMode } from "./pcmode";
/** 兼容旧名（内部只关心「现在是 PC 吗」） */
export { setKitPcMode as setHoverTipsEnabled, kitPcOn as hoverTipsEnabled, useKitPcMode as useHoverTipsEnabled } from "./pcmode";

// ------------------------------------------------------------- positioning
export interface TipPoint { x: number; y: number }

/**
 * Panel position for a cursor at (x,y): below-right of the pointer, flipped to
 * the other side when it would leave the viewport and always clamped inside it.
 * Pure and unit tested.
 */
export function hoverTipPos(
  x: number, y: number, w: number, h: number, vw: number, vh: number,
  gap = 14, edge = 6,
): TipPoint {
  let left = x + gap;
  if (left + w > vw - edge) left = x - gap - w;
  let top = y + gap;
  if (top + h > vh - edge) top = y - gap - h;
  return {
    x: Math.max(edge, Math.min(left, Math.max(edge, vw - w - edge))),
    y: Math.max(edge, Math.min(top, Math.max(edge, vh - h - edge))),
  };
}

/** rough panel size for the clamp (the real box is measured after mount) */
const EST_W = 240;
const EST_H = 64;

export interface HoverTipProps {
  title: string;
  desc?: string;
  x: number;
  y: number;
  /** measured size override (used by the live hook) */
  w?: number;
  h?: number;
}

export function HoverTip({ title, desc, x, y, w = EST_W, h = EST_H }: HoverTipProps) {
  const vw = typeof window === "undefined" ? 1024 : window.innerWidth;
  const vh = typeof window === "undefined" ? 768 : window.innerHeight;
  const p = hoverTipPos(x, y, w, h, vw, vh);
  return (
    <div className="htip" role="tooltip" style={{ left: p.x, top: p.y }}>
      <div className="htip-title">{title}</div>
      {desc ? <div className="htip-desc">{desc}</div> : null}
    </div>
  );
}

// -------------------------------------------------------------------- hook
export interface HoverTipApi {
  onPointerEnter: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerLeave: () => void;
  node: React.ReactNode;
}

/**
 * Wire a control's hover tooltip. Only mouse pointers trigger it, only in PC
 * mode, and only when there is something to say.
 */
export function useHoverTip(opts: { title?: string; desc?: string; enabled?: boolean }): HoverTipApi {
  const pc = useKitPcMode();
  const [pt, setPt] = useState<TipPoint | null>(null);
  const usable = (opts.enabled ?? true) && pc && !!(opts.title || opts.desc);
  // leaving PC mode while a tip is up must close it right away
  useEffect(() => { if (!usable) setPt(null); }, [usable]);
  const keep = (e: React.PointerEvent): boolean => e.pointerType === "mouse" && usable;
  return {
    onPointerEnter: (e) => { if (keep(e)) setPt({ x: e.clientX, y: e.clientY }); },
    onPointerMove: (e) => { if (keep(e)) setPt({ x: e.clientX, y: e.clientY }); },
    onPointerLeave: () => setPt(null),
    node: pt ? <HoverTip title={opts.title ?? ""} desc={opts.desc} x={pt.x} y={pt.y} /> : null,
  };
}
