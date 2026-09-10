// Hold-to-adjust buttons + long-press quick color wheel
import React, { useEffect, useRef, useState } from "react";
import { SESSION } from "./singleton";
import { DRAG_START, holdAllowed, leftRect, useColorDragFill, type RectBox } from "./color-drag";
import { makeT } from "./i18n";
import type { Lang } from "./i18n";
import { showTip, hideTip } from "./tooltip";
import type { RGBA } from "../engine/types";
import { chipCss } from "../engine/color";
import { isPc } from "../io/pcmode";
import { takeNotches, wheelNotches } from "../engine/scrub";

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
  value, min, max, title, format, onChange, dir = "h", hint, fixedBottom, onEnd, reset,
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
  /** quick DOUBLE-TAP resets the value to this default */
  reset?: number;
}) {
  const wheelRef = useRef<HTMLButtonElement | null>(null);
  /** 滚轮累计（一个滚轮格会被浏览器拆成几十个事件，必须按格累计） */
  const wheelAcc = useRef(0);
  /** 同一帧内连续事件用的最新值（props 的 value 要等重渲染才更新） */
  const wheelVal = useRef<number | null>(null);
  /** ⑦ PC：鼠标悬停在长按按钮上滚动滚轮＝调值（原生监听，才能 preventDefault） */
  useEffect(() => {
    const el = wheelRef.current;
    if (!el) return;
    wheelVal.current = null;   // props 变了：以 props 为准
    const onWheel = (e: WheelEvent) => {
      if (!isPc()) return;
      e.preventDefault();
      e.stopPropagation();
      const { steps, rest } = takeNotches(wheelAcc.current + wheelNotches(e.deltaY, e.deltaMode));
      wheelAcc.current = rest;
      if (!steps) return;
      const span = max - min;
      const step = span > 200 ? 5 : span > 50 ? 2 : 1;
      const cur = wheelVal.current ?? value;
      const next = Math.max(min, Math.min(max, cur - steps * step));
      if (next !== cur) { wheelVal.current = next; onChange(next); }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [min, max, value, onChange]);
  const tipT = useRef<number | null>(null);
  const tipOrigin = useRef<number>(0);
  const clearHoldTip = () => {
    if (tipT.current !== null) { window.clearTimeout(tipT.current); tipT.current = null; }
    hideTip();
  };
  const [bar, setBar] = useState<{ rect: DOMRect; cur: number; start: number } | null>(null);
  const [cur, setCur] = useState(value);
  // keep the label in sync with external value changes while no drag is active
  useEffect(() => { if (!bar) setCur(value); }, [value, bar]);
  const startPos = useRef(0);
  const dnT = useRef(0);
  const dnXY = useRef({ x: 0, y: 0 });
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  const axis = dir === "v" ? "y" : "x";
  const posOf = (p: PointerEvent | React.PointerEvent<HTMLButtonElement>) => (axis === "y" ? p.clientY : p.clientX);
  const factor = dir === "v" ? -1 : 1; // vertical: drag up = increase

  const down = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    dnT.current = Date.now();
    dnXY.current = { x: e.clientX, y: e.clientY };
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
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      setBar(null);
      onEnd?.();
      // quick double-tap (no drag) snaps the value back to the default
      if (reset !== undefined && Date.now() - dnT.current < 350 &&
          Math.hypot(ev.clientX - dnXY.current.x, ev.clientY - dnXY.current.y) < 8) {
        const lt = lastTap.current;
        if (lt && Date.now() - lt.t < 330 &&
            Math.hypot(ev.clientX - lt.x, ev.clientY - lt.y) < 26) {
          lastTap.current = null;
          setCur(reset);
          onChange(reset);
        } else {
          lastTap.current = { t: Date.now(), x: ev.clientX, y: ev.clientY };
        }
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  return (
    <>
      <button ref={wheelRef} className="holdbtn" title={title} onPointerDown={down}>
        <span className="hb-text">{format(cur)}</span>
      </button>
      {bar && dir === "v" && (() => {
        // swap ON  -> control rail on the right -> pop sits 20px to the LEFT of the button
        // swap OFF -> control rail on the left  -> pop sits 20px to the RIGHT of the button
        const swap = SESSION.prefs.railSwap;
        // keep the vertical popup fully visible: clamp it inside the viewport
        const popW = window.innerWidth < window.innerHeight ? 150 : 92;
        const popH = window.innerWidth < window.innerHeight ? 214 : 200;
        const top = Math.max(4, Math.min(Math.max(4, window.innerHeight - popH - 4), bar.rect.top + bar.rect.height / 2 - 92));
        const styleV = swap
          ? { right: Math.max(4, Math.min(window.innerWidth - popW - 4, window.innerWidth - bar.rect.left + 20)), top }
          : { left: Math.max(4, Math.min(window.innerWidth - popW - 4, bar.rect.right + 20)), top };
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
        <div className={"holdpop" + (fixedBottom ? " holdpop-fixed" : "")} style={fixedBottom ? undefined : (() => {
          const hw = 95; // popup ~190px wide, translated -50%, so clamp its centre point
          const left = Math.max(hw, Math.min(Math.max(hw, window.innerWidth - hw), bar.rect.left));
          const top = Math.max(4, bar.rect.top - 44);
          return { left, top };
        })()}>
          <span className="hp-label">{format(cur)}</span>
          <div className="hp-track">
            <div className="hp-fill" style={{ width: ((cur - min) / (max - min)) * 100 + "%" }} />
          </div>
        </div>
      )}
    </>
  );
}

/** long-press delay of the quick colour wheel (shared with the drag rule) */
export const HOLD_MS = 330;

/** Long-press color chip opens a floating small disk; dragging anywhere adjusts hue/sat/value. */

export function ColorHoldChip({ onClickTap }: { onClickTap: () => void }) {
  const [open, setOpen] = useState(false);
  const originRef = useRef<{ x: number; y: number; size: number } | null>(null);
  const activeRef = useRef(false);
  const timer = useRef<number | null>(null);
  const t = makeT(SESSION.prefs.lang as Lang);
  // move early enough = drag the colour onto a canvas to bucket-fill it there;
  // hold still = the quick colour wheel (the hold may not be stolen by a drag)
  const wheelRef = useRef(false);   // the quick wheel is open and owns the gesture
  const fillDrag = useColorDragFill({
    color: () => SESSION.color,
    holdActive: () => wheelRef.current,
  });
  /** the chip's own box + the last pointer position: a press that wanders off
   *  the button must not open the wheel (that is the drag gesture's job) */
  const boxRef = useRef<RectBox | null>(null);
  const ptRef = useRef<{ x: number; y: number } | null>(null);
  const downRef = useRef<{ x: number; y: number } | null>(null);
  const cancelHold = () => {
    if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
  };
  const offChip = (x: number, y: number): boolean => !!boxRef.current && leftRect(boxRef.current, x, y);
  /** px travelled since the press (0 when there is no press) */
  const travel = (x: number, y: number): number => {
    const d = downRef.current;
    return d ? Math.hypot(x - d.x, y - d.y) : 0;
  };

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
    wheelRef.current = false;
    window.removeEventListener("pointermove", doMove);
    window.removeEventListener("pointerup", doUp);
    window.removeEventListener("pointercancel", doUp);
    setOpen(false);
    originRef.current = null;
    SESSION.setColorPicking(false);
  };

  const start = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    // keep receiving moves/cancel even when the finger leaves the chip
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    fillDrag.begin(e);
    if (timer.current) window.clearTimeout(timer.current);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // remember the button box: leaving it cancels the pending hold
    boxRef.current = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    ptRef.current = { x: e.clientX, y: e.clientY };
    downRef.current = { x: e.clientX, y: e.clientY };
    wheelRef.current = false;
    const size = 170;
    const x = Math.max(6, Math.min(window.innerWidth - size - 16 - 26, rect.left + rect.width / 2 - (size + 24) / 2));
    const y = Math.max(6, rect.top - size - 16);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      // summon the wheel only while this is still a HOLD: a finger that has
      // moved past the drag threshold, or left the button, is filling instead
      const p = ptRef.current;
      if (!holdAllowed(p ? travel(p.x, p.y) : 0, HOLD_MS, HOLD_MS, p ? !offChip(p.x, p.y) : true)) return;
      if (fillDrag.dragging) return;
      originRef.current = { x, y, size };
      activeRef.current = true;
      wheelRef.current = true;
      SESSION.setColorPicking(true);
      setOpen(true);
      window.addEventListener("pointermove", doMove);
      window.addEventListener("pointerup", doUp);
      window.addEventListener("pointercancel", doUp);
    }, HOLD_MS);
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
        title={t("colorChipHint")}
        onPointerDown={start}
        onPointerMove={(e) => {
          ptRef.current = { x: e.clientX, y: e.clientY };
          // the pending hold dies as soon as the finger drags or leaves the
          // button: from then on the gesture is a fill drag, not a wheel
          if (timer.current !== null && (offChip(e.clientX, e.clientY) || travel(e.clientX, e.clientY) >= DRAG_START)) cancelHold();
          fillDrag.move(e);
        }}
        onPointerUp={(e) => {
          // a drag that reached the canvas is handled here; a plain tap opens
          // the palette, and the (cancelled) long press opens the quick wheel
          boxRef.current = null;
          ptRef.current = null;
          downRef.current = null;
          if (fillDrag.end(e)) return;
          if (timer.current) {
            window.clearTimeout(timer.current);
            timer.current = null;
            onClickTap();
          }
        }}
        onPointerCancel={() => {
          boxRef.current = null;
          ptRef.current = null;
          downRef.current = null;
          wheelRef.current = false;
          fillDrag.cancel();
          cancelHold();
        }}
      />
      {fillDrag.ghost}
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
