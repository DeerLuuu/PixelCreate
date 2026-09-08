// Canvas compositor: merges layers (with blend/opacity) into one frame image.
import { Cel } from "../engine/cel";
import { Doc } from "../engine/doc";
import type { BlendMode, Rect } from "../engine/types";
import { clampRect } from "./rect";
import { onionGhosts } from "./onion";
import { cssColor } from "../engine/color";

interface CelEntry { canvas: HTMLCanvasElement; img: ImageData }
const celCache = new WeakMap<Cel, CelEntry>();

function celEntry(cel: Cel): CelEntry {
  let e = celCache.get(cel);
  if (!e) {
    const canvas = document.createElement("canvas");
    canvas.width = cel.w;
    canvas.height = cel.h;
    e = { canvas, img: new ImageData(new Uint8ClampedArray(cel.w * cel.h * 4), cel.w, cel.h) };
    celCache.set(cel, e);
  }
  return e;
}

export function canvasToBlendMode(m: BlendMode): GlobalCompositeOperation {
  const map: Record<string, GlobalCompositeOperation> = {
    normal: "source-over", multiply: "multiply", screen: "screen", overlay: "overlay",
    darken: "darken", lighten: "lighten", dodge: "color-dodge", burn: "color-burn",
    hardlight: "hard-light", softlight: "soft-light", difference: "difference", exclusion: "exclusion",
  };
  return map[m] ?? "source-over";
}

export function celToCanvas(cel: Cel): HTMLCanvasElement {
  const e = celEntry(cel);
  e.img.data.set(cel.data);
  e.canvas.getContext("2d")!.putImageData(e.img, 0, 0);
  return e.canvas;
}

/** Same canvas as celToCanvas, but only `rect` is uploaded: the live-stroke
 *  path changes a few hundred pixels, not the whole cel. */
export function celToCanvasRect(cel: Cel, rect: Rect): HTMLCanvasElement {
  const e = celEntry(cel);
  const r = clampRect(rect, cel.w, cel.h);
  if (r) {
    const dst = e.img.data, src = cel.data, w = cel.w;
    for (let y = r.y; y < r.y + r.h; y++) {
      const a = y * w + r.x;
      dst.set(src.subarray(a * 4, (a + r.w) * 4), a * 4);
    }
    e.canvas.getContext("2d")!.putImageData(e.img, 0, 0, r.x, r.y, r.w, r.h);
  }
  return e.canvas;
}

/** Composite layers bottom→top of a single frame into a fresh w×h canvas. */
export function composeFrame(doc: Doc, fi: number, opts: { bgOverride?: number[] | null; onlyLi?: number | null } = {}): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = doc.w;
  c.height = doc.h;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, c.width, c.height);
  const bg = opts.bgOverride !== undefined ? opts.bgOverride : doc.bg;
  if (bg) {
    ctx.fillStyle = cssColor([bg[0], bg[1], bg[2], bg[3] ?? 255]);
    ctx.fillRect(0, 0, doc.w, doc.h);
  }
  if (opts.onlyLi != null) {
    // export a single layer: exact cel pixels over the backdrop
    const cel = doc.celAt(opts.onlyLi, fi);
    if (cel) {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(celToCanvas(cel), 0, 0);
    }
    return c;
  }
  for (let li = 0; li < doc.layers.length; li++) {
    const L = doc.layers[li];
    if (!L.visible) continue;
    const cel = doc.celAt(li, fi);
    if (!cel) continue;
    ctx.globalAlpha = L.opacity / 100;
    ctx.globalCompositeOperation = canvasToBlendMode(L.blend);
    ctx.drawImage(celToCanvas(cel), 0, 0);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  return c;
}

/** Tint an existing canvas to a solid color (keeps alpha shape). */
export function tintCanvas(src: HTMLCanvasElement, tint: string, alpha: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  const x = c.getContext("2d")!;
  x.globalAlpha = alpha;
  x.drawImage(src, 0, 0);
  x.globalCompositeOperation = "source-in";
  x.globalAlpha = 1;
  x.fillStyle = tint;
  x.fillRect(0, 0, c.width, c.height);
  return c;
}

/** reuse of the expensive parts of the onion composite between live-stroke
 *  updates: tinted ghost frames of the neighbouring frames (they cannot change
 *  while the user paints the current frame) */
export interface ComposeCache { ghosts: Map<string, HTMLCanvasElement> }
export function newComposeCache(): ComposeCache {
  return { ghosts: new Map() };
}

export interface OnionSpec {
  /** how many frames to ghost behind (previous) and ahead (next), 0..3 each */
  before: number;
  after: number;
  /** opacity of the nearest ghost (0..1); further ghosts fade by 1/k */
  alpha: number;
  /** tint previous ghosts red / next ghosts green (off = draw them as-is) */
  tint: boolean;
  /** loop the animation: ghosts wrap around the first/last frame and get a
   *  distinct colour so the wrap-around is obvious (default false) */
  wrap?: boolean;
}

