// C1 工具表（docs/PLAN-ai.md §3.1 工具面 / §3.6 权限分级 / §4 映射表 / §5.1 C1 契约）：
// schema + 参数校验 + tier 分级 + 调用分发。
//
// 这一层做的事只有一件：**把「模型给的 JSON」翻译成「既有 Session 方法的一次调用」**。
// 每条 handler 只做参数适配（解析 fg/bg、把 "current" 换成当前图层/帧、把枚举串换成既有
// 方法的联合类型），**绝不新增写入路径** —— 不直接改 doc/cel/palette，不绕过 history。
// 机械核对这条约束的办法写在 tests/ai-tools.test.ts：静态扫源文件里所有 `s.<方法>(` 调用，
// 逐个断言它真的存在于 `Session.prototype` 上。
//
// 为什么 destructive 必须走确认（§3.6）：
//   `layer_delete` / `layer_merge_down` / `frame_delete` / `canvas_clear` / `scale` 这几条，
//   一次调用就能把用户的作品删掉一大块。历史只有 120 步（`prefs.histSteps`），而用户未必记得
//   哪一步是 AI 干的；「模型幻觉 + 无确认」的代价是整个作品。所以 callTool 的顺序是**死**的：
//   ① 先 validateArgs（不合格直接返回，**不执行、不确认**）→ ② tier===destructive 才 await
//   ctx.confirm({tool,tier,summary})，false → `{ok:false, error:"cancelled"}` 且文档一个字节不动
//   → ③ 才执行 handler，并把结果原样返回。测试钉住了「取消时逐字节不变」。
//   注意：**tier 不决定 callTool 能不能调**（那是 C3 服务层的开关），它只决定要不要确认、
//   以及 listTools 默认给不给（`ui` 档默认不给，见 §3.6）。
//
// 为什么工具 id 与 Session.allActions() 共用命名空间（§3.1 原则 4）：
//   界面按钮、快捷键、动作搜索面板、AI 工具必须指向**同一批 id**，否则「AI 说它撤销了」
//   和「用户看到的撤销按钮」会漂成两套名字，动作也搬不动（浮动球 / 工具栏互搬就靠 id）。
//   能对上的直接复用 → `AI_TOOL_ACTION_IDS`（undo / redo 是动作表里真的有的两条）；
//   对不上的新 id 一律登记进 `AI_TOOL_ID_WHITELIST`。测试断言的是**相等**：
//   `AI_TOOL_ACTION_IDS ∪ AI_TOOL_ID_WHITELIST === 工具表 id 集合`（两个集合互不相交）。
//   加/删工具必须同时改白名单，所以白名单不会变成垃圾桶。
//
// 参数越界口径（§3.1 原则 2 的落地选择）：**拒绝，不静默钳制**。
//   validateArgs 对 int 的小数/越界、enum 取值、颜色格式、数组长度一律返回 `{ok:false, reason}`，
//   reason 里带允许范围。理由是「宁可让模型重发一次，也不要把『画在 A 处』悄悄变成『画在 B 处』」。
//   另一层（引擎侧真的会改小参数的 size/tolerance/通道值）由 `ai-doc.applyOps` 记 `clamped:` 警告，
//   那是文档层的事，不在这一层重复。
//
// 与 C0 的接缝：读类工具直接转发 `ai-doc.ts` 的 `docDigest` / `readRegion`（纯函数，无 DOM）；
//   写类工具当前一律走 `Session` 的既有方法，`applyOps` 留给 C2/C5 的「应用一批操作」入口。
//
// P1 像素级工具面（后来补的这批：draw_path / draw_shape / fill / erase / transform / fx_*×8）：
//   这一批的 handler 仍然只做参数适配，落笔在 `src/app/ai-draw.ts` —— 那里组合的是
//   `tools/stroke.ts` 的 Stroke（笔迹 / 形状 / 油漆桶 / 擦除）、`engine/effects.ts` 的 8 个
//   既有特效、`tools/xform.ts` 的纯仿射 + `tools/select.ts` 的浮动模型。**两边都没有新增写入
//   路径**：本文件只把 engine 的既有函数原样递给 ai-draw 去跑，历史一律由 `Stroke.commit()`
//   或 `Session.maskOp()` 压栈；`tests/ai-draw.test.ts` 用与这里同一条静态规则盯着那个文件。
//   tier 判据（加新工具时照这个判；t14 起改成与实现自洽的表述）：
//     · **draw ＝ 用画笔能画出的任何效果**：笔迹、形状、油漆桶、橡皮笔刷 —— 也包括
//       **以透明色填充**（`fill{color:"#00000000"}`）与**用橡皮画笔擦**（`draw_path{tool:"eraser"}`）：
//       它们与界面里同一支笔（油漆桶的「擦」、橡皮工具）逐字节同源，不因为「擦」这个字就换档。
//       ⚠ 这不等于 draw 档「无害」：`fill` 的 tolerance=255 配透明色一次就能擦掉整层像素
//       （t5 实测 4096 → 0）。这类工具能留在 draw 档，靠的是助手路线的兜底 ——
//       「预览后应用 + 一轮一条 undo」（PLAN-ai §3.3 / C5），不是 tier 本身。
//     · **destructive ＝ 清空 / 替换 / 删除整块画布（整帧全图层）级操作**，外加**按 rect / scope
//       删掉或搬走一整块已有像素**：`canvas_clear`、`layer_delete` / `layer_merge_down` /
//       `frame_delete`、`scale`（重采样整张画布或整层）、`erase`（把 rect 里的内容清成透明）、
//       `transform`（按 scope 平移 / 缩放 / 旋转，可能把像素推出画布）。未确认时**逐字节不动**。
//   `transform` 里「与 mode 无关的参数」是**报错**而不是静默忽略：模型按别的 mode 填了一组参数
//   时，静默成功会得到一个「看起来对、其实没动」的结果，比报错难查得多（§3.1 原则 2 同一条口径）。
//
// 两处对 §5.1 接口的**加字段**（只加可选字段，不改既有字段语义）：
//   · `AiToolResult.data`：§5.1 只留了 ok/changed/docRev/warn/error，读类工具的结果（摘要 / 区域）
//     没有地方放；
//   · `AiToolParam.optional`：§5.1 只有 default，而 default 会把「没说」变成「显式设成这个值」，
//     补丁类工具（`iso_set` 只改想改的参数）需要「省略 = 不动这一项」。
//   §5.1 里列出的四个函数签名（listTools / getTool / validateArgs / callTool）一字未改。

import { hexToRgba, rgbaToHex } from "../engine/color";
import * as fxE from "../engine/effects";
import { ISO_SHAPES, ISO_TILES } from "../engine/iso";
import type { IsoShapeId, IsoTile } from "../engine/iso";
import { SCALE_ALGOS } from "../engine/resample";
import { BLEND_MODES } from "../engine/types";
import type { Rect, RGBA } from "../engine/types";
import { CORE_TOOLS, SELECT_TOOLS, SHAPE_TOOLS } from "../tools/registry";
import type { ToolId } from "../tools/registry";
import type { PivotPreset } from "../tools/xform";
import {
  AI_FX_SCOPES, AI_PIVOTS, AI_SCALE_MAX, AI_SCALE_MIN, AI_SHAPE_KINDS, AI_STROKE_KINDS, AI_SYMS,
  AI_XFORM_MODES, AI_XFORM_SCOPES, applyFx, runStroke, runTransform,
} from "./ai-draw";
import type { AiFxScope, AiStrokeKind, AiSymName, AiXformMode, AiXformScope, CelFx } from "./ai-draw";
import { AI_MAX_REGION_PIXELS, docDigest, readRegion } from "./ai-doc";
import type { Session, IsoPrefs, ScaleScope } from "./session";

/** 权限分级（§3.6）：read 只读 / draw 允许（可关）/ destructive 每次确认 / ui 默认不暴露 */
export type AiTier = "read" | "draw" | "destructive" | "ui";

export type AiParamType = "int" | "num" | "bool" | "string" | "enum" | "color" | "xy" | "rect" | "array";

export interface AiToolParam {
  type: AiParamType;
  /** type === "enum" 时的取值表 */
  values?: string[];
  /** int/num = 数值范围（闭区间）；string = 字符数；array = 元素个数 */
  min?: number;
  max?: number;
  /** 省略该参数时用的值；int 参数可以用 AI_ARG_CURRENT（= 当前图层/帧） */
  default?: unknown;
  /** 可以省略、且省略时**不进** value（handler 靠 `a.x !== undefined` 判断）：
   *  「只改想改的字段」的补丁类工具需要它（`iso_set`）。§5.1 的 AiToolParam 只有 default，
   *  而 default 会把「没说」变成「显式设成这个值」，语义不对，所以这里加一个可选字段。 */
  optional?: boolean;
  /** type === "array" 时元素的类型 */
  items?: AiParamType;
  desc?: string;
}

export interface AiToolResult {
  ok: boolean;
  /** 实际碰到的像素并集矩形；拿不到矩形的方法（调色板类）省掉这个字段 */
  changed?: Rect | null;
  /** 写入后的文档版本号（`Doc.pixelRev`）：模型据此判断"我的改动生效了吗" */
  docRev?: number;
  warn?: string[];
  error?: string;
  /** 输出负载。§5.1 的 AiToolResult 只留了 ok/changed/docRev/warn/error，读类工具的结果
   *  （摘要对象 / 区域对象）没有地方放，所以这里加一个可选字段 —— **不改既有字段的语义**。 */
  data?: unknown;
}

export interface AiToolCtx {
  session: Session;
  /** destructive 档的确认回调（复用现有确认框机制）；返回 false = 用户点了取消 */
  confirm: (req: { tool: string; tier: AiTier; summary: string }) => Promise<boolean>;
  /** C2 的回合（还没接线时为 null）：开着才在成功的写操作后 mark 一次 */
  turn: { isOpen(): boolean; mark(): void } | null;
}

export type AiToolHandler = (args: Record<string, unknown>, ctx: AiToolCtx) => AiToolResult | Promise<AiToolResult>;

