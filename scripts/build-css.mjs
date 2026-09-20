#!/usr/bin/env node
/**
 * 样式产物拼接：`deer-ui/styles.css`（库段）+ `src/ui/style.css`（应用段）
 *   → `app2/www/css/style.css`
 *
 * 为什么要有这一步（而不是像以前那样 `cp src/ui/style.css`）：
 *   P2 把设计令牌与 kit 控件的样式搬进了库（库仓库 `dist/styles.css`，导出为 `deer-ui/styles.css`），
 *   应用侧那份已经删掉 —— **库是那些声明的唯一来源**，产物必须由两段拼出来。
 *
 * 顺序是硬约定（docs/PLAN-deer-ui.md §4.5 的产物级断言②）：**库段在前、应用段在后**。
 *   反过来的话应用段会被同一批选择器盖住，症状是「改了库的样式，页面却不变」。
 *   本脚本写完会**再读回来验一遍**顺序，不满足就退出码 1，不留半成品。
 *
 * 库缺失时**大声失败**（不产出没样式的产物）：`deer-ui/styles.css` 解析不到 = 安装树里的
 * tarball 太旧（`exports["./styles.css"]` 是 P2 才加的）。修法：
 *   ① 库仓库（`Z:\deer-ui`）里 `npm run pack:vendor`（prepack 会 build + check:dist）
 *   ② 把产出的 `deerui-<version>.tgz` 拷到本仓库 `vendor/`（覆盖）
 *   ③ 本仓库 `npm install --legacy-peer-deps`
 * 所以这里不给自己留「找不到就用别处的副本」的退路 —— 那正是「两份样式悄悄分叉」的入口。
 *
 * 用法：
 *   node scripts/build-css.mjs                  # 写 app2/www/css/style.css
 *   node scripts/build-css.mjs --out <file>     # 写到别处（自测 / 临时验证用）
 *   node scripts/build-css.mjs --check          # 只比较不写入：产物过期则退出码 1
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_OUT = path.join("app2", "www", "css", "style.css");
const APP_CSS = path.join("src", "ui", "style.css");
const LIB_SPEC = "deer-ui/styles.css";
/** 产物开头的说明 + 两段的机器可读分界注释（人看 / grep 都方便） */
const HEADER = "/* 本文件由 scripts/build-css.mjs 生成，不要手改：deer-ui/styles.css（库段）+ src/ui/style.css（应用段） */";
const LIB_ANCHOR = "/* ===== 段：deer-ui/styles.css（库）===== */";
const APP_ANCHOR = "/* ===== 段：src/ui/style.css（应用）===== */";

const die = (msg) => {
  console.error("[build-css] " + msg);
  process.exit(1);
};

function parseArgs(argv) {
  const out = { out: DEFAULT_OUT, check: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") {
      const v = argv[++i];
      if (!v) die("--out 后面要给一个路径");
      out.out = v;
    } else if (a === "--check") out.check = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else die("未知参数：" + a + "（--help 看用法）");
  }
  return out;
}

/** 行尾归一成 LF：库仓库一律 LF，应用工作区在 Windows 上是 CRLF —— 产物里两段不一致会让 diff 噪音很大 */
const lf = (s) => s.replace(/\r\n?/g, "\n");

function resolveLibCss() {
  try {
    return require.resolve(LIB_SPEC);
  } catch (e) {
    die(
      "解析不到 " + LIB_SPEC + " —— 安装树里的 deer-ui 太旧（P2 之前打的 tarball 没有 styles.css）。\n" +
      "  修法：库仓库 `npm run pack:vendor` → 把 deerui-<version>.tgz 拷进本仓库 vendor/ → `npm install --legacy-peer-deps`。\n" +
      "  （故意不留回退：读别处的副本就等于让两份样式分叉）\n" +
      "  原始错误：" + (e && e.message ? e.message : String(e)),
    );
  }
}

