// Godot-style settings registry.
//
// Every user-facing setting is declared exactly ONCE here: a dotted path
// (Godot's "category/subcategory/name" style), its type, default, range,
// group, i18n labels, visibility condition, refresh policy and optional
// custom getter/setter/side effect. The settings dialog is generated from
// this table, so adding a setting means adding one entry plus its strings —
// no UI plumbing, no new session setter, no extra localStorage key.
import type { Prefs, Session } from "./session";
import { GESTURES, GESTURE_ACTIONS, gesturePath } from "./gestures";
import * as bridge from "../io/bridge";
import { applySafeArea } from "../io/safearea";

export type SettingValue = boolean | number | string;
export type SettingKind = "bool" | "int" | "enum" | "color";
/** how the app must react when a value changes */
export type SettingRefresh = "none" | "changed" | "repaint" | "repaintAll";

export type SettingGroupId = "general" | "canvas" | "screen" | "tools" | "gesture" | "onion" | "history" | "display" | "data";

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
  /** enum rendering: a chip row (default) or an expandable dropdown.
   *  Omitted = chips for <= 6 options, dropdown above that. */
  control?: "chips" | "dropdown";
  /** extra button rendered under the control (label = i18n key) */
  action?: { label: string; run: (s: Session) => void };
  /** custom read (defaults to prefs[field]) */
  get?: (s: Session) => SettingValue;
  /** custom write (defaults to prefs[field]) */
  set?: (s: Session, v: SettingValue) => void;
  /** extra side effect after the value is stored */
  after?: (s: Session, v: SettingValue) => void;
}


// ---------------------------------------------------------------- helpers
/** true when the setting currently holds its declared default */
export function isDefault(s: Session, d: SettingDef): boolean {
  const v = s.settingValue(d.path);
  return typeof v === "number" && typeof d.default === "number"
    ? Math.abs(v - d.default) < 1e-9
    : v === d.default;
}

/** put one setting back to its declared default */
export function resetSetting(s: Session, d: SettingDef): void {
  if (isDefault(s, d)) return;
  s.setSetting(d.path, d.default);
}

/** validate/normalise a value coming from a settings file (undefined = reject) */
export function coerceSetting(d: SettingDef, v: unknown): SettingValue | undefined {
  if (d.kind === "bool") {
    if (typeof v === "boolean") return v;
    if (v === 1 || v === "1" || v === "true") return true;
    if (v === 0 || v === "0" || v === "false") return false;
    return undefined;
  }
  if (d.kind === "int") {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    if (!Number.isFinite(n)) return undefined;
    const lo = d.min ?? -Infinity;
    const hi = d.max ?? Infinity;
    return Math.max(lo, Math.min(hi, Math.round(n)));
  }
  if (typeof v !== "string") return undefined;
  if (d.kind === "color") return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : undefined;
  return (d.options ?? []).some((o) => o.value === v) ? v : undefined;
}

export interface SettingsFile {
  app: string;
  version: number;
  savedAt: string;
  values: Record<string, SettingValue>;
}

export const SETTINGS_FILE_VERSION = 1;

/** every declared setting as a plain object, ready to be written as JSON */
export function exportSettings(s: Session): SettingsFile {
  const values: Record<string, SettingValue> = {};
  for (const d of defs) values[d.path] = s.settingValue(d.path);
  return { app: "PixelCraft", version: SETTINGS_FILE_VERSION, savedAt: new Date().toISOString(), values };
}

/** apply a settings file (the exported object or a bare values map).
 *  Unknown keys and invalid values are counted as skipped, never applied. */
export function importSettings(s: Session, raw: unknown): { applied: number; skipped: number } {
  const src = (raw && typeof raw === "object" && "values" in (raw as Record<string, unknown>)
    ? (raw as { values?: unknown }).values
    : raw) as Record<string, unknown> | null | undefined;
  if (!src || typeof src !== "object") return { applied: 0, skipped: 0 };
  let applied = 0;
  let skipped = 0;
  for (const d of defs) {
    if (!(d.path in src)) continue;
    const v = coerceSetting(d, src[d.path]);
    if (v === undefined) { skipped++; continue; }
    s.setSetting(d.path, v);
    applied++;
  }
  return { applied, skipped };
}

