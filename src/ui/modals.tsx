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
import * as ase from "../io/aseread";
import { TAG_COLORS, tagRangeLabel } from "../engine/tags";
import * as compose from "../render/compositor";
import * as exporters from "../io/exporters";
import * as bridge from "../io/bridge";
import * as autosave from "../io/autosave";
import { Btn, Icon, useSession, ScrubNum, useBlankTap } from "./base";
import { DropMenu, TabBar } from "./tabs";
import { canVibrate, hapticReport } from "../io/bridge";
import { detectInsets } from "../io/safearea";
import type { RefImg } from "./refimg";
import { Dialog, Row, RowActions, NumberField, ColorField, ChipGroup, Segmented, Switch, useKitPcMode } from "./kit";
import { SHORTCUT_SHEET } from "../app/shortcuts";
import { REBINDABLE, chordForAction, chordLabel, chordOf, isOverridden, overrides } from "../app/keymap";
import { CBAR_ACTIONS, LAYOUT_KEYS, ORB_IDS, TOPBAR_ACTIONS, fullOrder } from "../app/uibar";

export type ModalId = "menu" | "changelog" | "newdoc" | "newproject" | "export" | "adjust" | "settings" | "frame" | "framePrev" | "size" | "sheet" | "history" | "canvasRef" | "shortcuts" | "customise" | null;
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
        <Row label={t("presets")}>
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
        </Row>
        <RowActions>
          <Btn icon="i-plus" label={t("palPresetSave")} onClick={() => {
            const name = SESSION.savePalettePreset();
            bridge.toast(name ? t("palPresetSaved") + name : t("palDedupeNone"));
          }} />
        </RowActions>
        <RowActions>
          <Btn icon="i-indexed" label={t("indexedMode")} active={SESSION.prefs.indexed}
            title={t(SESSION.prefs.indexed ? "indexedOn" : "indexedOff")}
            onClick={() => SESSION.setIndexed(!SESSION.prefs.indexed)} guide="pal-indexed" />
          {SESSION.prefs.indexed && (
            <Btn icon="i-dedupe" label={t("indexedRemap")} title={t("indexedRemapHint")}
              onClick={() => SESSION.remapToPalette("canvas")} guide="pal-remap" />
          )}
        </RowActions>
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
            <Row label={<>{t("recolor")} · 旧色 #{rgbaToHex(doc.palette[recolor.i]).slice(1)}</>}>
            <div className="ce-row">
              <input type="color" value={recColor} onChange={(e) => setRecColor(e.target.value)} />
              <span className="ce-hex">{recColor}</span>
            </div>
            </Row>
            <RowActions>
              <Btn label={t("recolorApply")} className="primary" onClick={() => { SESSION.recolorPaletteColor(recolor.i, hexToRgba(recColor)); setRecolor(null); }} />
              <Btn label={t("cancel")} onClick={() => setRecolor(null)} />
            </RowActions>
          </div>
        )}
        {palMode === "palette" && (
        <RowActions data-guide="pal-export">
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
        </RowActions>
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
export async function openFlow(mode: "new" | "layer"): Promise<void> {
  const f = await bridge.openFile("*/*");
  if (!f) return;
  await openFileBytes(f.name || "", f.bytes, mode, f.mime || "");
}

/** 打开一份「已经拿到字节」的文件（文件选择框与窗口拖放共用） */
export async function openFileBytes(name: string, bytes: Uint8Array, mode: "new" | "layer" = "new", mime = ""): Promise<boolean> {
  const t = makeT(SESSION.prefs.lang);
  const f = { name, bytes, mime };
  const ext = (f.name || "").split(".").pop()?.toLowerCase();
  const isGif = ext === "gif" || isGifHeader(f.bytes);
  if (!isGif && (ext === "pxc" || f.name.toLowerCase().endsWith(".pxc") || ext === "json")) {
    if (mode !== "new") { bridge.toast(t("importFail")); return false; }
    const txt = new TextDecoder().decode(f.bytes);
    const ok = await SESSION.loadProjectText(txt);
    bridge.toast(ok ? t("docLoaded") : t("importFail"));
    return ok;
  }
  // Aseprite (.ase / .aseprite): detected by magic, so a wrong extension still works
  if (ext === "ase" || ext === "aseprite" || ase.isAseBytes(f.bytes)) {
    const r = ase.readAseDoc(f.bytes, f.name || "sprite");
    if (!r.ok || !r.doc) { bridge.toast(t(r.reason || "importFail")); return false; }
    if (mode === "layer") {
      // flatten the first frame and drop it in as one layer
      const flat = compose.composeFrame(r.doc, 0);
      const px = flat.getContext("2d")!.getImageData(0, 0, flat.width, flat.height).data;
      const okLayer = addAsLayer(flat.width, flat.height, px, f.name);
      bridge.toast(okLayer ? t("importOk") : t("importFail") + " (size)");
      return okLayer;
    }
    if (!r.doc.palette.length) r.doc.palette = SESSION.doc.palette.map((c) => [c[0], c[1], c[2], c[3]]);
    const ok = await SESSION.replaceDoc(r.doc);
    bridge.toast(ok ? t("docLoaded") + (r.doc.layers.length > 1 || r.doc.frames.length > 1 ? " · " + r.doc.layers.length + "L/" + r.doc.frames.length + "F" : "") : t("importFail"));
    return ok;
  }
  if (isGif) {
    const gif = tryReadGif(f.bytes);
    if (gif) {
      if (mode === "new") {
        const ok = await SESSION.replaceDoc(docFromGifFrames(gif.w, gif.h, gif.frames, gif.delays, f.name));
        bridge.toast(ok ? t("importOk") + " " + gif.frames.length + "f" : t("importFail"));
        return ok;
      }
      const asLayer = addAsLayer(gif.w, gif.h, gif.frames[0] as unknown as Uint8ClampedArray, f.name);
      bridge.toast(asLayer ? t("importOk") : t("importFail") + " (size)");
      return asLayer;
    }
  }
  const still = await decodeStill(f.bytes, f.mime || "image/png");
  if (!still) { bridge.toast(t("importFail")); return false; }
  if (mode === "layer") {
    const ok = addAsLayer(still.w, still.h, still.px, f.name);
    bridge.toast(ok ? t("importOk") : t("importFail") + " (size)");
    return ok;
  }
  const ok = await SESSION.replaceDoc(docFromPixels(still.w, still.h, still.px, f.name));
  bridge.toast(ok ? t("importOk") : t("importFail"));
  return ok;
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
      <Dialog title={t("menu")} onClose={onClose} bodyClass="col">
        {!sub ? (<>
          {go("newproject")(t("newProject"), "i-new", "menu-new")}
          {act(t("save"), "i-save", () => void saveProject(), "menu-save")}
          {go("export")(t("exportCanvas"), "i-export", "menu-export")}
          {act(t("open"), "i-open", () => void openFlow("new"), "menu-open")}
          <Btn label={t("import")} icon="i-import" className="menuitem" guide="menu-import" onClick={() => setSub("import")} />
          {go("settings")(t("settings"), "i-gear", "menu-settings")}
          {go("shortcuts")(t("shortcutHelp"), "i-keys", "menu-shortcuts")}
          {go("customise")(t("customise"), "i-grid", "menu-customise")}
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
      </Dialog>
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
      <Dialog title={t("resizeTitle")} onClose={onClose} footer={<><Btn label={t("cancel")} onClick={onClose} /><Btn label={t("ok")} onClick={apply} className="primary" /></>}>
        <ChipGroup value={mode} onChange={switchMode} options={[
          { id: "canvas", label: t("canvasSize") },
          { id: "sprite", label: t("spriteSize") },
        ]} />
        <NumberField label={t("docs.w")} min={1} max={1024} value={w} onChange={(v) => onW(v)} />
        <NumberField label={t("docs.h")} min={1} max={1024} value={h} onChange={(v) => onH(v)} />
        <div className="chips"><button className={"chip" + (locked ? " on" : "")} onClick={() => setLocked(!locked)}>{t("lockRatio")}</button></div>
        {mode === "canvas" ? (<><Row label={t("anchor")}><div className="anchor-grid">{[0, 1, 2].map((r) => <div className="anchor-row" key={r}>{[0, 1, 2].map((c) => cell(r, c))}</div>)}</div></Row><p className="size-note">{t("canvasNote")}</p></>) : <p className="size-note">{t("spriteNote")}</p>}
      </Dialog>
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
      <Dialog title={t("importSheet")} onClose={onClose} footer={<><Btn label={t("cancel")} onClick={onClose} /><Btn label={t("ok")} onClick={apply} className="primary" /></>}>
        <div className="row-note">{img.name} · {img.w}×{img.h}</div>
        <NumberField label={t("sheetCellW")} min={1} value={cw} onChange={(v) => setCw(v)} />
        <NumberField label={t("sheetCellH")} min={1} value={ch} onChange={(v) => setCh(v)} />
        <div className="row-note">{t("sheetFrames")}: {cols * rows} ({cols}×{rows})</div>
      </Dialog>
    </>
  );
}
export function NewDocModal({ t, onClose, mode = "canvas" }: { t: ReturnType<typeof makeT>; onClose: () => void; mode?: "canvas" | "project" }) {
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
    const bg: [number, number, number, number] | null = white ? [255, 255, 255, 255] : null;
    const ok = mode === "project"
      ? await SESSION.newProject(nw, nh, name || "untitled", bg)
      : await SESSION.newDoc(nw, nh, name || "untitled", bg);
    if (ok) onClose();
  };
  return (
    <>
      <Dialog title={t(mode === "project" ? "newProject" : "newDoc")} onClose={onClose} footer={<><Btn label={t("cancel")} onClick={onClose} /><Btn label={t("ok")} onClick={apply} className="primary" /></>}>
        {mode === "project" && <div className="row-note">{t("newProjectNote")}</div>}
        <Row label={t("name")}>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Row>
        <NumberField label={t("docs.w")} min={1} max={1024} value={w} onChange={(v) => setW(v)} />
        <NumberField label={t("docs.h")} min={1} max={1024} value={h} onChange={(v) => setH(v)} />
        <div className="chips"><button className={"chip" + (white ? " on" : "")} onClick={() => setWhite(!white)}>{t("whiteBg")}</button></div>
      </Dialog>
    </>
  );
}
export function ExportModal({ t, snap, onClose }: { t: ReturnType<typeof makeT>; snap: Snapshot; onClose: () => void }) {
  const guideTab = (window as unknown as { __pcGuideExportTab?: string }).__pcGuideExportTab;
  const [tab, setTab] = useState<"png" | "gif" | "sheet" | "layers" | "ase">(guideTab === "gif" ? "gif" : "png");
  const [scope, setScope] = useState<"frame" | "layer" | "sel">("frame");
  const [scale, setScale] = useState(1);
  const [bgMode, setBgMode] = useState<"transparent" | "white">("transparent");
  const [cols, setCols] = useState(Math.min(8, snap.frameCount));
  /** 导出进行中（按钮禁用 + 文案提示），避免重复点击与「点了没反应」 */
  const [busy, setBusy] = useState(false);
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
    // 每个图层 × 每帧都会弹一次保存框：文件太多先问一句，别把系统刷爆
    const fileCount = doc.layers.length * (range[1] - range[0] + 1);
    if (fileCount > exporters.MAX_LAYER_FILES) {
      const ok = await SESSION.askConfirm({
        msg: t("exportLayerManyA") + fileCount + t("exportLayerManyB"),
        yes: t("ok"), no: t("cancel"),
      });
      if (!ok) return;
    }
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
  // 导出的每一步都包一层：忙状态 + 失败原因提示（以前 Promise 没有 catch，
  // 出错时界面完全没反应，用户只会觉得「点了没动静」）
  const reason = (e: unknown): string => {
    const m = e instanceof Error ? e.message : String(e);
    if (m === "tooBigImage") return t("exportTooBig");
    if (m === "tooBigAnim") return t("exportTooBigAnim");
    if (m === "gif-writer-missing") return t("exportFailed") + " (GIF)";
    return t("exportFailed") + ": " + m;
  };
  const run = async (fn: () => Promise<void>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try { await fn(); } catch (e) { bridge.toast(reason(e)); } finally { setBusy(false); }
  };
  const doExport = () => {
    const doc = SESSION.doc;
    const li = scope === "layer" ? SESSION.curLayer() : null;
    const b = scope === "sel" && doc.sel ? doc.sel.bounds() : null;
    const bg: [number, number, number, number] | null = bgMode === "white" ? [255, 255, 255, 255] : null;
    const o = { bg, scale, li, bounds: b, range };
    if (tab === "png") {
      void run(async () => {
        const r = await exporters.exportPNG(doc, snap.frameIdx, o);
        if (r) bridge.saveBytes(r.name, "image/png", r.bytes, (ok) => bridge.toast(ok ? t("exported") : t("saveCancel")));
      });
    } else if (tab === "gif") {
      void run(async () => {
        const r = await exporters.exportGIF(doc, { ...o, range });
        bridge.saveBytes(r.name, "image/gif", r.bytes, (ok) => bridge.toast(ok ? t("exported") : t("saveCancel")));
      });
    } else if (tab === "sheet") {
      void run(async () => {
        const r = await exporters.exportSheet(doc, { ...o, cols, range });
        if (!r) return;
        bridge.saveBytes(r.name, "image/png", r.png, (ok1) => {
          if (ok1) bridge.saveBytes(r.jsonName, "application/json", r.json, (ok2) => bridge.toast(ok2 ? t("exported") : t("saveCancel")));
          else bridge.toast(t("saveCancel"));
        });
      });
    } else if (tab === "ase") {
      void run(async () => {
        const r = await exporters.exportASE(doc);
        bridge.saveBytes(r.name, "application/octet-stream", r.bytes, (ok) => bridge.toast(ok ? t("exported") : t("saveCancel")));
      });
    } else {
      void run(exportLayersFlow);
    }
  };
  // 输出尺寸 + 预算检查：超大导出在点之前就拦住（以前会把标签页/手机拖死）。
  // Aseprite 导出输出的是一份文档而不是一张图，所以没有缩放/尺寸这一行。
  const size = (() => {
    if (tab === "ase") return null;
    const doc = SESSION.doc;
    const bounds = scope === "sel" && doc.sel ? doc.sel.bounds() : null;
    const fw = (bounds && bounds.w > 0 ? bounds.w : doc.w) * scale;
    const fh = (bounds && bounds.h > 0 ? bounds.h : doc.h) * scale;
    const n = tab === "png" ? 1 : rTo - rFrom + 1;
    const colsN = tab === "sheet" ? Math.max(1, Math.min(n, cols)) : 1;
    const rowsN = tab === "sheet" ? Math.ceil(n / colsN) : 1;
    const outW = fw * colsN;
    const outH = fh * rowsN;
    const err = exporters.exportBudgetError(outW, outH, 1, 1, "image") ||
      (tab === "png" ? null : exporters.exportBudgetError(fw, fh, 1, n, "anim"));
    return { outW, outH, n, err };
  })();
  return (
    <>
      <Dialog title={t("export")} onClose={onClose} guide="dlg-export" footer={<><Btn label={t("cancel")} onClick={onClose} /><Btn label={busy ? t("exporting") : t("export")} onClick={doExport} className="primary" /></>}>
        <Segmented value={tab} onChange={setTab} options={[
          { id: "png", label: "PNG" },
          { id: "gif", label: "GIF" },
          { id: "sheet", label: t("exportSheet") },
          { id: "layers", label: t("exportLayers") },
          { id: "ase", label: t("exportAseprite") },
        ]} />
        {tab === "layers" ? <div className="row-note">{t("layersNote")}</div> : tab === "ase" ? <div className="row-note" data-guide="exp-ase">{t("aseNote")}</div> : (<>
        <Row label={t("srcScope")}>
          <ChipGroup value={scope} onChange={setScope} options={[
            { id: "frame", label: t("srcFrame") },
            { id: "layer", label: t("srcLayer") },
            { id: "sel", label: t("srcSel"), hidden: !selAvail },
          ]} />
        </Row>
        <Row label={t("bgCustom")}>
          <ChipGroup value={bgMode} onChange={setBgMode} options={[
            { id: "transparent", label: t("transparent") },
            { id: "white", label: t("whiteBg") },
          ]} />
        </Row>
        </>)}
        {tab !== "ase" && (
        <Row label={t("scale")}>
          <ChipGroup value={String(scale)} onChange={(id) => setScale(Number(id))}
            options={[1, 2, 4, 8].map((n) => ({ id: String(n), label: n + "x" }))} />
        </Row>
        )}
        {tab !== "png" && tab !== "ase" && (<>
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
            {snap.activeTag && (
              <button className="chip" data-guide="exp-range-tag" onClick={() => {
                setRFrom(snap.activeTag!.from + 1);
                setRTo(snap.activeTag!.to + 1);
              }}>{t("frameRangeTag")}: {snap.activeTag.name}</button>
            )}
          </div>
        </>)}
        {tab === "sheet" && <NumberField label={t("columns")} min={1} max={rTo - rFrom + 1} value={cols}
          onChange={(v) => setCols(Math.max(1, Math.min(rTo - rFrom + 1, Number(v) || 1)))} />}
        {/* 输出尺寸 + 预算检查：超大导出在点之前就拦住（以前会把标签页/手机拖死） */}
        {size && (
          <div className={"row-note" + (size.err ? " warn" : "")} data-guide="exp-size">
            {t("exportSize")}: <b>{size.outW}×{size.outH}</b>
            {tab === "png" ? "" : " · " + size.n + " " + t("frames")}
            {size.err ? " · " + t(size.err === "tooBigAnim" ? "exportTooBigAnim" : "exportTooBig") : ""}
          </div>
        )}
      </Dialog>
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
      <Dialog title={t("adjust")} onClose={closeCancel} bodyClass="col" footer={<><Btn label={t("cancel")} onClick={closeCancel} /><Btn label={t("ok")} className="primary" onClick={() => { SESSION.adjustCommit(); onClose(); }} /></>}>
        <ChipGroup value={scope} onChange={setScope} options={[
          { id: "doc", label: t("scopeDoc") },
          { id: "layer", label: t("scopeLayer") },
        ]} />
        <div className="adj3">
          <HoldAdjust dir="h" fixedBottom value={hue} min={-180} max={180} title={t("hueL")} format={(v) => "H" + Math.round(v)} reset={0} onChange={(v) => { setHue(v); live(v, sat, light); }} />
          <HoldAdjust dir="h" fixedBottom value={sat} min={0} max={200} title={t("satL")} format={(v) => "S" + Math.round(v) + "%"} reset={100} onChange={(v) => { setSat(v); live(hue, v, light); }} />
          <HoldAdjust dir="h" fixedBottom value={light} min={-100} max={100} title={t("lightL")} format={(v) => "L" + Math.round(v)} reset={0} onChange={(v) => { setLight(v); live(hue, sat, v); }} />
        </div>
      </Dialog>
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
          <Switch checked={!!v} label={t(def.label)} onChange={(on) => SESSION.setSetting(def.path, on)} />
        )}
        {def.kind === "int" && (
          <HoldAdjust dir="h" value={Number(v)} min={def.min ?? 0} max={def.max ?? 100} title={t(def.label)}
            format={(n) => (def.unit ?? "") + n} reset={Number(def.reset ?? def.default)}
            onChange={(n) => SESSION.setSetting(def.path, n)} />
        )}
      </div>
      {def.kind === "color" && (
        <ColorField value={String(v)} onChange={(c) => SESSION.setSetting(def.path, c)} />
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
        <ChipGroup value={String(v)} onChange={(id) => SESSION.setSetting(def.path, id)}
          options={opts.map((o) => ({ id: o.value, label: t(o.label) }))} />
      ))}
      {def.action && (
        <RowActions>
          <Btn icon="i-check" label={t(def.action.label)} onClick={() => def.action!.run(SESSION)} />
        </RowActions>
      )}
      {def.desc && <p className="set-desc">{t(def.desc)}</p>}
    </div>
  );
}

