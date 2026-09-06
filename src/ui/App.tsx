import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { SESSION } from "./singleton";
import type { Snapshot } from "../app/session";
import { makeT } from "./i18n";
import type { Lang } from "./i18n";
import { CORE_TOOLS, SHAPE_TOOLS, SELECT_TOOLS, isShapeTool, isSelectTool } from "../tools/registry";
import { View } from "../render/view";
import { Doc } from "../engine/doc";
import { Cel } from "../engine/cel";
import { rgbaToHex, hexToRgba, cssColor } from "../engine/color";
import * as selOps from "../tools/select";
import { BLEND_MODES } from "../engine/types";
import { HsvWheel, colorToHex6 } from "./HsvWheel";
import * as compositor from "../render/compositor";
import { tryReadGif } from "../io/gifread";
import { HoldAdjust, ColorHoldChip, hsvToRgb } from "./hold";
import { PALETTE_PACKS } from "./palettes";
import { ReplayOverlay } from "./replay";
import { hexToRgba as hrgb } from "../engine/color";
import * as project from "../io/project";
import * as exporters from "../io/exporters";
import * as bridge from "../io/bridge";
import { writeClipboardPng, readClipboardImage } from "../io/clipboard";
import { showTip, hideTip, subscribeTip } from "./tooltip";
import { Icon, Btn, TipHost, Keep, Overlay, useSession, useLandscape } from "./base";
import { TimelineBar } from "./timeline";
import { PreviewBox } from "./preview";

type PanelId = "layers" | "palette" | null;
type ModalId = "menu" | "newdoc" | "export" | "adjust" | "settings" | "help" | "frame" | "size" | "sheet" | "history" | null;
type SizeMode = "canvas" | "sprite";
type SheetData = { w: number; h: number; px: Uint8ClampedArray; name: string };


export function App() {
  const snap = useSession();
  const t = useMemo(() => makeT(snap.lang as Lang), [snap.lang]);
  const [panel, setPanel] = useState<PanelId>(null);
  const [modal, setModal] = useState<ModalId>(null);
  const [frameDlgIdx, setFrameDlgIdx] = useState<number | null>(null);
  const [tlOn, setTlOn] = useState(true);
  const [sizeMode, setSizeMode] = useState<SizeMode>("canvas");
  const [sheet, setSheet] = useState<SheetData | null>(null);
  const [replayOn, setReplayOn] = useState(false);
  const [confirmQ, setConfirmQ] = useState<{ msg: string; yes: string; no: string; res: (ok: boolean) => void } | null>(null);

  useEffect(() => {
    SESSION.setConfirmAsk((q) => new Promise<boolean>((resolve) => setConfirmQ({ msg: q.msg, yes: q.yes, no: q.no, res: resolve })));
    return () => SESSION.setConfirmAsk(null);
  }, []);

  return (
    <div className={"app-root" + (SESSION.prefs.railSwap ? " rails-swap" : "")} onContextMenu={(e) => e.preventDefault()} onDragStart={(e) => e.preventDefault()}>
      <TopBar t={t} snap={snap} tlOn={tlOn} onToggleTl={() => setTlOn(!tlOn)} onMenu={() => setModal("menu")} onExport={() => setModal("export")} onResize={() => { setSizeMode("canvas"); setModal("size"); }} onHistory={() => setModal("history")} />
      <div className="workspace">
        <Viewport
          onColorClick={() => setPanel("palette")}
        />
      </div>
      <ControlBar t={t} snap={snap} onPanel={setPanel} onAdjust={() => setModal("adjust")} />
      {tlOn && (
      <div className="tline-wrap">
        <TimelineBar t={t} snap={snap} onFrameDlg={setFrameDlgIdx} />
      </div>
      )}
      <FloatingTools t={t} snap={snap} />
      {replayOn && <ReplayOverlay t={t} snap={snap} nameFn={(lb) => histName(lb, t, snap.lang)} onClose={() => { setModal(null); setReplayOn(false); }} />}
      <Keep on={panel === "palette"} el={panel === "palette" ? (
        <Overlay onClose={() => setPanel(null)}>
          <PalettePanel t={t} onClose={() => setPanel(null)} />
        </Overlay>
      ) : null} />
      <Keep on={modal === "menu"} el={modal === "menu" ? <MenuModal t={t} snap={snap} onClose={() => setModal(null)} onOpen={setModal} onSheet={(d) => { setSheet(d); setModal("sheet"); }} /> : null} />
      <Keep on={modal === "size"} el={modal === "size" ? <SizeModal t={t} snap={snap} initial={sizeMode} onClose={() => setModal(null)} /> : null} />
      <Keep on={modal === "sheet" && sheet !== null} el={modal === "sheet" && sheet ? <SheetModal t={t} img={sheet} onClose={() => { setModal(null); setSheet(null); }} /> : null} />
      <Keep on={modal === "newdoc"} el={modal === "newdoc" ? <NewDocModal t={t} onClose={() => setModal(null)} /> : null} />
      <Keep on={modal === "export"} el={modal === "export" ? <ExportModal t={t} snap={snap} onClose={() => setModal(null)} /> : null} />
      <Keep on={modal === "settings"} el={modal === "settings" ? <SettingsModal t={t} onClose={() => setModal(null)} /> : null} />
      <Keep on={modal === "adjust"} el={modal === "adjust" ? <AdjustModal t={t} onClose={() => setModal(null)} /> : null} />
      <Keep on={modal === "help"} el={modal === "help" ? <HelpModal t={t} onClose={() => setModal(null)} /> : null} />
      <Keep on={frameDlgIdx !== null} el={frameDlgIdx !== null ? <FrameModal t={t} snap={snap} fi={frameDlgIdx} onClose={() => setFrameDlgIdx(null)} /> : null} />
      <Keep on={modal === "history"} el={modal === "history" ? <HistoryModal t={t} snap={snap} onClose={() => setModal(null)} onReplay={() => { setModal(null); setReplayOn(true); }} /> : null} />
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
  menu: { zh: "打开主功能菜单（新建 / 打开 / 导入导出 / 设置 / 帮助）", en: "Open the main menu" },
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
      <Btn icon="i-gear" onClick={onMenu} title={t("menu")} desc={bd(snap.lang, "menu")} />
      <div className="grow" />
      <Btn icon="i-history" onClick={onHistory} title={t("historyTitle")} desc={bd(snap.lang, "hist")} />
      <Btn icon="i-undo" onClick={() => SESSION.undo()} title={t("undo")} desc={bd(snap.lang, "undo")} className={snap.canUndo ? "" : "off"} />
      <Btn icon="i-redo" onClick={() => SESSION.redo()} title={t("redo")} desc={bd(snap.lang, "redo")} className={snap.canRedo ? "" : "off"} />
      <Btn icon="i-export" onClick={onExport} title={t("export")} desc={bd(snap.lang, "export")} />
      <Btn icon="i-save" onClick={saveProject} title={t("save")} desc={bd(snap.lang, "save")} />
      <Btn icon="i-timeline" onClick={onToggleTl} active={tlOn} title={t(tlOn ? "timelineHide" : "timelineShow")} />
      <Btn icon="i-size" onClick={onResize} title={t("resizeTitle")} desc={bd(snap.lang, "resize")} />
      <Btn icon={fs ? "i-fsexit" : "i-fit"} onClick={() => void toggleFs()} title={t(fs ? "exitFullscreen" : "fullscreen")} desc={bd(snap.lang, "fs")} className={fs ? "fs-on" : ""} />
    </header>
  );
}

