// C3 协议路由（PLAN-ai §5.1 的「与传输无关」那层）：
// 把「外部能对这张画布做什么」写成一组**纯函数** —— 无 DOM、无网络、无定时器。
// 输入是一个已经解析好的请求形状（method / path / token / 原始 body 文本），
// 输出是 `{ status, body }`，body 恒为**单行 JSON**。
//
// 真正的传输有两条，各自只做搬家：
//   · APK 里：Java 的 `AiServer` 监听 127.0.0.1:8787，把请求包成
//     `{method,path,body}` 调 `window.__pc_ai_call(envelopeJson, requestId)`（见 src/app/ai-serve.ts）；
//   · 开发机上：`node toolchain/ai-server.mjs` 用 Node 的 http 模块。
// 两条路都调**同一份** `handleAiRequest` / `handleAiRequestAsync`，所以协议只有一处实现
// —— 这是「不允许各写一遍」的机械保证：状态码 / 鉴权 / tier 判定都在 route() 里。
//
// ---------------------------------------------------------------- 不要改回去
// 1. **`envelope.body` 永远是字符串**，要 `JSON.parse` 才能拿到 `{call,args}`；
//    **例外是 `GET /ai/health`：它的 body 是空串**（Java 也走同一个转发入口），
//    所以路径分流必须在解析之前 —— 对空串 `JSON.parse` 会炸成 400，真机上表现为「健康检查永远失败」。
// 2. **tier 只决定「要不要确认」和「listTools 默认给不给」，不决定能不能调。**
//    放行开关在这一层（`aiTierAllows`）：`ai.tier = read` 时 draw / destructive / ui 档的工具
//    一律回 `{ok:false,error}`（HTTP 仍是 200，见第 4 条）。`ui` 档（`set_tool`）默认不列，
//    只有服务档位是 `all` 且调用方**显式**要了 `ui` 才列。
// 3. **`ctx.confirm` 默认必须拒绝**：C3 没有确认 UI（那是 C5），所以省略 `ctx.confirm` 时用
//    `AI_CONFIRM_DENY`（恒 false），destructive 工具回 `{"ok":false,"error":"cancelled"}` 且文档一个字节不动。
//    **禁止**为了「让工具能用」把默认值改成 true —— 一次 `canvas_clear` 就能毁掉用户的作品。
// 4. 状态码：200（含工具自身失败，body 是 `{"ok":false,…}`）/ 400（call 不存在、参数形状不对、
//    非法 JSON）/ 401（token 不匹配）/ 404（未知路径）/ 405（路径对、方法不对）/
//    413（body 超过 `AI_RPC_MAX_BODY`）/ 503（Session 没就绪，或路由内部抛异常）。
// 5. **不要依赖工具的 `changed` 字段**：C1 的 43 个写类工具里只有 `iso_generate` / `scale`
//    给了矩形，`color_replace` 那类「改了 N 个像素」是 `data.changed`（数字，不是矩形）。
//    判定「改动生效了吗」一律用 **`docRev`**（`result.docRev` 前后比对）；需要脏矩形就用
//    `turn_preview`。拿到 `changed === undefined` **不是错误**，别拿它判成败。
// 6. **回合（turn）必须有人收尾**：C2 的「回合期间不动历史」是靠临时影子掉 `History` 的三个压栈入口
//    实现的（见 ai-turn.ts 的 suspendHistory），影子残留在身后 = 用户此后的正常绘制静默不进历史
//    （丢撤销），下一次 `turn_begin` 还会把用户这段时间的工作静默回滚。所以这一层有三道闸门：
//      a. 路由抛异常 → `rollbackIfTurnOpen()`（见 `handleAiRequest*`）；
//      b. **嵌套回合先收尾**：`turn_begin` 时已经有一个回合开着 → 先 rollback 上一个，结果里带
//         `warn: "previous turn rolled back"`（不报错、不叠加 —— 外部 agent 断线重连是正常结局）；
//      c. **空闲收尾**：默认 300s 没有任何请求（外部 agent 断线/不再说话）就自动 rollback，
//         `status` 里能看到这条口径与已收尾次数；`setAiTurnIdleSeconds()` 可配（0 = 关掉）。
//    **不要用 `runAiTurn(label, fn)` 包这三个协议动词**：它在 `fn` 成功后会自动 commit，
//    拿它实现 `turn_begin` 会在「只有 begin」的请求里就把回合提交掉，语义直接崩。
//    `runAiTurn` 留给「一次调用 = 一整轮」的复合流程（将来 C5 的「画个史莱姆」那种），
//    以及路由里那种必须成回合才算完的内部复合操作；动词路径就保持上面的守卫 + try/finally。
// 7. 同步入口对 `call_tool` 回一个哨兵体 `AI_RPC_ASYNC_BODY`：C1 的 handler 允许返回 Promise，
//    `callTool` 本身也是 async，同步路径**没法**等它；ai-serve 认出这个哨兵后改成「返回空串 +
//    `PixelBridge.aiRespond` 回调」（Java 把同步返回的 Promise 判成 `js-async-unsupported`）。
//    其余 call 全是纯同步的，两个入口结果**逐字节一致**。

