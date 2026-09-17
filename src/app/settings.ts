// Godot-style settings registry.
//
// Every user-facing setting is declared exactly ONCE here: a dotted path
// (Godot's "category/subcategory/name" style), its type, default, range,
// group, i18n labels, visibility condition, refresh policy and optional
// custom getter/setter/side effect. The settings dialog is generated from
// this table, so adding a setting means adding one entry plus its strings —
// no UI plumbing, no new session setter, no extra localStorage key.
import type { Prefs, Session } from "./session";
import { GESTURES, GESTURE_ACTIONS, gesturePath } from "./gestures";
import * as bridge from "../io/bridge";
import { applySafeArea } from "../io/safearea";
import { applyTheme } from "../io/theme";
import { applyPcMode, pcModeOf, pcModeOn } from "../io/pcmode";
import { AUTOSAVE_KEEP_DEFAULT, AUTOSAVE_KEEP_MAX } from "../io/autosave";
import { AI_RPC_DEFAULT_PORT, AI_RPC_DEFAULT_TIER, AI_SERVICE_TIERS, AI_TURN_IDLE_SEC_DEFAULT } from "./ai-rpc";
import type { AiServiceTier } from "./ai-rpc";
import { AI_CHAT_DEFAULT_PRESET, AI_CHAT_PRESETS, aiChatPresetOf, normalizePresetId } from "./ai-presets";
import type { AiChatPreset, AiChatPresetId } from "./ai-presets";

export type SettingValue = boolean | number | string;
/** 控件的取值形态。**不要新增字面量**：`tests/ai-rpc.test.ts` 静态钉住这一行只有四个值，
 *  文本类输入（AI 助手的端点 / 模型 / key）走 `SettingDef.text`，不占 kind。 */
export type SettingKind = "bool" | "int" | "enum" | "color";
/** 文本行的输入形态：`"plain"` 普通文本 / `"password"` 密文（API key） */
export type SettingText = "plain" | "password";
/** how the app must react when a value changes */
export type SettingRefresh = "none" | "changed" | "repaint" | "repaintAll";

export type SettingGroupId = "general" | "canvas" | "screen" | "tools" | "gesture" | "onion" | "history" | "display" | "data" | "ai" | "chat";

export interface SettingOption {
  value: string;
  /** i18n key of the option label */
  label: string;
}

export interface SettingDef {
  /** unique dotted path, e.g. "onion.before" */
  path: string;
  /** backing Session.prefs field (omit when get/set are supplied) */
  field?: keyof Prefs;
  /** 控件形态。文本行（AI 助手端点 / 模型 / key）不写 kind，改为写 `text` ——
   *  `SettingKind` 只允许四个字面量（见上面的注释），文本不是一个 kind 而是一种控件。 */
  kind?: SettingKind;
  /** 文本输入行；写它就是文本控件（`kind` 可以不写） */
  text?: SettingText;
  group: SettingGroupId;
  /** i18n key of the row label */
  label: string;
  /** optional i18n key of a one-line description under the control */
  desc?: string;
  /** default value (also used when stored data is invalid) */
  default: SettingValue;
  /** enum choices */
  options?: SettingOption[];
  /** int bounds */
  min?: number;
  max?: number;
  /** int suffix shown by the slider, e.g. "px" / "%" / "f" */
  unit?: string;
  /** double-tap reset target (defaults to `default`) */
  reset?: SettingValue;
  /** render only while this holds (Godot's usage-hint equivalent) */
  visible?: (s: Session) => boolean;
  /** UI reaction after the value is stored */
  refresh?: SettingRefresh;
  /** enum rendering: a chip row (default) or an expandable dropdown.
   *  Omitted = chips for <= 6 options, dropdown above that. */
  control?: "chips" | "dropdown";
  /** extra button rendered under the control (label = i18n key) */
  action?: { label: string; run: (s: Session) => void };
  /** custom read (defaults to prefs[field]) */
  get?: (s: Session) => SettingValue;
  /** custom write (defaults to prefs[field]) */
  set?: (s: Session, v: SettingValue) => void;
  /** extra side effect after the value is stored */
  after?: (s: Session, v: SettingValue) => void;
}


// ---------------------------------------------------------------- helpers
/** true when the setting currently holds its declared default */
export function isDefault(s: Session, d: SettingDef): boolean {
  const v = s.settingValue(d.path);
  return typeof v === "number" && typeof d.default === "number"
    ? Math.abs(v - d.default) < 1e-9
    : v === d.default;
}

/** put one setting back to its declared default */
export function resetSetting(s: Session, d: SettingDef): void {
  if (isDefault(s, d)) return;
  s.setSetting(d.path, d.default);
}

/** validate/normalise a value coming from a settings file (undefined = reject) */
export function coerceSetting(d: SettingDef, v: unknown): SettingValue | undefined {
  // 文本行（端点 / 模型 / key）先判：它不是四个 kind 里的任何一个
  if (d.text) return typeof v === "string" ? clipSettingText(v) : undefined;
  if (d.kind === "bool") {
    if (typeof v === "boolean") return v;
    if (v === 1 || v === "1" || v === "true") return true;
    if (v === 0 || v === "0" || v === "false") return false;
    return undefined;
  }
  if (d.kind === "int") {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    if (!Number.isFinite(n)) return undefined;
    const lo = d.min ?? -Infinity;
    const hi = d.max ?? Infinity;
    return Math.max(lo, Math.min(hi, Math.round(n)));
  }
  if (typeof v !== "string") return undefined;
  if (d.kind === "color") return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : undefined;
  return (d.options ?? []).some((o) => o.value === v) ? v : undefined;
}

export interface SettingsFile {
  app: string;
  version: number;
  savedAt: string;
  values: Record<string, SettingValue>;
}

export const SETTINGS_FILE_VERSION = 1;

// ---------------------------------------------------------------- AI 本地服务设置
//
// C3 的本地端口服务（只绑 127.0.0.1，默认关闭）有四个声明式设置：
// `ai.server` / `ai.port` / `ai.tier` / `ai.turnIdleSec`。
// 这三个值刻意**不放进 `Session.prefs`**：Node 开发宿主（toolchain/ai-server.mjs）没有 Session、
// 也没有 DOM，仍要读到同一份声明；而 `Prefs` 只由 session.ts 读写。所以这里自带一个极小存储：
// 内存缓存 + localStorage("pc.ai")，读不到（Node / 隐私模式 / 坏数据）就退回默认值，**不抛异常**。
//
// 为什么默认关闭 + 默认 read：开端口 = 外部进程能改这张画布。默认必须是「不开放」；用户明确打开后
// 也只读，要写必须自己升到 draw / all（档位口径见 src/app/ai-rpc.ts 的文件头）。

export const AI_SETTINGS_KEY = "pc.ai";

export interface AiServeSettings {
  /** `ai.server`：是否启动本地端口服务（默认 false） */
  server: boolean;
  /** `ai.port`：监听端口（只绑 127.0.0.1，默认 8787） */
  port: number;
  /** `ai.tier`：放行档位（默认 read = 只读） */
  tier: AiServiceTier;
  /** `ai.turnIdleSec`：AI 回合空闲多少秒自动 rollback（0 = 关闭这条兜底；默认 300） */
  turnIdleSec: number;
}

export const AI_PORT_MIN = 1024;
export const AI_PORT_MAX = 65535;
/** `ai.turnIdleSec` 的上限（1 小时够长了；0 在下面单独有含义） */
export const AI_TURN_IDLE_SEC_MAX = 3600;

/** 归一化：端口夹进 1024..65535、空闲秒数夹进 0..3600（**0 保留** = 用户主动关闭）、
 *  档位只认三个字面量、server 只认真 true */
export function normalizeAiServeSettings(raw: unknown): AiServeSettings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const port = Math.round(Number(o.port));
  const idle = Math.round(Number(o.turnIdleSec));
  const tier = String(o.tier);
  return {
    server: o.server === true,
    port: Number.isFinite(port) ? Math.max(AI_PORT_MIN, Math.min(AI_PORT_MAX, port)) : AI_RPC_DEFAULT_PORT,
    tier: (AI_SERVICE_TIERS as readonly string[]).indexOf(tier) >= 0 ? (tier as AiServiceTier) : AI_RPC_DEFAULT_TIER,
    turnIdleSec: Number.isFinite(idle)
      ? Math.max(0, Math.min(AI_TURN_IDLE_SEC_MAX, idle))
      : AI_TURN_IDLE_SEC_DEFAULT,
  };
}

let aiServeCache: AiServeSettings | null = null;
const aiServeListeners: Array<(v: AiServeSettings) => void> = [];

function aiStore(): { getItem(k: string): string | null; setItem(k: string, v: string): void } | null {
  try {
    const s = (globalThis as { localStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void } }).localStorage;
    return s && typeof s.getItem === "function" && typeof s.setItem === "function" ? s : null;
  } catch {
    return null;
  }
}

