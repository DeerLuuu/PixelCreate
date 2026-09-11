// Export helpers: PNG bytes, GIF animation, spritesheet (+JSON meta), Aseprite
import type { Doc } from "../engine/doc";
import type { RGBA } from "../engine/types";
import * as comp from "../render/compositor";
import { writeAse } from "./asewrite";

declare global {
  interface Window {
    GifWriter: new (buf: Uint8Array, w: number, h: number, opts?: unknown) => GifWriterLike;
  }
}
export interface GifWriterLike {
  addFrame(x: number, y: number, w: number, h: number, indexed: Uint8Array, opts: { delay: number; transparent?: number; disposal?: number }): void;
  end(): number;
}

export interface FrameData {
  data: Uint8ClampedArray | Uint8Array;
  delayMs: number;
}

export interface RectLike {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function sanitizeName(n: string): string {
  return n.replace(/[^\w\u4e00-\u9fa5-]+/g, "_");
}

export async function pngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array | null> {
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob((b) => res(b), "image/png"));
  if (!blob) return null;
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}

/** 单张图片 / 精灵表允许的最大像素数（16.8M ≈ 4096×4096） */
export const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;
/** GIF / 精灵表所有帧加起来允许的最大像素数 */
export const MAX_TOTAL_PIXELS = 48 * 1024 * 1024;
/** 一次「分图层导出」最多写多少个文件（超过要用户确认） */
export const MAX_LAYER_FILES = 12;

/**
 * 预算检查（纯函数）。超限时返回原因 key，调用方负责提示；返回 null 表示可以导出。
 * 以前没有这道闸：8× 放大的精灵表会去 new 一个上亿像素的 canvas，
 * 直接把标签页/手机拖到几乎无响应。
 */
export function exportBudgetError(w: number, h: number, scale: number, frames: number, kind: "image" | "anim"): string | null {
  const sc = Math.max(1, Math.round(scale || 1));
  const px = Math.max(1, w) * Math.max(1, h) * sc * sc;
  const total = px * Math.max(1, frames);
  if (px > MAX_IMAGE_PIXELS) return "tooBigImage";
  if (kind === "anim" && total > MAX_TOTAL_PIXELS) return "tooBigAnim";
  return null;
}

export interface ExportOpts {
  bg?: RGBA | null;
  scale?: number;
  li?: number | null;
  bounds?: RectLike | null;
  /** frames to export, 0-based inclusive; omitted = every frame */
  range?: [number, number] | null;
}

/** clamp an export frame range against the document (pure, unit tested) */
export function frameRange(o: ExportOpts, count: number): { from: number; to: number; n: number } {
  const last = Math.max(0, count - 1);
  let from = 0;
  let to = last;
  if (o.range) {
    from = Math.max(0, Math.min(last, Math.round(o.range[0])));
    to = Math.max(0, Math.min(last, Math.round(o.range[1])));
    if (from > to) { const t = from; from = to; to = t; }
  }
  return { from, to, n: to - from + 1 };
}

function medianCut(colors: [number, number, number][], maxColors: number): [number, number, number][] {
  const boxes: [number, number, number][][] = [colors];
  const split = (box: [number, number, number][]): [number, number, number][][] | null => {
    if (box.length < 2) return null;
    let r0 = 255, r1 = 0, g0 = 255, g1 = 0, b0 = 255, b1 = 0;
    for (const c of box) {
      if (c[0] < r0) r0 = c[0];
      if (c[0] > r1) r1 = c[0];
      if (c[1] < g0) g0 = c[1];
      if (c[1] > g1) g1 = c[1];
      if (c[2] < b0) b0 = c[2];
      if (c[2] > b1) b1 = c[2];
    }
    const rl = r1 - r0, gl = g1 - g0, bl = b1 - b0;
    const axis = rl >= gl && rl >= bl ? 0 : gl >= bl ? 1 : 2;
    box.sort((a, b) => a[axis] - b[axis]);
    const half = box.length >> 1;
    if (half === 0) return null;
    return [box.slice(0, half), box.slice(half)];
  };
  while (boxes.length < maxColors) {
    let bi = -1, blen = -1;
    for (let i = 0; i < boxes.length; i++) if (boxes[i].length > blen) { blen = boxes[i].length; bi = i; }
    if (bi < 0) break;
    const parts = split(boxes[bi]);
    if (!parts) break;
    boxes.splice(bi, 1, parts[0], parts[1]);
  }
  return boxes.map((b) => {
    let r = 0, g = 0, bb = 0;
    for (const c of b) { r += c[0]; g += c[1]; bb += c[2]; }
    const n = b.length;
    return [Math.round(r / n), Math.round(g / n), Math.round(bb / n)];
  });
}

