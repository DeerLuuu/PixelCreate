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
    // 边框（像素角）口径：4×4 的源图四角是 (0,0)-(4,4)
    const same = warpQuad(src, [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }], 4, 4);
    let diff = 0;
    for (let i = 0; i < src.data.length; i++) if (src.data[i] !== same[i]) diff++;
    eq("warp.quad.identity-lossless", diff, 0);

    // 斜切：整个四边形右移 1 -> 目标最左一列落在画面外（透明），内容整体右移
    const skew = warpQuad(src, [{ x: 1, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 4 }, { x: 1, y: 4 }], 5, 4);
    eq("warp.quad.skew-shifts", at(skew, 5, 1, 0)[0], 0);
    ok("warp.quad.skew-content", at(skew, 5, 4, 0)[0] === 30, String(at(skew, 5, 4, 0)[0]));
    ok("warp.quad.skew-right-filled", at(skew, 5, 4, 0)[3] === 255, String(at(skew, 5, 4, 0)[3]));
    // 画面外仍然透明（没有被胡乱拉伸填满）
    eq("warp.quad.skew-left-empty", at(skew, 5, 0, 0)[3], 0);

    // 退化四边形：不画东西（避免出现整片乱像素）
    const bad = warpQuad(src, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }], 4, 4);
    let anyAlpha = 0;
    for (let i = 3; i < bad.length; i += 4) anyAlpha += bad[i];
    eq("warp.quad.degenerate-empty", anyAlpha, 0);

    // 显式给出源四角时，口径不变（源 4×4 的角＝(0,0)-(4,4)）也是恒等
    const src4 = [
      { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 },
    ];
    const ident = warpQuad(src, [
      { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 },
    ], 4, 4, src4);
    let d2 = 0;
    for (let i = 0; i < src.data.length; i++) if (src.data[i] !== ident[i]) d2++;
    eq("warp.quad.explicit-srcquad-identity", d2, 0);
  }

  // ---- 奇数尺寸 / 非正方形 / 内容贴边：恒等变换也要逐字节无损（floor 取样口径） ----
  {
    for (const [w, h] of [[3, 5], [5, 3], [7, 4], [1, 2], [9, 9]] as Array<[number, number]>) {
      const src = mk(w, h);
      // 带透明边：只让内部 (1,1)..(w-2,h-2) 不透明（贴边留一圈透明）
      const edge = mk(w, h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const plain = x > 0 && y > 0 && x < w - 1 && y < h - 1;
        edge.data[(y * w + x) * 4 + 3] = plain ? 255 : 0;
      }
      const q = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
      const g = defaultGrid(w, h, 2);
      const tag = w + "x" + h;
      for (const [name, s2, isMesh] of [["quad", src, false], ["mesh", src, true], ["edge-quad", edge, false], ["edge-mesh", edge, true]] as Array<[string, ReturnType<typeof mk>, boolean]>) {
        const got = isMesh ? meshWarp(s2, g, w, h, 2) : warpQuad(s2, q, w, h);
        let d = 0;
        for (let i = 0; i < s2.data.length; i++) if (s2.data[i] !== got[i]) d++;
        eq("warp.identity." + name + "." + tag, d, 0);
        // 每一个不透明像素都必须被覆盖到（不能丢最右 / 最下一列）
        let lost = 0;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const p = (y * w + x) * 4;
          if (s2.data[p + 3] > 0 && got[p + 3] !== s2.data[p + 3]) lost++;
        }
        eq("warp.identity-covers." + name + "." + tag, lost, 0);
      }
    }
  }

  // ---- 网格变形：默认网格＝恒等；把一个控制点拉出去，附近像素跟着走 ----
  {
    const src = mk(6, 6);
    const grid = defaultGrid(6, 6, 2);
    eq("warp.grid.points", grid.length, 9);
    eq("warp.grid.corners", [grid[0], grid[2], grid[8]], [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 6 }]);
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

  // ---- 网格：整块往外拉 2 倍（仿射）时，缩略图覆盖每一个源像素（网格恒等无损的加强版） ----
  {
    const src = mk(6, 4);
    const grid2 = defaultGrid(6, 4, 2).map((p) => ({ x: p.x * 2, y: p.y * 2 }));
    const big = meshWarp(src, grid2, 12, 8, 2);
    let lost = 0;
    const miss: string[] = [];
    for (let y = 0; y < 4; y++) for (let x = 0; x < 6; x++) {
      let hit = false;
      for (let by = Math.floor(y * 2) - 2; by <= y * 2 + 2 && !hit; by++) {
        for (let bx = Math.floor(x * 2) - 2; bx <= x * 2 + 2 && !hit; bx++) {
          if (bx < 0 || by < 0 || bx >= 12 || by >= 8) continue;
          const sp = (by * 12 + bx) * 4;
          if (big[sp] === x * 10 && big[sp + 1] === y * 10 && big[sp + 3] === 255) hit = true;
        }
      }
      if (!hit) { lost++; if (miss.length < 6) miss.push(x + "," + y); }
    }
    eq("warp.mesh.scale-covers-all", lost, 0);
    // 每一行 / 每一列都还有不透明像素（不是整行整列空白）
    let emptyRows = 0, emptyCols = 0;
    for (let y = 0; y < 8; y++) {
      let any = false;
      for (let x = 0; x < 12; x++) if (big[(y * 12 + x) * 4 + 3] > 0) any = true;
      if (!any) emptyRows++;
    }
    for (let x = 0; x < 12; x++) {
      let any = false;
      for (let y = 0; y < 8; y++) if (big[(y * 12 + x) * 4 + 3] > 0) any = true;
      if (!any) emptyCols++;
    }
    eq("warp.mesh.scale-no-empty-rows", emptyRows, 0);
    eq("warp.mesh.scale-no-empty-cols", emptyCols, 0);
  }

  // ---- 斜切预设（边框口径：10×10 的右下角是 (10,10)，不是 (9,9)） ----
  {
    const q = skewQuad(10, 10, "x", 2);
    eq("warp.skew-quad.x", q[0], { x: 2, y: 0 });
    eq("warp.skew-quad.x-corner", q[2], { x: 8, y: 10 });
    eq("warp.skew-quad.x-bottom", q[3], { x: -2, y: 10 });
    eq("warp.skew-quad.y", skewQuad(10, 10, "y", 2)[0], { x: 0, y: 2 });
    eq("warp.skew-quad.y-corner", skewQuad(10, 10, "y", 2)[1], { x: 10, y: -2 });
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
    // 边框口径：控制点正好是选区框的四个角（不是内缩 1 像素的 5,5）
    eq("warp.float.quad", [quad[0], quad[2]], [{ x: 2, y: 2 }, { x: 6, y: 6 }]);
    eq("warp.float.grid", floatGrid(st!, 2).length, 9);
    // 网格控制点一个不多一个不少地铺满浮动区域（角点＝(2,2)..(6,6)）
    const fg = floatGrid(st!, 2);
    eq("warp.float.grid-corners", [fg[0], fg[2], fg[8]], [{ x: 2, y: 2 }, { x: 6, y: 2 }, { x: 6, y: 6 }]);

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
    // 边框口径：四角＝选区框四角 (2,2) (8,2) (8,6) (2,6)
    eq("warp.edge.quad-corners", [quad[0], quad[1], quad[2], quad[3]],
      [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 6 }, { x: 2, y: 6 }]);
    // 整条上边往外拖 4 格（左上 + 右上一起动＝把整块往右上拉长）：上边从 6 格变 10 格
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
