// P7 · PC 桌面版「最小启动器壳」（零依赖，只用 Node 内置模块）。
//
//   node toolchain/pc-shell.mjs                       # 起壳 + 自动开应用窗口（默认 127.0.0.1:8787）
//   node toolchain/pc-shell.mjs --port 8790 --no-open # 换端口 / 只起服务不开窗（自测用）
//   AI_PORT=8787 AI_TOKEN=xxx node toolchain/pc-shell.mjs
//   node toolchain/pc-shell.mjs --help
//   Windows 双击：toolchain\pc-shell.cmd
//
// ## 它是什么、为什么长这样
//
// 一个进程同时干三件事：伺服 app2/www 静态站点、在**同一个端口**上提供 AI 工具服务的两个入口、
// 把 AI 请求**转发进窗口里那个页面**。没有 Electron / Tauri，也没有第三方依赖。
//
// **为什么必须转发进页面**：浏览器页面不能监听端口，所以壳不能自己跑一份独立文档 —— 那样 AI 画的
// 是另一个进程里的空画布，跟用户看到的窗口毫无关系。分工与 APK 完全一致：
//
//     MCP 宿主 / curl ──HTTP(127.0.0.1:8787)──> 壳（只做传输 + 鉴权 + 状态码）
//                                                  │  SSE 推 envelope + requestId
//                                                  ▼
//                            窗口页面 window.__pc_ai_call(envelopeJson, requestId)
//                                                  │ = src/app/ai-serve.ts 的 aiServeHandleCall
//                                                  │ （业务全在页面的 ai-rpc / session 里）
//     壳把结果写回那个 HTTP 响应 <──POST /shell/reply（或页面稍后 aiRespond）┘
//
// 所以**协议一行都不重写**：状态码 / envelope / 双返回形态 / 失败码照 docs/API.md §24 与
// android/AiServer.java + MainActivity.java 的口径，壳只顶替 Java 的那两个位置（socket 与桥）。
//
// ## 通道为什么选 SSE（另一个选项是长轮询）
//
//   · **一个连接就够**：页面刷新 = EventSource 自动重连（`retry:` 已下发），不必每 300ms 发一次
//     长轮询；壳也知道「现在有没有页面上线」，这正是 `js-not-ready`（503）的判据；
//   · **低延迟**：`call_tool` 里 destructive 要等应用内确认，那 10s 预算不能被轮询间隔吃掉；
//   · **方向干净**：壳 → 页面只有一条 SSE 流，页面 → 壳只有 `POST /shell/reply`（带 requestId），
//     没有请求走私，未决请求的账本只放一处（壳的 pending 表）；
//   · 代价：SSE 是长连接，要设 `cache-control: no-store` + 定时心跳（20s）来发现死连接 —— 都在下面。
//
// ## 「Pages 不背 AI」的注入口径
//
// 壳桥只在**被这个壳伺服**的 index.html 里注入（下面 `injectBridge`），是内联脚本，不多一个文件；
// GitHub Pages / devserver.js / 任何普通静态服务都**不会**注入 → `window.PixelBridge` 不存在 →
// `ai-serve.ts` 的 `bridgeOf()` 走 `no-bridge` 分支，线上永远没有 AI，也没有监听端口的可能。
//
// ## 安全口径（与 §24 一致，壳不加也不减）
//
//   · 只绑 127.0.0.1；token **未指定时才**随机生成（16 字节 → 32 位十六进制）并打印，给了
//     `--token` / `AI_TOKEN` 就用给的那个；只在内存里（不落盘、不写进 HTML）；
//   · AI 入口的 Bearer 校验用常量时间比较（与 AiServer.java 同做法）；
//   · **服务默认关闭**：页面里的设置 `ai.server`（默认 false）没打开时，壳回 503 `ai-off` —— 壳自己
//     不会替用户把 AI 打开，「打开本机 AI」始终是用户在应用里的一个动作；
//   · token **不写进 HTML**：页面运行时用一次 loopback 握手（`POST /shell/handshake`）现取，免得
//     它出现在页面源码 / 缓存 / 截图里。老实说：能读 127.0.0.1 的本机进程同样能调握手拿到 token，
//     所以这条只防「误连与顺手泄漏」，不防本机恶意进程（那需要 OS 级隔离，与 ai-server.mjs 同一口径）。

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, ".."); // 站点根按**本脚本位置**推导（devserver.js 同款做法）
const WWW = path.join(ROOT, "app2", "www");
const HOST = "127.0.0.1"; // 只回环：局域网连不进来
/** 与 AiServer.MAX_BODY_BYTES 同口径（1 MiB）；超过回 413 */
const MAX_BODY_BYTES = 1024 * 1024;
/** 默认调用超时：与 MainActivity.AI_CALL_TIMEOUT_MS 一致 */
const DEFAULT_TIMEOUT_MS = 10000;
const HEARTBEAT_MS = 20000;
/**
 * provider 转发（`/provider/*`）的默认值与上限。**key 只在这一个进程里**（§3.7.2/§3.7.4）：
 * 页面从头到尾拿不到它 —— 页面只拿到 `GET /provider/config` 的一个布尔与两个公开字符串。
 */
const DEFAULT_PROVIDER_BASE = "https://api.deepseek.com";
const DEFAULT_PROVIDER_MODEL = "deepseek-v4-pro";
/** provider key 的环境变量优先级（第一个非空即用；§3.7.4 的定稿顺序） */
const PROVIDER_KEY_ENV = ["DEEPSEEK_API_KEY", "OPENAI_API_KEY", "PC_AI_KEY"];
/** 上游响应体上限（8 MiB）：比它大就截断并记日志，绝不把整个响应无限读进内存 */
const MAX_PROVIDER_BYTES = 8 * 1024 * 1024;
/**
 * **上游转发的默认超时**（与页面临时通道那个 `--timeout` 分开，别混）。
 * 10s 对模型请求太短：DeepSeek 的 V4 模型默认带思考模式，一次带 61 个工具 schema 的请求
 * 十几秒很常见 —— 早先共用 `--timeout`（10s）时，用户第一次真实调用基本必然撞
 * `504 provider-timeout`（实测：`{"ok":false,"error":"provider-timeout","detail":"10000ms"}`）。
 */
const DEFAULT_PROVIDER_TIMEOUT_MS = 60000;
/** 只有这些主机能收到**环境变量那把 key**（§3.7 的安全红线：环境 key 只能发往已知 provider） */
const ENV_KEY_HOSTS = new Set(["api.deepseek.com", "api.openai.com"]);
/** 注入脚本的锚点：优先插在应用 bundle 之前（桥必须在 ai-serve 之前就位） */
const APP_SCRIPT_TAG = '<script src="js/app.js"></script>';
const INJECT_ID = "pc-shell-bridge";
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

// ------------------------------------------------------------------ 参数

const opts = {
  port: 8787,
  token: "",
  timeoutMs: DEFAULT_TIMEOUT_MS,
  open: true,
  browser: "",
  verbose: false,
  help: false,
  // ---- provider 转发（`/provider/*`，P8/W1：docs/PLAN-ai.md §3.7.2）----
  /** 显式给的转发 key（**最高优先级**，argv 覆盖 env）；绝不写进 banner 全文，只打印尾 4 位 */
  providerKey: "",
  providerBase: DEFAULT_PROVIDER_BASE,
  providerModel: DEFAULT_PROVIDER_MODEL,
  /** 上游转发超时（`--provider-timeout` / `PC_SHELL_PROVIDER_TIMEOUT`）；与 `timeoutMs` 分开 */
  providerTimeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
  providerProxy: true,
  /** 环境变量里那把 key 的名字（`""` = 没有）：由 `resolveProviderKey` 填，只用于诊断文案 */
  providerKeyEnvName: "",
};

/**
 * provider key 的来源与优先级（§3.7.4 的定稿）：
 *   ① `--provider-key`（CLI，最高）；
 *   ② 环境变量 `DEEPSEEK_API_KEY` → `OPENAI_API_KEY` → `PC_AI_KEY`（第一个非空即用）。
 *
 * 注意与**已有**的 `AI_TOKEN` 区分：`AI_TOKEN` 是**壳 ↔ 页面的通道 token**，不是 provider 的 key，
 * 两者**不得混用**（所以这里不把 `AI_TOKEN` 当别名，`--provider-key` 也不接受它）。
 *
 * 判定时机：**壳启动时读一次**，之后不再重读 —— 改了环境变量要重启壳（这句也写进 `--help`）。
 */
function resolveProviderKey(cliKey) {
  const given = String(cliKey ?? "").trim();
  if (given) return { key: given, envName: "" };
  for (const name of PROVIDER_KEY_ENV) {
    const v = String(process.env[name] ?? "").trim();
    if (v) return { key: v, envName: name };
  }
  return { key: "", envName: "" };
}

