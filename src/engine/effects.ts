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

/** Chebyshev depth of every opaque pixel: distance to the nearest transparent
 *  pixel, with everything outside the canvas counting as transparent (so a
 *  sprite that fills the whole cel still has an outer ring, exactly like
 *  `outlineCel` treats it). 0 = the pixel itself is transparent, 1 = the
 *  silhouette's outer ring. 8-neighbour BFS. */
function edgeDepth(opaque: Uint8Array, w: number, h: number): Int32Array {
  const n = w * h;
  const dist = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!opaque[i]) {
        dist[i] = 0;                     // transparent pixels seed the wave
        queue[tail++] = i;
      } else if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
        dist[i] = 1;                     // the cel border is a silhouette edge
        queue[tail++] = i;
      }
    }
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % w, y = (i - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (dist[j] !== -1) continue;
        dist[j] = dist[i] + 1;
        queue[tail++] = j;
      }
    }
  }
  // pixels the wave never reached are opaque but walled in by opaque pixels;
  // they sit deeper than any painted band, so a large value is correct
  for (let i = 0; i < n; i++) if (dist[i] === -1) dist[i] = 1 << 20;
  return dist;
}

/** Inner line (Aseprite/PixelOver "inline"): keeps the silhouette's OUTER ring
 *  untouched and paints the next `width` rings inside it with `color`.
 *  `alpha` (0..255) blends the line with the pixel underneath, so a 50% line
 *  tints the artwork instead of replacing it; the pixel's own alpha is kept, so
 *  semi-transparent sprites stay semi-transparent. Needs a transparent
 *  background — a fully opaque canvas has no silhouette to trace. */
export function inlineCel(d: Uint8ClampedArray, w: number, h: number, width: number, color: RGBA, alpha = 255): void {
  const band = Math.round(width);
  if (w <= 0 || h <= 0 || band < 1) return;
  const n = w * h;
  const opaque = new Uint8Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    if (d[i * 4 + 3] > 0) { opaque[i] = 1; any = true; }
  }
  if (!any) return;
  const a = Math.max(0, Math.min(255, Math.round(alpha))) / 255;
  if (a <= 0) return;
  const depth = edgeDepth(opaque, w, h);
  const keep = 1 - a;
  for (let i = 0; i < n; i++) {
    if (!opaque[i]) continue;
    if (depth[i] < 2 || depth[i] > band + 1) continue;   // outer ring stays as it is
    const p = i * 4;
    d[p] = Math.round(d[p] * keep + color[0] * a);
    d[p + 1] = Math.round(d[p + 1] * keep + color[1] * a);
    d[p + 2] = Math.round(d[p + 2] * keep + color[2] * a);
    // the destination alpha is deliberately untouched
  }
}

/** 圆角化的两种方向：只削外直角，或者连内凹角（含 1px 洞）一起补 */
export type RoundMode = "outer" | "both";

/** count of opaque 8-neighbours around `i` (out of canvas = transparent) */
function opaqueNeighbours(opaque: Uint8Array, w: number, h: number, i: number): number {
  const x = i % w, y = (i - x) / w;
  let n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (opaque[ny * w + nx]) n++;
    }
  }
  return n;
}

/** 3x3 里四个对角象限，各自「三格全不透明」的个数。硬直角（外凸拐角）恰好只有
 *  1 个象限全满；直边是 2 个；1px 细线/斜线/折角是 0 个 —— 这就是「只削拐角、
 *  不啃边、不吃细线」的判据。画布外一律算透明。 */
function fullQuadrants(opaque: Uint8Array, w: number, h: number, i: number): number {
  const x = i % w, y = (i - x) / w;
  const at = (dx: number, dy: number): boolean => {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) return false;
    return opaque[ny * w + nx] === 1;
  };
  let n = 0;
  if (at(1, 0) && at(0, -1) && at(1, -1)) n++;   // NE
  if (at(1, 0) && at(0, 1) && at(1, 1)) n++;     // SE
  if (at(-1, 0) && at(0, 1) && at(-1, 1)) n++;   // SW
  if (at(-1, 0) && at(0, -1) && at(-1, -1)) n++; // NW
  return n;
}

/** do the remaining opaque 8-neighbours of `i` stay connected without it?
 *  (walk the 3x3 island that contains the first one) */
