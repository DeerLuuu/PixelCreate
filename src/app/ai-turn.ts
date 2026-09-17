// C2 回合事务（docs/PLAN-ai.md §3.3「一轮 = 一条 undo」/ §5.1 C2 契约）：
// 把 AI 一轮里的几十次写操作合成**一条**可撤销历史，并在回合中间一个字节都不写盘。
//
// 为什么一轮只落一条历史：
//   `prefs.histSteps` 默认 120 条，而一轮 AI 动辄几十次调用 —— 逐次压栈会把用户自己的撤销
//   挤掉（§2「现有缺口」就是这么写的）。所以回合期间把 `History` 的三个**压栈入口**临时摘掉，
//   只在 `commitTurn()` 时用「回合开始快照 → 回合结束快照」合成一条记录：用户按一次撤销，
//   整轮 AI 的改动一起收回。
//
// 为什么 begin 要快照**全部画布**（不只当前那张）：
//   `Session` 的历史是**整个工程共用一条**的，一步记录会记住自己改的是哪个 `doc`
//   （`History.Entry.doc`，见 engine/history.ts）；多画布工程里 AI 一样能跨画布写
//   （引用图层、多画布）。只快照当前画布的话 `rollbackTurn()` 会把别的画布留在半改状态，
//   而 C2 的验收口径是「rollback 后逐字节一致」。代价是 begin/commit 各一次全量
//   `doc.capture()` —— 结构快照本来就是这个量级，`Session.struct()` 一直这么干。
//
// 为什么回合期间不刷 autosave：
//   自动保存写的是「磁盘上那件作品」。回合中间写的是一份**可能马上被 rollback 掉**的半成品，
//   存下去只会让崩溃恢复拿到一个「模型中途失败」的残局。做法是 `Session.aiTurnAutosaveHeld`
//   这一面**独立**的旗（与回放查看器的 `replayActive` 互不覆盖，两个字段在闸门处做 OR），
//   `scheduleAutosave()` / `flushAutosave()` / 非强制的 `writeAutosave()` 都会早退；
//   回合开始时还会 `clearTimeout` 掉**已经排定**的那一次（回合拖过 autosaveMin 也不会写盘），
//   `commitTurn()` 之后补一次。
//
// 怎么用（**C3/C5 的回合只用这一个入口**）：
//   const r = await runAiTurn("描出史莱姆轮廓并铺底色", async () => { …callTool… ; return 摘要; });
//   r.ok ? 用 r.result : 报 r.error
//   **不要**自己手写 begin / try / commit / rollback：漏掉任何一条失败路径都会留下
//   「回合一直开着」的残留 —— 历史不落、autosave 被永久压住、**用户此后的写入会被下一次
//   rollback 吞掉**（见下面的调用方义务）。
//
// 调用方义务（写死，别改回去）：
//   1. 一轮 AI 的**全部**写操作都包在 `runAiTurn(label, fn)` 里；`fn` 里只放工具调用，
//      不要自己 begin/commit/rollback（嵌套 begin 会先把外层的回合丢弃掉）。
//   2. 任何失败 / 取消 / 超时路径都必须以 rollback 收尾（用 `runAiTurn` 就自动有了）。
//      **回合开着时用户的写入会被回滚吞掉** —— 回合只该覆盖 AI 自己的操作，所以回合期间
//      不要放行用户 / UI 的写入（C3 的服务层负责这道门）。
//   3. 需要「先看后应用」时用 `previewTurn()` 预览（只算不改文档），确认后才 `commitTurn()`；
//      `commitTurn()` 一轮只调一次，它在无改动时返回 false（不是失败）。
//   4. 「更稳的方案」（给 `engine/history.ts` 加显式批量抑制开关 + 会话级看门狗）本轮**不做**：
//      t14 决定不碰 History 的既有语义（回归面太大），缺口记在已知问题里，留给后续版本。
//
// 口径（不要改回去）：
//   1. 历史标签固定加前缀 `ai: `（§3.3，历史面板里一眼认出）；调用方自己带了 `ai: ` 不会重复。
//   2. 失败口径一律**不抛异常**：回合没开时 commit → `false`、rollback → no-op、
//      preview → `{count:0, rect:null}`、isTurnOpen → `false`。
//   3. `commitTurn()` 只在**文档内容**真的变了才压栈（cel 字节 / 调色板 / 图层帧标签 / 选区 /
//      画布尺寸）；只有画布位置或焦点变了 → `false` 且不压栈（历史里不该有内容相同的空步）。
//   4. 未落定的笔迹 / 浮动变形按 `View.flushStroke()` 的口径处理：commit 前与 rollback 前
//      都先 flush 一次（这时历史还关着，所以不会多出历史步骤），rollback 紧接着把文档恢复到
//      回合开始 —— 于是「回滚后与新开时逐字节一致」对多层多帧都成立。
//   5. 单画布回合用 `History.pushStruct`（带 before/after 快照，能进 .pxc 的历史）；跨画布
//      回合用 `History.record` 的闭包（一条 undo 覆盖所有画布，但没有可序列化的 payload，
//      `History.dump()` 会把它和更早的步骤丢掉 —— 多画布 AI 回合很少见，换的是「一条 undo」）。
//   6. `pixelRev` 不在「逐字节一致」的比较口径里：`Doc.restore()` 自己会 `pixelRev++`
//      （引擎既有语义），它只是渲染缓存键，不是内容。`Sel.ver` 同理。
//   7. `mark()` 只累计**操作数**并让脏矩形缓存失效（C1 的 callTool 每成功一次写操作调一次）；
//      脏矩形由 `previewTurn()` 在调用时逐字节比对得出 —— 不在每次 mark 里重扫全画布。
//   8. 回合只挡「AI 的写操作落历史」：用户自己在回合中间按了撤销/重做，动的仍是既有历史
//      （AI 回合不接管用户操作；C3 的服务层应在回合期间不放行 UI 写入）。
//   9. `beginTurn` **先发布回合**（`activeTurn = t`）再挂闸门 / 压 autosave，任何一步抛错都在
//      catch 里把闸门与抑制还原后重抛 —— 不会留下「闸门挂着但 `activeTurn` 还是 null」的
//      不可恢复窗口（t14-P3：那种状态下谁都调不动 rollback）。
//  10. `runAiTurn()` 的 `ok` = 回合**正常收尾**（`fn` 没抛异常；无改动也是 true）；
//      `fn` 抛异常 → rollback + 把异常装进 `error` 返回（**不重抛**，调用方看 `ok:false` 即可）。
//      压栈中途出错这种情况由 `commitTurn` 内部记 `lastCommitError`，`runAiTurn` 会把它
//      转成 `ok:false`（否则「压根没落盘」会被误报成成功）。
//  11. **按步撤回**（B2，`revertTurnStep(n)`）只在**预览回合**里有意义，语义定死：
//      「撤回第 n 步 = 文档回到第 n 步执行**之前**，第 n 步及之后一并作废」。三条边界：
//        · **单画布**才可用：这一步碰了别的画布 / 画布集合变了 → 当场禁用（`stepOff`），
//          `previewTurn().steps.revert.reason` 给一句人话，UI 显示「本回合不支持按步撤回」；
//          **不静默少留几步** —— 那会让「撤回第 n 步」指向一个错的过去，比禁用危险得多。
//        · **预算 32 MiB**（`AI_TURN_STEP_BUDGET_BYTES`，依据见那里的注释）：超了同样禁用，
//          退回「只能整轮回滚」。
//        · 撤回**不碰历史**（回合期间历史本来就是打桩的）：点「应用」时仍然只压**一条**
//          覆盖整轮的 struct。撤回之后**不再让模型接着跑** —— 消息线程里还留着被撤掉那些
//          步骤的 tool 结果，模型会基于一份不存在的过去继续推理（用户定死的口径）。
//  12. 步骤表（`TurnState.steps`）的下标 = **`mark()` 的次数**（= 文档真被改了几次），
//      不是 `callTool` 的次数：只读 / 失败 / 被用户取消的调用一步都不占（`mark()` 不会触发，
//      `endTurnStep()` 把那份没用的「执行前」快照丢掉）。所以 `revertTurnStep(n)` 的 n
//      总能指到一次真的写入上。