function loadAiServeSettings(): AiServeSettings {
  try {
    const store = aiStore();
    const raw = store ? store.getItem(AI_SETTINGS_KEY) : null;
    if (raw) return normalizeAiServeSettings(JSON.parse(raw));
  } catch {
    /* 坏数据 / 没有 localStorage：都用默认值 */
  }
  return normalizeAiServeSettings(null);
}

/** 当前值（返回副本；缓存一次，之后由 `saveAiServeSettings` 维护） */
export function aiServeSettings(): AiServeSettings {
  if (!aiServeCache) aiServeCache = loadAiServeSettings();
  return { ...aiServeCache };
}

/** 写回部分字段并通知监听者（ai-serve 用它即时起停原生端口）；返回写回后的完整值 */
export function saveAiServeSettings(patch: Partial<AiServeSettings>): AiServeSettings {
  const next = normalizeAiServeSettings({ ...aiServeSettings(), ...patch });
  aiServeCache = next;
  try {
    const store = aiStore();
    if (store) store.setItem(AI_SETTINGS_KEY, JSON.stringify(next));
  } catch {
    /* 存不下不算错：写盘失败不影响本次会话 */
  }
  for (const cb of aiServeListeners.slice()) {
    try {
      cb({ ...next });
    } catch {
      /* 监听者自己出错不该拖垮设置写入 */
    }
  }
  return { ...next };
}

/** 注册「AI 服务设置变了」的监听，返回退订函数（ai-serve 在 install 时订阅） */
export function onAiServeSettingsChange(cb: (v: AiServeSettings) => void): () => void {
  aiServeListeners.push(cb);
  return () => {
    const i = aiServeListeners.indexOf(cb);
    if (i >= 0) aiServeListeners.splice(i, 1);
  };
}

// ---------------------------------------------------------------- AI 助手（应用内聊天，C5）
//
// 应用内助手（docs/PLAN-ai.md §3.5 A 路线）的三项配置 + 一个总开关。与 C3 的本地端口服务
// 同一个做法：**值不进 `Session.prefs`**，自带一个极小存储（内存缓存 + localStorage("pc.aichat")），
// 读不到（Node / 隐私模式 / 坏数据）就退回默认值，**不抛异常**。
//
// 为什么 key 必须单独存、而且不进 prefs：
//   · `prefs` 会随工程 / 设置导出走（`exportSettings` 与 .pxc），**key 只该留在本机**（§3.6 红线）；
//   · 所以三项都在这里，只有 `ai.chatKey` 例外地**不进设置导出 / 导入**（`SETTING_SECRET_PATHS`）。
//
// 为什么 chat 设置不在 `SETTINGS`（导出用的那个数组）里：
//   `tests/session.test.ts` 钉住「导出的取值条数 === SETTINGS.length」「导入的 applied === SETTINGS.length」，
//   而 key 又必须**一个字节都不进导出** —— 两者不能同时成立。所以助手这一组单独一张表
//   （`CHAT_SETTINGS`），照样是声明式的（同一套 `SettingDef`、同一个设置页渲染器），
//   只是不参与「设置文件导出」这件事；`SETTINGS_BY_PATH` 两个表都收，`settingsOfGroup` 也两个都读。

export const AI_CHAT_SETTINGS_KEY = "pc.aichat";
/** 三项文本的最大长度（端点 URL / 模型名 / key；够长 JWT 用） */
export const AI_CHAT_MAX_TEXT = 2048;
/**
 * 默认端点 / 默认模型 = **DeepSeek 预设**（§3.7.7「开箱即用」）。
 * 两个常量与 `AI_CHAT_PRESETS` 同源（不是抄一遍字符串），所以改预设表就同时改了默认值。
 * 这里只有公开的 base URL 与公开的模型名，**没有任何凭据**（§3.6 的红线针对的是 key）。
 */
export const AI_CHAT_DEFAULT_ENDPOINT = aiChatPresetOf(AI_CHAT_DEFAULT_PRESET).baseUrl;
export const AI_CHAT_DEFAULT_MODEL = aiChatPresetOf(AI_CHAT_DEFAULT_PRESET).defaultModel;

/** 预设表与 id 的对外出口（§3.7.7 的 schema：预设就是「一组默认值 + 一个可切模型清单」） */
export { AI_CHAT_PRESETS, AI_CHAT_DEFAULT_PRESET };
export type { AiChatPreset, AiChatPresetId };

/**
 * `ai.chatThinking` 的档位（与 `ai-chat.ts` 的 `AiChatThinking` 同一口径）。
 * `default` = **一个字段都不发**（对任何 OpenAI 兼容端点最安全）；其余是 **DeepSeek 的思考模式**参数：
 * `{"thinking":{"type":"enabled|disabled"}}` + `{"reasoning_effort":"low|high|max"}` —— 换别的端点可能不认，
 * 所以默认必须是 `default`，只有用户明确选了才发。
 */
export const AI_CHAT_THINKING_DEFAULT = "default";
export const AI_CHAT_THINKING_MODES: readonly string[] = ["default", "off", "low", "high", "max"];

/** `ai.chatTimeoutSec`：**等模型回话**的秒数（发请求时 ×1000 变毫秒；壳的上游转发腿也按它等） */
export const AI_CHAT_TIMEOUT_DEFAULT = 60;
export const AI_CHAT_TIMEOUT_MIN = 5;
export const AI_CHAT_TIMEOUT_MAX = 600;

/** `ai.chatMaxRounds` 的取值区间（与 `ai-chat.ts` 的 `AI_CHAT_MAX_ROUNDS` 同一口径） */
export const AI_CHAT_MAX_ROUNDS_MIN = 1;
export const AI_CHAT_MAX_ROUNDS_MAX = 24;
export const AI_CHAT_MAX_ROUNDS_DEFAULT = 12;
/** `ai.chatTemp`：**整数档位**，发的 `temperature` = 值 × 0.1（0 = 不发这个字段，用端点默认） */
export const AI_CHAT_TEMP_MIN = 0;
export const AI_CHAT_TEMP_MAX = 20;
export const AI_CHAT_TEMP_DEFAULT = 0;
/** `ai.chatTemp` 一档 = 0.1（UI 与请求体共用同一个换算，别在别处再写一遍） */
export const AI_CHAT_TEMP_STEP = 0.1;

export interface AiChatSettings {
  /** `ai.chatOn`：应用内助手总开关（默认 false） */
  on: boolean;
  /** `ai.chatPreset`：当前选中的厂商预设（默认 `deepseek`；**切预设不碰 key**） */
  preset: AiChatPresetId;
  /** `ai.chatEndpoint`：OpenAI 兼容的基地址，例如 https://api.openai.com/v1 */
  endpoint: string;
  /** `ai.chatModel`：模型名 */
  model: string;
  /**
   * `ai.chatKey`：用户**手填**的 API key。**只存本机**，不进设置导出 / 导入、不进诊断文本、不进 toast。
   * 诚实边界（§3.7.4）：它就在本机页面的 `localStorage` 里，「key 不进页面」这条**只对
   * 「宿主环境变量提供的那把 key」成立** —— 环境 key 由壳持有并同源转发，页面只拿一个布尔。
   */
  key: string;
  /** `ai.providerBase`：手填 key 时的**直连地址**；留空 = 用 `ai.chatEndpoint`（§3.7.7） */
  providerBase: string;
  /** `ai.chatMaxRounds`：一整轮最多问几次模型（1..24，默认 12） */
  maxRounds: number;
  /** `ai.chatTemp`：温度档位 0..20（× 0.1 = 请求里的 temperature；0 = 不发这个字段） */
  temp: number;
  /** `ai.chatSystemPrompt`：非空则追加在内置提示词之后 */
  systemPrompt: string;
  /** `ai.chatThinking`：思考强度档位（`default` = 不发任何思考字段；`off`/`low`/`high`/`max` = DeepSeek 思考模式） */
  thinking: string;
  /** `ai.chatTimeoutSec`：等模型回话的秒数（5..600，默认 60；见 `ai-chat.ts` 的 `requestModel()`） */
  timeoutSec: number;
  /**
   * `ai.chatStream`（默认 **true**）：把 `stream:true` 发给端点并逐块读 SSE
   * （正文打字机 + 思考过程单独一块）。
   *
   * 端点不支持（回的 content-type 不是 `text/event-stream`）或流中途出错时
   * **自动降级**成整包请求，原因写在 `ChatTurnResult.streamNote.reason` 里由面板显示 ——
   * 所以这条开关最坏也就是「退回从前的行为」，不会让用户看到一个坏掉的回答。
   */
  stream: boolean;
  /**
   * `ai.protectKey`：**诊断 / 提示文本里不折叠 key 相关信息**的开关（默认 `true`）。
   *
   * 语义要写准（别让它变成一个危险开关）：置 `false` 只允许关掉「额外那一道诊断折叠」，
   * **绝不意味着 key 可以进任何文本** —— key 不进导出、不进 toast、不进错误文案这几条
   * 与它无关（那是由 `SETTING_SECRET_PATHS` 与「状态文本只拼有无」两处代码保证的）。
   */
  protectKey: boolean;
  // ---- 浮窗与小球的状态（docs/PLAN-ai.md §3.7.6）----
  //
  // 这三条是**状态**不是「用户要调的值」，所以两件事要一起说清：
  //   · 落在这里（而不是 `Session.prefs`）：`prefs` 会随工程 / 设置导出走，
  //     而「这个窗口开在屏幕哪个角落」是**这台机器这个屏幕**的事，与 `pc.aichat`、
  //     `pc.orb.pos` 同一类；
  //   · **不写进设置页界面**（下面对应的三条声明 `visible` 恒为 false）：它们不是可选项，
  //     给用户一个「窗口开着吗」的开关没有意义。真正的几何（x/y/w/h/min）走
  //     `localStorage["pc.aichat.win"]`（键与归一化在 `src/app/uibar.ts`），这里只存三件「有没有」的布尔。
  /** `ai.chatWinOpen`：浮窗当前是否打开（默认 false；进程内状态） */
  winOpen: boolean;
  /** `ai.chatWinMin`：是否已最小化成小球（默认 false） */
  winMin: boolean;
  /** `ai.chatBall`：是否允许显示助手小球（默认 true；关掉 = 只能用菜单打开窗口）。**这一条是可见开关** */
  ball: boolean;
}

