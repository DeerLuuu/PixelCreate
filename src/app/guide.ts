// Declarative onboarding guide registry.
//
// Like the settings registry, every step is declared once here: which space it
// belongs to, the version it arrived in (so a release only replays what is
// NEW), the real control it spotlights and its i18n copy. The overlay engine
// (src/ui/guide.tsx) knows nothing about the content, and the app only wires
// the targets and actions — adding a step = one entry + its strings.
export type GuideModule = "canvas" | "tools" | "orbs" | "timeline" | "files" | "gestures";

/** actions the host app can perform before/after a step (kept as ids so the
 *  registry stays free of app internals) */
export type GuideAction =
  | "openTimeline" | "closeTimeline" | "closeOverlays"
  | "undockOrbs" | "redockOrbs"
  | "demoSelection" | "restoreSelection" | "demoStroke"
  | "openToolRing" | "closeToolRing" | "toolSubShape" | "toolSubSelect" | "toolSubBack"
  | "openCanvasRing" | "closeCanvasRing" | "canvasMore" | "canvasBack"
  | "openMenu" | "closeMenu" | "menuSubImport" | "menuSubBack"
  // real, self-restoring demonstrations: the app performs the action for a
  // moment and then puts everything back (see src/ui/App.tsx), so the tour
  // never leaves the document, the history or the layout changed
  | "demoZoom" | "demoZoomIn" | "demoToolSwitch" | "demoShapeTool" | "demoMarquee"
  | "demoBrushSize" | "demoSwapColors" | "demoSymmetry"
  | "demoPalMode" | "demoFx"
  | "demoOnionFrame" | "demoFramePreview"
  | "demoSettings" | "closeSettings" | "demoChangelog" | "closeChangelog"
  | "closeOrbs"
  | "openPalettePanel" | "closePalettePanel"
  | "demoExportRange" | "closeExport" | "demoBucketGrad"
  | "demoFramePick";

/** a step may request several actions; they run in order */
export type GuideActionList = GuideAction | GuideAction[];

/** animated touch demo played inside the highlighted area: the guide shows the
 *  gesture with virtual finger dots instead of only describing it */
export type GuideDemoKind =
  | "tap" | "doubleTap" | "tripleTap"
  | "oneFingerDraw"
  | "twoFingerPinch" | "twoFingerPan"
  | "fourFingerSwipe"
  | "twoFingerDoubleTap"
  | "longPressDrag";

export interface GuideStep {
  /** unique id; recorded once the step has been shown */
  id: string;
  /** which space this teaches (used for grouping and for module replay) */
  module: GuideModule;
  /** dotted version this step first shipped in, e.g. "1.0.6.0" */
  since: string;
  /** i18n keys */
  title: string;
  body: string;
  /** CSS selector of the real control to highlight (omit = centred card) */
  target?: string;
  /** preferred bubble side; "auto" picks the side with the most room */
  place?: "auto" | "top" | "bottom" | "left" | "right";
  /** silently skipped when the target is not on screen right now */
  optional?: boolean;
  /** this step really opens a dialog: keep the backdrop light so the dialog
   *  behind the spotlight stays readable */
  peek?: boolean;
  /** run before showing the step (e.g. open the panel it points at) */
  before?: GuideActionList;
  /** run after leaving the step */
  after?: GuideActionList;
  /** animated virtual-finger demo of the gesture this step teaches */
  demo?: GuideDemoKind;
  /** REALLY tap this control when the step opens (simulated touch), so the app
   *  visibly performs the action instead of only describing it */
  click?: string;
  /** tap this control when leaving the step (e.g. close what was opened) */
  closeClick?: string;
}

export const GUIDE_MODULES: Array<{ id: GuideModule; label: string }> = [
  { id: "canvas", label: "guideModuleCanvas" },
  { id: "tools", label: "guideModuleTools" },
  { id: "orbs", label: "guideModuleOrbs" },
  { id: "timeline", label: "guideModuleTimeline" },
  { id: "files", label: "guideModuleFiles" },
  { id: "gestures", label: "guideModuleGestures" },
];

