// 颜色分析引擎：颜色统计 / 近似色分组 / 分布直方图 / 颜色替换。
//
// 纯函数、无 DOM、可单测（面板 ColorAnalysisModal + Session.analyseCanvas 都只是
// 把像素搬进来、把结果画出去）。四个能力：
//
//   1. `analyzeColours`   每种颜色的数量与占比、透明度分类、直方图、调色板命中
//   2. `groupSimilarColours`  按 RGB 距离把"肉眼难分"的颜色聚成组（重复色排查）
//   3. `replaceColours`   按颜色替换像素（容差 / 范围掩码 / alpha 规则）
//   4. `selectByColour`   把某个颜色的像素写进选区掩码
//
// 距离度量的选择（整个文件只用一个）：**RGB 空间的等权欧氏距离（平方后比较，
// 不开方）**，距离阈值以「d = sqrt(dr²+dg²+db²) ≤ tol」的口径解释。理由：
//   - 与项目既有实现一致：`Session.paletteSnap` / `remapToPalette` 用的是同一套
//     平方 RGB 距离，颜色分析和索引色吸附必须给出同一个"最近的调色板色"，
//     另立一套公式就会出现"统计说最接近 A、吸附却给 B"的自相矛盾；
//   - 与既有容差口径一致：魔棒 / 油漆桶的容差是 0..255 的单通道口径，这里让
//     0 = 完全同色，255 = 全部命中，滑杆能直接复用，用户不用学两套数字；
//   - 不做 γ / 感知加权：像素画调色板通常只有 8~64 色、色块大而平，等权欧氏
//     距离足够判断"这两个色是不是同一个色"，且它是 O(1) 的整数运算 —— 像素
//     级遍历（百万级像素）对性能敏感，ΔE2000 那种 L*a*b* 换算成本高一个数量级。
//   阈值口径：颜色之间的分组默认 `GROUP_TOLERANCE = 12`（约每通道 7 阶、整体
//   约 5% 的差别），这是 Aseprite 用户排查"看起来一样却不是一个色号"时常用的
//   尺度；容差替换默认 0（只换完全相同的颜色），与"精确替换"的直觉一致。
import type { RGBA } from "./types";

/** 用于"是否近到肉眼难分"的默认分组阈值（欧氏距离，见文件头说明） */
export const GROUP_TOLERANCE = 12;
/** 直方图每个通道的桶数上限（面板按 12~24 个桶画条形图） */
export const HIST_MAX_BUCKETS = 24;
/** 近似色分组最多返回几组（面板只列前几组，其余折叠成一句提示） */
export const GROUP_MAX_GROUPS = 64;

/** 统计范围 / 替换范围：整块数据、只当前图层帧、只选区内的像素 */
export type ColourScope = "all" | "layer" | "selection";

export const clampByte = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** 到 255 幅度的平方距离除以 3：dr=dg=db=v 时正好等于 v（便于和单通道容差对照）。
 *  与 `paletteSnap` 的判据同源，只是量纲归一化，排序结果完全相同。 */
export function rgbDistanceSq(r0: number, g0: number, b0: number, r1: number, g1: number, b1: number): number {
  const dr = r0 - r1, dg = g0 - g1, db = b0 - b1;
  return (dr * dr + dg * dg + db * db) / 3;
}

/** 是否在容差内（容差是 RGB 距离阈值；0 = 必须完全相同；255 = 全部命中） */
export function withinTolerance(a: RGBA, b: RGBA, tol: number): boolean {
  const t = Math.max(0, Math.min(255, tol));
  return rgbDistanceSq(a[0], a[1], a[2], b[0], b[1], b[2]) <= t * t;
}

