import { Session } from "../src/app/session";
import * as selOps from "../src/tools/select";
import {
  SETTINGS, SETTING_GROUPS, settingsOfGroup, coerceSetting, exportSettings, importSettings, isDefault, resetSetting,
} from "../src/app/settings";
import { GESTURES, GESTURE_ACTIONS, gesturePath, isActionAllowed } from "../src/app/gestures";
import { CORE_TOOLS, isSymTool } from "../src/tools/registry";
import { History } from "../src/engine/history";
import { Doc, Sel } from "../src/engine/doc";
import { Stroke } from "../src/tools/stroke";
import { scalarActions } from "../src/app/history-io";
import * as historyFile from "../src/io/historyfile";
import * as project from "../src/io/project";
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
  const rootAttrs: Record<string, string> = {};
  g.document = {
    createElement: (tag: string) => (tag === "canvas" ? makeCanvas() : { style: {}, appendChild: () => undefined }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    // <html> stub: applyTheme (src/io/theme.ts) writes data-theme here
    documentElement: {
      style: {},
      setAttribute: (k: string, v: string) => { rootAttrs[k] = String(v); },
      removeAttribute: (k: string) => { delete rootAttrs[k]; },
      getAttribute: (k: string) => (k in rootAttrs ? rootAttrs[k] : null),
    },
    querySelector: () => null,
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
    const enc = historyFile.encodeHistory(dump);
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

  // --- reference layers: live link to another canvas (per layer by default) ---
  {
    (globalThis as unknown as { localStorage: { clear(): void } }).localStorage.clear();
    const r = new Session();
    r.doc.name = "A";
    // same size as the holder: mirroring then needs no canvas at all
    const bIdx = r.addCanvas(new Doc(64, 64, "B"));
    const b = r.docs[bIdx].doc;
    // B has two layers: 影子 (bottom) + 本图层 (top), each with one pixel
    b.layers[0].name = "影子";
    b.layers.push({ id: "artLayer", name: "本图层", visible: true, opacity: 100, blend: "normal", locked: false });
    const shadowCel = b.ensureCel(0, 0); shadowCel.data[0] = 11; shadowCel.data[3] = 255;
    const artCel = b.ensureCel(1, 0); artCel.data[4] = 22; artCel.data[7] = 255;
    r.focusCanvas(0);                       // back on A
    // referencing B mirrors EVERY layer of B as its own live layer
    ok("ref.add", r.referenceCanvas(bIdx));
    eq("ref.layer-count", r.doc.layers.length, 3);   // A's layer + 2 mirrors
    const L0 = r.doc.layers[1], L1 = r.doc.layers[2];
    eq("ref.layer-names", [L0.name, L1.name], ["影子", "本图层"]);
    ok("ref.layer-linked", !!L0.ref && L0.ref === r.docs[bIdx].id);
    ok("ref.bound-to-source-layer", L0.refLayer === b.layers[0].id && L1.refLayer === "artLayer");
    eq("ref.top-focused", r.curLayer(), 2);
    // each mirror shows exactly its own source layer
    eq("ref.mirror-bottom", [r.doc.celAt(1, 0)!.data[0], r.doc.celAt(1, 0)!.data[4]], [11, 0]);
    eq("ref.mirror-top", [r.doc.celAt(2, 0)!.data[0], r.doc.celAt(2, 0)!.data[4]], [0, 22]);
    // a stroke on a mirror is redirected to the layer it mirrors (never guessed)
    const t0 = r.strokeTarget(1), t1 = r.strokeTarget(2);
    ok("ref.stroke-redirected", !!t0 && t0.doc === b && t0.li === 0 && t0.fi === 0);
    eq("ref.stroke-target-top", t1 && t1.li, 1);
    ok("ref.normal-layer-not-redirected", !r.strokeTarget(0));
    // a real stroke lands in the bound source layer and mirrors back
    const st = new Stroke(t0!.doc, t0!.li, t0!.fi, "pencil", { color: [200, 0, 0, 255], size: 1, alpha: 255, pressure: 1 }, false, "off");
    st.startAt(3, 3);
    st.commit(r.history, "tools.pencil");
    st.takeDirty(); // what the view does to drive the repaint / mirror sync
    r.repaintAll();
    eq("ref.stroke-lands-in-bound", b.celAt(0, 0)!.data[(3 * 64 + 3) * 4 + 3], 255);
    eq("ref.stroke-keeps-other-layer", b.celAt(1, 0)!.data[(3 * 64 + 3) * 4 + 3], 0);
    eq("ref.stroke-mirrors-back", r.doc.celAt(1, 0)!.data[(3 * 64 + 3) * 4], 200);
    // the source layer being hidden no longer hides the mirror (each mirror is
    // its own layer in the holder): painting always stays visible
    b.layers[0].visible = false; b.pixelRev++;
    r.syncRefLayers();
    eq("ref.hidden-source-still-shown", r.doc.celAt(1, 0)!.data[(3 * 64 + 3) * 4], 200);
    b.layers[0].visible = true; b.pixelRev++;
    // a locked source layer blocks painting AND says why
    b.layers[1].locked = true;
    eq("ref.block-locked", r.refPaintBlock(2), "locked");
    r.setLayer(2);
    ok("ref.locked-layer-blocks", r.layerLocked());
    b.layers[1].locked = false;
    ok("ref.unlocked-again", !r.layerLocked());
    // deleting the mirrored source layer is reported as "gone"
    b.layers.splice(1, 1);
    eq("ref.block-gone", r.refPaintBlock(2), "gone");
    ok("ref.gone-no-target", !r.strokeTarget(2));
    // the view asks these to draw the source canvas' selection on its layer
    eq("ref.source-of", r.refSourceOf(1)?.id, r.docs[bIdx].id);
    eq("ref.source-of-normal", r.refSourceOf(0), null);
    eq("ref.source-layer-name", r.refSourceLayerOf(1)?.name, "影子");
    eq("ref.offset-same-size", [r.refOffset(1).ox, r.refOffset(1).oy], [0, 0]);
    // release every mirror at once: pixels stay, links go, one history step
    eq("ref.unref-all-count", r.unrefAll(), 2);
    eq("ref.unref-all-cleared", r.doc.layers.filter((l) => !!l.ref).length, 0);
    eq("ref.unref-all-keeps-pixels", r.doc.celAt(1, 0)!.data[(3 * 64 + 3) * 4], 200);
    ok("ref.unref-all-one-step", !!r.history.undo());
    eq("ref.unref-all-undo", r.doc.layers.filter((l) => !!l.ref).length, 2);
    // a smaller source canvas is mirrored centred, and so is its selection
    r.focusCanvas(bIdx);
    r.doc.w = 32; r.doc.h = 24;
    r.focusCanvas(0);
    eq("ref.offset-centred", [r.refOffset(1).ox, r.refOffset(1).oy], [16, 20]);
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

  // --- reference in "flattened" mode: one mirror of the whole canvas ---
  {
    (globalThis as unknown as { localStorage: { clear(): void } }).localStorage.clear();
    const f = new Session();
    f.doc.name = "A";
    const bi = f.addCanvas(new Doc(32, 32, "B"));
    f.docs[bi].doc.layers.push({ id: "top", name: "top", visible: true, opacity: 100, blend: "normal", locked: false });
    f.focusCanvas(0);
    ok("refFlat.add", f.referenceCanvas(bi, { mode: "flat" }));
    eq("refFlat.layer-count", f.doc.layers.length, 2);
    ok("refFlat.no-bound-layer", !f.doc.layers[1].refLayer);
    // a flattened mirror has no bound layer: it follows the source selection
    f.docs[bi].li = 1;
    eq("refFlat.target-follows-source", f.strokeTarget(1)!.li, 1);
    f.docs[bi].li = 0;
    eq("refFlat.target-follows-source-2", f.strokeTarget(1)!.li, 0);
    eq("refFlat.unref-all-count", f.unrefAll(), 1);
  }

  // --- an older flattened reference can be upgraded to per-layer mirrors ---
  {
    (globalThis as unknown as { localStorage: { clear(): void } }).localStorage.clear();
    const u = new Session();
    u.doc.name = "A";
    // same size as the holder, so a mirror is not offset by the centring
    const bi = u.addCanvas(new Doc(64, 64, "B"));
    const b = u.docs[bi].doc;
    b.layers[0].name = "\u5f71\u5b50";
    b.layers.push({ id: "art", name: "\u672c\u56fe\u5c42", visible: true, opacity: 100, blend: "normal", locked: false });
    const c0 = b.ensureCel(0, 0); c0.data[0] = 5; c0.data[3] = 255;
    const c1 = b.ensureCel(1, 0); c1.data[4] = 6; c1.data[7] = 255;
    u.focusCanvas(0);
    ok("splitRef.add-flat", u.referenceCanvas(bi, { mode: "flat" }));
    ok("splitRef.can", u.canSplitRef(1));
    eq("splitRef.before-count", u.doc.layers.length, 2);
    ok("splitRef.split", u.splitRefLayer(1));
    eq("splitRef.after-count", u.doc.layers.length, 3);
    eq("splitRef.names", [u.doc.layers[1].name, u.doc.layers[2].name], ["\u5f71\u5b50", "\u672c\u56fe\u5c42"]);
    ok("splitRef.bound", u.doc.layers[1].refLayer === b.layers[0].id && u.doc.layers[2].refLayer === "art");
    eq("splitRef.mirror-bottom", u.doc.celAt(1, 0)!.data[0], 5);
    eq("splitRef.mirror-top", u.doc.celAt(2, 0)!.data[4], 6);
    ok("splitRef.no-more-can", !u.canSplitRef(1) && !u.splitRefLayer(1));
    ok("splitRef.undo", !!u.history.undo());
    eq("splitRef.undo-flat", [u.doc.layers.length, !u.doc.layers[1].refLayer], [2, true]);
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

    // stacked canvases snap TITLE_EXTRA px further apart (the gap has to fit the
    // lower canvas' title bar) and still group on release
    {
      const base = c.docs[0];
      const down = c.addCanvas(new Doc(64, 64, "D"), { x: base.x, y: base.y + base.doc.h + 200 });
      const near = c.snapPosition(down, base.x, base.y + base.doc.h + 6, 12);
      eq("canvas.snap.stacked-gap", [near.x, near.y - (base.y + base.doc.h), near.hit],
        [base.x, 8 + 20, 0]);
      ok("canvas.snap.stacked-snapped", near.hit !== null);
      c.moveCanvas(down, near.x, near.y);
      c.finishCanvasDrag(down, near.hit);
      ok("canvas.snap.stacked-grouped", !!c.docs[down].group && c.docs[down].group === base.group);
      c.unlinkCanvas(down);
      // side-by-side keeps the plain 8px gap
      const side = c.snapPosition(down, base.x + base.doc.w + 6, base.y, 12);
      eq("canvas.snap.side-gap", side.x - (base.x + base.doc.w), 8);
    }
  }

  // --- ② 跨画布剪切/粘贴：在画布 A 剪切，切到画布 B 粘贴 ---
  {
    (globalThis as unknown as { localStorage: { clear(): void } }).localStorage.clear();
    const s = new Session();
    s.doc.name = "A";
    const bi = s.addCanvas(new Doc(64, 64, "B"));
    s.focusCanvas(0);
    // 在 A 上画一个 4x4 方块并选中它，然后剪切
    const celA = s.doc.ensureCel(0, 0);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const i = celA.idx(x, y);
      celA.data[i] = 200; celA.data[i + 1] = 10; celA.data[i + 2] = 20; celA.data[i + 3] = 255;
    }
    s.doc.sel = new Sel(64, 64);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) s.doc.sel.set(x, y, 1);
    const clip = selOps.selOps.cut(s.doc, s.history, 0, 0);
    ok("xcanvas.cut.clip", !!clip && clip.w === 4 && clip.h === 4, "clip=" + (clip ? clip.w + "x" + clip.h : "null"));
    eq("xcanvas.cut.cleared", celA.data[0], 0);
    // 切到画布 B 粘贴：应落在 B 的当前图层（B 还没有 cel，由 paste 创建）
    s.focusCanvas(bi);
    s.clip = clip;
    ok("xcanvas.clip.shared", !!s.clip);
    selOps.selOps.paste(s.doc, s.history, s.curLayer(), s.curFrame(), s.clip!);
    const celB = s.doc.celAt(s.curLayer(), s.curFrame());
    ok("xcanvas.paste.created", !!celB, "cel=" + !!celB);
    // 粘贴的内容（居中放置）应能在 B 里找到该颜色
    let found = 0;
    if (celB) for (let i = 0; i < celB.data.length; i += 4) if (celB.data[i] === 200 && celB.data[i + 3] === 255) found++;
    ok("xcanvas.paste.pixels", found >= 16, "found=" + found);
    ok("xcanvas.paste.undoable", s.history.canUndo());
  }

  // --- reference layers are MIRRORED into their own cel (live preview) ---
  {
    (globalThis as unknown as { localStorage: { clear(): void } }).localStorage.clear();
    const s = new Session();
    s.doc.name = "A";
    // same size as the holder, so the mirror needs no canvas at all
    const bi = s.addCanvas(new Doc(64, 64, "B"));
    const srcCel = s.docs[bi].doc.ensureCel(0, 0);
    srcCel.data[0] = 77; srcCel.data[3] = 255;
    s.focusCanvas(0);
    ok("mirror.link", s.referenceCanvas(bi));
    const li = s.curLayer();
    const cel = s.doc.celAt(li, 0);
    ok("mirror.filled", !!cel && cel.data[0] === 77 && cel.data[3] === 255);
    // every frame of a reference layer shares one cel (they show the same canvas)
    s.frameAdd();
    ok("mirror.shared-cel", s.doc.celAt(li, 0) === s.doc.celAt(li, 1));
    // a change in the SOURCE re-mirrors ...
    srcCel.data[0] = 88; s.docs[bi].doc.pixelRev++;
    s.syncRefLayers();
    ok("mirror.remirrors", s.doc.celAt(li, 0)!.data[0] === 88);
    // ... but nothing changed -> the mirror is left alone
    const mirrorRef = s.doc.celAt(li, 0)!.data;
    s.syncRefLayers();
    ok("mirror.idempotent", s.doc.celAt(li, 0)!.data === mirrorRef);
    // a DIRECT edit of the reference layer (selection fill / FX / move …)
    // must be pushed back into the SOURCE canvas on the next sync
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
    ok("mirror.unref-cleared", !s.doc.layers[li].ref && !s.doc.layers[li].refLayer);
  }

  // --- a FLATTENED reference still mirrors through the compositor ---
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
      const bi = s.addCanvas(new Doc(64, 64, "B"));
      s.focusCanvas(0);
      ok("refFlatMirror.link", s.referenceCanvas(bi, { mode: "flat" }));
      const li = s.curLayer();
      ok("refFlatMirror.filled", s.doc.celAt(li, 0)!.data[0] === tag);
      const t0 = tag;
      s.docs[bi].doc.pixelRev++;
      s.syncRefLayers();
      ok("refFlatMirror.remirrors", tag > t0 && s.doc.celAt(li, 0)!.data[0] === tag);
      const t1 = tag;
      s.syncRefLayers();
      eq("refFlatMirror.idempotent", tag, t1);
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

  // --- ONE shared undo stack across every canvas (global undo + replay) ---
  {
    (globalThis as unknown as { localStorage: { clear(): void } }).localStorage.clear();
    const h = new Session();
    h.doc.name = "A";
    const celA = h.doc.ensureCel(0, 0);
    const beforeA = new Uint8ClampedArray(celA.data);
    celA.data[0] = 255; celA.data[3] = 255;
    h.history.pushPixels("tools.pencil", h.doc, [{ li: 0, fi: 0, before: beforeA, after: new Uint8ClampedArray(celA.data) }]);
    const bi = h.addCanvas(new Doc(8, 8, "B"));
    // switching canvas keeps the whole stack
    ok("history.shared.kept-after-add", h.history.canUndo());
    eq("history.shared.step-count", h.history.list().labels.length, 1);
    // a step recorded while B is focused goes on the same stack
    const celB = h.doc.ensureCel(0, 0);
    const beforeB = new Uint8ClampedArray(celB.data);
    celB.data[4] = 200; celB.data[7] = 255;
    h.history.pushPixels("tools.eraser", h.doc, [{ li: 0, fi: 0, before: beforeB, after: new Uint8ClampedArray(celB.data) }]);
    eq("history.shared.two-steps", h.history.list().labels.length, 2);
    // undo applies to the canvas the step belongs to, in global order
    h.undo();
    eq("history.shared.undo-b", h.doc.celAt(0, 0)!.data[4], 0);
    eq("history.shared.undo-b-keeps-a", h.docs[0].doc.celAt(0, 0)!.data[3], 255);
    h.undo();
    eq("history.shared.undo-a", h.docs[0].doc.celAt(0, 0)!.data[3], 0);
    h.redo();
    h.redo();
    eq("history.shared.redo-all", [h.docs[0].doc.celAt(0, 0)!.data[3], h.doc.celAt(0, 0)!.data[4]], [255, 200]);
    // undoing a step of a NON-focused canvas must invalidate its render cache
    const revBefore = h.docs[0].doc.pixelRev;
    h.focusCanvas(bi);
    h.undo();  // B's step (focused)
    h.undo();  // A's step, while B is focused
    ok("history.shared.undo-bumps-rev", h.docs[0].doc.pixelRev > revBefore, "rev " + revBefore + " -> " + h.docs[0].doc.pixelRev);
    h.redo();
    h.redo();
    // focusing elsewhere never loses the stack
    h.focusCanvas(0);
    ok("history.shared.still-there", h.history.canUndo());
    eq("history.shared.still-two", h.history.list().labels.length, 2);
    // closing a canvas is an ordinary step: nothing is dropped, and the close
    // itself can be undone (the canvas comes back) until the project closes
    const bDoc = h.docs[bi].doc;
    h.focusCanvas(bi);
    h.closeCanvas(bi);
    eq("history.close.step-added", h.history.list().labels.length, 3);
    eq("history.close.label", h.history.list().labels[2], "canvas-close");
    ok("history.close.b-gone", !h.docs.some((d) => d.doc === bDoc));
    h.undo(); // the close is undone: B is back and focused again
    eq("history.close.undo-restores", h.docs.length, 2);
    eq("history.close.undo-focus", h.doc.name, "B");
    eq("history.close.undo-pixels", h.doc.celAt(0, 0)!.data[4], 200);
    h.undo(); // ... and B's own steps are still on the stack
    eq("history.close.undo-b-step", h.doc.celAt(0, 0)!.data[4], 0);
    h.redo();
    h.redo();
    ok("history.close.redo-gone", !h.docs.some((d) => d.doc === bDoc));
  }

  // --- a closed canvas keeps everything: undo brings it back in place -------
  {
    (globalThis as unknown as { localStorage: { clear(): void } }).localStorage.clear();
    const c = new Session();
    c.doc.name = "one";
    const cel = c.doc.ensureCel(0, 0);
    const b0 = new Uint8ClampedArray(cel.data);
    cel.data[0] = 255; cel.data[3] = 255;
    c.history.pushPixels("tools.pencil", c.doc, [{ li: 0, fi: 0, before: b0, after: new Uint8ClampedArray(cel.data) }]);
    const i2 = c.addCanvas(new Doc(16, 16, "two"));
    c.moveCanvas(i2, 120, 60);
    c.toggleCanvasLock(i2);
    const pid = c.addPreview(i2);
    c.closeCanvas(i2);
    eq("closeUndo.closed", c.docs.length, 1);
    eq("closeUndo.preview-gone", c.previews.length, 0);
    eq("closeUndo.one-step", c.history.list().labels.length, 2);
    c.undo();
    eq("closeUndo.back", c.docs.length, 2);
    eq("closeUndo.name", c.docs[1].doc.name, "two");
    eq("closeUndo.place", [c.docs[1].x, c.docs[1].y], [120, 60]);
    ok("closeUndo.lock", c.isCanvasLocked(1));
    eq("closeUndo.preview-back", c.previews.map((p) => [p.canvas, p.id]), [[1, pid]]);
    eq("closeUndo.focus", c.docIdx, 1);
    eq("closeUndo.pixels-kept", c.docs[0].doc.celAt(0, 0)!.data[3], 255);
    c.redo();
    eq("closeUndo.redo", c.docs.length, 1);
    // a saved project cannot replay a canvas that is not in it: those steps
    // (and the close itself) are skipped, the rest keeps its order
    const dump = c.history.dump((d) => c.docs.find((e) => e.doc === d)?.id);
    eq("closeUndo.dump.entries", dump.entries.map((e) => e.label), ["tools.pencil"]);
    eq("closeUndo.dump.index", dump.index, 1);
    // the LAST canvas can be closed too, and undo refills the empty space
    c.undo(); // bring "two" back
    c.closeCanvas(1);
    c.closeCanvas(0);
    eq("closeUndo.empty", c.docs.length, 0);
    eq("closeUndo.empty-stub", c.doc.w, 1);
    c.undo();
    eq("closeUndo.empty-undo", [c.docs.length, c.doc.name], [1, "one"]);
    eq("closeUndo.empty-focus", c.docIdx, 0);
    // closing a canvas you are NOT looking at keeps the focus where it is
    const d = new Session();
    d.doc.name = "keep";
    d.addCanvas(new Doc(8, 8, "other"));
    d.focusCanvas(0);
    d.closeCanvas(1);
    eq("closeUndo.unfocused.closed", [d.docs.length, d.doc.name], [1, "keep"]);
    d.undo();
    eq("closeUndo.unfocused.back", [d.docs.length, d.doc.name, d.docIdx], [2, "keep", 0]);
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
  // --- rotate the canvas content 90° (width/height swap, undoable) ---
  {
    (globalThis as unknown as { localStorage: { clear(): void } }).localStorage.clear();
    const s = new Session();
    await s.replaceDoc(new Doc(4, 2, "rot"), { ask: false });
    const cel = s.doc.ensureCel(0, 0);
    cel.data[0] = 255; cel.data[3] = 255;            // (0,0) red
    const bi = (1 * 4 + 3) * 4;                      // (3,1) blue
    cel.data[bi] = 0; cel.data[bi + 1] = 0; cel.data[bi + 2] = 255; cel.data[bi + 3] = 255;
    s.doc.sel = new Sel(4, 2);
    s.doc.sel.set(0, 0, 1);
    s.rotateCanvasContent(1);
    eq("rot.size", [s.doc.w, s.doc.h], [2, 4]);
    const rc = s.doc.celAt(0, 0)!;
    const at = (x: number, y: number): number[] => {
      const i = rc.idx(x, y);
      return [rc.data[i], rc.data[i + 1], rc.data[i + 2], rc.data[i + 3]];
    };
    eq("rot.red-moved", at(1, 0), [255, 0, 0, 255]);
    eq("rot.blue-moved", at(0, 3), [0, 0, 255, 255]);
    eq("rot.old-spot-empty", at(0, 0), [0, 0, 0, 0]);
    eq("rot.sel-size", [s.doc.sel!.w, s.doc.sel!.h], [2, 4]);
    eq("rot.sel-moved", s.doc.sel!.get(1, 0), 1);
    ok("rot.undo", !!s.history.undo());
    eq("rot.undo-size", [s.doc.w, s.doc.h], [4, 2]);
    eq("rot.undo-px", [s.doc.celAt(0, 0)!.data[0], s.doc.celAt(0, 0)!.data[bi + 2]], [255, 255]);
    ok("rot.redo", !!s.history.redo());
    eq("rot.redo-size", [s.doc.w, s.doc.h], [2, 4]);
    // counter-clockwise turns it back
    s.rotateCanvasContent(-1);
    eq("rot.ccw-size", [s.doc.w, s.doc.h], [4, 2]);
    eq("rot.ccw-red", [s.doc.celAt(0, 0)!.data[0], s.doc.celAt(0, 0)!.data[3]], [255, 255]);
  }

  // --- new project: replaces every canvas and clears the history ---
  {
    (globalThis as unknown as { localStorage: { clear(): void } }).localStorage.clear();
    const s = new Session();
    const cel = s.doc.ensureCel(0, 0);
    const b0 = new Uint8ClampedArray(cel.data);
    cel.data[0] = 1; cel.data[3] = 255;
    s.history.pushPixels("tools.pencil", s.doc, [{ li: 0, fi: 0, before: b0, after: new Uint8ClampedArray(cel.data) }]);
    s.doc.name = "old";
    s.addCanvas(new Doc(8, 8, "extra"));
    // declining the unsaved-work prompt keeps everything
    s.setConfirmAsk(async () => false);
    ok("newProject.cancelled", !(await s.newProject(16, 16, "fresh", null)));
    eq("newProject.cancelled-keeps", [s.docs.length, s.docs[0].doc.name], [2, "old"]);
    ok("newProject.cancelled-keeps-history", s.history.canUndo());
    // accepting replaces the whole space with one canvas
    s.setConfirmAsk(async () => true);
    ok("newProject.ok", await s.newProject(16, 16, "fresh", null));
    eq("newProject.one-canvas", s.docs.length, 1);
    eq("newProject.name", s.doc.name, "fresh");
    eq("newProject.size", [s.doc.w, s.doc.h], [16, 16]);
    eq("newProject.focus", s.docIdx, 0);
    ok("newProject.history-cleared", !s.history.canUndo() && !s.history.canRedo());
    ok("newProject.empty-pixels", !s.doc.celAt(0, 0) || !s.doc.celAt(0, 0)!.hasAnyOpaque());
  }

  // --- a reference to a SMALLER canvas: paint must land on the same pixel ---
  // (the mirror is centred, so a cell of the holder maps to the source by
  //  subtracting the offset — this used to write out of bounds / off by the
  //  offset, which looked like "the reference layer cannot be edited")
  {
    (globalThis as unknown as { localStorage: { clear(): void } }).localStorage.clear();
    const s = new Session();
    s.doc.name = "A"; // 64x64
    const bi = s.addCanvas(new Doc(16, 16, "B"));
    const b = s.docs[bi].doc;
    const bc = b.ensureCel(0, 0);
    bc.data[(4 * 16 + 4) * 4 + 3] = 255; // a mark the mirror can show
    s.focusCanvas(0);
    ok("refOff.add", s.referenceCanvas(bi));
    eq("refOff.offset", [s.refOffset(1).ox, s.refOffset(1).oy], [24, 24]);
    const tgt = s.strokeTarget(1)!;
    eq("refOff.target-offset", [tgt.dx, tgt.dy], [24, 24]);
    // paint at holder (30,30): the source cell is (6,6)
    const st = new Stroke(tgt.doc, tgt.li, tgt.fi, "pencil", { color: [255, 0, 0, 255], size: 1, alpha: 255, pressure: 1 }, false, "off");
    st.refDx = tgt.dx; st.refDy = tgt.dy; st.setGeometry(s.doc.w, s.doc.h);
    st.startAt(30, 30);
    st.takeDirty();
    st.commit(s.history, "tools.pencil");
    s.repaintAll();
    eq("refOff.source-px", b.celAt(0, 0)!.data[(6 * 16 + 6) * 4 + 3], 255);
    eq("refOff.source-not-offset", b.celAt(0, 0)!.data[(4 * 16 + 4) * 4], 0);
    eq("refOff.mirror-px", s.doc.celAt(1, 0)!.data[(30 * 64 + 30) * 4], 255);
    eq("refOff.mirror-existing", s.doc.celAt(1, 0)!.data[(28 * 64 + 28) * 4 + 3], 255);
    // a holder cell outside the source paints nothing at all
    const st2 = new Stroke(tgt.doc, tgt.li, tgt.fi, "pencil", { color: [0, 255, 0, 255], size: 1, alpha: 255, pressure: 1 }, false, "off");
    st2.refDx = tgt.dx; st2.refDy = tgt.dy; st2.setGeometry(s.doc.w, s.doc.h);
    st2.startAt(2, 2);
    st2.takeDirty();
    eq("refOff.outside-no-step", st2.commit(s.history, "tools.pencil"), false);
    // the bucket seeds in the source too
    const bt = new Stroke(b, 0, 0, "bucket", { color: [0, 0, 255, 255], size: 1, alpha: 255, pressure: 1 }, false, "off");
    bt.refDx = tgt.dx; bt.refDy = tgt.dy; bt.setGeometry(s.doc.w, s.doc.h);
    bt.startAt(30, 30);
    bt.takeDirty();
    bt.commit(s.history, "tools.bucket");
    s.repaintAll();
    eq("refOff.bucket-source", b.celAt(0, 0)!.data[(6 * 16 + 6) * 4 + 2], 255);
    eq("refOff.bucket-mirror", s.doc.celAt(1, 0)!.data[(30 * 64 + 30) * 4 + 2], 255);
    // the holder's selection is mapped into the source
    s.doc.sel = new Sel(64, 64);
    s.doc.sel.set(30, 30, 1);
    const st3 = new Stroke(tgt.doc, tgt.li, tgt.fi, "pencil", { color: [255, 255, 0, 255], size: 1, alpha: 255, pressure: 1 }, false, "off");
    st3.refDx = tgt.dx; st3.refDy = tgt.dy; st3.setGeometry(s.doc.w, s.doc.h);
    st3.mask = (sx, sy) => s.doc.sel!.get(sx + tgt.dx, sy + tgt.dy) === 1;
    st3.startAt(30, 31); // outside the selection
    st3.takeDirty();
    eq("refOff.mask-blocks", st3.commit(s.history, "tools.pencil"), false);
    const st4 = new Stroke(tgt.doc, tgt.li, tgt.fi, "pencil", { color: [255, 255, 0, 255], size: 1, alpha: 255, pressure: 1 }, false, "off");
    st4.refDx = tgt.dx; st4.refDy = tgt.dy; st4.setGeometry(s.doc.w, s.doc.h);
    st4.mask = (sx, sy) => s.doc.sel!.get(sx + tgt.dx, sy + tgt.dy) === 1;
    st4.startAt(30, 30);
    st4.takeDirty();
    eq("refOff.mask-allows", st4.commit(s.history, "tools.pencil"), true);
    eq("refOff.mask-px", b.celAt(0, 0)!.data[(6 * 16 + 6) * 4], 255);
  }

  // --- indexed colour mode: painting snaps to the palette ---
  {
    (globalThis as unknown as { localStorage: { clear(): void } }).localStorage.clear();
    const s = new Session();
    s.doc.palette = [[255, 0, 0, 255], [0, 0, 255, 255], [0, 255, 0, 255]];
    s.setIndexed(false);
    eq("indexed.off-keeps", s.paletteSnap([250, 10, 10, 128]), [250, 10, 10, 128]);
    s.setIndexed(true);
    eq("indexed.snap-red", s.paletteSnap([250, 10, 10, 128]), [255, 0, 0, 128]);
    eq("indexed.snap-blue", s.paletteSnap([10, 10, 240, 255]), [0, 0, 255, 255]);
    // an empty palette leaves colours alone
    s.doc.palette = [];
    eq("indexed.empty-palette", s.paletteSnap([250, 10, 10, 128]), [250, 10, 10, 128]);
    // remap the pixels already on the canvas (one history step)
    s.doc.palette = [[255, 0, 0, 255], [0, 0, 255, 255]];
    const cel0 = s.doc.ensureCel(0, 0);
    cel0.data[0] = 200; cel0.data[1] = 20; cel0.data[2] = 30; cel0.data[3] = 255;
    cel0.data[4] = 20; cel0.data[5] = 30; cel0.data[6] = 200; cel0.data[7] = 255;
    const raw = cel0.data.join();
    eq("indexed.remap-count", s.remapToPalette("canvas"), 1);
    const cel1 = s.doc.celAt(0, 0)!;
    eq("indexed.remap-px", [cel1.data[0], cel1.data[1], cel1.data[2], cel1.data[4], cel1.data[5], cel1.data[6]], [255, 0, 0, 0, 0, 255]);
    ok("indexed.remap-undo", !!s.history.undo());
    eq("indexed.remap-undo-px", s.doc.celAt(0, 0)!.data.join(), raw);
    ok("indexed.remap-redo", !!s.history.redo());
    // a stroke with the snap hook paints a palette colour
    s.setIndexed(true);
    const st = new Stroke(s.doc, 0, 0, "pencil", { color: [250, 10, 10, 255], size: 1, alpha: 255, pressure: 1 }, false, "off");
    st.snapColor = (c) => s.paletteSnap(c);
    st.startAt(2, 2);
    st.commit(s.history, "tools.pencil");
    const cel2 = s.doc.celAt(0, 0)!;
    const k = cel2.idx(2, 2);
    eq("indexed.stroke-snaps", [cel2.data[k], cel2.data[k + 1], cel2.data[k + 2], cel2.data[k + 3]], [255, 0, 0, 255]);
  }

  // --- UI state changes must not invalidate pixel caches (rev vs pixelRev) ---
  {
    (globalThis as unknown as { localStorage: { clear(): void } }).localStorage.clear();
    const cmod = require("../src/render/compositor") as Record<string, unknown>;
    const origFrame = cmod.composeFrame;
    let composes = 0;
    cmod.composeFrame = (...a: unknown[]) => {
      composes++;
      return (origFrame as (...x: unknown[]) => unknown)(...a);
    };
    try {
      const s = new Session();
      const cel = s.doc.ensureCel(0, 0);
      cel.data[0] = 1; cel.data[3] = 255;
      const bi = s.addCanvas(new Doc(8, 8, "B"));
      s.focusCanvas(0);
      s.referenceCanvas(bi, { mode: "flat" }); // one mirror of the whole canvas
      const px0 = s.doc.pixelRev;
      const ui0 = s.getVersion();
      const comp0 = composes;
      // tool / brush / colour / layer / settings: no pixel invalidation at all
      s.setTool("eraser");
      s.setBrushSize(12);
      s.setBrushAlpha(200);
      s.setColor([9, 8, 7, 255]);
      s.setLayer(0);
      s.setPixelPerfect(false);
      s.setSetting("display.magZoom", 14);
      s.setSetting("history.steps", 90);
      eq("rev.ui-pixelRev-untouched", s.doc.pixelRev, px0);
      eq("rev.ui-no-ref-remirror", composes, comp0);
      ok("rev.ui-revision-bumped", s.getVersion() > ui0);
      // a real pixel change still invalidates (repaint bumps the holder doc)
      s.repaint();
      ok("rev.pixels-bump", s.doc.pixelRev > px0);
      // ... and a change in the SOURCE canvas re-mirrors the reference layer
      s.docs[bi].doc.pixelRev++;
      s.syncRefLayers();
      ok("rev.pixels-remirror", composes > comp0);
    } finally {
      cmod.composeFrame = origFrame;
    }
  }

  // --- autosave: interval writes + pure JSON (RLE) payload, no PNG ---
  {
    (globalThis as unknown as { localStorage: { clear(): void } }).localStorage.clear();
    const amod = require("../src/io/autosave") as Record<string, unknown>;
    const origSave = amod.saveAutosave;
    let saves = 0;
    let lastText = "";
    amod.saveAutosave = async (text: string) => { saves++; lastText = text; return "idb"; };
    try {
      const s = new Session();
      const cel = s.doc.ensureCel(0, 0);
      cel.data[0] = 12; cel.data[1] = 34; cel.data[2] = 56; cel.data[3] = 255;
      cel.data[4] = 12; cel.data[5] = 34; cel.data[6] = 56; cel.data[7] = 255;
      s.scheduleAutosave();
      eq("autosave.no-immediate-write", saves, 0);   // interval, not a debounce
      await s.writeAutosave();
      eq("autosave.writes-once", saves, 1);
      ok("autosave.json-rle", lastText.indexOf('"celsRle"') >= 0 && lastText.indexOf('"cels"') < 0, lastText.slice(0, 140));
      const back = await project.parseSpace(lastText);
      ok("autosave.roundtrip", !!back);
      const px = back!.entries[0].doc.celAt(0, 0)!;
      eq("autosave.pixels", [px.data[0], px.data[1], px.data[2], px.data[3]], [12, 34, 56, 255]);
      await s.writeAutosave();
      eq("autosave.not-dirty-no-write", saves, 1);
      await s.flushAutosave();
      eq("autosave.flush-forces", saves, 2);
      // the RLE codec round-trips a noisy buffer as well
      const raw = new Uint8ClampedArray(64 * 4);
      for (let i = 0; i < raw.length; i++) raw[i] = (i * 37) % 256;
      const dec = project.rleDecodeCel(project.rleEncodeCel(raw), 8, 8)!;
      eq("autosave.rle-roundtrip", dec.join(), raw.join());
    } finally {
      amod.saveAutosave = origSave;
    }
  }

  // --- project files keep layer ids: a per-layer reference survives a reload ---
  {
    (globalThis as unknown as { localStorage: { clear(): void } }).localStorage.clear();
    const pj = new Session();
    pj.doc.name = "A";
    const bi = pj.addCanvas(new Doc(8, 8, "B"));
    pj.docs[bi].doc.layers[0].name = "\u5f71\u5b50";
    pj.focusCanvas(0);
    ok("proj.ref-add", pj.referenceCanvas(bi));
    const text = await pj.serializeProject();
    const parsed = await project.parseSpace(text);
    ok("proj.parse", !!parsed);
    const holder = parsed!.entries[0].doc;
    const src = parsed!.entries[1].doc;
    eq("proj.layer-count", holder.layers.length, 2);
    eq("proj.ref-canvas-id", holder.layers[1].ref, parsed!.entries[1].id);
    eq("proj.ref-layer-id", holder.layers[1].refLayer, src.layers[0].id);
    eq("proj.ref-layer-name", holder.layers[1].name, "\u5f71\u5b50");
  }
}
