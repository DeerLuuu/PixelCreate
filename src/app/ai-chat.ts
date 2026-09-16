// C5 应用内助手（docs/PLAN-ai.md §3.3「一轮 = 一条 undo」/ §3.5 A 路线 / §3.6 key 与安全模型）：
// 把「用户说一句话」变成「模型选工具 → 我们调工具 → 结果回灌 → 再问模型」这个循环的**纯逻辑层**。
//
// 为什么单独一层：
//   这一层与平台无关 —— 不 import `window`、不直接调 `fetch`（`fetchFn` 由调用方注入），
//   所以能在没有 DOM 的测试里用假端点把**整轮**跑完（两次 tool_calls 再回文本）。
//   UI 只负责显示与两个按钮（应用 / 放弃）。
//
// 三条不要改回去的口径：
//   1. **一轮 = 一条 undo**：整轮包在 ai-turn 的回合里（预览模式也一样），任何失败路径都
//      `rollbackTurn()` ——「模型中途报错、文档已经被改了一半」是不允许出现的。回合里
//      工具的写操作全部落在 `ctx.turn` 上（由这一层挂 `turnHandle()`），所以 callTool
//      每成功一次写操作都会 mark 一次，UI 的「改了多少」才有数。
//   2. **失败说人话**：缺 key / 端点为空的地址 / 网络挂了 / HTTP 4xx-5xx / 返回不是 JSON /
//      模型给的工具参数不是合法 JSON，都要转成一句能读的错误（带 HTTP 状态或响应前 120 字），
//      **不静默失败**、也不把异常原样抛给 UI。
//   3. **预览后应用**（§3.3 建议默认）：`commit: false` 时回合**留开着**交给 UI
//      （结果里的 `turnOpen: true`），用户点「应用」才 `commitTurn()`、点「放弃」才
//      `rollbackTurn()`；`commit: true`（默认）走 `runAiTurn()` 一步落定。
//
// 与 C1/C2 的接缝：工具表与回合事务**都只通过既有公开面**使用 —— `callTool`（自带
// 校验 + destructive 确认）与 `runAiTurn / beginAiTurn / commitTurn / rollbackTurn`。
// 这一层不新增写入路径，也不碰 History。

import type { Rect } from "../engine/types";
import { AI_ARG_CURRENT, callTool, listTools } from "./ai-tools";
import type { AiParamType, AiTier, AiTool, AiToolCtx, AiToolParam, AiToolResult } from "./ai-tools";
import { beginAiTurn, isTurnOpen, rollbackTurn, runAiTurn, turnHandle } from "./ai-turn";

/** 默认最多几轮「模型 → 工具 → 模型」（§3.5 C5 的口径：12；设置项 `ai.chatMaxRounds` 覆盖它） */
export const AI_CHAT_DEFAULT_MAX_ROUNDS = 12;
/** 硬上限：调用方给再大也不会超过它（每一轮都在花 token，失控的循环必须挡住） */
export const AI_CHAT_MAX_ROUNDS = 24;
/** `ai.chatTemp` 的档位步长：设置项存整数 0..20，发的 `temperature` = 值 × 0.1（0 = 不发这个字段） */
export const AI_CHAT_TEMP_STEP = 0.1;
/** 一整轮里最多真的执行多少次工具调用（模型一轮塞 100 个 tool_calls 时别把界面卡死） */
export const AI_CHAT_MAX_CALLS = 80;
/** 默认给模型的档位：`ui` 档默认不暴露（与 `listTools()` 同一条口径） */
export const AI_CHAT_TOOL_TIERS: readonly AiTier[] = ["read", "draw", "destructive"];
/** 单条工具结果回灌给模型的最大字符数（`read_region` 能吐一整块区域；超了截断并写明） */
export const AI_CHAT_MAX_RESULT_CHARS = 4000;
/** 端点是「基地址」时自动补的路径（OpenAI 兼容） */
export const AI_CHAT_COMPLETIONS_PATH = "/chat/completions";
/** 系统提示词里那份画布摘要的最大字符数 */
export const AI_CHAT_MAX_DIGEST_CHARS = 6000;
/** 用户补充提示词（`ai.chatSystemPrompt`）的最大字符数 */
export const AI_CHAT_MAX_TEXT_EXTRA = 2048;
/** 空标签时的兜底（历史面板里显示成 `ai: 对话`） */
export const AI_CHAT_LABEL_FALLBACK = "对话";

/**
 * **代理模式哨兵**（docs/PLAN-ai.md §3.7.3，W1）：key 由本机壳持有，页面不拿。
 *
 * 传它 = `requestModel()` **不发** `Authorization`，改发 `X-Provider-Key: host`
 * （一个没有机密的标记头），真 key 由壳在转发时补上。非哨兵路径（用户手填 key 的直连）
 * 一个字节都没变 —— 既有断言 `aichat.http.auth` 钉的正是那一条。
 *
 * 诚实边界（§3.7.4）：**只有环境变量来源的 key 才真的不进页面**。用户手填的那把
 * `ai.chatKey` 今天就在本机页面的 `localStorage` 里（同源脚本读得到），这是既有存储模型，
 * 本轮不改；所以 UI 文案不许说成「任何 key 都不在页面里」。
 */
export const AI_CHAT_HOST_KEY_SENTINEL = "__pc-host-key__";

/**
 * 同源代理的两个地址（壳侧实现见 `toolchain/pc-shell.mjs` 的 `/provider/*`）：
 *   · 探测点 `GET /provider/config`（**不需要 token**，只回 baseUrl / defaultModel / models / hasEnvKey，
 *     绝不含 key 的任何片段 —— 连尾 4 位都不给）；
 *   · 转发点 `POST /provider/chat`（要壳的**通道** token，与 provider 的 key 是两回事）。
 * 两者都是**同源相对路径**，所以在壳里怎么换端口都不用改这两行。
 */
export const AI_CHAT_PROXY_CONFIG_PATH = "/provider/config";
export const AI_CHAT_PROXY_CHAT_PATH = "/provider/chat";
/** 从用户消息里取标签时截断到多少字 */
export const AI_CHAT_LABEL_MAX = 40;

/**
 * 系统提示词。要点只有三条（其余靠工具自带的 schema 与 desc）：
 * 工具是唯一能改画面的通道、破坏性操作会弹确认、改完等用户点「应用」才落历史。
 */
