# PixelCraft 发展路线蓝图（ROADMAP）

> 面向用户的功能说明 → [`README.md`](../README.md)；模块接口 → [`API.md`](API.md)；
> 架构与模块化目标 → [`ARCHITECTURE.md`](ARCHITECTURE.md)；AI 方案与进度 → [`PLAN-ai.md`](PLAN-ai.md)；
> 等距构建 → [`PLAN-isobuilder.md`](PLAN-isobuilder.md)；竞品对比 → [`COMPARISON.md`](COMPARISON.md)。

**这份文档解决一件事**：把「下一件该做什么、为什么是现在、做完怎么算做完」写成**可验收**的分期清单，
并且**显式列出不做的事与必须问用户的事**。它不是愿望清单，每条都指得到仓库里的文件与行。

- **谁维护**：任何人改完功能，**同一个提交里更新对应条目**（见 §0.4）。文档地图（`AGENTS.md` §9）由项目负责人更新，本蓝图不代改 `AGENTS.md`。
- **基线**：`master` · HEAD `8f54333` · 版本 `1.1.1.9` / `versionCode 66` · 回归 `8090` 条断言 / `ALL PASS` / exit 0。
- **怎么读**：先看 §1 一屏概览挑条目 → 读条目七要素 → 开工前确认 §7/§8/§9/§10 的边界。

---

## 0. 怎么用、怎么维护、口径是什么

### 0.1 三步定位

1. 在 **§1 一屏概览**里按「分期 × 主题」找到条目号（`S0-1`…`S3-6`）。
2. 翻到对应条目，读七要素：**目标 / 为什么现在 / 落点 / 验收口径 / 优先级 / 依赖 / 风险与代价**。
3. 开工前过一遍四道闸：**§7** 与既有计划的对齐（别重复造计划）、**§8** 文档口径漂移（别照着错口径写）、
   **§9** 明确不做（别当新任务重提）、**§10** 必须先问用户（没拍板就只做准备、不动实现）。

### 0.2 优先级与分期是两个维度（别混）

- **分期**回答「什么时候做」；**优先级**回答「不做会怎样」。两者不等价。
- **P0** = 不做会**持续产生错误决策**或**用户可见失败**（信息错、尺子不准、功能不可达、第三端起不来）。
- **P1** = 直接用户价值，或**阻塞下游**（不做它，后面的活会白做）。
- **P2** = 有价值但可以等。**P3** = 顺手活 / 低收益 / 条件未成熟。
- 因此 **S0 里可以出现 P1 条目**（例如 `S0-7` 补参数描述：它不阻塞下游，但成本是一个提交、零风险、直接抬模型准确率，
  所以放在 S0 而不是因为它是 P0）。**不要把 P0 当「重要」的同义词用**——那样优先级信号会被稀释。

### 0.3 与既有三份计划的关系（不另起第四套）

| 既有计划 | 它的性质 | 本蓝图与它的关系 |
|---|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) §4（M0–M4 模块化）+ §5（P0–P8 Server 化） | 目标设计与分期**框架** | 本蓝图 `S1-8 / S1-9 / S2-1 / S2-2 / S2-3 / S3-1 / S3-2` **就是它**，只是补上**可验收数字**与**执行顺序**（例如 P5 的完成判据） |
| [`PLAN-ai.md`](PLAN-ai.md)（C0–C5 / P8 / P1 / P17 / P18 已全部 ✅） | AI 能力线，**已完成** | 本蓝图的 AI 条目（`S0-7 / S1-11 / S1-12 / S2-6 / S2-10 / S3-1`）是它的**续期**，编号沿用它的 P 序列 |
| [`PLAN-isobuilder.md`](PLAN-isobuilder.md)（v1 已落地） | 等距构建，v1 完成 | `S1-2`（引导里那一步）与 `S2-8 / S3-3` **就是它 §6 的 v2 / v3** |

一句话：**本蓝图不新增方向，它把前三份的「未完成部分」+ 四路盘点发现的新缺口排进同一条时间线，并规定验收口径。**

### 0.4 这份文档怎么维护（防腐机制）

- 每个条目标题带状态：**⬜ 未开始 / 🟡 进行中 / ✅ 已完成 / 🅿️ 待用户拍板 / ⛔ 已取消**。
- **功能落地时同一个提交更新对应条目**（这条约定由 `AGENTS.md` §5.3 承接；该文件由项目负责人更新，本蓝图不代改）。
- 建议新增 `tests/roadmap.test.ts`：至少校验「每个 `### S<n>-<m>` 有状态标记」+「条目里引用的文件真实存在」。
  仓库已有 `tests/changelog.test.ts`、`tests/guide-anchors.test.ts` 这类**静态钉子**的先例（`S0-4` ④）。
- **为什么必须做**：本蓝图的核心论点之一就是「文档会静默漂移」（§8 列了 **25 条**实例）。如果它自己不设防腐机制，
  落地后它就是第 26 条。**不要退回「靠人记得改」。**

### 0.5 数字口径（别混，这是本节存在的唯一理由）

| 量 | 本文用的值 | 口径 |
|---|---|---|
| `src/` 行数 | **44,205** | **LF 口径**（按 `\n` 计数）。`ReadAllLines` 口径是 **44,209**（4 个文件末尾无换行）。本文一律用 LF 口径 |
| `view_` 调用 | **56 次（分布 55 行）** | `Select-String -Path src/app/session.ts -Pattern 'view_' -AllMatches` 的出现次数 **57** − 声明 1 行 = 56。**声明行不计**；注释与 `import type` 不计 |
| `changed()` | **72 处**（`this.changed()` **64**） | 正则 `changed\(\)`（**无参**调用）。带参的 `changed(...)` 未计入（口径不同会数出别的数） |
| 「工具数」 | **61 / 60 / 61** | 工具表 61（read 4 / draw 49 / destructive 7 / ui 1）；协议层 `list_tools {}` 默认 **60**（不列 `ui`）；MCP `tools/list` 在 `all` 档 **61**。见 [`API.md`](API.md) §25.3 |
| 行号 | `文件:行` | 全部用 `[System.IO.File]::ReadAllLines()` 复核过内容。⚠️ **Windows 工作区上 `Get-Content` 数行不可靠**（同一文件曾给出 329 行，`ReadAllLines` 给 589 行）——数行/取第 n 行一律用 `ReadAllLines` 或 `Select-String` |
| 无法复现的数字 | 标「**待验证**」 | 见 §11。**不许**以「已核」的口吻引用 |

---

## 1. 一屏概览

优先级：`P0` 阻塞或用户可见失败 / `P1` 用户价值或阻塞下游 / `P2` 可等 / `P3` 顺手活。

| 分期 | 条目 | 主题 | 优先级 | 状态 | 一句话 |
|---|---|---|---|---|---|
| **S0 立刻（0–2 周）** | S0-1 | 交付门禁 | **P0** | ⬜ | 一条 `verify` + 一个 CI + 锁定依赖版本，让「测试跑没跑 / 产物是不是这份源码」自动拦住交付 |
| | S0-2 | 交付门禁 | **P0** | ⬜ | 拔掉三颗钉子：`scripts/*.sh` 全 CRLF、`run-tests.sh` 写死不存在的 `tsc.js`、测试三份手工清单 |
| | S0-3 | 交付门禁 | **P0** | 🅿️ | 构建期注入来源戳，停止手改 `BUILD_TAG`；三端产物对齐（APK 那一半待出包） |
| | S0-4 | 信息正确性 | **P0** | ⬜ | 一次性校正会误导排期的文档口径（§8 的 25 条），并给本蓝图装防腐钉 |
| | S0-5 | 测量基线 | **P0** | ⬜ | 立「性能基线协议」：尺子不准，后面所有性能项都判不出好坏 |
| | S0-6 | 用户可见缺陷 | **P0** | ⬜ | 电脑模式下图案笔刷整块不可达，且已开的图案关不掉 |
| | S0-7 | AI 准确率 | P1 | ⬜ | 补 52 个参数描述 + 接通顶层 `warn`（零风险、成本一个提交，故排 S0） |
| | S0-8 | 数据安全 | P1 | ⬜ | 三条纯增量加固（读回校验 / 写失败分级 / 导入部分失败要报）+ 一条改错误路径语义 |
| | S0-9 | 顺手活 | P3 | ⬜ | `engine/history.ts` 的类型反向依赖下沉（零风险的一行活） |
| | S0-10 | 用户可见缺陷 | P1 | ⬜ | 电脑壳在干净克隆上白屏——第三端首启失败，三行守卫就能修 |
| **S1 近期（1–2 月）** | S1-1 | 文件生命周期 | P1 | 🅿️ | 记 `lastUri` 写回 + 最近工程；「每次保存都是另存为」的根因是没有文件身份 |
| | S1-2 | 可发现性 | P1 | ⬜ | 1.1.x 零引导步骤 + 动作搜索搜不到菜单项 + 英文界面里的中文常量 |
| | S1-3 | 导入导出 | P1 | ⬜ | 自己导出的精灵表 JSON 回不来；同一个 GIF 在三条菜单上结论不同 |
| | S1-4 | 三端一致 | P1 | ⬜ | PWA 里永远起不来的 AI 设置组 / 电脑壳没有全屏入口 / README 离线口径自相矛盾 |
| | S1-5 | 交互细节 | P2 | ⬜ | 新建画布没有常用尺寸预设，手机端要手打数字 |
| | S1-6 | 交互细节 | P2 | ⬜ | 标签的方向与重复次数只在文件里往返，播放时不生效 |
| | S1-7 | 质量基建 | P1 | ⬜ | 浏览器 e2e 入库（只读产物）+ 性能门禁 + 崩溃恢复链路覆盖（现在 0 条） |
| | S1-8 | 架构前置 | P1 | ⬜ | M0 模块工具链 + 依赖方向检查：给后面所有搬迁一条机器判据 |
| | S1-9 | 架构前置 | P1 | ⬜ | 绞杀者第一刀：切 `Session ↔ View`，把耦合变成可验收数字（起点 56） |
| | S1-10 | 性能 | P2 | ⬜ | 热路径去分配（回调式遍历 + 复用缓冲），本轮复跑约 1.9× |
| | S1-11 | AI 深化 | P1 | 🅿️ | 协议层 destructive 确认器（MCP 能否真改画的唯一堵点）+ `render_preview` |
| | S1-12 | AI 工具面 | P2 | ⬜ | 补 `export_*` / `selection_*` + 本地模型实跑一次 |
| **S2 中期（3–6 月）** | S2-1 | 结构 | P1 | ⬜ | Server 化 P2–P5 收尾，先把 P5 的完成口径重钉（`GestureHost` 起点 56） |
| | S2-2 | 结构 | P2 | ⬜ | `SignalHub` 最小版（5–6 频道）——M3 类模块的前置 |
| | S2-3 | 结构 | P1 | ⬜ | 模块化 M1–M2：最独立的八个模块先搬家 |
| | S2-4 | 专业工作流 | P2 | 🅿️ | 降到 N 色 / 时间轴缩略图 / 图层组 |
| | S2-5 | 性能 | P2 | ⬜ | 大画布 1024² 给一个可量化的「支持到哪」结论 |
| | S2-6 | AI | P2 | ⬜ | 长任务预算会计 + 两条读取路径的小数截断口径统一 |
| | S2-7 | 设备依赖 | P3 | 🅿️ | Android 侧同源代理（没有真机就不开工） |
| | S2-8 | iso | P2 | ⬜ | PLAN-isobuilder v2 收尾（重编辑上一次 / 投影阴影 / 视角切换） |
| | S2-9 | 数据格式 | P1 | ⬜ | `.pxc` 格式版本与迁移兼容（改结构之前必须先有它） |
| | S2-10 | AI 运维 | P3 | ⬜ | 上游模型名与能力位会过期：预设刷新 + 降级路径 |
| **S3 远期（6 月+）** | S3-1 | 模块化交付 | P2 | 🅿️ | M4：`ai` 模块 + 两条产线 + CI 三预设矩阵 |
| | S3-2 | 模块化交付 | P3 | ⬜ | 变体发布（`pixel-core` / `lite` / `full` / `studio`）+ 体积报告 |
| | S3-3 | iso | P3 | ⬜ | PLAN-isobuilder v3（三视图高级模式 / 逐帧等距动画） |
| | S3-4 | 生态 | P3 | 🅿️ | `.aseprite` 图层组 / 瓦片层往返 |
| | S3-5 | 离线 | P3 | 🅿️ | PWA service worker（或只改文案） |
| | S3-6 | 可访问性 | P3 | ⬜ | 无障碍清单 + 首屏体积预算 |

**状态图例**：⬜ 未开始 · 🟡 进行中 · ✅ 已完成 · 🅿️ 待用户拍板（§10）· ⛔ 已取消。
本文档首次落地时**所有条目都是 ⬜**（🅿️ 表示它依赖 §10 的某个决策）。

---

## 2. 排序依据（用户价值 × 风险 × 成本 × 阻塞关系）

### 2.1 四条规则（按权重）

1. **先消灭「错的信息」与「不能判好坏」**（成本极低、影响所有后续判断）：文档口径（`S0-4`）、性能协议（`S0-5`）、
   门禁与来源戳（`S0-1/2/3`）。不修这三类，后面每条都会**基于错的现状**做决策——今天已有实例：
   Pages 落后 18 个提交却带着「源提交 5182c7b」的标签、`BUILD_TAG = "72ff2b0"` 落后 HEAD **25** 个提交却显示给用户当「当前构建」。
2. **再修「用户每天摸得到、而且当下就是错的」**：电脑模式丢一整块绘制能力（`S0-6`）、第三端首启白屏（`S0-10`）、
   每次保存都另存为（`S1-1`）、1.1.x 零引导（`S1-2`）、同一 GIF 三处结论不同（`S1-3`）、PWA 里起不来的设置组（`S1-4`）。
   这些都是「功能存在但用户到不了 / 结果与预期不符」，修复成本低、感知强。
3. **结构改造不跟用户价值抢位，但它的硬前置必须提前**：Server 化 / 模块化不改用户可见行为，所以不进 S0；
   但 `M1` 依赖「P3/P4 完成」、`M3` 依赖「P5–P7 完成」（[`ARCHITECTURE.md`](ARCHITECTURE.md):509），
   而 P5 在 [`ARCHITECTURE.md`](ARCHITECTURE.md):604 被记成「四片完成」却仍留着 56 个成员的 `GestureHost`
   ⇒ **口径不重钉，M3 会建在假地基上**。所以 S1 只做「M0 工具链 + 依赖方向检查 + 绞杀者第一刀」这类低风险可验收的起步，大搬迁留给 S2。
4. **AI 线按「零风险 → 要用户拍板 → 要设备」排序**，并且**与架构线的 `ai` 模块化显式分开**（§7.2 真冲突 R1）。

### 2.2 为什么不是「先做最痛的结构改造」

`session.ts`(4,700) / `view.ts`(3,693) / `App.tsx`(2,997) / `modals.tsx`(2,410) 四个文件合计 **13,800 行 = 全仓 31.2%**
（[`ARCHITECTURE.md`](ARCHITECTURE.md):541 的目标是 ≤25%），看着最痛。但它：

