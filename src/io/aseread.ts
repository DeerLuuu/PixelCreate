// Aseprite file reader (.ase / .aseprite, format v1.3).
//
// Implements the official specification
// (https://github.com/aseprite/aseprite/blob/main/docs/ase-file-specs.md):
// 128-byte header, per-frame headers, and the chunk types we can map onto a
// PixelCraft document — layers (0x2004), cels (0x2005, raw / linked / zlib),
// palette (0x2019 + the old 0x0004/0x0011 chunks) and tags (0x2018).
// Everything else (slices, tilesets, user data, color profile, masks) is
// skipped by chunk size, so a file written by a newer Aseprite still opens.
//
// The parser is DOM-free and synchronous: cels are inflated by src/io/zlib.ts
// instead of DecompressionStream so it also runs in the plain-node test suite.
import { Cel } from "../engine/cel";
import { Doc, type LayerMeta } from "../engine/doc";
import { normalizeTags } from "../engine/tags";
import type { BlendMode, RGBA } from "../engine/types";
import { uid } from "../engine/types";
import { inflateZlib } from "./zlib";

export const ASE_MAGIC = 0xa5e0;
export const ASE_FRAME_MAGIC = 0xf1fa;

/** PixelCraft documents are capped at 1024×1024, so bigger sprites are refused
 *  instead of being silently cropped by the Doc constructor. */
export const ASE_MAX_SIZE = 1024;
/** sanity cap for one cel payload: a corrupt header must not make us allocate
 *  gigabytes before we notice (1024×1024×4 = 4 MB, so this is generous) */
const MAX_CEL_BYTES = 64 * 1024 * 1024;

/** quick probe: the magic word (0xA5E0, little-endian) sits right after the
 *  32-bit file size */
export function isAseBytes(b: Uint8Array): boolean {
  return b.length >= 128 && b[4] === (ASE_MAGIC & 0xff) && b[5] === (ASE_MAGIC >> 8);
}

/** ASE blend mode code → PixelCraft blend mode. Aseprite has seven modes we
 *  cannot composite (hue / saturation / color / luminosity / addition /
 *  subtract / divide); those fall back to "normal". */
const ASE_BLEND: BlendMode[] = [
  "normal", "multiply", "screen", "overlay", "darken", "lighten",
  "dodge", "burn", "hardlight", "softlight", "difference", "exclusion",
];

export function aseBlendName(code: number): BlendMode {
  return ASE_BLEND[code] ?? "normal";
}

export interface AseLayer {
  name: string;
  visible: boolean;
  editable: boolean;
  background: boolean;
  /** 0-255 (the file's own scale) */
  opacity: number;
  blend: number;
  group: boolean;
  tilemap: boolean;
  reference: boolean;
  childLevel: number;
}

export interface AseFrame {
  durationMs: number;
}

/** one cel with its pixels already decoded to RGBA (w×h, not the sprite size) */
export interface AseCel {
  li: number;
  fi: number;
  x: number;
  y: number;
  w: number;
  h: number;
  opacity: number;
  rgba: Uint8ClampedArray;
}

export interface AseTag {
  name: string;
  from: number;
  to: number;
  /** 0 forward, 1 reverse, 2 ping-pong, 3 ping-pong reverse */
  direction: number;
  repeat: number;
  /** #rrggbb from the (deprecated) tag colour bytes, when they are not black */
  color?: string;
}

export interface AseFile {
  w: number;
  h: number;
  /** 32 = RGBA, 16 = grayscale, 8 = indexed */
  bpp: number;
  /** palette index that means "transparent" (indexed sprites only) */
  transparentIndex: number;
  /** deprecated header field, used when a frame has no duration */
  speed: number;
  layers: AseLayer[];
  frames: AseFrame[];
  cels: AseCel[];
  palette: RGBA[] | null;
  tags: AseTag[];
}

/** bounds-checked little-endian cursor */
class Rd {
  p = 0;
  fail = false;
  constructor(readonly b: Uint8Array) {}

