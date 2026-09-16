// C5 应用内助手面板（docs/PLAN-ai.md §3.3「预览后应用」/ §3.5 A 路线 / §3.6 key 与安全模型）。
//
// 这个面板只做三件事：把话说给 `src/app/ai-chat.ts` 的整轮循环、把工具调用摘要显示出来、
// 提供「应用 / 放弃」两个结局。**逻辑一行都不写在这里**（那一层是纯函数 + 注入 fetch，能单测）。
//
// 平台门（用户 2026-09-16 明确：GitHub Pages / 普通浏览器**不背 AI**）：
//   · 只有 `isNativeShell()`（APK / 桌面壳的 `window.PixelBridge`）为真才会被挂出来
//     —— 菜单入口那一行也是同一个判据（`ui/modals.tsx` 的 MenuModal）；
//   · 这里再判一次是防御性的：真被挂起来也只显示一句说明，**不去连端点、不发任何请求**，
//     绝不出现「点了没反应」。
//
// 预览后应用（§3.3 建议默认）：
//   整轮用 `runChatTurn({ commit: false })` 跑，回合**留开着**（不落历史、不刷 autosave），
//   用户点「应用」才 `SESSION.commitAiTurn()`（一轮一条撤销），点「放弃」`SESSION.rollbackAiTurn()`
//   （逐字节回到这一轮开始）。**面板卸载时回合还开着 → 立刻放弃**：回合开着时用户自己的写入
//   会被下一次 rollback 吞掉（ai-turn.ts 的调用方义务第 2 条），绝不能把这个状态留下来。
//
// 浮窗化之后（PLAN-ai §3.7.6 的事件表 L465–L469）这一段多了一条细则：
// **最小化 = 浮窗 DOM 真的卸载**（`display:none` 不算）时，**回合还开着就 rollback** ——
// 最小化按钮 / 标题栏双击 / Esc / Android 返回键（「只是最小化」）/ 关窗 **同语义**：
// 放弃还没收尾的那一轮，保留的是**对话与 thread**（本文件上方那层会话存储）与浮窗几何。
// 理由与第 15-16 行同一个：回合开着会挡住用户自己的写入。
//
// 这个文件现在有三块（都在浮窗化时落在这里，为的是那几个 inScope 文件就是全部改动面）：
//   ① 跨卸载的会话存储（`aiWinStore` / `noteAiWinClosed`）
//   ② 助手浮动球 `ChatBall`（**独立小球**，不进 `ORB_IDS`）
//   ③ 对话面板 `AiPanel`
//
// key 不出现在这个文件里的任何提示 / 日志 / 网络以外的路径：面板只显示端点与模型名，
// key 只写进 `Authorization` 头（在 ai-chat 的 requestModel 里）。

import { useEffect, useRef, useState } from "react";
import { SESSION } from "./singleton";
import { Btn, Icon } from "./kit/primitives";
import { isNativeShell } from "../io/bridge";
import * as bridge from "../io/bridge";
import { docDigest } from "../app/ai-doc";
import {
  AI_CHAT_HOST_KEY_SENTINEL, AI_CHAT_TEMP_STEP, aiChatStatusText, chatConfigError,
  detectChatProxy, formatCallLog, proxyChatFetch, runChatTurn, systemMessage, userMessage,
} from "../app/ai-chat";
import type { ChatCallLog, ChatFetch, ChatMessage } from "../app/ai-chat";
import type { AiToolCtx } from "../app/ai-tools";
import { AI_CHAT_DEFAULT_MODEL, aiChatSettings, saveAiChatSettings } from "../app/settings";
import { AI_CHAT_BALL_KEY, CHAT_BALL_ID, clampAiBallPos, normalizeAiBallPos } from "../app/uibar";
import { orbMetrics } from "./orb-layout";
import { useKitPcMode } from "./kit";
import type { Rect } from "../engine/types";
import type { makeT } from "./i18n";

