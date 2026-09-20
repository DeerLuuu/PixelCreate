# deer-ui：独立 UI 库（PixelCraft 是它的第一个消费者）

> **定位（2026-09-20 第二轮起）**：`deer-ui` 是一个**独立的 React 18 控件库** —— 控件与自己的样式
> 住在库仓库 `Z:\deer-ui`（**与 `Z:\pixelcraft` 平级、各是一个 git 仓库**），库有自己的 README、
> `package.json`、lockfile、CI 与断言台账，**不依赖任何应用在场**就能 `npm ci` + `npm test` + `npm run build`。
> **PixelCraft（像素工坊）是它的第一个消费者**，也是目前唯一的消费者：它经 committed tarball 消费库，
> 并把「库不认识 PixelCraft」当成一条机器判据在守。
>
> 库自己的口径（怎么装、怎么用、组件清单、主题与令牌、开发调试）见**库仓库的 `README.md`**
> （`Z:\deer-ui\README.md` —— 它不在本仓库里，所以这里不给相对链接）—— **那个文件是库的说明书的唯一来源**，
> 本文只写**方案、决策与两仓之间的执行记录**。
> 本文原稿是「把 PixelCraft 的 UI 表现层切出去」的迁移方案，**像素画应用侧的那套叙事已降为附录与执行记录**：
> `§1`–`§9` 保留为**设计与决策依据**（读的时候把「宿主」理解成「消费者」），`§10` 是执行记录（含本轮）。

> 目标：把 `src/ui/` 里的**表现层原语**（控件、设计令牌、图标机制、i18n 注入点）独立成新仓库 `deer-ui`，
> 让 PixelCraft 从包里消费它，同时**应用行为与视觉零变化**。
>
> 基准：仓库 HEAD **`636d9fd`**，`assertions: 8090 / ALL PASS`。
> 输入：四路盘点（t1 UI 边界 / t2 硬耦合与适配层 / t3 包与构建 / t4 分期与验收）+ 对抗式复核（t6）。
> 本文中所有数字都由本轮在 `HEAD 636d9fd` 上**亲手复现**；凡未复现的一律标 `[待验证]` 并写明验法。
> 口径：行数用 `[System.IO.File]::ReadAllLines()`；断言数用 `node tests/.ts-out/tests/run-tests.js` 的**真实输出**按**小节**计数（不按行数估）。
>
> ⚠️ **断言数口径与三处更正（2026-09-20）**：本文凡写「某小节 N 条断言」，数法都是
> **跑 `node tests/.ts-out/tests/run-tests.js`，按输出里的 `--- 小节名 ---` 分段数 `ok ` 行**，
> 且**总数必须与末尾的 `assertions:` 一致**（迁移前 = **8090** → 宿主改为消费 deer-ui 之后 = **8119**
> → **第二轮样式抽进库之后 = 8134**，见 §10.7-3）。
> 原稿按 `ui.` / `uibar.` 这类**前缀**计数，跨小节的前缀会被算错，于是三个数字是错数，已按队长 2026-09 实测裁定更正：
>
> | 处 | 原值 | 实测 | 为什么会错 |
> |---|---|---:|---:|---|
> | 宿主 `ui kit` 小节（`tests/ui-kit.test.tsx`） | 112 | **70** | 「112」无出处；同小节里还有 `ui.htip.*` 13 条等非 `ui.dialog.*` 名字 |
> | 宿主 `i18n` 小节 | 34 | **8** | **34 其实是 `expr` 小节**的条数（`tests/expr.test.ts`），前缀相近被串了行 |
> | 宿主 `uibar` 小节 | 97 | **104** | 97 只是 `uibar.*` 前缀那一部分；同小节里另有 **7 条 `act.list.*`** |
>
> **行号里的数字不是断言数**（例：`timeline.tsx:70,112,166,237`、`style.css:5-97`），一律没动。
> **库侧运行合计实测 123**（= 从宿主搬入 62 + 库自身 A0/基建 61，见 §10 执行记录）——
> **第二轮把它改成 134**（库自带样式带来 +10 条样式判据、+1 条预算闸门；口径见 §10.7-3），
> 所以文中「库测试 ≥ 70」这类下限只是**保守**，没有任何闸门被放宽。

---

## 0. 一页结论

### 0.1 抽什么、不抽什么

> **抽的是「表现层原语」**：与业务无关的控件、设计令牌、图标**机制**、i18n **注入点**。
> **不抽的是「UI 目录」**：`src/ui/` 39 个文件里只有约 2,200 行属于前者，其余约 12,100 行是 PixelCraft 的产品界面。
> **抽库的本质不是「搬家」，而是「把 `docs/UI.md` §1.1 的纯度规则从 8 个文件推到一批新文件」。**

### 0.2 分期总览（P0–P8）

| 期 | 目标 | 代价 | 应用改动 |
|---|---|---|---|
| **P0a（A0）** | **零复制**：在 `src/ui/kit` 原地加 3 条机器判据（纯度白名单收紧 / barrel 导出面快照 / 库内不得自判 PC·主题·安全区） | S | **0**（只加测试） |
| **P0b（甲案）** | 把 10 个文件复制成能独立编译、独立跑 **70 条**断言的 `packages/deer-ui/` | S–M | **0** |
| **P1** | 给 `style.css` 划物理边界（仅重排 + 机器锚点，**声明零改动**） | M | 只动 `style.css` |
| **P2** | 拆样式：令牌 + kit 规则进库，构建时拼接为单一 `css/style.css` | M | `style.css` + 构建脚本 + 1 个测试 |
| **P3** | 图标契约 + i18n 注入契约 + 防分叉门禁上线 | S–M | 0（只加测试/脚本） |
| **P4a** | 第 2 刀之一：**4 个 0-import 纯几何文件**（零前置、可随时插队） | S | import 边 |
| **P4b** | 第 2 刀之二：`uibar.ts` 算法段（**硬前置**：先拆分算法/注册表） | M | 拆 `uibar.ts` + import 边 |
| **P5** | 拆仓：独立仓库、`tsc` 出包、`npm pack`、`vendor/*.tgz` | L | `vendor/` + `package.json` 一行 |
| **P6** | 应用消费库：`src/ui/kit/**` 变薄再导出壳 | M | `kit/*`、`tabs` 边、`tooltip` 归属 |
| **P6.5** | **`UiHost` 落地接线**（provider + `useUiHost()` + 宿主实现 + ≥2 个真实消费者） | M | `main.tsx` + `App.tsx` |
| **P7** | 收尾：删旧实现、文档三处入口、门禁进 verify | S | 删除 + 文档 |
| **P8（可选）** | 第二宿主验证（`examples/standalone.html`） | S | 0 |

### 0.3 主要风险

| 项 | 量 |
|---|---|
| 总代价 | **L–XL（约 14–22 人日）**，集中在 P1 + P4b + P5 + P6 + P6.5 |
| 最大技术风险 | **R1 包体 / React 重复实例**：React+ReactDOM 地板 **142,547 B** = `app.js`（**1,334,285 B**）的 10.7%，而 `kit/` 全部源码只有 **36,493 B** ⇒ **一次 React 重复抵消四次抽库** |
| 第二大风险 | **R2 三端兼容（`file://` / 旧 WebView）**：本机**没有 Android 设备**，只能静态守，**不许以「已核」口吻写进度** |
| 最易忽视 | **R7 双仓漂移**：两边测试都会绿，**没有测试能发现** → 靠 `CHECKSUMS.txt` + `--check` 门禁 |
| 已排除的伪风险 | 「抽库能省体积」——**不是**。目标是「不变大 + 边界变清」，`docs/ARCHITECTURE.md` §4.8 已写死「不要为了省 50 KB 做这件事」 |

### 0.4 三条必须一起读的勘误

| # | 错误说法 | 实测事实 |
|---|---|---|
| 1 | 「`src/ui/` 约 26 个文件」 | **39 个**（顶层 31 + `kit/` 8，含 `style.css`） |
| 2 | 「复用现成的 `modules.config.json`」 | **`modules.config.json` / `src/modules/` / `scripts/modules.mjs` 三者全不存在**，是 `docs/ARCHITECTURE.md` §4.4 的 **M0 期规划物** |
| 3 | 「`style.css` 分 5 区，切 `3/5 kit` 即可」 | 文件里**只有 2 个带编号横幅**（`1/5 tokens` 第 2 行、`2/5 base` 第 139 行；另有 `1b/5 PC 模式` 第 99 行），`3/5`/`4/5` **不存在** |

---

## 1. 目标与非目标

### 1.1 目标（可验收）

| # | 目标 | 验收判据（可执行） |
|---|---|---|
| **G1** | `deer-ui` 能**独立编译** | `node node_modules/typescript/lib/tsc.js -p packages/deer-ui/tsconfig.json --noEmit` → 退出码 0 |
| **G2** | 库能**独立跑 DOM 契约测试** | `cd packages/deer-ui && node node_modules/typescript/lib/tsc.js -p tests/tsconfig.json && node tests/.ts-out/tests/run-tests.js` → 末两行 `assertions: ≥ 70` / `ALL PASS`（库侧运行合计实测 **123**，见 §10） |
| **G3** | 应用的**行为与视觉零变化**，断言只增不减 | `node tests/.ts-out/tests/run-tests.js` → `assertions: ≥ 8090` / `ALL PASS` |
| **G4** | 库**不认识 PixelCraft** | `node scripts/check-ui-fork.mjs` → 退出码 0（反向段：库内不得出现应用 import / `SESSION`） |
| **G5** | 应用侧**调用点几乎不改** | `src/ui/kit/index.ts` 保持为**唯一再导出边**；`grep -rn 'from "./kit/' src/` 只命中它一条 |
| **G6** | 防分叉从「纪律」变成「CI 会红」 | `tests/ui-fork.test.ts` 四条断言全绿；负例（故意新建 `src/ui/Dialog.tsx`）必须红 |

> ⚠️ **`scripts/run-tests.sh` 里那条 `node node_modules/typescript/bin/tsc.js` 在本机不存在**（只有无扩展名的 `bin/tsc`），
> 真路径是 **`node_modules/typescript/lib/tsc.js`**。上面 G1/G2 用的是真路径。**新仓库脚本别照抄旧路径。**

### 1.2 非目标（逐条写具体）

| # | 非目标 | 为什么 |
|---|---|---|
| **N1** | **不是重写组件内部** | 迁移期唯一资产是「行为不变」。`Dialog` 的 DOM 契约被 70 条断言 + 引导锚点 + `style.css` 三类东西同时依赖，重写内部等于同时动三份契约。新特性一律另开功能期 |
| **N2** | **不做主题市场 / 不改主题机制** | `src/ui` 里 **0 处** import `io/theme`。主题只经 `document.documentElement.dataset.theme` + CSS 令牌块——**这是已经零耦合的一条，加进适配层反而是退步** |
| **N3** | **不搬业务 UI** | `App.tsx`(2,998) / `modals.tsx`(2,410) / `AiPanel.tsx`(1,172) / `timeline.tsx`(609) / `changelog.tsx`(811) / `iso.tsx` / `canvas.tsx` / `preview.tsx` / `refimg.tsx` / `replay.tsx` / `guide*.tsx` / `paste.ts` / `renderdebug.tsx` —— 已被 `docs/ARCHITECTURE.md` §4.2 **逐行指派给具体可选模块**，该跟**模块**走 |
| **N4** | **不搬 `src/render/view.ts`** | 3,693 行、import 38 个模块横跨 7 个目录、直触 `Session` 约 50 个成员、**真的在写数据**、且与 `Session` 是**双向环**（`session.ts` 持有 `view_`，56 处直调）。它是**渲染器**不是 UI 库；库只从它抽 `ViewHost` 接口与纯绘制原语 |
| **N5** | **库不自带 i18n 字典** | 会与宿主字典重复 845 键，且与 `docs/ARCHITECTURE.md` §4.6「每模块自带 `i18n.ts` 片段、构建时合并」形成**三套合并逻辑**。库只收注入的 `t` / 键名 + 英文兜底 |
| **N6** | **不搬图标数据（122 个 `i-*` symbol）与图标分组表** | `feature-icons.ts` 的分组语义是**产品规则**（同屏入口不得共用图标），且图标分组要**按启用模块计算** → 那是模块知识。库只给 `Icon` **机制** |
| **N7** | **不搬 `src/ui/back.ts` 作为「UI 控件」** | 它服务 Android 返回键，属**平台适配**而非控件。进库时按「平台无关的纯状态机」归类 |
| **N8** | **不引构建框架** | 不引 vite / rollup / tsup / turborepo / monorepo 工具链 / changesets。构建 = `tsc` 一次出 ESM + `.d.ts` |
| **N9** | **不引 jsdom / vitest / happy-dom** | jsdom **没有布局**，而本仓库历史 UI bug **全是布局类**（`DropMenu` 被 `overflow-x:auto` 裁掉、变形抓手命中区、浮动球几何）。引它换来「能跑事件」的错觉却抓不到真 bug |
| **N10** | **不改 DOM class 名、不删 `data-guide` 透传** | `tests/guide-anchors.test.ts`(10) + `tests/ui-kit.test.tsx`(70) + `tests/ui-tokens.test.ts`(17) 静态盯住这些名字；改名 = 引导与样式**同时静默失效** |
| **N11** | **不做「为了抽库顺手修既有缺陷」** | 见 §7.2 的 10 项待办，每一项都**单独小提交 + 单独验**，不混进迁移提交 |
| **N12** | **不碰 `android/` 与 `app2/www/`** | `AGENTS.md` §5.1b：这两个是**产物**，由 `build-web.sh` 生成。`docs/ARCHITECTURE.md` §8 决策 8 已裁：Java 层保持最小且通用 |
| **N13** | **不把库版本号接进 `APP_VERSION` / 更新日志 / `AndroidManifest`** | 两条版本线。接了会让 `tests/changelog.test.ts`(20) 红，且用户在更新日志里看到「deer-ui 0.2.1」这类无关条目 |
| **N15** | **不得在迁移中削弱无障碍属性**（**红线**） | `Dialog` 的 `role` / `aria-modal` / `aria-label`、`Switch` / `ChipGroup` / `Segmented` 的 `role` / `aria-*`、以及键盘可达性（`Esc` 关闭、`Tab` 聚焦）现在是**被 70 条断言隐式钉住的**（`ui.dialog.role`、`ui.dialog.aria-label`、`ui.chips.*`…）。**库的无障碍契约 = DOM 契约的一部分**：迁移**只做「不退化」承诺，不新增**。库测试必须**逐条保留** `role` / `aria-*` / 键盘可达断言，**禁止**以「简化 markup」为由删掉任何一条。判据：`ui kit` 小节断言数 ≥ 70 且其中 `role`/`aria` 相关断言逐条在位 |
| **N16** | **不承诺 SSR** | `renderToStaticMarkup` 是**测试手段**，不是 SSR 支持。库里有 `window.matchMedia` / `window.innerWidth`（`kit/primitives.tsx:12,14`、`kit/HoverTip.tsx:55-56`、`kit/scrub.tsx:100-101`），它们只是**测试渲染时的兜底**（`typeof window === "undefined" ? 默认值`）。第三方**不要**把它当 `renderToString` 上线的库 |
| **N17** | **P0 不产出发布面** | P0 **不 emit `dist`**、不写 CI、不做 `exports` 全集、不发 npm。P0 只承诺「能独立编译 + 能独立跑测试」。发布面属 P5 |

---

## 2. 现状与可抽取边界

### 2.1 基线与口径

| 项 | 实测值 | 口径 |
|---|---|---|
| HEAD | `636d9fd` | `git rev-parse --short HEAD` |
| 工作区 | 干净（0 条） | `git status --short` |
| 回归套件 | **assertions: 8090 / ALL PASS / 退出码 0** | `node tests/.ts-out/tests/run-tests.js` |
| `src/ui/` 规模 | **39 文件 / 约 14,335 行**（含 `style.css` 1,454 行） | **口径注**：按 LF 数到 14,332，按 `ReadAllLines` 数到 14,335，差 3 行是尾部换行口径。引用行号一律以 `ReadAllLines` 为准 |
| `src/ui/kit/` | 8 文件 / **901 行** / **36,493 B** 源码 | 逐文件相加 |
| 第一刀 10 文件 | **1,074 行**（`primitives 166 + scrub 198 + Dialog 86 + Form 143 + HoverTip 91 + pcmode 29 + index 13 + tabs 140 + tooltip 33 + demo 175`） | 逐文件相加 |
| `app.js` | **1,334,285 B**，md5 `a15d5b1e626edfaf526c28694bed4b86` | `(Get-Item app2\www\js\app.js).Length` |
| `app2/www/css/style.css` | **106,806 B**（源 = 产物，构建时纯 `cp`） | 同上 |
| 反向依赖 | **除 `src/main.tsx` 外没有文件 import `src/ui/**`** | `Select-String 'from "../ui/'` 于 `src/**` → 0 命中 |
| lockfile | **不存在**（`package-lock.json` / `yarn.lock` / `pnpm-lock.yaml` 均无） | `Test-Path` × 3 |

> **含义**：`src/ui/` 是一条**单向边**。抽库**不需要动** `app/ engine/ io/ render/ servers/ tools` 的任何一行 import；改动面**全部落在 `src/ui/**` 与 `tests/**`**，外加迁移期新增的 `packages/deer-ui/**`、`vendor/**`、`scripts/**`。

### 2.2 三档归属总表

| 归属 | 文件数 | 行数 | 清单 |
|---|---|---|---|
| **可进库**（只依赖 react/react-dom/纯函数） | **12** | **1,101** | `kit/{scrub,Dialog,Form,HoverTip,pcmode,index}`、`tabs.tsx`、`tooltip.ts`、`orb-layout.ts`、`pie-layout.ts`、`guide-layout.ts`、`back.ts` |
| **需改造后可进**（通用职责 + 硬引 SESSION/i18n/Doc） | **7** | **1,113** | `kit/primitives.tsx`、`hold.tsx`、`color-drag.tsx`、`base.tsx`、`HsvWheel.tsx`、`fxparam.tsx`、`scale-preview.ts` |
| **留在应用** | **20** | **12,121** | `App.tsx`、`modals.tsx`、`AiPanel.tsx`、`AiWindow.tsx`、`timeline.tsx`、`changelog.tsx`、`i18n.ts`、`singleton.ts`、`style.css`、`feature-icons.ts`、`iso.tsx`、`canvas.tsx`、`preview.tsx`、`refimg.tsx`、`replay.tsx`、`renderdebug.tsx`、`paste.ts`、`guide.tsx`、`guide-demo.tsx`、`kit/demo.tsx` |
| 合计 | 39 | ~14,335 | —— |

### 2.3 `style.css`：先划边界，再拆

**现状**（带编号横幅**恰好 2 条**）：

| 实测横幅 | 行 | 性质 |
|---|---:|---|
| `1/5  tokens — 设计令牌（唯一取值来源，规则里不写裸色值）` | 2 | 库区候选 |
| `1b/5  PC 模式（<html data-pc="1">）` | 99 | **宿主密度覆写**（含 `.btn/.chip/.tab/.dlg*` 的 PC 尺寸）→ 留应用 |
| `2/5  base — 重置与通用元素` | 139 | 混合（重置留应用、控件规则进库） |
| `Aseprite-style layer x frame matrix timeline`（**无编号**） | 397–802 | 业务 → 留应用 |
| `motion: window enter/exit + floating orb bounce`（**无编号**） | 803–1454 | 业务 → 留应用 |

**控件规则被劈成两簇**：主簇在业务段之前（`.btn*` 162–174、`.panel*` 195–206、`.rowlabel/.row-note/.row-actions` 208–219、`.dlg*` 244–261、`.tabs/.tab` 285–287、`.chips/.chip` 288–290、`.sw` 292–298、`.textinput` 516），另一簇**夹在业务段之间**（`.htip*` 654/662/663、`.set-*` 738–747、`.dropmenu*` 775–784）；`.btn` 还在 `:645` 以 `.btn,.orb,…,.chip` 的合并规则出现，`.rowlabel` 在 `:219` 与 `:728` 两处。

`tests/ui-tokens.test.ts`（187 行）只靠**三个锚点**切片：
- `:105` 只读**一个**文件 `src/ui/style.css`
- `:106-107` — `css.indexOf(":root{")` 与 `css.indexOf('\n[data-theme="light"]{')`
- `:65` — `const BANNER = "   2/5  base"`；`:124` — `const body = css.slice(css.indexOf("*/", css.indexOf(BANNER)) + 2)` ⇒ **body = 从 `2/5` 横幅注释结束处到文件末尾**

> **结论**：`docs/UI.md` §3.1 的「5 分区」是**文档愿望**而非文件现状。**「切样式」不是可执行任务，直到有人先给样式表划出物理边界**（P1）。
> **不要改回去**：这次盘点确认了 `3/5` / `4/5` 从来不存在，别再照 §3.1 的措辞写方案。

### 2.4 逐文件结论与依据

#### A. 可进库 12 个 / 1,101 行

| 文件 | 行 | 依据 | 备注 |
|---|---:|---|---|
| `kit/scrub.tsx` | 198 | 非 kit 依赖只有 `engine/expr`（`:7`）+ `engine/scrub`（`:8`），两者都是 0-import 纯函数；`kit/Form.tsx:6` 依赖它 | 库必须**内联**这两个纯函数 |
| `kit/Dialog.tsx` | 86 | 只 import `react:13` + `./primitives:14`；16 个 props 全受控 | 唯一硬编码文案：`:50` `closeLabel = "close"`（用于 `:74` 的 `aria-label`） |
| `kit/Form.tsx` | 143 | 只 import `react:5` + `./scrub:6,7` | 无 |
| `kit/HoverTip.tsx` | 91 | 只 import `react:10` + `./pcmode:11` | 「宿主推状态进库」的**依赖倒置样板** |
| `kit/pcmode.ts` | 29 | 只 import `react:7`（`useSyncExternalStore:28`） | ⚠️ `setKitPcMode` 全仓 **0 调用点**（见 §7.2 D3） |
| `kit/index.ts` | 13 | 纯再导出；barrel = 25 值 + 6 类型 | **公开面 = 可发布 API 的定义**。⚠️ **不含 `TabBar`/`DropMenu`**（见 §3.2-B） |
| `tabs.tsx` | 140 | `TabBar` / `DropMenu`，零非 ui 依赖（只 `react` + `react-dom` 的 `createPortal`） | `docs/UI.md` §2.7 已把它列在「基础件」，却不在 `kit/` 里 |
| `tooltip.ts` | 33 | **0 import**；模块级 store（`showTip/hideTip/subscribeTip`） | ⚠️ **唯一「两份就出 bug」的引用**，见 R10 |
| `orb-layout.ts` | 135 | **0 import**；`tests/orb.test.ts`(31) / `selorb`(47) / `pc`(31) 覆盖 | 含 PixelCraft 特有尺寸常量（`ORB_SIZE 40`…） |
| `pie-layout.ts` | 74 | **0 import**；`tests/pie.test.ts`(53) | 纯几何 |
| `guide-layout.ts` | 129 | **0 import**；`tests/guide-layout.test.ts`(24) | 纯几何 |
| `back.ts` | 30 | **0 import**；`tests/back.test.ts`(13) | 语义上是**平台适配**而非控件（N7） |

#### B. 需改造后可进 7 个 / 1,113 行（**加了「归属期」列**）

| 文件 | 行 | 改造点（证据） | **归属期** |
|---|---:|---|---|
| `kit/primitives.tsx` | 166 | `primitives.tsx:6` `import { showTip, hideTip, subscribeTip } from "../tooltip"` —— `tooltip` 在 `kit/` **之外**。这是 kit 唯一的「库外引用」 | **P0b 已解**（`tooltip.ts` 一并纳入） |
| `hold.tsx` | 403 | `hold.tsx:3` 直 import `SESSION`；`SESSION` 10 次（`prefs.railSwap` / `color` / `setColor` / `setColorPicking` / `hapticTick`）；`hold.tsx:10` `isPc` | **不在 P0–P8 内**（只登记改造点，不改它） |
| `color-drag.tsx` | 135 | `color-drag.tsx:12` import `./tooltip`；`SESSION` 5 次（`quickFill` / `prefs.lang` / `hapticTick:118`）；`bridge.toast:119,122` | **不在 P0–P8 内** |
| `base.tsx` | 29 | `./singleton`（`SESSION` 4 次）+ `./i18n` + `./kit/scrub`；**被 10 个 ui 文件 import** | **P6 拆两半**：`useSession()`（**必留应用**）+ 再导出层（指向包） |
| `HsvWheel.tsx` | 161 | 只 import `../engine/types` 的 `RGBA` **类型** | **不在 P0–P8 内**（低风险后手） |
| `fxparam.tsx` | 93 | `:12` `import type { Doc }` + `:11` `SESSION` 2 次（取当前色） | **不在 P0–P8 内** |
| `scale-preview.ts` | 126 | 只 `import type` `engine/color-analysis`（`flattenLayers`）+ `engine/doc`（`Doc`） | **不在 P0–P8 内**（`docs/ARCHITECTURE.md` §4.2 归 `resample` 模块） |

> **口径声明（防误读）**：「需改造后可进」是**分类**（它们职责通用、只差注入），**不是承诺**。
> 上表里 **5 个（`hold` / `color-drag` / `HsvWheel` / `fxparam` / `scale-preview`）在本方案的分期表里没有归属期** ——
> 本方案**不做**它们的改造。唯一例外是 `base.tsx`（P6 必动）与 `primitives.tsx`（P0b 自动解决）。

#### C. 留在应用 20 个 / 12,121 行

| 文件 | 行 | 为什么留 |
|---|---:|---|
| `App.tsx` | 2,998 | 应用外壳；`SESSION` 424 次；`docs/ARCHITECTURE.md` §4.9 点名它是**模块化硬前置** |
| `modals.tsx` | 2,410 | 21 个弹窗 + 导入/导出流程；`SESSION` 265 次；**不能整文件进库** |
| `AiPanel.tsx` | 1,172 | 绑死整条 AI 能力线（`ai-*.ts` 9 文件 7,001 行）；含 provider key/endpoint/模型预设；`isNativeShell()` 门 |
| `AiWindow.tsx` | 176 | 与 `AiPanel` 同生共死；几何归一化在 `app/uibar.ts` |
| `timeline.tsx` | 609 | 文档模型的可视化编辑器（帧/图层/标签/混合模式）；§4.2 归 `animation` 模块 |
| `changelog.tsx` | 811 | 产品数据 + `APP_VERSION` 与 `AndroidManifest.xml` 的 `versionName` 绑成不变量 |
| `i18n.ts` | 975 | 库不自带字典（N5） |
| `singleton.ts` | 3 | `export const SESSION = new Session();` —— **这就是「应用」的定义本身** |
| `style.css` | 1,454 | 见 §2.3，必须拆但拆前要先划边界 |
| `feature-icons.ts` | 105 | 「同屏不得复用图标」是**产品规则**，键名全是本产品功能 id（N6） |
| `iso.tsx` / `canvas.tsx` / `preview.tsx` / `refimg.tsx` / `replay.tsx` / `renderdebug.tsx` / `paste.ts` / `guide.tsx` / `guide-demo.tsx` | 171/193/168/153/160/59/72/197/60 | §4.2 **已逐行指派**给 `iso` / `multicanvas` / `frame-preview` / `refimage` / `history-replay` / `guide` 模块。其中 `renderdebug.tsx:14` 另有 §3.8 明令禁止的 `ui → servers` 既有硬伤（D9） |
| `kit/demo.tsx` | 175 | **归属见 §2.5 —— 与前述「留应用」不同，本方案把它划到 P0b 进库** |

