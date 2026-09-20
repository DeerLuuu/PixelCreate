// 样式归属契约（P2「样式进库」+ P6「应用消费库」）：
//   · 库是设计令牌与 kit 控件规则的**唯一来源**，应用只剩业务规则；
//   · 「库段 ∪ 应用段」的规则多重集合必须等于**拆分前那份**的指纹（视觉零变化的机器判据）；
//   · 产物 `app2/www/css/style.css` 里**库段在应用段之前**，且产物规则 == 两段之并（不许有第三种来源）。
//
// 口径、指纹常量的来历与「怎么重新对账」见 tests/css-rules.ts 的文件头。
import { eq, ok } from "./common";
import {
  APP_TOP_BLOCKS,
  APP_CSS_PATH,
  ARTIFACT_CSS_PATH,
  LIB_TOP_BLOCKS,
  PRE_SPLIT_FLAT_RULES,
  PRE_SPLIT_RULES_SHA256,
  PRE_SPLIT_TOP_BLOCKS,
  bagDiff,
  bagHash,
  flatRules,
  lf,
  libCssPath,
  normSel,
  readAppCss,
  readArtifactCss,
  readLibCss,
  rulesBag,
  tally,
  topBlocks,
} from "./css-rules";

declare const require: (m: string) => any;
const fs = require("fs");

/** 已经搬进库的控件选择器（抽查，不是全量）：应用侧一个都不许再定义 */
const MOVED_SELECTORS = [
  ":root", '[data-theme="light"]', "*", "svg", "button", "input,select", "input,textarea",
  "canvas,svg,img,button", ".btn", ".btn.small", ".grow", ".panel", ".panel.panel-full",
  ".panel-mask", ".panel-mask,.dlg-mask", ".row-actions", ".rowlabel", ".calcpad", ".cp-key",
  ".dlg", ".dlg-head", ".dlg-body", ".dlg-foot", ".tabs", ".tab", ".chips", ".chip", ".sw",
  ".sw i", ".tip-host", ".htip", "@keyframes tiph", "@keyframes pcFadeIn", "@keyframes pcDlgIn",
];

export function testUiCss(): void {
  const libText = readLibCss();
  const appText = readAppCss();
  const libBlocks = topBlocks(libText);
  const appBlocks = topBlocks(appText);
  const libTally = tally(libBlocks);
  const appTally = tally(appBlocks);

  // ------------------------------------------------- ① 两段各自的账（顶层块）
  ok("uicss.lib.exists", libText.length > 10000 && libText.indexOf(":root{") >= 0,
    libCssPath() + "（" + libText.length + " 字节）");
  eq("uicss.lib.blocks", [libTally.rules, libTally.keyframes, libTally.atBlocks],
    [LIB_TOP_BLOCKS.rules, LIB_TOP_BLOCKS.keyframes, 0]);
  eq("uicss.app.blocks", [appTally.rules, appTally.keyframes, appTally.atBlocks],
    [APP_TOP_BLOCKS.rules, APP_TOP_BLOCKS.keyframes, APP_TOP_BLOCKS.atBlocks]);
  eq("uicss.blocks.total", libBlocks.length + appBlocks.length,
    PRE_SPLIT_TOP_BLOCKS.rules + PRE_SPLIT_TOP_BLOCKS.keyframes + PRE_SPLIT_TOP_BLOCKS.atBlocks);

  // ------------------------------------------------- ② 唯一来源：应用侧不再有令牌与 kit 规则
  // 令牌块（`:root` / `[data-theme="light"]`）留在应用里就会**盖住库那份**，
  // 症状是「改了库的令牌，页面不变」—— 所以这条按整块判，不是「有没有 --bg 这个词」。
  ok("uicss.app.no-tokens",
    appText.indexOf(":root{") < 0 && appText.indexOf('[data-theme="light"]{') < 0);
  // 选择器**精确集合**相交必须为空：`.btn` 与 `html[data-pc] .btn` 是两个选择器，
  // 后者是宿主的 PC 密度覆写（R4，留在应用），前者不许再出现在应用里。
  const libSels = new Set(flatRules(libText).map((r) => r.sel));
  const dupes = [...new Set(flatRules(appText).map((r) => r.sel))].filter((s) => libSels.has(s));
  eq("uicss.app.no-duplicate-selectors", dupes, []);
  const appSelSet = new Set(appBlocks.map((b) => normSel(b.sel)));
  const stillApp = MOVED_SELECTORS.filter((s) => appSelSet.has(s));
  eq("uicss.moved.selectors-gone", stillApp, []);

  // ------------------------------------------------- ③ 视觉零变化：库 ∪ 应用 == 拆分前
  const union = rulesBag(libText);
  for (const [k, n] of rulesBag(appText)) union.set(k, (union.get(k) || 0) + n);
  const unionCount = [...union.values()].reduce((a, b) => a + b, 0);
  eq("uicss.rules.count", unionCount, PRE_SPLIT_FLAT_RULES);
  eq("uicss.rules.flat-total", flatRules(libText).length + flatRules(appText).length, PRE_SPLIT_FLAT_RULES);
  ok("uicss.rules-hash", bagHash(union) === PRE_SPLIT_RULES_SHA256,
    "实测 " + bagHash(union) + "（若这是**有意**改样式，请把 css-rules.ts 的 PRE_SPLIT_RULES_SHA256 更新成它并说明理由）");

  // ------------------------------------------------- ④ 产物：库段在应用段之前
  // 判据不靠固定注释锚点，靠**内容本身**：两段原文都要在产物里逐字出现，且库段的偏移更小。
  // 产物是构建出来的（`scripts/build-css.mjs`，gitignore），纯源码检出里可能没有它 ——
  // 那种情况下记录一条 skipped（与本仓库 export/icons 测试同一约定），不假装验过。
  const art = readArtifactCss();
  if (art === null) {
    ok("uicss.artifact.order-skipped", true, "没有产物（先跑 `node scripts/build-css.mjs`）：" + ARTIFACT_CSS_PATH);
    ok("uicss.artifact.rules-skipped", true, "同上");
  } else {
    const libAt = art.indexOf(lf(libText).trim());
    const appAt = art.indexOf(lf(appText).trim());
    ok("uicss.artifact.order", libAt >= 0 && appAt > libAt,
      "库段@" + libAt + " 应用段@" + appAt + "（" + ARTIFACT_CSS_PATH + "，" + art.length + " 字节）");
    ok("uicss.artifact.complete", art.indexOf(":root{") >= 0 && art.indexOf(".app-root{") > art.indexOf(":root{"),
      "库段与应用段都必须在产物里");
    // 产物只许是这两段的拼接（第三条来源 / 手工改动产物都会在这里露出来）
    eq("uicss.artifact.rules-match-sources", bagDiff(union, rulesBag(art)), []);
  }
  ok("uicss.app.source-only", fs.existsSync(APP_CSS_PATH));
}