export const AI_CHAT_SYSTEM_PROMPT = [
  "你是 PixelCraft 像素画编辑器里的绘制助手。用户会用一句话描述想要什么，你负责把它变成一串工具调用。",
  "规则：",
  "1. 只能通过工具改画面 —— 你没有别的方式修改文档；坐标一律是画布像素坐标，左上角是 (0,0)。",
  "2. 动手前先读：doc_digest 看工程概览，read_region 看具体区域的像素网格（画布小的时候很便宜）。",
  "3. 破坏性工具（删除图层 / 帧、清空画布、缩放画布、擦除、变换）会弹确认框，用户可能拒绝；被拒绝就不要重试同一个调用。",
  "4. 这一轮的全部改动会先给用户预览，用户点「应用」才写进历史（一条撤销）；所以尽量在一轮里把事情做完。",
  "5. 工具返回的 docRev 是文档版本号，变了说明画面真的改了；changed 是这次实际改动的像素矩形。",
  "6. 全部工具调用结束后，用一两句中文说清你做了什么（用户看的就是这句话）。",
].join("\n");

// ------------------------------------------------------------------ 消息形状

export type ChatRole = "system" | "user" | "assistant" | "tool";

/** 一次工具调用（OpenAI 兼容形状；`arguments` 恒为字符串） */
export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** 一条消息（OpenAI `/chat/completions` 的子集） */
export interface ChatMessage {
  role: ChatRole;
  content?: string;
  /** role === "assistant" 且模型要求调用工具时才有 */
  tool_calls?: ChatToolCall[];
  /** role === "tool" 时对应哪一次调用 */
  tool_call_id?: string;
  /** role === "tool" 时的工具名（部分宿主会忽略，带上便于排查） */
  name?: string;
}

/** `parseToolCalls()` 的产物：`error` 非空 = 这条调用的参数不能用来调工具 */
export interface ParsedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** 模型原始给的那段 arguments（合法 JSON 时保留原文，方便回灌） */
  raw: string;
  /** `arguments` 不是合法 JSON（或结构不对）时的原因；此时 `args` 是空对象 */
  error?: string;
}

/** 一次工具调用的摘要（UI 显示 / 回灌模型都用它） */
export interface ChatCallLog {
  id: string;
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  error?: string;
  /** 这次真的碰到了哪块像素（工具没给就是 null） */
  changed: Rect | null;
  /** 调用结束时的文档版本号 */
  docRev: number;
  /** 文档版本号推进了多少（0 = 一个像素都没改） */
  revDelta: number;
  /** 模型给的参数不能解析（这一条**没有**真的调工具） */
  parseError?: string;
}

/** `runChatTurn()` 的收尾原因（给 UI 显示「为什么停了」） */
export type ChatStopReason = "text" | "maxRounds" | "maxCalls";

export interface ChatTurnResult {
  ok: boolean;
  /** 模型最后那段文本（失败时是空串，看 `error`） */
  text: string;
  /** 可读错误（ok:false 时一定有） */
  error?: string;
  /** 完整消息流（含 tool 结果）——下次对话接着用 */
  messages: ChatMessage[];
  /** 这一轮每一次工具调用的摘要 */
  calls: ChatCallLog[];
  /** 实际发起了几次模型请求 */
  rounds: number;
  stop: ChatStopReason;
  /** 收尾时回合还开着（预览模式成功 → UI 显示「应用 / 放弃」） */
  turnOpen: boolean;
  /** 这一轮落了一条历史（`commitTurn()` 返回 true） */
  recorded: boolean;
  /** 收尾时的文档版本号 */
  docRev: number;
  /** 开始时的文档版本号 */
  docRevBefore: number;
}

/** 注入的 fetch（DOM 的 `fetch` 结构上就满足它；测试里给假的） */
export interface ChatFetchInit {
  method: string;
  headers: Record<string, string>;
  /**
   * 请求体。**GET / HEAD 一律不传这个字段**（省略而不是空串）：真浏览器对
   * `GET` + body 直接抛 `TypeError: Request with GET/HEAD method cannot have body`。
   * 假 fetch 也必须按这条校验（见 tests 的 `strictFetch`），否则这类缺陷会在全绿的单测里溜过去。
   */
  body?: string;
}
export interface ChatFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}
export type ChatFetch = (url: string, init: ChatFetchInit) => Promise<ChatFetchResponse>;

export interface ChatTurnOpts {
  /** 已经拼好的消息（第一条通常是 system 提示词） */
  messages: ChatMessage[];
  ctx: AiToolCtx;
  endpoint: string;
  model: string;
  key?: string;
  /** 由平台层注入（浏览器 / APK / 桌面壳各给一份） */
  fetchFn: ChatFetch;
  /** 省略 = `listTools({ tiers: AI_CHAT_TOOL_TIERS })` */
  tools?: readonly AiTool[];
  maxRounds?: number;
  /** `ai.chatTemp` × 0.1 = 发给端点的 `temperature`；0 / 省略 = **不发这个字段**（用端点默认） */
  temperature?: number;
  /** `ai.chatStream`：本轮**固定 false**（壳的代理对 `stream:true` 直接回 400）；省略 = 不发这个字段 */
  stream?: boolean;
  /** `ai.chatSystemPrompt`：非空则**追加**在内置提示词之后（不改内置那份） */
  systemPrompt?: string;
  /** 历史标签正文（`ai: ` 前缀由 ai-turn 加）；省略 = 取最后一条用户消息 */
  label?: string;
  /** true（默认）= 整轮直接落一条历史；false = 预览模式，回合留给 UI 收尾 */
  commit?: boolean;
  /** 每执行完一次调用回调一次（UI 实时显示摘要） */
  onCall?: (log: ChatCallLog, index: number) => void;
}

// ------------------------------------------------------------------ OpenAI 工具 schema

export interface OpenAiToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, Record<string, unknown>>;
      required: string[];
      additionalProperties: false;
    };
  };
}

const SCALAR_JSON: Record<string, string> = {
  int: "integer", num: "number", bool: "boolean", string: "string", color: "string", enum: "string",
};

