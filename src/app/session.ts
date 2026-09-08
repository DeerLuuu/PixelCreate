import { Doc } from "../engine/doc";
import { History } from "../engine/history";
import type { Rect, RGBA, BlendMode } from "../engine/types";
import { defaultPalette } from "../data/palettes";
import * as ops from "../engine/ops";
import * as fxE from "../engine/effects";
import * as compositor from "../render/compositor";
import * as project from "../io/project";
import * as autosave from "../io/autosave";
import { toast as toastFn } from "../io/bridge";
import type { ToolId, BrushState, SymMode } from "../tools/registry";
import { isShapeTool, nextSym, SYM_ANGLES } from "../tools/registry";
import type { View } from "../render/view";
import { rgbaToHex } from "../engine/color";
import * as selM from "../tools/select";
import { adjustPixel, type HslAdj } from "../engine/adjust";
import { type LoopMode, nextLoopMode, nextPlayFrame, startPlayDir, startPlayFrame } from "./playback";
import { SETTINGS_BY_PATH, normalizeSetting, type SettingValue } from "./settings";

export interface Prefs {
  lang: "zh" | "en";
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
  /** add frame via FrameAdd: clone current frame's cels into the new one */
  newFrameCopy: boolean;
  /** landscape: swap side rails (default on: control rail right, actions left) */
  railSwap: boolean;
  previewBg: "white" | "black" | "checker";
  /** timeline matrix max height in px (landscape friendly) */
  tlH: number;
  
  /** history recording: "steps" keeps the latest histSteps entries, "full" records everything */
  histMode: "steps" | "full";
  histSteps: number;
  /** drop shadow target: false = on the current layer, true = new "shadow" layer */
  shadowNewLayer: boolean;
  /** auto-pan the canvas when a brush/selection drag reaches the viewport edge */
  autoPan: boolean;
  /** paint bucket: fill every matching pixel in the layer (true) or only the
   *  connected region (false) */
  bucketGlobal: boolean;
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
}

export class Session {
  doc: Doc;
  history = new History();
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
  private lastColorAt = 0;
  playing = false;
  loopMode: LoopMode = "loop";
  private playDir: 1 | -1 = 1;
  /** most recently used colours, newest first (palette panel "recent" mode) */
  recentColors: RGBA[] = [];
  private recentSaveTimer: number | null = null;
  private docColorCache: { rev: number; colors: RGBA[] } | null = null;
  private playTimer: number | null = null;
  private autosaveTimer: number | null = null;
  private replayActive = false;
  private opacityLive: { li: number; from: number; to: number } | null = null;
  private view_: View | null = null;
  private listeners = new Set<() => void>();
  private previewCbs = new Set<() => void>();
  private rev = 0;
  private snapCache: Snapshot | null = null;
  private snapRev = -1;