function neighboursConnected(opaque: Uint8Array, w: number, h: number, i: number): boolean {
  const x = i % w, y = (i - x) / w;
  const list: number[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (opaque[ny * w + nx]) list.push(ny * w + nx);
    }
  }
  if (list.length < 2) return true;
  const seen = new Set<number>([list[0]]);
  const stack = [list[0]];
  while (stack.length) {
    const q = stack.pop() as number;
    for (const r of list) {
      if (seen.has(r)) continue;
      const qx = q % w, qy = (q - qx) / w;
      const rx = r % w, ry = (r - rx) / w;
      if (Math.abs(qx - rx) > 1 || Math.abs(qy - ry) > 1) continue;
      seen.add(r); stack.push(r);
    }
  }
  return seen.size === list.length;
}

/**
 * 圆角化：把轮廓上的硬直角削成圆角（`radius` = 削几层，1..8）。
 *
 * 逐层进行：每一层重新算深度图（到背景的 Chebyshev 距离，见 `edgeDepth`），
 * 只删「当前最外圈（深度 = 1）+ 至少 3 个不透明邻居 + 删掉后邻居仍连通」的像素。
 * 这三条守卫是刻意的：1px 细线/斜线/折角的像素只有 2 个邻居，因此**永远不会被削掉**；
 * 而「整幅最厚处还没超过 radius」时直接跳过，避免把 2~3px 粗的细条啃没。
 * `mode = "both"` 时额外把被 ≥6 个不透明像素包住的透明像素填上（补内凹角与 1px 洞）。
 */
export function roundCornersCel(d: Uint8ClampedArray, w: number, h: number, radius: number, mode: RoundMode = "outer"): void {
  const r = Math.round(radius);
  if (w <= 0 || h <= 0 || r < 1) return;
  const n = w * h;
  const mask = new Uint8Array(n);
  let any = false;
  for (let i = 0; i < n; i++) if (d[i * 4 + 3] > 0) { mask[i] = 1; any = true; }
  if (!any) return;

  const deepest = (): number => {
    const depth = edgeDepth(mask, w, h);
    let mx = 0;
    for (let i = 0; i < n; i++) if (mask[i] && depth[i] > mx && depth[i] < (1 << 20)) mx = depth[i];
    return mx;
  };
  // 太细了：任何一层都会把形状啃变形，直接不动
  if (deepest() <= r) return;

  const clear = (i: number): void => {
    const p = i * 4;
    d[p] = 0; d[p + 1] = 0; d[p + 2] = 0; d[p + 3] = 0;
    mask[i] = 0;
  };

  for (let pass = 0; pass < r; pass++) {
    const depth = edgeDepth(mask, w, h);
    const cut: number[] = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!mask[i] || depth[i] !== 1) continue;             // 只看最外圈
        if (fullQuadrants(mask, w, h, i) !== 1) continue;     // 只有硬直角才削（直边/细线/斜线都不动）
        if (opaqueNeighbours(mask, w, h, i) < 3) continue;    // 双保险
        if (!neighboursConnected(mask, w, h, i)) continue;    // 删了会断开：保住
        cut.push(i);
      }
    }
    // 一趟 = 一层：同一趟内一起删，连锁反应留到下一趟（radius 才等于层数）
    for (const i of cut) clear(i);
    if (!cut.length) break;
  }

  if (mode === "both") {
    // 补内凹角 / 1px 洞：被 ≥6 个不透明像素包住的透明像素，用周围出现最多的那个颜色填上
    const fill: number[] = [];
    for (let i = 0; i < n; i++) if (!mask[i] && opaqueNeighbours(mask, w, h, i) >= 6) fill.push(i);
    for (const i of fill) {
      const x = i % w, y = (i - x) / w;
      const tally = new Map<string, { count: number; at: number }>();
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (!mask[j]) continue;
          const key = d[j * 4] + "," + d[j * 4 + 1] + "," + d[j * 4 + 2] + "," + d[j * 4 + 3];
          const cur = tally.get(key);
          if (cur) cur.count++;
          else tally.set(key, { count: 1, at: j });
        }
      }
      let best = -1, bestCount = 0;
      for (const v of tally.values()) if (v.count > bestCount) { bestCount = v.count; best = v.at; }
      if (best < 0) continue;
      const p = i * 4, q = best * 4;
      d[p] = d[q]; d[p + 1] = d[q + 1]; d[p + 2] = d[q + 2]; d[p + 3] = d[q + 3];
      mask[i] = 1;
    }
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