/**
 * 把 C1 的工具表映射成 OpenAI 兼容的 tools 数组。口径：
 *   · `required` = **既没有 default 也不是 optional** 的参数（与 `validateArgs` 判定「缺少必填参数」
 *     的那一条完全一致 —— 两处口径必须一样，否则模型会漏参数然后拿到一条报错）；
 *   · `default` 照抄进 schema（`AI_ARG_CURRENT` 这种哨兵不是真值，不写进去，
 *     改为在 description 里说明「省略 = 当前图层/帧」）；
 *   · `int` 是 `integer`（`validateArgs` 对小数**拒绝**，不静默取整），`num` 才是 `number`；
 *   · `xy` 是 `[integer, integer]`、`rect` 是 `{x,y,w,h}` 四个整数（与 checkParam 的分支一一对应）；
 *   · `color` 额外把允许的字面量写进 description（`fg` / `bg` 不是颜色字面量，模型猜不到）。
 */
export function toOpenAiTools(tools: readonly AiTool[]): OpenAiToolSchema[] {
  return tools.map((tool) => {
    const properties: Record<string, Record<string, unknown>> = {};
    const required: string[] = [];
    for (const name of Object.keys(tool.params)) {
      const p = tool.params[name];
      properties[name] = paramSchema(p);
      if (p.optional !== true && p.default === undefined) required.push(name);
    }
    return {
      type: "function" as const,
      function: {
        name: tool.id,
        description: tool.title,
        parameters: { type: "object" as const, properties, required, additionalProperties: false as const },
      },
    };
  });
}

/**
 * 数组元素 / 嵌套值的 JSON schema：`items` 可以再是 `xy` / `rect` / `enum` 这类复合类型
 * （`validateArgs` 里 `array` 分支就是拿它当一层 `AiToolParam` 递归校验的）。
 */
function itemSchema(t: AiParamType): Record<string, unknown> {
  return t === "xy" || t === "rect" ? paramSchema({ type: t }) : { type: SCALAR_JSON[t] ?? "number" };
}

function paramSchema(p: AiToolParam): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (p.type === "xy") {
    out.type = "array";
    out.items = { type: "integer" };
    out.minItems = 2;
    out.maxItems = 2;
  } else if (p.type === "rect") {
    out.type = "object";
    out.properties = { x: { type: "integer" }, y: { type: "integer" }, w: { type: "integer" }, h: { type: "integer" } };
    out.required = ["x", "y", "w", "h"];
    out.additionalProperties = false;
  } else if (p.type === "array") {
    out.type = "array";
    // 元素类型复用同一套映射：`draw_path` 的 points 是 `items: "xy"`（每个点是 [x,y]），
    // 不是标量 —— 早先按标量表查会得到 `string`，模型就会发 ["1,1"] 这种参数被拒。
    out.items = itemSchema(p.items ?? "num");
    if (p.min !== undefined) out.minItems = p.min;
    if (p.max !== undefined) out.maxItems = p.max;
  } else {
    out.type = SCALAR_JSON[p.type] ?? "string";
    if (p.type === "enum") out.enum = (p.values ?? []).slice();
    if (p.type === "int" || p.type === "num") {
      if (p.min !== undefined) out.minimum = p.min;
      if (p.max !== undefined) out.maximum = p.max;
    }
    if (p.type === "string") {
      if (p.min !== undefined) out.minLength = p.min;
      if (p.max !== undefined) out.maxLength = p.max;
    }
  }
  const desc: string[] = [];
  if (p.desc) desc.push(p.desc);
  if (p.type === "color") desc.push("取值：#rgb / #rrggbb / #rrggbbaa，或 fg（前景色）/ bg（背景色）");
  if (p.default === AI_ARG_CURRENT) desc.push("省略 = 当前图层 / 当前帧");
  else if (p.default !== undefined && p.default !== null) desc.push("默认：" + JSON.stringify(p.default));
  else if (p.optional === true) desc.push("可省略（省略 = 不改这一项）");
  if (desc.length) out.description = desc.join("；");
  if (p.default !== undefined && p.default !== AI_ARG_CURRENT) out.default = p.default;
  return out;
}

// ------------------------------------------------------------------ 响应解析

/** 从响应里取第一个 choice 的 message（也接受 `{message}` / 直接给 message 的简化形状） */
function pickMessage(response: unknown): Record<string, unknown> | null {
  if (!response || typeof response !== "object") return null;
  const o = response as Record<string, unknown>;
  const choices = o.choices;
  if (Array.isArray(choices) && choices.length) {
    const c0 = choices[0] as Record<string, unknown> | null | undefined;
    const m = c0 && typeof c0 === "object" ? c0.message : null;
    if (m && typeof m === "object") return m as Record<string, unknown>;
    if (c0 && typeof c0 === "object" && ("content" in c0 || "tool_calls" in c0)) return c0;
  }
  const m = o.message;
  if (m && typeof m === "object") return m as Record<string, unknown>;
  if ("content" in o || "tool_calls" in o) return o;
  return null;
}

/** 模型这次回的文本（没有就是空串） */
export function responseText(response: unknown): string {
  const m = pickMessage(response);
  if (!m) return "";
  const c = m.content;
  if (typeof c === "string") return c;
  // 有的宿主按 parts 数组给内容：只取文本片段
  if (Array.isArray(c)) {
    return c.map((part) => {
      if (typeof part === "string") return part;
      const t = part && typeof part === "object" ? (part as { text?: unknown }).text : undefined;
      return typeof t === "string" ? t : "";
    }).join("");
  }
  return "";
}

/**
 * 解析模型返回的 tool_calls（**按数组顺序**，顺序就是调用顺序）。
 * 口径：`arguments` 不是合法 JSON → 这条带 `error` 返回（**不抛异常、也不瞎猜一个空参数去调**），
 * 调用方把它当成一条失败的工具结果回灌，模型下一轮能自己改；缺 id 时按位置补一个稳定 id。
 */
export function parseToolCalls(response: unknown): ParsedToolCall[] {
  const m = pickMessage(response);
  if (!m) return [];
  const raw = m.tool_calls;
  if (!Array.isArray(raw)) return [];
  const out: ParsedToolCall[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as Record<string, unknown> | null | undefined;
    if (!item || typeof item !== "object") continue;
    const fn = (item.function ?? item) as Record<string, unknown>;
    const name = typeof fn.name === "string" ? fn.name : "";
    const id = typeof item.id === "string" && item.id ? item.id : "call_" + i;
    const rawArgs = fn.arguments;
    let text = "";
    if (typeof rawArgs === "string") text = rawArgs;
    else if (rawArgs && typeof rawArgs === "object") text = JSON.stringify(rawArgs);
    const parsed = parseArgs(name, text);
    out.push({ id, name, raw: text, args: parsed.args, ...(parsed.error ? { error: parsed.error } : {}) });
  }
  return out;
}

