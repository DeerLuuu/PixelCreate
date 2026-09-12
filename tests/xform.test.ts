// 「移动 + 缩放 + 旋转 + 斜切」那套纯几何的回归（Aseprite 的交互模型）。
//
// 测的都是 `src/tools/xform.ts` 里的纯函数：矩阵组装、命中判定、拖拽解算、
// 枢轴 9 档与归一化跟位、缩放钳制、斜切 ±85° 钳制、像素精确搬运。
// 交互状态机（`View`）的回归在 `tests/xformui.test.ts`。
//
// 坐标口径（与 `warp.ts` 一致）：**像素下标空间**，一块 cw×ch 的内容占
// `0..cw-1` / `0..ch-1`；屏幕上画出来再加 0.5（像素中心）。
import {
  affineFrom, adjustPivot, applyAffine, anchorPoint, boxCenter, boxCorners, clampScale,
  clampTan, CLEAN_ANGLES_DEG, distToFrame, exactMove, indexBox, insideFrame, invertAffine,
  affineRotate, affineSkew, affineScale, affineTranslate,
  isExactTransform, isIntegerShift, isRightAngle, linearOf, mulAffine, normAngle, pivotComp,
  pivotInBox, pivotPresetAt, pivotPresetOf, pivotPresetPoint, PIVOT_PRESETS, scaleAnchor,
  screenAnchors, screenFrameOf, snapCleanAngle, solveRotate, solveScale, solveSkew,
  toFrameLocal, touchGrabs, touchLayout, transformedBox, ANCHORS, axisOf, isCorner,
  outerKindOf, ringHitAt, grabAt, rightAngleSteps, rotatedSize, SCALE_MAX, SCALE_MIN,
  TAN_SKEW_LIMIT, PC_HIT, TOUCH_HIT, TOUCH_OFF_CORNER, TOUCH_OFF_EDGE, TOUCH_OFF_OUTER, TOUCH_HIT_FLOOR,
  TOUCH_FULL_SPAN, TOUCH_MID_SPAN, TOUCH_MIN_SPAN, touchHitRadius, touchOuterOffset,
  skewBaseline, skewPivotOf, type AnchorId,
} from "../src/tools/xform";
import type { Mat3 } from "../src/tools/warp";
import { eq, ok } from "./common";

type P = { x: number; y: number };
const near = (a: number, b: number, t = 1e-9): boolean => Math.abs(a - b) <= t;
const nearPt = (p: P, q: P, t = 1e-9): boolean => near(p.x, q.x, t) && near(p.y, q.y, t);

