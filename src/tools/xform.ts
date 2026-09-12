// 选区自由变换（Aseprite 那一套）：移动 + 缩放 + 旋转 + 斜切，**纯仿射**。
//
// 与 `warp.ts` 的分工：
//   · `warp.ts`    = 四点 / 网格（透视、自由变形），是额外能力，口径不变；
//   · 本文件        = Aseprite 的常规变换：8 个物理锚点 + 枢轴 + 干净角吸附 + 斜切。
//
// 坐标口径（与 `warp.ts` 一致）：**像素下标空间**，像素 `i` 的中心在整数 `i` 上。
// 一块 w×h 的内容占下标 `0..w-1` / `0..h-1`（**不是** `w` / `h`），
// 所以「内容框」`indexBox(w, h)` 的两端就是 `0` 与 `w-1`，枢轴默认在其中心。
// 屏幕上画出来时下标再加 0.5（像素中心），与 `view.ts` 的 `warpHandles()` 同一口径。
//
// 本文件全是纯函数（无 DOM、无 Session），交互状态机在 `view.ts`，这里只负责
// 「几何 + 命中判定 + 拖拽解算」，因此可以单独单测。
import type { Mat3 } from "./warp";

/** 变换会话的语义：内圈＝缩放，外圈（角＝旋转 / 边中点＝斜切），枢轴＝自己一档 */
export type XfKind = "scale" | "rotate" | "skew" | "move" | "pivot";
/** 每一种语义对应的**历史标签**（一次会话一条，取会话里出现过的最高优先级那个） */
export const XF_LABEL: Record<XfKind, string> = {
  skew: "sel.skew", rotate: "sel.rotate", scale: "sel.scale", move: "sel.move", pivot: "sel.pivot",
};
/** 会话里出现多种语义时，谁的标签说了算（越靠前越优先） */
export const XF_LABEL_ORDER: XfKind[] = ["skew", "rotate", "scale", "move"];
/** 缩放的轴向：`x` 只改横向、`y` 只改纵向、`xy` 两轴（角上） */
export type XfAxis = "x" | "y" | "xy";
/** 8 个物理锚点：四个角 + 四条边的中点 */
export type AnchorId = "tl" | "t" | "tr" | "r" | "br" | "b" | "bl" | "l";

/** 8 个锚点，顺序固定（四角 + 四边中点，与 `selFramePts()` / `drawSelTransform()` 同序） */
export const ANCHORS: AnchorId[] = ["tl", "t", "tr", "r", "br", "b", "bl", "l"];

/** 锚点是不是角（角＝两轴缩放 / 旋转；边中点＝单轴缩放 / 斜切） */
export function isCorner(id: AnchorId): boolean {
  return id === "tl" || id === "tr" || id === "br" || id === "bl";
}

/** 锚点的轴向：角＝`xy`，上下边中点＝`y`，左右边中点＝`x` */
export function axisOf(id: AnchorId): XfAxis {
  return isCorner(id) ? "xy" : id === "t" || id === "b" ? "y" : "x";
}

export interface Pt { x: number; y: number }

/** 内容框（下标空间，两端都是下标、含端点） */
export interface XfBox { x0: number; y0: number; x1: number; y1: number }

/** 一块 w×h 内容在**下标空间**里的框：`0..w-1` / `0..h-1`（退化也允许） */
export function indexBox(w: number, h: number): XfBox {
  return { x0: 0, y0: 0, x1: Math.max(0, w - 1), y1: Math.max(0, h - 1) };
}

/** 框的四角，顺序：左上 → 右上 → 右下 → 左下（与 `floatQuad()` 同序） */
export function boxCorners(b: XfBox): Pt[] {
  return [
    { x: b.x0, y: b.y0 }, { x: b.x1, y: b.y0 },
    { x: b.x1, y: b.y1 }, { x: b.x0, y: b.y1 },
  ];
}

/** 框中心（枢轴预设的「中间」） */
export function boxCenter(b: XfBox): Pt {
  return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
}

/** 8 个锚点 + 框中心在**下标空间**里的位置 */
export function anchorPoint(b: XfBox, id: AnchorId): Pt {
  const c = boxCenter(b);
  switch (id) {
    case "tl": return { x: b.x0, y: b.y0 };
    case "t": return { x: c.x, y: b.y0 };
    case "tr": return { x: b.x1, y: b.y0 };
    case "r": return { x: b.x1, y: c.y };
    case "br": return { x: b.x1, y: b.y1 };
    case "b": return { x: c.x, y: b.y1 };
    case "bl": return { x: b.x0, y: b.y1 };
    case "l": return { x: b.x0, y: c.y };
  }
}

/**
 * 缩放的**不动点**＝被抓住的那个锚点的对角：抓手往外拉时内容从对面长出来，
 * 而不是绕中心两边一起长（Aseprite 同款）。
 * 角＝对角；上下边中点＝对边中点；左右边中点＝对边中点。
 */
export function scaleAnchor(b: XfBox, id: AnchorId): Pt {
  const c = boxCenter(b);
  switch (id) {
    case "tl": return { x: b.x1, y: b.y1 };
    case "tr": return { x: b.x0, y: b.y1 };
    case "br": return { x: b.x0, y: b.y0 };
    case "bl": return { x: b.x1, y: b.y0 };
    case "t": return { x: c.x, y: b.y1 };
    case "b": return { x: c.x, y: b.y0 };
    case "l": return { x: b.x1, y: c.y };
    case "r": return { x: b.x0, y: c.y };
  }
}

// ---------------------------------------------------------------- 干净角吸附
/** `atan(1/2)`，像素画的「干净角」最小步长（26.565°） */
const CLEAN = Math.atan(1 / 2);
const CLEAN_DEG = (CLEAN * 180) / Math.PI;                 // 26.56505117707799

