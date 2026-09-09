import React, { useEffect, useMemo, useRef, useState } from "react";
import { SESSION } from "./singleton";
import type { Snapshot } from "../app/session";
import { makeT } from "./i18n";
import type { Lang } from "./i18n";
import { CORE_TOOLS, SHAPE_TOOLS, SELECT_TOOLS, isShapeTool, isSelectTool, isSymTool, type ToolId } from "../tools/registry";
import { View } from "../render/view";
import { rgbaToHex, chipCss } from "../engine/color";
import { paintAt } from "../engine/paint";
import * as selOps from "../tools/select";
import * as fxE from "../engine/effects";
import * as compositor from "../render/compositor";
import { HoldAdjust, ColorHoldChip } from "./hold";
import { palChipPos, chipBox, swatchHitsChip } from "./orb-layout";
import { ReplayOverlay } from "./replay";
import * as bridge from "../io/bridge";
import { writeClipboardPng } from "../io/clipboard";
import { showTip, hideTip } from "./tooltip";
import { Icon, Btn, TipHost, Keep, Overlay, useSession, useLandscape } from "./base";
import { TimelineBar } from "./timeline";
import { PreviewBox } from "./preview";
import { RefImageBox } from "./refimg";
import type { RefImg } from "./refimg";
import { PalettePanel, MenuModal, SizeModal, SheetModal, NewDocModal, ExportModal, AdjustModal, SettingsModal, FrameModal, FramePreviewModal, HistoryModal, histName, saveProject } from "./modals";
import { ChangelogModal, changelogNeedsShow } from "./changelog";
import { watchSafeArea } from "../io/safearea";
import { GUIDE, guideStepsFor, type GuideAction, type GuideStep } from "../app/guide";
import { GuideOverlay, simulateTap } from "./guide";
import type { ModalId, SizeMode, SheetData } from "./modals";

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
    const onCtx = (e: Event) => e.preventDefault();
    const onDrag = (e: Event) => e.preventDefault();
    const onSel = (e: Event) => { if (!isEditable(e.target)) e.preventDefault(); };
    document.addEventListener("contextmenu", onCtx);
    document.addEventListener("dragstart", onDrag);
    document.addEventListener("selectstart", onSel);
    return () => {
      document.removeEventListener("contextmenu", onCtx);
      document.removeEventListener("dragstart", onDrag);
      document.removeEventListener("selectstart", onSel);
    };
  }, []);
  const [panel, setPanel] = useState<PanelId>(null);
  const [modal, setModal] = useState<ModalId>(null);
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
  /** onboarding tour: steps still unseen by this user (null = not running) */
  const [guide, setGuide] = useState<GuideStep[] | null>(null);
  /** app state before the tour started (the tour really taps buttons) */
  const guideState = useRef<{ tlOn: boolean; onionOn: boolean } | null>(null);
  /** live readout while dragging the timeline divider */
  const [tlDrag, setTlDrag] = useState<{ h: number; top: number } | null>(null);
  const tlGripRef = useRef<{ id: number; y0: number; h0: number } | null>(null);

  useEffect(() => {
    SESSION.setConfirmAsk((q) => new Promise<boolean>((resolve) => setConfirmQ({ msg: q.msg, yes: q.yes, no: q.no, res: resolve })));
    return () => SESSION.setConfirmAsk(null);
  }, []);

  // full screen / safe area: push the insets into CSS vars and keep them fresh
  // across rotation (the settings registry re-applies them on change too)
  useEffect(() => watchSafeArea(() => SESSION.prefs), []);

  // first launch after an update: auto-show the release notes
  useEffect(() => {
    if (changelogNeedsShow()) setModal("changelog");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    guideState.current = { tlOn, onionOn: SESSION.prefs.onionOn };
    const id = window.setTimeout(() => setGuide(todo), 900);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    SESSION.changed();
  };
  const restoreSelection = () => {
    const bak = selBackup.current;
    selBackup.current = null;
    if (!bak) return;
    const d = SESSION.doc;
    if (bak.had && bak.mask && d.sel) d.sel.mask.set(bak.mask);
    else selOps.selOps.clear(d);
    SESSION.repaintAll();
    SESSION.changed();
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
      SESSION.changed();
      window.setTimeout(() => {
        const l = SESSION.history.list();
        const last = l.labels[l.labels.length - 1];
        if (last === "guide-demo" && l.index === l.labels.length) SESSION.undo();
      }, 1500);
    },
    // tool ring: opened by the tour so every individual tool can be highlighted
    openToolRing: () => window.dispatchEvent(new CustomEvent("pc-guide-tools", { detail: "open" })),
    closeToolRing: () => window.dispatchEvent(new CustomEvent("pc-guide-tools", { detail: "close" })),
    toolSubShape: () => window.dispatchEvent(new CustomEvent("pc-guide-tools", { detail: "shape" })),
    toolSubSelect: () => window.dispatchEvent(new CustomEvent("pc-guide-tools", { detail: "select" })),
    toolSubBack: () => window.dispatchEvent(new CustomEvent("pc-guide-tools", { detail: "back" })),
    // main menu + its sub-menus: MenuModal takes the initial sub from this
    // window flag (it mounts after the click) and follows the event afterwards
    openMenu: () => {
      (window as unknown as { __pcGuideMenuSub?: null | "import" | "export" }).__pcGuideMenuSub = null;
      setModal("menu");
      window.setTimeout(() => window.dispatchEvent(new CustomEvent("pc-guide-menu-sub", { detail: null })), 0);
    },
    closeMenu: () => {
      (window as unknown as { __pcGuideMenuSub?: null | "import" | "export" }).__pcGuideMenuSub = null;
      setModal(null);
    },
    menuSubImport: () => window.dispatchEvent(new CustomEvent("pc-guide-menu-sub", { detail: "import" })),
    menuSubExport: () => window.dispatchEvent(new CustomEvent("pc-guide-menu-sub", { detail: "export" })),
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
        SESSION.changed();
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
        SESSION.changed();
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
    (window as unknown as { __pcGuideMenuSub?: null | "import" | "export" }).__pcGuideMenuSub = null;
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
    <div className={"app-root" + (SESSION.prefs.railSwap ? " rails-swap" : "") + (tlOn ? " has-tl" : "")} onContextMenu={(e) => e.preventDefault()} onDragStart={(e) => e.preventDefault()}>
      <TopBar t={t} snap={snap} tlOn={tlOn} onToggleTl={() => {
        if (tlClosing) return;
        if (tlOn) {
          setTlClosing(true);
          window.setTimeout(() => { setTlClosing(false); setTlOn(false); }, 210);
        } else {
          setTlOn(true);
        }
      }} onMenu={() => setModal("menu")} onExport={() => setModal("export")} onResize={() => { setSizeMode("canvas"); setModal("size"); }} onHistory={() => setModal("history")} />
      <div className="workspace">
        <Viewport
          onColorClick={() => setPanel("palette")}
          refImg={refImg}
          onRefClose={() => SESSION.setRefImage(null)}
          onFramePrev={() => setModal("framePrev")}
        />
      </div>
      <ControlBar t={t} snap={snap} onPanel={setPanel} onAdjust={() => setModal("adjust")} onFramePrev={() => setModal("framePrev")} />
      {tlOn && (
      <div className={"tline-wrap" + (tlClosing ? " closing" : "")}>
        <div className="tl-grip" data-guide="tl-grip" title={t("tlGripHint")}
          onPointerDown={gripDown} onPointerMove={gripMove} onPointerUp={gripUp} onPointerCancel={gripUp}
          onDoubleClick={() => SESSION.setTlHeight(200)} />
        <TimelineBar t={t} snap={snap} onFrameDlg={setFrameDlgIdx} />
      </div>
      )}
      {tlDrag && <div className="tl-pill" style={{ top: Math.max(4, tlDrag.top - 30) }}>{tlDrag.h}px</div>}
      <FloatingTools t={t} snap={snap} />
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
      <Keep on={modal === "export"} el={modal === "export" ? <ExportModal t={t} snap={snap} onClose={() => setModal(null)} /> : null} />
      <Keep on={modal === "settings"} el={modal === "settings" ? <SettingsModal t={t} onClose={() => setModal(null)} /> : null} />
      <Keep on={modal === "adjust"} el={modal === "adjust" ? <AdjustModal t={t} onClose={() => setModal(null)} /> : null} />
      <Keep on={frameDlgIdx !== null} el={frameDlgIdx !== null ? <FrameModal t={t} snap={snap} fi={typeof frameDlgIdx === "number" ? frameDlgIdx : snap.frameIdx} batch={frameDlgIdx === "batch"} onClose={() => setFrameDlgIdx(null)} /> : null} />
      <Keep on={modal === "history"} el={modal === "history" ? <HistoryModal t={t} snap={snap} onClose={() => setModal(null)} onReplay={() => { setModal(null); setReplayOn(true); }} /> : null} />
      <Keep on={modal === "framePrev"} el={modal === "framePrev" ? <FramePreviewModal t={t} onClose={() => setModal(null)} /> : null} />
      <Keep on={modal === "changelog"} el={modal === "changelog" ? <ChangelogModal onClose={() => setModal(null)} /> : null} />
      {guide && <GuideOverlay steps={guide} actions={guideActions} onDone={finishGuide} />}
      {confirmQ && (
        <div className="cfm-layer">
          <div className="dlg-mask" onClick={() => { confirmQ.res(false); setConfirmQ(null); }} />
          <div className="dlg">
            <div className="dlg-head"><span>{t("confirmTitle")}</span><div className="grow" /></div>
            <div className="dlg-body"><div className="row-note cfm-msg">{confirmQ.msg}</div></div>
            <div className="dlg-foot"><Btn label={confirmQ.no} onClick={() => { confirmQ.res(false); setConfirmQ(null); }} /><Btn label={confirmQ.yes} className="primary" onClick={() => { confirmQ.res(true); setConfirmQ(null); }} /></div>
          </div>
        </div>
      )}
      <TipHost />
    </div>
  );
}

