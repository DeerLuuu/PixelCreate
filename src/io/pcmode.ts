// PC mode: does this session have a real mouse + keyboard?
//
// The app is touch-first, so the desktop extras (wheel zoom, hover tooltips,
// middle-drag pan, keyboard shortcuts, bigger floating orb …) are switched on by
// one flag. It is written to <html data-pc="1"> so both React and the non-React
// layers (View, CSS) can read the same answer.
//
// Settings → Display & Colour → PC mode: auto (default) / on / off. `auto` uses
// the pointer media queries, which is right for phones (coarse, no hover) and
// for desktops (fine, hover) at the same time. A touch-screen laptop matches
// BOTH, so `auto` asks for hover+fine together and the user can force it on/off.
import type { Prefs } from "../app/session";

export type PcMode = "auto" | "on" | "off";

/** pure decision (unit tested): does this combination count as a PC session? */
export function resolvePcMode(mode: PcMode, finePointer: boolean, hover: boolean): boolean {
  if (mode === "on") return true;
  if (mode === "off") return false;
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
  return resolvePcMode(normalizePcMode(mode), cap.fine, cap.hover);
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

/** re-apply when the pointer capabilities change (mouse plugged in / tablet mode) */
export function watchPcCapabilities(getMode: () => PcMode, cb?: (on: boolean) => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => { /* nothing */ };
  const mq = [window.matchMedia("(pointer: fine)"), window.matchMedia("(hover: hover)")];
  const on = () => { const state = applyPcMode(getMode()); cb?.(state); };
  for (const m of mq) m.addEventListener("change", on);
  return () => { for (const m of mq) m.removeEventListener("change", on); };
}

/** the prefs field, handy for callers that only have Prefs */
export function pcModeOf(p: Pick<Prefs, "pcMode">): PcMode {
  return normalizePcMode(p.pcMode);
}