import type { Doc, DocSnapshot, Sel } from "../engine/doc";
import type { History } from "../engine/history";
import type { Rect } from "../engine/types";
import type { CanvasEntry } from "./session";

/** 回合预览：`count` = 这一轮被 `mark()` 记下的操作数；`rect` = 与回合开始逐字节比对出的像素改动包围盒 */
export interface AiTurnPreview {
  count: number;
  rect: Rect | null;
  /** 按步撤回的现状（见 `previewTurnSteps()`）；**回合没开时是 `null`** */
  steps: AiTurnStepPreview | null;
  /** 当前实况的文档版本号（撤回之后它就是撤回后的值） */
  docRev: number;
}

/** `previewTurn().steps`：这一轮的步骤表 + 按步撤回还能不能用 */
export interface AiTurnStepPreview {
  /** **能撤回的**步骤（`reverted` 为真的已经作废；撤回之后再撤到更早，它们一起从这张表里消失） */
  steps: AiTurnStepInfo[];
  /** 这一步的下标（`AiTurnStepInfo.index`）→ 撤回后要拿它传给 `revertTurnStep()` */
  revert: AiTurnStepRevert;
  /** 当前实况下与「本轮基线」逐字节比对出的改动包围盒 */
  rect: Rect | null;
  /** 落定后会压进历史的那条记录能覆盖的**操作总数**（含被撤回的那些） */
  count: number;
}

/** 一条步骤的摘要（纯数据，给 UI 显示用；**不含快照**） */
export interface AiTurnStepInfo {
  /** 1 起。**它就是 `revertTurnStep(n)` 的 n** */
  index: number;
  /** 工具名（步骤标签） */
  label: string;
  /** 这一步执行**之前**的文档版本号 */
  docRevBefore: number;
  /** 这一步执行**之后**的文档版本号 */
  docRevAfter: number;
  /** 这一步改动的像素矩形（与下一步的「执行前」逐字节比对得出；上一步没动就是 null） */
  changed: Rect | null;
  /** 这一步花了多少毫秒（`ai-chat` 量的真耗时；没量到就是 0） */
  durationMs: number;
  /** 已经被「撤回」作废（文档回到它执行之前，它和它之后的步骤都不作数了） */
  reverted: boolean;
}

/** 按步撤回的可用性（`ok:false` 时 `reason` 一定非空，UI 直接显示它） */
export interface AiTurnStepRevert {
  ok: boolean;
  reason?: string;
  /** 已经用掉的快照字节数（`AI_TURN_STEP_BUDGET_BYTES` 是上限） */
  usedBytes: number;
  /** 上限本身（UI 要显示「多大算太大」时用它，不要在 UI 里抄常量） */
  budgetBytes: number;
}

/** C1 定死的回合句柄形状（`AiToolCtx.turn`）：callTool 每成功一次写操作调用一次 `mark()` */
export interface AiTurnHandle {
  isOpen(): boolean;
  mark(): void;
}

/**
 * **按步撤回**（B2）的内部句柄：`ai-chat` 在每一次工具调用前后各调一次。
 *
 * 为什么不塞进 `AiTurnHandle`：C1 把 `AiToolCtx.turn` 的形状钉成 `{isOpen, mark}`，
 * 而「这一步从哪开始」是**整轮循环**才知道的事（`callTool` 自己不该关心）。所以这两条
 * 走模块级自由函数（与 `beginAiTurn` 同一条路），`ai-tools` 一个字节都不用改。
 */
export interface AiTurnStepHandle {
  /** 一次工具调用**开始**：记下「执行前」快照（能不能按步撤回在这里判） */
  begin(label: string): void;
  /** 一次工具调用**结束**：这一步真改了文档才落进步骤表（只读 / 失败 / 取消都丢掉） */
  end(): void;
}

/**
 * `runAiTurn()` 的结果。`ok` = 回合正常收尾（`fn` 没抛异常；无改动、没压栈也是 true）；
 * `ok:false` 一定带 `error`（`fn` 抛出的东西原样带回，或者回合压根没打开 / 收尾失败）。
 */
export interface AiTurnRunResult<T> {
  ok: boolean;
  result?: T;
  error?: unknown;
}

/**
 * 回合宿主 = `Session` 的公开面。这里刻意只用公开成员（结构类型），
 * 所以 ai-turn 不需要 import Session 的运行时值，也就没有循环依赖。
 */
export interface AiTurnSession {
  docs: CanvasEntry[];
  docIdx: number;
  layerIdx: number;
  frameIdx: number;
  readonly doc: Doc;
  history: History;
  readonly view: { flushStroke(): boolean } | null;
  curLayer(): number;
  curFrame(): number;
  syncAll(): void;
  syncAfterDocChange(): void;
  /** 回合期间抑制自动保存（`Session` 里用与 `replayActive` 同一面旗）；必须幂等 */
  aiTurnAutosaveSuppressed(on: boolean): void;
}