/** Settings dialog, generated entirely from the declaration table in
 *  src/app/settings.ts: adding a setting there makes it appear here. */
export function SettingsModal({ t, onClose }: { t: ReturnType<typeof makeT>; onClose: () => void }) {
  const pc = useKitPcMode();
  const [pcCat, setPcCat] = useState<string>("general");
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
      <Dialog title={t("settings")} onClose={onClose} guide="dlg-settings" footer={<><Btn label={t("close")} onClick={onClose} /></>}>
        <div className="set-search" data-guide="set-search">
          <input value={q} placeholder={t("setSearch")} onChange={(e) => setQ(e.target.value)} />
          {q !== "" && <button type="button" className="btn small" onClick={() => setQ("")}><Icon id="i-x" size={14} /></button>}
        </div>
        <RowActions className="set-io">
          <Btn label={t("setExport")} onClick={doExport} />
          <Btn label={t("setImport")} onClick={() => void doImport()} />
        </RowActions>
        {(() => {
          const renderGroup = (g: typeof SETTING_GROUPS[number]) => {
          const items = settingsOfGroup(SESSION, g.id).filter(hit);
          if (!items.length) return null;
          const open = query !== "" || !folded[g.id] || pcCat === g.id;
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
                  <RowActions>
                    <Btn label={t("autosaveNow")} onClick={() => { void SESSION.flushAutosave().then(() => SESSION.autosaveInfo().then(setAsInfo)); }} />
                    <Btn label={t("autosaveClear")} className="danger" onClick={() => { void SESSION.clearAutosave().then(() => setAsInfo(null)); }} />
                  </RowActions>
                  {/* vibration diagnostics: what the page can actually see */}
                  <HapticReport t={t} />
                </>
              )}
            </div>
          );
          };
          // ⑮ PC：左侧类别列表 + 右侧当前类别的设置（搜索时跨类别显示结果）
          if (pc) {
            const groups = SETTING_GROUPS.filter((g) => settingsOfGroup(SESSION, g.id).filter(hit).length > 0);
            const active = query !== "" ? null : groups.find((g) => g.id === pcCat) ?? groups[0];
            return (
              <div className="set-split">
                <div className="set-cats">
                  {groups.map((g) => (
                    <button key={g.id} type="button"
                      className={"set-cat" + (active && active.id === g.id ? " on" : "")}
                      onClick={() => { setPcCat(g.id); setQ(""); }}>
                      <span>{t(g.label)}</span>
                      {settingsOfGroup(SESSION, g.id).some((d) => !isDefault(SESSION, d)) && <i className="set-dot" />}
                    </button>
                  ))}
                </div>
                <div className="set-pane">
                  {query !== ""
                    ? groups.map((g) => renderGroup(g))
                    : (active ? renderGroup(active) : null)}
                </div>
              </div>
            );
          }
          return SETTING_GROUPS.map((g) => renderGroup(g));
        })()}
      </Dialog>
    </>
  );
}
export function FrameModal({ t, snap, fi, onClose, batch = false }: { t: ReturnType<typeof makeT>; snap: Snapshot; fi: number; onClose: () => void; batch?: boolean }) {
  // batch mode edits every frame picked in the timeline at once
  const [ms, setMs] = useState(SESSION.doc.frames[fi]?.durationMs ?? 100);
  const head = batch ? t("frameSelDur") + " · " + snap.frameSel.length : t("frames") + " " + (fi + 1);
  return (
    <>
      <Dialog title={head} onClose={onClose} footer={<><Btn label={t("cancel")} onClick={onClose} /> <Btn label={t("ok")} className="primary" onClick={() => { if (batch) SESSION.framesSetDuration(ms); else SESSION.setFrameDuration(fi, ms); onClose(); }} /></>}>
        <NumberField label={t("frameDur")} min={1} max={60000} value={ms} onChange={(v) => setMs(Number(v) || 1)} />
      </Dialog>
    </>
  );
}
/**
 * Animation tag editor. A tag is a named frame range: playback started on a
 * frame inside it stays inside that range. Everything applies live through
 * Session, so every edit is a single undo step and the timeline bar follows.
 */
