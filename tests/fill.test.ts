import { Cel } from "../src/engine/cel";
import { floodFill, globalFill, globalErase, polygonCells, fillPolygon, sprayDots, floodRegion, gradientFillRegion } from "../src/engine/paint";
import { Doc } from "../src/engine/doc";
import { Stroke } from "../src/tools/stroke";
import { eq, ok } from "./common";

const RED: [number, number, number, number] = [255, 0, 0, 255];
const BLUE: [number, number, number, number] = [0, 0, 255, 255];

function mk(w: number, h: number, pts: Array<[number, number]>): Cel {
  const c = new Cel(w, h);
  for (const [x, y] of pts) {
    const i = c.idx(x, y);
    c.data[i] = RED[0]; c.data[i + 1] = RED[1]; c.data[i + 2] = RED[2]; c.data[i + 3] = RED[3];
  }
  return c;
}
const at = (c: Cel, x: number, y: number): number[] => {
  const i = c.idx(x, y);
  return [c.data[i], c.data[i + 1], c.data[i + 2], c.data[i + 3]];
};
const countRed = (c: Cel): number => {
  let n = 0;
  for (let i = 0; i < c.data.length; i += 4) {
    if (c.data[i] === 255 && c.data[i + 1] === 0 && c.data[i + 2] === 0 && c.data[i + 3] === 255) n++;
  }
  return n;
};
const set3 = (c: Cel, x: number, r: number, g: number, b: number, a: number): void => {
  const i = c.idx(x, 0);
  c.data[i] = r; c.data[i + 1] = g; c.data[i + 2] = b; c.data[i + 3] = a;
};
const countBlue = (c: Cel): number => {
  let n = 0;
  for (let i = 0; i < c.data.length; i += 4) {
    if (c.data[i] === 0 && c.data[i + 1] === 0 && c.data[i + 2] === 255 && c.data[i + 3] === 255) n++;
  }
  return n;
};

/** five isolated red pixels: (0,0) (2,0) (1,1) (3,1) (2,2) on a 5x3 cel */
const ISOLATED: Array<[number, number]> = [[0, 0], [2, 0], [1, 1], [3, 1], [2, 2]];

