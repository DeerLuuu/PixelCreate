import { Doc } from "../engine/doc";
import { Cel } from "../engine/cel";
import { History, type HistoryDump, type HistoryDumpEntry } from "../engine/history";
import { uid } from "../engine/types";
import type { Rect, RGBA, BlendMode } from "../engine/types";
import { defaultPalette } from "../data/palettes";
import { hexToRgba, rgbaToHex } from "../engine/color";
import * as ops from "../engine/ops";
import * as fxE from "../engine/effects";
import * as compositor from "../render/compositor";
import * as project from "../io/project";
import * as historyFile from "../io/historyfile";
import { scalarActions, type ScalarData } from "./history-io";
import * as autosave from "../io/autosave";
import * as refstore from "../io/refstore";
import type { RefImg } from "../io/refstore";
import { toast as toastFn } from "../io/bridge";
import * as bridge from "../io/bridge";
import type { ToolId, BrushState, SymMode } from "../tools/registry";
import { GESTURES, isActionAllowed, type GestureActionId } from "./gestures";
import { isShapeTool, nextSym, SYM_ANGLES } from "../tools/registry";
import type { View } from "../render/view";
import * as selM from "../tools/select";
import { mirrorMaskInPlace } from "../engine/symmetry";
import { adjustPixel, type HslAdj } from "../engine/adjust";
import { type LoopMode, nextLoopMode, nextPlayFrame, startPlayDir, startPlayFrame } from "./playback";
import { SETTINGS_BY_PATH, normalizeSetting, type SettingValue } from "./settings";
import { snapToTargets, snapCandidates, snapGapRect, stackGap, type GapRect, type SnapTarget } from "./canvas-snap";

export interface Prefs {
  lang: "zh" | "en";
  /** desktop extras: auto (pointer media queries) | on | off */
  pcMode: "auto" | "on" | "off";
  /** UI colour theme: dark (default) or the opt-in light palette */
  theme: "dark" | "light";
  /** helper grid: off | pixel grid (cell gridSize) | isometric grid (spacing gridSize) */
  gridMode: "off" | "pixel" | "iso";
  gridSize: number;
  /** pixel loupe magnification: css px per doc pixel in the bottom-left loupe */
  magZoom: number;
  /** show the pixel loupe while picking a colour */
  loupe: boolean;
  /** onion skin master switch */
  onionOn: boolean;
  /** loop-aware onion skin: ghosts wrap around the first/last frame and get
   *  their own colour so the wrap-around is obvious */
  onionWrap: boolean;
  /** how many previous / next frames are ghosted (0..3 each) */
  onionBefore: number;
  onionAfter: number;
  /** opacity of the nearest ghost, percent (10..100) */
  onionAlpha: number;
  /** tint ghosts (previous red / next green) instead of drawing them as-is */
  onionTint: boolean;
  autosave: boolean;
  /** autosave interval in minutes (1..60) */
  autosaveMin: number;
  /** store the operation history inside saved project files */
  recordHistory: boolean;
  /** add frame via FrameAdd: clone current frame's cels into the new one */
  newFrameCopy: boolean;

  // ---- remembered tool / colour / symmetry state (survives a restart) ----
  brushSize: number;
  brushAlpha: number;
  /** "#rrggbb" or "#rrggbbaa" */
  fgColor: string;
  bgColor: string;
  tool: ToolId;
  currentShape: ToolId;
  currentSelect: ToolId;
  brushShape: "circle" | "square";
  /** freehand strokes drop the L-corner pixel (Aseprite pixel-perfect) */
  pixelPerfect: boolean;
  shapeSides: number;
  shapeFill: boolean;
  shapeFromCenter: boolean;
  sym: SymMode;
  symFour: boolean;
  symLocked: boolean;
  symAng: number;
  symOx: number;
  symOy: number;
  /** last used palette (hex strings); seeds new documents */
  palette: string[];
  /** new-document defaults */
  newDocW: number;
  newDocH: number;
  newDocBg: "transparent" | "white";

  // ---- touch / gesture tuning ----
  longPressMs: number;
  doubleTapMs: number;
  tripleTapZoom: number;
  fourFingerPx: number;
  autoPanMargin: number;
  autoPanSpeed: number;
  zoomMin: number;
  zoomMax: number;
  haptic: boolean;
  /** length of one haptic pulse in ms (short pulses are imperceptible on some
   *  ROMs, so this is user-tunable: 30 / 60 / 100) */
  hapticLen: number;
  /** gesture → action mapping (see src/app/gestures.ts) */
  gDoubleTapMargin: GestureActionId;
  gDoubleTapCanvas: GestureActionId;
  gTwoFingerDoubleTap: GestureActionId;
  /** two fingers held still → default: cycle to the next layer */
  gTwoFingerLongPress: GestureActionId;
  /** three fingers held still → same default; avoids the system's two-finger
   *  screen-recognition gesture on some phones (vivo / OPPO) */
  gThreeFingerLongPress: GestureActionId;
  gTripleTap: GestureActionId;
  gFourFinger: GestureActionId;
  gLongPress: GestureActionId;
  /** landscape: swap side rails (default on: control rail right, actions left) */
  railSwap: boolean;
  /** hide the system status / navigation bars (immersive full screen) */
  immersive: boolean;
  /** keep UI clear of the notch / punch hole and the gesture bar */
  safeArea: boolean;
  /** extra safe-area padding in px for ROMs that report nothing (0 = off) */
  safeExtra: number;
  previewBg: "white" | "black" | "checker";
  /** preview box: draw the artwork in greyscale (value/contrast check) */
  previewGray: boolean;
  /** tiled preview around the canvas: off / horizontal row / vertical column /
   *  3x3 grid (only the centre canvas is editable — for seamless tiles) */
  tileMode: "off" | "row" | "col" | "grid";
  /** height of the whole timeline panel in px (the drag handle resizes this) */
  tlH: number;
  /** tlH semantics marker: 2 = whole-panel height (1.x older = matrix max) */
  tlHv: number;
  
  /** history recording: "steps" keeps the latest histSteps entries, "full" records everything */
  histMode: "steps" | "full";
  histSteps: number;
  /** drop shadow target: false = on the current layer, true = new "shadow" layer */
  shadowNewLayer: boolean;
  /** auto-pan the canvas when a brush/selection drag reaches the viewport edge */
  autoPan: boolean;
  /** canvas snapping: master switch, magnetic range (screen px), the empty
   *  space left between two snapped canvases (doc px) and the two colours */
  snapOn: boolean;
  snapRange: number;
  snapGap: number;
  snapInColor: string;
  snapOutColor: string;
  /** paint bucket: fill every matching pixel in the layer (true) or only the
   *  connected region (false) */
  bucketGlobal: boolean;
  /** bucket: match colours within a per-channel tolerance ("similar colour") */
  fillSimilar: boolean;
  fillTolerance: number;
  /** bucket: seal gaps up to N px in the region boundary before filling */
  fillGaps: number;
  /** indexed-colour mode: painting only ever uses palette colours */
  indexed: boolean;
  /** paint bucket gradient mode: ramp the filled region FG -> BG */
  bucketGrad: boolean;
  /** gradient quantisation: "rgb" = per-pixel ramp, "2"/"4"/"8" = block size */
  bucketGradMode: "rgb" | "2" | "4" | "8";
  /** airbrush: smallest / largest random speck in px (1..16) */
  airbrushMin: number;
  airbrushMax: number;
  /** airbrush: specks sprayed per second (5..60) */
  airbrushRate: number;
  /** playback loop mode */
  loopMode: LoopMode;
  /** how many recently used colours the palette panel remembers (4..64) */
  recentColorsMax: number;
  /** magic-wand colour tolerance (0..64) */
  selectionTolerance: number;
}

export interface Snapshot {
  lang: Prefs["lang"];
  tool: ToolId;
  shape: ToolId;
  brushSize: number;
  brushAlpha: number; // alpha of current color (0..255)
  colorHex: string;
  layerIdx: number;
  frameIdx: number;
  layerCount: number;
  frameCount: number;
  canUndo: boolean;
  canRedo: boolean;
  onionOn: boolean;
  gridMode: Prefs["gridMode"];
  gridSize: number;
  previewBg: Prefs["previewBg"];
  previewGray: boolean;
  tileMode: Prefs["tileMode"];
  selActive: boolean;
  docName: string;
  w: number;
  h: number;
  playing: boolean;
  loopMode: LoopMode;
  /** frames picked in the timeline for a batch operation */
  frameSel: number[];
  /** true while the timeline is in "pick frames" mode */
  frameSelOn: boolean;
  /** how many canvases are open in the space, which one is focused */
  canvasCount: number;
  canvasIdx: number;
  /** name of the focused canvas (game-style title bar) */
  canvasName: string;
  /** how many floating preview windows are open */
  previewCount: number;
}

/** one open canvas: its document plus where it sits in the infinite space
 *  (doc-space pixels, top-left) and its own layer/frame selection */
export interface CanvasEntry {
  /** stable id: reference layers point at it (survives save/load) */
  id: string;
  doc: Doc;
  x: number;
  y: number;
  li: number;
  fi: number;
  /** position locked: the title bar can no longer drag this canvas */
  locked?: boolean;
  /** canvases snapped together share a group id and move as one */
  group?: string | null;
}

/** a floating preview window showing one canvas */
export interface PreviewEntry {
  id: string;
  /** index into Session.docs */
  canvas: number;
  /** window position in css px (null = place automatically) */
  x: number | null;
  y: number | null;
  size: number;
}

export class Session {
  /** every canvas open in the infinite space; docs[docIdx] is the focused one.
   *  An empty array is a valid state: a fresh install starts with NO canvas and
   *  the shell shows the empty-space screen until one is created or opened. */
  docs: CanvasEntry[] = [];
  docIdx = 0;
  /** floating preview windows (created from the canvas orb) */
  previews: PreviewEntry[] = [];
  /** stand-in document while no canvas is open (the UI is hidden then) */
  private emptyDoc: Doc | null = null;
  /** ONE undo stack for the whole project: steps remember which canvas they
   *  edited, so undo/redo and the replay walk every canvas in order */
  history = new History();

  /** the focused canvas entry, or null when nothing is open */
  private ensureEntry(): CanvasEntry | null {
    if (!this.docs.length) return null;
    if (this.docIdx < 0 || this.docIdx >= this.docs.length) this.docIdx = 0;
    return this.docs[this.docIdx];
  }
  /** the focused document (every existing caller keeps working unchanged) */
  get doc(): Doc {
    const e = this.ensureEntry();
    if (e) return e.doc;
    if (!this.emptyDoc) this.emptyDoc = new Doc(1, 1, "untitled");
    return this.emptyDoc;
  }
  set doc(d: Doc) {
    const e = this.ensureEntry();
    if (e) e.doc = d;
    else this.docs.push(this.newEntry(d, 0, 0));
  }
  private newEntry(doc: Doc, x: number, y: number): CanvasEntry {
    return { id: uid(), doc, x, y, li: 0, fi: 0, locked: false, group: null };
  }
  /** the canvas a reference layer points at (null when it is gone) */
  private entryOf(id: string | null | undefined): CanvasEntry | null {
    if (!id) return null;
    return this.docs.find((d) => d.id === id) ?? null;
  }
  /** pixels of a referenced canvas (its current frame) laid out on a w×h grid,
   *  centred. `layerId` mirrors exactly ONE layer of it (its opacity applied);
   *  null mirrors the flattened canvas. */
  private refPixels(refId: string, w: number, h: number, layerId?: string | null): Uint8ClampedArray | null {
    const e = this.entryOf(refId);
    if (!e) return null;
    const fi = Math.max(0, Math.min(e.doc.frames.length - 1, e.fi));
    const sw = e.doc.w, sh = e.doc.h;
    const ox = Math.round((w - sw) / 2), oy = Math.round((h - sh) / 2);
    if (layerId) {
      const out = new Uint8ClampedArray(w * h * 4);
      const li = e.doc.layers.findIndex((l) => l.id === layerId);
      if (li < 0) return out; // the source layer is gone: the mirror empties
      const cel = e.doc.celAt(li, fi);
      if (!cel) return out;
      const op = Math.max(0, Math.min(100, e.doc.layers[li].opacity)) / 100;
      for (let y = 0; y < sh; y++) {
        const ty = y + oy;
        if (ty < 0 || ty >= h) continue;
        for (let x = 0; x < sw; x++) {
          const tx = x + ox;
          if (tx < 0 || tx >= w) continue;
          const p = (y * sw + x) * 4, q = (ty * w + tx) * 4;
          const a = cel.data[p + 3];
          if (!a) continue;
          out[q] = cel.data[p]; out[q + 1] = cel.data[p + 1]; out[q + 2] = cel.data[p + 2];
          out[q + 3] = Math.round(a * op);
        }
      }
      return out;
    }
    const src = compositor.composeFrame(e.doc, fi);
    if (sw === w && sh === h) return new Uint8ClampedArray(src.getContext("2d")!.getImageData(0, 0, w, h).data);
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d")!;
    ctx.drawImage(src, ox, oy);
    return new Uint8ClampedArray(ctx.getImageData(0, 0, w, h).data);
  }
  /** last mirrored state per reference layer: `${holderId}:${layerId}` */
  private refSync = new Map<string, string>();
  /** the exact pixels we last mirrored, so a DIRECT edit of a reference layer
   *  (selection fill / move / FX … — anything that does not go through the
   *  stroke redirect) can be pushed back into the source canvas */
  private refMirror = new Map<string, Uint8ClampedArray>();

  /** reference-layer key: one entry per (canvas, layer) */
  private refKey(holder: CanvasEntry, L: { id: string }): string {
    return holder.id + ":" + L.id;
  }