function clipSettingText(v: string): string {
  const s = String(v ?? "");
  return s.length > AI_CHAT_MAX_TEXT ? s.slice(0, AI_CHAT_MAX_TEXT) : s;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
}

/** 思考强度：只认白名单里的档位，其余（含 undefined / 旧数据）一律回 `default`（= 不发任何思考字段） */
function normalizeThinking(v: unknown): string {
  const s = String(v ?? "");
  return AI_CHAT_THINKING_MODES.indexOf(s) >= 0 ? s : AI_CHAT_THINKING_DEFAULT;
}

/**
 * 归一化：字符串只认字符串、**五个**开关只认真 false（`stream` / `protectKey` / `ball` 是
 * 「默认 true」，所以判的是 `!== false`）、三个整数夹进区间。
 *
 * `endpoint` / `model` 的空串**不填默认值**：空串是「用户主动清空」的意思（§3.7.7 第 5 条），
 * 只有第一次打开助手（`pc.aichat` 这个键还不存在）时才会落预设默认值 —— 那一步由
 * `AI_CHAT_DEFAULT_ENDPOINT` / `AI_CHAT_DEFAULT_MODEL` 两个声明值完成。
 */
export function normalizeAiChatSettings(raw: unknown): AiChatSettings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  // 文本字段一律「只认字符串，其余空串」。`endpoint` / `model` 的**空串不填默认值**：
  // 空串是「用户主动清空」的意思（§3.7.7 第 5 条）；第一次打开助手时落预设默认值那一步，
  // 由上面两个**声明默认值**（`AI_CHAT_DEFAULT_ENDPOINT` / `AI_CHAT_DEFAULT_MODEL`）完成。
  const str = (v: unknown): string => (typeof v === "string" ? clipSettingText(v) : "");
  return {
    on: o.on === true,
    preset: normalizePresetId(o.preset),
    endpoint: str(o.endpoint),
    model: str(o.model),
    key: str(o.key),
    providerBase: str(o.providerBase),
    maxRounds: clampInt(o.maxRounds, AI_CHAT_MAX_ROUNDS_MIN, AI_CHAT_MAX_ROUNDS_MAX, AI_CHAT_MAX_ROUNDS_DEFAULT),
    temp: clampInt(o.temp, AI_CHAT_TEMP_MIN, AI_CHAT_TEMP_MAX, AI_CHAT_TEMP_DEFAULT),
    thinking: normalizeThinking(o.thinking),
    timeoutSec: clampInt(o.timeoutSec, AI_CHAT_TIMEOUT_MIN, AI_CHAT_TIMEOUT_MAX, AI_CHAT_TIMEOUT_DEFAULT),
    systemPrompt: str(o.systemPrompt),
    stream: o.stream !== false,
    protectKey: o.protectKey !== false,
    winOpen: o.winOpen === true, winMin: o.winMin === true, ball: o.ball !== false,
  };
}

/**
 * **切预设**（§3.7.7 的七条语义里的第 2–4 条）：写 `endpoint` + `model` 两个值，并记住 `preset`。
 *
 *   1. **绝不碰 `ai.chatKey`**：这个函数只写三个字段，key 连读都不读（结构保证，不是「记得别写」）；
 *   2. **切到 `custom` 一个字段都不写**：custom 的 baseUrl / defaultModel 是空串，直接写会把用户
 *      已经填好的端点 / 模型抹掉 —— custom 的语义就是「别动这两个值，我去手填」；
 *   3. 端点 / 模型仍是自由文本行，预设只是把它们**填成一组默认值**，之后用户随便改。
 *
 * @returns 写回后的完整设置（`custom` 时只写 `preset` 这一项）
 */
export function applyAiChatPreset(id: string): AiChatSettings {
  const wanted = normalizePresetId(id);
  const p = aiChatPresetOf(wanted);
  if (p.id === "custom") return saveAiChatSettings({ preset: wanted });
  return saveAiChatSettings({ preset: wanted, endpoint: p.baseUrl, model: p.defaultModel });
}

let aiChatCache: AiChatSettings | null = null;
const aiChatListeners: Array<(v: AiChatSettings) => void> = [];

/**
 * 读一次 `pc.aichat`。**首次加载就是 DeepSeek 默认值**（P8 修掉的 F3）：
 *
 * 「键不存在 = 从没配过」→ 用**声明默认值**（`AI_CHAT_DEFAULT_ENDPOINT` / `_MODEL`，
 * 与 DeepSeek 预设同源）兜底，并**当场落一次盘**。早先这里 `normalizeAiChatSettings(null)`
 * 给出的是**空串**端点 / 模型（因为 normalize 把「空串」当「用户主动清空」，见它自己的注释），
 * 于是设置页两行是空的 —— 默认值要等 `AiPanel` 探通代理后才补写，**代理一坏就永远补不上**
 * （F1/F2 同时坏掉时，用户看到的就是「端点 / 模型都空着」，开箱即用当场变成一句空话）。
 *
 * 三条边界（别把它们改回空串）：
 *   · 键**存在**但两个字段都是空串 = 用户主动清空 → **一个字都不写**（§3.7.7 第 5 条）；
 *   · 键存在且有值 → 原样归一化返回；
 *   · 没有 localStorage（Node / 隐私模式 / 坏 JSON）→ 内存里给出默认值，**不抛异常**（写盘失败不算错）。
 */
function loadAiChatSettings(): AiChatSettings {
  let raw: string | null = null;
  let readable = false;
  try {
    const store = aiStore();
    if (store) { readable = true; raw = store.getItem(AI_CHAT_SETTINGS_KEY); }
  } catch {
    readable = false;
  }
  if (raw) {
    try {
      return normalizeAiChatSettings(JSON.parse(raw));
    } catch {
      /* 坏 JSON：当没配过，走下面的默认值 */
    }
  }
  if (readable && raw === null) {
    // 从没配过：落一次默认（这就是「开箱即用」那一行；之后不再重复写，用户改了就是改了）
    const fresh = normalizeAiChatSettings({
      preset: AI_CHAT_DEFAULT_PRESET, endpoint: AI_CHAT_DEFAULT_ENDPOINT, model: AI_CHAT_DEFAULT_MODEL,
    });
    try {
      const store = aiStore();
      if (store) store.setItem(AI_CHAT_SETTINGS_KEY, JSON.stringify(fresh));
    } catch {
      /* 存不下不算错：本次会话里照样按默认值跑 */
    }
    return fresh;
  }
  // 没有可读的存储：给默认值，但**不假装写过盘**
  return normalizeAiChatSettings({
    preset: AI_CHAT_DEFAULT_PRESET, endpoint: AI_CHAT_DEFAULT_ENDPOINT, model: AI_CHAT_DEFAULT_MODEL,
  });
}

/** 当前值（返回副本；缓存一次，之后由 `saveAiChatSettings` 维护） */
export function aiChatSettings(): AiChatSettings {
  if (!aiChatCache) aiChatCache = loadAiChatSettings();
  return { ...aiChatCache };
}

