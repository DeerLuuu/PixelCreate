import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import { SESSION } from "./ui/singleton";
import { makeT } from "./ui/i18n";
import { backAction, type BackState } from "./ui/back";
import { applyTheme } from "./io/theme";
import { applyPcMode, pcModeOf, watchPcCapabilities } from "./io/pcmode";
import { setHoverTipsEnabled } from "./ui/kit";
import * as bridge from "./io/bridge";
import { APP_VERSION } from "./ui/changelog";
import { AI_SERVE_REASON_KEYS, installAiServe } from "./app/ai-serve";
import { aiServeSettings } from "./app/settings";

// colour theme before the first paint (prefs are read synchronously in Session)
applyTheme(SESSION.prefs.theme);
// desktop extras (wheel zoom / hover / shortcuts) follow the pointer, not the UA
setHoverTipsEnabled(applyPcMode(pcModeOf(SESSION.prefs)));
watchPcCapabilities(() => pcModeOf(SESSION.prefs), setHoverTipsEnabled);
// 设置里切换「电脑模式」后，界面层（浮动球尺寸/排布等）也要立刻跟上
SESSION.subscribe(() => setHoverTipsEnabled(applyPcMode(pcModeOf(SESSION.prefs))));
const host = document.getElementById("root");
if (!host) throw new Error("no #root");
createRoot(host).render(<App />);
// restore last autosaved project when available
void (async () => {
  try {
    const { SESSION } = await import("./ui/singleton");
    // 先问「上次是不是正常退出」（这一步同时把"本次正在运行"的标记写下去，
    // 必须先于任何自动保存写入），再恢复最新一版；崩溃时 Session 会挂出恢复面板
    await SESSION.checkBootCrash();
    await SESSION.restoreAutosave(); // brings back every open canvas
    // bring back the floating reference image as well
    await SESSION.restoreRefImage();
  } catch { /* ignore */ }
})();

// surface toast events from bridge-less environments
window.addEventListener("pc-toast", ((e: Event) => {
  const msg = (e as CustomEvent<string>).detail;
  let t = document.querySelector<HTMLDivElement>(".toast");
  if (!t) {
    t = document.createElement("div");
    t.className = "toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add("show");
  window.setTimeout(() => t.classList.remove("show"), 1800);
}) as EventListener);

// Android back gesture / button.
//
// 1. anything layered on top is dismissed (dialogs, panels, floating-ball
//    rings, the onboarding tour, an active selection) - each one answers the
//    "pc-back" event and reports whether it consumed the press
// 2. with nothing left to close the first press only warns, and a second
//    press within two seconds actually leaves the app
const backState: BackState = { warnAt: 0 };
(window as unknown as { __pc_back: () => boolean }).__pc_back = () => {
  // the onboarding tour is the topmost layer and answers pc-back itself, so a
  // dialog underneath it must not swallow the press first
  const guiding = !!document.querySelector(".guide-layer");
  // overlays with a mask are simply clicked shut
  const mask = guiding ? null : document.querySelector<HTMLElement>(".dlg-mask, .panel-mask, .fly-mask");
  if (mask) {
    mask.click();
    backAction(true, backState, Date.now());
    return true;
  }
  // React-side handlers (ball rings, tour, selection) claim the press
  const detail: { handled: boolean } = { handled: false };
  window.dispatchEvent(new CustomEvent("pc-back", { detail }));
  const act = backAction(detail.handled, backState, Date.now());
  if (act === "exit") return false;
  if (act === "warn") {
    window.dispatchEvent(new CustomEvent("pc-toast", { detail: makeT(SESSION.prefs.lang)("backExitHint") }));
  }
  return true;
};

// ------------------------------------------------------------------ C3 本地 AI 端口服务
//
// 设置 → AI 服务 里打开（默认关闭，只绑 127.0.0.1）。这里只做接线：
//   · 是否启动 / 端口 / 放行档位都读 src/app/settings.ts 的声明（ai.server / ai.port / ai.tier），
//     用户改设置时会即时起停（ai-serve 订阅了那个存储）；
//   · **回合空闲收尾显式接线**（`ai.turnIdleSec`，默认 300s）：用函数形式现读设置项，
//     既保证「不传也武装守卫」这条兜底落在生产路径上，又让改设置立刻生效（不钉死在启动那一刻）；
//   · 启动成功 / 绑定失败 / 停止时用既有 toast 提示端口与 token；
//   · 浏览器与 PWA 里没有 `window.PixelBridge.aiServerStart`，installAiServe 会全部降级成 no-op，
//     不会占端口也不会抛。
// 诊断入口：控制台 `__pcAi.text()`（一行）或 `__pcAi.status()`（对象）。
installAiServe({
  session: SESSION,
  version: APP_VERSION,
  turnIdleSec: () => aiServeSettings().turnIdleSec,
  notice: (n) => {
    const t = makeT(SESSION.prefs.lang);
    const msg = n.running
      ? t("aiServerNoticeOn").replace("{port}", String(n.port)).replace("{token}", n.token)
      : t("aiServerNoticeOff").replace("{reason}", t(AI_SERVE_REASON_KEYS[n.reason]));
    bridge.toast(msg);
  },
  log: (line) => {
    try {
      console.info(line);
    } catch {
      /* 控制台不可用也不算什么 */
    }
  },
});
