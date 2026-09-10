// Geometry helpers for the floating-orb radial menus (pure, unit-tested).
export interface ChipBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** diameter of a ring item / palette swatch (`.orb-item`, `.orb-item.pal-c`) */
export const ORB_SIZE = 40;
/** floater (main ball) radius: the chip must never cover it */
export const FLOATER_R = 26;
/** source chip size (approximate, used for the overlap test) */
export const CHIP_W = 84;
export const CHIP_H = 22;
/** clearance between the floater and the chip */
const GAP = 10;
/** keeps the chip away from the screen edges */
const EDGE = 20;

/**
 * Fixed position for the palette-source chip: always centred on the floater's
 * x and a constant distance BELOW it, independent of how many swatches the fan
 * shows (so it never jumps around while colours change). When the floater sits
 * too close to the bottom edge the chip flips to the same offset above it.
 */
export function palChipPos(cx: number, cy: number, winW: number, winH: number, floaterR = FLOATER_R): { x: number; y: number } {
  const offset = floaterR + CHIP_H / 2 + GAP;
  const below = cy + offset;
  const y = below > winH - EDGE ? cy - offset : below;
  return {
    x: Math.max(CHIP_W / 2 + 4, Math.min(winW - CHIP_W / 2 - 4, cx)),
    y: Math.max(EDGE, Math.min(winH - EDGE, y)),
  };
}

/** bounding box of the chip centred on (x, y) */
export function chipBox(x: number, y: number): ChipBox {
  return { x, y, w: CHIP_W, h: CHIP_H };
}

/** true when a swatch centred at (sx, sy) would overlap the chip */
export function swatchHitsChip(sx: number, sy: number, chip: ChipBox, size = ORB_SIZE): boolean {
  const half = size / 2;
  return Math.abs(sx - chip.x) < half + chip.w / 2 && Math.abs(sy - chip.y) < half + chip.h / 2;
}

/** true when the chip would cover the floater itself (must never happen) */
export function chipCoversFloater(cx: number, cy: number, chip: { x: number; y: number }): boolean {
  const halfH = CHIP_H / 2 + 1;
  const halfW = CHIP_W / 2 + 1;
  return Math.abs(chip.x - cx) < halfW + FLOATER_R && Math.abs(chip.y - cy) < halfH + FLOATER_R;
}

/** 浮动球在一台设备上的尺寸表（PC 模式整体放大 1.2× 并让排布更散） */
export interface OrbMetrics {
  /** 主球直径（与 .orb 的 CSS 一致） */
  orb: number;
  /** 环形菜单项直径（与 .orb-item 一致） */
  item: number;
  /** 内/外环半径 */
  r1: number;
  r2: number;
  /** 调色球扇形的格距与起始半径 */
  fanGap: number;
  fanR0: number;
  /** 调色球扇形里色球的直径（移动端比环形子球小，扇形才不占地方） */
  palItem: number;
  /** 扇形排布的最大半径 */
  fanRMax: number;
  /** 主球半径（色板胶囊避让用） */
  floaterR: number;
}

/**
 * pure + unit tested：PC 模式下的浮动球几何。
 *
 * 色球（palette fan）与环形子球**同尺寸**（见 ORB_SIZE / item），所以扇形的
 * 格距 = 子球直径 + 12px 间隙、起始半径 = 主球半径 + 半个子球 + 10px，
 * 保证「球与球」「球与胶囊」都不重叠。
 */
export function orbMetrics(pc: boolean): OrbMetrics {
  const item = pc ? 48 : ORB_SIZE;
  const floaterR = pc ? 31 : FLOATER_R;
  // 调色球扇形：桌面端保持大尺寸（好点），移动端保持紧凑 —— 手机上色球太多时
  // 扇形会铺满半个屏幕，所以色球比环形子球小一圈、格距也更密。
  const palItem = pc ? 48 : 32;
  const fanGap = palItem + (pc ? 12 : 6);
  const fanR0 = floaterR + palItem / 2 + (pc ? 10 : 6);
  const fanRMax = pc ? 340 : 280;
  return pc
    ? { orb: 62, item, floaterR, palItem, fanGap, fanR0, fanRMax, r1: 103, r2: 154 }
    : { orb: 52, item, floaterR, palItem, fanGap, fanR0, fanRMax, r1: 86, r2: 128 };
}

/** 扇形排布：给定环上项数、扇形张角与项直径，返回「不重叠」所需的最小半径 */
export function fanRadius(count: number, spanDeg: number, item: number, gap = 6, minRadius = 0): number {
  if (count <= 1) return Math.max(minRadius, item);
  const step = (spanDeg * Math.PI) / 180 / (count - 1);
  const need = (item + gap) / (2 * Math.sin(step / 2));
  // +1px 余量：取整后仍保证间距严格大于 item + gap（避免浮点临界）
  return Math.max(minRadius, Math.ceil(need) + 1);
}

/**
 * 一个浮动球展开后的所有落点：内环 + 外环（按需扩容），并保证
 *  - 同环相邻项间距 ≥ item + gap
 *  - 两环半径差 ≥ item + gap（跨环也不重叠）
 * 纯函数，有测试。
 */
export function ringLayout(opts: {
  count: number; cx: number; cy: number; spanDeg: number;
  r1: number; r2: number; item: number; gap?: number; inner?: number;
}): Array<{ x: number; y: number }> {
  const { count, cx, cy, spanDeg, item, gap = 6 } = opts;
  const inner = Math.max(1, Math.min(opts.inner ?? Math.ceil(count / 2), count));
  const outer = count - inner;
  const r1 = fanRadius(inner, spanDeg, item, gap, opts.r1);
  const r2 = outer > 0
    ? Math.max(fanRadius(outer, spanDeg, item, gap, opts.r2), r1 + item + gap)
    : r1;
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < count; i++) {
    const onInner = i < inner;
    const k = onInner ? i : i - inner;
    const n = onInner ? inner : outer;
    const t = n <= 1 ? 0 : k / (n - 1);
    const r = onInner ? r1 : r2;
    // 扇形从「贴着水平轴」开始，角度按象限展开（与既有视觉一致）
    const a0 = 0, a1 = (spanDeg * Math.PI) / 180;
    const ang = a0 + (a1 - a0) * t;
    out.push({ x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r });
  }
  return out;
}
