// 自由变换（斜切/透视/网格）的纯函数测试。
//
// 口径（全项目统一）：**像素下标空间，像素中心落在整数坐标上** ——
// 一块 cw×ch 的内容像素下标是 `0..cw-1` / `0..ch-1`，四角控制点就是
// `(0,0)`、`(cw-1,0)`、`(cw-1,ch-1)`、`(0,ch-1)`（不是 `cw` / `ch`）；
// 目标像素 `(px,py)` 的质心在下标空间里就是 `(px,py)`，反查回源下标后**就近取整**（Math.round）。
// 绘制时下标 `i` 画到屏幕 `(i + 0.5) * zoom + ox`（见 tests/warpui.test.ts）。
//
// 吸附粒度：控制点可以落在**整数**（压在像素中心）或 **`x.5`**（落在两个像素之间的边界线上），
// 由 `snapWarpCoord(v, half)` 决定（半像素模式＝默认，见 `prefs.selWarpHalfSnap`）。
// 半像素平移会让目标像素中心正好落在两个源像素**中间**，此时采样按「正中间取左边」处理
// （`warpFloating(..., halfSnap)` 的 `dropTie`），否则整块内容会白丢一列 / 一行。
import { applyMat, defaultGrid, homography, meshWarp, quadArea, skewQuad, snapWarpCoord, warpCoordLabel, warpPointFromScreen, warpQuad } from "../src/tools/warp";
import { beginMove, floatGrid, floatQuad, warpFloating } from "../src/tools/select";
import { Doc, Sel } from "../src/engine/doc";
import { eq, ok } from "./common";

function mk(w: number, h: number): { w: number; h: number; data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      data[p] = x * 10; data[p + 1] = y * 10; data[p + 2] = 7; data[p + 3] = 255;
    }
  }
  return { w, h, data };
}
const at = (d: Uint8ClampedArray, w: number, x: number, y: number): number[] => {
  const p = (y * w + x) * 4;
  return [d[p], d[p + 1], d[p + 2], d[p + 3]];
};
/** 一块 w×h 像素的下标口径四角（左上→右上→右下→左下） */
const corners = (w: number, h: number): Array<{ x: number; y: number }> =>
  [{ x: 0, y: 0 }, { x: w - 1, y: 0 }, { x: w - 1, y: h - 1 }, { x: 0, y: h - 1 }];

