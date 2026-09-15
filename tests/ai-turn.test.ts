// C2 回归：AI 回合事务（src/app/ai-turn.ts + session.ts 的薄门面）。
//
// 这一份测试盯的是「不要改回去」的几件事：
//   · 一轮 30 个写操作（走 C1 的 callTool）之后历史**只多 1 条**，标签以 `ai: ` 开头，
//     且回合进行中历史一动不动（「期间写操作不动历史」）；
//   · 一条 undo 覆盖整轮、一条 redo 回到回合结束；
//   · `rollbackTurn()` 之后工程与「新开的同一份工程」逐字节一致（多层多帧都要一致），
//     并把回合里新开的画布一起删掉（不留残留状态）；
//   · 回合期间 autosave 一个字节都不落盘（scheduleAutosave / flushAutosave / 非强制 writeAutosave
//     都早退，**回合前排定的计时器也会被取消**），commit 之后补一次；
//   · 无改动的 commit 返回 false 且不压栈（只有焦点/画布位置变了也不算改动）；
//   · 回合没开时 commit/rollback/preview 的失败口径（不抛异常）；
//   · 异常路径（压栈时抛错）不留残留：文档回到回合开始、历史闸门与 autosave 抑制都还回去；
//   · `runAiTurn()` 这个安全入口两条路径（成功 / fn 抛错）都收得干净；
//   · 回合与「回放查看器」两面旗互不覆盖（t14-F3）。
import { Doc } from "../src/engine/doc";
import { Session } from "../src/app/session";
import {
  AI_TURN_LABEL_FALLBACK, AI_TURN_LABEL_MAX, AI_TURN_LABEL_PREFIX,
  beginAiTurn, bindTurnHost, commitTurn, isTurnOpen, previewTurn, rollbackTurn, runAiTurn, turnHandle,
} from "../src/app/ai-turn";
import { callTool } from "../src/app/ai-tools";
import type { AiToolCtx } from "../src/app/ai-tools";
import { stubEnv } from "./session.test";
import { eq, ok } from "./common";

declare const require: (m: string) => any;

/** 有内容的会话：3 图层 × 3 帧（每格一个红像素）、两条标签、4 色调色板 */
function live(): Session {
  const s = new Session();
  s.doc.palette = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 0, 255]];
  s.layerAdd();
  s.layerAdd();
  s.frameAdd();
  s.frameAdd();
  for (let li = 0; li < s.doc.layers.length; li++) {
    for (let fi = 0; fi < s.doc.frames.length; fi++) {
      s.doc.ensureCel(li, fi).setPixel(li + 1, fi + 1, [255, 0, 0, 255]); // 位置随层/帧变化
    }
  }
  s.tagAdd("idle", 0, 1);
  s.history.clear();
  return s;
}

/** 文档内容投影（图层/帧/标签顺序与取值 + 调色板 + 选区 + cel 字节）；`withIds=false` 时去掉随机 uid */
function metaBytes(d: Doc, withIds: boolean): string {
  const layers = d.layers.map((l) => withIds ? { ...l } : [l.name, l.visible, l.opacity, l.blend, l.locked, l.ref ?? null, l.refLayer ?? null]);
  const frames = d.frames.map((f) => withIds ? { ...f } : { ms: f.durationMs });
  const tags = d.tags.map((t) => withIds ? { ...t } : [t.name, t.from, t.to, t.color ?? null]);
  return JSON.stringify({
    w: d.w, h: d.h, name: d.name, bg: d.bg, palette: d.palette, layers, frames, tags,
    sel: d.sel ? { w: d.sel.w, h: d.sel.h, mask: Array.from(d.sel.mask).join("") } : null,
  });
}

/** 整个工程逐字节（全部画布 + 画布集合/位置/焦点 + 每格 cel 字节）；不含 pixelRev 这类缓存键 */
function projectBytes(s: Session, withIds: boolean): string {
  const parts: string[] = ["focus=" + s.docIdx, "docs=" + s.docs.length];
  for (const e of s.docs) {
    parts.push(withIds ? "@" + e.id + ":" + e.x + "," + e.y + ":" + e.li + "," + e.fi : "@" + e.doc.w + "x" + e.doc.h);
    parts.push(metaBytes(e.doc, withIds));
    for (const k of Array.from(e.doc.cels.keys()).sort()) {
      const cel = e.doc.cels.get(k);
      if (cel) parts.push(k + "=" + Array.from(cel.data).join(","));
    }
  }
  return parts.join("|");
}