function parseArgs(name: string, text: string): { args: Record<string, unknown>; error?: string } {
  if (!name) return { args: {}, error: "模型给的调用没有函数名" };
  const trimmed = text.trim();
  if (!trimmed) return { args: {} }; // 无参数工具：空串是合法的
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return { args: {}, error: name + " 的参数不是合法 JSON：" + clip(trimmed, 120) };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { args: {}, error: name + " 的参数必须是 JSON 对象，收到 " + describe(value) };
  }
  return { args: value as Record<string, unknown> };
}

/** 把模型那条 assistant 消息规范成 OpenAI 形状（回灌时请求体必须是这个形状） */
export function assistantMessage(response: unknown): ChatMessage {
  const calls = parseToolCalls(response);
  const msg: ChatMessage = { role: "assistant", content: responseText(response) };
  if (calls.length) {
    msg.tool_calls = calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.raw } }));
  }
  return msg;
}

// ------------------------------------------------------------------ 消息拼装

/** 工具结果的正文：`ok` / `docRev` / `error` 排在前面，`data` 垫底并截断（token 预算） */
export function toolResultContent(result: AiToolResult): string {
  const payload: Record<string, unknown> = { ok: result.ok !== false };
  if (result.error) payload.error = result.error;
  if (typeof result.docRev === "number") payload.docRev = result.docRev;
  if (result.changed) payload.changed = result.changed;
  if (result.warn && result.warn.length) payload.warn = result.warn;
  if (result.data !== undefined) payload.data = result.data;
  return clip(JSON.stringify(payload), AI_CHAT_MAX_RESULT_CHARS);
}

/**
 * 把一次调用的结果拼成 `role=tool` 消息（返回新数组）。
 * `tool_call_id` 必须与模型给的 id 对上，否则端点会直接报 400。
 */
export function appendToolResult(
  messages: readonly ChatMessage[],
  call: { id: string; name: string },
  result: AiToolResult,
): ChatMessage[] {
  return messages.concat([{
    role: "tool" as const,
    tool_call_id: call.id,
    name: call.name,
    content: toolResultContent(result),
  }]);
}

/** 系统提示词 + 可选的画布摘要（摘要超长就截断，别一开口就把预算吃光） */
export function buildSystemPrompt(opts: { digest?: string; extra?: string } = {}): string {
  const d = opts.digest ? clip(opts.digest, AI_CHAT_MAX_DIGEST_CHARS) : "";
  // 用户自己那句（设置项 `ai.chatSystemPrompt`）**追加**在内置提示词之后，且排在摘要之前 ——
  // 内置那份是硬口径（工具是唯一写入通道 / 预览后应用），不能被用户文本顶掉
  const x = opts.extra ? clip(String(opts.extra).trim(), AI_CHAT_MAX_TEXT_EXTRA) : "";
  return AI_CHAT_SYSTEM_PROMPT + (x ? "\n\n用户补充的要求：\n" + x : "") +
    (d ? "\n\n当前工程摘要（doc_digest 的结果）：\n" + d : "");
}

/** `{role:"system"}` 消息 */
export function systemMessage(opts: { digest?: string; extra?: string } = {}): ChatMessage {
  return { role: "system", content: buildSystemPrompt(opts) };
}

/** `{role:"user"}` 消息 */
export function userMessage(text: string): ChatMessage {
  return { role: "user", content: String(text ?? "") };
}

// ------------------------------------------------------------------ 端点

/** 端点是基地址时补 `/chat/completions`；已经写着这个路径就原样用（去掉尾部斜杠） */
export function chatCompletionsUrl(endpoint: string): string {
  const base = String(endpoint ?? "").trim().replace(/\/+$/, "");
  if (!base) return "";
  if (base.slice(-AI_CHAT_COMPLETIONS_PATH.length) === AI_CHAT_COMPLETIONS_PATH) return base;
  return base + AI_CHAT_COMPLETIONS_PATH;
}

/** 配置是否齐全；返回一句人话（null = 可以发请求）。**不碰文档、不发请求** */
export function chatConfigError(cfg: { endpoint: string; model: string; key: string }): string | null {
  if (!String(cfg.endpoint ?? "").trim()) return "没有填端点：设置 → AI 助手 → 端点";
  if (!/^https?:\/\//i.test(String(cfg.endpoint).trim())) return "端点要以 http:// 或 https:// 开头";
  if (!String(cfg.model ?? "").trim()) return "没有填模型名：设置 → AI 助手 → 模型";
  if (!String(cfg.key ?? "").trim()) return "没有填 API key：设置 → AI 助手（key 只存在本机）";
  return null;
}

// ------------------------------------------------------------------ 通路：直连 / 同源代理（§3.7.3）

/** 壳的 `/provider/config` 里页面**只**读这四个字段（§3.7.2；其余字段一概不看） */
export interface HostProviderConfig {
  proxy: boolean;
  baseUrl: string;
  defaultModel: string;
  models: string[];
  /** 壳进程里有没有可用的 provider key（**布尔**；响应体里没有 key 的任何片段） */
  hasEnvKey: boolean;
}

/**
 * 解析壳的探测响应。**宁可当「没有代理」也不要瞎猜**：缺 `baseUrl` 或 `defaultModel`
 * （老壳 / 半个响应）就回 null → 调用方回落直连，绝不会出现「模式切错了」。
 */
export function readHostProviderConfig(raw: unknown): HostProviderConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.proxy !== true) return null;
  const baseUrl = typeof o.baseUrl === "string" ? o.baseUrl.trim() : "";
  const defaultModel = typeof o.defaultModel === "string" ? o.defaultModel.trim() : "";
  if (!baseUrl || !defaultModel) return null;
  const models = Array.isArray(o.models) ? o.models.filter((m): m is string => typeof m === "string" && m.trim() !== "") : [];
  return { proxy: true, baseUrl, defaultModel, models, hasEnvKey: o.hasEnvKey === true };
}