export function TagModal({ t, snap, id, onClose }: { t: ReturnType<typeof makeT>; snap: Snapshot; id: string; onClose: () => void }) {
  const tag = SESSION.tagById(id);
  const [name, setName] = useState(tag?.name ?? "");
  const [from, setFrom] = useState(String((tag?.from ?? 0) + 1));
  const [to, setTo] = useState(String((tag?.to ?? 0) + 1));
  const [color, setColor] = useState(tag?.color ?? TAG_COLORS[0]);
  const n = snap.frameCount;
  if (!tag) return null;
  const commit = () => {
    SESSION.tagRename(id, name);
    const a = Math.max(1, Math.min(n, parseInt(from, 10) || 1));
    const b = Math.max(1, Math.min(n, parseInt(to, 10) || 1));
    SESSION.tagSetRange(id, a - 1, b - 1);
    SESSION.tagSetColor(id, color);
    onClose();
  };
  const remove = () => { SESSION.tagRemove(id); onClose(); };
  return (
    <>
      <Dialog title={t("tagEdit")} onClose={onClose} footer={<>
        <Btn label={t("tagDelete")} danger onClick={remove} />
        <div className="grow" />
        <Btn label={t("cancel")} onClick={onClose} />
        <Btn label={t("ok")} className="primary" onClick={commit} />
      </>}>
        <div className="row-note">{t("tagNote")}</div>
        <Row label={t("name")}>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") commit(); else if (e.key === "Escape") onClose(); }} />
        </Row>
        <Row label={t("tagFrames")}>
          <div className="chips fsel-range">
            <ScrubNum min={1} max={n} value={parseInt(from, 10) || 1} onChange={(v) => {
              const k = Math.max(1, Math.min(n, Number(v) || 1));
              setFrom(String(k));
              if (k > (parseInt(to, 10) || 1)) setTo(String(k));
            }} />
            <span className="fsel-dash">–</span>
            <ScrubNum min={1} max={n} value={parseInt(to, 10) || 1} onChange={(v) => {
              const k = Math.max(1, Math.min(n, Number(v) || 1));
              setTo(String(k));
              if (k < (parseInt(from, 10) || 1)) setFrom(String(k));
            }} />
            <span className="fsel-count">{tagRangeLabel({ from: (parseInt(from, 10) || 1) - 1, to: (parseInt(to, 10) || 1) - 1 })}</span>
          </div>
        </Row>
        <Row label={t("tagColor")}>
          <div className="tag-colors">
            {TAG_COLORS.map((c) => (
              <button key={c} type="button" className={"tag-dot" + (c === color ? " on" : "")}
                style={{ background: c }} title={c} onClick={() => setColor(c)} />
            ))}
          </div>
        </Row>
        <RowActions>
          <Btn icon="i-play" label={t("tagPlayThis")} onClick={() => { SESSION.tagPlay(id); onClose(); }} />
          <Btn icon="i-framesel" label={t("tagPickFrames")} onClick={() => { SESSION.tagSelectFrames(id); onClose(); }} />
        </RowActions>
      </Dialog>
    </>
  );
}
const H_ZH: Record<string, string> = { "canvas-close": "关闭画布", "canvas-size": "修改画布尺寸", "sprite-size": "整体缩放精灵", "layer-add": "新建图层", "layer-del": "删除图层", "layer-up": "上移图层", "layer-down": "下移图层", "layer-move": "拖拽重排图层", "layer-dupe": "复制图层", "layer-merge": "向下合并图层", "layer-visible": "图层可见性", "layer-solo": "只显示该图层", "layer-ref-edit": "引用图层改动(同步到源画布)", "layer-lock": "锁定图层", "layer-rename": "重命名图层", "layer-opacity": "图层不透明度", "layer-blend": "图层混合模式", "frame-add": "新建帧", "frame-del": "删除帧", "frame-move": "移动帧", "frame-switch": "切换帧", "frame-dupe": "复制帧", "frame-duration": "帧时长", "tag-add": "新建动画标签", "tag-rename": "重命名动画标签", "tag-range": "调整标签范围", "tag-color": "标签颜色", "tag-del": "删除动画标签", "palette-set": "替换色板", "palette-add": "添加颜色", "palette-remove": "删除颜色", "import-layer": "导入为图层", "wand": "魔棒选区", "sel.grow": "扩展选区", "sel.shrink": "收缩选区", "sel.invert": "反选", "sel.lasso": "套索选区", "sel.move": "移动选区", "sel.rotate": "旋转选区", "sel.scale": "缩放选区", "adjust-color": "颜色调整", "palette-recolor": "色卡换色(整幅同步)", "outline-fill": "轮廓填充", "fx-outline": "描边", "fx-outline1": "描边 1px", "fx-blur": "模糊", "fx-shadow": "投影", "fx-glow": "外发光", "fx-invert": "反色", "fx-gray": "灰度", "fx-center": "居中" };
const H_EN: Record<string, string> = { "canvas-close": "Close canvas", "canvas-size": "Resize canvas", "sprite-size": "Scale sprite", "layer-add": "New layer", "layer-del": "Delete layer", "layer-up": "Move layer up", "layer-down": "Move layer down", "layer-move": "Reorder layer (drag)", "layer-dupe": "Duplicate layer", "layer-merge": "Merge layer down", "layer-visible": "Layer visibility", "layer-solo": "Solo layer", "layer-ref-edit": "Reference layer edit (synced to source)", "layer-lock": "Lock layer", "layer-rename": "Rename layer", "layer-opacity": "Layer opacity", "layer-blend": "Layer blend mode", "frame-add": "New frame", "frame-del": "Delete frame", "frame-move": "Move frame", "frame-switch": "Switch frame", "frame-dupe": "Duplicate frame", "frame-duration": "Frame duration", "tag-add": "New animation tag", "tag-rename": "Rename animation tag", "tag-range": "Change tag range", "tag-color": "Tag colour", "tag-del": "Delete animation tag", "palette-set": "Replace palette", "palette-add": "Add color", "palette-remove": "Remove color", "import-layer": "Import as layer", "wand": "Magic wand select", "sel.grow": "Grow selection", "sel.shrink": "Shrink selection", "sel.invert": "Invert selection", "sel.lasso": "Lasso select", "sel.move": "Move selection", "sel.rotate": "Rotate selection", "sel.scale": "Scale selection", "adjust-color": "Adjust color", "palette-recolor": "Recolor palette (sprite)", "outline-fill": "Outline fill", "fx-outline": "Outline", "fx-outline1": "Outline 1px", "fx-blur": "Blur", "fx-shadow": "Drop shadow", "fx-glow": "Outer glow", "fx-invert": "Invert", "fx-gray": "Grayscale", "fx-center": "Center" };
export function histName(label: string, t: ReturnType<typeof makeT>, lang: string): string {
  const m = lang === "zh" ? H_ZH : H_EN;
  if (m[label]) return m[label];
  const tr = t(label);
  return tr === label ? label : tr;
}
/**
 * Ctrl+F1 cheat sheet: every keyboard chord the app handles plus the mouse
 * vocabulary (the touch-only gestures are listed on the mobile side, where the
 * sheet also opens from the main menu). Content lives in app/shortcuts.ts.
 */
