import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SESSION } from "./singleton";
import { isPc } from "../io/pcmode";
import { makeT } from "./i18n";
import type { Snapshot } from "../app/session";
import { Btn, Icon, useLandscape } from "./base";
import { HoldAdjust } from "./hold";
import { BLEND_MODES } from "../engine/types";
import { tagRangeLabel } from "../engine/tags";
import * as bridge from "../io/bridge";
import { Dialog, Row } from "./kit";
export function TimelineBar({ t, snap, onFrameDlg, onTagDlg }: { t: ReturnType<typeof makeT>; snap: Snapshot; onFrameDlg: (fi: number | "batch") => void; onTagDlg: (id: string) => void }) {
  const HEAD = 20, ROW = 24, CELL = 30, LEFT = 96;
  /** animation tags add one thin row between the frame numbers and the layers */
  const TAGH = 15;
  const land = useLandscape();
  // landscape: measure matrix height so rows can grow to fill the footer
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [availH, setAvailH] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const upd = () => setAvailH(Math.max(0, el.clientHeight - 2));
    upd();
    const ro = new ResizeObserver(upd);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const frames = SESSION.doc.frames;
  const layers = SESSION.doc.layers;
  const doc = SESSION.doc;
  // tag bar: drawn only when the document has tags, so the usual layout keeps
  // its old height; rows below it shift by one track
  const tags = snap.tags;
  const tagRow = tags.length > 0;
  const rowOff = tagRow ? 3 : 2;

  // drag a frame NUMBER cell to reorder frames (long-press then drag)
  const [dl, setDl] = useState<{ from: number; to: number; dx: number } | null>(null);
  const gRef = useRef<{ from: number; x: number; y: number; armed: boolean; moved: boolean; dead: boolean; captured?: boolean; pc?: boolean } | null>(null);
  const tmRef = useRef<number | null>(null);
  const clearTm = () => { if (tmRef.current !== null) { window.clearTimeout(tmRef.current); tmRef.current = null; } };
  const reset = () => { clearTm(); gRef.current = null; setDl(null); };
  const numDropAt = (e: React.PointerEvent, from: number): number => {
    const els = Array.from(document.querySelectorAll(".ase-numcell")) as HTMLElement[];
    let c = 0;
    for (let i = 0; i < els.length; i++) {
      if (i === from) continue;
      const r = els[i].getBoundingClientRect();
      if (r.left + r.width / 2 < e.clientX) c++;
    }
    return Math.max(0, Math.min(frames.length - 1, c));
  };
  const numDown = (fi: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    // never capture/preventDefault before the long-press arms, so a plain swipe
    // scrolls the matrix instead of dragging frames
    clearTm();
    // ⑩ 电脑模式：鼠标按下即可拖动排序，不再等 300ms 长按
    const pcMouse = isPc() && e.pointerType === "mouse";
    gRef.current = { from: fi, x: e.clientX, y: e.clientY, armed: pcMouse, moved: false, dead: false, captured: false, pc: pcMouse };
    if (pcMouse) return;
    tmRef.current = window.setTimeout(() => {
      tmRef.current = null;
      const g = gRef.current;
      if (!g || g.dead) return;
      SESSION.setFrame(g.from);
      g.armed = true;
      setDl({ from: g.from, to: g.from, dx: 0 });
      SESSION.hapticTick("时间轴", 0.8);
    }, SESSION.prefs.longPressMs);
  };
  const numMove = (fi: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gRef.current;
    if (!g || g.dead || fi !== g.from) return;
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (!g.armed) {
      // moved before the hold finished: this is a scroll, cancel the pending press
      if (Math.hypot(dx, dy) > 10) { clearTm(); g.dead = true; gRef.current = null; }
      return;
    }
    // armed: take over the pointer and stop the matrix from scrolling
    if (!g.captured) {
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      g.captured = true;
    }
    e.preventDefault();
    if (Math.abs(dx) + Math.abs(dy) > 3) g.moved = true;
    setDl({ from: g.from, to: numDropAt(e, g.from), dx });
  };
  const numUp = (fi: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gRef.current;
    if (!g) return;
    clearTm();
    gRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (g.dead || fi !== g.from) { setDl(null); return; }
    if (g.armed) {
      if (!g.moved) {
        setDl(null);
        // PC: a plain click just selects; touch keeps "tap = frame settings"
        if (isPc() && g.pc) { pickFrame(fi, e.shiftKey); return; }
        onFrameDlg(g.from);
        return;
      }
      const to = numDropAt(e, g.from);
      setDl(null);
      SESSION.frameMoveTo(g.from, to);
      return;
    }
    setDl(null);
    pickFrame(fi, e.shiftKey);
  };
  /** ⑰ Shift+左键＝区间选中；否则普通点选（多选模式下切换该帧） */
  const pickFrame = (fi: number, range: boolean): void => {
    SESSION.setDelTarget("frames");
    if (range) { SESSION.pickFrameRange(fi); return; }
    if (SESSION.frameSelOn) SESSION.toggleFrameSel(fi);
    else SESSION.setFrame(fi);
  };

  // drag a layer row vertically to reorder layers (long-press then drag)
  const [ldl, setLdl] = useState<{ from: number; to: number; dy: number } | null>(null);
  const lgRef = useRef<{ from: number; x: number; y: number; armed: boolean; moved: boolean; dead: boolean; captured?: boolean; pc?: boolean } | null>(null);
  const ltmRef = useRef<number | null>(null);
  const clearLtm = () => { if (ltmRef.current !== null) { window.clearTimeout(ltmRef.current); ltmRef.current = null; } };
  const resetL = () => { clearLtm(); lgRef.current = null; setLdl(null); };
  const layerDropAt = (e: React.PointerEvent, from: number): number => {
    const els = Array.from(document.querySelectorAll(".ase-lcell")) as HTMLElement[];
    let c = 0;
    for (let i = 0; i < els.length; i++) {
      if (i === from) continue;
      const r = els[i].getBoundingClientRect();
      if (r.top + r.height / 2 < e.clientY) c++;
    }
    return Math.max(0, Math.min(layers.length - 1, c));
  };
  const layDown = (li: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    // the eye / lock buttons keep their own tap behaviour
    if (el.closest(".eye") || el.closest(".lock")) return;
    clearLtm();
    const pcMouse = isPc() && e.pointerType === "mouse";
    lgRef.current = { from: li, x: e.clientX, y: e.clientY, armed: pcMouse, moved: false, dead: false, captured: false, pc: pcMouse };
    if (pcMouse) { SESSION.setDelTarget("layer"); return; }
    ltmRef.current = window.setTimeout(() => {
      ltmRef.current = null;
      const g = lgRef.current;
      if (!g || g.dead) return;
      SESSION.setLayer(g.from);
      g.armed = true;
      setLdl({ from: g.from, to: g.from, dy: 0 });
      SESSION.hapticTick("时间轴", 0.8);
    }, SESSION.prefs.longPressMs);
  };
  const layMove = (li: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    const g = lgRef.current;
    if (!g || g.dead || li !== g.from) return;
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (!g.armed) {
      // moved before the hold finished: the matrix scroll takes over
      if (Math.hypot(dx, dy) > 10) { clearLtm(); g.dead = true; lgRef.current = null; }
      return;
    }
    if (!g.captured) {
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      g.captured = true;
    }
    e.preventDefault();
    if (Math.abs(dx) + Math.abs(dy) > 3) g.moved = true;
    setLdl({ from: g.from, to: layerDropAt(e, g.from), dy });
  };
  const layUp = (li: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    const g = lgRef.current;
    if (!g) return;
    clearLtm();
    lgRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (g.dead || li !== g.from) { setLdl(null); return; }
    if (g.armed) {
      if (!g.moved) { setLdl(null); return; }
      const to = layerDropAt(e, g.from);
      setLdl(null);
      SESSION.layerMoveTo(g.from, to);
      return;
    }
    setLdl(null);
    SESSION.setLayer(li);
  };
  const layerDrop = (() => {
    if (!ldl || ldl.to === ldl.from) return -1;
    return ldl.to < ldl.from ? ldl.to : (ldl.to + 1 < layers.length ? ldl.to + 1 : -1);
  })();

  // drag directly on the cel area to pan the matrix (frame numbers & left column keep their own logic)
  const panRef = useRef<{ x: number; y: number; sl: number; st: number; moved: boolean } | null>(null);
  const panT = useRef(0);
  const matDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const tgt = e.target as HTMLElement;
    if (tgt.closest(".ase-numcell") || tgt.closest(".ase-lcell")) return;
    panRef.current = { x: e.clientX, y: e.clientY, sl: e.currentTarget.scrollLeft, st: e.currentTarget.scrollTop, moved: false };
  };
  const matMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = panRef.current;
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (!p.moved) {
      if (Math.hypot(dx, dy) < 5) return;
      p.moved = true;
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    }
    e.preventDefault();
    const el = e.currentTarget;
    el.scrollLeft = p.sl - dx;
    el.scrollTop = p.st - dy;
  };
  const matUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = panRef.current;
    panRef.current = null;
    if (p && p.moved) panT.current = Date.now();
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  // cheap per-cel content preview, cached per session revision
  const prevCache = useRef<{ rev: number; m: Map<string, string | null> }>({ rev: -1, m: new Map() });
  const rev = SESSION.getVersion();
  if (prevCache.current.rev !== rev) { prevCache.current = { rev, m: new Map() }; }
  const celDot = (li: number, fi: number): string | null => {
    const k = li + ":" + fi;
    const c = prevCache.current.m.get(k);
    if (c !== undefined) return c;
    const cel = doc.celAt(li, fi);
    let res: string | null = null;
    if (cel) {
      const d = cel.data;
      const stride = cel.w * cel.h > 65536 ? 4 : 1;
      for (let i = 0; i < d.length; i += stride * 4) {
        if (d[i + 3] > 0) { res = "rgb(" + d[i] + "," + d[i + 1] + "," + d[i + 2] + ")"; break; }
      }
    }
    prevCache.current.m.set(k, res);
    return res;
  };

  // long-press a layer's eye = solo: hide every other layer (a tap still just
  // toggles that one layer). The pending press is cancelled as soon as the
  // finger lifts, so a normal tap never waits.
  const eyeHold = useRef<{ li: number; t: number; fired: boolean } | null>(null);
  const eyeDown = (li: number) => (e: React.PointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const rec = { li, t: 0, fired: false };
    rec.t = window.setTimeout(() => { rec.fired = true; SESSION.toggleSoloLayers(li); }, SESSION.prefs.longPressMs);
    eyeHold.current = rec;
  };
  const eyeUp = (li: number) => (e: React.PointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const rec = eyeHold.current;
    if (!rec || rec.li !== li) return;
    window.clearTimeout(rec.t);
    if (!rec.fired) eyeHold.current = null;
    // after a solo long-press the trailing click must be swallowed
    else window.setTimeout(() => { if (eyeHold.current === rec) eyeHold.current = null; }, 420);
  };
  const eyeCancel = () => { const rec = eyeHold.current; if (rec) { window.clearTimeout(rec.t); eyeHold.current = null; } };
  const eyeClick = (li: number) => (e: React.MouseEvent) => {
    e.stopPropagation();
    const rec = eyeHold.current;
    eyeHold.current = null;
    if (rec && rec.fired) return;
    SESSION.toggleLayerVisible(li);
  };

  const curLi = snap.layerIdx;
  const curL = layers[curLi];
  const [blendOpen, setBlendOpen] = useState(false);
  // renaming happens in its own dialog, only reachable for the selected layer
  const [ren, setRen] = useState(false);
  const [renName, setRenName] = useState("");
  /** layer the rename dialog edits (double-click a row picks that one) */
  const [renLi, setRenLi] = useState<number | null>(null);
  const commitRen = () => {
    const v = renName.trim();
    const li = renLi ?? curLi;
    const L = layers[li];
    if (L && v && v !== L.name) SESSION.renameLayer(li, v);
    setRen(false);
    setRenLi(null);
  };

  const dropBox = (() => {
    if (!dl || dl.to === dl.from) return -1;
    return dl.to < dl.from ? dl.to : (dl.to + 1 < frames.length ? dl.to + 1 : -1);
  })();
  const dragFrom = dl ? dl.from : -1;

  const gtc = LEFT + "px" + Array.from({ length: frames.length }, () => " " + CELL + "px").join("");
  // landscape: enlarge every layer row so the matrix fills the footer height
  let rowPx = ROW;
  if (land && availH > 0 && layers.length > 0) {
    const required = HEAD + (tagRow ? TAGH + 1 : 0) + layers.length * (ROW + 1); // +1px gaps between row tracks
    const grow = availH > required ? Math.floor((availH - required) / layers.length) : 0;
    rowPx = ROW + Math.min(64, Math.max(0, grow));
  }
  // trailing 1fr track + a full-width filler cell: when the panel is taller than
  // the layer rows, the empty area below them is painted like the cells
  const gtr = (tagRow ? HEAD + "px " + TAGH + "px" : HEAD + "px")
    + Array.from({ length: layers.length }, () => " " + rowPx + "px").join("") + " 1fr";

  return (
    // prefs.tlH is the WHOLE panel height (drag handle), so the matrix below
    // flexes to fill it and dragging always changes the height in real time
    <footer className="tline ase-tlbar" style={{ height: SESSION.prefs.tlH, maxHeight: SESSION.prefs.tlH }}>
      <div className="ase-main">
      <div className="tlctrl">
        <Btn icon="i-prev" onClick={() => SESSION.setFrame(snap.frameIdx - 1)} title={t("framePrev")} />
        <Btn icon={snap.playing ? "i-pause" : "i-play"} onClick={() => SESSION.togglePlay()} title={t(snap.playing ? "pause" : "play")} />
        <Btn icon="i-loop" onClick={() => { const m = SESSION.cycleLoopMode(); bridge.toast(t("loopModes." + m)); }}
          active={snap.loopMode !== "once"} title={t("loop") + " · " + t("loopModes." + snap.loopMode)} />
        <Btn icon="i-next" onClick={() => SESSION.setFrame(snap.frameIdx + 1)} title={t("frameNext")} />
        <Btn icon="i-plus" onClick={() => SESSION.frameAdd()} title={t("frameAdd")} />
        <Btn icon="i-dupe" onClick={() => SESSION.frameDuplicate()} title={t("frameDupe")} />
        <Btn icon="i-trash" onClick={() => SESSION.frameDelete()} title={t("frameDel")} />
        <Btn icon="i-onion" onClick={() => SESSION.toggleOnion()} active={snap.onionOn} title={t("onion")} guide="btn-onion" />
        <Btn icon="i-framesel" onClick={() => SESSION.setFrameSelMode(!snap.frameSelOn)} active={snap.frameSelOn} title={t("frameSelMode")} guide="btn-framesel" />
        {/* which animation playback will stay inside (no tag = the whole timeline) */}
        {snap.activeTag && (
          <button type="button" className={"tag-chip" + (snap.playTag && snap.playing ? " playing" : "")}
            style={{ borderColor: snap.activeTag.color || undefined }}
            title={t("tagPlayHint").replace("{name}", snap.activeTag.name).replace("{range}", tagRangeLabel(snap.activeTag))}
            onClick={() => onTagDlg(snap.activeTag!.id)} data-guide="btn-tag-chip">
            <Icon id="i-tag" size={12} />{snap.activeTag.name}
          </button>
        )}
        {snap.frameSelOn && (<>
          <span className="fsel-count" title={t("frameSelHint")}>{t("frameSelTitle")} · {snap.frameSel.length}</span>
          <Btn icon="i-sel-all" onClick={() => SESSION.framesSelectAll()} title={t("frameSelAll")} active={snap.frameSel.length >= snap.frameCount} />
          <Btn icon="i-tag" onClick={() => {
            const tag = SESSION.tagAdd();
            if (!tag) { bridge.toast(t("tagNone")); return; }
            bridge.toast(t("tagAdded") + tag.name);
            onTagDlg(tag.id);          // straight into the editor to name it
          }} title={t("tagAdd")} guide="btn-framesel-tag" />
          <Btn icon="i-dupe" onClick={() => {
            const n = SESSION.framesDuplicateSelected();
            bridge.toast(n ? t("frameSelDuped") + n : t("frameSelNone"));
          }} title={t("frameSelDupe")} guide="btn-framesel-dupe" />
          <Btn icon="i-clock" onClick={() => onFrameDlg("batch")} title={t("frameSelDur")} guide="btn-framesel-dur" />
          <Btn icon="i-trash" danger onClick={() => {
            const n = SESSION.framesDeleteSelected();
            bridge.toast(n ? t("frameSelDeleted") + n : t("frameSelKeepOne"));
          }} title={t("frameSelDel")} guide="btn-framesel-del" />
          <Btn icon="i-x" onClick={() => SESSION.setFrameSelMode(false)} title={t("frameSelExit")} guide="btn-framesel-exit" />
        </>)}
      </div>
      <div ref={scrollRef} className="ase-scroll" style={{ gridTemplateColumns: gtc, gridTemplateRows: gtr, maxHeight: SESSION.prefs.tlH }}
        onPointerDown={matDown} onPointerMove={matMove} onPointerUp={matUp} onPointerCancel={matUp}>
        {/* corner */}
        <div className="ase-cell ase-corner" style={{ gridColumn: 1, gridRow: 1 }} />
        {/* frame numbers */}
        {frames.map((f, fi) => {
          const isDrag = dragFrom === fi;
          const isDrop = dropBox === fi;
          return (
            <div key={"n" + f.id}
              className={"ase-cell ase-numcell" + (fi === snap.frameIdx ? " on" : "") + (snap.frameSel.includes(fi) ? " picked" : "") + (isDrag ? " dragging" : "") + (isDrop ? " drop" : "")}
              style={{ gridColumn: fi + 2, gridRow: 1, transform: isDrag && dl ? "translateX(" + dl.dx + "px) translateY(-2px)" : undefined }}
              data-guide={"frame-" + fi}
              onPointerDown={numDown(fi)} onPointerMove={numMove(fi)} onPointerUp={numUp(fi)} onPointerCancel={reset}
              onContextMenu={(e) => { e.preventDefault(); SESSION.setDelTarget("frames"); SESSION.setFrame(fi); onFrameDlg(fi); }}>
              <span>{fi + 1}</span>
            </div>
          );
        })}
        {/* animation tags: one bar per tag, spanning its frames */}
        {tagRow && tags.map((tg) => {
          const active = !!snap.activeTag && snap.activeTag.id === tg.id;
          const playing = !!snap.playTag && snap.playTag.id === tg.id && snap.playing;
          return (
            <button key={"t" + tg.id}
              className={"ase-cell ase-tagcell" + (active ? " on" : "") + (playing ? " playing" : "")}
              style={{
                gridColumn: (tg.from + 2) + " / " + (tg.to + 3),
                gridRow: 2,
                background: tg.color || "#3ad6e8",
              }}
              title={t("tagTip").replace("{name}", tg.name).replace("{range}", tagRangeLabel(tg))}
              onClick={() => onTagDlg(tg.id)}>
              <span>{tg.name}</span>
            </button>
          );
        })}
        {/* layer rows (long-press + drag vertically to reorder) */}
        {layers.map((L, li) => {
          const isDrag = ldl !== null && ldl.from === li;
          const isDrop = layerDrop === li;
          // a reference layer shows which canvas AND which of its layers it
          // mirrors, so painting on it is never a guess
          const refTip = (i: number): string => {
            const src = SESSION.refSourceOf(i);
            const sub = SESSION.refSourceLayerOf(i);
            return t("layerRefBadge") + " · " + (src?.doc.name || "?") + (sub ? " / " + sub.name : "");
          };
          return (
            <div key={"lh" + L.id}
              className={"ase-cell ase-lcell" + (li === snap.layerIdx ? " on" : "") + (isDrag ? " dragging" : "") + (isDrop ? " drop" : "")}
              style={{ gridColumn: 1, gridRow: li + rowOff, transform: isDrag && ldl ? "translateY(" + ldl.dy + "px)" : undefined }}
              onPointerDown={layDown(li)} onPointerMove={layMove(li)} onPointerUp={layUp(li)} onPointerCancel={resetL}>
              <button className="mini" data-guide="layer-eye"
                title={(L.visible ? t("layerHide") : t("layerShow")) + " · " + t("layerSoloHint")}
                onPointerDown={eyeDown(li)} onPointerUp={eyeUp(li)} onPointerCancel={eyeCancel} onPointerLeave={eyeCancel}
                onClick={eyeClick(li)}>
                <Icon id={L.visible ? "i-eye" : "i-eyeoff"} size={12} />
              </button>
              <button className="mini lock" title={L.locked ? t("lock") : t("unlock")} onClick={(e) => { e.stopPropagation(); SESSION.toggleLayerLock(li); }}>
                <Icon id={L.locked ? "i-lock" : "i-unlock"} size={12} />
              </button>
              <button className={"lname" + (L.ref ? " ref" : "")}
                title={L.ref ? refTip(li) : L.name}
                onDoubleClick={(e) => { e.stopPropagation(); SESSION.setLayer(li); setRenLi(li); setRenName(L.name); setRen(true); }}
                onClick={(e) => { e.stopPropagation(); SESSION.setDelTarget("layer"); SESSION.setLayer(li); }}>{L.ref ? "\u26ad " : ""}{L.name}</button>
            </div>
          );
        })}
        <div className="ase-cell ase-fill" style={{ gridColumn: "1 / -1", gridRow: layers.length + rowOff }} />
        {/* cel cells */}
        {layers.map((L, li) =>
          frames.map((f, fi) => {
            const active = li === snap.layerIdx && fi === snap.frameIdx;
            const dot = celDot(li, fi);
            return (
              <button key={"c" + L.id + ":" + f.id}
                className={"ase-cell ase-cel" + (active ? " on" : "") + (snap.frameSel.includes(fi) ? " picked" : "")}
                style={{ gridColumn: fi + 2, gridRow: li + rowOff, gridTemplateColumns: "none" }}
                onClick={() => {
                  if (Date.now() - panT.current < 260) return;
                  // in pick-frames mode the whole frame column (every layer cell)
                  // toggles the frame instead of switching layer + frame
                  if (SESSION.frameSelOn) { SESSION.toggleFrameSel(fi); return; }
                  SESSION.setLayer(li);
                  SESSION.setFrame(fi);
                }}>
                {dot && <i className="dot" style={{ background: dot }} />}
              </button>
            );
          })
        )}
      </div>
      </div>
      {curL && (
        <div className="tl-edit">
          <span className="tl-name tl-ro" title={curL.name}>{curL.name}</span>
          <HoldAdjust fixedBottom dir="h" value={curL.opacity} min={0} max={100} title={t("opacity")}
            format={(v) => v + "%"} reset={100}
            onChange={(v) => SESSION.editLayerOpacity(curLi, v)}
            onEnd={() => SESSION.endLayerOpacity()} />
          <button type="button" className="tl-blend" onClick={() => setBlendOpen(!blendOpen)}>
            <span className="bname">{t("blends." + curL.blend)}</span><i className="bchev">▾</i>
          </button>
          <div className="tl-btns">
            <Btn icon="i-rename" className="mini" title={t("layerRename")} onClick={() => { setRenLi(curLi); setRenName(curL.name); setRen(true); }} />
            <Btn icon="i-plus" className="mini primary" title={t("layerAdd")} onClick={() => SESSION.layerAdd()} />
            <Btn icon="i-up" className="mini" title={t("layerUp")} onClick={() => SESSION.layerUp()} />
            <Btn icon="i-down" className="mini" title={t("layerDown")} onClick={() => SESSION.layerDown()} />
            <Btn icon="i-dupe" className="mini" title={t("layerDupe")} onClick={() => SESSION.layerDuplicate()} />
            <Btn icon="i-merge" className="mini" title={t("layerMerge")} onClick={() => SESSION.layerMergeDown()} />
            {curL.ref && <Btn icon="i-unlink" className="mini" title={t("layerUnref")} onClick={() => SESSION.unrefLayer(curLi)} />}
            {SESSION.canSplitRef(curLi) && <Btn icon="i-ref" className="mini" title={t("layerRefSplit")} onClick={() => SESSION.splitRefLayer(curLi)} />}
            <Btn icon="i-dupe" className="mini" title={t("layerExtract")} onClick={() => void SESSION.extractLayerToCanvas(curLi)} />
            <Btn icon="i-trash" className="mini danger" title={t("layerDel")} onClick={() => SESSION.layerDelete()} />
          </div>
        </div>
      )}
      {curL && blendOpen && createPortal(
        <>
          <Dialog title={t("blendTitle")} onClose={() => setBlendOpen(false)} className="blend-dlg">
            {BLEND_MODES.map((b) => (
              <button key={b} type="button" className={"blend-item" + (b === curL.blend ? " on" : "")}
                onClick={() => { SESSION.setLayerBlend(curLi, b as never); setBlendOpen(false); }}>
                {t("blends." + b)}
              </button>
            ))}
          </Dialog>
        </>, document.body)}
      {ren && (renLi === null ? curL : layers[renLi]) && createPortal(
        <>
          <Dialog title={t("layerRename")} onClose={() => setRen(false)} className="dlg-top" footer={<><Btn label={t("cancel")} onClick={() => setRen(false)} /> <Btn label={t("ok")} className="primary" onClick={commitRen} /></>}>
            <Row label={t("name")}>
              <input autoFocus value={renName} onChange={(e) => setRenName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") commitRen(); else if (e.key === "Escape") setRen(false); }} />
            </Row>
          </Dialog>
        </>, document.body)}
    </footer>
  );
}
