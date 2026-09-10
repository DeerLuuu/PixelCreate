# PixelCraft UI 规范（设计令牌 + 控件库 + 迁移约定）

> 本文是 `src/ui/` 的**唯一 UI 规范来源**。新增/修改界面时必须先读本文；代码与本文冲突时，以本文为准并同步修正代码。
> 配套文档：[`AGENTS.md`](../AGENTS.md)（工程约定）、[`docs/API.md`](API.md)（模块接口）。
> 适用范围：`src/ui/**`、`src/ui/style.css`、`tests/ui-*.test.tsx`。

---

## 0. 本次实施计划（本文件的由来）

按「计划 → 规范 → 实现」三步推进，对应 5 个改造项（编号沿用 UI 系统盘点结论）：

| 项 | 内容 | 交付物 | 提交 |
|---|---|---|---|
| 3 | 设计令牌 + 浅色主题 | `style.css` 令牌层、`src/io/theme.ts`、`ui.theme` 设置项 | `feat(ui): 设计令牌层与浅色主题` |
| 1 | 弹窗壳子组件化 | `src/ui/kit/Dialog.tsx`，替换 18 处手写 `.dlg-*` | `feat(ui): Dialog 组件化` |
| 2 | 表单/选项控件 | `src/ui/kit/Form.tsx`（Row/ChipGroup/Segmented/Switch/NumberField/ColorField） | 同上 |
| 7 | 组件测试 | `tests/ui-kit.test.tsx`、`tests/ui-tokens.test.ts` | `test(ui): 组件与令牌规范测试` |
| 8 | 演示页与文档 | `src/ui/kit/demo.tsx`、`scripts/build-ui-demo.sh`、本文 | `docs(ui): 演示页与规范收尾` |

**验收口径**（每项完成都要满足）：
1. `tsc -p tsconfig.json --noEmit` 0 错误；
2. `tests/run-tests.ts` 全绿（含既有 1053 条断言，不得减少）；
3. `tests/guide-anchors.test.ts` 通过（改造不得丢 `data-guide` 锚点）；
4. 视觉效果：默认暗色主题下与改造前**逐像素等价**（除本文 §3.6 列出的「合并色」微差）；
5. 新增/改动样式一律使用令牌，不写裸色值。

---

## 1. 目录与依赖边界

```
src/ui/
  kit/                   ← 控件库（目标：可整体搬走）
    primitives.tsx       Icon / Btn / Keep / Overlay / TipHost / useBlankTap / useLandscape
    scrub.tsx            ScrubNum（数字输入 + 拖动 + 算式键盘）
    Dialog.tsx           Dialog（遮罩 + 头 + 体 + 脚）
    Form.tsx             Row / RowActions / ChipGroup / Segmented / Switch / NumberField / ColorField
    index.ts             统一出口（演示页与外部只从 barrel 引入）
    demo.tsx             演示页入口（不进主包）
  base.tsx               useSession + ScrubNum 的 i18n 包装 + 对 kit/primitives 的再导出（兼容层）
  hold.tsx  tabs.tsx     长按调节 / 标签条 + 下拉（后续迁移，暂留原处）
  modals.tsx  App.tsx    应用弹窗与外壳（使用 kit）
  i18n.ts  singleton.ts  guide*.tsx  ...
  style.css             唯一样式表，分区见 §3.1
```

### 1.1 kit 纯度规则（测试强制）

`src/ui/kit/**` 只允许 import：

- `react`、`react-dom`；
- `../engine/expr`（纯函数，算式求值）；
- 其它 kit 模块。

**禁止**：`singleton`（Session）、`i18n`、`../app/*`、`../io/*`、`../render/*`、`../tools/*`。
文案一律通过 props 传入；需要 i18n 的调用方在应用层包装（示例：`base.tsx` 的 `ScrubNum` 包装器注入 `padTitle`）。

### 1.2 兼容层

