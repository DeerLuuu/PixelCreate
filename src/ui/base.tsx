import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { SESSION } from "./singleton";
import type { Snapshot } from "../app/session";
import { showTip, hideTip, subscribeTip } from "./tooltip";
export function useSession(): Snapshot {
  return useSyncExternalStore(
    (cb) => SESSION.subscribe(cb),
    () => SESSION.snapshot(),
    () => SESSION.snapshot()
  );
}

/** true whenever landscape: side-rail layout is used on every device */
export function useLandscape(): boolean {
  const mq = "(orientation: landscape)";
  const [land, setLand] = useState(() => (typeof window === "undefined" ? false : window.matchMedia(mq).matches));
  useEffect(() => {
    const m = window.matchMedia(mq);
    const fn = () => setLand(m.matches);
    m.addEventListener("change", fn);
    return () => m.removeEventListener("change", fn);
  }, []);
  return land;
}

export function Icon({ id, size = 20 }: { id: string; size?: number }) {
  return (
    <svg width={size} height={size} aria-hidden>
      <use href={"#" + id} />
    </svg>
  );
}

export function Btn({
  icon, label, onClick, active, danger, title, desc, className = "", noTip, guide,
}: {
  icon?: string; label?: string; onClick: () => void; active?: boolean; danger?: boolean; title?: string; desc?: string; className?: string; noTip?: boolean;
  /** anchor id for the onboarding guide (rendered as data-guide) */
  guide?: string;
}) {
  const cls = ["btn"];
  if (active) cls.push("active");
  if (danger) cls.push("danger");
  if (className) cls.push(className);
  const tipTitle = title ?? label ?? "";
  const tipTimer = useRef<number | null>(null);
  const tipOrigin = useRef<{ x: number; y: number } | null>(null);
  const clearTip = () => {
    if (tipTimer.current !== null) { window.clearTimeout(tipTimer.current); tipTimer.current = null; }
    tipOrigin.current = null;
    hideTip();
  };
  const startTip = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (noTip || (!tipTitle && !desc)) return;
    e.preventDefault(); // keep the browser's own long-press menus from appearing
    tipOrigin.current = { x: e.clientX, y: e.clientY };
    tipTimer.current = window.setTimeout(() => {
      tipTimer.current = null;
      showTip({ title: tipTitle, desc });
    }, 450);
  };
  const guardMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!tipTimer.current) return;
    const o = tipOrigin.current;
    if (o && (Math.abs(e.clientX - o.x) > 10 || Math.abs(e.clientY - o.y) > 14)) clearTip();
  };
  return (
    <>
      <button
        type="button"
        className={cls.join(" ")}
        data-guide={guide}
        onClick={onClick}
        title={tipTitle}
        aria-label={tipTitle}
        onPointerDown={startTip}
        onPointerMove={guardMove}
        onPointerUp={clearTip}
        onPointerCancel={clearTip}
        onPointerLeave={clearTip}
        onContextMenu={(e) => e.preventDefault()}
      >
        {icon && <Icon id={icon} />}
        {label && <span>{label}</span>}
      </button>
    </>
  );
}

/** one shared tooltip host: fixed at bottom-centre of the screen */
export function TipHost() {
  const [tip, setTip] = useState<{ title: string; desc?: string } | null>(null);
  useEffect(() => subscribeTip((t) => setTip(t)), []);
  if (!tip) return null;
  return (
    <div className="tip-host">
      <div className="th-title">{tip.title}</div>
      {tip.desc ? <div className="th-desc">{tip.desc}</div> : null}
    </div>
  );
}
export function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (<><div className="panel-mask" onClick={onClose} /><section className="panel">{children}</section></>);
}
/**
 * Delayed-unmount wrapper: keeps the last shown subtree mounted for ms
 * after `on` turns false and flags the wrapper .out, so CSS exit
 * animations can run before the node is removed. Entrance animations
 * run on mount automatically.
 */
