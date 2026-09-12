// Selection operations, all exported via one `selOps` object.
import { Doc, Sel } from "../engine/doc";
import { Cel } from "../engine/cel";
import type { RGBA } from "../engine/types";
import type { History } from "../engine/history";
import { blendOver } from "../engine/color";
import { polygonCells } from "../engine/paint";
import { gridLine, meshWarp, warpQuad, type Pixmap, type Pt, type Mat3 } from "./warp";
import { applyAffine, indexBox, invertAffine, transformedBox, type XfBox } from "./xform";

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
  /**
   * 「复制」模式（选区球的 sticky chip，PC 上等价 Ctrl+拖动）：浮动内容**不从图层上挖走**，
   * 原内容留在原地，松手时把副本贴上去。`floatCut()` / `FloatDrop` 会看这个标志。
   */
  copy?: boolean;
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
/** 自由变换（斜切 / 透视 / 网格）预览：把浮动内容按 `pts` 重排进 `out`（整幅画布像素），
 *  同时把结果写进 `doc.sel` 掩码，返回被点亮的像素下标。
 *
 *  `pts` 是**画布坐标**：四边形时是四个角（左上→右上→右下→左下，顺序固定）；
 *  网格时是 (divs+1)² 个控制点（行主序）。口径统一为**像素下标**（见 `floatQuad()`）：
 *  控制点恒等时就是选区内容的像素下标 `ox..ox+cw-1` / `oy..oy+ch-1`，
 *  遍历范围取这些下标的包围盒（`floor(min)..ceil(max)` 含端点），
 *  所以恒等变换正好覆盖整个选区、不丢最右 / 最下一列。
 *  `st.content` 是手势开始时抓下来的那块像素，
 *  所以拖动过程中反复调用它都是「从原图重算」，不会累积误差。
 *
 *  `halfSnap`：控制点是否允许落在 `x.5`（半像素吸附，见 `warp.ts` 的 `snapWarpCoord()`）。
 *  开着时栅格化按「目标像素格的左沿」取样（`tieDown`），于是把四角整体挪 0.5 格
 *  正好是「整块内容连着边上那一列一起搬过去」，不会因为均分的取舍丢一列 / 一行。
 */
export function warpFloating(
  doc: Doc, st: MoveState, pts: Pt[], out: Uint8ClampedArray, mesh: boolean, divs = 2, halfSnap = false,
): number[] {
  const w = doc.w, h = doc.h;
  out.fill(0);
  if (!doc.sel) doc.sel = new Sel(w, h, false);
  const m = doc.sel.mask;
  m.fill(0);
  doc.sel.bump();   // 掩码被就地改写：让 view 的选区着色 / 虚线框缓存失效
  const cells: number[] = [];
  if (!pts.length) return cells;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const x0 = Math.max(0, Math.floor(minX));
  const y0 = Math.max(0, Math.floor(minY));
  const x1 = Math.min(w - 1, Math.ceil(maxX));
  const y1 = Math.min(h - 1, Math.ceil(maxY));
  if (x1 < x0 || y1 < y0) return cells;
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const local = pts.map((p) => ({ x: p.x - x0, y: p.y - y0 }));
  const src: Pixmap = { w: st.content.w, h: st.content.h, data: st.content.data };
  const warped = mesh
    ? meshWarp(src, local, bw, bh, divs, halfSnap)
    : warpQuad(src, local, bw, bh, undefined, halfSnap);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const sp = (y * bw + x) * 4;
      if (warped[sp + 3] === 0) continue;
      const di = (y0 + y) * w + (x0 + x);
      const o = di * 4;
      out[o] = warped[sp]; out[o + 1] = warped[sp + 1]; out[o + 2] = warped[sp + 2]; out[o + 3] = warped[sp + 3];
      cells.push(di);
      m[di] = 1;
    }
  }
  return cells;
}