`base.tsx` 继续导出 `Icon / Btn / Keep / Overlay / TipHost / useBlankTap / useLandscape / ScrubNum`，
实现改为「再导出 kit 实现」或「薄包装」。**已有 97 处 `Btn`、18 处 `Icon` 等调用点不需要改 import。**

---

## 2. 组件规范

所有组件的 DOM 契约（class 名）**不得随意改动**：样式表、引导锚点、既有测试都依赖它。

### 2.1 Dialog

```tsx
import { Dialog } from "../kit";

<Dialog
  title={t("settings")}          // 头部标题
  onClose={onClose}              // 遮罩点击 / × / Esc
  className="fxdlg"              // 追加到 .dlg
  bodyClass="col"                // 追加到 .dlg-body
  bodyStyle={{ touchAction: "pan-y" }}
  guide="dlg-settings"           // 引导锚点 → data-guide
  closeBtn                       // 默认 true；提示类弹窗传 false
  maskClose                      // 默认 true
  escClose                       // 默认 true
  closeLabel="关闭"              // × 的 aria-label（默认 "close"）
  footer={<><Btn label={t("cancel")} …/><Btn label={t("ok")} className="primary" …/></>}
>
  {内容}
</Dialog>
```

渲染结构（与手写版完全一致，仅新增 aria 属性）：

```html
<div class="dlg-mask" aria-hidden="true"></div>
<div class="dlg [className]" role="dialog" aria-modal="true" aria-label="…" data-guide="…">
  <div class="dlg-head"><span>标题</span><div class="grow"></div>
    <button class="btn small" aria-label="…"><svg …/></button></div>
  <div class="dlg-body [bodyClass]">…</div>
  <div class="dlg-foot">…</div>          <!-- footer 为空时不渲染 -->
</div>
```

约定：
- `Dialog` **只渲染 fragment**，不负责挂载/卸载；进出场动画由调用方套 `<Keep on={…} el={<Dialog …/>} />`（`.keep.out .dlg` 已定义退出动画）。
- 需要更高层级（确认框）时，外层自己加 `.cfm-layer`。
- 标题为纯字符串时自动作为 `aria-label`；否则传 `label`。

### 2.2 Row / RowActions

```tsx
<Row label={t("docs.w")} hint={t("sizeNote")}>
  <ScrubNum … />
</Row>
<RowActions><Btn label={t("setExport")} … /></RowActions>
```

- `Row` 输出 `<label class="rowlabel">{label}</label>` + 子节点 + 可选 `<div class="row-note">{hint}</div>`。
- `Row` 是**布局容器**，不绑定控件、不生成 `for` 属性（与既有视觉一致）。
- 没有 `label` 时只渲染子节点；`className` 追加到 `rowlabel`。

### 2.3 ChipGroup

```tsx
<ChipGroup value={mode} options={[
  { id: "canvas", label: t("canvasSize") },
  { id: "sprite", label: t("spriteSize") },
]} onChange={switchMode} />
```

- 结构：`<div class="chips"><button class="chip[ on]">…</button>…</div>`。
- `options` 支持 `guide`（→ `data-guide`）；条件项由调用方 `filter` 后再传。
- `className` 追加到 `.chips`。

### 2.4 Segmented

```tsx
<Segmented value={tab} options={[{ id: "png", label: "PNG" }, …]} onChange={setTab} />
```

- 结构：`<div class="tabs"><button class="tab[ on]">…</button>…</div>`。
- 与 `ChipGroup` 的区别：`.tabs` 是等宽分段（弹窗内切换视图），`.chips` 是可选标签（多值/开关）。

### 2.5 Switch

```tsx
<Switch checked={v} onChange={(on) => SESSION.setSetting("…", on)} label={t("…")} />
```

- 结构：`<button class="sw[ on]" role="switch" aria-checked="…" aria-label="…"><i /></button>`。
- 用于布尔设置项（替代旧 `ON/OFF` 胶囊）；`.sw` 尺寸 42×24，右侧对齐。
- 旧 `chip` 形态的布尔开关视为废弃写法。

### 2.6 NumberField / ColorField

