# PixelCraft 像素工坊 · Web 版

这个分支**只放部署用的静态站点**（GitHub Pages 直接发布根目录），
源码与 APK 工程全部在 [`master`](https://github.com/DeerLuuu/PixelCreate/tree/master) 分支上管理。

## 在线地址

- 应用：https://deerluuu.github.io/PixelCreate/
- 手机浏览器打开后可「添加到主屏幕」当应用使用（无需服务器，全部离线可跑，只是没有 Service Worker 缓存）

## 目录内容

| 路径 | 说明 |
|---|---|
| `index.html` | 单页入口（含内联 SVG 图标精灵） |
| `js/app.js` | 打包后的应用（React 已打进同一个 IIFE，无外部依赖） |
| `js/lib/omggif.js` | GIF 解码（导入 GIF 用） |
| `js/telemetry.js` | 调试用遥测：只往本地 devserver 的 `/log` 发；部署在 Pages 上会静默失败，可忽略 |
| `css/style.css` | 唯一样式表（含设计令牌与浅色主题） |
| `icons/`、`manifest.webmanifest` | PWA 图标与清单 |
| `.github/workflows/pages.yml` | Pages 部署 workflow（Actions 构建 + 发布，带站点文件校验） |
| `.nojekyll` | 关闭 Jekyll 处理 |

## 不要手工改这个分支

这里的文件是**构建产物**。更新方式：在 `master` 分支执行

```sh
sh scripts/publish-web.sh --push
```

它会重新构建 Web 包，把 `app2/www`（排除开发用的 `ui-demo.*`）+ `web/` 下的部署文件
（workflow / 本 README / `.nojekyll`）写成本分支的一次新提交并推送。
`web/` 是 master 上这些部署文件的唯一来源，改部署配置请改那里。

## 与 APK 版的差别

网页版没有原生壳（`window.PixelBridge`）提供的能力：

- 震动反馈、屏幕常亮、状态栏/导航栏隐藏（网页版改用顶栏右侧的全屏按钮）
- 直接写入相册 / 文件系统的保存通道（网页版走浏览器的下载）

绘制、图层与帧、洋葱皮、导出 PNG/GIF/精灵表并下载、工程 `.pxc` 保存与打开、调色板拖拽填充
等功能在网页版都正常。
