// deer-ui 是 bundler-only 的库：dist 是 ESM，相对 import 不带扩展名，exports 只有 import 条件。
// 于是 Node 的 CJS 测试进程**两种方式都拿不到它**：`require("deer-ui/kit")` 因为 exports 里没有
// require 条件而 ERR_PACKAGE_PATH_NOT_EXPORTED，直接 require 到文件又会因为无扩展名 import 报错。
//
// 这个桥只作用于**测试进程**（应用产物不走这里，esbuild 构建时正常走 exports map，见
// scripts/build-web.sh），做两件事：
//   ① 把 node_modules/deer-ui/dist 里每个 .js 用 esbuild 转成 CJS，落到 tests/.ts-out/.deerui/dist；
//   ② 把三个公开入口说明符 `deer-ui/kit` / `deer-ui/tabs` / `deer-ui/tooltip` 指到转好的文件。
//
// **逐文件转换、不是每个入口各打一个 bundle** —— 模块图与文件一一对应，所以
// `tooltip` 这种模块级可变单例（订阅表）在测试进程里也仍然只有一份（docs/PLAN-deer-ui.md R10）。
// 若是三个 bundle，kit 内联的那份 tooltip 会与 tooltip 入口各持一个订阅表，测试环境就与产物不一致了。
declare const require: (m: string) => any;
declare const __dirname: string;

const fs = require("fs");
const path = require("path");
const Module = require("module");
const esbuild = require("esbuild");

// 编译产物是 tests/.ts-out/tests/*.js，所以往上三层才是仓库根
const REPO = path.resolve(__dirname, "../../..");
const SRC = path.join(REPO, "node_modules/deer-ui/dist");
const OUT = path.resolve(__dirname, "../.deerui/dist");

// 库 exports map 里暴露的三个子路径（第四个是 ./package.json，运行时用不到）
const ENTRIES: Record<string, string> = {
  "deer-ui/kit": "kit/index.js",
  "deer-ui/tabs": "tabs.js",
  "deer-ui/tooltip": "tooltip.js",
};

if (!fs.existsSync(SRC)) {
  throw new Error(
    "deer-ui 没装：先跑 `npm install`（package.json 里 deer-ui = file:vendor/deerui-0.1.0.tgz）",
  );
}

const jsFiles: string[] = [];
{
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.slice(-3) === ".js") jsFiles.push(path.relative(SRC, p));
    }
  };
  walk(SRC);
}

for (const rel of jsFiles) {
  const code = esbuild.transformSync(fs.readFileSync(path.join(SRC, rel), "utf8"), {
    loader: "js",
    format: "cjs",
    target: "es2019",
  }).code as string;
  const dest = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, code);
}

const mapped: Record<string, string> = {};
for (const id of Object.keys(ENTRIES)) mapped[id] = path.join(OUT, ENTRIES[id]);

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...rest: unknown[]): string {
  const hit = mapped[request];
  if (hit) return hit;
  return origResolve.apply(this, [request, ...rest]);
};