export function testWarp(): void {
  // ---- 单应：恒等、平移、透视 ----
  {
    const rect = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    const ident = homography(rect, rect);
    ok("warp.homography.identity", !!ident);
    const p = applyMat(ident!, { x: 3, y: 4 });
    ok("warp.homography.identity-maps", Math.abs(p.x - 3) < 1e-6 && Math.abs(p.y - 4) < 1e-6, p.x + "," + p.y);

    // homography(from, to) 给出的矩阵把 from 空间的点映到 to 空间（warpQuad 用它的反方向）
    const shifted = homography(rect, [{ x: 5, y: 5 }, { x: 15, y: 5 }, { x: 15, y: 15 }, { x: 5, y: 15 }]);
    const q = applyMat(shifted!, { x: 2, y: 4 });
    ok("warp.homography.translate", Math.abs(q.x - 7) < 1e-6 && Math.abs(q.y - 9) < 1e-6, q.x + "," + q.y);

    // 退化成一条线：解不出来
    eq("warp.homography.degenerate", homography(rect, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }]), null);
    eq("warp.area.rect", quadArea(rect), 100);
    eq("warp.area.line", quadArea([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }]), 0);
  }

  // ---- 四点变换：恒等变换应逐像素相同（像素下标口径：4×4 的四角是 (0,0)-(3,3)） ----
  {
    const src = mk(4, 4);
    const same = warpQuad(src, corners(4, 4), 4, 4);
    let diff = 0;
    for (let i = 0; i < src.data.length; i++) if (src.data[i] !== same[i]) diff++;
    eq("warp.quad.identity-lossless", diff, 0);

    // 斜切 / 整体右移 1 格：下标口径下 1 格 = 1 个像素，结果正好是整块右移（逐字节）
    const shift = [{ x: 1, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 1, y: 3 }];
    const skew = warpQuad(src, shift, 5, 4);
    eq("warp.quad.shift-left-empty", at(skew, 5, 0, 0)[3], 0);        // 画面外仍然透明
    ok("warp.quad.shift-last-col", at(skew, 5, 4, 0)[0] === 30, String(at(skew, 5, 4, 0)[0]));
    ok("warp.quad.shift-right-filled", at(skew, 5, 4, 0)[3] === 255, String(at(skew, 5, 4, 0)[3]));
    let shiftWrong = 0;
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const a = at(src.data, 4, x, y), b = at(skew, 5, x + 1, y);
      if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2] || a[3] !== b[3]) shiftWrong++;
    }
    eq("warp.quad.shift-lossless", shiftWrong, 0);                    // 一格就是一格：没有半像素模糊

    // 退化四边形：不画东西（避免出现整片乱像素）
    const bad = warpQuad(src, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }], 4, 4);
    let anyAlpha = 0;
    for (let i = 3; i < bad.length; i += 4) anyAlpha += bad[i];
    eq("warp.quad.degenerate-empty", anyAlpha, 0);

    // 显式给出源四角时口径不变（源 4×4 的下标四角＝(0,0)-(3,3)）也是恒等
    const ident = warpQuad(src, corners(4, 4), 4, 4, corners(4, 4));
    let d2 = 0;
    for (let i = 0; i < src.data.length; i++) if (src.data[i] !== ident[i]) d2++;
    eq("warp.quad.explicit-srcquad-identity", d2, 0);
  }

  // ---- 恒等变换逐字节无损 + 全覆盖：奇/偶尺寸 × 非方形 × 带透明边 × 内容贴边 ----
  // （1×N / N×1 的内容在下标口径下四角会压成一条线，属于尺寸退化，进入变形的入口就拒绝了，
  //   见 tests/warpui.test.ts 的 warpui.thin.*，所以这里最小到 2×2）
  {
    for (const [w, h] of [[3, 5], [5, 3], [7, 4], [2, 2], [2, 3], [9, 9], [8, 5]] as Array<[number, number]>) {
      const full = mk(w, h);                       // 内容贴边（整块不透明）
      const ring = mk(w, h);                       // 只有最外一圈不透明（带透明内部）
      const inner = mk(w, h);                      // 只留内部（带一圈透明边）
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
        ring.data[(y * w + x) * 4 + 3] = edge ? 255 : 0;
        inner.data[(y * w + x) * 4 + 3] = edge ? 0 : 255;
      }
      const q = corners(w, h);
      const g = defaultGrid(w, h, 2);
      const tag = w + "x" + h;
      for (const [name, s2, isMesh] of [["quad", full, false], ["mesh", full, true], ["ring-quad", ring, false], ["ring-mesh", ring, true], ["inner-quad", inner, false], ["inner-mesh", inner, true]] as Array<[string, ReturnType<typeof mk>, boolean]>) {
        const got = isMesh ? meshWarp(s2, g, w, h, 2) : warpQuad(s2, q, w, h);
        let d = 0;
        for (let i = 0; i < s2.data.length; i++) if (s2.data[i] !== got[i]) d++;
        eq("warp.identity." + name + "." + tag, d, 0);
        // 每一个不透明像素都必须被覆盖到（不能丢最右 / 最下一列）
        let lost = 0, srcOpaque = 0, gotOpaque = 0;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const p = (y * w + x) * 4;
          if (s2.data[p + 3] > 0) srcOpaque++;
          if (got[p + 3] > 0) gotOpaque++;
          if (s2.data[p + 3] > 0 && got[p + 3] !== s2.data[p + 3]) lost++;
        }
        eq("warp.identity-covers." + name + "." + tag, lost, 0);
        // 不透明像素一个不多一个不少（既不丢最右 / 最下一列，也没有凭空多出来的像素）
        eq("warp.identity-opaque-count." + name + "." + tag, gotOpaque, srcOpaque);
      }
    }
  }

  // ---- 网格变形：默认网格＝恒等；把一个控制点拉出去，附近像素跟着走 ----
  {
    const src = mk(6, 6);
    const grid = defaultGrid(6, 6, 2);
    eq("warp.grid.points", grid.length, 9);
    // 下标口径：6×6 的四角是 (0,0) (5,0) (5,5)
    eq("warp.grid.corners", [grid[0], grid[2], grid[8]], [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }]);
    const same = meshWarp(src, grid, 6, 6, 2);
    let diff = 0;
    for (let i = 0; i < src.data.length; i++) if (src.data[i] !== same[i]) diff++;
    eq("warp.mesh.identity-lossless", diff, 0);

    // 中心点往上拉：上半部分像素被"吸"上去，画面上方出现内容，邻域跟着走
    const pulled = grid.map((p, i) => (i === 4 ? { x: p.x, y: p.y - 3 } : p));
    const warped = meshWarp(src, pulled, 6, 6, 2);
    let moved = 0;
    for (let i = 0; i < src.data.length; i++) if (src.data[i] !== warped[i]) moved++;
    ok("warp.mesh.pulls", moved > 0, String(moved));
    // 邻域（中心点所在格之外的像素）也跟着动了，不是只有中心点自己在挪
    ok("warp.mesh.pulls-neighbours", moved > 12, String(moved));

    // 没有洞：变形后不透明像素数不少于原来的一半（三角逆映射应当铺满整个四边形）
    let a0 = 0, a1 = 0;
    for (let i = 3; i < src.data.length; i += 4) a0 += src.data[i] > 0 ? 1 : 0;
    for (let i = 3; i < warped.length; i += 4) a1 += warped[i] > 0 ? 1 : 0;
    ok("warp.mesh.no-holes", a1 >= a0 * 0.6, a0 + " -> " + a1);
  }

  // ---- 网格：整块往外拉 2 倍（仿射）时覆盖每一个源像素（网格恒等无损的加强版） ----
  // 下标口径下「2 倍」＝ 下标 i 映到 2i，6×4 的内容覆盖 2*0..2*5=0..10 / 0..6，
  // 所以输出取 11×7 —— 正好是变换后内容的范围，里面不许有空行 / 空列。
  {
    const src = mk(6, 4);
    const grid2 = defaultGrid(6, 4, 2).map((p) => ({ x: p.x * 2, y: p.y * 2 }));
    const big = meshWarp(src, grid2, 11, 7, 2);
    let lost = 0;
    const miss: string[] = [];
    for (let y = 0; y < 4; y++) for (let x = 0; x < 6; x++) {
      let hit = false;
      for (let by = Math.floor(y * 2) - 2; by <= y * 2 + 2 && !hit; by++) {
        for (let bx = Math.floor(x * 2) - 2; bx <= x * 2 + 2 && !hit; bx++) {
          if (bx < 0 || by < 0 || bx >= 11 || by >= 7) continue;
          const sp = (by * 11 + bx) * 4;
          if (big[sp] === x * 10 && big[sp + 1] === y * 10 && big[sp + 3] === 255) hit = true;
        }
      }
      if (!hit) { lost++; if (miss.length < 6) miss.push(x + "," + y); }
    }
    eq("warp.mesh.scale-covers-all", lost, 0);
    // 每一行 / 每一列都还有不透明像素（不是整行整列空白）
    let emptyRows = 0, emptyCols = 0;
    for (let y = 0; y < 7; y++) {
      let any = false;
      for (let x = 0; x < 11; x++) if (big[(y * 11 + x) * 4 + 3] > 0) any = true;
      if (!any) emptyRows++;
    }
    for (let x = 0; x < 11; x++) {
      let any = false;
      for (let y = 0; y < 7; y++) if (big[(y * 11 + x) * 4 + 3] > 0) any = true;
      if (!any) emptyCols++;
    }
    eq("warp.mesh.scale-no-empty-rows", emptyRows, 0);
    eq("warp.mesh.scale-no-empty-cols", emptyCols, 0);
  }

  // ---- 斜切预设（像素下标口径：10×10 的右下角是 (9,9)，不是 (10,10)） ----
  {
    const q = skewQuad(10, 10, "x", 2);
    eq("warp.skew-quad.x", q[0], { x: 2, y: 0 });
    eq("warp.skew-quad.x-corner", q[2], { x: 7, y: 9 });
    eq("warp.skew-quad.x-bottom", q[3], { x: -2, y: 9 });
    eq("warp.skew-quad.y", skewQuad(10, 10, "y", 2)[0], { x: 0, y: 2 });
    eq("warp.skew-quad.y-corner", skewQuad(10, 10, "y", 2)[1], { x: 9, y: -2 });
  }

  // ---- 浮动选区上的自由变换（warpFloating）：控制点＝像素下标、恒等不动、拖角位移、掩码跟着走 ----
  {
    const doc = new Doc(10, 10, "W");
    const cel = doc.ensureCel(0, 0);
    // 画一块 4x4 的方块（左上 2,2）→ 像素下标 x 2..5 / y 2..5
    for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) {
      const p = cel.idx(x, y);
      cel.data[p] = 200; cel.data[p + 1] = 50; cel.data[p + 2] = 25; cel.data[p + 3] = 255;
    }
    doc.sel = new Sel(10, 10);
    for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) doc.sel.set(x, y, 1);
    const st = beginMove(doc, 0, 0);
    ok("warp.float.ready", !!st);
    const out = new Uint8ClampedArray(10 * 10 * 4);
    const quad = floatQuad(st!);
    // 像素下标口径：四角＝内容的像素下标 (2,2)..(5,5)，不是内缩 / 外扩的边界
    eq("warp.float.quad", [quad[0], quad[1], quad[2], quad[3]],
      [{ x: 2, y: 2 }, { x: 5, y: 2 }, { x: 5, y: 5 }, { x: 2, y: 5 }]);
    // 控制点必须是整数下标（用户报的「吸附半个像素」＝出现 x.5）
    eq("warp.float.quad-integers", quad.filter((p) => !Number.isInteger(p.x) || !Number.isInteger(p.y)).length, 0);
    eq("warp.float.grid", floatGrid(st!, 2).length, 9);
    // 网格控制点一个不多一个不少地铺满浮动区域（四角＝(2,2)..(5,5)，且全是整数）
    const fg = floatGrid(st!, 2);
    eq("warp.float.grid-corners", [fg[0], fg[2], fg[8]], [{ x: 2, y: 2 }, { x: 5, y: 2 }, { x: 5, y: 5 }]);
    eq("warp.float.grid-integers", fg.filter((p) => !Number.isInteger(p.x) || !Number.isInteger(p.y)).length, 0);
    // 行主序（左上→右上→右下→左下）：第 1 行第 2 个点是 (4,2)、第 2 行第 1 个点是 (2,4)，末点是 (5,5)
    eq("warp.float.grid-row-major", [fg[1], fg[3]], [{ x: 4, y: 2 }, { x: 2, y: 4 }]);
    // 4 格宽的浮动内容 / 2 段：中间那条线取最近的像素下标（2），不是 2.5（用户报的「吸附半个像素」）
    eq("warp.float.grid-mid-line", [fg[0].x, fg[1].x, fg[2].x], [2, 4, 5]);

    // 恒等：内容原地不动（逐字节）
    let cells = warpFloating(doc, st!, quad, out, false);
    ok("warp.float.identity-cells", cells.length > 0, String(cells.length));
    eq("warp.float.identity-px", [out[cel.idx(2, 2)], out[cel.idx(2, 2) + 3]], [200, 255]);
    ok("warp.float.identity-mask", doc.sel!.get(3, 3) === 1);
    // 恒等覆盖全部像素：最后一列/最后一行也要在（用户报的 bug 就是这里丢一列/一行）
    let lost = 0;
    for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) {
      const p = cel.idx(x, y);
      if (out[p + 3] !== 255 || doc.sel!.get(x, y) !== 1) lost++;
    }
    eq("warp.float.identity-covers-all", lost, 0);
    eq("warp.float.identity-last-col", out[cel.idx(5, 5) + 3], 255);

    // 恒等（网格）：同样是逐字节无损 + 全覆盖
    cells = warpFloating(doc, st!, floatGrid(st!, 2), out, true, 2);
    let lostM = 0;
    for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) if (out[cel.idx(x, y) + 3] !== 255) lostM++;
    eq("warp.float.mesh-identity-covers-all", lostM, 0);

    // 整体右移 3 格：新位置有像素、老位置空出来
    const moved = quad.map((p) => ({ x: p.x + 3, y: p.y }));
    cells = warpFloating(doc, st!, moved, out, false);
    eq("warp.float.moved-px", [out[cel.idx(5, 3) + 3], out[cel.idx(2, 3) + 3]], [255, 0]);
    ok("warp.float.moved-mask", doc.sel!.get(5, 3) === 1 && doc.sel!.get(2, 3) === 0);

    // 网格：把中心点往上拉，画面应发生变化且不留空洞
    const grid = floatGrid(st!, 2);
    grid[4] = { x: grid[4].x, y: grid[4].y - 3 };
    cells = warpFloating(doc, st!, grid, out, true, 2);
    ok("warp.float.mesh-cells", cells.length > 0, String(cells.length));

    // 退化四边形：什么都不画（避免整片乱像素）
    const line = [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 6, y: 0 }, { x: 9, y: 0 }];
    cells = warpFloating(doc, st!, line, out, false);
    eq("warp.float.degenerate", cells.length, 0);
  }

  // ---- 平移 1 个像素：四角整体 +1 后结果正好整体右移一格（逐字节，没有半像素模糊 / 丢列） ----
  {
    const doc = new Doc(14, 8, "S1");
    const cel = doc.ensureCel(0, 0);
    const cw = 5, ch = 3, ox = 3, oy = 2;         // 内容像素下标 x 3..7 / y 2..4
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const p = cel.idx(ox + x, oy + y);
      cel.data[p] = 11 + x; cel.data[p + 1] = 22 + y; cel.data[p + 2] = 33; cel.data[p + 3] = 255;
    }
    doc.sel = new Sel(doc.w, doc.h);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) doc.sel.set(ox + x, oy + y, 1);
    const st = beginMove(doc, 0, 0)!;
    const out = new Uint8ClampedArray(doc.w * doc.h * 4);
    const quad = floatQuad(st);
    eq("warp.shift.quad", [quad[0], quad[2]], [{ x: 3, y: 2 }, { x: 7, y: 4 }]);

    // 期望：内容原样落在 x+1，其余全透明
    const expect = new Uint8ClampedArray(doc.w * doc.h * 4);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const s = cel.idx(ox + x, oy + y), d = cel.idx(ox + 1 + x, oy + y);
      expect[d] = cel.data[s]; expect[d + 1] = cel.data[s + 1];
      expect[d + 2] = cel.data[s + 2]; expect[d + 3] = cel.data[s + 3];
    }
    let nz = 0;
    for (let i = 0; i < expect.length; i++) if (expect[i] !== 0) nz++;
    eq("warp.shift.expect-bytes", nz, cw * ch * 4);
    let outZero = 0;
    for (let i = 0; i < out.length; i++) if (out[i] !== 0) outZero++;
    eq("warp.shift.baseline-empty", outZero, 0);
    // 恒等（不下移）时结果＝内容留在原位
    warpFloating(doc, st, quad, out, false);
    let ident = 0;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const s = cel.idx(ox + x, oy + y), o = cel.idx(ox + x, oy + y);
      if (out[o] !== cel.data[s] || out[o + 3] !== 255) ident++;
    }
    eq("warp.shift.identity-baseline", ident, 0);

    // 四角整体 +1 → 逐字节等于「整块右移一格」
    const plus1 = quad.map((p) => ({ x: p.x + 1, y: p.y }));
    warpFloating(doc, st, plus1, out, false);
    let wrong = 0;
    for (let i = 0; i < expect.length; i++) if (expect[i] !== out[i]) wrong++;
    eq("warp.shift.one-pixel-exact", wrong, 0);
    // 旧位置（最左一列）必须空出来：没有半像素模糊残留
    eq("warp.shift.old-col-empty", out[cel.idx(ox, oy) + 3], 0);
    // 最右一列没有被丢：新位置的最右一列有像素
    eq("warp.shift.new-col-kept", out[cel.idx(ox + cw, oy) + 3], 255);  }

  // ---- 把右上角拖出去：整条上边的像素都要跟着走（不能只动半条边、不能丢列） ----
  {
    const doc = new Doc(16, 14, "Q");
    const cel = doc.ensureCel(0, 0);
    // 6×4 的块（左上 2,2）：红值＝列号、绿值＝行号，方便验证「哪一列去了哪」
    const cw = 6, ch = 4;
    for (let y = 2; y < 2 + ch; y++) for (let x = 2; x < 2 + cw; x++) {
      const p = cel.idx(x, y);
      cel.data[p] = (x - 2) * 40; cel.data[p + 1] = (y - 2) * 50; cel.data[p + 2] = 10; cel.data[p + 3] = 255;
    }
    doc.sel = new Sel(16, 14);
    for (let y = 2; y < 2 + ch; y++) for (let x = 2; x < 2 + cw; x++) doc.sel.set(x, y, 1);
    const st = beginMove(doc, 0, 0)!;
    const out = new Uint8ClampedArray(16 * 14 * 4);
    const quad = floatQuad(st);
    // 像素下标口径：四角＝内容的像素下标 (2,2) (7,2) (7,5) (2,5)
    eq("warp.edge.quad-corners", [quad[0], quad[1], quad[2], quad[3]],
      [{ x: 2, y: 2 }, { x: 7, y: 2 }, { x: 7, y: 5 }, { x: 2, y: 5 }]);
    // 整条上边往外拖 2 格、右上角再多 4 格（把整块往右上拉长）
    const pulled = [
      { x: quad[0].x, y: quad[0].y - 2 }, { x: quad[1].x + 4, y: quad[1].y - 2 },
      quad[2], quad[3],
    ];
    const cells = warpFloating(doc, st, pulled, out, false);
    ok("warp.edge.has-cells", cells.length > 0, String(cells.length));
    // 上边（源第 0 行）：从最左到最右都有像素，而且比原来 6 格宽（整条边都跟着走了）
    const topRow: number[] = [];
    for (let x = 0; x < 16; x++) if (out[cel.idx(x, 0) + 3] === 255) topRow.push(out[cel.idx(x, 0)]);
    ok("warp.edge.top-row-stretched", topRow.length > cw, "n=" + topRow.length);
    eq("warp.edge.top-row-values", [...new Set(topRow)].length, cw);      // 6 个源列全在
    eq("warp.edge.top-row-no-gaps", topRow.filter((_, i) => i > 0 && topRow[i] - topRow[i - 1] > 40).length, 0);
    // 最右一列（源 x=7，红值 200）没有被漏掉：它出现在最右的有效列上（≥ 原选区右边 8）
    let rightCol = 0;
    for (let y = 0; y <= 5; y++) for (let x = 8; x < 16; x++) {
      const p = cel.idx(x, y);
      if (out[p] === 200 && out[p + 3] === 255) { rightCol++; break; }
    }
    ok("warp.edge.right-col-kept", rightCol >= ch - 1, "rows=" + rightCol);
    // 最左一列（红值 0）也在
    let leftCol = 0;
    for (let y = 0; y <= 5; y++) for (let x = 0; x < 16; x++) {
      const p = cel.idx(x, y);
      if (out[p] === 0 && out[p + 3] === 255) { leftCol++; break; }
    }
    ok("warp.edge.left-col-kept", leftCol >= ch - 1, "rows=" + leftCol);
    // 每一行（绿值 0/50/100/150）都在 —— 最下一行没被漏掉
    const greens = new Set<number>();
    for (let y = 0; y < 14; y++) for (let x = 0; x < 16; x++) {
      const p = cel.idx(x, y);
      if (out[p + 3] === 255) greens.add(out[p + 1]);
    }
    eq("warp.edge.all-rows-kept", [...greens].sort((a, b) => a - b), [0, 50, 100, 150]);
  }

  // ---- 只把右上角拖出去（左边不动＝斜切）：上边整条跟着走，源列一个都不丢 ----
  {
    const doc = new Doc(16, 16, "S");
    const cel = doc.ensureCel(0, 0);
    const cw = 6, ch = 4;
    for (let y = 2; y < 2 + ch; y++) for (let x = 2; x < 2 + cw; x++) {
      const p = cel.idx(x, y);
      cel.data[p] = (x - 2) * 40; cel.data[p + 1] = 255; cel.data[p + 2] = 10; cel.data[p + 3] = 255;
    }
    doc.sel = new Sel(16, 16);
    for (let y = 2; y < 2 + ch; y++) for (let x = 2; x < 2 + cw; x++) doc.sel.set(x, y, 1);
    const st = beginMove(doc, 0, 0)!;
    const out = new Uint8ClampedArray(16 * 16 * 4);
    const quad = floatQuad(st);
    const skew = [quad[0], { x: quad[1].x + 4, y: quad[1].y }, quad[2], quad[3]];
    warpFloating(doc, st, skew, out, false);
    // 上边每一列都在，且 6 个源列的红值都出现（整条边一起走，没有哪一列被吞）
    const rowVals: number[] = [];
    for (let x = 0; x < 16; x++) if (out[cel.idx(x, 2) + 3] === 255) rowVals.push(out[cel.idx(x, 2)]);
    eq("warp.skew.top-colours", [...new Set(rowVals)].sort((a, b) => a - b), [0, 40, 80, 120, 160, 200]);
    ok("warp.skew.top-wider", rowVals.length > cw, "n=" + rowVals.length);
    // 右上角真的往外走了：最右一列（红值 200）出现在 x>8 的列上
    let far = false;
    for (let y = 0; y < 16; y++) for (let x = 9; x < 16; x++) {
      const p = cel.idx(x, y);
      if (out[p] === 200 && out[p + 3] === 255) far = true;
    }
    ok("warp.skew.corner-pulled-out", far);
  }

  // ---- 吸附粒度：半像素（默认）允许 `x.5`，整像素只允许整数 ----
  {
    // 半像素模式：任意小数都落到 0.5 的整数倍（整数＝像素中心，x.5＝像素之间的边界线）
    const half: Array<[number, number]> = [
      [12.2, 12], [12.3, 12.5], [12.5, 12.5], [12.7, 12.5], [12.8, 13],
      [-0.2, 0], [-0.7, -0.5], [0, 0], [3.5, 3.5], [3.9999999996, 4], [4.0000000004, 4],
    ];
    for (const [v, want] of half) eq("warp.snap.half." + v, snapWarpCoord(v, true), want);
    eq("warp.snap.half-any-fraction", half.filter(([v]) => {
      const q = snapWarpCoord(v, true);
      return Math.abs(q * 2 - Math.round(q * 2)) > 1e-9;
    }).length, 0);
    // 整像素模式：永远整数，且取的是 floor（原来的行为）
    const whole: Array<[number, number]> = [
      [12.2, 12], [12.5, 12], [12.99, 12], [13, 13], [-0.2, -1], [-0.7, -1], [3.9999999996, 4],
    ];
    for (const [v, want] of whole) eq("warp.snap.whole." + v, snapWarpCoord(v, false), want);
    eq("warp.snap.whole-integers", whole.filter(([v]) => Number.isInteger(snapWarpCoord(v, false))).length, whole.length);

    // 屏幕 → 控制点：绘制位置 `(q + 0.5) * zoom + ox` 的反解，两种模式都幂等（抓住不动不跳位）
    const zoom = 8, ox = 100, oy = 50;
    const draw = (q: number) => (q + 0.5) * zoom + ox;
    for (const halfMode of [true, false]) {
      let off = 0;
      for (const q of [10, 11, 3, -4]) {
        const p = warpPointFromScreen(draw(q), (q + 0.5) * zoom + oy, zoom, ox, oy, halfMode);
        if (p.x !== q || p.y !== q) off++;
      }
      eq("warp.point.idempotent." + (halfMode ? "half" : "whole"), off, 0);
    }
    // 半像素模式：屏幕落在像素中心与下一条边界线之间 → 取最近的半点
    const dy = (10 + 0.5) * zoom + oy;          // y 同样对准下标 10 的像素中心
    eq("warp.point.half.cell-centre", warpPointFromScreen(draw(10), dy, zoom, ox, oy, true), { x: 10, y: 10 });
    eq("warp.point.half.near-edge", warpPointFromScreen(draw(10) + zoom * 0.4, dy, zoom, ox, oy, true), { x: 10.5, y: 10 });
    eq("warp.point.half.edge", warpPointFromScreen(draw(10) + zoom * 0.5, dy, zoom, ox, oy, true), { x: 10.5, y: 10 });
    eq("warp.point.half.just-under", warpPointFromScreen(draw(10) + zoom * 0.2, dy, zoom, ox, oy, true), { x: 10, y: 10 });
    // 整像素模式：同样的小数屏幕坐标一定落到整数（就近取整，与绘制公式严格互逆）
    for (const [off, want] of [[0.2, 10], [0.6, 11], [0.4, 10], [0.9, 11], [0.8, 11]] as Array<[number, number]>) {
      const p = warpPointFromScreen(draw(10) + zoom * off, dy, zoom, ox, oy, false);
      eq("warp.point.whole." + off, p, { x: want, y: 10 });
      ok("warp.point.whole-integer." + off, Number.isInteger(p.x), String(p.x));
    }
    // 半像素模式：跨过半格就落到 `x.5`（细调能落在两格中间）
    eq("warp.point.half.over-half", warpPointFromScreen(draw(10) + zoom * 0.8, dy, zoom, ox, oy, true), { x: 11, y: 10 });
    eq("warp.point.half.one-and-a-half", warpPointFromScreen(draw(10) + zoom * 1.5, dy, zoom, ox, oy, true), { x: 11.5, y: 10 });

    // 拖动浮标的文案：半像素带一位小数，整像素是整数，-0 归一化成 0
    eq("warp.label.half", warpCoordLabel({ x: 12.5, y: -0.0 }, true), "12.5, 0.0");  // 负零归一成 0
    eq("warp.label.half-int", warpCoordLabel({ x: 12, y: 3 }, true), "12.0, 3.0");
    eq("warp.label.whole", warpCoordLabel({ x: 12.5, y: -0.0 }, false), "13, 0");
  }

  // ---- 半像素拖动：四角整体 +0.5 真的参与采样（与 +0、+1 都不同），且不丢列 / 不留洞 ----
  {
    /** 20×10 的文档上放一块 5×3 的内容（下标 x 3..7 / y 2..4） */
    const scene = () => {
      const doc = new Doc(20, 10, "H");
      const cel = doc.ensureCel(0, 0);
      const cw = 5, ch = 3, ox = 3, oy = 2;
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
        const p = cel.idx(ox + x, oy + y);
        cel.data[p] = 30 + x * 20; cel.data[p + 1] = 60 + y * 20; cel.data[p + 2] = 9; cel.data[p + 3] = 255;
      }
      doc.sel = new Sel(doc.w, doc.h);
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) doc.sel.set(ox + x, oy + y, 1);
      return { doc, cel, st: beginMove(doc, 0, 0)!, cw, ch, ox, oy };
    };
    /** 把四角整体挪 (dx, dy) 后跑一遍预览。
     *  落点**先过一遍吸附**（真拖动走的是 `warpPointFromScreen()` → `snapWarpCoord()`）：
     *  半像素模式留住 `.5`，整像素模式被吸附回整格。 */
    const run = (dx: number, dy: number, halfSnap: boolean) => {
      const g = scene();
      const out = new Uint8ClampedArray(g.doc.w * g.doc.h * 4);
      const quad = floatQuad(g.st).map((p) => ({
        x: snapWarpCoord(p.x + dx, halfSnap), y: snapWarpCoord(p.y + dy, halfSnap),
      }));
      const cells = warpFloating(g.doc, g.st, quad, out, false, 2, halfSnap);
      let count = 0;
      for (let i = 3; i < out.length; i += 4) if (out[i] > 0) count++;
      return { out, cells: cells.length, count, W: g.doc.w, H: g.doc.h, ox: g.ox, oy: g.oy, cw: g.cw, ch: g.ch };
    };
    /** 只把右上角（下标 1）往外挪 `mut` 格——带半像素位移的「拉伸」（同样先过吸附） */
    const stretch = (mut: number, halfSnap: boolean) => {
      const g = scene();
      const out = new Uint8ClampedArray(g.doc.w * g.doc.h * 4);
      const quad = floatQuad(g.st).map((p, i) => {
        const q = i === 1 ? { x: p.x + mut, y: p.y } : { x: p.x, y: p.y };
        return { x: snapWarpCoord(q.x, halfSnap), y: snapWarpCoord(q.y, halfSnap) };
      });
      const cells = warpFloating(g.doc, g.st, quad, out, false, 2, halfSnap);
      let count = 0;
      for (let i = 3; i < out.length; i += 4) if (out[i] > 0) count++;
      return { out, cells: cells.length, count, W: g.doc.w, H: g.doc.h, ox: g.ox, oy: g.oy, cw: g.cw, ch: g.ch };
    };
    const bytes = (a: Uint8ClampedArray, b: Uint8ClampedArray): number => {
      let n = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
      return n;
    };
    /** 按内容原色（红 = 30 + 列号*20，绿 = 60 + 行号*20）认一认这块内容在不在 */
    const looksRight = (r: ReturnType<typeof run>, x0: number, y0: number): number => {
      let bad = 0;
      for (let y = 0; y < r.ch; y++) for (let x = 0; x < r.cw; x++) {
        const p = ((y0 + y) * r.W + (x0 + x)) * 4;
        if (r.out[p] !== 30 + x * 20 || r.out[p + 1] !== 60 + y * 20 || r.out[p + 3] !== 255) bad++;
      }
      return bad;
    };
    /** 输出里有多少行 / 列还有内容，内容自身的包围盒里有没有「洞」（整行 / 整列为空） */
    const occupancy = (r: ReturnType<typeof run>) => {
      const on = (x: number, y: number): boolean => r.out[(y * r.W + x) * 4 + 3] > 0;
      let emptyRows = 0, emptyCols = 0;
      let bx0 = r.W, by0 = r.H, bx1 = -1, by1 = -1;
      for (let y = 0; y < r.H; y++) {
        let any = false;
        for (let x = 0; x < r.W; x++) {
          if (!on(x, y)) continue;
          any = true;
          if (x < bx0) bx0 = x;
          if (x > bx1) bx1 = x;
          if (y < by0) by0 = y;
          if (y > by1) by1 = y;
        }
        if (!any) emptyRows++;
      }
      for (let x = 0; x < r.W; x++) {
        let any = false;
        for (let y = 0; y < r.H; y++) if (on(x, y)) any = true;
        if (!any) emptyCols++;
      }
      // 洞＝内容包围盒内部整行 / 整列是空的（半个像素的位移不能把内容中间挖空）
      let holes = 0;
      for (let y = by0; y <= by1; y++) {
        let any = false;
        for (let x = bx0; x <= bx1; x++) if (on(x, y)) any = true;
        if (!any) holes++;
      }
      for (let x = bx0; x <= bx1; x++) {
        let any = false;
        for (let y = by0; y <= by1; y++) if (on(x, y)) any = true;
        if (!any) holes++;
      }
      return { emptyRows, emptyCols, holes };
    };

    // 基线：不挪（半像素模式开着）
    const b0 = run(0, 0, true);
    // 四角整体 +0.5：控制点落到 `x.5`（两格之间的边界线）——最典型的半像素拖动
    const bHalf = run(0.5, 0, true);
    // 整格：+1（半像素模式）与整像素模式下的 +1
    const h1 = run(1, 0, true);
    const c1 = run(1, 0, false);

    // 1) 0.5 确实被写进了几何：结果与不动**不同**（半个像素的位移真的参与了采样）
    ok("warp.halfdiff.differs-0", bytes(bHalf.out, b0.out) > 0, String(bytes(bHalf.out, b0.out)));
    ok("warp.halfdiff.int1-differs-0", bytes(h1.out, b0.out) > 0, String(bytes(h1.out, b0.out)));
    // 2) 像素数守恒、形状原样：半个像素的位移**不丢列、不留洞**（旧行为会白丢一列）
    eq("warp.halfdiff.count", bHalf.count, b0.count);
    eq("warp.halfdiff.cells", bHalf.cells, b0.cells);
    eq("warp.halfdiff.shape", looksRight(bHalf, bHalf.ox + 1, bHalf.oy), 0);
    eq("warp.halfdiff.occupied", [occupancy(bHalf).emptyRows, occupancy(bHalf).emptyCols],
      [bHalf.H - bHalf.ch, bHalf.W - bHalf.cw]);
    eq("warp.halfdiff.no-hole", occupancy(bHalf).holes, 0);
    // 3) 最近邻的必然结果：位移正好半个像素时目标像素中心压在两个源像素正中间，
    //    统一取「左沿那一格」，于是 +0.5 与「量化到 +1」逐字节相同（内容整体搬一格）；
    //    关键是**内容完整**（上面几条），不是凭空多出半像素的模糊。
    eq("warp.halfdiff.half-quantises-to-one", bytes(bHalf.out, h1.out), 0);
    // 4) 对照：整格拖动时，半像素模式与整像素模式结果**完全相同**（整格不吃半点）
    eq("warp.halfdiff.int1-matches-whole", bytes(h1.out, c1.out), 0);
    eq("warp.halfdiff.int1-count", h1.count, b0.count);
    eq("warp.halfdiff.int1-old-col-empty", h1.out[(h1.oy * h1.W + h1.ox) * 4 + 3], 0);
    eq("warp.halfdiff.int1-new-col", h1.out[(h1.oy * h1.W + h1.ox + h1.cw) * 4 + 3], 255);

    // 5) 单点带半像素的「拉伸」：目标四角真的是 `x.5`（不是整数），输出跟着变、不出洞
    const sh = stretch(0.5, true);
    eq("warp.halfdiff.stretch-quad", [
      snapWarpCoord(3 + 5 - 1 + 0.5, true), snapWarpCoord(2 + 0.5, true),
    ], [7.5, 2.5]);
    ok("warp.halfdiff.stretch-changed", bytes(sh.out, b0.out) > 0, String(bytes(sh.out, b0.out)));
    ok("warp.halfdiff.stretch-nonempty", sh.count > 0, String(sh.count));
    eq("warp.halfdiff.stretch-no-hole", occupancy(sh).holes, 0);
    // 6) 两个方向都带 0.5 时同样一个像素不丢、一行不丢（浮点毛刺不能让 y 掉一行）
    const bDiag = run(0.5, 0.5, true);
    eq("warp.halfdiff.diag-count", bDiag.count, b0.count);
    eq("warp.halfdiff.diag-shape", looksRight(bDiag, bDiag.ox + 1, bDiag.oy + 1), 0);
    eq("warp.halfdiff.diag-occupied", [occupancy(bDiag).emptyRows, occupancy(bDiag).emptyCols],
      [bDiag.H - bDiag.ch, bDiag.W - bDiag.cw]);
    // 7) 模式切换真的换了落点粒度：整像素模式下 `+0.5` 被吸附回整格，结果＝完全不动；
    //    同一次拖动在半像素模式下落点留在 `x.5`，结果跟着变 —— 两条路真的分开了
    const wholeHalf = run(0.5, 0, false);
    eq("warp.halfdiff.whole-mode-snaps-away", bytes(wholeHalf.out, b0.out), 0);
    eq("warp.halfdiff.whole-mode-count", wholeHalf.count, b0.count);
    ok("warp.halfdiff.half-mode-keeps", bytes(bHalf.out, wholeHalf.out) > 0, String(bytes(bHalf.out, wholeHalf.out)));
  }

  // ---- 半像素吸附：网格模式同样能落在 `x.5`，且投影/网格运算不出 NaN ----
  {
    const src = mk(5, 3);
    const grid = defaultGrid(5, 3, 2);
    // 把 9 个控制点整体往右下挪半格（下标 +0.5），不再是整数
    const moved = grid.map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }));
    const out = meshWarp(src, moved, 7, 5, 2, true);
    let opaque = 0, nan = 0;
    for (let i = 0; i < 7 * 5; i++) {
      const p = i * 4;
      if (out[p + 3] > 0) opaque++;
      if (!Number.isFinite(out[p]) || !Number.isFinite(out[p + 1])) nan++;
    }
    eq("warp.mesh-half.nan", nan, 0);
    ok("warp.mesh-half.nonempty", opaque > 0, String(opaque));
    // 恒等（网格不动）仍然是逐字节无损的，结论不受半点吸附影响
    const same = meshWarp(src, grid, 5, 3, 2, false);
    let diff = 0;
    for (let i = 0; i < src.data.length; i++) if (src.data[i] !== same[i]) diff++;
    eq("warp.mesh-half.identity-still-lossless", diff, 0);
    // 四点变换：目标四角带 .5 也不出 NaN、不把画面整片糊掉
    const q = [
      { x: 0.5, y: 0.5 }, { x: 4.5, y: 0.5 }, { x: 4.5, y: 2.5 }, { x: 0.5, y: 2.5 },
    ];
    const wq = warpQuad(src, q, 7, 4, undefined, true);
    let wqOpaque = 0, wqNaN = 0;
    for (let i = 0; i < 7 * 4; i++) { if (wq[i * 4 + 3] > 0) wqOpaque++; if (!Number.isFinite(wq[i * 4])) wqNaN++; }
    eq("warp.quad-half.nan", wqNaN, 0);
    eq("warp.quad-half.opaque", wqOpaque, src.w * src.h);   // 4 列 × 3 行：整块内容一格不少
  }
}
