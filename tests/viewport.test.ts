// ViewportServer 的纯数学回归（src/servers/viewport.ts）。
//
// 这些算术以前散在 render/view.ts 里，只有"DOM 桩 + 手势"那套间接覆盖；
// 抽出来之后可以逐个钉死口径 —— 尤其是三条曾经出过真机问题的：
//   · 缩放以锚点为不动点（拖拽缩放时光标下的像素不能动）
//   · 适配缩放只在离整数倍 0.18 以内才吸（否则像素画会半格抖动）
//   · screenToPixel 用 floor 而不是截断（负数坐标上两者差一格）
import {
  SPACE_MARGIN, clampSingle, clampSpace, fitTarget, panBy, rotationMatrix,
  screenToPixel, surfaceDelta, toLogical, toSurface, zoomAtPoint,
} from "../src/servers/viewport";
import { eq, ok } from "./common";

export function testViewport(): void {
  // ---------------------------------------------------------------- fitTarget
  {
    // 360×640 视口里的 32×32 画布：aw=340, ah=620 -> z=min(10.625, 19.375)
    const t = fitTarget(32, 32, 360, 640, 0.25, 64);
    eq("vp.fit.zoom", t.zoom, 10.625);
    // 32*10.625 = 340 -> 居中留边各 10 / 150
    eq("vp.fit.center", [t.ox, t.oy], [10, 150]);
    // 缩放到负数区域时夹到 zoomMin
    eq("vp.fit.min", fitTarget(1000, 1000, 100, 100, 0.25, 64).zoom, 0.25);
    eq("vp.fit.max", fitTarget(1, 1, 2000, 2000, 0.25, 4).zoom, 4);
    // 只差 0.02 就吸到整数倍（90×90 装进 202×202：aw=182 -> 2.02）
    eq("vp.fit.snap-integer", fitTarget(90, 90, 202, 202, 0.25, 64).zoom, 2);
    // 差 0.4 不吸（100×100 装进 360×640：340/100=3.4）
    eq("vp.fit.no-snap", fitTarget(100, 100, 360, 640, 0.25, 64).zoom, 3.4);
  }

  // ------------------------------------------------------------- clampSingle
  {
    // 画布比视口小：ox 夹在 0..(vpW-dw)
    eq("vp.clamp.small.lo", clampSingle({ zoom: 10, ox: -100, oy: 0 }, 32, 32, 360, 640).ox, 0);
    eq("vp.clamp.small.hi", clampSingle({ zoom: 10, ox: 100, oy: 0 }, 32, 32, 360, 640).ox, 40);
    // 画布比视口大：ox 夹在 (vpW-dw)..0
    eq("vp.clamp.big.lo", clampSingle({ zoom: 20, ox: -500, oy: 0 }, 32, 32, 360, 640).ox, -280);
    eq("vp.clamp.big.hi", clampSingle({ zoom: 20, ox: 50, oy: 0 }, 32, 32, 360, 640).ox, 0);
    // zoom 原样带回，y 轴独立
    const c = clampSingle({ zoom: 20, ox: 0, oy: -9999 }, 32, 32, 360, 640);
    eq("vp.clamp.zoom-kept", c.zoom, 20);
    eq("vp.clamp.y", c.oy, 640 - 32 * 20);
  }

  // -------------------------------------------------------------- clampSpace
  {
    // 聚焦 32×32@(0,0)，另一张 32×32@(40,0)，zoom 10：外接框 x 0..720
    const focus = { x: 0, y: 0, w: 32, h: 32 };
    const list = [focus, { x: 40, y: 0, w: 32, h: 32 }];
    const lo = clampSpace({ zoom: 10, ox: -1000, oy: 0 }, focus, list, 360, 640);
    eq("vp.space.lo", lo.ox, SPACE_MARGIN - 720);
    const hi = clampSpace({ zoom: 10, ox: 400, oy: 0 }, focus, list, 360, 640);
    eq("vp.space.hi", hi.ox, 360 - SPACE_MARGIN);
    // 在范围内时原样返回
    eq("vp.space.inside", clampSpace({ zoom: 10, ox: 0, oy: 0 }, focus, list, 360, 640).ox, 0);
  }

  // ----------------------------------------------------------- zoomAtPoint
  {
    const v = zoomAtPoint({ zoom: 2, ox: 0, oy: 0 }, 4, 100, 100, 0.25, 64);
    eq("vp.zoom.anchor-fixed", [v.zoom, v.ox, v.oy], [4, -100, -100]);
    // 锚点处对应的文档坐标在缩放前后不变（这就是"光标下的像素不动"）
    const before = screenToPixel({ zoom: 2, ox: 0, oy: 0 }, 100, 100);
    const after = screenToPixel(v, 100, 100);
    eq("vp.zoom.pixel-under-cursor", [before.x, before.y], [after.x, after.y]);
    // 夹上限后仍以锚点为不动点
    const capped = zoomAtPoint({ zoom: 2, ox: 0, oy: 0 }, 1000, 100, 100, 0.25, 64);
    eq("vp.zoom.capped", [capped.zoom, capped.ox], [64, 100 - 100 * 32]);
    // 不给锚点时以视口中心为锚点（由调用方传入）
    eq("vp.zoom.center-caller", zoomAtPoint({ zoom: 4, ox: 0, oy: 0 }, 2, 180, 320, 0.25, 64).ox, 90);
  }

  // ---------------------------------------------------------------- panBy
  {
    const p = panBy({ zoom: 7, ox: 10, oy: -20 }, 5, 6);
    eq("vp.pan", [p.zoom, p.ox, p.oy], [7, 15, -14]);
  }

  // --------------------------------------------------------- screenToPixel
  {
    eq("vp.s2p.basic", screenToPixel({ zoom: 10, ox: -5, oy: 0 }, 16, 26), { x: 2, y: 2 });
    // 负坐标必须 floor（-1.5 -> -2）；用 |0 截断会得到 -1，落在隔壁像素上
    eq("vp.s2p.floor-negative", screenToPixel({ zoom: 10, ox: 20, oy: 20 }, 5, 5), { x: -2, y: -2 });
  }

  // -------------------------------------------------------- rotationMatrix
  {
    eq("vp.rot.0", rotationMatrix(0, 2, 360, 640), [2, 0, 0, 2, 0, 0]);
    eq("vp.rot.90", rotationMatrix(90, 2, 360, 640), [0, 2, -2, 0, 720, 0]);
    eq("vp.rot.180", rotationMatrix(180, 2, 360, 640), [-2, 0, 0, -2, 720, 1280]);
    eq("vp.rot.270", rotationMatrix(270, 2, 360, 640), [0, -2, 2, 0, 0, 1280]);
  }

  // ------------------------------------------------- toLogical / toSurface
  {
    const W = 360, H = 640;
    for (const rot of [0, 90, 180, 270] as const) {
      const pts: Array<[number, number]> = [[0, 0], [W, 0], [0, H], [W, H], [37, 211]];
      let bad = 0;
      for (const [x, y] of pts) {
        const sp = toSurface(rot, W, H, x, y);
        const l = toLogical(rot, W, H, sp.x, sp.y);
        if (l.x !== x || l.y !== y) bad++;
      }
      eq("vp.roundtrip.rot" + rot, bad, 0);
    }
    eq("vp.logical.90.corner", toLogical(90, W, H, W, 0), { x: 0, y: 0 });
    eq("vp.surface.270.corner", toSurface(270, W, H, 0, 0), { x: 0, y: H });
  }

  // --------------------------------------------------------- surfaceDelta
  {
    eq("vp.delta.0", surfaceDelta(0, 4, 8, 12), { x: 2, y: 3 });
    eq("vp.delta.90", surfaceDelta(90, 4, 8, 12), { x: 3, y: -2 });
    eq("vp.delta.180", surfaceDelta(180, 4, 8, 12), { x: -2, y: -3 });
    eq("vp.delta.270", surfaceDelta(270, 4, 8, 12), { x: -3, y: 2 });
    // 90/270 是坐标交换，长度必须保持（否则旋转后拖动会"变快/变慢"）
    const d = surfaceDelta(90, 4, 8, 12);
    ok("vp.delta.length", Math.abs(Math.hypot(d.x, d.y) - Math.hypot(8, 12) / 4) < 1e-12);
  }
}
