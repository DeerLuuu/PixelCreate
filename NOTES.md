# PixelCraft 工程状态速记（会话压缩用）

## 位置与构建
- 源: /storage/emulated/0/Download/ds文件夹/pixelcraft/src（TS+React18）
- 打包: pc2 build = /data/data/com.dsharnessmobile.shell/files/home/pc2/build.sh（拷贝 src→tsc→rollup→写回 pixelcraft/app2/www）
- 类型检查: cd pc2 && node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit（须先把 pixelcraft/src 拷到 pc2/src）
- 浏览器测试: node toolchain/devserver.js（app2/www, 8090，已在后台运行）；PWA manifest 就绪
- 无 git / 无备份：改大文件前先 cp 副本；勿用行号拼接脚本（曾致 App.tsx 截断事故，已重建）

## 关键架构
- Session 单例(app/session.ts): doc/history/prefs/工具状态; changed() 驱动 React(useSyncExternalStore)
- History(engine/history.ts): record(廉价逆向)/pushPixels(像素差分)/pushStruct(全档快照,复杂操作); undo/redo/jumpTo(按 index=undoStack.length); list()
- View(render/view.ts) 接管画布手势; 撤销前 flushStroke
- Shape: 统一栅格 inside+border 实现实心/空心; 图形工具=line/rect/ellipse/circle/polygon; shapeFill 切换空心; polygon sides 3-12
- 浮动球(FloatingTools): 主球/选区球/取色球(pal) 多球互斥(68px)+径向圈净空(166); 旋转 clamp
- 取色: 点击取色球→PalBalls 四分之一扇形色球(新几何: 每环cols按半径自适应防重叠)
- UI 横屏≥768px 侧栏grid(railSwap 对调); 窄屏/横屏wrap
- i18n zh/en 各约110键; tooltip 全局底部中心(长按450ms, title+desc)

## 近期已做
撤销重做全量Command化、调色板入史、滑条合并、导入为图层入史、操作记录HistoryModal(可跳点)、图形重构、形状图标、画布/精灵尺寸(锚点+等比锁)、系统剪贴板、PWA、全屏按钮、多球/扇形取色、PreviewBox 缩小用双线性防丢细线。

## 当前任务热点
- PalBalls 扇形弹球间距调整(正在做：改为按半径自适应列数+环距34px 紧凑排布)
- devserver 已跑旧源码? 改后需 build.sh 重建并硬刷新

## 待办/已知缺口
- app2 产物由 pc2 生成, 工作区无构建配置; 建议后续把 rollup 配置收进 pixelcraft/
- Android APK 仍是旧 vanilla (app/www), 未切 React
