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

// ---------------------------------------------------------------- 助手浮窗与助手小球
//
// 应用内助手（docs/PLAN-ai.md §3.7.6）有**自己的**浮窗与小球，**不**进 `ORB_IDS`：
// 五个浮动球那套系统（dock 拖拽 / 展开环 / 饼菜单 / 界面定制 / `orbPrefs` 顺序）是全仓库
// 回归面最密的一块，而助手球没有任何「子项」要被搬运或排序 —— 它就是一个开关按钮。
// 所以这里只放**纯几何与存储归一化**（有单测），组件在 `src/ui/AiWindow.tsx`（浮窗）
// 与 `src/ui/AiPanel.tsx`（对话面板 + 助手小球 `ChatBall`）。
//
// 为什么几何归一化放在这里（而不是组件里）：`pc.aichat.win` / `pc.aichat.ball` 里躺的是
// 用户可写的 localStorage —— 坏数据 / 手改 / 换屏幕尺寸都会碰到。规则必须能单测，
// 组件只负责调用它（**不许把 `JSON.parse` 的结果直接塞进 style**）。

/** 助手浮窗几何的存储键（`{ v:1, x, y, w, h, min }`） */
export const AI_CHAT_WIN_KEY = "pc.aichat.win";
/** 助手小球位置的存储键（`{ x, y }`） */
export const AI_CHAT_BALL_KEY = "pc.aichat.ball";
/** 小球的内容 id（data-orb-id / data-guide 用；**不是** `ORB_IDS` 的一员） */
export const CHAT_BALL_ID = "ai";
/** 助手浮窗几何存储的版本号（换口径时整份丢弃，不做迁移） */
export const AI_WIN_STORE_V = 1;
/** 浮窗默认尺寸（§3.7.6 定稿） */
export const AI_WIN_W = 380;
export const AI_WIN_H = 460;
/** 浮窗的最小 / 最大尺寸；边距 = 与视口边缘的最小间隙 */
export const AI_WIN_MIN_W = 260;
export const AI_WIN_MIN_H = 200;
export const AI_WIN_EDGE = 8;
export const AI_WIN_MARGIN = 16;

export interface AiWinLayout {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 已最小化成小球 */
  min: boolean;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : NaN);

/** 视口尺寸（拿不到 / 是垃圾 → 0，调用方按「无约束」处理，绝不抛异常） */
function viewport(): { w: number; h: number } {
  const g = globalThis as { innerWidth?: unknown; innerHeight?: unknown };
  const w = num(g.innerWidth), h = num(g.innerHeight);
  return { w: w > 0 ? w : 0, h: h > 0 ? h : 0 };
}

/** 默认几何：贴右下角（`w/h` 视口放不下时按最小尺寸让位） */
export function aiWinDefaultLayout(innerW = 0, innerH = 0): AiWinLayout {
  const vw = num(innerW) > 0 ? num(innerW) : viewport().w;
  const vh = num(innerH) > 0 ? num(innerH) : viewport().h;
  const w = vw > 0 ? Math.max(AI_WIN_MIN_W, Math.min(AI_WIN_W, vw - AI_WIN_MARGIN * 2)) : AI_WIN_W;
  const h = vh > 0 ? Math.max(AI_WIN_MIN_H, Math.min(AI_WIN_H, vh - AI_WIN_MARGIN * 2)) : AI_WIN_H;
  return {
    w, h, min: false,
    x: vw > 0 ? Math.max(AI_WIN_EDGE, vw - w - AI_WIN_MARGIN) : Math.max(AI_WIN_EDGE, 1024 - w - AI_WIN_MARGIN),
    y: vh > 0 ? Math.max(AI_WIN_EDGE, vh - h - AI_WIN_MARGIN) : Math.max(AI_WIN_EDGE, 768 - h - AI_WIN_MARGIN),
  };
}

/** 把几何夹进视口（拖动 / 缩放 / 旋屏后都要跑一次：窗口不许跑到屏幕外） */
export function clampAiWinLayout(v: AiWinLayout, innerW = 0, innerH = 0): AiWinLayout {
  const vw = num(innerW) > 0 ? num(innerW) : viewport().w;
  const vh = num(innerH) > 0 ? num(innerH) : viewport().h;
  const maxW = vw > 0 ? Math.max(AI_WIN_MIN_W, vw - AI_WIN_EDGE * 2) : Math.max(AI_WIN_MIN_W, v.w);
  const maxH = vh > 0 ? Math.max(AI_WIN_MIN_H, vh - AI_WIN_EDGE * 2) : Math.max(AI_WIN_MIN_H, v.h);
  const w = Math.round(Math.max(AI_WIN_MIN_W, Math.min(maxW, num(v.w) || AI_WIN_W)));
  const h = Math.round(Math.max(AI_WIN_MIN_H, Math.min(maxH, num(v.h) || AI_WIN_H)));
  const limX = vw > 0 ? Math.max(AI_WIN_EDGE, vw - w - AI_WIN_EDGE) : Math.max(AI_WIN_EDGE, num(v.x) || AI_WIN_EDGE);
  const limY = vh > 0 ? Math.max(AI_WIN_EDGE, vh - h - AI_WIN_EDGE) : Math.max(AI_WIN_EDGE, num(v.y) || AI_WIN_EDGE);
  return {
    w, h, min: v.min === true,
    x: Math.round(Math.max(AI_WIN_EDGE, Math.min(limX, num(v.x) || AI_WIN_EDGE))),
    y: Math.round(Math.max(AI_WIN_EDGE, Math.min(limY, num(v.y) || AI_WIN_EDGE))),
  };
}