/** key 的脱敏尾巴（**唯一**允许出现在日志 / banner 里的形态）；没有 key 时回空串 */
function providerKeyTail() {
  return opts.providerKey ? "…" + opts.providerKey.slice(-4) : "";
}

/** 诊断用的一句话（绝不含 key 明文） */
function providerKeySource() {
  if (!opts.providerKey) return "none";
  if (opts.providerKeyEnvName) return "env:" + opts.providerKeyEnvName;
  return "cli";
}

/** `keySource` 的三档（§3.7.2 的响应契约）：`env` / `cli` / `none` */
function providerKeySourceKind() {
  if (!opts.providerKey) return "none";
  return opts.providerKeyEnvName ? "env" : "cli";
}

/**
 * **把自己那把 key 从任何要写回页面的文本里擦掉**（P15 第 2 项，评审的对抗实测）。
 *
 * 为什么必须有：壳对 provider 响应是**原样透传**（§3.7.2），而 provider 完全可能在错误体里
 * 把收到的 `Authorization` 回显出来（评审的假 provider 就是这么干的）；页面又会把 4xx body
 * 前 120 字拼进错误行 → 环境 key 明文进了页面 DOM，直接打破本轮核心承诺「key 不进页面」。
 *
 * 覆盖三种形态（都大小写不敏感、容忍空格 / 冒号周围空白）：
 *   ① `Bearer <key>`；② `"authorization":"Bearer <key>"` 这类 JSON 里的（由 ① 覆盖）；
 *   ③ 裸 key（不带前缀也会被回显，例如 `api key: <key> is invalid`）。
 * 打码成 `…` + 尾 4 位 —— 与 banner / 诊断里的 `providerKeyTail()` **同一形态**，
 * 所以「页面看到的内容」与「日志能看到的」严格一致，不多泄漏一位。
 *
 * 只动 key 相关的那几个字节，其它字段（`choices` / `error.message` …）一字不改，
 * 所以 §3.7.2 的「透传」承诺在除「key 不回显」之外的部分完全保留。
 */
function scrubProviderKey(text) {
  const key = String(opts.providerKey || "");
  if (!key) return text;
  const mask = "…" + key.slice(-4);
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return String(text)
    .replace(new RegExp("\\bbearer\\s+" + esc, "gi"), "Bearer " + mask)
    .replace(new RegExp(esc, "gi"), mask);
}

function toInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** provider 基地址只允许 http(s)，且**不带查询 / 片段**（转发时我们自己拼路径） */
function validProviderBase(raw) {
  try {
    const u = new URL(String(raw));
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    if (u.search || u.hash) return false;
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  // 环境变量先读、argv 覆盖（与 pc-mcp.mjs / ai-server.mjs 同风格）
  if (process.env.AI_PORT) opts.port = toInt(process.env.AI_PORT, 8787);
  if (process.env.AI_TOKEN) opts.token = String(process.env.AI_TOKEN).trim();
  if (process.env.PC_SHELL_TIMEOUT) opts.timeoutMs = toInt(process.env.PC_SHELL_TIMEOUT, DEFAULT_TIMEOUT_MS);
  if (process.env.PC_SHELL_PROVIDER_TIMEOUT) opts.providerTimeoutMs = toInt(process.env.PC_SHELL_PROVIDER_TIMEOUT, DEFAULT_PROVIDER_TIMEOUT_MS);
  if (process.env.PC_SHELL_NO_OPEN) opts.open = false;
  if (process.env.PC_SHELL_BROWSER) opts.browser = String(process.env.PC_SHELL_BROWSER);
  // provider 侧：环境变量先读，下面的 argv 覆盖
  if (process.env.PC_SHELL_PROVIDER_BASE) opts.providerBase = String(process.env.PC_SHELL_PROVIDER_BASE).trim();
  if (process.env.PC_SHELL_PROVIDER_MODEL) opts.providerModel = String(process.env.PC_SHELL_PROVIDER_MODEL).trim();
  if (process.env.PC_SHELL_NO_PROVIDER_PROXY) opts.providerProxy = false;
  const envKey = resolveProviderKey("");
  opts.providerKey = envKey.key;
  opts.providerKeyEnvName = envKey.envName;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => (i + 1 < argv.length ? argv[++i] : "");
    if (a === "--port" || a === "-p") opts.port = toInt(next(), NaN);
    else if (a === "--token" || a === "-t") opts.token = next().trim();
    else if (a === "--timeout") opts.timeoutMs = toInt(next(), NaN);
    else if (a === "--no-open" || a === "--no-browser") opts.open = false;
    else if (a === "--browser") opts.browser = next();
    else if (a === "--provider-key") { const k = resolveProviderKey(next()); opts.providerKey = k.key; opts.providerKeyEnvName = k.envName; }
    else if (a === "--provider-base") opts.providerBase = next().trim();
    else if (a === "--provider-model") opts.providerModel = next().trim();
    else if (a === "--provider-timeout") opts.providerTimeoutMs = toInt(next(), NaN);
    else if (a === "--no-provider-proxy") opts.providerProxy = false;
    else if (a === "--verbose" || a === "-v") opts.verbose = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else {
      console.log("未知参数：" + a);
      opts.help = true;
    }
  }
  // 基地址不合法（不是 http(s) / 带查询串）就回默认：宁可指回官方地址，也不要转发到一个奇怪的 URL
  if (!validProviderBase(opts.providerBase)) {
    console.log("⚠ --provider-base 不合法（要 http(s) 且不带查询串）：" + opts.providerBase + " → 回默认 " + DEFAULT_PROVIDER_BASE);
    opts.providerBase = DEFAULT_PROVIDER_BASE;
  }
  // 安全红线（§3.7）：**环境变量里那把 key 只发往已知 provider 主机，且必须是 https**。
  // 显式 `--provider-key` 是用户自己敲的、他自己担责的转发行（本机假 provider / 自建网关的自测都靠它），
  // 所以它不受这道闸门限制 —— 这道闸门护的是「用户设了一次 DEEPSEEK_API_KEY，结果被转发到自己不认识的
  // 主机上 / 被明文发出去」这种他最不可能预料到的情况。没有 key 时转发本来也只会回 409，不必额外关掉。
  //
  // 为什么协议也要查（P15 第 4 项，评审探针实测）：只查 hostname 的话
  // `--provider-base http://api.deepseek.com:8080` 会**通过**闸门，然后把环境 key 明文
  // 发到那个明文端口上。所以 env 来源额外要求 `https:`（与主机不匹配的情形**同构**地关掉转发，
  // 并在 banner 讲明原因）。
  if (opts.providerProxy && opts.providerKey && opts.providerKeyEnvName) {
    const base = new URL(opts.providerBase);
    const hostOk = ENV_KEY_HOSTS.has(base.hostname);
    const protoOk = base.protocol === "https:";
    if (!hostOk || !protoOk) {
      console.log("⚠ 环境变量里的 provider key（" + opts.providerKeyEnvName + "）只发往已知 provider（" +
        [...ENV_KEY_HOSTS].join(" / ") + "）且必须是 https，而 --provider-base 是 " + opts.providerBase +
        (hostOk ? "（协议不是 https，key 会明文出网）" : "（主机不在白名单）") +
        "：为安全起见**关掉** /provider/* 转发");
      console.log("   要在本机假 provider / 自建网关上自测，用显式 --provider-key <k>（它不受这道闸门限制），" +
        "或者干脆 --no-provider-proxy 并在页面里手填 key");
      opts.providerProxy = false;
    }
  }
}

