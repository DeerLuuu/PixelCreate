// Android back-gesture decision: a single press must never quit the app.
import { backAction, type BackState } from "../src/ui/back";
import { eq } from "./common";

export function testBack(): void {
  const s: BackState = { warnAt: 0 };
  // nothing to close: the first press only warns
  eq("back.first", backAction(false, s, 1000), "warn");
  // a second press within the window leaves the app
  eq("back.second", backAction(false, s, 2500), "exit");
  eq("back.reset-after-exit", s.warnAt, 0);
  // and the warning is armed again
  eq("back.after-exit", backAction(false, s, 2600), "warn");

  // a slow second press warns again instead of exiting
  const slow: BackState = { warnAt: 0 };
  eq("back.slow.first", backAction(false, slow, 0 + 1), "warn");
  eq("back.slow.second", backAction(false, slow, 3000), "warn");
  eq("back.slow.third", backAction(false, slow, 4000), "exit");

  // closing an overlay cancels the pending warning
  const closable: BackState = { warnAt: 0 };
  eq("back.close.warn", backAction(false, closable, 500), "warn");
  eq("back.close.handled", backAction(true, closable, 600), "close");
  eq("back.close.reset", closable.warnAt, 0);
  eq("back.close.next-press-warns", backAction(false, closable, 700), "warn");

  // custom window
  const w: BackState = { warnAt: 0 };
  eq("back.window.first", backAction(false, w, 100, 500), "warn");
  eq("back.window.too-late", backAction(false, w, 700, 500), "warn");
}