import { docDigest, readRegion } from "./ai-doc";
import { AI_TIER_ORDER, callTool, getTool, listTools } from "./ai-tools";
import type { AiTier, AiTool, AiToolCtx, AiToolResult } from "./ai-tools";
import type { Session } from "./session";

/** 服务的档位（设置项 `ai.tier`）：read 只读 / draw 允许写 / all 连 destructive 与 ui 也放行 */
export type AiServiceTier = "read" | "draw" | "all";

/** 规范顺序（设置项与文档里的顺序） */
export const AI_SERVICE_TIERS: readonly AiServiceTier[] = ["read", "draw", "all"];

/** 设置项的默认档位：只读（新建的端口服务默认什么都改不了） */
export const AI_RPC_DEFAULT_TIER: AiServiceTier = "read";

/** 设置项的默认端口（只绑 127.0.0.1） */
export const AI_RPC_DEFAULT_PORT = 8787;

/** body 上限（字节数近似：JS 字符串长度）。超过回 413 —— Java 侧也有同样的闸门。 */
export const AI_RPC_MAX_BODY = 262144;

/**
 * 同步入口的哨兵体：只有 `call_tool` 会返回它（handler 可能是异步的，同步路径等不了）。
 * ai-serve 见到它就返回空串并改走 `handleAiRequestAsync` + `PixelBridge.aiRespond`。
 * 形状与普通失败体一致，所以万一它被直接回给客户端，也只是一个明确的错误。
 */
export const AI_RPC_ASYNC_BODY = '{"ok":false,"error":"needs-async"}';

/** destructive 档的确认请求（形状同 C1 的 `AiToolCtx.confirm` 入参） */
export interface AiConfirmRequest {
  tool: string;
  tier: AiTier;
  summary: string;
}

/** 确认回调：返回 false = 用户点了取消 */
export type AiConfirm = (req: AiConfirmRequest) => Promise<boolean>;

/** 默认确认器：**一律拒绝**（第 3 条铁律；C5 才会有真弹框） */
export const AI_CONFIRM_DENY: AiConfirm = async () => false;

// ------------------------------------------------------------------ 回合收尾（防影子残留）
//
// 见文件头第 6 条：回合的影子残留在身后是**静默丢撤销**。这里只做记账与判定，不用任何定时器
// （这个文件必须能在 Node 里裸跑、也必须保持纯函数），真正的定时器在宿主里：
//   · 每个请求入口都会调一次 `expireIdleTurn(session)`（外部 agent 断线后只要还有任何请求，
//     下一次进来就收尾）；
//   · ai-serve（APK）另有一个 `setTimeout` 兜「再也不来请求」的情况。

/** 空闲收尾的默认秒数（可从宿主覆盖；0 = 关掉空闲收尾） */
export const AI_TURN_IDLE_SEC_DEFAULT = 300;

/** `turn_begin` 时若已有回合开着，回给调用方的警告正文（协议固定文案） */
export const AI_TURN_NESTED_WARN = "previous turn rolled back";

let turnIdleMs = AI_TURN_IDLE_SEC_DEFAULT * 1000;
let turnClock: { openedAt: number; lastAt: number; turnId: number } | null = null;
let turnIdleRollbacks = 0;

/** 当前空闲收尾秒数（0 = 关掉） */
export function aiTurnIdleSeconds(): number {
  return turnIdleMs / 1000;
}

