// Minimal zlib/DEFLATE codec used by the Aseprite reader and writer.
//
// Every .aseprite cel is a zlib stream (RFC1950 wrapping RFC1951). The browser
// offers DecompressionStream, but it is missing in older Android WebViews and
// would force the whole import to become asynchronous, so the reader carries
// its own small synchronous inflater (~200 lines, no dependencies). Writing
// uses CompressionStream when the platform has it and falls back to
// uncompressed ("raw") cels, which the format allows.
//
// Huffman handling follows the classic puff.c approach: count code lengths,
// derive the canonical offsets, then decode bit by bit.

/** RFC1951 length codes: base value + extra bits */
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
/** RFC1951 distance codes: base value + extra bits */
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
/** order in which the code-length code lengths are stored */
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

class BitReader {
  private buf = 0;
  private cnt = 0;
  private p = 0;
  bad = false;

  constructor(private readonly src: Uint8Array) {}

  private fill(n: number): void {
    while (this.cnt < n && this.p < this.src.length) {
      this.buf |= this.src[this.p++] << this.cnt;
      this.cnt += 8;
    }
  }

  /** read `n` (≤ 16) bits, LSB first */
  bits(n: number): number {
    if (n === 0) return 0;
    this.fill(n);
    if (this.cnt < n) {
      this.bad = true;
      return 0;
    }
    const v = this.buf & ((1 << n) - 1);
    this.buf >>>= n;
    this.cnt -= n;
    return v;
  }

  /** drop the remaining bits of the current byte (stored blocks) */
  align(): void {
    const drop = this.cnt & 7;
    this.buf >>>= drop;
    this.cnt -= drop;
  }

  byte(): number {
    if (this.cnt >= 8) {
      const v = this.buf & 255;
      this.buf >>>= 8;
      this.cnt -= 8;
      return v;
    }
    if (this.p >= this.src.length) {
      this.bad = true;
      return 0;
    }
    return this.src[this.p++];
  }
}

interface Huffman {
  /** how many codes have each bit length (index 0 is unused) */
  counts: Int32Array;
  /** symbols ordered by (length, symbol) */
  symbols: Int32Array;
}

/** canonical Huffman table from a list of code lengths (null = invalid) */
function huffmanFromLengths(lengths: Uint8Array, n: number): Huffman | null {
  const counts = new Int32Array(16);
  for (let i = 0; i < n; i++) counts[lengths[i]]++;
  // an empty table is legal (a block with no matches may carry a distance
  // table with no symbols): decoding any symbol from it fails, which is what
  // we want — treat it as a table that simply never matches.
  if (counts[0] === n) return { counts, symbols: new Int32Array(0) };
  counts[0] = 0;
  // reject over-subscribed codes
  let left = 1;
  for (let len = 1; len <= 15; len++) {
    left = (left << 1) - counts[len];
    if (left < 0) return null;
  }
  const offs = new Int32Array(16);
  for (let len = 1; len < 15; len++) offs[len + 1] = offs[len] + counts[len];
  const symbols = new Int32Array(n);
  for (let i = 0; i < n; i++) if (lengths[i]) symbols[offs[lengths[i]]++] = i;
  return { counts, symbols };
}

/** one symbol from the bit stream (-1 = corrupt) */
function decodeSymbol(br: BitReader, h: Huffman): number {
  let code = 0;
  let first = 0;
  let index = 0;
  for (let len = 1; len <= 15; len++) {
    code |= br.bits(1);
    const count = h.counts[len];
    if (code - count < first) return h.symbols[index + (code - first)];
    index += count;
    first = (first + count) << 1;
    code <<= 1;
  }
  return -1;
}

let fixedLit: Huffman | null = null;
let fixedDist: Huffman | null = null;

/** the two fixed tables of RFC1951 (built once) */
function fixedTables(): { lit: Huffman; dist: Huffman } | null {
  if (!fixedLit || !fixedDist) {
    const lit = new Uint8Array(288);
    for (let i = 0; i < 144; i++) lit[i] = 8;
    for (let i = 144; i < 256; i++) lit[i] = 9;
    for (let i = 256; i < 280; i++) lit[i] = 7;
    for (let i = 280; i < 288; i++) lit[i] = 8;
    const dist = new Uint8Array(30);
    for (let i = 0; i < 30; i++) dist[i] = 5;
    fixedLit = huffmanFromLengths(lit, 288);
    fixedDist = huffmanFromLengths(dist, 30);
  }
  return fixedLit && fixedDist ? { lit: fixedLit, dist: fixedDist } : null;
}