- **收益不进 S0 的用户视野**，风险却最高（回归面全在这几个文件上，[`ARCHITECTURE.md`](ARCHITECTURE.md):98 自己写「风险：高」）；
- **已经有一条成型的绞杀者路径**（[`ARCHITECTURE.md`](ARCHITECTURE.md) §5），缺的不是方案而是**执行顺序与度量口径**；
- 有一个**必须先解决的度量问题**：`view.ts` 目标写 ≤1,200 行而现状 3,693 行；`GestureHost` 目标未定而现状 56 个成员。
  **目标不重钉，做完也说不清做没做完**（→ §10 Q8）。

### 2.3 依赖草图（谁挡谁）

```
S0-1/2/3 门禁与产物 ──┬─> S1-7 质量基建第二批（e2e / 性能门禁 / 恢复覆盖）
                      └─> 所有后续条目的「验收口径可信」
S0-4 文档校正 ─────────> §7 对齐成立（否则照错口径规划出重复工作）
S0-5 性能协议 ─────────> S1-10 去分配、S2-5 大画布（否则判不出好坏）
S0-6 图案入口 / S0-10 电脑壳守卫 ──> （无下游，独立）
S0-7 desc + warn ──────> S1-11 render_preview（带图后要重核请求体）
S1-8 M0 工具链 + 依赖方向检查 ─┬─> S1-9 绞杀者第一刀
                              └─> S2-3 模块化 M1–M2 ──> S3-1 M4
S1-9 切 view_ ────> S2-1 Server 化收尾 ──> S2-2 SignalHub ──> S2-3（M3 类模块）
S2-9 格式版本与迁移 ──> S2-4 ② 图层组 / S3-4 生态往返
S2-4 ② 图层组 ────────> S3-4
§10 用户拍板项 ────────> 相关条目的实现（未答则只做准备、不动语义）
```

---

## 3. S0 立刻（0–2 周）——「先把地基上的错误信息清掉，让后面的判断有依据」

> 共同特征：**全是「一个提交级」或「一条脚本级」的改动**，风险低，但每条都在给后面所有期**提供判断依据**。

### S0-1 交付门禁：一条 `verify` 命令 + 一个 CI + 锁定依赖 ⬜ P0

- **目标**：把「测试跑没跑 + 产物是不是这份源码出来的」变成**自动执行、不一致就拦住交付**的门禁。
- **为什么现在**：今天**没有任何强制力**——`master` 没有 `.github`（本轮复测 `Test-Path .github` = False），
  `.git/hooks` 也不存在；唯一的自动化是部署工作流 `web/pages.yml`，它**只在 `main` 上跑**、只做
  4 个 `test -f` + 2 个 `wc -c`（`web/pages.yml:30-38`）、**不跑测试、不跑 `tsc`、不跑 `check-bundle`**。
  8090 条断言全靠人记得跑。另外仓库**没有 lockfile**（`package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` 三个都不存在），
  而本机装到的是 typescript **5.9.3**、`package.json` 写的是 `^5.6.0` ⇒ 不锁版本，CI 结果会随上游漂移。
- **落点**：新增 `scripts/verify.sh`、`.github/workflows/ci.yml`（**只在 `master`**）；生成并入库 `package-lock.json`（CI 用 `npm ci`）；
  复用现有资产：`node_modules/.bin/tsc`、`tests/.ts-out/tests/run-tests.js`、`toolchain/check-bundle.mjs`、`scripts/build-web.sh`。
- **验收口径**（执行环境：脚本本身用 `sh`，Windows 工作区经 WSL / Git Bash；CI 在 ubuntu runner）：
  ① `sh scripts/verify.sh` 退出码即结果（`tsc -p tsconfig.json --noEmit` → 编 tests 并跑 `run-tests.js`（要求 exit 0 且末行 `ALL PASS`）→ `build-web.sh` → `node toolchain/check-bundle.mjs app2/www/js/app.js`）；
  ② 故意改坏一个断言，`verify.sh` **必须非 0**；③ CI 在 push/PR 上跑同一条并在界面可见绿/红；
  ④ `npm ci` 装出的 typescript 版本与本机一致（`node_modules/typescript/package.json` 的 `version`）；
  ⑤（**顺手把「仓库清洁」变成可执行检查**）`verify.sh` 里加一条「`git status --short` 只允许出现已知产物路径」，
  否则交付前会漏掉不该入库的临时文件。
- **优先级**：**P0**。**依赖**：`S0-2`（否则脚本在 Windows 工作区跑不起来）。
- **风险与代价**：低。**注意**：CI 只跑 `master`，**不要动 `main`**（`main` 只放部署产物，见 `AGENTS.md` §5.1b）。

### S0-2 让门禁跑得起来的三颗钉子 ⬜ P0

- **目标**：把「脚本根本跑不起来」的三处硬钉子拔掉，`S0-1` 才有意义。
- **为什么现在**：① 工作区里 `scripts/*.sh` **全是 CRLF**（本轮 `git ls-files --eol scripts/` → 全文件 `i/lf w/crlf`），
  而仓库**没有 `.gitattributes`** ⇒ LF 版能跑、CRLF 版在 `set -e` 那一行即死；
  ② `scripts/run-tests.sh:5,10` 写死 `node_modules/typescript/bin/tsc.js`，而 typescript 5.9.3 的 `bin/` 下只有 `tsc` 与 `tsserver`
  ⇒ `npm test` 必然报「missing node_modules」；
  ③ 测试入口是**三份手工清单**（`tests/run-tests.ts` 的 import、它前面的分节标题、`tests/tsconfig.json` 的 `include`），
  本轮复核 `tests/tsconfig.json` 的 `include` **确实不含** `autosave.test.ts` / `hans.test.ts`（只因为被 import 才编到）
  ⇒ 「只写文件、不加 import」的测试会**永远不跑且全绿**。
- **落点**：新增 `.gitattributes`（`*.sh text eol=lf`）；`scripts/run-tests.sh:5,10` 改指 `node_modules/.bin/tsc`；
  三份清单收敛成单一来源（由 `run-tests.ts` 的 import 同时生成 `include` 与分节标题）。
- **验收口径**：① `git ls-files --eol scripts/` 显示 `w/lf`；② 在 Windows 工作区 `sh scripts/run-tests.sh` 跑到 `ALL PASS`（不再在 `set -e` 处死掉）；
  ③ 新增一个「只写文件、不 import」的测试时，`run-tests` 的输出里**必然出现**它的分节，或清单校验直接失败；
  ④ 明确写出「门禁脚本跑在哪个 shell」（验收环境一栏）。
- **优先级**：**P0**。**依赖**：无（可与 `S0-1` 同批）。
- **风险与代价**：低。`.gitattributes` 会一次性重写这些文件的行尾，**放在独立提交里**，别和代码改动混在一起。

### S0-3 构建来源戳 + 三端产物对齐 🅿️ P0

- **目标**：让「产物 ↔ 源码提交」的关系**机器可判、且不可静默错**；顺手消掉已有的落后。
- **为什么现在**：落后是**当前事实**（本轮复测）：工作区 `app2/www/js/app.js` = **1,334,285 B / md5 `a15d5b1e626edfaf526c28694bed4b86`**；
  `origin/main` 上的 Pages 产物 = **1,225,286 B / md5 `3048620ef845547cc8c024f24be69338`**，其提交信息自报「源提交 5182c7b」，
  而 `git rev-list --count 5182c7b..HEAD` = **18**；`build/PixelCraft.apk`（517,619 B，2026-09-11）内
  `assets/www/js/app.js` = **879,318 B / md5 `37390ae286a0494fd2fd56345e66d1e7`**，内含最高版本号 **1.0.9.9**（`1.1.0.0` / `1.1.1.9` 各 0 次）
  —— **三端却都显示同一个版本号 1.1.1.9**。
  机制也在：`scripts/publish-web.sh:19-23` **仓库内没有 `node_modules` 时直接跳过构建、用现成产物**，却仍把当前 HEAD 写进提交信息；
  `src/ui/changelog.tsx:15` 的 `BUILD_TAG = "72ff2b0"` 是手工维护的、落后 HEAD **25** 个提交，
  而 `tests/changelog.test.ts:32` 只校验「7+ 位 hex」格式，**永远不会红**。
- **落点**：esbuild `define` 注入 `__PC_COMMIT__`（`git rev-parse --short HEAD`）+ dirty 标记；`src/ui/changelog.tsx` 的 `BUILD_TAG` 改从注入值读；
  `tests/changelog.test.ts` 增加「戳 = 构建期提交」的断言；`scripts/publish-web.sh` 在「产物里的戳 ≠ HEAD」时**拒绝推送**。
- **发版清单（明确口径，别当漏项）**：版本号三处同步（`android/AndroidManifest.xml` 的 `versionName`、`src/ui/changelog.tsx` 的 `APP_VERSION`、更新日志条目）
  **已有** `tests/changelog.test.ts` 静态拦截；**`versionCode` 递增仍是手工** ⇒ 本蓝图**明确写「保持手工、不加自动化」**，不另立条目。
- **验收口径**：① 读产物里的戳 === `git rev-parse --short HEAD`；② `tests/changelog.test.ts` 新增断言通过（无注入值时显式表达为「未知」，不再是任意 hex）；
  ③ `sh scripts/sync-web.sh --check` exit 0（**执行环境：WSL / Git Bash**，依赖 `S0-2` 的行尾修复）；
  ④ **APK 那一半标注为「待出包时执行（容器内）」，不是今天可跑的验收**：出包后 `verify-apk.py` 必须报「app.js 与本地构建一致」。
- **优先级**：**P0**。**依赖**：`S0-1`/`S0-2`；**出包与版本号变更需用户明确要求**（`AGENTS.md` §5.1：`1.0.x` 第三段由用户决定、`versionCode` 每次出包 +1）⇒ §10 Q11。
- **风险与代价**：低。若用户暂不出包，先做「来源戳 + `--check` 必须 0」这两半，APK 那一半挂起（状态 🅿️ 只针对这一半）。

### S0-4 文档口径一次性校正（+ 给本蓝图装防腐钉） ⬜ P0

- **目标**：把会误导排期的口径一次性改对（清单见 **§8**），并让本蓝图自己有防腐机制。
- **为什么现在**：本蓝图要求「与既有计划去重对齐」，而**对齐的基准文档本身有矛盾和过期数字**：
  [`API.md`](API.md):1839（§16.5）仍把已删的 `serialize/parse/parseProject` 当现行接口，而
  [`API.md`](API.md):2142（§18.5）说它们已删除（本轮复测：`parseProject` 在 `src/` **0 命中**，代码是 `serializeSpace` / `parseSpace`）；
  [`ARCHITECTURE.md`](ARCHITECTURE.md):599 与 :603 让 **P4 在同一张进度表里出现两次**（🟡 / ⬜）；
  引导步数有 **54 / 41 / 46** 三种口径（本轮实测 `src/app/guide.ts` 的 `GUIDE` = **46** 条）。
  **最危险的一条**：[`PLAN-ai.md`](PLAN-ai.md):328 / :662 / :1000 / :1071 仍写「代理对 `stream:true` 回 400」/「固定 false」，
  而流式**两条腿都已落地**（`src/app/settings.ts:641` `default: true`）。如果照着这些口径写，会把**已做完的事**排成未来。
- **落点**：[`PLAN-ai.md`](PLAN-ai.md)、[`API.md`](API.md)、[`ARCHITECTURE.md`](ARCHITECTURE.md)、[`COMPARISON.md`](COMPARISON.md)、
  [`README.md`](../README.md)（**`AGENTS.md` 不在本条范围**，它的文档地图由项目负责人更新）；
  另加 `tests/roadmap.test.ts`（见 §0.4）。
- **验收口径**：① 逐条对照 §8 的表全部改完（表里带「核验状态」列，**只改已核过的**）；② **不重构文档结构**，只改与现状不符的具体句与数字；
  ③ 全量测试 `ALL PASS`（`tests/changelog.test.ts` 等静态校验不能因此变红）；④ `tests/roadmap.test.ts` 对本文档跑通。
- **优先级**：**P0**（成本极低、影响所有下游引用）。**依赖**：无。
- **风险与代价**：低。风险是「顺手把 `API.md` 大改」——**只改具体句与数字，别重构文档结构**。

### S0-5 性能基线协议（先把尺子校准） ⬜ P0

- **目标**：给笔迹性能定一套**可复现**的测量协议，让任何热路径改动都能判定「变好还是变坏」。
- **为什么现在**：今天的数字**不可复现**：同一命令连跑，最坏配置 `avg 0.139→1.20 ms`、`max 1.2→9.0 ms`；
  新 profile 首跑快、同 profile 再跑慢；同一页面连画三笔 `5.7→1.3→0.5 ms`（越画越快）。
  而 `toolchain/stress-stroke.mjs:135` 只做 `Page.navigate`，**不重置状态、不丢弃首笔**。
  **合成侧在所有 run 里都 ≤0.7 ms** ⇒「合成不是瓶颈 / 不做笔迹 overlay 层」这条**独立复核成立、保留**。
- **落点**：`toolchain/stress-stroke.mjs`（`--rig` 打印 rig、`--reset` 干净 profile / 显式清 `localStorage` + IndexedDB、**丢弃第一笔**、
  报**中位数 + p95**、连续 3 次取中位数）；[`COMPARISON.md`](COMPARISON.md) §三.1 的基线表按新协议重写并标注取数条件。
- **验收口径**：协议必须定义**两个 rig**，并规定下游阈值挂在哪一条：
  · **rig A「干净 profile」**：每次新建 profile + 丢首笔 + 连续 3 次取中位数（回答「稳态是多少」）；
  · **rig B「复用 profile」**：同一 profile 连续 3 次 + 丢首笔（回答「冷启动后是否退化」）。
  ① 同一 rig 连跑 3 次，**中位数之间偏差 < 20%**（今天同一命令能差 4–8 倍）；② 输出必须含 rig（doc 尺寸 / 图层数 / 笔刷 / 平铺 / 洋葱皮 / Chromium 版本）；
  ③ 报 p50 与 p95，**不许只报均值与峰值**；④ 表里同时保留「合成峰值」（独立复核成立）。
- **优先级**：**P0**。**依赖**：无。**下游**：`S1-10`（阈值挂 **rig A**）、`S2-5`（阈值挂 **rig A**）。
- **风险与代价**：低。唯一风险是「把峰值当噪声丢掉」——所以**必须同时留 p95**，并写明「首笔不计入」。

### S0-6 电脑模式下图案笔刷入口（功能不可达 + 不可逆状态） ⬜ P0

- **目标**：电脑模式下能打开图案面板、选中图案落笔、**关掉图案**。
- **为什么现在**：图案面板只能从工具球的 `pattern-brush` 项打开，而这一项在电脑模式下被**整条排除**、且**没进动作注册表**：
  `src/ui/App.tsx:1979-1987`（`...(pcMode ? [] : [action-search, pattern-brush, tool-group-shape, tool-group-select])`）、
  `:1984`（`pattern-brush` 的动作是 `onPatterns()`）、`:1995-2007`（注册表来源就是这些球的条目）
  ⇒ `Ctrl+K`（`src/ui/modals.tsx:1531` 读 `SESSION.allActions()`）与「界面定制」**也搜不到它**。
  更糟的是图案 id 跨启动保存在 `prefs.patternId`（`src/app/session.ts:224 / 1508 / 1614 / 1935-1936`）
  ⇒ **在手机上开过图案、换到电脑，图案一直在，界面上没有任何开关能关掉它**。