/**
 * 空闲收尾口径的**短文本**：`"300s"` / `"0.05s"`；显式关掉时是 `"∞s（已关闭）"`。
 * `status.turnIdleSec` 之外的每一处诊断（`status.turnPolicy`、ai-serve 的 `turnGuard` 与诊断行）
 * 都必须用这一处，**不许各写各的** —— R1 的教训就是一边报 300s、一边报「∞s」，
 * 结果「接线到底装没装定时器」从诊断上根本看不出来。
 */
export function aiTurnIdleText(): string {
  return turnIdleMs > 0 ? turnIdleMs / 1000 + "s" : "∞s（已关闭）";
}

/** 配置空闲收尾秒数；非法值 / ≤0 等于关掉。返回生效后的秒数 */
export function setAiTurnIdleSeconds(sec: number): number {
  const n = Number(sec);
  turnIdleMs = Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : 0;
  return turnIdleMs / 1000;
}

/** 回合时钟快照（`status` 与宿主定时器用；`open=false` 时其余字段为 0/null） */
export function aiTurnClock(): {
  open: boolean;
  openedAt: number;
  lastAt: number;
  turnId: number;
  idleSec: number;
  idleLeftSec: number;
  idleRollbacks: number;
} {
  const now = Date.now();
  return {
    open: !!turnClock,
    openedAt: turnClock ? turnClock.openedAt : 0,
    lastAt: turnClock ? turnClock.lastAt : 0,
    turnId: turnClock ? turnClock.turnId : 0,
    idleSec: turnIdleMs / 1000,
    idleLeftSec: turnClock && turnIdleMs > 0 ? Math.max(0, Math.ceil((turnClock.lastAt + turnIdleMs - now) / 1000)) : 0,
    idleRollbacks: turnIdleRollbacks,
  };
}

/** 记下回合开了（`turn_begin` 成功之后调） */
function rememberTurn(turnId: number): void {
  const now = Date.now();
  turnClock = { openedAt: now, lastAt: now, turnId };
}

/** 回合结束了（commit / rollback / 外部门面自己收了）→ 清掉时钟 */
function forgetTurn(): void {
  turnClock = null;
}

/**
 * 空闲收尾的判定本体。
 * `refresh = true`：这一条**通过鉴权的**请求也算「还活着」（刷新 `lastAt`）；
 * `refresh = false`：只做超时判定、**不刷新** —— 供**鉴权之前**的调用用，否则本机任何进程
 * 拿一串无 token 的垃圾请求就能把这条兜底防线无限期续命（R3）。
 */
function idleTick(s: Session, now: number, refresh: boolean): boolean {
  if (!s || !s.aiTurnOpen()) {
    forgetTurn();
    return false;
  }
  if (!turnClock) turnClock = { openedAt: now, lastAt: now, turnId: 0 };
  if (!turnIdleMs || now - turnClock.lastAt <= turnIdleMs) {
    if (refresh) turnClock.lastAt = now;
    return false;
  }
  try {
    s.rollbackAiTurn();
  } catch {
    /* 空闲收尾不该把请求打挂：回滚失败就当作没收尾，下一次再试 */
    return false;
  }
  turnIdleRollbacks++;
  forgetTurn();
  return true;
}

/**
 * 空闲收尾（宿主定时器调它，路由在**鉴权通过之后**也调一次）：回合开着、且距上一次
 * **通过鉴权的**请求超过 `idleSec` 就 rollback 掉。
 * @returns true = 这一下真的收尾了一个回合
 */
export function expireIdleTurn(s: Session, now = Date.now()): boolean {
  return idleTick(s, now, true);
}

/** 一条请求（Java 的 envelope 或 Node 的 http 都归约成这个形状） */
export interface AiRpcRequest {
  method: string;
  path: string;
  /** `Authorization: Bearer <token>` 里的 token。**空串 = 这一层不校验**（APK 路径由 Java 先验过） */
  token?: string;
  /** 原始 body 文本；`GET /ai/health` 是**空串**（不要 JSON.parse） */
  body?: string;
}

export interface AiRpcResponse {
  status: number;
  /** 恒为单行 JSON（`{"ok":true,"result":…}` 或 `{"ok":false,"error":"…"}`） */
  body: string;
}

