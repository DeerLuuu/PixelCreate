import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { SESSION } from "./singleton";
import type { Snapshot } from "../app/session";
import { showTip, hideTip, subscribeTip } from "./tooltip";
import type { ReactNode } from "react";
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
  icon, label, onClick, active, danger, title, desc, className = "", noTip,
}: {
  icon?: string; label?: string; onClick: () => void; active?: boolean; danger?: boolean; title?: string; desc?: string; className?: string; noTip?: boolean;
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