  /**
   * A reference layer can be edited through paths that write its cel directly
   * (selection fill/paste/move, effects, …). Those edits only touch the mirror,
   * so they are diffed against what we mirrored last time and written back into
   * the SOURCE canvas — that keeps "edit either side, the other follows" true
   * for every tool, not just the brush. History is recorded in the canvas the
   * user was working in (undo works right there).
   */
  private pushMirrorEdits(holder: CanvasEntry | null): void {
    if (!holder) return;
    for (let li = 0; li < holder.doc.layers.length; li++) {
      const L = holder.doc.layers[li];
      if (!L?.ref) continue;
      const key = this.refKey(holder, L);
      const last = this.refMirror.get(key);
      const cel = holder.doc.celAt(li, 0);
      const src = this.entryOf(L.ref);
      if (!last || !cel || !src || last.length !== cel.data.length) continue;
      const d = cel.data;
      const idx: number[] = [];
      const vals: number[] = [];
      for (let p = 0; p < last.length; p += 4) {
        if (last[p] === d[p] && last[p + 1] === d[p + 1] && last[p + 2] === d[p + 2] && last[p + 3] === d[p + 3]) continue;
        idx.push(p >> 2);
        vals.push(d[p], d[p + 1], d[p + 2], d[p + 3]);
      }
      if (!idx.length) continue;
      const post = Uint8ClampedArray.from(vals);
      // map the changed pixels back into the source canvas (mirror is centred)
      const hw = holder.doc.w, hh = holder.doc.h;
      const sw = src.doc.w, sh = src.doc.h;
      const ox = Math.round((hw - sw) / 2), oy = Math.round((hh - sh) / 2);
      const sli = this.refLayerIndex(src, L.refLayer);
      if (sli < 0) continue;
      const sfi = Math.max(0, Math.min(src.doc.frames.length - 1, src.fi));
      const tcel = src.doc.ensureCel(sli, sfi);
      const before = new Uint8ClampedArray(tcel.data);
      let touched = false;
      for (let k = 0; k < idx.length; k++) {
        const p = idx[k];
        const x = (p % hw) - ox, y = Math.floor(p / hw) - oy;
        if (x < 0 || y < 0 || x >= sw || y >= sh) continue;
        const j = (y * sw + x) * 4, q = k * 4;
        tcel.data[j] = post[q]; tcel.data[j + 1] = post[q + 1];
        tcel.data[j + 2] = post[q + 2]; tcel.data[j + 3] = post[q + 3];
        touched = true;
      }
      if (!touched) continue;
      this.history.pushPixels("layer-ref-edit", src.doc, [{ li: sli, fi: sfi, before, after: new Uint8ClampedArray(tcel.data) }]);
      src.doc.pixelRev++;
      this.refMirror.set(key, new Uint8ClampedArray(d)); // in sync again
    }
  }
  /**
   * Reference layers are MIRRORED into their own cel instead of being resolved
   * while compositing: the render path then is exactly the same as for a normal
   * layer (which is what the device is known to update live while painting).
   * Every frame of the layer shares one cel, because they all show the same
   * canvas. Runs on every repaint / structural change; the source canvas is only
   * re-composed when it actually changed.
   */
  syncRefLayers(): boolean {
    if (!this.docs.length) return false;
    let touched = false;
    // edits that wrote a reference layer directly go back to its source first
    this.pushMirrorEdits(this.ensureEntry());
    // two passes so a chain A -> B -> C settles within one call
    for (let pass = 0; pass < 2; pass++) {
      for (const holder of this.docs) {
        for (let li = 0; li < holder.doc.layers.length; li++) {
          const L = holder.doc.layers[li];
          if (!L?.ref) continue;
          const src = this.entryOf(L.ref);
          const key = holder.id + ":" + L.id;
          const stamp = src
            ? src.doc.pixelRev + ":" + holder.doc.frames.length + ":" + holder.doc.w + "x" + holder.doc.h + ":" + (L.refLayer ?? "*")
            : "gone";
          if (this.refSync.get(key) === stamp) continue;
          this.refSync.set(key, stamp);
          if (!src) continue;
          const px = this.refPixels(src.id, holder.doc.w, holder.doc.h, L.refLayer);
          if (!px) continue;
          const cel = holder.doc.ensureCel(li, 0);
          cel.data.set(px);
          touched = true;
          this.refMirror.set(key, new Uint8ClampedArray(px));
          // every frame of a reference layer shows the same picture: share one cel
          for (let fi = 0; fi < holder.doc.frames.length; fi++) holder.doc.cels.set(holder.doc.key(li, fi), cel);
          holder.doc.pixelRev++;
        }
      }
    }
    return touched;
  }
  /** foreground / background slots */
  fg: RGBA = [20, 20, 20, 255];
  bg: RGBA = [255, 255, 255, 255];
  /** the ACTIVE slot: `color` aliases fg or bg, and the brush paints `color` */
  color!: RGBA;
  colorTarget: "fg" | "bg" = "fg";
  brushSize = 1;
  tool: ToolId = "pencil";
  currentShape: import("../tools/registry").ToolId = "line";
  currentSelect: import("../tools/registry").ToolId = "select";
  layerIdx = 0;
  frameIdx = 0;
  prefs: Prefs;
  clip: import("../engine/cel").Cel | null = null;
  colorPicking = false;
  sym: SymMode = "off";
  /** four-way symmetry: also mirror across the perpendicular axis (cross) */
  symFour = false;
  /** axis is locked (not movable / intersecting hidden); toggle via the button */
  symLocked = false;
  /** adjustable mirror axis: pivot offset (symOx/symOy) from the doc centre
   *  in doc gridline units plus the axis angle (degrees, from 0/45/90/135). */
  symOx = 0;
  symOy = 0;
  symAng = 90;
  symTweaked = false;
  shapeSides = 6;
  /** shapes draw filled (true) or hollow outline (false) */
  shapeFill = true;
  /** rect/ellipse/circle/polygon grow from the centre instead of the corner */
  shapeFromCenter = false;
  /** brush tip: round disc (default) or square block */
  brushShape: "circle" | "square" = "circle";
  /** pixel-perfect freehand strokes (see Stroke) */
  pixelPerfect = true;
  private lastColorAt = 0;
  playing = false;
  loopMode: LoopMode = "loop";
  private playDir: 1 | -1 = 1;
  // ---------- reference image (persisted in IndexedDB) ----------
  /** the floating reference picture, restored on launch */
  refImg: RefImg | null = null;
  /** its window geometry + opacity */
  refBox: { x: number; y: number; size: number; opacity: number } = { x: 12, y: 12, size: 148, opacity: 100 };
  private refTimer: number | null = null;

  /** show a new reference image (null = hide) and remember it */
  setRefImage(img: RefImg | null, box?: Partial<Session["refBox"]>): void {
    if (box) this.refBox = { ...this.refBox, ...box };
    this.refImg = img;
    if (img) void refstore.saveRef({ ...img, ...this.refBox });
    else void refstore.clearRef();
    this.changed();
  }
  /** move / resize / fade the reference window (persisted, debounced) */
  setRefBox(box: Partial<Session["refBox"]>): void {
    this.refBox = { ...this.refBox, ...box };
    if (this.refImg) {
      if (this.refTimer !== null) window.clearTimeout(this.refTimer);
      this.refTimer = window.setTimeout(() => {
        this.refTimer = null;
        if (this.refImg) void refstore.saveRef({ ...this.refImg, ...this.refBox });
      }, 500);
    }
    this.changed();
  }
  /** called once at startup: bring back the last reference image */
  async restoreRefImage(): Promise<void> {
    const st = await refstore.loadRef();
    if (!st) return;
    this.refBox = { x: st.x, y: st.y, size: st.size, opacity: st.opacity };
    this.refImg = { w: st.w, h: st.h, px: st.px, name: st.name };
    this.changed();
  }

  /** most recently used colours, newest first (palette panel "recent" mode) */
  recentColors: RGBA[] = [];
  private recentSaveTimer: number | null = null;
  private docColorCache: { rev: number; colors: RGBA[] } | null = null;
  private playTimer: number | null = null;
  private autosaveTimer: number | null = null;
  /** changes happened since the last autosave write */
  private autosaveDirty = false;
  private replayActive = false;
  private opacityLive: { li: number; from: number; to: number } | null = null;
  /** visibility of every layer before the last solo-hide (null = not soloing) */
  private soloBackup: boolean[] | null = null;
  private view_: View | null = null;
  private listeners = new Set<() => void>();
  private previewCbs = new Set<() => void>();
  private rev = 0;
  private snapCache: Snapshot | null = null;
  private snapRev = -1;

