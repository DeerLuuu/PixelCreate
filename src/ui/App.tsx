import React, { useEffect, useMemo, useRef, useState } from "react";
import { SESSION } from "./singleton";
import type { Snapshot } from "../app/session";
import { makeT } from "./i18n";
import type { Lang } from "./i18n";
import { CORE_TOOLS, SHAPE_TOOLS, SELECT_TOOLS, isShapeTool, isSelectTool, isSymTool, type ToolId } from "../tools/registry";
import { View } from "../render/view";
import { rgbaToHex, hexToRgba, chipCss } from "../engine/color";
import { paintAt } from "../engine/paint";
import * as selOps from "../tools/select";
import * as fxE from "../engine/effects";
import * as compositor from "../render/compositor";
import { HoldAdjust, ColorHoldChip } from "./hold";
import { orbMetrics, palChipPos, chipBox, swatchHitsChip, ringLayout } from "./orb-layout";
import { pieFocusIndex, pieRadiusFor, pieSlots } from "./pie-layout";
import { chordForAction, chordOf } from "../app/keymap";
import { ReplayOverlay } from "./replay";
import * as bridge from "../io/bridge";
import { writeClipboardPng } from "../io/clipboard";
import { pasteClipboard } from "./paste";
import { showTip, hideTip } from "./tooltip";
import { useColorDragFill } from "./color-drag";
import { Icon, Btn, TipHost, Keep, Overlay, useSession, useLandscape } from "./base";
import { TimelineBar } from "./timeline";
import { PreviewBox } from "./preview";
import { RefImageBox } from "./refimg";
import type { RefImg } from "./refimg";
import { PalettePanel, openFlow, MenuModal, SizeModal, SheetModal, NewDocModal, ExportModal, AdjustModal, SettingsModal, FrameModal, FramePreviewModal, CanvasRefModal, HistoryModal, ShortcutHelpModal, histName, importFlow, saveProject, openFileBytes } from "./modals";
import { FxParamDialog, fxDefaults, type FxRun, type FxVals } from "./fxparam";
import { CanvasTitles } from "./canvas";
import { ChangelogModal, changelogNeedsShow } from "./changelog";
import { watchSafeArea } from "../io/safearea";
import { fullscreenIcon, fullscreenToggleVisible, isFullscreen, toggleFullscreen, watchFullscreen } from "../io/fullscreen";
import { shortcutFor } from "../app/shortcuts";
import { isPc } from "../io/pcmode";
import { GUIDE, bootOverlay, guideStepsFor, type GuideAction, type GuideStep } from "../app/guide";
import { GuideOverlay, simulateTap } from "./guide";
import type { ModalId, SizeMode, SheetData } from "./modals";
import { Dialog, useKitPcMode } from "./kit";

type PanelId = "layers" | "palette" | null;


