// C4 的电脑侧入口：把 MCP 的 `tools/list` / `tools/call` 转发到本机 PixelCraft AI 工具服务。
//
//   node toolchain/pc-mcp.mjs --port 8787 --token <hex>     # 手工调试（在终端里手打 JSON-RPC 行）
//   AI_PORT=8787 AI_TOKEN=<hex> node toolchain/pc-mcp.mjs   # 环境变量也行（argv 优先）
//   node toolchain/pc-mcp.mjs --help
//
// 为什么要有这一层（PLAN-ai §3.5）：MCP 是「宿主 → 工具服务」的方向，AI 要操作**我们的**软件，
// **我们必须当 server**。协议只有一份（§24：`GET /ai/health` + `POST /ai`，`Authorization: Bearer`），
// 所以这里只做搬运，一行路由 / 鉴权 / tier 判定都不重写：
//   · stdin/stdout 上跑**换行分隔**的 JSON-RPC 2.0（MCP 的 stdio 传输；没有第三方依赖）；
//   · **stdout 只许出现协议行** —— 任何日志一律走 stderr。往 stdout 多打一行，宿主就收到一行
//     解不开的"JSON"，表现是"一接上就断线"，排查起来很难看；
//   · `tools/list` → 本机 `list_tools`，`tools/call` → 本机 `call_tool`。工具表**不在这层复制**，
//     唯一源是 src/app/ai-tools.ts（schema 现取现映射），清单随服务档位 `ai.tier` 变化；
//   · 权限**不加也不减**：token 必须由用户显式给出，档位由本机服务的设置决定，这里只把拿到的
//     清单原样报给宿主；destructive 在被拒绝时收到的 `cancelled` 也原样透传（不吞错、不重试）。
//
// 一句话：宿主说 MCP，手机/本机说 HTTP + token，这一层是那台翻译机。

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const SERVER_NAME = "pixelcraft";
const HOST = "127.0.0.1"; // 与 §24.1 一致：只连回环，绝不连别处
const DEFAULT_PORT = 8787;
const DEFAULT_TIMEOUT_MS = 10000;
/** 支持的 MCP 修订：宿主报哪个就回哪个，不在表里就回首选（让宿主自己决定能不能用） */
const SUPPORTED_PROTOCOLS = ["2024-11-05", "2025-03-26", "2025-06-18"];
const PREFERRED_PROTOCOL = "2025-06-18";
/** int 参数的哨兵默认值（见 ai-tools：省略 = 当前帧 / 当前图层） */
const AI_ARG_CURRENT = "current";
/** 单行上限：MCP 是换行分隔，收到超长行说明对端不是 MCP（或 framing 坏了） */
const MAX_LINE_BYTES = 4 * 1024 * 1024;
/** 回包摘要长度上限（错误信息里带原文，但别把整个 body 塞进去） */
const SHORT_LEN = 300;

const TIER_HINT = {
  read: "只读，不改文档",
  draw: "能改画面（像素 / 图层 / 帧 / 标签 / 调色板 / 等距图形）",
  destructive: "会删改结构或清空画布，服务端每次都要确认；没人确认时返回 cancelled",
  ui: "只切界面状态（当前工具等），档位不是 all 时默认不列",
};

// ---------------------------------------------------------------- 参数与用法

const opts = {
  port: DEFAULT_PORT,
  token: "",
  timeoutMs: DEFAULT_TIMEOUT_MS,
  verbose: false,
  help: false,
};

function toInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function parseArgs(argv) {
  // 先环境变量、后 argv：显式给的参数优先（AI_PORT / AI_TOKEN 是给宿主配置用的快捷方式）
  if (process.env.AI_PORT) opts.port = toInt(process.env.AI_PORT, DEFAULT_PORT);
  if (process.env.AI_TOKEN) opts.token = String(process.env.AI_TOKEN).trim();
  if (process.env.AI_TIMEOUT) opts.timeoutMs = toInt(process.env.AI_TIMEOUT, DEFAULT_TIMEOUT_MS);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => (i + 1 < argv.length ? argv[++i] : "");
    if (a === "--port" || a === "-p") opts.port = toInt(next(), NaN);
    else if (a === "--token" || a === "-t") opts.token = next().trim();
    else if (a === "--timeout") opts.timeoutMs = toInt(next(), NaN);
    else if (a === "--verbose" || a === "-v") opts.verbose = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else {
      log("未知参数：" + a);
      opts.help = true;
    }
  }
}

