// Android 返回键处理器（`FloatingTools` 的 `pc-back`）静态守卫。
//
// 为什么这里要有一条**静态**断言：`src/ui/App.tsx` 那个处理器早先把 `st.sel` 当成一定有值来读，
// 而 `sel`（选区球）是这一组里**唯一**可能整个为 `null` 的 state（`pal` / `fx` / `canv` 都有默认对象）。
// 没有选区球时按返回键就会抛 `TypeError: Cannot read properties of null (reading 'open')`：
//   · 异常在事件派发里被吞掉（App 自己的 `pc-back` 监听照常跑），所以**功能看起来没问题**；
//   · 于是单测与人工都漏了它 —— 在 HEAD 基线上活了很久，最后由 P9 的真浏览器探针才发现。
// 这类「异常被吞掉」的坑，仓库的惯例是拿静态断言钉住（参见 `f2.panel-base-not-transport`、
// `warpui.order.*`）。这里是同一做法的另一例。
//
// 三条（与 P11 的修复口径一一对应）：
//   ① `st.sel.open` 的**每一次**读都必须先判空 —— 这个处理器里读它**两处**：一次判「有没有浮层要收」、
//      一次收它自己。只判一处不够：主球环开着时 `st.open` 会让第一个判定的 `||` 短路成 true，
//      流程继续走到第二次读，照样抛（P11 的真浏览器复现：`orb open` 状态下按返回键崩在第二处）。
//   ② `backState` 的两处仍在（ref 初始化 + 每一帧同步）—— 处理器读的是 ref 里的**实时**状态，
//      少任何一处，它读到的就是过期的 `sel`。
//   ③ 处理器形状仍在（`const onBack` + 先读后收 + `d.handled = true` 的语义）—— 防止「顺手重构」
//      把「谁算已处理」这条契约改掉（App 与原生侧都靠 `d.handled` 决定要不要继续处理）。
//
// 这一份只读 `src/ui/App.tsx` 的源码文本，不 import 任何 UI 模块（没有 DOM 也能跑）。
import { eq, ok } from "./common";

declare const require: (m: string) => any;
declare const __dirname: string;
const fs = require("fs");
const path = require("path");

/** 已编译的测试目录是 `<app>/tests/.ts-out/tests`，`src/` 在仓库根下 */
const APP_SRC = (): string => path.resolve(__dirname, "../../../src/ui/App.tsx");

/** 判空写法（等价即可，不钉死某一种）：`st.sel !== null` / `st.sel != null` / `st.sel &&` */
const GUARD = /st\.sel\s*(?:!==\s*null|!=\s*null|&&)/;

/**
 * 把 FloatingTools 的返回键处理器正文切出来。
 *
 * 两个坑（都踩过）：
 *   1. 全文有**两个** `const onBack`（App 层还有一个给助手浮窗收尾用的），所以定位要用
 *      `backState.current` 这个只在 FloatingTools 里出现的东西，不能拿第一个 `const onBack` 就完事；
 *   2. 搜索串里**别写出完整的箭头签名** —— 上面那段注释里也带着它，`indexOf` 会先命中注释。
 */
function backHandlerRegion(src: string): string {
  const norm = src.replace(/\r\n/g, "\n");            // 仓库里可能是 CRLF（git 会警告），先归一
  const anchor = norm.indexOf("const st = backState.current;");
  if (anchor < 0) return "";
  const head = norm.indexOf("const onBack", anchor - 200 >= 0 ? anchor - 200 : 0);
  const start = head < 0 ? anchor : head;
  const end = norm.indexOf("\n    };", anchor);
  return end < 0 ? norm.slice(start) : norm.slice(start, end);
}

export function testUiBack(): void {
  const src = (fs.readFileSync(APP_SRC(), "utf8") as string).replace(/\r\n/g, "\n");
  const region = backHandlerRegion(src);
  ok("uiback.handler.found", region.length > 200, "region=" + region.length + " 字符");

  // ---- ① `st.sel.open` 的每一次读都要判空 ----
  const reads = region.split("\n")
    .map((line, i) => ({ line: line.trim(), no: i + 1 }))
    .filter((x) => x.line.indexOf("st.sel.open") >= 0);
  eq("uiback.sel-open.read-count", reads.length, 2);          // 判定一次 + 收它自己一次
  eq("uiback.sel-open.all-guarded", reads.filter((r) => !GUARD.test(r.line)).map((r) => "第" + r.no + "行: " + r.line), []);
  // 兜底写法也算数：处理器更早处 `if (!st.sel) return;` / `if (st.sel === null) return;`
  const earlyReturn = /if\s*\(\s*!st\.sel\s*\)\s*return|if\s*\(\s*st\.sel\s*===\s*null\s*\)\s*return/.test(region);
  ok("uiback.sel-open.has-guard", reads.every((r) => GUARD.test(r.line)) || earlyReturn,
    "判空写法：" + (earlyReturn ? "早退" : "行内"));

  // ---- ② `backState` 的两处仍在 ----
  ok("uiback.backstate.ref-init", /const backState = useRef\(\{[^}]*\bsel\b[^}]*\}\)/.test(src));
  ok("uiback.backstate.synced-every-render", /backState\.current = \{[^}]*\bsel\b[^}]*\}/.test(src));

  // ---- ③ 处理器形状与 `d.handled` 语义 ----
  ok("uiback.handler.reads-detail", region.indexOf("(e as CustomEvent<{ handled: boolean }>).detail") >= 0);
  ok("uiback.handler.respects-foreign-handling", /if\s*\(!d\s*\|\|\s*d\.handled\)\s*return/.test(region));
  ok("uiback.handler.marks-handled-last",
    region.indexOf("d.handled = true") > region.indexOf("setOpen(false)")
    && region.indexOf("d.handled = true") > region.indexOf("setSub(null)"));
  ok("uiback.handler.listens-and-cleans", src.indexOf('window.addEventListener("pc-back", onBack)') >= 0
    && src.indexOf('window.removeEventListener("pc-back", onBack)') >= 0);
  // 收起动作一个都不能少（少一个就等于悄悄改了行为）
  const closes = ["setOpen(false)", "setSub(null)", "setPal(", "setFx(", "setCanv("];
  eq("uiback.handler.closes-all-layers", closes.filter((c) => region.indexOf(c) < 0), []);
}