/**
 * 同源代理的转发地址。**恒为同源相对路径**（`/provider/chat`），一个字都不拼调用方的 base ——
 * 这一点是 P8 修掉的真缺陷：早先写成 `<base>/provider/chat`，而 `base` 是**壳报回来的 provider
 * 基地址**（`https://api.deepseek.com`），于是请求被发到 `https://api.deepseek.com/provider/chat`
 * （生产）或 `http://127.0.0.1:8910/provider/chat`（本机假 provider），全是**跨源**、必然
 * `Failed to fetch`。契约（docs/PLAN-ai.md §3.7.1）要的一直是**同源**代理。
 *
 * 参数保留是为了**兼容既有调用点与断言**（`chatProxyFetch(base, token, inner)`），但它已经不参与
 * URL 拼装；`proxyChatFetch` 因此不再需要知道 provider 地址。
 */
export function chatProxyUrl(base?: string): string {
  void base; // 显式忽略：代理地址与 provider 地址无关（见上面的注释）
  return AI_CHAT_PROXY_CHAT_PATH;
}

/**
 * 探测一次同源代理。**任何失败都回 null**（壳不在 / 老壳没有这个端点 / 页面是 `file://`）——
 * 调用方据此回落直连，与今天的行为完全一致（不会出现「点了没反应」，§3.7.5）。
 *
 * 为什么 `GET /provider/config` 不要 token：它不泄漏任何机密（§3.7.2），拿它当
 * 「这个壳有没有代理」的探测点最省事；`POST /provider/chat` 那边照旧要壳的通道 token。
 *
 * ⚠️ **GET 不能带 body**（P8 修掉的阻塞缺陷）：早先这里写了 `body: ""`，真浏览器直接抛
 * `TypeError: Request with GET/HEAD method cannot have body`，而 `catch { return null }` 把它
 * 静静吞成「这台机器没有代理」—— 于是整条同源代理在真浏览器里从来没通过，而**单测的假 fetch
 * 不校验 method/body 组合，7527 条照样全绿**。所以：这里不发 body，测试那边配了一个「按真浏览器
 * 规则校验」的假 fetch（见 tests/ai-chat.test.ts 的 `strictFetch`）。
 */
