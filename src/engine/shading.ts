// 色彩明暗（Color Shading）—— 从 Aseprite 脚本 "Color Shading v5.0" 移植的调色板
// 生成器：给一个基色，一次生成若干条色阶（明暗 / 亮部 / 饱和 / 混色 / 微差 / 色相），
// 外加互补 / 三角 / 四角这类和声配色。
//
// 上游：https://github.com/GerryLCDF/Aseprite-Color-Shading-v5.0
// （v1–2 Dominick John + David Capello，v3 yashar98，v3.1 Daeyangae，v4 Manuel Hoelzl）。
//
// 这里是**纯函数**（无 DOM / 无 Session），方便直接单测；Lua 原版的口径逐行照搬，
// 只有两处刻意的差异，都写在对应函数上：
//   1) alpha 一路带着走（Lua 的 mixColors 会把 alpha 重置成 255）；
//   2) slots 会被夹到 3..25 的奇数（Lua 在 UI 上把偶数 +1，这里放进纯函数里）。
import { hslToRgb, rgbToHsl } from "./adjust";
import type { RGBA } from "./types";

/** 每条色阶的槽位数范围（Lua: slider 3..25，偶数自动 +1） */
export const SHADING_SLOTS_MIN = 3;
export const SHADING_SLOTS_MAX = 25;

export interface ShadingParams {
  /** 每条色阶的色块数（3..25，强制奇数：正中间那格就是基色本身） */
  slots: number;
  /** 明暗行的饱和度梯度（百分数，1..200；>100 会冲到全饱和） */
  intensity: number;
  /** 明暗行的明度梯度（百分数，1..100），决定最亮那格能亮多少 */
  peak: number;
  /** 两个温度色对明暗行的拉扯强度（百分数，1..100），0 = 不掺温度色 */
  sway: number;
  /** 暗部掺进去的色相（度，0..359.99），默认 215 = 偏冷的蓝 */
  lowTemp: number;
  /** 亮部掺进去的色相（度，0..359.99），默认 50 = 偏暖的黄 */
  highTemp: number;
}

/** Lua 原版的默认值（default_lowtemp / hightemp / intensity / peak / sway / slots） */
export const SHADING_DEFAULTS: ShadingParams = {
  slots: 7, intensity: 40, peak: 60, sway: 60, lowTemp: 215, highTemp: 50,
};

/** 交互式调整时用的范围（UI 滑杆与设置都用它，别在别处硬编码） */
export const SHADING_RANGES = {
  intensity: { min: 1, max: 200 },
  peak: { min: 1, max: 100 },
  sway: { min: 0, max: 100 },
  temp: { min: 0, max: 359.99 },
} as const;

/** 六条色阶行的 id（顺序＝界面里的顺序，标签在 i18n 的 shadingRows.*） */
export const SHADING_ROWS = ["shade", "light", "sat", "mix", "nuance", "hue"] as const;
export type ShadingRow = (typeof SHADING_ROWS)[number];

export interface ShadingRamps {
  /** 主行：温度 + 饱和度 + 明度一起上 */
  shade: RGBA[];
  /** 只动明度（±0.4） */
  light: RGBA[];
  /** 只动饱和度（±0.75） */
  sat: RGBA[];
  /** 两个基色之间的过渡（与基色本身无关） */
  mix: RGBA[];
  /** 极小色相偏移，用来做「肉眼难分的微差色」 */
  nuance: RGBA[];
  /** 色相环上等距推进 */
  hue: RGBA[];
}

