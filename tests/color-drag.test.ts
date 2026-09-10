// Colour drag & drop arbitration (src/ui/color-drag.ts).
//
// Two controls share the gesture: the palette fan's colour balls and the
// toolbar colour chip. The chip ALSO opens its quick colour wheel on a hold, so
// the rule "a hold wins, an early move is a drag" is what keeps tap / hold /
// drag from fighting. Only the pure decision is testable here; the painting
// itself is covered by the View.quickFill assertions in tests/view.test.ts.
import { DRAG_START, TIP_MS, gestureIntent } from "../src/ui/color-drag";
import { HOLD_MS } from "../src/ui/hold";
import { eq, ok } from "./common";

const HOLD = HOLD_MS;   // the toolbar chip's long-press delay (from hold.tsx)

export function testColorDrag(): void {
  eq("colordrag.threshold", DRAG_START, 8);
  ok("colordrag.tip-after-hold", TIP_MS > HOLD, "tip=" + TIP_MS + " hold=" + HOLD);

  // the palette fan has no hold action: any movement past the threshold drags
  eq("colordrag.fan.still", gestureIntent(0, 5000, Number.POSITIVE_INFINITY), "pending");
  eq("colordrag.fan.small-move", gestureIntent(7, 5000, Number.POSITIVE_INFINITY), "pending");
  eq("colordrag.fan.drag", gestureIntent(8, 20, Number.POSITIVE_INFINITY), "drag");

  // the toolbar chip: moving before the hold delay starts a fill drag…
  eq("colordrag.chip.early-drag", gestureIntent(20, 100, HOLD), "drag");
  eq("colordrag.chip.exactly-threshold", gestureIntent(DRAG_START, 100, HOLD), "drag");
  // …but once the hold fired the wheel owns the gesture, even while moving
  eq("colordrag.chip.hold-wins", gestureIntent(40, HOLD, HOLD), "hold");
  eq("colordrag.chip.hold-later", gestureIntent(200, 900, HOLD), "hold");
  // holding still stays pending until the hold fires
  eq("colordrag.chip.pending", gestureIntent(2, 120, HOLD), "pending");
  // a custom threshold still works (explicit argument)
  eq("colordrag.custom", gestureIntent(12, 10, HOLD, 20), "pending");
}
