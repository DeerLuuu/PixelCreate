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

import type { Doc, DocSnapshot, Sel } from "../engine/doc";
import type { History } from "../engine/history";
import type { Rect } from "../engine/types";
import type { CanvasEntry } from "./session";

/** 回合预览：`count` = 这一轮被 `mark()` 记下的操作数；`rect` = 与回合开始逐字节比对出的像素改动包围盒 */
export interface AiTurnPreview {
  count: number;
  rect: Rect | null;
}

/** C1 定死的回合句柄形状（`AiToolCtx.turn`）：callTool 每成功一次写操作调用一次 `mark()` */
export interface AiTurnHandle {
  isOpen(): boolean;
  mark(): void;
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

interface TurnState {
  id: number;
  /** 已归一化的标签正文（不含 `ai: ` 前缀） */
  label: string;
  host: AiTurnSession;
  begin: DocSetState;
  /** `mark()` 次数 */
  count: number;
  rectComputed: boolean;
  rect: Rect | null;
  gate: HistoryGate;
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

/** 预览：这一轮会改多少操作、哪块像素（**只算不改文档**）。回合没开 → `{count:0, rect:null}` */
export function previewTurn(): AiTurnPreview {
  const t = activeTurn;
  if (!t) return { count: 0, rect: null };
  if (!t.rectComputed) {
    t.rect = diffRect(t.begin, t.host);
    t.rectComputed = true;
  }
  return { count: t.count, rect: t.rect ? { ...t.rect } : null };
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

/** 与回合开始逐字节比对，给出像素改动的并集包围盒（多画布时是各画布矩形在各自文档坐标下的数值并集） */
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