/** 固定的标签前缀（§3.3） */
export const AI_TURN_LABEL_PREFIX = "ai: ";
/** 标签正文最长字符数（超出截断，免得历史面板被一行长文撑爆） */
export const AI_TURN_LABEL_MAX = 80;
/** 空标签时的兜底正文 */
export const AI_TURN_LABEL_FALLBACK = "未命名回合";

// ------------------------------------------------------------------ 按步撤回（B2）

/**
 * **按步撤回的快照预算：32 MiB**（`AI_TURN_STEP_REVERT_MAX_BYTES_PER_DOC` × 4 张画布）。
 *
 * 怎么算的：一步一份**结构快照**（`Doc.capture()` 的深拷贝），代价 ≈ `宽 × 高 × 4 × cel 数`。
 * 像素画的常态（64² · 2 图层）一步只有 32 KiB，整轮几十步也就几 MB；而最重的一档
 * （1024² · 4 图层，见 `AI_TURN_STEP_REVERT_MAX_BYTES_PER_DOC`）**一步就是 16 MiB** ——
 * 两步就顶到 32 MiB，于是这一轮干脆不逐留快照，只能整轮回滚（历史栈里那条 undo 照旧）。
 *
 * 为什么是这个量级：`prefs.histSteps` 默认 120 条，历史本身就用 `pushStruct` 存整档快照
 * （`Session.struct()`），也就是「120 份快照」是这套代码**本来就接受**的内存口径；
 * 给一个回合的撤留 32 MiB（≈ 最重档 2 步 / 常态 1024 步）远低于历史栈的常态占用，
 * 又足够覆盖像素画里真实的一轮 AI（几十次调用）。**超了就退回「只能整轮回滚」**，
 * 不是静默少留几步 —— 少留几步会让「撤回第 n 步」指向一个错的过去，比禁用危险得多。
 */
export const AI_TURN_STEP_BUDGET_BYTES = 32 * 1024 * 1024;
/** 单张画布在「最重档」下的一份快照字节数（1024² × 4 图层 × 4 通道 = 16 MiB）；仅用于文档与测试口径 */
export const AI_TURN_STEP_REVERT_MAX_BYTES_PER_DOC = 1024 * 1024 * 4 * 4;
/** 禁用原因：超预算 */
export const AI_TURN_STEP_OFF_TOO_BIG = "本回合太大，不支持按步撤回（只能整轮回滚）";
/** 禁用原因：跨画布 */
export const AI_TURN_STEP_OFF_CROSS_CANVAS = "这一轮改到了多张画布，不支持按步撤回（只能整轮回滚）";

// ------------------------------------------------------------------ 内部状态

/** 一张画布在回合开始（或结束）时的样子：内容快照 + 它在工程里的位置/选择 */
interface TurnDocState {
  /** 画布 id；null = 没有画布时的替身文档（`Session.doc` 的 emptyDoc） */
  id: string | null;
  doc: Doc;
  snap: DocSnapshot;
  x: number;
  y: number;
  li: number;
  fi: number;
  locked: boolean;
  group: string | null;
}

/** 整个工程在某一刻的样子（全部画布 + 焦点 + 当前图层/帧） */
interface DocSetState {
  docs: TurnDocState[];
  docIdx: number;
  layerIdx: number;
  frameIdx: number;
}

/**
 * 一步的「执行前」快照（B2 的核心状态）。**只存一张画布**（见 `StepSnap` 的注释），
 * 并且只存那一步真正要用的东西：内容快照 + 当前图层/帧 + 版本号 + 预计算的字节代价。
 */
interface StepSnap {
  /** 画布 id（`null` = 没有画布时的替身文档） */
  id: string | null;
  doc: Doc;
  snap: DocSnapshot;
  li: number;
  fi: number;
  docRev: number;
  /**
   * 这一步改了什么像素：**写完当场逐字节比对得出，写完就定死**（`null` = 没改到像素）。
   *
   * 为什么必须当场算、而不是 `previewTurn()` 里「拿这一步的快照比下一步的快照」（第一版那么写，
   * 是错的）：`Doc.restore()` 是**就地**改同一个 `Doc` 对象（`this.cels = new Map()`），
   * 而每一步的 `before.doc` 都是**同一个**实况文档 —— 下一步的 `restore` 会顺手把这一步
   * 「依附的那个 Doc」也换成新内容，于是两步一比就得到 null 或错的矩形
   * （探针实测：第 1 步的 `changed` 变成了两步的并集 29×29，`previewTurn().rect` 只剩最后一步）。
   * 在 `mark()` 里算完存下来，还顺带让「这一步改了什么」在下一步开始前就冻结了。
   */
  deltaRect: Rect | null;
  /**
   * 这份快照的**字节代价**（`宽 × 高 × 4 × cel 数`，与快照里 cel 字节之和取大者）。
   * 每落一步会深拷贝**两份**（`before` + 写完当场的那份，见 `recordStep`），所以按两倍算 ——
   * 见 §23.4 口径 7。为什么取大者：cel 的数据长度可能大于 `w*h*4`（画布被改小过），
   * 而 `capture()` 深拷贝的元数据（图层 / 帧 / 标签 / 选区掩码）比 `w*h*4` 更大时也不能漏算。
   */
  cost: number;
}

/** 步骤表里的一行（**每一行都对应一次真的写操作**，「没写」的调用根本不进表） */
interface TurnStep {
  index: number;
  label: string;
  before: StepSnap;
  docRevAfter: number;
  /** 这一步的真耗时（毫秒，`ai-chat` 量；没量到就是 0） */
  durationMs: number;
}

interface TurnState {
  id: number;
  /** 已归一化的标签正文（不含 `ai: ` 前缀） */
  label: string;
  host: AiTurnSession;
  /** 回合开始时的样子（`commitTurn()` / `rollbackTurn()` 用的**永远**是它，按步撤回不动它） */
  begin: DocSetState;
  /** `mark()` 次数 */
  count: number;
  /** `rect` 缓存是否还有效（`mark()` 与 `revertTurnStep()` 都会置假） */
  rectComputed: boolean;
  /** 从回合开始到实况的改动包围盒（`diffRect(t.begin, t.host)` 的结果缓存） */
  rect: Rect | null;
  gate: HistoryGate;
  // ---- B2 按步撤回 ----
  /** 步骤表（只收真改了文档的调用） */
  steps: TurnStep[];
  /** 正在等结果的那一步（`begin` 与 `end` 之间）；`null` = 现在没在跑工具调用 */
  activeStep: StepSnap | null;
  /** 正在等结果的那一步的标签 */
  activeLabel: string;
  /**
   * 这一次调用**刚刚**落过一行步骤（`mark()` 在 `callTool` 返回之前触发）。
   * `endTurnStep()` 靠它把耗时补进**这一步**，而不是补进上一次调用的那一行。
   */
  stepJustRecorded: boolean;
  /** 已经用掉的快照字节数 */
  stepBytes: number;
  /** 按步撤回为什么不能用（空串 = 能用）；一旦置上就**不再逐留快照** */
  stepOff: string;
  /**
   * 步骤表里**撤回点**：下标 ≥ `revertedAt` 的步骤都已经作废（`-1` = 一个都没撤）。
   * 它只增不减地往前走，所以步骤表本身可以原地留着 —— 但撤回过的那些快照**当场释放**
   * （`before.snap` 换成空的 `DocSnapshot`），内存不会被一堆够不着的过去占着。
   */
  revertedAt: number;
  /** 回合开始时画布 id（按步撤回只认它，见 `captureStepSnap()`） */
  firstDocId: string | null;
}

