// 高级颜色分析器：引擎（统计 / 近似色 / 替换 / 选区）与 Session 接口的回归。
//
// 引擎用例全部是纯数据（无 DOM）；Session 用例复用 session.test 的 DOM 桩，
// 只走「当前图层 / 选区 / 所有帧」这些不依赖 canvas 像素的范围（画布范围的
// 压平在引擎里由 flattenLayers 单测覆盖）。
import {
  GROUP_TOLERANCE, analyzeColours, bucketCount, colourKey, colourStatsCsv, flattenLayers, groupSimilarColours,
  hueOf, lightnessOf, nearestPalette, replaceColours, rgbDistanceSq, saturationOf, selectByColour,
  sortColourEntries, withinTolerance,
} from "../src/engine/color-analysis";
import type { ColourAnalysis } from "../src/engine/color-analysis";

declare const require: (m: string) => any;
declare const __dirname: string;
const fs = require("fs");
const nodePath = require("path");
/** **已编译**的 src/ 目录：用例跑在 <app>/tests/.ts-out/tests，编译产物在
 *  <app>/tests/.ts-out/src（require 只能拿编译后的 JS，不能读原始 .ts） */
const SRC = nodePath.resolve(__dirname, "../src");
import type { RGBA } from "../src/engine/types";
import { Session } from "../src/app/session";
import { Sel } from "../src/engine/doc";
import { stubEnv } from "./session.test";
// 副作用导入：把 ui/modals.tsx 拉进编译图（它平时只被 App.tsx 引用，而 App 不在
// 测试入口里）。面板的 SSR 冒烟测试要 require 编译后的 modals.js，没有这一行
// 编译产物里就没有这个文件。用命名空间形式"用一下"是为了不被 noUnusedLocals 拦下。
import * as modalsModule from "../src/ui/modals";
import { eq, ok } from "./common";

/** 测试用小画布：按 (x,y) -> RGBA 填像素（缺省 = 全透明） */
function buf(w: number, h: number, put: (x: number, y: number) => RGBA | null): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = put(x, y);
      if (!c) continue;
      const i = (y * w + x) * 4;
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = c[3];
    }
  }
  return d;
}
const px = (d: Uint8ClampedArray, w: number, x: number, y: number): number[] => {
  const i = (y * w + x) * 4;
  return [d[i], d[i + 1], d[i + 2], d[i + 3]];
};
const find = (a: ColourAnalysis, c: RGBA) => a.entries.find((e) => e.rgba[0] === c[0] && e.rgba[1] === c[1] && e.rgba[2] === c[2] && e.rgba[3] === c[3])!;

const RED: RGBA = [255, 0, 0, 255];
const GREEN: RGBA = [0, 255, 0, 255];
const BLUE: RGBA = [0, 0, 255, 255];

// ------------------------------------------------------------ 引擎：颜色统计

function testColourKey(): void {
  // 32 位颜色键：每个通道各占 8 位，任何两个不同的 RGBA 都必须给出不同的键
  eq("ca.key.red", colourKey([255, 0, 0, 255]) === colourKey([0, 255, 0, 255]), false);
  eq("ca.key.alpha-matters", colourKey([255, 0, 0, 255]) === colourKey([255, 0, 0, 0]), false);
  eq("ca.key.bit-layout", colourKey([1, 2, 3, 4]), (1 * 16777216 + 2 * 65536 + 3 * 256 + 4) >>> 0);
  // 逐通道扫一遍，确保没有两个颜色的键相同（回归：`a<<8 | b` 少写括号会撞键）
  const seen = new Set<number>();
  let dup = 0;
  for (let r = 0; r < 256; r += 17) {
    for (let g = 0; g < 256; g += 17) {
      for (let b = 0; b < 256; b += 17) {
        const k = colourKey([r, g, b, 255]);
        if (seen.has(k)) dup++;
        seen.add(k);
      }
    }
  }
  eq("ca.key.no-collision", dup, 0);
  eq("ca.key.key-count", seen.size, 16 * 16 * 16);
}

function testAnalyze(): void {
  // 2×2：红 / 绿 / 红半透明 / 全透明
  const semi: RGBA = [255, 0, 0, 128];
  const d = buf(2, 2, (x, y) => (y === 1 ? (x === 0 ? semi : null) : (x === 0 ? RED : GREEN)));
  const a = analyzeColours(d);
  eq("ca.analyze.total", a.totalPixels, 4);
  eq("ca.analyze.opaque", a.opaquePixels, 2);
  eq("ca.analyze.semi", a.semiPixels, 1);
  eq("ca.analyze.clear", a.clearPixels, 1);
  eq("ca.analyze.colourCount", a.colourCount, 3);
  eq("ca.analyze.opaqueColours", a.opaqueColours, 2);
  eq("ca.analyze.semiColours", a.semiColours, 1);
  // 数量降序；红(不透明) 与红(半透明) 是两种颜色，各 1
  eq("ca.analyze.order", a.entries.map((e) => e.count), [1, 1, 1]);
  eq("ca.analyze.has-clear-entry", a.entries.some((e) => e.rgba[3] === 0), false);
  eq("ca.analyze.ratio", find(a, GREEN).ratio, 0.25);
  eq("ca.analyze.ratio-semi", find(a, semi).ratio, 0.25);
  // 不透明占比：分母是不透明像素数（红 1 + 绿 1）
  eq("ca.analyze.ratio-opaque", find(a, RED).ratioOfOpaque, 0.5);
  eq("ca.analyze.ratio-opaque-semi", find(a, semi).ratioOfOpaque, 0.5);
}

