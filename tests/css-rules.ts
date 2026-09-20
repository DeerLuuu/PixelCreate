// 样式来源与解析口径（P2「样式进库」之后的唯一判据面）。
//
// 为什么单独一个文件：拆样式之后「样式」有两个来源，三处断言（ui-tokens / ui-fork / ui-css）
// 都要按同一套口径读它们，口径分叉就会让「谁能改样式」变得说不清：
//   · 库段  = 装进来的 `deer-ui/styles.css`（**通过 exports 解析**，不是路径硬编码 ——
//             装的是旧 tarball（没有 styles.css）时会在这里大声失败，而不是静默跳过）
//   · 应用段 = `src/ui/style.css`（只剩业务规则）
//   · 产物  = `app2/www/css/style.css`（`scripts/build-css.mjs` 拼出来的：库段在前、应用段在后）
//
// 解析口径：**按「选择器 + 声明」的扁平规则多重集合**比，不按子串出现次数比。
// 库 CSS 里 `.btn.off` / `.dlg` / `.panel` / `.rowlabel` / `.panel-mask,.dlg-mask` 都是
// 「基础规则 + 变体/动画」的合法重复，数 `:root{` / `.dlg{` 这类子串会数错。
//
// `PRE_SPLIT_*` 是**拆分前那份 `src/ui/style.css` 的指纹**（本轮由
// `git show HEAD:src/ui/style.css` 取到，一次性的对账脚本见本轮报告）：
// 库段 ∪ 应用段 的规则多重集合必须**逐条等于**它 —— 允许改顺序，不得改/丢/增声明，
// 这就是「视觉零变化」的机器判据。**故意改样式时会红**：这时要连着更新这里的常量
// （`uicss.rules-hash` 的失败信息里会打印实测值，直接抄过去），并说明为什么改。
declare const require: any;
declare const __dirname: string;
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/** 库样式表的导出说明符（exports map 里的键，见 docs/UI.md §1.3） */
export const LIB_CSS_SPEC = "deer-ui/styles.css";

export const REPO_ROOT = path.resolve(__dirname, "../../..");
export const APP_CSS_PATH = path.join(REPO_ROOT, "src/ui/style.css");
export const ARTIFACT_CSS_PATH = path.join(REPO_ROOT, "app2/www/css/style.css");

/** 拆分前 `src/ui/style.css` 的账（t2 的对账结论，本轮逐条复核过） */
export const PRE_SPLIT_TOP_BLOCKS = { rules: 831, keyframes: 34, atBlocks: 11 };
export const PRE_SPLIT_FLAT_RULES = 905;
/** 库段 ∪ 应用段的扁平规则多重集合 sha256（= 拆分前那份） */
export const PRE_SPLIT_RULES_SHA256 =
  "98e94d6cbe53528117dc91461eee906eae3ddda436bd80359a18de51fdd724f7";
/** 现在的两段各有多少顶层块（进库 92 = 85 + 7；留应用 784 = 746 + 27 + 11） */
export const LIB_TOP_BLOCKS = { rules: 85, keyframes: 7 };
export const APP_TOP_BLOCKS = { rules: 746, keyframes: 27, atBlocks: 11 };

/** 行尾归一（库仓库一律 LF，应用工作区在 Windows 上是 CRLF） */
export const lf = (s: string): string => s.replace(/\r\n?/g, "\n");

/** 选择器归一：剥注释 + 压空白 —— 缩进/换行差异不算「改了声明」 */
export const normSel = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\s+/g, " ").trim();

/** 库样式表的真实路径（走 exports map；解析不到就抛，别静默跳过） */
export function libCssPath(): string {
  try {
    return require.resolve(LIB_CSS_SPEC);
  } catch (e) {
    throw new Error(
      "解析不到 " + LIB_CSS_SPEC +
      " —— 安装树里的 deer-ui 太旧（P2 之前打的 tarball 没有 styles.css）。" +
      " 修法：库仓库 `npm run pack:vendor` → 拷 tarball 到 vendor/ → `npm install --legacy-peer-deps`。原因：" +
      (e && (e as Error).message ? (e as Error).message : String(e)),
    );
  }
}
export const readLibCss = (): string => lf(fs.readFileSync(libCssPath(), "utf8"));
export const readAppCss = (): string => lf(fs.readFileSync(APP_CSS_PATH, "utf8"));
export const readArtifactCss = (): string | null =>
  fs.existsSync(ARTIFACT_CSS_PATH) ? lf(fs.readFileSync(ARTIFACT_CSS_PATH, "utf8")) : null;