/** 调色板里最接近的颜色（同 paletteSnap 的判据：平方 RGB 距离，平局取先出现的） */
export function nearestPalette(r: number, g: number, b: number, palette: RGBA[]): RGBA | null {
  let best: RGBA | null = null;
  let bd = Infinity;
  for (const p of palette) {
    const d = rgbDistanceSq(r, g, b, p[0], p[1], p[2]);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

/** 32 位颜色键（RGBA 各 8 位），用来当 Map 的键。
 *  ⚠ 每一位都要自己加括号：`a << 8 | b` 的 `<<` 优先级高于 `|`，但 `a << 8 | b << 16`
 *  会被读成 `(a<<8) | (b<<16)` 之外的东西 —— 少写一对括号就会把两个不同的颜色
 *  并成同一个键（统计直接少一种颜色，且极难发现）。 */
export function colourKey(c: RGBA): number {
  return (((c[0] & 255) << 24) | ((c[1] & 255) << 16) | ((c[2] & 255) << 8) | (c[3] & 255)) >>> 0;
}

// ---------------------------------------------------------------- 颜色统计

export type ColourSort = "count" | "hue" | "light";

export interface PaletteHit {
  /** 调色板里完全相同的颜色（含 alpha） */
  exact: boolean;
  /** 调色板里最接近的颜色（调色板为空时是 null） */
  nearest: RGBA | null;
  /** 与最近色的距离（0..255 口径，同容差滑杆） */
  distance: number;
}

export interface ColourEntry {
  rgba: RGBA;
  count: number;
  /** count / total，0..1 */
  ratio: number;
  /** count / opaque，0..1（不含全透明像素；opaque=0 时是 0） */
  ratioOfOpaque: number;
  palette: PaletteHit;
  /** 是否和"最近调色板色"在默认分组阈值内（面板用来标"近似板色"） */
  nearPalette: boolean;
}

export interface Histogram {
  /** bucket 数（hue 固定 360/labels 粒度；sat/light 用 min(24, 2^n)） */
  buckets: number;
  /** 每个桶里的像素数 */
  counts: number[];
  /** 本通道出现过的最大值（面板按它定条长，避免空图时除 0） */
  max: number;
}

export interface ColourAnalysis {
  /** 使用到的颜色，按 opts.sort 排序（默认数量降序；平局按 RGBA 升序，保证确定性） */
  entries: ColourEntry[];
  /** 统计过的像素总数（含全透明） */
  totalPixels: number;
  opaquePixels: number;
  /** 0 < alpha < 255 的像素 */
  semiPixels: number;
  /** alpha === 0 的像素 */
  clearPixels: number;
  /** 不透明像素里用到的不同颜色数 */
  opaqueColours: number;
  /** 半透明像素里用到的不同颜色数 */
  semiColours: number;
  /** 用到的颜色总数（不透明 + 半透明） */
  colourCount: number;
  /** 调色板里一个像素都没用到的颜色（按调色板顺序） */
  unusedPalette: RGBA[];
  /** 调色板里用到的颜色数 */
  usedPaletteCount: number;
  histogram: { hue: Histogram; sat: Histogram; light: Histogram };
  /** 色相无意义的像素（灰阶 / 饱和度 < 6%），色相直方图不含它们 */
  hueNeutral: number;
}

export interface ColourAnalysisOpts {
  /** 调色板（默认空；空的时候 paletteHit 全 false / nearest=null） */
  palette?: RGBA[];
  /** 是否把全透明像素也算进"用到的颜色"（默认 false，只有统计"颜色"时才需要） */
  includeClear?: boolean;
  /** 排序方式（默认数量降序） */
  sort?: ColourSort;
  /** 直方图桶数上限（默认 24，会被夹到 12..24） */
  buckets?: number;
}

/** 直方图桶数：至少 12、至多 24，且取 4 的倍数（每桶均分，色相 360°/24=15° 整齐） */
export function bucketCount(requested?: number): number {
  const n = Math.max(12, Math.min(HIST_MAX_BUCKETS, Math.round(requested ?? HIST_MAX_BUCKETS)));
  return Math.round(n / 4) * 4;
}

function newHistogram(buckets: number): Histogram {
  return { buckets, counts: new Array<number>(buckets).fill(0), max: 0 };
}

function finishHistogram(h: Histogram): Histogram {
  let max = 0;
  for (const v of h.counts) if (v > max) max = v;
  return { buckets: h.buckets, counts: h.counts, max };
}

/** 与 src/engine/adjust.ts 的 rgbToHsl 同源（这里只需要 hue 与 lightness，
 *  内联一份避免 analysis 依赖调整模块的重型路径；数值口径保持一致） */
export function hueOf(r: number, g: number, b: number): number {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  if (max === min) return 0;
  const d = max - min;
  let h: number;
  if (max === R) h = (G - B) / d + (G < B ? 6 : 0);
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  return h * 60;
}

export function saturationOf(r: number, g: number, b: number): number {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return 0;
  const d = max - min;
  return l > 0.5 ? d / (2 - max - min) : d / (max + min);
}

export function lightnessOf(r: number, g: number, b: number): number {
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 510;
}

/** 饱和度低于这个值就当灰阶：色相没有意义，不进色相直方图 */
export const HUE_NEUTRAL_SAT = 0.06;

const cmpRgba = (a: RGBA, b: RGBA): number =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3];

/**
 * 统计一块 RGBA 像素里的颜色分布。
 * `data` 长度不足 4 的倍数时忽略尾巴，不会越界。
 */
export function analyzeColours(data: Uint8ClampedArray, opts: ColourAnalysisOpts = {}): ColourAnalysis {
  const palette = opts.palette ?? [];
  const includeClear = opts.includeClear === true;
  const sort: ColourSort = opts.sort ?? "count";
  const buckets = bucketCount(opts.buckets);

  const counts = new Map<number, { rgba: RGBA; count: number }>();
  const hueHist = newHistogram(buckets);
  const satHist = newHistogram(buckets);
  const lightHist = newHistogram(buckets);
  let totalPixels = 0, opaquePixels = 0, semiPixels = 0, clearPixels = 0, hueNeutral = 0;

  for (let i = 0; i + 3 < data.length; i += 4) {
    totalPixels++;
    const a = data[i + 3];
    if (a === 0) {
      clearPixels++;
      if (!includeClear) continue;
    } else if (a === 255) {
      opaquePixels++;
    } else {
      semiPixels++;
    }
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const key = colourKey([r, g, b, a]);
    const hit = counts.get(key);
    if (hit) hit.count++;
    else counts.set(key, { rgba: [r, g, b, a], count: 1 });

    // 分布统计只算"看得见"的像素（alpha > 0），否则全透明像素会把色相桶堆满
    if (a === 0) continue;
    const sat = saturationOf(r, g, b);
    satHist.counts[Math.min(buckets - 1, Math.floor(sat * buckets))]++;
    const light = lightnessOf(r, g, b);
    lightHist.counts[Math.min(buckets - 1, Math.floor(light * buckets))]++;
    if (sat < HUE_NEUTRAL_SAT) hueNeutral++;
    else hueHist.counts[Math.min(buckets - 1, Math.floor(hueOf(r, g, b) / (360 / buckets)))]++;
  }

  // 调色板命中：精确 = 完全相同的 RGBA；最近 = 同 paletteSnap 的判据
  let opaqueColours = 0, semiColours = 0;
  const usedPalette = new Set<number>();
  const paletteKeys = new Map<number, RGBA>();
  for (const p of palette) {
    const k = colourKey(p);
    if (!paletteKeys.has(k)) paletteKeys.set(k, p);
  }
  const entries: ColourEntry[] = [];
  for (const { rgba, count } of counts.values()) {
    if (rgba[3] === 255) opaqueColours++;
    else if (rgba[3] > 0) semiColours++;
    const exact = paletteKeys.has(colourKey(rgba));
    const near = nearestPalette(rgba[0], rgba[1], rgba[2], palette);
    const distance = near ? Math.sqrt(rgbDistanceSq(rgba[0], rgba[1], rgba[2], near[0], near[1], near[2])) : Infinity;
    if (near && !exact) usedPalette.add(colourKey(near));
    if (exact) usedPalette.add(colourKey(rgba));
    entries.push({
      rgba,
      count,
      ratio: totalPixels ? count / totalPixels : 0,
      ratioOfOpaque: opaquePixels ? count / opaquePixels : 0,
      palette: { exact, nearest: near, distance },
      nearPalette: near ? distance <= GROUP_TOLERANCE : false,
    });
  }

  entries.sort(sortComparator(sort));
  const unusedPalette = palette.filter((p) => !usedPalette.has(colourKey(p)));

  return {
    entries,
    totalPixels,
    opaquePixels,
    semiPixels,
    clearPixels,
    opaqueColours,
    semiColours,
    colourCount: opaqueColours + semiColours,
    unusedPalette,
    usedPaletteCount: palette.length - unusedPalette.length,
    histogram: { hue: finishHistogram(hueHist), sat: finishHistogram(satHist), light: finishHistogram(lightHist) },
    hueNeutral,
  };
}

/** 排序比较器：数量降序 / 色相升序 / 明度升序；平局一律按 RGBA 升序保证稳定 */
export function sortComparator(sort: ColourSort): (a: ColourEntry, b: ColourEntry) => number {
  if (sort === "hue") {
    return (a, b) => hueOf(a.rgba[0], a.rgba[1], a.rgba[2]) - hueOf(b.rgba[0], b.rgba[1], b.rgba[2])
      || lightnessOf(a.rgba[0], a.rgba[1], a.rgba[2]) - lightnessOf(b.rgba[0], b.rgba[1], b.rgba[2])
      || cmpRgba(a.rgba, b.rgba);
  }
  if (sort === "light") {
    return (a, b) => lightnessOf(a.rgba[0], a.rgba[1], a.rgba[2]) - lightnessOf(b.rgba[0], b.rgba[1], b.rgba[2])
      || cmpRgba(a.rgba, b.rgba);
  }
  return (a, b) => b.count - a.count || cmpRgba(a.rgba, b.rgba);
}

/** 面板切排序用：不重算统计，只重排已有条目（原数组不动） */
export function sortColourEntries(entries: ColourEntry[], sort: ColourSort): ColourEntry[] {
  return entries.slice().sort(sortComparator(sort));
}

// ---------------------------------------------------------------- 近似色分组

export interface ColourGroup {
  /** 代表色：组里数量最多的那个颜色（平局按 RGBA 升序） */
  rep: RGBA;
  members: ColourEntry[];
  /** 组内成员总数（像素数） */
  pixels: number;
  /** 组内离代表色最远的距离（0..255 口径，面板显示"相似度"） */
  spread: number;
}

/**
 * 把"肉眼难分"的颜色聚成组：按数量从多到少扫一遍，每个颜色并进**第一个**与
 * 代表色距离 ≤ tol 的组（贪心）。
 *
 * 代表色 = 组里**像素数最多**的那个颜色（并列时按 RGBA 升序取小的），这一点很
 * 关键：合并会把成员换成代表色，用最多的那个当代表色，画面主色块不动，只掉
 * 零星杂色；若按"最先遇到的颜色"当代表色，次要色的像素反而会盖掉主色。
 * 只返回成员 ≥ 2 的组（"可能重复"），单色组没有意义。
 */
export function groupSimilarColours(
  entries: ColourEntry[],
  tol: number = GROUP_TOLERANCE,
  maxGroups: number = GROUP_MAX_GROUPS,
): ColourGroup[] {
  const t = Math.max(0, Math.min(255, tol));
  const sorted = entries.slice().sort((a, b) => b.count - a.count || cmpRgba(a.rgba, b.rgba));
  const groups: ColourGroup[] = [];
  for (const e of sorted) {
    let target: ColourGroup | null = null;
    for (const g of groups) {
      if (withinTolerance(e.rgba, g.rep, t)) { target = g; break; }
    }
    if (!target) {
      groups.push({ rep: e.rgba, members: [e], pixels: e.count, spread: 0 });
      continue;
    }
    // 只统计 alpha 也一致的成员？不 —— 半透明同色也属于"重复色"，一起算，
    // 合并时按键值逐个替换，alpha 不会被改掉（见 Session.mergeColourGroup）
    target.members.push(e);
    target.pixels += e.count;
    target.spread = Math.max(target.spread, Math.sqrt(rgbDistanceSq(e.rgba[0], e.rgba[1], e.rgba[2], target.rep[0], target.rep[1], target.rep[2])));
  }
  // 成员数不设上限（面板自己只画前几个 + "还有 N 个"），组数设上限防止
  // "整张图都是近似色"时返回几百组把面板撑爆
  const out = groups
    .filter((g) => g.members.length > 1)
    // 重新挑代表色：数量最多者优先（并列时 RGBA 小的优先），并把 spread 按新
    // 代表色重算 —— 挑第一个成员当代表色会与"合并到主色"的意图相反
    .map((g) => {
      const rep = g.members
        .slice()
        .sort((a, b) => b.count - a.count || cmpRgba(a.rgba, b.rgba))[0].rgba;
      let spread = 0;
      for (const m of g.members) {
        spread = Math.max(spread, Math.sqrt(rgbDistanceSq(m.rgba[0], m.rgba[1], m.rgba[2], rep[0], rep[1], rep[2])));
      }
      return { rep, members: g.members, pixels: g.pixels, spread };
    })
    .sort((a, b) => b.pixels - a.pixels || cmpRgba(a.rep, b.rep));
  return out.slice(0, Math.max(1, Math.floor(maxGroups)));
}

// ---------------------------------------------------------------- 颜色替换

export interface ReplaceOpts {
  /** 欧氏距离容差（0..255，0 = 只换完全相同的颜色） */
  tolerance?: number;
  /** 处理范围：all=整块数据；layer=同一块数据但忽略掩码；selection=只处理掩码允许的像素 */
  scope?: ColourScope;
  /** 选区掩码里坐标 (x,y) 是否为 1；scope==="selection" 时必填 */
  inMask?: (x: number, y: number) => boolean;
  /** 只替换完全不透明的像素（默认 true）；false 时半透明像素也算命中 */
  opaqueOnly?: boolean;
  /** 替换半透明像素时保留它原来的 alpha（默认 true）。false = 换成目标色的 alpha */
  keepAlpha?: boolean;
}

export interface ReplaceResult {
  /** 被改动的像素数 */
  changed: number;
}

/** 单像素水平是否命中"源色 + 容差 + alpha 规则"（替换与选区共用同一口径） */
function hits(r: number, g: number, b: number, a: number, from: RGBA, tol: number, opaqueOnly: boolean): boolean {
  if (a === 0) return false;                       // 全透明像素没有颜色可言
  if (opaqueOnly && a !== 255) return false;
  return rgbDistanceSq(r, g, b, from[0], from[1], from[2]) <= tol * tol;
}

/**
 * 按颜色替换像素（原地改 `data`）。返回被改动的像素数。
 * 范围：`scope==="selection"` 时只动 `inMask(x,y) === 1` 的像素，其余一律不碰。
 */
export function replaceColours(
  data: Uint8ClampedArray, w: number, h: number, from: RGBA, to: RGBA, opts: ReplaceOpts = {},
): ReplaceResult {
  const tol = Math.max(0, Math.min(255, Math.round(opts.tolerance ?? 0)));
  const scope: ColourScope = opts.scope ?? "all";
  const opaqueOnly = opts.opaqueOnly !== false;
  const keepAlpha = opts.keepAlpha !== false;
  const mask = scope === "selection" ? opts.inMask : undefined;
  const useMask = scope === "selection" && typeof mask === "function";
  if (!data || data.length < 4) return { changed: 0 };

  let changed = 0;
  const px = Math.max(0, Math.floor(w));
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (useMask) {
      const p = i >> 2;
      const x = px > 0 ? p % px : 0;
      const y = px > 0 ? Math.floor(p / px) : 0;
      if (!mask!(x, y)) continue;
    }
    const a = data[i + 3];
    if (!hits(data[i], data[i + 1], data[i + 2], a, from, tol, opaqueOnly)) continue;
    data[i] = clampByte(to[0]);
    data[i + 1] = clampByte(to[1]);
    data[i + 2] = clampByte(to[2]);
    data[i + 3] = clampByte(keepAlpha ? a : to[3]);
    changed++;
  }
  return { changed };
}

