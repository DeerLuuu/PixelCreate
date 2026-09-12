// 自由变换：斜切 / 透视（四点）与网格变形（3x3）。
//
// 目的：把浮动选区的像素按「四角任意拖」或「网格点任意拖」变形后重新栅格化。
// 纯函数、无 DOM：给一块源像素 + 目标尺寸，返回新的像素（RGBA）。
//
// 采样一律**最近邻**（像素画不能被插值糊掉）；映射一律走「目标 → 源」的**逆向**映射，
// 所以拉伸时不会出现空洞。四点用单应（homography），网格把每个格子拆成两个三角形，
// 每个三角形用仿射逆变换——够快、无洞、像素画里看不出区别。
import type { RGBA } from "../engine/types";

export interface Pt { x: number; y: number }

/** 3x3 矩阵，行主序（仿射 / 单应共用） */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

/** 从「源四点 → 目标四点」解出单应矩阵（解 8x8 线性方程组）。
 *  退化（有三点共线等）时返回 null。 */
export function homography(src: Pt[], dst: Pt[]): Mat3 | null {
  if (src.length !== 4 || dst.length !== 4) return null;
  // 8 个未知量 h11..h32（h33 = 1），8 条方程
  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const s = src[i], d = dst[i];
    a.push([s.x, s.y, 1, 0, 0, 0, -d.x * s.x, -d.x * s.y]);
    b.push(d.x);
    a.push([0, 0, 0, s.x, s.y, 1, -d.y * s.x, -d.y * s.y]);
    b.push(d.y);
  }
  const h = solve(a, b);
  if (!h) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/** 高斯消元（带部分主元），奇异返回 null */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
    if (Math.abs(m[piv][c]) < 1e-9) return null;
    if (piv !== c) { const t = m[piv]; m[piv] = m[c]; m[c] = t; }
    const d = m[c][c];
    for (let k = c; k <= n; k++) m[c][k] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }
  return m.map((row) => row[n]);
}

/** 用矩阵把点从目标坐标映回源坐标（含透视除法） */
export function applyMat(m: Mat3, p: Pt): Pt {
  const w = m[6] * p.x + m[7] * p.y + m[8];
  if (Math.abs(w) < 1e-9) return { x: NaN, y: NaN };
  return {
    x: (m[0] * p.x + m[1] * p.y + m[2]) / w,
    y: (m[3] * p.x + m[4] * p.y + m[5]) / w,
  };
}