  constructor() {
    this.prefs = this.loadPrefs();
    this.doc = new Doc(64, 64, "untitled");
    this.doc.palette = defaultPalette();
    this.color = this.fg;
    this.loopMode = this.prefs.loopMode;
    this.recentColors = this.loadRecentColors();
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


  attachView(v: View): void {
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
  getVersion(): number {
    return this.rev;
  }
  changed(): void {
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
      selActive: this.doc.selectionActive(),
      docName: this.doc.name,
      w: this.doc.w,
      h: this.doc.h,
      playing: this.playing,
      loopMode: this.loopMode,
      frameSel: this.frameSelList(),
      frameSelOn: this.frameSelOn,
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
    return this.doc.layers[this.curLayer()]?.locked ?? false;
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
    this.changed();
  }

  // ---------- canvas ----------
  repaint(): void {
    this.view_?.invalidate();
    this.firePreviews();
    this.scheduleAutosave();
  }
  /** Live-stroke repaint: only `rect` (doc space) changed, so the compositor
   *  and the canvas update just that region. null = full frame. */
  repaintRect(rect: Rect | null): void {
    this.view_?.invalidate(rect);
    this.firePreviews();
    this.scheduleAutosave();
  }
  repaintAll(): void {
    this.view_?.markDirty();
    this.view_?.refresh(true);
    this.firePreviews();
  }
  private lastSaveNote = 0;
  /** mark replay mode: skip autosave while the history replay viewer steps */
  setReplayMode(on: boolean): void { this.replayActive = on; }
  scheduleAutosave(): void {
    if (!this.prefs.autosave || this.replayActive) return;
    if (this.autosaveTimer !== null) window.clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => {
      this.autosaveTimer = null;
      void this.writeAutosave();
    }, 1200);
  }
  async writeAutosave(): Promise<void> {
    try {
      const txt = await project.serialize(this.doc);
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
    await this.writeAutosave();
  }
  async restoreAutosave(): Promise<Doc | null> {
    try {
      const rec = await autosave.loadAutosave();
      if (!rec) return null;
      return await project.parse(rec.text);
    } catch { return null; }
  }
  /** metadata of the newest autosave (settings screen) */
  autosaveInfo(): Promise<autosave.AutosaveMeta | null> {
    return autosave.autosaveMeta();
  }
  async clearAutosave(): Promise<void> {
    await autosave.clearAutosave();
  }
  syncAll(): void {
    this.view_?.refresh(true);
    this.changed();
    this.firePreviews();
  }

  private loadPrefs(): Prefs {
    const p: Prefs = {
      lang: "zh", gridMode: "off", gridSize: 1, magZoom: 12, loupe: true,
      onionOn: false, onionBefore: 1, onionAfter: 0, onionAlpha: 55, onionTint: true, onionWrap: true,
      autosave: true, newFrameCopy: false, railSwap: true, previewBg: "white", tlH: 116,
      histMode: "steps", histSteps: 120, shadowNewLayer: false, autoPan: true,
      bucketGlobal: false, loopMode: "loop", recentColorsMax: 16, selectionTolerance: 8,
    };
    try {
      const saved = JSON.parse(localStorage.getItem("pc.prefs") ?? "{}");
      if (saved.lang === "en") p.lang = "en";
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
      if (typeof saved.autosave === "boolean") p.autosave = saved.autosave;
      if (typeof saved.newFrameCopy === "boolean") p.newFrameCopy = saved.newFrameCopy;
      if (typeof saved.railSwap === "boolean") p.railSwap = saved.railSwap;
      if (typeof saved.tlH === "number") p.tlH = Math.max(56, Math.min(340, Math.round(saved.tlH)));
      if (saved.histMode === "full" || saved.histMode === "steps") p.histMode = saved.histMode;
      if (typeof saved.histSteps === "number") p.histSteps = Math.max(10, Math.min(500, Math.round(saved.histSteps)));
      if (typeof saved.shadowNewLayer === "boolean") p.shadowNewLayer = saved.shadowNewLayer;
      if (typeof saved.autoPan === "boolean") p.autoPan = saved.autoPan;
      if (typeof saved.bucketGlobal === "boolean") p.bucketGlobal = saved.bucketGlobal;
      if (saved.loopMode === "once" || saved.loopMode === "loop" || saved.loopMode === "pingpong" || saved.loopMode === "reverse") p.loopMode = saved.loopMode;
      if (typeof saved.recentColorsMax === "number") p.recentColorsMax = Math.max(4, Math.min(64, Math.round(saved.recentColorsMax)));
      if (typeof saved.selectionTolerance === "number") p.selectionTolerance = Math.max(0, Math.min(64, Math.round(saved.selectionTolerance)));
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
  /** edit the ACTIVE slot (this mutates the array `color` aliases) */
  setColor(c: RGBA): void {
    const arr = this.color;
    arr[0] = c[0]; arr[1] = c[1]; arr[2] = c[2]; arr[3] = c[3];
    this.lastColorAt = Date.now();
    this.pushRecentColor(arr);
    this.changed();
  }
  /** pickers set the fg slot and make it active (paint follows) */
  setFgColor(c: RGBA): void {
    const f = this.fg;
    f[0] = c[0]; f[1] = c[1]; f[2] = c[2]; f[3] = c[3];
    this.colorTarget = "fg";
    this.color = this.fg;
    this.lastColorAt = Date.now();
    this.pushRecentColor(f);
    this.changed();
  }
  setColorTarget(t: "fg" | "bg"): void {
    this.colorTarget = t;
    this.color = t === "bg" ? this.bg : this.fg;
    this.lastColorAt = Date.now();
    this.changed();
  }
  swapColors(): void {
    const tmp: RGBA = [this.fg[0], this.fg[1], this.fg[2], this.fg[3]];
    const f = this.fg, b = this.bg;
    f[0] = b[0]; f[1] = b[1]; f[2] = b[2]; f[3] = b[3];
    b[0] = tmp[0]; b[1] = tmp[1]; b[2] = tmp[2]; b[3] = tmp[3];
    // `color` already aliases the active slot array; contents were swapped
    this.lastColorAt = Date.now();
    this.pushRecentColor(this.color);
    this.changed();
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
    this.changed();
  }
  colorPickedRecently(now: number, windowMs: number): boolean {
    return this.colorPicking || now - this.lastColorAt <= windowMs;
  }
  setTool(t: ToolId): void {
    this.tool = t;
    this.changed();
  }
  cycleSym(): SymMode {
    const prev = this.sym;
    this.sym = nextSym(prev);
    // enabling applies the default (centred) axis unless already customised
    if (this.sym !== "off" && !this.symTweaked) this.applySymPreset(this.sym);
    this.changed();
    this.repaint(); // show/hide the adjustable symmetry guides
    return this.sym;
  }
  /** toggle four-way symmetry (adds the perpendicular axis through the pivot) */
  setSymFour(on: boolean): void {
    if (this.symFour === on) return;
    this.symFour = on;
    this.repaint();
    this.changed();
  }
  /** lock / unlock the axis (locked = not movable, intersection hidden) */
  setSymLocked(on: boolean): void {
    if (this.symLocked === on) return;
    this.symLocked = on;
    this.repaint();
    this.changed();
  }
  /** step the mirror angle through 0/45/90/135 */
  cycleSymAngle(): number {
    const cur = ((this.symAng % 180) + 180) % 180;
    let idx = SYM_ANGLES.findIndex((a) => a === cur);
    if (idx < 0) idx = 0;
    this.symAng = SYM_ANGLES[(idx + 1) % SYM_ANGLES.length];
    this.symTweaked = true;
    this.repaint();
    this.changed();
    return this.symAng;
  }
  /** mode-preset axis geometry: centred pivot at the default (vertical) angle */
  applySymPreset(m: SymMode): void {
    void m;
    this.symOx = 0;
    this.symOy = 0;
    this.symAng = 90;
    this.symTweaked = false;
  }
  /** recentre the axis and restore the default angle */
  resetSymAxes(): void {
    this.applySymPreset(this.sym);
    this.repaint();
    this.changed();
  }
  setShapeSides(n: number): void {
    this.shapeSides = Math.max(3, Math.min(32, Math.round(n)));
    this.changed();
  }
  setShapeFill(f: boolean): void {
    this.shapeFill = f;
    this.changed();
  }
  setPalette(colors: Array<[number, number, number, number]>): void {
    if (!colors.length) return;
    this.struct("palette-set", () => {
      this.doc.palette = colors.slice(0, 512).map((c) => [c[0], c[1], c[2], c[3]]);
    });
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
    });
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
    });
    this.changed();
  }
  setBrushSize(n: number): void {
    this.brushSize = Math.max(1, Math.min(64, Math.round(n)));
    this.changed();
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
    });
  }
  setBrushAlpha(n: number): void {
    this.color[3] = Math.max(0, Math.min(255, Math.round(n)));
    this.changed();
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
      });
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
    this.layerIdx = Math.max(0, Math.min(this.doc.layers.length - 1, li));
    this.changed();
  }
  /** onion skin master switch (fine-grained options live in Settings) */
  toggleOnion(): void {
    this.prefs.onionOn = !this.prefs.onionOn;
    this.savePrefs();
    this.repaintAll();
    this.changed();
  }
  setOnionOn(on: boolean): void { this.setSetting("onion.enabled", on); }
  setOnionBefore(n: number): void { this.setSetting("onion.before", n); }
  setOnionAfter(n: number): void { this.setSetting("onion.after", n); }
  setOnionAlpha(n: number): void { this.setSetting("onion.alpha", n); }
  setOnionTint(on: boolean): void { this.setSetting("onion.tint", on); }
  setOnionWrap(on: boolean): void { this.setSetting("onion.wrap", on); }
  setPreviewBg(b: "white" | "black" | "checker"): void { this.setSetting("display.previewBg", b); }
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

  /** One-tap drop shadow based ONLY on the current layer's image. Depending on
   *  the shadowNewLayer pref it is baked into the current layer (silhouette kept
   *  on top) or written onto a new layer placed just below it. */
  applyShadow(): void {
    const doc = this.doc;
    const li = this.curLayer();
    const fi = this.curFrame();
    const cel = doc.celAt(li, fi);
    if (!cel) return;
    let has = false;
    for (let i = 3; i < cel.data.length; i += 4) if (cel.data[i] > 0) { has = true; break; }
    if (!has) { toastFn(this.prefs.lang === "en" ? "Layer is empty" : "当前图层为空"); return; }
    const w = doc.w, h = doc.h;
    const color: RGBA = [0, 0, 0, 150];
    if (!this.prefs.shadowNewLayer) {
      const before = new Uint8ClampedArray(cel.data);
      fxE.dropShadowCel(cel.data, w, h, 3, 3, color, true);
      let changed = false;
      for (let i = 0; i < before.length; i++) if (cel.data[i] !== before[i]) { changed = true; break; }
      if (changed) this.history.pushPixels("fx-shadow", doc, [{ li, fi, before, after: new Uint8ClampedArray(cel.data) }]);
      this.repaintAll();
      this.changed();
      return;
    }
    // new "shadow" layer below the current one, holding ONLY the offset copy.
    // The current layer's pixels are the silhouette source, so copy them in first.
    const shadow = new Uint8ClampedArray(cel.data);
    fxE.dropShadowCel(shadow, w, h, 3, 3, color, false);
    this.struct("fx-shadow", () => {
      const curLi = this.curLayer();
      ops.addLayer(doc, curLi, "shadow"); // shadow layer at curLi, artwork moves to curLi+1
      const sc = doc.ensureCel(curLi, fi);
      sc.data.set(shadow);
      this.layerIdx = curLi + 1; // keep the artwork layer active
    });
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

  /** cheap scalar command: fn applied now; undo restores via back(). */
  private cheap(label: string, fn: () => void, back: () => void): void {
    fn();
    this.history.record(label, { apply: fn, unapply: back });
    this.syncAfterDocChange();
  }

  // ---------- documents ----------
  async newDoc(w: number, h: number, name: string, bg: RGBA | null): Promise<boolean> {
    if (!(await this.askOverwrite("new"))) return false;
    this.doc = new Doc(w, h, name);
    this.doc.palette = defaultPalette();
    this.doc.bg = bg;
    this.layerIdx = 0;
    this.frameIdx = 0;
    this.history.clear();
    this.clip = null;
    this.applySymPreset(this.sym);
    this.stopPlayback();
    this.view_?.setDoc(this.doc);
    this.view_?.setFrame(0);
    this.view_?.fit();
    this.syncAll();
    return true;
  }
  async replaceDoc(doc: Doc): Promise<boolean> {
    if (!(await this.askOverwrite("open"))) return false;
    this.doc = doc;
    this.layerIdx = 0;
    this.frameIdx = 0;
    this.history.clear();
    this.clip = null;
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
    this.struct("layer-merge", () =>
      ops.mergeLayerDown(this.doc, li, (dst, src, o, b) => compositor.compositeOntoCel(dst, src, o, b))
    );
  }
  toggleLayerVisible(li: number): void {
    const L = this.doc.layers[li];
    if (!L) return;
    const old = L.visible;
    this.cheap("layer-visible",
      () => { const N = this.doc.layers[li]; if (N) N.visible = !old; },
      () => { const N = this.doc.layers[li]; if (N) N.visible = old; });
  }
  toggleLayerLock(li: number): void {
    const L = this.doc.layers[li];
    if (!L) return;
    const old = L.locked;
    this.cheap("layer-lock",
      () => { const N = this.doc.layers[li]; if (N) N.locked = !old; },
      () => { const N = this.doc.layers[li]; if (N) N.locked = old; });
  }
  renameLayer(li: number, name: string): void {
    if (!name.trim()) return;
    const L = this.doc.layers[li];
    if (!L) return;
    const old = L.name;
    const next = name.trim();
    this.cheap("layer-rename",
      () => { const N = this.doc.layers[li]; if (N) N.name = next; },
      () => { const N = this.doc.layers[li]; if (N) N.name = old; });
  }
  setLayerOpacity(li: number, o: number): void {
    const L = this.doc.layers[li];
    if (!L) return;
    const v = Math.max(0, Math.min(100, Math.round(o)));
    const old = L.opacity;
    this.cheap("layer-opacity",
      () => { const N = this.doc.layers[li]; if (N) N.opacity = v; },
      () => { const N = this.doc.layers[li]; if (N) N.opacity = old; });
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
    });
    this.changed();
  }
  setLayerBlend(li: number, b: BlendMode): void {
    const L = this.doc.layers[li];
    if (!L) return;
    const old = L.blend;
    this.cheap("layer-blend",
      () => { const N = this.doc.layers[li]; if (N) N.blend = b; },
      () => { const N = this.doc.layers[li]; if (N) N.blend = old; });
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
      () => { list.forEach((fi, k) => { const f = this.doc.frames[fi]; if (f) f.durationMs = olds[k]; }); });
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
  setTlHeight(v: number): void { this.setSetting("canvas.timelineHeight", v); }
  setFrameDuration(fi: number, ms: number): void {
    const f = this.doc.frames[fi];
    if (!f) return;
    const v = Math.max(1, Math.min(60000, Math.round(ms)));
    const old = f.durationMs;
    this.cheap("frame-duration",
      () => { const N = this.doc.frames[fi]; if (N) N.durationMs = v; },
      () => { const N = this.doc.frames[fi]; if (N) N.durationMs = old; });
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