/** 浮动内容在画布坐标里的四角（左上→右上→右下→左下）。
 *  **像素下标口径**：内容占像素下标 `ox..ox+cw-1` / `oy..oy+ch-1`，初始四角就是这四个下标
 *  （不是 `ox+cw` / `oy+ch`）—— 控制点因此落在**像素上**，而不是像素之间的边界上。
 *  绘制时 `View.warpHandles()` 再把下标加上 0.5 画到像素中心。
 *  拖过之后允许是 `x.5`（半像素吸附，见 `warp.ts` 的 `snapWarpCoord()`）：
 *  整数＝压在像素中心，`x.5`＝落在相邻两个像素之间的边界线上。
 *  遍历范围仍取控制点下标的包围盒，所以恒等变换正好覆盖整个选区（含最右 / 最下一列）。 */
export function floatQuad(st: MoveState): Pt[] {
  const cw = st.content.w, ch = st.content.h;
  return [
    { x: st.ox, y: st.oy },
    { x: st.ox + cw - 1, y: st.oy },
    { x: st.ox + cw - 1, y: st.oy + ch - 1 },
    { x: st.ox, y: st.oy + ch - 1 },
  ];
}

/** 浮动内容上的 (divs+1)² 网格控制点（画布坐标，**行主序**＝左上→右上→右下→左下，
 *  与 `meshWarp()` / `defaultGrid()` 同序；口径同为**像素下标**，末点＝ `ox+cw-1` / `oy+ch-1`）。
 *  中间几条线的分布由 `warp.ts` 的 `gridLine()` 给出（不整除时取最近的像素下标），
 *  与 `meshWarp()` 的源格线完全一致。
 *  这是**进入变形时的初始分布**（全是整数下标）；拖起来之后每个控制点各自按
 *  `snapWarpCoord()` 落到整数或 `x.5`（半像素模式，默认开），不再走 `gridLine()` 的取整。 */
export function floatGrid(st: MoveState, divs = 2): Pt[] {
  const n = Math.max(1, Math.round(divs));
  const cw = st.content.w, ch = st.content.h;
  const out: Pt[] = [];
  for (let gy = 0; gy <= n; gy++) {
    for (let gx = 0; gx <= n; gx++) {
      out.push({ x: st.ox + gridLine(cw, gx, n), y: st.oy + gridLine(ch, gy, n) });
    }
  }
  return out;
}

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
  doc.sel.bump();   // 掩码被就地改写：让 view 的选区着色 / 虚线框缓存失效
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

/**
 * 自由变换（Aseprite 那套：移动 + 缩放 + 旋转 + 斜切）的预览栅格化。
 *
 * 与 `warpFloating()` 的分工：那是四点 / 网格的**透视与自由变形**（口径由 `warp.ts` 定死），
 * 这里是**纯仿射**（矩阵由 `xform.ts` 的 `affineFrom()` 组装），所以不走单应、直接求逆。
 *
 * 采样口径（**像素中心对齐**，与 `warp.ts` 同一套）：
 *  - **像素下标空间**，内容占局部下标 `0..cw-1` / `0..ch-1`，`st.content` 的第 0 列就是画布下标 `st.ox`；
 *  - 遍历范围＝输出像素**中心**反查后仍可能落在源内的那一段：`floor(min)..ceil(max)`，
 *    所以恒等变换正好覆盖整个选区、缩放后正好覆盖放大后的每一格（不多不少）；
 *  - 输出像素 `(px, py)` 的**中心** `(px + 0.5, py + 0.5)`（画布下标空间）经逆矩阵映回
 *    目标局部中心坐标，再减去「局部 0 落在下标 0 中心」的 0.5，**就近取整**（`Math.round`）。
 *    恒等变换下 `px = ox` → `0`、`px = ox + cw - 1` → `cw - 1`；2× 放大下
 *    `px = ox .. ox + 2(cw-1)` → `0 .. cw-1`，两边都不多不少。
 *  - 采样一律**最近邻**（像素画不能被插值糊掉）。
 *
 * 每次都从 `st.content`（手势起点抓下来的原图）重算，所以拖动过程中不会累积误差。
 *
 * @param dest 目标像素中心包围盒（**画布下标空间**，含端点）；
 *             调用方用 `xformAffineDestBox()` 算出来（不是 `transformedBox()` —— 那个是
 *             目标空间的包围盒，差着一个 `st.ox / st.oy` 的平移）
 * @returns 被点亮的**画布像素下标**（overlay / 落笔用），同时把 `doc.sel` 掩码设成结果形状
 */
