// C3 的 JS 生命周期（PLAN-ai §5.1 的「服务层」）：
// 读设置决定起不起 → 经 `window.PixelBridge` 起停原生端口 → 注册 `window.__pc_ai_call`。
//
// 三条硬口径（不要改回去）：
// 1. **挂起 = 返回空串**。`window.__pc_ai_call(envelopeJson, requestId)` 先走同步快路径；
//    只有当路由回哨兵 `AI_RPC_ASYNC_BODY`（只有 `call_tool` 会）时才返回空串，过一会儿再用
//    `PixelBridge.aiRespond(requestId, json)` 交付。**绝不能把 Promise 直接返回给 Java**
//    —— Java 拿到 Promise 的字符串形式会判 `js-async-unsupported`。
//    `aiRespond` 返回 false（10s 超时 / 已经交付过）只记诊断，**不重试**：Java 侧已经放弃了，
//    重发只会把同一个 requestId 的第二次交付丢掉（而且 dirty 的第二次写入更糟）。
// 2. **无桥接（浏览器 / PWA / Node 开发宿主）全部降级为 no-op 且不抛**：这个文件在 Node 里
//    也能被 import（`toolchain/ai-server.mjs` 与 tests/ai-rpc.test.ts 就是这么做），
//    所以任何 `window` / `PixelBridge` 的触碰都必须在 `typeof window` 与 try/catch 后面。
// 3. **回合失败必须回滚**：路由抛异常 / 异步交付失败时，若 C2 的回合还开着就调
//    `rollbackAiTurn()`。C2 的「回合期间不动历史」是临时影子掉 History 的三个压栈入口实现的，
//    影子残留 = 用户此后正常绘制静默不进历史（丢撤销）。rollback 本身幂等。
//
// token：APK 路径由 Java 生成（`aiServerStart(port)` 同步返回 16 字节十六进制），JS 只保存；
// 没有 Java 的宿主（`toolchain/ai-server.mjs`）用这里导出的 `randomToken()` 自己生成一份 ——
// 两边都是**每次启动重新生成**，不会持久化（重启即换，旧 token 立刻失效）。
//
// `ctx.confirm` 默认省略 → 路由用 `AI_CONFIRM_DENY`（恒 false）。C3 没有确认 UI（C5 才有），
// **禁止**为了「让 destructive 工具能用」而默认放行；宿主想接真弹框就调 `setAiConfirmer()`。

import * as bridge from "../io/bridge";
import {
  AI_RPC_ASYNC_BODY, AI_TURN_IDLE_SEC_DEFAULT, aiRpcErrorBody, aiTurnIdleSeconds, aiTurnIdleText,
  expireIdleTurn, handleAiRequest, handleAiRequestAsync, setAiTurnIdleSeconds,
} from "./ai-rpc";
import type { AiConfirm, AiRpcCtx, AiRpcRequest, AiRpcResponse, AiServiceTier } from "./ai-rpc";
import { aiServeSettings, onAiServeSettingsChange } from "./settings";
import type { AiServeSettings } from "./settings";
import type { Session } from "./session";

/** Java 侧的四个桥接方法（可注入，方便测试与将来的宿主） */
export interface AiServeBridge {
  /** 起服务；返回 Java 生成的新 token，绑定失败返回 "" */
  aiServerStart?: (port: number) => string;
  aiServerStop?: () => void;
  /** Java 侧实况 JSON 原文 */
  aiServerStatus?: () => string;
  /** 交付一条异步响应；false = 超时 / 已交付过 */
  aiRespond?: (requestId: string, json: string) => boolean;
}

/** 服务没起来的原因（UI 层用 `AI_SERVE_REASON_KEYS` 查文案） */
export type AiServeReason = "running" | "disabled" | "no-bridge" | "bind-failed" | "stopped" | "error";

/** 原因 → i18n 键（文案在 src/ui/i18n.ts，本模块不 import UI） */
export const AI_SERVE_REASON_KEYS: Record<AiServeReason, string> = {
  running: "aiReasonRunning",
  disabled: "aiReasonDisabled",
  "no-bridge": "aiReasonNoBridge",
  "bind-failed": "aiReasonBindFailed",
  stopped: "aiReasonStopped",
  error: "aiReasonError",
};

