// 防分叉 / 单实例 / 供应的机器判据（docs/PLAN-deer-ui.md §6.4 的符号白名单 + R7 + R10 + 附 A）。
//
// 这一组盯的是「库化之后最容易静默失效的四件事」，每条都按**符号白名单精确匹配**，
// 不是「扫 src/ui 找组件定义」（那样 modals.tsx 的 21 个弹窗第一天就红）：
//   ① 被搬走的 9 个文件只剩薄再导出层，且指向库的公开入口（没有第二份实现）；
//   ② 应用 src/** 里不得再出现库公开面上的同名**实现**（适配层走显式白名单，且白名单自身要证明是转发）；
//   ③ React / react-dom 只有一份（从库的安装位置解析出来的与从应用根解析的是同一个文件）；
//   ④ vendor 里那份 tarball 与库侧 npm pack 的产物同一个 md5（供应链：不许有人偷偷换包）。
declare const require: any;
declare const __dirname: string;
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
import { eq, ok } from "./common";

const REPO = path.resolve(__dirname, "../../..");
const PKG = path.join(REPO, "node_modules/deer-ui");
const DIST = path.join(PKG, "dist");
const VENDOR = path.join(REPO, "vendor/deerui-0.1.0.tgz");
// 库侧 `npm pack` 的产物指纹（t8 对齐到库 HEAD `9fa9de3`：README 独立化 + `.gitattributes` 全 LF 闸门之后重打）。
// **版本号没变，指纹就是唯一能区分两份 0.1.0 的东西** —— 换包必须同时改这三行，改不动
// 就说明有人在偷换（或者忘了把库的新 tarball 拷进 vendor/）。
// 现在这份**与检出平台无关**：库仓库加了 `.gitattributes`（`* text=auto eol=lf`）+ `pack-vendor.mjs` 的
// 「进包文件全 LF」闸门之后，库工作树打的那份与 `git clone` 里打的那份**逐字节相同**（40278 B，两端各打一次实测）。
const VENDOR_MD5 = "0102c0631caacf357751e31e807cecc3";
const VENDOR_BYTES = 40278;
const VENDOR_SHA256 = "0e2e8ee130ffaeb88ba547082bf285ef16f1b6770f4aa7027b6f3f0e3199d444";

/** 库公开面上的值（kit barrel 25 + tabs 2 + tooltip 3）。 */
const KIT_VALUES = [
  "Icon", "Btn", "TipHost", "Overlay", "Keep", "useBlankTap", "useLandscape",
  "ScrubNum", "Dialog",
  "HoverTip", "hoverTipPos", "useHoverTip", "setHoverTipsEnabled", "useHoverTipsEnabled", "hoverTipsEnabled",
  "setKitPcMode", "kitPcOn", "useKitPcMode",
  "Row", "RowActions", "ChipGroup", "Segmented", "Switch", "NumberField", "ColorField",
];
const KIT_TYPES = ["ScrubNumProps", "HoverTipProps", "HoverTipApi", "DialogProps", "RowProps", "ChipOption"];
const TAB_VALUES = ["TabBar", "DropMenu"];
const TOOLTIP_VALUES = ["showTip", "hideTip", "subscribeTip"];

/** 应用侧被搬走的 9 个公开路径 —— 只许剩薄再导出，且必须指向库的对应入口。 */
const THIN: Array<[string, string]> = [
  ["src/ui/kit/index.ts", "deer-ui/kit"],
  ["src/ui/kit/primitives.tsx", "deer-ui/kit"],
  ["src/ui/kit/scrub.tsx", "deer-ui/kit"],
  ["src/ui/kit/Dialog.tsx", "deer-ui/kit"],
  ["src/ui/kit/Form.tsx", "deer-ui/kit"],
  ["src/ui/kit/HoverTip.tsx", "deer-ui/kit"],
  ["src/ui/kit/pcmode.ts", "deer-ui/kit"],
  ["src/ui/tooltip.ts", "deer-ui/tooltip"],
  ["src/ui/tabs.tsx", "deer-ui/tabs"],
];