function usage() {
  console.log([
    "用法：node toolchain/pc-shell.mjs [--port 8787] [--token <hex>] [--timeout 10000] [--no-open] [--browser <exe>] [--verbose]",
    "      [--provider-key <k>] [--provider-base <url>] [--provider-model <m>] [--provider-timeout 60000] [--no-provider-proxy]",
    "环境变量：AI_PORT / AI_TOKEN / PC_SHELL_TIMEOUT / PC_SHELL_NO_OPEN / PC_SHELL_BROWSER（命令行参数优先）",
    "          provider key：--provider-key 优先，其次 DEEPSEEK_API_KEY / OPENAI_API_KEY / PC_AI_KEY",
    "          /provider/* 转发：PC_SHELL_PROVIDER_BASE / PC_SHELL_PROVIDER_MODEL / PC_SHELL_PROVIDER_TIMEOUT / PC_SHELL_NO_PROVIDER_PROXY",
    "",
    "一个进程同时给：静态站点（app2/www）+ AI 工具服务入口（GET /ai/health · POST /ai）+ 把请求",
    "转发进窗口页面的通道 + 应用内助手的**同源模型代理**（GET /provider/config · POST /provider/chat）。",
    "只绑 127.0.0.1；token 未指定时才随机生成并打印（--token / AI_TOKEN 可以固定）。",
    "",
    "AI 入口默认是关的（与 APK 一致）：在窗口里 设置 → AI → 打开「本地服务」才会开始受理请求；",
    "档位 read 只能读，要改画面得选 draw（可在设置里关）或 all。",
    "",
    "/provider/* 是「应用内助手」用的那一条（与上面的 AI 工具入口是两件事）：壳从**环境变量**",
    "读一把 provider key（DEEPSEEK_API_KEY 优先），页面只拿一个 hasEnvKey 布尔 + 公开的端点/模型名，",
    "key 一个字节都不进页面。**读一次就定住**：改了环境变量要重启壳才生效。",
    "  · key 只发往已知 provider（api.deepseek.com / api.openai.com）；换了 --provider-base 会自动关掉转发；",
    "  · 日志与 banner 只打 key 的尾 4 位，绝不打印明文；",
    "  · 页面手填了 key 时不走这条（页面直连，与从前完全一致）。",
    "",
    "MCP 宿主（Claude Desktop 等）指到**同一个端口**（详见 toolchain/pc-mcp.mjs）：",
    '{ "mcpServers": { "pixelcraft": { "command": "node",',
    '    "args": ["<仓库绝对路径>\\\\toolchain\\\\pc-mcp.mjs", "--port", "8787"],',
    '    "env": { "AI_TOKEN": "<壳启动时打印的 token>" } } } }',
    "",
    "自测（无头）：node toolchain/pc-shell.mjs --port 8901 --no-open",
    "           msedge --headless=new --remote-debugging-port=9222 http://127.0.0.1:8901/",
    "           curl.exe -s -H \"Authorization: Bearer <token>\" http://127.0.0.1:8901/ai/health",
    "           curl.exe -s http://127.0.0.1:8901/provider/config",
    "",
    "关掉壳：Ctrl+C（会先请页面收尾回合再释放端口）；脚本里也可以 POST /shell/shutdown（同样带 token）。",
  ].join("\n"));
}

// ------------------------------------------------------------------ 状态

// **参数必须在这里就解析**（不能等到 main()）：下面 `TOKEN` 是**模块顶层**求值的，早先 parseArgs 只在
// main() 里调用（文件末尾），于是顶层读到的 `opts` 永远是初始值 —— `--token <hex>` 与 `AI_TOKEN=<hex>`
// 被静默吞掉，壳永远打印随机 token（与 --help / banner / 文件头承诺的「可以固定 token」自相矛盾）。
// 顺序约定：**任何**顶层求值要读 opts 的代码，都必须排在这一行之后。
parseArgs(process.argv.slice(2));

const TOKEN = opts.token || randomBytes(16).toString("hex"); // 与 ai-serve.randomToken() 同形状（32 位十六进制）
/** 页面侧的 SSE 订阅（通常正好 1 个；页面刷新期间会短暂有两个） */
const subs = new Set();
/** 未决请求：requestId → { res, timer, settled, label }；只认第一次交付（§24.2） */
const pending = new Map();
/** 应用里「本地服务」开着没有（页面调 /shell/start 才开；/shell/stop 关） */
let aiEnabled = false;
/** 应用设置里的 ai.port 与壳端口不一致时另绑的「只服务 AI 入口」监听 */
let extraServer = null;
let extraPort = 0;
let shuttingDown = false;

const stats = {
  aiRequests: 0,
  aiAnswered: 0,
  aiTimeouts: 0,
  aiRefusedNoSub: 0,
  aiRefusedOff: 0,
  replies: 0,
  duplicateReplies: 0,
  handshakes: 0,
  staticFiles: 0,
  startedAt: Date.now(),
  providerCalls: 0,
  providerRefused: 0,
  providerErrors: 0,
  providerTimeouts: 0,
};

function log(msg) {
  console.log("[pc-shell] " + msg);
}

function vlog(msg) {
  if (opts.verbose) log(msg);
}

function tokenTail() {
  return "…" + TOKEN.slice(-4);
}

function baseUrl() {
  return "http://" + HOST + ":" + opts.port;
}

// ------------------------------------------------------------------ HTTP 小工具

function json(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  const head = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  };
  if (extraHeaders) for (const k of Object.keys(extraHeaders)) head[k] = extraHeaders[k];
  if (res.headersSent) return;
  res.writeHead(status, head);
  res.end(body);
}

/** 401：与 AiServer.java 一样带 WWW-Authenticate（客户端据此知道要 Bearer） */
function unauthorized(res) {
  json(res, 401, { ok: false, error: "unauthorized" }, { "www-authenticate": "Bearer" });
}

/** 常量时间比较（长度不同直接 false，避免泄漏前缀） */
function constEq(a, b) {
  const x = Buffer.from(String(a || ""), "utf8");
  const y = Buffer.from(String(b || ""), "utf8");
  if (x.length !== y.length || x.length === 0) return false;
  try {
    return timingSafeEqual(x, y);
  } catch {
    return false;
  }
}

/** 一次请求的 token：`Authorization: Bearer` / `?token=` / body 里的 token 字段都能给 */
function authOk(req, url, bodyToken) {
  const h = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (constEq(h, TOKEN)) return true;
  if (url && constEq(url.searchParams.get("token") || "", TOKEN)) return true;
  if (constEq(bodyToken || "", TOKEN)) return true;
  return false;
}

/** 读请求 body（上限 1 MiB，超了回 413 并返回 null = 已经答复过了） */
function readBody(req, res) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        const body = JSON.stringify({ ok: false, error: "body-too-large" });
        // 先让响应出网再 destroy（直接 destroy 有可能把响应截断）
        res.writeHead(413, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
        res.end(body, () => {
          try {
            req.destroy();
          } catch {
            /* ignore */
          }
        });
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", () => {
      if (done) return;
      done = true;
      json(res, 400, { ok: false, error: "request-error" });
      resolve(null);
    });
  });
}

