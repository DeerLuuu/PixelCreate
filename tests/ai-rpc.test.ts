// C3 回归：协议路由（src/app/ai-rpc.ts）+ JS 生命周期（src/app/ai-serve.ts）+ 声明式设置项。
//
// 这一份测试盯的是「不要改回去」的几件事：
//   · **路由是纯函数**：静态扫 ai-rpc.ts，不许出现 window / document / fetch / import ../ui；
//   · 协议表：health（GET，**body 是空串**，不许 JSON.parse）、/ai 的 9 个 call、
//     状态码 200 / 400 / 401 / 404 / 405 / 413 / 503，body 恒为**单行 JSON**；
//   · tier 是 C3 服务层的**放行开关**：read 档下 draw / destructive / ui 一律被拒并写明原因，
//     `list_tools` 默认只给当前档位、`ui` 默认不列（显式要了才列）；
//   · `call_tool` 转发到 C1 的工具表：默认确认器（`AI_CONFIRM_DENY`）下 destructive 回
//     `cancelled` 且文档逐字节不动；`changed` 不可依赖（改没改只看 docRev）；
//   · 同步入口与异步入口共用同一套路由：非 call_tool 的请求两边**逐字节一致**，
//     call_tool 在同步入口回哨兵 `needs-async`、异步入口给真结果；
//   · ai-serve：无桥接环境 import / install / 处理请求全部降级且不抛；挂起走空串 +
//     `aiRespond` 回调（false 只记诊断）；token 是 16 字节十六进制、每次启动重新生成；
//   · 设置项 ai.server / ai.port / ai.tier 的声明、i18n 中英各一条、没有新增 SettingKind。
import { Session } from "../src/app/session";
import {
  AI_CONFIRM_DENY, AI_RPC_ASYNC_BODY, AI_RPC_DEFAULT_PORT, AI_RPC_DEFAULT_TIER, AI_RPC_MAX_BODY,
  AI_SERVICE_TIERS, AI_TURN_IDLE_SEC_DEFAULT, aiRpcErrorBody, aiRpcOkBody, aiTierAllows, aiTurnClock,
  aiTurnIdleSeconds, allowedToolTiers, expireIdleTurn, handleAiRequest, handleAiRequestAsync, setAiTurnIdleSeconds,
} from "../src/app/ai-rpc";
import type { AiRpcCtx, AiRpcRequest, AiRpcResponse, AiServiceTier } from "../src/app/ai-rpc";
import {
  AI_SERVE_REASON_KEYS, aiServeHandleCall, aiServeStatus, aiServeStatusText,
  installAiServe, randomToken, setAiConfirmer, stopAiServe, uninstallAiServe,
} from "../src/app/ai-serve";
import {
  AI_SETTINGS_KEY, AI_PORT_MAX, AI_PORT_MIN, AI_TURN_IDLE_SEC_MAX, SETTINGS, SETTINGS_BY_PATH,
  aiServeSettings, normalizeAiServeSettings, onAiServeSettingsChange, saveAiServeSettings,
  settingsOfGroup,
} from "../src/app/settings";
import { callTool, listTools } from "../src/app/ai-tools";
import { makeT } from "../src/ui/i18n";
import { stubEnv } from "./session.test";
import { eq, ok } from "./common";

declare const require: (m: string) => any;
declare const __dirname: string;
const fs = require("fs");
const path = require("path");

/** 固定 token（测试用；真机每次启动由 Java / Node 宿主重新随机生成） */
const TOKEN = "0123456789abcdef0123456789abcdef";
const OTHER_TOKEN = "ffffffffffffffffffffffffffffffff";

interface Reply {
  status: number;
  body: string;
  json: { ok?: boolean; result?: any; error?: string };
}

/** 一次路由 + 解析（顺便断言 body 是单行 JSON —— 协议的一部分） */
function call(req: AiRpcRequest, ctx: AiRpcCtx): Reply {
  const res: AiRpcResponse = handleAiRequest(req, ctx);
  return wrap(res);
}

async function callAsync(req: AiRpcRequest, ctx: AiRpcCtx): Promise<Reply> {
  return wrap(await handleAiRequestAsync(req, ctx));
}

function wrap(res: AiRpcResponse): Reply {
  ok("rpc.body.single-line", res.body.indexOf("\n") < 0 && res.body.indexOf("\r") < 0, res.body.slice(0, 60));
  ok("rpc.body.json", res.body.charAt(0) === "{" && res.body.charAt(res.body.length - 1) === "}", res.body.slice(0, 60));
  return { status: res.status, body: res.body, json: JSON.parse(res.body) };
}

/** `{call,args}` 的 POST /ai（token 默认带上；`token: undefined` 可测不带头的路径） */
function post(callName: string, args?: unknown, token: string | undefined = TOKEN): AiRpcRequest {
  const payload: Record<string, unknown> = { call: callName };
  if (args !== undefined) payload.args = args;
  return { method: "POST", path: "/ai", token, body: JSON.stringify(payload) };
}

function get(pathStr: string, token: string | undefined = TOKEN): AiRpcRequest {
  return { method: "GET", path: pathStr, token, body: "" };
}

/** 完全不带 token 字段的请求（envelope 里真的没有 Authorization 时就是这样） */
function bare(pathStr: string): AiRpcRequest {
  return { method: "GET", path: pathStr, body: "" };
}

function mkSession(): Session {
  stubEnv();
  const s = new Session();
  s.doc.palette = [[255, 0, 0, 255], [0, 255, 0, 255]];
  return s;
}

function mkCtx(s: Session | null, over: Partial<AiRpcCtx> = {}): AiRpcCtx {
  return { session: s, token: TOKEN, tier: "read", version: "9.9.9-test", ...over };
}

/** 文档逐字节快照（cel 字节 + 调色板 + 图层/帧）：钉住「取消时一个字节都没动」。
 *  **不含 `doc.pixelRev`**：`Doc.restore()` 自己会 ++（那是渲染缓存键，不是内容），
 *  rollback 前后它必然不同 —— 要判「像素真的变了」就单独比对 pixelRev（见 docRev 的用法）。 */
function docBytes(s: Session): string {
  const parts: string[] = [s.doc.w + "x" + s.doc.h, "pal=" + JSON.stringify(s.doc.palette),
    "layers=" + s.doc.layers.length, "frames=" + s.doc.frames.length];
  for (const k of Array.from(s.doc.cels.keys()).sort()) {
    const cel = s.doc.cels.get(k);
    if (cel) parts.push(k + "=" + Array.from(cel.data).join(","));
  }
  return parts.join("|");
}

/** 一张带内容的会话：3 图层、一个红像素（`color_replace` 用得上） */
function live(): Session {
  const s = mkSession();
  s.layerAdd();
  s.layerAdd();
  s.doc.ensureCel(0, 0).setPixel(0, 0, [255, 0, 0, 255]);
  s.history.clear();
  return s;
}

/** 把 stubEnv 的 window 当字典看（测试里要用它当 PixelBridge 宿主） */
function win(): Record<string, unknown> {
  return (globalThis as unknown as { window: Record<string, unknown> }).window;
}

function setBridge(pb: unknown): void {
  win().PixelBridge = pb;
}

function readSource(file: string): string {
  return fs.readFileSync(path.resolve(__dirname, "../../../src/app/" + file), "utf8") as string;
}

/** 去掉注释后的源码（纯函数性检查只看代码，注释里当然可以提 window / setTimeout） */
function codeOf(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => (l.trim().slice(0, 2) === "//" ? "" : l))
    .join("\n");
}

