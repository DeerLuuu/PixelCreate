// 自由变换（斜切/透视/网格）的纯函数测试。
//
// 口径（全项目统一）：**像素下标空间，像素中心落在整数坐标上** ——
// 一块 cw×ch 的内容像素下标是 `0..cw-1` / `0..ch-1`，四角控制点就是
// `(0,0)`、`(cw-1,0)`、`(cw-1,ch-1)`、`(0,ch-1)`（不是 `cw` / `ch`）；
// 目标像素 `(px,py)` 的质心在下标空间里就是 `(px,py)`，反查回源下标后**就近取整**（Math.round）。
// 绘制时下标 `i` 画到屏幕 `(i + 0.5) * zoom + ox`（见 tests/warpui.test.ts）。
import { defaultGrid, homography, applyMat, meshWarp, quadArea, skewQuad, warpQuad } from "../src/tools/warp";
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
}
