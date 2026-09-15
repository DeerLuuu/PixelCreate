// AI 文档文本化（C0，docs/PLAN-ai.md §3.2 / §5.1）：把画布变成模型能读的文本，
// 把结构化操作安全地写回文档。
//
// 为什么是「纯函数 + 无 DOM」：
//   · 三个函数是「AI 能对这张画布做什么」的地基，必须在 Node 里直接跑（tests/ai-doc.test.ts
//     就是这么测的），所以这里**不 import Session**，只用结构类型 AiSessionLike —— session.ts
//     有 4.2k 行且依赖 prefs/DOM 桩，把它拉进来这一层就没法单测了；
//   · **不碰 history、不碰 autosave**（那是 C2 回合事务的事，见 PLAN-ai §3.3）；
//     applyOps 只写 Doc/Cel 的像素，调用方负责开回合、落历史；
//   · **不产生兆级字符串**：readRegion 的 maxPixels 默认 65536（PLAN-ai §3.2 的 token 预算
//     就是这条约束），超出时保留左上角、整行保留、截断行数并置 clipped。
//
// 不要改回去的四条口径：
//   1. 颜色身份 = RGBA 四通道。同一 RGB 不同 alpha 是**两个**索引，调色板里写成 #rrggbbaa，
//      所以半透明像素的 alpha 永远能从 palette 精确读回（不需要再开一张「透明度表」）。
//   2. 越界坐标**不钳制也不搬位置**：画到画布外就是没画（changed 会说真话）。只有
//      size/tolerance/通道值这类「会被悄悄改小」的参数才进 warnings，形如
//      "clamped: size 999 → 64"，免得模型以为画在 A 处其实画在 B 处。
//   3. **空 ops 恒为 ok=true**，与目标图层锁没锁无关 —— 「没有 op 可失败」不是失败。
//      锁定只在真有 op 要执行时才让每个 op 记 layer-locked（早退必须排在锁定检查前面）。
//   4. **cel 只在真要写像素时才建**：put/wipe 先判 `doc.w/h` 再取 cel，fill 先判种子越界。
//      全程落在画布外的 op 一个字节没写，就不该在 doc.cels 里留下一条空 Cel ——
//      那会污染 docDigest 的 cels 计数（空 cel 也算「有」）。

import { clampByte, hexToRgba, rgbaToHex } from "../engine/color";
import { brushStamp, eraseAt, floodRegion, lineCells, paintAt } from "../engine/paint";
import type { MaskFn } from "../engine/paint";
import type { Doc } from "../engine/doc";
import type { BlendMode, Rect, RGBA } from "../engine/types";

/** 索引字符表：0-51 用 a-z/A-Z（§3.2 的格式提案） */
export const AI_INDEX_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** 一次 readRegion 最多吐多少像素（256×256）：token 预算的硬闸门 */
export const AI_MAX_REGION_PIXELS = 65536;
/** 笔迹尺寸上限，与 UI 的笔刷上限一致 */
export const AI_MAX_BRUSH = 64;
/** token 估算：ASCII 约 3.5 字符/token（PLAN-ai §3.2） */
export const AI_TOKENS_PER_CHAR = 3.5;

function tokensOf(text: string): number {
  return Math.ceil(text.length / AI_TOKENS_PER_CHAR);
}

function intOr(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 读一个整数字段：非数字返回 null（调用方记 error），小数截断并记 clamped */
function readInt(v: unknown, name: string, warnings: string[]): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const t = Math.trunc(n);
  if (t !== n) warnings.push("clamped: " + name + " " + n + " → " + t);
  return t;
}

// ---------------------------------------------------------------- 摘要

export interface AiDigestLayer {
  li: number;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blend: BlendMode;
}

export interface AiDigestFrame {
  fi: number;
  ms: number;
  /** 该帧存在 cel 对象的图层数（空 cel 也算「有」，它代表这一格已经建过） */
  cels: number;
}

export interface AiDigestTag {
  name: string;
  from: number;
  to: number;
}