function rawExportCanvas(doc: Doc, fi: number, o: ExportOpts = {}): HTMLCanvasElement {
  const full = comp.composeFrame(doc, fi, {
    bgOverride: o.bg ? [o.bg[0], o.bg[1], o.bg[2], o.bg[3] ?? 255] : null,
    onlyLi: o.li ?? null,
  });
  const b = o.bounds;
  let out: HTMLCanvasElement;
  if (b && b.w > 0 && b.h > 0) {
    out = document.createElement("canvas");
    out.width = b.w;
    out.height = b.h;
    const x = out.getContext("2d")!;
    x.imageSmoothingEnabled = false;
    x.drawImage(full, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
  } else {
    out = full;
  }
  const sc = o.scale || 1;
  if (sc > 1) {
    const big = document.createElement("canvas");
    big.width = out.width * sc;
    big.height = out.height * sc;
    const x = big.getContext("2d")!;
    x.imageSmoothingEnabled = false;
    x.drawImage(out, 0, 0, big.width, big.height);
    return big;
  }
  return out;
}

export function encodeGIF(frames: FrameData[], w: number, h: number, opts: { transparent?: boolean }): Uint8Array {
  if (typeof window === "undefined" || !window.GifWriter) throw new Error("gif-writer-missing");
  const useTrans = opts.transparent !== false;
  const hasTrans = useTrans && frames.some((f) => {
    const d = f.data;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 128) return true;
    return false;
  });
  const seen = new Set<number>();
  const colors: [number, number, number][] = [];
  const addC = (r: number, g: number, b: number) => {
    const k = (r << 16) | (g << 8) | b;
    if (!seen.has(k)) { seen.add(k); colors.push([r, g, b]); }
  };
  for (const f of frames) {
    const d = f.data;
    for (let i = 0; i < d.length; i += 4) {
      if (useTrans && d[i + 3] < 128) continue;
      addC(d[i], d[i + 1], d[i + 2]);
    }
  }
  const cap = hasTrans ? 255 : 256;
  const palette: [number, number, number][] = colors.length <= cap ? colors : medianCut(colors, cap);
  // 5bit 色立方查找表：先用调色板自己的格子做种子，再向邻居「洪水填充」，
  // 于是 32768 个格子**全部**都有值 —— 每个像素只做一次数组索引，
  // 再也不用为每个像素扫描整条调色板（旧实现 = 像素数 × 调色板项数）。
  const table = new Int16Array(1 << 15).fill(-1);
  const queue: number[] = [];
  for (let i = 0; i < palette.length; i++) {
    const c = palette[i];
    const ci = ((c[0] >> 3) << 10) | ((c[1] >> 3) << 5) | (c[2] >> 3);
    if (table[ci] < 0) { table[ci] = i; queue.push(ci); }
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const ci = queue[qi];
    const own = table[ci];
    const r = ci >> 10, g = (ci >> 5) & 31, b = ci & 31;
    if (r > 0) { const n = ci - 1024; if (table[n] < 0) { table[n] = own; queue.push(n); } }
    if (r < 31) { const n = ci + 1024; if (table[n] < 0) { table[n] = own; queue.push(n); } }
    if (g > 0) { const n = ci - 32; if (table[n] < 0) { table[n] = own; queue.push(n); } }
    if (g < 31) { const n = ci + 32; if (table[n] < 0) { table[n] = own; queue.push(n); } }
    if (b > 0) { const n = ci - 1; if (table[n] < 0) { table[n] = own; queue.push(n); } }
    if (b < 31) { const n = ci + 1; if (table[n] < 0) { table[n] = own; queue.push(n); } }
  }
  const mapFn = (r: number, g: number, b: number): number => {
    // 快路径：洪水填充后每个格子都有值，正常情况永远命中。
    // （以前的实现在表命中后仍然完整扫描一遍调色板：每个像素 ×256 次比较，
    //   一百万像素的 GIF 就是 2.5 亿次运算，界面直接卡死。）
    const hit = table[((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)];
    if (hit >= 0) return hit;
    let best = 0;
    let dmin = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const c = palette[i];
      const dr = c[0] - r, dg = c[1] - g, db = c[2] - b;
      const d = dr * dr + dg * dg + db * db;
      if (d < dmin) { dmin = d; best = i; }
    }
    return best;
  };
  const palInt = palette.map((c) => (c[0] << 16) | (c[1] << 8) | c[2]);
  const TI: number = hasTrans ? palette.length : 0;
  if (hasTrans) palInt.push(0);
  // omggif 要求调色板长度**必须是 2 的幂且 2..256**（check_palette_and_num_colors），
  // 而我们的调色板是「图里出现过的颜色数（+1 个透明色）」，3 / 5 / 7 个颜色
  // 都会直接抛 "Invalid code/color length"。这里补齐到下一个 2 的幂（多出来的
  // 位置填黑色，透明色下标 TI 不变，仍然有效）。
  while (palInt.length < 2 || (palInt.length & (palInt.length - 1)) !== 0) palInt.push(0);
  const perFrame = w * h * 2 + 64;
  const buf = new Uint8Array(4096 + perFrame * frames.length);
  const g = new window.GifWriter(buf, w, h, { palette: palInt, loop: 0 });
  for (const f of frames) {
    const d = f.data;
    const idx = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      if (hasTrans && d[i + 3] < 128) idx[j] = TI;
      else idx[j] = mapFn(d[i], d[i + 1], d[i + 2]);
    }
    g.addFrame(0, 0, w, h, idx, {
      delay: Math.max(1, Math.min(6553, Math.round((f.delayMs || 100) / 10))),
      transparent: hasTrans ? TI : undefined,
      disposal: 2,
    });
  }
  const len = g.end();
  return buf.subarray(0, len);
}

