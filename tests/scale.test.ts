// 高级缩放（重采样）回归。
//
// 覆盖三块：
//   · `engine/resample.ts` 六个算法的数值行为（像素对应、恒等、预乘 alpha、
//     Scale2x/3x 的邻域规则、降级、cleanTransparent、极端尺寸与上限）；
//   · `ops.scaleDocSprite`（老「精灵尺寸」）改走引擎 nearest 路径后行为不变；
//   · `Session.scaleAdvanced` 的三种作用域 +「一次操作一条历史」。
//
// 注意：`Cel.idx(x, y)` 返回的是**字节**偏移（不是像素下标），断言里务必按字节索引。
import { Session } from "../src/app/session";
import { Doc, Sel } from "../src/engine/doc";
import * as ops from "../src/engine/ops";
import {
  MAX_SIZE, SCALE_ALGOS, algoSupported, effectiveAlgo, resamplePixels, resampleRegion, scaleFactor,
  type ResampleAlgo,
} from "../src/engine/resample";
import { stubEnv } from "./session.test";
import { eq, ok } from "./common";

declare const require: (m: string) => any;
declare const __dirname: string;
const fs = require("fs");
const path = require("path");

/** 把 [r,g,b,a, r,g,b,a, …] 铺成 RGBA 缓冲区 */
function px(...v: number[]): Uint8ClampedArray {
  return new Uint8ClampedArray(v);
}
/** 第 i 个像素（4 字节） */
function at(d: Uint8ClampedArray, i: number): number[] {
  return [d[i * 4], d[i * 4 + 1], d[i * 4 + 2], d[i * 4 + 3]];
}
function pxAt(d: Uint8ClampedArray, x: number, y: number, w: number): number[] {
  return at(d, y * w + x);
}
/** 纯色缓冲区 */
function solid(w: number, h: number, c: number[]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = c[3];
  }
  return d;
}

