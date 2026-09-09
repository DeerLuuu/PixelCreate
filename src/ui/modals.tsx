import { useEffect, useRef, useState } from "react";
import { SESSION } from "./singleton";
import { makeT } from "./i18n";
import { SETTING_GROUPS, settingsOfGroup, isDefault, resetSetting, exportSettings, importSettings, type SettingDef } from "../app/settings";
import type { Snapshot } from "../app/session";
import { Doc } from "../engine/doc";
import { Cel } from "../engine/cel";
import { hexToRgba, rgbaToHex, hexToRgba as hrgb, chipCss } from "../engine/color";
import { HsvWheel } from "./HsvWheel";
import { HoldAdjust } from "./hold";
import { PALETTE_PACKS } from "../data/palettes";
import { tryReadGif } from "../io/gifread";
import * as compose from "../render/compositor";
import * as exporters from "../io/exporters";
import * as bridge from "../io/bridge";
import * as autosave from "../io/autosave";
import { Btn, Icon, useSession, ScrubNum, useBlankTap } from "./base";
import { DropMenu, TabBar } from "./tabs";
import { canVibrate, hapticReport } from "../io/bridge";
import { detectInsets } from "../io/safearea";
import type { RefImg } from "./refimg";

export type ModalId = "menu" | "changelog" | "newdoc" | "export" | "adjust" | "settings" | "frame" | "framePrev" | "size" | "sheet" | "history" | "canvasRef" | null;
export type SizeMode = "canvas" | "sprite";
export type SheetData = { w: number; h: number; px: Uint8ClampedArray; name: string };