function testAnalyzeCountsAndSort(): void {
  // 3×1：红 红 绿 —— 数量降序 / 色相升序 / 明度升序各校验一次
  const d = buf(3, 1, (x) => (x < 2 ? RED : GREEN));
  const a = analyzeColours(d);
  eq("ca.sort.count", a.entries.map((e) => [e.rgba[0], e.count]), [[255, 2], [0, 1]]);
  // 色相升序：红 0° 在绿 120° 之前
  eq("ca.sort.hue", sortColourEntries(a.entries, "hue").map((e) => e.rgba[1]), [0, 255]);
  // 明度升序：红 l=0.5、绿 l=0.5 —— 平局按 RGBA 升序，所以绿在前
  eq("ca.sort.light", sortColourEntries(a.entries, "light").map((e) => e.rgba[1]), [255, 0]);
  // 原数组不被改动（面板切排序不能污染缓存）
  eq("ca.sort.pure", a.entries.map((e) => e.count), [2, 1]);
  // 同一块数据在引擎里排序，entries 顺序与 sort 参数一致
  eq("ca.sort.engine-param", analyzeColours(d, { sort: "hue" }).entries.map((e) => e.rgba[1]), [0, 255]);
}

function testClearAndDegenerate(): void {
  // 空数据 / 空画布
  const empty = analyzeColours(new Uint8ClampedArray(0));
  eq("ca.empty.entries", empty.entries.length, 0);
  eq("ca.empty.total", empty.totalPixels, 0);
  eq("ca.empty.ratio-guard", empty.colourCount, 0);
  // 全透明画布
  const clear = analyzeColours(buf(2, 2, () => null));
  eq("ca.clear.total", clear.totalPixels, 4);
  eq("ca.clear.colours", clear.colourCount, 0);
  eq("ca.clear.histogram", clear.histogram.hue.counts.reduce((s, v) => s + v, 0), 0);
  // 单色画布：一个颜色、占比 1、直方图只落一个桶
  const one = analyzeColours(buf(2, 2, () => RED));
  eq("ca.single.entries", one.entries.length, 1);
  eq("ca.single.ratio", one.entries[0].ratio, 1);
  eq("ca.single.hue", one.histogram.hue.max, 4);
  eq("ca.single.light-bucket", one.histogram.light.counts.filter((v) => v > 0).length, 1);
  // includeClear：全透明像素也当成一种"颜色"统计
  const withClear = analyzeColours(buf(2, 1, (x) => (x === 0 ? RED : null)), { includeClear: true });
  eq("ca.includeClear.colours", withClear.entries.length, 2);
  ok("ca.includeClear.has-zero", withClear.entries.some((e) => e.rgba[3] === 0));
  // 尾部不足 4 字节的数据不越界
  eq("ca.ragged.total", analyzeColours(new Uint8ClampedArray(7)).totalPixels, 1);
}

function testHistogram(): void {
  eq("ca.bucket.default", bucketCount(), 24);
  eq("ca.bucket.max", bucketCount(999), 24);
  eq("ca.bucket.min", bucketCount(1), 12);
  eq("ca.bucket.multiple-of-4", bucketCount(20), 20);
  // 红 → 色相桶 0（0°）；绿 → 120° = 桶 8（360/24 = 15° 每桶）
  const d = buf(2, 1, (x) => (x === 0 ? RED : GREEN));
  const a = analyzeColours(d, { buckets: 24 });
  eq("ca.hist.buckets", a.histogram.hue.buckets, 24);
  eq("ca.hist.hue-red", a.histogram.hue.counts[0], 1);
  eq("ca.hist.hue-green", a.histogram.hue.counts[8], 1);
  eq("ca.hist.hue-sum", a.histogram.hue.counts.reduce((s, v) => s + v, 0), 2);
  // 灰阶：色相没有意义 → 不进色相直方图，计入 hueNeutral
  const grey = analyzeColours(buf(1, 1, () => [128, 128, 128, 255] as RGBA), { buckets: 12 });
  eq("ca.hist.neutral", grey.hueNeutral, 1);
  eq("ca.hist.neutral-hue-empty", grey.histogram.hue.max, 0);
  eq("ca.hist.neutral-sat-bucket", grey.histogram.sat.counts[0], 1);
  // 色相/饱和度/明度取值口径
  eq("ca.hsl.hue-red", hueOf(255, 0, 0), 0);
  eq("ca.hsl.hue-green", Math.round(hueOf(0, 255, 0)), 120);
  eq("ca.hsl.sat-grey", saturationOf(128, 128, 128), 0);
  eq("ca.hsl.light-black", lightnessOf(0, 0, 0), 0);
  eq("ca.hsl.light-white", lightnessOf(255, 255, 255), 1);
  // 半透明像素仍然进直方图（看得见），全透明的不进
  const semiOnly = analyzeColours(buf(1, 1, () => [255, 0, 0, 40] as RGBA), { buckets: 12 });
  eq("ca.hist.semi-counted", semiOnly.histogram.hue.max, 1);
}

// ------------------------------------------------------------ 引擎：调色板关系

function testPaletteHits(): void {
  const pal: RGBA[] = [RED, GREEN, BLUE];
  const d = buf(2, 2, (x, y) => (y === 0 ? (x === 0 ? RED : [250, 2, 2, 255] as RGBA) : null));
  const a = analyzeColours(d, { palette: pal });
  const exact = find(a, RED);
  const near = find(a, [250, 2, 2, 255]);
  ok("ca.palette.exact", exact.palette.exact);
  eq("ca.palette.exact-uses", a.usedPaletteCount, 1);
  // 距离口径：单通道 5 阶 -> sqrt(25/3) ≈ 2.89；默认阈值 12 内算"近似板色"
  eq("ca.palette.near-distance", Math.round(near.palette.distance * 100) / 100, 3.32);
  eq("ca.palette.near-nearest", near.palette.nearest, RED);
  ok("ca.palette.near-flag", near.nearPalette);
  // 未使用的调色板色
  eq("ca.palette.unused", a.unusedPalette.map((c) => c[0]), [0, 0]);
  eq("ca.palette.unused-count", a.unusedPalette.length, 2);
  // 没有调色板时：不命中、没有最近色、距离无限
  const bare = analyzeColours(d);
  eq("ca.palette.empty-exact", bare.entries.every((e) => !e.palette.exact), true);
  eq("ca.palette.empty-nearest", bare.entries[0].palette.nearest, null);
  eq("ca.palette.empty-unused", bare.unusedPalette.length, 0);
  // 判据与 paletteSnap 同源：最近色 = 调色板里距离最小的那个（平局取先出现的）
  eq("ca.palette.nearest-fn", nearestPalette(250, 2, 2, pal), RED);
  eq("ca.palette.nearest-null", nearestPalette(1, 2, 3, []), null);
  // 距离函数是归一化平方距离：dr=dg=db=v 时等于 v
  eq("ca.dist.axis", rgbDistanceSq(12, 0, 0, 0, 0, 0), 48);
  // 容差口径：单通道 10 阶 = 距离 sqrt(100/3) ≈ 5.77，所以容差 6 命中、5 不命中
  eq("ca.dist.within", withinTolerance([10, 0, 0, 255], [0, 0, 0, 255], 6), true);
  eq("ca.dist.outside", withinTolerance([10, 0, 0, 255], [0, 0, 0, 255], 5), false);
}

