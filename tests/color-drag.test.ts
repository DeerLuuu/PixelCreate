// Colour drag & drop arbitration (src/ui/color-drag.ts).
//
// Two controls share the gesture: the palette fan's colour balls and the
// toolbar colour chip. The chip ALSO opens its quick colour wheel on a hold, so
// the rule "a hold wins, an early move is a drag" is what keeps tap / hold /
// drag from fighting. Only the pure decision is testable here; the painting
// itself is covered by the View.quickFill assertions in tests/view.test.ts.
import { DRAG_START, TIP_MS, holdAllowed } from "../src/ui/color-drag";
import { HOLD_MS } from "../src/ui/hold";
import { eq, ok } from "./common";

const HOLD = HOLD_MS;   // the toolbar chip's long-press delay (from hold.tsx)

export function testColorDrag(): void {
  eq("colordrag.threshold", DRAG_START, 8);
  ok("colordrag.tip-after-hold", TIP_MS > HOLD, "tip=" + TIP_MS + " hold=" + HOLD);

  // a real hold: due, finger still on the control, never moved past the threshold
  eq("colordrag.hold.ok", holdAllowed(0, HOLD, HOLD), true);
  eq("colordrag.hold.wobble", holdAllowed(DRAG_START - 1, HOLD + 200, HOLD), true);
  // not due yet -> never fires early
  eq("colordrag.hold.early", holdAllowed(0, HOLD - 1, HOLD), false);
  // moving past the threshold turns the press into the fill gesture
  eq("colordrag.hold.moved", holdAllowed(DRAG_START, HOLD, HOLD), false);
  eq("colordrag.hold.moved-far", holdAllowed(60, HOLD, HOLD), false);
  // the finger left the button before the wheel was summoned: stay silent
  eq("colordrag.hold.left-control", holdAllowed(0, HOLD, HOLD, false), false);
  eq("colordrag.hold.left-and-moved", holdAllowed(30, HOLD + 500, HOLD, false), false);
  // a custom threshold still works (explicit argument)
  eq("colordrag.hold.custom-threshold", holdAllowed(12, HOLD, HOLD, true, 20), true);
  // the palette fan has no hold action at all, so it never asks
  eq("colordrag.tip.after-hold", TIP_MS, 450);
}
