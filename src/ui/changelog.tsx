// Release notes (更新日志): data + modal. Auto-shown on first launch after an
// update (version marker in localStorage); also reachable from the main menu.
import { useEffect, useMemo, useState } from "react";
import { SESSION } from "./singleton";
import { makeT } from "./i18n";
import type { Lang } from "./i18n";
import { TabBar } from "./tabs";
import { useKitPcMode } from "./kit";
import { Dialog } from "./kit";

/** keep in sync with android/AndroidManifest.xml versionName on every release */
export const APP_VERSION = "1.1.1.8";
/** build stamp shown next to the version (support/debug: identifies the exact
 *  package a user is running when the version number itself does not change) */
export const BUILD_TAG = "f2feadf";

export type ClgKind = "add" | "imp" | "fix";
export interface ClgItem { kind: ClgKind; zh: string; en: string }
export interface ClgVersion { v: string; date: string; items: ClgItem[] }

const it = (kind: ClgKind, zh: string, en: string): ClgItem => ({ kind, zh, en });

export const CHANGELOG: ClgVersion[] = [
  {
    v: "1.1.1.8",
    date: "2026-09-13",
    items: [
      it("add", "色彩明暗（调色板面板的「色彩明暗」或主菜单进入）：给一个基色，一次生成六条色阶。明暗行把温度色、饱和度、明度一起算进去，亮部行只动明度，饱和行只动饱和度，混色行是前景色与背景色之间的过渡，微差行是肉眼难分的近似色，色相行沿色环等距推进。另有互补、三角、四角三种和声配色，按需打开。", "Colour shading (palette panel → Colour shading, or the main menu): from one base colour it generates six ramps at once. Shade moves temperature, saturation and lightness together, Light moves lightness alone, Sat moves saturation alone, Mix runs between the foreground and background colours, Nuance keeps colours nearly identical, and Hue steps evenly around the wheel. Complementary, triadic and tetradic options sit behind a switch."),
      it("add", "色彩明暗的参数：暗部温度与亮部温度（默认 215° 偏冷 / 50° 偏暖，各带一个色块）、强度、亮度峰值、温度权重（0 就是纯明暗不掺色相）、槽位 3–25。槽位居中那一格就是基色本身，填偶数会自动加一。色块轻点设为前景色，长按或电脑右键设为背景色；「加入调色板」把六条色阶去重后追加进当前调色板，算一条撤销。这一版移植自 Aseprite 脚本 Color Shading v5.0。", "The controls: dark and light temperature (215° cool and 50° warm by default, each with its own swatch), intensity, peak, sway (0 means pure light and dark with no hue shift) and 3-25 slots. The middle slot is the base colour itself and an even number of slots is bumped up by one. Tap a swatch to set the foreground colour, hold it (right-click on desktop) for the background, and Add to palette appends the six ramps, de-duplicated, in one undo step. Ported from the Aseprite script Color Shading v5.0."),
      it("imp", "播放速度可以调了：时间轴控制条上循环按钮右边多了一个速度色片，可选 0.25x、0.5x、1x、1.5x、2x，改完立刻生效，重启后还记得。速度不改帧本身的时长，导出的 GIF 与 .aseprite 仍是原来写的时长。", "Playback speed is adjustable: a speed chip sits right of the loop button in the timeline, offering 0.25x, 0.5x, 1x, 1.5x and 2x. A change takes effect right away and is remembered across restarts. Speed never touches the frame durations themselves, so exported GIF and .aseprite files keep the lengths you authored."),
      it("add", "双击枢轴即复位：变换会话里双击那个枢轴标记（锚点），它就放回内容正中，画面一格不动，只改「绕哪里转」。枢轴拖远了不用再一次次点预设把它绕回来。", "Double-tap the pivot to reset it: in a transform session, double-tapping the pivot marker puts it back at the centre of the content without moving a single pixel of the picture — only the point you rotate around changes. No more cycling through presets to bring a dragged-away pivot home."),
      it("fix", "播放速度色片点开没反应：时间轴上面那条控制栏是横向滚动的，下拉列表被它整块裁掉，菜单其实开了、只是看不见。现在下拉列表挂在页面根上、按按钮的位置定位，屏幕内外都不会被裁掉。", "The playback speed chip seemed to do nothing: the timeline's control bar scrolls sideways, and it clipped the dropdown list away entirely — the menu did open, it was just invisible. Dropdown lists now hang off the page root and position themselves against the button, so no scrolling container can clip them."),
      it("imp", "色彩明暗接上色卡：点基色块会打开调色板挑一个新基色（选中的色立刻成为新基色，整组配色重算）；生成出来的色块长按一下就把这一格加进当前色卡（电脑右键仍是设背景色）；每条色阶右边有「+」把整行加进当前色卡、「保存」把整行存成一张新色卡（只加一张新色卡，不动你眼下的色板）。", "Colour shading now works with the palette: tapping a base swatch opens the palette so you can pick a new base colour (the pick becomes the base and the whole set is recomputed); holding a generated swatch adds that one colour to the current palette (right-click on desktop still sets the background); and each row ends with a + that adds the whole row to the current palette and a save button that stores it as a new palette (a new palette only — your current one is left alone)."),
      it("add", "等距图形（魔法球 →「等距图形」）：同一条参数条上选好形状、宽深高与每格像素，画布上就会出现这个等距体的半透明预览，拖四个菱形角抓手改宽深、拖黄色方块调高度、拖整块移动，全部吸附 2:1 栅格，松手才落笔。六种形状是立方体、楼梯、楔形、圆柱、金字塔、空心框，每格可选 4 / 8 / 16 / 32 像素（1×1×1 立方体正好是 4×4 / 8×8 / 16×16 / 32×32 像素）；楼梯级数与方向、楔形坡向、圆柱半径与空心、金字塔平顶、空心框壁厚都在「外观」里。", "Iso shapes (magic ball → Iso shapes): pick a shape, its width, depth, height and the pixels per cell in one bar, and a translucent preview of that isometric solid appears on the canvas. Drag the four diamond corners to resize the footprint, the yellow square to raise it, or the block itself to move it — everything snaps to the 2:1 grid and nothing is committed until you let go. The six shapes are cube, steps, wedge, cylinder, pyramid and frame, at 4 / 8 / 16 / 32 pixels per cell (a 1×1×1 cube is exactly 4×4 / 8×8 / 16×16 / 32×32 px). Steps count and direction, wedge slope, cylinder radius and hollow, pyramid flat top and frame wall thickness all live under Look."),
      it("add", "等距图形的外观与落地：「单色三档」按当前基色自动算顶面亮、右面中、左面暗（强度 / 亮度峰值 / 温度权重可调），也可以选「当前前景色三档」或三面各自指定颜色（点色块打开调色板挑色）；带一圈可关的接触阴影与 1px 描边。参数条实时显示「宽×深×高 · 像素尺寸 · 体素数」，超出画布会标红。「生成」写进当前图层算一条撤销，「生成到新图层」把新建图层和像素合成一条撤销，一次回退干净。", "The look and landing of iso shapes: Three tones derives a bright top, mid right face and dark left face from one base colour (intensity, peak and sway are adjustable); From foreground uses the current foreground colour the same way; Custom faces lets you set all three (tap a chip to pick from the palette). A contact shadow and a 1px outline can be switched off. The bar reads out width×depth×height, the pixel size and the voxel count, and turns red when the shape would leave the canvas. Generate writes into the current layer as one undo step, while To new layer folds the new layer and its pixels into a single undo step."),
      it("fix", "等距图形和网格对不齐：画布上的栅格、足迹虚线和抓手整体比图形偏左半格，看着就像生成的方块没落在网格上（拖动一格有时候也只挪半格）。现在地面原点取的是顶面菱形的顶点，栅格线正好穿过图形的角，吸附也只落在真正的网格节点上。", "Iso shapes sat off the grid: the on-canvas grid, the footprint outline and the drag handles were all half a cell to the left of the shape, so a generated cube looked like it had missed the grid (and dragging by one cell sometimes moved only half of one). The ground origin is now the top vertex of the top face, so the grid lines run through the shape's corners and snapping only ever lands on real grid nodes."),
      it("fix", "等距图形模式开着时不再同时画设置里的 30 度等距参考网格：30 度与 2:1 不可能重合，两套网格叠在一起只会让人以为图形没对齐。这个模式里只有一条跟着图形的 2:1 栅格。", "While iso shape mode is on, the 30° isometric guide grid from the settings is no longer drawn on top: 30° and 2:1 can never line up, and two grids at once only ever looked like the shape had missed the grid. The mode now shows a single 2:1 grid that follows the shape."),
      it("imp", "给新功能各自画了图标，不再和别的功能共用：等距图形是等距方块、颜色分析是柱状统计、色彩明暗是明暗色阶、索引色重映射是两块色卡加箭头、斜切与网格变形、吸附与半格吸附也各有各的图形。以前并排出现的「网格」「去重」「搜索」图标会让人分不清点哪个。", "New features now have icons of their own instead of borrowing other features': an isometric cube for iso shapes, a bar chart for colour analysis, a light-to-dark ramp for colour shading, two swatches and an arrow for indexed remapping, plus separate glyphs for skew, mesh warp, snapping and half-cell snapping. Sharing the old grid, de-duplicate and search glyphs made it impossible to tell the entries apart."),
    ],
  },
  {
    v: "1.1.1.7",
    date: "2026-09-13",
    items: [
      it("fix", "选区自由变换的旋转中心漏算了画布偏移：选区不在画布原点时，拖 90° 只转出 37°，框和全部抓手一起被甩走。现在旋转中心就是画出来的那个枢轴。", "The rotation centre of the selection transform ignored the canvas offset: with the selection away from the origin, a 90° drag turned it by 37° and threw the frame and all the handles off. The centre is now the pivot drawn on screen."),
      it("fix", "缩放的不动点改回对角那个锚点：拖右下角时左上角钉住不动。斜切的基准线改到被拖那条边的对面：拖哪条边哪条边跟手，对面一动不动。以前缩放绕中心两边一起长，斜切各走一半。", "Scaling pivots around the opposite anchor again: drag the bottom-right handle and the top-left corner stays put. Skew is measured from the edge opposite the one you drag, so the dragged edge follows the finger while the far edge stays still. Scaling used to grow from the centre and skew used to split the difference."),
      it("fix", "拖动解算以你抓住的那个图标为参照，不再按手指落点算。触屏命中半径 38px，按偏时图标会一直差着那一段，最多偏出 40px。", "The drag solver measures from the icon you grabbed, not from where your finger landed. With a 38px hit radius an off-centre press used to keep the icon that far from the finger for the whole drag, up to 40px."),
      it("fix", "同一次变换会话里拖第二次，会在上一次的结果上继续，不再把前面的缩放、旋转、斜切抹掉。", "A second drag in the same transform session continues from the previous result instead of wiping the earlier scale, rotation and skew."),
      it("fix", "原地转 90° 以前只有框转了、里面的像素一格没动；进入变换会话的瞬间，16 个抓手也不再整组跳位。", "A plain 90° rotation used to turn the frame while the pixels stayed where they were. The 16 handles also no longer jump as a group the moment a session starts."),
      it("fix", "变形（斜切 / 透视、网格变形）的控制点改成直接落在指针那一点上，拖到哪就是哪；命中半径按相邻点的间距自适应，密网格里也抓得住。按在内容上拖动，整块内容连同控制点一起走。", "Warp control points (skew/perspective and mesh) now land exactly on the pointer, and their hit radius follows the gap between neighbours so dense meshes stay grabbable. Dragging inside the content moves the whole block together with its control points."),
      it("fix", "从「移动 / 缩放 / 旋转」中途切进网格变形，会先把当前画面烘焙进浮动内容，控制点落在眼前这块内容上，不再跳回原位。", "Switching into mesh warp from a move, scale or rotate bakes the current picture into the floating content first, so the control points sit on what you see instead of snapping back."),
      it("fix", "控制点和网格线改成画在图像之上，不再被自己变出来的像素盖住；变形期间视口不再自动平移；选区贴到画布边时，落在画布外的旋转 / 斜切图标以前一按就变成拖动相机、按不到，现在抓手优先。", "Control points and grid lines are drawn above the image instead of under the pixels the warp produces, and the viewport no longer auto-pans during a warp. With a selection against the canvas edge, the rotate and skew icons that fall outside the canvas used to start a camera drag; handles now take priority."),
      it("fix", "高级缩放的对比预览以前两张图都是空的：改成读当前帧所有可见图层压平后的画面（以前只读当前图层，画在别的图层上就是空白），取块对准内容所在的位置（以前固定取区域正中，内容在角落就什么都看不到）。", "Advanced Scale's compare preview used to show two empty frames. It now samples the flattened visible layers of the current frame and takes the patch where the artwork is; it used to read only the current layer, so artwork on another layer showed nothing, and it used to crop the dead centre of the region, so artwork in a corner showed nothing."),
      it("fix", "对比预览取到透明块时给一行提示，预览底也加了透明棋盘格，好分清是「这块是空的」还是「预览坏了」。", "When the compare preview lands on a transparent patch it says so, and the previews sit on a transparency checkerboard so an empty patch is clearly different from a broken one."),
      it("imp", "对比预览从高级缩放的参数表单里挪到单独一屏，点弹窗左下角的对比按钮打开，两张图 128px 并排。调色板等抽屉面板在手机竖屏下改为铺满全屏，横屏与电脑模式仍是右侧抽屉。", "The compare preview moved out of the Advanced Scale form into its own panel, opened from the compare button at the bottom left of the dialog, with the two images 128px side by side. Palette and the other drawer panels now fill the screen on a portrait phone; landscape and desktop keep the right-hand drawer."),
    ],
  },
  {
    v: "1.1.1.6",
    date: "2026-09-13",
    items: [
      it("add", "高级缩放（画布球 →「高级缩放」，也能从「修改尺寸」跳进去）：六种重采样算法，最近邻（默认，保持硬边）、双线性、双三次（Catmull-Rom）、区域平均（缩小时不会像最近邻那样丢细节）、Scale2x 和 Scale3x（像素画专用的整数倍放大，只按规则搬邻居的颜色，不混色，硬边不糊）。", "Advanced Scale (canvas ball → Advanced Scale, also reachable from Resize) offers six resampling algorithms: nearest (default, keeps hard edges), bilinear, bicubic (Catmull-Rom), area average (shrinks without the detail nearest loses), and Scale2x / Scale3x (integer upscalers for pixel art that only move neighbour colours by rule and never blend, so hard edges stay crisp)."),
      it("add", "高级缩放的作用范围可选整个图像、当前图层或选区，三者口径一致，都是把这块内容重采样成你填的宽高。只有「整个图像」会改画布尺寸，图层和选区都按左上角贴回画布内，选区缩放后选区跟着变成新的大小。", "The scope of Advanced Scale can be whole image, current layer or selection, all meaning the same thing: resample that piece to the width and height you type. Only Whole Image changes the canvas size; layer and selection are anchored at the canvas top-left, and a scaled selection grows with its content."),
      it("add", "高级缩放的宽高输入、锁定比例和 2× / 3× / 4× / ÷2 快捷倍率按当前范围的尺寸算；「清理透明像素 RGB」防止透明边缘发黑发彩；原图与缩放后的并排预览会按当前设置真的跑一遍算法。颜色插值一律在预乘 alpha 空间做。", "Advanced Scale's width and height fields, lock ratio and 2× / 3× / 4× / ÷2 shortcuts are based on the size of the current scope. A clean transparent RGB switch keeps transparent edges from going dark or coloured, and the before/after preview really runs the algorithm with your settings. Colour interpolation always happens in premultiplied alpha space."),
      it("add", "算法在当前比例下用不了时会当场提示并说明降级到最近邻，比如选了 Scale2x 却填了非整数倍的尺寸。一次缩放只占一条撤销。", "When an algorithm cannot work at the current ratio it says so and explains the fallback to nearest, for instance Scale2x with a size that is not a whole multiple. One scale is one undo step."),
      it("add", "高级颜色分析器（调色板面板的「颜色分析」或主菜单进入）：按画布（当前帧可见图层）、当前图层、选区、所有帧四种范围，统计每种颜色的像素数与占比，分出不透明、半透明、全透明，给出用到的颜色数。", "Advanced colour analyser (palette panel → Colour Analysis, or the main menu) works on four scopes: canvas (visible layers of the current frame), current layer, selection and all frames. It counts every colour's pixels and share, splits opaque, semi-transparent and fully transparent, and reports how many colours are in use."),
      it("add", "颜色分析里每个颜色都标注在板内、近似板色还是板外，并列出调色板里没用到的颜色；另有色相、饱和度、明度三条直方图。近似色分组把肉眼难分的重复色归成一组（阈值默认 12，可调），一键合并成代表色，代表色取组内像素最多的那个颜色，算一条撤销。", "Every colour in the analyser is tagged in palette, close to a palette entry or outside the palette, and the palette entries that are never used are listed too. Hue, saturation and lightness histograms come with it. Near-colour groups bundle colours the eye cannot tell apart (threshold 12 by default, adjustable) and merge them into one representative colour, the group's most frequent one, in a single undo step."),
      it("add", "颜色分析的颜色替换支持源色、目标色、容差 0–255、范围、只替换不透明像素、保留半透明像素的 alpha、目标色吸附到最近板色，改完提示动了多少像素，可以撤销。每一行还能「设为前景色」或「选中这些像素」，按颜色直接建选区；统计结果可导出 CSV。", "Colour replace in the analyser takes a source colour, a target colour, a tolerance of 0–255, a scope, an opaque-only option, an option to keep the alpha of semi-transparent pixels and an option to snap the target to the nearest palette entry. It reports how many pixels changed and can be undone. Any row can also set the foreground colour or select those pixels, building a selection straight from a colour, and the statistics export to CSV."),
      it("imp", "变形抓手：上一版抓手离选区框太远，又都是同一种图标，既不好瞄准也分不清哪个是缩放、哪个是旋转、哪个是斜切。现在抓手贴着选区框（缩放 6px、旋转和斜切 30px，小选区收窄到 20px），图标固定语义：方块是缩放、圆形箭头是旋转、双向斜线是斜切，和电脑端的双层命中圈一致。", "Transform handles: last build they sat too far from the selection frame and all used the same icon, so they were hard to aim at and impossible to tell apart. They now hug the frame (scale 6px, rotate and skew 30px, narrowing to 20px on small selections) with fixed icons: square for scale, round arrow for rotate, double diagonal for skew, the same meanings as the desktop hit rings."),
      it("fix", "Scale2x / Scale3x 的规则实现有误：旧写法是「上下邻居不同且左右邻居不同就把四格全换成邻居」，孤立像素会整格消失，放大后中心一个像素都不剩。现在按公开规则先判两个邻居是否相等再改那一格，孤立像素长成 2×2（Scale3x 是 3×3）实心块，1 像素宽的线也不长毛刺。", "The Scale2x / Scale3x rules were implemented wrong: the old form replaced all four cells whenever the up and down neighbours differed and the left and right ones differed, which made an isolated pixel vanish, leaving nothing of it after upscaling. The published rules are used now, checking whether two neighbours are equal before changing a cell, so an isolated pixel grows into a solid 2×2 block (3×3 for Scale3x) and a one-pixel line never sprouts burrs."),
      it("fix", "「图层」和「选区」范围的缩放不再改动画布尺寸，以前会把别的图层挤错位；选区缩放也不再出现放大后又缩回原大小的空转。", "Scaling a layer or a selection no longer resizes the canvas, which used to shove the other layers out of alignment, and scaling a selection no longer scales up and then fits straight back."),
    ],
  },
  {
    v: "1.1.1.5",
    date: "2026-09-12",
    items: [
      it("add", "选区自由变换按 Aseprite 那套重做了：八个锚点（四个角加四条边的中点）加一个枢轴点。电脑上锚点带双层同心命中圈，贴着锚点拖是缩放，角上再往外一点是旋转，边中点再往外一点是斜切，整条边沿边方向平移，钳制在 ±85°。", "The selection free transform is rebuilt the Aseprite way: eight anchors (the four corners plus the four edge midpoints) and a pivot. On desktop the anchors use two concentric hit rings: grabbing an anchor scales, a little further out at a corner rotates, a little further out at an edge midpoint skews, sliding the whole edge along itself, clamped to ±85°."),
      it("add", "手机上换成看得见的独立抓手：方块是缩放，圆形箭头是旋转，双向斜线是斜切，命中半径 38px，按间距自动收窄，任意尺寸下都不重叠。另有四个可点的开关代替 Shift/Alt/Ctrl：等比、角度吸附、网格吸附、复制。", "On a phone the handles are visible and separate instead: a square scales, a round arrow rotates, a double diagonal skews, with a 38px hit radius that narrows with spacing so they never overlap at any size. Four tappable switches stand in for Shift/Alt/Ctrl: aspect, angle snap, grid snap and copy."),
      it("add", "枢轴可以拖，也可以选 3×3 预设；缩放后自动跟位，旋转后不动。旋转吸附到像素画干净角（0 / 26.565 / 45 / 63.435 / 90 等，不是 15° 的倍数）。", "The pivot can be dragged or set to any of the 3×3 presets; it follows a scale and stays put on a rotation. Rotation snaps to the pixel-art clean angles (0 / 26.565 / 45 / 63.435 / 90 and so on, not multiples of 15°)."),
      it("add", "只挪位置和 90° 转身走像素精确通道，完全不重采样；一次变换会话只记一条可撤销历史。上一版的四角自由变形与 3×3 网格变形作为额外模式保留。", "Pure moves and 90° turns go through a pixel-exact path with no resampling at all, and one transform session records exactly one undo step. The four-corner free deform and the 3×3 mesh warp from the last build stay available as extra modes."),
      it("fix", "以前在同一会话里连续做缩放、旋转、斜切会重建变换状态，枢轴也跟着丢，现在一条会话能做到底。切工具或换帧时进行中的变换会先落定，浮动内容不再漏出历史。", "Chaining scale, rotate and skew in one session used to rebuild the transform state and lose the pivot; the session now survives all three. Switching tools or frames settles an in-progress transform first, so the floating pixels reach the history instead of being dropped."),
      it("fix", "枢轴不再抢走角上抓手的命中，按得动了。缩放的解算不再混用内容局部坐标和画布坐标，以前镜像永远拖不出负值，抓手也跟着差一截。框、抓手、枢轴的屏幕口径统一，不再各自补半个像素。", "The pivot no longer steals hits from the corner handles, so they can be grabbed. The scale solver no longer mixes content-local and canvas coordinates, which used to keep mirroring from ever going negative and left the handles lagging. The frame, the handles and the pivot share one screen convention instead of each adding its own half-pixel offset."),
      it("fix", "tests/tsconfig.json 里漏掉的 11 个测试文件补了回来。这些测试此前根本没被编译执行，断言总数从 2612 涨到 2924。", "Eleven test files missing from tests/tsconfig.json are restored. They had never been compiled or run, which is why the assertion count went from 2612 to 2924."),
    ],
  },
  {
    v: "1.1.1.4",
    date: "2026-09-12",
    items: [
      it("fix", "变形的控制点现在正好画在像素上。以前画在像素之间的边界线上，看着像卡在半个像素处。口径统一成像素下标，四个角点落在选区四角的那个像素上；拖动里的取整换成连续反解，半格相位不再被吃掉。恒等变换依旧逐字节无损，整块选区一个像素都不丢。", "Warp handles now sit exactly on the pixels. They used to be drawn on the boundaries between pixels, which looked like snapping to half pixels. Coordinates are pixel indices now, so the four handles land on the pixels at the corners of the selection, and dragging uses a continuous inverse mapping that no longer swallows half-pixel phases. An identity warp stays byte-for-byte lossless and never drops a column or row."),
      it("add", "变形控制点支持半像素吸附：控制点可以落在整数像素上，也可以落在两个像素之间的半格（12.5 这种），拖动时会显示一位小数的坐标。选区球「变形」页多了这个开关，默认开半像素，点一下切回整像素；设置里也有对应一项。", "Warp handles can snap to half pixels: a control point can land on a whole pixel or halfway between two pixels (like 12.5), with a one-decimal coordinate shown while dragging. The Transform page of the selection ball gained a switch for it, half-pixel on by default, and tapping it goes back to whole pixels; there is a matching setting."),
      it("imp", "半像素位移不会丢列、不留洞，像素数守恒。位移正好是半格时，结果与整格一致，这是最近邻采样的必然取舍；真正受益的是单点或非整块形变的落点精度与跟手程度。", "A half-pixel move never drops a column, never leaves holes and keeps the pixel count. An exact half-pixel shift matches the whole-pixel result, an unavoidable consequence of nearest-neighbour sampling; what really gains is the landing precision and the feel of single-point or non-block warps."),
    ],
  },
  {
    v: "1.1.1.3",
    date: "2026-09-12",
    items: [
      it("fix", "变形现在覆盖整个选区。上一版的控制点比选区小一圈，结果会漏掉最右或最下一列。口径统一成像素角，四个控制点正好落在选区框的四角，采样按像素区间取整。整条边一起拖时，那一整边都会跟着走。", "A warp now covers the whole selection. The control points from the last build sat one pixel inside it, so the right or bottom row of the artwork was dropped. Everything uses pixel-corner coordinates now, the four handles land exactly on the selection frame, and sampling rounds per pixel interval. Dragging a whole edge moves the whole edge."),
      it("fix", "另修掉两处会让恒等变换丢像素的浮点边界问题：重心权重落在整数边界上会算成 3.9999999996，网格三角形共用对角线时，压线的像素被两边都判成外面。现在恒等变换逐字节无损。", "Two floating-point edge cases that also dropped pixels on an identity warp are fixed: a barycentric weight landing on an integer boundary came out as 3.9999999996, and mesh pixels sitting on a shared triangle diagonal were rejected by both sides. An identity warp is byte-for-byte lossless now."),
      it("imp", "手机上的选区球补齐了全部功能。以前「更多」那一页塞了 10 个按钮，为了不重叠，整圈半径被撑到屏幕外，自由变换、裁切、删除、翻转、扩展收缩、描边这些根本点不到。现在触屏分三页（常用、变形、工具），每页最多 7 项，收起球会回到第一页；电脑端照旧一页铺开。", "The selection ball is complete on a phone now. The old More page packed 10 buttons, and to keep them from overlapping the ring grew past the screen edge, which left free transform, crop, delete, flip, grow/shrink and outline unreachable. Touch now has three pages (Common, Transform, Tools) with at most 7 items each, and closing the ball returns to the first page; desktop still spreads everything out on one page."),
      it("imp", "调色板的 R/G/B 数值改成长按拖动，和底栏的不透明度、笔刷大小同一种操作：按住左右拖，点按按位置设值。它仍然和色轮、HEX、前景色三边同步。", "The R/G/B values in the palette are hold-and-drag now, the same control as opacity and brush size in the bottom bar: hold and slide to change, tap to set by position. They stay in sync with the colour wheel, the HEX field and the foreground colour."),
    ],
  },
  {
    v: "1.1.1.2",
    date: "2026-09-12",
    items: [
      it("fix", "变形模式下，画布上的普通拖动被完全拦住。以前进入变形后，只要手指在画布上一动又没抓住控制点，画面就会突然放大几十倍，控制点与画面脱钩。", "Plain drags on the canvas are swallowed while a warp is active. Before, any drag that did not grab a control point blew the preview up dozens of times and detached the handles from the artwork."),
      it("fix", "松手只是放下这一下，可以接着拖第二个点。以前一松手就自动提交并退出变形模式，控制点消失，完成与还原失效，网格一次只能拖一个点。", "Releasing now ends just that one drag, so you can grab the next point. Before, releasing auto-committed and left the mode: the handles vanished, Done and Revert stopped working, and the mesh allowed only one point per gesture."),
      it("fix", "进入变形不再立刻把图层挖空，改到真正拖动时才动手；没拖过就退出，像素一个字节都不变，也不产生历史。把四角拖成一条线或整体拖出画布时自动还原，不再落一条「清空内容」的历史。", "Entering a warp no longer cuts the layer open; that happens on the first real drag. Leaving without dragging changes zero bytes and records no history. Flattening the quad or dragging it off-canvas restores the pixels instead of recording an emptied step."),
      it("fix", "1 像素宽或高的选区，包括斜线和 1px 直线，会直接拒绝进入变形并给出提示，不再把内容清掉。切工具、切图层、撤销、自动保存、保存工程前都会先把变形落定，不会存出图层被清空的草稿。", "Selections 1px wide or tall, including diagonals and 1px lines, are refused with a message instead of losing their content. Switching tools or layers, undo, autosave and saving all settle the warp first, so a draft can never store a hollowed layer."),
      it("imp", "拖动不再每次整帧重算，不卡了。长按取色不再抢走拖动，选区高亮跟着变形走，历史里这一步显示为「自由变形」。", "Dragging no longer recomposites the whole frame on every move. The long-press colour picker no longer steals the drag, the selection highlight follows the warp, and this step shows up in history as Free transform."),
    ],
  },
  {
    v: "1.1.1.1",
    date: "2026-09-12",
    items: [
      it("add", "选区球「更多」里多了自由变换的入口：斜切/透视和网格变形。斜切/透视直接拖选区的四个角，拖一条边就是斜切，把角往里收就是透视；网格变形拖 3×3 的九个网格点，画面跟着扭。", "The More page of the selection ball has free transform entries now: Skew/perspective and Mesh warp. Skew/perspective drags the four corners of the selection, where sliding an edge skews and pulling a corner in gives perspective; mesh warp drags the nine points of a 3×3 mesh and the artwork bends with them."),
      it("add", "拖动时实时预览，每次都从开始那一刻的原图重算，不会越拖越糊。满意就点「完成」，落成一条可撤销的历史；不想要就点「还原」，原样退回。采样始终是最近邻，拉伸不会留下空洞。", "The preview is live and recomputed from the artwork as it was when you started, so repeated dragging never degrades it. Done applies it as one undoable step; Revert throws it away. Sampling stays nearest-neighbour, so stretching never leaves holes."),
      it("imp", "跟着上一版的反馈修了三处：开着图案笔刷时橡皮不再受图案影响，照常整片擦除，图案只决定上色落在哪些点；动作搜索改成工具球里的一个「搜索动作」小项，浮在主球上方那条去掉了，电脑的 Ctrl+K 不变；调色板的选色区多了 R/G/B 数值输入，和 HSV 色轮、HEX 三边同步，改哪个都行。", "Three fixes and additions from your feedback on the last build. The eraser ignores the pattern brush now and clears as usual, with the pattern only deciding which dots get painted. Action search is a Search actions entry inside the tool ball, the floating pill above the ball is gone, and desktop Ctrl+K is unchanged. The colour area of the palette gained R/G/B number inputs, kept in sync with the HSV wheel and the HEX field."),
    ],
  },
  {
    v: "1.1.1.0",
    date: "2026-09-12",
    items: [
      it("add", "工具球里新增图案笔刷，面板里有 10 个现成图案：棋盘 50%、抖动 12/25/75%、两个方向的斜线、交叉网、方格、散点、砖块。点一下图案就换成图案笔。", "The tool ball has a new Pattern brush entry, with 10 ready-made patterns in its panel: checker 50%, dither 12/25/75%, diagonals in both directions, cross-hatch, grid, dots and brick. One tap switches the brush to the pattern pen."),
      it("add", "选区和整张画布都能存成自己的图案：按内容自动裁边，最大 64×64，随设置一起保存。", "A selection or the whole canvas can be saved as your own pattern. It is trimmed to the content, up to 64x64, and stored with your settings."),
      it("imp", "图案按画布坐标平铺，所以每一笔都接得上；图案上透明的地方不着色；橡皮配上图案后只擦掉图案上的点，等于多了一个抖动橡皮。", "Patterns tile in canvas coordinates, so separate strokes line up. Transparent pixels in a pattern never paint, and an eraser with a pattern rubs out only the pattern dots, which works as a dither eraser."),
      it("add", "魔法球新增内描边：在轮廓内侧画一条线，最外圈的颜色原样保留。线条可以半透明，与底下的像素混合，不会把半透明像素变成不透明。", "The FX ball has a new Inline tool: it draws a line just inside the silhouette and keeps the outer ring exactly as it was. The line can be see-through, blended with the pixels underneath, and a semi-transparent pixel is never forced to opaque."),
      it("add", "魔法球新增圆角化：把轮廓上的硬直角削成圆角，层数可选 1–8 层，也可以同时补内凹角。1px 细线、斜线和折角都不会被啃掉。", "The FX ball has a new Round corners tool: it shaves hard right angles on the silhouette into rounded ones, with 1-8 layers to choose from and an option to fill inner corners too. 1px lines, diagonals and elbows are never eaten."),
      it("imp", "双击工具球就能切回上一个工具：比如从画笔切到橡皮，双击一下就回到画笔，两个工具来回换。", "Double-tap the tool ball to switch back to the previous tool: after moving from the brush to the eraser, a double tap returns to the brush, and the two swap back and forth."),
      it("imp", "把橡皮小项从工具球拖到画布上会临时变成橡皮：手指走到哪擦到哪，松手后当前工具不变，整个动作只记一条撤销。", "Dragging the eraser item out of the tool ball onto the canvas gives you a temporary eraser: it rubs out along the way, your current tool stays as it was, and the whole thing lands as a single undo step."),
      it("imp", "动作搜索可以按名字找到任何按钮：电脑上按 Ctrl+K，手机上是主球上方的一条「搜索动作」。", "Action search finds any button by name: press Ctrl+K on a computer, or use the Search actions pill above the tool ball on a phone."),
      it("imp", "调色板面板新增「从画布生成调色板」：把这张画布上用到的颜色按使用次数收进调色板，用得多的排在前面。", "The palette panel has a new Palette from canvas button, which collects the colours used on this canvas into the palette, with the most used ones first."),
    ],
  },
  {
    v: "1.1.0.0",
    date: "2026-09-12",
    items: [
      it("add", "可以直接打开 .ase 和 .aseprite 文件，RGBA、灰度、索引色都认。图层、帧、帧时长、混合模式、不透明度、链接帧、调色板和动画标签都会还原成工程。", "PixelCraft opens .ase and .aseprite files directly, whether they are RGBA, grayscale or indexed sprites. Layers, frames, frame durations, blend modes, opacities, linked cels, the palette and animation tags all come back as a normal project."),
      it("add", "画布也能导出成 .aseprite：cel 按内容裁剪，用 zlib 压缩，用 Aseprite 打开就能接着画。", "A canvas can be exported back to .aseprite as well, with cels cropped to their content and zlib-compressed, so Aseprite can carry on from there."),
      it("add", "把文件拖进窗口，菜单里的「打开」「导入图片」「导入为图层」都认这种文件；超过 1024×1024 会明确报错，不会偷偷裁掉。", "Dropping the file on the window, Open and both Import entries accept it. Files bigger than 1024x1024 are refused with a clear message instead of being silently cropped."),
      it("add", "动画标签就是 Aseprite 那种给帧区间起的名字：多选几帧后一键加成标签，时间轴上方会出现一条彩色标签条，重叠的标签各占一行，不会互相盖住。", "Animation tags are Aseprite-style names for a range of frames: select a few frames and turn them into a tag with one tap, and a coloured bar appears above the timeline. Overlapping tags each get a row of their own instead of being painted over one another."),
      it("imp", "播放范围跟着标签走：从标签内的任意一帧开始播，只循环这一段；起点不在任何标签里时，播整条时间轴。", "Playback follows the tag it started in: starting on any frame inside a tag loops only that range, while a start outside every tag plays the whole timeline."),
      it("imp", "点标签就直接播它这一段，两个标签重叠时播你点的那个，不会按帧去挑第一个标签；播放中点别的标签的帧，会切到那个动画。", "Tap a tag to play that range. With overlapping tags the one you tapped wins, never whichever tag holds the frame first, and tapping another tag's frame while playing switches to that animation."),
      it("imp", "拖标签条的左右边缘可以直接改范围；右键（手机上长按）打开编辑器，可以改名、换颜色、删除，或者选中这个标签的帧。", "Drag either end of a tag bar to change its range, and right-click (long-press on touch) to open the editor and rename the tag, recolour it, delete it or select its frames."),
      it("imp", "标签会随工程文件和 .aseprite 一起保存，重新打开工程时标签还在，对标签的所有改动都能撤销。", "Tags are saved with the project file and in .aseprite exports, so they are still there when you reopen a project, and every edit to a tag can be undone."),
      it("imp", "时间轴上方的循环按钮按模式换图标：单次、循环、乒乓、倒流各有各的图形，不用再看文字猜现在是哪种模式。", "The loop button above the timeline changes its glyph with the mode: once, loop, ping-pong and reverse each have their own icon, so the current mode is visible without reading the text."),
      it("imp", "导出对话框的帧范围多了一个「标签: 名字」快捷项，一键把导出限定在当前标签。", "The export dialog's frame range gained a 'Tag: name' shortcut that limits the export to the tag you are on."),
      it("add", "新手引导新增一步，演示动画标签怎么用。", "The tour has a new step that demonstrates how animation tags work."),
      it("fix", "修掉一个会让网页版白屏的打包问题：打包时用错 JSX 变换，控制台报 React is not defined。构建脚本现在会自检产物，把打好的包放进一个最小的页面环境里真跑一遍，跑不起来就直接判定构建失败。", "Fixed a packaging bug that turned the web build into a blank page: the bundler picked up the wrong JSX transform and the console reported React is not defined. The build script now smoke-tests its own output by running the bundle in a minimal page environment, and the build fails if it cannot boot."),
      it("fix", "浏览器一直报的 Manifest: Resource size is not correct 也修好了：PWA 图标实际是 96 和 192，而 manifest 里写的是 192 和 512，现在按声明的尺寸重新生成。", "The Manifest: Resource size is not correct warning is gone as well: the PWA icons were 96 and 192 while the manifest promised 192 and 512, so they have been regenerated at the declared sizes."),
    ],
  },
  {
    v: "1.0.9.9",
    date: "2026-09-10",
    items: [
      it("imp", "上下吸附的两张画布挨得更近了：吸住后中间只留 18px，以前是 28px。这块空隙本来留给标题栏，现在标题栏自己让位：上方紧贴另一张画布时收成 16px 高的紧凑一条，按钮和图标同步缩小，所以空隙变小也不会挡住画面；上方空着时仍是大标题栏。", "Stacked canvases sit closer together: a vertical snap now leaves an 18px gap instead of 28px. That space used to be reserved for the title bar, and now the bar gives way instead: with another canvas right above it, it shrinks to a 16px strip with smaller buttons and icons, so the tighter gap never covers either canvas. With nothing above it, the bar keeps its full size."),
      it("imp", "上下吸附的触发距离也收紧了，从 48px 改成 38px；左右吸附仍是 28px，不会离得老远就被吸住。", "The vertical snap range was tightened from 48px to 38px, while side-by-side snapping stays at 28px, so canvases are no longer caught from far away."),
      it("imp", "已经吸在一起的老工程，打开时会自动收拢到 18px 的新空隙。", "Projects whose canvases were already snapped together tighten up to the new 18px gap when they are opened."),
    ],
  },
  {
    v: "1.0.9.8",
    date: "2026-09-10",
    items: [
      it("imp", "「界面定制」的类别栏不再是裸按钮：电脑模式改成左侧竖列，外观和设置面板一致；手机上改成一排可换行的标签，和调色板包、符号面板一样。", "The Customise UI category bar is no longer a row of bare buttons: on desktop it is a left-hand column that looks like the settings panel, and on a phone it is a wrapping row of tags, the same as the palette packs and the symbol panel."),
      it("fix", "也修掉这个弹窗的一个毛病：小方块清单内容多时会被弹窗高度裁掉，还滚不动。现在左右两栏各自滚动。", "That dialog also had a flaw worth fixing: a long tile list was clipped by the dialog height and could not be scrolled. Both columns scroll on their own now."),
      it("imp", "装备槽（快捷圆盘）改成只在电脑模式出现：手机上不再渲染装备槽，设置里的「圆盘尺寸」「圆盘半径」也不再显示，这两项都要靠键盘发动，在手机上只是白占位置。", "The equip slot (quick pie) is desktop-only now: a phone no longer renders the slot, and the pie size and pie radius settings no longer appear there either, since both need a keyboard to fire and were only taking up room."),
      it("fix", "以前装备过的球在手机上照样浮在屏幕上，不会被藏起来；回到电脑模式，装备状态还在。", "A ball that was equipped earlier still floats on screen on a phone instead of disappearing, and the equipment is still there when you return to desktop mode."),
    ],
  },
  {
    v: "1.0.9.7",
    date: "2026-09-10",
    items: [
      it("imp", "色球的扇形不再在手机上占掉半个屏幕：色球尺寸和间距分成两套。电脑模式仍是大尺寸，48px，间距宽，好点；移动模式恢复紧凑，32px，间距更密，最大铺开半径也更小。", "The colour fan no longer eats half the screen on a phone: chip size and spacing are now two separate sets. Desktop keeps the big version, 48px with wide spacing that is easy to tap, while touch goes back to a compact one, 32px with tighter spacing and a smaller maximum spread."),
      it("imp", "「界面定制」面板整个重做：左边是「哪里」，列出布局、顶栏、底栏、五个浮动球和「未使用」；右边是那一处的小方块清单，一个方块一个功能，点一下显示或隐藏，能直接看出这块地方有什么、哪些被藏了。", "The Customise UI panel has been rebuilt. The left side asks where: Layout, Top bar, Bottom bar, the five balls and 'Not in use'. The right side shows that place as a grid of tiles, one tile per action, and tapping a tile shows or hides it, so you can see what lives there and what is hidden."),
      it("imp", "被藏起来的东西全部收进「未使用」，点一下放回原位，不会丢；顺序仍然在界面上直接拖（打开「编辑界面」）。", "Everything hidden is collected under 'Not in use' and can be put back with one tap, so nothing gets lost. Reordering is still done by dragging directly in the UI, with 'Edit UI' turned on."),
    ],
  },
  {
    v: "1.0.9.6",
    date: "2026-09-10",
    items: [
      it("fix", "电脑模式自动判定以前只看媒体查询：部分 Android 浏览器、WebView 和带触控笔的设备会谎报「有鼠标、能悬停」，于是手机上套用了桌面布局，浮动球被放大到桌面尺寸，工具也不再分页。现在判定同时参考真实输入：设备有触摸点，或者你用手指、笔操作过，就按触屏处理；真的收到鼠标事件才切到电脑模式。触屏笔记本插上鼠标后照样会自动切过去。", "Automatic PC mode detection used to look at the media queries only: some Android browsers, WebViews and devices with a stylus claim to have a mouse and to support hover, so a phone got the desktop layout, floating balls were blown up to desktop size and the tools stopped paging. Detection now also uses real input: a device that reports touch points, or that has been used with a finger or a pen, counts as touch, and only an actual mouse event switches PC mode on. A touch-screen laptop still switches over as soon as you move its mouse."),
      it("fix", "在设置里切换电脑模式后，浮动球要等重启才变。现在改完立即生效。如果你之前手动开过电脑模式，可以在设置 → 显示与取色 → 电脑模式里改回「自动」。", "Switching PC mode in Settings used to leave the floating balls unchanged until a restart; the change now applies right away. If you turned PC mode on by hand earlier, set it back to Auto in Settings, under Display & Colour, PC mode."),
    ],
  },
  {
    v: "1.0.9.5",
    date: "2026-09-10",
    items: [
      it("add", "浮动球的功能可以放进工具栏，工具栏的按钮也能放进浮动球：进入「编辑界面」后，把圆环上的子项拖到顶栏或底栏上松手，它就成了那两个栏里的按钮，同时从原球里移除；反过来把工具栏的按钮拖到某个浮动球上松手，它就进了那个球的圆环。两边都能继续排序、隐藏，也可以在「界面定制」面板里各自复位。", "Entries from a floating ball can be moved onto the toolbars, and toolbar buttons onto a ball. In Edit UI mode, drag a ring entry onto the top or bottom bar and release: it becomes a button there and leaves the ball. Drag a toolbar button onto a ball and release: it joins that ball's ring. Both stay reorderable and hideable, and each can be reset from the Customise UI panel."),
      it("add", "存储区和装备槽的位置可以自己摆：编辑界面模式下直接拖动存储区本身或装备槽本身就能移动，位置自动保存，并且始终限制在屏幕内；交互热区跟着实际位置走。「界面定制」里有「存储区/装备槽位置复位」。", "The storage area and the equip slot can be placed where you want: in Edit UI mode, drag the storage area or the equip slot itself to move it. The position is saved automatically and kept on screen, and the drop zone follows the real position. Customise UI has a reset for the storage area and the equip slot."),
      it("fix", "修好了竖屏下看不见装备槽的问题：它以前只在电脑模式渲染，现在竖屏布局里也会显示。", "Fixed the equip slot being invisible in portrait layouts: it used to render in PC mode only, so a phone held upright had no slot at all. It now shows up in portrait as well."),
      it("fix", "编辑界面模式下，画布完全不响应任何操作：在画布上拖动不会再误画一笔，也不会误触发缩放。", "While the UI is in edit mode, the canvas no longer responds at all: dragging across it cannot paint a stroke or trigger a zoom by mistake."),
      it("fix", "点「+」弹出的被隐藏按钮面板改成屏幕正中的浮层；以前它贴在顶栏下方，会被别的面板挡住。", "The hidden-button panel opened by + is now a centred overlay. It used to sit under the top bar, where other panels could cover it."),
      it("fix", "「交换前景/背景色」和「对称」两个按钮换成真正的 SVG 图标；之前用的 ⇄ / ⇋ 字符在部分设备的字体里显示不出来。", "The swap-colours and symmetry buttons now use real SVG icons; the old ⇄ and ⇋ characters came out blank because some device fonts do not include them."),
      it("imp", "界面定制面板改成与设置面板一致的 kit 行样式：分页用 Segmented，开关用 Switch，小按钮用 mini Btn。", "The Customise UI panel now uses the same kit rows as the Settings panel: Segmented for the tabs, Switch for the toggles and mini Btn for the small buttons."),
    ],
  },
  {
    v: "1.0.9.4",
    date: "2026-09-10",
    items: [
      it("imp", "拖动排序更好用了：按住按钮时它会跟着指针走并微微抬起（放大加阴影），越过邻居就换位。", "Dragging a button to reorder works better: it follows the pointer and lifts a little (scaled up with a shadow), and passing a neighbour swaps it into place."),
      it("imp", "直接把按钮拖出工具栏松手就是隐藏，浮动球的子项拖离圆环同理；隐藏后工具栏末尾的 + 会显示隐藏数量，点开就能放回来。", "Drag a button out of the bar and release to hide it; the same works for a floating-ball entry dragged away from its ring. The + at the end of the bar then shows how many entries are hidden, and opening it puts them back."),
      it("imp", "编辑模式下工具栏和快捷圆盘上的按钮带虚线框、× 角标和抬起阴影，浮动球上的隐藏按钮计数和编辑模式的提示条也更清楚。", "In edit mode the toolbar and the quick pie show dashed outlines, × badges and a lifted shadow on their buttons, and the hidden-button count on the floating balls plus the edit-mode hint bar are clearer too."),
      it("imp", "电脑模式下鼠标划过画布时的坐标、颜色读数改成每帧最多更新一次；以前每换一个像素就让整个界面重绘一次，鼠标快速划过时会明显掉帧。", "In PC mode the pixel and colour readout under the mouse now updates at most once per frame; it used to re-render the whole interface for every pixel crossed, which dropped frames when sweeping the mouse quickly."),
    ],
  },
  {
    v: "1.0.9.2",
    date: "2026-09-10",
    items: [
      it("add", "在界面上直接拖动排序：界面定制面板里点「在界面上直接拖动排序」进入编辑模式，顶部会出现提示条，按 Esc 或点「完成」退出。", "Drag to reorder right in the UI: the Customise UI panel has a 'Drag to reorder directly in the UI' button that turns edit mode on. A hint bar appears at the top; Esc or Done leaves edit mode."),
      it("add", "编辑模式下顶栏和底栏的按钮带虚线框和 × 角标：按住就能拖，拖过邻居的中点即实时换位，拖动时不会误触发按钮本身的功能。", "In edit mode the top and bottom bar buttons carry a dashed outline and an × badge: hold and drag, and they swap places live as you pass a neighbour's midpoint. A drag never fires the button's own action."),
      it("add", "点 × 隐藏按钮，点末尾的 + 把隐藏的按钮放回来；浮动球的子项同样可以拖动换位、点 × 隐藏。拖动作用在完整的排序列表上（含隐藏项），所以隐藏项的位置不会被打乱。", "The × hides a button and the + at the end of the bar brings hidden buttons back; floating-ball entries can be dragged around the ring and hidden with their × the same way. Dragging works on the full order list, hidden entries included, so hiding something never shuffles the rest."),
      it("add", "主菜单新增「界面定制」，里面分三页。布局页列出顶栏、底部控制栏、时间轴、浮动球存储区与装备槽、浮动球本体、画布标题栏，逐项可以开或关，也有一键恢复默认。", "The main menu has a new Customise UI panel with three pages. Layout lists the top bar, the bottom bar, the timeline, the ball storage area and equip slot, the floating balls themselves and the canvas title bars; each item can be switched on or off, and there is a one-click reset."),
      it("add", "工具栏页里顶栏与底栏的按钮可以上下调顺序、单独隐藏，隐藏的按钮随时能放回来。浮动球页里五个球分别列出全部子项，同样可调顺序与显隐。", "On the Toolbar page the top and bottom bar buttons can be reordered and hidden one by one, and a hidden button can always be brought back. On the Floating balls page each of the five balls lists all of its entries, with the same reorder and show/hide controls."),
      it("imp", "界面定制的改动立即生效并自动保存，随设置一起持久化。就算把某个按钮藏了，它的功能仍然能从别处用到，快捷键、浮动球、快捷圆盘都还在。", "Customise UI changes apply instantly and save automatically with the rest of the settings. Hiding a button never removes the feature: it stays reachable from the shortcuts, the floating balls or the quick pie."),
    ],
  },
  {
    v: "1.0.9.1",
    date: "2026-09-10",
    items: [
      it("add", "快捷键可以自己改了：用 Ctrl+F1 或主菜单里的「快捷键一览」打开面板，每一行的按键都是一个按钮，点它再按下新的组合键即可，立刻生效并自动记住。", "Shortcuts can be rebound: open the cheat sheet with Ctrl+F1 or from the main menu. Every row's chord is a button; click it and press the combination you want, and it applies at once and is remembered."),
      it("add", "改键时按 Esc 取消，按 Backspace/Delete 把这一项恢复默认，面板顶部还有「全部恢复默认」。", "Esc cancels a rebind, Backspace/Delete restores that one entry to its default, and the top of the panel has a button that resets every shortcut."),
      it("add", "如果新组合键已经被别的功能占用，面板会直接告诉你是被谁占了，例如「这个组合键已被占用：保存工程」。连「按住 F 发动快捷圆盘」的发动键也能改。", "If the chord you press is already taken, the panel names the action that owns it, for example: this shortcut is already used by Save Project. Even the quick-pie launch key, hold F, can be changed."),
      it("fix", "重画了一批图标，之前有几处图形重复或名不副实：播放和「下一帧」以前是同一个三角形，现在播放是纯三角、下一帧带一条竖线；横向平铺和纵向平铺以前也完全一样，现在一个向右排、一个向下排。", "A batch of icons was redrawn, because a few were duplicated or misleading. Play and Next frame used to be the same triangle; play is now a plain triangle and Next frame has a bar. Row tiling and column tiling were the same picture; one now repeats to the right and the other downwards."),
      it("add", "另外给这些动作各自画了专属图标：画布调整模式是四边把手，扩展/收缩选区是虚线选区加朝外、朝内箭头，索引色模式是固定色块加勾。", "Purpose-built glyphs were added as well: edge handles for resize mode, a dashed marquee with outward and inward arrows for grow/shrink selection, and fixed swatches plus a check for indexed colour mode."),
      it("add", "粘贴为新图层、粘贴为新画布用图层或画布加输入箭头，裁切到选区用裁切标记加虚线选区。", "Paste as layer and Paste as canvas use a layer or a canvas with an input arrow, and Crop to selection uses crop marks plus a dashed marquee."),
      it("fix", "快捷键一览里补上了漏写的 Ctrl+S（保存），并把 Ctrl+←/→、Ctrl+↑/↓ 和 +/- 各自拆成两行，让每个动作都能单独改键。", "The cheat sheet also gained the missing Ctrl+S (Save) row, and Ctrl+Left/Right, Ctrl+Up/Down and +/- were split into separate rows so each action can be rebound on its own."),
    ],
  },
  {
    v: "1.0.9.0",
    date: "2026-09-10",
    items: [
      it("add", "电脑模式新增「快捷圆盘」，做法类似 Blender 的快速圆盘。浮动球存储区下方多了一个装备槽，把一个浮动球拖进去就装备好了，只能装一个；拖着别的球再放进去会替换，被换下的球回到屏幕上；点一下槽可以把球取出来。", "PC mode has a quick pie, in the spirit of Blender's. An equip slot now sits below the floating-ball storage area: drag a floating ball onto it to equip it. Only one fits; dropping another swaps it, and the replaced ball returns to the screen. Click the slot to take the ball back out."),
      it("add", "按住发动键 F 时，这个球的全部子项以圆环铺在屏幕正中，鼠标指针隐藏；鼠标往哪个方向移就聚焦哪一项，中心一圈是死区。松开 F 激活该项，在中间松手或按 Esc 取消。", "Hold the launch key F and that ball's entries spread as a ring in the middle of the screen with the cursor hidden. Pointing in a direction focuses that entry; the middle is a dead zone. Releasing F runs the focused entry, while releasing in the middle or pressing Esc cancels."),
      it("add", "装备调色板球时，圆盘里显示的是颜色球，停在哪个颜色上松手，就把哪个颜色设为前景色。", "When the ball you equipped is the palette ball, the pie shows colour swatches instead of entries; releasing over one sets that colour as the foreground colour."),
      it("add", "快捷圆盘的大小可以自己调。设置 → 显示与取色里多了两项：「快捷圆盘子球大小」（36–96px，默认 58）和「快捷圆盘半径」，半径填 0 就按屏幕大小和子球数量自动适配（推荐），也可以填固定像素值。圆环会保证子球之间不重叠，也不超出屏幕。", "The quick pie size is adjustable. Settings → Display & Colour has two new settings: 'Quick pie entry size' (36-96px, 58 by default) and 'Quick pie radius'. A radius of 0 fits the screen size and the entry count automatically (recommended); any other value is a fixed pixel distance. The ring keeps the entries from overlapping and from going off the screen."),
      it("add", "新增 Ctrl+滚轮改笔刷大小：一格滚轮一步，和调值一样按格累计，浏览器把一格拆成几十个事件也不会一下飞掉。", "Ctrl+wheel changes the brush size: one notch is one step, accumulated the same way as value scrubbing, so a notch the browser splits into dozens of events still moves by one."),
    ],
  },
  {
    v: "1.0.8.11",
    date: "2026-09-10",
    items: [
      it("imp", "快捷圆盘的子球放大到 58px，图标跟着变大。圆环会按子球数量自动撑大，工具球有二十多个子球时也不会互相压住，整圈都在屏幕内。另外新增 Ctrl+滚轮改笔刷大小：一格滚轮一步，和调值一样按格累计，浏览器把一格拆成几十个事件也不会飞掉。", "Quick pie entries grew to 58px, icons included. The ring widens automatically with the number of entries, so a 24-entry tool pie does not overlap itself and the whole ring stays on screen. Ctrl+wheel changes the brush size as well: one notch is one step, accumulated the same way as value scrubbing, so a notch the browser splits into dozens of events still moves by one."),
      it("add", "电脑模式新增快捷圆盘，类似 Blender 的快速圆盘。浮动球存储区边上多了一个装备槽，把一个浮动球拖进去就装备好了；一次只能装一个，拖着别的球再放进去会替换，被换下的球回到屏幕上，点一下槽就把球取出。", "PC mode has a quick pie, similar to Blender's. The floating orb storage area has an equip slot beside it: drag a floating orb onto the slot to equip it. Only one at a time; drop another orb in and it replaces the current one, which goes back on screen, and clicking the slot takes the orb out."),
      it("add", "按住 F 键，装备槽里那个球的全部子项会以圆环铺在屏幕正中间，鼠标指针自动隐藏。鼠标往哪个方向移就聚焦哪一项，中心一圈是死区；松开 F 激活那一项，在中间松手或按 Esc 则什么都不做。装备的是取色球时，圆盘里显示的是颜色球，松手就把该颜色设为前景色。", "Hold the F key and every entry of the equipped orb spreads out as a ring in the middle of the screen with the mouse cursor hidden. Moving the mouse towards an entry focuses it, and the centre is a dead zone; releasing F runs the focused entry, while releasing in the middle or pressing Esc does nothing. Equip the colour orb and the pie shows colour balls instead: releasing sets that colour as the foreground."),
    ],
  },
  {
    v: "1.0.8.10",
    date: "2026-09-10",
    items: [
      it("imp", "把色球拖到画布上做油漆桶填充之后，取色球不再自动收起来：可以换个颜色接着填，想收起来点一下取色球本身，电脑上按 Esc 也行。轻点色球仍然是取色并收起，两条路互不影响。", "The palette fan no longer closes itself after you drag a colour ball onto the canvas to bucket-fill: you can keep filling with other colours. Tapping the colour orb itself puts it away, and Esc does the same on a computer. Tapping a colour ball still picks the colour and closes the fan, so the two gestures do not get in each other's way."),
      it("fix", "修掉导出时报的「Invalid code/color length, must be power of 2 and 2..256」：GIF 调色板以前按图里出现过的颜色数来定长度，而 GIF 规范要求长度必须是 2 的幂（2/4/8/…/256），所以只有 1、3、5、7… 种颜色的图一导出就报这个错。现在会自动补齐到下一个 2 的幂，多出来的位置填黑色，透明色下标不变，1 种到 256 种颜色都能正常导出。", "Fixed the export error 'Invalid code/color length, must be power of 2 and 2..256'. The GIF palette used to be sized by the number of colours in the artwork, but the format requires a power-of-two palette length (2/4/8/.../256), so any image with 1, 3, 5, 7... colours failed on export. The palette is now padded to the next power of two: the extra slots are filled with black and the transparent index does not change, so 1 to 256 colours all export."),
      it("fix", "新增的端到端测试用真正的 GIF 编码器和解码器跑 1/2/3/5/7/9/200 色与透明像素；缺少补齐这一步时，这些用例会直接复现上面那条报错。", "A new end-to-end test runs the real GIF encoder and decoder over 1/2/3/5/7/9/200 colours plus transparency; without the padding step those cases reproduce the error above."),
    ],
  },
  {
    v: "1.0.8.9",
    date: "2026-09-10",
    items: [
      it("fix", "修掉「把选区拖到另一张画布上松手后，只看到选区框、内容是空的，随便点一下就又出现了」：松手时只更新了界面状态，像素合成没有跟着重建；会动的选区虚线自己会重画，所以框出现了、内容还停在旧画面上。现在松手就完整重绘，内容立即出现在目标画布上。新增的回归测试会在缺少这一步重绘时直接失败。", "Fixed the case where dropping a selection onto another canvas showed the marquee but no pixels until you clicked somewhere. The drop only updated the UI state and never rebuilt the pixel composite; the animated marquee redraws itself, so the box appeared while the content stayed on a stale image. The composite is rebuilt the moment you release, so the content is on the target canvas right away. A new regression test fails if that redraw step is missing."),
    ],
  },
  {
    v: "1.0.8.8",
    date: "2026-09-10",
    items: [
      it("fix", "修掉导出里那个差点让整套流程跑不动的问题：GIF 导出时每个像素都要把整条调色板扫一遍，256×256 的八帧动画就是一亿次比较，实测光这一步 480 ms；开 8 倍放大后像素上亿，标签页或手机直接卡死。调色板查找表现在改成洪水填充式的全量覆盖，每个像素只查一次，同样的动画 42 ms 就导完。", "Fixed the bug in the export path that nearly paralysed everything: GIF export scanned the whole palette for every pixel, so a 256x256 eight-frame animation meant 100 million comparisons (480 ms in that step alone), and at 8x zoom that becomes hundreds of millions of pixels, which drags a tab or a phone to a halt. The palette lookup is now a flood-filled table covering the whole colour cube: each pixel costs one lookup and the same animation encodes in 42 ms."),
      it("imp", "导出加了预算闸门：单张超过 4096×4096 或动画总像素超限时，直接给出中英提示，不会再去申请一个上亿像素的画布。导出弹窗里实时显示这次的输出尺寸，超限标红。", "Export has a budget gate: a single image over 4096x4096, or an animation over the total pixel cap, gets a message in both languages instead of allocating a canvas with hundreds of millions of pixels. The export dialog shows the output size live and turns it red when it is over budget."),
      it("imp", "导出过程中按钮变成「正在导出…」并禁用；导出失败会说明原因，以前失败是静默的，点了没反应；分图层导出要写超过 12 个文件时先确认一次，不会一下弹出几十个保存框。", "While an export runs the button reads 'Exporting...' and is disabled. A failed export says why; failures used to be silent, so tapping seemed to do nothing. Exporting per layer asks first when it would write more than 12 files, instead of firing dozens of save dialogs at once."),
      it("imp", "导出更好找了：主菜单里新增「导出当前画布…」。选区球新增「裁切画布到选区」，一键把画布缩到选区的外接矩形，一条历史可撤销。", "Export is easier to find: the main menu has 'Export this canvas...'. The selection orb gained 'Crop canvas to selection', which shrinks the canvas to the selection bounds in one undoable step."),
      it("add", "新增画布调整模式，画布球里可以开关，快捷键是 Ctrl+R。打开后画布四条边和四个角出现把手，直接拖就能改画布大小，拖动时实时显示新尺寸，松手才记一条历史。拖哪条边，对面那条边固定不动，内容不会被拉伸。", "New resize mode, toggled from the canvas orb or with Ctrl+R. Handles appear on the four edges and corners of the canvas; dragging one changes the canvas size with a live size readout, and the change is recorded as one history step on release. The opposite edge stays put, so the content is never stretched."),
      it("imp", "跨画布拖动选区不再卡：浮动内容缓存成一张离屏图，拖动时只做一次贴图；以前每个不透明像素都要单独画一次，全画布选区一秒就是几十万次绘制。有跨画布落点时，原位那份会被裁在源画布内，内容不再糊在两张画布之间的空白上。", "Dragging a selection across canvases no longer stutters: the floating content is cached as one offscreen image and blitted in a single call. It used to draw every opaque pixel on its own, which is hundreds of thousands of draws per second for a full-canvas selection. While a cross-canvas drop is targeted, the original copy is clipped inside its own canvas, so it no longer smears over the gap between canvases."),
      it("fix", "几处细节修复：选区、套索、魔棒和轮廓填充工具在画布外的空白处按住拖动也能平移视图，和画笔工具一致；锁定的浮动球不再被其他球挤走，电脑上拖动某个球也不会把别人收起来；手机端选区球分成两页（常用和更多），电脑模式仍然一次全部铺开。", "Smaller fixes: with the marquee, lasso, wand or outline tool, holding and dragging on the empty area outside the artwork pans the view, the same as the brush tools; a locked floating orb is no longer shoved aside by the others, and dragging one on a computer no longer closes the rest; on a phone the selection orb is split into two pages (common actions plus a More page), while PC mode still lays everything out at once."),
    ],
  },
  {
    v: "1.0.8.7",
    date: "2026-09-10",
    items: [
      it("fix", "修好 Ctrl+V 粘贴不生效的问题：从系统剪贴板读到的图片以前被当成普通数据，粘贴时报错又被吞掉。现在一律转成真正的图像数据，失败也会给出提示。", "Ctrl+V pasting is fixed. An image read from the system clipboard was treated as plain data, so the paste threw and the error was swallowed. It is now converted into real image data, and a failure says so."),
      it("fix", "鼠标滚轮调值不再一跳到底（从 1 直接跳到 64）：一格滚轮只走一步，不管浏览器把它拆成多少个事件。手机上的数字框长按滑动也按同样的速度换算，轻轻一滑不会飞走。", "The mouse wheel no longer slams a value from 1 straight to 64. One notch is one step, no matter how many events the browser splits it into, and drag-to-scrub on number fields uses the same rate, so a light flick no longer flies across the field."),
      it("fix", "浏览器自己的手势现在都拦掉了：右键按住再滑动、双指横滑前进后退、触控板的橡皮筋回弹。弹窗和列表该滚还是能滚。", "The browser's own gestures are swallowed now: right-button drag, the two-finger sideways swipe (back/forward), and trackpad rubber-banding. Dialogs and lists still scroll normally."),
      it("add", "电脑模式的键盘与鼠标又补了几个：按住空格临时用背景色画，松开回到前景色；按 X 或点调色区按钮交换前景与背景；按住 Alt 指针立刻变成吸管。", "A few more keys and mouse actions in PC mode: hold Space to paint with the background colour and release to go back to the foreground, press X or tap the colour chip to swap the two, and hold Alt to turn the cursor into an eyedropper."),
      it("add", "电脑模式的文件与粘贴快捷键：Ctrl+O 打开、Ctrl+N 新建画布、Ctrl+E 导出、Ctrl+Shift+V 粘成新图层、Ctrl+Alt+V 粘成新画布（手机端这两项是选区球里的两个子球）。Ctrl+F1 打开快捷键一览，键盘和鼠标两套词汇都在里面，主菜单里也有入口。", "File and paste shortcuts in PC mode: Ctrl+O opens, Ctrl+N makes a new canvas, Ctrl+E exports, Ctrl+Shift+V pastes as a new layer and Ctrl+Alt+V as a new canvas (on a phone those two live in the selection orb). Ctrl+F1 opens the shortcut sheet, which lists both the keyboard and the mouse vocabulary, and the main menu has an entry too."),
      it("imp", "平移不再占用空格：改成在画布外的空白处按住左键拖动，或者用方向键。", "Panning no longer uses Space: drag with the left button on the blank area outside the artwork, or use the arrow keys."),
      it("imp", "列表和画布按鼠标习惯重做：帧和图层按住就能拖动排序，不用再等 300ms 长按；双击图层名或画布标题直接改名；右键点某一帧打开帧设置；单张画布也显示画布标题栏。", "Lists and canvases now behave like a desktop app: frames and layers drag to reorder the moment you press, with no 300ms hold; double-clicking a layer name or the canvas title renames it; right-clicking a frame opens its settings; and a single canvas shows its title bar."),
      it("imp", "多选和删除也按鼠标习惯走：Shift+左键选中从上次选中的帧到这一帧之间的所有帧；Del 键删除你最后点的地方，选区内容、选中的帧、当前图层或选中的画布标题都算，删画布依旧弹确认；帧多选时 Ctrl+V 把剪贴板内容一次粘到每一帧。", "Selection and Delete follow the mouse too: Shift+click picks every frame between the last picked one and this one, Delete removes whatever you last touched, whether that is selection pixels, picked frames, the current layer or the selected canvas title, and closing a canvas still asks first, while Ctrl+V pastes onto every picked frame at once."),
      it("imp", "电脑模式下多个浮动球可以同时展开，展开后不再挡住画布上的任何操作，按 Esc 收球；画布球一次铺开全部动作，不用翻页。", "In PC mode several floating orbs can be open at once, an open ring no longer blocks anything on the canvas, and Esc closes them. The canvas orb lays out every action at once instead of paging."),
      it("imp", "浮动球和色板继续按鼠标优化：色板颜色球改成和别的子球一样大，手机上也一样，排布和避让按新尺寸重算；电脑模式下选区球不再重复放复制、剪切、粘贴三个按钮，快捷键已经覆盖了。", "More mouse-friendly orbs and swatches: palette swatches are now the same size as the other ring items, on the phone too, with the packing and clearance recomputed for the new size. In PC mode the selection orb drops its copy/cut/paste buttons, since the shortcuts cover them."),
      it("imp", "把选区内容拖到另一张画布上时，拖动过程中就能看到落点：内容以半透明幽灵画在目标位置，目标画布描一圈虚线，松手即落笔。", "Dragging a selection onto another canvas shows the landing spot while you drag: the content is drawn as a translucent ghost at the target position with a dashed outline around that canvas, and releasing drops it there."),
    ],
  },
  {
    v: "1.0.8.6",
    date: "2026-09-10",
    items: [
      it("add", "选区可以直接搬到别的画布上：把选区内容拖起来，鼠标和手指都一样，拖到另一张画布上松手，像素就搬过去了。源画布留下空洞并记一条历史，目标画布自动聚焦、落点按边缘裁剪，目标图层锁定时整个动作作废并把像素放回。", "A selection can be moved onto another canvas: pick up the selection content, with a mouse or a finger, and release it over a different canvas to move the pixels there. The source keeps the hole with one history step, the target canvas is focused, the dropped corner is clipped at the canvas edge, and a locked target layer aborts the whole move and puts the pixels back."),
      it("add", "配套的键盘操作也补齐了：Ctrl+X 剪切、Ctrl+V 粘贴，可以先在画布 1 剪切，切到画布 2 再粘贴。", "The matching keyboard actions are there too: Ctrl+X cuts and Ctrl+V pastes, so you can cut on canvas 1, switch to canvas 2 and paste."),
      it("imp", "电脑模式下带第二页的浮动球不再翻页：工具球和选区球一次把全部选项铺开，展开后的排布重新算过，任何数量都不会互相压住。", "Orbs with a second page stop paging in PC mode: the tools orb and the selection orb lay out every option at once, and the expanded layout is recomputed so no amount of entries overlap."),
      it("imp", "浮动球在电脑模式下的其余问题：主球、选区、取色、魔法、画布五个球都补上了展开锁定；鼠标划得再快也不会中途脱离拖动；鼠标扫过菜单时横向纵向滚动条抽搐的问题也修好了，按钮同时加上悬停反馈。", "The rest of the PC orb fixes: all five orbs, main, selection, palette, magic and canvas, now have their expand-lock; dragging a ball fast no longer loses the drag; the horizontal/vertical scrollbar twitch when the mouse sweeps across a menu is gone, and buttons have hover feedback."),
      it("add", "电脑模式再补几个键位：Ctrl+左右切换前后帧、Ctrl+上下切换图层、Alt+单击某个像素立刻取色。", "A few more desktop keys: Ctrl+Left/Right switches frames, Ctrl+Up/Down switches layers, and Alt+click picks the colour under the pixel."),
      it("add", "按住空格不动就交换前景和背景色，鼠标一动就恢复正常，空格+左键拖动依旧是平移。", "Holding Space without moving the mouse swaps the foreground and background colours; move the mouse and Space goes back to being the pan modifier, so holding it and dragging with the left button still pans."),
      it("add", "鼠标中键点画布会聚焦并适配那张画布，不再用于平移；右键用背景色绘制，也不再弹出浏览器右键菜单。", "The middle button now focuses and fits the canvas under it instead of panning, and the right button paints with the background colour without triggering the browser context menu."),
      it("add", "鼠标滚轮也能调值了：悬停在按住拖动的按钮或数字输入框上，直接滚滚轮就能增减数值，不用先按住再拖。", "The mouse wheel adjusts values now: hover a hold-to-drag button or a number field and scroll to change the value, with no press-and-drag."),
      it("imp", "设置界面在电脑模式下改成左右布局：搜索框仍在最上方，左边选类别、右边调该项设置。更新日志也改成左边竖排版本列表，点哪版看哪版。", "Settings switch to a two-column desktop layout: search stays on top, categories on the left and the settings of the selected one on the right. The changelog lists versions vertically on the left, with the release notes of the version you pick on the right."),
      it("imp", "「预览所有帧」面板在电脑模式下加宽到屏幕的 60%，内容自动换行铺满，不再挤成一条。", "The all-frames preview panel now takes 60% of the screen in PC mode, with content flowing and wrapping instead of squeezing into a strip."),
    ],
  },
  {
    v: "1.0.8.5",
    date: "2026-09-10",
    items: [
      it("add", "新增「电脑模式」：用鼠标打开时自动启用，也可以在设置的显示与取色里强制开或关。关掉或没有鼠标时行为和以前完全一致。", "New PC mode: it turns on automatically when a mouse is present, and can be forced on or off in Settings, under Display & Colour. With the mode off, or without a mouse, everything behaves as before."),
      it("add", "电脑模式开启后的桌面操作：滚轮以光标为中心缩放、Shift+滚轮左右移动、Alt+滚轮上下移动、中键拖动或空格+左键拖动平移画布、右键用另一个颜色槽绘制，默认就是背景色。", "What PC mode brings: wheel zoom centred on the cursor, Shift+wheel to pan sideways, Alt+wheel to pan vertically, middle-drag or Space+left-drag to pan the canvas, and right-click to paint with the other colour slot, the background colour by default."),
      it("add", "鼠标悬停在控件上立刻显示说明气泡，0ms 响应、跟着光标走、移开即消失，不用再长按；光标也随工具变化：画笔是十字、取色器是吸管、平移是抓手、图层锁定时是禁止符号。", "Hovering a control shows its tooltip at once, with 0ms delay, following the cursor and gone the moment you leave, so no long press is needed. The cursor reflects the tool too: a crosshair for drawing, an eyedropper for the picker, a hand while panning and a no-entry sign on a locked layer."),
      it("add", "鼠标悬停在画布上时，右下角显示当前像素坐标、颜色方块与十六进制色值，笔刷落点框也一直跟着光标。", "Hovering the canvas shows the current pixel coordinates with a colour swatch and hex value in the bottom-right corner, and the brush footprint keeps tracking the cursor."),
      it("add", "电脑模式的键盘快捷键：Ctrl+Z 与 Ctrl+Shift+Z 撤销重做、Ctrl+S 保存、Ctrl+C 与 Ctrl+V 复制粘贴、Delete 删除选区内容、Esc 取消选区、+ - 0 缩放与适配、Tab 隐藏界面专注画画。", "Keyboard shortcuts in PC mode: Ctrl+Z and Ctrl+Shift+Z undo and redo, Ctrl+S saves, Ctrl+C and Ctrl+V copy and paste, Delete clears the selection, Esc drops it, + - 0 zoom and fit, and Tab hides the interface to concentrate on the artwork."),
      it("add", "方向键平移选区框，按住 Shift 一次 10 像素；字母键切换工具，B 铅笔、E 橡皮、G 油漆桶、I 取色、L 直线、R 矩形、O 椭圆、M 选区、W 魔棒、Q 套索。在输入框里只响应 Ctrl 组合，不会打断打字。", "Arrow keys nudge the selection frame, 10 pixels at a time with Shift held, and letter keys pick tools: B pencil, E eraser, G bucket, I picker, L line, R rectangle, O ellipse, M marquee, W wand, Q lasso. Inside a text field only the Ctrl combinations fire, so typing is never interrupted."),
      it("add", "把文件直接拖进窗口就能打开，.pxc 工程、PNG、GIF 都行，拖动时窗口有虚线高亮；Ctrl+V 把系统剪贴板里的图片粘贴成新内容，Ctrl+C 把选区写进系统剪贴板。", "Dropping a file anywhere on the window opens it, whether a .pxc project, a PNG or a GIF, with a dashed highlight while you drag. Ctrl+V pastes an image from the system clipboard as new content, and Ctrl+C writes the selection into it."),
      it("imp", "电脑模式下浮动球整体放大到 1.2 倍，环形菜单排得更开，更容易点到。展开时右上角多一把小锁（只在展开时显示），锁定后点画布或切换别的球都不会把它收起来，再点一次解锁。", "In PC mode the floating orb scales to 1.2x and its ring spreads wider, so it is easier to hit. While the ring is open a small padlock appears in its corner; once locked, tapping the canvas or switching to another orb no longer closes it, and tapping the lock again releases it."),
      it("imp", "电脑模式下浮动球按钮的可点区域放大到 40px，字号加 1，行距更松。长按取色、双击画布适配、三击缩放这些触屏手势在电脑模式下不再触发，改用滚轮和快捷键。", "In PC mode the orb buttons get 40px tap targets, the font goes up one step and the line height loosens. The touch gestures (long-press picking, double-tap to fit, triple-tap zoom) no longer fire; the wheel and the keyboard take over."),
      it("imp", "网页版默认压缩：Web 包从约 1.2MB 降到约 730KB，GitHub Pages 走 gzip 后约 180KB。正式站点上关掉了调试遥测（只在本地 devserver 上报），浏览器控制台里不再出现无效请求。", "The web build is minified by default: the bundle drops from about 1.2MB to about 730KB, around 180KB over the wire once GitHub Pages gzips it. Debug telemetry is off on the deployed site and only reports to a local dev server, so the browser console no longer shows failed requests."),
    ],
  },
  {
    v: "1.0.8.4",
    date: "2026-09-10",
    items: [
      it("add", "取色球扇形里的颜色小球可以直接拖到画布上填色：拖到画布松手，就用这个颜色对落点做一次油漆桶填充，跟手有一颗同色小球。填充规则和正常点击完全相同：相似色容差、填充缝隙、索引色吸附、平铺环绕、选区裁剪、引用图层重定向都生效，只记一条历史。拖到旁边另一张画布上也能填，会自动切换到那张画布。原地松手仍是原来那样取色并关闭扇形。", "Colour balls can be dragged straight onto the canvas: hold one in the palette fan, drag it over the artwork and release to bucket-fill that spot with it, with a same-coloured ball following your finger. The fill uses exactly the same rules as a normal tap: similar-colour tolerance, gap closing, indexed-colour snapping, tiled wrap, selection clipping and reference-layer redirect all apply, and it lands as a single history step. Dropping it on another canvas fills there and focuses that canvas. Releasing in place still picks the colour and closes the fan, as before."),
      it("add", "底部工具栏的颜色块也支持同一个手势：按住后直接拖走＝快速填充，按住不动＝原来的快捷调色盘，轻点＝打开调色板。三种手势互不干扰：手指移动超过阈值或离开颜色块之后，快捷调色盘不再呼出，这次拖动就当填充。", "The toolbar colour chip supports the same gesture: press and drag away to fill, press and hold for the quick colour wheel, tap to open the palette. The three never fight: once the finger moves past the threshold or leaves the chip, the wheel is not summoned and that drag becomes a fill."),
      it("fix", "上下叠放吸附时多留 20px：两张画布上下吸附后，下面那张的标题栏刚好落在加宽后的空隙里，既不压住上面那张画布，也不压住自己的画面。左右并排的空隙仍是 8px，可在设置 → 画布与网格里调整。", "Stacked canvases keep 20px more: after snapping one canvas above another, the lower canvas' title bar sits exactly in the wider gap, covering neither the canvas above nor its own artwork. Side-by-side snapping still keeps the configured gap (8px by default, adjustable in Settings → Canvas & Grid)."),
      it("add", "在浏览器里打开（网页或已安装的 PWA）时，顶部工具栏末尾会多一个全屏按钮，可以进入和退出全屏。软件版（APK）由系统栏自动隐藏，不需要这个按钮，所以不显示。", "Opened in a browser (web page or installed PWA), the toolbar gains a fullscreen toggle at the end so you can enter and leave fullscreen right there. The app build hides the system bars itself, so it needs no button and shows none."),
    ],
  },
  {
    v: "1.0.8.2",
    date: "2026-09-10",
    items: [
      it("fix", "引导（新手教程）以前会被其它浮层盖住：样式表里有一行残缺的选择器吃掉了引导层的整条规则，引导层因此没有定位与层级，弹窗、浮动球、提示气泡、Toast 都能压在它上面。现在引导层提到应用最上层，高于确认框、长按提示、Toast、过程回放，聚光灯和说明卡片不会再被挡住。", "The onboarding tour used to be covered by other overlays: a stray selector fragment in the stylesheet swallowed the whole guide-layer rule, so the layer had no positioning or stacking order and dialogs, floating balls, tooltips and toasts could all paint over it. The tour layer now sits at the top of the app, above confirm prompts, long-press tooltips, toasts and replay, so neither the spotlight nor the card gets covered."),
      it("fix", "聚光灯高亮框里的控件现在点得到：引导层自身不再拦截触摸，只由遮罩（没有高亮框的步骤）和说明卡片接管，需要你自己动手的那几步可以直接按被高亮的按钮。以前高亮框那一层会把点按吃掉。", "Controls inside the spotlight can really be tapped now: the tour layer itself no longer captures touches, only the backdrop (for steps without a highlight) and the card do, so the steps that ask you to try something yourself work directly on the highlighted button. The highlight used to swallow the tap."),
      it("fix", "安装新版本时更新日志和引导不再打架：更新日志先显示，等你关掉它引导才开始；全新安装仍然先等第一张画布出现，再开始引导。以前两层同时弹出，引导把更新日志挡住，既看不了也关不掉。", "Installing a new version no longer makes the release notes and the tour fight: the notes show first and the tour starts once you close them, while a fresh install still waits for the first canvas to appear. Both used to appear at once and the tour covered the notes, so they could be neither read nor dismissed."),
      it("fix", "引导进行中按返回键会直接退出引导，而不是先去点被引导遮住的弹窗（那个弹窗本来就点不到）。", "Pressing back while the tour is running now leaves the tour instead of clicking a dialog hidden behind it, which could not be reached anyway."),
    ],
  },
  {
    v: "1.0.8.1",
    date: "2026-09-10",
    items: [
      it("add", "新增浅色主题：设置 → 显示与取色 → 界面主题可在深色和浅色之间切换，立即生效并随设置保存。整套配色改由设计令牌驱动，共 141 个令牌（尺寸、主题色、固定色），浅色主题覆盖其中 76 个。画布工作区在浅色下是中性灰，保证像素画的对比度。浮动球、环形菜单、停靠条、模式胶囊、长按浮标、缩放指示、颜色指示、对称提示和画布标题栏都跟随主题；只有预览窗和参考图窗的底，以及引导遮罩保持深色。", "New light theme: Settings → Display & Colour → UI theme switches between Dark and Light, applied at once and stored with the settings. The palette now runs on design tokens, 141 in total (sizes, theme colours, fixed colours), and the light theme overrides 76 of them. The canvas workspace turns neutral grey so artwork keeps its contrast. The floating orb, radial menus, dock, mode chips, hold popups, zoom HUD, colour indicator, symmetry chips and canvas title bars all follow the theme; only the preview and reference-image backgrounds and the tour shade stay dark."),
      it("add", "新增 UI 控件库 src/ui/kit，包含弹窗外壳 Dialog 和表单控件 Row、RowActions、ChipGroup、Segmented、Switch、NumberField、ColorField。Dialog 有遮罩、标题、关闭钮、正文、页脚，支持额外插槽与自定义类名，并带 role=dialog、aria-modal 和 Esc 关闭。全项目 18 处手写弹窗、17 处表单标签、8 组选项胶囊、1 组分段切换、9 处行内按钮都改成了这些组件，样式与行为只有一处实现。", "New UI kit in src/ui/kit: the Dialog shell plus the form controls Row, RowActions, ChipGroup, Segmented, Switch, NumberField and ColorField. Dialog has a backdrop, title, close button, body and footer, takes extra slots and custom class names, and carries role=dialog, aria-modal and Escape-to-close. All 18 hand-written dialogs, 17 form labels, 8 chip groups, 1 segmented switch and 9 inline action rows across the app now use them, so every style and behaviour has one implementation."),
      it("imp", "设置的开关项由 ON / OFF 小胶囊换成真正的开关。设置项、弹窗和面板的配色全部改为引用令牌，外壳里不再有写死的颜色，主题切换不会有漏掉的地方。", "Boolean settings switched from an ON / OFF chip to a proper toggle. Settings rows, dialogs and panels now paint from tokens instead of hard-coded colours, so a theme switch leaves nothing behind."),
      it("add", "新增 UI 规范文档 docs/UI.md：令牌表、控件 DOM 契约、迁移清单与测试约定都写在里面。另加一个开发用的控件库演示页，跑 npm run demo 后打开 /ui-demo.html，一屏能看完全部控件与色板，还能现场切换主题。", "New UI specification in docs/UI.md: token tables, component DOM contracts, the migration list and the testing rules. There is also a developer demo page: run npm run demo, open /ui-demo.html and see every control and swatch on one screen, with a live theme switch."),
      it("add", "UI 自检新增 61 条自动断言：组件渲染契约（弹窗结构、开关 aria、选项组选中态）、令牌契约（浅色主题必须覆盖所有主题令牌、外壳禁止写死颜色），以及控件库不得依赖 Session。", "The UI self-checks gained 61 new assertions: component render contracts (dialog structure, switch aria, selected options), token contracts (the light theme must override every theme token and the shell may not hard-code colours), and the kit's independence from Session."),
      it("fix", "修复一个一直被引用却从未定义的 CSS 变量 --fg：菜单按钮、设置搜索框与小图标按钮的颜色以前实际来自继承。现在明确用正文色，行为与视觉不变，只是不再依赖巧合。", "Fixed a CSS variable that was referenced but never defined, --fg: menu buttons, the settings search field and small icon buttons were silently inheriting their colour. They now name the body text colour explicitly, so the behaviour no longer relies on coincidence."),
    ],
  },
  {
    v: "1.0.8.0",
    date: "2026-09-09",
    items: [
      it("add", "预览窗口新增灰度预览：一键把画面转成灰度，用来检查明暗关系与对比度。只转画面，底色保持不变。", "The preview box gained a greyscale mode: one tap turns the artwork greyscale to check values and contrast. Only the artwork goes grey; the backdrop keeps its colour."),
      it("imp", "预览窗口右上角的按钮改成二级菜单：展开后有白底、黑底、格子底与灰度预览四个选项，当前底色和灰度状态都会高亮。以前这个按钮只能循环切换底色。", "The button in the top-right of the preview box now opens a menu with four options: white, black, checker backdrop and greyscale preview, with the active backdrop and greyscale state highlighted. It used to only cycle the backdrop."),
      it("imp", "设置 → 显示与取色里新增「灰度预览」开关，与预览底色并列，状态随设置一起持久化。", "Settings → Display & Colour gained a Greyscale preview switch next to the preview backdrop; its state persists with the rest of the settings."),
      it("fix", "修复增量渲染的一个严重 bug：整幅画面变脏时（描边、灰度这类特效，选区的填充、剪切、粘贴、移动、反选）只重绘不重合成，画布停在旧画面，预览窗口却已经更新。现在只要整幅变脏就必定重新合成。选区框与套索拖动也改成只重绘叠加层，不再每帧整幅重合成。", "Fixed a serious incremental rendering bug: when the whole canvas went dirty (FX such as edge and greyscale, or selection fill, cut, paste, move and invert) the view redrew without recompositing, so the canvas kept the old pixels while the preview box was already up to date. A full dirty now always rebuilds the composite. Selection and lasso drags also redraw only the overlay instead of recompositing the whole frame every time."),
      it("add", "新增「轮廓填充」工具：像套索一样手绘一个闭合形状，松手后自动把内部填成当前色，比套索加填充快一步。绘制过程中有虚线路径和半透明填充预览，支持对称镜像与选区裁剪，整笔只记一步历史。", "New Outline fill tool: draw a closed freehand shape like a lasso and it fills with the current colour on release, one step instead of lasso plus fill. While drawing you see the dashed path and a translucent fill preview; symmetry mirroring and selection clipping both apply, and the whole gesture is one history step."),
      it("add", "新增双指长按手势：两指按住不动即触发，默认执行「切换到下一图层」，可在设置 → 手势与触控里改成任意动作。切到的图层会在画布上闪一下：白色轮廓淡出加边框脉冲，空图层只闪边框。", "New two-finger long-press gesture: hold two fingers still to fire it. It defaults to Next layer and can be re-mapped to any action in Settings → Gestures & Touch. The layer you switch to flashes on the canvas: a white silhouette fades out with a border pulse, and an empty layer flashes its border only."),
      it("add", "新增「三指长按」手势，默认同样是切换图层。部分机型（vivo、OPPO 等）把双指长按映射成系统「识屏」，三指长按不会跟它冲突。双指长按的说明里也写明了系统设置路径，真被系统抢走时会提示一次怎么处理。", "New three-finger long-press gesture, also defaulting to Next layer. Some phones (vivo, OPPO and others) map the two-finger long press to their system screen recognition, while three fingers do not clash with it. The two-finger entry now names the system setting too, and a one-off hint explains what to do if the OS grabs it."),
      it("add", "手势动作新增「切换到下一图层」和「上一图层」：循环切换，优先跳过隐藏图层；在设置 → 手势与触控里可以绑到任意手势。", "New gesture actions Next layer and Previous layer: they cycle the stack and skip hidden layers when possible. Bind them to any gesture in Settings → Gestures & Touch."),
      it("add", "新增平铺画布（设置 → 画布与网格 → 平铺画布）：中心画布四周显示 3×3 的副本，只有中心可以编辑，画无缝瓦片或背景时能直接看到接缝。有「平铺重复」与「镜像平铺」两种拼法，中心格用蓝色描边标出。", "New tiled canvas (Settings → Canvas & Grid → Tiled canvas): a 3x3 set of copies around the centre canvas where only the centre is editable, so the seams are visible while painting seamless tiles or backgrounds. Two layouts, plain repeat and mirrored repeat, with a blue outline marking the centre tile."),
      it("imp", "画布不再是一个文件：画布球里的「保存」和「关闭并保存」已经移除，换成「关闭画布」，只是把它从当前工程里移除。顶部工具栏恢复保存按钮，它保存的是整个工程，含所有画布以及每张画布的位置、帧、图层选择和操作记录。工程仍然是自动保存的。", "A canvas is no longer a file: the canvas orb's Save and Close & save entries are gone, replaced by Close canvas, which just removes it from the current project. The toolbar has the Save button back, and it writes the whole project: every canvas with its position, frames, layer selection and history. The project keeps autosaving as well."),
      it("fix", "修复在引用画布上绘画没有实时预览的 bug（笔、图形、橡皮擦）：引用层不再在合成时去取源画布的画面，而是把源画布的画面镜像进引用层自己的像素，每帧共用一份，源画布变了才重新镜像。这样它的渲染路径和普通图层完全一样，画的过程中就跟着手指走。", "Fixed the missing live preview when painting on a reference layer (pencil, shapes, eraser): instead of resolving the source canvas while compositing, the reference layer now mirrors the source picture into its own pixels, one shared cel per layer, re-mirrored only when the source changes. Its render path is the same as a normal layer, so it follows the finger while you paint."),
      it("add", "双击画布（不只是标题）也能快速聚焦并适配到那张画布：双击任意一张画布的画面即可切过去并缩放到适配大小，双击当前画布则只做适配。如果你把「画布内双击」映射成了别的功能，仍然执行你的映射。", "Double-tapping a canvas body, not just its title, now focuses that canvas and zooms it to fit: double-tap any canvas' artwork to switch to it and fit it on screen. Double-tapping the current canvas only fits it, and a user mapping of 'double tap on canvas' still wins."),
      it("add", "解除吸附也有动画反馈：点标题栏右侧的解除按钮时，两张画布之间那道连接会变成红色半透明，向两边扩散并淡出（约 0.5 秒），同时震一下，明确表示连接已经断开。", "Releasing a snap now animates too: tapping the un-snap button turns the connection between the two canvases into a red translucent link that spreads outwards and fades away (~0.5s), with a haptic tick, so it is clear the link is gone."),
      it("imp", "引用画布改为按图层引用：引用一张画布时，源画布的每个图层各生成一条引用图层，顺序和图层名都沿用，每条精确绑定到源画布对应的那条图层。在引用层上画就改到源画布那一条，不再猜是哪个图层。源画布那条图层被隐藏时，引用层照样显示内容，在引用画布这边可以单独开关；被锁定时会明确提示「源画布里的该图层已锁定」，不再默默没反应。", "Reference canvas now imports per layer: referencing a canvas creates one live reference layer for every layer of the source, in the same order and with the same names, each bound to that exact source layer. Painting on a reference layer edits precisely that layer instead of guessing which one. A hidden source layer still shows in the holder, where it can be toggled on its own, and a locked one says 'that layer is locked in the source canvas' instead of silently doing nothing."),
      it("add", "引用弹窗顶部新增「按图层引用 / 合并为一条」切换。选「合并为一条」时仍然只引用合成后的整张画面，编辑落在源画布当前选中的图层；旧工程里的单层引用也按这个方式继续工作。", "The reference dialog gained a Per layer / Flattened switch at the top. Flattened still mirrors the whole composited canvas in one layer, with edits landing in the source's selected layer, and single-layer references saved by older builds keep working that way."),
      it("add", "画布球 → 更多里新增「解除全部引用」：一次把当前画布上所有引用层烘焙成普通图层，记一步历史，可以撤销。图层面板上引用层的提示会写清它来自哪张画布、哪个图层；图层 id 与引用绑定关系随工程保存，重新打开工程后依然有效。", "The canvas orb's More page gained Release all refs, which bakes every reference layer of the current canvas into normal layers at once as one undoable step. The layer tooltip names the source canvas and layer, and layer ids plus the binding are saved with the project, so they survive a reload."),
      it("imp", "主菜单里的「新建画布」改成「新建工程」：会关闭当前所有画布并清空操作记录，先弹一次未保存确认，然后回到一张全新的画布。想在同一工程里再开一张画布，用画布球里的「新建画布」。", "The main menu item New canvas is now New project: it closes every open canvas and clears the undo history after one unsaved-work prompt, then starts from a fresh canvas. To add another canvas to the same project, use New canvas in the canvas orb."),
      it("fix", "修复撤销重做时引用图层慢一拍：以前先重合成画面、再同步引用层的镜像，源画布已经变回去了，当前画布上的引用层还显示旧内容，要等下一次重绘才对。现在顺序反过来，先同步镜像再合成，镜像真的变化时立即让视图重绘。", "Fixed reference layers lagging one step behind on undo/redo: the view composited before the mirrors were re-synced, so the source canvas had already reverted while the reference layer still showed the old pixels until the next repaint. The mirrors are now synced first, and a mirror that really changed invalidates the view immediately."),
      it("fix", "修复把小画布引用到大画布里、引用图层画不上去的问题：引用层的画面是居中放在当前画布里的，但笔迹一直按当前画布的坐标直接写进源画布，源画布更小的时候，画的点几乎全落在源画布外面，或者错位一格，看起来就像引用图层无法编辑。现在笔迹、油漆桶、渐变、形状、轮廓填充与选区遮罩都会先按居中偏移换算，画哪儿就改源画布的哪儿，再原样镜像回来。", "Fixed referencing a small canvas into a big one and finding the reference layer impossible to paint: the mirror is centred inside the current canvas, but strokes wrote into the source canvas using this canvas' coordinates, so with a smaller source most pixels landed outside it, or were offset by the centring, and it looked like the reference layer was not editable. Strokes, the bucket, gradients, shapes, outline fill and the selection mask are now translated by that centring offset, so painting edits exactly the source pixel under the finger and mirrors straight back."),
      it("add", "像素完美笔画：手绘时自动去掉 L 形拐角多余的那一个像素（Aseprite 的 pixel-perfect 规则），斜线和曲线不再出现台阶上的双像素；底栏铅笔和橡皮旁有开关，默认值在设置 → 工具里改。", "Pixel-perfect strokes: freehand drawing drops the extra pixel of an L-shaped corner (Aseprite's pixel-perfect rule), so diagonals and curves no longer double up on the staircase. A toggle sits next to the brush tip in the bottom bar and the default lives under Settings → Tools."),
      it("add", "油漆桶新增「相似色」容差：逐通道 0–255，抗锯齿边缘一次填满。", "The fill bucket gained a Similar colour tolerance: per channel 0-255, fills anti-aliased edges in one go."),
      it("add", "油漆桶新增「填充缝隙」：填色前把边界上小于指定宽度的缺口临时封住，线稿有断口也不漏色。", "The fill bucket gained Fill gaps: gaps in the boundary narrower than the chosen width are sealed before filling, so a broken outline does not leak."),
      it("add", "底栏多了相似色开关和两个长按拖动按钮，设置 → 工具里注册了默认值与总开关。", "The bottom bar gained the similar-colour toggle plus two hold-and-drag buttons, and Settings → Tools registers their defaults and master switch."),
      it("add", "平铺模式下笔迹会环绕补画：画到边缘的像素同时出现在对面，一笔就能画出接缝对得上的无缝瓦片；画笔、橡皮、喷枪、形状、油漆桶、轮廓填充都支持。", "In tiled mode strokes wrap around the canvas: pixels drawn past an edge appear on the opposite side, so one stroke produces a seam-matching seamless tile. Brush, eraser, airbrush, shapes, bucket and outline fill all follow."),
      it("add", "画布球 → 更多 → 「旋转画布 90°」把这张画布的像素整体顺时针转 90°：宽高互换，选区跟着转，可撤销。", "Canvas ball → More → Rotate canvas 90 turns this canvas' pixels 90 degrees clockwise: width and height swap, the selection rotates with it, and the step is undoable."),
      it("imp", "自动保存改成按间隔保存：默认每 5 分钟写一次，设置 → 数据里可调 1–60 分钟，不再是每次改动都写；切到后台或离开页面时仍会立即补存一次。", "Autosave now runs on an interval: once every 5 minutes by default, adjustable to 1-60 minutes under Settings → Data, instead of writing on every change. Hiding the app or leaving the page still saves once immediately."),
      it("imp", "自动保存的内容改成纯 JSON 数据，像素用 RLE 编码，不再内嵌 PNG 图片，体积更小、恢复更快。", "The autosave payload is now pure JSON data with pixels RLE-encoded and no embedded PNG images, so it is smaller and restores faster."),
      it("imp", "性能：像素变化和界面状态变化分开处理，切工具、拖笔刷大小或不透明度、选颜色、改设置不再让引用画布重新镜像，也不再把其他画布的合成缓存判为过期，拖参数时更顺。", "Performance: pixel changes and UI-only changes are handled separately, so switching tools, dragging brush size or opacity, picking colours or changing a setting no longer re-mirrors reference canvases or invalidates the other canvases' composite caches. Sliders feel smoother while dragging."),
      it("add", "索引色模式：调色板面板里的开关，开启后画上去的像素自动吸附到调色板里最接近的颜色（不透明度仍按画笔），画布始终保持调色板配色。", "Indexed colour mode: a switch in the palette panel. While it is on, painted pixels snap to the nearest palette colour (brush opacity still applies), so the artwork always stays inside the palette."),
      it("add", "调色板面板的「映射到调色板」可以把已有画面一次性换成调色板颜色，一条历史可撤销。", "The palette panel's Map to palette action converts existing artwork to palette colours in one undoable step."),
      it("add", "形状工具组新增多点折线与曲线工具：点一下加一个点，拖动时显示橡皮筋预览，点最后一个点结束并合成一条历史，点倒数第二个点可撤掉最后一个点；曲线用平滑样条穿过所有点。", "New multi-point polyline and curve tools in the shape group: tap to add a point, drag for a rubber-band preview, tap the last point to finish as one history step, and tap the point before it to remove it. The curve tool runs a smooth spline through every point."),
      it("add", "关闭的画布可以撤销找回：关闭画布会记成一条普通历史步（历史面板里显示为「关闭画布」），撤销后它回到空间里的原位置并重新聚焦，位置、尺寸、锁定状态、吸附组、图层和帧选择、预览框一并恢复；重做会再把它关掉。", "A closed canvas can be brought back with undo: closing a canvas is recorded as an ordinary history step (shown as Close canvas in the history panel), and undoing it returns the canvas to its original spot in the space and focuses it again, with its position, size, lock, snap group, layer and frame selection and preview window restored. Redo closes it once more."),
      it("imp", "这条撤销一直有效到打开或新建工程为止：工程文件里不会包含已经关闭的画布，重新打开工程后它就真的不在了。", "That undo stays available until you open or start another project: a project file never contains a canvas you closed, so after reopening the project it really is gone."),
      it("imp", "把最后一张画布也关掉、停在空白工程界面时，顶部工具栏的撤销和重做仍然可用；以前它们是灰的，关掉最后一张就再也救不回来。", "Undo and redo in the toolbar now stay live on the empty-project screen after the last canvas was closed. They used to be greyed out, so closing the last canvas was a dead end."),
      it("imp", "历史记录改成整个工程共用一条：不再按画布分开保存，撤销和重做按全局顺序作用到对应的画布，切画布不再改变撤销栈。", "History is now one shared stack for the whole project instead of one per canvas: undo and redo walk the global order and apply to the canvas each step belongs to, so switching canvases no longer changes the stack."),
      it("imp", "「过程回放」也改成全局回放，一次把所有画布的操作按顺序播完；关闭某张画布也是一步，可以撤销找回（见上一条）；工程文件里只存一条历史，每一步记录它属于哪张画布，旧版本按画布分开保存的历史在打开时按画布顺序合并。", "Replay is global too: every canvas' operations play back in one sequence. Closing a canvas is itself an undoable step (see the entry above), and the project file stores a single history where each step names its canvas. Projects saved by older builds with per-canvas histories are merged in canvas order on load."),
      it("imp", "全量核对并修整图标，不同功能不再共用同一个图标：选区反选、反色、色板去重原本都用一个图标，现在分别是「半选方块」「反色方块」「重叠方块减去」；删除选区不再用裁剪图标，清空画布不再用居中图标，选区描边改用描边图标，画布位置锁定改用图钉（与图层锁区分）", "Full icon audit so different features no longer share one icon: invert selection, invert colours and palette de-dupe used to be the same glyph and are now half-filled square, inverted square and overlapping squares minus. Deleting a selection no longer uses the crop icon, clearing the canvas no longer uses the centre icon, selection outline uses the outline icon and canvas position lock a pushpin (distinct from the layer lock)"),
      it("imp", "剪切改用剪刀，粘贴用剪贴板，重命名用钢笔，提取图层用「方框飞出」，引用画布用「两张画布连线」，解除吸附和解除引用用断链图标。", "Cut now uses scissors, paste a clipboard, rename a pen, extract a layer a box flying out, reference a canvas two linked frames, and un-snap or release reference a broken chain."),
      it("imp", "帧时长用时钟，更新日志用喇叭，引导重放用问号，参考图用图片，精灵表用表格，帧多选用带勾选的帧格，平铺横竖用排列图标，预览按钮用预览窗图标。", "Frame duration uses a clock, changelog a megaphone, tour replay a question mark, reference image a picture, sprite sheet a table, frame multi-select frames with ticks, horizontal and vertical tiling arrangement icons, and the preview button a preview-window icon."),
      it("imp", "主菜单按钮改成三横线（不再是齿轮），停靠区的主球显示当前工具图标而不是永远铅笔，并删掉 9 个没人用的图标（实心椭圆、适配、退出全屏、等距特效、描边2、手形、放大、缩小、画笔）", "The main menu button is now a hamburger instead of a gear and the docked main ball shows the active tool instead of always a pencil; 9 unused icons were deleted (filled ellipse, fit, exit-fullscreen, iso effect, edge-2, hand, zoom in and out, paint)"),
      it("add", "设置 → 画布与网格新增一组画布吸附参数：吸附总开关、吸附判定范围（4–48 屏幕像素）、吸附后留白（0–48 画布像素）、吸附进入颜色、吸附离开颜色，后四项在总开关关闭时自动隐藏。", "Settings → Canvas & Grid gained a set of canvas-snap parameters: the master switch, the snap range (4-48 screen px), the gap left after snapping (0-48 canvas px), the snap-in colour and the snap-out colour. The last four hide themselves while snapping is off."),
      it("add", "这些颜色用新的颜色选择器设置，并随设置文件导入导出。", "These colours use a new colour picker control and travel with the settings file."),
      it("imp", "吸附反馈支持多个区域同时满足：拖动时所有满足吸附条件的空隙一起亮绿，不再是一个亮了另一个就消失；每新进入一个区域各闪一次并震动。", "Snap feedback now handles several zones at once: every gap that satisfies the snap criteria lights up green together instead of one replacing another, and each newly entered zone flashes once with a haptic tick."),
      it("imp", "把某张画布拉出范围时只有那道空隙闪红消失，其余继续保持；以前离开范围的红闪因为离开后量不到空隙而根本没画出来，现在在离开瞬间把矩形快照下来，红闪正常显示。", "Pulling one canvas away fades only that gap out in red while the others stay lit. The leaving flash used to be invisible because the gap could no longer be measured after moving away; the rect is now snapshotted at the moment it is left, so the red flash shows."),
      it("imp", "画布在屏幕上比标题栏还窄时，标题栏只显示画布名称，并保持相对画布居中。", "When a canvas is narrower on screen than its title bar, the bar shows only the canvas name and stays centred on the canvas."),
      it("fix", "拖动画布时相机跟着画布跑的手感：相机锚定在聚焦画布上，以前拖动聚焦画布时画布在屏幕上不动、整个空间从它下面滑走；现在拖动聚焦画布或它所在的组会同步平移视口，画布跟着手指走、周围画布保持不动；拖动非聚焦画布时相机仍然不动。", "The camera no longer follows the canvas when you drag: the view is anchored on the focused canvas, so dragging that canvas used to keep it glued to the screen while the whole space slid underneath. Moving the focused canvas (or its group) now pans the view by the same amount, so the canvas follows your finger and the neighbours stay put. Dragging a canvas that is not focused still leaves the camera alone."),
      it("imp", "吸附改为留空隙：吸附后的两张画布之间固定留 8px 空档，不再贴在一起。空档用半透明绿色标出来，方便看出哪些画布是一组。", "Snapping now leaves a gap: two snapped canvases keep 8px of empty space between them instead of sitting flush. That space is tinted semi-transparent green so a group is easy to spot."),
      it("fix", "修复画布标题栏拖动不灵敏：上一版加了标题栏按钮，按在画布名字或图标上不会开始拖动，只有按到空白处才行。现在只要不是按在按钮上都能拖；拖动判定阈值也从 6px 降到 4px。", "Fixed the sluggish canvas title-bar drag: after the title-bar buttons were added, pressing the canvas name or its icons did not start a drag, only the empty part did. Now anything except the buttons starts it, and the movement threshold dropped from 6px to 4px."),
      it("imp", "标题栏左侧的眼睛改成开关：点一下给这张画布开预览框，再点一下关掉，打开时眼睛有高亮状态。标题栏不再显示画布尺寸。", "The eye at the left of a title bar is now a toggle: tap to open that canvas preview window, tap again to close it, and the eye stays highlighted while it is open. The title bar no longer shows the canvas size."),
      it("add", "画布吸附：把一张画布拖到另一张旁边会自动对齐边缘吸附，松手后两张成为一组，之后拖动其中任意一张都整组一起走。标题栏右侧出现「解除吸附」按钮，可以把一张单独解出来，其余仍成组。吸附关系随工程保存。", "Canvas snapping: drag a canvas next to another one and it aligns edge to edge; on release the two become a group, and dragging either one moves them together. An un-snap button appears at the right of the title bar to release one canvas, while the rest stay grouped. The grouping is saved with the project."),
      it("add", "画布球新增「锁定画布位置」与「解锁画布位置」：锁定后这张画布的标题栏拖不动，点按聚焦、双击适配照常，标题栏上显示锁图标；锁定状态随工程保存。", "The canvas orb gained Lock canvas position and Unlock canvas position: a locked canvas can no longer be dragged by its title bar, while tap to focus and double-tap to fit still work, and a lock glyph shows in the title. The state is saved with the project."),
      it("imp", "画布球精简：去掉「适配画布」，双击标题就能做同一件事；去掉「预览」，预览按钮移到每条画布标题栏的左侧，点一下就给这张画布开一个预览框。", "Leaner canvas orb: Fit is gone, since double-tapping a title does the same thing. Preview is gone too, moved to the left of every canvas title bar, where one tap opens that canvas preview window."),
      it("add", "被引用画布自己的选区现在会显示在引用它的那条图层上：淡紫色底加紫色虚线框，位置与该画布的镜像一致，两张画布尺寸不同时按居中偏移对齐。它只是那张画布的选区的显示，不会变成当前画布自己的选区，所以不会裁剪你在当前画布上的绘画。", "A reference canvas' own selection is now shown on the layer that mirrors it: a light violet tint plus a violet dashed border, aligned with the mirrored pixels, centred when the two sizes differ. It only displays that canvas' selection, it does not become this canvas' own selection, so it never clips what you paint here."),
      it("fix", "修复引用图层上的非笔迹修改不会同步到源画布的问题：选区填充、选区移动、旋转缩放、特效等直接写在镜像上，随后被源画布覆盖回来。现在每次同步前会对比镜像，把被直接改动的像素推回源画布，两侧真正双向。这类改动记在你当前所在画布的历史里，可直接撤销。顺带修好轮廓填充工具在引用图层上的重定向判断。", "Fixed non-stroke edits on a reference layer not reaching the source canvas: selection fill, selection move, rotate and scale, effects and the like were written onto the mirror and then overwritten by the source canvas. Every sync now compares the mirror and pushes the directly changed pixels back into the source canvas, so both sides really are two-way. Such edits are recorded in the history of the canvas you are working in, so undo works right there. The outline fill tool's redirect check on reference layers was fixed as well."),
      it("imp", "选区浮动球改成只要当前工具是选区工具（框选、魔棒、套索）或存在选区就出现，不再必须先框出选区。没有选区时全选、粘贴等按钮依然可用，需要选区的按钮会提示先建立选区。", "The selection orb now appears whenever the active tool is a selection tool (rect, wand, lasso) or something is selected, instead of only after a selection exists. With nothing selected, Select all and Paste still work, and the buttons that need a selection say so."),
      it("fix", "修复图形绘制后的自动选区在引用画布上失效的问题：画线、矩形、椭圆后自动选中刚画的像素并切到选区工具，上一版为避免坐标错位临时关掉了它。现在把选区从源画布坐标映射回当前画布，普通图层与引用图层都正常。", "Fixed the shape-to-selection step on reference canvases: after drawing a line, rectangle or ellipse the pixels you just drew are selected and the select tool activates, but the previous build had turned this off to avoid mismatched coordinates. The selection is now mapped back from the source canvas coordinates, so it works on normal layers and reference layers alike."),
      it("fix", "画布引用弹窗里的画布名称不再被横向截断：卡片加宽，名称最多两行完整显示，尺寸另起一行。", "Canvas names in the reference dialog are no longer cut off horizontally: wider cards, the name on up to two full lines, and the size on its own row."),
      it("add", "新增「引用画布」：画布球 → 更多 → 引用画布，弹出所有画布的缩略图，类似帧预览页，点一张就把它作为一层引用进当前画布。引用层实时联动，显示的永远是源画布，跟随源画布当前帧，尺寸不同时居中；在引用层上画会直接改到源画布的当前图层；源画布改动后，所有引用它的画布立刻更新。图层行上有 ⚭ 标记，图层面板点「解除引用」会保留像素并断开关系，循环引用会被拒绝。", "New Reference canvas: canvas orb → More → Reference canvas shows a thumbnail page of every canvas, like the frame preview; tap one and it becomes a live layer in this canvas. The layer always mirrors that canvas, follows its current frame and centres when the sizes differ; painting on it edits the source canvas' current layer; any edit over there updates every canvas that references it right away. The layer row carries a ⚭ mark, and Release reference in the layer panel keeps the pixels and breaks the link; reference loops are refused."),
      it("add", "新增「提取为画布」：画布球 → 更多 → 提取为画布，把当前图层连同它的所有帧移动成一张独立画布，原画布中的该图层会被移除，有确认提示。", "New Extract to canvas: canvas orb → More → Extract to canvas moves the current layer, with all of its frames, out into a canvas of its own; the layer is removed from the original canvas after a confirmation."),
      it("imp", "界面精简：顶部工具栏去掉导出、保存、修改尺寸与全屏按钮，主菜单去掉色相调整与导出，这些都在画布球里。视口右下角只保留缩放百分比，适配画布按钮也进了画布球。", "Leaner UI: the top bar drops export, save, resize and fullscreen, and the menu drops colour adjust and export, all of which now live in the canvas orb. The viewport keeps only the zoom percentage, and Fit moved into the canvas orb too."),
      it("add", "画布球改为两页：常用页是新建画布、重命名、改尺寸、保存（把这张画布存成它自己的 .pxc 文件）、关闭并保存；更多页是预览、色相调整、导出、适配画布、平铺。", "The canvas orb now has two pages: New canvas, Rename, Resize, Save (writes this canvas to its own .pxc file) and Close & save on the first page; Preview, Colour adjust, Export, Fit and Tiling on the More page."),
      it("add", "默认空白工程：全新安装启动时什么都不打开，中间是引导卡片（新建画布 / 打开像素画），控制栏、时间线和浮动球都会隐藏；关掉最后一张画布也会回到这个状态，工程文件会记住一张都不开。", "Empty project by default: a fresh install opens nothing and shows a start card (New canvas / Open artwork) with the control bar, timeline and floating balls hidden; closing the last canvas returns to it too, and the project file remembers the empty state."),
      it("fix", "每张画布现在有自己独立的撤销/重做栈：切换画布再切回来，之前的操作记录还在，之前会丢；工程文件为每张画布各存一段历史。", "Every canvas now keeps its own undo/redo stack: switching away and back no longer loses the other canvas' history, and the project file stores one history per canvas."),
      it("imp", "油漆桶的渐变改为拖动定义方向和长度：按住拖动时画布上出现黄色方向线，松手才真正写入像素（Aseprite 风格）。渐变沿拖动方向线性过渡，不拖动则默认从上到下，超出两端的像素取端点色。", "The bucket gradient is now set by dragging: press and drag to define direction and length, a yellow guide line shows on the canvas, and the pixels are only written on release, Aseprite-style. The ramp is linear along the drag, defaults to top-to-bottom without a drag, and pixels past either end clamp to the end colour."),
      it("imp", "平铺改为四种模式：关闭 / 横向平铺（左右各一份）/ 竖向平铺（上下各一份）/ 九宫格平铺（3×3），镜像平铺已移除。从画布球的平铺项点开选择，旧设置会自动迁移。", "Tiling now has four modes: off, horizontal (one copy each side), vertical (one above and one below) and a 3×3 grid. Mirrored tiling is gone. Pick it from the canvas orb's Tiling entry, and old settings migrate automatically."),
      it("imp", "特效弹窗里的颜色参数（投影颜色、描边颜色）点色块会打开右侧调色板面板：可以直接点色板颜色，也可以拖色轮调色。选完面板自动收起，回到特效弹窗继续实时预览。", "In the FX dialogs, tapping the colour swatch of a colour parameter opens the palette panel on the right: pick a palette colour or fine-tune with the wheel. The panel then closes itself and you are back in the dialog with the live preview still running."),
      it("imp", "这样取色只作用于特效参数，不会改动画笔的前景色。", "That colour only applies to the effect parameter; it does not change the paint colour."),
      it("fix", "浮动球存储区在拖动选择时会滚动跟随：某个球被面板裁切时，手指滑向它会把对应项滚进可视区，横屏同理。", "The floating-ball dock scrolls to follow your finger: when a ball is clipped by the panel, sliding towards it scrolls that item into view. Landscape works the same way."),
      it("add", "双击画布标题栏会平滑放大到该画布的适配大小，单击仍然只是聚焦。", "Double-tapping a canvas title bar smoothly zooms that canvas to fit the screen. A single tap still only focuses it."),
      it("add", "多画布：所有打开的画画布放在同一个无限空间里。", "Multiple canvases: every open artwork lives in one infinite space."),
      it("add", "每个画布上方有一条游戏风格的标题栏，显示文件名与尺寸。", "Each canvas has a game-style title bar above it showing the file name and size."),
      it("add", "点标题聚焦该画布，拖动标题栏可以在空间里移动画布。", "Tap a title to focus that canvas, and drag the title bar to move the canvas around the space."),
      it("imp", "画布之间不重叠，会自动错开；切换聚焦画布时画面不会跳动。", "Canvases never overlap and are placed automatically clear of each other, and focusing another canvas does not make the view jump."),
      it("add", "每个画布各自记住自己的图层与帧选择。", "Each canvas remembers its own layer and frame selection."),
      it("add", "新增画布球浮动球：可以新建画布、重命名（标题栏同步）和修改该画布的尺寸。", "New canvas orb: create a canvas, rename it (the title bar follows) and resize that canvas."),
      it("add", "画布球还能预览该画布（弹出对应的预览框），以及关闭画布并保存为单独的 .pxc 文件，至少保留一个画布。", "The canvas orb also previews that canvas in its own window, and closes a canvas by saving it to a standalone .pxc file. At least one canvas always stays open."),
      it("imp", "预览框改成按需出现：画布上方那个默认预览按钮已移除，只有从画布球点预览才会出现一个绑定到该画布的预览框。", "Preview windows are now on demand: the old preview button above the canvas is gone, and a window appears only from the canvas orb's Preview action, bound to that canvas."),
      it("add", "可以为多个画布各开一个预览框，互不干扰；每个框都能拖动、双指捏合缩放，左上角关闭，右上角仍可切换底色与灰度。", "Several canvases can each have their own preview window without interfering with each other. Every window can be dragged, pinch-resized and closed from its top-left corner, and still switches backdrop and greyscale from the top-right."),
      it("imp", "预览框与帧预览都支持双指捏合缩放：浮动预览框捏合改变框体大小，帧预览弹窗捏合改变缩略图大小，缩略图按新尺寸重绘，底部可一键复位。", "Preview boxes and the frame preview both support pinch zoom: pinch the floating box to resize it, and pinch the frame-preview dialog to scale its thumbnails. Thumbnails are redrawn at the new size, with a one-tap reset in the footer."),
      it("add", "喷枪工具：按住即持续喷出随机大小的像素点，笔刷大小就是喷洒半径；底部栏可实时调整点的最小与最大边长，以及每秒喷洒密度。支持对称、选区与图层锁定。", "New airbrush tool: hold to keep spraying specks of random size, where the brush size is the spray radius. The bottom bar adjusts the minimum and maximum dot edge length and the spray rate per second. Symmetry, selections and layer locks all apply."),
      it("add", "油漆桶新增渐变模式：底部栏多出一个按钮，在纯色填充与渐变填充之间切换。渐变从点击处向外，由前景色过渡到背景色。", "The fill bucket gained a gradient mode: a bottom-bar button switches between flat and gradient fill. The gradient ramps from the foreground to the background colour, outwards from the tap point."),
      it("add", "油漆桶渐变的颗粒可选 RGB 平滑 / 2×2 / 4×4 / 8×8，后三种按方块取色，是像素风的硬边渐变。", "The gradient steps can be RGB-smooth, 2×2, 4×4 or 8×8. The last three sample one colour per block, which gives hard-edged pixel-art ramps."),
      it("add", "新增模糊特效：弹窗设置半径 1–32px，拖动数值时画布实时预览，确定才记入历史。alpha 一起柔化，透明区域不会渗黑边。", "New Blur effect: a dialog sets the radius from 1–32px, the canvas previews live while you drag the value, and only confirming records a history step. Alpha is softened too, so transparent areas do not bleed dark halos."),
      it("imp", "投影特效改为参数弹窗：可设偏移 x/y、颜色与不透明度，实时预览；仍可在设置里选择写在本图层或新建 shadow 图层。", "Drop shadow is now a parameter dialog: set the offset x/y, colour and opacity, with live preview on the canvas. Settings still chooses the current layer or a new shadow layer."),
      it("imp", "描边特效改为参数弹窗：可设宽度 1–16px、位置（外侧/内侧/居中）与颜色，实时预览。", "Outline is now a parameter dialog: set the width from 1–16px, the position (outside/inside/centred) and the colour, with live preview on the canvas."),
      it("add", "长按图层眼睛只显示该图层，再次长按恢复其它图层原来的显示状态；手动点眼睛会退出该模式。这一步同样可撤销，也会随工程保存。", "Long-press a layer's eye to show only that layer, and long-press again to restore exactly what the other layers showed before. A manual eye tap leaves the mode. The step is undoable and saved with the project."),
      it("imp", "数字输入框支持四则运算：可以输入 64*2+8 这样的算式（+ - * / % ^ 与括号，兼容全角符号），边输边算，失焦或回车应用。", "Number fields accept arithmetic: type a formula such as 64*2+8 (+ - * / % ^ and parentheses, full-width symbols included) and it evaluates as you type. Blur or Enter applies it."),
      it("imp", "手机数字键盘没有运算符，聚焦数字输入框时下方会浮出一排 + − × ÷ ( ) ⌫ = 按键。", "The phone number pad has no operators, so a row of + − × ÷ ( ) backspace = keys pops up under the focused number field."),
    ],
  },
  {
    v: "1.0.7.10",
    date: "2026-09-08",
    items: [
      it("fix", "拖动时间线顶部那条线会实时改变整个面板的高度：以前只改矩阵上限，图层少时拖动看不出变化。图层行下方多出来的空间用单元格底色补满，横竖屏都跟随手指。", "Dragging the line above the timeline now resizes the whole panel as you go: it used to change only the matrix cap, so with few layers the drag looked like it did nothing. The extra space below the layer rows is filled with the cell colour, and it follows the finger in landscape and portrait."),
      it("imp", "设置里的「时间线面板高度」现在指整块面板的高度：默认 200px，范围 140–520px，旧版本存的矩阵高度会自动换算。双击分割线复位为 200px。", "The timeline panel height setting now means the whole panel: default 200px, range 140-520px, and heights saved by older builds are converted automatically. Double-tapping the divider resets it to 200px."),
    ],
  },
  {
    v: "1.0.7.9",
    date: "2026-09-08",
    items: [
      it("add", "设置里新增「全面屏」分组：打开沉浸式全屏会隐藏系统状态栏和导航栏；安全区适配让界面避开刘海、挖孔和底部手势条。", "A new Full screen group in Settings: the immersive switch hides the system status and navigation bars, and safe-area padding keeps the interface clear of the notch, punch hole and gesture bar."),
      it("add", "全面屏分组里还能补 0–40px 的额外安全边距，给不向应用上报安全区的机型手动补白；下面一行「安全区检测」实时显示系统上报的四边数值。", "The same group adds an extra safe margin of 0-40px for ROMs that report no safe area, plus a safe-area probe line showing the four inset values the system reports, updated live."),
      it("add", "全面屏适配：Android 侧允许内容画进挖孔区（cutout 用 SHORT_EDGES），并把系统栏安全边距折算成 CSS px 通过桥接交给网页，隐藏系统栏后的手势条和刘海也算在内。顶部栏、控制条、时间线、弹窗都按这个数值留白。", "Full-screen support on the Android side: content may now be drawn into the cutout area (SHORT_EDGES), and the system-bar insets, including the gesture bar and the notch once the bars are hidden, are converted to CSS px and passed to the page over the bridge. The top bar, control bar, timeline and dialogs pad themselves by that value."),
      it("fix", "设置里展开的下拉选项会被分组卡片裁掉，看不到完整选项。分组框现在不再裁剪，下拉在下方空间不足时会自动向上展开。", "Dropdown options in Settings were clipped by their group card, so the full list could not be seen. The group no longer clips, and a dropdown flips upwards when there is not enough room below."),
      it("add", "时间线面板顶部新增一条拖动条，上下拖动实时改变高度并显示 px 数值，双击复位为 116px。横屏时这条就是时间线顶部那条线。", "A grip on top of the timeline panel resizes it: drag it up or down for a live px readout, double-tap to reset to 116px. In landscape the grip is the line above the timeline."),
    ],
  },
  {
    v: "1.0.7.8",
    date: "2026-09-08",
    items: [
      it("imp", "设置界面重排：每条设置单独成一张卡片，浅底、圆角加细边框，说明文字改成小号灰字并收在同一张卡片内，不会再被误读成下一条设置的标题。", "Settings rows were reworked: every setting is its own card with a subtle background, rounded corners and a hairline border, and its description is small grey text inside that same card, so it can no longer be mistaken for the next setting's label."),
      it("imp", "设置行的标题统一成同一个字号和字重：以前开关行和数字行是 13px 亮色、枚举行是 11px 暗色，看着像两类东西。分组标题右侧多了个小圆点，表示该组里有改动过的设置。", "Setting titles now share one size and weight: switches and number rows used to be 13px and bright while enum rows were 11px and dim, which made them look like two different things. Group headers also show a small dot when that group contains changed settings."),
    ],
  },
  {
    v: "1.0.7.7",
    date: "2026-09-08",
    items: [
      it("fix", "以前只有四指预览和长按取色会震动，双击撤销、三连击缩放、双指双击重做、时间轴长按、工具栏展开都没有反应。现在每个手势动作都会先震一下再执行。", "Only the four-finger preview and the long-press eyedropper used to vibrate; double-tap undo, triple-tap zoom, two-finger double-tap redo, the timeline long press and the tool ring did nothing. Every gesture action now ticks once before it runs."),
      it("fix", "手势震动原来只有 10–26ms，部分机型对 30ms 以下的短震动基本无感，看着就像震动没生效。默认改成 60ms，并新增「震动时长」设置（短 30 / 中 60 / 长 100ms）。", "Gesture pulses were only 10-26ms long and some phones cannot feel a pulse under about 30ms, which looks the same as vibration not working. The default is 60ms now, plus a new Haptic length setting (short 30 / medium 60 / long 100ms)."),
      it("imp", "设置 → 数据 里的「震动环境诊断」现在显示开关状态、震动时长和最近 4 次震动调用（来源:时长），每秒刷新，可以直接看出某个手势有没有调到马达。", "The vibration probe under Settings, Data now shows the switch state, the pulse length and the last four haptic calls (source:length), refreshing every second, so it is plain whether a gesture reached the vibrator."),
      it("imp", "「测试震动」改为按当前所选时长发一次，0.4 秒后再发一次 120ms 的长震，两种时长可以直接对比。", "Test vibration now fires once at the chosen length and once more at 120ms 0.4s later, so the two lengths can be compared."),
      it("imp", "移除 1.0.7.6 加入的那一下启动诊断震动。", "Removed the startup diagnostic buzz that 1.0.7.6 added."),
    ],
  },
  {
    v: "1.0.7.6",
    date: "2026-09-08",
    items: [
      it("imp", "震动问题的诊断版：启动时只走 Java 震一下，不经过 JS；设置 → 数据 里新增「震动环境诊断」一行，显示 桥接 / 震动接口 / navigator.vibrate / 马达 / 上次调用结果。", "Diagnostic build for the vibration problem: a Java-only buzz at launch, with no JS involved; Settings → Data gains a Vibration diagnostics row showing bridge / vibrate API / navigator.vibrate / motor / last call result."),
    ],
  },
  {
    v: "1.0.7.5",
    date: "2026-09-08",
    items: [
      it("fix", "震动再修一轮：原生 vibrate 改为同步调用并返回是否触发，不再绕 UI 线程；振幅改为最大值 255，时长上限 200ms。打开工具球或浮动球时也会震一下。", "Another pass at vibration: the native vibrate call is synchronous and returns whether it fired, with no UI-thread hop. Amplitude is now the maximum 255 and the duration cap is 200ms. Opening the tool ring or a floating ball ticks as well."),
      it("add", "设置 → 手势与触控 里新增「测试震动」按钮：按下立刻震 80ms，并用提示区分「已触发」「系统禁止」「设备无马达」三种情况，方便定位问题。", "Settings → Gestures & Touch gains a Test vibration button: it fires an 80ms pulse and reports which case applies: fired / blocked by the system / no vibrator on the device."),
    ],
  },
  {
    v: "1.0.7.4",
    date: "2026-09-08",
    items: [
      it("fix", "修复应用内震动不生效：原生改用 VibratorManager（Android 12+），调用失败时回退旧接口；震动时长上限从 60ms 提到 100ms。", "Fix in-app vibration: the native side now uses VibratorManager (Android 12+), and falls back to the legacy call when it fails. The maximum pulse goes from 60ms to 100ms."),
      it("imp", "打开「震动反馈」开关会立刻震一下，长按拖拽开始时也震；设备没有可用马达时，设置里会给出提示。", "Switching Haptic feedback on now ticks right away, and a long-press drag ticks as it starts. Settings warns you when the device has no usable vibrator."),
      it("imp", "手势功能映射改用下拉选择（和调色板排序同款的可展开样式），选项多的设置项（如启动工具）也自动用下拉，不再铺一屏按钮。", "Gesture mappings now use a dropdown, the same expandable style as the palette sort control, and any setting with many options such as the launch tool switches to it automatically instead of filling the panel with buttons."),
    ],
  },
  {
    v: "1.0.7.3",
    date: "2026-09-08",
    items: [
      it("add", "手势的功能都可以改：设置 → 手势与触控 里，画布外双击、画布内双击、双指双击、三连击、四指滑动、长按各自可选撤销 / 重做 / 放大 / 缩小 / 适配视图 / 播放暂停 / 洋葱皮 / 网格 / 对称 / 时间轴 / 帧预览 / 上一帧 / 下一帧 / 调色板 / 取色 / 关闭。", "Every gesture can run a different action: in Settings → Gestures & Touch, the double-tap on the margin, the double-tap on the canvas, the two-finger double-tap, the triple-tap, the four-finger slide and the long-press each pick from undo / redo / zoom in / zoom out / fit / play-pause / onion skin / grid / symmetry / timeline / frame preview / prev frame / next frame / palette / pick colour / off."),
      it("add", "工程文件会带上操作记录：保存的 .pxc 里有撤销/重做栈（笔迹增量、图层与帧的结构快照、可见性这类小改动），重新打开后可以接着撤销、重做和跳转历史；设置 → 数据 里可以关掉记录存储，减小文件体积。", "Project files now carry their operation history: a saved .pxc holds the undo/redo stack (stroke deltas, layer/frame structure snapshots, small edits such as visibility), so reopening it lets you keep undoing, redoing and jumping through history. Settings → Data can turn the recording off to keep files smaller."),
      it("imp", "恢复的历史语义完整：能序列化的步骤全部保留，无法序列化的步骤会截断更旧的记录，撤销的结果不会错。", "Restored history keeps its meaning: every serializable step is kept, and a step that cannot be serialized truncates the older entries, so undo never returns a wrong result."),
    ],
  },
  {
    v: "1.0.7.2",
    date: "2026-09-08",
    items: [
      it("add", "状态跨启动保持：笔刷大小与不透明度、前景与背景色（含透明度）、当前工具与形状/选区子环、对称轴（开关、角度、轴心、四向、锁定）、最后使用的色板、新建文档的尺寸与背景、参考图，重启后都还在。", "State survives a restart: brush size and opacity, foreground/background colours (alpha included), the active tool with its shape/selection sub-ring, the symmetry axis (on/off, angle, pivot, four-way, lock), the last palette used, new-document size and background, and the reference image."),
      it("add", "笔尖形状可以切换：圆笔尖（默认）与方笔尖，笔迹和图形描边都跟着变；控制栏有切换按钮，设置里也能改。", "The brush tip switches between round (default) and square, and both freehand strokes and shape outlines follow it. A control-bar toggle handles it, and Settings has an entry too."),
      it("add", "图形新增「从中心绘制」：矩形、椭圆、圆、多边形以按下点为中心向外生长；控制栏有开关，设置里能定默认值。", "Shapes gain a Draw from the centre option: rect/ellipse/circle/polygon grow outwards from the point you press. A control-bar toggle switches it and Settings holds the default."),
      it("add", "多边形边数进了设置（3–32，控制栏的上限也从 12 提到 32）；图形还能设默认实心或空心。", "Polygon side count is a setting now (3–32, and the control-bar limit went from 12 to 32), and shapes can default to filled or hollow."),
      it("add", "打开对称后，选区工具（框选 / 套索 / 魔棒）画出的选区也按对称轴镜像，和画笔的规则一致。", "With symmetry on, the selection tools (marquee / lasso / wand) mirror the selection across the axis, the same way the brush does."),
      it("add", "新增「手势与触控」设置组，里面可以调长按判定时间、双击判定间隔、三连击放大倍率、四指滑动阈值、边缘自动平移的范围与速度、最小缩放、最大缩放、震动反馈开关、边距双击撤销开关。", "New Gestures and Touch settings group: long-press delay, double-tap window, triple-tap zoom factor, four-finger slide threshold, auto-pan edge zone and speed, minimum zoom, maximum zoom, haptic feedback and margin double-tap undo."),
      it("add", "参考图会跟窗口位置、大小和不透明度一起保存，重启后自动恢复；窗口左下角多了一个不透明度滑块。", "Reference images are saved with their window position, size and opacity and come back on the next launch. The window also has an opacity slider in its bottom-left corner."),
      it("imp", "调色板面板点空白处就能关掉，滚动和长按都不会误触。", "Tapping a blank spot on the palette panel closes it; scrolling and long-pressing never do."),
      it("add", "设置里新增启动时使用的工具，以及新建文档的宽度、高度和背景。", "New settings for the tool selected on launch, plus the width, height and background of a new document."),
    ],
  },
  {
    v: "1.0.7.1",
    date: "2026-09-08",
    items: [
      it("fix", "以前按返回键会直接退出应用：原生侧比较的是 JS 返回的字符串再 JSON 编码后的结果，每次都走到 finish()。现在有弹窗、面板、浮动球或引导时只关闭最上层；一个都没有时第一次按返回先提示，再按一次才退出。", "The back gesture used to quit the app outright: the native side compared a JSON-encoded copy of the string JS returned, so it always fell through to finish(). Now it closes the topmost layer when a dialog, panel, ball ring or tour is open, and when nothing is open the first press only warns and a second press exits."),
      it("imp", "多选帧时点该帧在图层矩阵里的任意一个格子都能勾选，不用只点帧号；选中的帧整列会加底色标出。", "When picking frames you can tap any layer cell in that frame instead of only the frame number, and the whole picked column is highlighted."),
      it("imp", "色板面板改用选项卡：色板 / 画布 / 最近，标题比原来短。排序收进选项卡右侧的下拉（按色相 / 按明度），去重改成图标按钮。颜色代号输入框旁边那个没用处的系统取色器删掉了。", "The palette panel now uses tabs (Palette / Canvas / Recent, with shorter labels). Sorting moved into a menu on the right of the tab bar (by hue / by lightness) and de-dupe became an icon button. The useless system colour picker beside the hex field is gone."),
      it("add", "当前色板可以存成自定义预设，保存后出现在预设列表里，能替换、合并或删除，重启后还在。", "The current palette can be saved as a custom preset. It shows up in the preset list, can be applied, merged or deleted, and is still there after a restart."),
      it("imp", "更新日志改成版本选项卡，横向可滚动，每个版本带日期；新增 / 改进 / 修复 三个分类点标题就能折叠。", "Release notes now use version tabs that scroll sideways, each with its date, and the Added / Improved / Fixed groups fold when you tap their header."),
      it("imp", "设置里「文字 + 开关」和「文字 + 数值」的行改成横向布局，标签在左、控件在右，纵向空间省掉一半；说明文字仍单独占下方一行。", "Settings rows that pair a label with a switch or a single number now put the label on the left and the control on the right, halving the vertical space. The description still gets a line of its own below."),
    ],
  },
  {
    v: "1.0.7",
    date: "2026-09-08",
    items: [
      it("imp", "绘制改成增量渲染：笔迹只重合成、重绘改动过的区域（脏矩形），同一帧内的多次重绘合并成一次。洋葱皮的幽灵帧和选区染色图也加了缓存，大画布上画起来顺很多。", "Drawing is now incremental: a stroke only re-composites and repaints the pixels it changed (dirty rectangles), and several repaints in one frame are merged into one. Onion ghosts and the selection tint are cached, so large canvases draw much more smoothly."),
      it("add", "时间轴支持帧多选：点帧号勾选多帧后，可以批量复制、删除，或统一设置时长，至少保留 1 帧。批量操作各算一步撤销。", "Multi-frame selection in the timeline: tap frame numbers to pick several, then duplicate, delete or set one duration for all of them, with at least 1 frame kept. Each batch counts as one undo step."),
      it("add", "洋葱皮新增「循环环绕」：首帧往前看到末尾帧，末帧往后看到开头帧，环绕帧用蓝色和琥珀色区分，做循环动画时不用自己数帧。", "Onion skin has a loop-aware mode: before the first frame you see the last one, after the last frame you see the first, and wrapped frames are tinted blue and amber so you do not have to count frames while building a loop."),
      it("add", "导出支持帧范围：GIF、精灵表、分图层导出都能只导出指定的一段，一键选「全部帧」或「用所选帧」（配合帧多选）。", "Exports can target a frame range: GIF, spritesheet and per-layer exports write only the span you pick, with one-tap 'All frames' or 'Use picked frames' (works with frame multi-select)."),
      it("add", "调色板可以整理：相同颜色只留一个，按色相或明度排序只改顺序，还能把预设色板合并进当前色板。", "The palette can be tidied up: identical colours are reduced to one, sorting by hue or lightness only reorders the swatches, and a preset palette can be merged into the current one."),
      it("add", "设置面板支持搜索，任意一行可以单独恢复默认值，整套设置能导出和导入 JSON；导入时未知项忽略、非法值跳过、整数自动裁剪。", "Settings can be searched, any single row can be reset to its default, and the whole set exports and imports as JSON; unknown keys are ignored, invalid values skipped and integers clamped."),
      it("add", "返回手势一次只关一层：先关弹窗，再关面板、浮动球环，最后是新手引导。一层都没开时，第一次按返回只提示，再按一次才退出应用。", "The back gesture closes one layer at a time: the dialog first, then the panel and the floating-ball ring, and the tour last. With nothing open the first press only warns, and a second press exits the app."),
      it("add", "新手引导新增 5 步：帧多选、色板整理、导出帧范围、设置搜索与恢复默认、返回手势。其中帧多选那步会替你勾选两帧，导出与设置两步直接打开真实窗口。", "The tour gains 5 steps: frame multi-select, palette tidying, export frame range, settings search and reset, and the back gesture. The frame step ticks two frames for you, and the export and settings steps open the real windows."),
      it("imp", "新增 README 与 docs/API.md 接口文档（18 章，覆盖引擎、工具、应用、渲染、IO、UI 的对外 API 与扩展指南），竞品对比文档里过时的结论也刷新了。", "New README and docs/API.md reference (18 chapters covering the engine, tools, app, render, IO and UI APIs plus an extension guide); the outdated conclusions in the competitor comparison doc are refreshed as well."),
    ],
  },
  {
    v: "1.0.6.0",
    date: "2026-09-08",
    items: [
      it("fix", "取色球的颜色来源胶囊改成固定槽位：始终在浮动球正下方固定距离，不随色球数量跳动，也不会压住浮动球；底部空间不足时翻到上方，色球布局自动避开这个位置。", "The colour-source chip of the colour orb now uses a fixed slot: a constant distance below the floater, so it no longer jumps as the number of swatches changes and never covers the floater. When the bottom is tight it flips above, and the swatch layout keeps that slot clear."),
      it("imp", "更新日志面板改成固定尺寸：版本是纵向列表，列表区自己滚动，选中版本的说明单独滚动，版本再多也不会把面板撑高。", "The release-notes panel has a fixed size: versions are a vertical list that scrolls inside its own area, the notes for the selected version scroll separately, and the panel no longer grows with the number of releases."),
      it("add", "新手引导改成模块化：按画布、工具与颜色、浮动球、图层与帧、文件与保存、手势与导航分步高亮真实控件。首次安装展示全部，之后每次大版本更新只展示新增步骤，主菜单里随时能重放。", "The tour is modular now: it walks through canvas, tools and colours, floating orbs, layers and frames, files and saving, and gestures and navigation, spotlighting the real controls step by step. A first install shows everything, a later release shows only the new steps, and the main menu can replay it at any time."),
      it("imp", "引导支持「先示范再讲解」：讲到选区球时会在画布上框出一个选区把它呼出来，不写入撤销记录，讲完恢复原来的选区；一个步骤也能一次声明多个动作。", "Tour steps can act before they explain: the selection-orb step frames a selection on the canvas to summon the orb, without touching the undo stack, then restores the previous selection. A step can also declare several actions at once."),
      it("add", "引导细化到具体按钮：会自动打开工具环（含形状/选区子环）与主菜单，逐个高亮每个工具、每个菜单项，导入图片、导入精灵表、参考图、导出对话框、导出调色板等二级功能也各有一步。", "The tour drills down to individual buttons: it opens the tool ring (including the shape and selection sub-rings) and the main menu by itself, spotlighting each tool, every menu entry and the sub-menu items such as import image, import spritesheet, reference image, export dialog and export palette."),
      it("add", "引导会实际替你点下按钮：点开浮动球与工具环、展开形状/选区子环、打开主菜单并进入导入/导出二级菜单、打开时间轴与洋葱皮，讲完自动恢复原状。缩放、绘制、点击、四指这些手势步骤改用虚拟触点动画演示。", "Interactive steps really perform the action: the tour taps the controls for you, opening the floating orbs and the tool ring, expanding the shape and selection sub-rings, opening the main menu and its import and export sub-menus, and switching on the timeline and onion skin, all restored when the tour ends. Gesture steps such as zoom, draw, taps and four-finger play a virtual-finger animation instead."),
      it("add", "引导每个模块的示范都真的执行一遍再还原：缩放步骤缩放一次，工具步骤在橡皮、直线、框选之间切换再切回，笔刷步骤调大再调回，前景背景交换一次。", "Every tour section really performs its demonstration and then restores it: the zoom step zooms once, the tool step switches between eraser, line and marquee and back, the brush step changes the brush size and restores it, and the foreground and background swap once."),
      it("add", "引导其余的示范同样真的执行：对称开一条轴再关掉，取色球循环一遍颜色来源，洋葱皮打开并翻到下一帧给你看前后帧参考，三连击放大 2×，四指步骤讲完弹出「预览所有帧」。", "The remaining demonstrations really run as well: symmetry turns one axis on and off, the colour orb cycles its colour sources, onion skin switches on and steps to the next frame to show the frames before and after, triple-tap zooms 2x, and finishing the four-finger step opens the all-frames preview."),
      it("add", "设置与更新日志两步直接打开真实窗口来讲解，这两步的遮罩更浅，窗口内容看得清，讲完自动关掉；魔法球的特效会改动画面，那一步只逐个高亮可用特效，不实际应用。", "The settings and release-notes steps open the real windows to explain them, with a lighter backdrop on those steps so the window content stays readable, closed again afterwards. The magic-orb effects would change the artwork, so that step lights up each available effect in turn instead of applying one."),
      it("fix", "修好「双指双击 = 重做」的手势演示：以前误用双指拖动的动画，现在改成两根手指同时双击；三连击步骤会把画布留在高亮区域里，真实放大效果看得见。", "The two-finger double-tap (redo) demo used to play the two-finger pan animation; it now shows two fingers double-tapping together. The triple-tap step also keeps the canvas inside the highlight so the real zoom is visible."),
      it("imp", "引导文案补上形状和容差的说明：形状工具松手后自动变成可拖动、可缩放的选区；魔棒容差在设置 →工具里调。", "Tour copy spells out shapes and tolerance: lifting your finger turns the shape into a movable, scalable selection, and wand tolerance is set in Settings under Tools."),
      it("imp", "引导文案补上帧的说明：点帧号格切到那一帧，长按设帧时长，长按后拖动重排帧顺序；洋葱皮至少需要 2 帧。", "Tour copy covers frames too: tap a frame number to switch to it, hold it to set the frame duration, hold and drag to reorder; onion skin needs at least 2 frames."),
      it("imp", "引导文案补上导入和预览的说明：新建或打开作品会替换当前内容；导入精灵表要先填单元格尺寸；预览里点任意一帧即可跳过去。", "Tour copy covers import and preview as well: new or open replaces the current artwork, spritesheet import needs the cell size first, and tapping any frame in the preview jumps to it."),
      it("add", "新增静态锚点测试：逐个检查引导用到的控件选择器是否真的存在于界面源码里。按钮改名会让步骤静默失效，现在测试会拦下来。", "New static anchor test: it checks that every control selector the tour uses really exists in the UI sources. A renamed button used to make a step silently point at nothing; the test catches it now."),
      it("fix", "引导气泡不再盖住正在讲解的内容：四个方向依次找不与高亮区域重叠的位置；目标占满屏幕时把高亮范围收缩到中心；气泡始终完整留在屏幕内。", "The guide card no longer covers what it explains: it tries the four sides for a spot that does not overlap the highlight, shrinks the highlight towards the centre when the target fills the screen, and always stays fully on screen."),
      it("add", "引导新增「跳过本模块」：一键跳过当前模块剩下的步骤，直接进入下一个模块。", "The tour gains a Skip section button: one tap skips the remaining steps of the current section and moves straight on to the next one."),
      it("fix", "修复引导气泡跑出屏幕：定位时先测量真实高度，再在横竖两个方向钳制；同时去掉会二次偏移坐标的入场位移动画，气泡跑偏就是它造成的。", "Fixed the guide bubble leaving the screen: the card is measured first, then clamped on both axes. The entrance animation that shifted its coordinates a second time is gone; that was what made the bubble drift."),
      it("fix", "引导期间，被收进存储区的浮动球会自动弹出，引导结束后恢复到原来的停靠布局。", "Floating balls parked in the storage area pop out while the tour runs, and the dock layout you had before is restored when it ends."),
    ],
  },
  {
    v: "1.0.5",
    date: "2026-09-08",
    items: [
      it("imp", "画布颜色和最近使用两个色源入口移到取色球扇形菜单：点色板旁的模式胶囊即可在「色板 / 画布颜色 / 最近使用」之间切换，刚用过的颜色会立刻出现，调色板面板也支持。", "Canvas colours and Recent moved into the colour-orb fan: tap the mode chip beside the palette to switch between Palette, Canvas colours and Recent. Newly used colours show up right away, and the palette panel works the same way."),
      it("imp", "设置系统重构成声明式注册表（Godot 风格）：每条设置集中声明一次，写清点号路径、类型、默认值、范围、分组、显示条件、刷新策略和自定义读写；设置界面按声明自动生成，分组可折叠，加一条设置只需加一条声明和它的文案。", "Settings rebuilt as a declarative registry (Godot style): each setting is declared once with its dotted path, type, default, range, group, visibility rule, refresh policy and custom accessors. The dialog is generated from that table with collapsible groups, so a new setting means one declaration plus its strings."),
      it("fix", "魔棒容差这类设置以前重启就丢，现在跟着注册表一起保存，重开应用不会回到默认值。", "Wand tolerance and similar settings used to be lost on restart. They are declared in the registry now, so they persist like the rest of the settings."),
    ],
  },
  {
    v: "1.0.4",
    date: "2026-09-08",
    items: [
      it("add", "油漆桶新增「连续 / 非连续」开关，只在油漆桶工具时出现在控制栏：非连续一次填满整层所有同色像素，连续只填连通的那一片。", "Paint bucket gains a contiguous / global switch, shown in the control bar only while the bucket is active: global fills every matching pixel in the layer at once, contiguous fills only the connected region."),
      it("add", "图层可在时间轴左侧直接拖动重排：在图层行上按住约 0.3 秒，再上下拖动即可调整顺序，一次撤销就能还原。", "Layers can be dragged to reorder in the timeline: hold a layer row for about 0.3s, then drag up or down to change the order. A single undo restores it."),
      it("add", "播放新增循环模式：单次 → 循环 → 来回循环（乒乓）→ 倒流循环；点循环按钮按这个顺序切换，并提示当前是哪一种。", "Playback gains loop modes: once → loop → ping-pong → reverse. The loop button cycles through them in that order and shows which one is active."),
      it("add", "洋葱皮设置搬进设置页：总开关、前/后帧数量（各 0–3）、不透明度、是否着色（前帧红、后帧绿）。", "Onion skin settings moved into Settings: master switch, frames before/after (0–3 each), opacity, and optional tint (previous frames red, next green)."),
      it("add", "选区浮动球新增「反选」按钮：有选区时反选，没有选区时等于全选。", "The selection ball gains an Invert button: with a selection it inverts it, and with none it selects everything."),
      it("add", "调色板面板新增「画布颜色」和「最近使用」两种取色模式：前者列出当前作品用到的全部颜色，后者列出最近用过的颜色；最近颜色保留几条可在设置里调（4–64）。", "The palette panel gains Canvas colours and Recent modes: the first lists every colour used in the artwork, the second the colours you used most recently. How many recent colours to keep is set in Settings (4–64)."),
      it("imp", "自动保存改用 IndexedDB：大画布不再因为 4MB 上限被跳过，旧数据会自动迁移过来。", "Autosave now stores data in IndexedDB: large canvases are no longer skipped at the 4MB cap, and old data migrates automatically."),
      it("imp", "自动保存更可靠：切到后台会立即保存；设置页显示上次保存时间，并提供「立即保存」和「清除」。", "Autosave is more reliable: going to the background saves immediately, and Settings shows the last save time with Save now and Clear buttons."),
      it("imp", "撤销默认步数由 60 提升到 120。", "Default undo steps raised from 60 to 120."),
      it("imp", "切换帧也会记入撤销/重做：点帧或按上一帧/下一帧都能撤回上一次查看的帧，播放过程中的切帧不进记录。", "Frame switching is part of undo/redo now: tapping a frame or using prev/next can be undone, while frame changes during playback stay out of the record."),
    ],
  },
  {
    v: "1.0.3",
    date: "2026-09-08",
    items: [
      it("add", "对称系统收成一个对称模式，轴角度可选 0/45/90/135°，四向对称另有开关。", "Symmetry is now one mode with an axis angle of 0/45/90/135° and a separate four-way toggle."),
      it("add", "对称辅助线可以直接拖动和旋转，按像素吸附。新增锁定按钮，SVG 图标，放在视口边缘防误触；锁定后对称调节芯片自动隐藏。", "The symmetry guides can be dragged and rotated with pixel snapping. A new lock button with an SVG glyph sits at the viewport edge so it is hard to hit by accident; the symmetry chips hide while it is locked."),
      it("add", "统一网格辅助线：关/像素格/等距三种模式，尺寸可调；等距网格改成真实的 30° 斜线。", "Unified grid guide with three modes (off / pixel / isometric) and an adjustable size; isometric mode now draws true 30° lines."),
      it("add", "画布边距双击撤销，边距双指双击重做，画布上三连击放大 2×。", "Double-tap the margin to undo, two-finger double-tap the margin to redo, triple-tap the canvas to zoom 2×."),
      it("add", "取色时屏幕角落会出现像素放大镜，倍率可调，也可以关掉。", "A pixel loupe appears in the corner of the screen while picking colours; its magnification is adjustable and it can be turned off."),
      it("add", "选区缩放按 Aseprite 的做法来：任意比例自由缩放，锚点在对侧手柄，采样用截断最近邻，缩放吸附保持像素清晰。", "Selection scaling follows Aseprite: free non-integer factors anchored at the opposite handle, truncating nearest-neighbour sampling, and snapping that keeps pixels crisp."),
      it("add", "全部帧的预览改成方形卡片；不透明度旁边新增了入口按钮，配了独立的 SVG 图标。", "The all-frames preview now uses square cards, and a new entry button sits beside opacity with its own SVG icon."),
      it("add", "删除选区内容收进选区球；魔法球新增清空画布，投影和发光的目标可以选当前层，也可以新建 shadow 图层。", "Delete selection moved into the Selection Ball. The Magic Ball can clear the canvas, and drop shadow or glow can target the current layer or a new shadow layer."),
      it("add", "浮动球停靠布局会保存下来，重启应用后已停靠的球还在原来的位置。", "Docked floating-ball layout is saved, so docked orbs come back in the same place after an app restart."),
      it("add", "空状态会给出操作提示；缩放百分比 HUD 旁边多了「适配视图」按钮。", "Empty states show a hint about what to do next, and the zoom percentage HUD gains a fit-to-view button."),
      it("add", "旋转屏幕或改变面板大小后，视口保持不变；画布平移始终钳制在视口内，不会丢出画面；边缘自动平移可以开关，并且限速。", "The viewport is kept when the screen rotates or the panel size changes; panning stays clamped so the canvas never leaves the view. Edge auto-pan can be toggled and has a speed cap."),
      it("add", "四指按住向上滑可以打开「预览所有帧」，手势期间画布不会移动或缩放。", "Hold four fingers and swipe up to open the all-frames preview; the canvas does not move or zoom during the gesture."),
      it("add", "全应用拦截浏览器的长按菜单和文本选择，画画时不会再误弹系统菜单。", "Browser long-press menus and text selection are blocked across the app, so drawing no longer pops up system menus."),
      it("fix", "撤销/重做快捷手势只在画布外生效：画布内双击不再误触发撤销，三连击放大也不会再撤掉此前画下的笔划。", "Undo/redo shortcut gestures only fire outside the canvas. A double-tap inside no longer triggers undo, and the triple-tap zoom no longer undoes strokes drawn earlier."),
      it("fix", "铅笔和橡皮的足迹光标不再卡在画布边缘。", "The pencil and eraser footprint cursor no longer sticks at the canvas edge."),
      it("fix", "对称的圆形笔刷在奇数尺寸和偶数尺寸下逐像素一致，是正圆，右侧和底部不再有扁边。", "Symmetric round brushes are pixel-identical for odd and even sizes and are true circles, with no flat edge on the right or the bottom."),
      it("fix", "投影生成到新图层时会把当前图层的内容复制过去作为阴影来源，以前只会得到一个空图层。", "Drop shadow onto a new layer copies the current layer as its shadow source; it used to produce a blank layer."),
      it("fix", "帧预览的图标 SVG 以前被错嵌进时间轴图标里；现在两个图标分开定义，帧预览用自己的那个。", "The frame-preview icon SVG used to be nested inside the timeline icon. The two are defined separately now, so the frame preview shows its own icon instead of the timeline one."),
      it("fix", "四指手势改成「四指按住 + 至少两指滑动」就触发帧预览：不再限定上滑方向和距离，往哪个方向滑都算，每根手指从自己的落点算位移，超过抖动阈值就算滑动。", "The four-finger gesture now opens the frame preview once four fingers are down and at least two of them slide. The old upward direction and distance are gone, any-direction travel past the jitter threshold counts, and travel is measured per finger from its own touchdown."),
      it("fix", "四指手势的误触判定：只有一根手指在动、按下后一直不动、以及第四指落下之前就开始滑的，都不触发。快速甩动、滑到一半抬指、先滑后回滑都能正常打开，打开前有一次震动反馈。", "False four-finger triggers are filtered out: only one finger moving, a press that never moves, and sliding that starts before the 4th finger lands all do nothing. Fast flicks, a finger lifting mid-way and slide-then-slide-back still open the preview, with one haptic tick before it appears."),
      it("imp", "仓库整理：web 构建和测试脚本收进仓库，npm 一条命令就能构建；已废弃的旧版程序和脚本删掉了。", "Housekeeping: the web build and test chain is in-repo and self-contained, so npm builds everything in one command, and the abandoned legacy app code and scripts are gone."),
    ],
  },
  {
    v: "1.0.2",
    date: "2025-09-07",
    items: [
      it("add", "操作记录支持两种模式：按步数只留最近若干步，步数可以调；或者选「完整记录」，从项目创建起保存全部操作，可以从头完整回放。", "History recording has two modes: a step-limited mode that keeps the most recent steps with an adjustable step count, or Full Recording, which saves every operation since the project was created so the whole history can be replayed from the start."),
      it("add", "特效球改名为魔法球，同时新增一键居中内容、智能裁剪画布空白、一键投影与外发光。", "The FX orb is now the Magic Ball, and it gains one-tap centring of the content, smart-crop of the empty canvas borders, and a drop shadow or outer glow."),
      it("add", "魔法球新增等距网格辅助，画布上可以铺一层等距网格；动作图标也补齐成整套 SVG。", "The Magic Ball now adds an isometric grid helper that lays an iso grid over the canvas, and its action icons come as the full SVG set."),
      it("add", "铅笔和橡皮改用 Aseprite 的圆形笔刷算法：尺寸就是直径，奇数尺寸和偶数尺寸逐像素一致。", "Pencil and eraser now use Aseprite's circular brush algorithm, where the size is the diameter, so odd and even brush sizes stay pixel-identical."),
      it("add", "画完图形会自动选中刚画出的那些像素，可以马上拖动；移动、旋转、缩放用 Aseprite 的浮动方式，不会带走底下的像素。", "Drawing a shape auto-selects its exact pixels, so they can be dragged right away. Move/rotate/scale uses Aseprite-style floating content that never carries the artwork underneath."),
      it("add", "图层重命名改成独立弹窗；图层透明度的长按手势条恢复了，弹层超出屏幕的问题也修好了。", "Layer rename now has its own dialog, the layer-opacity hold slider is back, and popups stay on-screen instead of running off the edge."),
      it("add", "数字输入框支持长按上下或左右滑动微调，步长按值域自动选；所有输入框统一成深色主题。", "Numeric fields support long-press slide scrubbing up, down, left or right, with the step picked automatically from the value range, and every input now matches the dark theme."),
      it("add", "菜单重新分组：导入和导出改成二级菜单，导入里有图片、图层、精灵表、参考图、色板，导出里有图片、图层、色板；时间线默认隐藏。", "The menu is regrouped: Import and Export are second-level menus now, with import covering image/layer/sheet/reference/palette and export covering image/layer/palette, and the timeline starts hidden."),
      it("add", "混合模式改用弹窗选择，弹窗居中、可滚动，横屏也能用；导出新增「图层导出」模式，每个图层单独出一张图。", "Blend modes are picked from a landscape-aware dialog that sits centred and scrolls, and export gains a Layers mode that writes one image per layer."),
      it("imp", "长按进度条按钮双击可以快速回到默认值；快速色轮长按时不再因为手指离开色块就消失；拖动时按钮文字实时跟着变。", "Double-tap a hold slider to snap it back to the default value; the quick colour wheel no longer closes when the finger leaves the chip; button labels update live while you drag."),
      it("fix", "浮动球收纳要拖进面板区域才生效，拖到别处不会收起来；拖动中手指离开区域也保持聚焦，不会中途取消。", "A floating orb only docks when you drop it inside the panel area, not anywhere else, and a drag that leaves the area stays focused instead of being cancelled."),
      it("fix", "从面板里取出的浮动球落在手指松开的位置；横屏下浮动球的宽度固定。", "An orb pulled out of the panel lands at the point where the finger let go, and in landscape every orb keeps a fixed width."),
      it("fix", "橡皮和铅笔的足迹指示以前和实际涂抹的区域对不齐，现在精确对齐，并且跟着手指一起移动。", "The eraser and pencil footprint marker used to be misaligned with the painted/erased area; it now lines up exactly and follows the finger."),
    ],
  },
  {
    v: "1.0.1",
    date: "2025-09-07",
    items: [
      it("add", "图层×帧矩阵时间轴：支持多图层多帧的动画编辑，图层可增删与合并，帧可增删，带洋葱皮。", "Layer×frame matrix timeline for animation with several layers and frames: add, delete or merge layers, add or delete frames, onion skin included."),
      it("add", "新建了操作历史与过程回放：从空白状态一步步重放整段绘画过程，重放速度可调。", "Operation history and replay: it replays the whole drawing session from a blank canvas, step by step, at an adjustable speed."),
      it("add", "新建了浮动球停靠区：暂时不用的浮动球拖到屏幕边缘收起，在边缘滑动就能再滑出来。", "Floating-ball dock: move orbs you do not need to the screen edge to park them, then swipe them back out."),
      it("add", "魔法球做了描边、反色、灰度三个特效，点一下就直接作用到画面上。", "The Magic Ball got three effects: outline, invert and grayscale. One tap applies one to the artwork."),
      it("add", "参考图可以导入当预览：能拖动、能双指缩放，还能直接在图上点按或拖动吸色。", "You can import a reference image as a preview: drag it around, pinch to resize it, and pick colours by tapping or dragging right on the picture."),
      it("add", "菜单里多了一项「更新日志」，装了新版本后第一次打开会自动弹出来。", "The menu gained a release-notes entry. It opens on its own the first time you launch the app after an update."),
      it("fix", "修复选中的颜色和画出来的颜色不一致：残留的透明色让新颜色画出来像橡皮擦，选黑色会画出白色。", "Fixed the picked colour not matching the drawn colour: leftover transparency made a new colour behave like an eraser, so black drew as white."),
      it("fix", "色块改成垫着棋盘格显示透明度，透明槽位不再画成黑色。", "Swatches now show transparency over a checkerboard instead of painting transparent slots as black."),
      it("fix", "修复添加或移动图层后帧里的内容错位，引擎回归测试覆盖了这一条。", "Fixed cel content shifting after a layer was added or moved. Engine regression tests cover this."),
      it("imp", "选色取到的颜色一律不透明地画上去，要半透明就拉「不透明度」滑块；取色器可以吸取透明背景。", "A picked colour is now applied fully opaque; for translucency use the opacity slider. The eyedropper can pick up transparent background."),
      it("imp", "时间轴开关加了过渡动画，长按进度条会填充，快速色轮、菜单与色块也补上了入场动画。", "The timeline panel opens and closes with a transition, hold-to-drag sliders fill up, and the quick colour wheel, menus and chips got entrance animations."),
      it("imp", "精简菜单：移除了「操作说明」和「清空当前帧」两个入口。", "Menu trimmed: the in-app help and Clear current frame entries were removed."),
    ],
  },
  {
    v: "1.0.0",
    date: "2025-09-06",
    items: [
      it("add", "首个发布版本：像素画布加上全套绘画与选择工具（铅笔、橡皮、油漆桶、取色器、直线、矩形、椭圆、正圆、多边形、选区、魔棒、套索）", "First release: a pixel canvas with the full set of drawing and selection tools (pencil, eraser, bucket, eyedropper, line, rect, ellipse, circle, polygon, select, wand, lasso)"),
      it("add", "双指缩放和平移画布，笔刷大小与不透明度可调。", "Pinch to zoom and pan the canvas, with adjustable brush size and opacity."),
      it("add", "前景与背景两个色槽、内置色板，还有色轮和快速取色。", "Foreground and background colour slots, built-in palettes, a colour wheel and a quick picker."),
      it("add", "图层与帧编辑、画布/精灵缩放、工程保存与打开；PNG/GIF 也能导入导出。", "Layer and frame editing, canvas/sprite resizing, and project save/open. PNG/GIF files can be imported and exported."),
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
  const pc = useKitPcMode();
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
      <Dialog title={t("changelog")} onClose={onClose} className={"clg-dlg" + (pc ? " clg-dlg-pc" : "")} guide="dlg-changelog">
        {/* PC：版本竖排列表（左），选中项的内容显示在右侧；触屏仍用横向标签条 */}
        {pc && (
          <div className="clg-vers">
            {CHANGELOG.map((v, i) => (
              <button key={v.v} type="button"
                className={"clg-veritem" + (i === vi ? " on" : "")}
                onClick={() => setVi(i)}>
                <span className="clg-veritem-v">{v.v}{v.v === APP_VERSION ? " *" : ""}</span>
                <span className="clg-veritem-d">{v.date}</span>
              </button>
            ))}
          </div>
        )}
        {!pc && (
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
        )}
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
      </Dialog>
    </>
  );
}
