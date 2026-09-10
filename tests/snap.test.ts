import { eq, ok } from "./common";
import { snapToTargets, snapCandidates, snapGapRect, stackGap, titleObstacle, titleTop, SNAP_GAP, SNAP_GAP_V, TITLE_H, TITLE_LIFT, type SnapTarget } from "../src/app/canvas-snap";

const target = (id: string, x: number, y: number, w: number, h: number): SnapTarget<string> => ({ id, x, y, w, h });

export function testSnap(): void {
  const t = target("B", 100, 0, 64, 64);

  // far away: nothing happens
  eq("snap.far", snapToTargets({ x: 400, y: 300, w: 64, h: 64 }, [t], 12), { x: 400, y: 300, hit: null });
  eq("snap.no-targets", snapToTargets({ x: 5, y: 5, w: 10, h: 10 }, [], 12), { x: 5, y: 5, hit: null });
  eq("snap.tol-zero", snapToTargets({ x: 96, y: 0, w: 64, h: 64 }, [t], 0), { x: 96, y: 0, hit: null });

  eq("snap.gap", SNAP_GAP, 8);
  // approaching from the left: our right edge snaps to their left edge MINUS the gap
  eq("snap.touch-right", snapToTargets({ x: 30, y: 0, w: 64, h: 64 }, [t], 12), { x: 100 - SNAP_GAP - 64, y: 0, hit: "B" });
  // approaching from the right: our left edge snaps to their right edge PLUS the gap
  eq("snap.touch-left", snapToTargets({ x: 170, y: 0, w: 64, h: 64 }, [t], 12), { x: 164 + SNAP_GAP, y: 0, hit: "B" });
  // overlapping but misaligned: left edges align
  eq("snap.align-left", snapToTargets({ x: 106, y: 0, w: 64, h: 64 }, [t], 12), { x: 100, y: 0, hit: "B" });
  // right edges align
  eq("snap.align-right", snapToTargets({ x: 30, y: 0, w: 64, h: 64 }, [t], 100), { x: 100 - SNAP_GAP - 64, y: 0, hit: "B" });

  // vertical: our top edge snaps to their bottom edge when horizontally close
  eq("snap.below", snapToTargets({ x: 100, y: 70, w: 64, h: 64 }, [t], 12), { x: 100, y: 64 + SNAP_GAP_V, hit: "B" });
  // ... but a canvas far below is NOT snapped to just because the x ranges line up
  eq("snap.vertical-not-close", snapToTargets({ x: 100, y: 400, w: 64, h: 64 }, [t], 12), { x: 100, y: 400, hit: null });

  // both axes at once (diagonal corner snap)
  const corner = snapToTargets({ x: 30, y: 70, w: 64, h: 64 }, [t], 12);
  eq("snap.corner", [corner.x, corner.y, corner.hit], [100 - SNAP_GAP - 64, 64 + SNAP_GAP_V, "B"]);

  // the nearest target wins when several are in range
  const c = target("C", 100, 200, 64, 64);
  eq("snap.nearest", snapToTargets({ x: 30, y: 206, w: 64, h: 64 }, [t, c], 12).hit, "C");

  // a candidate just outside the tolerance is ignored
  eq("snap.just-outside", snapToTargets({ x: 10, y: 0, w: 64, h: 64 }, [t], 12), { x: 10, y: 0, hit: null });
  // ... and one just inside is taken (right edge lands 8px before their left edge)
  eq("snap.just-inside", snapToTargets({ x: 16, y: 0, w: 64, h: 64 }, [t], 12), { x: 100 - SNAP_GAP - 64, y: 0, hit: "B" });
  // a custom gap is honoured
  eq("snap.custom-gap", snapToTargets({ x: 30, y: 0, w: 64, h: 64 }, [t], 12, 0), { x: 36, y: 0, hit: "B" });

  ok("snap.returns-new-object", snapToTargets({ x: 0, y: 0, w: 8, h: 8 }, [t], 4) !== null);

  // ---- several satisfied zones are reported at once ----
  {
    const a = target("A", 100, 0, 64, 64);
    const c = target("C", 100, 72, 64, 64); // directly below A (snapped to it)
    const moving = { x: 36, y: 0, w: 64, h: 64 };
    const cands = snapCandidates(moving, [a, c], 12);
    eq("snap.candidates.count", cands.length, 2);
    eq("snap.candidates.ids", cands.map((x) => x.id).sort(), ["A", "C"]);
    eq("snap.candidates.same-x", cands[0].x, cands[1].x);
    // a lone target still reports exactly one candidate
    eq("snap.candidates.one", snapCandidates(moving, [a], 12).length, 1);
    // nothing in range -> none
    eq("snap.candidates.none", snapCandidates({ x: 900, y: 900, w: 64, h: 64 }, [a, c], 12).length, 0);
  }

  // ---- stacked snapping: the gap includes the title bar ----
  {
    const a = target("B", 100, 0, 64, 64);
    // dragged to 6px below: the bigger stacked gap must still be reachable
    eq("snap.below.near", snapToTargets({ x: 100, y: 70, w: 64, h: 64 }, [a], 12), { x: 100, y: 64 + SNAP_GAP_V, hit: "B" });
    eq("snap.below.inside-zone", snapToTargets({ x: 100, y: 64 + SNAP_GAP_V + 10, w: 64, h: 64 }, [a], 12),
      { x: 100, y: 64 + SNAP_GAP_V, hit: "B" });
    eq("snap.below.far", snapToTargets({ x: 100, y: 64 + SNAP_GAP_V + 40, w: 64, h: 64 }, [a], 12).hit, null);
    eq("snap.above.near", snapToTargets({ x: 100, y: -(64 + 6), w: 64, h: 64 }, [a], 12),
      { x: 100, y: 0 - SNAP_GAP_V - 64, hit: "B" });
    // side-by-side keeps the plain gap
    eq("snap.side.unchanged", snapToTargets({ x: 30, y: 0, w: 64, h: 64 }, [a], 12).x, 100 - SNAP_GAP - 64);
  }

  // ---- the gap rect between adjacent canvases ----
  {
    const right = snapGapRect({ x: 0, y: 0, w: 64, h: 64 }, { x: 72, y: 10, w: 64, h: 64 });
    eq("snap.gaprect.right", right, { x0: 64, y0: 10, x1: 72, y1: 64 });
    const left = snapGapRect({ x: 72, y: 10, w: 64, h: 64 }, { x: 0, y: 0, w: 64, h: 64 });
    eq("snap.gaprect.left", left, { x0: 64, y0: 10, x1: 72, y1: 64 });
    const below = snapGapRect({ x: 0, y: 0, w: 64, h: 64 }, { x: 10, y: 64 + SNAP_GAP_V, w: 64, h: 64 });
    eq("snap.gaprect.below", below, { x0: 10, y0: 64, x1: 64, y1: 64 + SNAP_GAP_V });
    // stacked canvases keep TITLE_EXTRA px more than side-by-side ones…
    eq("snap.gapv.constant", SNAP_GAP_V - SNAP_GAP, 20);
    eq("snap.gapv.stack", stackGap(SNAP_GAP), SNAP_GAP_V);
    eq("snap.gapv.custom", stackGap(0), 20);
    // …and the gap fits the title bar with a margin on both sides
    ok("snap.gapv.fits-title", SNAP_GAP_V - TITLE_H >= 2, "slack=" + (SNAP_GAP_V - TITLE_H));
    eq("snap.gaprect.horizontal-unchanged", snapGapRect({ x: 0, y: 0, w: 64, h: 64 }, { x: 72, y: 10, w: 64, h: 64 }),
      { x0: 64, y0: 10, x1: 72, y1: 64 });
    eq("snap.gaprect.not-adjacent", snapGapRect({ x: 0, y: 0, w: 64, h: 64 }, { x: 200, y: 0, w: 64, h: 64 }), null);
    eq("snap.gaprect.overlap", snapGapRect({ x: 0, y: 0, w: 64, h: 64 }, { x: 60, y: 0, w: 64, h: 64 }), null);
  }

  // ---- canvas title bar placement (snapped neighbour above) ----
  {
    const lower = { x: 0, y: 72, w: 64, h: 64 };       // snapped 8px below `upper`
    const upper = { x: 0, y: 0, w: 64, h: 64 };
    // nothing above: the bar keeps its usual lift
    eq("title.top.free", titleTop(200, null), 200 - TITLE_LIFT);
    eq("title.obstacle.none", titleObstacle(lower, [{ x: 300, y: 0, w: 64, h: 64 }]), null);
    // snapped above: the bar clears the neighbour's bottom edge
    eq("title.obstacle.snapped", titleObstacle(lower, [upper]), 64);
    eq("title.top.snapped", titleTop(lower.y, titleObstacle(lower, [upper])), 65);   // 1px below the neighbour
    ok("title.top.clears", titleTop(lower.y, 64) >= 64, "top=" + titleTop(lower.y, 64));
    // the real stacked layout: gap = SNAP_GAP_V, bar sits inside it and covers
    // neither the neighbour above nor its own canvas
    {
      const gap = snapGapRect(upper, { x: 0, y: 64 + SNAP_GAP_V, w: 64, h: 64 });
      ok("title.snap.gap-known", !!gap, "gap=" + JSON.stringify(gap));
      const lowerTop = 64 + SNAP_GAP_V;
      const top = titleTop(lowerTop, 64);
      ok("title.snap.clear-neighbour", top >= 64, "top=" + top);
      ok("title.snap.clear-own", top + TITLE_H <= lowerTop, "bottom=" + (top + TITLE_H) + " own=" + lowerTop);
    }
    // far enough above that the bar would not touch it: no clamp
    eq("title.obstacle.far", titleObstacle(lower, [{ x: 0, y: -100, w: 64, h: 64 }]), null);
    // horizontally apart: no clamp even when vertically adjacent
    eq("title.obstacle.side", titleObstacle(lower, [{ x: 200, y: 0, w: 64, h: 64 }]), null);
    // partially overlapping horizontally is still in the way
    eq("title.obstacle.partial", titleObstacle(lower, [{ x: 40, y: 0, w: 64, h: 64 }]), 64);
    // the deepest of several neighbours wins (bar clears all of them)
    eq("title.obstacle.deepest", titleObstacle(lower, [upper, { x: 0, y: 10, w: 64, h: 50 }]), 64);
    eq("title.obstacle.deepest.single", titleObstacle(lower, [{ x: 0, y: 10, w: 64, h: 50 }]), 60);
    // a neighbour BELOW the canvas never clamps the bar
    eq("title.obstacle.below", titleObstacle(lower, [{ x: 0, y: 140, w: 64, h: 64 }]), null);
  }
}
