import { GUIDE_GAP, GUIDE_MARGIN, guideBubblePos, guideBubblePosAvoiding, pickPlace, shrinkHole } from "../src/ui/guide-layout";
import { eq, ok } from "./common";

const VW = 360, VH = 700;
const BW = 320, BH = 160;

/** the card must always be fully inside the viewport */
function inside(p: { left: number; top: number }, bw = BW, bh = BH): boolean {
  return p.left >= GUIDE_MARGIN - 0.01 && p.top >= GUIDE_MARGIN - 0.01
    && p.left + bw <= VW - GUIDE_MARGIN + 0.01 && p.top + bh <= VH - GUIDE_MARGIN + 0.01;
}

export function testGuideLayout(): void {
  // --- preferred side is honoured when there is room ---
  {
    const target = { x: 120, y: 300, w: 80, h: 40 };
    const p = guideBubblePos(target, BW, BH, VW, VH, "bottom");
    eq("guidelay.bottom.top", p.top, target.y + target.h + GUIDE_GAP);
    ok("guidelay.bottom.inside", inside(p));
  }

  // --- target at the very bottom flips the card above it ---
  {
    const target = { x: 120, y: VH - 60, w: 80, h: 40 };
    const p = guideBubblePos(target, BW, BH, VW, VH, "bottom");
    ok("guidelay.bottom-flips-up", p.top + BH <= target.y, "top=" + p.top);
    ok("guidelay.bottom-flips-inside", inside(p));
  }

  // --- target at the very top flips the card below it ---
  {
    const target = { x: 120, y: 4, w: 80, h: 40 };
    const p = guideBubblePos(target, BW, BH, VW, VH, "top");
    ok("guidelay.top-flips-down", p.top >= target.y + target.h, "top=" + p.top);
    ok("guidelay.top-flips-inside", inside(p));
  }

  // --- target at the left/right edge flips horizontally (narrower card so the
  //     horizontal flip is actually observable on a 360px-wide screen) ---
  {
    const NBW = 200;
    const left = { x: 2, y: 300, w: 40, h: 40 };
    const p = guideBubblePos(left, NBW, BH, VW, VH, "left");
    ok("guidelay.left-flips-right", p.left >= left.x + left.w, "left=" + p.left);
    ok("guidelay.left-flips-inside", inside(p, NBW));
    const right = { x: VW - 42, y: 300, w: 40, h: 40 };
    const q = guideBubblePos(right, NBW, BH, VW, VH, "right");
    ok("guidelay.right-flips-left", q.left + NBW <= right.x, "left=" + q.left);
    ok("guidelay.right-flips-inside", inside(q, NBW));
  }

  // --- a very tall card is pinned inside instead of overflowing ---
  {
    const target = { x: 100, y: 350, w: 100, h: 40 };
    const tall = VH; // taller than the viewport minus margins
    const p = guideBubblePos(target, BW, tall, VW, VH, "bottom");
    eq("guidelay.tall.pinned-top", p.top, GUIDE_MARGIN);
    ok("guidelay.tall.inside-x", p.left >= GUIDE_MARGIN && p.left + BW <= VW - GUIDE_MARGIN);
  }

  // --- no target: centred card, still inside ---
  {
    const p = guideBubblePos(null, BW, BH, VW, VH);
    eq("guidelay.centred.x", p.left, (VW - BW) / 2);
    ok("guidelay.centred.inside", inside(p));
  }

  // --- "auto" picks the roomiest side ---
  {
    const nearTop = { x: 150, y: 10, w: 60, h: 30 };
    eq("guidelay.auto.near-top", pickPlace("auto", nearTop, VW, VH), "bottom");
    const nearLeft = { x: 4, y: 135, w: 60, h: 30 }; // wide/short viewport: roomiest side is the right
    eq("guidelay.auto.near-left", pickPlace("auto", nearLeft, 900, 300), "right");
  }

  // --- huge targets are shrunk so the card can sit outside the highlight ---
  {
    const big = { x: 0, y: 0, w: VW, h: VH };
    const sh = shrinkHole(big, VW, VH);
    ok("guidelay.shrink.smaller", sh.w < VW && sh.h < VH, JSON.stringify(sh));
    ok("guidelay.shrink.centred",
      Math.abs(sh.x + sh.w / 2 - VW / 2) < 2 && Math.abs(sh.y + sh.h / 2 - VH / 2) < 2, JSON.stringify(sh));
    const small = { x: 100, y: 200, w: 60, h: 40 };
    eq("guidelay.shrink.keeps-small", shrinkHole(small, VW, VH), small);
  }

  // --- the card never covers the highlighted area when any side has room ---
  {
    const target = { x: 140, y: 300, w: 80, h: 40 };
    const p = guideBubblePosAvoiding(target, BW, BH, VW, VH, "bottom");
    ok("guidelay.avoid.no-overlap", !p.overlaps, JSON.stringify(p));

    let overlapCount = 0, outside = 0;
    for (let x = 0; x <= VW - 60; x += 30) {
      for (let y = 0; y <= VH - 60; y += 30) {
        const q = guideBubblePosAvoiding({ x, y, w: 60, h: 60 }, 200, 120, VW, VH, "auto");
        if (q.overlaps) overlapCount++;
        if (q.left < GUIDE_MARGIN - 0.01 || q.top < GUIDE_MARGIN - 0.01
          || q.left + 200 > VW - GUIDE_MARGIN + 0.01 || q.top + 120 > VH - GUIDE_MARGIN + 0.01) outside++;
      }
    }
    eq("guidelay.avoid.grid-no-overlap", overlapCount, 0);
    eq("guidelay.avoid.grid-inside", outside, 0);

    // a full-screen target: after shrinking the hole the card sits clear of it
    const hole = shrinkHole({ x: 0, y: 46, w: VW, h: VH - 120 }, VW, VH);
    const q = guideBubblePosAvoiding(hole, BW, 120, VW, VH, "auto");
    ok("guidelay.avoid.huge-target", !q.overlaps, JSON.stringify(q));
  }

  // --- every placement of a grid of targets stays inside the viewport ---
  {
    let bad = 0;
    for (let x = 0; x <= VW - 40; x += 40) {
      for (let y = 0; y <= VH - 40; y += 40) {
        for (const pref of ["top", "bottom", "left", "right", "auto"] as const) {
          const p = guideBubblePos({ x, y, w: 40, h: 40 }, BW, BH, VW, VH, pref);
          if (!inside(p)) bad++;
        }
      }
    }
    eq("guidelay.grid.all-inside", bad, 0);
  }
}
