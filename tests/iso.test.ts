// 等距图形（2:1 像素几何）—— 引擎回归。
//
// 这一组用例的作用是**把像素几何口径钉死**（docs/PLAN-isobuilder.md §2）：
// 行宽模板、立方体外框、遮挡顺序、三面着色、接触阴影、描边、形状不变量、性能上限。
// 口径一旦改动，这些黄金值会先红，避免「看着不对但说不清哪里不对」。
import { rgbToHsl } from "../src/engine/adjust";
import {
  ISO_MAX_VOXELS, ISO_SHAPE_DEFAULTS, ISO_TILES, isoDiamondRows, isoFaceColours, isoHexRows,
  isoRender, isoShapeVoxels, isoShadowOffset, isoWithinBudget, normalizeShapeParams,
  voxelAt, voxelCount,
} from "../src/engine/iso";
import type { IsoLook, IsoShapeParams, IsoTile } from "../src/engine/iso";
import type { RGBA } from "../src/engine/types";
import { eq, ok } from "./common";

const BASE: RGBA = [200, 140, 90, 255];
const TOP: RGBA = [255, 210, 160, 255];
const RIGHT: RGBA = [200, 140, 90, 255];
const LEFT: RGBA = [120, 80, 50, 255];

function look(tile: IsoTile, over: Partial<IsoLook> = {}): IsoLook {
  return {
    tile, faces: { top: TOP, right: RIGHT, left: LEFT },
    shadow: "off", shadowColor: [0, 0, 0, 90], outline: false, outlineColor: [20, 20, 20, 255],
    ...over,
  };
}

/** 第 y 行有多少不透明像素（越界返回 -1） */
function rowWidth(px: Uint8ClampedArray, w: number, h: number, y: number): number {
  if (y < 0 || y >= h) return -1;
  let n = 0;
  for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3] !== 0) n++;
  return n;
}

/** 每一行不透明像素必须是一段连续的 run：等距体是行凸的，出现断裂就是 stamp 错位/有洞 */
function rowConvex(px: Uint8ClampedArray, w: number, h: number): boolean {
  for (let y = 0; y < h; y++) {
    let seen = false, ended = false;
    for (let x = 0; x < w; x++) {
      const on = px[(y * w + x) * 4 + 3] !== 0;
      if (on && ended) return false;
      if (on) seen = true;
      else if (seen) ended = true;
    }
  }
  return true;
}

/** 4 邻域膨胀后的像素数（描边测试用） */
function dilatedArea(px: Uint8ClampedArray, w: number, h: number): number {
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && px[(y * w + x) * 4 + 3] !== 0;
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (on(x, y) || on(x - 1, y) || on(x + 1, y) || on(x, y - 1) || on(x, y + 1)) n++;
    }
  }
  return n;
}

/** 统计某个颜色（精确相等）的像素数 */
function countColour(px: Uint8ClampedArray, c: RGBA): number {
  let n = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i] === c[0] && px[i + 1] === c[1] && px[i + 2] === c[2] && px[i + 3] === c[3]) n++;
  }
  return n;
}

const shape = (over: Partial<IsoShapeParams>): Partial<IsoShapeParams> => ({ ...ISO_SHAPE_DEFAULTS, ...over });

