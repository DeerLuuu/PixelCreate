// Radial quick menu ("pie") geometry: even spacing, angular focus and the dead
// zone that lets you release the key without activating anything.
import { PIE_DEAD, PIE_ITEM, pieFocusIndex, pieRadius, pieRadiusFor, pieSlot, pieSlotGap, pieSlots } from "../src/ui/pie-layout";
import { TOOL_KEYS, shortcutFor } from "../src/app/shortcuts";
import { eq, ok } from "./common";

export function testPie(): void {
  // the first slot is straight up and the ring goes clockwise
  {
    const p = pieSlot(0, 4, 100, 100, 50);
    ok("pie.slot.top", Math.abs(p.x - 100) < 1e-9 && Math.abs(p.y - 50) < 1e-9, JSON.stringify(p));
    const right = pieSlot(1, 4, 100, 100, 50);
    ok("pie.slot.right", Math.abs(right.x - 150) < 1e-9 && Math.abs(right.y - 100) < 1e-9, JSON.stringify(right));
    const down = pieSlot(2, 4, 100, 100, 50);
    ok("pie.slot.bottom", Math.abs(down.x - 100) < 1e-9 && Math.abs(down.y - 150) < 1e-9);
    const left = pieSlot(3, 4, 100, 100, 50);
    ok("pie.slot.left", Math.abs(left.x - 50) < 1e-9 && Math.abs(left.y - 100) < 1e-9);
  }
  // every slot sits on the ring
  {
    const R = 200;
    const slots = pieSlots(24, 300, 300, R);
    eq("pie.slots.count", slots.length, 24);
    const off = slots.filter((s) => Math.abs(Math.hypot(s.x - 300, s.y - 300) - R) > 1e-6);
    eq("pie.slots.on-ring", off, []);
  }
  // 24 items still have room, and the fit-aware radius keeps them apart on a
  // small window too (item grew to 58px)
  eq("pie.item.size", PIE_ITEM, 58);
  ok("pie.gap.24", pieSlotGap(24, pieRadiusFor(1280, 800, 24)) > PIE_ITEM + 4, "gap=" + pieSlotGap(24, pieRadiusFor(1280, 800, 24)));
  ok("pie.gap.24-small", pieSlotGap(24, pieRadiusFor(900, 640, 24)) > PIE_ITEM, "gap=" + pieSlotGap(24, pieRadiusFor(900, 640, 24)));
  ok("pie.gap.8-small", pieSlotGap(8, pieRadiusFor(600, 480, 8)) > PIE_ITEM, "gap=" + pieSlotGap(8, pieRadiusFor(600, 480, 8)));
  // …while still fitting on screen (radius + half an item inside the viewport)
  for (const [vw, vh] of [[600, 480], [900, 640], [1280, 800], [4000, 3000]]) {
    const r = pieRadiusFor(vw, vh, 24);
    ok("pie.fits." + vw + "x" + vh, r + PIE_ITEM / 2 <= Math.min(vw, vh) / 2, "r=" + r);
  }
  ok("pie.radius.clamped", pieRadius(400, 300) >= 150 && pieRadius(4000, 3000) <= 380);

  // focus: pointing at an item selects it, wherever the pointer is beyond the zone
  {
    const cx = 500, cy = 400, R = 200;
    eq("pie.focus.top", pieFocusIndex(cx, cy - R, cx, cy, 4, R), 0);
    eq("pie.focus.top-far", pieFocusIndex(cx, cy - R * 2, cx, cy, 4, R), 0);
    eq("pie.focus.right", pieFocusIndex(cx + R, cy, cx, cy, 4, R), 1);
    eq("pie.focus.bottom", pieFocusIndex(cx, cy + R, cx, cy, 4, R), 2);
    eq("pie.focus.left", pieFocusIndex(cx - R, cy, cx, cy, 4, R), 3);
    // 45° between two items snaps to the nearer one
    eq("pie.focus.diag", pieFocusIndex(cx + R, cy - R, cx, cy, 4, R), 1);
    eq("pie.focus.diag2", pieFocusIndex(cx + R * 0.98, cy - R * 0.2, cx, cy, 4, R), 1);
  }
  // dead zone: releasing in the middle activates nothing
  {
    const cx = 500, cy = 400, R = 200;
    eq("pie.focus.dead-centre", pieFocusIndex(cx, cy, cx, cy, 8, R), -1);
    eq("pie.focus.dead-edge", pieFocusIndex(cx + R * PIE_DEAD * 0.9, cy, cx, cy, 8, R), -1);
    ok("pie.focus.just-outside", pieFocusIndex(cx + R * 0.5, cy, cx, cy, 8, R) >= 0);
    eq("pie.focus.empty", pieFocusIndex(cx + R, cy, cx, cy, 0, R), -1);
  }
  // many items: the index stays inside the ring and is stable around the circle
  {
    const cx = 0, cy = 0, R = 100, n = 12;
    for (let i = 0; i < n; i++) {
      const p = pieSlot(i, n, cx, cy, R * 1.4);
      eq("pie.focus.round." + i, pieFocusIndex(p.x, p.y, cx, cy, n, R), i);
    }
  }

  // F 键必须还没被占用（工具键里没有 f），否则「发动键」会跟工具切换打架
  ok("pie.key.free", !Object.prototype.hasOwnProperty.call(TOOL_KEYS, "f"));
  eq("pie.key.no-shortcut", shortcutFor({ key: "f" }), null);
}
