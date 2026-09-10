// UI-kit demo page (dev only, not part of the app bundle).
//
//   sh scripts/build-ui-demo.sh && node toolchain/devserver.js
//   → http://127.0.0.1:8090/ui-demo.html
//
// Every kit component in every variant on one screen, plus a token swatch and a
// dark/light switch. It imports nothing but the kit barrel, which doubles as the
// purity check from docs/UI.md §1.1 exercised at runtime.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Btn, Icon, Dialog, Row, RowActions, ChipGroup, Segmented, Switch,
  NumberField, ColorField, ScrubNum,
} from "./index";

const THEME_TOKENS = [
  "--bg", "--bg2", "--bg3", "--bg4", "--ws-bg", "--line", "--line-2",
  "--text", "--dim", "--text-2", "--text-3", "--text-4", "--dim-2", "--dim-3", "--dim-4",
  "--disabled", "--input-bg", "--input-line", "--input-text",
  "--surface-card", "--surface-pop", "--surface-toast", "--surface-anchor", "--surface-anchor-on",
  "--anchor-dot", "--accent", "--accent-2", "--accent-3", "--accent-4", "--accent-soft",
  "--accent-faint", "--accent-glow", "--on-accent", "--danger", "--danger-1", "--danger-2",
  "--link", "--mask", "--set-item-bg", "--set-item-line", "--set-group-bg", "--set-head-bg",
  "--ctl-bg-soft", "--ctl-line-soft",
];
const FIXED_TOKENS = [
  "--surface-orb", "--surface-orb-on", "--surface-item", "--surface-item-active", "--line-3",
  "--hud-bg", "--hud-bg-2", "--hud-tip", "--hud-deep", "--dock-bg", "--dock-bg-open",
  "--sym", "--sym-text", "--ok", "--info", "--warn", "--danger-line", "--grip",
];

function Sec({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <section className="demo-sec">
      <div className="demo-h">{title}</div>
      {children}
    </section>
  );
}

function Swatches({ tokens }: { tokens: string[] }) {
  return (
    <div className="chips">
      {tokens.map((tk) => (
        <span key={tk} className="chip" title={tk} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <i style={{ width: 14, height: 14, borderRadius: 4, background: `var(${tk})`, border: "1px solid var(--line)", display: "inline-block" }} />
          {tk}
        </span>
      ))}
    </div>
  );
}