export const GUIDE: GuideStep[] = [
  // ------------------------------------------------------------- canvas
  {
    id: "canvas.area", module: "canvas", since: "1.0.6.0", target: ".view-canvas", place: "bottom", demo: "oneFingerDraw",
    before: "demoStroke",
    title: "guide.canvas.title", body: "guide.canvas.body",
  },
  {
    id: "canvas.zoom", module: "canvas", since: "1.0.6.0", target: ".view-canvas", place: "top", demo: "twoFingerPinch",
    // the view really zooms while the finger dots play, then goes back
    before: "demoZoom",
    title: "guide.zoom.title", body: "guide.zoom.body",
  },

  // -------------------------------------------------------------- tools
  {
    id: "tools.core", module: "tools", since: "1.0.6.0", target: '[data-guide="tool-pencil"]', place: "right",
    // the ring opens from this tap; the demo switches the active tool inside it
    click: '[data-guide="orb-main"]', before: "demoToolSwitch", peek: true,
    title: "guide.coreTools.title", body: "guide.coreTools.body",
  },
  {
    // bucket gradient: the two bottom-bar buttons appear while the bucket is active
    id: "tools.bucketGrad", module: "tools", since: "1.0.7.11", target: '[data-guide="btn-bucket-grad"]', place: "top", peek: true,
    before: "demoBucketGrad",
    title: "guide.bucketGrad.title", body: "guide.bucketGrad.body",
  },
  {
    id: "tools.shape", module: "tools", since: "1.0.6.0", target: '[data-guide="tool-line"]', place: "right",
    click: '[data-guide="tool-shape-group"]',
    before: ["openToolRing", "toolSubShape", "demoShapeTool"], optional: true, peek: true,
    title: "guide.shapeTools.title", body: "guide.shapeTools.body",
  },
  {
    id: "tools.select", module: "tools", since: "1.0.6.0", target: '[data-guide="tool-select"]', place: "right",
    click: '[data-guide="tool-select-group"]',
    before: ["openToolRing", "toolSubSelect", "demoMarquee"], optional: true, peek: true,
    title: "guide.selectTools.title", body: "guide.selectTools.body",
  },
  {
    id: "tools.brush", module: "tools", since: "1.0.6.0", target: ".cb-sliders", place: "top",
    before: ["closeToolRing", "demoBrushSize"],
    title: "guide.brush.title", body: "guide.brush.body",
  },
  {
    id: "tools.color", module: "tools", since: "1.0.6.0", target: ".colorpair", place: "top",
    before: "demoSwapColors",
    title: "guide.color.title", body: "guide.color.body",
  },
  {
    id: "tools.controls", module: "tools", since: "1.0.6.0", target: '[data-guide="btn-adjust"]', place: "top", peek: true,
    before: "demoSymmetry",
    title: "guide.controls.title", body: "guide.controls.body",
  },

  // --------------------------------------------------------------- orbs
  // a docked orb is parked in the storage area (not on screen), so every orb
  // step pops them out first; the app restores the dock when the tour ends
  {
    id: "orbs.main", module: "orbs", since: "1.0.6.0", target: '[data-guide="orb-main"]', place: "left", demo: "tap",
    click: '[data-guide="orb-main"]',
    before: "undockOrbs",
    title: "guide.orbMain.title", body: "guide.orbMain.body",
  },
  {
    id: "orbs.sel", module: "orbs", since: "1.0.6.0", target: '[data-guide="orb-sel"]', place: "left", optional: true,
    click: '[data-guide="orb-sel"]',
    // the selection orb only exists while something is selected, so the tour
    // demonstrates a selection first and restores the previous one afterwards
    before: ["undockOrbs", "demoSelection"], after: "restoreSelection",
    title: "guide.orbSel.title", body: "guide.orbSel.body",
  },
  {
    id: "orbs.pal", module: "orbs", since: "1.0.6.0", target: '[data-guide="orb-pal"]', place: "left", optional: true,
    click: '[data-guide="orb-pal"]',
    // the fan opens from this tap; the demo cycles the colour-source chip inside it
    before: ["undockOrbs", "demoPalMode"], peek: true,
    title: "guide.orbPal.title", body: "guide.orbPal.body",
  },
  {
    // palette panel: de-dupe / sort / merge
    id: "orbs.paletteOps", module: "orbs", since: "1.0.7", target: '[data-guide="pal-ops"]', place: "auto", peek: true,
    before: ["openPalettePanel"], after: "closePalettePanel",
    title: "guide.paletteOps.title", body: "guide.paletteOps.body",
  },
  {
    // canvas orb: everything that acts on the focused canvas, in two pages
    id: "orbs.canvas", module: "orbs", since: "1.0.7.11", target: '[data-guide="orb-canv"]', place: "left", optional: true,
    before: ["closeOrbs", "undockOrbs"],
    title: "guide.orbCanvas.title", body: "guide.orbCanvas.body",
  },
  {
    id: "orbs.fx", module: "orbs", since: "1.0.6.0", target: '[data-guide="orb-fx"]', place: "left", optional: true,
    click: '[data-guide="orb-fx"]',
    before: ["closeOrbs", "undockOrbs", "closeOverlays", "demoFx"], peek: true,
    title: "guide.orbFx.title", body: "guide.orbFx.body",
  },

  // ----------------------------------------------------------- timeline
  {
    id: "timeline.matrix", module: "timeline", since: "1.0.6.0", target: ".tline-wrap", place: "top",
    click: '[data-guide="btn-timeline"]',
    after: "closeTimeline",
    title: "guide.timeline.title", body: "guide.timeline.body",
  },
  {
    id: "timeline.layerDrag", module: "timeline", since: "1.0.6.0", target: ".ase-lcell", place: "right", optional: true, demo: "longPressDrag",
    before: "openTimeline", after: "closeTimeline",
    title: "guide.layerDrag.title", body: "guide.layerDrag.body",
  },
  {
    // the tour really turns pick mode on and ticks two frame numbers
    id: "timeline.frameSel", module: "timeline", since: "1.0.7", target: '[data-guide="btn-framesel"]', place: "top", optional: true, peek: true,
    before: ["openTimeline", "demoFramePick"], closeClick: '[data-guide="btn-framesel-exit"]', after: "closeTimeline",
    title: "guide.frameSel.title", body: "guide.frameSel.body",
  },
  {
    id: "timeline.onion", module: "timeline", since: "1.0.6.0", target: '[data-guide="btn-onion"]', place: "top", optional: true, peek: true,
    before: ["openTimeline", "demoOnionFrame"], after: "closeTimeline",
    title: "guide.onion.title", body: "guide.onion.body",
  },

  // -------------------------------------------------------------- files
  {
    id: "files.topbar", module: "files", since: "1.0.6.0", target: ".topbar", place: "bottom",
    title: "guide.topbar.title", body: "guide.topbar.body",
  },
  {
    id: "files.undo", module: "files", since: "1.0.6.0", target: '[data-guide="btn-undo"]', place: "bottom",
    title: "guide.undo.title", body: "guide.undo.body",
  },
  {
    // per-canvas save: the canvas orb page 1 (the toolbar no longer has it)
    id: "files.save", module: "files", since: "1.0.6.0", target: '[data-guide="canv-save"]', place: "auto",
    before: ["openCanvasRing"], after: "closeCanvasRing",
    title: "guide.save.title", body: "guide.save.body",
  },
  {
    id: "files.export", module: "files", since: "1.0.6.0", target: '[data-guide="canv-more"]', place: "auto",
    before: ["openCanvasRing"], after: "closeCanvasRing",
    title: "guide.export.title", body: "guide.export.body",
  },
  // --- the main menu, opened for real by the tour ---
  {
    id: "files.menu", module: "files", since: "1.0.6.0", target: '[data-guide="menu-new"]', place: "right",
    click: '[data-guide="btn-menu"]',
    before: ["closeOverlays", "menuSubBack"],
    title: "guide.menu.title", body: "guide.menu.body",
  },
  {
    id: "files.menuSave", module: "files", since: "1.0.6.0", target: '[data-guide="menu-save"]', place: "right",
    before: ["openMenu", "menuSubBack"],
    title: "guide.menuSave.title", body: "guide.menuSave.body",
  },
  {
    id: "files.menuImport", module: "files", since: "1.0.6.0", target: '[data-guide="menu-import"]', place: "right",
    click: '[data-guide="menu-import"]',
    before: ["openMenu", "menuSubBack"],
    title: "guide.menuImport.title", body: "guide.menuImport.body",
  },
  {
    id: "files.importImg", module: "files", since: "1.0.6.0", target: '[data-guide="menu-import-img"]', place: "right",
    before: ["openMenu", "menuSubImport"],
    title: "guide.importImg.title", body: "guide.importImg.body",
  },
  {
    id: "files.importSheet", module: "files", since: "1.0.6.0", target: '[data-guide="menu-import-sheet"]', place: "right",
    before: ["openMenu", "menuSubImport"],
    title: "guide.importSheet.title", body: "guide.importSheet.body",
  },
  {
    id: "files.refImg", module: "files", since: "1.0.6.0", target: '[data-guide="menu-import-ref"]', place: "right",
    before: ["openMenu", "menuSubImport"],
    title: "guide.refImg.title", body: "guide.refImg.body",
  },
  {
    // the export entry lives on the canvas orb's second page now
    id: "files.menuExport", module: "files", since: "1.0.6.0", target: '[data-guide="canv-export"]', place: "auto",
    before: ["openCanvasRing", "canvasMore"], after: "closeCanvasRing",
    title: "guide.menuExport.title", body: "guide.menuExport.body",
  },
  {
    id: "files.exportDialog", module: "files", since: "1.0.6.0", target: '[data-guide="dlg-export"]', place: "auto", peek: true,
    before: ["closeCanvasRing", "demoExportRange"], after: "closeExport",
    title: "guide.exportDialog.title", body: "guide.exportDialog.body",
  },
  {
    // the real export dialog, opened on the GIF tab so the range row is there
    id: "files.exportRange", module: "files", since: "1.0.7", target: '[data-guide="exp-range"]', place: "auto", peek: true,
    before: ["closeMenu", "demoExportRange"], after: "closeExport",
    title: "guide.exportRange.title", body: "guide.exportRange.body",
  },
  {
    // palette import/export lives in the palette panel now
    id: "files.exportPalette", module: "files", since: "1.0.6.0", target: '[data-guide="pal-export"]', place: "auto",
    before: ["openPalettePanel"], after: "closePalettePanel",
    title: "guide.exportPalette.title", body: "guide.exportPalette.body",
  },
  {
    // operation history is stored inside the project file
    id: "files.history", module: "files", since: "1.0.7.3", target: '[data-guide="menu-save"]', place: "right",
    before: ["openMenu", "menuSubBack"],
    title: "guide.history.title", body: "guide.history.body",
  },
  {
    // the tour opens the real Settings dialog for this step, so the user sees
    // what is inside it instead of only the menu entry that leads there
    id: "files.menuSettings", module: "files", since: "1.0.6.0", target: '[data-guide="dlg-settings"]', place: "auto", peek: true,
    before: ["closeMenu", "demoSettings"], after: "closeSettings",
    title: "guide.menuSettings.title", body: "guide.menuSettings.body",
  },
  {
    // search / reset one row / settings file import-export
    id: "files.settingsSearch", module: "files", since: "1.0.7", target: '[data-guide="set-search"]', place: "auto", peek: true,
    before: ["closeMenu", "demoSettings"], after: "closeSettings",
    title: "guide.settingsSearch.title", body: "guide.settingsSearch.body",
  },
  {
    // same idea: the real changelog list is opened and highlighted
    id: "files.menuChangelog", module: "files", since: "1.0.6.0", target: '[data-guide="dlg-changelog"]', place: "auto", peek: true,
    before: ["closeMenu", "demoChangelog"], after: "closeChangelog",
    title: "guide.menuChangelog.title", body: "guide.menuChangelog.body",
  },
  {
    id: "files.menuGuide", module: "files", since: "1.0.6.0", target: '[data-guide="menu-guide"]', place: "right",
    before: ["openMenu", "menuSubBack"], after: "closeMenu",
    title: "guide.menuGuide.title", body: "guide.menuGuide.body",
  },

  // ----------------------------------------------------------- gestures
  {
    id: "gestures.doubleTap", module: "gestures", since: "1.0.6.0", demo: "doubleTap",
    title: "guide.doubleTap.title", body: "guide.doubleTap.body",
  },
  {
    id: "gestures.twoFingerTap", module: "gestures", since: "1.0.6.0", demo: "twoFingerDoubleTap",
    title: "guide.twoFingerTap.title", body: "guide.twoFingerTap.body",
  },
  {
    id: "gestures.tripleTap", module: "gestures", since: "1.0.6.0", target: ".view-canvas", place: "top", demo: "tripleTap",
    // the canvas really zooms 2x while the step is on screen, then goes back
    before: "demoZoomIn",
    title: "guide.tripleTap.title", body: "guide.tripleTap.body",
  },
  {
    id: "gestures.back", module: "gestures", since: "1.0.7",
    title: "guide.back.title", body: "guide.back.body",
  },
  {
    // the mapping lives in Settings -> Gestures & Touch
    id: "gestures.map", module: "gestures", since: "1.0.7.3",
    title: "guide.gestures.title", body: "guide.gestures.body",
  },
  {
    id: "gestures.fourFinger", module: "gestures", since: "1.0.6.0", demo: "fourFingerSwipe",
    // finishing the tour really opens the all-frames preview, then closes it
    after: "demoFramePreview",
    title: "guide.fourFinger.title", body: "guide.fourFinger.body",
  },
];

/** dotted version compare: a >= b (missing parts count as 0) */
export function versionGte(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/**
 * Steps the user still needs to see, in declaration order.
 *  - first run (no record at all): everything
 *  - after a release: only the steps that did not exist last time
 */
export function guideStepsFor(seen: readonly string[], fresh: boolean): GuideStep[] {
  if (fresh) return GUIDE.slice();
  const have = new Set(seen);
  return GUIDE.filter((s) => !have.has(s.id));
}

/** steps of one module (used by the "replay this section" entry point) */
export function guideStepsOfModule(module: GuideModule): GuideStep[] {
  return GUIDE.filter((s) => s.module === module);
}

export function guideProgress(index: number, total: number): string {
  return `${Math.min(index + 1, total)}/${total}`;
}

/** flatten a step's before/after declaration into a list of actions */
export function guideActionsOf(list: GuideActionList | undefined): GuideAction[] {
  return !list ? [] : Array.isArray(list) ? list : [list];
}