```tsx
<NumberField label={t("columns")} value={cols} onChange={setCols} min={1} max={rTo - rFrom + 1} />
<ColorField label={t("bgCustom")} value={hex} onChange={setHex} />
```

- `NumberField` = `Row` + `ScrubNum`（保留算式输入、长按拖动）；额外支持 `hint`、`placeholder`、`expr`。
- `ColorField` = `Row` + `<input type="color">` + 十六进制文本。
- 需要自定义布局时仍可直接用 `ScrubNum`（`base.tsx` 导出）。

### 2.7 基础件（沿用既有契约）

| 组件 | class | 变体 |
|---|---|---|
| `Icon` | `<svg><use href="#i-…">` | `size` |
| `Btn` | `.btn` | `active` / `danger` / `primary` / `off` / `rail` / `small` / `mini` |
| `Keep` | `.keep[.out]` | 延迟卸载 |
| `Overlay` | `.panel-mask` + `.panel` | 右侧面板 |
| `TipHost` | `.tip-host` | 全局长按提示 |
| `ScrubNum` | `input` + `.calcpad` | 拖动 / 算式 |
| `TabBar` / `DropMenu` | `.tabbar*` / `.dropmenu*` | 见 `tabs.tsx` |

### 2.8 可访问性底线（本次范围内）

- 弹窗：`role="dialog"` + `aria-modal` + `aria-label`，Esc 关闭。
- `Switch`：`role="switch"` + `aria-checked`。
- 所有纯图标按钮必须有 `aria-label`（`Btn` 已自动用 `label`/`title`）。
- 不引入焦点陷阱与键盘导航（属后续项，见 §7）。

---

## 3. 设计令牌

### 3.1 style.css 分区

```
/* ===== 1/5 tokens ===== */   :root 尺寸令牌 + 主题色令牌 + 固定色令牌；[data-theme="light"] 覆盖
/* ===== 2/5 base ===== */     重置、html/body、通用 input
/* ===== 3/5 kit ===== */      .btn .dlg .rowlabel .chip .tabs .sw .dropmenu .tabbar .panel …
/* ===== 4/5 shell ===== */    .app-root .topbar .ctrlbar .tline .set-* .clg-* …
/* ===== 5/5 canvas hud ===== */ .orb .cv-title .prevbox .bdock .sym-chiprow .guide-* + 动画
```

`style.css` 是**唯一**样式表（构建脚本直接拷贝，无 CSS 打包）：新增控件样式写进对应分区，不要新建 css 文件。

### 3.2 命名规则

| 前缀 | 含义 | 示例 |
|---|---|---|
| `--sp-*` | 间距（2/4/6/8/12/16/20/24） | `--sp-4:8px` |
| `--r-*` | 圆角（6/8/9/10/12/16/pill/round） | `--r-4:10px` |
| `--fs-*` | 字号（10/11/12/13/14/16） | `--fs-4:13px` |
| `--sh-*` | 阴影（固定令牌） | `--sh-4` 弹窗 |
| `--z-*` | 层级 | `--z-dlg:50` |
| 语义色 | 角色命名，不带数字含义 | `--bg3`、`--text-2`、`--accent-soft` |

**取值规则**：新样式只能取令牌；存量规则里无法归一到令牌的历史值（5/7/9/13px 等）允许保留，但**改动该规则时必须就近归一**。

### 3.3 尺寸令牌（两主题同值）