export async function saveProject(): Promise<void> {
  const doc = SESSION.doc;
  const txt = await SESSION.serializeProject();
  const bytes = new TextEncoder().encode(txt);
  bridge.saveBytes((doc.name || "art") + ".pxc", "application/json", bytes, (ok) =>
    bridge.toast(ok ? makeT(SESSION.prefs.lang)("saved") : makeT(SESSION.prefs.lang)("saveCancel"))
  );
}
export function PalettePanel({ t, onClose }: { t: ReturnType<typeof makeT>; onClose: () => void }) {
  useSession(); // keep the canvas/recent swatches live while the panel is open
  const doc = SESSION.doc;
  const active = SESSION.currentColor();
  const [hex, setHex] = useState(rgbaToHex(active));
  // selecting a colour applies it FULLY OPAQUE: a stale low/zero alpha from a
  // previous translucent/eraser setting must not make every new colour look
  // wrong (drawing transparent looks like erasing). Use the opacity slider
  // afterwards for translucency.
  const apply = (c: [number, number, number, number]) => { const o: [number, number, number, number] = [c[0], c[1], c[2], 255]; SESSION.setColor(o); setHex(rgbaToHex(o)); };
  // long-press a swatch to recolor it and remap matching pixels across the sprite
  const [recolor, setRecolor] = useState<{ i: number } | null>(null);
  const [recColor, setRecColor] = useState("#ffffff");
  // which colour source the grid shows: the document palette, every colour
  // used on the canvas, or the most recently used ones
  const [palMode, setPalMode] = useState<"palette" | "doc" | "recent">("palette");
  const [sortMode, setSortMode] = useState<"hue" | "light">("hue");
  const longRef = useRef<{ i: number; t: number } | null>(null);
  const skipRef = useRef(false);
  // tapping the blank part of the panel (below / beside the controls) closes it
  const blankTap = useBlankTap(onClose);
  return (
    <>
      <div className="panel-head"><span>{t("palette")}</span><div className="grow" /><button className="btn small" onClick={onClose}><Icon id="i-x" size={16} /></button></div>
      <div className="panel-body" {...blankTap}>
        <HsvWheel color={active} onChange={apply} />
        <div className="ce-row">
          <span className="ce-hex">#</span>
          <input className="hexinput" value={hex.replace(/^#/, "")} onChange={(e) => {
            const v = e.target.value.replace(/[^0-9a-fA-F]/g, "").slice(0, 8);
            setHex(v ? "#" + v : "#");
            if (v.length >= 6) { const c = hrgb(v); if (v.length === 8) SESSION.setColor([c[0], c[1], c[2], c[3]]); else { const o: [number, number, number, number] = [c[0], c[1], c[2], 255]; SESSION.setColor(o); setHex(rgbaToHex(o)); } }
          }} />
        </div>
        <label className="rowlabel">{t("presets")}</label>
        <div className="preset-list">
          {PALETTE_PACKS.map((pack) => (
            <button key={pack.id} className="preset-row" title={t("palPresetReplace")} onClick={() => SESSION.setPalette(pack.colors.map((hc) => { const x = hexToRgba(hc); return [x[0], x[1], x[2], x[3]]; }))}>
              <span className="preset-name">{SESSION.prefs.lang === "zh" ? pack.nameZh : pack.nameEn}</span>
              <span className="preset-dots">{pack.colors.slice(0, 6).map((hc, i) => <i key={i} style={{ background: hc }} />)}</span>
              <span className="preset-merge" role="button" title={t("palMerge")} onClick={(e) => {
                e.stopPropagation();
                const n = SESSION.paletteMerge(pack.colors.map((hc) => { const x = hexToRgba(hc); return [x[0], x[1], x[2], x[3]]; }));
                bridge.toast(n ? t("palMerged") + n : t("palMergeNone"));
              }}>+</span>
            </button>
          ))}
          {SESSION.myPalettes.map((pack) => (
            <button key={pack.id} className="preset-row mine" title={t("palPresetReplace")} onClick={() => SESSION.setPalette(pack.colors.map((hc) => { const x = hexToRgba(hc); return [x[0], x[1], x[2], x[3]]; }))}>
              <span className="preset-name">{pack.name}</span>
              <span className="preset-dots">{pack.colors.slice(0, 6).map((hc, i) => <i key={i} style={{ background: hc }} />)}</span>
              <span className="preset-merge" role="button" title={t("palMerge")} onClick={(e) => {
                e.stopPropagation();
                const n = SESSION.paletteMerge(pack.colors.map((hc) => { const x = hexToRgba(hc); return [x[0], x[1], x[2], x[3]]; }));
                bridge.toast(n ? t("palMerged") + n : t("palMergeNone"));
              }}>+</span>
              <span className="preset-merge danger" role="button" title={t("palPresetDelete")} onClick={(e) => {
                e.stopPropagation();
                SESSION.deletePalettePreset(pack.id);
              }}>×</span>
            </button>
          ))}
        </div>
        <div className="row-actions">
          <Btn icon="i-plus" label={t("palPresetSave")} onClick={() => {
            const name = SESSION.savePalettePreset();
            bridge.toast(name ? t("palPresetSaved") + name : t("palDedupeNone"));
          }} />
        </div>
        <div data-guide="pal-ops">
          <TabBar<"palette" | "doc" | "recent">
            items={[
              { id: "palette", label: t("palModePalette"), guide: "pal-mode-palette" },
              { id: "doc", label: t("palModeDoc"), guide: "pal-mode-doc" },
              { id: "recent", label: t("palModeRecent"), guide: "pal-mode-recent" },
            ]}
            value={palMode}
            onChange={setPalMode}
            right={<>
              <DropMenu
                guide="pal-sort"
                label={t("palSort") + " · " + t(sortMode === "hue" ? "palSortHue" : "palSortLight")}
                title={t("palSortHint")}
                value={sortMode}
                options={[{ id: "hue", label: t("palSortHue") }, { id: "light", label: t("palSortLight") }]}
                onPick={(m) => { setSortMode(m); SESSION.paletteSort(m); }}
              />
              <button type="button" className="iconbtn" title={t("palDedupeHint")} onClick={() => {
                const n = SESSION.paletteDedupe();
                bridge.toast(n ? t("palDedupeDone") + n : t("palDedupeNone"));
              }}><Icon id="i-dedupe" size={15} /></button>
            </>}
          />
        </div>
        {palMode === "palette" ? (
        <div className="palgrid">
          {doc.palette.map((c, i) => {
            const cur = c[0] === active[0] && c[1] === active[1] && c[2] === active[2];
            return <button key={i} className={"palcell" + (cur ? " on" : "")} style={{ background: chipCss(c) }} title={rgbaToHex(c)} onContextMenu={(e) => { e.preventDefault(); SESSION.paletteRemove(i); }}
              onPointerDown={() => { longRef.current = { i, t: Date.now() }; }}
              onPointerUp={() => { const l = longRef.current; longRef.current = null; if (l && l.i === i && Date.now() - l.t >= 420) { skipRef.current = true; setRecColor(rgbaToHex(c).slice(0, 7)); setRecolor({ i }); } }}
              onClick={() => { if (skipRef.current) { skipRef.current = false; return; } apply(c); }} />;
          })}
        </div>
        ) : (() => {
          const list = palMode === "doc" ? SESSION.docColors() : SESSION.recentColors;
          if (!list.length) return <div className="row-note">{palMode === "doc" ? t("palEmptyDoc") : t("palEmptyRecent")}</div>;
          return (
            <div className="palgrid">
              {list.map((c, i) => {
                const cur = c[0] === active[0] && c[1] === active[1] && c[2] === active[2];
                return <button key={palMode + i} className={"palcell" + (cur ? " on" : "")} style={{ background: chipCss(c) }} title={rgbaToHex(c)} onClick={() => apply(c)} />;
              })}
            </div>
          );
        })()}
        {palMode === "palette" && recolor !== null && doc.palette[recolor.i] && (
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
        {palMode === "palette" && (
        <div className="row-actions" data-guide="pal-export">
          <Btn icon="i-plus" label={t("paletteAdd")} onClick={() => SESSION.paletteAdd(active)} />
          <Btn icon="i-palette" label={t("importPalette")} onClick={() => void (async () => {
            const f = await bridge.openFile("*/*");
            if (!f) return;
            const colors = parsePaletteBytes(f.bytes);
            if (!colors.length) { bridge.toast(t("importFail")); return; }
            SESSION.setPalette(colors);
            bridge.toast(t("importOk"));
          })()} />
          <Btn icon="i-save" label={t("exportPalette")} onClick={() => { bridge.saveBytes((SESSION.doc.name || "palette") + ".gpl", "text/plain", exportGplPalette()); bridge.toast(t("saved")); }} />
        </div>
        )}
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
    if (await SESSION.loadProjectText(txt)) bridge.toast(t("docLoaded")); else bridge.toast(t("importFail"));
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
export function importFlow(): Promise<void> { return openFlow("new"); }
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
export function MenuModal({ t, snap, onClose, onOpen, onSheet, onRef, onGuide }: { t: ReturnType<typeof makeT>; snap: Snapshot; onClose: () => void; onOpen: (m: ModalId) => void; onSheet: (d: SheetData) => void; onRef: (d: RefImg) => void; onGuide: () => void }) {
  // the onboarding tour may open a sub-menu when the menu is shown
  const [sub, setSub] = useState<null | "import">(() => {
    const g = (window as unknown as { __pcGuideMenuSub?: null | "import" }).__pcGuideMenuSub;
    return g ?? null;
  });
  useEffect(() => {
    const onSub = (e: Event) => setSub(((e as CustomEvent).detail ?? null) as null | "import");
    window.addEventListener("pc-guide-menu-sub", onSub);
    return () => window.removeEventListener("pc-guide-menu-sub", onSub);
  }, []);
  const go = (modal: ModalId) => (label: string, icon: string, guide?: string) => <Btn label={label} icon={icon} onClick={() => onOpen(modal)} className="menuitem" guide={guide} />;
  const act = (label: string, icon: string, fn: () => void, guide?: string) => <Btn label={label} icon={icon} onClick={() => { fn(); onClose(); }} className="menuitem" guide={guide} />;
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
  const refPick = async () => {
    const f = await bridge.openFile("*/*");
    if (!f) return;
    if (isGifHeader(f.bytes)) { bridge.toast(t("importFail")); return; }
    const st = await decodeStill(f.bytes, f.mime || "image/png");
    if (!st) { bridge.toast(t("importFail")); return; }
    onRef({ w: st.w, h: st.h, px: st.px, name: f.name || "ref" });
    bridge.toast(t("importOk"));
  };
  return (
    <>
      <div className="dlg-mask" onClick={onClose} />
      <div className="dlg">
        <div className="dlg-head"><span>{t("menu")}</span><div className="grow" /><button className="btn small" onClick={onClose}><Icon id="i-x" size={16} /></button></div>
        <div className="dlg-body col">
          {!sub ? (<>
            {go("newdoc")(t("newDoc"), "i-new", "menu-new")}
            {act(t("save"), "i-save", () => void saveProject(), "menu-save")}
            {act(t("open"), "i-open", () => void openFlow("new"), "menu-open")}
            <Btn label={t("import")} icon="i-import" className="menuitem" guide="menu-import" onClick={() => setSub("import")} />
            {go("settings")(t("settings"), "i-gear", "menu-settings")}
            <Btn label={t("guideReplay")} icon="i-guide" className="menuitem" guide="menu-guide" onClick={onGuide} />
            {go("changelog")(t("changelog"), "i-news", "menu-changelog")}
          </>) : (
            <>
              <Btn label={"\u2039 " + t("import")} icon="" className="menuitem sub-back" onClick={() => setSub(null)} />
              <Btn label={t("importImg")} icon="i-import" className="menuitem" guide="menu-import-img" onClick={() => { void importFlow(); setSub(null); onClose(); }} />
              <Btn label={t("importLayerM")} icon="i-layers" className="menuitem" guide="menu-import-layer" onClick={() => { void importLayerFlow(); setSub(null); onClose(); }} />
              <Btn label={t("importSheet")} icon="i-sheet" className="menuitem" guide="menu-import-sheet" onClick={() => { void sheetPick(); setSub(null); }} />
              <Btn label={t("refImg")} icon="i-image" className="menuitem" guide="menu-import-ref" onClick={() => { void refPick(); setSub(null); }} />
              <Btn label={t("importPalette")} icon="i-palette" className="menuitem" guide="menu-import-palette" onClick={() => { void importPaletteFlow(); setSub(null); onClose(); }} />
            </>
          )}
        </div>
      </div>
    </>
  );
}
export function SizeModal({ t, snap, initial, onClose }: { t: ReturnType<typeof makeT>; snap: Snapshot; initial: SizeMode; onClose: () => void }) {
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
          <ScrubNum min={1} max={1024} value={w} onChange={(v) => onW(v)} />
          <label className="rowlabel">{t("docs.h")}</label>
          <ScrubNum min={1} max={1024} value={h} onChange={(v) => onH(v)} />
          <div className="chips"><button className={"chip" + (locked ? " on" : "")} onClick={() => setLocked(!locked)}>{t("lockRatio")}</button></div>
          {mode === "canvas" ? (<><label className="rowlabel">{t("anchor")}</label><div className="anchor-grid">{[0, 1, 2].map((r) => <div className="anchor-row" key={r}>{[0, 1, 2].map((c) => cell(r, c))}</div>)}</div><p className="size-note">{t("canvasNote")}</p></>) : <p className="size-note">{t("spriteNote")}</p>}
        </div>
        <div className="dlg-foot"><Btn label={t("cancel")} onClick={onClose} /><Btn label={t("ok")} onClick={apply} className="primary" /></div>
      </div>
    </>
  );
}
export function SheetModal({ t, img, onClose }: { t: ReturnType<typeof makeT>; img: SheetData; onClose: () => void }) {
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
          <ScrubNum min={1} value={cw} onChange={(v) => setCw(v)} />
          <label className="rowlabel">{t("sheetCellH")}</label>
          <ScrubNum min={1} value={ch} onChange={(v) => setCh(v)} />
          <div className="row-note">{t("sheetFrames")}: {cols * rows} ({cols}×{rows})</div>
        </div>
        <div className="dlg-foot"><Btn label={t("cancel")} onClick={onClose} /><Btn label={t("ok")} onClick={apply} className="primary" /></div>
      </div>
    </>
  );
}
export function NewDocModal({ t, onClose }: { t: ReturnType<typeof makeT>; onClose: () => void }) {
  // remembered defaults: the last size / background the user created
  const [w, setW] = useState(String(SESSION.prefs.newDocW));
  const [h, setH] = useState(String(SESSION.prefs.newDocH));
  const [name, setName] = useState("");
  const [white, setWhite] = useState(SESSION.prefs.newDocBg === "white");
  const apply = async () => {
    const nw = Math.max(1, Math.min(1024, parseInt(w, 10) || SESSION.prefs.newDocW));
    const nh = Math.max(1, Math.min(1024, parseInt(h, 10) || SESSION.prefs.newDocH));
    SESSION.setSetting("general.newDocW", nw);
    SESSION.setSetting("general.newDocH", nh);
    SESSION.setSetting("general.newDocBg", white ? "white" : "transparent");
    if (await SESSION.newDoc(nw, nh, name || "untitled", white ? [255, 255, 255, 255] : null)) onClose();
  };
  return (
    <>
      <div className="dlg-mask" onClick={onClose} />
      <div className="dlg">
        <div className="dlg-head"><span>{t("newDoc")}</span><div className="grow" /><button className="btn small" onClick={onClose}><Icon id="i-x" size={16} /></button></div>
        <div className="dlg-body">
          <label className="rowlabel">{t("name")}</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
          <label className="rowlabel">{t("docs.w")}</label>
          <ScrubNum min={1} max={1024} value={w} onChange={(v) => setW(v)} />
          <label className="rowlabel">{t("docs.h")}</label>
          <ScrubNum min={1} max={1024} value={h} onChange={(v) => setH(v)} />
          <div className="chips"><button className={"chip" + (white ? " on" : "")} onClick={() => setWhite(!white)}>{t("whiteBg")}</button></div>
        </div>
        <div className="dlg-foot"><Btn label={t("cancel")} onClick={onClose} /><Btn label={t("ok")} onClick={apply} className="primary" /></div>
      </div>
    </>
  );
}
export function ExportModal({ t, snap, onClose }: { t: ReturnType<typeof makeT>; snap: Snapshot; onClose: () => void }) {
  const guideTab = (window as unknown as { __pcGuideExportTab?: string }).__pcGuideExportTab;
  const [tab, setTab] = useState<"png" | "gif" | "sheet" | "layers">(guideTab === "gif" ? "gif" : "png");
  const [scope, setScope] = useState<"frame" | "layer" | "sel">("frame");
  const [scale, setScale] = useState(1);
  const [bgMode, setBgMode] = useState<"transparent" | "white">("transparent");
  const [cols, setCols] = useState(Math.min(8, snap.frameCount));
  // frame range for the multi-frame formats (GIF / spritesheet / per layer)
  const [rFrom, setRFrom] = useState(1);
  const [rTo, setRTo] = useState(snap.frameCount);
  const range: [number, number] = [rFrom - 1, rTo - 1];
  const rangeAll = rFrom === 1 && rTo === snap.frameCount;
  const selAvail = snap.selActive;
  const saveOne = (name: string, mime: string, bytes: Uint8Array) =>
    new Promise<boolean>((res) => bridge.saveBytes(name, mime, bytes, (ok) => res(ok)));
  const exportLayersFlow = async () => {
    const doc = SESSION.doc;
    const bg: [number, number, number, number] | null = bgMode === "white" ? [255, 255, 255, 255] : null;
    const o = { bg, scale, range };
    const multi = doc.frames.length > 1;
    let okN = 0;
    for (let li = 0; li < doc.layers.length; li++) {
      const lname = exporters.sanitizeName(doc.layers[li].name) || "layer" + (li + 1);
      for (let fi = range[0]; fi <= range[1]; fi++) {
        const r = await exporters.exportPNG(doc, fi, { ...o, li });
        if (!r) continue;
        const name = exporters.sanitizeName(doc.name) + "_" + lname + (multi ? "_" + (fi + 1) : "") + ".png";
        if (await saveOne(name, "image/png", r.bytes)) okN++;
      }
    }
    bridge.toast(okN > 0 ? t("exported") : t("saveCancel"));
  };
  useEffect(() => {
    // the tour may have forced the GIF tab just to show the range row
    return () => { delete (window as unknown as { __pcGuideExportTab?: string }).__pcGuideExportTab; };
  }, []);
  const doExport = () => {
    const doc = SESSION.doc;
    const li = scope === "layer" ? SESSION.curLayer() : null;
    const b = scope === "sel" && doc.sel ? doc.sel.bounds() : null;
    const bg: [number, number, number, number] | null = bgMode === "white" ? [255, 255, 255, 255] : null;
    const o = { bg, scale, li, bounds: b };
    if (tab === "png") { void exporters.exportPNG(doc, snap.frameIdx, o).then((r) => { if (r) bridge.saveBytes(r.name, "image/png", r.bytes, (ok) => bridge.toast(ok ? t("exported") : t("saveCancel"))); }); }
    else if (tab === "gif") { void exporters.exportGIF(doc, { ...o, range }).then((r) => { bridge.saveBytes(r.name, "image/gif", r.bytes, (ok) => bridge.toast(ok ? t("exported") : t("saveCancel"))); }); }
    else if (tab === "sheet") { void exporters.exportSheet(doc, { ...o, cols, range }).then((r) => { if (!r) return; bridge.saveBytes(r.name, "image/png", r.png, (ok1) => { if (ok1) bridge.saveBytes(r.jsonName, "application/json", r.json, (ok2) => bridge.toast(ok2 ? t("exported") : t("saveCancel"))); else bridge.toast(t("saveCancel")); }); }); }
    else { void exportLayersFlow(); }
  };
  return (
    <>
      <div className="dlg-mask" onClick={onClose} />
      <div className="dlg" data-guide="dlg-export">
        <div className="dlg-head"><span>{t("export")}</span><div className="grow" /><button className="btn small" onClick={onClose}><Icon id="i-x" size={16} /></button></div>
        <div className="dlg-body">
          <div className="tabs">
            <button className={"tab" + (tab === "png" ? " on" : "")} onClick={() => setTab("png")}>PNG</button>
            <button className={"tab" + (tab === "gif" ? " on" : "")} onClick={() => setTab("gif")}>GIF</button>
            <button className={"tab" + (tab === "sheet" ? " on" : "")} onClick={() => setTab("sheet")}>{t("exportSheet")}</button>
            <button className={"tab" + (tab === "layers" ? " on" : "")} onClick={() => setTab("layers")}>{t("exportLayers")}</button>
          </div>
          {tab === "layers" ? <div className="row-note">{t("layersNote")}</div> : (<>
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
          </>)}
          <label className="rowlabel">{t("scale")}</label>
          <div className="chips">{([1, 2, 4, 8] as const).map((s) => (
            <button key={s} className={"chip" + (scale === s ? " on" : "")} onClick={() => setScale(s)}>{s}x</button>
          ))}</div>
          {tab !== "png" && (<>
            <label className="rowlabel">{t("frameRange")}</label>
            <div className="chips fsel-range" data-guide="exp-range">
              <ScrubNum min={1} max={snap.frameCount} value={rFrom} onChange={(v) => {
                const n = Math.max(1, Math.min(snap.frameCount, Number(v) || 1));
                setRFrom(n);
                if (n > rTo) setRTo(n);
              }} />
              <span className="fsel-dash">–</span>
              <ScrubNum min={1} max={snap.frameCount} value={rTo} onChange={(v) => {
                const n = Math.max(1, Math.min(snap.frameCount, Number(v) || 1));
                setRTo(n);
                if (n < rFrom) setRFrom(n);
              }} />
              <button className={"chip" + (rangeAll ? " on" : "")} onClick={() => { setRFrom(1); setRTo(snap.frameCount); }}>{t("frameRangeAll")}</button>
              {snap.frameSel.length > 1 && (
                <button className="chip" onClick={() => {
                  const list = snap.frameSel;
                  setRFrom(list[0] + 1);
                  setRTo(list[list.length - 1] + 1);
                }}>{t("frameRangePicked")}</button>
              )}
            </div>
          </>)}
          {tab === "sheet" && (<><label className="rowlabel">{t("columns")}</label><ScrubNum min={1} max={rTo - rFrom + 1} value={cols} onChange={(v) => setCols(Math.max(1, Math.min(rTo - rFrom + 1, Number(v) || 1)))} /></>)}
        </div>
        <div className="dlg-foot"><Btn label={t("cancel")} onClick={onClose} /><Btn label={t("export")} onClick={doExport} className="primary" /></div>
      </div>
    </>
  );
}
export function AdjustModal({ t, onClose }: { t: ReturnType<typeof makeT>; onClose: () => void }) {
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
          <div className="adj3">
            <HoldAdjust dir="h" fixedBottom value={hue} min={-180} max={180} title={t("hueL")} format={(v) => "H" + Math.round(v)} reset={0} onChange={(v) => { setHue(v); live(v, sat, light); }} />
            <HoldAdjust dir="h" fixedBottom value={sat} min={0} max={200} title={t("satL")} format={(v) => "S" + Math.round(v) + "%"} reset={100} onChange={(v) => { setSat(v); live(hue, v, light); }} />
            <HoldAdjust dir="h" fixedBottom value={light} min={-100} max={100} title={t("lightL")} format={(v) => "L" + Math.round(v)} reset={0} onChange={(v) => { setLight(v); live(hue, sat, v); }} />
          </div>
        </div>
        <div className="dlg-foot"><Btn label={t("cancel")} onClick={closeCancel} /><Btn label={t("ok")} className="primary" onClick={() => { SESSION.adjustCommit(); onClose(); }} /></div>
      </div>
    </>
  );
}
/** live vibration diagnostics: the setting state plus the most recent haptic
 *  calls, so it is visible whether a gesture reached the vibrator at all */
function HapticReport({ t }: { t: ReturnType<typeof makeT> }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="row-note" data-guide="haptic-report">
      {t("hapticReport")}：{hapticReport({ on: SESSION.prefs.haptic, len: SESSION.prefs.hapticLen })}
    </div>
  );
}
/** live full-screen / safe-area readout: the detected window insets plus what
 *  the settings actually apply, so a ROM that reports nothing is visible */