const GESTURE_ACTION_LABELS: Record<string, string> = Object.fromEntries(
  GESTURE_ACTIONS.map((a) => [a.id, a.label]),
);

export const SETTING_GROUPS: Array<{ id: SettingGroupId; label: string }> = [
  { id: "general", label: "groupGeneral" },
  { id: "canvas", label: "groupCanvas" },
  { id: "screen", label: "groupScreen" },
  { id: "tools", label: "groupTools" },
  { id: "gesture", label: "groupGesture" },
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
    path: "canvas.tileMode", field: "tileMode", kind: "enum", group: "canvas",
    label: "tileMode", desc: "tileModeDesc", default: "off", refresh: "repaintAll",
    options: [
      { value: "off", label: "tileOff" },
      { value: "row", label: "tileRow" },
      { value: "col", label: "tileCol" },
      { value: "grid", label: "tileGrid" },
    ],
  },
  {
    path: "canvas.gridSize", field: "gridSize", kind: "int", group: "canvas",
    label: "gridSize", default: 1, min: 1, max: 32, unit: "px", reset: 1, refresh: "repaintAll",
    visible: (s) => s.prefs.gridMode !== "off",
  },
  {
    path: "canvas.snapOn", field: "snapOn", kind: "bool", group: "canvas",
    label: "snapOn", desc: "snapOnDesc", default: true, refresh: "none",
  },
  {
    path: "canvas.snapRange", field: "snapRange", kind: "int", group: "canvas",
    label: "snapRange", desc: "snapRangeDesc", default: 14, min: 4, max: 48, unit: "px", reset: 14, refresh: "none",
    visible: (s) => s.prefs.snapOn,
  },
  {
    path: "canvas.snapGap", field: "snapGap", kind: "int", group: "canvas",
    label: "snapGap", desc: "snapGapDesc", default: 8, min: 0, max: 48, unit: "px", reset: 8, refresh: "repaintAll",
    visible: (s) => s.prefs.snapOn,
  },
  {
    path: "canvas.snapInColor", field: "snapInColor", kind: "color", group: "canvas",
    label: "snapInColor", desc: "snapInColorDesc", default: "#78ffb4", refresh: "repaintAll",
    visible: (s) => s.prefs.snapOn,
  },
  {
    path: "canvas.snapOutColor", field: "snapOutColor", kind: "color", group: "canvas",
    label: "snapOutColor", desc: "snapOutColorDesc", default: "#ff6464", refresh: "repaintAll",
    visible: (s) => s.prefs.snapOn,
  },
  {
    path: "canvas.autoPan", field: "autoPan", kind: "bool", group: "canvas",
    label: "autoPan", default: true, refresh: "changed",
  },
  {
    path: "canvas.timelineHeight", field: "tlH", kind: "int", group: "canvas",
    label: "tlHeight", desc: "tlHeightDesc", default: 200, min: 140, max: 520, unit: "px", reset: 200, refresh: "changed",
  },

  {
    path: "screen.immersive", field: "immersive", kind: "bool", group: "screen",
    label: "immersiveLabel", desc: "immersiveDesc", default: true, refresh: "none",
    after: (s, v) => { bridge.setImmersive(v === true); applySafeArea(s.prefs); },
  },
  {
    path: "screen.safeArea", field: "safeArea", kind: "bool", group: "screen",
    label: "safeAreaLabel", desc: "safeAreaDesc", default: true, refresh: "none",
    after: (s) => applySafeArea(s.prefs),
  },
  {
    path: "screen.safeExtra", field: "safeExtra", kind: "int", group: "screen",
    label: "safeExtraLabel", desc: "safeExtraDesc", default: 0, min: 0, max: 40, unit: "px", reset: 0,
    refresh: "none",
    after: (s) => applySafeArea(s.prefs),
  },

  {
    path: "general.newDocW", field: "newDocW", kind: "int", group: "general",
    label: "newDocW", default: 64, min: 1, max: 1024, unit: "px", reset: 64, refresh: "none",
  },
  {
    path: "general.newDocH", field: "newDocH", kind: "int", group: "general",
    label: "newDocH", default: 64, min: 1, max: 1024, unit: "px", reset: 64, refresh: "none",
  },
  {
    path: "general.newDocBg", field: "newDocBg", kind: "enum", group: "general",
    label: "newDocBg", default: "transparent", refresh: "none",
    options: [{ value: "transparent", label: "transparent" }, { value: "white", label: "whiteBg" }],
  },

  // -------------------------------------------------------------- tools
  {
    // remembered tool / brush state
    path: "tools.brushSize", kind: "int", group: "tools",
    label: "brushSize", default: 1, min: 1, max: 64, unit: "px", reset: 1, refresh: "changed",
    get: (s) => s.brushSize,
    set: (s, v) => s.setBrushSize(Number(v)),
  },
  {
    path: "tools.brushAlpha", kind: "int", group: "tools",
    label: "opacity", default: 255, min: 0, max: 255, reset: 255, refresh: "changed",
    get: (s) => s.color[3],
    set: (s, v) => s.setBrushAlpha(Number(v)),
  },
  {
    path: "tools.brushShape", kind: "enum", group: "tools",
    label: "brushShapeLabel", desc: "brushShapeDesc", default: "circle", refresh: "changed",
    options: [{ value: "circle", label: "brushCircle" }, { value: "square", label: "brushSquare" }],
    get: (s) => s.brushShape,
    set: (s, v) => s.setBrushShape(v === "square" ? "square" : "circle"),
  },
  {
    path: "tools.shapeFill", kind: "bool", group: "tools",
    label: "shapeFillLabel", desc: "shapeFillDesc", default: true, refresh: "changed",
    get: (s) => s.shapeFill,
    set: (s, v) => s.setShapeFill(!!v),
  },
  {
    path: "tools.shapeFromCenter", kind: "bool", group: "tools",
    label: "shapeFromCenterLabel", desc: "shapeFromCenterDesc", default: false, refresh: "changed",
    get: (s) => s.shapeFromCenter,
    set: (s, v) => s.setShapeFromCenter(!!v),
  },
  {
    path: "tools.shapeSides", kind: "int", group: "tools",
    label: "sides", default: 6, min: 3, max: 32, unit: "◮", reset: 6, refresh: "changed",
    visible: (s) => s.tool === "polygon" || s.currentShape === "polygon",
    get: (s) => s.shapeSides,
    set: (s, v) => s.setShapeSides(Number(v)),
  },
  {
    path: "tools.defaultTool", kind: "enum", group: "tools",
    label: "defaultToolLabel", desc: "defaultToolDesc", default: "pencil", refresh: "changed",
    options: [
      { value: "pencil", label: "tools.pencil" }, { value: "eraser", label: "tools.eraser" },
      { value: "bucket", label: "tools.bucket" }, { value: "picker", label: "tools.picker" },
      { value: "airbrush", label: "tools.airbrush" },
      { value: "line", label: "tools.line" }, { value: "rect", label: "tools.rect" },
      { value: "ellipse", label: "tools.ellipse" }, { value: "circle", label: "tools.circle" },
      { value: "polygon", label: "tools.polygon" }, { value: "select", label: "tools.select" },
      { value: "wand", label: "tools.wand" }, { value: "lasso", label: "tools.lasso" },
    ],
    get: (s) => s.tool,
    set: (s, v) => s.setTool(String(v) as never),
  },
  {
    path: "tools.bucketGlobal", field: "bucketGlobal", kind: "bool", group: "tools",
    label: "bucketGlobalLabel", desc: "bucketGlobalDesc", default: false, refresh: "changed",
  },
  {
    path: "tools.bucketGrad", field: "bucketGrad", kind: "bool", group: "tools",
    label: "bucketGradLabel", desc: "bucketGradDesc", default: false, refresh: "changed",
    visible: (s) => s.tool === "bucket",
  },
  {
    path: "tools.bucketGradMode", field: "bucketGradMode", kind: "enum", group: "tools",
    label: "bucketGradModeLabel", desc: "bucketGradModeDesc", default: "rgb", refresh: "changed",
    visible: (s) => s.tool === "bucket" && s.prefs.bucketGrad,
    options: [
      { value: "rgb", label: "bucketGradRgb" },
      { value: "2", label: "bucketGrad2" },
      { value: "4", label: "bucketGrad4" },
      { value: "8", label: "bucketGrad8" },
    ],
  },
  {
    path: "tools.airbrushMin", kind: "int", group: "tools",
    label: "airbrushMinLabel", desc: "airbrushMinDesc", default: 1, min: 1, max: 16, unit: "px", reset: 1, refresh: "changed",
    visible: (s) => s.tool === "airbrush",
    get: (s) => s.prefs.airbrushMin,
    // the two bounds stay ordered: raising the floor lifts the ceiling too
    set: (s, v) => { s.prefs.airbrushMin = Number(v); if (s.prefs.airbrushMax < Number(v)) s.prefs.airbrushMax = Number(v); },
  },
  {
    path: "tools.airbrushMax", kind: "int", group: "tools",
    label: "airbrushMaxLabel", desc: "airbrushMaxDesc", default: 3, min: 1, max: 16, unit: "px", reset: 3, refresh: "changed",
    visible: (s) => s.tool === "airbrush",
    get: (s) => s.prefs.airbrushMax,
    set: (s, v) => { s.prefs.airbrushMax = Number(v); if (s.prefs.airbrushMin > Number(v)) s.prefs.airbrushMin = Number(v); },
  },
  {
    path: "tools.airbrushRate", field: "airbrushRate", kind: "int", group: "tools",
    label: "airbrushRateLabel", desc: "airbrushRateDesc", default: 20, min: 5, max: 60, unit: "/s", reset: 20, refresh: "none",
    visible: (s) => s.tool === "airbrush",
  },
  {
    path: "tools.wandTolerance", field: "selectionTolerance", kind: "int", group: "tools",
    label: "sel.wandTol", default: 8, min: 0, max: 64, unit: "T", reset: 8, refresh: "changed",
  },

  // ------------------------------------------------------------ gesture
  {
    path: "gesture.longPressMs", field: "longPressMs", kind: "int", group: "gesture",
    label: "longPressMsLabel", desc: "longPressMsDesc", default: 300, min: 200, max: 800, unit: "ms", reset: 300, refresh: "none",
  },
  {
    path: "gesture.doubleTapMs", field: "doubleTapMs", kind: "int", group: "gesture",
    label: "doubleTapMsLabel", desc: "doubleTapMsDesc", default: 420, min: 250, max: 600, unit: "ms", reset: 420, refresh: "none",
  },
  {
    path: "gesture.tripleTapZoom", field: "tripleTapZoom", kind: "int", group: "gesture",
    label: "tripleTapZoomLabel", default: 2, min: 1, max: 4, unit: "×", reset: 2, refresh: "none",
  },
  {
    path: "gesture.fourFingerPx", field: "fourFingerPx", kind: "int", group: "gesture",
    label: "fourFingerPxLabel", desc: "fourFingerPxDesc", default: 15, min: 8, max: 40, unit: "px", reset: 15, refresh: "none",
  },
  {
    path: "gesture.autoPanMargin", field: "autoPanMargin", kind: "int", group: "gesture",
    label: "autoPanMarginLabel", default: 34, min: 16, max: 80, unit: "px", reset: 34, refresh: "none",
    visible: (s) => s.prefs.autoPan,
  },
  {
    path: "gesture.autoPanSpeed", field: "autoPanSpeed", kind: "int", group: "gesture",
    label: "autoPanSpeedLabel", default: 3, min: 1, max: 6, reset: 3, refresh: "none",
    visible: (s) => s.prefs.autoPan,
  },
  {
    path: "gesture.zoomMin", field: "zoomMin", kind: "enum", group: "gesture",
    label: "zoomMinLabel", default: "0.05", refresh: "none",
    options: [{ value: "0.05", label: "5%" }, { value: "0.1", label: "10%" }, { value: "0.25", label: "25%" }, { value: "0.5", label: "50%" }],
    get: (s) => String(s.prefs.zoomMin),
    set: (s, v) => { s.prefs.zoomMin = Number(v) || 0.05; },
  },
  {
    path: "gesture.zoomMax", field: "zoomMax", kind: "enum", group: "gesture",
    label: "zoomMaxLabel", default: "32", refresh: "none",
    options: [{ value: "8", label: "8×" }, { value: "16", label: "16×" }, { value: "32", label: "32×" }, { value: "64", label: "64×" }],
    get: (s) => String(s.prefs.zoomMax),
    set: (s, v) => { s.prefs.zoomMax = Number(v) || 32; },
  },
  {
    path: "gesture.haptic", field: "haptic", kind: "bool", group: "gesture",
    label: "hapticLabel", desc: "hapticDesc", default: true, refresh: "none",
    // a tick right when it is switched on, so the effect is obvious
    after: (s, v) => { if (v) bridge.vibrate(s.prefs.hapticLen, "开关"); },
    action: {
      label: "hapticTest",
      run: (s) => {
        const cap = bridge.canVibrate();
        const ms = s.prefs.hapticLen;
        const ok = bridge.vibrate(ms, "测试");
        // a second, clearly longer pulse 0.4s later so the two can be compared
        window.setTimeout(() => bridge.vibrate(120, "测试长"), 400);
        bridge.toast(ok ? "hapticTestOk" : cap === false ? "hapticTestNoMotor" : "hapticTestFail");
      },
    },
  },
  {
    path: "gesture.hapticLen", field: "hapticLen", kind: "enum", group: "gesture",
    label: "hapticLenLabel", desc: "hapticLenDesc", default: "60", refresh: "none",
    options: [
      { value: "30", label: "hapticLenShort" },
      { value: "60", label: "hapticLenMid" },
      { value: "100", label: "hapticLenLong" },
    ],
    get: (s) => String(s.prefs.hapticLen),
    set: (s, v) => { s.prefs.hapticLen = Math.max(20, Math.min(150, Number(v) || 60)); },
  },
  // one entry per gesture: which function it runs (see src/app/gestures.ts)
  ...GESTURES.map((g): SettingDef => ({
    control: "dropdown" as const,
    path: gesturePath(g.id),
    field: g.field as keyof Prefs,
    kind: "enum",
    group: "gesture",
    label: g.label,
    desc: g.desc,
    default: g.defaultAction,
    options: g.actions.map((a) => ({ value: a, label: GESTURE_ACTION_LABELS[a] })),
    refresh: "none",
  })),

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
  {
    // loop-aware onion skin: the frames before the first / after the last one
    // are shown too, in their own colour (blue / amber) so the wrap is obvious
    path: "onion.wrap", field: "onionWrap", kind: "bool", group: "onion",
    label: "onionWrapLabel", desc: "onionWrapDesc", default: true, refresh: "repaintAll",
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
    path: "display.previewGray", field: "previewGray", kind: "bool", group: "display",
    label: "previewGray", desc: "previewGrayDesc", default: false, refresh: "changed",
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
    path: "data.recordHistory", field: "recordHistory", kind: "bool", group: "data",
    label: "recordHistoryLabel", desc: "recordHistoryDesc", default: true, refresh: "none",
  },
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
  if (def.kind === "color") return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null;
  return opts.some((o) => o.value === v) ? v : null;
}