export interface AiTool {
  /** 与 Session.allActions() 同一命名空间（见文件头） */
  id: string;
  /** 纯文本（工具表这一层不翻译，UI 再查 i18n） */
  title: string;
  tier: AiTier;
  params: Record<string, AiToolParam>;
  returns: Record<string, string>;
  handler: AiToolHandler;
}

/** 省略「当前图层 / 当前帧」时的哨兵值（PLAN-ai §3.1 的 `"default": "current"`） */
export const AI_ARG_CURRENT = "current";

/** tier 的规范顺序：listTools 就按这个分组（默认跳过 ui） */
export const AI_TIER_ORDER: readonly AiTier[] = ["read", "draw", "destructive", "ui"];

/** 工具表里**复用** Session.allActions() 命名空间的 id（动作表里真的有这两条） */
export const AI_TOOL_ACTION_IDS: readonly string[] = ["undo", "redo"];

/** 工具表**自己新造**的 id（动作表里没有）。加/删工具必须同步改这里 ——
 *  ai-tools.test.ts 断言 `AI_TOOL_ACTION_IDS ∪ AI_TOOL_ID_WHITELIST` 与工具表 id 集合**相等**。 */
export const AI_TOOL_ID_WHITELIST: readonly string[] = [
  "canvas_clear",
  "color_analyse",
  "color_groups",
  "color_merge_group",
  "color_replace",
  "color_select",
  "doc_digest",
  "draw_path",
  "draw_shape",
  "erase",
  "fill",
  "frame_add",
  "frame_delete",
  "frame_duplicate",
  "frame_duration",
  "frame_move",
  "frame_move_to",
  "frame_select",
  "fx_blur",
  "fx_glow",
  "fx_gray",
  "fx_inline",
  "fx_invert",
  "fx_outline",
  "fx_round",
  "fx_shadow",
  "iso_generate",
  "iso_origin",
  "iso_set",
  "layer_add",
  "layer_blend",
  "layer_delete",
  "layer_down",
  "layer_duplicate",
  "layer_merge_down",
  "layer_move_to",
  "layer_opacity",
  "layer_rename",
  "layer_select",
  "layer_toggle_lock",
  "layer_toggle_solo",
  "layer_toggle_visible",
  "layer_up",
  "palette_add",
  "palette_dedupe",
  "palette_from_canvas",
  "palette_merge",
  "palette_remap",
  "palette_remove",
  "palette_sort",
  "read_region",
  "scale",
  "set_tool",
  "tag_add",
  "tag_remove",
  "tag_rename",
  "tag_set_color",
  "tag_set_range",
  "transform",
];

// ------------------------------------------------------------------ 参数校验

const COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function describe(v: unknown): string {
  if (v === undefined) return "undefined（缺参数）";
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return "数组(" + v.length + " 项)";
  return typeof v === "object" ? "对象" : typeof v;
}

/** 严格数字：只认 JSON 里的 number（不认 "12" 这种字符串，免得模型把坐标写成字符串还能过） */
function numOf(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function spanOf(p: AiToolParam): string {
  if (p.min !== undefined && p.max !== undefined) return p.min + ".." + p.max;
  if (p.min !== undefined) return "≥ " + p.min;
  if (p.max !== undefined) return "≤ " + p.max;
  return "任意";
}

function fail(name: string, why: string): { ok: false; reason: string } {
  return { ok: false, reason: "参数 " + name + ": " + why };
}

type CheckResult = { ok: true; value: unknown } | { ok: false; reason: string };

function checkRange(name: string, p: AiToolParam, n: number): CheckResult {
  if (p.min !== undefined && n < p.min) {
    return fail(name, n + " 小于最小值 " + p.min + "（允许 " + spanOf(p) + "；不做静默钳制，请自己收进范围）");
  }
  if (p.max !== undefined && n > p.max) {
    return fail(name, n + " 大于最大值 " + p.max + "（允许 " + spanOf(p) + "；不做静默钳制，请自己收进范围）");
  }
  return { ok: true, value: n };
}

function checkParam(name: string, p: AiToolParam, v: unknown): CheckResult {
  switch (p.type) {
    case "int": {
      const n = numOf(v);
      if (n === null) return fail(name, "期望整数，收到 " + describe(v));
      if (!Number.isInteger(n)) return fail(name, "期望整数，收到小数 " + n + "（请自己取整）");
      return checkRange(name, p, n);
    }
    case "num": {
      const n = numOf(v);
      if (n === null) return fail(name, "期望数字，收到 " + describe(v));
      return checkRange(name, p, n);
    }
    case "bool":
      if (typeof v !== "boolean") return fail(name, "期望 true/false，收到 " + describe(v));
      return { ok: true, value: v };
    case "string": {
      if (typeof v !== "string") return fail(name, "期望字符串，收到 " + describe(v));
      if (p.min !== undefined && v.length < p.min) return fail(name, "长度 " + v.length + " 小于允许的 " + spanOf(p));
      if (p.max !== undefined && v.length > p.max) return fail(name, "长度 " + v.length + " 大于允许的 " + spanOf(p));
      return { ok: true, value: v };
    }
    case "enum": {
      const vals = p.values ?? [];
      if (typeof v !== "string") return fail(name, "期望枚举字符串，收到 " + describe(v));
      if (vals.indexOf(v) < 0) return fail(name, JSON.stringify(v) + " 不在 " + JSON.stringify(vals));
      return { ok: true, value: v };
    }
    case "color":
      if (typeof v !== "string") return fail(name, "期望颜色，收到 " + describe(v));
      if (v !== "fg" && v !== "bg" && !COLOR_RE.test(v)) {
        return fail(name, JSON.stringify(v) + " 不是颜色（支持 #rgb / #rrggbb / #rrggbbaa / fg / bg）");
      }
      return { ok: true, value: v };
    case "xy": {
      if (!Array.isArray(v) || v.length !== 2) return fail(name, "期望 [x,y]，收到 " + describe(v));
      const out: number[] = [];
      for (let i = 0; i < 2; i++) {
        const n = numOf(v[i]);
        if (n === null || !Number.isInteger(n)) return fail(name + "[" + (i === 0 ? "x" : "y") + "]", "期望整数，收到 " + describe(v[i]));
        out.push(n);
      }
      return { ok: true, value: out };
    }
    case "rect": {
      if (!v || typeof v !== "object" || Array.isArray(v)) return fail(name, "期望 {x,y,w,h}，收到 " + describe(v));
      const o = v as Record<string, unknown>;
      for (const k of Object.keys(o)) {
        if (k !== "x" && k !== "y" && k !== "w" && k !== "h") return fail(name, "未知字段 " + k + "（只接受 x,y,w,h）");
      }
      const box: Record<string, number> = {};
      for (const k of ["x", "y", "w", "h"]) {
        const n = numOf(o[k]);
        if (n === null || !Number.isInteger(n)) return fail(name + "." + k, "期望整数，收到 " + describe(o[k]));
        box[k] = n;
      }
      if (box.w < 0 || box.h < 0) return fail(name, "w/h 不能为负（收到 w=" + box.w + ", h=" + box.h + "）");
      return { ok: true, value: { x: box.x, y: box.y, w: box.w, h: box.h } };
    }
    case "array": {
      if (!Array.isArray(v)) return fail(name, "期望数组，收到 " + describe(v));
      if (p.min !== undefined && v.length < p.min) return fail(name, "长度 " + v.length + " 小于允许的 " + spanOf(p));
      if (p.max !== undefined && v.length > p.max) return fail(name, "长度 " + v.length + " 大于允许的 " + spanOf(p));
      const itemParam: AiToolParam = { type: p.items ?? "num" };
      const out: unknown[] = [];
      for (let i = 0; i < v.length; i++) {
        const r = checkParam(name + "[" + i + "]", itemParam, v[i]);
        if (r.ok === false) return r;
        out.push(r.value);
      }
      return { ok: true, value: out };
    }
    default:
      return fail(name, "未知参数类型 " + String(p.type));
  }
}

/**
 * 校验并按 schema **补齐默认值**（返回的是新对象，不改调用方给的那个）。
 * 口径：严格 —— 多给字段、类型不符、越界、枚举不认识，一律 `{ok:false, reason}`（不钳制）。
 */
export function validateArgs(tool: AiTool, args: unknown):
  { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  const raw: unknown = args === undefined || args === null ? {} : args;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "参数必须是对象（收到 " + describe(raw) + "）" };
  }
  const src = raw as Record<string, unknown>;
  const names = Object.keys(tool.params);
  for (const k of Object.keys(src)) {
    if (Object.prototype.hasOwnProperty.call(tool.params, k)) continue;
    return { ok: false, reason: "未知参数 " + k + "（本工具接受：" + (names.length ? names.join(", ") : "无参数") + "）" };
  }
  const value: Record<string, unknown> = {};
  for (const name of names) {
    const p = tool.params[name];
    const given = Object.prototype.hasOwnProperty.call(src, name) && src[name] !== undefined;
    if (!given) {
      if (p.default === undefined) {
        if (p.optional === true) continue; // 补丁类参数：省略 = 不改这一项
        return { ok: false, reason: "缺少必填参数 " + name + "（" + p.type + "，允许 " + spanOf(p) + "）" };
      }
      value[name] = p.default;
      continue;
    }
    const r = checkParam(name, p, src[name]);
    if (r.ok === false) return { ok: false, reason: r.reason };
    value[name] = r.value;
  }
  return { ok: true, value };
}

// ------------------------------------------------------------------ handler 小工具

/** int 参数的取值：AI_ARG_CURRENT / undefined → fallback（当前图层、当前帧） */
function at(v: unknown, fallback: number): number {
  return v === AI_ARG_CURRENT || v === undefined ? fallback : Number(v);
}

/** color 参数 → RGBA（fg/bg 取会话里的前景/背景色；其余走既有 hexToRgba） */
function rgbaOf(v: unknown, s: Session): RGBA {
  const c = String(v);
  if (c === "fg") return s.fg;
  if (c === "bg") return s.bg;
  return hexToRgba(c);
}

