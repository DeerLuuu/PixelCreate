// P1 像素级绘制适配层（AI 工具面用，对应 docs/PLAN-ai.md §4 映射表里标 C5+ 的那批：
// draw_path / draw_shape / fill / erase / fx_* / transform）：把「模型给的参数」翻译成
// 引擎与工具层**既有的一次调用**。
//
// 为什么单独一层（而不是全塞进 ai-tools.ts）：
//   ai-tools.ts 的契约是「schema + 参数校验 + tier 分级 + 分发」，handler 只做参数适配；
//   P1 这批工具要组合 `tools/stroke.ts` 的 Stroke（笔迹 / 形状 / 油漆桶 / 擦除）、
//   `engine/effects.ts` 的 8 个特效、`tools/xform.ts` 的纯仿射 + `tools/select.ts` 的浮动模型。
//   拆成两层之后，ai-tools.ts 那条「无新增写入路径」的静态扫描（tests/ai-tools.test.ts）
//   仍然只看表里那些 `s.<方法>(` 调用，本文件的调用由 tests/ai-draw.test.ts 用同一条规则盯着。
//
// **不新增写入路径**（与 ai-tools.ts 文件头同一条口径，改这里之前先读这段）：
//   · 笔迹 / 形状 / 填充 / 擦除 → `Stroke` 的 startAt / moveTo / drawPath + `commit()`：
//     commit 内部走 `history.pushPixels`，**没有真实改动时不压栈**（并删掉白建的 cel）；
//   · 特效 → `engine/effects.ts` 的既有函数 + `Session.maskOp()`：maskOp = pushStruct
//     一条历史 + repaintAll + changed，与「魔棒建选区」（Session.wandAt）用的是同一个门面，
//     这里只是把「一条结构快照」用在像素特效上；
//   · 变换 → `tools/select.ts` 的浮动模型（beginMove / selOps.floatCut / selOps.restore）+
//     `tools/xform.ts` 的纯函数（affineFrom / contentBox / pivotPresetPoint /
//     xformAffineDestBox / xformAffineFloating），口径与 `View.endXf()` 逐条对齐。
//   本文件**不 import History**，也不调用 `history.*` 的任何方法。
//
// 为什么特效要「先试跑一次」（applyFx）：
//   engine/effects.ts 的函数是**原地改写**整块 cel 的，跑完才知道有没有变化。而「没变化就不该
//   压一条历史、也不该动一个字节」是 C1 的硬口径。所以先在**副本**上跑一遍（试跑），拿到
//   差异包围盒与差异像素数；没有差异就直接返回（文档零改动）；有差异才在 `maskOp` 里把
//   同一个函数真正跑在 cel 上（特效全是确定性的，两次结果逐字节一致）。
//   选区分档时用「全画布试跑 + 只把选区内的差异写回去」，这样描边 / 外发光这类依赖周围像素的
//   效果在选区边界上仍然按「整幅图」的上下文计算，只是不外溢到选区外。
//
// 坑点（踩过的，别改回去）：
//   · **AI 笔画不吃图案笔刷**（Stroke.pattern 置 null）：图案来自用户的工具设置，模型无从知道，
//     落笔结果会变得不可预测、读回来的颜色也对不上；
//   · **橡皮不能被调色板吸附**：索引色模式下 `snapColor` 会把 color 换成调色板里的实色 ——
//     而橡皮正是靠 `color[3] === 0` 判定擦除的，一旦被吸附就变成「画」而不是「擦」；
//   · 形状一律按 `from → to` 的外接框落笔（**不吃**「从中心绘制」这个用户开关：模型给的就是
//     框，绕中心往外长会让落点与它算的对不上）；
//   · `takeDirty()` 是给重绘用的**脏矩形**（形状工具会把上一次那笔的补白框标进来），
//     返回给模型的 `changed` 矩形走 `diffRect()`：`Stroke.before` ↔ 当前 cel 逐字节比。
//
// 已知代价（想换之前先读这段）：特效 / 变换压的是 `Session.maskOp()` 的**结构快照**
//   （`History.pushStruct`：整档 before/after 各一份），而不是 `pushPixels` 的稀疏像素差分。
//   选它的理由有两条：① C1 的硬口径是「写入经 Session 既有方法」，本文件因此**完全不 import
//   History**；② 变换会顺手改选区掩码，只有结构快照能把它一起撤销。代价是**大画布**下一步要
//   两份整档快照（像素画常态 64²～256² 无所谓；1024² × 多图层时比稀疏差分贵得多）。要换成
//   稀疏差分得让 `maskOp` 认一个「只要像素」的开关（动 session.ts / history.ts），本轮不做。
//   · 变换的「一条历史」必须让 `maskOp` 捕获到**原位**的 cel —— 所以 `floatCut()` 要放在
//     maskOp 的回调里（`View.endXf()` 是用 `st.before` 当历史的前像，这里没有那个通道）。
//     早先把 floatCut 放在 maskOp 外面，undo 会把「内容被挖空」的状态当成原位。
import { Cel } from "../engine/cel";
import type { Doc } from "../engine/doc";
import type { RGBA, Rect } from "../engine/types";
import type { BrushShape } from "../engine/paint";
import { Stroke } from "../tools/stroke";
import type { SymMode } from "../tools/registry";
import { beginMove, selOps, xformAffineDestBox, xformAffineFloating } from "../tools/select";
import type { MoveState } from "../tools/select";
import { PIVOT_PRESETS, XF_LABEL, affineFrom, clampScale, contentBox, normAngle, pivotPresetPoint, snapCleanAngle } from "../tools/xform";
import type { PivotPreset } from "../tools/xform";
import type { Session } from "./session";