function usage() {
  console.log([
    "用法：node toolchain/pc-mcp.mjs [--port 8787] [--token <hex>] [--timeout 10000] [--verbose]",
    "环境变量：AI_PORT / AI_TOKEN / AI_TIMEOUT（命令行参数优先）",
    "默认：转发到 http://127.0.0.1:8787 · POST /ai（Authorization: Bearer <token>）· 超时 10s",
    "",
    "它在 stdin/stdout 上说 MCP（换行分隔的 JSON-RPC 2.0）：initialize / tools/list / tools/call。",
    "日志只走 stderr —— stdout 是协议通道，别往里加任何打印。",
    "",
    "先把本机服务跑起来，再把启动时打印的 token 填给宿主（token 每次重启都换）：",
    "  node toolchain/ai-server.mjs --port 8787 --tier all      # 电脑侧开发宿主（draw 只放开写类工具）",
    "  手机上：设置 → AI → 打开本地服务；要连手机先在电脑上 adb reverse tcp:8787 tcp:8787",
    "",
    "MCP 宿主配置示例（Claude Desktop 的 claude_desktop_config.json）：",
    '{ "mcpServers": { "pixelcraft": {',
    '    "command": "node",',
    '    "args": ["<仓库绝对路径>\\\\toolchain\\\\pc-mcp.mjs", "--port", "8787"],',
    '    "env": { "AI_TOKEN": "<服务启动时打印的 token>" } } } }',
    "",
    "自检：node --check toolchain/pc-mcp.mjs；真往返见 docs/PLAN-ai.md（C4）。",
  ].join("\n"));
}

/** 应用版本号：从 changelog.tsx 抠出来（这脚本不 import UI，也就不拖 React 进来） */
function appVersion() {
  try {
    const src = fs.readFileSync(path.join(ROOT, "src", "ui", "changelog.tsx"), "utf8");
    const m = src.match(/APP_VERSION\s*=\s*"([^"]+)"/);
    return m ? m[1] : "dev";
  } catch {
    return "dev";
  }
}

const SERVER_VERSION = appVersion();

// ---------------------------------------------------------------- 日志 / 发消息

function log(msg) {
  process.stderr.write("[pc-mcp] " + msg + "\n");
}

function vlog(msg) {
  if (opts.verbose) log(msg);
}

/** stdout 只走协议行：一次 write 写完一整行（换行分隔的 framing 不会串） */
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function short(text) {
  const s = String(text === undefined || text === null ? "" : text).replace(/\s+/g, " ").trim();
  return s.length > SHORT_LEN ? s.slice(0, SHORT_LEN) + "…" : s;
}

function tokenTail() {
  return opts.token ? "…" + opts.token.slice(-4) : "（空）";
}

function baseUrl() {
  return "http://" + HOST + ":" + opts.port;
}

// ---------------------------------------------------------------- HTTP 层

/** 连接层错误（连不上 / 超时 / 401 / 非 200）：可读文案，绝不静默挂起 */
class AiTransportError extends Error {}
/** 协议层拒绝（HTTP 200 + `{"ok":false}`：call 名不对、档位不放行、工具不存在…） */
class AiCallError extends Error {}

function unauthorizedText() {
  return (
    "401 Unauthorized：token 不匹配（当前给的是「" + tokenTail() + "」）。token 每次启动都重新生成，" +
    "重启服务后要把同一个值给 pc-mcp：--token <hex> 或 AI_TOKEN=<hex>（宿主配置的 env 里）"
  );
}