export async function detectChatProxy(
  fetchFn: ChatFetch,
  base?: string,
): Promise<HostProviderConfig | null> {
  // 只探测**同源**配置：相对路径（`/provider/config`）在真浏览器里按页面自己的源解析，
  // `base` 只允许传「明确的源」用于测试 / 非浏览器环境（生产不传）。
  const origin = base !== undefined ? String(base) : browserOrigin();
  let res: ChatFetchResponse;
  try {
    res = await fetchFn(origin + AI_CHAT_PROXY_CONFIG_PATH, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null; // 404（老壳）/ 其它：一律当没有代理
  let text = "";
  try {
    text = await res.text();
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  return readHostProviderConfig(raw);
}

/** 页面自己的源（同源相对路径要用它；非浏览器环境回空串 = 相对路径，调用方自己兜底） */
function browserOrigin(): string {
  try {
    const loc = (globalThis as { location?: { origin?: string } }).location;
    return typeof loc?.origin === "string" && loc.origin !== "null" ? loc.origin : "";
  } catch {
    return "";
  }
}

/**
 * `proxyChatFetch()` 拿到的**原始**响应体（按响应对象记）。
 *
 * 为什么要有它：`ChatFetchResponse.text()` 在这个模块里会被读**两次** ——
 * 一次在包装层（包装层要把 body 换成可读文本），一次在 `requestModel()`（`hostError()` 要拿
 * **壳的原文**去分辨「壳发的」还是「provider 透传的」）。如果不留底，第二次读到的是**已经加工过的文本**，
 * 再解析一次就会 JSON 解析失败：壳的 `detail` 会变成空串（用户只看到「（forbidden）」这种空括号），
 * provider 的 403 也会被误判成「不是壳的形状」而拿到一句没有信息量的话。
 */
const hostErrorBodies = new WeakMap<object, string>();

/**
 * 把 `ChatFetch` 包一层，指向壳的**同源**代理：URL 恒为相对路径 `/provider/chat`
 * （见 `chatProxyUrl()` 的注释 —— 早先拿 provider base 拼前缀是 P8 修掉的真缺陷），
 * 头里带上壳的**通道** token（与 provider 的 key 是两回事，§3.7.4），并**去掉** `Authorization`
 * 与哨兵头 —— 真 key 由壳补，页面一个字节都不持有。
 *
 * 第一个参数（`base`）只为兼容既有调用点保留，**已经不参与 URL 拼装**（`noUnusedParameters` 关着，
 * 所以留着参数不会报未用）。
 *
 * 失败响应：`text()` 仍旧回**壳的原文**（错误码翻译只做一次，由 `requestModel()` 那边做，
 * 见 `hostErrorBodies` 的注释），所以 409/502/504 的 `detail` 会完整地出现在用户看到的文本里。
 */
export function proxyChatFetch(base: string, shellToken: string, inner: ChatFetch): ChatFetch {
  const url = chatProxyUrl(base);   // 恒为同源相对路径
  return async (requestUrl, init) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    for (const k of Object.keys(init.headers || {})) {
      const lk = k.toLowerCase();
      if (lk === "authorization" || lk === "x-provider-key") continue; // 真 key / 哨兵都不出页面
      headers[k] = init.headers[k];
    }
    headers["X-Shell-Token"] = String(shellToken ?? "");
    // 代理这条路只发 POST（模型请求）；这里照旧把 method 原样转下去，**GET/HEAD 一律不带 body**
    // （真浏览器对 GET/HEAD 带 body 是直接抛 TypeError，见 `detectChatProxy()` 的注释）
    const method = String(init.method || "POST").toUpperCase();
    const noBody = method === "GET" || method === "HEAD";
    let res: ChatFetchResponse;
    try {
      res = await inner(url, noBody ? { method, headers } : { method, headers, body: init.body });
    } catch (e) {
      throw new Error("连不上本机壳（" + message(e) + "）：窗口是不是已经关了？");
    }
    if (res.ok) return res;
    let text = "";
    try {
      text = await res.text();
    } catch {
      text = "";
    }
    const out: ChatFetchResponse = { ok: false, status: res.status, text: async () => text };
    hostErrorBodies.set(out, text);
    return out;
  };
}

/**
 * 面板顶部那行状态文本（§3.7.4 的三态）。**它只拼「有无」**：
 * 手填 / 环境提供 / 两个都没有，key 的值本身一个字符都不进这段文本 —— 这是硬口径，
 * 与 `ai.protectKey` 那个开关**无关**（那个开关只决定要不要附一句「与 key 有关的说明」，
 * 不允许把 key 放进任何文本）。
 *
 * `protectKey`（第 4 个参数，默认 `true`）= 设置项 `ai.protectKey`。P15 之前它是个
 * 「可见可改但零效果」的摆设，现在**真的接在这里**：开 = 附一句操作说明（去哪儿查 / 怎么换）；
 * 关 = 只留 key 来源本身。两种取值产出**不同文本**，所以这个开关是可测的
 * （`proxy.status.protect-key.changes-text` / `...keeps-no-key-text`）。
 */
export function aiChatStatusText(
  cfg: { endpoint: string; model: string; key: string },
  hostKey: boolean,
  t: (key: string) => string,
  protectKey = true,
): string {
  const model = String(cfg.model ?? "").trim();
  const endpoint = String(cfg.endpoint ?? "").trim();
  const head = model && endpoint ? model + " · " + endpoint : t("aiChatErrNotReady");
  const manual = !!String(cfg.key ?? "").trim();
  const base = manual ? head + " · " + t("aiChatKeyManual")
    : hostKey ? head + " · " + t("aiChatKeyEnv")
    : head + " · " + t("aiChatKeyNone");
  // 这四段里**没有任何 key 材料**（连尾 4 位都没有）：手填的路径用户自己知道，环境那把根本不在页面里
  if (!protectKey) return base;
  const help = manual ? AI_CHAT_KEY_HELP_MANUAL
    : hostKey ? AI_CHAT_KEY_HELP_ENV
    : AI_CHAT_KEY_HELP_NONE;
  return base + "（" + help + "）";
}

/** `ai.protectKey` 打开时附加的那句说明（**三态各一句；都不含 key 材料**）。
 *  它是常量而不是 i18n 键，是为了让这段唯一的拼接点与 `ai-chat` 的其他文案同源、
 *  并能在没有 i18n 的 Node 测试里直接断言「两种取值文本不同」。 */
export const AI_CHAT_KEY_HELP_MANUAL = "这把 key 只存在本机页面存储里，不进设置导出与日志";
export const AI_CHAT_KEY_HELP_ENV = "由桌面壳从环境变量提供并同源转发，页面拿不到它；换 key 要重启壳";
export const AI_CHAT_KEY_HELP_NONE = "手填一把，或给桌面壳设 DEEPSEEK_API_KEY 后重启壳";

function httpError(status: number, body: string): string {
  const head = clip(body.replace(/\s+/g, " ").trim(), 120);
  if (status === 401 || status === 403) return "端点拒绝了这个 key（HTTP " + status + "）：" + head;
  if (status === 404) return "端点地址不对（HTTP 404）：" + head;
  if (status === 429) return "端点限流了（HTTP 429），等一会儿再试：" + head;
  return "端点返回 HTTP " + status + "：" + head;
}

/** 壳的 `/provider/*` 给的那几个 body（形状见 §3.7.2；`detail` 里绝不会有 key） */
interface HostErrorBody {
  ok?: boolean;
  error?: string;
  detail?: string;
}

/**
 * **这一条错误到底是壳自己发的，还是上游 provider 的？**（P10 修掉的误报根源）
 *
 * 判别依据是**壳响应的形状**，不是「看起来像」：`pc-shell.mjs` 自己产生的每一个错误体都是
 * `{ ok: false, error: "<code>", detail?: "…" }`（见 §3.7.2 的九档表），而 provider 的错误体
 * 是 OpenAI 形状（`{"error":{"message":…}}`），**没有 `ok` 字段**。所以：
 *   · `ok === false` → 壳自己发的（`proxy-off` / `unauthorized` / `no-key` / …）；
 *   · 其它 → provider 的（原样透传过来的状态码与 body）。
 *
 * 为什么不能反着判（「有 `error` 字符串就是壳」）：OpenAI 兼容端点也常回
 * `{"error":"insufficient_quota"}` 这种**字符串** `error` —— 那会把 provider 的拒绝又算回壳头上，
 * 正是 P10 要修的那类错误。
 *
 * 壳的响应里**没有任何机密**（不含 key，连尾 4 位都没有），所以这个判别不需要新的来源标记；
 * `toolchain/pc-shell.mjs` 因此**不用改**（P10 明确要求：能靠形状判就不加标记）。
 */
function isShellError(j: HostErrorBody | null): boolean {
  return !!j && j.ok === false;
}

/**
 * **壳的错误码 → 一句人话**（docs/PLAN-ai.md §3.7.2 的九档映射表）。只在「代理模式」这条路上生效，
 * 直连路径的文案一个字节都没变（`httpError()` 照旧）。
 *
 * 为什么这一段必须由页面写：壳把 provider 的状态码**原样透传**，所以同一个状态码可能是两件完全不同的事
 * —— 「409 是壳自己没 key」vs「409 是 provider 说的」、「403 是壳关掉了代理」vs「403 是 provider 拒绝了这个 key」。
 * 前者只有页面能按 `isShellError()` 分辨后翻成人话。**判不出来的一律退回 `httpError()`（provider 档），
 * 并把 provider 的原话带上 —— 不吞错、也不替 provider 背锅。**
 */
function hostError(status: number, body: string): string {
  let j: HostErrorBody | null = null;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) j = parsed as HostErrorBody;
  } catch {
    j = null;
  }
  const code = j && typeof j.error === "string" ? j.error : "";
  const detail = clip(String(j && j.detail ? j.detail : "").replace(/\s+/g, " ").trim(), 120);
  const shell = isShellError(j);
  // ---- 壳自己产生的错误（唯一判据：body 里 `ok === false`）----
  if (shell && status === 409 && code === "no-key") {
    return "本机壳里没有可用的 API key：设 DEEPSEEK_API_KEY（或 OPENAI_API_KEY / PC_AI_KEY）后重启桌面壳，或在设置里手填";
  }
  if (shell && status === 401 && code === "unauthorized") return "本机壳的通道 token 不对（重启壳后刷新页面）";
  if (shell && status === 403) return "本机壳拒绝了这次转发（" + (detail || code || "forbidden") + "）";
  if (shell && status === 413) return "请求太大（上限 1 MiB）：对话太长，清一下会话";
  if (shell && status === 502) return "连不上端点（" + (detail || "provider-unreachable") + "）：检查这台设备的网络";
  if (shell && status === 504) return "端点没在超时时间内回：" + (detail || "provider-timeout");
  if (shell && status === 400 && code === "bad-request") return "端点返回 HTTP 400：" + (detail || "bad-request");
  // ---- 剩下的都是 provider 透传过来的（含 provider 的 403）----
  // 403 单独说清「是模型服务商拒绝的」：这正是最需要方向感的一档 ——
  // 壳拒绝要用户查本机配置 / 端口 / token，provider 拒绝要他去服务商那边查 key 权限 / 余额 / 模型授权。
  if (status === 403) {
    const said = clip(body.replace(/\s+/g, " ").trim(), 120);
    return "模型服务商拒绝了这个请求（HTTP 403）：" + (said || "响应体是空的，去服务商控制台核一下 key 权限 / 余额 / 模型授权");
  }
  return httpError(status, body);
}