export async function testAiRpc(): Promise<void> {
  stubEnv();

  // ================================================================ 1. 纯函数
  // 机械证明「无 DOM / 无网络 / 不 import UI」：这一层必须能在 Node 里裸跑（本文件就是证据）
  {
    const src = codeOf(readSource("ai-rpc.ts"));
    for (const bad of ["window.", "document.", "fetch(", "XMLHttpRequest", "localStorage", "setTimeout", "setInterval", "import("]) {
      ok("rpc.pure.no-" + bad.replace(/[^a-z]/gi, ""), src.indexOf(bad) < 0, bad);
    }
    ok("rpc.pure.no-ui-import", src.indexOf('from "../ui/') < 0);
    ok("rpc.pure.no-bridge-import", src.indexOf('from "../io/') < 0);
    ok("rpc.pure.exports-sync-entry", src.indexOf("export function handleAiRequest(") >= 0);
    ok("rpc.pure.exports-async-entry", src.indexOf("export async function handleAiRequestAsync(") >= 0);
    ok("rpc.pure.one-route", src.indexOf("function route(") >= 0);
    // 只允许一处 JSON.parse（POST /ai 的 body）——health 的空 body 绝不能进解析
    eq("rpc.pure.parse-count", (src.match(/JSON\.parse\(/g) ?? []).length, 1);
    // **协议动词不许套 runAiTurn**：它在 fn 成功后自动 commit，套在 turn_begin 上会在
    // 「只有 begin」的请求里就把回合提交掉（t15 的口径）。复合流程才用它。
    ok("rpc.turn.verbs-not-wrapped", src.indexOf("runAiTurn") < 0);
  }

  {
    // 请求体形状：envelope 的 body 永远是字符串；health 的 body 是空串
    ok("rpc.okbody.shape", aiRpcOkBody({ a: 1 }) === '{"ok":true,"result":{"a":1}}');
    ok("rpc.errbody.shape", aiRpcErrorBody("no") === '{"ok":false,"error":"no"}');
    ok("rpc.errbody.escapes-newlines", aiRpcErrorBody("a\nb").indexOf("\n") < 0);
    ok("rpc.async.sentinel-shape", AI_RPC_ASYNC_BODY === aiRpcErrorBody("needs-async"));
    eq("rpc.tiers.order", AI_SERVICE_TIERS.slice(), ["read", "draw", "all"]);
    eq("rpc.default.tier", AI_RPC_DEFAULT_TIER, "read");
    eq("rpc.default.port", AI_RPC_DEFAULT_PORT, 8787);
  }

  // ================================================================ 2. health
  {
    const s = live();
    const ctx = mkCtx(s, { tier: "read" });
    const r = call(get("/ai/health"), ctx);
    eq("health.status", r.status, 200);
    eq("health.ok", r.json.ok, true);
    eq("health.version", r.json.result.version, "9.9.9-test");
    eq("health.tier", r.json.result.tier, "read");
    eq("health.docRev", r.json.result.docRev, s.doc.pixelRev);
    // ⚠ 空 body 不许 JSON.parse：body 塞了垃圾也照样按路径分流
    const junk = call({ method: "GET", path: "/ai/health", token: TOKEN, body: "{不是 JSON" }, ctx);
    eq("health.empty-body.no-parse", junk.status, 200);
    // 路径归一化：query / 尾斜杠都算同一个端点
    eq("health.query", call(get("/ai/health?probe=1"), ctx).status, 200);
    eq("health.trailing-slash", call(get("/ai/health/"), ctx).status, 200);
    // 方法不对 → 405
    const wrong = call({ method: "POST", path: "/ai/health", token: TOKEN, body: "" }, ctx);
    eq("health.post-405", wrong.status, 405);
    eq("health.post-405.error", wrong.json.ok, false);
  }

  // ================================================================ 3. 状态码
  {
    const s = live();
    const ctx = mkCtx(s);
    eq("path.unknown-404", call(get("/nope"), ctx).status, 404);
    eq("path.root-404", call(get("/"), ctx).status, 404);
    eq("path.ai-get-405", call(get("/ai"), ctx).status, 405);
    eq("path.ai-put-405", call({ method: "PUT", path: "/ai", token: TOKEN, body: "{}" }, ctx).status, 405);
    eq("path.ai-trailing-slash-post", call(post("digest"), ctx).status, 200);

    eq("auth.wrong-token-401", call(get("/ai/health", OTHER_TOKEN), ctx).status, 401);
    eq("auth.missing-token-401", call(bare("/ai/health"), ctx).status, 401);
    eq("auth.post-wrong-token-401", call(post("digest", undefined, OTHER_TOKEN), ctx).status, 401);
    eq("auth.error-shape", call(get("/ai/health", OTHER_TOKEN), ctx).json.error.indexOf("unauthorized"), 0);
    // ctx.token 为空 = 这一层不校验（APK 路径由 Java 验过）
    eq("auth.disabled-passes", call(get("/ai/health", undefined), mkCtx(s, { token: "" })).status, 200);

    // 非法 JSON / 形状不对 → 400
    eq("body.bad-json-400", call({ method: "POST", path: "/ai", token: TOKEN, body: "{" }, ctx).status, 400);
    eq("body.empty-400", call({ method: "POST", path: "/ai", token: TOKEN, body: "" }, ctx).status, 400);
    eq("body.array-400", call({ method: "POST", path: "/ai", token: TOKEN, body: "[]" }, ctx).status, 400);
    eq("body.no-call-400", call({ method: "POST", path: "/ai", token: TOKEN, body: "{}" }, ctx).status, 400);
    eq("body.bad-args-400", call({ method: "POST", path: "/ai", token: TOKEN, body: '{"call":"digest","args":[]}' }, ctx).status, 400);
    eq("call.unknown-400", call(post("nope"), ctx).status, 400);
    eq("call.unknown-400.error", call(post("nope"), ctx).json.error.indexOf("unknown call"), 0);
    // 超大 body → 413
    const huge = call({ method: "POST", path: "/ai", token: TOKEN, body: new Array(AI_RPC_MAX_BODY + 2).join("x") }, ctx);
    eq("body.too-large-413", huge.status, 413);
    // Session 没就绪 → 503（连 health 也是）
    eq("ready.null-503", call(get("/ai/health"), mkCtx(null)).status, 503);
    eq("ready.null-503.post", call(post("digest"), mkCtx(null)).status, 503);
    eq("ready.null-503.error", call(post("digest"), mkCtx(null)).json.ok, false);
  }

  // ================================================================ 4. 9 个 call 各自可达
  {
    const s = live();
    const ctx = mkCtx(s, { tier: "all" });
    const tools = call(post("list_tools"), ctx);
    eq("call.list_tools", tools.status, 200);
    ok("call.list_tools.tools", Array.isArray(tools.json.result.tools) && tools.json.result.tools.length > 40, "n=" + (tools.json.result.tools ?? []).length);
    ok("call.list_tools.no-handler", JSON.stringify(tools.json.result).indexOf("handler") < 0);

    const digest = call(post("digest"), ctx);
    eq("call.digest", digest.status, 200);
    eq("call.digest.ok", digest.json.ok, true);
    ok("call.digest.data", !!digest.json.result && typeof digest.json.result.text === "string", JSON.stringify(digest.json.result).slice(0, 80));

    const region = call(post("read_region", { x: 0, y: 0, w: 4, h: 4, rle: true }), ctx);
    eq("call.read_region", region.status, 200);
    ok("call.read_region.rows", Array.isArray(region.json.result.rows), JSON.stringify(region.json.result).slice(0, 60));
    eq("call.read_region.bad-args-400", call(post("read_region", { x: 0, y: 0, w: "4", h: 4 }), ctx).status, 400);
    eq("call.read_region.bad-fi-400", call(post("read_region", { x: 0, y: 0, w: 1, h: 1, fi: -1 }), ctx).status, 400);
    eq("call.digest.bad-fi-400", call(post("digest", { fi: 1.5 }), ctx).status, 400);

    // turn 系列
    const begin = call(post("turn_begin", { label: "画一条线" }), ctx);
    eq("call.turn_begin", begin.status, 200);
    eq("call.turn_begin.turnId", begin.json.result.turnId >= 1, true);
    eq("call.turn_begin.label-required-400", call(post("turn_begin"), ctx).status, 400);
    const prev = call(post("turn_preview"), ctx);
    eq("call.turn_preview", prev.status, 200);
    eq("call.turn_preview.zero", prev.json.result, { count: 0, rect: null });
    const commit = call(post("turn_commit"), ctx);
    eq("call.turn_commit", commit.status, 200);
    eq("call.turn_commit.committed", commit.json.result.committed, false);
    const back = call(post("turn_rollback"), ctx);
    eq("call.turn_rollback", back.status, 200);
    eq("call.turn_rollback.rolledBack", back.json.result.rolledBack, false);

    const st = call(post("status"), ctx);
    eq("call.status", st.status, 200);
    eq("call.status.tier", st.json.result.tier, "all");
    eq("call.status.turnOpen", st.json.result.turnOpen, false);
    ok("call.status.confirm-note", String(st.json.result.confirm).indexOf("denied-by-default") >= 0, String(st.json.result.confirm));
    ok("call.status.confirm-destructive-note", String(st.json.result.confirm).indexOf("destructive") >= 0, String(st.json.result.confirm));
    ok("call.status.tools-counts", st.json.result.tools.read === 4 && st.json.result.tools.draw > 30, JSON.stringify(st.json.result.tools));
    ok("call.status.turn-policy", String(st.json.result.turnPolicy).indexOf("rollback") >= 0, String(st.json.result.turnPolicy));
    eq("call.status.turn-idle-sec", st.json.result.turnIdleSec, 300);

    // call_tool 也是 9 个之一（详情在 §5）
    const tool = call(post("call_tool", { id: "doc_digest", args: {} }), ctx);
    eq("call.call_tool.sync-sentinel", tool.body, AI_RPC_ASYNC_BODY);
  }

  // ================================================================ 5. tier 过滤
  {
    const s = live();
    eq("tier.allows.read", aiTierAllows("read", "read"), true);
    eq("tier.allows.read-draw", aiTierAllows("read", "draw"), false);
    eq("tier.allows.draw", allowedToolTiers("draw").join(","), "read,draw");
    eq("tier.allows.all", allowedToolTiers("all").join(","), "read,draw,destructive,ui");

    const read = mkCtx(s, { tier: "read" });
    const listed = call(post("list_tools"), read);
    eq("tier.read.list-count", listed.json.result.count, 4);
    eq("tier.read.list-all-read", listed.json.result.tools.every((t: any) => t.tier === "read"), true);
    eq("tier.read.allowed", listed.json.result.allowed.join(","), "read");

    const refusedDraw = call(post("call_tool", { id: "layer_add", args: {} }), read);
    eq("tier.read.draw-200", refusedDraw.status, 200);
    eq("tier.read.draw-ok-false", refusedDraw.json.ok, false);
    ok("tier.read.draw-reason", refusedDraw.json.error.indexOf("draw") >= 0 && refusedDraw.json.error.indexOf("ai.tier") >= 0, refusedDraw.json.error);
    const refusedDestructive = call(post("call_tool", { id: "canvas_clear", args: {} }), read);
    eq("tier.read.destructive-refused", refusedDestructive.json.ok, false);
    ok("tier.read.destructive-reason", refusedDestructive.json.error.indexOf("destructive") >= 0, refusedDestructive.json.error);
    const refusedUi = call(post("call_tool", { id: "set_tool", args: { tool: "pencil" } }), read);
    eq("tier.read.ui-refused", refusedUi.json.ok, false);
    // 被拒的工具**没有**执行：图层数没变、历史还是空的
    eq("tier.read.nothing-ran.layers", s.doc.layers.length, 3);
    eq("tier.read.nothing-ran.history", s.history.list().labels.length, 0);
    // 读类工具在任何档位都放行
    eq("tier.read.read-tool-ok", (await callAsync(post("call_tool", { id: "doc_digest", args: {} }), read)).json.ok, true);
    // 要别的档位 → 400（不是「静默过滤」）
    eq("tier.read.ask-draw-400", call(post("list_tools", { tiers: ["draw"] }), read).status, 400);
    eq("tier.read.ask-ui-400", call(post("list_tools", { tiers: ["ui"] }), read).status, 400);
    eq("tier.read.ask-junk-400", call(post("list_tools", { tiers: ["nope"] }), read).status, 400);
    eq("tier.read.ask-not-array-400", call(post("list_tools", { tiers: "read" }), read).status, 400);

    const draw = mkCtx(s, { tier: "draw" });
    eq("tier.draw.list-allows-draw", call(post("list_tools", { tiers: ["read", "draw"] }), draw).json.result.count > 40, true);
    eq("tier.draw.layer_add-ok", (await callAsync(post("call_tool", { id: "layer_add", args: {} }), draw)).json.ok, true);
    eq("tier.draw.layers", s.doc.layers.length, 4);
    eq("tier.draw.destructive-refused", (await callAsync(post("call_tool", { id: "color_replace", args: { from: "#ff0000", to: "#00ff00" } }), mkCtx(s, { tier: "read" }))).json.ok, false);

    const all = mkCtx(s, { tier: "all" });
    const listedAll = call(post("list_tools"), all);
    eq("tier.all.list-has-destructive", listedAll.json.result.tools.some((t: any) => t.tier === "destructive"), true);
    eq("tier.all.ui-hidden-by-default", listedAll.json.result.tools.some((t: any) => t.tier === "ui"), false);
    eq("tier.all.ui-when-asked", call(post("list_tools", { tiers: ["ui"] }), all).json.result.tools.map((t: any) => t.id), ["set_tool"]);
    eq("tier.all.destructive-needs-confirm", (await callAsync(post("call_tool", { id: "canvas_clear", args: {} }), all)).json.error, "cancelled");
  }

  // ================================================================ 6. call_tool 转发
  {
    const s = live();
    const before = docBytes(s);
    const ctx = mkCtx(s, { tier: "draw" });

    // 未知工具 / 参数不合格：都走 C1 的原话，HTTP 仍是 200
    const unknown = await callAsync(post("call_tool", { id: "nope", args: {} }), ctx);
    eq("tool.unknown.200", unknown.status, 200);
    ok("tool.unknown.error", unknown.json.error.indexOf("unknown tool") >= 0, unknown.json.error);
    const bad = await callAsync(post("call_tool", { id: "layer_move_to", args: { index: "0" } }), ctx);
    eq("tool.bad-args.200", bad.status, 200);
    ok("tool.bad-args.error", bad.json.error.indexOf("invalid args") >= 0, bad.json.error);
    eq("tool.bad-args.no-write", docBytes(s), before);
    eq("tool.missing-id.400", call(post("call_tool", { args: {} }), ctx).status, 400);
    eq("tool.id-type.400", call(post("call_tool", { id: 5 }), ctx).status, 400);

    // 工具自身失败（没有可撤销的步骤）→ 200 + {ok:false,error}
    const failed = await callAsync(post("call_tool", { id: "undo", args: {} }), ctx);
    eq("tool.failed.200", failed.status, 200);
    eq("tool.failed.ok-false", failed.json.ok, false);
    eq("tool.failed.error", failed.json.error, "没有可撤销的步骤");

    // 写类工具真的生效：ok + docRev + data
    const add = await callAsync(post("call_tool", { id: "layer_add", args: {} }), ctx);
    eq("tool.write.ok", add.json.ok, true);
    eq("tool.write.layers", s.doc.layers.length, 4);
    ok("tool.write.docRev", typeof add.json.result.docRev === "number", String(add.json.result.docRev));
    eq("tool.write.history", s.history.list().labels.length, 1);

    // ⚠ changed 不可依赖：color_replace 只给 data.changed（数字），没有 res.changed 矩形，
    //    这**不是**错误；判定「改动生效了吗」一律用 docRev 前后比对。
    const rev0 = s.doc.pixelRev;
    const rep = await callAsync(post("call_tool", { id: "color_replace", args: { from: "#ff0000", to: "#00ff00" } }), ctx);
    eq("tool.changed.ok", rep.json.ok, true);
    eq("tool.changed.no-rect", rep.json.result.changed, undefined);
    eq("tool.changed.data-number", rep.json.result.data.changed, 1);
    eq("tool.changed.docRev-advanced", s.doc.pixelRev > rev0, true);

    // destructive：默认确认器（AI_CONFIRM_DENY）→ cancelled 且文档逐字节不动
    const keep = docBytes(s);
    const revKeep = s.doc.pixelRev;
    const cancelled = await callAsync(post("call_tool", { id: "canvas_clear", args: {} }), mkCtx(s, { tier: "all" }));
    eq("tool.confirm.default-cancelled", cancelled.json.error, "cancelled");
    eq("tool.confirm.default-bytes", docBytes(s), keep);
    eq("tool.confirm.default-docRev", s.doc.pixelRev, revKeep);
    eq("tool.confirm.deny-is-false", await AI_CONFIRM_DENY({ tool: "canvas_clear", tier: "destructive", summary: "x" }), false);

    // 注入真确认器（C5 / 宿主）之后才放行
    const asked: string[] = [];
    const yes = (await callAsync(post("call_tool", { id: "canvas_clear", args: {} }),
      mkCtx(s, { tier: "all", confirm: async (r) => { asked.push(r.tool + "|" + r.tier + "|" + r.summary); return true; } }))).json;
    eq("tool.confirm.injected.ok", yes.ok, true);
    eq("tool.confirm.asked-once", asked.length, 1);
    ok("tool.confirm.summary", asked[0].indexOf("清空画布") >= 0, asked[0]);
    eq("tool.confirm.cleared", s.doc.pixelRev > rev0, true);
  }

  // ================================================================ 7. 回合系列
  {
    const s = live();
    const ctx = mkCtx(s, { tier: "draw" });
    const t = call(post("turn_begin", { label: "画一条线并铺底色" }), ctx);
    ok("turn.begin.turnId", typeof t.json.result.turnId === "number" && t.json.result.turnId >= 1, String(t.json.result.turnId));
    eq("turn.open", s.aiTurnOpen(), true);
    // 协议动词不许被 runAiTurn 包（那会在「只有 begin」的请求里就自动 commit）
    eq("turn.begin.does-not-commit", s.history.list().labels.length, 0);
    for (let i = 0; i < 3; i++) {
      const r = await callAsync(post("call_tool", { id: "layer_add", args: {} }), ctx);
      eq("turn.write-" + i, r.json.ok, true);
    }
    const p = call(post("turn_preview"), ctx);
    eq("turn.preview.count", p.json.result.count, 3);
    eq("turn.preview.history-still-empty", s.history.list().labels.length, 0);
    const c = call(post("turn_commit"), ctx);
    eq("turn.commit.true", c.json.result.committed, true);
    eq("turn.commit.one-entry", s.history.list().labels.length, 1);
    eq("turn.commit.label", s.history.list().labels[0], "ai: 画一条线并铺底色");
    eq("turn.closed", s.aiTurnOpen(), false);
    // 一条 undo 覆盖整轮
    s.undo();
    eq("turn.undo.layers", s.doc.layers.length, 3);

    // rollback：回到回合开始，逐字节一致（含历史不落账）
    const s2 = live();
    const ctx2 = mkCtx(s2, { tier: "draw" });
    const bytes2 = docBytes(s2);
    call(post("turn_begin", { label: "放弃这一轮" }), ctx2);
    await callAsync(post("call_tool", { id: "layer_add", args: {} }), ctx2);
    const rb = call(post("turn_rollback"), ctx2);
    eq("turn.rollback.true", rb.json.result.rolledBack, true);
    eq("turn.rollback.bytes", docBytes(s2), bytes2);
    eq("turn.rollback.history", s2.history.list().labels.length, 0);
    eq("turn.rollback.closed", s2.aiTurnOpen(), false);
    // 幂等：再回滚一次仍是空操作
    eq("turn.rollback.idempotent", call(post("turn_rollback"), ctx2).json.result.rolledBack, false);

    // 路由抛异常时必须把回合回滚掉（影子残留 = 用户丢撤销）：
    // 让 turn_preview 抛错（影子掉实例方法，不动 Session 原型），并断言影子真的还回去了
    const s3 = live();
    const ctx3 = mkCtx(s3, { tier: "draw" });
    call(post("turn_begin", { label: "异常路径" }), ctx3);
    await callAsync(post("call_tool", { id: "layer_add", args: {} }), ctx3);
    eq("turn.throw.open", s3.aiTurnOpen(), true);
    (s3 as unknown as { previewAiTurn: () => unknown }).previewAiTurn = () => { throw new Error("boom"); };
    const boom = call(post("turn_preview"), ctx3);
    eq("turn.throw.503", boom.status, 503);
    ok("turn.throw.internal", String(boom.json.error).indexOf("internal") >= 0, boom.json.error);
    eq("turn.throw.rolled-back", s3.aiTurnOpen(), false);
    // 影子还原的机械证据：回合之后用户的正常操作照旧进历史（残留的话这里会是 0 条）
    s3.history.clear();
    s3.layerAdd();
    eq("turn.throw.history-restored", s3.history.list().labels.length, 1);

    // ---- 闸门（b）：嵌套 turn_begin 先收尾上一个（不报错、不叠加，带 warn）----
    const s4 = live();
    const ctx4 = mkCtx(s4, { tier: "draw" });
    const bytes4 = docBytes(s4);
    const t1 = call(post("turn_begin", { label: "第一轮" }), ctx4);
    await callAsync(post("call_tool", { id: "layer_add", args: {} }), ctx4);
    eq("turn.nested.first-dirty", s4.doc.layers.length, 4);
    const t2 = call(post("turn_begin", { label: "第二轮" }), ctx4);
    eq("turn.nested.warn", t2.json.result.warn, "previous turn rolled back");
    eq("turn.nested.new-turn-id", t2.json.result.turnId > t1.json.result.turnId, true);
    eq("turn.nested.previous-rolled-back", docBytes(s4), bytes4); // 第一轮的改动静默丢掉，但**有说法**
    eq("turn.nested.no-history", s4.history.list().labels.length, 0);
    eq("turn.nested.still-open", s4.aiTurnOpen(), true);
    await callAsync(post("call_tool", { id: "layer_add", args: {} }), ctx4);
    eq("turn.nested.commit", call(post("turn_commit"), ctx4).json.result.committed, true);
    eq("turn.nested.one-entry", s4.history.list().labels.length, 1);
    eq("turn.nested.label", s4.history.list().labels[0], "ai: 第二轮");
    // 没有嵌套时结果里不该有 warn
    eq("turn.nested.no-warn", call(post("turn_begin", { label: "单轮" }), ctx4).json.result.warn, undefined);
    eq("turn.nested.cleanup", call(post("turn_rollback"), ctx4).json.result.rolledBack, true);

    // ---- 闸门（c）：空闲收尾（外部 agent 断线后再也不说话）----
    const s5 = live();
    const ctx5 = mkCtx(s5, { tier: "draw" });
    const bytes5 = docBytes(s5);
    eq("turn.idle.default-sec", aiTurnIdleSeconds(), 300);
    eq("turn.idle.set", setAiTurnIdleSeconds(0.05), 0.05);
    call(post("turn_begin", { label: "断线的那一轮" }), ctx5);
    await callAsync(post("call_tool", { id: "layer_add", args: {} }), ctx5);
    eq("turn.idle.dirty", s5.doc.layers.length, 4);
    await new Promise((r) => setTimeout(r, 80));
    const st5 = call(post("status"), ctx5);
    eq("turn.idle.closed", st5.json.result.turnOpen, false);
    eq("turn.idle.rolled-back", docBytes(s5), bytes5);
    eq("turn.idle.counted", st5.json.result.turnIdleRollbacks >= 1, true);
    eq("turn.idle.policy-in-status", typeof st5.json.result.turnPolicy === "string" && st5.json.result.turnPolicy.indexOf("空闲") >= 0, true);
    ok("turn.idle.policy-text", String(st5.json.result.turnPolicy).indexOf("嵌套") >= 0, String(st5.json.result.turnPolicy));
    // 影子还原：用户的正常操作照旧进历史
    s5.history.clear();
    s5.layerAdd();
    eq("turn.idle.history-restored", s5.history.list().labels.length, 1);
    // 宿主定时器也能直接收尾（纯判定入口），且重复调用是空操作
    call(post("turn_begin", { label: "再断一次" }), ctx5);
    await new Promise((r) => setTimeout(r, 80));
    eq("turn.idle.expire-direct", expireIdleTurn(s5), true);
    eq("turn.idle.expire-direct-idempotent", expireIdleTurn(s5), false);
    eq("turn.idle.closed-again", s5.aiTurnOpen(), false);
    eq("turn.idle.off", setAiTurnIdleSeconds(0), 0);
    call(post("turn_begin", { label: "空闲收尾关掉" }), ctx5);
    await new Promise((r) => setTimeout(r, 60));
    eq("turn.idle.off-keeps-open", s5.aiTurnOpen(), true);
    eq("turn.idle.expire-when-off", expireIdleTurn(s5), false);
    call(post("turn_rollback"), ctx5);
    eq("turn.idle.restore-default", setAiTurnIdleSeconds(AI_TURN_IDLE_SEC_DEFAULT), 300);

    // ---- t15 的复合入口（「一次调用 = 一整轮」用它，不是协议动词）----
    const s8 = live();
    const r8 = await s8.runAiTurn("复合一轮", async () => {
      const r = await callAsync(post("call_tool", { id: "layer_add", args: {} }), mkCtx(s8, { tier: "draw" }));
      return r.json.ok;
    });
    eq("turn.run.ok", r8.ok, true);
    eq("turn.run.result", r8.result, true);
    eq("turn.run.closed", s8.aiTurnOpen(), false);
    eq("turn.run.one-entry", s8.history.list().labels.length, 1);
    eq("turn.run.label", s8.history.list().labels[0], "ai: 复合一轮");
    const r8b = await s8.runAiTurn("会抛的一轮", () => { throw new Error("nope"); });
    eq("turn.run.error-ok-false", r8b.ok, false);
    ok("turn.run.error-text", String(r8b.error).indexOf("nope") >= 0, String(r8b.error));
    eq("turn.run.error-closed", s8.aiTurnOpen(), false);
    eq("turn.run.error-no-entry", s8.history.list().labels.length, 1);
  }

  // ================================================================ 8. 两个入口一致
  {
    const s = live();
    const ctx = mkCtx(s, { tier: "all" });
    const reqs: Array<[string, AiRpcRequest]> = [
      ["health", get("/ai/health")],
      ["list_tools", post("list_tools")],
      ["digest", post("digest")],
      ["read_region", post("read_region", { x: 0, y: 0, w: 2, h: 2 })],
      ["status", post("status")],
      ["turn_preview", post("turn_preview")],
      ["turn_commit", post("turn_commit")],
      ["turn_rollback", post("turn_rollback")],
      ["404", get("/nope")],
      ["405", get("/ai")],
      ["401", get("/ai/health", OTHER_TOKEN)],
      ["400", { method: "POST", path: "/ai", token: TOKEN, body: "{" }],
    ];
    for (const [name, req] of reqs) {
      const a = handleAiRequest(req, ctx);
      const b = await handleAiRequestAsync(req, ctx);
      eq("both." + name, a.body, b.body);
      eq("both." + name + ".status", a.status, b.status);
    }
    // call_tool 是唯一分岔：同步回哨兵，异步给真结果
    const sync = handleAiRequest(post("call_tool", { id: "doc_digest", args: {} }), ctx);
    eq("both.call_tool.sync-sentinel", sync.body, AI_RPC_ASYNC_BODY);
    const async1 = await handleAiRequestAsync(post("call_tool", { id: "doc_digest", args: {} }), ctx);
    eq("both.call_tool.async-real", JSON.parse(async1.body).ok, true);
  }

  // ================================================================ 9. ai-serve
  {
    // 无桥接（stubEnv 的 PixelBridge 只有 toast/vibrate）→ 全降级、不抛
    eq("serve.random-token.shape", /^[0-9a-f]{32}$/.test(randomToken()), true);
    const tokens: string[] = [];
    for (let i = 0; i < 12; i++) tokens.push(randomToken());
    eq("serve.random-token.unique", new Set(tokens).size, 12);

    const s = live();
    // 声明式设置先关掉：默认状态不起服务（下面逐个打开来测三条启动路径）
    saveAiServeSettings({ server: false, port: 8787, tier: "read" });
    const notices: Array<{ running: boolean; reason: string; port: number; token: string }> = [];
    let st = installAiServe({ session: s, version: "9.9.9-test", notice: (n) => notices.push(n) });
    eq("serve.default-off.installed", st.installed, true);
    eq("serve.default-off.running", st.running, false);
    eq("serve.default-off.reason", st.reason, "disabled");
    eq("serve.globals.registered", typeof win().__pc_ai_call, "function");
    eq("serve.globals.diag", typeof (win().__pcAi as any).text, "function");

    // 打开设置但没有原生桥接 → no-bridge 降级（不抛、不占端口）
    saveAiServeSettings({ server: true });
    st = installAiServe({ session: s, version: "9.9.9-test", notice: (n) => notices.push(n) });
    eq("serve.no-bridge.running", st.running, false);
    eq("serve.no-bridge.reason", st.reason, "no-bridge");
    eq("serve.no-bridge.token", st.token, "");
    eq("serve.no-bridge.notice", notices[notices.length - 1].reason, "no-bridge");

    // 快路径：health 走 __pc_ai_call 直接回一行 JSON
    const health = String((win().__pc_ai_call as (a: string, b: string) => string)(
      JSON.stringify({ method: "GET", path: "/ai/health", body: "" }), "req-1"));
    eq("serve.health.ok", JSON.parse(health).result.version, "9.9.9-test");
    eq("serve.health.sync-counted", aiServeStatus().syncCalls >= 1, true);
    // 坏 envelope
    const badEnv = String((win().__pc_ai_call as (a: string, b: string) => string)("{oops", "req-2"));
    ok("serve.bad-envelope", JSON.parse(badEnv).error.indexOf("envelope") >= 0, badEnv);

    // 挂起：call_tool 回空串，随后由 aiRespond 交付
    const delivered: Array<{ id: string; json: string }> = [];
    let respondOk = true;
    const pb = {
      toast: () => {}, vibrate: () => true,
      aiServerStart: () => "",
      aiServerStop: () => {},
      aiServerStatus: () => '{"running":false}',
      aiRespond: (id: string, json: string) => { delivered.push({ id, json }); return respondOk; },
    };
    setBridge(pb);
    st = installAiServe({ session: s, version: "9.9.9-test", notice: (n) => notices.push(n) });
    eq("serve.start.port", st.port, 8787);
    eq("serve.start.running", st.running, false);
    eq("serve.start.bind-failed", st.reason, "bind-failed");
    eq("serve.start.notice", notices.length > 0, true);
    eq("serve.start.notice-reason", notices[notices.length - 1].reason, "bind-failed");

    // 绑定成功：token 来自 Java，notice 里有端口 + token
    let starts = 0;
    let stopped = 0;
    pb.aiServerStart = () => { starts++; return "aabbccddeeff00112233445566778899"; };
    pb.aiServerStop = () => { stopped++; };
    st = installAiServe({ session: s, version: "9.9.9-test", notice: (n) => notices.push(n) });
    eq("serve.native.running", st.running, true);
    eq("serve.native.port", st.port, 8787);
    eq("serve.native.token", st.token, "aabbccddeeff00112233445566778899");
    eq("serve.native.starts", starts, 1);
    eq("serve.native.notice-token", notices[notices.length - 1].token, "aabbccddeeff00112233445566778899");
    eq("serve.native.notice-port", notices[notices.length - 1].port, 8787);
    ok("serve.native.text", aiServeStatusText().indexOf("127.0.0.1:8787") >= 0, aiServeStatusText());
    ok("serve.text.confirm-note", aiServeStatusText().indexOf("确认器=默认拒绝") >= 0, aiServeStatusText());

    // 挂起 + 交付：call_tool 回空串，一轮微任务之后 aiRespond 拿到窗口内的 JSON
    const call1 = win().__pc_ai_call as (a: string, b: string) => string;
    const env = (callName: string, args?: unknown): string =>
      JSON.stringify({ method: "POST", path: "/ai", body: JSON.stringify({ call: callName, args }) });
    const pendingOut = String(call1(env("call_tool", { id: "doc_digest", args: {} }), "req-async"));
    eq("serve.async.returns-empty", pendingOut, "");
    eq("serve.async.pending", aiServeStatus().pending, 1);
    await new Promise((r) => setTimeout(r, 0));
    eq("serve.async.delivered", delivered.length, 1);
    eq("serve.async.requestId", delivered[0].id, "req-async");
    eq("serve.async.body-ok", JSON.parse(delivered[0].json).ok, true);
    eq("serve.async.pending-drained", aiServeStatus().pending, 0);
    eq("serve.async.responds", aiServeStatus().responds, 1);

    // aiRespond 返回 false（10s 超时 / 已交付）→ 只记诊断，不重试
    respondOk = false;
    eq("serve.async.timeout.empty", String(call1(env("call_tool", { id: "doc_digest", args: {} }), "req-timeout")), "");
    await new Promise((r) => setTimeout(r, 0));
    eq("serve.async.failures", aiServeStatus().respondFailures, 1);
    ok("serve.async.last-error", aiServeStatus().lastError.indexOf("false") >= 0, aiServeStatus().lastError);
    respondOk = true;

    // 默认确认器：经桥接的 destructive 也是 cancelled（async 路径）
    // （先升档到 all，否则在 read 档就会被服务层直接挡掉，走不到确认器）
    const tokenBeforeTier = aiServeStatus().token;
    saveAiServeSettings({ tier: "all" });
    eq("serve.tier.all", aiServeStatus().tier, "all");
    // 只换档位不该重启端口、更不该轮换 token（不然正在用的客户端会突然 401）
    eq("serve.tier.no-restart", starts, 1);
    eq("serve.tier.token-kept", aiServeStatus().token, tokenBeforeTier);
    delivered.length = 0;
    eq("serve.async.empty-destructive", String(call1(env("call_tool", { id: "canvas_clear", args: {} }), "req-d")), "");
    await new Promise((r) => setTimeout(r, 0));
    eq("serve.async.cancelled", JSON.parse(delivered[0].json).error, "cancelled");

    // 注入真确认器 → 放行，且 status 说明「宿主已接入」
    setAiConfirmer(async () => true);
    eq("serve.confirmer.injected", aiServeStatus().confirm, "injected");
    delivered.length = 0;
    const bytesBefore = docBytes(s);
    eq("serve.confirm.empty", String(call1(env("call_tool", { id: "canvas_clear", args: {} }), "req-d2")), "");
    await new Promise((r) => setTimeout(r, 0));
    eq("serve.confirm.ran", JSON.parse(delivered[0].json).ok, true);
    ok("serve.confirm.cleared-pixels", docBytes(s) !== bytesBefore);
    setAiConfirmer(null);
    eq("serve.confirmer.back-to-deny", aiServeStatus().confirm, "denied-by-default");

    // 改设置即时起停（声明式设置的 after 链路）
    // ---- R2：**关设置的路径也必须收尾回合**（关服务后才丢影子 = 用户此后丢撤销）----
    const sOff = live();
    setBridge(pb);
    saveAiServeSettings({ tier: "draw", port: 8787, server: true });
    installAiServe({ session: sOff, version: "9.9.9-test", notice: (n) => notices.push(n) });
    const callOff = win().__pc_ai_call as (a: string, b: string) => string;
    const bytesOff = docBytes(sOff);
    eq("serve.settings.off-begin", JSON.parse(callOff(env("turn_begin", { label: "关设置时开着" }), "req-off1")).ok, true);
    eq("serve.settings.off-write", String(callOff(env("call_tool", { id: "layer_add", args: {} }), "req-off2")), "");
    await new Promise((r) => setTimeout(r, 0));
    eq("serve.settings.off-turn-open", sOff.aiTurnOpen(), true);
    eq("serve.settings.off-guard-armed", aiServeStatus().idleGuardArmed, true);
    const stoppedBeforeOff = stopped;
    saveAiServeSettings({ server: false });
    eq("serve.settings.off-stops", stopped, stoppedBeforeOff + 1);
    eq("serve.settings.off-running", aiServeStatus().running, false);
    eq("serve.settings.off-reason", aiServeStatus().reason, "disabled");
    // 回合被收尾、文档逐字节回到回合前、影子还回去了（用户此后照旧能撤销）
    eq("serve.settings.off-turn-closed", sOff.aiTurnOpen(), false);
    eq("serve.settings.off-turn-restored", docBytes(sOff), bytesOff);
    eq("serve.settings.off-guard-cleared", aiServeStatus().idleGuardArmed, false);
    sOff.history.clear();
    sOff.layerAdd();
    eq("serve.settings.off-shadow-restored", sOff.history.list().labels.length, 1);

    saveAiServeSettings({ tier: "read" });
    saveAiServeSettings({ server: true, port: 9100 });
    eq("serve.settings.on-running", aiServeStatus().running, true);
    eq("serve.settings.on-port", aiServeStatus().port, 9100);
    eq("serve.settings.on-tier", aiServeStatus().tier, "read");

    // ---- 停止服务必须收尾回合（影子残留 = 用户此后丢撤销）----
    // 注意：live() 里的 stubEnv() 会把 window.PixelBridge 换回最朴素的桩，所以桥接要**在它之后**再装
    saveAiServeSettings({ tier: "draw", port: 8787, server: true });
    const s2 = live();
    setBridge(pb);
    st = installAiServe({ session: s2, version: "9.9.9-test", notice: (n) => notices.push(n) });
    eq("serve.turn.start", st.running, true);
    const bytes2 = docBytes(s2);
    const call2 = win().__pc_ai_call as (a: string, b: string) => string;
    // turn_begin 是**同步** call（快路径直接回一行 JSON）；只有 call_tool 才挂起回空串
    const beginJson = call2(env("turn_begin", { label: "开着就被停了" }), "req-tb");
    eq("serve.turn.begin-sync", JSON.parse(beginJson).ok, true);
    eq("serve.turn.open", s2.aiTurnOpen(), true);
    eq("serve.turn.status-open", aiServeStatus().turnOpen, true);
    eq("serve.turn.write", String(call2(env("call_tool", { id: "layer_add", args: {} }), "req-tw")), "");
    await new Promise((r) => setTimeout(r, 0));
    eq("serve.turn.dirty", s2.doc.layers.length, 4);
    const stoppedStatus = stopAiServe();
    eq("serve.turn.stop-rolled-back", stoppedStatus.turnOpen, false);
    eq("serve.turn.stop-closed", s2.aiTurnOpen(), false);
    eq("serve.turn.stop-restored", docBytes(s2), bytes2);
    ok("serve.turn.stop-counted", aiServeStatus().rollbacks >= 1, String(aiServeStatus().rollbacks));
    s2.history.clear();
    s2.layerAdd();
    eq("serve.turn.stop-shadow-restored", s2.history.list().labels.length, 1);

    // ---- 空闲兜底定时器：agent 断线后再也不来请求也能收尾 ----
    const s6 = live();
    setBridge(pb);
    const bytes6 = docBytes(s6);
    st = installAiServe({ session: s6, version: "9.9.9-test", turnIdleSec: 0.05, notice: () => {} });
    eq("serve.idle.policy", st.turnIdleSec, 0.05);
    eq("serve.idle.running", st.running, true);
    const call6 = win().__pc_ai_call as (a: string, b: string) => string;
    eq("serve.idle.begin-sync", JSON.parse(call6(env("turn_begin", { label: "断线" }), "req-i1")).ok, true);
    eq("serve.idle.begin-open", s6.aiTurnOpen(), true);
    eq("serve.idle.write", String(call6(env("call_tool", { id: "layer_add", args: {} }), "req-i2")), "");
    await new Promise((r) => setTimeout(r, 0));
    eq("serve.idle.open", s6.aiTurnOpen(), true);
    await new Promise((r) => setTimeout(r, 300));
    eq("serve.idle.timer-closed", s6.aiTurnOpen(), false);
    eq("serve.idle.timer-restored", docBytes(s6), bytes6);
    eq("serve.idle.status-closed", aiServeStatus().turnOpen, false);
    s6.history.clear();
    s6.layerAdd();
    eq("serve.idle.shadow-restored", s6.history.list().labels.length, 1);

    // ---- R1：**省略** turnIdleSec（= 生产接线）也必须真的武装守卫，且三处诊断同源 ----
    // 旧缺陷：state.turnIdleSec 初值 0 且只在传了 deps.turnIdleSec 时才赋值 → 生产接线永不武装，
    // 而 status 一边报 300s、一边报「∞s」，从诊断上根本看不出来。
    saveAiServeSettings({ server: true, port: 8787, tier: "draw", turnIdleSec: AI_TURN_IDLE_SEC_DEFAULT });
    const s10 = live();
    setBridge(pb);
    const st10 = installAiServe({ session: s10, version: "9.9.9-test", notice: () => {} }); // ← 不传 turnIdleSec
    eq("serve.idle.default.not-zero", st10.turnIdleSec, AI_TURN_IDLE_SEC_DEFAULT);
    eq("serve.idle.default.router", aiTurnIdleSeconds(), AI_TURN_IDLE_SEC_DEFAULT);
    eq("serve.idle.default.text", st10.turnIdleText, "300s");
    ok("serve.idle.default.text-no-infinity", aiServeStatusText().indexOf("∞") < 0, aiServeStatusText());
    const call10 = win().__pc_ai_call as (a: string, b: string) => string;
    // 三处诊断（router 的 status.turnIdleSec / turnPolicy、ai-serve 的 turnGuard / 文本）必须是同一个数
    const stJson = JSON.parse(call10(env("status"), "req-d0")).result;
    eq("serve.idle.default.status.router", stJson.turnIdleSec, AI_TURN_IDLE_SEC_DEFAULT);
    ok("serve.idle.default.status.policy", String(stJson.turnPolicy).indexOf("300s") >= 0, String(stJson.turnPolicy));
    ok("serve.idle.default.status.guard", String(stJson.turnGuard).indexOf("300s") >= 0, String(stJson.turnGuard));
    ok("serve.idle.default.status.guard-armed-flag", String(stJson.turnGuard).indexOf("未武装") >= 0, String(stJson.turnGuard));
    eq("serve.idle.default.guard-idle", aiServeStatus().idleGuardArmed, false); // 还没回合
    eq("serve.idle.default.begin", JSON.parse(call10(env("turn_begin", { label: "默认档位" }), "req-d1")).ok, true);
    // ★ R1 的验收点：默认值下守卫也必须装上了（旧写法这里是 false）
    eq("serve.idle.default.guard-armed", aiServeStatus().idleGuardArmed, true);
    eq("serve.idle.default.open", s10.aiTurnOpen(), true);
    // 把秒数临时改小（仍走「install 默认 → 守卫已武装」这条路径）验证到点真的收尾
    eq("serve.idle.default.retune", (win().__pcAi as { setTurnIdleSec: (n: number) => number }).setTurnIdleSec(0.05), 0.05);
    eq("serve.idle.default.retune-armed", aiServeStatus().idleGuardArmed, true);
    await new Promise((r) => setTimeout(r, 300));
    eq("serve.idle.default.closed", s10.aiTurnOpen(), false);
    eq("serve.idle.default.guard-drained", aiServeStatus().idleGuardArmed, false);
    s10.history.clear();
    s10.layerAdd();
    eq("serve.idle.default.shadow-restored", s10.history.list().labels.length, 1);

    // ---- R1 语义：**显式 0 = 用户主动关闭**（别把 0 当成默认）----
    const s12 = live();
    setBridge(pb);
    const st12 = installAiServe({ session: s12, version: "9.9.9-test", turnIdleSec: 0, notice: () => {} });
    eq("serve.idle.zero.reported", st12.turnIdleSec, 0);
    eq("serve.idle.zero.text", st12.turnIdleText, "∞s（已关闭）");
    eq("serve.idle.zero.router", aiTurnIdleSeconds(), 0);
    const call12 = win().__pc_ai_call as (a: string, b: string) => string;
    const st12Json = JSON.parse(call12(env("status"), "req-z0")).result;
    eq("serve.idle.zero.status", st12Json.turnIdleSec, 0);
    ok("serve.idle.zero.policy", String(st12Json.turnPolicy).indexOf("已关闭") >= 0, String(st12Json.turnPolicy));
    ok("serve.idle.zero.guard-text", String(st12Json.turnGuard).indexOf("∞s（已关闭）") >= 0, String(st12Json.turnGuard));
    eq("serve.idle.zero.begin", JSON.parse(call12(env("turn_begin", { label: "关掉兜底" }), "req-z1")).ok, true);
    eq("serve.idle.zero.not-armed", aiServeStatus().idleGuardArmed, false);
    eq("serve.idle.zero.no-expire", expireIdleTurn(s12, Date.now() + 10 * 60 * 1000), false);
    eq("serve.idle.zero.still-open", s12.aiTurnOpen(), true);
    eq("serve.idle.zero.rollback", JSON.parse(call12(env("turn_rollback"), "req-z2")).ok, true);

    // ---- 默认 300s 的策略本体（用注入的 now 推假时钟，不用真等 5 分钟）----
    const s13 = live();
    setBridge(pb);
    saveAiServeSettings({ server: true, port: 8787, tier: "draw", turnIdleSec: AI_TURN_IDLE_SEC_DEFAULT });
    installAiServe({ session: s13, version: "9.9.9-test", notice: () => {} }); // 不传 → 设置项的 300
    const call13 = win().__pc_ai_call as (a: string, b: string) => string;
    const bytes13 = docBytes(s13);
    eq("serve.idle.300.begin", JSON.parse(call13(env("turn_begin", { label: "假时钟" }), "req-k1")).ok, true);
    eq("serve.idle.300.policy", aiTurnIdleSeconds(), 300);
    eq("serve.idle.300.clock", aiTurnClock().idleSec, 300);
    eq("serve.idle.300.not-yet", expireIdleTurn(s13, Date.now() + 299 * 1000), false);
    eq("serve.idle.300.still-open", s13.aiTurnOpen(), true);
    // 注意 `expireIdleTurn()` 是**带刷新**的语义（宿主定时器 tick = 还活着），所以上面那一下
    // 已经把活动时间推到了 +299s —— 下面用一个新回合直接跳到 +301s 验「到点必收」
    eq("serve.idle.300.rollback", JSON.parse(call13(env("turn_rollback"), "req-k2")).ok, true);
    eq("serve.idle.300.begin2", JSON.parse(call13(env("turn_begin", { label: "假时钟 2" }), "req-k3")).ok, true);
    eq("serve.idle.300.after", expireIdleTurn(s13, Date.now() + 301 * 1000), true);
    eq("serve.idle.300.closed", s13.aiTurnOpen(), false);
    eq("serve.idle.300.restored", docBytes(s13), bytes13);

    // ---- R3：无 token 的垃圾请求**不能**给回合续命（它只判定超时、不刷新活动时间）----
    // 先摘掉 ai-serve（这一段只测路由的鉴权/超时顺序，别让宿主的守卫掺进来）
    uninstallAiServe();
    saveAiServeSettings({ server: true, port: 8787, tier: "draw", turnIdleSec: AI_TURN_IDLE_SEC_DEFAULT });
    const s11 = live();
    const ctx11 = mkCtx(s11, { tier: "draw" });
    setAiTurnIdleSeconds(0.05);
    const bytes11 = docBytes(s11); // 回合**之前**的样子：超时收尾就是回到这里
    call(post("turn_begin", { label: "被垃圾请求围住的一轮" }), ctx11);
    await callAsync(post("call_tool", { id: "layer_add", args: {} }), ctx11);
    eq("turn.idle.unauth.open", s11.aiTurnOpen(), true);
    eq("turn.idle.unauth.dirty", s11.doc.layers.length, 4);
    let closedAt = -1;
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 30));
      eq("turn.idle.unauth.401-" + i, call(get("/ai/health", OTHER_TOKEN), ctx11).status, 401);
      if (!s11.aiTurnOpen() && closedAt < 0) closedAt = i;
    }
    ok("turn.idle.unauth.closed-by-timeout", s11.aiTurnOpen() === false, "closedAt=" + closedAt);
    ok("turn.idle.unauth.not-first-request", closedAt >= 1, "closedAt=" + closedAt);
    eq("turn.idle.unauth.restored", docBytes(s11), bytes11);
    s11.history.clear();
    s11.layerAdd();
    eq("turn.idle.unauth.shadow-restored", s11.history.list().labels.length, 1);
    setAiTurnIdleSeconds(AI_TURN_IDLE_SEC_DEFAULT);
    uninstallAiServe();

    eq("serve.stop", stopAiServe().reason, "stopped");
    setAiTurnIdleSeconds(AI_TURN_IDLE_SEC_DEFAULT);

    uninstallAiServe();
    eq("serve.uninstall.removes-global", win().__pc_ai_call, undefined);
    eq("serve.uninstall.status", aiServeStatus().installed, false);
    // uninstall 也会停掉正在跑的端口服务
    const s7 = live();
    setBridge(pb);
    saveAiServeSettings({ server: true });
    eq("serve.uninstall.reinstall", installAiServe({ session: s7, version: "9.9.9-test" }).running, true);
    const stopBefore = stopped;
    uninstallAiServe();
    eq("serve.uninstall.stops-native", stopped, stopBefore + 1);
    saveAiServeSettings({ server: false, port: 8787, tier: "read" });

    // ---- 真正的 Node（连 window 都没有）：import / install / 处理请求全部不抛 ----
    const savedWindow = win();
    saveAiServeSettings({ server: true }); // 用户打开了服务，但环境里没有原生桥接
    delete (globalThis as { window?: unknown }).window;
    try {
      const s9 = mkSession(); // stubEnv 会重新造 window；下面再删一次
      delete (globalThis as { window?: unknown }).window;
      const st9 = installAiServe({ session: s9, version: "9.9.9-test" });
      eq("serve.no-window.installed", st9.installed, true);
      eq("serve.no-window.reason", st9.reason, "no-bridge");
      const h9 = aiServeHandleCall(JSON.stringify({ method: "GET", path: "/ai/health", body: "" }), "req-nw");
      eq("serve.no-window.health", JSON.parse(h9).result.version, "9.9.9-test");
      const t9 = aiServeHandleCall(JSON.stringify({ method: "POST", path: "/ai", body: JSON.stringify({ call: "turn_begin", args: { label: "无 window" } }) }), "req-nw2");
      eq("serve.no-window.turn", JSON.parse(t9).ok, true);
      // 没有 PixelBridge.aiRespond → 异步结果只能被丢弃，且只记诊断
      eq("serve.no-window.async-empty", aiServeHandleCall(JSON.stringify({ method: "POST", path: "/ai", body: JSON.stringify({ call: "call_tool", args: { id: "doc_digest", args: {} } }) }), "req-nw3"), "");
      await new Promise((r) => setTimeout(r, 0));
      eq("serve.no-window.respond-failures", aiServeStatus().respondFailures >= 1, true);
      ok("serve.no-window.last-error", aiServeStatus().lastError.indexOf("桥接") >= 0, aiServeStatus().lastError);
      uninstallAiServe();
    } finally {
      (globalThis as { window?: unknown }).window = savedWindow;
    }
  }

  // ================================================================ 10. 设置项
  {
    const s = live();
    stubEnv();
    const serverDef = SETTINGS_BY_PATH.get("ai.server");
    const portDef = SETTINGS_BY_PATH.get("ai.port");
    const tierDef = SETTINGS_BY_PATH.get("ai.tier");
    const idleDef = SETTINGS_BY_PATH.get("ai.turnIdleSec");
    ok("settings.declared", !!serverDef && !!portDef && !!tierDef && !!idleDef);
    eq("settings.kind.bool", serverDef!.kind, "bool");
    eq("settings.default.off", serverDef!.default, false);
    eq("settings.group", serverDef!.group, "ai");
    eq("settings.port.kind", portDef!.kind, "int");
    eq("settings.port.default", portDef!.default, 8787);
    eq("settings.port.range", [portDef!.min, portDef!.max], [AI_PORT_MIN, AI_PORT_MAX]);
    eq("settings.tier.kind", tierDef!.kind, "enum");
    eq("settings.tier.default", tierDef!.default, "read");
    eq("settings.tier.options", (tierDef!.options ?? []).map((o) => o.value), ["read", "draw", "all"]);
    // R1：空闲收尾也是一个声明式设置项（main.tsx 就是读它接线的），默认 300s、0 = 关闭
    eq("settings.idle.kind", idleDef!.kind, "int");
    eq("settings.idle.default", idleDef!.default, AI_TURN_IDLE_SEC_DEFAULT);
    eq("settings.idle.default-not-zero", idleDef!.default !== 0, true);
    eq("settings.idle.range", [idleDef!.min, idleDef!.max], [0, AI_TURN_IDLE_SEC_MAX]);
    eq("settings.idle.unit", idleDef!.unit, "s");
    // 值走 get/set（不进 prefs），往返必须通
    saveAiServeSettings({ server: false });
    eq("settings.value.default-off", s.settingValue("ai.server"), false);
    // 没打开时只露一条（端口与档位藏着）
    eq("settings.visible.off", settingsOfGroup(s, "ai").map((d) => d.path), ["ai.server"]);
    s.setSetting("ai.server", true);
    eq("settings.value.on", aiServeSettings().server, true);
    eq("settings.visible.on", settingsOfGroup(s, "ai").map((d) => d.path), ["ai.server", "ai.port", "ai.tier", "ai.turnIdleSec"]);
    s.setSetting("ai.port", 9001);
    eq("settings.port.set", aiServeSettings().port, 9001);
    eq("settings.port.getter", s.settingValue("ai.port"), 9001);
    s.setSetting("ai.tier", "draw");
    eq("settings.tier.set", aiServeSettings().tier, "draw");
    s.setSetting("ai.turnIdleSec", 120);
    eq("settings.idle.set", aiServeSettings().turnIdleSec, 120);
    eq("settings.idle.getter", s.settingValue("ai.turnIdleSec"), 120);
    s.setSetting("ai.turnIdleSec", 0);
    eq("settings.idle.zero-kept", aiServeSettings().turnIdleSec, 0); // 0 不是「无值」，是「关闭」
    s.setSetting("ai.turnIdleSec", 999999);
    eq("settings.idle.clamped-high", aiServeSettings().turnIdleSec, AI_TURN_IDLE_SEC_MAX);
    s.setSetting("ai.turnIdleSec", -5);
    eq("settings.idle.clamped-low", aiServeSettings().turnIdleSec, 0);
    s.setSetting("ai.turnIdleSec", AI_TURN_IDLE_SEC_DEFAULT);
    // 越界被 normalizeSetting 夹住（端口 80 → 1024）
    s.setSetting("ai.port", 80);
    eq("settings.port.clamped", aiServeSettings().port, AI_PORT_MIN);
    s.setSetting("ai.port", 999999);
    eq("settings.port.clamped-high", aiServeSettings().port, AI_PORT_MAX);
    // 归一化 + 持久化 + 监听
    eq("settings.normalize.bad-tier", normalizeAiServeSettings({ tier: "root" }).tier, "read");
    eq("settings.normalize.bad-port", normalizeAiServeSettings({ port: "abc" }).port, 8787);
    eq("settings.normalize.truthy-not-true", normalizeAiServeSettings({ server: 1 }).server, false);
    eq("settings.normalize.idle-default", normalizeAiServeSettings({}).turnIdleSec, AI_TURN_IDLE_SEC_DEFAULT);
    eq("settings.normalize.idle-bad", normalizeAiServeSettings({ turnIdleSec: "abc" }).turnIdleSec, AI_TURN_IDLE_SEC_DEFAULT);
    eq("settings.normalize.idle-zero", normalizeAiServeSettings({ turnIdleSec: 0 }).turnIdleSec, 0);
    eq("settings.normalize.idle-neg", normalizeAiServeSettings({ turnIdleSec: -60 }).turnIdleSec, 0);
    const seen: string[] = [];
    const off = onAiServeSettingsChange((v) => seen.push(v.tier));
    saveAiServeSettings({ tier: "all" });
    saveAiServeSettings({ tier: "read" });
    off();
    saveAiServeSettings({ tier: "draw" });
    eq("settings.listener.fired-then-unsubscribed", seen, ["all", "read"]);
    const raw = JSON.parse(String((globalThis as any).localStorage.getItem(AI_SETTINGS_KEY)));
    eq("settings.persisted", raw.tier, "draw");
    saveAiServeSettings({ server: false, port: 8787, tier: "read", turnIdleSec: AI_TURN_IDLE_SEC_DEFAULT });
    eq("settings.reset", aiServeSettings(), { server: false, port: 8787, tier: "read", turnIdleSec: AI_TURN_IDLE_SEC_DEFAULT });
    // 没有新增 SettingKind（机械核对：类型别名只有四个字面量）
    const src = fs.readFileSync(path.resolve(__dirname, "../../../src/app/settings.ts"), "utf8") as string;
    ok("settings.no-new-kind", src.indexOf('export type SettingKind = "bool" | "int" | "enum" | "color";') >= 0);
    eq("settings.kind.count", (src.match(/export type SettingKind/g) ?? []).length, 1);
    // 每个 ai.* 声明的 label / desc / 选项都必须在中文与英文里各有一条
    const t = makeT("zh");
    const te = makeT("en");
    for (const d of SETTINGS.filter((x) => x.group === "ai")) {
      ok("i18n." + d.path + ".label", t(d.label) !== d.label && te(d.label) !== d.label, d.label);
      if (d.desc) ok("i18n." + d.path + ".desc", t(d.desc) !== d.desc && te(d.desc) !== d.desc, d.desc);
      for (const o of d.options ?? []) ok("i18n." + d.path + "." + o.value, t(o.label) !== o.label && te(o.label) !== o.label, o.label);
    }
    for (const key of ["groupAi", "aiServerNoticeOn", "aiServerNoticeOff", "aiTierRead", "aiTierDraw", "aiTierAll", "aiTurnIdleLabel", "aiTurnIdleDesc"]) {
      ok("i18n." + key, t(key) !== key && te(key) !== key, key);
    }
    for (const reason of Object.keys(AI_SERVE_REASON_KEYS) as Array<keyof typeof AI_SERVE_REASON_KEYS>) {
      const k = AI_SERVE_REASON_KEYS[reason];
      ok("i18n.reason." + reason, t(k) !== k && te(k) !== k, k);
    }
    // 通知文案的占位符真的被替换得掉
    ok("i18n.notice.placeholders", t("aiServerNoticeOn").indexOf("{port}") >= 0 && t("aiServerNoticeOff").indexOf("{reason}") >= 0);
  }

  // ================================================================ 11. 工具表可用性抽查
  // 48 个工具里挑三条走完整路径（read / draw / destructive），确认真能穿透到 Session
  {
    const s = live();
    eq("chain.read", (await callAsync(post("call_tool", { id: "color_analyse", args: {} }), mkCtx(s, { tier: "read" }))).json.ok, true);
    const w = await callAsync(post("call_tool", { id: "palette_add", args: { color: "#123456" } }), mkCtx(s, { tier: "draw" }));
    eq("chain.draw", w.json.ok, true);
    eq("chain.draw.palette", s.doc.palette.length, 3);
    const d = await callAsync(post("call_tool", { id: "layer_delete", args: {} }),
      mkCtx(s, { tier: "all", confirm: async () => true }));
    eq("chain.destructive", d.json.ok, true);
    eq("chain.destructive.layers", s.doc.layers.length, 2);
    // listTools 与路由列出来的是同一批 id
    const routed = call(post("list_tools", { tiers: ["read", "draw", "destructive"] }), mkCtx(s, { tier: "all" })).json.result.tools.map((x: any) => x.id);
    eq("chain.list-matches-table", routed.join(","), listTools({ tiers: ["read", "draw", "destructive"] }).map((x) => x.id).join(","));
    eq("chain.callTool-direct-untouched", typeof callTool, "function");
  }
}
