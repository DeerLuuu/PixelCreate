// User-rebindable keyboard shortcuts (pure, unit tested).
//
// Every rebindable action has a default chord derived from the cheat sheet in
// app/shortcuts.ts; the user's overrides live in `prefs.keymap` as
// `{ action: "ctrl+shift+z" }`. A plain string chord keeps the preference file
// readable and makes conflict checks trivial.
import type { ShortcutAction, ShortcutKey } from "./shortcuts";
import { SHORTCUT_SHEET, shortcutFor } from "./shortcuts";

/** action -> chord ("ctrl+shift+z", "f", "delete", …) */
export type Keymap = Record<string, string>;

/**
 * Actions that may be rebound: the ones whose hit carries no payload (tools and
 * arrow-nudging build their payload from the event and keep their fixed keys).
 * `pieLaunch` is the "hold to open the quick pie" key (default F).
 */
export const REBINDABLE: readonly string[] = [
  "undo", "redo", "save", "openFile", "newDoc", "exportFile",
  "copy", "cut", "paste", "pasteLayer", "pasteCanvas", "delete", "escape",
  "swapColors", "framePrev", "frameNext", "layerPrev", "layerNext",
  "zoomIn", "zoomOut", "fit", "toggleUI", "resizeMode", "shortcutHelp", "actionSearch",
  "pieLaunch",
];

/** the default chord of the quick-pie launch key */
export const PIE_DEFAULT = "f";

/** pretty names for keys that have no single character */
const NAMED: Record<string, string> = {
  arrowleft: "\u2190", arrowright: "\u2192", arrowup: "\u2191", arrowdown: "\u2193",
  delete: "Delete", backspace: "Backspace", escape: "Esc", enter: "Enter",
  tab: "Tab", space: "Space",
};

/** normalise one key name from a KeyboardEvent (`e.key`) */
export function keyName(key: string): string | null {
  if (!key) return null;
  if (key === " " || key === "Spacebar") return "space";
  if (/^(Shift|Control|Alt|Meta|CapsLock|Dead)$/.test(key)) return null;   // modifier only
  if (key === "+") return "=";          // Ctrl+= and Ctrl++ are the same chord
  if (key === "_") return "-";
  if (key.length === 1) return key.toLowerCase();
  return key.toLowerCase();
}

/** the chord an event represents, or null for modifier-only presses */
export function chordOf(e: ShortcutKey): string | null {
  const k = keyName(e.key);
  if (!k) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  parts.push(k);
  return parts.join("+");
}

/** "ctrl+shift+z" -> "Ctrl+Shift+Z" (arrows become glyphs) */
export function chordLabel(chord: string): string {
  if (!chord) return "";
  const parts = chord.split("+");
  const key = parts.pop() ?? "";
  const word = NAMED[key] ?? (key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1));
  const mods = parts.map((p) => (p === "ctrl" ? "Ctrl" : p === "alt" ? "Alt" : p === "shift" ? "Shift" : "Meta"));
  return [...mods, word].join("+");
}

/** default chord of an action, taken from the cheat sheet (null = not listed) */
export function defaultChordOf(action: string): string | null {
  if (action === "pieLaunch") return PIE_DEFAULT;
  for (const g of SHORTCUT_SHEET) {
    for (const it of g.items) {
      if (it.action === action && it.probe) return chordOf(it.probe);
    }
  }
  return null;
}

/** the chord actually in force for an action (user override, else the default) */
export function chordForAction(action: string, keymap: Keymap = {}): string | null {
  return keymap[action] ?? defaultChordOf(action);
}

/** which action owns a chord right now (user overrides win over defaults) */
export function actionForChord(chord: string, keymap: Keymap = {}): string | null {
  for (const action of REBINDABLE) {
    if (keymap[action] && keymap[action] === chord) return action;
  }
  for (const action of REBINDABLE) {
    if (!keymap[action] && defaultChordOf(action) === chord) return action;
  }
  return null;
}

/** true when the action has a user override (i.e. it can be reset) */
export function isOverridden(action: string, keymap: Keymap = {}): boolean {
  return !!keymap[action];
}

/**
 * Rebind `action` to `chord`.
 * @returns `{ ok: true, keymap }` with a new map, or `{ ok: false, clash }`
 *          naming the action that already owns the chord.
 */
export function bindChord(
  action: string,
  chord: string,
  keymap: Keymap = {},
): { ok: true; keymap: Keymap } | { ok: false; clash: string } {
  if (!REBINDABLE.includes(action)) return { ok: false, clash: "" };
  const owner = actionForChord(chord, keymap);
  if (owner && owner !== action) return { ok: false, clash: owner };
  // a duplicate of the default is not an override at all
  if (defaultChordOf(action) === chord) {
    const next = { ...keymap };
    delete next[action];
    return { ok: true, keymap: next };
  }
  return { ok: true, keymap: { ...keymap, [action]: chord } };
}

/** drop the override of one action */
export function unbindChord(action: string, keymap: Keymap = {}): Keymap {
  const next = { ...keymap };
  delete next[action];
  return next;
}

/** human summary of the overrides, for tests and the panel footer */
export function overrides(keymap: Keymap = {}): Array<{ action: string; chord: string }> {
  return Object.keys(keymap)
    .filter((a) => REBINDABLE.includes(a))
    .sort()
    .map((action) => ({ action, chord: keymap[action] }));
}

/** kept here so the panel and the dispatcher agree on what a chord triggers */
export function actionHitFor(e: ShortcutKey, typing: boolean, keymap: Keymap): ShortcutAction | null {
  return shortcutFor(e, typing, keymap)?.action ?? null;
}