/** 给宿主的提示事实（文案由 UI 层拼：见 src/main.tsx） */
export interface AiServeNotice {
  running: boolean;
  reason: AiServeReason;
  port: number;
  token: string;
  tier: AiServiceTier;
}

export interface AiServeDeps {
  session: Session;
  /** `GET /ai/health` 报出去的版本号（main.tsx 传 APP_VERSION；本模块不 import UI） */
  version: string;
  /** 桥接实现；`undefined` = 用 `window.PixelBridge`，`null` = 强制当作没有桥接（测试用） */
  bridge?: AiServeBridge | null;
  /** 设置读取；省略 = `settings.ts` 的 `aiServeSettings()` */
  settings?: () => AiServeSettings;
  /** 真确认器（C5 / 宿主注入）；**省略 = 一律拒绝** */
  confirm?: AiConfirm;
  /**
   * 回合空闲多少秒自动 rollback。语义（**别把 0 当成默认**）：
   *   · **省略 / `undefined`** = 用设置项 `ai.turnIdleSec`（默认 `AI_TURN_IDLE_SEC_DEFAULT` = 300s），
   *     守卫**会**武装；
   *   · **显式 `0`** = 用户主动关掉这条兜底，守卫**不**武装（诊断写「∞s（已关闭）」）；
   *   · 也可以传函数（`main.tsx` 就是这么接的）：每次重挂守卫时现读设置项，
   *     免得把值钉死在启动那一刻、改设置不生效。
   */
  turnIdleSec?: number | (() => number);
  /** 启动 / 失败 / 停止时给用户看的一句话（main.tsx 用 toast 发出去） */
  notice?: (n: AiServeNotice) => void;
  /** 诊断行（控制台 / 日志；Node 宿主也会用） */
  log?: (line: string) => void;
}

export interface AiServeStatus {
  installed: boolean;
  running: boolean;
  reason: AiServeReason;
  port: number;
  tier: AiServiceTier;
  /** Java 发过来的 token（没有桥接时是空串）；**只给诊断用，别塞进对外响应** */
  token: string;
  calls: number;
  syncCalls: number;
  asyncCalls: number;
  pending: number;
  responds: number;
  respondFailures: number;
  rollbacks: number;
  /** 现在有没有一个 AI 回合开着（开着的时候 History 的三个压栈入口是被影子掉的） */
  turnOpen: boolean;
  /** 回合空闲多少秒会自动 rollback（0 = 关掉）。**现算**自 ai-rpc 的同一个值，不做第二份记账 */
  turnIdleSec: number;
  /** 空闲收尾口径的短文本（`"300s"` / `"∞s（已关闭）"`），与 `turnIdleSec` 同源 */
  turnIdleText: string;
  /** 回合空闲兜底定时器**现在装着没有**（R1 的验收点：省略 turnIdleSec 时也必须为 true） */
  idleGuardArmed: boolean;
  bridge: boolean;
  confirm: "denied-by-default" | "injected";
  lastError: string;
}

/** 运行时状态 = 诊断快照减去**两个现算字段**（`turnIdleSec` / `turnIdleText` 一律从 ai-rpc 现读，
 *  本模块不留第二份，免得又变成「一边 300s、一边 ∞s」） */
interface ServeState extends Omit<AiServeStatus, "turnIdleSec" | "turnIdleText"> {
  root: AiServeDeps | null;
  unsubscribe: (() => void) | null;
  confirmer: AiConfirm | null;
  /** 回合空闲兜底定时器（外部 agent 断线后再也不来请求，只能靠它收尾） */
  idleTimer: number | null;
  unloadHandler: (() => void) | null;
}

const state: ServeState = {
  installed: false,
  running: false,
  reason: "disabled",
  port: 0,
  tier: "read",
  token: "",
  calls: 0,
  syncCalls: 0,
  asyncCalls: 0,
  pending: 0,
  responds: 0,
  respondFailures: 0,
  rollbacks: 0,
  turnOpen: false,
  idleGuardArmed: false,
  bridge: false,
  confirm: "denied-by-default",
  lastError: "",
  root: null,
  unsubscribe: null,
  confirmer: null,
  idleTimer: null,
  unloadHandler: null,
};

