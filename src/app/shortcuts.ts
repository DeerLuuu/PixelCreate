// Keyboard shortcuts (PC mode). Pure key→action mapping, unit tested.
//
// The host (App.tsx) translates the returned action into a Session/View call, so
// the interesting part — which chord means what, and when a chord must be
// ignored (typing in a field, modifier-only presses) — stays testable.
export type ShortcutAction =
  | "undo" | "redo" | "save" | "openFile" | "newDoc" | "exportFile"
  | "copy" | "cut" | "paste" | "delete" | "escape"
  | "pasteLayer" | "pasteCanvas" | "swapColors" | "shortcutHelp" | "resizeMode"
  | "framePrev" | "frameNext" | "layerPrev" | "layerNext"
  | "zoomIn" | "zoomOut" | "fit" | "toggleUI"
  | "tool" | "nudge";

export interface ShortcutHit {
  action: ShortcutAction;
  /** for action === "tool" */
  tool?: string;
  /** for action === "nudge": -1 / 0 / 1 per axis, already scaled by Shift */
  dx?: number;
  dy?: number;
}

/** single-key tool bindings (Aseprite-flavoured where a key is obvious) */
export const TOOL_KEYS: Record<string, string> = {
  b: "pencil",
  e: "eraser",
  g: "bucket",
  i: "picker",
  a: "airbrush",
  l: "line",
  r: "rect",
  o: "ellipse",
  c: "circle",
  p: "polygon",
  y: "polyline",
  u: "curve",
  m: "select",
  w: "wand",
  q: "lasso",
  h: "outline",
};

/** how far an arrow key nudges: 1px, or 10px with Shift */
export const NUDGE_STEP = 1;
export const NUDGE_STEP_FAST = 10;

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
};