/** tint colours of the onion ghosts; the wrapped first/last frames differ */
export const ONION_TINT = {
  prev: "rgba(255,70,90,0.9)",
  next: "rgba(90,230,130,0.95)",
  prevWrap: "rgba(120,150,255,0.95)",
  nextWrap: "rgba(255,190,80,0.95)",
};

function ghostTint(prev: boolean, wrapped: boolean): string {
  if (wrapped) return prev ? ONION_TINT.prevWrap : ONION_TINT.nextWrap;
  return prev ? ONION_TINT.prev : ONION_TINT.next;
}

/** Frame image including onion ghosts of neighbouring frames. Ghosts are
 *  drawn far-to-near so the closest neighbour stays the most readable. */
export function composeFrameWithOnion(doc: Doc, fi: number, onion: OnionSpec, cache?: ComposeCache): HTMLCanvasElement {
  const out = composeFrame(doc, fi);
  const before = Math.max(0, Math.min(3, Math.round(onion.before)));
  const after = Math.max(0, Math.min(3, Math.round(onion.after)));
  if (before <= 0 && after <= 0) return out;
  const ctx = out.getContext("2d")!;
  const ghost = (f: number, k: number, prev: boolean, wrapped: boolean): void => {
    const tint = ghostTint(prev, wrapped);
    const key = f + (onion.tint ? "|" + tint : "|none");
    let cv = cache?.ghosts.get(key);
    if (!cv) {
      const src = composeFrame(doc, f, { bgOverride: null });
      cv = onion.tint ? tintCanvas(src, tint, 1) : src;
      cache?.ghosts.set(key, cv);
    }
    ctx.globalAlpha = Math.max(0.04, onion.alpha / k);
    ctx.drawImage(cv, 0, 0);
  };
  for (const g of onionGhosts(fi, doc.frames.length, before, after, !!onion.wrap)) ghost(g.f, g.k, g.prev, g.wrapped);
  ctx.globalAlpha = 1;
  return out;
}

/** Re-composite only `rect` of an existing composite canvas (live strokes).
 *  Everything outside the rect is already correct, so every visible layer is
 *  redrawn clipped to the changed region with a rect-limited cel upload. */
export function composeRectInto(
  doc: Doc, fi: number, onion: OnionSpec, rect: Rect, target: HTMLCanvasElement, cache?: ComposeCache,
): void {
  const r = clampRect(rect, doc.w, doc.h);
  if (!r) return;
  const ctx = target.getContext("2d");
  if (!ctx) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  ctx.clearRect(r.x, r.y, r.w, r.h);
  if (doc.bg) {
    ctx.fillStyle = cssColor([doc.bg[0], doc.bg[1], doc.bg[2], doc.bg[3] ?? 255]);
    ctx.fillRect(r.x, r.y, r.w, r.h);
  }
  for (let li = 0; li < doc.layers.length; li++) {
    const L = doc.layers[li];
    if (!L.visible) continue;
    const cel = doc.celAt(li, fi);
    if (!cel) continue;
    ctx.globalAlpha = L.opacity / 100;
    ctx.globalCompositeOperation = canvasToBlendMode(L.blend);
    ctx.drawImage(celToCanvasRect(cel, r), 0, 0);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  const before = Math.max(0, Math.min(3, Math.round(onion.before)));
  const after = Math.max(0, Math.min(3, Math.round(onion.after)));
  const ghost = (f: number, k: number, prev: boolean, wrapped: boolean): void => {
    const tint = ghostTint(prev, wrapped);
    const key = f + (onion.tint ? "|" + tint : "|none");
    let cv = cache?.ghosts.get(key);
    if (!cv) {
      const src = composeFrame(doc, f, { bgOverride: null });
      cv = onion.tint ? tintCanvas(src, tint, 1) : src;
      cache?.ghosts.set(key, cv);
    }
    ctx.globalAlpha = Math.max(0.04, onion.alpha / k);
    ctx.drawImage(cv, 0, 0);
  };
  for (const g of onionGhosts(fi, doc.frames.length, before, after, !!onion.wrap)) ghost(g.f, g.k, g.prev, g.wrapped);
  ctx.globalAlpha = 1;
  ctx.restore();
}

/** Merge dst canvas with src canvas using src layer's opacity/blend (for mergeLayerDown). */
export function compositeOntoCel(dst: Cel, src: Cel, srcOpacity: number, blend: BlendMode): void {
  const c = document.createElement("canvas");
  c.width = dst.w; c.height = dst.h;
  const ctx = c.getContext("2d")!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(dst.data), dst.w, dst.h), 0, 0);
  ctx.globalAlpha = Math.max(0, Math.min(1, srcOpacity));
  ctx.globalCompositeOperation = canvasToBlendMode(blend);
  ctx.drawImage(celToCanvas(src), 0, 0);
  const out = ctx.getImageData(0, 0, dst.w, dst.h).data;
  dst.data.set(out);
}