// ============================================================================================
// ① 跨卸载的会话存储（浮窗「最小化」是**真的卸载 DOM**，见 docs/PLAN-ai.md §3.7.6）
//
// 为什么需要它：按定稿状态机，最小化必须把浮窗 DOM 卸掉（`display:none` 不算 ——
// `AiPanel` 的卸载钩子要跑）。**对话与 thread 要留着**（用户下次打开还看得见自己说过什么），
// 而它们原来全是 `AiPanel` 的 useState，一卸载就没了。所以这一层把「跨卸载要活下来的东西」
// 提出来，放在**模块作用域**上（进程内保留，**不落盘** —— 本轮不持久化对话）。
//
// 注意区分**两件事**（P9 的核心）：
//   · **回合**（Session 的 AI turn）—— 卸载时只要还开着就 rollback，**没有例外**
//     （最小化 / 关窗 / 返回键 / 被别处卸掉同语义，见 `aiPanelDropsTurnOnUnmount()`）；
//   · **对话与浮窗几何** —— 跨卸载保留。
// 早先把这两个混成一个 `aiWinStore.mode` 标志位，于是「记得在最小化时设它」成了调用点的义务；
// 结果 `pc-back` 那条路径设了、窗口按钮那条没设，两边语义相反（一个留回合、一个丢回合），
// 而 §3.7.6 的事件表要求两边**都是丢**。现在判定只看 Session 的实况，不再有第二份状态可漂移。
// 这一层**不碰 Session、不碰 DOM**。
// ============================================================================================

/** 面板里的一行（用户 / 助手 / 提示）。模型侧的消息流另存在 `thread` 里 —— 两者不是一回事：
 *  「放弃」会把模型侧的这一轮忘掉，但用户看到的那句话要留着。 */
interface AiEntry {
  role: "user" | "assistant" | "note" | "error";
  text: string;
}

/** 预览还没收尾的那一轮 */
interface AiPending {
  calls: number;
  rect: Rect | null;
  docRev: number;
  docRevBefore: number;
}

interface AiWinStore {
  /** 模型侧的消息流（不含 system —— 每次发送时按当时的画布摘要重新拼一条） */
  thread: ChatMessage[];
  /** 用户看得见的那些行 */
  entries: AiEntry[];
  /** 还没收尾的预览（**只在会话里的回合确实开着时才有效**，见 `aiPanelShowsPreview()`） */
  pending: AiPending | null;
  /** 上一轮的调用摘要（列表用） */
  logs: ChatCallLog[];
  /** 输入框里没发出去的那句话 */
  input: string;
}

/** 进程内单例：`AiPanel` 每次挂载都读写它（所以卸载不丢对话） */
export const aiWinStore: AiWinStore = {
  thread: [], entries: [], pending: null, logs: [], input: "",
};

/**
 * **卸载这个面板时要不要放弃还没收尾的那一轮**（P9 定稿，纯函数、可单测）。
 *
 * 定稿口径（PLAN-ai §3.7.6 事件表 L465–L469）是「**只要卸载时回合还开着，就放弃**」：
 * 最小化按钮 / 标题栏双击 / Esc / Android 返回键（「只是最小化」）/ 关窗 **五条路径同语义**。
 * 所以这里不再有「最小化例外」—— 判据直接问 Session 的实况，**任何**新增的卸载路径
 * （第六条、第七条）都自动落在同一条规则上，不需要记得在任何地方补一个标志位。
 *
 * 唯一的输入是「现在是不是最小化着」，而且只用来**显示预览 UI**（见 `aiPanelShowsPreview()`）：
 * 最小化 = 这一轮已经被放弃、画面已回到轮次开始前，不该再画一套点不动的「应用 / 放弃」。
 */
export function aiPanelDropsTurnOnUnmount(session: { aiTurnOpen(): boolean }): boolean {
  return session.aiTurnOpen();
}

/**
 * **要不要画「预览中 → 应用 / 放弃」那套 UI**（纯函数、可单测）。
 *
 * 两个条件缺一不可：
 *   · 面板**看得见**（`winOpen && !winMin`）—— 最小化成球 / 关窗之后，那一轮已经被
 *     `aiPanelDropsTurnOnUnmount()` 放弃掉了，再画预览就是「点了没反应」的假 UI（P5 的 t5-f2）；
 *   · 会话里**真的有一轮开着**（`aiTurnOpen()`）—— 光有本地 `pending` 不算数：
 *     回合可能已经被别处收掉（空闲看门狗 / 用户自己的 undo）。
 *
 * 换句话说：预览 UI 的存在由**回合状态**决定，不由「曾经跑过一轮」决定。
 */
