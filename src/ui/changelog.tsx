// Release notes (更新日志): data + modal. Auto-shown on first launch after an
// update (version marker in localStorage); also reachable from the main menu.
import React, { useEffect, useMemo, useState } from "react";
import { SESSION } from "./singleton";
import { makeT } from "./i18n";
import type { Lang } from "./i18n";
import { Icon } from "./base";

/** keep in sync with android/AndroidManifest.xml versionName on every release */
export const APP_VERSION = "1.0.1";

export type ClgKind = "add" | "imp" | "fix";
export interface ClgItem { kind: ClgKind; zh: string; en: string }
export interface ClgVersion { v: string; date: string; items: ClgItem[] }

const it = (kind: ClgKind, zh: string, en: string): ClgItem => ({ kind, zh, en });

export const CHANGELOG: ClgVersion[] = [
  {
    v: "1.0.1",
    date: "2025-09-07",
    items: [
      it("add", "图层×帧矩阵时间轴：多图层多帧动画编辑（增删/合并图层、增删帧、洋葱皮）", "Layer×frame matrix timeline: multi-layer, multi-frame animation (add/delete/merge layers, frames, onion skin)"),
      it("add", "操作历史记录与过程回放：从空白状态逐步重放整段绘画过程，可调速", "Operation history with playback: replays the whole drawing session from scratch, speed adjustable"),
      it("add", "浮动球停靠区：把暂时不用的浮动球拖到屏幕边缘停靠，滑动即可弹出", "Floating-ball dock: park unused orbs at the screen edge, swipe to pop them back out"),
      it("add", "FX 特效浮动球：一键描边 / 反色 / 灰度", "FX orb: one-tap outline / invert / grayscale effects"),
      it("add", "参考图导入预览框：可拖拽缩放，并能直接从参考图上点按/拖动吸色", "Reference image preview: draggable & resizable, pick colours straight off the picture"),
      it("add", "菜单新增“更新日志”，版本更新后首次打开应用自动展示", "New release-notes entry in the menu; opens automatically on first launch after an update"),
      it("add", "操作记录双模式：按设置步数记录最近操作，或“完整记录”模式自项目创建起保存全部操作、可从头完整回放", "Two history recording modes: step-limited (configurable) or full recording since the project started for complete replay"),
      it("fix", "修复选中颜色与绘制颜色不一致：残留的透明色会让新颜色画出来像橡皮擦（黑变白等）", "Fix picked colour ≠ drawn colour: stale transparency made new colours act like an eraser (black drew as white)"),
      it("fix", "色块按棋盘格真实显示透明度，透明槽位不再显示成黑色", "Swatches now show transparency honestly over a checkerboard instead of black"),
      it("fix", "修复添加/移动图层后帧内容错位（引擎回归测试覆盖）", "Fix cel content shifting after inserting/moving layers (covered by engine regression tests)"),
      it("imp", "选色一律不透明应用，半透明请用“不透明度”滑块；取色器支持吸取透明背景", "Colour picks apply fully opaque; use the opacity slider for translucency. Eyedropper can pick transparency"),
      it("imp", "界面动效：时间轴开关、长按进度条、快速色轮、菜单与色块控件加入过渡/入场动画", "UI motion: smooth open/close & entrance animations for the timeline panel, hold-drag sliders, quick colour wheel, menus and chips"),
      it("imp", "精简菜单：移除“操作说明”与“清空当前帧”入口，界面更简洁", "Menu cleanup: removed the Help (操作说明) and Clear-current-frame (清空当前帧) entries"),
    ],
  },
  {
    v: "1.0.0",
    date: "2025-09-06",
    items: [
      it("add", "首个发布版本：像素画布与全套绘画/选择工具（铅笔、橡皮、油漆桶、取色器、直线、矩形、椭圆、正圆、多边形、选区、魔棒、套索）", "Initial release: pixel canvas with full drawing/selection tools (pencil, eraser, bucket, eyedropper, line, rect, ellipse, circle, polygon, select, wand, lasso)"),
      it("add", "双指缩放平移画布、笔刷大小与不透明度调节", "Pinch zoom/pan, adjustable brush size and opacity"),
      it("add", "前景/背景双色槽、内置色板、色轮与快速取色", "FG/BG colour slots, built-in palettes, colour wheel and quick picker"),
      it("add", "图层与帧编辑、画布/精灵缩放、工程保存与打开、PNG/GIF 导入导出", "Layer & frame editing, canvas/sprite resize, project save/open, PNG/GIF import & export"),
    ],
  },
];

const langOf = (): Lang => (SESSION.prefs.lang as Lang) || "zh";

/** true on the first run after an update (or very first run) */
export function changelogNeedsShow(): boolean {
  try {
    const seen = localStorage.getItem("pc.changelog.seen");
    return seen !== APP_VERSION;
  } catch {
    return false;
  }
}

export function ChangelogModal({ onClose }: { onClose: () => void }) {
  const lang = langOf();
  const t = useMemo(() => makeT(lang), [lang]);
  const [vi, setVi] = useState(() => {
    const i = CHANGELOG.findIndex((v) => v.v === APP_VERSION);
    return i >= 0 ? i : 0;
  });
  // opening the log (auto or manual) marks the current version as seen
  useEffect(() => {
    try { localStorage.setItem("pc.changelog.seen", APP_VERSION); } catch { /* ignore */ }
  }, []);
  const ver = CHANGELOG[vi] ?? CHANGELOG[0];
  const secs: [ClgKind, string][] = [
    ["add", t("clgAdd")],
    ["imp", t("clgImp")],
    ["fix", t("clgFix")],
  ];
  return (
    <>
      <div className="dlg-mask" onClick={onClose} />
      <div className="dlg clg-dlg">
        <div className="dlg-head">
          <span>{t("changelog")}</span>
          <div className="grow" />
          <button className="btn small" onClick={onClose}><Icon id="i-x" size={16} /></button>
        </div>
        <div className="dlg-body">
          <div className="clg-vers">
            {CHANGELOG.map((v, i) => (
              <button key={v.v} className={"clg-v" + (i === vi ? " on" : "") + (v.v === APP_VERSION ? " cur" : "")} onClick={() => setVi(i)}>
                <span className="clg-vname">{v.v}</span>
                <span className="clg-vdate">{v.date}</span>
                {v.v === APP_VERSION && <span className="clg-curtag">{t("clgCurrent")}</span>}
              </button>
            ))}
          </div>
          <div className="clg-view" key={"v" + ver.v}>
          <div className="clg-title">PixelCraft {ver.v} <span className="clg-date">· {ver.date}</span></div>
          <div className="clg-list">
            {secs.map(([kind, label]) => {
              const rows = ver.items.filter((x) => x.kind === kind);
              if (!rows.length) return null;
              return (
                <div className="clg-sec" key={kind}>
                  <div className={"clg-sec-h " + kind}><i /><b>{label}</b></div>
                  <ul className="clg-ul">
                    {rows.map((x, i) => <li key={i}>{langOf() === "zh" ? x.zh : x.en}</li>)}
                  </ul>
                </div>
              );
            })}
          </div>
          </div>
        </div>
      </div>
    </>
  );
}
