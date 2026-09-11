// 产物自检：把 app2/www/js/app.js 放进一个最小 DOM 桩里真的跑一遍。
//
// 为什么需要它：esbuild 会在源文件所在目录向上找最近的 tsconfig.json 来决定 JSX
// 变换方式。仓库根那份是 "jsx": "react-jsx"（自动运行时，React 由打包器注入），
// 但只要构建目录里多出一份没有 jsx 字段的 tsconfig.json，esbuild 就会退回经典
// 变换，打出引用全局 React 的包 —— 构建"成功"、体积正常，运行时却
// `Uncaught ReferenceError: React is not defined`，页面直接白屏。
// 这个脚本专门拦这一类"能构建但不能运行"的错误（以及任何模块初始化就抛异常的情况）。
//
//   node toolchain/check-bundle.mjs [bundle 路径]     # 默认 app2/www/js/app.js
//
// 退出码：0 = 已渲染；1 = 打包错误（React 未定义一类，必须修）；2 = 其它异常
//（可能只是桩不够，需人工看一眼）。

import { pathToFileURL } from "node:url";

const bundle = process.argv[2] || "app2/www/js/app.js";

// ---------------------------------------------------------------- 最小 DOM 桩
function el(tag = "div") {
  return {
    nodeType: 1, tagName: String(tag).toUpperCase(), nodeName: String(tag).toUpperCase(),
    style: {}, dataset: {}, children: [], childNodes: [], ownerDocument: null, parentNode: null,
    textContent: "", innerHTML: "", className: "", id: "", value: "",
    width: 300, height: 150, offsetWidth: 300, offsetHeight: 150, clientWidth: 300, clientHeight: 150,
    setAttribute() {}, getAttribute: () => null, removeAttribute() {}, hasAttribute: () => false,
    appendChild(c) { this.children.push(c); this.childNodes.push(c); return c; },
    removeChild(c) { return c; }, insertBefore(c) { this.children.push(c); return c; }, replaceChild(c) { return c; },
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
    click() {}, focus() {}, blur() {}, remove() {}, contains: () => false,
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 150, width: 300, height: 150 }),
    getContext: () => null, toBlob() {}, toDataURL: () => "data:,",
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  };
}

const host = el("div");
const doc = {
  nodeType: 9, documentElement: el("html"), head: el("head"), body: el("body"), defaultView: null,
  getElementById: (id) => (id === "root" ? host : null),
  createElement: (t) => el(t), createElementNS: (_ns, t) => el(t), createTextNode: () => el("#text"),
  createDocumentFragment: () => el("#fragment"), querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true, cookie: "",
};
for (const n of [doc.documentElement, doc.head, doc.body, host]) n.ownerDocument = doc;

const define = (k, v) => Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
globalThis.document = doc;
globalThis.window = globalThis;
globalThis.self = globalThis;
define("navigator", { userAgent: "bundle-check", vibrate: () => false, maxTouchPoints: 0, platform: "linux" });
define("location", { href: "file:///bundle-check/", protocol: "file:", hostname: "localhost", search: "", hash: "" });
Object.assign(globalThis, {
  addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
  innerWidth: 1280, innerHeight: 800, outerWidth: 1280, outerHeight: 800, devicePixelRatio: 1,
  screen: { width: 1280, height: 800, availWidth: 1280, availHeight: 800 }, scrollX: 0, scrollY: 0,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {}, key: () => null, length: 0 },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  getComputedStyle: () => ({ paddingTop: "0px", paddingRight: "0px", paddingBottom: "0px", paddingLeft: "0px", getPropertyValue: () => "" }),
  getSelection: () => ({ rangeCount: 0, removeAllRanges() {}, addRange() {} }),
  requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
  requestIdleCallback: (cb) => setTimeout(() => cb({ timeRemaining: () => 1 }), 0),
  cancelIdleCallback: (id) => clearTimeout(id),
  CustomEvent: class CustomEvent { constructor(type, opts) { this.type = type; this.detail = opts && opts.detail; } },
  Image: class Image { set src(_v) {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
});
for (const name of [
  "HTMLElement", "HTMLIFrameElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement",
  "HTMLButtonElement", "HTMLCanvasElement", "HTMLImageElement", "SVGElement", "Element", "Node",
  "DocumentFragment", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent", "FocusEvent",
]) {
  if (!globalThis[name]) globalThis[name] = class {};
}
doc.defaultView = globalThis;

// ------------------------------------------------------------------- 跑一遍
const REACT_PACKAGING = /React is not defined|React\.createElement is not a function|Cannot read properties of undefined \(reading 'createElement'\)/;
let failure = null;
try {
  await import(pathToFileURL(bundle).href);
  await new Promise((r) => setTimeout(r, 50)); // 让 createRoot 的首帧跑完
} catch (e) {
  failure = String((e && e.message) || e).split("\n")[0];
}

if (failure && REACT_PACKAGING.test(failure)) {
  console.error("✗ 产物不可运行：" + failure);
  console.error("  esbuild 用了经典 JSX 变换（引用了全局 React）。检查构建目录往上找的 tsconfig.json");
  console.error("  是否为仓库根那份（需要 \"jsx\": \"react-jsx\"），或给 esbuild 显式加 --jsx=automatic。");
  process.exit(1);
}
if (failure) {
  console.error("? 产物抛了非 JSX 类异常（可能只是桩不够）：" + failure);
  process.exit(2);
}
if (!host.children.length) {
  console.error("? 产物没有报错，但也没往 #root 里渲染任何节点（桩可能不足，或应用没挂载）");
  process.exit(2);
}
console.log("✓ 产物自检通过：bundle 能加载并渲染出 " + host.children.length + " 个根节点");
process.exit(0);