/** short function descriptions shown by the global long-press tooltip */
const B_DESC = {
  menu: { zh: "打开主功能菜单（新建 / 打开 / 导入导出 / 设置）", en: "Open the main menu" },
  undo: { zh: "撤销上一步操作", en: "Undo the last action" },
  redo: { zh: "重做已撤销的操作", en: "Redo the undone action" },
  save: { zh: "把工程保存为 .pxc 文件", en: "Save the project (.pxc)" },
  export: { zh: "导出 PNG / GIF 动画 / 精灵表", en: "Export PNG / GIF / spritesheet" },
  layers: { zh: "图层面板（新建 / 复制 / 合并 / 锁定）", en: "Layer panel" },
  resize: { zh: "修改尺寸：画布尺寸（裁剪/扩边）或精灵尺寸（整体缩放）", en: "Resize canvas or sprite" },
  fs: { zh: "进入 / 退出浏览器全屏", en: "Enter / exit browser fullscreen" },
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
  fx: { zh: "魔法球：描边 / 反色 / 灰度 / 居中（作用于当前图层帧）", en: "Magic ball: outline / invert / grayscale / center (active layer/frame)" },
  hist: { zh: "操作记录：查看可撤销/重做的步骤，点任意旧记录可回到该状态", en: "History: view undo/redo steps, tap one to jump back" },
  loop: { zh: "循环播放：播到最后一帧后回到第 1 帧继续；关闭则播到末尾停止", en: "Loop: restart from frame 1 at the end; off stops at the last frame" },
  sides: { zh: "多边形边数：按住拖动调节（3–12 边）", en: "Polygon sides: hold & drag (3–12)" },
} as const;
function bd(lang: string, key: keyof typeof B_DESC): string {
  const e = B_DESC[key];
  return lang === "zh" ? e.zh : e.en;
}