export function aiPanelShowsPreview(
  cfg: { winOpen: boolean; winMin: boolean },
  session: { aiTurnOpen(): boolean },
  hasPending: boolean,
): boolean {
  return hasPending && cfg.winOpen === true && cfg.winMin !== true && session.aiTurnOpen();
}

/**
 * 卸载路径（最小化 / 关窗）要**替已经卸载的面板收尾**：放弃还没收尾的那一轮 + 在对话里留一行说明。
 *
 * 与面板里「放弃」按钮那一支**同口径**（`discard()`）：文档回到轮次开始前、模型那半轮从
 * `thread` 里清掉（只留用户那句话）、调用摘要清空，差别只是这里还要补一行「为什么没了」。
 * 只有**真有待收尾的一轮**才动手 —— 没有的话一个字都不加，否则每收一次窗口都多一行废话。
 *
 * ⚠️ 调用时机：必须在把 `winMin` / `winOpen` 写下去**之前**（写下去会立刻重渲染，
 * 面板一卸载就没人接这一轮了）。见 `App.tsx` 的 `minimizeAiWin` / `closeAiWin`。
 */
export function noteAiWinClosed(text: string): void {
  if (!aiWinStore.pending) return;
  aiWinStore.pending = null;
  aiWinStore.logs = [];
  const lastUser = [...aiWinStore.thread].reverse().find((m) => m.role === "user");
  aiWinStore.thread = lastUser ? [lastUser] : [];
  aiWinStore.entries = aiWinStore.entries.concat([{ role: "note", text }]);
}

// ============================================================================================
// ② `localStorage` 读写（一律包 try：隐私模式 / 坏数据都不该让球画不出来）
// ============================================================================================

