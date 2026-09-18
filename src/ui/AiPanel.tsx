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
import { FEATURE_ICONS } from "./feature-icons";
import { isNativeShell } from "../io/bridge";
import * as bridge from "../io/bridge";
import { docDigest } from "../app/ai-doc";
import { pngBytes } from "../io/exporters";
import { bytesToB64 } from "../engine/b64";
import {
  AI_VISION_FIT_ROUNDS, AI_VISION_MAX_EDGE, AI_VISION_MIN_EDGE, clampImageSize, dataUrlOfPng,
  fitEncodedImage, refToRgba, rgbaOfRef, visionBudgetOf, visionGate,
} from "../app/ai-vision";
import {
  AI_CHAT_HOST_KEY_SENTINEL, AI_CHAT_TEMP_STEP, aiChatStatusText, chatConfigError,
  detectChatProxy, formatCallLog, proxyChatFetch, runChatTurn, systemMessage, userMessage,
} from "../app/ai-chat";
import type { ChatCallLog, ChatFetch, ChatFetchResponse, ChatMessage } from "../app/ai-chat";
import type { AiToolCtx } from "../app/ai-tools";
import type { AiTurnStepPreview } from "../app/ai-turn";
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
  /**
   * 模型这一轮的思考过程（`delta.reasoning_content` 的累积）。
   * 显示成**默认折叠**的「思考过程」块（点开 / 收起）—— 它是**辅助信息**，不该抢正文的位置。
   */
  reasoning?: string;
  /** 这一行还在流式长（用来画「流式输出中…」那个标记） */
  live?: boolean;
}

/** 预览还没收尾的那一轮 */
interface AiPending {
  calls: number;
  rect: Rect | null;
  docRev: number;
  docRevBefore: number;
  /** 按步撤回的现状（`SESSION.previewAiTurn().steps`；面板撤回之后就靠它重画） */
  steps: AiTurnStepPreview | null;
}

/**
 * **挂给这一轮的一张参考图**（契约 §5 的附件条要显示的全部信息）。
 *
 * 只留**编码后的 data URL**，不留原始 RGBA：图已经编好了，发送时直接用；
 * 再留一份原始像素只是白占内存（12 MB 的参考图就是 12 MB）。
 * 缩略图也不另外存一份 —— `<img src>` 直接用这个 data URL（浏览器自己缓存解码结果）。
 */
export interface AiAttachment {
  /** `data:image/png;base64,……`（发给模型的就是这一串） */
  dataUrl: string;
  /** 编码后的 PNG 字节数（**不是** base64 长度；界面按 KiB 显示） */
  bytes: number;
  /** 实际编码时的宽度（可能已经被尺寸夹取缩过） */
  w: number;
  /** 实际编码时的高度 */
  h: number;
  /** 原始宽（与 `w` 不同时界面要写「2048×2048 → 768×768」） */
  srcW: number;
  /** 原始高 */
  srcH: number;
  /** 来源文件名 / 参考图原名（可为空） */
  name: string;
  /** 来自哪一路（文案不同：一条是「用当前参考图」，一条是「选择图片文件」） */
  from: "ref" | "file";
  /** 给模型看的一句说明（尺寸缩放 / 体积），拼进文本块，可为空 */
  note: string;
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
  /** **这一轮撤回过**（B1：留一行说明，且语义上不再放行输入 —— 见 `aiPanelShowsPreview` 的备注） */
  reverted: boolean;
  /**
   * 当前挂着的参考图（契约 §5：**发送后保留**，只有用户点移除才清）。
   *
   * 为什么放在**跨卸载的存储**里而不是组件本地 `useState`：浮窗「最小化」是真的卸载 DOM
   * （见本文件顶部的三条口径），放本地状态就会「最小化一下图就没了」——
   * 与「对话不跟着丢」这条既有行为不一致。卸载钩子只收**回合**（`aiPanelDropsTurnOnUnmount`），
   * 不碰附件，所以最小化 → 还原之后附件还在，与用户的预期一致。
   */
  attach: AiAttachment | null;
}

/** 进程内单例：`AiPanel` 每次挂载都读写它（所以卸载不丢对话） */
export const aiWinStore: AiWinStore = {
  thread: [], entries: [], pending: null, logs: [], input: "", reverted: false, attach: null,
};

/**
 * **撤回过之后还能不能再让模型接着跑**：不能（`docs/API.md` §23.4 写死了这条语义）。
 *
 * 理由：撤回把文档恢复到第 n 步之前，但消息线程里**还留着**被撤掉那些步骤的 tool 结果 ——
 * 模型会以为它画在 A 上的东西还在，继续基于一份**不存在的过去**推理。所以撤回之后
 * 这一轮只剩两个结局：「应用当前状态」或「放弃整轮」（纯函数，可单测）。
 */