function TopBar({
  t, snap, tlOn, onToggleTl, onMenu, onExport, onResize, onHistory,
}: {
  t: ReturnType<typeof makeT>; snap: Snapshot; tlOn: boolean; onToggleTl: () => void; onMenu: () => void; onExport: () => void; onResize: () => void; onHistory: () => void;
}) {
  const [fs, setFs] = useState(false);
  useEffect(() => {
    const fn = () => setFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", fn);
    document.addEventListener("webkitfullscreenchange", fn as EventListener);
    return () => {
      document.removeEventListener("fullscreenchange", fn);
      document.removeEventListener("webkitfullscreenchange", fn as EventListener);
    };
  }, []);
  const toggleFs = async () => {
    try {
      const d = document as Document & { webkitExitFullscreen?: () => void; webkitFullscreenElement?: Element | null };
      const root = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
      if (!d.fullscreenElement && !d.webkitFullscreenElement) {
        const req = root.requestFullscreen ? root.requestFullscreen.bind(root) : root.webkitRequestFullscreen?.bind(root);
        if (!req) { bridge.toast(t("fsUnsupported")); return; }
        await req();
      } else {
        const ex = document.exitFullscreen ? document.exitFullscreen.bind(document) : d.webkitExitFullscreen?.bind(d);
        if (ex) ex();
      }
    } catch { /* ignore */ }
  };
  return (
    <header className="topbar">
      <Btn icon="i-gear" onClick={onMenu} title={t("menu")} desc={bd(snap.lang, "menu")} guide="btn-menu" />
      <div className="grow" />
      <Btn icon="i-history" onClick={onHistory} title={t("historyTitle")} desc={bd(snap.lang, "hist")} guide="btn-history" />
      <Btn icon="i-undo" onClick={() => SESSION.undo()} title={t("undo")} desc={bd(snap.lang, "undo")} className={snap.canUndo ? "" : "off"} guide="btn-undo" />
      <Btn icon="i-redo" onClick={() => SESSION.redo()} title={t("redo")} desc={bd(snap.lang, "redo")} className={snap.canRedo ? "" : "off"} guide="btn-redo" />
      <Btn icon="i-export" onClick={onExport} title={t("export")} desc={bd(snap.lang, "export")} guide="btn-export" />
      <Btn icon="i-save" onClick={saveProject} title={t("save")} desc={bd(snap.lang, "save")} guide="btn-save" />
      <Btn icon="i-timeline" onClick={onToggleTl} active={tlOn} title={t(tlOn ? "timelineHide" : "timelineShow")} guide="btn-timeline" />
      <Btn icon="i-size" onClick={onResize} title={t("resizeTitle")} desc={bd(snap.lang, "resize")} guide="btn-size" />
      <Btn icon={fs ? "i-fsexit" : "i-fit"} onClick={() => void toggleFs()} title={t(fs ? "exitFullscreen" : "fullscreen")} desc={bd(snap.lang, "fs")} className={fs ? "fs-on" : ""} />
    </header>
  );
}