export function testScale(): void {
  stubEnv();

  // ---------------------------------------------------------------- 元数据
  {
    eq("scale.algos.ids", SCALE_ALGOS.map((a) => a.id), ["nearest", "bilinear", "bicubic", "area", "scale2x", "scale3x"]);
    ok("scale.algos.nearest-default", SCALE_ALGOS[0].id === "nearest" && SCALE_ALGOS[0].onlyExactFactor === null);
    eq("scale.algos.pixel-art", SCALE_ALGOS.filter((a) => a.pixelArt).map((a) => a.id), ["scale2x", "scale3x"]);
    eq("scale.algos.factors", SCALE_ALGOS.filter((a) => a.onlyExactFactor !== null).map((a) => a.onlyExactFactor), [2, 3]);
    ok("scale.algos.max", MAX_SIZE === 1024);
    eq("scale.factor", scaleFactor(4, 4, 8, 12), { fx: 2, fy: 3 });
    eq("scale.factor.zero", scaleFactor(0, 0, 8, 8), { fx: 1, fy: 1 });
  }

  // ----------------------------------------------------- 可用性与安全降级
  {
    ok("scale.supported.2x", algoSupported("scale2x", 4, 4, 8, 8));
    ok("scale.supported.3x", algoSupported("scale3x", 4, 4, 12, 12));
    ok("scale.unsupported.2x-wrong", !algoSupported("scale2x", 4, 4, 8, 12));
    ok("scale.unsupported.3x-ratio", !algoSupported("scale3x", 4, 4, 6, 6));
    ok("scale.unsupported.2x-shrink", !algoSupported("scale2x", 4, 4, 2, 2));
    ok("scale.supported.normal", algoSupported("bilinear", 4, 4, 7, 3));
    eq("scale.effective.downgrade", effectiveAlgo("scale2x", 3, 3, 7, 7), "nearest");
    eq("scale.effective.keep", effectiveAlgo("scale2x", 3, 3, 6, 6), "scale2x");
    // 降级后的真实输出 = nearest 的输出（UI 提示与引擎行为一致）
    const src = px(
      1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255,
      10, 11, 12, 255, 13, 14, 15, 255, 16, 17, 18, 255,
      19, 20, 21, 255, 22, 23, 24, 255, 25, 26, 27, 255,
    );
    const down = resamplePixels(src, 3, 3, 7, 7, "scale2x");
    const ne = resamplePixels(src, 3, 3, 7, 7, "nearest");
    eq("scale.downgrade.equals-nearest", Array.from(down), Array.from(ne));
  }

  // ------------------------------------------------------------ nearest 精确性
  {
    // 2×2 → 4×4：floor 映射，每个源像素铺成 2×2 块
    const src = px(
      10, 20, 30, 255, 40, 50, 60, 255,
      70, 80, 90, 255, 100, 110, 120, 255,
    );
    const out = resamplePixels(src, 2, 2, 4, 4, "nearest");
    eq("nearest.len", out.length, 4 * 4 * 4);
    eq("nearest.block00", [pxAt(out, 0, 0, 4), pxAt(out, 1, 1, 4)], [[10, 20, 30, 255], [10, 20, 30, 255]]);
    eq("nearest.block10", pxAt(out, 2, 0, 4), [40, 50, 60, 255]);
    eq("nearest.block01", pxAt(out, 0, 2, 4), [70, 80, 90, 255]);
    eq("nearest.block11", pxAt(out, 3, 3, 4), [100, 110, 120, 255]);
    // 非整数比例：3×1 → 7×1 的对应关系必须是 floor(i*3/7)
    const row = px(1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255);
    const r7 = resamplePixels(row, 3, 1, 7, 1, "nearest");
    const got = [] as number[];
    for (let i = 0; i < 7; i++) got.push(r7[i * 4]);
    eq("nearest.3to7", got, [1, 1, 1, 2, 2, 3, 3]);
    // 输入绝不被修改
    const keep = Array.from(src);
    resamplePixels(src, 2, 2, 8, 8, "bicubic");
    eq("nearest.src-untouched", Array.from(src), keep);
  }

  // ---------------------------------------------------- 纯色恒等（线性放大）
  {
    const c = [37, 129, 201, 255];
    const src = solid(5, 3, c);
    for (const algo of ["bilinear", "bicubic", "area"] as ResampleAlgo[]) {
      const out = resamplePixels(src, 5, 3, 11, 7, algo);
      let bad = 0;
      for (let i = 0; i < 11 * 7; i++) if (at(out, i).join() !== c.join()) bad++;
      eq("scale.const." + algo, bad, 0);
    }
    // 缩小时也是恒等（面积平均的权重和归一化正确）
    for (const algo of ["bilinear", "bicubic", "area"] as ResampleAlgo[]) {
      const out = resamplePixels(src, 5, 3, 3, 2, algo);
      let bad = 0;
      for (let i = 0; i < 3 * 2; i++) if (at(out, i).join() !== c.join()) bad++;
      eq("scale.const.shrink." + algo, bad, 0);
    }
    // 半透明纯色同样恒等
    const ha = solid(3, 3, [200, 40, 60, 128]);
    const out2 = resamplePixels(ha, 3, 3, 6, 6, "bilinear");
    let bad2 = 0;
    for (let i = 0; i < 36; i++) if (at(out2, i).join() !== [200, 40, 60, 128].join()) bad2++;
    eq("scale.const.translucent", bad2, 0);
  }

  // --------------------------------------------------- 预乘 alpha（不能发黑）
  {
    // 左：不透明红；右：全透明但 RGB 是白色（很多工具会留残色）。
    // 正确做法在预乘空间插值 -> 中间像素仍是纯红(255,0,0)，只是 alpha 变低；
    // 直接对 RGB 求平均会得到「发白/发灰」的粉彩色 —— 这正是要钉死的 bug。
    const src = px(255, 0, 0, 255, 255, 255, 255, 0);
    const bi = resamplePixels(src, 2, 1, 4, 1, "bilinear");
    const mid = at(bi, 1);
    ok("premul.bilinear.red-not-lightened", mid[0] >= 250 && mid[1] <= 5 && mid[2] <= 5, "mid=" + mid.join());
    ok("premul.bilinear.alpha-blended", mid[3] > 120 && mid[3] < 200, "a=" + mid[3]);
    const bc = resamplePixels(src, 2, 1, 4, 1, "bicubic");
    const midc = at(bc, 1);
    ok("premul.bicubic.red-not-lightened", midc[0] >= 240 && midc[1] <= 10 && midc[2] <= 10, "mid=" + midc.join());
    // 区域平均同理：不透明红 + 全透明(白 RGB) 的平均必须是暗红而不是粉红
    const ar = resamplePixels(src, 2, 1, 1, 1, "area");
    const one = at(ar, 0);
    ok("premul.area.red-not-lightened", one[0] >= 250 && one[1] <= 5 && one[2] <= 5, "one=" + one.join());
    eq("premul.area.alpha", one[3] <= 130 ? "half" : "full", "half");
    // 反向检查：透明像素参与平均时目标像素不能反而不透明
    ok("premul.area.alpha-not-full", one[3] < 255, "a=" + one[3]);
  }

  // ------------------------------------------------------------ 面积平均（缩小）
  {
    // 4×1 亮度阶梯 → 1×2：每两个源像素平均
    const src = px(0, 0, 0, 255, 40, 0, 0, 255, 80, 0, 0, 255, 120, 0, 0, 255);
    const out = resamplePixels(src, 4, 1, 2, 1, "area");
    eq("area.halves", [at(out, 0)[0], at(out, 1)[0]], [20, 100]);
    // 1×4 → 1×2 的纵向同样适用
    const src2 = px(10, 0, 0, 255, 30, 0, 0, 255, 50, 0, 0, 255, 70, 0, 0, 255);
    const out2 = resamplePixels(src2, 1, 4, 1, 2, "area");
    eq("area.vertical", [at(out2, 0)[0], at(out2, 1)[0]], [20, 60]);
    // 纯透明区域缩小后仍然完全透明（不会渗出颜色）
    const src3 = px(255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0);
    const out3 = resamplePixels(src3, 4, 1, 1, 1, "area");
    eq("area.all-transparent", at(out3, 0), [0, 0, 0, 0]);
    // 混合：一个不透明 + 三个透明 -> alpha 只剩约 1/4，RGB 仍是那个不透明色
    const src4 = px(200, 100, 50, 255, 9, 9, 9, 0, 8, 8, 8, 0, 7, 7, 7, 0);
    const out4 = resamplePixels(src4, 4, 1, 1, 1, "area");
    const o4 = at(out4, 0);
    ok("area.mixed.alpha", o4[3] > 55 && o4[3] < 70, "a=" + o4[3]);
    eq("area.mixed.rgb", [o4[0], o4[1], o4[2]], [200, 100, 50]);
    // 缩小 8 倍（每个目标像素盖住 8 个源像素）：权重表不能溢出/错位
    const ramp = new Uint8ClampedArray(8 * 4);
    for (let i = 0; i < 8; i++) { ramp[i * 4] = i * 10; ramp[i * 4 + 3] = 255; }
    // 缩到 1/8：唯一的目标像素盖住全部 8 个源像素（权重＝各自的覆盖长度）
    const out8 = resamplePixels(ramp, 8, 1, 1, 1, "area");
    eq("area.wide-span", at(out8, 0)[0], 35);
    // 缩到 1/5（源 10 个像素 → 目标 2 个）：权重表必须是连续区间，不能溢出/错位
    const ramp10 = new Uint8ClampedArray(10 * 4);
    for (let i = 0; i < 10; i++) { ramp10[i * 4] = i * 10; ramp10[i * 4 + 3] = 255; }
    const out10 = resamplePixels(ramp10, 10, 1, 2, 1, "area");
    eq("area.partial-span", [at(out10, 0)[0], at(out10, 1)[0]], [20, 70]);
  }

  // ------------------------------------------------------ Scale2x / Scale3x
  {
    // 单个亮点：孤立像素 -> 2×2 实心块（透明邻居都同色，规则只放不扩）
    const dot = new Uint8ClampedArray(3 * 3 * 4);
    const setDot = (d: Uint8ClampedArray, w: number, x: number, y: number, c: number[]): void => {
      const i = (y * w + x) * 4;
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = c[3];
    };
    const red = [255, 0, 0, 255];
    const white = [255, 255, 255, 255];
    setDot(dot, 3, 1, 1, red);
    const d2 = resamplePixels(dot, 3, 3, 6, 6, "scale2x");
    eq("s2x.dot.len", d2.length, 6 * 6 * 4);
    eq("s2x.dot.block", [pxAt(d2, 2, 2, 6), pxAt(d2, 3, 3, 6)], [red, red]);
    eq("s2x.dot.isolated-transparent", pxAt(d2, 0, 0, 6), [0, 0, 0, 0]);

    // ★ 反例：孤立像素的上下左右是四种**互不相同**的颜色。
    // 最经典的写错方式是「B!=H && D!=F 就把四格全换成邻居」——那样中心像素会整格
    // 消失（放大后一个都不剩）。正确规则必须先判相等（D==B / B==F / D==H / H==F），
    // 中心像素必须原样长出 2×2。这条断言就是用来钉死这个坑的。
    const four = px(
      0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 0, 0,
      0, 0, 255, 255, 255, 255, 255, 255, 0, 255, 0, 255,
      0, 0, 0, 0, 255, 255, 0, 255, 0, 0, 0, 0,
    );
    const four2 = resamplePixels(four, 3, 3, 6, 6, "scale2x");
    let fourWhite = 0;
    for (let i = 0; i < 36; i++) if (at(four2, i).join() === "255,255,255,255") fourWhite++;
    eq("s2x.isolated-4colours.survives", fourWhite, 4);
    eq("s2x.isolated-4colours.block", pxAt(four2, 2, 2, 6).join(), pxAt(four2, 3, 3, 6).join());
    eq("s2x.isolated-4colours.reference", Array.from(four2), Array.from(refScale2x(four, 3, 3)));

    // 1 像素宽的水平线放大后必须正好 2 像素厚（不能保持 1 像素，也不能糊出半透明渐变）
    const hline = px(
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    );
    const hl2 = resamplePixels(hline, 5, 3, 10, 6, "scale2x");
    let hlWhite = 0;
    for (let i = 0; i < 60; i++) if (at(hl2, i).join() === "255,255,255,255") hlWhite++;
    eq("s2x.hline.white", hlWhite, 20);
    eq("s2x.hline.row0-empty", pxAt(hl2, 4, 0, 10).join(), "0,0,0,0");
    eq("s2x.hline.row2-full", pxAt(hl2, 4, 2, 10).join(), "255,255,255,255");

    // 斜线：单像素宽的 45° 线在 Scale2x 下不出台阶毛刺（保持硬边）
    const diag = px(
      255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255,
    );
    const dg2 = resamplePixels(diag, 3, 3, 6, 6, "scale2x");
    // 和「按定义独立写一遍的」Scale2x 参考实现逐字节比对：斜线、棋盘、单点三种
    // 图案都要一致。这样断言既钉住了规则本身，也不会让人肉推演算错写成假绿。
    eq("s2x.matches-reference.diag", Array.from(dg2), Array.from(refScale2x(diag, 3, 3)));
    // 斜线起始那个亮像素的 2×2（边界外按钳制＝自己）：
    //   E0 = D==B && B!=F && D!=H ? D : E → 上/左都是自己 → 白
    //   E1 = B==F && …            ? F : E → 上(白) vs 右(透明) 不等 → 白
    //   E2 = D==H && …            ? D : E → 左(白) vs 下(透明) 不等 → 白
    //   E3 = H==F && D!=H && B!=F ? F : E → 下/右都是透明、且都≠自己 → 透明
    // 即 Scale2x 会把斜线端点抹圆（算法固有特性，不是缺陷）。
    eq("s2x.diag.corner", [
      pxAt(dg2, 0, 0, 6).join(), pxAt(dg2, 1, 0, 6).join(), pxAt(dg2, 0, 1, 6).join(),
    ], [white.join(), white.join(), white.join()]);
    eq("s2x.diag.corner-sub", pxAt(dg2, 1, 1, 6).join(), [0, 0, 0, 0].join());
    eq("s2x.diag.tail-sub", pxAt(dg2, 5, 4, 6).join(), white.join());
    // 不混合颜色：所有输出像素必须是原图出现过的颜色之一
    const palette = new Set(["255,255,255,255", "0,0,0,0"]);
    let strange = 0;
    for (let i = 0; i < 36; i++) if (!palette.has(at(dg2, i).join())) strange++;
    eq("s2x.no-new-colours", strange, 0);

    // 棋盘：即使棋盘纹如此密集，也绝不产生第三种颜色（硬边不被插值糊掉）
    const checker = px(
      0, 0, 0, 255, 255, 255, 255, 255,
      255, 255, 255, 255, 0, 0, 0, 255,
    );
    const ck2 = resamplePixels(checker, 2, 2, 4, 4, "scale2x");
    const black = "0,0,0,255", whiteS = "255,255,255,255";
    let ckStrange = 0;
    for (let i = 0; i < 16; i++) {
      const s = at(ck2, i).join();
      if (s !== black && s !== whiteS) ckStrange++;
    }
    eq("s2x.checker.no-blend", ckStrange, 0);
    // 2×2 棋盘：颜色只取自原图（不插值成灰），四格分别按规则取
    //   (0,0) 块＝K K / K W（左上像素：左/上都是自己 → E0/E1/E2 保持 K，右下被 F 抢走）
    //   (1,0) 块＝W W / K W（右上像素：上与右钳制到自己是白 → E0 白，左下被判给 D）
    eq("s2x.checker.block", [pxAt(ck2, 0, 0, 4).join(), pxAt(ck2, 3, 3, 4).join()], [black, black]);
    eq("s2x.checker.block2", [
      pxAt(ck2, 2, 0, 4).join(), pxAt(ck2, 2, 1, 4).join(), pxAt(ck2, 3, 1, 4).join(),
    ], [whiteS, black, whiteS]);

    // 棋盘 / 单点也必须与参考实现逐字节一致（棋盘纹最密，规则最容易写错）
    eq("s2x.matches-reference.checker", Array.from(ck2), Array.from(refScale2x(checker, 2, 2)));
    eq("s2x.matches-reference.dot", Array.from(resamplePixels(dot, 3, 3, 6, 6, "scale2x")), Array.from(refScale2x(dot, 3, 3)));

    // Scale3x：像素化 3×，尺寸与硬边同时成立
    const dg3 = resamplePixels(diag, 3, 3, 9, 9, "scale3x");
    eq("s3x.diag.len", dg3.length, 9 * 9 * 4);
    eq("s3x.diag.p0", pxAt(dg3, 0, 0, 9).join(), white.join());
    eq("s3x.diag.p1", pxAt(dg3, 1, 1, 9).join(), white.join());
    eq("s3x.diag.p4", pxAt(dg3, 4, 4, 9).join(), white.join());
    // 与独立写一遍的 Scale3x 参考实现逐字节比对（斜线 / 棋盘 / 单点）
    eq("s3x.matches-reference.diag", Array.from(dg3), Array.from(refScale3x(diag, 3, 3)));
    let s3strange = 0;
    for (let i = 0; i < 81; i++) {
      const s = at(dg3, i).join();
      if (s !== "255,255,255,255" && s !== "0,0,0,0") s3strange++;
    }
    eq("s3x.no-new-colours", s3strange, 0);
    // 3× 的棋盘：每格 3×3
    const ck3 = resamplePixels(checker, 2, 2, 6, 6, "scale3x");
    let ck3strange = 0;
    for (let i = 0; i < 36; i++) {
      const s = at(ck3, i).join();
      if (s !== black && s !== whiteS) ck3strange++;
    }
    eq("s3x.checker.no-blend", ck3strange, 0);
    eq("s3x.matches-reference.checker", Array.from(ck3), Array.from(refScale3x(checker, 2, 2)));
    eq("s3x.matches-reference.dot", Array.from(resamplePixels(dot, 3, 3, 9, 9, "scale3x")), Array.from(refScale3x(dot, 3, 3)));
    // Scale3x 的规则确实会「补角」：单像素亮点的 3×3 里，四角会被邻域规则填上
    const dot3 = resamplePixels(dot, 3, 3, 9, 9, "scale3x");
    eq("s3x.dot.center", pxAt(dot3, 4, 4, 9).join(), red.join());

    // ★ Scale3x 的同款反例：九格必须**全部**是中心像素自己。
    // 漏掉 E1/E3/E5/E7 里的 `E!=对角` 条件时，四边会被四种邻居颜色各占一格，
    // 中心只剩 5 格；参考实现（C 版 border/center 转写）逐字节对照兜住这条。
    const four3 = resamplePixels(four, 3, 3, 9, 9, "scale3x");
    let four3White = 0;
    for (let i = 0; i < 81; i++) if (at(four3, i).join() === "255,255,255,255") four3White++;
    eq("s3x.isolated-4colours.survives", four3White, 9);
    eq("s3x.isolated-4colours.reference", Array.from(four3), Array.from(refScale3x(four, 3, 3)));

    // 只有整数倍可用：不满足时与 nearest 完全一致
    const wrong = resamplePixels(diag, 3, 3, 7, 7, "scale3x");
    const near = resamplePixels(diag, 3, 3, 7, 7, "nearest");
    eq("s3x.fallback-nearest", Array.from(wrong), Array.from(near));
    const wrong2 = resamplePixels(diag, 3, 3, 5, 5, "scale2x");
    const near2 = resamplePixels(diag, 3, 3, 5, 5, "nearest");
    eq("s2x.fallback-nearest", Array.from(wrong2), Array.from(near2));
  }

  // -------------------------------------------------------- cleanTransparent
  {
    // 带残色（RGB=200,100,50）的全透明像素：默认保留，勾选后清零
    const src = px(200, 100, 50, 0, 10, 20, 30, 255);
    const off = resamplePixels(src, 2, 1, 2, 1, "nearest");
    eq("clean.off.keeps-rgb", at(off, 0), [200, 100, 50, 0]);
    const on = resamplePixels(src, 2, 1, 2, 1, "nearest", { cleanTransparent: true });
    eq("clean.on.zeroes-rgb", at(on, 0), [0, 0, 0, 0]);
    eq("clean.on.keeps-opaque", at(on, 1), [10, 20, 30, 255]);
    // 其它算法也走同一条清理路径
    const onBi = resamplePixels(src, 2, 1, 4, 1, "bilinear", { cleanTransparent: true });
    eq("clean.on.bilinear", at(onBi, 0), [0, 0, 0, 0]);
    // 不勾选时完全透明像素的 RGB 也不会被算法凭空点亮成黑
    ok("clean.off.transparent-not-blackened", at(off, 0)[3] === 0);
  }

  // ------------------------------------------------- 极端尺寸 / 非法输入 / 上限
  {
    // 1×1 放大到 N×N：纯色恒等
    const one = px(9, 8, 7, 255);
    const big = resamplePixels(one, 1, 1, 5, 5, "bicubic");
    eq("extreme.1x1.up", [pxAt(big, 0, 0, 5).join(), pxAt(big, 4, 4, 5).join()], ["9,8,7,255", "9,8,7,255"]);
    // N×N 缩到 1×1：面积平均
    const many = solid(4, 4, [80, 80, 80, 255]);
    eq("extreme.down-to-1x1", at(resamplePixels(many, 4, 4, 1, 1, "area"), 0), [80, 80, 80, 255]);
    // 1×N / N×1
    const col = px(1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255, 4, 0, 0, 255);
    const colOut = resamplePixels(col, 1, 4, 1, 2, "area");
    eq("extreme.Nx1", [at(colOut, 0)[0], at(colOut, 1)[0]], [2, 4]);
    const rowOut = resamplePixels(col, 4, 1, 2, 1, "nearest");
    eq("extreme.1xN", [at(rowOut, 0)[0], at(rowOut, 1)[0]], [1, 3]);
    // 非法尺寸：不抛异常，返回全透明 / 空结果
    eq("extreme.zero-dst", resamplePixels(one, 1, 1, 0, 4, "nearest").length, 0);
    eq("extreme.zero-src", resamplePixels(new Uint8ClampedArray(0), 0, 0, 4, 4, "nearest").length, 64);
    eq("extreme.zero-src.all-transparent", at(resamplePixels(new Uint8ClampedArray(0), 0, 0, 4, 4, "nearest"), 0), [0, 0, 0, 0]);
    // 超过上限 1024：先钳到上限再算，绝不按入参分配内存
    const clamped = resamplePixels(solid(1024, MAX_SIZE, [1, 2, 3, 255]), 1024, MAX_SIZE, MAX_SIZE + 1, MAX_SIZE + 1, "nearest");
    eq("extreme.over-max.clamped", [clamped.length, MAX_SIZE], [MAX_SIZE * MAX_SIZE * 4, 1024]);
    eq("extreme.over-max.pixel", at(clamped, 0), [1, 2, 3, 255]);
    const tooSmall = new Uint8ClampedArray(4); // 声明 4×4 却只有 1 像素
    eq("extreme.short-buffer", resamplePixels(tooSmall, 4, 4, 2, 2, "area").length, 16);
    eq("extreme.short-buffer.transparent", at(resamplePixels(tooSmall, 4, 4, 2, 2, "area"), 0), [0, 0, 0, 0]);
  }

  // ------------------------------------------------------------- resampleRegion
  {
    // 4×4 画布，只有右下 2×2 有颜色；取那 2×2 放大到 4×4 再缩小回来
    const src = new Uint8ClampedArray(4 * 4 * 4);
    const put = (x: number, y: number, c: number[]): void => {
      const i = (y * 4 + x) * 4;
      src[i] = c[0]; src[i + 1] = c[1]; src[i + 2] = c[2]; src[i + 3] = c[3];
    };
    put(2, 2, [11, 22, 33, 255]);
    put(3, 2, [44, 55, 66, 255]);
    put(2, 3, [77, 88, 99, 255]);
    put(3, 3, [111, 122, 133, 255]);
    const up = resampleRegion(src, 4, 4, 2, 2, 2, 2, 4, 4, "nearest");
    eq("region.len", up.length, 64);
    eq("region.up.block", [pxAt(up, 0, 0, 4), pxAt(up, 3, 3, 4)], [[11, 22, 33, 255], [111, 122, 133, 255]]);
    const down = resampleRegion(src, 4, 4, 2, 2, 2, 2, 1, 1, "area");
    const avg = at(down, 0);
    eq("region.down.average", [avg[0], avg[1], avg[2], avg[3]], [61, 72, 83, 255]);
    // 越界取样被钳住，不会读到缓冲区外
    const edge = resampleRegion(src, 4, 4, 3, 3, 2, 2, 2, 2, "nearest");
    eq("region.clamped", pxAt(edge, 1, 1, 2), [111, 122, 133, 255]);
  }

  // ---------------------------------------------- ops.scaleDocSprite（老行为）
  {
    const doc = new Doc(2, 2, "t");
    const c = doc.ensureCel(0, 0);
    c.data[c.idx(1, 0)] = 55; c.data[c.idx(1, 0) + 3] = 255;
    ops.scaleDocSprite(doc, 4, 4);
    eq("ops.sprite.dims", [doc.w, doc.h], [4, 4]);
    const c4 = doc.celAt(0, 0)!;
    eq("ops.sprite.nearest-unchanged", [c4.data[c4.idx(2, 0)], c4.data[c4.idx(3, 0)], c4.data[c4.idx(3, 0) + 3]], [55, 55, 255]);
    // 显式传算法：bilinear 走同一份引擎
    const doc2 = new Doc(3, 3, "t");
    const c2 = doc2.ensureCel(0, 0);
    for (let i = 0; i < 9; i++) { c2.data[i * 4] = 200; c2.data[i * 4 + 3] = 255; }
    ops.scaleDocSprite(doc2, 6, 6, "bilinear");
    const c6 = doc2.celAt(0, 0)!;
    eq("ops.sprite.algo-param", [c6.data[0], c6.data[3]], [200, 255]);
  }

  // -------------------------------------------------- Session.scaleAdvanced
  {
    const s = new Session();
    s.doc.w = 2; s.doc.h = 2;
    s.doc.cels.clear();
    const cel = s.doc.ensureCel(0, 0);
    cel.data[cel.idx(0, 0)] = 10; cel.data[cel.idx(0, 0) + 3] = 255;
    cel.data[cel.idx(1, 1)] = 200; cel.data[cel.idx(1, 1) + 3] = 255;
    // 2×2 的四个像素各不相同，撤销/重做时的像素对应关系才看得出来
    cel.data[cel.idx(1, 0)] = 40; cel.data[cel.idx(1, 0) + 3] = 255;
    cel.data[cel.idx(0, 1)] = 70; cel.data[cel.idx(0, 1) + 3] = 255;
    s.doc.name = "scale-test";
    s.history.clear();

    // sprite 作用域 + nearest：一条历史，可撤销 / 可重做
    const okSprite = s.scaleAdvanced({ w: 4, h: 4, algo: "nearest", scope: "sprite" });
    ok("sess.sprite.ok", okSprite);
    eq("sess.sprite.dims", [s.doc.w, s.doc.h], [4, 4]);
    eq("sess.sprite.one-step", s.history.list().labels, ["scale-adv"]);
    const s4 = s.doc.celAt(0, 0)!;
    eq("sess.sprite.pixel", [s4.data[s4.idx(0, 0)], s4.data[s4.idx(2, 0)], s4.data[s4.idx(0, 2)], s4.data[s4.idx(3, 3)]], [10, 40, 70, 200]);
    s.undo();
    eq("sess.sprite.undo-dims", [s.doc.w, s.doc.h], [2, 2]);
    const s2 = s.doc.celAt(0, 0)!;
    eq("sess.sprite.undo-pixels", [s2.data[s2.idx(0, 0)], s2.data[s2.idx(1, 0)], s2.data[s2.idx(0, 1)], s2.data[s2.idx(1, 1)]], [10, 40, 70, 200]);
    s.redo();
    eq("sess.sprite.redo-dims", [s.doc.w, s.doc.h], [4, 4]);

    // 同尺寸 + sprite = 什么都不做（不产生空历史）
    s.history.clear();
    ok("sess.sprite.same-size-noop", !s.scaleAdvanced({ w: 4, h: 4, algo: "area", scope: "sprite" }));
    ok("sess.sprite.same-size-no-hist", !s.history.canUndo());

    // 尺寸钳制：0 / 负数 / 超上限都落到 1..1024
    s.history.clear();
    s.scaleAdvanced({ w: 0, h: -5, algo: "nearest", scope: "sprite" });
    eq("sess.clamp.min", [s.doc.w, s.doc.h], [1, 1]);
    s.undo();
    eq("sess.clamp.undo", [s.doc.w, s.doc.h], [4, 4]);
    // 超上限：不崩，落到 1024（这里只验证不抛 + 落在上限内）
    s.history.clear();
    s.scaleAdvanced({ w: 5000, h: 4, algo: "nearest", scope: "sprite" });
    eq("sess.clamp.max", s.doc.w, 1024);
    s.undo();

    // layer 作用域：只动当前图层，**画布尺寸不变**（其余图层连尺寸都不动）
    s.doc.w = 4; s.doc.h = 4; s.doc.cels.clear();
    const l0 = s.doc.ensureCel(0, 0);
    l0.data[l0.idx(0, 0)] = 30; l0.data[l0.idx(0, 0) + 3] = 255;
    s.layerAdd();               // 在第 0 层之上插入新层（插入后仍停留在原图层）
    eq("sess.layer.count", s.doc.layers.length, 2);
    s.setLayer(1);              // 切到新层：高级缩放只动"当前图层"
    const li = s.curLayer();
    eq("sess.layer.current", li, 1);
    const l1 = s.doc.ensureCel(li, 0);
    l1.data[l1.idx(1, 1)] = 90; l1.data[l1.idx(1, 1) + 3] = 255;
    s.history.clear();
    ok("sess.layer.ok", s.scaleAdvanced({ w: 8, h: 8, algo: "nearest", scope: "layer" }));
    eq("sess.layer.dims", [s.doc.w, s.doc.h], [4, 4]);
    eq("sess.layer.one-step", s.history.list().labels, ["scale-layer"]);
    const nl0 = s.doc.celAt(0, 0)!;
    // 别的图层一个像素都不动（画布没变，所以也不会被重采样）
    eq("sess.layer.other-untouched", [nl0.data[nl0.idx(0, 0)], nl0.data[nl0.idx(0, 0) + 3], nl0.data[nl0.idx(1, 0) + 3]], [30, 255, 0]);
    const nl1 = s.doc.celAt(li, 0)!;
    // 当前图层内容放大到 8×8 后按左上角贴回 4×4：源 (1,1) 的 90 落在 (2,2)-(3,3)，其余为空
    eq("sess.layer.target-scaled", [nl1.data[nl1.idx(2, 2)], nl1.data[nl1.idx(3, 3)]], [90, 90]);
    eq("sess.layer.target-topleft-empty", [nl1.data[nl1.idx(0, 0) + 3], nl1.data[nl1.idx(1, 1) + 3]], [0, 0]);
    // cel 必须始终与画布等大（engine/cel.ts 的约定），图层缩放不能把它撑大
    eq("sess.layer.cel-size-kept", [nl1.w, nl1.h], [4, 4]);
    s.undo();
    const ul1 = s.doc.celAt(li, 0)!;
    eq("sess.layer.undo", [ul1.data[ul1.idx(1, 1)], ul1.data[ul1.idx(2, 2) + 3]], [90, 0]);

    // selection 作用域：画布尺寸不变；没有选区时明确失败
    s.setLayer(0);                     // 选区缩放作用于「当前图层」，切回有内容的那一层
    s.doc.w = 4; s.doc.h = 4; s.doc.cels.clear();
    const sc = s.doc.ensureCel(0, 0);
    sc.data[sc.idx(0, 0)] = 5; sc.data[sc.idx(0, 0) + 3] = 255;
    sc.data[sc.idx(1, 0)] = 9; sc.data[sc.idx(1, 0) + 3] = 255;
    sc.data[sc.idx(0, 1)] = 11; sc.data[sc.idx(0, 1) + 3] = 255;
    sc.data[sc.idx(1, 1)] = 7; sc.data[sc.idx(1, 1) + 3] = 255;
    sc.data[sc.idx(3, 3)] = 66; sc.data[sc.idx(3, 3) + 3] = 255;   // 选区外的参照像素
    s.doc.sel = null;
    s.history.clear();
    ok("sess.sel.no-selection", !s.scaleAdvanced({ w: 2, h: 2, algo: "nearest", scope: "selection" }));
    ok("sess.sel.no-selection-no-hist", !s.history.canUndo());

    // 选住 (0,0)-(1,1) 的 2×2、放大到 3×3：内容以选区左上角为锚点铺开，盖住 (0,0)-(2,2)
    s.doc.sel = newSel(4, 4, [[0, 0], [1, 0], [0, 1], [1, 1]]);
    s.history.clear();
    ok("sess.sel.ok", s.scaleAdvanced({ w: 3, h: 3, algo: "nearest", scope: "selection" }));
    eq("sess.sel.canvas-unchanged", [s.doc.w, s.doc.h], [4, 4]);
    eq("sess.sel.one-step", s.history.list().labels, ["scale-sel"]);
    const sc2 = s.doc.celAt(0, 0)!;
    // 最近邻 2×2→3×3 的映射：i=0,1→源 0；i=2→源 1，所以每个源像素占 2 格
    eq("sess.sel.grown.row0", [sc2.data[sc2.idx(0, 0)], sc2.data[sc2.idx(1, 0)], sc2.data[sc2.idx(2, 0)]], [5, 5, 9]);
    eq("sess.sel.grown.row2", [sc2.data[sc2.idx(0, 2)], sc2.data[sc2.idx(2, 2)]], [11, 7]);
    // 选区之外完全不动：原来 (3,3) 的 66 还在
    eq("sess.sel.outside-kept", [sc2.data[sc2.idx(3, 3)], sc2.data[sc2.idx(3, 3) + 3]], [66, 255]);
    // 选区跟着内容变成 3×3（「选区＝刚缩放出来的那块」，后续操作才对得上）
    const sb2 = s.doc.sel ? s.doc.sel.bounds() : null;
    eq("sess.sel.mask-grown", sb2 ? [sb2.x, sb2.y, sb2.w, sb2.h] : null, [0, 0, 3, 3]);
    s.undo();
    const sc3 = s.doc.celAt(0, 0)!;
    eq("sess.sel.undo", [sc3.data[sc3.idx(0, 0)], sc3.data[sc3.idx(2, 0)], sc3.data[sc3.idx(3, 3)]], [5, 0, 66]);
    const sb3 = s.doc.sel ? s.doc.sel.bounds() : null;
    eq("sess.sel.undo-mask", sb3 ? [sb3.x, sb3.y, sb3.w, sb3.h] : null, [0, 0, 2, 2]);

    // 缩到 1×1：选区里 4 个像素被 area 合并成一个、写回选区左上角，选区也变成 1×1
    s.history.clear();
    ok("sess.sel.shrink-ok", s.scaleAdvanced({ w: 1, h: 1, algo: "area", scope: "selection" }));
    eq("sess.sel.shrink-steps", s.history.list().labels, ["scale-sel"]);
    const sc4 = s.doc.celAt(0, 0)!;
    // 4 个像素等权平均：(5+9+11+7)/4 = 8，落在选区左上角；选区外的老像素原样保留
    eq("sess.sel.shrink-merged", [sc4.data[sc4.idx(0, 0)], sc4.data[sc4.idx(0, 0) + 3]], [8, 255]);
    eq("sess.sel.shrink-keeps-old", [sc4.data[sc4.idx(1, 1)], sc4.data[sc4.idx(1, 1) + 3]], [7, 255]);
    const sb4 = s.doc.sel ? s.doc.sel.bounds() : null;
    eq("sess.sel.shrink-mask", sb4 ? [sb4.x, sb4.y, sb4.w, sb4.h] : null, [0, 0, 1, 1]);
    s.undo();
    const sc5 = s.doc.celAt(0, 0)!;
    eq("sess.sel.shrink-undo", [sc5.data[sc5.idx(0, 0)], sc5.data[sc5.idx(1, 0)], sc5.data[sc5.idx(1, 1)]], [5, 9, 7]);

    // 同尺寸重采样等于原样：必须当"没操作"（不压历史、不返回成功）
    s.history.clear();
    ok("sess.sel.same-size-noop", !s.scaleAdvanced({ w: 2, h: 2, algo: "bilinear", scope: "selection" }));
    ok("sess.sel.same-size-no-hist", !s.history.canUndo());

    // 选区缩放遇到 scale2x 但比例不符（2×2 → 3×3 不是 2×）-> 自动降级到 nearest
    s.doc.sel = newSel(4, 4, [[0, 0], [1, 0], [0, 1], [1, 1]]);
    s.history.clear();
    ok("sess.sel.downgrade-ok", s.scaleAdvanced({ w: 3, h: 3, algo: "scale2x", scope: "selection" }));
    eq("sess.sel.downgrade-dims", [s.doc.w, s.doc.h], [4, 4]);
    s.undo();

    // 空图层（没有任何 cel）时不报错
    s.doc.cels.clear();
    s.history.clear();
    ok("sess.empty.no-crash", s.scaleAdvanced({ w: 2, h: 2, algo: "area", scope: "sprite" }) === false);
    ok("sess.empty.no-hist", !s.history.canUndo());
  }

  // ------------------------------------------------------ UI 静态接线检查
  // 没有 DOM，所以按仓库既有做法（i18n / guide-anchors 测试）静态扫描源码：
  // 引擎 → Session → 对话框 → 入口 这条链上的每一环都必须在场，否则功能会「存在但进不去」。
  {
    const ui = path.resolve(__dirname, "../../../src/ui");
    const modals = fs.readFileSync(path.join(ui, "modals.tsx"), "utf8");
    const app = fs.readFileSync(path.join(ui, "App.tsx"), "utf8");
    const i18n = fs.readFileSync(path.join(ui, "i18n.ts"), "utf8");
    const css = fs.readFileSync(path.join(ui, "style.css"), "utf8");
    ok("ui.scale-modal", modals.includes("export function ScaleModal"));
    ok("ui.scale-modal-preview", modals.includes("function ScalePreview"));
    ok("ui.scale-modal-preview-canvas", modals.includes("putImageData") && modals.includes("getContext(\"2d\")"));
    ok("ui.scale-modal-imports-engine", /from "\.\.\/engine\/resample"/.test(modals));
    ok("ui.scale-modal-uses-meta", modals.includes("SCALE_ALGOS.map") && /t\(\s*a\.nameKey\s*\)/.test(modals) && /t\(SCALE_ALGOS\.find/.test(modals));
    ok("ui.scale-modal-uses-supported", modals.includes("algoSupported(") && modals.includes("effectiveAlgo("));
    ok("ui.modal-id", /ModalId = .*"scaleadv"/.test(modals));
    ok("ui.app-renders-modal", app.includes("ScaleModal") && app.includes('modal === "scaleadv"'));
    ok("ui.orb-entry", app.includes('id: "scaleAdv"') && app.includes("onCanvasScaleAdv"));
    ok("ui.size-modal-jump", modals.includes("onAdvanced") && app.includes('onAdvanced={() => setModal("scaleadv")}'));
    ok("ui.icon-not-hardcoded", !/#[0-9a-fA-F]{3,6}/.test(modals.slice(modals.indexOf("function ScaleModal"), modals.indexOf("function SizeModal"))));
    ok("ui.css-classes", css.includes(".scale-frames") && css.includes(".scale-cv") && css.includes(".scale-quote") === false);
    // 对比预览是单独一屏：弹窗里只留按钮，预览面板走 portal（.dlg 自带 transform，
    // fixed 子元素會被它当包含块）、图更大、有自己的 i18n 文案
    ok("ui.scale-compare-button", modals.includes('t("scaleCompare")') && modals.includes('icon="i-compare"'));
    ok("ui.scale-compare-portal", modals.includes("createPortal") && /cmpOpen && createPortal/.test(modals));
    ok("ui.scale-compare-css", css.includes(".dlg-scale-compare"));
    ok("ui.scale-compare-size", /size = 44/.test(modals) && modals.includes("const SW = size") && modals.includes("size={128}"));
    // 预览不再长在参数表单里：全文只有一处 <ScalePreview>，且在对比面板内部
    ok("ui.scale-modal-no-inline-preview", (modals.match(/<ScalePreview/g) || []).length === 1
      && modals.indexOf("<ScalePreview") > modals.indexOf("cmpOpen && createPortal"));
    // index.html 与源码不在同一层（仓库根 / app2/www），构建目录里也没有这份副本，
    // 所以向上逐层找一次，找不到就跳过（和 tests/icons.test.ts 同一套兜底）
    let html = "";
    for (let up = 3; up <= 7 && !html; up++) {
      const cand = path.resolve(__dirname, "../../".repeat(up) + "app2/www/index.html");
      if (fs.existsSync(cand)) html = fs.readFileSync(cand, "utf8");
    }
    ok("ui.icon-symbol", html === "" ? true : html.includes('id="i-scale-adv"'), html === "" ? "index.html not reachable" : "");
    // i18n：算法名的 nameKey / descKey 必须都在字典里（中英各一条，i18n.test 也会校验）
    for (const key of ["scaleAlgoNearest", "scaleAlgoBilinear", "scaleAlgoBicubic", "scaleAlgoArea", "scaleAlgo2x", "scaleAlgo3x",
      "scaleNearestDesc", "scaleBilinearDesc", "scaleBicubicDesc", "scaleAreaDesc", "scale2xDesc", "scale3xDesc",
      "scaleAdv", "scaleOpts", "scaleQuick", "scaleScope", "scaleScopeSel", "scaleClean", "scalePreview", "scaleCompare",
      "scaleCompareHint", "scaleUnsupported", "scaleSelEmpty", "scaleSameSize"]) {
      const hits = i18n.split("  " + key + ":").length - 1;
      eq("ui.i18n." + key, hits, 2);
    }
  }

  // --------------------------------------------------- 与历史/撤销的交互
  {
    const s = new Session();
    s.doc.w = 2; s.doc.h = 2; s.doc.cels.clear();
    const c = s.doc.ensureCel(0, 0);
    c.data[c.idx(0, 0)] = 12; c.data[c.idx(0, 0) + 3] = 255;
    s.history.clear();
    s.scaleAdvanced({ w: 4, h: 4, algo: "nearest", scope: "sprite" });
    s.scaleAdvanced({ w: 8, h: 8, algo: "nearest", scope: "sprite" });
    eq("sess.hist.two-steps", s.history.list().labels.length, 2);
    s.undo();
    eq("sess.hist.undo-one", [s.doc.w, s.doc.h], [4, 4]);
    s.undo();
    eq("sess.hist.undo-two", [s.doc.w, s.doc.h], [2, 2]);
    s.redo(); s.redo();
    eq("sess.hist.redo-all", [s.doc.w, s.doc.h], [8, 8]);
  }
}

/** 造一个只含指定坐标的选区（掩膜是像素索引，不是字节偏移） */
function newSel(w: number, h: number, pts: number[][]): Sel {
  const s = new Sel(w, h);
  for (const [x, y] of pts) s.mask[y * w + x] = 1;
  s.bump();
  return s;
}

/**
 * Scale2x / EPX 的独立参考实现。刻意用**和引擎不同的写法**：这是 Eric 的 EPX 形式——
 * 先判 guard(B!=H && D!=F)，成立时逐格问「这个邻居是不是顺着边接过来的」
 * （D==B / B==F / D==H / H==F），guard 不成立就整块保留自己。
 * 它与 Andrea Mazzoleni 的 Scale2x 四个条件式数学等价（可互推），但代码结构完全不同，
 * 所以两边逐字节一致才说明规则真写对了——照抄引擎写一遍的"参考实现"是假绿。
 */
function refScale2x(src: Uint8ClampedArray, sw: number, sh: number): Uint8ClampedArray {
  const dw = sw * 2, dh = sh * 2;
  const out = new Uint8ClampedArray(dw * dh * 4);
  const eqPx = (a: number, b: number): boolean => {
    for (let k = 0; k < 4; k++) if (src[a + k] !== src[b + k]) return false;
    return true;
  };
  const put = (x: number, y: number, si: number): void => {
    const di = (y * dw + x) * 4;
    out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2]; out[di + 3] = src[si + 3];
  };
  const at2 = (x: number, y: number): number => {
    const cx = x < 0 ? 0 : x >= sw ? sw - 1 : x;
    const cy = y < 0 ? 0 : y >= sh ? sh - 1 : y;
    return (cy * sw + cx) * 4;
  };
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const E = at2(x, y), B = at2(x, y - 1), H = at2(x, y + 1), D = at2(x - 1, y), F = at2(x + 1, y);
      if (!eqPx(B, H) && !eqPx(D, F)) {
        put(x * 2, y * 2, eqPx(D, B) ? D : E);
        put(x * 2 + 1, y * 2, eqPx(B, F) ? F : E);
        put(x * 2, y * 2 + 1, eqPx(D, H) ? D : E);
        put(x * 2 + 1, y * 2 + 1, eqPx(H, F) ? F : E);
      } else {
        put(x * 2, y * 2, E);
        put(x * 2 + 1, y * 2, E);
        put(x * 2, y * 2 + 1, E);
        put(x * 2 + 1, y * 2 + 1, E);
      }
    }
  }
  return out;
}