- **落点**：`src/ui/App.tsx:1979-1987`（把 `pattern-brush` 铺进电脑工具环，与 `tool-group-*` 同批）；可选 `src/ui/feature-icons.ts` 登记 + `data-guide` 锚点；
  **必须同时进注册表**。
- **验收口径**：① 电脑模式（设置 → 电脑模式开）下能打开图案面板 / 选中图案落笔 / 点「不用图案」关掉；
  ② `Ctrl+K` 输入「图案」能命中；③ `node tests/.ts-out/tests/run-tests.js` 全绿且 `tests/icons.test.ts` 的组内唯一仍通过。
- **优先级**：**P0**。**依赖**：无。**风险与代价**：低（电脑主球已铺开图形 / 选区两组；注意同环项数别撑爆第二页）。

### S0-7 AI：补 52 个参数描述 + 接通顶层 `warn` ⬜ P1

- **目标**：让模型选工具 / 填参数更准；让「模型可读的警告」真能到模型。
- **为什么现在**：① 本轮复测：**176 个参数里 52 个没有 `desc`**，分布在 **24 条工具**（`iso_set` 一条占 **17 个**）
  —— 这是**唯一的「纯数据、零风险、直接抬准确率」**改动；
  ② 顶层 `AiToolResult.warn` 的消费者（`ChatCallLog.warn`）链路已通但**61 条工具没有一条会填**，
  手写警告都落在 `data.warnings`（`src/app/ai-doc.ts:439` 一带）⇒ `clamped:` 与「图层已锁定」这类信息到不了模型。
- **落点**：`src/app/ai-tools.ts`（工具表 `TOOLS`，`iso_set` 优先）、对应 handler 的 `out.warn`（一处一行）、
  [`API.md`](API.md) §22.7 / §24.8 的数字、`tests/ai-tools.test.ts`。
- **验收口径**：① 统计「缺 `desc` 的参数数」⇒ **0**；② 新增断言「**无 `desc` 的参数数 === 0**」防退化；
  ③ 至少一条端到端断言证明 `data.warnings` 能到达 `ChatCallLog.warn`。
- **优先级**：**P1**（不阻塞下游，因此不是 P0；但零风险 + 一个提交，所以排进 S0，见 §0.2）。**依赖**：无；**先于** `S1-11`（带图会显著抬请求体）。
- **风险与代价**：极低。唯一注意：`iso_set` 的 17 个参数要**照着 `src/engine/iso.ts` 的真实语义**写，别把描述写成愿望（那等于给模型错信息）。

### S0-8 数据安全：三条纯增量 + 一条改错误路径语义 ⬜ P1

- **目标**：把「静默丢数据 / 静默覆盖 / 读回不校验」堵掉。**前三条不改用户可见流程；第四条会改，已单独标注。**
- **为什么现在**（本轮复测的落点）：
  ① **读回不校验内容**——`asRecord()`（`src/io/autosave.ts:161`）只看 text 是 string 且 ≥120 字符，索引里的 `hash`/`bytes` **从不对**；
  ② **写失败提示不完整**——IDB 写不进去退回 localStorage 单槽位时返回 `"local"`，而 `src/app/session.ts:1366` 一带**只对 `"fail"`/`"too-big"` 提示**
  ⇒ 用户以为历史还在，其实只剩最新一版；
  ③ **导入静默丢数据**——`src/io/project.ts:255` 一带单个画布解析失败就 `continue`（5 个画布可能只载入 4 个，零提示），
  `parseSpace` 只回 `null`，不区分「不是 `.pxc` / JSON 坏 / 版本未知」；
  ④ **cel 载荷无完整性校验**——`rleDecodeCel`（`src/io/project.ts:92`）在 run 长度和 ≠ w*h 时**静默补透明**，文件仍然**能打开**。
- **落点**：`src/io/autosave.ts`、`src/app/session.ts`（写失败分级提示）、`src/io/project.ts`、`src/ui/modals.tsx`（失败文案分档 + i18n 键）、
  `tests/autosave.test.ts` / 新增 `tests/project-verify.test.ts`。
- **验收口径**：① 手工改坏一个槽位字节后 `restoreAutosaveVersion` **返回失败**（而不是读出坏数据）；
  ② 写失败回退到 `"local"` 时**必有**用户可见提示；
  ③ 一个 5 画布工程里坏掉 1 个 ⇒ 载入 4 个**且提示「1 个画布载入失败」**；
  ④ **（这条是改错误路径语义）** 坏 RLE 载荷**仍然打开成功**，但记 `warnings` + 明确提示「部分像素缺失」——
  **不要**把它改成「判为损坏、拒绝打开」：那会让**今天能打开的存量 `.pxc` / 自动保存版本打不开**，是用户可见行为变更。
- **优先级**：**P1**。**依赖**：无（与 `S1-7` 的真存储覆盖可同批）。
- **风险与代价**：低。**「清除自动保存加确认 / 崩溃判定会话令牌 / 关闭前拦截」不在本条**（那三条改用户可见行为）⇒ §10 Q3。

### S0-9 顺手活：`engine/history.ts` 的类型反向依赖下沉 ⬜ P3

- **目标**：清掉「引擎零上层依赖」这条不变量上唯一的破口。
- **为什么现在**：`src/engine/history.ts:3` 是 `import type { ScalarData } from "../app/history-io";`（纯类型，一行活），
  破坏 [`ARCHITECTURE.md`](ARCHITECTURE.md):567 不变量 2；修法是把 `ScalarData` 的类型定义下沉到 `engine/` 或 `types.ts`。
- **落点**：`src/engine/history.ts:3`、`src/app/history-io.ts`（改 `import type` 反向引用）。
- **验收口径**：`Select-String -Path src/engine/*.ts,src/tools/*.ts -Pattern 'from "../app/'` ⇒ **0 命中**。
- **优先级**：**P3**。**依赖**：无。**风险与代价**：无（纯类型搬迁）。

### S0-10 电脑壳启动守卫（第三端首启白屏） ⬜ P1

- **目标**：干净克隆上跑电脑壳时，缺产物**立刻说清原因**，而不是白屏。
- **为什么现在**：`toolchain/pc-shell.mjs:1715` 只检查 `index.html` 是否存在，**不检查被 `.gitignore` 的 `js/app.js`**
  ⇒ 壳正常启动、页面 404 掉 JS、**白屏且没有任何提示**。而仓库里 `app2/www/js/app.js` 与 `css/style.css` **只在 `main` 分支**
  （`AGENTS.md` §5.1b）⇒ 干净克隆必然命中这个场景。第三端的第一印象就是白屏。
- **落点**：`toolchain/pc-shell.mjs:1715`（缺 `js/app.js` / `css/style.css` 时打印一行「先跑 `npm run build`（或 `sh scripts/sync-web.sh`）」并以**非 0** 退出）；
  [`README.md`](../README.md) 的电脑壳说明补一句前置条件。
- **验收口径**：在没有 `js/app.js` 的干净克隆里跑 `node toolchain/pc-shell.mjs` ⇒ **退出码非 0** 且打印前置条件（执行环境：Windows / 任意 Node 环境）。
- **优先级**：**P1**。**依赖**：无（可与 `S0-9` 同批）。**风险与代价**：无。

---

## 4. S1 近期（1–2 月）——「用户每天摸得到的：文件、引导、三端一致性、AI 落笔的可信度」

### S1-1 文件生命周期：`lastUri` 写回 + 最近工程 🅿️ P1

- **目标**：让「我有一个 `.pxc` 文件」这件事成立——保存能写回同一个文件，「另存为」是一个**显式动作**，并能一键打开最近工程。
- **为什么现在**：**每一次保存都是另存为**：APK 侧 `android/java/com/pixelcraft/app/MainActivity.java:184` 每次都 `ACTION_CREATE_DOCUMENT`（无 `lastUri` 复用）；
  无桥走 `src/io/bridge.ts` 的 `<a download>`；电脑壳 `toolchain/pc-shell.mjs` 的 `saveFile` 也是触发浏览器下载；
  `src/ui/modals.tsx:57` 一带的 `saveProject()` 只按 `doc.name` 拼名，**没有「覆盖原文件」分支**；
  全仓库没有最近工程列表（[`COMPARISON.md`](COMPARISON.md):119 自认缺口）。
  ⚠️ [`PC.md`](PC.md):61 写的是「`Ctrl+Shift+S` 另存为仍缺」——**这份写法过时**：真正的缺口不是一条快捷键，而是**没有文件身份**。
- **落点**：`MainActivity.java:180-214`（记 Uri + 写回分支）、`src/io/bridge.ts`（桥接声明面 + 无桥退化）、
  `toolchain/pc-shell.mjs`（下载侧说明）、`src/ui/modals.tsx`（`saveProject()` 分支 + 菜单项）、新增「最近工程」（复用 `src/io/autosave.ts` 的 IndexedDB 通道）。
- **验收口径**（①④ 的执行环境 = **真机 APK**，②③ 执行环境 = 电脑壳 / 网页）：
  ① 「保存」**不弹对话框**且写回同一个文件（用 `doc.name` + 文件 mtime 验证）；②「另存为」仍能选新位置（保留兜底）；
  ③ 电脑壳 / 网页保存后有明确说明（浏览器限制导致退化为固定名下载）；④ 菜单能一键打开上一条最近工程；
  ⑤ 新增「保存目标决策」的纯函数断言（`saveTarget(uri, docName)` 之类）。
- **优先级**：**P1**。**依赖**：APK 侧要动 Java 层 + 桥接契约，需同步 [`API.md`](API.md) §16.1 与 [`README.md`](../README.md)；
  「最近工程」可独立先做。**风险与代价**：中。语义变更**必须保留「每次另存为」的兜底**；SAF URI 在个别 ROM 上会失效
  ⇒ **「保存」语义本身是用户可见行为变更，先问用户**（§10 Q9）。

### S1-2 可发现性：引导补 1.1.x + 动作搜索覆盖菜单 ⬜ P1

- **目标**：1.1.0.0 之后的功能**教得到、搜得到**，并且英文界面下不再冒出中文常量。
- **为什么现在**：① 引导 46 步里**最晚的 `since` 是 `1.0.9.10`**（本轮实测），
  `src/app/guide.ts:375` 的 `guideStepsFor` 让升级用户**只重放没见过的新步骤** ⇒ **1.1.x 的升级用户打开引导无事可做**；
  ② 动作搜索覆盖不到主菜单 / 调色板面板里的功能，而文案写着「输入名字就能找到任何按钮」（`src/app/shortcuts.ts:230`）；
  ③ `guideStepsOfModule()`（`guide.ts:382`）是**死导出**、全仓无调用点，「想复看一节」只能一路点「跳过本节」；
  ④ 助手状态行说明是**中文常量不是 i18n 键**（[`AGENTS.md`](../AGENTS.md) §7 已记），英文界面下仍显示中文。
- **落点**：`src/app/guide.ts`（新增 6–8 步：等距图形 / 颜色高级两页 / 图案笔刷 / 自动保存历史 / AI 助手 + 参考图 / 高级缩放；
  AI 那两步用 `GuideStep.optional` 让非壳端跳过）、`src/ui/i18n.ts`（中英各一条）、对应控件加 `data-guide` 锚点；
  `src/ui/modals.tsx` 的菜单项包一层注册动作；主菜单引导入口改成「一节一节选」（复用死导出）。
- **验收口径**：① 新装走一遍能看到 ≥6 个 1.1.x 步骤；② 伪造 `guideSeen` 到 1.0.9.10 后只重放这些新步骤；
  ③ `tests/guide-anchors.test.ts` / `tests/i18n.test.ts` 全绿；④ `Ctrl+K` 输入「导出」「设置」「颜色分析」能命中；
  ⑤ 触屏端「快捷键一览」按电脑模式隐藏或改成「接上键盘才可用」的说明；⑥ **英文界面下助手面板无中文常量**。
- **优先级**：**P1**。**依赖**：`S0-4`（先把「41 步 vs 46 步」的口径改对）；与 `S2-3` 的 M3（`guide` 进模块）**撞同一批文件**（§7.2 真冲突 R2）。
- **风险与代价**：低-中。步数一多，全量重放体验变长 ⇒ 所以同时要做「按模块重放」。

### S1-3 导入导出：精灵表 JSON 导入 + GIF 口径统一 ⬜ P1

- **目标**：项目自己产出的格式能回来；同一个文件在三条菜单路径上给出**不矛盾**的结果或说明。
- **为什么现在**：① 导出精灵表同时写 `*_sheet.png` + `*_sheet.json`（`src/io/exporters.ts:271` 起），
  但**导入侧没有任何读这个 JSON 的代码**（`src/ui/modals.tsx:351` 一带只按 `cw/ch` 切图），
  而且**拖进窗口会被当成工程文件**（`modals.tsx:296` 把 `ext === "json"` 一律走 `loadProjectText`，失败只回一句「导入失败」）；
  ② GIF 作为「整体打开」能按帧导入（`modals.tsx:320` 一带），但「导入为图层」「精灵表」「参考图」三条路径**硬拒绝**且只给无因失败，
  而 [`PC.md`](PC.md):20 写着拖放支持 `.pxc/PNG/GIF`。
  ⚠️ [`COMPARISON.md`](COMPARISON.md):101 已经承认「导入仍缺 WebP / APNG / JSON 数据（精灵表 JSON 能导出但不能再导入）」。
- **落点**：`src/ui/modals.tsx`（JSON 嗅探 + 自动填单元格 / 时长 / 帧名）、`src/io/exporters.ts`（读回结构，**不动写入**）、`src/ui/i18n.ts`。
- **验收口径**：① 导出一张 4 帧精灵表 → 用 JSON 导入 → **帧数 / 时长 / 画布尺寸与原工程一致**；
  ② 非工程 `.json` 拖入时提示「这看起来是精灵表 JSON，用导入精灵表」；③ 三条菜单对同一个 GIF 各自给出明确、彼此不矛盾的结论或说明。
- **优先级**：**P1**（低成本、高感知）。**依赖**：无（`exporters.ts` 的 meta 结构已稳定）。**风险与代价**：低（只加读取路径）。

### S1-4 三端一致性（剩余三项） ⬜ P1

- **目标**：PWA 不显示永远起不来的设置组；两端都有全屏入口；离线口径自洽。
- **为什么现在**：① PWA 里「设置 → AI 服务」整组可见但永远起不来——`ai.server`/`ai.port`/`ai.tier`/`ai.turnIdleSec` 四条**没有任何平台门**
  （`src/app/settings.ts:1214` 一带），而助手那组有 `visible: bridge.isNativeShell()`（`settings.ts:535`）；
  ② 电脑壳里全屏按钮消失（`src/ui/fullscreen.ts:54` 的 `isNativeShell()` 为真 ⇒ 不渲染），只能靠 F11；
  ③ [`README.md`](../README.md):6 写「PWA / 网页版（可离线安装）」而 `:158` 写「无 service worker，离线使用请安装 APK」——**同一份 README 互相打脸**
  （本轮复测：`src/` 里 `serviceWorker` **0 命中**）。
