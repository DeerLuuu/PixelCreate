# 电脑模式（PC）适配清单与后续建议

> 对应 1.0.8.5 / 1.0.8.6 两批 PC 适配。表里 `✅` 是**已经做完**的，`⬜` 是**建议但还没做**的，
> 每条都标了实现位置，方便下一次接着做。用户端的说明在 [`README.md`](../README.md) §5。

## 一、已经做完的（本轮 18 项 + 之前批次）

| 能力 | 实现位置 |
|---|---|
| ✅ PC 模式识别（鼠标 + 宽屏启发式，设置里可强制开关） | `src/io/pcmode.ts`、`src/app/settings.ts`（`display.pcMode`） |
| ✅ 滚轮缩放（以光标为中心）、`Shift` 横向 / `Alt` 纵向平移 | `src/render/wheel.ts`、`View.onWheel` |
| ✅ 中键点画布＝聚焦并适配该画布；空格+左键拖动＝平移 | `View.onDown` / `View.onSpaceKey` |
| ✅ 右键用另一个颜色槽（默认背景色）绘制，且拦掉浏览器右键菜单 | `View.onDown`（`altPaint`）、`App.tsx` 的 `contextmenu` 拦截 |
| ✅ `Alt`+单击快速取色（长按取色在 PC 下关闭） | `View.onDown`（`e.altKey`） |
| ✅ 空格**长按不动**＝交换前景/背景色（鼠标一动即取消，仍是平移） | `View.onSpaceKey` / `swapColorsByHold`（`SPACE_MOVE_PX = 6`） |
| ✅ 悬停提示 0ms 跟随光标、随工具变化的光标、像素坐标 + 色值读数 | `src/ui/kit/HoverTip.tsx`、`src/render/cursor.ts`、`View.syncCursor` |
| ✅ 全套快捷键：`Ctrl+Z/Shift+Z/S/C/V/X`、`Delete`、`Esc`、`+ - 0`、`Ctrl+←→` 切帧、`Ctrl+↑↓` 切图层、方向键微移、`Tab` 专注、字母键切工具 | `src/app/shortcuts.ts`、`App.tsx` 全局 keydown |
| ✅ 剪切（`Ctrl+X`）+ 跨画布剪切粘贴（画布 1 剪切 → 画布 2 粘贴） | `Session.clip`（整个空间共用一份）、`App.tsx` |
| ✅ 选区**直接拖到另一张画布**（PC 与触屏都能用，目标图层锁定时整个动作回滚） | `View.dropSelDragToCanvas`、`selOps.floatDropInto` |
| ✅ 窗口拖放文件打开（`.pxc`/PNG/GIF）+ `Ctrl+C/V` 走系统剪贴板 | `src/io/clipboard.ts`、`App.tsx` 的拖放 effect |
| ✅ 浮动球：桌面尺寸、全部展开不翻页、零重叠排布、每个球都有展开锁定、快速拖动不掉手 | `src/ui/orb-layout.ts`、`App.tsx` 的 `FloatingTools` |
| ✅ 长按拖动按钮与数字输入框支持**悬停滚轮调值** | `src/ui/hold.tsx`、`src/ui/kit/scrub.tsx` |
| ✅ 设置界面左右分栏（搜索在上、左类别右设置）、更新日志左版本竖列 | `src/ui/modals.tsx`、`src/ui/changelog.tsx` |
| ✅ 「预览所有帧」面板宽 60%、内容自动换行 | `src/ui/modals.tsx`（`.dlg-frame-preview`）、`style.css` |
| ✅ 桌面化尺寸与悬停态：按钮 40px、菜单/弹窗/表单行加宽、`html[data-pc]` 一条条覆盖 | `src/ui/style.css`、`docs/UI.md` |

## 一b、1.0.8.7 又补上的（原 §二 里的条目）