export function Demo() {
  const [light, setLight] = useState(false);
  const [kind, setKind] = useState<"canvas" | "sprite">("canvas");
  const [tab, setTab] = useState<"png" | "gif">("png");
  const [on, setOn] = useState(true);
  const [w, setW] = useState("64");
  const [col, setCol] = useState("#5aa2f0");
  const [dlg, setDlg] = useState(false);
  const [scoped, setScoped] = useState<"frame" | "layer" | "sel">("frame");
  const toggleTheme = () => {
    const root = document.documentElement;
    if (light) root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", "light");
    setLight(!light);
  };
  return (
    <div className="app-root" style={{ height: "auto" }}>
      <div className="topbar">
        <span className="title">PixelCraft UI Kit</span>
        <div className="grow" />
        <Btn label={light ? "深色主题" : "浅色主题"} icon="i-eye" onClick={toggleTheme} />
        <Btn label="打开弹窗" icon="i-layers" className="primary" onClick={() => setDlg(true)} />
      </div>

      <Sec title="Btn — 变体与状态">
        <div className="demo-row">
          <Btn label="默认" onClick={() => { /* demo */ }} />
          <Btn label="激活" active onClick={() => { /* demo */ }} />
          <Btn label="主要" className="primary" onClick={() => { /* demo */ }} />
          <Btn label="危险" danger onClick={() => { /* demo */ }} />
          <Btn label="禁用" className="off" onClick={() => { /* demo */ }} />
          <Btn icon="i-pencil" onClick={() => { /* demo */ }} />
          <Btn icon="i-check" label="带图标" onClick={() => { /* demo */ }} />
          <Btn icon="i-x" className="small" onClick={() => { /* demo */ }} />
          <Btn icon="i-x" className="mini" onClick={() => { /* demo */ }} />
          <Btn label="长按看提示" title="提示标题" desc="长按 0.45 秒出现的说明文字" onClick={() => { /* demo */ }} />
        </div>
      </Sec>

      <Sec title="Icon — 图标精灵">
        <div className="demo-row">
          {["i-pencil", "i-eraser", "i-bucket", "i-picker", "i-line", "i-rect", "i-select", "i-grid", "i-eye", "i-layers", "i-lock", "i-star"].map((id) => (
            <span key={id} className="btn rail" title={id}><Icon id={id} /></span>
          ))}
        </div>
      </Sec>

      <Sec title="ChipGroup / Segmented">
        <ChipGroup value={kind} onChange={setKind} options={[
          { id: "canvas", label: "画布尺寸" },
          { id: "sprite", label: " sprite 尺寸" },
        ]} />
        <ChipGroup value={scoped} onChange={setScoped} options={[
          { id: "frame", label: "整帧" },
          { id: "layer", label: "当前图层" },
          { id: "sel", label: "选区（隐藏示例）", hidden: true },
        ]} />
        <Segmented value={tab} onChange={setTab} options={[
          { id: "png", label: "PNG" },
          { id: "gif", label: "GIF" },
        ]} />
      </Sec>

      <Sec title="Row / RowActions / Switch">
        <Row label="布尔设置（Switch）">
          <Switch checked={on} label="示例开关" onChange={setOn} />
        </Row>
        <Row label="含说明的行" hint="hint 就是 .row-note，位于控件下方">
          <Switch checked={on} label="带说明的开关" onChange={setOn} />
        </Row>
        <RowActions>
          <Btn label="行内按钮" onClick={() => { /* demo */ }} />
          <Btn label="另一个" onClick={() => { /* demo */ }} />
        </RowActions>
      </Sec>

      <Sec title="NumberField / ScrubNum / ColorField">
        <NumberField label="宽度（支持算式，长按可拖动）" value={w} onChange={setW} min={1} max={1024} />
        <Row label="裸 ScrubNum">
          <ScrubNum value={w} onChange={setW} min={0} max={100} />
        </Row>
        <ColorField label="颜色" value={col} onChange={setCol} />
      </Sec>

      <Sec title="令牌色板（主题令牌）">
        <Swatches tokens={THEME_TOKENS} />
      </Sec>
      <Sec title="令牌色板（固定令牌：画布 HUD / 状态色，两主题同值）">
        <Swatches tokens={FIXED_TOKENS} />
      </Sec>

      <Sec title="Dialog">
        <div className="demo-row">
          <Btn label="打开示例弹窗" className="primary" onClick={() => setDlg(true)} />
          <span className="note">遮罩点击 / × / Esc 均可关闭</span>
        </div>
        {dlg && (
          <Dialog
            title="示例弹窗"
            onClose={() => setDlg(false)}
            bodyClass="col"
            top={<div className="row-note">top 槽位：位于头部与正文之间（如历史模式说明）</div>}
            extra={<div className="row-note">extra 槽位：位于正文与页脚之间（如回放按钮行）</div>}
            footer={<><Btn label="取消" onClick={() => setDlg(false)} /><Btn label="确定" className="primary" onClick={() => setDlg(false)} /></>}
          >
            <Row label="弹窗内的表单行">
              <NumberField label="列数" value={w} onChange={setW} min={1} max={32} />
            </Row>
            <ChipGroup value={kind} onChange={setKind} options={[
              { id: "canvas", label: "画布尺寸" },
              { id: "sprite", label: "sprite 尺寸" },
            ]} />
          </Dialog>
        )}
      </Sec>
    </div>
  );
}

// mount only in the browser: tests render <Demo/> to a string instead (no DOM)
const host = typeof document === "undefined" ? null : document.getElementById("root");
if (host) createRoot(host).render(<Demo />);