function statusHint(status) {
  if (status === 503) return "（503：Session 还没就绪 —— 应用刚打开或服务刚起来，等一下重试）";
  if (status === 413) return "（413：body 超过上限 262144 字符，把一次调用拆小）";
  if (status === 404) return "（404：路径不认识 —— 对面可能不是 PixelCraft 的本地服务）";
  if (status === 405) return "（405：方法不对）";
  if (status === 400) return "（400：call 名或参数形状不对；协议层的 read_region 用的是扁平 {x,y,w,h}，见 §24.1）";
  return "";
}

function wrapNetError(e, label) {
  if (e instanceof AiTransportError) {
    if (e.message === "__timeout__") {
      return new AiTransportError(
        label + " 超时（" + opts.timeoutMs + "ms）：服务没在时限内回答。destructive 工具要等应用内确认（确认必须在 10s 内完成），" +
          "也可能只是服务卡住 —— 先 GET " + baseUrl() + "/ai/health 看看，必要时 --timeout 调大",
      );
    }
    return e;
  }
  const code = e && e.code ? String(e.code) : "";
  if (code === "ECONNREFUSED" || code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "EADDRNOTAVAIL") {
    return new AiTransportError(
      "连不上 " + baseUrl() + "（" + code + "）：PixelCraft 的本地 AI 服务没在跑。" +
        "手机上「设置 → AI → 打开本地服务」（要连手机先在电脑上 adb reverse tcp:8787 tcp:8787），" +
        "电脑侧开发用 node toolchain/ai-server.mjs --port " + opts.port,
    );
  }
  return new AiTransportError("请求本机服务失败（" + label + "）：" + (e && e.message ? e.message : String(e)));
}

/** 一次 HTTP 往返；只负责拿到 {status, text} */
function request(method, urlPath, bodyText, label) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(bodyText, "utf8");
    const req = http.request(
      {
        host: HOST,
        port: opts.port,
        path: urlPath,
        method,
        agent: false, // 短连接：MCP 空闲时不留悬挂 socket
        headers: {
          authorization: "Bearer " + opts.token,
          "content-type": "application/json; charset=utf-8",
          "content-length": buf.length,
          "cache-control": "no-store",
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > MAX_LINE_BYTES) {
            res.destroy();
            reject(new AiTransportError(label + " 的回包超过 " + MAX_LINE_BYTES + " 字节，已断开（把一次调用拆小）"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", (e) => reject(wrapNetError(e, label)));
      },
    );
    // setTimeout 到点就 destroy：destroy 会触发 error 事件，由上面那个 handler 统一转成可读错误
    req.setTimeout(opts.timeoutMs, () => req.destroy(new AiTransportError("__timeout__")));
    req.on("error", (e) => reject(wrapNetError(e, label)));
    req.end(buf);
  });
}

/** 解 envelope：`{"ok":true,"result":…}` / `{"ok":false,"error":"…"}`（§24.1） */
async function envelope(method, urlPath, bodyText, label) {
  const res = await request(method, urlPath, bodyText, label);
  if (res.status === 401) throw new AiTransportError(unauthorizedText());
  if (res.status !== 200) {
    throw new AiTransportError("本机服务回 HTTP " + res.status + "（" + label + "）：" + short(res.text) + statusHint(res.status));
  }
  let json;
  try {
    json = JSON.parse(res.text);
  } catch {
    throw new AiTransportError("回包不是 JSON（" + label + "）：" + short(res.text));
  }
  if (!json || typeof json !== "object" || typeof json.ok !== "boolean") {
    throw new AiTransportError("回包形状不对（" + label + "）：" + short(res.text));
  }
  if (json.ok !== true) throw new AiCallError(String(json.error || "未知错误"));
  vlog(label + " → ok");
  return json.result;
}

function aiCall(call, args) {
  return envelope("POST", "/ai", JSON.stringify(args === undefined ? { call } : { call, args }), "POST /ai " + call);
}