| 能力 | 实现位置 |
|---|---|
| ✅ 帧/图层鼠标**直接拖动排序**（不用等长按），触屏语义不变 | `src/ui/timeline.tsx`（`numDown` / `layDown` 的 `pcMouse` 分支） |
| ✅ **双击重命名**：图层名、画布标题（双击画布本身仍是聚焦并适配） | `timeline.tsx` 的 `lname.onDoubleClick`、`canvas.tsx` 标题的 `onDoubleClick` |
| ✅ **右键点帧＝帧设置**，并把 Del 目标切到帧 | `timeline.tsx` 帧头 `onContextMenu` |
| ✅ `Shift`+左键**区间选帧**（从上次选中的帧连选过来） | `Session.frameAnchor` / `pickFrameRange` |
| ✅ **Del 键全局删除**：选区内容 / 选中帧 / 当前图层 / 选中画布（画布仍弹确认） | `Session.delTarget` / `deleteKeyAction`，各区域 `setDelTarget` |
| ✅ **单画布也显示画布标题栏** | `src/ui/canvas.tsx` |
| ✅ **Ctrl+F1 快捷键一览**面板（键盘 + 鼠标两套词汇，逐行有测试保证不跑偏） | `SHORTCUT_SHEET`、`ShortcutHelpModal` |
| ✅ `Ctrl+Shift+V` 粘成新图层 / `Ctrl+Alt+V` 粘成新画布（手机端是选区球的两个子球） | `Session.pasteAsNewLayer` / `pasteAsNewCanvas`、`ui/paste.ts` |
| ✅ 帧多选时 `Ctrl+V` 一次粘到每一帧 | `Session.pasteIntoFrames` |
| ✅ **Ctrl+O / Ctrl+N / Ctrl+E** 打开、新建、导出 | `src/app/shortcuts.ts` |
| ✅ 文本框恢复**原生右键菜单**（画布上仍然拦截） | `App.tsx` 的 `onCtx` + `isEditable` |
| ✅ PC 模式**拦掉浏览器手势**：双指横滑前进后退、橡皮筋回弹、右键按下、Safari 捏合；可滚动区域照常滚 | `App.tsx` 的手势守卫 effect |
| ✅ 滚轮/拖动**调值不再跳变**（一格一档、拖动按范围换算） | `src/engine/scrub.ts` |
| ✅ 跨画布拖选区**实时预览**落点幽灵 + 目标画布虚线框 | `View.dropTargetOf` + `drawOverlay` |
| ✅ 色板小球与环形子球**同尺寸**；PC 球里隐藏复制/剪切/粘贴（有快捷键） | `orb-layout.ts`、`App.tsx` 的 `selItems` |
| ✅ PC 模式**多个浮动球同时展开**且不拦截画布操作（Esc 收球） | `App.tsx`（`!pcMode` 才渲染 `.radial-back`） |

## 二、还没做的（按优先级）

### P0 —— 桌面手感上的硬伤

1. ✅ ~~帧/图层拖动排序仍要长按 300ms~~（1.0.8.7 已改：鼠标按下即拖）：`src/ui/timeline.tsx` 的 `numDown` / `ltmRef` 用长按武装拖动，
   鼠标上很别扭。建议 `e.pointerType === "mouse"` 时**直接进入拖动**（越过计时器），长按语义只留给触屏。
2. ⬜ **右键上下文菜单只做了「帧设置」**：`App.tsx` 把所有 `contextmenu` 都拦掉了，桌面用户失去最顺手的入口。
   建议按目标给出不同菜单：画布标题栏（重命名 / 锁定位置 / 导出 / 关闭）、图层/帧（重命名 / 复制 / 删除 /
   锁定 / 不透明度）、选区（剪切 / 复制 / 变换 / 反选 / 描边）。
3. ⬜ **图层/帧重命名只能走弹窗**：加双击名称直接原地编辑（`dblclick` → inline input），
   与文件管理器一致。
4. ✅ ~~文件级快捷键缺失~~（1.0.8.7 已补 Ctrl+O / Ctrl+N / Ctrl+E；另存为仍缺）：只有 `Ctrl+S`。建议补 `Ctrl+O` 打开、`Ctrl+N` 新建、`Ctrl+Shift+S` 另存为、
   `Ctrl+E` 导出 PNG —— `ShortcutAction` 是联合类型，加 action + `App.tsx` 里接一条分支即可。
5. ✅ ~~快捷键没有可发现入口~~（1.0.8.7：Ctrl+F1 一览面板 + 主菜单入口）：目前只在更新日志里写过。建议 `?` / `F1` 打开「快捷键一览」面板，
   把 PC 独占操作（空格长按换色、悬停滚轮调值、中键聚焦适配、`Alt` 单击取色）也列进去。
