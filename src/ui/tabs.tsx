// Shared tab strip + dropdown, used by the palette panel, the export dialog
// and the release-notes dialog so all three look and behave the same.
import { useRef, useState } from "react";

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
  // flip the list upwards when there is not enough room below (it would be
  // clipped by the dialog body / the bottom of the screen)
  const [up, setUp] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const toggle = () => {
    const next = !open;
    if (next && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const below = window.innerHeight - r.bottom;
      const need = Math.min(240, options.length * 38 + 10);
      setUp(below < need && r.top > below);
    }
    setOpen(next);
  };
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
      {open && (
        <>
          <div className="dropmenu-back" onClick={() => setOpen(false)} />
          <div className="dropmenu-list">
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
        </>
      )}
    </div>
  );
}
