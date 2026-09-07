// Pixel "effects" helpers: outline, invert, desaturate … operate on one cel
// (whole layer×frame). They mutate the cel in place; callers wrap them in one
// history step via pushPixels so undo stays a single entry.
import type { Doc } from "./doc";
import type { RGBA } from "./types";

function hasAlpha(d: Uint8ClampedArray, w: number, p: number): boolean {
  return d[p + 3] > 0;
}

function pxAt(d: Uint8ClampedArray, w: number, h: number, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < w && y < h && hasAlpha(d, w, (y * w + x) * 4);
}

/** Add an outer outline of `width` px around every opaque pixel of the cel,
 * using the given RGBA colour. Painted only onto pixels that were transparent
 * before (opaque pixels keep their colour). */
export function outlineCel(d: Uint8ClampedArray, w: number, h: number, width: number, color: RGBA): void {
  if (w <= 0 || h <= 0 || width < 1) return;
  const opaque = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = (y * w + x) * 4;
    if (hasAlpha(d, w, p)) opaque[y * w + x] = 1;
  }
  const painted: boolean[] = new Array(w * h).fill(false);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const oi = y * w + x;
      if (!opaque[oi]) continue;
      // paint ring cells within Chebyshev distance `width` that are transparent
      for (let dy = -width; dy <= width; dy++) {
        for (let dx = -width; dx <= width; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (Math.max(Math.abs(dx), Math.abs(dy)) > width) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ti = ny * w + nx;
          if (opaque[ti] || painted[ti]) continue;
          painted[ti] = true;
          const p = ti * 4;
          d[p] = color[0]; d[p + 1] = color[1]; d[p + 2] = color[2]; d[p + 3] = color[3];
        }
      }
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

/** Apply fn() over the current active cel and record one undo step. */
export function runCelFx(
  doc: Doc, li: number, fi: number, fn: (d: Uint8ClampedArray, w: number, h: number) => void
): boolean {
  const cel = doc.celAt(li, fi);
  if (!cel) return false;
  const before = new Uint8ClampedArray(cel.data);
  fn(cel.data, cel.w, cel.h);
  const after = new Uint8ClampedArray(cel.data);
  let changed = false;
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) { changed = true; break; }
  return changed;
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
