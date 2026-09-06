/* PixelCraft i18n */
(function () {
  const zh = {
    appName: "像素工坊", appSub: "PixelCraft",
    tools: { pencil: "铅笔", eraser: "橡皮", bucket: "油漆桶", picker: "取色器", line: "直线", rect: "矩形描边", rectfill: "矩形填充", ellipse: "椭圆描边", ellipsefill: "椭圆填充", select: "选区", hand: "抓手/平移", zoom: "缩放" },
    undo: "撤销", redo: "重做", save: "保存工程", open: "打开工程", menu: "菜单",
    layers: "图层", layerAdd: "新建图层", layerDupe: "复制图层", layerDel: "删除图层", layerUp: "上移", layerDown: "下移", layerMerge: "向下合并", visible: "可见", locked: "锁定",
    palette: "调色板", paletteAdd: "添加颜色", paletteDel: "删除颜色",
    newDoc: "新建画布", importImg: "导入图片", exportMenu: "导出", settings: "设置",
    frames: "帧", frameAdd: "新建帧", frameDupe: "复制帧", frameDel: "删除帧", frameDur: "帧时长(毫秒)", fps: "播放速度", onion: "洋葱皮", play: "播放", pause: "暂停",
    brush: "笔刷", brushSize: "笔刷大小", opacity: "不透明度", blend: "混合模式",
    blendModes: { normal: "正常", multiply: "正片叠底", screen: "滤色", overlay: "叠加", darken: "变暗", lighten: "变亮", dodge: "颜色减淡", burn: "颜色加深", hardlight: "强光", softlight: "柔光", difference: "差值", exclusion: "排除" },
    sel: { active: "选区模式", clear: "清除选区", fill: "填充选区", cut: "剪切", copy: "复制", paste: "粘贴", move: "移动选区", fliph: "水平翻转", flipv: "垂直翻转", all: "全选" },
    onionNone: "关闭洋葱皮", onionPrev: "显示前帧", onionBoth: "前后帧",
    grid: "像素网格", checker: "透明底纹",
    confirm: "确定", cancel: "取消", close: "关闭", ok: "好", save: "保存", del: "删除", yes: "是", no: "否", name: "名称", width: "宽度", height: "高度",
    lang: "界面语言", langZh: "中文", langEn: "English",
    exportPng: "导出 PNG(当前帧)", exportGif: "导出 GIF(动画)", exportSheet: "导出精灵表 PNG+JSON",
    exportGifOpts: "GIF 选项", transparentBg: "透明背景", includeBg: "填充白色背景", scaleExport: "导出放大倍数",
    toasts: { saved: "已保存", saveCancel: "已取消保存", opened: "已打开：", openCancel: "已取消打开", exportDone: "导出成功", docLoaded: "工程已加载", noSelArea: "没有可用的选区内容", pasted: "已粘贴", copied: "已复制", cut: "已剪切", cleared: "已清除",
      fillDone: "填充完成", mergeDone: "已合并", newDocCreated: "新画布已创建", importOk: "导入成功", importFail: "图片解析失败", autosaveFail: "自动保存失败(画布过大)", layerCount: "图层", frameCount: "帧", emptyProj: "空的工程文件", badFile: "无法识别的文件" },
    projectExt: "像素工坊工程", gifNote: "提示：GIF 颜色将被压缩到 256 色以内。",
    wip: "此功能开发中",
    pickColor: "取色：在画布上点击取色（当前帧已合并颜色）",
    frameLongPress: "长按帧可设时长", backExit: "再按一次返回键退出",
    helpSheet: "操作帮助",
    helpText: "· 单指 = 当前工具绘图\n· 双指 = 平移 / 缩放画布\n· 双指捏合 = 缩放\n· 触控笔支持压感(笔刷粗细)\n· 长按画布 = 快速取色\n· 右侧面板可管理图层/帧/颜色",
    autosaveNote: "自动保存已开启：退出应用前请用“保存”导出工程文件。",
    clearDoc: "清空当前帧", newLayerNote: "新图层将添加到当前层上方。",
    overMax: "画布过大(>1024px)，已限制。",
    ui: { doc: "文档", edit: "编辑", view: "视图", help: "帮助" },
    deselect: "取消选择", moveMode: "移动模式",
    currentFrame: "当前帧", durMs: "毫秒",
  };

  const en = {
    appName: "PixelCraft", appSub: "Pixel Art Studio",
    tools: { pencil: "Pencil", eraser: "Eraser", bucket: "Fill", picker: "Eyedropper", line: "Line", rect: "Rect (outline)", rectfill: "Rect (filled)", ellipse: "Ellipse (outline)", ellipsefill: "Ellipse (filled)", select: "Select", hand: "Hand / Pan", zoom: "Zoom" },
    undo: "Undo", redo: "Redo", save: "Save project", open: "Open project", menu: "Menu",
    layers: "Layers", layerAdd: "New layer", layerDupe: "Duplicate layer", layerDel: "Delete layer", layerUp: "Move up", layerDown: "Move down", layerMerge: "Merge down", visible: "Visible", locked: "Locked",
    palette: "Palette", paletteAdd: "Add color", paletteDel: "Remove color",
    newDoc: "New canvas", importImg: "Import image", exportMenu: "Export", settings: "Settings",
    frames: "Frames", frameAdd: "New frame", frameDupe: "Duplicate frame", frameDel: "Delete frame", frameDur: "Frame duration (ms)", fps: "Playback", onion: "Onion skin", play: "Play", pause: "Pause",
    brush: "Brush", brushSize: "Brush size", opacity: "Opacity", blend: "Blend mode",
    blendModes: { normal: "Normal", multiply: "Multiply", screen: "Screen", overlay: "Overlay", darken: "Darken", lighten: "Lighten", dodge: "Color dodge", burn: "Color burn", hardlight: "Hard light", softlight: "Soft light", difference: "Difference", exclusion: "Exclusion" },
    sel: { active: "Selection", clear: "Clear selection", fill: "Fill selection", cut: "Cut", copy: "Copy", paste: "Paste", move: "Move selection", fliph: "Flip H", flipv: "Flip V", all: "Select all" },
    onionNone: "Onion off", onionPrev: "Previous frame", onionBoth: "Both",
    grid: "Pixel grid", checker: "Transparency",
    confirm: "OK", cancel: "Cancel", close: "Close", ok: "OK", save: "Save", del: "Delete", yes: "Yes", no: "No", name: "Name", width: "Width", height: "Height",
    lang: "Language", langZh: "中文", langEn: "English",
    exportPng: "Export PNG (frame)", exportGif: "Export GIF (animation)", exportSheet: "Export spritesheet PNG+JSON",
    exportGifOpts: "GIF options", transparentBg: "Transparent background", includeBg: "White background", scaleExport: "Export scale",
    toasts: { saved: "Saved", saveCancel: "Save cancelled", opened: "Opened: ", openCancel: "Open cancelled", exportDone: "Exported", docLoaded: "Project loaded", noSelArea: "No selected content", pasted: "Pasted", copied: "Copied", cut: "Cut", cleared: "Cleared",
      fillDone: "Filled", mergeDone: "Merged", newDocCreated: "New canvas created", importOk: "Imported", importFail: "Could not decode image", autosaveFail: "Autosave failed (canvas too large)", layerCount: "Layer", frameCount: "Frame", emptyProj: "Empty project file", badFile: "Unrecognized file" },
    projectExt: "PixelCraft project", gifNote: "Note: GIF colors are limited to 256.",
    wip: "Coming soon",
    pickColor: "Pick color by tapping the canvas",
    frameLongPress: "Long-press a frame to set its duration",
    backExit: "Press back again to exit",
    helpSheet: "Help",
    helpText: "· One finger = draw with current tool\n· Two fingers = pan / zoom\n· Pinch = zoom\n· Stylus pressure supported\n· Long-press canvas = eyedropper\n· Side panels manage layers/frames/colors",
    autosaveNote: "Autosave is on — use Save to export a project file before leaving.",
    clearDoc: "Clear current frame", newLayerNote: "New layer is added above the current one.",
    overMax: "Canvas too large (>1024px). Limited.",
    ui: { doc: "Document", edit: "Edit", view: "View", help: "Help" },
    deselect: "Deselect", moveMode: "Move mode",
    currentFrame: "Current frame", durMs: "ms",
  };

  const langs = { zh: zh, en: en };
  let cur = "zh";
  const PX = window.PX = window.PX || {};
  PX.dicts = langs;
  PX.t = function (key) {
    const d = langs[cur];
    const parts = String(key).split(".");
    let v = d;
    for (const p of parts) { if (v == null) break; v = v[p]; }
    if (v == null) return key;
    return String(v);
  };
  PX.setLang = function (l) { cur = langs[l] ? l : (navigator.language || "").startsWith("zh") ? "zh" : "en"; return cur; };
  PX.getLang = function () { return cur; };
  PX._ = PX.t; // alias
})();
