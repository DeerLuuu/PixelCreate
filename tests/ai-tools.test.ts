// C1 回归：AI 工具表（src/app/ai-tools.ts）。
//
// 这一份测试盯的是「不要改回去」的几件事：
//   · 工具 id 与 Session.allActions() 共用命名空间 —— 白名单与工具表 id 集合**相等**，
//     新 id 必须登记，能对上的 id 必须在界面动作表里真的存在（静态扫 uibar.ts / App.tsx）；
//   · 没有新增写入路径 —— 静态扫 ai-tools.ts 里所有 `s.<方法>(` 调用，逐个断言它真的在
//     `Session.prototype` 上（handler 只能「适配参数 + 调既有方法」）；
//   · callTool 的固定顺序：参数不合格不执行也不确认；destructive 未确认 → cancelled 且
//     文档逐字节不变；确认后才执行；
//   · listTools 的稳定顺序（tier 分组 + 组内字典序）与「默认不含 ui」；
//   · §4 映射表里标「已有方法」的条目全部有工具。
import { Doc } from "../src/engine/doc";
import { Session } from "../src/app/session";
import { AI_INDEX_ALPHABET, docDigest, readRegion } from "../src/app/ai-doc";
import {
  AI_ARG_CURRENT, AI_TIER_ORDER, AI_TOOL_ACTION_IDS, AI_TOOL_ID_WHITELIST,
  allToolIds, callTool, getTool, idRegistrationDiff, listTools, validateArgs,
} from "../src/app/ai-tools";
import type { AiParamType, AiTier, AiTool, AiToolCtx, AiToolParam } from "../src/app/ai-tools";
import { stubEnv } from "./session.test";
import { eq, ok } from "./common";

declare const require: (m: string) => any;
declare const __dirname: string;
const fs = require("fs");
const path = require("path");

const ALL_TIERS: AiTier[] = ["read", "draw", "destructive", "ui"];
const PARAM_TYPES: AiParamType[] = ["int", "num", "bool", "string", "enum", "color", "xy", "rect", "array"];

type Args = Record<string, unknown>;

interface CtxKit {
  ctx: AiToolCtx;
  asked: Array<{ tool: string; tier: string; summary: string }>;
  marks: () => number;
}

/** 会话 + 确认回调 + 回合桩（确认默认「点确定」；`yes=false` 模拟用户点取消） */
function mkCtx(s: Session, yes = true, turnOn = false): CtxKit {
  const asked: Array<{ tool: string; tier: string; summary: string }> = [];
  let marks = 0;
  const ctx: AiToolCtx = {
    session: s,
    confirm: async (r) => { asked.push({ tool: r.tool, tier: r.tier, summary: r.summary }); return yes; },
    turn: turnOn ? { isOpen: () => true, mark: () => { marks++; } } : null,
  };
  return { ctx, asked, marks: () => marks };
}

/** 逐字节的文档快照（含调色板 / 图层帧数 / 版本号），钉住「取消时一个字节都没动」 */
function docBytes(s: Session): string {
  const parts: string[] = [s.doc.w + "x" + s.doc.h, "pal=" + JSON.stringify(s.doc.palette),
    "layers=" + s.doc.layers.length, "frames=" + s.doc.frames.length,
    "tags=" + JSON.stringify(s.doc.tags), "rev=" + s.doc.pixelRev];
  for (const k of Array.from(s.doc.cels.keys()).sort()) {
    const cel = s.doc.cels.get(k);
    if (cel) parts.push(k + "=" + Array.from(cel.data).join(","));
  }
  return parts.join("|");
}

function inkCount(s: Session): number {
  let n = 0;
  for (const cel of s.doc.cels.values()) for (let i = 3; i < cel.data.length; i += 4) if (cel.data[i] > 0) n++;
  return n;
}

/**
 * 用 `read_region` 读回**一格**像素的规范颜色串（`.` = 全透明 → null）。
 * P1 的「真画完再读回」断言全靠它：走的是模型自己会走的那条读路径（索引网格 → 调色板），
 * 而不是直接戳 cel 的字节。
 */
async function readPx(kit: CtxKit, x: number, y: number, li = 0, fi = 0): Promise<string | null> {
  const r = await callTool("read_region", { rect: { x, y, w: 1, h: 1 }, li, fi }, kit.ctx);
  const reg = r.data as { rows: string[]; palette: string[] };
  const ch = reg.rows[0] ? reg.rows[0][0] : ".";
  if (ch === ".") return null;
  const i = AI_INDEX_ALPHABET.indexOf(ch);
  return i >= 0 ? reg.palette[i] : null;
}

/** 有内容的会话：3 色调色板、16 个红像素、两帧两个标签（tag_* 的工具要有真 id 可用） */
function live(): Session {
  const s = new Session();
  s.doc.palette = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]];
  const cel = s.doc.ensureCel(0, 0);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) cel.setPixel(x, y, [255, 0, 0, 255]);
  s.frameAdd();
  s.tagAdd("t1", 0, 0);
  s.tagAdd("t2", 1, 1);
  s.history.clear();
  return s;
}

function fakeTool(params: Record<string, AiToolParam>): AiTool {
  return { id: "fake", title: "假工具", tier: "read", params, returns: {}, handler: () => ({ ok: true }) };
}

function lastReason(r: { ok: true; value: Args } | { ok: false; reason: string }): string {
  return r.ok === false ? r.reason : "";
}

function validated(tool: AiTool, args: Args): Args | null {
  const r = validateArgs(tool, args);
  return r.ok ? r.value : null;
}

function readFile(rel: string): string {
  // 编译到 <app>/tests/.ts-out/tests → 仓库根在三级之上
  return fs.readFileSync(path.resolve(__dirname, "../../..", rel), "utf8");
}