export function aiPanelAllowsSend(hasPending: boolean, reverted: boolean): boolean {
  return !hasPending && !reverted;
}

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
  aiWinStore.reverted = false;
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
const scratchStore: AiWinStore = {
  thread: [], entries: [], pending: null, logs: [], input: "", reverted: false, attach: null,
};

// ============================================================================================
// ③b 参考图 → data URL（**页面侧只做 canvas + 编码**，一切算术都在 `src/app/ai-vision.ts`）
//
// 这一小段是把纯函数接到真浏览器上的那几行，也是唯一 import DOM 的地方：
//   `putImageData`（把直通 RGBA 放进画布）→ `pngBytes()`（**仓库既有的 PNG 编码**，
//   `src/io/exporters.ts`）→ `bytesToB64()`（**仓库既有的 base64**，`src/engine/b64.ts`）
//   → `dataUrlOfPng()`（拼前缀）。
//
// 体积不达标时**缩一轮再编一轮**（`fitEncodedImage()` 用**真实字节数**反推下一档尺寸）：
// 为什么不是「先估好尺寸一次编成」—— PNG 的体积与内容强相关（纯色几 KB、噪点图几百 KB），
// 任何事前估算都会在某一头失准；以真数为准则每一轮都收敛。
// ============================================================================================

/** 编码一张直通 RGBA（尺寸已经由 `clampImage()` 定好）→ PNG data URL 与字节数 */
async function encodeRgba(px: Uint8ClampedArray, w: number, h: number): Promise<{ dataUrl: string; bytes: number } | null> {
  try {
    const cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.round(w));
    cv.height = Math.max(1, Math.round(h));
    const ctx = cv.getContext("2d");
    if (!ctx) return null;
    const id = new ImageData(cv.width, cv.height);
    id.data.set(px.subarray ? px.subarray(0, cv.width * cv.height * 4) : px);
    ctx.putImageData(id, 0, 0);
    const bytes = await pngBytes(cv);
    if (!bytes || !bytes.length) return null;
    return { dataUrl: dataUrlOfPng(bytesToB64(bytes)), bytes: bytes.length };
  } catch {
    return null;   // 编码失败（画布建不出来 / toBlob 回 null）：交给调用方说一句人话
  }
}

/**
 * 把一张参考图（或用户选的文件解出来的像素）夹到能发的尺寸与体积，返回附件。
 *
 * 对**端到端脚本**也是入口：契约 §6.3 要求「经真壳 + 无头浏览器发一条带图消息」，
 * 而参考图在页面里只能靠 `SESSION.refImg` 摆好、再点按钮；脚本需要在**同一台机器**上
 * 造一张确定性的图，所以这个函数是 `export` 的（探测包把它挂到 `globalThis`，
 * 走的是与按钮**完全相同**的编码路径）。
 *
 * @param img   直通 RGBA 的源（参考图走 `SESSION.refImg`，文件走 `<img>` 解码后的画布）
 * @param name  来源名（文件用 `file.name`，参考图用 `SESSION.refImg.name`）
 * @param from  哪一路进来的（只影响文案）
 * @returns 附件；`error` 非空 = 这张图**发不出去**（中文原因，调用方必须显示出来）
 */
export async function encodeAttachment(
  img: { w: number; h: number; px: Uint8ClampedArray },
  name: string,
  from: "ref" | "file",
  /** 只给探测脚本用：每轮「尺寸 + 真实字节数」的轨迹（默认不收集，不分配） */
  trace?: Array<{ w: number; h: number; bytes: number }>,
): Promise<{ attach?: AiAttachment; error?: string }> {
  const srcW = Math.max(0, Math.round(Number(img?.w) || 0));
  const srcH = Math.max(0, Math.round(Number(img?.h) || 0));
  if (srcW <= 0 || srcH <= 0 || !img?.px || !img.px.length) return { error: "这张图没有像素可读（可能是空文件或格式不认识）" };
  const source = { w: srcW, h: srcH, px: img.px };
  // 第一档 = 尺寸夹取（只缩不放，整数倍走最近邻）；之后每轮按**上一轮的真实字节数**定的 `next` 重编。
  // 每一轮都从**原图**重采样（不是拿上一轮的输出再缩）：反复缩一张已经缩过的图会累积模糊。
  //
  // 内存口径（一张 4000×3000 ≈ 48 MB 的 RGBA 源，缩图循环最多 6 轮）：
  //   · 循环里**只调一次** `refToRgba()` —— 它内部会拷一份再缩（`resamplePixels()` 只读源，
  //     但「绝不改调用方的缓冲区」这条口径是 `rgbaOfRef()` 的职责，不能省）；
  //   · 第一轮够小（`scale === 1`）时**直接用调用方的缓冲区**（不再拷一份），于是
  //     「小图直接发」这条最常走的路是零额外拷贝。`encodeAttachment()` 的入参是临时的
  //     （参考图那条走 `rgbaOfRef()` 明确拷贝，文件那条本来就是新解出来的），
  //     而 `putImageData()` 只读它 —— 所以这里不拷贝是安全的。
  let edge = AI_VISION_MAX_EDGE;
  for (let round = 0; ; round++) {
    const size = clampImageSize(srcW, srcH, edge);
    const px = size.scale === 1 ? source.px : refToRgba(source, edge).px;
    const enc = await encodeRgba(px, size.w, size.h);
    if (!enc) return { error: "这张图编码不出来（本机浏览器没能生成 PNG）——换一张试试" };
    if (trace) trace.push({ w: size.w, h: size.h, bytes: enc.bytes });
    const fit = fitEncodedImage(enc.bytes, size, { round });
    if (fit.ok) {
      const shrinkNote = size.w !== srcW || size.h !== srcH
        ? "参考图已从 " + srcW + "×" + srcH + " 缩到 " + size.w + "×" + size.h + "（最长边上限 768px，只缩不放）"
        : "";
      const budget = visionBudgetOf(enc.bytes);
      const bigNote = budget.overSoft ? "（体积偏大：" + Math.round(budget.dataUrlBytes / 1024) + " KiB）" : "";
      return {
        attach: {
          dataUrl: enc.dataUrl, bytes: enc.bytes, w: size.w, h: size.h, srcW, srcH,
          name: String(name ?? ""), from, note: shrinkNote + bigNote,
        },
      };
    }
    if (!fit.next) return { error: fit.reason || "这张图太大，发不出去" };
    edge = Math.max(AI_VISION_MIN_EDGE, Math.max(fit.next.w, fit.next.h));
    if (round + 1 >= AI_VISION_FIT_ROUNDS) return { error: fit.reason || "这张图太大，发不出去" };
  }
}