### 2.5 `kit/demo.tsx` 的归属（**本文改正了一处错误前提**）

**先纠正一条事实**：`tests/ui-kit.test.tsx` **今天就在 import 并真实渲染** `demo.tsx`：

- `:12` `import { Demo } from "../src/ui/kit/demo";`
- `:170-177` 一个独立小节 `// demo page`，`:173` `const demo = html(<Demo />);`
- `:174-175` 5 条探针断言 + `:177` `ui.demo.sections` = **共 6 条** `ui.demo.*`

**所以**「库测试不 import 它 ⇒ 它不该放 `src/`」这条判据**是错的**：它今天就在被 import。
照「P0 只复制 9 个文件、排除 `demo.tsx`」做，库测试副本会 `import "../src/ui/kit/demo"` **直接指不到库目录** → 编译/运行期失败。

**裁决：P0b 就把 `demo.tsx` 复制进库**（`packages/deer-ui/src/demo.tsx`），三条约束：

| 约束 | 说明 |
|---|---|
| ① **不进 barrel** | 库的 `src/index.ts` **不** `export * from "./demo"`。它只是测试夹具 |
| ② **不进 `files`** | 发布清单里没有它（P5 才有 `files`；`demo` 不是公开面） |
| ③ **不进 `tsconfig.build.json` 的 emit** | 它只在 `tests/tsconfig.json` 的编译范围内。**P0b 不 emit `dist`**（N17），所以这条 P0b 期自然成立，P5 出包时靠 `tsconfig.build.json` 的 `include` 明确排除 |

**接受已知的双副本窗口**：P0b 起应用侧 `src/ui/kit/demo.tsx` **仍有第二份**（`scripts/build-ui-demo.sh:16` 的 esbuild 入口就是 `src/ui/kit/demo.tsx`）。
这是**有截止日期的**：P5 把它搬到库仓库 `examples/`，P7 删应用侧副本。窗口期内由 §6.4 的防分叉门禁 + R7 同步纪律收口。

**为什么不是「P0b 少搬 6 条」**：那会让「库测试 = 70 条」这条**唯一可量化的验收**变成 64 条，
且要在未来的某一期再把 6 条补回来——**等于把不确定性推后**，与本方案的排期原则相反。

### 2.6 首刀切哪里（**A0 + 甲案**）

#### A0（零复制的前置探针，**P0a**）

**不新增任何目录**，先在 `src/ui/kit` **原地**加 3 条机器判据：

| 判据 | 内容 |
|---|---|
| **A0-1 纯度白名单收紧** | 把 `tests/ui-kit.test.tsx:184-197` 的白名单从 8 项收成 **4 项**：`react` / `react-dom` / `react-dom/*` / `./*`。**去掉** `../../engine/expr`、`../../engine/scrub`、`../tooltip` |
| **A0-2 barrel 导出面快照** | `src/ui/kit/index.ts` 的导出面**逐符号快照**（25 值 + 6 类型），改动即红 —— 这是「公开面 = API」这句话的机器形态 |
| **A0-3 库内不得自判 PC / 主题 / 安全区**（见 R3 的修正措辞） | 禁的是**判定性调用**：`matchMedia(` 带 `pointer:`/`hover:` 的模式；`documentElement.dataset.pc` / `dataset.theme` 的**写**；`localStorage` 全禁。**不禁** `window.innerWidth` 的测量用法（见 R3） |

**成本 S 的下限、零复制、零双份实现、完全可逆。**

> ⚠️ **A0-1 会当场变红**（今天 `primitives.tsx:6` 的 `../tooltip`、`scrub.tsx:7-8` 的 `engine/*` 都在白名单里，去掉就红）。
> **这正是 A0 的价值**：它把「kit 现在还不是自足的」变成**一条会红的断言**。
> **A0 的完成定义** = 三条断言落地，且对**当前**代码给出「已知 3 处越界」的**明确输出**（不是全绿）：
> 白名单先按现状写 8 项 **并加一条 TODO 断言**记录「3 处越界待 P0b 消除」，P0b 再把白名单收到 4 项。
> **不要**为了让 A0 绿而把断言写成 8 项了事。

#### 甲案（P0b）

| 项 | 内容 |
|---|---|
| 内容 | `kit/{primitives,scrub,Dialog,Form,HoverTip,pcmode,index}`（7）+ `tabs.tsx` + `tooltip.ts` + `demo.tsx` = **10 文件 / 1,074 行** |
| 应用改动 | **0**（纯复制；应用继续从 `src/ui/kit` 引） |
| 外部依赖 | `react` / `react-dom` + `../tooltip`（复制进库）+ `engine/{expr,scrub}`（内联） |
| 验证力 | **高**：70 条 DOM 契约断言 + 纯度扫描 + 独立 tsc，一次把「库能否成立」证掉 |
| 代价 | S–M |

#### 乙案（拆成 P4a / P4b）

| 子期 | 内容 | 前置 |
|---|---|---|
| **P4a** | `orb-layout.ts`(135) + `pie-layout.ts`(74) + `guide-layout.ts`(129) + `back.ts`(30) = **4 文件 / 368 行**（全部 0 import） | **零前置，可随时插队** |
| **P4b** | `app/uibar.ts` 的**算法段**（见 §5.2 P4b 的逐函数表） | **硬前置**：`uibar.ts` 是单文件，业务注册表与算法同处一文件，必须先拆 |

#### 为什么 P0 = A0 + 甲案

1. **先证契约面、再复制**：A0 用 1/5 的代价暴露甲案想证的那类不确定性（`../tooltip` 越界、barrel 面、PC/主题自判），并把**首个不可逆动作（复制）推后**。
2. **甲案证的是「库能否成立」这件事**——只有带 DOM 契约的控件证得了。乙案的 4 个文件**今天已经是库形状**（0 import、纯函数、有单测），搬它们证不了新东西。
3. **乙案的「更便宜」是假便宜**：它便宜在**没有不确定性可暴露**。但 P4a 仍然值得做（零耦合、零风险），**所以放在 P0 之后而不是不做**。
4. **不选「先铺适配层」**：它的唯一好处是「不动文件」，代价是「库成立与否到末期才知道」——在 379 个提交、8090 条断言的仓库里，把不确定性推到末期是最贵的排法。
5. **P4a 与 P4b 必须拆开**：`uibar.ts` 需要前置，4 个几何文件**不需要**。把 5 个文件当一个整体会低估 P4a 的可插队性。

### 2.7 测试引用面：采用 **24 个文件 / 三分类**

| 类 | 数量 | 文件 | 迁移时的影响 |
|---|---|---|---|
| **A. 目录 / 全文件扫描** | **5** | `i18n.test.ts`、`guide-anchors.test.ts`、`icons.test.ts`、`ui-tokens.test.ts`、`ui-kit.test.tsx` | **红点来源**。`readdirSync` 类会直接 ENOENT（`run-tests.ts` 打 `FATAL`）；扫描类会**静默漏网**（更危险，见 R12） |
| **B. 精确路径静态接线** | **14** | `ai-chat` / `ai-tools` / `ai-vision` / `ai-rpc` / `changelog` / `color-analysis` / `color-drag` / `fullscreen` / `pc` / `scale` / `selorb` / `shading` / `uiback` / `back` | **只要不改这些文件在 `src/ui` 里的位置就不红**。本方案 P0–P7 **不动 `App.tsx`/`modals.tsx`/`changelog.tsx`/`AiPanel.tsx`/`i18n.ts` 的路径** → 这 14 个**全程应有 0 改动** |
| **C. 纯函数直接 import** | **5** | `orb.test.ts` / `pie.test.ts` / `guide-layout.test.ts` / `pc.test.ts` / `scale.test.ts` | 与位置无关，只要模块还在。**P4a 搬前三个（整体跟着走），后两个只搬与几何有关那段** |

> **「分类」比「总数」重要**：真正跟着库走的只有 `ui-kit` 的组件契约 + `ui-tokens` 的库部分；
> 留应用的静态扫描类（`icons` 86 / `i18n` 8 / `guide-anchors` 10 / `pc` 31 / `scale` 23 / `changelog` 20 …）**一条都不需要改**。

---

## 3. 架构

### 3.1 包与目录结构

**形态：单包 + `exports` 子路径。不做多包 workspace。**

**理由**：可抽体量太小（`kit/` 源码仅 36,493 B / 8 文件）；`src/ui` 里有 **61 处** `from "../{app,io,render,tools,servers}/..."` 耦合，能独立发布的只有一坨。多包的价值在「独立版本号 + 独立发布节奏 + 强边界」，而拆成 `@deerluu/kit` + `@deerluu/tokens` 只会变成 3 个版本号同步改、3 份 CHANGELOG、3 次 `npm publish` —— **边界没变强，事务成本 ×3**。

**迁移期（单仓，P0–P4）布局**：

```
Z:\pixelcraft\                        ← 应用仓库
  src\                                ← 应用源码（P0–P4 除 kit/tabs/tooltip 与 style.css 外不动）
  packages\deer-ui\                   ← ★ 库的源码真相（P0b 起）
    package.json                      ← peerDeps: react ^18.3.0 / react-dom ^18.3.0；private: true（见 Q14）
    LICENSE                           ← ★ P0b 交付物（见 §5.2 P0b）
    tsconfig.json                     ← noEmit（独立编译验收）
    tsconfig.build.json               ← P5 才用（emit dist）
    src\
      index.ts                        ← 公开 barrel（只 re-export）；★ 需新增 export * from "./tabs"
      kit\  primitives.tsx  scrub.tsx  Dialog.tsx  Form.tsx  HoverTip.tsx  pcmode.ts  index.ts
      tabs.tsx                        ← P0b 复制（并在 index.ts 里导出，否则不在公开面）
      tooltip.ts                      ← P0b 复制（库独占）
      demo.tsx                        ← P0b 复制（测试夹具；不进 barrel / 不进 files）
      internal\  expr.ts  scrub.ts    ← 从 engine/{expr,scrub} 内联的纯函数
      geometry\  orb-layout.ts  pie-layout.ts  guide-layout.ts  back.ts   ← P4a
      icons\index.ts                  ← P3
      i18n.tsx                        ← P3（I18nProvider / useT / setKitI18n）
      host.tsx                        ← P6.5（UiHostProvider / useUiHost / UiStrings 兜底）
      tokens.css  kit.css             ← P2
    tests\  tsconfig.json  common.ts  run-tests.ts  ui-kit.test.tsx  ui-tokens.test.ts
            icons.test.ts  i18n.test.ts  host.test.tsx
    examples\demo.tsx                 ← P5 搬入（不进 barrel / 不进 files）
  vendor\deerui-<version>.tgz         ← P5 起：committed tarball
  scripts\deer-ui-vendor.sh  build-css.mjs  check-ui-fork.mjs   ← 迁移期新增
```

**拆仓后（P5+）**：`packages/deer-ui/` → `../deer-ui`（与 PixelCraft **平级**）。应用侧只保留 `vendor/` 与三个脚本。

### 3.2 公开面清单

#### A. 包入口（`exports` map）

| 子路径 | 内容 | 期 | 解析状态 |
|---|---|---|---|
| `.` | `dist/index.d.ts` / `dist/index.js` | P5 | ✅ 已验证（同形假包） |
| `./kit` | kit barrel | **P0b 就有**（源码级） | ✅ 已验证 |
| `./tabs` | `TabBar` / `DropMenu` | **P0b 就有** | [待验证] |
| `./tooltip` | `showTip` / `hideTip` / `subscribeTip`（**库独占**） | **P0b 就有** | ✅ 已验证 |
| `./icons` | `Icon` / `IconSprite` / `assertIconIds` / `SPRITE_STRING` | P3 | ✅（同形假包） |
| `./i18n` | `I18nProvider` / `useT` / `setKitI18n` | P3 | ✅ |
| `./host` | `UiHostProvider` / `useUiHost` / `UiStrings` / `UiHost` 类型 | P6.5 | [待验证] |
| `./tokens.css` / `./kit.css` | 两块样式（拼接由宿主做） | P2 | ✅ |
| `./geometry` | 纯几何 | **P4a 验证项 → P5 才进正式表** | [待验证] |
| `./bundle.css` | tokens + kit 拼接 | **P5 验证项**（P2 的拼接在**宿主**做，不需要这个入口） | [待验证] |
| `./sprite.svg` | **不提供** | —— | 与「sprite 必须内联」冲突（外链 `<use href="sprite.svg#id">` Chromium 不支持、`file://` 受限） |

> **P0b 只承诺子路径 `.` / `./kit` / `./tabs` / `./tooltip`**（源码级，不发 npm、不出 `dist`）。
> `./geometry`、`./bundle.css` 是 **P4a/P5 的验证项**，不写进 P0 的正式表 —— 免得让人以为 P0 要把发布面做全。
>
> 两条硬规则：① **`types` 条件必须排在 `import` 前面**（条件按顺序匹配）；② **各入口之间不得互相交叉 import**（否则宿主按模块裁剪时会连带把库的整棵子树拉回来，`docs/ARCHITECTURE.md` §4.4 的静态可达前提被破坏）。

#### B. 组件（**加了「来源入口」列**）

| 符号 | 来源入口 | 备注 |
|---|---|---|
| `Icon` / `Btn` / `TipHost` / `Overlay` / `Keep` | `kit` | `Overlay` 有 `full`（`.panel.panel-full`）变体 |
| `useBlankTap` / `useLandscape` | `kit` | hooks |
| `ScrubNum` | `kit` | 数字输入 + 拖动 + 算式键盘 |
| `Dialog` | `kit` | 16 props 全受控；DOM 契约见 `docs/UI.md` §2.1 |
| `Row` / `RowActions` / `ChipGroup` / `Segmented` / `Switch` / `NumberField` / `ColorField` | `kit` | 表单行六件套 |
| `HoverTip` / `hoverTipPos` / `useHoverTip` | `kit` | PC 鼠标悬停提示 |
| `setHoverTipsEnabled` / `useHoverTipsEnabled` / `hoverTipsEnabled` | `kit` | 由宿主 `main.tsx` 推入 |
| `setKitPcMode` / `kitPcOn` / `useKitPcMode` | `kit` | ⚠️ `setKitPcMode` 0 调用点（D3） |
| **`TabBar` / `DropMenu`** | **`tabs`**（**不在 `kit/index.ts` 里**） | `tabs.tsx:10-11` 只 import `react`/`react-dom`；`DropMenu` = portal + `position:fixed` |
| `Demo`（测试夹具） | **`demo`（不入公开面）** | 库测试渲染它；**不进 barrel、不进 `files`** |

> ⚠️ **`kit/index.ts` 的 25 个值里没有 `TabBar`/`DropMenu`**。所以库的 `src/index.ts` **必须新增**
> `export * from "./tabs";`，否则 `TabBar`/`DropMenu` 只在文件里、不在公开面上。

#### C. 类型导出（6 个）

`ScrubNumProps` / `HoverTipProps` / `HoverTipApi` / `DialogProps` / `RowProps` / `ChipOption`

#### D. 函数导出（P3/P6.5 新增）

`assertIconIds(ids)` / `IconSprite` / `SPRITE_STRING`（P3）、`I18nProvider` / `useT` / `setKitI18n`（P3）、`UiHostProvider` / `useUiHost`（P6.5）、`internal/expr` / `internal/scrub`（**不进 `exports`**）

### 3.3 库自己的测试基建（**新增小节**）

> 真正要重写的**不是测试内容，是编译编排**。本仓库这套**不能照抄**：

| 文件 | 关键配置 | 为什么不能照抄 |
|---|---|---|
| `tests/tsconfig.json`（79 行） | `rootDir: ".."`、`outDir: ".ts-out"`、`include` = **60 条显式 `../tests/*.ts*` 清单**、`module: commonjs`、`target: es2019` | ①**显式清单**：库没有 60 个测试文件，且每加一个测试要改两处（历史包袱）；②`rootDir: ".."` 的语义是「仓库根」，库的根是 `packages/deer-ui/`；③它**不含 `../src/**`** —— 靠 import 传递编译 |
| `tsconfig.json`（19 行） | `include: ["src"]`、`noEmit: true`、`moduleResolution: Bundler`、`noUnusedLocals: true` | `include: ["src"]` **看不到 `packages/deer-ui/src`**（P6 的漏检来源，R12-2） |
| `tests/run-tests.sh` | `node node_modules/typescript/bin/tsc.js` | **本机不存在**该文件（真路径 `lib/tsc.js`）。**新仓库别照抄** |

**库的 `tests/tsconfig.json` 设计（全文要点）**：

```jsonc
{
  "compilerOptions": {
    "module": "commonjs",          // 与本仓库一致：Node 直跑编译产物
    "target": "es2019",            // 与本仓库一致
    "lib": ["es2020", "dom"],
    "moduleResolution": "node",    // 与本仓库 tests 一致（不是 Bundler）
    "jsx": "react-jsx",            // ★ 必须：esbuild 按「源文件往上最近的 tsconfig」决定 JSX 变换
    "esModuleInterop": true,
    "skipLibCheck": true,
    "strict": false,               // 与本仓库一致；改 strict 是独立的一轮
    "rootDir": "..",               // ★ 库根 = packages/deer-ui/
    "outDir": ".ts-out",           // 与 rootDir 配对 → 产物落 packages/deer-ui/tests/.ts-out/
    "types": ["node"]              // 库测试用到 fs / path / __dirname
  },
  "include": ["../tests/**/*.ts", "../tests/**/*.tsx"]   // ★ 用 glob，不用显式清单
}
```

**三条「不要改回去」**：

1. **`include` 用 glob，不用显式清单**。本仓库那份 60 条清单是历史包袱（每加一个测试要改两处），**新仓库没理由继承**。这是**有意的偏离**，理由写进库 README。
2. **`rootDir` 必须指向库根**，否则 `../src/ui/kit/...` 这类路径的 emit 结构会与 `.ts-out/tests/...` 的期望路径**不一致** → 运行期 `Cannot find module`。
3. **`jsx: "react-jsx"` 必须在库的每个 `tsconfig` 里都有**。`AGENTS.md` §6.8 记过这个坑：构建目录里多出一份没有该字段的 tsconfig，esbuild 就退回经典 JSX，产出**引用全局 React 的白屏包**。`toolchain/check-bundle.mjs` 就是为此写的。

**库的测试运行**：

```sh
# 库自身的独立编译（G1）
node node_modules/typescript/lib/tsc.js -p packages/deer-ui/tsconfig.json --noEmit
# 库测试（G2）—— 产物路径由 rootDir/outDir 决定
cd packages/deer-ui && node node_modules/typescript/lib/tsc.js -p tests/tsconfig.json
node tests/.ts-out/tests/run-tests.js     # 期望末两行 assertions: ≥70 / ALL PASS（库侧实测 123）
```

**P6 的连带修改**：应用侧测试要读 `packages/deer-ui/src/**`（`ui-kit.test.tsx` 改读库目录），
所以 **`tests/tsconfig.json` 的 `include` 必须加库的 `src/`**（或让该测试改成 `require` 编译产物）。
**负例验收**：故意在库源码里写一个类型错误 → 应用侧 `tsc -p tests/tsconfig.json` **必须红**（证判据不是恒真）。

### 3.4 `UiHost` 适配层接口

#### 3.4.1 三条硬规则

1. **只放能力（动词 / 判定），不放业务状态（名词）。** 业务状态一律由宿主演成 **props**（`Snapshot` 就是现成的例子）。
2. **每个成员必须有现有的调用点。** 写不出调用点的一律不写进接口。
3. **`UiHost` 的成员不得只有「库内」用、宿主不用。**

> **表里没有这四项是因为消费者全在宿主侧**：`watchSafeArea`（`App.tsx` 自己订阅）、`setImmersive`（`io/fullscreen` 自己调）、
> `envInsets`（`io/safearea` 自己写 CSS 变量）、`hapticLogText`（诊断设施）。
> **它们不是漏写** —— 库不需要这些能力。

#### 3.4.2 接口本文（TypeScript，可直接抄）

```ts
/** deer-ui 适配层：通用 UI 库向宿主索要的**全部**能力。 */
export type Lang = string;
export interface Insets { top: number; bottom: number; left: number; right: number }
export interface OpenedFile { name: string; mime: string; bytes: Uint8Array }
export interface DecodedImage { w: number; h: number; px: Uint8ClampedArray }
export interface ConfirmAsk { msg: string; yes: string; no: string }
export interface TextAsk { title: string; value: string; ok: string; cancel: string }
/** 宿主没提供 t() 时的兜底（**只覆盖库自己产生的文案**，不含任何业务文案） */
export interface UiStrings { close: string; ok: string; cancel: string }

export interface UiHost {
  // 1. 文案
  t(key: string): string;
  lang: Lang;
  // 2. 反馈（纯副作用）
  toast(msg: string): void;
  haptic(tag: string, scale?: number): void;
  // 3. 反向询问（库 → 宿主，Promise 语义）
  confirm(q: ConfirmAsk): Promise<boolean>;
  prompt(q: TextAsk): Promise<string | null>;
  // 4. 平台判定
  pcMode(): boolean;
  nativeShell(): boolean;
  vibratorAvailable(): boolean | null;
  hapticReport(pref?: { on: boolean; len: number }): string;
  // 5. 文件 / 剪贴板 / 解码
  saveFile(name: string, mime: string, bytes: Uint8Array): Promise<boolean>;
  openFile(mime?: string): Promise<OpenedFile | null>;
  copyPng(canvas: HTMLCanvasElement): Promise<boolean>;
  decodeImage(bytes: Uint8Array, mime?: string): Promise<DecodedImage | null>;
  // 6. 全屏（三端行为不同，差异全部留在宿主）
  fullscreen: {
    supported(): boolean; isOn(): boolean; toggle(): void | Promise<void>;
    watch(cb: (on: boolean) => void): () => void;
  };
  // 7. 布局环境
  insets(): Insets;
  viewport(): { w: number; h: number };
  // 8. 极简持久化（只存「库自己的 UI 状态」）
  store: { get(key: string): string | null; set(key: string, value: string): void; remove(key: string): void };
}
/** 主题：**故意不进 UiHost** —— 靠 [data-theme] + CSS 令牌已零耦合。 */
```

#### 3.4.3 逐项对应表（每个成员都指出现有调用点）

| # | 成员 | 现有调用点 | 数量 |
|---|---|---|---:|
| 1.1 | `t(key)` | `src/ui/base.tsx:28`（`makeT(...)("calcHint")` 注入 `ScrubNum` 的 `padTitle`）、`src/ui/guide.tsx:48` | 2（库内） |
| 1.2 | `lang` | `SESSION.prefs.lang` 的 20 处：`App.tsx:232,280,290,2683,2939`、`base.tsx:28`、`canvas.tsx:22`、`changelog.tsx:721`、`color-drag.tsx:116`、`fxparam.tsx:61`、`guide.tsx:48`、`hold.tsx:210`、`modals.tsx:62,119,292,1322,1569`、`paste.ts:47`、`preview.tsx:26`、`refimg.tsx:32` | 20 |
| 2.1 | `toast(msg)` | `bridge.toast`（`io/bridge.ts:140`）在 `src/ui` 的匹配 **106** 处：`App 32 / modals 54 / paste 6 / timeline 6 / color-drag 2 / iso 2 / AiPanel 1 / refimg 1` | **106** |
| 2.2 | `haptic(tag, scale?)` | `SESSION.hapticTick` 的 **19** 处：`App.tsx:174,198,1160,1372,2103,2108,2142,2346,2363`、`timeline.tsx:80,173,183,247`、`canvas.tsx:119,137`、`color-drag.tsx:118`、`iso.tsx:42`、`refimg.tsx:52`、`AiPanel.tsx:320` | 19 |
| 3.1 | `confirm(q)` | `SESSION.askConfirm` 的 **5** 处：`App.tsx:1956`、`modals.tsx:735,1056,1063`、`AiPanel.tsx:752`；注册侧 `App.tsx:114,116` | 5 |
| 3.2 | `prompt(q)` | `SESSION.askText` 的 **2** 处：`App.tsx:1943`、`canvas.tsx:92`；注册侧 `App.tsx:115,116` | 2 |
| 4.1 | `pcMode()` | `isPc()`（`io/pcmode.ts:99`）的 **6** 处：`App.tsx:261`、`hold.tsx:73`、`timeline.tsx:70,112,166,237`。**另有 React 路**：`kit/pcmode.ts:28 useKitPcMode()`（由 `main.tsx` 推送） | 6 |
| 4.2 | `nativeShell()` | `isNativeShell()`（`bridge.ts:36`）的 **6** 处：`AiPanel.tsx:271,633`、`AiWindow.tsx:136`、`App.tsx:182,200`、`modals.tsx:443` | 6 |
| 4.3 | `vibratorAvailable()` | `canVibrate()`（`bridge.ts:206`）1 处：`modals.tsx:1170` | 1 |
| 4.4 | `hapticReport(pref)` | `hapticReport()`（`bridge.ts:194`）在 `src/ui` 的 **4** 处：`modals.tsx` 2 + `i18n.ts` 2 | **4** |
| 5.1 | `saveFile(...)` | `bridge.saveBytes`（`bridge.ts:217`）的 **9** 处：全在 `modals.tsx:61,236,729,783,788,794,795,802,1132` | 9 |
| 5.2 | `openFile(...)` | `bridge.openFile`（`bridge.ts:248`）的 **6** 处：全在 `modals.tsx:229,285,405,413,421,1135` | 6 |
| 5.3 | `copyPng(canvas)` | `writeClipboardPng`（`io/clipboard.ts:5`）的 **5** 处（含 import）：`App.tsx:280,290,1640,1641` | 4 真调用 |
| 5.4 | `decodeImage(...)` | **两条重复实现**：`modals.tsx:245-254`（`decodeStill`）与 `AiPanel.tsx:455-476`（`attachmentFromFile`） | 2 |
| 6.1 | `fullscreen.supported()` | `fullscreenToggleVisible()`：`App.tsx:992`（实现 `io/fullscreen.ts:54`） | 1 |
| 6.2 | `fullscreen.isOn()` | `isFullscreen`：`App.tsx:1022`。⚠️ `App.tsx:1046` 的 `fullscreenIcon(fsOn)` —— **图标名不是平台能力**，不进 host | 1 |
| 6.3 | `fullscreen.toggle()` | `toggleFullscreen()`：`App.tsx:1039` | 1 |
| 6.4 | `fullscreen.watch(cb)` | `watchFullscreen(setFsOn)`：`App.tsx:1023` | 1 |
| 7.1 | `insets()` | `detectInsets()`（`io/safearea.ts:27`）1 处：`modals.tsx:950`。**样式侧**另走 `--sat/--sab/--sal/--sar`（`safearea.ts:41-45` 写、`style.css` 消费） | 1 + CSS 变量 |
| 7.2 | `viewport()` | `app/uibar.ts:87` 的模块内 `viewport()`；消费者 = `aiWinDefaultLayout` / `clampAiWinLayout` / `aiBallDefaultPos` / `clampAiBallPos` | 4 消费者 |
| 8.1 | `store.*` | `localStorage` 直用 **~30** 处：`App.tsx:377,679,682,1130,1260,1273,1332,1381,1403,1420,1532,1562,1581,2372,2393,2417,2442`、`AiWindow.tsx:39,48`、`AiPanel.tsx:229,238`、`changelog.tsx:726,746`、`modals.tsx:1821,1830` | ~30 |
| — | `theme` / AI 端口服务 | **不设成员**：`src/ui` 内 `io/theme` import = **0** 处；`aiServer*` 只被 `AiPanel.tsx:607` 消费（业务，且 `AiPanel` 不进库） | 0 / 1 |