const spaceBytes = (s: Session): string => projectBytes(s, true);
const contentBytes = (s: Session): string => projectBytes(s, false);

/** C1 的调用上下文：confirm 一律「点确定」，turn 用 C2 的真句柄（这就是 C1↔C2 的接缝） */
function toolCtx(s: Session): AiToolCtx {
  return { session: s, confirm: async () => true, turn: s.aiTurnHandle() };
}

function labels(s: Session): string[] {
  return s.history.list().labels;
}

/**
 * 窥视 Session 的私有记账字段（自动保存脏标记 / 抑制旗）。白盒测试专用：
 * 「回合期间不刷 autosave」必须能看到 `scheduleAutosave()` 到底有没有真的标记 + 排定时器，
 * 光数调用次数是数不出来的（回合期间 repaint 照样会调它，只是它早退）。
 */
function priv(s: Session): Record<string, unknown> {
  return s as unknown as Record<string, unknown>;
}

/**
 * 大字符串相等断言（工程逐字节快照有兆级内容）：失败时只打印长度与首个差异位置，
 * 不把 cel 字节倒进日志。相等判定与 eq() 完全一致。
 */
function sameBytes(name: string, a: string, b: string): void {
  if (a === b) { ok(name, true); return; }
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  ok(name, false, "len=" + a.length + "/" + b.length + " 首个差异 @" + i
    + " a=" + JSON.stringify(a.slice(i, i + 24)) + " b=" + JSON.stringify(b.slice(i, i + 24)));
}

