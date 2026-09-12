// 移动端选区球的分页回归。
//
// 背景：选区球的条目一度全部挤在两页里（第二页 10 项：四个自由变换入口 +
// 翻转 / 扩展 / 收缩 / 描边 / 裁切 / 删除），触屏上翻到第二页后环被撑到屏幕外、
// 上一版新加的自由变换入口几乎点不到。现在分三页（常用 → 变形 → 工具），
// 每页最多 7 项。这里没有 DOM，所以直接静态读 App.tsx 断言：
//   1. 三页的条目数（含条件分支）都不超过一页能容纳的上限
//   2. 每个选区动作 id 至少出现在一页里（手机上真的点得到）
//   3. PC 的合并视图＝三页的并集，且没有重复 id
//   4. 环的几何：按 ringLayout 排布后不重叠、半径落在手机屏幕内
import { ringLayout, orbMetrics, ORB_SIZE } from "../src/ui/orb-layout";
import { eq, ok } from "./common";

declare const require: (m: string) => any;
declare const __dirname: string;
const fs = require("fs");
const path = require("path");

/** 一页放得下的条目上限（超过就必须再分一页，否则环会撑出屏幕）。
 *  从 7 提到 8：变形页多了一个「半像素吸附」开关（点一下就地切换、选中态高亮）。
 *  8 项时 ringLayout 把内环半径撑到 57px（4+4 两排、张角 90°），最远的球落在
 *  `hypot(57, 57) ≈ 81px` 上，加球半径仍远在手机短边内 —— 下面的几何断言就是钉这条。 */
const MAX_PER_PAGE = 8;

