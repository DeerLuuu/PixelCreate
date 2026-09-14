// 渲染调试 HUD（设置 → 显示 → 渲染调试）。
//
// 目的：回答"这一次渲染到底渲染了什么"。每次重绘都会往 `renderDebug` 记一条事件
// （走的是 `RenderServer.noteFrame`），这里把它画成左上角一小块面板：计数 + 最近几次
// 事件（整幅/局部/跳过、原因、脏矩形 → 屏幕重绘区域、是否整块 blit、耗时）。
//
// 几点约定：
//  · **关掉时零成本**：`RenderDebug.note()` 第一行就返回，组件也不挂载。
//  · 数据源是 `src/servers/render.ts` 的模块级单例 `renderDebug`，也是控制台入口
//    （`__pcRender.text()` / `__pcRender.totals` / `__pcRender.setEnabled(true)`）。
//  · 只读、不吃指针事件（`pointer-events:none`），不挡画布手势。
import { useEffect, useState } from "react";
import { SESSION } from "./singleton";
import { renderDebug, type RenderEvent } from "../servers/render";
import type { makeT } from "./i18n";

/** 一行事件的简短描述（宽度有限，宁可短） */
function line(e: RenderEvent): string {
  const r = e.docRect ? `${e.docRect.x},${e.docRect.y} ${e.docRect.w}x${e.docRect.h}` : "整幅";
  const s = e.screen ? `${e.screen.x},${e.screen.y} ${e.screen.w}x${e.screen.h}` : "全屏";
  const tag = e.kind === "skip" ? "跳过" : e.kind === "full" ? "整幅" : "局部";
  return `#${e.seq} f${e.fi} ${tag} ${e.reason} 脏[${r}] 屏[${s}]${e.fullBlit ? " FULL" : ""} ${e.ms.toFixed(1)}ms`;
}

export function RenderDebugHud({ t }: { t: ReturnType<typeof makeT> }): JSX.Element | null {
  const [, bump] = useState(0);
  const on = SESSION.prefs.renderDebug;

  // 订阅事件流（记录器自己只保留最近 cap 条）
  useEffect(() => {
    if (!on) return;
    return renderDebug.subscribe(() => bump((n) => n + 1));
  }, [on]);
  // 开关切换时把记录器一起开关：关掉即清空，避免留下陈旧数字
  useEffect(() => {
    renderDebug.setEnabled(on);
    return () => { renderDebug.setEnabled(false); };
  }, [on]);

  if (!on) return null;
  const tot = renderDebug.totals;
  const evts = renderDebug.events().slice(-8).reverse();
  return (
    <div className="rdbg" aria-live="off">
      <div className="rdbg-head">
        <span className="rdbg-title">{t("renderDebug")}</span>
        <span className="rdbg-stat">
          重绘 {tot.frames} · 合成 {tot.composes}（整幅 {tot.rebuilds} / 局部 {tot.partials}）· 跳过 {tot.skips}
          {" · "}整块 {tot.fullBlits} · 上次 {tot.lastMs.toFixed(1)}ms · 峰值 {tot.maxMs.toFixed(1)}ms
        </span>
      </div>
      <div className="rdbg-list">
        {evts.length === 0
          ? <div className="rdbg-row rdbg-dim">（还没有重绘）</div>
          : evts.map((e) => <div className="rdbg-row" key={e.seq}>{line(e)}</div>)}
      </div>
    </div>
  );
}