/**
 * 像素画的**干净角**表（度）：`0 / 26.565 / 45 / 63.435 / 90 / 116.565 / 135 / 153.435 / 180 …`，
 * 即 `atan(1/2)` 与 `atan(2)` 的两个斜率族 —— 也就是像素里不会出现「锯齿台阶」的角度。
 *
 * 注意：**不是 15° 倍数**（那会把 `26.565` 吸到 `30`）。Aseprite 的 Shift 旋转吸附用的就是这套。
 * 序列以 45° 为周期：每 45° 里 0°、`26.565°`、45° 三个点。
 */
export const CLEAN_ANGLES_DEG: number[] = (() => {
  const out: number[] = [];
  // 0..180 每 45° 一格里放「45 的倍数」与「45 的倍数 + atan(1/2)」两个角；
  // 负半轴照抄一份（0 与 ±180 只留一份）
  for (let q = 0; q < 4; q++) {
    const base = q * 45;
    out.push(base, base + CLEAN_DEG);
  }
  out.push(180);
  const neg = out.slice().reverse().map((d) => -d).sort((a, b) => a - b);
  return [...neg.filter((d) => d > -180 && d < 0), ...out];
})();

/** 干净角表（弧度，与 `CLEAN_ANGLES_DEG` 一一对应） */
export const CLEAN_ANGLES_RAD: number[] = CLEAN_ANGLES_DEG.map((d) => (d * Math.PI) / 180);

/** 弧度归一到 `(-π, π]` */
export function normAngle(a: number): number {
  const t = Math.PI * 2;
  let r = a % t;
  if (r <= -Math.PI) r += t;
  else if (r > Math.PI) r -= t;
  return r;
}

/**
 * 把角度吸到最近的干净角。**按圆周距离**找最近的（不按数值差）：
 * `-89°` 要吸到 `-90°` 而不是 `0°`，`179°` 要吸到 `180°`。
 */
export function snapCleanAngle(rad: number): number {
  const a = normAngle(rad);
  let best = CLEAN_ANGLES_RAD[0], bd = Infinity;
  for (const c of CLEAN_ANGLES_RAD) {
    const d = Math.abs(normAngle(a - c));       // 圆上距离（-180..180 归一后取绝对值）
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

/** 角度是不是 90° 的整数倍（像素精确通道的前提） */
export function isRightAngle(rad: number): boolean {
  const q = Math.round(rad / (Math.PI / 2));
  return Math.abs(rad - q * (Math.PI / 2)) < 1e-9;
}

/** 归一到 `0..3` 的 90° 倍数序号（0=0°, 1=90°, 2=180°, 3=270°） */
export function rightAngleSteps(rad: number): number {
  return ((Math.round(rad / (Math.PI / 2)) % 4) + 4) % 4;
}

/** 整数平移只该走「逐像素搬运」：位移必须是整数（浮点毛刺容差与 `snapRound` 同量级） */
export function isIntegerShift(v: number): boolean {
  return Math.abs(v - Math.round(v)) < 1e-9 * Math.max(1, Math.abs(v));
}

// ---------------------------------------------------------------- 缩放钳制
/**
 * 缩放倍率的钳制范围。**下界不能是 0**（矩阵不可逆、`1/s` 会炸成 Infinity），
 * 上界也不能空着：极端值会让目标包围盒算成天文数字、`new Uint8ClampedArray` 直接爆内存
 * （用户报过 segfault）。0.02..40 与旧实现一致，够用且安全。
 */
export const SCALE_MIN = 0.02;
export const SCALE_MAX = 40;
export function clampScale(s: number): number {
  if (!Number.isFinite(s)) return s > 0 ? SCALE_MAX : s < 0 ? -SCALE_MAX : SCALE_MIN;
  // **按绝对值钳制、保留正负号**：负值＝镜像翻转（拖过对面那一边），
  // 直接 `clamp(s, 0.02, 40)` 会把翻转悄悄变成 0.02×，把内容缩成一小团。
  const mag = Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.abs(s)));
  return s < 0 ? -mag : mag;
}
/** 斜切的 ±85° 钳制（`tan(85°) ≈ 11.43`）：不能让斜切退化成无穷大 */
export const SKEW_LIMIT_DEG = 85;
export const TAN_SKEW_LIMIT = Math.tan((SKEW_LIMIT_DEG * Math.PI) / 180);
export function clampTan(t: number): number {
  if (!Number.isFinite(t)) return t > 0 ? TAN_SKEW_LIMIT : -TAN_SKEW_LIMIT;
  return Math.min(TAN_SKEW_LIMIT, Math.max(-TAN_SKEW_LIMIT, t));
}

// ---------------------------------------------------------------- 仿射矩阵
// 3x3 行主序，与 `warp.ts` 的 `Mat3` 同一布局（`[a, b, c, d, e, f, 0, 0, 1]` 的推广）。
// 采用**列向量**约定：`p' = M · p`，即
//   x' = m0*x + m1*y + m2
//   y' = m3*x + m4*y + m5
// 注意这与 `warp.ts` 的 `applyMat()` 相反（那是单应的「目标 → 源」反向映射，
// 行向量写法），所以本文件另配 `applyAffine()`，不要混用。

