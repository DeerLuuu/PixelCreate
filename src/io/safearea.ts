// Full-screen / safe-area handling (Android notch, punch hole, gesture bar).
//
// The native shell reports the real window insets in CSS px; the browser and
// ROMs that report nothing fall back to the CSS env(safe-area-inset-*) values.
// The result is published as CSS variables on <html>, so the stylesheet can
// pad the bars and dialogs without any JS layout work:
//
//   --sat / --sab / --sal / --sar   (top / bottom / left / right, px)
//
// "安全区适配" off turns every var back to 0; "额外安全边距" adds a manual
// amount on top of whatever was detected. Lives in io/ (next to the bridge)
// so the settings registry can call it without depending on the UI layer.
import * as bridge from "./bridge";

export interface Insets { top: number; bottom: number; left: number; right: number }

export interface SafeAreaPrefs {
  /** keep the UI clear of the notch / gesture bar */
  safeArea: boolean;
  /** extra px added to every detected inset */
  safeExtra: number;
  /** hide the system bars */
  immersive: boolean;
}

/** insets as detected right now (native probe first, env() fallback) */
export function detectInsets(): Insets {
  return bridge.insets();
}

/** write the CSS variables for the current settings (idempotent, cheap) */
export function applySafeArea(p: SafeAreaPrefs): void {
  try {
    const root = document.documentElement;
    let top = 0, bottom = 0, left = 0, right = 0;
    if (p.safeArea) {
      const d = detectInsets();
      const ex = Math.max(0, Math.min(40, Math.round(p.safeExtra || 0)));
      top = d.top + ex; bottom = d.bottom + ex; left = d.left + ex; right = d.right + ex;
    }
    root.style.setProperty("--sat", top + "px");
    root.style.setProperty("--sab", bottom + "px");
    root.style.setProperty("--sal", left + "px");
    root.style.setProperty("--sar", right + "px");
    root.classList.toggle("safe-off", !p.safeArea);
  } catch { /* no DOM (tests) */ }
  // keep the Android window in sync with the immersive setting
  bridge.setImmersive(p.immersive);
}

/** re-apply on rotation / resize (insets change with orientation) and once now */
export function watchSafeArea(get: () => SafeAreaPrefs): () => void {
  const run = () => applySafeArea(get());
  window.addEventListener("resize", run);
  window.addEventListener("orientationchange", run);
  run();
  return () => {
    window.removeEventListener("resize", run);
    window.removeEventListener("orientationchange", run);
  };
}