/**
 * Shortcut cheat sheet + rebinding: every rebindable row has an edit button —
 * click it (or the chord) and press the new combination. Esc cancels,
 * Backspace/Delete restores the default, a chord already used by another action
 * is refused with a note. Overrides live in `prefs.keymap`.
 */
export function ShortcutHelpModal({ t, onClose }: { t: ReturnType<typeof makeT>; onClose: () => void }) {
  const en = SESSION.prefs.lang === "en";
  const pc = useKitPcMode();
  const [pick, setPick] = useState(0);
  const [capture, setCapture] = useState<string | null>(null);
  const [, bump] = useState(0);
  const groups = SHORTCUT_SHEET;
  const g = groups[Math.min(pick, groups.length - 1)];
  const keymap = SESSION.prefs.keymap;
  const anyOverride = overrides(keymap).length > 0;

  // 捕获新按键：Esc 取消、Backspace/Delete 恢复默认，其余组合键保存
  useEffect(() => {
    if (!capture) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") { setCapture(null); return; }
      if (e.key === "Backspace" || e.key === "Delete") {
        SESSION.resetKey(capture);
        setCapture(null);
        bump((n) => n + 1);
        return;
      }
      const chord = chordOf({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey });
      if (!chord) return;                     // modifier only: keep waiting
      const clash = SESSION.bindKey(capture, chord);
      if (clash) {
        bridge.toast(t("scClash") + " " + keyActionLabel(clash, en));
        return;                               // stay in capture mode
      }
      setCapture(null);
      bump((n) => n + 1);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capture, en]);

  /** 面板里显示某动作当前生效的组合键 */
  const labelOf = (action: string): string => {
    const chord = chordForAction(action, keymap);
    return chord ? chordLabel(chord) : "";
  };
  const overridden = (action: string): boolean => isOverridden(action, keymap);
  const canRebind = (it: { action?: string }): boolean => !!it.action && REBINDABLE.indexOf(it.action) >= 0;

  const row = (it: typeof g.items[number], k: string) => {
    const rebindable = canRebind(it);
    const action = it.action ?? "";
    const capturing = capture === action;
    return (
      <div key={k} className={"sc-row" + (capturing ? " capturing" : "")}>
        {rebindable ? (
          <button className={"sc-keys sc-keybtn" + (capturing ? " capturing" : "") + (overridden(action) ? " custom" : "")}
            data-guide={"sc-key-" + action}
            title={capturing ? t("scPressKey") : t("scRebind")}
            onClick={() => setCapture(capturing ? null : action)}>
            {capturing ? t("scPressKey") : labelOf(action)}
          </button>
        ) : (
          <kbd className="sc-keys">{it.keys}</kbd>
        )}
        <span className="sc-desc">{en ? it.en : it.zh}</span>
        {rebindable && overridden(action) && (
          <button className="sc-reset" title={t("scResetOne")} onClick={() => { SESSION.resetKey(action); bump((n) => n + 1); }}>
            <Icon id="i-undo" size={14} />
          </button>
        )}
      </div>
    );
  };
  const list = (
    <>
      {pc
        ? g.items.map((it, i) => row(it, "pc" + i))
        : groups.map((grp) => (
          <div key={grp.en} className="sc-group">
            <div className="sc-gtitle">{en ? grp.en : grp.zh}</div>
            {grp.items.map((it, i) => row(it, grp.en + i))}
          </div>
        ))}
    </>
  );
  return (
    <Dialog title={t("shortcutHelp")} onClose={onClose} className={"sc-dlg" + (pc ? " sc-dlg-pc" : "")} bodyClass="sc-body"
      extra={<div className="row-note">{t("shortcutHelpHint")}</div>}
      footer={
        <>
          {anyOverride && <Btn label={t("scResetAll")} onClick={() => { SESSION.resetAllKeys(); bump((n) => n + 1); }} />}
          <Btn label={t("close")} onClick={onClose} />
        </>
      }>
      {pc ? (
        <div className="sc-split">
          <div className="sc-cats">
            {groups.map((grp, i) => (
              <button key={grp.en} className={"sc-cat" + (i === pick ? " on" : "")} onClick={() => setPick(i)}>{en ? grp.en : grp.zh}</button>
            ))}
          </div>
          <div className="sc-pane">{list}</div>
        </div>
      ) : (
        <div className="sc-flat">{list}</div>
      )}
    </Dialog>
  );
}

