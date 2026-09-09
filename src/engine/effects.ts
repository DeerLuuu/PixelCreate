// Pixel "effects" helpers: outline, invert, desaturate … operate on one cel
// (whole layer×frame). They mutate the cel in place; callers wrap them in one
// history step via pushPixels so undo stays a single entry.
import type { RGBA } from "./types";

function hasAlpha(d: Uint8ClampedArray, w: number, p: number): boolean {
  return d[p + 3] > 0;
}

/** where an outline is painted relative to the silhouette */
export type OutlinePos = "outside" | "inside" | "center";

/** Add an outline of `width` px around every opaque pixel of the cel, using the
 *  given RGBA colour. `pos` picks the side: outside (default) paints only onto
 *  pixels that were transparent before, inside recolours the silhouette's edge
 *  band, center splits the width over both sides. */
export function outlineCel(d: Uint8ClampedArray, w: number, h: number, width: number, color: RGBA, pos: OutlinePos = "outside"): void {
  if (w <= 0 || h <= 0 || width < 1) return;
  const opaque = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = (y * w + x) * 4;
    if (hasAlpha(d, w, p)) opaque[y * w + x] = 1;
  }
  const outW = pos === "inside" ? 0 : pos === "center" ? Math.ceil(width / 2) : width;
  const inW = pos === "outside" ? 0 : pos === "center" ? Math.floor(width / 2) : width;
  const paint = (ti: number) => {
    const p = ti * 4;
    d[p] = color[0]; d[p + 1] = color[1]; d[p + 2] = color[2]; d[p + 3] = color[3];
  };
  // outside band: transparent cells within Chebyshev distance outW of the shape
  if (outW > 0) {
    const painted: boolean[] = new Array(w * h).fill(false);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const oi = y * w + x;
        if (!opaque[oi]) continue;
        for (let dy = -outW; dy <= outW; dy++) {
          for (let dx = -outW; dx <= outW; dx++) {
            if (dx === 0 && dy === 0) continue;
            if (Math.max(Math.abs(dx), Math.abs(dy)) > outW) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const ti = ny * w + nx;
            if (opaque[ti] || painted[ti]) continue;
            painted[ti] = true;
            paint(ti);
          }
        }
      }
    }
  }
  // inside band: opaque cells within Chebyshev distance inW of a transparent cell
  if (inW > 0) {
    const edge = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const oi = y * w + x;
        if (!opaque[oi] || edge[oi]) continue;
        let near = false;
        for (let dy = -inW; dy <= inW && !near; dy++) {
          for (let dx = -inW; dx <= inW; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) > inW) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) { near = true; break; }
            if (!opaque[ny * w + nx]) { near = true; break; }
          }
        }
        if (near) edge[oi] = 1;
      }
    }
    for (let i = 0; i < w * h; i++) if (edge[i]) paint(i);
  }
}

/** Separable box blur, applied twice (a close, cheap approximation of a
 *  Gaussian). Alpha-premultiplied so transparent pixels never bleed their RGB
 *  into the result. `radius` is in pixels (1..N); 0 is a no-op. */
export function blurCel(d: Uint8ClampedArray, w: number, h: number, radius: number): void {
  const r = Math.round(radius);
  if (w <= 0 || h <= 0 || r < 1) return;
  const n = w * h;
  let src = new Float32Array(n * 4);
  let dst = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const a = d[i * 4 + 3] / 255;
    src[i * 4] = d[i * 4] * a;
    src[i * 4 + 1] = d[i * 4 + 1] * a;
    src[i * 4 + 2] = d[i * 4 + 2] * a;
    src[i * 4 + 3] = d[i * 4 + 3];
  }
  for (let pass = 0; pass < 2; pass++) {
    boxH(src, dst, w, h, r);
    boxV(dst, src, w, h, r);
  }
  for (let i = 0; i < n; i++) {
    const a = src[i * 4 + 3];
    const k = a > 0 ? 255 / a : 0;
    d[i * 4] = Math.round(src[i * 4] * k);
    d[i * 4 + 1] = Math.round(src[i * 4 + 1] * k);
    d[i * 4 + 2] = Math.round(src[i * 4 + 2] * k);
    d[i * 4 + 3] = Math.round(a);
  }
}