/**
 * **丢掉内存缓存、重新从存储里读一次**（测试与将来的「切机器 / 重启」诊断用）。
 *
 * 与 `aiChatSettings()` 的缓存是同一份状态，所以调用它之后拿到的是**刚读出来的真值**：
 * 这是「全新配置首次加载就落默认值」这条口径唯一可测的入口 —— 不这么做，模块级缓存会让
 * 「第一次读」只发生一次，测试没法重放「全新安装」。
 */
export function reloadAiChatSettings(): AiChatSettings {
  aiChatCache = loadAiChatSettings();
  return { ...aiChatCache };
}

/** 写回部分字段并通知监听者；返回写回后的完整值 */
export function saveAiChatSettings(patch: Partial<AiChatSettings>): AiChatSettings {
  const next = normalizeAiChatSettings({ ...aiChatSettings(), ...patch });
  aiChatCache = next;
  try {
    const store = aiStore();
    if (store) store.setItem(AI_CHAT_SETTINGS_KEY, JSON.stringify(next));
  } catch {
    /* 存不下不算错：写盘失败不影响本次会话 */
  }
  for (const cb of aiChatListeners.slice()) {
    try {
      cb({ ...next });
    } catch {
      /* 监听者自己出错不该拖垮设置写入 */
    }
  }
  return { ...next };
}

/** 注册「助手设置变了」的监听，返回退订函数 */
export function onAiChatSettingsChange(cb: (v: AiChatSettings) => void): () => void {
  aiChatListeners.push(cb);
  return () => {
    const i = aiChatListeners.indexOf(cb);
    if (i >= 0) aiChatListeners.splice(i, 1);
  };
}

/** 清掉 key（换机器 / 怀疑泄漏时「一键清除」，见 §3.6） */
export function clearAiChatKey(): void {
  saveAiChatSettings({ key: "" });
}

/**
 * **绝不出现在设置导出 / 导入里的路径**（key 只存在本机，§3.6）。
 * 两处 `exportSettings` / `importSettings` 都显式跳过它 —— 即使以后有人把这条声明挪进
 * `SETTINGS`，key 也不会跟着设置文件跑到别的机器上。
 */
export const SETTING_SECRET_PATHS: readonly string[] = ["ai.chatKey"];

export function isSecretSettingPath(path: string): boolean {
  return SETTING_SECRET_PATHS.indexOf(path) >= 0;
}

/**
 * 助手那一组设置（声明式，但**不参与设置文件导出**，见文件上方那一节）。
 * 平台门：只有有原生桥接（APK / 桌面壳的 `window.PixelBridge`）时才出现 ——
 * 普通浏览器里连这几行都不显示（GitHub Pages 不背 AI，见 §3.6）；
 * 端点 / 模型 / key 还要等总开关打开（关着的时候设置页只留一条开关）。
 */
const chatRowsVisible = (): boolean => bridge.isNativeShell();

export const CHAT_SETTINGS: SettingDef[] = [
  {
    path: "ai.chatOn", kind: "bool", group: "chat",
    label: "aiChatOnLabel", desc: "aiChatOnDesc", default: false, refresh: "none",
    visible: () => chatRowsVisible(),
    get: () => aiChatSettings().on,
    set: (_s, v) => { saveAiChatSettings({ on: v === true }); },
  },
  {
    // 厂商预设（§3.7.7）：切它 = 一次 `applyAiChatPreset()`（写 endpoint + model，**绝不碰 key**）。
    // 三个选项所以默认按 chips 渲染（`control` 不写），顺序与 `AI_CHAT_PRESETS` 一致。
    path: "ai.chatPreset", kind: "enum", group: "chat",
    label: "aiChatPresetLabel", desc: "aiChatPresetDesc", default: AI_CHAT_DEFAULT_PRESET, refresh: "none",
    options: AI_CHAT_PRESETS.map((p) => ({ value: p.id, label: p.label })),
    visible: () => chatRowsVisible() && aiChatSettings().on,
    get: () => aiChatSettings().preset,
    set: (_s, v) => { applyAiChatPreset(String(v)); },
  },
  {
    path: "ai.chatEndpoint", text: "plain", group: "chat",
    label: "aiChatEndpointLabel", desc: "aiChatEndpointDesc", default: AI_CHAT_DEFAULT_ENDPOINT, refresh: "none",
    visible: () => chatRowsVisible() && aiChatSettings().on,
    get: () => aiChatSettings().endpoint,
    set: (_s, v) => { saveAiChatSettings({ endpoint: String(v) }); },
  },
  {
    path: "ai.chatModel", text: "plain", group: "chat",
    label: "aiChatModelLabel", desc: "aiChatModelDesc", default: AI_CHAT_DEFAULT_MODEL, refresh: "none",
    visible: () => chatRowsVisible() && aiChatSettings().on,
    get: () => aiChatSettings().model,
    set: (_s, v) => { saveAiChatSettings({ model: String(v) }); },
  },
  {
    path: "ai.chatKey", text: "password", group: "chat",
    label: "aiChatKeyLabel", desc: "aiChatKeyDesc", default: "", refresh: "none",
    visible: () => chatRowsVisible() && aiChatSettings().on,
    get: () => aiChatSettings().key,
    set: (_s, v) => { saveAiChatSettings({ key: String(v) }); },
    // §3.6「key 要能一键清除」：清完通知 UI 刷新（输入框里那串字要跟着消失）。
    // §3.7.4：**清空 = 落回宿主环境变量那把 key**（有代理时），文案里必须写明这一点
    action: {
      label: "aiChatKeyClear",
      run: (sess) => { clearAiChatKey(); sess.changedUI(); bridge.toast("aiChatKeyCleared"); },
    },
  },
  {
    // 直连地址的另一份（§3.7.7）：给「key 走网关、基地址又和预设不一样」的场景。
    // 留空 = 用 `ai.chatEndpoint`（预设填的那个），所以它默认空串、不影响开箱即用
    path: "ai.providerBase", text: "plain", group: "chat",
    label: "aiProviderBaseLabel", desc: "aiProviderBaseDesc", default: "", refresh: "none",
    visible: () => chatRowsVisible() && aiChatSettings().on,
    get: () => aiChatSettings().providerBase,
    set: (_s, v) => { saveAiChatSettings({ providerBase: String(v) }); },
  },
  {
    path: "ai.chatMaxRounds", kind: "int", group: "chat",
    label: "aiChatMaxRoundsLabel", desc: "aiChatMaxRoundsDesc",
    default: AI_CHAT_MAX_ROUNDS_DEFAULT, min: AI_CHAT_MAX_ROUNDS_MIN, max: AI_CHAT_MAX_ROUNDS_MAX,
    reset: AI_CHAT_MAX_ROUNDS_DEFAULT, unit: "×", refresh: "none",
    visible: () => chatRowsVisible() && aiChatSettings().on,
    get: () => aiChatSettings().maxRounds,
    set: (_s, v) => { saveAiChatSettings({ maxRounds: Number(v) }); },
  },
  {
    path: "ai.chatTemp", kind: "int", group: "chat",
    label: "aiChatTempLabel", desc: "aiChatTempDesc",
    default: AI_CHAT_TEMP_DEFAULT, min: AI_CHAT_TEMP_MIN, max: AI_CHAT_TEMP_MAX,
    reset: AI_CHAT_TEMP_DEFAULT, unit: "%", refresh: "none",
    visible: () => chatRowsVisible() && aiChatSettings().on,
    get: () => aiChatSettings().temp,
    set: (_s, v) => { saveAiChatSettings({ temp: Number(v) }); },
  },
  {
    // 思考强度（DeepSeek 思考模式）：**默认档一个字段都不发** —— 那些参数换到非 DeepSeek 端点
    // 可能不被认（甚至 400），所以必须由用户明确选；`off` = 关闭思考（最快）。
    path: "ai.chatThinking", kind: "enum", group: "chat",
    label: "aiChatThinkingLabel", desc: "aiChatThinkingDesc", default: AI_CHAT_THINKING_DEFAULT, refresh: "none",
    options: AI_CHAT_THINKING_MODES.map((m) => ({ value: m, label: "aiChatThinking_" + m })),
    visible: () => chatRowsVisible() && aiChatSettings().on,
    get: () => aiChatSettings().thinking,
    set: (_s, v) => { saveAiChatSettings({ thinking: String(v) }); },
  },
  {
    // 等模型回话的秒数：**这一条真的会传到壳**（请求头 `X-Provider-Timeout`，壳按它等上游），
    // 直连时由页面的 AbortController 按同一个值兜底 —— 两条路都按它等，别只在一边生效。
    path: "ai.chatTimeoutSec", kind: "int", group: "chat",
    label: "aiChatTimeoutLabel", desc: "aiChatTimeoutDesc",
    default: AI_CHAT_TIMEOUT_DEFAULT, min: AI_CHAT_TIMEOUT_MIN, max: AI_CHAT_TIMEOUT_MAX,
    reset: AI_CHAT_TIMEOUT_DEFAULT, unit: "s", refresh: "none",
    visible: () => chatRowsVisible() && aiChatSettings().on,
    get: () => aiChatSettings().timeoutSec,
    set: (_s, v) => { saveAiChatSettings({ timeoutSec: Number(v) }); },
  },
  {
    path: "ai.chatSystemPrompt", text: "plain", group: "chat",
    label: "aiChatSystemPromptLabel", desc: "aiChatSystemPromptDesc", default: "", refresh: "none",
    visible: () => chatRowsVisible() && aiChatSettings().on,
    get: () => aiChatSettings().systemPrompt,
    set: (_s, v) => { saveAiChatSettings({ systemPrompt: String(v) }); },
  },
  {
    // 流式（默认开）：真的把 `stream:true` 发给端点并逐块读 SSE；端点不支持或流中途出错时
    // **自动降级**成整包（原因由面板显示）。关掉 = 请求体里一个字节都不发这个字段（从前的行为）。
    path: "ai.chatStream", kind: "bool", group: "chat",
    label: "aiChatStreamLabel", desc: "aiChatStreamDesc", default: true, refresh: "none",
    visible: () => chatRowsVisible() && aiChatSettings().on,
    get: () => aiChatSettings().stream,
    set: (_s, v) => { saveAiChatSettings({ stream: v !== false }); },
  },
  {
    // 「诊断 / 提示文本里不许出现 key」这条**已经由代码保证**（状态文本只拼「有无」，见
    // `ai-chat.ts` 的 `aiChatStatusText()`；key 也从不进导出 / toast）。这个开关是给用户
    // 一份**显式的安心**：默认开，关掉只关掉「额外的诊断折叠」，绝不等于允许把 key 打进任何文本
    // —— 那句话写在 desc 里，别让用户以为关掉就"能显示 key 了"。
    path: "ai.protectKey", kind: "bool", group: "chat",
    label: "aiProtectKeyLabel", desc: "aiProtectKeyDesc", default: true, refresh: "none",
    visible: () => chatRowsVisible() && aiChatSettings().on,
    get: () => aiChatSettings().protectKey,
    set: (_s, v) => { saveAiChatSettings({ protectKey: v !== false }); },
  },
  // ---- 浮窗与小球的状态（docs/PLAN-ai.md §3.7.6）----
  //
  // 前两条是**状态**不是「用户要调的值」，所以 `visible` 恒为 false：设置页里一条都不显示
  // （给用户一个「窗口开着吗」的开关没有意义）。它们落在这里而不是 `Session.prefs`，
  // 是因为「这台机器这个屏幕上的窗口」不该跟着工程 / 设置导出走；真正的几何（x/y/w/h/min）
  // 走 `localStorage["pc.aichat.win"]`，键与归一化在 `src/app/uibar.ts`。
  //
  // 第三条（`ai.chatBall`）是**可见开关**：它决定「最小化后的那个球还画不画」，
  // 是一个用户真的要调的值，所以它跟别的 chat 行一样在 `ai.chatOn` 打开后露出来
  // （`aichat.setting.visible-on` 因此把它列了进去，见 §3.7.7 / §3.7.8）。
  {
    path: "ai.chatWinOpen", kind: "bool", group: "chat",
    label: "aiChatTitle", desc: "aiChatOpen", default: false, refresh: "none",
    visible: () => false,
    get: () => aiChatSettings().winOpen,
    set: (_s, v) => { saveAiChatSettings({ winOpen: v === true }); },
  },
  {
    path: "ai.chatWinMin", kind: "bool", group: "chat",
    label: "aiChatMinimize", desc: "aiChatMinimize", default: false, refresh: "none",
    visible: () => false,
    get: () => aiChatSettings().winMin,
    set: (_s, v) => { saveAiChatSettings({ winMin: v === true }); },
  },
  {
    path: "ai.chatBall", kind: "bool", group: "chat",
    label: "aiChatBallLabel", desc: "aiChatBallDesc", default: true, refresh: "none",
    visible: () => chatRowsVisible() && aiChatSettings().on,
    get: () => aiChatSettings().ball,
    set: (_s, v) => { saveAiChatSettings({ ball: v !== false }); },
  },
];