export function testIso(): void {
  // --- 行宽模板：与文档里的黄金值逐项相等 ---
  eq("iso.tiles.list", ISO_TILES.join(","), "4,8,16,32");
  eq("iso.diamond.t4", isoDiamondRows(4).join(","), "2,2");
  eq("iso.hex.t4", isoHexRows(4).join(","), "2,4,4,2");
  eq("iso.diamond.t16", isoDiamondRows(16).join(","), "2,6,10,14,14,10,6,2");
  eq("iso.diamond.t8", isoDiamondRows(8).join(","), "2,6,6,2");
  eq("iso.hex.t16", isoHexRows(16).join(","), "2,6,10,14,16,16,16,16,16,16,16,16,14,10,6,2");
  eq("iso.hex.t8", isoHexRows(8).join(","), "2,6,8,8,8,8,6,2");
  eq("iso.hex.t32.rows", isoHexRows(32).length, 32);
  // 菱形面积 = T²/4（顶面），六边形面积 = 3T²/4（立方体轮廓）
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  for (const t of ISO_TILES) {
    eq("iso.area.diamond." + t, sum(isoDiamondRows(t)), (t * t) / 4);
    eq("iso.area.hex." + t, sum(isoHexRows(t)), (3 * t * t) / 4);
  }

  // --- 1×1×1 立方体：T×T 外框 + 逐行宽度等于黄金值 ---
  for (const t of ISO_TILES) {
    const r = isoRender(isoShapeVoxels(shape({ w: 1, d: 1, h: 1 })), look(t));
    eq("iso.cube.size." + t, [r.w, r.h], [t, t]);
    eq("iso.cube.voxels." + t, r.voxels, 1);
    eq("iso.cube.area." + t, r.pixels, (3 * t * t) / 4);
    eq("iso.cube.origin." + t, [r.originAt.x, r.originAt.y], [0, 0]);   // 锚点 = 格 (0,0) 的 stamp 左上角
    const rows: number[] = [];
    for (let y = 0; y < r.h; y++) rows.push(rowWidth(r.px, r.w, r.h, y));
    eq("iso.cube.rows." + t, rows.join(","), isoHexRows(t).join(","));
    // 顶面 64/4 格像素、两个侧面各 1/4
    eq("iso.cube.top-px." + t, countColour(r.px, TOP), (t * t) / 4);
    eq("iso.cube.right-px." + t, countColour(r.px, RIGHT), (t * t) / 4);
    eq("iso.cube.left-px." + t, countColour(r.px, LEFT), (t * t) / 4);
  }
  // 4px 是「图标尺寸」的迷你方块：4×4 外框、顶面 2×2 行宽、三个面各 4 px
  {
    const r = isoRender(isoShapeVoxels(shape({ w: 1, d: 1, h: 1 })), look(4));
    eq("iso.t4.cube", [r.w, r.h, r.pixels], [4, 4, 12]);
    // 3×3×2：外接框 = (w+d)·T/4 宽、(w+d)·T/4 + h·T/2 高
    const plain = isoRender(isoShapeVoxels(shape({ w: 3, d: 3, h: 2 })), look(4));
    eq("iso.t4.shape.size", [plain.w, plain.h], [12, 10]);
    const deco = isoRender(isoShapeVoxels(shape({ w: 3, d: 3, h: 2 })), look(4, { shadow: "contact", outline: true }));
    // 描边左右各 1px、阴影只往右下扩（4px 图块的偏移是 (1,1)）
    const sh4 = isoShadowOffset(4);
    eq("iso.t4.deco-grows", [deco.w, deco.h], [plain.w + 2 + sh4.x, plain.h + 2 + sh4.y]);
    eq("iso.t4.shape.convex", rowConvex(deco.px, deco.w, deco.h), true);
    eq("iso.t4.shadow-offset", [isoShadowOffset(4).x, isoShadowOffset(4).y], [1, 1]);
  }

  // --- 相邻两格：外框按 (T/2, T/4) 扩展，行必须连续（无洞），近处那格盖住远处的侧面 ---
  {
    const r = isoRender(isoShapeVoxels(shape({ w: 2, d: 1, h: 1 })), look(16));
    eq("iso.two-wide.size", [r.w, r.h], [24, 20]);
    eq("iso.two-wide.voxels", r.voxels, 2);
    eq("iso.two-wide.convex", rowConvex(r.px, r.w, r.h), true);
    // 顶面两块（2×64）、左面两块（2×64），右面只有靠前那格（64）：远处的右面被挡住
    eq("iso.two-wide.top", countColour(r.px, TOP), 128);
    eq("iso.two-wide.left", countColour(r.px, LEFT), 128);
    eq("iso.two-wide.right", countColour(r.px, RIGHT), 64);
    eq("iso.two-wide.pixels", r.pixels, 320);
  }

  // --- 遮挡：叠高一层 → 下层顶面被盖掉，只留下一个顶面；侧面连成一片 ---
  {
    const r = isoRender(isoShapeVoxels(shape({ w: 1, d: 1, h: 2 })), look(16));
    eq("iso.column.voxels", r.voxels, 2);
    eq("iso.column.size", [r.w, r.h], [16, 24]);
    eq("iso.column.top-px", countColour(r.px, TOP), 64);          // 只有最上面那格露顶面
    eq("iso.column.left-px", countColour(r.px, LEFT), 128);        // 侧面连成一片
    eq("iso.column.right-px", countColour(r.px, RIGHT), 128);
    eq("iso.column.convex", rowConvex(r.px, r.w, r.h), true);
  }
  {
    // 3×3×1 平板：只有最外圈的侧面可见，内部那格的侧面全被邻居挡掉
    const r = isoRender(isoShapeVoxels(shape({ w: 3, d: 3, h: 1 })), look(16));
    eq("iso.slab.size", [r.w, r.h], [48, 32]);
    eq("iso.slab.top", countColour(r.px, TOP), 9 * 64);
    eq("iso.slab.left", countColour(r.px, LEFT), 3 * 64);
    eq("iso.slab.right", countColour(r.px, RIGHT), 3 * 64);
    eq("iso.slab.pixels", r.pixels, 15 * 64);
    eq("iso.slab.convex", rowConvex(r.px, r.w, r.h), true);
    const one = isoRender(isoShapeVoxels(shape({ w: 1, d: 1, h: 1 })), look(16));
    ok("iso.slab.larger-than-cube", r.w > one.w && r.h > one.h);
  }

  // --- 三面着色：顶面最亮、右面基色、左面最暗 ---
  {
    const f = isoFaceColours(BASE);
    const lum = (c: RGBA) => rgbToHsl(c[0], c[1], c[2])[2];
    ok("iso.faces.top-brightest", lum(f.top) > lum(f.right) && lum(f.right) > lum(f.left),
      JSON.stringify([lum(f.top), lum(f.right), lum(f.left)]));
    eq("iso.faces.right-is-base", f.right.join(","), BASE.join(","));
    // sway = 0 时不掺温度色：三面色相基本一致
    const hue = (c: RGBA) => rgbToHsl(c[0], c[1], c[2])[0];
    ok("iso.faces.no-hue-shift", Math.abs(hue(f.top) - hue(BASE)) < 6 && Math.abs(hue(f.left) - hue(BASE)) < 6,
      JSON.stringify([hue(f.top), hue(BASE), hue(f.left)]));
    // 明暗参数可用：peak 拉满时对比更大
    const hard = isoFaceColours(BASE, { peak: 90, intensity: 40 });
    ok("iso.faces.peak-works", lum(hard.top) > lum(f.top) && lum(hard.left) < lum(f.left));
  }

  // --- 接触阴影：关掉时没有半透明像素；打开时外接框变大，并在下缘露出一圈暗边 ---
  {
    const v = isoShapeVoxels(shape({ w: 2, d: 2, h: 2 }));
    const on = (r: { px: Uint8ClampedArray; w: number; h: number }, x: number, y: number) =>
      x >= 0 && y >= 0 && x < r.w && y < r.h && r.px[(y * r.w + x) * 4 + 3] !== 0;
    const semi = (r: { px: Uint8ClampedArray }) => {
      let n = 0;
      for (let i = 3; i < r.px.length; i += 4) if (r.px[i] > 0 && r.px[i] < 255) n++;
      return n;
    };
    const nonEmpty = (r: { px: Uint8ClampedArray }) => {
      let n = 0;
      for (let i = 3; i < r.px.length; i += 4) if (r.px[i] > 0) n++;
      return n;
    };
    const off = isoRender(v, look(16));
    const shadowed = isoRender(v, look(16, { shadow: "contact", shadowColor: [0, 0, 0, 120] }));
    eq("iso.shadow.off-clean", semi(off), 0);
    eq("iso.shadow.offset", isoShadowOffset(16).x > 0 && isoShadowOffset(16).y > 0, true);
    ok("iso.shadow.grows", shadowed.w > off.w && shadowed.h > off.h, JSON.stringify([off.w, off.h, shadowed.w, shadowed.h]));
    // 影子往右下偏移：露出来的那圈一定在物体的右下侧
    let rimBottom = 0;
    for (let y = 0; y < shadowed.h; y++) {
      for (let x = 0; x < shadowed.w; x++) {
        const i = (y * shadowed.w + x) * 4;
        if (shadowed.px[i + 3] === 0 || shadowed.px[i + 3] === 255) continue;
        if (y >= off.h - 2 || x >= off.w - 2) rimBottom++;
      }
    }
    ok("iso.shadow.rim-at-bottom-right", rimBottom > 0, "rim=" + rimBottom);
    ok("iso.shadow.rim-small", semi(shadowed) < off.pixels / 4, "semi=" + semi(shadowed));
    ok("iso.shadow.adds-pixels", nonEmpty(shadowed) > nonEmpty(off));
    ok("iso.shadow.keeps-outline-row", rowConvex(shadowed.px, shadowed.w, shadowed.h));
  }

  // --- 描边：沿轮廓补一圈暗边（= 形状 4 邻域膨胀出来的那一圈，含贴着缓冲边的那部分）---
  {
    const v = isoShapeVoxels(shape({ w: 1, d: 1, h: 1 }));
    const plain = isoRender(v, look(16));
    const lined = isoRender(v, look(16, { outline: true, outlineColor: [10, 10, 10, 255] }));
    ok("iso.outline.grows", lined.w === plain.w + 2 && lined.h === plain.h + 2, JSON.stringify([lined.w, lined.h]));
    const on = (x: number, y: number) =>
      x >= 0 && y >= 0 && x < plain.w && y < plain.h && plain.px[(y * plain.w + x) * 4 + 3] !== 0;
    let ring = 0;
    for (let y = -1; y <= plain.h; y++) {
      for (let x = -1; x <= plain.w; x++) {
        if (on(x, y)) continue;
        if (on(x - 1, y) || on(x + 1, y) || on(x, y - 1) || on(x, y + 1)) ring++;
      }
    }
    eq("iso.outline.ring", countColour(lined.px, [10, 10, 10, 255]), ring);
    eq("iso.outline.keeps-faces", countColour(lined.px, TOP), 64);
  }

  // --- 形状库：每个形状的不变量 ---
  {
    const box = isoShapeVoxels(shape({ shape: "box", w: 3, d: 2, h: 4 }));
    eq("iso.shape.box.count", voxelCount(box), 24);
    eq("iso.shape.box.corner", voxelAt(box, 2, 1, 3), true);
    eq("iso.shape.box.outside", voxelAt(box, 3, 0, 0), false);

    const steps = isoShapeVoxels(shape({ shape: "steps", w: 4, d: 2, h: 4, steps: 4, axis: "x" }));
    let rises = true;
    for (let x = 1; x < 4; x++) {
      const hPrev = [0, 1, 2, 3].filter((z) => voxelAt(steps, x - 1, 0, z)).length;
      const hCur = [0, 1, 2, 3].filter((z) => voxelAt(steps, x, 0, z)).length;
      if (hCur < hPrev) rises = false;
    }
    ok("iso.shape.steps.rises", rises);
    eq("iso.shape.steps.top", voxelAt(steps, 0, 0, 3), false);
    const stepsRev = isoShapeVoxels(shape({ shape: "steps", w: 4, d: 2, h: 4, steps: 4, axis: "x", dir: -1 }));
    eq("iso.shape.steps.dir", voxelAt(stepsRev, 0, 0, 3), true);

    const wedge = isoShapeVoxels(shape({ shape: "wedge", w: 4, d: 2, h: 4, axis: "x" }));
    let falls = true;
    for (let x = 1; x < 4; x++) {
      const hPrev = [0, 1, 2, 3].filter((z) => voxelAt(wedge, x - 1, 0, z)).length;
      const hCur = [0, 1, 2, 3].filter((z) => voxelAt(wedge, x, 0, z)).length;
      if (hCur > hPrev) falls = false;
    }
    ok("iso.shape.wedge.falls", falls);

    const cyl = isoShapeVoxels(shape({ shape: "cylinder", w: 9, d: 9, h: 2, radius: 4 }));
    const footprint = new Set<string>();
    for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) if (voxelAt(cyl, x, y, 0)) footprint.add(x + "," + y);
    let round = true;
    footprint.forEach((k) => {
      const [x, y] = k.split(",").map(Number);
      if (Math.hypot(x - 4, y - 4) > 4.25) round = false;
    });
    ok("iso.shape.cylinder.round", round && footprint.size > 40, "cells=" + footprint.size);
    const hollow = isoShapeVoxels(shape({ shape: "cylinder", w: 9, d: 9, h: 2, radius: 4, hollow: true, thickness: 1 }));
    eq("iso.shape.cylinder.hollow", voxelAt(hollow, 4, 4, 0), false);
    ok("iso.shape.cylinder.ring", voxelCount(hollow) > 0 && voxelCount(hollow) < voxelCount(cyl));

    const pyr = isoShapeVoxels(shape({ shape: "pyramid", w: 9, d: 9, h: 4 }));
    const w0 = [0, 1, 2, 3, 4, 5, 6, 7, 8].filter((x) => voxelAt(pyr, x, 4, 0)).length;
    const w3 = [0, 1, 2, 3, 4, 5, 6, 7, 8].filter((x) => voxelAt(pyr, x, 4, 3)).length;
    ok("iso.shape.pyramid.taper", w0 > w3 && w3 >= 1, w0 + " -> " + w3);
    ok("iso.shape.pyramid.centred", voxelAt(pyr, 4, 4, 3));

    const frame = isoShapeVoxels(shape({ shape: "frame", w: 6, d: 6, h: 3, thickness: 1 }));
    eq("iso.shape.frame.wall", voxelAt(frame, 0, 3, 1), true);
    eq("iso.shape.frame.hole", voxelAt(frame, 3, 3, 1), false);
    eq("iso.shape.frame.count", voxelCount(frame), (6 * 6 - 4 * 4) * 3);
  }

  // --- 参数夹取与体素上限 ---
  {
    const p = normalizeShapeParams({ w: 999, d: -3, h: 0, steps: 1, radius: 99, thickness: 0 });
    ok("iso.norm.clamped", p.w === 64 && p.d === 1 && p.h === 1 && p.steps >= 2 && p.thickness >= 1, JSON.stringify(p));
    eq("iso.norm.axis", normalizeShapeParams({ axis: "z" as unknown as "x" }).axis, "x");
    eq("iso.budget.small", isoWithinBudget(32, 32, 32), true);
    eq("iso.budget.big", isoWithinBudget(64, 64, 64), 64 * 64 * 64 <= ISO_MAX_VOXELS);
    eq("iso.budget.limit", ISO_MAX_VOXELS, 262144);
  }

  // --- 性能：32×32×32 的空心盒子（表面体素最多）必须在预算内 ---
  {
    const v = isoShapeVoxels(shape({ shape: "box", w: 32, d: 32, h: 32 }));
    const t0 = Date.now();
    const r = isoRender(v, look(8, { shadow: "contact", outline: true }));
    const ms = Date.now() - t0;
    ok("iso.perf.32", ms < 250, ms + " ms");
    eq("iso.perf.voxels", r.voxels, 32768);
    ok("iso.perf.pixels", r.pixels > 32768);
  }
}
