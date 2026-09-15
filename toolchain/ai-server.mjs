// C3 的 Node 开发宿主：在 Windows / Linux / macOS 上把同一份协议路由真跑起来。
//
//   node toolchain/ai-server.mjs                          # 只绑 127.0.0.1:8787 · 档位 read
//   node toolchain/ai-server.mjs --port 8788 --tier draw  # 换端口 / 放开写类工具
//   AI_TOKEN=xxx AI_TIER=all node toolchain/ai-server.mjs # 环境变量也行
//   node toolchain/ai-server.mjs --help
//
// 三条口径与 APK 里完全一样（因为调的是**同一份** src/app/ai-rpc.ts）：
//   · 只绑 127.0.0.1（局域网访问不到）；token 每次启动随机生成（16 字节十六进制）并打印；
//   · `POST /ai` 的 body 是单行 JSON `{"call":"…","args":{…}}`，`GET /ai/health` 的 body 是空串；
//   · `ctx.confirm` **不提供** → 路由用 AI_CONFIRM_DENY：destructive 工具一律回
//     `{"ok":false,"error":"cancelled"}`（这个宿主没有确认 UI，C5 才有）。
//
// 它**不重新实现**协议：只做三件事 —— 起 http 服务器、把请求规约成 AiRpcRequest、
// 调 tests/.ts-out 里编译好的 `handleAiRequestAsync`。所以这里没有一行路由 / 鉴权 / tier 判定。
//
// 没有第三方依赖；Session 在 Node 里靠 tests/session.test.ts 的 `stubEnv()`（编译产物）跑起来。

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(root, "tests", ".ts-out"); // tsc -p tests/tsconfig.json 的产物

const TSC_HINT = [
  "先编译（仓库在 Windows 上，没有 sh）：",
  "  Remove-Item -Recurse -Force tests\\.ts-out -ErrorAction SilentlyContinue",
  "  node node_modules/typescript/bin/tsc -p tests/tsconfig.json",
].join("\n  ");

// ------------------------------------------------------------------ 参数

function parseArgs(argv) {
  const out = { port: 8787, token: "", tier: "read", version: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => (i + 1 < argv.length ? argv[++i] : "");
    if (a === "--port" || a === "-p") out.port = Number(next());
    else if (a === "--token" || a === "-t") out.token = next();
    else if (a === "--tier") out.tier = next();
    else if (a === "--version") out.version = next();
    else if (a === "--help" || a === "-h") out.help = true;
    else {
      console.error("未知参数：" + a);
      out.help = true;
    }
  }
  if (process.env.AI_PORT) out.port = Number(process.env.AI_PORT);
  if (process.env.AI_TOKEN) out.token = process.env.AI_TOKEN;
  if (process.env.AI_TIER) out.tier = process.env.AI_TIER;
  return out;
}

function usage() {
  console.log([
    "用法：node toolchain/ai-server.mjs [--port 8787] [--token <hex>] [--tier read|draw|all] [--version x.y.z]",
    "环境变量：AI_PORT / AI_TOKEN / AI_TIER",
    "默认：只绑 127.0.0.1:8787 · 档位 read（只读）· token 随机生成并打印",
    "档位只决定「要不要确认」与默认列出哪些工具；destructive 在这个宿主里一律被拒绝（没有确认 UI）。",
  ].join("\n"));
}

// ------------------------------------------------------------------ 编译产物

function loadApp() {
  const need = [
    path.join(OUT, "src", "app", "ai-rpc.js"),
    path.join(OUT, "src", "app", "ai-serve.js"),
    path.join(OUT, "src", "app", "session.js"),
    path.join(OUT, "tests", "session.test.js"),
  ];
  const missing = need.filter((p) => !fs.existsSync(p));
  if (missing.length) {
    console.error("缺少编译产物：\n  " + missing.join("\n  ") + "\n" + TSC_HINT);
    process.exit(1);
  }
  const rpc = require(path.join(OUT, "src", "app", "ai-rpc.js"));
  const serve = require(path.join(OUT, "src", "app", "ai-serve.js"));
  const { Session } = require(path.join(OUT, "src", "app", "session.js"));
  // 同一个最小桩：Node 里没有 DOM，Session 需要 window/document/localStorage/canvas 的替身
  const { stubEnv } = require(path.join(OUT, "tests", "session.test.js"));
  return { rpc, serve, Session, stubEnv };
}

/** 应用版本号：直接从 changelog.tsx 里抠出来（这个脚本不 import UI，也就不拖 React 进来） */
function appVersion() {
  try {
    const src = fs.readFileSync(path.join(root, "src", "ui", "changelog.tsx"), "utf8");
    const m = src.match(/APP_VERSION\s*=\s*"([^"]+)"/);
    return m ? m[1] : "dev";
  } catch {
    return "dev";
  }
}