/**
 * 存储 → 几何（§3.7.6 的「跨会话恢复口径」，逐条可测）：
 *   · `x/y/w/h` 任一不是有限数字 → **整份丢弃**，回默认值（不做逐字段修补：半份数据只会让窗口怪模怪样）；
 *   · `v` 不认识、不是对象、是 `null`/字符串 → 同上；
 *   · `w/h` 只在有限时才认，超界由 `clampAiWinLayout` 夹取（视口小于最小尺寸时以最小尺寸为准）；
 *   · `min` **只认 `true`**（其余一律 false）。
 */
export function normalizeAiWinLayout(raw: unknown, innerW = 0, innerH = 0): AiWinLayout {
  if (!raw || typeof raw !== "object") return aiWinDefaultLayout(innerW, innerH);
  const o = raw as Record<string, unknown>;
  if (o.v !== undefined && o.v !== AI_WIN_STORE_V) return aiWinDefaultLayout(innerW, innerH);
  const x = num(o.x), y = num(o.y), w = num(o.w), h = num(o.h);
  if ([x, y, w, h].some((n) => !Number.isFinite(n))) return aiWinDefaultLayout(innerW, innerH);
  return clampAiWinLayout({ x, y, w, h, min: o.min === true }, innerW, innerH);
}

/** 小球默认位置：贴右下角，并**抬高 32px** 让开底栏（§3.7.6） */
export function aiBallDefaultPos(orb: number, innerW = 0, innerH = 0): { x: number; y: number } {
  const vw = num(innerW) > 0 ? num(innerW) : viewport().w;
  const vh = num(innerH) > 0 ? num(innerH) : viewport().h;
  const fallback = { x: 1024 - orb - AI_WIN_MARGIN, y: 768 - orb - 32 };
  return {
    x: Math.max(AI_WIN_EDGE, vw > 0 ? vw - orb - AI_WIN_MARGIN : fallback.x),
    y: Math.max(AI_WIN_EDGE, vh > 0 ? vh - orb - 32 : fallback.y),
  };
}

/** 小球位置夹取（与 `FloatingTools` 的 `clampXY` 同款口径，只是直径由调用方给） */
export function clampAiBallPos(p: { x: number; y: number }, orb: number, innerW = 0, innerH = 0): { x: number; y: number } {
  const vw = num(innerW) > 0 ? num(innerW) : viewport().w;
  const vh = num(innerH) > 0 ? num(innerH) : viewport().h;
  return {
    x: Math.round(Math.max(AI_WIN_EDGE, Math.min(vw > 0 ? vw - orb - AI_WIN_EDGE : num(p.x) || AI_WIN_EDGE, num(p.x) || AI_WIN_EDGE))),
    y: Math.round(Math.max(AI_WIN_EDGE, Math.min(vh > 0 ? vh - orb - AI_WIN_EDGE : num(p.y) || AI_WIN_EDGE, num(p.y) || AI_WIN_EDGE))),
  };
}

/** 存储 → 小球位置（坏数据一律回默认位；`orb` 由调用方按当前模式给） */
export function normalizeAiBallPos(raw: unknown, orb: number, innerW = 0, innerH = 0): { x: number; y: number } {
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const x = num(o.x), y = num(o.y);
    if (Number.isFinite(x) && Number.isFinite(y)) return clampAiBallPos({ x, y }, orb, innerW, innerH);
  }
  return clampAiBallPos(aiBallDefaultPos(orb, innerW, innerH), orb, innerW, innerH);
}

/**
 * 拖动 / 缩放一次的**纯几何**：从按下那一刻的几何 `l0` 加位移，
 * **每次从起点重算**而不是逐帧累加 —— 累加会被夹取一点点往回挤（拖到屏幕边缘再拖回来位置就错了）。
 * 夹取由调用方跑 `clampAiWinLayout`，这里只算。
 */
export function aiWinDragFrom(l0: AiWinLayout, kind: "move" | "resize", dx: number, dy: number): AiWinLayout {
  return kind === "move"
    ? { ...l0, x: l0.x + dx, y: l0.y + dy }
    : { ...l0, w: l0.w + dx, h: l0.h + dy };
}

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