6. ⬜ **粘贴的粒度**：`Ctrl+Shift+V` 粘贴为新图层 / 新画布（Aseprite 习惯），以及「粘贴到鼠标位置」。

### P1 —— 效率与一致性

7. ⬜ **选区变换手柄命中半径固定 20px**（旋转点 26px，`View.handleAt`），而旋转点在 `selFramePts` 里被
   `Math.max(14, y0 - 30)` 拉回顶部，小选区时会与上边中点手柄抢同一个点。建议半径随 zoom 调整，
   并给旋转点留屏幕固定的垂直偏移。
8. ⬜ **环形菜单展开时输入仍然打到画布**：滚轮会缩放、右键会画到下面的画布。建议弹出层置顶时吞掉画布输入。
9. ⬜ **悬停读数每跨一个像素就 `changedUI()`**（`Session.setHover`）：PC 上鼠标移动密集，整屏 React 重渲染
   会成为负担。建议节流到 1 帧，或直接用 ref 写 DOM。
10. ⬜ **拖放导入只按「整窗打开文件」处理**：既然已经有 `app/canvas-space.ts` 的命中测试，
    可以按落点把图片导入为**那张画布**的内容/新图层，落点高亮提示画布边框。
11. ✅ ~~多选的鼠标修饰键~~（1.0.8.7：Shift+左键区间选帧）：帧/图层多选目前要先进「多选模式」再点。建议 `Ctrl+点击` 加选、`Shift+点击` 连选。
12. ⬜ **窗口尺寸变化没有防抖**：拖窗口边缘 / 进出全屏会连打 `View.resize`（FUSE 路径上尤其明显）。
    建议 rAF 合并 + ~100ms 防抖后再重建合成。
13. ✅ ~~全局拦 contextmenu 连输入框也拦掉了~~（1.0.8.7：文本框放行原生菜单）：`App.tsx` 的 `onCtx` 没有放过 `INPUT`/`TEXTAREA`，
    文本框里的「复制/粘贴/拼写建议」原生菜单也没了（`isEditable` 判断在同一个文件里已经写好，直接复用）。
14. ⬜ **面板不能自由布局**：时间轴高度可拖（已有），但图层栏/调色板不能折叠或重排；桌面习惯是可停靠面板。

### P2 —— 体感增强

15. ⬜ **小地图 / 全部画布总览**：多画布空间变大后容易迷失。建议 `Shift+0` = 适配全部画布，
    右下角加一块可点的小地图。
16. ⬜ **缩放档位吸附**：靠近 100% / 200% / 400% 时轻微吸附，并给一个「1:1」快捷键（现在 `0` 是适配）。
17. ⬜ **中键行为可配置**：默认「聚焦并适配」，但很多人习惯中键平移；设置里加一个二选一。
18. ⬜ **状态栏信息**：已有缩放百分比、像素坐标与色值；再补选区尺寸（w×h）与当前帧时长。
19. ⬜ **无障碍**：焦点环、`aria-label`、Tab 键导航 —— `Tab` 现在被专注模式占用，
    建议在设置里提供「Tab 行为」开关（专注模式 / 键盘导航）。
20. ⬜ **窗口失焦时暂停动画**：洋葱皮蚂蚁线、播放模式、悬停高亮的 rAF 在后台仍在跑，建议
    `document.hidden` / `blur` 时停掉。

## 三、刻意不做 / 已知取舍

- **不做多窗口**：APK 是单 WebView，网页版也不做多显示器窗口管理。
- **不做浏览器原生右键菜单**：按用户要求全局拦截；代价是「图片另存为」等浏览器便利也没了
  （导出走应用内导出）。
- **`Tab` 继续给专注模式**（Aseprite 习惯），因此桌面键盘导航要另找键位（见 §二.19）。
- **触屏手势在 PC 模式下关闭**（双击适配、三击缩放、长按取色），由滚轮/中键/`Alt` 单击替代；
  但「按住拖动」类控件（`HoldAdjust`、调色球迷你轮）在 PC 下**保留**，因为鼠标没有别的连续调值方式。