export interface CssBlock { sel: string; body: string; raw: string }

/**
 * 顶层块（注释 / 字符串感知的括号配对）。
 * 注意：块前的注释也算进 `sel`（`normSel` 会剥掉它），所以按 `normSel(sel)` 匹配时
 * 「注释 + 规则」整体是一块 —— 删的时候会连注释一起删，这正是想要的行为。
 */
export function topBlocks(text: string): CssBlock[] {
  const out: CssBlock[] = [];
  const n = text.length;
  const skipStr = (k: number, q: string): number => {
    k++;
    while (k < n && text[k] !== q) { if (text[k] === "\\") k++; k++; }
    return k + 1;
  };
  let i = 0;
  while (i < n) {
    let j = i;
    while (j < n) {
      if (text[j] === "/" && text[j + 1] === "*") { const e = text.indexOf("*/", j + 2); j = e < 0 ? n : e + 2; continue; }
      if (text[j] === "{") break;
      j++;
    }
    if (j >= n) break;
    let depth = 1;
    let k = j + 1;
    while (k < n && depth > 0) {
      const c = text[k];
      if (c === "/" && text[k + 1] === "*") { const e = text.indexOf("*/", k + 2); k = e < 0 ? n : e + 2; continue; }
      if (c === '"' || c === "'") { k = skipStr(k, c); continue; }
      if (c === "{") depth++;
      else if (c === "}") depth--;
      k++;
    }
    out.push({ sel: text.slice(i, j), body: text.slice(j + 1, k - 1), raw: text.slice(i, k) });
    i = k;
  }
  return out;
}

export const kindOf = (sel: string): "rule" | "keyframes" | "atBlock" => {
  const s = normSel(sel);
  if (s.indexOf("@keyframes") === 0) return "keyframes";
  if (s.indexOf("@") === 0) return "atBlock";
  return "rule";
};

export const tally = (blocks: CssBlock[]): { rules: number; keyframes: number; atBlocks: number } => {
  const t = { rules: 0, keyframes: 0, atBlocks: 0 };
  for (const b of blocks) {
    const k = kindOf(b.sel);
    if (k === "rule") t.rules++;
    else if (k === "keyframes") t.keyframes++;
    else t.atBlocks++;
  }
  return t;
};

/**
 * 扁平规则表：`@media` 递归进去、`@keyframes` **整块原子**
 * （里面的 `from` / `to` 是关键帧选择器，不是 CSS 规则，拆开会让「库/应用选择器交集」误报）。
 */
export function flatRules(text: string): Array<{ sel: string; decls: string }> {
  const out: Array<{ sel: string; decls: string }> = [];
  const walk = (t: string): void => {
    for (const b of topBlocks(t)) {
      if (b.body.indexOf("{") >= 0 && kindOf(b.sel) !== "keyframes") walk(b.body);
      else out.push({ sel: normSel(b.sel), decls: lf(b.body) });
    }
  };
  walk(text);
  return out;
}

/** 规则多重集合：键 = `选择器 ||| 声明`，值 = 条数 */
export function rulesBag(text: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of flatRules(text)) {
    const k = r.sel + " ||| " + r.decls;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}

/** 多重集合指纹：与顺序无关（排序后 sha256），比「条数相等」强得多 */
export function bagHash(m: Map<string, number>): string {
  const lines = [...m.entries()].map(([k, n]) => n + "×" + k).sort();
  return crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** 两个多重集合的差异（双向），空数组 = 逐条相等 */
export function bagDiff(a: Map<string, number>, b: Map<string, number>): string[] {
  const out: string[] = [];
  for (const [k, n] of a) {
    const m = b.get(k) || 0;
    if (m !== n) out.push((m > n ? "b 多 " : "b 少 ") + Math.abs(m - n) + " 条：" + k.slice(0, 120));
  }
  for (const [k, n] of b) if (!a.has(k)) out.push("b 新增 " + n + " 条：" + k.slice(0, 120));
  return out;
}