/** horizontal box pass with clamped edges (keeps the total mass constant) */
function boxH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const win = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
    for (let k = -r; k <= r; k++) {
      const x = k < 0 ? 0 : k >= w ? w - 1 : k;
      const i = (row + x) * 4;
      s0 += src[i]; s1 += src[i + 1]; s2 += src[i + 2]; s3 += src[i + 3];
    }
    for (let x = 0; x < w; x++) {
      const o = (row + x) * 4;
      dst[o] = s0 / win; dst[o + 1] = s1 / win; dst[o + 2] = s2 / win; dst[o + 3] = s3 / win;
      const xa = x - r < 0 ? 0 : x - r;
      const xb = x + r + 1 >= w ? w - 1 : x + r + 1;
      const ia = (row + xa) * 4, ib = (row + xb) * 4;
      s0 += src[ib] - src[ia]; s1 += src[ib + 1] - src[ia + 1];
      s2 += src[ib + 2] - src[ia + 2]; s3 += src[ib + 3] - src[ia + 3];
    }
  }
}

/** vertical box pass, same clamping */
function boxV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const win = 2 * r + 1;
  for (let x = 0; x < w; x++) {
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
    for (let k = -r; k <= r; k++) {
      const y = k < 0 ? 0 : k >= h ? h - 1 : k;
      const i = (y * w + x) * 4;
      s0 += src[i]; s1 += src[i + 1]; s2 += src[i + 2]; s3 += src[i + 3];
    }
    for (let y = 0; y < h; y++) {
      const o = (y * w + x) * 4;
      dst[o] = s0 / win; dst[o + 1] = s1 / win; dst[o + 2] = s2 / win; dst[o + 3] = s3 / win;
      const ya = y - r < 0 ? 0 : y - r;
      const yb = y + r + 1 >= h ? h - 1 : y + r + 1;
      const ia = (ya * w + x) * 4, ib = (yb * w + x) * 4;
      s0 += src[ib] - src[ia]; s1 += src[ib + 1] - src[ia + 1];
      s2 += src[ib + 2] - src[ia + 2]; s3 += src[ib + 3] - src[ia + 3];
    }
  }
}

/** Invert the RGB of every pixel that is not fully transparent (alpha kept). */
export function invertCel(d: Uint8ClampedArray): void {
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 0) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; }
  }
}

/** Desaturate every visible pixel to its luminance (alpha kept). */
export function desaturateCel(d: Uint8ClampedArray): void {
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 0) {
      const v = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
      d[i] = v; d[i + 1] = v; d[i + 2] = v;
    }
  }
}

/** One-tap drop shadow: silhouette offset (dx,dy) down-right, painted with
 * `color`, original pixels stay on top. Mutates in place. */
export function dropShadowCel(d: Uint8ClampedArray, w: number, h: number, dx: number, dy: number, color: RGBA, keepOriginal = true): void {
  if (w <= 0 || h <= 0) return;
  const src = new Uint8ClampedArray(d);
  d.fill(0);
  const put = (x: number, y: number, c: RGBA) => {
    const p = (y * w + x) * 4;
    d[p] = c[0]; d[p + 1] = c[1]; d[p + 2] = c[2]; d[p + 3] = c[3];
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      if (src[p + 3] === 0) continue;
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h) put(nx, ny, color);
    }
  }
  if (keepOriginal) {
    for (let i = 0; i < d.length; i++) d[i] = src[i] > 0 ? src[i] : d[i];
  }
}

/** One-tap outer glow: expands the silhouette by R px, each ring painted with
 * `color` at fading alpha; original pixels stay on top. */
export function outerGlowCel(d: Uint8ClampedArray, w: number, h: number, R: number, color: RGBA): void {
  if (w <= 0 || h <= 0 || R < 1) return;
  const src = new Uint8ClampedArray(d);
  const out = new Uint8ClampedArray(d.length);
  const isLit = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    const p = (y * w + x) * 4;
    return src[p + 3] > 0 || out[p + 3] > 0;
  };
  for (let ring = 1; ring <= R; ring++) {
    const a = Math.round((color[3] * (R - ring + 1)) / (R + 1));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4;
        if (src[p + 3] > 0 || out[p + 3] > 0) continue; // already lit/original
        const n = isLit(x - 1, y) || isLit(x + 1, y) || isLit(x, y - 1) || isLit(x, y + 1);
        if (n) {
          out[p] = color[0]; out[p + 1] = color[1]; out[p + 2] = color[2]; out[p + 3] = a;
        }
      }
    }
  }
  // glow below, original above
  for (let i = 0; i < d.length; i += 4) {
    if (src[i + 3] > 0) { out[i] = src[i]; out[i + 1] = src[i + 1]; out[i + 2] = src[i + 2]; out[i + 3] = src[i + 3]; }
  }
  d.set(out);
}
