// Android back-gesture decision (pure, unit tested).
//
// The native shell asks the web layer first (`window.__pc_back`); this decides
// what a single press means so the app never quits on the first tap.
export interface BackState {
  /** timestamp of the warning press, 0 = none pending */
  warnAt: number;
}

export type BackAction = "close" | "warn" | "exit";

/**
 * @param handled true when an overlay consumed the press
 * @param state   mutable warning state (shared across presses)
 * @param now     current timestamp
 * @param windowMs how long the first warning stays valid
 */
export function backAction(handled: boolean, state: BackState, now: number, windowMs = 2000): BackAction {
  if (handled) {
    // closing something always cancels a pending "press again to exit"
    state.warnAt = 0;
    return "close";
  }
  if (state.warnAt !== 0 && now - state.warnAt < windowMs) {
    state.warnAt = 0;
    return "exit";
  }
  state.warnAt = now;
  return "warn";
}
