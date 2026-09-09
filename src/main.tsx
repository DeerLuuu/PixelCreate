import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import { SESSION } from "./ui/singleton";
import { makeT } from "./ui/i18n";
import { backAction, type BackState } from "./ui/back";

const host = document.getElementById("root");
if (!host) throw new Error("no #root");
createRoot(host).render(<App />);
// restore last autosaved project when available
void (async () => {
  try {
    const { SESSION } = await import("./ui/singleton");
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
  // overlays with a mask are simply clicked shut
  const mask = document.querySelector<HTMLElement>(".dlg-mask, .panel-mask, .fly-mask");
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
