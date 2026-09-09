import { Cel } from "../src/engine/cel";
import { floodFill, globalFill, globalErase, polygonCells, fillPolygon } from "../src/engine/paint";
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
}
