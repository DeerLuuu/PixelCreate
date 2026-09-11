// Aseprite file writer (.aseprite).
//
// Writes a v1.3 file that Aseprite (and any reader following the spec) opens:
// one layer chunk per PixelCraft layer, one cel chunk per layer × frame with
// the pixels cropped to their non-transparent bounds, a palette chunk when the
// document has a palette, and zlib-compressed cel payloads whenever the
// platform provides CompressionStream (raw cels otherwise — both are legal).
//
// Kept DOM-free and synchronous apart from the optional compression step so
// the node test suite can round-trip it.
import type { Doc, LayerMeta } from "../engine/doc";
import type { Cel } from "../engine/cel";
import type { BlendMode } from "../engine/types";
import { deflateZlib } from "./zlib";

export const ASE_MAGIC = 0xa5e0;
export const ASE_FRAME_MAGIC = 0xf1fa;

const CHUNK_LAYER = 0x2004;
const CHUNK_CEL = 0x2005;
const CHUNK_PALETTE = 0x2019;

const CEL_RAW = 0;
const CEL_COMPRESSED = 2;

/** PixelCraft blend mode → Aseprite blend mode code */
const BLEND_CODE: Record<BlendMode, number> = {
  normal: 0, multiply: 1, screen: 2, overlay: 3, darken: 4, lighten: 5,
  dodge: 6, burn: 7, hardlight: 8, softlight: 9, difference: 10, exclusion: 11,
};

