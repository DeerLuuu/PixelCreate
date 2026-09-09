// Selection operations, all exported via one `selOps` object.
import { Doc, Sel } from "../engine/doc";
import { Cel } from "../engine/cel";
import type { RGBA } from "../engine/types";
import type { History } from "../engine/history";
import { blendOver } from "../engine/color";
import { polygonCells } from "../engine/paint";

function record(doc: Doc, history: History, li: number, fi: number, before: Uint8ClampedArray | null, label: string): void {
  const cel = doc.celAt(li, fi);
  history.pushPixels(label, doc, [
    { li, fi, before, after: cel ? new Uint8ClampedArray(cel.data) : null },
  ]);
}

function setRectFn(doc: Doc, x0: number, y0: number, x1: number, y1: number): void {
  if (!doc.sel) doc.sel = new Sel(doc.w, doc.h, false);
  doc.sel.clear();
  const xa = Math.min(x0, x1), xb = Math.max(x0, x1);
  const ya = Math.min(y0, y1), yb = Math.max(y0, y1);
  for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) doc.sel!.set(x, y, 1);
}

function grabFn(doc: Doc, li: number, fi: number): Cel | null {
  if (!doc.sel || !doc.sel.hasAny()) return null;
  const b = doc.sel.bounds();
  const cel = doc.celAt(li, fi);
  if (!b || !cel) return null;
  const out = new Cel(b.w, b.h);
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      const sx = b.x + x, sy = b.y + y;
      if (doc.selAt(sx, sy) === 1) {
        const si = cel.idx(sx, sy);
        const oi = out.idx(x, y);
        out.data[oi] = cel.data[si];
        out.data[oi + 1] = cel.data[si + 1];
        out.data[oi + 2] = cel.data[si + 2];
        out.data[oi + 3] = cel.data[si + 3];
      }
    }
  }
  return out;
}


// ---- mask growth / shrink / wand / outline ----
export function wandSelect(doc: Doc, li: number, fi: number, x: number, y: number, tol: number): void {
  const cel = doc.celAt(li, fi);
  if (!cel || !cel.inBounds(x, y)) return;
  const w = cel.w, h = cel.h, d = cel.data;
  const bi = cel.idx(x, y);
  const baseR = d[bi], baseG = d[bi + 1], baseB = d[bi + 2], baseA = d[bi + 3];
  if (!doc.sel) doc.sel = new Sel(doc.w, doc.h, false);
  doc.sel.clear();
  const sel = doc.sel;
  const visited = new Uint8Array(w * h);
  const stack: [number, number][] = [[x, y]];
  const matches = (px: number, py: number): boolean => {
    const i = cel.idx(px, py);
    return (
      Math.abs(d[i] - baseR) <= tol && Math.abs(d[i + 1] - baseG) <= tol &&
      Math.abs(d[i + 2] - baseB) <= tol && Math.abs(d[i + 3] - baseA) <= tol
    );
  };
  while (stack.length) {
    const [cx, cy] = stack.pop()!;
    if (!cel.inBounds(cx, cy)) continue;
    const vi = cy * w + cx;
    if (visited[vi]) continue;
    visited[vi] = 1;
    if (!matches(cx, cy)) continue;
    sel.set(cx, cy, 1);
    stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
  }
}

export function growSelection(doc: Doc, px: number): void {
  if (!doc.sel) return;
  const w = doc.w, h = doc.h;
  const src = doc.sel.mask;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = false;
      outer: for (let dy = -px; dy <= px; dy++) {
        for (let dx = -px; dx <= px; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && src[ny * w + nx]) { on = true; break outer; }
        }
      }
      out[y * w + x] = on ? 1 : 0;
    }
  }
  doc.sel.mask = out;
  doc.sel.bump(); // the tint cache keys on this
}

export function shrinkSelection(doc: Doc, px: number): void {
  if (!doc.sel) return;
  const w = doc.w, h = doc.h;
  const src = doc.sel.mask;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let all = true;
      outer2: for (let dy = -px; dy <= px; dy++) {
        for (let dx = -px; dx <= px; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || !src[ny * w + nx]) { all = false; break outer2; }
        }
      }
      out[y * w + x] = all ? 1 : 0;
    }
  }
  doc.sel.mask = out;
  doc.sel.bump(); // the tint cache keys on this
}