- **落点**：`src/app/settings.ts:1214` 一带（加平台门，**必须保留电脑壳可见**——壳有 `aiServerStart`）、`src/ui/fullscreen.ts:54` + 电脑壳、
  [`README.md`](../README.md):6 / :158。
- **验收口径**：① 浏览器里「AI 服务」组不可见（或置灰 + 一句「本端不支持」），电脑壳里**仍可见可用**；
  ② 电脑壳里有全屏入口；③ README 两处口径一致。
- **优先级**：**P1**。**依赖**：无。**风险与代价**：低。（第三端白屏那条已拆到 `S0-10`。）

### S1-5 新建画布预设 + 底色 ⬜ P2

- **目标**：一键新建常用尺寸。
- **为什么现在**：`NewDocModal`（`src/ui/modals.tsx:681` 起，本轮读过 700-712 行）只有名称 / 宽 / 高 / 一个「白底」开关
  （`<NumberField>` ×2 + 一个 `whiteBg` chip），底色只有纯白或透明两档，没有 32/64/128 之类预设，也没有「从剪贴板新建」。
  像素画最常见的开场要手打数字，手机端尤其贵。
- **落点**：`src/ui/modals.tsx:700-712`（尺寸 chips + 底色复用 `ColorField`）、`src/app/settings.ts` 的 `general.newDocW/H` 保留。
- **验收口径**：① 一键新建 32×32；② 底色选自定义色后新画布首帧填充该色；③ 弹窗已有的 `data-guide` 锚点**不改名**（否则引导锚点测试红）。
- **优先级**：**P2**。**依赖**：无。**风险与代价**：低。

### S1-6 动画标签的方向 / 重复次数参与播放 ⬜ P2

- **目标**：从 Aseprite 导入的标签方向与次数**真的生效**。
- **为什么现在**：`FrameTag` 有 `dir` / `repeat` 字段，源码注释自述是 file metadata
  （`src/engine/doc.ts:28`：「`dir`/`repeat` mirror the .aseprite tag chunk so tags survive」），
  读写两侧都保留它，但 `src/app/playback.ts` 只认**全局** `LoopMode`（该模块的 `dir` 是乒乓方向，不是标签的方向字段）
  ⇒ 导入一个「reverse / pingpong / 播 3 次」的标签，PixelCraft 按自己的全局模式播。
- **落点**：`src/app/playback.ts`（`startPlayback(tag)` 时按标签自身方向 / 次数覆盖全局，全局仍是默认）、`src/ui/timeline.tsx` 的 `TagModal`（暴露两个字段）、
  [`API.md`](API.md)（口径变化）。
- **验收口径**：① 导入带 pingpong / 3 次的 `.aseprite`，点该标签播放的行为与 Aseprite 一致；② 导出后这两个字段不变（往返断言）；③ 全局循环模式仍是默认。
- **优先级**：**P2**。**依赖**：无。**风险与代价**：低-中（会改「点标签＝播这一段」的既有口径，需同步文档）。

### S1-7 质量基建第二批：e2e 冒烟入库 + 性能门禁 + 恢复链路覆盖 ⬜ P1

- **目标**：把「只在 `%TEMP%` 里重生的一次性验证」变成仓库资产，并给性能与崩溃恢复加退化可见性。
- **为什么现在**：① **真浏览器 e2e 完全不在仓库里**——本轮复测 `toolchain/` 只有 `ai-server.mjs / check-bundle.mjs / devserver.js / make-icon.js / pc-mcp.mjs / pc-shell.mjs / stress-stroke.mjs`，
  `scripts/` 只有 5 个 `.sh`，**没有任何 e2e / CDP / headless 脚本**；文档里的「43 条端到端断言全绿」（[`PLAN-ai.md`](PLAN-ai.md):1105）**不可从仓库复现**；
  更糟的是一次性脚本会**临时把仓库的 `app2/www/js/app.js` 换成探针包再换回**（`%TEMP%\pc-e2e\e2e.cjs` 自述），中途失败会把探针包留在工作区；
  ② `toolchain/check-bundle.mjs:33` 的 DOM 桩是 `getContext: () => null`，`:105` 只断言「能加载且渲染出 ≥1 个节点」，
  且 `scripts/build-web.sh:34-38` **只把退出码 1 当致命**、退出码 2 降级成一句提示；
  ③ 无性能门禁（`stress-stroke.mjs` 只打印数字）；
  ④ **真存储与崩溃恢复 0 覆盖**：本轮复测 `wasCleanExit` / `markCleanExit` / `markSessionRunning` / `checkBootCrash` / `restoreAutosaveVersion` /
  `exportAutosaveVersion` / `clearAutosave` 在 `tests/` 里**全部 0 命中**（只有 `saveAutosave` 被两处打桩）。
- **落点**：新增 `toolchain/e2e-smoke.mjs`（**只读 `app2/www`、不换产物**，用命令行参数 / URL 注入探针；
  固定三条最小断言：加载无 console error；新建文档画一笔后像素 / 历史变化；导出 PNG 的 magic 字节），挂到 `S0-1` 同一条 CI；
  `toolchain/stress-stroke.mjs --json` + 入库阈值（**阈值必须在 `S0-5` 的 rig A 下先测 3 次再定**）；
  `tests/autosave.test.ts` 加真 IndexedDB 路径 + 崩溃恢复链路用例。
- **验收口径**：① `node toolchain/e2e-smoke.mjs` 在 CI 里退出码 0；② 它**不写** `app2/www` 下任何文件（跑完 `git status --short` 只剩本来就有的产物）；
  ③ 性能门禁在人为把 `mirrorCells` 改慢 2× 后**必须红**；④ 崩溃恢复链路 ≥10 条断言（现在 0 条）。
- **优先级**：**P1**（e2e + 恢复覆盖）/ **P2**（性能门禁）。**依赖**：`S0-1`、`S0-5`。
- **风险与代价**：中：CI 里要有 Chromium（体积与时间成本）；性能门禁阈值定太紧会天天红（先用宽松阈值 + 观察期）。

### S1-8 架构前置：M0 模块工具链 + 依赖方向检查 ⬜ P1

- **目标**：给模块化提供**可执行的机器判据**，并先给现有依赖记账。
- **为什么现在**：① [`ARCHITECTURE.md`](ARCHITECTURE.md):464 的 **M0** 明确写「可与 P0–P2 并行」，
  而它的交付物**此刻不存在**（本轮复测 `Test-Path scripts/modules.mjs` = False）；
  ② 依赖方向的**判据与现状已经不一致**：文档记的三处硬伤之外，实测还有
  `src/io/exporters.ts:4` 的 `import * as comp from "../render/compositor"`（**io 反向依赖渲染，文档没记**）、
  `src/render/view.ts` 的 4 处 `app/` 依赖、`src/ui/renderdebug.tsx:14` 依赖 `servers/`（[`ARCHITECTURE.md`](ARCHITECTURE.md) §3.8 明令禁止）
  ⇒ 检查脚本一上线就红，所以**必须先记账、先只报告不拦截**。
- **落点**：新增 `scripts/modules.mjs`、`src/modules/_generated.ts`、`tests/modules.test.ts`、依赖方向检查脚本（[`ARCHITECTURE.md`](ARCHITECTURE.md):581 决策 4「推荐做，成本低」）、`modules.config.json`。
- **验收口径**：① `tests/modules.test.ts` 能拦住「依赖缺失 / 成环 / id 重复」三类错误（各造一个反例，必须红）；
  ② 依赖方向检查**先以 report 模式**进 `verify`（打印四类边清单），全部记账后再升级为失败；
  ③ 全开时 bundle 与行为**零变化**（`check-bundle` + 全量测试 + 产物 md5 对比）。
- **优先级**：**P1**。**依赖**：`S0-1`/`S0-2`。**下游**：`S1-9`、`S2-3`、`S3-1`。
- **风险与代价**：低（M0 行为零变化）。**注意**：`import type` 的环与 `import * as X` 的实现依赖要**分开记账**——前者可容忍，后者必须收口。

### S1-9 绞杀者第一刀：切 `Session ↔ View` 环 ⬜ P1

- **目标**：让模块化有一个**真地基**，并把「耦合」变成可验收数字。
- **为什么现在**：`Session` 与 `View` 互相 `import type`（`src/app/session.ts:27` / `src/render/view.ts:23`）构成模块级环，
  `Session` 持有 `private view_: View | null`（`session.ts:624`）并直调——文档写 **10 处**（[`ARCHITECTURE.md`](ARCHITECTURE.md):132），
  实测 **56 次调用（分布 55 行）**（口径见 §0.5）。这是 [`ARCHITECTURE.md`](ARCHITECTURE.md):456-459 明说的**模块化硬前置**。
  同时「填充落在哪」这类业务规则仍住在 `View` 里（`session.ts:1301` 的 `quickFill()` → `view_.quickFill()`），**无 DOM 测不到**。
- **落点**：`src/app/session.ts`、`src/render/view.ts`；按 [`ARCHITECTURE.md`](ARCHITECTURE.md) §5.2 的 P0（`HistoryServer`）/ P1（`PaletteServer`）起步，
  本期**只搬一个域**，并同时把「业务规则从 View 搬回可测层」。
- **验收口径**：① `view_` **调用次数 ≤ 45**（起点 **56**；口径同 §0.5：出现次数减声明行，**声明行不计**）；
  ② `node tests/.ts-out/tests/run-tests.js` 断言数**只增不减**且 `ALL PASS`；
  ③ 行为回归：同一串操作前后文档像素**逐字节一致**（[`ARCHITECTURE.md`](ARCHITECTURE.md):521 的口径）；
  ④ 每期在提交信息里报「`view_` 调用次数 / `session.ts` 行数」。
- **优先级**：**P1**。**依赖**：`S1-8`（依赖方向检查提供判据）。
- **风险与代价**：**高**——改动面最大、回归面全在这两个文件上（[`ARCHITECTURE.md`](ARCHITECTURE.md):98 自己写「风险：高」）。
  缓解＝每期只搬一个域 + **先补行为断言再搬代码**。

### S1-10 性能：热路径去分配（回调式遍历 + 复用缓冲） ⬜ P2

- **目标**：把 `mirrorCells` / `wrapPts` / `stampCells` 的**逐格分配**去掉，降低大笔刷的同步峰值与 GC 压力。
- **为什么现在**：**先纠正口径**——`AGENTS.md` §7 与 [`COMPARISON.md`](COMPARISON.md) §三.1（`:91-92`）说的「`stampCells()` 每次移动重建笔尖图案」
  **不成立**：模块级 `stampCache` 早在 `src/engine/paint.ts:364`（`brushStamp(64) === brushStamp(64)` 为 true），
  真正逐格分配的是 `src/engine/symmetry.ts:30-47` 的 `mirrorCells`、`src/tools/stroke.ts:199` 的 `wrapPts`、`src/tools/stroke.ts:381` 的 `stampCells`。
  收益**真实但量级有限**——**本轮复跑** `%TEMP%\pc-audit-stroke-bench2.cjs`（Node 侧合成基准）：
  平铺开 `avg 0.978 → 0.508 ms`、`max 1.448 → 0.775 ms`（约 **1.9×**）；平铺关 `avg 0.656 → 0.435 ms`；
  `node --trace-gc` 全程 **836 次 Scavenge**。
  ⚠️ **这是 Node 侧、按「运行时 patch 成不建数组的实现」量出的**上限，不等于浏览器端真机收益。
- **落点**：`src/engine/symmetry.ts:30-47`、`src/tools/stroke.ts:199`、`src/tools/stroke.ts:381`。
- **验收口径**：① 在 **`S0-5` 的 rig A** 下，最坏配置的 **p95 与 max 至少改善 30%**；② `--plain` 与最坏配置**都不退化**；
  ③ 全量测试 `ALL PASS`（图形 / 对称 / 笔迹断言全绿）。
- **优先级**：**P2**。**依赖**：`S0-5`（协议）、`S0-4`（口径纠正）。**风险与代价**：**中**。
  复用缓冲要求**调用方不保留返回数组**——`stroke.ts:413` 的 `this.ppSaved = { cells, bytes }` **会留下返回的数组**
  ⇒ 改这里必须逐调用点确认，否则会出现「偶发画错一像素」的静默 bug。

### S1-11 AI 深化：协议层确认器 + `render_preview` 🅿️ P1

- **目标**：让协议 / MCP 这条路**真的能改画**（而不是永远 `cancelled`）；让模型**能看到自己画的**。
- **为什么现在**：① `setAiConfirmer()`（`src/app/ai-serve.ts:511`）存在但**产品路径从没调用过**（本轮复测：`setAiConfirmer` 在 `src/` 里只出现在 `ai-serve.ts`，`tests/` 里 3 次），
  默认是 `AI_CONFIRM_DENY`（`src/app/ai-rpc.ts:86`，`:556` 处 `confirm: ctx.confirm ?? AI_CONFIRM_DENY`）
  ⇒ `curl` / Claude Desktop 上一切 destructive **必然 `cancelled`**（把 tier 设成 `all` 也没用）。
  ⚠️ **依赖链**：`android/java/com/pixelcraft/app/AiServer.java:103` 的 `READ_TIMEOUT_MS = 10000` ⇒ **确认必须在 10s 内完成**，
  而人在终端输 y/N 很容易超时；放宽它又要付「挂起一直占一个 worker」的代价。
  ② `ai-vision.ts` 只做完「用户挂图 → 模型」这条腿，**反向腿不存在**；[`PLAN-ai.md`](PLAN-ai.md) 把「理解」轴记为 `render_preview` 并列在未落地。
  后果：模型只能读文本网格与摘要，**看不到自己画的** ⇒ 配色 / 对比度 / 构图做不了、也无法自检。
- **落点**：`toolchain/pc-mcp.mjs`（`--allow-destructive` 之类的最小可行确认）、`src/app/ai-rpc.ts`（确认器接入）、[`API.md`](API.md) §24/§25；
  `render_preview` = `src/render/compositor.ts` + `src/io/exporters.ts` 的 PNG 编码 + `src/app/ai-vision.ts` 的体积闸门，
  **不新增出站通道**（复用 `/provider/chat` 与已有的能力门控）。
- **验收口径**：① 从 MCP 宿主发起一次 `canvas_clear`，在确认窗口内回答 y ⇒ **真删且返回 ok**；回答 N 或超时 ⇒ 文档**逐字节不变**；
  ② 新增断言证明「协议层确认器非默认 deny 时行为正确」；③ `render_preview` 返回的 PNG 能被 `ai-vision` 的体积闸门接受；
  ④ **重核请求体**：61 条 schema + 一张图的实际大小必须量出来（[`API.md`](API.md):4070 自报约 **60–90 KB**）。