export interface ShadingHarmonics {
  /** 基色 + 补色（+180°） */
  complementary: RGBA[];
  /** 基色 + 三角（+120° / +240°） */
  triadic: RGBA[];
  /** 基色 + 四角（+90° / +180° / +270°） */
  tetradic: RGBA[];
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const lerp = (a: number, b: number, t: number) => a * (1 - t) + b * t;

/** 夹到范围内并**强制奇数**（Lua 的 onchange 里把偶数 +1） */
export function normalizeSlots(n: number): number {
  let v = Math.round(Number.isFinite(n) ? n : SHADING_DEFAULTS.slots);
  v = clamp(v, SHADING_SLOTS_MIN, SHADING_SLOTS_MAX);
  if (v % 2 === 0) v += 1;                 // 24 -> 25，超出上限时下一行再夹回来
  return clamp(v, SHADING_SLOTS_MIN, SHADING_SLOTS_MAX);
}

/** 把参数夹到合法范围（UI 每次改动都过一遍，别让脏数据进算法） */
export function normalizeParams(p: Partial<ShadingParams>): ShadingParams {
  const src = { ...SHADING_DEFAULTS, ...p };
  return {
    slots: normalizeSlots(src.slots),
    intensity: clamp(src.intensity, SHADING_RANGES.intensity.min, SHADING_RANGES.intensity.max),
    peak: clamp(src.peak, SHADING_RANGES.peak.min, SHADING_RANGES.peak.max),
    sway: clamp(src.sway, SHADING_RANGES.sway.min, SHADING_RANGES.sway.max),
    lowTemp: ((src.lowTemp % 360) + 360) % 360,
    highTemp: ((src.highTemp % 360) + 360) % 360,
  };
}

/** hue 转一个「圈数」（Lua 的 shiftHue 收的是 amount，乘 360 后取模） */
function shiftHue(c: RGBA, turns: number): RGBA {
  const [h, s, l] = rgbToHsl(c[0], c[1], c[2]);
  const [r, g, b] = hslToRgb(((h + turns * 360) % 360 + 360) % 360, s, l);
  return [r, g, b, c[3]];
}

/** >0 往 1 靠（更饱和），<0 往 0 靠（更灰）；0 原样 */
function shiftSat(c: RGBA, amount: number): RGBA {
  if (amount === 0) return [...c] as RGBA;
  const [h, s, l] = rgbToHsl(c[0], c[1], c[2]);
  const [r, g, b] = hslToRgb(h, clamp(amount > 0 ? lerp(s, 1, amount) : lerp(s, 0, -amount), 0, 1), l);
  return [r, g, b, c[3]];
}

/** >0 往 1 靠（更亮），<0 往 0 靠（更暗） */
function shiftLight(c: RGBA, amount: number): RGBA {
  if (amount === 0) return [...c] as RGBA;
  const [h, s, l] = rgbToHsl(c[0], c[1], c[2]);
  const [r, g, b] = hslToRgb(h, s, clamp(amount > 0 ? lerp(l, 1, amount) : lerp(l, 0, -amount), 0, 1));
  return [r, g, b, c[3]];
}

/** 两个颜色按比例混（含 alpha；Lua 只混 RGB） */
function mixColors(a: RGBA, b: RGBA, t: number): RGBA {
  return [
    Math.round(lerp(a[0], b[0], t)),
    Math.round(lerp(a[1], b[1], t)),
    Math.round(lerp(a[2], b[2], t)),
    Math.round(lerp(a[3], b[3], t)),
  ];
}

/** 把色相直接设成 `hue`（度）再按比例混回来：这就是「掺温度色」 */
function shiftShading(c: RGBA, hue: number, proportion: number): RGBA {
  const [, s0, l0] = rgbToHsl(c[0], c[1], c[2]);
  const [r, g, b] = hslToRgb(hue, s0, l0);
  return mixColors(c, [r, g, b, c[3]], proportion);
}

/**
 * 六条色阶一次算出来。`base` 是基色，`other` 只用于 Mix 行（Lua 里是 FG + BG）。
 * 正中间那格（奇数 slots）**逐位等于基色本身**，是整套配色的锚点。
 */
export function shadingRamps(base: RGBA, other: RGBA, params: Partial<ShadingParams> = {}): ShadingRamps {
  const p = normalizeParams(params);
  const { slots } = p;
  const out: ShadingRamps = { shade: [], light: [], sat: [], mix: [], nuance: [], hue: [] };
  const mid = (slots + 1) / 2;
  for (let i = 1; i <= slots; i++) {
    // Mix 行只跟两个基色有关：i/(slots+1) 从基色走到另一个基色（两端都不取满）
    out.mix.push(mixColors(base, other, i / (slots + 1)));
    // Hue 行：色相环上等距推进
    out.hue.push(shiftHue(base, i / (slots + 1)));
    if (i === mid) {
      out.shade.push([...base] as RGBA);
      out.light.push([...base] as RGBA);
      out.sat.push([...base] as RGBA);
      out.nuance.push([...base] as RGBA);
      continue;
    }
    // factor：中间为 0、越往两端越接近 ±1；暗部那半 neg=-1、亮部那半 neg=+1
    let factor = ((slots - 1) / 2 - i + 1) / ((slots - 1) / 2);
    let neg = -1;
    let temp = p.lowTemp;
    if (i > slots / 2) {
      factor = -factor;
      neg = 1;
      temp = p.highTemp;
    }
    const shaded = shiftShading(
      shiftSat(shiftLight(base, (p.peak / 100) * factor * neg), (p.intensity / 100) * factor),
      temp,
      (p.sway / 100) * factor,
    );
    out.shade.push(shaded);
    out.light.push(shiftLight(base, 0.4 * factor * neg));
    out.sat.push(shiftSat(base, 0.75 * factor * neg));
    out.nuance.push(shiftHue(base, ((mid - i) / (slots + 1)) * (2 / (slots + 1))));
  }
  return out;
}

/** 和声配色：Lua 的 Color Options（Compl. / Triad / Tetrad） */
export function shadingHarmonics(base: RGBA): ShadingHarmonics {
  return {
    complementary: [base, shiftHue(base, 0.5)],
    triadic: [base, shiftHue(base, 120 / 360), shiftHue(base, 240 / 360)],
    tetradic: [base, shiftHue(base, 90 / 360), shiftHue(base, 180 / 360), shiftHue(base, 270 / 360)],
  };
}

/** 按顺序摊平成一条颜色列表（「加入调色板」用），可选去重 */
export function flatRamps(ramps: ShadingRamps, rows: readonly ShadingRow[] = SHADING_ROWS, dedupe = true): RGBA[] {
  const out: RGBA[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const c of ramps[row]) {
      const key = c.join(",");
      if (dedupe && seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}
