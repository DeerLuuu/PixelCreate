import { createRoot } from "react-dom/client";
import { App } from "./ui/App";

const host = document.getElementById("root");
if (!host) throw new Error("no #root");
createRoot(host).render(<App />);
// restore last autosaved project when available
void (async () => {
  try {
    const { SESSION } = await import("./ui/singleton");
    const doc = await SESSION.restoreAutosave();
    if (doc) SESSION.replaceDoc(doc);
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

(window as unknown as { __pc_back: () => boolean }).__pc_back = (() => {
  return () => {
    // Close overlays via click on masks
    const mask = document.querySelector<HTMLElement>(".dlg-mask, .panel-mask");
    if (mask) {
      mask.click();
      return true;
    }
    return false;
  };
})();