interface HistoryGate {
  /** 恢复 `History` 原来的三个压栈入口（幂等） */
  restore(): void;
}

let boundHost: AiTurnSession | null = null;
let activeTurn: TurnState | null = null;
let nextTurnId = 1;
/** `commitTurn()` 收尾时抛出的异常（内部记账，只给 `runAiTurn()` 分辨「没改动」与「收尾失败」用） */
let lastCommitError: unknown = null;

// ------------------------------------------------------------------ 对外接口

/** 把某个 Session 登记成 §5.1 五个自由函数的宿主（`Session` 的门面每次调用都会登记） */
export function bindTurnHost(s: AiTurnSession | null): void {
  boundHost = s;
}

/** 打开回合：返回 turnId（≥1）。没有宿主（从没绑过 Session）时返回 0 且回合不打开 */
export function beginAiTurn(label: string): number {
  if (!boundHost) return 0;
  return beginTurn(boundHost, label);
}

/**
 * **单一安全入口**（C3/C5 的每一轮 AI 都走它，别自己手写 begin/finally）：
 * `begin` → `await fn()` → `commitTurn()`；`fn` 抛异常 → `rollbackTurn()` 并把异常装进
 * `error` 返回（不重抛）；`finally` 里只要回合还开着（例如 `fn` 自己 begin 过）就再 rollback 一次。
 *
 * 注意：`ok:true` 表示「正常收尾」，**不**表示「一定落了一条历史」—— 无改动时 `commitTurn()`
 * 返回 false，那也不是失败。想知道改了什么用 `previewTurn()`；想知道落没落盘看 `isTurnOpen()`
 * 之后的 `history.list()`。收尾**失败**（压栈/同步出错）会转成 `ok:false`。
 */
export async function runAiTurn<T>(label: string, fn: () => T | Promise<T>): Promise<AiTurnRunResult<T>> {
  if (!boundHost) {
    return { ok: false, error: new Error("ai turn: 没有宿主 —— 先调 Session 的回合门面（或 bindTurnHost）") };
  }
  const turnId = beginAiTurn(label);
  if (turnId <= 0) return { ok: false, error: new Error("ai turn: 回合没能打开（beginAiTurn 返回 0）") };
  try {
    const result = await fn();
    const committed = commitTurn();
    if (!committed && lastCommitError !== null) return { ok: false, error: lastCommitError };
    return { ok: true, result };
  } catch (error) {
    rollbackTurn(); // 失败路径的默认动作：丢弃这一轮的全部改动
    return { ok: false, error };
  } finally {
    if (isTurnOpen()) rollbackTurn(); // 兜底：fn 自己开过回合 / 上面的 rollback 没兜住
  }
}

/**
 * 预览：这一轮会改多少操作、哪块像素（**只算不改文档**）。回合没开 → 四个字段都是空值。
 *
 * `rect` = 从**回合开始**到实况的逐字节比对（`diffRect()`）—— 于是「撤回之后」它算的正是
 * 撤回后的实况（比如撤到第 1 步之前就是 `null`）。它与 `steps[].changed` 的并集在正常回合里
 * 必然相等（每一步的差值就是按同一套比对算的），两条路径各自独立、互为交叉验证。
 * **缓存**在 `t.rect` 上：`mark()` 会让它失效，`revertTurnStep()` 也会。
 */
export function previewTurn(): AiTurnPreview {
  const t = activeTurn;
  if (!t) return { count: 0, rect: null, steps: null, docRev: 0 };
  if (!t.rectComputed) {
    t.rect = diffRect(t.begin, t.host);
    t.rectComputed = true;
  }
  return { count: t.count, rect: t.rect ? { ...t.rect } : null, steps: previewTurnSteps(t), docRev: docRevOf(t.host) };
}

/**
 * 步骤表摘要。
 *
 * 两条口径：
 *   · `changed` 直接取那一步**写完当场**算好的 `before.deltaRect`（不在预览里现算 —— 见
 *     `StepSnap.deltaRect` 的注释：现算会因为 `Doc.restore()` 就地改文档而得到错的矩形）；
 *   · 已经撤回的步骤（下标 ≥ `revertedAt`）**仍然在表里**（UI 要显示「第 n 步已撤回」），
 *     但它们的快照已经在撤回时释放，这里也不会再去读它（`reverted` 为真时 `changed` 恒 null）。
 */
function previewTurnSteps(t: TurnState): AiTurnStepPreview {
  const out: AiTurnStepInfo[] = [];
  for (let i = 0; i < t.steps.length; i++) {
    const st = t.steps[i];
    const reverted = t.revertedAt >= 0 && i >= t.revertedAt;
    out.push({
      index: st.index,
      label: st.label,
      docRevBefore: st.before.docRev,
      docRevAfter: st.docRevAfter,
      changed: reverted ? null : (st.before.deltaRect ? { ...st.before.deltaRect } : null),
      durationMs: st.durationMs,
      reverted,
    });
  }
  return {
    steps: out,
    revert: { ok: !t.stepOff, ...(t.stepOff ? { reason: t.stepOff } : {}), usedBytes: t.stepBytes, budgetBytes: AI_TURN_STEP_BUDGET_BYTES },
    rect: t.rect ? { ...t.rect } : null,
    count: t.count,
  };
}

/** 文档版本号（`Doc.pixelRev`；拿不到就是 0） */
function docRevOf(s: AiTurnSession): number {
  const d = (s.doc as unknown as { pixelRev?: number } | null)?.pixelRev;
  return typeof d === "number" ? d : 0;
}

// ------------------------------------------------------------------ B2：按步撤回