/** 单位阵 */
export function affineIdentity(): Mat3 {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

/** 用点正向应用仿射：`p' = M · p` */
export function applyAffine(m: Mat3, p: Pt): Pt {
  return { x: m[0] * p.x + m[1] * p.y + m[2], y: m[3] * p.x + m[4] * p.y + m[5] };
}

/** 矩阵乘法 `a · b`（先 b 后 a），只取前两行 */
export function mulAffine(a: Mat3, b: Mat3): Mat3 {
  return [
    a[0] * b[0] + a[1] * b[3], a[0] * b[1] + a[1] * b[4], a[0] * b[2] + a[1] * b[5] + a[2],
    a[3] * b[0] + a[4] * b[3], a[3] * b[1] + a[4] * b[4], a[3] * b[2] + a[4] * b[5] + a[5],
    0, 0, 1,
  ];
}

/** 求逆（仿射部分 2x2 行列式为 0 时返回 null） */
export function invertAffine(m: Mat3): Mat3 | null {
  const det = m[0] * m[4] - m[1] * m[3];
  if (Math.abs(det) < 1e-12) return null;
  const id = 1 / det;
  const a = m[4] * id, b = -m[1] * id, d = -m[3] * id, e = m[0] * id;
  return [a, b, -(a * m[2] + b * m[5]), d, e, -(d * m[2] + e * m[5]), 0, 0, 1];
}

export interface XfParams {
  /** 枢轴（下标空间）＝整个变换的不动点 */
  pivot: Pt;
  /** 会话**起点**的枢轴：枢轴被拖动后，用它算「画面不动」的补偿位移 */
  pivot0?: Pt;
  /** 旋转（弧度） */
  angle: number;
  /** 两轴缩放（可以为负＝镜像翻转） */
  sx: number;
  sy: number;
  /** 斜切：`skewX` 让 x 跟着 y 走（上下边中点拖出来的），`skewY` 反过来 */
  skewX?: number;
  skewY?: number;
  /**
   * 斜切的基准点：**被拖的那条边**（默认＝枢轴）。
   * 斜切的基准线是「过基准点的那条水平 / 垂直线」，被拖的边整条沿边方向平移、
   * 对面那条边一动不动（Aseprite 的行为，见 `solveSkew()`）。
   */
  skewPivot?: Pt;
  /** 纯平移位移（下标空间，累计；「移动」语义与旋转时的落点都看它） */
  shift?: Pt;
  /** 斜切基准点（`skewPivot` 的别名，视图侧把它挂在变换参数上，见 `View.xfParams()`） */
  skewAnchor?: Pt;

  /** 枢轴拖动产生的补偿位移（`pivotComp()` 算出，同样折进矩阵的平移分量） */
  pivot0Shift?: Pt;
}

/** 把「枢轴被拖走」这件事折成矩阵上的补偿位移：拖动前后画面必须逐像素不动。
 *
 *  设变换为 `p' = R·K·S·(p - pivot) + pivot + shift`（见 `affineFrom()`）：
 *  把枢轴从 `pivot0` 挪到 `pivot1` 时要保持 `p'` 不变，需要
 *      `shift1 = shift0 + (pivot0 - pivot1) - L·(pivot1 - pivot0)`，`L = R·K·S`
 *  —— 即「枢轴自己挪了多少」抵消掉「枢轴挪动引起的整体位移」。
 */
export function pivotComp(p: XfParams): Pt {
  if (!p.pivot0) return { x: 0, y: 0 };
  const d = { x: p.pivot0.x - p.pivot.x, y: p.pivot0.y - p.pivot.y };
  const l = linearOf(p);
  const ld = { x: l[0] * d.x + l[1] * d.y, y: l[2] * d.x + l[3] * d.y };
  return { x: d.x - ld.x, y: d.y - ld.y };
}

/** 线性部分 `L = R · K · S`（不含平移） */
export function linearOf(p: XfParams): [number, number, number, number] {
  const c = Math.cos(p.angle), s = Math.sin(p.angle);
  const kx = p.skewX ?? 0, ky = p.skewY ?? 0;
  const k00 = p.sx, k01 = kx * p.sy;
  const k10 = ky * p.sx, k11 = p.sy;
  return [c * k00 - s * k10, c * k01 - s * k11, s * k00 + c * k10, s * k01 + c * k11];
}

/**
 * 组装变换矩阵：**先缩放 → 再斜切 → 最后旋转**，全部绕枢轴，再叠加平移。
 * 斜切按 Aseprite 的 `dx += dy * tan(skew)`（枢轴所在的那条线是不动的基准线）：
 * 于是「拖上边中点」＝整条上边沿边方向平移，对面那条边一动不动。
 *
 * 平移项 `shift`（纯移动 / 枢轴补偿）在**旋转之后**叠加：像素画里「移动」永远是
 * 屏幕方向的整格位移，不该被旋转角带着拐弯。
 */
export function affineFrom(p: XfParams): Mat3 {
  // 复合 = `S`（绕枢轴缩放）→ `K`（以 `skewPivot` 为原点斜切）→ `R`（绕枢轴旋转）。
  // 线性部分 `L = R · K · S`，平移分量在「**枢轴不动**」下反解：`t = c - L·c`。
  // 斜切的固定线由 `skewPivot` 决定（视图层把它设成枢轴那条线，见 `skewPivotOf()`）。
  const kx = p.skewX ?? 0, ky = p.skewY ?? 0;
  const co = Math.cos(p.angle), si = Math.sin(p.angle);
  const k00 = p.sx, k01 = kx * p.sy;
  const k10 = ky * p.sx, k11 = p.sy;
  const m00 = co * k00 - si * k10, m01 = co * k01 - si * k11;
  const m10 = si * k00 + co * k10, m11 = si * k01 + co * k11;
  const px = p.pivot.x, py = p.pivot.y;
  const sh = p.shift ?? { x: 0, y: 0 };
  const cmp = p.pivot0Shift ?? { x: 0, y: 0 };
  return [
    m00, m01, px - m00 * px - m01 * py + sh.x + cmp.x,
    m10, m11, py - m10 * px - m11 * py + sh.y + cmp.y,
    0, 0, 1,
  ];
}

/** 平移矩阵 */
export function affineTranslate(dx: number, dy: number, m?: Mat3): Mat3 {
  const t: Mat3 = [1, 0, dx, 0, 1, dy, 0, 0, 1];
  return m ? mulAffine(t, m) : t;
}

/** 绕 `c` 缩放：`T(c) · S · T(-c)`（线性部分是对角的，两种写法等价） */
export function affineScale(sx: number, sy: number, c: Pt): Mat3 {
  return [sx, 0, c.x * (1 - sx), 0, sy, c.y * (1 - sy), 0, 0, 1];
}

/** 绕 `c` 旋转：`T(c) · R · T(-c)` */
export function affineRotate(a: number, c: Pt = { x: 0, y: 0 }): Mat3 {
  const co = Math.cos(a), si = Math.sin(a);
  return [co, -si, c.x - co * c.x + si * c.y, si, co, c.y - si * c.x - co * c.y, 0, 0, 1];
}

/**
 * 绕 `c` 斜切：`skewX` 是 `dx += dy * tan`（上下边中点拖出来的），`skewY` 反过来。
 * `c` 就是**基准点**：过它的那条水平 / 垂直线是不动线 —— 拖上边中点时 `c` 放在上边，
 * 于是整条上边沿边方向平移、下边一动不动（Aseprite 的行为，见 `solveSkew()`）。
 */
export function affineSkew(kx: number, ky: number, c: Pt): Mat3 {
  // `T(c)·K·T(-c)` 展开：`K·(p - c) + c = K·p + (c - K·c)`，
  // 而 `K·c = (c.x + kx·c.y, ky·c.x + c.y)`，于是平移分量是 `(-kx·c.y, -ky·c.x)`。
  // 注意**不能**写成 `T(c)·(K·T(-c))`：那样 `K` 会把 `T(-c)` 的平移又乘一遍。
  return [1, kx, -kx * c.y, ky, 1, -ky * c.x, 0, 0, 1];
}

/** 变换后内容（w×h 的框）在目标空间的包围盒：`floor..ceil`，含端点（栅格化范围与它一致） */
export function transformedBox(m: Mat3, w: number, h: number): XfBox {
  const cs = boxCorners(indexBox(w, h)).map((p) => applyAffine(m, p));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of cs) {
    if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
  }
  return { x0: Math.floor(x0), y0: Math.floor(y0), x1: Math.ceil(x1), y1: Math.ceil(y1) };
}