export async function testAiTurn(): Promise<void> {
  stubEnv();
  const s = live();

  // ------------------------------------------------------------ 1. 导出面 + 回合没开时的失败口径
  eq("aiturn.exports.begin", typeof beginAiTurn, "function");
  eq("aiturn.exports.preview", typeof previewTurn, "function");
  eq("aiturn.exports.commit", typeof commitTurn, "function");
  eq("aiturn.exports.rollback", typeof rollbackTurn, "function");
  eq("aiturn.exports.isOpen", typeof isTurnOpen, "function");
  eq("aiturn.exports.handle", typeof turnHandle, "function");
  eq("aiturn.prefix", AI_TURN_LABEL_PREFIX, "ai: ");
  ok("aiturn.max-label", AI_TURN_LABEL_MAX >= 32, "AI_TURN_LABEL_MAX=" + AI_TURN_LABEL_MAX);
  eq("aiturn.fallback-label", AI_TURN_LABEL_FALLBACK, "未命名回合");

  ok("aiturn.closed.isOpen", !isTurnOpen());
  ok("aiturn.closed.facade-isOpen", !s.aiTurnOpen());
  eq("aiturn.closed.preview", previewTurn(), { count: 0, rect: null });
  eq("aiturn.closed.facade-preview", s.previewAiTurn(), { count: 0, rect: null });
  eq("aiturn.closed.commit", commitTurn(), false);
  eq("aiturn.closed.facade-commit", s.commitAiTurn(), false);
  const closedBytes = spaceBytes(s);
  rollbackTurn();
  s.rollbackAiTurn();
  sameBytes("aiturn.closed.rollback-noop", spaceBytes(s), closedBytes);
  eq("aiturn.closed.history-noop", labels(s).length, 0);
  ok("aiturn.closed.still-closed", !isTurnOpen() && !s.aiTurnOpen());

  const h0 = s.aiTurnHandle();
  eq("aiturn.handle.shape", [typeof h0.isOpen, typeof h0.mark], ["function", "function"]);
  ok("aiturn.handle.closed", !h0.isOpen());
  h0.mark();
  ok("aiturn.handle.mark-does-not-open", !isTurnOpen());

  // 从没绑过宿主：begin 返回 0 且回合不打开（失败口径里没有异常）
  bindTurnHost(null);
  eq("aiturn.begin.no-host", beginAiTurn("没有宿主"), 0);
  ok("aiturn.begin.no-host.closed", !isTurnOpen());
  bindTurnHost(s);

  // ------------------------------------------------------------ 2. 一轮 30 个写操作 → 历史只多 1 条
  s.history.clear();
  const before = spaceBytes(s);
  const id = s.beginAiTurn("描出史莱姆轮廓并铺底色");
  ok("aiturn.begin.id", id >= 1, "turnId=" + id);
  ok("aiturn.begin.open", isTurnOpen() && s.aiTurnOpen());
  eq("aiturn.begin.preview-count", s.previewAiTurn().count, 0);
  const ctx = toolCtx(s);
  for (let i = 0; i < 30; i++) {
    const r = i % 3 === 0
      ? await callTool("palette_add", { color: "#" + ((i * 7 + 16) % 256).toString(16).padStart(2, "0") + "1020" }, ctx)
      : i % 3 === 1
        ? await callTool("color_replace", { from: "#ff0000", to: "#00ffff", scope: "canvas" }, ctx)
        : await callTool("layer_toggle_visible", { li: 0 }, ctx);
    ok("aiturn.ops." + i, r.ok === true);
  }
  eq("aiturn.ops.history-untouched", labels(s).length, 0); // 回合进行中：一条都不压
  eq("aiturn.ops.preview-count", s.previewAiTurn().count, 30); // C1 每成功一次写操作 mark 一次
  ok("aiturn.ops.preview-rect", s.previewAiTurn().rect !== null);
  const after = spaceBytes(s);
  ok("aiturn.ops.content-changed", after !== before);

  eq("aiturn.commit.returns-true", s.commitAiTurn(), true);
  ok("aiturn.commit.closed", !s.aiTurnOpen() && !isTurnOpen());
  const hist = s.history.list();
  eq("aiturn.commit.one-step", hist.labels.length, 1);
  eq("aiturn.commit.label", hist.labels[0], "ai: 描出史莱姆轮廓并铺底色");
  eq("aiturn.commit.label-prefix", hist.labels[0].slice(0, AI_TURN_LABEL_PREFIX.length), "ai: ");
  eq("aiturn.commit.index", hist.index, 1);
  sameBytes("aiturn.commit.content-kept", spaceBytes(s), after);
  s.undo();
  sameBytes("aiturn.commit.undo-covers-turn", spaceBytes(s), before);
  eq("aiturn.commit.undo-one-step", labels(s).length, 1);
  s.redo();
  sameBytes("aiturn.commit.redo-covers-turn", spaceBytes(s), after);
  s.undo(); // 后面的用例从「回合前」继续

  // 标签归一化：自带前缀不重复 / 空标签兜底 / 换行压成空格 / 超长截断
  const labelCase = async (raw: string, want: string, name: string): Promise<void> => {
    s.history.clear();
    s.beginAiTurn(raw);
    await callTool("layer_toggle_visible", { li: 1 }, toolCtx(s));
    s.commitAiTurn();
    const ls = labels(s);
    eq("aiturn.label." + name, ls[ls.length - 1], want);
  };
  await labelCase("ai: 描出史莱姆轮廓并铺底色", "ai: 描出史莱姆轮廓并铺底色", "no-double-prefix");
  await labelCase("", AI_TURN_LABEL_PREFIX + AI_TURN_LABEL_FALLBACK, "fallback");
  await labelCase("  画\n个   蘑菇  ", "ai: 画 个 蘑菇", "whitespace");
  await labelCase("x".repeat(200), AI_TURN_LABEL_PREFIX + "x".repeat(AI_TURN_LABEL_MAX), "truncated");

  // ------------------------------------------------------------ 3. 无改动：false 且不压栈
  s.history.clear();
  s.beginAiTurn("什么都不做");
  eq("aiturn.nochange.commit", s.commitAiTurn(), false);
  eq("aiturn.nochange.no-step", labels(s).length, 0);
  ok("aiturn.nochange.closed", !s.aiTurnOpen());
  // 只换当前图层（文档内容没变）→ 不算改动，但选择也不该被吞掉
  s.beginAiTurn("只切图层");
  await callTool("layer_select", { li: 1 }, toolCtx(s));
  eq("aiturn.nochange.select-only", s.commitAiTurn(), false);
  eq("aiturn.nochange.select-kept", s.curLayer(), 1);
  eq("aiturn.nochange.select-no-step", labels(s).length, 0);
  // 走自由函数（§5.1 的五个名字）也一样
  s.beginAiTurn("空回合走自由函数");
  eq("aiturn.nochange.free-commit", commitTurn(), false);
  ok("aiturn.nochange.free-closed", !isTurnOpen());

  // ------------------------------------------------------------ 4. preview 的计数与脏矩形
  const s5 = live();
  s5.history.clear();
  s5.beginAiTurn("只改一个小方块");
  const cel5 = s5.doc.ensureCel(0, 0);
  for (let y = 2; y < 6; y++) for (let x = 3; x < 7; x++) cel5.setPixel(x, y, [0, 255, 0, 255]);
  const px5 = spaceBytes(s5);
  eq("aiturn.preview.rect-exact", s5.previewAiTurn().rect, { x: 3, y: 2, w: 4, h: 4 });
  eq("aiturn.preview.rect-cached", previewTurn().rect, { x: 3, y: 2, w: 4, h: 4 });
  sameBytes("aiturn.preview.no-touch", spaceBytes(s5), px5); // preview 只算不改文档
  eq("aiturn.preview.count-free", previewTurn().count, 0);
  const h5 = s5.aiTurnHandle();
  ok("aiturn.preview.handle-open", h5.isOpen());
  h5.mark();
  eq("aiturn.preview.count-after-mark", s5.previewAiTurn().count, 1);
  eq("aiturn.preview.rect-after-mark", s5.previewAiTurn().rect, { x: 3, y: 2, w: 4, h: 4 });
  ok("aiturn.preview.free-open", isTurnOpen());
  eq("aiturn.preview.free-commit", commitTurn(), true); // 用自由函数提交
  eq("aiturn.preview.one-step", labels(s5).length, 1);
  eq("aiturn.preview.label", labels(s5)[0], "ai: 只改一个小方块");
  ok("aiturn.preview.handle-shut", !s5.aiTurnHandle().isOpen());

  // ------------------------------------------------------------ 5. rollback：与新开时逐字节一致（多层多帧）
  const s6 = live();
  const ref = live(); // 同一份构造出来的「新开」工程
  sameBytes("aiturn.rollback.same-as-fresh", contentBytes(s6), contentBytes(ref));
  const rbBefore = spaceBytes(s6);
  s6.beginAiTurn("乱画一通");
  for (let i = 0; i < 10; i++) {
    await callTool("color_replace", { from: "#ff0000", to: "#00ffff", scope: "allFrames" }, toolCtx(s6));
    await callTool("palette_add", { color: "#123456" }, toolCtx(s6));
    await callTool("layer_add", {}, toolCtx(s6));
  }
  ok("aiturn.rollback.changed", spaceBytes(s6) !== rbBefore);
  eq("aiturn.rollback.layers-grown", s6.doc.layers.length, 13);
  s6.rollbackAiTurn();
  sameBytes("aiturn.rollback.bytes", spaceBytes(s6), rbBefore);
  sameBytes("aiturn.rollback.fresh", contentBytes(s6), contentBytes(ref));
  eq("aiturn.rollback.no-history", labels(s6).length, 0);
  ok("aiturn.rollback.closed", !s6.aiTurnOpen());
  ok("aiturn.rollback.autosave-restored", priv(s6).replayActive === false && priv(s6).aiTurnAutosaveHeld === false);
  // 闸门真的还回去了：普通写操作照旧压历史
  s6.layerAdd();
  eq("aiturn.rollback.gate-restored", labels(s6).length, 1);
  s6.undo();
  eq("aiturn.rollback.undo-works", labels(s6).length, 1);

  // ------------------------------------------------------------ 6. autosave：回合期间一个字节都不落盘
  // 观测口径 = autosave 模块的 `saveAutosave`（真的写盘才算一次）：`writeAutosave` 被旗子挡住的
  // 早退不算写盘 —— 这正是要证明的事。计时器用可记录的桩，好模拟「旧计时器回调仍然跑了」。
  const amod = require("../src/io/autosave") as Record<string, unknown>;
  const origSave = amod.saveAutosave;
  const w7 = window as unknown as Record<string, unknown>;
  const realSetTimeout = w7.setTimeout;
  const realClearTimeout = w7.clearTimeout;
  let writes = 0;
  const timers: Array<{ id: number; cb: () => void }> = [];
  const clearedIds: number[] = [];
  let timerSeq = 900;
  amod.saveAutosave = async () => { writes++; return "idb"; };
  w7.setTimeout = (cb: () => void) => { const id = ++timerSeq; timers.push({ id, cb }); return id; };
  w7.clearTimeout = (id: number) => { clearedIds.push(id); };
  try {
    const s7 = live();
    priv(s7).autosaveDirty = false;
    priv(s7).autosaveTimer = null;
    // 回合**之前**就排定了一次自动保存（比如用户刚画过两笔、还没到 autosaveMin）
    s7.scheduleAutosave();
    const pendingId = priv(s7).autosaveTimer as number;
    const pendingCb = timers[timers.length - 1].cb;
    eq("aiturn.autosave.pending-scheduled", priv(s7).autosaveDirty, true);
    s7.beginAiTurn("画个蘑菇");
    eq("aiturn.autosave.pending-timer-cleared", priv(s7).autosaveTimer, null); // F2：挂抑制时取消待触发的计时器
    ok("aiturn.autosave.pending-cleared-called", clearedIds.indexOf(pendingId) >= 0, "cleared=" + clearedIds.join(","));
    pendingCb();                                                               // 模拟「旧计时器回调仍然跑了」
    eq("aiturn.autosave.pending-timer-no-write", writes, 0);                    // writeAutosave 的旗子检查挡下
    priv(s7).autosaveDirty = false;                                            // 模拟上一次保存已写完，好干净地观察下面的抑制
    await callTool("layer_toggle_visible", { li: 0 }, toolCtx(s7));
    s7.repaint();          // 这两条都会走 scheduleAutosave()，回合期间必须早退
    s7.repaintRect(null);
    eq("aiturn.autosave.turn-not-dirty", priv(s7).autosaveDirty, false);
    eq("aiturn.autosave.turn-no-timer", priv(s7).autosaveTimer, null);
    await s7.flushAutosave(); // 页面隐藏时的同步 flush 也要早退
    eq("aiturn.autosave.turn-no-flush", writes, 0);
    eq("aiturn.autosave.commit", s7.commitAiTurn(), true);
    eq("aiturn.autosave.commit-dirty", priv(s7).autosaveDirty, true);
    ok("aiturn.autosave.commit-timer", priv(s7).autosaveTimer !== null);
    await s7.flushAutosave();
    eq("aiturn.autosave.commit-flush", writes, 1);
    eq("aiturn.autosave.after-commit-open", s7.aiTurnOpen(), false);

    // ---- F3：回合与回放查看器是两面**独立**的旗，互不覆盖 ----
    const s7b = live();
    priv(s7b).autosaveDirty = false;
    priv(s7b).autosaveTimer = null;
    s7b.beginAiTurn("回合中来回切回放");
    s7b.setReplayMode(true);   // 回合中开回放
    await callTool("layer_toggle_visible", { li: 0 }, toolCtx(s7b));
    s7b.repaint();
    eq("aiturn.autosave.turn-replay-on-not-dirty", priv(s7b).autosaveDirty, false);
    s7b.setReplayMode(false);  // 回合中把回放关掉：抑制必须还在（早先是靠还原 replayActive 的，会漏）
    await callTool("layer_toggle_visible", { li: 1 }, toolCtx(s7b));
    s7b.repaint();
    eq("aiturn.autosave.turn-replay-off-still-suppressed", priv(s7b).autosaveDirty, false);
    eq("aiturn.autosave.turn-replay-off-no-timer", priv(s7b).autosaveTimer, null);
    eq("aiturn.autosave.turn-replay-off-held", priv(s7b).aiTurnAutosaveHeld, true);
    eq("aiturn.autosave.turn-replay-flag-untouched", priv(s7b).replayActive, false); // 回合不再借/还回放那面旗
    eq("aiturn.autosave.turn-replay-commit", s7b.commitAiTurn(), true);
    eq("aiturn.autosave.turn-replay-commit-dirty", priv(s7b).autosaveDirty, true);
    eq("aiturn.autosave.turn-replay-held-cleared", priv(s7b).aiTurnAutosaveHeld, false);

    const s7c = live();
    priv(s7c).autosaveDirty = false;
    priv(s7c).autosaveTimer = null;
    s7c.setReplayMode(true);   // 回放查看器先开着，然后进回合
    s7c.beginAiTurn("回放中开回合");
    await callTool("layer_toggle_visible", { li: 0 }, toolCtx(s7c));
    s7c.repaint();
    eq("aiturn.autosave.replay-first-turn-not-dirty", priv(s7c).autosaveDirty, false);
    eq("aiturn.autosave.replay-first-commit", s7c.commitAiTurn(), true);
    eq("aiturn.autosave.replay-first-replay-kept", priv(s7c).replayActive, true); // 收尾没有把回放模式关掉
    eq("aiturn.autosave.replay-first-held-cleared", priv(s7c).aiTurnAutosaveHeld, false);
    await s7c.flushAutosave();                                                    // 回放还开着 → 一个字节都不写
    eq("aiturn.autosave.replay-first-no-write", writes, 1);
    s7c.setReplayMode(false);
    await s7c.flushAutosave();                                                    // 回放关掉后才真的写
    eq("aiturn.autosave.replay-first-write", writes, 2);
  } finally {
    amod.saveAutosave = origSave;
    w7.setTimeout = realSetTimeout;
    w7.clearTimeout = realClearTimeout;
  }

  // ------------------------------------------------------------ 7. 多画布：一条 undo 覆盖全部画布
  const s8 = live();
  const other = new Doc(16, 16, "second");
  other.palette = [[255, 0, 0, 255]];
  const ocel = other.ensureCel(0, 0);
  for (let x = 0; x < 6; x++) ocel.setPixel(x, 0, [255, 0, 0, 255]);
  s8.addCanvas(other, { focus: false });
  s8.history.clear();
  const multiBefore = spaceBytes(s8);
  s8.beginAiTurn("两张画布一起改");
  await callTool("palette_add", { color: "#010203" }, toolCtx(s8)); // 焦点画布（第一张）
  const idx2 = s8.docs.findIndex((e) => e.doc === other);
  s8.focusCanvas(idx2);
  await callTool("color_replace", { from: "#ff0000", to: "#00ffff", scope: "canvas" }, toolCtx(s8));
  eq("aiturn.multi.preview-count", s8.previewAiTurn().count, 2);
  const multiAfter = spaceBytes(s8);
  ok("aiturn.multi.changed", multiAfter !== multiBefore);
  eq("aiturn.multi.commit", s8.commitAiTurn(), true);
  eq("aiturn.multi.one-step", labels(s8).length, 1);
  eq("aiturn.multi.label", labels(s8)[0], "ai: 两张画布一起改");
  // 记录现状（**不要试图改行为**）：跨画布回合只能走 `History.record` 的闭包，它没有可序列化的
  // payload（.pxc 的历史导出只认 enc/snap/data），所以 dump 出来是空数组 —— 用「一条 undo 覆盖
  // 所有画布」换的。单画布回合走 pushStruct，dump 里能看到一条。
  eq("aiturn.multi.dump-empty", s8.history.dump(() => "d1").entries.length, 0);
  // 对照：单画布回合走 pushStruct（有 before/after 快照），dump 里就是正常的一条
  const s8b = live();
  s8b.history.clear();
  s8b.beginAiTurn("单画布一轮");
  await callTool("palette_add", { color: "#020304" }, toolCtx(s8b));
  eq("aiturn.multi.single-commit", s8b.commitAiTurn(), true);
  eq("aiturn.multi.single-dump-one", s8b.history.dump(() => "d1").entries.length, 1);
  sameBytes("aiturn.multi.content-kept", spaceBytes(s8), multiAfter);
  s8.undo();
  sameBytes("aiturn.multi.undo-both", spaceBytes(s8), multiBefore);
  s8.redo();
  sameBytes("aiturn.multi.redo-both", spaceBytes(s8), multiAfter);

  // ------------------------------------------------------------ 8. 回合里新开的画布：回滚要删掉，undo 也要删掉
  const s9 = live();
  s9.history.clear();
  const s9Before = spaceBytes(s9);
  s9.beginAiTurn("顺手开张新画布");
  s9.addCanvas(new Doc(8, 8, "extra"));
  await callTool("palette_add", { color: "#0f0f0f" }, toolCtx(s9));
  eq("aiturn.newcanvas.added", s9.docs.length, 2);
  s9.rollbackAiTurn();
  eq("aiturn.newcanvas.rollback-count", s9.docs.length, 1);
  sameBytes("aiturn.newcanvas.rollback-bytes", spaceBytes(s9), s9Before);
  eq("aiturn.newcanvas.rollback-history", labels(s9).length, 0);

  s9.beginAiTurn("加一张画布并画点东西");
  s9.addCanvas(new Doc(8, 8, "extra2"));
  await callTool("palette_add", { color: "#202020" }, toolCtx(s9));
  const s9After = spaceBytes(s9);
  eq("aiturn.newcanvas.second", s9.docs.length, 2);
  eq("aiturn.newcanvas.commit", s9.commitAiTurn(), true);
  eq("aiturn.newcanvas.one-step", labels(s9).length, 1);
  sameBytes("aiturn.newcanvas.content-kept", spaceBytes(s9), s9After);
  s9.undo();
  eq("aiturn.newcanvas.undo-removes", s9.docs.length, 1);
  sameBytes("aiturn.newcanvas.undo-bytes", spaceBytes(s9), s9Before);
  s9.redo();
  sameBytes("aiturn.newcanvas.redo-restores", spaceBytes(s9), s9After);

  // ------------------------------------------------------------ 9. 异常路径：commit 中途抛错 → 回到回合开始，不留残留
  const s10 = live();
  s10.history.clear();
  const realPush = s10.history.pushStruct; // 回合开始前抓一份「原装」的，用来验闸门还回去了
  const realCapture = s10.doc.capture;     // 同理：doc 快照方法的原装版本
  const s10Before = spaceBytes(s10);
  s10.beginAiTurn("模型中途挂了");
  await callTool("palette_add", { color: "#445566" }, toolCtx(s10));
  ok("aiturn.boom.changed", spaceBytes(s10) !== s10Before);
  // commit 的第二步就是给「回合结束」拍快照：让它抛错，模拟任何中途异常
  s10.doc.capture = () => { throw new Error("boom"); };
  eq("aiturn.boom.commit-false", s10.commitAiTurn(), false);
  s10.doc.capture = realCapture;
  sameBytes("aiturn.boom.bytes-rolled-back", spaceBytes(s10), s10Before);
  eq("aiturn.boom.no-history", labels(s10).length, 0);
  ok("aiturn.boom.closed", !s10.aiTurnOpen());
  ok("aiturn.boom.gate-restored", s10.history.pushStruct === realPush);
  ok("aiturn.boom.autosave-restored",
    priv(s10).aiTurnAutosaveHeld === false
    && priv(s10).replayActive === false);
  s10.layerAdd();
  eq("aiturn.boom.writes-again", labels(s10).length, 1);

  // 压栈**之后**才出错（极端情况）：栈里那条已经存在、抽不掉，所以文档必须留在「回合结束」
  const s10b = live();
  s10b.history.clear();
  const realSync = s10b.syncAfterDocChange;
  s10b.beginAiTurn("压栈后挂掉");
  await callTool("palette_add", { color: "#778899" }, toolCtx(s10b));
  const s10bAfter = spaceBytes(s10b);
  s10b.syncAfterDocChange = () => { throw new Error("boom"); };
  eq("aiturn.post-push.commit-false", s10b.commitAiTurn(), false);
  s10b.syncAfterDocChange = realSync;
  eq("aiturn.post-push.one-step", labels(s10b).length, 1);
  eq("aiturn.post-push.label", labels(s10b)[0], "ai: 压栈后挂掉");
  sameBytes("aiturn.post-push.kept-after", spaceBytes(s10b), s10bAfter);
  ok("aiturn.post-push.closed", !s10b.aiTurnOpen());

  // ------------------------------------------- 9b. 残留：回合漏了 rollback / 走安全入口 (t14-F1)
  const s12 = live();
  s12.history.clear();
  const s12Before = spaceBytes(s12);
  const realPush12 = s12.history.pushStruct;
  s12.beginAiTurn("漏了 rollback");
  await callTool("palette_add", { color: "#333333" }, toolCtx(s12));
  // 调用方忘了 rollback（模拟「AI 循环抛错后没收拾」）：回合一直开着
  s12.layerAdd(); // 用户的写操作被闸门挡下 → 历史一动不动
  eq("aiturn.residue.labels-still-zero", labels(s12).length, 0);
  eq("aiturn.residue.autosave-held", priv(s12).aiTurnAutosaveHeld, true);
  eq("aiturn.residue.replay-flag-untouched", priv(s12).replayActive, false); // F3：回合不再借回放那面旗
  eq("aiturn.residue.turn-open", s12.aiTurnOpen(), true);
  // 补上 rollback：连用户中途那次 layerAdd 一起吞掉 —— 这就是「回合开着时用户写入会被回滚吞掉」
  s12.rollbackAiTurn();
  sameBytes("aiturn.residue.rollback-bytes", spaceBytes(s12), s12Before);
  ok("aiturn.residue.rollback-gate", s12.history.pushStruct === realPush12);
  eq("aiturn.residue.rollback-held-cleared", priv(s12).aiTurnAutosaveHeld, false);
  eq("aiturn.residue.rollback-closed", s12.aiTurnOpen(), false);
  s12.layerAdd();
  eq("aiturn.residue.writes-again", labels(s12).length, 1);

  // 安全入口 runAiTurn：成功路径
  const s13 = live();
  s13.history.clear();
  const r13 = await s13.runAiTurn("跑一轮", async () => {
    const rr = await callTool("palette_add", { color: "#556677" }, toolCtx(s13));
    return rr.ok === true ? "done" : "tool-failed";
  });
  eq("aiturn.run.ok", r13.ok, true);
  eq("aiturn.run.result", r13.result, "done");
  eq("aiturn.run.closed", s13.aiTurnOpen(), false);
  eq("aiturn.run.one-step", labels(s13).length, 1);
  eq("aiturn.run.label", labels(s13)[0], "ai: 跑一轮");

  // 安全入口：无改动的一轮也算正常收尾（commit false 不是失败）
  const r13b = await s13.runAiTurn("空跑", () => 7);
  eq("aiturn.run.noop-ok", r13b.ok, true);
  eq("aiturn.run.noop-result", r13b.result, 7);
  eq("aiturn.run.noop-no-new-step", labels(s13).length, 1);
  eq("aiturn.run.noop-closed", s13.aiTurnOpen(), false);

  // 安全入口：fn 抛错 → rollback + 异常原样带回，闸门与抑制都归还（t14-F1 的 catch 路径）
  const s14 = live();
  s14.history.clear();
  const s14Before = spaceBytes(s14);
  const realPush14 = s14.history.pushStruct;
  const r14 = await s14.runAiTurn("中途失败的一轮", async () => {
    await callTool("palette_add", { color: "#444444" }, toolCtx(s14));
    throw new Error("model-dead");
  });
  eq("aiturn.run.error-ok", r14.ok, false);
  eq("aiturn.run.error-message", (r14.error as Error).message, "model-dead");
  eq("aiturn.run.error-closed", s14.aiTurnOpen(), false);
  sameBytes("aiturn.run.error-rolled-back", spaceBytes(s14), s14Before);
  eq("aiturn.run.error-no-step", labels(s14).length, 0);
  ok("aiturn.run.error-gate", s14.history.pushStruct === realPush14);
  eq("aiturn.run.error-held-cleared", priv(s14).aiTurnAutosaveHeld, false);
  eq("aiturn.run.error-replay-untouched", priv(s14).replayActive, false);
  s14.layerAdd();
  eq("aiturn.run.error-writes-again", labels(s14).length, 1);
  s14.undo();

  // 安全入口的自由函数形式（先用 bindTurnHost 明确宿主）
  bindTurnHost(s14);
  const r14b = await runAiTurn("自由函数跑一轮", async () => {
    await callTool("palette_add", { color: "#666666" }, toolCtx(s14));
    return 1;
  });
  eq("aiturn.run.free-ok", r14b.ok, true);
  eq("aiturn.run.free-label", labels(s14)[labels(s14).length - 1], "ai: 自由函数跑一轮");
  eq("aiturn.run.free-closed", s14.aiTurnOpen(), false);

  // 安全入口：收尾失败（压栈后同步抛错）→ ok:false 且带 error（不会被当成「没改动」）
  const s14c = live();
  s14c.history.clear();
  const realSync14 = s14c.syncAfterDocChange;
  const r14c = await (async (): Promise<{ ok: boolean; error?: unknown }> => {
    const p = s14c.runAiTurn("收尾挂掉", async () => {
      await callTool("palette_add", { color: "#777777" }, toolCtx(s14c));
      s14c.syncAfterDocChange = () => { throw new Error("sync-boom"); };
      return 1;
    });
    const r = await p;
    s14c.syncAfterDocChange = realSync14;
    return r;
  })();
  eq("aiturn.run.commit-fail-ok", r14c.ok, false);
  eq("aiturn.run.commit-fail-error", (r14c.error as Error).message, "sync-boom");
  eq("aiturn.run.commit-fail-closed", s14c.aiTurnOpen(), false);

  // ------------------------------------------------------------ 10. 重复 begin：先丢弃上一轮未提交的改动
  const s11 = live();
  s11.history.clear();
  const b11 = spaceBytes(s11);
  const i1 = s11.beginAiTurn("第一轮");
  await callTool("palette_add", { color: "#abcdef" }, toolCtx(s11));
  ok("aiturn.reopen.changed", spaceBytes(s11) !== b11);
  const i2 = s11.beginAiTurn("第二轮");
  ok("aiturn.reopen.new-id", i2 > i1, "i1=" + i1 + " i2=" + i2);
  ok("aiturn.reopen.still-open", s11.aiTurnOpen());
  sameBytes("aiturn.reopen.first-discarded", spaceBytes(s11), b11);
  eq("aiturn.reopen.no-history", labels(s11).length, 0);
  await callTool("layer_toggle_visible", { li: 0 }, toolCtx(s11));
  eq("aiturn.reopen.commit", s11.commitAiTurn(), true);
  eq("aiturn.reopen.label", labels(s11)[0], "ai: 第二轮");
  s11.undo();
  sameBytes("aiturn.reopen.undo", spaceBytes(s11), b11);
}