/** 显式白名单：`src/ui/base.tsx` 的 ScrubNum 是**注入适配层**（只补一句翻译过的 pad 文案，
 *  转发给库组件），不是实现 —— 白名单的合法性由 `uifork.adapter.*` 那条自己证明。 */
const ADAPTERS: Array<[string, string]> = [["src/ui/base.tsx", "ScrubNum"]];

const read = (p: string): string => fs.readFileSync(p, "utf8");
const md5 = (p: string): string => crypto.createHash("md5").update(fs.readFileSync(p)).digest("hex");
const sha256 = (p: string): string => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

export function testUiFork(): void {
  // ---------------------------------------------------- vendor 与安装形态
  ok("uifork.vendor.exists", fs.existsSync(VENDOR), VENDOR);
  if (fs.existsSync(VENDOR)) {
    eq("uifork.vendor.bytes", fs.statSync(VENDOR).size, VENDOR_BYTES);
    eq("uifork.vendor.md5", md5(VENDOR), VENDOR_MD5);
    eq("uifork.vendor.sha256", sha256(VENDOR), VENDOR_SHA256);
  } else {
    eq("uifork.vendor.bytes", "missing", VENDOR_BYTES);
    eq("uifork.vendor.md5", "missing", VENDOR_MD5);
    eq("uifork.vendor.sha256", "missing", VENDOR_SHA256);
  }
  // file: 装出来的必须是**真目录**：junction / symlink 下 React 会解析到库自己的 node_modules，
  // 那就是两个 React 实例（方案 §4.6 的路线 A/B 失败、路线 D 成立，就是这条）。
  const st = fs.lstatSync(PKG);
  ok("uifork.install.real-dir", st.isDirectory() && !st.isSymbolicLink(), "isDir=" + st.isDirectory() + " link=" + st.isSymbolicLink());
  eq("uifork.install.path-stable", fs.realpathSync(PKG), PKG);
  ok("uifork.install.entries", ["kit/index.js", "tabs.js", "tooltip.js"].every((f) => fs.existsSync(path.join(DIST, f))));

  // ------------------------------------------------- 9 个公开路径只剩薄再导出
  for (const [rel, spec] of THIN) {
    const p = path.join(REPO, rel);
    let verdict = "missing";
    if (fs.existsSync(p)) {
      const lines = read(p)
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && l.indexOf("//") !== 0);
      const onlyReexport = lines.length === 1 && lines[0] === 'export * from "' + spec + '";';
      verdict = onlyReexport ? "ok" : "not-thin: " + JSON.stringify(lines);
    }
    eq("uifork.thin." + rel.replace(/^src\/ui\//, ""), verdict, "ok");
  }

  // 白名单那条适配层必须真的是转发（引用库组件 + 展开它），否则白名单就成了后门
  {
    const base = read(path.join(REPO, "src/ui/base.tsx"));
    ok("uifork.adapter.base-scrubnum",
      base.indexOf("ScrubNum as ScrubNumBase") >= 0 && base.indexOf("<ScrubNumBase") >= 0,
      "base.tsx 的 ScrubNum 必须是转发，不是实现");
  }

  // ------------------------------- 应用 src/** 不得再出现库公开面上的同名实现
  const appFiles: string[] = [];
  {
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name)) appFiles.push(path.relative(REPO, p).replace(/\\/g, "/"));
      }
    };
    walk(path.join(REPO, "src"));
  }
  const thinSet = new Set(THIN.map((t) => t[0]));
  const adapterSet = new Set(ADAPTERS.map((a) => a[0] + "|" + a[1]));
  const defined = (sym: string): string[] => {
    const re = new RegExp(
      "^(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?(?:function|const|let|var|class|interface|type|enum)\\s+" + sym + "\\b",
      "m",
    );
    return appFiles.filter((f) => !thinSet.has(f) && !adapterSet.has(f + "|" + sym) && re.test(read(path.join(REPO, f))));
  };
  const fork = (syms: string[]): string[] => {
    const out: string[] = [];
    for (const s of syms) for (const f of defined(s)) out.push(s + " @ " + f);
    return out;
  };
  eq("uifork.no-fork.kit", fork(KIT_VALUES.concat(KIT_TYPES)), []);
  eq("uifork.no-fork.tabs", fork(TAB_VALUES), []);
  eq("uifork.no-fork.tooltip", fork(TOOLTIP_VALUES), []);

  // --------------------------------------------------- 公开面本身也要对得上
  // 反向盯：库里少导一个符号也要红（否则薄再导出层会静默丢符号，应用侧 import 全变 undefined）
  const exported = (file: string): string[] => {
    const src = read(path.join(DIST, file));
    const names: string[] = [];
    for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
      for (const n of m[1].split(",")) {
        const s = n.trim().split(/\s+as\s+/).pop();
        if (s && s.indexOf("type ") !== 0) names.push(s.trim());
      }
    }
    for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) names.push(m[1]);
    return names.sort();
  };
  eq("uifork.surface.kit-values", exported("kit/index.js"), KIT_VALUES.slice().sort());
  eq("uifork.surface.tabs", exported("tabs.js"), TAB_VALUES.slice().sort());
  eq("uifork.surface.tooltip", exported("tooltip.js"), TOOLTIP_VALUES.slice().sort());
  {
    // exports map 的形状：三个子路径都在，且 types 条件排在 import 前面（条件按顺序匹配）
    const pj = JSON.parse(read(path.join(PKG, "package.json")));
    const want = ["./kit", "./tabs", "./tooltip"];
    const good = want.every((k) => {
      const e = pj.exports && pj.exports[k];
      if (!e || !e.types || !e.import) return false;
      return Object.keys(e).indexOf("types") < Object.keys(e).indexOf("import");
    });
    ok("uifork.exports.map", pj.name === "deer-ui" && good);
  }

  // -------------------------------------------------------- React 单实例
  // 判据：从**库的安装位置**解析 react / react-dom，得到必须与从应用根解析的是同一个文件。
  // 库自己没有 node_modules（上面已断言没有嵌套安装），所以两个入口必然指向同一份 ——
  // 产物级证据（esbuild metafile 里 react 输入恰好一条）见构建报告。
  const fromApp = (m: string): string => require.resolve(m);
  const fromLib = (m: string): string => require.resolve(m, { paths: [PKG] });
  eq("uifork.react.single-instance-react", fromLib("react"), fromApp("react"));
  eq("uifork.react.single-instance-react-dom", fromLib("react-dom"), fromApp("react-dom"));
  ok("uifork.react.no-nested-install", !fs.existsSync(path.join(PKG, "node_modules")));

  // ------------------------------------------------- 体系结构里最小的一份重复
  // 库里只有一份 tooltip 的实现（宿主那份已改成再导出），模块级订阅表因此只有一张。
  eq("uifork.tooltip.single-source", fs.existsSync(path.join(REPO, "src/ui/tooltip.ts")) && read(path.join(REPO, "src/ui/tooltip.ts")).indexOf('export * from "deer-ui/tooltip";') >= 0, true);

  // ------------------------------------------------- P2 之后：库**自带**样式，顺序断言在 ui-css.test.ts
  // 早先这里是一条「P0 不发 CSS」的闸门（库里一旦出现 .css 就红，提醒补顺序断言）——
  // P2 真的发了 CSS，所以它按约定变成了**正向**断言：库必须带 styles.css，且经 exports 暴露。
  // 「库段在应用段之前」的产物级断言落在 tests/ui-css.test.ts（uicss.artifact.order），
  // 因为那条要读拼出来的 app2/www/css/style.css，与本节「供应 / 防分叉」的关注点不同。
  {
    const cssFile = path.join(DIST, "styles.css");
    const pj = JSON.parse(read(path.join(PKG, "package.json")));
    ok("uifork.css.shipped",
      fs.existsSync(cssFile) && fs.statSync(cssFile).size > 10000
      && pj.exports && pj.exports["./styles.css"] === "./dist/styles.css",
      "size=" + (fs.existsSync(cssFile) ? fs.statSync(cssFile).size : "missing")
      + " exports=" + JSON.stringify(pj.exports && pj.exports["./styles.css"]));
  }
  ok("uifork.css.app-only", fs.existsSync(path.join(REPO, "src/ui/style.css")));
}