function FloatingTools({ t, snap }: { t: ReturnType<typeof makeT>; snap: Snapshot }) {
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
  const drag = useRef<{ which: "main" | "sel" | "pal" | "fx"; dx: number; dy: number; moved: boolean } | null>(null);

  const ORB = 52;
  const MINC = ORB + 16;
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
      }
    };
    window.addEventListener("pc-guide-tools", onTools);
    return () => window.removeEventListener("pc-guide-tools", onTools);
  }, []);

  // Android back: close whatever floating layer is on top before leaving.
  // The handler reads the live state from a ref, because state updates inside
  // the event would only be applied after the native side already decided.
  const backState = useRef({ open, sub, sel, pal, fx });
  backState.current = { open, sub, sel, pal, fx };
  useEffect(() => {
    const onBack = (e: Event) => {
      const d = (e as CustomEvent<{ handled: boolean }>).detail;
      if (!d || d.handled) return;
      const st = backState.current;
      const any = st.open || st.sub !== null || st.sel.open || st.pal.open || st.fx.open;
      if (!any) return;
      setOpen(false);
      setSub(null);
      if (st.sel.open) setSel({ ...st.sel, open: false });
      if (st.pal.open) setPal({ ...st.pal, open: false });
      if (st.fx.open) setFx({ ...st.fx, open: false });
      d.handled = true;
    };
    window.addEventListener("pc-back", onBack);
    return () => window.removeEventListener("pc-back", onBack);
  }, []);

  // ---------- floating-ball dock ----------
  const landD = useLandscape();
  type BallId = "main" | "pal" | "fx";
  const dockKey = "pc.orb.dock";
  const loadDock = (): Array<{ id: BallId; x: number; y: number }> => {
    try {
      const d = JSON.parse(localStorage.getItem(dockKey) || "[]");
      if (Array.isArray(d)) {
        return d.filter((e) => e && (e.id === "main" || e.id === "pal" || e.id === "fx") &&
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
    const cur = id === "main" ? pos : id === "pal" ? { x: pal.x, y: pal.y } : { x: fx.x, y: fx.y };
    if (id === "main") {
      try { localStorage.setItem(orbKey, JSON.stringify(cur)); } catch { /* ignore */ }
    }
    setOpen(false);
    setSub(null);
    if (sel) setSel({ ...sel, open: false });
    setPal((g) => (g ? { ...g, open: false } : g));
    setFx((g) => (g ? { ...g, open: false } : g));
    setDocked((d) => [...d, { id, x: cur.x, y: cur.y }]);
    setDockOpen(true);
    dockCollapse(900);
  };
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
    else setFx({ x: np.x, y: np.y, open: false });
    setDockOpen(false);
    setDockHover(null);
  };
  const iconOfBall = (id: BallId): string => id === "main" ? "i-pencil" : id === "pal" ? "i-palette" : "i-star";

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

  // selection appeared -> spawn the selection action ball near the top-left corner
  useEffect(() => {
    if (snap.selActive && !prevSelA.current) {
      setSel({ ...separate(clampXY({ x: 12, y: 96 }), pos), open: false });
      setOpen(false);
      setSub(null);
    } else if (!snap.selActive) {
      setSel(null);
    }
    prevSelA.current = snap.selActive;
  }, [snap.selActive]);

  const pickTool = (family: "core" | "shape" | "select", id: string) => {
    SESSION.setTool(id as never);
    if (family === "shape") SESSION.setCurrentShape(id as never);
    else if (family === "select") SESSION.setCurrentSelect(id as never);
    setOpen(false);
    setSub(null);
    if (sel) setSel({ ...sel, open: false });
  };

  const closeRadials = () => {
    setOpen(false);
    setSub(null);
    if (sel) setSel({ ...sel, open: false });
    if (pal) setPal({ ...pal, open: false });
    setFx((g) => (g ? { ...g, open: false } : g));
  };

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

  const moveBall = (which: "main" | "sel" | "pal" | "fx", nx: number, ny: number) => {
    // drop exactly where the finger is: no auto repulsion from other orbs
    const p = clampXY({ x: nx, y: ny });
    if (which === "main") {
      setPos(p);
      try { localStorage.setItem(orbKey, JSON.stringify(p)); } catch { /* ignore */ }
    } else if (which === "sel") {
      setSel({ x: p.x, y: p.y, open: false });
    } else if (which === "pal") {
      setPal((g) => ({ ...g, x: p.x, y: p.y, open: false }));
    } else {
      setFx((g) => ({ ...g, x: p.x, y: p.y, open: false }));
    }
    setOpen(false);
    setSub(null);
    if (sel && which !== "sel") setSel((s) => (s ? { ...s, open: false } : s));
    if (pal && which !== "pal") setPal((g) => (g ? { ...g, open: false } : g));
    if (which !== "fx") setFx((g) => (g ? { ...g, open: false } : g));
  };

  type Item = { icon: string; label: string; act: () => void; active?: boolean; desc?: string; guide?: string };
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
    const z: Record<string, string> = { pencil: "铅笔：逐像素绘制", eraser: "橡皮：清除像素", bucket: "油漆桶：向同色连通区域填充当前色", picker: "取色器：吸取画布上的颜色", line: "直线", rect: "矩形描边", rectfill: "实心矩形", ellipse: "椭圆描边", ellipsefill: "实心椭圆", circle: "圆形：拖动绘制正圆", polygon: "多边形：可调边数（3–12）", select: "矩形选区：拖拽框选区域", wand: "魔棒：按容差选中同色连通区域", lasso: "套索：自由手绘选区" };
    const en: Record<string, string> = { pencil: "Pencil: draw pixels", eraser: "Eraser: clear pixels", bucket: "Fill bucket: fill same-colour region", picker: "Eyedropper: pick a colour", line: "Line", rect: "Rect outline", rectfill: "Filled rect", ellipse: "Ellipse outline", ellipsefill: "Filled ellipse", circle: "Circle: drag to draw a perfect circle", polygon: "Polygon: adjustable sides (3–12)", select: "Rect selection: drag to select", wand: "Magic wand: select same-colour area", lasso: "Lasso: freehand selection" };
    return (snap.lang === "zh" ? z : en)[id] ?? "";
  };

  const li = snap.layerIdx, fi = snap.frameIdx;
  const d = SESSION.doc;
  const repaintChanged = () => { SESSION.repaint(); SESSION.changed(); };
  const selItems: Item[] = [
    { icon: "i-check", label: t("sel.all"), act: () => { selOps.selOps.selectAll(d); SESSION.repaint(); } },
    { icon: "i-fx-inv", label: t("sel.invert"), act: () => SESSION.maskOp("sel.invert", () => selOps.selOps.invert(d)) },
    { icon: "i-x", label: t("sel.clear"), act: () => { selOps.selOps.clear(d); SESSION.repaint(); } },
    { icon: "i-bucket", label: t("sel.fill"), act: () => { if (!(d.sel && d.sel.hasAny())) { bridge.toast(t("noSel")); return; } selOps.selOps.fill(d, SESSION.history, li, fi, SESSION.color); repaintChanged(); } },
    { icon: "i-dupe", label: t("sel.copy"), act: () => { const c = selOps.selOps.copy(d, li, fi); SESSION.clip = c; if (c) void writeClipboardPng(compositor.celToCanvas(c)).then((ok) => bridge.toast(ok ? t("sysCopy") : t("copied"))); } },
    { icon: "i-pencil", label: t("sel.cut"), act: () => { const c = selOps.selOps.cut(d, SESSION.history, li, fi); SESSION.clip = c; if (c) { repaintChanged(); void writeClipboardPng(compositor.celToCanvas(c)).then((ok) => bridge.toast(ok ? t("sysCopy") : t("cut"))); } } },
    { icon: "i-import", label: t("sel.paste"), act: () => { if (SESSION.clip) { selOps.selOps.paste(d, SESSION.history, li, fi, SESSION.clip); repaintChanged(); bridge.toast(t("pasted")); } else bridge.toast(t("noSel")); } },
    { icon: "i-fliph", label: t("sel.fliph"), act: () => { selOps.selOps.flip(d, SESSION.history, li, fi, true); repaintChanged(); } },
    { icon: "i-flipv", label: t("sel.flipv"), act: () => { selOps.selOps.flip(d, SESSION.history, li, fi, false); repaintChanged(); } },
    { icon: "i-plus", label: t("sel.grow"), act: () => SESSION.maskOp("sel.grow", () => selOps.growSelection(d, 1)) },
    { icon: "i-minus", label: t("sel.shrink"), act: () => SESSION.maskOp("sel.shrink", () => selOps.shrinkSelection(d, 1)) },
    { icon: "i-paint", label: t("sel.outline"), act: () => { selOps.outlineSelected(d, SESSION.history, li, fi, SESSION.color); repaintChanged(); } },
    { icon: "i-fx-crop", label: t("sel.delete"), act: () => { SESSION.deleteSelection(); } },
  ];

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
    fxI("o1", "i-fx-o1", "描边", "Edge", "边缘描边 1px（用前景色）", "Edge outline 1px outward (FG colour)", () => fxDo("fx-outline1", (dd, w, h) => fxE.outlineCel(dd, w, h, 1, SESSION.color))), fxI("crop", "i-fx-crop", "智能裁剪", "Crop", "自动裁剪画布四周空白（全部图层/帧）", "Auto-crop empty canvas borders (all layers/frames)", () => SESSION.cropSmart()),
    fxI("shadow", "i-fx-shadow", "投影", "Shadow", "一键投影：仅按当前图层生成（设置可选当前图层 / 新建shadow图层）", "Drop shadow from the current layer only (Settings: bake here or on a new shadow layer)", () => SESSION.applyShadow()),
    fxI("clear", "i-fx-ctr", "清空画布", "Clear", "清空当前帧所有图层的画布内容", "Empty the current frame on all layers", () => SESSION.clearCanvas()),
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

  const mainItems: Item[] = sub
    ? [
        { icon: "", label: "\u2039", act: () => setSub(null), guide: "tool-back" },
        ...(sub === "shape" ? SHAPE_TOOLS : SELECT_TOOLS).map((dd) => ({ icon: dd.icon, label: t("tools." + dd.id), desc: td(dd.id), act: () => pickTool(sub, dd.id), active: snap.tool === dd.id, guide: "tool-" + dd.id })),
      ]
    : [
        ...CORE_TOOLS.map((dd) => ({ icon: dd.icon, label: t("tools." + dd.id), desc: td(dd.id), act: () => pickTool("core", dd.id), active: snap.tool === dd.id, guide: "tool-" + dd.id })),
        { icon: defOf(snap.shape)?.icon || "i-rect", label: t("shapeGroup"), desc: snap.lang === "zh" ? "图形工具：直线 / 矩形 / 椭圆" : "Shape tools: line / rect / ellipse", act: () => { setSub("shape"); if (sel) setSel({ ...sel, open: false }); }, active: isShapeTool(snap.tool), guide: "tool-shape-group" },
        { icon: (snap.tool !== "line" && isSelectTool(snap.tool) ? defOf(snap.tool)?.icon : defOf(SESSION.currentSelect)?.icon) || "i-select", label: t("sel.active"), desc: snap.lang === "zh" ? "选区工具：框选 / 魔棒 / 套索" : "Select tools: rect / wand / lasso", act: () => { setSub("select"); if (sel) setSel({ ...sel, open: false }); }, active: isSelectTool(snap.tool), guide: "tool-select-group" },
      ];

  const baseIcon =
    (isShapeTool(snap.tool) ? defOf(snap.shape)?.icon
      : isSelectTool(snap.tool) ? defOf(snap.tool)?.icon
      : defOf(snap.tool)?.icon) || "i-pencil";

  const ringAt = (p0: { x: number; y: number }, i: number, n: number) => {
    const cx = p0.x + ORB / 2, cy = p0.y + ORB / 2;
    const R1 = 86, R2 = 128;
    const dx = window.innerWidth - cx >= cx ? 1 : -1;
    const dy = window.innerHeight - cy >= cy ? 1 : -1;
    const deg = dx === 1 && dy === 1 ? [-6, 84] : dx === 1 && dy === -1 ? [-84, 6] : dx === -1 && dy === -1 ? [174, 264] : [96, 186];
    const a0 = (deg[0] * Math.PI) / 180, a1 = (deg[1] * Math.PI) / 180;
    const ringA = Math.ceil(n / 2);
    const inA = i < ringA;
    const pr = inA ? (ringA <= 1 ? 0 : i / (ringA - 1)) : (() => { const j = i - ringA; const cnt = n - ringA; return cnt <= 1 ? 0 : j / (cnt - 1); })();
    const r = inA ? R1 : R2;
    const ang = a0 + (a1 - a0) * pr;
    return { x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r };
  };

  const renderBall = (
    which: "main" | "sel" | "pal" | "fx",
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
      }}
      onPointerMove={(e) => {
        guardTip(e);
        const dr = drag.current;
        if (!dr || dr.which !== which) return;
        if (Math.abs(e.clientX - p.x - dr.dx) > 4 || Math.abs(e.clientY - p.y - dr.dy) > 4) dr.moved = true;
        if (dr.moved) {
          stopTip();
          moveBall(which, e.clientX - dr.dx, e.clientY - dr.dy);
          const near = inDockZone(e.clientX, e.clientY);
          const parked = overDockPanel(e.clientX, e.clientY);
          parkRef.current = parked ? ({ id: which as never }) : null;
          if (near) { dockClear(); setDockOpen(true); } // panel pops up while approaching the edge
          setDockArmed(parked); // highlight only when it would actually park
        }
      }}
      onPointerUp={() => {
        stopTip();
        setDockArmed(false);
        const dr = drag.current;
        if (dr && dr.which === which) {
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
      {!dockedById("main") && renderBall("main", pos, baseIcon, open, t("menu"), bd(snap.lang, "orb"), () => {
        if (open) { setOpen(false); setSub(null); return; }
        if (sel) {
          const pushed = clearRingOf(pos, { x: sel.x, y: sel.y });
          if (pushed) setSel({ ...pushed, open: false });
        }
        if (pal) {
          const pushed2 = clearRingOf(pos, { x: pal.x, y: pal.y });
          if (pushed2) setPal({ ...pushed2, open: false });
        }
        if (fx) {
          const pushed3 = clearRingOf(pos, { x: fx.x, y: fx.y });
          if (pushed3) setFx({ ...pushed3, open: false });
        }
        SESSION.hapticTick("工具栏", 0.7);
        setOpen(true);
      })}
      <Keep on={!!sel} el={sel ? renderBall("sel", { x: sel.x, y: sel.y }, "i-select", sel.open, t("sel.active"), bd(snap.lang, "selBall"), () => {
        setOpen(false);
        setSub(null);
        if (!sel.open) {
          const np = clearRingOf({ x: sel.x, y: sel.y }, pos);
          if (np && (np.x !== pos.x || np.y !== pos.y)) {
            setPos(np);
            try { localStorage.setItem(orbKey, JSON.stringify(np)); } catch { /* ignore */ }
          }
          if (pal) {
            const pp = clearRingOf({ x: sel.x, y: sel.y }, { x: pal.x, y: pal.y });
            if (pp) setPal({ ...pp, open: false });
          }
          if (fx) {
            const fp = clearRingOf({ x: sel.x, y: sel.y }, { x: fx.x, y: fx.y });
            if (fp) setFx({ ...fp, open: false });
          }
        }
        setSel({ ...sel, open: !sel.open });
      }) : null} />
      {!dockedById("pal") && renderBall("pal", { x: pal.x, y: pal.y }, "i-palette", pal.open, t("palette"), bd(snap.lang, "palette"), () => {
        setOpen(false);
        setSub(null);
        if (sel) setSel({ ...sel, open: false });
        if (!pal.open) {
          const np = clearRingOf({ x: pal.x, y: pal.y }, pos);
          if (np && (np.x !== pos.x || np.y !== pos.y)) {
            setPos(np);
            try { localStorage.setItem(orbKey, JSON.stringify(np)); } catch { /* ignore */ }
          }
          if (sel) {
            const sp = clearRingOf({ x: pal.x, y: pal.y }, { x: sel.x, y: sel.y });
            if (sp) setSel({ ...sp, open: false });
          }
          if (fx) {
            const fp = clearRingOf({ x: pal.x, y: pal.y }, { x: fx.x, y: fx.y });
            if (fp) setFx({ ...fp, open: false });
          }
        }
        setPal({ ...pal, open: !pal.open });
      })}
      {!dockedById("fx") && renderBall("fx", { x: fx.x, y: fx.y }, "i-star", fx.open, t("fxOrb"), bd(snap.lang, "fx"), () => {
        setOpen(false);
        setSub(null);
        if (sel) setSel({ ...sel, open: false });
        if (pal) setPal({ ...pal, open: false });
        if (!fx.open) {
          const np = clearRingOf({ x: fx.x, y: fx.y }, pos);
          if (np && (np.x !== pos.x || np.y !== pos.y)) {
            setPos(np);
            try { localStorage.setItem(orbKey, JSON.stringify(np)); } catch { /* ignore */ }
          }
          if (sel) {
            const sp = clearRingOf({ x: fx.x, y: fx.y }, { x: sel.x, y: sel.y });
            if (sp) setSel({ ...sp, open: false });
          }
          if (pal) {
            const pp = clearRingOf({ x: fx.x, y: fx.y }, { x: pal.x, y: pal.y });
            if (pp) setPal({ ...pp, open: false });
          }
        }
        setFx({ ...fx, open: !fx.open });
      })}
      {(docked.length > 0 || dockOpen) && (
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
              <Icon id={iconOfBall(d.id)} size={15} />
            </span>
          ))}
        </div>
      )}
      {(open || (sel && sel.open) || pal.open || fx.open) && (
        <div className="radial-back" onPointerDown={closeRadials} />
      )}
      <Keep on={open} el={open ? ring(pos, mainItems) : null} />
      <Keep on={!!sel && sel.open} el={sel && sel.open ? ring({ x: sel.x, y: sel.y }, selItems) : null} />
      <Keep on={pal.open} el={pal.open ? <PalBalls x={pal.x} y={pal.y} onDone={() => setPal({ ...pal, open: false })} /> : null} />
      <Keep on={fx.open} el={fx.open ? ring({ x: fx.x, y: fx.y }, fxItems) : null} />
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
  const mode = SESSION.palOrbMode;
  const colors = SESSION.palOrbColors();
  const { sx, sy } = palQuadrant(x, y);
  const cx = x + 26, cy = y + 26;
  // the source chip owns a FIXED slot under the floater: its position never
  // depends on how many colours the fan shows, and swatches are laid out
  // around it so the two can never overlap
  const chip = palChipPos(cx, cy, window.innerWidth, window.innerHeight);
  const chipArea = chipBox(chip.x, chip.y);
  // neat lattice: regular grid clipped to an annulus sector (R0..R1 inside the quadrant)
  // pack tightly around the floater: candidates sorted by distance, take only what the palette needs
  const G = 32, R0 = 46, RMAX = 340;
  const cand: Array<{ du: number; dv: number; r: number }> = [];
  for (let i = 0; (i + 0.5) * G <= RMAX; i++) {
    for (let j = 0; (j + 0.5) * G <= RMAX; j++) {
      const du = (i + 0.5) * G, dv = (j + 0.5) * G;
      const r = Math.hypot(du, dv);
      if (r < R0 || r > RMAX) continue;
      if (swatchHitsChip(cx + sx * du, cy + sy * dv, chipArea)) continue; // keep the chip slot clear
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
  return (
    <div className="radial-layer">
      {items.map((it) => {
        const c = it.c;
        const cur = c[0] === SESSION.color[0] && c[1] === SESSION.color[1] && c[2] === SESSION.color[2];
        return (
          <button key={"pb" + mode + it.i} className={"orb-item pal-c" + (cur ? " on" : "")} style={{ left: it.px, top: it.py, background: chipCss(c), "--st": (Math.min(it.i, 40) * 8) + "ms" } as unknown as React.CSSProperties} title={rgbaToHex(c)} onContextMenu={(e) => e.preventDefault()}
            onClick={() => { SESSION.setFgColor([c[0], c[1], c[2], 255]); onDone(); }} />
        );
      })}
      {!items.length && (
        <div className="orb-modechip orb-modeempty"
          style={{ left: chipX, top: Math.max(14, Math.min(window.innerHeight - 14, chipY > cy ? chipY + 26 : chipY - 26)) }}>
          {mode === "doc" ? t("palEmptyDoc") : t("palEmptyRecent")}
        </div>
      )}
      <button type="button" className="orb-modechip" data-guide="pal-mode-chip" style={{ left: chipX, top: chipY }} title={t("palModeTap")}
        onClick={(e) => { e.stopPropagation(); SESSION.cyclePalOrbMode(); }}>
        {label}
      </button>
    </div>
  );
}





const SYM_GLYPH: Record<string, string> = { off: "·", on: "⇋" };
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
        {snap.tool === "polygon" && <HoldAdjust dir={dir} value={SESSION.shapeSides} min={3} max={32} title={t("sides")} hint={bd(snap.lang, "sides")} format={(v) => "◮" + v} reset={6} onChange={(v) => SESSION.setShapeSides(v)} />}
        {isShapeTool(snap.tool) && snap.tool !== "line" && (
          <Btn label="✛" active={SESSION.shapeFromCenter} onClick={() => SESSION.setShapeFromCenter(!SESSION.shapeFromCenter)}
            title={t(SESSION.shapeFromCenter ? "shapeFromCenterOn" : "shapeFromCenterOff")} />
        )}
        {snap.tool === "bucket" && <Btn label={SESSION.prefs.bucketGlobal ? "∞" : "◎"} active={SESSION.prefs.bucketGlobal} onClick={() => SESSION.setBucketGlobal(!SESSION.prefs.bucketGlobal)} title={SESSION.prefs.bucketGlobal ? t("bucketGlobalOn") : t("bucketGlobalOff")} />}
        {isShapeTool(snap.tool) && snap.tool !== "line" && <Btn icon={SESSION.shapeFill ? "i-rect" : "i-rectfill"} onClick={() => SESSION.setShapeFill(!SESSION.shapeFill)} title={SESSION.shapeFill ? t("shapeHollow") : t("shapeSolid")} />}
      </div>
    </section>
  );
}
function Viewport({ onColorClick, refImg, onRefClose, onFramePrev }: { onColorClick: () => void; refImg: RefImg | null; onRefClose: () => void; onFramePrev: () => void }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<View | null>(null);
  const tv = makeT(SESSION.prefs.lang as Lang);
  const [, setTick] = useState(0);
  const onFpRef = useRef(onFramePrev);
  onFpRef.current = onFramePrev;
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const v = new View(host, SESSION);
    viewRef.current = v;
    // four-finger swipe-up opens the all-frames preview
    v.onFramePreview = () => onFpRef.current();
    SESSION.attachView(v);
    v.fit();
    const iv = window.setInterval(() => setTick((x) => x + 1), 300);
    return () => { window.clearInterval(iv); v.destroy(); viewRef.current = null; };
  }, []);
  const symOn = SESSION.sym !== "off" && isSymTool(SESSION.tool);
  const c = SESSION.color;
  const visible = SESSION.colorPickedRecently(Date.now(), 1600);
  return (
    <section className="viewport">
      <div className="view-canvas" ref={hostRef} />
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
        <span className="zoom-pct">{Math.round((viewRef.current?.zoom ?? 8) * 100)}%</span>
        <button className="zoom-fit" type="button" title={tv("fitView")} onClick={() => { const v = viewRef.current; if (v) { v.fit(); v.refresh(false); } }}>{tv("fitView")}</button>
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