#### 3.4.4 宿主侧落点（**加了「哪一期」列**）

| 落点 | 动作 | 哪一期 |
|---|---|---|
| `src/main.tsx` | 建 `PixelCraftHost` 实现（包 `bridge` / `pcmode` / `fullscreen` / `safearea` / `localStorage`）+ 注入 `UiHostProvider` | **P6.5** |
| `src/ui/base.tsx:27-29` | `ScrubNum` 包装器改从 host 取 `padTitle`（或继续用 props，两者都可接受） | P6.5 |
| `src/app/session.ts:839,849` | `setConfirmAsk` / `setTextAsk` **保留**（`Session` 仍需要反向通道），类型抽到公共声明 | P6.5 |
| `src/io/bridge.ts` | **拆包**：能力子集（进 host 实现）与 AI 端口服务子集（`:91-124` 的 `aiServer*` + `:26-29` 的全局声明）分文件。**不能整份搬** —— 它混了三类东西：真·平台能力（`:36-276`）、AI 端口服务桥（`:91-124`）、诊断设施（`:178-203`） | P6.5 |
| 库侧 `host.tsx` | `UiHostProvider` + `useUiHost()` + `UiStrings` 英文兜底 | P6.5 |

### 3.5 `UiHost` 的接线期（**新增小节**）

**先回答「P0 需不需要它」**：**不需要，且不矛盾。** 实测 P0b 那 10 个文件对 host 的依赖是 **0**：

| 文件 | 它的全部 import |
|---|---|
| `kit/Dialog.tsx` | `react`(13) + `./primitives`(14) |
| `kit/Form.tsx` | `react`(5) + `./scrub`(6,7) |
| `kit/HoverTip.tsx` | `react`(10) + `./pcmode`(11) |
| `kit/pcmode.ts` | `react`(7) |
| `kit/index.ts` | 纯再导出 |
| `kit/scrub.tsx` | `react`(5) + `react-dom`(6) + `engine/expr`(7) + `engine/scrub`(8) → **P0b 内联为 `./internal/*`** |
| `kit/primitives.tsx` | `react`(5) + `../tooltip`(6) + `./HoverTip`(7) → **P0b 改成 `./tooltip`** |
| `kit/demo.tsx` | `react`(9) + `react-dom/client`(10) + `./index`(11) |
| `tabs.tsx` | `react` + `react-dom`（`tabs.tsx:10-11`） |
| `tooltip.ts` | **0 个 import** |

⇒ **P0b 可以完全不谈 host**，这与它的验收（应用零改动 + 库测试全绿）不冲突。
**但接线不能悬空**：`UiHost` 是 **P6.5** 的交付物。

**接线设计（指派给 P6.5）**：

```tsx
// 库侧：packages/deer-ui/src/host.tsx
const Ctx = createContext<UiHost | null>(null);
export function UiHostProvider({ host, strings, children }: {...}) { /* 提供默认 UiStrings 兜底 */ }
export function useUiHost(): UiHost { /* Ctx 为 null 时返回一个「全兜底」的实现，不抛 */ }
// 非 React 路径（tooltip store、纯函数工具）：由 provider 挂载时写入模块级单例
export function setHostSingleton(h: UiHost | null): void
```

应用侧：`src/main.tsx` 建 `PixelCraftHost`，用 `<UiHostProvider host={...}>` 包住 `<App/>`。
`I18nProvider` 与之同构（P3 只出库侧定义，**应用侧注入落点也是 P6.5**）。

**两个现成的先例**（所以这不是新机制）：

| 先例 | 位置 | 形态 |
|---|---|---|
| PC 模式推进库 | `src/main.tsx:17-20` 调 `setHoverTipsEnabled(...)`；`kit/pcmode.ts:28` 用 `useSyncExternalStore` 订阅 | 「宿主推、库订阅」 |
| 确认框反向通道 | `src/ui/App.tsx:114-116` 注册 → `src/app/session.ts:839,849` 持有函数指针 | 「库问、宿主答」 |

**P6.5 的完成定义**：`PixelCraftHost` 实现存在 + provider 接进 `main.tsx` + **至少 2 个真实消费者**（`scrub` 的 `padTitle`、`HoverTip` 的 PC 判定是现成先例）+ `tests/host.test.tsx`（假 host 注入、无 host 时兜底不抛）。

### 3.6 四件事的策略

| 主题 | 策略 |
|---|---|
| **主题与令牌** | **主题不进 `UiHost`**。宿主在 `<html>` 上切 `data-theme`，库只消费 `[data-theme="light"]` 的令牌覆盖。令牌层（`:root` 143 个 + 浅色覆盖 77 个）**整份进库**（`tokens.css`） |
| **样式** | **先划边界（P1）再拆（P2）**。tokens + kit 规则进库，shell + canvas-hud 留应用；构建时**源码级拼接成单一 `style.css`**；**JS 里一行 CSS import 都不写**（`import "…css"` 会让 esbuild 多吐一个 `.css`，破坏「单 app.js + 单 style.css」产物契约） |
| **图标** | **机制进包、数据留宿主**：库给 `Icon`、`IconSprite`、`assertIconIds()`、`SPRITE_STRING`。**122 个 symbol 与 `feature-icons.ts` 的分组留宿主**。**sprite 必须内联**（外链 `<use href="sprite.svg#id">` Chromium 不支持、`file://` 受限）。库当前用到的 id 清单（宿主必须提供）：`kit/Dialog.tsx` → `i-x`；`kit/demo.tsx` → `i-eye/i-layers/i-pencil/i-check/i-x/i-eraser/i-bucket/i-picker/i-line/i-rect/i-select/i-grid/i-lock/i-star`（**共 15 个 id**）→ 这就是「宿主必须提供」的机器判据（`kit.icon.contract-ids`） |
| **i18n** | **库不自带字典**。库只认 `TFn = (key: string) => string`；叶子控件继续收 props（现状已是）；**库自己产生的文案**走 `host.t` 或 `UiStrings` 兜底（英文默认）。键空间划分：**库不定义任何业务键** |

> **i18n 键的数法本身就是一条坑（已核实）**：zh / en **各 845 个顶层键、1,136 条叶子**，11 个命名空间容器。
> `src/ui/i18n.ts` 的 `zh` / `en` **是模块私有、未导出**的，编译产物 `tests/.ts-out/src/ui/i18n.js` 的导出面里也没有字典对象 ——
> 要数键必须**包一层 `new Function` 取出模块内部那两个 `const` 再求值**。
> **按行计数会数出 347 —— 那是错的**，因为实测有 **185 行把多个键写在同一行**（例：`undo, redo, save, open, menu` 五个键同一行）。
> **185 行 ⇒ 行计数法少一半以上，而且不报错、只是静默偏小。**
> **为什么这条要写进方案**：库独立之后，任何「重新数键 / 对账库的键 ⊆ 宿主字典」的人都会撞上同一个坑。
> **凡涉及 i18n 键的断言，一律走求值口径，并在断言名或注释里写明这一点。**
> 注：`tests/i18n.test.ts` 现有实现走的正是 `makeT` 求值（不是行计数），与这条口径一致。

### 3.7 依赖方向规则（违规怎么被卡住）

> **红线**：「`deer-ui` 不认识 PixelCraft。任何 PixelCraft 的业务名词（帧 / 图层 / 标签 / 选区 / 画布 / AI 工具 / 等距 / 导出格式 / 引导步骤 / 版本号）出现在库的类型签名里，这条就破了。」

| 规则 | 落地方式 |
|---|---|
| 库 `src/**` 的 import 白名单 = `react` / `react-dom` / `react-dom/*` / `./*` / `../*`（库内部） | **目录白名单 + import 白名单的静态断言**。模板已存在：`tests/ui-kit.test.tsx:184-197`（**实测**：白名单 8 项、黑名单正则拦 `../{singleton,i18n,app,io,render,tools}`；**它只扫 import 说明符，不看全局 API 调用**）。**P0b 后白名单收成前 4 项** |
| 应用 `src/**` 不得出现库 barrel 里的同名实现 | `scripts/check-ui-fork.mjs` **按符号白名单精确匹配**。**不能**写成「扫 `src/ui` 找组件定义」—— `modals.tsx` 有 21 个弹窗、`App.tsx` 有浮动球，第一天就红 |
| 依赖方向检查脚本 | **复用 `docs/ROADMAP.md` S1-8 要新增的「依赖方向检查脚本」**，其白名单逻辑与本条同一种东西。**建议把库的纯度断言挂到同一个脚本上** |
| 与既有红线的语境一致 | `docs/ARCHITECTURE.md` §6 红线 5「`ui/kit` 这类呈现组件不进 server」；红线 8「模块之间不得 import 实现文件，只允许 `import type`」—— **与库的纯度规则同一个思路** |

---

## 4. 工程化

### 4.1 构建与产物

| 项 | 结论 |
|---|---|
| 编译器 | **`tsc -p tsconfig.build.json`，一次同时产出 ESM（逐文件）+ `.d.ts`**；不 bundling、不上 tsup/rollup |
| **不发 CJS** | 消费者只有三类（宿主 esbuild IIFE / 库自己的示范页 / 将来第三方 React 项目），全是打包器或浏览器；双包危害 + 产物翻倍，收益为零 |
| 相对 import 后缀 | **(b) 声明 bundler-only**（默认，见 Q4）。必须在 README + `package.json` 的 `description` 里明确声明 —— **两条路都可行，但不能留默认** |
| `target` | 库用 **ES2020**，宿主再降 `--target=es2019` |
| `strict` | **`false`（与宿主一致）+ `noUnusedLocals: true`**；改成 strict 是独立的一轮 |
| 库内「死导出」 | 不用 `noUnusedLocals` 兜（barrel 再导出会红），改用 **`ts-prune`**（仓库已有该 devDependency） |
| 产物契约 | **单 IIFE + 单 CSS + 内联 sprite + 无外联** —— **三端不需要任何按端分支** |
| **P0b 不产出 `dist`** | 写死（N17）。P0b 的 `package.json` 只是「让库目录自成一个包」的声明，不做 emit |

### 4.2 发布与版本

- **包名**：npm 上**裸 `deer-ui` 已被占用**（latest `1.1.10`，作者 `bear-ui`）→ 只能 `@deerluu/deer-ui`（scope 名下空闲）或 `deerui`。**GitHub 仓库名可以就叫 `deer-ui`**（与 npm 包名不冲突）。
- **v0 不发 npm**：消费者的真实需求只有一个；发出去是**永久承诺**；容器出包环境能不能访问 npm 是未验证变量，而 committed tarball 把这条变量消掉。`exports`/`types`/`peerDependencies` **照写**，将来 `npm publish` **零改动**。
- **版本**：`0.x.y` 起步，API 冻结前不承诺 semver；`exports` 的入口集合 = 公开 API；版本号**只有 `package.json` 一个来源**；**不引 changesets / semantic-release**。
- **`peerDependencies`**：**`^18.3.0`**（不写死补丁号、不宣称支持 19），并**必须加一条硬约束：React 单实例** —— 两份 = `Invalid hook call` / `useSyncExternalStore` 订阅表分裂。
- `"sideEffects": ["*.css"]`（**不写 `false`**：CSS 有副作用）、`"files": ["dist","README.md","LICENSE"]`、`"publishConfig": {"access":"public"}`、`prepack` 跑 `check:exports` + `check:size` + `check:no-cdn`。

**0.x 的破坏性变更如何通知应用**：

| 环节 | 做法 |
|---|---|
| 库侧 | `CHANGELOG.md` 用 Keep a Changelog 形态，**每个 breaking 单列 `### Breaking` 段**（写明「改了哪个导出 / 哪个 props 必填性 / 哪个 DOM class 名」），**不写中文用户文案** |
| 应用侧 | **每个 breaking 必须在应用侧产生一个独立提交**（`chore(ui): 同步 deer-ui vX.Y.Z（源 <库 sha>）`），提交信息里带**库的 sha**而不是库版本号（避免应用历史里出现两套版本语义） |
| 升级 checklist | ① 跑 `node tests/.ts-out/tests/run-tests.js` → `≥ 8090 / ALL PASS`；② `sh scripts/build-web.sh` + `node toolchain/check-bundle.mjs app2/www/js/app.js`；③ 体积闸门 ≤ 基线 + 2 KB；④ `tests/guide-anchors.test.ts` + `tests/ui-tokens.test.ts` 全绿（DOM class 名与令牌是 breaking 的高危面） |
| 允许的前提 | **0.x 期间允许直接改签名**（不承诺 semver），但上面的 checklist 一条不能省 |

### 4.3 CI

两个 workflow：`ci.yml`（typecheck / test / build / `check:exports` / `check:size` / `pack --dry-run` / `check:no-cdn` + 两条专治最贵坑的断言：`! grep -rl "react-dom.development" dist/`（未打进 React）、`! grep -rEo "https?://..." dist/`（无外链，`www.w3.org/2000/svg` 豁免））、`pages.yml`（示范页，**无 CDN、全本地资源**）。

> 与 PixelCraft 的差异：deer-ui 的 `docs/` 由 CI 生成后上传，**不建产物分支** —— 示范页不是交付物，**没有 md5 三方一致性要求**。

### 4.4 测试策略

| 层 | 内容 | 必要性 |
|---|---|---|
| **契约层** | `renderToStaticMarkup` 断言 markup/class/aria + 自写 `common.ts`（`ok`/`eq`）+ 汇总 runner | **必须有** |
| **规范层** | 静态扫描：①kit 纯度 ②令牌契约 ③图标 id 组内唯一 ④**barrel 导出面快照** ⑤**库内不得自判 PC/主题/安全区** | **必须有** |
| **浏览器冒烟** | CDP 无头 Chromium 打开示范页 → 「无 console 错误 + `#root` 有子节点 + 每个控件 `getBoundingClientRect()` 非零」。照抄 `toolchain/stress-stroke.mjs` 的形态 | 建议有 |
| **库测试自带 DOM 桩** | 库的 runner **不得**依赖应用 `session.test` 的 `stubEnv()`（**实测**：`uibar.test` 单跑报 `window is not defined`，全套里能过）。输出里要打 `assertions: N / ALL PASS`，CI 断言 **N ≥ 70**（库侧运行合计实测 **123**），**不只看「没报错」** | 必须有（R9） |

**计数纪律**：

```
应用侧断言数(app) = 8090 - 已迁出的应用自有断言 + 新增的「防分叉 / 对账 / 契约」断言
库侧断言数(lib)   = 迁入的库断言 + 库新增断言
约束：app ≥ 8090（**应用侧一条不许净减**），且每个迁出的断言在库侧有同名或同义替代
      「迁出」必须有台账：本文逐条列 名字 → 旧位置 → 新位置
```

> **P4a 是唯一的例外**：它把 `orb.test.ts` / `pie.test.ts` / `guide-layout.test.ts` 整体搬走，
> 应用侧会**净减**这部分 —— 台账必须写清「库侧新增 = 应用侧净减」，且**应用侧总数仍 ≥ 8090**（由新增的防分叉/对账断言补回）。

**每期的报数命令**（**必须逐期跑**）：

```sh
node tests/.ts-out/tests/run-tests.js          # 末两行：assertions: N / ALL PASS
node tests/.ts-out/tests/run-tests.js | Select-String '^ok\s+ui\.'   # 库侧相关前缀
```
> `--require %TEMP%\deerui-hook.cjs` 是为了**按段落分布**输出，纯跑不需要 hook。

### 4.5 体积预算

| 项 | 值 |
|---|---|
| 基线 | `app.js` = **1,334,285 B**，md5 `a15d5b1e626edfaf526c28694bed4b86` |
| 闸门阈值 | **≤ 基线 + 2 KB** |
| **真约束是「防重复」不是「省体积」** | React+ReactDOM 地板 = **142,547 B（10.7%）**，`kit/` 全部源码 = **36,493 B** ⇒ **一次 React 重复抵消四次抽库** |
| 体积闸门的第二价值 | **架构违规的自动探针**：抽库后若涨 30 KB+，基本只有一个解释 —— **有代码同时存在于宿主与库里**（`tooltip` / `engine/{expr,scrub}` / 令牌 CSS 各留一份） |
| 产物级断言 | ① `:root{` 与 `[data-theme="light"]{` 在**库段**里各恰好一次（`check-dist.mjs`，**这是库自身的产物判据，不是「数子串」**）；② **拼接产物里「库段」必须出现在「应用段」之前**（`scripts/build-css.mjs` 写完就自检偏移量，`tests/ui-css.test.ts` 的 `uicss.artifact.order` 再判一次） |

> ⚠️ **不能按子串出现次数判「某选择器在产物里出现了几次」**（初稿这里写过「`:root{` 与 `.dlg{` 各恰好一次」）：
> 库 CSS 里 `.dlg` / `.panel` / `.rowlabel` / `.btn.off` / `.panel-mask,.dlg-mask` 都是「基础规则 + 变体 / 动画」的
> **合法重复**，`grep -c ".dlg{"` 会数出「多了」的假红，而真正的重复（同一「选择器 + 声明」出现两次）反而漏掉。
> **正确口径是按「选择器 + 声明」的扁平规则多重集合比**（相等 = 视觉零变化，允许改顺序），实现见
> `tests/css-rules.ts`（`rulesBag` / `bagHash` / `bagDiff`）。产物必须等于 `库段 ∪ 应用段`，**不许有第三种来源**。

> **必须写下这条**（免得后面有人「顺手优化」）：**抽库的目标不是变小，是「不变大 + 边界变清」**。`docs/ARCHITECTURE.md` §4.8 已写死「不要为了省 50 KB 做这件事」。

### 4.6 本仓库迁移期怎么消费它

> **用 `file:vendor/deerui-<version>.tgz`（把打好的 tarball 提交进 `vendor/`）。**
> **明确不选**：`npm link`、`file:../deer-ui`（目录）、workspace、把源码 vendored 进 `src/`。

| 组 | 方式 | 结果 |
|---|---|---|
| A | `file:../pkg`（npm 装成**目录 junction**）+ 宿主 esbuild 默认参数 | ❌ **构建失败**：`Could not resolve "react"` |
| B | 同上 + `preserveSymlinks: true` | ❌ 失败（`Could not resolve "scheduler"`）→ 靠加 flag 绕过 = 长期隐患 |
| C | 同上 + `nodePaths: [宿主 node_modules]` | ✅ 258,014 B，但**要改宿主构建脚本** → 只作应急 |
| **D** | **`npm pack` → `file:…tgz` 安装**（装成**真目录**）+ 默认参数 | ✅ **258,054 B，React 输入全部来自宿主 = 单实例** |
| D-lock | 同上看 lockfile | `"integrity": "sha512-…"` → **APK 可重现**（目录形式只有 `"link": true`） |
| F | 只要 react + react-dom | **142,547 B** = React 地板价 |

**为什么不把源码 vendored 进 `src/`**：① `tests/hans.test.ts` 从仓库根**递归** walk，`SKIP_DIR` 硬编码且**不含 vendor** → 库代码注释进入简体中文校验射程，一条繁体字就让 8090 条变红；② 测试工具会把库代码当自家代码（`guide-anchors` 扫 `src/ui/*`、`ui-tokens` 解析 `src/ui/style.css`）。

**必须明说一条**：`AGENTS.md` §5.1b 反对的是「**1.1 MB 单行 JS** 进源码分支」；tarball 是**压缩后的依赖**（预计 50–150 KB），**性质不同**。

### 4.7 双仓协作（**新增小节**）

| 项 | 规则 |
|---|---|
| **定性规则** | 「**DOM 契约 / 控件行为 / 无障碍属性**」→ **库仓库**；「**业务文案 / 数据 / 布局位置 / 什么时候显示**」→ **应用仓库** |
| **复现要求** | **先在本仓库复现**，确认与宿主无关（例如「同一控件在库的 `examples/standalone.html` 里也错」）后再搬到库仓库。这条避免把「应用接错了」记成库的 bug |
| **issue 模板** | 两仓各一份。库侧要求附「最小复现（示范页可复现）+ 期望的 markup」；应用侧要求附「截图 + 操作路径 + 是否在 `examples/standalone.html` 能复现」 |
| **PR 分工** | 库侧改动**只能在库仓库**做，合并后由同步脚本带进应用；应用侧**禁止**直接改 `vendor/` 里的 tarball 内容或（P5 后）`packages/deer-ui/` 的副本 |
| **评审要求** | 库的一次改动同时影响两个仓库 → `CONTRIBUTING.md` 写死「改库必须走库仓库 + `scripts/deer-ui-vendor.sh`」；库 PR 模板要求跑应用侧 checklist（§4.2 的 4 条） |
| **落点** | 库仓库 `CONTRIBUTING.md`（**进 P5 的文件清单**）+ 应用侧 `docs/UI.md` 的「库边界」章留一行指向它 |

**供应链与许可**：

| 项 | 结论 |
|---|---|
| 运行时依赖 | **零**（除 `react` / `react-dom` peer）。这是最有效的供应链缓解 |
| devDependencies | `typescript` / `esbuild` / `@types/react*` / `ts-prune` —— 全部 MIT/Apache-2.0 系。**P5 的 CI 加一条 `npm ls --prod` 为空**（证明零运行时依赖）+ 生成一份许可清单 |
| v0 的取舍 | v0 不发 npm → 供应链暴露面 = 0。**许可审查安排在 P5**，理由写清即可，不必在 P0–P4 做 |
| **`LICENSE` 与 `package.json` 的 `license` 字段** | **属于 P0b 交付物**（`package.json` 是 P0b 的文件）。**默认走 `"private": true` 且不写 `license` 字段**（v0 不发 npm）；真要发布时再定 —— 见 Q14 |

---

## 5. 分期迁移

### 5.0 每期共用的验收与纪律

- **每期可测验收**：`node tests/.ts-out/tests/run-tests.js` → `assertions: ≥ 8090 / ALL PASS` + 该期专项断言。
- **回滚点**：每期**一个提交**（`AGENTS.md` §5.5）；回滚 = `git revert` 那一个提交。**凡要删文件的期，先把「等价实现已在新位置」跑绿再删**。
- **每期结束必须报三个数**：断言数 / `src/ui` 行数 / `App.tsx`+`modals.tsx` 行数。
- **代价值**：S（0.5–1 人日）/ M（1–3）/ L（3–5）/ XL。

### 5.1 分期总表

见 §0.2。补充两列：

| 期 | 前置 | 回滚成本 |
|---|---|---|
| P0a | 无 | 极低（只加测试） |
| P0b | P0a | 极低（只新增目录） |
| P1 | 无 | **最低**（不改任何声明） |
| P2 | **P1 + Q5 已拍板** | 低 |
| P3 | P0b | 低 |
| P4a | P3（门禁先上线更稳） | 低 |
| P4b | **P3 + `uibar.ts` 拆分完成** | 中（改了应用源码） |
| P5 | P2–P4 | 低（不影响应用） |
| P6 | P5 | **高**（应用第一次真消费库） |
| P6.5 | P6 | 中 |
| P7 | P6.5 | 中（删目录） |

### 5.2 各期明细

#### P0a（A0）— 零复制的前置探针

| 项 | 内容 |
|---|---|
| **落点** | **只加测试，不新增目录**：`tests/ui-kit.test.tsx` 加 A0-1/A0-2/A0-3 三条判据（或新建 `tests/ui-kit-contract.test.ts` 并登记进 `tests/tsconfig.json` + `tests/run-tests.ts`） |
| **验收** | ① `assertions: ≥ 8090` 且**新增** ≥ 3 条；② A0-1 的**已知越界输出**必须逐条列出（`primitives.tsx:6 → ../tooltip`、`scrub.tsx:7 → ../../engine/expr`、`scrub.tsx:8 → ../../engine/scrub`），并有一条 TODO 断言记录「这 3 处在 P0b 消除」；③ A0-2 的 barrel 快照列出 **25 值 + 6 类型**；④ A0-3 对当前代码**不报违规**（`primitives.tsx:12,14` 是 `(orientation: landscape)` **不是 PC 判定**；`localStorage` 在 kit 内 0 处） |
| **回滚** | 一个只改测试的提交 |
| **坑** | **不要为了让 A0 绿而把白名单写成 8 项**。A0-1 的价值就在于它**会指出越界**；把「已知 3 处越界」写成显式断言，而不是靠白名单放行 |

#### P0b（甲案）— 最小可验证的一刀