// ------------------------------------------------------------ 引擎：近似色分组

function testGroups(): void {
  const mk = (c: RGBA, n: number): ColourAnalysis["entries"][number] => ({
    rgba: c, count: n, ratio: 0, ratioOfOpaque: 0,
    palette: { exact: false, nearest: null, distance: Infinity }, nearPalette: false,
  });
  const entries = [mk(RED, 10), mk([251, 2, 2, 255], 4), mk(GREEN, 6)];
  // 阈值内：红与 250,3,3 一组（组内距离 ≈ 4.3 ≤ 12）
  const g1 = groupSimilarColours(entries, GROUP_TOLERANCE);
  eq("ca.group.count", g1.length, 1);
  eq("ca.group.rep-is-most-used", g1[0].rep, RED);
  eq("ca.group.members", g1[0].members.map((m) => m.count), [10, 4]);
  eq("ca.group.pixels", g1[0].pixels, 14);
  eq("ca.group.spread", Math.round(g1[0].spread * 100) / 100, 2.83);
  // 阈值外：把阈值压到 1，两个红就分开了（没有组）
  eq("ca.group.tol-out", groupSimilarColours(entries, 1).length, 0);
  // 边界：距离正好等于阈值算命中（≤）
  const dRed = Math.sqrt(rgbDistanceSq(RED[0], RED[1], RED[2], 251, 2, 2));
  ok("ca.group.boundary-setup", dRed > 1 && dRed < 3, "d=" + dRed);
  eq("ca.group.boundary-in", groupSimilarColours(entries, Math.ceil(dRed)).length, 1);
  eq("ca.group.boundary-out", groupSimilarColours(entries, Math.floor(dRed) - 1).length, 0);
  // 只有一种颜色时不产生"重复"组
  eq("ca.group.single", groupSimilarColours([mk(RED, 5)]).length, 0);
  eq("ca.group.empty", groupSimilarColours([]).length, 0);
  // 组数上限：三种互不相近的近似对 → 最多返回 maxGroups 组
  const many = [
    mk(RED, 3), mk([250, 0, 0, 255], 1),
    mk(GREEN, 3), mk([0, 250, 0, 255], 1),
    mk(BLUE, 3), mk([0, 0, 250, 255], 1),
  ];
  eq("ca.group.all", groupSimilarColours(many).length, 3);
  eq("ca.group.capped", groupSimilarColours(many, GROUP_TOLERANCE, 2).length, 2);
}

// ------------------------------------------------------------ 引擎：替换

function testReplaceTolerance(): void {
  const from: RGBA = [10, 10, 10, 255];
  const to: RGBA = [255, 255, 255, 255];
  // 容差 5：与源色距离 5 的像素在阈值内，距离 6 的在外面
  const d = buf(3, 1, (x) => (x === 0 ? from : x === 1 ? [15, 10, 10, 255] as RGBA : [16, 10, 10, 255] as RGBA));
  const r = replaceColours(d, 3, 1, from, to, { tolerance: 3 });
  eq("ca.replace.tol.changed", r.changed, 2);
  eq("ca.replace.tol.inside", px(d, 3, 1, 0), [255, 255, 255, 255]);
  eq("ca.replace.tol.outside", px(d, 3, 2, 0), [16, 10, 10, 255]);
  // 容差 0 = 只换完全相同的颜色
  const d0 = buf(2, 1, (x) => (x === 0 ? from : [11, 10, 10, 255] as RGBA));
  eq("ca.replace.exact", replaceColours(d0, 2, 1, from, to, { tolerance: 0 }).changed, 1);
  eq("ca.replace.exact-untouched", px(d0, 2, 1, 0), [11, 10, 10, 255]);
  // 容差 255 = 全部命中
  const dAll = buf(2, 1, () => [200, 3, 90, 255] as RGBA);
  eq("ca.replace.max", replaceColours(dAll, 2, 1, from, to, { tolerance: 255 }).changed, 2);
  // 全透明像素不算命中（它没有颜色）
  const dClear = buf(1, 1, () => null);
  eq("ca.replace.clear-skipped", replaceColours(dClear, 1, 1, [0, 0, 0, 0], to, { tolerance: 255 }).changed, 0);
}

function testReplaceAlphaRules(): void {
  const from: RGBA = [50, 60, 70, 255];
  const to: RGBA = [200, 100, 50, 255];
  const semi = [50, 60, 70, 128] as RGBA;
  // 默认 opaqueOnly：半透明像素不动
  const d1 = buf(2, 1, (x) => (x === 0 ? from : semi));
  eq("ca.replace.opaque-only", replaceColours(d1, 2, 1, from, to).changed, 1);
  eq("ca.replace.opaque-only.semi-kept", px(d1, 2, 1, 0), [50, 60, 70, 128]);
  // 关掉 opaqueOnly：半透明也换，默认保留它自己的 alpha
  const d2 = buf(2, 1, (x) => (x === 0 ? from : semi));
  eq("ca.replace.include-semi", replaceColours(d2, 2, 1, from, to, { opaqueOnly: false }).changed, 2);
  eq("ca.replace.semi-keeps-alpha", px(d2, 2, 1, 0), [200, 100, 50, 128]);
  // keepAlpha=false：连 alpha 一起换成目标色
  const d3 = buf(2, 1, (x) => (x === 0 ? from : semi));
  replaceColours(d3, 2, 1, from, to, { opaqueOnly: false, keepAlpha: false });
  eq("ca.replace.alpha-from-target", px(d3, 2, 1, 0), [200, 100, 50, 255]);
  // 目标色的 alpha 参与（keepAlpha=false 时用它替换）
  const d4 = buf(1, 1, () => from);
  replaceColours(d4, 1, 1, from, [9, 9, 9, 40], { keepAlpha: false });
  eq("ca.replace.target-alpha", px(d4, 1, 0, 0), [9, 9, 9, 40]);
}