function tryJson(text) {
  try {
    const j = JSON.parse(String(text));
    return j && typeof j === "object" && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ 注入的壳桥（内联脚本）
//
// 只有这个壳伺服 index.html 时才会插进去（GitHub Pages / devserver.js 一律没有 → 线上没有 AI）。
// 内容与 src/io/bridge.ts 的 `window.PixelBridge` 声明**逐字对齐**：
//   saveFile / openFile / toast / vibrate / hasVibrator / insets / setImmersive + AI 的四件套。
// 后四个 AI 方法必须是**同步**返回（ai-serve 的契约：`aiServerStart` 同步回 token、`aiRespond` 同步
// 回「是不是第一次交付」），所以这里用同步 XHR —— 都是到 127.0.0.1 本进程的小请求（毫秒级）。
//
// 另外注册一个 `window.__pc_ai_call` **兜底**：真业务由页面的 ai-serve 接管（`installAiServe()` 会把
// `window.__pc_ai_call` 换成 `aiServeHandleCall`）；兜底只在「页面里还没有处理者」时被通道泵用到，
// 按 §24 的期待返回**一行 JSON 字符串**（绝不返回 Promise —— 宿主会判 `js-async-unsupported`）。
function bridgeSource(port, timeoutMs) {
  return [
    "(function () {",
    '  "use strict";',
    "  if (window.__pcShell) return;",
    "  var PORT = " + JSON.stringify(port) + ", TIMEOUT = " + JSON.stringify(timeoutMs) + ";",
    "  var state = { token: '', running: false, port: 0, extra: false, ai: false, jobs: 0, replies: 0, replyFailures: 0, lastError: '' };",
    "",
    "  function post(path, text) {",
    "    try {",
    "      var x = new XMLHttpRequest();",
    "      x.open('POST', path, false);",
    "      x.setRequestHeader('content-type', 'application/json; charset=utf-8');",
    "      if (state.token) x.setRequestHeader('authorization', 'Bearer ' + state.token);",
    "      x.send(text);",
    "      return x.responseText;",
    "    } catch (e) { state.lastError = path + ': ' + e; return null; }",
    "  }",
    "  function jparse(t) { try { return JSON.parse(t); } catch (e) { return null; } }",
    "",
    "  // 握手：拿通道 token（壳**不把 token 写进 HTML**，运行时现取）。失败不抛，等上层重试。",
    "  function handshake() {",
    "    var j = jparse(post('/shell/handshake', '{}'));",
    "    if (!j || !j.token) return false;",
    "    state.token = String(j.token);",
    "    state.port = Number(j.port) || PORT;",
    "    state.ai = j.ai === true;",
    "    return true;",
    "  }",
    "",
    "  // 页面 → 壳：交付结果。返回 true = 壳收下了（第一次）；false = 超时 / 已交付过（只记诊断，不重试）",
    "  function reply(requestId, json, noHandler) {",
    "    var out = jparse(post('/shell/reply', JSON.stringify({ requestId: requestId, json: json, noHandler: noHandler === true })));",
    "    if (out && out.ok === true) { state.replies++; return true; }",
    "    state.replyFailures++;",
    "    return false;",
    "  }",
    "",
    "  // ---------------- 通道：SSE（为什么选它见壳源码的文件头） ----------------",
    "  var es = null;",
    "  function subscribe() {",
    "    if (!state.token || typeof EventSource !== 'function') return;",
    "    try { if (es) es.close(); } catch (e) {}",
    "    try {",
    "      es = new EventSource('/shell/events?token=' + encodeURIComponent(state.token));",
    "      es.addEventListener('job', onJob);",
    "      es.addEventListener('state', onState);",
    "      es.addEventListener('shutdown', onShutdown);",
    "      es.onerror = function () { /* EventSource 自己按 retry: 1000 重连 */ };",
    "    } catch (e) { state.lastError = 'subscribe: ' + e; }",
    "  }",
    "",
    "  function onJob(ev) {",
    "    var job = jparse(ev.data);",
    "    if (!job || !job.requestId) return;",
    "    state.jobs++;",
    "    var fn = window.__pc_ai_call;",
    "    if (!fn || fn.__pcShellFallback === true) {",
    "      // 页面里还没有 ai-serve（应用没引导完 / 这个页面没有 AI 业务）：壳按 503 js-not-ready 回",
    "      reply(job.requestId, JSON.stringify({ ok: false, error: 'js-not-ready' }), true);",
    "      return;",
    "    }",
    "    var out = '';",
    "    try {",
    "      out = fn(job.envelope, job.requestId);",
    "    } catch (e) {",
    "      out = JSON.stringify({ ok: false, error: 'page threw: ' + (e && e.message ? e.message : String(e)) });",
    "    }",
    "    if (typeof out === 'string' && out !== '') { reply(job.requestId, out, false); return; }",
    "    // 空串 = 挂起（§24.2）：业务稍后用 PixelBridge.aiRespond(requestId, json) 交付",
    "  }",
    "",
    "  function onState(ev) {",
    "    var j = jparse(ev.data);",
    "    if (j) state.ai = j.ai === true;",
    "  }",
    "",
    "  function onShutdown() {",
    "    // 壳要退了：请页面走它自己的收尾路径（回合 rollback + 停服务），别把 History 的影子留下",
    "    try { if (window.__pcAi && typeof window.__pcAi.stop === 'function') window.__pcAi.stop(); } catch (e) {}",
    "  }",
    "",
    "  // ---------------- PixelBridge（字段与 src/io/bridge.ts 的声明逐字对齐） ----------------",
    "  window.PixelBridge = Object.assign(window.PixelBridge || {}, {",
    "    // 与 APK 同形：**同步**返回 token，绑定失败回 ''（页面据此判 bind-failed）",
    "    aiServerStart: function (port) {",
    "      if (!state.token && !handshake()) return '';",
    "      var p = Math.round(Number(port) || PORT);",
    "      var j = jparse(post('/shell/start', JSON.stringify({ port: p })));",
    "      if (!j || !j.token) { state.running = false; state.extra = false; return ''; }",
    "      state.token = String(j.token);",
    "      state.running = true;",
    "      state.port = Number(j.port) || p;",
    "      state.extra = j.extra === true;",
    "      state.ai = true;",
    "      subscribe();",
    "      return state.token;",
    "    },",
    "    aiServerStop: function () {",
    "      state.running = false;",
    "      state.extra = false;",
    "      state.ai = false;",
    "      post('/shell/stop', '{}');",
    "    },",
    "    // '{\"running\":bool,\"port\":N,\"token\":\"…\"}'（APK 里是 Java 侧的实况；这里同样如实报）",
    "    aiServerStatus: function () {",
    "      return JSON.stringify({ running: state.running === true, port: state.running ? state.port : 0, token: state.token });",
    "    },",
    "    aiRespond: function (requestId, json) { return reply(String(requestId), String(json), false); },",
    "",
    "    // 下面这几个是 bridge.ts 声明面里**不能缺**的：bridge.ts 见到 window.PixelBridge 就一律走",
    "    // 桥接分支（`if (b) b.saveFile(...)`），缺一个就会让导出 / 导入直接抛。桌面窗口里按浏览器",
    "    // 的做法实现（下载 / 文件选择 + 同名的 pcsave / pcopen 事件），语义与 bridge.ts 的无桥兜底一致。",
    "    toast: function (msg) {",
    "      try { window.dispatchEvent(new CustomEvent('pc-toast', { detail: String(msg) })); } catch (e) {}",
    "    },",
    "    vibrate: function () { return false; },   // 桌面没有马达；bridge.ts 会再试 navigator.vibrate",
    "    hasVibrator: function () { return false; },",
    "    insets: function () { return '0,0,0,0'; }, // 桌面窗口没有安全区",
    "    setImmersive: function () {},",
    "    saveFile: function (name, mime, base64, reqId) {",
    "      var ok = false;",
    "      try {",
    "        var bin = atob(String(base64 || ''));",
    "        var bytes = new Uint8Array(bin.length);",
    "        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);",
    "        var url = URL.createObjectURL(new Blob([bytes], { type: mime || 'application/octet-stream' }));",
    "        var a = document.createElement('a');",
    "        a.href = url;",
    "        a.download = String(name || 'pixelcraft.bin');",
    "        document.body.appendChild(a);",
    "        a.click();",
    "        a.remove();",
    "        setTimeout(function () { URL.revokeObjectURL(url); }, 600);",
    "        ok = true;",
    "      } catch (e) { state.lastError = 'saveFile: ' + e; }",
    "      try { window.dispatchEvent(new CustomEvent('pcsave', { detail: { ok: ok, reqId: String(reqId || '') } })); } catch (e) {}",
    "    },",
    "    openFile: function (mime) {",
    "      try {",
    "        var inp = document.createElement('input');",
    "        inp.type = 'file';",
    "        inp.accept = mime || '*/*';",
    "        inp.onchange = function () {",
    "          var f = inp.files && inp.files[0];",
    "          if (!f) { window.dispatchEvent(new CustomEvent('pcopen', { detail: { ok: false } })); return; }",
    "          var fr = new FileReader();",
    "          fr.onload = function () {",
    "            var bytes = new Uint8Array(fr.result), bin = '', CH = 0x8000;",
    "            for (var i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));",
    "            window.dispatchEvent(new CustomEvent('pcopen', { detail: { ok: true, name: f.name, mime: f.type || mime || '', data: btoa(bin) } }));",
    "          };",
    "          fr.onerror = function () { window.dispatchEvent(new CustomEvent('pcopen', { detail: { ok: false } })); };",
    "          fr.readAsArrayBuffer(f);",
    "        };",
    "        inp.click();",
    "      } catch (e) { state.lastError = 'openFile: ' + e; }",
    "    }",
    "  });",
    "",
    "  // ---------------- __pc_ai_call 兜底（真业务由页面的 ai-serve 接管） ----------------",
    "  var fallback = function (envelopeJson, requestId) {",
    "    // 把请求转成一次 /shell/... 请求，拿回一行 JSON 字符串（同步，绝不返回 Promise）",
    "    var out = post('/shell/no-handler', JSON.stringify({ envelope: String(envelopeJson), requestId: String(requestId) }));",
    "    return out == null ? JSON.stringify({ ok: false, error: 'js-not-ready' }) : out;",
    "  };",
    "  fallback.__pcShellFallback = true;",
    "  window.__pc_ai_call = fallback;",
    "",
    "  // 诊断入口（页面控制台 / 自测脚本用；不带明文 token）",
    "  window.__pcShell = {",
    "    info: function () {",
    "      return {",
    "        port: PORT, timeoutMs: TIMEOUT, tokenTail: state.token ? state.token.slice(-4) : '',",
    "        ai: state.ai === true, running: state.running === true, runningPort: state.port, extra: state.extra === true,",
    "        jobs: state.jobs, replies: state.replies, replyFailures: state.replyFailures, lastError: state.lastError,",
    "      };",
    "    },",
    "  };",
    "",
    "  handshake();",
    "  subscribe();",
    "})();",
  ].join("\n");
}

/**
 * 注入脚本**必须等参数解析完再生**（早先写成模块级常量，注入进去的 PORT/TIMEOUT 是默认值 8787/10000，
 * 换个 `--port` 启动时页面里的兜底常量就与实际端口不一致）。第一次伺服 index.html 时才生成，之后缓存。
 */
let bridgeTag = "";
function bridgeTagOf() {
  if (!bridgeTag) bridgeTag = '<script id="' + INJECT_ID + '">' + bridgeSource(opts.port, opts.timeoutMs) + "</script>";
  return bridgeTag;
}

/** 只在伺服 index.html 时注入（Pages / 任何普通静态服务都不会有这段） */
function injectBridge(html) {
  if (html.indexOf(INJECT_ID) >= 0) return html; // 已经被注过（例如页面是构建产物里的旧壳）
  const tag = "\n" + bridgeTagOf() + "\n";
  if (html.indexOf(APP_SCRIPT_TAG) >= 0) return html.replace(APP_SCRIPT_TAG, tag + APP_SCRIPT_TAG);
  if (html.indexOf("</body>") >= 0) return html.replace("</body>", tag + "</body>");
  vlog("⚠ index.html 里找不到注入锚点（js/app.js 或 </body>），这一份按原样伺服");
  return html;
}

// ------------------------------------------------------------------ 静态站点

function routeStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    json(res, 405, { ok: false, error: "method-not-allowed" }, { allow: "GET" });
    return;
  }
  const rel = pathname === "/" ? "/index.html" : pathname;
  const file = path.normalize(path.join(WWW, decodeURIComponent(rel)));
  if (file !== WWW && !file.startsWith(WWW + path.sep)) {
    json(res, 403, { ok: false, error: "forbidden" });
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      json(res, 404, { ok: false, error: "not-found" });
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const isIndex = path.basename(file) === "index.html";
    const body = isIndex ? Buffer.from(injectBridge(data.toString("utf8")), "utf8") : data;
    stats.staticFiles++;
    if (res.headersSent) return;
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "content-length": body.length,
      "cache-control": "no-store", // 桌面壳永远伺服仓库里当前那份文件（改完刷新就生效）
    });
    res.end(req.method === "HEAD" ? undefined : body);
  });
}