export async function exportPNG(doc: Doc, fi: number, o: ExportOpts = {}): Promise<{ bytes: Uint8Array; name: string } | null> {
  const bw = o.bounds && o.bounds.w > 0 ? o.bounds.w : doc.w;
  const bh = o.bounds && o.bounds.h > 0 ? o.bounds.h : doc.h;
  const budget = exportBudgetError(bw, bh, o.scale || 1, 1, "image");
  if (budget) throw new Error(budget);
  const c = rawExportCanvas(doc, fi, o);
  const bytes = await pngBytes(c);
  if (!bytes) return null;
  const suffix = o.bounds ? "_sel" : o.li != null ? "_l" + (o.li + 1) : "_f" + (fi + 1);
  return { bytes, name: sanitizeName(doc.name) + suffix + ".png" };
}

/** 让浏览器喘口气：长循环里每帧调一次，界面不会被冻住 */
export function yieldToUI(): Promise<void> {
  return new Promise((res) => setTimeout(res, 0));
}

export async function exportGIF(doc: Doc, o: ExportOpts = {}): Promise<{ bytes: Uint8Array; name: string }> {
  const r = frameRange(o, doc.frames.length);
  const sc = Math.max(1, Math.round(o.scale || 1));
  const budget = exportBudgetError(doc.w, doc.h, sc, r.n, "anim");
  if (budget) throw new Error(budget);
  const frames: FrameData[] = [];
  for (let fi = r.from; fi <= r.to; fi++) {
    const c = rawExportCanvas(doc, fi, o);
    frames.push({ data: c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data, delayMs: doc.frames[fi].durationMs });
    await yieldToUI();               // 一帧一让，界面和大列表都不会卡死
  }
  const first = rawExportCanvas(doc, r.from, o);
  const bytes = encodeGIF(frames, first.width, first.height, { transparent: o.bg == null });
  const suffix = (o.bounds ? "_sel" : o.li != null ? "_l" + (o.li + 1) : "") + (r.n < doc.frames.length ? "_f" + (r.from + 1) + "-" + (r.to + 1) : "");
  return { bytes, name: sanitizeName(doc.name) + suffix + ".gif" };
}