| 项 | 内容 |
|---|---|
| **第一期要动的文件** | **只新增**（应用侧 **0 个文件改动**）：<br>`packages/deer-ui/src/{primitives.tsx, scrub.tsx, Dialog.tsx, Form.tsx, HoverTip.tsx, pcmode.ts, index.ts}`（= 今天 `src/ui/kit/` 的 7 个源文件，**逐字节复制**）<br>`packages/deer-ui/src/tabs.tsx`（从 `src/ui/tabs.tsx`）<br>`packages/deer-ui/src/tooltip.ts`（从 `src/ui/tooltip.ts`）<br>`packages/deer-ui/src/demo.tsx`（从 `src/ui/kit/demo.tsx`，**测试夹具**，见 §2.5）<br>`packages/deer-ui/src/internal/{expr.ts,scrub.ts}`（从 `engine/{expr,scrub}` 复制纯函数）<br>`packages/deer-ui/src/index.ts`（barrel；**必须新增 `export * from "./tabs"`**）<br>`packages/deer-ui/package.json`（`private: true`、peerDeps）<br>`packages/deer-ui/LICENSE`<br>`packages/deer-ui/tsconfig.json`、`packages/deer-ui/tests/tsconfig.json`、`tests/common.ts`、`tests/run-tests.ts`、`tests/ui-kit.test.tsx`（副本，改路径） |
| **要改的 import（只在副本内）** | `primitives.tsx` 的 `../tooltip` → `./tooltip`；`scrub.tsx` 的 `../../engine/expr` → `./internal/expr`、`../../engine/scrub` → `./internal/scrub`。**这一步就是「库成立」的判据**：副本内任何 `../..` 都是失败 |
| **验收 ①（独立编译）** | `node node_modules/typescript/lib/tsc.js -p packages/deer-ui/tsconfig.json --noEmit` → **退出码 0**（⚠️ **不是** `node_modules/typescript/bin/tsc.js`，那在本机不存在） |
| **验收 ②（独立跑测试）** | `cd packages/deer-ui && node node_modules/typescript/lib/tsc.js -p tests/tsconfig.json && node tests/.ts-out/tests/run-tests.js` → 末两行 `assertions: ≥ 70` / `ALL PASS`（库侧运行合计实测 **123** = 搬入 62 + 库自身 A0/基建 61，见 §10）。**70 条的实测分布**（按运行期断言名重数）：`ui.dialog.*` 13 / `ui.htip.*` 13 / `ui.kit.*` 12 / **`ui.demo.*` 6** / 表单行（`ui.row*` 5 + `ui.chips*` 5 + `ui.switch*` 3 + `ui.segmented*` 2 + `ui.numberfield` 1 + `ui.colorfield*` 2 + `ui.rowactions` 1）19 / `ui.dropmenu.*` 3 / `ui.overlay*`（含 `-wiring`）2 / `ui.btn` + `ui.icon` 2。**排除 `ui.demo.*` 是 64** —— 本方案**不排除**它（见 §2.5）。<br>**建议把「按小节报数」做成库 CI 的一行命令**，否则「达标」靠拍脑袋 |
| **验收 ③（纯度收紧）** | 库内 `src/**` 的 import 白名单 = `react` / `react-dom` / `react-dom/*` / `./*` / `../*`（库内部）。**不再有 `../tooltip`、不再有 `../../engine/*`** —— 这正是 P0b 要证的 |
| **验收 ④（应用不动）** | `node tests/.ts-out/tests/run-tests.js` → **`assertions: 8090` / ALL PASS**（P0b 不改应用，必须一条不差） |
| **验收 ⑤（逐字节相等）** | 副本与应用原件**逐字节相等**。**覆盖 9 个文件**（`kit/` 7 + `tabs.tsx` + `tooltip.ts`）；`demo.tsx` 同样比对 = **共 10 个**。用 `git hash-object` 或哈希比对，差异必须为空 |
| **验收 ⑥（测试基建）** | 库的 `tests/tsconfig.json` 按 §3.3 的设计（`rootDir: ".."` 指向库根、`outDir: ".ts-out"`、**`include` 用 glob 不用显式清单**）；**负例**：故意在库源码里写一个类型错误 → 库的 `tsc -p tsconfig.json --noEmit` **必须红** |
| **回滚点** | 一个提交：`chore(ui): 复制 kit + tabs + tooltip + demo 到 packages/deer-ui 并让它在仓库内独立编译`。**只新增目录，风险极低** |
| **坑** | ① 库每个 `tsconfig` 的 `jsx` 必须是 **`react-jsx`**（esbuild 按「源文件往上最近的 tsconfig」决定 JSX 变换；写错会静默退回经典 JSX → **引用全局 React 的白屏包**，`AGENTS.md` §6.8 已踩过一次）；② `Icon` 只渲染 `<use href="#i-x">`，**库的 DOM 契约依赖宿主提供 sprite symbol** → 写进库 README（P3 变机器判据）；③ **`demo.tsx` 的双副本窗口从本期开始**，记账在案（§2.5） |

#### P1 — 给样式表划物理边界

| 项 | 内容 |
|---|---|
| **目标** | 让「哪条规则属于库 / 属于应用」在**文件里有物理边界**（每段连续、可被脚本机械切出），且**行为与视觉零变化** |
| **落点** | 只动 `src/ui/style.css`（**不改内容**）：① 把带编号横幅补全成 5 段（`1/5 tokens` / `2/5 pc-density` / `3/5 kit-controls` / `4/5 app-shell` / `5/5 canvas-hud-motion`），段头写清「归属：库 / 应用」；② **段内只做重排**（把第二簇控件规则聚回 `3/5`，**注意 `.btn` 还在 `:645` 以合并规则出现、`.rowlabel` 在 `:219` 与 `:728` 两处**），**逐条移动、不改一行声明**；③ 段头加**机器锚点** `/* deer-ui:kit-controls:start */` / `:end */` |
| **验收 ①（等价，核心判据）** | 用等价脚本（**先把 `tests/ui-tokens.test.ts:79` 的 `rules()` 提成共享工具模块或导出它** —— 它现在是**模块私有**，直接 import 不到）对重排前后做 `{sel → decls}` 的**多重集合相等**比较，**差异必须为空** |
| **验收 ②** | `assertions: ≥ 8090`，其中 `uitoken.*` **17 条一条不少**（若切片锚点必须改，同时改断言里的锚点字符串，**并把新旧锚点写进提交信息**） |
| **验收 ③** | 暗/浅两主题各看一遍（人工项） |
| **回滚点** | 一个纯重排提交：`refactor(ui): 给 style.css 划定 5 段物理边界（仅重排+横幅，声明零改动）`。**全方案里最安全的一期** |
| **坑** | ① 层叠顺序：`.panel` 与 `.panel.panel-full` 必须保持**相邻且原顺序**；② `@media` 块内也有控件规则，**不要挪出 `@media`**；③ `1b/5 PC 模式`（`:99` 起）的覆写里有 `.btn/.chip/.tab/.dlg*` 的 PC 尺寸 —— **属宿主密度覆写，不要塞进库段**；④ **别顺手合并相同声明或去重** —— 那已经不是重排，等价脚本会红 |

#### P2 — 拆样式

| 项 | 内容 |
|---|---|
| **前置（硬）** | **Q5 必须在 P1 结束前拍板，否则本期的验收写不出来** |
| **落点（库）** | `packages/deer-ui/src/{tokens.css,kit.css}`：`:root` 令牌（今天 `style.css:5-97`）+ kit 控件规则（`.btn*`、`.panel*` 抽屉部分 `195-206`、`.rowlabel/.row-note/.row-actions` `208-219`、`.dlg*` `244-261`、`.tabs/.tab/.chips/.chip/.sw` `285-298`、`.htip*`、`.dropmenu*`、`.menuitem`、`.textinput` `516`） |
| **落点（应用）** | `src/ui/style.css` 删掉这些块，保留 shell + 时间轴（397–802）+ 动画（803–1454）+ 画布 HUD / 引导 / 业务弹窗自有类 |
| **构建** | 按 **Q5 的默认方案（第三方案）**：保留 `:root` 与 `2/5 base` 锚点不动、**库 CSS 只做尾部注入**、**测试一行不改**。**不要用 esbuild 的 CSS 入口**（改成两条 `<link>` 会让 `file://` 下多一次请求并改变层叠顺序，`--z-guide`/`--z-mask` 这类顺序敏感令牌都在里面） |
| **验收 ①** | `assertions: ≥ 8090` 且 `uitoken.*` **17 条一条不少** |
| **验收 ②（位置，新增）** | **产物级断言：拼接产物里「库段」必须出现在「应用段」之前**（用 P1 的机器锚点判位置）。原来「库在前、应用在后」这条**没有任何断言的比对对象是顺序** |
| **验收 ③** | `node toolchain/check-bundle.mjs app2/www/js/app.js` 通过；产物里 `:root{` 与 `.dlg{` **各恰好一次**（拼接脚本必须**幂等**，同一段只注入一次） |
| **验收 ④** | `node toolchain/devserver.js` + 打开 8090，暗/浅两主题各看一遍弹窗、表单行、chips、开关（**人工项，必须写进验收但不作为自动门禁**） |
| **回滚点** | 一个提交：`refactor(ui): 令牌与控件规则拆进 deer-ui，构建拼接为单一 style.css` |
| **坑** | ① 安全区变量 `--sat/--sab/--sal/--sar` 在 `:root`（`style.css:16-19`）由 `src/io/safearea.ts:41-45` 覆写 —— **库只声明带 `env()` 兜底的默认值，写入者永远是应用**；② `1b/5 PC 模式` 的覆写**留在应用**，并在库文档写明；③ **第三方案下最容易踩的**：库 CSS 在尾部注入后，`uitoken.no-raw-colour-in-shell`（`:140-147`，判 `SHELL` 名单里的选择器不得写裸色）会把**库段的规则也一起看**（因为 `body` 切片到文件末尾）→ 库 CSS **不得出现 `SHELL` 名单里的选择器 + 裸色值**，这一条要写进库的 `tokens.test.ts` |

#### P3 — 图标契约 + i18n 注入 + 防分叉门禁

| 项 | 内容 |
|---|---|
| **库侧** | `src/icons/index.ts`（`Icon` / `IconSprite` / `assertIconIds` / `SPRITE_STRING`，**不新增 sprite 文件**避免两份）；`src/i18n.tsx`（`TFn` / `I18nProvider` / `useT` / `setKitI18n` + 英文默认值） |
| **应用侧** | **零改动**：`feature-icons.ts` 继续留应用；`app2/www/index.html` 的 122 个 symbol 继续由应用提供；`src/ui/i18n.ts` 继续留应用 |
| **门禁（本期上线）** | `scripts/check-ui-fork.mjs` + `tests/ui-fork.test.ts` 四条断言：`nofork.local-implementations` / `nofork.kit-reexport-only` / `nofork.kitdir-file-count` / `nofork.library-no-app-imports` |
| **验收 ①** | 库测试新增：`kit.icon.snippet-has-i-x`、**`kit.icon.contract-ids`**（库源码里每个 `#i-…` 都在 `SPRITE_SNIPPET` 里；**清单见 §3.6，本轮实测 15 个 id**）、`kit.i18n.default-lang`、`kit.i18n.override` |
| **验收 ②** | 应用侧 `icons.test.ts` **≥ 86 条一条不少**；`i18n.test.ts` **≥ 8 条一条不少**（**修正**：原写「≥ 34」是错数 —— **34 其实是 `expr` 小节的条数**；实测 `i18n` 小节 = **8**，见文首口径说明与 §10） |
| **验收 ③（对账）** | **跨库对账断言** `kit.i18n.keys ⊆ 应用字典`：库的每个键在 `src/ui/i18n.ts` 里 zh/en 各一条。**必须走求值口径**（见 §3.6 的数法坑），不许写成行计数版 |
| **验收 ④（门禁负例）** | 故意在 `src/ui/` 下新建一个 `Dialog.tsx` → `node scripts/check-ui-fork.mjs` 退出码 **1** |
| **验收 ⑤（扫描面）** | `tests/i18n.test.ts` 与 `tests/guide-anchors.test.ts` 的**扫描根必须覆盖库源码**，并**在断言名里写清扫描根**（例：`i18n.sources.covers-kit`）。理由见 R12-3 / R12-4 |
| **回滚点** | 三个小提交（图标契约 / i18n 注入 / 门禁），互不依赖 |
| **坑** | ① `tests/icons.test.ts` 的 `icons.sprite.size` 要求 `syms.length >= 90`：库的 snippet **不得被那个 walk 扫到**（它只扫 `src/` 下的 `.ts/.tsx`）→ snippet 写成**库内的 TS 常量**；② 反过来，一旦库 `.tsx` 引用 `#i-…`，那条 `icons.all-referenced-defined` **不会扫到它**（walk 根是 `src/`）—— **这是「不红但更危险」的漏网**，必须靠 `kit.icon.contract-ids` 兜住 |

#### P4a — 第 2 刀之一：4 个 0-import 纯几何文件

| 项 | 内容 |
|---|---|
| **前置** | **零前置，可随时插队**（4 个文件各自 0 import、各自有单测） |
| **落点** | `packages/deer-ui/src/geometry/{orb-layout.ts, pie-layout.ts, guide-layout.ts, back.ts}`（**368 行**） |
| **要改的 import 边** | `App.tsx`（`orb-layout` 3 处 + `pie-layout` 1 处）、`AiPanel.tsx`（`orb-layout`）、`guide.tsx` + `guide-demo.tsx`（`guide-layout`）、`src/main.tsx`（`back`） |
| **测试** | `tests/orb.test.ts`(31) / `pie.test.ts`(53) / `guide-layout.test.ts`(24) / `back.test.ts`(13) **整体跟着走**；`tests/pc.test.ts`(31) 与 `tests/selorb.test.ts`(47) 里**只搬与几何有关的那段**，其余留应用 |
| **验收 ①** | 应用 `node tests/.ts-out/tests/run-tests.js` → **`assertions ≥ 8090`**（几何断言迁出后的净减由本期新增的等价断言 + 既有总数余量吸收；**台账必须写明净减多少、库侧新增多少**） |
| **验收 ②** | 库侧新增 `geom.no-side-effect`：库内不得出现 `matchMedia` / `innerWidth` / `localStorage` / `document.` |
| **验收 ③（负例）** | 单独跑库测试 → `ALL PASS` 且 `assertions` 落在预期区间（**必须自带 DOM 桩**，见 R9） |
| **回滚点** | 一个提交（未改应用行为，只改 import 边） |
| **坑** | ① `ORB_SIZE 40` 这类 PixelCraft 特有常量进库时要**接受为默认值/参数**；② `back.ts` 按 N7 归类为「平台无关纯状态机」，**不要写成 UI 控件** |

#### P4b — 第 2 刀之二：`uibar.ts` 算法段（**逐函数表**）

| 段 | 起止 | 内容 | 归属 |
|---|---|---|---|
| 业务数据 | `:11-44` | `UIAction` 接口(`:11`)、`TOPBAR_ACTIONS`(`:23`)、`CBAR_ACTIONS`(`:34`)、**`ORB_IDS`(`:43`)**、`OrbKey`(`:44`) | **宿主**（12 条业务动作 + 5 个球的 id）。`UIAction.label` 是 **i18n 键**（`:13-19` 注释写明） |
| **AI 浮窗几何** | `:46-179` | `AI_CHAT_WIN_KEY`(`:59`)、`AI_CHAT_BALL_KEY`(`:61`)、`CHAT_BALL_ID`(`:63`)、`AI_WIN_*`(`:65-73`)、`AiWinLayout`(`:75`)、`viewport()`(`:87`)、`aiWinDefaultLayout`(`:94`)、`clampAiWinLayout`(`:107`)、`normalizeAiWinLayout`(`:130`)、`aiBallDefaultPos`(`:140`)、`clampAiBallPos`(`:151`)、`normalizeAiBallPos`(`:161`)、`aiWinDragFrom`(`:175`) | **宿主**（**不是** clamp/normalize 系列的通用工具，而是**应用内助手浮窗的几何**，消费者是 `AiWindow.tsx` / `AiPanel.tsx`；按 N3 跟 `ai` 模块走）。**`viewport()`(`:87`) 也留宿主** —— 它读 `window.innerWidth`，正是 §3.4.3 #7.2「库不许直接读 window」的对立面 |
| 布局归一化 | `:182-208` | `LAYOUT_KEYS`(`:182`)、`LayoutKey`(`:183`)、`DEFAULT_LAYOUT`(`:185`)、`normalizeLayout`(`:190`)、`isDefaultLayout`(`:200`) | **算法进库**，`LAYOUT_KEYS` 的**具体键名是业务的**（top/bar/timeline/dock/orbs/titles）→ 库收形状、宿主给键名 |
| 顺序 / 拖放算术 | `:210-311` | `orderedActions`(`:210`)、`fullOrder`(`:228`)、`moveId`(`:241`)、`toggleHidden`(`:252`)、`visibleCount`(`:260`)、`missingFrom`(`:266`)、`dropIndexAt`(`:276`)、`nearestSlotIndex`(`:292`)、`stepsBetween`(`:309`) | **算法进库** |

**硬前置**：`uibar.ts` 现在**业务注册表与算法同处一个文件**，所以 `:11-44` 与 `:46-179` 必须先留在（或移到）应用侧的一个独立文件，算法段才能进库。**这一步是改应用源码**，必须单独提交、单独回滚。

**库侧类型口径**：`UIAction.label` 在库里定义成 `label: string`（**已解析文本**），宿主保留 `labelKey: string`。

**验收（按断言名前缀切分，不是按行区间）**：

| 进库的 `uibar.*` 断言 | 留宿主的 `uibar.*` 断言 |
|---|---|
| `uibar.layout.*`(9) / `uibar.order.*`(5) / `uibar.full-order`(1) / `uibar.move.*`(15) / `uibar.hidden.*`(2) / `uibar.visible-count`(1) / `uibar.drop.*`(5) / `uibar.ring.*`(6) / `uibar.steps`(1) = **45** | `uibar.top.*`(18) / `uibar.cbar.*`(13) / `uibar.orbs`(1) / `uibar.registry.*`(3) / `uibar.pos.*`(2) / `uibar.reset.extras`(1) / `uibar.session.*`(14) = **52** |

> **总数实测 = 104**（运行期小节口径）。**两侧之和必须 ≥ 104**。
> **这张前缀表的数字也已经漂移**：实测该小节 104 条 = `uibar.*` 前缀 **97** 条 + **`act.list.*` 7 条**（同小节、不同前缀）；
> 而 `uibar.*` 内部也不是表里那 45 + 52：进库侧实测 `uibar.layout` **7**（不是 9）、`uibar.move` **13**（不是 15），
> 留宿主侧实测 `uibar.top` **17**（不是 18）、`uibar.session` **19**（不是 14）。**P4b 开工时按运行期断言名重算，别照抄这张表。**
> **`uibar.test.ts` 的真实小节边界**（实测）：`:12` 注册表完整性 / `:28` layout normalisation / `:36` ordering·hiding / `:62` 动作注册表 + 互搬 + 位置（`:64` 起 `new Session()`）/ `:104` 直接拖动落点判定 / `:122` Session wrappers。
> **不要照抄 `:11-119` / `:70-165`** —— 两个区间与真实小节边界**都不重合**，照它搬会**把 `:12-27` 那批依赖业务注册表的断言误判成「纯函数部分」搬进库**（那正是 N6 禁止的）。

#### P5 — 拆仓

| 项 | 内容 |
|---|---|
| **库仓库文件清单** | `package.json`（peerDeps / `files` / `sideEffects` / `publishConfig`）、`tsconfig.json` + `tsconfig.build.json`、`LICENSE`、`README.md`（**契约章**）、`CHANGELOG.md`、**`CONTRIBUTING.md`**（双仓协作与红线）、`.github/workflows/{ci.yml,pages.yml}`、`scripts/{build.sh,build-css.mjs,build-demo.sh,check-exports.mjs,check-size.mjs,check-no-cdn.mjs,run-tests.sh}`、`examples/demo.tsx`（从 `src/ui/kit/demo.tsx` 搬入；**不进 barrel / 不进 `files`**） |
| **本仓库** | `vendor/deerui-<ver>.tgz`（committed）、`package.json` 的 `devDependencies` 加一行 `"@deerluu/deer-ui": "file:vendor/deerui-<ver>.tgz"`、`scripts/deer-ui-vendor.sh`（**换版本的唯一入口**）、`scripts/build-css.mjs` |
| **验收 ①** | 库 CI 绿：`tsc --noEmit` 0 错误、库测试 `ALL PASS`（`assertions ≥ 70`，实测 123 + `geometry` 那批）、`dist/*.{js,d.ts,css}` 存在且能被 10 行第三方冒烟脚本 import；`npm pack --dry-run` 的文件清单**不含** `src/` / `tests/` / `examples/` |
| **验收 ②** | **路线 D 可复现**：`npm i file:vendor/….tgz` 后宿主 esbuild 默认参数打包成功、React 输入**全部来自宿主**、lockfile 带 `integrity: sha512-…` |
| **验收 ③** | 应用 `assertions ≥ 8090 / ALL PASS` + `check-bundle.mjs` 通过 + 体积 ≤ 基线 + 2 KB |
| **验收 ④（许可与供应链）** | `npm ls --prod` 为空（零运行时依赖）+ 生成许可清单 + `LICENSE` 与 `package.json` 的 `license` 字段按 Q14 的裁决落地 |
| **回滚点** | 库仓库首个 tag `v0.1.0` + 本仓库那一个提交。**回滚不影响应用** |
| **坑** | ① **仓库里没有任何 lockfile** → 库的 peer 范围不能写死成 `18.3.1`；应用侧应补锁（`ROADMAP.md` S0-1，**既有缺口，不算在抽离头上**）；② `package.json` 的 `name` 是 `pixelcraft-web`、`version` 是 `1.0.2`（**与应用版本 `1.1.1.9` 无关**）—— **别把库版本号接到 `APP_VERSION`**；③ [待验证] 容器出包环境里 deer-ui 装在哪能否被 esbuild 解析到（验法：容器里跑一次 `esbuild … --outfile=/tmp/probe.js`，见不到 `Could not resolve` 即成立） |

#### P6 — 应用消费库

| 项 | 内容 |
|---|---|
| **落点** | `src/ui/kit/index.ts` → 改成**静态再导出**（保证 esbuild 静态可达）；`src/ui/kit/` 下 7 个实现文件删除；`src/ui/base.tsx` **保留**（`useSession()` 与 `ScrubNum` 的 i18n 包装继续在应用侧 —— `useSession` **必须留应用**）；`src/ui/tooltip.ts` 删除（改从库 re-export，或让 4 处调用点改 import）；`tabs.tsx` 的应用侧 import 改为库（**不许留两份实现**） |
| **要改的测试** | `tests/ui-kit.test.tsx`：`kitDir` 改成库目录；`ui.kit.purity` 白名单**收紧**；`ui.overlay-full` / `ui.dropmenu.*` 保留并改读库副本；`ui.overlay-full-wiring`（读 `App.tsx`）**留应用**；**`ui.demo.*` 6 条改读库的 `src/demo.tsx`**。**`ui kit` 小节必须 ≥ 70，只增不减** |
| **要改的配置** | **`tests/tsconfig.json` 的 `include` 必须加库的 `src/`**（否则应用侧测试读库源码 → 编译产物里没有 → 运行期读不到；**不是红，是 throw/静默空文件**）。**负例**：故意在库源码里写类型错误 → 应用侧 `tsc -p tests/tsconfig.json` **必须红** |
| **验收 ①** | `assertions ≥ 8090 / ALL PASS`，且 `ui kit` 小节 ≥ 70、`ui.kit.purity` 白名单里已无 `../tooltip` / `../../engine/*` |
| **验收 ②** | `grep -rn 'from "./kit' src/` 与 `grep -rn 'src/ui/kit' tests/ src/ scripts/` 里**没有任何一条指向已删除的实现文件**（只剩 `index.ts` 这条再导出边） |
| **验收 ③** | `sh scripts/build-web.sh` 出包 + `check-bundle.mjs` 通过 + `app2/www/css/style.css` 拼接正确 |
| **验收 ④（首屏）** | `node toolchain/devserver.js` 起 8090，控制台无错、五球与主菜单可用（人工项） |
| **验收 ⑤（负例）** | 临时在库 `Dialog.tsx` 里加 `import { SESSION } from "../../../src/ui/singleton";`（**只在本地试一次，不提交**）→ 纯度断言**必须失败**（证判据不是恒真） |
| **回滚点** | 分两个提交：`refactor(ui): kit 改为 deer-ui 的静态再导出` + `test(ui): 纯度断言指向库目录`。**第一个是全方案最高风险点**，必须单独提交、单独跑全量、单独回滚 |
| **坑** | ① `noUnusedLocals`：删掉实现文件后，只被旧文件使用的类型导出会立刻红（`tsc` 会指出来，属良性）；② 根 `tsconfig.json` 的 `include: ["src"]` **看不到库源码** → 应用 `tsc --noEmit` 会**漏检**（不是红，是漏）→ `include` 加库 `src`，**同时保留库自己的 `tsconfig.json`**；③ `Icon` 的 sprite 仍由 `app2/www/index.html` 提供，**库不得自己再插一份 sprite** |

#### P6.5 — `UiHost` 落地接线（**新增期**）

| 项 | 内容 |
|---|---|
| **目标** | 让 §3.4 的接口**有运行时落点** |
| **库侧落点** | `packages/deer-ui/src/host.tsx`：`UiHostProvider`（React context）+ `useUiHost()` + `UiStrings` 英文兜底 + `setHostSingleton(h)`（给非 React 路径，如 `tooltip` store、纯函数工具） |
| **应用侧落点** | `src/main.tsx` 建 `PixelCraftHost`（包 `bridge` / `pcmode` / `fullscreen` / `safearea` / `localStorage`）并用 `<UiHostProvider>` 包住 `<App/>`；`I18nProvider` 同构 |
| **必做的两处改造** | ① `src/io/bridge.ts` **拆包**（能力子集 vs AI 端口服务 `:91-124`）；② `src/app/session.ts:839,849` 的 `setConfirmAsk/setTextAsk` 类型抽到公共声明 |
| **验收 ①** | `tests/host.test.tsx`（**新增**）：①假 host 注入后 `scrub` 的 `padTitle` 来自 host；②**无 host 时不抛**且走 `UiStrings` 英文兜底；③非 React 路径能拿到 singleton；④`setHostSingleton(null)` 后回到兜底 |
| **验收 ②** | 应用 `assertions ≥ 8090 / ALL PASS`；`build-web.sh` + `check-bundle.mjs` 通过；首屏人工项 |
| **验收 ③** | **至少 2 个真实消费者**在位（`scrub` 的 `padTitle`、`HoverTip` 的 PC 判定） |
| **回滚点** | 两个提交（库侧 host.tsx / 应用侧接线），可分别回滚 |
| **为什么单列而不是塞进 P6** | P6 是「应用第一次消费库」（风险最高、必须最小化）；把接线混进去会让 P6 的回滚面从「import 边」扩到「运行时行为」，违背 P6 自己定的「单独提交、单独回滚」纪律 |

#### P7 — 收尾