  private need(n: number): boolean {
    if (this.p + n > this.b.length) {
      this.fail = true;
      this.p = this.b.length;
      return false;
    }
    return true;
  }
  u8(): number {
    return this.need(1) ? this.b[this.p++] : 0;
  }
  u16(): number {
    if (!this.need(2)) return 0;
    const v = this.b[this.p] | (this.b[this.p + 1] << 8);
    this.p += 2;
    return v;
  }
  i16(): number {
    const v = this.u16();
    return v >= 0x8000 ? v - 0x10000 : v;
  }
  u32(): number {
    if (!this.need(4)) return 0;
    const b = this.b;
    const v = (b[this.p] | (b[this.p + 1] << 8) | (b[this.p + 2] << 16) | (b[this.p + 3] << 24)) >>> 0;
    this.p += 4;
    return v;
  }
  /** WORD length + UTF-8 bytes */
  str(): string {
    const n = this.u16();
    if (!this.need(n)) return "";
    const s = new TextDecoder().decode(this.b.subarray(this.p, this.p + n));
    this.p += n;
    return s;
  }
  skip(n: number): void {
    if (n > 0 && this.need(n)) this.p += n;
  }
  /** a view of the next n bytes (no copy) */
  view(n: number): Uint8Array {
    if (!this.need(n)) return new Uint8Array(0);
    const v = this.b.subarray(this.p, this.p + n);
    this.p += n;
    return v;
  }
}

interface RawCel {
  li: number;
  fi: number;
  x: number;
  y: number;
  opacity: number;
  type: number;
  w: number;
  h: number;
  /** raw file-order pixel bytes (bpp/8 per pixel) */
  px: Uint8Array | null;
  /** frame this cel is linked to (type 1) */
  link: number;
}

/**
 * Parse an .ase/.aseprite file. Returns null when the bytes are not a valid
 * Aseprite file (bad magic, truncated header, unsupported color depth).
 * Unsupported *chunks* are skipped, never fatal.
 */