- **优先级**：**P1**。**依赖**：`S0-7`（`desc` 先补完）；**确认策略要做多细需用户拍板**（§10 Q5）。
- **风险与代价**：**高**（红线相关）。`src/app/ai-rpc.ts:86` 的 `AI_CONFIRM_DENY` 是**单行致命改动点**：
  把它改成 `() => true` 就是一次 `canvas_clear` 毁作品——**不要改它**。`render_preview` 的代价是 token 成本与首字延迟。

### S1-12 AI 工具面：`export_*` / `selection_*` + 本地模型实跑 ⬜ P2

- **目标**：补齐工具面里最常用的一段，并把「本地模型」这条线跑通一次。
- **为什么现在**：本轮复测这些工具**在 `src/` 里 0 命中**：`render_preview`、`export_png`、`selection_rect` 等；
  [`PLAN-ai.md`](PLAN-ai.md) 自己把 `export_*` / `selection_*` 记为未落地。
  本地模型只有**文档测法**（[`API.md`](API.md):3943-3950 的测法 A：`--provider-key local --provider-base http://127.0.0.1:11434/v1`），**没有任何实测记录**。
- **落点**：`src/app/ai-tools.ts`（工具表）+ `src/app/ai-draw.ts`（落笔适配，**不 import `History`** 这条静态规则要保住）、
  `tests/ai-tools.test.ts` / `tests/ai-draw.test.ts`；本地模型实跑按测法 A。
- **验收口径**：① 工具表条数按新增清单上升，且「工具 → 实现一一对应」断言全绿；
  ② `export_png` 产出的字节与既有导出路径**逐字节一致**（黄金 md5）；
  ③ 本地模型实跑记录（命令、模型名、成功 / 失败、耗时）写进文档，**不靠印象**。
- **优先级**：**P2**。**依赖**：无（本地模型实跑零成本，可提前）。**风险与代价**：低-中。
  本地模型对 61 条 schema + `tool_choice` 的兼容度**未知**；`export_*` 会引出一个新问题——**导出到哪**（与 `S1-1` 的文件身份同源）。

---

## 5. S2 中期（3–6 月）——「结构：Server 化与模块化真正开工，专业工作流补环」

### S2-1 Server 化 P2–P5 收尾（P5 的完成口径重新钉） ⬜ P1

- **目标**：按 [`ARCHITECTURE.md`](ARCHITECTURE.md) §5.2 推完 P2–P5，并**先把 P5 的完成口径改成可验收的**。
- **为什么现在**：[`ARCHITECTURE.md`](ARCHITECTURE.md):604 把 P5 记为「🟢 四片完成」（同时记「`GestureHost` 93 → 54 个成员」），
  但本轮 **AST 复测** `src/servers/gesture.ts:359..434` 的 `GestureHost` 接口是 **56 个成员**（50 个方法签名 + 6 个属性签名），
  `GestureController` 是 **6 个方法 + 39 个字段**（45 个成员）⇒ **这是状态搬家，不是耦合下降**。
  若把 P5 记为「已完成」，M3 会建在一个仍耦合的地基上。
  ⚠️ 口径差：文档记 54、本轮复测 **56**，差 2 未定位 ⇒ **以本轮复测数为起点**，并在条目里一并订正文档数字。
- **落点**：`src/servers/`、`src/render/view.ts`、`src/app/session.ts`；[`ARCHITECTURE.md`](ARCHITECTURE.md):604 的状态行。
- **验收口径**：① `GestureHost` 成员数 **≤ 20**（起点 **56**，口径 = `ts.createSourceFile` 的 `interfaceDeclaration.members.length`）；
  ② `view.ts` 行数**单调下降**并在提交信息里报数（起点 3,693，LF 口径）；
  ③ 每期 `tsc` 0 错误 + 断言只增不减 + `ALL PASS`；④ 同一文档合成结果逐字节一致（P4 的口径）。
- **优先级**：**P1**。**依赖**：`S1-9`。**风险与代价**：**高**。手势是用户直接感知的路径，回归面大；
  但 `tests/gesture.test.ts` + `tests/gesture-host.test.ts` + 三个白盒 UI 测试已钉住一批行为，**先补断言再动**。

### S2-2 `SignalHub` 最小版 ⬜ P2

- **目标**：把全量 `changed()` 换成**分域订阅**，给 `App.tsx` 的复杂度一个下降的地基。
- **为什么现在**：`Session.changed()` 做四件事并通知**全部** listener，`snapshot()` 以单一 `snapRev === this.rev` 做全局缓存；
  本轮复测全仓 `changed()`（无参）调用 **72 处**（`this.changed()` **64**；分布 `session.ts` 65 / `render/view.ts` 3 / `tools/stroke.ts` 2 / `ui/App.tsx` 1 / `app/ai-draw.ts` 1）；
  `SignalHub` 在源码里**零命中**、`new Worker(` / `OffscreenCanvas` 也**零命中** ⇒ 这就是 P7 的全部现状，而 **M3 挂在它后面**（[`ARCHITECTURE.md`](ARCHITECTURE.md):509）。
- **落点**：`src/app/session.ts`（分域快照）、新增 `src/servers/signal.ts`、`src/ui/*` 订阅点；[`ARCHITECTURE.md`](ARCHITECTURE.md):580 决策 3。
- **验收口径**：① 切 5–6 个频道（建议：doc / tool / selection / palette / playback / layout）；② `App.tsx` 的 `snapshot` 拆成**按域快照**，每域独立版本号；
  ③ **沿用 [`ARCHITECTURE.md`](ARCHITECTURE.md):522 的括号豁免**——本期不守「UI 零改动」，改为「关键屏人工过 + e2e 冒烟 + 重渲染计数下降」，其余期仍守「UI 零改动」；
  ④ 用计数器记录 React 重渲染次数，**必须下降**。
- **优先级**：**P2**。**依赖**：`S2-1`（Session 先瘦）、`S1-7`（需要 e2e 才敢改 UI 语义）。
- **风险与代价**：**中-高**（React 重渲染语义变化、UI 回归面大）。
  **Web Worker / OffscreenCanvas（导出 / 大图重采样）列为「明确不做」**（§9）：单文件 IIFE + `file://` 离线的形态下复杂度远高于收益。

### S2-3 模块化 M1–M2 ⬜ P1

- **目标**：把最独立的八个模块搬成可裁剪单位（[`ARCHITECTURE.md`](ARCHITECTURE.md):465-466）。
- **为什么现在**：M1 的前置（P3/P4）在 `S2-1` 完成后成立；且 `ai` 之外的模块今天**已经全部编进同一个包**（本轮复测 `scripts/modules.mjs` 不存在 ⇒ 可裁剪模块数 = 0）。
  ⚠️ **注意真冲突 R2**：M1 的 `iso` / `color-analysis`+`shading` 与 `S1-2`（改 `guide.ts`）、`S1-3`（改精灵表导入）、`S2-8`（改 `iso`）**落在同一批文件上**。
- **落点**：`src/modules/*/module.ts`、`src/engine/iso.ts` + `src/ui/iso.tsx`、`src/engine/color-analysis.ts`、`src/engine/shading.ts`、
  `src/io/aseread.ts` / `asewrite.ts` / `zlib.ts` 等；`tests/modules/<id>.test.ts`。
- **验收口径**：① 全开时 bundle 与行为**不变**（产物 md5 对比）；② 关掉某模块后 `tsc` / 测试 / `check-bundle` 全绿且**无悬空入口**
  （新增静态断言：核心不得出现可选模块的字面量，如关掉 `iso` 后 `App.tsx` 里不得有 `i-iso`）；
  ③ **数据完整性测试**：关掉 `tags` / `animation` 后读写 `.pxc` / `.aseprite` **不丢字段**（[`ARCHITECTURE.md`](ARCHITECTURE.md):416-418）。
- **优先级**：**P1**。**依赖**：`S1-8`（M0）、`S2-1`（P3/P4）。
- **风险与代价**：中。[`ARCHITECTURE.md`](ARCHITECTURE.md):471-480 的七条风险都成立，最实际的是「UI 悬空入口」与「测试工具要改成按启用模块扫描」。

### S2-4 专业工作流：降到 N 色 / 时间轴缩略图 / 图层组 🅿️ P2

- **目标**：补上「替代 Aseprite」叙事里最常被点名的三块中的两块半。
- **为什么现在**（本轮复测的存在性）：`src/` 里 `quantiz` **0 命中**（没有量化 / 降色 / 抖动到指定色数）、`layerGroup` **0 命中**（`Layer` 无组概念）；
  [`COMPARISON.md`](COMPARISON.md):66 把 Tilemap 记为「**无**」；时间轴帧头是数字（缩略图只在帧预览与引用画布选择页出现）。
- **落点**：① 降到 N 色 = `src/engine/color-analysis.ts` + 调色板面板（复用统计 + 最近色映射，成本最低、与既有模块同源）；
  ② 时间轴缩略图 + 组折叠 = `src/ui/timeline.tsx` + `src/engine/doc.ts`（需改 `.pxc` / `.aseprite` 双向，**先做 `S2-9`**）；
  ③ tilemap **不在这条**（§9 明确不做 / 单独立项）。
- **验收口径**：① 给一张 24 色图，降到 8 色后画面**只用 ≤8 色**、可撤销、CSV / 统计对得上；
  ② 组折叠后播放与导出结果不变，`.pxc` 往返逐字节一致（断言）；③ 时间轴帧头显示缩略图且不影响滚动性能（`S0-5` 协议下测）。
- **优先级**：**P2**。**依赖**：`S2-9`（格式版本与迁移，做 ② 之前必须先有）。
- **风险与代价**：中-高（② 改数据结构，牵动导入导出与 90+ 提交的回归面）。**触屏上组嵌套的操作成本不低** ⇒ §10 Q6。

### S2-5 大画布 1024² 的可用性口径 ⬜ P2

- **目标**：给出「1024² × 多图层算不算支持范围」的**可量化结论**，而不是含糊的「未做压力测试」。
- **为什么现在**：**待验证的数字**（t1 实测，本轮未复跑）：同一笔（32px 圆刷、40 步、单图层）在 `1024²` 下
  Stroke 构造 ~1.04 ms + `commit()` ~3.07 ms，而 `64²` 是 0.13 / 0.06 ms ⇒ **每笔固定约 4 ms ≈ 一帧预算的 1/4**，
  且顿挫落在「松手那一下」。落点明确：`src/tools/stroke.ts:110` 的 `new Uint8ClampedArray(cel.data)`（4MB 拷贝）、
  `stroke.ts:628` 的 `changed()` 全缓冲扫描、`src/engine/history.ts:149` 一带的逐像素全扫。
  ⚠️ 该数字只有 **Node（V8，无 DOM）** 证据，浏览器端 1024² **未测**。
- **落点**：`toolchain/stress-stroke.mjs`（加 1024² rig）、[`COMPARISON.md`](COMPARISON.md) §三.1、`src/tools/stroke.ts` / `src/engine/history.ts`（若决定优化）。
- **验收口径**：先按 `S0-5` 的 rig A 复测，然后二选一并写进文档——
  ① **优化到阈值内**：1024² 单笔 `commit()` p95 < 2 ms；或
  ② **明确排除**：文档写「支持到 512² × 多图层；1024² 为实验性」，并在 UI 给出提示。
- **优先级**：**P2**。**依赖**：`S0-5`。**风险与代价**：低（只测量）；若要优化，`pushPixels` 的稀疏化要小心「全档快照 vs 差分」的历史语义（`AGENTS.md` §7 已有一大段「别顺手改」）。

### S2-6 AI：预算会计 + 小数截断口径统一 ⬜ P2

- **目标**：长任务可估成本；两条读取路径的边界口径一致。
- **为什么现在**：① 轮数 / 调用数 / 结果字符上限都已定（[`API.md`](API.md):3623-3626），但**没有 token / 费用预算会计**；
  ② `readRegion` 的 `opts.fi` / `opts.li` 小数仍**静默截断**（`src/app/ai-doc.ts:283` 一带的 `intOr`），而 `applyOps` 侧已统一成 `warnings` ⇒ 两条路径口径不一致。
- **落点**：`src/app/ai-chat.ts`（`runChatTurn` 加预算回调；`ChatTurnResult.stop` 加第四档 `budget` 是**加可选值不是改形状**）、
  `src/app/ai-doc.ts`（`readRegion` 走 `warnings`）。
- **验收口径**：① 预算超限时 `stop === "budget"` 且**不吞错**（断言）；② `readRegion` 传小数 `fi`/`li` ⇒ 返回 `warn` 而不是静默截断；
  ③ 一次真实多轮调用的 token 用量有记录。
- **优先级**：**P2**。**依赖**：`S0-7`（`warn` 链路）。**风险与代价**：低。

### S2-7 Android 侧同源代理（没有真机就不开工） 🅿️ P3

- **目标**：让 APK 上的助手真的能用（今天形同虚设）。
- **为什么现在**：三条事实——① Android 没有给宿主进程用的环境变量机制；② `MainActivity` 没开
  `setAllowUniversalAccessFromFileURLs` / `setAllowFileAccessFromFileURLs`，WebView 对 `file://` 跨源 `fetch` 默认拦（**未验证**）；
  ③ `INTERNET` 已在（`android/AndroidManifest.xml`）。而 **APK 是主端**。
  [`PLAN-ai.md`](PLAN-ai.md):1001 把这条记为「本轮**明确不做**」——**与本条不冲突**：本蓝图保留它作为「**有设备才开工**」的候选，没有设备就不做。
- **落点**：`android/java/com/pixelcraft/app/AiServer.java` 或 `MainActivity`（同源代理）；`src/app/ai-chat.ts` 的传输检测。
- **验收口径**（执行环境 = **真机 / 模拟器**）：① 真机上打开助手，发一句话 ⇒ 走同源代理、**key 不进页面**（复用壳侧的擦除与哨兵口径）；
  ② 关闭代理后行为回落明确（有提示、不静默失败）。
- **优先级**：**P3**。**依赖**：**真实设备 / 模拟器**（§10 Q10；见 §12 真机验证计划）。
- **风险与代价**：中。「只绑 `127.0.0.1`」在这条路上要重新验证：`toolchain/pc-shell.mjs` 有**两个监听点**（`:1726` 与应用端口不一致时另绑的 `:973/976/984`），
  只改一处会留下对外监听，Android 侧同理。

### S2-8 PLAN-isobuilder v2 收尾 ⬜ P2

- **目标**：把 [`PLAN-isobuilder.md`](PLAN-isobuilder.md) §6 的 v2 收干净（v1 已落地）。
- **为什么现在**：v1（几何 + 六个形状 + `isoRender` + 模式进出 + 三个抓手 + 参数条 + 魔法球入口）**已全部落地**（该文件 §10 记 ✅），
  文档自己在「下一步」里列了 1–4 条：① 首次进入的就地提示 + 引导真操作演示（**与 `S1-2` 合并**）；
  ② 「重编辑上一次」（记住最后一次生成的参数，改参数原地重生成）；③ v2：投影式阴影（8 档光照）、左右视角切换、更多形状、PC 快捷键；④ v3 见 `S3-3`。
