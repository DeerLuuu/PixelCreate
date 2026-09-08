// Godot-style settings registry.
//
// Every user-facing setting is declared exactly ONCE here: a dotted path
// (Godot's "category/subcategory/name" style), its type, default, range,
// group, i18n labels, visibility condition, refresh policy and optional
// custom getter/setter/side effect. The settings dialog is generated from
// this table, so adding a setting means adding one entry plus its strings —
// no UI plumbing, no new session setter, no extra localStorage key.
import type { Prefs, Session } from "./session";

export type SettingValue = boolean | number | string;
export type SettingKind = "bool" | "int" | "enum";
/** how the app must react when a value changes */
export type SettingRefresh = "none" | "changed" | "repaint" | "repaintAll";

export type SettingGroupId = "general" | "canvas" | "tools" | "onion" | "history" | "display" | "data";

export interface SettingOption {
  value: string;
  /** i18n key of the option label */
  label: string;
}

export interface SettingDef {
  /** unique dotted path, e.g. "onion.before" */
  path: string;
  /** backing Session.prefs field (omit when get/set are supplied) */
  field?: keyof Prefs;
  kind: SettingKind;
  group: SettingGroupId;
  /** i18n key of the row label */
  label: string;
  /** optional i18n key of a one-line description under the control */
  desc?: string;
  /** default value (also used when stored data is invalid) */
  default: SettingValue;
  /** enum choices */
  options?: SettingOption[];
  /** int bounds */
  min?: number;
  max?: number;
  /** int suffix shown by the slider, e.g. "px" / "%" / "f" */
  unit?: string;
  /** double-tap reset target (defaults to `default`) */
  reset?: SettingValue;
  /** render only while this holds (Godot's usage-hint equivalent) */
  visible?: (s: Session) => boolean;
  /** UI reaction after the value is stored */
  refresh?: SettingRefresh;
  /** custom read (defaults to prefs[field]) */
  get?: (s: Session) => SettingValue;
  /** custom write (defaults to prefs[field]) */
  set?: (s: Session, v: SettingValue) => void;
  /** extra side effect after the value is stored */
  after?: (s: Session, v: SettingValue) => void;
}

export const SETTING_GROUPS: Array<{ id: SettingGroupId; label: string }> = [
  { id: "general", label: "groupGeneral" },
  { id: "canvas", label: "groupCanvas" },
  { id: "tools", label: "groupTools" },
  { id: "onion", label: "groupOnion" },
  { id: "history", label: "groupHistory" },
  { id: "display", label: "groupDisplay" },
  { id: "data", label: "groupData" },
];