export function xformAffineFloating(
  doc: Doc, st: MoveState, m: Mat3, out: Uint8ClampedArray, dest: XfBox,
): number[] {
  const w = doc.w, h = doc.h;
  out.fill(0);
  const cells: number[] = [];
  if (!doc.sel) doc.sel = new Sel(w, h, false);
  const mask = doc.sel.mask;
  mask.fill(0);
  doc.sel.bump();   // 掩码被就地改写：让 view 的选区着色 / 虚线框缓存失效
  if (dest.x1 < dest.x0 || dest.y1 < dest.y0) return cells;
  const inv = invertAffine(m);
  if (!inv) return cells;                       // 退化矩阵（缩放被钳死在 0 附近）：不画
  const content = st.content;
  const cw = content.w, ch = content.h;
  // `dest` 是**半开区间**：`[x0, x1)` / `[y0, y1)`（见 `xformAffineDestBox()`）
  const x0 = Math.max(0, dest.x0), y0 = Math.max(0, dest.y0);
  const x1 = Math.min(w - 1, dest.x1 - 1), y1 = Math.min(h - 1, dest.y1 - 1);
  if (x1 < x0 || y1 < y0) return cells;
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      // 采样点＝「目标像素在索引空间向后错一格的 +0.5」再逆映射回内容局部下标（口径同 `xformFloating`）
      const p = applyAffine(inv, { x: px - st.ox + 0.5, y: py - st.oy + 0.5 });
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      const lx = Math.floor(p.x), ly = Math.floor(p.y);
      if (lx < 0 || ly < 0 || lx >= cw || ly >= ch) continue;
      const si = content.idx(lx, ly);
      if (content.data[si + 3] === 0) continue;
      const di = py * w + px, o = di * 4;
      out[o] = content.data[si];
      out[o + 1] = content.data[si + 1];
      out[o + 2] = content.data[si + 2];
      out[o + 3] = content.data[si + 3];
      cells.push(di);
      mask[di] = 1;
    }
  }
  return cells;
}

/**
 * `xformAffineFloating()` 的遍历范围（**内容局部下标空间**，半开区间 `[x0, x1) × [y0, y1)`）。
 *
 * 口径与 `xformFloating()` 一致（那是旧的旋转 / 缩放实现，一直是对的）：目标像素 `(px, py)`
 * 采样的是「索引空间里 `(px - st.ox + 1, py - st.oy + 1)` 处的 +0.5」再 `floor`，
 * 所以恒等变换正好覆盖内容本身、缩放后正好覆盖缩放后的每一格。`x1` / `y1` 用 `ceil` 取
 * **上界**（不是最后一个下标）：边界那一列会多取样一个像素，`floor` + 源越界判定会把它滤掉。
 */
export function xformAffineDestBox(m: Mat3, cw: number, ch: number, ox: number, oy: number): XfBox {
  // 内容占局部下标 `0..cw-1`，也就是**像素范围** `-0.5 .. cw-0.5`（像素中心在下标上）
  const cs = [
    { x: -0.5, y: -0.5 }, { x: cw - 0.5, y: -0.5 },
    { x: cw - 0.5, y: ch - 0.5 }, { x: -0.5, y: ch - 0.5 },
  ].map((p) => applyAffine(m, p));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of cs) {
    if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
  }
  // 画布下标 = 局部下标 + 内容原点；遍历用半开区间，所以上界取 ceil
  return { x0: Math.floor(x0) + ox, y0: Math.floor(y0) + oy, x1: Math.ceil(x1) + ox, y1: Math.ceil(y1) + oy };
}

/** 兼容旧名（目标**局部**空间的包围盒，`floor..ceil` 含端点；视图层已改用上面的版本） */
export function xformDestBox(m: Mat3, cw: number, ch: number): XfBox {
  return transformedBox(m, cw, ch);
}

/** 内容框（下标空间）：`0..cw-1` / `0..ch-1`（转发 `xform.ts`，省得视图层再 import 一次） */
export function xformContentBox(cw: number, ch: number): XfBox {
  return indexBox(cw, ch);
}

