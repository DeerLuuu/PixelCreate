// C5 回归：应用内助手（src/app/ai-chat.ts + 设置项 + 面板接线）。
//
// 这一份测试盯的是「不要改回去」的几件事：
//   · **纯函数部分**：`listTools()` → OpenAI 兼容 tools schema（required / 类型 / 范围一一对上
//     `validateArgs` 的判定）、`tool_calls` 解析（缺 id / 参数不是 JSON 都不抛异常）、
//     消息拼装（assistant.tool_calls → 一条条 role=tool，tool_call_id 必须对得上）；
//   · **整轮循环**（假端点，两次 tool_calls 再回文本）：按顺序调了预期的工具、文档真的变了、
//     `docRev` 推进、**历史只多一条**、标签是 `ai: 用户那句话`；
//   · **预览后应用**：`commit:false` 时历史一动不动、回合开着，点「应用」才落一条，
//     点「放弃」逐字节回到这一轮开始；
//   · **失败不改文档**：模型第一轮已经画了东西、第二轮端点 500 / 网络异常 →
//     整轮 rollback，文档逐字节回原样、历史不变，错误是一句人话；
//   · **destructive 逐个确认**：`erase` 走 `ctx.confirm`，用户点取消时这一条 `cancelled`
//     且那一块像素一个字节没动；
//   · **key 只存在本机**：不进设置导出 / 导入、不进任何错误文本；
//   · **平台门**：没有原生桥接（浏览器 / Pages）时设置里连这一组都不显示、面板只渲染一句说明，
//     不挂输入框（静态接线 + SSR 各查一遍）。
import { Session } from "../src/app/session";
import {
  AI_CHAT_COMPLETIONS_PATH, AI_CHAT_DEFAULT_MAX_ROUNDS, AI_CHAT_HOST_KEY_SENTINEL, AI_CHAT_PROXY_CHAT_PATH,
  AI_CHAT_STREAM_FALLBACK_BROKEN, AI_CHAT_STREAM_FALLBACK_NOT_SSE,
  AI_CHAT_SYSTEM_PROMPT, AI_CHAT_TEMP_STEP, aiChatStatusText, appendToolResult, appendStreamChunk,
  assistantMessage, buildSystemPrompt, changedCount, chatCompletionsUrl, chatConfigError, chatProxyUrl,
  consumeSseStream, defaultTurnLabel, detectChatProxy, formatCallLog, newChatStreamState, parseSseData,
  parseToolCalls, proxyChatFetch, readHostProviderConfig, responseText, runChatTurn, splitSseChunk,
  streamResponse, systemMessage, toOpenAiTools, toolResultContent, userMessage,
} from "../src/app/ai-chat";
import type { ChatFetch, ChatFetchInit, ChatMessage, ChatTurnOpts } from "../src/app/ai-chat";
import { callTool, listTools, validateArgs } from "../src/app/ai-tools";
import type { AiToolCtx } from "../src/app/ai-tools";
import {
  AI_CHAT_DEFAULT_ENDPOINT, AI_CHAT_DEFAULT_MODEL, AI_CHAT_DEFAULT_PRESET, AI_CHAT_MAX_ROUNDS_MAX,
  AI_CHAT_PRESETS, AI_CHAT_SETTINGS_KEY, CHAT_SETTINGS, SETTINGS, SETTINGS_BY_PATH, SETTING_SECRET_PATHS,
  aiChatSettings, applyAiChatPreset, clearAiChatKey, exportSettings, importSettings, isSecretSettingPath,
  normalizeAiChatSettings, onAiChatSettingsChange, reloadAiChatSettings, saveAiChatSettings, settingsOfGroup,
} from "../src/app/settings";
import { aiChatPresetOf, normalizePresetId } from "../src/app/ai-presets";
import { isNativeShell } from "../src/io/bridge";
import { makeT } from "../src/ui/i18n";
import {
  AI_CHAT_BALL_KEY, AI_CHAT_WIN_KEY, AI_WIN_EDGE, CHAT_BALL_ID, ORB_IDS,
  aiBallDefaultPos, aiWinDefaultLayout, aiWinDragFrom, clampAiBallPos, clampAiWinLayout,
  normalizeAiBallPos, normalizeAiWinLayout,
} from "../src/app/uibar";
/** 副作用导入：把面板拉进编译图（它平时只被 ui/modals 引用），SSR 冒烟测试要用它 */
import * as aiPanelModule from "../src/ui/AiPanel";
import * as modalsModule from "../src/ui/modals";
import * as aiWindowModule from "../src/ui/AiWindow";
import {
  ChatBall, aiPanelDropsTurnOnUnmount, aiPanelShowsPreview, aiWinStore, chatTransport, noteAiWinClosed, resetChatTransport,
} from "../src/ui/AiPanel";
import { stubEnv } from "./session.test";
import { beginAiTurn, rollbackTurn } from "../src/app/ai-turn";
import { eq, ok } from "./common";

declare const require: (m: string) => any;
declare const __dirname: string;
const fs = require("fs");
const path = require("path");
/** **已编译**的 src/ 目录（用例跑在 <app>/tests/.ts-out/tests） */
const SRC = path.resolve(__dirname, "../src");

/** 一张有内容的会话：2 图层、一个红像素，历史清空 */
function live(): Session {
  const s = new Session();
  s.doc.palette = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]];
  s.layerAdd();
  s.doc.ensureCel(0, 0).setPixel(0, 0, [255, 0, 0, 255]);
  s.doc.ensureCel(1, 0).setPixel(1, 1, [0, 255, 0, 255]);
  s.history.clear();
  return s;
}

/** 文档逐字节（cel 字节 + 调色板 + 图层/帧数）；**不含 `doc.pixelRev`**（那是渲染缓存键） */
function docBytes(s: Session): string {
  const parts: string[] = [s.doc.w + "x" + s.doc.h, "pal=" + JSON.stringify(s.doc.palette),
    "layers=" + s.doc.layers.length, "frames=" + s.doc.frames.length];
  for (const k of Array.from(s.doc.cels.keys()).sort()) {
    const cel = s.doc.cels.get(k);
    if (cel) parts.push(k + "=" + Array.from(cel.data).join(","));
  }
  return parts.join("|");
}

const histLen = (s: Session): number => s.history.list().labels.length;

/** 某一格像素（cel 键是 `li:fi`，见 engine/doc.ts 的 Doc.key；cel 不存在 = 全透明） */
function px(s: Session, li: number, x: number, y: number): number[] {
  const cel = s.doc.cels.get(li + ":0");
  if (!cel) return [0, 0, 0, 0];
  const i = (y * s.doc.w + x) * 4;
  return [cel.data[i], cel.data[i + 1], cel.data[i + 2], cel.data[i + 3]];
}
const pxSoft = px;

/** C1 的调用上下文：confirm 可换；turn 用 C2 的真句柄（这就是 C1↔C2 的接缝） */
function toolCtx(s: Session, confirm: (req: { tool: string }) => Promise<boolean> = async () => true) {
  const asked: string[] = [];
  const ctx: AiToolCtx = {
    session: s,
    confirm: async (req) => { asked.push(req.tool); return confirm(req); },
    turn: s.aiTurnHandle(),
  };
  return { ctx, asked };
}

// ---------------------------------------------------------------- 假端点

/**
 * 一次假的模型回复。
 * `contentType` / `sse` 是**流式**那两个字段（见 `streamReply()`）：
 * `sse` 非空 = 这个响应有 `chunks()`，按块吐那些文本；`contentType` 决定算不算 SSE。
 */
interface Reply { status?: number; body?: string; thrown?: string; contentType?: string; sse?: string[] }
/** 记下一个请求：`init` 是**原样的** `ChatFetchInit`（所以「GET 到底带没带 body 字段」可断言） */
interface Seen { url: string; init: ChatFetchInit; headers: Record<string, string>; body: any }

/** 真浏览器不允许带 body 的 method（`fetch()` 直接抛 TypeError）。**假 fetch 也照这条校验** ——
 *  P8 的 F1 就是「假 fetch 太温柔」漏掉的：`detectChatProxy()` 早先用 `GET + body: ""` 探测，
 *  真浏览器抛 `Request with GET/HEAD method cannot have body`，被 `catch { return null }` 吞成
 *  「这台机器没有代理」，而假 fetch 无条件回 200，所以 7527 条断言照样全绿。 */
const BODYLESS_METHODS = ["GET", "HEAD"];

/** 请求体形状是否与 method 相容；不相容就**按真浏览器那样抛 TypeError**（不是回一个 200 了事） */
function assertFetchInit(method: unknown, init: { body?: unknown }): void {
  const m = String(method ?? "").toUpperCase();
  if (BODYLESS_METHODS.indexOf(m) >= 0 && init && init.body !== undefined) {
    throw new TypeError("Request with " + m + " method cannot have body");
  }
  if (init && init.body !== undefined && typeof init.body !== "string") {
    throw new TypeError("fetch body 必须是字符串（收到 " + typeof init.body + "）");
  }
}

function fakeFetch(replies: Reply[]): { fn: ChatFetch; seen: Seen[] } {
  const seen: Seen[] = [];
  let i = 0;
  const fn: ChatFetch = async (url, init) => {
    // 先校验 method/body 组合（GET/HEAD 该**没有** body 字段），再解析
    assertFetchInit(init.method, init);
    seen.push({ url, init, headers: init.headers,
      body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const r = replies[Math.min(i++, replies.length - 1)];
    if (r.thrown) throw new Error(r.thrown);
    const status = r.status ?? 200;
    const out: {
      ok: boolean; status: number; text(): Promise<string>;
      headers?: { get(k: string): string | null };
      chunks?: () => AsyncIterable<string>;
    } = { ok: status >= 200 && status < 300, status, text: async () => r.body ?? "" };
    if (r.contentType) out.headers = { get: (k: string) => (k.toLowerCase() === "content-type" ? r.contentType! : null) };
    if (r.sse) {
      // 真的**按块**吐（每块之间让一次 microtask）—— 不是一下子把整段给出去
      out.chunks = async function* (): AsyncIterable<string> {
        for (const piece of r.sse!) { await Promise.resolve(); yield piece; }
      };
    }
    return out;
  };
  return { fn, seen };
}

/** 把一段模型回复写成 SSE 分片（`[DONE]` 收尾）。**分片边界故意切在字段中间** —— 这才是真流式的样子 */
function sseChunks(text: string, reasoning: string, calls: Array<{ id: string; name: string; args: string }>): string[] {
  const pieces: string[] = [];
  const put = (delta: Record<string, unknown>): void => {
    pieces.push("data: " + JSON.stringify({ choices: [{ index: 0, delta }] }) + "\n\n");
  };
  // 思考过程：切成 3 段（真的逐块增长，而不是一次给完）
  if (reasoning) {
    const a = Math.max(1, Math.floor(reasoning.length / 3));
    const b = Math.max(a + 1, Math.floor((reasoning.length * 2) / 3));
    put({ reasoning_content: reasoning.slice(0, a) });
    put({ reasoning_content: reasoning.slice(a, b) });
    put({ reasoning_content: reasoning.slice(b) });
  }
  if (text) {
    const h = Math.max(1, Math.floor(text.length / 2));
    put({ content: text.slice(0, h) });
    put({ content: text.slice(h) });
  }
  // tool_calls **分片**：第一片带 id / name，后续片是 arguments 的字符串片段（按 index 合并）
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    put({ tool_calls: [{ index: i, id: c.id, type: "function", function: { name: c.name, arguments: "" } }] });
    const arg = c.args;
    const mid = Math.max(1, Math.floor(arg.length / 2));
    for (const part of [arg.slice(0, mid), arg.slice(mid)]) {
      put({ tool_calls: [{ index: i, function: { arguments: part } }] });
    }
  }
  // 收尾帧（`finish_reason`）与 `[DONE]`
  pieces.push("data: " + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }] }) + "\n\n");
  pieces.push("data: [DONE]\n\n");
  return pieces;
}

/**
 * 一次**流式**假回复：`contentType` 默认 `text/event-stream`（改它就能演「端点不支持 SSE」），
 * `body` 是**等价整包**（同一个 message 形状）—— 两条路必须解析出**逐字段相同**的结果，
 * 这就是「流式不改变既有语义」的证据面。
 */
function streamReply(
  msg: { content?: string; reasoning?: string; calls?: Array<{ id: string; name: string; args: string }> },
  over: { contentType?: string | null; status?: number } = {},
): Reply {
  const content = msg.content ?? "";
  const reasoning = msg.reasoning ?? "";
  const calls = msg.calls ?? [];
  const message: Record<string, unknown> = { role: "assistant", content };
  if (reasoning) message.reasoning_content = reasoning;
  if (calls.length) {
    message.tool_calls = calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args } }));
  }
  const status = over.status ?? 200;
  const out: Reply = { status, body: JSON.stringify({ choices: [{ index: 0, message, finish_reason: calls.length ? "tool_calls" : "stop" }] }) };
  if (over.contentType !== null) out.contentType = over.contentType ?? "text/event-stream";
  out.sse = sseChunks(content, reasoning, calls);
  return out;
}

/** 一次假的模型回复：`calls` 是 tool_calls（`rawArgs` 可故意给一段坏 JSON） */
function reply(calls: Array<{ id?: string; name: string; args?: unknown; rawArgs?: string }>, text = ""): Reply {
  const toolCalls = calls.map((c, i) => ({
    id: c.id ?? "c" + (i + 1),
    type: "function",
    function: { name: c.name, arguments: c.rawArgs ?? JSON.stringify(c.args ?? {}) },
  }));
  const message: Record<string, unknown> = { role: "assistant", content: text };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return { body: JSON.stringify({ choices: [{ index: 0, message, finish_reason: toolCalls.length ? "tool_calls" : "stop" }] }) };
}

/** 一轮整跑的公共参数（每个用例只改自己关心的那几项） */
function turnOpts(s: Session, fn: ChatFetch, over: Partial<ChatTurnOpts> = {}): ChatTurnOpts {
  const { ctx } = toolCtx(s);
  return {
    messages: [systemMessage(), userMessage("画一条红线")],
    ctx, endpoint: "https://endpoint.test/v1", model: "test-model", key: "sk-test-key", fetchFn: fn,
    ...over,
  };
}

const readFile = (rel: string): string => fs.readFileSync(path.resolve(__dirname, "../../../" + rel), "utf8") as string;