删 `src/ui/kit/` 的实现文件（`index.ts` 保留为再导出边）、删 `src/ui/kit/demo.tsx` 的应用侧副本（`scripts/build-ui-demo.sh:16` 的入口改指库的 `examples/`）；`docs/UI.md` 增补「库边界」章并把 §1.2 兼容层指向新路径；`README.md` 的文档表加一行入口；`docs/ARCHITECTURE.md` §4/§5 补一句「UI 控件库已独立为 deer-ui」；门禁进 verify。

**验收**：① `assertions ≥ 8090 / ALL PASS`；② `node scripts/check-ui-fork.mjs` 返回 0，且**故意新建 `src/ui/Dialog.tsx` 时返回 1**（负例当场验）；③ `nofork.*` 三条断言名都在；④ 全仓 `grep -rn 'from "./kit/' src/` 只命中 `src/ui/kit/index.ts` 一条；⑤ 文档三处入口都在。
**回滚点**：一个「删目录 + 加脚本」的提交。**删目录必须放在该提交的最后**：先让所有引用切换完成并跑绿，再删。

#### P8（可选）— 第二宿主验证

`examples/standalone.{html,tsx}`：只有 react + sprite snippet + `deer-ui.css`，渲染 `Dialog`/`Row`/`Switch`，**不 import 应用任何东西**。
**验收**：页面能起 + 无 console 错误；产物 `grep -c "SESSION"` = **0**；CSS **不引**应用 `style.css`。

---

## 6. 与既有计划的关系

### 6.1 `docs/ARCHITECTURE.md` §4（21 个可裁剪模块 / M0–M4）—— **两条并行线，命名不撞车，三处边界重叠**

| 事实 | 关系判定 |
|---|---|
| **`modules.config.json` / `src/modules/` / `scripts/modules.mjs` 三者都不存在**（`Test-Path` 全 False） | **引用 §4.2 的模块边界 + §4.9 的分期作为对齐基准**。`docs/ARCHITECTURE.md` 里多处都在描述这条**规划流水线**。**本方案全文不写「复用现成机制」** |
| 模块清单里**没有 `ui-kit` / `tokens` / `icons`**（§4.2 的 core + 21 行可选模块表） | **分类上是父子关系，不是并列关系**：呈现层原语是模块清单**下面的公共底座**（`guide`/`changelog`/`iso`/`frame-preview` 这些模块**提供的 UI** 恰恰要消费 kit）→ **命名与机制都不撞车** |
| 会**同抢 `src/ui/` 文件**的模块有 **8 个** | `iso`→`ui/iso.tsx`、`guide`→`ui/guide*.tsx`、`changelog`→`ui/changelog.tsx`、`refimage`→`ui/refimg.tsx`、`history-replay`→`ui/replay.tsx`+`modals.tsx`、`frame-preview`→`ui/preview.tsx`、`multicanvas`→`ui/canvas.tsx`、`animation`→`ui/timeline.tsx` → **这 8 个正是本方案判「不进库」的那批 → 两条路线结论一致、天然不冲突**。唯一要写清的是**优先级**：`ROADMAP.md` §7.2 R2 定的「**先做产品项、后搬模块**」同样适用 |
| **边界重叠 ①：模块自带的 UI 归谁** | **规则**：功能 UI **留宿主（模块内）**，不许搬进 deer-ui；deer-ui 只给它们**原语**。判据：**「这个组件的 props 里会不会出现某个功能模块的知识（iso/tag/ai）？」会 → 留宿主** |
| **边界重叠 ②：图标数据与分组** | **规则**：**机制进包、数据+分组留宿主**（§3.6） |
| **边界重叠 ③：i18n 字典** | **规则**：deer-ui **只提供注入点，不持有字典** —— 否则会出现**三套合并逻辑**（库 / 模块 / 宿主）。§4.6 明确「i18n：每模块自带 `i18n.ts` 片段，构建时合并；`tests/i18n.test.ts` **按启用模块**校验」。**这条做完，`docs/UI.md` §7 第 4 项 `UIProvider` 就顺带完成了** |
| §6 红线的语境 | 红线 5「`ui/kit` 这类呈现组件不进 server」；红线 8「模块之间不得 import 实现文件，只允许 `import type` 与 `ctx.use()`」→ **红线 8 与库的纯度规则是同一个思路，措辞可互相引用** |
| `App.tsx` / `modals.tsx` 是模块化**硬前置**（§4.9）；`ROADMAP` S1-9 把 `Session ↔ View` 环标为**高**风险 | 与本方案 §2.4-C 一致：这两个文件**既不是「待搬的库」，也不是「待拆的模块」，是「待拆的上帝文件」**。本方案**一行不动它们** |

**正面回答「会不会撞车」**：
> **不会在命名与机制上撞车，但会在三处边界上重叠**（功能 UI / 图标分组 / i18n 字典），已用上面的规则划清。
> **deer-ui 是安装期的包，模块系统是构建期的静态 import 剔除** —— 两条线可以并行。
> **唯一禁止的组合**是「让 deer-ui 变成模块系统的宿主」或「让模块开关去控制 deer-ui 的 `exports`」。

### 6.2 `docs/ROADMAP.md` 的 S0–S3

| 条目 | 关系 |
|---|---|
| **S1-8（M0 模块工具链 + 依赖方向检查）** | **本方案的机器判据可以直接复用它**：S1-8 要新增的「依赖方向检查脚本」的白名单逻辑与 §3.7 的「库 import 白名单断言」是同一种东西。**建议把库的纯度断言挂到同一个脚本上** |
| **S1-9（切 `Session ↔ View` 环，起点 56 次 `view_` 调用）** | §1.2-N4 的「抽 `ViewHost`」**就是这条**。本方案**不新增条目**，只声明「库的 `ViewHost` 抽取依赖它」；`view.ts` 本体**不进库** |
| **§7.2 R2（模块化与产品项撞同一批文件）** | **本方案与它同构** → **必须引用 R2 的取舍原则**：先产品项、后结构活；同一文件同一提交周期只允许一方改 |
| **§7.2 R3（量化目标与现实差一个量级）** | **本方案不为 deer-ui 另设行数目标**（会与 R3 打架），只用「**减耦计数**」（例：库内 `app/`/`io/` import 数 = 0） |
| **S0-1（补 lockfile）** | **仓库没有任何 lockfile** → 这是**既有缺口**，与 R5 相关。**不要算在 UI 抽离头上** |
| **§9「明确不做」** | 与本方案冲突的 **0 条**（笔迹 overlay 层 / Web Worker / 运行期模块开关都写在渲染与构建层面） |
| **§10 待用户拍板 Q1–Q14** | 直接相关的是 **Q4（`ai` 要不要进可裁剪模块）**：它决定 AI 助手是「永远编进包」还是「可裁」。**deer-ui 的立场不变**：无论 Q4 怎么答，**AI 助手都不进通用 UI 库** |

### 6.3 `docs/UI.md`

| 事实 | 关系 |
|---|---|
| §7「后续项（本次不做）」第 4 项 `UIProvider` 注入 `lang/t/toast/haptic`；第 5 项 Toast 组件化；**最后一行**「把 `src/ui/kit` 提成独立 workspace 包并对外发布」 | **这就是本任务的目标本身**：这条工作在既有计划里**已被显式预留**。本方案把第 4 项具体化为 §3.4 的 `UiHost`，把第 5 项对应到 §3.4.3 的 `toast` |
| §1.1 kit 纯度规则（测试强制） | **本方案的地基** |
| **§1.1 的纯度白名单与代码不符**（少 `engine/scrub`、`ui/tooltip`） | 代码真相：`scrub.tsx:7,8` → `engine/{expr,scrub}`；`primitives.tsx:6` → `../tooltip`；`tests/ui-kit.test.tsx:190-193` 的白名单含这三条。**登记为文档同步待办 D7** |
| §1.2 兼容层（`base.tsx` 再导出） | `base.tsx` 是「97 处 `Btn` / 18 处 `Icon` 免改 import」的支点 → **迁移期原样复用这个手法**（应用里留一个转发模块指向包） |
| §3.1 `style.css` 五分区 | **与文件已漂移**（§2.3）→ 库拿 tokens + base + kit，shell 与 canvas hud 留宿主。**P1 就是为这条设计的前置期** |
| §3.4/§3.5 令牌表、§3.7 主题、§3.7b PC 尺寸、§3.8 层级 | 令牌层**整份可搬**；主题/PC/层级都走「能力 → DOM 属性 → CSS」，**已是零耦合模式** |
| §5 测试规范 | kit 的策略是「**无 DOM**：`renderToStaticMarkup` 断言 DOM 契约，事件交互收敛到纯函数」→ **deer-ui 应沿用**。**但注意 N16：这是测试手段，不是 SSR 承诺** |
| §6「演示页不依赖 Session（验证 kit 纯度）」 | 与 §2.5 的裁决一致 |

### 6.4 一句话总结

> **deer-ui 抽库 = 把 `docs/UI.md` §7 的三项（`UIProvider` / Toast 组件化 / kit 独立成包）做完 + 复用 `docs/ROADMAP.md` S1-8 的依赖检查脚本 + 依赖 S1-9 的 `Session ↔ View` 解环（仅用于 `ViewHost`，`view.ts` 不进库）；与 `docs/ARCHITECTURE.md` §4 的模块化「不撞车但会抢同一批文件」，用 §6.1 的三条规则划清。**

---

## 7. 风险与缓解

### 7.1 风险登记（R1–R9 沿用 + R10–R12 补充）

| # | 风险 | 触发条件 | 缓解 | 怎么验 |
|---|---|---|---|---|
| **R1** | **包体变大 / React 重复实例**（**最高**） | ①库产物被重复打进；②为库化引入运行时依赖；③**两份同名组件同时在依赖图里**（P0b→P7 窗口期）；④**React 被装两份** | ①库**零运行时依赖**；②库**只以源码/单份产物内联**；③两边 CI 各一道体积闸门；④走 **tarball** 路线保证 React 单实例 | 基线 1,334,285 B + md5；阈值 **≤ +2 KB**；**「一份 React = 142,547 B」**说明闸门要盯**重复** |
| **R2** | **三端兼容（`file://` / 旧 WebView）**（高） | ①库 target 比宿主更现代；②新运行时 API（`structuredClone`/`.at(`/`ResizeObserver`/`:has()`）；③依赖 `fetch`/ESM 加载；④`file://` 下资源引用方式变化 | ①库与宿主**同一个 target 常量**；②库**不引入跨文档资源引用**（`<use href="#id">` 同文档 sprite 不变）；③新 API 在 `app.js` 里数**字符串出现次数** | `check-bundle.mjs` + esbuild 反解语法检查 + 库 CI 断言产物不含 `??=`/`.at(`/`structuredClone` + 三端各跑一次。**⚠️ 本机没有 Android 设备 → 真机项只能静态守，不许以「已核」口吻写进度** |
| **R3** | **PC 模式与安全区变量**（中） | ①库自己探测 PC（**媒体查询 / 屏幕宽度 / `dataset.pc`**）→ 与 `resolvePcMode()`（按**输入证据**判定）打架；②库自己写 `--sat/--sab/--sal/--sar`；③库自己切 `data-theme`；④`1b/5 PC 模式` 的覆写与库控件规则**两边都改同一类名** → 静默双改 | ①契约写死两边文档：**PC 判定 / 主题 / 安全区 / 密度覆写全部是宿主职责，库只消费**；②库保留「被推入」形态并**修掉今天那条断线**（`setKitPcMode` 0 调用点，**单独小提交**）；③四个变量唯一写入者 | `tests/pc.test.ts`(31) + `fullscreen.test.ts`(11) 保持全绿；**判据措辞见下** |
| **R4** | **i18n 文案漂移**（中） | 库需要一句文案时自带一份；库自带默认值后宿主忘了注入 | ①库只收**键名 + 英文默认值**；②应用侧加**对账断言** `kit.i18n.keys ⊆ 应用字典`（**求值口径**）；③**组件内部一律不写死文案** | `tests/i18n.test.ts` **≥ 8 条**全绿 + 新增对账断言；人工项：切英文界面看一遍库控件 |
| **R5** | **React 版本钉死**（中） | **仓库没有任何 lockfile**，`package.json` 写 `^18.3.1`（装出恰好 18.3.1）。库作为 peer 发布后可能装到 18.4.x / 19.x | ①库 `peerDependencies` 写 **`^18.3.0`**，README 写明「只测过 18.3.1」；②应用侧按 `ROADMAP` S0-1 补锁；③库 CI 把 React 版本**矩阵化**（18.2/18.3） | 库 CI 版本矩阵；`npm ls react` |
| **R6** | **379 个提交的回归面**（高） | kit 上累积多批 UI 改造，其中**只被人工验证覆盖、没被 70 条断言覆盖**的，会在「复制 + 改路径」时静默丢掉 | ①**先补行为断言再搬**：把 `docs/UI.md` §4「必须保持」那串逐条落成断言（`ui.dialog.guide`/`ui.dialog.classes`/`ui.dialog.foot` 有，**`Keep` 与 `.cfm-layer` 没有**）；②每期报数；③关键路径留**黄金 md5** | 新增 **≥ 8 条**断言（`ui.dialog.golden-md5`、`ui.keep.wraps`、`ui.cfm-layer.present`…）；**负例**：故意改一个 class 名 → md5 断言必须红 |
| **R7** | **双仓同步成本 / 漂移**（中） | 库改一处应用不知道；或应用为赶功能**直接改副本** | ①`packages/deer-ui/CHECKSUMS.txt` + `scripts/sync-deer-ui.sh --check`（**只比对不写入**）进 verify 门禁；②库的每次发布在应用侧产生**一个独立提交**；③分叉检测脚本**每期都跑**；④文档写死「**改库必须走库仓库**」 | `--check` 的**负例**（改一个字节 → 退出码 1）必须**当场验一次** |
| **R8** | **changelog / 版本号两处维护**（中） | 库有自己的 `version` 与 `CHANGELOG.md`，应用有 `APP_VERSION` / `BUILD_TAG` / `AndroidManifest` 的 `versionName`/`versionCode` | ①**两条线**：库版本只在库仓库维护（**不写中文用户文案**）；②写死「**不要**把库版本写进 `changelog.tsx`」；③提交信息带「源 <库 sha>」而不是库版本号 | `tests/changelog.test.ts`(20) 保持绿 |
| **R9** | **测试基建的隐式顺序依赖**（低） | 库测试**单独跑**时，应用侧某些模块依赖前序测试装的 DOM 桩（**实测**：`uibar.test` 单跑报 `window is not defined`，全套里能过） | ①库 runner **自带 DOM 桩**；②输出打 `assertions: N / ALL PASS`，CI 断言 **N ≥ 70**（实测 123） | 单独跑一次库测试，N 必须落在预期区间 |
| **R10** | **`tooltip` 双实例 → 长按提示静默消失**（**中高**） | `primitives.tsx:6` 是 kit 唯一的库外引用，而它是**模块级可变单例**（`subs` 是模块级 `Set`）。库一份 + 宿主一份 = **两个订阅表**：kit 控件调 `showTip` 写进库的表，宿主 `TipHost` 订阅的是宿主那份 | ①**库独占** `tooltip`，宿主 `src/ui/tooltip.ts` 改为 re-export 或删除；②加一条静态断言：宿主 `src/ui/tooltip.ts` 必须是 re-export 或已删除 | 断言本身；**负例**：宿主保留独立实现 → 断言红。**注意 `tooltip.ts` 有 4 处宿主调用点**（`primitives.tsx` + `App.tsx` / `canvas.tsx` / `color-drag.tsx` / `hold.tsx`） |
| **R11** | **`engine/{expr,scrub}` 两份字节**（低） | 两个纯函数被内联进库，宿主仍保留原版 | **接受重复、登记在案**（5,640 B 源码 ≈ minify 后 < 2 KB，不共享状态、无行为风险）。要消掉就让宿主也改成 import 包的入口 —— **不建议**（engine 不是 deer-ui 的边界） | 体积闸门（在 +2 KB 容差内） |
| **R12** | **「不红但更危险」的静默失效**（中） | 见下表 **6 条**。共同特征：**测试继续绿，但扫描/校验面在缩水** | 逐条给判据（见下） | 逐条给负例 |

#### R3 的判据措辞（**修正**）

> **原文「库内不得出现 `matchMedia` / `innerWidth` / `localStorage`」与 P0b 的「逐字节复制」直接冲突**：
> 实测 `kit/HoverTip.tsx:55-56`、`kit/primitives.tsx:12,14`、`kit/scrub.tsx:100-101`、`tabs.tsx:77,80` **都有 `window.innerWidth` / `matchMedia`**。
> **修正后的判据（语义规则，不是字符串黑名单）**：
> **库内不得「自行判定 PC / 主题 / 安全区」**。具体禁的是：
> ① `matchMedia(` 且媒体特征是 `pointer:` / `hover:` 系的**判定性**调用（`primitives.tsx:12,14` 是 `(orientation: landscape)`，**是布局查询、不是 PC 判定 → 允许**）；
> ② `documentElement.dataset.pc` / `dataset.theme` 的**写**；
> ③ `localStorage` **全禁**（实测 kit 内 0 处）。
> **允许**：`window.innerWidth/innerHeight` 用于**测量已有的 rect / 计算提示气泡位置**（`HoverTip`/`scrub`/`tabs`）—— 这与「判定 PC 模式」不同类。
> **断言名**：`kit.pcmode.pushed-not-detected`（P0a 的 A0-3）。
> ⚠️ 若坚持原来的字符串黑名单，P0b 就会**当场红**，与「P0b 应用零改动 + 库测试 ALL PASS」冲突 —— 所以**采纳修正后的措辞**。

#### R12 的 6 条静默风险（逐条给判据）

| # | 静默风险 | 实测证据 | 判据 / 缓解 |
|---|---|---|---|
| **12-1** | **`icons.test.ts` 的 walk 根是 `src/`**：P3 后库源码引用 `#i-…`，**一条都不会被扫**（不红，是漏网） | `tests/icons.test.ts` walk `src/**` 找 `"i-…"`；库在 `packages/` 下 | **二选一，写进断言名**：①把 walk 根扩到仓库根（会让 `packages/` 整个进射程）；②库侧加 `kit.icon.contract-ids`（**本方案选②**） |
| **12-2** | **根 `tsconfig.json` 的 `include: ["src"]` 看不到库源码** → 库里的类型错误被漏检（不红，是漏） | `tsconfig.json:18` `"include": ["src"]` | 根 `tsconfig` 的 `include` 加库 `src`，**同时保留库自己的 `tsconfig.json`**；负例：库里写一个类型错误 → 应用 `tsc --noEmit` 必须红 |
| **12-3** | **`tests/i18n.test.ts` 非递归扫 `src/ui` + 阈值 `files.length > 10`**：库成为新家后，**库源码的 i18n 键一条都不被校验**，而测试继续绿 | `tests/i18n.test.ts:24-30`：`readdirSync` **非递归**；`ok("i18n.sources", files.length > 10)`；`src/ui` 文件数余量极小 | ①阈值改成**显式清单**（「扫到 `src/ui` + `src/ui/kit` 的全部文件数 ≥ 当前值」）；②**新增断言** `i18n.sources.covers-kit`；③**在断言名里写清扫描根** |
| **12-4** | **`tests/guide-anchors.test.ts` 同样非递归 + `getBarSource()` 的 `catch { return "" }`**：`uibar.ts` 被拆（P4b 的硬前置）之后，若路径变了，**锚点校验静默跳过** | `tests/guide-anchors.test.ts:20-26`：`readdirSync` 非递归；`getBarSource()` 读 `src/app/uibar.ts` 且 **`catch { return "" }`**（读不到就当空字符串，不报错） | ①同样加「扫描根」断言；②**去掉 `catch` 的静默回退**（读不到就 `ok(name, false)`）；③P4b 拆 `uibar.ts` 时**必须同步改这个测试的路径** |
| **12-5** | **`tests/tsconfig.json` 的显式 `files` 清单 + `rootDir: ".."`**：应用侧测试一旦读库源码，**要么编不进 `.ts-out`、要么路径结构对不上** | `tests/tsconfig.json:14-15`；`include` = **60 条显式路径**且**不含 `../src/**`** | **P0b 就撞**（库测试副本要自带编排），**P6 再撞一次**（应用测试读库源码）→ 见 §3.3 的设计 + P6 的连带修改 + 负例验收 |
| **12-6** | **「库段与应用段对同一类名的层叠顺序」没有任何断言覆盖** | P2 要求「库在前、应用在后」，但原来**没有一条断言的比对对象是「顺序」**；`uitoken.panel-full` 只保证 `.panel.panel-full` **恰好一次** | **新增产物级断言**（P2 验收 ②）：拼接产物里**库段必须出现在应用段之前**（用 P1 的机器锚点 `/* deer-ui:kit-controls:start */` 判位置） |

### 7.2 「已发现待办」——本轮登记，不改（D1–D10）

| # | 问题 | 证据 | 处置建议 |
|---|---|---|---|
| D1 | **`askOverwrite` 的中英文案硬编码在 `session.ts:868-875`，没走 i18n** | 两条提示中英双份；`ROADMAP.md` §8 D24 / `S1-2` 记过同类问题 | 搬进 `i18n.ts`（或改成 `host.confirm({msgKey})`）。**单独小提交**；会改「文案由谁提供」的归属 → 同步 `docs/API.md` |
| D2 | **`decodeImage` 有两份重复实现** | `modals.tsx:245-254`（`decodeStill`）与 `AiPanel.tsx:455-476`（`attachmentFromFile`） | 收进 `UiHost.decodeImage` 后两处合一（§3.4.3 #5.4，**P6.5**） |
| D3 | **`setKitPcMode` 全仓 0 调用点** | `kit/pcmode.ts` 导出它但无调用者；`main.tsx` 只调了 `setHoverTipsEnabled` | 「接线缺一根」。**单独一个小提交 + 一条断言**，不混进迁移（修它 = 行为变更） |
| D4 | **仓库没有任何 lockfile** | `package-lock.json` / `yarn.lock` / `pnpm-lock.yaml` 均不存在；`package.json` 写 `^18.3.1` | 属**既有缺口**（`ROADMAP` S0-1），**不要算在 UI 抽离头上**；但它直接放大 R5 |
| D5 | **`scripts/run-tests.sh` 里的 `node_modules/typescript/bin/tsc.js` 在本机不存在** | 真路径是 `node_modules/typescript/lib/tsc.js`（`bin/tsc` 是无扩展名的 shell 包装） | **新仓库的脚本别照抄这条**（§3.3 已写明） |
| D6 | **`docs/UI.md` §3.1 的「5 分区」与 `src/ui/style.css` 已漂移** | §2.3；带编号横幅只有 2 条 | P1 划真边界后，同步更新 `docs/UI.md` §3.1（属文档同步活，单独一轮） |
| D7 | **`docs/UI.md` §1.1 的 kit 纯度白名单与代码不符**（少 `engine/scrub`、`ui/tooltip`） | `scrub.tsx:7,8`、`primitives.tsx:6`；`tests/ui-kit.test.tsx:190-193` 已含这三条 | P0b 时会自然收口（白名单收成 4 项）；顺手补 `docs/UI.md` §1.1 |
| D8 | **`tests/i18n.test.ts` 硬编码源码目录 + 阈值过低** | `:24-30` 用 `path.resolve(__dirname, "../../../src/ui")`；`ok("i18n.sources", files.length > 10)` | 见 R12-3 |
| D9 | **`renderdebug.tsx` 违反 `docs/ARCHITECTURE.md` §3.8「禁止 `ui → servers`」** | `renderdebug.tsx:14` `import { renderDebug, type RenderEvent } from "../servers/render"` | **留应用**（开发者工具），登记为模块化那一线的既有债 |
| D10 | **i18n 键的「数法」是个坑（已核实数字与成因）** | zh/en 各 **845 顶层键 / 1,136 叶子**。字典**未导出**（模块内 `const zh` / `en`），须包 `new Function` 求值才能数；**实测 185 行把多个键写在同一行**，按行计数会数出 **347**（少一半以上，且静默不报错） | ①口径写进 §3.6；②**对账/校验类断言一律用求值口径**，不许写成行计数版；③`tests/i18n.test.ts` 现有实现走 `makeT` 求值，与此一致 |

---

## 8. 待用户拍板

> 每项都给出**「如果不拍板，方案默认怎么走」**。默认值一律取「**风险最低 + 可逆**」的那一支。

| # | 问题 | 默认（不拍板时怎么走） | 是否影响 P0b 范围 |
|---|---|---|---|
| **Q1** | **仓库位置**：deer-ui 与 PixelCraft **平级**（`../deer-ui`）／submodule／另一盘符？ | **平级 `../deer-ui`**（影响只是 `scripts/deer-ui-vendor.sh` 的一个变量） | 否 |
| **Q2** | **迁移期是否双仓并行**：P0–P4 在 `packages/deer-ui/` 内发育（单仓），还是从 P0 就建独立仓库？ | **P0–P4 单仓 `packages/deer-ui/`**，**P5 再拆仓** | **否** |
| **Q3** | **包名与是否发 npm**：`@deerluu/deer-ui`（scope 空闲）/ `deerui` / 别的；v0 只发 tarball 还是同时 publish？（**GitHub 仓库名可以就叫 `deer-ui`**） | **包名 `@deerluu/deer-ui`，v0 不发 npm**，用 committed tarball；`exports`/`types`/`peerDeps` 照写 | 否 |
| **Q4** | **`.js` 后缀路线**：(a) 源码显式写 `.js`（原生 Node 也能 import，要一次机械替换）／(b) 声明 **bundler-only**（零替换，`node` 直接 import `dist` 会失败） | **(b) bundler-only**；**必须在 README + `package.json` 的 `description` 明确声明** —— 两条路都可行，但**不能留默认** | 否 |
| **Q5** | **CSS 拼接落点**：**(A)** 拼回 `src/ui/style.css`（既有静态扫描零改动，但**改写受版本管理的源文件**）／**(B)** 只拼到 `app2/www/css/style.css` 产物（源文件干净，但 `ui-tokens.test.ts` 必须改成读两份）／**(C) 第三方案（推荐）**：**保留 `:root` 与 `2/5 base` 锚点不动、库 CSS 只做尾部注入、测试一行不改** | **(C) 第三方案**。理由：`tests/ui-tokens.test.ts:106-107,:124` 的三个锚点全部继续成立（`body` 是从 `2/5` 横幅结束处到**文件末尾**，尾部注入的库规则自然落在切片内）。**代价**：`uitoken.no-raw-colour-in-shell`（`:140-147`）会把**库段的规则也一起看** → 库 CSS **不得出现 `SHELL` 名单里的选择器 + 裸色值**（写进库的 `tokens.test.ts`）。<br>**⚠️ 必须在 P1 结束前拍板，否则 P2 的验收写不出来** | 否（P2 才需要） |
| **Q6** | **库的定位**：「PixelCraft 内部复用 + 将来对外」还是「只做本项目的解耦」？ | **先做「内部复用」** → **P0b 不产出 `dist`、不写 CI、不做 `exports` 全集、不发 npm**（N17 写死）；等 P8 第二宿主验证过了再谈发布 | **是** |
| **Q7** | **库的测试栈** | **继承「测试内容」**（`renderToStaticMarkup` + 静态扫描 + 自写 `common.ts`/runner，**不引 jsdom/vitest**），**但 `tsconfig` 编排必须重写**（见 §3.3）—— 直接照抄仓库那套会撞 `rootDir`/`outDir`/显式清单 | **是** |
| **Q8** | **`kit/demo.tsx` 归属** | **P0b 就复制进库**（`src/demo.tsx`），**不进 barrel / 不进 `files` / 库测试渲染它**（§2.5）。**接受双副本窗口**，P5 搬 `examples/`、P7 删应用侧 | **是**（9 个 vs 10 个） |
| **Q9** | **`ui.dropmenu.pop-css` 与令牌类断言拆分后读哪一份** | **控件规则读库 CSS**；**「唯一性 / 层叠顺序」类读拼接产物** | 否 |
| **Q10** | **`aria-label="close"` 这类库内置英文常量要不要 i18n 化** | **保持现状**（P3 只做注入通道，**不新增文案**），单独作为一个小项登记 | 否 |
| **Q11** | **`setKitPcMode` 那条断线修不修** | **单独修**（一个小提交 + 一条断言），**不混进迁移** | 否 |
| **Q12** | **首刀是否就是 A0 + 甲案** | **是**（§2.6） | **是** |
| **Q13** | **是否接受「应用侧断言恒 ≥ 8090」这条比 `ROADMAP.md` 更硬的计数纪律** | **接受**。P4a 会净减一部分几何断言 → 台账必须写清「库侧新增 = 应用侧净减」，且总数仍 ≥ 8090 | 否 |
| **Q14** | **许可与版权**：MIT / Apache-2.0 / 私有／版权行写谁？ | **默认 `"private": true` 且不写 `license` 字段**（v0 不发 npm，没有对外授权需求）。`LICENSE` 文件与 `package.json` 的 `license` 字段**属于 P0b 交付物**；真要发布时（P5+）再定具体许可与版权行 | **是** |