const defs: SettingDef[] = [
  // ------------------------------------------------------------ general
  {
    path: "general.language", field: "lang", kind: "enum", group: "general",
    label: "lang", default: "zh", refresh: "changed",
    options: [{ value: "zh", label: "zhLabel" }, { value: "en", label: "enLabel" }],
  },
  {
    path: "general.swapRails", field: "railSwap", kind: "bool", group: "general",
    label: "swapRails", default: true, refresh: "changed",
  },
  {
    path: "general.newFrameCopy", field: "newFrameCopy", kind: "bool", group: "general",
    label: "newFrameCopy", default: false, refresh: "changed",
  },

  // ------------------------------------------------------------- canvas
  {
    path: "canvas.grid", field: "gridMode", kind: "enum", group: "canvas",
    label: "grid", default: "off", refresh: "repaintAll",
    options: [{ value: "off", label: "gridNone" }, { value: "pixel", label: "gridPixel" }, { value: "iso", label: "gridIso" }],
    // a tiny cell size makes the isometric guide too dense
    after: (s, v) => { if (v === "iso" && s.prefs.gridSize < 4) s.prefs.gridSize = 8; },
  },
  {
    path: "canvas.gridSize", field: "gridSize", kind: "int", group: "canvas",
    label: "gridSize", default: 1, min: 1, max: 32, unit: "px", reset: 1, refresh: "repaintAll",
    visible: (s) => s.prefs.gridMode !== "off",
  },
  {
    path: "canvas.autoPan", field: "autoPan", kind: "bool", group: "canvas",
    label: "autoPan", default: true, refresh: "changed",
  },
  {
    path: "canvas.timelineHeight", field: "tlH", kind: "int", group: "canvas",
    label: "tlHeight", default: 116, min: 56, max: 340, unit: "px", reset: 116, refresh: "changed",
  },

  // -------------------------------------------------------------- tools
  {
    path: "tools.bucketGlobal", field: "bucketGlobal", kind: "bool", group: "tools",
    label: "bucketGlobalLabel", desc: "bucketGlobalDesc", default: false, refresh: "changed",
  },
  {
    path: "tools.wandTolerance", field: "selectionTolerance", kind: "int", group: "tools",
    label: "sel.wandTol", default: 8, min: 0, max: 64, unit: "T", reset: 8, refresh: "changed",
  },

  // -------------------------------------------------------------- onion
  {
    path: "onion.enabled", field: "onionOn", kind: "bool", group: "onion",
    label: "onion", default: false, refresh: "repaintAll",
  },
  {
    path: "onion.before", field: "onionBefore", kind: "int", group: "onion",
    label: "onionBefore", default: 1, min: 0, max: 3, unit: "f", reset: 1, refresh: "repaintAll",
    visible: (s) => s.prefs.onionOn,
    after: (s, v) => { if (Number(v) > 0) s.prefs.onionOn = true; },
  },
  {
    path: "onion.after", field: "onionAfter", kind: "int", group: "onion",
    label: "onionAfter", default: 0, min: 0, max: 3, unit: "f", reset: 0, refresh: "repaintAll",
    visible: (s) => s.prefs.onionOn,
    after: (s, v) => { if (Number(v) > 0) s.prefs.onionOn = true; },
  },
  {
    path: "onion.alpha", field: "onionAlpha", kind: "int", group: "onion",
    label: "onionAlpha", default: 55, min: 10, max: 100, unit: "%", reset: 55, refresh: "repaintAll",
    visible: (s) => s.prefs.onionOn,
  },
  {
    path: "onion.tint", field: "onionTint", kind: "bool", group: "onion",
    label: "onionTint", default: true, refresh: "repaintAll",
    visible: (s) => s.prefs.onionOn,
  },

  // ------------------------------------------------------------ history
  {
    path: "history.mode", field: "histMode", kind: "enum", group: "history",
    label: "histMode", default: "steps", refresh: "changed",
    options: [{ value: "steps", label: "histModeSteps" }, { value: "full", label: "histModeFull" }],
    after: (s) => s.applyHistoryLimit(),
  },
  {
    path: "history.steps", field: "histSteps", kind: "int", group: "history",
    label: "histStepsLabel", default: 120, min: 10, max: 500, reset: 120, refresh: "changed",
    visible: (s) => s.prefs.histMode !== "full",
    after: (s) => s.applyHistoryLimit(),
  },

  // ------------------------------------------------------------ display
  {
    path: "display.previewBg", field: "previewBg", kind: "enum", group: "display",
    label: "previewBg", default: "white", refresh: "changed",
    options: [{ value: "white", label: "previewWhite" }, { value: "black", label: "previewBlack" }, { value: "checker", label: "previewChecker" }],
  },
  {
    path: "display.loupe", field: "loupe", kind: "bool", group: "display",
    label: "loupe", default: true, refresh: "changed",
  },
  {
    path: "display.magZoom", field: "magZoom", kind: "int", group: "display",
    label: "magZoom", default: 12, min: 8, max: 20, unit: "px", reset: 12, refresh: "changed",
  },
  {
    path: "display.recentColors", field: "recentColorsMax", kind: "int", group: "display",
    label: "recentColorsMax", default: 16, min: 4, max: 64, reset: 16, refresh: "changed",
    after: (s) => s.trimRecentColors(),
  },
  {
    path: "display.shadowTarget", kind: "enum", group: "display",
    label: "shadowMode", default: "cur", refresh: "changed",
    options: [{ value: "cur", label: "shadowCur" }, { value: "new", label: "shadowNew" }],
    get: (s) => (s.prefs.shadowNewLayer ? "new" : "cur"),
    set: (s, v) => { s.prefs.shadowNewLayer = v === "new"; },
  },

  // --------------------------------------------------------------- data
  {
    path: "data.autosave", field: "autosave", kind: "bool", group: "data",
    label: "autosave", default: true, refresh: "none",
    after: (s, v) => { if (v) s.scheduleAutosave(); },
  },
];

export const SETTINGS: SettingDef[] = defs;
export const SETTINGS_BY_PATH: Map<string, SettingDef> = new Map(defs.map((d) => [d.path, d]));

/** settings of one group, in declaration order (visible ones only) */
export function settingsOfGroup(s: Session, g: SettingGroupId): SettingDef[] {
  return defs.filter((d) => d.group === g && (!d.visible || d.visible(s)));
}

/** coerce a raw value to the definition's kind/bounds; null = reject */
export function normalizeSetting(def: SettingDef, raw: SettingValue): SettingValue | null {
  if (def.kind === "bool") return !!raw;
  if (def.kind === "int") {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) return null;
    const lo = def.min ?? -Infinity, hi = def.max ?? Infinity;
    return Math.max(lo, Math.min(hi, n));
  }
  const opts = def.options ?? [];
  const v = String(raw);
  return opts.some((o) => o.value === v) ? v : null;
}
