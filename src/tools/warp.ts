// 自由变换：斜切 / 透视（四点）与网格变形（3x3）。
//
// 目的：把浮动选区的像素按「四角任意拖」或「网格点任意拖」变形后重新栅格化。
// 纯函数、无 DOM：给一块源像素 + 目标尺寸，返回新的像素（RGBA）。
//
// 采样一律**最近邻**（像素画不能被插值糊掉）；映射一律走「目标 → 源」的**逆向**映射，
// 所以拉伸时不会出现空洞。四点用单应（homography），网格把每个格子拆成两个三角形，
// 每个三角形用仿射逆变换——够快、无洞、像素画里看不出区别。
//
// 坐标口径（全项目统一）：**边框 / 像素角口径** —— 像素 i 覆盖 `[i, i+1)`，
// 一块 w×h 的区域四角是 `(0,0)`、`(w,0)`、`(w,h)`、`(0,h)`（不是 `w-1` / `h-1`）。
// 选区框 `View.selFramePts()`、浮动内容四角 `floatQuad()` 用的都是这个口径，
// 所以变形的四个控制点正好落在选区框的四个角上（早先用「像素下标」口径会让
// 控制点内缩 1 像素，且最右 / 最下一列因为 bbox 算窄了而漏出选区）。
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

/** 取源像素 (ix, iy)（越界＝保持透明） */
function samplePx(src: Pixmap, ix: number, iy: number, out: Uint8ClampedArray, o: number): void {
  if (ix < 0 || iy < 0 || ix >= src.w || iy >= src.h) return;   // 画面外：保持透明
  const p = (iy * src.w + ix) * 4;
  out[o] = src.data[p]; out[o + 1] = src.data[p + 1]; out[o + 2] = src.data[p + 2]; out[o + 3] = src.data[p + 3];
}

/**
 * 像素精度容差：`v` 是「反查回来的源坐标」，先按像素尺寸做一次相对吸附再 `floor`。
 *
 * 为什么要吸附：meshWarp 里源坐标是「重心权重 × 源顶点」再除以行列式算出来的，
 * 纯浮点运算会在**正好落在像素整数边界**时给出 `3.9999999999999996` 这类结果 ——
 * 直接 `floor` 就掉到前一格（恒等变换时表现为丢最右 / 最下一列）。
 * 容差取 `1e-9 × max(1, |v|)`：源坐标量级（画布长边）最多几千，误差约 1e-16 相对量级，
 * 吸附阈值比误差大好几个数量级、又远小于一个像素，所以不会真的挪动取样点。
 */
function snapFloor(v: number): number {
  return Math.floor(v + 1e-9 * Math.max(1, Math.abs(v)));
}

/**
 * 最近邻取样：**用 `Math.floor` 不用 `Math.round`**。
 *
 * 因为本项目统一走「边框 / 像素角」口径：像素 i 覆盖 `[i, i+1)`，它的**左上角**坐标就是 `i`。
 * 逆映射算出来的 `(x, y)` 是「目标像素中心反查回来的源坐标」，落进哪一格的半开区间
 * `[i, i+1)` 就属于哪一格 —— 这正是 `floor`（`snapFloor` 只是抹掉浮点毛刺）。
 * 若改成 `round`，`(i-0.5, i+0.5)` 里的像素会被算到邻居身上：恒等变换时最右 / 最下一列
 * 的像素中心一旦因浮点误差跨过 `i+0.5` 就会采到区域外面，表现为**丢掉一列 / 一行**。
 */
function sampleNearest(src: Pixmap, x: number, y: number, out: Uint8ClampedArray, o: number): void {
  samplePx(src, snapFloor(x), snapFloor(y), out, o);
}

/**
 * 四点自由变换（斜切 / 透视）：`quad` 是目标四边形（左上、右上、右下、左下，顺序固定），
 * `srcQuad` 默认是源图的四个角 —— **边框口径** `(0,0) (w,0) (w,h) (0,h)`，
 * 与 `quad` 用同一套坐标（见文件头）。返回 `outW × outH` 的新像素。
 */
