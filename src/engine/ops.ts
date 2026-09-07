// Raw structural operations on a Doc. The caller wraps these in history.
import { Cel } from "./cel";
import { Doc, type LayerMeta, type FrameMeta } from "./doc";
import { uid } from "./types";
import type { BlendMode } from "./types";

export function freshLayer(doc: Doc, name?: string): LayerMeta {
  return { id: uid(), name: name || `Layer ${doc.layers.length + 1}`, visible: true, opacity: 100, blend: "normal", locked: false };
}
export function freshFrame(durationMs = 100): FrameMeta {
  return { id: uid(), durationMs };
}

/** Reindex cels: any cel with layer index >= removedIdx shifts by delta. */
function shiftCelsByLayer(doc: Doc, fromIdx: number, delta: number): void {
  const moves: { li: number; fi: number; cel: Cel }[] = [];
  for (const [k, cel] of doc.cels) {
    const sep = k.indexOf(":");
    const li = Number(k.slice(0, sep));
    const fi = Number(k.slice(sep + 1));
    if (li >= fromIdx) moves.push({ li, fi, cel });
  }
  // two phases: delete every old key first, then write the new keys, so chain
  // remaps never delete a key that was just written
  for (const m of moves) doc.cels.delete(doc.key(m.li, m.fi));
  for (const m of moves) doc.cels.set(doc.key(m.li + delta, m.fi), m.cel);
}

function shiftCelsByFrame(doc: Doc, fromIdx: number, delta: number): void {
  const moves: { li: number; fi: number; cel: Cel }[] = [];
  for (const [k, cel] of doc.cels) {
    const sep = k.indexOf(":");
    const li = Number(k.slice(0, sep));
    const fi = Number(k.slice(sep + 1));
    if (fi >= fromIdx) moves.push({ li, fi, cel });
  }
  // two phases (see shiftCelsByLayer)
  for (const m of moves) doc.cels.delete(doc.key(m.li, m.fi));
  for (const m of moves) doc.cels.set(doc.key(m.li, m.fi + delta), m.cel);
}

export function addLayer(doc: Doc, index: number): void {
  const at = Math.max(0, Math.min(doc.layers.length, index));
  doc.layers.splice(at, 0, freshLayer(doc));
  // every layer originally at >= at shifted up by one: re-key their cels so
  // content follows the layer (mirrors addFrame below)
  shiftCelsByLayer(doc, at, +1);
}
export function duplicateLayer(doc: Doc, li: number): void {
  const src = doc.layers[li];
  if (!src) return;
  doc.layers.splice(li + 1, 0, { ...src, id: uid(), name: src.name + " copy" });
  shiftCelsByLayer(doc, li + 1, +1);
  for (let fi = 0; fi < doc.frames.length; fi++) {
    const cel = doc.celAt(li, fi);
    if (cel) doc.cels.set(doc.key(li + 1, fi), cel.clone());
  }
}
export function removeLayer(doc: Doc, li: number): void {
  if (doc.layers.length <= 1) return;
  doc.layers.splice(li, 1);
  // delete cels that belonged to the removed layer, then reindex those above
  for (const k of Array.from(doc.cels.keys())) {
    if (Number(k.slice(0, k.indexOf(":"))) === li) doc.cels.delete(k);
  }
  shiftCelsByLayer(doc, li + 1, -1);
}
export function moveLayer(doc: Doc, from: number, to: number): void {
  const n = doc.layers.length;
  if (from < 0 || from >= n) return;
  const toC = Math.max(0, Math.min(n - 1, to));
  if (toC === from) return;
  const pre = doc.layers.slice(); // keeps layer-object identity + old order
  const L = doc.layers[from];
  doc.layers.splice(from, 1);
  doc.layers.splice(toC, 0, L);
  // re-key every cel whose layer moved (tracked by layer-object identity) so
  // content follows the layer even across a multi-index jump. Two phases:
  // delete all old keys first, then write the new keys.
  const rekeys: Array<{ li: number; nf: number; fi: number; cel: Cel }> = [];
  for (const [k, cel] of Array.from(doc.cels)) {
    const sep = k.indexOf(":");
    const li = Number(k.slice(0, sep));
    const fi = Number(k.slice(sep + 1));
    const lobj = pre[li];
    if (!lobj) continue;
    const nf = doc.layers.indexOf(lobj);
    if (nf !== -1 && nf !== li) rekeys.push({ li, nf, fi, cel });
  }
  for (const r of rekeys) doc.cels.delete(doc.key(r.li, r.fi));
  for (const r of rekeys) doc.cels.set(doc.key(r.nf, r.fi), r.cel);
}