// ---------------------------------------------------------------- 拖拽解算
/** 缩放的解算结果 */
export interface ScaleSolution { sx: number; sy: number }
/** 旋转的解算结果 */
export interface RotateSolution { angle: number; snapped: boolean }
/** 斜切的解算结果（`tan` 已钳制到 ±85°） */
export interface SkewSolution { tan: number }

/** 把屏幕位移投影到框自身的两个轴上（框可能已经转过角度：拖动要在**框内**量） */
export function toFrameLocal(dx: number, dy: number, angle: number): Pt {
  const c = Math.cos(-angle), s = Math.sin(-angle);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

/**
 * 缩放：锚点（对角 / 对边中点）是不动点，抓手从 `from` 拖到 `to`（都已在框内坐标系里）。
 *
 * 负值＝镜像翻转（Aseprite：拖过对面那一边就翻过来），所以两轴都**不取绝对值**。
 * `keepAspect`（Shift / 「等比」开关）＝按两轴里变化更大的那一个等比缩放。
 */
export function solveScale(
  from: Pt, to: Pt, anchor: Pt, axis: XfAxis, keepAspect = false, gridSnap = false,
): ScaleSolution {
  const f0x = from.x - anchor.x, f0y = from.y - anchor.y;
  const f1x = to.x - anchor.x, f1y = to.y - anchor.y;
  const pick = (a: number, b: number): number => {
    if (Math.abs(a) < 1e-6) return 1;                 // 抓手正压不动点上：不改这一轴
    const s = b / a;
    return gridSnap ? Math.round(s) || (s < 0 ? -1 : 1) : s;
  };
  let sx = axis === "y" ? 1 : pick(f0x, f1x);
  let sy = axis === "x" ? 1 : pick(f0y, f1y);
  if (keepAspect && axis === "xy") {
    // 变化更大的那一轴说了算（绝对值比，方向各自保留＝允许翻转）
    const k = Math.abs(sx) >= Math.abs(sy) ? sx : sy;
    sx = k; sy = k;
  }
  sx = axis === "y" ? 1 : clampScale(sx);
  sy = axis === "x" ? 1 : clampScale(sy);
  return { sx, sy };
}

/**
 * 旋转：`from` / `to` 是抓手相对枢轴的位置（会话起点的那个位置 → 当前位置）。
 *
 * 直接量「`from` 指向 `to` 的方向」而不是「两者各自的方位角之差」，有一个实际好处：
 * 手指起点与抓手圆心总差着几十像素，指针走直线时这个差会污染方位角；按**位移方向**
 * 量则与「把抓手拖到哪」完全一致，拖 90° 就是 90°。
 *
 * `snap`（Shift / 「角度吸附」开关）＝吸到**干净角**表（见 `CLEAN_ANGLES_DEG`）。
 * 注意吸附只在**等价角**（相差整圈）里挑最近的：拖过 90° 再往回一点仍然落在 90°，
 * 而不会跳到 `-153.435°` 那种"数值上更近、画面上却翻了半个圈"的角上。
 */
export function solveRotate(from: Pt, to: Pt, snap: boolean): RotateSolution {
  const raw = normAngle(Math.atan2(to.y, to.x) - Math.atan2(from.y, from.x));
  if (!snap) return { angle: raw, snapped: false };
  const c = snapCleanAngle(raw);
  // 在 c ± 2π 里挑离 raw 最近的那个（等价角）
  let best = c, bd = Math.abs(c - raw);
  for (const k of [-1, 1]) {
    const t = c + k * Math.PI * 2;
    const d = Math.abs(t - raw);
    if (d < bd) { bd = d; best = t; }
  }
  return { angle: best, snapped: true };
}

/**
 * 斜切：把握手在**框内**的位移换算成 `tan(skew)`。
 *
 * 矩阵是 `x' = x + kx·(y - 基准线)`（上下边）与 `y' = y + ky·(x - 基准线)`（左右边），
 * 基准线就是**枢轴所在的那条线**（Aseprite 的 `dx += dy·tan(skew)` 同款）。
 * 于是被拖的边整条平移 `t·h/2`、对面那条边反向平移同样的量 —— 选中框围绕枢轴保持形状，
 * 拖出来的格数一眼能算（`Δ` 是屏幕上换算到下标空间的拖动量，`h` 是框在被拖方向上的跨度）。
 */
export function solveSkew(id: AnchorId, from: Pt, to: Pt, span: number): SkewSolution {
  if (isCorner(id)) return { tan: 0 };
  const horiz = id === "t" || id === "b";
  const local = toFrameLocal(to.x - from.x, to.y - from.y, 0);
  const delta = horiz ? local.x : local.y;
  if (!(span > 1e-6)) return { tan: 0 };
  const SIGN: Record<"t" | "b" | "l" | "r", number> = { t: -1, b: 1, l: -1, r: 1 };
  return { tan: clampTan((delta * SIGN[id]) / span) };
}

/** 斜切的**固定直线**（＝被拖那条边的对面中点）：那条边一动不动，被拖的边整条平移 */
export function skewBaseline(b: XfBox, id: AnchorId): Pt {
  return scaleAnchor(b, id);
}

/** 把固定线转成「剪切原点」：水平剪切看 `y`、竖直剪切看 `x`（另一个坐标清零） */
export function skewPivotOf(id: AnchorId, fixed: Pt): Pt {
  return id === "t" || id === "b" ? { x: 0, y: fixed.y } : { x: fixed.x, y: 0 };
}

// ---------------------------------------------------------------- 枢轴
/** 枢轴的 9 档预设（Aseprite 的 3×3 菜单）：四角 + 四边中点 + 中心，顺序＝菜单行主序 */
export type PivotPreset = "tl" | "tc" | "tr" | "cl" | "cc" | "cr" | "bl" | "bc" | "br";
export const PIVOT_PRESETS: PivotPreset[] = ["tl", "tc", "tr", "cl", "cc", "cr", "bl", "bc", "br"];

/** 第 `i` 档预设（循环用：`i` 会自动取模） */
export function pivotPresetAt(i: number): PivotPreset {
  const n = PIVOT_PRESETS.length;
  return PIVOT_PRESETS[((Math.round(i) % n) + n) % n];
}

/** 预设对应的下标空间坐标 */
export function pivotPresetPoint(b: XfBox, k: PivotPreset): Pt {
  const c = boxCenter(b);
  // 行主序：tl tc tr / cl cc cr / bl bc br（`t`/`c`/`b` 是行，`l`/`c`/`r` 是列）
  const map: Record<PivotPreset, Pt> = {
    tl: { x: b.x0, y: b.y0 }, tc: { x: c.x, y: b.y0 }, tr: { x: b.x1, y: b.y0 },
    cl: { x: b.x0, y: c.y }, cc: { x: c.x, y: c.y }, cr: { x: b.x1, y: c.y },
    bl: { x: b.x0, y: b.y1 }, bc: { x: c.x, y: b.y1 }, br: { x: b.x1, y: b.y1 },
  };
  return map[k];
}
/** 当前枢轴最接近哪一档预设（UI 高亮用） */
export function pivotPresetOf(b: XfBox, p: Pt): PivotPreset {
  let best: PivotPreset = "cc", bd = Infinity;
  for (const k of PIVOT_PRESETS) {
    const q = pivotPresetPoint(b, k);
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < bd) { bd = d; best = k; }
  }
  return best;
}

