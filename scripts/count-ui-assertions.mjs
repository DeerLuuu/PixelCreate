#!/usr/bin/env node
/**
 * **应用侧记账**：数应用自己的 `tests/ui-kit.test.tsx` 跑出多少条 `ui.*` 断言，并与台账对账。
 *
 * 它的前身是库仓库的 `scripts/count-host-assertions.mjs`（数「宿主 ui kit 小节」的账），
 * P2/独立化那一轮**从库里删掉**了：那是应用侧的账，库不该持有、也不该依赖宿主仓库。
 * 现在这份落在应用里，读的是**应用自己的**测试文件，库侧不再需要任何宿主路径。
 *
 * 跑法：`npm run count:ui-assertions`（前置：`node node_modules/typescript/bin/tsc -p tests/tsconfig.json`）
 *
 * 口径（三条，和旧脚本一致）：
 *   ① `ui.*` = **运行期**跑出来的断言名（不是静态数 `ok("ui.` 的调用点 —— 文件里有 `for` 循环
 *      生成名字，静态数一定数错）。做法：在进程内 require 编译产物 `tests/.ts-out/tests/ui-kit.test.js`，
 *      把 `common.ok/eq` 包一层记录名字。
 *   ② 交叉校验甲：每条运行期名字都要能在 `tests/ui-kit.test.tsx` 源码里找到对应**字面量前缀**
 *      （循环生成的名字按前缀命中），否则说明数出来的东西不是这个文件产生的。
 *   ③ 交叉校验乙（可选）：`node tests/.ts-out/tests/run-tests.js > log` 之后
 *      `--from-run-log log`，数 `--- ui kit ---` 小节里的 `ok ` 行 —— 两处口径必须一致。
 *
 * 数字变了要两处一起改：本文件的 `EXPECTED_UI_KIT` 与库仓库 `tests/budget.test.ts` 的门槛
 * （库那边的口径见 `Z:\deer-ui` README「断言台账」）。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TS_OUT = path.join(repoRoot, "tests", ".ts-out", "tests");
const KIT_TEST_JS = path.join(TS_OUT, "ui-kit.test.js");
const KIT_TEST_SRC = path.join(repoRoot, "tests", "ui-kit.test.tsx");
/** 台账里写死的期望值（库仓库那轮的记账：宿主 ui kit 小节 = 70 = 搬入 62 + 留宿主 8） */
const EXPECTED_UI_KIT = 70;
const SECTION = "ui kit";

const die = (msg) => { console.error("[count-ui] " + msg); process.exit(1); };

function parseArgs(argv) {
  const out = { fromRunLog: null, list: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--from-run-log") out.fromRunLog = argv[++i];
    else if (argv[i] === "--list") out.list = true;
    else if (argv[i] === "--help" || argv[i] === "-h") out.help = true;
    else die("未知参数：" + argv[i] + "（--help 看用法）");
  }
  return out;
}

/** 在进程内跑一份编译产物，记录每条断言的**运行期名字**（caller 负责恢复 console/common） */
function collect(entry) {
  require(path.join(TS_OUT, "deerui-bridge.js")); // 库是 ESM/bundler-only，测试进程要先装桥
  const common = require(path.join(TS_OUT, "common.js"));
  const names = [];
  const ok0 = common.ok;
  const eq0 = common.eq;
  const finish0 = common.finish;
  common.ok = function (n, c, d) { names.push(n); return ok0(n, c, d); };
  common.eq = function (n, a, b) { names.push(n); return eq0(n, a, b); };
  common.finish = function () { /* 收尾交给本脚本 */ };
  const log0 = console.log;
  const err0 = console.error;
  console.log = () => {};
  console.error = () => {};
  let err = null;
  try {
    require(entry).testUiKit();
  } catch (e) {
    err = e && e.message ? e.message : String(e);
  }
  console.log = log0;
  console.error = err0;
  common.ok = ok0;
  common.eq = eq0;
  common.finish = finish0;
  return { names, err, total: common.total, fails: common.fails };
}

/** 名字能不能追溯到源码里的字面量前缀（循环生成的名字只在前缀处有字面量） */
function traceable(name, src) {
  const parts = name.split(".");
  for (let i = parts.length; i >= 1; i--) {
    const prefix = parts.slice(0, i).join(".");
    if (src.indexOf('"' + prefix) >= 0 || src.indexOf("'" + prefix) >= 0) return true;
  }
  return false;
}

/**
 * 读文本：PowerShell 的 `>` 重定向写的是 **UTF-16LE**（带 BOM），node 按 utf8 读会全是乱码 ——
 * 这个坑在本仓库踩过不止一次（`node tests/.ts-out/tests/run-tests.js > log` 是最常见的一条）。
 */
