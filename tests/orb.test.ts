import {
  CHIP_H, CHIP_W, FLOATER_R, ORB_SIZE,
  chipBox, chipCoversFloater, palChipPos, swatchHitsChip,
} from "../src/ui/orb-layout";
import { eq, ok } from "./common";

export function testOrbLayout(): void {
  const W = 400, H = 800;

  // --- fixed slot: centred on the floater's x, constant distance below it ---
  {
    const a = palChipPos(200, 400, W, H);
    const b = palChipPos(200, 400, W, H);
    eq("orb.chip.fixed-x", a.x, 200);
    eq("orb.chip.fixed-y", a.y, 400 + FLOATER_R + CHIP_H / 2 + 10);
    eq("orb.chip.deterministic", a, b);
  }

  // --- the slot does not depend on the swatch list at all ---
  {
    const before = palChipPos(150, 300, W, H);
    const after = palChipPos(150, 300, W, H);
    eq("orb.chip.no-swatch-dependency", before, after);
  }

  // --- never covers the floater (middle of the screen and near the bottom) ---
  {
    const mid = palChipPos(200, 400, W, H);
    ok("orb.chip.no-overlap-mid", !chipCoversFloater(200, 400, mid), JSON.stringify(mid));
    const low = palChipPos(200, H - 30, W, H);
    ok("orb.chip.flips-above", low.y < H - 30, "y=" + low.y);
    ok("orb.chip.no-overlap-bottom", !chipCoversFloater(200, H - 30, low), JSON.stringify(low));
  }

  // --- stays inside the viewport even when the floater hugs an edge ---
  {
    const p = palChipPos(4, 6, W, H);
    ok("orb.chip.clamp-x", p.x >= CHIP_W / 2, "x=" + p.x);
    ok("orb.chip.clamp-y", p.y >= 20 && p.y <= H - 20, "y=" + p.y);
  }

  // --- swatch overlap test: the reserved slot is excluded, far swatches are not ---
  {
    const p = palChipPos(200, 400, W, H);
    const box = chipBox(p.x, p.y);
    ok("orb.swatch.slot-blocked", swatchHitsChip(p.x, p.y, box));
    ok("orb.swatch.slot-blocked-neighbour", swatchHitsChip(p.x + ORB_SIZE, p.y, box));
    ok("orb.swatch.far-clear", !swatchHitsChip(p.x + 120, p.y, box));
    ok("orb.swatch.above-clear", !swatchHitsChip(p.x, p.y - 120, box));
  }
}