export function testXform(): void {
  const box = indexBox(6, 4);              // 内容下标 0..5 / 0..3

  // ---------------------------------------------------------------- 框 / 锚点
  {
    eq("xform.box.index", [box.x0, box.y0, box.x1, box.y1], [0, 0, 5, 3]);
    eq("xform.box.corners", boxCorners(box), [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 3 }, { x: 0, y: 3 }]);
    eq("xform.box.center", boxCenter(box), { x: 2.5, y: 1.5 });
    eq("xform.anchor.tl", anchorPoint(box, "tl"), { x: 0, y: 0 });
    eq("xform.anchor.br", anchorPoint(box, "br"), { x: 5, y: 3 });
    eq("xform.anchor.r", anchorPoint(box, "r"), { x: 5, y: 1.5 });
    eq("xform.anchor.t", anchorPoint(box, "t"), { x: 2.5, y: 0 });
    // 缩放的锚点＝对角（角）/ 对边中点（边），否则内容不会「从对面长出来」
    eq("xform.scaleAnchor.tl", scaleAnchor(box, "tl"), { x: 5, y: 3 });
    eq("xform.scaleAnchor.br", scaleAnchor(box, "br"), { x: 0, y: 0 });
    eq("xform.scaleAnchor.t", scaleAnchor(box, "t"), { x: 2.5, y: 3 });
    eq("xform.scaleAnchor.l", scaleAnchor(box, "l"), { x: 5, y: 1.5 });
    // 轴：角＝两轴，上下边＝y，左右边＝x
    eq("xform.axis.corners", [axisOf("tl"), axisOf("tr"), axisOf("br"), axisOf("bl")], ["xy", "xy", "xy", "xy"]);
    eq("xform.axis.edges", [axisOf("t"), axisOf("b"), axisOf("l"), axisOf("r")], ["y", "y", "x", "x"]);
    eq("xform.anchor.corners", ANCHORS.filter(isCorner), ["tl", "tr", "br", "bl"]);
    eq("xform.outer.kinds", ANCHORS.map(outerKindOf),
      ["rotate", "skew", "rotate", "skew", "rotate", "skew", "rotate", "skew"]);
  }

  // ---------------------------------------------------------------- 角度与吸附
  {
    // 干净角表：0 / 26.565 / 45 / 63.435 / 90 …（不是 15° 倍数）
    eq("xform.clean.first", CLEAN_ANGLES_DEG, [-161.56505117707798, -135, -116.56505117707799, -90, -71.56505117707799, -45, -26.56505117707799, 0, 26.56505117707799, 45, 71.56505117707799, 90, 116.56505117707799, 135, 161.56505117707798, 180]);
    eq("xform.clean.order", CLEAN_ANGLES_DEG.length, 16);
    ok("xform.clean.has-90", CLEAN_ANGLES_DEG.some((d) => near(d, 90, 1e-9)));
    ok("xform.clean.no-15", !CLEAN_ANGLES_DEG.some((d) => near(d, 15, 1e-6)));
    ok("xform.clean.no-30", !CLEAN_ANGLES_DEG.some((d) => near(d, 30, 1e-6)));
    ok("xform.clean.has-116", CLEAN_ANGLES_DEG.some((d) => near(d, 116.56505117707799, 1e-9)));
    ok("xform.clean.has-153", CLEAN_ANGLES_DEG.some((d) => near(d, -161.56505117707798, 1e-9)));
    ok("xform.clean.has-neg", CLEAN_ANGLES_DEG.some((d) => near(d, -26.56505117707799, 1e-9)) && CLEAN_ANGLES_DEG.some((d) => near(d, -90, 1e-9)));
    const deg = (r: number): number => (r * 180) / Math.PI;
    // 吸附：26.565 附近的吸到 26.565（不是 30）
    eq("xform.snap.26", Math.round(deg(snapCleanAngle((27 * Math.PI) / 180)) * 1000) / 1000, 26.565);
    eq("xform.snap.28", Math.round(deg(snapCleanAngle((28.5 * Math.PI) / 180)) * 1000) / 1000, 26.565);
    eq("xform.snap.44", Math.round(deg(snapCleanAngle((44 * Math.PI) / 180)) * 1000) / 1000, 45);
    eq("xform.snap.89", Math.round(deg(snapCleanAngle((89 * Math.PI) / 180)) * 1000) / 1000, 90);
    eq("xform.snap.negative", Math.round(deg(snapCleanAngle((-89 * Math.PI) / 180)) * 1000) / 1000, -90);
    eq("xform.snap.neg-27", Math.round(deg(snapCleanAngle((-27 * Math.PI) / 180)) * 1000) / 1000, -26.565);
    eq("xform.snap.180", Math.round(deg(snapCleanAngle(Math.PI * 0.999)) * 1000) / 1000, 180);
    // 归一化
    ok("xform.norm.pi", near(normAngle(Math.PI * 3), Math.PI));
    ok("xform.norm.neg", near(normAngle(-Math.PI * 1.5), Math.PI * 0.5));
    // 90° 倍数判定与圈数
    eq("xform.right.steps", [0, 90, 180, 270, 360, -90].map((d) => rightAngleSteps((d * Math.PI) / 180)), [0, 1, 2, 3, 0, 3]);
    ok("xform.right.yes", isRightAngle(Math.PI / 2) && isRightAngle(Math.PI) && isRightAngle(0));
    ok("xform.right.no", !isRightAngle((26.565 * Math.PI) / 180));
    ok("xform.integer-shift", isIntegerShift(3) && isIntegerShift(-4) && !isIntegerShift(0.5));
  }

  // ---------------------------------------------------------------- 矩阵组装
  {
    const id = affineFrom({ pivot: { x: 2, y: 2 }, angle: 0, sx: 1, sy: 1 });
    eq("xform.mat.identity", id, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    // 纯平移：绕枢轴的旋转 / 缩放都是恒等时，矩阵就是平移
    const tr = affineFrom({ pivot: { x: 0, y: 0 }, angle: 0, sx: 1, sy: 1, shift: { x: 3, y: -2 } });
    eq("xform.mat.shift", applyAffine(tr, { x: 1, y: 1 }), { x: 4, y: -1 });
    // 绕枢轴缩放：枢轴不动
    const sc = affineFrom({ pivot: { x: 2, y: 2 }, angle: 0, sx: 2, sy: 3 });
    eq("xform.mat.scale-pivot", applyAffine(sc, { x: 2, y: 2 }), { x: 2, y: 2 });
    eq("xform.mat.scale-pt", applyAffine(sc, { x: 3, y: 3 }), { x: 4, y: 5 });
    // 90° 绕枢轴：整数点映到整数点（像素精确通道的基础）
    const r90 = affineFrom({ pivot: { x: 1, y: 1 }, angle: Math.PI / 2, sx: 1, sy: 1 });
    const p90 = applyAffine(r90, { x: 2, y: 1 });
    // 90° 的线性部分是**正交整数阵**（0/±1）：`R·Rᵀ = I`，且整数点映到整数点 ——
    // 这正是「像素精确通道」成立的前提（`isRightAngle()` + `exactMove()`）
    {
      const R: Mat3 = [r90[0], r90[1], 0, r90[3], r90[4], 0, 0, 0, 1];
      const Rt: Mat3 = [R[0], R[3], 0, R[1], R[4], 0, 0, 0, 1];
      eq("xform.mat.rot90-orthonormal", mulAffine(R, Rt).slice(0, 5), [1, 0, 0, 0, 1]);
      let worst = 0;
      for (let y = -3; y <= 3; y++) {
        for (let x = -3; x <= 3; x++) {
          const q = applyAffine(r90, { x, y });
          worst = Math.max(worst, Math.abs(q.x - Math.round(q.x)), Math.abs(q.y - Math.round(q.y)));
        }
      }
      ok("xform.mat.rot90-integers", worst < 1e-6, String(worst));
    }
    // 斜切：`dx += dy * tan`，枢轴所在水平线不动
    const sk = affineFrom({ pivot: { x: 0, y: 0 }, angle: 0, sx: 1, sy: 1, skewX: 0.5 });
    eq("xform.mat.skew-pivot-line", applyAffine(sk, { x: 3, y: 0 }), { x: 3, y: 0 });
    eq("xform.mat.skew-plus2", applyAffine(sk, { x: 3, y: 2 }), { x: 4, y: 2 });
    eq("xform.mat.skew-minus2", applyAffine(sk, { x: 3, y: -2 }), { x: 2, y: -2 });
    // 乘法与求逆
    const m = affineFrom({ pivot: { x: 1, y: 1 }, angle: 0.7, sx: 1.7, sy: 0.6, skewX: 0.3 });
    const inv = invertAffine(m)!;
    const q = applyAffine(m, { x: 4, y: -2 });
    ok("xform.mat.inverse", nearPt(applyAffine(inv, q), { x: 4, y: -2 }, 1e-9), JSON.stringify(q));
    const one = mulAffine(m, inv);
    ok("xform.mat.mul-inverse", near(one[0], 1, 1e-9) && near(one[1], 0, 1e-9) && near(one[4], 1, 1e-9), JSON.stringify(one));
    eq("xform.mat.singular", invertAffine([0, 0, 0, 0, 0, 0, 0, 0, 1]), null);
    eq("xform.linear.no-translation", linearOf({ pivot: { x: 9, y: 9 }, angle: 0, sx: 2, sy: 0.5 }).slice(0, 2), [2, 0]);
  }

  // ---------------------------------------------------------------- 钳制（防爆内存 / 防无穷）
  {
    eq("xform.clamp.low", clampScale(0), SCALE_MIN);
    eq("xform.clamp.neg-low", clampScale(-0.0001), -SCALE_MIN);
    eq("xform.clamp.high", clampScale(1e9), SCALE_MAX);
    eq("xform.clamp.nan", clampScale(NaN), SCALE_MIN);
    eq("xform.clamp.normal", clampScale(1.5), 1.5);
    ok("xform.clamp.tan-limit", near(clampTan(1e9), TAN_SKEW_LIMIT));
    ok("xform.clamp.tan-neg", near(clampTan(-1e9), -TAN_SKEW_LIMIT));
    eq("xform.clamp.tan-normal", clampTan(0.4), 0.4);
    eq("xform.clamp.tan-inf", clampTan(Infinity), TAN_SKEW_LIMIT);
    // 极端缩放下包围盒仍然是有限数字（不会算出天文数字的宽高）
    const huge = affineFrom({ pivot: { x: 0, y: 0 }, angle: 0, sx: SCALE_MAX, sy: SCALE_MAX });
    const tb = transformedBox(huge, 100, 100);
    ok("xform.clamp.box-finite", Number.isFinite(tb.x1) && tb.x1 <= 4000, JSON.stringify(tb));
  }

  // ---------------------------------------------------------------- 缩放解算
  {
    const b = indexBox(6, 4);                       // 内容 6×4
    const a = scaleAnchor(b, "br");                 // 拖右下角：左上角是不动点
    eq("xform.solve.anchor", a, { x: 0, y: 0 });
    const from = anchorPoint(b, "br");
    // 往外拖一倍：等比放大 2×
    const s2 = solveScale(from, { x: from.x * 2, y: from.y * 2 }, a, "xy");
    eq("xform.solve.double", [s2.sx, s2.sy], [2, 2]);
    // 只往右拖：x 变、y 不变
    const sx2 = solveScale(from, { x: from.x * 2, y: from.y }, a, "xy");
    eq("xform.solve.axis-x", [sx2.sx, sx2.sy], [2, 1]);
    // 拖过不动点（负坐标）：**镜像翻转**，不是取绝对值
    // 从「不动点 + 偏移」拖到「不动点 - 偏移」＝镜像翻转（不是取绝对值）
    const mir = solveScale({ x: 2, y: 3 }, { x: -2, y: -3 }, a, "xy");
    eq("xform.solve.mirror", [mir.sx, mir.sy], [-1, -1]);
    const mirX = solveScale({ x: 2, y: 3 }, { x: -2, y: 3 }, a, "xy");
    eq("xform.solve.mirror-x", [mirX.sx, mirX.sy], [-1, 1]);
    // 等比（Shift / 「等比」chip）：取变化更大的那一轴
    const keep = solveScale(from, { x: from.x * 3, y: from.y * 1.2 }, a, "xy", true);
    eq("xform.solve.keep-aspect", [keep.sx, keep.sy], [3, 3]);
    // 单轴（边中点）：另一轴恒为 1
    const edge = solveScale(from, { x: from.x * 2, y: from.y * 5 }, a, "x");
    eq("xform.solve.edge-x", [edge.sx, edge.sy], [2, 1]);
    const edgeY = solveScale(from, { x: from.x * 5, y: from.y * 2 }, a, "y");
    eq("xform.solve.edge-y", [edgeY.sx, edgeY.sy], [1, 2]);
    // 网格吸附：吸附到整数倍
    const g = solveScale(from, { x: from.x * 2.4, y: from.y * 2.4 }, a, "xy", false, true);
    eq("xform.solve.grid-snap", [g.sx, g.sy], [2, 2]);
    const g2 = solveScale(from, { x: from.x * 2.6, y: from.y * 2.6 }, a, "xy", false, true);
    eq("xform.solve.grid-snap-up", [g2.sx, g2.sy], [3, 3]);
    // 抓手正好压在不动点上（0 长）：不改这一轴，避免除零
    const same = solveScale(from, from, a, "xy");
    eq("xform.solve.degenerate", [same.sx, same.sy], [1, 1]);
  }

  // ---------------------------------------------------------------- 旋转解算
  {
    const pivot: P = { x: 0, y: 0 };
    const from = { x: 10, y: 0 };                  // 起点在 +x 方向
    // 拖到 +y 方向 = 转了 90°
    const r = solveRotate(from, { x: 0, y: 10 }, false);
    ok("xform.rotate.90", near(Math.abs(r.angle), Math.PI / 2), String(r.angle));
    // 吸附到干净角：起点放在 27°、拖 0 位移 → 结果就是 26.565°
    const a27 = (27 * Math.PI) / 180;
    const rs = solveRotate({ x: 10, y: 0 }, { x: 10 * Math.cos(a27), y: 10 * Math.sin(a27) }, true);
    eq("xform.rotate.clean-snap", Math.round(((rs.angle * 180) / Math.PI) * 1000) / 1000, 26.565);
    ok("xform.rotate.snapped-flag", rs.snapped);
    // 不吸附时保持原样
    const rn = solveRotate({ x: 10, y: 0 }, { x: 10 * Math.cos(a27), y: 10 * Math.sin(a27) }, false);
    eq("xform.rotate.no-snap", Math.round(((rn.angle * 180) / Math.PI) * 1000) / 1000, 27);
    ok("xform.rotate.not-snapped-flag", !rn.snapped);
    // 吸附模式下拖到 90° 附近 → 正好 90°（像素精确通道才认得出来）
    const a89 = (89 * Math.PI) / 180;
    const r90 = solveRotate({ x: 1, y: 0 }, { x: Math.cos(a89), y: Math.sin(a89) }, true);
    // 拖过 90° 再往回一点：吸附结果仍然在 90° 那一档（不会翻到 -153°）
    const r92 = solveRotate({ x: 1, y: 0 }, { x: Math.cos((92 * Math.PI) / 180), y: Math.sin((92 * Math.PI) / 180) }, true);
    ok("xform.rotate.snaps-92", isRightAngle(r92.angle), String(r92.angle));
    ok("xform.rotate.snaps-to-90", isRightAngle(r90.angle), String(r90.angle));
  }

  // ---------------------------------------------------------------- 斜切解算
  {
    const b = indexBox(6, 4);                        // 内容 6×4：下标 0..5 / 0..3
    const piv = boxCenter(b);
    const OPP: Record<string, string> = { t: "b", b: "t", l: "r", r: "l" };
    /** 走一遍「拖某条边中点 → 算 tan → 组矩阵 → 看两条边各走了多少」（与 View 同一套调用） */
    const skewDrag = (id: AnchorId, dx: number, dy: number): { tan: number; dragged: number; opposite: number } => {
      const horiz = id === "t" || id === "b";
      const span = horiz ? Math.abs(b.y1 - b.y0) : Math.abs(b.x1 - b.x0);
      const p = anchorPoint(b, id);
      const tan = solveSkew(id, p, { x: p.x + dx, y: p.y + dy }, span).tan;
      const m = affineFrom({
        pivot: piv, angle: 0, sx: 1, sy: 1,
        skewX: horiz ? tan : 0, skewY: horiz ? 0 : tan,
        skewPivot: skewPivotOf(id, piv),
      });
      const a = applyAffine(m, p);
      const o = anchorPoint(b, OPP[id] as AnchorId);
      const q = applyAffine(m, o);
      return horiz
        ? { tan, dragged: a.x - p.x, opposite: q.x - o.x }
        : { tan, dragged: a.y - p.y, opposite: q.y - o.y };
    };

    // 四条边各拖 1 格：被拖的边整条平移 `Δ/2`、对面那条边反向平移 `Δ/2`
    // （基准线在枢轴那条线上，所以是「围绕枢轴反着走」，选中框因此保持形状 —— 与 Aseprite 一致）
    for (const id of ["t", "b", "l", "r"] as AnchorId[]) {
      const horiz = id === "t" || id === "b";
      const row = skewDrag(id, horiz ? 1 : 0, horiz ? 0 : 1);
      ok("xform.skew." + id + ".dragged", near(row.dragged, 0.5), String(row.dragged));
      ok("xform.skew." + id + ".opposite", near(row.opposite, -0.5), String(row.opposite));
      ok("xform.skew." + id + ".tan-nonzero", row.tan !== 0, String(row.tan));
    }
    // 拖反方向：位移跟着翻符号
    {
      const up = skewDrag("t", 1, 0), down = skewDrag("t", -1, 0);
      ok("xform.skew.flip", near(up.dragged, -down.dragged) && near(up.opposite, -down.opposite),
        JSON.stringify([up, down]));
    }
    // ±85° 钳制：拖到天边也不会翻出去
    {
      const huge = solveSkew("t", anchorPoint(b, "t"), { x: 1e6, y: 0 }, Math.abs(b.y1 - b.y0)).tan;
      ok("xform.skew.clamp-high", near(huge, -TAN_SKEW_LIMIT), String(huge));
      const huge2 = solveSkew("t", anchorPoint(b, "t"), { x: -1e6, y: 0 }, Math.abs(b.y1 - b.y0)).tan;
      ok("xform.skew.clamp-low", near(huge2, TAN_SKEW_LIMIT), String(huge2));
    }
    // 角不斜切（角的外圈是旋转）；跨度 0（框在被拖方向上是 1 像素）退化
    eq("xform.skew.corner", solveSkew("tl", { x: 0, y: 0 }, { x: 9, y: 9 }, 5).tan, 0);
    eq("xform.skew.zero-span", solveSkew("t", { x: 0, y: 0 }, { x: 5, y: 0 }, 0).tan, 0);
    // 固定线的取法：水平剪切看 `y`、竖直剪切看 `x`（另一半清零）
    eq("xform.skew.pivot-of-t", skewPivotOf("t", { x: 9, y: 3 }), { x: 0, y: 3 });
    eq("xform.skew.pivot-of-l", skewPivotOf("l", { x: 9, y: 3 }), { x: 9, y: 0 });
    eq("xform.skew.baseline", skewBaseline(b, "t"), { x: 2.5, y: 3 });

    // 线性部分与 `R · K · S` 逐项一致（平移分量由「枢轴不动」定，见下一条）
    {
      const pp: P = { x: 2.5, y: 1.5 }, sp: P = { x: 0, y: 1.5 };
      const base = affineFrom({ pivot: pp, angle: 0.7, sx: 1.2, sy: 0.8, skewX: 0.3, skewY: 0.4, skewPivot: sp });
      const hand = mulAffine(
        affineRotate(0.7),
        mulAffine(affineSkew(0.3, 0.4, { x: 0, y: 0 }), affineScale(1.2, 0.8, { x: 0, y: 0 })),
      );
      let worst = 0;
      for (let i = 0; i < 5; i++) {
        if (i === 2) continue;                        // 平移分量不比（由「枢轴不动」单独钉）
        worst = Math.max(worst, Math.abs(base[i] - hand[i]));
      }
      ok("xform.skew.linear-matches-primitives", worst < 1e-9, String(worst));
      // 平移分量：**枢轴必须是不动点**（`p' = p`）
      ok("xform.skew.pivot-fixed", nearPt(applyAffine(base, pp), pp, 1e-9), JSON.stringify(applyAffine(base, pp)));
      // 固定线上的点只沿着边方向动（水平剪切：y 不变）

    }
  }

  // ---------------------------------------------------------------- 枢轴
  {
    const b = indexBox(6, 4);
    eq("xform.pivot.9-presets", PIVOT_PRESETS.length, 9);
    eq("xform.pivot.cycle", [0, 1, 8, 9, -1].map(pivotPresetAt), ["tl", "tc", "br", "tl", "br"]);
    eq("xform.pivot.tl", pivotPresetPoint(b, "tl"), { x: 0, y: 0 });
    eq("xform.pivot.cc", pivotPresetPoint(b, "cc"), { x: 2.5, y: 1.5 });
    eq("xform.pivot.bc", pivotPresetPoint(b, "bc"), { x: 2.5, y: 3 });
    eq("xform.pivot.cr", pivotPresetPoint(b, "cr"), { x: 5, y: 1.5 });
    eq("xform.pivot.of", ["tl", "cc", "br"].map((k) => pivotPresetOf(b, pivotPresetPoint(b, k as never))), ["tl", "cc", "br"]);
    ok("xform.pivot.in-box", pivotInBox(b, { x: 5, y: 3 }) && pivotInBox(b, { x: 0, y: 0 }));
    ok("xform.pivot.out-box", !pivotInBox(b, { x: 9, y: 9 }));

    // 缩放后按**归一化比例**跟位：枢轴在右下角，放大 2× 后仍在右下角
    const scaled = { x0: 0, y0: 0, x1: 10, y1: 6 };
    eq("xform.pivot.follow-corner", adjustPivot(b, scaled, { x: 5, y: 3 }), { x: 10, y: 6 });
    // 中心跟到中心
    eq("xform.pivot.follow-centre", adjustPivot(b, scaled, { x: 2.5, y: 1.5 }), { x: 5, y: 3 });
    // 半途的点按比例走
    eq("xform.pivot.follow-half", adjustPivot(b, scaled, { x: 2.5, y: 0 }), { x: 5, y: 0 });
    // 退化框（宽高为 0）：落到中心而不是 NaN
    eq("xform.pivot.follow-degenerate", adjustPivot(indexBox(1, 1), indexBox(1, 1), { x: 0, y: 0 }), { x: 0, y: 0 });

    // 拖动枢轴时画面不动：pivotComp 补出的位移使得「任意点的像」保持不变
    const p0: P = { x: 2.5, y: 1.5 }, p1: P = { x: 0, y: 0 };
    const base = { angle: (40 * Math.PI) / 180, sx: 1.8, sy: 0.7, skewX: 0.2, skewPivot: p0 };
    const mOld = affineFrom({ pivot: p0, ...base });
    const shifted = pivotComp({ pivot: p1, pivot0: p0, ...base });
    const mNew = affineFrom({ pivot: p1, pivot0: p0, pivot0Shift: shifted, ...base, skewPivot: p1 });
    let worst = 0;
    for (const q of [{ x: 0, y: 0 }, { x: 5, y: 3 }, { x: 2.5, y: 0 }, { x: -3, y: 7 }]) {
      const a = applyAffine(mOld, q), c = applyAffine(mNew, q);
      worst = Math.max(worst, Math.abs(a.x - c.x), Math.abs(a.y - c.y));
    }
    ok("xform.pivot.drag-keeps-picture", worst < 1e-9, String(worst));
  }

  // ---------------------------------------------------------------- 屏幕框 / 命中
  {
    // 无旋转、zoom=1、ox=oy=0：内容 6×4 → 下标 0..5 / 0..3，画在像素中心
    const f = screenFrameOf(affineFrom({ pivot: { x: 3.5, y: 2.5 }, angle: 0, sx: 1, sy: 1 }), 8, 6, 1, 0, 0);
    eq("xform.screen.corners", f.corners.map((p) => [p.x, p.y]),
      [[0.5, 0.5], [7.5, 0.5], [7.5, 5.5], [0.5, 5.5]]);
    eq("xform.screen.span", [f.spanX, f.spanY], [7, 5]);
    eq("xform.screen.anchors", screenAnchors(f).map((p) => [p.x, p.y]),
      [[0.5, 0.5], [4, 0.5], [7.5, 0.5], [7.5, 3], [7.5, 5.5], [4, 5.5], [0.5, 5.5], [0.5, 3]]);
    ok("xform.screen.inside", insideFrame(f, { x: 3, y: 2 }));
    ok("xform.screen.outside", !insideFrame(f, { x: 9, y: 2 }) && !insideFrame(f, { x: 3, y: 7 }));
    eq("xform.screen.dist-to-frame", distToFrame(f, { x: 3, y: 0.5 }), 0);

    // 8×6 的小框上相邻锚点只隔 3.5px，22px 内圈会互相压到 —— 命中判定按「最近的那个锚点」
    // 分层（`ringHitAt()`），所以下面用一块大框（81×81）看两层圈的语义
    const big = screenFrameOf(affineFrom({ pivot: { x: 40, y: 40 }, angle: 0, sx: 1, sy: 1 }), 81, 81, 1, 0, 0);
    const bt = screenAnchors(big)[0];
    eq("xform.ring.inner-scale", (() => { const h = ringHitAt(big, { x: bt.x + 20, y: bt.y }, PC_HIT); return [h?.anchor, h?.kind, h?.ring]; })(),
      ["tl", "scale", "inner"]);
    eq("xform.ring.outer-rotate", (() => { const h = ringHitAt(big, { x: bt.x - 25, y: bt.y - 18 }, PC_HIT); return [h?.anchor, h?.kind, h?.ring]; })(),
      ["tl", "rotate", "outer"]);
    const btop = screenAnchors(big)[1];
    eq("xform.ring.outer-skew", (() => { const h = ringHitAt(big, { x: btop.x, y: btop.y - 30 }, PC_HIT); return [h?.anchor, h?.kind]; })(),
      ["t", "skew"]);
    // 再远就没有了（距离 > 34）
    eq("xform.ring.none", ringHitAt(big, { x: btop.x, y: btop.y - 40 }, PC_HIT), null);
    // 8 个锚点各自的正中心都判成「内圈缩放」（内圈优先，不会被外圈抢走）
    const anchorsS = screenAnchors(f);
    eq("xform.ring.centre-of-every-anchor", ANCHORS.map((_, i) => ringHitAt(f, anchorsS[i], PC_HIT)?.kind),
      ANCHORS.map(() => "scale"));
    // 内外圈半径是**屏幕常量**（与 zoom 无关）：放大 4× 后 34px 处仍然是内圈 / 外圈那两档
    const z4 = screenFrameOf(affineFrom({ pivot: { x: 50, y: 50 }, angle: 0, sx: 1, sy: 1 }), 101, 101, 4, 0, 0);
    const a4 = screenAnchors(z4)[0];
    eq("xform.ring.zoom-invariant-inner", ringHitAt(z4, { x: a4.x + 20, y: a4.y }, PC_HIT)?.ring, "inner");
    eq("xform.ring.zoom-invariant-outer", ringHitAt(z4, { x: a4.x - 25, y: a4.y - 18 }, PC_HIT)?.ring, "outer");
    eq("xform.ring.zoom-invariant-none", ringHitAt(z4, { x: a4.x - 40, y: a4.y - 40 }, PC_HIT), null);
  }

  // ---------------------------------------------------------------- 触屏抓手布局与互不重叠
  {
    // 大框（短边 200）：16 个抓手全摆开，任意两个圆心 ≥ 2× 命中半径 → 触摸区不重叠
    const f = screenFrameOf(affineFrom({ pivot: { x: 100, y: 100 }, angle: 0, sx: 1, sy: 1 }), 201, 201, 1, 0, 0);
    const layout = touchLayout(f.spanX, f.spanY);
    eq("xform.touch.layout-full", layout, { corners: true, edges: true, rotate: true, skew: true });
    const grabs = touchGrabs(f, layout);
    eq("xform.touch.grab-kinds", grabs.map((g) => g.kind),
      ["scale", "rotate", "scale", "skew", "scale", "rotate", "scale", "skew",
        "scale", "rotate", "scale", "skew", "scale", "rotate", "scale", "skew"]);
    let min = Infinity;
    for (let i = 0; i < grabs.length; i++) {
      for (let j = i + 1; j < grabs.length; j++) {
        min = Math.min(min, Math.hypot(grabs[i].x - grabs[j].x, grabs[i].y - grabs[j].y));
      }
    }
    ok("xform.touch.no-overlap", min >= touchHitRadius(grabs) * 2, "min=" + min.toFixed(1));
    // 尺寸扫描：每一档、任意大小都不许重叠（这是硬约束）
    let worst = Infinity;
    for (const s of [20, 40, 60, 79, 80, 100, 120, 159, 160, 200, 300, 400, 800]) {
      const sf = screenFrameOf(affineFrom({ pivot: { x: s / 2, y: s / 2 }, angle: 0, sx: 1, sy: 1 }), s + 1, s + 1, 1, 0, 0);
      const sl = touchLayout(sf.spanX, sf.spanY);
      const sg = touchGrabs(sf, sl);
      let m = Infinity;
      for (let i = 0; i < sg.length; i++) {
        for (let j = i + 1; j < sg.length; j++) m = Math.min(m, Math.hypot(sg[i].x - sg[j].x, sg[i].y - sg[j].y));
      }
      if (sg.length > 1) worst = Math.min(worst, m - touchHitRadius(sg) * 2);
    }
    ok("xform.touch.sweep-no-overlap", worst >= 0, "worst slack=" + worst.toFixed(2));
    ok("xform.touch.radius-floor", touchHitRadius([]) === TOUCH_HIT.inner && TOUCH_HIT_FLOOR < TOUCH_HIT.inner);
    // 每个抓手都真的能命中（而且命中的就是它自己）
    let ok2 = 0;
    for (const g of grabs) {
      const hit = grabAt(grabs, { x: g.x, y: g.y }, TOUCH_HIT.inner);
      if (hit && hit.kind === g.kind && hit.anchor === g.anchor) ok2++;
    }
    eq("xform.touch.each-hittable", ok2, grabs.length);
    // 旋转抓手在角外侧（离框中心更远），缩放抓手压在锚点上
    const rot = grabs.find((g) => g.kind === "rotate")!;
    const corner = grabs.find((g) => g.kind === "scale")!;
    ok("xform.touch.rotate-outside", rot.x < corner.x && rot.y < corner.y, JSON.stringify([rot, corner]));
    // 旋转抓手在角缩放的更外侧，两者都沿同一条角平分线 → 圆心距 =（两档外移距离之差）× √2
    ok("xform.touch.grab-offset",
      near(Math.hypot(rot.x - corner.x, rot.y - corner.y),
        touchOuterOffset(Math.min(f.spanX, f.spanY)) - TOUCH_OFF_CORNER, 1e-9),
      String(Math.hypot(rot.x - corner.x, rot.y - corner.y)));
    // 中等选区（短边 100）：角缩放 + 角旋转（丢掉边中点与斜切），仍然不重叠
    const small = screenFrameOf(affineFrom({ pivot: { x: 50, y: 50 }, angle: 0, sx: 1, sy: 1 }), 101, 101, 1, 0, 0);
    const sl = touchLayout(small.spanX, small.spanY);
    eq("xform.touch.layout-small", sl, { corners: true, edges: false, rotate: true, skew: false });
    const sg = touchGrabs(small, sl);
    eq("xform.touch.small-count", sg.length, 8);
    let minS = Infinity;
    for (let i = 0; i < sg.length; i++) {
      for (let j = i + 1; j < sg.length; j++) {
        minS = Math.min(minS, Math.hypot(sg[i].x - sg[j].x, sg[i].y - sg[j].y));
      }
    }
    ok("xform.touch.small-no-overlap", minS >= touchHitRadius(sg) * 2, "min=" + minS.toFixed(1));
    // 极小选区：只剩 4 个角缩放抓手
    const tiny = screenFrameOf(affineFrom({ pivot: { x: 20, y: 20 }, angle: 0, sx: 1, sy: 1 }), 41, 41, 1, 0, 0);
    eq("xform.touch.layout-tiny", touchLayout(tiny.spanX, tiny.spanY), { corners: true, edges: false, rotate: false, skew: false });
    eq("xform.touch.tiny-count", touchGrabs(tiny, touchLayout(tiny.spanX, tiny.spanY)).length, 4);
    // 阈值与常量本身
    ok("xform.touch.threshold",
      TOUCH_MID_SPAN === 80 && TOUCH_FULL_SPAN === 160 && TOUCH_MIN_SPAN === 60
      && TOUCH_OFF_CORNER + TOUCH_OFF_EDGE === 92 && TOUCH_OFF_OUTER === 144);
    ok("xform.touch.outer-grows", touchOuterOffset(160) === TOUCH_OFF_OUTER && touchOuterOffset(400) > TOUCH_OFF_OUTER);
    ok("xform.touch.pc-radii-constant", PC_HIT.inner === 22 && PC_HIT.outer === 34);
  }

  // ---------------------------------------------------------------- 像素精确搬运
  {
    const w = 4, h = 3;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { data[i * 4] = i + 1; data[i * 4 + 3] = 255; }
    const src = { w, h, data };
    // 0°：逐字节照搬
    const same = exactMove(src, 0);
    eq("xform.exact.size", [same.w, same.h], [4, 3]);
    let diff = 0;
    for (let i = 0; i < same.dst.length; i++) if (same.dst[i] !== data[i]) diff++;
    eq("xform.exact.identity", diff, 0);
    // 90°：宽高互换、像素 (x,y) → (h-1-y, x)
    const r90 = exactMove(src, 1);
    eq("xform.exact.rot90-size", [r90.w, r90.h], [3, 4]);
    const px = (d: Uint8ClampedArray, ww: number, x: number, y: number): number[] => {
      const p = (y * ww + x) * 4;
      return [d[p], d[p + 1], d[p + 2], d[p + 3]];
    };
    eq("xform.exact.rot90-corner", px(r90.dst, 3, 0, 0), px(data, 4, 0, 2));
    eq("xform.exact.rot90-maps", px(r90.dst, 3, 2, 3), px(data, 4, 3, 0));
    // 180°：中心对称
    const r180 = exactMove(src, 2);
    eq("xform.exact.rot180", px(r180.dst, 4, 3, 2), px(data, 4, 0, 0));
    // 270°
    const r270 = exactMove(src, 3);
    eq("xform.exact.rot270-size", [r270.w, r270.h], [3, 4]);
    eq("xform.exact.rot270-maps", px(r270.dst, 3, 0, 0), px(data, 4, 3, 0));
    // 四圈回到自己（尺寸与像素都回来）
    const back = exactMove(exactMove(exactMove(exactMove(src, 1), 1), 1), 1);
    eq("xform.exact.four-turns", [back.w, back.h], [4, 3]);
    let d2 = 0;
    for (let i = 0; i < back.dst.length; i++) if (back.dst[i] !== data[i]) d2++;
    eq("xform.exact.four-turns-pixels", d2, 0);
    // horizontal flip 与 180° 不是一回事
    const fx = exactMove(src, 0, true, false);
    eq("xform.exact.flip-x", px(fx.dst, 4, 3, 0), px(data, 4, 0, 0));
    eq("xform.exact.rotated-size-helper", [rotatedSize(4, 3, 1), rotatedSize(4, 3, 2)], [{ w: 3, h: 4 }, { w: 4, h: 3 }]);
    // 哪些参数走精确通道
    const base = { pivot: { x: 0, y: 0 }, angle: 0, sx: 1, sy: 1 };
    ok("xform.exact.is-exact-move", isExactTransform(base));
    ok("xform.exact.is-exact-rot90", isExactTransform({ ...base, angle: Math.PI / 2 }));
    ok("xform.exact.is-exact-mirror", isExactTransform({ ...base, sx: -1 }));
    ok("xform.exact.not-skew", !isExactTransform({ ...base, skewX: 0.2 }));
    ok("xform.exact.not-scale", !isExactTransform({ ...base, sx: 1.5 }));
    ok("xform.exact.not-clean-angle", !isExactTransform({ ...base, angle: (26.565 * Math.PI) / 180 }));
  }

  // ---------------------------------------------------------------- 框内拖动量的投影
  {
    // 框转了 90°：屏幕上的「向右」在框内是「向上」（-y）
    const l = toFrameLocal(10, 0, Math.PI / 2);
    ok("xform.local.rot90", nearPt(l, { x: 0, y: -10 }, 1e-9), JSON.stringify(l));
    const l2 = toFrameLocal(0, 10, Math.PI / 2);
    ok("xform.local.rot90-y", nearPt(l2, { x: 10, y: 0 }, 1e-9), JSON.stringify(l2));
  }
}