/**
 * 把"某个颜色的所有像素"写进选区掩码（供面板的「选中这些像素」按钮）。
 * `mask` 长度不足 w*h 时只写能写到的部分；返回选中的像素数。
 * 只命中不透明 / 半透明像素（全透明像素不会被选中，它没有颜色）。
 */
export function selectByColour(
  mask: Uint8Array, data: Uint8ClampedArray, w: number, h: number, from: RGBA, tol = 0, opaqueOnly = false,
): number {
  if (!mask || !data) return 0;
  const t = Math.max(0, Math.min(255, Math.round(tol)));
  const cells = Math.min(mask.length, Math.max(0, Math.floor(w) * Math.floor(h)));
  let hit = 0;
  for (let p = 0; p < cells; p++) {
    const i = p * 4;
    if (i + 3 >= data.length) break;
    const a = data[i + 3];
    if (a === 0) continue;
    if (opaqueOnly && a !== 255) continue;
    if (rgbDistanceSq(data[i], data[i + 1], data[i + 2], from[0], from[1], from[2]) > t * t) continue;
    mask[p] = 1;
    hit++;
  }
  return hit;
}

// ---------------------------------------------------------------- 图层压平

/** 一层要压平的像素（顺序 = 从下到上） */
export interface FlattenLayer {
  data: Uint8ClampedArray;
  /** 不透明度百分比（1..100），缺省 100 */
  opacity?: number;
}