/** 冲突提示里显示的动作名 */
function keyActionLabel(action: string, en: boolean): string {
  if (action === "pieLaunch") return en ? "quick pie" : "快捷圆盘";
  for (const g of SHORTCUT_SHEET) {
    for (const it of g.items) if (it.action === action) return en ? it.en : it.zh;
  }
  return action;
}

/**
 * 界面定制。
 *
 * 结构重做过：左边是「哪里」（布局 / 顶栏 / 底栏 / 五个浮动球 / 未使用），
 * 右边是那一处的**小方块清单** —— 一眼看清这块地方有什么、什么被藏起来了。
 * 点方块＝显示/隐藏；顺序请打开「编辑界面」后直接在界面上拖动。
 * 被藏起来的一切都收在「未使用」里，点一下就能放回原位，不会丢。
 */
export function CustomiseModal({ t, onClose }: { t: ReturnType<typeof makeT>; onClose: () => void }) {
  const en = SESSION.prefs.lang === "en";
  const pc = useKitPcMode();
  const [where, setWhere] = useState<string>("layout");
  const [, bump] = useState(0);
  const redraw = () => bump((n) => n + 1);

  const layoutText: Record<string, { label: string; hint: string }> = {
    top: { label: t("cuTopBar"), hint: en ? "Menu, undo, redo, save, timeline, fullscreen" : "菜单 / 撤销 / 保存 / 时间轴等" },
    bar: { label: t("cuBottomBar"), hint: en ? "Colour pair, brush size and the tool sliders" : "颜色对、笔刷大小与随工具的滑杆" },
    timeline: { label: t("timelineShow"), hint: en ? "Frame and layer matrix" : "帧与图层矩阵" },
    dock: { label: t("cuDock"), hint: pc
      ? (en ? "Storage area and the equip slot" : "停靠区与快捷圆盘装备槽")
      : (en ? "Where docked floating balls live" : "浮动球的停靠存储区") },
    orbs: { label: t("cuTabOrbs"), hint: en ? "The five floating balls" : "五个浮动球本身" },
    titles: { label: t("cuTitles"), hint: en ? "Title bar above each canvas" : "每张画布上方的标题条" },
  };

  /** 一个小方块：图标 + 名字；藏起来时变暗并显示 ⊕（点它放回来） */
  const tile = (key: string, icon: string, label: string, hidden: boolean, onToggle: () => void, extra?: string) => (
    <button key={key} className={"cu-tile" + (hidden ? " off" : "")} onClick={onToggle} title={hidden ? t("cuShow") : t("cuHide")}>
      <span className="cu-tile-icon"><Icon id={icon || "i-more"} size={18} /></span>
      <span className="cu-tile-label">{label}</span>
      {extra ? <span className="cu-tile-extra">{extra}</span> : null}
      <span className="cu-tile-eye"><Icon id={hidden ? "i-plus" : "i-eye"} size={11} /></span>
    </button>
  );

  const barTiles = (all: typeof TOPBAR_ACTIONS, section: string) => {
    const order = fullOrder(all, SESSION.prefs.barOrder);
    const items = order.map((id) => all.find((a) => a.id === id)).filter((a): a is typeof all[number] => !!a);
    return (
      <div className="cu-tiles">
        {items.map((a) => tile(a.id, a.icon, t(a.label), SESSION.isBarHidden(a.id),
          () => { if (!SESSION.toggleBarAction(all, a.id)) bridge.toast(t("cuKeepOne")); redraw(); }))}
        {SESSION.barExtras(section).map((id) => {
          const a = SESSION.actionById(id);
          if (!a) return null;
          return tile("x" + id, a.icon, a.label, false, () => { SESSION.removeBarExtra(section, id); redraw(); }, t("cuFromOrbShort"));
        })}
      </div>
    );
  };

  const orbTiles = (ball: string) => {
    if (ball === "pal") return <div className="row-note">{t("cuPalNote")}</div>;
    const all = pieAllItems(ball);
    const order = fullOrder(all, SESSION.orbPref(ball).order);
    const items = order.map((id) => all.find((a) => a.id === id)).filter((a): a is typeof all[number] => !!a);
    return (
      <div className="cu-tiles">
        {items.map((a) => tile(ball + a.id, "", a.label, SESSION.isOrbItemHidden(ball, a.id),
          () => { if (!SESSION.toggleOrbItem(all, ball, a.id)) bridge.toast(t("cuKeepOne")); redraw(); }))}
        {SESSION.orbExtras(ball).map((id) => {
          const a = SESSION.actionById(id);
          if (!a) return null;
          return tile("x" + id, a.icon, a.label, false, () => { SESSION.removeOrbExtra(ball, id); redraw(); }, t("cuFromBarShort"));
        })}
      </div>
    );
  };

  const unusedTiles = () => {
    const rows: Array<{ key: string; icon: string; label: string; back: () => void; from: string }> = [];
    for (const a of TOPBAR_ACTIONS) {
      if (SESSION.isBarHidden(a.id)) rows.push({ key: "t" + a.id, icon: a.icon, label: t(a.label), from: t("cuTopBar"), back: () => SESSION.toggleBarAction(TOPBAR_ACTIONS, a.id) });
    }
    for (const a of CBAR_ACTIONS) {
      if (SESSION.isBarHidden(a.id)) rows.push({ key: "b" + a.id, icon: a.icon, label: t(a.label), from: t("cuBottomBar"), back: () => SESSION.toggleBarAction(CBAR_ACTIONS, a.id) });
    }
    for (const ball of ORB_IDS) {
      for (const item of SESSION.orbCatalogOf(ball)) {
        if (SESSION.isOrbItemHidden(ball, item.id)) {
          rows.push({
            key: ball + item.id, icon: SESSION.actionById(item.id)?.icon ?? "", label: item.label, from: ballLabelOf(ball, t),
            back: () => SESSION.toggleOrbItem(SESSION.orbCatalogOf(ball), ball, item.id),
          });
        }
      }
    }
    if (!rows.length) return <div className="row-note">{t("cuNoneHidden")}</div>;
    return (
      <div className="cu-tiles">
        {rows.map((r) => (
          <button key={r.key} className="cu-tile off" title={t("cuShow")}
            onClick={() => { r.back(); bridge.toast(t("cuPutBack")); redraw(); }}>
            <span className="cu-tile-icon"><Icon id={r.icon || "i-more"} size={18} /></span>
            <span className="cu-tile-label">{r.label}</span>
            <span className="cu-tile-extra">{r.from}</span>
            <span className="cu-tile-eye"><Icon id="i-plus" size={11} /></span>
          </button>
        ))}
      </div>
    );
  };

  /** 类别导航的条目：PC 与移动端共用同一份列表，只是换个呈现方式 */
  const cats: Array<{ id: string; label: string }> = [
    { id: "layout", label: t("cuTabLayout") },
    { id: "top", label: t("cuTopBar") },
    { id: "bar", label: t("cuBottomBar") },
    ...ORB_IDS.map((b) => ({ id: "orb:" + b, label: ballLabelOf(b, t) })),
    { id: "unused", label: t("cuUnused") },
  ];
  const section = where.startsWith("orb:") ? where.slice(4) : "";
  const title = where === "layout" ? t("cuTabLayout")
    : where === "top" ? t("cuTopBar")
      : where === "bar" ? t("cuBottomBar")
        : where === "unused" ? t("cuUnused") : ballLabelOf(section, t);

  return (
    <Dialog title={t("customise")} onClose={onClose} className="cu-dlg" bodyClass="cu-body"
      extra={<div className="cu-entry">
        <span className="row-note cu-hintline">{t("cuHint")}</span>
        <Btn label={t("uiEditStart")} icon="i-grid" className="primary"
          onClick={() => { SESSION.setUiEdit(true); onClose(); }} />
      </div>}
      footer={<>
        <Btn label={t("cuResetAll")} onClick={() => { SESSION.resetAllUi(); redraw(); }} />
        <Btn label={t("close")} onClick={onClose} className="primary" />
      </>}>
      <div className={pc ? "cu-split" : "cu-flat"}>
        {/* 类别导航：PC＝左侧竖列（和设置面板同一套 .set-cat 外观），
            移动端＝项目通用的 chip 行（kit 的 ChipGroup，同调色板包 / 符号面板） */}
        {pc ? (
          <div className="cu-cats">
            {cats.map((c) => (
              <button key={c.id} type="button" className={"cu-cat" + (where === c.id ? " on" : "")}
                onClick={() => setWhere(c.id)}>{c.label}</button>
            ))}
          </div>
        ) : (
          <ChipGroup value={where} onChange={setWhere} options={cats} />
        )}
        <div className="cu-pane">
          <div className="cu-head">
            <span className="cu-head-title">{title}</span>
            <span className="cu-head-hint">{t(where === "layout" ? "cuLayoutHint" : where === "unused" ? "cuUnusedHint" : "cuOrderHint")}</span>
          </div>
          {where === "layout" && LAYOUT_KEYS.map((k) => (
            <div className="cu-line" key={k}>
              <div className="cu-line-main">
                <span className="cu-name">{layoutText[k].label}</span>
                <span className="cu-hint">{layoutText[k].hint}</span>
              </div>
              <RowActions><Switch checked={SESSION.layoutOn(k)} label={layoutText[k].label}
                onChange={(v) => { SESSION.setLayout(k, v); redraw(); }} /></RowActions>
            </div>
          ))}
          {where === "top" && barTiles(TOPBAR_ACTIONS, "top")}
          {where === "bar" && barTiles(CBAR_ACTIONS, "bar")}
          {section && orbTiles(section)}
          {where === "unused" && unusedTiles()}
          <div className="cu-actions">
            {where === "layout" && <>
              <Btn label={t("cuResetPos")} className="mini" onClick={() => { SESSION.setDockPos(null); SESSION.setPieSlotPos(null); bridge.toast(t("cuPosReset")); redraw(); }} />
              <Btn label={t("cuResetSection")} className="mini" onClick={() => { SESSION.resetLayout(); redraw(); }} />
            </>}
            {where === "top" && <Btn label={t("cuResetSection")} className="mini" onClick={() => { SESSION.resetBar(TOPBAR_ACTIONS); redraw(); }} />}
            {where === "bar" && <Btn label={t("cuResetSection")} className="mini" onClick={() => { SESSION.resetBar(CBAR_ACTIONS); redraw(); }} />}
            {section && <Btn label={t("cuResetSection")} className="mini" onClick={() => { SESSION.resetOrb(section); redraw(); }} />}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

/** 某个球的全部条目（含被隐藏的）：由 App 注册进 Session，面板据此列清单 */
function pieAllItems(ball: string): Array<{ id: string; label: string }> {
  return SESSION.orbCatalogOf(ball);
}
/** 球的显示名 */
function ballLabelOf(ball: string, t: ReturnType<typeof makeT>): string {
  return ball === "main" ? t("menu") : ball === "sel" ? t("sel.active") : ball === "pal" ? t("palette") : ball === "fx" ? t("fxOrb") : t("canvasOrb");
}

export function HistoryModal({ t, snap, onClose, onReplay }: { t: ReturnType<typeof makeT>; snap: Snapshot; onClose: () => void; onReplay: () => void }) {
  const { labels, index } = SESSION.history.list();
  const rows = [{ key: 0, label: t("historyStart") } as { key: number; label: string }].concat(labels.map((lb, i) => ({ key: i + 1, label: histName(lb, t, snap.lang) })));
  return (
    <>
      <Dialog title={t("historyTitle")} onClose={onClose} bodyClass="hist-body" top={SESSION.prefs.histMode === "full"
          ? <div className="hist-mode-note full">{t("histNoteFull")}</div>
          : <div className="hist-mode-note">{t("histNoteStepsA")} {SESSION.history.limit()} {t("histNoteStepsB")}</div>} extra={labels.length > 0 && (
          <div className="repl-line"><Btn icon="i-play" label={t("replay")} className="repl-play" onClick={onReplay} noTip /><span>{t("replayHint")}</span></div>
        )} footer={<><Btn label={t("close")} onClick={onClose} /></>}>
        {labels.length === 0 ? <div className="row-note">{t("historyEmpty")}</div> : rows.map((r) => (<button key={r.key} className={"hist-row" + (index === r.key ? " cur" : "")} onClick={() => SESSION.jumpHistory(r.key)}><span className="hnum">{r.key === 0 ? "▸" : r.key}</span><span className="htext">{r.label}</span></button>))}
      </Dialog>
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
      <Dialog title={t("canvasRefPick")} onClose={onClose} className="dlg-frame-preview dlg-canvasref" bodyClass="fp-grid" guide="dlg-canvasref" top={<><div className="ref-mode">
          {(["layers", "flat"] as const).map((m) => (
            <button key={m} className={"ref-mode-btn" + (mode === m ? " on" : "")} onClick={() => setMode(m)}>
              <b>{t(m === "layers" ? "canvasRefModeLayers" : "canvasRefModeFlat")}</b>
              <span>{t(m === "layers" ? "canvasRefModeLayersDesc" : "canvasRefModeFlatDesc")}</span>
            </button>
          ))}
        </div></>} footer={<><Btn label={t("close")} onClick={onClose} /></>}>
        {list.length === 0 ? <div className="row-note">{t("canvasRefNone")}</div> : list.map(({ e, i }) => (
          <button key={e.id} className="fp-cell col" style={{ width: 178, height: 190 }}
            title={e.doc.name + " · " + e.doc.w + "\u00d7" + e.doc.h + " · " + e.doc.layers.length + t("canvasRefLayerCount")}
            onClick={() => { if (SESSION.referenceCanvas(i, { mode })) onClose(); }}>
            <FrameThumb doc={e.doc} fi={e.fi} sz={124} />
            <span className="fp-name">{e.doc.name || "untitled"}</span>
            <span className="fp-meta">{e.doc.w + "\u00d7" + e.doc.h + " · " + e.doc.layers.length + t("canvasRefLayerCount")}</span>
          </button>
        ))}
      </Dialog>
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
      <Dialog title={t("framePreview")} onClose={onClose} className="dlg-frame-preview" bodyClass="fp-grid" bodyStyle={{ touchAction: "pan-y" }}
        bodyProps={{
          onPointerDown: (e) => {
            pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pts.current.size === 2) pinch.current = { d0: dist(), c0: cell };
          },
          onPointerMove: (e) => {
            if (!pts.current.has(e.pointerId)) return;
            pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
            const p = pinch.current;
            if (!p || pts.current.size < 2) return;
            e.preventDefault();
            setCellSize(p.c0 * (dist() / p.d0));
          },
          onPointerUp: (e) => { pts.current.delete(e.pointerId); if (pts.current.size < 2) pinch.current = null; },
          onPointerCancel: (e) => { pts.current.delete(e.pointerId); if (pts.current.size < 2) pinch.current = null; },
        }} footer={<>{cell !== DEF && <Btn label={t("resetLabel")} onClick={() => setCellSize(DEF)} />} <Btn label={t("close")} onClick={onClose} /></>}>
        {frames.length === 0 ? <div className="row-note">{t("historyEmpty")}</div> : frames.map((f, i) => (
          <button key={f.id} className={"fp-cell" + (i === snap.frameIdx ? " on" : "")}
            style={{ width: cell, height: cell }} onClick={() => { SESSION.setFrame(i); onClose(); }}>
            <FrameThumb doc={doc} fi={i} sz={thumb} />
          </button>
        ))}
      </Dialog>
    </>
  );
}