export function parseAse(bytes: Uint8Array): AseFile | null {
  if (bytes.length < 128) return null;
  const r = new Rd(bytes);
  r.u32(); // file size (rewritten at the end by the encoder, not trusted)
  if (r.u16() !== ASE_MAGIC) return null;
  const frameCount = r.u16();
  const w = r.u16();
  const h = r.u16();
  const bpp = r.u16();
  r.u32(); // flags: 1 = layer opacity has a valid value
  const speed = r.u16();
  r.u32(); // deprecated
  r.u32(); // deprecated
  const transparentIndex = r.u8();
  r.skip(3);
  r.u16(); // number of colors
  r.u8(); // pixel ratio w
  r.u8(); // pixel ratio h
  r.skip(4); // grid x, grid y
  r.skip(4); // grid w, grid h
  r.skip(84);
  if (r.fail || !frameCount || !w || !h) return null;
  if (bpp !== 8 && bpp !== 16 && bpp !== 32) return null;

  const pxBytes = bpp / 8;
  const layers: AseLayer[] = [];
  const frames: AseFrame[] = [];
  const cels: RawCel[] = [];
  const tags: AseTag[] = [];
  let palette: RGBA[] | null = null;
  let oldPalette: RGBA[] | null = null;
  let sawNewPalette = false;

  const put = (into: RGBA[] | null, i: number, c: RGBA): RGBA[] => {
    const arr = into ?? [];
    while (arr.length <= i) arr.push([0, 0, 0, 0]);
    arr[i] = c;
    return arr;
  };
  /** old FLI color chunks (0x0004 / 0x0011): packets of R,G,B values */
  const readOldPalette = (r2: Rd, sixBit: boolean): void => {
    const packets = r2.u16();
    let idx = 0;
    for (let i = 0; i < packets && !r2.fail; i++) {
      idx += r2.u8();
      let size = r2.u8();
      if (size === 0) size = 256;
      for (let c = 0; c < size && !r2.fail; c++) {
        let cr = r2.u8();
        let cg = r2.u8();
        let cb = r2.u8();
        if (sixBit) {
          cr = (cr << 2) | (cr >> 4);
          cg = (cg << 2) | (cg >> 4);
          cb = (cb << 2) | (cb >> 4);
        }
        oldPalette = put(oldPalette, idx++, [cr, cg, cb, 255]);
      }
    }
  };

  for (let fi = 0; fi < frameCount; fi++) {
    const frameStart = r.p;
    const frameBytes = r.u32();
    if (r.u16() !== ASE_FRAME_MAGIC) return null;
    const oldChunks = r.u16();
    const duration = r.u16();
    r.skip(2);
    const newChunks = r.u32();
    if (r.fail) return null;
    frames.push({ durationMs: duration });
    const declared = newChunks > 0 ? newChunks : oldChunks === 0xffff ? 0 : oldChunks;
    // trust the frame size only when it is consistent with the file
    const declaredEnd = frameStart + frameBytes;
    const end = frameBytes >= 16 && declaredEnd <= bytes.length ? declaredEnd : 0;
    if (!end && declared === 0) return null;

    for (let ci = 0; declared === 0 || ci < declared; ci++) {
      if ((end && r.p + 6 > end) || r.fail) break;
      const chunkStart = r.p;
      const size = r.u32();
      const type = r.u16();
      if (size < 6 || chunkStart + size > bytes.length) return null;
      const dataEnd = chunkStart + size;

      if (type === 0x2004) {
        // ---- layer chunk ----
        const flags = r.u16();
        const layerType = r.u16();
        const childLevel = r.u16();
        r.skip(4); // default width / height
        const blend = r.u16();
        const opacity = r.u8();
        r.skip(3);
        const name = r.str();
        if (layerType === 2) r.u32(); // tilemap: tileset index
        layers.push({
          name,
          visible: (flags & 1) !== 0,
          editable: (flags & 2) !== 0,
          background: (flags & 8) !== 0,
          opacity,
          blend,
          group: layerType === 1,
          tilemap: layerType === 2,
          reference: (flags & 64) !== 0,
          childLevel,
        });
      } else if (type === 0x2005) {
        // ---- cel chunk ----
        const li = r.u16();
        const x = r.i16();
        const y = r.i16();
        const opacity = r.u8();
        const celType = r.u16();
        r.i16(); // z-index (see NOTE.5 of the spec; unused by PixelCraft)
        r.skip(5);
        const cel: RawCel = { li, fi, x, y, opacity, type: celType, w: 0, h: 0, px: null, link: -1 };
        if (celType === 0 || celType === 2) {
          cel.w = r.u16();
          cel.h = r.u16();
          const raw = cel.w * cel.h * pxBytes;
          if (raw > MAX_CEL_BYTES) return null; // corrupt size, refuse early
          if (celType === 0) {
            // clamp to the chunk: a truncated file must not eat the next chunk
            cel.px = r.view(Math.min(raw, Math.max(0, dataEnd - r.p)));
          } else {
            const zdata = bytes.subarray(r.p, dataEnd);
            cel.px = inflateZlib(zdata, raw);
            if (!cel.px) return null; // a corrupt cel is a corrupt file
          }
        } else if (celType === 1) {
          cel.link = r.u16();
        }
        // 3 = compressed tilemap: no pixel payload we can use → dropped
        if (celType !== 3) cels.push(cel);
      } else if (type === 0x2019) {
        // ---- palette chunk ----
        const newSize = r.u32();
        const from = r.u32();
        const to = r.u32();
        r.skip(8);
        if (to > 65535 || from > to) return null; // corrupt range
        if (newSize > 65535) return null;
        if (newSize > 0 && (!palette || palette.length < newSize)) {
          const grown = palette ? palette.slice() : [];
          while (grown.length < newSize) grown.push([0, 0, 0, 0]);
          palette = grown;
        }
        for (let c = from; c <= to && !r.fail; c++) {
          const eflags = r.u16();
          const cr = r.u8();
          const cg = r.u8();
          const cb = r.u8();
          const ca = r.u8();
          if (eflags & 1) r.str(); // entry name
          palette = put(palette, c, [cr, cg, cb, ca]);
        }
        sawNewPalette = true;
      } else if (type === 0x0004) {
        // ---- old palette chunk (ignored when 0x2019 is present) ----
        readOldPalette(r, false);
      } else if (type === 0x0011) {
        readOldPalette(r, true);
      } else if (type === 0x2018) {
        // ---- tags chunk ----
        const n = r.u16();
        r.skip(8);
        for (let t = 0; t < n && !r.fail; t++) {
          const from = r.u16();
          const to = r.u16();
          const direction = r.u8();
          const repeat = r.u16();
          r.skip(6);
          // deprecated RGB bytes: Aseprite v1.2.x stored the tag colour here,
          // v1.3 moved it to a user-data chunk we do not parse — keep them so
          // our own round trip through the tag bar colour survives
          const cr = r.u8();
          const cg = r.u8();
          const cb = r.u8();
          r.skip(1); // extra byte
          const name = r.str();
          const color = cr || cg || cb ? "#" + [cr, cg, cb].map((v) => v.toString(16).padStart(2, "0")).join("") : undefined;
          tags.push({ name, from, to, direction, repeat, color });
        }
      }
      // any other chunk (slices, tilesets, user data, color profile…) is
      // skipped by size, which is exactly why every chunk carries its size
      r.p = dataEnd;
    }
    if (r.fail) return null;
    if (end) r.p = end;
  }
  // the old FLI chunks only count when the file has no 0x2019 palette
  if (!sawNewPalette && oldPalette) palette = oldPalette;

  const opaque = transparentIndex | 0;
  const out: AseCel[] = [];
  const decode = (c: RawCel): Uint8ClampedArray | null => {
    if (!c.px || c.w <= 0 || c.h <= 0) return null;
    const n = c.w * c.h;
    const dst = new Uint8ClampedArray(n * 4);
    if (bpp === 32) {
      const m = Math.min(n * 4, c.px.length);
      for (let i = 0; i < m; i++) dst[i] = c.px[i];
    } else if (bpp === 16) {
      for (let i = 0; i < n && i * 2 + 1 < c.px.length; i++) {
        const v = c.px[i * 2];
        dst[i * 4] = v;
        dst[i * 4 + 1] = v;
        dst[i * 4 + 2] = v;
        dst[i * 4 + 3] = c.px[i * 2 + 1];
      }
    } else {
      const pal = palette ?? [];
      for (let i = 0; i < n && i < c.px.length; i++) {
        const pi = c.px[i];
        const col = pi === opaque ? null : pal[pi];
        if (!col) continue;
        dst[i * 4] = col[0];
        dst[i * 4 + 1] = col[1];
        dst[i * 4 + 2] = col[2];
        dst[i * 4 + 3] = col[3];
      }
    }
    if (c.opacity < 255) {
      const k = c.opacity / 255;
      for (let i = 3; i < dst.length; i += 4) dst[i] = Math.round(dst[i] * k);
    }
    return dst;
  };
  // linked cels point at another frame of the same layer; resolve in two
  // passes so a link may appear before its source
  const byKey = new Map<string, RawCel>();
  for (const c of cels) byKey.set(c.li + ":" + c.fi, c);
  for (const c of cels) {
    let src = c;
    for (let guard = 0; src.type === 1 && guard < 64; guard++) {
      const next = byKey.get(src.li + ":" + src.link);
      if (!next || next === src) break;
      src = next;
    }
    const rgba = decode(src);
    if (!rgba) continue;
    out.push({ li: c.li, fi: c.fi, x: src.x, y: src.y, w: src.w, h: src.h, opacity: src.opacity, rgba });
  }

  return { w, h, bpp, transparentIndex: bpp === 8 ? opaque : 0, speed, layers, frames, cels: out, palette, tags };
}