export function outlineSelected(doc: Doc, history: History, li: number, fi: number, color: RGBA): void {
  const b = doc.sel?.bounds();
  const cel = doc.celAt(li, fi);
  if (!b || !cel) return;
  if (doc.layers[li]?.locked) return;
  const before = new Uint8ClampedArray(cel.data);
  const d = doc;
  const paint = (X: number, Y: number) => {
    if (X < 0 || Y < 0 || X >= cel.w || Y >= cel.h) return;
    const i = cel.idx(X, Y);
    if (color[3] >= 255) { cel.data[i] = color[0]; cel.data[i + 1] = color[1]; cel.data[i + 2] = color[2]; cel.data[i + 3] = 255; }
    else if (color[3] === 0) { cel.data[i] = 0; cel.data[i + 1] = 0; cel.data[i + 2] = 0; cel.data[i + 3] = 0; }
    else blendOver(cel.data, i, color);
  };
  for (let y = b.y; y < b.y + b.h; y++) {
    for (let x = b.x; x < b.x + b.w; x++) {
      if (d.selAt(x, y) !== 1) continue;
      const isBorder = d.selAt(x + 1, y) !== 1 || d.selAt(x - 1, y) !== 1 || d.selAt(x, y + 1) !== 1 || d.selAt(x, y - 1) !== 1;
      if (isBorder) paint(x, y);
    }
  }
  history.pushPixels("sel.outline", doc, [{ li, fi, before, after: new Uint8ClampedArray(cel.data) }]);
}


export function lassoFill(doc: Doc, pts: Array<[number, number]>): void {
  if (!doc.sel) doc.sel = new Sel(doc.w, doc.h, false);
  doc.sel.clear();
  const sel = doc.sel;
  polygonCells(doc.w, doc.h, pts, (x, y) => sel.set(x, y, 1));
}
/** One-time state captured when a selection-move gesture begins. */
export interface MoveState {
  /** grabbed opaque pixels (bbox of the original mask) at gesture start */
  content: Cel;
  /** whole-canvas selection mask at gesture start */
  mask: Uint8Array;
  /** top-left of the mask's bounding box (grab origin) */
  ox: number;
  oy: number;
  /** cel bytes at gesture start (drag-start picture) */
  before: Uint8ClampedArray;
}

/** Snapshot everything needed to move a selection without corrupting old content. */
export function beginMove(doc: Doc, li: number, fi: number): MoveState | null {
  if (!doc.sel || !doc.sel.hasAny()) return null;
  const b = doc.sel.bounds();
  const cel = doc.celAt(li, fi);
  if (!b || !cel) return null;
  const content = grabFn(doc, li, fi);
  if (!content) return null;
  return {
    content,
    mask: new Uint8Array(doc.sel.mask),
    ox: b.x,
    oy: b.y,
    before: new Uint8ClampedArray(cel.data),
  };
}



/**
 * Floating rotate/scale: rasterises the transformed selection content into
 * `out` (doc-sized RGBA) and moves the selection mask, WITHOUT touching the
 * layer cel. Returns the painted document pixel indices (for overlay drawing).
 */