/**
 * 缩放后枢轴**按归一化比例跟位**（Aseprite 的 `adjustPivot`）：枢轴在框内的相对位置不变。
 * Aseprite 的源码是拿「枢轴到四角的距离」那套公式算的，这里用等价的**归一化比例**写法，
 * 在轴上（框的某条边界上）也稳定。
 *
 * 注意：**旋转不动枢轴**（枢轴就是旋转中心，原地不动），所以这条只在缩放时调用。
 * 对应的视图侧逻辑见 `view.ts` 的 `xfMove()`。
 *
 * @param oldBox 变换前的框（下标空间）
 * @param newBox 变换后的框
 */
export function adjustPivot(oldBox: XfBox, newBox: XfBox, pivot: Pt): Pt {
  const spanX = oldBox.x1 - oldBox.x0, spanY = oldBox.y1 - oldBox.y0;
  const nx = spanX > 1e-9 ? (pivot.x - oldBox.x0) / spanX : 0.5;
  const ny = spanY > 1e-9 ? (pivot.y - oldBox.y0) / spanY : 0.5;
  return {
    x: newBox.x0 + nx * (newBox.x1 - newBox.x0),
    y: newBox.y0 + ny * (newBox.y1 - newBox.y0),
  };
}

/** 枢轴点是否在框内（含边界） */
export function pivotInBox(b: XfBox, p: Pt): boolean {
  return p.x >= b.x0 - 0.5 && p.x <= b.x1 + 0.5 && p.y >= b.y0 - 0.5 && p.y <= b.y1 + 0.5;
}

