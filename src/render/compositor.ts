// Canvas compositor: merges layers (with blend/opacity) into one frame image.
import { Cel } from "../engine/cel";
import { Doc } from "../engine/doc";
import type { BlendMode } from "../engine/types";
import { cssColor } from "../engine/color";

const celCache = new WeakMap<Cel, HTMLCanvasElement>();

export function canvasToBlendMode(m: BlendMode): GlobalCompositeOperation {
  const map: Record<string, GlobalCompositeOperation> = {
    normal: "source-over", multiply: "multiply", screen: "screen", overlay: "overlay",
    darken: "darken", lighten: "lighten", dodge: "color-dodge", burn: "color-burn",
    hardlight: "hard-light", softlight: "soft-light", difference: "difference", exclusion: "exclusion",
  };
  return map[m] ?? "source-over";
}

export function celToCanvas(cel: Cel): HTMLCanvasElement {
  let c = celCache.get(cel);
  if (!c) {
    c = document.createElement("canvas");
    c.width = cel.w;
    c.height = cel.h;
    celCache.set(cel, c);
  }
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.putImageData(new ImageData(new Uint8ClampedArray(cel.data), cel.w, cel.h), 0, 0);
  return c;
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

export interface OnionSpec {
  /** how many frames to ghost behind (previous) and ahead (next), 0..3 each */
  before: number;
  after: number;
  /** opacity of the nearest ghost (0..1); further ghosts fade by 1/k */
  alpha: number;
  /** tint previous ghosts red / next ghosts green (off = draw them as-is) */
  tint: boolean;
}

/** Frame image including onion ghosts of neighbouring frames. Ghosts are
 *  drawn far-to-near so the closest neighbour stays the most readable. */
export function composeFrameWithOnion(doc: Doc, fi: number, onion: OnionSpec): HTMLCanvasElement {
  const out = composeFrame(doc, fi);
  const before = Math.max(0, Math.min(3, Math.round(onion.before)));
  const after = Math.max(0, Math.min(3, Math.round(onion.after)));
  if (before <= 0 && after <= 0) return out;
  const ctx = out.getContext("2d")!;
  const ghost = (f: number, k: number, prev: boolean): void => {
    const src = composeFrame(doc, f, { bgOverride: null });
    ctx.globalAlpha = Math.max(0.04, onion.alpha / k);
    ctx.drawImage(onion.tint ? tintCanvas(src, prev ? "rgba(255,70,90,0.9)" : "rgba(90,230,130,0.95)", 1) : src, 0, 0);
  };
  for (let k = before; k >= 1; k--) {
    const f = fi - k;
    if (f < 0) continue;
    ghost(f, k, true);
  }
  for (let k = after; k >= 1; k--) {
    const f = fi + k;
    if (f >= doc.frames.length) continue;
    ghost(f, k, false);
  }
  ctx.globalAlpha = 1;
  return out;
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
