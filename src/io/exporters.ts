// Export helpers: PNG bytes, GIF animation, spritesheet (+JSON meta)
import type { Doc } from "../engine/doc";
import type { RGBA } from "../engine/types";
import * as comp from "../render/compositor";

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

export interface ExportOpts {
  bg?: RGBA | null;
  scale?: number;
  li?: number | null;
  bounds?: RectLike | null;
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
  const table = new Int16Array(1 << 15).fill(-1);
  for (let i = 0; i < palette.length; i++) {
    const c = palette[i];
    const r5 = c[0] >> 3, g5 = c[1] >> 3, b5 = c[2] >> 3;
    for (let dr = -1; dr <= 1; dr++) for (let dg = -1; dg <= 1; dg++) for (let db = -1; db <= 1; db++) {
      const rr = r5 + dr, gg = g5 + dg, bb = b5 + db;
      if (rr < 0 || rr > 31 || gg < 0 || gg > 31 || bb < 0 || bb > 31) continue;
      const ci = (rr << 10) | (gg << 5) | bb;
      if (table[ci] < 0) table[ci] = i;
    }
  }
  const mapFn = (r: number, g: number, b: number): number => {
    let best = table[((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)];
    if (best < 0) best = 0;
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
  const c = rawExportCanvas(doc, fi, o);
  const bytes = await pngBytes(c);
  if (!bytes) return null;
  const suffix = o.bounds ? "_sel" : o.li != null ? "_l" + (o.li + 1) : "_f" + (fi + 1);
  return { bytes, name: sanitizeName(doc.name) + suffix + ".png" };
}

export async function exportGIF(doc: Doc, o: ExportOpts = {}): Promise<{ bytes: Uint8Array; name: string }> {
  const frames: FrameData[] = [];
  for (let fi = 0; fi < doc.frames.length; fi++) {
    const c = rawExportCanvas(doc, fi, o);
    frames.push({ data: c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data, delayMs: doc.frames[fi].durationMs });
  }
  const first = rawExportCanvas(doc, 0, o);
  const bytes = encodeGIF(frames, first.width, first.height, { transparent: o.bg == null });
  const suffix = o.bounds ? "_sel" : o.li != null ? "_l" + (o.li + 1) : "";
  return { bytes, name: sanitizeName(doc.name) + suffix + ".gif" };
}

export async function exportSheet(doc: Doc, o: ExportOpts & { cols?: number } = {}): Promise<{ png: Uint8Array; json: Uint8Array; name: string; jsonName: string } | null> {
  const cols = Math.max(1, Math.min(doc.frames.length, o.cols || doc.frames.length));
  const rows = Math.ceil(doc.frames.length / cols);
  const frame0 = rawExportCanvas(doc, 0, o);
  const fw = frame0.width, fh = frame0.height;
  const c = document.createElement("canvas");
  c.width = fw * cols;
  c.height = fh * rows;
  const x = c.getContext("2d")!;
  x.imageSmoothingEnabled = false;
  for (let fi = 0; fi < doc.frames.length; fi++) {
    const fr = rawExportCanvas(doc, fi, o);
    x.drawImage(fr, (fi % cols) * fw, Math.floor(fi / cols) * fh);
  }
  const base = sanitizeName(doc.name);
  const suffix = o.bounds ? "_sel" : o.li != null ? "_l" + (o.li + 1) : "";
  const frames = doc.frames.map((f, fi) => ({
    filename: base + suffix + "_" + (fi + 1) + ".png",
    frame: { x: (fi % cols) * fw, y: Math.floor(fi / cols) * fh, w: fw, h: fh },
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
