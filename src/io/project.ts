// PixelCraft project file (.pxc): JSON with per-cel PNG data URLs.
//
// The PROJECT is the only file unit — one .pxc holds every open canvas (their
// position, their own layer/frame selection and their own history). v2 files
// (a single document) are still readable: they load as a one-canvas project.
import { Doc } from "../engine/doc";
import { Cel } from "../engine/cel";
import { normalizeTags } from "../engine/tags";
import { b64ToBytes, bytesToB64 } from "../engine/b64";
import type { RGBA } from "../engine/types";

function dataURLFromBytes(bytes: Uint8Array, mime: string): string {
  // reuse base64 encoder without import cycle
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH) as unknown as number[]);
  return "data:" + mime + ";base64," + btoa(bin);
}

async function celToDataURL(cel: Cel): Promise<string | null> {
  if (!cel.hasAnyOpaque()) return null;
  const c = document.createElement("canvas");
  c.width = cel.w;
  c.height = cel.h;
  const ctx = c.getContext("2d")!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(cel.data), cel.w, cel.h), 0, 0);
  const blob = await new Promise<Blob | null>((res) => c.toBlob((b) => res(b), "image/png"));
  if (!blob) return null;
  const buf = new Uint8Array(await blob.arrayBuffer());
  return dataURLFromBytes(buf, "image/png");
}

async function dataURLToPixels(dataURL: string, expectW: number, expectH: number): Promise<Uint8ClampedArray | null> {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth || expectW;
        c.height = img.naturalHeight || expectH;
        const ctx = c.getContext("2d")!;
        ctx.clearRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        res(new Uint8ClampedArray(d));
      } catch {
        res(null);
      }
    };
    img.onerror = () => res(null);
    img.src = dataURL;
  });
}

/** the serialisable content of one document (no envelope fields) */
interface DocPayload {
  name: string;
  w: number;
  h: number;
  bg: number[] | null;
  layers: Array<{ id?: string; name: string; visible: boolean; opacity: number; blend: string; locked: boolean; ref?: string | null; refLayer?: string | null }>;
  frames: Array<{ durationMs: number }>;
  /** animation tags (named frame ranges), e.g. "walk" = frames 3–7 */
  tags?: Array<{ name: string; from: number; to: number; dir?: number; repeat?: number; color?: string }>;
  palette: number[][];
  /** cel payload as PNG data URLs (the .pxc file format) */
  cels?: [string, string][];
  /** cel payload as RLE base64 (autosave: pure JSON data, no image encoder) */
  celsRle?: [string, string][];
}

/** Run-length encode a cel's RGBA pixels as [runLength, packedRGBA, ...]
 *  (Uint32 pairs → base64). Pixel art is mostly long flat runs, so this stays
 *  small — and the autosave stays pure JSON instead of embedding PNG images. */
export function rleEncodeCel(data: Uint8ClampedArray): string {
  const n = data.length / 4;
  const out: number[] = [];
  let i = 0;
  const pack = (p: number): number =>
    ((data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]) >>> 0;
  while (i < n) {
    const px = pack(i * 4);
    let run = 1;
    while (i + run < n && pack((i + run) * 4) === px) run++;
    out.push(run, px);
    i += run;
  }
  return bytesToB64(new Uint8Array(new Uint32Array(out).buffer));
}

/** inverse of rleEncodeCel; null when the payload is malformed */
export function rleDecodeCel(s: string, w: number, h: number): Uint8ClampedArray | null {
  const bytes = b64ToBytes(s);
  if (!bytes.length || bytes.length % 8) return null;
  const u32 = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  const out = new Uint8ClampedArray(w * h * 4);
  const total = w * h;
  let i = 0;
  for (let k = 0; k + 1 < u32.length; k += 2) {
    const run = u32[k], px = u32[k + 1];
    for (let n = 0; n < run && i < total; n++, i++) {
      const p = i * 4;
      out[p] = (px >>> 24) & 255;
      out[p + 1] = (px >>> 16) & 255;
      out[p + 2] = (px >>> 8) & 255;
      out[p + 3] = px & 255;
    }
    if (i >= total) break;
  }
  return out;
}