export const selOps = {
  setRect: setRectFn,  selectAll(doc: Doc): void {
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
    const before = new Uint8ClampedArray(doc.ensureCel(li, fi).data);
    if (!pasteRaw(doc, li, fi, clip, at)) return;
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
  /** cut the grabbed pixels out of the layer (called once when the drag starts)。
   *  `st.copy`（「复制」开关 / PC 的 Ctrl+拖动）＝**不挖**，原内容留在原地。 */
  floatCut(doc: Doc, li: number, fi: number, st: MoveState): void {
    if (st.copy) return;
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
  /** paste the floating pixels back onto the layer at (ox+dx, oy+dy)。
   *  `st.copy` 时刻意**直接覆盖**（不透明混合）：复制出来的副本要与源像素逐字节一致。 */
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

/**
 * Blit a clip into a cel at an exact position WITHOUT touching the history and
 * set that document's selection to the pasted rectangle. Used by `selOps.paste`
 * (which records the step itself) and by the "paste as new layer / new canvas /
 * into every picked frame" flows, where a single structural step covers it all.
 *
 * @param at top-left of the clip; defaults to the selection bounds, else centred
 * @returns true when at least one pixel row/column landed inside the canvas
 */
export function pasteRaw(doc: Doc, li: number, fi: number, clip: Cel, at?: { x: number; y: number }): boolean {
  if (!clip || !clip.w || !clip.h || doc.layers[li]?.locked) return false;
  const b = doc.sel?.bounds();
  const px = at ? at.x : b ? b.x : Math.max(0, Math.floor((doc.w - clip.w) / 2));
  const py = at ? at.y : b ? b.y : Math.max(0, Math.floor((doc.h - clip.h) / 2));
  const ox = Math.max(0, px), oy = Math.max(0, py);
  const ow = Math.min(clip.w, doc.w - ox), oh = Math.min(clip.h, doc.h - oy);
  if (ow <= 0 || oh <= 0) return false;
  const cel = doc.ensureCel(li, fi);
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
  return true;
}

/**
 * Drop a floating selection into ANOTHER document — the cross-canvas move.
 *
 * `st.content` (the pixels grabbed at drag start) is copied at an exact
 * position: unlike `selOps.paste`, a negative origin is CLIPPED instead of
 * shifting the whole clip onto the edge, so a drop that hangs off the target
 * canvas lands exactly where the pointer is. Pixels are copied directly (no
 * alpha blending), matching the in-canvas float drop. The target document's
 * selection becomes the dropped rectangle and one history step is pushed.
 *
 * @param st floating move state carried over from the source document
 * @param x  target pixel of the clip's top-left (may be negative)
 * @returns true when at least one pixel was written
 */
export function floatDropInto(
  doc: Doc, li: number, fi: number, st: MoveState, x: number, y: number,
  history?: History, label = "sel.move",
): boolean {
  const content = st.content;
  if (!content || doc.layers[li]?.locked) return false;
  const cel = doc.ensureCel(li, fi);
  if (!cel) return false;
  const w = doc.w, h = doc.h;
  const before = history ? new Uint8ClampedArray(cel.data) : null;
  let wrote = false;
  for (let cy = 0; cy < content.h; cy++) {
    const ty = y + cy;
    if (ty < 0 || ty >= h) continue;
    for (let cx = 0; cx < content.w; cx++) {
      const tx = x + cx;
      if (tx < 0 || tx >= w) continue;
      const si = content.idx(cx, cy);
      if (content.data[si + 3] === 0) continue;
      const di = cel.idx(tx, ty);
      cel.data[di] = content.data[si];
      cel.data[di + 1] = content.data[si + 1];
      cel.data[di + 2] = content.data[si + 2];
      cel.data[di + 3] = content.data[si + 3];
      wrote = true;
    }
  }
  if (!wrote) return false;
  // the selection follows the dropped pixels, clipped to the canvas edge
  if (!doc.sel) doc.sel = new Sel(w, h, false);
  doc.sel.clear();
  const x0 = Math.max(0, x), y0 = Math.max(0, y);
  const x1 = Math.min(w - 1, x + content.w - 1), y1 = Math.min(h - 1, y + content.h - 1);
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) doc.sel.set(tx, ty, 1);
  if (history && before) record(doc, history, li, fi, before, label);
  return true;
}