- **落点**：`src/engine/iso.ts`、`src/app/session.ts`（iso 会话）、`src/ui/iso.tsx`、`src/render/view.ts`（覆盖层）。
- **验收口径**：① 「重编辑上一次」改参数后原地重生成且**只压一条历史**（断言）；② 8 档光照下阴影方向随光源改变（黄金值断言）；
  ③ 左右视角切换 = 绕 z 轴镜像，`Voxels` 断言逐体素对上；
  ④ `tests/iso.test.ts` 的 `iso.align.*` / `iso.snap.*` / `iso.place.*` 全绿（**别把 2026-09-13 的对齐修正改回去**）。
- **优先级**：**P2**。**依赖**：若 `S2-3` 先动 `iso`，本条排在它之后或合并（§7.2 真冲突 R2）。**风险与代价**：低-中（有 529 行引擎 + 黄金测试兜底）。

### S2-9 `.pxc` 格式版本与迁移兼容 ⬜ P1

- **目标**：改数据结构的**前置条件**：任何 `S2-4 ②` / `S3-4` 的字段变更都必须走这条。
- **为什么现在**（本轮复测的口径）：**版本字段其实已经存在**——`src/io/project.ts:233/235` 写出 `v: 3`；
  但**读侧不校验**（`obj.v` 在 `src/io/project.ts` 里 0 命中），也**没有旧版本加载路径与迁移测试**
  ⇒ 未来 v4 文件会被按 v3 猜着读，而坏载荷会被静默修补（`rleDecodeCel` 在 `src/io/project.ts:92` 补透明）。
  [`AGENTS.md`](../AGENTS.md) §7 已有「同一批 cel 字节两种读法」的历史教训——**格式约定不写清，后患就是观感变化**。
- **落点**：`src/io/project.ts`（读侧校验 `v` + 版本分派）、新增迁移函数、`tests/project-version.test.ts`。
- **验收口径**：① 未知版本（如 `v: 4`）的文件**明确报错**而不是按 v3 猜读；
  ② 每个历史版本有一个「打开旧工程不丢字段」的**黄金断言**（比对规范化后的 JSON）；
  ③ `S2-3` 的「数据完整性测试」口径挂到本条下面。
- **优先级**：**P1**（它阻塞 `S2-4 ②` 与 `S3-4`）。**依赖**：无。**风险与代价**：低-中（不动写侧格式，只加读侧校验与迁移骨架）。

### S2-10 上游预设与能力位刷新（运维项） ⬜ P3

- **目标**：模型名 / 端点 / 能力位是**会过期**的数据，要有定期刷新与降级路径。
- **为什么现在**：AI 线押在 `src/app/ai-presets.ts` 里写死的主机与模型名上（`https://api.deepseek.com` + `deepseek-v4-pro`（默认）/ `deepseek-flash`；
  `https://api.openai.com/v1` + `gpt-4o-mini` / `gpt-4o`，后两者视觉能力标 `unknown`），
  该文件自己的注释已经在处理「旧名已下线」这类事实。仓库没有「预设随上游变化刷新」的维护项，也没有「端点 / 模型弃用时的降级」验收。
- **落点**：`src/app/ai-presets.ts`、`src/app/settings.ts` 的默认值、[`API.md`](API.md) §26 的预设与能力位表。
- **验收口径**：① 每次刷新给出「核对日期 + 来源」的注释（该文件已有此惯例）；
  ② 能力位重测（含 vision 三态）有记录；③ 上游 4xx / 模型下线时**有可读的降级文案**，并有断言（不静默失败）。
- **优先级**：**P3**。**依赖**：无。**风险与代价**：低（纯数据 + 文案）。

---

## 6. S3 远期（6 月+）

### S3-1 M4：`ai` 模块 + 两条产线 + CI 三预设矩阵 🅿️ P2

- **目标**：把 AI 能力按 [`ARCHITECTURE.md`](ARCHITECTURE.md):468 的 M4 做成**可裁剪模块**，并让不同预设各自出包。
- **为什么现在**：[`ARCHITECTURE.md`](ARCHITECTURE.md):345 把 `ai` 列为可裁剪模块并在同一行写「**（未实现）**」、`:468` M4、
  而 **AI 能力本身已全量落地**（[`PLAN-ai.md`](PLAN-ai.md) 的 C0–C18 全 ✅）。**这是同一份计划里两套并行说法**（§7.2 真冲突 R1）：
  本蓝图显式分成「**AI 能力线**（已落地，续期走 `S0-7`/`S1-11`/`S1-12`/`S2-6`/`S2-10`）」与「**`ai` 模块化**（未开始，走本条）」。
  且 AI 的运行时接线**只有 3 处**（`src/main.tsx`、`src/app/session.ts`、`src/ui/AiPanel.tsx` + `src/ui/App.tsx`），是模块化的**低成本候选**。
- **落点**：`src/modules/ai/module.ts`（manifest + `register(ctx)`）、`modules.config.json` 的 `studio` 预设、CI 三预设矩阵。
- **验收口径**：① `pixel-core`（无 `ai`）与 `studio`（含 `ai`）**都能出包**；
  ② 关掉 `ai` 后 `tsc` / 测试 / `check-bundle` 全绿且**无悬空入口**（`Ctrl+K` 搜不到 AI 助手、设置里无 AI 组）；
  ③ 关掉 `ai` 时 `.pxc` / `.aseprite` 读写**不丢字段**。
- **优先级**：**P2**。**依赖**：`S2-3`、`S2-1`、`S2-2`。**风险与代价**：中。
  **「`ai` 要不要进可裁剪模块」是用户决策点**（§10 Q4）——它会牵动 `App.tsx` / `modals.tsx` 的注册表，而这两个正是最大的两个文件。

### S3-2 变体发布 + 体积报告 ⬜ P3

- **目标**：一个仓库出多种产品形态（[`ARCHITECTURE.md`](ARCHITECTURE.md) §4.7）。
- **为什么现在**：这是模块化的**真正收益**（该文档 §4.8 明写「不要把预期放在省 50 KB」，目标是交付形态与复杂度上限）。
- **落点**：`modules.config.json` 的 preset、`scripts/build-web.sh` / 出包脚本的变体参数、产物命名。
- **验收口径**：① 每个预设都跑 `tsc` + 全量测试 + `check-bundle`；② **每个预设报「gzip 后首屏体积」**（现在 `app2/www/js/app.js` = 1,334,285 B，没有体积门禁）。
- **优先级**：**P3**。**依赖**：`S3-1`。**风险与代价**：中。**预设数量（4 个 vs 2 个）是用户决策点**（§10 Q7）。

### S3-3 PLAN-isobuilder v3 ⬜ P3

- **目标**：[`PLAN-isobuilder.md`](PLAN-isobuilder.md) §6 / §7 的高级与差异化那一层（三视图高级模式 `solid = top && front && side`、逐帧等距动画、等距精灵表导出、6 向旋转、多画布联动）。
- **为什么现在**：它是已定稿计划里的既有内容，**不新增方向**。
- **落点**：`src/engine/iso.ts`（剪影求交）、导出器、`src/render/view.ts`。
- **验收口径**：沿用该文档 §7 的备忘口径；每项都要有黄金值断言；文档写明局限（凹形 / 悬空 / 细节会失真）。
- **优先级**：**P3**。**依赖**：`S2-8`。**风险与代价**：中（复用同一渲染器降低风险）。

### S3-4 生态：`.aseprite` 图层组 / 瓦片层往返 🅿️ P3

- **目标**：让 Aseprite 工程的组与 tilemap 层**不丢**。
- **为什么现在**：今天导入时组被拍平、tilemap 层被丢弃（`src/io/aseread.ts:452` 一带的注释自述「groups and tilemaps have no pixel data we can store」）。
- **落点**：`src/io/aseread.ts` / `asewrite.ts` / `src/engine/doc.ts`。
- **验收口径**：① 一个含 2 个组 + 1 个 tilemap 层的 `.aseprite` 往返后**组结构与瓦片层仍在**
  （或明确记录「瓦片层以展平图片保留」并断言）；② `.pxc` 往返逐字节一致。
- **优先级**：**P3**。**依赖**：`S2-4 ②`（图层组的数据结构）+ `S2-9`（格式版本）。**风险与代价**：中-高（格式改动 = 回归面大）。**先问用户**（§10 Q6）。

### S3-5 PWA service worker（或只改文案） 🅿️ P3

- **目标**：要么把离线能力补齐，要么把文案改成诚实的。
- **为什么现在**：[`README.md`](../README.md):6 与 `:158` 互相打脸（一处说「可离线安装」，一处说「无 service worker」）；`src/` 里 `serviceWorker` **0 命中**。
- **落点**：`app2/www/`（SW 脚本 + 注册）、`web/pages.yml`（版本更新策略）、[`README.md`](../README.md)。
- **验收口径**：① 装为 PWA 后**断网能打开**（人工 + 至少一条 e2e 断言）；② 版本更新策略明确（新版本不静默卡住老缓存）。
- **优先级**：**P3**。**依赖**：§10 Q2（**只改文案的成本是一个提交**，做 SW 是新能力线）。
- **风险与代价**：中。SW 的缓存失效策略与「Pages 单分支部署」耦合，做不好会让用户**长期拿到旧包**——这与 `S0-3` 要治的「静默落后」是同一类失败。

### S3-6 可访问性与首屏预算 ⬜ P3

- **目标**：把两个完全没覆盖的维度起个头（不追求一次做完）。
- **为什么现在**：① 全篇盘点**没有任何无障碍项**（仅图标按钮的可读名、对比度、焦点顺序都没有清单）；
  ② 包体与首屏**没有度量**（`app2/www/js/app.js` = 1,334,285 B，`ARCHITECTURE.md`:544 有 core-only 的目标但那只是模块化副产品）。
- **落点**：`src/ui/kit/*`（控件的 `aria-*`）、`src/ui/feature-icons.ts` 的入口、`app2/www/index.html`。
- **验收口径**：① 建立清单并从「所有仅图标按钮有可读名（`aria-label` 或文本）」起步，逐项打勾；
  ② 在 `S1-7` 的 CI 里加一条**首屏体积记录**（先只记录不拦截，观察一段时间再决定是否设阈值）。
- **优先级**：**P3**。**依赖**：`S1-7`（体积记录） 。**风险与代价**：低。

---

## 7. 与既有计划的去重与对齐

### 7.1 映射表（本蓝图 → 既有计划）

| 本蓝图 | 既有计划条目 | 关系 |
|---|---|---|
| `S0-1 / S0-2 / S0-3 / S1-7` | **新增**（三份既有计划都没有 CI / 门禁 / e2e 入库 / 性能门禁 / lockfile） | 补空白；[`ARCHITECTURE.md`](ARCHITECTURE.md):581 决策 4 只提到「依赖方向检查」，本蓝图扩成门禁 |
| `S0-4` + §8 | **新增**（三份计划都没有「文档口径校正」这一项） | 前置：不校正则对齐基准是错的 |
| `S0-5` | 与 [`COMPARISON.md`](COMPARISON.md) §三.1 的基线表**同一件事** | 把它从「散文表」升级成「协议」 |
| `S0-6 / S0-10 / S1-1~S1-6 / S2-4` | 与 [`COMPARISON.md`](COMPARISON.md) §五 的既有优先级（性能 / 桌面体验 / 生态 / 数据安全）**部分重叠** | **合并**成「文件与数据生命周期」（`S1-1` + `S0-8`）与「工作流缺口」（`S1-3` + `S2-4`） |
| `S0-7 / S1-11 / S1-12 / S2-6 / S2-10` | [`PLAN-ai.md`](PLAN-ai.md) 的 C0–C5 / P8 / P1 / P17 / P18 **之后的续期**（那些都 ✅ 完成，本蓝图**不重复**） | 续期；编号沿用它的 P 序列（建议 P19/P20/…），**不另起一套** |
| `S0-9` | [`ARCHITECTURE.md`](ARCHITECTURE.md):597「修 `engine/history.ts` 的类型反向依赖 ⬜」 | **就是它**，不新增 |
| `S1-8` | [`ARCHITECTURE.md`](ARCHITECTURE.md):464 M0 + `:581` 决策 4 | 合并（M0 同批交付依赖方向检查） |
| `S1-9 / S2-1` | [`ARCHITECTURE.md`](ARCHITECTURE.md) §5.2 的 P0–P5 | **就是它**，本蓝图只补「可验收数字」与「P5 口径重钉」 |
| `S2-2` | [`ARCHITECTURE.md`](ARCHITECTURE.md) §5.2 的 P7 + §3.6 信号总线 + §8 决策 3 | **就是它**，本蓝图补「最小版 = 5–6 频道」 |
| `S2-3 / S3-1 / S3-2` | [`ARCHITECTURE.md`](ARCHITECTURE.md):465-468 的 M1–M4 + §4.7 预设 | **就是它** |
| `S2-8 / S3-3` | [`PLAN-isobuilder.md`](PLAN-isobuilder.md) §6 的 v2 / v3 + §10「下一步」 | **就是它** |
| `S3-4` | [`COMPARISON.md`](COMPARISON.md):136 点名的生态卡点 + `aseprite-io` 模块 | 合并 |
| `S3-5` | [`README.md`](../README.md):6,158 的离线口径 | 二选一（改文案 or 做能力） |
| **`PLAN-ai.md` §7 的 8 条待决策** | ① 离线承诺（`INTERNET`）→ **已被现状取代**（已加 `INTERNET`）；② key 策略 → **已解决**（手填 + env 两条都落地）；③ AI 默认行为 → **已解决**（预览后应用已落地）；④ C 路线是否现在做 → **已被现状取代**（C 全线完成）；⑤ 生成轴（文生像素图）→ **仍待拍板**（§10 Q14）；⑥①手填 key 搬出页面 → **仍待拍板**（§10 Q13）；⑥②流式 → **已被现状取代**（流式两条腿已落地，见 §8 D1/D2）；⑦ Android 同源代理 → **仍待拍板 + 待设备**（§10 Q10、`S2-7`）；⑧ 两条诚实边界 → **部分被取代**，剩余登记在 §8 | 逐条对齐，**不留「计划里悬着的待决策」** |

### 7.2 真冲突（只有这两条，其余都不是冲突）

| # | 冲突 | 两边怎么说 | 取舍 |
|---|---|---|---|
| **R1** | **`ai` 到底是「未实现」还是「已落地」** | [`ARCHITECTURE.md`](ARCHITECTURE.md):345/`:468`/`:506`/`:607-612` 把 `ai` 记为未实现、M4 未开始 **vs** [`PLAN-ai.md`](PLAN-ai.md) 的 C0–P18 全 ✅ | **拆成两条线**：「AI 能力线」（已落地，续期见 §7.1）与「`ai` 模块化」（未开始，`S3-1`）。[`ARCHITECTURE.md`](ARCHITECTURE.md) 的 `ai` 行改为「**能力已落地、模块边界未做**」。**同一个「P8」在两边指两件事 ⇒ 交叉引用必须写清** |
| **R2** | **模块化与产品项撞同一批文件** | [`ARCHITECTURE.md`](ARCHITECTURE.md):465 的 M1 搬 `iso` / `color-analysis`+`shading`、`:467` 的 M3 搬 `guide` / `changelog` / `spritesheet` **vs** `S1-2`（改 `guide.ts`）、`S1-3`（改精灵表导入）、`S2-8`（改 `iso`） | **先做产品项、后搬模块**（产品项改动小、用户可见；搬模块是结构活，晚做不会更贵）。若必须并行：**同一个文件在同一个提交周期内只允许一方改** |
| **R3** | **量化目标与现实差一个量级** | [`ARCHITECTURE.md`](ARCHITECTURE.md):538 写 `view.ts` ≤1,200 行（现 **3,693**）、`:539` `session.ts` ≤600 行（现 **4,700**） | **重钉目标**：`view.ts` 改为「≤2,500 行 + 覆盖层独立」、`session.ts` 先定「门面 ≤1,500 行」；**要用户拍板**（§10 Q8）。**不重钉则做完也说不清做没做完** |