export function addFrame(doc: Doc, index: number): void {
  const at = Math.max(0, Math.min(doc.frames.length, index));
  doc.frames.splice(at, 0, freshFrame(doc.frames[Math.max(0, at - 1)]?.durationMs ?? 100));
  // frames originally at >= at shifted up by one: reindex their cels, or every
  // following frame would read the wrong cel (and the last one would go blank)
  shiftCelsByFrame(doc, at, +1);
}
export function duplicateFrame(doc: Doc, fi: number): void {
  const src = doc.frames[fi];
  if (!src) return;
  doc.frames.splice(fi + 1, 0, { id: uid(), durationMs: src.durationMs });
  shiftCelsByFrame(doc, fi + 1, +1);
  for (let li = 0; li < doc.layers.length; li++) {
    const cel = doc.celAt(li, fi);
    if (cel) doc.cels.set(doc.key(li, fi + 1), cel.clone());
  }
}
export function removeFrame(doc: Doc, fi: number): void {
  if (doc.frames.length <= 1) return;
  doc.frames.splice(fi, 1);
  for (const k of Array.from(doc.cels.keys())) {
    if (Number(k.slice(k.indexOf(":") + 1)) === fi) doc.cels.delete(k);
  }
  shiftCelsByFrame(doc, fi + 1, -1);
}
export function moveFrame(doc: Doc, from: number, to: number): void {
  const n = doc.frames.length;
  if (from < 0 || from >= n) return;
  const t = Math.max(0, Math.min(n - 1, to));
  if (t === from) return;
  const pre = doc.frames.slice(); // keeps frame-object identity + old order
  const F = doc.frames[from];
  doc.frames.splice(from, 1);
  doc.frames.splice(t, 0, F);
  // re-key every cel whose frame moved (tracked by frame-object identity).
  // Two phases: delete all old keys first, then write new keys, so chain
  // remaps (e.g. 0->1->2->0) never overwrite one another.
  const rekeys: Array<{ li: number; of: number; nf: number; cel: Cel }> = [];
  for (const [k, cel] of Array.from(doc.cels)) {
    const sep = k.indexOf(":");
    const li = Number(k.slice(0, sep));
    const fi = Number(k.slice(sep + 1));
    const fobj = pre[fi];
    if (!fobj) continue;
    const nf = doc.frames.indexOf(fobj);
    if (nf !== -1 && nf !== fi) rekeys.push({ li, of: fi, nf, cel });
  }
  for (const r of rekeys) doc.cels.delete(doc.key(r.li, r.of));
  for (const r of rekeys) doc.cels.set(doc.key(r.li, r.nf), r.cel);
}

/**
 * Merge layer `li` (non-background, above) into `li-1` across ALL frames.
 * Destination keeps its own name/opacity/blend; source layer is removed.
 */
export function mergeLayerDown(doc: Doc, li: number, blendComposite: (dst: Cel, src: Cel, srcOpacity: number, blend: BlendMode) => void): void {
  if (li <= 0 || li >= doc.layers.length) return;
  const srcL = doc.layers[li];
  for (let fi = 0; fi < doc.frames.length; fi++) {
    const dst = doc.celAt(li - 1, fi);
    const src = doc.celAt(li, fi);
    if (!src) continue;
    if (!dst) {
      doc.cels.set(doc.key(li - 1, fi), src.clone());
    } else {
      blendComposite(dst, src, srcL.opacity / 100, srcL.blend);
    }
  }
  removeLayer(doc, li);
}

/**
 * Canvas Size (Aseprite-like): change the document dimensions only.
 * The old content keeps its pixels and is placed at (ox, oy) inside the new
 * canvas (ox/oy may be negative to crop). Every cel buffer is reallocated.
 */
export function resizeDocCanvas(doc: Doc, w2: number, h2: number, ox: number, oy: number): void {
  const W = Math.max(1, Math.min(1024, Math.round(w2)));
  const H = Math.max(1, Math.min(1024, Math.round(h2)));
  if (W === doc.w && H === doc.h && ox === 0 && oy === 0) return;
  const entries = Array.from(doc.cels.entries());
  doc.cels.clear();
  for (const [k, cel] of entries) {
    const next = new Cel(W, H);
    const x0 = Math.max(0, ox);
    const y0 = Math.max(0, oy);
    const x1 = Math.min(W, ox + cel.w);
    const y1 = Math.min(H, oy + cel.h);
    if (x0 < x1 && y0 < y1) {
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const si = cel.idx(x - ox, y - oy);
          const di = next.idx(x, y);
          next.data[di] = cel.data[si];
          next.data[di + 1] = cel.data[si + 1];
          next.data[di + 2] = cel.data[si + 2];
          next.data[di + 3] = cel.data[si + 3];
        }
      }
    }
    doc.cels.set(k, next);
  }
  doc.w = W;
  doc.h = H;
  doc.sel = null;
}

/**
 * Sprite Size (Aseprite-like): scale the whole sprite (all layers x frames)
 * to the new dimensions using nearest-neighbour sampling.
 */
export function scaleDocSprite(doc: Doc, w2: number, h2: number): void {
  const W = Math.max(1, Math.min(1024, Math.round(w2)));
  const H = Math.max(1, Math.min(1024, Math.round(h2)));
  if (W === doc.w && H === doc.h) return;
  const sw = doc.w, sh = doc.h;
  const entries = Array.from(doc.cels.entries());
  doc.cels.clear();
  for (const [k, cel] of entries) {
    const next = new Cel(W, H);
    const d = next.data, s = cel.data;
    for (let y = 0; y < H; y++) {
      const sy = Math.min(sh - 1, Math.floor((y * sh) / H));
      for (let x = 0; x < W; x++) {
        const sx = Math.min(sw - 1, Math.floor((x * sw) / W));
        const si = (sy * sw + sx) * 4;
        const di = (y * W + x) * 4;
        d[di] = s[si]; d[di + 1] = s[si + 1]; d[di + 2] = s[si + 2]; d[di + 3] = s[si + 3];
      }
    }
    doc.cels.set(k, next);
  }
  doc.w = W;
  doc.h = H;
  doc.sel = null;
}



/** Union bounding box of every opaque pixel across all layers/frames, or null
 * when the document is empty. */
export function contentBounds(doc: Doc): { x: number; y: number; w: number; h: number } | null {
  const W = doc.w, H = doc.h;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (const cel of doc.cels.values()) {
    const d = cel.data;
    const w = cel.w, h = cel.h;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (d[(row + x) * 4 + 3] > 0) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