function testReplaceScope(): void {
  const from: RGBA = [10, 10, 10, 255];
  const to: RGBA = [0, 200, 0, 255];
  const d = buf(4, 1, () => from);
  const mask = new Uint8Array(4);
  mask[1] = 1; mask[3] = 1;
  const r = replaceColours(d, 4, 1, from, to, { scope: "selection", inMask: (x) => mask[x] === 1 });
  eq("ca.replace.scope.changed", r.changed, 2);
  eq("ca.replace.scope.outside", px(d, 4, 0, 0), [10, 10, 10, 255]);
  eq("ca.replace.scope.inside", px(d, 4, 1, 0), [0, 200, 0, 255]);
  eq("ca.replace.scope.last", px(d, 4, 3, 0), [0, 200, 0, 255]);
  // selection 范围但没给掩码函数：等同"不限制"（面板一定给了，引擎这层只求不炸）
  const d2 = buf(2, 1, () => from);
  eq("ca.replace.scope.no-mask", replaceColours(d2, 2, 1, from, to, { scope: "selection" }).changed, 2);
  // 空数据
  eq("ca.replace.empty", replaceColours(new Uint8ClampedArray(0), 0, 0, from, to).changed, 0);
}

function testSelectByColour(): void {
  const d = buf(3, 1, (x) => (x === 0 ? RED : x === 1 ? [250, 0, 0, 255] as RGBA : GREEN));
  const mask = new Uint8Array(3);
  eq("ca.select.exact", selectByColour(mask, d, 3, 1, RED, 0), 1);
  eq("ca.select.mask", Array.from(mask), [1, 0, 0]);
  mask.fill(0);
  eq("ca.select.tol", selectByColour(mask, d, 3, 1, RED, 10), 2);
  eq("ca.select.mask-tol", Array.from(mask), [1, 1, 0]);
  // 半透明像素也算命中；全透明不算
  const semi: RGBA = [1, 2, 3, 90];
  const d2 = buf(2, 1, (x) => (x === 0 ? semi : null));
  const m2 = new Uint8Array(2);
  eq("ca.select.semi", selectByColour(m2, d2, 2, 1, semi, 0), 1);
  eq("ca.select.semi-mask", Array.from(m2), [1, 0]);
  // opaqueOnly 时半透明不算
  const m3 = new Uint8Array(2);
  eq("ca.select.opaque-only", selectByColour(m3, d2, 2, 1, semi, 0, true), 0);
  // 掩码比 w*h 小时不越界
  const m4 = new Uint8Array(1);
  eq("ca.select.small-mask", selectByColour(m4, d, 3, 1, RED, 0), 1);
}

function testFlatten(): void {
  // 底层绿、上层半透明红：压平后是红绿混合
  const bottom = buf(1, 1, () => GREEN);
  const top = buf(1, 1, () => [255, 0, 0, 128] as RGBA);
  const out = flattenLayers(1, 1, [{ data: bottom }, { data: top }]);
  eq("ca.flatten.blend", Array.from(out), [128, 127, 0, 255]);
  // 图层不透明度 50% 等同于 alpha 减半（0.5 * 0.5 = 0.25 → 混合结果更偏绿色）
  const half = flattenLayers(1, 1, [{ data: bottom }, { data: top, opacity: 50 }]);
  eq("ca.flatten.opacity", Array.from(half), [64, 191, 0, 255]);
  // opacity 0 的图层完全不参与
  const zero = flattenLayers(1, 1, [{ data: bottom }, { data: top, opacity: 0 }]);
  eq("ca.flatten.opacity-zero", Array.from(zero), [0, 255, 0, 255]);
  // 空图层列表 = 全透明
  eq("ca.flatten.empty", flattenLayers(1, 1, []).reduce((s, v) => s + v, 0), 0);
}

// ------------------------------------------------------------ Session

