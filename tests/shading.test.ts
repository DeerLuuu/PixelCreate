// 色彩明暗（Color Shading）—— 移植自 Aseprite 脚本 "Color Shading v5.0" 的
// 调色板生成器。前半是纯引擎用例（色阶的形状与不变量），后半把面板真渲染一遍
// （react-dom/server），保证弹窗不会一打开就抛。
import { rgbToHsl } from "../src/engine/adjust";
import {
  SHADING_DEFAULTS, SHADING_ROWS, SHADING_SLOTS_MAX, SHADING_SLOTS_MIN,
  dedupeColours, flatRamps, normalizeParams, normalizeSlots, shadingHarmonics, shadingRamps,
} from "../src/engine/shading";
import type { ShadingParams } from "../src/engine/shading";
import type { RGBA } from "../src/engine/types";
import { stubEnv } from "./session.test";
import { eq, ok } from "./common";

declare const require: (m: string) => any;
declare const __dirname: string;
const nodePath = require("path");
/** **已编译**的 src/ 目录（用例跑在 <app>/tests/.ts-out/tests） */
const SRC = nodePath.resolve(__dirname, "../src");

const ORANGE: RGBA = [230, 126, 34, 255];
const BLUE: RGBA = [41, 128, 185, 255];

const lum = (c: RGBA): number => rgbToHsl(c[0], c[1], c[2])[2];
const hue = (c: RGBA): number => rgbToHsl(c[0], c[1], c[2])[0];
/** 色相环上的最短距离（度） */
const hueGap = (a: number, b: number): number => {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return Math.min(d, 360 - d);
};