---

## 9. 明确不做

| # | 不做的事 | 理由 |
|---|---|---|
| 1 | **为了抽库顺手重写组件内部** | 迁移期唯一资产是「行为不变」。`Dialog` 的 DOM 契约被 70 条断言 + 引导锚点 + `style.css` 三方同时依赖 |
| 2 | **改库组件的 DOM class 名 / 删 `data-guide` 透传** | 静态断言盯住这些名字；改名 = 引导与样式**同时静默失效** |
| 3 | **削弱无障碍属性（`role` / `aria-*` / 键盘可达）** | **N15 红线**：库的无障碍契约 = DOM 契约的一部分，只做「不退化」承诺 |
| 4 | **把 `App.tsx` / `modals.tsx` / `timeline.tsx` / `AiPanel.tsx` 拆了再搬** | §4.9 明说模块化必须排在 Server 化之后；这四个是业务外壳不是控件 |
| 5 | **改造 `hold` / `color-drag` / `HsvWheel` / `fxparam` / `scale-preview`** | 它们硬引 `SESSION` 或绑业务类型，属「需改造后**可**进」= **分类不是承诺**。**本方案不给它们归属期**，只登记改造点（§2.4-B） |
| 6 | **搬 `orb-layout` / `pie-layout` / `guide-layout` / `back` 之外的零依赖纯函数**（如 `scale-preview`） | `scale-preview` 绑 `engine/color-analysis`（§4.2 归 `resample` 模块） |
| 7 | **把 `src/ui/i18n.ts`（975 行）整体搬进库** | 库会变成「PixelCraft 全部产品文案的载体」；§4.6 要的是「每模块自带片段、构建时合并」 |
| 8 | **把 `feature-icons.ts`（105 行）与 122 个 symbol 搬进库** | 图标集是应用资源；「同屏不得复用」是**产品规则** |
| 9 | **把 `src/render/view.ts`（3,693 行）搬进库** | 它是**渲染器**：import 38 模块跨 7 目录、直触 `Session` 约 50 成员、真的在写数据、与 `Session` 双向环 |
| 10 | **库引入除 `react` / `react-dom` 之外的运行时依赖** | R1 包体 + R2 `file://` 离线形态；`engine/expr`、`engine/scrub` **内联进库**比引包更便宜 |
| 11 | **为了抽库引入构建框架**（vite / rollup / tsup / turborepo / monorepo 工具链 / changesets） | 今天是「esbuild 一条命令 + 一个 HTML」；引工具链会打破「产物只有 app.js 一个文件」这条硬约束 |
| 12 | **在库仓库里放任何 PixelCraft 业务 CSS**（`.tl-` / `.ca-` / `.sh-` / `.iso-` / `.guide-` / `.ai-`） | 这些类名只在应用里出现；库 CSS 只允许 P1/P2 划定的「令牌 + 控件规则」段 |
| 13 | **顺手修 D1–D3、D5 那几项既有缺陷** | 都属**行为变更**，必须**单独小提交、单独验** |
| 14 | **把库版本号接进 `APP_VERSION` / 更新日志 / `AndroidManifest`** | R8：两条版本线 |
| 15 | **在 Android 侧也做一套裁剪/适配（Java 桥里加 UI 分支）** | §8 决策 8 已裁：Java 层保持最小且通用；UI 抽库**完全不涉及** `android/` |
| 16 | **为了「库化」手改 `app2/www/`** | `AGENTS.md` §5.1b：它们是**产物**；P2 的拼接要写进构建脚本 |
| 17 | **把库源码 vendored 进 `src/`** | `tests/hans.test.ts` 递归 walk 的 `SKIP_DIR` **不含 vendor** → 库注释进简繁校验射程 |
| 18 | **为 deer-ui 另设行数目标** | `ROADMAP.md` §7.2 R3 已指出既有权目标与现实差一个量级；本方案改用**减耦计数** |
| 19 | **为 `UiHost` 写「看起来完整」但无调用点的成员** | §3.4.1 规则 2：**写不出调用点的一律不写进接口** |
| 20 | **把 855 处 `SESSION` 引用一起搬 / 一起解耦** | **两级消费**：一级「库内」只认 props + host；二级「业务面板」继续直接 import `SESSION`，**明说不搬** |
| 21 | **承诺 SSR** | N16：`renderToStaticMarkup` 是测试手段，不是 SSR 支持 |
| 22 | **在 P0 就产出发布面**（`dist` / CI / `exports` 全集 / npm publish / `sprite.svg`） | N17 + §3.2-A：P0 只承诺「能独立编译 + 能独立跑测试」。`./sprite.svg` **不提供** |
| 23 | **在本仓库创建 deer-ui 的实现代码（本轮）** | 本轮约束：**只写方案**。P0a 只加测试；P0b 起才允许创建 `packages/deer-ui/`，且必须由后续任务开工 |

---

## 10. 执行记录

> **本节是事实记录，不是计划。**
> **§10.1–§10.6 = 第一轮（2026-09-20，P0a–P6）**：所有数字都在 `Z:\pixelcraft`（HEAD `189ef94` + 未提交的工作区改动）与
> `Z:\deer-ui`（库仓 HEAD `f2244f5`）上**亲手复跑**过；凡没复现的一律标 `[待验证]`。
> 三步都在**同一个工作区**里做完；**应用侧一个提交都没做**（提交由队长处理）。
> **§10.7 = 第二轮（同日，库独立化 + 样式抽进库）**：库侧走 `b0f259a` → `a5cefbb` 两个本地提交（**未 push**），
> 应用侧仍是未提交的工作区改动。**第二轮把 §10.3-⑥（P1/P2 没做）、§10.5-1（库 CI 跑不起来）、
> §10.5-2（没有「安装树 == vendor tarball」断言的一半）收掉了**，同时带出三个新的真问题（见 §10.7-4）。
>
> **§10.8 = 第三轮（同日，收尾两轮 + 终检缺陷）**：库侧 `b5d7c51` → `e2bc5d4` → `9fa9de3`（README 收尾 /
> 让「从 git 装」为真 / `.gitattributes`），宿主侧 `vendor/deerui-0.1.0.tgz` 重打到 **40,278 B**并同步三条指纹常量
> 与 lock 的 `integrity`。**这一轮的产出主要是「承诺变真 + 把上两轮蒙住的地方补上判据」**：
> **数字自己查的话看 §10.8-4 那张表**；「为什么前两轮验收没抓住那四处缺陷」看 §10.8-5（本轮最有价值的一节）。

### 10.1 三步各自的实际结果