export async function testAiTools(): Promise<void> {
  stubEnv();
  const s = live();

  // ------------------------------------------------------------ 1. 表结构 / schema
  const all = listTools({ tiers: ALL_TIERS });
  eq("aitools.count", all.length, 61);
  eq("aitools.action-ids", AI_TOOL_ACTION_IDS, ["undo", "redo"]);
  eq("aitools.list-default-no-ui", listTools().filter((t) => t.tier === "ui").length, 0);
  eq("aitools.list-ui-only", listTools({ tiers: ["ui"] }).map((t) => t.id), ["set_tool"]);
  eq("aitools.list-default-count", listTools().length, all.length - 1);
  eq("aitools.list-stable", listTools({ tiers: ALL_TIERS }).map((t) => t.id), all.map((t) => t.id));

  // 顺序：tier 分组（read → draw → destructive → ui），组内按 id 字典序
  for (let i = 1; i < all.length; i++) {
    ok("aitools.order.tier-monotonic." + i,
      AI_TIER_ORDER.indexOf(all[i].tier) >= AI_TIER_ORDER.indexOf(all[i - 1].tier));
  }
  eq("aitools.order.first-tier", all[0].tier, "read");
  eq("aitools.order.last-tier", all[all.length - 1].tier, "ui");
  for (const tier of AI_TIER_ORDER) {
    const ids = all.filter((t) => t.tier === tier).map((t) => t.id);
    eq("aitools.order.sorted." + tier, ids, ids.slice().sort());
    ok("aitools.order.nonempty." + tier, ids.length > 0, "tier=" + tier);
  }
  // 传入的档序不影响输出顺序（永远是规范顺序）
  eq("aitools.list-tiers-order-ignored", listTools({ tiers: ["destructive", "read"] }).map((t) => t.id),
    all.filter((t) => t.tier === "read" || t.tier === "destructive").map((t) => t.id));
  eq("aitools.list-unknown-tier-filter", listTools({ tiers: ["nope" as AiTier] }).length, 0);

  // P1 新工具的 tier 分档与参数 desc（写像素＝draw；删掉 / 移走已有像素＝destructive）
  const P1_TIERS: Record<string, AiTier> = {
    draw_path: "draw", draw_shape: "draw", fill: "draw",
    fx_outline: "draw", fx_inline: "draw", fx_shadow: "draw", fx_glow: "draw",
    fx_invert: "draw", fx_gray: "draw", fx_round: "draw", fx_blur: "draw",
    erase: "destructive", transform: "destructive",
  };
  eq("aitools.p1.count", Object.keys(P1_TIERS).length, 13);
  let p1Params = 0, p1NoDesc = 0;
  for (const id of Object.keys(P1_TIERS)) {
    const t = getTool(id);
    ok("aitools.p1.in-table." + id, !!t);
    if (!t) continue;
    ok("aitools.p1.tier." + id, t.tier === P1_TIERS[id], id + " → " + t.tier);
    ok("aitools.p1.returns-docrev." + id, Object.prototype.hasOwnProperty.call(t.returns, "docRev"));
    for (const name of Object.keys(t.params)) {
      p1Params++;
      if (!t.params[name].desc) p1NoDesc++;
    }
  }
  ok("aitools.p1.params-sane", p1Params >= 60, "params=" + p1Params);
  eq("aitools.p1.params-desc", p1NoDesc, 0);

  // 每个 schema 都自洽
  for (const t of all) {
    ok("aitools.schema.id." + t.id, t.id.length > 0 && t.id === t.id.toLowerCase(), "id=" + t.id);
    ok("aitools.schema.id-shape." + t.id, /^[a-z][a-z0-9_]*$/.test(t.id), "id=" + t.id);
    ok("aitools.schema.title." + t.id, typeof t.title === "string" && t.title.length > 0);
    ok("aitools.schema.tier." + t.id, AI_TIER_ORDER.indexOf(t.tier) >= 0, "tier=" + t.tier);
    ok("aitools.schema.returns." + t.id, Object.keys(t.returns).length > 0);
    ok("aitools.schema.handler." + t.id, typeof t.handler === "function");
    eq("aitools.schema.gettool." + t.id, getTool(t.id) === t, true);
    for (const name of Object.keys(t.params)) {
      const p = t.params[name];
      ok("aitools.schema.param-type." + t.id + "." + name, PARAM_TYPES.indexOf(p.type) >= 0, "type=" + p.type);
      if (p.type === "enum") {
        ok("aitools.schema.enum-values." + t.id + "." + name, Array.isArray(p.values) && p.values.length > 0);
      }
      if (p.type === "array") {
        ok("aitools.schema.array-items." + t.id + "." + name, !!p.items && PARAM_TYPES.indexOf(p.items) >= 0);
      }
      if (p.min !== undefined && p.max !== undefined) {
        ok("aitools.schema.range." + t.id + "." + name, p.min <= p.max, p.min + ".." + p.max);
      }
      if (p.default === undefined || p.default === AI_ARG_CURRENT) continue;
      // 默认值必须自己能过校验（否则「省略参数」会被自己的校验拒掉）
      const one = validateArgs(fakeTool({ v: p }), { v: p.default });
      ok("aitools.schema.default-valid." + t.id + "." + name, one.ok === true, lastReason(one));
    }
  }
  eq("aitools.gettool.unknown", getTool("nope"), null);
  eq("aitools.gettool.no-proto-leak", getTool("toString"), null);

  // ------------------------------------------------------------ 2. id 命名空间与 allActions()
  const tableIds = new Set(allToolIds());
  const declared = new Set<string>([...AI_TOOL_ACTION_IDS, ...AI_TOOL_ID_WHITELIST]);
  eq("aitools.ids.size", tableIds.size, declared.size);
  eq("aitools.ids.no-dupe", allToolIds().length, new Set(allToolIds()).size);
  eq("aitools.whitelist.sorted", AI_TOOL_ID_WHITELIST.slice().sort(), AI_TOOL_ID_WHITELIST.slice());
  eq("aitools.whitelist.no-dupe", new Set(AI_TOOL_ID_WHITELIST).size, AI_TOOL_ID_WHITELIST.length);
  eq("aitools.whitelist.disjoint-from-actions", AI_TOOL_ID_WHITELIST.filter((id) => AI_TOOL_ACTION_IDS.indexOf(id) >= 0), []);
  for (const id of tableIds) ok("aitools.ids.declared." + id, declared.has(id));
  for (const id of declared) ok("aitools.ids.in-table." + id, tableIds.has(id));
  eq("aitools.ids.diff", idRegistrationDiff(), { missingFromTable: [], missingFromWhitelist: [] });

  // 与动作表同名的那两条：真的能被 Session 的动作注册表列出来（同一命名空间）
  const s2 = new Session();
  s2.registerActions({
    undo: { icon: "i-undo", label: "撤销", run: () => undefined },
    redo: { icon: "i-redo", label: "重做", run: () => undefined },
  });
  const actionIds = new Set(s2.allActions().map((a) => a.id));
  for (const id of AI_TOOL_ACTION_IDS) ok("aitools.ids.action-namespace." + id, actionIds.has(id));

  // 静态扫界面源码：共用的 id 必须在动作表里出现；白名单里的 id 必须是工具表新造的
  const uiSrc = readFile("src/ui/App.tsx") + "\n" + readFile("src/app/uibar.ts");
  const uiActionIds = new Set<string>();
  const idRe = /id:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = idRe.exec(uiSrc)) !== null) uiActionIds.add(m[1]);
  ok("aitools.ids.ui-scan-sane", uiActionIds.size >= 30, "ui ids=" + uiActionIds.size);
  for (const id of AI_TOOL_ACTION_IDS) ok("aitools.ids.ui-has." + id, uiActionIds.has(id));
  eq("aitools.ids.whitelist-not-ui-actions", AI_TOOL_ID_WHITELIST.filter((id) => uiActionIds.has(id)), []);

  // ------------------------------------------------------------ 3. §4 覆盖矩阵 + 无新写入路径
  const covered: Array<[string, string]> = [
    // palette_*
    ["paletteAdd", "palette_add"], ["paletteRemove", "palette_remove"], ["paletteDedupe", "palette_dedupe"],
    ["paletteMerge", "palette_merge"], ["paletteSort", "palette_sort"],
    ["paletteFromCanvas", "palette_from_canvas"], ["remapToPalette", "palette_remap"],
    // color_*
    ["analyseCanvas", "color_analyse"], ["colourGroups", "color_groups"],
    ["replaceColour", "color_replace"], ["selectColourPixels", "color_select"],
    ["mergeColourGroup", "color_merge_group"],
    // layer_*
    ["layerAdd", "layer_add"], ["layerDuplicate", "layer_duplicate"], ["layerDelete", "layer_delete"],
    ["layerUp", "layer_up"], ["layerDown", "layer_down"], ["layerMoveTo", "layer_move_to"],
    ["layerMergeDown", "layer_merge_down"], ["toggleLayerVisible", "layer_toggle_visible"],
    ["toggleLayerLock", "layer_toggle_lock"], ["toggleSoloLayers", "layer_toggle_solo"],
    ["renameLayer", "layer_rename"], ["setLayerOpacity", "layer_opacity"], ["setLayerBlend", "layer_blend"],
    ["setLayer", "layer_select"],
    // frame_*
    ["frameAdd", "frame_add"], ["frameDuplicate", "frame_duplicate"], ["frameDelete", "frame_delete"],
    ["frameMove", "frame_move"], ["frameMoveTo", "frame_move_to"], ["setFrameDuration", "frame_duration"],
    ["setFrame", "frame_select"],
    // tag_*
    ["tagAdd", "tag_add"], ["tagRename", "tag_rename"], ["tagSetRange", "tag_set_range"],
    ["tagSetColor", "tag_set_color"], ["tagRemove", "tag_remove"],
    // undo / redo / scale / iso_* / 清空画布
    ["undo", "undo"], ["redo", "redo"], ["scaleAdvanced", "scale"], ["clearCanvas", "canvas_clear"],
    ["setIsoPref", "iso_set"], ["setIsoOrigin", "iso_origin"], ["isoGenerate", "iso_generate"],
    ["setTool", "set_tool"],
    // P1 像素级工具面：handler 调的是 src/app/ai-draw.ts，而 ai-draw 只走 Session 的这几个门面
    ["brush", "draw_path"], ["brush", "draw_shape"], ["paletteSnap", "draw_path"],
    ["strokeTarget", "draw_shape"], ["refPaintBlock", "erase"], ["repaint", "fill"],
    ["changedUI", "fill"], ["maskOp", "fx_outline"], ["maskOp", "fx_inline"], ["maskOp", "fx_shadow"],
    ["maskOp", "fx_glow"], ["maskOp", "fx_invert"], ["maskOp", "fx_gray"], ["maskOp", "fx_round"],
    ["maskOp", "fx_blur"], ["maskOp", "transform"],
  ];
  const proto = Session.prototype as unknown as Record<string, unknown>;
  for (const [method, toolId] of covered) {
    ok("aitools.cover.tool." + toolId, getTool(toolId) !== null, toolId);
    ok("aitools.cover.method." + method, typeof proto[method] === "function", method);
  }
  // 文档读类工具转发的是 C0 的两个纯函数
  ok("aitools.cover.tool.doc_digest", getTool("doc_digest") !== null);
  ok("aitools.cover.tool.read_region", getTool("read_region") !== null);
  eq("aitools.cover.docDigest", typeof docDigest, "function");
  eq("aitools.cover.readRegion", typeof readRegion, "function");
  // 反向：工具表里没有「游离」的工具（每个 id 都被覆盖矩阵点到）
  const coveredIds = new Set(covered.map((c) => c[1]).concat(["doc_digest", "read_region"]));
  eq("aitools.cover.no-orphan", allToolIds().filter((id) => !coveredIds.has(id)), []);

  // 静态扫源文件：handler 里每一次 `s.<方法>(` 都必须是 Session 上已有的方法
  const src = readFile("src/app/ai-tools.ts");
  const callRe = /\bs\.([A-Za-z_$][A-Za-z0-9_$]*)\(/g;
  const calls = new Set<string>();
  while ((m = callRe.exec(src)) !== null) calls.add(m[1]);
  ok("aitools.nowrite.scan-sane", calls.size >= 35, "session calls=" + calls.size);
  for (const name of Array.from(calls).sort()) {
    ok("aitools.nowrite.session-method." + name, typeof proto[name] === "function", name);
  }
  // handler 不许直接改文档结构（绕过 Session 的写入路径）
  const forbidden = ["doc.cels.set(", "doc.palette.push(", "doc.palette.splice(", "doc.layers.push(",
    "doc.frames.push(", "doc.tags.push(", "history.record(", "history.pushPixels(", "history.pushStruct("];
  forbidden.forEach((bad, i) => ok("aitools.nowrite.no-direct-write." + i, src.indexOf(bad) < 0, bad));

  // ------------------------------------------------------------ 4. validateArgs 单元（逐类型）
  ok("aitools.validate.int.ok", validateArgs(fakeTool({ v: { type: "int", min: 1, max: 64 } }), { v: 5 }).ok === true);
  ok("aitools.validate.int.frac", lastReason(validateArgs(fakeTool({ v: { type: "int" } }), { v: 1.5 })).indexOf("整数") >= 0);
  ok("aitools.validate.int.string", lastReason(validateArgs(fakeTool({ v: { type: "int" } }), { v: "5" })).indexOf("期望整数") >= 0);
  ok("aitools.validate.int.nan", lastReason(validateArgs(fakeTool({ v: { type: "int" } }), { v: NaN })).indexOf("期望整数") >= 0);
  ok("aitools.validate.int.min", lastReason(validateArgs(fakeTool({ v: { type: "int", min: 1 } }), { v: 0 })).indexOf("小于最小值 1") >= 0);
  ok("aitools.validate.int.max", lastReason(validateArgs(fakeTool({ v: { type: "int", max: 64 } }), { v: 999 })).indexOf("大于最大值 64") >= 0);
  ok("aitools.validate.int.no-clamp-hint", lastReason(validateArgs(fakeTool({ v: { type: "int", max: 64 } }), { v: 999 })).indexOf("不做静默钳制") >= 0);
  ok("aitools.validate.num.ok", validateArgs(fakeTool({ v: { type: "num", min: 0, max: 1 } }), { v: 0.5 }).ok === true);
  ok("aitools.validate.num.bad", validateArgs(fakeTool({ v: { type: "num" } }), { v: "0.5" }).ok === false);
  ok("aitools.validate.bool.ok", validateArgs(fakeTool({ v: { type: "bool" } }), { v: false }).ok === true);
  ok("aitools.validate.bool.bad", validateArgs(fakeTool({ v: { type: "bool" } }), { v: 0 }).ok === false);
  ok("aitools.validate.string.ok", validateArgs(fakeTool({ v: { type: "string", min: 1, max: 4 } }), { v: "ab" }).ok === true);
  ok("aitools.validate.string.short", validateArgs(fakeTool({ v: { type: "string", min: 2 } }), { v: "a" }).ok === false);
  ok("aitools.validate.string.long", validateArgs(fakeTool({ v: { type: "string", max: 2 } }), { v: "abc" }).ok === false);
  ok("aitools.validate.enum.ok", validateArgs(fakeTool({ v: { type: "enum", values: ["a", "b"] } }), { v: "b" }).ok === true);
  ok("aitools.validate.enum.bad", lastReason(validateArgs(fakeTool({ v: { type: "enum", values: ["a", "b"] } }), { v: "z" })).indexOf("不在") >= 0);
  for (const good of ["#abc", "#AABBCC", "#aabbccdd", "fg", "bg"]) {
    ok("aitools.validate.color.ok." + good, validateArgs(fakeTool({ v: { type: "color" } }), { v: good }).ok === true);
  }
  for (const bad of ["#12345", "#gggggg", "red", "rgb(1,2,3)"]) {
    ok("aitools.validate.color.bad." + bad, validateArgs(fakeTool({ v: { type: "color" } }), { v: bad }).ok === false);
  }
  ok("aitools.validate.color.not-string", validateArgs(fakeTool({ v: { type: "color" } }), { v: 7 }).ok === false);
  eq("aitools.validate.xy.ok", validated(fakeTool({ v: { type: "xy" } }), { v: [3, 4] }), { v: [3, 4] });
  for (const bad of [[3], [3, 4, 5], ["3", 4], [3.5, 4], 3, null]) {
    ok("aitools.validate.xy.bad." + JSON.stringify(bad), validateArgs(fakeTool({ v: { type: "xy" } }), { v: bad }).ok === false);
  }
  eq("aitools.validate.rect.ok", validated(fakeTool({ v: { type: "rect" } }), { v: { x: 1, y: 2, w: 3, h: 4 } }), { v: { x: 1, y: 2, w: 3, h: 4 } });
  ok("aitools.validate.rect.extra", lastReason(validateArgs(fakeTool({ v: { type: "rect" } }), { v: { x: 1, y: 2, w: 3, h: 4, z: 0 } })).indexOf("未知字段") >= 0);
  ok("aitools.validate.rect.missing", validateArgs(fakeTool({ v: { type: "rect" } }), { v: { x: 1, y: 2, w: 3 } }).ok === false);
  ok("aitools.validate.rect.negative", lastReason(validateArgs(fakeTool({ v: { type: "rect" } }), { v: { x: 0, y: 0, w: -1, h: 1 } })).indexOf("不能为负") >= 0);
  ok("aitools.validate.rect.bad-type", validateArgs(fakeTool({ v: { type: "rect" } }), { v: [0, 0, 1, 1] }).ok === false);
  ok("aitools.validate.array.ok", validateArgs(fakeTool({ v: { type: "array", items: "color", min: 1, max: 2 } }), { v: ["#fff"] }).ok === true);
  ok("aitools.validate.array.short", validateArgs(fakeTool({ v: { type: "array", items: "color", min: 1 } }), { v: [] }).ok === false);
  ok("aitools.validate.array.long", validateArgs(fakeTool({ v: { type: "array", items: "color", max: 1 } }), { v: ["#fff", "#000"] }).ok === false);
  ok("aitools.validate.array.item", lastReason(validateArgs(fakeTool({ v: { type: "array", items: "color" } }), { v: ["#fff", "nope"] })).indexOf("[1]") >= 0);
  ok("aitools.validate.array.not-array", validateArgs(fakeTool({ v: { type: "array", items: "color" } }), { v: "#fff" }).ok === false);
  ok("aitools.validate.unknown-param", lastReason(validateArgs(fakeTool({ v: { type: "int" } }), { v: 1, x: 2 })).indexOf("未知参数 x") >= 0);
  ok("aitools.validate.no-param-tool-rejects", lastReason(validateArgs(fakeTool({}), { x: 2 })).indexOf("无参数") >= 0);
  ok("aitools.validate.missing", lastReason(validateArgs(fakeTool({ v: { type: "int" } }), {})).indexOf("缺少必填参数 v") >= 0);
  ok("aitools.validate.not-object", validateArgs(fakeTool({ v: { type: "int", default: 1 } }), [1]).ok === false);
  ok("aitools.validate.default-args-ok", validateArgs(fakeTool({ v: { type: "int", default: 7 } }), undefined).ok === true);
  eq("aitools.validate.default-value", (validated(fakeTool({ v: { type: "int", default: 7 } }), {}) ?? {}).v, 7);
  eq("aitools.validate.current-sentinel", (validated(fakeTool({ v: { type: "int", default: AI_ARG_CURRENT } }), {}) ?? {}).v, AI_ARG_CURRENT);
  ok("aitools.validate.rejects-current-when-given", validateArgs(fakeTool({ v: { type: "int" } }), { v: AI_ARG_CURRENT }).ok === false);
  // optional：省略 = 不改这一项（值里干脆不出现这个键），补丁类工具靠它
  ok("aitools.validate.optional-omitted-ok", validateArgs(fakeTool({ v: { type: "int", optional: true } }), {}).ok === true);
  eq("aitools.validate.optional-key-absent", validated(fakeTool({ v: { type: "int", optional: true }, k: { type: "int", default: 1 } }), {}), { k: 1 });
  ok("aitools.validate.optional-still-checked", validateArgs(fakeTool({ v: { type: "int", min: 5, optional: true } }), { v: 1 }).ok === false);
  const isoSet = getTool("iso_set") as AiTool;
  ok("aitools.schema.iso-set-all-optional", Object.keys(isoSet.params).every((k) => isoSet.params[k].optional === true));
  eq("aitools.validate.iso-set-partial", validated(isoSet, { shape: "box" }), { shape: "box" });
  // 严格：传进来的对象不被改、返回值只含声明过的字段
  const given: Args = { v: 3 };
  const before = JSON.stringify(given);
  const vr = validateArgs(fakeTool({ v: { type: "int" }, k: { type: "bool", default: true } }), given);
  eq("aitools.validate.input-untouched", JSON.stringify(given), before);
  eq("aitools.validate.fills-only-declared", vr.ok ? Object.keys(vr.value).sort() : [], ["k", "v"]);

  // ------------------------------------------------------------ 5. callTool 固定顺序
  const kit = mkCtx(s);
  eq("aitools.call.unknown", await callTool("nope", {}, kit.ctx), { ok: false, error: "unknown tool: nope" });
  eq("aitools.call.unknown-proto", await callTool("toString", {}, kit.ctx), { ok: false, error: "unknown tool: toString" });

  // ① 非法参数：不执行、不确认
  const sBad = live();
  const kitBad = mkCtx(sBad);
  const badBefore = docBytes(sBad);
  const rBad = await callTool("palette_add", { color: "not-a-colour" }, kitBad.ctx);
  eq("aitools.call.invalid.ok", rBad.ok, false);
  ok("aitools.call.invalid.reason", (rBad.error ?? "").indexOf("invalid args") === 0 && (rBad.error ?? "").indexOf("不是颜色") > 0, String(rBad.error));
  eq("aitools.call.invalid.not-executed", sBad.doc.palette.length, 3);
  eq("aitools.call.invalid.no-confirm", kitBad.asked.length, 0);
  eq("aitools.call.invalid.doc-untouched", docBytes(sBad), badBefore);
  const rBadDestructive = await callTool("scale", { w: 9999, h: 8 }, kitBad.ctx);
  eq("aitools.call.invalid-destructive.ok", rBadDestructive.ok, false);
  eq("aitools.call.invalid-destructive.no-confirm", kitBad.asked.length, 0);
  eq("aitools.call.invalid-destructive.doc-untouched", docBytes(sBad), badBefore);

  // ② destructive 未确认 → cancelled，且文档逐字节不变（P1 新增的 erase / transform 同款）
  for (const id of ["canvas_clear", "layer_delete", "frame_delete", "layer_merge_down", "scale", "erase", "transform"]) {
    const sc = live();
    const cancelKit = mkCtx(sc, false);
    const before = docBytes(sc);
    const args: Args = id === "scale" ? { w: 32, h: 32 }
      : id === "erase" ? { rect: { x: 0, y: 0, w: 4, h: 4 } }
        : id === "transform" ? { mode: "move", scope: "layer", dx: 3, dy: 3 }
          : {};
    const res = await callTool(id, args, cancelKit.ctx);
    eq("aitools.call.cancel.result." + id, res, { ok: false, error: "cancelled" });
    eq("aitools.call.cancel.asked." + id, cancelKit.asked.length, 1);
    eq("aitools.call.cancel.tool." + id, cancelKit.asked[0].tool, id);
    eq("aitools.call.cancel.tier." + id, cancelKit.asked[0].tier, "destructive");
    ok("aitools.call.cancel.summary." + id, cancelKit.asked[0].summary.length > 0);
    eq("aitools.call.cancel.bytes." + id, docBytes(sc), before);
    eq("aitools.call.cancel.no-mark." + id, cancelKit.marks(), 0);
  }

  // non-destructive 档不许问确认（问就是打扰用户）
  const sQuiet = live();
  const quiet = mkCtx(sQuiet, false);
  eq("aitools.call.draw-no-confirm.ok", (await callTool("palette_add", { color: "#123456" }, quiet.ctx)).ok, true);
  eq("aitools.call.draw-no-confirm.asked", quiet.asked.length, 0);
  const sRead = live();
  const readKit = mkCtx(sRead, false);
  const rr = await callTool("doc_digest", {}, readKit.ctx);
  eq("aitools.call.read-no-confirm.ok", rr.ok, true);
  eq("aitools.call.read-no-confirm.asked", readKit.asked.length, 0);
  eq("aitools.call.read-result-is-digest", (rr.data as { w: number }).w, sRead.doc.w);
  eq("aitools.call.no-wrapper-field", Object.prototype.hasOwnProperty.call(rr, "result"), false);

  // ③ 确认之后正常执行
  const sOk = live();
  const okKit = mkCtx(sOk, true);
  const beforeClear = inkCount(sOk);
  ok("aitools.call.confirm.had-ink", beforeClear > 0, "ink=" + beforeClear);
  const clearRes = await callTool("canvas_clear", {}, okKit.ctx);
  eq("aitools.call.confirm.cleared-ok", clearRes.ok, true);
  eq("aitools.call.confirm.cleared-count", (clearRes.data as { cleared: number }).cleared, beforeClear);
  eq("aitools.call.confirm.asked-once", okKit.asked.length, 1);
  ok("aitools.call.confirm.summary-has-title", okKit.asked[0].summary.indexOf("清空画布") >= 0, okKit.asked[0].summary);
  eq("aitools.call.confirm.cleared-bytes", inkCount(sOk), 0);

  const sScale = live();
  const scaleKit = mkCtx(sScale, true);
  const scaleRes = await callTool("scale", { w: 32, h: 32, algo: "nearest", scope: "sprite" }, scaleKit.ctx);
  eq("aitools.call.confirm.scale-ok", scaleRes.ok, true);
  eq("aitools.call.confirm.scale-dims", [sScale.doc.w, sScale.doc.h], [32, 32]);
  eq("aitools.call.confirm.scale-asked", scaleKit.asked.length, 1);
  ok("aitools.call.confirm.scale-summary", scaleKit.asked[0].summary.indexOf("w=32") >= 0, scaleKit.asked[0].summary);
  eq("aitools.call.confirm.scale-changed", scaleRes.changed, { x: 0, y: 0, w: 32, h: 32 });

  const sDel = live();
  sDel.layerAdd();
  const delKit = mkCtx(sDel, true);
  eq("aitools.call.confirm.layer-delete-before", sDel.doc.layers.length, 2);
  eq("aitools.call.confirm.layer-delete-ok", (await callTool("layer_delete", {}, delKit.ctx)).ok, true);
  eq("aitools.call.confirm.layer-delete-count", sDel.doc.layers.length, 1);

  // handler 抛异常也只转成 {ok:false, error}
  const broken = mkCtx(null as unknown as Session);
  const thrown = await callTool("doc_digest", {}, broken.ctx);
  eq("aitools.call.handler-throw.ok", thrown.ok, false);
  ok("aitools.call.handler-throw.reason", (thrown.error ?? "").indexOf("handler failed") === 0, String(thrown.error));

  // ------------------------------------------------------------ 6. 回合（C2 的接缝）
  const sTurn = live();
  const turnKit = mkCtx(sTurn, true, true);
  await callTool("palette_add", { color: "#010203" }, turnKit.ctx);
  eq("aitools.turn.mark-on-write", turnKit.marks(), 1);
  await callTool("doc_digest", {}, turnKit.ctx);
  eq("aitools.turn.no-mark-on-read", turnKit.marks(), 1);
  await callTool("palette_add", { color: "bad" }, turnKit.ctx);
  eq("aitools.turn.no-mark-on-invalid", turnKit.marks(), 1);
  const cancelTurn = mkCtx(sTurn, false, true);
  await callTool("canvas_clear", {}, cancelTurn.ctx);
  eq("aitools.turn.no-mark-on-cancel", cancelTurn.marks(), 0);

  // ------------------------------------------------------------ 7. 每个工具都能被调用到
  const SMOKE: Record<string, (ss: Session) => Args> = {
    doc_digest: () => ({}),
    read_region: () => ({ rect: { x: 0, y: 0, w: 8, h: 8 } }),
    color_analyse: () => ({ scope: "canvas" }),
    color_groups: () => ({ scope: "layer", tol: 12 }),
    color_merge_group: () => ({ rep: "#00ff00", colors: ["#0000ff"], scope: "canvas" }),
    color_replace: () => ({ from: "#ff0000", to: "#00ff00", scope: "canvas" }),
    color_select: () => ({ color: "#00ff00", scope: "layer" }),
    frame_add: () => ({}),
    frame_duplicate: () => ({}),
    frame_duration: () => ({ ms: 120 }),
    frame_move: () => ({ direction: "next" }),
    frame_move_to: () => ({ from: 0, to: 1 }),
    frame_select: () => ({ fi: 1 }),
    iso_generate: () => ({ target: "layer" }),
    iso_origin: () => ({ at: [4, 4] }),
    iso_set: () => ({ shape: "box", w: 2, d: 2, h: 1, tile: "4", colorMode: "mono" }),
    draw_path: () => ({ points: [[1, 1], [6, 6]], tool: "pencil", size: 1, color: "#ff00ff" }),
    draw_shape: () => ({ shape: "rect", from: [1, 1], to: [5, 5], fill: true, color: "#00ffff" }),
    fill: () => ({ at: [0, 0], color: "#123456", tolerance: 0, gaps: 0 }),
    erase: () => ({ rect: { x: 0, y: 0, w: 2, h: 2 } }),
    transform: () => ({ mode: "move", scope: "layer", dx: 1, dy: 1 }),
    fx_outline: () => ({ width: 1, pos: "outside", color: "#000000" }),
    fx_inline: () => ({ width: 1, alpha: 100, color: "#000000" }),
    fx_shadow: () => ({ dx: 1, dy: 1, color: "#000000", alpha: 50 }),
    fx_glow: () => ({ radius: 1, color: "#ffffff" }),
    fx_invert: () => ({}),
    fx_gray: () => ({}),
    fx_round: () => ({ radius: 1, mode: "outer" }),
    fx_blur: () => ({ radius: 1 }),
    layer_add: () => ({}),
    layer_blend: () => ({ blend: "multiply" }),
    layer_duplicate: () => ({}),
    layer_down: () => ({}),
    layer_move_to: () => ({ from: 1, to: 2 }),
    layer_opacity: () => ({ opacity: 80 }),
    layer_rename: () => ({ name: "ai 层" }),
    layer_select: () => ({ li: 1 }),
    layer_toggle_lock: () => ({}),
    layer_toggle_solo: () => ({}),
    layer_toggle_visible: () => ({}),
    layer_up: () => ({}),
    palette_add: () => ({ color: "#123456" }),
    palette_dedupe: () => ({}),
    palette_from_canvas: () => ({}),
    palette_merge: () => ({ colors: ["#abcdef", "fg"] }),
    palette_remove: () => ({ index: 0 }),
    palette_remap: () => ({ scope: "canvas" }),
    palette_sort: () => ({ mode: "light" }),
    redo: () => ({}),
    tag_add: () => ({ name: "smoke", from: 0, to: 1 }),
    tag_remove: (ss) => ({ id: ss.doc.tags.length ? ss.doc.tags[0].id : "nope" }),
    tag_rename: (ss) => ({ id: ss.doc.tags.length ? ss.doc.tags[0].id : "nope", name: "renamed" }),
    tag_set_color: (ss) => ({ id: ss.doc.tags.length ? ss.doc.tags[0].id : "nope", color: "#ff00ff" }),
    tag_set_range: (ss) => ({ id: ss.doc.tags.length ? ss.doc.tags[0].id : "nope", from: 0, to: 1 }),
    undo: () => ({}),
    canvas_clear: () => ({}),
    frame_delete: () => ({}),
    layer_delete: () => ({}),
    layer_merge_down: () => ({}),
    scale: () => ({ w: 32, h: 32, scope: "sprite" }),
    set_tool: () => ({ tool: "pencil" }),
  };
  eq("aitools.smoke.covers-table", Object.keys(SMOKE).sort(), allToolIds().slice().sort());
  const sSmoke = live();
  const smokeKit = mkCtx(sSmoke, true);
  for (const t of all) {
    const make = SMOKE[t.id];
    ok("aitools.smoke.has-args." + t.id, typeof make === "function");
    if (!make) continue;
    const res = await callTool(t.id, make(sSmoke), smokeKit.ctx);
    ok("aitools.smoke.callable." + t.id, !!res && typeof res.ok === "boolean", JSON.stringify(res).slice(0, 240));
  }

  // ------------------------------------------------------------ 8. 行为抽查（每条只调既有方法）
  const b = live();
  const bk = mkCtx(b, true);

  // 读类转发的是 ai-doc 的纯函数结果
  const dig = await callTool("doc_digest", { fi: 0 }, bk.ctx);
  eq("aitools.behave.digest.w", (dig.data as { w: number }).w, b.doc.w);
  eq("aitools.behave.digest.docrev", dig.docRev, b.doc.pixelRev);
  const reg = await callTool("read_region", { rect: { x: 0, y: 0, w: 4, h: 4 }, fi: 0, li: 0 }, bk.ctx);
  eq("aitools.behave.region.rows", (reg.data as { rows: string[] }).rows.length, 4);
  eq("aitools.behave.region.clipped", (reg.data as { clipped: boolean }).clipped, false);
  eq("aitools.behave.region.text-head", (reg.data as { text: string }).text.indexOf("region (x=0,y=0,w=4,h=4)") === 0, true);
  const regOut = await callTool("read_region", { rect: { x: 60, y: 60, w: 16, h: 16 } }, bk.ctx);
  eq("aitools.behave.region-outside-clipped", (regOut.data as { clipped: boolean }).clipped, true);

  // 调色板
  eq("aitools.behave.palette.add", (await callTool("palette_add", { color: "#010203" }, bk.ctx)).data, { index: 3, size: 4 });
  eq("aitools.behave.palette.size", b.doc.palette.length, 4);
  eq("aitools.behave.palette.add-fg", (await callTool("palette_add", { color: "fg" }, bk.ctx)).data, { index: 4, size: 5 });
  eq("aitools.behave.palette.dedupe", (await callTool("palette_dedupe", {}, bk.ctx)).data, { removed: 0 });
  eq("aitools.behave.palette.merge", (await callTool("palette_merge", { colors: ["#010203", "#010203", "#0a0b0c"] }, bk.ctx)).data, { added: 1 });
  eq("aitools.behave.palette.remove-missing", (await callTool("palette_remove", { index: 99 }, bk.ctx)).ok, false);
  eq("aitools.behave.palette.remove-ok", (await callTool("palette_remove", { index: 0 }, bk.ctx)).ok, true);
  eq("aitools.behave.palette.from-canvas", (await callTool("palette_from_canvas", { max: 8 }, bk.ctx)).data, { count: 1 });
  eq("aitools.behave.palette.sort-ok", (await callTool("palette_sort", { mode: "hue" }, bk.ctx)).ok, true);
  eq("aitools.behave.palette.remap-ok", (await callTool("palette_remap", { scope: "canvas" }, bk.ctx)).ok, true);

  // 颜色分析 / 替换 / 选区
  const an = await callTool("color_analyse", { scope: "canvas" }, bk.ctx);
  ok("aitools.behave.color.analyse", Array.isArray((an.data as { entries: unknown[] }).entries));
  const grp = await callTool("color_groups", { scope: "canvas", tol: 12 }, bk.ctx);
  ok("aitools.behave.color.groups", Array.isArray(grp.data));
  ok("aitools.behave.color.ink-before", inkCount(b) > 0);
  const rep = await callTool("color_replace", { from: "#ff0000", to: "#0000ff", scope: "layer", tolerance: 0 }, bk.ctx);
  ok("aitools.behave.color.replace", (rep.data as { changed: number }).changed > 0, JSON.stringify(rep.data));
  const sel = await callTool("color_select", { color: "#0000ff", scope: "layer" }, bk.ctx);
  ok("aitools.behave.color.select", (sel.data as { pixels: number }).pixels > 0, JSON.stringify(sel.data));
  const merged = await callTool("color_merge_group", { rep: "#00ff00", colors: ["#0000ff"], scope: "layer" }, bk.ctx);
  ok("aitools.behave.color.merge", (merged.data as { changed: number }).changed > 0, JSON.stringify(merged.data));

  // 图层
  eq("aitools.behave.layer.add", (await callTool("layer_add", {}, bk.ctx)).data, { layers: 2 });
  eq("aitools.behave.layer.duplicate", (await callTool("layer_duplicate", {}, bk.ctx)).data, { layers: 3 });
  eq("aitools.behave.layer.up-blocked", (await callTool("layer_up", {}, bk.ctx)).ok, false);
  eq("aitools.behave.layer.select", (await callTool("layer_select", { li: 1 }, bk.ctx)).data, { li: 1 });
  eq("aitools.behave.layer.up", (await callTool("layer_up", {}, bk.ctx)).ok, true);
  eq("aitools.behave.layer.select-missing", (await callTool("layer_select", { li: 99 }, bk.ctx)).ok, false);
  eq("aitools.behave.layer.rename", (await callTool("layer_rename", { name: "线稿" }, bk.ctx)).ok, true);
  eq("aitools.behave.layer.opacity", (await callTool("layer_opacity", { opacity: 55 }, bk.ctx)).data, { li: 1, opacity: 55 });
  eq("aitools.behave.layer.blend-ok", (await callTool("layer_blend", { blend: "screen" }, bk.ctx)).ok, true);
  eq("aitools.behave.layer.blend-stored", b.doc.layers[1].blend, "screen");
  eq("aitools.behave.layer.lock", (await callTool("layer_toggle_lock", {}, bk.ctx)).ok, true);
  eq("aitools.behave.layer.locked", b.doc.layers[1].locked, true);
  eq("aitools.behave.layer.unlock", (await callTool("layer_toggle_lock", {}, bk.ctx)).ok, true);
  eq("aitools.behave.layer.solo", (await callTool("layer_toggle_solo", {}, bk.ctx)).ok, true);
  eq("aitools.behave.layer.unsolo", (await callTool("layer_toggle_solo", {}, bk.ctx)).ok, true);
  eq("aitools.behave.layer.visible-toggle", (await callTool("layer_toggle_visible", {}, bk.ctx)).ok, true);
  eq("aitools.behave.layer.move-to", (await callTool("layer_move_to", { from: 0, to: 2 }, bk.ctx)).ok, true);

  // 帧
  eq("aitools.behave.frame.add", (await callTool("frame_add", {}, bk.ctx)).data, { frames: 3, added: 1 });
  eq("aitools.behave.frame.duplicate", (await callTool("frame_duplicate", {}, bk.ctx)).ok, true);
  eq("aitools.behave.frame.duration", (await callTool("frame_duration", { fi: 0, ms: 250 }, bk.ctx)).data, { fi: 0, ms: 250 });
  b.history.clear();
  eq("aitools.behave.frame.select", (await callTool("frame_select", { fi: 1 }, bk.ctx)).data, { fi: 1 });
  eq("aitools.behave.frame.select-no-history", b.history.canUndo(), false);
  eq("aitools.behave.frame.move", (await callTool("frame_move", { direction: "next" }, bk.ctx)).ok, true);
  eq("aitools.behave.frame.move-to", (await callTool("frame_move_to", { from: 0, to: 2 }, bk.ctx)).ok, true);

  // 标签
  const t1 = await callTool("tag_add", { name: "走", from: 0, to: 1 }, bk.ctx);
  const tid = (t1.data as { id: string }).id;
  eq("aitools.behave.tag.add", t1.ok, true);
  eq("aitools.behave.tag.rename", (await callTool("tag_rename", { id: tid, name: "跑" }, bk.ctx)).data, { name: "跑" });
  eq("aitools.behave.tag.range", (await callTool("tag_set_range", { id: tid, from: 1, to: 2 }, bk.ctx)).data, { from: 1, to: 2 });
  const tagCol = await callTool("tag_set_color", { id: tid, color: "fg" }, bk.ctx);
  ok("aitools.behave.tag.color", typeof (tagCol.data as { color: string }).color === "string" && (tagCol.data as { color: string }).color[0] === "#", JSON.stringify(tagCol.data));
  eq("aitools.behave.tag.remove", (await callTool("tag_remove", { id: tid }, bk.ctx)).ok, true);
  eq("aitools.behave.tag.remove-again", (await callTool("tag_remove", { id: tid }, bk.ctx)).ok, false);

  // 撤销 / 重做
  const sHist = live();
  const hk = mkCtx(sHist, true);
  await callTool("palette_add", { color: "#0a0b0c" }, hk.ctx);
  eq("aitools.behave.undo.before", sHist.doc.palette.length, 4);
  eq("aitools.behave.undo.ok", (await callTool("undo", {}, hk.ctx)).ok, true);
  eq("aitools.behave.undo.after", sHist.doc.palette.length, 3);
  eq("aitools.behave.redo.ok", (await callTool("redo", {}, hk.ctx)).ok, true);
  eq("aitools.behave.redo.after", sHist.doc.palette.length, 4);
  sHist.history.clear();
  eq("aitools.behave.undo.empty", (await callTool("undo", {}, hk.ctx)).ok, false);
  eq("aitools.behave.redo.empty", (await callTool("redo", {}, hk.ctx)).ok, false);

  // 等距图形：参数 → 落点 → 生成（changed 矩形来自 Session.isoLast）
  const sIso = live();
  const ik = mkCtx(sIso, true);
  eq("aitools.behave.iso.set", (await callTool("iso_set", { shape: "box", w: 2, d: 2, h: 2, tile: "8" }, ik.ctx)).ok, true);
  eq("aitools.behave.iso.prefs", sIso.isoShape().shape, "box");
  eq("aitools.behave.iso.origin", (await callTool("iso_origin", { at: [16, 16] }, ik.ctx)).ok, true);
  const gen = await callTool("iso_generate", { target: "new" }, ik.ctx);
  eq("aitools.behave.iso.generate", gen.ok, true);
  ok("aitools.behave.iso.pixels", (gen.data as { pixels: number }).pixels > 0, JSON.stringify(gen.data));
  ok("aitools.behave.iso.changed", !!gen.changed && gen.changed.w > 0, JSON.stringify(gen.changed));
  eq("aitools.behave.iso.new-layer", sIso.doc.layers.length, 2);
  eq("aitools.behave.iso.patch-shape", (await callTool("iso_set", { shape: "wedge" }, ik.ctx)).ok, true);
  eq("aitools.behave.iso.patch-keeps-w", sIso.isoShape().w, 2);
  eq("aitools.behave.iso.patch-shape-value", sIso.isoShape().shape, "wedge");
  eq("aitools.behave.iso.bad-shape", (await callTool("iso_set", { shape: "sphere" }, ik.ctx)).ok, false);

  // 缩放
  const sBig = live();
  const gk = mkCtx(sBig, true);
  eq("aitools.behave.scale.ok", (await callTool("scale", { w: 128, h: 128, algo: "nearest", scope: "sprite" }, gk.ctx)).ok, true);
  eq("aitools.behave.scale.dims", [sBig.doc.w, sBig.doc.h], [128, 128]);
  eq("aitools.behave.scale.same-size", (await callTool("scale", { w: 128, h: 128 }, gk.ctx)).ok, false);
  eq("aitools.behave.scale.bad-scope", (await callTool("scale", { w: 8, h: 8, scope: "nope" }, gk.ctx)).ok, false);

  // set_tool（ui 档：默认不列，但显式调用仍然可以 —— 放行与否是 C3 服务层的开关）
  const sUi = live();
  const uk = mkCtx(sUi, true);
  eq("aitools.behave.set-tool", (await callTool("set_tool", { tool: "eraser" }, uk.ctx)).data, { tool: "eraser" });
  eq("aitools.behave.set-tool-flag", sUi.snapshot().tool, "eraser");
  eq("aitools.behave.set-tool-bad", (await callTool("set_tool", { tool: "spray" }, uk.ctx)).ok, false);

  // 新建的小画布也是合法会话（工具层不依赖 UI 状态）
  const sTiny = new Session();
  sTiny.addCanvas(new Doc(16, 16, "tiny"), { focus: true });
  const tinyKit = mkCtx(sTiny, true);
  eq("aitools.behave.tiny.doc", [sTiny.doc.w, sTiny.doc.h], [16, 16]);
  eq("aitools.behave.tiny.digest", (await callTool("doc_digest", {}, tinyKit.ctx)).ok, true);

  // ------------------------------------------------------------ 9. read 档：一个字节都不动
  // 「read 档跑不动任何写操作」在 C1 这一层的口径＝read 档的三个工具调完之后文档逐字节不变，
  // 而且它们**不触发确认**（确认是 destructive 档专属）。
  const sReadOnly = live();
  const roKit = mkCtx(sReadOnly, false);           // 确认回调一律拒绝：read 档根本不该问
  const roBefore = docBytes(sReadOnly);
  const RO_ARGS: Record<string, Args> = {
    doc_digest: {}, read_region: { rect: { x: 0, y: 0, w: 8, h: 8 }, fi: 0, li: 0 },
    color_analyse: { scope: "canvas" }, color_groups: { scope: "layer", tol: 8 },
  };
  const readIds = listTools({ tiers: ["read"] }).map((t) => t.id);
  eq("aitools.readtier.ids", readIds, ["color_analyse", "color_groups", "doc_digest", "read_region"]);
  for (const id of readIds) {
    ok("aitools.readtier.has-args." + id, !!RO_ARGS[id]);
    const r = await callTool(id, RO_ARGS[id] ?? {}, roKit.ctx);
    eq("aitools.readtier.ok." + id, r.ok, true);
  }
  eq("aitools.readtier.bytes", docBytes(sReadOnly), roBefore);
  eq("aitools.readtier.no-confirm", roKit.asked.length, 0);

  // ------------------------------------------------------------ 10. P1 像素级工具：真画完再读回
  // 每个工具都「调一次 → 用 read_region 把像素读回来」，验形状与颜色真的落到画布上；
  // 越界 / 矛盾的参数一律被拒且 reason 带允许范围，且**文档逐字节不变**。
  const P = live();                                 // 64x64，layer0/frame0 的 (0..3,0..3) 是 16 个红像素
  const pk = mkCtx(P, true);
  /** 读回 P 会话里的一格（本节大部分断言都用它） */
  const px = (x: number, y: number, li = 0, fi = 0): Promise<string | null> => readPx(pk, x, y, li, fi);

  // --- draw_path：折线笔迹（3 个点 → 两段线）---
  const dp = await callTool("draw_path", { points: [[10, 10], [19, 10], [19, 14]], tool: "pencil", size: 1, color: "#00ff00", layer: 0, frame: 0 }, pk.ctx);
  eq("aitools.draw.path.ok", dp.ok, true);
  eq("aitools.draw.path.changed-rect", dp.changed, { x: 10, y: 10, w: 10, h: 5 });
  eq("aitools.draw.path.head", await px(10, 10), "#00ff00");
  eq("aitools.draw.path.corner", await px(19, 10), "#00ff00");
  eq("aitools.draw.path.tail", await px(19, 14), "#00ff00");
  eq("aitools.draw.path.empty-before", await px(9, 10), null);
  eq("aitools.draw.path.empty-after", await px(19, 15), null);

  // --- draw_path：形状子集（line / rect / ellipse，只取首尾两点）---
  const dl = await callTool("draw_path", { points: [[10, 20], [19, 20]], tool: "line", size: 3, color: "#0000ff" }, pk.ctx);
  eq("aitools.draw.path.line.ok", dl.ok, true);
  eq("aitools.draw.path.line-px", await px(14, 20), "#0000ff");
  eq("aitools.draw.path.line-width", await px(14, 19), "#0000ff");       // size=3 → 上下各铺 1px
  const drect = await callTool("draw_path", { points: [[24, 20], [27, 23]], tool: "rect", fill: true, color: "#ff00ff" }, pk.ctx);
  eq("aitools.draw.path.rect.ok", drect.ok, true);
  eq("aitools.draw.path.rect-corner", await px(24, 20), "#ff00ff");
  eq("aitools.draw.path.rect-fill", await px(26, 22), "#ff00ff");
  eq("aitools.draw.path.rect-outside", await px(28, 20), null);

  // --- draw_shape：实心 / 空心 ---
  const ds = await callTool("draw_shape", { shape: "rect", from: [30, 30], to: [33, 32], fill: true, color: "#ff0000" }, pk.ctx);
  eq("aitools.shape.rect.ok", ds.ok, true);
  eq("aitools.shape.rect.filled", await px(31, 31), "#ff0000");
  const de = await callTool("draw_shape", { shape: "ellipse", from: [40, 40], to: [48, 48], fill: false, color: "#00ffff" }, pk.ctx);
  eq("aitools.shape.ellipse.ok", de.ok, true);
  eq("aitools.shape.ellipse.outline", await px(44, 40), "#00ffff");       // 椭圆顶边中点
  eq("aitools.shape.ellipse.hollow", await px(44, 44), null);             // 空心：中心必须是空的
  const def = await callTool("draw_shape", { shape: "ellipse", from: [40, 40], to: [48, 48], fill: true, color: "#00ffff" }, pk.ctx);
  eq("aitools.shape.ellipse.fill-ok", def.ok, true);
  eq("aitools.shape.ellipse.filled", await px(44, 44), "#00ffff");

  // --- fill：油漆桶（种子 / 容差 / 封口 / 渐变）---
  // 先给 (0,4) 放一个「几乎同色」的像素（ΔR=1），它是红块的 4 邻接邻居
  await callTool("draw_path", { points: [[0, 4]], tool: "pencil", color: "#fe0000" }, pk.ctx);
  const fl = await callTool("fill", { at: [0, 0], color: "#0000ff", tolerance: 0, gaps: 0, layer: 0, frame: 0 }, pk.ctx);
  eq("aitools.fill.ok", fl.ok, true);
  eq("aitools.fill.seed", await px(0, 0), "#0000ff");
  eq("aitools.fill.far-corner", await px(3, 3), "#0000ff");
  eq("aitools.fill.tolerance-zero-leaves-neighbour", await px(0, 4), "#fe0000");
  eq("aitools.fill.stops-at-colour-change", await px(4, 0), null);
  // 容差 2 时 ΔR=1 的邻居算同色 → 一起被填
  const sTol = live();
  const tlk = mkCtx(sTol, true);
  await callTool("draw_path", { points: [[0, 4]], tool: "pencil", color: "#fe0000" }, tlk.ctx);
  const flTol = await callTool("fill", { at: [0, 0], color: "#00ff00", tolerance: 2, gaps: 0 }, tlk.ctx);
  eq("aitools.fill.tolerance-ok", flTol.ok, true);
  eq("aitools.fill.tolerance-includes-neighbour", await readPx(tlk, 0, 4), "#00ff00");
  eq("aitools.fill.tolerance-block", await readPx(tlk, 3, 3), "#00ff00");
  // gaps 封口：能给、能跑（口径 0..16）
  const sGap = live();
  const gpk = mkCtx(sGap, true);
  const flGap = await callTool("fill", { at: [0, 20], color: "#123456", tolerance: 0, gaps: 2, layer: 0, frame: 0 }, gpk.ctx);
  eq("aitools.fill.gaps-ok", flGap.ok, true);
  eq("aitools.fill.gaps-px", await readPx(gpk, 0, 20), "#123456");
  // 渐变：从种子指向 gradientAt，两端分别是起止色（逐像素 ramp，b=1）
  const sGrad = live();
  const glk = mkCtx(sGrad, true);
  const flG = await callTool("fill", { at: [0, 40], color: "#ff0000", gradient: true, gradientTo: "#0000ff", gradientAt: [63, 40], layer: 0, frame: 0 }, glk.ctx);
  eq("aitools.fill.gradient-ok", flG.ok, true);
  eq("aitools.fill.gradient-start", await readPx(glk, 0, 40), "#ff0000");
  eq("aitools.fill.gradient-end", await readPx(glk, 63, 40), "#0000ff");
  ok("aitools.fill.gradient-mid", (await readPx(glk, 32, 40)) !== "#ff0000" && (await readPx(glk, 32, 40)) !== "#0000ff");

  // --- erase：矩形擦除（destructive，确认后执行）---
  const sEr = live();
  const ek = mkCtx(sEr, true);
  ok("aitools.erase.before-ink", (await readPx(ek, 0, 0)) !== null);
  const er = await callTool("erase", { rect: { x: 0, y: 0, w: 4, h: 4 }, layer: 0, frame: 0 }, ek.ctx);
  eq("aitools.erase.ok", er.ok, true);
  eq("aitools.erase.asked-once", ek.asked.length, 1);
  eq("aitools.erase.tier", ek.asked[0].tier, "destructive");
  eq("aitools.erase.bytes-after", inkCount(sEr), 0);
  eq("aitools.erase.cleared", await readPx(ek, 0, 0), null);
  eq("aitools.erase.keeps-outside", await readPx(ek, 5, 5), null);
  // 有选区时只擦选区里的部分：先画一个选区外的绿像素，擦 8x8 的区域，绿的必须活下来
  const sErSel = live();
  const esk = mkCtx(sErSel, true);
  await callTool("draw_shape", { shape: "rect", from: [6, 6], to: [6, 6], fill: true, color: "#00ff00" }, esk.ctx);
  await callTool("color_select", { color: "#ff0000", tolerance: 0, scope: "layer" }, esk.ctx);
  await callTool("erase", { rect: { x: 0, y: 0, w: 8, h: 8 }, layer: 0, frame: 0 }, esk.ctx);
  eq("aitools.erase.selection-inside-cleared", await readPx(esk, 0, 0), null);
  eq("aitools.erase.selection-outside-kept", await readPx(esk, 6, 6), "#00ff00");
  const sErNoSel = live();
  const ensk = mkCtx(sErNoSel, true);
  await callTool("erase", { rect: { x: 0, y: 0, w: 4, h: 4 }, layer: 0, frame: 0 }, ensk.ctx);
  eq("aitools.erase.no-selection-clears-all", inkCount(sErNoSel), 0);

  // --- transform：移动（整层 / 选区）+ 旋转 ---
  const sTf = live();
  const tk = mkCtx(sTf, true);
  const mv = await callTool("transform", { mode: "move", scope: "layer", dx: 10, dy: 0, layer: 0, frame: 0 }, tk.ctx);
  eq("aitools.transform.move.ok", mv.ok, true);
  eq("aitools.transform.move.asked", tk.asked.length, 1);
  eq("aitools.transform.move.old-spot-empty", await readPx(tk, 0, 0), null);
  eq("aitools.transform.move.new-spot", await readPx(tk, 10, 0), "#ff0000");
  eq("aitools.transform.move.rect", mv.changed, { x: 10, y: 0, w: 4, h: 4 });
  const rot = await callTool("transform", { mode: "rotate", scope: "layer", angle: 90, pivot: "cc", layer: 0, frame: 0 }, tk.ctx);
  eq("aitools.transform.rotate.ok", rot.ok, true);
  // 画布 64x64，枢轴 cc=(32,32)，顺时针 90°：(x,y) → (64-y, x)；方块 10..13 x 0..3 → 61..64 x 10..13（x=64 被裁）
  eq("aitools.transform.rotate.px", await readPx(tk, 61, 10), "#ff0000");
  eq("aitools.transform.rotate.old-spot-empty", await readPx(tk, 10, 0), null);
  // 选区分档：选区跟着内容走（doc_digest 的 sel 就是证据）
  const sTfSel = live();
  const tsk = mkCtx(sTfSel, true);
  await callTool("color_select", { color: "#ff0000", tolerance: 0, scope: "layer" }, tsk.ctx);
  const selDig0 = await callTool("doc_digest", {}, tsk.ctx);
  eq("aitools.transform.sel.pre-sel", (selDig0.data as { sel: unknown }).sel, { x: 0, y: 0, w: 4, h: 4, pixels: 16 });
  const smv = await callTool("transform", { mode: "move", scope: "selection", dx: 0, dy: 8, layer: 0, frame: 0 }, tsk.ctx);
  eq("aitools.transform.sel.ok", smv.ok, true);
  const selDig1 = await callTool("doc_digest", {}, tsk.ctx);
  eq("aitools.transform.sel.moved", (selDig1.data as { sel: unknown }).sel, { x: 0, y: 8, w: 4, h: 4, pixels: 16 });
  eq("aitools.transform.sel.px-moved", await readPx(tsk, 0, 8), "#ff0000");
  eq("aitools.transform.sel.old-empty", await readPx(tsk, 0, 0), null);

  // --- fx_*：8 个引擎既有特效（每个用一个干净会话，读回一个决定性像素）---
  const sFx1 = live();
  const fk1 = mkCtx(sFx1, true);
  const fxIn = await callTool("fx_invert", { scope: "layer", layer: 0, frame: 0 }, fk1.ctx);
  eq("aitools.fx.invert.ok", fxIn.ok, true);
  eq("aitools.fx.invert.px", await readPx(fk1, 0, 0), "#00ffff");                     // 红 → 青
  eq("aitools.fx.invert.keeps-transparent", await readPx(fk1, 10, 10), null);
  eq("aitools.fx.invert.changed-rect", fxIn.changed, { x: 0, y: 0, w: 4, h: 4 });

  const sFx2 = live();
  const fk2 = mkCtx(sFx2, true);
  const fxGray = await callTool("fx_gray", { scope: "layer", layer: 0, frame: 0 }, fk2.ctx);
  eq("aitools.fx.gray.ok", fxGray.ok, true);
  eq("aitools.fx.gray.px", await readPx(fk2, 0, 0), "#4c4c4c");                       // round(0.299*255) = 76 = 0x4c
  eq("aitools.fx.gray.keeps-transparent", await readPx(fk2, 10, 10), null);

  const sFx3 = live();
  const fk3 = mkCtx(sFx3, true);
  const fxOut = await callTool("fx_outline", { width: 1, pos: "outside", color: "#000000", scope: "layer", layer: 0, frame: 0 }, fk3.ctx);
  eq("aitools.fx.outline.ok", fxOut.ok, true);
  eq("aitools.fx.outline.ring", await readPx(fk3, 4, 0), "#000000");                  // 轮廓外 1px
  eq("aitools.fx.outline.keeps-fill", await readPx(fk3, 1, 1), "#ff0000");

  const sFx4 = live();
  const fk4 = mkCtx(sFx4, true);
  const fxInl = await callTool("fx_inline", { width: 1, alpha: 100, color: "#ffffff", scope: "layer", layer: 0, frame: 0 }, fk4.ctx);
  eq("aitools.fx.inline.ok", fxInl.ok, true);
  eq("aitools.fx.inline.inner", await readPx(fk4, 1, 1), "#ffffff");                  // 往里一圈变白
  eq("aitools.fx.inline.outer-ring-kept", await readPx(fk4, 0, 0), "#ff0000");        // 最外圈原色保留

  const sFx5 = live();
  const fk5 = mkCtx(sFx5, true);
  const fxSh = await callTool("fx_shadow", { dx: 8, dy: 0, color: "#000000", alpha: 100, scope: "layer", layer: 0, frame: 0 }, fk5.ctx);
  eq("aitools.fx.shadow.ok", fxSh.ok, true);
  eq("aitools.fx.shadow.copy", await readPx(fk5, 10, 1), "#000000");
  eq("aitools.fx.shadow.original-kept", await readPx(fk5, 1, 1), "#ff0000");

  const sFx6 = live();
  const fk6 = mkCtx(sFx6, true);
  const fxGl = await callTool("fx_glow", { radius: 1, color: "#ffffff", scope: "layer", layer: 0, frame: 0 }, fk6.ctx);
  eq("aitools.fx.glow.ok", fxGl.ok, true);
  eq("aitools.fx.glow.ring", await readPx(fk6, 4, 0), "#ffffff80");                   // 255*1/(1+1) = 128
  eq("aitools.fx.glow.original-kept", await readPx(fk6, 0, 0), "#ff0000");

  const sFx7 = live();
  const fk7 = mkCtx(sFx7, true);
  const fxBl = await callTool("fx_blur", { radius: 1, scope: "layer", layer: 0, frame: 0 }, fk7.ctx);
  eq("aitools.fx.blur.ok", fxBl.ok, true);
  const blurEdge = await readPx(fk7, 3, 1);
  ok("aitools.fx.blur.edge-semi", blurEdge !== null && blurEdge.length === 9 && blurEdge.indexOf("#ff00") === 0, String(blurEdge));

  // 圆角化要一块够厚的形状（细线 / 小方块会被刻意跳过，见 effects.roundCornersCel）
  const sFx8 = live();
  const fk8 = mkCtx(sFx8, true);
  await callTool("draw_shape", { shape: "rect", from: [20, 20], to: [27, 27], fill: true, color: "#ff0000" }, fk8.ctx);
  const fxRd = await callTool("fx_round", { radius: 1, mode: "outer", scope: "layer", layer: 0, frame: 0 }, fk8.ctx);
  eq("aitools.fx.round.ok", fxRd.ok, true);
  eq("aitools.fx.round.corner-cut", await readPx(fk8, 20, 20), null);
  eq("aitools.fx.round.edge-kept", await readPx(fk8, 21, 20), "#ff0000");

  // 空图层 / 无差异：一个字节都不动，也不压历史（changed:false 不是失败）
  const sFx9 = live();
  const fk9 = mkCtx(sFx9, true);
  sFx9.history.clear();
  const fxNoop = await callTool("fx_invert", { scope: "layer", layer: 0, frame: 1 }, fk9.ctx);
  eq("aitools.fx.noop.ok", fxNoop.ok, true);
  eq("aitools.fx.noop.changed", (fxNoop.data as { changed: boolean }).changed, false);
  eq("aitools.fx.noop.no-history", sFx9.history.canUndo(), false);

  // 选区分档：只有选区里的像素能被特效改到
  const sFxSel = live();
  const fsk = mkCtx(sFxSel, true);
  await callTool("draw_shape", { shape: "rect", from: [20, 20], to: [23, 23], fill: true, color: "#00ff00" }, fsk.ctx);
  await callTool("color_select", { color: "#ff0000", tolerance: 0, scope: "layer" }, fsk.ctx);
  const fxSel = await callTool("fx_invert", { scope: "selection", layer: 0, frame: 0 }, fsk.ctx);
  eq("aitools.fx.selection.ok", fxSel.ok, true);
  eq("aitools.fx.selection.changed-rect", fxSel.changed, { x: 0, y: 0, w: 4, h: 4 });
  eq("aitools.fx.selection.inside", await readPx(fsk, 0, 0), "#00ffff");              // 选区内的红 → 青
  eq("aitools.fx.selection.outside-kept", await readPx(fsk, 20, 20), "#00ff00");      // 选区外的绿一个字节没动
  eq("aitools.fx.selection.outside-transparent", await readPx(fsk, 30, 30), null);

  // --- 非法参数：拒绝 + reason 带范围 + 文档逐字节不变 ---
  const sBad2 = live();
  const bk2 = mkCtx(sBad2, true);
  const badBefore2 = docBytes(sBad2);
  const badCases: Array<[string, Args, string]> = [
    ["draw_path", { points: [{ nope: 1 }] as unknown as number[][], tool: "pencil" }, "期望 [x,y]"],
    ["draw_path", { points: [[0, 0]], size: 0 }, "小于最小值 1"],
    ["draw_path", { points: [[0, 0]], size: 65 }, "大于最大值 64"],
    ["draw_path", { points: new Array(4097).fill([0, 0]), tool: "pencil" }, "大于允许的 1..4096"],
    ["draw_path", { points: [[1, 1], [5, 5], [9, 9]], tool: "line" }, "恰好 2 个点"],
    ["draw_path", { points: [[1, 1], [5, 5]], tool: "bucket" }, "恰好 1 个点"],
    ["draw_shape", { shape: "circle", from: [1, 1], to: [4, 4] }, "不在"],
    ["draw_shape", { shape: "rect", from: [1, 1], to: [4, 4], fill: "yes" }, "期望 true/false"],
    ["fill", { at: [999, 0] }, "必须在画布内"],
    ["fill", { at: [0, 0], tolerance: 256 }, "大于最大值 255"],
    ["fill", { at: [0, 0], gaps: 17 }, "大于最大值 16"],
    ["fill", { at: [0, 0], gradientAt: [3, 3] }, "只在 gradient=true 时有意义"],
    ["erase", { rect: { x: 0, y: 0, w: 0, h: 4 } }, "必须 ≥1"],
    ["erase", { rect: { x: 0, y: 0, w: 4, h: 4, z: 1 } }, "未知字段 z"],
    ["transform", { mode: "skew" }, "不在"],
    ["transform", { mode: "move", dx: 1, sx: 2 }, "mode=move 只接受 dx / dy"],
    ["transform", { mode: "rotate", angle: 90, dy: 2 }, "mode=rotate 只接受 angle"],
    ["transform", { mode: "scale", sx: 0 }, "绝对值允许 0.02..40"],
    ["transform", { mode: "scale", sx: 0.01 }, "绝对值允许 0.02..40"],
    ["transform", { mode: "scale", sx: 100 }, "大于最大值 40"],
    ["transform", { mode: "move", scope: "selection", dx: 2 }, "需要先建立选区"],
    ["fx_outline", { width: 0 }, "小于最小值 1"],
    ["fx_outline", { width: 1, pos: "middle" }, "不在"],
    ["fx_blur", { radius: 33 }, "大于最大值 32"],
    ["fx_invert", { scope: "selection" }, "需要先建立选区"],
    ["fx_gray", { scope: "both" }, "不在"],
  ];
  for (let i = 0; i < badCases.length; i++) {
    const [id, args, needle] = badCases[i];
    const r = await callTool(id, args, bk2.ctx);
    eq("aitools.bad." + i + ".tool", id, id);
    eq("aitools.bad." + i + ".rejected", r.ok, false);
    ok("aitools.bad." + i + ".reason." + id, (r.error ?? "").indexOf(needle) >= 0, JSON.stringify([id, args, r.error]).slice(0, 220) );
  }
  eq("aitools.bad.doc-untouched", docBytes(sBad2), badBefore2);
  // callTool 的顺序是死的：参数级拒绝**完全不确认**；handler 级拒绝发生在确认之后
  // （destructive 档先问再执行），所以这几条 erase / transform 会先弹一次确认框。
  eq("aitools.bad.confirms-only-after-valid-args", bk2.asked.map((r) => r.tool),
    ["erase", "transform", "transform", "transform", "transform", "transform"]);
}