/** how the cel pixels travel inside the JSON payload */
export type CelFormat = "png" | "rle";

async function docPayload(doc: Doc, fmt: CelFormat = "png"): Promise<DocPayload> {
  const cels: [string, string][] = [];
  if (fmt === "rle") {
    for (const [k, cel] of doc.cels) {
      if (!cel.hasAnyOpaque()) continue; // same rule as PNG: empty cels are skipped
      cels.push([k, rleEncodeCel(cel.data)]);
    }
    return { ...(await docPayloadHead(doc)), celsRle: cels };
  }
  for (const [k, cel] of doc.cels) {
    const png = await celToDataURL(cel);
    if (png) cels.push([k, png]);
  }
  return { ...(await docPayloadHead(doc)), cels };
}

/** the non-pixel part of a document payload */
async function docPayloadHead(doc: Doc): Promise<Omit<DocPayload, "cels" | "celsRle">> {
  return {
    name: doc.name,
    w: doc.w,
    h: doc.h,
    bg: doc.bg ? [...doc.bg] : null,
    layers: doc.layers.map((l) => ({
      id: l.id, name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend, locked: l.locked,
      ref: l.ref ?? null, refLayer: l.refLayer ?? null,
    })),
    frames: doc.frames.map((f) => ({ durationMs: f.durationMs })),
    tags: doc.tags.length
      ? doc.tags.map((t) => ({ name: t.name, from: t.from, to: t.to, dir: t.dir, repeat: t.repeat, color: t.color }))
      : undefined,
    palette: doc.palette.map((c) => [...c]),
  };
}

/** rebuild one document from a v2 payload (or a v3 canvas entry) */
async function docFromPayload(obj: {
  w?: number; h?: number; name?: string;
  bg?: number[] | null; layers?: Record<string, unknown>[]; frames?: { durationMs?: number }[];
  tags?: { name?: string; from?: number; to?: number; dir?: number; repeat?: number; color?: string }[];
  palette?: number[][]; cels?: [string, string][]; celsRle?: [string, string][];
}): Promise<Doc | null> {
  if (!obj || !obj.w || !obj.h) return null;
  const doc = new Doc(obj.w, obj.h, obj.name || "untitled");
  doc.layers = (obj.layers || []).map((l: Record<string, unknown>) => ({
    // ids are kept: reference layers point at a specific source layer by id
    id: typeof l.id === "string" && l.id ? l.id : Math.random().toString(36).slice(2),
    name: String(l.name ?? "Layer"),
    visible: l.visible !== false,
    opacity: Math.max(0, Math.min(100, Number(l.opacity ?? 100))),
    blend: (["normal", "multiply", "screen", "overlay", "darken", "lighten", "dodge", "burn", "hardlight", "softlight", "difference", "exclusion"].includes(String(l.blend)) ? String(l.blend) : "normal") as Doc["layers"][number]["blend"],
    locked: !!l.locked,
    ref: typeof l.ref === "string" ? l.ref : null,
    refLayer: typeof l.refLayer === "string" ? l.refLayer : null,
  }));
  doc.frames = (obj.frames && obj.frames.length ? obj.frames : [{ durationMs: 100 }]).map((f) => ({
    id: Math.random().toString(36).slice(2),
    durationMs: Math.max(1, Math.min(60000, Number(f?.durationMs ?? 100))),
  }));
  if (!doc.layers.length) doc.layers = [{ id: "x1", name: "Layer 1", visible: true, opacity: 100, blend: "normal", locked: false }];
  doc.tags = normalizeTags(
    (obj.tags || []).map((t, i) => ({
      id: Math.random().toString(36).slice(2),
      name: String(t?.name ?? "Tag " + (i + 1)).slice(0, 64) || "Tag " + (i + 1),
      from: Math.round(Number(t?.from ?? 0)),
      to: Math.round(Number(t?.to ?? 0)),
      dir: typeof t?.dir === "number" ? t.dir : undefined,
      repeat: typeof t?.repeat === "number" ? t.repeat : undefined,
      color: typeof t?.color === "string" ? t.color : undefined,
    })),
    doc.frames.length,
  );
  doc.bg = obj.bg && obj.bg.length === 4 ? (obj.bg as RGBA) : null;
  doc.palette = (obj.palette || []).map((c) => [c[0], c[1], c[2], c[3]] as RGBA);
  doc.cels = new Map();
  const put = (k: string, px: Uint8ClampedArray | null): void => {
    if (!px) return;
    const cel = new Cel(doc.w, doc.h);
    const n = Math.min(cel.data.length, px.length);
    for (let i = 0; i < n; i++) cel.data[i] = px[i];
    doc.cels.set(k, cel);
  };
  // autosaves carry RLE data, .pxc files carry PNG data URLs
  for (const [k, rle] of obj.celsRle || []) put(k, rleDecodeCel(rle, doc.w, doc.h));
  for (const [k, png] of obj.cels || []) put(k, await dataURLToPixels(png, doc.w, doc.h));
  return doc;
}