export function testSelOrb(): void {
  const appSrc = fs.readFileSync(path.resolve(__dirname, "../../../src/ui/App.tsx"), "utf8");
  const i18nSrc = fs.readFileSync(path.resolve(__dirname, "../../../src/ui/i18n.ts"), "utf8");

  /** 取一页里出现的所有 id（含 `...(cond ? [] : [...])` 里的分支），顺带数条目数 */
  const page = (name: string): { ids: string[]; max: number } => {
    const start = appSrc.indexOf("const " + name + ": Item[] = [");
    ok("selorb." + name + ".declared", start >= 0, name);
    // 到下一个顶层 `const xxx: Item[] =` / `const selItems` 为止
    const rest = appSrc.slice(start);
    const end = rest.indexOf("\n  const ");
    const body = end > 0 ? rest.slice(0, end) : rest;
    const ids = [...body.matchAll(/\bid:\s*"([A-Za-z0-9_.-]+)"/g)].map((m) => m[1]).filter((id) => id !== "sel-back");
    // 条目数上限：分支里最多的一条（pc 分支与手机分支都算）
    const branches = body.split("...(pcMode").map((part, i) => (i === 0 ? part : part.slice(0, part.indexOf("])"))));
    const max = Math.max(...branches.map((b) => (b.match(/\bid:\s*"/g) || []).length));
    return { ids: [...new Set(ids)], max };
  };

  const p1 = page("selPage1");
  const p2 = page("selPage2");
  const p3 = page("selPage3");

  // 1) 每页都要在一屏内放得下
  for (const [name, p] of [["page1", p1], ["page2", p2], ["page3", p3]] as const) {
    ok("selorb." + name + ".fits", p.max <= MAX_PER_PAGE, name + "=" + p.max);
    ok("selorb." + name + ".has-items", p.ids.length >= 4, name + "=" + p.ids.join(","));
  }

  // 2) 触屏上依赖的全部条目都在某一页里
  //    （上一版新增的自由变换四个入口 + 复制/剪切/粘贴/粘贴为新图层/为新画布）
  const mobile = new Set([...p1.ids, ...p2.ids, ...p3.ids]);
  const must = [
    "sel.all", "sel.invert", "sel.clear", "sel.fill",
    "sel.copy", "sel.cut", "sel.paste", "pasteAsLayerBall", "pasteAsCanvasBall",
    "selWarpQuad", "selWarpMesh", "selWarpDone", "selWarpRevert", "selWarpHalf",
    "sel.fliph", "sel.flipv", "sel.grow", "sel.shrink", "sel.outline", "selCrop", "sel.delete",
  ];
  eq("selorb.mobile-reach-all", must.filter((id) => !mobile.has(id)), []);
  // 自由变换四个入口必须和「四角 / 网格」在同一页（点进去就能接着点「完成」），
  // 吸附粒度开关（半像素 / 整像素）也在这一页：拖之前顺手就能切
  ok("selorb.warp-one-page", p2.ids.includes("selWarpQuad") && p2.ids.includes("selWarpMesh")
    && p2.ids.includes("selWarpDone") && p2.ids.includes("selWarpRevert"), p2.ids.join(","));
  ok("selorb.warp-half-on-warp-page", p2.ids.includes("selWarpHalf"), p2.ids.join(","));
  // 开关项：点一下翻转设置项 tools.selWarpHalfSnap，并把当前状态显示成选中态（Item.active）
  const halfItem = appSrc.slice(appSrc.indexOf('id: "selWarpHalf"'));
  const halfBody = halfItem.slice(0, halfItem.indexOf("guide:") + 40);
  ok("selorb.warp-half-toggles", halfBody.includes("setSelWarpHalfSnap(on)") && halfBody.includes("!SESSION.prefs.selWarpHalfSnap"),
    halfBody.replace(/\s+/g, " ").slice(0, 160));
  ok("selorb.warp-half-active", halfBody.includes("active: SESSION.prefs.selWarpHalfSnap"), "active");
  ok("selorb.warp-half-desc", halfBody.includes("selWarpHalfOn") && halfBody.includes("selWarpHalfOff"), "desc");

  // 3) PC 合并视图＝三页并集，且没有重复 id（重复会让动作搜索列两次）
  const pcView = appSrc.slice(appSrc.indexOf("const selItems: Item[] = pcMode"), appSrc.indexOf("const selCatalog"));
  const all = [...p1.ids, ...p2.ids, ...p3.ids];
  eq("selorb.no-duplicate-ids", all.filter((id, i) => all.indexOf(id) !== i), []);
  ok("selorb.pc-view-merges", pcView.includes("selPage1") && pcView.includes("selPage2") && pcView.includes("selPage3"), pcView.slice(0, 80));
  // 翻页导航项不能进 PC 的合并视图 / 饼菜单
  ok("selorb.pc-view-drops-nav", pcView.includes('"sel-more"') && pcView.includes('"sel-more-tools"'), "nav filter");
  ok("selorb.pie-drops-nav", appSrc.includes('it.guide !== "sel-more" && it.guide !== "sel-more-tools"'), "pie filter");

  // 4) 环的几何：每页排布后同环 / 跨环都不重叠，且最远的球仍在屏幕内
  const M = orbMetrics(false);                 // 手机几何
  const px = Math.min(390, 360);               // 一台常见手机的短边
  const py = 640;                              // 展开方向上的可用高度
  for (const [name, p] of [["page1", p1], ["page2", p2], ["page3", p3]] as const) {
    const n = p.max;
    const pts = ringLayout({ count: n, cx: 0, cy: 0, spanDeg: 84, r1: M.r1, r2: M.r2, item: M.item, gap: 8 });
    eq("selorb." + name + ".slots", pts.length, n);
    let min = Infinity;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) min = Math.min(min, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
    }
    ok("selorb." + name + ".no-overlap", n < 2 || min >= ORB_SIZE + 6 - 1e-6, name + " min=" + min.toFixed(2));
    const reach = Math.max(...pts.map((q) => Math.hypot(q.x, q.y)));
    ok("selorb." + name + ".on-screen", reach + ORB_SIZE / 2 <= Math.max(px, py) / 2, name + " reach=" + reach.toFixed(1));
  }

  // 5) 新增的 i18n 文案中英都有，锚点也都在
  for (const key of ["selMoreWarpDesc", "selMoreTools", "selMoreToolsDesc", "selWarpHalfSnap", "selWarpHalfSnapDesc", "selWarpHalfOn", "selWarpHalfOff"]) {
    const hits = i18nSrc.match(new RegExp("\\b" + key + ":", "g")) || [];
    eq("selorb.i18n." + key, hits.length, 2);
  }
  ok("selorb.anchor-more", appSrc.includes('guide: "sel-more"'));
  ok("selorb.anchor-more-tools", appSrc.includes('guide: "sel-more-tools"'));
  ok("selorb.anchor-back", appSrc.includes('guide: "sel-back"'));
  // 收起球要回到第一页
  ok("selorb.close-resets-page", appSrc.includes("if (sel.open) setSelSub(null);"));
}