export function testFill(): void {
  // ------------------------------------------- freehand outline fill
  // (what the outline tool does on release: raster + symmetry + mask)
  {
    const cel = new Cel(8, 8);
    const box = fillPolygon(cel, 8, 8, [[1, 1], [6, 1], [6, 6], [1, 6]], BLUE);
    eq("polyfill.box", box, { x: 1, y: 1, w: 6, h: 5 });
    const px = (x: number, y: number): number[] => {
      const i = cel.idx(x, y);
      return [cel.data[i], cel.data[i + 1], cel.data[i + 2], cel.data[i + 3]];
    };
    eq("polyfill.inside", px(3, 3), [0, 0, 255, 255]);
    eq("polyfill.outside", px(0, 0), [0, 0, 0, 0]);
    // an active selection clips the fill
    const cel2 = new Cel(8, 8);
    const mask = (x: number, y: number) => x >= 4;
    const box2 = fillPolygon(cel2, 8, 8, [[1, 1], [6, 1], [6, 6], [1, 6]], BLUE, mask);
    eq("polyfill.mask.box", box2, { x: 4, y: 1, w: 3, h: 5 });
    ok("polyfill.mask.clipped", cel2.data[cel2.idx(2, 3) + 3] === 0 && cel2.data[cel2.idx(5, 3) + 3] === 255);
    // symmetry mirrors the fill across the vertical axis of an 8x8 doc
    const cel3 = new Cel(8, 8);
    const ax = { on: true, four: false, ox: 0, oy: 0, angDeg: 90 };
    const box3 = fillPolygon(cel3, 8, 8, [[0, 0], [2, 0], [2, 2], [0, 2]], RED, null, ax);
    ok("polyfill.sym.left", cel3.data[cel3.idx(1, 1) + 3] === 255);
    ok("polyfill.sym.right", cel3.data[cel3.idx(6, 1) + 3] === 255);
    eq("polyfill.sym.box", box3, { x: 0, y: 0, w: 8, h: 2 });
    // nothing painted -> null (no history step)
    eq("polyfill.empty", fillPolygon(new Cel(8, 8), 8, 8, [[1, 1], [2, 2]], BLUE), null);
  }

  // ------------------------------------------------- polygon rasteriser
  // (used by the lasso selection and the freehand outline-fill tool)
  {
    const cells = new Set<string>();
    polygonCells(8, 8, [[1, 1], [6, 1], [6, 6], [1, 6]], (x, y) => cells.add(x + "," + y));
    // half-open scanline (same rule as the lasso): columns 1..6, rows 1..5
    ok("poly.square.count", cells.size === 30, "n=" + cells.size);
    ok("poly.square.inside", cells.has("3,3") && cells.has("1,1") && cells.has("6,5"));
    ok("poly.square.outside", !cells.has("0,0") && !cells.has("6,6") && !cells.has("7,3"));
    // a triangle: only cells below the diagonal are inside
    const tri = new Set<string>();
    polygonCells(8, 8, [[0, 0], [7, 0], [0, 7]], (x, y) => tri.add(x + "," + y));
    ok("poly.triangle.inside", tri.has("0,0") && tri.has("1,0") && tri.has("0,6"));
    ok("poly.triangle.outside", !tri.has("6,6") && !tri.has("7,7"));
    // degenerate input is ignored
    const none = new Set<string>();
    polygonCells(8, 8, [[1, 1], [2, 2]], (x, y) => none.add(x + "," + y));
    eq("poly.too-few-points", none.size, 0);
    // pixels outside the canvas are clipped, never negative
    const clipped = new Set<string>();
    polygonCells(4, 4, [[-5, -5], [9, -5], [9, 9], [-5, 9]], (x, y) => clipped.add(x + "," + y));
    eq("poly.clipped.count", clipped.size, 16);
    ok("poly.clipped.bounds", clipped.has("0,0") && clipped.has("3,3") && !clipped.has("4,4"));
  }

  // --- contiguous (regression): only the seed's own region changes ---
  {
    const c = mk(5, 3, ISOLATED);
    floodFill(c, 0, 0, BLUE);
    eq("fill.contiguous.seed", at(c, 0, 0), BLUE);
    eq("fill.contiguous.other-untouched", at(c, 2, 0), RED);
    eq("fill.contiguous.red-left", countRed(c), 4);
  }

  // --- global: every matching pixel anywhere in the cel is filled ---
  {
    const c = mk(5, 3, ISOLATED);
    globalFill(c, 0, 0, BLUE);
    eq("fill.global.all-blue", countBlue(c), 5);
    eq("fill.global.no-red-left", countRed(c), 0);
    eq("fill.global.far-pixel", at(c, 2, 2), BLUE);
  }

  // --- global honours a selection mask ---
  {
    const c = mk(5, 3, ISOLATED);
    globalFill(c, 0, 0, BLUE, (_x, y) => y === 0);
    eq("fill.global.mask.row0", countBlue(c), 2);
    eq("fill.global.mask.rest-red", countRed(c), 3);
  }

  // --- filling with the colour that is already there is a no-op ---
  {
    const c = mk(5, 3, ISOLATED);
    globalFill(c, 0, 0, RED);
    eq("fill.global.same-colour", countRed(c), 5);
  }

  // --- global erase clears every matching pixel ---
  {
    const c = mk(5, 3, ISOLATED);
    globalErase(c, 0, 0);
    ok("fill.global-erase.empty", countRed(c) === 0);
    eq("fill.global-erase.pixel", at(c, 3, 1), [0, 0, 0, 0]);
  }

  // --- erase respects the mask too ---
  {
    const c = mk(5, 3, ISOLATED);
    globalErase(c, 0, 0, (_x, y) => y === 0);
    eq("fill.global-erase.mask", countRed(c), 3);
  }

  // --- a connected blob is filled identically by both modes ---
  {
    const pts: Array<[number, number]> = [[1, 1], [2, 1], [1, 2], [2, 2]];
    const a = mk(4, 4, pts);
    const b = mk(4, 4, pts);
    floodFill(a, 1, 1, BLUE);
    globalFill(b, 1, 1, BLUE);
    ok("fill.blob.same-result", a.data.join() === b.data.join());
  }

  // ---- airbrush spray (deterministic with a seeded RNG) ----
  {
    // 1px specks: one cell each, sampled inside the disc
    const cells: Array<[number, number]> = [];
    sprayDots(20, 20, 5, 1, 1, 40, lcg(7), (x, y) => cells.push([x, y]));
    eq("spray.count", cells.length, 40);
    ok("spray.inside-disc", cells.every(([x, y]) => Math.hypot(x - 20, y - 20) <= 5.5), "out of disc");
    // same seed -> same specks (no hidden state)
    const again: Array<[number, number]> = [];
    sprayDots(20, 20, 5, 1, 1, 40, lcg(7), (x, y) => again.push([x, y]));
    eq("spray.deterministic", again, cells);
    // every speck is a square whose side is in [2,4]: cells stay within +-2
    const big: Array<[number, number]> = [];
    sprayDots(0, 0, 0, 2, 4, 50, lcg(11), (x, y) => big.push([x, y]));
    ok("spray.size-range", big.length >= 200 && big.length <= 800, "cells=" + big.length);
    ok("spray.size-extent", big.every(([x, y]) => x >= -2 && x <= 2 && y >= -2 && y <= 2), "speck too big");
    // a degenerate range is normalised instead of producing nothing
    const one: Array<[number, number]> = [];
    sprayDots(0, 0, 0, 3, 1, 1, lcg(3), (x, y) => one.push([x, y]));
    eq("spray.range-normalised", one.length, 9);
    // zero specks / zero radius paint nothing at all
    let none = 0;
    sprayDots(0, 0, 4, 1, 2, 0, lcg(1), () => { none++; });
    eq("spray.zero-count", none, 0);
  }

  // ---- airbrush through the stroke engine (mask / symmetry aware) ----
  {
    const doc = new Doc(16, 16, "spray");
    const brush = { color: RED, size: 1, alpha: 255, pressure: 1 };
    const st = new Stroke(doc, 0, 0, "airbrush", brush, false, "off");
    st.sprayMin = 1;
    st.sprayMax = 1;
    st.startAt(8, 8);
    const cel = doc.celAt(0, 0)!;
    ok("spray.stroke.paints", cel.hasAnyOpaque());
    // the first speck is centred on the touch point (size 1 -> exactly there)
    eq("spray.stroke.centre", at(cel, 8, 8), RED);
    // symmetric airbrush: the mirrored speck lands on the other side of the axis
    const doc2 = new Doc(16, 16, "spray-sym");
    const st2 = new Stroke(doc2, 0, 0, "airbrush", brush, false, "on", 6, true, 0, 0, 90);
    st2.sprayMin = 1;
    st2.sprayMax = 1;
    st2.startAt(4, 6);
    const cel2 = doc2.celAt(0, 0)!;
    eq("spray.sym.source", at(cel2, 4, 6), RED);
    eq("spray.sym.mirror", at(cel2, 11, 6), RED); // 16-wide doc, vertical axis at x=8
  }

  // ---- bucket gradient mode (linear along the drag) ----
  {
    const row: Array<[number, number]> = [];
    for (let x = 0; x < 8; x++) row.push([x, 0]);
    const c = mk(8, 1, row);
    const cells = floodRegion(c, 0, 0, false);
    eq("grad.region.count", cells.length, 8);
    gradientFillRegion(c, cells, RED, BLUE, 1, { x0: 0, y0: 0, dx: 7, dy: 0 });
    eq("grad.start", at(c, 0, 0), RED);
    eq("grad.end", at(c, 7, 0), BLUE);
    const mid = at(c, 3, 0);
    ok("grad.mid-between", mid[0] > 0 && mid[0] < 255 && mid[2] > 0 && mid[2] < 255, JSON.stringify(mid));
    let mono = true;
    for (let x = 1; x < 8; x++) {
      const a = at(c, x - 1, 0), b = at(c, x, 0);
      if (b[0] > a[0] || b[2] < a[2]) mono = false;
    }
    ok("grad.monotonic", mono);

    // a vertical drag over the same row: every cell projects to t=0 -> all c0
    const c2 = mk(8, 1, row);
    gradientFillRegion(c2, cells, RED, BLUE, 1, { x0: 0, y0: 0, dx: 0, dy: 8 });
    eq("grad.direction.matters", [at(c2, 0, 0), at(c2, 7, 0)], [RED, RED]);

    // no drag -> automatic vertical ramp over the region bbox
    const c3 = mk(4, 2, [[0, 0], [1, 0], [2, 0], [3, 0], [0, 1], [1, 1], [2, 1], [3, 1]]);
    const cs3 = floodRegion(c3, 0, 0, false);
    gradientFillRegion(c3, cs3, RED, BLUE, 1, null);
    eq("grad.auto.top", at(c3, 0, 0), RED);
    eq("grad.auto.bottom", at(c3, 0, 1), BLUE);

    // cells past either end clamp instead of wrapping
    const c4 = mk(6, 1, [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0]]);
    const cs4 = floodRegion(c4, 0, 0, false);
    gradientFillRegion(c4, cs4, RED, BLUE, 1, { x0: 2, y0: 0, dx: 2, dy: 0 });
    eq("grad.clamp.before", [at(c4, 0, 0), at(c4, 1, 0)], [RED, RED]);
    eq("grad.clamp.after", [at(c4, 4, 0), at(c4, 5, 0)], [BLUE, BLUE]);

    // block = 2: every 2x2 tile gets ONE colour (hard-edged pixel-art ramp)
    const box: Array<[number, number]> = [];
    for (let y = 0; y < 2; y++) for (let x = 0; x < 4; x++) box.push([x, y]);
    const c5 = mk(4, 2, box);
    const cs5 = floodRegion(c5, 0, 0, false);
    gradientFillRegion(c5, cs5, RED, BLUE, 2, { x0: 0, y0: 0, dx: 4, dy: 0 });
    const near = at(c5, 0, 0), far = at(c5, 2, 0);
    ok("grad.block2.tile-uniform", [at(c5, 1, 0), at(c5, 0, 1), at(c5, 1, 1)].every((p) => p.join() === near.join()));
    ok("grad.block2.tile2-uniform", [at(c5, 3, 0), at(c5, 2, 1), at(c5, 3, 1)].every((p) => p.join() === far.join()));
    ok("grad.block2.ramps", near[0] > far[0] && near[2] < far[2], JSON.stringify([near, far]));
    // a drag that ends exactly on the far tile centre reaches the end colour
    const c6 = mk(4, 2, box);
    gradientFillRegion(c6, cs5, RED, BLUE, 2, { x0: 0.5, y0: 0.5, dx: 2, dy: 0 });
    eq("grad.block2.end-reached", at(c6, 2, 0), BLUE);

    // a single cell / an empty region
    const one = mk(3, 3, [[1, 1]]);
    const oc = floodRegion(one, 1, 1, false);
    gradientFillRegion(one, oc, RED, BLUE, 4, null);
    eq("grad.single.colour", at(one, 1, 1), RED);
    eq("grad.empty", gradientFillRegion(one, [], RED, BLUE, 1, null), null);

    // the selection mask is honoured
    const m = mk(4, 1, [[0, 0], [1, 0], [2, 0], [3, 0]]);
    const mc = floodRegion(m, 0, 0, false, (x) => x < 2);
    eq("grad.mask.region", mc.length, 2);
    gradientFillRegion(m, mc, RED, BLUE, 1, { x0: 0, y0: 0, dx: 3, dy: 0 }, (x) => x < 2);
    eq("grad.mask.untouched", [at(m, 2, 0), at(m, 3, 0)], [RED, RED]);

    // global mode grabs disconnected matches as well
    const g = mk(5, 1, [[0, 0], [1, 0], [3, 0], [4, 0]]);
    eq("grad.global.region", floodRegion(g, 0, 0, true).length, 4);
    eq("grad.connected.region", floodRegion(g, 0, 0, false).length, 2);
  }

  // ---- gradient through the stroke engine: the drag sets the direction ----
  {
    const doc = new Doc(8, 2, "grad");
    const brush = { color: RED, size: 1, alpha: 255, pressure: 1 };
    const st = new Stroke(doc, 0, 0, "bucket", brush, false, "off");
    st.gradEnd = BLUE;
    st.gradBlock = 1;
    st.startAt(0, 0);      // seeds the region, paints the automatic ramp
    st.moveTo(7, 0, 1);    // drag to the right -> horizontal ramp
    const cel = doc.celAt(0, 0)!;
    eq("gradstroke.left", at(cel, 0, 0), RED);
    eq("gradstroke.right", at(cel, 7, 0), BLUE);
    const line = st.gradLine();
    eq("gradstroke.line", line && [line.x0, line.y0, line.x1, line.y1], [0, 0, 7, 0]);
  }

  // ------------------------------------------- tolerance + fill gaps
  {
    // a 8x1 strip: three slightly different reds then a solid blue wall
    const c = new Cel(8, 1);
    const set = (x: number, r: number, g: number, b: number, a: number): void => {
      const i = c.idx(x, 0);
      c.data[i] = r; c.data[i + 1] = g; c.data[i + 2] = b; c.data[i + 3] = a;
    };
    set(0, 200, 0, 0, 255); set(1, 210, 4, 0, 255); set(2, 220, 8, 0, 255);
    set(3, 0, 0, 255, 255); set(4, 200, 0, 0, 255);
    // tolerance 0: only the exact seed colour is replaced
    floodFill(c, 0, 0, [0, 255, 0, 255]);
    eq("fill.tol0.exact", [at(c, 0, 0), at(c, 1, 0), at(c, 2, 0)], [[0, 255, 0, 255], [210, 4, 0, 255], [220, 8, 0, 255]]);
    eq("fill.tol0.wall", at(c, 3, 0), [0, 0, 255, 255]);
    eq("fill.tol0.beyond", at(c, 4, 0), [200, 0, 0, 255]);
    // tolerance 24: the near-reds join the region, the wall still stops it
    const c2 = new Cel(8, 1);
    const set2 = (x: number, r: number, g: number, b: number, a: number): void => {
      const i = c2.idx(x, 0);
      c2.data[i] = r; c2.data[i + 1] = g; c2.data[i + 2] = b; c2.data[i + 3] = a;
    };
    set2(0, 200, 0, 0, 255); set2(1, 210, 4, 0, 255); set2(2, 220, 8, 0, 255);
    set2(3, 0, 0, 255, 255); set2(4, 200, 0, 0, 255);
    floodFill(c2, 0, 0, [0, 255, 0, 255], null, { tolerance: 24 });
    eq("fill.tol24.region", [at(c2, 0, 0), at(c2, 1, 0), at(c2, 2, 0)], [[0, 255, 0, 255], [0, 255, 0, 255], [0, 255, 0, 255]]);
    eq("fill.tol24.stops", [at(c2, 3, 0), at(c2, 4, 0)], [[0, 0, 255, 255], [200, 0, 0, 255]]);
    // global (non-contiguous) fill honours the tolerance too
    const c3 = new Cel(8, 1);
    for (let x = 0; x < 8; x++) set3(c3, x, x < 4 ? 200 + x : 100, 0, 0, 255);
    globalFill(c3, 0, 0, [0, 255, 0, 255], null, { tolerance: 8 });
    eq("fill.global-tol", [at(c3, 0, 0), at(c3, 3, 0), at(c3, 4, 0)], [[0, 255, 0, 255], [0, 255, 0, 255], [100, 0, 0, 255]]);

    // a 5x5 box drawn with a 1px gap: without gap closing the fill leaks out
    const box = (gap: boolean): Cel => {
      const b = new Cel(7, 7);
      for (let i = 1; i <= 5; i++) {
        for (const [x, y] of [[i, 1], [i, 5], [1, i], [5, i]] as Array<[number, number]>) {
          const p = b.idx(x, y);
          b.data[p] = 0; b.data[p + 1] = 0; b.data[p + 2] = 0; b.data[p + 3] = 255;
        }
      }
      // the gap sits in the top edge
      if (gap) {
        const p = b.idx(3, 1);
        b.data[p + 3] = 0;
      }
      return b;
    };
    const leak = box(true);
    floodFill(leak, 3, 3, [255, 0, 0, 255]);
    ok("fill.gap.leaks-without", at(leak, 0, 0)[3] === 255, "outside filled: " + JSON.stringify(at(leak, 0, 0)));
    const sealed = box(true);
    floodFill(sealed, 3, 3, [255, 0, 0, 255], null, { gaps: 1 });
    eq("fill.gap.inside-filled", at(sealed, 3, 3), [255, 0, 0, 255]);
    eq("fill.gap.outside-clean", at(sealed, 0, 0), [0, 0, 0, 0]);
    eq("fill.gap.line-kept", at(sealed, 1, 1), [0, 0, 0, 255]);
    // no gap -> identical result with or without gap closing
    const solidA = box(false); floodFill(solidA, 3, 3, [255, 0, 0, 255]);
    const solidB = box(false); floodFill(solidB, 3, 3, [255, 0, 0, 255], null, { gaps: 2 });
    eq("fill.gap.solid-same", [at(solidA, 3, 3), at(solidA, 0, 0), at(solidB, 3, 3), at(solidB, 0, 0)],
      [[255, 0, 0, 255], [0, 0, 0, 0], [255, 0, 0, 255], [0, 0, 0, 0]]);
    // an outline that runs along the canvas edge still holds the fill inside
    const edge = new Cel(5, 5);
    for (let x = 0; x < 5; x++) { const p = edge.idx(x, 0); edge.data[p + 3] = 255; edge.data[p] = 0; edge.data[p + 1] = 0; edge.data[p + 2] = 0; }
    for (let y = 0; y < 5; y++) { const p = edge.idx(0, y); edge.data[p + 3] = 255; edge.data[p] = 0; edge.data[p + 1] = 0; edge.data[p + 2] = 0; }
    floodFill(edge, 3, 3, [255, 0, 0, 255], null, { gaps: 2 });
    eq("fill.gap.edge-line", at(edge, 2, 0), [0, 0, 0, 255]);
    eq("fill.gap.edge-inside", at(edge, 3, 3), [255, 0, 0, 255]);
  }
}

/** tiny deterministic PRNG so the spray tests can assert exact specks */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