/** 写类工具的通用结果：ok + 版本号 +（可选）负载 */
function done(s: Session, data?: unknown): AiToolResult {
  const r: AiToolResult = { ok: true, docRev: s.doc.pixelRev };
  if (data !== undefined) r.data = data;
  return r;
}

function rectOf(v: unknown): Rect {
  const o = v as { x: number; y: number; w: number; h: number };
  return { x: o.x, y: o.y, w: o.w, h: o.h };
}

/** 写类工具的统一结果：ok + docRev +（真碰到像素时）changed 矩形 + data */
function written(
  s: Session,
  r: { changed: boolean; rect: Rect | null; error?: string },
  extra?: Record<string, unknown>,
): AiToolResult {
  if (r.error) return { ok: false, error: r.error, docRev: s.doc.pixelRev };
  const data: Record<string, unknown> = { changed: r.changed };
  if (extra) for (const k of Object.keys(extra)) data[k] = extra[k];
  const out: AiToolResult = { ok: true, docRev: s.doc.pixelRev, data };
  if (r.rect) out.changed = r.rect;
  return out;
}

/**
 * `draw_path` 的点数口径（§3.1 原则 2：越界/多给的参数**拒绝**，不静默忽略）：
 * 形状工具只看首尾两点，所以必须**恰好 2 个**；油漆桶只看种子，必须**恰好 1 个**；
 * pencil / eraser 是折线，1..4096 都合法（schema 已经拦了上限）。
 */
function pathPointCountError(kind: string, n: number): string | null {
  if (kind === "line" || kind === "rect" || kind === "ellipse") {
    return n === 2 ? null : "tool=" + kind + " 需要恰好 2 个点（起点与终点，允许 2；收到 " + n + " 个）";
  }
  if (kind === "bucket") {
    return n === 1 ? null : "tool=bucket 需要恰好 1 个点（填充种子，允许 1；收到 " + n + " 个）";
  }
  return null;
}

/** 点必须在画布内（xy 参数没范围可限，只有这里能拦） */
function inCanvasError(s: Session, x: number, y: number, name: string): string | null {
  const w = s.doc.w, h = s.doc.h;
  if (x < 0 || y < 0 || x >= w || y >= h) {
    return name + " 必须在画布内（x 允许 0.." + (w - 1) + "，y 允许 0.." + (h - 1) + "；收到 [" + x + ", " + y + "]）";
  }
  return null;
}

/** 渐变量化档 → 引擎的块大小（`engine/paint.ts` 的 gradientFillRegion 收 1 / 2 / 4 / 8） */
const GRAD_BLOCK: Record<string, number> = { rgb: 1, "2": 2, "4": 4, "8": 8 };

/** fx_* 共用的三个参数（作用范围 + 目标图层 / 帧） */
const FX_TARGET: Record<string, AiToolParam> = {
  scope: { type: "enum", values: AI_FX_SCOPES.slice(), default: "layer",
    desc: "layer = 整个图层；selection = 只在当前选区里生效（需要先建立选区）" },
  layer: { type: "int", min: 0, default: AI_ARG_CURRENT, desc: "图层号，省略 = 当前图层" },
  frame: { type: "int", min: 0, default: AI_ARG_CURRENT, desc: "帧号，省略 = 当前帧" },
};

/** 确认框里给用户看的一句话（纯文本，C3/C5 直接显示） */
export function summarizeToolCall(tool: AiTool, value: Record<string, unknown>): string {
  const keys = Object.keys(value);
  const args = keys.length ? keys.map((k) => k + "=" + JSON.stringify(value[k])).join(", ") : "无参数";
  return tool.title + "：" + args;
}

const TOOL_IDS: readonly string[] = [...AI_TOOL_ACTION_IDS, ...AI_TOOL_ID_WHITELIST];

const ALL_TOOL_IDS: readonly string[] = [...CORE_TOOLS, ...SHAPE_TOOLS, ...SELECT_TOOLS].map((t) => t.id);

function tool(
  id: string,
  title: string,
  tier: AiTier,
  params: Record<string, AiToolParam>,
  returns: Record<string, string>,
  handler: AiToolHandler,
): AiTool {
  return { id, title, tier, params, returns, handler };
}

/** fx_* 的公共尾巴：把「作用范围 + 目标图层 / 帧」翻成 ai-draw 的一次 applyFx */
function fxResult(s: Session, label: string, fn: CelFx, a: Record<string, unknown>): AiToolResult {
  const r = applyFx(s, label, fn, {
    li: at(a.layer, s.curLayer()),
    fi: at(a.frame, s.curFrame()),
    scope: a.scope as AiFxScope,
  });
  return written(s, r, { pixels: r.pixels });
}

// ------------------------------------------------------------------ 工具表

/** 读类工具共用的 returns 描述 */
const R_READ: Record<string, string> = { ok: "true", docRev: "文档版本号", data: "读到的结构化结果", warn: "提示（可空）" };