declare global {
  interface Window {
    /** C3 诊断入口（`__pcAi.status()` / `text()` / `start()` / `stop()` / `setConfirmer()`） */
    __pcAi?: {
      status: () => AiServeStatus;
      text: () => string;
      start: () => AiServeStatus;
      stop: () => AiServeStatus;
      setConfirmer: (fn: AiConfirm | null) => void;
      setTurnIdleSec: (sec: number) => number;
    };
  }
}

// ------------------------------------------------------------------ token

/**
 * 16 字节随机 token → 32 位十六进制（`randomToken()` 的长度是协议的一部分：
 * Java 侧 `AiServer.java` 生成的也是 16 字节十六进制）。
 * 优先 `crypto.getRandomValues`，没有（老环境 / 受限 WebView）才退回 `Math.random`。
 */
export function randomToken(): string {
  const bytes = new Uint8Array(16);
  let filled = false;
  try {
    const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
    if (c && typeof c.getRandomValues === "function") {
      c.getRandomValues(bytes);
      filled = true;
    }
  } catch {
    filled = false;
  }
  if (!filled) for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] + 0x100).toString(16).slice(1);
  return out;
}

// ------------------------------------------------------------------ 回合收尾

/** 回滚一个开着的回合（幂等、吞异常）。**任何**「这个回合不会有人来 commit 了」的路径都要调它：
 *  路由抛异常、异步交付失败、`aiServerStop()`、`pagehide`、空闲超时。 */
function rollbackOpenTurn(root: AiServeDeps | null): boolean {
  try {
    if (!root || !root.session || !root.session.aiTurnOpen()) return false;
    root.session.rollbackAiTurn();
    state.rollbacks++;
    state.turnOpen = false;
    return true;
  } catch {
    return false; // 已经在错误路径上了，别把调用方也打挂
  }
}

function clearIdleGuard(): void {
  state.idleGuardArmed = false;
  if (state.idleTimer === null) return;
  try {
    clearTimeout(state.idleTimer);
  } catch {
    /* ignore */
  }
  state.idleTimer = null;
}

/**
 * 回合空闲兜底：每处理完一条请求，只要回合还开着就重新上一发定时器（`idleSec + 0.1s` 之后触发）。
 * 这是「外部 agent 断线后再也不说话」唯一能收尾的路径 —— 用户此后照常画画，而 History 的影子
 * 要是留着，他画的一切都静默不进历史（丢撤销）。定时器只在有回合开着时才存在。
 *
 * `sec` **现读 ai-rpc 的同一个值**（`aiTurnIdleSeconds()`），本模块不再自己记账：
 * `status.turnIdleSec` / `turnPolicy` / `turnGuard` 与这个定时器读到的必须是同一个数（R1）。
 */
function armIdleGuard(root: AiServeDeps): void {
  clearIdleGuard();
  const sec = aiTurnIdleSeconds();
  if (!(sec > 0) || !root.session || !root.session.aiTurnOpen()) return;
  const arm = (): void => {
    const t = setTimeout(() => {
      state.idleTimer = null;
      state.idleGuardArmed = false;
      try {
        expireIdleTurn(root.session);
      } catch {
        /* 空闲收尾失败不该影响服务 */
      }
      if (root.session.aiTurnOpen()) arm(); // 还没到点（或回滚失败）→ 继续等
    }, Math.round(sec * 1000) + 100);
    state.idleTimer = t as unknown as number;
    state.idleGuardArmed = true;
    // Node 里别让这个定时器把事件循环吊着（浏览器里是 number，没有 unref，`?.` 天然跳过）
    try {
      (t as unknown as { unref?: () => void }).unref?.();
    } catch {
      /* ignore */
    }
  };
  arm();
}

// ------------------------------------------------------------------ 桥接

const nativeBridge: AiServeBridge = {
  aiServerStart: (port: number) => bridge.aiServerStart(port),
  aiServerStop: () => bridge.aiServerStop(),
  aiServerStatus: () => bridge.aiServerStatus(),
  aiRespond: (requestId: string, json: string) => bridge.aiRespond(requestId, json),
};

/** 当前桥接：注入的优先；否则只有 `window.PixelBridge` 真的带 AI 方法才算「有桥接」
 *  （老壳 / 浏览器里 PixelBridge 只提供 toast/vibrate，那种不算）。 */