/**
 * 把多层像素按「source-over + 图层不透明度」压成一张 RGBA 图。
 * 纯函数版 `compositor.composeFrame`：颜色分析要在没有 DOM（测试 / 后台）的
 * 环境里也能算出和画面一致的像素，所以这里不走 canvas。
 *
 * 已知边界：**混合模式（正片叠底等）不在这里模拟**，一律按正常模式叠加。
 * 画面上的混合模式结果由渲染层（canvas `globalCompositeOperation`）负责，
 * 分析器刻意不重写那套公式，以免和渲染口径分叉（见 docs/API.md 的口径说明）。
 */
export function flattenLayers(w: number, h: number, layers: FlattenLayer[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(Math.max(0, w * h * 4));
  for (const L of layers) {
    const src = L.data;
    if (!src) continue;
    const op = Math.max(0, Math.min(100, L.opacity === undefined ? 100 : L.opacity)) / 100;
    if (op <= 0) continue;
    for (let i = 0; i + 3 < out.length && i + 3 < src.length; i += 4) {
      const sa = (src[i + 3] / 255) * op;
      if (sa <= 0) continue;
      const ia = 1 - sa;
      out[i] = src[i] * sa + out[i] * ia;
      out[i + 1] = src[i + 1] * sa + out[i + 1] * ia;
      out[i + 2] = src[i + 2] * sa + out[i + 2] * ia;
      out[i + 3] = (sa + (out[i + 3] / 255) * ia) * 255;
    }
  }
  return out;
}

// ---------------------------------------------------------------- CSV

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** 统计结果导成 CSV（UTF-8 文本，Excel 可读；首行是表头） */
export function colourStatsCsv(a: ColourAnalysis, opts: { scopeLabel?: string; paletteSize?: number } = {}): string {
  const rows: Array<Array<string | number>> = [];
  rows.push(["scope", opts.scopeLabel ?? "", "paletteSize", opts.paletteSize ?? "", "colours", a.colourCount]);
  rows.push(["totalPixels", a.totalPixels, "opaquePixels", a.opaquePixels, "semiPixels", a.semiPixels, "clearPixels", a.clearPixels]);
  rows.push([]);
  rows.push(["index", "hex", "r", "g", "b", "a", "pixels", "ratio", "opaqueRatio", "inPalette", "nearestHex", "nearestDistance"]);
  a.entries.forEach((e, i) => {
    const hex = "#" + [e.rgba[0], e.rgba[1], e.rgba[2]].map((v) => ("0" + v.toString(16)).slice(-2)).join("")
      + (e.rgba[3] < 255 ? ("0" + e.rgba[3].toString(16)).slice(-2) : "");
    const near = e.palette.nearest;
    rows.push([
      i + 1, hex, e.rgba[0], e.rgba[1], e.rgba[2], e.rgba[3], e.count,
      (e.ratio * 100).toFixed(3) + "%",
      (e.ratioOfOpaque * 100).toFixed(3) + "%",
      e.palette.exact ? 1 : 0,
      near ? "#" + near.slice(0, 3).map((v) => ("0" + v.toString(16)).slice(-2)).join("") : "",
      Number.isFinite(e.palette.distance) ? e.palette.distance.toFixed(2) : "",
    ]);
  });
  if (a.unusedPalette.length) {
    rows.push([]);
    rows.push(["unusedPalette"]);
    for (const p of a.unusedPalette) rows.push(["#" + p.slice(0, 3).map((v) => ("0" + v.toString(16)).slice(-2)).join("")]);
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
