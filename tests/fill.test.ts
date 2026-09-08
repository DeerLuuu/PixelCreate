import { Cel } from "../src/engine/cel";
import { floodFill, globalFill, globalErase } from "../src/engine/paint";
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