/** one canvas of the infinite space */
export interface SpaceEntry {
  /** stable canvas id (reference layers point at it) */
  id?: string;
  doc: Doc;
  x: number;
  y: number;
  li: number;
  fi: number;
  /** already-encoded operation history of THIS canvas (optional) */
  hist?: unknown;
  /** position locked (the title bar cannot drag it) */
  locked?: boolean;
  /** id shared by canvases snapped together (they move as one) */
  group?: string | null;
}

/** serialize the whole multi-canvas space (v3); the focused canvas also fills
 *  the v2 fields so older builds can still open the file */
export async function serializeSpace(entries: SpaceEntry[], focus: number, history?: unknown, fmt: CelFormat = "png"): Promise<string> {
  const canvases: unknown[] = [];
  for (const e of entries) {
    canvases.push({
      id: e.id, x: e.x, y: e.y, li: e.li, fi: e.fi,
      hist: e.hist ?? undefined, locked: e.locked === true, group: e.group ?? null,
      ...(await docPayload(e.doc, fmt)),
    });
  }
  // an empty space is a valid project: "everything closed" survives a restart
  if (!entries.length) return JSON.stringify({ app: "PixelCraft", v: 3, focus: 0, canvases });
  const head = await docPayload(entries[focus] ? entries[focus].doc : entries[0].doc, fmt);
  return JSON.stringify({ app: "PixelCraft", v: 3, ...head, focus, canvases, history: history ?? undefined });
}

export interface ParsedSpace {
  entries: SpaceEntry[];
  focus: number;
  /** the project-wide history payload (v3), null when there is none */
  history: unknown | null;
}

/** parse a .pxc into the full space (v2 single document or v3 canvases) */
export async function parseSpace(text: string): Promise<ParsedSpace | null> {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  const obj = o as Record<string, unknown> & { app?: string; focus?: number; history?: unknown; canvases?: Array<Record<string, unknown>> };
  if (obj.app !== "PixelCraft") return null;
  if (Array.isArray(obj.canvases) && obj.canvases.length) {
    const entries: SpaceEntry[] = [];
    for (const c of obj.canvases) {
      const doc = await docFromPayload(c);
      if (!doc) continue;
      entries.push({
        id: typeof c.id === "string" ? c.id : undefined,
        doc,
        x: Math.round(Number(c.x) || 0),
        y: Math.round(Number(c.y) || 0),
        li: Math.max(0, Math.round(Number(c.li) || 0)),
        fi: Math.max(0, Math.round(Number(c.fi) || 0)),
        hist: (c as { hist?: unknown }).hist ?? null,
        locked: c.locked === true,
        group: typeof c.group === "string" ? c.group : null,
      });
    }
    // "canvases": [] is an explicitly empty project (all canvases closed)
    if (!entries.length) return { entries: [], focus: 0, history: obj.history ?? null };
    const focus = Math.max(0, Math.min(entries.length - 1, Math.round(Number(obj.focus) || 0)));
    return { entries, focus, history: obj.history ?? null };
  }
  const doc = await docFromPayload(obj as Parameters<typeof docFromPayload>[0]);
  if (!doc) return null;
  return { entries: [{ doc, x: 0, y: 0, li: 0, fi: 0 }], focus: 0, history: obj.history ?? null };
}