function testSessionAnalysis(): void {
  stubEnv();
  const s = new Session();
  const doc = s.doc;
  // 缩成 2×2（Doc 改尺寸不会重算已有 cel 的大小，所以先丢掉旧 cel 再建）
  doc.cels.clear();
  doc.w = 2; doc.h = 2;
  doc.sel = null;
  s.history.clear();
  const cel = doc.ensureCel(0, 0);
  const near: RGBA = [251, 2, 2, 255];
  // 每行 2 个像素：红 / 近红 / 绿 / 蓝
  cel.data.set(buf(2, 2, (x, y) => (y === 0 ? (x === 0 ? RED : near) : x === 0 ? GREEN : BLUE)));
  doc.palette = [RED, GREEN, [9, 9, 9, 255]];

  const a = s.analyseCanvas("layer");
  eq("ca.session.layer.colours", a.colourCount, 4);
  eq("ca.session.layer.total", a.totalPixels, 4);
  eq("ca.session.layer.order", a.entries.map((e) => e.count), [1, 1, 1, 1]);
  // 调色板命中：红 / 绿精确命中，近红最近色是红；蓝最近的板色是深灰，
  // 所以三个板色都算"用到"，未使用清单为空（用了不该用的色 = 全都会被标出来）
  eq("ca.session.layer.palette-unused", a.unusedPalette.length, 0);
  eq("ca.session.layer.used-palette", a.usedPaletteCount, 3);
  eq("ca.session.layer.unused-count", a.unusedPalette.length + a.usedPaletteCount, doc.palette.length);
  // 换一个真正没用上的调色板，就能看到未使用清单
  doc.palette = [RED, GREEN, [0, 0, 0, 255], [255, 255, 255, 255]];
  const unused = s.analyseCanvas("layer");
  eq("ca.session.layer.unused-list", unused.unusedPalette.length, 1);
  // 未使用清单按"最近色归属"判定：蓝会归到最近的黑，所以只有白色真的没人用
  eq("ca.session.layer.unused-hex", unused.unusedPalette[0], [255, 255, 255, 255]);
  doc.palette = [RED, GREEN, [9, 9, 9, 255]];
  ok("ca.session.layer.exact-red", find(a, RED).palette.exact);
  // 近红不是精确命中，但最近色就是红，且在默认阈值内
  eq("ca.session.layer.near-nearest", find(a, near).palette.nearest, RED);
  eq("ca.session.layer.near-exact", find(a, near).palette.exact, false);
  ok("ca.session.layer.near-flag", find(a, near).nearPalette);
  eq("ca.session.layer.blue-nearest", find(a, BLUE).palette.nearest, [9, 9, 9, 255]);
  ok("ca.session.layer.blue-not-near", !find(a, BLUE).nearPalette);

  // 近似色分组（Session 入口用统计结果转发引擎，只读、不记历史）
  const groups = s.colourGroups(a, GROUP_TOLERANCE);
  eq("ca.session.group.count", groups.length, 1);
  // 代表色 = 组里像素最多的颜色；这里红与近红各 1 个像素，并列时取 RGBA 小的（近红）
  eq("ca.session.group.rep", groups[0].rep, near);
  eq("ca.session.group.members", groups[0].members.length, 2);
  eq("ca.session.group.pixels", groups[0].pixels, 2);
  eq("ca.session.group.spread", Math.round(groups[0].spread * 100) / 100, 2.83);
  ok("ca.session.groups-noop", s.history.list().labels.indexOf("colour-replace") < 0);

  // 画布范围：可见图层压平（只有一个图层，结果与图层范围一致）
  const c = s.analyseCanvas("canvas");
  eq("ca.session.canvas.colours", c.colourCount, 4);
  eq("ca.session.canvas.total", c.totalPixels, 4);

  // 选区范围：没有选区时有效像素为 0（范围仍是整张画布）
  eq("ca.session.selection-empty", s.analyseCanvas("selection").totalPixels, 4);
  eq("ca.session.selection-empty-colours", s.analyseCanvas("selection").colourCount, 0);
  // 有选区：只把选区内的像素当有效像素（范围仍是整张画布，被排除的变成全透明）
  doc.sel = new Sel(2, 2);
  doc.sel.set(0, 0, 1);
  const sel = s.analyseCanvas("selection");
  eq("ca.session.selection.total", sel.totalPixels, 4);
  eq("ca.session.selection.colours", sel.colourCount, 1);
  eq("ca.session.selection.entry", sel.entries[0].rgba, RED);
  eq("ca.session.selection.ratio", sel.entries[0].ratio, 0.25);
  eq("ca.session.selection.opaque", sel.opaquePixels, 1);
  eq("ca.session.selection.clear", sel.clearPixels, 3);
  doc.sel = null;
  // 分析选区不会改动图层：把像素写回去再验一次
  eq("ca.session.selection.no-mutation", px(cel.data, 2, 0, 0), RED);

  // 所有帧：口径是「同一个像素位置只算一次，先出现的帧优先」（见 analysisPixels 注释）。
  // 用 4×1 画布：第 0 帧只占位置 0/1，让第 1 帧的位置 2/3 露出来。
  doc.cels.clear();
  doc.w = 4; doc.h = 1;
  const f0cel = doc.ensureCel(0, 0);
  f0cel.data.set(buf(4, 1, (x) => (x === 0 ? RED : x === 1 ? near : null)));
  s.frameAdd();
  eq("ca.session.allFrames.frames", doc.frames.length, 2);
  // ⚠ 第 1 帧要写自己的缓冲区：同一个 buf 会被两个 cel 共享，先写的帧反而被覆盖
  doc.ensureCel(0, 1).data.set(buf(4, 1, (x) => (x >= 2 ? ([255, 255, 0, 255] as RGBA) : null)));
  const af = s.analyseCanvas("allFrames");
  eq("ca.session.allFrames.total", af.totalPixels, 4);
  eq("ca.session.allFrames.colours", af.colourCount, 3);
  // 两格黄 + 一格红 + 一格近红：数量降序
  eq("ca.session.allFrames.entries", af.entries.map((e) => e.count), [2, 1, 1]);
  eq("ca.session.allFrames.has-yellow", af.entries.some((e) => e.rgba[0] === 255 && e.rgba[1] === 255), true);
  eq("ca.session.allFrames.clear", af.clearPixels, 0);
  eq("ca.session.allFrames.histogram", af.histogram.light.counts.reduce((x, v) => x + v, 0), 4);
  // 当前帧只有前两个像素：颜色数 2
  eq("ca.session.currentFrame.colours", s.analyseCanvas("canvas").colourCount, 2);
  // 第 1 帧铺满时：位置 0 仍是红的（先出现的帧赢），黄色只在位置 2/3 之前没被占的地方
  doc.ensureCel(0, 1).data.set(buf(4, 1, () => [255, 255, 0, 255] as RGBA));
  const af2 = s.analyseCanvas("allFrames");
  eq("ca.session.allFrames.first-wins", af2.colourCount, 3);
  eq("ca.session.allFrames.first-wins-red", af2.entries.filter((e) => e.rgba[0] === 255 && e.rgba[1] === 0).length, 1);
  eq("ca.session.allFrames.first-wins-yellow", af2.entries.filter((e) => e.rgba[0] === 255 && e.rgba[1] === 255).length, 1);
  // 同一位置被前帧占满时，后帧的颜色一个都进不了统计（数据口径，不是丢数据）
  doc.w = 2; doc.h = 2; doc.cels.clear();
  const g0 = doc.ensureCel(0, 0);
  g0.data.set(buf(2, 2, () => RED));
  doc.ensureCel(0, 1).data.set(buf(2, 2, () => [255, 255, 0, 255] as RGBA));
  const af3 = s.analyseCanvas("allFrames");
  eq("ca.session.allFrames.covered", af3.colourCount, 1);
  eq("ca.session.allFrames.covered-colour", af3.entries[0].rgba, RED);
  // 恢复成第 0 帧的红/近红/绿/蓝，供下面的 CSV 断言使用
  doc.cels.clear();
  doc.ensureCel(0, 0).data.set(buf(2, 2, (x, y) => (y === 0 ? (x === 0 ? RED : near) : x === 0 ? GREEN : BLUE)));


  // CSV：表头 + 每种颜色一行 + 未使用色小节
  // 上面三个板色都被"用到"了（蓝归到最近的黑），这里加一个真的没人用的颜色
  doc.palette = [RED, GREEN, [9, 9, 9, 255], [75, 0, 130, 255]];
  const csv = colourStatsCsv(s.analyseCanvas("layer"), { scopeLabel: "layer", paletteSize: 4 });
  doc.palette = [RED, GREEN, [9, 9, 9, 255]];
  ok("ca.session.csv.header", csv.indexOf("index,hex,r,g,b,a,pixels,ratio") > 0);
  ok("ca.session.csv.has-hex", csv.indexOf("#ff0000") > 0);
  ok("ca.session.csv.unused", csv.indexOf("unusedPalette") > 0);
  ok("ca.session.csv.unused-hex", csv.indexOf("#4b0082") > 0);
  ok("ca.session.csv.crlf", csv.endsWith("\r\n"));
  ok("ca.session.csv.scope", csv.indexOf("layer") > 0);
  ok("ca.session.csv.ratios", csv.indexOf("25.000%") > 0);
}

