// P1 回归：像素级绘制适配层（src/app/ai-draw.ts）。
//
// 这一份盯的是「适配层不许自己造写入路径」那件事，外加几条只有在这一层才测得准的口径：
//   · 静态扫源文件：每一次 `s.<方法>(` 都必须是 Session 上已有的方法（与 ai-tools.test.ts
//     对 ai-tools.ts 用的是同一条规则）；≥10 处调用的落点（Session 方法 / engine 导出 /
//     tools 导出）逐个断言真的存在；
//   · `Stroke` / `selOps` 这两个既有写入通道之外的「直接改文档结构」一个都不许有；
//   · 对称档（off/h/v/both/4）到引擎 (on, four, angDeg) 的收敛；
//   · 特效：先试跑再落笔 —— 没有差异时**不压历史、不动一个字节**；选区分档不外溢；
//   · 变换：单位变换不压历史；内容被推出画布时什么都不做（文档逐字节不变）；
//     90° 旋转走像素精确通道（逐字节搬，不插值）；整层范围不改动用户的选区。
import { Doc, Sel } from "../src/engine/doc";
import { Session } from "../src/app/session";
import {
  AI_FX_SCOPES, AI_PIVOTS, AI_SCALE_MAX, AI_SCALE_MIN, AI_SHAPE_KINDS, AI_STROKE_KINDS, AI_SYMS,
  AI_XFORM_MODES, AI_XFORM_SCOPES, applyFx, runStroke, runTransform, symSpecOf,
} from "../src/app/ai-draw";
import * as fxE from "../src/engine/effects";
import { beginMove, selOps, xformAffineDestBox, xformAffineFloating } from "../src/tools/select";
import { PIVOT_PRESETS, XF_LABEL, affineFrom, clampScale, contentBox, normAngle, pivotPresetPoint, snapCleanAngle } from "../src/tools/xform";
import { Stroke } from "../src/tools/stroke";
import { brushStamp, floodRegion, gradientFillRegion, lineCells } from "../src/engine/paint";
import { ellipseFill, ellipseOutline } from "../src/engine/shape";
import { stubEnv } from "./session.test";
import { eq, ok } from "./common";

declare const require: (m: string) => any;
declare const __dirname: string;
const fs = require("fs");
const path = require("path");

function readFile(rel: string): string {
  // 编译到 <app>/tests/.ts-out/tests → 仓库根在三级之上
  return fs.readFileSync(path.resolve(__dirname, "../../..", rel), "utf8");
}

/** 一层有 16 个红像素的会话（64x64，layer0/frame0 的 (0..3,0..3)） */
function live(): Session {
  const s = new Session();
  s.doc.palette = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]];
  const cel = s.doc.ensureCel(0, 0);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) cel.setPixel(x, y, [255, 0, 0, 255]);
  s.history.clear();
  return s;
}

/** 直接读 cel 的一格（这一层测的是「落笔结果对不对」，读回路径由 ai-tools.test.ts 覆盖） */
function at(s: Session, x: number, y: number, li = 0, fi = 0): number[] | null {
  const cel = s.doc.celAt(li, fi);
  if (!cel) return null;
  const i = cel.idx(x, y);
  return cel.data[i + 3] === 0 ? null : [cel.data[i], cel.data[i + 1], cel.data[i + 2], cel.data[i + 3]];
}

function celBytes(s: Session): string {
  const parts: string[] = [];
  for (const k of Array.from(s.doc.cels.keys()).sort()) parts.push(k + "=" + Array.from(s.doc.cels.get(k)!.data).join(","));
  return parts.join("|");
}

// ---------------------------------------------------------------- 裸缓冲写守卫（t14）
/**
 * ai-draw.ts 里**直接写像素缓冲**的语句（`cel.data[p] = ...`、`const data = cel.data; data[o] = ...`
 * 这类）只允许出现在 `s.maskOp(...)` 的回调里 —— maskOp 是「一条历史 + repaintAll + changed」
 * 的唯一门面；回调外裸写＝绕过历史（一条 undo 盖不住那几笔）。
 *
 * 为什么不用一句 `src.indexOf("cel.data[") < 0` 当守卫：合法的**选区掩码回写**本身就在 maskOp
 * 里写 `cel.data[p] = trial[p]`，一刀切会把对的代码也拦掉。所以这里做「等价、但精确」的版本：
 * ① 先把注释抹成等长空格（注释里的大括号不会带偏配对，注释里提到的裸写也不会误报）；
 * ② 花括号配对找出每个 `maskOp(` 回调体的区间；③ 再看每条写入落在哪个区间里。
 */