// ------------------------------------------------------------------ 通道（SSE）

function newestSubscriber() {
  let last = null;
  for (const s of subs) last = s; // Set 保持插入序 → 最后一个就是最近订阅的那个
  return last;
}

function writeEvent(res, name, obj) {
  try {
    res.write("event: " + name + "\ndata: " + JSON.stringify(obj) + "\n\n");
  } catch {
    /* 连接已断：由 close 事件把它摘掉 */
  }
}

/** 只推给**最近**订阅的那个页面：避免两个窗口同时执行同一次 call_tool（会画两遍） */
function pushJob(job) {
  const sub = newestSubscriber();
  if (!sub) return false;
  writeEvent(sub, "job", job);
  return true;
}

function broadcast(name, obj) {
  for (const s of subs) writeEvent(s, name, obj);
}

function routeEvents(req, res, url) {
  if (req.method !== "GET") {
    json(res, 405, { ok: false, error: "method-not-allowed" }, { allow: "GET" });
    return;
  }
  if (!authOk(req, url)) {
    unauthorized(res);
    return;
  }
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write("retry: 1000\n\n"); // 页面刷新 / 断线后 EventSource 自己按这个间隔重连
  res.write(": connected\n\n");
  subs.add(res);
  log("页面已接入通道（订阅者 " + subs.size + "）" + (aiEnabled ? "" : " · 注意：应用里的 AI 服务还没打开"));
  const hb = setInterval(() => {
    try {
      res.write(": hb\n\n");
    } catch {
      /* ignore */
    }
  }, HEARTBEAT_MS);
  if (typeof hb.unref === "function") hb.unref();

  let dropped = false;
  const drop = () => {
    if (dropped) return; // 'error' 与 'close' 都会来一次，别记两遍 / 别重复收尾
    dropped = true;
    clearInterval(hb);
    subs.delete(res);
    vlog("页面通道断开（订阅者 " + subs.size + "）");
    // 页面断线时保留未决请求？不：执行它的那个页面上下文已经没了，等 10s 只会白等。
    // （页面刷新也走这条路 —— 刷新后新连接会立刻重新订阅，但旧文档里的那次调用确实没了。）
    if (subs.size === 0) failAllPending("js-not-ready（页面通道断开）");
  };
  req.on("close", drop);
  req.on("error", drop);
}

function failAllPending(reason) {
  for (const [id, item] of pending) {
    if (item.settled) continue;
    settlePending(id, 503, JSON.stringify({ ok: false, error: reason }));
  }
}

// ------------------------------------------------------------------ AI 入口（§24）

function settlePending(requestId, status, body) {
  const item = pending.get(requestId);
  if (!item || item.settled) return false;
  item.settled = true;
  clearTimeout(item.timer);
  pending.delete(requestId);
  stats.aiAnswered++;
  vlog("交付 " + item.label + " → " + status + " " + (body.length > 160 ? body.slice(0, 160) + "…" : body));
  try {
    if (!item.res.headersSent) {
      item.res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(body),
      });
    }
    item.res.end(body);
  } catch {
    /* 客户端已经断开：账本清了就行 */
  }
  return true;
}

async function routeAi(req, res, pathname) {
  const wantMethod = pathname === "/ai/health" ? "GET" : "POST";
  if (req.method !== wantMethod) {
    json(res, 405, { ok: false, error: "method-not-allowed" }, { allow: wantMethod });
    return;
  }
  if (!authOk(req)) {
    vlog("AI 请求被拒：token 不匹配（" + req.method + " " + pathname + "）");
    unauthorized(res);
    return;
  }
  const body = wantMethod === "POST" ? await readBody(req, res) : "";
  if (body === null) return; // 413 已经答复过

  if (!aiEnabled) {
    stats.aiRefusedOff++;
    json(res, 503, {
      ok: false,
      error: "ai-off: 应用里还没打开本地服务（设置 → AI → 打开「本地服务」，档位选 draw / all 才能改画面）",
    });
    return;
  }
  if (subs.size === 0) {
    stats.aiRefusedNoSub++;
    // 页面没起来 = 桥上没有 __pc_ai_call：§24 的 js-not-ready（503），别让调用方等 10s
    json(res, 503, { ok: false, error: "js-not-ready" });
    return;
  }

  const requestId = randomUUID();
  const envelope = JSON.stringify({ method: req.method, path: pathname, body });
  stats.aiRequests++;
  const timer = setTimeout(() => {
    if (pending.has(requestId)) {
      stats.aiTimeouts++;
      log("⚠ 页面 " + opts.timeoutMs + "ms 内没回（" + req.method + " " + pathname + "），回 timeout");
      settlePending(requestId, 503, JSON.stringify({ ok: false, error: "timeout" }));
    }
  }, opts.timeoutMs);
  if (typeof timer.unref === "function") timer.unref();
  pending.set(requestId, {
    res,
    timer,
    settled: false,
    label: req.method + " " + pathname + " " + requestId.slice(0, 8),
  });
  vlog("转发 " + req.method + " " + pathname + " → 页面（" + requestId.slice(0, 8) + "，未决 " + pending.size + "）");
  if (!pushJob({ requestId, envelope })) {
    // 极端竞态：刚检查完订阅者就断了
    settlePending(requestId, 503, JSON.stringify({ ok: false, error: "js-not-ready" }));
  }
}

/** 只服务 AI 入口的备用监听（应用设置里的 ai.port 与壳端口不一致时才绑） */
function createAiOnlyServer() {
  return http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url || "/", baseUrl());
    } catch {
      json(res, 400, { ok: false, error: "bad-url" });
      return;
    }
    if (url.pathname === "/ai/health" || url.pathname === "/ai") {
      void routeAi(req, res, url.pathname);
      return;
    }
    json(res, 404, { ok: false, error: "not-found" });
  });
}

// ------------------------------------------------------------------ 壳自己的端点

async function routeHandshake(req, res) {
  if (req.method !== "POST") {
    json(res, 405, { ok: false, error: "method-not-allowed" }, { allow: "POST" });
    return;
  }
  const body = await readBody(req, res);
  if (body === null) return;
  stats.handshakes++;
  vlog("握手（页面取通道 token）");
  json(res, 200, { ok: true, token: TOKEN, port: opts.port, timeoutMs: opts.timeoutMs, ai: aiEnabled });
}

async function routeReply(req, res) {
  if (req.method !== "POST") {
    json(res, 405, { ok: false, error: "method-not-allowed" }, { allow: "POST" });
    return;
  }
  const raw = await readBody(req, res);
  if (raw === null) return;
  const j = tryJson(raw);
  if (!j) {
    json(res, 400, { ok: false, error: "bad-json" });
    return;
  }
  if (!authOk(req, null, j.token)) {
    unauthorized(res);
    return;
  }
  const id = String(j.requestId || "");
  const item = pending.get(id);
  if (!item || item.settled) {
    // §24.2：**只认第一次**。超时之后 / 重复交付一律 false，页面只记诊断、不重试。
    stats.duplicateReplies++;
    json(res, 200, { ok: false, error: item ? "already-settled" : "unknown-or-expired-request" });
    return;
  }
  stats.replies++;
  if (j.noHandler === true) {
    // 页面活着但里面还没有 __pc_ai_call（应用没装 ai-serve）→ 与 APK 的 js-not-ready 同口径
    settlePending(id, 503, JSON.stringify({ ok: false, error: "js-not-ready" }));
  } else {
    const text = typeof j.json === "string" ? j.json : "";
    // 空串按 MainActivity 的 AI_ERR_EMPTY 处理（那边也是空 → empty-response）
    settlePending(id, 200, text.trim() === "" ? JSON.stringify({ ok: false, error: "empty-response" }) : text);
  }
  json(res, 200, { ok: true });
}

