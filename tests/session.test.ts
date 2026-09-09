import { Session } from "../src/app/session";
import {
  SETTINGS, SETTING_GROUPS, settingsOfGroup, coerceSetting, exportSettings, importSettings, isDefault, resetSetting,
} from "../src/app/settings";
import { GESTURES, GESTURE_ACTIONS, gesturePath, isActionAllowed } from "../src/app/gestures";
import { CORE_TOOLS, isSymTool } from "../src/tools/registry";
import { History } from "../src/engine/history";
import { Doc } from "../src/engine/doc";
import { Stroke } from "../src/tools/stroke";
import { scalarActions } from "../src/app/history-io";
import * as historyFile from "../src/io/historyfile";
import * as bridge from "../src/io/bridge";
import { eq, ok } from "./common";

declare const require: (m: string) => any;

/** minimal DOM-less environment for Session (no View attached) */
export function stubEnv(): void {
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
  // minimal canvas stubs: reference-layer mirroring composes other canvases
  const ctx: unknown = new Proxy({}, {
    get: (_t, k: string) => {
      if (k === "getImageData" || k === "createImageData") return (_x: number, _y: number, w?: number, h?: number) => ({ data: new Uint8ClampedArray(Math.max(4, ((w ?? 1) | 0) * ((h ?? 1) | 0) * 4)) });
      if (k === "createPattern") return () => ({});
      if (k === "measureText") return () => ({ width: 1 });
      return () => undefined;
    },
    set: () => true,
  });
  const makeCanvas = (): unknown => ({
    width: 0, height: 0, style: {}, getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 240 }),
  });
  g.document = {
    createElement: (tag: string) => (tag === "canvas" ? makeCanvas() : { style: {}, appendChild: () => undefined }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  g.ImageData = class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} };
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