function testSessionReplaceAndSelect(): void {
  stubEnv();
  const s = new Session();
  const doc = s.doc;
  doc.w = 2; doc.h = 2;
  const cel = doc.ensureCel(0, 0);
  const original = buf(2, 2, (x, y) => (y === 0 ? RED : x === 0 ? GREEN : BLUE));
  cel.data.set(original);
  doc.palette = [];
  doc.sel = null;
  s.setIndexed(false);
  s.history.clear();
  // --- 一条历史：整块替换 + undo 逐字节还原 ---
  const n = s.replaceColour(RED, [255, 255, 255, 255], { scope: "layer", tolerance: 0 });
  eq("ca.session.replace.changed", n, 2);
  eq("ca.session.replace.pixel", px(cel.data, 2, 0, 0), [255, 255, 255, 255]);
  eq("ca.session.replace.history", s.history.list().labels, ["colour-replace"]);
  s.undo();
  eq("ca.session.replace.undo-bytes", Array.from(cel.data), Array.from(original));
  ok("ca.session.replace.undo-no-redo-needed", !s.history.canUndo());
  s.redo();
  eq("ca.session.replace.redo-pixel", px(cel.data, 2, 0, 0), [255, 255, 255, 255]);
  s.undo();
  s.history.clear();

  // --- 容差：10 阶内的近似色一起换 ---
  cel.data.set(buf(2, 2, (x, y) => (y === 0 ? (x === 0 ? RED : [248, 4, 4, 255] as RGBA) : (x === 0 ? GREEN : BLUE))));
  eq("ca.session.replace.tol.changed", s.replaceColour(RED, [0, 0, 0, 255], { scope: "layer", tolerance: 10 }), 2);
  eq("ca.session.replace.tol.blue-kept", px(cel.data, 2, 1, 1), BLUE);
  s.undo();
  s.history.clear();

  // --- 选区范围：选区外的同色像素不动 ---
  cel.data.set(buf(2, 2, () => RED));
  doc.sel = new Sel(2, 2);
  doc.sel.set(0, 0, 1);
  eq("ca.session.replace.sel.changed", s.replaceColour(RED, [0, 0, 0, 255], { scope: "selection" }), 1);
  eq("ca.session.replace.sel.inside", px(cel.data, 2, 0, 0), [0, 0, 0, 255]);
  eq("ca.session.replace.sel.outside", px(cel.data, 2, 1, 1), RED);
  s.undo();
  s.history.clear();
  // 没有选区时选区范围什么都不做（也不记历史）
  doc.sel = null;
  eq("ca.session.replace.no-sel", s.replaceColour(RED, [0, 0, 0, 255], { scope: "selection" }), 0);
  ok("ca.session.replace.no-sel-history", !s.history.canUndo());

  // --- 索引色模式：目标色吸附到最近的调色板色 ---
  doc.palette = [[0, 128, 0, 255], [0, 0, 128, 255]];
  s.setIndexed(true);
  cel.data.set(buf(2, 2, () => RED));
  s.replaceColour(RED, [200, 40, 40, 255], { scope: "layer" });
  eq("ca.session.replace.indexed-snap", px(cel.data, 2, 0, 0), [0, 128, 0, 255]);
  s.undo();
  s.history.clear();
  // 索引色关闭时用原样的目标色
  s.setIndexed(false);
  cel.data.set(buf(2, 2, () => RED));
  s.replaceColour(RED, [200, 40, 40, 255], { scope: "layer" });
  eq("ca.session.replace.raw-target", px(cel.data, 2, 0, 0), [200, 40, 40, 255]);
  s.undo();
  s.history.clear();

  // --- 所有帧范围：两帧的同色像素一次改完，undo 一次全回（逐字节） ---
  s.frameAdd();
  s.history.clear();
  const f0 = doc.ensureCel(0, 0), f1 = doc.ensureCel(0, 1);
  f0.data.set(buf(2, 2, (x, y) => (y === 0 ? RED : x === 0 ? GREEN : BLUE)));
  f1.data.set(buf(2, 2, (x, y) => (x === 0 && y === 0 ? RED : null)));
  const beforeF0 = new Uint8ClampedArray(f0.data);
  const beforeF1 = new Uint8ClampedArray(f1.data);
  eq("ca.session.replace.allFrames", s.replaceColour(RED, [1, 2, 3, 255], { scope: "allFrames" }), 3);
  eq("ca.session.replace.allFrames.f1", px(f1.data, 2, 0, 0), [1, 2, 3, 255]);
  eq("ca.session.replace.allFrames.f0", px(f0.data, 2, 0, 0), [1, 2, 3, 255]);
  eq("ca.session.replace.allFrames.one-step", s.history.list().labels, ["colour-replace"]);
  s.undo();
  eq("ca.session.replace.allFrames.undo-f0", Array.from(f0.data), Array.from(beforeF0));
  eq("ca.session.replace.allFrames.undo-f1", Array.from(f1.data), Array.from(beforeF1));
  s.history.clear();

  // --- mergeColourGroup：组内成员各一条替换，全部进同一条历史 ---
  cel.data.set(buf(2, 2, (x, y) => (y === 0 ? (x === 0 ? RED : [250, 3, 3, 255] as RGBA) : GREEN)));
  const merged = s.mergeColourGroup(RED, [RED, [250, 3, 3, 255] as RGBA], "layer");
  eq("ca.session.merge.changed", merged, 1);
  eq("ca.session.merge.pixel", px(cel.data, 2, 1, 0), RED);
  // 代表色自己不会被"替换"（没有多余的历史步），只留一条
  s.history.clear();
  cel.data.set(buf(2, 2, (x, y) => (y === 0 ? (x === 0 ? RED : [250, 3, 3, 255] as RGBA) : GREEN)));
  s.mergeColourGroup(RED, [RED, [250, 3, 3, 255] as RGBA], "layer");
  eq("ca.session.merge.one-step", s.history.list().labels, ["colour-replace"]);
  s.history.clear();

  // --- selectColourPixels：掩码正确 + 选区变更走一条历史 ---
  doc.sel = null;
  cel.data.set(buf(2, 2, (x, y) => (y === 0 ? RED : x === 0 ? BLUE : null)));
  const hit = s.selectColourPixels(RED, 0, "layer");
  eq("ca.session.select.count", hit, 2);
  eq("ca.session.select.mask", [doc.sel!.get(0, 0), doc.sel!.get(1, 0), doc.sel!.get(0, 1), doc.sel!.get(1, 1)], [1, 1, 0, 0]);
  ok("ca.session.select.history", s.history.list().labels.indexOf("colour-select") >= 0);
  s.undo();
  eq("ca.session.select.undo", doc.sel === null || !doc.sel.hasAny(), true);
  // 容差命中近似色；范围 = 画布时把其它图层的命中也算进来
  s.history.clear();
  doc.sel = null;
  cel.data.set(buf(2, 2, (x, y) => (y === 0 ? (x === 0 ? RED : [252, 1, 1, 255] as RGBA) : BLUE)));
  s.layerAdd();
  doc.ensureCel(1, 0).data.set(buf(2, 2, (x, y) => (x === 1 && y === 1 ? [251, 2, 2, 255] as RGBA : null)));
  eq("ca.session.select.canvas-scope", s.selectColourPixels(RED, 8, "canvas"), 3);
  doc.sel = null;
  // 全选等于没有选区（文档 64×64，像素级全选只有把每个像素都涂上才可能；
  // 这里用「整张画布都是红」构造一次真正的全选）
  doc.w = 2; doc.h = 2; doc.sel = null; doc.cels.clear();
  const c2 = doc.ensureCel(0, 0);
  c2.data.set(buf(2, 2, () => RED));
  eq("ca.session.select.all", s.selectColourPixels(RED, 0, "layer"), 4);
  eq("ca.session.select.all-cleared", doc.sel!.hasAny(), false);
  // 没命中：留下空选区
  doc.sel = null;
  c2.data.set(buf(2, 2, () => BLUE));
  eq("ca.session.select.miss", s.selectColourPixels(RED, 0, "layer"), 0);
  eq("ca.session.select.miss-empty", doc.sel!.hasAny(), false);
  doc.w = 64; doc.h = 64; doc.cels.clear();
}