/**
 * 发一次请求并解析 JSON；任何失败都抛一句人话（调用方包在回合里，异常即回滚）。
 *
 * **两条头路径**（§3.7.3 的「零改动面口子」）：
 *   · 非哨兵（默认，用户手填 key 的直连）：`Authorization: Bearer <key>` —— 逐字不变；
 *   · 哨兵（`AI_CHAT_HOST_KEY_SENTINEL`，走壳的同源代理）：不带 Authorization，改带
 *     `X-Provider-Key: host`。真 key 由壳在转发时补（页面从头到尾没有它）。
 */
async function requestModel(
  opts: {
    endpoint: string; model: string; key: string; messages: readonly ChatMessage[];
    tools: readonly AiTool[]; temperature?: number; stream?: boolean;
  },
  fetchFn: ChatFetch,
): Promise<unknown> {
  const body: Record<string, unknown> = { model: opts.model, messages: opts.messages };
  if (opts.tools.length) body.tools = toOpenAiTools(opts.tools);
  // temperature 只在用户真的填了非 0 档位时才发（0 = 用端点默认，不是「温度 0」）
  if (typeof opts.temperature === "number" && Number.isFinite(opts.temperature) && opts.temperature !== 0) {
    body.temperature = opts.temperature;
  }
  if (opts.stream === true) body.stream = true;
  const hostKey = opts.key === AI_CHAT_HOST_KEY_SENTINEL;
  const headers: Record<string, string> = hostKey
    ? { "Content-Type": "application/json", "X-Provider-Key": "host" }
    : { "Content-Type": "application/json", Authorization: "Bearer " + opts.key };
  let res: ChatFetchResponse;
  try {
    res = await fetchFn(chatCompletionsUrl(opts.endpoint), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error("连不上端点（" + message(e) + "）：检查端点地址和这台设备的网络");
  }
  let text = "";
  try {
    text = await res.text();
  } catch (e) {
    throw new Error("读端点响应失败：" + message(e));
  }
  if (!res.ok) {
    // 代理模式的失败体：优先用包装层留底的**壳原文**（见 `hostErrorBodies` 的注释）
    const raw = hostErrorBodies.get(res) ?? text;
    throw new Error(hostKey ? hostError(res.status, raw) : httpError(res.status, raw));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("端点返回的不是 JSON（HTTP " + res.status + "）：" + clip(text.replace(/\s+/g, " ").trim(), 120));
  }
  const err = parsed && typeof parsed === "object" ? (parsed as { error?: unknown }).error : null;
  if (err) {
    const m = err && typeof err === "object" ? (err as { message?: unknown }).message : err;
    throw new Error("端点报错：" + (typeof m === "string" && m ? m : JSON.stringify(err)));
  }
  return parsed;
}

// ------------------------------------------------------------------ 整轮

/** 从最后一条用户消息取历史标签（空 → `AI_CHAT_LABEL_FALLBACK`） */
export function defaultTurnLabel(messages: readonly ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    const text = String(messages[i].content ?? "").replace(/\s+/g, " ").trim();
    if (text) return text.length > AI_CHAT_LABEL_MAX ? text.slice(0, AI_CHAT_LABEL_MAX) : text;
  }
  return AI_CHAT_LABEL_FALLBACK;
}

function docRevOf(ctx: AiToolCtx): number {
  const d = (ctx.session as unknown as { doc?: { pixelRev?: number } } | null)?.doc;
  return typeof d?.pixelRev === "number" ? d.pixelRev : 0;
}

/** 历史里已有多少步（用来判断 `commitTurn()` 真的落了一条，而不是靠猜） */
function historyLen(ctx: AiToolCtx): number {
  const h = (ctx.session as unknown as { history?: { list?(): { labels: string[] } } } | null)?.history;
  try {
    const l = h?.list?.();
    return l && Array.isArray(l.labels) ? l.labels.length : 0;
  } catch {
    return 0;
  }
}

function clampRounds(n: number | undefined): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v) || v <= 0) return AI_CHAT_DEFAULT_MAX_ROUNDS;
  return Math.max(1, Math.min(AI_CHAT_MAX_ROUNDS, v));
}

/**
 * 把用户补的那句插进一条已经拼好的 system 消息里：先摘掉内置提示词前缀（面板拼消息时用的是
 * `systemMessage({ digest })`，前缀必然在），再把 extra 接在**内置提示词之后、摘要之前**。
 * 认不出前缀（调用方自己拼了别的 system 文本）时就在末尾追加 —— 内置口径永远排在最前面。
 */
function mergeSystemPrompt(existing: string, extra: string): string {
  const x = clip(String(extra).trim(), AI_CHAT_MAX_TEXT_EXTRA);
  if (!x) return existing;
  const tail = existing.startsWith(AI_CHAT_SYSTEM_PROMPT) ? existing.slice(AI_CHAT_SYSTEM_PROMPT.length) : "\n" + existing;
  return AI_CHAT_SYSTEM_PROMPT + "\n\n用户补充的要求：\n" + x + tail;
}

/**
 * 跑完一整轮：请求模型 → 有 `tool_calls` 就按顺序 `callTool` 并把结果回灌 → 再请求，
 * 直到模型只回文本（或到达 `maxRounds` / 调用次数上限）。
 *
 * 回合由这一层打开：`commit` 缺省走 `runAiTurn()`（一轮一条 undo），`commit:false` 走
 * 「开着回合交给 UI」的预览模式 —— 失败路径两种模式都一样 rollback。
 */