/**
 * 一次工具调用**开始**（`ai-chat` 在 `callTool` 之前调）。记下「执行前」快照。
 *
 * 为什么在**调用前**抓：语义定死了 —— 「撤回第 n 步 = 把文档恢复到第 n 步执行**之前**」。
 * 调用后再抓就变成了「恢复到第 n 步之后」，那是另一种功能。
 * 调用结束没写文档（只读 / 失败 / 用户取消）时这一步会被 `endTurnStep()` 丢掉。
 */
export function beginTurnStep(label: string): void {
  const t = activeTurn;
  if (!t) return;
  t.activeLabel = String(label ?? "");
  t.stepJustRecorded = false;
  t.activeStep = t.stepOff ? null : captureStepSnap(t);
}

/**
 * 一次工具调用**结束**（`ai-chat` 在 `callTool` 之后调）。真改了文档才落进步骤表。
 *
 * `mark()`（C1 的 `AiToolCtx.turn.mark`）在 `ai-tools.callTool` 里只对
 * 「成功 + 非只读」的调用触发一次，所以「写没写」这件事不用这里再猜一遍 ——
 * 落行发生在 `mark()` 里（见 `recordStep()`），这里只负责两件收尾：
 *   · 这一步真的写了 → 把 `ai-chat` 量的**真耗时**补进那一行；
 *   · 没写（只读 / 失败 / 用户取消）→ 把那份没用的「执行前」快照丢掉。
 */
export function endTurnStep(durationMs?: number): void {
  const t = activeTurn;
  if (!t) return;
  const just = t.stepJustRecorded;
  t.stepJustRecorded = false;
  t.activeStep = null;
  if (!just || !t.steps.length) return;
  const ms = Math.round(Number(durationMs));
  if (Number.isFinite(ms) && ms >= 0) t.steps[t.steps.length - 1].durationMs = ms;
}

/**
 * `mark()` 的按步口径：**每成功写一次文档就落一行步骤** —— 下标就是 `revertTurnStep(n)` 的 n。
 *
 * 为什么一行就是「一次 `mark()`」而不是「一次 `callTool`」：`mark()` 是 C1 那条**唯一**的
 * 「文档真的被改了」信号，`callTool` 的一次调用可能一次都没 mark（只读 / 失败 / 取消）。
 * 用「写了几次」当下标，`revertTurnStep(n)` 才总是有意义的；用「第几次调用」当下标会
 * 更容易让用户指到一个什么都没改的调用上。
 */
function recordStep(t: TurnState): void {
  const snap = t.activeStep;
  if (!snap) return;
  const live = findDocById(t.host, snap.id);
  const after = live ? live.capture() : null;   // 写完当场的那一份（算差值用，算完就丢）
  const delta = live ? contentDiffRect(snap.snap, live) : null;
  // 差值**当场算完存死**：晚一点算就会被下一步的 `Doc.restore()`（就地改文档）污染，见 `deltaRect` 注释
  snap.deltaRect = delta;
  t.steps.push({
    index: t.steps.length + 1, label: t.activeLabel, before: snap,
    docRevAfter: docRevOf(t.host), durationMs: 0,
  });
  t.stepJustRecorded = true;
  // 预算按**两份**算：`before` + 刚才那份 `after`（`after` 只活在这一次比较里，不进步骤表）
  t.stepBytes += snap.cost + (after ? snapshotCost(after) : 0);
  if (t.stepBytes > AI_TURN_STEP_BUDGET_BYTES) disableStepRevert(t, AI_TURN_STEP_OFF_TOO_BIG);
}

/** 按步撤回不可用（跨画布 / 超预算 / 画布集合变了）：**不再逐留快照**，UI 拿 `previewTurn().steps.revert.reason` */
function disableStepRevert(t: TurnState, reason: string): void {
  if (t.stepOff) return;
  t.stepOff = reason;
  t.activeStep = null;
  t.stepJustRecorded = false;
  // 已经抓到的那些快照**不再够用**（一旦禁用，步骤表整体作废），当场释放，别占着内存
  for (const st of t.steps) st.before.snap = emptySnap(st.before.snap);
  t.steps = [];
  t.stepBytes = 0;
  t.revertedAt = -1;
}

/**
 * 抓「当前实况」的一份「执行前」快照。
 *
 * **只抓聚焦画布那一张**，这是「按步撤回的代价」与「安全性」两件事的折中：
 *   · 回合开始只有一张画布 → 单画布回合（历史走 `pushStruct`），一张快照就够；
 *   · 这一步碰了**别的**画布（引用图层把写操作投给源画布 / 模型自己切了画布）→
 *     一张快照不够，而我们**不会**为每一步再抓 N 张（内存是 N 倍）→ 明确禁用按步撤回；
 *   · 画布集合在这一步里变了（新开 / 关掉画布）→ 同理，禁用。
 *
 * 禁用不是「默默不做」：`previewTurn().steps.revert.reason` 里有一句人话，UI 会显示出来。
 */
function captureStepSnap(t: TurnState): StepSnap | null {
  const s = t.host;
  if (s.docs.length !== t.begin.docs.length) {
    disableStepRevert(t, AI_TURN_STEP_OFF_CROSS_CANVAS);
    return null;
  }
  const focus = s.docs[s.docIdx];
  const id = focus ? focus.id : null;
  if (id !== t.firstDocId) {
    disableStepRevert(t, AI_TURN_STEP_OFF_CROSS_CANVAS);
    return null;
  }
  const doc = focus ? focus.doc : s.doc;
  const snap = doc.capture();
  return {
    id,
    doc,
    snap,
    li: focus ? focus.li : s.layerIdx,
    fi: focus ? focus.fi : s.frameIdx,
    docRev: docRevOf(s),
    deltaRect: null,                 // 写完当场由 `recordStep()` 填上
    cost: snapshotCost(snap),
  };
}

/** 一份快照的字节代价：`宽 × 高 × 4 × cel 数`，与快照里 cel 字节之和取大者（见 `StepSnap.cost`） */
function snapshotCost(snap: DocSnapshot): number {
  let sum = 0;
  for (const cel of snap.cels.values()) sum += cel.data.length;
  return Math.max(sum, snap.w * snap.h * 4 * snap.cels.size, snap.w * snap.h * 4);
}

/** 把一份快照换成空壳（撤回 / 禁用时**当场释放**像素缓冲；步骤摘要还留着给 UI 用） */
function emptySnap(s: DocSnapshot): DocSnapshot {
  return { ...s, cels: new Map(), layers: [], frames: [], tags: [], palette: [], sel: null };
}

function findDocById(s: AiTurnSession, id: string | null): Doc | null {
  if (!id) return s.docs.length ? null : s.doc;
  const e = s.docs.find((d) => d.id === id);
  return e ? e.doc : null;
}