| 步 | 方案位置 | 实际做了什么 | 实测判据 | 结果 |
|---|---|---|---|---|
| **① A0 三条机器判据** | §2.6 A0 / P0a | **不在 `src/ui/kit` 原地加**，而是直接落进新仓库 `Z:\deer-ui\tests\`：`a0-purity`（纯度白名单）/ `a0-barrel`（导出面 JSON 快照 + 入口只许 re-export）/ `a0-host-boundaries`（不得自判 PC / 主题 / 安全区），**三条各带自检段**（合成样本喂给扫描函数，证判据不是恒真） | 库测试 `assertions: 123 / ALL PASS`（exit 0）；A0-1 **13** + A0-2 **9** + A0-3 **28** = **50** 条 | ✅ 落地（判据比方案**更严**，见 10.3-④） |
| **② P0b 复制进库** | §5.2 P0b 甲案 | 库 `src/` 复制 **9 个文件 / 899 行**（HEAD 行数实测：`kit/` 7 个 = index 13 + primitives 166 + scrub 198 + Dialog 86 + Form 143 + HoverTip 91 + pcmode 29，加 `tabs.tsx` 140 + `tooltip.ts` 33），只改 2 行 import（`scrub.tsx` 的 `../../engine/{expr,scrub}` → `../internal/*`；`internal/*` 是从 `engine/*` 内联的副本，各多 5 行出处注释）；示范页 `examples/demo.tsx` 只作 dev-only 文件（逐字节复制 + 1 行 import 改动），**不进 `src/`、不进 barrel、不进 `files`、不进 `dist`，库测试不渲染它** | 库测试 `123 / ALL PASS`；应用侧 `8090 / ALL PASS`（P0b 期应用一行没改） | ✅ 落地（文件面与方案差 1 个，见 10.3-②） |
| **③ 宿主改为消费** | §4.6 路线 D + P6 | `vendor/deerui-0.1.0.tgz` 进应用仓 + `package.json` 加 `"deer-ui": "file:vendor/deerui-0.1.0.tgz"`；**9 个公开路径全部改成薄再导出层**（一行 `export * from "deer-ui/<入口>"`），**没有删任何实现文件**；`tests/ui-kit.test.tsx` 里 **17 条**断言的读数对象换成装进来的**库产物**；新增 `tests/ui-fork.test.ts`（29 条）+ `tests/deerui-bridge.ts`（CJS 测试进程的 ESM 加载桥） | 四道闸门全绿（见 10.2）；`ui kit` 小节仍 **70** 条、一条没删；新增 29 条全是 `uifork.*` | ✅ 落地（**未删文件**，见 10.3-③） |

**A0 的「已知 3 处越界」怎么收口的**：方案 §2.6 要求 A0-1 对**当时的** `src/ui/kit` 给出「3 处越界」的明确输出
（`primitives.tsx:6 → ../tooltip`、`scrub.tsx:7,8 → ../../engine/*`）并把白名单收成 4 项。
实际做法是**跳过「先红后收」那一步**：库侧一落地就是收紧后的规则 —— 白名单 = `react` / `react-dom` / `react-dom/*` / `react/*` 与**库内相对路径**，
且相对路径必须**解析得到**、**不得越出库的 `src/`**。原始「3 处越界」的等价证据落在库仓 `tests/a0-purity.test.ts` 的自检段里。

### 10.2 实测数字（本节所有数都是本轮复跑出来的）

> ⚠️ **本节是第一轮的数字，第二轮之后已经变了**（权威值见 **§10.7**）：宿主断言 **8119 → 8134**、
> 库侧 **123 → 134**、`vendor/deerui-0.1.0.tgz` **26,932 B → 36,234 B**（md5 `1e9c0d79…` → `d0e943ff…`）、
> 库 `dist` 多了 `styles.css`。本节保留第一轮的原值与核法 —— **引用时请连第二轮一起读**，别把 8119 / 123 当现值。

**断言数** —— 数法：`node tests/.ts-out/tests/run-tests.js`，按输出里的 `--- 小节名 ---` 分段数 `ok ` 行，总数与末尾 `assertions:` 一致。

| 项 | 值 | 怎么核的 |
|---|---:|---|
| 应用侧基线（迁移前） | **8090 / ALL PASS**（exit 0） | 我自建基线：`git -c core.autocrlf=false archive HEAD` 出 **221/221** 个文件到 `%TEMP%\t6-base`（逐个 `git hash-object` 等于对应的 `HEAD:<path>` blob，0 处不符）+ junction `node_modules`，再 `tsc -p tests/tsconfig.json` + `node .ts-out/tests/run-tests.js`。**行尾陷阱**：`git archive` 默认按 `core.autocrlf=true` 写出 **CRLF**，会让 `f1.detect-get-has-no-body` 这类**按 `\n` 字面比源码**的断言**假红**（我第一次就是这么跑的：1 条 FAIL，`sanitized` 后 0 条）⇒ **必须带 `-c core.autocrlf=false`** |
| 应用侧现在 | **8119 / ALL PASS**（FAIL 0） | 直接跑；`8119 − 8090 = 29`，**全是**新增的 `uifork.*` |
| `ui kit` 小节 | **70**（基线也是 70） | 我按 `--- 小节名 ---` 两侧各切 **62** 个小节逐节比对：**只有新增的 `ui fork / react single instance` 变了（0 → 29）**，其余 **61 个小节条数完全相同**；名字级「基线有、现在没有」= **0**，新出现的 **29** 个名字全是 `uifork.*`（无删除、无改名） |
| `ui fork / react single instance` 小节 | **29**（新增） | 同上 |
| `i18n` / `uibar` / `icons` / `ui tokens` / `guide anchors` / `expr` 小节 | **8 / 104 / 86 / 17 / 10 / 34** | 同上（前三个就是本方案的三个更正数；**34 属 `expr`**） |
| 库侧（`Z:\deer-ui`） | **123 / ALL PASS** | 跑 `node scripts/tsc.mjs -p tests/tsconfig.json` + `node tests/.ts-out/tests/run-tests.js`（= 库的 `npm test`）；分节：基建 10 + A0-1 13 + A0-2 9 + A0-3 28 + 控件契约 62 + 预算闸门 1 = 123；闸门是 `lib.budget.assertions`（下限 123 = 搬入 62 + 基建 61） |

**产物与供应链**

| 项 | 值 |
|---|---|
| 四道闸门 | ① `tsc -p tsconfig.json --noEmit` exit 0；② `tsc -p tests/tsconfig.json` exit 0；③ `run-tests` → `assertions: 8119 / ALL PASS` exit 0；④ `check-bundle app2/www/js/app.js` → `✓ 产物自检通过：bundle 能加载并渲染出 1 个根节点` exit 0 |
| `app2/www/js/app.js`（现在） | **1,334,394 B** / md5 **`3f9db8acbfb76fe38ffaa6c33f875940`**（我独立重建得到同一 md5） |
| 同上（迁移前基线） | **1,334,285 B** / md5 `a15d5b1e626edfaf526c28694bed4b86` ⇒ **+109 B**。闸门是 §4.5 的 **≤ 基线 + 2 KB**（**不是**任务书里曾写的 +4 KB），两种口径都过 |
| 重建可复现性 | 同一份 esbuild 参数（`absWorkingDir` = 仓库根、`entryPoints:["src/main.tsx"]`、bundle/iife/browser/es2019/minify）分别重建「现在」与「HEAD 基线」→ 两个 md5 与上表逐字节相同；metafile：现在 **11 个 `node_modules/deer-ui/dist/*`** 输入，基线 **0 个**；基线输入里有 `src/engine/expr.ts`，现在没有（= D 项的宿主死代码证据） |
| `vendor/deerui-0.1.0.tgz` | **26,932 B** / md5 **`1e9c0d79952e7a3ac5cb82a4ecd1af98`**；与库仓 `Z:\deer-ui\deerui-0.1.0.tgz` **同一 md5**（两边解包 **27/27 文件逐字节相同** —— 引自 t4/t5 的解包比对，本轮只复核了 md5 与字节数） |
| `node_modules/deer-ui` | **真目录**（`Attributes=Directory`、`IsReparsePoint=False` —— 我核过），与 tarball **27/27 逐字节相同、无多余文件**（引自 t4/t5）；`package-lock.json` 记的 `integrity` 与实际 sha512 一致（引自 t4） |
| 库侧 A0 判据 | A0-1 / A0-2 / A0-3 各带自检段；库 `dist` 是库 `src` 的忠实产物（24/24 逐字节 —— 引自 t5 的重编比对） |

**工作区变更面（`git status --short` 原文，收工时）**

```
 M docs/API.md
 M docs/PLAN-deer-ui.md
 M docs/UI.md
 M README.md
 M package.json
 M src/ui/kit/Dialog.tsx
 M src/ui/kit/Form.tsx
 M src/ui/kit/HoverTip.tsx
 M src/ui/kit/index.ts
 M src/ui/kit/pcmode.ts
 M src/ui/kit/primitives.tsx
 M src/ui/kit/scrub.tsx
 M src/ui/tabs.tsx
 M src/ui/tooltip.ts
 M tests/run-tests.ts
 M tests/tsconfig.json
 M tests/ui-kit.test.tsx
?? package-lock.json
?? tests/deerui-bridge.ts
?? tests/ui-fork.test.ts
?? vendor/
```

> 前 13 个 ` M` + 4 个 `??` 是 t3 的消费改动（本轮开工前就是这些，t4/t5 复核过逐字一致）；
> **本轮文档同步只加了前 4 个 `docs/`+`README` 的 ` M`**。**应用侧一个提交都没做。**

### 10.3 与本方案的逐条偏差

| # | 方案怎么写 | 实际怎么做 | 影响 |
|---|---|---|---|
| ① | Q2 默认：**P0–P4 单仓 `packages/deer-ui/`**，**P5 再拆仓**；Q3 默认包名 **`@deerluu/deer-ui`** | 直接建**独立仓库 `Z:\deer-ui`**（与 `Z:\pixelcraft` 平级 = Q1 的默认位置）；包名用的是**裸 `deer-ui`** | 等于提前采用了 Q2 的「从 P0 就建独立仓库」那一支；本仓**没有** `packages/` 目录。好处是双仓漂移（R7）从第一天就有物理边界，代价是 P5 的「`npm pack` 消费链」被提前做掉一部分（`deerui-0.1.0.tgz` + `file:` 安装）。**包名**：`private: true` + 不发 npm ⇒ 裸名被占用不构成冲突（库 README 写清了「真要 `npm publish` 必须换名，候选 `@deerluu/deer-ui`」），所以 Q3 的 scope 名没用上 |
| ② | P0b 复制 **10 个文件 / 1,074 行**（含 `demo.tsx` → 库 `src/demo.tsx`，Q8） | 库 `src/` **9 个文件**；示范页只以 `examples/demo.tsx` 存在（逐字节复制 + 1 行 import 改动），**不进 `src/`、不进 barrel、不进 `files`、不进 `dist`**，库测试**不渲染它** | Q8 的「双副本窗口」实际**没有开**（比方案更干净）；代价是库侧没有「控件演示级」回归，那 6 条 `ui.demo.*` 仍留宿主读 `src/ui/kit/demo.tsx`（P7 才删）。**注意：库仓确实有 `examples/demo.tsx`（tracked，`kit.examples.*` 四条判据要求它存在），别写成「库内没有 demo」** |
| ③ | P6：`src/ui/kit/` 下 **7 个实现文件删除**、`tooltip.ts` 删除、`tabs` 改 import | **一个文件都没删**：9 个公开路径（7 个 kit + `tabs.tsx` + `tooltip.ts`）**全部保留为薄再导出层** | 「删文件」不是本轮验收项，而且删了就要动 import 路径与测试路径；代价是 P7 的「删目录」仍欠着，且「薄层里偷偷写回实现」只能靠 `uifork.thin.*`（要求文件里只剩一行 `export *`）抓 |
| ④ | A0-1：先按现状写 **8 项白名单** + 一条 TODO 断言记录 3 处越界，P0b 再收到 4 项 | 库侧一次到位：白名单 = `react` / `react-dom` / `react-dom/*` / `react/*` + **库内相对路径**（必须解析得到、不得越出 `src/`），并带自检段 | 更严（`../*` 只许库内、且要求可解析）；「先红后收」那一步被跳过，等价的越界证据在库仓 `a0-purity.test.ts` 的自检段 |
| ⑤ | P5：`CHECKSUMS.txt` + `scripts/sync-deer-ui.sh --check` 进 verify 门禁；`scripts/deerui-vendor.sh` 是换版本唯一入口 | **都没做**。换版本目前是「库仓 `npm run pack:vendor` → `cp` 进 `vendor/` → `npm i file:...`」的人工三步 | R7 的机器判据暂缺（见 10.5-3） |
| ⑥ | §4.5 的产物级断言「`:root{` 与 `.dlg{` 各恰好一次」「库段在应用段之前」（P2 的拼接） | **P1 / P2 整期没做**：`src/ui/style.css` 仍是唯一样式表、产物 `app2/www/css/style.css` 一个字节没动 | 库**不发 CSS**（`uifork.css.not-shipped` / `uifork.css.app-only` 两条断言钉住）；`sideEffects: ["*.css"]` 留在库 `package.json` 里占位 |
| ⑦ | P3（图标契约 / i18n 注入 / 防分叉门禁脚本）、P4a / P4b（几何 / `uibar` 算法段）、P6.5（`UiHost` 接线）、P8（第二宿主） | **全部顺延**，一条没做 | 防分叉**门禁的等价物**已经落地，但落点不同：不是 `scripts/check-ui-fork.mjs` + 四条，而是 `tests/ui-fork.test.ts` 的 **29 条** `uifork.*`（薄层 / 同名实现 / 公开面 / React 单实例 / 安装形态 / tarball 指纹 / tooltip 单源 / CSS 归属） |
| ⑧ | R6：**先补行为断言再搬**，关键路径留**黄金 md5**（`ui.dialog.golden-md5` / `ui.keep.wraps` / `ui.cfm-layer.present`） | **一条都没落地**（全仓 grep `golden-md5|keep.wraps|cfm-layer` = 0 命中） | 本轮改用三件**更强**的事替代：库源码与应用 HEAD **逐字节同一**（9/9）、库 `dist` 是库 `src` 的**忠实产物**（24/24 逐字节）、**注入负例**（改库产物一个 class 名 → `ui.dialog.foot` 当场红）。但 R6 点名的**剩余风险**仍在，见 10.5-7 —— **不许写成「已覆盖」** |
| ⑨ | 计数纪律（Q13）：应用侧 **≥ 8090**、`ui.*` 只增不减 | 成立：8090 → **8119**，`ui kit` 仍 **70**、无删除、无改名、无放宽 | 62 条与库侧同名的断言**没有删**（照 P6 的删法会掉到 8028）；它们现在经薄再导出层**直接跑库里的实现**（双跑窗口按 Q8/§2.5 继续） |
| ⑩ | §7.1 R7 的负例口径 | 「改一个字节 → `--check` 退出码 1」 | 脚本还没写，负例换成「改 tarball 指纹 / 移开安装树 → 断言必红」（见 10.6）。**另一条口径更正**：任务书里曾写体积阈值 **+4 KB**，方案 §4.5 的原文是 **≤ 基线 + 2 KB**，以方案为准 |
| ⑪ | 采纳 Q8 的「库复制 `demo.tsx`、库测试渲染它」 | 示范页留 `examples/`、库测试不碰它 | t4 的 F5 曾据此判「Q8 没执行」——**事实更正见本条 ②**：库内**确实有** `examples/demo.tsx`（tracked，`kit.examples.*` 四条判据要求它存在），只是不进 `src/`、不进 barrel、不进 `files`、不进 `dist`，且库测试不渲染它 |

### 10.4 三条口径更正（正文已按此改，见文首口径说明）

`ui kit` **112 → 70**、`i18n` **34 → 8**（34 其实是 `expr` 小节的条数）、`uibar` **97 → 104**（97 只是 `uibar.*` 前缀那部分，同小节另有 7 条 `act.list.*`）。
根因是原稿**按前缀计数**，而断言名会跨小节；现在文首写死了「按 `--- 小节名 ---` 分段数 `ok ` 行 + 总数与 `assertions:` 一致」这条数法。
`uibar` 那张进库/留宿主的前缀表**逐项数也已漂移**（`layout` 9→7、`move` 15→13、`top` 18→17、`session` 14→19），P4b 开工时必须按运行期断言名重算。

### 10.5 已知缺口与后续待办（**不是本轮缺陷，但别让它们消失**）

> **第二轮（§10.7）的收卷情况**：**第 1 条已收**（库补了 lockfile、CI 恢复成真文件，且在无宿主目录里跑绿了四步）；
> **第 2 条仍开着**（「安装树 == vendor tarball」没有断言，第二轮只做了人工逐字节核对）；
> 第 3 / 4 / 5 / 6 / 7 / 8 条**原样仍在**（第二轮没有碰它们）。

1. **（缺口，第二轮已收）库仓的 CI 当时跑不起来**：`Z:\deer-ui\.github\workflows\ci.yml` 写的是 `npm install`，但库仓**没有 lockfile**（我核过），
   本机**离线装不上依赖**（库 README 记的实测：`npm error … cache mode is 'only-if-cached'` / `ENOTCACHED`）；
   库的实际开发姿势是 `scripts/link-dev-deps.mjs` 把平级 PixelCraft 的 `node_modules` 以 **junction** 链进来
   （我核过：库 `node_modules/` 下 8 个条目**全是 junction**，指向 `Z:\pixelcraft\node_modules\*`）。
   这与本仓库审计出的「**门禁其实跑不起来**」**同类**（本仓 `scripts/run-tests.sh` 里的 `node_modules/typescript/bin/tsc.js` 在本机不存在，见 §7.2 D5）——
   **不得在新仓库重演**：库侧 CI 要么补 lockfile 后在有网络的环境真跑一次，要么把「本机怎么跑」固化成脚本（tsc 那一段已由 `scripts/tsc.mjs` 三级查找解决）。
2. **（缺口）没有断言钉住「安装树 == vendor tarball」**（medium）：就地改 `node_modules/deer-ui/dist` 里**不影响导出面与渲染标记**的东西，8119 会全绿，而 `app.js` 打的就是被改那份。
   现在只有 `uifork.vendor.{exists,bytes,md5}`（锁 tarball 自己）与 `uifork.install.*`（锁安装形态）。建议后续在 `ui-fork.test.ts` 加**逐字节比对**。
3. **（缺口）应用侧的 R1 / R7 机器判据仍是人工的**（medium）：应用仓**没有 `.github/`**（`Test-Path .github` = False，我核过）、
   没有 `app.js` **体积断言**、也没有 `deerui-vendor` 同步脚本 / `CHECKSUMS.txt`。
4. **（缺口）`src/engine/expr.ts` 已成宿主死代码**（low-med）：产物里没有它（我的 metafile 基线/现在对比可直接看到），全仓只剩 `tests/expr.test.ts` 引用
   （`tests/ui-kit.test.tsx:192` 那处是纯度黑名单**字符串**，不是 import）。
   ⇒ **R11 对 `expr` 的「双份内联、接受重复」登记前提已失效**，后续期要决定「删宿主那份」还是「把断言迁进库」。
5. **（缺口）文档 / 注释的过时残留**（low）：`docs/UI.md` 的 §1 目录树 / §1.1 白名单 / §5.3 / §7 最后一行**本轮已同步**；
   但 `src/ui/base.tsx:3` 与库 `dist/kit/primitives.js` 里**各留着一句「实现住在 `src/ui/kit`」的过时注释**（库源码那份在 P0b 时就带着）——
   属**注释级**、不影响行为，改它要重出一次 tarball，本轮不做（登记给 P7）。另 `docs/UI.md` §3.1 的「5 分区」与 `style.css` 的漂移（D6）**仍未修**。
6. **（登记不修）8 个薄层文件缺结尾换行**（low）：`src/ui/kit/{index,primitives,scrub,Dialog,Form,HoverTip,pcmode}` + `src/ui/tooltip.ts`
   的末字节是 `;`（59），而对应 HEAD blob 的末字节是 `\n`（10）—— 我逐个读过两侧字节，且 **7 个 kit 薄层现在都恰好 325 B**（`tabs.tsx` 153 B、`tooltip.ts` 347 B）。
   `git diff` 因此多出 `\ No newline at end of file`。`uifork.thin.*` 会过滤空行，所以**不影响任何断言**，但既然后面还有集成轮，顺手收掉更好。
7. **（R6 的剩余风险 → 库侧 P1 的验收项，不许写成「已覆盖」）**：公开组件 `Keep` 至今**零直接断言**；`ScrubNum` 的**键盘 / 指针**路径、`tabs` 的**滚动 / portal** 行为**没有黄金 md5 兜底**。
   本轮的「逐字节同一 + `dist` 忠实 + 注入证明行为断言真跑库实现」三条**证不到**上面这三处细节 —— 它们要在库侧单独立验收项。
8. **（供应链与版本）** `package-lock.json` 是本轮 `npm install file:vendor/…` 的副产物，出现在应用仓根（`?? package-lock.json`）、**未提交**，
   与 D4 的「仓库没有任何 lockfile」既有口径冲突 → 处置（提交 / 加 `.gitignore` / 删除）留给队长。另：`npm ls react` 与「干净 checkout + 真 `npm install` 走一遍」**都没跑**，`[待验证]`。

### 10.6 公开面差异与负例（评审留档）

- **公开面差异 1 项：`TipPoint`** —— 库的类型导出里多了一个 `TipPoint`，**全仓 0 引用**
  （我核过：`src/` / `tests/` / `scripts/` / `toolchain/` 一处都没有），**不影响行为**，t5 判 pass。
  它是「**待登记的公开面差异**」，后续期决定保留还是删 —— **不要写成「公开面完全守恒」**。
- **负例（七组，就地恢复，每组恢复后 8119 ALL PASS；①–⑥ 由 t4 做、t5 复核并加做 ⑦ —— 引自两份报告，本轮未重跑故障注入）**：
  ① 薄层写回实现 **+** 别处放同名实现 → `FAIL uifork.thin.kit/primitives.tsx` + `uifork.no-fork.kit`；
  ② 真第二份 React → `FAIL uifork.react.single-instance-react`（打印 got/want 两条解析路径）+ `no-nested-install`；
  ③ **只把 `vendor/deerui-0.1.0.tgz` 改名 → 构建不会失败**（产物仍逐字节等于发货产物，因为构建读的是**已安装**的 `node_modules/deer-ui`），红的是 `uifork.vendor.{exists,bytes,md5}`；
  ③b **再**把 `node_modules/deer-ui` 移开 → 重建才红在 `✘ [ERROR] Could not resolve "deer-ui/kit"`（指 `src/ui/kit/index.ts:4`，`tabs` / `tooltip` 同）；
  > ⚠️ **两个名字差一个连字符，别记混**：`package.json` 里的**包名/安装目录**是 `deer-ui`，而 vendor 里的 **tarball 文件名**是 `deerui-0.1.0.tgz`。
  ④ 越界 import → `FAIL ui.kit.purity`；⑤ junction 安装 → `FAIL uifork.install.real-dir`（`isDir=false link=true`）+ `path-stable`；
  ⑥ 改库产物一个 class 名 → `FAIL ui.dialog.foot`（**证明宿主行为断言真跑在库 dist 上**）；
  ⑦ `ui.kit.purity` 的非空核查：扫 **12 个 dist `.js` / 32 条 import 说明符**，offenders=0，越界样例会红（不是恒真断言）。
  > **③ 的措辞不要再写回「改名 tarball 就会构建失败」** —— 照抄会让人得出「判据不咬人」的错误结论。
  > **§4.5 的产物级断言也已按「选择器 + 声明」重写**：数 `:root{` / `.dlg{` 这类**子串**不算判据 ——
  > 库 CSS 里 `.dlg` / `.panel` / `.rowlabel` / `.btn.off` / `.panel-mask,.dlg-mask` 都是「基础规则 + 变体 / 动画」的
  > **合法重复**，数子串会把合法重复报成「出现多次」，却对「同一条（选择器 + 声明）真出现两次」无感。
  > 正确口径见 `tests/css-rules.ts`（`rulesBag` 多重集合 + `bagHash`）。
- **双跑窗口与 62/8 账目**：`ui kit` 小节的 **70** = 搬进库的 **62** + 留在宿主的 **8**（`ui.demo.*` 6 + `ui.overlay-full-wiring` + `ui.dropmenu.pop-css`）。
  「库侧 == 应用侧 − 8」**只在小节口径下成立**；**按 `ui.` 前缀核是 50**（`ui.i18n.*` 28 / `ui.scale-*` 13 / `ui.icon-*` 2 … 属别的小节却共享前缀）—— 别再用前缀口径。
  另有 **17 条**（不是 12 条）断言的**读数对象**从应用副本换成库产物，逐条见 `tests/ui-kit.test.tsx` 的 diff；其中 `ui.kit.purity` 由 8 项白名单**收紧**为「react/react-dom + 必须解析到包内相对路径」。

---

## 10.7 第二轮执行记录：库独立化 + 样式抽进库（2026-09-20）

> ⚠️ **本节是第二轮的实测记录，第三轮（收尾两轮 + 终检）的权威值见 §10.8**。容易被当现值引用的两处**数值不改**
> （改了就把第二轮的实测抹掉了），但要连着 §10.8 读：
> · 应用侧断言 **8119**（§10.7-3 表里那个数 = **第二轮结束时**的数；第三轮之后仍是 **8134**，见 §10.8-4）；
> · `vendor/deerui-0.1.0.tgz` 指纹 **36,234 B / `d0e943ff…` / `718c5b7b…`**（§10.7-4-②，**已被 §10.8-2 取代**）。
> 引用「当前是多少」时，一律以 **§10.8-4 的数字自查表**为准。

> **这一轮的定位变化比改动本身更重要**：前一轮的成果是「控件实现搬进库、应用留薄层」，
> 库仍然**只有跟 PixelCraft 的检出放在一起才能装、才能测、才能构建**；样式与令牌**整份留在应用**。
> 这一轮把这两件事都收掉 —— 库**不依赖任何应用在场**，且**样式与令牌的唯一来源变成库**。
>
> 库侧两个本地提交（**未 push**，推送由队长做）：`b0f259a`（独立化第一步，13 文件）→ `a5cefbb`（库自带样式，14 文件）；
> 两轮提交后库仓工作区都是干净的。应用侧**一个提交都没做**（全在工作区）。

### 10.7-1 库独立安装与运行（收掉 §10.5-1「库 CI 跑不起来」）

| 改动 | 内容 |
|---|---|
| `+package-lock.json` | 联网 `npm install` 生成并入库：`lockfileVersion 3` / **11 个包** / `resolved` 指向腾讯镜像 / `integrity` 齐。`node_modules/react` 从此是**真目录**，不再是指向 `Z:\pixelcraft\node_modules` 的 junction |
| `scripts/tsc-path.mjs` | **删掉 `../pixelcraft/.../lib/tsc.js` 那条隐式回退** → 只剩 ① 本仓库 `node_modules` ② `$DEERUI_TSC` |
| `scripts/link-dev-deps.mjs` | **默认来源删除**：必须显式给 `$DEERUI_DEPS_SOURCE`（不设就退出码 1），降级为「离线应急」 |
| `-scripts/count-host-assertions.mjs`、`-npm run count:host-assertions` | 「宿主 `ui kit` 70 = 搬入 62 + 留宿主 8」是**应用侧的账**（要读宿主 `tests/ui-kit.test.tsx`、还要链宿主的安装树）→ 移出库，应用侧自己收（本轮应用侧新增 `scripts/count-ui-assertions.mjs`，见 10.7-3） |
| `tests/budget.test.ts` | 门槛换成**库自己的口径**：`ui.*` 控件契约 **≥ 62** + `kit.*`/`lib.*` 判据与基建（当时）**≥ 61**，**分开判**，总 **≥ 123**；删掉 `MIN_HOST_MOVED` 这类应用侧概念（`common.ts` / `run-tests.ts` / `globals.d.ts` / `tsc.mjs` 注释同步）。<br>**注意这块此后又动过一次**：第二轮的样式判据让基建涨到 **72**、总闸门变成 **134**（见 §10.7-3 表与 §10.8-1 —— t7 之前文档里写「≥ 61」是把这一轮的中间值当成了现值） |
| `.github/workflows/ci.yml` | 恢复成**真文件**（`npm ci` → `typecheck` → `build` → `test` → `check:dist`），删掉 `.github/ci.yml.example` |

**验证（都是真跑，不是推断）**：

| 环境 | 结果 |
|---|---|
| 仓库内 `npm ci`（10 包） | `npm test` **123 / ALL PASS** → `npm run build` → `check:dist` OK → `typecheck` 退出码 0 |
| `%TEMP%\deerui-standalone`（robocopy 排除 `node_modules`/`.git`/`dist`/`.ts-out`，**旁边没有 pixelcraft**） | `npm install`（`--cache` 指向全新缓存，真下载 5.55 MB / 22 项）→ `test` 123 / ALL PASS → `build` → `check:dist` **24 文件** OK → `typecheck` 0 |
| **更强一条**：`git clone Z:\deer-ui %TEMP%\deerui-clone`（无 `node_modules`） | `npm ci` → 四条闸门全绿 ⇒ **提交进去的那份是可独立跑的**（不是「靠工作区里没提交的东西跑起来的」） |
| 负例 | `%TEMP%` 副本里 `npm run link:devdeps` **不设来源** → 退出码 1 |

### 10.7-2 样式与令牌抽进库（收掉 §10.3-⑥「P1/P2 整期没做」）

- 库 `src/styles/tokens.css`（`:root` + `[data-theme="light"]`，**逐条原样**从应用 `src/ui/style.css` 搬来，
  只把行尾从应用工作区的 CRLF 归一成 LF）+ `src/styles/kit.css`（**83 条**只属于 kit 的控件规则 + **7 个** `@keyframes`）；
  `scripts/build-styles.mjs` 逐字节拼成 `dist/styles.css`，`exports` 加 `"./styles.css": "./dist/styles.css"`。
- **判定规则**：按「组件真的渲染出哪个 class」判，不按名字像不像（R1 令牌块 → 库；R2 普通规则**整条原子**，
  选择器里的类名有一个只有应用在用就留应用；R3 纯元素选择器分页面外壳 / 库组件；R4 `html[data-pc] …` 留应用；
  R5 `@keyframes` 按被谁引用；`@media` 整块留应用）。完整规则与两份清单见库 `README.md`「库自带样式」。
- **对账（不重不漏）**：应用 `src/ui/style.css` 拆分前 **876 个顶层块 = 831 规则 + 34 `@keyframes` + 11 `@media`/其它**；
  **进库 92 项（85 规则 + 7 `@keyframes`）+ 留应用 784 项（746 + 27 + 11）= 876**；85 + 746 = 831 账平；
  两边规则键多重集合**无交集**；产物里 92 条规则的**原文**全部命中原样式表（0 处不符）。

### 10.7-3 应用改为消费库的样式（P6）

| 项 | 实测 |
|---|---|
| 应用 `src/ui/style.css` | **删掉** `:root` / `[data-theme="light"]` 与全部 kit 规则（**只剩业务规则**：外壳 / 业务面板 / 画布 HUD / 覆盖层 / PC 密度覆写 / `@media`） |
| 产物拼接 | 新增 `scripts/build-css.mjs`：`deer-ui/styles.css`（库段）+ `src/ui/style.css`（应用段）→ `app2/www/css/style.css`，**库段在前、应用段在后**，写完**再读回来验一遍顺序**（不满足退出码 1、不留半成品），库段解析不到就**大声失败**（不给自己留「找不到就用别处副本」的退路）。`build-web.sh` / `build-ui-demo.sh` 都改成走它，**都不再 `cp` 源文件** |
| 视觉零变化的机器判据 | 新增 `tests/css-rules.ts`（解析口径：**按「选择器 + 声明」的扁平规则多重集合**，不按子串出现次数）+ `tests/ui-css.test.ts`（**+10 条**）：库段 ∪ 应用段的多重集合 `sha256` **等于拆分前那份**（`98e94d6cbe535281…`，差异 **0**）、应用侧不再有令牌块、应用侧不再有库的选择器、产物两段顺序与「不许有第三种来源」。`tests/ui-tokens.test.ts` 改成在**两段的并集**上判（令牌齐 / 引用都能解 / shell 不写裸色），判据一条没松 |
| 应用侧记账收回 | 新增 `scripts/count-ui-assertions.mjs` + `npm run count:ui-assertions`（`ui kit` 小节 70 = 搬入 62 + 留宿主 8，交叉校验 + 可从运行日志复核）；`package.json` 另加 `build:css` |
| 断言数 | **8119 → 8134**（+15，含 `uicss.*` 10 条；**名字级「基线有、现在没有」= 0**，一条没消失、没有放宽） |
| 产物 | `app2/www/js/app.js` **逐字节不变**（本次只动样式来源，JS 依赖图未变） |

### 10.7-4 本轮暴露的**四个真问题**（写进档案，别只活在任务记录里）

**① `vendor/deerui-0.1.0.tgz` 的静默落后（本轮的导火索）**：库已经改了两轮，而应用的 vendor tarball
**还是第一轮那份**（`26932 B`：没有 `dist/styles.css`、`exports` 里没有 `"./styles.css"`）——
**没有任何机制会提醒重打**，构建脚本、测试、CI 都不会红（`uifork.vendor.*` 只锁 tarball 自己的指纹，
而指纹是「照当时那份」记下来的）。
**本轮补救**：库 `npm run pack:vendor` 重打 → 覆盖 `vendor/deerui-0.1.0.tgz` → 把 lock 里 `deer-ui` 的
`integrity` 换成新值 → 删掉 `node_modules/deer-ui` 再 `npm install --legacy-peer-deps`。
**待建的后续**：同步 / 校验脚本 + **两层断言** —— ⑴ `node_modules/deer-ui` == `vendor/*.tgz`（逐字节），
⑵ `vendor/*.tgz` 对应**库的哪个提交**（把库的 sha 写进一个随包的清单，或干脆让 vendor 文件名带 sha）。

**② 同一个版本号 `0.1.0`、tarball 内容却变了**（三处指纹 + lock 的 integrity，全记在这里）：
> ⚠️ **下表是第二轮的指纹，已被 §10.8-2 取代**（第三轮把 `README.md` / `package.json` /
> `dist/kit/primitives.js` 又改了一次，重新 pack 后指纹变成 40,278 B / `0102c063…` / `0e2e8ee1…`）。
> 把这张表当现值引用会得到「照 README 重打却对不上数」的错误结论 —— **现值见 §10.8-2**。

| 位置 | 值 |
|---|---|
| 库侧 tarball `Z:\deer-ui\deerui-0.1.0.tgz` | **36,234 B** / md5 `d0e943ff79298a8851c6a4ccf465623d` / sha256 `718c5b7bb5d0800315af033d63d7401007dda3e2adf53081a91c23a5198ef309` |
| 应用侧 `vendor/deerui-0.1.0.tgz` | **与上面逐字节相同**（同 bytes / md5 / sha256） |
| `node_modules/deer-ui/dist/styles.css` | **17,790 B** / sha256 `f078e80a04fbe4926f08cacab3524c26e2fc9dedd86aef94a42acc8f18f7b1b3`（= 库内 `dist/styles.css`，**逐字节相同**）；安装树 `dist/**.js` **12 个**、`exports` 五个子路径齐全 |
| `package-lock.json` 里 `node_modules/deer-ui` | `integrity: sha512-hLDmVYKs0z1t2MCXM6DU2vT8oicY6FqWxkLG5+WNQLdInXr4JA3y8gshh3SYohHkLYgaJ0Fl+myhW/Lmpn5YMg==`、`resolved: file:vendor/deerui-0.1.0.tgz` |

> **同版本换包的陷阱（实测）**：直接 `npm install` 会**从缓存**拿出旧包 —— 装完 `node_modules/deer-ui` 里
> 仍然没有 `styles.css`、lock 也没变。破解：**先在 lock 里把 `deer-ui` 的 integrity 换成新值**（或删掉
> `node_modules/deer-ui`），再装；装完必须**逐字节核对**安装树的 `dist/styles.css`。

**③ 库把「应用外壳域」的令牌整块吞了进去（队长独立发现，本轮最值得记的一条）**：
库 `:root` / `[data-theme="light"]` 一共定义 **143 个**令牌，而**库自己的规则只引用 34 个**；
未引用的 **109 个**里 **93 个只有应用在用**（`--orb-fg` / `--dock-bg` / `--sym-strong` / `--hud-*` /
`--guide-shade` / `--pie-mask` / `--set-item-*` / `--railw` / 安全区 `--sat…`），另 **16 个谁都不用**。
⇒ 库的样式里有**一件并不属于它**的东西（应用外壳 / 画布 HUD / 引导层的令牌），这与「库要独立」相抵：
库替一个它不认识的宿主维护了一批它不用的变量。
❗ **「多重集合等价」这类判据抓不到这个问题**：整体搬走、并集不变，`bagHash` 照样相等 —— 它证的是
「视觉零变化」，不是「归属正确」。**建议的后续**：把库的令牌收敛到它真正引用的那批（34 个 + 少数几处
应用**必须**从库拿的基础令牌），其余**回到应用 `:root`**，再做一轮等价验证。
**本轮不做**：改令牌归属要同时改两边的 `:root` 与令牌断言，属独立一轮。

**④ 两个会咬人的坑（别只活在任务记录里）**：

| 坑 | 症状 | 正确做法 |
|---|---|---|
| 删 junction **不能**用 `Remove-Item -Recurse` | 会**跟进目标**把宿主 `node_modules` 里的真目录删掉（库侧 8 个条目全是指向 `Z:\pixelcraft\node_modules\*` 的 junction） | 逐个 `cmd /c rmdir <路径>` |
| PowerShell 的 `>` 重定向是 **UTF-16** | 用它写出的 `package-lock.json` 让 node 报 `SyntaxError`（`ConvertFrom-Json` 也会报 name 无效） | 用 `cmd /c` 重定向，或 `Out-File -Encoding utf8` / node 自己写 |
| 行尾 | 应用工作区是 **CRLF**、库仓库一律 **LF**：直接比字节会假红 | 比之前 `lf()` 归一；库生成的样式产物**统一 LF**（跨平台可复现），逻辑见库 `scripts/build-styles.mjs` |

### 10.7-5 与方案的逐条偏差（第二轮）

| # | 方案怎么说 | 实际怎么做 | 影响 |
|---|---|---|---|
| ① | §4.5 产物级断言：`:root{` 与 `.dlg{` 在产物里**各恰好一次**；用 P1 的机器锚点 `/* deer-ui:kit-controls:start */` 判库段位置 | 锚点**没做**；位置判据改成**按内容**（两段原文都要在产物里逐字出现、且库段偏移更小，`build-css.mjs` + `uicss.artifact.order` 各判一次）。**「各恰好一次」按子串数**这条**判据本身是错的**（库 CSS 里 `.dlg` / `.panel` / `.rowlabel` / `.btn.off` 都是合法重复），已按「选择器 + 声明」重写 | 判据更严也更准；`§4.5` 与 `§10.6` 的旧措辞已就地更正 |
| ② | Q5 默认 **方案 (C)**：保留应用 `:root` 与 `2/5 base` 锚点不动、**库 CSS 只做尾部注入**、测试一行不改 | 走的是**方案 (B) 的变体**：库段**在前**、应用段在后；应用那份 `:root` / kit 规则**整条删除**（不是「留个空锚点」）；`tests/ui-tokens.test.ts` 改成读**两段的并集** | 顺序与 Q5-(C) **相反**（(C) 是「应用在前、库在后」）。理由：同优先级下**后写的赢**，库段在后会让库的基础规则盖住应用的外壳覆写；现在应用在后 ⇒ 应用仍能覆写库。代价：`ui-tokens` 的读数对象变了（判据一条没松） |
| ③ | §7.1 R12-6：P2 验收要「新增产物级断言：拼接产物里库段必须在应用段之前」 | **做了**，但落点不是新断言名，而是 `build-css.mjs` 的**写后自检**（构建期，硬失败）+ `tests/ui-css.test.ts` 的 `uicss.artifact.order`（测试期） | 比方案的「只加一条断言」更强：**构建期就不产出顺序错的产物** |
| ④ | §5.2 P1：先给 `style.css` 划物理边界（重排 + 机器锚点，声明零改动） | **P1 整期跳过**：直接做 P2（拆样式） | 少了一轮「只重排不改声明」的纯机械步骤；代价是没有「拆分前先划清边界」的中间态可核对 —— 等于用**多重集合等价**（库 ∪ 应用 == 拆分前）替代了物理锚点。缺口：**归属正确性没有机器判据**（见 10.7-4-③） |
| ⑤ | §5.2 P7：删应用侧残留（`src/ui/kit/demo.tsx` 副本、薄层末行换行） | **没做**（`ui.demo.*` 6 条仍读应用副本；8 个薄层文件仍缺结尾换行） | 与第一轮同欠；本轮新增一条注释级残留（库 `src/kit/primitives.tsx` 与 `dist/kit/primitives.js` 里那句「实现住在宿主 `src/ui/kit`」） |
| ⑥ | §4.3 / N17：CI 不要应用在场 | **成立**，且从「示例文件」变成**真文件**：`b0f259a` 把 `.github/ci.yml.example` 改回 `.github/workflows/ci.yml`（库已有 lockfile，不再有「跑不起来」的理由） | 本机**没有**真跑过 GitHub Actions；「CI 能跑」的证据是**在无宿主目录里把四步逐条跑绿** + YAML 语法自检，属 `[待验证]`（与 §10.5-1 的旧缺口同性质，弱化成「未在 CI 服务上跑过」） |
| ⑦ | 迁移期「应用侧断言恒 ≥ 8090」 | 成立：**8119 → 8134**，`ui kit` 小节仍 **70**、无删除、无改名、无放宽 | 本轮新增的 10 条 `uicss.*` 是**新判据**，不是替换 |

### 10.7-6 仍存缺口（**不是本轮缺陷，但别让它们消失**）

1. **没有断言钉住「安装树 == vendor tarball」**（§10.5-2 的旧缺口仍在，medium）：就地改
   `node_modules/deer-ui/dist` 里不影响导出面与渲染标记的东西，8134 会全绿，而 `app.js` 打的就是被改那份。
   现在只有 `uifork.vendor.{exists,bytes,md5}`（锁 tarball 自己）与 `uifork.install.*`（锁安装形态）。
   **本轮的「逐字节核对」是人工做的**（见 10.7-4-②），没有进断言。
2. **令牌归属错误没有机器判据**（10.7-4-③，medium）：多重集合等价证不到「这东西该不该在库里」。
   需要一个新判据（例如「库 `:root` 里每个令牌都至少被库规则引用一次」+ 一份显式的「允许留在库里的令牌」清单）。
3. **`.github/workflows/ci.yml` 未在真 CI 服务上跑过**（§10.7-5-⑥，low-med）：本机是「无宿主目录里跑四步」。
4. **库测试的 134 是下限不是精确值**（low）：`budget.test.ts` 判的是 ≥ 62 / ≥ 61，总数随判据增加而涨；
   写文档时请以 `npm test` 输出的 `assertions:` 为准。
5. **P3 / P4a / P4b / P6.5 / P7 / P8 仍全部顺延**（与第一轮同）：图标契约、i18n 注入、纯几何、`uibar` 算法段、
   `UiHost` 接线、删应用侧残留、第二宿主。
6. **`src/ui/kit/demo.tsx` 的应用侧副本还在**（P7 才删）：`ui.demo.*` 6 条断言仍读它，因此它**不能**先删。
7. **R6 的三处行为细节仍无兜底**（`Keep` 零直接断言、`ScrubNum` 键盘 / 指针、`tabs` 滚动 / portal）——
   与本轮「样式零变化 + 库独立」两条判据**都无关**，别把它们记成已覆盖。
8. **模板里的 `:hover` / 移动端 `@media` 覆写顺序没被验过**：库段在前保证了「应用能覆盖库」，
   但**反过来**（库的 `@media` 或 `html[data-pc]` 规则去覆盖应用的外壳）本轮没有用例 —— 因为库不自判 PC / 主题，
   这类规则按 R4 全留在应用（属有意设计，不是缺口，记在这里免得下次有人「顺手挪一条进库」）。

---

## 10.8 第三轮执行记录：收尾两轮 + 终检缺陷（2026-09-20）

> **这一轮没有新功能，只有「把承诺变成真的」与「把上一轮蒙住的地方补上判据」。**
> 两轮收尾：**t7 库侧**（让 README 的安装承诺为真）与 **t8 宿主侧**（vendor tarball 重打 + 三条指纹同步），
> 之后队长做了一遍终检，抓出 **4 处缺陷**（§10.8-3）。这一节的价值主要在**§10.8-3 与 §10.8-5**：
> 记清「这些缺陷是怎么混过前两轮验收的」——那 4 条都不是实现错，而是**承诺没人验**。

### 10.8-1 t7：库侧收尾（提交 `e2bc5d4`，未 push）

| 项 | 改前 | 改后 |
|---|---|---|
| `package.json` 的 `scripts` | 只有 `prepack`（= `build` + `check:dist`） | 加 **`"prepare": "npm run build"`** —— npm 从 git 装时**只有 `prepare` 会跑**，`prepack` 不跑；`dist/` 又被 `.gitignore` 忽略、从未入库 ⇒ 改前 `npm i github:DeerLuuu/deer-ui` 装出来**只有 `README.md` + `LICENSE` 两个文件**（没有一行 JS/CSS） |
| 库 `README.md` 的预算下限 | `kit.*`+`lib.*` **≥ 61** | **≥ 72**（对齐 `tests/budget.test.ts` 的 `MIN_INFRA = 72`；`MIN_CONTRACT = 62`、`MIN_TOTAL = 134`） |
| `src/kit/primitives.tsx:3` 的注释 | `// Lives in src/ui/kit so the whole library can be moved out later…`（说的是**宿主**的路径） | `// The implementation lives **here**, in this repository's `src/kit/` … Consumers import it as `deer-ui/kit`; a second copy … is a fork, not a re-export.` |

