// Form controls — the declarative rows every dialog/settings panel uses.
//
// All of them are pure layout + callbacks (docs/UI.md §2.2–2.6); the app layer
// supplies translated strings and the Session wiring.
import React from "react";
import { ScrubNum } from "./scrub";
import type { ScrubNumProps } from "./scrub";

export interface RowProps {
  /** small caption above the control (.rowlabel) */
  label?: React.ReactNode;
  /** one-line note under the control (.row-note) */
  hint?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}

/** label → control → note, the standard dialog row */
export function Row({ label, hint, children, className = "" }: RowProps) {
  return (
    <>
      {label ? <label className={"rowlabel" + (className ? " " + className : "")}>{label}</label> : null}
      {children}
      {hint ? <div className="row-note">{hint}</div> : null}
    </>
  );
}

/** a row of buttons under a control (.row-actions) */
export function RowActions({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return <div className={"row-actions" + (className ? " " + className : "")}>{children}</div>;
}

export interface ChipOption<T extends string> {
  id: T;
  label: React.ReactNode;
  /** optional onboarding anchor */
  guide?: string;
  /** render nothing for this entry (conditional options keep the array literal
   *  contextually typed — a call-site .filter() would widen T to string) */
  hidden?: boolean;
}

/** wrapping tag row: one option per value (.chips > .chip) */
export function ChipGroup<T extends string>({ value, options, onChange, className = "" }: {
  value: T;
  /** NoInfer: T comes from `value` alone, so literal option arrays and
   *  state setters (Dispatch<SetStateAction<…>>) both type-check. */
  options: Array<ChipOption<NoInfer<T>>>;
  onChange: (v: NoInfer<T>) => void;
  className?: string;
}) {
  return (
    <div className={"chips" + (className ? " " + className : "")}>
      {options.filter((o) => !o.hidden).map((o) => (
        <button
          key={o.id}
          type="button"
          className={"chip" + (value === o.id ? " on" : "")}
          data-guide={o.guide}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** equal-width segmented switch (.tabs > .tab) — a view switch inside a dialog */
export function Segmented<T extends string>({ value, options, onChange, className = "" }: {
  value: T;
  options: Array<ChipOption<NoInfer<T>>>;
  onChange: (v: NoInfer<T>) => void;
  className?: string;
}) {
  return (
    <div className={"tabs" + (className ? " " + className : "")}>
      {options.filter((o) => !o.hidden).map((o) => (
        <button
          key={o.id}
          type="button"
          className={"tab" + (value === o.id ? " on" : "")}
          data-guide={o.guide}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** boolean toggle (.sw) — used for settings rows instead of an ON/OFF chip */
export function Switch({ checked, onChange, label, disabled }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  /** accessible name (the visible caption lives in the Row) */
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={"sw" + (checked ? " on" : "")}
      onClick={() => onChange(!checked)}
    >
      <i />
    </button>
  );
}

/** Row + ScrubNum: the standard numeric field */
export function NumberField({
  label, hint, padTitle, ...num
}: ScrubNumProps & { label?: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <Row label={label} hint={hint}>
      <ScrubNum {...num} padTitle={padTitle} />
    </Row>
  );
}

/** Row + native colour input + hex readout */
export function ColorField({ label, hint, value, onChange }: {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Row label={label} hint={hint}>
      <div className="set-color">
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
        <span className="set-hex">{value}</span>
      </div>
    </Row>
  );
}
