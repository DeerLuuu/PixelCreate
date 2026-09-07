import { Doc, Sel } from "../src/engine/doc";
import { beginMove, selOps } from "../src/tools/select";
import { eq } from "./common";

function setPx(c: { w: number; data: Uint8ClampedArray }, x: number, y: number, r: number, g: number, b: number, a: number): void {
  const i = (y * c.w + x) * 4;
  c.data[i] = r; c.data[i + 1] = g; c.data[i + 2] = b; c.data[i + 3] = a;
}
function isV(d: Uint8ClampedArray, x: number, y: number, r: number, g: number, b: number, a: number, w: number): boolean {
  const i = (y * w + x) * 4;
  return d[i] === r && d[i + 1] === g && d[i + 2] === b && d[i + 3] === a;
}
function outlineSel(doc: Doc): void {
  doc.sel = new Sel(doc.w, doc.h);
  for (let x = 0; x < doc.w; x++) {
    for (let y = 0; y < doc.h; y++) {
      const on = ((y === 2 || y === 5) && x >= 2 && x <= 5) || ((x === 2 || x === 5) && y >= 2 && y <= 5);
      if (on) doc.sel.set(x, y, 1);
    }
  }
}

export function testMove(): void {
  { // dragging a hollow-square mask across artwork then away never carries it
    const doc = new Doc(16, 16, "t");
    const c = doc.ensureCel(0, 0);
    for (let x = 2; x <= 5; x++) { setPx(c, x, 2, 10, 10, 10, 255); setPx(c, x, 5, 10, 10, 10, 255); }
    for (let y = 2; y <= 5; y++) { setPx(c, 2, y, 10, 10, 10, 255); setPx(c, 5, y, 10, 10, 10, 255); }
    setPx(c, 3, 3, 200, 0, 0, 255); // "1"-like artwork inside the hollow bbox
    outlineSel(doc);
    const st = beginMove(doc, 0, 0);
    if (!st) throw new Error("beginMove failed");
    selOps.move(doc, 0, 0, 1, 0, st); // drag across the red pixel
    selOps.move(doc, 0, 0, 5, 0, st); // drag away again (same gesture)
    eq("m.cross.away.red.stays", isV(c.data, 3, 3, 200, 0, 0, 255, 16), true);
    eq("m.cross.away.origin.cleared", isV(c.data, 3, 2, 0, 0, 0, 0, 16), true);
    eq("m.cross.away.landed", isV(c.data, 7, 2, 10, 10, 10, 255, 16), true);
  }
  { // releasing exactly over artwork covers it (Aseprite drop = paste), not carry
    const doc = new Doc(16, 16, "t");
    const c = doc.ensureCel(0, 0);
    for (let x = 2; x <= 5; x++) { setPx(c, x, 2, 10, 10, 10, 255); setPx(c, x, 5, 10, 10, 10, 255); }
    for (let y = 2; y <= 5; y++) { setPx(c, 2, y, 10, 10, 10, 255); setPx(c, 5, y, 10, 10, 10, 255); }
    setPx(c, 3, 3, 200, 0, 0, 255);
    outlineSel(doc);
    const st = beginMove(doc, 0, 0);
    if (!st) throw new Error("beginMove failed");
    selOps.move(doc, 0, 0, 1, 0, st); // one final step overlapping the red pixel
    eq("m.rest.over.red.covered", isV(c.data, 3, 3, 200, 0, 0, 255, 16), false);
    eq("m.rest.mask.pixel", isV(c.data, 3, 3, 10, 10, 10, 255, 16), true);
  }
}
