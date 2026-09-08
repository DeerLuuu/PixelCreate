import { Session } from "../src/app/session";
import {
  SETTINGS, settingsOfGroup, coerceSetting, exportSettings, importSettings, isDefault, resetSetting,
} from "../src/app/settings";
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
  w.PixelBridge = { toast: () => {}, vibrate: () => {} };
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