// ------------------------------------------------------------------ 对称（sym）

/**
 * AI 侧的对称档（PLAN-ai §3.1 的 schema 草案）：
 *   `off` 关；`h` **水平**镜像线（上下对称，引擎的 `angDeg = 0`）；
 *   `v` **垂直**镜像线（左右对称，`angDeg = 90`）；
 *   `both` 两条镜像线 = 四向对称；`4` 是四向对称的旧名（与 both 等价，保留兼容）。
 * 引擎侧只有 `sym: "off" | "on"` + `symFour` + `symAng` 四个字段（见 tools/registry.ts），
 * 所以这里做一层收敛：`h`/`v` = 单轴，`both`/`4` = 四向。
 */
export type AiSymName = "off" | "h" | "v" | "both" | "4";
export const AI_SYMS: readonly AiSymName[] = ["off", "h", "v", "both", "4"];

export interface SymSpec { on: boolean; four: boolean; angDeg: number }

/** 档名 → 引擎的 (on, four, angDeg)。未知档名按 `off` 处理（schema 已经先拦过一遍）。 */
export function symSpecOf(name: string): SymSpec {
  if (name === "h") return { on: true, four: false, angDeg: 0 };
  if (name === "v") return { on: true, four: false, angDeg: 90 };
  if (name === "both" || name === "4") return { on: true, four: true, angDeg: 90 };
  return { on: false, four: false, angDeg: 90 };
}

// ------------------------------------------------------------------ 公共结果

export interface AiDrawOutcome {
  /** 真的写进去了（false 时文档一个字节都没动） */
  changed: boolean;
  /** 实际碰到的像素并集矩形（null = 没碰到） */
  rect: Rect | null;
  /** 拒绝执行的原因（中文，带允许范围）；ok=false 时下游会原样回给模型 */
  error?: string;
}

/**
 * `commit()` 之后**真正的**差异包围盒：拿 `Stroke.before`（落笔前的 cel 字节，
 * Stroke 的公开字段）与当前 cel 逐字节比。
 *
 * 为什么不用 `Stroke.takeDirty()`：那是给**重绘**用的脏矩形 —— 形状工具每次重画都会把
 * 「上一次那笔的补白框」（按笔尖尺寸外扩）也标进去，于是返回的矩形会比真正改动的像素大一圈。
 * 模型拿这个矩形去 `read_region` 复看时，窗口里会多出没动过的像素。所以这里多扫一遍字节，
 * 换一个可依赖的精确结果（与 `Stroke.commit()` 自己的 `changed()` 是同一趟量级的开销）。
 * `before === null`（cel 是本笔新建的）＝与「全透明」比。
 */
