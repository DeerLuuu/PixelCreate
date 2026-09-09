import {
  GUIDE, GUIDE_MODULES, guideActionsOf, guideProgress, guideStepsFor, guideStepsOfModule, versionGte,
  type GuideActionList,
} from "../src/app/guide";
import { eq, ok } from "./common";

export function testGuide(): void {
  // --- dotted version comparison ---
  ok("guide.ver.equal", versionGte("1.0.6.0", "1.0.6.0"));
  ok("guide.ver.newer-patch", versionGte("1.0.6.1", "1.0.6.0"));
  ok("guide.ver.newer-minor", versionGte("1.0.7", "1.0.6.9"));
  ok("guide.ver.newer-major", versionGte("2.0.0", "1.99.99"));
  ok("guide.ver.shorter-pad", versionGte("1.0.6", "1.0.6.0"));
  ok("guide.ver.older-patch", !versionGte("1.0.6.0", "1.0.6.1"));
  ok("guide.ver.older-minor", !versionGte("1.0.5.9", "1.0.6"));
  ok("guide.ver.garbage-safe", versionGte("1.x.6", "1.0.0")); // non-numbers read as 0

  // --- step selection: first run vs. incremental after a release ---
  {
    const all = guideStepsFor([], true);
    eq("guide.fresh.all", all.length, GUIDE.length);
    eq("guide.fresh.order", all[0].id, GUIDE[0].id);
  }
  {
    const seen = GUIDE.slice(0, 3).map((s) => s.id);
    const rest = guideStepsFor(seen, false);
    eq("guide.seen.remaining", rest.length, GUIDE.length - 3);
    ok("guide.seen.skips-seen", !rest.some((s) => seen.includes(s.id)));
  }
  {
    const all = GUIDE.map((s) => s.id);
    eq("guide.seen.nothing-left", guideStepsFor(all, false).length, 0);
  }

  // --- module grouping ---
  {
    const orbs = guideStepsOfModule("orbs");
    ok("guide.module.orbs", orbs.length >= 3 && orbs.every((s) => s.module === "orbs"));
    eq("guide.module.gestures", guideStepsOfModule("gestures").length, 6);
  }

  // --- every orb step pops docked balls out first (they may be parked away) ---
  {
    const orbs = guideStepsOfModule("orbs");
    const before = (s: { before?: string | string[] }): string[] => (Array.isArray(s.before) ? s.before : s.before ? [s.before] : []);
    // only steps that spotlight a ball itself need the dock popped out (the
    // palette-panel step points at the panel, not at an orb)
    const orbSteps = orbs.filter((s) => /^\[data-guide="orb-/.test(s.target ?? ""));
    ok("guide.orbs.undock-first", orbSteps.length > 0 && orbSteps.every((s) => before(s).includes("undockOrbs")));
    // the selection orb only exists while something is selected: the tour must
    // demonstrate a selection first and restore the previous state after
    const sel = orbs.find((s) => s.id === "orbs.sel");
    ok("guide.orbs.sel-demo-selection", !!sel && before(sel).includes("demoSelection"));
    ok("guide.orbs.sel-restore", !!sel && sel.after === "restoreSelection");
  }

  // --- progress label ---
  eq("guide.progress.first", guideProgress(0, 17), "1/17");
  eq("guide.progress.last", guideProgress(16, 17), "17/17");
  eq("guide.progress.clamped", guideProgress(20, 17), "17/17");

  // --- registry integrity: unique ids, known modules, version tags, i18n keys ---
  {
    const ids = new Set<string>();
    let dupes = 0, badModule = 0, badVersion = 0, missingCopy = 0;
    const modules = new Set(GUIDE_MODULES.map((m) => m.id));
    for (const s of GUIDE) {
      if (ids.has(s.id)) dupes++;
      ids.add(s.id);
      if (!modules.has(s.module)) badModule++;
      if (!/^\d+(\.\d+)*$/.test(s.since)) badVersion++;
      if (!s.title || !s.body) missingCopy++;
    }
    eq("guide.ids.unique", dupes, 0);
    eq("guide.modules.valid", badModule, 0);
    eq("guide.versions.valid", badVersion, 0);
    eq("guide.copy.present", missingCopy, 0);
    eq("guide.modules.count", GUIDE_MODULES.length, 6);
  }

  // --- steps that really tap a control declare a usable selector ---
  {
    const clicks = GUIDE.filter((s) => !!s.click);
    ok("guide.click.some", clicks.length >= 10, "clicks=" + clicks.length);
    eq("guide.click.selectors-sane", clicks.filter((s) => {
      const c = (s.click ?? "").trim();
      return !(c.startsWith("[") || c.startsWith("."));
    }).length, 0);
    // timeline.onion is driven by its before-demo instead of a tap: the demo
    // turns onion skin on itself, a tap would toggle the same switch off again
    const must = ["orbs.main", "orbs.pal", "tools.shape", "files.menu", "files.menuImport"];
    eq("guide.click.covered", must.filter((id) => !GUIDE.find((s) => s.id === id)?.click), []);
  }

  // --- interactive steps must carry a virtual-finger demo ---
  {
    const kinds = new Set(["tap", "doubleTap", "tripleTap", "oneFingerDraw", "twoFingerPinch", "twoFingerPan", "twoFingerDoubleTap", "fourFingerSwipe", "longPressDrag"]);
    const withDemo = GUIDE.filter((s) => !!s.demo);
    ok("guide.demo.some", withDemo.length >= 7, "demos=" + withDemo.length);
    eq("guide.demo.kinds-valid", GUIDE.filter((s) => s.demo && !kinds.has(s.demo)).length, 0);
    const must = ["canvas.area", "canvas.zoom", "orbs.main", "timeline.layerDrag",
      "gestures.doubleTap", "gestures.twoFingerTap", "gestures.tripleTap", "gestures.fourFinger"];
    const missing = must.filter((id) => !GUIDE.find((s) => s.id === id)?.demo);
    eq("guide.demo.interactive-covered", missing, []);
  }

  // --- steps that point at a menu item or tool must open it first ---
  {
    const acts = (s: { before?: string | string[] }): string[] => (Array.isArray(s.before) ? s.before : s.before ? [s.before] : []);
    // a step may open the container by its own real tap instead of a before action
    const opensByTap = (s: { click?: string }): boolean =>
      s.click === '[data-guide="btn-menu"]' || s.click === '[data-guide="orb-main"]' || s.click === '[data-guide="btn-timeline"]';
    const menuSteps = GUIDE.filter((s) => (s.target ?? "").startsWith('[data-guide="menu-'));
    ok("guide.menu.steps-exist", menuSteps.length >= 6, "menu steps=" + menuSteps.length);
    eq("guide.menu.open-first", menuSteps.filter((s) => !acts(s).includes("openMenu") && !opensByTap(s)).length, 0);
    const importSteps = GUIDE.filter((s) => /^\[data-guide="menu-import-/.test(s.target ?? ""));
    ok("guide.menu.import-submenu", importSteps.length >= 3 && importSteps.every((s) => acts(s).includes("menuSubImport")));
    // export / save moved out of the menu into the canvas orb: those steps must
    // open the canvas ring first
    const canvSteps = GUIDE.filter((s) => /^\[data-guide="canv-/.test(s.target ?? ""));
    ok("guide.canvas.ring-open-first", canvSteps.length >= 3 && canvSteps.every((s) => acts(s).includes("openCanvasRing")), "canvas steps=" + canvSteps.length);
    const toolSteps = GUIDE.filter((s) => /^\[data-guide="tool-/.test(s.target ?? ""));
    ok("guide.tools.ring-open-first", toolSteps.length >= 3 && toolSteps.every((s) => acts(s).includes("openToolRing") || opensByTap(s)));
    ok("guide.detail.total", GUIDE.length >= 30, "total=" + GUIDE.length);
  }

  // --- real, self-restoring demos: every one is paired with its undo -------
  {
    const acts = (l?: GuideActionList): string[] => guideActionsOf(l);
    const used = GUIDE.flatMap((s) => [...acts(s.before), ...acts(s.after)]);
    const known = new Set<string>([
      "openTimeline", "closeTimeline", "closeOverlays", "undockOrbs", "redockOrbs",
      "demoSelection", "restoreSelection", "demoStroke",
      "openToolRing", "closeToolRing", "toolSubShape", "toolSubSelect", "toolSubBack",
      "openMenu", "closeMenu", "menuSubImport", "menuSubBack",
      "openCanvasRing", "closeCanvasRing", "canvasMore", "canvasBack",
      "demoZoom", "demoZoomIn", "demoToolSwitch", "demoShapeTool", "demoMarquee",
      "demoBrushSize", "demoSwapColors", "demoSymmetry", "demoPalMode", "demoFx",
      "demoOnionFrame", "demoFramePreview",
      "demoSettings", "closeSettings", "demoChangelog", "closeChangelog", "closeOrbs",
      "openPalettePanel", "closePalettePanel", "demoExportRange", "closeExport", "demoFramePick",
      "demoBucketGrad",
    ]);
    eq("guide.demo.actions-known", used.filter((a) => !known.has(a)), []);
    // every real demo the app implements must actually be requested by a step
    const real = [
      "demoZoom", "demoZoomIn", "demoToolSwitch", "demoShapeTool", "demoMarquee",
      "demoBrushSize", "demoSwapColors", "demoSymmetry", "demoPalMode", "demoFx",
      "demoOnionFrame", "demoFramePreview", "demoSettings", "demoChangelog",
    ];
    eq("guide.demo.all-used", real.filter((a) => !used.includes(a)), []);
    // a dialog demo is always closed again by the same step, and keeps the
    // backdrop light so the dialog stays readable behind the spotlight
    for (const [open, close] of [["demoSettings", "closeSettings"], ["demoChangelog", "closeChangelog"]] as const) {
      const step = GUIDE.find((s) => acts(s.before).includes(open));
      ok("guide.demo." + open + "-closed", !!step && acts(step.after).includes(close));
      ok("guide.demo." + open + "-peek", !!step && step.peek === true);
      ok("guide.demo." + open + "-target", !!step && !!step.target);
    }
    // the four-finger step finishes by opening the real all-frames preview
    const ff = GUIDE.find((s) => s.id === "gestures.fourFinger");
    ok("guide.demo.frame-preview", !!ff && acts(ff.after).includes("demoFramePreview"));
    // the triple-tap step really zooms while it is on screen, so the canvas must
    // stay inside the spotlight (an "after" demo would play behind the next step)
    const tt = GUIDE.find((s) => s.id === "gestures.tripleTap");
    ok("guide.demo.triple-tap-visible", !!tt && tt.target === ".view-canvas" && acts(tt.before).includes("demoZoomIn"));
    // two-finger double-tap is a double tap, not a pan
    eq("guide.demo.two-finger-double-tap", GUIDE.find((s) => s.id === "gestures.twoFingerTap")?.demo, "twoFingerDoubleTap");
    // onion skin really steps a frame, so it needs at least two frames to show
    // onion skin really turns on and steps a frame while the step is shown; a
    // separate click would toggle the very same switch straight back off
    const onion = GUIDE.find((s) => s.id === "timeline.onion");
    ok("guide.demo.onion-frame", !!onion && acts(onion.before).includes("demoOnionFrame"));
    ok("guide.demo.onion-no-double-toggle", !!onion && !onion.click);
  }

  // --- targets: every selector is a plain CSS selector string ---
  {
    const bad = GUIDE.filter((s) => s.target && (s.target.trim() !== s.target || s.target.length === 0));
    eq("guide.targets.sane", bad.length, 0);
    const withTargets = GUIDE.filter((s) => !!s.target).length;
    ok("guide.targets.most-steps-point-somewhere", withTargets >= GUIDE.length - 5, "with targets=" + withTargets);
  }
}