function aiHealth() {
  return envelope("GET", "/ai/health", "", "GET /ai/health");
}

// ---------------------------------------------------------------- 工具表 → MCP schema

/** 一个参数的 JSON Schema。`min` / `max` 落到各自的关键字上（数值 minimum/maximum、
 *  字符串 minLength/maxLength、数组 minItems/maxItems）—— JSON Schema 里 minimum 对字符串没有意义。 */
function paramSchema(p) {
  const type = typeof p.type === "string" ? p.type : "string";
  const s = {};
  switch (type) {
    case "int":
      s.type = "integer";
      break;
    case "num":
      s.type = "number";
      break;
    case "bool":
      s.type = "boolean";
      break;
    case "string":
      s.type = "string";
      break;
    case "enum":
      s.type = "string";
      if (Array.isArray(p.values)) s.enum = p.values.map((v) => String(v));
      break;
    case "color":
      s.type = "string"; // "#rrggbb" / "#rrggbbaa" / "fg" / "bg"
      break;
    case "xy":
      s.type = "array";
      s.items = { type: "integer" };
      s.minItems = 2;
      s.maxItems = 2;
      break;
    case "rect":
      s.type = "object";
      s.properties = { x: { type: "integer" }, y: { type: "integer" }, w: { type: "integer" }, h: { type: "integer" } };
      s.required = ["x", "y", "w", "h"];
      break;
    case "array":
      s.type = "array";
      // 注意：本机 `list_tools` 目前**不下发** `items`（ai-rpc.ts 的 aiToolInfo 只搬
      // type/values/min/max/default/optional/desc），所以元素类型常常是未知的。
      // 未知就**不要瞎猜**（猜成 number 的话，颜色数组会给出一个自相矛盾的 schema）：
      // 给一个放开的 {}，并在 description 里说清楚。
      s.items = typeof p.items === "string" ? paramSchema({ type: p.items }) : {};
      break;
    default:
      s.type = "string"; // 没见过的新类型：放开成字符串，别把工具从清单里丢掉
      break;
  }

  // 范围：按 schema 类型落到对应关键字
  const numeric = s.type === "integer" || s.type === "number";
  if (numeric) {
    if (typeof p.min === "number") s.minimum = p.min;
    if (typeof p.max === "number") s.maximum = p.max;
  } else if (s.type === "string") {
    if (typeof p.min === "number") s.minLength = p.min;
    if (typeof p.max === "number") s.maxLength = p.max;
  } else if (s.type === "array") {
    if (typeof p.min === "number") s.minItems = p.min;
    if (typeof p.max === "number") s.maxItems = p.max;
  }

  // default：只在「值的类型真的符合 schema」时才写进 JSON Schema。
  // 反例很重要：`fi: {type:"int", min:0, default:"current"}` —— 那个 "current" 是哨兵
  // （省略 = 当前帧 / 当前图层），把它当 integer 的 default 会产出一份自相矛盾的 schema，
  // 所以哨兵只在 description 里说明。
  const hasDefault = p.default !== undefined;
  const isSentinel = p.default === AI_ARG_CURRENT;
  if (hasDefault && !isSentinel && defaultValueFits(s.type, p.default)) s.default = p.default;

  const bits = [];
  if (p.desc) bits.push(String(p.desc));
  else bits.push(autoParamText(type, p, s)); // 按 AiParamType 生成（不是 JSON Schema 的那个 type）
  if (hasDefault && !isSentinel && s.default === undefined) {
    bits.push("（默认 " + JSON.stringify(p.default) + "）"); // 类型对不上、只当提示
  }
  if (isSentinel && bits.join(" ").indexOf("省略") < 0) bits.push("（省略 = 当前帧 / 当前图层）");
  if (type === "array" && typeof p.items !== "string") {
    bits.push("（元素类型未随清单下发：按工具说明填，颜色类用 #rrggbb / fg / bg）");
  }
  s.description = bits.join(" ").trim();
  return s;
}