export interface AiDigest {
  docRev: number;
  w: number;
  h: number;
  layers: AiDigestLayer[];
  frames: AiDigestFrame[];
  tags: AiDigestTag[];
  /** "#rrggbb"（alpha<255 时是 "#rrggbbaa"，与 readRegion 的 palette 同一口径） */
  palette: string[];
  sel: { x: number; y: number; w: number; h: number; pixels: number } | null;
  /** 当前帧可见图层的非空包围盒（含端点，无内容为 null） */
  bbox: { x: number; y: number; w: number; h: number } | null;
  /** 非透明像素占比，0..1，3 位小数 */
  inkRatio: number;
  /** 单行摘要 */
  text: string;
  tokens: number;
}

function countCels(doc: Doc, fi: number): number {
  let n = 0;
  for (let li = 0; li < doc.layers.length; li++) if (doc.celAt(li, fi)) n++;
  return n;
}

function selBox(doc: Doc): { x: number; y: number; w: number; h: number; pixels: number } | null {
  const s = doc.sel;
  if (!s || !s.hasAny()) return null;
  const b = s.bounds();
  if (!b) return null;
  let pixels = 0;
  for (let i = 0; i < s.mask.length; i++) if (s.mask[i]) pixels++;
  return { x: b.x, y: b.y, w: b.w, h: b.h, pixels };
}