export interface ShortcutKey {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

/**
 * @param typing true while a text field / contenteditable has focus: then only
 *               the Ctrl/Cmd chords that never insert text are honoured
 */
export function shortcutFor(e: ShortcutKey, typing = false): ShortcutHit | null {
  const mod = !!(e.ctrlKey || e.metaKey);
  const key = e.key;
  const lower = key.length === 1 ? key.toLowerCase() : key;
  if (mod && e.altKey) {
    // Ctrl+Alt+V: paste as a new canvas
    if (lower === "v") return { action: "pasteCanvas" };
    return null;
  }
  if (mod && !e.altKey) {
    switch (lower) {
      case "z": return { action: e.shiftKey ? "redo" : "undo" };
      case "y": return { action: "redo" };
      case "s": return { action: "save" };
      case "o": return { action: "openFile" };
      case "n": return { action: "newDoc" };
      case "e": return { action: "exportFile" };
      case "c": return { action: "copy" };
      case "x": return { action: "cut" };
      case "v": return { action: e.shiftKey ? "pasteLayer" : "paste" };
      case "F1": return { action: "shortcutHelp" };
      case "r": return { action: "resizeMode" };
      case "ArrowLeft": return { action: "framePrev" };
      case "ArrowRight": return { action: "frameNext" };
      case "ArrowUp": return { action: "layerPrev" };
      case "ArrowDown": return { action: "layerNext" };
    }
    return null;
  }
  if (typing) return null;         // never steal plain keys from a text field
  if (e.altKey) return null;
  if (key === "Delete" || key === "Backspace") return { action: "delete" };
  if (key === "Escape") return { action: "escape" };
  if (key === "+" || key === "=") return { action: "zoomIn" };
  if (key === "-" || key === "_") return { action: "zoomOut" };
  if (key === "0") return { action: "fit" };
  if (key === "Tab") return { action: "toggleUI" };
  if (lower === "x" && !e.shiftKey) return { action: "swapColors" };
  const arrow = ARROWS[key];
  if (arrow) {
    const step = e.shiftKey ? NUDGE_STEP_FAST : NUDGE_STEP;
    return { action: "nudge", dx: arrow[0] * step, dy: arrow[1] * step };
  }
  const tool = TOOL_KEYS[lower];
  if (tool && !e.shiftKey) return { action: "tool", tool };
  return null;
}

/**
 * The cheat sheet behind the Ctrl+F1 panel: every chord the app really handles,
 * plus the mouse vocabulary (which has no key). Each keyboard row carries a
 * `probe`/`action` pair so tests/pc.test.ts can prove the panel never drifts
 * from `shortcutFor`.
 */
export interface SheetItem {
  keys: string;
  zh: string;
  en: string;
  /** keyboard rows only: the chord as `shortcutFor` sees it */
  probe?: ShortcutKey;
  action?: ShortcutAction;
  /** true for rows that document mouse / gesture behaviour */
  mouse?: boolean;
}

export interface SheetGroup {
  zh: string;
  en: string;
  items: SheetItem[];
}

export const SHORTCUT_SHEET: SheetGroup[] = [
  {
    zh: "编辑", en: "Edit",
    items: [
      { keys: "Ctrl+Z", zh: "撤销", en: "Undo", probe: { key: "z", ctrlKey: true }, action: "undo" },
      { keys: "Ctrl+Shift+Z / Ctrl+Y", zh: "重做", en: "Redo", probe: { key: "z", ctrlKey: true, shiftKey: true }, action: "redo" },
      { keys: "Ctrl+C", zh: "复制选区", en: "Copy selection", probe: { key: "c", ctrlKey: true }, action: "copy" },
      { keys: "Ctrl+X", zh: "剪切选区", en: "Cut selection", probe: { key: "x", ctrlKey: true }, action: "cut" },
      { keys: "Ctrl+V", zh: "粘贴到当前画布（帧多选时粘到每一帧）", en: "Paste into the focused canvas (every picked frame)", probe: { key: "v", ctrlKey: true }, action: "paste" },
      { keys: "Ctrl+Shift+V", zh: "粘贴为新图层", en: "Paste as a new layer", probe: { key: "v", ctrlKey: true, shiftKey: true }, action: "pasteLayer" },
      { keys: "Ctrl+Alt+V", zh: "粘贴为新画布", en: "Paste as a new canvas", probe: { key: "v", ctrlKey: true, altKey: true }, action: "pasteCanvas" },
      { keys: "Delete / Backspace", zh: "删除（选区内容 / 当前图层 / 选中帧 / 选中画布）", en: "Delete (selection pixels / layer / frames / canvas)", probe: { key: "Delete" }, action: "delete" },
      { keys: "Esc", zh: "取消选区（有球展开时先收球）", en: "Drop the selection (closes open orbs first)", probe: { key: "Escape" }, action: "escape" },
      { keys: "Ctrl+O", zh: "打开文件 / 导入图片", en: "Open a file / import an image", probe: { key: "o", ctrlKey: true }, action: "openFile" },
      { keys: "Ctrl+N", zh: "新建画布", en: "New canvas", probe: { key: "n", ctrlKey: true }, action: "newDoc" },
      { keys: "Ctrl+E", zh: "导出图片", en: "Export an image", probe: { key: "e", ctrlKey: true }, action: "exportFile" },
    ],
  },
  {
    zh: "视图", en: "View",
    items: [
      { keys: "滚轮", zh: "以光标为中心缩放", en: "Zoom around the cursor", mouse: true },
      { keys: "Shift+滚轮 / Alt+滚轮", zh: "左右 / 上下平移", en: "Pan sideways / vertically", mouse: true },
      { keys: "左键在画布外拖动", zh: "平移视图", en: "Pan the view", mouse: true },
      { keys: "方向键", zh: "平移视图（有选区时改为微移选区）", en: "Pan the view (nudges the selection when there is one)", probe: { key: "ArrowLeft" }, action: "nudge" },
      { keys: "+ / -", zh: "放大 / 缩小", en: "Zoom in / out", probe: { key: "+" }, action: "zoomIn" },
      { keys: "0", zh: "适配画布", en: "Fit the canvas", probe: { key: "0" }, action: "fit" },
      { keys: "Tab", zh: "隐藏界面（专注画画）", en: "Hide the interface (focus mode)", probe: { key: "Tab" }, action: "toggleUI" },
      { keys: "中键", zh: "点哪张画布就聚焦并适配它", en: "Focus and fit the canvas under the cursor", mouse: true },
    ],
  },
  {
    zh: "帧与图层", en: "Frames & layers",
    items: [
      { keys: "Ctrl+← / Ctrl+→", zh: "上一帧 / 下一帧", en: "Previous / next frame", probe: { key: "ArrowLeft", ctrlKey: true }, action: "framePrev" },
      { keys: "Ctrl+↑ / Ctrl+↓", zh: "上一个 / 下一个图层", en: "Previous / next layer", probe: { key: "ArrowUp", ctrlKey: true }, action: "layerPrev" },
      { keys: "Shift+左键点帧", zh: "区间选中（到上一个选中帧为止）", en: "Range-select frames back to the last picked one", mouse: true },
      { keys: "左键拖动帧 / 图层", zh: "直接拖动排序（不用长按）", en: "Drag to reorder (no long press needed)", mouse: true },
      { keys: "双击名称", zh: "重命名图层 / 帧 / 画布", en: "Rename a layer / frame / canvas", mouse: true },
      { keys: "右键点帧", zh: "帧设置", en: "Frame settings", mouse: true },
    ],
  },
  {
    zh: "颜色与工具", en: "Colour & tools",
    items: [
      { keys: "X", zh: "交换前景 / 背景色", en: "Swap foreground / background", probe: { key: "x" }, action: "swapColors" },
      { keys: "按住空格", zh: "临时用背景色绘制（松开回到前景色）", en: "Paint with the background colour while held", mouse: true },
      { keys: "右键拖动", zh: "用另一个色槽绘制", en: "Paint with the other colour slot", mouse: true },
      { keys: "Alt+单击", zh: "吸取该像素颜色", en: "Pick the colour under the pixel", mouse: true },
      { keys: "悬停滚轮", zh: "在数字框 / 长按按钮上调值", en: "Adjust a number field or hold-button", mouse: true },
      { keys: "Ctrl+F1", zh: "打开这份快捷键一览", en: "Open this cheat sheet", probe: { key: "F1", ctrlKey: true }, action: "shortcutHelp" },
      { keys: "Ctrl+R", zh: "画布调整模式（拖四条边改尺寸）", en: "Resize mode (drag the canvas edges)", probe: { key: "r", ctrlKey: true }, action: "resizeMode" },
      { keys: "B / E / G / I / L / R / O / M / W / Q", zh: "铅笔 / 橡皮 / 油漆桶 / 取色 / 直线 / 矩形 / 椭圆 / 选区 / 魔棒 / 套索", en: "Pencil / eraser / bucket / picker / line / rect / ellipse / marquee / wand / lasso", probe: { key: "b" }, action: "tool" },
    ],
  },
];