function defaultValueFits(jsonType, value) {
  if (jsonType === "integer") return typeof value === "number" && Number.isInteger(value);
  if (jsonType === "number") return typeof value === "number";
  if (jsonType === "boolean") return typeof value === "boolean";
  if (jsonType === "string") return typeof value === "string";
  return true;
}

/** 52/89 个参数没有 desc（PLAN-ai 已知缺口），这一层按 AiParamType 补一句能用的说明：类型 + 范围/取值 */
function autoParamText(aiType, p, s) {
  const range = (lo, hi, unit) => {
    if (typeof lo === "number" && typeof hi === "number") return "（" + lo + ".." + hi + (unit || "") + "）";
    if (typeof lo === "number") return "（≥" + lo + (unit || "") + "）";
    if (typeof hi === "number") return "（≤" + hi + (unit || "") + "）";
    return "";
  };
  switch (aiType) {
    case "int":
      return "整数" + range(p.min, p.max);
    case "num":
      return "数字" + range(p.min, p.max);
    case "bool":
      return "true / false";
    case "string":
      return "字符串" + range(p.min, p.max, " 个字符");
    case "enum":
      return Array.isArray(p.values) ? "枚举：" + p.values.map(String).join(" / ") : "枚举";
    case "color":
      return "颜色：#rrggbb / #rrggbbaa / fg（前景色）/ bg（背景色）";
    case "xy":
      return "[x, y] 两个整数";
    case "rect":
      return "矩形 {x, y, w, h}（画布坐标）";
    case "array":
      return "数组" + range(p.min, p.max, " 个元素") + (Array.isArray(s.enum) ? "：" + s.enum.join(" / ") : "");
    default:
      return aiType;
  }
}

/** 一个 AiToolInfo → MCP 工具（name / description / inputSchema [+ annotations]） */
function toMcpTool(t) {
  const params = t && t.params && typeof t.params === "object" ? t.params : {};
  const properties = {};
  const required = [];
  for (const name of Object.keys(params)) {
    const p = params[name] && typeof params[name] === "object" ? params[name] : {};
    properties[name] = paramSchema(p);
    // required = 没有 default 且不是 optional（AiToolParam 的两个口径，见 ai-tools.ts 文件头）
    const hasDefault = p.default !== undefined;
    if (!hasDefault && p.optional !== true) required.push(name);
  }

  const tier = typeof t.tier === "string" ? t.tier : "draw";
  const hint = TIER_HINT[tier] || tier;
  const lines = [String(t.title || t.id) + "（PixelCraft 工具 · " + tier + " 档：" + hint + "）"];
  if (required.length) lines.push("必填参数：" + required.join(" / "));
  else if (Object.keys(properties).length === 0) lines.push("无参数");
  else lines.push("参数都可省略");
  if (tier !== "read") lines.push("改完用 read_region / doc_digest 读回复核（docRev 变了才算生效）");

  return {
    name: String(t.id),
    description: lines.join("\n"),
    inputSchema: { type: "object", properties, required },
    // 给宿主的额外提示（MCP 2025-06-18 的 annotations）：read 档可安全并行 / 预授权
    annotations: { title: String(t.title || t.id), readOnlyHint: tier === "read", destructiveHint: tier === "destructive" },
  };
}

/**
 * 取本机工具清单。`ui` 档默认不列（§24.3：只有服务档位是 all 且调用方**显式**点名才给），
 * 所以档位允许 ui 时再问一次全量 —— MCP 宿主要的是完整工具面。问不到就退回第一次的结果，绝不因此报错。
 */
async function fetchTools() {
  let payload = await aiCall("list_tools", {});
  const tools = payload && Array.isArray(payload.tools) ? payload.tools : [];
  const allowed = payload && Array.isArray(payload.allowed) ? payload.allowed.map(String) : [];
  if (allowed.indexOf("ui") >= 0) {
    try {
      const full = await aiCall("list_tools", { tiers: allowed });
      const more = full && Array.isArray(full.tools) ? full.tools : [];
      if (more.length > tools.length) payload = full;
    } catch (e) {
      vlog("要 ui 档清单失败，按第一次的结果给：" + (e && e.message ? e.message : String(e)));
    }
  }
  return payload;
}