export async function testSession(): Promise<void> {
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
    eq("timeline.drag.clamp-max", s.prefs.tlH, 520);
    s.setTlHeight(1);
    eq("timeline.drag.clamp-min", s.prefs.tlH, 140);
    s.setTlHeight(260);
    eq("timeline.drag.set", s.prefs.tlH, 260);
    s.setSetting("canvas.timelineHeight", 520);
    eq("timeline.setting.max", s.prefs.tlH, 520);
    s.setSetting("canvas.timelineHeight", 200);
    eq("timeline.setting.default", s.prefs.tlH, 200);
    // older builds stored the matrix max-height (no tlHv marker) -> migrate
    (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem(
      "pc.prefs", JSON.stringify({ tlH: 116 }));
    eq("timeline.migrate.old-default", new Session().prefs.tlH, 200);
    (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem(
      "pc.prefs", JSON.stringify({ tlH: 56 }));
    eq("timeline.migrate.old-min", new Session().prefs.tlH, 140);
    (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem(
      "pc.prefs", JSON.stringify({ tlH: 999, tlHv: 2 }));
    eq("timeline.migrate.new-clamp", new Session().prefs.tlH, 520);
    (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem(
      "pc.prefs", JSON.stringify({ tlH: 260, tlHv: 2 }));
    eq("timeline.migrate.kept", new Session().prefs.tlH, 260);
  }

  // --- tiled canvas preview (seamless tiles) ---
  {
    eq("tile.default", s.prefs.tileMode, "off");
    s.setTileMode("grid");
    eq("tile.set", s.prefs.tileMode, "grid");
    s.savePrefs();
    const raw = JSON.parse((globalThis as unknown as { localStorage: { getItem(k: string): string } }).localStorage.getItem("pc.prefs"));
    eq("tile.persist", raw.tileMode, "grid");
    (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem(
      "pc.prefs", JSON.stringify({ tileMode: "nonsense" }));
    eq("tile.invalid-ignored", new Session().prefs.tileMode, "off");
    // the old modes migrate: repeat was a 3x3 grid, mirror no longer exists
    (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem(
      "pc.prefs", JSON.stringify({ tileMode: "repeat" }));
    eq("tile.migrate.repeat", new Session().prefs.tileMode, "grid");
    (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem(
      "pc.prefs", JSON.stringify({ tileMode: "mirror" }));
    eq("tile.migrate.mirror", new Session().prefs.tileMode, "grid");
    (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem(
      "pc.prefs", JSON.stringify({ tileMode: "row" }));
    eq("tile.load.row", new Session().prefs.tileMode, "row");
    s.setTileMode("off");
  }

  // --- preview box: greyscale toggle lives next to the backdrop setting ---
  {
    s.setPreviewBg("checker");
    s.setPreviewGray(true);
    eq("preview.bg", s.prefs.previewBg, "checker");
    eq("preview.gray", s.prefs.previewGray, true);
    s.savePrefs();
    const raw = JSON.parse((globalThis as unknown as { localStorage: { getItem(k: string): string } }).localStorage.getItem("pc.prefs"));
    eq("preview.persist", [raw.previewBg, raw.previewGray], ["checker", true]);
    s.setPreviewGray(false);
    s.setPreviewBg("white");
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

  // --- one-time OS-conflict hint ---
  {
    const w = globalThis.window as unknown as Record<string, unknown>;
    const pb = w.PixelBridge as { toast: (m: string) => void };
    const orig = pb.toast;
    let n = 0;
    pb.toast = () => { n++; };
    (globalThis as unknown as { localStorage: { clear(): void } }).localStorage.clear();
    s.hintOnce("unit-test", "中文提示", "english hint");
    s.hintOnce("unit-test", "中文提示", "english hint");
    eq("hint.once-only", n, 1);
    pb.toast = orig;
    (globalThis as unknown as { localStorage: { clear(): void } }).localStorage.clear();
  }

  // --- freehand outline tool ---
  {
    const def = CORE_TOOLS.find((x) => x.id === "outline");
    ok("tool.outline.registered", !!def && def.icon === "i-outline" && def.shape === false);
    ok("tool.outline.symmetry", isSymTool("outline"));
    s.setTool("outline");
    eq("tool.outline.selected", s.tool, "outline");
    s.setTool("pencil");
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
    // two-finger long press: defaults to cycling layers
    {
      const g = GESTURES.find((x) => x.id === "twoFingerLongPress");
      ok("gesture.two-finger-long-press", !!g && g.defaultAction === "nextLayer", g ? g.defaultAction : "missing");
      ok("gesture.two-finger-long-press.actions",
        isActionAllowed("twoFingerLongPress", "nextLayer") && isActionAllowed("twoFingerLongPress", "prevLayer"));
      eq("gesture.two-finger-long-press.default", s.prefs.gTwoFingerLongPress, "nextLayer");
      // cycleLayer walks the stack, wraps around and skips hidden layers
      (globalThis as unknown as { localStorage: { clear(): void } }).localStorage.clear();
      const c = new Session();
      c.layerAdd();
      c.layerAdd();
      eq("layer.cycle.count", c.doc.layers.length, 3);
      c.setLayer(0);
      c.cycleLayer(1);
      eq("layer.cycle.next", c.curLayer(), 1);
      c.cycleLayer(-1);
      eq("layer.cycle.prev", c.curLayer(), 0);
      c.cycleLayer(-1);
      eq("layer.cycle.wrap", c.curLayer(), 2);
      c.toggleLayerVisible(1);
      c.setLayer(0);
      c.cycleLayer(1);
      eq("layer.cycle.skips-hidden", c.curLayer(), 2);
      c.toggleLayerVisible(1);
      c.setLayer(0);
    }

    // solo layers: long-press the eye hides every other layer, long-press again
    // restores exactly the visibility each layer had before
    {
      (globalThis as unknown as { localStorage: { clear(): void } }).localStorage.clear();
      const z = new Session();
      z.layerAdd();
      z.layerAdd();                    // 3 layers
      z.toggleLayerVisible(2);         // layer 2 hidden
      const vis0 = z.doc.layers.map((l) => l.visible);
      eq("layer.solo.base", vis0, [true, true, false]);
      z.toggleSoloLayers(1);
      eq("layer.solo.only-target", z.doc.layers.map((l) => l.visible), [false, true, false]);
      z.toggleSoloLayers(1);
      eq("layer.solo.restored", z.doc.layers.map((l) => l.visible), vis0);
      z.toggleSoloLayers(0);
      eq("layer.solo.toggle", z.doc.layers.map((l) => l.visible), [true, false, false]);
      z.undo();
      eq("layer.solo.undo", z.doc.layers.map((l) => l.visible), vis0);
      // a manual eye tap ends solo mode, so the next long-press starts fresh
      z.toggleSoloLayers(0);
      z.toggleLayerVisible(2);
      z.toggleSoloLayers(1);
      eq("layer.solo.after-manual", z.doc.layers.map((l) => l.visible), [false, true, false]);
      // the step survives a project save: rebuild it from its payload
      const acts = scalarActions({ k: "layer-solo", li: 0, on: true, before: [false, false, true] },
        { doc: z.doc, showFrame: () => {} });
      acts.apply();
      eq("layer.solo.payload.apply", z.doc.layers.map((l) => l.visible), [true, false, false]);
      acts.unapply();
      eq("layer.solo.payload.unapply", z.doc.layers.map((l) => l.visible), [false, false, true]);
    }

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

  // --- reference layers: live link to another canvas ---
  {
    (globalThis as unknown as { localStorage: { clear(): void } }).localStorage.clear();
    const r = new Session();
    r.doc.name = "A";
    // same size as the holder: mirroring then needs no canvas at all
    const bIdx = r.addCanvas(new Doc(64, 64, "B"));
    r.focusCanvas(0);                       // back on A
    // referencing B adds a live layer pointing at B's canvas id
    ok("ref.add", r.referenceCanvas(bIdx));
    const L = r.doc.layers[r.curLayer()];
    ok("ref.layer-linked", !!L.ref && L.ref === r.docs[bIdx].id);
    eq("ref.layer-name", L.name, "B");
    eq("ref.layer-count", r.doc.layers.length, 2);
    // the stroke on a reference layer is redirected to B's current layer
    const tgt = r.strokeTarget(r.curLayer());
    ok("ref.stroke-redirected", !!tgt && tgt.doc === r.docs[bIdx].doc && tgt.li === 0 && tgt.fi === 0);
    ok("ref.normal-layer-not-redirected", !r.strokeTarget(0));
    // the view asks these to draw the source canvas' selection on its layer
    eq("ref.source-of", r.refSourceOf(r.curLayer())?.id, r.docs[bIdx].id);
    eq("ref.source-of-normal", r.refSourceOf(0), null);
    eq("ref.offset-same-size", [r.refOffset(r.curLayer()).ox, r.refOffset(r.curLayer()).oy], [0, 0]);
    // a smaller source canvas is mirrored centred, and so is its selection
    r.focusCanvas(bIdx);
    r.doc.w = 32; r.doc.h = 24;
    r.focusCanvas(0);
    eq("ref.offset-centred", [r.refOffset(r.curLayer()).ox, r.refOffset(r.curLayer()).oy], [16, 20]);
    // a canvas cannot reference itself, and cycles are refused
    r.focusCanvas(bIdx);
    ok("ref.self-refused", !r.referenceCanvas(bIdx));
    eq("ref.cycle-refused", r.referenceCanvas(0), false);   // B -> A -> B
    r.focusCanvas(0);
    // merging a reference layer is refused instead of silently doing nothing
    const before = r.doc.layers.length;
    r.layerMergeDown();
    eq("ref.merge-refused", r.doc.layers.length, before);
  }

  // --- extract a layer into its own canvas (confirm required) ---
  {
    (globalThis as unknown as { localStorage: { clear(): void } }).localStorage.clear();
    const x = new Session();
    x.setConfirmAsk(async () => false);
    eq("extract.cancelled", await x.extractLayerToCanvas(0), null);
    eq("extract.cancelled.count", x.docs.length, 1);
    x.setConfirmAsk(async () => true);
    x.frameAdd();                       // two frames
    const cel0 = x.doc.ensureCel(0, 0);
    cel0.data[0] = 200; cel0.data[3] = 255;
    const cel1 = x.doc.ensureCel(0, 1);
    cel1.data[4] = 100; cel1.data[7] = 255;
    x.doc.name = "src";
    const idx = await x.extractLayerToCanvas(0);
    eq("extract.added-canvas", x.docs.length, 2);
    eq("extract.focused", x.docIdx, idx);
    eq("extract.new-name", x.doc.name, "src_Layer 1");
    eq("extract.new-frames", x.doc.frames.length, 2);
    eq("extract.copied-f0", x.doc.celAt(0, 0)!.data[0], 200);
    eq("extract.copied-f1", x.doc.celAt(0, 1)!.data[4], 100);
    x.focusCanvas(0);
    eq("extract.source-kept-one-layer", x.doc.layers.length, 1);
    eq("extract.source-frames", x.doc.frames.length, 2);
    ok("extract.source-empty", !x.doc.celAt(0, 0) && !x.doc.celAt(0, 1));
  }

  // --- snap settings: range, gap, colours, master switch ---
  {
    (globalThis as unknown as { localStorage: { clear(): void } }).localStorage.clear();
    const g = new Session();
    const gb = g.addCanvas(new Doc(64, 64, "B"));
    eq("snapset.defaults", [g.prefs.snapOn, g.prefs.snapRange, g.prefs.snapGap, g.prefs.snapInColor, g.prefs.snapOutColor],
      [true, 14, 8, "#78ffb4", "#ff6464"]);
    // the gap comes from the settings
    g.setSetting("canvas.snapGap", 20);
    const near = g.snapPosition(gb, g.docs[0].x + 64 + 16, g.docs[0].y, 12);
    eq("snapset.gap-used", near.x, g.docs[0].x + 64 + 20);
    // colours are validated like any other colour setting
    g.setSetting("canvas.snapInColor", "#00FF00");
    eq("snapset.color-normalised", g.prefs.snapInColor, "#00ff00");
    g.setSetting("canvas.snapInColor", "nope");
    eq("snapset.color-invalid-ignored", g.prefs.snapInColor, "#00ff00");
    eq("snapset.color-export", g.settingValue("canvas.snapOutColor"), "#ff6464");
    // the master switch disables snapping entirely
    g.setSetting("canvas.snapOn", false);
    const off = g.snapPosition(gb, g.docs[0].x + 64 + 16, g.docs[0].y, 12);
    eq("snapset.off", [off.x, off.y, off.hit, off.zones.length], [g.docs[0].x + 64 + 16, g.docs[0].y, null, 0]);
    g.setSetting("canvas.snapOn", true);
    ok("snapset.back-on", g.snapPosition(gb, g.docs[0].x + 64 + 16, g.docs[0].y, 12).hit === 0);
    // snap details are hidden while snapping is off
    g.setSetting("canvas.snapOn", false);
    ok("snapset.details-hidden", !settingsOfGroup(g, "canvas").some((d) => d.path === "canvas.snapGap"));
    g.setSetting("canvas.snapOn", true);
    ok("snapset.details-shown", settingsOfGroup(g, "canvas").some((d) => d.path === "canvas.snapGap"));
    // settings round trip keeps them
    const file = exportSettings(g);
    const h2 = new Session();
    importSettings(h2, file);
    eq("snapset.roundtrip", [h2.prefs.snapGap, h2.prefs.snapInColor], [20, "#00ff00"]);
  }

  // --- canvas position lock + snapping into groups ---
  {
    (globalThis as unknown as { localStorage: { clear(): void } }).localStorage.clear();
    const c = new Session();
    c.doc.name = "A";
    const b = c.addCanvas(new Doc(64, 64, "B"));
    eq("canvas.snap.initial-gap", c.docs[b].x, c.docs[0].x + 64 + 24);
    // dragging B towards A snaps it flush against A's right edge
    const near = c.snapPosition(b, c.docs[0].x + 64 + 5, c.docs[0].y, 12);
    // snapped neighbours keep SNAP_GAP px of empty space between them
    eq("canvas.snap.touch", [near.x, near.y, near.hit], [c.docs[0].x + 64 + 8, c.docs[0].y, 0]);
    c.moveCanvas(b, near.x, near.y);
    eq("canvas.snap.moved", c.docs[b].x, c.docs[0].x + 64 + 8);
    // releasing while flush groups them
    c.finishCanvasDrag(b, near.hit);
    ok("canvas.snap.grouped", !!c.docs[b].group && c.docs[b].group === c.docs[0].group);
    // dragging either one moves the whole group
    c.moveCanvas(b, c.docs[b].x + 40, c.docs[b].y + 10);
    eq("canvas.snap.move-together", [c.docs[0].x, c.docs[0].y], [40, 10]);
    // a canvas that is NOT touching does not group, even when aligned
    c.unlinkCanvas(b);
    ok("canvas.snap.unlinked", !c.docs[b].group && !c.docs[0].group);
    // releasing only one member of a 3-canvas group keeps the rest linked
    c.finishCanvasDrag(b, 0);
    const d = c.addCanvas(new Doc(64, 64, "C"), { x: c.docs[b].x + 64 + 8, y: c.docs[b].y });
    c.finishCanvasDrag(d, b);
    ok("canvas.snap.group-of-three", c.docs[0].group === c.docs[b].group && c.docs[b].group === c.docs[d].group);
    c.unlinkCanvas(b);
    ok("canvas.snap.middle-released", !c.docs[b].group && !!c.docs[0].group && c.docs[0].group === c.docs[d].group);
    c.unlinkCanvas(d);
    ok("canvas.snap.rest-released", !c.docs[0].group && !c.docs[d].group);
    c.moveCanvas(b, c.docs[0].x + 300, c.docs[0].y);
    c.finishCanvasDrag(b, 0);
    ok("canvas.snap.no-touch-no-group", !c.docs[b].group);
    // lock blocks dragging but not focusing
    c.toggleCanvasLock(0);
    ok("canvas.lock.on", c.isCanvasLocked(0));
    const ax = c.docs[0].x;
    c.moveCanvas(0, ax + 100, c.docs[0].y);
    eq("canvas.lock.blocks-move", c.docs[0].x, ax);
    c.toggleCanvasLock(0);
    ok("canvas.lock.off", !c.isCanvasLocked(0));
    // the title-bar eye toggles one preview window per canvas
    ok("canvas.preview.toggle-open", c.togglePreview(0));
    ok("canvas.preview.toggle-has", c.hasPreview(0));
    eq("canvas.preview.toggle-close", c.togglePreview(0), false);
    ok("canvas.preview.toggle-gone", !c.hasPreview(0));
  }

  // --- reference layers are MIRRORED into their own cel (live preview) ---
  {
    const cmod = require("../src/render/compositor") as Record<string, unknown>;
    const origFrame = cmod.composeFrame;
    let tag = 0;
    cmod.composeFrame = (doc: Doc) => {
      tag++;
      const w = doc.w, h = doc.h;
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < data.length; i += 4) { data[i] = tag; data[i + 3] = 255; }
      return { width: w, height: h, getContext: () => ({ getImageData: () => ({ data }) }) };
    };
    try {
      (globalThis as unknown as { localStorage: { clear(): void } }).localStorage.clear();
      const s = new Session();
      s.doc.name = "A";
      // same size as the holder, so the mirror needs no canvas at all
      const bi = s.addCanvas(new Doc(64, 64, "B"));
      s.focusCanvas(0);
      ok("mirror.link", s.referenceCanvas(bi));
      const li = s.curLayer();
      const cel = s.doc.celAt(li, 0);
      ok("mirror.filled", !!cel && cel.data[0] === tag && cel.data[3] === 255);
      // every frame of a reference layer shares one cel (they show the same canvas)
      s.frameAdd();
      ok("mirror.shared-cel", s.doc.celAt(li, 0) === s.doc.celAt(li, 1));
      // a change in the SOURCE re-mirrors ...
      const t0 = tag;
      s.docs[bi].doc.pixelRev++;
      s.syncRefLayers();
      ok("mirror.remirrors", tag > t0 && s.doc.celAt(li, 0)!.data[0] === tag);
      // ... but nothing changed -> no work
      const t1 = tag;
      s.syncRefLayers();
      eq("mirror.idempotent", tag, t1);
      // a DIRECT edit of the reference layer (selection fill / FX / move …)
      // must be pushed back into the SOURCE canvas on the next sync
      const srcCel = s.docs[bi].doc.ensureCel(0, 0);
      const srcBefore = srcCel.data.join();
      const mirror = s.doc.celAt(li, 0)!;
      // simulate an edit that only touched the mirror
      mirror.data[0] = 200; mirror.data[1] = 100; mirror.data[2] = 50; mirror.data[3] = 255;
      s.syncRefLayers();
      ok("mirror.push-to-source", srcCel.data[0] === 200 && srcCel.data[3] === 255);
      ok("mirror.push-recorded", s.history.canUndo());
      s.history.undo();
      ok("mirror.push-undo", srcCel.data.join() === srcBefore);
      s.history.redo();
      ok("mirror.push-redo", srcCel.data[0] === 200);

      // releasing the link keeps the pixels and splits the shared cel
      s.unrefLayer(li);
      ok("mirror.unref-keeps-pixels", s.doc.celAt(li, 0)!.data[3] === 255);
      ok("mirror.unref-splits-cel", s.doc.celAt(li, 0) !== s.doc.celAt(li, 1));
      ok("mirror.unref-cleared", !s.doc.layers[li].ref);
    } finally {
      cmod.composeFrame = origFrame;
    }
  }

  // --- a pending colour pick is routed to the FX dialog, not the brush ---
  {
    (globalThis as unknown as { localStorage: { clear(): void } }).localStorage.clear();
    const cp = new Session();
    cp.setColor([10, 20, 30, 255]);
    let got: number[] | null = null;
    cp.awaitColorPick((c) => { got = [c[0], c[1], c[2], c[3]]; });
    cp.setColor([200, 100, 50, 255]);
    eq("colorpick.routed", got, [200, 100, 50, 255]);
    eq("colorpick.brush-untouched", [cp.color[0], cp.color[1], cp.color[2], cp.color[3]], [10, 20, 30, 255]);
    // the callback is one-shot
    cp.setColor([1, 2, 3, 255]);
    eq("colorpick.one-shot", [cp.color[0], cp.color[1], cp.color[2], cp.color[3]], [1, 2, 3, 255]);
    // cancel makes the next pick a normal colour change again
    cp.awaitColorPick(() => { throw new Error("must not fire"); });
    cp.cancelColorPick();
    cp.setColor([9, 9, 9, 255]);
    eq("colorpick.cancel", [cp.color[0], cp.color[1], cp.color[2], cp.color[3]], [9, 9, 9, 255]);
  }

  // --- every canvas keeps its OWN undo stack ---
  {
    (globalThis as unknown as { localStorage: { clear(): void } }).localStorage.clear();
    const h = new Session();
    h.doc.name = "A";
    const cel = h.doc.ensureCel(0, 0);
    const before = new Uint8ClampedArray(cel.data);
    cel.data[0] = 255; cel.data[3] = 255;
    h.history.pushPixels("tools.pencil", h.doc, [{ li: 0, fi: 0, before, after: new Uint8ClampedArray(cel.data) }]);
    ok("history.percanvas.a-can-undo", h.history.canUndo());
    h.addCanvas(new Doc(8, 8, "B"));
    ok("history.percanvas.b-empty", !h.history.canUndo());
    h.focusCanvas(0);
    ok("history.percanvas.a-kept", h.history.canUndo());
    h.undo();
    eq("history.percanvas.a-undone", h.doc.celAt(0, 0)!.data[3], 0);
    h.redo();
    eq("history.percanvas.a-redone", h.doc.celAt(0, 0)!.data[3], 255);
    h.focusCanvas(1);
    ok("history.percanvas.b-still-empty", !h.history.canUndo());
    h.focusCanvas(0);
    ok("history.percanvas.a-still-there", h.history.canUndo());
  }

  // --- airbrush speck range stays ordered; the rate is clamped ---
  {
    (globalThis as unknown as { localStorage: { clear(): void } }).localStorage.clear();
    const ab = new Session();
    ab.setAirbrushMax(8);
    ab.setAirbrushMin(6);
    eq("airbrush.range.valid", [ab.prefs.airbrushMin, ab.prefs.airbrushMax], [6, 8]);
    ab.setAirbrushMin(9); // raising the floor lifts the ceiling too
    eq("airbrush.range.raise-min", [ab.prefs.airbrushMin, ab.prefs.airbrushMax], [9, 9]);
    ab.setAirbrushMax(4); // lowering the ceiling lowers the floor
    eq("airbrush.range.lower-max", [ab.prefs.airbrushMin, ab.prefs.airbrushMax], [4, 4]);
    ab.setAirbrushMin(0);
    eq("airbrush.range.clamp-low", ab.prefs.airbrushMin, 1);
    ab.setAirbrushRate(999);
    eq("airbrush.rate.clamp-high", ab.prefs.airbrushRate, 60);
    ab.setAirbrushRate(1);
    eq("airbrush.rate.clamp-low", ab.prefs.airbrushRate, 5);
  }

  // --- multiple canvases share one infinite space ---
  {
    (globalThis as unknown as { localStorage: { clear(): void } }).localStorage.clear();
    const m = new Session();
    eq("canvas.initial.count", m.docs.length, 1);
    eq("canvas.initial.focus", m.docIdx, 0);
    m.doc.name = "one";
    // a new canvas lands to the right of the focused one and takes focus
    const i2 = m.addCanvas(new Doc(32, 24, "two"));
    eq("canvas.add.count", m.docs.length, 2);
    eq("canvas.add.focus", m.docIdx, i2);
    ok("canvas.add.right", m.docs[1].x > m.docs[0].x, "x=" + m.docs[1].x);
    eq("canvas.add.same-y", m.docs[1].y, m.docs[0].y);
    // every canvas remembers its own layer/frame selection
    m.frameAdd();
    m.setFrame(1);
    m.focusCanvas(0);
    eq("canvas.focus.one-frame", m.curFrame(), 0);
    m.focusCanvas(1);
    eq("canvas.focus.two-frame", m.curFrame(), 1);
    eq("canvas.focus.two-frames", m.doc.frames.length, 2);
    // rename trims, move rounds, an empty name is ignored
    m.renameCanvas(0, "  renamed  ");
    eq("canvas.rename", m.docs[0].doc.name, "renamed");
    m.renameCanvas(0, "   ");
    eq("canvas.rename.blank-ignored", m.docs[0].doc.name, "renamed");
    m.moveCanvas(1, 200.4, -40.6);
    eq("canvas.move", [m.docs[1].x, m.docs[1].y], [200, -41]);
    // one preview window per canvas, idempotent, closable by id
    const p0 = m.addPreview(0);
    const p1 = m.addPreview(1);
    eq("canvas.preview.count", m.previews.length, 2);
    eq("canvas.preview.same-again", m.addPreview(0), p0);
    eq("canvas.preview.still-two", m.previews.length, 2);
    m.closePreview(p1);
    eq("canvas.preview.closed", m.previews.length, 1);
    m.addPreview(1);
    // closing a canvas drops its preview and renumbers the later ones
    m.closeCanvas(0);
    eq("canvas.close.count", m.docs.length, 1);
    eq("canvas.close.focus-name", m.doc.name, "two");
    eq("canvas.close.preview-shift", m.previews.map((p) => p.canvas), [0]);
    // the last canvas CAN be closed: an empty project is a valid state
    m.closeCanvas(0);
    eq("canvas.close.last-empty", m.docs.length, 0);
    eq("canvas.close.last-previews", m.previews.length, 0);
    eq("canvas.empty.doc-stub", m.doc.w, 1);
    // ... and a new canvas can be created from the empty state
    const back = m.addCanvas(new Doc(8, 8, "fresh"));
    eq("canvas.empty.add-again", [m.docs.length, m.docIdx, back], [1, 0, 0]);
    eq("canvas.empty.origin", [m.docs[0].x, m.docs[0].y], [0, 0]);
  }
}