/** little-endian growable buffer */
class Wr {
  private buf = new Uint8Array(1 << 14);
  private len = 0;

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  u8(v: number): void {
    this.ensure(1);
    this.buf[this.len++] = v & 255;
  }
  u16(v: number): void {
    this.u8(v);
    this.u8(v >> 8);
  }
  u32(v: number): void {
    this.u8(v);
    this.u8(v >> 8);
    this.u8(v >> 16);
    this.u8(v >> 24);
  }
  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
  pad(n: number): void {
    this.ensure(n);
    this.len += n;
  }
  str(s: string): void {
    const b = new TextEncoder().encode(s);
    this.u16(b.length);
    this.bytes(b);
  }
  get size(): number {
    return this.len;
  }
  patchU32(at: number, v: number): void {
    this.buf[at] = v & 255;
    this.buf[at + 1] = (v >> 8) & 255;
    this.buf[at + 2] = (v >> 16) & 255;
    this.buf[at + 3] = (v >> 24) & 255;
  }
  toBytes(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** bounding box of the non-transparent pixels (null = an empty cel) */
export function celBounds(cel: Cel): Rect | null {
  let x0 = cel.w;
  let y0 = cel.h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < cel.h; y++) {
    const row = y * cel.w * 4;
    for (let x = 0; x < cel.w; x++) {
      if (cel.data[row + x * 4 + 3] > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** the pixels of `rect` as tightly packed RGBA bytes (row by row) */
function pixelsOf(cel: Cel, r: Rect): Uint8Array {
  if (r.x === 0 && r.y === 0 && r.w === cel.w && r.h === cel.h) return new Uint8Array(cel.data);
  const out = new Uint8Array(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) {
    const src = ((r.y + y) * cel.w + r.x) * 4;
    out.set(cel.data.subarray(src, src + r.w * 4), y * r.w * 4);
  }
  return out;
}

/** one layer as it will be written (the backdrop becomes a real layer) */
interface OutLayer {
  name: string;
  visible: boolean;
  locked: boolean;
  /** 0-255, the scale the file uses */
  opacity: number;
  blend: number;
  background: boolean;
  /** index into doc.layers, or -1 for the synthesised background */
  li: number;
}

/** an opaque `doc.bg` backdrop is written as a real "Background" layer so the
 *  exported file looks the same as the canvas did */
function outLayersOf(doc: Doc): OutLayer[] {
  const out: OutLayer[] = [];
  const bg = doc.bg;
  if (bg && (bg[3] ?? 255) > 0) {
    out.push({ name: "Background", visible: true, locked: false, opacity: 255, blend: 0, background: true, li: -1 });
  }
  doc.layers.forEach((l: LayerMeta, li: number) => {
    out.push({
      name: l.name || "Layer " + (li + 1),
      visible: l.visible,
      locked: l.locked,
      opacity: Math.max(0, Math.min(255, Math.round((l.opacity / 100) * 255))),
      blend: BLEND_CODE[l.blend] ?? 0,
      background: false,
      li,
    });
  });
  return out;
}

interface OutCel {
  li: number;
  x: number;
  y: number;
  w: number;
  h: number;
  compressed: boolean;
  data: Uint8Array;
}

/**
 * Serialise `doc` as an Aseprite file.
 *
 * - layer order, names, visibility, opacity, blend modes and lock state survive
 * - every frame keeps its duration
 * - cels are cropped to their content, which is what Aseprite itself does
 * - `compress: false` forces raw cels (used by the tests and by platforms
 *   without CompressionStream)
 */
export async function writeAse(doc: Doc, opts: { compress?: boolean } = {}): Promise<Uint8Array> {
  const wantCompress = opts.compress !== false;
  const layers = outLayersOf(doc);
  const frameCount = Math.max(1, doc.frames.length);
  const bg = doc.bg;

  // ---- prepare the cel payloads (compression is the only async part) ----
  const cels: OutCel[][] = [];
  for (let fi = 0; fi < frameCount; fi++) {
    const list: OutCel[] = [];
    for (let li = 0; li < layers.length; li++) {
      const layer = layers[li];
      let rect: Rect | null;
      let px: Uint8Array;
      if (layer.li >= 0) {
        const cel = doc.celAt(layer.li, fi);
        if (!cel) continue;
        rect = celBounds(cel);
        if (!rect) continue;
        px = pixelsOf(cel, rect);
      } else {
        if (!bg) continue;
        rect = { x: 0, y: 0, w: doc.w, h: doc.h };
        px = new Uint8Array(doc.w * doc.h * 4);
        for (let i = 0; i < px.length; i += 4) {
          px[i] = bg[0];
          px[i + 1] = bg[1];
          px[i + 2] = bg[2];
          px[i + 3] = bg[3] ?? 255;
        }
      }
      let data = px;
      let compressed = false;
      if (wantCompress) {
        const z = await deflateZlib(px);
        // a compressed payload only pays off when it is actually smaller
        if (z && z.length < px.length) {
          data = z;
          compressed = true;
        }
      }
      list.push({ li, x: rect.x, y: rect.y, w: rect.w, h: rect.h, compressed, data });
    }
    cels.push(list);
  }

  // ---- serialise ----
  const w = new Wr();
  const headerAt = w.size;
  w.u32(0); // file size, patched at the end
  w.u16(ASE_MAGIC);
  w.u16(frameCount);
  w.u16(doc.w);
  w.u16(doc.h);
  w.u16(32); // 32 bpp = RGBA
  w.u32(1); // flags: layer opacity has a valid value
  w.u16(Math.max(1, Math.min(65535, Math.round(doc.frames[0]?.durationMs ?? 100))));
  w.u32(0); // deprecated
  w.u32(0); // deprecated
  w.u8(0); // transparent palette index (indexed sprites only)
  w.u8(0);
  w.u8(0);
  w.u8(0);
  w.u16(Math.min(65535, doc.palette.length)); // number of colors
  w.u8(1); // pixel ratio
  w.u8(1);
  w.u16(0); // grid x
  w.u16(0); // grid y
  w.u16(0); // grid width (0 = no grid)
  w.u16(0); // grid height
  w.pad(84);

  for (let fi = 0; fi < frameCount; fi++) {
    const frameAt = w.size;
    const list = cels[fi];
    // frame 0 carries the palette + layer chunks (Aseprite writes the layer
    // layout once, in the first frame)
    const chunks = list.length + (fi === 0 ? layers.length + (doc.palette.length ? 1 : 0) : 0);
    w.u32(0); // frame size, patched below
    w.u16(ASE_FRAME_MAGIC);
    w.u16(chunks < 0xffff ? chunks : 0xffff);
    w.u16(Math.max(1, Math.min(65535, Math.round(doc.frames[fi]?.durationMs ?? 100))));
    w.pad(2);
    w.u32(chunks);

    if (fi === 0) {
      if (doc.palette.length) {
        const at = w.size;
        w.u32(0);
        w.u16(CHUNK_PALETTE);
        w.u32(doc.palette.length);
        w.u32(0);
        w.u32(doc.palette.length - 1);
        w.pad(8);
        for (const c of doc.palette) {
          w.u16(0); // no entry name
          w.u8(c[0]);
          w.u8(c[1]);
          w.u8(c[2]);
          w.u8(c[3] ?? 255);
        }
        w.patchU32(at, w.size - at);
      }
      for (const layer of layers) {
        // flags: 1 visible, 2 editable, 4 lock movement, 8 background
        const flags = (layer.visible ? 1 : 0) | (layer.locked ? 0 : 2) | (layer.background ? 8 : 0);
        const at = w.size;
        w.u32(0);
        w.u16(CHUNK_LAYER);
        w.u16(flags);
        w.u16(0); // normal (image) layer
        w.u16(0); // child level: PixelCraft layers are flat
        w.u16(0); // default width (ignored by readers)
        w.u16(0); // default height
        w.u16(layer.blend);
        w.u8(layer.opacity);
        w.pad(3);
        w.str(layer.name);
        w.patchU32(at, w.size - at);
      }
    }

    for (const c of list) {
      const at = w.size;
      w.u32(0);
      w.u16(CHUNK_CEL);
      w.u16(c.li);
      w.u16(c.x);
      w.u16(c.y);
      w.u8(255); // cel opacity (already baked into the pixels)
      w.u16(c.compressed ? CEL_COMPRESSED : CEL_RAW);
      w.u16(0); // z-index
      w.pad(5);
      w.u16(c.w);
      w.u16(c.h);
      w.bytes(c.data);
      w.patchU32(at, w.size - at);
    }

    w.patchU32(frameAt, w.size - frameAt);
  }

  const bytes = w.toBytes();
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  dv.setUint32(headerAt, bytes.length, true);
  return bytes;
}
