import { Doc } from "../src/engine/doc";
import { History } from "../src/engine/history";
import * as ops from "../src/engine/ops";
import { eq, ok } from "./common";

function px(d: Doc, li: number, fi: number): Uint8ClampedArray | null {
  const c = d.celAt(li, fi);
  return c ? new Uint8ClampedArray(c.data) : null;
}
function setPx(c: { w: number; data: Uint8ClampedArray }, x: number, y: number, r: number, g: number, b: number, a: number): void {
  const i = (y * c.w + x) * 4;
  c.data[i] = r; c.data[i + 1] = g; c.data[i + 2] = b; c.data[i + 3] = a;
}

export function testHistory(): void {
  { // 1) born cel
    const doc = new Doc(8, 8, "t"); const h = new History();
    const c = doc.ensureCel(0, 0);
    setPx(c, 2, 3, 255, 0, 0, 255); setPx(c, 5, 6, 0, 255, 0, 255);
    const after = new Uint8ClampedArray(c.data);
    h.pushPixels("born", doc, [{ li: 0, fi: 0, before: null, after }]);
    h.undo(); eq("h.born.undo deletes cel", px(doc, 0, 0), null);
    h.redo(); eq("h.born.redo restores", px(doc, 0, 0), after);
    h.undo(); h.redo(); eq("h.born.cycle2", px(doc, 0, 0), after);
  }
  { // 2) sparse edit
    const doc = new Doc(8, 8, "t"); const h = new History();
    const c = doc.ensureCel(0, 0);
    setPx(c, 0, 0, 10, 20, 30, 255); setPx(c, 7, 7, 1, 2, 3, 255);
    const before = new Uint8ClampedArray(c.data);
    setPx(c, 3, 3, 200, 100, 50, 255); setPx(c, 4, 4, 9, 9, 9, 200);
    const after = new Uint8ClampedArray(c.data);
    h.pushPixels("edit", doc, [{ li: 0, fi: 0, before, after }]);
    h.undo(); eq("h.edit.undo", px(doc, 0, 0), before);
    h.redo(); eq("h.edit.redo", px(doc, 0, 0), after);
  }
  { // 3) clear to zero
    const doc = new Doc(6, 6, "t"); const h = new History();
    const c = doc.ensureCel(0, 0);
    setPx(c, 1, 1, 255, 0, 0, 255); setPx(c, 2, 2, 0, 0, 255, 128);
    const before = new Uint8ClampedArray(c.data);
    c.data.fill(0);
    const after = new Uint8ClampedArray(c.data);
    h.pushPixels("clear", doc, [{ li: 0, fi: 0, before, after }]);
    h.undo(); eq("h.clear.undo", px(doc, 0, 0), before);
    h.redo(); eq("h.clear.redo", px(doc, 0, 0), after);
  }
  { // 4) removal
    const doc = new Doc(5, 5, "t"); const h = new History();
    const c = doc.ensureCel(0, 0);
    setPx(c, 2, 2, 12, 34, 56, 255);
    const before = new Uint8ClampedArray(c.data);
    doc.cels.delete(doc.key(0, 0));
    h.pushPixels("remove", doc, [{ li: 0, fi: 0, before, after: null }]);
    eq("h.remove.now gone", px(doc, 0, 0), null);
    h.undo(); eq("h.remove.undo", px(doc, 0, 0), before);
    h.redo(); eq("h.remove.redo gone", px(doc, 0, 0), null);
  }
  { // 5) dense fallback
    const doc = new Doc(16, 16, "t"); const h = new History();
    const c = doc.ensureCel(0, 0);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) setPx(c, x, y, 255, 255, 255, 255);
    const before = new Uint8ClampedArray(c.data);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) setPx(c, x, y, x, y, 0, 255);
    const after = new Uint8ClampedArray(c.data);
    h.pushPixels("fill", doc, [{ li: 0, fi: 0, before, after }]);
    h.undo(); eq("h.fill.undo", px(doc, 0, 0), before);
    h.redo(); eq("h.fill.redo", px(doc, 0, 0), after);
  }
  { // 6) multi cel one entry
    const doc = new Doc(4, 4, "t"); const h = new History();
    const c0 = doc.ensureCel(0, 0); const c1 = doc.ensureCel(0, 1);
    setPx(c0, 0, 0, 1, 0, 0, 255); setPx(c1, 3, 3, 0, 1, 0, 255);
    const b0 = new Uint8ClampedArray(c0.data); const b1 = new Uint8ClampedArray(c1.data);
    setPx(c0, 0, 0, 9, 9, 9, 255); setPx(c1, 3, 3, 8, 8, 8, 255);
    const a0 = new Uint8ClampedArray(c0.data); const a1 = new Uint8ClampedArray(c1.data);
    h.pushPixels("multi", doc, [
      { li: 0, fi: 0, before: b0, after: a0 },
      { li: 0, fi: 1, before: b1, after: a1 },
    ]);
    h.undo(); eq("h.multi.undo0", px(doc, 0, 0), b0); eq("h.multi.undo1", px(doc, 0, 1), b1);
    h.redo(); eq("h.multi.redo0", px(doc, 0, 0), a0); eq("h.multi.redo1", px(doc, 0, 1), a1);
  }
  { // 7) no-op adds no step
    const doc = new Doc(4, 4, "t"); const h = new History();
    const c = doc.ensureCel(0, 0);
    const before = new Uint8ClampedArray(c.data);
    h.pushPixels("noop", doc, [{ li: 0, fi: 0, before, after: new Uint8ClampedArray(c.data) }]);
    ok("h.noop no step", !h.canUndo());
  }
  { // 8) struct snapshot
    const doc = new Doc(6, 6, "t"); const h = new History();
    const c = doc.ensureCel(0, 0);
    setPx(c, 1, 1, 255, 0, 0, 255);
    const pre = new Uint8ClampedArray(c.data);
    h.pushStruct("struct", doc, () => {
      setPx(doc.celAt(0, 0)!, 2, 2, 0, 0, 255, 255);
      ops.addLayer(doc, doc.layers.length);
    });
    h.undo();
    eq("h.struct.undo px", px(doc, 0, 0), pre);
    ok("h.struct.undo layers", doc.layers.length === 1);
    h.redo();
    ok("h.struct.redo layers", doc.layers.length === 2);
    const rp = px(doc, 0, 0)!; const i = (2 * 6 + 2) * 4;
    ok("h.struct.redo px set", rp[i] === 0 && rp[i + 1] === 0 && rp[i + 2] === 255 && rp[i + 3] === 255);
  }
}