export async function testAiChat(): Promise<void> {
  stubEnv();

  // ================================================================ 1. 纯函数：schema 映射
  {
    const tools = listTools({ tiers: ["read", "draw", "destructive"] });
    const schema = toOpenAiTools(tools);
    eq("aichat.schema.count", schema.length, tools.length);
    eq("aichat.schema.names", schema.map((t) => t.function.name), tools.map((t) => t.id));
    ok("aichat.schema.all-functions", schema.every((t) => t.type === "function" && t.function.parameters.type === "object"));

    const byName = new Map(schema.map((t) => [t.function.name, t]));
    const dp = byName.get("draw_path")!.function.parameters;
    eq("aichat.schema.draw_path.required", dp.required, ["points"]);
    // points 是 `items: "xy"`：每个点是 [integer, integer]，**不是**标量数组
    const pp = dp.properties.points as { type: string; items: unknown; minItems: number; maxItems: number };
    eq("aichat.schema.draw_path.points", [pp.type, pp.items, pp.minItems, pp.maxItems],
      ["array", { type: "array", items: { type: "integer" }, minItems: 2, maxItems: 2 }, 1, 4096]);
    eq("aichat.schema.draw_path.tool", dp.properties.tool.type, "string");
    eq("aichat.schema.draw_path.tool.enum", dp.properties.tool.enum, ["pencil", "eraser", "line", "rect", "ellipse", "bucket"]);
    eq("aichat.schema.draw_path.size", [dp.properties.size.type, dp.properties.size.minimum, dp.properties.size.maximum], ["integer", 1, 64]);
    eq("aichat.schema.draw_path.no-additional", dp.additionalProperties, false);
    ok("aichat.schema.color-hint", String(dp.properties.color.description).indexOf("fg") >= 0);

    // int 是 integer（validateArgs 对小数是**拒绝**，不是取整）、num 才是 number
    const scale = byName.get("scale")!.function.parameters;
    ok("aichat.schema.int-is-integer", Object.values(scale.properties).every((p) => p.type !== "number"));
    // 有默认值的参数写进 schema 的 default（且不进 required）
    const gy = byName.get("fx_glow")!.function.parameters;
    eq("aichat.schema.glow-scope-default", gy.properties.scope.default, "layer");
    eq("aichat.schema.glow-scope-required", gy.required.indexOf("scope"), -1);

    // rect 是 {x,y,w,h} 四个整数（与 checkParam 的 rect 分支一一对应）
    const er = byName.get("erase")!.function.parameters;
    eq("aichat.schema.erase.rect", (er.properties.rect as any).required, ["x", "y", "w", "h"]);
    eq("aichat.schema.erase.rect.type", (er.properties.rect as any).properties.w.type, "integer");

    // required 的口径必须与 validateArgs 完全一致（「既没默认值也不是 optional」）：
    // 逐个工具比一遍，并确认 validateArgs 对空参数报的就是第一个必填项
    const mismatch: string[] = [];
    for (const tool of tools) {
      const sch = byName.get(tool.id)!.function.parameters;
      const expect = Object.keys(tool.params).filter((n) => tool.params[n].optional !== true && tool.params[n].default === undefined);
      if (sch.required.join(",") !== expect.join(",")) mismatch.push(tool.id + " required=" + sch.required.join(",") + " 期望 " + expect.join(","));
      const v = validateArgs(tool, {});
      if (expect.length) {
        if (v.ok === true) mismatch.push(tool.id + " 缺 " + expect[0] + " 却没报错");
        else if (v.reason.indexOf("缺少必填参数 " + expect[0]) < 0) mismatch.push(tool.id + " → " + v.reason);
      } else if (v.ok === false && v.reason.indexOf("缺少必填参数") >= 0) {
        mismatch.push(tool.id + " 没有必填参数却报缺：" + v.reason);
      }
    }
    eq("aichat.schema.required-matches-validate", mismatch.slice(0, 3), []);

    // AI_ARG_CURRENT 这类哨兵不当默认值写进 schema
    const dpDefault = JSON.stringify(dp.properties.layer ?? {});
    ok("aichat.schema.sentinel-not-default", dpDefault.indexOf("current") < 0, dpDefault);
  }

  // ================================================================ 2. 纯函数：tool_calls 解析
  {
    const one = { choices: [{ message: { content: "好", tool_calls: [{ id: "a1", type: "function", function: { name: "doc_digest", arguments: "{}" } }] } }] };
    const calls = parseToolCalls(one);
    eq("aichat.parse.count", calls.length, 1);
    eq("aichat.parse.name", calls[0].name, "doc_digest");
    eq("aichat.parse.args", calls[0].args, {});
    eq("aichat.parse.text", responseText(one), "好");

    // 空 arguments 是合法的（无参数工具）；缺 id 按位置补一个稳定 id
    const noArgs = parseToolCalls({ choices: [{ message: { tool_calls: [{ function: { name: "undo" } }] } }] });
    eq("aichat.parse.no-id", noArgs[0].id, "call_0");
    eq("aichat.parse.empty-args", [noArgs[0].args, !!noArgs[0].error], [{}, false]);

    // arguments 是对象（有的宿主这么给）
    const objArgs = parseToolCalls({ message: { tool_calls: [{ id: "z", function: { name: "set_tool", arguments: { tool: "pencil" } } }] } });
    eq("aichat.parse.object-args", objArgs[0].args, { tool: "pencil" });

    // 坏 JSON：不抛异常，带 error 返回（调用方当失败结果回灌，绝不用空参数去调工具）
    const bad = parseToolCalls({ choices: [{ message: { tool_calls: [{ id: "b", function: { name: "draw_path", arguments: "{oops" } }] } }] });
    eq("aichat.parse.bad-json.count", bad.length, 1);
    eq("aichat.parse.bad-json.args", bad[0].args, {});
    ok("aichat.parse.bad-json.error", !!bad[0].error && bad[0].error!.indexOf("合法 JSON") >= 0, bad[0].error);
    // 没有函数名 / 不是对象 / 数组
    ok("aichat.parse.no-name", !!parseToolCalls({ message: { tool_calls: [{ id: "x", function: { arguments: "{}" } }] } })[0].error);
    ok("aichat.parse.array-args", !!parseToolCalls({ message: { tool_calls: [{ id: "y", function: { name: "undo", arguments: "[1]" } }] } })[0].error);
    // 结构不对 → 空数组（不抛）
    eq("aichat.parse.junk", [parseToolCalls(null), parseToolCalls({}), parseToolCalls("nope"), parseToolCalls({ choices: [] })], [[], [], [], []]);
    eq("aichat.parse.text-array", responseText({ choices: [{ message: { content: [{ type: "text", text: "甲" }, { type: "text", text: "乙" }] } }] }), "甲乙");

    // 规范成 OpenAI 形状（回灌时请求体必须是这个形状）
    const msg = assistantMessage(one);
    eq("aichat.assistant.role", msg.role, "assistant");
    eq("aichat.assistant.tool_calls", msg.tool_calls, [{ id: "a1", type: "function", function: { name: "doc_digest", arguments: "{}" } }]);
    eq("aichat.assistant.plain", assistantMessage(reply([], "只有文本")).tool_calls, undefined);
  }

  // ================================================================ 3. 纯函数：消息拼装
  {
    const base: ChatMessage[] = [systemMessage(), userMessage("画个圆")];
    ok("aichat.msg.system-prompt", base[0].content!.indexOf("工具") >= 0 && base[0].content === AI_CHAT_SYSTEM_PROMPT);
    ok("aichat.msg.digest", systemMessage({ digest: '{"w":64}' }).content!.indexOf('{"w":64}') > 0);
    ok("aichat.msg.digest-clip", buildSystemPrompt({ digest: "x".repeat(9000) }).length < 9000);

    const call = { id: "c1", name: "doc_digest" };
    const out = appendToolResult(base, call, { ok: true, docRev: 7, changed: { x: 1, y: 2, w: 3, h: 4 }, data: { big: "y".repeat(9000) } });
    eq("aichat.msg.pure", base.length, 2);           // 不改传进来的数组
    eq("aichat.msg.count", out.length, 3);
    eq("aichat.msg.role", out[2].role, "tool");
    eq("aichat.msg.call-id", out[2].tool_call_id, "c1");
    eq("aichat.msg.name", out[2].name, "doc_digest");
    ok("aichat.msg.content-ok", out[2].content!.indexOf('"ok":true') > 0);
    ok("aichat.msg.content-head", out[2].content!.indexOf('"docRev":7') > 0 && out[2].content!.indexOf('"changed"') > 0);
    ok("aichat.msg.truncated", out[2].content!.length < 4200 && out[2].content!.indexOf("已截断") > 0, "len=" + out[2].content!.length);
    ok("aichat.msg.error-first", toolResultContent({ ok: false, error: "boom" }).indexOf('"error":"boom"') < 60);

    eq("aichat.label.from-user", defaultTurnLabel(base), "画个圆");
    eq("aichat.label.empty", defaultTurnLabel([systemMessage()]), "对话");
    eq("aichat.label.clip", defaultTurnLabel([userMessage("一".repeat(120))]).length, 40);
  }

  // ================================================================ 4. 纯函数：端点与配置
  {
    eq("aichat.url.base", chatCompletionsUrl("https://api.openai.com/v1"), "https://api.openai.com/v1" + AI_CHAT_COMPLETIONS_PATH);
    eq("aichat.url.slash", chatCompletionsUrl("https://x.test/v1/"), "https://x.test/v1" + AI_CHAT_COMPLETIONS_PATH);
    eq("aichat.url.full", chatCompletionsUrl("https://x.test/v1/chat/completions"), "https://x.test/v1/chat/completions");
    eq("aichat.url.empty", chatCompletionsUrl("   "), "");
    ok("aichat.cfg.endpoint", String(chatConfigError({ endpoint: "", model: "m", key: "k" })).indexOf("端点") > 0);
    ok("aichat.cfg.scheme", String(chatConfigError({ endpoint: "api.test/v1", model: "m", key: "k" })).indexOf("http") > 0);
    ok("aichat.cfg.model", String(chatConfigError({ endpoint: "https://x.test/v1", model: " ", key: "k" })).indexOf("模型") > 0);
    ok("aichat.cfg.key", String(chatConfigError({ endpoint: "https://x.test/v1", model: "m", key: "" })).indexOf("key") > 0);
    eq("aichat.cfg.ok", chatConfigError({ endpoint: "https://x.test/v1", model: "m", key: "k" }), null);
    eq("aichat.rounds.default", AI_CHAT_DEFAULT_MAX_ROUNDS, 12);
  }

  // ================================================================ 5. 假端点整轮（预览后应用）
  {
    const s = live();
    const before = docBytes(s);
    const hist0 = histLen(s);
    const { ctx, asked } = toolCtx(s, async (req) => req.tool !== "erase");   // 破坏性操作：用户点取消
    const { fn, seen } = fakeFetch([
      reply([
        { id: "c1", name: "draw_path", args: { points: [[1, 1], [4, 1]], color: "#ff0000" } },
        { id: "c2", name: "erase", args: { rect: { x: 1, y: 1, w: 4, h: 1 }, shape: "rect", fill: true } },
      ]),
      reply([{ id: "c3", name: "draw_path", args: { points: [[6, 6]], size: 1, color: "#0000ff" } }]),
      reply([], "画好了：一条红线加一个蓝点，擦除被你取消了。"),
    ]);
    const r = await runChatTurn({
      messages: [systemMessage(), userMessage("画一条红线，再擦掉它")],
      ctx, endpoint: "https://endpoint.test/v1", model: "test-model", key: "sk-test-key",
      fetchFn: fn, commit: false,
    });

    eq("aichat.turn.ok", r.ok, true);
    eq("aichat.turn.rounds", r.rounds, 3);
    eq("aichat.turn.stop", r.stop, "text");
    eq("aichat.turn.text", r.text, "画好了：一条红线加一个蓝点，擦除被你取消了。");
    eq("aichat.turn.calls", r.calls.map((c) => c.name), ["draw_path", "erase", "draw_path"]);
    eq("aichat.turn.ok-flags", r.calls.map((c) => c.ok), [true, false, true]);
    eq("aichat.turn.cancelled", r.calls[1].error, "cancelled");
    eq("aichat.turn.asked-once", asked, ["erase"]);                        // destructive 逐个确认
    eq("aichat.turn.revdelta0", r.calls[0].revDelta > 0, true);
    eq("aichat.turn.revdelta-cancelled", r.calls[1].revDelta > 0, false);  // 取消的那次一个字节没动
    eq("aichat.turn.changed-rect", r.calls[0].changed, { x: 1, y: 1, w: 4, h: 1 });
    eq("aichat.turn.doc-rev-grew", r.docRev > r.docRevBefore, true);
    eq("aichat.turn.changed-count", changedCount(r.calls), 2);

    // 文档真的变了（红线上第 2、3 个像素被画上；被取消的擦除没把人字形擦掉）
    eq("aichat.turn.px-red", px(s, 0, 2, 1), [255, 0, 0, 255]);
    eq("aichat.turn.px-blue", px(s, 0, 6, 6), [0, 0, 255, 255]);
    ok("aichat.turn.doc-changed", docBytes(s) !== before);

    // 预览口径：历史一动不动、回合开着
    eq("aichat.preview.hist-unchanged", histLen(s), hist0);
    eq("aichat.preview.turn-open", r.turnOpen, true);
    eq("aichat.preview.session-open", s.aiTurnOpen(), true);
    const pv = s.previewAiTurn();
    eq("aichat.preview.count", pv.count, 2);
    eq("aichat.preview.rect", pv.rect, { x: 1, y: 1, w: 6, h: 6 });

    // 请求体：URL / 头 / tools / 消息角色顺序
    eq("aichat.http.url", seen[0].url, "https://endpoint.test/v1" + AI_CHAT_COMPLETIONS_PATH);
    eq("aichat.http.auth", seen[0].headers.Authorization, "Bearer sk-test-key");
    eq("aichat.http.ctype", seen[0].headers["Content-Type"], "application/json");
    eq("aichat.http.model", seen[0].body.model, "test-model");
    eq("aichat.http.tools", seen[0].body.tools.length, listTools({ tiers: ["read", "draw", "destructive"] }).length);
    eq("aichat.http.roles", seen[1].body.messages.map((m: ChatMessage) => m.role),
      ["system", "user", "assistant", "tool", "tool"]);
    eq("aichat.http.tool-ids", seen[1].body.messages.slice(3).map((m: ChatMessage) => m.tool_call_id), ["c1", "c2"]);
    ok("aichat.http.tool-content", String(seen[1].body.messages[3].content).indexOf('"ok":true') > 0);
    ok("aichat.http.cancel-content", String(seen[1].body.messages[4].content).indexOf("cancelled") > 0);
    eq("aichat.http.3rd-request", seen.length, 3);

    // 工具结果回灌进对话流（UI 下次对话接着用）
    eq("aichat.turn.messages", r.messages.map((m) => m.role), ["system", "user", "assistant", "tool", "tool", "assistant", "tool", "assistant"]);

    // 点「应用」：一轮一条 undo，标签带 ai: 前缀
    eq("aichat.apply.recorded", s.commitAiTurn(), true);
    eq("aichat.apply.hist+1", histLen(s), hist0 + 1);
    eq("aichat.apply.label", s.history.list().labels[histLen(s) - 1], "ai: 画一条红线，再擦掉它");
    eq("aichat.apply.turn-closed", s.aiTurnOpen(), false);
    eq("aichat.apply.recorded-flag", r.recorded, false);   // 预览模式：落历史的是 UI 那一下

    // 一条 undo 收回整轮
    s.undo();
    eq("aichat.apply.undo-bytes", docBytes(s), before);
    eq("aichat.apply.undo-open", s.aiTurnOpen(), false);
  }

  // ================================================================ 6. 自动提交模式（commit 缺省 = runAiTurn）
  {
    const s = live();
    const hist0 = histLen(s);
    const { fn } = fakeFetch([
      reply([{ id: "d1", name: "draw_path", args: { points: [[3, 3]], color: "#00ff00" } }]),
      reply([], "好了。"),
    ]);
    const r = await runChatTurn(turnOpts(s, fn));
    eq("aichat.commit.ok", r.ok, true);
    eq("aichat.commit.recorded", r.recorded, true);
    eq("aichat.commit.hist+1", histLen(s), hist0 + 1);
    eq("aichat.commit.turn-closed", r.turnOpen, false);
    eq("aichat.commit.px", px(s, 0, 3, 3), [0, 255, 0, 255]);
    eq("aichat.commit.label", s.history.list().labels[hist0], "ai: 画一条红线");
    // 只读的一轮：不落历史（runAiTurn 也是 ok:true）
    const { fn: fn2 } = fakeFetch([reply([{ id: "e1", name: "doc_digest", args: {} }]), reply([], "看过了。")]);
    const r2 = await runChatTurn(turnOpts(s, fn2));
    eq("aichat.commit.readonly-ok", r2.ok, true);
    eq("aichat.commit.readonly-recorded", r2.recorded, false);
    eq("aichat.commit.readonly-hist", histLen(s), hist0 + 1);
  }

  // ================================================================ 7. 「放弃」逐字节回原样
  {
    const s = live();
    const before = docBytes(s);
    const hist0 = histLen(s);
    const { fn } = fakeFetch([
      reply([{ id: "f1", name: "draw_path", args: { points: [[10, 10]], size: 3, color: "#ff0000" } }]),
      reply([{ id: "f2", name: "layer_add", args: {} }]),
      reply([], "画完了。"),
    ]);
    const r = await runChatTurn({ ...turnOpts(s, fn), commit: false });
    eq("aichat.discard.ok", r.ok, true);
    eq("aichat.discard.turn-open", s.aiTurnOpen(), true);
    ok("aichat.discard.doc-changed", docBytes(s) !== before);
    s.rollbackAiTurn();
    eq("aichat.discard.bytes", docBytes(s), before);
    eq("aichat.discard.hist", histLen(s), hist0);
    eq("aichat.discard.turn-closed", s.aiTurnOpen(), false);
    eq("aichat.discard.px", pxSoft(s, 0, 10, 10), [0, 0, 0, 0]);
    eq("aichat.discard.layers", s.doc.layers.length, 2);
  }

  // ================================================================ 8. 失败：不改文档、错误是人话
  {
    // 8a 模型第一轮已经画了东西、第二轮端点 500 → 整轮回滚
    const s = live();
    const before = docBytes(s);
    const hist0 = histLen(s);
    const { fn } = fakeFetch([
      reply([{ id: "g1", name: "draw_path", args: { points: [[7, 7]], color: "#ff0000" } }]),
      { status: 500, body: "upstream exploded" },
    ]);
    const r = await runChatTurn({ ...turnOpts(s, fn), commit: false });
    eq("aichat.fail500.ok", r.ok, false);
    ok("aichat.fail500.error", String(r.error).indexOf("HTTP 500") >= 0 && String(r.error).indexOf("upstream exploded") >= 0, r.error);
    eq("aichat.fail500.bytes", docBytes(s), before);
    eq("aichat.fail500.hist", histLen(s), hist0);
    eq("aichat.fail500.turn-closed", s.aiTurnOpen(), false);
    ok("aichat.fail500.messages", r.messages.map((m) => m.role).join(",") === "system,user,assistant,tool");

    // 8b 401：key 被拒，错误文本里**不能**有 key 本身
    const { fn: fn401 } = fakeFetch([{ status: 401, body: '{"error":{"message":"invalid api key"}}' }]);
    const r401 = await runChatTurn({ ...turnOpts(s, fn401), key: "sk-super-secret", commit: false });
    eq("aichat.fail401.ok", r401.ok, false);
    ok("aichat.fail401.error", String(r401.error).indexOf("401") >= 0, r401.error);
    ok("aichat.fail401.no-key", String(r401.error).indexOf("sk-super-secret") < 0, r401.error);
    eq("aichat.fail401.bytes", docBytes(s), before);

    // 8c 连不上端点（fetch 直接抛）
    const { fn: fnNet } = fakeFetch([{ thrown: "Failed to fetch" }]);
    const rNet = await runChatTurn({ ...turnOpts(s, fnNet), commit: false });
    eq("aichat.failnet.ok", rNet.ok, false);
    ok("aichat.failnet.error", String(rNet.error).indexOf("连不上端点") >= 0 && String(rNet.error).indexOf("Failed to fetch") >= 0, rNet.error);
    eq("aichat.failnet.bytes", docBytes(s), before);

    // 8d 不是 JSON
    const { fn: fnHtml } = fakeFetch([{ body: "<html>nope</html>" }]);
    const rHtml = await runChatTurn({ ...turnOpts(s, fnHtml), commit: false });
    ok("aichat.failhtml.error", String(rHtml.error).indexOf("不是 JSON") >= 0, rHtml.error);

    // 8e 端点把错误放在 body 里（HTTP 200）
    const { fn: fnErr } = fakeFetch([{ body: JSON.stringify({ error: { message: "model not found" } }) }]);
    const rErr = await runChatTurn({ ...turnOpts(s, fnErr), commit: false });
    ok("aichat.failbody.error", String(rErr.error).indexOf("model not found") >= 0, rErr.error);

    // 8f 缺 key / 端点：**一个请求都不发**、连回合都不开
    const { fn: fnNever, seen } = fakeFetch([reply([], "不该走到这里")]);
    const noKey = await runChatTurn({ ...turnOpts(s, fnNever), key: "" });
    const noEndpoint = await runChatTurn({ ...turnOpts(s, fnNever), endpoint: "" });
    eq("aichat.nokey.calls", seen.length, 0);
    eq("aichat.nokey.ok", [noKey.ok, noEndpoint.ok], [false, false]);
    ok("aichat.nokey.hint", String(noKey.error).indexOf("key") > 0 && String(noEndpoint.error).indexOf("端点") > 0);
    eq("aichat.nokey.turn", [noKey.turnOpen, s.aiTurnOpen()], [false, false]);
    eq("aichat.nokey.bytes", docBytes(s), before);
  }

  // ================================================================ 9. 轮数与坏参数
  {
    const s = live();
    // 模型一直要求调用：到 maxRounds 停下（而且不是失败），一轮仍然只落一条历史
    const { fn, seen } = fakeFetch([
      reply([{ name: "draw_path", args: { points: [[1, 1]], color: "#ff0000" } }]),
      reply([{ name: "draw_path", args: { points: [[2, 1]], color: "#ff0000" } }]),
      reply([{ name: "draw_path", args: { points: [[3, 1]], color: "#ff0000" } }]),
    ]);
    const hist0 = histLen(s);
    const r = await runChatTurn(turnOpts(s, fn, { maxRounds: 3 }));
    eq("aichat.maxrounds.ok", r.ok, true);
    eq("aichat.maxrounds.rounds", r.rounds, 3);
    eq("aichat.maxrounds.stop", r.stop, "maxRounds");
    eq("aichat.maxrounds.requests", seen.length, 3);
    ok("aichat.maxrounds.text", r.text.indexOf("最大轮数") >= 0, r.text);
    eq("aichat.maxrounds.px", [px(s, 0, 1, 1), px(s, 0, 3, 1)], [[255, 0, 0, 255], [255, 0, 0, 255]]);
    eq("aichat.maxrounds.hist+1", histLen(s), hist0 + 1);
    // 上限夹住（不会真的跑 999 轮）：24 是硬上限
    const { fn: fnMany } = fakeFetch([reply([{ name: "doc_digest", args: {} }])]);
    eq("aichat.maxrounds.clamped", (await runChatTurn(turnOpts(s, fnMany, { maxRounds: 999 }))).rounds, 24);
    // maxRounds 以外的 0 / 非数字 → 回到默认（12）
    const { fn: fnZero } = fakeFetch([reply([{ name: "doc_digest", args: {} }])]);
    eq("aichat.maxrounds.default", (await runChatTurn(turnOpts(s, fnZero, { maxRounds: 0 }))).rounds, AI_CHAT_DEFAULT_MAX_ROUNDS);

    // 模型给的参数不是合法 JSON：**不拿空参数去调工具**，回灌一条失败结果，模型下一轮改口
    const s2 = live();
    const before2 = docBytes(s2);
    const { fn: fnBad } = fakeFetch([
      reply([{ id: "h1", name: "draw_path", rawArgs: "{画一条线" }]),
      reply([], "抱歉，我重来。"),
    ]);
    const rBad = await runChatTurn({ ...turnOpts(s2, fnBad), commit: false });
    eq("aichat.badargs.ok", rBad.ok, true);
    eq("aichat.badargs.calls", rBad.calls.length, 1);
    eq("aichat.badargs.ok-flag", rBad.calls[0].ok, false);
    ok("aichat.badargs.parse-error", !!rBad.calls[0].parseError, rBad.calls[0].parseError);
    eq("aichat.badargs.bytes", docBytes(s2), before2);
    s2.rollbackAiTurn();
    eq("aichat.badargs.closed", s2.aiTurnOpen(), false);

    // 摘要文案（UI 直接显示）
    const line = formatCallLog(rBad.calls[0]);
    ok("aichat.format.failed", line.indexOf("draw_path") === 0 && line.indexOf("失败") > 0 && line.indexOf("JSON") > 0, line);
    const line2 = formatCallLog({ id: "x", name: "fill", args: {}, ok: true, changed: { x: 0, y: 0, w: 5, h: 6 }, docRev: 9, revDelta: 2 });
    ok("aichat.format.ok", line2.indexOf("改动 5×6") > 0 && line2.indexOf("docRev 7→9") > 0, line2);
  }

  // ================================================================ 10. 设置项 + key 只存在本机
  {
    const s = live();
    // P8/W2：默认预设 = DeepSeek（开箱即用），所以端点默认值不再是空串。
    // 这条是 P1 §3.7.8 **明确授权**要改的两条断言之一。
    eq("aichat.setting.default-endpoint", SETTINGS_BY_PATH.get("ai.chatEndpoint")!.default, "https://api.deepseek.com");
    eq("aichat.setting.default-model", SETTINGS_BY_PATH.get("ai.chatModel")!.default, "deepseek-v4-pro");
    eq("aichat.setting.kind-bool", SETTINGS_BY_PATH.get("ai.chatOn")!.kind, "bool");
    eq("aichat.setting.key-password", SETTINGS_BY_PATH.get("ai.chatKey")!.text, "password");
    eq("aichat.setting.endpoint-text", SETTINGS_BY_PATH.get("ai.chatEndpoint")!.text, "plain");
    eq("aichat.setting.no-new-kind", SETTINGS_BY_PATH.get("ai.chatKey")!.kind, undefined);
    eq("aichat.setting.default-off", SETTINGS_BY_PATH.get("ai.chatOn")!.default, false);
    // `ai.chatStream` 的声明默认值也是**打开**（`normalizeAiChatSettings` 的 `!== false` 是另一道）
    eq("aichat.setting.stream.default-on", SETTINGS_BY_PATH.get("ai.chatStream")!.default, true);
    eq("aichat.setting.group", SETTINGS_BY_PATH.get("ai.chatOn")!.group, "chat");
    // 平台门：没有原生桥接时这一组一条都不显示（浏览器里连设置都没有）
    const savedBridge = (globalThis as unknown as { window: Record<string, unknown> }).window.PixelBridge;
    ok("aichat.setting.native", isNativeShell());
    delete (globalThis as unknown as { window: Record<string, unknown> }).window.PixelBridge;
    eq("aichat.setting.hidden-in-browser", settingsOfGroup(s, "chat").length, 0);
    eq("aichat.bridge.off", isNativeShell(), false);
    (globalThis as unknown as { window: Record<string, unknown> }).window.PixelBridge = savedBridge;

    // 关着的时候只露开关一条（端点 / 模型 / key 藏起来）
    saveAiChatSettings({ on: false, endpoint: "", model: "", key: "" });
    eq("aichat.setting.visible-off", settingsOfGroup(s, "chat").map((d) => d.path), ["ai.chatOn"]);
    s.setSetting("ai.chatOn", true);
    eq("aichat.setting.on", aiChatSettings().on, true);
    // P8/W2：新增的设置项逐条列全（这是 P1 §3.7.8 **明确授权**要改的第二条断言）
    eq("aichat.setting.visible-on", settingsOfGroup(s, "chat").map((d) => d.path),
      ["ai.chatOn", "ai.chatPreset", "ai.chatEndpoint", "ai.chatModel", "ai.chatKey", "ai.providerBase",
        "ai.chatMaxRounds", "ai.chatTemp", "ai.chatThinking", "ai.chatTimeoutSec",
        "ai.chatSystemPrompt", "ai.chatStream", "ai.protectKey", "ai.chatBall"]);
    // 新增的两条：思考强度（白名单 + 默认"什么都不发"）与超时（秒，夹 5..600）
    eq("aichat.setting.thinking.default", aiChatSettings().thinking, "default");
    eq("aichat.setting.timeout.default", aiChatSettings().timeoutSec, 60);
    eq("aichat.setting.thinking.options", (SETTINGS_BY_PATH.get("ai.chatThinking")!.options ?? []).map((o) => o.value),
      ["default", "off", "low", "high", "max"]);
    s.setSetting("ai.chatThinking", "max");
    s.setSetting("ai.chatTimeoutSec", 600000);
    eq("aichat.setting.thinking.clamped", [aiChatSettings().thinking, aiChatSettings().timeoutSec], ["max", 600]);
    s.setSetting("ai.chatThinking", "ultra-不存在的档位");
    s.setSetting("ai.chatTimeoutSec", 1);
    // 设置层对 enum 只认选项表里的值（非法值不改动），所以白名单要**直接问归一化函数**
    eq("aichat.setting.thinking.whitelist",
      [normalizeAiChatSettings({ thinking: "ultra-不存在的档位" }).thinking,
        normalizeAiChatSettings({}).thinking,
        normalizeAiChatSettings({ thinking: "off" }).thinking], ["default", "default", "off"]);
    eq("aichat.setting.timeout.clamped-low", aiChatSettings().timeoutSec, 5);
    s.setSetting("ai.chatEndpoint", "https://gateway.test/v1/");
    s.setSetting("ai.chatModel", "my-model");
    s.setSetting("ai.chatKey", "sk-local-only");
    eq("aichat.setting.values", [s.settingValue("ai.chatEndpoint"), s.settingValue("ai.chatModel"), s.settingValue("ai.chatKey")],
      ["https://gateway.test/v1/", "my-model", "sk-local-only"]);
    // 归一化 + 持久化 + 监听。
    // 这条恢复成**全量比较**（P15 第 3 项）：曾经为了少改字退化成 4 字段子集，
    // 结果「归一化多出/漏掉一个字段」这类回归它能溜过去。14 个字段一个不漏地列全。
    eq("aichat.setting.normalize-junk", normalizeAiChatSettings({ on: 1, endpoint: 5, model: null, key: "k" }), {
      on: false, preset: "deepseek", endpoint: "", model: "", key: "k", providerBase: "",
      maxRounds: 12, temp: 0, thinking: "default", timeoutSec: 60, systemPrompt: "", stream: true, protectKey: true,
      winOpen: false, winMin: false, ball: true,
    });
    // 字段数也要钉住：多一个字段（比如将来加新设置忘了同步这条）同样会红
    eq("aichat.setting.normalize-keys", Object.keys(normalizeAiChatSettings({})).sort().join(","),
      ["ball", "endpoint", "key", "maxRounds", "model", "on", "preset", "protectKey", "providerBase",
        "stream", "systemPrompt", "temp", "thinking", "timeoutSec", "winMin", "winOpen"].join(","));
    // **这条断言不是摆设**：给它一份「多一个字段」的对象，它必须不等（否则就是恒真的假断言）。
    // 这同时证明上面那条确实在做**全量**比较（子集比较在这种输入下会静默相等）。
    eq("aichat.setting.normalize-junk.is-tight",
      JSON.stringify(Object.assign(normalizeAiChatSettings({ on: 1, endpoint: 5, model: null, key: "k" }), { iAmNew: 1 }))
        === JSON.stringify({
          on: false, preset: "deepseek", endpoint: "", model: "", key: "k", providerBase: "",
          maxRounds: 12, temp: 0, thinking: "default", timeoutSec: 60, systemPrompt: "", stream: true, protectKey: true,
          winOpen: false, winMin: false, ball: true,
        }), false);
    // 预设 / 高级项各自的默认值与夹取（P8/W2 的新增面）。
    // `stream` 现在是**默认打开**的真开关（`o.stream !== false`），旧数据 / 缺字段都当打开。
    eq("aichat.setting.normalize-addons", (() => {
      const v = normalizeAiChatSettings({});
      return [v.preset, v.providerBase, v.maxRounds, v.temp, v.systemPrompt, v.stream, v.protectKey];
    })(), ["deepseek", "", 12, 0, "", true, true]);
    eq("aichat.setting.stream.opt-out", normalizeAiChatSettings({ stream: false }).stream, false);
    eq("aichat.setting.normalize-clamp", (() => {
      const v = normalizeAiChatSettings({ preset: "nope", maxRounds: 999, temp: -3, protectKey: false });
      return [v.preset, v.maxRounds, v.temp, v.protectKey];
    })(), ["deepseek", 24, 0, false]);
    eq("aichat.setting.normalize-clip", normalizeAiChatSettings({ key: "x".repeat(4000) }).key.length, 2048);
    const raw = JSON.parse(String((globalThis as unknown as { localStorage: { getItem(k: string): string } }).localStorage.getItem(AI_CHAT_SETTINGS_KEY)));
    eq("aichat.setting.persisted", [raw.on, raw.key], [true, "sk-local-only"]);
    const seenTiers: boolean[] = [];
    const off = onAiChatSettingsChange((v) => seenTiers.push(v.on));
    saveAiChatSettings({ on: false });
    saveAiChatSettings({ on: true });
    off();
    saveAiChatSettings({ on: true });
    eq("aichat.setting.listener", seenTiers, [false, true]);

    // key **不进设置导出**（导出的取值里没有这条路径，文本里也没有 key 本身）
    const file = exportSettings(s);
    eq("aichat.export.no-key-path", Object.prototype.hasOwnProperty.call(file.values, "ai.chatKey"), false);
    ok("aichat.export.no-key-text", JSON.stringify(file).indexOf("sk-local-only") < 0);
    eq("aichat.export.all-paths", Object.keys(file.values).length, SETTINGS.length);
    // 别人塞一个 ai.chatKey 进来：不覆盖本机的 key（这一组本来就不参与设置文件导入，
    // 机密路径那道显式闸门是**双保险**：见下面 isSecretSettingPath 与源码扫描）
    const imp = importSettings(s, { values: { "ai.chatKey": "sk-evil", "ai.chatModel": "other" } });
    eq("aichat.import.applied", [imp.applied, imp.skipped], [0, 0]);
    eq("aichat.import.key-untouched", aiChatSettings().key, "sk-local-only");
    eq("aichat.import.secret-paths", [isSecretSettingPath("ai.chatKey"), isSecretSettingPath("ai.chatModel"), SETTING_SECRET_PATHS.length], [true, false, 1]);
    // 机密路径真的被 exportSettings 跳过（口径：即使以后有人把它挪回 SETTINGS 也不会泄漏）
    ok("aichat.export.secret-guard", readFile("src/app/settings.ts").indexOf("if (isSecretSettingPath(d.path)) continue;") >= 0);
    ok("aichat.setting.kind-pinned", readFile("src/app/settings.ts").indexOf('export type SettingKind = "bool" | "int" | "enum" | "color";') >= 0);
    // 一键清除（§3.6）：声明式 action 挂在 key 那一行上，点一下就清空本机的 key
    const keyDef = SETTINGS_BY_PATH.get("ai.chatKey")!;
    eq("aichat.key.action", keyDef.action?.label, "aiChatKeyClear");
    saveAiChatSettings({ key: "sk-to-clear" });
    keyDef.action!.run(s);
    eq("aichat.key.clear", aiChatSettings().key, "");
    clearAiChatKey();
    eq("aichat.key.clear-api", aiChatSettings().key, "");
    saveAiChatSettings({ key: "sk-local-only" });

    // 设置页与面板的文案：中英各一条，且都不含 key 的值
    const tzh = makeT("zh");
    const ten = makeT("en");
    const bad: string[] = [];
    for (const d of CHAT_SETTINGS) {
      if (tzh(d.label) === d.label || ten(d.label) === d.label) bad.push(d.path + ".label");
      if (d.desc && (tzh(d.desc) === d.desc || ten(d.desc) === d.desc)) bad.push(d.path + ".desc");
    }
    for (const key of ["groupChat", "aiChatErrNoBridge", "aiChatErrOff", "aiChatLocalOnly", "aiChatApply", "aiChatDiscard",
      "aiChatConfirm", "aiChatThinking", "aiChatPlaceholder", "aiChatSend", "aiChatTitle", "aiChatOpen", "aiChatCalls",
      "aiChatKeyClear", "aiChatKeyCleared"]) {
      if (tzh(key) === key || ten(key) === key) bad.push(key);
    }
    eq("aichat.i18n", bad, []);
    ok("aichat.i18n.no-key", [tzh("aiChatKeyDesc"), ten("aiChatKeyDesc")].every((x) => x.indexOf("sk-local-only") < 0));
  }

  // ================================================================ 11. 平台门：没桥接就没有入口
  {
    const modals = readFile("src/ui/modals.tsx");
    const panel = readFile("src/ui/AiPanel.tsx");
    const appSrc = readFile("src/ui/App.tsx");
    const winSrc = readFile("src/ui/AiWindow.tsx");
    ok("aichat.menu.gated", modals.indexOf("bridge.isNativeShell()") >= 0 && modals.indexOf("menu-ai-chat") >= 0);
    ok("aichat.menu.icon", modals.indexOf("FEATURE_ICONS.menu.aiChat") >= 0);
    // P2 起面板挂在**浮窗**里（不再是菜单的子面板）：菜单那一行只负责把浮窗叫出来
    ok("aichat.panel.mounted", winSrc.indexOf("<AiPanel") >= 0 && appSrc.indexOf("<AiWindow") >= 0);
    ok("aichat.panel.gate", panel.indexOf("if (!native)") >= 0 && panel.indexOf("ai-no-bridge") >= 0);
    ok("aichat.panel.preview-then-apply", panel.indexOf("previewAiTurn") >= 0 && panel.indexOf("commitAiTurn") >= 0 && panel.indexOf("rollbackAiTurn") >= 0);
    ok("aichat.panel.commit-false", panel.indexOf("commit: false") >= 0);
    // 卸载时回合还开着 → 立刻放弃。P9 起**没有例外**：最小化 / 关窗 / 返回键 / 别处卸掉同语义
    // （判据是 Session 实况，见 `aiPanelDropsTurnOnUnmount()`；行为断言在第 13 区）
    ok("aichat.panel.unmount-rollback", panel.indexOf("aiPanelDropsTurnOnUnmount(SESSION)") >= 0
      && panel.indexOf("SESSION.rollbackAiTurn();") >= 0
      && panel.indexOf('st.mode') < 0);
    ok("aichat.panel.no-fake-preview", panel.indexOf("aiPanelShowsPreview(aiChatSettings(), SESSION, pending !== null)") >= 0);
    ok("aichat.panel.no-key-in-text", panel.indexOf("cfg.key") > 0 && panel.indexOf("{cfg.key}") < 0);
    ok("aichat.settings.text-row", modals.indexOf('def.text === "password"') >= 0);

    // 行为：删掉原生桥接后，设置里那一组消失、面板只渲染一句说明（没有输入框、没有请求）
    stubEnv();
    const w = (globalThis as unknown as { window: Record<string, unknown> }).window;
    const saved = w.PixelBridge;
    delete w.PixelBridge;
    const s = live();
    const React = require("react");
    const { renderToStaticMarkup } = require("react-dom/server");
    const ssr = (el: unknown): string => renderToStaticMarkup(el as never);
    const menuProps = {
      t: makeT("zh"), snap: null, onClose: () => { /* noop */ }, onOpen: () => { /* noop */ },
      onSheet: () => { /* noop */ }, onRef: () => { /* noop */ }, onGuide: () => { /* noop */ },
    };
    eq("aichat.gate.bridge", isNativeShell(), false);
    eq("aichat.gate.settings", settingsOfGroup(s, "chat").length, 0);
    const html: string = ssr(React.createElement(aiPanelModule.AiPanel, { t: makeT("zh") }));
    ok("aichat.gate.markup", html.indexOf("ai-no-bridge") >= 0, html.slice(0, 120));
    eq("aichat.gate.no-input", html.indexOf("ai-input") < 0, true);
    eq("aichat.gate.no-pending", html.indexOf("ai-pending") < 0, true);
    eq("aichat.gate.no-request", html.indexOf("aiChatPlaceholder") < 0, true);
    // 主菜单里连那一行都不出现（真渲染一遍菜单）
    const menuOff: string = ssr(React.createElement(modalsModule.MenuModal, menuProps));
    eq("aichat.gate.menu-no-entry", menuOff.indexOf("menu-ai-chat") < 0, true);
    eq("aichat.gate.menu-ok", menuOff.indexOf("menu-settings") > 0, true);
    // 设置页里那一组也不渲染（连 key 的输入框都没有）
    const setOff: string = ssr(React.createElement(modalsModule.SettingsModal, { t: makeT("zh"), onClose: () => { /* noop */ } }));
    eq("aichat.gate.settings-no-key", setOff.indexOf("ai.chatKey") < 0, true);
    eq("aichat.gate.settings-no-group", setOff.indexOf("groupChat") < 0, true);

    // 有桥接 + 打开时：面板真的挂出输入框与「key 只存在本机」
    w.PixelBridge = saved;
    saveAiChatSettings({ on: true, endpoint: "https://gateway.test/v1", model: "my-model" });
    const html2: string = ssr(React.createElement(aiPanelModule.AiPanel, { t: makeT("zh") }));
    ok("aichat.native.markup", html2.indexOf("ai-input") >= 0 && html2.indexOf("ai-local-only") >= 0, html2.slice(0, 120));
    ok("aichat.native.shows-config", html2.indexOf("my-model") >= 0 && html2.indexOf("gateway.test") >= 0);
    ok("aichat.native.hides-key", html2.indexOf("sk-local-only") < 0);
    // 菜单入口出现了
    const menuOn: string = ssr(React.createElement(modalsModule.MenuModal, menuProps));
    ok("aichat.native.menu-entry", menuOn.indexOf("menu-ai-chat") >= 0, menuOn.slice(0, 200));
    // 设置页：端点 / 模型是文本框，key 是**密文**输入框（password 形态）
    saveAiChatSettings({ key: "sk-local-only" });
    const setOn: string = ssr(React.createElement(modalsModule.SettingsModal, { t: makeT("zh"), onClose: () => { /* noop */ } }));
    ok("aichat.native.settings-key-row", setOn.indexOf('data-setting="ai.chatKey"') >= 0);
    ok("aichat.native.settings-password", setOn.indexOf('type="password"') >= 0, setOn.slice(setOn.indexOf("ai.chatKey"), setOn.indexOf("ai.chatKey") + 200));
    ok("aichat.native.settings-text-row", setOn.indexOf('data-setting="ai.chatEndpoint"') >= 0 && setOn.indexOf('type="text"') >= 0);
    ok("aichat.native.settings-group", setOn.indexOf("AI 助手") >= 0);
    saveAiChatSettings({ on: false });
  }

  // ================================================================ 12. 直接走 callTool 的口径没变
  // （助手这一层只是循环：工具的校验 / 确认 / 写入路径仍然由 C1/C2 负责）
  {
    const s = live();
    const before = docBytes(s);
    const { ctx, asked } = toolCtx(s, async () => false);
    const blocked = await callTool("erase", { rect: { x: 0, y: 0, w: 2, h: 2 }, fill: true }, ctx);
    eq("aichat.calltool.cancelled", blocked.error, "cancelled");
    eq("aichat.calltool.asked", asked, ["erase"]);
    eq("aichat.calltool.bytes", docBytes(s), before);
    const bad = await callTool("draw_path", { points: [] }, ctx);
    ok("aichat.calltool.validated", bad.ok === false && String(bad.error).indexOf("invalid args") === 0, String(bad.error));
  }

  // ================================================================ 13. 助手浮窗 + 浮动球（P2）
  //
  // 盯住四件事：
  //   · 几何归一化（`pc.aichat.win` / `pc.aichat.ball` 是用户可写的 localStorage，坏数据不许炸）；
  //   · 状态机（开 / 最小化 / 关 / 点球还原）真的挂在 `CHAT_SETTINGS` 上并可持久化；
  //   · 助手球是**独立小球**：`ORB_IDS` 仍然是 5 个（五球系统的断言一条没动）；
  //   · 静态接线：浮窗**不在** `Keep` 里（卸载要立刻跑回合收尾）、触屏互斥、不含 key。
  {
    const s = live();
    const w = (globalThis as unknown as { window: Record<string, unknown> }).window;
    const VW = 1280, VH = 800;
    w.innerWidth = VW; w.innerHeight = VH;

    // ---- 13a 几何归一化：默认 / 坏数据 / 夹取 / 拖动算术 ----
    const def = aiWinDefaultLayout(VW, VH);
    eq("aiwin.def.size", [def.w, def.h, def.min], [380, 460, false]);
    eq("aiwin.def.pos", [def.x, def.y], [VW - 380 - 16, VH - 460 - 16]);
    // 坏数据 → **整份**回默认（不是逐字段修补）
    eq("aiwin.bad.string", normalizeAiWinLayout("nope", VW, VH), def);
    eq("aiwin.bad.null", normalizeAiWinLayout(null, VW, VH), def);
    // 字段齐全但**版本号不认识**（换过口径）→ 整份丢弃；缺 `v` 当 1 用（不丢数据）
    eq("aiwin.bad.version", normalizeAiWinLayout({ v: 99, x: 10, y: 10, w: 300, h: 300 }, VW, VH), def);
    eq("aiwin.bad.string-x", (() => { const l = normalizeAiWinLayout({ v: 1, x: "nope", y: 10, w: 300, h: 300 }, VW, VH); return [l.x, l.y, l.w, l.h]; })(), [def.x, def.y, 380, 460]);
    eq("aiwin.bad.nan-h", (() => { const l = normalizeAiWinLayout({ v: 1, x: 10, y: 10, w: 300, h: NaN }, VW, VH); return [l.x, l.y, l.w, l.h]; })(), [def.x, def.y, 380, 460]);
    // 合法值原样回来（含 min 只认 true）
    eq("aiwin.ok", (() => { const l = normalizeAiWinLayout({ v: 1, x: 100, y: 120, w: 300, h: 340, min: true }, VW, VH); return [l.x, l.y, l.w, l.h, l.min]; })(), [100, 120, 300, 340, true]);
    eq("aiwin.min-only-true", normalizeAiWinLayout({ v: 1, x: 100, y: 120, w: 300, h: 340, min: "yes" }, VW, VH).min, false);
    // 没有版本号但参数齐全 → 照旧保留，只把尺寸夹进上下限（不是整份丢弃）
    eq("aiwin.bad.no-v", (() => { const l = normalizeAiWinLayout({ x: 10, y: 10, w: 3, h: 1 }, VW, VH); return [l.x, l.y, l.w, l.h]; })(), [10, 10, 260, 200]);
    // 夹取：不许拖出视口、尺寸有上下限（最小 260×200，最大 = 视口 - 边距）
    eq("aiwin.clamp.neg", (() => { const l = clampAiWinLayout({ x: -50, y: -90, w: 300, h: 300, min: false }, VW, VH); return [l.x, l.y]; })(), [8, 8]);
    eq("aiwin.clamp.far", (() => { const l = clampAiWinLayout({ x: 9999, y: 9999, w: 300, h: 300, min: false }, VW, VH); return [l.x, l.y]; })(), [VW - 300 - 8, VH - 300 - 8]);
    eq("aiwin.clamp.min-size", (() => { const l = clampAiWinLayout({ x: 0, y: 0, w: 10, h: 10, min: false }, VW, VH); return [l.w, l.h]; })(), [260, 200]);
    eq("aiwin.clamp.max-size", (() => { const l = clampAiWinLayout({ x: 0, y: 0, w: 9999, h: 9999, min: false }, VW, VH); return [l.w, l.h]; })(), [VW - 16, VH - 16]);
    // 视口比最小尺寸还小时不硬撑（以最小尺寸为准，位置仍夹在边距内）
    eq("aiwin.clamp.tiny-view", (() => { const l = clampAiWinLayout({ x: 5, y: 5, w: 300, h: 300, min: false }, 200, 150); return [l.w, l.h, l.x, l.y]; })(), [260, 200, 8, 8]);
    // 拖动 / 缩放的算术（每次从**按下那一刻**的几何重算，不累加）
    const l0 = { x: 100, y: 100, w: 300, h: 340, min: false };
    eq("aiwin.drag.move", (() => { const l = aiWinDragFrom(l0, "move", 40, -25); return [l.x, l.y, l.w, l.h]; })(), [140, 75, 300, 340]);
    eq("aiwin.drag.resize", (() => { const l = aiWinDragFrom(l0, "resize", -20, 60); return [l.x, l.y, l.w, l.h]; })(), [100, 100, 280, 400]);
    // 拖出屏幕后夹回来：位置是「起点 + 位移」的结果，不是被一帧帧挤歪的值
    eq("aiwin.drag.no-drift", (() => {
      const far = clampAiWinLayout(aiWinDragFrom(l0, "move", 9999, 0), VW, VH);
      const back = clampAiWinLayout(aiWinDragFrom(l0, "move", 0, 0), VW, VH);
      return [far.x, back.x, back.y];
    })(), [VW - 300 - 8, 100, 100]);
    // 缩放同样夹进「视口 - 边距」（x/y 不动，所以上限就是视口 - 边距）
    eq("aiwin.drag.clamped", (() => { const l = clampAiWinLayout(aiWinDragFrom(l0, "resize", 9999, 9999), VW, VH); return [l.w, l.h]; })(), [VW - AI_WIN_EDGE * 2, VH - AI_WIN_EDGE * 2]);

    // ---- 13b 小球位置：默认贴右下角并抬 32px 让开底栏，坏数据回落 ----
    const ORB = 52;
    const bdef = aiBallDefaultPos(ORB, VW, VH);
    eq("aiwin.ball.def", bdef, { x: VW - ORB - 16, y: VH - ORB - 32 });
    eq("aiwin.ball.bad", normalizeAiBallPos({ x: "no", y: 3 }, ORB, VW, VH), bdef);
    eq("aiwin.ball.null", normalizeAiBallPos(null, ORB, VW, VH), bdef);
    eq("aiwin.ball.clamped", clampAiBallPos({ x: -20, y: -20 }, ORB, VW, VH), { x: 8, y: 8 });
    eq("aiwin.ball.kept", normalizeAiBallPos({ x: 400, y: 300 }, ORB, VW, VH), { x: 400, y: 300 });

    // ---- 13c 状态机：窗口三布尔进 CHAT_SETTINGS（`pc.aichat`），几何进 localStorage ----
    eq("aiwin.setting.paths", CHAT_SETTINGS.map((d) => d.path),
      ["ai.chatOn", "ai.chatPreset", "ai.chatEndpoint", "ai.chatModel", "ai.chatKey", "ai.providerBase",
        "ai.chatMaxRounds", "ai.chatTemp", "ai.chatThinking", "ai.chatTimeoutSec",
        "ai.chatSystemPrompt", "ai.chatStream", "ai.protectKey",
        "ai.chatWinOpen", "ai.chatWinMin", "ai.chatBall"]);
    eq("aiwin.setting.win-defaults",
      [SETTINGS_BY_PATH.get("ai.chatWinOpen")!.default, SETTINGS_BY_PATH.get("ai.chatWinMin")!.default, SETTINGS_BY_PATH.get("ai.chatBall")!.default],
      [false, false, true]);
    ok("aiwin.setting.bool-kind", ["ai.chatWinOpen", "ai.chatWinMin", "ai.chatBall"]
      .every((p) => SETTINGS_BY_PATH.get(p)!.kind === "bool" && !SETTINGS_BY_PATH.get(p)!.text));
    // 两条窗口**状态**（开着吗 / 最小化了吗）在设置页里不显示；`ai.chatBall` 是用户真的要调的
    // 开关，所以它与别的 chat 行一起露出来（P8/W2：§3.7.7 的可见清单）
    const s2 = live();
    saveAiChatSettings({ on: true });
    eq("aiwin.setting.hidden-in-page", settingsOfGroup(s2, "chat").map((d) => d.path).filter((p) => p.indexOf("ai.chatWin") === 0), []);
    ok("aiwin.setting.ball-visible", settingsOfGroup(s2, "chat").map((d) => d.path).indexOf("ai.chatBall") > 0);
    ok("aiwin.setting.state-hidden", SETTINGS_BY_PATH.get("ai.chatWinOpen")!.visible!(s2) === false
      && SETTINGS_BY_PATH.get("ai.chatWinMin")!.visible!(s2) === false);
    // 窗口开 → 最小化 → 关：状态跟着走，且**不动 key**
    saveAiChatSettings({ key: "sk-local-only", on: true, winOpen: false, winMin: false });
    s2.setSetting("ai.chatWinOpen", true);
    eq("aiwin.state.open", [aiChatSettings().winOpen, s2.settingValue("ai.chatWinOpen")], [true, true]);
    s2.setSetting("ai.chatWinMin", true);
    eq("aiwin.state.min", [aiChatSettings().winMin, aiChatSettings().key], [true, "sk-local-only"]);
    eq("aiwin.state.persisted",
      JSON.parse(String((globalThis as unknown as { localStorage: { getItem(k: string): string } }).localStorage.getItem(AI_CHAT_SETTINGS_KEY))).winMin, true);
    s2.setSetting("ai.chatWinOpen", false);
    eq("aiwin.state.closed", [aiChatSettings().winOpen, s2.settingValue("ai.chatBall")], [false, true]);
    // 同样恢复成**整对象比较**（P15 第 3 项：3 字段子集形态同类，一并改掉）
    eq("aiwin.state.normalize", normalizeAiChatSettings({ winOpen: 1, winMin: "x" }), {
      on: false, preset: "deepseek", endpoint: "", model: "", key: "", providerBase: "",
      maxRounds: 12, temp: 0, thinking: "default", timeoutSec: 60, systemPrompt: "", stream: true, protectKey: true,
      winOpen: false, winMin: false, ball: true,
    });
    eq("aiwin.state.ball-default", normalizeAiChatSettings({}).ball, true);
    eq("aiwin.state.ball-off", normalizeAiChatSettings({ ball: false }).ball, false);
    // 几何的持久化：写 → 读回来一模一样（刷新后复原靠的就是这一步）
    const savedWin = { v: 1, x: 300, y: 220, w: 420, h: 500, min: true };
    (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem(AI_CHAT_WIN_KEY, JSON.stringify(savedWin));
    eq("aiwin.persist.roundtrip", (() => {
      const l = normalizeAiWinLayout(JSON.parse(String((globalThis as unknown as { localStorage: { getItem(k: string): string } }).localStorage.getItem(AI_CHAT_WIN_KEY))), VW, VH);
      return [l.x, l.y, l.w, l.h, l.min];
    })(), [300, 220, 420, 500, true]);
    (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem(AI_CHAT_BALL_KEY, JSON.stringify({ x: 12, y: 34 }));
    eq("aiwin.ball.persist", normalizeAiBallPos(JSON.parse(String((globalThis as unknown as { localStorage: { getItem(k: string): string } }).localStorage.getItem(AI_CHAT_BALL_KEY))), ORB, VW, VH), { x: 12, y: 34 });

    // ---- 13d 助手球是**独立小球**：五球系统的口径一点没变 ----
    eq("aiwin.orb.count-unchanged", ORB_IDS.length, 5);
    ok("aiwin.orb.id-not-in-orbs", (ORB_IDS as readonly string[]).indexOf(CHAT_BALL_ID) < 0, CHAT_BALL_ID);
    eq("aiwin.orb.chat-ball-id", CHAT_BALL_ID, "ai");

    // ---- 13e 静态接线（没有 DOM，所以查源码：与既有 ui.* 静态断言同一套做法）----
    const appSrc = readFile("src/ui/App.tsx");
    const winSrc = readFile("src/ui/AiWindow.tsx");
    const modals = readFile("src/ui/modals.tsx");
    const panelSrc = readFile("src/ui/AiPanel.tsx");
    const ballSrc = winSrc + "\n" + panelSrc;   // 浮窗 + 面板 + 小球都在这一组里
    // 浮窗**不在** Keep 里：它靠卸载跑回合收尾，延迟卸载不行
    ok("aiwin.app.mounts-fresh", appSrc.indexOf("{aiOn && !aiCfg.winMin && <AiWindow") >= 0);
    ok("aiwin.app.ball-mount", appSrc.indexOf("<ChatBall t={t} onRestore={restoreAiWin}") >= 0);
    ok("aiwin.app.drag-before-unmount", appSrc.indexOf("const openAiWin = ()") >= 0 && appSrc.indexOf('window.addEventListener("pc-ai-window"') > 0);
    // Android 返回键 = 最小化（**不关窗**，与窗口按钮同一个入口 = 同语义）
    ok("aiwin.app.back-minimises", appSrc.indexOf('window.addEventListener("pc-back", onBack)') > 0
      && appSrc.indexOf("minimizeAiWin();") > 0
      && appSrc.indexOf("aiWinStore.mode") < 0);
    // 触屏互斥：助手球点/拖时收起别的球的环
    ok("aiwin.app.radial-exclusive", appSrc.indexOf('window.addEventListener("pc-ai-ball-tap"') > 0 && appSrc.indexOf("closeRadialsRef.current()") > 0);
    // 收尾说明由**面板卸载钩子**写（比 App 晚，不会被面板的「同步进存储」覆盖）
    ok("aiwin.panel.close-note", panelSrc.indexOf("noteAiWinClosed(t(\"aiChatDiscarded\"))") > 0
      && appSrc.indexOf('<AiWindow t={t} onMinimize={minimizeAiWin}') > 0);
    // 浮窗是 portal 到 body 的浮层，退出 MenuModal 子面板路径
    ok("aiwin.portal", winSrc.indexOf("createPortal") > 0 && winSrc.indexOf("document.body") > 0);
    ok("aiwin.leaves-menu-sub", modals.indexOf('setSub("ai")') < 0 && modals.indexOf("onAiWindow") > 0);
    ok("aiwin.menu-entry-kept", modals.indexOf("menu-ai-chat") > 0 && modals.indexOf("bridge.isNativeShell()") > 0);
    // 拖动 / 缩放只用指针事件（触屏与电脑同一路径）
    ok("aiwin.pointer-only", ballSrc.indexOf("onPointerDown") > 0 && ballSrc.indexOf("pointermove") > 0
      && ballSrc.indexOf("onMouseDown") < 0 && ballSrc.indexOf("mousedown") < 0 && ballSrc.indexOf("touchstart") < 0);
    // 面板与浮窗的源码里都没有回显 key 的路径
    ok("aiwin.no-key-text", ballSrc.indexOf("{cfg.key}") < 0 && ballSrc.indexOf("{key}") < 0);
    // 最小化 / 关窗走**各自唯一**的入口，卸载钩子只问 Session 实况（没有第二份状态可漂移）
    ok("aiwin.panel.unmount-minimize", panelSrc.indexOf("aiPanelDropsTurnOnUnmount(SESSION)") > 0
      && panelSrc.indexOf("st.mode") < 0);
    ok("aiwin.app.single-minimize-entry", appSrc.indexOf("const minimizeAiWin = ()") > 0
      && appSrc.indexOf("<AiWindow t={t} onMinimize={minimizeAiWin} onClose={closeAiWin} />") > 0
      && winSrc.indexOf("onMinimize") > 0 && winSrc.indexOf("saveAiChatSettings") < 0);
    ok("aiwin.panel.store", panelSrc.indexOf("store?: AiWinStore") > 0);

    // ---- 13d2 P9 判定：最小化与关窗**同语义 = 都放弃回合**，而且判定只认 Session 实况 ----
    // 早先的写法是「在调用点记 `aiWinStore.mode`」：`pc-back` 那条记了、窗口按钮那条没记，
    // 于是两条路径语义相反。现在 `aiPanelDropsTurnOnUnmount()` 的输入只有 Session，
    // **cfg（开/最小化）都不参与** —— 新增第五条、第六条路径因此不会漏。
    const sOpen = live();
    // **真开一轮**（回合事务的公开 API）再验判据，而不是只拿个句柄
    eq("aiwin.p9.begin", beginAiTurn("P9 判定") > 0, true);
    eq("aiwin.p9.turn-open-on-config", sOpen.aiTurnOpen(), true);
    let drops = 0;
    for (let i = 0; i < 4; i++) if (aiPanelDropsTurnOnUnmount(sOpen)) drops++;   // 四条路径都只问同一件事
    eq("aiwin.p9.all-four-paths-drop", drops, 4);
    eq("aiwin.p9.drops-ignores-window-state", aiPanelDropsTurnOnUnmount(sOpen), true);   // 最小化着也照样丢
    eq("aiwin.p9.no-turn-no-drop", aiPanelDropsTurnOnUnmount({ aiTurnOpen: () => false }), false);
    rollbackTurn();
    eq("aiwin.p9.closed.drops", aiPanelDropsTurnOnUnmount(sOpen), false);
    // 预览 UI：只有「看得见 + 回合真开着」才画（假预览态画不出来）
    const openTurn = { aiTurnOpen: () => true };
    const shutTurn = { aiTurnOpen: () => false };
    eq("aiwin.preview.visible", aiPanelShowsPreview({ winOpen: true, winMin: false }, openTurn, true), true);
    eq("aiwin.preview.minimised", aiPanelShowsPreview({ winOpen: true, winMin: true }, openTurn, true), false);
    eq("aiwin.preview.closed", aiPanelShowsPreview({ winOpen: false, winMin: false }, openTurn, true), false);
    eq("aiwin.preview.turn-already-gone", aiPanelShowsPreview({ winOpen: true, winMin: false }, shutTurn, true), false);
    eq("aiwin.preview.no-pending", aiPanelShowsPreview({ winOpen: true, winMin: false }, openTurn, false), false);

    // ---- 13d3 P9 行为：卸载钩子那一问的**后果**是逐字节回滚（四条路径同一条规则）----
    // 四条路径（按钮 / 双击 / 返回键 / 直接写 winMin）在 App 侧都只写 `winMin` 然后卸载面板，
    // 面板卸载时问的就是 `aiPanelDropsTurnOnUnmount(SESSION)`。这里用**真回合**（假端点跑一轮，
    // 与第 7 区「放弃」同一个口径）把那个「问 → 回滚」跑四遍：每遍都验回合关掉 + 文档逐字节回原样。
    {
      const s9 = live();
      const baseline = docBytes(s9);
      const hist9 = histLen(s9);
      for (let i = 0; i < 4; i++) {
        const { fn } = fakeFetch([
          reply([{ id: "q" + i, name: "draw_path", args: { points: [[3 + i, 5], [6 + i, 5]], color: "#ff0000" } }]),
          reply([], "画好了。"),
        ]);
        const r9 = await runChatTurn({ ...turnOpts(s9, fn), commit: false });
        eq("aiwin.p9.path" + i + ".turn-open", r9.turnOpen, true);
        ok("aiwin.p9.path" + i + ".dirty", docBytes(s9) !== baseline);
        eq("aiwin.p9.path" + i + ".unmount-drops", aiPanelDropsTurnOnUnmount(s9), true);
        s9.rollbackAiTurn();                                  // 卸载钩子做的就是这一下
        eq("aiwin.p9.path" + i + ".bytes", docBytes(s9), baseline);
        eq("aiwin.p9.path" + i + ".closed", s9.aiTurnOpen(), false);
        eq("aiwin.p9.path" + i + ".hist-untouched", histLen(s9), hist9);
      }
    }

    // ---- 13f 会话存储：跨卸载保留对话，关窗时给还没收尾的那轮留痕 ----
    aiWinStore.thread = []; aiWinStore.entries = []; aiWinStore.pending = null; aiWinStore.logs = []; aiWinStore.input = "";
    aiWinStore.entries = [{ role: "user", text: "画一条红线" }];
    noteAiWinClosed("已放弃");
    eq("aiwin.store.no-pending-no-note", aiWinStore.entries.length, 1);
    aiWinStore.pending = { calls: 1, rect: null, docRev: 3, docRevBefore: 1 };
    aiWinStore.logs = [{ id: "x", name: "draw_path", args: {}, ok: true, changed: null, docRev: 3, revDelta: 1 } as never];
    noteAiWinClosed("已放弃");
    eq("aiwin.store.note-on-pending", [aiWinStore.pending, aiWinStore.logs.length, aiWinStore.entries.length], [null, 0, 2]);
    eq("aiwin.store.note-keeps-user-line", aiWinStore.entries[0].text, "画一条红线");
    aiWinStore.entries = []; aiWinStore.pending = null; aiWinStore.logs = [];

    // ---- 13g 平台门下的 SSR 冒烟：没有桥接时浮窗与球都渲染成空 ----
    const saved = w.PixelBridge;
    delete w.PixelBridge;
    const React = require("react");
    const { renderToStaticMarkup } = require("react-dom/server");
    const ssr = (el: unknown): string => renderToStaticMarkup(el as never);
    saveAiChatSettings({ winOpen: true, winMin: false, ball: true });
    eq("aiwin.gate.window", ssr(React.createElement(aiWindowModule.AiWindow, { t: makeT("zh"), onClose: () => { /* noop */ } })), "");
    eq("aiwin.gate.ball", ssr(React.createElement(ChatBall, { t: makeT("zh"), onRestore: () => { /* noop */ }, onOtherRings: () => { /* noop */ } })), "");
    eq("aiwin.gate.window-no-input", ssr(React.createElement(aiWindowModule.AiWindow, { t: makeT("zh"), onClose: () => { /* noop */ } })).indexOf("ai-input") < 0, true);
    // 有桥接 + 最小化：球画出来了（锚点 / 图标 / 数据属性都对）
    w.PixelBridge = saved;
    const ballHtml: string = ssr(React.createElement(ChatBall, { t: makeT("zh"), onRestore: () => { /* noop */ }, onOtherRings: () => { /* noop */ } }));
    ok("aiwin.ball.markup", ballHtml.indexOf('data-guide="orb-ai"') >= 0 && ballHtml.indexOf('data-orb-id="ai"') >= 0, ballHtml.slice(0, 160));
    ok("aiwin.ball.class", ballHtml.indexOf('class="orb sub"') >= 0);
    ok("aiwin.ball.icon", ballHtml.indexOf("i-ai-chat") >= 0);
    ok("aiwin.ball.no-key", ballHtml.indexOf("sk-local-only") < 0);
    saveAiChatSettings({ on: false, winOpen: false, winMin: false, ball: true });
  }

  // ================================================================ 14. 厂商预设（P3/W2，§3.7.7）
  //
  // 盯住五件事：①默认预设就是 DeepSeek（开箱即用）；②切预设写端点 + 模型两个值；
  // ③**切预设绝不碰 key**（三个预设切一圈，key 一字不变）；④切到 custom 不清空端点 / 模型；
  // ⑤预设行是 enum chips，端点 / 模型仍是自由文本（`SettingKind` 不新增）。
  {
    const s = live();
    stubEnv();
    // ① 默认：预设 id = deepseek，端点 / 模型就是 DeepSeek 那一组（声明默认值同源）
    eq("preset.default-id", AI_CHAT_DEFAULT_PRESET, "deepseek");
    eq("preset.default-values", [AI_CHAT_PRESETS[0].baseUrl, AI_CHAT_PRESETS[0].defaultModel],
      ["https://api.deepseek.com", "deepseek-v4-pro"]);
    eq("preset.declared-defaults",
      [SETTINGS_BY_PATH.get("ai.chatPreset")!.default, SETTINGS_BY_PATH.get("ai.chatEndpoint")!.default,
        SETTINGS_BY_PATH.get("ai.chatModel")!.default],
      ["deepseek", "https://api.deepseek.com", "deepseek-v4-pro"]);
    // 模型清单：只有官方文档里当前有的两个名字，**不含已下线的旧名**
    eq("preset.deepseek-models", AI_CHAT_PRESETS[0].models, ["deepseek-v4-pro", "deepseek-flash"]);
    eq("preset.no-retired-model", AI_CHAT_PRESETS[0].models.filter((m) => m === "deepseek-v4-chat" || m === "deepseek-chat" || m === "deepseek-reasoner" || m === "deepseek-v4-flash"), []);
    // 预设行是 enum（chips），三个选项与预设表同源；端点 / 模型仍是 text:"plain"
    const presetDef = SETTINGS_BY_PATH.get("ai.chatPreset")!;
    eq("preset.row-kind", [presetDef.kind, presetDef.text, (presetDef.options ?? []).map((o) => o.value)],
      ["enum", undefined, ["deepseek", "openai", "custom"]]);
    eq("preset.row-text-rows", [SETTINGS_BY_PATH.get("ai.chatEndpoint")!.text, SETTINGS_BY_PATH.get("ai.chatModel")!.text],
      ["plain", "plain"]);

    // ②③ 切预设：端点 + 模型跟着走，key 一字不变
    saveAiChatSettings({ on: true, key: "sk-preset-untouched" });
    const before = aiChatSettings().key;
    const afterDeepseek = applyAiChatPreset("deepseek");
    eq("preset.switch.deepseek", [afterDeepseek.preset, afterDeepseek.endpoint, afterDeepseek.model],
      ["deepseek", "https://api.deepseek.com", "deepseek-v4-pro"]);
    const afterOpenai = applyAiChatPreset("openai");
    eq("preset.switch.openai", [afterOpenai.preset, afterOpenai.endpoint, afterOpenai.model],
      ["openai", "https://api.openai.com/v1", "gpt-4o-mini"]);
    eq("preset.switch.key-untouched", [before, aiChatSettings().key], ["sk-preset-untouched", "sk-preset-untouched"]);

    // ④ 切到 custom：**一个字段都不写**（端点 / 模型保持切换前的值），只记住 preset
    const beforeCustom = aiChatSettings();
    const afterCustom = applyAiChatPreset("custom");
    eq("preset.custom.keeps-values", [afterCustom.endpoint, afterCustom.model],
      [beforeCustom.endpoint, beforeCustom.model]);
    eq("preset.custom.preset", afterCustom.preset, "custom");
    eq("preset.custom.key", afterCustom.key, "sk-preset-untouched");
    // 用户切到 custom 后自己手填的端点 / 模型照样存得住（自由文本行）
    s.setSetting("ai.chatEndpoint", "https://my-gateway.test/v1");
    s.setSetting("ai.chatModel", "my-model");
    eq("preset.custom.free-text", [aiChatSettings().endpoint, aiChatSettings().model],
      ["https://my-gateway.test/v1", "my-model"]);
    // 坏数值 / 不认识的 id → 回默认预设与默认值（不抛）
    eq("preset.bad-id", [normalizePresetId("nope"), normalizePresetId(7), aiChatPresetOf("nope").id],
      ["deepseek", "deepseek", "deepseek"]);
    eq("preset.persisted", JSON.parse(String(
      (globalThis as unknown as { localStorage: { getItem(k: string): string } }).localStorage.getItem(AI_CHAT_SETTINGS_KEY))).preset, "custom");
    // 这一轮的落盘里也没有 key 明文之外的意外字段（预设不引入新的存储键）
    eq("preset.no-new-storage", Object.keys(normalizeAiChatSettings(null)).sort(),
      ["ball", "endpoint", "key", "maxRounds", "model", "on", "preset", "protectKey", "providerBase",
        "stream", "systemPrompt", "temp", "thinking", "timeoutSec", "winMin", "winOpen"]);
    saveAiChatSettings({ on: false, key: "" });
  }

  // ================================================================ 14b. 流式输出（`ai.chatStream`，§26.6）
  //
  // 盯四件事（名字统一 `stream.*` 前缀）：
  //   ① SSE 文本分片能拼出**最终文本**，`reasoning_content` **单独累积**；
  //   ② 分片 `tool_calls`（第一片带 id/name，后续片是 arguments 字符串片段）拼出来的形状
  //      与整包**逐字段相同** —— 这是「整轮循环一个字节都不变」的证据；
  //   ③ 端点不是 `text/event-stream` / 流中途抛错 → **自动降级**成整包，并说明原因；
  //   ④ 流式下 `assistantMessage()` 仍带回 `reasoning_content`（DeepSeek 带 tools 时后续必须回传）。
  {
    stubEnv();
    const S_REASON = "先看画布，再决定用哪把工具";
    const S_TEXT = "画好了：一条红线。";
    const S_ARGS = '{"points":[[1,1],[4,1]],"color":"#ff0000"}';
    /** 流式增量回调收到的正文 / 思考（面板就是拿它们让文字长出来的） */
    const partsText: string[] = [];
    const partsReason: string[] = [];
    const partsNoSse: string[] = [];

    // ---- ① 纯函数层：分片 → 状态 → 文本 / 思考 ----
    const state = newChatStreamState();
    for (const raw of ["data: " + JSON.stringify({ choices: [{ delta: { content: "你" } }] }) + "\n\n",
      "data: " + JSON.stringify({ choices: [{ delta: { reasoning_content: "想" } }] }) + "\n\n"]) {
      const split = splitSseChunk("", raw);
      for (const d of split.events) appendStreamChunk(state, parseSseData(d));
    }
    // 跨块：一个事件的 JSON **切两半**，第二次调用必须能拼回来（`carry` 的职责）
    const half = JSON.stringify({ choices: [{ delta: { content: "好" } }] });
    const s1 = splitSseChunk("", "data: " + half.slice(0, 12));
    eq("stream.split.carry-open", s1.events.length, 0);
    const s2 = splitSseChunk(s1.carry, half.slice(12) + "\n\n");
    eq("stream.split.carry-closed", s2.events, [half]);
    eq("stream.split.carry-drained", s2.carry, "");
    appendStreamChunk(state, parseSseData(s2.events[0]));
    eq("stream.text.accumulated", responseText(streamResponse(state)), "你好");
    eq("stream.reasoning.accumulated", state.message.reasoning_content, "想");

    // ---- ② 工具调用分片 → 与 parseToolCalls() **逐字段相同** ----
    const fullMsg = {
      choices: [{ message: {
        role: "assistant", content: S_TEXT, reasoning_content: S_REASON,
        tool_calls: [{ id: "c1", type: "function", function: { name: "draw_path", arguments: S_ARGS } }],
      } }],
    };
    const tState = newChatStreamState();
    let tCarry = "";
    for (const piece of sseChunks(S_TEXT, S_REASON, [{ id: "c1", name: "draw_path", args: S_ARGS }])) {
      const split = splitSseChunk(tCarry, piece);
      tCarry = split.carry;
      for (const d of split.events) {
        const parsed = parseSseData(d);
        if (parsed !== null && parsed !== undefined) appendStreamChunk(tState, parsed);
      }
    }
    const tResponse = streamResponse(tState);
    const streamCalls = parseToolCalls(tResponse);
    const fullCalls = parseToolCalls(fullMsg);
    eq("stream.tools.identical-to-full", streamCalls, fullCalls);
    // 逐字段钉一遍（上面那条是整对象比较，这里再拆开写死，回归时一眼能看出是哪个字段坏了）
    eq("stream.tools.field-wise", [streamCalls.length, streamCalls[0].id, streamCalls[0].name, streamCalls[0].raw, streamCalls[0].args, !!streamCalls[0].error],
      [1, "c1", "draw_path", S_ARGS, { points: [[1, 1], [4, 1]], color: "#ff0000" }, false]);
    // 形状本身也要与整包一致（回灌给端点的那条 assistant 消息）
    eq("stream.assistant-same-as-full", assistantMessage(tResponse), assistantMessage(fullMsg));
    // ---- ④ 流式下 `reasoning_content` 仍要回传（DeepSeek 带 tools 的硬要求）----
    eq("stream.assistant.carries-reasoning", assistantMessage(tResponse).reasoning_content, S_REASON);

    // ---- ③ 降级：不是 text/event-stream（端点不支持 SSE）→ 同一个响应按整包解析 ----
    const sNoSse = live();
    const backNoSse: unknown[] = [];
    const { fn: noSseFn, seen: noSseSeen } = fakeFetch([
      streamReply({ content: "整包也画好了" }, { contentType: "application/json" }),
    ]);
    const wrapNoSse: ChatFetch = async (url, init) => {
      backNoSse.push(JSON.parse(String(init.body)));
      return noSseFn(url, init);
    };
    const rNoSse = await runChatTurn({
      ...turnOpts(sNoSse, wrapNoSse), commit: false, stream: true,
      onText: (v) => partsNoSse.push(v),
    });
    eq("stream.fallback.not-sse.requests", backNoSse.length, 1);       // **不重发**
    eq("stream.fallback.not-sse.text", rNoSse.text, "整包也画好了");
    eq("stream.fallback.not-sse.note", [rNoSse.streamNote.used, rNoSse.streamNote.fellBack, rNoSse.streamNote.reason],
      [false, true, AI_CHAT_STREAM_FALLBACK_NOT_SSE]);
    eq("stream.fallback.not-sse.no-deltas", partsNoSse.length, 0);     // 降级 = 一次增量都没有

    // ---- ③' 降级：流中途抛错 → 重发一次**整包**（第二次请求不带 stream）----
    const sBroken = live();
    const brokenBodies: any[] = [];
    const { fn: okInner } = fakeFetch([{ body: JSON.stringify({ choices: [{ message: { role: "assistant", content: "整包救回来了" } }] }) }]);
    const brokenFetch: ChatFetch = async (url, init) => {
      brokenBodies.push(JSON.parse(String(init.body)));
      if (brokenBodies.length === 1) {
        const pieces = sseChunks("半截", "", []).slice(0, 1);
        return {
          ok: true, status: 200, text: async () => "",
          headers: { get: () => "text/event-stream" },
          // 吐完一块就**断掉**（网关挂掉 / 网络断的真实样子：迭代器抛错）
          chunks: async function* (): AsyncIterable<string> {
            for (const p of pieces) yield p;
            throw new Error("upstream stream reset");
          },
        };
      }
      return okInner(url, init);
    };
    const rBroken = await runChatTurn({
      ...turnOpts(sBroken, brokenFetch), commit: false, stream: true, maxRounds: 1,
    });
    eq("stream.fallback.broken.requests", brokenBodies.length, 2);
    eq("stream.fallback.broken.second-not-stream", brokenBodies[1].stream, undefined);
    eq("stream.fallback.broken.text", rBroken.text, "整包救回来了");
    eq("stream.fallback.broken.note", [rBroken.streamNote.used, rBroken.streamNote.fellBack, rBroken.streamNote.reason],
      [false, true, AI_CHAT_STREAM_FALLBACK_BROKEN]);

    // ---- 真流式整轮：逐块回调 + 与整包逐字段相同 ----
    const sStream = live();
    const { fn: streamFn, seen: seenStream } = fakeFetch([
      streamReply({ content: "画好了", reasoning: "先读画布，再落笔" }),
    ]);
    const rStream = await runChatTurn({
      ...turnOpts(sStream, streamFn), commit: false, stream: true,
      onText: (v) => partsText.push(v), onReasoning: (v) => partsReason.push(v),
    });
    eq("stream.turn.stream-body", seenStream[0].body.stream, true);
    eq("stream.turn.text", rStream.text, "画好了");
    eq("stream.turn.note", [rStream.streamNote.used, rStream.streamNote.fellBack], [true, false]);
    // 逐块：至少来过一次，且**最后一次就是终值**（面板照着它让文字长出来）
    ok("stream.turn.on-text-grows", partsText.length >= 2 && partsText[partsText.length - 1] === "画好了", JSON.stringify(partsText));
    ok("stream.turn.on-reasoning-grows", partsReason.length >= 2 && partsReason[partsReason.length - 1] === "先读画布，再落笔",
      JSON.stringify(partsReason));
    eq("stream.turn.assistant-carries-reasoning",
      rStream.messages.filter((m) => m.role === "assistant").map((m) => m.reasoning_content), ["先读画布，再落笔"]);
    // 关掉 `stream` 时**一个字节都不发**这个字段（从前的行为逐字不变）
    const { fn: offFn, seen: seenOff } = fakeFetch([streamReply({ content: "普通" }, { contentType: null })]);
    const rOff = await runChatTurn({ ...turnOpts(live(), offFn), commit: false, stream: false });
    eq("stream.off.no-field", Object.prototype.hasOwnProperty.call(seenOff[0].body, "stream"), false);
    eq("stream.off.text", rOff.text, "普通");
    eq("stream.off.note", [rOff.streamNote.used, rOff.streamNote.fellBack], [false, false]);

    // ---- 流式 + 多轮工具调用：一轮一条 undo / 预览后应用一个字都没变 ----
    const sTools = live();
    const beforeTools = docBytes(sTools);
    const histBeforeTools = histLen(sTools);
    const { ctx: ctxTools } = toolCtx(sTools);
    const { fn: toolsFn, seen: seenTools } = fakeFetch([
      streamReply({ content: "", reasoning: "先看一眼", calls: [{ id: "c1", name: "draw_path", args: S_ARGS }] }),
      streamReply({ content: "画完了", reasoning: "收工" }),
    ]);
    const rTools = await runChatTurn({
      messages: [systemMessage(), userMessage("画一条红线")], ctx: ctxTools,
      endpoint: "https://endpoint.test/v1", model: "test-model", key: "sk-test-key",
      fetchFn: toolsFn, commit: false, stream: true, maxRounds: 3,
    });
    eq("stream.loop.rounds", rTools.rounds, 2);
    eq("stream.loop.calls", rTools.calls.map((c) => c.name), ["draw_path"]);
    eq("stream.loop.pixel", pxSoft(sTools, 0, 1, 1), [255, 0, 0, 255]);
    eq("stream.loop.turn-open", rTools.turnOpen, true);
    eq("stream.loop.history-untouched", histLen(sTools), histBeforeTools);   // 预览模式：还没落历史
    eq("stream.loop.second-round-carries-reasoning",
      (seenTools[1].body.messages as ChatMessage[]).filter((m) => m.role === "assistant").map((m) => m.reasoning_content),
      ["先看一眼"]);
    sTools.commitAiTurn();
    eq("stream.loop.one-undo-entry", histLen(sTools) - histBeforeTools, 1);
    sTools.undo();
    eq("stream.loop.undo-restores-bytes", docBytes(sTools), beforeTools);
    // `[DONE]` / 注释行 / 坏 JSON 都不抛异常
    eq("stream.sse.done-is-null", parseSseData("[DONE]"), null);
    eq("stream.sse.junk-skipped", [parseSseData(""), parseSseData("{oops")], [undefined, undefined]);
    eq("stream.split.ignores-comments", splitSseChunk("", ": hb\n\nevent: x\ndata: {}\n\n").events, ["{}"]);
    // `consumeSseStream()` 直接吃一个**逐块**迭代器（不必先拼成整段）
    const chunks: string[] = sseChunks("逐块", "", []);
    const consumed = await consumeSseStream((async function* (): AsyncIterable<string> {
      for (const c of chunks) yield c;
    })());
    eq("stream.consume.final-text", responseText(streamResponse(consumed)), "逐块");
  }

  // ================================================================ 15. 通路：环境 key → 同源代理（P3/W1，§3.7.2/§3.7.3）
  //
  // 全用**假 fetch**，不碰网络：这里只钉请求形状与错误文案映射。
  // 真壳的端到端自测在实现任务里用无头浏览器单独跑（不落进仓库）。
  {
    stubEnv();
    resetChatTransport();
    const CN = "sk-env-probe";                       // 假的环境 key：任何文本里都不许出现它

    // ---- 15a 探测响应解析：缺字段 / 不是对象 / 不是 JSON → 一律当「没有代理」----
    eq("proxy.cfg.valid", readHostProviderConfig({
      ok: true, proxy: true, baseUrl: "https://api.deepseek.com", defaultModel: "deepseek-v4-pro",
      models: ["deepseek-v4-pro", "deepseek-flash"], hasEnvKey: true, keySource: "env",
    }), { proxy: true, baseUrl: "https://api.deepseek.com", defaultModel: "deepseek-v4-pro",
      models: ["deepseek-v4-pro", "deepseek-flash"], hasEnvKey: true });
    eq("proxy.cfg.proxy-off", readHostProviderConfig({ ok: true, proxy: false, hasEnvKey: true }), null);
    eq("proxy.cfg.missing-base", readHostProviderConfig({ proxy: true, defaultModel: "m", hasEnvKey: true }), null);
    eq("proxy.cfg.missing-model", readHostProviderConfig({ proxy: true, baseUrl: "https://x.test", hasEnvKey: true }), null);
    eq("proxy.cfg.junk", [readHostProviderConfig(null), readHostProviderConfig("nope"), readHostProviderConfig([{}])], [null, null, null]);
    eq("proxy.cfg.no-key-flag", readHostProviderConfig({ proxy: true, baseUrl: "https://x.test", defaultModel: "m" })!.hasEnvKey, false);
    // 代理 URL 是**同源相对路径**（换端口不用改代码）；`base` 已经**不参与**拼装（P8 的 F2）
    eq("proxy.url.relative", chatProxyUrl(""), AI_CHAT_PROXY_CHAT_PATH);
    eq("proxy.url.base-ignored", chatProxyUrl("http://127.0.0.1:8787/"), AI_CHAT_PROXY_CHAT_PATH);
    // ⚠️ 反向断言：拿 **provider 基地址** 当 base 也**不许**拼进去 ——
    // 生产下就是这一条把请求发到了 `https://api.deepseek.com/provider/chat`（跨源，必然失败）
    eq("proxy.url.provider-base-not-prefixed", chatProxyUrl("https://api.deepseek.com"), AI_CHAT_PROXY_CHAT_PATH);

    // ---- 15b `detectChatProxy()`：200 且形状对 → 配置；404 / 抛异常 / 非 JSON → null ----
    // 探测走 `fakeFetch`（**已经会按真浏览器规则校验 GET 不能带 body**，见文件上方 `assertFetchInit`）：
    // 显式传 origin 只是为了断言得到绝对 URL；`base` 不参与代理转发地址的拼装。
    const ORIGIN = "http://127.0.0.1:8787";
    const { fn: cfgGood, seen: seenCfg } = fakeFetch([{ body: JSON.stringify({
      ok: true, proxy: true, baseUrl: "http://127.0.0.1:8787", defaultModel: "deepseek-flash", models: ["deepseek-flash"], hasEnvKey: true,
    }) }]);
    const good = await detectChatProxy(cfgGood, ORIGIN);
    eq("proxy.detect.ok", good && good.hasEnvKey, true);
    eq("proxy.detect.method", [seenCfg[0].url, seenCfg[0].init.method], [ORIGIN + "/provider/config", "GET"]);
    // **F1 的回归断言**：探测是 GET，且**一个 body 字段都不带**
    eq("proxy.detect.get-no-body", seenCfg[0].body, undefined);
    eq("proxy.detect.get-no-body-key", Object.prototype.hasOwnProperty.call(seenCfg[0].init, "body"), false);
    // 同一条用**真浏览器规则**的假 fetch 复跑一遍：只要有人把 `body` 加回 GET，这一条就会红
    // （假 fetch 会抛 `Request with GET method cannot have body` → `detectChatProxy` 吞成 null）
    const { fn: cfgStrict, seen: seenStrict } = fakeFetch([{ body: JSON.stringify({
      ok: true, proxy: true, baseUrl: "http://127.0.0.1:8787", defaultModel: "deepseek-flash", models: [], hasEnvKey: true,
    }) }]);
    const strictProbe = await detectChatProxy(cfgStrict, "https://shell.test");
    eq("proxy.detect.strict-ok", strictProbe !== null && strictProbe.proxy, true);
    eq("proxy.detect.strict-url", seenStrict[0].url, "https://shell.test/provider/config");
    // 反面①：**假 fetch 的规则本身**必须硬（GET/HEAD 带 body 抛 TypeError，空串也算带）
    let getBodyThrew = "";
    try {
      assertFetchInit("GET", { body: "" });
    } catch (e) {
      getBodyThrew = String(e);
    }
    ok("proxy.detect.get-body-throws", getBodyThrew.indexOf("cannot have body") > 0, getBodyThrew);
    let headBodyThrew = "";
    try {
      assertFetchInit("head", { body: "{}" });
    } catch (e) {
      headBodyThrew = String(e);
    }
    ok("proxy.detect.head-body-throws", headBodyThrew.indexOf("cannot have body") > 0, headBodyThrew);
    // 反面②：把「GET 带 body」喂给**严格假 fetch**，探测必须回 null（真浏览器就是这个结局）
    const getWithBody: ChatFetch = (url, init) => {
      assertFetchInit(init.method, init);
      return Promise.resolve({ ok: true, status: 200, text: async () => "{}" });
    };
    eq("proxy.detect.strict-rejects-get-body",
      await detectChatProxy((url, init) => getWithBody(url, { ...init, body: "" }), ORIGIN), null);
    eq("proxy.detect.404", await detectChatProxy(fakeFetch([{ status: 404, body: "" }]).fn, ORIGIN), null);
    eq("proxy.detect.throw", await detectChatProxy(() => Promise.reject(new Error("no shell")), ORIGIN), null);
    eq("proxy.detect.html", await detectChatProxy(fakeFetch([{ body: "<html>nope</html>" }]).fn, ORIGIN), null);
    // 探测响应里**没有** key 的字符（壳那一侧的契约由 pc-shell 的源码扫描兜住）
    eq("proxy.detect.no-key-text", JSON.stringify(good).indexOf(CN) < 0, true);

    // ---- 15c `proxyChatFetch()`：URL **恒为同源相对路径** + 去掉 Authorization/哨兵头 + 带壳 token ----
    const seen: Seen[] = [];
    const inner: ChatFetch = async (url, init) => {
      seen.push({ url, init, headers: init.headers, body: JSON.parse(init.body) });
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "好" } }] }) };
    };
    // ⚠️ 这里**故意**把 provider 基地址当 base 传进去（P8 的 F2 复现条件：壳回的 `cfg.baseUrl`
    // 是 provider 地址）。修好后它不参与拼装，所以请求仍落在**同源** `/provider/chat`。
    const pf = proxyChatFetch("https://api.deepseek.com", "shell-token-1234", inner);
    await pf("https://api.deepseek.com/provider/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Provider-Key": "host" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    eq("proxy.fetch.url", seen[0].url, AI_CHAT_PROXY_CHAT_PATH);
    eq("proxy.fetch.no-provider-prefix", seen[0].url.indexOf("api.deepseek.com") < 0, true);
    eq("proxy.fetch.headers", [seen[0].headers.Authorization, seen[0].headers["X-Provider-Key"],
      seen[0].headers["X-Shell-Token"], seen[0].headers["Content-Type"]],
      [undefined, undefined, "shell-token-1234", "application/json"]);
    eq("proxy.fetch.no-key-text", JSON.stringify(seen[0]).indexOf(CN) < 0, true);
    // 回环 provider 基地址同样不许拼进去（P4 实测就是 `http://127.0.0.1:8910/provider/chat` 那条）
    const seenLoop: Seen[] = [];
    const pfLoop = proxyChatFetch("http://127.0.0.1:8910", "t2", async (url, init) => {
      seenLoop.push({ url, init, headers: init.headers, body: JSON.parse(init.body) });
      return { ok: true, status: 200, text: async () => "{}" };
    });
    await pfLoop("http://127.0.0.1:8910/provider/chat", { method: "POST", headers: {}, body: "{}" });
    eq("proxy.fetch.loopback-not-prefixed", seenLoop[0].url, AI_CHAT_PROXY_CHAT_PATH);

    // ---- 思考强度与超时（`ai.chatThinking` / `ai.chatTimeoutSec`）----
    // ① 打开思考：发 thinking + reasoning_effort，且**不发 temperature**（文档明说该模式下它不生效）
    const seenThink: Seen[] = [];
    const thinkWrap = (inner: ChatFetch): ChatFetch => async (url, init) => {
      seenThink.push({ url, init, headers: init.headers, body: JSON.parse(init.body) });
      return inner(url, init);
    };
    const okReply = { status: 200, body: JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi" } }] }) };
    const { fn: okFn1 } = fakeFetch([okReply]);
    await runChatTurn({
      ...turnOpts(live(), thinkWrap(okFn1)), endpoint: "http://127.0.0.1:8787", key: "sk-x",
      commit: false, temperature: 0.7, thinking: "high", timeoutMs: 90000,
    });
    const bOn = seenThink[0].body as Record<string, unknown>;
    eq("proxy.thinking.mode-and-effort", [bOn.thinking, bOn.reasoning_effort], [{ type: "enabled" }, "high"]);
    eq("proxy.thinking.drops-temperature", Object.prototype.hasOwnProperty.call(bOn, "temperature"), false);
    eq("proxy.timeout.header", seenThink[0].headers["X-Provider-Timeout"], "90000");
    // ② 关闭思考：只发 disabled，不发 reasoning_effort，temperature 照旧发
    seenThink.length = 0;
    const { fn: okFn2 } = fakeFetch([okReply]);
    await runChatTurn({
      ...turnOpts(live(), thinkWrap(okFn2)), endpoint: "http://127.0.0.1:8787", key: "sk-x",
      commit: false, temperature: 0.7, thinking: "off",
    });
    const bOff = seenThink[0].body as Record<string, unknown>;
    eq("proxy.thinking.off", [bOff.thinking, Object.prototype.hasOwnProperty.call(bOff, "reasoning_effort"), bOff.temperature],
      [{ type: "disabled" }, false, 0.7]);
    // ③ 默认档：**一个思考字段都不发**（换非 DeepSeek 端点最安全），也不带超时头（沿用壳默认）
    seenThink.length = 0;
    const { fn: okFn3 } = fakeFetch([okReply]);
    await runChatTurn({ ...turnOpts(live(), thinkWrap(okFn3)), endpoint: "http://127.0.0.1:8787", key: "sk-x", commit: false });
    const bDef = seenThink[0].body as Record<string, unknown>;
    eq("proxy.thinking.default-sends-nothing",
      [Object.prototype.hasOwnProperty.call(bDef, "thinking"), Object.prototype.hasOwnProperty.call(bDef, "reasoning_effort"),
        Object.prototype.hasOwnProperty.call(seenThink[0].headers, "X-Provider-Timeout")], [false, false, false]);
    // ④ **思考模式 + tools 的硬要求**：上一轮的 `reasoning_content` 必须原样回传（否则 API 400）
    const seenRc: Seen[] = [];
    const { fn: rcInner } = fakeFetch([
      { status: 200, body: JSON.stringify({ choices: [{ message: {
        role: "assistant", content: "", reasoning_content: "先看一下画布",
        tool_calls: [{ id: "c1", type: "function", function: { name: "doc_digest", arguments: "{}" } }],
      } }] }) },
      okReply,
    ]);
    const rcWrap: ChatFetch = async (url, init) => {
      seenRc.push({ url, init, headers: init.headers, body: JSON.parse(init.body) });
      return rcInner(url, init);
    };
    await runChatTurn({
      ...turnOpts(live(), rcWrap), endpoint: "http://127.0.0.1:8787", key: "sk-x",
      commit: false, thinking: "low", maxRounds: 3,
    });
    const rcMsgs = (seenRc[1]?.body as { messages?: { role?: string; reasoning_content?: string }[] } | undefined)?.messages ?? [];
    eq("proxy.thinking.reasoning-content-returned",
      rcMsgs.filter((m) => m.role === "assistant").map((m) => m.reasoning_content), ["先看一下画布"]);

    // ---- 15d 错误码 → 中文文案（§3.7.2 的九档映射）----
    const errFetch = (status: number, body: string): ChatFetch =>
      () => Promise.resolve({ ok: false, status, text: async () => body });
    const errText = async (status: number, body: string): Promise<string> => {
      const { fn } = fakeFetch([{ status, body }]);
      const r = await runChatTurn({
        ...turnOpts(live(), fn),
        endpoint: "http://127.0.0.1:8787", key: AI_CHAT_HOST_KEY_SENTINEL,
        fetchFn: proxyChatFetch("http://127.0.0.1:8787", "t", errFetch(status, body)), commit: false,
      });
      return String(r.error);
    };
    const e409 = await errText(409, JSON.stringify({ ok: false, error: "no-key", detail: "本机壳里没有 key" }));
    ok("proxy.err.409", e409.indexOf("没有可用的 API key") >= 0 && e409.indexOf("DEEPSEEK_API_KEY") >= 0, e409);
    const e401 = await errText(401, JSON.stringify({ ok: false, error: "unauthorized" }));
    ok("proxy.err.401", e401.indexOf("通道 token") >= 0, e401);
    const e403 = await errText(403, JSON.stringify({ ok: false, error: "proxy-off", detail: "--no-provider-proxy" }));
    ok("proxy.err.403", e403.indexOf("拒绝了这次转发") >= 0 && e403.indexOf("--no-provider-proxy") >= 0, e403);
    // 错误码只翻一次：那句人话里不许出现「翻第二遍」的痕迹（翻第二遍会让 detail 变成空串）
    eq("proxy.err.single-translate", e403.indexOf("拒绝了这次转发") === e403.lastIndexOf("拒绝了这次转发"), true);
    // **P15 第 2 项：provider 回显 key 时，页面这一侧也绝不许出现明文。**
    // 壳侧负责擦（有 `shell.scrubs-key-before-return` 与端到端实测），页面侧这里是「回显形状长这样时，
    // 页面把 body 拼进错误行的效果」—— 用的是**已经被壳擦过**的 body（与真壳逐字同形），
    // 并且额外钉一条「页面自己不许再把它还原/回显」：错误行里只该出现掩码与 provider 的原话。
    const echoedByShell = JSON.stringify({
      error: { message: "invalid api key: Bearer …7777", received: "…7777" },
      model: "deepseek-v4-pro", code: 401,
    });
    const eEcho = await errText(401, echoedByShell);
    ok("proxy.err.echo.provider-quote-kept", eEcho.indexOf("invalid api key") >= 0, eEcho);
    ok("proxy.err.echo.masked-shown", eEcho.indexOf("…7777") >= 0, eEcho);
    eq("proxy.err.echo.no-plain-key",
      ["sk-fake-env-7777", "SK-FAKE-ENV-7777", "Bearer sk-fake-env-7777"].some((k) => eEcho.indexOf(k) >= 0), false);
    // 面板源码里也不存在任何「把 key 拼进文本」的路径（这一条与 P15 的开关无关，是硬口径）
    eq("proxy.err.echo.panel-no-key-text",
      readFile("src/ui/AiPanel.tsx").indexOf("{cfg.key}") < 0, true);
    const e413 = await errText(413, JSON.stringify({ ok: false, error: "body-too-large" }));
    ok("proxy.err.413", e413.indexOf("请求太大") >= 0, e413);
    const e502 = await errText(502, JSON.stringify({ ok: false, error: "provider-unreachable", detail: "ENOTFOUND" }));
    ok("proxy.err.502", e502.indexOf("连不上端点") >= 0 && e502.indexOf("ENOTFOUND") >= 0, e502);
    const e504 = await errText(504, JSON.stringify({ ok: false, error: "provider-timeout", detail: "10000ms" }));
    ok("proxy.err.504", e504.indexOf("端点没在超时时间内回") >= 0 && e504.indexOf("10000ms") >= 0, e504);
    const e400 = await errText(400, JSON.stringify({ ok: false, error: "bad-request", detail: "stream:true" }));
    ok("proxy.err.400", e400.indexOf("HTTP 400") >= 0 && e400.indexOf("stream:true") >= 0, e400);
    // 壳的 413 / 504 都带 `ok:false`（P10 给这几档加的 `shell` 守卫不许把它们改坏）
    ok("proxy.err.413.shell-shape", e413.indexOf("请求太大") >= 0 && e413.indexOf("端点") < 0, e413);
    eq("proxy.err.504.shell-shape", e504.indexOf("端点没在超时时间内回：10000ms") >= 0, true);
    // **直连分支也必须翻**（用户实测症状）：壳的信封落到非哨兵路径时，早先把原始 JSON 直接甩给用户 ——
    // `端点返回 HTTP 504：{"ok":false,"error":"provider-timeout","detail":"10000ms"}`。
    // 判别只按**响应形状**（`ok === false`），与走哪条分支无关。
    const direct504 = await (async (): Promise<string> => {
      const { fn } = fakeFetch([{ status: 504, body: JSON.stringify({ ok: false, error: "provider-timeout", detail: "10000ms" }) }]);
      const r = await runChatTurn({
        ...turnOpts(live(), fn),
        endpoint: "http://127.0.0.1:8787", key: "sk-direct-not-sentinel", commit: false,
      });
      return String(r.error);
    })();
    ok("proxy.err.504.direct-shape-still-translated",
      direct504.indexOf("端点没在超时时间内回：10000ms") >= 0 && direct504.indexOf("端点返回 HTTP 504") < 0, direct504);
    eq("proxy.err.504.direct-shape.no-raw-envelope", direct504.indexOf('"ok":false') < 0, true);
    // 未知 code / 非 JSON body → 退回既有的四档文案（不吞错、不泄漏）
    const e429 = await errText(429, "slow down");
    ok("proxy.err.429-fallback", e429.indexOf("429") >= 0 && e429.indexOf("slow down") >= 0, e429);
    const eJunk = await errText(500, "<html>boom</html>");
    ok("proxy.err.junk-fallback", eJunk.indexOf("HTTP 500") >= 0 && eJunk.indexOf("boom") >= 0, eJunk);
    eq("proxy.err.no-key-leak", [e409, e401, e403, e413, e502, e504, e400, e429, eJunk]
      .every((x) => x.indexOf(CN) < 0), true);

    // ---- 15d2 provider 透传的 403 vs 壳自己的 403（P10 修掉的误报）----
    //
    // 判别依据是**壳响应的形状**（`pc-shell.mjs` 自己产生的错误体恒为 `{ok:false,…}`；provider 的
    // 错误体是 OpenAI 形状、没有 `ok`），不是「看起来像」。这一组断言就是钉住这条依据。
    const p403 = await errText(403, JSON.stringify({
      error: { message: "You do not have access to model deepseek-v4-pro", type: "insufficient_quota" },
    }));
    ok("proxy.err.403.provider.says-provider",
      p403.indexOf("模型服务商拒绝了这个请求") >= 0, p403);
    ok("proxy.err.403.provider.keeps-status", p403.indexOf("HTTP 403") >= 0, p403);
    ok("proxy.err.403.provider.keeps-quote",
      p403.indexOf("You do not have access to model deepseek-v4-pro") >= 0, p403);
    eq("proxy.err.403.provider.not-blamed-on-shell",
      p403.indexOf("本机壳拒绝了这次转发") < 0, true);
    eq("proxy.err.403.provider.no-forbidden-filler", p403.indexOf("（forbidden）") < 0, true);
    // OpenAI 兼容端点也常回**字符串** `error`：那同样是 provider 说的，不许算回壳头上
    const p403s = await errText(403, JSON.stringify({ error: "insufficient_quota" }));
    ok("proxy.err.403.provider-string-error",
      p403s.indexOf("模型服务商拒绝了这个请求") >= 0 && p403s.indexOf("insufficient_quota") >= 0
      && p403s.indexOf("本机壳拒绝") < 0, p403s);
    // provider 的 403 是 HTML / 空体：也要说清责任方，并给出状态码或可读摘要
    const p403h = await errText(403, "<html><body>403 Forbidden by upstream</body></html>");
    ok("proxy.err.403.provider-html",
      p403h.indexOf("模型服务商拒绝了这个请求") >= 0 && p403h.indexOf("Forbidden by upstream") >= 0, p403h);
    const p403e = await errText(403, "");
    ok("proxy.err.403.provider-empty",
      p403e.indexOf("模型服务商拒绝了这个请求") >= 0 && p403e.indexOf("HTTP 403") >= 0
      && p403e.indexOf("key 权限") >= 0, p403e);
    // 壳自己的 403 一个字节都不许变（现状是对的：`{ok:false,error:"proxy-off"}`）
    eq("proxy.err.403.shell-unchanged", e403, "本机壳拒绝了这次转发（--no-provider-proxy）");
    const shell403NoDetail = await errText(403, JSON.stringify({ ok: false, error: "proxy-off" }));
    eq("proxy.err.403.shell-no-detail", shell403NoDetail, "本机壳拒绝了这次转发（proxy-off）");
    // 判别本身也要可测：`ok:false` 才算壳（含「壳 403 带 `ok:false`」与「provider 403 无 `ok`」两极）
    const shellShape = await errText(403, JSON.stringify({ ok: false, error: "unauthorized" }));
    ok("proxy.err.403.discriminator-shell", shellShape.indexOf("本机壳拒绝了这次转发") >= 0, shellShape);
    // provider 的 403 里不许出现环境 key / 手填 key 的明文
    eq("proxy.err.403.provider.no-key-leak",
      [p403, p403s, p403h, p403e].every((x) => x.indexOf(CN) < 0), true);

    // ---- 15e 请求形状：哨兵路径**不带 Authorization**、发 X-Provider-Key；请求体照旧 ----
    const { fn: fnHost, seen: seenHost } = fakeFetch([reply([], "好")]);
    const rHost = await runChatTurn({
      ...turnOpts(live(), fnHost),
      endpoint: "https://api.deepseek.com", key: AI_CHAT_HOST_KEY_SENTINEL,
      temperature: 0.7, systemPrompt: "一律用暗色调",
    });
    eq("proxy.req.ok", rHost.ok, true);
    eq("proxy.req.no-auth", seenHost[0].headers.Authorization, undefined);
    eq("proxy.req.host-header", seenHost[0].headers["X-Provider-Key"], "host");
    eq("proxy.req.url", seenHost[0].url, "https://api.deepseek.com" + AI_CHAT_COMPLETIONS_PATH);
    eq("proxy.req.temperature", seenHost[0].body.temperature, 0.7);
    eq("proxy.req.system-prompt", String(seenHost[0].body.messages[0].content).indexOf("一律用暗色调") > 0, true);
    ok("proxy.req.system-prompt-keeps-builtin",
      String(seenHost[0].body.messages[0].content).indexOf(AI_CHAT_SYSTEM_PROMPT) === 0);
    // 哨兵路径下 `chatConfigError` 不应把「没有 key」当错误（key 由壳持有）
    eq("proxy.req.cfg-ok", chatConfigError({ endpoint: "https://api.deepseek.com", model: "m", key: AI_CHAT_HOST_KEY_SENTINEL }), null);
    // temperature = 0 时**不发这个字段**（0 = 用端点默认，不是「温度 0」）
    const { fn: fnZero, seen: seenZero } = fakeFetch([reply([], "好")]);
    await runChatTurn({ ...turnOpts(live(), fnZero), temperature: 0 });
    eq("proxy.req.temp-zero-omitted", "temperature" in seenZero[0].body, false);
    eq("proxy.req.temp-step", AI_CHAT_TEMP_STEP, 0.1);

    // ---- 15f 三态状态文本：只拼「有无」，key 的值一个字符都不进（`ai.protectKey` 关掉也一样）----
    const tzh = makeT("zh");
    const withKey = aiChatStatusText({ endpoint: "https://api.deepseek.com", model: "deepseek-v4-pro", key: "sk-status-secret" }, false, tzh);
    const withEnv = aiChatStatusText({ endpoint: "https://api.deepseek.com", model: "deepseek-v4-pro", key: "" }, true, tzh);
    const withNone = aiChatStatusText({ endpoint: "https://api.deepseek.com", model: "deepseek-v4-pro", key: "" }, false, tzh);
    ok("proxy.status.manual", withKey.indexOf(tzh("aiChatKeyManual")) > 0 && withKey.indexOf("deepseek-v4-pro") >= 0, withKey);
    ok("proxy.status.env", withEnv.indexOf(tzh("aiChatKeyEnv")) > 0, withEnv);
    ok("proxy.status.none", withNone.indexOf(tzh("aiChatKeyNone")) > 0, withNone);
    eq("proxy.status.no-key-leak", [withKey, withEnv, withNone].every((x) => x.indexOf("sk-status-secret") < 0), true);
    // `ai.protectKey` 关掉也**不能**把 key 放进文本：这一条与那个开关无关
    saveAiChatSettings({ protectKey: false });
    const relaxed = aiChatStatusText({ endpoint: "https://api.deepseek.com", model: "m", key: "sk-status-secret" }, false, tzh);
    eq("proxy.status.protect-off-still-safe", relaxed.indexOf("sk-status-secret") < 0, true);
    saveAiChatSettings({ protectKey: true });

    // ---- 15f2 `ai.protectKey` **真的有消费者**（P15 第 1 项：它以前是「可见可改但零效果」）----
    //
    // 三种 key 状态 × 开/关，两种取值必须产出**不同文本**；且四种输出里都不许有 key 材料。
    const protectCases = [
      { id: "manual", cfg: { endpoint: "https://api.deepseek.com", model: "deepseek-v4-pro", key: "sk-protect-secret" }, host: false },
      { id: "env", cfg: { endpoint: "https://api.deepseek.com", model: "deepseek-v4-pro", key: "" }, host: true },
      { id: "none", cfg: { endpoint: "https://api.deepseek.com", model: "deepseek-v4-pro", key: "" }, host: false },
    ].map((c) => ({
      ...c,
      on: aiChatStatusText(c.cfg, c.host, tzh, true),
      off: aiChatStatusText(c.cfg, c.host, tzh, false),
    }));
    eq("proxy.status.protect-key.changes-text",
      protectCases.map((c) => c.on !== c.off), [true, true, true]);
    // 关掉只是**不附那句说明**，不是换一套来源标记：状态行前半段必须逐字一致（前缀关系）
    eq("proxy.status.protect-key.prefix",
      protectCases.map((c) => c.on.indexOf(c.off) === 0), [true, true, true]);
    ok("proxy.status.protect-key.help-text",
      protectCases.every((c) => c.on.length > c.off.length && c.on.indexOf("（") > 0),
      JSON.stringify(protectCases.map((c) => [c.id, c.off, c.on])));
    // 开关两种取值下都不许出现 key 材料（含尾 4 位）
    eq("proxy.status.protect-key.no-key-text",
      protectCases.every((c) => c.on.indexOf("sk-protect-secret") < 0 && c.off.indexOf("sk-protect-secret") < 0
        && c.on.indexOf("-secret") < 0 && c.off.indexOf("-secret") < 0), true);
    // 默认（不传第 4 个参数）走**受保护**那一支：老调用点不会静默变成「不附说明」
    eq("proxy.status.protect-key.default-protected",
      aiChatStatusText(protectCases[0].cfg, false, tzh), protectCases[0].on);
    // 设置项的 get 真的读到存储里那个值（开关从设置页到函数之间这一段也要通）
    saveAiChatSettings({ protectKey: false });
    eq("proxy.status.protect-key.from-settings", aiChatSettings().protectKey, false);
    saveAiChatSettings({ protectKey: true });
    eq("proxy.status.protect-key.from-settings-on", aiChatSettings().protectKey, true);

    // ---- 15g 设置面板真的改得到、且即时生效 ----
    stubEnv();
    const s2 = live();
    s2.setSetting("ai.chatKey", "sk-preset-untouched");           // 先手填一把 key
    s2.setSetting("ai.chatPreset", "openai");
    eq("proxy.panel.preset-applied", [aiChatSettings().preset, aiChatSettings().endpoint, aiChatSettings().model],
      ["openai", "https://api.openai.com/v1", "gpt-4o-mini"]);
    eq("proxy.panel.key-kept", aiChatSettings().key, "sk-preset-untouched");
    s2.setSetting("ai.chatTemp", 7);
    s2.setSetting("ai.chatMaxRounds", 5);
    s2.setSetting("ai.chatSystemPrompt", "只用三色");
    eq("proxy.panel.immediate", [aiChatSettings().temp, aiChatSettings().maxRounds, aiChatSettings().systemPrompt],
      [7, 5, "只用三色"]);
    eq("proxy.panel.rounds-clamped", (s2.setSetting("ai.chatMaxRounds", 999), aiChatSettings().maxRounds), AI_CHAT_MAX_ROUNDS_MAX);
    eq("proxy.panel.temp-clamped", (s2.setSetting("ai.chatTemp", -4), aiChatSettings().temp), 0);
    saveAiChatSettings({ on: false, key: "", endpoint: "", model: "", preset: "deepseek", systemPrompt: "", temp: 0, maxRounds: 12 });

    // ---- 15h 通路判定顺序（谁在花钱）：手填 key → 直连；只有环境 key → 代理；都没有 → 不发请求 ----
    stubEnv();
    resetChatTransport();
    const w2 = (globalThis as unknown as { window: Record<string, unknown> }).window;
    const savedBridge2 = w2.PixelBridge;
    const cfgReply = JSON.stringify({ ok: true, proxy: true, baseUrl: "http://127.0.0.1:8787", defaultModel: "deepseek-v4-pro", models: [], hasEnvKey: true });
    // 探测走 `fakeFetch`（它会按真浏览器规则校验 GET 不带 body，见文件上方 `assertFetchInit`）
    const { fn: probeFn, seen: probeSeen } = fakeFetch([{ body: cfgReply }]);
    const tr = await detectChatProxy(probeFn, "http://127.0.0.1:8910");
    eq("proxy.order.detected", tr !== null && tr.hasEnvKey, true);
    eq("proxy.order.probe-shape", [probeSeen.length, probeSeen[0].headers.Accept,
      probeSeen[0].url], [1, "application/json", "http://127.0.0.1:8910/provider/config"]);
    eq("proxy.order.probe-no-body", probeSeen[0].body, undefined);
    eq("proxy.order.no-key-text", JSON.stringify(probeSeen[0]).indexOf(CN) < 0, true);
    w2.PixelBridge = savedBridge2;
    // 页面里既没有手填 key 也没有代理 → `chatConfigError` 报缺 key（面板据此不发请求）
    ok("proxy.order.no-key-blocked", String(chatConfigError({ endpoint: "https://api.deepseek.com", model: "m", key: "" })).indexOf("key") > 0);
    resetChatTransport();
    eq("proxy.order.cache-reset", chatTransport(), null);
    saveAiChatSettings({ on: false, key: "" });
  }

  // ================================================================ 15i 「全新配置」首次加载就落 DeepSeek 默认值（P8 的 F3）
  //
  // 缺陷现场：`pc.aichat` 这个键还不存在时，早先的 `loadAiChatSettings()` 走
  // `normalizeAiChatSettings(null)`，而 normalize 把空串当「用户主动清空」→ 端点 / 模型都是**空串**，
  // 设置页两行空白；默认值要等 `AiPanel` 探通代理后才补写，F1/F2 一坏就永远补不上（「开箱即用」变空话）。
  {
    stubEnv();
    // ① 真·全新：没有 `pc.aichat` 键
    const store = (globalThis as unknown as { localStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void } }).localStorage;
    eq("fresh.starts-empty", store.getItem(AI_CHAT_SETTINGS_KEY), null);
    const fresh = reloadAiChatSettings();
    eq("fresh.default-endpoint", fresh.endpoint, AI_CHAT_DEFAULT_ENDPOINT);
    eq("fresh.default-model", fresh.model, AI_CHAT_DEFAULT_MODEL);
    eq("fresh.default-preset", fresh.preset, "deepseek");
    eq("fresh.defaults-are-deepseek", [AI_CHAT_DEFAULT_ENDPOINT, AI_CHAT_DEFAULT_MODEL],
      ["https://api.deepseek.com", "deepseek-v4-pro"]);
    // ② **当场落盘**（不是只活在内存里）：读存储就有这两个值
    const persisted = JSON.parse(String(store.getItem(AI_CHAT_SETTINGS_KEY)));
    eq("fresh.persisted-endpoint", persisted.endpoint, "https://api.deepseek.com");
    eq("fresh.persisted-model", persisted.model, "deepseek-v4-pro");
    // ③ 设置在**设置页/会话**这一层就能看到（渲染设置页读的就是同一个 aiChatSettings()）
    const s3 = live();
    eq("fresh.setting-rows", [s3.settingValue("ai.chatEndpoint"), s3.settingValue("ai.chatModel")],
      ["https://api.deepseek.com", "deepseek-v4-pro"]);
    eq("fresh.setting-traceable", [SETTINGS_BY_PATH.get("ai.chatEndpoint")!.default, SETTINGS_BY_PATH.get("ai.chatModel")!.default],
      [AI_CHAT_DEFAULT_ENDPOINT, AI_CHAT_DEFAULT_MODEL]);
    // ④ 反面：**用户主动清空**（键存在、两个字段都是空串）不许被默认值覆盖（§3.7.7 第 5 条）
    store.setItem(AI_CHAT_SETTINGS_KEY, JSON.stringify({ on: true, endpoint: "", model: "", key: "" }));
    const cleared = reloadAiChatSettings();
    eq("fresh.user-cleared-kept", [cleared.endpoint, cleared.model], ["", ""]);
    eq("fresh.user-cleared-not-rewritten", JSON.parse(String(store.getItem(AI_CHAT_SETTINGS_KEY))).endpoint, "");
    // ⑤ 缺字段的老 JSON（只有 key）→ 该补的补、key 不动
    store.setItem(AI_CHAT_SETTINGS_KEY, JSON.stringify({ key: "sk-old-shape" }));
    const legacy = reloadAiChatSettings();
    eq("fresh.legacy-shape", [legacy.key, legacy.endpoint, legacy.model], ["sk-old-shape", "", ""]);
    // ⑥ 坏 JSON：不抛异常（回默认值；读不出来就当没配过，**不改写**用户那份坏数据）
    store.setItem(AI_CHAT_SETTINGS_KEY, "{这不是 JSON");
    const broken = reloadAiChatSettings();
    eq("fresh.bad-json.no-throw", [broken.endpoint, broken.model], [AI_CHAT_DEFAULT_ENDPOINT, AI_CHAT_DEFAULT_MODEL]);
    eq("fresh.bad-json.untouched", store.getItem(AI_CHAT_SETTINGS_KEY), "{这不是 JSON");
    saveAiChatSettings({ on: false, key: "" });
  }

  // ================================================================ 16. 壳侧代理的静态口径（P3/W1 + 流式）
  //
  // 壳是 `.mjs`（跑不了 tsc），所以这里查源码钉住几条**结构性**口径：
  //   · 环境变量名与优先级、`--provider-*` 参数都在；
  //   · 环境 key **只发往已知主机**、密钥不落日志、不跟随重定向；
  //   · **流式**：有真的流式分支（不再对 `stream:true` 回 400），且擦 key 是**按 SSE 事件边界**做的；
  //   · 页面侧不留任何「把 key 拼进文本」的路径。
  {
    const shell = readFile("toolchain/pc-shell.mjs");
    ok("shell.env-names", shell.indexOf('const PROVIDER_KEY_ENV = ["DEEPSEEK_API_KEY", "OPENAI_API_KEY", "PC_AI_KEY"]') >= 0);
    ok("shell.env-priority-order",
      shell.indexOf('["DEEPSEEK_API_KEY", "OPENAI_API_KEY", "PC_AI_KEY"]') < shell.indexOf("for (const name of PROVIDER_KEY_ENV)"));
    ok("shell.known-hosts", shell.indexOf('const ENV_KEY_HOSTS = new Set(["api.deepseek.com", "api.openai.com"])') >= 0);
    // 环境 key 只发往已知主机（显式 --provider-key 是用户自己敲的自测 / 自建网关通道，不受这道闸门限制），
    // 且**必须是 https**（P15 第 4 项：只查 hostname 时 `http://api.deepseek.com:8080` 会把 key 明文发出去）
    ok("shell.env-key-host-guard", shell.indexOf("opts.providerKeyEnvName") > 0
      && shell.indexOf("ENV_KEY_HOSTS.has(base.hostname)") >= 0
      && shell.indexOf("opts.providerProxy = false") > 0);
    ok("shell.env-key-https-guard", shell.indexOf('base.protocol === "https:"') > 0
      // 顺序断言只在**闸门那一段**里比（文件别处还有 `PC_SHELL_NO_PROVIDER_PROXY` 也会置 false）
      && shell.slice(shell.indexOf("if (opts.providerProxy && opts.providerKey && opts.providerKeyEnvName) {"))
        .indexOf('base.protocol === "https:"') < shell.slice(shell.indexOf("if (opts.providerProxy && opts.providerKey && opts.providerKeyEnvName) {"))
        .indexOf("opts.providerProxy = false;"));
    // 协议不匹配时 banner 要讲明原因（与主机不匹配同构）
    ok("shell.env-key-protocol-explained", shell.indexOf("协议不是 https，key 会明文出网") > 0);
    // 显式 --provider-key 继续豁免（分流逻辑不变）：闸门条件里必须带 `opts.providerKeyEnvName` 这个前提
    ok("shell.cli-key-exempt", shell.indexOf("if (opts.providerProxy && opts.providerKey && opts.providerKeyEnvName) {") > 0);
    ok("shell.routes", shell.indexOf('p === "/provider/config"') > 0 && shell.indexOf('p === "/provider/chat"') > 0
      && shell.indexOf("method-not-allowed") > 0);
    ok("shell.only-adds-auth", shell.indexOf('authorization: "Bearer " + opts.providerKey') > 0);
    ok("shell.key-tail-only", shell.indexOf("providerKeyTail()") > 0 && shell.indexOf("providerKey") > 0
      && shell.indexOf('"…" + opts.providerKey.slice(-4)') > 0);
    // **P15 第 2 项：写回之前必须把自己那把 key 擦掉**（provider 可能把 Authorization 回显在错误体里，
    // 页面又会把 4xx body 前 120 字拼进错误行 → 环境 key 就进页面了）。静态钉住「擦」这一步在链路上。
    ok("shell.scrubs-key-before-return", shell.indexOf("function scrubProviderKey(text)") > 0
      && shell.indexOf("const safe = scrubProviderKey(r.body);") > 0
      && shell.indexOf("Buffer.from(safe, \"utf8\")") > 0);
    ok("shell.scrub-covers-bearer-and-bare", shell.indexOf('"\\\\bbearer\\\\s+" + esc') > 0
      && shell.indexOf('.replace(new RegExp(esc, "gi"), mask)') > 0);
    // 不跟随重定向：上游响应**原样透传**（3xx 也不追 —— 这条路上没有 redirect / follow 逻辑）
    ok("shell.no-redirect-follow", shell.indexOf("redirect") < 0 && shell.indexOf("followRedirect") < 0
      && shell.indexOf("res.writeHead(r.status") > 0);
    ok("shell.key-never-in-config", shell.indexOf("providerConfigBody") > 0
      && shell.indexOf("hasEnvKey: !!opts.providerKey") > 0);
    ok("shell.token-auth", shell.indexOf('req.headers["x-shell-token"]') > 0 && shell.indexOf("providerAuthOk") > 0);
    // ---- 流式（`stream:true`）：壳侧必须真的转，且擦 key 按**事件边界**做 ----
    // ① 不再回 400（旧分支的文案一个字都不许回来）
    eq("shell.stream.no-400", shell.indexOf("本轮不支持 stream:true") < 0
      && shell.indexOf("body.stream === true") > 0, true);
    // ② 有真的流式转发函数，且它把上游响应标成 `text/event-stream` 边收边转
    ok("shell.stream.forward-exists", shell.indexOf("function forwardToProviderStream(payload, timeoutMs, req, res)") > 0
      && shell.indexOf("forwardToProviderStream(JSON.stringify(out), timeoutMs, req, res)") > 0
      && shell.indexOf('"content-type": "text/event-stream; charset=utf-8"') > 0
      && shell.indexOf('accept: "text/event-stream"') > 0);
    // ③ 擦 key 在**事件边界**上：`flushSseEvents()` 一定在切出完整事件之后才 `res.write`
    //    （分块各擦一遍会漏掉被 TCP 切两半的 key —— 这就是「未擦原文透给页面」那条红线）
    ok("shell.stream.scrub-per-event", shell.indexOf("function flushSseEvents(queue, res)") > 0
      && shell.indexOf("res.write(scrubProviderKey(rawEvent));") > 0
      && shell.indexOf("queue = flushSseEvents(queue, res);") > 0
      && shell.indexOf("rest = rest.subarray(cut + skip);") > 0);
    // ④ carry-over 缓冲：跨 TCP 块的半截事件留在 `queue` 里，收尾时也要**先擦再发**
    ok("shell.stream.carry-over", shell.indexOf("queue = Buffer.concat([queue, c]);") > 0
      && shell.indexOf('if (queue.length) res.write(scrubProviderKey(queue.toString("utf8")));') > 0);
    // ⑤ 上游不是 SSE 时按整包透传（同一口径：擦 key + 改 content-length），不是原样甩给页面
    ok("shell.stream.non-sse-passthrough", shell.indexOf("const isSse = ctype.indexOf(\"text/event-stream\") >= 0;") > 0
      && shell.indexOf("const safeStream = scrubProviderKey(rs.body);") > 0
      && shell.indexOf('"content-length": bufStream.length') > 0);
    // ⑥ 超时：流式那条腿同样按 `req.setTimeout(waitMs)`（首字节 + 整个流），不是只在流结束才算
    ok("shell.stream.timeout-covers-first-byte", shell.indexOf("upReq.on(\"timeout\"") > 0
      && shell.indexOf("timeout: waitMs") > 0
      && shell.indexOf("stats.providerTimeouts++") > 0);
    // 超时**分两条**：页面临时通道 `timeoutMs`（10s，与 APK 的 AI_CALL_TIMEOUT_MS 同口径）
    // 与上游转发 `providerTimeoutMs`（60s，模型请求十几秒很正常）。早先共用 10s，
    // 用户第一次真实调用必然撞 504 provider-timeout。这里的断言钉住"两条都在、且没有回退成共用"。
    ok("shell.timeout-and-size", shell.indexOf("MAX_PROVIDER_BYTES") > 0
      && shell.indexOf("timeout: waitMs") > 0
      && shell.indexOf("DEFAULT_PROVIDER_TIMEOUT_MS = 60000") > 0
      && shell.indexOf("--provider-timeout") > 0);
    eq("shell.timeout.two-legs-separate",
      [shell.indexOf("timeoutMs: DEFAULT_TIMEOUT_MS") > 0,
        shell.indexOf("timeout: opts.timeoutMs") < 0,
        shell.indexOf("const waitMs = Number.isFinite(timeoutMs)") > 0
          && shell.indexOf("detail: waitMs + \"ms\"") > 0],
      [true, true, true]);
    // 页面可以在 `X-Provider-Timeout` 里为**这一次请求**要一个上游超时（`ai.chatTimeoutSec`），
    // 壳夹到 1s..10min、非法就回退自己的 `--provider-timeout`
    ok("shell.provider-timeout.per-request",
      shell.indexOf("x-provider-timeout") > 0
      && shell.indexOf("requestProviderTimeoutMs(req)") > 0
      && shell.indexOf("Math.min(600000, n)") > 0);
    // 页面侧：不允许把 key 拼进任何文本（哨兵常量只在头里用）
    const panelSrc = readFile("src/ui/AiPanel.tsx");
    ok("shell.page-no-key-text", panelSrc.indexOf("{cfg.key}") < 0 && panelSrc.indexOf("{key}") < 0);
    ok("shell.page-sentinel-only", (readFile("src/app/ai-chat.ts").match(/AI_CHAT_HOST_KEY_SENTINEL/g) ?? []).length >= 2);
    // **P10 的静态钉子**：判别依据必须是「壳的响应形状」这一个函数，且壳侧那几档都过了它 ——
    // 谁要是把某一档的 `shell &&` 守卫删掉（或把判别换成「有 error 字符串就算壳」），这里就红。
    const chatSrcP10 = readFile("src/app/ai-chat.ts");
    ok("p10.shell-discriminator-exists",
      chatSrcP10.indexOf("function isShellError(j: HostErrorBody | null): boolean") > 0
      && chatSrcP10.indexOf("return !!j && j.ok === false;") > 0);
    ok("p10.shell-branches-guarded",
      (chatSrcP10.match(/if \(shell && status ===/g) ?? []).length >= 6);
    ok("p10.provider-403-says-provider",
      chatSrcP10.indexOf('return "模型服务商拒绝了这个请求（HTTP 403）："') > 0);
    // 判别**不许**用「有 error 字符串」这种看起来像的依据（OpenAI 兼容端点也回字符串 error）
    ok("p10.discriminator-not-string-error",
      chatSrcP10.indexOf('code !== ""') < 0 && chatSrcP10.indexOf("code.length > 0") < 0);
    // **F2 的静态钉子**：面板调 `proxyChatFetch()` 时**不许**把 `transport.base`（= 壳报的
    // provider 基地址）当第一个参数传进去 —— 那正是 P8 的阻塞缺陷（请求发到 provider 主机上）。
    // 源码层的这一条与运行时那几条（`proxy.fetch.url` / `proxy.url.base-ignored`）互为双保险。
    ok("f2.panel-base-not-transport", panelSrc.indexOf("proxyChatFetch(transport.base") < 0
      && panelSrc.indexOf("proxyChatFetch(tr.base") < 0
      && panelSrc.indexOf('proxyChatFetch(""') > 0);
    // 探测与转发各只有一处：探测不带 body（`method: "GET"` 紧跟 headers，没有 body 行）
    const chatSrc = readFile("src/app/ai-chat.ts");
    ok("f1.detect-get-has-no-body", chatSrc.indexOf('method: "GET",\n      headers: { Accept: "application/json" },\n    });') > 0);
    // 代理地址只可能是相对路径：源码里不许再出现「拼一个 base 前缀」的写法
    ok("f2.proxy-url-relative-only", chatSrc.indexOf("return AI_CHAT_PROXY_CHAT_PATH;") > 0
      && chatSrc.indexOf("+ AI_CHAT_PROXY_CHAT_PATH") < 0);
  }
}