export function Keep({ on, el, ms = 200 }: { on: boolean; el: React.ReactNode; ms?: number }) {
  const [alive, setAlive] = useState(on);
  const [out, setOut] = useState(false);
  const cached = useRef<React.ReactNode | null>(null);
  const prev = useRef(on);
  const aliveRef = useRef(on);
  aliveRef.current = alive;
  if (on) cached.current = el;
  useEffect(() => {
    if (on === prev.current) return;
    prev.current = on;
    if (on) {
      setAlive(true);
      setOut(false);
      return;
    }
    if (!aliveRef.current) return;
    setOut(true);
    const t = window.setTimeout(() => { setAlive(false); setOut(false); }, ms);
    return () => window.clearTimeout(t);
  }, [on, ms]);
  if (!alive) return null;
  return <div className={"keep" + (out ? " out" : "")}>{on ? el : cached.current}</div>;
}


/** Tap the empty area of a container itself (not its children) to run an
 *  action. Scrolls and long presses are ignored so dragging inside a list
 *  never closes it by accident. */
export function useBlankTap(onTap: () => void, moveTol = 8): {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
} {
  const down = useRef<{ x: number; y: number; t: number } | null>(null);
  return {
    onPointerDown: (e: React.PointerEvent) => {
      down.current = { x: e.clientX, y: e.clientY, t: Date.now() };
    },
    onPointerUp: (e: React.PointerEvent) => {
      const d = down.current;
      down.current = null;
      if (!d) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > moveTol) return;
      if (Date.now() - d.t > 700) return;
      if (e.target === e.currentTarget) onTap();
    },
  };
}

/**
 * Numeric input with a scrub gesture: long-press (no typing) then slide
 * up/down or left/right to change the value. The per-step magnitude is
 * derived from the bounds ((max-min)/100, minimum 1) or defaults to 1 when a
 * bound is missing.
 */
export function ScrubNum({
  value, onChange, min, max, step, title, placeholder, style,
}: {
  value: string | number;
  onChange: (v: string) => void;
  min?: number;
  max?: number;
  step?: number;
  title?: string;
  placeholder?: string;
  style?: React.CSSProperties;
}) {
  const elRef = useRef<HTMLInputElement | null>(null);
  const armT = useRef<number | null>(null);
  const anchor = useRef<{ x: number; y: number; n: number } | null>(null);
  const unit = step != null ? step : (min != null && max != null ? Math.max(1, Math.round((max - min) / 100)) : 1);
  const numeric = () => { const n = parseFloat(String(value)); return Number.isFinite(n) ? n : (min ?? 0); };
  const clampN = (n: number) => { if (min != null) n = Math.max(min, n); if (max != null) n = Math.min(max, n); return n; };
  const end = () => {
    if (armT.current !== null) { window.clearTimeout(armT.current); armT.current = null; }
    anchor.current = null;
    window.removeEventListener("pointermove", mv);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
  };
  const mv = (ev: PointerEvent) => {
    const a = anchor.current;
    if (!a) return;
    const dx = ev.clientX - a.x;
    const dy = ev.clientY - a.y;
    const d = Math.abs(dy) > Math.abs(dx) ? -dy : dx; // drag up or right increases
    onChange(String(Math.round(clampN(a.n + (d / 3) * unit))));
  };
  const down = (e: React.PointerEvent<HTMLInputElement>) => {
    const el = e.currentTarget;
    armT.current = window.setTimeout(() => {
      armT.current = null;
      try { el.blur(); } catch { /* ignore */ }
      anchor.current = { x: e.clientX, y: e.clientY, n: numeric() };
      window.addEventListener("pointermove", mv);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    }, 380);
  };
  const clearT = () => { if (armT.current !== null) { window.clearTimeout(armT.current); armT.current = null; } };
  return (
    <input
      ref={elRef}
      type="number"
      inputMode="decimal"
      value={String(value)}
      title={title}
      placeholder={placeholder}
      style={style}
      onChange={(e) => onChange(e.target.value)}
      onPointerDown={down}
      onPointerUp={clearT}
      onPointerCancel={clearT}
    />
  );
}