const BUFFER_WRITE_RE = /(?:\bcel\.data|\b(?:data|d|dst|out|trial|buf))\[[^\]\n]*\]\s*[-+*/]?=(?!=)/g;

/** 行注释 / 块注释 → 等长空格（保长度，下标与原文一一对应） */
function blankComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src[i] === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") { out += " "; i++; }
      continue;
    }
    if (src[i] === "/" && src[i + 1] === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) { out += " "; i++; }
      out += "  ";
      i += 2;
      continue;
    }
    out += src[i];
    i++;
  }
  return out;
}

/** 每个 `maskOp(` 回调体的字符区间 `[首个 {, 配对的 }]` */
function maskOpRegions(src: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const re = /\bmaskOp\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const brace = src.indexOf("{", m.index);
    if (brace < 0) continue;
    let depth = 0, end = -1;
    for (let i = brace; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end > brace) out.push([brace, end]);
  }
  return out;
}

/** 源码里所有缓冲写入语句的起始下标（注释先抹掉，所以注释里的不算） */
function bufferWrites(src: string): number[] {
  const clean = blankComments(src);
  const out: number[] = [];
  const re = new RegExp(BUFFER_WRITE_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) out.push(m.index);
  return out;
}

/** 落在所有 maskOp 回调之外的缓冲写入（返回原文片段，便于定位） */
function bareWritesOutsideMaskOp(src: string): Array<{ at: number; snippet: string }> {
  const clean = blankComments(src);
  const regions = maskOpRegions(clean);
  const out: Array<{ at: number; snippet: string }> = [];
  for (const at of bufferWrites(src)) {
    if (regions.some(([a, b]) => at > a && at < b)) continue;
    out.push({ at, snippet: src.slice(at, at + 60) });
  }
  return out;
}

