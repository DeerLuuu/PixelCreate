// Aseprite (.ase / .aseprite) reader + writer regression tests.
//
// The fixtures here are built BY HAND from the published specification
// (docs/ase-file-specs.md) instead of with our own writer, so a wrong
// assumption in the writer cannot hide a wrong assumption in the reader:
//
//   * header / frame header / chunk framing
//   * layer chunk (0x2004) flags, opacity, blend, name
//   * cel chunk (0x2005) raw, linked and zlib-compressed payloads
//   * palette chunk (0x2019) and the old FLI color chunk (0x0004)
//   * RGBA (32bpp), grayscale (16bpp) and indexed (8bpp) pixel formats
//   * unknown chunks are skipped by size, not fatal
//
// The round-trip half then writes a document and parses the bytes back.
import { Doc } from "../src/engine/doc";
import { aseToDoc, isAseBytes, parseAse, readAseDoc } from "../src/io/aseread";
import { writeAse } from "../src/io/asewrite";
import { canDeflate, inflateZlib } from "../src/io/zlib";
import { eq, ok } from "./common";

// ---------------------------------------------------------------- byte builder

class Buf {
  private a: number[] = [];
  u8(v: number): this {
    this.a.push(v & 255);
    return this;
  }
  u16(v: number): this {
    this.u8(v);
    this.u8(v >> 8);
    return this;
  }
  u32(v: number): this {
    this.u16(v);
    this.u16(v >> 16);
    return this;
  }
  str(s: string): this {
    let bin = "";
    for (const ch of s) {
      const c = ch.codePointAt(0) as number;
      if (c < 0x80) bin += String.fromCharCode(c);
      else if (c < 0x800) bin += String.fromCharCode(0xc0 | (c >> 6), 0x80 | (c & 63));
      else bin += String.fromCharCode(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    this.u16(bin.length);
    for (let i = 0; i < bin.length; i++) this.u8(bin.charCodeAt(i));
    return this;
  }
  raw(b: Uint8Array | number[]): this {
    for (let i = 0; i < b.length; i++) this.u8(b[i]);
    return this;
  }
  pad(n: number): this {
    for (let i = 0; i < n; i++) this.u8(0);
    return this;
  }
  get len(): number {
    return this.a.length;
  }
  patch32(at: number, v: number): void {
    this.a[at] = v & 255;
    this.a[at + 1] = (v >> 8) & 255;
    this.a[at + 2] = (v >> 16) & 255;
    this.a[at + 3] = (v >> 24) & 255;
  }
  bytes(): Uint8Array {
    return new Uint8Array(this.a);
  }
}

function chunk(out: Buf, type: number, body: (b: Buf) => void): void {
  const b = new Buf();
  body(b);
  out.u32(b.len + 6);
  out.u16(type);
  out.raw(b.bytes());
}

interface CelSpec {
  li: number;
  x?: number;
  y?: number;
  opacity?: number;
  /** cel size, defaults to the sprite size */
  w?: number;
  h?: number;
  /** raw pixel values in file order (bpp/8 bytes per pixel) */
  px?: number[];
  /** zlib-compressed payload instead of the raw one */
  z?: Uint8Array;
  /** linked-cel source frame (cel type 1) */
  link?: number;
}

interface FileSpec {
  w: number;
  h: number;
  bpp?: number;
  transparentIndex?: number;
  speed?: number;
  palette?: number[][];
  layers?: { name: string; flags?: number; type?: number; blend?: number; opacity?: number }[];
  frames: { durationMs: number; cels: CelSpec[] }[];
  /** extra chunks injected into the first frame (unknown-chunk test) */
  extra?: (b: Buf) => void;
}

/** hand-written .aseprite file following the spec */
function buildAse(spec: FileSpec): Uint8Array {
  const bpp = spec.bpp ?? 32;
  const out = new Buf();
  const headerAt = out.len;
  out.u32(0);
  out.u16(0xa5e0);
  out.u16(spec.frames.length);
  out.u16(spec.w);
  out.u16(spec.h);
  out.u16(bpp);
  out.u32(1); // layer opacity is valid
  out.u16(spec.speed ?? 100);
  out.u32(0);
  out.u32(0);
  out.u8(spec.transparentIndex ?? 0);
  out.pad(3);
  out.u16(spec.palette ? spec.palette.length : 0);
  out.u8(1);
  out.u8(1);
  out.u16(0);
  out.u16(0);
  out.u16(0);
  out.u16(0);
  out.pad(84);

  spec.frames.forEach((frame, fi) => {
    const frameAt = out.len;
    out.u32(0);
    out.u16(0xf1fa);
    out.u16(0);
    out.u16(frame.durationMs);
    out.pad(2);
    const chunksAt = out.len;
    out.u32(0);
    let chunks = 0;

    if (fi === 0) {
      if (spec.palette) {
        chunk(out, 0x2019, (b) => {
          b.u32(spec.palette!.length);
          b.u32(0);
          b.u32(spec.palette!.length - 1);
          b.pad(8);
          for (const c of spec.palette!) {
            b.u16(0);
            b.u8(c[0]);
            b.u8(c[1]);
            b.u8(c[2]);
            b.u8(c[3]);
          }
        });
        chunks++;
      }
      for (const l of spec.layers ?? []) {
        chunk(out, 0x2004, (b) => {
          b.u16(l.flags ?? 3); // visible + editable
          b.u16(l.type ?? 0); // 0 normal, 1 group, 2 tilemap
          b.u16(0); // child level
          b.u16(0);
          b.u16(0);
          b.u16(l.blend ?? 0);
          b.u8(l.opacity ?? 255);
          b.pad(3);
          b.str(l.name);
        });
        chunks++;
      }
      if (spec.extra) {
        spec.extra(out);
        chunks++;
      }
    }

    for (const cel of frame.cels) {
      chunk(out, 0x2005, (b) => {
        b.u16(cel.li);
        b.u16((cel.x ?? 0) & 0xffff);
        b.u16((cel.y ?? 0) & 0xffff);
        b.u8(cel.opacity ?? 255);
        if (cel.link !== undefined) {
          b.u16(1);
          b.u16(0);
          b.pad(5);
          b.u16(cel.link);
          return;
        }
        const compressed = !!cel.z;
        b.u16(compressed ? 2 : 0);
        b.u16(0);
        b.pad(5);
        b.u16(cel.w ?? spec.w);
        b.u16(cel.h ?? spec.h);
        if (compressed) b.raw(cel.z as Uint8Array);
        else b.raw(cel.px ?? []);
      });
      chunks++;
    }

    out.patch32(chunksAt, chunks);
    out.patch32(frameAt, out.len - frameAt);
  });
  out.patch32(headerAt, out.len);
  return out.bytes();
}

/** w×h RGBA buffer with one pixel painted */
function dot(w: number, h: number, x: number, y: number, c: number[]): number[] {
  const px = new Array(w * h * 4).fill(0);
  const o = (y * w + x) * 4;
  for (let i = 0; i < c.length; i++) px[o + i] = c[i];
  return px;
}

function pick(cel: { data: Uint8ClampedArray } | null, w: number, x: number, y: number): number[] | null {
  if (!cel) return null;
  const o = (y * w + x) * 4;
  return [cel.data[o], cel.data[o + 1], cel.data[o + 2], cel.data[o + 3]];
}

export async function testAse(): Promise<void> {
  // ---------------- reader: synthetic fixtures ----------------
  const basic = buildAse({
    w: 4,
    h: 3,
    layers: [{ name: "底" }, { name: "Top", flags: 1, blend: 2, opacity: 128 }],
    frames: [
      { durationMs: 120, cels: [{ li: 0, px: dot(4, 3, 1, 2, [10, 20, 30, 255]) }] },
      { durationMs: 250, cels: [{ li: 1, x: 2, y: 1, w: 2, h: 1, px: dot(2, 1, 0, 0, [200, 100, 50, 255]) }] },
    ],
    palette: [[1, 2, 3, 255], [4, 5, 6, 255]],
  });
  ok("ase.probe", isAseBytes(basic) && !isAseBytes(new Uint8Array([1, 2, 3, 4, 5, 6])));
  const f1 = parseAse(basic);
  ok("ase.parse", !!f1);
  eq("ase.size", [f1?.w, f1?.h, f1?.bpp], [4, 3, 32]);
  eq("ase.frames", f1?.frames.map((f) => f.durationMs), [120, 250]);
  eq("ase.layer-names", f1?.layers.map((l) => l.name), ["底", "Top"]);
  eq("ase.layer-meta", [
    f1?.layers[0].visible, f1?.layers[0].editable, f1?.layers[0].opacity,
    f1?.layers[1].visible, f1?.layers[1].editable, f1?.layers[1].blend, f1?.layers[1].opacity,
  ], [true, true, 255, true, false, 2, 128]);
  eq("ase.palette", f1?.palette, [[1, 2, 3, 255], [4, 5, 6, 255]]);

  const d1 = aseToDoc(f1!);
  ok("ase.doc", !!d1);
  eq("ase.doc-shape", [d1?.w, d1?.h, d1?.layers.length, d1?.frames.length], [4, 3, 2, 2]);
  eq("ase.doc-layer", [d1?.layers[1].name, d1?.layers[1].blend, d1?.layers[1].opacity, d1?.layers[1].locked], ["Top", "screen", 50, true]);
  eq("ase.doc-pixel", pick(d1!.celAt(0, 0), 4, 1, 2), [10, 20, 30, 255]);
  eq("ase.doc-pixel-offset", pick(d1!.celAt(1, 1), 4, 2, 1), [200, 100, 50, 255]);
  eq("ase.doc-pixel-empty", pick(d1!.celAt(0, 0), 4, 0, 0), [0, 0, 0, 0]);

  // indexed sprite: palette lookup + transparency by palette index
  const indexed = buildAse({
    w: 2,
    h: 1,
    bpp: 8,
    transparentIndex: 0,
    palette: [[9, 9, 9, 255], [255, 0, 0, 255], [0, 255, 0, 128]],
    layers: [{ name: "L" }],
    frames: [{ durationMs: 100, cels: [{ li: 0, px: [0, 2] }] }],
  });
  const idxDoc = aseToDoc(parseAse(indexed)!);
  eq("ase.indexed-transparent", pick(idxDoc!.celAt(0, 0), 2, 0, 0), [0, 0, 0, 0]);
  eq("ase.indexed-color", pick(idxDoc!.celAt(0, 0), 2, 1, 0), [0, 255, 0, 128]);
  eq("ase.indexed-palette", idxDoc?.palette.length, 3);

  // grayscale: value byte + alpha byte
  const gray = buildAse({
    w: 2,
    h: 1,
    bpp: 16,
    layers: [{ name: "G" }],
    frames: [{ durationMs: 100, cels: [{ li: 0, px: [64, 255, 200, 128] }] }],
  });
  const grayDoc = aseToDoc(parseAse(gray)!);
  eq("ase.gray-opaque", pick(grayDoc!.celAt(0, 0), 2, 0, 0), [64, 64, 64, 255]);
  eq("ase.gray-alpha", pick(grayDoc!.celAt(0, 0), 2, 1, 0), [200, 200, 200, 128]);

  // a cel that starts outside the sprite is clipped, not lost
  const offset = buildAse({
    w: 4,
    h: 4,
    layers: [{ name: "L" }],
    frames: [{ durationMs: 100, cels: [{ li: 0, x: -1, y: 1, w: 2, h: 1, px: dot(2, 1, 1, 0, [7, 8, 9, 255]) }] }],
  });
  const offDoc = aseToDoc(parseAse(offset)!);
  eq("ase.clip-inside", pick(offDoc!.celAt(0, 0), 4, 0, 1), [7, 8, 9, 255]);
  eq("ase.clip-outside", pick(offDoc!.celAt(0, 0), 4, 3, 1), [0, 0, 0, 0]);

  // linked cels (type 1) reuse the source frame's pixels
  const linked = buildAse({
    w: 2,
    h: 2,
    layers: [{ name: "L" }],
    frames: [
      { durationMs: 100, cels: [{ li: 0, x: 1, y: 1, w: 1, h: 1, px: dot(1, 1, 0, 0, [1, 2, 3, 255]) }] },
      { durationMs: 100, cels: [{ li: 0, link: 0 }] },
    ],
  });
  const linkDoc = aseToDoc(parseAse(linked)!);
  eq("ase.linked", pick(linkDoc!.celAt(0, 1), 2, 1, 1), [1, 2, 3, 255]);

  // an unknown chunk (user data) must be skipped by its size
  const withExtra = buildAse({
    w: 1,
    h: 1,
    layers: [{ name: "L" }],
    frames: [{ durationMs: 100, cels: [{ li: 0, px: dot(1, 1, 0, 0, [5, 5, 5, 255]) }] }],
    extra: (b) => chunk(b, 0x2020, (x) => { x.u32(1); x.str("hello"); }), // user data: text
  });
  const extraDoc = aseToDoc(parseAse(withExtra)!);
  eq("ase.unknown-chunk-skipped", pick(extraDoc!.celAt(0, 0), 1, 0, 0), [5, 5, 5, 255]);

  // old FLI color chunk (0x0004) is used when there is no 0x2019 palette
  const oldPal = new Buf();
  oldPal.u16(1); // one packet
  oldPal.u8(0); // skip 0
  oldPal.u8(2); // two colors
  oldPal.raw([10, 20, 30, 40, 50, 60]);
  const oldPalFile = buildAse({
    w: 2,
    h: 1,
    bpp: 8,
    transparentIndex: 9, // no entry matches, so both pixels are opaque
    layers: [{ name: "L" }],
    frames: [{ durationMs: 100, cels: [{ li: 0, px: [0, 1] }] }],
    extra: (b) => {
      b.u32(6 + oldPal.len);
      b.u16(0x0004);
      b.raw(oldPal.bytes());
    },
  });
  const oldDoc = aseToDoc(parseAse(oldPalFile)!);
  eq("ase.old-palette", [pick(oldDoc!.celAt(0, 0), 2, 0, 0), pick(oldDoc!.celAt(0, 0), 2, 1, 0)],
    [[10, 20, 30, 255], [40, 50, 60, 255]]);

  // tags are parsed (PixelCraft has no tag UI yet, but the data must survive
  // the parse) and a group layer is flattened away
  const tagged = buildAse({
    w: 1,
    h: 1,
    layers: [{ name: "Group", flags: 1, type: 1 }, { name: "Inner" }],
    frames: [{ durationMs: 100, cels: [{ li: 1, px: dot(1, 1, 0, 0, [3, 3, 3, 255]) }] }],
    extra: (b) => chunk(b, 0x2018, (x) => {
      x.u16(1);
      x.pad(8);
      x.u16(0);
      x.u16(0);
      x.u8(0);
      x.u16(0);
      x.pad(6 + 3 + 1);
      x.str("walk");
    }),
  });
  const tagFile = parseAse(tagged)!;
  eq("ase.tags", tagFile.tags.map((t) => [t.name, t.from, t.to]), [["walk", 0, 0]]);
  const tagDoc = aseToDoc(tagFile)!;
  eq("ase.group-flattened", tagDoc.layers.map((l) => l.name), ["Inner"]);
  eq("ase.group-cel-remap", pick(tagDoc.celAt(0, 0), 1, 0, 0), [3, 3, 3, 255]);

  // corrupt / unsupported input never throws
  eq("ase.reject-garbage", readAseDoc(new Uint8Array([1, 2, 3, 4, 5, 6])).ok, false);
  eq("ase.reject-truncated", readAseDoc(basic.subarray(0, 40)).ok, false);
  const badDepth = basic.slice();
  badDepth[12] = 24; // 24 bpp is not part of the format
  badDepth[13] = 0;
  eq("ase.reject-depth", parseAse(badDepth), null);
  const huge = buildAse({ w: 2000, h: 8, frames: [{ durationMs: 100, cels: [] }] });
  const hugeRes = readAseDoc(huge);
  eq("ase.too-big", [hugeRes.ok, hugeRes.reason], [false, "aseTooBig"]);
  // a cel header claiming a gigantic payload must not allocate it
  const fatCel = basic.slice();
  {
    // frame 0 starts at 128; walk to the first cel chunk and blow up its size
    const dv = new DataView(fatCel.buffer, fatCel.byteOffset, fatCel.byteLength);
    let p = 128 + 16;
    while (p < fatCel.length) {
      const size = dv.getUint32(p, true);
      if (dv.getUint16(p + 4, true) === 0x2005) {
        dv.setUint16(p + 22, 0xffff, true); // cel width
        dv.setUint16(p + 24, 0xffff, true); // cel height
        break;
      }
      p += size;
    }
    eq("ase.cel-size-guard", parseAse(fatCel), null);
  }

  // ---------------- zlib: a hand-written stored block ----------------
  // header 78 01, BFINAL+stored, LEN=5 NLEN=0xfffa, "1 2 3 4 5", adler32
  const stored = new Uint8Array([0x78, 0x01, 0x01, 0x05, 0x00, 0xfa, 0xff, 1, 2, 3, 4, 5, 0x00, 0x28, 0x00, 0x10]);
  eq("zlib.stored-block", Array.from(inflateZlib(stored, 5) ?? []), [1, 2, 3, 4, 5]);
  eq("zlib.wrong-size", inflateZlib(stored, 6), null);
  eq("zlib.bad-header", inflateZlib(new Uint8Array([0x00, 0x00, 0x00]), 1), null);

  // ---------------- writer + round trip ----------------
  const doc = new Doc(8, 6, "rt");
  doc.layers = [
    { id: "a", name: "底", visible: true, opacity: 100, blend: "normal", locked: false },
    { id: "b", name: "Shade", visible: false, opacity: 50, blend: "multiply", locked: true },
  ];
  doc.frames = [{ id: "f1", durationMs: 120 }, { id: "f2", durationMs: 250 }];
  doc.palette = [[255, 0, 0, 255], [0, 255, 0, 128], [0, 0, 255, 255]];
  doc.ensureCel(0, 0).setPixel(1, 1, [255, 0, 0, 255]);
  doc.ensureCel(0, 0).setPixel(2, 1, [0, 255, 0, 255]);
  doc.ensureCel(1, 1).setPixel(7, 5, [0, 0, 255, 255]);

  for (const compress of [true, false]) {
    const bytes = await writeAse(doc, { compress });
    const tag = compress ? "compressed" : "raw";
    ok("ase.write." + tag, isAseBytes(bytes) && bytes.length > 128);
    const back = parseAse(bytes);
    ok("ase.write." + tag + ".parse", !!back);
    eq("ase.write." + tag + ".size", [back?.w, back?.h, back?.bpp], [8, 6, 32]);
    eq("ase.write." + tag + ".frames", back?.frames.map((f) => f.durationMs), [120, 250]);
    eq("ase.write." + tag + ".layer-names", back?.layers.map((l) => l.name), ["底", "Shade"]);
    eq("ase.write." + tag + ".layer-meta", [
      back?.layers[0].visible, back?.layers[0].opacity,
      back?.layers[1].visible, back?.layers[1].editable, back?.layers[1].opacity, back?.layers[1].blend,
    ], [true, 255, false, false, 128, 1]);
    eq("ase.write." + tag + ".palette", back?.palette, doc.palette);

    const doc2 = aseToDoc(back!)!;
    eq("ase.write." + tag + ".pixels", [
      pick(doc2.celAt(0, 0), 8, 1, 1), pick(doc2.celAt(0, 0), 8, 2, 1),
      pick(doc2.celAt(1, 1), 8, 7, 5), pick(doc2.celAt(1, 1), 8, 0, 0),
    ], [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [0, 0, 0, 0]]);
    // cels are cropped to their content (that is what Aseprite does too)
    eq("ase.write." + tag + ".crop", [back?.cels[0].x, back?.cels[0].y, back?.cels[0].w, back?.cels[0].h], [1, 1, 2, 1]);
  }

  // compression must actually shrink a flat sprite and stay readable
  const flat = new Doc(64, 64, "flat");
  const fc = flat.ensureCel(0, 0);
  for (let i = 0; i < 64 * 64; i++) {
    fc.data[i * 4] = 200;
    fc.data[i * 4 + 3] = 255;
  }
  const flatBytes = await writeAse(flat);
  const flatBack = aseToDoc(parseAse(flatBytes)!)!;
  eq("ase.write.flat-pixel", pick(flatBack.celAt(0, 0), 64, 63, 63), [200, 0, 0, 255]);
  if (canDeflate()) {
    ok("ase.write.compressed-small", flatBytes.length < 64 * 64 * 4 / 10, "bytes=" + flatBytes.length);
    ok("ase.write.compressed-type", parseAse(flatBytes)?.cels[0].w === 64);
  } else {
    ok("ase.write.compressed-small", true, "platform has no CompressionStream");
  }

  // an opaque document backdrop becomes a real Background layer, so the
  // exported file looks like the canvas did
  const bgDoc = new Doc(4, 4, "bg");
  bgDoc.bg = [10, 20, 30, 255];
  const bgBack = parseAse(await writeAse(bgDoc))!;
  eq("ase.write.bg-layer", bgBack.layers.map((l) => [l.name, l.background]), [["Background", true], ["Layer 1", false]]);
  const bgDoc2 = aseToDoc(bgBack)!;
  eq("ase.write.bg-pixels", pick(bgDoc2.celAt(0, 0), 4, 3, 3), [10, 20, 30, 255]);

  // empty documents and single-pixel documents survive
  const empty = new Doc(1, 1, "e");
  const emptyBack = parseAse(await writeAse(empty))!;
  eq("ase.write.empty", [emptyBack.w, emptyBack.h, emptyBack.cels.length], [1, 1, 0]);
  const onePx = new Doc(1, 1, "p");
  onePx.ensureCel(0, 0).setPixel(0, 0, [1, 2, 3, 4]);
  eq("ase.write.one-pixel", pick(aseToDoc(parseAse(await writeAse(onePx))!)!.celAt(0, 0), 1, 0, 0), [1, 2, 3, 4]);

  // readAseDoc names the document after the file
  const named = readAseDoc(basic, "hero.aseprite");
  eq("ase.doc-name", named.doc?.name, "hero");
}