**t7 的实测（干净克隆模拟，全部在 `e2bc5d4` 上跑）**：

| 情形 | 命令 | 结果 |
|---|---|---|
| 克隆后装 | `git clone Z:\deer-ui <tmp>` → `npm install` | install 前**没有** `dist/`；`prepare` 自动跑 build（`[deer-ui] dist/styles.css：17790 B / 92 条规则 / 326 行`），`added 10 packages`，exit 0 → `dist/` **25 个文件**，`dist/styles.css` sha256 = `f078e80a…`（与库仓库一致） |
| 克隆内打包 | 接上一步 `npm pack` | `deer-ui-0.1.0.tgz` **28 个条目**，`package/dist/index.js`、`package/dist/styles.css`、`package/README.md`、`package/LICENSE` 全在；tgz 内 `dist/styles.css` sha256 = `f078e80a…`（17790 B） |
| 消费者（默认 / `--omit=dev`） | 消费者项目里 `npm i git+file:///Z:/deer-ui`（两档） | **两档都成功**（added 6 packages）：`node_modules/deer-ui/dist/index.js` + `dist/styles.css` 都在、sha256 一致、`exports["./styles.css"] = "./dist/styles.css"` |
| 反例 | 库仓库自己的树 `npm ci --omit=dev` | **退出码 2**（`[deer-ui] 找不到可用的 tsc…`）：`prepare` 要 devDependencies 里的 `typescript` |

> ⚠️ **口径**：以上是**本地克隆模拟**（`git clone Z:\deer-ui` / `git+file:///Z:/deer-ui`）—— 库仓库**尚未 push**，
> 远端默认分支 HEAD 还是 `bce2647`，所以**不是**对真 GitHub 远端的验证。库 README 的「从 git 装」一栏已写明这条。

### 10.8-2 t8：宿主侧收尾（重打 tarball + 三条指纹）

对齐的库 HEAD = **`9fa9de3`**（= t7 的 `e2bc5d4` + t10 的 `.gitattributes`），`git status --short` 为空。

| 指纹 | bytes | md5 | sha256 |
|---|---:|---|---|
| **新 `vendor/deerui-0.1.0.tgz`**（= 库树 pack = 干净克隆 pack，**三者逐字节相同**） | **40278** | **`0102c0631caacf357751e31e807cecc3`** | **`0e2e8ee130ffaeb88ba547082bf285ef16f1b6770f4aa7027b6f3f0e3199d444`** |
| 第二轮的 vendor（§10.7-4-② 记的那份，**改前**） | 36234 | `d0e943ff79298a8851c6a4ccf465623d` | `718c5b7bb5d0800315af033d63d7401007dda3e2adf53081a91c23a5198ef309` |
| 第一轮的 vendor（`git show HEAD:vendor/…`，只作归属参考） | 26932 | `1e9c0d79952e7a3ac5cb82a4ecd1af98` | `c991ab50ea2d2618b9d13160d7cf606a430064423adb2e01538e8ebf6881d1c2` |

`package-lock.json` 里 `node_modules/deer-ui` 的 `integrity`（SRI）改成
**`sha512-ZGFy01rDqDW5rMUi1OjiTMKxqqhKafVOWmsyQ/i3ehnNjFTDosB+ZIqPJEuVyaZxxedip0Ua4eAFKNB2+s3Dpw==`**，
`resolved` 仍是 `file:vendor/deerui-0.1.0.tgz`。

**`tests/ui-fork.test.ts` 的三个常量（改前 → 改后）** —— `HEAD` 里只有前两个，第三个是 t8 新加的
（同一个 tarball 的 md5 不够用时用 sha256 兜底）：

| 常量 | `HEAD`（第一轮值） | t3 之后到 t8 之前的磁盘值 | **现在** |
|---|---|---|---|
| `VENDOR_BYTES` | `26932` | `36234` | **`40278`** |
| `VENDOR_MD5` | `"1e9c0d79952e7a3ac5cb82a4ecd1af98"` | `"d0e943ff79298a8851c6a4ccf465623d"` | **`"0102c0631caacf357751e31e807cecc3"`** |
| `VENDOR_SHA256` | **（不存在）** | `"718c5b7bb5d0800315af033d63d7401007dda3e2adf53081a91c23a5198ef309"` | **`"0e2e8ee130ffaeb88ba547082bf285ef16f1b6770f4aa7027b6f3f0e3199d444"`** |

**逐条目差异（相对第二轮那份 36234 B 的 tarball）**：28 条 → **相同 25、变了 3**，全部落在允许的文档 / 注释级：

| tarball 内条目 | sha256 改前 → 改后 | 字节 | 首异行 |
|---|---|---:|---|
| `package/dist/kit/primitives.js` | `46f82472a498…` → `b6846a2e72fe…` | 6026 → **6183** | 第 4 行（那句「实现住在宿主」的注释，见 §10.8-1） |
| `package/package.json` | `ac8b7a9dc1a0…` → `cfc4edd06607…` | 1869 → **2021** | 第 5 行（`description` 改成库自身定位） |
| `package/README.md` | `90c1754d1566…` → `5d15d9de25c5…` | 23495 → **32189** | 第 3 行（宿主视角 → 库视角，见 §10.7 与 §10.8-1） |

**不变式（t8 的硬约束，本轮独立复核过）**：`package/dist/styles.css` 仍是
**17790 B / sha256 `f078e80a04fbe4926f08cacab3524c26e2fc9dedd86aef94a42acc8f18f7b1b3`**，
另外 24 个 JS/`.d.ts` 条目逐条 sha 未变 ⇒ **第二轮的样式等价判据没有被重打包推翻**。
`app2/www/js/app.js` 也**没变**：**1,334,394 B / md5 `3f9db8acbfb76fe38ffaa6c33f875940`**（与 §10.2 一致）。

**本轮新增的人工核对（把 §10.5-2 那条「安装树 == tarball」缺口先手工补上一次）**：
`tar -xzf vendor/deerui-0.1.0.tgz` 解出的 **28 个文件** 与 `node_modules/deer-ui` 下的 **28 个文件**
**文件名面相同、逐文件 sha256 全相同（28/28）**；`dist/styles.css` 三处（库 `dist/`、tgz 内、安装树）
sha256 都是 `f078e80a…`。**注意这仍是人工核对，不是断言** —— 断言待建。

### 10.8-3 四处终检缺陷（每条：症状 / 根因 / 修法 / 落在哪个提交）

> 这四条**没有一条是「实现写错了」**，全部是**承诺与实现脱节**：文档（或注释）描述了一个没人验的状态。
> 更值钱的是下面 §10.8-5 那张表：**为什么前两轮的验收都没抓住它们**。

**① 库 README 的 `npm i github:DeerLuuu/deer-ui` 装出来是空包**

- **症状**：照库 README 装出来只有 `README.md` + `LICENSE`，`node_modules/deer-ui` 里**没有一行 JS/CSS**，`deer-ui/kit` 解析不到。
- **根因**：`dist/` 在库 `.gitignore` 里（从未入库），而 `package.json` 只有 `prepack`（`npm pack`/`publish` 前跑）——
  **npm 从 git 装时不跑 `prepack`，只跑 `prepare`**。README 却把这条写成「三种方式任选一种」。
- **修法**：`package.json` 加 `"prepare": "npm run build"`；README 的安装段补一张「三条路各自谁负责构建」表，
  并把两个反例（库仓库自己的树上 `--omit=dev` 会红；消费者项目里 `--omit=dev` 没问题）写进前提。
- **落地**：库提交 **`e2bc5d4`**。

**② 库 README 的预算下限写 61、常量是 72**

- **症状**：库 README「断言台账与预算闸门」写 `kit.*`+`lib.*` **≥ 61**，与 `tests/budget.test.ts` 的 `MIN_INFRA = 72` 不符。
- **根因**：**把一个中间值留在了文档里**。第二轮加样式判据时，基建从 61 涨到 **72**、总闸门从 123 涨到 **134**：
  同一段的表里写对了（72 / 134），只有正文那句下限没跟着改 —— 而且我（docs-integrator，t6）在**同一句里**
  一边写「≥ 61」一边写「62 + 72 = 134」，**自相矛盾**却没被任何断言抓住（文档里的数字**没有判据**）。
- **修法**：改成 **≥ 72**（t7）；本任务在宿主侧的 §10.7-1 那一行同时补了「此后基建涨到 72、总闸门 134」的说明，
  免得后来人再把第二轮的中间值当现值。
- **落地**：库提交 **`e2bc5d4`**（宿主侧说明见本节）。

**③ `src/kit/primitives.tsx:3` 仍说「实现住在宿主的 `src/ui/kit`」**

- **症状**：库源码与 `dist/kit/primitives.js` 的头注释写着 `Lives in src/ui/kit so the whole library can be moved out later`——
  与「库是源码真相、宿主是消费者」正好相反。
- **根因**：P0b 从宿主**逐字节复制**时原样带过来的注释（见 §10.7 附的 P0b 落地记录：那次只改 import 路径）；
  t6 已在库 README 的「有意偏离与已知缺口」里**登记**过它（当时判断「改注释要重出 tarball，本轮不做」），
  但**登记不等于修**，而它恰好是「库的自我描述」里最容易被外部人读到的两行。
- **修法**：改写成库视角（`The implementation lives **here** … a second copy … is a fork, not a re-export`）；
  同时**必须重打包**才能进 `dist`（这正是它拖到 t8 才落地的原因）。
- **落地**：库提交 **`e2bc5d4`**；进产物由 **`t8`**（重打 tarball）完成。

**④ 宿主 `vendor/deerui-0.1.0.tgz` 里嵌的 README 是改版前的宿主视角**

- **症状**：库 README 已按库视角改写（`b5d7c51`），但宿主 vendor 里的 tarball **还是改版前那份**：
  内嵌 `README.md` 是 23,495 B 的宿主视角版本、`package.json` 的 `description` 还是「PixelCraft 的 UI 表现层」。
- **根因**：**vendor tarball 的重打没有任何提醒机制**（§10.7-4-① 已把它登记为「静默落后」），
  而这一次的落后面是**文档**：源码级行为一个字节没变，所以测试、构建、`check:dist` **全绿**。
  发现方式是 t6 顺手 `tar -xzf` 看了一眼内嵌 `README.md` 的行数——**纯属巧合，不是判据**。
- **修法**：库侧改完（t7）后由 **t8** 重打：`vendor/` 换成 40,278 B 的新包（内嵌 README 32,189 B / 库视角，
  `package.json` 带 `prepare`）、刷安装树与 lock 的 `integrity`、同步三条指纹常量。
- **落地**：宿主侧（**未提交**，提交由队长统一做）；库侧对应提交 `e2bc5d4` + `9fa9de3`。

**另外一处同性质的缺陷（第五处，队长在终检里单独测出来的，记在这里以免丢）**：

**⑤ 库的打包产物跨检出不可复现**

- **症状**：同一个 commit `a5cefbb`，库**工作区** pack 出来是 **36,234 B / md5 `d0e943ff…`**，
  而**干净克隆**里 pack 出来是 **36,329 B / md5 `c4073bf4…`** —— 28 个条目里只有 3 条不同，差异**全是 `\r`**。
- **根因**：库仓库**没有 `.gitattributes`**，而本机（与多数 Windows 环境）`core.autocrlf=true` 会把文本检出成 CRLF；
  `npm pack` 打的是**工作区文件**。宿主把 bytes/md5/sha256 钉进了 `tests/ui-fork.test.ts`、
  把 sha512 钉进了 lock 的 `integrity` ⇒ **照 README 重打一遍的人必然对不上数**，还会误以为是自己操作错了。
- **修法**：库根加 **`.gitattributes`**（`* text=auto eol=lf`）让检出统一 LF；`pack-vendor.mjs` 打印三条指纹。
- **落地**：库提交 **`9fa9de3`**（t10）。实测生效：干净克隆（HEAD `9fa9de3`）里 `install` + `npm pack`
  得到**同样 40,278 B / `0102c063…` / `0e2e8ee1…`** ⇒ 「同一提交、两种检出、两套指纹」这条已作废。
- **对文档的影响**：`tests/ui-fork.test.ts` 里那段「同一提交换个克隆就变一套指纹」的注意事项已按实测改写；
  本任务在宿主文档里**不再复述**那条旧结论。

### 10.8-4 数字自查表（每个数字 → 去哪儿核 → 实测值）

> 这张表是本轮所有文档数字的**唯一权威来源**；§2 / §4 / §6 / §7 / §10 里凡与它冲突的，以它为准。

| 数字 | 怎么核 | 实测值 |
|---|---|---|
| 应用侧断言数 | `node tests/.ts-out/tests/run-tests.js`（末行） | **8134** / `ALL PASS` / exit 0（`hans.clean` 也在其中） |
| 库侧断言数 | `cd Z:\deer-ui && npm test` | **134** / `ALL PASS`；构成 `ui.*` 62 + `kit.*`+`lib.*` 72 |
| `dist/styles.css` | `wc -c` / 顶层块计数 | **17,790 B / 92 个顶层块**（85 条规则 + 7 个 `@keyframes`）/ 326 行 |
| 令牌账 | 解析库 `src/styles/{tokens,kit}.css` | `:root`/light 定义 **143**；库规则引用 **34**；只有宿主在用 **93**；无人引用 **16**；浅色覆盖 **77** |
| `vendor/deerui-0.1.0.tgz` | `node` 读字节 + md5/sha256 | **40,278 B / `0102c063…` / `0e2e8ee1…`**（已提交进 HEAD 的那份 blob 仍是第一轮的 26,932 B —— **应用侧不提交，等队长**） |
| 库侧同一次 pack | 库根 `deerui-0.1.0.tgz` | 与 vendor **逐字节相同** |
| lock 的 `integrity` | `package-lock.json` 的 `packages["node_modules/deer-ui"]` | `sha512-ZGFy01rDqDW5…`（= 实测 sha512 的 base64，逐字相同） |
| 安装树 | `node_modules/deer-ui` | **真目录**（非 junction）；**28 个文件**，与 tarball **28/28 逐文件 sha256 相同**；`exports` 五个子路径齐全 |
| `app2/www/js/app.js` | 读字节 + md5 | **1,334,394 B / md5 `3f9db8acbfb76fe38ffaa6c33f875940`**（与 §10.2 一致，**重打包没动它**） |
| 库 HEAD | `git -C Z:\deer-ui log` | **`9fa9de3`**（`b0f259a` → `a5cefbb` → `b5d7c51` → `e2bc5d4` → `9fa9de3`），工作区干净，**未 push** |

### 10.8-5 为什么前两轮的验收没抓住这四处（本轮最有价值的记录）

| 缺陷 | 哪条验收本该抓它 | 为什么没抓住 |
|---|---|---|
| ① `npm i github:` 空包 | 「库能独立安装与运行」那条（t1 的四条闸门） | 验的全是**本地目录**：库工作区 `npm ci` / `npm install`，以及 `git clone` + `npm ci`。这两条都装了 devDependencies（`npm ci` 对自己这个包装的是**全量**依赖）并跑 `prepare`，`dist/` 要么已在、要么被建出来 —— **「从 git 装」（npm 只跑克隆、`prepare`、打包，不跑 `prepack`）这条路径从来没被走过**。而 CI 里跑的也是 `npm ci`，所以**将来 CI 真跑起来，这条 bug 仍然是绿的** |
| ② 预算下限 61 vs 72 | 库侧 `lib.budget.assertions` | 那条断言判的是**运行期断言数**（`>= MIN_INFRA`），**不判文档里写的数字**。文档里的数字**没有任何判据**（这是本仓库反复踩的坑：§10.4 的「按前缀计数」、§4.5 的「数子串」都是同一类） |
| ③ primitives 的过时注释 | 「逐字节复制」+「`dist` 忠实于 `src`」两条 | 两条都**只保证复制得忠实**，不保证**内容本身是对的**：注释是从宿主**逐字节**搬来的，`dist` 又是 `src` 的忠实产物，两条判据同时通过 —— **没有任何一条在问「这句注释是不是还成立」**（§10.7 的 P0b 记录里登记过它，但「登记」不是判据） |
| ④ tarball 里嵌旧 README | `uifork.vendor.{exists,bytes,md5,sha256}` | 这四条**只锁「tarball 还是那个 tarball」**：只要**没重打**，指纹当然一直是旧值、断言一直绿。「tarball 里的内容**是不是最新的文档**」没人问 —— 这正是 §10.7-4-① 登记的「静默落后」，而它的第一次真实发作就是这次 |
| ⑤ 跨检出不可复现 | 「tarball 指纹」那四条 + lock 的 integrity | 指纹**只在一台机器的一个检出里核过**（同一份文件、同一个 md5）。**换检出（clone）打一遍**才暴露 —— 属于「同一个判据在另一个环境里没人重跑」 |

**共同特征（写下来，下次照这条查）**：

1. **判据只覆盖「实现的正确性」，不覆盖「承诺的真实性」。** ①④ 都是文档承诺了一条没人验证过的路；
   ② 是文档数字与常量脱节；③ 是注释描述的架构与真实架构相反。**四条都不是代码 bug**。
2. **每个判据都只在「已经准备好的环境」里跑。** 工作区、`node_modules` 就绪的目录、单一检出 ——
   **换一个入口（git 安装 / 干净克隆 / 全新检出）就换一套结论**。t8 的克隆对照与 t10 的 `.gitattributes`
   就是「换入口重跑」抓出来的。
3. **文档里的数字没有判据。** 本仓库已经开始用脚本核对源码里的常量（`scripts/count-ui-assertions.mjs`），
   但**文档正文里的数字**仍然靠人眼。**建议的后续**（登记，不在本轮）：给几处高频数字（断言数 / 样式字节数 /
   tarball 指纹）加一条静态扫描断言 —— 扫 `docs/*.md` 与 `README.md`，把「断言数」这类数字与运行期实测对齐。

### 10.8-6 现实约束：GitHub 上的 CI 现在**没有在跑**（不许写成已完成）

- 库的 `.github/workflows/ci.yml` 已经是**真文件**（`npm ci` → `typecheck` → `build` → `test` → `check:dist`），
  **在库 HEAD 里**（`git ls-tree HEAD .github` → `.github/workflows/ci.yml`）。
- **但它还没被推上去**：库仓 **`master` 领先 `origin/master` 5 个提交**（`9fa9de3` vs `bce2647`），
  `origin/master` 上连 `ci.yml` 都不存在 —— 远端那个提交里它还是 `.github/ci.yml.example`。
- **而且还卡着一道 token 闸门**：本机 gh 的 OAuth token **没有 `workflow` scope**，GitHub 会**拒绝**推送
  `.github/workflows/**`（先例：提交 **`bce2647`** 就是为此把它降级成 `.github/ci.yml.example`）。
  队长推送时若再撞上，同一手法（改名 `.example` 先推、换凭据后再推回去）仍然有效。
- ⇒ 所以本仓库所有文档里，关于 CI 的**准确说法**只有两种：
  ① 「workflow 文件已在库仓库的提交里，**未推送**」；② 「**在无宿主仓库的目录里把四步逐条跑绿**（t1/t7 都真跑过）」。
  **不许**出现「GitHub 上 CI 已经在跑 / CI 会拦这条」这类完成态表述（§10.7-5-⑥ 与附 A 已按这条改准）。

### 10.8-7 本轮之后仍存缺口（**新增/更新，不含 §10.7-6 里那 8 条**）

1. **「安装树 == vendor tarball」仍只有人工核对**（本轮做了 28/28 那次），**没有断言**（§10.5-2 未收）。
2. **文档里的数字没有判据**（§10.8-5-3）：建议加一条扫文档数字的静态断言。
3. **真 GitHub 远端的 git 安装 / CI 都没验过**：t7 的「从 git 装」是本地克隆模拟（`git+file:///`），
   CI 是「本地跑四步」。**「换个入口就换一套结论」**这条教训的直接后果 —— 要收它必须真 push 一次。
4. **库的令牌面仍是超集**（143 / 34 / 93 / 16，§10.7-4-③），且**收敛时会同时踩两条断言**
   （`uicss.app.no-tokens` 禁应用里出现 `:root`；`uitoken.count` 要求库 `:root` ≥ 100）—— 两条口径必须一起改。
5. **样式拆分的「真渲染等价」判据仍是一次性的**（`%TEMP%` 里的无头浏览器脚本，没入库、没进闸门）。

---

## 附 A：本文的证据边界（**不要当已核引用**）

| 项 | 状态 |
|---|---|
| (2026-09-20 复核后已变动的行标了 ✅；其余仍是原状) | |
| 真机 / Android 设备 / WebView | **未验证**（本机没有设备，与 R2 的自陈一致） |
| `npm pack` → `file:…tgz` 的路线 D 字节数 | ✅ **已复现**（**第一轮**的数，现值见 §10.8-2）：tarball 26,932 B / md5 `1e9c0d79…`，宿主产物 +109 B（§10.2） |
| npm registry 的 `deer-ui` / `@deerluu/deer-ui` 占用情况 | 同上，**未联网复现** |
| 容器出包环境（`/root/pcbuild`）里能否解析 `vendor/*.tgz` | **未验证**（验法见 P5 坑③；本机走的是「仓库根 + `node_modules`」这条路） |
| P0b 的「逐字节相等」脚本与 P1 的 `{sel→decls}` 等价脚本 | 库侧**逐字节比对已做过**（12 个文件 `git hash-object` 相等，见库仓 README）；**P1 的等价脚本仍不存在**（P1 未开工） |
| 库拆分后的实际构建产物字节数 | ✅ **已存在**：库 `dist/`（tarball 里 27 文件）+ 宿主 `app.js` **1,334,394 B** / md5 `3f9db8ac…`（§10.2） |
| `./geometry` / `./bundle.css` / `./host` / `./tabs` 四条子路径的解析 | ✅ **`./tabs` 已落地**（进 `exports`，宿主真实消费）；`./geometry` / `./bundle.css` / `./host` **仍 [待验证]**（对应期未开工） |
| （第二轮追加）库能否**在没有 PixelCraft 在场**的目录里装 / 测 / 构建 | ✅ **已复现三遍**：`%TEMP%\deerui-standalone`（robocopy 排除 `node_modules`/`.git`/`dist`/`.ts-out`，旁边无 `pixelcraft`）走 `npm install`（全新缓存，真下载 5.55 MB / 22 项）→ `test` 123 / ALL PASS → `build` → `check:dist` 24 文件 → `typecheck` 0；更严的一条是 `git clone Z:\deer-ui %TEMP%\deerui-clone` 后 `npm ci`，四条闸门全绿（§10.7-1） |
| （第二轮追加）库自带样式 ↔ 应用样式的**等效**（视觉零变化） | ✅ **已做成机器判据**：`uicss.rules-hash` 比「库段 ∪ 应用段」的**扁平规则多重集合 sha256** == 拆分前那份（`98e94d6cbe535281…`，差异 0）；产物两段顺序、两段各自账、应用侧无令牌块/无库选择器另有 10 条（§10.7-3） |
| （第二轮追加）**令牌归属**是否正确（该不该在库里） | ❌ **没有判据**：库定义 143 个令牌、自己只用 34 个（93 个只有应用在用、16 个谁都不用）。多重集合等价**证不到**这件事（整体搬走并集不变）—— 缺口登记在 §10.7-4-③ |
| （第二轮追加）`.github/workflows/ci.yml` 在**真 CI 服务**上跑过 | ❌ **仍未验证**：本机只做到「无宿主目录里把四步逐条跑绿」+ YAML 语法自检；**库仓领先 `origin/master` 5 个提交、还没 push**，远端那个提交里它还是 `.github/ci.yml.example`（本机 gh token 没有 `workflow` scope）。准确说法见 §10.8-6 |
| （第三轮追加）`npm i github:DeerLuuu/deer-ui` 这条**真 git 安装** | ⚠️ **本地克隆模拟已验**（`git+file:///Z:/deer-ui`；默认与 `--omit=dev` 两档都成功），**真 GitHub 远端未验**（库未 push）。见 §10.8-1 |
| （第三轮追加）`node_modules/deer-ui` 与 `vendor/*.tgz` 是否**同一份** | ✅ **本轮人工核过**：解包 28 个文件 vs 安装树 28 个文件，**逐文件 sha256 全相同（28/28）**；`dist/styles.css` 三处（库 `dist/`、tgz 内、安装树）都是 `f078e80a…`。**但不是断言** —— 缺口见 §10.8-7-1 |
| （第三轮追加）tarball 指纹的**跨检出可复现** | ✅ **已修并实测**：库加 `.gitattributes`（`* text=auto eol=lf`，提交 `9fa9de3`）后，干净克隆里 `install` + `npm pack` 得到与工作区**逐字节相同**的 40,278 B / `0102c063…` / `0e2e8ee1…`（修前同一 commit 两种检出会差出几十个 `\r`，见 §10.8-3-⑤） |
| （第三轮追加）**文档里的数字**与仓库实际是否一致 | ❌ **没有判据**（本轮靠人眼扫全仓，改了 4 处过期断言数）：文档正文里的数字没有静态断言盯着 —— 建议见 §10.8-5-3 / §10.8-7-2 |