/**
 * 修改枢轴时要顺手把**待提交的像素结果**表达成「相对新枢轴的等值参数」。
 *
 * 枢轴是矩阵的组装基准（`affineFrom()` 把旋转 / 缩放都放在它周围），
 * 枢轴一拖，如果角度 / 缩放 / 斜切原样保留，画面就会整体跳一下。
 * 把角度改成 `新的枢轴→原枢轴` 的方向差、把位移 △ 转成平移即可保持画面不动：
 *   · 平移：`p' = M(p - pivot) + pivot`，要让它等于旧结果就补一个
 *     `(pivot_new - pivot_old) - R·K·S·(pivot_new - pivot_old)`（见 `pivotShift()`）；
 *   · 旋转：吸到「干净角」时新枢轴不一定在旋转中心上，角度要补 `atan2` 差。
 *
 * 本文件只给纯函数，实际调用见 `view.ts`。
 */
export function pivotShift(m: Mat3, oldPivot: Pt, newPivot: Pt): Pt {
  const d = { x: newPivot.x - oldPivot.x, y: newPivot.y - oldPivot.y };
  const md = applyAffine(m, d);
  return { x: d.x - md.x, y: d.y - md.y };
}

// ---------------------------------------------------------------- 屏幕上的一层（命中 / 绘制）
/** 变换框在屏幕上的样子（`view.ts` 算出来后交给这里做命中判定与落点） */
export interface ScreenFrame {
  /** 框的四角（屏幕坐标，左上 → 右上 → 右下 → 左下），已含旋转 */
  corners: Pt[];
  /** 框的旋转角（= 变换角，弧度） */
  angle: number;
  /** 内容框在屏幕上的尺寸（像素），用于判断「小选区」 */
  spanX: number;
  spanY: number;
}

/** 由「下标空间的框 + 变换矩阵 + 视口」算出屏幕上的框（画与命中通用） */
export function screenFrameOf(m: Mat3, w: number, h: number, zoom: number, ox: number, oy: number): ScreenFrame {
  const cs = boxCorners(indexBox(w, h))
    .map((p) => applyAffine(m, p))
    // 下标 → 屏幕：像素中心 `(i + 0.5) * zoom + o`
    .map((p) => ({ x: (p.x + 0.5) * zoom + ox, y: (p.y + 0.5) * zoom + oy }));
  const spanX = Math.hypot(cs[1].x - cs[0].x, cs[1].y - cs[0].y);
  const spanY = Math.hypot(cs[3].x - cs[0].x, cs[3].y - cs[0].y);
  // 屏幕上的旋转角＝框方向（以「上边指向右」为 0°）
  const angle = Math.atan2(cs[1].y - cs[0].y, cs[1].x - cs[0].x);
  return { corners: cs, angle, spanX, spanY };
}

/** 框在屏幕上的 8 个锚点位置（角 + 边中点，与 `ANCHORS` 同序） */
export function screenAnchors(f: ScreenFrame): Pt[] {
  const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const [tl, tr, br, bl] = f.corners;
  return [
    tl, mid(tl, tr), tr, mid(tr, br), br, mid(br, bl), bl, mid(bl, tl),
  ];
}

/** 命中半径（屏幕像素常量）：内圈＝缩放，外圈＝旋转 / 斜切 */
export interface HitRadii { inner: number; outer: number }

/**
 * PC：Aseprite 的**两层同心命中圈**。内圈（≈2× 手柄宽）＝缩放，
 * 外圈（≈3×）＝角上旋转、边中点上斜切。半径是**屏幕像素常量**：不随画布 zoom 变，
 * 所以放大画布时手柄不会变难按。
 */
export const PC_HIT: HitRadii = { inner: 22, outer: 34 };
/**
 * 触屏：**独立抓手**（不是「再往外一点」）。半径与偏移全部是**屏幕像素常量**。
 *
 * 布局的硬约束：**任意两个抓手的触摸区不相交**（圆心距 ≥ 2×命中半径）。
 * 手机上一块选区在屏幕上的大小差别极大（画布 zoom 从 0.05× 到 8×），
 * 「所有抓手都 ≥40px 且互不重叠」在小选区上物理上做不到，所以按**分档**来：
 *
 * | 短边（屏幕 px） | 摆的抓手 | 命中半径 |
 * |---|---|---|
 * | ≥ 160 | 4 角缩放 + 4 边单轴缩放 + 4 旋转 + 4 斜切（16 个） | 41 |
 * | ≥ 80  | 4 角缩放 + 4 旋转（8 个） | 41 |
 * | ≥ 60  | 4 角旋转（4 个，兼作缩放） | 41 |
 * | < 60  | 4 角缩放（4 个，最不挤的排法） | max(28, 短边/2)，真实值由 `touchHitRadius()` 给 |
 *
 * 外移距离按「相邻抓手圆心距 ≥ 2×38px」反解：角缩放 46、边缩放 46、旋转 / 斜切 144
 * （见 `tests/xform.test.ts` 的 `touch.no-overlap`：各档实测最小圆心距 ≈ 98px ≥ 76px）。
 */
export const TOUCH_HIT: HitRadii = { inner: 38, outer: 38 };
/** 抓手沿「远离框中心」方向的外移距离（角 / 边 / 旋转与斜切三档） */
export const TOUCH_OFF_CORNER = 46;
export const TOUCH_OFF_EDGE = 46;
export const TOUCH_OFF_OUTER = 144;
/** 触屏分档阈值（框的短边，屏幕像素） */
export const TOUCH_FULL_SPAN = 160;
export const TOUCH_MID_SPAN = 80;
export const TOUCH_MIN_SPAN = 60;
/** 极小选区下命中半径的下限（再小就真的点不到了，宁可叠着） */
export const TOUCH_HIT_FLOOR = 28;
/** 旋转 / 斜切抓手的外移距离随框长大：`TOUCH_OFF_OUTER + 0.6 × max(0, 短边 - TOUCH_FULL_SPAN)`。
 *  这样「16 个抓手」那一档在任意尺寸下最小圆心距都 ≥ 75px（每 160px 多留 96px）。 */