/**
 * Scale3x 的独立参考实现：**逐行直译 scale2x 项目 `scale3x.c` 的 C 代码**——
 * border()/center() 两个函数 + 首像素/中间像素/末像素三段特判 + 上下边界行钳制，
 * 而不是引擎那版「外层 guard + 3×3 九格」的紧凑写法。
 * 两条结构完全不同的路径逐字节一致，才能说明紧凑写法没把 E1/E3/E5/E7 里的
 * `E!=<对角>` 条件写漏（漏掉就会把无关的邻居颜色糊进来）。
 * 注意：C 源码本身 assert(count >= 2)，所以本参考实现只用于 sw >= 2 的图；
 * sw === 1 的边界行为由引擎侧的独立断言覆盖（引擎那里四邻按边缘钳制）。
 */
function refScale3x(src: Uint8ClampedArray, sw: number, sh: number): Uint8ClampedArray {
  const dw = sw * 3, dh = sh * 3;
  const out = new Uint8ClampedArray(dw * dh * 4);
  const idx = (x: number, y: number): number => (y * sw + x) * 4;
  const same = (a: number, b: number): boolean => {
    for (let k = 0; k < 4; k++) if (src[a + k] !== src[b + k]) return false;
    return true;
  };
  const put = (x: number, y: number, si: number): void => {
    const di = (y * dw + x) * 4;
    out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2]; out[di + 3] = src[si + 3];
  };
  const last = sw - 1;
  for (let y = 0; y < sh; y++) {
    const ry0 = y > 0 ? y - 1 : y;         // 上一行（第一行钳制成自己，对应 C 调用方传 src0=src1）
    const ry2 = y < sh - 1 ? y + 1 : y;    // 下一行（最后一行钳制成自己）
    const U = (x: number): number => idx(x, ry0);   // C 里的 src0
    const B = (x: number): number => idx(x, y);     // C 里的 src1（本行）
    const Dn = (x: number): number => idx(x, ry2);  // C 里的 src2

    /** C: scale3x_*_border(dst, src0, src1, src2) 的完整转写（九个输出格只写三行里的一行） */
    const border = (dstRow: number, s0: (x: number) => number, s2: (x: number) => number): void => {
      const oy = y * 3 + dstRow;
      if (!same(s0(0), s2(0)) && !same(B(0), B(1))) {
        put(0, oy, B(0));
        put(1, oy, (same(B(0), s0(0)) && !same(B(0), s0(1))) || (same(B(1), s0(0)) && !same(B(0), s0(0))) ? s0(0) : B(0));
        put(2, oy, same(B(1), s0(0)) ? B(1) : B(0));
      } else {
        put(0, oy, B(0)); put(1, oy, B(0)); put(2, oy, B(0));
      }
      for (let x = 1; x < last; x++) {
        if (!same(s0(x), s2(x)) && !same(B(x - 1), B(x + 1))) {
          put(3 * x, oy, same(B(x - 1), s0(x)) ? B(x - 1) : B(x));
          put(3 * x + 1, oy, (same(B(x - 1), s0(x)) && !same(B(x), s0(x + 1)))
            || (same(B(x + 1), s0(x)) && !same(B(x), s0(x - 1))) ? s0(x) : B(x));
          put(3 * x + 2, oy, same(B(x + 1), s0(x)) ? B(x + 1) : B(x));
        } else {
          put(3 * x, oy, B(x)); put(3 * x + 1, oy, B(x)); put(3 * x + 2, oy, B(x));
        }
      }
      if (sw > 1) {
        if (!same(s0(last), s2(last)) && !same(B(last - 1), B(last))) {
          put(3 * last, oy, same(B(last - 1), s0(last)) ? B(last - 1) : B(last));
          put(3 * last + 1, oy, (same(B(last - 1), s0(last)) && !same(B(last), s0(last)))
            || (same(B(last), s0(last)) && !same(B(last), s0(last - 1))) ? s0(last) : B(last));
          put(3 * last + 2, oy, B(last));
        } else {
          put(3 * last, oy, B(last)); put(3 * last + 1, oy, B(last)); put(3 * last + 2, oy, B(last));
        }
      }
    };

    /** C: scale3x_*_center(dst, src0, src1, src2) 的完整转写（中间那一行，E4 永远是本行像素） */
    const center = (dstRow: number, s0: (x: number) => number, s2: (x: number) => number): void => {
      const oy = y * 3 + dstRow;
      if (!same(s0(0), s2(0)) && !same(B(0), B(1))) {
        put(0, oy, B(0));
        put(1, oy, B(0));
        put(2, oy, (same(B(1), s0(0)) && !same(B(0), s2(1)))
          || (same(B(1), s2(0)) && !same(B(0), s0(1))) ? B(1) : B(0));
      } else {
        put(0, oy, B(0)); put(1, oy, B(0)); put(2, oy, B(0));
      }
      for (let x = 1; x < last; x++) {
        if (!same(s0(x), s2(x)) && !same(B(x - 1), B(x + 1))) {
          put(3 * x, oy, (same(B(x - 1), s0(x)) && !same(B(x), s2(x - 1)))
            || (same(B(x - 1), s2(x)) && !same(B(x), s0(x - 1))) ? B(x - 1) : B(x));
          put(3 * x + 1, oy, B(x));
          put(3 * x + 2, oy, (same(B(x + 1), s0(x)) && !same(B(x), s2(x + 1)))
            || (same(B(x + 1), s2(x)) && !same(B(x), s0(x + 1))) ? B(x + 1) : B(x));
        } else {
          put(3 * x, oy, B(x)); put(3 * x + 1, oy, B(x)); put(3 * x + 2, oy, B(x));
        }
      }
      if (sw > 1) {
        if (!same(s0(last), s2(last)) && !same(B(last - 1), B(last))) {
          put(3 * last, oy, (same(B(last - 1), s0(last)) && !same(B(last), s2(last - 1)))
            || (same(B(last - 1), s2(last)) && !same(B(last), s0(last - 1))) ? B(last - 1) : B(last));
          put(3 * last + 1, oy, B(last));
          put(3 * last + 2, oy, B(last));
        } else {
          put(3 * last, oy, B(last)); put(3 * last + 1, oy, B(last)); put(3 * last + 2, oy, B(last));
        }
      }
    };

    // C 的 scale3x_*_def()：dst0 = border(src0,src1,src2)、dst1 = center(...)、dst2 = border(src2,src1,src0)
    border(0, U, Dn);
    center(1, U, Dn);
    border(2, Dn, U);
  }
  return out;
}
