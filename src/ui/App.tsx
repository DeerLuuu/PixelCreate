import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { SESSION } from "./singleton";
import type { Snapshot } from "../app/session";
import { makeT } from "./i18n";
import type { Lang } from "./i18n";
import { CORE_TOOLS, SHAPE_TOOLS, SELECT_TOOLS, isShapeTool, isSelectTool, isSymTool } from "../tools/registry";
import { View } from "../render/view";
import { Doc } from "../engine/doc";
import { Cel } from "../engine/cel";
import { rgbaToHex, hexToRgba, chipCss } from "../engine/color";
import * as selOps from "../tools/select";
import * as fxE from "../engine/effects";
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
import { RefImageBox } from "./refimg";
import type { RefImg } from "./refimg";
import { PalettePanel, MenuModal, SizeModal, SheetModal, NewDocModal, ExportModal, AdjustModal, SettingsModal, FrameModal, HistoryModal, histName, saveProject } from "./modals";
import { ChangelogModal, changelogNeedsShow } from "./changelog";
import type { ModalId, SizeMode, SheetData } from "./modals";

type PanelId = "layers" | "palette" | null;


export function App() {
  const snap = useSession();
  const t = useMemo(() => makeT(snap.lang as Lang), [snap.lang]);
  const [panel, setPanel] = useState<PanelId>(null);
  const [modal, setModal] = useState<ModalId>(null);
  const [frameDlgIdx, setFrameDlgIdx] = useState<number | null>(null);
  const [tlOn, setTlOn] = useState(false); // timeline starts hidden
  const [tlClosing, setTlClosing] = useState(false);
  const [sizeMode, setSizeMode] = useState<SizeMode>("canvas");
  const [sheet, setSheet] = useState<SheetData | null>(null);
  const [replayOn, setReplayOn] = useState(false);
  const [refImg, setRefImg] = useState<RefImg | null>(null);
  const [confirmQ, setConfirmQ] = useState<{ msg: string; yes: string; no: string; res: (ok: boolean) => void } | null>(null);

  useEffect(() => {
    SESSION.setConfirmAsk((q) => new Promise<boolean>((resolve) => setConfirmQ({ msg: q.msg, yes: q.yes, no: q.no, res: resolve })));
    return () => SESSION.setConfirmAsk(null);
  }, []);

  // first launch after an update: auto-show the release notes
  useEffect(() => {
    if (changelogNeedsShow()) setModal("changelog");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={"app-root" + (SESSION.prefs.railSwap ? " rails-swap" : "")} onContextMenu={(e) => e.preventDefault()} onDragStart={(e) => e.preventDefault()}>
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
          onRefClose={() => setRefImg(null)}
        />
      </div>
      <ControlBar t={t} snap={snap} onPanel={setPanel} onAdjust={() => setModal("adjust")} />
      {tlOn && (
      <div className={"tline-wrap" + (tlClosing ? " closing" : "")}>
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
      <Keep on={modal === "menu"} el={modal === "menu" ? <MenuModal t={t} snap={snap} onClose={() => setModal(null)} onOpen={setModal} onSheet={(d) => { setSheet(d); setModal("sheet"); }} onRef={(d) => setRefImg(d)} /> : null} />
      <Keep on={modal === "size"} el={modal === "size" ? <SizeModal t={t} snap={snap} initial={sizeMode} onClose={() => setModal(null)} /> : null} />
      <Keep on={modal === "sheet" && sheet !== null} el={modal === "sheet" && sheet ? <SheetModal t={t} img={sheet} onClose={() => { setModal(null); setSheet(null); }} /> : null} />
      <Keep on={modal === "newdoc"} el={modal === "newdoc" ? <NewDocModal t={t} onClose={() => setModal(null)} /> : null} />
      <Keep on={modal === "export"} el={modal === "export" ? <ExportModal t={t} snap={snap} onClose={() => setModal(null)} /> : null} />
      <Keep on={modal === "settings"} el={modal === "settings" ? <SettingsModal t={t} onClose={() => setModal(null)} /> : null} />
      <Keep on={modal === "adjust"} el={modal === "adjust" ? <AdjustModal t={t} onClose={() => setModal(null)} /> : null} />
      <Keep on={frameDlgIdx !== null} el={frameDlgIdx !== null ? <FrameModal t={t} snap={snap} fi={frameDlgIdx} onClose={() => setFrameDlgIdx(null)} /> : null} />
      <Keep on={modal === "history"} el={modal === "history" ? <HistoryModal t={t} snap={snap} onClose={() => setModal(null)} onReplay={() => { setModal(null); setReplayOn(true); }} /> : null} />
      <Keep on={modal === "changelog"} el={modal === "changelog" ? <ChangelogModal onClose={() => setModal(null)} /> : null} />
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

  // ---------- floating-ball dock ----------
  const landD = useLandscape();
  type BallId = "main" | "pal" | "fx";
  const [docked, setDocked] = useState<{ id: BallId; x: number; y: number }[]>([]);
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

  const fxZh = snap.lang === "zh";
  const fxDo = (label: string, fn: (data: Uint8ClampedArray, w: number, h: number) => void) => {
    const cel = d.celAt(li, fi);
    if (!cel) return;
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
    fxI("shadow", "i-fx-shadow", "投影", "Shadow", "一键投影：内容右下 3px 黑色半透明投影", "Drop shadow: semi-transparent black copy 3px down-right", () => fxDo("fx-shadow", (dd, w, h) => fxE.dropShadowCel(dd, w, h, 3, 3, [0, 0, 0, 150]))),
    fxI("glow", "i-fx-glow", "外发光", "Glow", "一键外发光：用当前颜色向外发光 2px 并逐层淡出", "Outer glow: current colour fading outwards 2px", () => {
      const base = SESSION.color;
      fxDo("fx-glow", (dd, w, h) => fxE.outerGlowCel(dd, w, h, 2, [base[0], base[1], base[2], 255]));
    }),
    fxI("iso", "i-fx-iso", "等距网格", "Iso", "等距网格辅助线（开关）", "Isometric helper grid (toggle)", () => SESSION.toggleIsoGrid(), SESSION.prefs.isoGrid),
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
          <button key={"pb" + it.i} className={"orb-item pal-c" + (cur ? " on" : "")} style={{ left: it.px, top: it.py, background: chipCss(c), "--st": (Math.min(it.i, 40) * 8) + "ms" } as unknown as React.CSSProperties} title={rgbaToHex(c)} onContextMenu={(e) => e.preventDefault()}
            onClick={() => { SESSION.setFgColor([c[0], c[1], c[2], 255]); onDone(); }} />
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
            style={{ background: chipCss(SESSION.colorTarget === "bg" ? SESSION.fg : SESSION.bg) }} />
        </div>
        <Btn label="⇄" className="swap-color" title={t("swapColors")} onClick={() => SESSION.swapColors()} />
        <Btn icon="i-adjust" onClick={onAdjust} title={t("adjust")} />
        <Btn label={SYM_GLYPH[sym]} className="sym-toggle" active={sym !== "off"} title={t(symKey[sym])} desc={bd(snap.lang, "sym")} onClick={() => { const m = SESSION.cycleSym(); bridge.toast(t(symKey[m])); }} />
      </div>
      <div className="cb-sliders">
        <HoldAdjust dir={dir} value={snap.brushSize} min={1} max={64} title={t("brushSize")} hint={bd(snap.lang, "brush")} format={(v) => "◉" + v} reset={1} onChange={(v) => SESSION.setBrushSize(v)} />
        <HoldAdjust dir={dir} value={snap.brushAlpha} min={0} max={255} title={t("opacity")} hint={bd(snap.lang, "alpha")} format={(v) => "◐" + v} reset={255} onChange={(v) => SESSION.setBrushAlpha(v)} />
        {snap.tool === "polygon" && <HoldAdjust dir={dir} value={SESSION.shapeSides} min={3} max={12} title={t("sides")} hint={bd(snap.lang, "sides")} format={(v) => "◮" + v} reset={6} onChange={(v) => SESSION.setShapeSides(v)} />}
        {isShapeTool(snap.tool) && snap.tool !== "line" && <Btn icon={SESSION.shapeFill ? "i-rect" : "i-rectfill"} onClick={() => SESSION.setShapeFill(!SESSION.shapeFill)} title={SESSION.shapeFill ? t("shapeHollow") : t("shapeSolid")} />}
      </div>
    </section>
  );
}
function Viewport({ onColorClick, refImg, onRefClose }: { onColorClick: () => void; refImg: RefImg | null; onRefClose: () => void }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<View | null>(null);
  const tv = makeT(SESSION.prefs.lang as Lang);
  const [, setTick] = useState(0);
  const [symAdj, setSymAdj] = useState(false);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const v = new View(host, SESSION);
    viewRef.current = v;
    SESSION.attachView(v);
    v.fit();
    const iv = window.setInterval(() => setTick((x) => x + 1), 300);
    return () => { window.clearInterval(iv); v.destroy(); viewRef.current = null; };
  }, []);
  const symOn = SESSION.sym !== "off" && isSymTool(SESSION.tool);
  // switching tool/off symmetry exits the axis-adjust mode automatically
  useEffect(() => {
    if (!symOn && symAdj) {
      setSymAdj(false);
      viewRef.current?.setSymAdjust(false);
    }
  });
  const c = SESSION.color;
  const visible = SESSION.colorPickedRecently(Date.now(), 1600);
  return (
    <section className="viewport">
      <div className="view-canvas" ref={hostRef} />
      <PreviewBox />
      {refImg && <RefImageBox img={refImg} onClose={onRefClose} />}
      {symOn && (
        <div className={"sym-chiprow" + (symAdj ? " adj" : "")}>
          {symAdj ? (
            <>
              <button className="sym-chip sym-done" type="button" title={tv("symAdjustHint")} onClick={() => { setSymAdj(false); viewRef.current?.setSymAdjust(false); }}>{tv("symDone")}</button>
              <button className="sym-chip" type="button" title={tv("symReset")} onClick={() => SESSION.resetSymAxes()}>{tv("symReset")}</button>
            </>
          ) : (
            <button className="sym-chip" type="button" title={tv("symAdjustHint")} onClick={() => { setSymAdj(true); viewRef.current?.setSymAdjust(true); }}>{tv("symAdjust")}</button>
          )}
        </div>
      )}
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