export function touchOuterOffset(minSpan: number): number {
  return TOUCH_OFF_OUTER + 0.6 * Math.max(0, minSpan - TOUCH_FULL_SPAN);
}

/** 触屏抓手布局：每个物理锚点旁边挂哪几个独立抓手 */
export interface TouchLayout {
  /** 4 角缩放抓手 */
  corners: boolean;
  /** 4 边中点缩放抓手（单轴） */
  edges: boolean;
  /** 4 个旋转抓手（角外侧偏移） */
  rotate: boolean;
  /** 4 个斜切抓手（边中点外侧偏移） */
  skew: boolean;
}

/** 触屏布局决策（分档见文件头那张表；保证同档内**互不重叠**） */
export function touchLayout(spanX: number, spanY: number): TouchLayout {
  const minSpan = Math.min(spanX, spanY);
  if (minSpan >= TOUCH_MID_SPAN) {
    return {
      corners: true,
      edges: minSpan >= TOUCH_FULL_SPAN,
      rotate: true,
      skew: minSpan >= TOUCH_FULL_SPAN,
    };
  }
  return { corners: true, edges: false, rotate: false, skew: false };
}

/** 一个可点的抓手（屏幕坐标 + 语义） */
export interface Grab {
  kind: XfKind;
  /** 对应的物理锚点（`move` / `pivot` 没有） */
  anchor?: AnchorId;
  x: number;
  y: number;
}

/** 8 个锚点里，哪一个的外圈被命中了（角 ＝ 旋转，边中点 ＝ 斜切） */
export function outerKindOf(id: AnchorId): XfKind {
  return isCorner(id) ? "rotate" : "skew";
}

/**
 * 触屏的抓手摆位：缩放抓手沿「远离框中心」的方向外移，旋转 / 斜切抓手再往外一档。
 * `layout` 决定摆哪几个（见 `touchLayout()`）。
 *
 * 角缩放沿**角平分线**外移（不是沿屏幕轴）：这样它与同角的旋转抓手、相邻角 / 相邻边的
 * 抓手之间距离都够，具体数值由 `tests/xform.test.ts` 钉住。
 */
export function touchGrabs(f: ScreenFrame, layout: TouchLayout, offCorner = TOUCH_OFF_CORNER,
  offEdge = TOUCH_OFF_EDGE, offOuter = touchOuterOffset(Math.min(f.spanX, f.spanY))): Grab[] {
  const anchors = screenAnchors(f);
  const c = { x: (f.corners[0].x + f.corners[2].x) / 2, y: (f.corners[0].y + f.corners[2].y) / 2 };
  const away = (p: Pt, d: number): Pt => {
    const vx = p.x - c.x, vy = p.y - c.y;
    const len = Math.hypot(vx, vy) || 1;
    return { x: p.x + (vx / len) * d, y: p.y + (vy / len) * d };
  };
  const out: Grab[] = [];
  for (let i = 0; i < ANCHORS.length; i++) {
    const id = ANCHORS[i];
    if (isCorner(id)) {
      if (layout.corners) {
        const p = away(anchors[i], offCorner);
        out.push({ kind: "scale", anchor: id, x: p.x, y: p.y });
      }
      if (layout.rotate) {
        const p = away(anchors[i], offOuter);
        out.push({ kind: "rotate", anchor: id, x: p.x, y: p.y });
      }
    } else {
      if (layout.edges) {
        const p = away(anchors[i], offEdge);
        out.push({ kind: "scale", anchor: id, x: p.x, y: p.y });
      }
      if (layout.skew) {
        const p = away(anchors[i], offOuter);
        out.push({ kind: "skew", anchor: id, x: p.x, y: p.y });
      }
    }
  }
  return out;
}

/**
 * 触屏这一屏的**命中半径**：基准 41px（手指直径量级），但在小选区上会被
 * 「相邻抓手不许重叠」压下来（见 `touchLayout()` 的分档表）。
 * 取 `min(41, 两两最小圆心距 / 2)`，下限 `TOUCH_HIT_FLOOR`（28px）。
 * 调用方（`View.xfHitAt()`）拿它当命中半径，于是「画出来的圈」和「点得到的范围」永远一致。
 */
export function touchHitRadius(grabs: Grab[], base = TOUCH_HIT.inner): number {
  let min = Infinity;
  for (let i = 0; i < grabs.length; i++) {
    for (let j = i + 1; j < grabs.length; j++) {
      min = Math.min(min, Math.hypot(grabs[i].x - grabs[j].x, grabs[i].y - grabs[j].y));
    }
  }
  if (!Number.isFinite(min)) return base;
  return Math.max(TOUCH_HIT_FLOOR, Math.min(base, min / 2));
}

/** 找到一个屏幕点命中的抓手（近的优先；`r` 为命中半径） */
export function grabAt(grabs: Grab[], p: Pt, r: number): Grab | null {
  let best: Grab | null = null, bd = r;
  for (const g of grabs) {
    const d = Math.hypot(p.x - g.x, p.y - g.y);
    if (d <= bd) { bd = d; best = g; }
  }
  return best;
}

/** PC 的两层圈命中结果 */
export interface RingHit { anchor: AnchorId; kind: XfKind; ring: "inner" | "outer" }

/**
 * PC 的两层同心圈，**按锚点算**：先找最近的那个锚点，再看它落在哪一层
 * （≤`inner`＝缩放，≤`outer`＝角旋转 / 边中点斜切）。
 *
 * 不能「先全局找内圈、再全局找外圈」：小框上相邻锚点的内圈会互相压到，
 * 那样会把「明明贴着 A 的外圈」判成「稍远一点的 B 的内圈」，手感会忽然跳档。
 * 按最近锚点分层则永远归属最贴手的那个。
 */