const TOOLS: readonly AiTool[] = [
  // ---------------- read：只读，默认给 ----------------
  tool("doc_digest", "读文档摘要", "read",
    {
      fi: { type: "int", min: 0, default: AI_ARG_CURRENT, desc: "帧号，省略 = 当前帧" },
    },
    { ...R_READ, data: "AiDigest（尺寸/图层/帧/标签/调色板/包围盒/单行摘要 text）" },
    (a, ctx) => {
      const s = ctx.session;
      const d = docDigest(s.doc, { fi: at(a.fi, s.curFrame()) });
      return { ok: true, docRev: d.docRev, data: d };
    }),

  tool("read_region", "读一块像素区域", "read",
    {
      rect: { type: "rect", desc: "要读的区域 {x,y,w,h}（画布坐标，越界会被裁剪并置 clipped）" },
      fi: { type: "int", min: 0, default: AI_ARG_CURRENT, desc: "帧号，省略 = 当前帧" },
      li: { type: "int", min: 0, default: AI_ARG_CURRENT, desc: "图层号，省略 = 当前图层" },
      rle: { type: "bool", default: false, desc: "行内 RLE（调色板超过 52 色时自动关闭）" },
      maxPixels: { type: "int", min: 1, max: AI_MAX_REGION_PIXELS, default: AI_MAX_REGION_PIXELS, desc: "像素上限（token 预算闸门）" },
    },
    { ...R_READ, data: "AiRegion（rows 索引网格 / palette / clipped / text）" },
    (a, ctx) => {
      const s = ctx.session;
      const r = readRegion(s.doc, rectOf(a.rect), {
        fi: at(a.fi, s.curFrame()), li: at(a.li, s.curLayer()),
        rle: a.rle === true, maxPixels: Number(a.maxPixels),
      });
      return { ok: true, docRev: s.doc.pixelRev, data: r };
    }),

  tool("color_analyse", "统计颜色", "read",
    {
      scope: { type: "enum", values: ["canvas", "layer", "selection", "allFrames"], default: "canvas" },
      sort: { type: "enum", values: ["count", "hue", "light"], default: "count" },
    },
    { ...R_READ, data: "ColourAnalysis（entries / totalPixels / opaquePixels / 直方图 …）" },
    (a, ctx) => {
      const s = ctx.session;
      const r = s.analyseCanvas(a.scope as "canvas" | "layer" | "selection" | "allFrames", a.sort as "count" | "hue" | "light");
      return { ok: true, docRev: s.doc.pixelRev, data: r };
    }),

  tool("color_groups", "近似色分组", "read",
    {
      scope: { type: "enum", values: ["canvas", "layer", "selection", "allFrames"], default: "canvas" },
      tol: { type: "int", min: 0, max: 255, default: 12, desc: "近似阈值（引擎默认 12）" },
    },
    { ...R_READ, data: "分组结果：[{rep, members[], count}]" },
    (a, ctx) => {
      const s = ctx.session;
      const an = s.analyseCanvas(a.scope as "canvas" | "layer" | "selection" | "allFrames", "count");
      return { ok: true, docRev: s.doc.pixelRev, data: s.colourGroups(an, Number(a.tol)) };
    }),

  // ---------------- draw：允许（可关） ----------------
  // P1 像素级工具面（docs/PLAN-ai.md §4 里标 C5+ 的那批）：handler 只做参数适配，
  // 落笔 / 特效 / 变换全部交给 src/app/ai-draw.ts（那里只组合 Stroke 与 engine 既有函数）。
  tool("draw_path", "画一条路径", "draw",
    {
      points: { type: "array", items: "xy", min: 1, max: 4096, desc: "折线顶点 [x,y]，画布坐标（越界的部分自然被裁掉）" },
      tool: { type: "enum", values: AI_STROKE_KINDS.slice(), default: "pencil",
        desc: "落笔方式：pencil / eraser ＝ 折线笔迹（逐点连线），line / rect / ellipse ＝ 只取首尾两点，bucket ＝ 只取首点当填充种子" },
      size: { type: "int", min: 1, max: 64, default: 1, desc: "笔尖直径：笔迹与空心形状的线宽（实心形状只用它算脏矩形）" },
      color: { type: "color", default: "fg", desc: "颜色；tool=eraser 时忽略（橡皮固定擦除）" },
      sym: { type: "enum", values: AI_SYMS.slice(), default: "off",
        desc: "对称：h ＝ 水平镜像线（上下对称），v ＝ 垂直镜像线（左右对称），both / 4 ＝ 两条线（四向）" },
      fill: { type: "bool", default: true, desc: "tool=rect / ellipse 时是否实心" },
      brush: { type: "enum", values: ["circle", "square"], optional: true, desc: "笔尖形状，省略 = 用当前的画笔形状" },
      layer: { type: "int", min: 0, default: AI_ARG_CURRENT, desc: "图层号，省略 = 当前图层" },
      frame: { type: "int", min: 0, default: AI_ARG_CURRENT, desc: "帧号，省略 = 当前帧" },
    },
    { ok: "true / false（点数与 tool 不匹配 / 图层锁定 / 下标不存在）", changed: "画到的像素并集矩形", data: "{ changed }", docRev: "文档版本号" },
    (a, ctx) => {
      const s = ctx.session;
      const kind = a.tool as AiStrokeKind;
      const pts = (a.points as number[][]).map((p) => [p[0], p[1]] as [number, number]);
      const bad = pathPointCountError(kind, pts.length);
      if (bad) return { ok: false, error: bad, docRev: s.doc.pixelRev };
      const r = runStroke(s, {
        kind, li: at(a.layer, s.curLayer()), fi: at(a.frame, s.curFrame()),
        size: Number(a.size), color: rgbaOf(a.color, s), sym: a.sym as AiSymName,
        shapeFill: a.fill === true, points: pts, label: "draw-path",
        brushShape: a.brush === undefined ? undefined : (a.brush as "circle" | "square"),
      });
      return written(s, r);
    }),

  tool("draw_shape", "画一个形状", "draw",
    {
      shape: { type: "enum", values: AI_SHAPE_KINDS.slice(), desc: "line / rect / ellipse" },
      from: { type: "xy", desc: "起点 [x,y]（含）" },
      to: { type: "xy", desc: "终点 [x,y]（含）；rect / ellipse 用它和 from 组成外接矩形" },
      fill: { type: "bool", default: false, desc: "rect / ellipse 是否实心（line 忽略）" },
      size: { type: "int", min: 1, max: 64, default: 1, desc: "线宽（笔尖直径）" },
      color: { type: "color", default: "fg", desc: "#rrggbb / #rrggbbaa / fg / bg" },
      sym: { type: "enum", values: AI_SYMS.slice(), default: "off", desc: "对称（同 draw_path）" },
      brush: { type: "enum", values: ["circle", "square"], optional: true, desc: "笔尖形状，省略 = 用当前的画笔形状" },
      layer: { type: "int", min: 0, default: AI_ARG_CURRENT, desc: "图层号，省略 = 当前图层" },
      frame: { type: "int", min: 0, default: AI_ARG_CURRENT, desc: "帧号，省略 = 当前帧" },
    },
    { ok: "true / false（图层锁定 / 下标不存在）", changed: "画到的像素并集矩形", data: "{ changed }", docRev: "文档版本号" },
    (a, ctx) => {
      const s = ctx.session;
      const r = runStroke(s, {
        kind: a.shape as AiStrokeKind,
        li: at(a.layer, s.curLayer()), fi: at(a.frame, s.curFrame()),
        size: Number(a.size), color: rgbaOf(a.color, s), sym: a.sym as AiSymName,
        shapeFill: a.fill === true, points: [a.from as number[], a.to as number[]] as Array<[number, number]>,
        label: "draw-shape",
        brushShape: a.brush === undefined ? undefined : (a.brush as "circle" | "square"),
      });
      return written(s, r);
    }),

  tool("fill", "油漆桶填充", "draw",
    {
      at: { type: "xy", desc: "填充种子 [x,y]（必须在画布内）" },
      color: { type: "color", default: "fg", desc: "填充色（alpha=0 时＝擦掉这片区域，与油漆桶的「擦」一致）" },
      tolerance: { type: "int", min: 0, max: 255, default: 0, desc: "per-channel 容差（0 = 只填与种子完全同色的区域）" },
      gaps: { type: "int", min: 0, max: 16, default: 0, desc: "封口：填之前把轮廓上 ≤N px 的缺口补上（0 = 不封口）" },
      global: { type: "bool", default: false, desc: "true = 整层同色像素全填（不连通），false = 只填相连区域" },
      gradient: { type: "bool", default: false, desc: "true = 填成 color → gradientTo 的渐变" },
      gradientTo: { type: "color", default: "bg", desc: "渐变终点色（只在 gradient=true 时有意义）" },
      gradientBlock: { type: "enum", values: ["rgb", "2", "4", "8"], default: "rgb", desc: "渐变量化：rgb = 逐像素，其余 = 按 N×N 色块" },
      gradientAt: { type: "xy", optional: true, desc: "渐变方向与长度：从 at 指向这个点；省略 = 区域包围盒自上而下" },
      sym: { type: "enum", values: AI_SYMS.slice(), default: "off", desc: "对称（同 draw_path）" },
      layer: { type: "int", min: 0, default: AI_ARG_CURRENT, desc: "图层号，省略 = 当前图层" },
      frame: { type: "int", min: 0, default: AI_ARG_CURRENT, desc: "帧号，省略 = 当前帧" },
    },
    { ok: "true / false（种子在画布外 / 图层锁定 / 参数矛盾）", changed: "被填到的像素并集矩形", data: "{ changed }", docRev: "文档版本号" },
    (a, ctx) => {
      const s = ctx.session;
      const seed = a.at as number[];
      const bad = inCanvasError(s, seed[0], seed[1], "at");
      if (bad) return { ok: false, error: bad, docRev: s.doc.pixelRev };
      const grad = a.gradient === true;
      const gradAt = a.gradientAt as number[] | undefined;
      if (!grad && gradAt) {
        return { ok: false, error: "gradientAt 只在 gradient=true 时有意义（当前 gradient=false）；要么打开渐变，要么去掉 gradientAt", docRev: s.doc.pixelRev };
      }
      const r = runStroke(s, {
        kind: "bucket", li: at(a.layer, s.curLayer()), fi: at(a.frame, s.curFrame()),
        size: 1, color: rgbaOf(a.color, s), sym: a.sym as AiSymName,
        fillTolerance: Number(a.tolerance), fillGaps: Number(a.gaps), bucketGlobal: a.global === true,
        gradient: grad ? { end: rgbaOf(a.gradientTo, s), block: GRAD_BLOCK[String(a.gradientBlock)] ?? 1 } : null,
        gradientTo: grad && gradAt ? [gradAt[0], gradAt[1]] : null,
        points: [[seed[0], seed[1]]], label: "fill",
      });
      return written(s, r);
    }),

  // ---------------- fx_*：engine/effects.ts 的 8 个既有特效 ----------------
  // 作用范围 = 整个图层（默认）或当前选区；一条历史（Session.maskOp 的结构快照）。
  tool("fx_outline", "描边", "draw",
    {
      width: { type: "int", min: 1, max: 16, default: 1, desc: "描边宽度（px）" },
      pos: { type: "enum", values: ["outside", "inside", "center"], default: "outside", desc: "画在轮廓外 / 内 / 内外各一半" },
      color: { type: "color", default: "fg", desc: "描边色" },
      ...FX_TARGET,
    },
    { ok: "true / false（图层锁定 / scope=selection 但没有选区）", changed: "被改动的像素矩形", data: "{ changed, pixels }", docRev: "文档版本号" },
    (a, ctx) => fxResult(ctx.session, "fx-outline",
      (d, w, h) => fxE.outlineCel(d, w, h, Number(a.width), rgbaOf(a.color, ctx.session), a.pos as fxE.OutlinePos), a)),

  tool("fx_inline", "内描边", "draw",
    {
      width: { type: "int", min: 1, max: 8, default: 1, desc: "往里画几圈（最外圈原色保留）" },
      alpha: { type: "int", min: 0, max: 100, default: 100, desc: "与底下像素的混合比例（%），100 = 完全覆盖" },
      color: { type: "color", default: "fg", desc: "内描边色" },
      ...FX_TARGET,
    },
    { ok: "true / false（图层锁定 / 没有选区 / 没有透明背景）", changed: "被改动的像素矩形", data: "{ changed, pixels }", docRev: "文档版本号" },
    (a, ctx) => fxResult(ctx.session, "fx-inline",
      (d, w, h) => fxE.inlineCel(d, w, h, Number(a.width), rgbaOf(a.color, ctx.session), Math.round(Number(a.alpha) * 2.55)), a)),

  tool("fx_shadow", "投影", "draw",
    {
      dx: { type: "int", min: -64, max: 64, default: 3, desc: "水平偏移（px，正数向右）" },
      dy: { type: "int", min: -64, max: 64, default: 3, desc: "垂直偏移（px，正数向下）" },
      color: { type: "color", default: "#000000", desc: "影子颜色" },
      alpha: { type: "int", min: 0, max: 100, default: 59, desc: "影子不透明度（%）" },
      ...FX_TARGET,
    },
    { ok: "true / false（图层锁定 / 没有选区）", changed: "被改动的像素矩形", data: "{ changed, pixels }", docRev: "文档版本号" },
    (a, ctx) => fxResult(ctx.session, "fx-shadow", (d, w, h) => {
      const c = rgbaOf(a.color, ctx.session);
      fxE.dropShadowCel(d, w, h, Number(a.dx), Number(a.dy), [c[0], c[1], c[2], Math.round((Number(a.alpha) / 100) * 255)], true);
    }, a)),

  tool("fx_glow", "外发光", "draw",
    {
      radius: { type: "int", min: 1, max: 16, default: 2, desc: "向外发光几圈（每圈更淡）" },
      color: { type: "color", default: "fg", desc: "发光颜色" },
      ...FX_TARGET,
    },
    { ok: "true / false（图层锁定 / 没有选区）", changed: "被改动的像素矩形", data: "{ changed, pixels }", docRev: "文档版本号" },
    (a, ctx) => fxResult(ctx.session, "fx-glow", (d, w, h) => {
      const c = rgbaOf(a.color, ctx.session);
      fxE.outerGlowCel(d, w, h, Number(a.radius), [c[0], c[1], c[2], c[3] > 0 ? c[3] : 255]);
    }, a)),

  tool("fx_invert", "反色", "draw",
    { ...FX_TARGET },
    { ok: "true / false（图层锁定 / 没有选区）", changed: "被改动的像素矩形", data: "{ changed, pixels }", docRev: "文档版本号" },
    (a, ctx) => fxResult(ctx.session, "fx-invert", (d) => fxE.invertCel(d), a)),

  tool("fx_gray", "灰度", "draw",
    { ...FX_TARGET },
    { ok: "true / false（图层锁定 / 没有选区）", changed: "被改动的像素矩形", data: "{ changed, pixels }", docRev: "文档版本号" },
    (a, ctx) => fxResult(ctx.session, "fx-gray", (d) => fxE.desaturateCel(d), a)),

  tool("fx_round", "圆角化", "draw",
    {
      radius: { type: "int", min: 1, max: 8, default: 2, desc: "削几层（1..8）" },
      mode: { type: "enum", values: ["outer", "both"], default: "outer", desc: "outer = 只削外直角；both = 连内凹角与 1px 洞一起补" },
      ...FX_TARGET,
    },
    { ok: "true / false（图层锁定 / 没有选区）", changed: "被改动的像素矩形", data: "{ changed, pixels }", docRev: "文档版本号" },
    (a, ctx) => fxResult(ctx.session, "fx-round",
      (d, w, h) => fxE.roundCornersCel(d, w, h, Number(a.radius), a.mode as fxE.RoundMode), a)),

  tool("fx_blur", "模糊", "draw",
    {
      radius: { type: "int", min: 1, max: 32, default: 2, desc: "模糊半径（px；两遍盒式模糊，近似高斯）" },
      ...FX_TARGET,
    },
    { ok: "true / false（图层锁定 / 没有选区）", changed: "被改动的像素矩形", data: "{ changed, pixels }", docRev: "文档版本号" },
    (a, ctx) => fxResult(ctx.session, "fx-blur", (d, w, h) => fxE.blurCel(d, w, h, Number(a.radius)), a)),

  tool("undo", "撤销", "draw", {},
    { ok: "是否执行了撤销（没有可撤销的步骤时为 false）", docRev: "撤销后的文档版本号" },
    (_a, ctx) => {
      const s = ctx.session;
      const can = s.snapshot().canUndo;
      s.undo();
      return can ? done(s) : { ok: false, error: "没有可撤销的步骤", docRev: s.doc.pixelRev };
    }),

  tool("redo", "重做", "draw", {},
    { ok: "是否执行了重做（没有可重做的步骤时为 false）", docRev: "重做后的文档版本号" },
    (_a, ctx) => {
      const s = ctx.session;
      const can = s.snapshot().canRedo;
      s.redo();
      return can ? done(s) : { ok: false, error: "没有可重做的步骤", docRev: s.doc.pixelRev };
    }),

  tool("palette_add", "调色板加一色", "draw",
    { color: { type: "color", desc: "#rrggbb / #rrggbbaa / fg / bg" } },
    { ok: "true", data: "{ index, size }：新色下标与调色板长度", docRev: "文档版本号" },
    (a, ctx) => {
      const s = ctx.session;
      s.paletteAdd(rgbaOf(a.color, s));
      return done(s, { index: s.doc.palette.length - 1, size: s.doc.palette.length });
    }),

  tool("palette_remove", "调色板删一色", "draw",
    { index: { type: "int", min: 0, desc: "色卡下标" } },
    { ok: "true / false（下标不存在）", data: "{ removed, size }", docRev: "文档版本号" },
    (a, ctx) => {
      const s = ctx.session;
      const i = Number(a.index);
      if (!s.doc.palette[i]) return { ok: false, error: "调色板下标 " + i + " 不存在", docRev: s.doc.pixelRev };
      s.paletteRemove(i);
      return done(s, { removed: i, size: s.doc.palette.length });
    }),

  tool("palette_dedupe", "调色板去重", "draw", {},
    { ok: "true", data: "{ removed }：删掉的重复色数", docRev: "文档版本号" },
    (_a, ctx) => {
      const s = ctx.session;
      return done(s, { removed: s.paletteDedupe() });
    }),

  tool("palette_merge", "合并颜色进调色板", "draw",
    { colors: { type: "array", items: "color", min: 1, max: 64, desc: "要加进去的颜色（已存在的会跳过）" } },
    { ok: "true", data: "{ added }：真的加进去的数量", docRev: "文档版本号" },
    (a, ctx) => {
      const s = ctx.session;
      const list = (a.colors as string[]).map((c) => rgbaOf(c, s));
      return done(s, { added: s.paletteMerge(list) });
    }),

  tool("palette_sort", "调色板排序", "draw",
    { mode: { type: "enum", values: ["hue", "light"], default: "hue" } },
    { ok: "true", docRev: "文档版本号" },
    (a, ctx) => {
      const s = ctx.session;
      s.paletteSort(a.mode as "hue" | "light");
      return done(s, { mode: a.mode });
    }),

  tool("palette_from_canvas", "由画布生成调色板", "draw",
    { max: { type: "int", min: 2, max: 256, default: 256, desc: "最多取多少色（按使用次数）" } },
    { ok: "true / false（画布上没有任何颜色）", data: "{ count }", docRev: "文档版本号" },
    (a, ctx) => {
      const s = ctx.session;
      const n = s.paletteFromCanvas(Number(a.max));
      return n > 0 ? done(s, { count: n }) : { ok: false, error: "画布上没有任何颜色", docRev: s.doc.pixelRev };
    }),

  tool("palette_remap", "把像素映射到调色板", "draw",
    { scope: { type: "enum", values: ["canvas", "layer"], default: "canvas" } },
    { ok: "true", data: "{ changed }：被改动的像素数", docRev: "文档版本号" },
    (a, ctx) => {
      const s = ctx.session;
      return done(s, { changed: s.remapToPalette(a.scope as "canvas" | "layer") });
    }),

  tool("color_replace", "替换颜色", "draw",
    {
      from: { type: "color", desc: "被替换的颜色" },
      to: { type: "color", desc: "替换成的颜色" },
      scope: { type: "enum", values: ["canvas", "layer", "selection", "allFrames"], default: "canvas" },
      tolerance: { type: "int", min: 0, max: 255, default: 0 },
      opaqueOnly: { type: "bool", default: true, desc: "只改不透明像素" },
      keepAlpha: { type: "bool", default: true, desc: "保留各自 alpha" },
    },
    { ok: "true", data: "{ changed }：被改动的像素数", docRev: "文档版本号" },
    (a, ctx) => {
      const s = ctx.session;
      const n = s.replaceColour(rgbaOf(a.from, s), rgbaOf(a.to, s), {
        scope: a.scope as "canvas" | "layer" | "selection" | "allFrames",
        tolerance: Number(a.tolerance), opaqueOnly: a.opaqueOnly === true, keepAlpha: a.keepAlpha === true,
      });
      return done(s, { changed: n });
    }),

  tool("color_select", "按颜色建选区", "draw",
    {
      color: { type: "color", desc: "要选中的颜色" },
      tolerance: { type: "int", min: 0, max: 255, default: 0 },
      scope: { type: "enum", values: ["layer", "canvas", "allFrames"], default: "layer" },
    },
    { ok: "true", data: "{ pixels }：选中的像素数（0 = 没命中，选区被清空）", docRev: "文档版本号" },
    (a, ctx) => {
      const s = ctx.session;
      return done(s, { pixels: s.selectColourPixels(rgbaOf(a.color, s), Number(a.tolerance), a.scope as "layer" | "canvas" | "allFrames") });
    }),

  tool("color_merge_group", "合并一组近似色", "draw",
    {
      rep: { type: "color", desc: "代表色（留下的那个）" },
      colors: { type: "array", items: "color", min: 1, max: 64, desc: "要并进代表色的颜色" },
      scope: { type: "enum", values: ["canvas", "layer", "selection", "allFrames"], default: "canvas" },
    },
    { ok: "true", data: "{ changed }：被改动的像素数", docRev: "文档版本号" },
    (a, ctx) => {
      const s = ctx.session;
      const rep = rgbaOf(a.rep, s);
      const list = (a.colors as string[]).map((c) => rgbaOf(c, s));
      return done(s, { changed: s.mergeColourGroup(rep, list, a.scope as "canvas" | "layer" | "selection" | "allFrames") });
    }),

  tool("layer_add", "新建图层", "draw", {},
    { ok: "true", data: "{ layers }", docRev: "文档版本号" },
    (_a, ctx) => {
      const s = ctx.session;
      s.layerAdd();
      return done(s, { layers: s.doc.layers.length });
    }),

  tool("layer_duplicate", "复制当前图层", "draw", {},
    { ok: "true", data: "{ layers }", docRev: "文档版本号" },
    (_a, ctx) => {
      const s = ctx.session;
      s.layerDuplicate();
      return done(s, { layers: s.doc.layers.length });
    }),

  tool("layer_up", "当前图层上移一层", "draw", {},
    { ok: "true / false（已经在最上面）", docRev: "文档版本号" },
    (_a, ctx) => {
      const s = ctx.session;
      const li = s.curLayer();
      if (li <= 0) return { ok: false, error: "当前图层已经在最上面", docRev: s.doc.pixelRev };
      s.layerUp();
      return done(s);
    }),

  tool("layer_down", "当前图层下移一层", "draw", {},
    { ok: "true / false（已经在最下面）", docRev: "文档版本号" },
    (_a, ctx) => {
      const s = ctx.session;
      const li = s.curLayer();
      if (li >= s.doc.layers.length - 1) return { ok: false, error: "当前图层已经在最下面", docRev: s.doc.pixelRev };
      s.layerDown();
      return done(s);
    }),

  tool("layer_move_to", "把图层移到指定下标", "draw",
    {
      from: { type: "int", min: 0 },
      to: { type: "int", min: 0 },
    },
    { ok: "true / false（下标不存在或没动）", docRev: "文档版本号" },
    (a, ctx) => {
      const s = ctx.session;
      const from = Number(a.from), to = Number(a.to);
      if (!s.doc.layers[from]) return { ok: false, error: "图层下标 " + from + " 不存在", docRev: s.doc.pixelRev };
      if (from === to) return done(s, { moved: false });
      s.layerMoveTo(from, to);
      return done(s, { moved: true });
    }),

  tool("layer_toggle_visible", "切换图层可见", "draw",
    { li: { type: "int", min: 0, default: AI_ARG_CURRENT, desc: "图层号，省略 = 当前图层" } },
    { ok: "true / false（图层不存在）", data: "{ li, visible }", docRev: "文档版本号" },
    (a, ctx) => {
      const s = ctx.session;
      const li = at(a.li, s.curLayer());
      const L = s.doc.layers[li];
      if (!L) return { ok: false, error: "图层下标 " + li + " 不存在", docRev: s.doc.pixelRev };
      s.toggleLayerVisible(li);
      return done(s, { li, visible: s.doc.layers[li].visible });
    }),

  tool("layer_toggle_lock", "切换图层锁定", "draw",
    { li: { type: "int", min: 0, default: AI_ARG_CURRENT, desc: "图层号，省略 = 当前图层" } },
    { ok: "true / false（图层不存在）", data: "{ li, locked }", docRev: "文档版本号" },
    (a, ctx) => {
      const s = ctx.session;
      const li = at(a.li, s.curLayer());
      const L = s.doc.layers[li];
      if (!L) return { ok: false, error: "图层下标 " + li + " 不存在", docRev: s.doc.pixelRev };
      s.toggleLayerLock(li);
      return done(s, { li, locked: s.doc.layers[li].locked });
    }),

  tool("layer_toggle_solo", "只看这个图层（再切一次恢复）", "draw",
    { li: { type: "int", min: 0, default: AI_ARG_CURRENT, desc: "图层号，省略 = 当前图层" } },
    { ok: "true / false（图层不存在）", data: "{ li, visible[] }", docRev: "文档版本号" },
    (a, ctx) => {
      const s = ctx.session;
      const li = at(a.li, s.curLayer());
      if (!s.doc.layers[li]) return { ok: false, error: "图层下标 " + li + " 不存在", docRev: s.doc.pixelRev };
      s.toggleSoloLayers(li);
      return done(s, { li, visible: s.doc.layers.map((l) => l.visible) });
    }),

  tool("layer_rename", "重命名图层", "draw",
    {
      li: { type: "int", min: 0, default: AI_ARG_CURRENT, desc: "图层号，省略 = 当前图层" },
      name: { type: "string", min: 1, max: 64 },
    },
    { ok: "true / false（图层不存在或名字没变）", docRev: "文档版本号" },
    (a, ctx) => {
      const s = ctx.session;
      const li = at(a.li, s.curLayer());
      const L = s.doc.layers[li];
      if (!L) return { ok: false, error: "图层下标 " + li + " 不存在", docRev: s.doc.pixelRev };
      const name = String(a.name).trim();
      if (!name || name === L.name) return done(s, { renamed: false });
      s.renameLayer(li, name);
      return done(s, { renamed: true, name });
    }),

  tool("layer_opacity", "设置图层不透明度", "draw",
    {
      li: { type: "int", min: 0, default: AI_ARG_CURRENT, desc: "图层号，省略 = 当前图层" },
      opacity: { type: "int", min: 0, max: 100 },
    },
    { ok: "true / false（图层不存在）", docRev: "文档版本号" },
    (a, ctx) => {
      const s = ctx.session;
      const li = at(a.li, s.curLayer());
      if (!s.doc.layers[li]) return { ok: false, error: "图层下标 " + li + " 不存在", docRev: s.doc.pixelRev };
      s.setLayerOpacity(li, Number(a.opacity));
      return done(s, { li, opacity: s.doc.layers[li].opacity });
    }),

  tool("layer_blend", "设置图层混合模式", "draw",
    {
      li: { type: "int", min: 0, default: AI_ARG_CURRENT, desc: "图层号，省略 = 当前图层" },
      blend: { type: "enum", values: BLEND_MODES.slice() },
    },
    { ok: "true / false（图层不存在）", docRev: "文档版本号" },
    (a, ctx) => {
      const s = ctx.session;
      const li = at(a.li, s.curLayer());
      if (!s.doc.layers[li]) return { ok: false, error: "图层下标 " + li + " 不存在", docRev: s.doc.pixelRev };
      s.setLayerBlend(li, a.blend as (typeof BLEND_MODES)[number]);
      return done(s, { li, blend: s.doc.layers[li].blend });
    }),

  tool("layer_select", "切换当前图层（后续写操作的目标）", "draw",
    { li: { type: "int", min: 0 } },
    { ok: "true / false（图层不存在）", data: "{ li }", docRev: "文档版本号" },
    (a, ctx) => {
      const s = ctx.session;
      const li = Number(a.li);
      if (!s.doc.layers[li]) return { ok: false, error: "图层下标 " + li + " 不存在", docRev: s.doc.pixelRev };
      s.setLayer(li);
      return done(s, { li: s.curLayer() });
    }),

  tool("frame_add", "新建帧", "draw", {},
    { ok: "true / false（已经是最后一帧且无法新增）", data: "{ frames }", docRev: "文档版本号" },
    (_a, ctx) => {
      const s = ctx.session;
      const before = s.doc.frames.length;
      s.frameAdd();
      return done(s, { frames: s.doc.frames.length, added: s.doc.frames.length - before });
    }),

  tool("frame_duplicate", "复制当前帧", "draw", {},
    { ok: "true", data: "{ frames }", docRev: "文档版本号" },
    (_a, ctx) => {
      const s = ctx.session;
      s.frameDuplicate();
      return done(s, { frames: s.doc.frames.length });
    }),

  tool("frame_move", "当前帧前后移动一位", "draw",
    { direction: { type: "enum", values: ["prev", "next"], default: "next" } },
    { ok: "true / false（已经到头了）", docRev: "文档版本号" },
    (a, ctx) => {
      const s = ctx.session;
      const cur = s.curFrame();
      const dir: -1 | 1 = a.direction === "prev" ? -1 : 1;
      if (cur + dir < 0 || cur + dir >= s.doc.frames.length) return { ok: false, error: "帧已经到头了", docRev: s.doc.pixelRev };
      s.frameMove(dir);
      return done(s, { frames: s.doc.frames.length });
    }),

  tool("frame_move_to", "把帧移到指定下标", "draw",
    { from: { type: "int", min: 0 }, to: { type: "int", min: 0 } },
    { ok: "true / false（下标不存在）", docRev: "文档版本号" },
    (a, ctx) => {
      const s = ctx.session;
      const from = Number(a.from), to = Number(a.to);
      if (from >= s.doc.frames.length) return { ok: false, error: "帧下标 " + from + " 不存在", docRev: s.doc.pixelRev };
      if (from === to) return done(s, { moved: false });
      s.frameMoveTo(from, to);
      return done(s, { moved: true });
    }),

  tool("frame_duration", "设置帧时长", "draw",
    {
      fi: { type: "int", min: 0, default: AI_ARG_CURRENT, desc: "帧号，省略 = 当前帧" },
      ms: { type: "int", min: 1, max: 60000 },
    },
    { ok: "true / false（帧不存在）", data: "{ fi, ms }", docRev: "文档版本号" },
    (a, ctx) => {
      const s = ctx.session;
      const fi = at(a.fi, s.curFrame());
      if (!s.doc.frames[fi]) return { ok: false, error: "帧下标 " + fi + " 不存在", docRev: s.doc.pixelRev };
      s.setFrameDuration(fi, Number(a.ms));
      return done(s, { fi, ms: s.doc.frames[fi].durationMs });
    }),

  tool("frame_select", "切换当前帧（后续写操作的目标）", "draw",
    { fi: { type: "int", min: 0 } },
    { ok: "true / false（帧不存在）", data: "{ fi }", docRev: "文档版本号" },
    (a, ctx) => {
      const s = ctx.session;
      const fi = Number(a.fi);
      if (!s.doc.frames[fi]) return { ok: false, error: "帧下标 " + fi + " 不存在", docRev: s.doc.pixelRev };
      // record=false：切帧是导航，不该占用户一条历史（UI 的手动切帧才记）
      s.setFrame(fi, false);
      return done(s, { fi: s.curFrame() });
    }),

  tool("tag_add", "新建动画标签", "draw",
    {
      name: { type: "string", min: 1, max: 64 },
      from: { type: "int", min: 0 },
      to: { type: "int", min: 0 },
    },
    { ok: "true / false（范围非法）", data: "{ id, name, from, to }", docRev: "文档版本号" },
    (a, ctx) => {
      const s = ctx.session;
      const t = s.tagAdd(String(a.name), Number(a.from), Number(a.to));
      if (!t) return { ok: false, error: "标签范围非法（from/to 必须在帧范围内）", docRev: s.doc.pixelRev };
      return done(s, { id: t.id, name: t.name, from: t.from, to: t.to });
    }),

  tool("tag_rename", "重命名动画标签", "draw",
    { id: { type: "string", min: 1, max: 64 }, name: { type: "string", min: 1, max: 64 } },
    { ok: "true / false（标签不存在或名字没变）", docRev: "文档版本号" },
    (a, ctx) => {
      const s = ctx.session;
      const id = String(a.id);
      if (!s.tagById(id)) return { ok: false, error: "标签 " + id + " 不存在", docRev: s.doc.pixelRev };
      s.tagRename(id, String(a.name));
      const t = s.tagById(id);
      return done(s, { name: t ? t.name : null });
    }),

  tool("tag_set_range", "改动画标签的帧范围", "draw",
    { id: { type: "string", min: 1, max: 64 }, from: { type: "int", min: 0 }, to: { type: "int", min: 0 } },
    { ok: "true / false（标签不存在或范围非法）", data: "{ from, to }", docRev: "文档版本号" },
    (a, ctx) => {
      const s = ctx.session;
      const id = String(a.id);
      if (!s.tagById(id)) return { ok: false, error: "标签 " + id + " 不存在", docRev: s.doc.pixelRev };
      s.tagSetRange(id, Number(a.from), Number(a.to));
      const t = s.tagById(id);
      return t ? done(s, { from: t.from, to: t.to }) : { ok: false, error: "范围非法", docRev: s.doc.pixelRev };
    }),

  tool("tag_set_color", "改动画标签的颜色", "draw",
    { id: { type: "string", min: 1, max: 64 }, color: { type: "color", desc: "#rrggbb / #rrggbbaa / fg / bg" } },
    { ok: "true / false（标签不存在）", data: "{ color }", docRev: "文档版本号" },
    (a, ctx) => {
      const s = ctx.session;
      const id = String(a.id);
      if (!s.tagById(id)) return { ok: false, error: "标签 " + id + " 不存在", docRev: s.doc.pixelRev };
      // 标签颜色是 CSS 色串，fg/bg 先解析成 #rrggbb（否则会把 "fg" 原样存进去）
      s.tagSetColor(id, rgbaToHex(rgbaOf(a.color, s)));
      const t = s.tagById(id);
      return done(s, { color: t ? t.color : null });
    }),

  tool("tag_remove", "删除动画标签", "draw",
    { id: { type: "string", min: 1, max: 64 } },
    { ok: "true / false（标签不存在）", docRev: "文档版本号" },
    (a, ctx) => {
      const s = ctx.session;
      const okDel = s.tagRemove(String(a.id));
      return okDel ? done(s) : { ok: false, error: "标签 " + String(a.id) + " 不存在", docRev: s.doc.pixelRev };
    }),

  tool("iso_set", "设置等距图形参数", "draw",
    {
      // 全部可选（补丁语义）：只改传了的字段，没传的保持当前设置
      shape: { type: "enum", values: ISO_SHAPES.slice(), optional: true },
      w: { type: "int", min: 1, max: 64, optional: true, desc: "足迹宽（格）" },
      d: { type: "int", min: 1, max: 64, optional: true, desc: "足迹深（格）" },
      h: { type: "int", min: 1, max: 64, optional: true, desc: "高度（层）" },
      steps: { type: "int", min: 2, max: 64, optional: true },
      axis: { type: "enum", values: ["x", "y"], optional: true },
      dir: { type: "enum", values: ["1", "-1"], optional: true, desc: "1 = 正向递增，-1 = 反向" },
      radius: { type: "int", min: 1, max: 32, optional: true },
      hollow: { type: "bool", optional: true },
      topW: { type: "int", min: 0, max: 64, optional: true },
      topD: { type: "int", min: 0, max: 64, optional: true },
      thickness: { type: "int", min: 1, max: 32, optional: true },
      tile: { type: "enum", values: ISO_TILES.map((n) => String(n)), optional: true, desc: "每格像素宽（2:1 栅格）" },
      colorMode: { type: "enum", values: ["mono", "fg", "custom"], optional: true },
      faceTop: { type: "color", optional: true },
      faceRight: { type: "color", optional: true },
      faceLeft: { type: "color", optional: true },
      intensity: { type: "int", min: 0, max: 100, optional: true },
      peak: { type: "int", min: 0, max: 100, optional: true },
      sway: { type: "int", min: 0, max: 100, optional: true },
      shadow: { type: "enum", values: ["off", "contact"], optional: true },
      outline: { type: "bool", optional: true },
      layerName: { type: "string", min: 1, max: 64, optional: true, desc: "「生成到新图层」用的名字" },
    },
    { ok: "true", data: "{ shape, w, d, h, tile }：生效后的取值", docRev: "文档版本号" },
    (a, ctx) => {
      const s = ctx.session;
      const patch: Partial<IsoPrefs> = {};
      if (a.shape !== undefined) patch.shape = a.shape as IsoShapeId;
      if (a.w !== undefined) patch.w = Number(a.w);
      if (a.d !== undefined) patch.d = Number(a.d);
      if (a.h !== undefined) patch.h = Number(a.h);
      if (a.steps !== undefined) patch.steps = Number(a.steps);
      if (a.axis !== undefined) patch.axis = a.axis as "x" | "y";
      if (a.dir !== undefined) patch.dir = Number(a.dir) === -1 ? -1 : 1;
      if (a.radius !== undefined) patch.radius = Number(a.radius);
      if (a.hollow !== undefined) patch.hollow = a.hollow === true;
      if (a.topW !== undefined) patch.topW = Number(a.topW);
      if (a.topD !== undefined) patch.topD = Number(a.topD);
      if (a.thickness !== undefined) patch.thickness = Number(a.thickness);
      if (a.tile !== undefined) patch.tile = Number(a.tile) as IsoTile;
      if (a.colorMode !== undefined) patch.colorMode = a.colorMode as "mono" | "fg" | "custom";
      if (a.faceTop !== undefined) patch.faceTop = rgbaToHex(rgbaOf(a.faceTop, s));
      if (a.faceRight !== undefined) patch.faceRight = rgbaToHex(rgbaOf(a.faceRight, s));
      if (a.faceLeft !== undefined) patch.faceLeft = rgbaToHex(rgbaOf(a.faceLeft, s));
      if (a.intensity !== undefined) patch.intensity = Number(a.intensity);
      if (a.peak !== undefined) patch.peak = Number(a.peak);
      if (a.sway !== undefined) patch.sway = Number(a.sway);
      if (a.shadow !== undefined) patch.shadow = a.shadow as "off" | "contact";
      if (a.outline !== undefined) patch.outline = a.outline === true;
      if (a.layerName !== undefined) patch.layerName = String(a.layerName);
      s.setIsoPref(patch);
      const cur = s.isoShape();
      return done(s, { shape: cur.shape, w: cur.w, d: cur.d, h: cur.h, tile: s.isoLook().tile });
    }),

  tool("iso_origin", "设置等距图形落点", "draw",
    {
      at: { type: "xy", desc: "[x,y]：格 (0,0) 顶面顶点在画布上的像素位置" },
      snap: { type: "bool", default: true, desc: "吸附到 2:1 栅格" },
    },
    { ok: "true", data: "{ x, y }", docRev: "文档版本号" },
    (a, ctx) => {
      const s = ctx.session;
      const p = a.at as number[];
      s.setIsoOrigin(p[0], p[1], a.snap !== false);
      return done(s, { x: s.isoOrigin ? s.isoOrigin.x : p[0], y: s.isoOrigin ? s.isoOrigin.y : p[1] });
    }),

  tool("iso_generate", "生成等距图形", "draw",
    { target: { type: "enum", values: ["layer", "new"], default: "layer", desc: "new = 先新建一个图层（合成一条历史）" } },
    {
      ok: "true / false（画布外 / 参数为空）",
      changed: "生成物落进画布的矩形",
      data: "{ w, h, voxels, pixels, clipped, reason? }",
      docRev: "文档版本号",
    },
    (a, ctx) => {
      const s = ctx.session;
      const r = s.isoGenerate(a.target as "layer" | "new");
      const out: AiToolResult = { ok: r.ok, docRev: s.doc.pixelRev, data: r };
      if (r.ok && s.isoLast) out.changed = { ...s.isoLast };
      if (!r.ok) {
        const why = r.reason === "locked" ? "图层被锁定" : r.reason === "outside" ? "完全在画布外" : r.reason === "empty" ? "参数为空" : String(r.reason);
        out.error = "生成失败：" + why;
      }
      return out;
    }),

  // ---------------- destructive：每次确认 ----------------
  // `erase` 与 `transform` 归这一档：它们**删掉 / 移走**已有像素（擦除会把一块内容清成透明，
  // 变换可能把像素推出画布、缩放 / 旋转还会重采样）—— 与既有的 `scale`（改画布尺寸 / 重采样）
  // 同一类。写得再多也只是覆盖像素的 `fill` / `color_replace` / `fx_*` 仍然留在 draw 档。
  tool("erase", "擦除一块区域", "destructive",
    {
      rect: { type: "rect", desc: "要擦掉的区域 {x,y,w,h}（画布坐标；w / h 必须 ≥1）" },
      shape: { type: "enum", values: ["rect", "ellipse"], default: "rect", desc: "擦除区域的外形（ellipse = 内切椭圆）" },
      fill: { type: "bool", default: true, desc: "true = 整块擦掉；false = 只擦 1px 轮廓" },
      sym: { type: "enum", values: AI_SYMS.slice(), default: "off", desc: "对称（同 draw_path）" },
      layer: { type: "int", min: 0, default: AI_ARG_CURRENT, desc: "图层号，省略 = 当前图层" },
      frame: { type: "int", min: 0, default: AI_ARG_CURRENT, desc: "帧号，省略 = 当前帧" },
    },
    { ok: "true / false（w / h 为 0 / 图层锁定 / 下标不存在）", changed: "擦到的像素并集矩形",
      data: "{ changed }（有选区时只擦选区内的部分，与橡皮工具一致）", docRev: "文档版本号" },
    (a, ctx) => {
      const s = ctx.session;
      const rc = rectOf(a.rect);
      if (rc.w < 1 || rc.h < 1) {
        return { ok: false, error: "rect 的 w / h 必须 ≥1（允许 1..画布尺寸；收到 w=" + rc.w + ", h=" + rc.h + "）", docRev: s.doc.pixelRev };
      }
      const r = runStroke(s, {
        kind: a.shape as AiStrokeKind, li: at(a.layer, s.curLayer()), fi: at(a.frame, s.curFrame()),
        size: 1, color: [0, 0, 0, 0], sym: a.sym as AiSymName, shapeFill: a.fill !== false,
        points: [[rc.x, rc.y], [rc.x + rc.w - 1, rc.y + rc.h - 1]], label: "erase",
      });
      return written(s, r);
    }),

  tool("transform", "变换图层或选区", "destructive",
    {
      mode: { type: "enum", values: AI_XFORM_MODES.slice(), desc: "move（平移）/ scale（缩放，可镜像）/ rotate（旋转）" },
      scope: { type: "enum", values: AI_XFORM_SCOPES.slice(), default: "selection",
        desc: "selection = 只变换选区里的内容（需要先建立选区）；layer = 变换整个图层（无视选区，作用范围＝整幅画布）" },
      dx: { type: "int", min: -4096, max: 4096, default: 0, desc: "mode=move：水平位移（整格，正数向右）" },
      dy: { type: "int", min: -4096, max: 4096, default: 0, desc: "mode=move：垂直位移（整格，正数向下）" },
      sx: { type: "num", min: -40, max: 40, default: 1, desc: "mode=scale：横向倍率，0.02..40（负值＝镜像翻转）" },
      sy: { type: "num", min: -40, max: 40, default: 1, desc: "mode=scale：纵向倍率，0.02..40（负值＝镜像翻转）" },
      angle: { type: "num", min: -360, max: 360, default: 0, desc: "mode=rotate：旋转角度（度，正数＝顺时针）" },
      snap: { type: "bool", default: false, desc: "mode=rotate：把角度吸到像素画的干净角（26.565° 那一族，与 UI 的角度吸附同一张表）" },
      pivot: { type: "enum", values: AI_PIVOTS.slice(), default: "cc", desc: "枢轴（缩放 / 旋转的不动点）：tl / tc / tr / cl / cc / cr / bl / bc / br，cc = 正中" },
      layer: { type: "int", min: 0, default: AI_ARG_CURRENT, desc: "图层号，省略 = 当前图层" },
      frame: { type: "int", min: 0, default: AI_ARG_CURRENT, desc: "帧号，省略 = 当前帧" },
    },
    { ok: "true / false（参数与 mode 矛盾 / 没有选区 / 图层锁定 / 空图层）", changed: "落进画布的像素并集矩形",
      data: "{ changed, pixels }（内容被推出画布的部分不会写进来）", docRev: "文档版本号" },
    (a, ctx) => {
      const s = ctx.session;
      const mode = a.mode as AiXformMode;
      const dx = Number(a.dx), dy = Number(a.dy), sx = Number(a.sx), sy = Number(a.sy);
      const angle = Number(a.angle), snap = a.snap === true;
      const pivot = String(a.pivot);
      // 与 mode 无关的参数**拒绝**（不静默忽略）：模型按别的 mode 填的一组参数会得到一个
      // 「看起来成功、其实没动」的结果，比报错难查得多。
      if (mode === "move" && (sx !== 1 || sy !== 1 || angle !== 0 || snap || pivot !== "cc")) {
        return { ok: false, error: "mode=move 只接受 dx / dy；sx / sy / angle / snap / pivot 属于 scale / rotate（当前 sx=" + sx + ", sy=" + sy + ", angle=" + angle + ", snap=" + snap + ", pivot=" + pivot + "）", docRev: s.doc.pixelRev };
      }
      if (mode === "scale") {
        if (dx !== 0 || dy !== 0 || angle !== 0 || snap) {
          return { ok: false, error: "mode=scale 只接受 sx / sy / pivot；dx / dy / angle / snap 属于 move / rotate（当前 dx=" + dx + ", dy=" + dy + ", angle=" + angle + ", snap=" + snap + "）", docRev: s.doc.pixelRev };
        }
        for (const v of [sx, sy]) {
          const mag = Math.abs(v), okMag = mag >= AI_SCALE_MIN && mag <= AI_SCALE_MAX;
          if (!Number.isFinite(v) || v === 0 || !okMag) {
            return { ok: false, error: "缩放倍率的绝对值允许 " + AI_SCALE_MIN + ".." + AI_SCALE_MAX + "（负值＝镜像；不做静默钳制，请自己收进范围；收到 " + v + "）", docRev: s.doc.pixelRev };
          }
        }
      }
      if (mode === "rotate" && (dx !== 0 || dy !== 0 || sx !== 1 || sy !== 1)) {
        return { ok: false, error: "mode=rotate 只接受 angle / snap / pivot；dx / dy / sx / sy 属于 move / scale（当前 dx=" + dx + ", dy=" + dy + ", sx=" + sx + ", sy=" + sy + "）", docRev: s.doc.pixelRev };
      }
      const r = runTransform(s, {
        li: at(a.layer, s.curLayer()), fi: at(a.frame, s.curFrame()),
        mode, scope: a.scope as AiXformScope, dx, dy, sx, sy, angle, snap, pivot: pivot as PivotPreset,
      });
      return written(s, r, { pixels: r.pixels });
    }),

  tool("layer_delete", "删除当前图层", "destructive", {},
    { ok: "true / false（只剩一个图层）", data: "{ layers }", docRev: "文档版本号" },
    (_a, ctx) => {
      const s = ctx.session;
      if (s.doc.layers.length <= 1) return { ok: false, error: "只剩一个图层，不能删", docRev: s.doc.pixelRev };
      s.layerDelete();
      return done(s, { layers: s.doc.layers.length });
    }),

  tool("layer_merge_down", "与下一层合并", "destructive", {},
    { ok: "true / false（已经在最下面）", data: "{ layers }", docRev: "文档版本号" },
    (_a, ctx) => {
      const s = ctx.session;
      if (s.curLayer() <= 0) return { ok: false, error: "当前图层已经在最下面，没有可合并的下一层", docRev: s.doc.pixelRev };
      s.layerMergeDown();
      return done(s, { layers: s.doc.layers.length });
    }),

  tool("frame_delete", "删除当前帧", "destructive", {},
    { ok: "true / false（只剩一帧）", data: "{ frames }", docRev: "文档版本号" },
    (_a, ctx) => {
      const s = ctx.session;
      if (s.doc.frames.length <= 1) return { ok: false, error: "只剩一帧，不能删", docRev: s.doc.pixelRev };
      s.frameDelete();
      return done(s, { frames: s.doc.frames.length });
    }),

  tool("canvas_clear", "清空画布（当前帧的所有图层）", "destructive", {},
    { ok: "true", data: "{ cleared }：被清掉的像素数", docRev: "文档版本号" },
    (_a, ctx) => {
      const s = ctx.session;
      let cleared = 0;
      for (const cel of s.doc.cels.values()) for (let i = 3; i < cel.data.length; i += 4) if (cel.data[i] > 0) cleared++;
      s.clearCanvas();
      return done(s, { cleared });
    }),

  tool("scale", "高级缩放（改画布尺寸 / 重采样）", "destructive",
    {
      w: { type: "int", min: 1, max: 1024 },
      h: { type: "int", min: 1, max: 1024 },
      algo: { type: "enum", values: SCALE_ALGOS.map((m) => m.id) , default: "nearest" },
      scope: { type: "enum", values: ["sprite", "layer", "selection"], default: "sprite", desc: "只有 sprite 会改画布尺寸" },
      cleanTransparent: { type: "bool", default: false, desc: "清掉透明像素的 RGB" },
    },
    { ok: "是否真的执行了缩放", changed: "缩放后画布尺寸", docRev: "文档版本号" },
    (a, ctx) => {
      const s = ctx.session;
      const r = s.scaleAdvanced({
        w: Number(a.w), h: Number(a.h),
        algo: a.algo as "nearest" | "bilinear" | "bicubic" | "area" | "scale2x" | "scale3x",
        scope: a.scope as ScaleScope,
        cleanTransparent: a.cleanTransparent === true,
      });
      const out: AiToolResult = { ok: r, docRev: s.doc.pixelRev, changed: { x: 0, y: 0, w: s.doc.w, h: s.doc.h }, data: { w: s.doc.w, h: s.doc.h } };
      if (!r) out.error = "未执行：目标尺寸与源尺寸相同、选区为空或图层被锁定";
      return out;
    }),

  // ---------------- ui：默认不暴露（§3.6） ----------------
  tool("set_tool", "切换当前工具", "ui",
    { tool: { type: "enum", values: ALL_TOOL_IDS.slice() } },
    { ok: "true", data: "{ tool }", docRev: "文档版本号" },
    (a, ctx) => {
      const s = ctx.session;
      s.setTool(a.tool as ToolId);
      return done(s, { tool: a.tool });
    }),
];

