// Fullscreen for the web build.
//
// The APK runs inside the Android WebView shell, which already hides the system
// bars (bridge.setImmersive), so the toggle is only rendered when the page is
// opened as a web page: see fullscreenToggleVisible().
//
// Vendor prefixes are still needed for older Android WebViews and Samsung
// Internet (webkitRequestFullscreen / webkitFullscreenElement), and the whole
// API is missing on iOS Safari for iPhone.
import { isNativeShell } from "./bridge";

type FsDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type FsElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
  webkitRequestFullScreen?: () => Promise<void> | void;
};

/** pure decision (tested): the toggle belongs to browser sessions only */
export function showFullscreenToggle(nativeShell: boolean, supported: boolean): boolean {
  return !nativeShell && supported;
}

/** icon for the current state (pure, tested) */
export function fullscreenIcon(on: boolean): string {
  return on ? "i-full-exit" : "i-full";
}

export function fullscreenSupported(): boolean {
  if (typeof document === "undefined") return false;
  const d = document as FsDocument;
  const el = document.documentElement as FsElement | null;
  if (!el) return false;
  const api = !!(el.requestFullscreen || el.webkitRequestFullscreen || el.webkitRequestFullScreen);
  return api && (d.fullscreenEnabled !== false || !!d.webkitFullscreenEnabled);
}

/** the element currently in fullscreen, if any */
export function fullscreenElement(): Element | null {
  if (typeof document === "undefined") return null;
  const d = document as FsDocument;
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

export function isFullscreen(): boolean {
  return !!fullscreenElement();
}

/** shown only in a browser tab / PWA — never inside the APK shell */
export function fullscreenToggleVisible(): boolean {
  return showFullscreenToggle(isNativeShell(), fullscreenSupported());
}

export async function requestFullscreen(): Promise<void> {
  if (typeof document === "undefined") return;
  const el = document.documentElement as FsElement | null;
  if (!el) return;
  try {
    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: "hide" });
    else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
    else if (el.webkitRequestFullScreen) await el.webkitRequestFullScreen();
  } catch { /* browsers may refuse outside a user gesture */ }
}

export async function exitFullscreen(): Promise<void> {
  if (typeof document === "undefined") return;
  const d = document as FsDocument;
  try {
    if (d.exitFullscreen) await d.exitFullscreen();
    else if (d.webkitExitFullscreen) await d.webkitExitFullscreen();
  } catch { /* ignore */ }
}

/** toggle and return the intended new state (the real one arrives via the event) */
export async function toggleFullscreen(): Promise<boolean> {
  const on = isFullscreen();
  if (on) await exitFullscreen();
  else await requestFullscreen();
  return !on;
}

/** subscribe to state changes (Esc / F11 / the toggle); returns the unsubscriber */
export function watchFullscreen(cb: (on: boolean) => void): () => void {
  if (typeof document === "undefined") return () => { /* nothing to watch */ };
  const handler = () => cb(isFullscreen());
  document.addEventListener("fullscreenchange", handler);
  document.addEventListener("webkitfullscreenchange", handler as EventListener);
  return () => {
    document.removeEventListener("fullscreenchange", handler);
    document.removeEventListener("webkitfullscreenchange", handler as EventListener);
  };
}
