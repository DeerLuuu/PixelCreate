// 「高级缩放」对比预览的**取块逻辑**（纯函数：无 React、无 DOM，可单独单测）。
//
// 单独一个模块的理由：这段逻辑最容易出「看起来什么都没显示」的问题，而它完全能在
// `node .ts-out/tests/run-tests.js` 里跑 —— 组件只负责把结果画进 canvas。
//
// 两个口径（改之前先读）：
//  1. **源像素**与作用范围一致：`sprite` ＝ 当前帧**可见图层压平**（＝用户在画布上看到的画面；
//     `scaleAdvanced()` 对 sprite 范围也是把所有 cel 都重采样），`layer` / `selection`
//     ＝ 当前图层的那一张 cel。早先一律只读当前 cel：图层一多、或者画在别的图层上，
//     预览就是空白（用户报的「两个图片都没显示任何内容」）。
//  2. **取哪一块**＝按缩放倍数反过来取一小块（左右两侧显示同样多的内容、同样的屏幕像素
//     大小），位置**对准内容包围盒**的中心 —— 固定取区域正中时，内容在角落就什么都看不到。
import { flattenLayers } from "../engine/color-analysis";
import type { Doc } from "../engine/doc";

export interface PreviewRegion { x: number; y: number; w: number; h: number }

export interface PreviewGeometry {
  /** 取的那一块在**画布坐标**里的位置与大小 */
  x: number; y: number; w: number; h: number;
  /** 「缩放后」那一侧的像素尺寸 */
  tw: number; th: number;
  /** 这一块里有没有可见像素（空的时候组件给提示，而不是画两个空框） */
  empty: boolean;
}

/** 当前帧**可见图层**压平后的像素（画布尺寸，RGBA） */
export function flatFrame(doc: Doc, fi: number): Uint8ClampedArray {
  const layers: Array<{ data: Uint8ClampedArray; opacity?: number }> = [];
  for (let li = 0; li < doc.layers.length; li++) {
    const L = doc.layers[li];
    if (!L.visible) continue;
    const cel = doc.celAt(li, fi);
    if (!cel) continue;
    layers.push({ data: cel.data, opacity: L.opacity });
  }
  return flattenLayers(doc.w, doc.h, layers);
}

/**
 * 预览的源像素。
 *  - `sprite`（整个图像）：当前帧可见图层的压平结果 —— 缩放会改所有 cel，画面就是它；
 *  - `layer` / `selection`：当前图层那一张 cel（拷贝一份，避免调用方改到文档）。
 */
export function previewSource(doc: Doc, scope: string, li: number, fi: number): Uint8ClampedArray {
  if (scope === "sprite") return flatFrame(doc, fi);
  const out = new Uint8ClampedArray(doc.w * doc.h * 4);
  const cel = doc.celAt(li, fi);
  if (cel) out.set(cel.data.subarray(0, Math.min(cel.data.length, out.length)));
  return out;
}

/** 区域里的**内容包围盒**（只看 alpha>0 的像素；没有内容返回 null） */
export function contentBounds(src: Uint8ClampedArray, docW: number, docH: number, region: PreviewRegion):
{ x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const rx1 = region.x + region.w, ry1 = region.y + region.h;
  for (let y = Math.max(0, region.y); y < Math.min(docH, ry1); y++) {
    for (let x = Math.max(0, region.x); x < Math.min(docW, rx1); x++) {
      if (src[(y * docW + x) * 4 + 3] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 >= x0 ? { x0, y0, x1, y1 } : null;
}

/** 把 `v` 夹到 `[lo, hi]`（`hi < lo` 时返回 `lo`） */
function clampInt(v: number, lo: number, hi: number): number {
  const n = Math.round(v);
  return Math.max(lo, Math.min(Math.max(lo, hi), n));
}

/**
 * 取块几何：大小＝按缩放倍数反推（`span = region / k`），位置＝对准内容包围盒中心
 * （内容为空时退回区域中心），并整块夹在区域内。`tw` / `th` 是缩放后那一侧的尺寸。
 */
export function previewPatchGeometry(
  src: Uint8ClampedArray, docW: number, docH: number, region: PreviewRegion, cw: number, ch: number,
): PreviewGeometry {
  const rw = Math.max(1, region.w), rh = Math.max(1, region.h);
  const kx = cw / rw, ky = ch / rh;
  const spanX = Math.max(1, Math.min(rw, Math.round(rw / Math.max(1, kx))));
  const spanY = Math.max(1, Math.min(rh, Math.round(rh / Math.max(1, ky))));
  const bb = contentBounds(src, docW, docH, region);
  const cx = bb ? (bb.x0 + bb.x1 + 1) / 2 : region.x + rw / 2;
  const cy = bb ? (bb.y0 + bb.y1 + 1) / 2 : region.y + rh / 2;
  const x = clampInt(cx - spanX / 2, region.x, region.x + rw - spanX);
  const y = clampInt(cy - spanY / 2, region.y, region.y + rh - spanY);
  return {
    x, y, w: spanX, h: spanY,
    tw: Math.max(1, Math.round(spanX * kx)),
    th: Math.max(1, Math.round(spanY * ky)),
    empty: !bb,
  };
}

/** 从画布尺寸的源像素里裁出几何体描述的那一块（画布外的部分保持透明） */
export function cropPatch(src: Uint8ClampedArray, docW: number, docH: number, g: PreviewGeometry): Uint8ClampedArray {
  const out = new Uint8ClampedArray(g.w * g.h * 4);
  for (let y = 0; y < g.h; y++) {
    const py = g.y + y;
    if (py < 0 || py >= docH) continue;
    for (let x = 0; x < g.w; x++) {
      const px = g.x + x;
      if (px < 0 || px >= docW) continue;
      const si = (py * docW + px) * 4, di = (y * g.w + x) * 4;
      out[di] = src[si];
      out[di + 1] = src[si + 1];
      out[di + 2] = src[si + 2];
      out[di + 3] = src[si + 3];
    }
  }
  return out;
}

/** 倍率文案：整数写 `2×`，否则最多两位小数且不留尾零（`1.5×` / `0.5×`）；两轴不同时写 `2× / 1.5×` */
export function scaleFactorLabel(cw: number, ch: number, region: PreviewRegion): string {
  const fmt = (k: number): string => (Math.abs(k - Math.round(k)) < 1e-9
    ? String(Math.round(k))
    : String(Number(k.toFixed(2))));
  const kx = cw / Math.max(1, region.w), ky = ch / Math.max(1, region.h);
  return fmt(kx) + "\u00d7" + (Math.abs(kx - ky) < 1e-9 ? "" : " / " + fmt(ky) + "\u00d7");
}