export function ringHitAt(f: ScreenFrame, p: Pt, r: HitRadii = PC_HIT): RingHit | null {
  const anchors = screenAnchors(f);
  let best = -1, bd = Infinity;
  for (let i = 0; i < anchors.length; i++) {
    const d = Math.hypot(p.x - anchors[i].x, p.y - anchors[i].y);
    if (d < bd) { bd = d; best = i; }
  }
  if (best < 0 || bd > r.outer) return null;
  const id = ANCHORS[best];
  if (bd <= r.inner) return { anchor: id, kind: "scale", ring: "inner" };
  return { anchor: id, kind: outerKindOf(id), ring: "outer" };
}

/** 点到线段的距离（「只拖选区边框」的环带判定用） */
export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** 点到框四条边的最近距离 */
export function distToFrame(f: ScreenFrame, p: Pt): number {
  let d = Infinity;
  for (let i = 0; i < 4; i++) {
    const a = f.corners[i], b = f.corners[(i + 1) % 4];
    d = Math.min(d, distToSegment(p, a, b));
  }
  return d;
}

/** 点是否在框内（含边） —— 四角叉积同号 */
export function insideFrame(f: ScreenFrame, p: Pt): boolean {
  let pos = 0, neg = 0;
  for (let i = 0; i < 4; i++) {
    const a = f.corners[i], b = f.corners[(i + 1) % 4];
    const cr = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (cr > 0) pos++; else if (cr < 0) neg++;
  }
  return pos === 0 || neg === 0;
}

// ---------------------------------------------------------------- 像素精确搬运
/**
 * 平移 / 90° 倍数旋转走的**像素精确通道**：不重采样、逐像素整数搬运。
 *
 * `content` 是源像素（`w×h`），返回的 `dst` 尺寸＝转置后的尺寸（90° / 270° 时互换），
 * `dx` / `dy` 是**目标画布上的整数位移**（映射后的左上角落点）。
 * 命中判定见 `isExactTransform()`：只有「无斜切 + 无缩放（或 -1/1 的翻转）+ 角度是 90° 倍数」
 * 才允许走这条路，其余一律走最近邻重采样（`select.ts` 的 `xformAffineFloating()`）。
 *
 * 为什么必须留着这条路：像素画里「整格移动」和「转 90°」是**最高频**的两个操作，
 * 一旦重采样，1px 的线会变成 2px、颜色会被邻居串味 —— 用户一眼就能看出来。
 * 与 Aseprite 的 `TaskPixelExactMove`（`doc::move_image` + `flip_image`）同一个思路。
 */
export interface ExactMove {
  dst: Uint8ClampedArray;
  w: number;
  h: number;
  /** 结果像素本身（＝`dst`，形状与 `Pixmap` 兼容：便于再喂回 `exactMove()`） */
  data: Uint8ClampedArray;
}

/** 90° 倍数旋转后的尺寸（奇数圈互换宽高） */
export function rotatedSize(w: number, h: number, steps: number): { w: number; h: number } {
  const s = ((Math.round(steps) % 4) + 4) % 4;
  return s % 2 === 0 ? { w, h } : { w: h, h: w };
}

/**
 * 逐像素搬运（可选 90° 倍数旋转 + 1/-1 翻转），全程整数下标、不插值。
 * 源像素 `(x, y)` 在结果里的落点：
 *   steps=0：`(x, y)`；1：`(h-1-y, x)`；2：`(w-1-x, h-1-y)`；3：`(y, w-1-x)`
 * （转置再把宽高换过来，正是 `rotatedSize()` 的尺寸）
 */
export function exactMove(
  content: { w: number; h: number; data: Uint8ClampedArray },
  steps: number, flipX = false, flipY = false,
): ExactMove {
  const sw = content.w, sh = content.h;
  const size = rotatedSize(sw, sh, steps);
  const dw = size.w, dh = size.h;
  const dst = new Uint8ClampedArray(Math.max(0, dw) * Math.max(0, dh) * 4);
  const s = ((Math.round(steps) % 4) + 4) % 4;
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      let tx: number, ty: number;
      if (s === 0) { tx = x; ty = y; }
      else if (s === 1) { tx = sh - 1 - y; ty = x; }
      else if (s === 2) { tx = sw - 1 - x; ty = sh - 1 - y; }
      else { tx = y; ty = sw - 1 - x; }
      if (flipX) tx = dw - 1 - tx;
      if (flipY) ty = dh - 1 - ty;
      if (tx < 0 || ty < 0 || tx >= dw || ty >= dh) continue;
      const si = (y * sw + x) * 4, di = (ty * dw + tx) * 4;
      dst[di] = content.data[si];
      dst[di + 1] = content.data[si + 1];
      dst[di + 2] = content.data[si + 2];
      dst[di + 3] = content.data[si + 3];
    }
  }
  return { dst, w: dw, h: dh, data: dst };
}

/**
 * 这次变换能不能走像素精确通道？
 * 条件：没有斜切、角度是 90° 的整数倍、缩放是 ±1（0 被钳掉了，所以只看 ±1）。
 * 纯整数平移**总是**走这条路（`sx = sy = 1`、角度 0）。
 */
export function isExactTransform(p: XfParams): boolean {
  if ((p.skewX ?? 0) !== 0 || (p.skewY ?? 0) !== 0) return false;
  if (!isRightAngle(p.angle)) return false;
  const ok = (v: number): boolean => Math.abs(Math.abs(v) - 1) < 1e-9;
  return ok(p.sx) && ok(p.sy);
}