function SafeAreaReport({ t }: { t: ReturnType<typeof makeT> }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  const d = detectInsets();
  const p = SESSION.prefs;
  const ex = p.safeArea ? Math.max(0, Math.min(40, p.safeExtra || 0)) : 0;
  return (
    <div className="row-note" data-guide="safe-report">
      {t("safeReport")}：{t("safeAreaLabel")}={p.safeArea ? "ON" : "OFF"}
      {" · "}{t("safeExtraLabel")}={ex}px
      {" · 检测 上"}{d.top}{" 下"}{d.bottom}{" 左"}{d.left}{" 右"}{d.right}
    </div>
  );
}
/** one settings row, generated from its declaration in src/app/settings.ts.
 *  Every setting is its own card (label + control + description), so a
 *  description can never be read as the next setting's label. */
function SettingRow({ def, t }: { def: SettingDef; t: ReturnType<typeof makeT> }) {
  const v = SESSION.settingValue(def.path);
  const changed = !isDefault(SESSION, def);
  const resetBtn = changed ? (
    <button type="button" className="set-reset" title={t("setReset")} onClick={() => resetSetting(SESSION, def)}>
      <Icon id="i-undo" size={11} />
    </button>
  ) : null;
  const opts = def.options ?? [];
  const asDrop = def.control === "dropdown" || (def.control !== "chips" && opts.length > 6);
  const cur = opts.find((o) => o.value === v);
  return (
    <div className={"set-item" + (changed ? " changed" : "")} data-setting={def.path}>
      {/* switch / single-number rows keep the label and the control on one line */}
      <div className="set-line">
        <span className="set-name" title={t(def.label)}>{t(def.label)}{resetBtn}</span>
        {def.kind === "bool" && (
          <button className={"chip" + (v ? " on" : "")} onClick={() => SESSION.setSetting(def.path, !v)}>{v ? "ON" : "OFF"}</button>
        )}
        {def.kind === "int" && (
          <HoldAdjust dir="h" value={Number(v)} min={def.min ?? 0} max={def.max ?? 100} title={t(def.label)}
            format={(n) => (def.unit ?? "") + n} reset={Number(def.reset ?? def.default)}
            onChange={(n) => SESSION.setSetting(def.path, n)} />
        )}
      </div>
      {def.kind === "color" && (
        <div className="set-color">
          <input type="color" value={String(v)} onChange={(e) => SESSION.setSetting(def.path, e.target.value)} />
          <span className="set-hex">{String(v)}</span>
        </div>
      )}
      {def.kind === "enum" && (asDrop ? (
        <div className="set-drop">
          <DropMenu
            label={cur ? t(cur.label) : String(v)}
            title={t(def.label)}
            value={String(v)}
            options={opts.map((o) => ({ id: o.value, label: t(o.label) }))}
            onPick={(id) => SESSION.setSetting(def.path, id)}
          />
        </div>
      ) : (
        <div className="chips">
          {opts.map((o) => (
            <button key={o.value} className={"chip" + (v === o.value ? " on" : "")} onClick={() => SESSION.setSetting(def.path, o.value)}>{t(o.label)}</button>
          ))}
        </div>
      ))}
      {def.action && (
        <div className="row-actions">
          <Btn icon="i-check" label={t(def.action.label)} onClick={() => def.action!.run(SESSION)} />
        </div>
      )}
      {def.desc && <p className="set-desc">{t(def.desc)}</p>}
    </div>
  );
}