async function routeStart(req, res) {
  if (req.method !== "POST") {
    json(res, 405, { ok: false, error: "method-not-allowed" }, { allow: "POST" });
    return;
  }
  const raw = await readBody(req, res);
  if (raw === null) return;
  const j = tryJson(raw) || {};
  if (!authOk(req, null, j.token)) {
    unauthorized(res);
    return;
  }
  const want = toInt(j.port, NaN);
  if (!Number.isInteger(want) || want < 1024 || want > 65535) {
    json(res, 200, { ok: true, token: "", port: 0, extra: false, error: "bad-port" });
    return;
  }
  aiEnabled = true;
  if (want === opts.port) {
    log("页面启用了 AI 入口（127.0.0.1:" + opts.port + "；档位由页面的 ai.tier 决定）");
    broadcast("state", { ai: true, port: opts.port });
    json(res, 200, { ok: true, token: TOKEN, port: opts.port, extra: false });
    return;
  }
  // 应用设置里的 ai.port 与壳端口不同：另绑一个只服务 AI 入口的监听（静态站点仍在壳端口上）
  if (extraServer && extraPort === want) {
    json(res, 200, { ok: true, token: TOKEN, port: want, extra: true });
    return;
  }
  if (extraServer) {
    try {
      extraServer.close();
    } catch {
      /* ignore */
    }
    extraServer = null;
    extraPort = 0;
  }
  const srv = createAiOnlyServer();
  const ok = await new Promise((resolve) => {
    srv.once("error", (e) => {
      log("⚠ 另绑 127.0.0.1:" + want + " 失败：" + (e && e.message ? e.message : String(e)));
      resolve(false);
    });
    srv.listen(want, HOST, () => resolve(true));
  });
  if (!ok) {
    json(res, 200, { ok: true, token: "", port: want, extra: false, error: "bind-failed" });
    return;
  }
  extraServer = srv;
  extraPort = want;
  log("应用设置里的 ai.port=" + want + " 与壳端口不同，已另绑一个只服务 AI 入口的监听：http://127.0.0.1:" + want + "/ai");
  broadcast("state", { ai: true, port: want });
  json(res, 200, { ok: true, token: TOKEN, port: want, extra: true });
}

async function routeStop(req, res) {
  if (req.method !== "POST") {
    json(res, 405, { ok: false, error: "method-not-allowed" }, { allow: "POST" });
    return;
  }
  const raw = await readBody(req, res);
  if (raw === null) return;
  const j = tryJson(raw) || {};
  if (!authOk(req, null, j.token)) {
    unauthorized(res);
    return;
  }
  aiEnabled = false;
  if (extraServer) {
    const s = extraServer;
    extraServer = null;
    extraPort = 0;
    try {
      s.close();
    } catch {
      /* ignore */
    }
  }
  log("页面关掉了 AI 入口（只关受理，静态站点与通道不动）");
  broadcast("state", { ai: false, port: opts.port });
  json(res, 200, { ok: true });
}

async function routeStatus(req, res, url) {
  if (req.method !== "GET") {
    json(res, 405, { ok: false, error: "method-not-allowed" }, { allow: "GET" });
    return;
  }
  if (!authOk(req, url)) {
    unauthorized(res);
    return;
  }
  json(res, 200, {
    ok: true,
    result: {
      running: aiEnabled, // = 应用里的 ai.server 现在开着没有
      port: opts.port,
      extraPort,
      host: HOST,
      tokenTail: tokenTail(),
      subscribers: subs.size,
      pending: pending.size,
      timeoutMs: opts.timeoutMs,
      uptimeSec: Math.round((Date.now() - stats.startedAt) / 1000),
      // provider 转发：**只报尾 4 位与来源名**，绝不回 key 明文（诊断文本也是「不进 key」的地方）
      provider: {
        proxy: !!opts.providerProxy,
        baseUrl: opts.providerProxy ? opts.providerBase : "",
        defaultModel: opts.providerProxy ? opts.providerModel : "",
        keyTail: providerKeyTail(),
        keySource: providerKeySource(),
      },
      ...stats,
    },
  });
}

/**
 * 让壳干净地退出（与 Ctrl+C **走同一个** `shutdown()`）：
 * 脚本 / 启动器可以先发这一条再等进程结束，免得只能强杀（强杀不会有「请页面收尾回合」这一步）。
 */
async function routeShutdown(req, res) {
  if (req.method !== "POST") {
    json(res, 405, { ok: false, error: "method-not-allowed" }, { allow: "POST" });
    return;
  }
  const raw = await readBody(req, res);
  if (raw === null) return;
  const j = tryJson(raw) || {};
  if (!authOk(req, null, j.token)) {
    unauthorized(res);
    return;
  }
  json(res, 200, { ok: true, note: "shutting down" });
  setTimeout(() => shutdown("HTTP /shell/shutdown"), 30);
}

async function routeNoHandler(req, res) {  if (req.method !== "POST") {
    json(res, 405, { ok: false, error: "method-not-allowed" }, { allow: "POST" });
    return;
  }
  const raw = await readBody(req, res);
  if (raw === null) return;
  log("⚠ 页面里还没有 __pc_ai_call（应用没装 ai-serve 或还没引导完），这条请求回了 js-not-ready");
  json(res, 200, { ok: false, error: "js-not-ready: 页面里还没有 __pc_ai_call（应用没装 ai-serve）" });
}

// ------------------------------------------------------------------ provider 同源代理（§3.7.2，P8/W1）
//
// 为什么这一层在**壳体**而不是页面里（§3.7.2 的定稿）：
//   · 现有 `POST /ai` 通道的协议是 `ai-rpc`（9 个 call、状态码口径、tier 门禁都在 docs/API.md §24），
//     往里塞一个「转发模型请求」的 call 会把两件事糅在一起；转发**纯传输**，与壳现在把 `/ai`
//     转发进页面是同一类工作，放这里不需要动页面里的业务层。
//
// ❗**不要**把「修 CORS」当成本节的目标：§3.7.1 的实测已经证明 DeepSeek 会回 CORS 头、
// `file://` 源也被放行 —— 页面直连是**能**通到 DeepSeek 的。代理的四条真理由是：
//   ① 环境变量那把 key 一个字节都不进页面；② 用户不用手填 key；③ 错误能翻成一句人话；
//   ④ 不再依赖对端 CORS 配置。
// 所以页面里**既有**的直连能力照样保留（手填 key / 非 DeepSeek 端点走它）。
//
// 安全口径（§3.7 的红线，逐条可核）：
//   · **key 只发往已知 provider**：`ENV_KEY_HOSTS` 之外的目标在有 key 时直接关掉转发（见 parseArgs）；
//   · **不接受任意 URL 转发**：目标由 CLI / 环境变量定（`opts.providerBase`），**请求体里没有 URL** 这个字段；
//   · **不跟随重定向**：上游 3xx 原样透传（带上 location），绝不替页面去追；
//   · 只绑 `127.0.0.1`（HOST）+ 沿用既有通道 token 鉴权；body 上限复用 `MAX_BODY_BYTES`，超时复用 `opts.timeoutMs`；
//   · 任何日志 / 错误文案 / 诊断文本里**都没有 key 明文**（只有 `providerKeyTail()` 的尾 4 位）。

/** 转发端点允许的 CORS：只在壳端口上，供同源 / `file://` 双端（APK 侧将来照抄这一段） */
function providerCors(req) {
  const origin = String(req.headers.origin || "").trim();
  return {
    "access-control-allow-origin": origin || "*",
    "access-control-allow-headers": "authorization,content-type,x-shell-token",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "cache-control": "no-store",
    vary: "origin",
  };
}

/** 页面 → 壳的鉴权：优先 `Authorization: Bearer <通道token>`，兼容 `X-Shell-Token`（§3.7.2） */
function providerAuthOk(req, url) {
  if (authOk(req, url)) return true;
  return constEq(String(req.headers["x-shell-token"] || "").trim(), TOKEN);
}

/** 壳回给页面的错误体（`detail` 里**绝不放 key**） */
function providerError(res, req, status, code, detail) {
  json(res, status, { ok: false, error: code, detail: String(detail ?? "") }, providerCors(req));
}