/** result of readAseDoc(). Plain optional fields instead of a discriminated
 *  union on purpose: this codebase compiles with `strict: false`, where a
 *  `{ ok: true } | { ok: false }` union does not narrow. */
export interface AseImport {
  ok: boolean;
  /** the imported document (set when ok) */
  doc?: Doc;
  /** i18n key of the failure reason: aseBad / aseTooBig */
  reason?: string;
  layers?: number;
  frames?: number;
  cels?: number;
  tags?: number;
}

/** Turn a parsed Aseprite file into a PixelCraft document (null when it does
 *  not fit the 1024×1024 document limit). */
export function aseToDoc(file: AseFile): Doc | null {
  if (file.w > ASE_MAX_SIZE || file.h > ASE_MAX_SIZE) return null;
  const doc = new Doc(file.w, file.h, "sprite");
  const map: number[] = [];
  const metas: LayerMeta[] = [];
  for (const l of file.layers) {
    // groups and tilemaps have no pixel data we can store: their children
    // (childLevel > 0) still come through as ordinary layers
    if (l.group || l.tilemap) {
      map.push(-1);
      continue;
    }
    map.push(metas.length);
    metas.push({
      id: uid(),
      name: l.name || "Layer " + (metas.length + 1),
      visible: l.visible,
      opacity: Math.max(0, Math.min(100, Math.round((l.opacity / 255) * 100))),
      blend: aseBlendName(l.blend),
      locked: !l.editable,
    });
  }
  if (!metas.length) metas.push({ id: uid(), name: "Layer 1", visible: true, opacity: 100, blend: "normal", locked: false });
  doc.layers = metas;

  const dur = (d: number): number => Math.max(1, Math.min(60000, d || file.speed || 100));
  doc.frames = (file.frames.length ? file.frames : [{ durationMs: 100 }]).map((f) => ({ id: uid(), durationMs: dur(f.durationMs) }));

  // animation tags become real tags here, so playback inside Aseprite's
  // "walk" / "idle" ranges works the same way it does over there
  doc.tags = normalizeTags(
    file.tags.map((tg, i) => ({
      id: uid(),
      name: tg.name || "Tag " + (i + 1),
      from: tg.from,
      to: tg.to,
      dir: tg.direction,
      repeat: tg.repeat,
      color: tg.color,
    })),
    doc.frames.length,
  );

  doc.cels = new Map();
  for (const c of file.cels) {
    const li = map[c.li];
    if (li === undefined || li < 0 || c.fi >= doc.frames.length) continue;
    const cel = new Cel(doc.w, doc.h);
    for (let y = 0; y < c.h; y++) {
      const ty = c.y + y;
      if (ty < 0 || ty >= doc.h) continue;
      for (let x = 0; x < c.w; x++) {
        const tx = c.x + x;
        if (tx < 0 || tx >= doc.w) continue;
        const si = (y * c.w + x) * 4;
        const di = (ty * doc.w + tx) * 4;
        cel.data[di] = c.rgba[si];
        cel.data[di + 1] = c.rgba[si + 1];
        cel.data[di + 2] = c.rgba[si + 2];
        cel.data[di + 3] = c.rgba[si + 3];
      }
    }
    doc.cels.set(doc.key(li, c.fi), cel);
  }
  if (file.palette && file.palette.length) doc.palette = file.palette.map((c) => [c[0], c[1], c[2], c[3]] as RGBA);
  return doc;
}

/** Parse + convert in one step (this is what the open/import flow calls). */
export function readAseDoc(bytes: Uint8Array, name = "sprite"): AseImport {
  const file = parseAse(bytes);
  if (!file) return { ok: false, reason: "aseBad" };
  if (file.w > ASE_MAX_SIZE || file.h > ASE_MAX_SIZE) return { ok: false, reason: "aseTooBig" };
  const doc = aseToDoc(file);
  if (!doc) return { ok: false, reason: "aseBad" };
  doc.name = name.replace(/\.[^.]+$/, "") || "sprite";
  return { ok: true, doc, layers: doc.layers.length, frames: doc.frames.length, cels: doc.cels.size, tags: file.tags.length };
}