function testSessionDegenerate(): void {
  stubEnv();
  const s = new Session();
  const doc = s.doc;
  // 缩成 1×1 并丢掉旧 cel（Doc 改尺寸不会重算已有 cel 的大小）
  doc.cels.clear();
  doc.w = 1; doc.h = 1;
  doc.sel = null;
  s.history.clear();
  // 空画布（没有任何 cel）
  const empty = s.analyseCanvas("layer");
  eq("ca.session.empty.total", empty.totalPixels, 1);
  eq("ca.session.empty.colours", empty.colourCount, 0);
  // 空画布上替换 / 选区都不炸
  eq("ca.session.empty.replace", s.replaceColour(RED, BLUE, { scope: "layer" }), 0);
  eq("ca.session.empty.select", s.selectColourPixels(RED, 0, "layer"), 0);
  // 单色画布（1×1）
  doc.ensureCel(0, 0).data.set([7, 8, 9, 255]);
  const one = s.analyseCanvas("layer");
  eq("ca.session.single.colours", one.colourCount, 1);
  eq("ca.session.single.ratio", one.entries[0].ratio, 1);
  eq("ca.session.single.ratio-opaque", one.entries[0].ratioOfOpaque, 1);
  // 半透明画布：分类正确（同一块数据放大到 2×2 也一样，这里改用 2×2 文档）
  doc.cels.clear();
  doc.w = 2; doc.h = 2;
  doc.ensureCel(0, 0).data.set(buf(2, 2, (x) => (x === 0 ? [1, 1, 1, 128] as RGBA : [1, 1, 1, 255] as RGBA)));
  const semi = s.analyseCanvas("layer");
  eq("ca.session.semi.opaque", semi.opaquePixels, 2);
  eq("ca.session.semi.semi", semi.semiPixels, 2);
  eq("ca.session.semi.colours", semi.colourCount, 2);
  doc.cels.clear();
  doc.w = 1; doc.h = 1;
  // 该数据在 RGBA 空间里长度不匹配时也不越界（cel 只有 1 像素的数据）
  doc.ensureCel(0, 0).data = new Uint8ClampedArray(4);
  eq("ca.session.short-cel.total", s.analyseCanvas("layer").totalPixels, 1);
}

// 让 tsc 保留上面那条副作用导入（see_modals 只用于此处）
export const CA_MODALS_LOADED: boolean = typeof modalsModule.ColorAdvancedModal === "function";

export function testColorAnalysis(): void {
  testColourKey();
  testAnalyze();
  testAnalyzeCountsAndSort();
  testClearAndDegenerate();
  testHistogram();
  testPaletteHits();
  testGroups();
  testReplaceTolerance();
  testReplaceAlphaRules();
  testReplaceScope();
  testSelectByColour();
  testFlatten();
  testSessionAnalysis();
  testSessionReplaceAndSelect();
  testSessionDegenerate();
  testColorAnalysisPanel();
}