// ------------------------------------------------------------------ 主流程

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return;
  }
  if (!opts.port || opts.port < 1024 || opts.port > 65535) {
    console.error("端口不合法：" + opts.port + "（允许 1024..65535）");
    process.exit(1);
  }
  if (["read", "draw", "all"].indexOf(opts.tier) < 0) {
    console.error("档位不合法：" + opts.tier + "（read | draw | all）");
    process.exit(1);
  }

  const { rpc, serve, Session, stubEnv } = loadApp();
  stubEnv(); // ← 必须在 new Session() 之前：它要读 localStorage / document
  const session = new Session();
  const version = opts.version || appVersion();
  const token = opts.token || serve.randomToken(); // 16 字节十六进制；每次启动都换

  const ctx = {
    session,
    token,
    tier: opts.tier,
    version,
    // confirm 故意省略 → 路由用 AI_CONFIRM_DENY（恒 false）：destructive 一定被拒
    hostStatus: () => ({
      host: "node-dev-host",
      node: process.version,
      pid: process.pid,
      note: "destructive 需宿主确认，这个宿主没接线，一律回 cancelled（C5 才有确认 UI）",
    }),
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on("data", (c) => {
      size += c.length;
      // 比路由的字符上限宽 4 倍（UTF-8 一个字符最多 4 字节），先挡住超大 body 再交给路由判 413
      if (size > rpc.AI_RPC_MAX_BODY * 4) {
        aborted = true;
        res.writeHead(413, { "content-type": "application/json; charset=utf-8" });
        res.end(rpc.aiRpcErrorBody("body too large（上限 " + rpc.AI_RPC_MAX_BODY + " 字符）"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (aborted) return;
      void handle(req, res, Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", () => {
      if (!aborted) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(rpc.aiRpcErrorBody("request error"));
      }
    });
  });

  async function handle(req, res, body) {
    const auth = String(req.headers.authorization || "");
    const requestToken = auth.replace(/^Bearer\s+/i, "").trim();
    const out = await rpc.handleAiRequestAsync(
      { method: req.method || "GET", path: req.url || "/", token: requestToken, body },
      ctx,
    );
    res.writeHead(out.status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(out.body),
    });
    res.end(out.body);
    const short = out.body.length > 200 ? out.body.slice(0, 200) + "…" : out.body;
    console.log("  " + (req.method || "") + " " + (req.url || "") + " → " + out.status + " " + short);
  }

  // 回合空闲兜底（C2 的影子里有个「没人来 commit」的窗口）：
  // 外部 agent 断线后再也不来请求，就靠这个定时器把回合收掉，否则用户此后画的东西静默不进历史。
  const guard = setInterval(() => {
    try {
      if (rpc.expireIdleTurn(session)) console.log("  ⚠ 回合空闲超时，已自动 rollback（" + rpc.aiTurnIdleSeconds() + "s）");
    } catch (e) {
      console.log("  ⚠ 空闲收尾出错：" + (e && e.message ? e.message : String(e)));
    }
  }, 5000);
  if (typeof guard.unref === "function") guard.unref();

  function shutdown(signal) {
    console.log("\n收到 " + signal + "，收尾中…");
    try {
      if (session.aiTurnOpen()) {
        session.rollbackAiTurn();
        console.log("  已回滚开着的回合（避免 History 影子残留）");
      }
    } catch (e) {
      console.log("  回合回滚出错：" + (e && e.message ? e.message : String(e)));
    }
    clearInterval(guard);
    server.close(() => {
      console.log(serve.aiServeStatusText());
      process.exit(0);
    });
    // 兜底：连接没关干净也别拖着
    setTimeout(() => process.exit(0), 500);
  }
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  server.on("error", (e) => {
    console.error("监听 127.0.0.1:" + opts.port + " 失败：" + (e && e.message ? e.message : String(e)));
    console.error("端口被占用时换一个：node toolchain/ai-server.mjs --port 8788");
    process.exit(1);
  });

  server.listen(opts.port, "127.0.0.1", () => {
    console.log("PixelCraft AI 本地服务（Node 开发宿主）");
    console.log("  地址：http://127.0.0.1:" + opts.port + "（只绑本机，局域网访问不到）");
    console.log("  token：" + token + "      ← 每次启动重新随机生成");
    console.log("  档位：" + opts.tier + "（read 只读 / draw 允许写 / all 连 destructive 也放行，但本宿主一律拒绝确认）");
    console.log("  版本：" + version);
    console.log("  试一下：");
    console.log('    curl.exe -s -H "Authorization: Bearer ' + token + '" http://127.0.0.1:' + opts.port + "/ai/health");
    console.log('    curl.exe -s -X POST -H "Authorization: Bearer ' + token + '" -d "{\\"call\\":\\"list_tools\\"}" http://127.0.0.1:' + opts.port + "/ai");
    console.log("  Ctrl+C 退出（会先回滚开着的回合）");
  });
}

main();