export async function runChatTurn(opts: ChatTurnOpts): Promise<ChatTurnResult> {
  const commit = opts.commit !== false;
  let messages = opts.messages.slice();
  // 用户在设置里补的那句（`ai.chatSystemPrompt`）：**原地换掉第一条 system 消息**（改写而不是追加
  // 一条），让「每次发请求时按当时的画布摘要重拼 system」这条既有口径继续成立 ——
  // 面板每次都重拼 messages，重拼时把 extra 一起传进来（见 `systemMessage({ digest, extra })`）。
  if (opts.systemPrompt && opts.systemPrompt.trim() && messages.length && messages[0].role === "system") {
    messages[0] = { role: "system", content: mergeSystemPrompt(String(messages[0].content ?? ""), opts.systemPrompt) };
  }
  const calls: ChatCallLog[] = [];
  const ctx: AiToolCtx = { ...opts.ctx, turn: opts.ctx.turn ?? turnHandle() };
  const tools = (opts.tools ?? listTools({ tiers: AI_CHAT_TOOL_TIERS.slice() })).slice();
  const maxRounds = clampRounds(opts.maxRounds);
  const label = (opts.label && opts.label.trim()) || defaultTurnLabel(messages);
  const docRevBefore = docRevOf(ctx);
  const histBefore = historyLen(ctx);

  const fail = (error: string, rounds: number, stop: ChatStopReason = "text"): ChatTurnResult => ({
    ok: false, error, text: "", messages, calls, rounds, stop,
    turnOpen: isTurnOpen(), recorded: false, docRev: docRevOf(ctx), docRevBefore,
  });

  const cfgErr = chatConfigError({ endpoint: opts.endpoint, model: opts.model, key: opts.key ?? "" });
  if (cfgErr) {
    // 配置不全时**连回合都不开**：文档一个字节不动，历史也不会多出空步骤
    return fail(cfgErr, 0);
  }

  let text = "";
  let rounds = 0;
  let stop: ChatStopReason = "text";

  const body = async (): Promise<void> => {
    for (let round = 0; round < maxRounds; round++) {
      rounds = round + 1;
      const response = await requestModel({
        endpoint: opts.endpoint, model: opts.model, key: opts.key ?? "", messages, tools,
        temperature: opts.temperature, stream: opts.stream,
      }, opts.fetchFn);
      messages.push(assistantMessage(response));
      const parsed = parseToolCalls(response);
      const said = responseText(response);
      if (said.trim()) text = said.trim();
      if (!parsed.length) { stop = "text"; return; }         // 模型不再要求调用：这一轮结束
      for (const call of parsed) {
        if (calls.length >= AI_CHAT_MAX_CALLS) { stop = "maxCalls"; return; }
        const before = docRevOf(ctx);
        let result: AiToolResult;
        if (call.error) {
          // 参数都不能解析：**不要**拿一个空参数去调工具（那会真的改到画布）
          result = { ok: false, error: call.error };
        } else {
          result = await callTool(call.name, call.args, ctx);
        }
        const log: ChatCallLog = {
          id: call.id, name: call.name, args: call.args,
          ok: result.ok !== false,
          changed: result.changed ?? null,
          docRev: docRevOf(ctx),
          revDelta: 0,
          ...(result.error ? { error: result.error } : {}),
          ...(call.error ? { parseError: call.error } : {}),
        };
        log.revDelta = log.docRev - before;
        calls.push(log);
        opts.onCall?.(log, calls.length - 1);
        messages = appendToolResult(messages, call, result);
      }
    }
    stop = "maxRounds";
  };

  if (commit) {
    const r = await runAiTurn(label, body);
    if (!r.ok) return fail(message(r.error), rounds);
    return {
      ok: true, text: fallbackText(text, calls, stop, maxRounds), messages, calls, rounds, stop,
      // 落没落历史由 History 自己说了算（只读回合 / 无改动时 runAiTurn 也是 ok:true）
      turnOpen: false, recorded: historyLen(ctx) > histBefore, docRev: docRevOf(ctx), docRevBefore,
    };
  }
  // 预览模式：回合开着交给 UI（点「应用」才 commitTurn、「放弃」才 rollbackTurn）
  const turnId = beginAiTurn(label);
  if (turnId <= 0) return fail("AI 回合没能打开（没有绑定会话）", 0);
  try {
    await body();
  } catch (e) {
    rollbackTurn(); // 失败一律回到回合开始：文档不变、历史不变
    return fail(message(e), rounds);
  }
  return {
    ok: true, text: fallbackText(text, calls, stop, maxRounds), messages, calls, rounds, stop,
    turnOpen: isTurnOpen(), recorded: false, docRev: docRevOf(ctx), docRevBefore,
  };
}

/** 模型只调工具不说话时，也要给用户一句「它干了什么」 */
function fallbackText(text: string, calls: readonly ChatCallLog[], stop: ChatStopReason, maxRounds: number): string {
  if (text) return text;
  if (stop === "maxRounds") return "达到最大轮数（" + maxRounds + "），已经停下。这一轮改了 " + changedCount(calls) + " 处画面。";
  if (stop === "maxCalls") return "工具调用次数到达上限，已经停下。这一轮改了 " + changedCount(calls) + " 处画面。";
  if (calls.length) return "模型只调用了工具，没有给出说明（共 " + calls.length + " 次调用）。";
  return "模型没有返回任何内容。";
}

/** 有过实际像素改动的调用次数（UI 与兜底文案共用） */
export function changedCount(calls: readonly ChatCallLog[]): number {
  return calls.filter((c) => c.revDelta > 0 || c.changed).length;
}

/** 一次工具调用的一句话摘要（纯文本，和 ai-tools 的 `summarizeToolCall` 同一风格） */
export function formatCallLog(log: ChatCallLog): string {
  const bits: string[] = [log.name];
  bits.push(log.ok ? "成功" : "失败");
  if (log.parseError) bits.push("模型给的参数不是合法 JSON");
  if (log.error && !log.parseError) bits.push(log.error);
  if (log.changed) bits.push("改动 " + log.changed.w + "×" + log.changed.h + " 像素");
  if (log.revDelta > 0) bits.push("docRev " + (log.docRev - log.revDelta) + "→" + log.docRev);
  return bits.join(" · ");
}

// ------------------------------------------------------------------ 小工具

/** 可读的异常信息（非 Error 也能读） */
export function message(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "string" && e) return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function clip(s: string, max: number): string {
  const text = String(s ?? "");
  return text.length > max ? text.slice(0, max) + "…（已截断）" : text;
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "数组";
  return typeof v;
}