function bridgeOf(root: AiServeDeps): AiServeBridge | null {
  if (root.bridge !== undefined) return root.bridge;
  try {
    if (typeof window === "undefined") return null;
    const pb = window.PixelBridge as unknown as AiServeBridge | undefined;
    if (!pb) return null;
    if (typeof pb.aiServerStart !== "function" && typeof pb.aiRespond !== "function") return null;
    return nativeBridge;
  } catch {
    return null;
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function settingsOf(root: AiServeDeps): AiServeSettings {
  try {
    return (root.settings ?? aiServeSettings)();
  } catch {
    return aiServeSettings();
  }
}

// ------------------------------------------------------------------ 生命周期

function emitNotice(root: AiServeDeps, reason: AiServeReason): void {
  const n: AiServeNotice = { running: state.running, reason, port: state.port, token: state.token, tier: state.tier };
  try {
    root.notice?.(n);
  } catch {
    /* 提示失败不该影响服务本身 */
  }
  try {
    root.log?.("AI 服务：" + aiServeStatusText());
  } catch {
    /* 同上 */
  }
}

function stopNative(root: AiServeDeps): void {
  const b = bridgeOf(root);
  try {
    b?.aiServerStop?.();
  } catch (e) {
    state.lastError = "aiServerStop 抛异常: " + message(e);
  }
}

/**
 * 生效的空闲秒数（**唯一一处决定「守卫装不装」的地方**，R1）：
 *   ① 宿主显式传了 `turnIdleSec`（数字或函数）→ 用它；**显式 0 = 主动关掉**；
 *   ② 否则读设置项 `ai.turnIdleSec`（默认 `AI_TURN_IDLE_SEC_DEFAULT` = 300s）；
 *   ③ 再兜底成 `AI_TURN_IDLE_SEC_DEFAULT` —— 就算将来有人换了接线方式、设置读不出来，
 *      守卫也不会静默失效（缺省必须是「武装」，不是「关闭」）。
 */
function resolveIdleSec(root: AiServeDeps, cfg: AiServeSettings): number {
  let d: unknown = root.turnIdleSec;
  if (typeof d === "function") {
    try {
      d = d();
    } catch {
      d = undefined;
    }
  }
  if (typeof d === "number" && Number.isFinite(d) && d >= 0) return d;
  const c = Number(cfg.turnIdleSec);
  if (Number.isFinite(c) && c >= 0) return c;
  return AI_TURN_IDLE_SEC_DEFAULT;
}

/**
 * 按设置起 / 停（幂等）。这是**唯一**碰原生端口的地方：
 *   · `ai.server` 关 → 先收尾回合、清守卫，再停端口（R2：关设置和 stopAiServe 同口径）；
 *   · 没有桥接 → no-op 降级（不抛），原因记 `no-bridge`；
 *   · `aiServerStart` 返回空串 → 绑定失败（端口被占用 / 权限），原因记 `bind-failed`。
 */
export function applyAiServe(): AiServeStatus {
  applyServeSettings();
  // 每一次应用设置都按最新值重挂守卫（回合没开就是空操作）：改 ai.turnIdleSec 立刻生效
  if (state.root) armIdleGuard(state.root);
  return aiServeStatus();
}

/** 起停 + 把空闲秒数同步进 ai-rpc（守卫的挂载由调用方负责，见 applyAiServe） */
function applyServeSettings(): void {
  const root = state.root;
  if (!root) {
    state.reason = "error";
    state.lastError = "installAiServe 还没调用";
    return;
  }
  const cfg = settingsOf(root);
  state.tier = cfg.tier;
  setAiTurnIdleSeconds(resolveIdleSec(root, cfg));

  if (!cfg.server) {
    const wasRunning = state.running;
    // 关掉服务也必须先收尾：回合的影子（History 三个压栈入口）留在身后 = 用户此后丢撤销。
    // 两步都幂等，不会伤到「本来就关着」的状态（R2）。
    clearIdleGuard();
    rollbackOpenTurn(root);
    if (wasRunning) stopNative(root);
    state.running = false;
    state.port = cfg.port;
    state.token = "";
    state.reason = "disabled";
    if (wasRunning) emitNotice(root, "stopped");
    return;
  }

  // 已经在同一个端口上跑着 → **只换档位，不重启**（重启会轮换 token，正在用的客户端会突然 401）
  if (state.running && state.port === cfg.port) {
    state.reason = "running";
    return;
  }
  state.port = cfg.port;

  const b = bridgeOf(root);
  state.bridge = !!b;
  if (!b || typeof b.aiServerStart !== "function") {
    // 浏览器 / Node / PWA：没有原生端口可起。**全部降级为 no-op**，不抛异常。
    state.running = false;
    state.token = "";
    state.reason = "no-bridge";
    emitNotice(root, "no-bridge");
    return;
  }

  let token = "";
  try {
    token = b.aiServerStart(cfg.port) || "";
  } catch (e) {
    state.running = false;
    state.token = "";
    state.reason = "error";
    state.lastError = "aiServerStart 抛异常: " + message(e);
    emitNotice(root, "error");
    return;
  }
  if (!token) {
    state.running = false;
    state.token = "";
    state.reason = "bind-failed";
    state.lastError = "aiServerStart(" + cfg.port + ") 返回空串：端口被占用或绑定失败（只绑 127.0.0.1）";
    emitNotice(root, "bind-failed");
    return;
  }
  state.running = true;
  state.token = token;
  state.reason = "running";
  state.lastError = "";
  emitNotice(root, "running");
}

/** 装好这个模块：注册 `window.__pc_ai_call` / `window.__pcAi`、订阅设置、按设置起服务。幂等。 */
export function installAiServe(deps: AiServeDeps): AiServeStatus {
  uninstallAiServe();
  state.root = deps;
  state.installed = true;
  state.confirmer = deps.confirm ?? null;
  state.confirm = state.confirmer ? "injected" : "denied-by-default";
  try {
    if (typeof window !== "undefined") {
      window.__pc_ai_call = aiServeHandleCall;
      window.__pcAi = {
        status: aiServeStatus,
        text: aiServeStatusText,
        start: applyAiServe,
        stop: stopAiServe,
        setConfirmer: setAiConfirmer,
        setTurnIdleSec: (sec) => {
          setAiTurnIdleSeconds(sec);
          if (state.root) armIdleGuard(state.root);
          return aiTurnIdleSeconds();
        },
      };
      // 页面卸载（WebView 被销毁 / 关标签页）：端口是 Java 的事，但**回合的影子必须还回去**
      const onUnload = (): void => {
        clearIdleGuard();
        rollbackOpenTurn(state.root);
      };
      window.addEventListener("pagehide", onUnload);
      state.unloadHandler = onUnload;
    }
  } catch {
    /* 只读的 window（极端宿主）也要能装下去：服务本身不依赖这两个入口 */
  }
  state.unsubscribe = onAiServeSettingsChange(() => {
    applyAiServe();
  });
  return applyAiServe();
}

/** 摘掉入口与订阅（测试用；原生端口也会停掉，开着的回合先回滚） */
export function uninstallAiServe(): void {
  clearIdleGuard();
  rollbackOpenTurn(state.root);
  const root = state.root;
  if (root && state.running) stopNative(root);
  state.running = false;
  state.token = "";
  if (state.unsubscribe) {
    try {
      state.unsubscribe();
    } catch {
      /* ignore */
    }
  }
  state.unsubscribe = null;
  state.root = null;
  state.installed = false;
  try {
    if (typeof window !== "undefined") {
      if (state.unloadHandler) window.removeEventListener("pagehide", state.unloadHandler);
      state.unloadHandler = null;
      if (window.__pc_ai_call === aiServeHandleCall) delete window.__pc_ai_call;
      delete window.__pcAi;
    }
  } catch {
    /* ignore */
  }
}

/**
 * 停服务：**先收尾回合再停端口**。回合的影子残留在身后 = 用户此后正常绘制静默不进历史
 * （丢撤销），所以这一步不能省 —— 即使端口停掉之后不会再有外部请求进来。
 */
export function stopAiServe(): AiServeStatus {
  clearIdleGuard();
  rollbackOpenTurn(state.root);
  const root = state.root;
  if (root) stopNative(root);
  state.running = false;
  state.token = "";
  state.reason = "stopped";
  return aiServeStatus();
}

/** 注入 destructive 的确认器（宿主 / C5 接真弹框）；传 null 回到「一律拒绝」 */
export function setAiConfirmer(fn: AiConfirm | null): void {
  state.confirmer = fn ?? null;
  state.confirm = state.confirmer ? "injected" : "denied-by-default";
}

// ------------------------------------------------------------------ 请求入口

/** 回合还开着就回滚（路由抛异常 / 异步交付失败时调；幂等，出错也吞掉） */
function rollbackTurnSafe(root: AiServeDeps | null): void {
  rollbackOpenTurn(root);
}

/** 从 envelope 里取 token：支持 `{token}` 与 `{headers:{Authorization}}` 两种；取不到返回 "" */
function envelopeToken(env: Record<string, unknown>): string {
  if (typeof env.token === "string") return env.token;
  const h = env.headers;
  if (h && typeof h === "object") {
    const o = h as Record<string, unknown>;
    const raw = o.Authorization ?? o.authorization;
    if (typeof raw === "string") return raw.replace(/^Bearer\s+/i, "").trim();
  }
  return "";
}

function buildCtx(root: AiServeDeps): AiRpcCtx {
  return {
    session: root.session,
    // Java 已经用同一个 token 验过请求头，envelope 里通常没有 token；带了的就逐字节比
    token: state.token,
    tier: state.tier,
    version: root.version,
    confirm: state.confirmer ?? undefined,
    hostStatus: () => ({
      host: root.bridge ? "injected" : bridgeOf(root) ? "android-webview" : "none",
      port: state.port,
      running: state.running,
      tokenTail: state.token ? state.token.slice(-4) : "",
      calls: state.calls,
      syncCalls: state.syncCalls,
      asyncCalls: state.asyncCalls,
      pending: state.pending,
      responds: state.responds,
      respondFailures: state.respondFailures,
      rollbacks: state.rollbacks,
      native: bridge.aiServerStatus() || "",
      turnGuard: "嵌套 turn_begin 先 rollback 上一个（结果带 warn）；空闲 " + aiTurnIdleText() +
        " 无请求自动 rollback（守卫" + (state.idleGuardArmed ? "已武装" : "未武装") +
        "）；停止服务 / pagehide / 路由抛异常都会 rollback",
      note: "destructive 需宿主确认，本版本未接线（C5 才有确认 UI）：默认一律拒绝，回 {\"ok\":false,\"error\":\"cancelled\"}",
    }),
  };
}

/** 交付一次异步结果（只认第一次；false 只记诊断，不重试） */
function deliverAsync(root: AiServeDeps, requestId: string, json: string): void {
  if (state.pending > 0) state.pending--;
  if (!requestId) {
    state.respondFailures++;
    state.lastError = "异步结果没有 requestId，无法交付";
    return;
  }
  const b = bridgeOf(root);
  if (!b || typeof b.aiRespond !== "function") {
    state.respondFailures++;
    state.lastError = "没有桥接，异步结果被丢弃";
    return;
  }
  let ok = false;
  try {
    ok = b.aiRespond(requestId, json) === true;
  } catch (e) {
    state.lastError = "aiRespond 抛异常: " + message(e);
  }
  if (ok) state.responds++;
  else {
    state.respondFailures++;
    if (!state.lastError) state.lastError = "aiRespond 返回 false（10s 超时或已交付过）";
  }
}

/**
 * `window.__pc_ai_call(envelopeJson, requestId)` 的本体（导出来是为了能在 Node 里直接测）。
 * envelope 永远是 `{"method":"POST","path":"/ai","body":"<原始 body 文本>"}`；
 * `body` 对 `/ai/health` 是**空串**，所以这里原样往下传，由路由按路径分流。
 * @returns 一行 JSON（快路径）；**空串 = 挂起**，随后由 `PixelBridge.aiRespond` 交付。
 */
export function aiServeHandleCall(envelopeJson: string, requestId: string): string {
  state.calls++;
  const root = state.root;
  if (!root) return aiRpcErrorBody("ai-serve 还没 installAiServe");

  let env: Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(envelopeJson)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return aiRpcErrorBody("envelope 必须是 JSON 对象");
    env = parsed as Record<string, unknown>;
  } catch (e) {
    return aiRpcErrorBody("envelope 不是 JSON: " + message(e));
  }

  const req: AiRpcRequest = {
    method: typeof env.method === "string" ? env.method : "GET",
    path: typeof env.path === "string" ? env.path : "/ai",
    // 带 token 就按它校验，没带就用 Java 交回来的那个（Java 已经验过请求头）
    token: envelopeToken(env) || state.token,
    body: typeof env.body === "string" ? env.body : "",
  };
  const ctx = buildCtx(root);

  let sync: AiRpcResponse;
  try {
    sync = handleAiRequest(req, ctx);
  } catch (e) {
    rollbackTurnSafe(root);
    state.turnOpen = root.session.aiTurnOpen();
    armIdleGuard(root);
    return aiRpcErrorBody("internal: " + message(e));
  }
  state.turnOpen = root.session.aiTurnOpen();
  armIdleGuard(root);
  if (sync.body !== AI_RPC_ASYNC_BODY) {
    state.syncCalls++;
    return sync.body;
  }

  // 挂起：call_tool 的 handler 可能是异步的（destructive 还要 await 确认）。
  // **同步返回空串**，让 Java 的 worker 继续等；结果过一会儿用 aiRespond 交付。
  state.asyncCalls++;
  state.pending++;
  const id = String(requestId ?? "");
  handleAiRequestAsync(req, ctx).then(
    (r) => {
      state.turnOpen = root.session.aiTurnOpen();
      armIdleGuard(root);
      deliverAsync(root, id, r.body);
    },
    (e) => {
      rollbackTurnSafe(root);
      state.turnOpen = root.session.aiTurnOpen();
      armIdleGuard(root);
      deliverAsync(root, id, aiRpcErrorBody("internal: " + message(e)));
    },
  );
  return "";
}

// ------------------------------------------------------------------ 诊断

/** 状态快照（副本）。`turnOpen` / `turnIdleSec` 现算，避免拿旧快照判断「回合还开着吗」 */
export function aiServeStatus(): AiServeStatus {
  let turnOpen = state.turnOpen;
  try {
    if (state.root && state.root.session) turnOpen = state.root.session.aiTurnOpen();
  } catch {
    /* 拿不到就退回上次记的值 */
  }
  return {
    installed: state.installed,
    running: state.running,
    reason: state.reason,
    port: state.port,
    tier: state.tier,
    token: state.token,
    calls: state.calls,
    syncCalls: state.syncCalls,
    asyncCalls: state.asyncCalls,
    pending: state.pending,
    responds: state.responds,
    respondFailures: state.respondFailures,
    rollbacks: state.rollbacks,
    turnOpen,
    // 三处诊断同源：这两个值都现算自 ai-rpc 的同一个 turnIdleMs（本模块不存第二份）
    turnIdleSec: aiTurnIdleSeconds(),
    turnIdleText: aiTurnIdleText(),
    idleGuardArmed: state.idleGuardArmed,
    bridge: state.bridge,
    confirm: state.confirm,
    lastError: state.lastError,
  };
}

/** 一行诊断（`__pcAi.text()` / 控制台 / toast 共用） */
export function aiServeStatusText(): string {
  const s = aiServeStatus();
  return "AI 本地服务：" + (s.running ? "运行中 127.0.0.1:" + s.port : "未运行（" + s.reason + "）") +
    " · 档位 " + s.tier +
    " · token " + (s.token ? "…" + s.token.slice(-4) : "无") +
    " · 调用 " + s.calls + "（同步 " + s.syncCalls + " / 异步 " + s.asyncCalls + " / 挂起 " + s.pending + "）" +
    " · 异步回调 " + s.responds + " 成功 / " + s.respondFailures + " 失败" +
    " · 回合" + (s.turnOpen ? "开着" : "关着") +
    "（空闲 " + s.turnIdleText + " 自动收尾" + (s.idleGuardArmed ? "，守卫已武装" : "") + "）" +
    " · 回合回滚 " + s.rollbacks +
    " · 确认器=" + (s.confirm === "injected" ? "宿主已接入" : "默认拒绝（destructive 需宿主确认，本版本未接线）") +
    (s.lastError ? " · 最近错误：" + s.lastError : "");
}
