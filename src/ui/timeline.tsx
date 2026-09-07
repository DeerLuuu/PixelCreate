import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SESSION } from "./singleton";
import { makeT } from "./i18n";
import type { Snapshot } from "../app/session";
import { Btn, Icon, useLandscape } from "./base";
import { HoldAdjust } from "./hold";
import { BLEND_MODES } from "../engine/types";
export function TimelineBar({ t, snap, onFrameDlg }: { t: ReturnType<typeof makeT>; snap: Snapshot; onFrameDlg: (fi: number) => void }) {
  const HEAD = 20, ROW = 24, CELL = 30, LEFT = 96;
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

  // drag a frame NUMBER cell to reorder frames (long-press then drag)
  const [dl, setDl] = useState<{ from: number; to: number; dx: number } | null>(null);
  const gRef = useRef<{ from: number; x: number; y: number; armed: boolean; moved: boolean; dead: boolean; captured?: boolean } | null>(null);
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
    gRef.current = { from: fi, x: e.clientX, y: e.clientY, armed: false, moved: false, dead: false, captured: false };
    tmRef.current = window.setTimeout(() => {
      tmRef.current = null;
      const g = gRef.current;
      if (!g || g.dead) return;
      SESSION.setFrame(g.from);
      g.armed = true;
      setDl({ from: g.from, to: g.from, dx: 0 });
    }, 300);
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
      if (!g.moved) { setDl(null); onFrameDlg(g.from); return; }
      const to = numDropAt(e, g.from);
      setDl(null);
      SESSION.frameMoveTo(g.from, to);
      return;
    }
    setDl(null);
    SESSION.setFrame(fi);
  };

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

  const curLi = snap.layerIdx;
  const curL = layers[curLi];
  const [blendOpen, setBlendOpen] = useState(false);
  // renaming happens in its own dialog, only reachable for the selected layer
  const [ren, setRen] = useState(false);
  const [renName, setRenName] = useState("");
  const commitRen = () => {
    const v = renName.trim();
    if (curL && v && v !== curL.name) SESSION.renameLayer(curLi, v);
    setRen(false);
  };

  const dropBox = (() => {
    if (!dl || dl.to === dl.from) return -1;
    return dl.to < dl.from ? dl.to : (dl.to + 1 < frames.length ? dl.to + 1 : -1);
  })();
  const dragFrom = dl ? dl.from : -1;

  const cols = frames.length + 1;
  const rowsN = layers.length + 1;
  const gtc = LEFT + "px" + Array.from({ length: frames.length }, () => " " + CELL + "px").join("");
  // landscape: enlarge every layer row so the matrix fills the footer height
  let rowPx = ROW;
  if (land && availH > 0 && layers.length > 0) {
    const required = HEAD + layers.length * (ROW + 1); // +1px gaps between row tracks
    const grow = availH > required ? Math.floor((availH - required) / layers.length) : 0;
    rowPx = ROW + Math.min(64, Math.max(0, grow));
  }
  const gtr = HEAD + "px" + Array.from({ length: layers.length }, () => " " + rowPx + "px").join("");

  return (
    <footer className="tline ase-tlbar">
      <div className="ase-main">
      <div className="tlctrl">
        <Btn icon="i-prev" onClick={() => SESSION.setFrame(snap.frameIdx - 1)} title={t("framePrev")} />
        <Btn icon={snap.playing ? "i-pause" : "i-play"} onClick={() => SESSION.togglePlay()} title={t(snap.playing ? "pause" : "play")} />
        <Btn icon="i-loop" onClick={() => SESSION.toggleLoop()} active={snap.loop} title={t("loop")} />
        <Btn icon="i-next" onClick={() => SESSION.setFrame(snap.frameIdx + 1)} title={t("frameNext")} />
        <Btn icon="i-plus" onClick={() => SESSION.frameAdd()} title={t("frameAdd")} />
        <Btn icon="i-dupe" onClick={() => SESSION.frameDuplicate()} title={t("frameDupe")} />
        <Btn icon="i-minus" onClick={() => SESSION.frameDelete()} title={t("frameDel")} />
        <Btn icon="i-onion" onClick={() => SESSION.cycleOnion()} active={snap.onion > 0} title={t("onion")} />

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
              className={"ase-cell ase-numcell" + (fi === snap.frameIdx ? " on" : "") + (isDrag ? " dragging" : "") + (isDrop ? " drop" : "")}
              style={{ gridColumn: fi + 2, gridRow: 1, transform: isDrag && dl ? "translateX(" + dl.dx + "px) translateY(-2px)" : undefined }}
              onPointerDown={numDown(fi)} onPointerMove={numMove(fi)} onPointerUp={numUp(fi)} onPointerCancel={reset}>
              <span>{fi + 1}</span>
            </div>
          );
        })}
        {/* layer rows */}
        {layers.map((L, li) => (
          <div key={"lh" + L.id} className={"ase-cell ase-lcell" + (li === snap.layerIdx ? " on" : "")} style={{ gridColumn: 1, gridRow: li + 2 }} onClick={() => SESSION.setLayer(li)}>
            <button className="mini eye" title={L.visible ? t("layerHide") : t("layerShow")} onClick={(e) => { e.stopPropagation(); SESSION.toggleLayerVisible(li); }}>
              <Icon id={L.visible ? "i-eye" : "i-eyeoff"} size={12} />
            </button>
            <button className="mini lock" title={L.locked ? t("lock") : t("unlock")} onClick={(e) => { e.stopPropagation(); SESSION.toggleLayerLock(li); }}>
              <Icon id={L.locked ? "i-lock" : "i-unlock"} size={12} />
            </button>
            <button className="lname" title={L.name} onClick={(e) => { e.stopPropagation(); SESSION.setLayer(li); }}>{L.name}</button>

          </div>
        ))}
        {/* cel cells */}
        {layers.map((L, li) =>
          frames.map((f, fi) => {
            const active = li === snap.layerIdx && fi === snap.frameIdx;
            const dot = celDot(li, fi);
            return (
              <button key={"c" + L.id + ":" + f.id}
                className={"ase-cell ase-cel" + (active ? " on" : "")}
                style={{ gridColumn: fi + 2, gridRow: li + 2, gridTemplateColumns: "none" }}
                onClick={() => { if (Date.now() - panT.current < 260) return; SESSION.setLayer(li); SESSION.setFrame(fi); }}>
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
            <Btn icon="i-pencil" className="mini" title={t("layerRename")} onClick={() => { setRenName(curL.name); setRen(true); }} />
            <Btn icon="i-plus" className="mini primary" title={t("layerAdd")} onClick={() => SESSION.layerAdd()} />
            <Btn icon="i-up" className="mini" title={t("layerUp")} onClick={() => SESSION.layerUp()} />
            <Btn icon="i-down" className="mini" title={t("layerDown")} onClick={() => SESSION.layerDown()} />
            <Btn icon="i-dupe" className="mini" title={t("layerDupe")} onClick={() => SESSION.layerDuplicate()} />
            <Btn icon="i-merge" className="mini" title={t("layerMerge")} onClick={() => SESSION.layerMergeDown()} />
            <Btn icon="i-trash" className="mini danger" title={t("layerDel")} onClick={() => SESSION.layerDelete()} />
          </div>
        </div>
      )}
      {curL && blendOpen && createPortal(
        <>
          <div className="dlg-mask" onClick={() => setBlendOpen(false)} />
          <div className="dlg blend-dlg">
            <div className="dlg-head"><span>{t("blendTitle")}</span><div className="grow" /><button className="btn small" onClick={() => setBlendOpen(false)}><Icon id="i-x" size={16} /></button></div>
            <div className="dlg-body">
              {BLEND_MODES.map((b) => (
                <button key={b} type="button" className={"blend-item" + (b === curL.blend ? " on" : "")}
                  onClick={() => { SESSION.setLayerBlend(curLi, b as never); setBlendOpen(false); }}>
                  {t("blends." + b)}
                </button>
              ))}
            </div>
          </div>
        </>, document.body)}
      {ren && curL && createPortal(
        <>
          <div className="dlg-mask" onClick={() => setRen(false)} />
          <div className="dlg dlg-top">
            <div className="dlg-head"><span>{t("layerRename")}</span><div className="grow" /><button className="btn small" onClick={() => setRen(false)}><Icon id="i-x" size={16} /></button></div>
            <div className="dlg-body">
              <label className="rowlabel">{t("name")}</label>
              <input autoFocus value={renName} onChange={(e) => setRenName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") commitRen(); else if (e.key === "Escape") setRen(false); }} />
            </div>
            <div className="dlg-foot">
              <Btn label={t("cancel")} onClick={() => setRen(false)} />
              <Btn label={t("ok")} className="primary" onClick={commitRen} />
            </div>
          </div>
        </>, document.body)}
    </footer>
  );
}