export interface AiRpcCtx {
  /** null = 服务没就绪（Session 还没构造好）→ 一律 503 */
  session: Session | null;
  /** 非空 = 逐字节比对请求头里的 token；空串 = 不校验（Java 侧已经验过） */
  token: string;
  tier: AiServiceTier;
  /** `GET /ai/health` 里报给客户端的应用版本号（宿主传入，这个模块不 import UI） */
  version: string;
  /** destructive 的确认器；**省略 = 一律拒绝**（见 AI_CONFIRM_DENY） */
  confirm?: AiConfirm;
  /** 追加进 `status` 的宿主信息（端口 / 是否 running / 桥接状态…） */
  hostStatus?: () => Record<string, unknown>;
}

// ------------------------------------------------------------------ JSON 小工具

/** 序列化成一行（`JSON.stringify` 会把换行转义成 `\n`，所以结果必然是单行） */
export function aiRpcJson(value: unknown): string {
  try {
    return JSON.stringify(value === undefined ? null : value);
  } catch {
    return '"<unserializable>"';
  }
}

/** 成功体：`{"ok":true,"result":…}` */
export function aiRpcOkBody(result: unknown): string {
  return '{"ok":true,"result":' + aiRpcJson(result) + "}";
}

/** 失败体：`{"ok":false,"error":"…"}` */
export function aiRpcErrorBody(error: string): string {
  return '{"ok":false,"error":' + aiRpcJson(String(error)) + "}";
}

// ------------------------------------------------------------------ tier 放行

/** 服务档位 → 放行的工具档位（`all` 连 `ui` 也放行，但列不列由 listTools 决定） */
export function allowedToolTiers(tier: AiServiceTier): AiTier[] {
  if (tier === "all") return ["read", "draw", "destructive", "ui"];
  if (tier === "draw") return ["read", "draw"];
  return ["read"];
}

/** 这个工具在当前服务档位下能不能调 */
export function aiTierAllows(tier: AiServiceTier, toolTier: AiTier): boolean {
  return allowedToolTiers(tier).indexOf(toolTier) >= 0;
}

/** 拒绝原因（带「怎么办」：改设置 ai.tier 或先 list_tools） */
export function aiTierRefusal(tier: AiServiceTier, toolTier: AiTier, id: string): string {
  return "tier \"" + tier + "\" 不放行 " + toolTier + " 档工具 " + id +
    "（当前允许：" + allowedToolTiers(tier).join("/") + "；改设置 ai.tier 或先 list_tools 看可用清单）";
}

// ------------------------------------------------------------------ 路由

/** 一个能拿出来给模型看的工具描述（**不含 handler**：函数没法序列化） */
export interface AiToolInfo {
  id: string;
  title: string;
  tier: AiTier;
  params: Record<string, unknown>;
  returns: Record<string, string>;
}

export function aiToolInfo(t: AiTool): AiToolInfo {
  const params: Record<string, unknown> = {};
  for (const k of Object.keys(t.params)) {
    const p = t.params[k];
    const o: Record<string, unknown> = { type: p.type };
    if (p.values) o.values = p.values.slice();
    if (p.min !== undefined) o.min = p.min;
    if (p.max !== undefined) o.max = p.max;
    if (p.default !== undefined) o.default = p.default;
    if (p.optional === true) o.optional = true;
    if (p.desc) o.desc = p.desc;
    params[k] = o;
  }
  return { id: t.id, title: t.title, tier: t.tier, params, returns: { ...t.returns } };
}

/** 一次路由的结果：要么立刻能回答，要么必须异步执行（只有 call_tool） */
type RouteOut =
  | { kind: "reply"; status: number; body: string }
  | { kind: "tool"; id: string; args: unknown };

function replyOk(status: number, result: unknown): RouteOut {
  return { kind: "reply", status, body: aiRpcOkBody(result) };
}

function replyErr(status: number, error: string): RouteOut {
  return { kind: "reply", status, body: aiRpcErrorBody(error) };
}

function intOf(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) ? v : null;
}