// ---------------------------------------------------------------- MCP 方法

function onInitialize(params) {
  const asked = params && typeof params.protocolVersion === "string" ? params.protocolVersion : "";
  const protocolVersion = SUPPORTED_PROTOCOLS.indexOf(asked) >= 0 ? asked : PREFERRED_PROTOCOL;
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: {
      name: SERVER_NAME,
      title: "PixelCraft 像素工坊（电脑侧 MCP 入口）",
      version: SERVER_VERSION,
    },
    instructions:
      "这是 PixelCraft 像素工坊的电脑侧入口：工具全部转发到本机 " + baseUrl() + " 的 AI 工具服务，" +
      "清单随该服务的档位（read / draw / all）变化。改动画布后用 read_region 或 doc_digest 读回复核" +
      "（docRev 变了才算生效）；destructive 档每次都要应用内确认，没人确认时返回 cancelled。",
  };
}

function reasonOf(result) {
  if (result && typeof result.error === "string" && result.error) return result.error;
  if (result && Array.isArray(result.warn) && result.warn.length) return result.warn.join("; ");
  return "服务端说 ok:false，但没给 error 文本";
}

/** 大回包就别缩进了（token 预算）；小的缩进一下，宿主里好读 */
function renderJson(value) {
  const compact = JSON.stringify(value);
  if (compact === undefined) return String(value);
  if (compact.length > 4000) return compact;
  return JSON.stringify(value, null, 2);
}

/** tools/call：转发到本机 call_tool；工具自身失败 → isError 但正文带原因（不吞错） */
async function onToolsCall(params) {
  const name = params && typeof params.name === "string" ? params.name : "";
  if (!name) {
    return { error: { code: -32602, message: "tools/call 的 params.name 必须是工具 id 字符串（先 tools/list）" } };
  }
  const args = params.arguments === undefined || params.arguments === null ? {} : params.arguments;
  if (typeof args !== "object" || Array.isArray(args)) {
    return { error: { code: -32602, message: "tools/call 的 params.arguments 必须是对象（收到 " + typeof args + "）" } };
  }
  try {
    const result = await aiCall("call_tool", { id: name, args });
    if (!result || result.ok !== false) return { result: { content: [{ type: "text", text: renderJson(result) }] } };
    return {
      result: {
        content: [{ type: "text", text: "工具 " + name + " 执行失败：" + reasonOf(result) + "\n" + renderJson(result) }],
        isError: true,
      },
    };
  } catch (e) {
    if (e instanceof AiCallError) {
      // 路由层拒绝（工具不存在 / 档位不放行 / call 名不对）：仍然是「可读的 MCP 错误」，不当协议故障
      return { result: { content: [{ type: "text", text: "工具 " + name + " 没有执行：" + e.message }], isError: true } };
    }
    throw e; // 连接层（连不上 / 超时 / 401 / 非 200）→ 上层转 JSON-RPC error
  }
}

