// C0 回归：AI 文档文本化（src/app/ai-doc.ts）。
// 口径以 docs/PLAN-ai.md §3.2 / §5.1 为准；这里的断言是「不要改回去」的记录：
//   · 颜色身份 = RGBA（同 RGB 不同 alpha 两个索引）；
//   · 画到画布外 = 没画（changed 说真话），只有 size/tolerance/通道值会被钳制并记 clamped；
//   · 画同色 → applied 计入、changed 仍返回矩形，但 docRev 不前进；
//   · 空 ops 无论图层锁没锁都必须是 ok=true（「没有 op 可失败」不是失败）；
//   · cel 只在真要写像素时才建（全程落在画布外的 op 不留空 Cel）；
//   · readRegion 永不产出兆级字符串（maxPixels 默认 65536）。
import { Doc, Sel } from "../src/engine/doc";
import { Cel } from "../src/engine/cel";
import { Session } from "../src/app/session";
import { rgbaToHex } from "../src/engine/color";
import {
  AI_INDEX_ALPHABET, AI_MAX_REGION_PIXELS, applyOps, docDigest, readRegion,
} from "../src/app/ai-doc";
import type { AiApplyCtx, AiOp, AiSessionLike } from "../src/app/ai-doc";
import { eq, ok } from "./common";

const CTX: AiApplyCtx = { session: { fg: [10, 20, 30, 255], bg: [250, 251, 252, 255], li: 0, fi: 0 } };

/** 编译期形状断言（运行期零成本）：钉住「真实的 Session 能提供什么」。
 *
 *  **实测结论（t10 修复期用 tsc 验出来的）：`Session` 并不满足 `AiSessionLike`。**
 *  Session 上是 `fg` / `bg` / `doc` / `curLayer()` / `curFrame()`（session.ts:516/517/350/914/917），
 *  **没有 `li` / `fi` 这两个字段**（本文件早先误以为 session.ts:310-311 就是 Session 的字段，
 *  那两行其实属于 `CanvasEntry`）。所以 `AiApplyCtx.session: AiSessionLike` 与 PLAN §5.1
 *  「`ctx.session: Session`」之间需要一层适配：调用方（C1/C2）得把
 *  `{ fg, bg, li: curLayer(), fi: curFrame() }` 显式交给这一层。
 *
 *  这里不做 `= {} as Session` 的断言 —— 那会编译失败（TS2739），而且掩盖了上面这件事；
 *  改成断言「本层需要的四个字段都能从 Session 取到」，既能被 tsc 守住，也把适配需求写死在类型里。 */
export const _sessionShape: Pick<Session, "fg" | "bg"> & { li: number; fi: number } = {
  fg: [0, 0, 0, 255],
  bg: [255, 255, 255, 255],
  li: 0,
  fi: 0,
};

function alphaAt(c: Cel, x: number, y: number): number {
  return c.data[c.idx(x, y) + 3];
}
function rleDecode(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    let num = "";
    while (i < s.length && s[i] >= "0" && s[i] <= "9") { num += s[i]; i++; }
    const ch = s[i++];
    out += ch.repeat(num ? parseInt(num, 10) : 1);
  }
  return out;
}

/** 两个 hex 颜色（#rrggbb / #rrggbbaa）逐通道差是否都 ≤ tol：反乘允许 ±ceil(255/(2a)) */
function nearHex(a: string, b: string, tol: number): boolean {
  const ch = (h: string): number[] => {
    const s = h.replace("#", "");
    const t = s.length === 6 ? s + "ff" : s;
    return [0, 2, 4, 6].map((i) => parseInt(t.slice(i, i + 2), 16));
  };
  const x = ch(a), y = ch(b);
  return x.length === y.length && x.every((v, i) => Math.abs(v - y[i]) <= tol);
}

