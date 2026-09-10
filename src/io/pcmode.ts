// PC mode: does this session have a real mouse + keyboard?
//
// The app is touch-first, so the desktop extras (wheel zoom, hover tooltips,
// middle-drag pan, keyboard shortcuts, bigger floating orb …) are switched on by
// one flag. It is written to <html data-pc="1"> so both React and the non-React
// layers (View, CSS) can read the same answer.
//
// Settings → Display & Colour → PC mode: auto (default) / on / off.
//
// `auto` must never trust the media queries alone: Android WebView (and some
// phones with a stylus) happily report `(hover: hover)` + `(pointer: fine)`,
// which used to switch the whole desktop layout on for a touch device. The
// decision therefore also uses real input evidence:
//   * a `pointerType === "mouse"` event ever seen  -> definitely a PC (sticky)
//   * a touch / pen event ever seen, or the device advertising touch points
//     (`navigator.maxTouchPoints > 0`)             -> not a PC, unless a mouse
//     shows up later (then the mouse wins, e.g. a touch-screen laptop)
//   * otherwise fall back to the media queries (plain desktop with no touch).
import type { Prefs } from "../app/session";

export type PcMode = "auto" | "on" | "off";

/** real-input evidence collected while the app runs */
export interface PcHints {
  /** a pointerType === "mouse" event has been seen (sticky once true) */
  seenMouse?: boolean;
  /** a touch / pen event has been seen */
  seenTouch?: boolean;
  /** navigator.maxTouchPoints (a phone/tablet advertises touch points) */
  touchPoints?: number;
}

/** module-level evidence, fed by watchPcCapabilities() */
const hints: PcHints = { seenMouse: false, seenTouch: false, touchPoints: 0 };

/** note one input event (called by the watcher; also used by tests) */
export function notePointerType(t: string): void {
  if (t === "mouse") hints.seenMouse = true;
  else if (t === "touch" || t === "pen") hints.seenTouch = true;
}

/** current input evidence (touch points read from the browser once) */
export function inputHints(): PcHints {
  if (typeof navigator !== "undefined" && typeof navigator.maxTouchPoints === "number") {
    hints.touchPoints = navigator.maxTouchPoints;
  }
  return hints;
}

/**
 * pure decision (unit tested): does this combination count as a PC session?
 * @param h real input evidence; omit to judge on the media queries alone
 */
export function resolvePcMode(mode: PcMode, finePointer: boolean, hover: boolean, h: PcHints = {}): boolean {
  if (mode === "on") return true;
  if (mode === "off") return false;
  if (h.seenMouse) return true;                       // a real mouse event beats every heuristic
  if (h.seenTouch) return false;                      // the finger/pen has been used
  if ((h.touchPoints ?? 0) > 0) return false;         // a phone/tablet advertises touch points
  return finePointer && hover;
}

export function normalizePcMode(v: unknown): PcMode {
  return v === "on" || v === "off" ? v : "auto";
}

/** media queries: a precise pointer that can hover = a mouse */
export function pointerCapabilities(): { fine: boolean; hover: boolean } {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return { fine: false, hover: false };
  }
  try {
    return {
      fine: window.matchMedia("(pointer: fine)").matches,
      hover: window.matchMedia("(hover: hover)").matches,
    };
  } catch {
    return { fine: false, hover: false };
  }
}

export function pcModeOn(mode: unknown): boolean {
  const cap = pointerCapabilities();
  return resolvePcMode(normalizePcMode(mode), cap.fine, cap.hover, inputHints());
}

/** apply the mode to <html>; returns the resolved state */
export function applyPcMode(mode: unknown): boolean {
  const on = pcModeOn(mode);
  if (typeof document !== "undefined" && document.documentElement) {
    const root = document.documentElement;
    if (on) root.setAttribute("data-pc", "1");
    else root.removeAttribute("data-pc");   // `--pc` 由 CSS 的 html[data-pc] 规则提供
  }
  return on;
}

/** read the current state without React (View, CSS-driven code) */
export function isPc(): boolean {
  try {
    return typeof document !== "undefined" && !!document.documentElement
      && document.documentElement.getAttribute("data-pc") === "1";
  } catch {
    return false;
  }
}

/**
 * Re-apply when the input situation changes: the media queries (mouse plugged
 * in / tablet mode) **and** the first real pointer event — the latter is what
 * corrects a phone whose WebView claims `hover: hover` (the first touch pins it
 * to touch mode, the first mouse move switches the desktop extras on).
 */
export function watchPcCapabilities(getMode: () => PcMode, cb?: (on: boolean) => void): () => void {
  if (typeof window === "undefined") return () => { /* nothing */ };
  let last = isPc();
  const on = () => {
    const state = applyPcMode(getMode());
    if (state !== last) { last = state; cb?.(state); }
  };
  const onPointer = (e: Event) => {
    const t = (e as PointerEvent).pointerType;
    if (typeof t === "string") notePointerType(t);
    on();
  };
  const mq = typeof window.matchMedia === "function"
    ? [window.matchMedia("(pointer: fine)"), window.matchMedia("(hover: hover)")]
    : [];
  for (const m of mq) m.addEventListener("change", on);
  // capture phase: this must see the event before anything can stop it
  window.addEventListener("pointerdown", onPointer, true);
  window.addEventListener("pointermove", onPointer, true);
  return () => {
    for (const m of mq) m.removeEventListener("change", on);
    window.removeEventListener("pointerdown", onPointer, true);
    window.removeEventListener("pointermove", onPointer, true);
  };
}

/** the prefs field, handy for callers that only have Prefs */
export function pcModeOf(p: Pick<Prefs, "pcMode">): PcMode {
  return normalizePcMode(p.pcMode);
}