| 令牌 | 值 | 令牌 | 值 |
|---|---|---|---|
| `--sp-1` | 2px | `--r-1` | 6px |
| `--sp-2` | 4px | `--r-2` | 8px |
| `--sp-3` | 6px | `--r-3` | 9px |
| `--sp-4` | 8px | `--r-4` | 10px |
| `--sp-5` | 12px | `--r-5` | 12px |
| `--sp-6` | 16px | `--r-6` | 16px |
| `--sp-7` | 20px | `--r-pill` | 999px |
| `--sp-8` | 24px | `--r-round` | 50% |
| `--fs-1` | 10px | `--ctl-h` | 34px |
| `--fs-2` | 11px | `--tap` | 44px |
| `--fs-3` | 12px | `--z-mask` | 40 |
| `--fs-4` | 13px | `--z-dlg` | 50 |
| `--fs-5` | 14px | `--z-panel` | 60 |
| `--fs-6` | 16px | `--z-pop` | 70 |
| `--sh-1` | 0 3px 10px rgba(0,0,0,.4) | `--z-mask` | 40 |
| `--sh-2` | 0 6px 20px rgba(0,0,0,.5) | `--z-dlg` | 50 |
| `--sh-3` | 0 12px 40px rgba(0,0,0,.45) | `--z-panel-mask` | 60 |
| `--sh-4` | 0 12px 60px rgba(0,0,0,.6) | `--z-panel` | 61 |
| `--sh-panel` | -8px 0 30px rgba(0,0,0,.4) | `--z-pop` | 70 |
| `--sh-2b` | 0 10px 30px rgba(0,0,0,.55) | `--z-toast` | 99 |
| `--sh-ring` | 0 0 0 1px rgba(0,0,0,.35) | `--z-tip` | 120 |
| | | `--z-top` | 300 |

### 3.4 主题色令牌（**浅色主题必须逐个覆盖**）