/**
 * **按步撤回**（B2，只在预览回合里用）：把文档恢复到**第 n 步执行之前**，并让
 * **第 n 步及之后的所有步骤一并作废**（后续步骤建立在它们之上）。
 *
 * 语义（用户定死，别自由发挥）：
 *   1. 回合**仍然开着**（还是预览态），用户之后只能「应用当前状态」或「放弃整轮」；
 *      **不允许撤回后再让模型接着跑** —— 消息线程里还留着「模型画过的那些步骤」的
 *      tool 结果，而文档已经回到那些步骤之前，再跑下去模型是基于一份**不存在的过去**
 *      继续推理（它以为画在 A 上的东西还在）。所以 UI 在撤回之后只给「应用 / 放弃」，
 *      输入框在语义上是关着的（见 `AiPanel` 的 `showPreview` 分支与 `aiChatStepReverted`）。
 *   2. 撤回**不碰历史**：回合期间历史本来就是打桩的（`suspendHistory`），
 *      点「应用」时仍然**只压一条**覆盖整轮的 struct（一轮一条 undo 这条不变式不变）。
 *   3. 撤回后 `previewTurn()` 的 `rect` / `docRev` / `steps[].changed` 反映**撤回后的实况**：
 *      `rect` 是**还活着的**那些步骤 `changed` 的并集（撤回过的整段不再计入），
 *      而每一步的 `changed` 是它写完当场算好存死的（见 `StepSnap.deltaRect`）。
 *
 * 返回 true = 真撤回了；false = 没撤回（回合没开 / n 不是 1..步骤数 / 这一步已经作废过）。
 * **不抛异常**，与 C2 其余失败口径一致。
 */
export function revertTurnStep(n: number): boolean {
  const t = activeTurn;
  if (!t) return false;
  const k = Math.round(Number(n));
  if (!Number.isFinite(k) || k < 1 || k > t.steps.length) return false;
  const at = k - 1;
  if (t.revertedAt >= 0 && at >= t.revertedAt) return false;   // 已经作废的步骤：不能「再撤一次」
  const st = t.steps[at];

  // ① 先落定未完成的笔迹：`Doc.restore()` 会整批换掉 cel 对象，View 手里那份会变成孤儿
  //    （与 `rollbackTurn()` 同一条口径）。
  try { t.host.view?.flushStroke(); } catch { /* flush 失败不该挡住撤回本身 */ }
  // ② 内容回到「第 n 步执行之前」（结构快照 = 逐字节）
  st.before.doc.restore(st.before.snap);
  // ③ 选择（当前图层 / 帧）也回到那一刻 —— 后续步骤可能切过图层
  if (st.before.id) {
    const e = t.host.docs.find((d) => d.id === st.before.id);
    if (e) { e.li = st.before.li; e.fi = st.before.fi; }
  }
  // ④ 第 n 步及之后作废：快照当场释放（够不着了），只留摘要给 UI 显示「已撤回」
  const after = docRevOf(t.host);        // `Doc.restore()` 自己会 pixelRev++（单调修订号）
  const wasLast = t.steps.length;
  for (let i = at; i < wasLast; i++) {
    const x = t.steps[i];
    x.before.snap = emptySnap(x.before.snap);
    x.docRevAfter = after;
  }
  t.stepBytes = 0;
  for (let i = 0; i < at; i++) t.stepBytes += t.steps[i].before.cost;   // 前面的活步骤照旧算（它们还能再撤）
  t.revertedAt = at;
  // 实况变了：`rect` 缓存作废（下一次 previewTurn 会按撤回后的实况重算）
  t.rectComputed = false;
  t.rect = null;
  t.host.syncAll();
  return true;
}

/** 落一条历史（结构快照）+ 补一次 autosave：真有改动 → true；没改动 / 回合没开 → false */
export function commitTurn(): boolean {
  const t = activeTurn;
  if (!t) return false; // 回合没开：不抛异常、不动文档
  activeTurn = null; // 先关回合：下面无论怎么走都不会留下「开着但已落定」的状态
  const s = t.host;
  let pushed = false;
  let after: DocSetState | null = null;
  lastCommitError = null;
  try {
    s.view?.flushStroke(); // 未落定的笔迹 / 浮动变形先落定（历史还关着 → 不会多出历史步骤）
    after = captureDocSet(s);
    const changed = changedDocIds(t.begin, after);
    t.gate.restore();
    if (!changed.length) {
      // 没改动：不压栈、不补 autosave（文档一个字节都没动）
      s.aiTurnAutosaveSuppressed(false);
      return false;
    }
    const label = AI_TURN_LABEL_PREFIX + t.label;
    // 先把文档恢复成回合开始的样子：于是 pushStruct 的 before 快照 = 回合开始，after = 回合结束
    applyDocSet(s, t.begin);
    pushTurnEntry(s, label, t.begin, after, changed);
    pushed = true;
    // 再回到「回合结束」的样子（内容 + 画布集合 + 焦点/选择），最后同步一次并补 autosave
    applyDocSet(s, after);
    s.aiTurnAutosaveSuppressed(false);
    s.syncAfterDocChange();
    return true;
  } catch (e) {
    // 任何意外都不能把「历史关着 / autosave 被压着」留在身后，也不能留下半成品：
    // 压栈**之前**出错 → 文档回到回合开始（等于什么都没提交）；
    // 压栈**之后**才出错（极罕见：栈里的那条已经存在，没法再抽掉）→ 文档留在「回合结束」，
    // 与历史里那条记录保持一致，函数仍返回 false 表示「没有正常落定」。
    // 异常本身记进 `lastCommitError`：`runAiTurn()` 靠它把「没改动」与「收尾失败」分开。
    lastCommitError = e;
    t.gate.restore();
    s.aiTurnAutosaveSuppressed(false);
    applyDocSet(s, pushed && after ? after : t.begin);
    s.syncAll();
    return false;
  }
}

/** 放弃：恢复到回合开始（逐字节一致）。回合没开 → no-op，不抛异常 */
export function rollbackTurn(): void {
  const t = activeTurn;
  if (!t) return;
  activeTurn = null;
  const s = t.host;
  try {
    s.view?.flushStroke(); // 先落定，免得 View 手里还攥着已被 restore() 换掉的 cel
    applyDocSet(s, t.begin);
    s.syncAll();
  } finally {
    t.gate.restore();
    s.aiTurnAutosaveSuppressed(false);
  }
}

/** 回合是不是开着 */
export function isTurnOpen(): boolean {
  return activeTurn !== null;
}