/** 一条 JSON-RPC 消息 → 一条响应（通知返回 null） */
async function handleMessage(msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "不是合法的 JSON-RPC 消息" } };
  }
  const method = typeof msg.method === "string" ? msg.method : "";
  const hasId = Object.prototype.hasOwnProperty.call(msg, "id") && msg.id !== null && msg.id !== undefined;

  // 通知（没有 id）一律不回：MCP 的 notifications/* 都走这条，包括 notifications/initialized
  if (!hasId) {
    if (method && method !== "notifications/initialized") vlog("忽略通知：" + method);
    return null;
  }
  if (!method) return { jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: "缺 method" } };

  try {
    switch (method) {
      case "initialize":
        return { jsonrpc: "2.0", id: msg.id, result: onInitialize(msg.params) };
      case "ping":
        return { jsonrpc: "2.0", id: msg.id, result: {} };
      case "notifications/initialized":
        return { jsonrpc: "2.0", id: msg.id, result: {} };
      case "tools/list": {
        const payload = await fetchTools();
        const tools = (payload && Array.isArray(payload.tools) ? payload.tools : []).map(toMcpTool);
        vlog("tools/list → " + tools.length + " 个工具（服务档位 " + (payload && payload.tier) + "，放行 " + ((payload && payload.allowed) || []).join("/") + "）");
        return { jsonrpc: "2.0", id: msg.id, result: { tools } };
      }
      case "tools/call": {
        const out = await onToolsCall(msg.params);
        if (out.error) return { jsonrpc: "2.0", id: msg.id, error: out.error };
        return { jsonrpc: "2.0", id: msg.id, result: out.result };
      }
      default:
        return {
          jsonrpc: "2.0",
          id: msg.id,
          error: {
            code: -32601,
            message: "未知方法：" + method + "（这个服务器只提供 tools/list 与 tools/call，传输是 MCP stdio）",
          },
        };
    }
  } catch (e) {
    const text = e && e.message ? e.message : String(e);
    const code = e instanceof AiTransportError ? -32000 : -32603;
    log("✗ " + method + "：" + text);
    return { jsonrpc: "2.0", id: msg.id, error: { code, message: text } };
  }
}

async function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON 解析失败：" + (e && e.message ? e.message : String(e)) } });
    return;
  }
  if (Array.isArray(msg)) {
    // JSON-RPC 的批量请求（MCP 2025-03-26 起已移除，但旧宿主可能发）
    const outs = [];
    for (const m of msg) {
      const r = await handleMessage(m);
      if (r) outs.push(r);
    }
    if (outs.length) send(outs.length === 1 ? outs[0] : outs);
    return;
  }
  const r = await handleMessage(msg);
  if (r) send(r);
}

// ---------------------------------------------------------------- 主流程

function main() {
  parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return;
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    log("端口不合法：" + opts.port + "（允许 1..65535）");
    process.exit(1);
  }
  if (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs < 1000 || opts.timeoutMs > 600000) {
    log("超时不合法：" + opts.timeoutMs + "ms（允许 1000..600000，默认 " + DEFAULT_TIMEOUT_MS + "）");
    process.exit(1);
  }
  if (!opts.token) {
    log("⚠ 没有给 token（--token / AI_TOKEN）：本机服务一定会回 401。token 是服务启动时打印的那串十六进制。");
  }

  log("PixelCraft MCP 入口（stdio）→ " + baseUrl() + " · token " + tokenTail() + " · 超时 " + opts.timeoutMs + "ms");

  // 启动探活：只是给用户一句看得懂的话，**不阻塞也不影响** MCP 握手（服务可能是稍后才起来的）
  void aiHealth()
    .then((h) => log("本机服务在跑：version=" + h.version + " docRev=" + h.docRev + " tier=" + h.tier))
    .catch((e) => log("⚠ 现在连不上本机服务：" + (e && e.message ? e.message : String(e))));

  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "").trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
        send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "单条消息超过 " + MAX_LINE_BYTES + " 字节，已丢弃" } });
        continue;
      }
      // 不 await：一条慢调用（destructive 等确认）不该把后面的请求排住
      void handleLine(line).catch((e) => log("✗ 处理消息出错：" + (e && e.message ? e.message : String(e))));
    }
    if (buf.length > MAX_LINE_BYTES) {
      send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "收到超长单行（没有换行分隔），已丢弃" } });
      buf = "";
    }
  });
  process.stdin.on("end", () => {
    log("stdin 关闭，退出");
    process.exit(0);
  });
  process.stdin.on("error", (e) => {
    log("stdin 出错：" + (e && e.message ? e.message : String(e)));
    process.exit(1);
  });
  // 宿主关了管道就别再写了（否则 Node 抛 EPIPE 打一堆无用的堆栈）
  process.stdout.on("error", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}

main();
