// Geometry helpers for the floating-orb radial menus (pure, unit-tested).
export interface ChipBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** swatch diameter used by the palette fan (`.orb-item.pal-c`) */
export const ORB_SIZE = 30;
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
export function palChipPos(cx: number, cy: number, winW: number, winH: number): { x: number; y: number } {
  const offset = FLOATER_R + CHIP_H / 2 + GAP;
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
export function swatchHitsChip(sx: number, sy: number, chip: ChipBox): boolean {
  const half = ORB_SIZE / 2;
  return Math.abs(sx - chip.x) < half + chip.w / 2 && Math.abs(sy - chip.y) < half + chip.h / 2;
}

/** true when the chip would cover the floater itself (must never happen) */
export function chipCoversFloater(cx: number, cy: number, chip: { x: number; y: number }): boolean {
  const halfH = CHIP_H / 2 + 1;
  const halfW = CHIP_W / 2 + 1;
  return Math.abs(chip.x - cx) < halfW + FLOATER_R && Math.abs(chip.y - cy) < halfH + FLOATER_R;
}
