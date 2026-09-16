// 应用内助手的**浮动小窗**（docs/PLAN-ai.md §3.7.6 是唯一契约）。
//
// 为什么要有这个文件：助手原来是 `MenuModal` 里的一个整屏子面板（`modals.tsx` 的 `setSub("ai")`），
// 一关菜单它就没了、也挡不住画布。现在它是 `createPortal` 到 `document.body` 的浮窗：
// 自带标题栏（拖动柄 + 最小化 + 关闭），可以拖到任何地方、缩放到任何大小，位置尺寸**按机器**持久化。
// 对话面板与助手小球 `ChatBall` 在 `src/ui/AiPanel.tsx`（同一个交互闭环，放一起省得来回跳）。
//
// 四条边界（改这里之前先读完，别把它们改回去）：
//   1. **逻辑一行都不在这里**：整轮循环仍在 `src/app/ai-chat.ts`；本文件只做容器、拖动、持久化。
//      `AiPanel` 保持「只做对话区」，原样搬进来 —— 它自己的平台门（`if (!native)`）也不动。
//   2. **平台门**：`isNativeShell()` 为假时这里**一个 DOM 都不渲染、一个请求都不发**
//      （挂载点在 `App.tsx`，同一个判据）。
//   3. **回合不变式**：最小化 = 浮窗 DOM **真的卸载**（`display:none` 不算，`AiPanel` 的卸载钩子要跑）。
//      「卸载时留不留这一轮」只认持久化状态（`aiChatSettings().winOpen/winMin`，见
//      `AiPanel.tsx` 的 `aiPanelKeepsTurn()`）：最小化 → 留着；关窗 / 被别处卸掉 → 放弃。
//      **所以本文件不许自己写 `winMin`**：最小化走 `onMinimize`、关窗走 `onClose`，
//      两者都是 `App.tsx` 里那一个写状态的地方（P9 修的就是「按钮路径漏了」这一类问题，
//      让窗口成为第二个写入点必然复现）。App **不要**把浮窗包进 `Keep`。
//   4. **拖动 / 缩放只用指针事件**（pointerdown/move/up + capture），不用鼠标专属事件，
//      所以触屏与电脑模式是**同一条**代码路径。
//
// 几何口径全在 `src/app/uibar.ts`（纯函数 + 单测）：`pc.aichat.win` 的读写、坏数据回落、
// 视口夹取、拖动算术。这里只负责把它们接到 DOM 上。

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./base";
import { isNativeShell } from "../io/bridge";
import {
  AI_CHAT_WIN_KEY, aiWinDragFrom, clampAiWinLayout, normalizeAiWinLayout,
} from "../app/uibar";
import type { AiWinLayout } from "../app/uibar";
import { AiPanel, aiWinStore } from "./AiPanel";
import type { makeT } from "./i18n";

/** `localStorage` 读写一律包在 try 里：隐私模式 / 坏数据都不该让窗口打不开 */
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

/** 把一份几何写盘（键与版本号的口径固定在 `src/app/uibar.ts`，这里不另立一份） */
function saveWin(l: AiWinLayout): void {
  lsSet(AI_CHAT_WIN_KEY, { v: 1, x: l.x, y: l.y, w: l.w, h: l.h, min: l.min });
}

/** 拖动 / 缩放的一次会话（`id` 用来忽略别的指针） */
interface DragState {
  id: number;
  kind: "move" | "resize";
  x0: number;
  y0: number;
  /** 按下那一刻的几何：拖动**从不累加**，每一帧都从起点重算（否则夹取会累积漂移） */
  l0: AiWinLayout;
}

/**
 * 助手浮窗本体（`createPortal` 到 body）。只在两处状态上工作：
 * `aiChatSettings()` 里的三个布尔（开 / 最小化 / 允许小球）与 `pc.aichat.win` 里的几何。
 *
 * 拖动 / 缩放**松手那一下**才写盘（与 `pc.orb.pos` 一致），而每一帧都跑夹取，
 * 所以屏幕上看到的永远是屏幕内的值、存进去的也是。
 *
 * **写入点只有一个**：`onMinimize` / `onClose` 都由 `App.tsx` 提供（它那边同时负责
 * `pc.aichat` 状态与「留不留这一轮」的判定），本组件自己不碰设置、不碰回合。
 */