function diffRect(cel: Cel, before: Uint8ClampedArray | null): Rect | null {
  const w = cel.w, h = cel.h, d = cel.data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const same = before
        ? before[p] === d[p] && before[p + 1] === d[p + 1] && before[p + 2] === d[p + 2] && before[p + 3] === d[p + 3]
        : d[p] === 0 && d[p + 1] === 0 && d[p + 2] === 0 && d[p + 3] === 0;
      if (same) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** 这次写操作落在哪个文档 / 图层 / 帧 */
interface PaintTarget {
  doc: Doc;
  li: number;
  fi: number;
  /** 参考图层：本画布的格 (x, y) 落到源画布的 (x - dx, y - dy)（见 View.wireRedirect） */
  dx: number;
  dy: number;
  ref: boolean;
}

function layerRange(doc: Doc): string {
  return "0.." + (doc.layers.length - 1);
}

/**
 * 解析写目标：普通图层＝当前文档的该图层；参考图层＝它镜像的**源画布**（与 UI 同一条路，
 * 见 `View.wireRedirect()`）；锁定 / 下标不存在 / 参考源已消失一律返回原因。
 */
function paintTarget(s: Session, li: number, fi: number): { tgt: PaintTarget | null; error?: string } {
  const doc = s.doc;
  const L = doc.layers[li];
  if (!L) return { tgt: null, error: "图层下标 " + li + " 不存在（当前文档的图层允许 " + layerRange(doc) + "）" };
  if (!doc.frames[fi]) return { tgt: null, error: "帧下标 " + fi + " 不存在（当前文档的帧允许 0.." + (doc.frames.length - 1) + "）" };
  if (L.ref) {
    const block = s.refPaintBlock(li);
    if (block === "locked") return { tgt: null, error: "图层 " + li + " 镜像的源图层已锁定，不能绘制" };
    const rt = s.strokeTarget(li);
    if (!rt) return { tgt: null, error: "图层 " + li + " 是参考图层，而它镜像的源图层已不存在（解除引用后即可绘制）" };
    if (s.doc.layers[li].locked) return { tgt: null, error: "图层 " + li + " 已锁定" };
    return { tgt: { doc: rt.doc, li: rt.li, fi: rt.fi, dx: rt.dx, dy: rt.dy, ref: true } };
  }
  if (L.locked) return { tgt: null, error: "图层 " + li + " 已锁定" };
  return { tgt: { doc, li, fi, dx: 0, dy: 0, ref: false } };
}

// ------------------------------------------------------------------ 笔迹 / 形状 / 填充 / 擦除

/**
 * AI 笔迹能用的工具子集（`ToolKind` 里去掉多指工具 polyline / curve、正多边形 polygon、
 * 正圆 circle 与喷枪 airbrush：它们的语义要么与 draw_path 的折线重复，要么依赖时间 / 手数）。
 */
export type AiStrokeKind = "pencil" | "eraser" | "line" | "rect" | "ellipse" | "bucket";
export const AI_STROKE_KINDS: readonly AiStrokeKind[] = ["pencil", "eraser", "line", "rect", "ellipse", "bucket"];
/** 形状类（只看首尾两点）：line / rect / ellipse */
export const AI_SHAPE_KINDS: readonly AiStrokeKind[] = ["line", "rect", "ellipse"];

export interface StrokeSpec {
  /** 用哪个工具落笔（AiStrokeKind 的子集） */
  kind: AiStrokeKind;
  li: number;
  fi: number;
  /** 笔尖直径（1..64）；线 / 空心形状＝线宽，实心形状只用它算脏矩形 */
  size: number;
  color: RGBA;
  sym: AiSymName;
  /** 形状是否实心（pencil / eraser / bucket 忽略） */
  shapeFill?: boolean;
  /** 省略 = 用当前的画笔形状（Session.brushShape） */
  brushShape?: BrushShape;
  /** 油漆桶：per-channel 容差 0..255 与封口 0..16 */
  fillTolerance?: number;
  fillGaps?: number;
  /** 油漆桶：整层同色像素（true）还是连通区域（false） */
  bucketGlobal?: boolean;
  /** 油漆桶渐变：终点色 + 量化块大小（1 / 2 / 4 / 8） */
  gradient?: { end: RGBA; block: number } | null;
  /** 渐变轴终点（省略 = 区域包围盒自上而下）；只在 gradient 打开时有效 */
  gradientTo?: [number, number] | null;
  /**
   * 落点：pencil / eraser = 折线（1..4096 点，逐段连线）；
   * line / rect / ellipse = 恰好 2 点（起、止）；bucket = 恰好 1 点（种子）。
   */
  points: Array<[number, number]>;
  /** 历史标签（历史面板里显示的那一行） */
  label: string;
}

/**
 * 跑一次笔迹：`Stroke` 无 UI 实例化 → startAt / moveTo → commit。
 * 返回的 `rect` 是 `diffRect()` 给出的**精确**差异包围盒（画布坐标，已裁剪到画布内）。
 */
export function runStroke(s: Session, spec: StrokeSpec): AiDrawOutcome {
  const pt = paintTarget(s, spec.li, spec.fi);
  if (!pt.tgt) return { changed: false, rect: null, error: pt.error };
  const tgt = pt.tgt;
  const sym = symSpecOf(spec.sym);
  // 橡皮靠 alpha=0 判定（见 Stroke.paintOne）：颜色由这里定死，不吃 color 参数
  const eraseMode = spec.kind === "eraser" || spec.color[3] === 0;
  const color: RGBA = eraseMode ? [0, 0, 0, 0] : spec.color;
  const size = Math.max(1, Math.min(64, Math.round(spec.size)));
  let st: Stroke;
  try {
    st = new Stroke(
      tgt.doc, tgt.li, tgt.fi, spec.kind,
      { ...s.brush(), pattern: null, color, size },
      false, (sym.on ? "on" : "off") as SymMode, s.shapeSides, spec.shapeFill !== false,
      s.symOx, s.symOy, sym.angDeg, sym.four,
      spec.bucketGlobal === true, spec.brushShape ?? s.brushShape, false,
    );
  } catch (e) {
    return { changed: false, rect: null, error: "无法开始绘制：" + (e instanceof Error ? e.message : String(e)) };
  }
  if (!eraseMode) st.snapColor = (c) => s.paletteSnap(c);
  if (tgt.ref) {
    st.refDx = tgt.dx;
    st.refDy = tgt.dy;
    st.setGeometry(s.doc.w, s.doc.h);
    const sel = s.doc.sel;
    if (sel && sel.hasAny()) st.mask = (x, y) => sel.get(x + tgt.dx, y + tgt.dy) === 1;
  }
  const tm = s.prefs.tileMode;
  st.wrapX = tm === "row" || tm === "grid";
  st.wrapY = tm === "col" || tm === "grid";
  st.fillTolerance = Math.max(0, Math.min(255, Math.round(spec.fillTolerance ?? 0)));
  st.fillGaps = Math.max(0, Math.min(16, Math.round(spec.fillGaps ?? 0)));
  if (spec.gradient) {
    st.gradEnd = spec.gradient.end;
    st.gradBlock = Math.max(1, Math.round(spec.gradient.block));
  }

  const pts = spec.points;
  st.startAt(pts[0][0], pts[0][1]);
  if (spec.kind === "bucket") {
    // 渐变轴＝从种子指向 gradientTo（引擎默认：没有轴就按区域包围盒自上而下）
    if (spec.gradientTo) st.moveTo(spec.gradientTo[0], spec.gradientTo[1], 1);
  } else if (spec.kind === "line" || spec.kind === "rect" || spec.kind === "ellipse") {
    const last = pts[pts.length - 1];
    st.moveTo(last[0], last[1], 1);
  } else {
    for (let i = 1; i < pts.length; i++) st.moveTo(pts[i][0], pts[i][1], 1);
  }

  const rec = st.commit(s.history, spec.label);
  const r = rec ? diffRect(st.cel, st.before) : null;
  // 参考图层的笔画落在源画布上：矩形换算回**这次请求的那张画布**的坐标
  const rect = r && tgt.ref ? { x: r.x + tgt.dx, y: r.y + tgt.dy, w: r.w, h: r.h } : r;
  s.repaint();
  if (rec) s.changedUI();
  return { changed: rec, rect };
}

// ------------------------------------------------------------------ engine/effects.ts 的 8 个特效

export type AiFxScope = "layer" | "selection";
export const AI_FX_SCOPES: readonly AiFxScope[] = ["layer", "selection"];

/** 一个作用在整块 cel 上的特效（engine/effects.ts 的既有函数签名） */
export type CelFx = (data: Uint8ClampedArray, w: number, h: number) => void;

export interface FxSpec { li: number; fi: number; scope: AiFxScope }

export interface FxOutcome extends AiDrawOutcome {
  /** 被改动的像素数（选区分档时只数选区内的） */
  pixels: number;
}

/**
 * 跑一个特效（先试跑一次拿差异，再在 `maskOp` 里真正跑一遍）。
 * 返回 `changed:false` 的三种情况都**不动文档的任何一个字节**、也不压历史：
 * 空 cel、特效没有产生差异、选区里没有差异。
 */
export function applyFx(s: Session, label: string, fn: CelFx, spec: FxSpec): FxOutcome {
  const doc = s.doc;
  const L = doc.layers[spec.li];
  if (!L) return { changed: false, rect: null, pixels: 0, error: "图层下标 " + spec.li + " 不存在（当前文档的图层允许 " + layerRange(doc) + "）" };
  if (!doc.frames[spec.fi]) return { changed: false, rect: null, pixels: 0, error: "帧下标 " + spec.fi + " 不存在（当前文档的帧允许 0.." + (doc.frames.length - 1) + "）" };
  if (L.ref) return { changed: false, rect: null, pixels: 0, error: "图层 " + spec.li + " 是参考图层（它只镜像别处的像素），请在源画布上做特效" };
  if (L.locked) return { changed: false, rect: null, pixels: 0, error: "图层 " + spec.li + " 已锁定" };
  const selOn = spec.scope === "selection";
  if (selOn && !doc.selectionActive()) {
    return { changed: false, rect: null, pixels: 0, error: "scope=selection 需要先建立选区（当前没有选区；scope=layer 作用于整个图层）" };
  }
  const cel = doc.celAt(spec.li, spec.fi);
  if (!cel) return { changed: false, rect: null, pixels: 0 };   // 这一帧还没有 cel：没有可处理的内容，不算失败
  const w = doc.w, h = doc.h;
  const trial = new Uint8ClampedArray(cel.data);
  fn(trial, w, h);
  let n = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (selOn && doc.selAt(x, y) !== 1) continue;
      const p = (y * w + x) * 4;
      if (trial[p] === cel.data[p] && trial[p + 1] === cel.data[p + 1] &&
          trial[p + 2] === cel.data[p + 2] && trial[p + 3] === cel.data[p + 3]) continue;
      n++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (!n) return { changed: false, rect: null, pixels: 0 };
  const rect: Rect = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  s.maskOp(label, () => {
    if (!selOn) { fn(cel.data, w, h); return; }
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (doc.selAt(x, y) !== 1) continue;
        const p = (y * w + x) * 4;
        cel.data[p] = trial[p];
        cel.data[p + 1] = trial[p + 1];
        cel.data[p + 2] = trial[p + 2];
        cel.data[p + 3] = trial[p + 3];
      }
    }
  });
  return { changed: true, rect, pixels: n };
}

