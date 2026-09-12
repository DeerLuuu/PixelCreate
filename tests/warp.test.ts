// 自由变换（斜切/透视/网格）的纯函数测试。
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

  // ---- 四点变换：恒等变换应逐像素相同 ----
  {
    const src = mk(4, 4);
    const same = warpQuad(src, [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 3 }, { x: 0, y: 3 }], 4, 4);
    let diff = 0;
    for (let i = 0; i < src.data.length; i++) if (src.data[i] !== same[i]) diff++;
    eq("warp.quad.identity-lossless", diff, 0);

    // 斜切：左上角不动、右下角被推到外面 -> 第 0 行的像素整体右移
    const skew = warpQuad(src, [{ x: 1, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 1, y: 3 }], 5, 4);
    eq("warp.quad.skew-shifts", at(skew, 5, 0, 0)[0], 0);
    eq("warp.quad.skew-content", at(skew, 5, 1, 0)[0], 0);
    ok("warp.quad.skew-right-filled", at(skew, 5, 4, 0)[3] === 255, String(at(skew, 5, 4, 0)[3]));
    // 画面外仍然透明（没有被胡乱拉伸填满）
    eq("warp.quad.skew-left-empty", at(skew, 5, 0, 0)[3], 0);

    // 退化四边形：不画东西（避免出现整片乱像素）
    const bad = warpQuad(src, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }], 4, 4);
    let anyAlpha = 0;
    for (let i = 3; i < bad.length; i += 4) anyAlpha += bad[i];
    eq("warp.quad.degenerate-empty", anyAlpha, 0);
  }

  // ---- 网格变形：默认网格＝恒等；把一个控制点拉出去，附近像素跟着走 ----
  {
    const src = mk(6, 6);
    const grid = defaultGrid(6, 6, 2);
    eq("warp.grid.points", grid.length, 9);
    eq("warp.grid.corners", [grid[0], grid[2], grid[8]], [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }]);
    const same = meshWarp(src, grid, 6, 6, 2);
    let diff = 0;
    for (let i = 0; i < src.data.length; i++) if (src.data[i] !== same[i]) diff++;
    eq("warp.mesh.identity-lossless", diff, 0);

    // 中心点往上拉：上半部分像素被"吸"上去，画面上方出现内容
    const pulled = grid.map((p, i) => (i === 4 ? { x: p.x, y: p.y - 3 } : p));
    const warped = meshWarp(src, pulled, 6, 6, 2);
    let moved = 0;
    for (let i = 0; i < src.data.length; i++) if (src.data[i] !== warped[i]) moved++;
    ok("warp.mesh.pulls", moved > 0, String(moved));

    // 没有洞：变形后不透明像素数不少于原来的一半（三角逆映射应当铺满整个四边形）
    let a0 = 0, a1 = 0;
    for (let i = 3; i < src.data.length; i += 4) a0 += src.data[i] > 0 ? 1 : 0;
    for (let i = 3; i < warped.length; i += 4) a1 += warped[i] > 0 ? 1 : 0;
    ok("warp.mesh.no-holes", a1 >= a0 * 0.6, a0 + " -> " + a1);
  }

  // ---- 斜切预设 ----
  {
    const q = skewQuad(10, 10, "x", 2);
    eq("warp.skew-quad.x", q[0], { x: 2, y: 0 });
    eq("warp.skew-quad.x-bottom", q[3], { x: -2, y: 9 });
    eq("warp.skew-quad.y", skewQuad(10, 10, "y", 2)[0], { x: 0, y: 2 });
  }

  // ---- 浮动选区上的自由变换（warpFloating）：恒等不动、拖角位移、掩码跟着走 ----
  {
    const doc = new Doc(10, 10, "W");
    const cel = doc.ensureCel(0, 0);
    // 画一块 4x4 的方块（左上 2,2）
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
    eq("warp.float.quad", [quad[0], quad[2]], [{ x: 2, y: 2 }, { x: 5, y: 5 }]);
    eq("warp.float.grid", floatGrid(st!, 2).length, 9);

    // 恒等：内容原地不动
    let cells = warpFloating(doc, st!, quad, out, false);
    ok("warp.float.identity-cells", cells.length > 0, String(cells.length));
    eq("warp.float.identity-px", [out[cel.idx(2, 2)], out[cel.idx(2, 2) + 3]], [200, 255]);
    ok("warp.float.identity-mask", doc.sel!.get(3, 3) === 1);

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
}