export function xformFloating(
  doc: Doc, st: MoveState, angleRad: number, sx: number, sy: number,
  out: Uint8ClampedArray, anchorX?: number, anchorY?: number,
): number[] {
  const w = doc.w, h = doc.h;
  const content = st.content;
  const cw = content.w, ch = content.h;
  out.fill(0);
  const cells: number[] = [];
  const c = Math.cos(angleRad), sn = Math.sin(angleRad);
  // scale/rotate around a fixed anchor (the opposite handle); default = content centre
  const ax = anchorX === undefined ? st.ox + cw / 2 : anchorX;
  const ay = anchorY === undefined ? st.oy + ch / 2 : anchorY;
  const sxn = Math.max(0.02, sx), syn = Math.max(0.02, sy);
  // bounding box of the content corners transformed around the anchor
  const corners: [number, number][] = [[st.ox, st.oy], [st.ox + cw, st.oy], [st.ox, st.oy + ch], [st.ox + cw, st.oy + ch]];
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (const [cxx, cyy] of corners) {
    const rx = cxx - ax, ry = cyy - ay;
    const fx = ax + c * rx * sxn - sn * ry * syn;
    const fy = ay + sn * rx * sxn + c * ry * syn;
    const fxi = Math.round(fx), fyi = Math.round(fy);
    if (fxi < x0) x0 = fxi; if (fxi > x1) x1 = fxi;
    if (fyi < y0) y0 = fyi; if (fyi > y1) y1 = fyi;
  }
  x0 = Math.max(0, x0); y0 = Math.max(0, y0);
  x1 = Math.min(w - 1, x1); y1 = Math.min(h - 1, y1);
  if (!doc.sel) doc.sel = new Sel(w, h, false);
  const m = doc.sel.mask;
  m.fill(0);
  if (x0 > x1 || y0 > y1) return cells;
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const dx0 = px + 0.5 - ax, dy0 = py + 0.5 - ay;
      const vx = (dx0 * c + dy0 * sn) / sxn;
      const vy = (-dx0 * sn + dy0 * c) / syn;
      const sxx = ax + vx - st.ox;
      const syy = ay + vy - st.oy;
      if (sxx < 0 || syy < 0 || sxx >= cw || syy >= ch) continue;
      const si = content.idx(sxx | 0, syy | 0);
      if (content.data[si + 3] === 0) continue;
      const di = py * w + px, o = di * 4;
      out[o] = content.data[si];
      out[o + 1] = content.data[si + 1];
      out[o + 2] = content.data[si + 2];
      out[o + 3] = content.data[si + 3];
      cells.push(di);
      m[di] = 1;
    }
  }
  return cells;
}