> 除 R1/R2/R3 外，其余「看起来像冲突」的都只是**文档没同步**（性质是纠偏、成本是一个提交），已全部归入 §8，**不要把它们写成「等用户拍板」**。

---

## 8. 文档口径漂移校正清单（`S0-4` 的执行表）

> **为什么单列**：不校正就会规划出重复工作（最典型：把已落地的流式当未来做、把已缓存的笔尖当待优化）。
> 「核验状态」列 = 本轮（t7）是否亲手在仓库里复核过。**只改「已核」的行**；「未核」的行先别动，等复核。
> 「位置」列写给的是**节号 + 复核那一刻的行号**（行号会随后续编辑漂移，节号不会）——
> 定位时以节号为准，行号只当「大概在哪一带」的提示。

| # | 漂移 | 位置 | 应为准 | 核验状态 | 归属 |
|---|---|---|---|---|---|
| D1 | 代理对 `stream:true` 直接回 `400` | [`PLAN-ai.md`](PLAN-ai.md):328、`:1000`、`:1071` | 流式**两条腿都已落地**（壳侧 SSE 转发 + 页面侧逐块解析） | **已核** | `S0-4` **P0** |
| D2 | `ai.chatStream` 默认 `false` /「固定 false」 | [`PLAN-ai.md`](PLAN-ai.md):662 | **已核**：`src/app/settings.ts:641` `default: true` | **已核** | `S0-4` **P0** |
| D3 | `CHAT_SETTINGS` **14 条** +「`SETTINGS` 里 5 条 AI 高级项」 | [`API.md`](API.md) §26 头表（复核时 L3802） | **已核**：`CHAT_SETTINGS` **16** 条；`SETTINGS` 里 `group==="ai"` **4** 条，没有「5 条高级项」 | **已核 → `API.md` 已修**（t5） | `S0-4` P1 |
| D4 | `normalizeAiChatSettings()` 有 **14 个字段** | [`API.md`](API.md) §26.2 口径 4（复核时 L3883） | **已核**：16（漏 `thinking` / `timeoutSec`） | **已核 → `API.md` 已修**（t5） | `S0-4` P1 |
| D5 | `CHAT_SETTINGS` 扩到 **14 条** | [`AGENTS.md`](../AGENTS.md):593 | **已核**：16 条（**该文件由项目负责人更新**，本条只登记） | **已核** | `S0-4` P1 |
| D6 | as-built 是 **12 条**可见路径 | [`PLAN-ai.md`](PLAN-ai.md):705 | **已核**：实测 **16** 条（`CHAT_SETTINGS` 的 path 清单） | **已核** | `S0-4` P1 |
| D7 | §10 进度表缺 4 个已落地批次；**B1/B2 标签全仓无定义** | [`PLAN-ai.md`](PLAN-ai.md) §10 | **已核**：4 个提交都存在（`e47a28c`/`ac65969`/`3157485`/`be99ff8`）。**`B1`/`B2` 标签的分布已复核（原结论「全仓只在 `API.md` 4 处」不成立）**：`B1` = `docs/API.md` **2** 处（§22.6 与 §26.4）+ `src/ui/i18n.ts` 2 + `src/ui/AiPanel.tsx` 2 + `tests/ai-chat.test.ts` 2 + `src/ui/style.css` 1；**`B2` 主要在实现侧**——`src/app/ai-turn.ts` **9** 处（段落标签，见 `:68/145/195/299/433/565`…）+ `tests/ai-chat.test.ts` 5 + `src/ui/AiPanel.tsx` 3 + `docs/API.md` 2 + `src/app/ai-chat.ts` / `src/app/session.ts` 各 1 ⇒ **`B1` 是「只在文档里出现的批次标签」，`B2` 已是代码里的段落标签**。缺的仍然是 `PLAN-ai.md` §10 进度表那 4 个批次（`B1`/`B2` 的**定义**只在本文件 §8 与 `docs/API.md` 里） | **已核** | `S0-4` P1 |
| D8 | `ai`（未实现）/「AI 已完成」并存 | [`ARCHITECTURE.md`](ARCHITECTURE.md):345、`:468`、`:506`、`:607-612` | 见 §7.2 R1 | **已核** | `S0-4` P1 |
| D9 | 助手设置漏「思考强度」「模型响应超时」 | [`README.md`](../README.md):42 | 两条设置确实存在（`settings.ts` 的 `ai.chatThinking` / `ai.chatTimeoutSec` 在 `CHAT_SETTINGS` 的 16 条 path 里） | **已核** | `S0-4` P2 |
| D10 | `serialize` / `parse` / **`parseProject`** 当现行接口 | [`API.md`](API.md) §16.5（复核时 L2142） | **已核**：§18.5（复核时 L2468）说已删除；代码是 `serializeSpace`（`src/io/project.ts:223`）/ `parseSpace`（`:246`）；`parseProject` 在 `src/` **0 命中** | **已核 → `API.md` 已修**（t5，§16.5 换成 `serializeSpace` / `parseSpace`） | `S0-4` P1 |
| D11 | §15.4 把五个成员列为公开面 | [`API.md`](API.md) §15.4（复核时 L1504 一带；`cyclePivot` L1518、`xfHint` L1523） | **已核**：`xfScreenFrame`/`xfGrabs`/`xfPivotScreen`/`grabIconAt`/`warpHandles` 现在都是 **private**（`src/render/view.ts:2148/2183/2199/2249/2579`）；`cyclePivot(step = 1): void`（文档）vs 实际 `cyclePivot(): PivotPreset \| null`（`view.ts:2881`） | **已核 → `API.md` 已修**（t5，5 个 private 分档 + `cyclePivot()`） | `S0-4` P1 |
| D12 | §12 设置注册表 | [`API.md`](API.md) §12（复核时 L1305） | **已核**：`SettingKind` 多了 `"color"`、另有 `SettingText = "plain" \| "password"`（`settings.ts:24/26`）；分组实际 **11** 组（`SETTINGS` 10 组 + `CHAT_SETTINGS` 的 `chat`） | **已核 → `API.md` 已修**（t5，补 `"color"` / `SettingText` / 11 组） | `S0-4` P1 |
| D13 | §16.1 原生桥 **8 个**方法 | [`API.md`](API.md) §16.1（复核时 L1935） | **已核**：`MainActivity.java` 有 **12** 个 `@JavascriptInterface`（多 `aiServerStart/Stop/Status`、`aiRespond`） | **已核 → `API.md` 已修**（t5） | `S0-4` P1 |
| D14 | `ARCHITECTURE.md` 头部与 §5.5 数字 | [`ARCHITECTURE.md`](ARCHITECTURE.md):43 一带、`:538-544` | **已核（本轮复测）**：`src/` **111** 文件 / **44,205** 行（LF 口径；`ReadAllLines` 44,209）；扣 `ai-*` **9 文件 7,001 行** ⇒ 102 文件 37,204 行；`style.css` 1,454；`session.ts` 4,700、`view.ts` 3,693、`App.tsx` 2,997（`ReadAllLines` 2,998）、`modals.tsx` 2,410（四个合计 **31.2%**，文档写 44%）；测试 **60** 文件 / 21,076 行 / **8,090** 断言；设置 path **104**（88+16）；`MainActivity.java` **731** 行 / 12 桥；`GestureHost` **56**（文档 :604 写 54） | **已核** | `S0-4` P1 |
| D15 | §9 进度表 **P4 出现两次** | [`ARCHITECTURE.md`](ARCHITECTURE.md):599（🟡）/`:603`（⬜） | **已核** | **已核** | `S0-4` P1 |
| D16 | 引导步数 **54 / 41 / 46** 三种口径 | [`COMPARISON.md`](COMPARISON.md):13（41）/`:68`（46！**同一文件自相矛盾**）、`ARCHITECTURE.md`（54） | **已核**：`src/app/guide.ts` 的 `GUIDE` = **46** 条 ⇒ 一律写 46，并把口径写成「`GUIDE` 数组条目数」 | **已核** | `S0-4` P1 |
| D17 | `COMPARISON.md` §三严重过期 | `:104`（「`App.tsx` 中**零 keydown**」）、`:122-123`（「`view.ts` 1300+ 行 / `App.tsx` 900 行」） | **已核**：现 `view.ts` 3,693 / `App.tsx` 2,997；`App.tsx` 里 `keydown`/`onKeyDown` **8** 处，另有 `src/app/shortcuts.ts` + `keymap.ts` | **已核** | `S0-4` P2 |
| D18 | §三.1 的性能结论 | [`COMPARISON.md`](COMPARISON.md):86/`:91-92`、[`AGENTS.md`](../AGENTS.md):340/`:553` | **已核**：笔尖**已缓存**（`src/engine/paint.ts:364`）；待做的是 `mirrorCells` / `wrapPts` / `stampCells` 的逐格分配（见 `S1-10`）。**别改回去** | **已核** | `S0-4` **P0** |
| D19 | 「`Ctrl+Shift+S` 另存为仍缺」 | [`PC.md`](PC.md):61 | **已核**：真正的缺口是**没有文件身份**（每次保存都是另存为）⇒ 见 `S1-1` | **已核** | `S0-4` P2 |
| D20 | README 离线口径自相矛盾 | [`README.md`](../README.md):6 vs `:158` | **已核**：`src/` 里 `serviceWorker` 0 命中 | **已核** | `S0-4` P1 |
| D21 | `BUILD_TAG` 手工维护、落后、测试永不红 | `src/ui/changelog.tsx:15`（`"72ff2b0"`）、`tests/changelog.test.ts:32` | **已核**：`git rev-list --count 72ff2b0..HEAD` = **25**；测试只校验 `[0-9a-f]{7,}` 格式 | **已核** | `S0-3` |
| D22 | 引导里教的「三击 = 2× 放大」默认够不到 | `src/app/guide.ts` 的三击步骤；`tests/gesture.test.ts` 的 `gesture.triple.shadowed.*` | 现状被测试钉住 | **已核**（测试存在） | §10 Q12 |
| D23 | `ARCHITECTURE.md:132` 的行号已过期 | 该行写 `session.ts:1273 quickFill()`、且写「`view_` 在 Session 中被调 **10** 处」 | **已核**：`quickFill()` 现在在 `src/app/session.ts:1301`；`view_` 调用 **56**（口径见 §0.5） | **已核** | `S0-4` P1 |
| D24 | 助手状态行说明是中文常量而非 i18n 键 | [`AGENTS.md`](../AGENTS.md) §7；`src/ui/AiPanel.tsx` 的 `AI_CHAT_KEY_HELP_*` | 英文界面下仍显示中文 | **未核**（只从文档转述） | §11 + `S1-2` |
| D25 | 文档里的「43 条端到端断言全绿」 | [`PLAN-ai.md`](PLAN-ai.md):759 | **已核（脚本层面，口径已纠正）**：`toolchain/stress-stroke.mjs` **就是**一个 CDP + 无头浏览器脚本（`--headless=new --remote-debugging-port`），所以「`toolchain/` 里没有任何 CDP / 无头脚本」**不成立**；正确口径是**端到端断言脚本不在仓库里、不可复现**，且「43 条」的出处是 `PLAN-ai.md:759`（不是 `:1105`）。**「43 条」这个数字本身仍未核**（记为待验证） | 部分 | `S0-4` + `S1-7` |

---

## 9. 明确不做（附理由，**不要在后续期里当新任务重提**）

| 不做的事 | 理由 | 出处 |
|---|---|---|
| **笔迹 overlay 层** | 实测合成不是瓶颈（所有 run ≤0.7ms，一帧预算 16.7ms），做覆盖层省不到 5%，却要为「上方有可见图层 / 擦除 / 洋葱皮 / 自动平移」加四条退回分支 | [`AGENTS.md`](../AGENTS.md) §7、[`COMPARISON.md`](COMPARISON.md) §三.1、本轮复核成立 |
| **多窗口 / 浏览器原生右键菜单 / `Tab` 继续给专注模式** | 已有决策 | [`PC.md`](PC.md):99-106 |
| **`History` 层批量抑制开关 / 回合看门狗** | 会改 `History` 语义并牵动 90+ 提交的回归面 | [`AGENTS.md`](../AGENTS.md) §7 |
| **本机假 provider 的受信证书口子** | 只为验一个组合（env key + 上游回显）而给本机假 provider 配受信证书，代价不成比例 | [`AGENTS.md`](../AGENTS.md) §7 |
| **在 Android 里实现完整 MCP 传输层** | 宿主在电脑侧；MCP 是桌面生态的协议 | [`PLAN-ai.md`](PLAN-ai.md) §1.2 |
| **云端账号 / 协作 / 云存储** | 与「本机、离线、单文件」的产品形态冲突 | [`PLAN-ai.md`](PLAN-ai.md) §1.2 |
| **像素级视觉回环（把画布逐像素喂给模型）** | 与 `S1-11` 的 `render_preview` 是两件事：前者是 token 灾难，后者是必要的近似。**不要把两者混为一谈** | [`PLAN-ai.md`](PLAN-ai.md) §1.2 |
| **`apply_ops` 批量入口** | 「不新增写入路径」是工具面的硬口径；批量入口等于第二条写入路径 | [`PLAN-ai.md`](PLAN-ai.md) §8 |
| **`search_tools`** | 61 条仍在上下文预算内；**但加 `render_preview` 带图后要重核**（`S1-11` 的验收④就是干这个） | [`PLAN-ai.md`](PLAN-ai.md) §8 |
| **`fx_*` / `transform` 换成稀疏差分** | 要改 `Session.maskOp()` / `History` 接口；代价只在 1024² 级别的大画布 | [`API.md`](API.md):2887 一带、[`AGENTS.md`](../AGENTS.md) §7 |
| **`/provider/*` 的 `Host` 校验与去掉 `?token=`** | 两处都是「不可利用的加固」（只绑 `127.0.0.1` + 通道 token 已挡住实际利用） | [`PLAN-ai.md`](PLAN-ai.md) §7.8 |
| **RID / 句柄 / 命令队列** | 除非真要换渲染后端或上多线程，那是过度设计 | [`ARCHITECTURE.md`](ARCHITECTURE.md):553 |
| **GDExtension 式运行期动态加载** | APK/PWA 离线、无插件市场，动态加载只带来异步与失败路径 | [`ARCHITECTURE.md`](ARCHITECTURE.md):393 |
| **运行期模块开关** | 与编译期能力位形成两套机制，容易混乱（只做编译期裁剪） | [`ARCHITECTURE.md`](ARCHITECTURE.md):585 |
| **Android Java 桥按模块裁剪** | dex 与 Web 资源两套裁剪逻辑会打架 | [`ARCHITECTURE.md`](ARCHITECTURE.md):587-588 |
| **Web Worker / OffscreenCanvas（导出 / 大图重采样）** | 单文件 IIFE + `file://` 离线形态下复杂度远高于收益；导出已有 `yieldToUI` | [`ARCHITECTURE.md`](ARCHITECTURE.md):593、本轮 `new Worker(` / `OffscreenCanvas` **0 命中** |
| **e2e 脚本「换产物再换回」的做法** | 中途失败会**把探针包留在工作区**；入库时必须只读产物（`S1-7`） | 本轮复核：一次性脚本自述此行为 |
| **为了省体积做模块化** | [`ARCHITECTURE.md`](ARCHITECTURE.md):452-454 自己写「不要为了省 50 KB 做这件事」 | 同上 |
| **tilemap 层** | 最大、最偏生态、触屏收益低；若要做请**单独立项**并先问用户 | [`COMPARISON.md`](COMPARISON.md):66 记为「无」、§10 Q6 |
| **把 `AI_CONFIRM_DENY` 改成放行** | 它是单行致命改动点：改成 `() => true` 就是一次 `canvas_clear` 毁作品 | `src/app/ai-rpc.ts:86` |
| **把坏 RLE 载荷改成「拒绝打开」** | 会让今天能打开的存量 `.pxc` / 自动保存版本打不开（用户可见行为变更）⇒ 见 `S0-8` ④ 的正确做法是「照样打开 + 明确提示」 | 本轮复核 `src/io/project.ts:92` |

