# PixelCraft 像素工坊

面向手机/平板的像素画与逐帧动画编辑器。**TypeScript + React 18 + Canvas**，同一套源码同时产出：

- **Android APK**（自研无 Gradle 打包链，WebView + 原生桥接）
- **PWA / 网页版**（`app2/www`，可离线安装）

> 定位：把桌面像素画软件（Aseprite 风格）的算法搬到触屏，免费、无广告、可自用移植。
> 与 Aseprite / Resprite 的详细对比见 [`docs/COMPARISON.md`](docs/COMPARISON.md)。

---

## 1. 功能一览

| 模块 | 能力 |
|---|---|
| 绘制 | 铅笔 / 橡皮 / 油漆桶（连续·全局）/ 取色器；直线 / 矩形 / 椭圆 / 圆 / 多边形；笔刷 1–64、不透明度、压感（`pointerType === "pen"`） |
| 选区 | 框选 / 魔棒（容差）/ 套索；全选、反选、清空、填充、复制、剪切、粘贴、水平·垂直翻转、扩展、收缩、描边、删除；移动 / 旋转 / 缩放（仿射） |
| 图层 | 显示、锁定、不透明度、12 种混合模式、重命名、新增 / 复制 / 上下移 / 向下合并 / 删除、长按拖拽重排 |
| 帧 | 新增 / 复制 / 删除 / 拖拽重排 / 单帧时长；**多选帧**批量复制、删除、统一时长 |
| 播放 | 单次 / 循环 / 乒乓 / 倒流，逐帧时长驱动 |
| 洋葱皮 | 前后帧数（0–3）、不透明度、着色（前红后绿）、**循环环绕**（首末帧用蓝/琥珀色区分） |
| 对称 | 可旋转对称轴 0/45/90/135、四向对称、轴锁定 |
| 调色板 | HSV 色轮 + HEX + 预设色板；色板 / 画布颜色 / 最近使用三种来源；长按色块全局换色；**去重 / 按色相·明度排序 / 合并预设色板**；`.gpl` 导入导出 |
| 特效 | 描边、投影、外发光、反色、灰度、居中、智能裁剪 |
| 导出 | PNG（整帧 / 图层 / 选区 + 倍率 + 背景）、GIF（**帧范围**、逐帧时长、透明）、精灵表 + JSON、调色板 `.gpl`、分图层批量导出 |
| 导入 | 图片（新建 / 作为图层）、精灵表按单元格切帧、参考图浮窗、色板 |
| 工程 | `.pxc` 工程文件、IndexedDB 自动保存与恢复、设置文件导入导出 |
| 交互 | 双指缩放/平移、三连击 2× 放大、边距双击撤销、双指双击重做、四指打开全部帧预览、像素放大镜、边缘自动平移、**返回手势逐层关闭 + 二次确认退出** |
| 体验 | 声明式设置（搜索 / 单项恢复默认 / 分组折叠）、41 步模块化新手引导（真操作演示）、更新日志、操作记录与回放、帧预览、中英双语 |
| 渲染 | 增量渲染：笔迹脏矩形合成 + 局部重绘 + rAF 合并；洋葱皮幽灵帧缓存；选区染色按版本缓存 |

---

## 2. 快速开始

```bash
npm install            # 安装开发依赖（React / TypeScript / esbuild）

npm run typecheck      # tsc 严格检查
npm test               # 392 项引擎 / 逻辑回归测试
npm run build          # 产出 app2/www/js/app.js + css/style.css
```

本地预览（手机/桌面浏览器打开）：

```bash
node toolchain/devserver.js      # http://127.0.0.1:8090/  （静态服务 + /diag + /log）
```

打包 APK（需要 `toolchain/` 里的 aapt2 / d8 / apksigner，脚本自动调用）：

```bash
bash build.sh          # aapt2 + javac + d8 + apksigner，产出 build/PixelCraft.apk
```

---

## 3. 目录结构

```
src/
├─ engine/      纯像素引擎（无 DOM）：doc / cel / paint / shape / effects / ops / history / color / adjust
├─ tools/       工具层：registry（工具表与笔刷状态）、stroke（笔迹引擎）、select（选区与变换）
├─ app/         应用层：session（状态中枢）、settings（设置注册表）、guide（引导注册表）、playback（循环模式）
├─ render/      view（视口 / 手势 / 渲染）、compositor（合成）、rect（脏矩形工具）、onion（洋葱皮布局）
├─ io/          bridge（原生桥接）、exporters、gifread、project（.pxc）、autosave、clipboard
└─ ui/          React 界面：App、timeline、modals、changelog、guide(+demo/layout)、hold、preview、i18n、style.css
tests/          引擎与逻辑测试（无 DOM 依赖，node 直接跑）
android/        自研 APK 工程（AndroidManifest + MainActivity + 图标）
app2/www/       PWA 产物（index.html + 构建后的 app.js/style.css）
toolchain/      打包工具链（aapt2/d8/apksigner/devserver）
```

### 架构要点

- **引擎层零 DOM**：`engine/`、`app/`、`tools/` 全部可在 Node 下测试（392 项测试跑在纯数据上）。
- **声明式注册表**：设置项写在 `src/app/settings.ts`，引导步骤写在 `src/app/guide.ts`；新增功能 = 一条声明 + i18n 文案，界面自动生成。
- **增量渲染**：笔迹只重合成/重绘改动区域（`Rect` + `composeRectInto` + `celToCanvasRect`），一帧一次绘制（rAF 合并）。
- **撤销栈**：`history.pushPixels`（像素）/ `pushStruct`（结构快照）/ `record`（标量前后值）三类，所有破坏性操作都可单步撤销。
- **原生桥接**：`window.PixelBridge`（保存 / 打开 / 震动 / Toast / 常亮），网页端自动降级为 `<a download>` 与 `<input file>`。

---

## 4. 文档

| 文档 | 内容 |
|---|---|
| [`docs/API.md`](docs/API.md) | 各模块 API 接口文档（函数签名、参数、返回值、用法示例） |
| [`docs/COMPARISON.md`](docs/COMPARISON.md) | 与 Aseprite / Resprite 的功能对比与改进优先级 |
| [`NOTES.md`](NOTES.md) | 协作约定：版本号规则、出包流程、声明式优先、提交规范 |

---

## 5. 平台说明

- **Android**：`android/java/com/pixelcraft/app/MainActivity.java` 是单文件 WebView 壳，加载 `assets/www`；`window.__pc_back()` 决定返回键行为（先关层，再二次确认退出）。
- **网页 / PWA**：`app2/www/manifest.webmanifest` 提供安装信息；无 service worker，离线使用请安装 APK。
- **文件读写**：Android 走 SAF（`ACTION_CREATE_DOCUMENT` / `ACTION_OPEN_DOCUMENT`），网页走浏览器下载与文件选择。
