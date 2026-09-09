// Release notes (更新日志): data + modal. Auto-shown on first launch after an
// update (version marker in localStorage); also reachable from the main menu.
import { useEffect, useMemo, useState } from "react";
import { SESSION } from "./singleton";
import { makeT } from "./i18n";
import type { Lang } from "./i18n";
import { Icon } from "./base";
import { TabBar } from "./tabs";

/** keep in sync with android/AndroidManifest.xml versionName on every release */
export const APP_VERSION = "1.0.7.11";
/** build stamp shown next to the version (support/debug: identifies the exact
 *  package a user is running when the version number itself does not change) */
export const BUILD_TAG = "b0912d";

export type ClgKind = "add" | "imp" | "fix";
export interface ClgItem { kind: ClgKind; zh: string; en: string }
export interface ClgVersion { v: string; date: string; items: ClgItem[] }

const it = (kind: ClgKind, zh: string, en: string): ClgItem => ({ kind, zh, en });

export const CHANGELOG: ClgVersion[] = [
  {
    v: "1.0.7.11",
    date: "2026-09-09",
    items: [
      it("add", "预览窗口新增灰度预览：一键把画面转成灰度，方便检查明暗关系与对比度（只灰画面，底色保持不变）", "The preview box gained a greyscale mode: one tap turns the artwork greyscale to check values and contrast (only the artwork, the backdrop keeps its colour)"),
      it("imp", "预览窗口右上角那个按钮改成二级菜单：点一下展开「白底 / 黑底 / 格子底」+「灰度预览」四个选项（原来只能循环切换底色），当前底色与灰度状态都有高亮", "The top-right button of the preview box now opens a second-level menu with White / Black / Checker plus Greyscale preview (it used to only cycle the backdrop), highlighting both the active backdrop and the greyscale state"),
      it("imp", "设置 → 显示与取色 新增「灰度预览」开关，与预览底色并列，状态随设置持久化", "Settings -> Display & Colour gained a Greyscale preview switch next to the preview backdrop, persisted with the rest of the settings"),
      it("fix", "修复增量渲染的严重 bug：整幅画面变脏时（描边/灰度等特效、选区填充/剪切/粘贴/移动、反选）只重绘不重合成，画布停在旧画面而预览窗口却已更新——现在只要整幅变脏就必定重新合成；顺带让选区框/套索拖动只重绘叠加层，不再每帧整幅重合成", "Fixed a serious incremental-rendering bug: when the whole canvas became dirty (FX such as edge/greyscale, selection fill/cut/paste/move/invert) the view redrew without recompositing, so the canvas kept the old pixels while the preview box was already correct. A full dirty now always rebuilds the composite; selection/lasso drags also redraw only the overlay instead of recompositing every frame"),      it("add", "新增「轮廓填充」工具：像套索一样手绘一个闭合形状，松手后自动把内部填成当前色（比套索 + 填充快一步）；绘制过程中有虚线路径和半透明填充预览，支持对称镜像与选区裁剪，整笔只记一步历史", "New Outline fill tool: draw a closed freehand shape like a lasso and it fills itself with the current colour on release (one step instead of lasso + fill). While drawing you see the dashed path and a translucent fill preview; symmetry mirroring and selection clipping both apply, and the whole gesture is one history step"),      it("add", "新增双指长按手势：两指按住不动即触发，默认为「切换到下一图层」，可在设置 → 手势与触控里改成任意动作；切到的图层会在画布上闪一下（白色轮廓淡出 + 边框脉冲，空图层闪边框）", "New two-finger long-press gesture: hold two fingers still to fire it, defaulting to Next layer and re-mappable from Settings -> Gestures & Touch. The layer you switch to flashes on the canvas (white silhouette fading out plus a border pulse; an empty layer flashes its border)"),
      it("add", "新增「三指长按」手势（默认同样是切换图层）：部分机型（vivo/OPPO 等）把双指长按映射成系统「识屏」，三指长按不会冲突；双指长按的说明里也写明了系统设置路径，真被系统抢走时会一次性提示怎么处理", "New three-finger long-press gesture (defaults to Next layer as well): some phones (vivo/OPPO) map the two-finger long press to their system screen recognition, while three fingers do not clash. The two-finger entry now also names the system setting, and a one-off hint explains what to do if the OS grabs it"),      it("add", "手势动作新增「切换到下一图层 / 上一图层」：循环切换并优先跳过隐藏图层（设置 → 手势与触控里可绑定到任意手势）", "New gesture actions Next layer / Previous layer: they cycle through the stack, preferring visible layers, and can be bound to any gesture in Settings -> Gestures & Touch"),      it("add", "新增平铺画布（设置 → 画布与网格 → 平铺画布）：在中心画布四周显示 3×3 的副本，只有中心可编辑，画无缝瓦片/背景时能直接看到接缝；支持「平铺重复」与「镜像平铺」两种拼法，中心格有蓝色描边标识", "New tiled canvas (Settings -> Canvas & Grid -> Tiled canvas): a 3x3 set of copies around the centre canvas, only the centre is editable, so you can see the seams while painting seamless tiles/backgrounds. Two layouts: plain repeat and mirrored repeat, with a blue outline marking the editable tile"),
      it("imp", "画布不再是一个文件：画布球里的「保存 / 关闭并保存」已移除（换成「关闭画布」，只是把它从当前工程里移除），顶部工具栏恢复保存按钮——它保存的是整个工程（含所有画布、每张画布的位置/帧/图层选择与操作记录），工程仍然是自动保存的", "A canvas is no longer a file: the canvas orb's Save / Close & save are gone (replaced by Close canvas, which just removes it from the current project), and the toolbar has the Save button back — it writes the WHOLE project (every canvas, with each canvas' position, frames, layer selection and history), which keeps autosaving as well"),
      it("fix", "修复在引用画布上绘画没有实时预览的 bug（笔、图形、橡皮擦）：引用层不再在合成时去取源画布的画面，而是把源画布的画面**镜像进引用层自己的像素**（每帧共用一份，源画布变了才重新镜像）——这样它的渲染路径和普通图层完全一样，画的过程中就跟着手指走", "Fixed the missing live preview when painting on a reference layer (pencil, shapes, eraser): instead of resolving the source canvas while compositing, the reference layer now MIRRORS the source picture into its own pixels (one shared cel per layer, re-mirrored only when the source changes), so its render path is exactly the same as a normal layer and follows the finger while painting"),
      it("add", "双击画布（不只是标题）也能快速聚焦并适配到那张画布：双击任意一张画布的画面即可切过去并缩放到适配大小；双击当前画布则只做适配（若你把「画布内双击」映射成了别的功能，仍然执行你的映射）", "Double-tapping a canvas BODY (not just its title) now focuses that canvas and zooms it to fit: double-tap any canvas' artwork to switch to it and fit it on screen. Double-tapping the current canvas just fits it, and a user mapping of \"double tap on canvas\" still wins"),
      it("add", "解除吸附也有动画反馈：点标题栏右侧的解除按钮时，两张画布之间那道连接会变成红色半透明，向两边扩散并淡出（约 0.5 秒），同时震一下，明确表示连接已经断开", "Releasing a snap now animates too: tapping the un-snap button turns the connection between the two canvases into a red translucent link that spreads outwards and fades away (~0.5s), with a haptic tick, so it is obvious the link is gone"),
      it("imp", "引用画布改为「按图层引用」：引用一张画布时，源画布的每个图层各生成一条引用图层（按顺序、沿用图层名），每条都精确绑定到源画布对应的那条图层——在引用层上画，就改到源画布那一条，不再「猜」是哪个图层；源画布那条图层即使被隐藏，引用层照样显示内容（在引用画布这边可单独开关），被锁定时会明确提示「源画布里的该图层已锁定」而不是默默没反应。引用弹窗顶部新增「按图层引用 / 合并为一条」切换：后者仍只引用合成后的整张画面（编辑落在源画布当前选中的图层），旧工程里的单层引用也按这个方式继续工作。画布球 → 更多里新增「解除全部引用」，一次把当前画布上所有引用层烘焙成普通图层（一条历史，可撤销）；图层面板上引用层的提示会写清「哪张画布 / 哪个图层」；图层 id 与引用绑定关系随工程保存，重新打开工程后依然有效。", "Reference canvas now imports PER LAYER: referencing a canvas creates one live reference layer for every layer of the source (same order, same names), and each one is bound to that exact source layer — painting on a reference layer edits precisely that layer instead of guessing which one. A hidden source layer still shows in the holder (where it can be toggled on its own), and a locked one now says \u201cthat layer is locked in the source canvas\u201d instead of silently doing nothing. The reference dialog gained a Per layer / Flattened switch: Flattened still mirrors the whole canvas in one layer (edits land in the source's selected layer), and references saved by older builds keep working that way. The canvas orb's More page gained Release all refs, which bakes every reference layer of the current canvas into normal layers at once (one undoable step), the layer tooltip names the source canvas and layer, and layer ids plus the binding are stored in the project so they survive a reload."),
      it("imp", "主菜单里的「新建画布」改成「新建工程」：会关闭当前所有画布并清空操作记录（先弹一次未保存确认），回到一张全新的画布；如果只是想在同一工程里再开一张画布，用画布球里的「新建画布」", "The main menu item New canvas is now New project: it closes every open canvas and clears the undo history (after the usual unsaved-work prompt) and starts from one fresh canvas. To add another canvas inside the same project, use New canvas in the canvas ball"),
      it("fix", "修复撤销/重做时「引用图层慢一拍」：以前是先重合成画面、再同步引用层的镜像，所以源画布已经变回去了、当前画布上的引用层还显示旧内容，要等下一次重绘才对。现在顺序反过来（先同步镜像再合成），并且镜像真的变化时会立即让视图重绘", "Fixed reference layers lagging one step behind on undo/redo: the view composited BEFORE the mirrors were re-synced, so the source canvas had already reverted while the reference layer still showed the old pixels until the next repaint. The order is now mirrors-first, and a mirror that really changed immediately invalidates the view"),
      it("fix", "修复「把小画布引用到大画布里，引用图层画不上去」：引用层的画面是**居中**放在当前画布里的，但笔迹一直按当前画布的坐标直接写进源画布——源画布更小的时候，画的点几乎全都落在源画布外面（或者错位一格），看起来就像引用图层无法编辑。现在笔迹、油漆桶、渐变、形状、轮廓填充与选区遮罩都会先按居中偏移换算，画哪儿就改源画布的哪儿，再原样镜像回来", "Fixed \u201creferencing a small canvas into a big one and the reference layer cannot be painted\u201d: the mirror is CENTRED inside the current canvas, but strokes wrote into the source canvas using this canvas' coordinates. With a smaller source most pixels landed outside it (or were offset by the centring), which looked like the reference layer was not editable. Strokes, the bucket, gradients, shapes, outline fill and the selection mask are now translated by that centring offset, so painting edits exactly the source pixel under the finger and mirrors straight back"),
      it("add", "像素完美笔画：手绘时自动去掉「L 形拐角」多余的那一个像素（Aseprite 的 pixel-perfect 规则），斜线/曲线不会再出现台阶上的双像素；底栏铅笔/橡皮旁有开关，设置 → 工具里可改默认", "Pixel-perfect strokes: freehand drawing drops the extra corner pixel of an L-shaped step (Aseprite's pixel-perfect rule), so diagonals and curves no longer double up on the staircase. There is a toggle next to the brush tip in the bottom bar and a setting under Tools"),
      it("add", "油漆桶升级：新增「相似色」容差（逐通道 0–255，抗锯齿边缘一次填满）与「填充缝隙」（填色前把边界上小于指定宽度的缺口临时封住，线稿有断口也不漏色）；底栏多出相似色开关与两个长按拖动按钮，设置 → 工具里注册了默认值与总开关", "Fill bucket upgraded: a Similar colour tolerance (per channel 0-255, fills anti-aliased edges in one go) and Fill gaps (seals boundary gaps narrower than the chosen width before filling, so a broken outline does not leak). The bottom bar gained the similar-colour toggle plus two hold-and-drag buttons, and Settings -> Tools registers their defaults and master switch"),
      it("add", "平铺模式下笔迹会环绕补画：画到边缘的像素同时出现在对面，一笔就能画出接缝对得上的无缝瓦片（画笔/橡皮/喷枪/形状/油漆桶/轮廓填充都支持）", "In tiled mode strokes wrap around the canvas: pixels drawn past an edge appear on the opposite side, so one stroke produces a seam-matching seamless tile (brush, eraser, airbrush, shapes, bucket and outline fill all follow)"),
      it("add", "视图 90° 旋转：画布球 → 更多 → 「旋转视图 90°」按 0/90/180/270 循环，画布标题栏、指针命中与拖拽方向都会跟着转；躺着画或竖屏画横图时很顺手", "Rotate the view 90 degrees: Canvas ball -> More -> Rotate view 90 cycles 0/90/180/270. Canvas title bars, pointer hit-testing and drag direction all follow, which is handy when drawing a landscape sprite in portrait"),
      it("imp", "自动保存改为「按间隔保存」：默认每 5 分钟写一次（设置 → 数据里可调 1–60 分钟），不再是每次改动都写；切到后台或离开页面时仍会立即补存一次。自动保存的内容改成纯 JSON 数据（像素用 RLE 编码），不再内嵌 PNG 图片，体积更小、恢复更快", "Autosave now saves on an INTERVAL: once every 5 minutes by default (1-60 minutes in Settings -> Data) instead of on every change, and hiding the app or leaving the page still writes once immediately. The payload is pure JSON data (pixels RLE-encoded) with no embedded PNG images, so it is smaller and restores faster"),
      it("imp", "性能：把「像素变化」和「界面状态变化」分开——切工具、拖笔刷大小/不透明度、选颜色、改设置不再让引用画布重新镜像，也不再把其他画布的合成缓存判为过期（拖参数时明显更顺）", "Performance: pixel changes and UI-only changes are now separate, so switching tools, dragging brush size/opacity, picking colours or changing a setting no longer re-mirrors reference canvases or invalidates the other canvases' composite caches (noticeably smoother while dragging a slider)"),
      it("add", "索引色模式：调色板面板里的开关，开启后画上去的像素自动吸附到调色板里最接近的颜色（不透明度仍按画笔），画布始终保持调色板配色；配套的「映射到调色板」可以把已有画面一次性换成调色板颜色（一条历史可撤销）", "Indexed colour mode: a switch in the palette panel. While on, painted pixels snap to the nearest palette colour (brush opacity still applies) so the artwork always stays inside the palette, and the companion Map to palette action converts existing artwork in one undoable step"),
      it("add", "新增多点折线与曲线工具（形状工具组里）：点一下加一个点、拖动时显示橡皮筋预览、点最后一个点结束并合成一条历史、点倒数第二个点可撤掉最后一个点；曲线用平滑样条穿过所有点", "New multi-point polyline and curve tools (in the shape group): tap to add a point, drag for a rubber-band preview, tap the last point to finish (one history step) and tap the point before it to remove it. The curve tool runs a smooth spline through every point"),
      it("add", "关闭的画布现在可以撤销找回：关闭画布会记成一条普通历史步（历史面板里显示为「关闭画布」），撤销后它连同**位置、尺寸、锁定状态、吸附组、图层/帧选择、预览框**一起回到空间里的原位置并重新聚焦，重做会再把它关掉。这条撤销一直有效到打开或新建工程为止——工程文件里不会包含已经关闭的画布，重新打开工程后它就真的不在了。另外，把最后一张画布也关掉、停在空白工程界面时，顶部工具栏的撤销/重做仍然可用（以前是灰的，等于关掉最后一张就再也救不回来）。", "A closed canvas can now be brought back with undo: closing a canvas is recorded as an ordinary history step (shown as Close canvas in the history panel), and undoing it returns the canvas to its original spot in the space — position, size, lock, snap group, layer/frame selection and its preview window included — and focuses it again, while redo closes it once more. This stays available until you open or start another project: a project file never contains a canvas you closed, so after reopening the project it really is gone. Undo/redo in the toolbar also stay live on the empty-project screen after the last canvas was closed (they used to be greyed out, so closing the last canvas was a dead end)."),
      it("imp", "历史记录改为整个工程共用一条：不再按画布分开保存，撤销/重做按全局顺序作用到对应的画布（切画布不再改变撤销栈），「过程回放」也变成全局回放——一次把所有画布的操作按顺序播完；关闭某张画布也记成一步，可以撤销找回（见下一条）；工程文件里只存一条历史（每一步记录它属于哪张画布），旧版本按画布分开保存的历史在打开时会按画布顺序合并", "History is now one shared stack for the whole project instead of one per canvas: undo/redo walk the global order and apply to the canvas each step belongs to (switching canvases no longer changes the stack), and Replay is global too — every canvas' operations play back in one sequence. Closing a canvas is itself a step you can undo (see the next entry), and the project file stores a single history where each step names its canvas; projects saved by older builds with per-canvas histories are merged in canvas order on load"),
      it("imp", "全量核对并修整图标：不同功能不再共用同一图标——选区反选/反色/色板去重原本都用一个图标，现在分别是「半选方块 / 反色方块 / 重叠方块减去」；删除选区不再用裁剪图标、清空画布不再用居中图标、选区描边改用描边图标、剪切用剪刀、粘贴用剪贴板、重命名用钢笔、提取图层用「方框飞出」、引用画布用「两张画布连线」、画布位置锁定改用图钉（与图层锁区分）、解除吸附/解除引用用断链图标、帧时长用时钟、更新日志用喇叭、引导重放用问号、参考图用图片、精灵表用表格、帧多选用带勾选的帧格、平铺横/竖用排列图标、预览按钮用预览窗图标；主菜单按钮改成三横线（不再是齿轮）；停靠区的主球显示当前工具图标而不是永远铅笔；同时删掉 9 个没人用的图标（实心椭圆、适配、退出全屏、等距特效、描边2、手形、放大、缩小、画笔）", "Full icon audit and cleanup: different features no longer share one icon — invert selection / invert colours / palette de-dupe used to be the same glyph and are now half-filled square, inverted square and overlapping squares minus; deleting a selection no longer uses the crop icon, clearing the canvas no longer uses the centre icon, selection outline now uses the outline icon, cut uses scissors, paste a clipboard, rename a pen, extract a layer a box flying out, reference a canvas two linked frames, canvas position lock a pushpin (distinct from the layer lock), un-snap / release reference a broken chain, frame duration a clock, changelog a megaphone, tour replay a question mark, reference image a picture, sprite sheet a table, frame multi-select frames with ticks, horizontal/vertical tiling arrangement icons and the preview button a preview-window icon. The main menu button is now a hamburger (was a gear) and the docked main ball shows the active tool instead of always a pencil; 9 unused icons were deleted (filled ellipse, fit, exit-fullscreen, iso effect, edge-2, hand, zoom in/out, paint)"),
      it("add", "设置 → 画布与网格新增一整组画布吸附参数：吸附总开关、吸附判定范围（4–48 屏幕像素）、吸附后留白（0–48 画布像素）、吸附进入颜色、吸附离开颜色（后四项在总开关关闭时自动隐藏）；颜色用新的颜色选择器设置，并随设置文件导入导出", "Settings -> Canvas & Grid gained a full set of canvas-snap parameters: the master switch, the snap range (4-48 screen px), the gap left after snapping (0-48 canvas px), the snap-in colour and the snap-out colour (the last four hide themselves while snapping is off). Colours use a new colour picker control and travel with the settings file"),
      it("imp", "吸附反馈支持多个区域同时满足：拖动时所有满足吸附条件的空隙会一起亮绿（不再是一个亮了另一个就消失），每新进入一个区域各闪一次并震动，把某张画布拉出范围时只有那道空隙闪红消失、其余继续保持；之前「离开范围的红闪」因为离开后已经量不到空隙而根本没画出来，现在在离开瞬间把矩形快照下来，红闪正常显示", "Snap feedback now handles several zones at once: every gap that satisfies the snap criteria lights up green together (a new one no longer replaces the old one), each newly entered zone flashes once with a haptic tick, and pulling away from one canvas only fades THAT gap out in red while the others stay lit. The \"leaving\" flash was previously invisible because the gap could no longer be measured after moving away — the rect is now snapshotted at the moment it is left"),
      it("imp", "画布缩得很小（比标题栏还窄）时，标题栏只显示画布名称，并且保持相对画布居中", "When a canvas is smaller on screen than its title bar, the bar shows only the canvas name and stays centred on the canvas"),
      it("fix", "修复拖动画布时「相机跟着画布跑」的怪异手感：相机锚定在聚焦画布上，以前拖动聚焦画布时画布在屏幕上不动、整个空间从它下面滑走；现在拖动聚焦画布（或它所在的组）会同步平移视口，画布跟着手指走、周围画布保持不动；拖动非聚焦画布时相机仍然不动", "Fixed the odd \"camera follows the canvas\" feel when dragging: the view is anchored on the focused canvas, so dragging THAT canvas used to keep it glued to the screen while the whole space slid underneath. Moving the focused canvas (or its group) now pans the view by the same amount, so the canvas follows your finger and the neighbours stay put; dragging a canvas that is not focused still leaves the camera alone"),
      it("imp", "吸附改为留空隙：吸附后的两张画布之间固定留 8px 空档（不再贴在一起），这段空档用半透明绿色标出来，一眼能看出哪些画布是一组", "Snapping now leaves a gap: two snapped canvases keep 8px of empty space between them (no longer flush), and that space is tinted semi-transparent green so a group is obvious at a glance"),
      it("fix", "修复画布标题栏拖动不灵敏：上一版加了标题栏按钮后，按在画布名字/图标上不会开始拖动（只有按到空白处才行），现在只要不是按在按钮上都能拖；拖动判定阈值也从 6px 降到 4px", "Fixed the sluggish canvas title-bar drag: after adding the title-bar buttons, pressing on the canvas name or icons no longer started a drag (only the empty part worked). Now anything except the buttons starts the drag, and the movement threshold dropped from 6px to 4px"),
      it("imp", "标题栏左侧的眼睛改成开关：点一下给这张画布开预览框，再点一下关掉（眼睛有高亮状态）；标题栏不再显示画布尺寸，更清爽", "The eye at the left of a title bar is now a toggle: tap to open that canvas' preview window and tap again to close it (the eye highlights while it is open); the canvas size is no longer shown in the title bar"),
      it("add", "画布吸附：把一张画布拖到另一张旁边时会自动对齐边缘吸附，松手后两张画布成为一组，之后拖动其中任意一张都会整组一起移动；标题栏右侧出现「解除吸附」按钮可以单独把一张画布解出来（其余仍成组），吸附关系随工程保存", "Canvas snapping: drag a canvas next to another one and it magnetically aligns edge-to-edge; on release the two become a group, and dragging either one moves them all. An un-snap button appears at the right of the title bar to release one canvas (the rest stay grouped), and the grouping is saved with the project"),
      it("add", "画布球新增「锁定 / 解锁画布位置」：锁定后这张画布的标题栏拖不动（点按聚焦、双击适配照常），标题栏上显示锁图标；锁定状态随工程保存", "The canvas orb gained Lock / Unlock canvas position: a locked canvas can no longer be dragged by its title bar (tap to focus and double-tap to fit still work) and shows a lock glyph in the title; the state is saved with the project"),
      it("imp", "画布球精简：移除「适配画布」（与双击标题重复），移除「预览」——预览按钮移到每条画布标题栏的左侧，点一下就给这张画布开一个预览框", "Leaner canvas orb: Fit was removed (double-tapping a title does it) and Preview moved to the LEFT of every canvas title bar, where one tap opens that canvas' preview window"),
      it("add", "被引用画布自己的选区现在会显示在引用它的那条图层上：淡紫色底 + 紫色虚线框，位置与该画布的镜像一致（两张画布尺寸不同也按居中偏移对齐）。它只是「那张画布的选区」的显示，不会变成当前画布自己的选区，因此不会裁剪你在当前画布上的绘画", "A referenced canvas' own selection is now shown on the reference layer that mirrors it: a faint violet tint plus a violet dashed frame, aligned with the mirrored pixels (centred when the sizes differ). It is only a display of that canvas' selection, not this canvas' own selection, so it never clips what you paint here"),
      it("fix", "修复引用图层上的「非笔迹」修改不会同步到源画布的问题（选区填充/移动/旋转缩放、特效等直接写在镜像上，随后被源画布覆盖回来）：现在每次同步前会对比镜像，把被直接改动的像素推回源画布，两侧真正双向；这类改动记在你当前所在画布的历史里，可直接撤销；顺带修好轮廓填充工具在引用层上的重定向判断", "Fixed non-stroke edits on a reference layer (selection fill/move/transform, effects …) not reaching the source canvas — they were written onto the mirror and then overwritten. Every sync now diffs the mirror and pushes direct edits back into the source canvas, so both sides really stay in sync; such edits are recorded in the history of the canvas you are working in, so undo works right there. The outline tool's redirect check on reference layers was fixed too"),
      it("imp", "选区浮动球改成「只要当前工具是选区工具（框选/魔棒/套索）或存在选区」就出现，不再必须先框出选区；没有选区时全选、粘贴等按钮依然可用，需要选区的按钮会提示先建立选区", "The selection orb now appears whenever the active tool is a selection tool (rect / wand / lasso) OR something is selected, instead of only after a selection exists. With nothing selected, Select all and Paste still work and the buttons that need a selection say so"),
      it("fix", "修复图形绘制后的自动选区（画线/矩形/椭圆后自动选中刚画的像素并切到选区工具）在引用画布上失效的问题：上一版为避免坐标错位临时关掉了它，现在把选区从源画布坐标映射回当前画布，普通图层与引用图层都正常", "Fixed the shape-to-selection step (after drawing a line/rect/ellipse the pixels you just drew are selected and the select tool activates) on reference layers: the previous build had disabled it to avoid mismatched coordinates; the selection is now mapped back from the source canvas' coordinates, so it works on normal layers and reference layers alike"),
      it("fix", "画布引用弹窗里的画布名称不再被横向截断：卡片加宽、名称最多两行完整显示（尺寸另起一行）", "Canvas names in the reference dialog are no longer cut off horizontally: wider cards and the name wraps onto up to two lines, with the size on its own row"),
      it("add", "新增「引用画布」：画布球 → 更多 → 引用画布，弹出所有画布的缩略图（类似帧预览页），点一张就把它作为一层引用进当前画布。引用层是实时联动：它显示的永远是源画布（跟随源画布当前帧，尺寸不同时居中），在引用层上画会直接改到源画布的当前图层，源画布改动后所有引用它的画布立刻更新；图层行上有 ⚭ 标记，图层面板点「解除引用」会保留像素并断开关系，循环引用会被拒绝", "New Reference canvas: canvas orb -> More -> Reference canvas shows a thumbnail page of every canvas (like the frame preview); tap one and it becomes a live layer in this canvas. The layer always mirrors that canvas (following its current frame, centred when sizes differ), painting on it edits the source canvas' current layer, and any edit over there updates every canvas that references it. The layer row is marked with a link glyph, and Release reference in the layer panel keeps the pixels and breaks the link; reference loops are refused"),
      it("add", "新增「提取为画布」：画布球 → 更多 → 提取为画布，把当前图层（连同它的所有帧）移动成一张独立画布，原画布中的该图层会被移除（有确认提示）", "New Extract to canvas: canvas orb -> More -> Extract to canvas moves the current layer (with all of its frames) out into a canvas of its own; the layer is removed from the original canvas after a confirmation"),
      it("imp", "界面精简：顶部工具栏去掉导出、保存、修改尺寸与全屏按钮，主菜单去掉色相调整与导出（都移到画布球里）；视口右下角只保留缩放百分比，适配画布按钮也进了画布球", "Leaner UI: the top bar drops export, save, resize and fullscreen, and the menu drops colour adjust and export (all moved into the canvas orb). The viewport keeps only the zoom percentage, and Fit moved into the canvas orb too"),
      it("add", "画布球改为两页：常用页是新建画布、重命名、改尺寸、保存（把这张画布存成它自己的 .pxc 文件）、关闭并保存；「更多」页是预览、色相调整、导出、适配画布、平铺", "The canvas orb now has two pages: New canvas, Rename, Resize, Save (writes this canvas to its own .pxc file) and Close & save on page one; Preview, Colour adjust, Export, Fit and Tiling on the More page"),
      it("add", "默认空白工程：全新安装启动时什么都不打开，中间是引导卡片（新建画布 / 打开像素画），控制栏、时间线和浮动球都会隐藏；关掉最后一张画布也会回到这个状态（工程文件会记住「一张都不开」）", "Empty project by default: a fresh install opens nothing and shows a start card (New canvas / Open artwork) with the control bar, timeline and floating balls hidden; closing the last canvas returns to it too, and the project file remembers the empty state"),
      it("fix", "每张画布现在有自己独立的撤销/重做栈：切换画布再切回来，之前的操作记录还在（之前会丢）；工程文件为每张画布各存一段历史", "Every canvas now keeps its OWN undo/redo stack: switching away and back no longer loses the other canvas' history, and the project file stores one history per canvas"),
      it("imp", "油漆桶渐变改为拖动定义方向与长度：按住拖动时画布上出现黄色方向线，松手才真正写入像素（Aseprite 风格）；渐变沿拖动方向线性过渡，不拖动则默认从上到下，超出两端的像素自动取端点色", "The bucket gradient now follows a drag: press and drag to set direction and length (a yellow guide appears on the canvas) and the pixels are only written on release, Aseprite-style. The ramp is linear along the drag, defaults to top-to-bottom without a drag, and pixels past either end clamp to the end colour"),
      it("imp", "平铺改为四种模式：关闭 / 横向平铺（左右各一份）/ 竖向平铺（上下各一份）/ 九宫格平铺（3×3），镜像平铺已移除；从画布球的「平铺」点开后弹出选择，旧设置会自动迁移", "Tiling now has four modes: off, horizontal (one copy each side), vertical (one above and below) and 3x3 grid; mirrored tiling is gone. Pick it from the canvas orb's Tiling entry, and old settings migrate automatically"),
      it("imp", "特效弹窗里的颜色参数（投影颜色、描边颜色）点色块会打开右侧调色板面板，可以直接点色板颜色，也可以拖色轮调色；选完面板自动收起、回到特效弹窗继续实时预览，且不会改动画笔的前景色", "In the FX dialogs, tapping the colour swatch of a colour parameter opens the palette panel: pick a palette colour or fine-tune with the wheel, and the panel closes itself and returns to the dialog with the live preview still running — without touching the paint colour"),
      it("fix", "浮动球存储区在拖动选择时会滚动跟随：球被面板裁切时，手指滑向它会把对应项滚进可视区（横屏同理）", "The floating-ball dock now scrolls to follow your finger: when a ball is clipped by the panel, sliding towards it scrolls that item into view (same in landscape)"),
      it("add", "双击画布标题栏会平滑放大到该画布的适配大小（单击仍只是聚焦）", "Double-tapping a canvas title bar smoothly zooms that canvas to fit the screen (a single tap still just focuses it)"),
      it("add", "多画布：所有打开的画画布都放在同一个无限空间里，每个画布上方有一条游戏风格的标题栏（文件名 + 尺寸），点标题聚焦该画布、拖动标题栏可以在空间里移动画布，画布之间不重叠自动错开；切换聚焦画布时画面不会跳动，每个画布还各自记住自己的图层/帧选择", "Multiple canvases: every open artwork lives in one infinite space, each with a game-style title bar above it (file name + size). Tap a title to focus that canvas, drag the title bar to move it around the space, and new canvases are placed without overlapping. Focusing another canvas never makes the view jump, and each canvas remembers its own layer/frame selection"),
      it("add", "新增「画布球」浮动球：新建画布、重命名（标题栏同步）、修改该画布尺寸、预览（弹出对应的预览框）、关闭并保存为单独的 .pxc 文件（至少保留一个画布）", "New canvas orb: new canvas, rename (the title bar follows), resize that canvas, preview (opens its own preview window) and close & save to a standalone .pxc file (at least one canvas always stays open)"),
      it("imp", "预览框改成按需出现：画布上方那个默认预览按钮已移除，只有从画布球点「预览」才会出现一个绑定到该画布的预览框，可以为多个画布各开一个、互不干扰；每个框都能拖动、双指捏合缩放、左上角关闭，右上角仍可切换底色/灰度", "Preview windows are now on demand: the old preview toggle above the canvas is gone, and a window appears only from the canvas orb's Preview action, bound to that canvas. Several canvases can each have their own window; every window can be dragged, pinch-resized and closed from its top-left corner, and still switches backdrop/greyscale from the top-right"),
      it("add", "喷枪工具：按住即持续喷出随机大小的像素点（笔刷大小 = 喷洒半径），底部栏可实时调整点的最小/最大边长与每秒喷洒密度，支持对称、选区与图层锁定", "New airbrush tool: hold to keep spraying random-size specks (brush size = spray radius), with the dot-size range and the spray rate adjustable from the bottom bar. Symmetry, selections and layer locks all apply"),
      it("add", "油漆桶新增渐变模式：底部栏多出一个按钮在「纯色填充 / 渐变填充」之间切换，渐变从点击处向外由前景色过渡到背景色，颗粒可选 RGB 平滑 / 2×2 / 4×4 / 8×8（后三种按方块取色，像素风硬边渐变）", "The fill bucket gained a gradient mode: a bottom-bar button switches between flat and gradient fill. The gradient ramps from the foreground to the background colour, radially outwards from the tap point, with RGB-smooth / 2x2 / 4x4 / 8x8 steps (the last three sample one colour per block for hard-edged pixel-art ramps)"),
      it("add", "新增「模糊」特效：弹窗设置半径 1–32px，拖动数值时画布实时预览，确定才记入历史（alpha 一起柔化，透明区域不会渗黑边）", "New Blur effect: a dialog sets the radius (1-32px) with live canvas preview; only confirming records a history step (alpha is softened too, and transparent areas never bleed dark halos)"),
      it("imp", "投影与描边特效改为参数弹窗：投影可设偏移 x/y、颜色与不透明度（仍可在设置里选择写在本图层或新建 shadow 图层）；描边可设宽度 1–16px、位置（外侧/内侧/居中）与颜色；两者都实时预览", "Drop shadow and outline are now parameter dialogs: the shadow takes offset x/y, colour and opacity (Settings still chooses the current layer or a new shadow layer), the outline takes width 1-16px, position (outside/inside/centred) and colour. Both preview live on the canvas"),
      it("add", "长按图层眼睛 = 只显示该图层，再次长按恢复其它图层原来的显示状态（手动点眼睛会退出该模式；这一步同样可撤销、可随工程保存）", "Long-press a layer's eye to show only that layer; long-pressing again restores exactly what the other layers showed before. A manual eye tap leaves the mode, and the step is undoable and saved with the project"),
      it("imp", "数字输入框支持四则运算：可以输入 64*2+8 这样的算式（+ - * / % ^ 与括号，兼容全角符号），边输边算，失焦或回车应用；手机数字键盘没有运算符，聚焦时输入框下方会浮出一排 + − × ÷ ( ) ⌫ = 按键", "Number fields accept arithmetic: type a formula such as 64*2+8 (+ - * / % ^ and parentheses, full-width symbols included) and it evaluates as you type, applying on blur or Enter. The phone number pad has no operators, so a row of + - x / ( ) backspace = keys pops up under the focused field"),
      it("imp", "预览框与帧预览都支持双指捏合缩放：浮动预览框捏合改变框体大小，帧预览弹窗捏合改变缩略图大小（缩略图按新尺寸重绘，底部可一键复位）", "Preview boxes and the frame preview both support pinch zoom: pinch the floating box to resize it, pinch the frame-preview dialog to scale its thumbnails (redrawn at the new size, with a one-tap reset in the footer)"),
    ],
  },
  {
    v: "1.0.7.10",
    date: "2026-09-08",
    items: [
      it("fix", "拖动时间线顶部那条线现在会实时改变整个面板的高度（以前只改矩阵上限，图层少时拖动看不出变化）——图层行下方多出来的空间用单元格底色补满，横竖屏都跟随手指", "Dragging the line above the timeline now resizes the whole panel in real time (it used to change only the matrix cap, so with few layers nothing moved). The space below the layer rows is filled with the cell colour, and it follows the finger in both orientations"),
      it("imp", "设置里的「时间线面板高度」改为整块面板高度：默认 200px、范围 140–520px（旧版本存的矩阵高度会自动换算），双击分割线复位 200px", "The Timeline panel height setting now means the whole panel: default 200px, range 140-520px (values saved by older builds are converted automatically), and double-tapping the divider resets it to 200px"),
    ],
  },
  {
    v: "1.0.7.9",
    date: "2026-09-08",
    items: [
      it("add", "新增「全面屏」设置组：沉浸式全屏开关（隐藏系统状态栏 / 导航栏）、安全区适配（避开刘海、挖孔与底部手势条）、额外安全边距 0–40px（系统不上报时手动补），并有一行实时「安全区检测」显示系统上报的四边数值", "New Full screen settings group: an immersive switch (hides the system status and navigation bars), safe-area padding (keeps controls clear of the notch, punch hole and gesture bar), extra padding of 0-40px for ROMs that report nothing, and a live safe-area probe line showing the four detected insets"),
      it("add", "全面屏适配：Android 侧改为允许内容画进挖孔区（cutout SHORT_EDGES），并通过桥接把系统栏安全边距（含隐藏系统栏后的手势条 / 刘海）折算成 CSS px 交给网页，顶部栏、控制条、时间线、弹窗都按它留白", "Full-screen support: the Android layer now draws into the cutout area (SHORT_EDGES) and reports the system-bar and cutout insets in CSS px to the page, which pads the top bar, control bar, timeline and dialogs accordingly"),
      it("fix", "设置里展开的下拉选项会被分组卡片裁切（看不到完整选项）——分组框不再裁剪，且下拉在下方空间不足时自动向上展开", "Dropdown options in Settings were clipped by their group card; the group no longer clips, and a dropdown flips upwards when there is not enough room below"),
      it("add", "时间线高度可以直接拖动：时间线面板顶部新增拖动条（横屏时就是时间线顶部那条线），上下拖动实时改变高度并显示 px 数值，双击复位为 116px", "The timeline height is now draggable: a grip on top of the timeline panel (in landscape that is the line above the bottom timeline) resizes it live with a px readout, and double-tapping it resets to 116px"),
    ],
  },
  {
    v: "1.0.7.8",
    date: "2026-09-08",
    items: [
      it("imp", "设置界面重排：每条设置独立成一张卡片（浅底 + 圆角 + 细边框），说明文字改成小号灰字并收在同一张卡片内，不会再被误读成下一条设置的标题", "Settings layout rework: every setting is its own card (subtle background, rounded corners, hairline border) and its description is small grey text inside that same card, so it can no longer be mistaken for the next setting's label"),
      it("imp", "设置行标题统一为同一字号字重（原来开关/数字行是 13px 亮色、枚举行是 11px 暗色，看起来像两类东西）；分组标题右侧多了一个小圆点，表示该组里有改动过的设置", "Setting titles now share one size and weight (switches/numbers were 13px bright while enum rows were 11px dim, which made them look like different things); group headers show a small dot when that group contains changed settings"),
    ],
  },
  {
    v: "1.0.7.7",
    date: "2026-09-08",
    items: [
      it("fix", "震动只有四指预览和长按取色会触发，其余手势（双击撤销、三连击缩放、双指双击重做、时间轴长按、工具栏展开）完全没有震动 —— 现在每个手势动作都会先震一下再执行", "Only the four-finger preview and the long-press eyedropper used to vibrate; every other gesture (double-tap undo, triple-tap zoom, two-finger double-tap redo, timeline long press, tool ring) fired nothing. Every gesture action now gives a tick before it runs"),
      it("fix", "手势震动时长原来只有 10–26ms，部分机型对 30ms 以下的短震动基本无感，看起来就像“震动没生效”——默认改为 60ms，并新增「震动时长」设置（短 30 / 中 60 / 长 100ms）", "Gesture pulses were only 10-26ms long and some phones cannot feel pulses under about 30ms, which looks exactly like 'vibration does not work'. The default is now 60ms plus a new Haptic length setting (short 30 / medium 60 / long 100ms)"),
      it("imp", "设置 → 数据 的「震动环境诊断」升级：显示开关状态、震动时长和最近 4 次震动调用（来源:时长），每秒刷新，可直接看出某个手势到底有没有调到马达；「测试震动」改为按所选时长发一次、0.4 秒后再发一次 120ms 长震，便于对比", "The vibration diagnostics line in Settings -> Data now shows the switch state, the pulse length and the last four haptic calls (source:length), refreshing every second, so it is directly visible whether a gesture reached the vibrator. Test vibration now fires once at the chosen length and again at 120ms 0.4s later for comparison"),
      it("imp", "移除 1.0.7.6 的启动诊断震动", "Removed the diagnostic buzz on launch that 1.0.7.6 shipped"),
    ],
  },
  {
    v: "1.0.7.6",
    date: "2026-09-08",
    items: [
      it("imp", "震动问题排查用诊断版：启动时直接用 Java 震一下（不经过 JS），设置 → 数据 里新增“震动环境诊断”一行，显示 桥接 / 震动接口 / navigator.vibrate / 马达 / 上次调用结果", "Diagnostic build for the vibration issue: a Java-only buzz on launch (no JS involved) plus a Vibration diagnostics line in Settings -> Data showing bridge / vibrate API / navigator.vibrate / motor / last call result"),
    ],
  },
  {
    v: "1.0.7.5",
    date: "2026-09-08",
    items: [
      it("fix", "再次修复震动：原生 vibrate 改为同步调用并返回结果（不再绕 UI 线程），振幅改为最大值 255、时长上限 200ms；打开工具球/浮动球也会震一下", "Vibration fix, round two: the native vibrate call is now synchronous and returns whether it fired (no UI-thread hop), amplitude is the maximum 255 with a 200ms cap, and opening the tool ring / floating ball ticks as well"),
      it("add", "设置 → 手势与触控 里新增“测试震动”按钮：按下会立刻震动 80ms，并用提示区分“已触发”“系统禁止”“设备无马达”三种情况，方便定位问题", "Settings -> Gestures & Touch gains a Test vibration button: it fires an 80ms pulse and tells you whether it fired, the system blocked it, or the device reports no vibrator"),
    ],
  },
  {
    v: "1.0.7.4",
    date: "2026-09-08",
    items: [
      it("fix", "修复应用内震动不生效：原生改用 VibratorManager（Android 12+）并在失败时回退旧接口，震动时长上限从 60ms 提到 100ms；打开“震动反馈”开关会立刻震一下，长按拖拽开始时也会震；设备没有可用马达时在设置里给出提示", "Fix in-app vibration: the native side now uses VibratorManager (Android 12+) with a legacy fallback, the maximum pulse went from 60ms to 100ms, switching Haptic feedback on ticks immediately, long-press drags tick as well, and Settings warns when no vibrator is available"),
      it("imp", "手势功能映射改用下拉选择（和调色板排序同款的可展开样式），选项多的设置项（如启动工具）也自动用下拉，不再铺一屏按钮", "Gesture mappings now use the same expandable dropdown as the palette sort control, and any setting with many options (like the launch tool) switches to it automatically instead of filling the panel with buttons"),
    ],
  },
  {
    v: "1.0.7.3",
    date: "2026-09-08",
    items: [
      it("add", "每个手势的功能都可以改：设置 → 手势与触控里，画布外双击、画布内双击、双指双击、三连击、四指滑动、长按各自可以选择撤销 / 重做 / 放大 / 缩小 / 适配视图 / 播放暂停 / 洋葱皮 / 网格 / 对称 / 时间轴 / 帧预览 / 上一帧 / 下一帧 / 调色板 / 取色 / 关闭", "Every gesture can now run a different function: in Settings -> Gestures & Touch, double-tap margin, double-tap canvas, two-finger double-tap, triple-tap, four-finger slide and long-press each pick from undo / redo / zoom in / zoom out / fit / play-pause / onion skin / grid / symmetry / timeline / frame preview / prev frame / next frame / palette / pick colour / nothing"),
      it("add", "工程文件现在会带上操作记录：保存的 .pxc 里包含撤销/重做栈（笔迹增量、图层/帧结构快照、可见性等小改动），重新打开后还能继续撤销、重做和跳转历史；设置 → 数据里可以关闭记录存储来减小文件体积", "Project files now carry the operation history: a saved .pxc contains the undo/redo stack (stroke deltas, layer/frame snapshots, small edits like visibility), so reopening it lets you keep undoing, redoing and jumping through history; Settings -> Data can turn the recording off to keep files small"),
      it("imp", "恢复的历史步骤语义完整：能序列化的步骤全部保留，无法序列化的步骤会截断更旧的记录，保证撤销结果永远正确", "Restored history stays correct: every serializable step is kept and an unserializable one truncates the older entries, so undo can never produce a wrong result"),
    ],
  },
  {
    v: "1.0.7.2",
    date: "2026-09-08",
    items: [
      it("add", "状态跨启动保持：笔刷大小/不透明度、前景与背景色（含透明度）、当前工具与形状/选区子环、对称轴（开关/角度/轴心/四向/锁定）、最后使用的色板、新建文档的尺寸与背景、参考图，重启后全部还在", "Everything survives a restart now: brush size and opacity, foreground/background colours (including alpha), the active tool plus its shape/selection sub-ring, the whole symmetry axis (on/off, angle, pivot, four-way, lock), the last palette, new-document size and background, and the reference image"),
      it("add", "笔尖形状可切换：圆笔尖（默认）与方笔尖，笔迹和图形描边都跟着变；控制栏加了切换按钮，设置里也有", "Switchable brush tip: round (default) or square, applied to both freehand strokes and shape outlines, with a control-bar toggle and a Settings entry"),
      it("add", "图形新增“从中心绘制”：矩形/椭圆/圆/多边形以按下点为中心向外生长，控制栏有开关、设置里有默认值", "New Draw shapes from the centre option: rect/ellipse/circle/polygon grow outwards from the touch point, with a control-bar toggle and a Settings default"),
      it("add", "多边形边数进入设置（3–32，控制栏上限也从 12 提到 32），并可设置图形默认实心/空心", "Polygon side count is now a setting (3–32, the control-bar slider also goes to 32) and shapes can default to filled or hollow"),
      it("add", "对称开启时选区工具（框选 / 套索 / 魔棒）也会按对称轴镜像选区，和画笔保持一致", "With symmetry on, the selection tools (marquee / lasso / wand) mirror the selection across the axis too, matching the brush"),
      it("add", "新增“手势与触控”设置组：长按判定时间、双击判定间隔、三连击放大倍率、四指滑动阈值、边缘自动平移范围与速度、最小/最大缩放、震动反馈开关、边距双击撤销开关", "New Gestures & Touch settings group: long-press delay, double-tap window, triple-tap zoom factor, four-finger slide threshold, auto-pan edge zone and speed, minimum/maximum zoom, haptic feedback and margin double-tap undo"),
      it("add", "参考图持久化：导入的参考图连同窗口位置、大小与不透明度一起保存，重启后自动恢复；窗口左下角新增不透明度滑块", "Reference images persist: the picture plus its window position, size and opacity are restored on launch, and the window gains an opacity slider"),
      it("imp", "调色板面板：点击面板空白区域即可关闭（滚动或长按不会误触）", "Palette panel: tapping its blank area closes it (scrolling or long-pressing never does)"),
      it("add", "设置新增：启动时使用的工具、新建文档宽高与背景", "New settings: the tool selected on launch, plus new-document width, height and background"),
    ],
  },
  {
    v: "1.0.7.1",
    date: "2026-09-08",
    items: [
      it("fix", "修复返回键直接把应用退到后台：原生侧把 JS 返回的字符串再 JSON 编码后比较失败，导致每次返回都执行了 finish()；现在有弹窗/面板/浮动球/引导时只关闭最上层，都没有时第一次返回提示、再按一次才退出", "Fix the back gesture quitting straight to the home screen: the native side compared a JSON-encoded string and always fell through to finish(). Now it closes the topmost layer (dialog / panel / ball ring / tour) and only warns first when nothing is open"),
      it("imp", "多选帧时点击该帧在图层矩阵中的任意格子也能勾选，选中帧的整列会加底色标出（不再只能点帧号）", "While picking frames you can now tap any layer cell in that frame, not just the frame number, and the whole picked column is highlighted"),
      it("imp", "色板面板改用选项卡：色板 / 画布 / 最近（标题更短），排序改成选项卡右侧的可展开下拉（按色相 / 按明度），去重改为图标按钮；删掉了颜色代号输入框旁毫无意义的取色器", "The palette panel now uses tabs (Palette / Canvas / Recent, shorter labels), sorting moved into an expandable menu on the right of the tab bar (by hue / by lightness), de-dupe became an icon button, and the pointless native colour picker beside the hex field is gone"),
      it("add", "可以把当前色板保存为自定义预设：保存后出现在预设列表里，可替换 / 合并 / 删除，重启后仍在", "The current palette can be saved as a custom preset: it shows up in the preset list and can be applied, merged or deleted, and it survives restarts"),
      it("imp", "更新日志改为版本选项卡（横向可滚动，带日期），新增 / 改进 / 修复 分类可以点标题折叠", "Release notes now use version tabs (horizontally scrollable, with dates) and the Added / Improved / Fixed groups can be folded by tapping their header"),
      it("imp", "设置面板里“文字 + 开关”和“文字 + 数值”的设置项改为同一行横向布局（标签在左、控件在右），省掉一半纵向空间；说明文字仍在下方独占一行", "Settings rows with a switch or a single number now put the label and the control on one line (label left, control right), halving the vertical space; the description still gets its own line below"),
    ],
  },
  {
    v: "1.0.7",
    date: "2026-09-08",
    items: [
      it("imp", "绘制改为增量渲染：笔迹只重合成与重绘改动的区域（脏矩形），并把同一帧内的多次重绘合并成一次；洋葱皮幽灵帧与选区染色图加入缓存，大画布下手感明显更顺", "Drawing is now incremental: a stroke only re-composites and repaints the pixels it touched (dirty rectangles), several repaints inside one frame are coalesced into one, and onion ghosts plus the selection tint are cached — noticeably smoother on large canvases"),
      it("add", "时间轴帧多选：点帧号勾选多帧，可批量复制、删除、统一设置时长（至少保留 1 帧），批量操作各算一步撤销", "Multi-frame selection in the timeline: tap frame numbers to pick several, then duplicate, delete or set one duration for all of them (one frame always survives), each batch being a single undo step"),
      it("add", "洋葱皮新增“循环环绕”：首帧往前看到末尾帧、末帧往后看到开头帧，并用蓝色/琥珀色区分环绕帧，做循环动画时不用再自己数帧", "Loop-aware onion skin: the frame before the first one is the last one and the frame after the last is the first, tinted blue / amber so wrapped frames are obvious — no more counting frames while building a loop"),
      it("add", "导出支持帧范围：GIF、精灵表、分图层导出都能只导出指定区间，可一键“全部帧”或“用所选帧”（配合帧多选）", "Exports can now target a frame range: GIF, spritesheet and per-layer exports write just the slice you pick, with All frames / Use picked frames shortcuts"),
      it("add", "调色板整理：去重（相同颜色只留一个）、按色相或明度排序（只改顺序）、把预设色板合并进当前色板", "Palette tidying: de-dupe identical colours, sort by hue or lightness (order only), and merge a preset palette into the current one"),
      it("add", "设置面板支持搜索、单项恢复默认值，以及整套设置导出/导入 JSON（未知项忽略、非法值跳过、整数自动裁剪）", "Settings can be searched, a single row can be reset to its default, and the whole set exports/imports as JSON (unknown keys ignored, invalid values skipped, integers clamped)"),
      it("add", "返回手势逐层关闭：弹窗 → 面板 → 浮动球环 → 新手引导；都没有打开时第一次返回只提示，再按一次才退出应用", "Back gesture closes one layer at a time (dialog -> panel -> floating-ball ring -> tour); with nothing open the first press only warns and a second press exits the app"),
      it("add", "新手引导新增 5 步：帧多选、色板整理、导出帧范围、设置搜索与恢复默认、返回手势（其中帧多选会真的替你勾选两帧，导出与设置步骤直接打开真实窗口）", "The onboarding tour gains 5 steps: frame multi-select, palette tidying, export frame range, settings search/reset and the back gesture (the frame step really ticks two frames for you, while the export and settings steps open the real windows)"),
      it("imp", "新增 README 与 docs/API.md 接口文档（18 章，覆盖引擎/工具/应用/渲染/IO/UI 的对外 API 与扩展指南），并刷新竞品对比文档的过时结论", "New README and docs/API.md reference (18 chapters covering the engine, tools, app, render, IO and UI APIs plus an extension guide), and the competitor comparison doc no longer lists already-fixed gaps"),
    ],
  },
  {
    v: "1.0.6.0",
    date: "2026-09-08",
    items: [
      it("fix", "取色球的颜色来源胶囊改为固定槽位：始终位于浮动球正下方固定距离（不随色球数量跳动、绝不压住浮动球，底部空间不足时翻到上方），色球布局自动避开该位置", "The colour-source chip of the colour orb now occupies a fixed slot: a constant distance below the floater (never jumping as colours change, never covering the floater, flipping above when the bottom is tight), and the swatch layout keeps that slot clear"),
      it("imp", "更新日志面板改为固定尺寸：版本改成纵向列表（列表区内部滚动），选中版本的说明单独滚动，版本再多也不会把面板撑高", "Release-notes dialog now has a fixed size: versions are a scrollable vertical list and the notes pane scrolls on its own, so the panel never grows with the number of releases"),
      it("add", "新增模块化新手引导：分步高亮真实控件（画布 / 工具与颜色 / 浮动球 / 图层与帧 / 文件与保存 / 手势与导航），首次安装展示全部，之后每次大版本更新只展示新增步骤，主菜单里可随时重放", "New modular onboarding guide: step-by-step spotlight on the real controls (canvas / tools & colours / floating orbs / layers & frames / files & saving / gestures), shows everything on a first install, only the NEW steps after a later release, and can be replayed any time from the main menu"),
      it("imp", "引导支持“先示范再讲解”：讲到选区球时会自动在画布上框出一个选区把它呼出来（不写入撤销记录），讲完恢复原来的选区状态；步骤动作也支持一次声明多个", "The tour can now demonstrate before it explains: the selection-orb step frames a selection on the canvas to summon the orb (without touching the undo stack) and restores the previous selection afterwards. Steps may also declare several actions at once"),
      it("add", "引导细化到具体按钮：会自动打开工具环（含形状/选区子环）与主菜单，逐个高亮工具、菜单项，以及导入/导出二级菜单里的具体功能（导入图片、导入精灵表、参考图、导出对话框、导出调色板等）", "The tour now drills down to individual buttons: it opens the tool ring (including the shape and selection sub-rings) and the main menu by itself, spotlighting each tool, every menu entry, and the concrete import/export sub-menu items (import image, spritesheet, reference image, export dialog, export palette)"),
      it("add", "交互操作改为“真操作演示”：引导会真的替你点下按钮——点开浮动球与工具环、展开形状/选区子环、打开主菜单并进入导入/导出二级菜单、打开时间轴与洋葱皮（讲完自动恢复原状）；缩放/绘制/点击/四指等手势步骤另有虚拟触点动画演示", "Interactive steps now really perform the action: the tour taps the controls for you (opening the floating orbs and tool ring, expanding the shape/selection sub-rings, opening the main menu and its import/export sub-menus, switching on the timeline and onion skin — all restored when the tour ends), while gesture steps such as zoom, draw, taps and four-finger also play the virtual-finger animation"),
      it("add", "引导每个模块都补上了“真操作演示”：缩放步骤真的缩放一次再还原、工具步骤真的切换工具（橡皮/直线/框选）再切回、笔刷步骤真的调大再调回、前景背景真的交换一次、对称真的开一条轴再关掉、取色球真的循环颜色来源、洋葱皮真的打开并翻到下一帧给你看前后帧参考、三连击真的放大 2×、四连指结束引导后真的弹出“预览所有帧”", "Every tour section now performs a real demonstration: the zoom step really zooms and restores, the tool steps really switch tool (eraser / line / marquee) and switch back, the brush step really changes the size and restores it, fg/bg really swap once, symmetry really turns one axis on and off, the colour orb really cycles its colour source, onion skin really switches on and steps to the next frame, triple-tap really zooms 2x, and finishing the four-finger step really opens the all-frames preview"),
      it("add", "设置与更新日志两步直接打开真实窗口来讲解（这两步的遮罩更浅，能看清窗口内容，讲完自动关掉）；特效球因为会真的改动画面，改为逐个高亮可用特效而不实际应用", "The Settings and release-notes steps now open the real windows to explain them (with a lighter backdrop on those steps so the window stays readable, and closed again afterwards); the magic-orb effects would change the artwork, so that step lights up each effect in turn instead of applying one"),
      it("fix", "修复“双指双击 = 重做”的手势演示：之前误用了双指拖动的动画，现在改为两根手指同时双击的动画；同时三连击步骤会把画布留在高亮区域，真实放大效果看得见", "Fix the two-finger double-tap (redo) demo: it wrongly played the two-finger pan animation and now shows two fingers double-tapping together; the triple-tap step also keeps the canvas inside the highlight so the real zoom is visible"),
      it("imp", "引导文案补齐细节：形状工具松手后自动变选区（可拖动/缩放）、魔棒容差在设置→工具、帧号格点一下切帧/长按设时长/长按拖动重排、洋葱皮至少需要 2 帧、新建或打开会替换当前作品、导入精灵表需要先填单元格尺寸、预览里点任意一帧即可跳转", "Tour copy filled in the details: shapes become a movable/scalable selection when you lift, wand tolerance lives in Settings -> Tools, frame numbers switch frame / hold to set duration / hold-drag to reorder, onion skin needs at least 2 frames, new or open replaces the artwork, spritesheet import needs the cell size first, and tapping any frame in the preview jumps to it"),
      it("add", "新增静态锚点测试：自动检查引导里用到的每个控件选择器都真实存在于界面源码中，避免步骤指向已经改名的按钮而被静默跳过", "New static anchor test: it verifies that every control selector the tour uses really exists in the UI sources, so a renamed button can never make a step silently point at nothing"),
      it("fix", "引导气泡不再遮挡正在讲解的内容：依次尝试四个方向挑选不与高亮区域重叠的位置；目标占满屏幕时自动把高亮范围收缩到中心，气泡始终完整显示在屏幕内", "The guide card no longer covers what it explains: it tries all four sides for a spot that does not overlap the highlight, shrinks the highlight to its centre when the target fills the screen, and always stays fully on screen"),
      it("add", "引导新增“跳过本模块”：一键跳过当前模块剩余的步骤，直接进入下一个模块", "The tour gains a Skip section button: jumps straight past the remaining steps of the current section"),
      it("fix", "修复引导气泡超出屏幕：定位改为先测量真实高度并双向钳制，并去掉会二次偏移坐标的入场位移动画（气泡跑偏的根因）；引导时若浮动球被收进存储区会自动弹出，结束后恢复原来的停靠布局", "Fix the guide bubble leaving the screen: the card is measured first and clamped on both axes, and the entrance animation no longer shifts its coordinates (that was the root cause). Dock-parked orbs are popped out for the tour and restored to their storage layout afterwards"),
    ],
  },
  {
    v: "1.0.5",
    date: "2026-09-08",
    items: [
      it("fix", "历史色板（画布颜色 / 最近使用）入口移到取色球扇形菜单：点色板旁的模式胶囊即可在“色板 / 画布颜色 / 最近使用”之间切换，新使用的颜色立即出现（调色板面板同样支持）", "Canvas/Recent colour sources moved into the colour-orb fan: tap the mode chip beside the ball to switch between Palette / Canvas colours / Recent, and newly used colours appear immediately (the palette panel supports the same)"),
      it("imp", "设置系统重构为声明式注册表（Godot 风格）：所有设置集中声明（点号路径/类型/默认值/范围/分组/依赖显示/刷新策略/自定义读写），设置界面按声明自动生成并分组折叠，新增设置只需加一条声明 + 文案；魔法棒容差等设置现在也会持久化", "Settings rebuilt as a declarative registry (Godot style): every setting is declared once (dotted path / type / default / range / group / visibility / refresh policy / custom accessors), the dialog is generated from that table with collapsible groups, and adding a setting now means adding one declaration plus its strings. Wand tolerance and friends persist properly too"),
    ],
  },
  {
    v: "1.0.4",
    date: "2026-09-08",
    items: [
      it("add", "油漆桶新增“连续/非连续”开关（仅在油漆桶工具时出现在控制栏）：非连续=整层所有同色像素一次填充，连续=只填连通区域", "Paint bucket gains a contiguous / global switch (shown only while the bucket tool is active): global fills every matching pixel in the layer at once, contiguous fills just the connected region"),
      it("add", "图层长按拖拽重排：在时间轴左侧图层行按住约 0.3 秒后上下拖动即可调整图层顺序（一次撤销可还原）", "Layer drag reordering: hold a layer row in the timeline for ~0.3s then drag vertically to reorder layers (a single undo restores it)"),
      it("add", "播放新增循环模式：单次 → 循环 → 来回循环（乒乓）→ 倒流循环，点循环按钮循环切换并提示当前模式", "New playback loop modes: once → loop → ping-pong → reverse; the loop button cycles through them and shows the current mode"),
      it("add", "洋葱皮设置进入设置页：总开关、前/后帧数量（各 0–3）、不透明度、是否着色（前帧红/后帧绿）", "Onion skin settings moved into Settings: master switch, frames before/after (0–3 each), opacity, and optional tint (previous red / next green)"),
      it("add", "选区浮动球新增“反选”按钮（无选区时=全选）", "Selection ball gains an Invert button (inverts an existing selection, selects everything when empty)"),
      it("add", "调色板面板新增“画布颜色 / 最近使用”两种取色模式：可列出当前作品用到的全部颜色，以及最近使用的颜色；最近颜色数量可在设置里调整（4–64）", "Palette panel gains Canvas-colours and Recent modes: every colour used in the artwork, and the most recently used colours; how many to keep is configurable in Settings (4–64)"),
      it("imp", "自动保存更可靠：改用 IndexedDB（大画布不再因 4MB 上限被跳过，旧数据自动迁移），切到后台立即保存，设置页显示上次保存时间并可立即保存 / 清除", "More reliable autosave: now stored in IndexedDB (large canvases are no longer skipped at the 4MB cap, old data migrates automatically), flushed immediately when the app goes to the background, and the Settings screen shows the last save with Save now / Clear buttons"),
      it("imp", "撤销默认步数由 60 提升到 120", "Default undo steps raised from 60 to 120"),
      it("imp", "切换帧现在也会记入撤销/重做（点击帧或上一帧/下一帧可撤销回到之前查看的帧；播放过程中的切帧不会污染记录）", "Frame switching is now part of undo/redo (tapping a frame or prev/next can be undone; playback frame changes never pollute the history)"),
    ],
  },
  {
    v: "1.0.3",
    date: "2026-09-08",
    items: [
      it("add", "对称系统全面升级：单一对称模式 + 可调轴角度（0/45/90/135°）+ 四向对称开关；辅助线可随手势拖动/旋转（像素级吸附），新增锁定按钮（SVG 图标、移到视口边缘防误触），锁定时自动隐藏对称调节芯片", "Symmetry overhaul: one unified mode with adjustable axis angle (0/45/90/135°) and a four-way toggle; dashed guides are draggable/rotatable with pixel-snapped steps, a lock button (SVG glyph) sits at the viewport edge, and the adjust chips hide while locked"),
      it("add", "统一网格辅助线：关/像素格/等距三模式、尺寸可调；等距网格改为真实 30° 斜线", "Unified grid helper: off / pixel grid / isometric with adjustable size; iso now draws true 30° lines"),
      it("add", "快捷手势：画布边距双击=撤销、边距双指双击=重做、画布上三连击=2× 放大；取色时屏幕角落显示像素放大镜（可调倍率、可关闭，仅取色时出现）", "Quick gestures: double-tap the margin = undo, two-finger double-tap the margin = redo, triple-tap the canvas = 2× zoom; a pixel loupe (adjustable magnification, optional) appears while picking colours"),
      it("add", "选区缩放完全复刻 Aseprite：任意比例自由缩放、锚定在对侧手柄、截断最近邻采样，缩放吸附保持像素清晰", "Selection scale replicates Aseprite: free non-integer factor anchored at the opposite handle with truncating nearest-neighbour sampling and pixel-crisp snapping"),
      it("add", "帧预览（全部帧缩略图）改为方形卡片并接入新入口按钮（不透明度旁）；新增独立 SVG 按钮图标", "All-frames preview now shows square frame cards and gets a new entry button beside opacity with its own SVG icon"),
      it("add", "选区/魔法球操作归位：删除选区内容移入“选区球”；魔法球新增清空画布、投影与发光目标可选当前层或新建 shadow 图层", "Selection & Magic Ball cleanup: delete-selection lives in the Selection Ball; Magic Ball gains clear-canvas and drop-shadow/glow target options (current layer or a new shadow layer)"),
      it("add", "浮动球停靠布局持久化：重启应用后已停靠的球保持原位", "Docked floating-ball layout persists across app restarts"),
      it("add", "界面完善：空状态操作提示、缩放百分比 HUD 与“适配视图”按钮、旋转/缩放后保持视口、画布平移始终被钳制在视口内不丢失、边缘自动平移（可开关并限速）", "UI polish: empty-state toasts, zoom % HUD with fit-to-view, viewport kept on resize, pan clamped so the canvas never leaves the view, edge auto-pan (toggleable, speed-capped)"),
      it("add", "四指上滑快速打开“预览所有帧”：四指按住向上滑动即可查看全部帧（期间画布不会移动/缩放）", "Four-finger swipe up opens the all-frames preview (the canvas stays put during the gesture)"),
      it("add", "全应用拦截浏览器长按菜单与文本选择，绘画过程不再误弹系统菜单", "Browser long-press menus and text selection are blocked app-wide so drawing never triggers system menus"),
      it("fix", "撤销/重做快捷手势只在画布外生效：画布内双击不再误触发撤销，三连击放大也不再误撤此前画下的笔划", "Undo/redo shortcuts only fire outside the canvas; in-canvas double-taps and triple-tap zoom never undo earlier strokes"),
      it("fix", "铅笔/橡皮足迹光标不再在画布边缘卡住；对称圆形笔刷奇偶尺寸逐像素一致的真圆，无右侧/底部扁边", "Brush/eraser footprint no longer freezes at the canvas border; symmetric stamps are true circles for every size with no flat chords"),
      it("fix", "投影生成到新图层时会复制当前图层内容作为阴影来源（此前得到空图层）", "Drop-shadow onto a new layer copies the current layer as its shadow source (was blank)"),
      it("fix", "修复帧预览图标 SVG 被错误嵌套进时间轴图标的问题", "Fix the frame-preview icon SVG being accidentally nested inside the timeline icon"),
      it("fix", "四指手势改为“四指按住 + 至少两指滑动”即触发预览：不再要求特定上滑距离/方向，任意方向滑动（每指自落点位移超过抖动阈值）即激活；快速甩动、中途抬指、先滑后回滑都能稳定打开，误触（仅一指动、轻放不动、滑动发生在第四指落下前）被排除，触发前有震动反馈", "Four-finger gesture now opens the preview whenever >=4 fingers are down and at least two of them slide: no upward swipe or distance is required any more — any-direction travel past the jitter threshold (measured per finger from its own touchdown) arms it. Fast flicks, a finger lifting mid-way and slide-then-slide-back all work reliably, while false triggers (only one finger moving, a still touch, sliding only before the 4th finger lands) are rejected, with a haptic tick before the sheet opens"),
      it("imp", "工程整理：web 构建/测试链收进仓库（npm 一键构建），移除已废弃的旧版程序与脚本", "Housekeeping: self-contained npm build & test scripts shipped in-repo; legacy app code removed"),
    ],
  },
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
  // category groups fold away individually (keyed by version + kind)
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const toggleGroup = (key: string) => setFolded((f) => ({ ...f, [key]: !f[key] }));
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
      <div className="dlg clg-dlg" data-guide="dlg-changelog">
        <div className="dlg-head">
          <span>{t("changelog")}</span>
          <div className="grow" />
          <button className="btn small" onClick={onClose}><Icon id="i-x" size={16} /></button>
        </div>
        <div className="dlg-body">
          <TabBar
            className="clg-tabs"
            items={CHANGELOG.map((v) => ({
              id: v.v,
              label: v.v + (v.v === APP_VERSION ? " *" : ""),
              badge: v.date,
            }))}
            value={ver.v}
            onChange={(v) => setVi(Math.max(0, CHANGELOG.findIndex((x) => x.v === v)))}
          />
          <div className="clg-view" key={"v" + ver.v}>
          <div className="clg-title">PixelCraft {ver.v} <span className="clg-date">· {ver.date}{ver.v === APP_VERSION ? " · " + BUILD_TAG : ""}</span>
            {ver.v === APP_VERSION && <span className="clg-curtag">{t("clgCurrent")}</span>}
          </div>
          <div className="clg-list">
            {secs.map(([kind, label]) => {
              const rows = ver.items.filter((x) => x.kind === kind);
              if (!rows.length) return null;
              const gkey = ver.v + ":" + kind;
              const open = !folded[gkey];
              return (
                <div className={"clg-sec" + (open ? "" : " folded")} key={kind}>
                  <button type="button" className={"clg-sec-h " + kind} onClick={() => toggleGroup(gkey)}>
                    <i /><b>{label}</b><span className="clg-sec-n">{rows.length}</span>
                    <span className="clg-sec-chev">▾</span>
                  </button>
                  {open && (
                    <ul className="clg-ul">
                      {rows.map((x, i) => <li key={i}>{langOf() === "zh" ? x.zh : x.en}</li>)}
                    </ul>
                  )}
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
