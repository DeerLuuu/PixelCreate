import { eq, ok } from "./common";
import { snapToTargets, type SnapTarget } from "../src/app/canvas-snap";

const target = (id: string, x: number, y: number, w: number, h: number): SnapTarget<string> => ({ id, x, y, w, h });

export function testSnap(): void {
  const t = target("B", 100, 0, 64, 64);

  // far away: nothing happens
  eq("snap.far", snapToTargets({ x: 400, y: 300, w: 64, h: 64 }, [t], 12), { x: 400, y: 300, hit: null });
  eq("snap.no-targets", snapToTargets({ x: 5, y: 5, w: 10, h: 10 }, [], 12), { x: 5, y: 5, hit: null });
  eq("snap.tol-zero", snapToTargets({ x: 96, y: 0, w: 64, h: 64 }, [t], 0), { x: 96, y: 0, hit: null });

  // approaching from the left: our right edge snaps to their left edge
  eq("snap.touch-right", snapToTargets({ x: 30, y: 0, w: 64, h: 64 }, [t], 12), { x: 36, y: 0, hit: "B" });
  // approaching from the right: our left edge snaps to their right edge
  eq("snap.touch-left", snapToTargets({ x: 170, y: 0, w: 64, h: 64 }, [t], 12), { x: 164, y: 0, hit: "B" });
  // overlapping but misaligned: left edges align
  eq("snap.align-left", snapToTargets({ x: 106, y: 0, w: 64, h: 64 }, [t], 12), { x: 100, y: 0, hit: "B" });
  // right edges align
  eq("snap.align-right", snapToTargets({ x: 30, y: 0, w: 64, h: 64 }, [t], 100), { x: 36, y: 0, hit: "B" });

  // vertical: our top edge snaps to their bottom edge when horizontally close
  eq("snap.below", snapToTargets({ x: 100, y: 70, w: 64, h: 64 }, [t], 12), { x: 100, y: 64, hit: "B" });
  // ... but a canvas far below is NOT snapped to just because the x ranges line up
  eq("snap.vertical-not-close", snapToTargets({ x: 100, y: 400, w: 64, h: 64 }, [t], 12), { x: 100, y: 400, hit: null });

  // both axes at once (diagonal corner snap)
  const corner = snapToTargets({ x: 30, y: 70, w: 64, h: 64 }, [t], 12);
  eq("snap.corner", [corner.x, corner.y, corner.hit], [36, 64, "B"]);

  // the nearest target wins when several are in range
  const c = target("C", 100, 200, 64, 64);
  eq("snap.nearest", snapToTargets({ x: 30, y: 206, w: 64, h: 64 }, [t, c], 12).hit, "C");

  // a candidate just outside the tolerance is ignored
  eq("snap.just-outside", snapToTargets({ x: 20, y: 0, w: 64, h: 64 }, [t], 12), { x: 20, y: 0, hit: null });
  // ... and one just inside is taken
  eq("snap.just-inside", snapToTargets({ x: 26, y: 0, w: 64, h: 64 }, [t], 12), { x: 36, y: 0, hit: "B" });

  ok("snap.returns-new-object", snapToTargets({ x: 0, y: 0, w: 8, h: 8 }, [t], 4) !== null);
}