/**
 * **「用当前参考图」**：把 `SESSION.refImg`（索引库里的参考图）编成附件。
 * 没有参考图时给一句中文说明（不是静默什么都不做）。
 */
async function attachmentFromRef(): Promise<{ attach?: AiAttachment; error?: string }> {
  const ref = SESSION.refImg;
  if (!ref) return { error: "现在没有参考图：先用「导入参考图」放一张，或直接「选择图片文件」" };
  return encodeAttachment({ w: ref.w, h: ref.h, px: rgbaOfRef(ref) }, ref.name || "参考图", "ref");
}

/**
 * **「选择图片文件」**：`<input type="file">` → 解码成像素 → 走与参考图**同一条**编码路径。
 *
 * 为什么用 `createObjectURL` + `<img>` 解码而不是 `createImageBitmap()`：后者在
 * 老 WebView / 部分桌面壳里没有，而 `<img>` + `drawImage` 是这套代码（`io/bridge.ts`
 * 的导入、`ui/paste.ts`）用了很久的路径，行为有既有回归兜着。`finally` 里撤销 URL，
 * 不留悬空的 blob。
 */
async function attachmentFromFile(file: File): Promise<{ attach?: AiAttachment; error?: string }> {
  const url = URL.createObjectURL(file);
  try {
    const el = new Image();
    await new Promise<void>((res, rej) => {
      el.onload = () => res();
      el.onerror = () => rej(new Error("decode"));
      el.src = url;
    });
    const w = Math.max(1, el.naturalWidth || el.width);
    const h = Math.max(1, el.naturalHeight || el.height);
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d");
    if (!ctx) return { error: "本机浏览器读不了这张图（画布不可用）" };
    ctx.drawImage(el, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    return await encodeAttachment({ w, h, px: data }, file.name, "file");
  } catch {
    return { error: "这张图片文件解不开（可能是损坏的文件，或不是 PNG / JPEG / WebP / GIF）" };
  } finally {
    try { URL.revokeObjectURL(url); } catch { /* 撤销失败不算错 */ }
  }
}

/** 附件条上的一行体积文本（`KiB`；与错误文案里的单位一致，别一处 KiB 一处 KB） */
function attachSizeText(a: AiAttachment): string {
  return String(Math.max(1, Math.round(a.bytes / 1024))) + " KiB";
}

/**
 * 浏览器 / APK / 桌面壳的 fetch 都满足 `ChatFetch`；没有 fetch 的运行环境返回 null。
 *
 * **流式挂在这一层**（`ai-chat.ts` 保持平台无关：不 import DOM 类型、不直接调 fetch）：
 * 把 `res.body`（Web Streams 的 `ReadableStream`）包成 `ChatFetchResponse.chunks()` 那个
 * `AsyncIterable<string>`，只负责**解码**，切分与累积由 `ai-chat` 的 `consumeSseStream()` 做。
 *
 * 三条边界：
 *   · `body` 不存在（204 / 老宿主）→ **不挂 `chunks`**：`ai-chat` 据此走整包（自动降级那条路）；
 *   · `body` 既不是异步可迭代、也没有 `getReader` → 同上（宁可降级，也不要一个坏掉的回答）；
 *   · 迭代被提前打断（超时 / 回合失败）→ `finally` 里 `cancel()`/`releaseLock()`，
 *     别把上游连接吊在那儿。
 */
function platformFetch(): ChatFetch | null {
  if (typeof fetch !== "function") return null;
  // `ChatFetchInit` 与 `RequestInit` 结构一致，只有 `signal` 一个是**故意写成 `unknown`** 的
  // （`ai-chat.ts` 要保持平台无关、不 import DOM 类型），所以在平台边界这一次转换是准确的。
  return async (url, init) => {
    const res = await fetch(url, init as RequestInit);
    const body = res.body as (ReadableStream<Uint8Array> & { getReader?: unknown }) | null | undefined;
    if (!body) return res as unknown as ChatFetchResponse;
    const dec = new TextDecoder();
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    /** 收尾：**正常读完也走它**（`finally`）—— 提前中断（超时 / 回合失败）时顺带取消上游 */
    const finish = (): void => {
      const r = reader;
      reader = null;
      if (r) {
        try { void r.cancel().catch(() => { /* 已经关了 / 已读完 */ }); } catch { /* 已经关了 */ }
      }
    };
    const raw = body as unknown as AsyncIterable<Uint8Array>;
    const holder: { chunks?: () => AsyncIterable<string> } = {};
    if (typeof (raw as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function") {
      holder.chunks = async function* (): AsyncIterable<string> {
        try {
          for await (const part of raw) yield dec.decode(part, { stream: true });
          const tail = dec.decode();
          if (tail) yield tail;
        } finally {
          finish();
        }
      };
    } else if (typeof body.getReader === "function") {
      reader = body.getReader();
      holder.chunks = async function* (): AsyncIterable<string> {
        try {
          for (;;) {
            const step = await reader!.read();
            if (step.done) break;
            if (step.value) yield dec.decode(step.value, { stream: true });
          }
          const tail = dec.decode();
          if (tail) yield tail;
        } finally {
          finish();
        }
      };
    } else {
      return res as unknown as ChatFetchResponse;
    }
    // 一个**薄**包装：`text()` 原样转发（错误体那条路要用原文），`ok` / `status` 原样读，
    // 只有流式时多一个 `chunks()`。`res` 上的 `headers` 也一并透出去 ——
    // `ai-chat` 的 `isEventStream()` 要拿 `content-type` 判断「这到底是不是 SSE」。
    return {
      ok: res.ok,
      status: res.status,
      headers: res.headers,
      text: () => res.text(),
      chunks: holder.chunks,
    } as unknown as ChatFetchResponse;
  };
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
  /** 这一轮撤回过（B2）：留一行说明，且不再放行输入（见 `aiPanelAllowsSend`） */
  const [reverted, setReverted] = useState(() => st.reverted === true);
  /**
   * 当前挂着的参考图（契约 §5）：跨卸载保留（见 `AiWinStore.attach` 的注释）。
   * **发送后保留** —— 只有用户点附件条上的「移除」才清，这样「换个说法再问一遍同一张图」
   * 不用重新挂一次。
   */
  const [attach, setAttach] = useState<AiAttachment | null>(() => st.attach);
  /** 正在编码 / 解码那张图（读文件是异步的，期间按钮要禁用，免得连点挂两张） */
  const [attaching, setAttaching] = useState(false);
  /** `<input type="file">` 的 ref（隐藏起来，由「选择图片文件」按钮代点） */
  const fileRef = useRef<HTMLInputElement | null>(null);
  // 通路（直连 / 同源代理）：null = 还没探完（探完才决定 key 从哪来）
  const [transport, setTransport] = useState<typeof transportCache>(() => transportCache);
  // 流式那一行的状态：`live` = 正在流式（画「流式输出中…」），`fallback` = 降级的说明（一定要给用户看）
  const [streamFlag, setStreamFlag] = useState<{ live: boolean; fallback: string }>({ live: false, fallback: "" });
  const live = useRef(true);
  /**
   * 流式增量的目标行下标（`entries` 的最后一行）。用 ref 而不是从 state 反推：
   * 增量回调可能在**同一次 `send()` 里连着来几十次**，从 state 里找会读到旧值、把自增写坏。
   */
  const streamRow = useRef(-1);
  /**
   * `entries` 的**同步长度镜像**：React 的 `setEntries(fn)` 不保证立刻跑 `fn`，
   * 所以「流式那一行是第几条」不能靠 state 反推（增量可能连着来几十次）。
   * 每次 `setEntries` 都同步维护它，行下标当场就能定下来。
   */
  const entriesLen = useRef(st.entries.length);

  /** 任何一项变化都同步进存储（卸载时不丢）；四处状态一起走这里，别各写一份 */
  useEffect(() => {
    st.thread = thread; st.entries = entries; st.pending = pending;
    st.logs = logs; st.input = input; st.reverted = reverted; st.attach = attach;
    // 行数镜像（见 `entriesLen` 的注释）：一次渲染里补平，下一批增量就有准数了
    entriesLen.current = entries.length;
  }, [st, thread, entries, pending, logs, input, reverted, attach]);

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

  /**
   * 挂图的两个入口共用这一段收尾：编码中禁用按钮 → 成功就换上、失败就说一句中文。
   *
   * **失败一定说出来**（`setErr`）：体积超限、格式不认、没有参考图，都是用户需要知道的事，
   * 静默什么都不做就是最糟的那种「点了没反应」。
   */
  const runAttach = async (job: () => Promise<{ attach?: AiAttachment; error?: string }>): Promise<void> => {
    if (attaching) return;
    setAttaching(true);
    setErr("");
    try {
      const r = await job();
      if (!live.current) return;
      if (r.attach) setAttach(r.attach);
      else if (r.error) setErr(r.error);
    } catch (e) {
      if (live.current) setErr(String((e as Error)?.message ?? e));
    } finally {
      if (live.current) setAttaching(false);
    }
  };
  /** 「用当前参考图」：取会话里那张参考图（`SESSION.refImg`），走同一条编码路径 */
  const useRefImage = (): void => { void runAttach(attachmentFromRef); };
  /** 「选择图片文件」：交给隐藏的 `<input type="file">`，选到之后在 `onChange` 里解码 */
  const pickFile = (): void => {
    if (attaching) return;
    const el = fileRef.current;
    if (!el) return;
    el.value = "";                 // 清掉上一次的选择：否则「再选同一个文件」不会触发 change
    el.click();
  };

  /** 挂图 + 模型不支持视觉 → 发送前的**本地预览判定**（点发送就报，不等一整轮跑完） */
  const attachGate = attach && cfg.model.trim() ? visionGate(cfg.model.trim(), true) : null;
  const attachWarn = attachGate && !attachGate.allow ? (attachGate.reason || t("aiChatVisionNo"))
    : attachGate && attachGate.note ? attachGate.note : "";

  const send = async (): Promise<void> => {
    // 撤回过的一轮**不许再让模型接着跑**（文档与消息线程已经不一致，见 §23.4 与 `aiPanelAllowsSend`）
    if (busy || pending || reverted) return;           // 上一轮还在跑 / 还没收尾 / 已撤回过：不叠加
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
    // 挂图 + 模型不支持视觉：**发送前拦下**（`ai-chat.runChatTurn()` 里还有同一道闸，
    // 那里是硬口径 —— 这里只是为了在点发送的那一刻就把中文提示显示出来，不用等一整轮）。
    if (attach) {
      const gate = visionGate(model, true);
      if (!gate.allow) { setErr(gate.reason || t("aiChatVisionNo")); return; }
    }
    const ctx: AiToolCtx = { session: SESSION, confirm: confirmTool, turn: null };
    const messages = [sysMsg(), ...thread, userMessage(text)];
    setEntries((prev) => prev.concat([{ role: "user", text }]));
    setInput("");
    setErr("");
    setLogs([]);
    setReverted(false);
    setStreamFlag({ live: false, fallback: "" });
    // 流式落点的行下标：此刻 `entries` 的最后一条刚推入的是用户那句话，
    // 增量来时（`onText`）再推一条 assistant 预览行并把下标记下来。
    streamRow.current = -1;
    setBusy(true);
    /**
     * 流式增量：**只改显示**（那一行的正文 / 思考过程），回合与历史一个字节都没碰。
     * `thinking` 只写进行对象，`text` 变了才重建 —— 免得每次 reasoning 增量都白重渲染一遍正文。
     */
    const onDelta = (kind: "text" | "reasoning", value: string): void => {
      if (!live.current) return;
      const i = streamRow.current;
      if (i < 0) {
        const row: AiEntry = { role: "assistant", text: kind === "text" ? value : "", live: true };
        if (kind === "reasoning") row.reasoning = value;
        streamRow.current = entriesLen.current;
        entriesLen.current += 1;
        setEntries((prev) => prev.concat([row]));
        return;
      }
      setEntries((prev) => prev.map((e, j) => (
        j !== i ? e : (kind === "text" ? { ...e, text: value, live: true } : { ...e, reasoning: value, live: true })
      )));
    };
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
      thinking: cfg.thinking,                           // 思考强度（default = 一个思考字段都不发）
      timeoutMs: cfg.timeoutSec * 1000,                 // 秒 → 毫秒；壳的上游腿与直连兜底都按它等
      stream: cfg.stream,
      systemPrompt: cfg.systemPrompt,
      // 挂图：图是**编好的 data URL**（`ai-vision.ts` + `b64.ts` 在本文件上半段产出），
      // `ai-chat` 把它并进最后一条 user 消息（文本块先、图块后），并再走一次能力门控。
      // 没有附件时这两个字段是空串 → 请求体逐字节与从前相同（`content` 仍是纯字符串）。
      imageDataUrl: attach ? attach.dataUrl : "",
      imageNote: attach ? attach.note : "",
      onCall: (log) => { if (live.current) setLogs((prev) => prev.concat([log])); },
      onText: (v) => onDelta("text", v),
      onReasoning: (v) => onDelta("reasoning", v),
    });
    if (!live.current) return;
    setBusy(false);
    // 这一轮到底流式了没有：让用户看见一行说明（尤其是**降级**时的具体原因）
    setStreamFlag({ live: false, fallback: r.streamNote.fellBack ? (r.streamNote.reason || "") : "" });
    if (!r.ok) {
      const why = r.error || t("aiChatFailed");
      setErr(why);
      setEntries((prev) => prev.concat([{ role: "error", text: why }]));
      return;                                           // 文档已经被 rollback 了（ai-chat 保证）
    }
    setThread(r.messages.filter((m) => m.role !== "system"));
    // 正文以**收尾后的完整文本**为准：把流式那一行的 `live` 标记摘掉并补齐（工具调用轮里的中间文本
    // 本来就不显示，所以这里只更新最后那条 assistant 行，不新推一条）。
    const rc = r.messages.filter((m) => m.role === "assistant").map((m) => m.reasoning_content ?? "").join("");
    const rowIdx = streamRow.current;
    if (r.text) {
      setEntries((prev) => {
        const next = prev.slice();
        if (rowIdx >= 0 && rowIdx < next.length && next[rowIdx].role === "assistant") {
          next[rowIdx] = { ...next[rowIdx], text: r.text, live: false, ...(rc ? { reasoning: rc } : {}) };
          return next;
        }
        return next.concat([{ role: "assistant", text: r.text, live: false, ...(rc ? { reasoning: rc } : {}) }]);
      });
    } else if (rc && rowIdx >= 0) {
      // 只有思考过程、没有正文（例如模型直接调工具）：那一行也别留着「流式中」的标记
      setEntries((prev) => prev.map((e, j) => (j === rowIdx ? { ...e, reasoning: rc, live: false } : e)));
    }
    if (r.turnOpen) {
      const pv = SESSION.previewAiTurn();
      setPending({ calls: r.calls.length, rect: pv.rect, docRev: pv.docRev, docRevBefore: r.docRevBefore, steps: pv.steps });
    }
  };

  /**
   * **按步撤回**（B2）：撤回第 `n` 步 → 文档回到它执行之前，它和它之后的步骤一并作废。
   *
   * 三条不许动的口径（`docs/API.md` §23.4）：
   *   · 回合**仍然开着**（还是预览态），所以这里只重画预览，不动历史、不动 thread；
   *   · 预览里的 `docRev` / `changed` / 每一步的 `changed` 一律取自 `SESSION.previewAiTurn()`
   *     （**撤回后的实况**），不在面板里自己算；
   *   · 撤回之后**不再放行输入**（`reverted`），理由见 `aiPanelAllowsSend()`。
   */
  const revertStep = (n: number): void => {
    if (!SESSION.revertAiTurnStep(n)) return;   // 越界 / 已经作废过 / 本回合不支持：什么都不做
    const pv = SESSION.previewAiTurn();
    setPending((prev) => (prev ? { ...prev, rect: pv.rect, docRev: pv.docRev, steps: pv.steps } : prev));
    // 调用记录里也标一下（`ChatCallLog.reverted`）：按 `index` 对上，`index` 就是撤回用的 n
    const gone = new Set((pv.steps?.steps ?? []).filter((s) => s.reverted).map((s) => s.index));
    setLogs((prev) => prev.map((l) => (gone.has(l.index) ? { ...l, reverted: true } : l)));
    setReverted(true);
    const note = t("aiChatStepReverted").replace("{n}", String(n));
    setEntries((prev) => prev.concat([{ role: "note", text: note }]));
  };

  const apply = (): void => {
    const recorded = SESSION.commitAiTurn();
    setPending(null);
    setReverted(false);
    // 这一轮已经落定：步骤表随回合一起消失（`previewAiTurn().steps` 变成 null），
    // 记录里那份「已撤回」的标记也一起清掉 —— 历史里落的是**撤回后的当前状态**那一条。
    // （用解构而不是 `reverted: undefined`：`exactOptionalPropertyTypes` 现在是关的，
    //   但留一个显式的 `undefined` 字段会让 `JSON.stringify` 之类的地方多一个键。）
    setLogs((prev) => prev.map(({ reverted: _was, ...rest }) => rest));
    const note = recorded ? t("aiChatApplied") : t("aiChatAppliedNothing");
    setEntries((prev) => prev.concat([{ role: "note", text: note }]));
    bridge.toast(note);
  };

  const discard = (): void => {
    SESSION.rollbackAiTurn();
    setPending(null);
    setReverted(false);
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
              {e.live ? <span className="as-why" data-guide="ai-stream">{t("aiChatStreaming")}</span> : null}
            </div>
            {/* 思考过程：**单独一块、默认折叠**（`<details>` 不带 `open`）—— 它不该抢正文的位置，
                但流式期间必须看得见它在长（`summary` 上的字数会跟着涨）。 */}
            {e.reasoning ? (
              <details className="ai-reason" data-guide="ai-reasoning">
                <summary>{t("aiChatReasoning") + "（" + e.reasoning.length + "）"}</summary>
                <div className="ai-reason-body">{e.reasoning}</div>
              </details>
            ) : null}
          </div>
        ))}
      </div>
      {logs.length ? (
        <div data-guide="ai-calls">
          <div className="rowlabel">{t("aiChatCalls") + "（" + logs.length + "）"}</div>
          {/*
            调用记录（B1）：每条**一行摘要**（第几步 / 工具 / 耗时 / ok·失败 / 改动），
            点开看详情（参数、结果、docRev 变化、警告）；右侧是**按步撤回**（B2）。
            「步骤号」直接取 `log.index` —— 它就是 `SESSION.revertAiTurnStep(n)` 的 n
            （ai-turn 的步骤表与 ai-chat 的 `calls` 一一对应，见 `ChatCallLog.index`）。
          */}
          {logs.map((log, i) => {
            const step = pending?.steps?.steps.find((s) => s.index === log.index) ?? null;
            // 撤回之后一切都以 Session 的实况为准（本地 `log.reverted` 只是那一瞬间的快照）
            const isReverted = step ? step.reverted : log.reverted === true;
            // 撤回之后一切都以 Session 的实况为准（本地 `log.reverted` 只是那一瞬间的快照）
            const changed = isReverted ? null : (step ? step.changed : log.changed);
            // 「还能撤回」的判据 = 这一步**还活着**。Session 那边只给活步骤返回非 null 的 `changed`
            // （作废的整段都返回 null），所以这一个条件同时管住两件事：
            //   · 已经作废的步骤没有按钮（撤过之后再点第 2 步 = 那儿已经没有按钮）；
            //   · 真改了像素的活步骤才有按钮（没改像素的步骤本来就无从「撤回」）。
            // 再叠一道 `revert.ok`（整轮禁用时所有步骤都没有按钮）。
            const canRevert = !!pending?.steps?.revert.ok && changed !== null && changed !== undefined;
            return (
              <div className={"as-row ai-call-row" + (isReverted ? " reverted" : "")} key={i} data-guide="ai-call">
                <details className="ai-call" style={{ flex: "1 1 150px", minWidth: 0 }}>
                  <summary className="ai-call-head" data-guide="ai-call-summary" title={t("aiChatStepDetail")}>
                    <b>{t("aiChatStepNo").replace("{n}", String(log.index))}</b>
                    <span>{log.name}</span>
                    <span className="as-why">{t("aiChatStepMs").replace("{ms}", String(log.durationMs))}</span>
                    <span className={log.ok ? undefined : "warn"}>{log.ok ? t("aiChatStepOk") : t("aiChatStepFail")}</span>
                    {changed ? <span>{"改动 " + changed.w + "×" + changed.h}</span> : null}
                    {isReverted ? <span className="as-why">{"· " + t("aiChatStepRevert")}</span> : null}
                  </summary>
                  <div className="ai-call-body">
                    <div>{t("aiChatStepArgs").replace("{v}", log.argsText || t("aiChatStepNoArgs"))}</div>
                    <div>{t("aiChatStepResult").replace("{v}", formatCallLog(log))}</div>
                    {log.rawArgs ? <div className="as-why">{t("aiChatStepRaw").replace("{v}", log.rawArgs)}</div> : null}
                    <div className={"ai-call-rev" + (log.revDelta > 0 ? " grew" : "")}>
                      {t("aiChatDocRev").replace("{from}", String(log.docRevBefore)).replace("{to}", String(log.docRevAfter))}
                    </div>
                    {log.warn && log.warn.length
                      ? <div className="warn">{t("aiChatStepWarn").replace("{v}", log.warn.join("；"))}</div>
                      : null}
                  </div>
                </details>
                {canRevert ? (
                  <div className="row-actions as-acts">
                    <Btn icon="i-undo" label={t("aiChatStepRevert")} onClick={() => revertStep(log.index)}
                      guide="ai-step-revert" />
                  </div>
                ) : null}
              </div>
            );
          })}
          {/* 按步撤回在本回合不可用（跨画布 / 太大）：**明确说出来**，别让用户找那个不存在的按钮 */}
          {pending && pending.steps && !pending.steps.revert.ok ? (
            <div className="row-note warn" data-guide="ai-step-off">
              {t("aiChatStepOff").replace("{why}", pending.steps.revert.reason || "")}
            </div>
          ) : null}
          {pending && pending.steps && pending.steps.revert.ok && pending.steps.steps.length ? (
            <div className="row-note" data-guide="ai-step-budget">
              {t("aiChatStepBudget").replace("{used}", String(Math.round(pending.steps.revert.usedBytes / 1024)))
                .replace("{budget}", String(Math.round(pending.steps.revert.budgetBytes / 1024)))}
            </div>
          ) : null}
        </div>
      ) : null}
      {busy ? <div className="row-note">{t("aiChatThinking")}</div> : null}
      {/* 流式降级的说明：**一定要给用户看**（否则「说好的流式怎么没动」就成了谜） */}
      {streamFlag.fallback
        ? <div className="row-note" data-guide="ai-stream-fallback">{t("aiChatStreamFallback").replace("{why}", streamFlag.fallback)}</div>
        : null}
      {err ? <div className="row-note warn" data-guide="ai-error">{err}</div> : null}
      {/*
        参考图附件条（契约 §5）：缩略图 + 宽×高 + 编码体积 + 移除按钮，外加两个挂图入口。
        **它在输入框上方、并且与输入框的可用性无关** —— 输入被锁住（还有一轮没收尾 / 撤回过）
        的时候用户仍然能看出「图还挂着」，也能先把它移除。
        挂图 + 模型不支持视觉时，`attachWarn` 就是那句「该换哪个模型」的中文提示（点发送之前就看得见）。
      */}
      <div className="ai-attach" data-guide="ai-attach">
        {attach ? (
          <div className="ai-attach-row" data-guide="ai-attach-row">
            <img className="ai-attach-thumb" src={attach.dataUrl} alt="" data-guide="ai-attach-thumb" />
            <div className="ai-attach-meta">
              <div className="ai-attach-line" data-guide="ai-attach-info">
                {attach.srcW !== attach.w || attach.srcH !== attach.h
                  ? attach.srcW + "×" + attach.srcH + " → " + attach.w + "×" + attach.h
                  : attach.w + "×" + attach.h}
                {" · " + attachSizeText(attach)}
                {attach.name ? " · " + attach.name : ""}
              </div>
              <div className="as-why" data-guide="ai-attach-from">
                {attach.from === "ref" ? t("aiChatAttachFromRef") : t("aiChatAttachFromFile")}
              </div>
            </div>
            <button type="button" className="ai-attach-x" data-guide="ai-attach-remove"
              title={t("aiChatAttachRemove")} aria-label={t("aiChatAttachRemove")}
              onClick={() => { setAttach(null); setErr(""); }}>
              <Icon id="i-x" size={12} />
            </button>
          </div>
        ) : null}
        <div className="row-actions">
          {/* 两个挂图入口**并排**，图标必须能分清：`i-ref`（参考图）与 `i-import`（导入文件），
              登记在 `FEATURE_ICONS.aiAttach`（见那里的注释：为什么可以复用这两个既有图标）。 */}
          <Btn icon={FEATURE_ICONS.aiAttach.ref} label={t("aiChatAttachRef")} onClick={useRefImage} guide="ai-attach-ref" />
          <Btn icon={FEATURE_ICONS.aiAttach.file} label={t("aiChatAttachFile")} onClick={pickFile} guide="ai-attach-file" />
          {attaching ? <span className="as-why" data-guide="ai-attach-busy">{t("aiChatAttachBusy")}</span> : null}
        </div>
        {/*
          隐藏的文件选择器。`accept` 按契约 §5 写死四种格式（**官方图像理解支持的那四种**）；
          真正的格式判定不看文件名与 MIME —— 我们解成像素之后一律编成 PNG 发出去，
          所以「格式按内容判」这条天然成立（契约 §1）。
        */}
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          data-guide="ai-attach-input"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files && e.target.files[0];
            if (f) void runAttach(() => attachmentFromFile(f));
          }}
        />
        {attachWarn
          ? <div className="row-note warn" data-guide="ai-attach-warn">{attachWarn}</div>
          : null}
      </div>
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
      ) : !aiPanelAllowsSend(pending !== null, reverted) ? (
        // 撤回过 / 还有一轮没收尾：语义上**不再放行输入**（见 `aiPanelAllowsSend()` 与 §23.4）。
        // 这里给的是输入框本身（disabled）+ 一句「为什么」，而不是干脆不画 ——
        // 用户看得见「这一轮要怎么收尾」，不会以为面板坏了。`send()` 自己也有同一道闸
        // （`if (busy || pending) return` 之外还有 `reverted`），所以这里就算被触发也发不出去。
        <div data-guide="ai-step-locked">
          <div className="row-actions">
            <input className="textinput" value={input} disabled placeholder={t("aiChatStepRevert")}
              data-guide="ai-input-locked" onChange={() => { /* disabled：这里不会触发 */ }} />
            <Btn icon="i-check" label={t("aiChatSend")} className="primary"
              onClick={() => void send()} guide="ai-send-locked" />
          </div>
          {reverted ? <div className="row-note warn" data-guide="ai-step-reverted">{t("aiChatStepRevertedNote")}</div> : null}
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