/** 交给 C3 的 `AiToolCtx.turn`（形状由 C1 定死：`{ isOpen, mark }`）；mark 只在回合开着时计数 */
export function turnHandle(): AiTurnHandle {
  return {
    isOpen: () => activeTurn !== null,
    mark: () => {
      const t = activeTurn;
      if (!t) return; // 回合没开：mark 不该凭空造出一个回合
      t.count++;
      t.rectComputed = false; // 脏矩形缓存失效，下一次 previewTurn 重新比对
      // B2：`mark()` 是「文档真的被改了」的唯一信号，所以**步骤表就在这一行落**
      // （`beginTurnStep()` 抓的「执行前」快照 + 这一次 mark = 一步）。见 `recordStep()`。
      recordStep(t);
    },
  };
}

// ------------------------------------------------------------------ 回合本体

function beginTurn(s: AiTurnSession, rawLabel: string): number {
  // 重复 begin：先丢弃上一轮未提交的改动（不回滚用户既有历史），再开新的
  if (activeTurn) rollbackTurn();
  const t: TurnState = {
    id: nextTurnId++,
    label: normalizeLabel(rawLabel),
    host: s,
    begin: captureDocSet(s),
    count: 0,
    rectComputed: false,
    rect: null,
    // 占位闸门：真正的挂载在下面；先放一个能让 catch 安全调用 restore() 的空实现
    gate: { restore: () => { /* 闸门还没挂上 */ } },
    // ---- B2 按步撤回 ----
    steps: [],
    activeStep: null,
    activeLabel: "",
    stepJustRecorded: false,
    stepBytes: 0,
    stepOff: "",
    revertedAt: -1,
    firstDocId: s.docs.length ? s.docs[Math.max(0, Math.min(s.docs.length - 1, s.docIdx))].id : null,
  };
  // **先发布回合、再动副作用**（挂闸门 / 压 autosave）：两个副作用的逆操作都记在 `t` 上，
  // 中途抛错也能在 catch 里完整还原。反过来（先挂闸门后发布）在挂载那一步抛错时会留下
  // 「闸门已经挂上、activeTurn 却是 null」的不可恢复窗口 —— 谁都调不动 rollback（t14-P3）。
  activeTurn = t;
  try {
    t.gate = suspendHistory(s.history);
    s.aiTurnAutosaveSuppressed(true);
  } catch (e) {
    activeTurn = null;
    t.gate.restore();
    s.aiTurnAutosaveSuppressed(false);
    throw e;
  }
  return t.id;
}

/** 标签归一化：去空白 → 去掉调用方可能自带的 `ai: ` → 截断到 `AI_TURN_LABEL_MAX` */
function normalizeLabel(raw: string): string {
  let s = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (s.slice(0, AI_TURN_LABEL_PREFIX.length) === AI_TURN_LABEL_PREFIX) s = s.slice(AI_TURN_LABEL_PREFIX.length).trim();
  else if (s.slice(0, 3) === "ai:") s = s.slice(3).trim();
  if (!s) return AI_TURN_LABEL_FALLBACK;
  return s.length > AI_TURN_LABEL_MAX ? s.slice(0, AI_TURN_LABEL_MAX) : s;
}

/**
 * 回合期间把 `History` 的三个压栈入口暂时摘掉：
 *   · `pushPixels` / `record`：调用方**已经**改完文档了，它们只负责编码 + 压栈 → 直接丢弃；
 *   · `pushStruct`：**fn 必须在里面执行** —— `Session.struct()` 的全部改动都写在 fn 里，
 *     拦掉 fn 等于「AI 什么都没干」。所以放行 fn、只丢压栈。
 */
function suspendHistory(h: History): HistoryGate {
  const saved = { record: h.record, pushPixels: h.pushPixels, pushStruct: h.pushStruct };
  h.record = () => { /* 回合期间不落历史 */ };
  h.pushPixels = () => { /* 同上 */ };
  h.pushStruct = (_label: string, _doc: Doc, fn: () => void) => { fn(); };
  let restored = false;
  return {
    restore: () => {
      if (restored) return;
      restored = true;
      h.record = saved.record;
      h.pushPixels = saved.pushPixels;
      h.pushStruct = saved.pushStruct;
    },
  };
}

/** 压一条覆盖整轮的记录（单画布 → pushStruct；跨画布 → record 的闭包） */
function pushTurnEntry(
  s: AiTurnSession,
  label: string,
  begin: DocSetState,
  after: DocSetState,
  changed: string[],
): void {
  const singleId = changed.length === 1 ? changed[0] : null;
  const rec = singleId === null ? undefined : after.docs.find((d) => d.id === singleId);
  if (rec && rec.id && sameDocSetShape(begin, after)) {
    // 常态：docSet 的形状没变，只有一张画布的内容变了 —— pushStruct 带 before/after 快照，
    // 能进 .pxc 的历史（Engine/history 的 dump 只认有 payload 的步骤）
    const entry = s.docs.find((e) => e.id === rec.id);
    const doc = entry ? entry.doc : rec.doc;
    const snap = rec.snap;
    s.history.pushStruct(label, doc, () => doc.restore(snap));
    return;
  }
  // 跨画布（或画布集合变了）：一条闭包记录，undo 一次覆盖所有画布
  s.history.record(label, {
    apply: () => applyDocSet(s, after),
    unapply: () => applyDocSet(s, begin),
  }, undefined, s.doc);
}

// ------------------------------------------------------------------ 工程快照 / 恢复

function captureDocSet(s: AiTurnSession): DocSetState {
  const docs: TurnDocState[] = [];
  for (let i = 0; i < s.docs.length; i++) {
    const e = s.docs[i];
    const focused = i === s.docIdx; // 焦点画布的当前图层/帧就是 Session 上的那两个字段
    docs.push({
      id: e.id, doc: e.doc, snap: e.doc.capture(),
      x: e.x, y: e.y,
      li: focused ? s.layerIdx : e.li,
      fi: focused ? s.frameIdx : e.fi,
      locked: e.locked === true, group: e.group ?? null,
    });
  }
  if (!docs.length) {
    // 一张画布都没开：`Session.doc` 是那张 1×1 的替身文档，照样纳入回合
    const d = s.doc;
    docs.push({ id: null, doc: d, snap: d.capture(), x: 0, y: 0, li: 0, fi: 0, locked: false, group: null });
  }
  return { docs, docIdx: s.docIdx, layerIdx: s.layerIdx, frameIdx: s.frameIdx };
}

/**
 * 让工程回到某个快照描述的样子：内容逐字节 + 画布集合（多出来的删掉、缺了的补回来）
 * + 画布位置 + 焦点与当前图层/帧选择。**不碰历史**。
 */