> **Android 侧同源代理**不在本表：它在 [`PLAN-ai.md`](PLAN-ai.md) §7.7 记为「本轮明确不做」，本蓝图把它保留为**有设备才开工**的候选（`S2-7`）——口径不冲突：**没有设备就不做**。

---

## 10. 必须先问用户（**未答之前，相关条目只做「不改语义的准备」，不动实现**）

| # | 问题 | 为什么必须问 | 选项 | 影响条目 |
|---|---|---|---|---|
| **Q1** | **cel 字节的「存储语义」要不要统一？** | `src/engine/color.ts:40` 的 `blendOver()` 把 RGB 按 alpha **缩过再存**，而 `resample` / `blurCel` / `compositor.celToCanvas` 把**同一批字节当直通 RGBA** 处理——同一块 cel 读法不同、结果不同。**统一它一定会改存量半透明像素的画面观感** | ① 统一到直通（像素正确、观感变）；② 统一到预乘（观感不变、语义继续混）；③ 不动 | 影响 `paletteFromCanvas`（`src/app/session.ts:1888`，直接遍历原始字节，与 `readRegion` 口径可能对不上，见 [`API.md`](API.md):3292）；影响读取口径与 `resample` 系列 |
| **Q2** | **PWA 要不要 service worker？** | [`README.md`](../README.md):6 与 `:158` 互相打脸；`src/` 里 `serviceWorker` 0 命中 | ① 只改文案（成本一个提交）；② 真做 SW（新能力线，`S3-5`） | `S1-4` 的范围；`S3-5` 立不立项 |
| **Q3** | **数据安全的三类「改用户可见行为」做不做？** | ①「清除自动保存」今天**无确认**（`src/ui/modals.tsx:1183` 一个 `danger` 按钮一次点击删掉最新一版**和全部 16 个槽位**，而同面板的恢复 / 删除都问：`:1056`/`:1063`）；② 崩溃判定是**全局单标记、无会话令牌**（同域两标签会漏报）；③ **无关闭前拦截** | ① 只给删除加确认；② 加确认 + 会话令牌 + 关闭拦截；③ 都不动 | `S0-8` 的边界；相关小条目是否立项 |
| **Q4** | **`ai` 要不要进可裁剪模块（M4）？** | 会牵动 `App.tsx`(2,997) / `modals.tsx`(2,410) 的注册表；而 AI 运行时接线只有 3 处 | ① 进（`S3-1`）；② 不进（AI 永远编进包，只做能力线） | `S3-1` / `S3-2`；[`ARCHITECTURE.md`](ARCHITECTURE.md):345 那行怎么写 |
| **Q5** | **协议层 destructive 确认器要做到什么程度？** | MCP 协议本身**没有确认原语**；`AiServer.java:103` 的 **10s 超时**决定确认窗口，放宽它要付「挂起一直占 worker」的代价 | ① 进程内一次性 `--allow-destructive`（最小可行）；② 每次调用都问（会撞 10s）；③ 只在最高档放行（危险）；④ 不做 | `S1-11` 的全部 |
| **Q6** | **图层组 / tilemap 要不要做？** | 数据结构 + `.pxc` / `.aseprite` 双向格式改动，回归面大；触屏上组嵌套的操作成本不低 | ① 只做「降到 N 色」+「时间轴缩略图」；② 加图层组；③ 再加 tilemap | `S2-4` / `S3-4` |
| **Q7** | **模块预设维护几个？** | 2 个（`full` + `pixel-core`）与 4 个（+ `lite` + `studio`）的维护成本差一倍 | ① 2 个；② 4 个 | `S3-2`；[`ARCHITECTURE.md`](ARCHITECTURE.md):586 决策 7 |
| **Q8** | **`view.ts` / `session.ts` 的量化目标要不要重钉？** | 文档写 `view.ts` ≤1,200 行、`session.ts` ≤600 行，而**本轮实测** 3,693 / 4,700；不重钉则做完也说不清做没做完 | ① 沿用原目标（激进）；② 改成 `view.ts` ≤2,500 行 + 覆盖层独立、`session.ts` 门面 ≤1,500 行；③ 只用「单调下降 + 减耦」不设绝对目标 | `S1-9` / `S2-1` 的验收；[`ARCHITECTURE.md`](ARCHITECTURE.md):538-539 |
| **Q9** | **「保存」语义变更到什么程度？** | 「有 URI 就写回、`Ctrl+Shift+S` 才弹框」会改用户可见行为（有人习惯每次选目录） | ① 写回 + 另存为（`S1-1` 建议）；② 保持每次另存为，只加「最近工程」；③ 两端不同策略 | `S1-1` 的全部 |
| **Q10** | **有没有真实设备 / 模拟器可用？** | 本机**没有 Android 设备 / 模拟器** ⇒ APK 上助手能否连上真 provider **未知**；`INTERNET` 已有但 WebView 跨源 `fetch` 是否被拦**未验证** | ① 有设备（`S2-7` 可开工）；② 无设备（`S2-7` 挂起，真机验证线整体挂起，见 §12） | `S2-7`；`S1-1`①；`S1-11` 的真机验收 |
| **Q11** | **现在出不出包 / 动不动版本号？** | `AGENTS.md` §5.1：`1.0.x` 第三段由用户决定、`versionCode` 每次出包 +1；产物只在 `main`。而 `S0-3` 的「三端产物对齐」需要**出一次包**才能消掉 APK 那份 1.0.9.9 | ① 现在出一次包（对齐 APK）；② 只对齐 Pages，APK 等下次出包 | `S0-3` 的后半段 |
| **Q12** | **画布内三击手势怎么办？** | 三击（2× 放大）在默认设置下**够不到**：单指第二下落在画布上就被「双击画布」或「聚焦适配」吃掉并清零，且现状被 `tests/gesture.test.ts` 的 `gesture.triple.shadowed.*` **钉住**。**而引导里还教了这一步** | ① 改判定顺序（三击可达，双击行为受影响）；② 承认只在边距外有效（改引导文案 + 文档口径）；③ 去掉这个手势 | `S1-2`（引导里那一步怎么写）；[`API.md`](API.md) 的手势口径 |
| **Q13** | **手填的 `ai.chatKey` 要不要也搬出页面？** | 它今天存在本机页面的 `localStorage` 里，同源脚本读得到；要堵上就得挪进壳的存储、页面只拿哨兵——**会牺牲「换浏览器还在」的便利**。[`PLAN-ai.md`](PLAN-ai.md):997 的原话是「**等用户拍板要不要做**」 | ① 搬（三者都搬）；② 不搬；③ 只搬环境变量那条路（那条**已经**不进页面） | 安全口径与设置文案；**不要把它当成「明确不做」** |
| **Q14** | **生成轴（文生像素图）要不要一起规划？** | [`PLAN-ai.md`](PLAN-ai.md):996 记为待决策：它需要选定模型与计费方式，与操作轴（工具面）是两套东西 | ① 规划；② 本轮不做（记进 §9） | 是否新增 AI 能力线条目 |

---

## 11. 待验证清单（**不许以「已核」的口吻引用**）

| 项 | 为什么没核 | 怎么核 |
|---|---|---|
| 大画布 `1024²` 的 ctor ~1.04ms / `commit()` ~3.07ms | 只有 t1 的 Node（V8、无 DOM）实测，本轮未复跑，浏览器端未测 | 按 `S0-5` 的 rig A 复跑 `toolchain/stress-stroke.mjs`（加 1024² rig） |
| 「APNG / 动画 WebP 只取首帧」 | 静态推断（解码走 `<img>`，GIF 有专门分支） | 实测一张 APNG / 动画 WebP |
| 「43 条端到端断言」（[`PLAN-ai.md`](PLAN-ai.md):1105） | 脚本不在仓库，无法复现；数字本身未核 | 若仍需要，先把 e2e 收入仓库（`S1-7`），再补测 |
| PWA 上 `navigator.vibrate` 是否真的可用 | 静态推断（有回落分支） | 安卓 Chrome 实测 |
| `pc-shell.mjs` 两个监听点是否都走同一套 token 鉴权 | 只核到「有两个监听点」（`:1726` + `:973/976/984`） | 实现者动它前自测一遍 |
| `docs/API.md` §6–§20 的「434 个标识符只有 `parseProject` 缺失」 | 本轮只核了 `parseProject` **0 命中**，没复跑全量标识符扫描 | 复跑 t1 的扫描脚本，或逐节抽检 |
| D24（助手状态行三条中文常量） | 只从 `AGENTS.md` §7 转述，未读 `src/ui/AiPanel.tsx` | 读该文件的 `AI_CHAT_KEY_HELP_*` |
| `VIEW_` / 其它未列入 §8 的文档漂移 | 本清单只覆盖四路盘点点名的条目，**没做 docs 全量机械对照** | 按 `S0-4` 的口径补一轮「`docs/*.md` 数字 vs 实测」 |

---

## 12. 真机验证计划（APK 是主端，但今天没有设备）

真机是本蓝图里**唯一的物理前置**：`S1-1`①（SAF 写回）、`S2-7`（Android 同源代理）、`S1-11`④（vision 真机链路）与
出包后的 `S0-3`④ 都挂在它上面，而现状是**本机没有 Android 设备 / 模拟器**。

| 条目 | 验收环境 | 拿不到设备时怎么办 |
|---|---|---|
| `S0-3`④（APK 内 app.js 与本地构建一致） | 容器内出包 + `verify-apk.py` | **不需要真机**（纯解包校验）⇒ 只要用户同意出包（Q11）就能做 |
| `S1-1`①（保存写回同一个文件） | **真机 APK** | 桌面壳 / 网页那一半先做（②③④），APK 那一半挂起 |
| `S1-11`④（`render_preview` 的请求体与体积闸门） | 电脑壳（可做）+ 真机（可缓） | 先用电脑壳量请求体，真机部分挂起 |
| `S2-7`（Android 同源代理） | **真机 / 模拟器** | **整个条目挂起**（PLAN-ai §7.7 也记为「本轮不做」） |
| MCP 路线的 destructive 确认（`S1-11`①） | 电脑侧（不需要真机） | 与真机无关，可先做 |

**设备从哪来**：Android 模拟器（需 SDK / 镜像，本机没有）或借一台真机。**Q10 未答之前，上表「挂起」列就是默认状态**。

---

## 附：本文档所用数字的复现命令

```powershell
# 仓库状态与 HEAD
git status --short; git rev-parse --short HEAD

# 回归套件（期望末行 ALL PASS、exit 0）
node tests/.ts-out/tests/run-tests.js

# 类型检查
node_modules/.bin/tsc.cmd -p tsconfig.json --noEmit

# 规模（LF 口径 vs ReadAllLines 口径）——用 Node 或 .NET，别用 Get-Content 数行
node -e "const fs=require('fs'),p=require('path');const w=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?w(p.join(d,e.name)):(/\.(ts|tsx)$/.test(e.name)?[p.join(d,e.name)]:[]));const f=w('src');let lf=0,ral=0;for(const x of f){const s=fs.readFileSync(x,'utf8');lf+=s.split('\n').length-1;const a=s.split(/\r?\n/);if(a[a.length-1]==='')a.pop();ral+=a.length}console.log('files',f.length,'LF',lf,'ReadAllLines',ral)"

# 工具面 / 设置表
node -e "const t=require('./tests/.ts-out/src/app/ai-tools.js');const all=t.listTools({tiers:['read','draw','destructive','ui']});let p=0,m=0;for(const x of all)for(const k of Object.keys(x.params||{})){p++;if(!x.params[k].desc)m++;}console.log(all.length,p,m,t.listTools().length)"
node -e "const s=require('./tests/.ts-out/src/app/settings.js');console.log(s.CHAT_SETTINGS.length,s.SETTINGS.length,s.SETTINGS.filter(x=>x.group==='ai').length)"

# 耦合计数（口径见 §0.5）
(Select-String -Path src/app/session.ts -Pattern 'view_' -AllMatches | ForEach-Object { $_.Matches.Count } | Measure-Object -Sum).Sum   # 出现 57，减声明 1 = 调用 56
(Select-String -Path src/app/session.ts -Pattern 'changed\(\)' -AllMatches | ForEach-Object { $_.Matches.Count } | Measure-Object -Sum).Sum

# 三端产物
(Get-Item app2/www/js/app.js).Length; (Get-FileHash app2/www/js/app.js -Algorithm MD5).Hash.ToLower()
git rev-list --count 5182c7b..HEAD
git rev-list --count 72ff2b0..HEAD

# 行尾与门禁事实
git ls-files --eol scripts/
Select-String -Path scripts/run-tests.sh -Pattern 'tsc'
Test-Path .github; Test-Path .gitattributes; Test-Path scripts/modules.mjs; Test-Path .git/hooks; Test-Path package-lock.json
```

> ⚠️ **两个工具坑**（会让人数错、读错）：① Windows 工作区上 `Get-Content` 数行/按行取值**不可靠**
> （同一文件曾给出 329 行，`ReadAllLines` 给 589 行）——数行、取第 n 行一律用 `[System.IO.File]::ReadAllLines()` 或 `Select-String`；
> ② 用 PowerShell 的 `>` 重定向写**二进制/大文件**会改变编码与行尾（`git show origin/main:js/app.js > x` 的 md5 对不上），
> 要比 md5 请用 `cmd /c "git cat-file blob … > x"`。