/** 当前转发配置（**绝不含 key 片段**，连尾 4 位都不给；§3.7.2 的响应契约） */
function providerConfigBody() {
  return {
    ok: true,
    proxy: !!opts.providerProxy,
    baseUrl: opts.providerBase,
    defaultModel: opts.providerModel,
    models: [DEFAULT_PROVIDER_MODEL, "deepseek-flash"],
    hasEnvKey: !!opts.providerKey,
    // 上游转发超时（只读的诊断信息；页面不需要它，也不含任何机密）
    providerTimeoutMs: opts.providerTimeoutMs,
    keySource: providerKeySourceKind(),
  };
}

/**
 * `GET /provider/config`：页面探测用。**不要 token**（它不泄漏任何机密，见上），
 * 拿它就当「这个壳有没有代理」的探测点。`--no-provider-proxy` 时回 `proxy:false`（仍是 200），
 * 页面据此回落直连 —— 老壳没有这个端点时是 404，两条路页面都当「没有代理」处理。
 */
async function routeProviderConfig(req, res) {
  if (req.method === "OPTIONS") {
    if (res.headersSent) return;
    res.writeHead(204, providerCors(req));
    res.end();
    return;
  }
  if (req.method !== "GET") {
    json(res, 405, { ok: false, error: "method-not-allowed" }, { allow: "GET", ...providerCors(req) });
    return;
  }
  json(res, 200, providerConfigBody(), providerCors(req));
}

/**
 * 转发一次到 provider（**不改任何字段**，只补 `Authorization`）。用 Node 内置 `https` ——
 * 这个脚本的口径是「零依赖，只用 Node 内置模块」，所以不用全局 fetch。
 *
 * 三件事写死在这里：① `Accept-Encoding: identity`（免去 gzip 解码，透传才是原样）；
 * ② 响应体上限 `MAX_PROVIDER_BYTES`；③ 超时用 `AbortController` 掐断。
 */
/**
 * **本次请求**的上游超时：页面可以在 `X-Provider-Timeout` 头里给一个毫秒值（`ai.chatTimeoutSec` × 1000），
 * 非法 / 缺失 / 非正数一律回退到壳自己的 `--provider-timeout`。夹在 1s..10min ——
 * 页面只能"要求等多久"，不能借这个头表达别的含义。
 */
function requestProviderTimeoutMs(req) {
  const raw = req.headers["x-provider-timeout"];
  const n = Math.round(Number(Array.isArray(raw) ? raw[0] : raw));
  if (!Number.isFinite(n) || n <= 0) return opts.providerTimeoutMs;
  return Math.max(1000, Math.min(600000, n));
}

function forwardToProvider(payload, timeoutMs) {
  const waitMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : opts.providerTimeoutMs;
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(opts.providerBase);
    } catch {
      resolve({ ok: false, kind: "unreachable", detail: "provider 基地址不合法" });
      return;
    }
    const isHttps = target.protocol === "https:";
    const mod = isHttps ? https : http;
    const basePath = target.pathname.replace(/\/+$/, "");
    const full = target.origin + basePath + "/chat/completions";
    const data = Buffer.from(payload, "utf8");
    const req = mod.request(full, {
      method: "POST",
      timeout: waitMs,
      headers: {
        "content-type": "application/json",
        "content-length": data.length,
        authorization: "Bearer " + opts.providerKey,
        "user-agent": "pixelcraft-pc-shell",
        accept: "application/json",
        "accept-encoding": "identity",
      },
    }, (up) => {
      const chunks = [];
      let size = 0;
      let truncated = false;
      up.on("data", (c) => {
        size += c.length;
        if (size > MAX_PROVIDER_BYTES) {
          truncated = true;
          up.destroy();
          return;
        }
        chunks.push(c);
      });
      const done = () => resolve({
        ok: true,
        status: up.statusCode || 502,
        headers: up.headers,
        body: Buffer.concat(chunks).toString("utf8"),
        truncated,
      });
      up.on("end", done);
      up.on("close", done);      // truncated 时 destroy 走 close 而不是 end
      up.on("error", (e) => resolve({ ok: false, kind: "unreachable", detail: String(e && e.message ? e.message : e) }));
    });
    req.on("timeout", () => {
      stats.providerTimeouts++;
      try {
        req.destroy(new Error("timeout"));
      } catch {
        /* ignore */
      }
      resolve({ ok: false, kind: "timeout", detail: waitMs + "ms" });
    });
    req.on("error", (e) => resolve({ ok: false, kind: "unreachable", detail: String(e && e.message ? e.message : e) }));
    req.end(data);
  });
}

/**
 * `POST /provider/chat`：页面 → 壳 → provider，**把 provider 的状态码与 body 原样透传**。
 *
 * 为什么原样透传（§3.7.2）：页面侧的 `httpError()` 按状态分档的文案一行都不用改；
 * `{"error":{"message":…}}` 那条分支也照旧命中。壳只在**自己**这一层出错时（没 key / 连不上 /
 * 超时 / 太大 / token 不对）才换成自己的码，那几档由页面的 `hostError()` 翻成人话。
 *
 * 请求体：OpenAI 兼容原样转发（`{model, messages, tools?, …}`）。**没有 URL 字段** ——
 * 目标地址只由壳的启动参数决定，这从结构上堵死了「拿代理当任意 URL 转发器」。
 */
async function routeProviderChat(req, res, url) {
  if (req.method === "OPTIONS") {
    if (res.headersSent) return;
    res.writeHead(204, providerCors(req));
    res.end();
    return;
  }
  if (req.method !== "POST") {
    json(res, 405, { ok: false, error: "method-not-allowed" }, { allow: "POST", ...providerCors(req) });
    return;
  }
  if (!opts.providerProxy) {
    stats.providerRefused++;
    providerError(res, req, 403, "proxy-off", "--no-provider-proxy（或目标不是已知 provider）");
    return;
  }
  if (!providerAuthOk(req, url)) {
    stats.providerRefused++;
    unauthorized(res);
    return;
  }
  const raw = await readBody(req, res);   // 上限复用 MAX_BODY_BYTES（1 MiB），超了这里已经回 413
  if (raw === null) return;
  if (!opts.providerKey) {
    stats.providerRefused++;
    providerError(res, req, 409, "no-key",
      "本机壳里没有可用的 provider key（设 DEEPSEEK_API_KEY / OPENAI_API_KEY / PC_AI_KEY，或用 --provider-key）");
    return;
  }
  const body = tryJson(raw);
  if (!body) {
    providerError(res, req, 400, "bad-request", "请求体不是 JSON 对象");
    return;
  }
  if (body.stream === true) {
    providerError(res, req, 400, "bad-request", "本轮不支持 stream:true（流式还没做）");
    return;
  }
  // 页面没给 model 时用壳的默认模型（§3.7.2 的「壳补充的字段」）
  const out = { ...body };
  if (typeof out.model !== "string" || !out.model.trim()) out.model = opts.providerModel;
  stats.providerCalls++;
  vlog("转发一次模型请求 → " + new URL(opts.providerBase).origin + "（model=" + out.model + "，key " + providerKeyTail() + "）");
  const r = await forwardToProvider(JSON.stringify(out), requestProviderTimeoutMs(req));
  if (!r.ok) {
    stats.providerErrors++;
    if (r.kind === "timeout") {
      providerError(res, req, 504, "provider-timeout", r.detail);
    } else {
      providerError(res, req, 502, "provider-unreachable", r.detail);
    }
    return;
  }
  // **原样透传**状态码与 body（3xx 也照透，不跟随重定向）——**唯一**的例外是把 key 擦掉：
  // provider 可能把收到的 Authorization 回显在 body 里，而页面会把 4xx body 前 120 字拼进错误行，
  // 那样环境 key 就进页面了（P15 第 2 项）。擦完按**新字节长度**回写 content-length。
  if (res.headersSent) return;
  const safe = scrubProviderKey(r.body);
  const buf = Buffer.from(safe, "utf8");
  const head = { ...providerCors(req), "content-type": "application/json; charset=utf-8", "content-length": buf.length };
  res.writeHead(r.status, head);
  res.end(buf);
}

// ------------------------------------------------------------------ 总路由

function handler(req, res) {
  let url;
  try {
    url = new URL(req.url || "/", baseUrl());
  } catch {
    json(res, 400, { ok: false, error: "bad-url" });
    return;
  }
  const p = url.pathname;
  if (p === "/ai" || p === "/ai/health") return void routeAi(req, res, p);
  if (p === "/provider/config") return void routeProviderConfig(req, res);
  if (p === "/provider/chat") return void routeProviderChat(req, res, url);
  if (p === "/provider" || p === "/provider/") {
    // 基址本身没有内容：给一眼能看懂的提示（页面不会调它）
    json(res, 200, providerConfigBody(), providerCors(req));
    return;
  }
  if (p === "/shell/events") return routeEvents(req, res, url);
  if (p === "/shell/handshake") return void routeHandshake(req, res);
  if (p === "/shell/reply") return void routeReply(req, res);
  if (p === "/shell/start") return void routeStart(req, res);
  if (p === "/shell/stop") return void routeStop(req, res);
  if (p === "/shell/status") return void routeStatus(req, res, url);
  if (p === "/shell/shutdown") return void routeShutdown(req, res);
  if (p === "/shell/no-handler") return void routeNoHandler(req, res);
  if (p.startsWith("/ai/") || p.startsWith("/shell/") || p.startsWith("/provider/")) {
    // 与 AiServer.java 同口径：路径不认识就 404（不是静态文件）
    json(res, 404, { ok: false, error: "not-found" }, providerCors(req));
    return;
  }
  routeStatic(req, res, p);
}