/** inflate one DEFLATE stream into `out`; returns the byte count or -1 */
function inflateRaw(br: BitReader, out: Uint8Array): number {
  let pos = 0;
  for (;;) {
    const last = br.bits(1);
    const type = br.bits(2);
    if (br.bad) return -1;
    if (type === 0) {
      // stored block
      br.align();
      const len = br.byte() | (br.byte() << 8);
      const nlen = br.byte() | (br.byte() << 8);
      if (br.bad || (len ^ 0xffff) !== nlen || pos + len > out.length) return -1;
      for (let i = 0; i < len; i++) out[pos++] = br.byte();
      if (br.bad) return -1;
    } else if (type === 1 || type === 2) {
      let lit: Huffman;
      let dist: Huffman;
      if (type === 1) {
        const t = fixedTables();
        if (!t) return -1;
        lit = t.lit;
        dist = t.dist;
      } else {
        const hlit = br.bits(5) + 257;
        const hdist = br.bits(5) + 1;
        const hclen = br.bits(4) + 4;
        if (br.bad) return -1;
        const clen = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) clen[CLEN_ORDER[i]] = br.bits(3);
        const clh = huffmanFromLengths(clen, 19);
        if (!clh || br.bad) return -1;
        const lengths = new Uint8Array(hlit + hdist);
        let i = 0;
        while (i < lengths.length) {
          const sym = decodeSymbol(br, clh);
          if (sym < 0 || br.bad) return -1;
          if (sym < 16) lengths[i++] = sym;
          else {
            let len = 0;
            let rep: number;
            if (sym === 16) {
              if (i === 0) return -1;
              len = lengths[i - 1];
              rep = 3 + br.bits(2);
            } else if (sym === 17) {
              rep = 3 + br.bits(3);
            } else {
              rep = 11 + br.bits(7);
            }
            if (i + rep > lengths.length) return -1;
            while (rep-- > 0) lengths[i++] = len;
          }
        }
        const l = huffmanFromLengths(lengths.subarray(0, hlit), hlit);
        const d = huffmanFromLengths(lengths.subarray(hlit), hdist);
        if (!l || !d) return -1;
        lit = l;
        dist = d;
      }
      for (;;) {
        const sym = decodeSymbol(br, lit);
        if (sym < 0 || br.bad) return -1;
        if (sym < 256) {
          if (pos >= out.length) return -1;
          out[pos++] = sym;
          continue;
        }
        if (sym === 256) break;
        const li = sym - 257;
        if (li >= LEN_BASE.length) return -1;
        const len = LEN_BASE[li] + br.bits(LEN_EXTRA[li]);
        const dsym = decodeSymbol(br, dist);
        if (dsym < 0 || dsym >= DIST_BASE.length || br.bad) return -1;
        const back = DIST_BASE[dsym] + br.bits(DIST_EXTRA[dsym]);
        if (back > pos || pos + len > out.length) return -1;
        for (let i = 0; i < len; i++, pos++) out[pos] = out[pos - back];
      }
    } else {
      return -1; // reserved block type
    }
    if (last) break;
    if (br.bad) return -1;
  }
  return pos;
}

/**
 * Inflate a zlib stream into exactly `outSize` bytes.
 * Returns null when the stream is corrupt or does not decode to that size
 * (a short stream would silently leave transparent pixels behind).
 */
export function inflateZlib(src: Uint8Array, outSize: number): Uint8Array | null {
  if (src.length < 3) return null;
  const cmf = src[0];
  const flg = src[1];
  if ((cmf & 0x0f) !== 8) return null; // only the deflate method
  if (((cmf << 8) | flg) % 31 !== 0) return null; // header check bits
  const out = new Uint8Array(outSize);
  const br = new BitReader(src.subarray(2));
  const n = inflateRaw(br, out);
  if (n !== outSize || br.bad) return null;
  return out;
}

interface CompressionStreamCtor {
  new (format: string): { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
}

/** true when the platform can DEFLATE (Chrome 80+/Node 18+ WebView builds) */
export function canDeflate(): boolean {
  return typeof (globalThis as { CompressionStream?: unknown }).CompressionStream === "function";
}

/** zlib-compress `src`; null when the platform has no CompressionStream */
export async function deflateZlib(src: Uint8Array): Promise<Uint8Array | null> {
  const CS = (globalThis as { CompressionStream?: CompressionStreamCtor }).CompressionStream;
  if (!CS) return null;
  try {
    const stream = new Blob([src as BlobPart]).stream().pipeThrough(new CS("deflate"));
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}