function asObject(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

/** 路径归一化：去掉 query，去掉尾部 `/`（`/ai/` 与 `/ai` 同义；`/` 保持 `/`） */
function normalizePath(raw: unknown): string {
  let p = typeof raw === "string" ? raw : "/";
  const q = p.indexOf("?");
  if (q >= 0) p = p.slice(0, q);
  while (p.length > 1 && p.charAt(p.length - 1) === "/") p = p.slice(0, -1);
  return p;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 唯一的一份路由：鉴权 → 路径 → 方法 → 解析 body → 分发。
 * **没有副作用**（`call_tool` 只把 id/args 交给调用方去 await），所以同步与异步两个入口
 * 可以各跑一遍而不会重复执行工具。
 */
function route(req: AiRpcRequest, ctx: AiRpcCtx): RouteOut {
  const s = ctx.session;
  if (!s) return replyErr(503, "ai service not ready（Session 还没就绪）");

  // 回合收尾闸门（c）· 只判定不刷新：**鉴权之前**就跑一次，过期就收掉。
  // 这里刻意用 refresh=false —— 否则一串无 token 的垃圾请求会把 lastAt 一路刷新，
  // 外部 agent 早就断线了、这条兜底防线却永不触发（R3）。
  idleTick(s, Date.now(), false);

  // 鉴权：ctx.token 为空 = 这一层不校验（APK 路径由 Java 用过同一个 token 验过）
  if (ctx.token) {
    const got = typeof req.token === "string" ? req.token : "";
    if (got !== ctx.token) return replyErr(401, "unauthorized（Authorization: Bearer <token> 不匹配）");
  }

  // 过了鉴权才算「这一轮还活着」：刷新活动时间（下一次超时从这一刻算）
  expireIdleTurn(s);

  const method = String(req.method ?? "GET").toUpperCase();
  const path = normalizePath(req.path);

  if (path === "/ai/health") {
    if (method !== "GET") return replyErr(405, "method not allowed（/ai/health 只接受 GET）");
    // ⚠ health 的 body 是空串：这里**不能**去 JSON.parse
    return replyOk(200, { version: ctx.version, docRev: s.doc.pixelRev, tier: ctx.tier });
  }

  if (path !== "/ai") return replyErr(404, "not found: " + path);
  if (method !== "POST") return replyErr(405, "method not allowed（/ai 只接受 POST）");

  const raw = typeof req.body === "string" ? req.body : "";
  if (raw.length > AI_RPC_MAX_BODY) return replyErr(413, "body too large（上限 " + AI_RPC_MAX_BODY + " 字符）");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return replyErr(400, "bad json: " + message(e));
  }
  const root = asObject(parsed);
  if (!root) return replyErr(400, "body 必须是一个 JSON 对象：{\"call\":\"…\",\"args\":{…}}");
  const call = root.call;
  if (typeof call !== "string" || !call) return replyErr(400, "缺少 call（字符串）");
  const args = root.args === undefined || root.args === null ? {} : asObject(root.args);
  if (!args) return replyErr(400, "args 必须是对象");

  switch (call) {
    case "list_tools":
      return listToolsPayload(ctx, args);
    case "digest":
      return digestPayload(s, args);
    case "read_region":
      return readRegionPayload(s, args);
    case "call_tool":
      return callToolRoute(ctx, args);
    case "turn_begin":
      return turnBegin(s, args);
    case "turn_preview": {
      const p = s.previewAiTurn();
      return replyOk(200, { count: p.count, rect: p.rect });
    }
    case "turn_commit": {
      const committed = s.commitAiTurn();
      if (!s.aiTurnOpen()) forgetTurn();
      return replyOk(200, { committed });
    }
    case "turn_rollback": {
      const wasOpen = s.aiTurnOpen();
      s.rollbackAiTurn();
      forgetTurn();
      return replyOk(200, { rolledBack: wasOpen });
    }
    case "status":
      return replyOk(200, statusPayload(ctx));
    default:
      return replyErr(400, "unknown call: " + call);
  }
}

// ------------------------------------------------------------------ 各 call

function listToolsPayload(ctx: AiRpcCtx, args: Record<string, unknown>): RouteOut {
  const base = allowedToolTiers(ctx.tier);
  const asked = args.tiers;
  let effective: AiTier[] = base.filter((t) => t !== "ui"); // ui 默认不列（§3.6）
  if (asked !== undefined) {
    if (!Array.isArray(asked)) return replyErr(400, "args.tiers 必须是数组，例如 [\"read\",\"draw\"]");
    const want: AiTier[] = [];
    for (let i = 0; i < asked.length; i++) {
      const t = String(asked[i]) as AiTier;
      if (AI_TIER_ORDER.indexOf(t) < 0) return replyErr(400, "args.tiers[" + i + "] = " + aiRpcJson(asked[i]) + " 不是档位（read/draw/destructive/ui）");
      if (base.indexOf(t) < 0) return replyErr(400, "args.tiers 里的 " + t + " 不在当前服务档位放行的集合（" + base.join("/") + "）");
      if (want.indexOf(t) < 0) want.push(t);
    }
    effective = want;
  }
  const tools = listTools({ tiers: effective });
  return replyOk(200, {
    tier: ctx.tier,
    allowed: base,
    count: tools.length,
    tools: tools.map(aiToolInfo),
  });
}

function digestPayload(s: Session, args: Record<string, unknown>): RouteOut {
  let fi: number | undefined;
  if (args.fi !== undefined) {
    const n = intOf(args.fi);
    if (n === null || n < 0) return replyErr(400, "args.fi 必须是非负整数");
    fi = n;
  }
  // docDigest 的文档段受 AI_MAX_REGION_PIXELS 闸门保护，不会产出兆级字符串
  return replyOk(200, docDigest(s.doc, fi === undefined ? {} : { fi }));
}

function readRegionPayload(s: Session, args: Record<string, unknown>): RouteOut {
  const box: Record<string, number> = {};
  for (const k of ["x", "y", "w", "h"]) {
    const n = intOf(args[k]);
    if (n === null) return replyErr(400, "args." + k + " 必须是整数（收到 " + aiRpcJson(args[k]) + "）");
    box[k] = n;
  }
  if (box.w < 0 || box.h < 0) return replyErr(400, "args.w / args.h 不能为负");
  const opts: { fi?: number; li?: number; rle?: boolean } = {};
  for (const k of ["fi", "li"] as const) {
    if (args[k] === undefined) continue;
    const n = intOf(args[k]);
    if (n === null || n < 0) return replyErr(400, "args." + k + " 必须是非负整数");
    opts[k] = n;
  }
  if (args.rle !== undefined) {
    if (typeof args.rle !== "boolean") return replyErr(400, "args.rle 必须是 true/false");
    opts.rle = args.rle;
  }
  return replyOk(200, readRegion(s.doc, { x: box.x, y: box.y, w: box.w, h: box.h }, opts));
}

function callToolRoute(ctx: AiRpcCtx, args: Record<string, unknown>): RouteOut {
  const id = args.id;
  if (typeof id !== "string" || !id) return replyErr(400, "args.id 必须是工具 id 字符串（先 list_tools）");
  const tool = getTool(id);
  if (!tool) return replyErr(200, "unknown tool: " + id); // 工具自身失败 → HTTP 仍是 200
  if (!aiTierAllows(ctx.tier, tool.tier)) return replyErr(200, aiTierRefusal(ctx.tier, tool.tier, id));
  return { kind: "tool", id, args: args.args };
}

function turnBegin(s: Session, args: Record<string, unknown>): RouteOut {
  if (typeof args.label !== "string") return replyErr(400, "args.label 必须是字符串（这一轮的意图，进历史标签）");
  // 收尾闸门（b）：**嵌套回合先收尾**，不报错也不叠加。外部 agent 断线后重连时必然会撞上这一条，
  // 报错只会让它更不知道该怎么办；而直接 begin 会把上一轮的改动静默吞掉（C2 的 beginTurn 内部
  // 就是这么做的），连个说法都没有。所以这里显式 rollback 并在结果里给一条 warn。
  const nested = s.aiTurnOpen();
  if (nested) {
    s.rollbackAiTurn();
    forgetTurn();
  }
  const turnId = s.beginAiTurn(args.label);
  if (!turnId) {
    forgetTurn();
    return replyErr(200, "回合没打开：Session 还没绑定回合宿主");
  }
  rememberTurn(turnId);
  const result: Record<string, unknown> = { turnId, label: args.label };
  if (nested) result.warn = AI_TURN_NESTED_WARN;
  return replyOk(200, result);
}

function statusPayload(ctx: AiRpcCtx): Record<string, unknown> {
  const s = ctx.session as Session;
  const counts: Record<string, number> = {};
  for (const t of listTools({ tiers: ["read", "draw", "destructive", "ui"] })) counts[t.tier] = (counts[t.tier] ?? 0) + 1;
  const clock = aiTurnClock();
  const out: Record<string, unknown> = {
    version: ctx.version,
    docRev: s.doc.pixelRev,
    tier: ctx.tier,
    allowed: allowedToolTiers(ctx.tier),
    tools: counts,
    turnOpen: s.aiTurnOpen(),
    // 回合收尾口径（文件头第 6 条）：空闲多久自动 rollback、还剩多少、已经收尾过几次
    turnIdleSec: clock.idleSec,
    turnIdleLeftSec: clock.idleLeftSec,
    turnOpenedAgoSec: clock.open ? Math.round((Date.now() - clock.openedAt) / 1000) : 0,
    turnIdleRollbacks: clock.idleRollbacks,
    // 收尾口径（文件头第 6 条）：三处诊断必须同源 —— 数字与文本都来自同一个 turnIdleMs
    turnIdleText: aiTurnIdleText(),
    turnPolicy: clock.idleSec > 0
      ? "嵌套 turn_begin 先 rollback 上一个（结果带 warn）；回合空闲 " + aiTurnIdleText() +
        " 无请求自动 rollback（设置 ai.turnIdleSec / setAiTurnIdleSeconds 可配）；服务停止 / pagehide / 路由抛异常也会 rollback"
      : "嵌套 turn_begin 先 rollback 上一个（结果带 warn）；**空闲收尾已关闭**（turnIdleSec = 0）；服务停止 / pagehide / 路由抛异常仍会 rollback",
    // destructve 需要宿主确认：这一层没有确认 UI（C5 才有），所以默认拒绝对话里的每一个 destructive 工具
    confirm: ctx.confirm ? "injected（宿主接入了确认器）" : "denied-by-default（destructive 需宿主确认，本版本未接线，一律回 cancelled）",
  };
  if (ctx.hostStatus) {
    const extra = ctx.hostStatus();
    if (extra && typeof extra === "object") for (const k of Object.keys(extra)) out[k] = extra[k];
  }
  return out;
}

// ------------------------------------------------------------------ 两个入口

/** 路由失败（抛异常）时把回合回滚掉：影子残留在身后 = 用户丢撤销（见文件头第 6 条 a） */
function rollbackIfTurnOpen(ctx: AiRpcCtx): void {
  try {
    if (ctx.session && ctx.session.aiTurnOpen()) ctx.session.rollbackAiTurn();
  } catch {
    /* 回滚自己失败也只能作罢：这里已经在错误路径上了 */
  }
  forgetTurn();
}

function toolCtx(ctx: AiRpcCtx): AiToolCtx {
  const s = ctx.session as Session;
  return {
    session: s,
    confirm: ctx.confirm ?? AI_CONFIRM_DENY,
    turn: s.aiTurnHandle(),
  };
}

/**
 * 同步快路径：所有纯同步的 call（health / list_tools / digest / read_region / turn_* / status）
 * 与全部错误路径都在这里回答；`call_tool` 返回 `AI_RPC_ASYNC_BODY` 哨兵，
 * 由调用方（ai-serve / Node 宿主）改走 `handleAiRequestAsync`。
 */
export function handleAiRequest(req: AiRpcRequest, ctx: AiRpcCtx): AiRpcResponse {
  try {
    const out = route(req, ctx);
    if (out.kind === "reply") return { status: out.status, body: out.body };
    return { status: 200, body: AI_RPC_ASYNC_BODY };
  } catch (e) {
    rollbackIfTurnOpen(ctx);
    return { status: 503, body: aiRpcErrorBody("internal: " + message(e)) };
  }
}

/**
 * 异步入口：与同步入口共用 `route()`，只是把 `call_tool` 真的 await 掉
 * （C1 的 handler 允许返回 Promise）。同一个请求两个入口的结果对非 call_tool 的 call
 * **逐字节一致**；`call_tool` 只有这条路径给得出真结果。
 */
export async function handleAiRequestAsync(req: AiRpcRequest, ctx: AiRpcCtx): Promise<AiRpcResponse> {
  try {
    const out = route(req, ctx);
    if (out.kind === "reply") return { status: out.status, body: out.body };
    const res: AiToolResult = await callTool(out.id, out.args, toolCtx(ctx));
    if (res && res.ok === false) return { status: 200, body: aiRpcErrorBody(res.error ?? "tool failed") };
    return { status: 200, body: aiRpcOkBody(res) };
  } catch (e) {
    rollbackIfTurnOpen(ctx);
    return { status: 503, body: aiRpcErrorBody("internal: " + message(e)) };
  }
}