export function AiWindow({ t, onMinimize, onClose }: {
  t: ReturnType<typeof makeT>;
  /** 最小化成浮球（App 写状态；窗口靠它卸载） */
  onMinimize: () => void;
  /** 关窗（App 写状态；回合还没收尾就放弃） */
  onClose: () => void;
}) {
  const [layout, setLayout] = useState<AiWinLayout>(() => normalizeAiWinLayout(lsGet(AI_CHAT_WIN_KEY)));
  const [dragging, setDragging] = useState(false);
  const drag = useRef<DragState | null>(null);

  /** 最小化前先把几何（含 `min:true`）落盘：还原时窗口的位置与尺寸就是这一份 */
  const minimize = (): void => {
    saveWin({ ...layout, min: true });
    onMinimize();
  };

  /** 旋屏 / 改窗口大小：重跑一次夹取并写盘（窗口不许留在屏幕外） */
  useEffect(() => {
    const fix = () => setLayout((l) => {
      const c = clampAiWinLayout(l);
      saveWin(c);
      return c;
    });
    window.addEventListener("resize", fix);
    window.addEventListener("orientationchange", fix);
    return () => {
      window.removeEventListener("resize", fix);
      window.removeEventListener("orientationchange", fix);
    };
  }, []);

  const startDrag = (kind: "move" | "resize") => (e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    drag.current = { id: e.pointerId, kind, x0: e.clientX, y0: e.clientY, l0: layout };
    setDragging(true);
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const onMove = (ev: PointerEvent) => {
      const d = drag.current;
      if (!d || ev.pointerId !== d.id) return;
      setLayout(clampAiWinLayout(aiWinDragFrom(d.l0, d.kind, ev.clientX - d.x0, ev.clientY - d.y0)));
    };
    const done = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", done);
      window.removeEventListener("pointercancel", done);
      drag.current = null;
      setDragging(false);
      setLayout((l) => { const c = clampAiWinLayout(l); saveWin(c); return c; });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", done);
    window.addEventListener("pointercancel", done);
  };

  if (!isNativeShell()) return null;

  return createPortal(
    <section
      className={"ai-win" + (dragging ? " dragging" : "")}
      data-guide="ai-window"
      role="dialog"
      aria-label={t("aiChatTitle")}
      style={{ left: layout.x, top: layout.y, width: layout.w, height: layout.h }}
    >
      {/* 标题栏：整条都是拖动柄（按钮自己 stopPropagation，不会被当成拖动起点）。
          双击标题栏 = 最小化（§3.7.6 事件表 L465），与最小化按钮走**同一个** `minimize()`。 */}
      <div className="ai-win-head" data-guide="ai-win-head"
        onPointerDown={startDrag("move")} onDoubleClick={minimize}>
        <Icon id="i-ai-chat" size={15} />
        <span className="ai-win-title">{t("aiChatTitle")}</span>
        <span className="grow" />
        <button type="button" className="btn small" data-guide="ai-min" title={t("aiChatMinimize")}
          aria-label={t("aiChatMinimize")}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); minimize(); }}>
          <Icon id="i-minus" size={14} />
        </button>
        <button type="button" className="btn small" data-guide="ai-close" title={t("close")}
          aria-label={t("close")}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onClose(); }}>
          <Icon id="i-x" size={15} />
        </button>
      </div>
      <div className="ai-win-body">
        {/* 面板自己带平台门；传「关窗」当它的返回键（最小化不经过这里） */}
        <AiPanel t={t} onBack={onClose} store={aiWinStore} />
      </div>
      {/* 右下角唯一的缩放抓手（不做八向：收益低、触屏易误触，见 §3.7.6） */}
      <div className="ai-win-grip" data-guide="ai-grip" title={t("aiChatResize")}
        onPointerDown={startDrag("resize")} />
    </section>,
    document.body,
  );
}
