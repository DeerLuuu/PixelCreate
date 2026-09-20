// Component contract tests for the UI kit (docs/UI.md §5).
//
// The kit implementation moved into the deer-ui library (docs/PLAN-deer-ui.md P0b);
// src/ui/kit/* are thin re-exports of it. The import paths above are unchanged, so the
// rendered assertions below now exercise **the installed library**, and the blocks that
// used to read an app-side copy now read the installed dist instead — same claim, but
// about the artifact the app really bundles (no second implementation can hide there).
//
// The container has no jsdom, so instead of mounting into a DOM the kit is
// rendered with react-dom/server and asserted on its markup. Every claim here
// is one the styles, the guide anchors or an existing call site depends on:
// class names, aria attributes and the head → top → body → extra → foot order.
import { renderToStaticMarkup } from "react-dom/server";
import { eq, ok } from "./common";
import { readLibCss } from "./css-rules";
import { Dialog } from "../src/ui/kit/Dialog";
import { Row, RowActions, ChipGroup, Segmented, Switch, NumberField, ColorField } from "../src/ui/kit/Form";
import { Icon, Btn } from "../src/ui/kit/primitives";
import { Demo } from "../src/ui/kit/demo";
import { HoverTip, hoverTipPos, setHoverTipsEnabled } from "../src/ui/kit/HoverTip";

declare const require: (m: string) => any;
declare const __dirname: string;
const fs = require("fs");
const path = require("path");

const html = (el: unknown): string => renderToStaticMarkup(el as never);

// node_modules/deer-ui/dist — same depth as the old "../../../src/ui/kit" below.
const KIT_DIST = path.resolve(__dirname, "../../../node_modules/deer-ui/dist");
const kitSrc = (rel: string): string => fs.readFileSync(path.join(KIT_DIST, rel), "utf8");