  constructor() {
    this.prefs = this.loadPrefs();
    this.doc = new Doc(64, 64, "untitled");
    // the remembered palette wins over the built-in default
    this.doc.palette = this.prefs.palette.length ? this.prefs.palette.map((h) => hexToRgba(h)) : defaultPalette();
    this.applyRememberedState();
    this.color = this.fg;
    this.loopMode = this.prefs.loopMode;
    this.recentColors = this.loadRecentColors();
    this.myPalettes = this.loadMyPalettes();
    this.applyHistoryLimit();
    // Android may kill a backgrounded WebView without warning: flush the
    // autosave the moment the app is hidden so the last strokes survive
    try {
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", () => {
          if (document.hidden) void this.flushAutosave();
        });
      }
    } catch { /* ignore */ }
  }

  /** push the remembered tool/colour/symmetry values into the live fields */
  private applyRememberedState(): void {
    const p = this.prefs;
    this.brushSize = p.brushSize;
    this.tool = p.tool;
    this.currentShape = p.currentShape;
    this.currentSelect = p.currentSelect;
    this.brushShape = p.brushShape;
    this.pixelPerfect = p.pixelPerfect;
    this.shapeSides = p.shapeSides;
    this.shapeFill = p.shapeFill;
    this.shapeFromCenter = p.shapeFromCenter;
    this.sym = p.sym;
    this.symFour = p.symFour;
    this.symLocked = p.symLocked;
    this.symAng = p.symAng;
    this.symOx = p.symOx;
    this.symOy = p.symOy;
    this.fg = hexToRgba(p.fgColor);
    this.bg = hexToRgba(p.bgColor);
    if (p.brushAlpha !== 255) this.fg[3] = p.brushAlpha;
    this.color = this.fg;
  }
  /** debounced prefs write for the hot paths (brush size, colours, sym drag) */
  private prefsTimer: number | null = null;
  scheduleSavePrefs(): void {
    if (this.prefsTimer !== null) return;
    this.prefsTimer = window.setTimeout(() => {
      this.prefsTimer = null;
      this.savePrefs();
    }, 600);
  }
  /** remember the current palette so a new document starts with it */
  private rememberPalette(): void {
    this.prefs.palette = this.doc.palette.map((c) => "#" + [c[0], c[1], c[2]]
      .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join(""));
    this.scheduleSavePrefs();
  }

  /** one haptic pulse, gated by the setting. `tag` shows up in the
   *  diagnostics line so it is visible which gesture actually fired.
   *  `scale` lengthens/shortens the pulse relative to prefs.hapticLen. */
  hapticTick(tag: string, scale = 1): boolean {
    if (!this.prefs.haptic) return false;
    return bridge.vibrate(Math.round(this.prefs.hapticLen * scale), tag);
  }

  /** Run the action a gesture is mapped to. Returns false when nothing ran.
   *  UI-level actions (timeline / preview / palette) are broadcast as a
   *  "pc-gesture" event so the React shell can open the right thing. */
  runGestureAction(action: GestureActionId, ctx?: { x?: number; y?: number }): boolean {
    const v = this.view_;
    if (action === "none") return false;
    // every gesture confirms itself with a short tick (except the eyedropper,
    // which ticks per sampled pixel from the view)
    if (action !== "pickColor") this.hapticTick("手势:" + action, 0.9);
    switch (action) {
      case "undo":
        if (this.history.canUndo()) this.undo();
        return true;
      case "redo":
        if (this.history.canRedo()) this.redo();
        return true;
      case "zoomIn":
        if (v) v.zoomAt(Math.min(this.prefs.zoomMax, v.zoom * this.prefs.tripleTapZoom), ctx?.x, ctx?.y);
        return true;
      case "zoomOut":
        if (v) v.zoomAt(Math.max(this.prefs.zoomMin, v.zoom / this.prefs.tripleTapZoom), ctx?.x, ctx?.y);
        return true;
      case "fitView":
        if (v) { v.fit(); v.refresh(false); }
        return true;
      case "togglePlay":
        this.togglePlay();
        return true;
      case "toggleOnion":
        this.toggleOnion();
        return true;
      case "toggleGrid":
        this.setGridMode(this.prefs.gridMode === "off" ? "pixel" : "off");
        return true;
      case "toggleSymmetry":
        this.cycleSym();
        return true;
      case "nextFrame":
        this.setFrame(this.curFrame() + 1);
        return true;
      case "prevFrame":
        this.setFrame(this.curFrame() - 1);
        return true;
      case "nextLayer":
        this.cycleLayer(1);
        return true;
      case "prevLayer":
        this.cycleLayer(-1);
        return true;
      case "toggleTimeline":
      case "framePreview":
      case "openPalette":
        window.dispatchEvent(new CustomEvent("pc-gesture", { detail: action }));
        return true;
      case "pickColor":
        // the view owns the pixel coordinates; it handles this one itself
        return false;
    }
  }

  /** enforce the configured recording mode on the history stack */
  applyHistoryLimit(): void {
    if (this.prefs.histMode === "full") this.history.setCap(Infinity);
    else {
      this.history.setCap(this.prefs.histSteps);
      this.history.trimToCap();
    }
  }
  setHistMode(m: "steps" | "full"): void { this.setSetting("history.mode", m); }
  setHistSteps(n: number): void { this.setSetting("history.steps", n); }


  attachView(v: View | null): void {
    this.view_ = v;
  }
  get view(): View | null {
    return this.view_;
  }

  registerPreview(fn: () => void): () => void {
    this.previewCbs.add(fn);
    return () => this.previewCbs.delete(fn);
  }
  private firePreviews(): void {
    for (const f of this.previewCbs) {
      try { f(); } catch { /* ignore */ }
    }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  /** remember the focused canvas' layer/frame selection in its entry */
  private syncEntry(): void {
    const e = this.docs[this.docIdx];
    if (e) { e.li = this.layerIdx; e.fi = this.frameIdx; }
  }
  getVersion(): number {
    return this.rev;
  }
  /**
   * UI-only state changed (tool, colour, a setting, a preview window …): the
   * pixels are untouched, so the content version is NOT bumped and the
   * reference-layer mirror / other-canvas caches stay valid. Call changed()
   * for anything that really alters pixels or the document structure.
   */
  changedUI(): void {
    this.syncEntry(); // the focused canvas remembers its layer/frame
    this.rev++;
    this.snapCache = null;
    for (const l of this.listeners) l();
  }
  /** content changed: bump the pixel version and refresh reference mirrors */
  changed(): void {
    this.syncEntry(); // the focused canvas remembers its layer/frame
    this.doc.pixelRev++; // structural changes count as a content change
    // keep mirrored reference layers up to date; when a mirror really changed
    // the view has to repaint as well (its composite is built from the cels)
    if (this.syncRefLayers()) this.view_?.invalidate();
    this.rev++;
    this.snapCache = null;
    for (const l of this.listeners) l();
  }

  // ---------- overwrite confirmation (new/open/import wipe the current doc) ----------
  private confirmAsk: ((q: { msg: string; yes: string; no: string }) => Promise<boolean>) | null = null;
  /** App registers a styled confirm dialog here; without one we skip the prompt */
  setConfirmAsk(fn: ((q: { msg: string; yes: string; no: string }) => Promise<boolean>) | null): void {
    this.confirmAsk = fn;
  }
  /** ask the user to confirm something (resolves false when no dialog is wired) */
  async askConfirm(q: { msg: string; yes: string; no: string }): Promise<boolean> {
    if (!this.confirmAsk) return false;
    return await this.confirmAsk(q);
  }
  private textAsk: ((q: { title: string; value: string; ok: string; cancel: string }) => Promise<string | null>) | null = null;
  /** App registers a styled single-line text prompt here */
  setTextAsk(fn: ((q: { title: string; value: string; ok: string; cancel: string }) => Promise<string | null>) | null): void {
    this.textAsk = fn;
  }
  /** prompt for a single line of text (null = cancelled) */
  async askText(q: { title: string; value: string; ok: string; cancel: string }): Promise<string | null> {
    if (!this.textAsk) return null;
    return await this.textAsk(q);
  }
  /** true when the doc holds any work worth protecting */
  private isDirty(): boolean {
    if (this.history.canUndo() || this.history.canRedo()) return true;
    for (const cel of this.doc.cels.values()) if (cel.hasAnyOpaque()) return true;
    return false;
  }
  /** ask before wiping the current doc; returns false when the user declines */
  async askOverwrite(kind: "new" | "open"): Promise<boolean> {
    if (!this.isDirty()) return true;
    const cb = this.confirmAsk;
    if (!cb) return true;
    const zh = kind === "new"
      ? { msg: "当前作品尚未保存，新建将丢弃现有内容。确定继续？", yes: "继续新建", no: "取消" }
      : { msg: "打开/导入会替换当前作品，且会清空操作记录（无法撤销）。建议先保存工程。确定继续？", yes: "继续打开", no: "取消" };
    const en = kind === "new"
      ? { msg: "The current artwork is unsaved. A new document discards it. Continue?", yes: "Continue", no: "Cancel" }
      : { msg: "Opening/importing replaces the artwork and clears the undo history (cannot be undone). Saving first is recommended. Continue?", yes: "Continue", no: "Cancel" };
    const d = this.prefs.lang === "en" ? en : zh;
    return await cb({ msg: d.msg, yes: d.yes, no: d.no });
  }

  snapshot(): Snapshot {
    if (this.snapRev === this.rev && this.snapCache) return this.snapCache;
    const snap: Snapshot = {
      lang: this.prefs.lang,
      tool: this.tool,
      shape: isShapeTool(this.tool) ? this.tool : this.currentShape,
      brushSize: this.brushSize,
      brushAlpha: this.color[3],
      colorHex: rgbaToHex(this.color),
      layerIdx: this.curLayer(),
      frameIdx: this.curFrame(),
      layerCount: this.doc.layers.length,
      frameCount: this.doc.frames.length,
      canUndo: this.history.canUndo(),
      canRedo: this.history.canRedo(),
      onionOn: this.prefs.onionOn,
      gridMode: this.prefs.gridMode,
  gridSize: this.prefs.gridSize,
      previewBg: this.prefs.previewBg,
      previewGray: this.prefs.previewGray,
      tileMode: this.prefs.tileMode,
      selActive: this.doc.selectionActive(),
      docName: this.doc.name,
      w: this.doc.w,
      h: this.doc.h,
      playing: this.playing,
      loopMode: this.loopMode,
      frameSel: this.frameSelList(),
      frameSelOn: this.frameSelOn,
      canvasCount: this.docs.length,
      canvasIdx: this.docIdx,
      canvasName: this.doc.name,
      previewCount: this.previews.length,
    };
    this.snapCache = snap;
    this.snapRev = this.rev;
    return snap;
  }

  curLayer(): number {
    return Math.max(0, Math.min(this.doc.layers.length - 1, this.layerIdx));
  }
  curFrame(): number {
    return Math.max(0, Math.min(this.doc.frames.length - 1, this.frameIdx));
  }
  brush(): BrushState {
    return { color: this.color, size: this.brushSize, alpha: this.color[3], pressure: 1 };
  }
  layerLocked(): boolean {
    const L = this.doc.layers[this.curLayer()];
    if (!L) return false;
    // a reference layer is never paintable in place: strokes are redirected to
    // the source canvas, which enforces ITS own lock
    if (L.ref) return this.refPaintBlock(this.curLayer()) !== null;
    return L.locked;
  }
  /** which layer of a source canvas a mirror shows: the bound layer, or (for a
   *  flattened reference) whatever layer is selected in the source right now */
  private refLayerIndex(src: CanvasEntry, refLayer?: string | null): number {
    if (refLayer) return src.doc.layers.findIndex((l) => l.id === refLayer);
    return Math.max(0, Math.min(src.doc.layers.length - 1, src.li));
  }
  /** why a reference layer cannot be painted right now (null = it can):
   *  its source layer is locked, or no longer exists */
  refPaintBlock(li: number): "locked" | "gone" | null {
    const L = this.doc.layers[li];
    if (!L?.ref) return null;
    const e = this.entryOf(L.ref);
    if (!e) return null; // the source canvas is gone: the mirror paints locally
    const sli = this.refLayerIndex(e, L.refLayer);
    if (sli < 0) return "gone";
    return e.doc.layers[sli].locked ? "locked" : null;
  }
  /** tell the user why nothing was painted (a silent no-op is the worst case) */
  paintBlockedNote(): void {
    const en = this.prefs.lang === "en";
    const why = this.refPaintBlock(this.curLayer());
    if (why === "locked") toastFn(en ? "That layer is locked in the source canvas" : "源画布里的该图层已锁定");
    else if (why === "gone") toastFn(en ? "The referenced layer is gone — release the reference to paint here" : "被引用的图层已不存在——解除引用后即可在此绘制");
    else toastFn(en ? "This layer is locked" : "该图层已锁定");
  }
  /** the canvas a reference layer points at (null = normal layer / gone) */
  refSourceOf(li: number): CanvasEntry | null {
    const L = this.doc.layers[li];
    return L?.ref ? this.entryOf(L.ref) : null;
  }
  /** the source layer a mirror shows (null = the whole flattened canvas) */
  refSourceLayerOf(li: number): { name: string; li: number } | null {
    const L = this.doc.layers[li];
    const e = this.entryOf(L?.ref);
    if (!L?.ref || !e) return null;
    if (!L.refLayer) return null;
    const k = e.doc.layers.findIndex((l) => l.id === L.refLayer);
    return k < 0 ? null : { name: e.doc.layers[k].name, li: k };
  }
  /** where the referenced canvas' pixels sit inside this canvas (centred) */
  refOffset(li: number): { ox: number; oy: number } {
    const src = this.refSourceOf(li);
    if (!src) return { ox: 0, oy: 0 };
    return {
      ox: Math.round((this.doc.w - src.doc.w) / 2),
      oy: Math.round((this.doc.h - src.doc.h) / 2),
    };
  }
  /** true when the given layer mirrors another canvas */
  isRefLayer(li: number): boolean {
    return !!this.doc.layers[li]?.ref;
  }
  /** where a stroke on layer `li` really lands: the layer of the referenced
   *  canvas this mirror shows (a bound layer, or the source's current one for a
   *  flattened reference), or null for a normal layer */
  strokeTarget(li: number): { doc: Doc; li: number; fi: number; refId: string; dx: number; dy: number } | null {
    const L = this.doc.layers[li];
    const e = this.entryOf(L?.ref);
    if (!L?.ref || !e) return null;
    const sli = this.refLayerIndex(e, L.refLayer);
    if (sli < 0) return null; // the mirrored layer no longer exists
    const off = this.refOffset(li);
    return {
      doc: e.doc,
      li: sli,
      fi: Math.max(0, Math.min(e.doc.frames.length - 1, e.fi)),
      refId: e.id,
      // the mirror is centred: a cell of THIS canvas maps to the source by
      // subtracting this offset (see Stroke.refDx / refDy)
      dx: off.ox,
      dy: off.oy,
    };
  }
  /**
   * Reference another canvas into this one.
   *  - mode "layers" (default): every layer of the source becomes its own live
   *    reference layer, in the same order, each bound to that exact source
   *    layer — so painting/undo land where you expect and the holder shows the
   *    source's layer structure (artwork + shadow …).
   *  - mode "flat": one layer mirroring the flattened canvas (edits go to the
   *    source's currently selected layer).
   */
  referenceCanvas(canvasIndex: number, opts?: { mode?: "layers" | "flat" }): boolean {
    const src = this.docs[canvasIndex];
    if (!src || src === this.entryOf(this.docs[this.docIdx]?.id)) {
      toastFn(this.prefs.lang === "en" ? "Cannot reference the current canvas" : "不能引用当前画布");
      return false;
    }
    // refuse a link that would form a cycle (A -> B -> A)
    if (this.refReaches(src.id, this.docs[this.docIdx]?.id)) {
      toastFn(this.prefs.lang === "en" ? "That would create a reference loop" : "这样会形成循环引用");
      return false;
    }
    const flat = opts?.mode === "flat";
    const srcLayers = src.doc.layers.map((l) => ({ id: l.id, name: l.name }));
    const at = this.curLayer() + 1;
    this.struct("layer-ref", () => {
      const d = this.doc;
      const added: Doc["layers"] = flat || !srcLayers.length
        ? [{ id: uid(), name: src.doc.name || "ref", visible: true, opacity: 100, blend: "normal", locked: false, ref: src.id, refLayer: null }]
        : srcLayers.map((L) => ({
            id: uid(), name: L.name, visible: true, opacity: 100, blend: "normal" as const,
            locked: false, ref: src.id, refLayer: L.id,
          }));
      d.layers.splice(at, 0, ...added);
      this.layerIdx = at + added.length - 1; // the top-most mirror
    });
    this.refSync.clear();
    this.syncRefLayers();
    const n = this.doc.layers.filter((l) => l.ref === src.id).length;
    toastFn(this.prefs.lang === "en"
      ? "Referenced " + (src.doc.name || "canvas") + (flat ? "" : " (" + n + " layers, live)")
      : "已引用画布「" + (src.doc.name || "") + "」" + (flat ? "" : "（" + n + " 个图层，实时联动）"));
    return true;
  }
  /** true when `fromId` already (transitively) references `targetId` */
  private refReaches(fromId: string | null | undefined, targetId: string | null | undefined): boolean {
    if (!fromId || !targetId) return false;
    const seen = new Set<string>();
    const stack = [fromId];
    while (stack.length) {
      const id = stack.pop()!;
      if (id === targetId) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const e = this.entryOf(id);
      if (!e) continue;
      for (const L of e.doc.layers) if (L.ref) stack.push(L.ref);
    }
    return false;
  }
  /** can this (flattened) reference be split into one mirror per source layer? */
  canSplitRef(li = this.curLayer()): boolean {
    const L = this.doc.layers[li];
    const e = this.entryOf(L?.ref);
    return !!L?.ref && !L.refLayer && !!e && e.doc.layers.length > 1;
  }
  /** upgrade a flattened reference (saved by an older build) into one mirror
   *  per source layer, in place — the same thing a fresh reference now creates */
  splitRefLayer(li = this.curLayer()): boolean {
    const L = this.doc.layers[li];
    const e = this.entryOf(L?.ref);
    if (!L?.ref || L.refLayer || !e || e.doc.layers.length < 2) return false;
    this.syncRefLayers(); // flush pending direct edits back into the source first
    const srcId = e.id;
    const metas = e.doc.layers.map((s) => ({ id: s.id, name: s.name }));
    this.struct("layer-ref", () => {
      const d = this.doc;
      const cur = d.layers[li];
      if (!cur) return;
      const added = metas.map((m) => ({
        id: uid(), name: m.name, visible: cur.visible, opacity: cur.opacity,
        blend: cur.blend, locked: false, ref: srcId, refLayer: m.id,
      }));
      d.layers.splice(li, 1, ...added);
      // the old mirror cel (one per frame) goes; the cels above shift up
      const shift = added.length - 1;
      for (const k of [...d.cels.keys()]) {
        const [kls, kf] = k.split(":");
        const kl = Number(kls);
        if (kl === li) { d.cels.delete(k); continue; }
        if (kl > li && shift) {
          const cel = d.cels.get(k)!;
          d.cels.delete(k);
          d.cels.set((kl + shift) + ":" + kf, cel);
        }
      }
      this.layerIdx = li + added.length - 1;
    });
    this.refSync.clear();
    this.refMirror.clear();
    this.syncRefLayers();
    toastFn(this.prefs.lang === "en"
      ? "Split into " + metas.length + " reference layers"
      : "已拆成 " + metas.length + " 条引用图层");
    return true;
  }
  /** break the link of a reference layer, keeping the pixels it shows */  unrefLayer(li = this.curLayer()): void {
    const doc = this.doc;
    const L = doc.layers[li];
    if (!L?.ref) return;
    const px = this.refPixels(L.ref, doc.w, doc.h, L.refLayer);
    this.struct("layer-unref", () => {
      const d = this.doc;
      const N = d.layers[li];
      if (!N) return;
      N.ref = null;
      N.refLayer = null;
      // frames shared one cel while the link was live: split them now
      for (let fi = 0; fi < d.frames.length; fi++) {
        const cel = new Cel(d.w, d.h);
        const old = d.cels.get(d.key(li, fi));
        if (px) cel.data.set(px);
        else if (old) cel.data.set(old.data);
        d.cels.set(d.key(li, fi), cel);
      }
    });
    this.refSync.clear();
    this.refMirror.clear();
    toastFn(this.prefs.lang === "en" ? "Reference released, pixels kept" : "已解除引用，图层内容保留");
  }
  /** release EVERY reference layer of this canvas in one step (keeps pixels) */
  unrefAll(): number {
    const doc = this.doc;
    const list = doc.layers.map((L, li) => ({ L, li })).filter((x) => !!x.L.ref);
    if (!list.length) return 0;
    const px = list.map(({ L }) => this.refPixels(L.ref!, doc.w, doc.h, L.refLayer));
    this.struct("layer-unref", () => {
      const d = this.doc;
      for (let n = 0; n < list.length; n++) {
        const { li } = list[n];
        const N = d.layers[li];
        if (!N) continue;
        N.ref = null;
        N.refLayer = null;
        for (let fi = 0; fi < d.frames.length; fi++) {
          const cel = new Cel(d.w, d.h);
          const old = d.cels.get(d.key(li, fi));
          if (px[n]) cel.data.set(px[n]!);
          else if (old) cel.data.set(old.data);
          d.cels.set(d.key(li, fi), cel);
        }
      }
    });
    this.refSync.clear();
    this.refMirror.clear();
    toastFn(this.prefs.lang === "en" ? "All references released, pixels kept" : "已解除全部引用，图层内容保留");
    return list.length;
  }
  /** move the current layer out into a canvas of its own */
  async extractLayerToCanvas(li = this.curLayer()): Promise<number | null> {
    const doc = this.doc;
    const L = doc.layers[li];
    if (!L) return null;
    const en = this.prefs.lang === "en";
    const ok = await this.askConfirm({
      msg: en
        ? "Extract layer \"" + L.name + "\" into its own canvas? It is removed from this canvas."
        : "把图层「" + L.name + "」提取为单独画布？提取后该图层会从当前画布移除。",
      yes: this.prefs.lang === "en" ? "Extract" : "提取",
      no: this.prefs.lang === "en" ? "Cancel" : "取消",
    });
    if (!ok) return null;
    const refPx = L.ref ? this.refPixels(L.ref, doc.w, doc.h, L.refLayer) : null;
    const nd = new Doc(doc.w, doc.h, (doc.name || "art") + "_" + L.name);
    nd.palette = doc.palette.map((c) => [...c] as RGBA);
    nd.bg = null;
    nd.frames = doc.frames.map((f) => ({ id: uid(), durationMs: f.durationMs }));
    nd.layers = [{ id: uid(), name: L.name, visible: true, opacity: L.opacity, blend: "normal", locked: false }];
    nd.cels = new Map();
    for (let fi = 0; fi < doc.frames.length; fi++) {
      const cel = doc.celAt(li, fi);
      const nc = nd.ensureCel(0, fi);
      if (cel) nc.data.set(cel.data);
      else if (refPx) nc.data.set(refPx);
    }
    this.struct("layer-extract", () => {
      const d = this.doc;
      d.layers.splice(li, 1);
      if (!d.layers.length) {
        d.layers.push({ id: uid(), name: "Layer 1", visible: true, opacity: 100, blend: "normal", locked: false });
      }
      for (const k of [...d.cels.keys()]) {
        const [kl] = k.split(":");
        if (Number(kl) === li) d.cels.delete(k);
        else if (Number(kl) > li) {
          const cel = d.cels.get(k)!;
          d.cels.delete(k);
          d.cels.set((Number(kl) - 1) + ":" + k.split(":")[1], cel);
        }
      }
      this.layerIdx = Math.max(0, Math.min(d.layers.length - 1, li - 1));
    });
    this.addCanvas(nd);
    toastFn(en ? "Extracted into its own canvas" : "已提取为单独画布");
    return this.docs.length - 1;
  }
  /** magic-wand tolerance lives on prefs so it persists and shows in Settings */
  get selectionTolerance(): number {
    return this.prefs.selectionTolerance;
  }

  // ---------- settings registry (declared in src/app/settings.ts) ----------
  /** current value of a declared setting by its dotted path */
  settingValue(path: string): SettingValue {
    const d = SETTINGS_BY_PATH.get(path);
    if (!d) return false;
    if (d.get) return d.get(this);
    return this.prefs[d.field as keyof Prefs] as SettingValue;
  }
  /** store a setting by path: normalize, persist, then run its side effects */
  setSetting(path: string, raw: SettingValue): void {
    const d = SETTINGS_BY_PATH.get(path);
    if (!d) return;
    const v = normalizeSetting(d, raw);
    if (v === null) return;
    if (d.set) d.set(this, v);
    else (this.prefs as unknown as Record<string, SettingValue>)[d.field as string] = v;
    d.after?.(this, v);
    this.savePrefs();
    if (d.refresh === "repaintAll") this.repaintAll();
    else if (d.refresh === "repaint") this.repaint();
    this.changedUI();
  }

  // ---------- canvas ----------
  /**
   * Quick fill at a screen point (palette fan drag & drop): the canvas under
   * the point is focused and bucket-filled with `color` in one history step.
   * @returns the canvas index that was filled, -1 when the point missed.
   */
  quickFill(sx: number, sy: number, color: RGBA): number {
    return this.view_ ? this.view_.quickFill(sx, sy, color) : -1;
  }

  repaint(): void {
    this.doc.pixelRev++;
    this.syncRefLayers();
    this.view_?.invalidate();
    this.firePreviews();
    this.scheduleAutosave();
  }
  /** Live-stroke repaint: only `rect` (doc space) changed, so the compositor
   *  and the canvas update just that region. null = full frame. */
  repaintRect(rect: Rect | null): void {
    this.doc.pixelRev++;
    this.syncRefLayers();
    this.view_?.invalidate(rect);
    this.firePreviews();
    this.scheduleAutosave();
  }
  repaintAll(): void {
    this.doc.pixelRev++;
    this.syncRefLayers();
    this.view_?.markDirty();
    this.view_?.refresh(true);
    this.firePreviews();
  }
  private lastSaveNote = 0;
  /** mark replay mode: skip autosave while the history replay viewer steps */
  setReplayMode(on: boolean): void { this.replayActive = on; }
  /** mark the project dirty; the actual write happens on the autosave
   *  INTERVAL (Settings -> Data, default 5 minutes), not on every change.
   *  Hiding the app still flushes immediately (flushAutosave). */
  scheduleAutosave(): void {
    if (!this.prefs.autosave || this.replayActive) return;
    this.autosaveDirty = true;
    if (this.autosaveTimer !== null) return;
    const ms = Math.max(10_000, Math.round((this.prefs.autosaveMin || 5) * 60_000));
    this.autosaveTimer = window.setTimeout(() => {
      this.autosaveTimer = null;
      void this.writeAutosave().then(() => {
        if (this.autosaveDirty && !this.replayActive) this.scheduleAutosave();
      });
    }, ms);
  }
  async writeAutosave(force = false): Promise<void> {
    if (!force && !this.autosaveDirty) return;
    this.autosaveDirty = false;
    try {
      // the autosave stores pure JSON (RLE cel data), not PNG images
      const txt = await this.serializeProject({ cels: "rle" });
      const meta = {
        savedAt: Date.now(), bytes: txt.length, name: this.doc.name,
        w: this.doc.w, h: this.doc.h,
        frames: this.doc.frames.length, layers: this.doc.layers.length,
      };
      const where = await autosave.saveAutosave(txt, meta);
      if ((where === "fail" || where === "too-big") && Date.now() - this.lastSaveNote > 8000) {
        this.lastSaveNote = Date.now();
        const en = this.prefs.lang === "en";
        toastFn(where === "too-big"
          ? (en ? "Autosave skipped (project too large)" : "自动保存跳过（工程过大）")
          : (en ? "Autosave failed (storage full)" : "自动保存失败（存储空间不足）"));
      }
    } catch { /* ignore */ }
  }
  /** write right now (page hidden / about to be killed): never lose the last strokes */
  async flushAutosave(): Promise<void> {
    if (!this.prefs.autosave || this.replayActive) return;
    if (this.autosaveTimer !== null) {
      window.clearTimeout(this.autosaveTimer);
      this.autosaveTimer = null;
    }
    await this.writeAutosave(true);
  }
  /** bring back the autosaved space at launch (no confirmation prompt) */
  async restoreAutosave(): Promise<boolean> {
    try {
      const rec = await autosave.loadAutosave();
      if (!rec) return false;
      return await this.loadProjectText(rec.text, { ask: false });
    } catch { return false; }
  }
  /** metadata of the newest autosave (settings screen) */
  autosaveInfo(): Promise<autosave.AutosaveMeta | null> {
    return autosave.autosaveMeta();
  }
  async clearAutosave(): Promise<void> {
    await autosave.clearAutosave();
  }
  syncAll(): void {
    // refresh the reference mirrors FIRST: the composite below is built from the
    // cels, so a mirror updated after the blit would not show up until the next
    // repaint (undo/redo used to look one step behind on reference layers)
    this.syncRefLayers();
    this.view_?.refresh(true);
    this.changed();
    this.firePreviews();
  }

  private loadPrefs(): Prefs {
    const p: Prefs = {
      lang: "zh", theme: "dark", pcMode: "auto", gridMode: "off", gridSize: 1, magZoom: 12, loupe: true,
      onionOn: false, onionBefore: 1, onionAfter: 0, onionAlpha: 55, onionTint: true, onionWrap: true,
      autosave: true, autosaveMin: 5, recordHistory: true, newFrameCopy: false, railSwap: true, previewBg: "white", previewGray: false, tileMode: "off", tlH: 200, tlHv: 2,
      immersive: true, safeArea: true, safeExtra: 0,
      histMode: "steps", histSteps: 120, shadowNewLayer: false, autoPan: true,
      snapOn: true, snapRange: 14, snapGap: 8, snapInColor: "#78ffb4", snapOutColor: "#ff6464",
      bucketGlobal: false, fillSimilar: false, fillTolerance: 32, fillGaps: 0, indexed: false,
      loopMode: "loop", recentColorsMax: 16, selectionTolerance: 8,
      bucketGrad: false, bucketGradMode: "rgb",
      airbrushMin: 1, airbrushMax: 3, airbrushRate: 20,
      brushSize: 1, brushAlpha: 255, fgColor: "#141414", bgColor: "#ffffff",
      tool: "pencil", currentShape: "line", currentSelect: "select",
      brushShape: "circle", pixelPerfect: true, shapeSides: 6, shapeFill: true, shapeFromCenter: false,
      sym: "off", symFour: false, symLocked: false, symAng: 90, symOx: 0, symOy: 0,
      palette: [], newDocW: 64, newDocH: 64, newDocBg: "transparent",
      longPressMs: 300, doubleTapMs: 420, tripleTapZoom: 2, fourFingerPx: 15,
      autoPanMargin: 34, autoPanSpeed: 3, zoomMin: 0.05, zoomMax: 32,
      haptic: true, hapticLen: 60,
      gDoubleTapMargin: "undo", gDoubleTapCanvas: "none", gTwoFingerDoubleTap: "redo",
      gTwoFingerLongPress: "nextLayer", gThreeFingerLongPress: "nextLayer",
      gTripleTap: "zoomIn", gFourFinger: "framePreview", gLongPress: "pickColor",
    };
    try {
      const saved = JSON.parse(localStorage.getItem("pc.prefs") ?? "{}");
      if (saved.lang === "en") p.lang = "en";
      if (saved.theme === "light" || saved.theme === "dark") p.theme = saved.theme;
      if (saved.pcMode === "on" || saved.pcMode === "off" || saved.pcMode === "auto") p.pcMode = saved.pcMode;
      if (saved.gridMode === "pixel" || saved.gridMode === "iso") p.gridMode = saved.gridMode;
      else if (saved.grid === true) p.gridMode = "pixel"; // migrate the old checkbox
      if (typeof saved.gridSize === "number") p.gridSize = Math.max(1, Math.min(64, Math.round(saved.gridSize)));
      if (typeof saved.magZoom === "number") p.magZoom = Math.max(8, Math.min(20, Math.round(saved.magZoom)));
      if (typeof saved.loupe === "boolean") p.loupe = saved.loupe;
      // onion: migrate the old 0/1/2 tri-state into the fine-grained prefs
      if (saved.onion === 1) { p.onionOn = true; p.onionBefore = 1; p.onionAfter = 0; }
      else if (saved.onion === 2) { p.onionOn = true; p.onionBefore = 1; p.onionAfter = 1; }
      if (typeof saved.onionOn === "boolean") p.onionOn = saved.onionOn;
      if (typeof saved.onionBefore === "number") p.onionBefore = Math.max(0, Math.min(3, Math.round(saved.onionBefore)));
      if (typeof saved.onionAfter === "number") p.onionAfter = Math.max(0, Math.min(3, Math.round(saved.onionAfter)));
      if (typeof saved.onionAlpha === "number") p.onionAlpha = Math.max(10, Math.min(100, Math.round(saved.onionAlpha)));
      if (typeof saved.onionTint === "boolean") p.onionTint = saved.onionTint;
      if (typeof saved.onionWrap === "boolean") p.onionWrap = saved.onionWrap;
      if (saved.previewBg === "black" || saved.previewBg === "checker" || saved.previewBg === "white") p.previewBg = saved.previewBg;
      if (typeof saved.previewGray === "boolean") p.previewGray = saved.previewGray;
      if (saved.tileMode === "row" || saved.tileMode === "col" || saved.tileMode === "grid") p.tileMode = saved.tileMode;
      // migrate the old modes: plain repeat was a 3x3 grid, mirror is gone
      else if (saved.tileMode === "repeat" || saved.tileMode === "mirror") p.tileMode = "grid";
      if (typeof saved.autosave === "boolean") p.autosave = saved.autosave;
      if (typeof saved.autosaveMin === "number") p.autosaveMin = Math.max(1, Math.min(60, Math.round(saved.autosaveMin)));
      if (typeof saved.recordHistory === "boolean") p.recordHistory = saved.recordHistory;
      if (typeof saved.newFrameCopy === "boolean") p.newFrameCopy = saved.newFrameCopy;
      if (typeof saved.railSwap === "boolean") p.railSwap = saved.railSwap;
      if (typeof saved.immersive === "boolean") p.immersive = saved.immersive;
      if (typeof saved.safeArea === "boolean") p.safeArea = saved.safeArea;
      if (typeof saved.safeExtra === "number") p.safeExtra = Math.max(0, Math.min(40, Math.round(saved.safeExtra)));
      if (typeof saved.tlH === "number") {
        // older builds stored the matrix max-height (56–340); this build stores
        // the whole panel height (140–520) — migrate by adding the chrome
        const raw = saved.tlHv === 2 ? saved.tlH : saved.tlH + 84;
        p.tlH = Math.max(140, Math.min(520, Math.round(raw)));
      }
      if (saved.histMode === "full" || saved.histMode === "steps") p.histMode = saved.histMode;
      if (typeof saved.histSteps === "number") p.histSteps = Math.max(10, Math.min(500, Math.round(saved.histSteps)));
      if (typeof saved.shadowNewLayer === "boolean") p.shadowNewLayer = saved.shadowNewLayer;
      if (typeof saved.autoPan === "boolean") p.autoPan = saved.autoPan;
      if (typeof saved.snapOn === "boolean") p.snapOn = saved.snapOn;
      if (typeof saved.fillSimilar === "boolean") p.fillSimilar = saved.fillSimilar;
      if (typeof saved.fillTolerance === "number") p.fillTolerance = Math.max(0, Math.min(255, Math.round(saved.fillTolerance)));
      if (typeof saved.fillGaps === "number") p.fillGaps = Math.max(0, Math.min(16, Math.round(saved.fillGaps)));
      if (typeof saved.indexed === "boolean") p.indexed = saved.indexed;
      if (typeof saved.snapRange === "number") p.snapRange = Math.max(4, Math.min(48, Math.round(saved.snapRange)));
      if (typeof saved.snapGap === "number") p.snapGap = Math.max(0, Math.min(48, Math.round(saved.snapGap)));
      if (typeof saved.snapInColor === "string" && /^#[0-9a-fA-F]{6}$/.test(saved.snapInColor)) p.snapInColor = saved.snapInColor.toLowerCase();
      if (typeof saved.snapOutColor === "string" && /^#[0-9a-fA-F]{6}$/.test(saved.snapOutColor)) p.snapOutColor = saved.snapOutColor.toLowerCase();
      if (typeof saved.bucketGlobal === "boolean") p.bucketGlobal = saved.bucketGlobal;
      if (typeof saved.bucketGrad === "boolean") p.bucketGrad = saved.bucketGrad;
      if (saved.bucketGradMode === "rgb" || saved.bucketGradMode === "2" || saved.bucketGradMode === "4" || saved.bucketGradMode === "8") p.bucketGradMode = saved.bucketGradMode;
      if (typeof saved.airbrushMin === "number") p.airbrushMin = Math.max(1, Math.min(16, Math.round(saved.airbrushMin)));
      if (typeof saved.airbrushMax === "number") p.airbrushMax = Math.max(1, Math.min(16, Math.round(saved.airbrushMax)));
      if (typeof saved.airbrushRate === "number") p.airbrushRate = Math.max(5, Math.min(60, Math.round(saved.airbrushRate)));
      if (saved.loopMode === "once" || saved.loopMode === "loop" || saved.loopMode === "pingpong" || saved.loopMode === "reverse") p.loopMode = saved.loopMode;
      if (typeof saved.recentColorsMax === "number") p.recentColorsMax = Math.max(4, Math.min(64, Math.round(saved.recentColorsMax)));
      if (typeof saved.selectionTolerance === "number") p.selectionTolerance = Math.max(0, Math.min(64, Math.round(saved.selectionTolerance)));
      // remembered tool / colour / symmetry / document state
      const hex = (v: unknown): string | null => (typeof v === "string" && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v) ? v.toLowerCase() : null);
      if (typeof saved.brushSize === "number") p.brushSize = Math.max(1, Math.min(64, Math.round(saved.brushSize)));
      if (typeof saved.brushAlpha === "number") p.brushAlpha = Math.max(0, Math.min(255, Math.round(saved.brushAlpha)));
      const fg = hex(saved.fgColor); if (fg) p.fgColor = fg;
      const bg = hex(saved.bgColor); if (bg) p.bgColor = bg;
      const toolIds = ["pencil", "eraser", "bucket", "picker", "line", "rect", "rectfill", "ellipse",
        "ellipsefill", "circle", "polygon", "select", "wand", "lasso"];
      if (typeof saved.tool === "string" && toolIds.includes(saved.tool)) p.tool = saved.tool;
      if (typeof saved.currentShape === "string" && toolIds.includes(saved.currentShape)) p.currentShape = saved.currentShape;
      if (typeof saved.currentSelect === "string" && toolIds.includes(saved.currentSelect)) p.currentSelect = saved.currentSelect;
      if (saved.brushShape === "square" || saved.brushShape === "circle") p.brushShape = saved.brushShape;
      if (typeof saved.pixelPerfect === "boolean") p.pixelPerfect = saved.pixelPerfect;
      if (typeof saved.shapeSides === "number") p.shapeSides = Math.max(3, Math.min(32, Math.round(saved.shapeSides)));
      if (typeof saved.shapeFill === "boolean") p.shapeFill = saved.shapeFill;
      if (typeof saved.shapeFromCenter === "boolean") p.shapeFromCenter = saved.shapeFromCenter;
      if (saved.sym === "on" || saved.sym === "off") p.sym = saved.sym;
      if (typeof saved.symFour === "boolean") p.symFour = saved.symFour;
      if (typeof saved.symLocked === "boolean") p.symLocked = saved.symLocked;
      if (typeof saved.symAng === "number") p.symAng = Math.max(0, Math.min(179, Math.round(saved.symAng)));
      if (typeof saved.symOx === "number") p.symOx = saved.symOx;
      if (typeof saved.symOy === "number") p.symOy = saved.symOy;
      if (Array.isArray(saved.palette)) {
        p.palette = (saved.palette as unknown[]).filter((c): c is string => typeof c === "string" && /^#[0-9a-fA-F]{6,8}$/.test(c)).slice(0, 512);
      }
      if (typeof saved.newDocW === "number") p.newDocW = Math.max(1, Math.min(1024, Math.round(saved.newDocW)));
      if (typeof saved.newDocH === "number") p.newDocH = Math.max(1, Math.min(1024, Math.round(saved.newDocH)));
      if (saved.newDocBg === "white" || saved.newDocBg === "transparent") p.newDocBg = saved.newDocBg;
      if (typeof saved.longPressMs === "number") p.longPressMs = Math.max(200, Math.min(800, Math.round(saved.longPressMs)));
      if (typeof saved.doubleTapMs === "number") p.doubleTapMs = Math.max(250, Math.min(600, Math.round(saved.doubleTapMs)));
      if (typeof saved.tripleTapZoom === "number") p.tripleTapZoom = Math.max(1, Math.min(4, Math.round(saved.tripleTapZoom)));
      if (typeof saved.fourFingerPx === "number") p.fourFingerPx = Math.max(8, Math.min(40, Math.round(saved.fourFingerPx)));
      if (typeof saved.autoPanMargin === "number") p.autoPanMargin = Math.max(16, Math.min(80, Math.round(saved.autoPanMargin)));
      if (typeof saved.autoPanSpeed === "number") p.autoPanSpeed = Math.max(1, Math.min(6, Math.round(saved.autoPanSpeed)));
      if (typeof saved.zoomMin === "number") p.zoomMin = Math.max(0.05, Math.min(1, saved.zoomMin));
      if (typeof saved.zoomMax === "number") p.zoomMax = Math.max(2, Math.min(64, saved.zoomMax));
      if (p.zoomMax < p.zoomMin * 2) p.zoomMax = Math.min(64, p.zoomMin * 8);
      if (typeof saved.haptic === "boolean") p.haptic = saved.haptic;
      if (typeof saved.hapticLen === "number") p.hapticLen = Math.max(20, Math.min(150, Math.round(saved.hapticLen)));
      // gesture mapping: only accept actions the gesture actually offers
      for (const g of GESTURES) {
        const v = (saved as Record<string, unknown>)[g.field];
        if (typeof v === "string" && isActionAllowed(g.id, v)) {
          (p as unknown as Record<string, string>)[g.field] = v;
        }
      }
      /* palette floater style fixed to ball */
    } catch {
      /* ignore */
    }
    return p;
  }
  savePrefs(): void {
    try {
      localStorage.setItem("pc.prefs", JSON.stringify(this.prefs));
    } catch {
      /* ignore */
    }
  }

  // ---------- ui setters ----------
  /** current paint colour (= the active fg/bg slot) */
  currentColor(): RGBA { return this.color; }
  /** while set, the next colour chosen anywhere is handed to this callback
   *  instead of changing the paint colour (FX dialogs pick a parameter) */
  private colorPickCb: ((c: RGBA) => void) | null = null;
  /** route the next picked colour to `cb` (the palette panel closes itself) */
  awaitColorPick(cb: (c: RGBA) => void): void { this.colorPickCb = cb; }
  cancelColorPick(): void { this.colorPickCb = null; }

  /** edit the ACTIVE slot (this mutates the array `color` aliases) */
  setColor(c: RGBA): void {
    const want = this.colorPickCb;
    if (want) {
      // a parameter pick must not touch the paint colour
      this.colorPickCb = null;
      want([c[0], c[1], c[2], c[3]]);
      try { window.dispatchEvent(new CustomEvent("pc-color-picked")); } catch { /* ignore */ }
      return;
    }
    const arr = this.color;
    arr[0] = c[0]; arr[1] = c[1]; arr[2] = c[2]; arr[3] = c[3];
    this.lastColorAt = Date.now();
    this.pushRecentColor(arr);
    this.rememberColors();
    this.changedUI();
  }
  /** pickers set the fg slot and make it active (paint follows) */
  setFgColor(c: RGBA): void {
    const f = this.fg;
    f[0] = c[0]; f[1] = c[1]; f[2] = c[2]; f[3] = c[3];
    this.colorTarget = "fg";
    this.color = this.fg;
    this.lastColorAt = Date.now();
    this.pushRecentColor(f);
    this.rememberColors();
    this.changedUI();
  }
  setColorTarget(t: "fg" | "bg"): void {
    this.colorTarget = t;
    this.color = t === "bg" ? this.bg : this.fg;
    this.lastColorAt = Date.now();
    this.changedUI();
  }
  swapColors(): void {
    const tmp: RGBA = [this.fg[0], this.fg[1], this.fg[2], this.fg[3]];
    const f = this.fg, b = this.bg;
    f[0] = b[0]; f[1] = b[1]; f[2] = b[2]; f[3] = b[3];
    b[0] = tmp[0]; b[1] = tmp[1]; b[2] = tmp[2]; b[3] = tmp[3];
    // `color` already aliases the active slot array; contents were swapped
    this.lastColorAt = Date.now();
    this.pushRecentColor(this.color);
    this.rememberColors();
    this.changedUI();
  }

  // ---------- user-saved palettes ----------
  /** palettes the user saved from the current document palette (persisted) */
  myPalettes: Array<{ id: string; name: string; colors: string[] }> = [];
  private static readonly MY_PAL_KEY = "pc.palettes.mine";

  private loadMyPalettes(): Array<{ id: string; name: string; colors: string[] }> {
    try {
      const raw = JSON.parse(localStorage.getItem(Session.MY_PAL_KEY) ?? "[]");
      if (!Array.isArray(raw)) return [];
      return raw
        .filter((p) => p && typeof p.id === "string" && Array.isArray(p.colors))
        .map((p) => ({
          id: String(p.id),
          name: String(p.name ?? "palette"),
          colors: (p.colors as unknown[]).filter((c): c is string => typeof c === "string" && /^#[0-9a-fA-F]{6,8}$/.test(c)).slice(0, 512),
        }))
        .filter((p) => p.colors.length > 0);
    } catch {
      return [];
    }
  }
  private saveMyPalettes(): void {
    try { localStorage.setItem(Session.MY_PAL_KEY, JSON.stringify(this.myPalettes)); } catch { /* ignore */ }
  }
  /** store the current document palette as a named preset; returns its name */
  savePalettePreset(name?: string): string {
    const colors = this.doc.palette.map((c) => "#" + [c[0], c[1], c[2]]
      .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join(""));
    if (!colors.length) return "";
    const label = (name ?? "").trim() || (this.prefs.lang === "en" ? "My palette " : "我的色板 ") + (this.myPalettes.length + 1);
    this.myPalettes = [...this.myPalettes, { id: "my" + uid(), name: label, colors }];
    this.saveMyPalettes();
    this.changed();
    return label;
  }
  deletePalettePreset(id: string): boolean {
    const before = this.myPalettes.length;
    this.myPalettes = this.myPalettes.filter((p) => p.id !== id);
    if (this.myPalettes.length === before) return false;
    this.saveMyPalettes();
    this.changed();
    return true;
  }

  // ---------- recent colours (palette panel "recent" mode) ----------
  private loadRecentColors(): RGBA[] {
    try {
      const raw = JSON.parse(localStorage.getItem("pc.recentColors") ?? "[]");
      if (!Array.isArray(raw)) return [];
      return raw
        .filter((c) => Array.isArray(c) && c.length >= 3 && c.every((n) => typeof n === "number"))
        .slice(0, 64)
        .map((c) => [c[0] | 0, c[1] | 0, c[2] | 0, c[3] === undefined ? 255 : c[3] | 0] as RGBA);
    } catch { return []; }
  }
  private saveRecentColors(): void {
    if (this.recentSaveTimer !== null) return;
    this.recentSaveTimer = window.setTimeout(() => {
      this.recentSaveTimer = null;
      try { localStorage.setItem("pc.recentColors", JSON.stringify(this.recentColors)); } catch { /* ignore */ }
    }, 800);
  }
  /** remember a colour the user just picked (newest first, de-duplicated) */
  pushRecentColor(c: RGBA): void {
    const max = Math.max(4, Math.min(64, Math.round(this.prefs.recentColorsMax)));
    const same = (a: RGBA, b: RGBA): boolean => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
    const col: RGBA = [c[0], c[1], c[2], c[3] === undefined ? 255 : c[3]];
    const list = this.recentColors.filter((x) => !same(x, col));
    list.unshift(col);
    this.recentColors = list.slice(0, max);
    this.saveRecentColors();
  }
  /** every distinct opaque colour currently used anywhere in the document */
  docColors(): RGBA[] {
    if (this.docColorCache && this.docColorCache.rev === this.rev) return this.docColorCache.colors;
    const seen = new Set<number>();
    const out: RGBA[] = [];
    for (const cel of this.doc.cels.values()) {
      const d = cel.data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        const key = (d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3];
        if (seen.has(key)) continue;
        seen.add(key);
        out.push([d[i], d[i + 1], d[i + 2], d[i + 3]]);
        if (out.length >= 512) { this.docColorCache = { rev: this.rev, colors: out }; return out; }
      }
    }
    this.docColorCache = { rev: this.rev, colors: out };
    return out;
  }
  setRecentColorsMax(n: number): void { this.setSetting("display.recentColors", n); }
  /** keep the recent-colour list within the configured limit */
  trimRecentColors(): void {
    const max = Math.max(4, Math.min(64, Math.round(this.prefs.recentColorsMax)));
    if (this.recentColors.length > max) {
      this.recentColors = this.recentColors.slice(0, max);
      this.saveRecentColors();
    }
  }
  /** paint bucket: fill only the connected region (false) or every matching pixel */
  setBucketGlobal(on: boolean): void { this.setSetting("tools.bucketGlobal", on); }
  /** paint bucket: flat fill vs FG→BG gradient ramp */
  setBucketGrad(on: boolean): void { this.setSetting("tools.bucketGrad", on); }
  setBucketGradMode(m: "rgb" | "2" | "4" | "8"): void { this.setSetting("tools.bucketGradMode", m); }
  /** bottom-bar chip: cycle rgb → 2×2 → 4×4 → 8×8 */
  cycleBucketGradMode(): "rgb" | "2" | "4" | "8" {
    const order: Array<"rgb" | "2" | "4" | "8"> = ["rgb", "2", "4", "8"];
    const next = order[(order.indexOf(this.prefs.bucketGradMode) + 1) % order.length];
    this.setBucketGradMode(next);
    return next;
  }

  /** bucket "similar colour" master switch + tolerance + gap closing */
  setFillSimilar(on: boolean): void {
    this.prefs.fillSimilar = on;
    this.savePrefs();
    this.changedUI();
  }
  setFillTolerance(n: number): void {
    this.prefs.fillTolerance = Math.max(0, Math.min(255, Math.round(n)));
    this.savePrefs();
    this.changedUI();
  }
  setFillGaps(n: number): void {
    this.prefs.fillGaps = Math.max(0, Math.min(16, Math.round(n)));
    this.savePrefs();
    this.changedUI();
  }
  /** indexed-colour mode: every painted pixel snaps to a palette colour */
  setIndexed(on: boolean): void {
    this.prefs.indexed = on;
    this.savePrefs();
    this.changedUI();
  }
  /** nearest palette colour (RGB distance); the alpha of `c` is kept. An empty
   *  palette (or indexed mode off) leaves the colour untouched. */
  paletteSnap(c: RGBA): RGBA {
    const pal = this.doc.palette;
    if (!this.prefs.indexed || !pal.length) return c;
    let best = pal[0];
    let bd = Infinity;
    for (const p of pal) {
      const dr = p[0] - c[0], dg = p[1] - c[1], db = p[2] - c[2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bd) { bd = d; best = p; }
    }
    return [best[0], best[1], best[2], c[3]];
  }
  /** rewrite every pixel of the focused canvas (or one layer) to its nearest
   *  palette colour — the one-time conversion into indexed mode */
  remapToPalette(scope: "layer" | "canvas" = "canvas"): number {
    const doc = this.doc;
    const pal = doc.palette;
    if (!pal.length) {
      toastFn(this.prefs.lang === "en" ? "The palette is empty" : "调色板是空的");
      return 0;
    }
    const nearest = (r: number, g: number, b: number): RGBA => {
      let best = pal[0], bd = Infinity;
      for (const p of pal) {
        const dr = p[0] - r, dg = p[1] - g, db = p[2] - b;
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; best = p; }
      }
      return best;
    };
    const cache = new Map<number, RGBA>();
    const lis = scope === "layer" ? [this.curLayer()] : doc.layers.map((_, i) => i);
    let touched = 0;
    this.struct("palette-index", () => {
      const d = this.doc;
      for (const li of lis) {
        for (let fi = 0; fi < d.frames.length; fi++) {
          const cel = d.celAt(li, fi);
          if (!cel) continue;
          let any = false;
          const data = cel.data;
          for (let i = 0; i < data.length; i += 4) {
            if (!data[i + 3]) continue;
            const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
            let c = cache.get(key);
            if (!c) { c = nearest(data[i], data[i + 1], data[i + 2]); cache.set(key, c); }
            if (c[0] === data[i] && c[1] === data[i + 1] && c[2] === data[i + 2]) continue;
            data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2];
            any = true;
          }
          if (any) touched++;
        }
      }
    });
    toastFn(this.prefs.lang === "en"
      ? (touched ? "Mapped " + touched + " cel(s) to the palette" : "Already palette colours")
      : (touched ? "已把 " + touched + " 个图层帧映射到调色板" : "画面已经全部是调色板颜色"));
    return touched;
  }
  /** airbrush speck range / rate (the min<=max clamp lives in settings.ts) */
  setAirbrushMin(n: number): void { this.setSetting("tools.airbrushMin", n); }
  setAirbrushMax(n: number): void { this.setSetting("tools.airbrushMax", n); }
  setAirbrushRate(n: number): void { this.setSetting("tools.airbrushRate", n); }
  /** colour source shown by the palette floater fan (swatch / canvas / recent) */
  palOrbMode: "palette" | "doc" | "recent" = "palette";
  cyclePalOrbMode(): void {
    const order = ["palette", "doc", "recent"] as const;
    const i = order.indexOf(this.palOrbMode);
    this.palOrbMode = order[(i + 1) % order.length];
    this.changed();
  }
  /** colours the palette floater should currently show */
  palOrbColors(): RGBA[] {
    if (this.palOrbMode === "doc") return this.docColors();
    if (this.palOrbMode === "recent") return this.recentColors;
    return this.doc.palette;
  }

  // ---------- HSL adjustment (live preview, one history step on commit) ----------
  private pendingAdj: { li: number; fi: number; cel: import("../engine/cel").Cel; before: Uint8ClampedArray }[] = [];
  adjustStart(scope: "doc" | "layer"): void {
    this.pendingAdj = [];
    const doc = this.doc;
    const curLi = this.curLayer();
    for (const [k, cel] of Array.from(doc.cels)) {
      const sep = k.indexOf(":");
      const li = Number(k.slice(0, sep));
      const fi = Number(k.slice(sep + 1));
      if (scope === "layer" && li !== curLi) continue;
      this.pendingAdj.push({ li, fi, cel, before: new Uint8ClampedArray(cel.data) });
    }
  }
  adjustLive(a: HslAdj): void {
    const adj = this.pendingAdj;
    if (!adj.length) return;
    for (const p of adj) {
      const d = p.cel.data;
      d.set(p.before);
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        const px = adjustPixel(d[i], d[i + 1], d[i + 2], d[i + 3], a);
        d[i] = px[0]; d[i + 1] = px[1]; d[i + 2] = px[2];
      }
    }
    this.repaintAll();
    this.changed();
  }
  adjustCommit(): void {
    const adj = this.pendingAdj;
    this.pendingAdj = [];
    const diffs: { li: number; fi: number; before: Uint8ClampedArray | null; after: Uint8ClampedArray | null }[] = [];
    for (const p of adj) {
      const a = p.cel.data;
      const b = p.before;
      let changed = false;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { changed = true; break; }
      if (changed) diffs.push({ li: p.li, fi: p.fi, before: b, after: new Uint8ClampedArray(a) });
    }
    if (diffs.length) this.history.pushPixels("adjust-color", this.doc, diffs);
    this.changed();
  }
  adjustCancel(): void {
    const adj = this.pendingAdj;
    this.pendingAdj = [];
    if (adj.length) {
      for (const p of adj) p.cel.data.set(p.before);
      this.repaintAll();
      this.changed();
    }
  }
  setColorPicking(on: boolean): void {
    this.colorPicking = on;
    this.changedUI();
  }
  colorPickedRecently(now: number, windowMs: number): boolean {
    return this.colorPicking || now - this.lastColorAt <= windowMs;
  }
  setTool(t: ToolId): void {
    this.view_?.flushStroke(); // finish a pending polyline / curve
    this.tool = t;
    this.prefs.tool = t;
    this.savePrefs();
    this.changedUI();
  }
  cycleSym(): SymMode {
    const prev = this.sym;
    this.sym = nextSym(prev);
    // enabling applies the default (centred) axis unless already customised
    if (this.sym !== "off" && !this.symTweaked) this.applySymPreset(this.sym);
    this.rememberSym();
    this.changedUI();
    this.repaint(); // show/hide the adjustable symmetry guides
    return this.sym;
  }
  /** persist the symmetry axis state (angle / pivot / flags) */
  rememberSym(): void {
    const p = this.prefs;
    p.sym = this.sym;
    p.symFour = this.symFour;
    p.symLocked = this.symLocked;
    p.symAng = this.symAng;
    p.symOx = this.symOx;
    p.symOy = this.symOy;
    this.scheduleSavePrefs();
  }
  /** toggle four-way symmetry (adds the perpendicular axis through the pivot) */
  setSymFour(on: boolean): void {
    if (this.symFour === on) return;
    this.symFour = on;
    this.rememberSym();
    this.repaint();
    this.changedUI();
  }
  /** lock / unlock the axis (locked = not movable, intersection hidden) */
  setSymLocked(on: boolean): void {
    if (this.symLocked === on) return;
    this.symLocked = on;
    this.rememberSym();
    this.repaint();
    this.changedUI();
  }
  /** step the mirror angle through 0/45/90/135 */
  cycleSymAngle(): number {
    const cur = ((this.symAng % 180) + 180) % 180;
    let idx = SYM_ANGLES.findIndex((a) => a === cur);
    if (idx < 0) idx = 0;
    this.symAng = SYM_ANGLES[(idx + 1) % SYM_ANGLES.length];
    this.rememberSym();
    this.symTweaked = true;
    this.repaint();
    this.changedUI();
    return this.symAng;
  }
  /** mode-preset axis geometry: centred pivot at the default (vertical) angle */
  applySymPreset(m: SymMode): void {
    void m;
    this.symOx = 0;
    this.symOy = 0;
    this.symAng = 90;
    this.symTweaked = false;
    this.rememberSym();
  }
  /** recentre the axis and restore the default angle */
  resetSymAxes(): void {
    this.applySymPreset(this.sym);
    this.repaint();
    this.changedUI();
  }
  setShapeSides(n: number): void {
    this.shapeSides = Math.max(3, Math.min(32, Math.round(n)));
    this.prefs.shapeSides = this.shapeSides;
    this.scheduleSavePrefs();
    this.changedUI();
  }
  setShapeFill(f: boolean): void {
    this.shapeFill = f;
    this.prefs.shapeFill = f;
    this.savePrefs();
    this.changedUI();
  }
  setPalette(colors: Array<[number, number, number, number]>): void {
    if (!colors.length) return;
    this.struct("palette-set", () => {
      this.doc.palette = colors.slice(0, 512).map((c) => [c[0], c[1], c[2], c[3]]);
    });
    this.rememberPalette();
  }
  /** drop duplicate swatches (exact RGBA match, first occurrence wins) */
  paletteDedupe(): number {
    const p = this.doc.palette;
    const seen = new Set<string>();
    const out: RGBA[] = [];
    for (const c of p) {
      const k = c[0] + "," + c[1] + "," + c[2] + "," + c[3];
      if (seen.has(k)) continue;
      seen.add(k);
      out.push([c[0], c[1], c[2], c[3]]);
    }
    const removed = p.length - out.length;
    if (removed > 0) this.setPalette(out);
    return removed;
  }
  /** merge colours in, skipping the ones the palette already has */
  paletteMerge(colors: Array<[number, number, number, number]>): number {
    const have = new Set(this.doc.palette.map((c) => c[0] + "," + c[1] + "," + c[2] + "," + c[3]));
    const add: RGBA[] = [];
    for (const c of colors) {
      const k = c[0] + "," + c[1] + "," + c[2] + "," + c[3];
      if (have.has(k)) continue;
      have.add(k);
      add.push([c[0], c[1], c[2], c[3]]);
    }
    if (!add.length) return 0;
    this.setPalette([...this.doc.palette, ...add]);
    return add.length;
  }
  /** sort the palette by hue (then saturation/lightness) or by lightness */
  paletteSort(mode: "hue" | "light"): void {
    const key = (c: RGBA): number[] => {
      const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const l = (mx + mn) / 2;
      const d = mx - mn;
      let h = 0, sat = 0;
      if (d > 0) {
        sat = d / (1 - Math.abs(2 * l - 1) || 1);
        if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        else if (mx === g) h = ((b - r) / d + 2) / 6;
        else h = ((r - g) / d + 4) / 6;
      }
      // grey colours (no hue) group at the end of a hue sort
      return mode === "hue" ? [sat === 0 ? 1 : 0, h, sat, l] : [l, h, sat];
    };
    const sorted = this.doc.palette
      .map((c, i) => ({ c, i, k: key(c) }))
      .sort((a, b) => {
        for (let j = 0; j < a.k.length; j++) {
          if (a.k[j] !== b.k[j]) return a.k[j] - b.k[j];
        }
        return a.i - b.i; // stable
      })
      .map((e) => e.c);
    // nothing to do when the order is already right
    if (sorted.every((c, i) => c === this.doc.palette[i])) return;
    this.setPalette(sorted);
  }

  /** replace a palette swatch AND recolor every matching pixel (whole sprite) */
  recolorPaletteColor(idx: number, newC: RGBA): void {
    const doc = this.doc;
    const old = doc.palette[idx];
    if (!old) return;
    const nc: RGBA = [newC[0], newC[1], newC[2], newC[3] === undefined ? 255 : newC[3]];
    this.struct("palette-recolor", () => {
      doc.palette[idx] = [nc[0], nc[1], nc[2], nc[3]];
      const or = old[0], og = old[1], ob = old[2];
      for (const cel of doc.cels.values()) {
        const d = cel.data;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] === or && d[i + 1] === og && d[i + 2] === ob) {
            d[i] = nc[0]; d[i + 1] = nc[1]; d[i + 2] = nc[2];
          }
        }
      }
    });
  }
  paletteAdd(c: RGBA): void {
    const doc = this.doc;
    const idx = doc.palette.length;
    const col: RGBA = [c[0], c[1], c[2], c[3]];
    doc.palette.push(col);
    this.history.record("palette-add", {
      apply: () => { if (doc.palette.length <= idx) doc.palette.push(col); },
      unapply: () => { if (doc.palette[idx]) doc.palette.splice(idx, 1); },
    }, { k: "palette-add", idx, color: col }, doc);
    this.rememberPalette();
    this.changed();
  }
  paletteRemove(idx: number): void {
    const doc = this.doc;
    const col = doc.palette[idx];
    if (!col) return;
    doc.palette.splice(idx, 1);
    this.history.record("palette-remove", {
      apply: () => { if (doc.palette.length > idx) doc.palette.splice(idx, 1); },
      unapply: () => { doc.palette.splice(Math.min(idx, doc.palette.length), 0, col); },
    }, { k: "palette-remove", idx, color: col }, doc);
    this.rememberPalette();
    this.changed();
  }
  setBrushSize(n: number): void {
    this.brushSize = Math.max(1, Math.min(64, Math.round(n)));
    this.prefs.brushSize = this.brushSize;
    this.scheduleSavePrefs();
    this.changedUI();
  }
  setBrushShape(s: "circle" | "square"): void {
    this.brushShape = s;
    this.prefs.brushShape = s;
    this.savePrefs();
    this.changedUI();
  }
  /** pixel-perfect freehand strokes (corner pixels of an L are dropped) */
  setPixelPerfect(on: boolean): void {
    this.pixelPerfect = on;
    this.prefs.pixelPerfect = on;
    this.savePrefs();
    this.changedUI();
  }
  setShapeFromCenter(on: boolean): void {
    this.shapeFromCenter = on;
    this.prefs.shapeFromCenter = on;
    this.savePrefs();
    this.changedUI();
  }
  setCurrentShape(id: ToolId): void {
    this.currentShape = id;
    this.prefs.currentShape = id;
    this.savePrefs();
    this.changedUI();
  }
  setCurrentSelect(id: ToolId): void {
    this.currentSelect = id;
    this.prefs.currentSelect = id;
    this.savePrefs();
    this.changedUI();
  }
  setSelectionTolerance(n: number): void { this.setSetting("tools.wandTolerance", n); }
  maskOp(label: string, fn: () => void): void {
    this.history.pushStruct(label, this.doc, fn);
    this.repaintAll();
    this.changed();
  }
  wandAt(x: number, y: number): void {
    this.maskOp("wand", () => {
      selM.wandSelect(this.doc, this.curLayer(), this.curFrame(), x, y, this.selectionTolerance);
      this.mirrorSelectionMask();
    });
  }
  /** when drawing symmetry is on, selection tools mirror their mask too */
  mirrorSelectionMask(): boolean {
    const sel = this.doc.sel;
    if (this.sym === "off" || !sel) return false;
    const changed = mirrorMaskInPlace(sel.mask, this.doc.w, this.doc.h, {
      on: true, four: this.symFour, ox: this.symOx, oy: this.symOy, angDeg: this.symAng,
    });
    if (changed) sel.bump();
    return changed;
  }
  setBrushAlpha(n: number): void {
    this.color[3] = Math.max(0, Math.min(255, Math.round(n)));
    this.prefs.brushAlpha = this.color[3];
    this.rememberColors();
    this.changedUI();
  }
  /** store both colour slots (they carry the current brush opacity too) */
  private rememberColors(): void {
    this.prefs.fgColor = rgbaToHex(this.fg);
    this.prefs.bgColor = rgbaToHex(this.bg);
    this.prefs.brushAlpha = this.color[3];
    this.scheduleSavePrefs();
  }
  /** switch the visible frame. User-initiated switches (timeline taps, prev /
   *  next buttons) are recorded as their own undo step; internal playback and
   *  history restoration pass record=false. */
  setFrame(fi: number, record = true): void {
    const n = this.doc.frames.length;
    const next = Math.max(0, Math.min(n - 1, fi));
    const prev = this.curFrame();
    if (next === prev) return;
    if (record) {
      this.history.record("frame-switch", {
        apply: () => this.applyFrame(next),
        unapply: () => this.applyFrame(prev),
      }, { k: "frame-switch", fi: next, prev }, this.doc);
    }
    this.applyFrame(next);
  }
  /** apply a frame index without touching the history stack */
  private applyFrame(fi: number): void {
    this.frameIdx = Math.max(0, Math.min(this.doc.frames.length - 1, fi));
    this.view_?.setFrame(this.frameIdx);
    this.repaintAll();
    this.changed();
  }
  setLayer(li: number): void {
    this.view_?.flushStroke();
    const n = Math.max(0, Math.min(this.doc.layers.length - 1, li));
    const moved = n !== this.layerIdx;
    this.layerIdx = n;
    // visual confirmation on the canvas: the layer you switched to pulses
    if (moved) this.view_?.flashLayer(n);
    this.changedUI(); // selecting a layer changes no pixels
  }
  /** cycle layers by ±1, skipping hidden ones when there is a choice */
  cycleLayer(delta: number): boolean {
    const n = this.doc.layers.length;
    if (n < 2) return false;
    const cur = this.curLayer();
    for (let i = 1; i <= n; i++) {
      const cand = ((cur + delta * i) % n + n) % n;
      if (this.doc.layers[cand] && this.doc.layers[cand].visible) {
        this.setLayer(cand);
        return true;
      }
    }
    this.setLayer(((cur + delta) % n + n) % n);
    return true;
  }
  /** onion skin master switch (fine-grained options live in Settings) */
  toggleOnion(): void {
    this.prefs.onionOn = !this.prefs.onionOn;
    this.savePrefs();
    this.repaintAll(); // the composite changes; repaintAll bumps the version
    this.changedUI();
  }
  setOnionOn(on: boolean): void { this.setSetting("onion.enabled", on); }
  setOnionBefore(n: number): void { this.setSetting("onion.before", n); }
  setOnionAfter(n: number): void { this.setSetting("onion.after", n); }
  setOnionAlpha(n: number): void { this.setSetting("onion.alpha", n); }
  setOnionTint(on: boolean): void { this.setSetting("onion.tint", on); }
  setOnionWrap(on: boolean): void { this.setSetting("onion.wrap", on); }
  setPreviewBg(b: "white" | "black" | "checker"): void { this.setSetting("display.previewBg", b); }
  setPreviewGray(on: boolean): void { this.setSetting("display.previewGray", on); }
  setTileMode(m: "off" | "row" | "col" | "grid"): void { this.setSetting("canvas.tileMode", m); }
  /** helper grid mode: off | pixel | iso */
  setGridMode(m: "off" | "pixel" | "iso"): void { this.setSetting("canvas.grid", m); }
  /** helper grid cell size / iso spacing (sprite px) */
  setGridSize(n: number): void { this.setSetting("canvas.gridSize", n); }
  /** pixel loupe magnification (css px per doc pixel) */
  setMagZoom(n: number): void { this.setSetting("display.magZoom", n); }
  /** show the pixel loupe while picking a colour */
  setLoupe(on: boolean): void { this.setSetting("display.loupe", on); }
  /** set where the drop-shadow lands: current layer (false) or a new shadow layer (true) */
  setShadowNewLayer(on: boolean): void { this.setSetting("display.shadowTarget", on ? "new" : "cur"); }
  /** auto-pan when dragging near the viewport edge */
  setAutoPan(on: boolean): void { this.setSetting("canvas.autoPan", on); }
  /** background autosave on/off */
  setAutosave(on: boolean): void { this.setSetting("data.autosave", on); }

  /** Drop shadow with explicit parameters (the FX dialog). Depending on
   *  `newLayer` it is baked into the current layer (silhouette kept on top) or
   *  written onto a new "shadow" layer placed just below it. */
  applyShadowParams(dx: number, dy: number, color: RGBA, newLayer: boolean): boolean {
    const doc = this.doc;
    const li = this.curLayer();
    const fi = this.curFrame();
    const cel = doc.celAt(li, fi);
    if (!cel) return false;
    let has = false;
    for (let i = 3; i < cel.data.length; i += 4) if (cel.data[i] > 0) { has = true; break; }
    if (!has) { toastFn(this.prefs.lang === "en" ? "Layer is empty" : "当前图层为空"); return false; }
    const w = doc.w, h = doc.h;
    if (!newLayer) {
      const before = new Uint8ClampedArray(cel.data);
      fxE.dropShadowCel(cel.data, w, h, dx, dy, color, true);
      let changed = false;
      for (let i = 0; i < before.length; i++) if (cel.data[i] !== before[i]) { changed = true; break; }
      if (changed) this.history.pushPixels("fx-shadow", doc, [{ li, fi, before, after: new Uint8ClampedArray(cel.data) }]);
      this.repaintAll();
      this.changed();
      return changed;
    }
    // new "shadow" layer below the current one, holding ONLY the offset copy.
    // The current layer's pixels are the silhouette source, so copy them in first.
    const shadow = new Uint8ClampedArray(cel.data);
    fxE.dropShadowCel(shadow, w, h, dx, dy, color, false);
    this.struct("fx-shadow", () => {
      const curLi = this.curLayer();
      ops.addLayer(doc, curLi, "shadow"); // shadow layer at curLi, artwork moves to curLi+1
      const sc = doc.ensureCel(curLi, fi);
      sc.data.set(shadow);
      this.layerIdx = curLi + 1; // keep the artwork layer active
    });
    return true;
  }

  /** Clear the pixels inside the current selection to transparent (keeps the selection). */
  deleteSelection(): void {
    const doc = this.doc;
    if (!doc.sel || !doc.sel.hasAny()) { toastFn(this.prefs.lang === "en" ? "No selection" : "请先建立选区"); return; }
    const li = this.curLayer(), fi = this.curFrame();
    const cel = doc.celAt(li, fi);
    if (!cel) return;
    const before = new Uint8ClampedArray(cel.data);
    for (let y = 0; y < doc.h; y++) {
      for (let x = 0; x < doc.w; x++) {
        if (doc.selAt(x, y) === 1) {
          const i = cel.idx(x, y);
          cel.data[i] = 0; cel.data[i + 1] = 0; cel.data[i + 2] = 0; cel.data[i + 3] = 0;
        }
      }
    }
    let changed = false;
    for (let i = 0; i < before.length; i++) if (before[i] !== cel.data[i]) { changed = true; break; }
    if (changed) this.history.pushPixels("sel.delete", doc, [{ li, fi, before, after: new Uint8ClampedArray(cel.data) }]);
    this.repaintAll();
    this.changed();
  }

  /** Empty the whole canvas: clear the content of the current frame on every layer. */
  clearCanvas(): void {
    const doc = this.doc;
    const fi = this.curFrame();
    const changes: Array<{ li: number; fi: number; before: Uint8ClampedArray; after: Uint8ClampedArray }> = [];
    for (let li = 0; li < doc.layers.length; li++) {
      const cel = doc.celAt(li, fi);
      if (!cel) continue;
      let has = false;
      for (let i = 3; i < cel.data.length; i += 4) if (cel.data[i] > 0) { has = true; break; }
      if (!has) continue;
      const before = new Uint8ClampedArray(cel.data);
      cel.data.fill(0);
      changes.push({ li, fi, before, after: new Uint8ClampedArray(cel.data) });
    }
    if (changes.length) this.history.pushPixels("clear-canvas", doc, changes);
    this.repaintAll();
    this.changed();
  }

  // ---------- history ----------
  undo(): void {
    this.view_?.flushStroke(); // never undo while a gesture is still open
    this.history.undo();
    this.syncAfterDocChange();
  }
  redo(): void {
    this.view_?.flushStroke();
    this.history.redo();
    this.syncAfterDocChange();
  }
  jumpHistory(index: number): void {
    this.view_?.flushStroke();
    this.history.jumpTo(index);
    this.syncAfterDocChange();
  }
  syncAfterDocChange(): void {
    this.layerIdx = this.curLayer();
    this.frameIdx = this.curFrame();
    this.view_?.setFrame(this.frameIdx);
    this.syncAll();
    this.scheduleAutosave();
  }
  struct(label: string, fn: () => void): void {
    this.history.pushStruct(label, this.doc, fn);
    this.syncAfterDocChange();
  }

  /** one-time user hint (persisted in localStorage) — used when the OS steals
   *  a gesture, so the user learns how to fix it without being nagged */
  hintOnce(key: string, zh: string, en: string): void {
    try {
      const k = "pc.hint." + key;
      if (localStorage.getItem(k) === "1") return;
      localStorage.setItem(k, "1");
    } catch { /* ignore */ }
    toastFn(this.prefs.lang === "en" ? en : zh);
  }

  /** cheap scalar command: fn applied now; undo restores via back(). */
  private cheap(label: string, fn: () => void, back: () => void, data?: ScalarData): void {
    fn();
    this.history.record(label, { apply: fn, unapply: back }, data, this.doc);
    this.syncAfterDocChange();
  }

  // ---------- operation history inside project files ----------
  /** true when saves should carry the operation history */
  get recordHistory(): boolean {
    return this.prefs.recordHistory;
  }
  /** switch the visible frame without touching the history stack */
  showFrame(fi: number): void {
    this.applyFramePublic(fi);
  }
  private applyFramePublic(fi: number): void {
    this.frameIdx = Math.max(0, Math.min(this.doc.frames.length - 1, fi));
    this.view_?.setFrame(this.frameIdx);
    this.repaintAll();
    this.changed();
  }
  /** serialize every open canvas plus the ONE shared history as .pxc */
  async serializeProject(opts?: { cels?: project.CelFormat }): Promise<string> {
    this.syncEntry();
    let hist: unknown = null;
    if (this.prefs.recordHistory && this.history.list().labels.length) {
      const idOf = (doc: Doc): string | undefined => this.docs.find((d) => d.doc === doc)?.id;
      hist = historyFile.encodeHistory(this.history.dump(idOf));
    }
    const entries: project.SpaceEntry[] = this.docs.map((e) => ({
      id: e.id, doc: e.doc, x: e.x, y: e.y, li: e.li, fi: e.fi,
      locked: e.locked === true, group: e.group ?? null,
    }));
    return project.serializeSpace(entries, this.docIdx, hist, opts?.cels ?? "png");
  }
  /** older builds stored one history payload per canvas: merge them in canvas
   *  order so a project saved that way still replays as one sequence */
  private legacyHistoryDump(parsed: project.ParsedSpace): HistoryDump | null {
    const entries: HistoryDumpEntry[] = [];
    parsed.entries.forEach((e, i) => {
      if (!e.hist) return;
      const d = historyFile.decodeHistory(e.hist);
      if (!d) return;
      const id = e.id ?? this.docs[i]?.id;
      for (const en of d.entries) entries.push({ ...en, docId: en.docId ?? id });
    });
    return entries.length ? { index: entries.length, entries } : null;
  }
  /** load a .pxc: one canvas (v2) or a whole space (v3) */
  async loadProjectText(text: string, opts?: { ask?: boolean }): Promise<boolean> {
    const parsed = await project.parseSpace(text);
    if (!parsed) return false;
    if (opts?.ask !== false && !(await this.askOverwrite("open"))) return false;
    this.docs = parsed.entries.map((e) => ({
      id: e.id || uid(), doc: e.doc, x: e.x, y: e.y, li: e.li, fi: e.fi,
      locked: e.locked === true, group: e.group ?? null,
    }));
    this.docIdx = parsed.focus;
    this.applyHistoryLimit();
    // one shared stack; steps name the canvas they edited
    this.history.clear();
    const dump = parsed.history
      ? historyFile.decodeHistory(parsed.history)
      : this.legacyHistoryDump(parsed);
    if (dump) {
      this.history.loadDump(dump, {
        doc: this.doc,
        docFor: (id) => this.docs.find((d) => d.id === id)?.doc ?? null,
        scalarActions: (d: ScalarData, doc?: Doc) => scalarActions(d, {
          doc: doc ?? this.doc,
          showFrame: (fi) => {
            const ent = doc ? this.docs.find((x) => x.doc === doc) : null;
            if (ent) ent.fi = fi;
            else this.applyFramePublic(fi);
          },
        }),
      });
    }
    const e = this.docs[this.docIdx] ?? this.docs[0];
    this.layerIdx = e ? Math.max(0, Math.min(e.doc.layers.length - 1, e.li)) : 0;
    this.frameIdx = e ? Math.max(0, Math.min(e.doc.frames.length - 1, e.fi)) : 0;
    this.clip = null;
    this.soloBackup = null;
    this.previews = [];
    this.applySymPreset(this.sym);
    this.stopPlayback();
    this.view_?.setDoc(this.doc);
    this.view_?.setFrame(this.frameIdx);
    this.view_?.fit();
    this.syncAll();
    return true;
  }

  // ---------- documents / multiple canvases ----------
  /** a free spot in the space: to the right of the focused canvas, shifting
   *  right / down until it does not overlap any open canvas */
  private placeSpot(): { x: number; y: number } {
    const e = this.ensureEntry();
    if (!e) return { x: 0, y: 0 };
    let x = e.x + e.doc.w + 24;
    let y = e.y;
    for (let guard = 0; guard < 64; guard++) {
      const clash = this.docs.some((o) =>
        o !== e && x < o.x + o.doc.w + 16 && o.x < x + e.doc.w + 16 && y < o.y + o.doc.h + 16 && o.y < y + e.doc.h + 16);
      if (!clash) break;
      x += e.doc.w + 32;
      if (x > e.x + 4096) { x = e.x; y += e.doc.h + 48; }
    }
    return { x, y };
  }
  /** open another canvas in the space (focuses it unless told otherwise) */
  addCanvas(doc: Doc, opts?: { x?: number; y?: number; focus?: boolean }): number {
    this.syncEntry();
    const spot = this.placeSpot();
    this.docs.push(this.newEntry(doc, Math.round(opts?.x ?? spot.x), Math.round(opts?.y ?? spot.y)));
    const idx = this.docs.length - 1;
    this.applyHistoryLimit();
    if (opts?.focus === false) this.changed();
    else this.focusCanvas(idx);
    return idx;
  }
  /** focus another canvas: it brings back its own layer/frame selection */
  focusCanvas(i: number): void {
    if (i < 0 || i >= this.docs.length) return;
    if (i === this.docIdx) { this.changedUI(); return; }
    this.syncEntry();
    const old = this.docs[this.docIdx];
    this.docIdx = i;
    const e = this.docs[i];
    this.layerIdx = Math.max(0, Math.min(e.doc.layers.length - 1, e.li));
    this.frameIdx = Math.max(0, Math.min(e.doc.frames.length - 1, e.fi));
    this.stopPlayback();
    // the view is anchored on the focused document: move the anchor so the
    // whole space stays where it was on screen
    if (old && old !== e) this.view_?.shiftFocus(e.x - old.x, e.y - old.y);
    this.view_?.setDoc(e.doc);
    this.view_?.setFrame(this.frameIdx);
    this.repaintAll();
    this.changed();
    this.scheduleAutosave();
  }
  renameCanvas(i: number, name: string): void {
    const e = this.docs[i];
    const v = name.trim();
    if (!e || !v) return;
    e.doc.name = v;
    this.changedUI();
    this.scheduleAutosave();
  }
  /** move a canvas inside the space (drag its title bar); canvases snapped
   *  into the same group move together */
  moveCanvas(i: number, x: number, y: number): void {
    const e = this.docs[i];
    if (!e || e.locked) return;
    const nx = Math.round(x), ny = Math.round(y);
    const dx = nx - e.x, dy = ny - e.y;
    if (!dx && !dy) return;
    const focused = this.docs[this.docIdx];
    let focusMoved = false;
    for (const o of this.docs) {
      if (o === e || (e.group && o.group === e.group)) {
        if (o === focused) focusMoved = true;
        o.x += dx;
        o.y += dy;
      }
    }
    // the camera is anchored on the focused canvas: when THAT canvas moves in
    // space the view must pan by the same amount, otherwise the canvas would
    // stay glued to the screen while the whole space slides under the finger
    if (focusMoved) this.view_?.shiftFocus(dx, dy);
    this.repaint();
    this.changed();
    this.scheduleAutosave();
  }
  /** lock / unlock a canvas position (locked canvases cannot be dragged) */
  toggleCanvasLock(i = this.docIdx): void {
    const e = this.docs[i];
    if (!e) return;
    e.locked = !e.locked;
    this.changed();
    this.scheduleAutosave();
  }
  /** live snap feedback while dragging: the full set of satisfied zones */
  setSnapZones(zones: Array<{ a: number; b: number } & GapRect>, animate = true): void {
    this.view_?.setSnapZones(zones, animate);
  }
  /** true when the canvas position is locked */
  isCanvasLocked(i = this.docIdx): boolean {
    return this.docs[i]?.locked === true;
  }
  /** proposed position for a drag: magnetically aligned with the other canvases
   *  (canvases already in the same group are ignored) */
  snapPosition(i: number, x: number, y: number, tol: number): {
    x: number;
    y: number;
    hit: number | null;
    /** every satisfied zone (all of them are highlighted while dragging) */
    zones: Array<{ a: number; b: number } & GapRect>;
  } {
    const e = this.docs[i];
    if (!e || !this.prefs.snapOn) return { x, y, hit: null, zones: [] };
    const gap = Math.max(0, Math.round(this.prefs.snapGap));
    const targets: Array<SnapTarget<number>> = [];
    for (let k = 0; k < this.docs.length; k++) {
      const o = this.docs[k];
      if (o === e || (e.group && o.group === e.group)) continue;
      targets.push({ id: k, x: o.x, y: o.y, w: o.doc.w, h: o.doc.h });
    }
    const moving = { x, y, w: e.doc.w, h: e.doc.h };
    const r = snapToTargets(moving, targets, tol, gap);
    // every target that would snap, with the gap it would leave: all of those
    // zones are shown at once, not only the one the position ends up using
    const zones: Array<{ a: number; b: number } & GapRect> = [];
    for (const c of snapCandidates(moving, targets, tol, gap)) {
      const o = this.docs[c.id];
      if (!o) continue;
      const g = snapGapRect({ x: c.x, y: c.y, w: e.doc.w, h: e.doc.h }, { x: o.x, y: o.y, w: o.doc.w, h: o.doc.h }, gap);
      if (g) zones.push({ a: i, b: c.id, ...g });
    }
    return { x: r.x, y: r.y, hit: r.hit, zones };
  }
  /** true when two canvases are neighbours with exactly the snap gap between */
  private canvasesTouch(a: CanvasEntry, b: CanvasEntry): boolean {
    const gap = Math.max(0, Math.round(this.prefs.snapGap));
    const ax1 = a.x + a.doc.w, ay1 = a.y + a.doc.h;
    const bx1 = b.x + b.doc.w, by1 = b.y + b.doc.h;
    const gapV = stackGap(gap);   // stacked neighbours keep room for the title bar
    const sideBySide = (ax1 + gap === b.x || bx1 + gap === a.x) && a.y < by1 && b.y < ay1;
    const stacked = (ay1 + gapV === b.y || by1 + gapV === a.y) && a.x < bx1 && b.x < ax1;
    return sideBySide || stacked;
  }
  /** a drag ended on canvas `hit`: snap them together when they really touch */
  finishCanvasDrag(i: number, hit: number | null): void {
    if (hit === null || hit === i) return;
    const a = this.docs[i], b = this.docs[hit];
    if (!a || !b) return;
    if (a.group && b.group && a.group === b.group) return;
    if (!this.canvasesTouch(a, b)) return;
    this.linkCanvas(i, hit);
    this.hapticTick("吸附", 0.8);
    toastFn(this.prefs.lang === "en"
      ? "Snapped to " + (b.doc.name || "canvas") + " — they now move together"
      : "已吸附到「" + (b.doc.name || "画布") + "」——拖动会一起移动");
  }
  /** put two canvases into one group (merged with any existing groups) */
  linkCanvas(a: number, b: number): void {
    const A = this.docs[a], B = this.docs[b];
    if (!A || !B || A === B) return;
    const merged = B.group && A.group && A.group !== B.group ? B.group : null;
    const g = A.group ?? B.group ?? uid();
    A.group = g;
    B.group = g;
    if (merged) for (const o of this.docs) if (o.group === merged) o.group = g;
    this.changed();
    this.scheduleAutosave();
  }
  /** release one canvas from its group (the rest stay snapped together) */
  unlinkCanvas(i: number): void {
    const e = this.docs[i];
    if (!e?.group) return;
    const g = e.group;
    // the neighbours that lose their link: shown as a red dissolving connection
    const pairs: Array<[number, number]> = [];
    for (let k = 0; k < this.docs.length; k++) {
      const o = this.docs[k];
      if (o === e || o.group !== g) continue;
      if (this.canvasesTouch(e, o)) pairs.push([i, k]);
    }
    e.group = null;
    const rest = this.docs.filter((o) => o.group === g);
    if (rest.length === 1) rest[0].group = null; // a group of one is no group
    if (pairs.length) {
      this.view_?.pulseUnsnap(pairs);
      this.hapticTick("解除吸附", 0.7);
    }
    this.changed();
    this.scheduleAutosave();
    toastFn(this.prefs.lang === "en" ? "Un-snapped" : "已解除吸附");
  }
  /** rotate THIS canvas' pixels 90° clockwise (width/height swap, undoable) */
  rotateCanvasContent(dir: 1 | -1 = 1): void {
    const d = this.doc;
    if (!d.layers.length) return;
    this.struct("canvas-rotate", () => ops.rotateDocContent(this.doc, dir));
    // the symmetry axis is measured from the canvas centre: recentre it
    this.applySymPreset(this.sym);
    this.view_?.fit();
    this.changedUI(); // struct() already synced + repainted
    toastFn(this.prefs.lang === "en"
      ? "Canvas rotated 90°"
      : "画布已旋转 90°");
  }
  /** rotate the VIEW 90° clockwise (the artwork itself is unchanged) */
  rotateView(step = 90): void {
    const v = this.view_;
    if (!v) return;
    v.setRotation(v.rot + step);
    toastFn(this.prefs.lang === "en" ? "View rotated " + v.rot + "\u00b0" : "视图已旋转 " + v.rot + "\u00b0");
    this.changed();
  }
  /** current view rotation in degrees (0/90/180/270) */
  get viewRotation(): number {
    return this.view_?.rot ?? 0;
  }
  /** smoothly zoom the view to fit the focused canvas */
  fitCanvas(): void {
    this.view_?.fitAnimated();
    this.changed();
  }
  /** re-anchor the view on docs[i] (or on the empty stub when the space is
   *  empty) and bring that canvas' own layer/frame selection back; `from` is
   *  the space position the view was anchored on, so the rest of the space does
   *  not jump on screen */
  private anchorFocus(i: number, from: { x: number; y: number } | null): void {
    if (!this.docs.length) {
      this.docIdx = 0;
      this.layerIdx = 0;
      this.frameIdx = 0;
      this.view_?.setDoc(this.doc);
      return;
    }
    this.docIdx = Math.max(0, Math.min(this.docs.length - 1, i));
    const e = this.docs[this.docIdx];
    this.layerIdx = Math.max(0, Math.min(e.doc.layers.length - 1, e.li));
    this.frameIdx = Math.max(0, Math.min(e.doc.frames.length - 1, e.fi));
    if (from && (from.x !== e.x || from.y !== e.y)) this.view_?.shiftFocus(e.x - from.x, e.y - from.y);
    this.view_?.setDoc(e.doc);
    this.view_?.setFrame(this.frameIdx);
  }
  /** close a canvas: the project is the only file, so nothing is written here.
   *  The close is an ordinary history step, so a closed canvas can be brought
   *  back with undo (and walks through the replay) until the project itself is
   *  closed — opening another project or starting a new one clears the stack. */
  closeCanvas(i: number): boolean {
    const e = this.docs[i];
    if (!e) return false;
    this.syncEntry(); // the entry keeps its layer/frame selection
    const at = i;
    const gone = this.previews.filter((p) => p.canvas === at);
    // did the close take the focus away? then undo gives it back
    let tookFocus = false;
    const drop = (): void => {
      const k = this.docs.indexOf(e);
      if (k < 0) return;
      const focused = this.docs[this.docIdx] === e;
      this.previews = this.previews
        .filter((p) => p.canvas !== k)
        .map((p) => (p.canvas > k ? { ...p, canvas: p.canvas - 1 } : p));
      this.docs.splice(k, 1);
      if (focused) {
        tookFocus = true;
        this.anchorFocus(Math.min(k, this.docs.length - 1), { x: e.x, y: e.y });
        this.view_?.fit();
      } else if (k < this.docIdx) {
        this.docIdx--;
      }
      this.repaintAll();
      this.changed();
      this.scheduleAutosave();
    };
    const restore = (): void => {
      if (this.docs.includes(e)) return;
      const k = Math.max(0, Math.min(this.docs.length, at));
      this.docs.splice(k, 0, e);
      e.doc.pixelRev++; // its render cache is stale by now
      this.previews = this.previews.map((p) => (p.canvas >= k ? { ...p, canvas: p.canvas + 1 } : p));
      for (const p of gone) if (!this.previews.some((q) => q.id === p.id)) this.previews.push({ ...p, canvas: k });
      if (tookFocus) {
        this.anchorFocus(k, null);
        this.view_?.fit();
      } else if (k <= this.docIdx) {
        this.docIdx++;
      }
      this.repaintAll();
      this.changed();
      this.scheduleAutosave();
    };
    this.history.record("canvas-close", { apply: drop, unapply: restore }, undefined, e.doc);
    drop();
    return true;
  }

  // ---------- floating preview windows ----------
  /** open (or focus) the preview window of one canvas; returns its id */
  addPreview(canvas = this.docIdx): string {
    const found = this.previews.find((p) => p.canvas === canvas);
    if (found) { this.changedUI(); return found.id; }
    let size = 148;
    try { const n = parseInt(localStorage.getItem("pc.prev.size") || "148", 10); if (n >= 90 && n <= 380) size = n; } catch { /* ignore */ }
    const id = uid();
    this.previews.push({ id, canvas, x: null, y: null, size });
    this.changedUI();
    return id;
  }
  /** the eye on a canvas title: open this canvas' preview, or close it again */
  togglePreview(canvas = this.docIdx): boolean {
    const open = this.previews.find((p) => p.canvas === canvas);
    if (open) { this.closePreview(open.id); return false; }
    this.addPreview(canvas);
    return true;
  }
  /** true when a preview window is open for this canvas */
  hasPreview(canvas = this.docIdx): boolean {
    return this.previews.some((p) => p.canvas === canvas);
  }
  closePreview(id: string): void {
    const n = this.previews.length;
    this.previews = this.previews.filter((p) => p.id !== id);
    if (this.previews.length !== n) this.changedUI();
  }
  movePreview(id: string, x: number, y: number): void {
    const p = this.previews.find((q) => q.id === id);
    if (!p) return;
    p.x = Math.round(x);
    p.y = Math.round(y);
    this.changedUI();
  }
  resizePreview(id: string, size: number): void {
    const p = this.previews.find((q) => q.id === id);
    if (!p) return;
    p.size = Math.max(90, Math.min(380, Math.round(size)));
    try { localStorage.setItem("pc.prev.size", String(p.size)); } catch { /* ignore */ }
    this.changedUI();
  }

  /** start a brand-new PROJECT: every open canvas and the whole history are
   *  replaced by one fresh canvas (with the unsaved-work prompt first) */
  async newProject(w: number, h: number, name: string, bg: RGBA | null): Promise<boolean> {
    if (!(await this.askOverwrite("new"))) return false;
    const doc = new Doc(w, h, name);
    doc.palette = this.prefs.palette.length ? this.prefs.palette.map((hex) => hexToRgba(hex)) : defaultPalette();
    doc.bg = bg;
    const ok = await this.replaceDoc(doc, { ask: false });
    if (ok) this.scheduleAutosave();
    return ok;
  }
  /** create a brand new canvas (the previous ones stay open) */
  async newDoc(w: number, h: number, name: string, bg: RGBA | null): Promise<boolean> {
    const doc = new Doc(w, h, name);
    doc.palette = this.prefs.palette.length ? this.prefs.palette.map((hex) => hexToRgba(hex)) : defaultPalette();
    doc.bg = bg;
    this.addCanvas(doc);
    return true;
  }
  /** replace the whole space with one document (open / import / autosave) */
  async replaceDoc(doc: Doc, opts?: { add?: boolean; ask?: boolean }): Promise<boolean> {
    if (opts?.add) { this.addCanvas(doc); return true; }
    if (opts?.ask !== false && !(await this.askOverwrite("open"))) return false;
    this.docs = [this.newEntry(doc, 0, 0)];
    this.docIdx = 0;
    this.applyHistoryLimit();
    this.layerIdx = 0;
    this.frameIdx = 0;
    this.history.clear();
    this.clip = null;
    this.soloBackup = null;
    this.applySymPreset(this.sym);
    this.stopPlayback();
    this.view_?.setDoc(doc);
    this.view_?.setFrame(0);
    this.view_?.fit();
    this.syncAll();
    return true;
  }

  // ---------- layers ----------
  layerAdd(): void {
    this.struct("layer-add", () => ops.addLayer(this.doc, this.curLayer() + 1));
  }
  layerDuplicate(): void {
    this.struct("layer-dupe", () => ops.duplicateLayer(this.doc, this.curLayer()));
  }
  layerDelete(): void {
    if (this.doc.layers.length <= 1) return;
    const li = this.curLayer();
    this.struct("layer-del", () => ops.removeLayer(this.doc, li));
  }
  layerUp(): void {
    const li = this.curLayer();
    if (li <= 0) return;
    this.struct("layer-up", () => ops.moveLayer(this.doc, li, li - 1));
  }
  layerDown(): void {
    const li = this.curLayer();
    if (li >= this.doc.layers.length - 1) return;
    this.struct("layer-down", () => ops.moveLayer(this.doc, li, li + 1));
  }
  /** drag reorder: move layer `from` so it ends up at index `to` (0-based) */
  layerMoveTo(from: number, to: number): void {
    const n = this.doc.layers.length;
    if (from < 0 || from >= n) return;
    const t = Math.max(0, Math.min(n - 1, Math.round(to)));
    if (t === from) return;
    const wasCur = this.curLayer() === from;
    this.struct("layer-move", () => ops.moveLayer(this.doc, from, t));
    if (wasCur) this.layerIdx = t;
    this.changed();
  }
  layerMergeDown(): void {
    const li = this.curLayer();
    if (li <= 0) return;
    if (this.isRefLayer(li) || this.isRefLayer(li - 1)) {
      toastFn(this.prefs.lang === "en" ? "Release the reference first" : "请先解除引用再合并");
      return;
    }
    this.struct("layer-merge", () =>
      ops.mergeLayerDown(this.doc, li, (dst, src, o, b) => compositor.compositeOntoCel(dst, src, o, b))
    );
  }
  toggleLayerVisible(li: number): void {
    const L = this.doc.layers[li];
    if (!L) return;
    this.soloBackup = null; // a manual eye tap leaves solo mode
    const old = L.visible;
    this.cheap("layer-visible",
      () => { const N = this.doc.layers[li]; if (N) N.visible = !old; },
      () => { const N = this.doc.layers[li]; if (N) N.visible = old; },
      { k: "layer-visible", li, on: !old, prev: old });
  }
  /** Long-press a layer's eye: hide every OTHER layer; long-press again to
   *  bring back exactly the visibility each layer had before. */
  toggleSoloLayers(li: number): void {
    const doc = this.doc;
    if (!doc.layers[li]) return;
    const bak = this.soloBackup;
    const on = !(bak && bak.length === doc.layers.length);
    const before = bak && bak.length === doc.layers.length ? bak : doc.layers.map((l) => l.visible);
    this.soloBackup = on ? before.slice() : null;
    this.cheap("layer-solo",
      () => { doc.layers.forEach((l, i) => { l.visible = on ? i === li : (before[i] ?? true); }); },
      () => {
        doc.layers.forEach((l, i) => { l.visible = on ? (before[i] ?? true) : i === li; });
        this.soloBackup = on ? null : before.slice();
      },
      { k: "layer-solo", li, on, before: before.slice() });
    toastFn(on
      ? (this.prefs.lang === "en" ? "Hid the other layers (long-press the eye to restore)" : "已隐藏其他图层（再长按眼睛恢复）")
      : (this.prefs.lang === "en" ? "Layer visibility restored" : "已恢复其他图层的显示"));
  }
  toggleLayerLock(li: number): void {
    const L = this.doc.layers[li];
    if (!L) return;
    const old = L.locked;
    this.cheap("layer-lock",
      () => { const N = this.doc.layers[li]; if (N) N.locked = !old; },
      () => { const N = this.doc.layers[li]; if (N) N.locked = old; },
      { k: "layer-lock", li, on: !old, prev: old });
  }
  renameLayer(li: number, name: string): void {
    if (!name.trim()) return;
    const L = this.doc.layers[li];
    if (!L) return;
    const old = L.name;
    const next = name.trim();
    this.cheap("layer-rename",
      () => { const N = this.doc.layers[li]; if (N) N.name = next; },
      () => { const N = this.doc.layers[li]; if (N) N.name = old; },
      { k: "layer-rename", li, name: next, prev: old });
  }
  setLayerOpacity(li: number, o: number): void {
    const L = this.doc.layers[li];
    if (!L) return;
    const v = Math.max(0, Math.min(100, Math.round(o)));
    const old = L.opacity;
    this.cheap("layer-opacity",
      () => { const N = this.doc.layers[li]; if (N) N.opacity = v; },
      () => { const N = this.doc.layers[li]; if (N) N.opacity = old; },
      { k: "layer-opacity", li, v, prev: old });
  }
  /** live slider edits: mutate + repaint, but coalesce into ONE history step */
  editLayerOpacity(li: number, o: number): void {
    const L = this.doc.layers[li];
    if (!L) return;
    const v = Math.max(0, Math.min(100, Math.round(o)));
    if (!this.opacityLive) this.opacityLive = { li, from: L.opacity, to: L.opacity };
    L.opacity = v;
    if (this.opacityLive && this.opacityLive.li === li) this.opacityLive.to = v;
    this.repaint();
  }
  endLayerOpacity(): void {
    const live = this.opacityLive;
    this.opacityLive = null;
    if (!live) return;
    if (live.from === live.to) return;
    this.history.record("layer-opacity", {
      apply: () => { const L = this.doc.layers[live.li]; if (L) L.opacity = live.to; },
      unapply: () => { const L = this.doc.layers[live.li]; if (L) L.opacity = live.from; },
    }, { k: "layer-opacity", li: live.li, v: live.to, prev: live.from }, this.doc);
    this.changed();
  }
  setLayerBlend(li: number, b: BlendMode): void {
    const L = this.doc.layers[li];
    if (!L) return;
    const old = L.blend;
    this.cheap("layer-blend",
      () => { const N = this.doc.layers[li]; if (N) N.blend = b; },
      () => { const N = this.doc.layers[li]; if (N) N.blend = old; },
      { k: "layer-blend", li, b, prev: old });
  }

  // ---------- frames ----------
  frameAdd(): void {
    const src = this.curFrame();
    const copy = this.prefs.newFrameCopy;
    this.struct("frame-add", () => {
      ops.addFrame(this.doc, src + 1);
      if (copy) {
        for (let li = 0; li < this.doc.layers.length; li++) {
          const cel = this.doc.celAt(li, src);
          if (cel) this.doc.cels.set(this.doc.key(li, src + 1), cel.clone());
        }
      }
    });
  }
  frameDuplicate(): void {
    this.struct("frame-dupe", () => ops.duplicateFrame(this.doc, this.curFrame()));
  }
  frameDelete(): void {
    if (this.doc.frames.length <= 1) return;
    const fi = this.curFrame();
    this.struct("frame-del", () => ops.removeFrame(this.doc, fi));
  }

  // ---------- multi-frame selection (timeline batch edits) ----------
  /** frames picked in the timeline; every batch button acts on all of them */
  frameSel = new Set<number>();
  /** true while the timeline shows the pick-frames toolbar */
  frameSelOn = false;

  setFrameSelMode(on: boolean): void {
    this.frameSelOn = on;
    if (!on) this.frameSel.clear();
    this.changed();
  }
  toggleFrameSel(fi: number): void {
    if (fi < 0 || fi >= this.doc.frames.length) return;
    if (this.frameSel.has(fi)) this.frameSel.delete(fi);
    else this.frameSel.add(fi);
    this.changed();
  }
  clearFrameSel(): void {
    if (!this.frameSel.size) return;
    this.frameSel.clear();
    this.changed();
  }
  /** selected frame indices, ascending and pruned against the current doc */
  frameSelList(): number[] {
    const n = this.doc.frames.length;
    return [...this.frameSel].filter((fi) => fi >= 0 && fi < n).sort((a, b) => a - b);
  }
  /** select every frame (a second call clears the selection) */
  framesSelectAll(): void {
    const n = this.doc.frames.length;
    if (this.frameSel.size >= n) this.frameSel.clear();
    else for (let fi = 0; fi < n; fi++) this.frameSel.add(fi);
    this.changed();
  }
  /** delete every selected frame; at least one frame always survives */
  framesDeleteSelected(): number {
    const list = this.frameSelList();
    if (!list.length || list.length >= this.doc.frames.length) return 0;
    const cur = this.curFrame();
    this.struct("frames-del", () => {
      // back to front so the remaining indices stay valid
      for (let i = list.length - 1; i >= 0; i--) ops.removeFrame(this.doc, list[i]);
    });
    const removedBefore = list.filter((fi) => fi < cur).length;
    this.frameIdx = Math.max(0, Math.min(this.doc.frames.length - 1, cur - removedBefore));
    this.view_?.setFrame(this.frameIdx);
    this.frameSel.clear();
    this.repaintAll();
    this.changed();
    return list.length;
  }
  /** duplicate every selected frame directly after its source */
  framesDuplicateSelected(): number {
    const list = this.frameSelList();
    if (!list.length) return 0;
    this.struct("frames-dupe", () => {
      for (let i = list.length - 1; i >= 0; i--) ops.duplicateFrame(this.doc, list[i]);
    });
    this.frameSel.clear();
    this.repaintAll();
    this.changed();
    return list.length;
  }
  /** apply one duration to every selected frame */
  framesSetDuration(ms: number): number {
    const list = this.frameSelList();
    if (!list.length) return 0;
    const v = Math.max(1, Math.min(60000, Math.round(ms)));
    const olds = list.map((fi) => this.doc.frames[fi]?.durationMs ?? 100);
    this.cheap("frames-duration",
      () => { for (const fi of list) { const f = this.doc.frames[fi]; if (f) f.durationMs = v; } },
      () => { list.forEach((fi, k) => { const f = this.doc.frames[fi]; if (f) f.durationMs = olds[k]; }); },
      { k: "frames-duration", list, v, olds });
    return list.length;
  }
  frameMove(dir: -1 | 1): void {
    const fi = this.curFrame();
    const to = fi + dir;
    if (to < 0 || to >= this.doc.frames.length) return;
    this.struct("frame-move", () => ops.moveFrame(this.doc, fi, to));
  }

  /** drag reorder: move frame `from` so it ends up at index `to` (0-based) */
  frameMoveTo(from: number, to: number): void {
    const n = this.doc.frames.length;
    if (from < 0 || from >= n) return;
    const t = Math.max(0, Math.min(n - 1, Math.round(to)));
    if (t === from) return;
    const wasCur = this.curFrame() === from;
    this.struct("frame-move", () => ops.moveFrame(this.doc, from, t));
    if (wasCur) this.frameIdx = t;
    this.view_?.setFrame(this.frameIdx);
    this.repaintAll();
    this.changed();
  }
  setNewFrameCopy(v: boolean): void { this.setSetting("general.newFrameCopy", v); }
  setRailSwap(v: boolean): void { this.setSetting("general.swapRails", v); }
  /** live timeline height (drag handle): clamped, debounced to disk */
  setTlHeight(v: number): void {
    const n = Math.max(140, Math.min(520, Math.round(v)));
    if (n === this.prefs.tlH) return;
    this.prefs.tlH = n;
    this.scheduleSavePrefs();
    this.changed();
  }
  setFrameDuration(fi: number, ms: number): void {
    const f = this.doc.frames[fi];
    if (!f) return;
    const v = Math.max(1, Math.min(60000, Math.round(ms)));
    const old = f.durationMs;
    this.cheap("frame-duration",
      () => { const N = this.doc.frames[fi]; if (N) N.durationMs = v; },
      () => { const N = this.doc.frames[fi]; if (N) N.durationMs = old; },
      { k: "frame-duration", fi, ms: v, prev: old });
  }
  // ---------- image size (Aseprite-style) ----------
  /** ax/ay in {-1,0,1}: -1 = top/left, 0 = center, 1 = bottom/right */
  canvasSize(w: number, h: number, ax: -1 | 0 | 1, ay: -1 | 0 | 1): void {
    const nw = Math.max(1, Math.min(1024, Math.round(w)));
    const nh = Math.max(1, Math.min(1024, Math.round(h)));
    const ox = ax === -1 ? 0 : ax === 0 ? Math.round((nw - this.doc.w) / 2) : nw - this.doc.w;
    const oy = ay === -1 ? 0 : ay === 0 ? Math.round((nh - this.doc.h) / 2) : nh - this.doc.h;
    this.struct("canvas-size", () => ops.resizeDocCanvas(this.doc, nw, nh, ox, oy));
  }
  spriteSize(w: number, h: number): void {
    const nw = Math.max(1, Math.min(1024, Math.round(w)));
    const nh = Math.max(1, Math.min(1024, Math.round(h)));
    this.struct("sprite-size", () => ops.scaleDocSprite(this.doc, nw, nh));
  }

  /** smart crop: shrink the canvas to the union of all drawn content */
  cropSmart(): void {
    const b = ops.contentBounds(this.doc);
    if (!b) { toastFn(this.prefs.lang === "en" ? "Nothing to crop" : "无可裁剪内容"); return; }
    if (b.w === this.doc.w && b.h === this.doc.h) return;
    this.struct("auto-crop", () => {
      const bb = ops.contentBounds(this.doc);
      if (bb) ops.resizeDocCanvas(this.doc, bb.w, bb.h, -bb.x, -bb.y);
    });
  }
  

  // ---------- playback ----------
  togglePlay(): void {
    if (this.playing) this.stopPlayback();
    else this.startPlayback();
  }
  startPlayback(): void {
    if (this.playing) return;
    const n = this.doc.frames.length;
    this.playDir = startPlayDir(this.loopMode);
    const start = startPlayFrame(this.loopMode, this.curFrame(), n);
    if (start !== this.curFrame()) this.applyFrame(start); // rewind: no history step
    this.playing = true;
    this.changed();
    this.tickPlay();
  }
  stopPlayback(): void {
    this.playing = false;
    if (this.playTimer !== null) {
      window.clearTimeout(this.playTimer);
      this.playTimer = null;
    }
    this.changed();
  }
  private tickPlay(): void {
    if (!this.playing) return;
    const n = this.doc.frames.length;
    if (n <= 1) {
      this.stopPlayback();
      return;
    }
    const fi = this.curFrame();
    const dur = Math.max(16, this.doc.frames[fi].durationMs);
    this.playTimer = window.setTimeout(() => {
      if (!this.playing) return;
      const step = nextPlayFrame(this.loopMode, this.curFrame(), n, this.playDir);
      if (step.stop) {
        this.stopPlayback();
        return;
      }
      this.playDir = step.dir;
      this.applyFrame(step.fi); // playback never pollutes the undo history
      this.tickPlay();
    }, dur);
  }

  /** cycle playback mode: once -> loop -> ping-pong -> reverse -> once */
  cycleLoopMode(): LoopMode {
    this.loopMode = nextLoopMode(this.loopMode);
    this.prefs.loopMode = this.loopMode;
    this.savePrefs();
    this.changed();
    return this.loopMode;
  }

  /** composite-sample used by the eyedropper */
  sampleComposite(x: number, y: number): RGBA | null {
    // fast path: when no background and no onion ghosts the live composite is
    // already identical to a fresh no-bg compose, so just read one pixel
    const v = this.view_;
    if (v && this.doc.bg === null && !this.prefs.onionOn) {
      const p = v.samplePixel(x, y);
      if (p) return p;
    }
    try {
      const c = compositor.composeFrame(this.doc, this.curFrame(), { bgOverride: null });
      const d = c.getContext("2d")!.getImageData(x, y, 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    } catch {
      return null;
    }
  }
}
