// Hold-to-adjust buttons + long-press quick color wheel
import React, { useRef, useState } from "react";
import { SESSION } from "./singleton";
import { showTip, hideTip } from "./tooltip";
import type { RGBA } from "../engine/types";
import { chipCss } from "../engine/color";

export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

export function rgbToHsv(c: RGBA): [number, number, number] {
  const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  const s = max === 0 ? 0 : d / max;
  return [h, s, max];
}

/** Press-hold shows a floating progress bar; slide left/right to change value. */
export function HoldAdjust({
  value, min, max, title, format, onChange, dir = "h", hint, fixedBottom, onEnd,
}: {
  value: number;
  min: number;
  max: number;
  title: string;
  format: (v: number) => string;
  onChange: (v: number) => void;
  dir?: "h" | "v";
  hint?: string;
  /** show the drag bar fixed at the bottom-centre instead of next to the button */
  fixedBottom?: boolean;
  /** called when the drag gesture ends (commit / coalesce history) */
  onEnd?: () => void;
}) {
  const tipT = useRef<number | null>(null);
  const tipOrigin = useRef<number>(0);
  const clearHoldTip = () => {
    if (tipT.current !== null) { window.clearTimeout(tipT.current); tipT.current = null; }
    hideTip();
  };
  const [bar, setBar] = useState<{ rect: DOMRect; cur: number; start: number } | null>(null);
  const [cur, setCur] = useState(value);
  const startPos = useRef(0);
  const axis = dir === "v" ? "y" : "x";
  const posOf = (p: PointerEvent | React.PointerEvent<HTMLButtonElement>) => (axis === "y" ? p.clientY : p.clientX);
  const factor = dir === "v" ? -1 : 1; // vertical: drag up = increase

  const down = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    startPos.current = posOf(e);
    setCur(value);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setBar({ rect, cur: value, start: posOf(e) });
    // stationary long hold -> global tooltip (shown only when not dragging)
    if (hint || title) {
      tipOrigin.current = posOf(e);
      tipT.current = window.setTimeout(() => {
        tipT.current = null;
        showTip({ title, desc: hint });
      }, 450);
    }
    const onMove = (ev: PointerEvent) => {
      if (tipT.current !== null && Math.abs(posOf(ev) - tipOrigin.current) > 3) clearHoldTip();
      const step = (max - min) / 180;
      const delta = posOf(ev) - (bar ? bar.start : startPos.current);
      const nv = Math.max(min, Math.min(max, Math.round((bar ? bar.cur : value) + factor * delta * step)));
      setCur(nv);
      onChange(nv);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      setBar(null);
      onEnd?.();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  return (
    <>
      <button className="holdbtn" title={title} onPointerDown={down}>
        <span className="hb-text">{format(value)}</span>
      </button>
      {bar && dir === "v" && (() => {
        // swap ON  -> control rail on the right -> pop sits 20px to the LEFT of the button
        // swap OFF -> control rail on the left  -> pop sits 20px to the RIGHT of the button
        const swap = SESSION.prefs.railSwap;
        const top = Math.max(4, bar.rect.top + bar.rect.height / 2 - 92);
        const styleV = swap
          ? { right: Math.max(4, window.innerWidth - bar.rect.left + 20), top }
          : { left: bar.rect.right + 20, top };
        return (
        <div
          className="holdpop v"
          style={styleV}
        >
            <span className="hp-label">{format(cur)}</span>
            <div className="hp-track">
              <div className="hp-fill" style={{ height: ((cur - min) / (max - min)) * 100 + "%" }} />
            </div>
          </div>
        );
      })()}
      {bar && dir !== "v" && (
        <div className={"holdpop" + (fixedBottom ? " holdpop-fixed" : "")} style={fixedBottom ? undefined : { left: bar.rect.left, top: bar.rect.top - 44 }}>
          <span className="hp-label">{format(cur)}</span>
          <div className="hp-track">
            <div className="hp-fill" style={{ width: ((cur - min) / (max - min)) * 100 + "%" }} />
          </div>
        </div>
      )}
    </>
  );
}

/** Long-press color chip opens a floating small disk; dragging anywhere adjusts hue/sat/value. */

export function ColorHoldChip({ onClickTap }: { onClickTap: () => void }) {
  const [open, setOpen] = useState(false);
  const originRef = useRef<{ x: number; y: number; size: number } | null>(null);
  const activeRef = useRef(false);
  const timer = useRef<number | null>(null);

  const doMove = (ev: PointerEvent) => {
    const o = originRef.current;
    if (!o) return;
    const [h, s, v] = rgbToHsv(SESSION.color);
    const dcx = o.x + o.size / 2;
    const dcy = o.y + o.size / 2;
    const barX0 = o.x + o.size + 8;
    if (ev.clientX >= barX0 - 6 && ev.clientX <= barX0 + 22 && ev.clientY >= o.y - 8 && ev.clientY <= o.y + o.size + 8) {
      const vv = 1 - Math.max(0, Math.min(1, (ev.clientY - o.y) / o.size));
      const [rr, gg, bb] = hsvToRgb(h, s, vv);
      SESSION.setColor([rr, gg, bb, 255]);
      return;
    }
    const dx = ev.clientX - dcx;
    const dy = ev.clientY - dcy;
    const hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 90 + 360) % 360;
    const sat = Math.min(1, Math.hypot(dx, dy) / (o.size / 2));
    const [rr, gg, bb] = hsvToRgb(hue, sat, v);
    SESSION.setColor([rr, gg, bb, 255]);
  };
  const doUp = () => {
    activeRef.current = false;
    window.removeEventListener("pointermove", doMove);
    window.removeEventListener("pointerup", doUp);
    window.removeEventListener("pointercancel", doUp);
    setOpen(false);
    originRef.current = null;
    SESSION.setColorPicking(false);
  };

  const start = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    if (timer.current) window.clearTimeout(timer.current);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const size = 170;
    const x = Math.max(6, Math.min(window.innerWidth - size - 16 - 26, rect.left + rect.width / 2 - (size + 24) / 2));
    const y = Math.max(6, rect.top - size - 16);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      originRef.current = { x, y, size };
      activeRef.current = true;
      SESSION.setColorPicking(true);
      setOpen(true);
      window.addEventListener("pointermove", doMove);
      window.addEventListener("pointerup", doUp);
      window.addEventListener("pointercancel", doUp);
    }, 330);
  };

  const c = SESSION.color;
  const [hq, , vq] = rgbToHsv(c);
  const top = hsvToRgb(hq, 1, 1);
  const o = originRef.current;
  return (
    <>
      <button
        className="colorchip"
        style={{ background: chipCss(c) }}
        title="hold for quick color · tap for palette"
        onPointerDown={start}
        onPointerUp={() => {
          if (timer.current) {
            window.clearTimeout(timer.current);
            timer.current = null;
            onClickTap();
          }
        }}
        onPointerCancel={() => {
          if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
        }}
      />
      {open && o && (
        <div
          className="quickwheel"
          style={{ left: o.x, top: o.y, width: o.size + 24, height: o.size }}
        >
          <QuickDisk size={o.size} color={c.slice() as RGBA} />
          <div
            className="qvbar"
            style={{
              width: 16,
              height: o.size,
              background: "linear-gradient(to bottom, rgb(" + top.join(",") + "), #000)",
              ["--vpos" as never]: vq,
            }}
          />
        </div>
      )}
    </>
  );
}