| 令牌 | 暗色 | 浅色 | 用途 |
|---|---|---|---|
| `--bg` | `#14151a` | `#eef1f6` | 应用底色 |
| `--bg2` | `#1c1e26` | `#f8f9fc` | 面板/顶栏/时间线 |
| `--bg3` | `#242734` | `#e9ecf3` | 卡片/输入/菜单项 |
| `--bg4` | `#2e3242` | `#dbe0e9` | 按下/选中底 |
| `--ws-bg` | `#17181e` | `#c2c7d1` | 画布工作区底 |
| `--line` | `#343a4d` | `#ccd2de` | 主分隔线 |
| `--line-2` | `#3a3f55` | `#bcc3d1` | 输入框/浮层边框 |
| `--text` | `#d7dae2` | `#22262f` | 主文字 |
| `--dim` | `#8b90a3` | `#5f6675` | 次要文字 |
| `--fg` | `var(--text)` | `var(--text)` | 兼容别名（历史遗留） |
| `--text-2` | `#dfe3f0` | `#3c4250` | 次级文字（标题/名称） |
| `--text-3` | `#cfd5e6` | `#4b5262` | 三级文字 |
| `--text-4` | `#e7ebf4` | `#2e333f` | 高亮文字（数值） |
| `--dim-2` | `#9aa3bd` | `#6b7284` | 弱化文字 |
| `--dim-3` | `#8a90a6` | `#7b8294` | 更弱文字（元信息） |
| `--dim-4` | `#7b8299` | `#98a0af` | 占位符 |
| `--disabled` | `#565b6b` | `#b4bac6` | 禁用文字 |
| `--input-bg` | `#232834` | `#ffffff` | 输入底 |
| `--input-line` | `#3a4055` | `#c3c9d6` | 输入边框 |
| `--input-text` | `#e9edf7` | `#22262f` | 输入文字 |
| `--surface-card` | `#1d2129` | `#ffffff` | 卡片（参考模式/帧格） |
| `--surface-pop` | `#20242f` | `#ffffff` | 浮层（holdpop / 回放 HUD） |
| `--surface-toast` | `#2a2d3a` | `#2f3442` | 轻提示底（浅色下保持深色） |
| `--surface-anchor` | `#232736` | `#eef1f7` | 九宫格锚点底 |
| `--surface-anchor-on` | `#2c3a66` | `#dbe6fb` | 锚点选中底 |
| `--anchor-dot` | `#59607a` | `#b6bcc8` | 锚点圆点 |
| `--accent` | `#5aa2f0` | `#2f6fd0` | 主色 |
| `--accent-2` | `#5f83e8` | `#4a7fe0` | 主色变体（二级球） |
| `--accent-3` | `#4f7cf7` | `#2f6fd0` | 主色变体（锚点选中） |
| `--accent-4` | `#7fb0ff` | `#6f9de8` | 主色变体（锚点圆点） |
| `--accent-soft` | `rgba(90,162,240,.32)` | `rgba(47,111,208,.28)` | 选中边框 |
| `--accent-faint` | `rgba(90,162,240,.07)` | `rgba(47,111,208,.08)` | 选中底 |
| `--accent-glow` | `rgba(90,162,240,.5)` | `rgba(47,111,208,.4)` | 高亮外环 |
| `--on-accent` | `#fff` | `#fff` | 主色上的文字/图标 |
| `--danger` | `#f0616d` | `#c8343f` | 危险色 |
| `--link` | `#8fd0ff` | `#1b6fd0` | 引用图层名等链接色 |
| `--mask` | `rgba(0,0,0,.45)` | `rgba(15,20,30,.28)` | 遮罩 |
| `--set-item-bg` | `rgba(255,255,255,.028)` | `rgba(0,0,0,.022)` | 设置卡片底 |
| `--set-item-line` | `rgba(255,255,255,.055)` | `rgba(0,0,0,.07)` | 设置卡片边 |
| `--set-group-bg` | `rgba(255,255,255,.02)` | `rgba(0,0,0,.018)` | 设置分组底 |
| `--set-head-bg` | `rgba(255,255,255,.04)` | `rgba(0,0,0,.04)` | 分组标题底 |
| `--ctl-bg-soft` | `rgba(255,255,255,.06)` | `rgba(0,0,0,.06)` | 小按钮底 |
| `--ctl-line-soft` | `rgba(255,255,255,.07)` | `rgba(0,0,0,.08)` | 小按钮边 |
| **画布上的浮动控件**（跟随主题，浅色下与浅色工作区一致） | | | |
| `--surface-orb` / `--surface-orb-on` / `--orb-fg` | `#2b2f3e` / `#343a52` / `#e6eaf4` | `#fff` / `#e2e9f7` / `#2e333f` | 浮动球底/展开/图标 |
| `--surface-item` / `--surface-item-active` / `--surface-item-line` | `#262b3a` / `#3d445c` / `#4c5268` | `#fff` / `#dde3ee` / `#c3c9d6` | 环形菜单项 |
| `--line-3` | `#565c74` | `#b4bccd` | 浮动球边框 |
| `--hud-bg` / `--hud-bg-2` / `--hud-bg-2-dim` | `rgba(16,17,22,.78)` / `rgba(21,23,32,.94)` / `rgba(21,23,32,.8)` | `rgba(255,255,255,.86)` / `rgba(255,255,255,.94)` / `rgba(255,255,255,.88)` | 颜色指示、模式胶囊、缩放 HUD |
| `--hud-bg-3` / `--hud-bg-4` | `rgba(21,23,32,.84)` / `rgba(21,23,32,.5)` | `rgba(255,255,255,.9)` / `rgba(255,255,255,.66)` | 对称提示（常态/只读） |
| `--hud-tip` / `--tip-fg` | `rgba(13,15,22,.96)` / `#b7bdcc` | `rgba(255,255,255,.97)` / `#4b5262` | 长按提示气泡 |
| `--dock-bg` / `--dock-bg-open` / `--dock-bg-armed` | `rgba(20,22,32,.55)` / `rgba(15,17,25,.92)` / `rgba(30,36,52,.9)` | `rgba(255,255,255,.72)` / `rgba(255,255,255,.95)` / `rgba(226,233,245,.95)` | 停靠条 |
| `--grad-title-1` / `-2` / `-on-1` / `-on-2` | `rgba(38,42,56,.96)` / `rgba(24,27,37,.96)` / `rgba(58,86,150,.96)` / `rgba(32,42,68,.96)` | `rgba(255,255,255,.96)` / `rgba(238,241,246,.96)` / `rgba(198,219,250,.96)` / `rgba(224,235,252,.96)` | 画布标题栏渐变 |
| `--sym-text` / `--sym-text-2` / `--sym-bg-ro` / `--sym-bg-on` | `#b2ffe2` / `#9fe8cf` / `#1d2a30` / `rgba(34,54,52,.85)` | `#1c7a5a` / `#2a8c69` / `#eef3f2` / `#dff2ea` | 对称提示的文字与底色 |
| `--track-bg` / `--swatch-line` / `--ring-soft` | `rgba(255,255,255,.09)` / `rgba(255,255,255,.4)` / `rgba(255,255,255,.12)` | `rgba(0,0,0,.09)` / `rgba(0,0,0,.25)` / `rgba(0,0,0,.12)` | 进度槽、色块描边、内环 |
| `--sh-float` | `0 4px 14px rgba(0,0,0,.45)` | `0 3px 12px rgba(15,20,30,.18)` | 浮动控件投影 |
| `--accent-2-glow` | `rgba(95,131,232,.25)` | `rgba(74,127,224,.22)` | 二级浮动球外环 |