// ------------------------------------------------------------------ 变换（移动 / 缩放 / 旋转）

export type AiXformMode = "move" | "scale" | "rotate";
export type AiXformScope = "selection" | "layer";
export const AI_XFORM_MODES: readonly AiXformMode[] = ["move", "scale", "rotate"];
export const AI_XFORM_SCOPES: readonly AiXformScope[] = ["selection", "layer"];
/** 缩放的允许区间（绝对值）：与引擎的 `clampScale()` 同一个上下界 */
export const AI_SCALE_MIN = 0.02;
export const AI_SCALE_MAX = 40;
/** 枢轴 9 档预设（直接复用 tools/xform.ts 的表，不另抄一份） */
export const AI_PIVOTS: readonly PivotPreset[] = PIVOT_PRESETS;

export interface XformSpec {
  li: number;
  fi: number;
  mode: AiXformMode;
  /** 作用范围：`selection` 只变换选区内的内容（需要选区）；`layer` 变换整层内容 */
  scope: AiXformScope;
  dx: number;
  dy: number;
  sx: number;
  sy: number;
  /** 度（mode=rotate） */
  angle: number;
  /** 角度吸附到像素画的干净角（26.565° 那一族，见 xform.ts 的 CLEAN_ANGLES_DEG） */
  snap: boolean;
  /** 缩放 / 旋转的枢轴（内容外框上的 9 档预设） */
  pivot: PivotPreset;
}

