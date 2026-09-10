// Value scrubbing: wheel notches and pointer-drag rate (src/engine/scrub.ts).
//
// The regression this guards: a single light wheel flick used to move a number
// field all the way (1 -> 64), because every wheel EVENT applied one step and a
// browser slices one mouse notch into 10-40 events.
import { SCRUB_DEAD_PX, scrubRatePerPx, scrubValue, takeNotches, wheelNotches } from "../src/engine/scrub";
import { eq, ok } from "./common";

export function testScrub(): void {
  // one classic mouse notch (deltaMode 0, 100px) = exactly one notch
  eq("scrub.wheel.notch", wheelNotches(100, 0), 1);
  eq("scrub.wheel.notch-up", wheelNotches(-100, 0), -1);
  // Firefox reports lines: 3 lines = one notch
  eq("scrub.wheel.lines", wheelNotches(3, 1), 1);
  eq("scrub.wheel.pages", wheelNotches(1, 2), 1);

  // a "smooth scrolling" notch arrives as a burst of small deltas …
  let acc = 0, steps = 0;
  for (let i = 0; i < 20; i++) {
    const t = takeNotches(acc + wheelNotches(5, 0));
    acc = t.rest; steps += Math.abs(t.steps);
  }
  eq("scrub.wheel.burst-one-step", steps, 1);        // … and still moves once
  // but a long deliberate scroll keeps moving (no starving)
  let steps2 = 0;
  for (let i = 0; i < 60; i++) {
    const t = takeNotches(acc + wheelNotches(5, 0));
    acc = t.rest; steps2 += Math.abs(t.steps);
  }
  eq("scrub.wheel.sustained", steps2, 3);
  // the leftover travel carries over instead of being dropped
  const t3 = takeNotches(0.6);
  eq("scrub.wheel.rest", { steps: 0, rest: 0.6 }, t3);

  // drag rate: a small range must not fly (9-10px per unit for 0..63)
  const rate63 = scrubRatePerPx(1, 64);
  ok("scrub.rate.small", Math.abs(rate63 - 63 / 600) < 1e-9, "rate=" + rate63);
  ok("scrub.rate.small-px", 1 / rate63 > 8 && 1 / rate63 < 12, "px per unit=" + (1 / rate63));
  // an explicit step gets a fixed 8px of travel
  eq("scrub.rate.step", scrubRatePerPx(0, 100, 2), 0.25);
  // a huge range never moves more than 1 unit per pixel
  eq("scrub.rate.huge", scrubRatePerPx(0, 4096), 1);
  // no bounds at all: 8px per unit
  eq("scrub.rate.none", scrubRatePerPx(), 0.125);

  // values: 30px of drag on 1..64 moves ~3 units and stays inside the bounds
  eq("scrub.value.drag", scrubValue(1, 30, 1, 64), 4);
  eq("scrub.value.clamp-max", scrubValue(60, 400, 1, 64), 64);
  eq("scrub.value.clamp-min", scrubValue(4, -400, 1, 64), 1);
  eq("scrub.value.back", scrubValue(30, -30, 1, 64), 27);
  ok("scrub.dead-zone", SCRUB_DEAD_PX === 4);
}