/** every declared setting as a plain object, ready to be written as JSON */
export function exportSettings(s: Session): SettingsFile {
  const values: Record<string, SettingValue> = {};
  for (const d of defs) {
    // key 之类的机密路径**显式跳过**（§3.6：key 只存在本机，绝不跟着设置文件走）
    if (isSecretSettingPath(d.path)) continue;
    values[d.path] = s.settingValue(d.path);
  }
  return { app: "PixelCraft", version: SETTINGS_FILE_VERSION, savedAt: new Date().toISOString(), values };
}

/** apply a settings file (the exported object or a bare values map).
 *  Unknown keys and invalid values are counted as skipped, never applied. */
export function importSettings(s: Session, raw: unknown): { applied: number; skipped: number } {
  const src = (raw && typeof raw === "object" && "values" in (raw as Record<string, unknown>)
    ? (raw as { values?: unknown }).values
    : raw) as Record<string, unknown> | null | undefined;
  if (!src || typeof src !== "object") return { applied: 0, skipped: 0 };
  let applied = 0;
  let skipped = 0;
  for (const d of defs) {
    if (!(d.path in src)) continue;
    // 机密路径显式跳过：别人塞一个 ai.chatKey 进来也不会覆盖本机的 key
    if (isSecretSettingPath(d.path)) { skipped++; continue; }
    const v = coerceSetting(d, src[d.path]);
    if (v === undefined) { skipped++; continue; }
    s.setSetting(d.path, v);
    applied++;
  }
  return { applied, skipped };
}

const GESTURE_ACTION_LABELS: Record<string, string> = Object.fromEntries(
  GESTURE_ACTIONS.map((a) => [a.id, a.label]),
);

export const SETTING_GROUPS: Array<{ id: SettingGroupId; label: string }> = [
  { id: "general", label: "groupGeneral" },
  { id: "canvas", label: "groupCanvas" },
  { id: "screen", label: "groupScreen" },
  { id: "tools", label: "groupTools" },
  { id: "gesture", label: "groupGesture" },
  { id: "onion", label: "groupOnion" },
  { id: "history", label: "groupHistory" },
  { id: "display", label: "groupDisplay" },
  { id: "data", label: "groupData" },
  { id: "ai", label: "groupAi" },
  { id: "chat", label: "groupChat" },
];

