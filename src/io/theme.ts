// UI theme switch (dark = default, light = opt-in).
//
// The whole palette lives in src/ui/style.css: :root holds the dark values and
// [data-theme="light"] overrides the theme tokens. This module only writes the
// attribute (plus <meta name="theme-color">, which cannot read CSS variables)
// so it can be called from main.tsx at boot and from the settings `after` hook.
export type ThemeMode = "dark" | "light";

/** window/status-bar colour mirroring --bg for each theme */
const CHROME: Record<ThemeMode, string> = { dark: "#14151a", light: "#eef1f6" };

/** normalise an untrusted value (stored prefs, imported settings file) */
export function themeMode(v: unknown): ThemeMode {
  return v === "light" ? "light" : "dark";
}

export function applyTheme(mode: unknown): ThemeMode {
  const m = themeMode(mode);
  if (typeof document === "undefined") return m;
  const root = document.documentElement;
  if (!root) return m; // headless / partial DOM stub
  if (m === "light") root.setAttribute("data-theme", "light");
  else root.removeAttribute("data-theme");
  // native form controls / scrollbars follow the browser colour-scheme
  if (root.style) root.style.colorScheme = m;
  const meta = typeof document.querySelector === "function"
    ? document.querySelector('meta[name="theme-color"]')
    : null;
  if (meta) meta.setAttribute("content", CHROME[m]);
  return m;
}