/** Settings dialog, generated entirely from the declaration table in
 *  src/app/settings.ts: adding a setting there makes it appear here. */
export function SettingsModal({ t, onClose }: { t: ReturnType<typeof makeT>; onClose: () => void }) {
  const snap = useSession();
  const [asInfo, setAsInfo] = useState<autosave.AutosaveMeta | null>(null);
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState("");
  useEffect(() => { void SESSION.autosaveInfo().then(setAsInfo); }, [snap]);
  const query = q.trim().toLowerCase();
  const hit = (d: SettingDef): boolean =>
    !query || t(d.label).toLowerCase().includes(query) ||
    (d.desc ? t(d.desc).toLowerCase().includes(query) : false) ||
    d.path.toLowerCase().includes(query);
  const doExport = () => {
    const bytes = new TextEncoder().encode(JSON.stringify(exportSettings(SESSION), null, 2));
    bridge.saveBytes("pixelcraft-settings.json", "application/json", bytes, (ok) => bridge.toast(ok ? t("exported") : t("saveCancel")));
  };
  const doImport = async () => {
    const f = await bridge.openFile("application/json");
    if (!f) return;
    try {
      const raw = JSON.parse(new TextDecoder().decode(f.bytes));
      const r = importSettings(SESSION, raw);
      bridge.toast(t("setImported") + r.applied + (r.skipped ? " · " + t("setSkipped") + r.skipped : ""));
    } catch {
      bridge.toast(t("setImportFail"));
    }
  };
  return (
    <>
      <div className="dlg-mask" onClick={onClose} />
      <div className="dlg" data-guide="dlg-settings">
        <div className="dlg-head"><span>{t("settings")}</span><div className="grow" /><button className="btn small" onClick={onClose}><Icon id="i-x" size={16} /></button></div>
        <div className="dlg-body">
          <div className="set-search" data-guide="set-search">
            <input value={q} placeholder={t("setSearch")} onChange={(e) => setQ(e.target.value)} />
            {q !== "" && <button type="button" className="btn small" onClick={() => setQ("")}><Icon id="i-x" size={14} /></button>}
          </div>
          <div className="row-actions set-io">
            <Btn label={t("setExport")} onClick={doExport} />
            <Btn label={t("setImport")} onClick={() => void doImport()} />
          </div>
          {SETTING_GROUPS.map((g) => {
            const items = settingsOfGroup(SESSION, g.id).filter(hit);
            if (!items.length) return null;
            const open = query !== "" || !folded[g.id];
            return (
              <div key={g.id} className="set-group">
                <button type="button" className="set-grouphead" onClick={() => setFolded({ ...folded, [g.id]: open })}>
                  <span>{t(g.label)}</span>
                  {items.some((d) => !isDefault(SESSION, d)) && <i className="set-dot" title={t("setChanged")} />}
                  <i className={"chev" + (open ? " open" : "")}>▾</i>
                </button>
                {open && items.map((d) => <SettingRow key={d.path} def={d} t={t} />)}
                {open && g.id === "screen" && <SafeAreaReport t={t} />}
                {open && g.id === "gesture" && canVibrate() === false && (
                  <div className="row-note">{t("hapticUnsupported")}</div>
                )}
                {open && g.id === "data" && (
                  <>
                    <div className="row-note">
                      {asInfo && asInfo.savedAt > 0
                        ? t("autosaveAt") + new Date(asInfo.savedAt).toLocaleString() + " · " + Math.max(1, Math.round(asInfo.bytes / 1024)) + "KB"
                          + (asInfo.name ? " · " + asInfo.name + " " + asInfo.w + "×" + asInfo.h : "")
                        : t("autosaveNone")}
                    </div>
                    <div className="row-actions">
                      <Btn label={t("autosaveNow")} onClick={() => { void SESSION.flushAutosave().then(() => SESSION.autosaveInfo().then(setAsInfo)); }} />
                      <Btn label={t("autosaveClear")} className="danger" onClick={() => { void SESSION.clearAutosave().then(() => setAsInfo(null)); }} />
                    </div>
                    {/* vibration diagnostics: what the page can actually see */}
                    <HapticReport t={t} />
                  </>
                )}
              </div>
            );
          })}
        </div>
        <div className="dlg-foot"><Btn label={t("close")} onClick={onClose} /></div>
      </div>
    </>
  );
}
export function FrameModal({ t, snap, fi, onClose, batch = false }: { t: ReturnType<typeof makeT>; snap: Snapshot; fi: number; onClose: () => void; batch?: boolean }) {
  // batch mode edits every frame picked in the timeline at once
  const [ms, setMs] = useState(SESSION.doc.frames[fi]?.durationMs ?? 100);
  const head = batch ? t("frameSelDur") + " · " + snap.frameSel.length : t("frames") + " " + (fi + 1);
  return (
    <>
      <div className="dlg-mask" onClick={onClose} />
      <div className="dlg">
        <div className="dlg-head"><span>{head}</span><div className="grow" /><button className="btn small" onClick={onClose}><Icon id="i-x" size={16} /></button></div>
        <div className="dlg-body">
          <label className="rowlabel">{t("frameDur")}</label>
          <ScrubNum min={1} max={60000} value={ms} onChange={(v) => setMs(Number(v) || 1)} />
        </div>
        <div className="dlg-foot"><Btn label={t("cancel")} onClick={onClose} />
          <Btn label={t("ok")} className="primary" onClick={() => {
            if (batch) SESSION.framesSetDuration(ms);
            else SESSION.setFrameDuration(fi, ms);
            onClose();
          }} /></div>
      </div>
    </>
  );
}
const H_ZH: Record<string, string> = { "canvas-close": "关闭画布", "canvas-size": "修改画布尺寸", "sprite-size": "整体缩放精灵", "layer-add": "新建图层", "layer-del": "删除图层", "layer-up": "上移图层", "layer-down": "下移图层", "layer-move": "拖拽重排图层", "layer-dupe": "复制图层", "layer-merge": "向下合并图层", "layer-visible": "图层可见性", "layer-solo": "只显示该图层", "layer-ref-edit": "引用图层改动(同步到源画布)", "layer-lock": "锁定图层", "layer-rename": "重命名图层", "layer-opacity": "图层不透明度", "layer-blend": "图层混合模式", "frame-add": "新建帧", "frame-del": "删除帧", "frame-move": "移动帧", "frame-switch": "切换帧", "frame-dupe": "复制帧", "frame-duration": "帧时长", "palette-set": "替换色板", "palette-add": "添加颜色", "palette-remove": "删除颜色", "import-layer": "导入为图层", "wand": "魔棒选区", "sel.grow": "扩展选区", "sel.shrink": "收缩选区", "sel.invert": "反选", "sel.lasso": "套索选区", "sel.move": "移动选区", "sel.rotate": "旋转选区", "sel.scale": "缩放选区", "adjust-color": "颜色调整", "palette-recolor": "色卡换色(整幅同步)", "outline-fill": "轮廓填充", "fx-outline": "描边", "fx-outline1": "描边 1px", "fx-blur": "模糊", "fx-shadow": "投影", "fx-glow": "外发光", "fx-invert": "反色", "fx-gray": "灰度", "fx-center": "居中" };
const H_EN: Record<string, string> = { "canvas-close": "Close canvas", "canvas-size": "Resize canvas", "sprite-size": "Scale sprite", "layer-add": "New layer", "layer-del": "Delete layer", "layer-up": "Move layer up", "layer-down": "Move layer down", "layer-move": "Reorder layer (drag)", "layer-dupe": "Duplicate layer", "layer-merge": "Merge layer down", "layer-visible": "Layer visibility", "layer-solo": "Solo layer", "layer-ref-edit": "Reference layer edit (synced to source)", "layer-lock": "Lock layer", "layer-rename": "Rename layer", "layer-opacity": "Layer opacity", "layer-blend": "Layer blend mode", "frame-add": "New frame", "frame-del": "Delete frame", "frame-move": "Move frame", "frame-switch": "Switch frame", "frame-dupe": "Duplicate frame", "frame-duration": "Frame duration", "palette-set": "Replace palette", "palette-add": "Add color", "palette-remove": "Remove color", "import-layer": "Import as layer", "wand": "Magic wand select", "sel.grow": "Grow selection", "sel.shrink": "Shrink selection", "sel.invert": "Invert selection", "sel.lasso": "Lasso select", "sel.move": "Move selection", "sel.rotate": "Rotate selection", "sel.scale": "Scale selection", "adjust-color": "Adjust color", "palette-recolor": "Recolor palette (sprite)", "outline-fill": "Outline fill", "fx-outline": "Outline", "fx-outline1": "Outline 1px", "fx-blur": "Blur", "fx-shadow": "Drop shadow", "fx-glow": "Outer glow", "fx-invert": "Invert", "fx-gray": "Grayscale", "fx-center": "Center" };
export function histName(label: string, t: ReturnType<typeof makeT>, lang: string): string {
  const m = lang === "zh" ? H_ZH : H_EN;
  if (m[label]) return m[label];
  const tr = t(label);
  return tr === label ? label : tr;
}
export function HistoryModal({ t, snap, onClose, onReplay }: { t: ReturnType<typeof makeT>; snap: Snapshot; onClose: () => void; onReplay: () => void }) {
  const { labels, index } = SESSION.history.list();
  const rows = [{ key: 0, label: t("historyStart") } as { key: number; label: string }].concat(labels.map((lb, i) => ({ key: i + 1, label: histName(lb, t, snap.lang) })));
  return (
    <>
      <div className="dlg-mask" onClick={onClose} />
      <div className="dlg">
        <div className="dlg-head"><span>{t("historyTitle")}</span><div className="grow" /><button className="btn small" onClick={onClose}><Icon id="i-x" size={16} /></button></div>
        {SESSION.prefs.histMode === "full"
          ? <div className="hist-mode-note full">{t("histNoteFull")}</div>
          : <div className="hist-mode-note">{t("histNoteStepsA")} {SESSION.history.limit()} {t("histNoteStepsB")}</div>}
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

function FrameThumb({ doc, fi, sz = 132 }: { doc: Doc; fi: number; sz?: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const SZ = sz;
    cv.width = SZ; cv.height = SZ;
    const full = compose.composeFrame(doc, fi);
    const z = Math.min(SZ / doc.w, SZ / doc.h);
    const w = Math.max(1, Math.round(doc.w * z)), h = Math.max(1, Math.round(doc.h * z));
    const ctx = cv.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#1d2129";
    ctx.fillRect(0, 0, SZ, SZ);
    ctx.drawImage(full, (SZ - w) >> 1, (SZ - h) >> 1, w, h);
  }, [doc, fi, sz]);
  return <canvas ref={ref} className="fp-thumb" style={{ width: sz, height: sz }} />;
}

/** pick another canvas to mirror into the focused one as a live layer */
export function CanvasRefModal({ t, onClose }: { t: ReturnType<typeof makeT>; onClose: () => void }) {
  useSession(); // the list must follow canvases opening / closing / renaming
  const cur = SESSION.docIdx;
  // "layers" (default) mirrors every source layer as its own live layer, so a
  // stroke edits exactly the layer you painted on; "flat" keeps one layer that
  // mirrors the whole canvas (edits go to the source's selected layer)
  const [mode, setMode] = useState<"layers" | "flat">("layers");
  const list = SESSION.docs.map((e, i) => ({ e, i })).filter(({ i }) => i !== cur);
  return (
    <>
      <div className="dlg-mask" onClick={onClose} />
      <div className="dlg dlg-frame-preview dlg-canvasref" data-guide="dlg-canvasref">
        <div className="dlg-head"><span>{t("canvasRefPick")}</span><div className="grow" /><button className="btn small" onClick={onClose}><Icon id="i-x" size={16} /></button></div>
        <div className="ref-mode">
          {(["layers", "flat"] as const).map((m) => (
            <button key={m} className={"ref-mode-btn" + (mode === m ? " on" : "")} onClick={() => setMode(m)}>
              <b>{t(m === "layers" ? "canvasRefModeLayers" : "canvasRefModeFlat")}</b>
              <span>{t(m === "layers" ? "canvasRefModeLayersDesc" : "canvasRefModeFlatDesc")}</span>
            </button>
          ))}
        </div>
        <div className="dlg-body fp-grid">
          {list.length === 0 ? <div className="row-note">{t("canvasRefNone")}</div> : list.map(({ e, i }) => (
            <button key={e.id} className="fp-cell col" style={{ width: 178, height: 190 }}
              title={e.doc.name + " · " + e.doc.w + "\u00d7" + e.doc.h + " · " + e.doc.layers.length + t("canvasRefLayerCount")}
              onClick={() => { if (SESSION.referenceCanvas(i, { mode })) onClose(); }}>
              <FrameThumb doc={e.doc} fi={e.fi} sz={124} />
              <span className="fp-name">{e.doc.name || "untitled"}</span>
              <span className="fp-meta">{e.doc.w + "\u00d7" + e.doc.h + " · " + e.doc.layers.length + t("canvasRefLayerCount")}</span>
            </button>
          ))}
        </div>
        <div className="dlg-foot"><Btn label={t("close")} onClick={onClose} /></div>
      </div>
    </>
  );
}

export function FramePreviewModal({ t, onClose }: { t: ReturnType<typeof makeT>; onClose: () => void }) {
  const snap = useSession();
  const doc = SESSION.doc;
  const frames = doc.frames;
  // two-finger pinch scales the thumbnails (persisted); double-tap a thumbnail
  // is not used here, the reset button in the footer restores the default
  const DEF = 142;
  const [cell, setCell] = useState(() => {
    try { const n = parseInt(localStorage.getItem("pc.fprev.cell") || String(DEF), 10); return n >= 80 && n <= 320 ? n : DEF; } catch { return DEF; }
  });
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d0: number; c0: number } | null>(null);
  const dist = () => { const [a, b] = [...pts.current.values()]; return Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)); };
  const setCellSize = (n: number) => {
    const v = Math.max(80, Math.min(320, Math.round(n)));
    if (v === cell) return;
    setCell(v);
    try { localStorage.setItem("pc.fprev.cell", String(v)); } catch { /* ignore */ }
  };
  const thumb = Math.max(40, cell - 10);
  return (
    <>
      <div className="dlg-mask" onClick={onClose} />
      <div className="dlg dlg-frame-preview">
        <div className="dlg-head"><span>{t("framePreview")}</span><div className="grow" /><button className="btn small" onClick={onClose}><Icon id="i-x" size={16} /></button></div>
        <div className="dlg-body fp-grid" style={{ touchAction: "pan-y" }}
          onPointerDown={(e) => {
            pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pts.current.size === 2) pinch.current = { d0: dist(), c0: cell };
          }}
          onPointerMove={(e) => {
            if (!pts.current.has(e.pointerId)) return;
            pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
            const p = pinch.current;
            if (!p || pts.current.size < 2) return;
            e.preventDefault();
            setCellSize(p.c0 * (dist() / p.d0));
          }}
          onPointerUp={(e) => { pts.current.delete(e.pointerId); if (pts.current.size < 2) pinch.current = null; }}
          onPointerCancel={(e) => { pts.current.delete(e.pointerId); if (pts.current.size < 2) pinch.current = null; }}>
          {frames.length === 0 ? <div className="row-note">{t("historyEmpty")}</div> : frames.map((f, i) => (
            <button key={f.id} className={"fp-cell" + (i === snap.frameIdx ? " on" : "")}
              style={{ width: cell, height: cell }} onClick={() => { SESSION.setFrame(i); onClose(); }}>
              <FrameThumb doc={doc} fi={i} sz={thumb} />
            </button>
          ))}
        </div>
        <div className="dlg-foot">
          {cell !== DEF && <Btn label={t("resetLabel")} onClick={() => setCellSize(DEF)} />}
          <Btn label={t("close")} onClick={onClose} />
        </div>
      </div>
    </>
  );
}