function lsGet(key: string): unknown {
  try {
    const s = (globalThis as { localStorage?: { getItem(k: string): string | null } }).localStorage;
    const raw = s && typeof s.getItem === "function" ? s.getItem(key) : null;
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function lsSet(key: string, v: unknown): void {
  try {
    const s = (globalThis as { localStorage?: { setItem(k: string, v: string): void } }).localStorage;
    if (s && typeof s.setItem === "function") s.setItem(key, JSON.stringify(v));
  } catch {
    /* 存不下不算错：本机记不住位置而已 */
  }
}

// ============================================================================================
// ③ 助手浮动球（**独立小球**，不进 `ORB_IDS`）
//
// 为什么不扩展 `ORB_IDS`：见 `src/app/uibar.ts` 那段注释（五球系统的 dock / 展开环 /
// 饼菜单 / 界面定制回归面最密，而助手球没有可搬运的子项）。它只与五球系统共享**一条**规则：
// 触屏下点/拖它会收起别的球已经展开的环（`onOtherRings` → App 的 `closeRadials`）；PC 不互斥。
//
// 口径（§3.7.6「球的定稿口径」）：
//   · 存在条件由 App 判（`isNativeShell() && winOpen && winMin && ball`），这里只管画与交互；
//   · 复用 `.orb` 的类名与 `orbMetrics(pcMode).orb` 的尺寸，**不新造球样式**；
//   · 按下后位移 < 8px 视为**点击**（还原浮窗），否则视为拖动（松手不回窗、只记位置）。
// ============================================================================================

export function ChatBall({ t, onRestore, onOtherRings }: {
  t: ReturnType<typeof makeT>;
  onRestore: () => void;
  /** 点球/拖球时通知 App 收起其它球的展开环（触屏互斥；PC 模式由 App 自己忽略） */
  onOtherRings: () => void;
}) {
  const pcMode = useKitPcMode();
  const ORB = orbMetrics(pcMode).orb;
  const [pos, setPos] = useState<{ x: number; y: number }>(() => normalizeAiBallPos(lsGet(AI_CHAT_BALL_KEY), ORB));
  const drag = useRef<{ id: number; dx: number; dy: number; moved: boolean } | null>(null);

  // 平台门（与浮窗同一个判据、同一个理由）：没有原生桥接就没有这个球，一个 DOM 都不渲染
  // —— 挂载点已经判过一次，这里是防御性的第二道。
  if (!isNativeShell()) return null;

  // 旋屏 / 改窗口大小后重跑一次夹取（与 `FloatingTools` 同款做法）
  useEffect(() => {
    const fix = () => setPos((p) => {
      const c = clampAiBallPos(p, ORB);
      lsSet(AI_CHAT_BALL_KEY, c);
      return c;
    });
    window.addEventListener("resize", fix);
    window.addEventListener("orientationchange", fix);
    return () => {
      window.removeEventListener("resize", fix);
      window.removeEventListener("orientationchange", fix);
    };
  }, [ORB]);

  return (
    <button
      type="button"
      data-orb-ball={CHAT_BALL_ID}
      data-orb-id={CHAT_BALL_ID}
      data-guide="orb-ai"
      className="orb sub"
      style={{ left: pos.x, top: pos.y }}
      title={t("aiChatOpen")}
      aria-label={t("aiChatOpen")}
      onPointerDown={(e) => {
        e.preventDefault();
        drag.current = { id: e.pointerId, dx: e.clientX - pos.x, dy: e.clientY - pos.y, moved: false };
        try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
        const onMove = (ev: PointerEvent) => {
          const d = drag.current;
          if (!d || ev.pointerId !== d.id) return;
          // 只有「一次拖动里的第一帧」判一次：之后 d.moved 已经是 true，不再比位移
          if (!d.moved && (Math.abs(ev.clientX - pos.x - d.dx) > 8 || Math.abs(ev.clientY - pos.y - d.dy) > 8)) {
            d.moved = true;
            onOtherRings();                   // 真的开始拖 = 触屏下收起别的球的环
          }
          if (!d.moved) return;
          setPos(clampAiBallPos({ x: ev.clientX - d.dx, y: ev.clientY - d.dy }, ORB));
        };
        const done = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", done);
          window.removeEventListener("pointercancel", done);
          const d = drag.current;
          drag.current = null;
          if (!d) return;
          if (!d.moved) { SESSION.hapticTick("AI 助手", 0.7); onRestore(); return; }
          setPos((p) => { const c = clampAiBallPos(p, ORB); lsSet(AI_CHAT_BALL_KEY, c); return c; });
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", done);
        window.addEventListener("pointercancel", done);
      }}
      onDoubleClick={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <Icon id="i-ai-chat" size={20} />
    </button>
  );
}

// ============================================================================================
// ④ 对话面板本体
// ============================================================================================

/** 没有浮窗存储（SSR / 单测直接渲染面板）时的退路：进程内一个空壳，行为与从前一致 */
const scratchStore: AiWinStore = { thread: [], entries: [], pending: null, logs: [], input: "" };

/** 浏览器 / APK / 桌面壳的 fetch 都满足 `ChatFetch`；没有 fetch 的运行环境返回 null */
function platformFetch(): ChatFetch | null {
  if (typeof fetch !== "function") return null;
  return (url, init) => fetch(url, init);
}

// ------------------------------------------------------------------ 通路：直连 / 同源代理（§3.7.3）
//
// 判定顺序**必须**是这个顺序（它决定「谁在花钱」）：
//   1. 用户在设置里**手填了 key** → 直连（用户的 key 用户自己管，行为与今天完全一致）；
//   2. 没有手填 key，且壳的 `/provider/config` 可用且 `hasEnvKey` → 代理（key 用哨兵常量，
//      页面一个字节都不拿真 key）；
//   3. 两者都没有 → 面板显示「没有可用的 key」提示条，**不发请求**。
//
// ❗不要顺手去「修 CORS」：§3.7.1 的实测已经证明 DeepSeek 会回 CORS 头、`file://` 源也放行，
// 所以代理**不是**为了绕 CORS 而做（四条真理由见 §3.7.1：环境 key 不进页面、用户免手填、
// 错误可控、不依赖对端 CORS）。既有的页面直连能力**必须保留**（非 DeepSeek 端点、或手填 key 时走它）。

/** 探测结果：走代理要知道「壳自报的默认模型」；`base` 只用于展示，**不参与代理 URL 拼装** */
interface ChatTransport {
  mode: "proxy";
  /** 壳报回来的 **provider 基地址**（给用户看的那个端点，不是代理地址） */
  base: string;
  /** 壳自报的默认模型（老壳没这个字段时为空串） */
  model: string;
  hasEnvKey: boolean;
}

/** 进程级缓存：一次打开面板探一次（`pc.aichat` 里不存这个 —— 它随壳的启动参数变） */
let transportCache: ChatTransport | { mode: "direct" } | null = null;
/** 壳的通道 token（**只放内存**，绝不写 localStorage / 不写进任何文本） */
let shellTokenCache = "";

/** 探一次通路。壳不在 / 老壳没有 `/provider/*` / 页面是 `file://` → 一律 `{mode:"direct"}` */
async function detectTransport(fn: ChatFetch): Promise<ChatTransport | { mode: "direct" }> {
  if (transportCache) return transportCache;
  const cfg = await detectChatProxy(fn);
  if (cfg && cfg.hasEnvKey) {
    shellTokenCache = shellToken();
    // `base` 是**壳报回来的 provider 地址**，只用于展示；
    // ⚠️ **绝不能用它拼代理 URL** —— 那会变成 `<providerBase>/provider/chat`（跨源，必然失败）。
    // 代理地址恒为同源相对路径 `/provider/chat`（见 ai-chat 的 `chatProxyUrl()`，P8 修的就是这一条）。
    transportCache = { mode: "proxy", base: cfg.baseUrl, model: cfg.defaultModel, hasEnvKey: true };
  } else {
    transportCache = { mode: "direct" };
  }
  return transportCache;
}

/** 壳的通道 token：`window.PixelBridge.aiServerStatus()` 的 `{"running","port","token"}`（§3.7.2）。
 *  老壳 / 未握手时回空串 → 转发会拿到 401，`hostError()` 会翻成一句「重启壳后刷新页面」。 */
function shellToken(): string {
  try {
    const raw = bridge.aiServerStatus();
    if (!raw) return "";
    const j = JSON.parse(raw) as { token?: unknown };
    return typeof j.token === "string" ? j.token : "";
  } catch {
    return "";
  }
}

/** 测试 / 换壳后重探（通路缓存是进程级的，见上方注释）；本轮 UI 不调它 */
export function resetChatTransport(): void {
  transportCache = null;
  shellTokenCache = "";
}

/** 当前通路（`null` = 还没探完）；给测试与将来的诊断用，**不含任何机密** */
export function chatTransport(): typeof transportCache {
  return transportCache;
}

export function AiPanel({ t, onBack, store }: {
  t: ReturnType<typeof makeT>;
  onBack?: () => void;
  /** 跨卸载的会话存储（浮窗最小化时 DOM 真的卸载，对话不能跟着丢）；省略则用进程内空壳 */
  store?: AiWinStore;
}) {
  const native = isNativeShell();
  const st = store ?? scratchStore;
  /** 模型侧的消息流（不含 system —— 每次发送时按当时的画布摘要重新拼一条） */
  const [thread, setThread] = useState<ChatMessage[]>(() => st.thread.slice());
  const [entries, setEntries] = useState<AiEntry[]>(() => st.entries.slice());
  const [input, setInput] = useState(() => st.input);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [logs, setLogs] = useState<ChatCallLog[]>(() => st.logs.slice());
  // 还没收尾的那一轮（跨卸载保留，但**只有 Session 里回合真的开着**才画预览，见 aiPanelShowsPreview）
  const [pending, setPending] = useState<AiPending | null>(() => st.pending);
  // 通路（直连 / 同源代理）：null = 还没探完（探完才决定 key 从哪来）
  const [transport, setTransport] = useState<typeof transportCache>(() => transportCache);
  const live = useRef(true);

  /** 任何一项变化都同步进存储（卸载时不丢）；四处状态一起走这里，别各写一份 */
  useEffect(() => {
    st.thread = thread; st.entries = entries; st.pending = pending;
    st.logs = logs; st.input = input;
  }, [st, thread, entries, pending, logs, input]);

  useEffect(() => () => {
    live.current = false;
    // 卸载时把开着的回合收掉：否则它会一直挡着用户的写入（下一次 rollback 会吞掉它们）。
    // **没有例外**：最小化 / 关窗 / 返回键 / 被别处卸掉都是卸载，都走这一条（§3.7.6 事件表）。
    // 收尾说明也在这一步补（比 App 更晚写，不会被本组件的「同步进存储」覆盖掉）。
    if (aiPanelDropsTurnOnUnmount(SESSION)) {
      SESSION.rollbackAiTurn();
      noteAiWinClosed(t("aiChatDiscarded"));
    }
  }, [st, t]);

  // 本地的 `pending` 只是「面板以为还有一轮没收尾」；**真值在 Session 里**。
  // 渲染那一步用 `aiPanelShowsPreview()` 再问一次 Session，所以假预览态根本画不出来 ——
  // 这里不再留一个「同步清 pending」的 effect（那样只会让状态多一份、又会漂移）。

  // 每次打开面板探一次通路（不轮询、不跨会话缓存）。探到代理时**只补缺的那个模型名**：
  // 端点 / 模型在**首次加载**时已经由 `settings.ts` 落了 DeepSeek 默认值（P8 的 F3），
  // 这里不再「探通代理才补写」——早先那一步是 F1/F2 一坏就永远补不上的根源。
  useEffect(() => {
    const fn = platformFetch();
    if (!fn || transportCache) { if (transportCache) setTransport(transportCache); return; }
    let alive = true;
    void detectTransport(fn).then((tr) => {
      if (!alive) return;
      // 壳自报的默认模型（老壳没这个字段时退回内置默认值）；用户填过的一个字都不覆盖
      const cfg = aiChatSettings();
      if (tr.mode === "proxy" && !cfg.model.trim()) {
        saveAiChatSettings({ model: tr.model || AI_CHAT_DEFAULT_MODEL });
      }
      setTransport(tr);
    });
    return () => { alive = false; };
  }, []);

  const cfg = aiChatSettings();
  const rawFetch = platformFetch();
  const hostKey = transport?.mode === "proxy" && transport.hasEnvKey;
  // 判定顺序见上方注释：手填 key > 环境 key（代理）> 无。哨兵 key = 「由壳持有」。
  const effKey = cfg.key.trim() ? cfg.key : hostKey ? AI_CHAT_HOST_KEY_SENTINEL : "";
  // 手填 key 时走 `ai.providerBase`（留空 = 用端点地址）；代理模式一律用端点地址（壳自己知道去哪）
  const effEndpoint = (transport?.mode === "proxy" ? cfg.endpoint : cfg.providerBase.trim() || cfg.endpoint).trim();
  // 代理模式下请求重写到**同源** `/provider/chat`，所以底层的 fetch 必须换成包过的那一层。
  // ⚠️ **绝不要把 `transport.base`（壳报的 provider 基地址）当第一个参数传进去** ——
  // 那正是 P8 的 F2：请求会被发到 `<providerBase>/provider/chat`（跨源，必然 Failed to fetch）。
  // 代理地址恒为同源相对路径，所以这里传空串（`chatProxyUrl()` 本来就忽略这个参数）。
  const fetchFn = !rawFetch ? null
    : transport?.mode === "proxy" ? proxyChatFetch("", shellTokenCache, rawFetch)
    : rawFetch;
  // 一个请求都不发的两种情形：通路还没探完，或通路上根本没有 key
  const needKey = !!transport && !effKey;
  /**
   * 预览 UI（「预览中 → 应用 / 放弃」）**在不在这幅画里**：由 `aiPanelShowsPreview()` 判 ——
   * 它同时要求「面板看得见」与「会话里真的有一轮开着」。所以：
   *   · 最小化成球 / 关窗之后，那一轮已经被卸载钩子放弃掉，预览 UI 不会再出现（t5-f2 的假预览态）；
   *   · 若回合被别处收掉，本地残留的 `pending` 也画不出这套按钮 —— 宁可回落到输入框，
   *     也不留一个点了没反应的「应用」。
   */
  const showPreview = aiPanelShowsPreview(aiChatSettings(), SESSION, pending !== null);
  /** 发给模型的 system 消息：画布摘要 + 用户在设置里补的那句（§3.7.7 的 `ai.chatSystemPrompt`） */
  const sysMsg = (): ChatMessage => systemMessage({ digest: digestText(), extra: cfg.systemPrompt });

  const digestText = (): string => {
    try {
      return JSON.stringify(docDigest(SESSION.doc, { fi: SESSION.curFrame() }));
    } catch {
      return "";   // 摘要只是给模型的上下文，取不到就少给一段，不该拦住对话
    }
  };

  /** destructive 档的逐个确认：复用应用既有的确认框（AI 想删图层 / 清画布时弹出来） */
  const confirmTool = (req: { tool: string; tier: string; summary: string }): Promise<boolean> =>
    SESSION.askConfirm({ msg: t("aiChatConfirm") + "\n" + req.summary, yes: t("ok"), no: t("cancel") });

  const send = async (): Promise<void> => {
    if (busy || pending) return;                       // 上一轮还在跑 / 还没收尾：不叠加
    const text = input.trim();
    if (!text) return;
    if (!native) { setErr(t("aiChatErrNoBridge")); return; }
    if (!cfg.on) { setErr(t("aiChatErrOff")); return; }
    if (!effKey) { setErr(t("aiChatKeyNoneHint")); return; }  // 手填与环境 key 都没有：一个请求都不发
    // 代理模式下 model 可能还没落进设置（用户没填过）：按壳的默认模型走，别报「没填模型」
    const model = cfg.model.trim() || (transport?.mode === "proxy" ? AI_CHAT_DEFAULT_MODEL : "");
    const cfgErr = chatConfigError({ endpoint: effEndpoint, model, key: effKey });
    if (cfgErr) { setErr(cfgErr); return; }
    if (!fetchFn) { setErr(t("aiChatErrOff")); return; }
    const ctx: AiToolCtx = { session: SESSION, confirm: confirmTool, turn: null };
    const messages = [sysMsg(), ...thread, userMessage(text)];
    setEntries((prev) => prev.concat([{ role: "user", text }]));
    setInput("");
    setErr("");
    setLogs([]);
    setBusy(true);
    const r = await runChatTurn({
      messages,
      ctx,
      endpoint: effEndpoint,
      model,
      key: effKey,
      fetchFn,
      commit: false,                                    // 预览模式：回合留给「应用 / 放弃」
      label: text,
      maxRounds: cfg.maxRounds,
      temperature: cfg.temp * AI_CHAT_TEMP_STEP,        // 档位 × 0.1；0 = 不发这个字段
      stream: cfg.stream,
      systemPrompt: cfg.systemPrompt,
      onCall: (log) => { if (live.current) setLogs((prev) => prev.concat([log])); },
    });
    if (!live.current) return;
    setBusy(false);
    if (!r.ok) {
      const why = r.error || t("aiChatFailed");
      setErr(why);
      setEntries((prev) => prev.concat([{ role: "error", text: why }]));
      return;                                           // 文档已经被 rollback 了（ai-chat 保证）
    }
    setThread(r.messages.filter((m) => m.role !== "system"));
    if (r.text) setEntries((prev) => prev.concat([{ role: "assistant", text: r.text }]));
    if (r.turnOpen) {
      const pv = SESSION.previewAiTurn();
      setPending({ calls: r.calls.length, rect: pv.rect, docRev: r.docRev, docRevBefore: r.docRevBefore });
    }
  };

  const apply = (): void => {
    const recorded = SESSION.commitAiTurn();
    setPending(null);
    const note = recorded ? t("aiChatApplied") : t("aiChatAppliedNothing");
    setEntries((prev) => prev.concat([{ role: "note", text: note }]));
    bridge.toast(note);
  };

  const discard = (): void => {
    SESSION.rollbackAiTurn();
    setPending(null);
    // 这一轮忘掉：文档回去了，对话里也把模型的这半轮清掉，只留用户那句话
    const lastUser = [...thread].reverse().find((m) => m.role === "user");
    setThread(lastUser ? [lastUser] : []);
    setLogs([]);
    setEntries((prev) => prev.concat([{ role: "note", text: t("aiChatDiscarded") }]));
  };

  if (!native) {
    // 浏览器 / GitHub Pages：不挂输入框、不连端点（只有一句说明，永远不会「点了没反应」）
    return (
      <div className="col" data-guide="ai-panel">
        <div className="row-note warn" data-guide="ai-no-bridge">{t("aiChatErrNoBridge")}</div>
        {onBack ? <div className="row-actions"><Btn label={t("aiChatBack")} onClick={onBack} /></div> : null}
      </div>
    );
  }

  const rectText = (r: Rect): string => r.w + "×" + r.h + " @ " + r.x + "," + r.y;
  // §3.7.4 的三态：手填 / 本机环境提供 / 没有。**只拼「有无」，key 的值一个字符都不进这段文本**
  // （`aiChatStatusText()` 是唯一生成这行的地方，纯函数、有单测）。
  // 第 4 个参数就是设置项 `ai.protectKey`：它决定要不要附那句「与 key 有关的说明」—— 这是该开关
  // **唯一**的消费者，也是它可测的地方（P15 之前它是个零消费者的惰性开关）。
  const head = aiChatStatusText(
    { endpoint: effEndpoint, model: cfg.model.trim(), key: cfg.key }, hostKey, t, cfg.protectKey);
  // 关掉 protectKey 时那句「已由电脑环境提供」的说明也一并收起：剩下的状态行里已经有来源标记，
  // 用户仍然知道 key 从哪来、也不会误报「没配」。
  const showKeySourceRow = hostKey && !cfg.key.trim() && cfg.protectKey;

  return (
    <div data-guide="ai-panel">
      <div className="row-actions">
        {onBack ? <Btn icon="" label={t("aiChatBack")} onClick={onBack} guide="ai-back" /> : null}
        <span className="row-note" style={{ margin: 0 }}>{head}</span>
      </div>
      {/* 只有环境 key 时：确认「已由电脑环境提供」，既不显示假 key，也不误报「没配」 */}
      {showKeySourceRow
        ? <div className="row-note" data-guide="ai-key-source">{t("aiChatKeyEnvHint")}</div>
        : null}
      {needKey ? <div className="row-note warn" data-guide="ai-no-key">{t("aiChatKeyNoneHint")}</div> : null}
      <div data-guide="ai-thread" className="ai-thread">
        {entries.length === 0 ? <div className="row-note">{t("aiChatSettingsHint")}</div> : null}
        {entries.map((e, i) => (
          <div className="as-row" key={i}>
            <div className="as-main">
              <b>{e.role === "user" ? t("aiChatYou") : e.role === "assistant" ? t("aiChatAssistant") : "·"}</b>
              <span className={e.role === "error" ? "warn" : undefined}>{e.text}</span>
            </div>
          </div>
        ))}
      </div>
      {logs.length ? (
        <div data-guide="ai-calls">
          <div className="rowlabel">{t("aiChatCalls") + "（" + logs.length + "）"}</div>
          {logs.map((log, i) => (
            <div className="as-row" key={i}>
              <div className="as-main">
                <b>{log.ok ? "✓" : "✗"}</b>
                <span>{formatCallLog(log)}</span>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {busy ? <div className="row-note">{t("aiChatThinking")}</div> : null}
      {err ? <div className="row-note warn" data-guide="ai-error">{err}</div> : null}
      {showPreview && pending ? (
        <div data-guide="ai-pending">
          <div className="row-note">
            {pending.rect
              ? t("aiChatPreview").replace("{n}", String(pending.calls)).replace("{rect}", rectText(pending.rect))
              : t("aiChatPreviewEmpty")}
          </div>
          <div className="row-note">
            {t("aiChatDocRev").replace("{from}", String(pending.docRevBefore)).replace("{to}", String(pending.docRev))}
          </div>
          <div className="row-actions">
            <Btn icon="i-check" label={t("aiChatApply")} className="primary" onClick={apply} guide="ai-apply" />
            <Btn icon="i-x" label={t("aiChatDiscard")} danger onClick={discard} guide="ai-discard" />
          </div>
        </div>
      ) : (
        <div className="row-actions">
          <input
            className="textinput"
            value={input}
            placeholder={t("aiChatPlaceholder")}
            data-guide="ai-input"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void send(); }}
          />
          <Btn icon="i-check" label={t("aiChatSend")} className="primary"
            onClick={() => void send()} guide="ai-send" />
        </div>
      )}
      <div className="row-note" data-guide="ai-local-only">{t("aiChatLocalOnly")}</div>
    </div>
  );
}