async function saveProject(): Promise<void> {
  const doc = SESSION.doc;
  const txt = await project.serialize(doc);
  const bytes = new TextEncoder().encode(txt);
  bridge.saveBytes((doc.name || "art") + ".pxc", "application/json", bytes, (ok) =>
    bridge.toast(ok ? makeT(SESSION.prefs.lang)("saved") : makeT(SESSION.prefs.lang)("saveCancel"))
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
  const drag = useRef<{ which: "main" | "sel" | "pal"; dx: number; dy: number; moved: boolean } | null>(null);

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
    if (family === "shape") SESSION.currentShape = id as never;
    else if (family === "select") SESSION.currentSelect = id as never;
    setOpen(false);
    setSub(null);
    if (sel) setSel({ ...sel, open: false });
  };

  const closeRadials = () => {
    setOpen(false);
    setSub(null);
    if (sel) setSel({ ...sel, open: false });
    if (pal) setPal({ ...pal, open: false });
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

  const moveBall = (which: "main" | "sel" | "pal", nx: number, ny: number) => {
    const others: { x: number; y: number }[] = [];
    if (which !== "main") others.push(pos);
    if (sel && which !== "sel") others.push({ x: sel.x, y: sel.y });
    if (pal && which !== "pal") others.push({ x: pal.x, y: pal.y });
    let p = clampXY({ x: nx, y: ny });
    for (const o of others) p = separate(p, o);
    if (which === "main") {
      setPos(p);
      try { localStorage.setItem(orbKey, JSON.stringify(p)); } catch { /* ignore */ }
    } else if (which === "sel") {
      setSel({ x: p.x, y: p.y, open: false });
    } else {
      setPal((g) => ({ ...g, x: p.x, y: p.y, open: false }));
    }
    setOpen(false);
    setSub(null);
    if (sel && which !== "sel") setSel((s) => (s ? { ...s, open: false } : s));
    if (pal && which !== "pal") setPal((g) => (g ? { ...g, open: false } : g));
  };

  type Item = { icon: string; label: string; act: () => void; active?: boolean; desc?: string };
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
    { icon: "i-x", label: t("sel.clear"), act: () => { selOps.selOps.clear(d); SESSION.repaint(); } },
    { icon: "i-bucket", label: t("sel.fill"), act: () => { selOps.selOps.fill(d, SESSION.history, li, fi, SESSION.color); repaintChanged(); } },
    { icon: "i-dupe", label: t("sel.copy"), act: () => { const c = selOps.selOps.copy(d, li, fi); SESSION.clip = c; if (c) void writeClipboardPng(compositor.celToCanvas(c)).then((ok) => bridge.toast(ok ? t("sysCopy") : t("copied"))); } },
    { icon: "i-pencil", label: t("sel.cut"), act: () => { const c = selOps.selOps.cut(d, SESSION.history, li, fi); SESSION.clip = c; if (c) { repaintChanged(); void writeClipboardPng(compositor.celToCanvas(c)).then((ok) => bridge.toast(ok ? t("sysCopy") : t("cut"))); } } },
    { icon: "i-import", label: t("sel.paste"), act: () => { if (SESSION.clip) { selOps.selOps.paste(d, SESSION.history, li, fi, SESSION.clip); repaintChanged(); bridge.toast(t("pasted")); } else bridge.toast(t("noSel")); } },
    { icon: "i-fliph", label: t("sel.fliph"), act: () => { selOps.selOps.flip(d, SESSION.history, li, fi, true); repaintChanged(); } },
    { icon: "i-flipv", label: t("sel.flipv"), act: () => { selOps.selOps.flip(d, SESSION.history, li, fi, false); repaintChanged(); } },
    { icon: "i-plus", label: t("sel.grow"), act: () => SESSION.maskOp("sel.grow", () => selOps.growSelection(d, 1)) },
    { icon: "i-minus", label: t("sel.shrink"), act: () => SESSION.maskOp("sel.shrink", () => selOps.shrinkSelection(d, 1)) },
    { icon: "i-paint", label: t("sel.outline"), act: () => { selOps.outlineSelected(d, SESSION.history, li, fi, SESSION.color); repaintChanged(); } },
  ];

  const mainItems: Item[] = sub
    ? [
        { icon: "", label: "\u2039", act: () => setSub(null) },
        ...(sub === "shape" ? SHAPE_TOOLS : SELECT_TOOLS).map((dd) => ({ icon: dd.icon, label: t("tools." + dd.id), desc: td(dd.id), act: () => pickTool(sub, dd.id), active: snap.tool === dd.id })),
      ]
    : [
        ...CORE_TOOLS.map((dd) => ({ icon: dd.icon, label: t("tools." + dd.id), desc: td(dd.id), act: () => pickTool("core", dd.id), active: snap.tool === dd.id })),
        { icon: defOf(snap.shape)?.icon || "i-rect", label: t("shapeGroup"), desc: snap.lang === "zh" ? "图形工具：直线 / 矩形 / 椭圆" : "Shape tools: line / rect / ellipse", act: () => { setSub("shape"); if (sel) setSel({ ...sel, open: false }); }, active: isShapeTool(snap.tool) },
        { icon: (snap.tool !== "line" && isSelectTool(snap.tool) ? defOf(snap.tool)?.icon : defOf(SESSION.currentSelect)?.icon) || "i-select", label: t("sel.active"), desc: snap.lang === "zh" ? "选区工具：框选 / 魔棒 / 套索" : "Select tools: rect / wand / lasso", act: () => { setSub("select"); if (sel) setSel({ ...sel, open: false }); }, active: isSelectTool(snap.tool) },
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
    which: "main" | "sel" | "pal",
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
        if (dr.moved) { stopTip(); moveBall(which, e.clientX - dr.dx, e.clientY - dr.dy); }
      }}
      onPointerUp={() => {
        stopTip();
        const dr = drag.current;
        if (dr && dr.which === which) {
          if (!dr.moved) tap();
          drag.current = null;
        }
      }}
      onPointerCancel={() => {
        stopTip();
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
            className={"orb-item" + (it.active ? " on" : "")}
            style={{ left: pt.x, top: pt.y, "--st": (i * 16) + "ms" } as unknown as React.CSSProperties}
            title={it.label}
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
      {renderBall("main", pos, baseIcon, open, t("menu"), bd(snap.lang, "orb"), () => {
        if (open) { setOpen(false); setSub(null); return; }
        if (sel) {
          const pushed = clearRingOf(pos, { x: sel.x, y: sel.y });
          if (pushed) setSel({ ...pushed, open: false });
        }
        if (pal) {
          const pushed2 = clearRingOf(pos, { x: pal.x, y: pal.y });
          if (pushed2) setPal({ ...pushed2, open: false });
        }
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
        }
        setSel({ ...sel, open: !sel.open });
      }) : null} />
      {renderBall("pal", { x: pal.x, y: pal.y }, "i-palette", pal.open, t("palette"), bd(snap.lang, "palette"), () => {
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
        }
        setPal({ ...pal, open: !pal.open });
      })}
      {(open || (sel && sel.open) || pal.open) && (
        <div className="radial-back" onPointerDown={closeRadials} />
      )}
      <Keep on={open} el={open ? ring(pos, mainItems) : null} />
      <Keep on={!!sel && sel.open} el={sel && sel.open ? ring({ x: sel.x, y: sel.y }, selItems) : null} />
      <Keep on={pal.open} el={pal.open ? <PalBalls x={pal.x} y={pal.y} onDone={() => setPal({ ...pal, open: false })} /> : null} />
    </>
  );
}




