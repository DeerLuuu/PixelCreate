// Keyboard shortcuts (PC mode). Pure key→action mapping, unit tested.
//
// The host (App.tsx) translates the returned action into a Session/View call, so
// the interesting part — which chord means what, and when a chord must be
// ignored (typing in a field, modifier-only presses) — stays testable.
export type ShortcutAction =
  | "undo" | "redo" | "save" | "copy" | "cut" | "paste" | "delete" | "escape"
  | "framePrev" | "frameNext" | "layerPrev" | "layerNext"
  | "zoomIn" | "zoomOut" | "fit" | "toggleUI"
  | "tool" | "nudge";

export interface ShortcutHit {
  action: ShortcutAction;
  /** for action === "tool" */
  tool?: string;
  /** for action === "nudge": -1 / 0 / 1 per axis, already scaled by Shift */
  dx?: number;
  dy?: number;
}

/** single-key tool bindings (Aseprite-flavoured where a key is obvious) */
export const TOOL_KEYS: Record<string, string> = {
  b: "pencil",
  e: "eraser",
  g: "bucket",
  i: "picker",
  a: "airbrush",
  l: "line",
  r: "rect",
  o: "ellipse",
  c: "circle",
  p: "polygon",
  y: "polyline",
  u: "curve",
  m: "select",
  w: "wand",
  q: "lasso",
  h: "outline",
};

/** how far an arrow key nudges: 1px, or 10px with Shift */
export const NUDGE_STEP = 1;
export const NUDGE_STEP_FAST = 10;

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
};

export interface ShortcutKey {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

/**
 * @param typing true while a text field / contenteditable has focus: then only
 *               the Ctrl/Cmd chords that never insert text are honoured
 */
export function shortcutFor(e: ShortcutKey, typing = false): ShortcutHit | null {
  const mod = !!(e.ctrlKey || e.metaKey);
  const key = e.key;
  const lower = key.length === 1 ? key.toLowerCase() : key;
  if (mod && !e.altKey) {
    switch (lower) {
      case "z": return { action: e.shiftKey ? "redo" : "undo" };
      case "y": return { action: "redo" };
      case "s": return { action: "save" };
      case "c": return { action: "copy" };
      case "x": return { action: "cut" };
      case "v": return { action: "paste" };
      case "ArrowLeft": return { action: "framePrev" };
      case "ArrowRight": return { action: "frameNext" };
      case "ArrowUp": return { action: "layerPrev" };
      case "ArrowDown": return { action: "layerNext" };
    }
    return null;
  }
  if (typing) return null;         // never steal plain keys from a text field
  if (e.altKey) return null;
  if (key === "Delete" || key === "Backspace") return { action: "delete" };
  if (key === "Escape") return { action: "escape" };
  if (key === "+" || key === "=") return { action: "zoomIn" };
  if (key === "-" || key === "_") return { action: "zoomOut" };
  if (key === "0") return { action: "fit" };
  if (key === "Tab") return { action: "toggleUI" };
  const arrow = ARROWS[key];
  if (arrow) {
    const step = e.shiftKey ? NUDGE_STEP_FAST : NUDGE_STEP;
    return { action: "nudge", dx: arrow[0] * step, dy: arrow[1] * step };
  }
  const tool = TOOL_KEYS[lower];
  if (tool && !e.shiftKey) return { action: "tool", tool };
  return null;
}
