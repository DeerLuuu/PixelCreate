// 功能入口图标表。
//
// 约定（真机反馈「新功能图标重复，分不清哪个是哪个」）：
//   * **每个功能入口都有自己的 SVG**，画在 `app2/www/index.html` 的 sprite 里；
//   * 同一组 = **同一屏上会同时出现**的一批入口，组内图标不得重复；
//   * 想复用别的功能的图标，说明它们其实是同一个动作（比如自由变换里的「重置」与
//     「还原」都走 `View.revertXf()`）—— 那就用 `FEATURE_ICONS.x.reset` 引用同一个值，
//     别在调用点各写一份字面量，免得以后改一处漏一处。
//
// `tests/icons.test.ts` 会静态校验：组内唯一，且每个图标在 sprite 里真实存在。
// 新增功能时先在这里登记 + 画一个新 SVG，再去接入口。
export const FEATURE_ICONS = {
  /** 主菜单首屏（`ui/modals.tsx` 的 MenuModal） */
  menu: {
    newProject: "i-new",
    save: "i-save",
    export: "i-export",
    open: "i-open",
    import: "i-import",
    colorAnalysis: "i-ca",
    shading: "i-shade",
    iso: "i-iso",
    settings: "i-gear",
    shortcuts: "i-keys",
    customise: "i-grid",
    guide: "i-guide",
    changelog: "i-news",
  },
  /** 调色板面板顶部那一排动作（同一行同时可见） */
  palette: {
    indexed: "i-indexed",
    remap: "i-remap",
    dedupe: "i-dedupe",
    fromCanvas: "i-pal-from-canvas",
    colorAnalysis: "i-ca",
    shading: "i-shade",
  },
  /** 魔法球（fx）：日常效果 + 等距图形入口 */
  fxOrb: {
    iso: "i-iso",
    outline: "i-fx-o1",
    inline: "i-fx-inline",
    round: "i-fx-round",
    blur: "i-fx-blur",
    crop: "i-fx-crop",
    shadow: "i-fx-shadow",
    clear: "i-clear",
    glow: "i-fx-glow",
    invert: "i-fx-inv",
    gray: "i-fx-gray",
    center: "i-fx-ctr",
  },
  /**
   * 选择球（sel）：手机分四页，**电脑模式四页铺成一屏**，所以整组一起算。
   * 页 1 的复制 / 剪切 / 粘贴只在手机出现，电脑模式由快捷键接管，故不入表。
   */
  selRing: {
    all: "i-sel-all",
    invert: "i-sel-invert",
    clear: "i-sel-none",
    fill: "i-bucket",
    aspect: "i-resize-mode",
    angleSnap: "i-rotate",
    gridSnap: "i-snap",
    copyOnXf: "i-dupe",
    pivot: "i-sym",
    reset: "i-undo",
    quad: "i-skew",
    mesh: "i-mesh",
    done: "i-check",
    halfSnap: "i-snap-half",
    crop: "i-fx-crop",
    fliph: "i-fliph",
    flipv: "i-flipv",
    grow: "i-sel-grow",
    shrink: "i-sel-shrink",
    outline: "i-fx-o1",
    del: "i-sel-del",
  },
  /** 等距图形参数条（`ui/iso.tsx` 的 IsoBar） */
  isoBar: {
    generate: "i-plus",
    newLayer: "i-layers",
    look: "i-palette",
  },
} as const;