const BY_ID: Record<string, AiTool> = {};
for (const t of TOOLS) BY_ID[t.id] = t;

// ------------------------------------------------------------------ 对外接口

/**
 * 稳定顺序：tier 分组（read → draw → destructive → ui），组内按 id 字典序。
 * `opts.tiers` 只筛掉不要的档；**默认不含 ui**（§3.6）。传入的档序不影响输出顺序（永远是规范顺序）。
 */
export function listTools(opts: { tiers?: AiTier[] } = {}): AiTool[] {
  const asked = opts.tiers;
  const want = AI_TIER_ORDER.filter((t) => (t === "ui" ? !!(asked && asked.indexOf("ui") >= 0) : !asked || asked.indexOf(t) >= 0));
  const out: AiTool[] = [];
  for (const tier of want) {
    const ids = TOOLS.filter((t) => t.tier === tier).map((t) => t.id).sort();
    for (const id of ids) out.push(BY_ID[id]);
  }
  return out;
}

export function getTool(id: string): AiTool | null {
  return Object.prototype.hasOwnProperty.call(BY_ID, id) ? BY_ID[id] : null;
}

/**
 * 固定顺序：① 校验参数（不合格直接返回，**不执行、不确认**）→
 * ② destructive 档先 await ctx.confirm，false → `{ok:false, error:"cancelled"}` →
 * ③ 执行 handler 并把结果原样返回（handler 抛异常也只转成 `{ok:false, error}`）。
 */