export function warpQuad(src: Pixmap, quad: Pt[], outW: number, outH: number, srcQuad?: Pt[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(Math.max(0, outW) * Math.max(0, outH) * 4);
  if (outW <= 0 || outH <= 0) return out;
  const s = srcQuad ?? [
    { x: 0, y: 0 }, { x: src.w, y: 0 }, { x: src.w, y: src.h }, { x: 0, y: src.h },
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
 * 网格变形：`grid` 是 (n+1)×(n+1) 个控制点（**行主序**，左上 → 右下），n = `divs`（默认 2，
 * 即 3×3 个点）。控制点与 `floatGrid()` 同序同口径：边框口径下 `grid[0]` 是左上角
 * `(0,0)`，`grid[2]` 是右上角 `(w,0)`，`grid[8]` 是右下角 `(w,h)`（见文件头）。
 * 每个格子拆成两个三角形做仿射逆映射，两个三角形拼起来正好是该格的目标四边形，
 * 所以拉伸时不留洞、也不会漏掉最右 / 最下一列。
 */
export function meshWarp(src: Pixmap, grid: Pt[], outW: number, outH: number, divs = 2): Uint8ClampedArray {
  const n = Math.max(1, Math.round(divs));
  const need = (n + 1) * (n + 1);
  const out = new Uint8ClampedArray(Math.max(0, outW) * Math.max(0, outH) * 4);
  if (outW <= 0 || outH <= 0 || grid.length < need) return out;
  // 边框口径：源格边 = 源区域宽高 / 分格数（整块源的右 / 下边界就是 w / h）
  const cellW = src.w / n;
  const cellH = src.h / n;
  const tri = (a: Pt, b: Pt, c: Pt, sa: Pt, sb: Pt, sc: Pt, rMinX: number, rMinY: number, rMaxX: number, rMaxY: number): void => {
    // 目标三角形 → 源三角形 的仿射逆映射
    const d = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
    if (Math.abs(d) < 1e-9) return;
    const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
    const maxX = Math.min(outW - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
    const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
    const maxY = Math.min(outH - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        // 重心权重（未除以行列式）：目标像素质心 → 源坐标
        const n0 = (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y);
        const n1 = (x - a.x) * (c.y - a.y) - (c.x - a.x) * (y - a.y);
        const n2 = d - n0 - n1;                       // u 项（u = n2 / d）
        const sx = (n2 * sa.x + n1 * sb.x + n0 * sc.x) / d;
        const sy = (n2 * sa.y + n1 * sb.y + n0 * sc.y) / d;
        // 归属判定放在**源空间**：算出源坐标后看它是否落在本格的源矩形里。
        // 不用目标空间的重心符号判「在三角形内」，是因为两个三角形共用一条对角线，
        // 正好压在对角线上的像素质心两边权重都是 0，除法舍入误差会把它判成两侧都在外面
        // —— 恒等变换时表现为丢一列 / 一行像素。源空间只有一个矩形判定，
        // 1e-9 的相对容差足够吸收浮点误差，也不会多吞一格。
        const inRect = sx >= rMinX - 1e-9 && sx <= rMaxX + 1e-9 && sy >= rMinY - 1e-9 && sy <= rMaxY + 1e-9;
        if (!inRect) continue;
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
      tri(p00, p10, p11, s00, s10, s11, s00.x, s00.y, s11.x, s11.y);
      tri(p00, p11, p01, s00, s11, s01, s00.x, s00.y, s11.x, s11.y);
    }
  }
  return out;
}

/** 默认的 3x3 网格控制点：覆盖一整块 w×h 的区域（**边框口径**，四角 `(0,0) (w,0) (w,h) (0,h)`，
 *  与 `floatGrid()` 的行主序一致） */
export function defaultGrid(w: number, h: number, divs = 2): Pt[] {
  const n = Math.max(1, Math.round(divs));
  const out: Pt[] = [];
  for (let gy = 0; gy <= n; gy++) {
    for (let gx = 0; gx <= n; gx++) {
      out.push({ x: (w * gx) / n, y: (h * gy) / n });
    }
  }
  return out;
}

/** 把 4 个角点从一个矩形变成任意四边形：常用的「上边斜切」等预设。
 *  与 `warpQuad` 同口径（边框 / 像素角）。 */
export function skewQuad(w: number, h: number, kind: "x" | "y", amount: number): Pt[] {
  const t = amount;
  if (kind === "x") {
    return [{ x: t, y: 0 }, { x: w + t, y: 0 }, { x: w - t, y: h }, { x: -t, y: h }];
  }
  return [{ x: 0, y: t }, { x: w, y: -t }, { x: w, y: h + t }, { x: 0, y: h - t }];
}

/** 颜色数组工具（供 UI 预览用） */
export function pixmapFromCel(data: Uint8ClampedArray, w: number, h: number): Pixmap {
  return { w, h, data };
}

export type { RGBA };