export function testAiDoc(): void {
  // ------------------------------------------------------------ docDigest
  const d = new Doc(8, 4, "t");
  d.palette = [[255, 0, 0, 255], [0, 255, 0, 255]];
  const cel = d.ensureCel(0, 0);
  cel.setPixel(1, 1, [255, 0, 0, 255]);
  cel.setPixel(2, 1, [255, 0, 0, 255]);
  cel.setPixel(2, 2, [0, 0, 255, 255]);
  const dig = docDigest(d);
  eq("aidoc.digest.dims", [dig.w, dig.h], [8, 4]);
  eq("aidoc.digest.rev", dig.docRev, d.pixelRev);
  eq("aidoc.digest.layers.count", dig.layers.length, 1);
  eq("aidoc.digest.layer.name", dig.layers[0].name, "Layer 1");
  eq("aidoc.digest.layer.visible", dig.layers[0].visible, true);
  eq("aidoc.digest.layer.locked", dig.layers[0].locked, false);
  eq("aidoc.digest.layer.opacity", dig.layers[0].opacity, 100);
  eq("aidoc.digest.frames.count", dig.frames.length, 1);
  eq("aidoc.digest.frame.ms", dig.frames[0].ms, 100);
  eq("aidoc.digest.frame.cels", dig.frames[0].cels, 1);
  eq("aidoc.digest.tags.empty", dig.tags, []);
  eq("aidoc.digest.palette", dig.palette, ["#ff0000", "#00ff00"]);
  eq("aidoc.digest.sel.none", dig.sel, null);
  eq("aidoc.digest.bbox", dig.bbox, { x: 1, y: 1, w: 2, h: 2 });
  eq("aidoc.digest.ink", dig.inkRatio, 0.094);
  ok("aidoc.digest.text.head", dig.text.indexOf("digest: 8x4") === 0);
  ok("aidoc.digest.text.one-line", dig.text.indexOf("\n") < 0);
  ok("aidoc.digest.text.rev", dig.text.indexOf("rev: 0") >= 0);
  ok("aidoc.digest.text.layers", dig.text.indexOf('layers: ["Layer 1"]') >= 0);
  ok("aidoc.digest.text.tags", dig.text.indexOf("tags: []") >= 0);
  ok("aidoc.digest.text.bbox", dig.text.indexOf("bbox: (1,1)-(2,2)") >= 0);
  ok("aidoc.digest.text.ink", dig.text.indexOf("ink: 0.094") >= 0);
  eq("aidoc.digest.tokens", dig.tokens, Math.ceil(dig.text.length / 3.5));

  const hidden = new Doc(4, 4, "h");
  hidden.ensureCel(0, 0).setPixel(0, 0, [255, 0, 0, 255]);
  hidden.layers[0].visible = false;
  eq("aidoc.digest.hidden.bbox", docDigest(hidden).bbox, null);
  eq("aidoc.digest.hidden.ink", docDigest(hidden).inkRatio, 0);
  ok("aidoc.digest.hidden.mark", docDigest(hidden).text.indexOf("(hidden)") >= 0);

  const faded = new Doc(4, 4, "o");
  faded.ensureCel(0, 0).setPixel(1, 1, [255, 0, 0, 255]);
  faded.layers[0].opacity = 0;
  eq("aidoc.digest.opacity0.bbox", docDigest(faded).bbox, null);

  const multi = new Doc(4, 4, "f");
  multi.ensureCel(0, 0).setPixel(0, 0, [1, 2, 3, 255]);
  multi.frames.push({ id: "f2", durationMs: 50 });
  multi.ensureCel(0, 1).setPixel(0, 0, [1, 2, 3, 255]);
  multi.ensureCel(0, 1).setPixel(1, 0, [1, 2, 3, 255]);
  multi.tags.push({ id: "t1", name: "idle", from: 0, to: 1 });
  const digMulti = docDigest(multi, { fi: 1 });
  eq("aidoc.digest.frame2.ms", digMulti.frames[1].ms, 50);
  eq("aidoc.digest.frame2.cels", digMulti.frames[1].cels, 1);
  eq("aidoc.digest.frames.count2", digMulti.frames.length, 2);
  eq("aidoc.digest.tags.one", digMulti.tags, [{ name: "idle", from: 0, to: 1 }]);
  ok("aidoc.digest.tags.text", digMulti.text.indexOf('{"idle",0,1}') >= 0);
  eq("aidoc.digest.fi.over-clamped", docDigest(multi, { fi: 99 }).text.indexOf("ink: " + docDigest(multi, { fi: 1 }).inkRatio.toFixed(3)) >= 0, true);

  multi.sel = new Sel(4, 4);
  multi.sel.set(1, 1, 1);
  multi.sel.set(2, 1, 1);
  const digSel = docDigest(multi);
  eq("aidoc.digest.sel.box", digSel.sel, { x: 1, y: 1, w: 2, h: 1, pixels: 2 });
  ok("aidoc.digest.sel.text", digSel.text.indexOf("sel: (1,1)+(2x1) 2px") >= 0);

  const countOnly = new Doc(3, 3, "c");
  countOnly.ensureCel(0, 0);
  eq("aidoc.digest.empty-cel.counted", docDigest(countOnly).frames[0].cels, 1);

  // 调色板里的半透明项 → "#rrggbbaa"（颜色身份 = RGBA 四通道，digest 与 region 同一口径）
  const digSemi = new Doc(2, 1, "ds");
  digSemi.palette = [[255, 0, 0, 255], [0, 0, 255, 128]];
  eq("aidoc.digest.palette.semi", docDigest(digSemi).palette, ["#ff0000", "#0000ff80"]);

  // ------------------------------------------------------------ readRegion
  function regionDoc(): Doc {
    const doc = new Doc(4, 3, "r");
    doc.palette = [[255, 0, 0, 255], [0, 255, 0, 255]];
    const c = doc.ensureCel(0, 0);
    c.setPixel(0, 0, [255, 0, 0, 255]);
    c.setPixel(1, 0, [255, 0, 0, 255]);
    c.setPixel(2, 0, [0, 255, 0, 255]);
    c.setPixel(0, 1, [0, 0, 255, 255]);
    return doc;
  }
  const rd = regionDoc();
  const rg = readRegion(rd, { x: 0, y: 0, w: 4, h: 2 });
  eq("aidoc.region.rows", rg.rows, ["aab.", "c..."]);
  eq("aidoc.region.palette", rg.palette, ["#ff0000", "#00ff00", "#0000ff"]);
  eq("aidoc.region.dims", [rg.x, rg.y, rg.w, rg.h, rg.fi, rg.li], [0, 0, 4, 2, 0, 0]);
  eq("aidoc.region.clipped", rg.clipped, false);
  eq("aidoc.region.tokens", rg.tokens, Math.ceil(rg.text.length / 3.5));
  ok("aidoc.region.text.head", rg.text.indexOf("region (x=0,y=0,w=4,h=2) @frame 0, layer 0:") === 0);
  ok("aidoc.region.text.palette", rg.text.indexOf("palette: a=#ff0000 b=#00ff00 c=#0000ff") >= 0);
  ok("aidoc.region.text.y0", rg.text.indexOf("y= 0 aab.") >= 0);
  ok("aidoc.region.text.y1", rg.text.indexOf("y= 1 c...") >= 0);
  ok("aidoc.region.no-clip-note", rg.text.indexOf("区域已被裁剪") < 0);
  eq("aidoc.alphabet.len", AI_INDEX_ALPHABET.length, 52);

  // 调色板顺序：先按文档调色板顺序取用到的子集，未命中的按首次出现顺序追加
  const po = new Doc(2, 1, "p");
  po.palette = [[0, 255, 0, 255], [255, 0, 0, 255]];
  po.ensureCel(0, 0).setPixel(0, 0, [255, 0, 0, 255]);
  po.ensureCel(0, 0).setPixel(1, 0, [0, 255, 0, 255]);
  const rgPo = readRegion(po, { x: 0, y: 0, w: 2, h: 1 });
  eq("aidoc.region.palette.doc-order", rgPo.palette, ["#00ff00", "#ff0000"]);
  eq("aidoc.region.rows.doc-order", rgPo.rows, ["ba"]);

  // 颜色身份 = RGBA：同 RGB 不同 alpha 是两个索引，alpha 能从 palette 读回
  const al = new Doc(2, 1, "al");
  al.ensureCel(0, 0).setPixel(0, 0, [255, 0, 0, 255]);
  al.ensureCel(0, 0).setPixel(1, 0, [255, 0, 0, 128]);
  const rgAl = readRegion(al, { x: 0, y: 0, w: 2, h: 1 });
  eq("aidoc.region.alpha.palette", rgAl.palette, ["#ff0000", "#ff000080"]);
  eq("aidoc.region.alpha.rows", rgAl.rows, ["ab"]);
  ok("aidoc.region.alpha.note", rgAl.text.indexOf("半透明") >= 0);

  // 裁剪 / 完全在外 / 零尺寸
  const rgClip = readRegion(rd, { x: -2, y: 0, w: 4, h: 2 });
  eq("aidoc.region.clip.origin", [rgClip.x, rgClip.y, rgClip.w, rgClip.h], [0, 0, 2, 2]);
  eq("aidoc.region.clip.flag", rgClip.clipped, true);
  ok("aidoc.region.clip.note", rgClip.text.indexOf("区域已被裁剪") >= 0);
  const rgOut = readRegion(rd, { x: 10, y: 10, w: 4, h: 4 });
  eq("aidoc.region.outside.rows", rgOut.rows, []);
  eq("aidoc.region.outside.palette", rgOut.palette, []);
  eq("aidoc.region.outside.clipped", rgOut.clipped, true);
  ok("aidoc.region.outside.text", rgOut.text.indexOf("完全在画布外") >= 0);
  // 完全在外时的 head 口径：字段 x/y 回显**请求**坐标、w=h=0，文本原样写出请求矩形，
  // 不假装读到了像素；x>0 与 x<0 两侧对称（早先 head 用裁剪后的 x0/y0，两种请求给出不同形状）
  eq("aidoc.region.outside.box", [rgOut.x, rgOut.y, rgOut.w, rgOut.h], [10, 10, 0, 0]);
  ok("aidoc.region.outside.head-right", rgOut.text.indexOf(
    "region requested (x=10,y=10,w=4,h=4) → 完全在画布外 @frame 0, layer 0:") >= 0);
  const rgOutNeg = readRegion(rd, { x: -10, y: -10, w: 4, h: 4 });
  eq("aidoc.region.outside.neg.box", [rgOutNeg.x, rgOutNeg.y, rgOutNeg.w, rgOutNeg.h], [-10, -10, 0, 0]);
  ok("aidoc.region.outside.head-left", rgOutNeg.text.indexOf(
    "region requested (x=-10,y=-10,w=4,h=4) → 完全在画布外 @frame 0, layer 0:") >= 0);
  const rgZero = readRegion(rd, { x: 0, y: 0, w: 0, h: 2 });
  eq("aidoc.region.zero.rows", rgZero.rows, []);
  ok("aidoc.region.zero.warn", rgZero.text.indexOf("宽或高为 0") >= 0);

  // li / fi 越界：回退 + warn（不静默）
  const rgIdx = readRegion(rd, { x: 0, y: 0, w: 1, h: 1 }, { fi: 7, li: 9 });
  eq("aidoc.region.idx.clamped", [rgIdx.fi, rgIdx.li], [0, 0]);
  ok("aidoc.region.idx.fi-warn", rgIdx.text.indexOf("warn: fi 7") >= 0);
  ok("aidoc.region.idx.li-warn", rgIdx.text.indexOf("warn: li 9") >= 0);

  // 没有 cel 的图层/帧：全 `.`、调色板为空
  const noCel = new Doc(2, 2, "e");
  const rgNo = readRegion(noCel, { x: 0, y: 0, w: 2, h: 2 });
  eq("aidoc.region.empty.rows", rgNo.rows, ["..", ".."]);
  eq("aidoc.region.empty.palette", rgNo.palette, []);
  eq("aidoc.region.empty.clipped", rgNo.clipped, false);

  // maxPixels：默认 65536，超出时保留左上角、整行保留、截断行数
  const big = new Doc(300, 300, "big");
  const rgBig = readRegion(big, { x: 0, y: 0, w: 300, h: 300 });
  ok("aidoc.region.maxpixels.budget", rgBig.w * rgBig.h <= AI_MAX_REGION_PIXELS);
  eq("aidoc.region.maxpixels.w", rgBig.w, 300);
  eq("aidoc.region.maxpixels.h", rgBig.h, 218);
  eq("aidoc.region.maxpixels.clipped", rgBig.clipped, true);
  ok("aidoc.region.maxpixels.note", rgBig.text.indexOf("maxPixels 65536") >= 0);
  const rgSmall = readRegion(big, { x: 0, y: 0, w: 300, h: 300 }, { maxPixels: 600 });
  eq("aidoc.region.maxpixels.custom", [rgSmall.w, rgSmall.h], [300, 2]);

  // RLE
  const rleDoc = new Doc(6, 1, "rle");
  const rleCel = rleDoc.ensureCel(0, 0);
  for (let x = 0; x < 3; x++) rleCel.setPixel(x, 0, [255, 0, 0, 255]);
  rleCel.setPixel(3, 0, [0, 255, 0, 255]);
  const rgRle = readRegion(rleDoc, { x: 0, y: 0, w: 6, h: 1 }, { rle: true });
  eq("aidoc.region.rle.rows", rgRle.rows, ["3ab2."]);
  ok("aidoc.region.rle.note", rgRle.text.indexOf("rle 开启") >= 0);
  eq("aidoc.region.rle.off-by-default", readRegion(rleDoc, { x: 0, y: 0, w: 6, h: 1 }).rows, ["aaab.."]);
  eq("aidoc.region.rle.roundtrip", rleDecode(rgRle.rows[0]), "aaab..");

  // > 52 色：定宽两位十六进制，RLE 自动关闭
  const wide = new Doc(53, 1, "wide");
  const wideCel = wide.ensureCel(0, 0);
  for (let x = 0; x < 53; x++) wideCel.setPixel(x, 0, [x, 0, 0, 255]);
  const rgWide = readRegion(wide, { x: 0, y: 0, w: 53, h: 1 }, { rle: true });
  eq("aidoc.region.wide.palette", rgWide.palette.length, 53);
  eq("aidoc.region.wide.cell-width", rgWide.rows[0].length, 53 * 2);
  ok("aidoc.region.wide.first", rgWide.rows[0].indexOf("00") === 0);
  ok("aidoc.region.wide.note", rgWide.text.indexOf("超过 52 色") >= 0);
  ok("aidoc.region.wide.rle-off", rgWide.text.indexOf("rle 开启") < 0);
  const n52 = new Doc(52, 1, "n52");
  const n52Cel = n52.ensureCel(0, 0);
  for (let x = 0; x < 52; x++) n52Cel.setPixel(x, 0, [x, 0, 0, 255]);
  const rgN52 = readRegion(n52, { x: 0, y: 0, w: 52, h: 1 });
  eq("aidoc.region.narrow52.len", rgN52.rows[0].length, 52);
  eq("aidoc.region.narrow52.palette", rgN52.palette.length, 52);
  eq("aidoc.region.narrow52.last", rgN52.rows[0].slice(-1), "Z");
  const decodeRow = (row: string, palette: string[]): string[] =>
    row.split("").map((ch) => (ch === "." ? "#00000000" : palette[AI_INDEX_ALPHABET.indexOf(ch)]));
  eq("aidoc.region.roundtrip.p00", decodeRow(rg.rows[0], rg.palette)[0], "#ff0000");
  eq("aidoc.region.roundtrip.p22", decodeRow(rg.rows[0], rg.palette)[2], "#00ff00");
  eq("aidoc.region.roundtrip.p30", decodeRow(rg.rows[1], rg.palette)[0], "#0000ff");
  eq("aidoc.region.roundtrip.transparent", decodeRow(rg.rows[0], rg.palette)[3], "#00000000");

  // ------------------------------------------------------------ applyOps
  const ap = new Doc(4, 4, "ap");
  const apEmpty = applyOps(ap, [], CTX);
  eq("aidoc.apply.empty.ok", apEmpty.ok, true);
  eq("aidoc.apply.empty.applied", apEmpty.applied, 0);
  eq("aidoc.apply.empty.changed", apEmpty.changed, null);
  eq("aidoc.apply.empty.rev", apEmpty.docRev, 0);
  eq("aidoc.apply.empty.no-cel", ap.celAt(0, 0), null);

  // 空 ops 与图层是否锁定无关：「没有 op 可失败」不是失败（PLAN-ai §5.1:351）
  const apLockEmpty = new Doc(2, 2, "lock-empty");
  apLockEmpty.layers[0].locked = true;
  const apLockEmptyRes = applyOps(apLockEmpty, [], CTX);
  eq("aidoc.apply.empty.locked-layer.ok", apLockEmptyRes.ok, true);
  eq("aidoc.apply.empty.locked-layer.applied", apLockEmptyRes.applied, 0);
  eq("aidoc.apply.empty.locked-layer.changed", apLockEmptyRes.changed, null);
  eq("aidoc.apply.empty.locked-layer.errors", apLockEmptyRes.errors, []);
  eq("aidoc.apply.empty.locked-layer.no-cel", apLockEmpty.celAt(0, 0), null);
  // 防回归：锁定 + **非空** ops 仍必须 ok=false + layer-locked + 零写入
  const apLockOp = applyOps(apLockEmpty, [{ op: "pixels", x: 0, y: 0, rgba: [255, 0, 0, 255] }], CTX);
  eq("aidoc.apply.empty.locked-op.ok", apLockOp.ok, false);
  eq("aidoc.apply.empty.locked-op.errors", apLockOp.errors, [{ index: 0, reason: "layer-locked" }]);
  eq("aidoc.apply.empty.locked-op.no-cel", apLockEmpty.celAt(0, 0), null);

  const apPix = applyOps(ap, [{ op: "pixels", x: 1, y: 2, rgba: [255, 0, 0, 255] }], CTX);
  eq("aidoc.apply.pixels.ok", apPix.ok, true);
  eq("aidoc.apply.pixels.applied", apPix.applied, 1);
  eq("aidoc.apply.pixels.changed", apPix.changed, { x: 1, y: 2, w: 1, h: 1 });
  eq("aidoc.apply.pixels.rev", apPix.docRev, 1);
  const apCel = ap.celAt(0, 0) as Cel;
  eq("aidoc.apply.pixels.bytes", [apCel.data[apCel.idx(1, 2)], alphaAt(apCel, 1, 2)], [255, 255]);

  const apSame = applyOps(ap, [{ op: "pixels", x: 1, y: 2, rgba: [255, 0, 0, 255] }], CTX);
  eq("aidoc.apply.same.applied", apSame.applied, 1);
  eq("aidoc.apply.same.changed", apSame.changed, { x: 1, y: 2, w: 1, h: 1 });
  eq("aidoc.apply.same.rev", apSame.docRev, 1);

  const line = new Doc(8, 8, "line");
  const apLine = applyOps(line, [{ op: "line", x0: 0, y0: 0, x1: 3, y1: 0, color: "#00ff00" }], CTX);
  eq("aidoc.apply.line.applied", apLine.applied, 1);
  eq("aidoc.apply.line.changed", apLine.changed, { x: 0, y: 0, w: 4, h: 1 });
  const lineCel = line.celAt(0, 0) as Cel;
  let linePixels = 0;
  for (let i = 3; i < lineCel.data.length; i += 4) if (lineCel.data[i]) linePixels++;
  eq("aidoc.apply.line.pixels", linePixels, 4);
  const apLine3 = applyOps(line, [{ op: "line", x0: 0, y0: 4, x1: 3, y1: 4, color: "#0000ff", size: 3 }], CTX);
  eq("aidoc.apply.line.size.changed", apLine3.changed, { x: 0, y: 3, w: 5, h: 3 });
  const apBig = applyOps(line, [{ op: "line", x0: 0, y0: 6, x1: 0, y1: 6, color: "#000000", size: 999 }], CTX);
  ok("aidoc.apply.line.size-clamp", apBig.warnings.join("|").indexOf("clamped: size 999 → 64") >= 0);

  const rect = new Doc(6, 6, "rect");
  const apRect = applyOps(rect, [{ op: "rect", x: 1, y: 1, w: 3, h: 3, color: "#ff0000" }], CTX);
  const rectCel = rect.celAt(0, 0) as Cel;
  eq("aidoc.apply.rect.applied", apRect.applied, 1);
  eq("aidoc.apply.rect.changed", apRect.changed, { x: 1, y: 1, w: 3, h: 3 });
  eq("aidoc.apply.rect.edge", alphaAt(rectCel, 1, 1), 255);
  eq("aidoc.apply.rect.hollow", alphaAt(rectCel, 2, 2), 0);
  const apFillRect = applyOps(rect, [{ op: "rect", x: 1, y: 4, w: 2, h: 2, color: "#00ff00", fill: true }], CTX);
  eq("aidoc.apply.rect.fill.ok", apFillRect.ok, true);
  eq("aidoc.apply.rect.fill", [alphaAt(rectCel, 1, 4), alphaAt(rectCel, 2, 5)], [255, 255]);

  const apErase = applyOps(rect, [{ op: "erase", x: 1, y: 1, w: 3, h: 3 }], CTX);
  eq("aidoc.apply.erase.applied", apErase.applied, 1);
  eq("aidoc.apply.erase.cleared", alphaAt(rectCel, 1, 1), 0);
  eq("aidoc.apply.erase.kept-other", alphaAt(rectCel, 1, 4), 255);

  const fill = new Doc(5, 5, "fill");
  const fillCel = fill.ensureCel(0, 0);
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) fillCel.setPixel(x, y, [0, 0, 0, 255]);
  const apFill = applyOps(fill, [{ op: "fill", x: 0, y: 0, color: "#ff0000" }], CTX);
  eq("aidoc.apply.fill.applied", apFill.applied, 1);
  eq("aidoc.apply.fill.changed", apFill.changed, { x: 0, y: 0, w: 5, h: 5 });
  eq("aidoc.apply.fill.corner", [fillCel.data[fillCel.idx(4, 4)], fillCel.data[fillCel.idx(4, 4) + 1]], [255, 0]);

  const bounded = new Doc(3, 1, "bounded");
  const boundedCel = bounded.ensureCel(0, 0);
  boundedCel.setPixel(0, 0, [0, 0, 0, 255]);
  boundedCel.setPixel(1, 0, [255, 255, 255, 255]);
  boundedCel.setPixel(2, 0, [0, 0, 0, 255]);
  const apBounded = applyOps(bounded, [{ op: "fill", x: 0, y: 0, color: "#00ff00" }], CTX);
  eq("aidoc.apply.fill.bounded.changed", apBounded.changed, { x: 0, y: 0, w: 1, h: 1 });
  eq("aidoc.apply.fill.bounded.untouched", boundedCel.data[boundedCel.idx(2, 0) + 1], 0);

  const tol = new Doc(3, 1, "tol");
  const tolCel = tol.ensureCel(0, 0);
  tolCel.setPixel(0, 0, [100, 100, 100, 255]);
  tolCel.setPixel(1, 0, [110, 110, 110, 255]);
  tolCel.setPixel(2, 0, [200, 200, 200, 255]);
  const apTol = applyOps(tol, [{ op: "fill", x: 0, y: 0, color: "#ff0000", tolerance: 20 }], CTX);
  eq("aidoc.apply.fill.tolerance.changed", apTol.changed, { x: 0, y: 0, w: 2, h: 1 });
  const apOut = applyOps(tol, [{ op: "fill", x: 99, y: 0, color: "#ff0000" }], CTX);
  eq("aidoc.apply.fill.outside.ok", apOut.ok, false);
  eq("aidoc.apply.fill.outside.reason", apOut.errors[0].reason.indexOf("在画布外") >= 0, true);

  // 部分成功：非法 op 记 errors 并跳过，其余照常执行
  const mix = new Doc(4, 4, "mix");
  const apMix = applyOps(mix, [
    { op: "pixels", x: 0, y: 0, rgba: [255, 0, 0, 255] },
    { op: "nope" } as unknown as AiOp,
    { op: "pixels", x: 1, y: 0, rgba: [0, 255, 0, 255] },
  ], CTX);
  eq("aidoc.apply.mix.ok", apMix.ok, false);
  eq("aidoc.apply.mix.applied", apMix.applied, 2);
  eq("aidoc.apply.mix.errors", apMix.errors.length, 1);
  eq("aidoc.apply.mix.error-index", apMix.errors[0].index, 1);
  eq("aidoc.apply.mix.changed", apMix.changed, { x: 0, y: 0, w: 2, h: 1 });
  const mixCel = mix.celAt(0, 0) as Cel;
  eq("aidoc.apply.mix.second-written", mixCel.data[mixCel.idx(1, 0) + 1], 255);

  // 通道值钳制：改小了就要说（warnings 带最终值）
  const apClamp = applyOps(mix, [{ op: "pixels", x: 2, y: 0, rgba: [300, -5, 0, 255] }], CTX);
  ok("aidoc.apply.clamp.warn", apClamp.warnings.join("|").indexOf("clamped: rgba[0] 300 → 255") >= 0);
  eq("aidoc.apply.clamp.value", mixCel.data[mixCel.idx(2, 0)], 255);
  const apFrac = applyOps(mix, [{ op: "pixels", x: 3.7, y: 0, rgba: [1, 2, 3, 255] }], CTX);
  ok("aidoc.apply.coord.warn", apFrac.warnings.join("|").indexOf("clamped: x 3.7 → 3") >= 0);
  eq("aidoc.apply.coord.written", mixCel.data[mixCel.idx(3, 0) + 3], 255);

  // 颜色解析：fg/bg、十六进制、非法值、resolveColor 接管
  const col = new Doc(2, 1, "colour");
  const colCel0 = col.ensureCel(0, 0);
  const apFg = applyOps(col, [{ op: "line", x0: 0, y0: 0, x1: 1, y1: 0, color: "fg" }], CTX);
  eq("aidoc.apply.colour.fg.ok", apFg.ok, true);
  eq("aidoc.apply.colour.fg", [colCel0.data[colCel0.idx(0, 0)], colCel0.data[colCel0.idx(0, 0) + 1], colCel0.data[colCel0.idx(0, 0) + 2]], [10, 20, 30]);
  const apBg = applyOps(col, [{ op: "line", x0: 0, y0: 0, x1: 0, y1: 0, color: "bg" }], CTX);
  eq("aidoc.apply.colour.bg.ok", apBg.ok, true);
  eq("aidoc.apply.colour.bg", colCel0.data[colCel0.idx(0, 0)], 250);
  eq("aidoc.apply.colour.bad", applyOps(col, [{ op: "line", x0: 0, y0: 0, x1: 0, y1: 0, color: "zzz" }], CTX).errors.length, 1);
  // 半透明色画到不透明像素上走 paintAt 的 source-over：结果仍不透明（引擎既有语义）
  const apSemi = applyOps(col, [{ op: "line", x0: 1, y0: 0, x1: 1, y1: 0, color: "#11223344" }], CTX);
  eq("aidoc.apply.colour.semi.ok", apSemi.ok, true);
  eq("aidoc.apply.colour.semi-over-opaque", colCel0.data[colCel0.idx(1, 0) + 3], 255);
  // 画到空像素上则保留源 alpha
  const hexa = new Doc(1, 1, "hexa");
  const hexaCel = hexa.ensureCel(0, 0);
  eq("aidoc.apply.colour.hex8", applyOps(hexa, [{ op: "line", x0: 0, y0: 0, x1: 0, y1: 0, color: "#11223344" }], CTX).ok, true);
  eq("aidoc.apply.colour.hex8.alpha", hexaCel.data[hexaCel.idx(0, 0) + 3], 0x44);
  // 引擎的 blendOver 会把源 RGB 按 alpha 缩放（0x11 * 68/255 = 4.53 → 5），
  // 这是笔迹本来就有的语义，AI 这层不另立一套，钉住免得以后被"修正"成别的口径。
  eq("aidoc.apply.colour.hex8.rgb", hexaCel.data[hexaCel.idx(0, 0)], 5);

  // ------------------------------------------------ readRegion 反预乘（t14：直通 RGBA 口径）
  // 上一条钉住的是**写入侧**（cel 里的半透明字节 = 源 RGB × alpha）。读回那一步必须反乘回
  // 直通，否则「AI 画 #ff000080 → read_region 读回 #80000080」，与工具入参 #rrggbbaa、
  // doc.palette（都是直通）永远对不上 —— 「AI 画完自己复看」这条核心用法就断了。
  {
    const un = new Doc(3, 1, "unpremul");
    un.palette = [[255, 0, 128, 128]];                 // doc.palette 是直通口径（#rrggbbaa）
    const uc = un.ensureCel(0, 0);
    const wr = applyOps(un, [
      { op: "pixels", x: 0, y: 0, rgba: [255, 0, 128, 128] },        // 直通红@50%：paintAt → blendOver
      { op: "pixels", x: 1, y: 0, rgba: [255, 0, 128, 255] },        // a=255：必须与改动前一致
      { op: "pixels", x: 2, y: 0, rgba: [255, 0, 128, 0] },          // a=0：全透明
    ], CTX);
    eq("aidoc.region.unpremul.apply.ok", wr.ok, true);
    eq("aidoc.region.unpremul.apply.applied", wr.applied, 3);
    // 写入侧没变：cel 里那个半透明像素仍是按 alpha 缩过的字节 [128,0,64,128]（预乘语义，本次不动）
    eq("aidoc.region.unpremul.cel-bytes.semi",
      [uc.data[uc.idx(0, 0)], uc.data[uc.idx(0, 0) + 1], uc.data[uc.idx(0, 0) + 2], uc.data[uc.idx(0, 0) + 3]],
      [128, 0, 64, 128]);
    eq("aidoc.region.unpremul.cel-bytes.opaque",
      [uc.data[uc.idx(1, 0)], uc.data[uc.idx(1, 0) + 1], uc.data[uc.idx(1, 0) + 2], uc.data[uc.idx(1, 0) + 3]],
      [255, 0, 128, 255]);
    eq("aidoc.region.unpremul.cel-bytes.alpha0",
      [uc.data[uc.idx(2, 0)], uc.data[uc.idx(2, 0) + 1], uc.data[uc.idx(2, 0) + 2], uc.data[uc.idx(2, 0) + 3]],
      [0, 0, 0, 0]);

    const rgUn = readRegion(un, { x: 0, y: 0, w: 3, h: 1 });
    const decUn = decodeRow(rgUn.rows[0], rgUn.palette);
    // ① 半透明像素读回 = 写进去的直通色（a=128 这一档允许 ±1/通道）
    ok("aidoc.region.unpremul.roundtrip-semi", nearHex(decUn[0], "#ff008080", 1), decUn[0]);
    // ② 读回的 hex 就是 doc.palette 里那一条（不再是 #80004080）
    eq("aidoc.region.unpremul.palette", rgUn.palette, ["#ff008080", "#ff0080"]);
    eq("aidoc.region.unpremul.matches-doc-palette", rgUn.palette[0], rgbaToHex([255, 0, 128, 128]));
    // digest 侧同口径核对：它只输出 doc.palette（不含 cel 字节），所以本来就直通、无需反乘
    const digUn = docDigest(un);
    eq("aidoc.region.unpremul.digest-palette", digUn.palette, ["#ff008080"]);
    ok("aidoc.region.unpremul.digest-no-premultiplied-hex", digUn.text.indexOf("#80004080") < 0, digUn.text);
    ok("aidoc.region.unpremul.text-no-premultiplied-hex", rgUn.text.indexOf("#80004080") < 0, rgUn.text.split("\n")[1] ?? "");
    ok("aidoc.region.unpremul.text-has-straight-hex", rgUn.text.indexOf("#ff008080") >= 0);
    // ③ a=255：逐字节与改动前一致（cel 字节已在上面对过，这里对读回值）
    eq("aidoc.region.unpremul.opaque-exact", decUn[1], rgbaToHex([255, 0, 128, 255]));
    eq("aidoc.region.unpremul.opaque-hex", decUn[1], "#ff0080");
    // ④ a=0：全透明走 `.`，不进调色板
    eq("aidoc.region.unpremul.alpha0-dot", decUn[2], "#00000000");
    eq("aidoc.region.unpremul.alpha0-not-in-palette", rgUn.palette.indexOf("#00000000"), -1);
    ok("aidoc.region.unpremul.alpha0-note", rgUn.text.indexOf("1 个半透明像素") >= 0, rgUn.text.split("\n").pop() ?? "");
  }

  // 反乘的误差上界：写入那一步已经把 RGB 量化成 round(rgb*a/255)，信息不可逆地丢了。
  // 误差 ≈ ceil(255/(2a))：a=128 ≤±1、a=64 ≤±2、a=8 ≤±16；a=1 时只剩 1 个色阶。
  {
    const bd = new Doc(4, 1, "bound");
    const bc = bd.ensureCel(0, 0);
    bd.palette = [];
    applyOps(bd, [
      { op: "pixels", x: 0, y: 0, rgba: [255, 0, 128, 128] },
      { op: "pixels", x: 1, y: 0, rgba: [255, 0, 128, 64] },
      { op: "pixels", x: 2, y: 0, rgba: [255, 0, 128, 8] },
      { op: "pixels", x: 3, y: 0, rgba: [255, 0, 128, 1] },
    ], CTX);
    const rgB = readRegion(bd, { x: 0, y: 0, w: 4, h: 1 });
    const decB = decodeRow(rgB.rows[0], rgB.palette);
    ok("aidoc.region.unpremul.bound.a128", nearHex(decB[0], "#ff008080", 1), decB[0]);
    ok("aidoc.region.unpremul.bound.a64", nearHex(decB[1], "#ff008040", 2), decB[1]);
    ok("aidoc.region.unpremul.bound.a8", nearHex(decB[2], "#ff008008", 16), decB[2]);
    ok("aidoc.region.unpremul.bound.a1-lossy", decB[3] !== "#ff008001", decB[3]);
    // cel 侧字节：round(255*1/255)=1 / round(128*1/255)=1 → 反乘回来是 [255,0,255,1]
    eq("aidoc.region.unpremul.bound.a1-cel-bytes",
      [bc.data[bc.idx(3, 0)], bc.data[bc.idx(3, 0) + 1], bc.data[bc.idx(3, 0) + 2], bc.data[bc.idx(3, 0) + 3]],
      [1, 0, 1, 1]);
    eq("aidoc.region.unpremul.bound.a1-hex", decB[3], "#ff00ff01");
    eq("aidoc.region.unpremul.bound.alpha-kept", decB.map((h) => h.slice(-2)), ["80", "40", "08", "01"]);
  }
  const apOverride = applyOps(col, [{ op: "line", x0: 1, y0: 0, x1: 1, y1: 0, color: "whatever" }],
    { ...CTX, resolveColor: () => [7, 8, 9, 255] });
  eq("aidoc.apply.colour.override.ok", apOverride.ok, true);
  eq("aidoc.apply.colour.override", [colCel0.data[colCel0.idx(1, 0)], colCel0.data[colCel0.idx(1, 0) + 1]], [7, 8]);
  const apNull = applyOps(col, [{ op: "line", x0: 0, y0: 0, x1: 0, y1: 0, color: "#ff0000" }],
    { ...CTX, resolveColor: () => null });
  eq("aidoc.apply.colour.override-null", apNull.errors.length, 1);

  // 锁定图层：一个字节都不写
  const locked = new Doc(2, 2, "lock");
  locked.layers[0].locked = true;
  const apLock = applyOps(locked, [{ op: "pixels", x: 0, y: 0, rgba: [255, 0, 0, 255] }], CTX);
  eq("aidoc.apply.lock.ok", apLock.ok, false);
  eq("aidoc.apply.lock.applied", apLock.applied, 0);
  eq("aidoc.apply.lock.reason", apLock.errors[0].reason, "layer-locked");
  eq("aidoc.apply.lock.no-write", locked.celAt(0, 0), null);

  // 选区掩膜：框外的像素不写、也不进 changed
  const sel = new Doc(3, 1, "sel");
  sel.ensureCel(0, 0);
  const mask = new Sel(3, 1);
  mask.set(1, 0, 1);
  sel.sel = mask;
  const apSel = applyOps(sel, [{ op: "line", x0: 0, y0: 0, x1: 2, y1: 0, color: "#ff0000" }], CTX);
  const selCel = sel.celAt(0, 0) as Cel;
  eq("aidoc.apply.sel.changed", apSel.changed, { x: 1, y: 0, w: 1, h: 1 });
  eq("aidoc.apply.sel.inside", alphaAt(selCel, 1, 0), 255);
  eq("aidoc.apply.sel.outside", alphaAt(selCel, 0, 0), 0);

  // li / fi 越界钳制走 warnings
  const apIdx = applyOps(sel, [{ op: "pixels", x: 2, y: 0, rgba: [1, 1, 1, 255] }], { session: CTX.session, li: 5, fi: 9 });
  ok("aidoc.apply.idx.li-warn", apIdx.warnings.join("|").indexOf("clamped: li 5 → 0") >= 0);
  ok("aidoc.apply.idx.fi-warn", apIdx.warnings.join("|").indexOf("clamped: fi 9 → 0") >= 0);

  // ops 不是数组：按空处理，不抛
  const apNa = applyOps(sel, null as unknown as AiOp[], CTX);
  eq("aidoc.apply.not-array.ok", apNa.ok, true);
  eq("aidoc.apply.not-array.applied", apNa.applied, 0);
  ok("aidoc.apply.not-array.warn", apNa.warnings.join("|").indexOf("ops 不是数组") >= 0);

  // 纯写入：除了像素与 pixelRev，别的一个字段都不动（不碰 history / autosave / 结构）
  const pure = new Doc(2, 2, "pure");
  const layersBefore = JSON.stringify(pure.layers);
  const framesBefore = JSON.stringify(pure.frames);
  const paletteBefore = JSON.stringify(pure.palette);
  const apPure = applyOps(pure, [{ op: "pixels", x: 0, y: 0, rgba: [1, 2, 3, 255] }], CTX);
  eq("aidoc.apply.pure.layers", JSON.stringify(pure.layers), layersBefore);
  eq("aidoc.apply.pure.frames", JSON.stringify(pure.frames), framesBefore);
  eq("aidoc.apply.pure.palette", JSON.stringify(pure.palette), paletteBefore);
  eq("aidoc.apply.pure.tags", pure.tags.length, 0);
  eq("aidoc.apply.pure.sel", pure.sel, null);
  eq("aidoc.apply.pure.rev", [apPure.docRev, pure.pixelRev], [1, 1]);
  const apNoop = applyOps(pure, [{ op: "pixels", x: 0, y: 0, rgba: [1, 2, 3, 255] }], CTX);
  eq("aidoc.apply.same-pixel.rev", apNoop.docRev, 1);
  eq("aidoc.apply.same-pixel.applied", apNoop.applied, 1);
  eq("aidoc.apply.same-pixel.changed", apNoop.changed, { x: 0, y: 0, w: 1, h: 1 });
  // 但碰到还没写过的像素就算真改：rev 前进
  const apNewPixels = applyOps(pure, [{ op: "rect", x: 0, y: 0, w: 2, h: 1, color: "#010203" }], CTX);
  eq("aidoc.apply.new-pixels.rev", apNewPixels.docRev, 2);

  // 懒创建：全程落在画布外的 op 一个字节没写，就不该在 doc.cels 里留下一条空 Cel
  // （applied / changed / docRev 的口径不变：仍然计入 applied、changed 为 null、rev 不动）
  const offPix = new Doc(3, 3, "off-pixels");
  const apOffPix = applyOps(offPix, [{ op: "pixels", x: 9, y: 9, rgba: [1, 2, 3, 255] }], CTX);
  eq("aidoc.apply.off.pixels.no-cel", offPix.celAt(0, 0), null);
  eq("aidoc.apply.off.pixels.result", [apOffPix.ok, apOffPix.applied, apOffPix.changed, apOffPix.docRev], [true, 1, null, 0]);
  const offErase = new Doc(3, 3, "off-erase");
  const apOffErase = applyOps(offErase, [{ op: "erase", x: 9, y: 9, w: 2, h: 2 }], CTX);
  eq("aidoc.apply.off.erase.no-cel", offErase.celAt(0, 0), null);
  eq("aidoc.apply.off.erase.result", [apOffErase.ok, apOffErase.applied, apOffErase.changed, apOffErase.docRev], [true, 1, null, 0]);
  const offRect = new Doc(3, 3, "off-rect");
  const apOffRect = applyOps(offRect, [{ op: "rect", x: 9, y: 9, w: 2, h: 2, color: "#ff0000" }], CTX);
  eq("aidoc.apply.off.rect.no-cel", offRect.celAt(0, 0), null);
  eq("aidoc.apply.off.rect.result", [apOffRect.ok, apOffRect.applied, apOffRect.changed, apOffRect.docRev], [true, 1, null, 0]);
  // fill 的种子越界：记 error 返回，同样不建 cel
  const offFill = new Doc(3, 3, "off-fill");
  const apOffFill = applyOps(offFill, [{ op: "fill", x: -1, y: 0, color: "#ff0000" }], CTX);
  eq("aidoc.apply.off.fill.ok", apOffFill.ok, false);
  eq("aidoc.apply.off.fill.reason", apOffFill.errors, [{ index: 0, reason: "fill 起点 (-1,0) 在画布外" }]);
  eq("aidoc.apply.off.fill.no-cel", offFill.celAt(0, 0), null);
  // 但一端在内一端在外的 line 仍要建 cel 并画出进画布的那截
  const halfLine = new Doc(4, 3, "half-line");
  const apHalfLine = applyOps(halfLine, [{ op: "line", x0: -5, y0: 1, x1: 2, y1: 1, color: "#ff0000" }], CTX);
  eq("aidoc.apply.off.line.changed", apHalfLine.changed, { x: 0, y: 1, w: 3, h: 1 });
  eq("aidoc.apply.off.line.cel", halfLine.celAt(0, 0) === null, false);

  // ctx 的 fi / li 小数：截断要进 warnings（与坐标、readRegion 口径统一）
  const apFracFi = applyOps(pure, [{ op: "pixels", x: 0, y: 1, rgba: [9, 9, 9, 255] }], { session: CTX.session, fi: 3.7 });
  ok("aidoc.apply.idx.fi-frac-warn", apFracFi.warnings.join("|").indexOf("clamped: fi 3.7 → 0") >= 0);
  const apFracLi = applyOps(pure, [{ op: "pixels", x: 1, y: 1, rgba: [9, 9, 9, 255] }], { session: CTX.session, li: 0.4 });
  ok("aidoc.apply.idx.li-frac-warn", apFracLi.warnings.join("|").indexOf("clamped: li 0.4 → 0") >= 0);
}