export async function exportSheet(doc: Doc, o: ExportOpts & { cols?: number } = {}): Promise<{ png: Uint8Array; json: Uint8Array; name: string; jsonName: string } | null> {
  const r = frameRange(o, doc.frames.length);
  const cols = Math.max(1, Math.min(r.n, o.cols || r.n));
  const rows = Math.ceil(r.n / cols);
  const sc = Math.max(1, Math.round(o.scale || 1));
  const budget = exportBudgetError(doc.w * cols, doc.h * rows, sc, 1, "image");
  if (budget) throw new Error(budget);
  const frame0 = rawExportCanvas(doc, r.from, o);
  const fw = frame0.width, fh = frame0.height;
  const c = document.createElement("canvas");
  c.width = fw * cols;
  c.height = fh * rows;
  const x = c.getContext("2d")!;
  x.imageSmoothingEnabled = false;
  for (let fi = r.from; fi <= r.to; fi++) {
    const k = fi - r.from;
    const fr = rawExportCanvas(doc, fi, o);
    x.drawImage(fr, (k % cols) * fw, Math.floor(k / cols) * fh);
    await yieldToUI();
  }
  await yieldToUI();   // 让 toBlob 之前的最后一帧先画上屏
  const base = sanitizeName(doc.name);
  const suffix = (o.bounds ? "_sel" : o.li != null ? "_l" + (o.li + 1) : "") + (r.n < doc.frames.length ? "_f" + (r.from + 1) + "-" + (r.to + 1) : "");
  const frames = doc.frames.slice(r.from, r.to + 1).map((f, k) => ({
    filename: base + suffix + "_" + (r.from + k + 1) + ".png",
    frame: { x: (k % cols) * fw, y: Math.floor(k / cols) * fh, w: fw, h: fh },
    duration: f.durationMs,
  }));
  const meta = { frames, meta: { app: "PixelCraft", version: "2.0", image: base + suffix + "_sheet.png", size: { w: c.width, h: c.height }, scale: o.scale || 1 } };
  const png = await pngBytes(c);
  if (!png) return null;
  return {
    png,
    json: new TextEncoder().encode(JSON.stringify(meta, null, 1)),
    name: base + suffix + "_sheet.png",
    jsonName: base + suffix + "_sheet.json",
  };
}

/** Export the document as an Aseprite file (.aseprite): layers, frames,
 *  durations, blend modes and the palette all survive, so the sprite can be
 *  opened in Aseprite and edited further (see src/io/asewrite.ts).
 *  Scale / background / frame range do not apply: an Aseprite file is a
 *  document, not a rendering. */
export async function exportASE(doc: Doc): Promise<{ bytes: Uint8Array; name: string }> {
  const bytes = await writeAse(doc);
  return { bytes, name: sanitizeName(doc.name || "sprite") + ".aseprite" };
}