### 3.5 固定色令牌（画布 HUD / 状态色 / 装饰，两主题同值，**不得**在浅色块覆盖）

| 令牌 | 值 | 用途 |
|---|---|---|
| `--hud-deep` | `#101116` | 预览窗底（图像容器，保持深色） |
| `--hud-on-image` / `--hud-on-image-2` / `--hud-on-image-fg` | `rgba(16,17,22,.78)` / `rgba(18,19,26,.8)` / `#cfd5e6` | 压在图像窗上的小按钮 |
| `--sym` / `--sym-dot` | `#7cf5c5` / `#5a9` | 对称轴线与画布圆点（绿色语义色） |
| `--sym-weak` / `--sym-mid` / `--sym-faint` / `--sym-strong-2` / `--sym-strong` | `rgba(126,255,214,.4)` / `.45` / `.14` / `.65` / `.9` | 对称辅助透明度（叠加在浮动控件上，两主题通用） |
| `--ok` / `--info` / `--warn` | `#4ade80` / `#60a5fa` / `#fbbf24` | 更新日志 add/imp/fix 圆点、未链接图标 |
| `--danger-1`…`--danger-4` | `#ff929b` / `#ff8d96` / `#ff7a7a` / `#ffb4b4` | 危险文字变体 |
| `--danger-line` | `#8a5a5a` | 锁定画布边框 |
| `--guide-shade` / `--guide-shade-soft` | `rgba(8,9,12,.68)` / `rgba(8,9,12,.3)` | 引导遮罩 |
| `--shade-soft` | `rgba(6,8,14,.25)` | 回放遮罩 |
| `--grip` | `#c6cbd8` | 预览窗缩放手柄 |

### 3.6 合并色（唯一允许的视觉微差）

以下近色合并为同一令牌，差值 ≤ 2/255 或 ≤ 2% 透明度，肉眼不可辨：

| 合并后令牌 | 被合并的旧值 |
|---|---|
| `--text-2` | `#dfe3f0`、`#dfe3ee`、`#dfe4f0`、`#dbe1ee` |
| `--text-3` | `#cfd5e6`、`#cdd3e2`、`#c8cfdd` |
| `--dim-2` | `#9aa3bd`、`#9aa0b0`、`#aab1c6` |
| `--dim-3` | `#8a90a6`、`#8d94ab`、`#7f869a` |
| `--hud-deep` | `#101116`、`#0d0f16` |
| `--surface-pop` | `#20242f`、`#1c202b` |
| `--text-4` | 主题底色上的 `#fff`（`.menuitem.on`、`.hist-row.cur`、`.ase-lcell.on .lname`、`.swatch.cur` 描边）——否则浅色主题下白字/白描边会消失 |
| `--sh-1/2/3/4` | 原有 14 种阴影（模糊/透明度就近归一） |

### 3.7 主题切换

