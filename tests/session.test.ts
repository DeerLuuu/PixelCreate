import { Session } from "../src/app/session";
import {
  SETTINGS, SETTING_GROUPS, settingsOfGroup, coerceSetting, exportSettings, importSettings, isDefault, resetSetting,
} from "../src/app/settings";
import { GESTURES, GESTURE_ACTIONS, gesturePath, isActionAllowed } from "../src/app/gestures";
import { History } from "../src/engine/history";
import { scalarActions } from "../src/app/history-io";
import * as historyFile from "../src/io/historyfile";
import * as bridge from "../src/io/bridge";
import { eq, ok } from "./common";

/** minimal DOM-less environment for Session (no View attached) */
function stubEnv(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g.window) g.window = {};
  const w = g.window as Record<string, unknown>;
  w.setTimeout = () => 1;
  w.clearTimeout = () => {};
  w.setInterval = () => 1;
  w.clearInterval = () => {};
  w.addEventListener = () => {};
  w.removeEventListener = () => {};
  w.dispatchEvent = () => {};
  w.PixelBridge = { toast: () => {}, vibrate: () => true };
  // stateful in-memory localStorage so persistence round trips can be tested
  const store = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
}

export function testSession(): void {
  stubEnv();
  const s = new Session();

  // --- frame switching is recorded as its own undo step ---
  s.frameAdd(); // second frame (records "frame-add")
  eq("session.frames.count", s.doc.frames.length, 2);
  s.history.clear();

  eq("session.switch.start", s.curFrame(), 0);
  s.setFrame(1);
  eq("session.switch.moved", s.curFrame(), 1);
  ok("session.switch.recorded", s.history.canUndo());
  s.undo();
  eq("session.switch.undo", s.curFrame(), 0);
  s.redo();
  eq("session.switch.redo", s.curFrame(), 1);

  // --- switching to the frame you are already on records nothing ---
  s.history.clear();
  s.setFrame(1);
  ok("session.switch.same-frame-no-record", !s.history.canUndo());

  // --- playback must NOT pollute the undo history ---
  s.setFrame(0);
  s.history.clear();
  s.loopMode = "loop";
  s.startPlayback();
  s.stopPlayback();
  ok("session.play.no-record", !s.history.canUndo());

  // --- history listing shows the frame switch label ---
  s.history.clear();
  s.setFrame(1);
  const list = s.history.list();
  eq("session.switch.label", list.labels[list.labels.length - 1], "frame-switch");

  // --- layer drag reorder is a single undoable step ---
  s.layerAdd();
  s.layerAdd();
  eq("session.layers.count", s.doc.layers.length, 3);
  s.history.clear();
  const firstName = s.doc.layers[0].name;
  s.layerMoveTo(0, 2);
  eq("session.layer-move.applied", s.doc.layers[2].name, firstName);
  ok("session.layer-move.recorded", s.history.canUndo());
  s.undo();
  eq("session.layer-move.undo", s.doc.layers[0].name, firstName);

  // --- bucket mode + recent colours bookkeeping ---
  eq("session.bucket.default", s.prefs.bucketGlobal, false);
  s.setBucketGlobal(true);
  eq("session.bucket.on", s.prefs.bucketGlobal, true);

  s.setRecentColorsMax(4);
  for (let i = 0; i < 6; i++) s.pushRecentColor([i, 0, 0, 255]);
  eq("session.recent.capped", s.recentColors.length, 4);
  eq("session.recent.newest-first", s.recentColors[0], [5, 0, 0, 255]);
  s.pushRecentColor([3, 0, 0, 255]); // already in the list -> moves to front, no dupe
  eq("session.recent.dedupe", s.recentColors[0], [3, 0, 0, 255]);
  eq("session.recent.dedupe-len", s.recentColors.length, 4);

  // --- doc colours are collected from the canvas ---
  const cel = s.doc.ensureCel(0, 0);
  cel.data[0] = 10; cel.data[1] = 20; cel.data[2] = 30; cel.data[3] = 255;
  cel.data[4] = 10; cel.data[5] = 20; cel.data[6] = 30; cel.data[7] = 255;
  cel.data[8] = 200; cel.data[9] = 0; cel.data[10] = 0; cel.data[11] = 255;
  const cols = s.docColors();
  eq("session.doc-colors.count", cols.length, 2);
  ok("session.doc-colors.has", cols.some((c) => c[0] === 200 && c[3] === 255));

  // --- palette floater colour sources (fan menu) ---
  eq("session.palOrb.default", s.palOrbMode, "palette");
  eq("session.palOrb.palette", s.palOrbColors(), s.doc.palette);
  s.cyclePalOrbMode();
  eq("session.palOrb.doc-mode", s.palOrbMode, "doc");
  eq("session.palOrb.doc-colors", s.palOrbColors().length, s.docColors().length);
  s.cyclePalOrbMode();
  eq("session.palOrb.recent-mode", s.palOrbMode, "recent");
  eq("session.palOrb.recent-colors", s.palOrbColors(), s.recentColors);
  s.cyclePalOrbMode();
  eq("session.palOrb.wrap", s.palOrbMode, "palette");

  // --- loop mode cycles and persists into prefs ---
  s.loopMode = "once";
  eq("session.loop.cycle1", s.cycleLoopMode(), "loop");
  eq("session.loop.cycle2", s.cycleLoopMode(), "pingpong");
  eq("session.loop.prefs", s.prefs.loopMode, "pingpong");

  // --- onion skin setters drive the prefs used by the compositor ---
  s.setOnionOn(true);
  s.setOnionBefore(2);
  s.setOnionAfter(1);
  s.setOnionAlpha(80);
  s.setOnionTint(false);
  eq("session.onion.prefs", [s.prefs.onionOn, s.prefs.onionBefore, s.prefs.onionAfter, s.prefs.onionAlpha, s.prefs.onionTint], [true, 2, 1, 80, false]);

  // --- Godot-style settings registry ---
  eq("settings.default.lang", s.settingValue("general.language"), "zh");
  s.setSetting("general.language", "en");
  eq("settings.set.enum", s.prefs.lang, "en");
  s.setSetting("general.language", "fr"); // invalid choice is rejected
  eq("settings.reject.enum", s.prefs.lang, "en");

  s.setSetting("canvas.gridSize", 999); // clamped to the declared maximum
  eq("settings.clamp.max", s.prefs.gridSize, 32);
  s.setSetting("canvas.gridSize", -5);
  eq("settings.clamp.min", s.prefs.gridSize, 1);
  s.setSetting("canvas.grid", "iso"); // after-hook raises a too-tiny iso spacing
  eq("settings.after.iso-default", s.prefs.gridSize, 8);
  eq("settings.read.enum", s.settingValue("canvas.grid"), "iso");

  s.setSetting("canvas.autoPan", false);
  eq("settings.set.bool", s.prefs.autoPan, false);
  s.setSetting("canvas.autoPan", 1); // coerced to bool
  eq("settings.coerce.bool", s.prefs.autoPan, true);

  // custom getter/setter pair (bool stored, enum exposed)
  eq("settings.custom.get.cur", s.settingValue("display.shadowTarget"), "cur");
  s.setSetting("display.shadowTarget", "new");
  eq("settings.custom.set", s.prefs.shadowNewLayer, true);
  eq("settings.custom.get.new", s.settingValue("display.shadowTarget"), "new");

  // dependency visibility: onion details only exist while onion is on
  s.setSetting("onion.enabled", false);
  ok("settings.visible.hidden", !settingsOfGroup(s, "onion").some((d) => d.path === "onion.alpha"));
  s.setSetting("onion.enabled", true);
  ok("settings.visible.shown", settingsOfGroup(s, "onion").some((d) => d.path === "onion.alpha"));
  s.setSetting("onion.before", 2);
  eq("settings.onion.before", s.prefs.onionBefore, 2);

  // wand tolerance now persists through prefs (was a session-only field)
  s.setSetting("tools.wandTolerance", 20);
  eq("settings.wand.prefs", s.prefs.selectionTolerance, 20);
  eq("settings.wand.getter", s.selectionTolerance, 20);

  // history mode/steps side effect reaches the stack cap
  s.setSetting("history.steps", 30);
  eq("settings.hist.steps", s.prefs.histSteps, 30);
  eq("settings.hist.cap", s.history.limit(), 30);

  // every declared setting must resolve to a concrete value
  let unresolved = 0;
  for (const d of SETTINGS) {
    const v = s.settingValue(d.path);
    if (v === undefined || v === null) unresolved++;
  }
  eq("settings.all-resolve", unresolved, 0);

  // --- full screen / safe area + live timeline height (drag handle) ---
  {
    ok("screen.group-present", SETTING_GROUPS.some((g) => g.id === "screen"));
    eq("screen.group-settings", settingsOfGroup(s, "screen").length, 3);
    s.setSetting("screen.safeArea", false);
    eq("screen.safeArea.off", s.prefs.safeArea, false);
    s.setSetting("screen.safeExtra", 24);
    eq("screen.safeExtra.set", s.prefs.safeExtra, 24);
    s.setSetting("screen.immersive", false);
    eq("screen.immersive.off", s.prefs.immersive, false);
    s.savePrefs();
    const raw = JSON.parse((globalThis as unknown as { localStorage: { getItem(k: string): string } }).localStorage.getItem("pc.prefs"));
    eq("screen.persist", [raw.safeArea, raw.safeExtra, raw.immersive], [false, 24, false]);
    s.setTlHeight(9999);
    eq("timeline.drag.clamp-max", s.prefs.tlH, 400);
    s.setTlHeight(1);
    eq("timeline.drag.clamp-min", s.prefs.tlH, 56);
    s.setTlHeight(180);
    eq("timeline.drag.set", s.prefs.tlH, 180);
    s.setSetting("canvas.timelineHeight", 400);
    eq("timeline.setting.max", s.prefs.tlH, 400);
    s.setSetting("canvas.timelineHeight", 116);
  }

  // --- haptics: the tick is gated by the switch and uses the chosen length ---
  {
    s.setSetting("gesture.hapticLen", "100");
    eq("settings.haptic.len", s.prefs.hapticLen, 100);
    const before = bridge.hapticLog.length;
    s.setSetting("gesture.haptic", false);
    eq("settings.haptic.off-no-call", s.hapticTick("测试"), false);
    eq("settings.haptic.off-log", bridge.hapticLog.length, before);
    s.setSetting("gesture.haptic", true);
    eq("settings.haptic.on-call", s.hapticTick("测试"), true);
    const last = bridge.hapticLog[bridge.hapticLog.length - 1];
    eq("settings.haptic.tag", last.tag, "测试");
    eq("settings.haptic.ms", last.ms, 100);
    s.savePrefs();
    const raw = JSON.parse((globalThis as unknown as { localStorage: { getItem(k: string): string } }).localStorage.getItem("pc.prefs"));
    eq("settings.haptic.persist", raw.hapticLen, 100);
  }

  // --- remembered tool / colour / symmetry / document state ---
  {
    (globalThis as unknown as { localStorage: { clear(): void } }).localStorage.clear();
    const a = new Session();
    a.setBrushSize(7);
    a.setBrushShape("square");
    a.setShapeSides(9);
    a.setShapeFill(false);
    a.setShapeFromCenter(true);
    a.setTool("eraser");
    a.setCurrentShape("ellipse");
    a.setCurrentSelect("wand");
    a.cycleSym();                 // off -> on
    a.setSymFour(true);
    a.setSymLocked(true);
    a.setFgColor([1, 2, 3, 255]);
    a.setPalette([[10, 20, 30, 255], [40, 50, 60, 255]]);
    a.savePrefs();

    const b = new Session();
    eq("persist.brushSize", b.brushSize, 7);
    eq("persist.brushShape", b.brushShape, "square");
    eq("persist.shapeSides", b.shapeSides, 9);
    eq("persist.shapeFill", b.shapeFill, false);
    eq("persist.shapeFromCenter", b.shapeFromCenter, true);
    eq("persist.tool", b.tool, "eraser");
    eq("persist.currentShape", b.currentShape, "ellipse");
    eq("persist.currentSelect", b.currentSelect, "wand");
    eq("persist.sym", b.sym, "on");
    eq("persist.symFour", b.symFour, true);
    eq("persist.symLocked", b.symLocked, true);
    eq("persist.fg", b.fg, [1, 2, 3, 255]);
    eq("persist.palette", b.doc.palette, [[10, 20, 30, 255], [40, 50, 60, 255]]);

    // symmetry axis changes are remembered too
    const c = new Session();
    c.symAng = 45;
    c.symOx = 3;
    c.symOy = -2;
    c.rememberSym();
    c.savePrefs();
    const d = new Session();
    eq("persist.symAng", d.symAng, 45);
    eq("persist.symOx", d.symOx, 3);
    eq("persist.symOy", d.symOy, -2);
  }

  // --- gesture / touch settings ---
  {
    (globalThis as unknown as { localStorage: { clear(): void } }).localStorage.clear();
    const a = new Session();
    a.setSetting("gesture.longPressMs", 500);
    a.setSetting("gesture.doubleTapMs", 300);
    a.setSetting("gesture.tripleTapZoom", 4);
    a.setSetting("gesture.fourFingerPx", 25);
    a.setSetting("gesture.autoPanMargin", 60);
    a.setSetting("gesture.autoPanSpeed", 6);
    a.setSetting("gesture.zoomMin", "0.25");
    a.setSetting("gesture.zoomMax", "64");
    a.setSetting("gesture.haptic", false);
    const b = new Session();
    eq("gesture.longPress", b.prefs.longPressMs, 500);
    eq("gesture.doubleTap", b.prefs.doubleTapMs, 300);
    eq("gesture.tripleZoom", b.prefs.tripleTapZoom, 4);
    eq("gesture.fourFinger", b.prefs.fourFingerPx, 25);
    eq("gesture.autoPanMargin", b.prefs.autoPanMargin, 60);
    eq("gesture.autoPanSpeed", b.prefs.autoPanSpeed, 6);
    eq("gesture.zoomMin", b.prefs.zoomMin, 0.25);
    eq("gesture.zoomMax", b.prefs.zoomMax, 64);
    eq("gesture.haptic", b.prefs.haptic, false);
    // out-of-range values are clamped on load
    (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem(
      "pc.prefs", JSON.stringify({ longPressMs: 9999, fourFingerPx: 1, zoomMin: 0.5, zoomMax: 0.6 }));
    const c = new Session();
    eq("gesture.clamp.longPress", c.prefs.longPressMs, 800);
    eq("gesture.clamp.fourFinger", c.prefs.fourFingerPx, 8);
    ok("gesture.clamp.zoomRange", c.prefs.zoomMax > c.prefs.zoomMin, c.prefs.zoomMin + "/" + c.prefs.zoomMax);
  }

  // --- gesture -> action mapping ---
  {
    // registry integrity
    const ids = new Set(GESTURES.map((g) => g.id));
    eq("gesture.ids.unique", ids.size, GESTURES.length);
    ok("gesture.every-default-allowed", GESTURES.every((g) => g.actions.includes(g.defaultAction)));
    ok("gesture.every-action-known", GESTURE_ACTIONS.length >= 12 && GESTURES.every((g) => g.actions.every((a) => GESTURE_ACTIONS.some((x) => x.id === a))));
    ok("gesture.pick-only-where-sensible", isActionAllowed("longPress", "pickColor") && !isActionAllowed("doubleTapMargin", "pickColor"));
    ok("gesture.bad-id", !isActionAllowed("nope" as never, "undo"));
    // every gesture has a settings entry with matching options
    for (const g of GESTURES) {
      const def = SETTINGS.find((d) => d.path === gesturePath(g.id));
      ok("gesture.setting." + g.id, !!def && def.kind === "enum" && def.default === g.defaultAction, def ? "" : "missing");
      eq("gesture.setting.options." + g.id, (def?.options ?? []).map((o) => o.value), g.actions);
    }

    // the mapping rows are rendered as dropdowns (palette-sort style)
    for (const g of GESTURES) {
      const def = SETTINGS.find((d) => d.path === gesturePath(g.id));
      eq("gesture.control." + g.id, def?.control, "dropdown");
    }
    ok("gesture.drop.long-list", (SETTINGS.find((d) => d.path === "tools.defaultTool")?.options?.length ?? 0) > 6);

    // dispatcher: session-level actions really run
    (globalThis as unknown as { localStorage: { clear(): void } }).localStorage.clear();
    const g = new Session();
    g.setPalette([[1, 2, 3, 255], [4, 5, 6, 255]]);
    g.history.clear();
    g.paletteRemove(0);
    ok("gesture.can-undo", g.history.canUndo());
    ok("gesture.undo", g.runGestureAction("undo"));
    eq("gesture.undo.result", g.doc.palette.length, 2);
    ok("gesture.redo", g.runGestureAction("redo"));
    eq("gesture.redo.result", g.doc.palette.length, 1);
    ok("gesture.none", !g.runGestureAction("none"));
    const grid0 = g.prefs.gridMode;
    ok("gesture.grid", g.runGestureAction("toggleGrid"));
    ok("gesture.grid.changed", g.prefs.gridMode !== grid0);
    const onion0 = g.prefs.onionOn;
    ok("gesture.onion", g.runGestureAction("toggleOnion"));
    ok("gesture.onion.changed", g.prefs.onionOn !== onion0);
    const sym0 = g.sym;
    ok("gesture.sym", g.runGestureAction("toggleSymmetry"));
    ok("gesture.sym.changed", g.sym !== sym0);
    // frame navigation clamps at the ends
    g.runGestureAction("nextFrame");
    eq("gesture.nextFrame.clamp", g.curFrame(), 0);
    // the mapping survives a restart
    g.setSetting("gesture.doubleTapMargin", "redo");
    g.setSetting("gesture.fourFinger", "toggleGrid");
    const h = new Session();
    eq("gesture.persist.margin", h.prefs.gDoubleTapMargin, "redo");
    eq("gesture.persist.four", h.prefs.gFourFinger, "toggleGrid");
    // invalid stored values fall back to the default
    (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem(
      "pc.prefs", JSON.stringify({ gDoubleTapMargin: "explode" }));
    const k = new Session();
    eq("gesture.invalid.fallback", k.prefs.gDoubleTapMargin, "undo");
  }

  // --- operation history inside project files ---
  {
    (globalThis as unknown as { localStorage: { clear(): void } }).localStorage.clear();
    const s2 = new Session();
    const doc = s2.doc;
    const cel = doc.ensureCel(0, 0);
    const before = new Uint8ClampedArray(cel.data);
    cel.data[0] = 200; cel.data[3] = 255;
    s2.history.pushPixels("stroke", doc, [{ li: 0, fi: 0, before, after: new Uint8ClampedArray(cel.data) }]);
    s2.layerAdd();                 // struct snapshot step
    s2.toggleLayerVisible(0);      // scalar step (hides layer 0)
    eq("hist.steps", s2.history.list().labels.length, 3);

    const dump = s2.history.dump();
    eq("hist.dump.count", dump.entries.length, 3);
    eq("hist.dump.index", dump.index, 3);
    eq("hist.dump.kinds", dump.entries.map((e) => e.kind), ["pixels", "struct", "scalar"]);

    // encode -> JSON -> decode (this is what a .pxc file carries)
    const enc = historyFile.encodeHistory(dump, doc.w, doc.h);
    ok("hist.encode.some", !!enc);
    const round = historyFile.decodeHistory(JSON.parse(JSON.stringify(enc)));
    ok("hist.decode", !!round && round.entries.length === 3);

    // load into a fresh stack bound to the same document, then undo everything
    const h2 = new History();
    h2.loadDump(round!, { doc, scalarActions: (d) => scalarActions(d, { doc, showFrame: () => {} }) });
    eq("hist.load.can-undo", h2.canUndo(), true);
    eq("hist.load.index", h2.list().index, 3);
    h2.undo();
    h2.undo();
    h2.undo();
    eq("hist.undo.pixel", doc.celAt(0, 0)?.data[3] ?? -1, 0);
    eq("hist.undo.layers", doc.layers.length, 1);
    eq("hist.undo.visible", doc.layers[0].visible, true);
    h2.redo();
    h2.redo();
    h2.redo();
    eq("hist.redo.pixel", doc.celAt(0, 0)?.data[3] ?? -1, 255);
    eq("hist.redo.layers", doc.layers.length, 2);
    eq("hist.redo.visible", doc.layers[0].visible, false);

    // a step with no serializable payload truncates everything older
    s2.history.record("opaque-step", { apply: () => {}, unapply: () => {} });
    s2.toggleLayerVisible(0);
    const d2 = s2.history.dump();
    eq("hist.truncate.count", d2.entries.length, 1);
    eq("hist.truncate.index", d2.index, 1);
    eq("hist.truncate.kind", d2.entries[0].kind, "scalar");

    // frame switching is part of the history too
    s2.frameAdd();
    s2.setFrame(1);
    const d3 = s2.history.dump();
    const last = d3.entries[d3.entries.length - 1];
    eq("hist.frame-switch.kind", last.kind, "scalar");
    eq("hist.frame-switch.data", (last.data as { k: string }).k, "frame-switch");

    // the setting controls whether saves carry it
    eq("hist.setting.default", s2.prefs.recordHistory, true);
    s2.setSetting("data.recordHistory", false);
    const s3 = new Session();
    eq("hist.setting.persist", s3.prefs.recordHistory, false);
  }

  // --- user-saved palettes ---
  {
    const p = new Session();
    p.setPalette([[255, 0, 0, 255], [0, 255, 0, 255]]);
    eq("mypal.empty", p.myPalettes.length, 0);
    const name = p.savePalettePreset();
    ok("mypal.saved-name", name.length > 0, name);
    eq("mypal.count", p.myPalettes.length, 1);
    eq("mypal.colors", p.myPalettes[0].colors, ["#ff0000", "#00ff00"]);
    const custom = p.savePalettePreset("My set");
    eq("mypal.custom-name", custom, "My set");
    eq("mypal.count2", p.myPalettes.length, 2);
    const id = p.myPalettes[0].id;
    ok("mypal.delete", p.deletePalettePreset(id));
    eq("mypal.after-delete", p.myPalettes.length, 1);
    eq("mypal.delete.missing", p.deletePalettePreset("nope"), false);
  }

  // --- settings: per-row reset + file export/import ---
  {
    (globalThis as unknown as { localStorage: { clear(): void } }).localStorage.clear();
    const g = new Session();
    const intDef = SETTINGS.find((d) => d.path === "onion.before")!;
    const boolDef = SETTINGS.find((d) => d.path === "onion.tint")!;
    const enumDef = SETTINGS.find((d) => d.path === "display.previewBg")!;

    ok("settings.isdefault.true", isDefault(g, intDef));
    g.setSetting("onion.before", 3);
    ok("settings.isdefault.false", !isDefault(g, intDef));
    resetSetting(g, intDef);
    eq("settings.reset", g.settingValue("onion.before"), 1);
    ok("settings.reset.idempotent", isDefault(g, intDef));

    // coercion of values coming from a file
    eq("settings.coerce.bool.true", coerceSetting(boolDef, "true"), true);
    eq("settings.coerce.bool.one", coerceSetting(boolDef, 1), true);
    eq("settings.coerce.bool.bad", coerceSetting(boolDef, "yes"), undefined);
    eq("settings.coerce.int.clamp", coerceSetting(intDef, 99), 3);
    eq("settings.coerce.int.round", coerceSetting(intDef, "2.6"), 3);
    eq("settings.coerce.int.bad", coerceSetting(intDef, "abc"), undefined);
    eq("settings.coerce.enum.ok", coerceSetting(enumDef, "black"), "black");
    eq("settings.coerce.enum.bad", coerceSetting(enumDef, "purple"), undefined);

    // export -> import round trip
    g.setSetting("onion.before", 2);
    g.setSetting("display.previewBg", "black");
    const file = exportSettings(g);
    eq("settings.export.app", file.app, "PixelCraft");
    eq("settings.export.version", file.version, 1);
    ok("settings.export.all-paths", Object.keys(file.values).length === SETTINGS.length, "n=" + Object.keys(file.values).length);
    const h = new Session();
    const r = importSettings(h, file);
    eq("settings.import.applied", r.applied, SETTINGS.length);
    eq("settings.import.value", h.settingValue("onion.before"), 2);
    eq("settings.import.enum", h.settingValue("display.previewBg"), "black");

    // unknown keys are ignored, invalid values are skipped, ints are clamped
    const r2 = importSettings(h, { values: { "onion.before": 99, "nope.x": 1, "display.previewBg": "purple" } });
    eq("settings.import.skipped", r2.skipped, 1);
    eq("settings.import.clamped", h.settingValue("onion.before"), 3);
    eq("settings.import.bad-kept", h.settingValue("display.previewBg"), "black");
    eq("settings.import.garbage", importSettings(h, null), { applied: 0, skipped: 0 });
  }

  // --- palette sort / merge / dedupe ---
  {
    const p = new Session();
    p.setPalette([[255, 0, 0, 255], [0, 0, 255, 255], [255, 0, 0, 255], [0, 255, 0, 255], [128, 128, 128, 255]]);
    eq("pal.setup", p.doc.palette.length, 5);
    eq("pal.dedupe.removed", p.paletteDedupe(), 1);
    eq("pal.dedupe.len", p.doc.palette.length, 4);
    eq("pal.dedupe.none", p.paletteDedupe(), 0);
    p.history.undo();
    eq("pal.dedupe.undo", p.doc.palette.length, 5);

    eq("pal.merge.added", p.paletteMerge([[0, 0, 255, 255], [1, 2, 3, 255]]), 1);
    eq("pal.merge.len", p.doc.palette.length, 6);
    eq("pal.merge.none", p.paletteMerge([[0, 0, 255, 255]]), 0);

    // hue sort: red -> green -> blue, greys grouped at the end
    p.setPalette([[0, 0, 255, 255], [255, 0, 0, 255], [128, 128, 128, 255], [0, 255, 0, 255]]);
    p.paletteSort("hue");
    eq("pal.sort.hue", p.doc.palette.map((c) => c[0] + "," + c[1] + "," + c[2]),
      ["255,0,0", "0,255,0", "0,0,255", "128,128,128"]);

    // lightness sort: dark -> light
    p.setPalette([[128, 128, 128, 255], [0, 0, 0, 255], [255, 255, 255, 255]]);
    p.paletteSort("light");
    eq("pal.sort.light", p.doc.palette.map((c) => c[0]), [0, 128, 255]);

    // already sorted: no extra undo step
    const steps = p.history.list().labels.length;
    p.paletteSort("light");
    eq("pal.sort.noop", p.history.list().labels.length, steps);
  }

  // --- multi-frame selection: batch duplicate / delete / duration ---
  {
    const f = new Session();
    f.frameAdd();
    f.frameAdd(); // 3 frames
    eq("fsel.frames", f.doc.frames.length, 3);

    f.setFrameSelMode(true);
    f.toggleFrameSel(0);
    f.toggleFrameSel(2);
    eq("fsel.list", f.frameSelList(), [0, 2]);
    eq("fsel.snapshot", f.snapshot().frameSel, [0, 2]);
    eq("fsel.mode.snapshot", f.snapshot().frameSelOn, true);
    f.toggleFrameSel(0); // toggling twice removes it again
    eq("fsel.toggle-off", f.frameSelList(), [2]);
    f.toggleFrameSel(0);
    eq("fsel.toggle-on", f.frameSelList(), [0, 2]);

    // duplicate both picked frames (one undo step)
    eq("fsel.dupe.return", f.framesDuplicateSelected(), 2);
    eq("fsel.dupe.total", f.doc.frames.length, 5);
    eq("fsel.dupe.cleared", f.frameSelList(), []);
    f.history.undo();
    eq("fsel.dupe.undo", f.doc.frames.length, 3);
    f.history.redo();
    eq("fsel.dupe.redo", f.doc.frames.length, 5);

    // duration for the picked frames only
    f.toggleFrameSel(1);
    f.toggleFrameSel(3);
    eq("fsel.dur.return", f.framesSetDuration(250), 2);
    eq("fsel.dur.picked", [1, 3].map((fi) => f.doc.frames[fi].durationMs), [250, 250]);
    eq("fsel.dur.other", f.doc.frames[0].durationMs, 100);
    f.history.undo();
    eq("fsel.dur.undo", [1, 3].map((fi) => f.doc.frames[fi].durationMs), [100, 100]);

    // delete the picked frames
    f.toggleFrameSel(0);
    f.toggleFrameSel(2);
    eq("fsel.del.return", f.framesDeleteSelected(), 4);
    eq("fsel.del.total", f.doc.frames.length, 1);
    eq("fsel.del.cleared", f.frameSelList(), []);
    f.history.undo();
    eq("fsel.del.undo", f.doc.frames.length, 5);

    // deleting every frame is refused: one frame always has to survive
    f.framesSelectAll();
    eq("fsel.all", f.frameSelList().length, 5);
    eq("fsel.del.last-guard", f.framesDeleteSelected(), 0);
    eq("fsel.del.last-guard.total", f.doc.frames.length, 5);
    // select-all toggles back off
    f.framesSelectAll();
    eq("fsel.all.off", f.frameSelList(), []);

    // leaving pick mode clears the selection
    f.toggleFrameSel(0);
    eq("fsel.mode-on", f.frameSelList(), [0]);
    f.setFrameSelMode(false);
    eq("fsel.mode-off-clears", f.frameSelList(), []);
  }
}
