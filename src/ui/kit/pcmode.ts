// Kit-local PC flag.
//
// The kit never imports the app (docs/UI.md §1.1), so the app pushes the
// resolved PC-mode state in here (main.tsx). Controls that change shape on a
// desktop — hover tooltips, the bigger floating orb — subscribe through
// useKitPcMode().
import { useSyncExternalStore } from "react";

let pcOn = false;
const subs = new Set<() => void>();

export function setKitPcMode(on: boolean): void {
  if (pcOn === on) return;
  pcOn = on;
  for (const f of subs) f();
}

export function kitPcOn(): boolean {
  return pcOn;
}

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  return () => { subs.delete(cb); };
}

export function useKitPcMode(): boolean {
  return useSyncExternalStore(subscribe, kitPcOn, kitPcOn);
}
