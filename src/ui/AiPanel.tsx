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
// key 不出现在这个文件里的任何提示 / 日志 / 网络以外的路径：面板只显示端点与模型名，
// key 只写进 `Authorization` 头（在 ai-chat 的 requestModel 里）。

import { useEffect, useRef, useState } from "react";
import { SESSION } from "./singleton";
import { Btn } from "./kit/primitives";
import { isNativeShell } from "../io/bridge";
import * as bridge from "../io/bridge";
import { docDigest } from "../app/ai-doc";
import { chatConfigError, formatCallLog, runChatTurn, systemMessage, userMessage } from "../app/ai-chat";
import type { ChatCallLog, ChatFetch, ChatMessage } from "../app/ai-chat";
import type { AiToolCtx } from "../app/ai-tools";
import { aiChatSettings } from "../app/settings";
import type { Rect } from "../engine/types";
import type { makeT } from "./i18n";

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

/** 浏览器 / APK / 桌面壳的 fetch 都满足 `ChatFetch`；没有 fetch 的运行环境返回 null */
function platformFetch(): ChatFetch | null {
  if (typeof fetch !== "function") return null;
  return (url, init) => fetch(url, init);
}

export function AiPanel({ t, onBack }: { t: ReturnType<typeof makeT>; onBack?: () => void }) {
  const native = isNativeShell();
  /** 模型侧的消息流（不含 system —— 每次发送时按当时的画布摘要重新拼一条） */
  const [thread, setThread] = useState<ChatMessage[]>([]);
  const [entries, setEntries] = useState<AiEntry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [logs, setLogs] = useState<ChatCallLog[]>([]);
  const [pending, setPending] = useState<AiPending | null>(null);
  const live = useRef(true);

  useEffect(() => () => {
    live.current = false;
    // 卸载时把开着的回合收掉：否则它会一直挡着用户的写入（下一次 rollback 会吞掉它们）
    if (SESSION.aiTurnOpen()) SESSION.rollbackAiTurn();
  }, []);

  const cfg = aiChatSettings();
  const fetchFn = platformFetch();

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
    const cfgErr = chatConfigError(cfg);
    if (cfgErr) { setErr(cfgErr); return; }             // 缺 key / 缺端点：一个请求都不发
    if (!fetchFn) { setErr(t("aiChatErrOff")); return; }
    const ctx: AiToolCtx = { session: SESSION, confirm: confirmTool, turn: null };
    const messages = [systemMessage({ digest: digestText() }), ...thread, userMessage(text)];
    setEntries((prev) => prev.concat([{ role: "user", text }]));
    setInput("");
    setErr("");
    setLogs([]);
    setBusy(true);
    const r = await runChatTurn({
      messages,
      ctx,
      endpoint: cfg.endpoint.trim(),
      model: cfg.model.trim(),
      key: cfg.key,
      fetchFn,
      commit: false,                                    // 预览模式：回合留给「应用 / 放弃」
      label: text,
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
  const head = cfg.endpoint.trim() && cfg.model.trim()
    ? cfg.model.trim() + " · " + cfg.endpoint.trim()
    : t("aiChatErrNotReady");

  return (
    <div data-guide="ai-panel">
      <div className="row-actions">
        {onBack ? <Btn icon="" label={t("aiChatBack")} onClick={onBack} guide="ai-back" /> : null}
        <span className="row-note" style={{ margin: 0 }}>{head}</span>
      </div>
      <div data-guide="ai-thread" style={{ maxHeight: "42vh", overflowY: "auto" }}>
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
      {pending ? (
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
