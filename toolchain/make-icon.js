// Generates the launcher / PWA icons (pixel-art quadrant palette motif) as PNGs.
//
//   node make-icon.js <outdir>          Android launcher icons (mipmap-* 48…192)
//   node make-icon.js --pwa <outdir>    PWA / manifest icons (icon-192, icon-512)
//
// The --pwa sizes must match manifest.webmanifest, otherwise Chrome logs
// "Resource size is not correct - typo in the Manifest?" and drops the icon.
const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "ascii");
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function writePng(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Palette: quadrant colors with border frame
const C = [0x3a, 0xd6, 0xe8, 255]; // cyan
const R = [0xf2, 0x4a, 0x5e, 255]; // red/pink
const Y = [0xf2, 0xd4, 0x2c, 255]; // yellow
const M = [0xa8, 0x5a, 0xf0, 255]; // violet
const G = [0xe8, 0x8b, 0x2c, 255]; // orange
const B = [0x1d, 0x1e, 0x26, 255]; // bg/frame dark
const W = [0xff, 0xff, 0xff, 255];
const L = [0x4a, 0x4d, 0x5c, 255]; // grid line

// 16x16 design
function design16() {
  const px = new Array(16 * 16).fill(null).map(() => B);
  // inner area from (2..13)
  const colorOf = (x, y) => {
    // quadrant 4x4 arrangement with 1px grid
    const gx = Math.floor((x - 2) / 3), gy = Math.floor((y - 2) / 3); // 4 blocks of 3px within 12px? 12/3=4
    const inx = (x - 2) % 3, iny = (y - 2) % 3;
    if (x < 2 || x > 13 || y < 2 || y > 13) return B;
    const gridLine = inx === 0 || iny === 0;
    const idx = gy * 4 + gx;
    let col = idx % 2 === 0 ? C : R;
    // custom pattern:
    const pat = [C, Y, M, G, R, C, G, M, M, G, C, Y, G, M, Y, C];
    col = pat[idx];
    if (gridLine) return L;
    return col;
  };
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px[y * 16 + x] = colorOf(x, y);
  // white sparkle at top-left corner block
  px[2 * 16 + 3] = W; px[3 * 16 + 2] = W; px[3 * 16 + 3] = W;
  return px;
}

function scale16toN(px16, n) {
  const out = Buffer.alloc(n * n * 4);
  const f = n / 16;
  for (let y = 0; y < n; y++) {
    const sy = Math.min(15, Math.floor(y / f));
    for (let x = 0; x < n; x++) {
      const sx = Math.min(15, Math.floor(x / f));
      const src = px16[sy * 16 + sx];
      const o = (y * n + x) * 4;
      out[o] = src[0]; out[o + 1] = src[1]; out[o + 2] = src[2]; out[o + 3] = src[3];
    }
  }
  return out;
}

const art = design16();
const args = process.argv.slice(2);
const pwaIdx = args.indexOf("--pwa");

if (pwaIdx >= 0) {
  // PWA icons: exactly the sizes manifest.webmanifest declares
  const dir = args[pwaIdx + 1] || ".";
  fs.mkdirSync(dir, { recursive: true });
  for (const n of [192, 512]) {
    const file = path.join(dir, "icon-" + n + ".png");
    fs.writeFileSync(file, writePng(n, n, scale16toN(art, n)));
    console.log("wrote", file, n + "x" + n);
  }
} else {
  const outdir = args[0] || ".";
  const sizes = { "mipmap-mdpi": 48, "mipmap-hdpi": 72, "mipmap-xhdpi": 96, "mipmap-xxhdpi": 144, "mipmap-xxxhdpi": 192 };
  for (const [d, n] of Object.entries(sizes)) {
    const dir = path.join(outdir, d);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "ic_launcher.png"), writePng(n, n, scale16toN(art, n)));
    console.log("wrote", path.join(dir, "ic_launcher.png"), n + "x" + n);
  }
}