export interface XformOutcome extends AiDrawOutcome {
  /** 落进画布的像素数（内容被推出画布的部分不会写进来） */
  pixels: number;
}

export function runTransform(s: Session, spec: XformSpec): XformOutcome {
  const doc = s.doc;
  const L = doc.layers[spec.li];
  if (!L) return { changed: false, rect: null, pixels: 0, error: "图层下标 " + spec.li + " 不存在（当前文档的图层允许 " + layerRange(doc) + "）" };
  if (!doc.frames[spec.fi]) return { changed: false, rect: null, pixels: 0, error: "帧下标 " + spec.fi + " 不存在（当前文档的帧允许 0.." + (doc.frames.length - 1) + "）" };
  if (L.ref) return { changed: false, rect: null, pixels: 0, error: "图层 " + spec.li + " 是参考图层（它只镜像别处的像素），请在源画布上做变换" };
  if (L.locked) return { changed: false, rect: null, pixels: 0, error: "图层 " + spec.li + " 已锁定" };
  if (spec.scope === "selection" && !doc.selectionActive()) {
    return { changed: false, rect: null, pixels: 0, error: "scope=selection 需要先建立选区（当前没有选区；scope=layer 变换整个图层）" };
  }
  const cel = doc.celAt(spec.li, spec.fi);
  if (!cel) return { changed: false, rect: null, pixels: 0, error: "图层 " + spec.li + " 的第 " + spec.fi + " 帧是空的，没有可变换的内容" };

  const rad = (spec.angle * Math.PI) / 180;
  const angle = spec.mode === "rotate" ? (spec.snap ? snapCleanAngle(rad) : rad) : 0;
  // 单位变换：不动文档、不压历史（与 UI 的「进了会话但没拖」同一个口径）
  if (spec.mode === "move" && !spec.dx && !spec.dy) return { changed: false, rect: null, pixels: 0 };
  if (spec.mode === "scale" && spec.sx === 1 && spec.sy === 1) return { changed: false, rect: null, pixels: 0 };
  if (spec.mode === "rotate" && Math.abs(normAngle(angle)) < 1e-9) return { changed: false, rect: null, pixels: 0 };

  // 浮动内容：选区范围＝选区里的像素（beginMove 抓下来）；整层范围＝整幅画布
  let st: MoveState;
  if (spec.scope === "selection") {
    const mv = beginMove(doc, spec.li, spec.fi);
    if (!mv) return { changed: false, rect: null, pixels: 0, error: "选区为空，或该图层这一帧没有内容" };
    st = mv;
  } else {
    const content = new Cel(doc.w, doc.h);
    content.data.set(cel.data);
    st = { content, mask: new Uint8Array(doc.w * doc.h).fill(1), ox: 0, oy: 0, before: new Uint8ClampedArray(cel.data) };
  }

  // 选区掩码：变换后要「跟着内容走」（选区分档，与 UI 一致）；整层分档不碰用户的选区
  const selBefore = doc.sel;
  const selMask = selBefore ? new Uint8Array(selBefore.mask) : null;
  const restoreSel = (): void => {
    if (selBefore) {
      if (selMask) selBefore.mask.set(selMask);
      selBefore.bump();                       // ver 变了，视图的选区着色缓存才会失效
      if (doc.sel !== selBefore) doc.sel = selBefore;
    } else {
      doc.sel = null;
    }
  };

  const cw = st.content.w, ch = st.content.h;
  const pivot = pivotPresetPoint(contentBox(cw, ch), spec.pivot);
  const m = affineFrom({
    pivot, angle,
    sx: spec.mode === "scale" ? clampScale(spec.sx) : 1,
    sy: spec.mode === "scale" ? clampScale(spec.sy) : 1,
    // 位移走「屏幕方向的整格平移」（affineFrom 把它叠在旋转之后），像素画里移动永远是整格
    shift: spec.mode === "move" ? { x: Math.round(spec.dx), y: Math.round(spec.dy) } : { x: 0, y: 0 },
  });
  const buf = new Uint8ClampedArray(doc.w * doc.h * 4);
  const cells = xformAffineFloating(doc, st, m, buf, xformAffineDestBox(m, cw, ch, st.ox, st.oy));
  if (spec.scope === "layer") restoreSel();
  if (!cells.length) {
    // 内容整个被推出画布 / 缩成一条线：什么都不做（想删内容有专门的删除入口）
    restoreSel();
    return { changed: false, rect: null, pixels: 0 };
  }
  let x0 = doc.w, y0 = doc.h, x1 = -1, y1 = -1;
  for (const di of cells) {
    const x = di % doc.w, y = (di - x) / doc.w;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const rect: Rect = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  const label = spec.mode === "move" ? XF_LABEL.move : spec.mode === "scale" ? XF_LABEL.scale : XF_LABEL.rotate;
  s.maskOp(label, () => {
    // floatCut 必须在 maskOp 里面：pushStruct 要捕获**原位**的 cel 当前像
    selOps.floatCut(doc, spec.li, spec.fi, st);
    const data = cel.data;
    for (const di of cells) {
      const o = di * 4;
      data[o] = buf[o];
      data[o + 1] = buf[o + 1];
      data[o + 2] = buf[o + 2];
      data[o + 3] = buf[o + 3];
    }
  });
  return { changed: true, rect, pixels: cells.length };
}