- 令牌只在 `:root` 与 `[data-theme="light"]` 两处定义；**规则里不写裸色值**。
- 切换入口：设置 → 显示 → 「界面主题」（`ui.theme`，枚举 `dark|light`，默认 `dark`）。
- 实现：`src/io/theme.ts` 的 `applyTheme(mode)` 写 `document.documentElement.dataset.theme`，并同步 `<meta name="theme-color">`；
  启动时在 `main.tsx` 调用，设置项用 `after` 钩子调用。
- 浅色主题是**新增可选项**，默认仍是暗色；画布工作区在浅色下为中性灰（`--ws-bg`），保证像素画对比度。
- **画布上的浮动控件跟随主题**：浮动球、环形菜单、停靠条、模式胶囊、长按浮标、缩放 HUD、颜色指示、
  对称提示、画布标题栏、长按提示气泡全部使用主题令牌（浅色下变亮，与浅色工作区一致）。
  只有**图像容器**例外并保持深色：预览窗 / 参考图窗底（`--hud-deep`、`--hud-on-image*`）与引导遮罩
  （`--guide-shade*`）——它们承载图像或需要压暗背景。

---

## 4. 迁移清单（实现时逐条勾）

| 目标 | 现状 | 处理 |
|---|---|---|
| 弹窗壳 | 18 处手写 `.dlg-mask/.dlg/.dlg-head/.dlg-body/.dlg-foot` | 全部改为 `<Dialog>` |
| 表单标签 | 17 处 `<label className="rowlabel">` | `<Row label>` |
| 选项组 | 9 处 `.chips`、11 处 `.chip` | `<ChipGroup>` |
| 分段切换 | 4 处 `.tabs/.tab`（导出弹窗） | `<Segmented>` |
| 布尔设置 | `.chip` ON/OFF | `<Switch>` |
| 行内说明/按钮 | 13 处 `.row-note`、6 处 `.row-actions` | `Row hint` / `<RowActions>` |
| 数值/颜色 | 直接 `ScrubNum` / `input[type=color]` | `NumberField` / `ColorField`（保留原布局的可不动） |

**必须保持**：`data-guide` 锚点、`className` 传入的自定义类（`fxdlg`/`tile-dlg`/`clg-dlg`/`blend-dlg`/`dlg-top`/`dlg-frame-preview`/`dlg-canvasref`/`hist-body`/`fp-grid`/`col`）、`Keep` 包裹、`.cfm-layer`。

---

## 5. 测试规范

### 5.1 组件渲染测试（`tests/ui-kit.test.tsx`）

容器里没有 jsdom，组件测试用 **`react-dom/server` 的 `renderToStaticMarkup`** 断言 DOM 契约（无 DOM 依赖，可跑在 `node .ts-out/tests/run-tests.js` 里）：

- `Dialog`：遮罩存在且绑定关闭；标题、`.dlg-head`、`.grow`、关闭按钮（`aria-label`）；`footer` 为空时不渲染 `.dlg-foot`；`className`/`bodyClass` 合并；`closeBtn={false}` 无 ×；`guide` → `data-guide`；`role="dialog"` + `aria-modal="true"`。
- `Row` / `RowActions`：class 与顺序（label → children → note）。
- `ChipGroup` / `Segmented`：选中项带 `on`；点击回调（直接调用 `props.onChange` 断言纯逻辑，不模拟事件）。
- `Switch`：`role="switch"`、`aria-checked` 随 `checked` 变化。
- `NumberField` / `ColorField`：label 与控件同时渲染。

> 事件交互不引入 jsdom：把「点击后发生什么」收敛到纯函数或用 props 直接验证。

当前套件规模：`tests/ui-kit.test.tsx`（组件契约 + kit 纯度）、`tests/ui-tokens.test.ts`（令牌契约）；
两者由 `tests/run-tests.ts` 调用，`tests/tsconfig.json` 需 `jsx: react-jsx`。

### 5.2 令牌规范测试（`tests/ui-tokens.test.ts`）

静态解析 `src/ui/style.css`（与 `tests/i18n.test.ts` 同样的读文件方式）：