export async function callTool(id: string, args: unknown, ctx: AiToolCtx): Promise<AiToolResult> {
  const tool = getTool(id);
  if (!tool) return { ok: false, error: "unknown tool: " + id };

  const v = validateArgs(tool, args);
  if (v.ok === false) return { ok: false, error: "invalid args: " + v.reason };

  if (tool.tier === "destructive") {
    let yes = false;
    try {
      yes = await ctx.confirm({ tool: tool.id, tier: tool.tier, summary: summarizeToolCall(tool, v.value) });
    } catch (e) {
      return { ok: false, error: "confirm failed: " + (e instanceof Error ? e.message : String(e)) };
    }
    if (!yes) return { ok: false, error: "cancelled" };
  }

  let res: AiToolResult;
  try {
    res = await tool.handler(v.value, ctx);
  } catch (e) {
    return { ok: false, error: "handler failed: " + (e instanceof Error ? e.message : String(e)) };
  }
  // 回合开着才记一次：读类工具不改文档，不进回合计数（C2 的 previewTurn 靠它数改动）
  if (res && res.ok !== false && tool.tier !== "read" && ctx.turn && ctx.turn.isOpen()) ctx.turn.mark();
  return res;
}

/** 工具表里全部 id（两种归属拼起来；测试用它断言与白名单相等） */
export function allToolIds(): string[] {
  return TOOLS.map((t) => t.id).slice();
}

/** 表里定义过、白名单里却没登记（或反之）的 id —— 自检用，正常应为空 */
export function idRegistrationDiff(): { missingFromTable: string[]; missingFromWhitelist: string[] } {
  const table = new Set(TOOLS.map((t) => t.id));
  const declared = new Set(TOOL_IDS);
  return {
    missingFromTable: TOOL_IDS.filter((id) => !table.has(id)),
    missingFromWhitelist: TOOLS.map((t) => t.id).filter((id) => !declared.has(id)),
  };
}