// ------------------------------------------------------------------ 开窗

function findBrowser() {
  // 显式给的路径先确认存在：不存在就当没给（否则 spawn 的异步 'error' 会把壳打挂）
  if (opts.browser) {
    try {
      if (fs.existsSync(opts.browser)) return opts.browser;
    } catch {
      /* ignore */
    }
    log("⚠ --browser 给的路径不存在：" + opts.browser + "（回退到自动探测）");
  }
  const pf86 = process.env["ProgramFiles(x86)"] || "";
  const pf = process.env.ProgramFiles || "";
  const local = process.env.LOCALAPPDATA || "";
  const cands = [
    path.join(pf86, "Microsoft/Edge/Application/msedge.exe"),
    path.join(pf, "Microsoft/Edge/Application/msedge.exe"),
    path.join(local, "Microsoft/Edge/Application/msedge.exe"),
    path.join(pf86, "Google/Chrome/Application/chrome.exe"),
    path.join(pf, "Google/Chrome/Application/chrome.exe"),
    path.join(local, "Google/Chrome/Application/chrome.exe"),
  ];
  for (const c of cands) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return "";
}

/** 应用窗口模式开窗：msedge/chrome 的 `--app=` 没有地址栏与标签页，最像「桌面版」 */
function openWindow(url) {
  const args = ["--app=" + url, "--no-first-run", "--no-default-browser-check"];
  const exe = findBrowser();
  if (exe) {
    try {
      const child = spawn(exe, args, { detached: true, stdio: "ignore" });
      // spawn 的失败是**异步**的（'error' 事件）：不接住就是未捕获异常，整个壳会在启动时挂掉
      child.on("error", (e) => log("⚠ 启动浏览器失败：" + (e && e.message ? e.message : String(e)) + " → 手动访问 " + url));
      child.unref();
      log("已用应用窗口模式打开：" + path.basename(exe) + " --app=" + url);
      vlog("浏览器命令：" + exe + " " + args.join(" "));
      return;
    } catch (e) {
      log("⚠ 指定的浏览器启动失败（--browser 要给可执行文件的路径，别给 .cmd/.bat）：" + (e && e.message ? e.message : String(e)));
    }
  }
  // 没有 msedge / chrome（或上面那条路失败）：退回系统默认程序
  try {
    const child =
      process.platform === "win32"
        ? spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" })
        : process.platform === "darwin"
          ? spawn("open", [url], { detached: true, stdio: "ignore" })
          : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    child.on("error", (e) => log("⚠ 打开失败（不影响服务）：" + (e && e.message ? e.message : String(e)) + " → 手动访问 " + url));
    child.unref();
    log("已让系统默认程序打开：" + url);
  } catch (e) {
    log("⚠ 打开窗口失败（不影响服务）：" + (e && e.message ? e.message : String(e)) + " → 手动访问 " + url);
  }
}

// ------------------------------------------------------------------ 退出

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("收到 " + signal + "，收尾中…");
  // ① 请页面走它自己的收尾路径：`__pcAi.stop()` = 回合 rollback + 停服务（History 影子不留身后）
  broadcast("shutdown", { reason: signal });
  // ② 未决请求一律按 shutdown 回（与 MainActivity 的 AI_ERR_SHUTDOWN 同文案）
  for (const [id, item] of pending) {
    if (!item.settled) settlePending(id, 503, JSON.stringify({ ok: false, error: "shutdown" }));
  }
  const finish = () => {
    for (const s of subs) {
      try {
        s.end();
      } catch {
        /* ignore */
      }
    }
    subs.clear();
    if (extraServer) {
      try {
        extraServer.close();
      } catch {
        /* ignore */
      }
    }
    server.close(() => {
      log("端口已释放，退出");
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 500).unref(); // 连接没关干净也别拖着
  };
  // 给页面一点时间跑 __pcAi.stop()（rollback 是同步的，300ms 很够）
  setTimeout(finish, subs.size ? 300 : 0);
}

// ------------------------------------------------------------------ 主流程

const server = http.createServer(handler);
server.on("clientError", (err, socket) => {
  try {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  } catch {
    /* ignore */
  }
});
// SSE 是长连接：别让默认的 keep-alive / 请求超时把通道掐了
server.keepAliveTimeout = 0;
server.requestTimeout = 0;
server.headersTimeout = 120000;

function banner() {
  const mcp = path.join(ROOT, "toolchain", "pc-mcp.mjs");
  console.log("");
  console.log("PixelCraft PC 桌面壳（最小启动器 · 零依赖）");
  console.log("  应用窗口  " + baseUrl() + "/");
  console.log("  静态站点  " + WWW);
  console.log("  AI 入口   GET /ai/health · POST /ai（Authorization: Bearer " + TOKEN + "）");
  console.log("  token     " + TOKEN + "     ← 未指定 --token / AI_TOKEN 时才随机生成；别外传");
  // provider 转发：**只打尾 4 位**（key 明文绝不进 banner / 日志 / 任何文本；§3.7 红线）
  if (opts.providerProxy) {
    console.log("  模型代理  GET /provider/config · POST /provider/chat（应用内助手用；页面拿不到 key）");
    console.log("            目标 " + opts.providerBase + " · 默认模型 " + opts.providerModel + " · key " +
      (opts.providerKey ? providerKeyTail() + "（来源 " + providerKeySource() + "）" : "没有（设 DEEPSEEK_API_KEY 后重启壳）"));
  } else {
    console.log("  模型代理  已关闭（--no-provider-proxy 或目标不是已知 provider）：/provider/config 回 proxy:false");
  }
  console.log("  启用 AI   窗口里 设置 → AI → 打开「本地服务」（默认关闭，与 APK 同口径）；");
  console.log("            档位 read 只能读，draw 能改画面，all 连 destructive 也放行（仍需确认）");
  console.log("  MCP 接法  宿主指向**同一个端口**（token 填上面那串）：");
  console.log('            { "mcpServers": { "pixelcraft": { "command": "node",');
  console.log('                "args": ["' + mcp + '", "--port", "' + opts.port + '"],');
  console.log('                "env": { "AI_TOKEN": "' + TOKEN + '" } } } }');
  console.log("  自测      msedge --headless=new --remote-debugging-port=9222 " + baseUrl() + "/");
  console.log("  Ctrl+C 退出（先请页面收尾回合，再释放端口）");
  console.log("");
  console.log("ready " + baseUrl() + " token=" + TOKEN);
}

function main() {
  // 注意：**不在这里** parseArgs —— 它在文件顶部（模块顶层，紧挨 `const TOKEN` 之前）已经调用过。
  // 顶层求值（TOKEN / 注入脚本里的端口与超时…）必须先看到解析后的 opts；重复解析只会多一处隐患。
  if (opts.help) {
    usage();
    return;
  }
  if (!Number.isInteger(opts.port) || opts.port < 1024 || opts.port > 65535) {
    log("端口不合法：" + opts.port + "（允许 1024..65535）");
    process.exit(1);
  }
  if (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs < 1000 || opts.timeoutMs > 600000) {
    log("超时不合法：" + opts.timeoutMs + "ms（允许 1000..600000，默认 " + DEFAULT_TIMEOUT_MS + "）");
    process.exit(1);
  }
  if (!Number.isInteger(opts.providerTimeoutMs) || opts.providerTimeoutMs < 1000 || opts.providerTimeoutMs > 600000) {
    log("上游转发超时不合法：" + opts.providerTimeoutMs + "ms（允许 1000..600000，默认 " + DEFAULT_PROVIDER_TIMEOUT_MS + "）");
    process.exit(1);
  }
  if (!fs.existsSync(path.join(WWW, "index.html"))) {
    log("找不到站点根：" + WWW + "（app2/www 不在？壳必须从仓库里跑）");
    process.exit(1);
  }

  server.on("error", (e) => {
    log("监听 " + HOST + ":" + opts.port + " 失败：" + (e && e.message ? e.message : String(e)));
    log("端口被占用？换一个：node toolchain/pc-shell.mjs --port 8788");
    process.exit(1);
  });

  server.listen(opts.port, HOST, () => {
    banner();
    if (opts.open) openWindow(baseUrl() + "/");
    else log("--no-open：没有开窗口，自己访问 " + baseUrl() + "/");
  });

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
