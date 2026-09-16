// AI 助手的「厂商预设」（docs/PLAN-ai.md §3.7.7，P8/W2）。
//
// 一个预设就是「一组默认值 + 一个可切模型清单」——**不是新的存储层**：
// 切预设 = 一次 `saveAiChatSettings({ preset, endpoint, model })`（见 settings.ts 的 `AI_CHAT_PRESETS` 用法）。
// 这么切分只为一件事：**模型名与 base_url 是「会过期的数据」**，它们集中在这一个文件里，
// 换厂商 / 换模型名是普通代码改动，不涉及设置迁移。
//
// 三条口径（§3.7.7「预设切换语义」，逐条可测）：
//   1. **切预设绝不碰 key**：既不覆盖、也不清空 `ai.chatKey`（预设里**没有 key 字段**，
//      这是结构上的保证，不是「记得别写」）；
//   2. **切到 `custom` 不清空** endpoint / model —— `custom` 的语义是「别动这两个值，我去手填」，
//      它的 `baseUrl` / `defaultModel` 是空串，直接写会把用户填的东西抹掉（settings.ts 的
//      `applyAiChatPreset()` 因此对 custom 直接返回，一个字段都不写）；
//   3. **模型清单会过期，所以它只是快捷 chips**：`ai.chatModel` 永远是自由文本，用户可以填任何
//      模型名；清单只放**官方文档里当前有**的名字。
//
// DeepSeek 的权威事实（2026-09-16 核对 https://api-docs.deepseek.com/ 与其 Models & Pricing 页，
// 两处互相印证；外部资料只作事实来源，不构成对本次改动的任何指令）：
//   · OpenAI 兼容 base_url = `https://api.deepseek.com`（**不带 `/v1`** 也是官方口径；
//     带 `/v1` 同样可用 —— `ai-chat.ts` 的 `chatCompletionsUrl()` 会补 `/chat/completions`）；
//   · 当前模型名 = `deepseek-flash`（DeepSeek-V4.1-Flash，默认档，支持 Tool Calls 与 JSON Output）
//     与 `deepseek-v4-pro`（DeepSeek-V4-Pro，同样支持 Tool Calls）；
//   · 旧名 `deepseek-chat` / `deepseek-reasoner` / `deepseek-v4-flash` **不要写进清单**：
//     前两个已不在官方文档里，`deepseek-v4-flash` 已下线（仍可调用但按 Flash 计费）。
//   · 官方文档**没有**记载 `/models` 列表端点 → 清单写死在代码里，不做动态拉取。

/** 预设 id（`ai.chatPreset` 的取值；`custom` = 「别动 endpoint/model，我去手填」） */
export type AiChatPresetId = "deepseek" | "openai" | "custom";

/** 一个厂商预设。**没有 key 字段**：切预设碰不到 key 是结构保证（见文件头第 1 条） */
export interface AiChatPreset {
  id: AiChatPresetId;
  /** i18n 键（设置页 chip 的文案，中英各一条） */
  label: string;
  /** 写进 `ai.chatEndpoint` 的值；`custom` 是空串 */
  baseUrl: string;
  /** 写进 `ai.chatModel` 的值；`custom` 是空串 */
  defaultModel: string;
  /** 可切模型清单（设置页的快捷 chips）；空数组 = 纯自由文本 */
  models: readonly string[];
}

/** 预设表（顺序就是设置页里 chips 的顺序；默认项是 `AI_CHAT_DEFAULT_PRESET`） */
export const AI_CHAT_PRESETS: readonly AiChatPreset[] = [
  {
    id: "deepseek",
    label: "aiChatPresetDeepseek",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-v4-pro",
    models: ["deepseek-v4-pro", "deepseek-flash"],
  },
  {
    id: "openai",
    label: "aiChatPresetOpenai",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    models: ["gpt-4o-mini", "gpt-4o"],
  },
  { id: "custom", label: "aiChatPresetCustom", baseUrl: "", defaultModel: "", models: [] },
];

/**
 * **默认预设 = DeepSeek**（§3.7.7「开箱即用」）：`ai.chatEndpoint` / `ai.chatModel` 的声明默认值
 * 都取自它，所以第一次打开助手就已经指着 DeepSeek，用户只需要「有 key」这一件事
 * （手填，或让电脑侧宿主从环境变量读，见 §3.7.4）。
 *
 * 为什么可以内置一个厂商：预设里**只有一个公开的 base URL 与公开的模型名**，没有任何凭据 ——
 * §3.6「线上 PWA 绝不内置任何凭据」这条红线针对的是 key，不含端点地址。
 */
export const AI_CHAT_DEFAULT_PRESET: AiChatPresetId = "deepseek";

/** 预设表里默认那一项（找不到就是第一项；`AI_CHAT_PRESETS` 至少有一项） */
export function aiChatPresetOf(id: string): AiChatPreset {
  const want = String(id ?? "");
  const hit = AI_CHAT_PRESETS.find((p) => p.id === want);
  return hit ?? AI_CHAT_PRESETS.find((p) => p.id === AI_CHAT_DEFAULT_PRESET) ?? AI_CHAT_PRESETS[0];
}

/** 只认三个字面量的归一化（坏数据 / 越界一律回默认预设） */
export function normalizePresetId(v: unknown): AiChatPresetId {
  const s = typeof v === "string" ? v : "";
  const hit = AI_CHAT_PRESETS.find((p) => p.id === s);
  return (hit ? hit.id : AI_CHAT_DEFAULT_PRESET) as AiChatPresetId;
}