1. `:root` 必须定义全部尺寸令牌与主题色令牌（§3.3、§3.4 列表硬编码在测试里）；
2. `[data-theme="light"]` 必须覆盖**每一个**主题色令牌；
3. 固定色令牌**不得**出现在浅色块；
4. `kit` 分区（`.btn`、`.dlg*`、`.rowlabel`、`.row-note`、`.row-actions`、`.chips`、`.chip`、`.tabs`、`.tab`、`.sw`、`.dropmenu*`、`.tabbar*`、`.panel*`、`.set-*`）中不得出现裸色值（`#rrggbb`、`rgb()`、`rgba()`）；
5. `var(--x)` 引用的每个 `--x` 都必须已定义（防拼写错）。

### 5.3 kit 纯度测试

`tests/ui-kit.test.tsx` 内附带：扫描 `src/ui/kit/**` 的 import，禁止 §1.1 的黑名单模块。

### 5.4 回归

`tests/guide-anchors.test.ts`、`tests/i18n.test.ts` 必须继续通过；新增 i18n 键（主题设置）中英各一条。

---

## 6. 演示页

```sh
sh scripts/build-ui-demo.sh          # esbuild → app2/www/ui-demo.html + app2/www/js/ui-demo.js（均 gitignore）
node toolchain/devserver.js          # 端口 8090
# 浏览器打开 http://127.0.0.1:8090/ui-demo.html
```

容器内（仓库路径含中文，esbuild 无法直接读该路径）改用 ASCII 构建目录，与 §6.4 同理：

```sh
cd /root/pcbuild/buildsrc && cp -r /root/pcbuild/app/src/. .
../node_modules/.bin/esbuild ui/kit/demo.tsx --bundle --format=iife --platform=browser \
  --target=es2019 --define:process.env.NODE_ENV='"development"' --outfile=ui-demo.js --log-level=warning
cp ui-demo.js "<repo>/app2/www/js/ui-demo.js" && cp ui/style.css "<repo>/app2/www/css/style.css"
python3 "<按 scripts/build-ui-demo.sh 里的片段生成 app2/www/ui-demo.html>"
```

- 入口 `src/ui/kit/demo.tsx`：一屏展示全部控件与变体、令牌色板、暗/浅主题切换按钮。
- 演示页**不依赖 Session**（验证 kit 纯度）；图标用构建脚本从 `app2/www/index.html` 提取的 sprite。
- 产物不入库：`.gitignore` 已包含 `app2/www/ui-demo.html`、`app2/www/js/ui-demo.js`。
- **打包 APK 前删掉这两个产物**：`make-apk.sh` 会把整个 `app2/www` 塞进 `assets/www`，
  演示页包有 1MB 上下（压缩后约 200KB），不应该进发布包：

  ```sh
  rm -f app2/www/ui-demo.html app2/www/js/ui-demo.js   # 出包
  sh scripts/build-ui-demo.sh                          # 出完包再按需重建
  ```

---

## 7. 后续项（本次不做）

| 项 | 说明 |
|---|---|
| 4 | `UIProvider` 注入 `lang/t/toast/haptic`，彻底移除控件对 Session 的间接依赖 |
| 5 | Toast 组件化（现在是 `main.tsx` 的命令式 DOM） |
| 6 | 键盘导航、焦点陷阱、`aria-live`、桌面快捷键 |
| — | 把 `src/ui/kit` 提成独立 workspace 包并对外发布 |

---

## 8. 提交与验收

每个改造项单独提交，提交信息用中文 `type(scope): 摘要` + `-` 要点；提交前：

```sh
cp -r src/. /root/pcbuild/app/src/ && cp -r tests/. /root/pcbuild/app/tests/
cd /root/pcbuild && ./node_modules/.bin/tsc -p tsconfig.json --noEmit
cd /root/pcbuild/app/tests && ../../node_modules/.bin/tsc -p tsconfig.json && node .ts-out/tests/run-tests.js
```

打包时按 [`AGENTS.md`](../AGENTS.md) §6 走，版本号**只在用户要求出包时**改动。
