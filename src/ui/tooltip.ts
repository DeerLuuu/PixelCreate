// `tooltip` 是模块级可变单例（订阅表 subs）：库一份 + 宿主一份 = 两个订阅表，
// 控件的长按提示会写进库的表而宿主 TipHost 订阅宿主那份，提示静默消失（docs/PLAN-deer-ui.md R10）。
// 所以实现只留在 deer-ui 里，宿主这一层只做再导出。
export * from "deer-ui/tooltip";