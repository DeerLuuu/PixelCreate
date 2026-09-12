// 图案笔刷的图案库：内置图案是「1 位遮罩」（落笔时用当前画笔颜色着色），
// 用户图案可以是任意 RGBA 小图（从选区或整张画布抓下来）。
//
// 纯数据 + 纯函数，无 DOM：画布坐标取模平铺（所以笔刷跨笔之间图案是连续的），
// 图案里 alpha=0 的像素**不落笔**（既不上色也不擦除），这样抖动笔刷才能只点出小点。
import { b64ToBytes, bytesToB64 } from "../engine/b64";
import type { RGBA } from "../engine/types";

/** 图案最大边长（超过就不收：图案要能一直平铺，太大没有意义且会拖慢落笔） */
export const PATTERN_MAX = 64;

export interface PatternDef {
  /** 稳定 id（内置 = 名字，用户图案 = 生成） */
  id: string;
  name: string;
  w: number;
  h: number;
  /** RGBA 原始字节的 base64（w*h*4） */
  data: string;
  /** true = 1 位遮罩，落笔时用当前画笔颜色着色（内置图案都是这种） */
  tint?: boolean;
  /** true = 内置图案，不可删除 */
  builtin?: boolean;
}

/** 8x8 的 1 位图案，'#' 落笔、'.' 留白 */
const ONE_BIT: Array<{ id: string; name: string; zh: string; rows: string[] }> = [
  { id: "checker", name: "Checker", zh: "棋盘 50%", rows: [
    "#.#.#.#.", ".#.#.#.#", "#.#.#.#.", ".#.#.#.#", "#.#.#.#.", ".#.#.#.#", "#.#.#.#.", ".#.#.#.#"] },
  { id: "dither25", name: "Dither 25%", zh: "抖动 25%", rows: [
    "#.......", "........", "....#...", "........", "..#.....", "........", "......#.", "........"] },
  { id: "dither75", name: "Dither 75%", zh: "抖动 75%", rows: [
    "###.###.", "###.###.", "#.#####.", "###.###", "###.###.", "###.#.#.", "#####.##", ".###.###"] },
  { id: "dither12", name: "Dither 12%", zh: "抖动 12%", rows: [
    "#.......", "........", "........", "........", "......#.", "........", "........", "....#..."] },
  { id: "diag", name: "Diagonal", zh: "斜线 /", rows: [
    "......#.", ".....#..", "....#...", "...#....", "..#.....", ".#......", "#.......", "........"] },
  { id: "diagBack", name: "Diagonal \\", zh: "斜线 \\", rows: [
    "#.......", ".#......", "..#.....", "...#....", "....#...", ".....#..", "......#.", "........"] },
  { id: "cross", name: "Cross", zh: "交叉网", rows: [
    "#...#...", ".#...#..", "..#...#.", "...#...#", "#...#...", ".#...#..", "..#...#.", "...#...#"] },
  { id: "grid", name: "Grid", zh: "方格", rows: [
    "########", "#.......", "#.......", "#.......", "########", "#.......", "#.......", "#......."] },
  { id: "dots", name: "Dots", zh: "散点", rows: [
    "#...#...", "........", "........", "...#...#", "........", "........", "#...#...", "........"] },
  { id: "brick", name: "Brick", zh: "砖块", rows: [
    "########", "#...#...", "#...#...", "########", "..#...#.", "..#...#.", "########", "......#."] },
];

/** 把 1 位行文字转成 RGBA 字节（'#' = 不透明白，'.' = 透明） */
function oneBitBytes(rows: string[]): { w: number; h: number; bytes: Uint8ClampedArray } {
  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  const bytes = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rows[y][x] !== "#") continue;
      const p = (y * w + x) * 4;
      bytes[p] = 255; bytes[p + 1] = 255; bytes[p + 2] = 255; bytes[p + 3] = 255;
    }
  }
  return { w, h, bytes };
}

/** 内置图案（tint = true：落笔时换成当前画笔颜色） */
export const BUILTIN_PATTERNS: PatternDef[] = ONE_BIT.map((p) => {
  const b = oneBitBytes(p.rows);
  return { id: p.id, name: p.name, w: b.w, h: b.h, data: bytesToB64(b.bytes), tint: true, builtin: true };
});

/** 内置图案的中文名（i18n 之外的一份小表，避免给每个图案加两条 i18n 键） */
export const BUILTIN_PATTERN_ZH: Record<string, string> = Object.fromEntries(ONE_BIT.map((p) => [p.id, p.zh]));

/** 解出图案的 RGBA 字节（长度不对时返回 null） */
export function patternBytes(p: PatternDef): Uint8ClampedArray | null {
  if (p.w <= 0 || p.h <= 0 || p.w > PATTERN_MAX || p.h > PATTERN_MAX) return null;
  let raw: Uint8Array;
  try {
    raw = b64ToBytes(p.data);
  } catch {
    return null;
  }
  if (raw.length !== p.w * p.h * 4) return null;
  return new Uint8ClampedArray(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
}

/** 画布坐标 (x,y) 处的图案颜色：取模平铺；透明处返回 null（＝不落笔） */
export function patternColorAt(bytes: Uint8ClampedArray, w: number, h: number, x: number, y: number): RGBA | null {
  if (w <= 0 || h <= 0) return null;
  const px = ((Math.floor(x) % w) + w) % w;
  const py = ((Math.floor(y) % h) + h) % h;
  const p = (py * w + px) * 4;
  if (bytes[p + 3] === 0) return null;
  return [bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]];
}

/** 从一块像素里裁出图案：默认裁掉四周全透明的边（选区里画的东西往往只占一角） */
export function patternFromBytes(
  src: Uint8ClampedArray, w: number, h: number, trim = true,
): { w: number; h: number; bytes: Uint8ClampedArray } | null {
  if (w <= 0 || h <= 0) return null;
  let x0 = 0, y0 = 0, x1 = w - 1, y1 = h - 1;
  if (trim) {
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (src[(y * w + x) * 4 + 3] === 0) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) return null;              // 全透明：没有图案可抓
    x0 = minX; y0 = minY; x1 = maxX; y1 = maxY;
  }
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  if (cw > PATTERN_MAX || ch > PATTERN_MAX) return null;
  const out = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const s = ((y + y0) * w + (x + x0)) * 4;
      const d = (y * cw + x) * 4;
      out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2]; out[d + 3] = src[s + 3];
    }
  }
  return { w: cw, h: ch, bytes: out };
}

/** 图案在 8x8 预览里的采样（面板画缩略图用）：透明处返回 null */
export function patternPreview(bytes: Uint8ClampedArray, w: number, h: number, size: number): Array<RGBA | null> {
  const out: Array<RGBA | null> = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      out.push(patternColorAt(bytes, w, h, x, y));
    }
  }
  return out;
}