function QuickDisk({ size, color }: { size: number; color: RGBA }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  React.useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const N = Math.round(size * dpr);
    cv.width = N;
    cv.height = N;
    const ctx = cv.getContext("2d")!;
    const cx = N / 2, cy = N / 2, R = N / 2 - 1;
    const img = ctx.createImageData(N, N);
    for (let py = 0; py < N; py++) {
      for (let px = 0; px < N; px++) {
        const dx = px + 0.5 - cx, dy = py + 0.5 - cy;
        const dist = Math.hypot(dx, dy);
        if (dist > R) continue;
        const hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 90 + 360) % 360;
        const sat = Math.min(1, dist / R);
        const [rr, gg, bb] = hsvToRgb(hue, sat, 1);
        const i = (py * N + px) * 4;
        img.data[i] = rr; img.data[i + 1] = gg; img.data[i + 2] = bb; img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    // marker
    const [h, s] = rgbToHsv(color);
    const ang = ((h - 90) * Math.PI) / 180;
    const mr = Math.max(3, s * (size / 2));
    const mx = size / 2 + Math.cos(ang) * mr;
    const my = size / 2 + Math.sin(ang) * mr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.beginPath();
    ctx.arc(mx, my, 6, 0, Math.PI * 2);
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(mx, my, 6, 0, Math.PI * 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(0,0,0,.6)";
    ctx.stroke();
  }, [size, color]);
  return <canvas ref={ref} style={{ width: size, height: size, borderRadius: "50%" }} />;
}
