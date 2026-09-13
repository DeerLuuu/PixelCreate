/** Shared tab strip + dropdown, used by the palette panel, the export dialog
 *  and the release-notes dialog so all three look and behave the same.
 *
 *  The dropdown list is rendered through a **portal** with fixed positioning: a
 *  plain absolute box would be clipped by any scrolling ancestor, and the
 *  timeline toolbar (`.ase-tlbar .tlctrl`) is exactly that — `overflow-x:auto`
 *  clips on BOTH axes, so the playback-speed menu opened, was measured fine, and
 *  yet never appeared on screen (真机反馈「点了没反应」).
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface TabItem<T extends string> {
  id: T;
  label: string;
  /** small dim text after the label (e.g. a release date) */
  badge?: string;
  /** optional data-guide anchor for the onboarding tour */
  guide?: string;
}

/** A horizontally scrollable tab strip with an optional control on the right. */
export function TabBar<T extends string>({ items, value, onChange, right, className }: {
  items: Array<TabItem<T>>;
  value: T;
  onChange: (v: T) => void;
  /** rendered at the right end of the same row (sort menu, count, …) */
  right?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={"tabbar" + (className ? " " + className : "")}>
      <div className="tabbar-tabs">
        {items.map((it) => (
          <button
            key={it.id}
            type="button"
            data-guide={it.guide}
            className={"tabbar-tab" + (value === it.id ? " on" : "")}
            onClick={() => onChange(it.id)}
          >
            {it.label}
            {it.badge ? <i className="tabbar-badge">{it.badge}</i> : null}
          </button>
        ))}
      </div>
      {right ? <div className="tabbar-right">{right}</div> : null}
    </div>
  );
}

export interface DropOption<T extends string> {
  id: T;
  label: string;
}

/** Compact "expandable" selector: a chip that opens a small option list. */
export function DropMenu<T extends string>({ label, title, value, options, onPick, guide }: {
  label: string;
  title?: string;
  value: T;
  options: Array<DropOption<T>>;
  onPick: (v: T) => void;
  guide?: string;
}) {
  const [open, setOpen] = useState(false);
  // the list is portaled, so it needs the anchor box in viewport coordinates
  const [box, setBox] = useState<{ left: number; right: number; top: number; bottom: number; minWidth: number } | null>(null);
  // flip the list upwards when there is not enough room below (a bottom toolbar
  // would otherwise push it off screen)
  const [up, setUp] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const measure = () => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const need = Math.min(240, options.length * 38 + 10);
    setUp(below < need && r.top > below);
    setBox({ left: r.left, right: window.innerWidth - r.right, top: r.bottom + 4, bottom: window.innerHeight - r.top + 4, minWidth: Math.max(132, r.width) });
  };
  const toggle = () => {
    const next = !open;
    if (next) measure();
    setOpen(next);
  };
  // 跟着窗口变化重算（横竖屏切换 / 键盘弹起后按钮会移动）
  useLayoutEffect(() => {
    if (!open) return;
    const onMove = () => measure();
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  });
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <div className={"dropmenu" + (up ? " up" : "")}>
      <button
        ref={btnRef}
        type="button"
        className={"dropmenu-btn" + (open ? " on" : "")}
        title={title}
        data-guide={guide}
        onClick={toggle}
      >
        {label}
        <i className="dropmenu-chev">▾</i>
      </button>
      {open && box && createPortal(
        <>
          <div className="dropmenu-back" onClick={() => setOpen(false)} />
          <div
            className={"dropmenu-list dropmenu-pop" + (up ? " up" : "")}
            style={{ left: box.left, right: box.right, minWidth: box.minWidth, top: up ? "auto" : box.top, bottom: up ? box.bottom : "auto" }}
          >
            {options.map((o) => (
              <button
                key={o.id}
                type="button"
                className={"dropmenu-item" + (value === o.id ? " on" : "")}
                onClick={() => { setOpen(false); onPick(o.id); }}
              >
                {o.label}
              </button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}