function readText(file) {
  const buf = readFileSync(file);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString("utf16le");
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return buf.slice(2).swap16().toString("utf16le");
  return buf.toString("utf8");
}

/** 从 run-tests.js 的输出里数某个小节的 `ok ` 行（`--- 小节名 ---` 分段） */function countInRunLog(text, section) {
  const lines = text.split(/\r?\n/);
  let current = "";
  const hits = [];
  const perSection = {};
  for (const ln of lines) {
    const sec = /^---\s*(.+?)\s*---\s*$/.exec(ln);
    if (sec) { current = sec[1]; continue; }
    const m = /^ok {2}(.+?)\s*$/.exec(ln);
    if (!m) continue;
    perSection[current] = (perSection[current] || 0) + 1;
    if (m[1].indexOf("ui.") === 0) hits.push(current + " | " + m[1]);
  }
  return { hits, inSection: hits.filter((h) => h.indexOf(section + " | ") === 0).length, perSection };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("用法：node scripts/count-ui-assertions.mjs [--from-run-log <log>] [--list]\n"
      + "  数应用 tests/ui-kit.test.tsx 的 ui.* 断言，与台账对账；--from-run-log 用 run-tests.js 的输出交叉校验。");
    return;
  }
  if (!existsSync(KIT_TEST_JS)) {
    die("没有编译产物 " + KIT_TEST_JS + "\n  先跑：node node_modules/typescript/bin/tsc -p tests/tsconfig.json");
  }
  if (!existsSync(KIT_TEST_SRC)) die("找不到 " + KIT_TEST_SRC);

  const src = readFileSync(KIT_TEST_SRC, "utf8");
  const run = collect(KIT_TEST_JS);
  if (run.err) die("跑 " + path.relative(repoRoot, KIT_TEST_JS) + " 时抛异常：" + run.err);

  const ui = run.names.filter((n) => n.indexOf("ui.") === 0);
  const groups = {};
  for (const n of ui) {
    const g = n.split(".").slice(0, 2).join(".");
    groups[g] = (groups[g] || 0) + 1;
  }
  const untraceable = ui.filter((n) => !traceable(n, src));

  console.log("========== 应用侧记账：tests/ui-kit.test.tsx ==========");
  console.log("运行期断言总数（本文件）= " + run.names.length + "，其中 ui.* = " + ui.length
    + "，台账期望 = " + EXPECTED_UI_KIT
    + (ui.length === EXPECTED_UI_KIT ? "（一致）" : "（⚠ 不一致：改了就同步 EXPECTED_UI_KIT 与库侧门槛）"));
  console.log("ui.* 构成： " + Object.keys(groups).sort().map((g) => g + " ×" + groups[g]).join(" / "));
  if (args.list) for (const n of ui) console.log("   - " + n);
  console.log("交叉校验甲（名字能在源码里追溯到字面量前缀）：" + (untraceable.length === 0 ? "OK" : "FAIL " + untraceable.join(", ")));
  console.log("另一种数法（口径自洽用）：node tests/.ts-out/tests/run-tests.js > log && "
    + "node scripts/count-ui-assertions.mjs --from-run-log log");

  const problems = [];
  if (ui.length !== EXPECTED_UI_KIT) problems.push("ui.* 数 " + ui.length + " ≠ 台账 " + EXPECTED_UI_KIT);
  if (untraceable.length) problems.push("有名字追溯不到 " + path.relative(repoRoot, KIT_TEST_SRC) + "：" + untraceable.join(", "));
  if (run.fails) problems.push("这份测试自己有 " + run.fails + " 条失败");

  if (args.fromRunLog) {
    if (!existsSync(args.fromRunLog)) die("找不到 run-tests 日志：" + args.fromRunLog);
    const r = countInRunLog(readText(args.fromRunLog), SECTION);
    console.log("========== 交叉校验乙：run-tests.js 的 " + SECTION + " 小节 ==========");
    console.log("日志里 ui.* 的 ok 行总数 = " + r.hits.length + "，其中 " + SECTION + " 小节 = " + r.inSection);
    if (r.inSection !== ui.length) problems.push("交叉校验乙不一致：日志 " + r.inSection + " ≠ 本脚本 " + ui.length);
    else console.log("交叉校验乙：一致（" + r.inSection + " = " + ui.length + "）");
  }

  if (problems.length) {
    console.error("[count-ui] FAIL");
    for (const p of problems) console.error("  - " + p);
    process.exit(1);
  }
  console.log("[count-ui] OK：" + ui.length + " 条 ui.* 断言（= 台账 " + EXPECTED_UI_KIT + "）");
}

main();