export const selOps = {
  setRect: setRectFn,
  selectAll(doc: Doc): void {
    if (!doc.sel) doc.sel = new Sel(doc.w, doc.h, false);
    doc.sel.fillAll();
  },
  /** invert the selection: an empty selection becomes "everything", an
   *  existing one flips every pixel between selected and unselected */
  invert(doc: Doc): void {
    if (!doc.sel) doc.sel = new Sel(doc.w, doc.h, false);
    const m = doc.sel.mask;
    if (!doc.sel.hasAny()) { m.fill(1); doc.sel.bump(); return; }
    for (let i = 0; i < m.length; i++) m[i] = m[i] ? 0 : 1;
    doc.sel.bump();
  },
  clear(doc: Doc): void {
    if (doc.sel) doc.sel.clear();
  },
  grab: grabFn,
  fill(doc: Doc, history: History, li: number, fi: number, color: RGBA): void {
    if (!doc.sel || !doc.sel.hasAny() || doc.layers[li]?.locked) return;
    const b = doc.sel.bounds();
    if (!b) return;
    const cel = doc.ensureCel(li, fi);
    const before = new Uint8ClampedArray(cel.data);
    for (let y = b.y; y < b.y + b.h; y++) {
      for (let x = b.x; x < b.x + b.w; x++) {
        if (doc.selAt(x, y) === 1) {
          const i = cel.idx(x, y);
          if (color[3] >= 255) {
            cel.data[i] = color[0]; cel.data[i + 1] = color[1]; cel.data[i + 2] = color[2]; cel.data[i + 3] = 255;
          } else if (color[3] > 0) {
            blendOver(cel.data, i, color);
          }
        }
      }
    }
    record(doc, history, li, fi, before, "fill");
  },
  eraseSelected(doc: Doc, history: History, li: number, fi: number): void {
    if (!doc.sel || !doc.sel.hasAny() || doc.layers[li]?.locked) return;
    const b = doc.sel.bounds();
    if (!b) return;
    const cel = doc.ensureCel(li, fi);
    const before = new Uint8ClampedArray(cel.data);
    for (let y = b.y; y < b.y + b.h; y++) {
      for (let x = b.x; x < b.x + b.w; x++) {
        if (doc.selAt(x, y) === 1) {
          const i = cel.idx(x, y);
          cel.data[i] = 0; cel.data[i + 1] = 0; cel.data[i + 2] = 0; cel.data[i + 3] = 0;
        }
      }
    }
    record(doc, history, li, fi, before, "erase");
  },
  copy(doc: Doc, li: number, fi: number): Cel | null {
    return grabFn(doc, li, fi);
  },
  cut(doc: Doc, history: History, li: number, fi: number): Cel | null {
    const clip = grabFn(doc, li, fi);
    if (!clip) return null;
    if (!doc.layers[li]?.locked) this.eraseSelected(doc, history, li, fi);
    return clip;
  },
  paste(doc: Doc, history: History, li: number, fi: number, clip: Cel, at?: { x: number; y: number }): void {
    if (doc.layers[li]?.locked || !clip) return;
    const b = doc.sel?.bounds();
    const px = at ? at.x : b ? b.x : Math.max(0, Math.floor((doc.w - clip.w) / 2));
    const py = at ? at.y : b ? b.y : Math.max(0, Math.floor((doc.h - clip.h) / 2));
    const ox = Math.max(0, px), oy = Math.max(0, py);
    const ow = Math.min(clip.w, doc.w - ox), oh = Math.min(clip.h, doc.h - oy);
    if (ow <= 0 || oh <= 0) return;
    const cel = doc.ensureCel(li, fi);
    const before = new Uint8ClampedArray(cel.data);
    for (let y = 0; y < oh; y++) {
      for (let x = 0; x < ow; x++) {
        const si = clip.idx(x, y);
        if (clip.data[si + 3] > 0) {
          const c: RGBA = [clip.data[si], clip.data[si + 1], clip.data[si + 2], clip.data[si + 3]];
          blendOver(cel.data, cel.idx(ox + x, oy + y), c);
        }
      }
    }
    if (!doc.sel) doc.sel = new Sel(doc.w, doc.h, false);
    doc.sel.clear();
    for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) doc.sel!.set(ox + x, oy + y, 1);
    record(doc, history, li, fi, before, "paste");
  },
  flip(doc: Doc, history: History, li: number, fi: number, horizontal: boolean): void {
    const b = doc.sel?.bounds();
    const cel = doc.celAt(li, fi);
    if (!b || !cel) return;
    const before = new Uint8ClampedArray(cel.data);
    const swap = (x1: number, y1: number, x2: number, y2: number) => {
      const i = cel.idx(x1, y1), j = cel.idx(x2, y2);
      for (let k = 0; k < 4; k++) {
        const tmp = cel.data[i + k];
        cel.data[i + k] = cel.data[j + k];
        cel.data[j + k] = tmp;
      }
    };
    if (horizontal) {
      for (let y = 0; y < b.h; y++) {
        for (let x = 0; x < Math.floor(b.w / 2); x++) {
          const x1 = b.x + x, x2 = b.x + b.w - 1 - x;
          if (doc.selAt(x1, b.y + y) || doc.selAt(x2, b.y + y)) swap(x1, b.y + y, x2, b.y + y);
        }
      }
    } else {
      for (let x = 0; x < b.w; x++) {
        for (let y = 0; y < Math.floor(b.h / 2); y++) {
          const y1 = b.y + y, y2 = b.y + b.h - 1 - y;
          if (doc.selAt(b.x + x, y1) || doc.selAt(b.x + x, y2)) swap(b.x + x, y1, b.x + x, y2);
        }
      }
    }
    record(doc, history, li, fi, before, horizontal ? "flip-h" : "flip-v");
  },
  /**
   * Redraw moved content at (origin + dx, origin + dy).
   * Every drag step starts from the drag-start snapshot, cuts the grabbed
   * pixels out of their original spot and pastes them at the new offset, so
   * repeated pointermove calls never duplicate or leave old content behind.
   */
  move(doc: Doc, li: number, fi: number, dx: number, dy: number, st: MoveState): void {
    const cel = doc.celAt(li, fi);
    if (!cel) return;
    const content = st.content;
    const w = doc.w, h = doc.h;
    // back to the pre-drag picture (idempotent while dragging)
    cel.data.set(st.before);
    // cut the dragged pixels out of their original spot
    for (let y = 0; y < content.h; y++) {
      for (let x = 0; x < content.w; x++) {
        const si = content.idx(x, y);
        if (content.data[si + 3] === 0) continue;
        const gx = st.ox + x, gy = st.oy + y;
        if (gx < 0 || gy < 0 || gx >= w || gy >= h) continue;
        const di = cel.idx(gx, gy);
        cel.data[di] = 0; cel.data[di + 1] = 0; cel.data[di + 2] = 0; cel.data[di + 3] = 0;
      }
    }
    // paste at the new offset
    const nx = st.ox + dx, ny = st.oy + dy;
    for (let y = 0; y < content.h; y++) {
      for (let x = 0; x < content.w; x++) {
        const si = content.idx(x, y);
        if (content.data[si + 3] === 0) continue;
        const tx = nx + x, ty = ny + y;
        if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
        const di = cel.idx(tx, ty);
        cel.data[di] = content.data[si];
        cel.data[di + 1] = content.data[si + 1];
        cel.data[di + 2] = content.data[si + 2];
        cel.data[di + 3] = content.data[si + 3];
      }
    }
    // the selection keeps its original shape, shifted by (dx, dy)
    if (!doc.sel) doc.sel = new Sel(w, h, false);
    const dst = doc.sel.mask, src = st.mask;
    dst.fill(0);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (src[y * w + x]) {
          const tx = x + dx, ty = y + dy;
          if (tx >= 0 && ty >= 0 && tx < w && ty < h) dst[ty * w + tx] = 1;
        }
      }
    }
    doc.sel.bump();
  },
  // ---- Aseprite-style floating helpers: while a selection drags, the grabbed
  // pixels live OUTSIDE the cel; the layer only sees them when dropped. ----
  /** cut the grabbed pixels out of the layer (called once when the drag starts) */
  floatCut(doc: Doc, li: number, fi: number, st: MoveState): void {
    const cel = doc.celAt(li, fi);
    if (!cel) return;
    const content = st.content;
    const w = doc.w, h = doc.h;
    for (let y = 0; y < content.h; y++) {
      for (let x = 0; x < content.w; x++) {
        const si = content.idx(x, y);
        if (content.data[si + 3] === 0) continue;
        const gx = st.ox + x, gy = st.oy + y;
        if (gx < 0 || gy < 0 || gx >= w || gy >= h) continue;
        const di = cel.idx(gx, gy);
        cel.data[di] = 0; cel.data[di + 1] = 0; cel.data[di + 2] = 0; cel.data[di + 3] = 0;
      }
    }
  },
  /** paste the floating pixels back onto the layer at (ox+dx, oy+dy) */
  floatPaste(doc: Doc, li: number, fi: number, st: MoveState, dx: number, dy: number): void {
    const cel = doc.celAt(li, fi);
    if (!cel) return;
    const content = st.content;
    const w = doc.w, h = doc.h;
    const nx = st.ox + dx, ny = st.oy + dy;
    for (let y = 0; y < content.h; y++) {
      for (let x = 0; x < content.w; x++) {
        const si = content.idx(x, y);
        if (content.data[si + 3] === 0) continue;
        const tx = nx + x, ty = ny + y;
        if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
        const di = cel.idx(tx, ty);
        cel.data[di] = content.data[si];
        cel.data[di + 1] = content.data[si + 1];
        cel.data[di + 2] = content.data[si + 2];
        cel.data[di + 3] = content.data[si + 3];
      }
    }
  },
  /** put the layer back to the pre-gesture picture (drag cancelled) */
  restore(doc: Doc, li: number, fi: number, st: MoveState): void {
    const cel = doc.celAt(li, fi);
    if (cel) cel.data.set(st.before);
  },
  /** move the selection mask only (the outline follows the finger) */
  shiftMask(doc: Doc, st: MoveState, dx: number, dy: number): void {
    if (!doc.sel) doc.sel = new Sel(doc.w, doc.h, false);
    const dst = doc.sel.mask, src = st.mask;
    const w = doc.w, h = doc.h;
    dst.fill(0);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (src[y * w + x]) {
          const tx = x + dx, ty = y + dy;
          if (tx >= 0 && ty >= 0 && tx < w && ty < h) dst[ty * w + tx] = 1;
        }
      }
    }
    doc.sel.bump();
  },
};