export function testAiDraw(): void {
  stubEnv();

  // ------------------------------------------------------------ 1. 静态：没有新增写入路径
  const src = readFile("src/app/ai-draw.ts");
  const proto = Session.prototype as unknown as Record<string, unknown>;
  const callRe = /\bs\.([A-Za-z_$][A-Za-z0-9_$]*)\(/g;
  const calls = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(src)) !== null) calls.add(m[1]);
  ok("aidraw.nowrite.scan-sane", calls.size >= 6, "session calls=" + calls.size);
  for (const name of Array.from(calls).sort()) {
    ok("aidraw.nowrite.session-method." + name, typeof proto[name] === "function", name);
  }
  // 适配层唯一的写入通道是 Stroke.commit / engine 特效函数 / selOps 浮动模型；
  // 直接改文档结构的写法一个都不许出现（与 ai-tools.test.ts 同一张清单）
  const forbidden = ["doc.cels.set(", "doc.cels.delete(", "doc.palette.push(", "doc.palette.splice(",
    "doc.layers.push(", "doc.frames.push(", "doc.tags.push(", "doc.layers.splice(",
    "history.record(", "history.pushPixels(", "history.pushStruct("];
  forbidden.forEach((bad, i) => ok("aidraw.nowrite.no-direct-write." + i, src.indexOf(bad) < 0, bad));
  ok("aidraw.nowrite.no-import-history", src.indexOf('from "../engine/history"') < 0);

  // 裸缓冲写守卫（t14）：`cel.data[...] = ...` 这类写入只允许出现在 maskOp 回调里。
  // （不能用一句 `src.indexOf("cel.data[") < 0` —— maskOps 内的**选区掩码回写**本来就那样写。）
  const cleanSrc = blankComments(src);
  const regions = maskOpRegions(cleanSrc);
  const writes = bufferWrites(src);
  const outside = bareWritesOutsideMaskOp(src);
  ok("aidraw.nowrite.bare.guard-sane",
    regions.length >= 1 && regions.length === (cleanSrc.match(/\bmaskOp\s*\(/g) ?? []).length,
    "maskOp regions=" + regions.length);
  eq("aidraw.nowrite.bare.writes-counted", writes.length, 8);
  eq("aidraw.nowrite.bare.no-write-outside-maskop", outside.map((v) => v.snippet), []);
  // 守卫自检：合成源码里，回调**内**的写入放过、回调**外**的写入必须被抓住
  const GUARD_BAD = [
    "function f(s: S, cel: C, trial: U) {",
    "  s.maskOp(\"t\", () => { cel.data[0] = trial[0]; });",
    "  cel.data[4] = 7;                  // 裸写：回调外面",
    "}",
  ].join("\n");
  const GUARD_GOOD = [
    "function f(s: S, cel: C, trial: U) {",
    "  s.maskOp(\"t\", () => { cel.data[0] = trial[0]; });",
    "  s.maskOp(\"t2\", () => {",
    "    const data = cel.data;",
    "    for (const o of [0, 4]) data[o] = trial[o];",
    "  });",
    "}",
  ].join("\n");
  const badHits = bareWritesOutsideMaskOp(GUARD_BAD);
  eq("aidraw.nowrite.bare.selftest-bad-hits", badHits.length, 1);
  ok("aidraw.nowrite.bare.selftest-bad-snippet", !!badHits[0] && badHits[0].snippet.indexOf("cel.data[4]") === 0,
    badHits.length ? badHits[0].snippet : "(no hit)");
  eq("aidraw.nowrite.bare.selftest-good-hits", bareWritesOutsideMaskOp(GUARD_GOOD).length, 0);
  eq("aidraw.nowrite.bare.selftest-good-writes", bufferWrites(GUARD_GOOD).length, 2);

  // 抽查：适配层用到的每一个落点都真的存在（Session.prototype 或 engine / tools 导出）
  const CEL: Record<string, Record<string, unknown>> = {
    Session: proto,
    Stroke: Stroke.prototype as unknown as Record<string, unknown>,
    effects: fxE as unknown as Record<string, unknown>,
    select: { beginMove, selOps, xformAffineDestBox, xformAffineFloating } as unknown as Record<string, unknown>,
    xform: { PIVOT_PRESETS, XF_LABEL, affineFrom, clampScale, contentBox, normAngle, pivotPresetPoint, snapCleanAngle } as unknown as Record<string, unknown>,
    paint: { brushStamp, floodRegion, gradientFillRegion, lineCells } as unknown as Record<string, unknown>,
    shape: { ellipseFill, ellipseOutline } as unknown as Record<string, unknown>,
    doc: { Doc, Sel } as unknown as Record<string, unknown>,
  };
  const USES: Array<[string, string, "method" | "value"]> = [
    ["Session", "maskOp", "method"],
    ["Session", "repaint", "method"],
    ["Session", "changedUI", "method"],
    ["Session", "brush", "method"],
    ["Session", "paletteSnap", "method"],
    ["Session", "strokeTarget", "method"],
    ["Session", "refPaintBlock", "method"],
    // Stroke 的写入通道（AI 笔迹 / 形状 / 填充 / 擦除全靠这几条）
    ["Stroke", "startAt", "method"],
    ["Stroke", "moveTo", "method"],
    ["Stroke", "commit", "method"],
    ["Stroke", "takeDirty", "method"],
    ["Stroke", "setGeometry", "method"],
    // engine/effects.ts 的 8 个特效
    ["effects", "outlineCel", "value"],
    ["effects", "inlineCel", "value"],
    ["effects", "dropShadowCel", "value"],
    ["effects", "outerGlowCel", "value"],
    ["effects", "invertCel", "value"],
    ["effects", "desaturateCel", "value"],
    ["effects", "roundCornersCel", "value"],
    ["effects", "blurCel", "value"],
    // 浮动模型 + 纯仿射
    ["select", "beginMove", "value"],
    ["select", "selOps", "value"],
    ["select", "xformAffineFloating", "value"],
    ["select", "xformAffineDestBox", "value"],
    ["xform", "affineFrom", "value"],
    ["xform", "contentBox", "value"],
    ["xform", "pivotPresetPoint", "value"],
    ["xform", "snapCleanAngle", "value"],
    ["xform", "clampScale", "value"],
    ["xform", "PIVOT_PRESETS", "value"],
    ["xform", "XF_LABEL", "value"],
    ["paint", "brushStamp", "value"],
    ["paint", "floodRegion", "value"],
    ["paint", "gradientFillRegion", "value"],
    ["paint", "lineCells", "value"],
    ["shape", "ellipseFill", "value"],
    ["shape", "ellipseOutline", "value"],
    ["doc", "Doc", "value"],
    ["doc", "Sel", "value"],
  ];
  ok("aidraw.uses.sane", USES.length >= 10, "uses=" + USES.length);
  for (const [mod, name, kind] of USES) {
    const bag = CEL[mod];
    const got = bag ? typeof bag[name] : "undefined";
    ok("aidraw.uses." + mod + "." + name, kind === "method" ? got === "function" : got !== "undefined", mod + "." + name + " → " + got);
  }
  // 选区的落点必须是既有对象（不是副本）：selOps 的六个成员都在
  for (const k of ["floatCut", "floatPaste", "restore", "shiftMask", "move", "eraseSelected"]) {
    ok("aidraw.uses.select.selOps." + k, typeof (selOps as unknown as Record<string, unknown>)[k] === "function", k);
  }

  // ------------------------------------------------------------ 2. 对称档收敛
  eq("aidraw.sym.values", AI_SYMS.slice(), ["off", "h", "v", "both", "4"]);
  eq("aidraw.sym.off", symSpecOf("off"), { on: false, four: false, angDeg: 90 });
  eq("aidraw.sym.h", symSpecOf("h"), { on: true, four: false, angDeg: 0 });
  eq("aidraw.sym.v", symSpecOf("v"), { on: true, four: false, angDeg: 90 });
  eq("aidraw.sym.both", symSpecOf("both"), { on: true, four: true, angDeg: 90 });
  eq("aidraw.sym.four", symSpecOf("4"), { on: true, four: true, angDeg: 90 });
  eq("aidraw.sym.unknown", symSpecOf("nope"), { on: false, four: false, angDeg: 90 });
  // 档名与引擎口径对齐：h = 水平镜像线（上下对称）、v = 垂直镜像线（左右对称）
  const sSym = live();
  runStroke(sSym, {
    kind: "pencil", li: 0, fi: 0, size: 1, color: [0, 255, 0, 255], sym: "v",
    points: [[5, 5]], label: "t",
  });
  eq("aidraw.sym.v-draws", at(sSym, 5, 5), [0, 255, 0, 255]);
  eq("aidraw.sym.v-mirrors-x", at(sSym, 58, 5), [0, 255, 0, 255]);   // 64-1-5 = 58
  eq("aidraw.sym.v-keeps-y", at(sSym, 58, 6), null);
  const sSym4 = live();
  runStroke(sSym4, {
    kind: "pencil", li: 0, fi: 0, size: 1, color: [0, 255, 0, 255], sym: "4",
    points: [[5, 5]], label: "t",
  });
  eq("aidraw.sym.four-xy", at(sSym4, 58, 58), [0, 255, 0, 255]);
  // h = 水平镜像线 → 只翻 y（上下对称）
  const sSymH = live();
  runStroke(sSymH, {
    kind: "pencil", li: 0, fi: 0, size: 1, color: [0, 255, 0, 255], sym: "h",
    points: [[5, 5]], label: "t",
  });
  eq("aidraw.sym.h-mirrors-y", at(sSymH, 5, 58), [0, 255, 0, 255]);
  eq("aidraw.sym.h-keeps-x", at(sSymH, 58, 5), null);

  // ------------------------------------------------------------ 3. Stroke 适配
  eq("aidraw.kinds.stroke", AI_STROKE_KINDS.slice(), ["pencil", "eraser", "line", "rect", "ellipse", "bucket"]);
  eq("aidraw.kinds.shape", AI_SHAPE_KINDS.slice(), ["line", "rect", "ellipse"]);

  const sLock = live();
  sLock.doc.layers[0].locked = true;
  const lockedBefore = celBytes(sLock);
  const rLock = runStroke(sLock, { kind: "pencil", li: 0, fi: 0, size: 1, color: [255, 255, 255, 255], sym: "off", points: [[8, 8]], label: "t" });
  eq("aidraw.stroke.locked.ok", rLock.changed, false);
  ok("aidraw.stroke.locked.reason", (rLock.error ?? "").indexOf("锁定") >= 0, String(rLock.error));
  eq("aidraw.stroke.locked.bytes", celBytes(sLock), lockedBefore);

  const sBad = live();
  ok("aidraw.stroke.bad-layer", (runStroke(sBad, { kind: "pencil", li: 9, fi: 0, size: 1, color: [1, 1, 1, 255], sym: "off", points: [[1, 1]], label: "t" }).error ?? "").indexOf("图层下标 9") >= 0);
  ok("aidraw.stroke.bad-frame", (runStroke(sBad, { kind: "pencil", li: 0, fi: 9, size: 1, color: [1, 1, 1, 255], sym: "off", points: [[1, 1]], label: "t" }).error ?? "").indexOf("帧下标 9") >= 0);

  // 橡皮（alpha=0）：只擦不画
  const sEr = live();
  const rEr = runStroke(sEr, { kind: "rect", li: 0, fi: 0, size: 1, color: [0, 0, 0, 0], sym: "off", shapeFill: true, points: [[1, 1], [2, 2]], label: "t" });
  eq("aidraw.stroke.erase.changed", rEr.changed, true);
  eq("aidraw.stroke.erase.bit", at(sEr, 1, 1), null);
  eq("aidraw.stroke.erase.kept-outside", at(sEr, 0, 0), [255, 0, 0, 255]);
  eq("aidraw.stroke.erase.rect", rEr.rect, { x: 1, y: 1, w: 2, h: 2 });
  // 一条历史 + 一次 undo 逐字节还原
  const beforeEr = celBytes(live());
  sEr.undo();
  eq("aidraw.stroke.erase.undo", celBytes(sEr), beforeEr);

  // 没有真实改动 → 不压历史（画在已经同色的地方）
  const sNoop = live();
  sNoop.history.clear();
  const rNoop = runStroke(sNoop, { kind: "pencil", li: 0, fi: 0, size: 1, color: [255, 0, 0, 255], sym: "off", points: [[0, 0]], label: "t" });
  eq("aidraw.stroke.noop.changed", rNoop.changed, false);
  eq("aidraw.stroke.noop.no-history", sNoop.history.canUndo(), false);

  // 油漆桶：种子 / 容差 / 封口参数直接落到 Stroke
  const sFill = live();
  const rFill = runStroke(sFill, {
    kind: "bucket", li: 0, fi: 0, size: 1, color: [0, 0, 255, 255], sym: "off",
    fillTolerance: 0, fillGaps: 0, bucketGlobal: false, points: [[0, 0]], label: "t",
  });
  eq("aidraw.stroke.bucket.changed", rFill.changed, true);
  eq("aidraw.stroke.bucket.px", at(sFill, 3, 3), [0, 0, 255, 255]);
  eq("aidraw.stroke.bucket.stops", at(sFill, 4, 0), null);

  // 渐变没给轴：引擎默认按**区域包围盒自上而下**（起点色在区域顶、终点色在区域底）
  const sGrad = new Session();
  sGrad.doc.ensureCel(0, 0);
  const rGrad = runStroke(sGrad, {
    kind: "bucket", li: 0, fi: 0, size: 1, color: [255, 0, 0, 255], sym: "off",
    gradient: { end: [0, 0, 255, 255], block: 1 }, gradientTo: null, points: [[0, 0]], label: "t",
  });
  eq("aidraw.stroke.gradient.changed", rGrad.changed, true);
  eq("aidraw.stroke.gradient.top", at(sGrad, 0, 0), [255, 0, 0, 255]);
  eq("aidraw.stroke.gradient.bottom", at(sGrad, 0, 63), [0, 0, 255, 255]);

  // ------------------------------------------------------------ 4. 特效：先试跑再落笔
  eq("aidraw.fx.scopes", AI_FX_SCOPES.slice(), ["layer", "selection"]);
  const sFx = live();
  sFx.history.clear();
  const rInv = applyFx(sFx, "t-invert", (d) => fxE.invertCel(d), { li: 0, fi: 0, scope: "layer" });
  eq("aidraw.fx.invert.changed", rInv.changed, true);
  eq("aidraw.fx.invert.pixels", rInv.pixels, 16);
  eq("aidraw.fx.invert.rect", rInv.rect, { x: 0, y: 0, w: 4, h: 4 });
  eq("aidraw.fx.invert.px", at(sFx, 0, 0), [0, 255, 255, 255]);
  eq("aidraw.fx.invert.history", sFx.history.canUndo(), true);
  sFx.undo();
  eq("aidraw.fx.invert.undo", at(sFx, 0, 0), [255, 0, 0, 255]);

  // 没有差异：一个字节不动、也不压历史
  const sFxNo = live();
  sFxNo.history.clear();
  const noBytes = celBytes(sFxNo);
  const rNo = applyFx(sFxNo, "t-none", () => undefined, { li: 0, fi: 0, scope: "layer" });
  eq("aidraw.fx.noop.changed", rNo.changed, false);
  eq("aidraw.fx.noop.pixels", rNo.pixels, 0);
  eq("aidraw.fx.noop.bytes", celBytes(sFxNo), noBytes);
  eq("aidraw.fx.noop.no-history", sFxNo.history.canUndo(), false);

  // 选区分档：只改选区里的像素（选区外的那块绿一个字节都不动）
  const sFxSel = live();
  const gcel = sFxSel.doc.ensureCel(0, 0);
  for (let y = 20; y < 24; y++) for (let x = 20; x < 24; x++) gcel.setPixel(x, y, [0, 255, 0, 255]);
  sFxSel.doc.sel = new Sel(64, 64, false);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) sFxSel.doc.sel.set(x, y, 1);
  sFxSel.history.clear();
  const rSel = applyFx(sFxSel, "t-sel", (d) => fxE.invertCel(d), { li: 0, fi: 0, scope: "selection" });
  eq("aidraw.fx.sel.ok", rSel.changed, true);
  eq("aidraw.fx.sel.rect", rSel.rect, { x: 0, y: 0, w: 4, h: 4 });
  eq("aidraw.fx.sel.inside", at(sFxSel, 0, 0), [0, 255, 255, 255]);
  eq("aidraw.fx.sel.outside-kept", at(sFxSel, 20, 20), [0, 255, 0, 255]);

  // 选区分档但没有选区 → 明确拒绝（不静默退回整层）
  const sFxNoSel = live();
  const rNoSel = applyFx(sFxNoSel, "t", (d) => fxE.invertCel(d), { li: 0, fi: 0, scope: "selection" });
  eq("aidraw.fx.sel-missing.changed", rNoSel.changed, false);
  ok("aidraw.fx.sel-missing.reason", (rNoSel.error ?? "").indexOf("需要先建立选区") >= 0, String(rNoSel.error));

  const sFxLock = live();
  sFxLock.doc.layers[0].locked = true;
  ok("aidraw.fx.locked.reason", (applyFx(sFxLock, "t", (d) => fxE.invertCel(d), { li: 0, fi: 0, scope: "layer" }).error ?? "").indexOf("锁定") >= 0);
  ok("aidraw.fx.bad-layer.reason", (applyFx(sFxLock, "t", (d) => fxE.invertCel(d), { li: 7, fi: 0, scope: "layer" }).error ?? "").indexOf("图层下标 7") >= 0);
  // 空 cel / 连 cel 都没有：不是失败，只是没有可处理的内容
  const sFxEmpty = new Session();
  sFxEmpty.doc.ensureCel(0, 0);
  const rEmpty = applyFx(sFxEmpty, "t", (d) => fxE.invertCel(d), { li: 0, fi: 0, scope: "layer" });
  eq("aidraw.fx.empty.changed", rEmpty.changed, false);
  eq("aidraw.fx.empty.error", rEmpty.error, undefined);
  const sNoCel = new Session();
  const rNoCel = applyFx(sNoCel, "t", (d) => fxE.invertCel(d), { li: 0, fi: 0, scope: "layer" });
  eq("aidraw.fx.no-cel.changed", rNoCel.changed, false);
  eq("aidraw.fx.no-cel.error", rNoCel.error, undefined);

  // ------------------------------------------------------------ 5. 变换
  eq("aidraw.xform.modes", AI_XFORM_MODES.slice(), ["move", "scale", "rotate"]);
  eq("aidraw.xform.scopes", AI_XFORM_SCOPES.slice(), ["selection", "layer"]);
  eq("aidraw.xform.pivots", AI_PIVOTS.slice(), PIVOT_PRESETS.slice());
  eq("aidraw.xform.scale-range", [AI_SCALE_MIN, AI_SCALE_MAX], [0.02, 40]);

  // 单位变换：不压历史、不动字节
  const sId = live();
  sId.history.clear();
  const idBytes = celBytes(sId);
  for (const spec of [
    { mode: "move" as const, dx: 0, dy: 0 },
    { mode: "scale" as const, sx: 1, sy: 1 },
    { mode: "rotate" as const, angle: 0 },
  ]) {
    const r = runTransform(sId, {
      li: 0, fi: 0, mode: spec.mode, scope: "layer", dx: spec.dx ?? 0, dy: spec.dy ?? 0,
      sx: spec.sx ?? 1, sy: spec.sy ?? 1, angle: spec.angle ?? 0, snap: false, pivot: "cc",
    });
    eq("aidraw.xform.identity." + spec.mode, r.changed, false);
  }
  eq("aidraw.xform.identity.bytes", celBytes(sId), idBytes);
  eq("aidraw.xform.identity.no-history", sId.history.canUndo(), false);

  // 内容整个被推出画布：什么都不做（不落「把内容清空」的历史）
  const sOut = live();
  sOut.history.clear();
  const outBytes = celBytes(sOut);
  const rOut = runTransform(sOut, {
    li: 0, fi: 0, mode: "move", scope: "layer", dx: 1000, dy: 0, sx: 1, sy: 1, angle: 0, snap: false, pivot: "cc",
  });
  eq("aidraw.xform.offcanvas.changed", rOut.changed, false);
  eq("aidraw.xform.offcanvas.pixels", rOut.pixels, 0);
  eq("aidraw.xform.offcanvas.bytes", celBytes(sOut), outBytes);
  eq("aidraw.xform.offcanvas.no-history", sOut.history.canUndo(), false);
  eq("aidraw.xform.offcanvas.no-sel-leak", sOut.doc.sel, null);

  // 移动：整格平移、逐字节搬运（不重采样）
  const sMv = live();
  const rMv = runTransform(sMv, {
    li: 0, fi: 0, mode: "move", scope: "layer", dx: 3, dy: 2, sx: 1, sy: 1, angle: 0, snap: false, pivot: "cc",
  });
  eq("aidraw.xform.move.changed", rMv.changed, true);
  eq("aidraw.xform.move.rect", rMv.rect, { x: 3, y: 2, w: 4, h: 4 });
  eq("aidraw.xform.move.px", at(sMv, 3, 2), [255, 0, 0, 255]);
  eq("aidraw.xform.move.old-empty", at(sMv, 0, 0), null);

  // 90° 旋转：像素精确（逐字节搬，颜色不变）
  const sRot = live();
  const rcel = sRot.doc.ensureCel(0, 0);
  rcel.setPixel(30, 30, [255, 0, 0, 255]);
  rcel.setPixel(31, 30, [0, 255, 0, 255]);
  rcel.setPixel(30, 31, [0, 0, 255, 255]);
  rcel.setPixel(31, 31, [255, 255, 255, 255]);
  const rRot = runTransform(sRot, {
    li: 0, fi: 0, mode: "rotate", scope: "layer", dx: 0, dy: 0, sx: 1, sy: 1, angle: 90, snap: false, pivot: "cc",
  });
  eq("aidraw.xform.rotate.changed", rRot.changed, true);
  // 枢轴 = 画布正中 (32,32)；顺时针 90°：(x,y) → (64-y, x)
  eq("aidraw.xform.rotate.a", at(sRot, 33, 30), [255, 0, 0, 255]);     // (30,30) → (33,30)
  eq("aidraw.xform.rotate.b", at(sRot, 33, 31), [0, 255, 0, 255]);     // (31,30) → (33,31)
  eq("aidraw.xform.rotate.c", at(sRot, 32, 30), [0, 0, 255, 255]);     // (30,31) → (32,30)
  eq("aidraw.xform.rotate.d", at(sRot, 32, 31), [255, 255, 255, 255]); // (31,31) → (32,31)
  eq("aidraw.xform.rotate.old-empty", at(sRot, 30, 30), null);

  // 缩放 2×（枢轴＝内容左上角）：方块像素逐格翻倍 → 0..7 全是红
  const sSc = live();
  const rSc = runTransform(sSc, {
    li: 0, fi: 0, mode: "scale", scope: "layer", dx: 0, dy: 0, sx: 2, sy: 2, angle: 0, snap: false, pivot: "tl",
  });
  eq("aidraw.xform.scale.changed", rSc.changed, true);
  eq("aidraw.xform.scale.px", at(sSc, 0, 0), [255, 0, 0, 255]);
  eq("aidraw.xform.scale.edge", at(sSc, 7, 7), [255, 0, 0, 255]);
  eq("aidraw.xform.scale.outside", at(sSc, 8, 8), null);
  eq("aidraw.xform.scale.old-content-scaled", at(sSc, 3, 3), [255, 0, 0, 255]);
  // 绕正中放大时，左上角的内容会被整个推出画布 → 什么都不做（不是「把内容清空」）
  const sScCc = live();
  const rScCc = runTransform(sScCc, {
    li: 0, fi: 0, mode: "scale", scope: "layer", dx: 0, dy: 0, sx: 2, sy: 2, angle: 0, snap: false, pivot: "cc",
  });
  eq("aidraw.xform.scale.cc-off-canvas", rScCc.changed, false);
  eq("aidraw.xform.scale.cc-bytes", at(sScCc, 0, 0), [255, 0, 0, 255]);

  // 整层范围不该改动用户的选区
  const sKeepSel = live();
  sKeepSel.doc.sel = new Sel(64, 64, false);
  for (let y = 5; y < 8; y++) for (let x = 5; x < 8; x++) sKeepSel.doc.sel.set(x, y, 1);
  const selMaskBefore = Array.from(sKeepSel.doc.sel.mask).join("");
  runTransform(sKeepSel, {
    li: 0, fi: 0, mode: "move", scope: "layer", dx: 4, dy: 0, sx: 1, sy: 1, angle: 0, snap: false, pivot: "cc",
  });
  eq("aidraw.xform.layer-scope.keeps-sel", Array.from(sKeepSel.doc.sel!.mask).join(""), selMaskBefore);
  eq("aidraw.xform.layer-scope.sel-object", sKeepSel.doc.sel!.get(5, 5), 1);

  // 选区分档：只有选区里的内容被搬走，选区跟着内容走
  const sSel = live();
  sSel.doc.sel = new Sel(64, 64, false);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) sSel.doc.sel.set(x, y, 1);
  const rSelMv = runTransform(sSel, {
    li: 0, fi: 0, mode: "move", scope: "selection", dx: 0, dy: 10, sx: 1, sy: 1, angle: 0, snap: false, pivot: "cc",
  });
  eq("aidraw.xform.sel.changed", rSelMv.changed, true);
  eq("aidraw.xform.sel.rect", rSelMv.rect, { x: 0, y: 10, w: 2, h: 2 });
  eq("aidraw.xform.sel.moved", at(sSel, 0, 10), [255, 0, 0, 255]);
  eq("aidraw.xform.sel.old-empty", at(sSel, 0, 0), null);
  eq("aidraw.xform.sel.untouched-inside-block", at(sSel, 2, 2), [255, 0, 0, 255]);   // 选区外的红像素没动
  eq("aidraw.xform.sel.mask-moved", sSel.doc.sel!.get(0, 10), 1);
  eq("aidraw.xform.sel.mask-old-cleared", sSel.doc.sel!.get(0, 0), 0);

  // 错误路径
  const sErr = live();
  ok("aidraw.xform.bad-layer", (runTransform(sErr, { li: 3, fi: 0, mode: "move", scope: "layer", dx: 1, dy: 0, sx: 1, sy: 1, angle: 0, snap: false, pivot: "cc" }).error ?? "").indexOf("图层下标 3") >= 0);
  ok("aidraw.xform.bad-frame", (runTransform(sErr, { li: 0, fi: 3, mode: "move", scope: "layer", dx: 1, dy: 0, sx: 1, sy: 1, angle: 0, snap: false, pivot: "cc" }).error ?? "").indexOf("帧下标 3") >= 0);
  ok("aidraw.xform.sel-missing", (runTransform(sErr, { li: 0, fi: 0, mode: "move", scope: "selection", dx: 1, dy: 0, sx: 1, sy: 1, angle: 0, snap: false, pivot: "cc" }).error ?? "").indexOf("需要先建立选区") >= 0);
  const sEmptyCel = new Session();
  sEmptyCel.addCanvas(new Doc(8, 8, "empty"), { focus: true });
  ok("aidraw.xform.empty-cel", (runTransform(sEmptyCel, { li: 0, fi: 0, mode: "move", scope: "layer", dx: 1, dy: 0, sx: 1, sy: 1, angle: 0, snap: false, pivot: "cc" }).error ?? "").indexOf("是空的") >= 0);
  const sLock2 = live();
  sLock2.doc.layers[0].locked = true;
  ok("aidraw.xform.locked", (runTransform(sLock2, { li: 0, fi: 0, mode: "move", scope: "layer", dx: 1, dy: 0, sx: 1, sy: 1, angle: 0, snap: false, pivot: "cc" }).error ?? "").indexOf("锁定") >= 0);

  // 变换也走「一条历史」：一次 undo 逐字节回到原位
  const sUndo = live();
  const undoBefore = celBytes(sUndo);
  runTransform(sUndo, { li: 0, fi: 0, mode: "move", scope: "layer", dx: 5, dy: 5, sx: 1, sy: 1, angle: 0, snap: false, pivot: "cc" });
  eq("aidraw.xform.one-step.history", sUndo.history.canUndo(), true);
  sUndo.undo();
  eq("aidraw.xform.one-step.undo", celBytes(sUndo), undoBefore);

  // 小画布也成立（工具层不依赖 UI 状态 / 默认尺寸）
  const sTiny = new Session();
  sTiny.addCanvas(new Doc(8, 8, "tiny"), { focus: true });
  const rTiny = runStroke(sTiny, {
    kind: "pencil", li: 0, fi: 0, size: 1, color: [255, 255, 255, 255], sym: "off", points: [[1, 1], [6, 1]], label: "t",
  });
  eq("aidraw.tiny.changed", rTiny.changed, true);
  eq("aidraw.tiny.rect", rTiny.rect, { x: 1, y: 1, w: 6, h: 1 });
  eq("aidraw.tiny.px", at(sTiny, 6, 1), [255, 255, 255, 255]);
}