const defs: SettingDef[] = [
  // ------------------------------------------------------------ general
  {
    path: "general.language", field: "lang", kind: "enum", group: "general",
    label: "lang", default: "zh", refresh: "changed",
    options: [{ value: "zh", label: "zhLabel" }, { value: "en", label: "enLabel" }],
  },
  {
    path: "general.swapRails", field: "railSwap", kind: "bool", group: "general",
    label: "swapRails", default: true, refresh: "changed",
  },
  {
    path: "general.newFrameCopy", field: "newFrameCopy", kind: "bool", group: "general",
    label: "newFrameCopy", default: false, refresh: "changed",
  },

  // ------------------------------------------------------------- canvas
  {
    path: "canvas.grid", field: "gridMode", kind: "enum", group: "canvas",
    label: "grid", default: "off", refresh: "repaintAll",
    options: [{ value: "off", label: "gridNone" }, { value: "pixel", label: "gridPixel" }, { value: "iso", label: "gridIso" }],
    // a tiny cell size makes the isometric guide too dense
    after: (s, v) => { if (v === "iso" && s.prefs.gridSize < 4) s.prefs.gridSize = 8; },
  },
  {
    path: "canvas.tileMode", field: "tileMode", kind: "enum", group: "canvas",
    label: "tileMode", desc: "tileModeDesc", default: "off", refresh: "repaintAll",
    options: [
      { value: "off", label: "tileOff" },
      { value: "row", label: "tileRow" },
      { value: "col", label: "tileCol" },
      { value: "grid", label: "tileGrid" },
    ],
  },
  {
    path: "canvas.gridSize", field: "gridSize", kind: "int", group: "canvas",
    label: "gridSize", default: 1, min: 1, max: 32, unit: "px", reset: 1, refresh: "repaintAll",
    visible: (s) => s.prefs.gridMode !== "off",
  },
  {
    path: "canvas.snapOn", field: "snapOn", kind: "bool", group: "canvas",
    label: "snapOn", desc: "snapOnDesc", default: true, refresh: "none",
  },
  {
    path: "canvas.snapRange", field: "snapRange", kind: "int", group: "canvas",
    label: "snapRange", desc: "snapRangeDesc", default: 14, min: 4, max: 48, unit: "px", reset: 14, refresh: "none",
    visible: (s) => s.prefs.snapOn,
  },
  {
    path: "canvas.snapGap", field: "snapGap", kind: "int", group: "canvas",
    label: "snapGap", desc: "snapGapDesc", default: 8, min: 0, max: 48, unit: "px", reset: 8, refresh: "repaintAll",
    visible: (s) => s.prefs.snapOn,
  },
  {
    path: "canvas.snapInColor", field: "snapInColor", kind: "color", group: "canvas",
    label: "snapInColor", desc: "snapInColorDesc", default: "#78ffb4", refresh: "repaintAll",
    visible: (s) => s.prefs.snapOn,
  },
  {
    path: "canvas.snapOutColor", field: "snapOutColor", kind: "color", group: "canvas",
    label: "snapOutColor", desc: "snapOutColorDesc", default: "#ff6464", refresh: "repaintAll",
    visible: (s) => s.prefs.snapOn,
  },
  {
    path: "canvas.autoPan", field: "autoPan", kind: "bool", group: "canvas",
    label: "autoPan", default: true, refresh: "changed",
  },
  {
    path: "canvas.timelineHeight", field: "tlH", kind: "int", group: "canvas",
    label: "tlHeight", desc: "tlHeightDesc", default: 200, min: 140, max: 520, unit: "px", reset: 200, refresh: "changed",
  },

  {
    path: "screen.immersive", field: "immersive", kind: "bool", group: "screen",
    label: "immersiveLabel", desc: "immersiveDesc", default: true, refresh: "none",
    after: (s, v) => { bridge.setImmersive(v === true); applySafeArea(s.prefs); },
  },
  {
    path: "screen.safeArea", field: "safeArea", kind: "bool", group: "screen",
    label: "safeAreaLabel", desc: "safeAreaDesc", default: true, refresh: "none",
    after: (s) => applySafeArea(s.prefs),
  },
  {
    path: "screen.safeExtra", field: "safeExtra", kind: "int", group: "screen",
    label: "safeExtraLabel", desc: "safeExtraDesc", default: 0, min: 0, max: 40, unit: "px", reset: 0,
    refresh: "none",
    after: (s) => applySafeArea(s.prefs),
  },

  {
    path: "general.newDocW", field: "newDocW", kind: "int", group: "general",
    label: "newDocW", default: 64, min: 1, max: 1024, unit: "px", reset: 64, refresh: "none",
  },
  {
    path: "general.newDocH", field: "newDocH", kind: "int", group: "general",
    label: "newDocH", default: 64, min: 1, max: 1024, unit: "px", reset: 64, refresh: "none",
  },
  {
    path: "general.newDocBg", field: "newDocBg", kind: "enum", group: "general",
    label: "newDocBg", default: "transparent", refresh: "none",
    options: [{ value: "transparent", label: "transparent" }, { value: "white", label: "whiteBg" }],
  },

  // -------------------------------------------------------------- tools
  {
    // remembered tool / brush state
    path: "tools.brushSize", kind: "int", group: "tools",
    label: "brushSize", default: 1, min: 1, max: 64, unit: "px", reset: 1, refresh: "changed",
    get: (s) => s.brushSize,
    set: (s, v) => s.setBrushSize(Number(v)),
  },
  {
    path: "tools.brushAlpha", kind: "int", group: "tools",
    label: "opacity", default: 255, min: 0, max: 255, reset: 255, refresh: "changed",
    get: (s) => s.color[3],
    set: (s, v) => s.setBrushAlpha(Number(v)),
  },
  {
    path: "tools.brushShape", kind: "enum", group: "tools",
    label: "brushShapeLabel", desc: "brushShapeDesc", default: "circle", refresh: "changed",
    options: [{ value: "circle", label: "brushCircle" }, { value: "square", label: "brushSquare" }],
    get: (s) => s.brushShape,
    set: (s, v) => s.setBrushShape(v === "square" ? "square" : "circle"),
  },
  {
    path: "tools.indexed", field: "indexed", kind: "bool", group: "tools",
    label: "indexedLabel", desc: "indexedDesc", default: false, refresh: "changed",
  },
  {
    path: "tools.pixelPerfect", kind: "bool", group: "tools",
    label: "pixelPerfectLabel", desc: "pixelPerfectDesc", default: true, refresh: "changed",
    get: (s) => s.pixelPerfect,
    set: (s, v) => s.setPixelPerfect(!!v),
  },
  {
    path: "tools.shapeFill", kind: "bool", group: "tools",
    label: "shapeFillLabel", desc: "shapeFillDesc", default: true, refresh: "changed",
    get: (s) => s.shapeFill,
    set: (s, v) => s.setShapeFill(!!v),
  },
  {
    path: "tools.shapeFromCenter", kind: "bool", group: "tools",
    label: "shapeFromCenterLabel", desc: "shapeFromCenterDesc", default: false, refresh: "changed",
    get: (s) => s.shapeFromCenter,
    set: (s, v) => s.setShapeFromCenter(!!v),
  },
  {
    path: "tools.shapeSides", kind: "int", group: "tools",
    label: "sides", default: 6, min: 3, max: 32, unit: "◮", reset: 6, refresh: "changed",
    visible: (s) => s.tool === "polygon" || s.currentShape === "polygon",
    get: (s) => s.shapeSides,
    set: (s, v) => s.setShapeSides(Number(v)),
  },
  {
    path: "tools.defaultTool", kind: "enum", group: "tools",
    label: "defaultToolLabel", desc: "defaultToolDesc", default: "pencil", refresh: "changed",
    options: [
      { value: "pencil", label: "tools.pencil" }, { value: "eraser", label: "tools.eraser" },
      { value: "bucket", label: "tools.bucket" }, { value: "picker", label: "tools.picker" },
      { value: "airbrush", label: "tools.airbrush" },
      { value: "line", label: "tools.line" }, { value: "rect", label: "tools.rect" },
      { value: "ellipse", label: "tools.ellipse" }, { value: "circle", label: "tools.circle" },
      { value: "polygon", label: "tools.polygon" }, { value: "select", label: "tools.select" },
      { value: "wand", label: "tools.wand" }, { value: "lasso", label: "tools.lasso" },
    ],
    get: (s) => s.tool,
    set: (s, v) => s.setTool(String(v) as never),
  },
  {
    path: "tools.bucketGlobal", field: "bucketGlobal", kind: "bool", group: "tools",
    label: "bucketGlobalLabel", desc: "bucketGlobalDesc", default: false, refresh: "changed",
  },
  {
    path: "tools.fillSimilar", field: "fillSimilar", kind: "bool", group: "tools",
    label: "fillSimilarLabel", desc: "fillSimilarDesc", default: false, refresh: "changed",
    visible: (s) => s.tool === "bucket",
  },
  {
    path: "tools.fillTolerance", field: "fillTolerance", kind: "int", group: "tools",
    label: "fillToleranceLabel", desc: "fillToleranceDesc", default: 32, min: 0, max: 255,
    reset: 32, refresh: "changed",
    visible: (s) => s.tool === "bucket" && s.prefs.fillSimilar,
  },
  {
    path: "tools.fillGaps", field: "fillGaps", kind: "int", group: "tools",
    label: "fillGapsLabel", desc: "fillGapsDesc", default: 0, min: 0, max: 16, unit: "px",
    reset: 0, refresh: "changed",
    visible: (s) => s.tool === "bucket",
  },
  {
    path: "tools.bucketGrad", field: "bucketGrad", kind: "bool", group: "tools",
    label: "bucketGradLabel", desc: "bucketGradDesc", default: false, refresh: "changed",
    visible: (s) => s.tool === "bucket",
  },
  {
    path: "tools.bucketGradMode", field: "bucketGradMode", kind: "enum", group: "tools",
    label: "bucketGradModeLabel", desc: "bucketGradModeDesc", default: "rgb", refresh: "changed",
    visible: (s) => s.tool === "bucket" && s.prefs.bucketGrad,
    options: [
      { value: "rgb", label: "bucketGradRgb" },
      { value: "2", label: "bucketGrad2" },
      { value: "4", label: "bucketGrad4" },
      { value: "8", label: "bucketGrad8" },
    ],
  },
  {
    path: "tools.airbrushMin", kind: "int", group: "tools",
    label: "airbrushMinLabel", desc: "airbrushMinDesc", default: 1, min: 1, max: 16, unit: "px", reset: 1, refresh: "changed",
    visible: (s) => s.tool === "airbrush",
    get: (s) => s.prefs.airbrushMin,
    // the two bounds stay ordered: raising the floor lifts the ceiling too
    set: (s, v) => { s.prefs.airbrushMin = Number(v); if (s.prefs.airbrushMax < Number(v)) s.prefs.airbrushMax = Number(v); },
  },
  {
    path: "tools.airbrushMax", kind: "int", group: "tools",
    label: "airbrushMaxLabel", desc: "airbrushMaxDesc", default: 3, min: 1, max: 16, unit: "px", reset: 3, refresh: "changed",
    visible: (s) => s.tool === "airbrush",
    get: (s) => s.prefs.airbrushMax,
    set: (s, v) => { s.prefs.airbrushMax = Number(v); if (s.prefs.airbrushMin > Number(v)) s.prefs.airbrushMin = Number(v); },
  },
  {
    path: "tools.airbrushRate", field: "airbrushRate", kind: "int", group: "tools",
    label: "airbrushRateLabel", desc: "airbrushRateDesc", default: 20, min: 5, max: 60, unit: "/s", reset: 20, refresh: "none",
    visible: (s) => s.tool === "airbrush",
  },
  {
    path: "tools.wandTolerance", field: "selectionTolerance", kind: "int", group: "tools",
    label: "sel.wandTol", default: 8, min: 0, max: 64, unit: "T", reset: 8, refresh: "changed",
  },
  {
    // 变形控制点的吸附粒度：默认**半像素**（控制点可以落在两个像素之间的边界线上细调）。
    // 选区球的「变形」页里有一个同名开关项，改的就是这一条（见 ui/App.tsx 的 selWarpHalf）。
    path: "tools.selWarpHalfSnap", field: "selWarpHalfSnap", kind: "bool", group: "tools",
    label: "selWarpHalfSnap", desc: "selWarpHalfSnapDesc", default: true, refresh: "changed",
  },
  // ---- 自由变换的 sticky 开关（选区球「变形」页的 chip 行）----
  // 手机既没有 Shift / Alt / Ctrl，也没有 hover，所以修饰键那一套全部做成**看得见、
  // 点得到、状态高亮**的开关；PC 上 Shift / Ctrl / Alt 依然直接可用，判断时取「或」。
  {
    path: "tools.selXformAspect", field: "selXformAspect", kind: "bool", group: "tools",
    label: "selXfAspect", desc: "selXfAspectDesc", default: false, refresh: "none",
  },
  {
    path: "tools.selXformAngleSnap", field: "selXformAngleSnap", kind: "bool", group: "tools",
    label: "selXfAngleSnap", desc: "selXfAngleSnapDesc", default: false, refresh: "none",
  },
  {
    path: "tools.selXformGridSnap", field: "selXformGridSnap", kind: "bool", group: "tools",
    label: "selXfGridSnap", desc: "selXfGridSnapDesc", default: false, refresh: "none",
  },
  {
    path: "tools.selXformCopy", field: "selXformCopy", kind: "bool", group: "tools",
    label: "selXfCopy", desc: "selXfCopyDesc", default: false, refresh: "none",
  },

  // ------------------------------------------------------------ gesture
  {
    path: "gesture.longPressMs", field: "longPressMs", kind: "int", group: "gesture",
    label: "longPressMsLabel", desc: "longPressMsDesc", default: 300, min: 200, max: 800, unit: "ms", reset: 300, refresh: "none",
  },
  {
    path: "gesture.doubleTapMs", field: "doubleTapMs", kind: "int", group: "gesture",
    label: "doubleTapMsLabel", desc: "doubleTapMsDesc", default: 420, min: 250, max: 600, unit: "ms", reset: 420, refresh: "none",
  },
  {
    path: "gesture.tripleTapZoom", field: "tripleTapZoom", kind: "int", group: "gesture",
    label: "tripleTapZoomLabel", default: 2, min: 1, max: 4, unit: "×", reset: 2, refresh: "none",
  },
  {
    path: "gesture.fourFingerPx", field: "fourFingerPx", kind: "int", group: "gesture",
    label: "fourFingerPxLabel", desc: "fourFingerPxDesc", default: 15, min: 8, max: 40, unit: "px", reset: 15, refresh: "none",
  },
  {
    path: "gesture.autoPanMargin", field: "autoPanMargin", kind: "int", group: "gesture",
    label: "autoPanMarginLabel", default: 34, min: 16, max: 80, unit: "px", reset: 34, refresh: "none",
    visible: (s) => s.prefs.autoPan,
  },
  {
    path: "gesture.autoPanSpeed", field: "autoPanSpeed", kind: "int", group: "gesture",
    label: "autoPanSpeedLabel", default: 3, min: 1, max: 6, reset: 3, refresh: "none",
    visible: (s) => s.prefs.autoPan,
  },
  {
    path: "gesture.zoomMin", field: "zoomMin", kind: "enum", group: "gesture",
    label: "zoomMinLabel", default: "0.05", refresh: "none",
    options: [{ value: "0.05", label: "5%" }, { value: "0.1", label: "10%" }, { value: "0.25", label: "25%" }, { value: "0.5", label: "50%" }],
    get: (s) => String(s.prefs.zoomMin),
    set: (s, v) => { s.prefs.zoomMin = Number(v) || 0.05; },
  },
  {
    path: "gesture.zoomMax", field: "zoomMax", kind: "enum", group: "gesture",
    label: "zoomMaxLabel", default: "32", refresh: "none",
    options: [{ value: "8", label: "8×" }, { value: "16", label: "16×" }, { value: "32", label: "32×" }, { value: "64", label: "64×" }],
    get: (s) => String(s.prefs.zoomMax),
    set: (s, v) => { s.prefs.zoomMax = Number(v) || 32; },
  },
  {
    path: "gesture.haptic", field: "haptic", kind: "bool", group: "gesture",
    label: "hapticLabel", desc: "hapticDesc", default: true, refresh: "none",
    // a tick right when it is switched on, so the effect is obvious
    after: (s, v) => { if (v) bridge.vibrate(s.prefs.hapticLen, "开关"); },
    action: {
      label: "hapticTest",
      run: (s) => {
        const cap = bridge.canVibrate();
        const ms = s.prefs.hapticLen;
        const ok = bridge.vibrate(ms, "测试");
        // a second, clearly longer pulse 0.4s later so the two can be compared
        window.setTimeout(() => bridge.vibrate(120, "测试长"), 400);
        bridge.toast(ok ? "hapticTestOk" : cap === false ? "hapticTestNoMotor" : "hapticTestFail");
      },
    },
  },
  {
    path: "gesture.hapticLen", field: "hapticLen", kind: "enum", group: "gesture",
    label: "hapticLenLabel", desc: "hapticLenDesc", default: "60", refresh: "none",
    options: [
      { value: "30", label: "hapticLenShort" },
      { value: "60", label: "hapticLenMid" },
      { value: "100", label: "hapticLenLong" },
    ],
    get: (s) => String(s.prefs.hapticLen),
    set: (s, v) => { s.prefs.hapticLen = Math.max(20, Math.min(150, Number(v) || 60)); },
  },
  // one entry per gesture: which function it runs (see src/app/gestures.ts)
  ...GESTURES.map((g): SettingDef => ({
    control: "dropdown" as const,
    path: gesturePath(g.id),
    field: g.field as keyof Prefs,
    kind: "enum",
    group: "gesture",
    label: g.label,
    desc: g.desc,
    default: g.defaultAction,
    options: g.actions.map((a) => ({ value: a, label: GESTURE_ACTION_LABELS[a] })),
    refresh: "none",
  })),

  // -------------------------------------------------------------- onion
  {
    path: "onion.enabled", field: "onionOn", kind: "bool", group: "onion",
    label: "onion", default: false, refresh: "repaintAll",
  },
  {
    path: "onion.before", field: "onionBefore", kind: "int", group: "onion",
    label: "onionBefore", default: 1, min: 0, max: 3, unit: "f", reset: 1, refresh: "repaintAll",
    visible: (s) => s.prefs.onionOn,
    after: (s, v) => { if (Number(v) > 0) s.prefs.onionOn = true; },
  },
  {
    path: "onion.after", field: "onionAfter", kind: "int", group: "onion",
    label: "onionAfter", default: 0, min: 0, max: 3, unit: "f", reset: 0, refresh: "repaintAll",
    visible: (s) => s.prefs.onionOn,
    after: (s, v) => { if (Number(v) > 0) s.prefs.onionOn = true; },
  },
  {
    path: "onion.alpha", field: "onionAlpha", kind: "int", group: "onion",
    label: "onionAlpha", default: 55, min: 10, max: 100, unit: "%", reset: 55, refresh: "repaintAll",
    visible: (s) => s.prefs.onionOn,
  },
  {
    path: "onion.tint", field: "onionTint", kind: "bool", group: "onion",
    label: "onionTint", default: true, refresh: "repaintAll",
    visible: (s) => s.prefs.onionOn,
  },
  {
    // loop-aware onion skin: the frames before the first / after the last one
    // are shown too, in their own colour (blue / amber) so the wrap is obvious
    path: "onion.wrap", field: "onionWrap", kind: "bool", group: "onion",
    label: "onionWrapLabel", desc: "onionWrapDesc", default: true, refresh: "repaintAll",
    visible: (s) => s.prefs.onionOn,
  },

  // ------------------------------------------------------------ history
  {
    path: "history.mode", field: "histMode", kind: "enum", group: "history",
    label: "histMode", default: "steps", refresh: "changed",
    options: [{ value: "steps", label: "histModeSteps" }, { value: "full", label: "histModeFull" }],
    after: (s) => s.applyHistoryLimit(),
  },
  {
    path: "history.steps", field: "histSteps", kind: "int", group: "history",
    label: "histStepsLabel", default: 120, min: 10, max: 500, reset: 120, refresh: "changed",
    visible: (s) => s.prefs.histMode !== "full",
    after: (s) => s.applyHistoryLimit(),
  },

  // ------------------------------------------------------------ display
  {
    path: "display.theme", field: "theme", kind: "enum", group: "display",
    label: "uiTheme", desc: "uiThemeDesc", default: "dark", refresh: "none",
    options: [{ value: "dark", label: "themeDark" }, { value: "light", label: "themeLight" }],
    after: (_s, v) => { applyTheme(v); },
  },
  {
    path: "display.pcMode", kind: "enum", group: "display",
    label: "pcMode", desc: "pcModeDesc", default: "auto", refresh: "none",
    options: [{ value: "auto", label: "pcModeAuto" }, { value: "on", label: "pcModeOn" }, { value: "off", label: "pcModeOff" }],
    get: (s) => pcModeOf(s.prefs),
    set: (s, v) => { s.prefs.pcMode = (v === "on" || v === "off") ? v : "auto"; },
    after: (s) => { applyPcMode(pcModeOf(s.prefs)); },
  },
  {
    // 快捷圆盘（**仅电脑模式**：装备槽与发动键都只在 PC 存在，移动端不显示这两项）
    path: "display.pieItem", field: "pieItem", kind: "int", group: "display",
    label: "pieItemLabel", desc: "pieItemDesc", default: 58, min: 36, max: 96, unit: "px", reset: 58, refresh: "none",
    visible: (s) => pcModeOn(s.prefs.pcMode),
  },
  {
    path: "display.pieRadius", field: "pieRadius", kind: "int", group: "display",
    label: "pieRadiusLabel", desc: "pieRadiusDesc", default: 0, min: 0, max: 520, unit: "px", reset: 0, refresh: "none",
    visible: (s) => pcModeOn(s.prefs.pcMode),
  },
  {
    path: "display.previewBg", field: "previewBg", kind: "enum", group: "display",
    label: "previewBg", default: "white", refresh: "changed",
    options: [{ value: "white", label: "previewWhite" }, { value: "black", label: "previewBlack" }, { value: "checker", label: "previewChecker" }],
  },
  {
    path: "display.previewGray", field: "previewGray", kind: "bool", group: "display",
    label: "previewGray", desc: "previewGrayDesc", default: false, refresh: "changed",
  },
  {
    path: "display.loupe", field: "loupe", kind: "bool", group: "display",
    label: "loupe", default: true, refresh: "changed",
  },
  {
    path: "display.renderDebug", field: "renderDebug", kind: "bool", group: "display",
    label: "renderDebug", desc: "renderDebugDesc", default: false, refresh: "changed",
  },
  {
    path: "display.magZoom", field: "magZoom", kind: "int", group: "display",
    label: "magZoom", default: 12, min: 8, max: 20, unit: "px", reset: 12, refresh: "changed",
  },
  {
    path: "display.recentColors", field: "recentColorsMax", kind: "int", group: "display",
    label: "recentColorsMax", default: 16, min: 4, max: 64, reset: 16, refresh: "changed",
    after: (s) => s.trimRecentColors(),
  },
  {
    path: "display.shadowTarget", kind: "enum", group: "display",
    label: "shadowMode", default: "cur", refresh: "changed",
    options: [{ value: "cur", label: "shadowCur" }, { value: "new", label: "shadowNew" }],
    get: (s) => (s.prefs.shadowNewLayer ? "new" : "cur"),
    set: (s, v) => { s.prefs.shadowNewLayer = v === "new"; },
  },

  // --------------------------------------------------------------- data
  {
    path: "data.recordHistory", field: "recordHistory", kind: "bool", group: "data",
    label: "recordHistoryLabel", desc: "recordHistoryDesc", default: true, refresh: "none",
  },
  {
    path: "data.autosave", field: "autosave", kind: "bool", group: "data",
    label: "autosave", default: true, refresh: "none",
    after: (s, v) => { if (v) s.scheduleAutosave(); },
  },
  {
    path: "data.autosaveMin", field: "autosaveMin", kind: "int", group: "data",
    label: "autosaveMinLabel", desc: "autosaveMinDesc", default: 5, min: 1, max: 60,
    unit: "min", reset: 5, refresh: "none",
    visible: (s) => s.prefs.autosave,
  },
  {
    path: "data.autosaveKeep", field: "autosaveKeep", kind: "int", group: "data",
    label: "autosaveKeepLabel", desc: "autosaveKeepDesc",
    default: AUTOSAVE_KEEP_DEFAULT, min: 1, max: AUTOSAVE_KEEP_MAX,
    reset: AUTOSAVE_KEEP_DEFAULT, refresh: "none",
    visible: (s) => s.prefs.autosave,
  },

  // ---------------------------------------------------------------- ai
  // 本地端口服务（C3）：三个声明 + 一个自有存储（见文件上方 AI 本地服务设置 一节）。
  // 值不落在 prefs 上，所以这里一律用 get/set；改完由 saveAiServeSettings 通知 ai-serve 即时起停。
  {
    path: "ai.server", kind: "bool", group: "ai",
    label: "aiServerLabel", desc: "aiServerDesc", default: false, refresh: "none",
    get: () => aiServeSettings().server,
    set: (_s, v) => { saveAiServeSettings({ server: v === true }); },
  },
  {
    path: "ai.port", kind: "int", group: "ai",
    label: "aiPortLabel", desc: "aiPortDesc",
    default: AI_RPC_DEFAULT_PORT, min: AI_PORT_MIN, max: AI_PORT_MAX,
    reset: AI_RPC_DEFAULT_PORT, refresh: "none",
    visible: () => aiServeSettings().server,
    get: () => aiServeSettings().port,
    set: (_s, v) => { saveAiServeSettings({ port: Number(v) }); },
  },
  {
    path: "ai.tier", kind: "enum", group: "ai",
    label: "aiTierLabel", desc: "aiTierDesc", default: AI_RPC_DEFAULT_TIER, refresh: "none",
    visible: () => aiServeSettings().server,
    options: [
      { value: "read", label: "aiTierRead" },
      { value: "draw", label: "aiTierDraw" },
      { value: "all", label: "aiTierAll" },
    ],
    get: () => aiServeSettings().tier,
    set: (_s, v) => { saveAiServeSettings({ tier: v as AiServiceTier }); },
  },
  {
    path: "ai.turnIdleSec", kind: "int", group: "ai",
    label: "aiTurnIdleLabel", desc: "aiTurnIdleDesc",
    default: AI_TURN_IDLE_SEC_DEFAULT, min: 0, max: AI_TURN_IDLE_SEC_MAX,
    unit: "s", reset: AI_TURN_IDLE_SEC_DEFAULT, refresh: "none",
    visible: () => aiServeSettings().server,
    get: () => aiServeSettings().turnIdleSec,
    set: (_s, v) => { saveAiServeSettings({ turnIdleSec: Number(v) }); },
  },
];

export const SETTINGS: SettingDef[] = defs;
/** 设置页要渲染的全部声明 = 可导出的那张表 + 助手那一组（后者不导出，见上方那一节） */
const allDefs: SettingDef[] = defs.concat(CHAT_SETTINGS);
export const SETTINGS_BY_PATH: Map<string, SettingDef> = new Map(allDefs.map((d) => [d.path, d]));

/** settings of one group, in declaration order (visible ones only) */
export function settingsOfGroup(s: Session, g: SettingGroupId): SettingDef[] {
  return allDefs.filter((d) => d.group === g && (!d.visible || d.visible(s)));
}

/** coerce a raw value to the definition's kind/bounds; null = reject */
export function normalizeSetting(def: SettingDef, raw: SettingValue): SettingValue | null {
  if (def.text) return clipSettingText(String(raw ?? ""));
  if (def.kind === "bool") return !!raw;
  if (def.kind === "int") {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) return null;
    const lo = def.min ?? -Infinity, hi = def.max ?? Infinity;
    return Math.max(lo, Math.min(hi, n));
  }
  const opts = def.options ?? [];
  const v = String(raw);
  if (def.kind === "color") return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null;
  return opts.some((o) => o.value === v) ? v : null;
}
