// PixelCraft project file (.pxc): JSON with per-cel PNG data URLs.
import { Doc } from "../engine/doc";
import { Cel } from "../engine/cel";
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

/** `history` is the already-encoded history payload (see historyfile.ts) */
export async function serialize(doc: Doc, history?: unknown): Promise<string> {
  const cels: [string, string][] = [];
  for (const [k, cel] of doc.cels) {
    const png = await celToDataURL(cel);
    if (png) cels.push([k, png]);
  }
  return JSON.stringify({
    app: "PixelCraft",
    v: 2,
    name: doc.name,
    w: doc.w,
    h: doc.h,
    bg: doc.bg ? [...doc.bg] : null,
    layers: doc.layers.map((l) => ({ name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend, locked: l.locked })),
    frames: doc.frames.map((f) => ({ durationMs: f.durationMs })),
    palette: doc.palette.map((c) => [...c]),
    cels,
    history: history ?? undefined,
  });
}

export interface ParsedProject {
  doc: Doc;
  history: unknown | null;
}

/** parse a .pxc file including its optional operation history */
export async function parseProject(text: string): Promise<ParsedProject | null> {
  const doc = await parse(text);
  if (!doc) return null;
  let history: unknown | null = null;
  try {
    const o = JSON.parse(text) as { history?: unknown };
    if (o && o.history) history = o.history;
  } catch { /* ignore */ }
  return { doc, history };
}

export async function parse(text: string): Promise<Doc | null> {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  const obj = o as {
    app?: string; w?: number; h?: number; name?: string;
    bg?: number[] | null; layers?: Record<string, unknown>[]; frames?: { durationMs?: number }[];
    palette?: number[][]; cels?: [string, string][];
  };
  if (obj.app !== "PixelCraft" || !obj.w || !obj.h) return null;
  const doc = new Doc(obj.w, obj.h, obj.name || "untitled");
  doc.layers = (obj.layers || []).map((l: Record<string, unknown>) => ({
    id: Math.random().toString(36).slice(2),
    name: String(l.name ?? "Layer"),
    visible: l.visible !== false,
    opacity: Math.max(0, Math.min(100, Number(l.opacity ?? 100))),
    blend: (["normal", "multiply", "screen", "overlay", "darken", "lighten", "dodge", "burn", "hardlight", "softlight", "difference", "exclusion"].includes(String(l.blend)) ? String(l.blend) : "normal") as Doc["layers"][number]["blend"],
    locked: !!l.locked,
  }));
  doc.frames = (obj.frames && obj.frames.length ? obj.frames : [{ durationMs: 100 }]).map((f) => ({
    id: Math.random().toString(36).slice(2),
    durationMs: Math.max(1, Math.min(60000, Number(f?.durationMs ?? 100))),
  }));
  if (!doc.layers.length) doc.layers = [{ id: "x1", name: "Layer 1", visible: true, opacity: 100, blend: "normal", locked: false }];
  doc.bg = obj.bg && obj.bg.length === 4 ? (obj.bg as RGBA) : null;
  doc.palette = (obj.palette || []).map((c) => [c[0], c[1], c[2], c[3]] as RGBA);
  doc.cels = new Map();
  for (const [k, png] of obj.cels || []) {
    const px = await dataURLToPixels(png, doc.w, doc.h);
    if (px) {
      const cel = new Cel(doc.w, doc.h);
      const n = Math.min(cel.data.length, px.length);
      for (let i = 0; i < n; i++) cel.data[i] = px[i];
      doc.cels.set(k, cel);
    }
  }
  return doc;
}