/** 当前帧可见图层的非空包围盒；隐藏图层与 opacity=0 的图层不参与 */
function visibleBox(doc: Doc, fi: number): { x: number; y: number; w: number; h: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let li = 0; li < doc.layers.length; li++) {
    const L = doc.layers[li];
    if (!L.visible || L.opacity <= 0) continue;
    const cel = doc.celAt(li, fi);
    if (!cel) continue;
    for (let y = 0; y < doc.h; y++) {
      for (let x = 0; x < doc.w; x++) {
        if (cel.data[cel.idx(x, y) + 3] === 0) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** 非透明像素占比：可见图层里「至少一层不透明」的像素 / 画布总像素 */
function inkRatioOf(doc: Doc, fi: number): number {
  const total = doc.w * doc.h;
  if (total <= 0) return 0;
  let ink = 0;
  for (let y = 0; y < doc.h; y++) {
    for (let x = 0; x < doc.w; x++) {
      for (let li = 0; li < doc.layers.length; li++) {
        const L = doc.layers[li];
        if (!L.visible || L.opacity <= 0) continue;
        const cel = doc.celAt(li, fi);
        if (!cel) continue;
        if (cel.data[cel.idx(x, y) + 3] !== 0) { ink++; break; }
      }
    }
  }
  return Number((ink / total).toFixed(3));
}

export function docDigest(doc: Doc, opts: { fi?: number } = {}): AiDigest {
  const fi = clampInt(intOr(opts.fi, 0), 0, Math.max(0, doc.frames.length - 1));

  const layers: AiDigestLayer[] = doc.layers.map((l, li) => ({
    li, name: l.name, visible: l.visible, locked: l.locked, opacity: l.opacity, blend: l.blend,
  }));
  const frames: AiDigestFrame[] = doc.frames.map((f, i) => ({ fi: i, ms: f.durationMs, cels: countCels(doc, i) }));
  const tags: AiDigestTag[] = doc.tags.map((t) => ({ name: t.name, from: t.from, to: t.to }));
  const palette = doc.palette.map((c) => rgbaToHex(c));
  const sel = selBox(doc);
  const bbox = visibleBox(doc, fi);
  const inkRatio = inkRatioOf(doc, fi);

  const layerText = "[" + layers.map((l) => JSON.stringify(l.name) + (l.visible ? "" : "(hidden)") + (l.locked ? "(locked)" : "")).join(",") + "]";
  const tagText = "[" + tags.map((t) => '{"' + t.name + '",' + t.from + "," + t.to + "}").join(",") + "]";
  const selText = sel ? "(" + sel.x + "," + sel.y + ")+(" + sel.w + "x" + sel.h + ") " + sel.pixels + "px" : "none";
  const bboxText = bbox ? "(" + bbox.x + "," + bbox.y + ")-(" + (bbox.x + bbox.w - 1) + "," + (bbox.y + bbox.h - 1) + ")" : "none";
  const text = "digest: " + doc.w + "x" + doc.h
    + " | rev: " + doc.pixelRev
    + " | layers: " + layerText
    + " | frames: " + frames.length
    + " | tags: " + tagText
    + " | colors: " + palette.length
    + " | sel: " + selText
    + " | bbox: " + bboxText
    + " | ink: " + inkRatio.toFixed(3);

  return {
    docRev: doc.pixelRev, w: doc.w, h: doc.h,
    layers, frames, tags, palette, sel, bbox, inkRatio,
    text, tokens: tokensOf(text),
  };
}

// ---------------------------------------------------------------- 区域读取

export interface AiRegion {
  /** 实际读取到的区域（已按画布边界裁剪、已按 maxPixels 收敛）。
   *  **请求区域完全在画布外**时 `w = h = 0`、`rows` 为空，此时 `x/y` 回显的是**请求**坐标
   *  （head 文本会原样写成 `region requested (x,y,w,h) → 完全在画布外`，不会假装读到了什么）。 */
  x: number;
  y: number;
  w: number;
  h: number;
  fi: number;
  li: number;
  /** 每行一个字符串：`.` = 全透明，其余是 palette 的下标字符 */
  rows: string[];
  /** rows 用到的颜色（先按文档调色板顺序取子集，再按首次出现顺序追加新颜色） */
  palette: string[];
  /** 请求区域被画布边界或 maxPixels 裁剪过 */
  clipped: boolean;
  /** 带 y= 行号与 palette 行的排版文本 */
  text: string;
  tokens: number;
}

export interface AiReadOpts {
  fi?: number;
  li?: number;
  /** 行内 RLE（`2a3b`，单次省略次数）；调色板超过 52 色时自动关闭 */
  rle?: boolean;
  /** 默认 65536；超出时保留左上角、整行保留、截断行数 */
  maxPixels?: number;
}

function rleEncode(cells: string[]): string {
  let out = "";
  let i = 0;
  while (i < cells.length) {
    const t = cells[i];
    let n = 1;
    while (i + n < cells.length && cells[i + n] === t) n++;
    out += n > 1 ? String(n) + t : t;
    i += n;
  }
  return out;
}

export function readRegion(doc: Doc, rect: Rect, opts: AiReadOpts = {}): AiRegion {
  const notes: string[] = [];
  const r = rect || ({} as Rect);

  const liRaw = intOr(opts.li, 0);
  const liMax = Math.max(0, doc.layers.length - 1);
  const li = clampInt(liRaw, 0, liMax);
  if (li !== liRaw) notes.push("warn: li " + liRaw + " 超出图层范围 0.." + liMax + "，已回退到 " + li);

  const fiRaw = intOr(opts.fi, 0);
  const fiMax = Math.max(0, doc.frames.length - 1);
  const fi = clampInt(fiRaw, 0, fiMax);
  if (fi !== fiRaw) notes.push("warn: fi " + fiRaw + " 超出帧范围 0.." + fiMax + "，已回退到 " + fi);

  const rx = intOr(r.x, 0), ry = intOr(r.y, 0);
  const rw = Math.max(0, intOr(r.w, 0)), rh = Math.max(0, intOr(r.h, 0));
  if (intOr(r.w, 0) < 0 || intOr(r.h, 0) < 0) notes.push("warn: 宽或高为负，按 0 处理");

  let x0 = Math.max(0, rx), y0 = Math.max(0, ry);
  let x1 = Math.min(doc.w, rx + rw), y1 = Math.min(doc.h, ry + rh);
  let clipped = x0 !== rx || y0 !== ry || x1 !== rx + rw || y1 !== ry + rh;
  if (rw <= 0 || rh <= 0) notes.push("warn: 请求区域宽或高为 0");
  if (x1 <= x0 || y1 <= y0) {
    notes.push("warn: 请求区域完全在画布外");
    const requested = "region requested (x=" + rx + ",y=" + ry + ",w=" + rw + ",h=" + rh + ") → 完全在画布外 @frame " + fi + ", layer " + li + ":";
    const text = [requested].concat(notes).join("\n");
    // x/y 回显**请求**坐标（不是裁剪后的 x0/y0）：完全在外时 w=h=0、rows 为空，
    // 请求本身才是「读的是哪块」的真相；否则 x=10 回 10、x=-10 回 0，同一件事两种形状。
    return { x: rx, y: ry, w: 0, h: 0, fi, li, rows: [], palette: [], clipped: true, text, tokens: tokensOf(text) };
  }

  const maxPx = Math.max(1, intOr(opts.maxPixels, AI_MAX_REGION_PIXELS));
  let w = x1 - x0, h = y1 - y0;
  if (w * h > maxPx) {
    const nw = Math.min(w, maxPx);
    const nh = Math.max(1, Math.floor(maxPx / nw));
    notes.push("note: maxPixels " + maxPx + " 截断，只读了 " + nw + "x" + nh + "（保留左上角、整行保留）");
    x1 = x0 + nw;
    y1 = y0 + nh;
    w = nw;
    h = nh;
    clipped = true;
  }

  // 颜色身份 = RGBA：同一 RGB 不同 alpha 是两个索引，alpha 永远能从 palette 读回
  const cel = doc.celAt(li, fi);
  const keys: string[] = new Array(w * h);
  const used = new Set<string>();
  const order: string[] = [];
  let semi = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const at = (y - y0) * w + (x - x0);
      if (!cel) { keys[at] = ""; continue; }
      const i = cel.idx(x, y);
      const a = cel.data[i + 3];
      if (a === 0) { keys[at] = ""; continue; }
      const hex = rgbaToHex([cel.data[i], cel.data[i + 1], cel.data[i + 2], a]);
      keys[at] = hex;
      if (a < 255) semi++;
      if (!used.has(hex)) { used.add(hex); order.push(hex); }
    }
  }

  const palette: string[] = [];
  const idxOf = new Map<string, number>();
  for (const c of doc.palette) {
    const hex = rgbaToHex(c);
    if (!used.has(hex) || idxOf.has(hex)) continue;
    idxOf.set(hex, palette.length);
    palette.push(hex);
  }
  for (const hex of order) {
    if (idxOf.has(hex)) continue;
    idxOf.set(hex, palette.length);
    palette.push(hex);
  }

  const narrow = palette.length <= AI_INDEX_ALPHABET.length;
  const hexW = Math.max(2, Math.max(1, palette.length - 1).toString(16).length);
  const cellOf = (hex: string): string => {
    if (!hex) return narrow ? "." : ".".repeat(hexW);
    const i = idxOf.get(hex) ?? 0;
    return narrow ? AI_INDEX_ALPHABET[i] : i.toString(16).padStart(hexW, "0");
  };

  const useRle = !!opts.rle && narrow;
  const rows: string[] = [];
  for (let y = y0; y < y1; y++) {
    const cells: string[] = [];
    for (let x = x0; x < x1; x++) cells.push(cellOf(keys[(y - y0) * w + (x - x0)]));
    rows.push(useRle ? rleEncode(cells) : cells.join(""));
  }

  const head = "region (x=" + x0 + ",y=" + y0 + ",w=" + w + ",h=" + h + ") @frame " + fi + ", layer " + li + ":";
  const lines: string[] = [head];
  if (palette.length) {
    lines.push("palette: " + palette.map((hex, i) => (narrow ? AI_INDEX_ALPHABET[i] : i.toString(16).padStart(hexW, "0")) + "=" + hex).join(" "));
  }
  for (let k = 0; k < rows.length; k++) lines.push("y=" + String(y0 + k).padStart(2, " ") + " " + rows[k]);
  if (useRle) notes.push("note: rle 开启（[次数]字符，单次省略次数）");
  if (!narrow) notes.push("note: 调色板超过 52 色，索引回退定宽十六进制且 RLE 关闭");
  if (semi > 0) notes.push("note: " + semi + " 个半透明像素按 RGBA 单独占索引，alpha 见 palette 的 #rrggbbaa");
  if (clipped) notes.push("note: 区域已被裁剪（clipped）");

  const text = lines.concat(notes).join("\n");
  return { x: x0, y: y0, w, h, fi, li, rows, palette, clipped, text, tokens: tokensOf(text) };
}

// ---------------------------------------------------------------- 结构化操作

/** "#rrggbb" / "#rrggbbaa" / "fg" / "bg" */
export type AiColor = string;

export type AiOp =
  | { op: "pixels"; x: number; y: number; rgba: [number, number, number, number] }
  | { op: "line"; x0: number; y0: number; x1: number; y1: number; color: AiColor; size?: number }
  | { op: "rect"; x: number; y: number; w: number; h: number; color: AiColor; fill?: boolean }
  | { op: "erase"; x: number; y: number; w: number; h: number }
  | { op: "fill"; x: number; y: number; color: AiColor; tolerance?: number };

/** applyOps 只需要 Session 的这几个字段：用结构类型而不是 `Session`，
 *  这样这一层不依赖 4.2k 行的 session.ts，测试可以直接给一个字面量。 */
export interface AiSessionLike {
  fg: RGBA;
  bg: RGBA;
  li: number;
  fi: number;
}

export interface AiApplyCtx {
  session: AiSessionLike;
  fi?: number;
  li?: number;
  /** 给了就**完全接管**颜色解析（返回 null 走错误口径，不再回落到 fg/bg） */
  resolveColor?: (c: AiColor) => RGBA | null;
}

export interface AiApplyResult {
  /** 没有任何 op 失败（部分成功是常态） */
  ok: boolean;
  /** 成功执行的 op 数（画同色也算执行成功） */
  applied: number;
  /** 实际碰到的像素并集包围盒（没碰到像素为 null） */
  changed: Rect | null;
  /** 写入后的文档版本号；只有像素字节真的变了才前进 */
  docRev: number;
  warnings: string[];
  errors: Array<{ index: number; reason: string }>;
}

export function applyOps(doc: Doc, ops: AiOp[], ctx: AiApplyCtx): AiApplyResult {
  const warnings: string[] = [];
  const errors: Array<{ index: number; reason: string }> = [];
  let applied = 0;
  let changed: Rect | null = null;
  let dirty = false;

  if (!Array.isArray(ops)) warnings.push("warn: ops 不是数组，按空处理");
  const list: AiOp[] = Array.isArray(ops) ? ops : [];
  const sess = ctx && ctx.session ? ctx.session : null;

  // 空 ops = 没有 op 可失败 → ok 恒为 true，与图层锁没锁无关（plan §5.1）。
  // 这一条必须排在锁定检查前面，否则「锁定图层 + 空 ops」会吐 ok=false 且 errors 为空。
  if (!list.length) return { ok: true, applied: 0, changed: null, docRev: doc.pixelRev, warnings, errors };

  // li / fi：先留住**原始值**再截断，这样小数（3.7）与越界都能各报一条 clamped
  const liRawNum = ctx?.li === undefined ? (sess ? sess.li : 0) : Number(ctx.li);
  const liRaw = Number.isFinite(liRawNum) ? Math.trunc(liRawNum) : 0;
  const li = clampInt(liRaw, 0, Math.max(0, doc.layers.length - 1));
  if (li !== liRawNum) warnings.push("clamped: li " + liRawNum + " → " + li);
  const fiRawNum = ctx?.fi === undefined ? (sess ? sess.fi : 0) : Number(ctx.fi);
  const fiRaw = Number.isFinite(fiRawNum) ? Math.trunc(fiRawNum) : 0;
  const fi = clampInt(fiRaw, 0, Math.max(0, doc.frames.length - 1));
  if (fi !== fiRawNum) warnings.push("clamped: fi " + fiRawNum + " → " + fi);

  const layer = doc.layers[li];
  if (!layer || layer.locked) {
    for (let index = 0; index < list.length; index++) errors.push({ index, reason: "layer-locked" });
    warnings.push("warn: 目标图层已锁定，未写入任何像素");
    return { ok: false, applied: 0, changed: null, docRev: doc.pixelRev, warnings, errors };
  }

  const mask: MaskFn | null = doc.selectionActive() ? (x, y) => doc.selAt(x, y) > 0 : null;
  let cel = doc.celAt(li, fi);
  // 懒创建：只有「坐标真在画布内、而且选区掩膜也放行」时才 ensureCel。
  // 先拿 doc.w/h 判一次，避免把画布外的点变成一条空 Cel（见文件头第 4 条口径）。
  const needWrite = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < doc.w && y < doc.h && (!mask || mask(x, y));

  const mark = (x: number, y: number): void => {
    if (!changed) { changed = { x, y, w: 1, h: 1 }; return; }
    const x1 = Math.max(changed.x + changed.w, x + 1);
    const y1 = Math.max(changed.y + changed.h, y + 1);
    changed.x = Math.min(changed.x, x);
    changed.y = Math.min(changed.y, y);
    changed.w = x1 - changed.x;
    changed.h = y1 - changed.y;
  };

  const put = (x: number, y: number, c: RGBA): void => {
    if (!needWrite(x, y)) return;
    if (!cel) cel = doc.ensureCel(li, fi);
    const i = cel.idx(x, y);
    const d = cel.data;
    const b0 = d[i], b1 = d[i + 1], b2 = d[i + 2], b3 = d[i + 3];
    if (!paintAt(cel, x, y, c, mask)) return;
    if (!dirty && (d[i] !== b0 || d[i + 1] !== b1 || d[i + 2] !== b2 || d[i + 3] !== b3)) dirty = true;
    mark(x, y);
  };

  const wipe = (x: number, y: number): void => {
    if (!needWrite(x, y)) return;
    if (!cel) cel = doc.ensureCel(li, fi);
    const i = cel.idx(x, y);
    const d = cel.data;
    const b0 = d[i], b1 = d[i + 1], b2 = d[i + 2], b3 = d[i + 3];
    if (!eraseAt(cel, x, y, mask)) return;
    if (!dirty && (d[i] !== b0 || d[i + 1] !== b1 || d[i + 2] !== b2 || d[i + 3] !== b3)) dirty = true;
    mark(x, y);
  };

  const resolve = (c: AiColor): RGBA | null => {
    if (ctx && typeof ctx.resolveColor === "function") {
      const got = ctx.resolveColor(c);
      if (!got) return null;
      return [clampByte(got[0]), clampByte(got[1]), clampByte(got[2]), clampByte(got[3] === undefined ? 255 : got[3])];
    }
    if (c === "fg") return sess ? sess.fg : [0, 0, 0, 255];
    if (c === "bg") return sess ? sess.bg : [255, 255, 255, 255];
    if (typeof c === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(c)) return hexToRgba(c);
    return null;
  };

  for (let index = 0; index < list.length; index++) {
    const op = list[index] as AiOp | null | undefined;
    if (!op || typeof op !== "object") {
      errors.push({ index, reason: "操作不是对象" });
      continue;
    }
    const kind = (op as { op?: unknown }).op;
    try {
      if (kind === "pixels") {
        const p = op as Extract<AiOp, { op: "pixels" }>;
        const x = readInt(p.x, "x", warnings);
        const y = readInt(p.y, "y", warnings);
        if (x === null || y === null) { errors.push({ index, reason: "pixels.x/y 不是数字" }); continue; }
        if (!Array.isArray(p.rgba) || p.rgba.length !== 4) { errors.push({ index, reason: "pixels.rgba 必须是 4 个通道" }); continue; }
        const c: RGBA = [0, 0, 0, 0];
        let bad = false;
        for (let k = 0; k < 4; k++) {
          const v = Number(p.rgba[k]);
          if (!Number.isFinite(v)) { errors.push({ index, reason: "pixels.rgba[" + k + "] 不是数字" }); bad = true; break; }
          const t = Math.trunc(v);
          const cl = clampInt(t, 0, 255);
          if (cl !== t) warnings.push("clamped: rgba[" + k + "] " + t + " → " + cl);
          c[k] = cl;
        }
        if (bad) continue;
        put(x, y, c);
        applied++;
        continue;
      }

      if (kind === "line") {
        const p = op as Extract<AiOp, { op: "line" }>;
        const x0 = readInt(p.x0, "x0", warnings), y0 = readInt(p.y0, "y0", warnings);
        const x1 = readInt(p.x1, "x1", warnings), y1 = readInt(p.y1, "y1", warnings);
        if (x0 === null || y0 === null || x1 === null || y1 === null) { errors.push({ index, reason: "line 的坐标不是数字" }); continue; }
        const sizeRaw = p.size === undefined ? 1 : readInt(p.size, "size", warnings);
        if (sizeRaw === null) { errors.push({ index, reason: "line.size 不是数字" }); continue; }
        const size = clampInt(sizeRaw, 1, AI_MAX_BRUSH);
        if (size !== sizeRaw) warnings.push("clamped: size " + sizeRaw + " → " + size);
        const color = resolve(p.color);
        if (!color) { errors.push({ index, reason: "无法解析颜色: " + String(p.color) }); continue; }
        const stamp = brushStamp(size, "circle");
        lineCells(x0, y0, x1, y1, (cx, cy) => {
          for (const [dx, dy] of stamp.cells) put(cx + dx, cy + dy, color);
        });
        applied++;
        continue;
      }

      if (kind === "rect") {
        const p = op as Extract<AiOp, { op: "rect" }>;
        const x = readInt(p.x, "x", warnings), y = readInt(p.y, "y", warnings);
        const w = readInt(p.w, "w", warnings), h = readInt(p.h, "h", warnings);
        if (x === null || y === null || w === null || h === null) { errors.push({ index, reason: "rect 的坐标不是数字" }); continue; }
        if (w < 0 || h < 0) { errors.push({ index, reason: "rect.w/h 必须 ≥ 0" }); continue; }
        const color = resolve(p.color);
        if (!color) { errors.push({ index, reason: "无法解析颜色: " + String(p.color) }); continue; }
        const fill = !!p.fill;
        for (let yy = y; yy < y + h; yy++) {
          for (let xx = x; xx < x + w; xx++) {
            const edge = xx === x || yy === y || xx === x + w - 1 || yy === y + h - 1;
            if (fill || edge) put(xx, yy, color);
          }
        }
        applied++;
        continue;
      }

      if (kind === "erase") {
        const p = op as Extract<AiOp, { op: "erase" }>;
        const x = readInt(p.x, "x", warnings), y = readInt(p.y, "y", warnings);
        const w = readInt(p.w, "w", warnings), h = readInt(p.h, "h", warnings);
        if (x === null || y === null || w === null || h === null) { errors.push({ index, reason: "erase 的坐标不是数字" }); continue; }
        if (w < 0 || h < 0) { errors.push({ index, reason: "erase.w/h 必须 ≥ 0" }); continue; }
        for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) wipe(xx, yy);
        applied++;
        continue;
      }

      if (kind === "fill") {
        const p = op as Extract<AiOp, { op: "fill" }>;
        const x = readInt(p.x, "x", warnings), y = readInt(p.y, "y", warnings);
        if (x === null || y === null) { errors.push({ index, reason: "fill.x/y 不是数字" }); continue; }
        const color = resolve(p.color);
        if (!color) { errors.push({ index, reason: "无法解析颜色: " + String(p.color) }); continue; }
        const tolRaw = p.tolerance === undefined ? 0 : readInt(p.tolerance, "tolerance", warnings);
        if (tolRaw === null) { errors.push({ index, reason: "fill.tolerance 不是数字" }); continue; }
        const tol = clampInt(tolRaw, 0, 255);
        if (tol !== tolRaw) warnings.push("clamped: tolerance " + tolRaw + " → " + tol);
        // 种子越界：先记 error 返回，**不建 cel**（否则一个字节没写却留下一条空 Cel）
        if (x < 0 || y < 0 || x >= doc.w || y >= doc.h) { errors.push({ index, reason: "fill 起点 (" + x + "," + y + ") 在画布外" }); continue; }
        if (!cel) cel = doc.ensureCel(li, fi);
        const cells = floodRegion(cel, x, y, false, mask, { tolerance: tol });
        for (const [cx, cy] of cells) put(cx, cy, color);
        applied++;
        continue;
      }

      errors.push({ index, reason: "未知操作: " + String(kind) });
    } catch (e) {
      errors.push({ index, reason: "执行异常: " + (e instanceof Error ? e.message : String(e)) });
    }
  }

  if (dirty) doc.pixelRev++;
  return { ok: errors.length === 0, applied, changed, docRev: doc.pixelRev, warnings, errors };
}