function applyDocSet(s: AiTurnSession, set: DocSetState): void {
  const want = new Map<string, TurnDocState>();
  for (const d of set.docs) if (d.id) want.set(d.id, d);
  for (let i = s.docs.length - 1; i >= 0; i--) {
    if (!want.has(s.docs[i].id)) s.docs.splice(i, 1); // 回合里新开的画布：回滚要删掉，不留残留
  }
  for (const d of set.docs) {
    if (!d.id) { d.doc.restore(d.snap); continue; } // 替身文档
    let e = s.docs.find((x) => x.id === d.id);
    if (!e) {
      e = { id: d.id, doc: d.doc, x: d.x, y: d.y, li: d.li, fi: d.fi, locked: d.locked, group: d.group };
      s.docs.push(e);
    }
    e.doc = d.doc;
    e.x = d.x; e.y = d.y; e.li = d.li; e.fi = d.fi; e.locked = d.locked; e.group = d.group;
    d.doc.restore(d.snap);
  }
  s.docIdx = Math.max(0, Math.min(Math.max(0, s.docs.length - 1), set.docIdx));
  const e = s.docs[s.docIdx];
  s.layerIdx = e ? e.li : set.layerIdx; // 每张画布自己的 li/fi 就是快照里的选择
  s.frameIdx = e ? e.fi : set.frameIdx;
}

/** 内容有没有变（只比文档内容：画布位置/焦点不算改动） */
function changedDocIds(a: DocSetState, b: DocSetState): string[] {
  const out: string[] = [];
  const byId = new Map<string, TurnDocState>();
  for (const d of a.docs) byId.set(d.id ?? "\u0000", d);
  const seen = new Set<string>();
  for (const d of b.docs) {
    const key = d.id ?? "\u0000";
    seen.add(key);
    const o = byId.get(key);
    if (!o) { out.push(key); continue; } // 新开的画布：内容自然算变
    if (o.doc !== d.doc || !sameSnapshot(o.snap, d.snap)) out.push(key);
  }
  for (const d of a.docs) if (!seen.has(d.id ?? "\u0000")) out.push(d.id ?? "\u0000"); // 被删掉的画布
  return out;
}

/** docSet 的形状（画布集合与顺序）有没有变 */
function sameDocSetShape(a: DocSetState, b: DocSetState): boolean {
  if (a.docs.length !== b.docs.length) return false;
  for (let i = 0; i < a.docs.length; i++) if ((a.docs[i].id ?? "\u0000") !== (b.docs[i].id ?? "\u0000")) return false;
  return true;
}

/**
 * 与回合开始逐字节比对，给出像素改动的并集包围盒（多画布时是各画布矩形在各自文档坐标下的数值并集）。
 * `previewTurn()` 的 `rect` 用它，`commitTurn()` 的「有没有改动」也用它的兄弟 `changedDocIds()`。
 */
function diffRect(begin: DocSetState, s: AiTurnSession): Rect | null {
  let out: Rect | null = null;
  const seen = new Set<string>();
  for (const d of begin.docs) {
    if (!d.id) {
      out = unionRect(out, contentDiffRect(d.snap, s.doc));
      continue;
    }
    seen.add(d.id);
    const live = s.docs.find((e) => e.id === d.id);
    if (!live) { out = unionRect(out, { x: 0, y: 0, w: d.snap.w, h: d.snap.h }); continue; }
    out = unionRect(out, contentDiffRect(d.snap, live.doc));
  }
  for (const e of s.docs) {
    if (!seen.has(e.id)) out = unionRect(out, { x: 0, y: 0, w: e.doc.w, h: e.doc.h }); // 回合里新开的画布
  }
  return out;
}

/** 一张画布相对快照的像素改动包围盒（null = 一个像素都没动） */
function contentDiffRect(snap: DocSnapshot, doc: Doc): Rect | null {
  if (snap.w !== doc.w || snap.h !== doc.h) {
    return { x: 0, y: 0, w: Math.max(snap.w, doc.w), h: Math.max(snap.h, doc.h) };
  }
  const keys = new Set<string>([...snap.cels.keys(), ...doc.cels.keys()]);
  let out: Rect | null = null;
  for (const k of keys) {
    const before = snap.cels.get(k);
    const now = doc.cels.get(k);
    if (before && now && sameBytes(before.data, now.data)) continue;
    out = unionRect(out, pixelDiffBox(before ? before.data : null, now ? now.data : null, doc.w, doc.h));
  }
  return out;
}

/** 两个 `Uint8ClampedArray` 逐字节比较（长度不同直接算不同） */
function sameBytes(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 两份 cel 字节的差异包围盒；缺的那一侧按「全透明」算 */
function pixelDiffBox(a: Uint8ClampedArray | null, b: Uint8ClampedArray | null, w: number, h: number): Rect | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      if (a && b) {
        if (a[p] === b[p] && a[p + 1] === b[p + 1] && a[p + 2] === b[p + 2] && a[p + 3] === b[p + 3]) continue;
      } else {
        const t = a ?? b;
        if (!t) continue;
        if (t[p] === 0 && t[p + 1] === 0 && t[p + 2] === 0 && t[p + 3] === 0) continue;
      }
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w), y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ------------------------------------------------------------------ 内容比较

/** 两份文档快照的内容是否逐字节一致（忽略 pixelRev / Sel.ver 这类缓存键） */
function sameSnapshot(a: DocSnapshot, b: DocSnapshot): boolean {
  if (a.w !== b.w || a.h !== b.h || a.name !== b.name) return false;
  if (JSON.stringify(a.layers) !== JSON.stringify(b.layers)) return false;
  if (JSON.stringify(a.frames) !== JSON.stringify(b.frames)) return false;
  if (JSON.stringify(a.tags ?? []) !== JSON.stringify(b.tags ?? [])) return false;
  if (JSON.stringify(a.bg) !== JSON.stringify(b.bg)) return false;
  if (JSON.stringify(a.palette) !== JSON.stringify(b.palette)) return false;
  if (!sameSel(a.sel, b.sel)) return false;
  if (a.cels.size !== b.cels.size) return false;
  for (const [k, ca] of a.cels) {
    const cb = b.cels.get(k);
    if (!cb || !sameBytes(ca.data, cb.data)) return false;
  }
  return true;
}

function sameSel(a: Sel | null, b: Sel | null): boolean {
  if (!a !== !b) return false;
  if (!a || !b) return true;
  if (a.w !== b.w || a.h !== b.h || a.mask.length !== b.mask.length) return false;
  for (let i = 0; i < a.mask.length; i++) if (a.mask[i] !== b.mask[i]) return false;
  return true;
}