// ------------------------------------------------------------ 面板接线（静态扫描）
//
// 没有 DOM，所以面板本身跑不起来；这里用静态扫描锁住三件容易漏的事：
//   1. 弹窗真的被 App 渲染了、ModalId 真的加了（否则入口点了没反应）
//   2. 两个入口（调色板面板的动作行 + 主菜单）都在
//   3. 面板里的统计表 / 直方图 / 近似色合并 / 替换区都有 data-guide 锚点
export function testColorAnalysisPanel(): void {
  const uiDir = __dirname + "/../../../src/ui";
  const read = (f: string): string => fs.readFileSync(uiDir + "/" + f, "utf8");
  const app = read("App.tsx");
  const modals = read("modals.tsx");

  // 与「色彩明暗」合并成「颜色高级模式」之后：一个 ModalId、一个入口（明暗页由页签切换）
  ok("ca.panel.modal-id", /"coloradv"/.test(modals), "ModalId 里没有 coloradv");
  ok("ca.panel.keep-rendered", /modal === "coloradv"/.test(app), "App 没有渲染 ColorAdvancedModal");
  ok("ca.panel.imported", /ColorAdvancedModal/.test(app));
  ok("ca.panel.open-event-listener", /pc-color-adv/.test(app), "App 没有监听打开事件");
  ok("ca.panel.palette-entry", /guide="pal-color-adv"/.test(modals), "调色板面板没有入口");
  ok("ca.panel.menu-entry", /go\("coloradv"\)/.test(modals), "主菜单没有入口");
  // 合并之后不该再有旧的两个入口 / 旧 ModalId
  ok("ca.panel.merged.no-old-entry", modals.indexOf("pal-shading") < 0 && modals.indexOf("pal-color-analysis") < 0);
  // ModalId 联合类型里不该再留着旧的两个 id（"shading" 作为页签名仍然存在，所以只查那一行）
  const modalIdLine = modals.split("\n").find((l) => l.indexOf("export type ModalId") === 0) || "";
  ok("ca.panel.merged.no-old-id", modalIdLine.indexOf("\"coloranalysis\"") < 0 && modalIdLine.indexOf("\"shading\"") < 0
    && modalIdLine.indexOf("\"coloradv\"") >= 0, modalIdLine.slice(0, 80));
  ok("ca.panel.merged.tabs", modals.indexOf("cadv-tab-analysis") >= 0 && modals.indexOf("cadv-tab-shading") >= 0);
  for (const a of ["ca-hint", "ca-scope-canvas", "ca-scope-layer", "ca-scope-selection", "ca-scope-frames", "ca-ops", "ca-table", "ca-hist", "ca-replace", "ca-run", "dlg-color-analysis"]) {
    ok("ca.panel.anchor." + a, modals.indexOf(a) >= 0, "缺少锚点 " + a);
  }
  // 面板必须走 Session 的接口，不能自己重写一遍统计/替换
  for (const api of ["analyseCanvas", "replaceColour", "selectColourPixels", "colourGroups", "mergeColourGroup", "exportColourStatsCsv"]) {
    ok("ca.panel.uses." + api, modals.indexOf("SESSION." + api) >= 0, "面板没用 " + api);
  }
  // 面板不许自己写死颜色：色块一律走 chipCss（诚实显示不透明度）
  ok("ca.panel.chipCss", modals.indexOf("chipCss(e.rgba)") >= 0 && modals.indexOf("chipCss(from)") >= 0);

  // 真渲染一遍：没有 jsdom，但 react-dom/server 能把面板的 DOM 结构吐出来。
  // 这一条能抓住"面板打不开/渲染就抛"这类错误（静态扫描看不到）。
  // 必须在 stubEnv 之后 require：session/singleton 在模块加载时就建实例。
  stubEnv();
  /* eslint-disable @typescript-eslint/no-var-requires */
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  eq("ca.panel.markup.exported", CA_MODALS_LOADED, true);
  const { ColorAdvancedModal } = modalsModule;
  const { SESSION } = require(SRC + "/ui/singleton");
  const { makeT } = require(SRC + "/ui/i18n");
  const d = SESSION.doc;
  d.cels.clear();
  d.w = 2; d.h = 2; d.sel = null;
  const cel = d.ensureCel(0, 0);
  cel.data.set(buf(2, 2, (x, y) => (y === 0 ? (x === 0 ? RED : [251, 2, 2, 255] as RGBA) : (x === 0 ? GREEN : BLUE))));
  // 三个板色都被"用到"（蓝归到最近的黑），第四个才是真正没用到的
  d.palette = [[9, 9, 9, 255], [0, 255, 0, 255], [255, 0, 0, 255], [75, 0, 130, 255]];
  const html: string = renderToStaticMarkup(React.createElement(ColorAdvancedModal, {
    t: makeT("zh"), onClose: () => { /* noop */ }, initialTab: "analysis",
  }));
  ok("ca.panel.markup.renders", html.length > 200, "len=" + html.length);
  ok("ca.panel.markup.dialog", html.indexOf('data-guide="dlg-color-analysis"') >= 0);
  ok("ca.panel.markup.hex", html.indexOf("#ff0000") >= 0 && html.indexOf("#fb0202") >= 0, "统计表里应有红与近红");
  eq("ca.panel.markup.rows", (html.match(/class="ca-row"/g) || []).length, 4);
  ok("ca.panel.markup.hist", (html.match(/class="ca-hcell"/g) || []).length >= 36, "三条直方图共 12~24 格 ×3");
  ok("ca.panel.markup.unused", html.indexOf("ca-unused") >= 0, "未使用板色应有一块");
  ok("ca.panel.markup.scope", html.indexOf("ca-scope-canvas") >= 0 && html.indexOf("ca-scope-frames") >= 0);
  ok("ca.panel.markup.replace", html.indexOf('data-guide="ca-replace"') >= 0 && html.indexOf('data-guide="ca-run"') >= 0);
  ok("ca.panel.markup.no-raw-inline-colour", html.indexOf("rgb(9,9,9)") < 0);
}