function build(libFile, appFile) {
  const lib = lf(readFileSync(libFile, "utf8"));
  const app = lf(readFileSync(appFile, "utf8"));
  // 库段必须真的是样式表：解析到空文件 / 只有注释的文件（旧 tarball、被清空的产物）都要拦下来
  if (!/:root\s*\{/.test(lib) || (lib.match(/\{/g) || []).length < 20) {
    die("库段不像样式表（缺 :root 或规则太少）：" + libFile + "（" + lib.length + " 字节）");
  }
  if (app.indexOf(":root{") >= 0 || app.indexOf('[data-theme="light"]{') >= 0) {
    die("应用段里还有令牌块（`src/ui/style.css` 不该再定义 :root / [data-theme=\"light\"]）—— 唯一来源是库");
  }
  return HEADER + "\n" + LIB_ANCHOR + "\n" + lib.replace(/\n*$/, "\n") + "\n" + APP_ANCHOR + "\n" + app.replace(/\n*$/, "\n");
}

/** 顺序自检：再读一遍产物，确认「库段在应用段之前」且两段都真的在里面 */
function assertOrder(outFile, text, libFile, appFile) {
  const lib = lf(readFileSync(libFile, "utf8")).trim();
  const app = lf(readFileSync(appFile, "utf8")).trim();
  const libAt = text.indexOf(lib);
  const appAt = text.indexOf(app);
  const libAnchorAt = text.indexOf(LIB_ANCHOR);
  const appAnchorAt = text.indexOf(APP_ANCHOR);
  if (libAt < 0) die("产物里找不到库段原文：" + outFile);
  if (appAt < 0) die("产物里找不到应用段原文：" + outFile);
  if (!(libAnchorAt >= 0 && appAnchorAt > libAnchorAt)) die("产物里两段的分界注释顺序不对：" + outFile);
  if (!(libAt < appAt)) die("产物里库段必须出现在应用段之前（现在 lib@" + libAt + " app@" + appAt + "）：" + outFile);
  // 偏移量按**字节**打印：`indexOf` 给的是字符下标，中文注释下两者不等，容易被误读
  const bytesUpTo = (idx) => Buffer.byteLength(text.slice(0, idx), "utf8");
  return { libAt: bytesUpTo(libAt), appAt: bytesUpTo(appAt), libBytes: Buffer.byteLength(lib, "utf8"), appBytes: Buffer.byteLength(app, "utf8") };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("用法：node scripts/build-css.mjs [--out <file>] [--check]\n  默认输出 app2/www/css/style.css（库段在前、应用段在后）");
    return;
  }
  const libFile = resolveLibCss();
  const appFile = path.join(repoRoot, APP_CSS);
  if (!existsSync(appFile)) die("找不到应用样式表：" + appFile);
  const outFile = path.isAbsolute(args.out) ? args.out : path.join(repoRoot, args.out);
  const text = build(libFile, appFile);

  if (args.check) {
    const cur = existsSync(outFile) ? lf(readFileSync(outFile, "utf8")) : "";
    if (cur !== text) die("产物与来源不一致（跑一次不带 --check 的 build-css 重建）：" + outFile);
    console.log("[build-css] --check OK：" + path.relative(repoRoot, outFile) + "（" + Buffer.byteLength(text) + " 字节）");
    return;
  }

  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, text, "utf8");
  const order = assertOrder(outFile, lf(readFileSync(outFile, "utf8")), libFile, appFile);
  console.log("[build-css] 库段 " + path.relative(repoRoot, libFile) + "（" + order.libBytes + " B，字节偏移 " + order.libAt + "）");
  console.log("[build-css] 应用段 " + APP_CSS + "（" + order.appBytes + " B，字节偏移 " + order.appAt + "）");
  console.log("[build-css] 写出 " + path.relative(repoRoot, outFile) + "（" + Buffer.byteLength(text, "utf8") + " 字节）：库段在应用段之前 ✔");
}

main();
