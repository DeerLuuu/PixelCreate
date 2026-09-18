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
// 第 4 条（2026-09 追加，参考图 / vision）：清单里的每一项不只是个名字，还带一个**图像能力位**
// （`AiModelInfo.vision`）。理由与「模型名会过期」是同一条 —— 这是**会过期的数据**，
// 所以集中在这一个文件里：`visionOfModel()` 是唯一的查表点，`ai-chat.ts` 只拿它的三态结果
// 决定「挂图能不能发」。**不要在 UI 或 ai-chat 里另写一份模型名清单。**
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
//   · **图像理解**（vision，2026-09-16 同一页核对）：`deepseek-flash` 支持（JPEG / PNG / GIF / WebP，
//     **按文件实际内容判格式**，不看文件名或声明的 MIME）；`deepseek-v4-pro` **不支持**。
//     旧名 `deepseek-v4-flash-vision-exp` 仍可调用但该模型已下线，请求由最新 Flash 承接。

/** 预设 id（`ai.chatPreset` 的取值；`custom` = 「别动 endpoint/model，我去手填」） */
export type AiChatPresetId = "deepseek" | "openai" | "custom";

/**
 * **能不能收图**（vision / 图像理解）——三态，不是布尔。
 *
 * 为什么必须有 `unknown` 这一档：`ai.chatModel` 是**自由文本**，用户随时能填一个我们
 * 没听说过的名字（自建网关 / 换厂商 / 填了个中转站的别名）。把「不认识」当成 `no`
 * 会把这些用户**全部拦死**（他们本来能用），当成 `yes` 又会让 `deepseek-v4-pro`
 * 拿着图去撞一个必然的 HTTP 400。所以不认识就是 `unknown`：**允许发送**，UI 上多一句
 * 风险说明，让用户自己承担（错了也有明确的中文报错指回来）。
 */
export type AiVision = "yes" | "no" | "unknown";

/** 一个可切模型的元信息：**名字 + 能力位**（模型名是「会过期的数据」，集中在这一个文件里） */
export interface AiModelInfo {
  /** 模型名（写进 `ai.chatModel` 的那个字符串，逐字匹配） */
  id: string;
  /** 图像理解能力（见 `AiVision`） */
  vision: AiVision;
}

/** 一个厂商预设。**没有 key 字段**：切预设碰不到 key 是结构保证（见文件头第 1 条） */
export interface AiChatPreset {
  id: AiChatPresetId;
  /** i18n 键（设置页 chip 的文案，中英各一条） */
  label: string;
  /** 写进 `ai.chatEndpoint` 的值；`custom` 是空串 */
  baseUrl: string;
  /** 写进 `ai.chatModel` 的值；`custom` 是空串 */
  defaultModel: string;
  /** 可切模型清单（设置页的快捷 chips，**带能力位**）；空数组 = 纯自由文本 */
  models: readonly AiModelInfo[];
}

/** 预设表（顺序就是设置页里 chips 的顺序；默认项是 `AI_CHAT_DEFAULT_PRESET`） */
export const AI_CHAT_PRESETS: readonly AiChatPreset[] = [
  {
    id: "deepseek",
    label: "aiChatPresetDeepseek",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-v4-pro",
    // 能力位（2026-09-16 核对官方 Models & Pricing 页的「图像理解」一列）：
    //   · `deepseek-flash` **支持**图像理解（JPEG / PNG / GIF / WebP，按**内容**判格式）；
    //   · `deepseek-v4-pro` **不支持** —— 挂图发过去必然是 HTTP 400，所以先在本地拦下。
    models: [
      { id: "deepseek-v4-pro", vision: "no" },
      { id: "deepseek-flash", vision: "yes" },
    ],
  },
  {
    id: "openai",
    label: "aiChatPresetOpenai",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    // 这两条的图像能力**官方是支持的**，但我们的助手从没对着 OpenAI 端点跑过挂图请求，
    // 而 `unknown` 的语义是「允许发送 + UI 多一句风险说明」—— 不认识的模型走这条路最稳；
    // 也免得以后加了新模型忘了改这里就把用户拦死。
    models: [
      { id: "gpt-4o-mini", vision: "unknown" },
      { id: "gpt-4o", vision: "unknown" },
    ],
  },
  { id: "custom", label: "aiChatPresetCustom", baseUrl: "", defaultModel: "", models: [] },
];

/**
 * **模型名 → 图像能力**的三态查表（见 `AiVision`）。口径（逐条可测）：
 *
 *   · 表里命中的名字 → 表里那一档；
 *   · `deepseek-v4-flash-vision-exp` → `yes`：该模型**名字**已下线，但请求由最新 Flash 承接
 *     （官方口径），而 Flash 是支持图像的 —— 所以挂图仍然发得出去；
 *   · 表里没有的名字 → `unknown`（**允许发送**，UI 上带一句风险说明）。
 *
 * 只把官方**明确记载**的模型写进表；预设之外的名字一律 `unknown`，绝不替用户做否定判断
 * （否定的代价是「本来能用的人被拦死」）。
 */
const MODEL_VISION: readonly AiModelInfo[] = [
  { id: "deepseek-flash", vision: "yes" },
  // 旧名（已下线，请求由最新 Flash 承接）：能力跟着承接方走，所以是 yes
  { id: "deepseek-v4-flash-vision-exp", vision: "yes" },
  { id: "deepseek-v4-pro", vision: "no" },
];

/**
 * 模型名 → 三态能力位。**纯函数、大小写与首尾空白都容忍**（模型名是用户手填的自由文本，
 * 多一个空格不该把能力判成 unknown；但除了 trim + 小写之外不做任何模糊匹配 ——
 * 猜错方向的两端代价不对称，见 `AiVision`）。
 */
export function visionOfModel(model: string): AiVision {
  const want = String(model ?? "").trim().toLowerCase();
  if (!want) return "unknown";
  const hit = MODEL_VISION.find((m) => m.id === want);
  return hit ? hit.vision : "unknown";
}

/** 只把「明确支持」当支持：`unknown` 也要放行（它是「不知道」，不是「不行」） */
export function modelAcceptsImages(model: string): boolean {
  return visionOfModel(model) !== "no";
}

/** 表里**明确支持**图像理解的模型名（拦下挂图时用来告诉用户「该换哪个」，UI 文案要具体） */
export function visionCapableModels(): string[] {
  return MODEL_VISION.filter((m) => m.vision === "yes").map((m) => m.id);
}

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
