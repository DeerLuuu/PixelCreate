// Editable UI: which bar actions exist, in what order, and which layout regions
// are shown. Pure data + helpers (unit tested); the shell renders the registries
// and the customise panel edits the two preference lists.
//
// Storage model (kept deliberately simple, so reordering never loses an entry):
//   prefs.barOrder   = ["menu", "undo", …]   the FULL list, hidden ones included
//   prefs.barHidden  = ["timeline", …]       suppressed from the bar
// A new action added in a later release simply appears at its registry position
// (it is missing from the stored order), and hiding/showing never moves anything.

export interface UIAction {
  id: string;
  icon: string;
  /** i18n key of the label */
  label: string;
  /** i18n key of the long description / ball text (optional) */
  desc?: string;
  /** onboarding anchor, rendered as data-guide */
  guide?: string;
}

/** every button the top bar can show, in the default order */
export const TOPBAR_ACTIONS: UIAction[] = [
  { id: "menu", icon: "i-menu", label: "menu", desc: "menu", guide: "btn-menu" },
  { id: "history", icon: "i-history", label: "historyTitle", desc: "hist", guide: "btn-history" },
  { id: "undo", icon: "i-undo", label: "undo", desc: "undo", guide: "btn-undo" },
  { id: "redo", icon: "i-redo", label: "redo", desc: "redo", guide: "btn-redo" },
  { id: "save", icon: "i-save", label: "save", desc: "save", guide: "btn-save" },
  { id: "timeline", icon: "i-timeline", label: "timelineShow", guide: "btn-timeline" },
  { id: "fullscreen", icon: "i-full", label: "fullscreen", desc: "full", guide: "btn-fullscreen" },
];

/** the global (tool-independent) buttons of the bottom control bar */
export const CBAR_ACTIONS: UIAction[] = [
  { id: "colors", icon: "", label: "fgActive", guide: "btn-colors" },   // the colour pair is its own chip
  { id: "swap", icon: "i-swap", label: "swapColors", guide: "btn-swap" },
  { id: "adjust", icon: "i-adjust", label: "adjust", guide: "btn-adjust" },
  { id: "symmetry", icon: "i-sym", label: "sym.off", guide: "btn-sym" },
  { id: "frameprev", icon: "i-frameprev", label: "framePreview", guide: "btn-frameprev" },
];

/** the five floating balls (sel is not dockable but is customisable) */
export const ORB_IDS = ["main", "sel", "pal", "fx", "canv"] as const;
export type OrbKey = typeof ORB_IDS[number];

/** layout regions that can be switched off */
export const LAYOUT_KEYS = ["top", "bar", "timeline", "dock", "orbs", "titles"] as const;
export type LayoutKey = typeof LAYOUT_KEYS[number];

export const DEFAULT_LAYOUT: Record<LayoutKey, boolean> = {
  top: true, bar: true, timeline: true, dock: true, orbs: true, titles: true,
};

/** coerce a stored layout blob into a complete, boolean map */
export function normalizeLayout(v: unknown): Record<LayoutKey, boolean> {
  const out = { ...DEFAULT_LAYOUT };
  if (v && typeof v === "object") {
    const src = v as Record<string, unknown>;
    for (const k of LAYOUT_KEYS) if (typeof src[k] === "boolean") out[k] = src[k] as boolean;
  }
  return out;
}

/** true when the layout is still the default one */
export function isDefaultLayout(l: Record<LayoutKey, boolean>): boolean {
  return LAYOUT_KEYS.every((k) => l[k] === DEFAULT_LAYOUT[k]);
}

/**
 * The actions to render, in the user's order.
 * @param all    the registry (default order)
 * @param order  stored order (full list); missing ids fall back to registry order
 * @param hidden ids to leave out
 */
export function orderedActions<T extends { id: string }>(
  all: readonly T[],
  order?: readonly string[],
  hidden?: readonly string[],
): T[] {
  const drop = new Set(hidden ?? []);
  const byId = new Map(all.map((a) => [a.id, a]));
  const out: T[] = [];
  const used = new Set<string>();
  for (const id of order ?? []) {
    const a = byId.get(id);
    if (a && !used.has(id)) { used.add(id); if (!drop.has(id)) out.push(a); }
  }
  for (const a of all) if (!used.has(a.id) && !drop.has(a.id)) out.push(a);
  return out;
}

/** the stored order as a full id list (stored order first, unknown ids dropped, new ids appended) */
export function fullOrder(all: readonly { id: string }[], order?: readonly string[]): string[] {
  const ids = all.map((a) => a.id);
  const known = new Set(ids);
  const out: string[] = [];
  for (const id of order ?? []) if (known.has(id) && !out.includes(id)) out.push(id);
  for (const id of ids) if (!out.includes(id)) out.push(id);
  return out;
}

/**
 * Move `id` by `delta` slots inside the full order (so a hidden neighbour does
 * not make the item jump two places).
 */
export function moveId(all: readonly { id: string }[], order: readonly string[] | undefined, id: string, delta: number): string[] {
  const list = fullOrder(all, order);
  const i = list.indexOf(id);
  if (i < 0) return list;
  const j = Math.max(0, Math.min(list.length - 1, i + delta));
  if (i === j) return list;
  list.splice(j, 0, list.splice(i, 1)[0]);
  return list;
}

/** toggle one id in a hidden list (returns a new array) */
export function toggleHidden(hidden: readonly string[] | undefined, id: string): string[] {
  const set = new Set(hidden ?? []);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  return [...set];
}

/** how many entries are still visible (used to refuse hiding everything) */
export function visibleCount(all: readonly { id: string }[], hidden?: readonly string[]): number {
  const drop = new Set(hidden ?? []);
  return all.filter((a) => !drop.has(a.id)).length;
}

/** true when every registry id is still reachable somewhere in the UI */
export function missingFrom(list: readonly string[], all: readonly { id: string }[]): string[] {
  const known = new Set(all.map((a) => a.id));
  return list.filter((id) => !known.has(id));
}

/**
 * Index the dragged item should land on, given the current slots' centre
 * positions along one axis (screen px). Used by the bar drag: the item is
 * re-ordered live as the pointer passes a neighbour's midpoint.
 */
export function dropIndexAt(centers: readonly number[], x: number): number {
  if (!centers.length) return -1;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < centers.length; i++) {
    const d = Math.abs(centers[i] - x);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * Nearest slot of a ring (floating-ball drag): the slot whose centre is closest
 * to the pointer. `count` slots are evenly spaced from the top, clockwise —
 * the same convention as the orb ring renderer.
 */
export function nearestSlotIndex(
  px: number, py: number, cx: number, cy: number, count: number,
): number {
  if (count <= 0) return -1;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < count; i++) {
    const a = -Math.PI / 2 + i * ((Math.PI * 2) / count);
    const x = cx + Math.cos(a);
    const y = cy + Math.sin(a);
    const d = (px - x) * (px - x) + (py - y) * (py - y);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** how many steps to move `from` to reach `to` (negative = up/left) */
export function stepsBetween(from: number, to: number): number {
  return to - from;
}