/** 面积是否退化（四个目标点挤成一条线之类） */
export function quadArea(q: Pt[]): number {
  let s = 0;
  for (let i = 0; i < q.length; i++) {
    const a = q[i], b = q[(i + 1) % q.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/** 一块 RGBA 像素（源） */
export interface Pixmap { w: number; h: number; data: Uint8ClampedArray }

function sampleNearest(src: Pixmap, x: number, y: number, out: Uint8ClampedArray, o: number): void {
  const ix = Math.round(x), iy = Math.round(y);
  if (ix < 0 || iy < 0 || ix >= src.w || iy >= src.h) return;   // 画面外：保持透明
  const p = (iy * src.w + ix) * 4;
  out[o] = src.data[p]; out[o + 1] = src.data[p + 1]; out[o + 2] = src.data[p + 2]; out[o + 3] = src.data[p + 3];
}

/**
 * 四点自由变换（斜切 / 透视）：`quad` 是目标四边形（左上、右上、右下、左下，顺序固定），
 * `srcQuad` 默认是源图的四个角。返回 `outW × outH` 的新像素。
 */
export function warpQuad(src: Pixmap, quad: Pt[], outW: number, outH: number, srcQuad?: Pt[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(Math.max(0, outW) * Math.max(0, outH) * 4);
  if (outW <= 0 || outH <= 0) return out;
  const s = srcQuad ?? [
    { x: 0, y: 0 }, { x: src.w - 1, y: 0 }, { x: src.w - 1, y: src.h - 1 }, { x: 0, y: src.h - 1 },
  ];
  if (quadArea(quad) < 0.5) return out;                       // 压成一条线：不画
  const m = homography(quad, s);                              // 目标 → 源
  if (!m) return out;
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const p = applyMat(m, { x, y });
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      sampleNearest(src, p.x, p.y, out, (y * outW + x) * 4);
    }
  }
  return out;
}

/**
 * 网格变形：`grid` 是 (n+1)×(n+1) 个控制点（行主序，左上 → 右下），n = `divs`（默认 2，
 * 即 3×3 个点）。每个格子拆成两个三角形做仿射逆映射，所以拉伸时不留洞。
 */
export function meshWarp(src: Pixmap, grid: Pt[], outW: number, outH: number, divs = 2): Uint8ClampedArray {
  const n = Math.max(1, Math.round(divs));
  const need = (n + 1) * (n + 1);
  const out = new Uint8ClampedArray(Math.max(0, outW) * Math.max(0, outH) * 4);
  if (outW <= 0 || outH <= 0 || grid.length < need) return out;
  const cellW = (src.w - 1) / n;
  const cellH = (src.h - 1) / n;
  const tri = (a: Pt, b: Pt, c: Pt, sa: Pt, sb: Pt, sc: Pt): void => {
    // 目标三角形 → 源三角形 的仿射逆映射
    const d = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
    if (Math.abs(d) < 1e-9) return;
    const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
    const maxX = Math.min(outW - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
    const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
    const maxY = Math.min(outH - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        // 重心坐标：点在三角形内才画
        const w0 = ((b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y)) / d;
        const w1 = ((x - a.x) * (c.y - a.y) - (c.x - a.x) * (y - a.y)) / d;
        const u = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || u < -1e-6) continue;
        const sx = u * sa.x + w1 * sb.x + w0 * sc.x;
        const sy = u * sa.y + w1 * sb.y + w0 * sc.y;
        sampleNearest(src, sx, sy, out, (y * outW + x) * 4);
      }
    }
  };
  for (let gy = 0; gy < n; gy++) {
    for (let gx = 0; gx < n; gx++) {
      const p00 = grid[gy * (n + 1) + gx];
      const p10 = grid[gy * (n + 1) + gx + 1];
      const p01 = grid[(gy + 1) * (n + 1) + gx];
      const p11 = grid[(gy + 1) * (n + 1) + gx + 1];
      const s00: Pt = { x: gx * cellW, y: gy * cellH };
      const s10: Pt = { x: (gx + 1) * cellW, y: gy * cellH };
      const s01: Pt = { x: gx * cellW, y: (gy + 1) * cellH };
      const s11: Pt = { x: (gx + 1) * cellW, y: (gy + 1) * cellH };
      tri(p00, p10, p11, s00, s10, s11);
      tri(p00, p11, p01, s00, s11, s01);
    }
  }
  return out;
}

/** 默认的 3x3 网格控制点（覆盖一整块 w×h 的矩形） */
export function defaultGrid(w: number, h: number, divs = 2): Pt[] {
  const n = Math.max(1, Math.round(divs));
  const out: Pt[] = [];
  for (let gy = 0; gy <= n; gy++) {
    for (let gx = 0; gx <= n; gx++) {
      out.push({ x: (w - 1) * (gx / n), y: (h - 1) * (gy / n) });
    }
  }
  return out;
}

/** 把 4 个角点从一个矩形变成任意四边形：常用的「上边斜切」等预设 */
export function skewQuad(w: number, h: number, kind: "x" | "y", amount: number): Pt[] {
  const t = amount;
  if (kind === "x") {
    return [{ x: t, y: 0 }, { x: w - 1 + t, y: 0 }, { x: w - 1 - t, y: h - 1 }, { x: -t, y: h - 1 }];
  }
  return [{ x: 0, y: t }, { x: w - 1, y: -t }, { x: w - 1, y: h - 1 + t }, { x: 0, y: h - 1 - t }];
}

/** 颜色数组工具（供 UI 预览用） */
export function pixmapFromCel(data: Uint8ClampedArray, w: number, h: number): Pixmap {
  return { w, h, data };
}

export type { RGBA };