/** quarter-fan colour picker for the palette floater */
/** palette floater: big outward quarter-fan or coloured-ball cloud */
/** palette floater: palette-coloured balls laid out in an outward quarter-fan */
function palQuadrant(x: number, y: number) {
  const right = window.innerWidth - (x + 52) >= x;
  const bottom = window.innerHeight - (y + 52) >= y;
  return { sx: right ? 1 : -1, sy: bottom ? 1 : -1 };
}
function PalBalls({ x, y, onDone }: { x: number; y: number; onDone: () => void }) {
  const colors = SESSION.doc.palette;
  if (!colors.length) return null;
  const { sx, sy } = palQuadrant(x, y);
  const cx = x + 26, cy = y + 26;
  // neat lattice: regular grid clipped to an annulus sector (R0..R1 inside the quadrant)
  // pack tightly around the floater: candidates sorted by distance, take only what the palette needs
  const G = 32, R0 = 46, RMAX = 340;
  const cand: Array<{ du: number; dv: number; r: number }> = [];
  for (let i = 0; (i + 0.5) * G <= RMAX; i++) {
    for (let j = 0; (j + 0.5) * G <= RMAX; j++) {
      const du = (i + 0.5) * G, dv = (j + 0.5) * G;
      const r = Math.hypot(du, dv);
      if (r >= R0 && r <= RMAX) cand.push({ du, dv, r });
    }
  }
  cand.sort((a, b) => a.r - b.r || Math.atan2(a.dv, a.du) - Math.atan2(b.dv, b.du));
  const n = Math.min(colors.length, cand.length);
  const pts = cand.slice(0, n);
  const items: Array<{ c: [number, number, number, number]; px: number; py: number; i: number }> = [];
  for (let k = 0; k < n; k++) {
    const p = pts[k];
    const c = colors[k];
    items.push({ c, px: Math.round(cx + sx * p.du) - 15, py: Math.round(cy + sy * p.dv) - 15, i: k });
  }
  if (!items.length) return null;
  return (
    <div className="radial-layer">
      {items.map((it) => {
        const c = it.c;
        const cur = c[0] === SESSION.color[0] && c[1] === SESSION.color[1] && c[2] === SESSION.color[2];
        return (
          <button key={"pb" + it.i} className={"orb-item pal-c" + (cur ? " on" : "")} style={{ left: it.px, top: it.py, background: "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")", "--st": (Math.min(it.i, 40) * 8) + "ms" } as unknown as React.CSSProperties} title={rgbaToHex(c)} onContextMenu={(e) => e.preventDefault()}
            onClick={() => { SESSION.setFgColor([c[0], c[1], c[2], c[3]]); onDone(); }} />
        );
      })}
    </div>
  );
}





const SYM_GLYPH: Record<string, string> = { off: "·", lr: "↔", tb: "↕", both: "✳" };
function ControlBar({ t, snap, onPanel, onAdjust }: { t: ReturnType<typeof makeT>; snap: Snapshot; onPanel: (p: PanelId) => void; onAdjust: () => void }) {
  const land = useLandscape();
  const dir: "h" | "v" = land ? "v" : "h";
  const sym: "off" | "lr" | "tb" | "both" = SESSION.sym;
  const symKey = { off: "sym.off", lr: "sym.lr", tb: "sym.tb", both: "sym.both" } as const;
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
            style={{ background: cssColor(SESSION.colorTarget === "bg" ? SESSION.fg : SESSION.bg) }} />
        </div>
        <Btn label="⇄" className="swap-color" title={t("swapColors")} onClick={() => SESSION.swapColors()} />
        <Btn icon="i-adjust" onClick={onAdjust} title={t("adjust")} />
        <Btn label={SYM_GLYPH[sym]} className="sym-toggle" active={sym !== "off"} title={t(symKey[sym])} desc={bd(snap.lang, "sym")} onClick={() => { const m = SESSION.cycleSym(); bridge.toast(t(symKey[m])); }} />
      </div>
      <div className="cb-sliders">
        <HoldAdjust dir={dir} value={snap.brushSize} min={1} max={64} title={t("brushSize")} hint={bd(snap.lang, "brush")} format={(v) => "◉" + v} onChange={(v) => SESSION.setBrushSize(v)} />
        <HoldAdjust dir={dir} value={snap.brushAlpha} min={0} max={255} title={t("opacity")} hint={bd(snap.lang, "alpha")} format={(v) => "◐" + v} onChange={(v) => SESSION.setBrushAlpha(v)} />
        {snap.tool === "polygon" && <HoldAdjust dir={dir} value={SESSION.shapeSides} min={3} max={12} title={t("sides")} hint={bd(snap.lang, "sides")} format={(v) => "◮" + v} onChange={(v) => SESSION.setShapeSides(v)} />}
        {isShapeTool(snap.tool) && snap.tool !== "line" && <Btn icon={SESSION.shapeFill ? "i-rect" : "i-rectfill"} onClick={() => SESSION.setShapeFill(!SESSION.shapeFill)} title={SESSION.shapeFill ? t("shapeHollow") : t("shapeSolid")} />}
      </div>
    </section>
  );
}
function Viewport({ onColorClick }: { onColorClick: () => void }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const tv = makeT(SESSION.prefs.lang as Lang);
  const [, setTick] = useState(0);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const v = new View(host, SESSION);
    SESSION.attachView(v);
    v.fit();
    const iv = window.setInterval(() => setTick((x) => x + 1), 300);
    return () => { window.clearInterval(iv); v.destroy(); };
  }, []);
  const c = SESSION.color;
  const visible = SESSION.colorPickedRecently(Date.now(), 1600);
  return (
    <section className="viewport">
      <div className="view-canvas" ref={hostRef} />
      <PreviewBox />
      {visible && (
        <div className="canvas-corner">
          <button className="colorbox" onClick={onColorClick} title={tv("colorPicked")}>
            <span className="cb-swatch" style={{ background: cssColor([c[0], c[1], c[2], 255]) }} />
            <span className="cb-hex">{rgbaToHex(c)}</span>
          </button>
        </div>
      )}
    </section>
  );
}
function PalettePanel({ t, onClose }: { t: ReturnType<typeof makeT>; onClose: () => void }) {
  const doc = SESSION.doc;
  const active = SESSION.currentColor();
  const [hex, setHex] = useState(rgbaToHex(active));
  const alpha = active[3];
  const apply = (c: [number, number, number, number]) => { SESSION.setColor(c); setHex(rgbaToHex(c)); };
  // long-press a swatch to recolor it and remap matching pixels across the sprite
  const [recolor, setRecolor] = useState<{ i: number } | null>(null);
  const [recColor, setRecColor] = useState("#ffffff");
  const longRef = useRef<{ i: number; t: number } | null>(null);
  const skipRef = useRef(false);
  return (
    <>
      <div className="panel-head"><span>{t("palette")}</span><div className="grow" /><button className="btn small" onClick={onClose}><Icon id="i-x" size={16} /></button></div>
      <div className="panel-body">
        <HsvWheel color={active} onChange={apply} />
        <div className="ce-row">
          <span className="ce-hex">#</span>
          <input className="hexinput" value={hex.replace(/^#/, "")} onChange={(e) => {
            const v = e.target.value.replace(/[^0-9a-fA-F]/g, "").slice(0, 8);
            setHex(v ? "#" + v : "#");
            if (v.length >= 6) { const c = hrgb(v); SESSION.setColor([c[0], c[1], c[2], v.length === 8 ? c[3] : alpha]); }
          }} />
          <input type="color" value={colorToHex6(active)} onChange={(e) => { const c = hrgb(e.target.value); apply([c[0], c[1], c[2], alpha]); }} />
        </div>
        <label className="rowlabel">{t("presets")}</label>
        <div className="preset-list">
          {PALETTE_PACKS.map((pack) => (
            <button key={pack.id} className="preset-row" onClick={() => SESSION.setPalette(pack.colors.map((hc) => { const x = hexToRgba(hc); return [x[0], x[1], x[2], x[3]]; }))}>
              <span className="preset-name">{SESSION.prefs.lang === "zh" ? pack.nameZh : pack.nameEn}</span>
              <span className="preset-dots">{pack.colors.slice(0, 6).map((hc, i) => <i key={i} style={{ background: hc }} />)}</span>
            </button>
          ))}
        </div>
        <div className="palgrid">
          {doc.palette.map((c, i) => {
            const cur = c[0] === active[0] && c[1] === active[1] && c[2] === active[2];
            return <button key={i} className={"palcell" + (cur ? " on" : "")} style={{ background: "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")" }} title={rgbaToHex(c)} onContextMenu={(e) => { e.preventDefault(); SESSION.paletteRemove(i); }}
              onPointerDown={() => { longRef.current = { i, t: Date.now() }; }}
              onPointerUp={() => { const l = longRef.current; longRef.current = null; if (l && l.i === i && Date.now() - l.t >= 420) { skipRef.current = true; setRecColor(rgbaToHex(c).slice(0, 7)); setRecolor({ i }); } }}
              onClick={() => { if (skipRef.current) { skipRef.current = false; return; } apply(c); }} />;
          })}
        </div>
        {recolor !== null && doc.palette[recolor.i] && (
          <div className="recolor-row">
            <label className="rowlabel">{t("recolor")} · 旧色 #{rgbaToHex(doc.palette[recolor.i]).slice(1)}</label>
            <div className="ce-row">
              <input type="color" value={recColor} onChange={(e) => setRecColor(e.target.value)} />
              <span className="ce-hex">{recColor}</span>
            </div>
            <div className="row-actions">
              <Btn label={t("recolorApply")} className="primary" onClick={() => { SESSION.recolorPaletteColor(recolor.i, hexToRgba(recColor)); setRecolor(null); }} />
              <Btn label={t("cancel")} onClick={() => setRecolor(null)} />
            </div>
          </div>
        )}
        <div className="row-actions">
          <Btn icon="i-plus" label={t("paletteAdd")} onClick={() => SESSION.paletteAdd(active)} />
          <Btn icon="i-open" label={t("importPalette")} onClick={() => void (async () => {
            const f = await bridge.openFile("*/*");
            if (!f) return;
            const colors = parsePaletteBytes(f.bytes);
            if (!colors.length) { bridge.toast(t("importFail")); return; }
            SESSION.setPalette(colors);
            bridge.toast(t("importOk"));
          })()} />
          <Btn icon="i-save" label={t("exportPalette")} onClick={() => { bridge.saveBytes((SESSION.doc.name || "palette") + ".gpl", "text/plain", exportGplPalette()); bridge.toast(t("saved")); }} />
        </div>
      </div>
    </>
  );
}
function headOf(bytes: Uint8Array): string { return String.fromCharCode.apply(null, bytes.subarray(0, 6) as unknown as number[]); }
function isGifHeader(b: Uint8Array): boolean { const h = headOf(b); return h === "GIF87a" || h === "GIF89a"; }
async function decodeStill(bytes: Uint8Array, mime: string): Promise<{ w: number; h: number; px: Uint8ClampedArray } | null> {
  return new Promise((res) => {
    const blob = new Blob([bytes as BlobPart], { type: mime || "image/png" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); const w = img.naturalWidth, h = img.naturalHeight; const c = document.createElement("canvas"); c.width = w; c.height = h; const ctx = c.getContext("2d")!; ctx.drawImage(img, 0, 0); res({ w, h, px: new Uint8ClampedArray(ctx.getImageData(0, 0, w, h).data) }); };
    img.onerror = () => { URL.revokeObjectURL(url); res(null); };
    img.src = url;
  });
}
function docFromPixels(w: number, h: number, px: Uint8ClampedArray, name: string, delayMs = 100): Doc {
  const doc = new Doc(w, h, name.replace(/\.[^.]+$/, "") || "img");
  doc.palette = SESSION.doc.palette.map((c) => [...c] as never);
  doc.frames = [{ id: "f1", durationMs: delayMs }];
  doc.cels = new Map();
  const cel = doc.ensureCel(0, 0);
  cel.data.set(px.subarray(0, Math.min(cel.data.length, px.length)));
  return doc;
}
function docFromGifFrames(w: number, h: number, datas: Uint8Array[], delays: number[], name: string): Doc {
  const doc = new Doc(w, h, name.replace(/\.[^.]+$/, "") || "img");
  doc.palette = SESSION.doc.palette.map((c) => [...c] as never);
  doc.frames = datas.map((_, i) => ({ id: "f" + i, durationMs: delays[i] || 100 }));
  doc.cels = new Map();
  datas.forEach((d, i) => { const cel = doc.ensureCel(0, i); cel.data.set(d.subarray(0, Math.min(cel.data.length, d.length))); });
  return doc;
}
function addAsLayer(w: number, h: number, px: Uint8ClampedArray, name: string): boolean {
  const d = SESSION.doc;
  if (w !== d.w || h !== d.h) return false;
  SESSION.struct("import-layer", () => {
    const li = d.layers.length;
    d.layers.push({ id: Math.random().toString(36).slice(2), name: name.replace(/\.[^.]+$/, ""), visible: true, opacity: 100, blend: "normal", locked: false });
    const cel = d.ensureCel(li, SESSION.curFrame());
    cel.data.set(px.subarray(0, Math.min(cel.data.length, px.length)));
    SESSION.layerIdx = li;
  });
  return true;
}
async function openFlow(mode: "new" | "layer"): Promise<void> {
  const t = makeT(SESSION.prefs.lang);
  const f = await bridge.openFile("*/*");
  if (!f) return;
  const ext = (f.name || "").split(".").pop()?.toLowerCase();
  const isGif = ext === "gif" || isGifHeader(f.bytes);
  if (!isGif && (ext === "pxc" || f.name.toLowerCase().endsWith(".pxc") || ext === "json")) {
    if (mode !== "new") { bridge.toast(t("importFail")); return; }
    const txt = new TextDecoder().decode(f.bytes);
    const doc = await project.parse(txt);
    if (doc) { if (await SESSION.replaceDoc(doc)) bridge.toast(t("docLoaded")); } else bridge.toast(t("importFail"));
    return;
  }
  if (isGif) {
    const gif = tryReadGif(f.bytes);
    if (gif) {
      if (mode === "new") { if (await SESSION.replaceDoc(docFromGifFrames(gif.w, gif.h, gif.frames, gif.delays, f.name))) bridge.toast(t("importOk") + " " + gif.frames.length + "f"); }
      else { if (!addAsLayer(gif.w, gif.h, gif.frames[0] as unknown as Uint8ClampedArray, f.name)) bridge.toast(t("importFail") + " (size)"); else bridge.toast(t("importOk")); }
      return;
    }
  }
  const still = await decodeStill(f.bytes, f.mime || "image/png");
  if (!still) { bridge.toast(t("importFail")); return; }
  if (mode === "layer") { if (!addAsLayer(still.w, still.h, still.px, f.name)) bridge.toast(t("importFail") + " (size)"); else bridge.toast(t("importOk")); }
  else { if (await SESSION.replaceDoc(docFromPixels(still.w, still.h, still.px, f.name))) bridge.toast(t("importOk")); }
}
function importFlow(): Promise<void> { return openFlow("new"); }
function importLayerFlow(): Promise<void> { return openFlow("layer"); }
function sheetDocFromPixels(cw: number, ch: number, img: SheetData): Doc | null {
  const cols = Math.floor(img.w / cw); const rows = Math.floor(img.h / ch);
  if (cols < 1 || rows < 1) return null;
  const doc = new Doc(cw, ch, (img.name.replace(/\.[^.]+$/, "") || "sheet") + "_s");
  doc.palette = SESSION.doc.palette.map((c) => [c[0], c[1], c[2], c[3]]);
  doc.frames = Array.from({ length: cols * rows }, () => ({ id: Math.random().toString(36).slice(2), durationMs: 100 }));
  doc.cels = new Map();
  for (let fi = 0; fi < cols * rows; fi++) {
    const col = fi % cols; const row = (fi / cols) | 0;
    const cel = new Cel(cw, ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const si = ((row * ch + y) * img.w + (col * cw + x)) * 4; const di = cel.idx(x, y);
      cel.data[di] = img.px[si]; cel.data[di + 1] = img.px[si + 1]; cel.data[di + 2] = img.px[si + 2]; cel.data[di + 3] = img.px[si + 3];
    }
    doc.cels.set(doc.key(0, fi), cel);
  }
  return doc;
}
function exportGplPalette(): Uint8Array {
  const doc = SESSION.doc;
  const lines = ["GIMP Palette", "Name: " + (doc.name || "pixelcraft"), "Columns: 8", "#"];
  for (const c of doc.palette) lines.push(c[0] + " " + c[1] + " " + c[2] + "\t#" + rgbaToHex(c).slice(1));
  return new TextEncoder().encode(lines.join("\n") + "\n");
}
function parsePaletteBytes(b: Uint8Array): Array<[number, number, number, number]> {
  const txt = new TextDecoder().decode(b);
  const out: Array<[number, number, number, number]> = [];
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || out.length >= 512) continue;
    const hexM = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.exec(line);
    if (hexM) { let hx = hexM[1]; if (hx.length === 3) hx = hx[0] + hx[0] + hx[1] + hx[1] + hx[2] + hx[2]; const n = parseInt(hx, 16); out.push([(n >> 16) & 255, (n >> 8) & 255, n & 255, 255]); continue; }
    const rgbM = /^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})/.exec(line);
    if (rgbM) out.push([+rgbM[1], +rgbM[2], +rgbM[3], 255]);
  }
  return out;
}
function MenuModal({ t, snap, onClose, onOpen, onSheet }: { t: ReturnType<typeof makeT>; snap: Snapshot; onClose: () => void; onOpen: (m: ModalId) => void; onSheet: (d: SheetData) => void }) {
  const go = (modal: ModalId) => (label: string, icon: string) => <Btn label={label} icon={icon} onClick={() => onOpen(modal)} className="menuitem" />;
  const act = (label: string, icon: string, fn: () => void) => <Btn label={label} icon={icon} onClick={() => { fn(); onClose(); }} className="menuitem" />;
  const sheetPick = async () => {
    const f = await bridge.openFile("*/*");
    if (!f) return;
    if (isGifHeader(f.bytes)) { bridge.toast(t("importFail")); return; }
    const st = await decodeStill(f.bytes, f.mime || "image/png");
    if (!st) { bridge.toast(t("importFail")); return; }
    onSheet({ w: st.w, h: st.h, px: st.px, name: f.name || "sheet" });
  };
  const importPaletteFlow = async () => {
    const f = await bridge.openFile("*/*");
    if (!f) return;
    const colors = parsePaletteBytes(f.bytes);
    if (!colors.length) { bridge.toast(t("importFail")); return; }
    SESSION.setPalette(colors);
    bridge.toast(t("importOk"));
  };
  const exportPaletteFlow = () => { bridge.saveBytes((SESSION.doc.name || "palette") + ".gpl", "text/plain", exportGplPalette()); bridge.toast(t("saved")); };
  return (
    <>
      <div className="dlg-mask" onClick={onClose} />
      <div className="dlg">
        <div className="dlg-head"><span>{t("menu")}</span><div className="grow" /><button className="btn small" onClick={onClose}><Icon id="i-x" size={16} /></button></div>
        <div className="dlg-body col">
          {go("newdoc")(t("newDoc"), "i-new")}
          {act(t("save"), "i-save", () => void saveProject())}
          {act(t("open"), "i-open", () => void openFlow("new"))}
          {go("export")(t("export"), "i-export")}
          {act(t("importImg"), "i-import", () => void importFlow())}
          {act(t("importLayerM"), "i-layers", () => void importLayerFlow())}
          <Btn label={t("importSheet")} icon="i-open" className="menuitem" onClick={() => { void sheetPick(); }} />
          <Btn label={t("importPalette")} icon="i-palette" className="menuitem" onClick={() => { void importPaletteFlow(); }} />
          <Btn label={t("exportPalette")} icon="i-save" className="menuitem" onClick={() => { exportPaletteFlow(); }} />
          {go("adjust")(t("adjust"), "i-size")}
          {go("settings")(t("settings"), "i-gear")}
          {go("help")(t("helpTitle"), "i-eye")}
          <Btn label={t("clearFrame")} icon="i-eraser" onClick={() => { SESSION.clearActiveCel(); onClose(); }} className="menuitem danger" />
        </div>
      </div>
    </>
  );
}
function SizeModal({ t, snap, initial, onClose }: { t: ReturnType<typeof makeT>; snap: Snapshot; initial: SizeMode; onClose: () => void }) {
  const [mode, setMode] = useState<SizeMode>(initial);
  const [w, setW] = useState(String(SESSION.doc.w));
  const [h, setH] = useState(String(SESSION.doc.h));
  const [ax, setAx] = useState(0);
  const [ay, setAy] = useState(0);
  const [locked, setLocked] = useState(true);
  const ratio = SESSION.doc.h > 0 && SESSION.doc.w > 0 ? SESSION.doc.h / SESSION.doc.w : 1;
  const onW = (v: string) => { setW(v); if (locked) { const n = parseInt(v, 10); if (n > 0) setH(String(Math.max(1, Math.round(n * ratio)))); } };
  const onH = (v: string) => { setH(v); if (locked) { const n = parseInt(v, 10); if (n > 0) setW(String(Math.max(1, Math.round(n / ratio)))); } };
  const switchMode = (m: SizeMode) => { setMode(m); setW(String(SESSION.doc.w)); setH(String(SESSION.doc.h)); };
  const apply = () => { const nw = Math.max(1, Math.min(1024, parseInt(w, 10) || SESSION.doc.w)); const nh = Math.max(1, Math.min(1024, parseInt(h, 10) || SESSION.doc.h)); if (mode === "canvas") SESSION.canvasSize(nw, nh, ax as -1 | 0 | 1, ay as -1 | 0 | 1); else SESSION.spriteSize(nw, nh); onClose(); };
  const cell = (r: number, c: number) => { const on = ax === c - 1 && ay === r - 1; return <button key={r + "-" + c} className={"anchor" + (on ? " on" : "")} onClick={() => { setAx(c - 1); setAy(r - 1); }}><span className={"a-dot" + (on ? " on" : "")} /></button>; };
  return (
    <>
      <div className="dlg-mask" onClick={onClose} />
      <div className="dlg">
        <div className="dlg-head"><span>{t("resizeTitle")}</span><div className="grow" /><button className="btn small" onClick={onClose}><Icon id="i-x" size={16} /></button></div>
        <div className="dlg-body">
          <div className="chips">
            <button className={"chip" + (mode === "canvas" ? " on" : "")} onClick={() => switchMode("canvas")}>{t("canvasSize")}</button>
            <button className={"chip" + (mode === "sprite" ? " on" : "")} onClick={() => switchMode("sprite")}>{t("spriteSize")}</button>
          </div>
          <label className="rowlabel">{t("docs.w")}</label>
          <input type="number" min={1} max={1024} value={w} onChange={(e) => onW(e.target.value)} />
          <label className="rowlabel">{t("docs.h")}</label>
          <input type="number" min={1} max={1024} value={h} onChange={(e) => onH(e.target.value)} />
          <div className="chips"><button className={"chip" + (locked ? " on" : "")} onClick={() => setLocked(!locked)}>{t("lockRatio")}</button></div>
          {mode === "canvas" ? (<><label className="rowlabel">{t("anchor")}</label><div className="anchor-grid">{[0, 1, 2].map((r) => <div className="anchor-row" key={r}>{[0, 1, 2].map((c) => cell(r, c))}</div>)}</div><p className="size-note">{t("canvasNote")}</p></>) : <p className="size-note">{t("spriteNote")}</p>}
        </div>
        <div className="dlg-foot"><Btn label={t("cancel")} onClick={onClose} /><Btn label={t("ok")} onClick={apply} className="primary" /></div>
      </div>
    </>
  );
}
function SheetModal({ t, img, onClose }: { t: ReturnType<typeof makeT>; img: SheetData; onClose: () => void }) {
  const [cw, setCw] = useState("16");
  const [ch, setCh] = useState("16");
  const cwi = Math.max(1, Math.floor(parseInt(cw, 10) || 1));
  const chi = Math.max(1, Math.floor(parseInt(ch, 10) || 1));
  const cols = Math.floor(img.w / cwi); const rows = Math.floor(img.h / chi);
  const apply = async () => { const doc = sheetDocFromPixels(cwi, chi, img); if (!doc) { bridge.toast(t("importFail")); return; } if (await SESSION.replaceDoc(doc)) { bridge.toast(t("importOk")); onClose(); } };
  return (
    <>
      <div className="dlg-mask" onClick={onClose} />
      <div className="dlg">
        <div className="dlg-head"><span>{t("importSheet")}</span><div className="grow" /><button className="btn small" onClick={onClose}><Icon id="i-x" size={16} /></button></div>
        <div className="dlg-body">
          <div className="row-note">{img.name} · {img.w}×{img.h}</div>
          <label className="rowlabel">{t("sheetCellW")}</label>
          <input type="number" min={1} value={cw} onChange={(e) => setCw(e.target.value)} />
          <label className="rowlabel">{t("sheetCellH")}</label>
          <input type="number" min={1} value={ch} onChange={(e) => setCh(e.target.value)} />
          <div className="row-note">{t("sheetFrames")}: {cols * rows} ({cols}×{rows})</div>
        </div>
        <div className="dlg-foot"><Btn label={t("cancel")} onClick={onClose} /><Btn label={t("ok")} onClick={apply} className="primary" /></div>
      </div>
    </>
  );
}
function NewDocModal({ t, onClose }: { t: ReturnType<typeof makeT>; onClose: () => void }) {
  const [w, setW] = useState("64");
  const [h, setH] = useState("64");
  const [name, setName] = useState("");
  const [white, setWhite] = useState(false);
  const apply = async () => { if (await SESSION.newDoc(Math.max(1, Math.min(1024, parseInt(w, 10) || 64)), Math.max(1, Math.min(1024, parseInt(h, 10) || 64)), name || "untitled", white ? [255, 255, 255, 255] : null)) onClose(); };
  return (
    <>
      <div className="dlg-mask" onClick={onClose} />
      <div className="dlg">
        <div className="dlg-head"><span>{t("newDoc")}</span><div className="grow" /><button className="btn small" onClick={onClose}><Icon id="i-x" size={16} /></button></div>
        <div className="dlg-body">
          <label className="rowlabel">{t("name")}</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
          <label className="rowlabel">{t("docs.w")}</label>
          <input type="number" min={1} max={1024} value={w} onChange={(e) => setW(e.target.value)} />
          <label className="rowlabel">{t("docs.h")}</label>
          <input type="number" min={1} max={1024} value={h} onChange={(e) => setH(e.target.value)} />
          <div className="chips"><button className={"chip" + (white ? " on" : "")} onClick={() => setWhite(!white)}>{t("whiteBg")}</button></div>
        </div>
        <div className="dlg-foot"><Btn label={t("cancel")} onClick={onClose} /><Btn label={t("ok")} onClick={apply} className="primary" /></div>
      </div>
    </>
  );
}
function ExportModal({ t, snap, onClose }: { t: ReturnType<typeof makeT>; snap: Snapshot; onClose: () => void }) {
  const [tab, setTab] = useState<"png" | "gif" | "sheet">("png");
  const [scope, setScope] = useState<"frame" | "layer" | "sel">("frame");
  const [scale, setScale] = useState(1);
  const [bgMode, setBgMode] = useState<"transparent" | "white">("transparent");
  const [cols, setCols] = useState(Math.min(8, snap.frameCount));
  const selAvail = snap.selActive;
  const doExport = () => {
    const doc = SESSION.doc;
    const li = scope === "layer" ? SESSION.curLayer() : null;
    const b = scope === "sel" && doc.sel ? doc.sel.bounds() : null;
    const bg: [number, number, number, number] | null = bgMode === "white" ? [255, 255, 255, 255] : null;
    const o = { bg, scale, li, bounds: b };
    if (tab === "png") { void exporters.exportPNG(doc, snap.frameIdx, o).then((r) => { if (r) bridge.saveBytes(r.name, "image/png", r.bytes, (ok) => bridge.toast(ok ? t("exported") : t("saveCancel"))); }); }
    else if (tab === "gif") { void exporters.exportGIF(doc, o).then((r) => { bridge.saveBytes(r.name, "image/gif", r.bytes, (ok) => bridge.toast(ok ? t("exported") : t("saveCancel"))); }); }
    else { void exporters.exportSheet(doc, { ...o, cols }).then((r) => { if (!r) return; bridge.saveBytes(r.name, "image/png", r.png, (ok1) => { if (ok1) bridge.saveBytes(r.jsonName, "application/json", r.json, (ok2) => bridge.toast(ok2 ? t("exported") : t("saveCancel"))); else bridge.toast(t("saveCancel")); }); }); }
  };
  return (
    <>
      <div className="dlg-mask" onClick={onClose} />
      <div className="dlg">
        <div className="dlg-head"><span>{t("export")}</span><div className="grow" /><button className="btn small" onClick={onClose}><Icon id="i-x" size={16} /></button></div>
        <div className="dlg-body">
          <div className="tabs">
            <button className={"tab" + (tab === "png" ? " on" : "")} onClick={() => setTab("png")}>PNG</button>
            <button className={"tab" + (tab === "gif" ? " on" : "")} onClick={() => setTab("gif")}>GIF</button>
            <button className={"tab" + (tab === "sheet" ? " on" : "")} onClick={() => setTab("sheet")}>{t("exportSheet")}</button>
          </div>
          <label className="rowlabel">{t("srcScope")}</label>
          <div className="chips">
            <button className={"chip" + (scope === "frame" ? " on" : "")} onClick={() => setScope("frame")}>{t("srcFrame")}</button>
            <button className={"chip" + (scope === "layer" ? " on" : "")} onClick={() => setScope("layer")}>{t("srcLayer")}</button>
            {selAvail && <button className={"chip" + (scope === "sel" ? " on" : "")} onClick={() => setScope("sel")}>{t("srcSel")}</button>}
          </div>
          <label className="rowlabel">{t("bgCustom")}</label>
          <div className="chips">
            <button className={"chip" + (bgMode === "transparent" ? " on" : "")} onClick={() => setBgMode("transparent")}>{t("transparent")}</button>
            <button className={"chip" + (bgMode === "white" ? " on" : "")} onClick={() => setBgMode("white")}>{t("whiteBg")}</button>
          </div>
          <label className="rowlabel">{t("scale")}</label>
          <select value={scale} onChange={(e) => setScale(Number(e.target.value))}>{[1, 2, 4, 8].map((s) => <option key={s} value={s}>{s}x</option>)}</select>
          {tab === "sheet" && (<><label className="rowlabel">{t("columns")}</label><input type="number" min={1} max={snap.frameCount} value={cols} onChange={(e) => setCols(Math.max(1, Math.min(snap.frameCount, Number(e.target.value) || 1)))} /></>)}
        </div>
        <div className="dlg-foot"><Btn label={t("cancel")} onClick={onClose} /><Btn label={t("export")} onClick={doExport} className="primary" /></div>
      </div>
    </>
  );
}
function AdjustModal({ t, onClose }: { t: ReturnType<typeof makeT>; onClose: () => void }) {
  const [scope, setScope] = useState<"doc" | "layer">("doc");
  const [hue, setHue] = useState(0);
  const [sat, setSat] = useState(100);
  const [light, setLight] = useState(0);
  useEffect(() => {
    // start a fresh preview scope whenever the scope chip changes
    SESSION.adjustCancel();
    SESSION.adjustStart(scope);
  }, [scope]);
  const live = (h: number, s: number, l: number) => SESSION.adjustLive({ hue: h, satMul: s / 100, lightAdd: l / 100 });
  const closeCancel = () => { SESSION.adjustCancel(); onClose(); };
  return (
    <>
      <div className="dlg-mask" onClick={closeCancel} />
      <div className="dlg">
        <div className="dlg-head"><span>{t("adjust")}</span><div className="grow" /><button className="btn small" onClick={closeCancel}><Icon id="i-x" size={16} /></button></div>
        <div className="dlg-body col">
          <div className="chips">
            <button className={"chip" + (scope === "doc" ? " on" : "")} onClick={() => setScope("doc")}>{t("scopeDoc")}</button>
            <button className={"chip" + (scope === "layer" ? " on" : "")} onClick={() => setScope("layer")}>{t("scopeLayer")}</button>
          </div>
          <HoldAdjust dir="h" fixedBottom value={hue} min={-180} max={180} title={t("hueL")} format={(v) => "H" + Math.round(v)} onChange={(v) => { setHue(v); live(v, sat, light); }} />
          <HoldAdjust dir="h" fixedBottom value={sat} min={0} max={200} title={t("satL")} format={(v) => "S" + Math.round(v) + "%"} onChange={(v) => { setSat(v); live(hue, v, light); }} />
          <HoldAdjust dir="h" fixedBottom value={light} min={-100} max={100} title={t("lightL")} format={(v) => "L" + Math.round(v)} onChange={(v) => { setLight(v); live(hue, sat, v); }} />
        </div>
        <div className="dlg-foot"><Btn label={t("cancel")} onClick={closeCancel} /><Btn label={t("ok")} className="primary" onClick={() => { SESSION.adjustCommit(); onClose(); }} /></div>
      </div>
    </>
  );
}
function SettingsModal({ t, onClose }: { t: ReturnType<typeof makeT>; onClose: () => void }) {
  const snap = useSession();
  const setLang = (l: Lang) => { SESSION.prefs.lang = l; SESSION.savePrefs(); SESSION.changed(); };
  return (
    <>
      <div className="dlg-mask" onClick={onClose} />
      <div className="dlg">
        <div className="dlg-head"><span>{t("settings")}</span><div className="grow" /><button className="btn small" onClick={onClose}><Icon id="i-x" size={16} /></button></div>
        <div className="dlg-body">
          <label className="rowlabel">{t("lang")}</label>
          <div className="chips">
            <button className={"chip" + (snap.lang === "zh" ? " on" : "")} onClick={() => setLang("zh")}>{t("zhLabel")}</button>
            <button className={"chip" + (snap.lang === "en" ? " on" : "")} onClick={() => setLang("en")}>{t("enLabel")}</button>
          </div>
          <label className="rowlabel">{t("newFrameCopy")}</label>
          <button className={"chip" + (SESSION.prefs.newFrameCopy ? " on" : "")} onClick={() => SESSION.setNewFrameCopy(!SESSION.prefs.newFrameCopy)}>{SESSION.prefs.newFrameCopy ? "ON" : "OFF"}</button>
          <label className="rowlabel">{t("swapRails")}</label>
          <button className={"chip" + (SESSION.prefs.railSwap ? " on" : "")} onClick={() => SESSION.setRailSwap(!SESSION.prefs.railSwap)}>{SESSION.prefs.railSwap ? "ON" : "OFF"}</button>
          <label className="rowlabel">{t("grid")}</label>
          <button className={"chip" + (snap.grid ? " on" : "")} onClick={() => SESSION.toggleGrid()}>{snap.grid ? "ON" : "OFF"}</button>
          <label className="rowlabel">{t("tlHeight")}</label>
          <div className="row-actions"><HoldAdjust dir="h" value={SESSION.prefs.tlH} min={56} max={340} title={t("tlHeight")} format={(v) => v + "px"} onChange={(v) => SESSION.setTlHeight(v)} /></div>
          <label className="rowlabel">{t("sel.wandTol")}</label>
          <div className="row-actions"><HoldAdjust value={SESSION.selectionTolerance} min={0} max={64} title={t("sel.wandTol")} format={(v) => "T" + v} onChange={(v) => SESSION.setSelectionTolerance(v)} /></div>
          <label className="rowlabel">{t("previewBg")}</label>
          <div className="chips">
            <button className={"chip" + (snap.previewBg === "white" ? " on" : "")} onClick={() => SESSION.setPreviewBg("white")}>{t("previewWhite")}</button>
            <button className={"chip" + (snap.previewBg === "black" ? " on" : "")} onClick={() => SESSION.setPreviewBg("black")}>{t("previewBlack")}</button>
            <button className={"chip" + (snap.previewBg === "checker" ? " on" : "")} onClick={() => SESSION.setPreviewBg("checker")}>{t("previewChecker")}</button>
          </div>
        </div>
        <div className="dlg-foot"><Btn label={t("close")} onClick={onClose} /></div>
      </div>
    </>
  );
}
function HelpModal({ t, onClose }: { t: ReturnType<typeof makeT>; onClose: () => void }) {
  return (
    <>
      <div className="dlg-mask" onClick={onClose} />
      <div className="dlg">
        <div className="dlg-head"><span>{t("helpTitle")}</span><div className="grow" /><button className="btn small" onClick={onClose}><Icon id="i-x" size={16} /></button></div>
        <div className="dlg-body"><pre className="help-text">{t("helpText")}</pre></div>
        <div className="dlg-foot"><Btn label={t("ok")} onClick={onClose} className="primary" /></div>
      </div>
    </>
  );
}
function FrameModal({ t, snap, fi, onClose }: { t: ReturnType<typeof makeT>; snap: Snapshot; fi: number; onClose: () => void }) {
  const [ms, setMs] = useState(SESSION.doc.frames[fi]?.durationMs ?? 100);
  return (
    <>
      <div className="dlg-mask" onClick={onClose} />
      <div className="dlg">
        <div className="dlg-head"><span>{t("frames")} {fi + 1}</span><div className="grow" /><button className="btn small" onClick={onClose}><Icon id="i-x" size={16} /></button></div>
        <div className="dlg-body">
          <label className="rowlabel">{t("frameDur")}</label>
          <input type="number" min={1} max={60000} value={ms} onChange={(e) => setMs(Number(e.target.value) || 1)} />
        </div>
        <div className="dlg-foot"><Btn label={t("cancel")} onClick={onClose} /><Btn label={t("ok")} onClick={() => { SESSION.setFrameDuration(fi, ms); onClose(); }} className="primary" /></div>
      </div>
    </>
  );
}
const H_ZH: Record<string, string> = { "canvas-size": "修改画布尺寸", "sprite-size": "整体缩放精灵", "clear-frame": "清空当前帧", "layer-add": "新建图层", "layer-del": "删除图层", "layer-up": "上移图层", "layer-down": "下移图层", "layer-dupe": "复制图层", "layer-merge": "向下合并图层", "layer-visible": "图层可见性", "layer-lock": "锁定图层", "layer-rename": "重命名图层", "layer-opacity": "图层不透明度", "layer-blend": "图层混合模式", "frame-add": "新建帧", "frame-del": "删除帧", "frame-move": "移动帧", "frame-dupe": "复制帧", "frame-duration": "帧时长", "palette-set": "替换色板", "palette-add": "添加颜色", "palette-remove": "删除颜色", "import-layer": "导入为图层", "wand": "魔棒选区", "sel.grow": "扩展选区", "sel.shrink": "收缩选区", "sel.lasso": "套索选区", "sel.move": "移动选区", "sel.rotate": "旋转选区", "sel.scale": "缩放选区", "adjust-color": "颜色调整", "palette-recolor": "色卡换色(整幅同步)" };
const H_EN: Record<string, string> = { "canvas-size": "Resize canvas", "sprite-size": "Scale sprite", "clear-frame": "Clear frame", "layer-add": "New layer", "layer-del": "Delete layer", "layer-up": "Move layer up", "layer-down": "Move layer down", "layer-dupe": "Duplicate layer", "layer-merge": "Merge layer down", "layer-visible": "Layer visibility", "layer-lock": "Lock layer", "layer-rename": "Rename layer", "layer-opacity": "Layer opacity", "layer-blend": "Layer blend mode", "frame-add": "New frame", "frame-del": "Delete frame", "frame-move": "Move frame", "frame-dupe": "Duplicate frame", "frame-duration": "Frame duration", "palette-set": "Replace palette", "palette-add": "Add color", "palette-remove": "Remove color", "import-layer": "Import as layer", "wand": "Magic wand select", "sel.grow": "Grow selection", "sel.shrink": "Shrink selection", "sel.lasso": "Lasso select", "sel.move": "Move selection", "sel.rotate": "Rotate selection", "sel.scale": "Scale selection", "adjust-color": "Adjust color", "palette-recolor": "Recolor palette (sprite)" };
function histName(label: string, t: ReturnType<typeof makeT>, lang: string): string {
  const m = lang === "zh" ? H_ZH : H_EN;
  if (m[label]) return m[label];
  const tr = t(label);
  return tr === label ? label : tr;
}
function HistoryModal({ t, snap, onClose, onReplay }: { t: ReturnType<typeof makeT>; snap: Snapshot; onClose: () => void; onReplay: () => void }) {
  const { labels, index } = SESSION.history.list();
  const rows = [{ key: 0, label: t("historyStart") } as { key: number; label: string }].concat(labels.map((lb, i) => ({ key: i + 1, label: histName(lb, t, snap.lang) })));
  return (
    <>
      <div className="dlg-mask" onClick={onClose} />
      <div className="dlg">
        <div className="dlg-head"><span>{t("historyTitle")}</span><div className="grow" /><button className="btn small" onClick={onClose}><Icon id="i-x" size={16} /></button></div>
        <div className="dlg-body hist-body">
          {labels.length === 0 ? <div className="row-note">{t("historyEmpty")}</div> : rows.map((r) => (<button key={r.key} className={"hist-row" + (index === r.key ? " cur" : "")} onClick={() => SESSION.jumpHistory(r.key)}><span className="hnum">{r.key === 0 ? "▸" : r.key}</span><span className="htext">{r.label}</span></button>))}
        </div>
        {labels.length > 0 && (
          <div className="repl-line"><Btn icon="i-play" label={t("replay")} className="repl-play" onClick={onReplay} noTip /><span>{t("replayHint")}</span></div>
        )}
        <div className="dlg-foot"><Btn label={t("close")} onClick={onClose} /></div>
      </div>
    </>
  );
}
