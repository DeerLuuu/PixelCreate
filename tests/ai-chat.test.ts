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
  AI_CHAT_COMPLETIONS_PATH, AI_CHAT_DEFAULT_MAX_ROUNDS, AI_CHAT_SYSTEM_PROMPT, appendToolResult,
  assistantMessage, buildSystemPrompt, changedCount, chatCompletionsUrl, chatConfigError, defaultTurnLabel,
  formatCallLog, parseToolCalls, responseText, runChatTurn, systemMessage, toOpenAiTools, toolResultContent,
  userMessage,
} from "../src/app/ai-chat";
import type { ChatFetch, ChatMessage, ChatTurnOpts } from "../src/app/ai-chat";
import { callTool, listTools, validateArgs } from "../src/app/ai-tools";
import type { AiToolCtx } from "../src/app/ai-tools";
import {
  AI_CHAT_SETTINGS_KEY, CHAT_SETTINGS, SETTINGS, SETTINGS_BY_PATH, SETTING_SECRET_PATHS,
  aiChatSettings, clearAiChatKey, exportSettings, importSettings, isSecretSettingPath,
  normalizeAiChatSettings, onAiChatSettingsChange, saveAiChatSettings, settingsOfGroup,
} from "../src/app/settings";
import { isNativeShell } from "../src/io/bridge";
import { makeT } from "../src/ui/i18n";
/** 副作用导入：把面板拉进编译图（它平时只被 ui/modals 引用），SSR 冒烟测试要用它 */
import * as aiPanelModule from "../src/ui/AiPanel";
import * as modalsModule from "../src/ui/modals";
import { stubEnv } from "./session.test";
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

interface Reply { status?: number; body?: string; thrown?: string }
interface Seen { url: string; headers: Record<string, string>; body: any }

function fakeFetch(replies: Reply[]): { fn: ChatFetch; seen: Seen[] } {
  const seen: Seen[] = [];
  let i = 0;
  const fn: ChatFetch = async (url, init) => {
    seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const r = replies[Math.min(i++, replies.length - 1)];
    if (r.thrown) throw new Error(r.thrown);
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => r.body ?? "" };
  };
  return { fn, seen };
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
    eq("aichat.setting.default-endpoint", SETTINGS_BY_PATH.get("ai.chatEndpoint")!.default, "");
    eq("aichat.setting.kind-bool", SETTINGS_BY_PATH.get("ai.chatOn")!.kind, "bool");
    eq("aichat.setting.key-password", SETTINGS_BY_PATH.get("ai.chatKey")!.text, "password");
    eq("aichat.setting.endpoint-text", SETTINGS_BY_PATH.get("ai.chatEndpoint")!.text, "plain");
    eq("aichat.setting.no-new-kind", SETTINGS_BY_PATH.get("ai.chatKey")!.kind, undefined);
    eq("aichat.setting.default-off", SETTINGS_BY_PATH.get("ai.chatOn")!.default, false);
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
    eq("aichat.setting.visible-on", settingsOfGroup(s, "chat").map((d) => d.path),
      ["ai.chatOn", "ai.chatEndpoint", "ai.chatModel", "ai.chatKey"]);
    s.setSetting("ai.chatEndpoint", "https://gateway.test/v1/");
    s.setSetting("ai.chatModel", "my-model");
    s.setSetting("ai.chatKey", "sk-local-only");
    eq("aichat.setting.values", [s.settingValue("ai.chatEndpoint"), s.settingValue("ai.chatModel"), s.settingValue("ai.chatKey")],
      ["https://gateway.test/v1/", "my-model", "sk-local-only"]);
    // 归一化 + 持久化 + 监听
    eq("aichat.setting.normalize-junk", normalizeAiChatSettings({ on: 1, endpoint: 5, model: null, key: "k" }),
      { on: false, endpoint: "", model: "", key: "k" });
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
    ok("aichat.menu.gated", modals.indexOf("bridge.isNativeShell()") >= 0 && modals.indexOf("menu-ai-chat") >= 0);
    ok("aichat.menu.icon", modals.indexOf("FEATURE_ICONS.menu.aiChat") >= 0);
    ok("aichat.panel.mounted", modals.indexOf("<AiPanel") >= 0);
    ok("aichat.panel.gate", panel.indexOf("if (!native)") >= 0 && panel.indexOf("ai-no-bridge") >= 0);
    ok("aichat.panel.preview-then-apply", panel.indexOf("previewAiTurn") >= 0 && panel.indexOf("commitAiTurn") >= 0 && panel.indexOf("rollbackAiTurn") >= 0);
    ok("aichat.panel.commit-false", panel.indexOf("commit: false") >= 0);
    ok("aichat.panel.unmount-rollback", panel.indexOf("if (SESSION.aiTurnOpen()) SESSION.rollbackAiTurn();") >= 0);
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
}
