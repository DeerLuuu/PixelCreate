// Drawing symmetry maths, shared by the stroke engine and the selection tools.
//
// One mirror axis through a pivot, optionally with the perpendicular axis
// (four-way). Everything here is pure so the pixel mapping is unit tested.
export interface SymAxis {
  /** false = symmetry disabled */
  on: boolean;
  /** also mirror across the perpendicular axis (four-way) */
  four: boolean;
  /** pivot offset from the document centre, in doc gridline units */
  ox: number;
  oy: number;
  /** mirror-line angle in degrees (0 = horizontal) */
  angDeg: number;
}

/** reflect one cell centre across the mirror line through (px,py) */
function reflect(x: number, y: number, px: number, py: number, ux: number, uy: number): [number, number] {
  const cx = x + 0.5 - px;
  const cy = y + 0.5 - py;
  const dot = cx * ux + cy * uy;
  return [
    Math.round(px + 2 * dot * ux - cx - 0.5),
    Math.round(py + 2 * dot * uy - cy - 0.5),
  ];
}

/** every cell a single cell maps to under the current symmetry (includes the
 *  cell itself; returns just itself when symmetry is off) */
export function mirrorCells(x: number, y: number, w: number, h: number, ax: SymAxis): Array<[number, number]> {
  if (!ax.on) return [[x, y]];
  const px = w / 2 + ax.ox;
  const py = h / 2 + ax.oy;
  const rad = (ax.angDeg * Math.PI) / 180;
  const ux = Math.cos(rad);
  const uy = Math.sin(rad);
  const out: Array<[number, number]> = [[x, y]];
  out.push(reflect(x, y, px, py, ux, uy));
  if (ax.four) {
    const u2x = -uy;
    const u2y = ux;
    const m2 = reflect(x, y, px, py, u2x, u2y);
    out.push(m2);
    out.push(reflect(m2[0], m2[1], px, py, ux, uy));
  }
  return out;
}

/** OR the mirrored copies of a selection mask back into it (in place).
 *  Used so a marquee / lasso / wand selection is mirrored like a stroke. */
export function mirrorMaskInPlace(mask: Uint8Array, w: number, h: number, ax: SymAxis): boolean {
  if (!ax.on || w <= 0 || h <= 0) return false;
  const src = new Uint8Array(mask); // snapshot: mirrors must not mirror again
  let added = false;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!src[y * w + x]) continue;
      for (const [mx, my] of mirrorCells(x, y, w, h, ax)) {
        if (mx < 0 || my < 0 || mx >= w || my >= h) continue;
        const i = my * w + mx;
        if (!mask[i]) { mask[i] = 1; added = true; }
      }
    }
  }
  return added;
}
