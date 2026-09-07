// Release notes (更新日志): data + modal. Auto-shown on first launch after an
// update (version marker in localStorage); also reachable from the main menu.
import React, { useEffect, useMemo, useState } from "react";
import { SESSION } from "./singleton";
import { makeT } from "./i18n";
import type { Lang } from "./i18n";
import { Icon } from "./base";

/** keep in sync with android/AndroidManifest.xml versionName on every release */
export const APP_VERSION = "1.0.2";

export type ClgKind = "add" | "imp" | "fix";
export interface ClgItem { kind: ClgKind; zh: string; en: string }
export interface ClgVersion { v: string; date: string; items: ClgItem[] }

const it = (kind: ClgKind, zh: string, en: string): ClgItem => ({ kind, zh, en });

export const CHANGELOG: ClgVersion[] = [
  {
    v: "1.0.2",
    date: "2025-09-07",
    items: [
      it("add", "操作记录双模式：按步数记录最近操作，或“完整记录”模式自项目创建起保存全部操作、可从头完整回放", "Two history recording modes: step-limited (configurable) or full recording since the project started for complete replay"),
      it("add", "魔法球（原特效球）：居中、智能裁剪画布空白、一键投影/外发光、等距网格辅助、全套 SVG 图标", "Magic Ball (was FX orb): centre content, smart-crop empty borders, one-tap drop shadow / outer glow, isometric grid helper, full SVG action icons"),
      it("add", "铅笔与橡皮改用 Aseprite 圆形笔刷算法（尺寸＝直径，奇偶尺寸逐像素一致）", "Pencil & eraser now use Aseprite’s circular brush algorithm (size = diameter, pixel-identical for odd/even sizes)"),
      it("add", "图形绘制后自动进入精确像素选区并可立刻拖动；选区移动/旋转/缩放按 Aseprite 浮动方式，不带走底下像素", "Shapes auto-select their exact pixels and can be dragged immediately; move/rotate/scale uses Aseprite-style floating content that never carries underlying artwork"),
      it("add", "图层重命名改为独立弹窗；图层透明度量程恢复为长按手势条并修复弹层越界", "Layer rename via its own dialog; layer-opacity hold slider restored with popups clamped on-screen"),
      it("add", "数字输入框支持长按上下/左右滑动微调（步长按值域自适应）；全部输入框统一深色主题", "Numeric fields support long-press slide scrubbing (auto step from value range); all inputs now match the dark theme"),
      it("add", "菜单重组：导入（图片/图层/精灵表/参考图/色板）与导出（图片/图层/色板）二级菜单；时间线默认隐藏", "Menu regrouped: Import and Export open second-level menus (image/layer/sheet/reference/palette); timeline starts hidden"),
      it("add", "混合模式改为弹窗选择（屏幕居中、可滚动、横屏适配）；导出新增“图层导出”模式", "Blend modes open a centred scrollable dialog (landscape-aware); new Layers export mode exports one image per layer"),
      it("imp", "长按进度条按钮双击快速归位默认值；快速色轮长按时不再因离开色块而消失；按钮文字实时跟随", "Double-tap hold-sliders to snap back to defaults; quick colour wheel stays open when the finger leaves the chip; live label updates"),
      it("fix", "浮动球收纳需拖入面板区域才生效、离开区域保持聚焦、拿出落在手指位置、横屏固定宽度", "Dock fixes: parking only inside the panel, focus kept outside, eject at the finger drop point, fixed landscape width"),
      it("fix", "橡皮擦/铅笔足迹指示与实际涂抹区域精确对齐并随手指移动", "Brush footprint marker aligns exactly with the painted/erased area and follows the finger"),
    ],
  },
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