export function App() {
  const snap = useSession();
  const t = useMemo(() => makeT(snap.lang as Lang), [snap.lang]);
  // kill the browser's long-press menu / text selection anywhere in the app
  useEffect(() => {
    const isEditable = (t: EventTarget | null): boolean => {
      const el = t as HTMLElement | null;
      return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    };
    // text fields keep the NATIVE menu (copy / paste / spelling); everywhere else
    // the browser menu is swallowed so a right-click can paint with the other slot
    const onCtx = (e: Event) => {
      if (isEditable(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    // 右键相关的浏览器手势（拖拽/中键自动滚动/辅助点击菜单）全部拦掉
    const onAux = (e: Event) => { const m = e as MouseEvent; if (m.button === 1 || m.button === 2) e.preventDefault(); };
    const onDragEnd = (e: Event) => e.preventDefault();
    const onDrag = (e: Event) => e.preventDefault();
    const onSel = (e: Event) => { if (!isEditable(e.target)) e.preventDefault(); };
    document.addEventListener("contextmenu", onCtx);
    document.addEventListener("auxclick", onAux);
    document.addEventListener("dragend", onDragEnd);
    document.addEventListener("dragstart", onDrag);
    document.addEventListener("selectstart", onSel);
    return () => {
      document.removeEventListener("contextmenu", onCtx);
      document.removeEventListener("auxclick", onAux);
      document.removeEventListener("dragend", onDragEnd);
      document.removeEventListener("dragstart", onDrag);
      document.removeEventListener("selectstart", onSel);
    };
  }, []);
  const [panel, setPanel] = useState<PanelId>(null);
  const [modal, setModal] = useState<ModalId>(null);
  /** PC 模式（跟随 kit 的标记）：快捷键、手势拦截、桌面布局都看它 */
  const pcMode = useKitPcMode();
  // frame duration dialog: a frame index, or "batch" for the picked frames
  const [frameDlgIdx, setFrameDlgIdx] = useState<number | "batch" | null>(null);
  const [tlOn, setTlOn] = useState(false); // timeline starts hidden
  const [tlClosing, setTlClosing] = useState(false);
  const [sizeMode, setSizeMode] = useState<SizeMode>("canvas");
  const [sheet, setSheet] = useState<SheetData | null>(null);
  const [replayOn, setReplayOn] = useState(false);
  // the reference image lives in the session so it survives a restart
  const refImg = SESSION.refImg;
  const [confirmQ, setConfirmQ] = useState<{ msg: string; yes: string; no: string; res: (ok: boolean) => void } | null>(null);
  const [textQ, setTextQ] = useState<{ title: string; value: string; ok: string; cancel: string; res: (v: string | null) => void } | null>(null);
  /** onboarding tour: steps still unseen by this user (null = not running) */
  const [guide, setGuide] = useState<GuideStep[] | null>(null);
  /** app state before the tour started (the tour really taps buttons) */
  const guideState = useRef<{ tlOn: boolean; onionOn: boolean } | null>(null);
  /** live readout while dragging the timeline divider */
  const [tlDrag, setTlDrag] = useState<{ h: number; top: number } | null>(null);
  const tlGripRef = useRef<{ id: number; y0: number; h0: number } | null>(null);

  useEffect(() => {
    SESSION.setConfirmAsk((q) => new Promise<boolean>((resolve) => setConfirmQ({ msg: q.msg, yes: q.yes, no: q.no, res: resolve })));
    SESSION.setTextAsk((q) => new Promise<string | null>((resolve) => setTextQ({ ...q, res: resolve })));
    return () => { SESSION.setConfirmAsk(null); SESSION.setTextAsk(null); };
  }, []);

  // full screen / safe area: push the insets into CSS vars and keep them fresh
  // across rotation (the settings registry re-applies them on change too)
  useEffect(() => watchSafeArea(() => SESSION.prefs), []);

  // first launch after an update: auto-show the release notes. While they are
  // due (or still open) the tour below waits: the guide is a full-screen
  // spotlight that swallows taps, so starting both would trap the user behind
  // the notes (see bootOverlay in src/app/guide.ts).
  // PC：Tab 隐藏界面（专注画画）
  const [uiHidden, setUiHidden] = useState(false);
  const [clgBlock, setClgBlock] = useState<boolean>(() => changelogNeedsShow());
  useEffect(() => {
    if (clgBlock) setModal("changelog");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // PC：把文件拖到窗口里直接打开（.pxc / PNG / GIF），拖动时显示提示层
  const [dropHint, setDropHint] = useState(false);
  useEffect(() => {
    let depth = 0;
    const hasFile = (e: DragEvent): boolean => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
    const onOver = (e: DragEvent) => { if (!hasFile(e)) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; };
    const onEnter = (e: DragEvent) => { if (!hasFile(e)) return; e.preventDefault(); depth++; setDropHint(true); };
    const onLeave = () => { depth = Math.max(0, depth - 1); if (!depth) setDropHint(false); };
    const onDrop = (e: DragEvent) => {
      if (!hasFile(e)) return;
      e.preventDefault();
      depth = 0; setDropHint(false);
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      void (async () => {
        try {
          const buf = new Uint8Array(await file.arrayBuffer());
          await openFileBytes(file.name, buf, "new", file.type || "");
        } catch { bridge.toast(makeT(SESSION.prefs.lang as Lang)("importFail")); }
      })();
    };
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  // PC 键盘快捷键（全部动作集中在这里，映射表在 app/shortcuts.ts 里是纯函数）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isPc()) return;
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      const hit = shortcutFor({
        key: e.key, code: e.code,
        ctrlKey: e.ctrlKey || e.metaKey, metaKey: e.metaKey,
        shiftKey: e.shiftKey, altKey: e.altKey,
      }, typing, SESSION.prefs.keymap);
      if (!hit) return;
      const v = SESSION.view;
      switch (hit.action) {
        case "undo": e.preventDefault(); SESSION.undo(); break;
        case "redo": e.preventDefault(); SESSION.redo(); break;
        case "save": e.preventDefault(); void saveProject(); break;
        case "copy": {
          e.preventDefault();
          const d0 = SESSION.doc, li0 = SESSION.curLayer(), fi0 = SESSION.curFrame();
          const clip = selOps.selOps.copy(d0, li0, fi0);
          SESSION.clip = clip;
          if (clip) void writeClipboardPng(compositor.celToCanvas(clip)).then((ok) => bridge.toast(ok ? makeT(SESSION.prefs.lang as Lang)("sysCopy") : makeT(SESSION.prefs.lang as Lang)("copied")));
          break;
        }
        case "cut": {
          e.preventDefault();
          const d0 = SESSION.doc, li0 = SESSION.curLayer(), fi0 = SESSION.curFrame();
          const clip = selOps.selOps.cut(d0, SESSION.history, li0, fi0);
          SESSION.clip = clip;
          if (clip) {
            SESSION.repaint();
            void writeClipboardPng(compositor.celToCanvas(clip)).then((ok) => bridge.toast(ok ? makeT(SESSION.prefs.lang as Lang)("sysCopy") : makeT(SESSION.prefs.lang as Lang)("cut")));
          }
          break;
        }
        case "framePrev": e.preventDefault(); SESSION.stepFrame(-1); break;
        case "frameNext": e.preventDefault(); SESSION.stepFrame(1); break;
        case "layerPrev": e.preventDefault(); SESSION.cycleLayer(-1); break;
        case "layerNext": e.preventDefault(); SESSION.cycleLayer(1); break;
        case "paste":
        case "pasteLayer":
        case "pasteCanvas": {
          e.preventDefault();
          void pasteClipboard(hit.action === "pasteLayer" ? "layer" : hit.action === "pasteCanvas" ? "canvas" : "inPlace");
          break;
        }
        case "delete": e.preventDefault(); void SESSION.deleteKeyAction(); break;
        case "escape": if (SESSION.doc.sel?.hasAny()) { SESSION.doc.sel.clear(); SESSION.repaint(); } break;
        case "zoomIn": e.preventDefault(); if (v) { v.zoomAt(v.zoom * 1.25, v.vpW() / 2, v.vpH() / 2); SESSION.changedUI(); } break;
        case "zoomOut": e.preventDefault(); if (v) { v.zoomAt(v.zoom / 1.25, v.vpW() / 2, v.vpH() / 2); SESSION.changedUI(); } break;
        case "fit": e.preventDefault(); SESSION.fitCanvas(); break;
        case "toggleUI": e.preventDefault(); setUiHidden((on) => !on); break;
        case "tool": e.preventDefault(); SESSION.setTool(hit.tool as ToolId); break;
        case "swapColors": e.preventDefault(); SESSION.swapColors(); break;
        case "resizeMode": e.preventDefault(); SESSION.toggleResizeMode(); break;
        case "openFile": e.preventDefault(); void openFlow("new"); break;
        case "newDoc": e.preventDefault(); setModal("newdoc"); break;
        case "exportFile": e.preventDefault(); setModal("export"); break;
        case "shortcutHelp": e.preventDefault(); setModal("shortcuts"); break;
        case "nudge": {
          e.preventDefault();
          const dx = hit.dx ?? 0, dy = hit.dy ?? 0;
          if (!SESSION.nudgeSelection(dx, dy) && v) v.panBy(-dx * 8, -dy * 8);
          break;
        }
        default: break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ⑫ PC 模式：拦掉浏览器自带手势 —— 双指横滑＝前进/后退、触控板橡皮筋回弹、
  // 右键长按拖动、Safari 触控板捏合。真正可滚动的区域（弹窗、时间轴、列表）照常滚动，
  // Ctrl+滚轮留给浏览器缩放（画布自己的滚轮缩放由 View 处理）。
  useEffect(() => {
    if (!pcMode) return;
    const canScroll = (el: Element | null, dx: number, dy: number): boolean => {
      for (let n = el as HTMLElement | null; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
        const st = window.getComputedStyle(n);
        const vertical = Math.abs(dy) >= Math.abs(dx);
        if (vertical && /auto|scroll/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 1) return true;
        if (!vertical && /auto|scroll/.test(st.overflowX) && n.scrollWidth > n.clientWidth + 1) return true;
        if (/auto|scroll/.test(st.overflowX) && /auto|scroll/.test(st.overflowY) &&
            n.scrollHeight > n.clientHeight + 1 && n.scrollWidth > n.clientWidth + 1) return true;
      }
      return false;
    };
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return;                       // browser zoom stays available
      if (e.defaultPrevented) return;              // the canvas already handled it
      if (canScroll(e.target as Element, e.deltaX, e.deltaY)) return;
      e.preventDefault();                          // no history swipe / overscroll
    };
    const onDown = (e: PointerEvent) => { if (e.button === 2) e.preventDefault(); };
    const onGesture = (e: Event) => e.preventDefault();
    document.addEventListener("wheel", onWheel, { capture: true, passive: false });
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("gesturestart", onGesture, true);
    document.addEventListener("gesturechange", onGesture, true);
    document.addEventListener("gestureend", onGesture, true);
    return () => {
      document.removeEventListener("wheel", onWheel, true);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("gesturestart", onGesture, true);
      document.removeEventListener("gesturechange", onGesture, true);
      document.removeEventListener("gestureend", onGesture, true);
    };
  }, [pcMode]);

  // onboarding: first run shows everything, a later release only shows the NEW
  // steps (those whose ids were never recorded), and only once per launch
  useEffect(() => {
    let seen: string[] = [];
    let fresh = true;
    try {
      const raw = localStorage.getItem("pc.guide.seen");
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          seen = arr.filter((x): x is string => typeof x === "string");
          fresh = false;
        }
      }
    } catch { /* ignore */ }
    const todo = guideStepsFor(seen, fresh);
    if (!todo.length) return;
    // release notes first (they are dismissed by the user), then the tour
    if (bootOverlay(todo.length, clgBlock, snap.canvasCount) !== "guide") return;
    guideState.current = { tlOn, onionOn: SESSION.prefs.onionOn };
    const id = window.setTimeout(() => setGuide(todo), 900);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.canvasCount > 0, clgBlock]);

  /** selection demonstrated for the selection-orb step, restored afterwards */
  const selBackup = useRef<{ had: boolean; mask: Uint8Array | null } | null>(null);
  const demoSelection = () => {
    const d = SESSION.doc;
    if (!selBackup.current) {
      selBackup.current = { had: !!d.sel && d.sel.hasAny(), mask: d.sel ? new Uint8Array(d.sel.mask) : null };
    }
    // a centred rectangle (no history entry: the tour must not pollute undo)
    const w = Math.max(2, Math.round(d.w * 0.4));
    const h = Math.max(2, Math.round(d.h * 0.4));
    const x0 = Math.max(0, Math.round((d.w - w) / 2));
    const y0 = Math.max(0, Math.round((d.h - h) / 2));
    selOps.selOps.setRect(d, x0, y0, x0 + w - 1, y0 + h - 1);
    SESSION.repaintAll();
    SESSION.changedUI();
  };
  const restoreSelection = () => {
    const bak = selBackup.current;
    selBackup.current = null;
    if (!bak) return;
    const d = SESSION.doc;
    if (bak.had && bak.mask && d.sel) d.sel.mask.set(bak.mask);
    else selOps.selOps.clear(d);
    SESSION.repaintAll();
    SESSION.changedUI();
  };

  /** host actions the guide can request (declared in src/app/guide.ts) */
  const guideActions = useMemo<Partial<Record<GuideAction, () => void>>>(() => ({
    openTimeline: () => setTlOn(true),
    closeTimeline: () => setTlOn(false),
    closeOverlays: () => { setPanel(null); setModal(null); },
    // docked orbs live in the storage area, not on screen: pop them out for the
    // tour and put the layout back afterwards (FloatingTools listens for these)
    undockOrbs: () => window.dispatchEvent(new Event("pc-guide-undock")),
    redockOrbs: () => window.dispatchEvent(new Event("pc-guide-redock")),
    demoSelection,
    restoreSelection,
    // really paint a short stroke on the canvas, then undo it: the user sees a
    // real mark appear and disappear (the history step is tagged so a stroke
    // the user draws meanwhile is never rolled back by mistake)
    demoStroke: () => {
      const d = SESSION.doc;
      const li = SESSION.curLayer(), fi = SESSION.curFrame();
      const cel = d.ensureCel(li, fi);
      const before = new Uint8ClampedArray(cel.data);
      const len = Math.max(6, Math.round(d.w * 0.25));
      const x0 = Math.max(1, Math.round((d.w - len) / 2));
      const y0 = Math.round(d.h / 2);
      for (let i = 0; i < len; i++) {
        const x = x0 + i;
        const y = y0 + Math.round(Math.sin((i / len) * Math.PI) * 2);
        paintAt(cel, x, y, SESSION.color);
      }
      SESSION.history.pushPixels("guide-demo", d, [{ li, fi, before, after: new Uint8ClampedArray(cel.data) }]);
      SESSION.repaint();
      SESSION.changedUI();
      window.setTimeout(() => {
        const l = SESSION.history.list();
        const last = l.labels[l.labels.length - 1];
        if (last === "guide-demo" && l.index === l.labels.length) SESSION.undo();
      }, 1500);
    },
    // tool ring: opened by the tour so every individual tool can be highlighted
    openToolRing: () => window.dispatchEvent(new CustomEvent("pc-guide-tools", { detail: "open" })),
    // canvas orb ring (page 1 / the "more" page)
    openCanvasRing: () => window.dispatchEvent(new CustomEvent("pc-guide-canvas", { detail: "open" })),
    closeCanvasRing: () => window.dispatchEvent(new CustomEvent("pc-guide-canvas", { detail: "close" })),
    canvasMore: () => window.dispatchEvent(new CustomEvent("pc-guide-canvas", { detail: "more" })),
    canvasBack: () => window.dispatchEvent(new CustomEvent("pc-guide-canvas", { detail: "back" })),
    closeToolRing: () => window.dispatchEvent(new CustomEvent("pc-guide-tools", { detail: "close" })),
    toolSubShape: () => window.dispatchEvent(new CustomEvent("pc-guide-tools", { detail: "shape" })),
    toolSubSelect: () => window.dispatchEvent(new CustomEvent("pc-guide-tools", { detail: "select" })),
    toolSubBack: () => window.dispatchEvent(new CustomEvent("pc-guide-tools", { detail: "back" })),
    // main menu + its sub-menus: MenuModal takes the initial sub from this
    // window flag (it mounts after the click) and follows the event afterwards
    openMenu: () => {
      (window as unknown as { __pcGuideMenuSub?: null | "import" }).__pcGuideMenuSub = null;
      setModal("menu");
      window.setTimeout(() => window.dispatchEvent(new CustomEvent("pc-guide-menu-sub", { detail: null })), 0);
    },
    closeMenu: () => {
      (window as unknown as { __pcGuideMenuSub?: null | "import" }).__pcGuideMenuSub = null;
      setModal(null);
    },
    menuSubImport: () => window.dispatchEvent(new CustomEvent("pc-guide-menu-sub", { detail: "import" })),
    menuSubBack: () => window.dispatchEvent(new CustomEvent("pc-guide-menu-sub", { detail: null })),
    // close every floating-ball ring (used when the tour ends)
    closeOrbs: () => window.dispatchEvent(new CustomEvent("pc-guide-tools", { detail: "closeall" })),
    // palette panel (palette sort / merge / de-dupe step)
    openPalettePanel: () => setPanel("palette"),
    closePalettePanel: () => setPanel((p) => (p === "palette" ? null : p)),
    // export dialog with the frame-range row visible
    demoExportRange: () => {
      (window as unknown as { __pcGuideExportTab?: string }).__pcGuideExportTab = "gif";
      setModal("export");
    },
    closeExport: () => setModal((m) => (m === "export" ? null : m)),
    // frame multi-select: enter pick mode and really tick two frames
    demoFramePick: () => {
      SESSION.setFrameSelMode(true);
      const n = SESSION.doc.frames.length;
      const pick = (i: number) => {
        if (i < n) window.setTimeout(() => simulateTap('[data-guide="frame-' + i + '"]'), 320 + i * 260);
      };
      pick(0);
      pick(Math.min(2, n - 1));
    },

    // ---------------------------------------------------------------- demos
    // Every demo below performs the REAL action and then puts the app back the
    // way it found it. Restores are guarded: if the user (or the next step)
    // changed the same thing meanwhile, the demo leaves it alone.
    //
    // the view really zooms out and back in while the finger dots play
    demoZoom: () => {
      const v = SESSION.view;
      if (!v) return;
      const z0 = v.zoom, ox0 = v.ox, oy0 = v.oy;
      const seq = [0.75, 0.55, 0.75, 1];
      seq.forEach((k, i) => window.setTimeout(() => {
        const want = i === 0 ? z0 : z0 * seq[i - 1];
        if (Math.abs(v.zoom - want) > 1e-6) return; // user took over: stop touching it
        v.zoomAt(z0 * k);
      }, 260 + i * 300));
      window.setTimeout(() => {
        if (Math.abs(v.zoom - z0) > 1e-6) return;
        v.zoom = z0; v.ox = ox0; v.oy = oy0; v.refresh(false);
      }, 260 + seq.length * 300 + 200);
    },
    // triple-tap really zooms 2x around the canvas centre, then goes back
    demoZoomIn: () => {
      const v = SESSION.view;
      if (!v) return;
      const z0 = v.zoom, ox0 = v.ox, oy0 = v.oy;
      const z1 = Math.min(32, z0 * 2);
      if (Math.abs(z1 - z0) < 1e-6) return;
      v.zoomAt(z1);
      window.setTimeout(() => {
        if (Math.abs(v.zoom - z1) > 1e-6) return; // user zoomed: keep their view
        v.zoom = z0; v.ox = ox0; v.oy = oy0; v.refresh(false);
      }, 1800);
    },
    // really select another tool, then hand the previous one back
    // really switch to the bucket with gradient mode on, then put it back
    demoBucketGrad: () => {
      const prevTool = SESSION.tool;
      const prevGrad = SESSION.prefs.bucketGrad;
      SESSION.setTool("bucket");
      SESSION.setBucketGrad(true);
      window.setTimeout(() => {
        if (SESSION.tool === "bucket") SESSION.setTool(prevTool);
        if (SESSION.prefs.bucketGrad === true) SESSION.setBucketGrad(prevGrad);
      }, 2600);
    },
    demoToolSwitch: () => {
      const prev = SESSION.tool;
      const alt: ToolId = prev === "eraser" ? "pencil" : "eraser";
      SESSION.setTool(alt);
      window.setTimeout(() => { if (SESSION.tool === alt) SESSION.setTool(prev); }, 1600);
    },
    demoShapeTool: () => {
      const prev = SESSION.tool;
      SESSION.setTool("line");
      window.setTimeout(() => { if (SESSION.tool === "line") SESSION.setTool(prev); }, 1600);
    },
    demoMarquee: () => {
      const prev = SESSION.tool;
      SESSION.setTool("select");
      window.setTimeout(() => { if (SESSION.tool === "select") SESSION.setTool(prev); }, 1600);
    },
    // really change the brush size, then restore the previous one
    demoBrushSize: () => {
      const prev = SESSION.brushSize;
      const alt = prev === 1 ? 8 : 1;
      SESSION.setBrushSize(alt);
      window.setTimeout(() => { if (SESSION.brushSize === alt) SESSION.setBrushSize(prev); }, 1600);
    },
    // really swap FG/BG, then swap the contents back (a second swapColors()
    // would also reorder the recent-colour list)
    demoSwapColors: () => {
      const f0 = [...SESSION.fg] as typeof SESSION.fg;
      const b0 = [...SESSION.bg] as typeof SESSION.bg;
      SESSION.swapColors();
      window.setTimeout(() => {
        if (SESSION.fg[0] !== b0[0] || SESSION.fg[1] !== b0[1] || SESSION.fg[2] !== b0[2] || SESSION.fg[3] !== b0[3]) return;
        SESSION.fg[0] = f0[0]; SESSION.fg[1] = f0[1]; SESSION.fg[2] = f0[2]; SESSION.fg[3] = f0[3];
        SESSION.bg[0] = b0[0]; SESSION.bg[1] = b0[1]; SESSION.bg[2] = b0[2]; SESSION.bg[3] = b0[3];
        SESSION.changedUI();
      }, 1600);
    },
    // really turn a symmetry axis on (the guides appear on the canvas), then off
    demoSymmetry: () => {
      const prev = { sym: SESSION.sym, four: SESSION.symFour, tweaked: SESSION.symTweaked };
      const on = SESSION.cycleSym();
      window.setTimeout(() => {
        if (SESSION.sym !== on) return; // the user changed it: keep their choice
        SESSION.sym = prev.sym; SESSION.symFour = prev.four; SESSION.symTweaked = prev.tweaked;
        SESSION.repaint();
        SESSION.changedUI();
      }, 1900);
    },
    // really tap the colour-source chip of the palette fan: the fan redraws
    // with canvas colours, then recent colours, then cycles back to the start
    demoPalMode: () => {
      const mode0 = SESSION.palOrbMode;
      const tap = () => simulateTap('[data-guide="pal-mode-chip"]');
      window.setTimeout(tap, 700);
      window.setTimeout(tap, 1500);
      window.setTimeout(() => {
        let guard = 0;
        while (SESSION.palOrbMode !== mode0 && guard++ < 4) SESSION.cyclePalOrbMode();
      }, 2400);
    },
    // the FX ring really exists at this point; applying an effect would change
    // the artwork, so the demo lights up every effect in turn instead
    demoFx: () => {
      const items = Array.from(document.querySelectorAll<HTMLElement>(".radial-layer .orb-item"));
      items.forEach((el, i) => {
        window.setTimeout(() => el.classList.add("guide-flash"), 240 + i * 240);
        window.setTimeout(() => el.classList.remove("guide-flash"), 240 + i * 240 + 460);
      });
    },
    // onion skin really shows the neighbouring frame (no history entry)
    demoOnionFrame: () => {
      const d = SESSION.doc;
      if (d.frames.length < 2) return;
      const fi0 = SESSION.curFrame();
      if (!SESSION.prefs.onionOn) SESSION.setOnionOn(true);
      const fi1 = (fi0 + 1) % d.frames.length;
      SESSION.setFrame(fi1, false);
      window.setTimeout(() => { if (SESSION.curFrame() === fi1) SESSION.setFrame(fi0, false); }, 2000);
    },
    // the four-finger preview, for real: opens, then closes itself
    demoFramePreview: () => {
      setModal("framePrev");
      window.setTimeout(() => setModal((m) => (m === "framePrev" ? null : m)), 2800);
    },
    // the settings / changelog dialogs, for real (the guide spotlights them)
    demoSettings: () => setModal("settings"),
    closeSettings: () => setModal((m) => (m === "settings" ? null : m)),
    demoChangelog: () => setModal("changelog"),
    closeChangelog: () => setModal((m) => (m === "changelog" ? null : m)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  // a colour picked for an FX parameter closes the palette panel again
  useEffect(() => {
    const onPicked = () => setPanel((p) => (p === "palette" ? null : p));
    window.addEventListener("pc-color-picked", onPicked);
    return () => window.removeEventListener("pc-color-picked", onPicked);
  }, []);

  // gestures can be re-mapped to UI-level actions (timeline / preview / palette)
  useEffect(() => {
    const onGesture = (e: Event) => {
      const what = (e as CustomEvent<string>).detail;
      if (what === "toggleTimeline") setTlOn((v) => !v);
      else if (what === "framePreview") setModal("framePrev");
      else if (what === "openPalette") setPanel("palette");
    };
    window.addEventListener("pc-gesture", onGesture);
    return () => window.removeEventListener("pc-gesture", onGesture);
  }, []);

  const finishGuide = (shown: string[]) => {
    try {
      const prev = JSON.parse(localStorage.getItem("pc.guide.seen") ?? "[]");
      const set = new Set<string>(Array.isArray(prev) ? prev : []);
      for (const id of shown) set.add(id);
      localStorage.setItem("pc.guide.seen", JSON.stringify([...set]));
    } catch { /* ignore */ }
    // restore whatever the tour changed: docked orbs, demonstrated selection,
    // an open tool ring or main menu
    window.dispatchEvent(new Event("pc-guide-redock"));
    window.dispatchEvent(new CustomEvent("pc-guide-tools", { detail: "closeall" }));
    (window as unknown as { __pcGuideMenuSub?: null | "import" }).__pcGuideMenuSub = null;
    setModal((m) => (m === "menu" ? null : m));
    restoreSelection();
    // the tour tapped the timeline / onion buttons for real: put them back
    if (guideState.current) {
      setTlOn(guideState.current.tlOn);
      if (SESSION.prefs.onionOn !== guideState.current.onionOn) SESSION.setOnionOn(guideState.current.onionOn);
      guideState.current = null;
    }
    setGuide(null);
  };

  // --- draggable divider between the control bar and the timeline ----------
  // portrait: the line above the frame strip; landscape: the top edge of the
  // bottom timeline row. Dragging it resizes prefs.tlH live.
  const tlMaxH = (): number => Math.max(140, Math.min(520, Math.round(window.innerHeight * 0.62)));
  const gripDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    tlGripRef.current = { id: e.pointerId, y0: e.clientY, h0: SESSION.prefs.tlH };
    el.classList.add("on");
    setTlDrag({ h: SESSION.prefs.tlH, top: el.getBoundingClientRect().top });
  };
  const gripMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = tlGripRef.current;
    if (!g || e.pointerId !== g.id) return;
    // dragging up (dy < 0) makes the panel taller
    const h = Math.max(140, Math.min(tlMaxH(), Math.round(g.h0 - (e.clientY - g.y0))));
    SESSION.setTlHeight(h);
    setTlDrag({ h, top: e.currentTarget.getBoundingClientRect().top });
  };
  const gripUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = tlGripRef.current;
    if (!g || e.pointerId !== g.id) return;
    tlGripRef.current = null;
    e.currentTarget.classList.remove("on");
    window.setTimeout(() => setTlDrag(null), 700);
  };

  return (
    <div className={"app-root" + (SESSION.prefs.railSwap ? " rails-swap" : "") + (tlOn ? " has-tl" : "") + (uiHidden ? " chrome-off" : "")} onContextMenu={(e) => e.preventDefault()} onDragStart={(e) => e.preventDefault()}>
      <TopBar t={t} snap={snap} tlOn={tlOn} noCanvas={snap.canvasCount === 0} onToggleTl={() => {
        if (tlClosing) return;
        if (tlOn) {
          setTlClosing(true);
          window.setTimeout(() => { setTlClosing(false); setTlOn(false); }, 210);
        } else {
          setTlOn(true);
        }
      }} onMenu={() => setModal("menu")} onHistory={() => setModal("history")} onSave={() => void saveProject()} />
      <div className="workspace">
        {snap.canvasCount === 0
          ? <EmptyCanvas t={t} onNew={() => setModal("newdoc")} onOpen={() => void importFlow()} />
          : <Viewport
            onColorClick={() => setPanel("palette")}
            refImg={refImg}
            onRefClose={() => SESSION.setRefImage(null)}
            onFramePrev={() => setModal("framePrev")}
          />}
      </div>
      {snap.canvasCount > 0 && <ControlBar t={t} snap={snap} onPanel={setPanel} onAdjust={() => setModal("adjust")} onFramePrev={() => setModal("framePrev")} />}
      {snap.canvasCount > 0 && tlOn && (
      <div className={"tline-wrap" + (tlClosing ? " closing" : "")}>
        <div className="tl-grip" data-guide="tl-grip" title={t("tlGripHint")}
          onPointerDown={gripDown} onPointerMove={gripMove} onPointerUp={gripUp} onPointerCancel={gripUp}
          onDoubleClick={() => SESSION.setTlHeight(200)} />
        <TimelineBar t={t} snap={snap} onFrameDlg={setFrameDlgIdx} />
      </div>
      )}
      {tlDrag && <div className="tl-pill" style={{ top: Math.max(4, tlDrag.top - 30) }}>{tlDrag.h}px</div>}
      {snap.canvasCount > 0 && <FloatingTools t={t} snap={snap}
        onCanvasNew={() => setModal("newdoc")}
        onCanvasSize={() => { setSizeMode("canvas"); setModal("size"); }}
        onCanvasAdjust={() => setModal("adjust")}
        onCanvasExport={() => setModal("export")}
        onOpenPalette={() => setPanel("palette")}
        onCanvasRef={() => setModal("canvasRef")} />}
      {replayOn && <ReplayOverlay t={t} snap={snap} nameFn={(lb) => histName(lb, t, snap.lang)} onClose={() => { setModal(null); setReplayOn(false); }} />}
      <Keep on={panel === "palette"} el={panel === "palette" ? (
        <Overlay onClose={() => setPanel(null)}>
          <PalettePanel t={t} onClose={() => setPanel(null)} />
        </Overlay>
      ) : null} />
      <Keep on={modal === "menu"} el={modal === "menu" ? <MenuModal t={t} snap={snap} onClose={() => setModal(null)} onOpen={setModal} onSheet={(d) => { setSheet(d); setModal("sheet"); }} onRef={(d) => SESSION.setRefImage(d)} onGuide={() => { setModal(null); setGuide(GUIDE.slice()); }} /> : null} />
      <Keep on={modal === "size"} el={modal === "size" ? <SizeModal t={t} snap={snap} initial={sizeMode} onClose={() => setModal(null)} /> : null} />
      <Keep on={modal === "sheet" && sheet !== null} el={modal === "sheet" && sheet ? <SheetModal t={t} img={sheet} onClose={() => { setModal(null); setSheet(null); }} /> : null} />
      <Keep on={modal === "newdoc"} el={modal === "newdoc" ? <NewDocModal t={t} onClose={() => setModal(null)} /> : null} />
      <Keep on={modal === "newproject"} el={modal === "newproject" ? <NewDocModal t={t} mode="project" onClose={() => setModal(null)} /> : null} />
      <Keep on={modal === "export"} el={modal === "export" ? <ExportModal t={t} snap={snap} onClose={() => setModal(null)} /> : null} />
      <Keep on={modal === "settings"} el={modal === "settings" ? <SettingsModal t={t} onClose={() => setModal(null)} /> : null} />
      <Keep on={modal === "adjust"} el={modal === "adjust" ? <AdjustModal t={t} onClose={() => setModal(null)} /> : null} />
      <Keep on={frameDlgIdx !== null} el={frameDlgIdx !== null ? <FrameModal t={t} snap={snap} fi={typeof frameDlgIdx === "number" ? frameDlgIdx : snap.frameIdx} batch={frameDlgIdx === "batch"} onClose={() => setFrameDlgIdx(null)} /> : null} />
      <Keep on={modal === "history"} el={modal === "history" ? <HistoryModal t={t} snap={snap} onClose={() => setModal(null)} onReplay={() => { setModal(null); setReplayOn(true); }} /> : null} />
      <Keep on={modal === "framePrev"} el={modal === "framePrev" ? <FramePreviewModal t={t} onClose={() => setModal(null)} /> : null} />
      <Keep on={modal === "canvasRef"} el={modal === "canvasRef" ? <CanvasRefModal t={t} onClose={() => setModal(null)} /> : null} />
      <Keep on={modal === "shortcuts"} el={modal === "shortcuts" ? <ShortcutHelpModal t={t} onClose={() => setModal(null)} /> : null} />
      <Keep on={modal === "changelog"} el={modal === "changelog" ? <ChangelogModal onClose={() => { setModal(null); setClgBlock(false); }} /> : null} />
      {guide && <GuideOverlay steps={guide} actions={guideActions} onDone={finishGuide} />}
      {textQ && (
        <div className="cfm-layer">
          <Dialog title={textQ.title} onClose={() => { textQ.res(null); setTextQ(null); }} closeBtn={false} footer={<><Btn label={textQ.cancel} onClick={() => { textQ.res(null); setTextQ(null); }} /> <Btn label={textQ.ok} className="primary" onClick={() => { const v = textQ.value; textQ.res(v); setTextQ(null); }} /></>}>
            <input className="textinput" autoFocus value={textQ.value} onChange={(e) => setTextQ({ ...textQ, value: e.target.value })} />
          </Dialog>
        </div>
      )}
      {confirmQ && (
        <div className="cfm-layer">
          <Dialog title={t("confirmTitle")} onClose={() => { confirmQ.res(false); setConfirmQ(null); }} closeBtn={false} footer={<><Btn label={confirmQ.no} onClick={() => { confirmQ.res(false); setConfirmQ(null); }} /><Btn label={confirmQ.yes} className="primary" onClick={() => { confirmQ.res(true); setConfirmQ(null); }} /></>}>
            <div className="row-note cfm-msg">{confirmQ.msg}</div>
          </Dialog>
        </div>
      )}
      {dropHint && (
        <div className="drop-hint"><span>{t("dropHint")}</span></div>
      )}
      <TipHost />
    </div>
  );
}

/** short function descriptions shown by the global long-press tooltip */
const B_DESC = {
  menu: { zh: "打开主功能菜单（新建 / 打开 / 导入导出 / 设置）", en: "Open the main menu" },
  full: { zh: "进入 / 退出全屏（只在浏览器打开时出现，软件版由系统栏自动隐藏）", en: "Enter / leave fullscreen (only shown in the browser; the app builds hide the system bars themselves)" },
  undo: { zh: "撤销上一步操作", en: "Undo the last action" },
  save: { zh: "把整个工程（含所有画布）保存为 .pxc 文件", en: "Save the whole project (every canvas) as a .pxc file" },
  redo: { zh: "重做已撤销的操作", en: "Redo the undone action" },

  export: { zh: "导出 PNG / GIF 动画 / 精灵表（已移到画布球）", en: "Export PNG / GIF / spritesheet (moved to the canvas orb)" },
  layers: { zh: "图层面板（新建 / 复制 / 合并 / 锁定）", en: "Layer panel" },


  palette: { zh: "调色板与取色器", en: "Palette & color picker" },
  sym: { zh: "绘画对称：正常 → 左右 → 上下 → 四向", en: "Symmetry: normal / L-R / T-B / four-way" },
  framePrev: { zh: "上一帧", en: "Previous frame" },
  play: { zh: "播放 / 暂停动画", en: "Play / pause animation" },
  frameNext: { zh: "下一帧", en: "Next frame" },
  frameAdd: { zh: "新建帧（可在设置里选择复制上一帧）", en: "New frame" },
  frameDupe: { zh: "复制当前帧", en: "Duplicate current frame" },
  frameDel: { zh: "删除当前帧", en: "Delete current frame" },
  onion: { zh: "洋葱皮：显示前后帧作参考", en: "Onion skin: reference neighbour frames" },
  brush: { zh: "笔刷大小：按住并沿轴向拖动调节", en: "Brush size: hold & drag to adjust" },
  alpha: { zh: "不透明度：按住拖动调节（0 = 橡皮擦）", en: "Opacity: hold & drag (0 = eraser)" },
  orb: { zh: "快捷工具球：点按打开工具环，按住拖动可移动位置", en: "Tool orb: tap to open, drag to move" },
  selBall: { zh: "选区操作球：填充 / 复制 / 剪切 / 粘贴 / 翻转 / 扩展等", en: "Selection actions ball" },
  fx: { zh: "魔法球：描边 / 模糊 / 投影 / 反色 / 灰度 / 居中（作用于当前图层帧）", en: "Magic ball: outline / blur / shadow / invert / grayscale / center (active layer/frame)" },
  canv: { zh: "画布球：对聚焦画布操作（新建 / 重命名 / 改尺寸 / 预览 / 关闭并保存）", en: "Canvas ball: act on the focused canvas (new / rename / resize / preview / close & save)" },
  hist: { zh: "操作记录：查看可撤销/重做的步骤，点任意旧记录可回到该状态", en: "History: view undo/redo steps, tap one to jump back" },
  loop: { zh: "循环播放：播到最后一帧后回到第 1 帧继续；关闭则播到末尾停止", en: "Loop: restart from frame 1 at the end; off stops at the last frame" },
  sides: { zh: "多边形边数：按住拖动调节（3–12 边）", en: "Polygon sides: hold & drag (3–12)" },
} as const;
function bd(lang: string, key: keyof typeof B_DESC): string {
  const e = B_DESC[key];
  return lang === "zh" ? e.zh : e.en;
}

function TopBar({
  t, snap, tlOn, noCanvas, onToggleTl, onMenu, onHistory, onSave,
}: {
  t: ReturnType<typeof makeT>; snap: Snapshot; tlOn: boolean; noCanvas: boolean; onToggleTl: () => void; onMenu: () => void; onHistory: () => void; onSave: () => void;
}) {
  const off = (fn: () => void) => (noCanvas ? () => { /* no canvas open */ } : fn);
  // the browser build gets a fullscreen toggle; the APK shell already hides the
  // system bars itself, so there the button is not rendered at all
  const [fsShow] = useState(() => fullscreenToggleVisible());
  const [fsOn, setFsOn] = useState(isFullscreen);
  useEffect(() => (fsShow ? watchFullscreen(setFsOn) : undefined), [fsShow]);
  // undo/redo stay live on the empty-space screen: closing the LAST canvas is
  // itself a history step, so it can be brought back from there
  const hist = snap.canUndo || snap.canRedo;
  return (
    <header className="topbar">
      <Btn icon="i-menu" onClick={onMenu} title={t("menu")} desc={bd(snap.lang, "menu")} guide="btn-menu" />
      <div className="grow" />
      <Btn icon="i-history" onClick={onHistory} title={t("historyTitle")} desc={bd(snap.lang, "hist")} className={noCanvas && !hist ? "off" : ""} guide="btn-history" />
      <Btn icon="i-undo" onClick={() => SESSION.undo()} title={t("undo")} desc={bd(snap.lang, "undo")} className={snap.canUndo ? "" : "off"} guide="btn-undo" />
      <Btn icon="i-redo" onClick={() => SESSION.redo()} title={t("redo")} desc={bd(snap.lang, "redo")} className={snap.canRedo ? "" : "off"} guide="btn-redo" />
      <Btn icon="i-save" onClick={off(onSave)} title={t("save")} desc={bd(snap.lang, "save")} className={noCanvas ? "off" : ""} guide="btn-save" />
      <Btn icon="i-timeline" onClick={off(onToggleTl)} active={tlOn && !noCanvas} title={t(tlOn ? "timelineHide" : "timelineShow")} className={noCanvas ? "off" : ""} guide="btn-timeline" />
      {fsShow && (
        <Btn icon={fullscreenIcon(fsOn)} onClick={() => { void toggleFullscreen(); }}
          title={t(fsOn ? "exitFullscreen" : "fullscreen")} desc={bd(snap.lang, "full")} guide="btn-fullscreen" />
      )}
    </header>
  );
}





/** shown when no canvas is open at all (fresh install / everything closed) */
function EmptyCanvas({ t, onNew, onOpen }: { t: ReturnType<typeof makeT>; onNew: () => void; onOpen: () => void }) {
  return (
    <div className="empty-canvas">
      <div className="ec-card">
        <div className="ec-logo"><Icon id="i-canvas" size={30} /></div>
        <div className="ec-title">{t("emptyTitle")}</div>
        <div className="ec-body">{t("emptyBody")}</div>
        <div className="ec-actions">
          <Btn icon="i-plus" label={t("emptyNew")} className="primary" onClick={onNew} guide="empty-new" />
          <Btn icon="i-open" label={t("emptyOpen")} onClick={onOpen} guide="empty-open" />
        </div>
      </div>
    </div>
  );
}

function FloatingTools({ t, snap, onCanvasNew, onCanvasSize, onCanvasAdjust, onCanvasExport, onOpenPalette, onCanvasRef }: {
  t: ReturnType<typeof makeT>; snap: Snapshot; onCanvasNew: () => void; onCanvasSize: () => void;
  onCanvasAdjust: () => void; onCanvasExport: () => void; onOpenPalette: () => void; onCanvasRef: () => void;
}) {
  const orbKey = "pc.orb.pos";
  const loadPos = () => {
    try {
      const p = JSON.parse(localStorage.getItem(orbKey) || "null");
      if (p && typeof p.x === "number" && typeof p.y === "number") return p;
    } catch { /* ignore */ }
    return { x: 120, y: Math.round(window.innerHeight * 0.35) };
  };
  const [pos, setPos] = useState(loadPos);
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<"shape" | "select" | null>(null);
  const [sel, setSel] = useState<{ x: number; y: number; open: boolean } | null>(null);
  const prevSelA = useRef(false);
  const drag = useRef<{ which: OrbId; dx: number; dy: number; moved: boolean } | null>(null);

  const pcMode = useKitPcMode();
  const M = orbMetrics(pcMode);
  const ORB = M.orb;
  const MINC = ORB + 16;
  /** 展开锁定：锁定后外部点击/其它球不会再收起主球环 */
  /** ⑤ 每个展开的球都能单独锁定：id → 是否锁定 */
  const [ringLock, setRingLock] = useState<Record<string, boolean>>({});
  const ringLockRef = useRef<Record<string, boolean>>({});
  ringLockRef.current = ringLock;
  const lockOf = (id: string): boolean => !!ringLock[id];
  const toggleLock = (id: string): void => setRingLock((m) => ({ ...m, [id]: !m[id] }));
  /** 每个球展开时右上角的小锁（仅展开时显示） */
  const lockBtn = (id: string, x: number, y: number) => (
    <button type="button" key={"lock-" + id} className={"orb-lock" + (lockOf(id) ? " on" : "")}
      data-guide={"orb-lock-" + id}
      style={{ left: x + ORB - 13, top: y - 13 }}
      title={t(lockOf(id) ? "orbUnlockRing" : "orbLockRing")}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); SESSION.hapticTick("工具栏", 0.6); toggleLock(id); }}>
      <Icon id={lockOf(id) ? "i-lock" : "i-unlock"} size={15} />
    </button>
  );
  const clampXY = (p: { x: number; y: number }) => ({
    x: Math.max(8, Math.min(window.innerWidth - ORB - 8, p.x)),
    y: Math.max(8, Math.min(window.innerHeight - ORB - 8, p.y)),
  });

  const [pal, setPal] = useState<{ x: number; y: number; open: boolean }>(() => ({
    x: Math.max(8, Math.round(window.innerWidth - ORB - 16)),
    y: Math.max(8, Math.round(window.innerHeight * 0.55)),
    open: false,
  }));
  const [fx, setFx] = useState<{ x: number; y: number; open: boolean }>(() => ({
    x: Math.max(8, Math.round(window.innerWidth * 0.62)),
    y: Math.max(8, Math.round(window.innerHeight * 0.62)),
    open: false,
  }));
  /** canvas orb second page + the tiling chooser dialog */
  const [canvSub, setCanvSub] = useState<"more" | null>(null);
  const [tileDlg, setTileDlg] = useState(false);
  /** canvas orb: actions on the focused canvas (rename / resize / close / preview) */
  const [canv, setCanv] = useState<{ x: number; y: number; open: boolean }>(() => ({
    x: Math.max(8, Math.round(window.innerWidth * 0.30)),
    y: Math.max(8, Math.round(window.innerHeight * 0.72)),
    open: false,
  }));

  // the onboarding tour can open the tool ring and its sub-rings by itself
  useEffect(() => {
    const onTools = (e: Event) => {
      const what = (e as CustomEvent<string>).detail;
      if (what === "open") { setOpen(true); setSub(null); }
      else if (what === "close") { setOpen(false); setSub(null); }
      else if (what === "shape") { setOpen(true); setSub("shape"); }
      else if (what === "select") { setOpen(true); setSub("select"); }
      else if (what === "back") setSub(null);
      else if (what === "closeall") {
        setOpen(false); setSub(null);
        setSel((v) => (v ? { ...v, open: false } : v));
        setPal((v) => ({ ...v, open: false }));
        setFx((v) => ({ ...v, open: false }));
        setCanv((v) => ({ ...v, open: false }));
        setCanvSub(null);
      }
    };
    window.addEventListener("pc-guide-tools", onTools);
    return () => window.removeEventListener("pc-guide-tools", onTools);
  }, []);

  // the onboarding tour opens the canvas ring / its "more" page by itself
  useEffect(() => {
    const onCanv = (e: Event) => {
      const what = (e as CustomEvent<string>).detail;
      if (what === "open") { setCanv((g) => ({ ...g, open: true })); setCanvSub(null); }
      else if (what === "close") { setCanv((g) => ({ ...g, open: false })); setCanvSub(null); }
      else if (what === "more") setCanvSub("more");
      else if (what === "back") setCanvSub(null);
    };
    window.addEventListener("pc-guide-canvas", onCanv);
    return () => window.removeEventListener("pc-guide-canvas", onCanv);
  }, []);

  // Android back: close whatever floating layer is on top before leaving.
  // The handler reads the live state from a ref, because state updates inside
  // the event would only be applied after the native side already decided.
  const backState = useRef({ open, sub, sel, pal, fx, canv });
  backState.current = { open, sub, sel, pal, fx, canv };
  useEffect(() => {
    const onBack = (e: Event) => {
      const d = (e as CustomEvent<{ handled: boolean }>).detail;
      if (!d || d.handled) return;
      const st = backState.current;
      const any = st.open || st.sub !== null || st.sel.open || st.pal.open || st.fx.open || st.canv.open;
      if (!any) return;
      setOpen(false);
      setSub(null);
      if (st.sel.open) setSel({ ...st.sel, open: false });
      if (st.pal.open) setPal({ ...st.pal, open: false });
      if (st.fx.open) setFx({ ...st.fx, open: false });
      if (st.canv.open) { setCanv({ ...st.canv, open: false }); setCanvSub(null); }
      d.handled = true;
    };
    window.addEventListener("pc-back", onBack);
    return () => window.removeEventListener("pc-back", onBack);
  }, []);

  // ---------- floating-ball dock ----------
  const landD = useLandscape();
  /** every floating orb (sel is not dockable) */
  type OrbId = "main" | "sel" | "pal" | "fx" | "canv";
  type BallId = "main" | "pal" | "fx" | "canv";
  const dockKey = "pc.orb.dock";
  const loadDock = (): Array<{ id: BallId; x: number; y: number }> => {
    try {
      const d = JSON.parse(localStorage.getItem(dockKey) || "[]");
      if (Array.isArray(d)) {
        return d.filter((e) => e && (e.id === "main" || e.id === "pal" || e.id === "fx" || e.id === "canv") &&
          typeof e.x === "number" && typeof e.y === "number");
      }
    } catch { /* ignore */ }
    return [];
  };
  const [docked, setDocked] = useState<{ id: BallId; x: number; y: number }[]>(loadDock);
  // persist the docked-ball layout so a saved layout restores the storage area
  const dockSaveSuspended = useRef(false);
  useEffect(() => {
    if (dockSaveSuspended.current) return; // the guide temporarily popped the balls out
    try { localStorage.setItem(dockKey, JSON.stringify(docked)); } catch { /* ignore */ }
  }, [docked]);
  // the onboarding tour needs the balls on screen: pop every docked ball out
  // (without touching the saved layout) and restore it when the tour ends
  const dockBackup = useRef<Array<{ id: BallId; x: number; y: number }> | null>(null);
  useEffect(() => {
    const onUndock = () => {
      if (dockBackup.current) return; // already popped out
      dockBackup.current = docked;
      dockSaveSuspended.current = true;
      setDocked([]);
      setDockOpen(false);
    };
    const onRedock = () => {
      const bak = dockBackup.current;
      dockBackup.current = null;
      dockSaveSuspended.current = false;
      if (bak && bak.length) setDocked(bak);
    };
    window.addEventListener("pc-guide-undock", onUndock);
    window.addEventListener("pc-guide-redock", onRedock);
    return () => {
      window.removeEventListener("pc-guide-undock", onUndock);
      window.removeEventListener("pc-guide-redock", onRedock);
    };
  }, [docked]);
  const [dockOpen, setDockOpen] = useState(false);
  const [dockHover, setDockHover] = useState<number | null>(null);
  const [dockArmed, setDockArmed] = useState(false);
  const dockT = useRef<number | null>(null);
  const dockDown = useRef<{ x: number; y: number } | null>(null);
  const parkRef = useRef<{ id: BallId } | null>(null);
  const dockWrap = useRef<HTMLDivElement | null>(null);
  const dockedById = (id: BallId): boolean => docked.some((d) => d.id === id);
  const dockClear = () => {
    if (dockT.current !== null) { window.clearTimeout(dockT.current); dockT.current = null; }
  };
  const dockCollapse = (ms: number) => {
    dockClear();
    dockT.current = window.setTimeout(() => { dockT.current = null; setDockOpen(false); setDockHover(null); }, ms);
  };
  const inDockZone = (x: number, y: number): boolean => (landD ? y <= 64 : x >= window.innerWidth - 64);
  /** true when the pointer is over the actual dock panel (parking only works here) */
  const overDockPanel = (x: number, y: number): boolean => {
    const el = dockWrap.current;
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };
  const park = (id: BallId) => {
    if (dockedById(id)) return;
    const cur = id === "main" ? pos : id === "pal" ? { x: pal.x, y: pal.y } : id === "canv" ? { x: canv.x, y: canv.y } : { x: fx.x, y: fx.y };
    if (id === "main") {
      try { localStorage.setItem(orbKey, JSON.stringify(cur)); } catch { /* ignore */ }
    }
    setOpen(false);
    setSub(null);
    if (sel && !pcMode) setSel({ ...sel, open: false });
    setPal((g) => (g ? { ...g, open: false } : g));
    setFx((g) => (g ? { ...g, open: false } : g));
    setCanv((g) => (g ? { ...g, open: false } : g));
    setDocked((d) => [...d, { id, x: cur.x, y: cur.y }]);
    setDockOpen(true);
    dockCollapse(900);
  };
  /** 装备槽（存储区**边上**的独立一格）：把球拖进去就是装备它 */
  const pieSlotRef = useRef<HTMLDivElement | null>(null);
  const overPieSlot = (x: number, y: number): boolean => {
    const el = pieSlotRef.current;
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return x >= r.left - 6 && x <= r.right + 6 && y >= r.top - 6 && y <= r.bottom + 6;
  };
  /** 把某个球放进装备槽；原来装着的球弹回屏幕，槽里同时只能有一个 */
  const equipBall = (id: OrbId) => {
    const prev = pieEquip;
    setDocked((d) => d.filter((e) => (e.id as string) !== (id as string)));
    if (prev && prev !== id) {
      // 被换下来的球回到屏幕上（原来的位置）
      const back = prev === "main" ? pos : prev === "pal" ? { x: pal.x, y: pal.y } : prev === "canv" ? { x: canv.x, y: canv.y } : { x: fx.x, y: fx.y };
      const np = clampXY(back);
      if (prev === "main") setPos(np);
      else if (prev === "pal") setPal({ x: np.x, y: np.y, open: false });
      else if (prev === "canv") setCanv({ x: np.x, y: np.y, open: false });
      else setFx({ x: np.x, y: np.y, open: false });
    }
    setPieEquip(id);
    setOpen(false);
    setSub(null);
    setPal((g) => (g ? { ...g, open: false } : g));
    setFx((g) => (g ? { ...g, open: false } : g));
    setCanv((g) => (g ? { ...g, open: false } : g));
    bridge.toast(t("pieEquipped") + " " + ballLabel(id));
    SESSION.hapticTick("装备", 0.8);
  };
  /** 从槽里把球取出（点一下槽，或拖出来） */
  const unequipBall = (at?: { x: number; y: number }) => {
    const id = pieEquip;
    if (!id) return;
    setPieEquip(null);
    const cur = id === "main" ? pos : id === "pal" ? { x: pal.x, y: pal.y } : id === "canv" ? { x: canv.x, y: canv.y } : { x: fx.x, y: fx.y };
    const np = clampXY(at ? { x: at.x, y: at.y } : cur);
    if (id === "main") { setPos(np); try { localStorage.setItem(orbKey, JSON.stringify(np)); } catch { /* ignore */ } }
    else if (id === "pal") setPal({ x: np.x, y: np.y, open: false });
    else if (id === "canv") setCanv({ x: np.x, y: np.y, open: false });
    else if (id === "sel") setSel((g) => ({ x: np.x, y: np.y, open: false }));
    else setFx({ x: np.x, y: np.y, open: false });
  };
  /** 球是否已经不在屏幕上（停靠进存储区，或装进了装备槽） */
  const hiddenById = (id: BallId): boolean => dockedById(id) || pieEquip === id;

  const popDock = (idx: number, at?: { x: number; y: number }) => {
    const d = docked[idx];
    if (!d) return;
    dockClear();
    setDocked(docked.filter((_, k) => k !== idx));
    // the ball pops out exactly where the finger released (fallback: old spot)
    const np = at
      ? clampXY({ x: at.x, y: at.y })
      : clampXY(landD
        ? { x: Math.min(d.x, window.innerWidth - 140), y: Math.max(8, d.y) }
        : { x: Math.min(d.x, window.innerWidth - 140), y: d.y });
    if (d.id === "main") { setPos(np); try { localStorage.setItem(orbKey, JSON.stringify(np)); } catch { /* ignore */ } }
    else if (d.id === "pal") setPal({ x: np.x, y: np.y, open: false });
    else if (d.id === "canv") setCanv({ x: np.x, y: np.y, open: false });
    else setFx({ x: np.x, y: np.y, open: false });
    setDockOpen(false);
    setDockHover(null);
  };
  const iconOfBall = (id: BallId): string => id === "main" ? "i-pencil" : id === "pal" ? "i-palette" : id === "canv" ? "i-canvas" : "i-star";
  /** 球的显示名（装备槽、饼菜单标题用） */
  const ballLabel = (id: OrbId): string =>
    id === "main" ? t("menu") : id === "sel" ? t("sel.active") : id === "pal" ? t("palette") : id === "fx" ? t("fxOrb") : t("canvasOrb");

  // rotation / resize: keep every floating ball inside the viewport
  useEffect(() => {
    const fix = () => {
      setPos((p: { x: number; y: number }) => {
        const c = clampXY(p);
        try { localStorage.setItem(orbKey, JSON.stringify(c)); } catch { /* ignore */ }
        return c;
      });
      setSel((s) => (s ? { ...s, x: clampXY({ x: s.x, y: s.y }).x, y: clampXY({ x: s.x, y: s.y }).y } : s));
      setPal((p) => ({ ...p, ...clampXY({ x: p.x, y: p.y }) }));
      setFx((p) => ({ ...p, ...clampXY({ x: p.x, y: p.y }) }));
      setCanv((p) => ({ ...p, ...clampXY({ x: p.x, y: p.y }) }));
    };
    window.addEventListener("resize", fix);
    window.addEventListener("orientationchange", fix);
    return () => {
      window.removeEventListener("resize", fix);
      window.removeEventListener("orientationchange", fix);
    };
  }, []);

  const defOf = (id: string) =>
    CORE_TOOLS.find((x) => x.id === id) ||
    SHAPE_TOOLS.find((x) => x.id === id) ||
    SELECT_TOOLS.find((x) => x.id === id);

  // the selection ball is available while a selection tool is active OR while
  // something is actually selected (a select tool with nothing selected still
  // offers select-all / paste), and it spawns near the top-left corner
  const wantSel = snap.selActive || isSelectTool(snap.tool);
  useEffect(() => {
    if (wantSel && !prevSelA.current) {
      setSel({ ...separate(clampXY({ x: 12, y: 96 }), pos), open: false });
      setOpen(false);
      setSub(null);
    } else if (!wantSel) {
      setSel(null);
    }
    prevSelA.current = wantSel;
  }, [wantSel]);

  const pickTool = (family: "core" | "shape" | "select", id: string) => {
    SESSION.setTool(id as never);
    if (family === "shape") SESSION.setCurrentShape(id as never);
    else if (family === "select") SESSION.setCurrentSelect(id as never);
    setOpen(false);
    setSub(null);
    if (sel && !pcMode) setSel({ ...sel, open: false });
  };

  /** close the canvas ring (its items all dismiss it before acting) */
  const closeCanv = () => { setCanv((g) => (g ? { ...g, open: false } : g)); setCanvSub(null); };

  const closeRadials = () => {
    const L = ringLockRef.current;
    if (!L.main) { setOpen(false); setSub(null); }          // 锁定的球忽略外部点击
    if (sel && !L.sel) setSel({ ...sel, open: false });
    if (pal && !L.pal) setPal({ ...pal, open: false });
    if (!L.fx) setFx((g) => (g ? { ...g, open: false } : g));
    if (!L.canv) closeCanv();
  };

  // PC 模式没有「点空白处收球」的遮罩（那会拦住画布操作），所以 Esc 负责收球
  useEffect(() => {
    if (!pcMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const L = ringLockRef.current;
      let any = false;
      if (open && !L.main) { setOpen(false); setSub(null); any = true; }
      if (sel && sel.open && !L.sel) { setSel({ ...sel, open: false }); any = true; }
      if (pal.open && !L.pal) { setPal({ ...pal, open: false }); any = true; }
      if (fx.open && !L.fx) { setFx({ ...fx, open: false }); any = true; }
      if (canv.open && !L.canv) { setCanv({ ...canv, open: false }); setCanvSub(null); any = true; }
      if (any) e.preventDefault();     // 收球优先于「取消选区」
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pcMode, open, sel, pal, fx, canv]);

  const separate = (m: { x: number; y: number }, o: { x: number; y: number } | null) => {
    if (!o) return m;
    let dx = m.x - o.x, dy = m.y - o.y;
    const d = Math.hypot(dx, dy);
    if (d >= MINC) return m;
    if (d < 1) { dx = MINC; dy = 0; } else { dx = (dx / d) * MINC; dy = (dy / d) * MINC; }
    return clampXY({ x: o.x + dx, y: o.y + dy });
  };

  /** ring clearance: keep the other ball outside the outer radial ring (R2 ~128px) */
  const RING_CLEAR = 166;
  const clearRingOf = (anchor: { x: number; y: number }, other: { x: number; y: number } | null) => {
    if (!other) return other;
    let dx = other.x - anchor.x, dy = other.y - anchor.y;
    const d = Math.hypot(dx, dy) || 1;
    if (d >= RING_CLEAR) return other;
    return clampXY({ x: anchor.x + (dx / d) * RING_CLEAR, y: anchor.y + (dy / d) * RING_CLEAR });
  };

  const moveBall = (which: OrbId, nx: number, ny: number) => {
    // drop exactly where the finger is: no auto repulsion from other orbs
    const p = clampXY({ x: nx, y: ny });
    if (which === "main") {
      setPos(p);
      try { localStorage.setItem(orbKey, JSON.stringify(p)); } catch { /* ignore */ }
    } else if (which === "sel") {
      // ⑤ PC 模式拖动一个球不再收起它自己/别人的环
      setSel((g) => (g ? { ...g, x: p.x, y: p.y, open: pcMode ? g.open : false } : g));
    } else if (which === "pal") {
      setPal((g) => ({ ...g, x: p.x, y: p.y, open: pcMode ? g.open : false }));
    } else if (which === "canv") {
      setCanv((g) => ({ ...g, x: p.x, y: p.y, open: pcMode ? g.open : false }));
    } else {
      setFx((g) => ({ ...g, x: p.x, y: p.y, open: pcMode ? g.open : false }));
    }
    if (!pcMode) {
      setOpen(false);
      setSub(null);
      if (sel && which !== "sel") setSel((s) => (s ? { ...s, open: false } : s));
      if (pal && which !== "pal") setPal((g) => (g ? { ...g, open: false } : g));
      if (which !== "fx") setFx((g) => (g ? { ...g, open: false } : g));
      if (which !== "canv") setCanv((g) => (g ? { ...g, open: false } : g));
    }
  };

  type Item = { icon: string; label: string; act: () => void; active?: boolean; desc?: string; guide?: string };

  // ---------- 装备槽 + 饼菜单（Blender 式，仅 PC）----------
  // 存储区边的槽里可以「装备」一个球；按住发动键（默认 F）时，这个球的所有
  // 子项会以圆环铺在屏幕中间并隐藏鼠标，鼠标指向哪一项就聚焦哪一项，
  // 松开按键激活聚焦项（中间是死区，松手即取消）。
  const pieKey = "pc.pie.ball";
  const loadPie = (): OrbId | null => {
    try {
      const v = localStorage.getItem(pieKey);
      return v === "main" || v === "sel" || v === "pal" || v === "fx" || v === "canv" ? v : null;
    } catch { return null; }
  };
  const [pieEquip, setPieEquip] = useState<OrbId | null>(loadPie);
  /** 拖动中的球是否正悬在装备槽上（松手即装备） */
  const slotRef = useRef<OrbId | null>(null);
  const [slotArmed, setSlotArmed] = useState(false);
  /** open pie: which ball's items are shown and which one the pointer focuses */
  const [pie, setPie] = useState<{ ball: OrbId; focus: number; cancelled: boolean } | null>(null);
  const pieRef = useRef<{ ball: OrbId; focus: number; cancelled: boolean } | null>(null);
  pieRef.current = pie;
  /** 最近一次鼠标位置：饼打开的那一瞬先用它决定聚焦项 */
  const lastMouse = useRef({ x: 0, y: 0 });
  useEffect(() => {
    try { if (pieEquip) localStorage.setItem(pieKey, pieEquip); else localStorage.removeItem(pieKey); } catch { /* ignore */ }
  }, [pieEquip]);
  const tipT = useRef<number | null>(null);
  const tipO = useRef<{ x: number; y: number } | null>(null);
  const stopTip = () => {
    if (tipT.current !== null) { window.clearTimeout(tipT.current); tipT.current = null; }
    hideTip();
  };
  const startTip = (title: string, desc?: string) => (e: React.PointerEvent) => {
    if (!title && !desc) return;
    e.preventDefault();
    stopTip();
    tipO.current = { x: e.clientX, y: e.clientY };
    tipT.current = window.setTimeout(() => { tipT.current = null; showTip({ title, desc }); }, 450);
  };
  const guardTip = (e: React.PointerEvent) => {
    if (tipT.current === null) return;
    const o = tipO.current;
    if (o && (Math.abs(e.clientX - o.x) > 10 || Math.abs(e.clientY - o.y) > 14)) stopTip();
  };
  const td = (id: string): string => {
    const z: Record<string, string> = { pencil: "铅笔：逐像素绘制", eraser: "橡皮：清除像素", bucket: "油漆桶：向同色连通区域填充当前色；底部栏可切换渐变模式（前景色→背景色，可选 RGB/2×2/4×4/8×8 颗粒）", picker: "取色器：吸取画布上的颜色", line: "直线", rect: "矩形描边", rectfill: "实心矩形", ellipse: "椭圆描边", ellipsefill: "实心椭圆", circle: "圆形：拖动绘制正圆", polygon: "多边形：可调边数（3–12）", polyline: "折线：点一下加一个点，点最后一个点结束（点倒数第二个可撤掉最后一个点）", curve: "曲线：点一下加一个点，用平滑样条串起来，点最后一个点结束", select: "矩形选区：拖拽框选区域", wand: "魔棒：按容差选中同色连通区域", lasso: "套索：自由手绘选区", outline: "轮廓填充：手绘闭合形状，松手后自动填充内部", airbrush: "喷枪：按住持续喷出随机大小像素点（底部栏可调点大小区间与密度）" };
    const en: Record<string, string> = { pencil: "Pencil: draw pixels", eraser: "Eraser: clear pixels", bucket: "Fill bucket: fill the same-colour region (bottom bar: gradient mode, FG->BG with RGB/2x2/4x4/8x8 steps)", picker: "Eyedropper: pick a colour", line: "Line", rect: "Rect outline", rectfill: "Filled rect", ellipse: "Ellipse outline", ellipsefill: "Filled ellipse", circle: "Circle: drag to draw a perfect circle", polygon: "Polygon: adjustable sides (3–12)", polyline: "Polyline: tap to add points, tap the last point to finish (tap the point before it to undo one)", curve: "Curve: tap to add points, a smooth spline runs through them; tap the last point to finish", select: "Rect selection: drag to select", wand: "Magic wand: select same-colour area", lasso: "Lasso: freehand selection", outline: "Outline fill: draw a closed shape, it fills itself on release", airbrush: "Airbrush: hold to spray random-size specks (dot-size range & rate in the bottom bar)" };
    return (snap.lang === "zh" ? z : en)[id] ?? "";
  };

  const li = snap.layerIdx, fi = snap.frameIdx;
  const d = SESSION.doc;
  const repaintChanged = () => { SESSION.repaint(); SESSION.changedUI(); };
  // ⑥ 手机端：选区球分两页（常用在前，其余在「更多」里），PC 模式一次全铺开
  const [selSub, setSelSub] = useState<null | "more">(null);
  const selPage1: Item[] = [
    { icon: "i-sel-all", label: t("sel.all"), act: () => { selOps.selOps.selectAll(d); SESSION.repaint(); } },
    { icon: "i-sel-invert", label: t("sel.invert"), act: () => SESSION.maskOp("sel.invert", () => selOps.selOps.invert(d)) },
    { icon: "i-sel-none", label: t("sel.clear"), act: () => { selOps.selOps.clear(d); SESSION.repaint(); } },
    { icon: "i-bucket", label: t("sel.fill"), act: () => { if (!(d.sel && d.sel.hasAny())) { bridge.toast(t("noSel")); return; } selOps.selOps.fill(d, SESSION.history, li, fi, SESSION.color); repaintChanged(); } },
    // ⑧ 电脑模式有 Ctrl+C / Ctrl+X / Ctrl+V，球里不再重复这三个按钮；
    //    手机端保留，并且把「粘贴为新图层 / 新画布」也放进来（⑮）
    ...(pcMode ? [] : [
      { icon: "i-dupe", label: t("sel.copy"), act: () => { const c = selOps.selOps.copy(d, li, fi); SESSION.clip = c; if (c) void writeClipboardPng(compositor.celToCanvas(c)).then((ok) => bridge.toast(ok ? t("sysCopy") : t("copied"))); } },
      { icon: "i-cut", label: t("sel.cut"), act: () => { const c = selOps.selOps.cut(d, SESSION.history, li, fi); SESSION.clip = c; if (c) { repaintChanged(); void writeClipboardPng(compositor.celToCanvas(c)).then((ok) => bridge.toast(ok ? t("sysCopy") : t("cut"))); } } },
      { icon: "i-paste", label: t("sel.paste"), act: () => { if (SESSION.clip) { selOps.selOps.paste(d, SESSION.history, li, fi, SESSION.clip); repaintChanged(); bridge.toast(t("pasted")); } else bridge.toast(t("noSel")); } },
      { icon: "i-paste-layer", label: t("pasteAsLayerBall"), desc: t("pasteAsLayerBallDesc"), act: () => { void pasteClipboard("layer"); } },
      { icon: "i-paste-canvas", label: t("pasteAsCanvasBall"), desc: t("pasteAsCanvasBallDesc"), act: () => { void pasteClipboard("canvas"); } },
    ]),
  ];
  const selPage2: Item[] = [
    { icon: "", label: "\u2039", act: () => setSelSub(null), guide: "sel-back" },
    { icon: "i-fliph", label: t("sel.fliph"), act: () => { selOps.selOps.flip(d, SESSION.history, li, fi, true); repaintChanged(); } },
    { icon: "i-flipv", label: t("sel.flipv"), act: () => { selOps.selOps.flip(d, SESSION.history, li, fi, false); repaintChanged(); } },
    { icon: "i-sel-grow", label: t("sel.grow"), act: () => SESSION.maskOp("sel.grow", () => selOps.growSelection(d, 1)) },
    { icon: "i-sel-shrink", label: t("sel.shrink"), act: () => SESSION.maskOp("sel.shrink", () => selOps.shrinkSelection(d, 1)) },
    { icon: "i-fx-o1", label: t("sel.outline"), act: () => { selOps.outlineSelected(d, SESSION.history, li, fi, SESSION.color); repaintChanged(); } },
    { icon: "i-fx-crop", label: t("selCrop"), desc: t("selCropDesc"), act: () => { if (SESSION.cropToSelection()) repaintChanged(); } },
    { icon: "i-sel-del", label: t("sel.delete"), act: () => { SESSION.deleteSelection(); } },
    ...(pcMode ? [] : [{
      icon: "i-more", label: t("canvasMore"),
      desc: snap.lang === "zh" ? "更多：翻转 / 扩展 / 收缩 / 描边 / 裁切到选区 / 删除" : "More: flip / grow / shrink / outline / crop / delete",
      act: () => setSelSub("more"), guide: "sel-more",
    }]),
  ];
  const selItems: Item[] = pcMode || selSub === "more"
    ? [...selPage1.filter((it) => it.guide !== "sel-more"), ...selPage2.filter((it) => it.guide !== "sel-back")]
    : selPage1;

  // ---- parameterised FX: live preview on a snapshot, one history step on OK
  const [fxDlg, setFxDlg] = useState<{ run: FxRun; vals: FxVals } | null>(null);
  const fxOrig = useRef<{ li: number; fi: number; before: Uint8ClampedArray } | null>(null);
  const celHasPixels = (cel: { data: Uint8ClampedArray }): boolean => {
    for (let i = 3; i < cel.data.length; i += 4) if (cel.data[i] > 0) return true;
    return false;
  };
  /** re-run the effect from the pristine snapshot so previews never stack up */
  const fxPreview = (run: FxRun, vals: FxVals) => {
    const o = fxOrig.current;
    if (!o) return;
    const cel = d.celAt(o.li, o.fi);
    if (!cel) return;
    cel.data.set(o.before);
    run.apply(cel.data, d.w, d.h, vals);
    SESSION.repaint();
    SESSION.changedUI();
  };
  const openFx = (run: FxRun) => {
    const cel = d.celAt(li, fi);
    if (!cel || !celHasPixels(cel)) { bridge.toast(t("noContent")); return; }
    fxOrig.current = { li, fi, before: new Uint8ClampedArray(cel.data) };
    const vals = fxDefaults(run);
    setFxDlg({ run, vals });
    fxPreview(run, vals);
  };
  const fxChange = (key: string, v: number | string) => {
    const g = fxDlg;
    if (!g) return;
    const vals = { ...g.vals, [key]: v };
    setFxDlg({ ...g, vals });
    fxPreview(g.run, vals);
  };
  const fxCance = () => {
    SESSION.cancelColorPick();
    const o = fxOrig.current;
    fxOrig.current = null;
    setFxDlg(null);
    if (!o) return;
    const cel = d.celAt(o.li, o.fi);
    if (cel) cel.data.set(o.before);
    SESSION.repaint();
    SESSION.changedUI();
  };
  const fxApplyDlg = () => {
    SESSION.cancelColorPick();
    const g = fxDlg, o = fxOrig.current;
    fxOrig.current = null;
    setFxDlg(null);
    if (!g || !o) return;
    // effects that need their own commit path (new-layer shadow) handle it here
    if (g.run.commit) {
      g.run.commit(d, o.li, o.fi, o.before, g.vals);
      return;
    }
    const cel = d.celAt(o.li, o.fi);
    if (!cel) return;
    let changed = false;
    for (let i = 0; i < o.before.length; i++) if (o.before[i] !== cel.data[i]) { changed = true; break; }
    if (!changed) { SESSION.repaint(); SESSION.changedUI(); return; }
    SESSION.history.pushPixels(g.run.label, d, [{ li: o.li, fi: o.fi, before: o.before, after: new Uint8ClampedArray(cel.data) }]);
    SESSION.repaint();
    SESSION.changedUI();
  };
  const hexOf = (c: [number, number, number, number]): string => rgbaToHex(c).slice(0, 7);

  const fxZh = snap.lang === "zh";
  const fxDo = (label: string, fn: (data: Uint8ClampedArray, w: number, h: number) => void) => {
    const cel = d.celAt(li, fi);
    if (!cel) { bridge.toast(t("noContent")); return; }
    let has = false;
    for (let i = 3; i < cel.data.length; i += 4) if (cel.data[i] > 0) { has = true; break; }
    if (!has) { bridge.toast(t("noContent")); return; }
    const before = new Uint8ClampedArray(cel.data);
    fn(cel.data, d.w, d.h);
    let changed = false;
    for (let i = 0; i < before.length; i++) if (before[i] !== cel.data[i]) { changed = true; break; }
    if (!changed) return;
    SESSION.history.pushPixels(label, d, [{ li, fi, before, after: new Uint8ClampedArray(cel.data) }]);
    repaintChanged();
  };
  const fxI = (key: string, icon: string, labelZh: string, labelEn: string, descZh: string, descEn: string, act: () => void, active = false): Item => ({
    icon, label: fxZh ? labelZh : labelEn, desc: fxZh ? descZh : descEn, act, ...(active ? { active: true } : {}),
  });
  const fxItems: Item[] = [
    fxI("o1", "i-fx-o1", "描边", "Edge", "描边样式：宽度 / 位置（内·外·居中）/ 颜色，弹窗实时预览", "Outline style: width / position (outside, inside, center) / colour, live preview", () => openFx({
      label: "fx-outline", title: "fxOutlineTitle", desc: "fxOutlineDesc",
      params: [
        { key: "w", kind: "int", label: "fxOutlineWidth", min: 1, max: 16, unit: "px", def: 1 },
        { key: "pos", kind: "enum", label: "fxOutlinePos", def: "outside", options: [
          { value: "outside", label: "fxOutlineOutside" }, { value: "inside", label: "fxOutlineInside" }, { value: "center", label: "fxOutlineCenter" }] },
        { key: "color", kind: "color", label: "fxOutlineColor", def: hexOf(SESSION.color) },
      ],
      apply: (dd, w, h, v) => fxE.outlineCel(dd, w, h, Number(v.w), hexToRgba(String(v.color)), v.pos as fxE.OutlinePos),
    })),
    fxI("blur", "i-fx-blur", "模糊", "Blur", "模糊滤镜：弹窗设置半径，可实时预览", "Blur filter: set the radius in a dialog, live preview", () => openFx({
      label: "fx-blur", title: "fxBlurTitle", desc: "fxBlurDesc",
      params: [{ key: "r", kind: "int", label: "fxBlurRadius", min: 1, max: 32, unit: "px", def: 2 }],
      apply: (dd, w, h, v) => fxE.blurCel(dd, w, h, Number(v.r)),
    })),
    fxI("crop", "i-fx-crop", "智能裁剪", "Crop", "自动裁剪画布四周空白（全部图层/帧）", "Auto-crop empty canvas borders (all layers/frames)", () => SESSION.cropSmart()),
    fxI("shadow", "i-fx-shadow", "投影", "Shadow", "投影参数：偏移 x/y、颜色与不透明度，弹窗实时预览", "Drop shadow: offset x/y, colour and opacity, live preview", () => openFx({
      label: "fx-shadow", title: "fxShadowTitle", desc: "fxShadowDesc",
      params: [
        { key: "dx", kind: "int", label: "fxShadowX", min: -64, max: 64, unit: "px", def: 3 },
        { key: "dy", kind: "int", label: "fxShadowY", min: -64, max: 64, unit: "px", def: 3 },
        { key: "color", kind: "color", label: "fxShadowColor", def: "#000000" },
        { key: "alpha", kind: "int", label: "fxShadowAlpha", min: 0, max: 100, unit: "%", def: 59 },
      ],
      apply: (dd, w, h, v) => {
        const c = hexToRgba(String(v.color));
        fxE.dropShadowCel(dd, w, h, Number(v.dx), Number(v.dy), [c[0], c[1], c[2], Math.round((Number(v.alpha) / 100) * 255)], true);
      },
      // the live preview always shows the baked version; "new shadow layer"
      // (Settings > display) is applied for real when the user confirms
      commit: (doc, li, fi, before, v) => {
        const cel = doc.celAt(li, fi);
        if (cel) cel.data.set(before); // undo the preview first
        const c = hexToRgba(String(v.color));
        return SESSION.applyShadowParams(Number(v.dx), Number(v.dy),
          [c[0], c[1], c[2], Math.round((Number(v.alpha) / 100) * 255)], SESSION.prefs.shadowNewLayer);
      },
    })),
    fxI("clear", "i-clear", "清空画布", "Clear", "清空当前帧所有图层的画布内容", "Empty the current frame on all layers", () => SESSION.clearCanvas()),
    fxI("glow", "i-fx-glow", "外发光", "Glow", "一键外发光：用当前颜色向外发光 2px 并逐层淡出", "Outer glow: current colour fading outwards 2px", () => {
      const base = SESSION.color;
      fxDo("fx-glow", (dd, w, h) => fxE.outerGlowCel(dd, w, h, 2, [base[0], base[1], base[2], 255]));
    }),
    fxI("inv", "i-fx-inv", "反色", "Inv", "反色：把不透明像素的 RGB 取反（保留透明）", "Invert RGB of visible pixels", () => fxDo("fx-invert", (dd) => fxE.invertCel(dd))),
    fxI("gray", "i-fx-gray", "灰度", "B/W", "去饱和：把不透明像素变为灰度", "Desaturate visible pixels to grayscale", () => fxDo("fx-gray", (dd) => fxE.desaturateCel(dd))),
    fxI("ctr", "i-fx-ctr", "居中", "Ctr", "把当前图层内容居中到画布中心（有选区时居中到选区）", "Center the layer content in the canvas (or inside the selection when one is active)", () => fxDo("fx-center", (data, w, h) => {
      const tgt = (d.sel && d.sel.hasAny() ? d.sel.bounds() : null) ?? { x: 0, y: 0, w: d.w, h: d.h };
      let minX = w, minY = h, maxX = -1, maxY = -1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (data[(y * w + x) * 4 + 3] !== 0) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) return; // nothing opaque to move
      const cw = maxX - minX + 1, ch = maxY - minY + 1;
      // an axis is only centred when the content fits inside the target;
      // otherwise it stays put so nothing is ever clipped or lost
      const dx = cw <= tgt.w ? tgt.x + Math.floor((tgt.w - cw) / 2) - minX : 0;
      const dy = ch <= tgt.h ? tgt.y + Math.floor((tgt.h - ch) / 2) - minY : 0;
      if (dx === 0 && dy === 0) return;
      const out = new Uint8ClampedArray(data.length);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          if (data[i + 3] === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
            const j = (ny * w + nx) * 4;
            out[j] = data[i]; out[j + 1] = data[i + 1]; out[j + 2] = data[i + 2]; out[j + 3] = data[i + 3];
          }
        }
      }
      data.set(out);
    })),
  ];

  // canvas orb: everything that acts on the FOCUSED canvas. Page 1 = the
  // everyday actions, page 2 ("more") = preview / colour adjust / export /
  // fit / tiling, so the ring never gets crowded.
  // page 1 = everyday actions, page 2 = the rest; PC mode lays BOTH out at once
  const canvPage2: Item[] = [
    { icon: "", label: "\u2039", act: () => setCanvSub(null), guide: "canv-back" },
    { icon: "i-adjust", label: t("adjust"), desc: t("canvasAdjustDesc"), act: () => { closeCanv(); onCanvasAdjust(); } },
    { icon: "i-export", label: t("export"), desc: t("canvasExportDesc"), act: () => { closeCanv(); onCanvasExport(); }, guide: "canv-export" },
    { icon: "i-grid", label: t("canvasTile"), desc: t("canvasTileDesc"), act: () => { setCanv({ ...canv, open: false }); setCanvSub(null); setTileDlg(true); }, guide: "canv-tile" },
    { icon: "i-rotate", label: t("canvasRotate"), desc: t("canvasRotateDesc"), act: () => { closeCanv(); SESSION.rotateCanvasContent(1); }, guide: "canv-rotate" },
    { icon: "i-ref", label: t("canvasRef"), desc: t("canvasRefDesc"), act: () => { closeCanv(); onCanvasRef(); }, guide: "canv-ref" },
    ...(SESSION.doc.layers.some((l) => !!l.ref)
      ? [{ icon: "i-unlink", label: t("refAllRelease"), desc: t("refAllReleaseDesc"), act: () => { closeCanv(); SESSION.unrefAll(); } }]
      : []),
    { icon: "i-extract", label: t("layerExtract"), desc: t("layerExtractDesc"), act: () => { closeCanv(); void SESSION.extractLayerToCanvas(); }, guide: "canv-extract" },
  ];
  const canvPage1: Item[] = [
    { icon: "i-plus", label: t("canvasNew"), desc: t("canvasNewDesc"), act: () => { closeCanv(); onCanvasNew(); } },
    { icon: "i-rename", label: t("canvasRename"), desc: t("canvasRenameDesc"), act: () => {
      closeCanv();
      void (async () => {
        const i = SESSION.docIdx;
        const v = await SESSION.askText({ title: t("canvasRename"), value: SESSION.doc.name, ok: t("ok"), cancel: t("cancel") });
        if (v !== null) SESSION.renameCanvas(i, v);
      })();
    } },
    { icon: "i-size", label: t("resizeTitle"), desc: t("canvasResizeDesc"), act: () => { closeCanv(); onCanvasSize(); } },
    { icon: "i-resize-mode", label: t("canvasResizeMode"), desc: t("canvasResizeModeDesc"), active: SESSION.resizeModeOn, act: () => { closeCanv(); SESSION.toggleResizeMode(); } },
    { icon: SESSION.isCanvasLocked() ? "i-pin" : "i-pin-off", label: t(SESSION.isCanvasLocked() ? "canvasUnlock" : "canvasLock"), desc: t("canvasLockDesc"), act: () => { closeCanv(); SESSION.toggleCanvasLock(); }, guide: "canv-lock" },
    { icon: "i-x", label: t("canvasClose"), desc: t("canvasCloseDesc"), act: () => {
      closeCanv();
      void (async () => {
        const i = SESSION.docIdx;
        const name = SESSION.doc.name || "untitled";
        const ok = await SESSION.askConfirm({ msg: t("canvasCloseAsk") + " " + name + t("canvasCloseAsk2"), yes: t("ok"), no: t("cancel") });
        if (ok) SESSION.closeCanvas(i);
      })();
    } },
    { icon: "i-more", label: t("canvasMore"), desc: t("canvasMoreDesc"), act: () => setCanvSub("more"), guide: "canv-more" },
  ];
  // PC：鼠标点两下比翻页快，直接把两页铺成一个大环（去掉「返回」项）
  const canvItems: Item[] = pcMode
    ? [...canvPage1.filter((it) => it.guide !== "canv-more"), ...canvPage2.filter((it) => it.guide !== "canv-back")]
    : canvSub === "more" ? canvPage2 : canvPage1;

  const mainItems: Item[] = sub
    ? [
        { icon: "", label: "\u2039", act: () => setSub(null), guide: "tool-back" },
        ...(sub === "shape" ? SHAPE_TOOLS : SELECT_TOOLS).map((dd) => ({ icon: dd.icon, label: t("tools." + dd.id), desc: td(dd.id), act: () => pickTool(sub, dd.id), active: snap.tool === dd.id, guide: "tool-" + dd.id })),
      ]
    : [
        ...CORE_TOOLS.map((dd) => ({ icon: dd.icon, label: t("tools." + dd.id), desc: td(dd.id), act: () => pickTool("core", dd.id), active: snap.tool === dd.id, guide: "tool-" + dd.id })),
        // ③ PC：鼠标没有“翻页”的耐心——把「图形 / 选区」两页的工具直接铺进同一个环
        ...(pcMode ? [
          ...SHAPE_TOOLS.map((dd) => ({ icon: dd.icon, label: t("tools." + dd.id), desc: td(dd.id), act: () => pickTool("shape", dd.id), active: snap.tool === dd.id, guide: "tool-" + dd.id })),
          ...SELECT_TOOLS.map((dd) => ({ icon: dd.icon, label: t("tools." + dd.id), desc: td(dd.id), act: () => pickTool("select", dd.id), active: snap.tool === dd.id, guide: "tool-" + dd.id })),
        ] : []),
        ...(pcMode ? [] : [
        { icon: defOf(snap.shape)?.icon || "i-rect", label: t("shapeGroup"), desc: snap.lang === "zh" ? "图形工具：直线 / 矩形 / 椭圆" : "Shape tools: line / rect / ellipse", act: () => { setSub("shape"); if (sel && !pcMode) setSel({ ...sel, open: false }); }, active: isShapeTool(snap.tool), guide: "tool-shape-group" },
        { icon: (snap.tool !== "line" && isSelectTool(snap.tool) ? defOf(snap.tool)?.icon : defOf(SESSION.currentSelect)?.icon) || "i-select", label: t("sel.active"), desc: snap.lang === "zh" ? "选区工具：框选 / 魔棒 / 套索" : "Select tools: rect / wand / lasso", act: () => { setSub("select"); if (sel && !pcMode) setSel({ ...sel, open: false }); }, active: isSelectTool(snap.tool), guide: "tool-select-group" },
        ]),
      ];

  const baseIcon =
    (isShapeTool(snap.tool) ? defOf(snap.shape)?.icon
      : isSelectTool(snap.tool) ? defOf(snap.tool)?.icon
      : defOf(snap.tool)?.icon) || "i-pencil";

  /** 饼菜单里显示哪些项：就是被装备那个球的子项（PC 模式已经全部铺开的版本） */
  const pieItemsFor = (ball: OrbId): Item[] => {
    if (ball === "main") return mainItems.filter((it) => !it.guide || (it.guide !== "tool-back" && it.guide !== "tool-shape-group" && it.guide !== "tool-select-group"));
    if (ball === "sel") return selItems;
    if (ball === "fx") return fxItems;
    if (ball === "canv") return canvItems.filter((it) => it.guide !== "canv-back");
    return [];
  };

  /** 展开后的落点：由 ringLayout 算出，保证同环/跨环都不重叠（PC 球更大时半径自动扩容） */
  const ringSlots = (p0: { x: number; y: number }, n: number) => {
    const cx = p0.x + ORB / 2, cy = p0.y + ORB / 2;
    const dx = window.innerWidth - cx >= cx ? 1 : -1;
    const dy = window.innerHeight - cy >= cy ? 1 : -1;
    const deg = dx === 1 && dy === 1 ? [-6, 84] : dx === 1 && dy === -1 ? [-84, 6] : dx === -1 && dy === -1 ? [174, 264] : [96, 186];
    // ringLayout 在「0..span」上排布，再按象限旋转到实际方向
    const base = ringLayout({
      count: n, cx: 0, cy: 0, spanDeg: deg[1] - deg[0],
      r1: M.r1, r2: M.r2, item: M.item, gap: 8,
    });
    const rot = (deg[0] * Math.PI) / 180;
    return base.map((pt) => ({
      x: cx + pt.x * Math.cos(rot) - pt.y * Math.sin(rot),
      y: cy + pt.x * Math.sin(rot) + pt.y * Math.cos(rot),
    }));
  };
  const ringAt = (p0: { x: number; y: number }, i: number, n: number) => ringSlots(p0, n)[i] ?? { x: p0.x, y: p0.y };

  // ---------- 饼菜单：按住发动键 → 圆环布置 → 松手激活 ----------
  /** 被装备球在饼里的条目（色板球是「颜色」，单独处理） */
  const pieEntries = (ball: OrbId): Item[] => pieItemsFor(ball);
  const pieColours = (ball: OrbId): Array<[number, number, number, number]> =>
    ball === "pal" ? SESSION.palOrbColors().slice(0, 24) : [];
  const pieCount = (ball: OrbId): number => (ball === "pal" ? pieColours(ball).length : pieEntries(ball).length);

  // 按住发动键期间：跟随鼠标方向聚焦；松开时执行；Esc 取消
  useEffect(() => {
    if (!pcMode) return;
    const isTyping = (t: EventTarget | null): boolean => {
      const el = t as HTMLElement | null;
      return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    };
    /** 圆盘半径：设置了就用设置值，否则按屏幕与子球数量自动适配 */
    const radiusFor = (count: number): number => {
      const n = Math.max(1, count);
      const custom = SESSION.prefs.pieRadius;
      return custom > 0 ? custom : pieRadiusFor(window.innerWidth, window.innerHeight, n, SESSION.prefs.pieItem);
    };
    const focusAt = (x: number, y: number, ball: OrbId): number => {
      const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
      return pieFocusIndex(x, y, cx, cy, Math.max(1, pieCount(ball)), radiusFor(pieCount(ball)));
    };
    const launchChord = () => chordForAction("pieLaunch", SESSION.prefs.keymap) ?? "f";
    const isLaunch = (e: KeyboardEvent): boolean => chordOf({
      key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey,
    }) === launchChord();
    const onDown = (e: KeyboardEvent) => {
      const open = pieRef.current;
      if (open) {
        // 饼打开时吞掉其它按键，别让工具键/快捷键在背后生效
        if (!isLaunch(e)) e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setPie({ ...open, cancelled: true, focus: -1 });
        }
        return;
      }
      if (!isLaunch(e)) return;
      if (isTyping(e.target)) return;
      if (!pieEquip) {
        bridge.toast(t("pieNeedEquip"));
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      setPie({ ball: pieEquip, focus: -1, cancelled: false });
      // 让指针当前位置立刻决定聚焦项（不必先动一下鼠标）
      setPie((g) => (g ? { ...g, focus: focusAt(lastMouse.current.x, lastMouse.current.y, g.ball) } : g));
    };
    const onUp = (e: KeyboardEvent) => {
      const open = pieRef.current;
      if (!open || !isLaunch(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setPie(null);
      if (open.cancelled) return;
      const i = open.focus;
      if (i < 0) return;
      const ball = open.ball;
      if (ball === "pal") {
        const cols = pieColours(ball);
        const c = cols[Math.min(i, cols.length - 1)];
        if (c) { SESSION.setFgColor([c[0], c[1], c[2], 255]); SESSION.hapticTick("饼菜单", 0.7); }
        return;
      }
      const list = pieEntries(ball);
      const it = list[Math.min(i, list.length - 1)];
      if (it) { SESSION.hapticTick("饼菜单", 0.7); it.act(); }
    };
    const onMove = (e: MouseEvent) => {
      lastMouse.current = { x: e.clientX, y: e.clientY };
      const open = pieRef.current;
      if (!open) return;
      const i = focusAt(e.clientX, e.clientY, open.ball);
      if (i !== open.focus) setPie({ ...open, focus: i });
    };
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    window.addEventListener("mousemove", onMove, true);
    return () => {
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", onUp, true);
      window.removeEventListener("mousemove", onMove, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pcMode, pieEquip, pieItemsFor]);

  const renderBall = (
    which: OrbId,
    p: { x: number; y: number },
    icon: string,
    isOpen: boolean,
    title: string,
    tipDesc: string,
    tap: () => void,
  ) => (
    <button
      key={which}
      className={"orb" + (isOpen ? " open" : "") + (which !== "main" ? " sub" : "")}
      style={{ left: p.x, top: p.y }}
      data-guide={"orb-" + which}
      title={title}
      onPointerDown={(e) => {
        e.preventDefault();
        startTip(title, tipDesc)(e);
        drag.current = { which, dx: e.clientX - p.x, dy: e.clientY - p.y, moved: false };
        // ⑬ 鼠标移动比触摸快得多，元素级 pointermove 会在光标离开球体时丢事件：
        //    捕获指针并把 move/up 挂到 window，快速甩动也不会掉出拖动状态
        try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
        const onWinMove = (ev: PointerEvent) => {
          const dr = drag.current;
          if (!dr || dr.which !== which || ev.pointerId !== e.pointerId) return;
          if (Math.abs(ev.clientX - p.x - dr.dx) > 4 || Math.abs(ev.clientY - p.y - dr.dy) > 4) dr.moved = true;
          if (!dr.moved) return;
          stopTip();
          moveBall(which, ev.clientX - dr.dx, ev.clientY - dr.dy);
          const near = inDockZone(ev.clientX, ev.clientY);
          const onSlot = overPieSlot(ev.clientX, ev.clientY);
          const parked = !onSlot && overDockPanel(ev.clientX, ev.clientY);
          slotRef.current = onSlot ? which : null;
          parkRef.current = parked ? ({ id: which as never }) : null;
          if (near) { dockClear(); setDockOpen(true); }
          setDockArmed(parked);
          setSlotArmed(onSlot);
        };
        const detach = () => {
          window.removeEventListener("pointermove", onWinMove);
          window.removeEventListener("pointerup", detach);
          window.removeEventListener("pointercancel", detach);
        };
        window.addEventListener("pointermove", onWinMove);
        window.addEventListener("pointerup", detach);
        window.addEventListener("pointercancel", detach);
      }}
      onPointerMove={(e) => { guardTip(e); }}
      onPointerUp={() => {
        stopTip();
        setDockArmed(false);
        const dr = drag.current;
        if (dr && dr.which === which) {
          // 拖到装备槽上松手＝把这个球装进去（而不是停靠进存储区）
          if (slotRef.current === which) {
            slotRef.current = null;
            setSlotArmed(false);
            parkRef.current = null;
            drag.current = null;
            equipBall(which);
            return;
          }
          if (parkRef.current && (parkRef.current.id as string) === (which as string)) {
            parkRef.current = null;
            park(which as never);
            drag.current = null;
            return;
          }
          if (!dr.moved) tap();
          else if (dockOpen) dockCollapse(260);
          drag.current = null;
        }
      }}
      onPointerCancel={() => {
        stopTip();
        setDockArmed(false);
        if (drag.current && drag.current.which === which) drag.current = null;
      }}
    >
      <Icon id={icon} size={20} />
    </button>
  );

  const ring = (p0: { x: number; y: number }, items: Item[]) => (
    <div className="radial-layer">
      {items.map((it, i) => {
        const pt = ringAt(p0, i, items.length);
        return (
          <button
            key={it.label + i}
            data-guide={it.guide}
            className={"orb-item" + (it.active ? " on" : "")}
            style={{ left: pt.x, top: pt.y, "--st": (i * 16) + "ms" } as unknown as React.CSSProperties}
            title={it.desc || it.label}
            onClick={it.act}
            onPointerDown={startTip(it.label, it.desc)}
            onPointerMove={guardTip}
            onPointerUp={stopTip}
            onPointerCancel={stopTip}
            onContextMenu={(e) => e.preventDefault()}
          >
            {it.icon ? <Icon id={it.icon} size={16} /> : <span style={{ fontSize: 16, fontWeight: 800 }}>{it.label}</span>}
          </button>
        );
      })}
    </div>
  );

  return (
    <>
      {!hiddenById("main") && renderBall("main", pos, baseIcon, open, t("menu"), bd(snap.lang, "orb"), () => {
        if (open) { setOpen(false); setSub(null); setRingLock((m) => ({ ...m, main: false })); return; }
        if (sel) {
          const pushed = clearRingOf(pos, { x: sel.x, y: sel.y });
          if (pushed) setSel({ ...pushed, open: pcMode ? sel.open : false });
        }
        if (pal) {
          const pushed2 = clearRingOf(pos, { x: pal.x, y: pal.y });
          if (pushed2) setPal({ ...pushed2, open: pcMode ? pal.open : false });
        }
        if (fx) {
          const pushed3 = clearRingOf(pos, { x: fx.x, y: fx.y });
          if (pushed3) setFx({ ...pushed3, open: pcMode ? fx.open : false });
        }
        SESSION.hapticTick("工具栏", 0.7);
        setOpen(true);
      })}
      <Keep on={!!sel && pieEquip !== "sel"} el={sel ? renderBall("sel", { x: sel.x, y: sel.y }, "i-select", sel.open, t("sel.active"), bd(snap.lang, "selBall"), () => {
        if (!pcMode) { setOpen(false); setSub(null); }
        if (!sel.open && !lockOf("main")) {   // ② 锁定的球不被别人挤走
          const np = clearRingOf({ x: sel.x, y: sel.y }, pos);
          if (np && (np.x !== pos.x || np.y !== pos.y)) {
            setPos(np);
            try { localStorage.setItem(orbKey, JSON.stringify(np)); } catch { /* ignore */ }
          }
          if (pal) {
            const pp = clearRingOf({ x: sel.x, y: sel.y }, { x: pal.x, y: pal.y });
            if (pp) setPal({ ...pp, open: pcMode ? pal.open : false });
          }
          if (fx) {
            const fp = clearRingOf({ x: sel.x, y: sel.y }, { x: fx.x, y: fx.y });
            if (fp) setFx({ ...fp, open: pcMode ? fx.open : false });
          }
        }
        setSel({ ...sel, open: !sel.open });
      }) : null} />
      {!hiddenById("pal") && renderBall("pal", { x: pal.x, y: pal.y }, "i-palette", pal.open, t("palette"), bd(snap.lang, "palette"), () => {
        if (!pcMode) { setOpen(false); setSub(null); setSel((g) => (g ? { ...g, open: false } : g)); }
        if (!pal.open && !lockOf("main")) {
          const np = clearRingOf({ x: pal.x, y: pal.y }, pos);
          if (np && (np.x !== pos.x || np.y !== pos.y)) {
            setPos(np);
            try { localStorage.setItem(orbKey, JSON.stringify(np)); } catch { /* ignore */ }
          }
          if (sel) {
            const sp = clearRingOf({ x: pal.x, y: pal.y }, { x: sel.x, y: sel.y });
            if (sp) setSel({ ...sp, open: pcMode ? sel.open : false });
          }
          if (fx) {
            const fp = clearRingOf({ x: pal.x, y: pal.y }, { x: fx.x, y: fx.y });
            if (fp) setFx({ ...fp, open: pcMode ? fx.open : false });
          }
        }
        setPal({ ...pal, open: !pal.open });
      })}
      {!hiddenById("fx") && renderBall("fx", { x: fx.x, y: fx.y }, "i-star", fx.open, t("fxOrb"), bd(snap.lang, "fx"), () => {
        if (!pcMode) {
          setOpen(false);
          setSub(null);
          if (sel) setSel({ ...sel, open: false });
          if (pal) setPal({ ...pal, open: false });
        }
        if (!fx.open && !lockOf("main")) {
          const np = clearRingOf({ x: fx.x, y: fx.y }, pos);
          if (np && (np.x !== pos.x || np.y !== pos.y)) {
            setPos(np);
            try { localStorage.setItem(orbKey, JSON.stringify(np)); } catch { /* ignore */ }
          }
          if (sel) {
            const sp = clearRingOf({ x: fx.x, y: fx.y }, { x: sel.x, y: sel.y });
            if (sp) setSel({ ...sp, open: pcMode ? sel.open : false });
          }
          if (pal) {
            const pp = clearRingOf({ x: fx.x, y: fx.y }, { x: pal.x, y: pal.y });
            if (pp) setPal({ ...pp, open: pcMode ? pal.open : false });
          }
        }
        setFx({ ...fx, open: !fx.open });
      })}
      {!hiddenById("canv") && renderBall("canv", { x: canv.x, y: canv.y }, "i-canvas", canv.open, t("canvasOrb"), bd(snap.lang, "canv"), () => {
        if (!pcMode) {
          setOpen(false);
          setSub(null);
          if (sel) setSel({ ...sel, open: false });
          if (pal) setPal({ ...pal, open: false });
          if (fx) setFx({ ...fx, open: false });
        }
        if (!canv.open && !lockOf("main")) {
          const np = clearRingOf({ x: canv.x, y: canv.y }, pos);
          if (np && (np.x !== pos.x || np.y !== pos.y)) {
            setPos(np);
            try { localStorage.setItem(orbKey, JSON.stringify(np)); } catch { /* ignore */ }
          }
          if (pal) {
            const pp = clearRingOf({ x: canv.x, y: canv.y }, { x: pal.x, y: pal.y });
            if (pp) setPal({ ...pp, open: pcMode ? pal.open : false });
          }
          if (fx) {
            const fp = clearRingOf({ x: canv.x, y: canv.y }, { x: fx.x, y: fx.y });
            if (fp) setFx({ ...fp, open: pcMode ? fx.open : false });
          }
        }
        setCanvSub(null);
        setCanv({ ...canv, open: !canv.open });
      })}
      {/* 装备槽：在存储区**边上**的独立一格；把一个浮动球拖进来就装备它（只装备一个）。
          点一下槽＝把球取出放回屏幕。按住 F 发动它的快捷圆盘。 */}
      {pcMode && (
        <div ref={pieSlotRef} className={"pie-slot" + (pieEquip ? " on" : "") + (slotArmed ? " armed" : "")}
          data-guide="pie-equip"
          title={pieEquip ? t("pieEquipDesc") + " · " + ballLabel(pieEquip) + "\n" + t("pieUnequipHint") : t("pieEquip")}
          onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onClick={() => {
            if (!pieEquip) { bridge.toast(t("pieEquipDrop")); return; }
            unequipBall({ x: window.innerWidth - 120, y: window.innerHeight / 2 });
          }}>
          {pieEquip ? <Icon id={iconOfBall(pieEquip as BallId)} size={16} /> : <span className="pie-slot-plus">+</span>}
          <span className="pie-slot-key">F</span>
        </div>
      )}

      {pie && (() => {
        const ball = pie.ball;
        const cols = pieColours(ball);
        const items = pieEntries(ball);
        const n = Math.max(1, ball === "pal" ? cols.length : items.length);
        const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
        const item = SESSION.prefs.pieItem;
        const custom = SESSION.prefs.pieRadius;
        const R = custom > 0 ? custom : pieRadiusFor(window.innerWidth, window.innerHeight, n, item);
        const slots = pieSlots(n, cx, cy, R);
        const foc = pie.focus;
        const label = foc >= 0
          ? (ball === "pal" ? rgbaToHex(cols[Math.min(foc, cols.length - 1)] ?? [0, 0, 0, 255]) : (items[Math.min(foc, items.length - 1)]?.label ?? ""))
          : "";
        return (
          <div className="pie-layer" data-guide="pie-layer"
            onContextMenu={(e) => e.preventDefault()}
            onPointerDown={(e) => e.preventDefault()}>
            {foc >= 0 && (
              <svg className="pie-line" width="100%" height="100%">
                <line x1={cx} y1={cy} x2={slots[foc]?.x} y2={slots[foc]?.y}
                  stroke="var(--accent)" strokeWidth="1.5" strokeDasharray="5 5" opacity="0.8" />
              </svg>
            )}
            {ball === "pal"
              ? cols.map((c, i) => {
                const p0 = slots[i];
                return (
                  <span key={"piec" + i}
                    className={"pie-item" + (i === foc ? " on" : "")}
                    style={{ left: p0.x, top: p0.y, width: item, height: item, background: chipCss(c) } as React.CSSProperties} />
                );
              })
              : items.map((it, i) => {
                const p0 = slots[i];
                return (
                  <span key={"pie" + i + it.label}
                    className={"pie-item" + (i === foc ? " on" : "")}
                    style={{ left: p0.x, top: p0.y, width: item, height: item } as React.CSSProperties}>
                    <Icon id={it.icon || "i-more"} size={Math.round(item * 0.42)} />
                  </span>
                );
              })}
            <div className="pie-centre">
              <div className="pie-title">{t("pieTitle")} · {ballLabel(ball)}</div>
              <div className="pie-focus">{label || t("pieNoFocus")}</div>
            </div>
            <div className="pie-hint">{t("pieHint")}</div>
          </div>
        );
      })()}

      {(pcMode || docked.length > 0 || dockOpen) && (
        <div ref={dockWrap} className={"bdock" + (landD ? " horiz" : "") + (dockOpen ? " open" : "") + (dockArmed ? " armed" : "")}
          onPointerDown={(e) => {
            e.preventDefault();
            dockClear();
            setDockOpen(true);
            setDockHover(-1);
            dockDown.current = { x: e.clientX, y: e.clientY };
            try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
          }}
          onPointerMove={(e) => {
            if (!dockOpen) return;
            const el = dockWrap.current;
            if (!el) return;
            // sliding only re-focuses while over the panel; leaving keeps the
            // focused ball unchanged so the finger can carry it out to the drop point
            if (!overDockPanel(e.clientX, e.clientY)) return;
            const items = Array.from(el.querySelectorAll<HTMLElement>(".bd-item"));
            let best = -1;
            let bd = 1e9;
            for (let i = 0; i < items.length; i++) {
              const r = items[i].getBoundingClientRect();
              const cc = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
              if (cc < bd) { bd = cc; best = i; }
            }
            setDockHover(items.length ? best : -1);
            // keep the focused ball visible: with 5 dockable balls the panel
            // scrolls, so sliding towards a clipped one scrolls it into view
            if (best >= 0 && items[best]) {
              const it = items[best];
              const r = it.getBoundingClientRect();
              const cr = el.getBoundingClientRect();
              if (landD) {
                if (r.left < cr.left) el.scrollLeft -= (cr.left - r.left) + 8;
                else if (r.right > cr.right) el.scrollLeft += (r.right - cr.right) + 8;
              } else {
                if (r.top < cr.top) el.scrollTop -= (cr.top - r.top) + 8;
                else if (r.bottom > cr.bottom) el.scrollTop += (r.bottom - cr.bottom) + 8;
              }
            }
          }}
          onPointerUp={(e) => {
            try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
            const inside = overDockPanel(e.clientX, e.clientY);
            const down = dockDown.current;
            dockDown.current = null;
            const tap = down !== null && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 12;
            // eject the focused ball wherever the finger released; a plain tap
            // over the panel still pops the single stored ball for convenience
            let pick = -1;
            if (dockHover != null && dockHover >= 0) pick = dockHover;
            else if (inside && tap && docked.length === 1) pick = 0;
            if (pick >= 0) popDock(pick, { x: e.clientX, y: e.clientY }); else dockCollapse(220);
            setDockHover(null);
          }}
          onPointerCancel={() => { dockDown.current = null; dockCollapse(120); setDockHover(null); }}
        >
          {!dockOpen && <span className="bd-dots">{docked.length ? "•".repeat(Math.min(docked.length, 8)) : "·"}</span>}
          {dockOpen && docked.map((d, i) => (
            <span key={d.id} className={"bd-item" + (dockHover === i ? " on" : "")}>
              {/* the docked main ball shows the ACTIVE tool, not always a pencil */}
              <Icon id={d.id === "main" ? baseIcon : iconOfBall(d.id)} size={15} />
            </span>
          ))}
        </div>
      )}
      {!pcMode && (open || (sel && sel.open) || pal.open || fx.open || canv.open) && (
        <div className="radial-back" onPointerDown={closeRadials} />
      )}
      {open && lockBtn("main", pos.x, pos.y)}
      <Keep on={open} el={open ? ring(pos, mainItems) : null} />
      <Keep on={!!sel && sel.open} el={sel && sel.open ? ring({ x: sel.x, y: sel.y }, selItems) : null} />
      {sel && sel.open && lockBtn("sel", sel.x, sel.y)}
      <Keep on={pal.open} el={pal.open ? <PalBalls x={pal.x} y={pal.y} onDone={() => setPal({ ...pal, open: false })} /> : null} />
      {pal.open && lockBtn("pal", pal.x, pal.y)}
      <Keep on={fx.open} el={fx.open ? ring({ x: fx.x, y: fx.y }, fxItems) : null} />
      {fx.open && lockBtn("fx", fx.x, fx.y)}
      <Keep on={canv.open} el={canv.open ? ring({ x: canv.x, y: canv.y }, canvItems) : null} />
      {canv.open && lockBtn("canv", canv.x, canv.y)}
      <Keep on={tileDlg} el={tileDlg ? (
        <>
          <Dialog title={t("canvasTilePick")} onClose={() => setTileDlg(false)} className="tile-dlg" bodyClass="col" footer={<><Btn label={t("close")} onClick={() => setTileDlg(false)} /></>}>
            {(["off", "row", "col", "grid"] as const).map((m) => (
              <button key={m} type="button" className={"menuitem" + (SESSION.prefs.tileMode === m ? " on" : "")}
                onClick={() => { SESSION.setTileMode(m); setTileDlg(false); }}>
                <Icon id={m === "off" ? "i-x" : m === "row" ? "i-tile-row" : m === "col" ? "i-tile-col" : "i-grid"} size={16} />
                <span>{t(m === "off" ? "tileOff" : m === "row" ? "tileRow" : m === "col" ? "tileCol" : "tileGrid")}</span>
              </button>
            ))}
          </Dialog>
        </>
      ) : null} />
      <Keep on={!!fxDlg} el={fxDlg ? <FxParamDialog run={fxDlg.run} vals={fxDlg.vals} onChange={fxChange} onApply={fxApplyDlg} onCancel={fxCance}
        onPickColor={(key) => { SESSION.awaitColorPick((c) => fxChange(key, hexOf(c))); onOpenPalette(); }} /> : null} />
    </>
  );
}

/** palette floater: palette-coloured balls laid out in an outward quarter-fan */
function palQuadrant(x: number, y: number) {
  const right = window.innerWidth - (x + 52) >= x;
  const bottom = window.innerHeight - (y + 52) >= y;
  return { sx: right ? 1 : -1, sy: bottom ? 1 : -1 };
}
/** palette floater: colours laid out in an outward quarter-fan. The fan shows
 *  the document palette, every colour used on the canvas, or the most recently
 *  used ones — a chip beside the ball cycles the source (and the list redraws
 *  the moment a new colour is picked). */
function PalBalls({ x, y, onDone }: { x: number; y: number; onDone: () => void }) {
  const t = makeT(SESSION.prefs.lang as Lang);
  useSession(); // subscribe: a newly used colour must appear immediately
  const M = orbMetrics(useKitPcMode());
  const mode = SESSION.palOrbMode;
  const colors = SESSION.palOrbColors();
  const { sx, sy } = palQuadrant(x, y);
  const cx = x + M.floaterR, cy = y + M.floaterR;
  // the source chip owns a FIXED slot under the floater: its position never
  // depends on how many colours the fan shows, and swatches are laid out
  // around it so the two can never overlap
  const chip = palChipPos(cx, cy, window.innerWidth, window.innerHeight, M.floaterR);
  const chipArea = chipBox(chip.x, chip.y);
  // neat lattice: regular grid clipped to an annulus sector (R0..R1 inside the quadrant)
  // pack tightly around the floater: candidates sorted by distance, take only what the palette needs
  const G = M.fanGap, R0 = M.fanR0, RMAX = 340;
  const cand: Array<{ du: number; dv: number; r: number }> = [];
  for (let i = 0; (i + 0.5) * G <= RMAX; i++) {
    for (let j = 0; (j + 0.5) * G <= RMAX; j++) {
      const du = (i + 0.5) * G, dv = (j + 0.5) * G;
      const r = Math.hypot(du, dv);
      if (r < R0 || r > RMAX) continue;
      if (swatchHitsChip(cx + sx * du, cy + sy * dv, chipArea, M.item)) continue; // keep the chip slot clear
      cand.push({ du, dv, r });
    }
  }
  cand.sort((a, b) => a.r - b.r || Math.atan2(a.dv, a.du) - Math.atan2(b.dv, b.du));
  const n = Math.min(colors.length, cand.length);
  const items: Array<{ c: [number, number, number, number]; px: number; py: number; i: number }> = [];
  for (let k = 0; k < n; k++) {
    const p = cand[k];
    const c = colors[k];
    items.push({ c, px: Math.round(cx + sx * p.du) - 15, py: Math.round(cy + sy * p.dv) - 15, i: k });
  }
  // the source chip keeps its fixed slot (see palChipPos above)
  const { x: chipX, y: chipY } = chip;
  const label = mode === "palette" ? t("palModePalette") : mode === "doc" ? t("palModeDoc") : t("palModeRecent");
  // dragging a colour ball onto the canvas bucket-fills there (one history step);
  // a plain tap keeps the old behaviour (take the colour, close the fan)
  const skipClick = useRef(false);
  // 拖着色球去油漆桶填充后**不再收起色板球**：可以接着换别的颜色继续填，
  // 想收起来点一下色板球（PC 也可以按 Esc）即可。轻点色球仍然是「取色并收起」。
  const fillDrag = useColorDragFill({
    color: () => SESSION.color,
    tip: (c) => ({ title: rgbaToHex(c), desc: t("palDragHint") }),
  });
  const swatchDown = (ev: React.PointerEvent<HTMLButtonElement>, c: [number, number, number, number]) => {
    skipClick.current = false;
    try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
    fillDrag.begin(ev, c);
  };
  const swatchMove = (ev: React.PointerEvent<HTMLButtonElement>) => { fillDrag.move(ev); };
  const swatchUp = (ev: React.PointerEvent<HTMLButtonElement>) => {
    if (fillDrag.end(ev)) skipClick.current = true;   // a drag must not also fire the click
    try { ev.currentTarget.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
  };
  const swatchCancel = (ev: React.PointerEvent<HTMLButtonElement>) => {
    fillDrag.cancel();
    try { ev.currentTarget.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
  };
  return (
    <div className="radial-layer">
      {items.map((it) => {
        const c = it.c;
        const cur = c[0] === SESSION.color[0] && c[1] === SESSION.color[1] && c[2] === SESSION.color[2];
        return (
          <button key={"pb" + mode + it.i} className={"orb-item pal-c" + (cur ? " on" : "")} style={{ left: it.px, top: it.py, background: chipCss(c), "--st": (Math.min(it.i, 40) * 8) + "ms" } as unknown as React.CSSProperties} title={rgbaToHex(c)} onContextMenu={(e) => e.preventDefault()}
            onPointerDown={(ev) => swatchDown(ev, c)}
            onPointerMove={swatchMove}
            onPointerUp={swatchUp}
            onPointerCancel={swatchCancel}
            onClick={() => {
              if (skipClick.current) { skipClick.current = false; return; }
              SESSION.setFgColor([c[0], c[1], c[2], 255]);
              onDone();
            }} />
        );
      })}
      {!items.length && (
        <div className="orb-modechip orb-modeempty"
          style={{ left: chipX, top: Math.max(14, Math.min(window.innerHeight - 14, chipY > cy ? chipY + 26 : chipY - 26)) }}>
          {mode === "doc" ? t("palEmptyDoc") : t("palEmptyRecent")}
        </div>
      )}
      {fillDrag.ghost}
      <button type="button" className="orb-modechip" data-guide="pal-mode-chip" style={{ left: chipX, top: chipY }} title={t("palModeTap")}
        onClick={(e) => { e.stopPropagation(); SESSION.cyclePalOrbMode(); }}>
        {label}
      </button>
    </div>
  );
}





const SYM_GLYPH: Record<string, string> = { off: "·", on: "⇋" };
/** gradient-step chip label: rgb = smooth, otherwise N×N blocks */
function gradLabel(m: "rgb" | "2" | "4" | "8"): string {
  return m === "rgb" ? "RGB" : m + "\u00d7" + m;
}
function ControlBar({ t, snap, onPanel, onAdjust, onFramePrev }: { t: ReturnType<typeof makeT>; snap: Snapshot; onPanel: (p: PanelId) => void; onAdjust: () => void; onFramePrev: () => void }) {
  const land = useLandscape();
  const dir: "h" | "v" = land ? "v" : "h";
  const sym: "off" | "on" = SESSION.sym;
  const symKey = { off: "sym.off", on: "sym.on" } as const;
  return (
    <section className={"ctrlbar" + (land ? " land" : "")}>
      <div className="cb-row">
        <div className="colorpair" title={SESSION.colorTarget === "bg" ? t("bgActive") : t("fgActive")}>
          <div className={"cp-front" + (SESSION.colorTarget === "fg" ? " on" : "")}>
            <ColorHoldChip onClickTap={() => onPanel("palette")} />
          </div>
          <button className={"cp-switch" + (SESSION.colorTarget === "bg" ? " on" : "")}
            title={SESSION.colorTarget === "bg" ? t("useFg") : t("useBg")}
            aria-label={SESSION.colorTarget === "bg" ? t("useFg") : t("useBg")}
            onClick={() => SESSION.setColorTarget(SESSION.colorTarget === "bg" ? "fg" : "bg")}
            style={{ background: chipCss(SESSION.colorTarget === "bg" ? SESSION.fg : SESSION.bg) }} />
        </div>
        <Btn label="⇄" className="swap-color" title={t("swapColors")} onClick={() => SESSION.swapColors()} guide="btn-swap" />
        <Btn icon="i-adjust" onClick={onAdjust} title={t("adjust")} guide="btn-adjust" />
        <Btn label={SYM_GLYPH[sym]} active={sym !== "off"} title={t(symKey[sym])} desc={bd(snap.lang, "sym")} onClick={() => { const m = SESSION.cycleSym(); bridge.toast(t(symKey[m])); }} />
      </div>
      <div className="cb-sliders">
        <HoldAdjust dir={dir} value={snap.brushSize} min={1} max={64} title={t("brushSize")} hint={bd(snap.lang, "brush")} format={(v) => "◉" + v} reset={1} onChange={(v) => SESSION.setBrushSize(v)} />
        <HoldAdjust dir={dir} value={snap.brushAlpha} min={0} max={255} title={t("opacity")} hint={bd(snap.lang, "alpha")} format={(v) => "◐" + v} reset={255} onChange={(v) => SESSION.setBrushAlpha(v)} />
        <Btn icon="i-frameprev" onClick={onFramePrev} title={t("framePreview")} guide="btn-frameprev" />
        {(snap.tool === "pencil" || snap.tool === "eraser") && (
          <Btn label={SESSION.brushShape === "square" ? "■" : "●"} active={SESSION.brushShape === "square"}
            onClick={() => SESSION.setBrushShape(SESSION.brushShape === "square" ? "circle" : "square")}
            title={SESSION.brushShape === "square" ? t("brushSquare") : t("brushCircle")} />
        )}
        {(snap.tool === "pencil" || snap.tool === "eraser") && (
          <Btn label="▘" active={SESSION.pixelPerfect}
            onClick={() => SESSION.setPixelPerfect(!SESSION.pixelPerfect)}
            title={t(SESSION.pixelPerfect ? "pixelPerfectOn" : "pixelPerfectOff")} guide="btn-pixelperfect" />
        )}
        {snap.tool === "polygon" && <HoldAdjust dir={dir} value={SESSION.shapeSides} min={3} max={32} title={t("sides")} hint={bd(snap.lang, "sides")} format={(v) => "◮" + v} reset={6} onChange={(v) => SESSION.setShapeSides(v)} />}
        {isShapeTool(snap.tool) && snap.tool !== "line" && snap.tool !== "polyline" && snap.tool !== "curve" && (
          <Btn label="✛" active={SESSION.shapeFromCenter} onClick={() => SESSION.setShapeFromCenter(!SESSION.shapeFromCenter)}
            title={t(SESSION.shapeFromCenter ? "shapeFromCenterOn" : "shapeFromCenterOff")} />
        )}
        {snap.tool === "bucket" && (<>
          <Btn label={SESSION.prefs.bucketGrad ? "\u25e8" : "\u25e7"} active={SESSION.prefs.bucketGrad}
            onClick={() => SESSION.setBucketGrad(!SESSION.prefs.bucketGrad)}
            title={SESSION.prefs.bucketGrad ? t("bucketGradOn") : t("bucketGradOff")} guide="btn-bucket-grad" />
          {SESSION.prefs.bucketGrad && (
            <Btn label={gradLabel(SESSION.prefs.bucketGradMode)} title={t("bucketGradModeHint")} guide="btn-bucket-gradmode"
              onClick={() => { const m = SESSION.cycleBucketGradMode(); bridge.toast(t("bucketGradModeLabel") + " · " + gradLabel(m)); }} />
          )}
          <Btn label={SESSION.prefs.bucketGlobal ? "∞" : "◎"} active={SESSION.prefs.bucketGlobal} onClick={() => SESSION.setBucketGlobal(!SESSION.prefs.bucketGlobal)} title={SESSION.prefs.bucketGlobal ? t("bucketGlobalOn") : t("bucketGlobalOff")} />
          <Btn label="≈" active={SESSION.prefs.fillSimilar} onClick={() => SESSION.setFillSimilar(!SESSION.prefs.fillSimilar)}
            title={t(SESSION.prefs.fillSimilar ? "fillSimilarOn" : "fillSimilarOff")} guide="btn-fill-similar" />
          {SESSION.prefs.fillSimilar && (
            <HoldAdjust dir={dir} value={SESSION.prefs.fillTolerance} min={0} max={255} title={t("fillToleranceLabel")}
              hint={t("fillToleranceDesc")} format={(v) => "≈" + v} reset={32} onChange={(v) => SESSION.setFillTolerance(v)} />
          )}
          <HoldAdjust dir={dir} value={SESSION.prefs.fillGaps} min={0} max={16} title={t("fillGapsLabel")}
            hint={t("fillGapsDesc")} format={(v) => "▫" + v} reset={0} onChange={(v) => SESSION.setFillGaps(v)} />
        </>)}
        {snap.tool === "airbrush" && (<>
          <HoldAdjust dir={dir} value={SESSION.prefs.airbrushMin} min={1} max={16} title={t("airbrushMinLabel")} hint={t("airbrushMinDesc")} format={(v) => "·" + v} reset={1} onChange={(v) => SESSION.setAirbrushMin(v)} />
          <HoldAdjust dir={dir} value={SESSION.prefs.airbrushMax} min={1} max={16} title={t("airbrushMaxLabel")} hint={t("airbrushMaxDesc")} format={(v) => "◦" + v} reset={3} onChange={(v) => SESSION.setAirbrushMax(v)} />
          <HoldAdjust dir={dir} value={SESSION.prefs.airbrushRate} min={5} max={60} title={t("airbrushRateLabel")} hint={t("airbrushRateDesc")} format={(v) => "~" + v} reset={20} onChange={(v) => SESSION.setAirbrushRate(v)} />
        </>)}
        {isShapeTool(snap.tool) && snap.tool !== "line" && snap.tool !== "polyline" && snap.tool !== "curve" && <Btn icon={SESSION.shapeFill ? "i-rect" : "i-rectfill"} onClick={() => SESSION.setShapeFill(!SESSION.shapeFill)} title={SESSION.shapeFill ? t("shapeHollow") : t("shapeSolid")} />}
      </div>
    </section>
  );
}
function Viewport({ onColorClick, refImg, onRefClose, onFramePrev }: { onColorClick: () => void; refImg: RefImg | null; onRefClose: () => void; onFramePrev: () => void }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<View | null>(null);
  const tv = makeT(SESSION.prefs.lang as Lang);
  const [, setTick] = useState(0);
  /** bumped whenever the view transform changes (the canvas title bars follow) */
  const [vt, setVt] = useState(0);
  const onFpRef = useRef(onFramePrev);
  onFpRef.current = onFramePrev;
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const v = new View(host, SESSION);
    viewRef.current = v;
    // four-finger swipe-up opens the all-frames preview
    v.onFramePreview = () => onFpRef.current();
    v.onViewChanged = () => setVt((x) => (x + 1) & 0xffff);
    SESSION.attachView(v);
    v.fit();
    const iv = window.setInterval(() => setTick((x) => x + 1), 300);
    return () => { window.clearInterval(iv); v.destroy(); SESSION.attachView(null); viewRef.current = null; };
  }, []);
  const symOn = SESSION.sym !== "off" && isSymTool(SESSION.tool);
  const c = SESSION.color;
  const visible = SESSION.colorPickedRecently(Date.now(), 1600);
  return (
    <section className="viewport">
      <div className="view-canvas" ref={hostRef} />
      <CanvasTitles view={viewRef.current} tick={vt} />
      <PreviewBox />
      {refImg && <RefImageBox img={refImg} onClose={onRefClose} />}
      {symOn && !SESSION.symLocked && (
        <div className="sym-chiprow">
          <button className={"sym-chip" + (SESSION.symFour ? " on" : "")} type="button" title={tv("symFour")} onClick={() => SESSION.setSymFour(!SESSION.symFour)}>{tv("symFour")}</button>
          <button className="sym-chip sym-ro" type="button" title={tv("symAngleHint")} onClick={() => SESSION.cycleSymAngle()}>{tv("symAngle")} {SESSION.symAng}°</button>
          <button className="sym-chip sym-done" type="button" title={tv("symAdjustHint")} onClick={() => SESSION.resetSymAxes()}>{tv("symReset")}</button>
        </div>
      )}
      <div className="zoom-hud">
        {/* PC：光标下的像素坐标与颜色（悬停在画布外时隐藏） */}
        {SESSION.hover && (() => {
          const h = SESSION.hover!;
          return (
            <span className="zoom-hover" title={tv("hoverReadHint")}>
              {h.x},{h.y}
              {h.color ? <i className="zh-dot" style={{ background: chipCss([h.color[0], h.color[1], h.color[2], h.color[3]]) }} /> : null}
              {h.color ? <span className="zh-hex">{rgbaToHex([h.color[0], h.color[1], h.color[2], h.color[3]])}</span> : null}
            </span>
          );
        })()}
        <span className="zoom-pct">{Math.round((viewRef.current?.zoom ?? 8) * 100)}%</span>
      </div>
      {visible && (
        <div className="canvas-corner">
          <button className="colorbox" onClick={onColorClick} title={tv("colorPicked")}>
            <span className="cb-swatch" style={{ background: chipCss(c) }} />
            <span className="cb-hex">{rgbaToHex(c)}</span>
          </button>
        </div>
      )}
    </section>
  );
}