export function testShading(): void {
  // --- 默认值就是 Lua 原版的默认（改了要一起改文档）---
  eq("shading.defaults.slots", SHADING_DEFAULTS.slots, 7);
  eq("shading.defaults.intensity", SHADING_DEFAULTS.intensity, 40);
  eq("shading.defaults.peak", SHADING_DEFAULTS.peak, 60);
  eq("shading.defaults.sway", SHADING_DEFAULTS.sway, 60);
  eq("shading.defaults.lowtemp", SHADING_DEFAULTS.lowTemp, 215);
  eq("shading.defaults.hightemp", SHADING_DEFAULTS.highTemp, 50);
  eq("shading.rows.count", SHADING_ROWS.length, 6);

  // --- slots 永远落在 3..25 的奇数上（Lua 的 onchange 把偶数 +1）---
  eq("shading.slots.even-bumped", normalizeSlots(8), 9);
  eq("shading.slots.low-clamped", normalizeSlots(2), SHADING_SLOTS_MIN);
  eq("shading.slots.high-clamped", normalizeSlots(30), SHADING_SLOTS_MAX);
  eq("shading.slots.keeps-odd", normalizeSlots(15), 15);
  eq("shading.params.slots-normalised", normalizeParams({ slots: 4 }).slots, 5);
  eq("shading.params.temp-wrapped", normalizeParams({ lowTemp: -40 }).lowTemp, 320);

  // --- 六条色阶都是 slots 个色块 ---
  const r7 = shadingRamps(ORANGE, BLUE, { slots: 7 });
  for (const row of SHADING_ROWS) eq("shading.row.len." + row, r7[row].length, 7);

  // --- 正中间那格**逐位等于基色**（整套配色的锚点）---
  eq("shading.middle.shade", r7.shade[3], ORANGE);
  eq("shading.middle.light", r7.light[3], ORANGE);
  eq("shading.middle.sat", r7.sat[3], ORANGE);
  eq("shading.middle.nuance", r7.nuance[3], ORANGE);

  // --- 明暗：中间往两端走，暗端更暗、亮端更亮；色阶单调 ---
  ok("shading.light.dark-end-darker", lum(r7.light[0]) < lum(ORANGE) - 0.1, "l=" + lum(r7.light[0]).toFixed(3));
  ok("shading.light.bright-end-brighter", lum(r7.light[6]) > lum(ORANGE) + 0.1, "l=" + lum(r7.light[6]).toFixed(3));
  let monoLight = true;
  for (let i = 1; i <= 3; i++) if (lum(r7.light[i]) <= lum(r7.light[i - 1])) monoLight = false;
  for (let i = 5; i <= 6; i++) if (lum(r7.light[i]) <= lum(r7.light[i - 1])) monoLight = false;
  ok("shading.light.monotonic", monoLight);
  ok("shading.shade.dark-end-darker", lum(r7.shade[0]) < lum(ORANGE), "l=" + lum(r7.shade[0]).toFixed(3));
  ok("shading.shade.bright-end-brighter", lum(r7.shade[6]) > lum(ORANGE), "l=" + lum(r7.shade[6]).toFixed(3));

  // --- 暗部往「暗部温度」偏、亮部往「亮部温度」偏；sway=0 时完全不偏 ---
  const dark = r7.shade[0];
  ok("shading.shade.dark-cools", hueGap(hue(dark), SHADING_DEFAULTS.lowTemp) < hueGap(hue(dark), hue(ORANGE)),
    "h=" + hue(dark).toFixed(1));
  const light = r7.shade[6];
  ok("shading.shade.light-warms", hueGap(hue(light), SHADING_DEFAULTS.highTemp) < hueGap(hue(light), hue(ORANGE)),
    "h=" + hue(light).toFixed(1));
  const rSway0 = shadingRamps(ORANGE, BLUE, { sway: 0 });
  ok("shading.sway0.keeps-hue", hueGap(hue(rSway0.shade[0]), hue(ORANGE)) < 1.5 && hueGap(hue(rSway0.shade[6]), hue(ORANGE)) < 1.5,
    "dark=" + hue(rSway0.shade[0]).toFixed(1) + " light=" + hue(rSway0.shade[6]).toFixed(1));
  ok("shading.sway0.still-shades", lum(rSway0.shade[0]) < lum(ORANGE) && lum(rSway0.shade[6]) > lum(ORANGE));

  // --- 温度拉满时，暗端色相更贴近温度色（sway 越大越像）---
  const half = shadingRamps(ORANGE, BLUE, { sway: 50 }).shade[0];
  const full = shadingRamps(ORANGE, BLUE, { sway: 100 }).shade[0];
  ok("shading.sway.monotonic", hueGap(hue(full), SHADING_DEFAULTS.lowTemp) < hueGap(hue(half), SHADING_DEFAULTS.lowTemp));

  // --- Mix 行：基色 → 另一个基色，按 i/(slots+1) 线性走，两端都不取满 ---
  eq("shading.mix.first", r7.mix[0], [
    Math.round(ORANGE[0] * (7 / 8) + BLUE[0] * (1 / 8)),
    Math.round(ORANGE[1] * (7 / 8) + BLUE[1] * (1 / 8)),
    Math.round(ORANGE[2] * (7 / 8) + BLUE[2] * (1 / 8)),
    255,
  ]);
  ok("shading.mix.reaches-other",
    Math.abs(r7.mix[6][0] - Math.round(ORANGE[0] * (1 / 8) + BLUE[0] * (7 / 8))) <= 1);
  ok("shading.mix.monotonic", r7.mix[0][2] < r7.mix[6][2]);

  // --- Hue 行：沿色环等距推进 i/(slots+1) 圈 ---
  for (let i = 1; i <= 7; i++) {
    const want = (hue(ORANGE) + (i / 8) * 360) % 360;
    ok("shading.hue.step." + i, hueGap(hue(r7.hue[i - 1]), want) < 3,
      "i=" + i + " got=" + hue(r7.hue[i - 1]).toFixed(1) + " want=" + want.toFixed(1));
  }

  // --- Nuance 行：偏移很小，而且正负对称（中间那格就是基色）---
  ok("shading.nuance.small", hueGap(hue(r7.nuance[0]), hue(ORANGE)) < 40 && hueGap(hue(r7.nuance[0]), hue(ORANGE)) > 1,
    "gap=" + hueGap(hue(r7.nuance[0]), hue(ORANGE)).toFixed(1));
  ok("shading.nuance.symmetric",
    Math.abs(hueGap(hue(r7.nuance[0]), hue(ORANGE)) - hueGap(hue(r7.nuance[6]), hue(ORANGE))) < 3);

  // --- alpha 一路带着走（Lua 的 mixColors 会重置成 255，这里刻意保留）---
  const semi: RGBA = [230, 126, 34, 128];
  const rA = shadingRamps(semi, [41, 128, 185, 64], { slots: 5 });
  const noMix = SHADING_ROWS.filter((row) => row !== "mix");
  ok("shading.alpha.base-kept", noMix.every((row) => rA[row].every((c) => c[3] === 128)));
  eq("shading.alpha.mix-blends", rA.mix[0][3], Math.round(128 * (5 / 6) + 64 * (1 / 6)));

  // --- 3 槽位：首尾就是最暗 / 最亮，中间是基色 ---
  const r3 = shadingRamps(ORANGE, BLUE, { slots: 3 });
  eq("shading.slots3.len", r3.light.length, 3);
  eq("shading.slots3.middle", r3.light[1], ORANGE);
  ok("shading.slots3.ends", lum(r3.light[0]) < lum(ORANGE) && lum(r3.light[2]) > lum(ORANGE));

  // --- 和声配色：补 180°、三角 120/240、四角 90/180/270 ---
  const hm = shadingHarmonics(ORANGE);
  eq("shading.harm.compl.len", hm.complementary.length, 2);
  eq("shading.harm.triad.len", hm.triadic.length, 3);
  eq("shading.harm.tetrad.len", hm.tetradic.length, 4);
  eq("shading.harm.compl.base", hm.complementary[0], ORANGE);
  ok("shading.harm.compl.180", hueGap(hue(hm.complementary[1]), (hue(ORANGE) + 180) % 360) < 3);
  ok("shading.harm.triad.120", hueGap(hue(hm.triadic[1]), (hue(ORANGE) + 120) % 360) < 3);
  ok("shading.harm.triad.240", hueGap(hue(hm.triadic[2]), (hue(ORANGE) + 240) % 360) < 3);
  ok("shading.harm.tetrad.90", hueGap(hue(hm.tetradic[1]), (hue(ORANGE) + 90) % 360) < 3);
  ok("shading.harm.tetrad.180", hueGap(hue(hm.tetradic[2]), (hue(ORANGE) + 180) % 360) < 3);
  ok("shading.harm.tetrad.270", hueGap(hue(hm.tetradic[3]), (hue(ORANGE) + 270) % 360) < 3);

  // --- 「加入调色板」用的摊平列表：去重、保序、条数对得上 ---
  const flat = flatRamps(r7);
  const keys = new Set(flat.map((c) => c.join(",")));
  eq("shading.flat.unique", keys.size, flat.length);
  ok("shading.flat.keeps-order", flat[0].join(",") === r7.shade[0].join(",") && flat[flat.length - 1].join(",") === r7.hue[6].join(","));
  ok("shading.flat.subset", flat.length > 6 * 7 - 8 && flat.length <= 6 * 7, "len=" + flat.length);
  eq("shading.flat.node-dup", flatRamps(r7, SHADING_ROWS, false).length, 6 * 7);

  // --- 参数越界不会算出怪东西（UI 每次改动都过 normalizeParams）---
  const wild: ShadingParams = normalizeParams({ slots: 25, intensity: 9999, peak: -5, sway: 12345, lowTemp: 720 });
  ok("shading.params.clamped", wild.slots === 25 && wild.intensity === 200 && wild.peak === 1 && wild.sway === 100 && wild.lowTemp === 0,
    JSON.stringify(wild));

  // --- 「加入色板 / 存为新色卡」用的去重：保持顺序、不重复 ---
  eq("shading.dedupe.removes", dedupeColours([ORANGE, BLUE, ORANGE, BLUE, ORANGE]).length, 2);
  eq("shading.dedupe.order", dedupeColours([BLUE, ORANGE, BLUE])[0], BLUE);
  eq("shading.dedupe.empty", dedupeColours([]).length, 0);

  // --- 面板 SSR 冒烟：能渲染出六条色阶 + 基色 + 温度色块 + 每行的两个色卡按钮 ---
  stubEnv();
  /* eslint-disable @typescript-eslint/no-var-requires */
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { ShadingModal } = require(SRC + "/ui/modals");
  const { makeT } = require(SRC + "/ui/i18n");
  const html: string = renderToStaticMarkup(
    React.createElement(ShadingModal, { t: makeT("zh"), onClose: () => { /* noop */ }, onOpenPalette: () => { /* noop */ } }),
  );
  ok("shading.panel.markup.renders", html.length > 400, "len=" + html.length);
  ok("shading.panel.markup.dialog", html.indexOf('data-guide="dlg-shading"') >= 0);
  ok("shading.panel.markup.rows", SHADING_ROWS.every((row) => html.indexOf('data-guide="sh-row-' + row + '"') >= 0));
  const swatches = (html.match(/class="sh-swatch/g) || []).length;
  eq("shading.panel.markup.swatches", swatches, 6 * 7 + 2 + 2); // 六行 × 7 格 + 两个基色 + 两个温度色
  ok("shading.panel.markup.base", html.indexOf('data-guide="sh-base-a"') >= 0 && html.indexOf('data-guide="sh-base-b"') >= 0);
  ok("shading.panel.markup.temps", html.indexOf('data-guide="sh-temp-dark"') >= 0 && html.indexOf('data-guide="sh-temp-light"') >= 0);
  ok("shading.panel.markup.actions", html.indexOf('data-guide="sh-to-palette"') >= 0 && html.indexOf('data-guide="sh-reset"') >= 0);
  // 每行两个小动作：整行加入当前色卡 / 整行存为新色卡（六行都要有）
  ok("shading.panel.markup.row-add", SHADING_ROWS.every((row) => html.indexOf('data-guide="sh-row-' + row + '-add"') >= 0));
  ok("shading.panel.markup.row-save", SHADING_ROWS.every((row) => html.indexOf('data-guide="sh-row-' + row + '-save"') >= 0));
  // 基色块可点（打开调色板换色）——虚线边是它的外观标记
  eq("shading.panel.markup.pick", (html.match(/class="sh-swatch big pick"/g) || []).length, 2);
  // 色块一律走 chipCss（诚实显示不透明度），面板不许自己拼颜色
  ok("shading.panel.markup.no-raw-rgb", html.indexOf("rgb(230,126,34)") < 0);
  // 面板只通过公开 API 落库：加入色卡 / 存成新色卡 / 取色（读的是**源码**，不是编译产物）
  const modals = require("fs").readFileSync(nodePath.resolve(__dirname, "../../../src/ui/modals.tsx"), "utf8");
  for (const api of ["paletteMerge", "savePalettePresetOf", "awaitColorPick"]) {
    ok("shading.panel.uses." + api, modals.indexOf("SESSION." + api) >= 0, "面板没用 " + api);
  }
}

/** 「存为新色卡」只往 myPalettes 里加一条，不动用户眼下的色板 */
export function testShadingPaletteSave(): void {
  stubEnv();
  const { Session } = require(SRC + "/app/session");
  const s = new Session();
  const before = s.doc.palette.map((c: RGBA) => c.join(","));
  const n = s.myPalettes.length;
  const name = s.savePalettePresetOf([[1, 2, 3, 255], [4, 5, 6, 255]], "明暗测试");
  eq("shading.save.name", name, "明暗测试");
  eq("shading.save.added", s.myPalettes.length, n + 1);
  const saved = s.myPalettes[s.myPalettes.length - 1];
  eq("shading.save.hex", saved.colors.join(","), "#010203,#040506");
  eq("shading.save.keeps-doc-palette", s.doc.palette.map((c: RGBA) => c.join(",")).join("|"), before.join("|"));
  eq("shading.save.empty", s.savePalettePresetOf([]), "");
  eq("shading.save.empty-not-added", s.myPalettes.length, n + 1);
  // 存进去的能在面板里删掉（走既有 API）
  ok("shading.save.deletable", s.deletePalettePreset(saved.id));
}
