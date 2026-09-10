// ScrubNum — numeric field with a scrub gesture and an arithmetic pad.
//
// SESSION-free (docs/UI.md §1.1): the translated pad tooltip arrives through
// `padTitle`; src/ui/base.tsx wraps this with the app's i18n text.
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { evalExpr } from "../../engine/expr";

export interface ScrubNumProps {
  value: string | number;
  onChange: (v: string) => void;
  min?: number;
  max?: number;
  step?: number;
  title?: string;
  placeholder?: string;
  style?: React.CSSProperties;
  /** accept arithmetic ("12+3*2"); false = digits only */
  expr?: boolean;
  /** tooltip of the formula pad (app layer supplies the translated string) */
  padTitle?: string;
}

/**
 * Numeric input with a scrub gesture: long-press (no typing) then slide
 * up/down or left/right to change the value. The per-step magnitude is
 * derived from the bounds ((max-min)/100, minimum 1) or defaults to 1 when a
 * bound is missing.
 *
 * The field also accepts a formula: while it has focus the text is kept
 * verbatim ("64*2+8") and evaluated live (see src/engine/expr.ts). A small
 * operator pad pops up under the field, because the numeric phone keypad has
 * no + − × ÷ keys.
 */
export function ScrubNum({
  value, onChange, min, max, step, title, placeholder, style, expr = true, padTitle,
}: ScrubNumProps) {
  const elRef = useRef<HTMLInputElement | null>(null);
  const armT = useRef<number | null>(null);
  const anchor = useRef<{ x: number; y: number; n: number } | null>(null);
  const unit = step != null ? step : (min != null && max != null ? Math.max(1, Math.round((max - min) / 100)) : 1);
  /** raw text while focused (null = show the committed value) */
  const [text, setText] = useState<string | null>(null);
  /** screen position of the operator pad while focused */
  const [pad, setPad] = useState<{ left: number; top: number } | null>(null);
  const clampN = (n: number) => { if (min != null) n = Math.max(min, n); if (max != null) n = Math.min(max, n); return n; };
  const numeric = () => {
    if (text !== null) { const e = evalExpr(text); if (e !== null) return clampN(e); }
    const n = parseFloat(String(value));
    return Number.isFinite(n) ? n : (min ?? 0);
  };
  /** commit an evaluated result (integers unless a fractional step is declared) */
  const commit = (n: number) => {
    const q = step != null && !Number.isInteger(step) ? n : Math.round(n);
    onChange(String(clampN(q)));
  };
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
  // ---- formula editing ----------------------------------------------------
  const edit = (v: string) => {
    setText(v);
    const n = evalExpr(v);
    if (n !== null) commit(n); // live: the rest of the UI follows as you type
  };
  const placePad = () => {
    const el = elRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPad({
      left: Math.max(6, Math.min(window.innerWidth - 292, r.left)),
      top: Math.min(window.innerHeight - 46, r.bottom + 6),
    });
  };
  useEffect(() => {
    if (!pad) return;
    const on = () => placePad();
    window.addEventListener("resize", on);
    window.addEventListener("scroll", on, true);
    return () => {
      window.removeEventListener("resize", on);
      window.removeEventListener("scroll", on, true);
    };
  }, [pad !== null]);
  const blur = () => {
    const t = text;
    setText(null);
    setPad(null);
    if (t === null) return;
    const n = evalExpr(t);
    // an unfinished formula ("12+") falls back to the last committed value
    if (n === null) commit(parseFloat(String(value)) || (min ?? 0));
    else commit(n);
  };
  /** PC：鼠标悬停在数字框上滚动滚轮＝按步长调值（0ms、无需聚焦） */
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const span = min != null && max != null ? max - min : 0;
      const stepN = step != null ? step : span > 200 ? 5 : span > 50 ? 1 : 1;
      const cur = numeric();
      const next = clampN(cur + (e.deltaY < 0 ? stepN : -stepN));
      if (next !== cur) commit(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [min, max, step, value, text]);

  /** insert at the caret of the (controlled) field, keeping the caret put */
  const insert = (ins: string) => {
    const el = elRef.current;
    const cur = text ?? String(value);
    const at = el && el.selectionStart != null ? el.selectionStart : cur.length;
    edit(cur.slice(0, at) + ins + cur.slice(at));
    window.requestAnimationFrame(() => {
      try { el?.focus(); el?.setSelectionRange(at + ins.length, at + ins.length); } catch { /* ignore */ }
    });
  };
  const backspace = () => {
    const el = elRef.current;
    const cur = text ?? String(value);
    const at = el && el.selectionStart != null ? el.selectionStart : cur.length;
    if (at <= 0) return;
    edit(cur.slice(0, at - 1) + cur.slice(at));
    window.requestAnimationFrame(() => {
      try { el?.focus(); el?.setSelectionRange(at - 1, at - 1); } catch { /* ignore */ }
    });
  };
  return (
    <>
      <input
        ref={elRef}
        type="text"
        inputMode="decimal"
        value={text ?? String(value)}
        title={title}
        placeholder={placeholder}
        style={style}
        onChange={(e) => (expr ? edit(e.target.value) : onChange(e.target.value))}
        onFocus={() => { if (!expr) return; setText(String(value)); placePad(); }}
        onBlur={blur}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); elRef.current?.blur(); } }}
        onPointerDown={down}
        onPointerUp={clearT}
        onPointerCancel={clearT}
      />
      {pad && createPortal(
        <div className="calcpad" style={{ left: pad.left, top: pad.top }} title={padTitle}
          onPointerDown={(e) => e.preventDefault()}>
          {["(", ")", "+", "\u2212", "\u00d7", "\u00f7"].map((c) => (
            <button key={c} type="button" className="cp-key" onClick={() => insert(c === "\u2212" ? "-" : c === "\u00d7" ? "*" : c === "\u00f7" ? "/" : c)}>{c}</button>
          ))}
          <button type="button" className="cp-key cp-back" onClick={backspace}>{"\u232b"}</button>
          <button type="button" className="cp-key cp-eq" onClick={() => elRef.current?.blur()}>{"="}</button>
        </div>,
        document.body,
      )}
    </>
  );
}