export function testUiKit(): void {
  // ---------------------------------------------------------------- Dialog
  const d = html(
    <Dialog
      title="设置"
      onClose={() => { /* noop */ }}
      className="fxdlg"
      bodyClass="col"
      guide="dlg-settings"
      top={<div className="top-probe" />}
      extra={<div className="extra-probe" />}
      footer={<button type="button">ok</button>}
    >
      <span id="body-probe" />
    </Dialog>
  );
  ok("ui.dialog.mask", d.indexOf('class="dlg-mask"') >= 0);
  ok("ui.dialog.role", d.indexOf('role="dialog"') >= 0 && d.indexOf('aria-modal="true"') >= 0);
  ok("ui.dialog.aria-label", d.indexOf('aria-label="设置"') >= 0);
  ok("ui.dialog.classes", d.indexOf('class="dlg fxdlg"') >= 0);
  ok("ui.dialog.body-class", d.indexOf('class="dlg-body col"') >= 0);
  ok("ui.dialog.guide", d.indexOf('data-guide="dlg-settings"') >= 0);
  ok("ui.dialog.head-span", d.indexOf("<span>设置</span>") >= 0 && d.indexOf('class="grow"') >= 0);
  ok("ui.dialog.close", d.indexOf('aria-label="close"') >= 0 && d.indexOf("#i-x") >= 0);
  ok("ui.dialog.foot", d.indexOf('class="dlg-foot"') >= 0);
  {
    const ih = d.indexOf("top-probe");
    const ib = d.indexOf("body-probe");
    const ie = d.indexOf("extra-probe");
    const ifo = d.indexOf("dlg-foot");
    ok("ui.dialog.order", ih > 0 && ih < ib && ib < ie && ie < ifo, [ih, ib, ie, ifo].join(","));
  }

  const noClose = html(<Dialog title="确认" closeBtn={false} onClose={() => { /* noop */ }} />);
  eq("ui.dialog.no-close", noClose.indexOf("i-x") >= 0, false);
  eq("ui.dialog.no-footer", html(<Dialog title="菜单" onClose={() => { /* noop */ }} />).indexOf("dlg-foot") >= 0, false);
  // a dialog without onClose must not render an × either
  eq("ui.dialog.headerless-close", html(<Dialog title="x" />).indexOf("i-x") >= 0, false);

  // ------------------------------------------------------------------- Row
  const row = html(<Row label="宽度" hint="提示"><input /></Row>);
  ok("ui.row.label", row.indexOf('class="rowlabel"') >= 0 && row.indexOf("宽度") >= 0);
  ok("ui.row.hint", row.indexOf('class="row-note"') >= 0 && row.indexOf("提示") >= 0);
  ok("ui.row.order", row.indexOf("rowlabel") < row.indexOf("<input") && row.indexOf("<input") < row.indexOf("row-note"));
  eq("ui.row.no-label", html(<Row><span /></Row>).indexOf("rowlabel") >= 0, false);
  eq("ui.row.className", html(<Row label="a" className="x" />).indexOf('class="rowlabel x"') >= 0, true);

  const ra = html(<RowActions className="set-io"><button type="button">b</button></RowActions>);
  ok("ui.rowactions", ra.indexOf('class="row-actions set-io"') >= 0);

  // -------------------------------------------------------------- ChipGroup
  // NOTE: const narrowing would collapse the union, so cast at the call site
  const chips = html(
    <ChipGroup
      value={"b" as "a" | "b" | "c"}
      onChange={() => { /* noop */ }}
      options={[{ id: "a", label: "A" }, { id: "b", label: "B", guide: "btn-b" }, { id: "c", label: "C", hidden: true }]}
    />
  );
  ok("ui.chips.wrapper", chips.indexOf('class="chips"') >= 0);
  ok("ui.chips.on", chips.indexOf('class="chip on"') >= 0);
  eq("ui.chips.off-count", (chips.match(/class="chip"/g) || []).length, 1);
  eq("ui.chips.hidden", chips.indexOf(">C<") >= 0, false);
  ok("ui.chips.guide", chips.indexOf('data-guide="btn-b"') >= 0);

  const seg = html(
    <Segmented
      value={"png" as "png" | "gif"}
      onChange={() => { /* noop */ }}
      options={[{ id: "png", label: "PNG" }, { id: "gif", label: "GIF" }]}
    />
  );
  ok("ui.segmented", seg.indexOf('class="tabs"') >= 0 && seg.indexOf('class="tab on"') >= 0 && seg.indexOf('class="tab"') >= 0);
  ok("ui.segmented.labels", seg.indexOf("PNG") >= 0 && seg.indexOf("GIF") >= 0);

  // ----------------------------------------------------------------- Switch
  const on = html(<Switch checked label="开关" onChange={() => { /* noop */ }} />);
  ok("ui.switch.on", on.indexOf('role="switch"') >= 0 && on.indexOf('aria-checked="true"') >= 0 && on.indexOf('class="sw on"') >= 0);
  const off = html(<Switch checked={false} label="开关" onChange={() => { /* noop */ }} />);
  ok("ui.switch.off", off.indexOf('aria-checked="false"') >= 0 && off.indexOf('class="sw"') >= 0);
  ok("ui.switch.label", off.indexOf('aria-label="开关"') >= 0);

  // ---------------------------------------------------- NumberField / Color
  const nf = html(<NumberField label="列" value={4} onChange={() => { /* noop */ }} min={1} max={8} />);
  ok("ui.numberfield", nf.indexOf("rowlabel") >= 0 && nf.toLowerCase().indexOf('inputmode="decimal"') >= 0 && nf.indexOf('value="4"') >= 0);
  const cf = html(<ColorField label="底色" value="#112233" onChange={() => { /* noop */ }} />);
  ok("ui.colorfield", cf.indexOf('type="color"') >= 0 && cf.indexOf('class="set-hex"') >= 0 && cf.indexOf("#112233") >= 0);
  ok("ui.colorfield.row", cf.indexOf("rowlabel") >= 0);

  // ------------------------------------------------------------ primitives
  const btn = html(<Btn label="保存" onClick={() => { /* noop */ }} active danger guide="btn-save" />);
  ok("ui.btn", btn.indexOf('class="btn active danger"') >= 0 && btn.indexOf('aria-label="保存"') >= 0 && btn.indexOf('data-guide="btn-save"') >= 0);
  ok("ui.icon", html(<Icon id="i-x" size={16} />).indexOf('width="16"') >= 0);

  // ------------------------------------------------------------ HoverTip
  // the panel is positioned by a pure helper: to the lower-right of the cursor,
  // flipped when it would leave the viewport, always clamped inside it
  eq("ui.htip.pos.default", hoverTipPos(100, 100, 200, 60, 1000, 800), { x: 114, y: 114 });
  {
    // near the right edge -> flips to the left of the pointer
    const p1 = hoverTipPos(980, 100, 200, 60, 1000, 800);
    ok("ui.htip.pos.flip-x", p1.x < 980, "x=" + p1.x);
    // near the bottom edge -> flips above the pointer
    const p2 = hoverTipPos(100, 780, 200, 60, 1000, 800);
    ok("ui.htip.pos.flip-y", p2.y < 780, "y=" + p2.y);
    // a pointer in the corner still yields an on-screen panel
    const p3 = hoverTipPos(999, 799, 200, 60, 1000, 800);
    ok("ui.htip.pos.inside", p3.x >= 0 && p3.y >= 0 && p3.x + 200 <= 1000 && p3.y + 60 <= 800, JSON.stringify(p3));
    // a panel wider than the viewport is pinned to the edge, never negative
    const p4 = hoverTipPos(10, 10, 2000, 60, 1000, 800);
    ok("ui.htip.pos.oversize", p4.x >= 0 && p4.y >= 0, JSON.stringify(p4));
  }
  const htip = html(<HoverTip title="画笔" desc="按住拖动可调大小" x={40} y={40} />);
  ok("ui.htip.markup", htip.indexOf('class="htip"') >= 0 && htip.indexOf('role="tooltip"') >= 0);
  ok("ui.htip.title", htip.indexOf("htip-title") >= 0 && htip.indexOf("画笔") >= 0);
  ok("ui.htip.desc", htip.indexOf("htip-desc") >= 0 && htip.indexOf("按住拖动可调大小") >= 0);
  eq("ui.htip.no-desc", html(<HoverTip title="只有标题" x={10} y={10} />).indexOf("htip-desc") >= 0, false);
  // the kit exposes the on/off switch the app pushes PC mode into
  setHoverTipsEnabled(true);
  const { hoverTipsEnabled } = require("../src/ui/kit/HoverTip") as { hoverTipsEnabled: () => boolean };
  eq("ui.htip.enabled-flag", hoverTipsEnabled(), true);
  setHoverTipsEnabled(false);
  eq("ui.htip.disabled-flag", hoverTipsEnabled(), false);
  // Btn must be wired to it (the hover tip is the desktop substitute for the
  // long-press tip, so it has to live inside Btn and not at the call sites)
  {
    const prim = kitSrc("kit/primitives.js");
    ok("ui.htip.btn-wired", prim.indexOf("useHoverTip") >= 0 && prim.indexOf("hover.node") >= 0);
    ok("ui.htip.mouse-not-longpress", prim.indexOf('e.pointerType === "mouse"') >= 0);
  }
  // 手机竖屏的面板整屏铺开（由 App 决定 full，kit 只负责加类名）
  {
    const prim = kitSrc("kit/primitives.js");
    ok("ui.overlay-full", /full = false/.test(prim) && prim.includes('full ? " panel-full" : ""'));
    const app = fs.readFileSync(path.resolve(__dirname, "../../../src/ui/App.tsx"), "utf8");
    ok("ui.overlay-full-wiring", app.includes("<Overlay full={!land && !pcMode}"));
  }
  // 下拉列表必须 portal 出去：时间轴控制条是 `overflow-x:auto` 的滚动容器，
  // 绝对定位的列表会被它整块裁掉 —— 播放速度色片「点了没反应」就是这么来的
  {
    const tabs = kitSrc("tabs.js");
    ok("ui.dropmenu.portal", tabs.includes("createPortal") && tabs.includes("document.body"));
    ok("ui.dropmenu.fixed-pos", tabs.includes("dropmenu-pop") && tabs.includes("getBoundingClientRect"));
    const css = readLibCss();
    ok("ui.dropmenu.pop-css", /\.dropmenu-list\.dropmenu-pop\{[^}]*position:fixed/.test(css),
      "读库段（P2 之后 .dropmenu-* 是库的规则：唯一来源 deer-ui/styles.css，应用侧的副本已删）");
  }

  // ------------------------------------------------------------- demo page
  // the demo exercises every component at once; rendering it here also proves
  // it never touches the DOM at import time (it mounts only in a browser)
  const demo = html(<Demo />);
  for (const probe of ["PixelCraft UI Kit", "ChipGroup", "NumberField", "令牌色板", "Dialog"]) {
    ok("ui.demo." + probe, demo.indexOf(probe) >= 0);
  }
  ok("ui.demo.sections", (demo.match(/demo-h/g) || []).length >= 6);

  // --------------------------------------------------------- kit purity
  // docs/UI.md §1.1：库内只许 import react / react-dom 及其子路径 + **库内**相对路径。
  // 迁移后主体换成**装进来的库产物**（dist 里 ESM 的 import 说明符原样保留），白名单从 8 项
  // 收紧到「react/react-dom + 相对路径」——而且相对路径必须**解析到包内已存在的文件**，
  // 所以 `../../engine/expr` 这种越出包边界的写法会红（这正是 P0b 要证的那条：
  // 越界的东西现在根本装不进来）。
  const distFiles: string[] = [];
  {
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.js$/.test(e.name)) distFiles.push(p);
      }
    };
    walk(KIT_DIST);
  }
  ok("ui.kit.sources", distFiles.length >= 5, "dist files=" + distFiles.length);
  const banned = /from\s+["'](\.\.\/(singleton|i18n|app|io|render|tools)|\.\/singleton)/;
  const offenders: string[] = [];
  const bareOk = (mod: string): boolean =>
    mod === "react" || mod.indexOf("react/") === 0
    || mod === "react-dom" || mod.indexOf("react-dom/") === 0;
  // 相对 import 必须落在包内、且目标文件真的存在（dist 是编译产物，无扩展名相对路径）
  const insidePackage = (fromFile: string, mod: string): boolean => {
    const base = path.resolve(path.dirname(fromFile), mod);
    const hit = [base, base + ".js", path.join(base, "index.js")]
      .find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
    if (!hit) return false;
    const rel = path.relative(KIT_DIST, hit);
    return rel.length > 0 && rel.indexOf("..") !== 0 && !path.isAbsolute(rel);
  };
  for (const f of distFiles) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/from\s+["']([^"']+)["']/g)) {
      const mod = m[1];
      const isRel = mod.indexOf("./") === 0 || mod.indexOf("../") === 0;
      const bad = isRel ? !insidePackage(f, mod) : !bareOk(mod);
      if (bad || banned.test('from "' + mod + '"')) {
        offenders.push(path.relative(KIT_DIST, f).replace(/\\/g, "/") + " -> " + mod);
      }
    }
  }
  eq("ui.kit.purity", offenders, []);

  // the barrel is what the demo page and, later, an external consumer import
  const barrel = kitSrc("kit/index.js");
  for (const sym of ["Dialog", "Row", "ChipGroup", "Segmented", "Switch", "NumberField", "ColorField", "Btn", "Icon", "ScrubNum"]) {
    ok("ui.kit.export." + sym, new RegExp("\\b" + sym + "\\b").test(barrel));
  }
}
