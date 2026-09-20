// 实现已迁进独立库 deer-ui（docs/PLAN-deer-ui.md P0b 甲案）：
// 本文件只剩薄再导出层，公开路径保持不变 —— 应用侧 import 与测试路径一字不改。
// 库的 exports 只暴露 `./kit` 一个控件入口，所以 kit 的 7 个子路径都指向它。
export * from "deer-ui/kit";