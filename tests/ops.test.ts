import { Doc } from "../src/engine/doc";
import * as ops from "../src/engine/ops";
import { eq, ok } from "./common";

// Content is tracked as a plain 2-D array mirror (code per cell), where code 0
// means "no cel". The engine ops are mirrored onto this simple array model, so
// re-indexing / re-keying bugs (like interleaved delete+set on the cel Map)
// surface as a matrix mismatch instead of being mirrored silently.

function codeAt(doc: Doc, li: number, fi: number): number {
  const c = doc.celAt(li, fi);
  if (!c) return 0;
  return c.data[(1 * doc.w + 1) * 4];
}

function paint(doc: Doc, li: number, fi: number, code: number): void {
  const c = doc.ensureCel(li, fi);
  const p = (1 * doc.w + 1) * 4;
  c.data[p] = code; c.data[p + 3] = 255;
}

function syncModel(doc: Doc, m: number[][]): void {
  for (let li = 0; li < doc.layers.length; li++) {
    for (let fi = 0; fi < doc.frames.length; fi++) {
      const want = m[li][fi];
      const got = codeAt(doc, li, fi);
      if (want === 0) ok("cell empty @" + li + "," + fi, got === 0);
      else ok("cell code @" + li + "," + fi, got === want, "got " + got + " want " + want);
    }
  }
}

function freshMatrix(rows: number, cols: number): number[][] {
  const m: number[][] = [];
  for (let r = 0; r < rows; r++) { m.push([]); for (let c = 0; c < cols; c++) m[r].push(0); }
  return m;
}

// array helpers mirroring each op on the model
function mAddLayer(m: number[][], at: number): void { m.splice(at, 0, m[0].map(() => 0)); }
function mRemoveLayer(m: number[][], li: number): void { m.splice(li, 1); }
function mDuplicateLayer(m: number[][], li: number): void { m.splice(li + 1, 0, m[li].slice()); }
function mMoveLayer(m: number[][], from: number, to: number): void { const r = m.splice(from, 1)[0]; m.splice(to, 0, r); }
function mAddFrame(m: number[][], at: number): void { for (const r of m) r.splice(at, 0, 0); }
function mRemoveFrame(m: number[][], fi: number): void { for (const r of m) r.splice(fi, 1); }
function mDuplicateFrame(m: number[][], fi: number): void { for (const r of m) r.splice(fi + 1, 0, r[fi]); }
function mMoveFrame(m: number[][], from: number, to: number): void {
  const col: number[] = []; for (const r of m) col.push(r.splice(from, 1)[0]);
  for (let i = 0; i < m.length; i++) m[i].splice(to, 0, col[i]);
}

function buildDoc(rows: number, cols: number): { doc: Doc; m: number[][] } {
  const doc = new Doc(5, 5, "t");
  const m = freshMatrix(rows, cols);
  for (let li = 0; li < rows; li++) { if (li > 0) ops.addLayer(doc, doc.layers.length); }
  for (let fi = 0; fi < cols; fi++) { if (fi > 0) ops.addFrame(doc, doc.frames.length); }
  // unique codes
  for (let li = 0; li < rows; li++) for (let fi = 0; fi < cols; fi++) { const code = li * 40 + fi * 5 + 3; paint(doc, li, fi, code); m[li][fi] = code; }
  return { doc, m };
}

export function testOps(): void {
  { // frame add/dup/move/remove keep cel content with the right frame (2 layers)
    const { doc, m } = buildDoc(2, 4);
    ops.addFrame(doc, 1); mAddFrame(m, 1);          // insert empty in middle
    ops.duplicateFrame(doc, 0); mDuplicateFrame(m, 0);
    ops.moveFrame(doc, 3, 0); mMoveFrame(m, 3, 0);   // chained remap
    ops.removeFrame(doc, 0); mRemoveFrame(m, 0);
    ops.duplicateFrame(doc, doc.frames.length - 1); mDuplicateFrame(m, m[0].length - 1);
    ops.moveFrame(doc, doc.frames.length - 1, 1); mMoveFrame(m, m[0].length - 1, 1);
    eq("frm final frames", doc.frames.length, m[0].length);
    syncModel(doc, m);
  }
  { // layer add/dup/move/remove keep cel content with the right layer (2 frames)
    const { doc, m } = buildDoc(3, 2);
    ops.duplicateLayer(doc, 1); mDuplicateLayer(m, 1);
    ops.moveLayer(doc, 2, 0); mMoveLayer(m, 2, 0);   // chained remap
    ops.removeLayer(doc, 2); mRemoveLayer(m, 2);
    ops.addLayer(doc, 1); mAddLayer(m, 1);
    ops.removeLayer(doc, 0); mRemoveLayer(m, 0);
    ops.duplicateLayer(doc, doc.layers.length - 1); mDuplicateLayer(m, m.length - 1);
    eq("lyr final layers", doc.layers.length, m.length);
    syncModel(doc, m);
  }
  { // frame drag reorder chain 0->3->1->2 stress
    const { doc, m } = buildDoc(2, 5);
    ops.moveFrame(doc, 0, 3); mMoveFrame(m, 0, 3);
    ops.moveFrame(doc, 3, 1); mMoveFrame(m, 3, 1);
    ops.moveFrame(doc, 1, 2); mMoveFrame(m, 1, 2);
    ops.moveFrame(doc, 4, 0); mMoveFrame(m, 4, 0);
    ops.moveLayer(doc, 1, 0); mMoveLayer(m, 1, 0);
    ops.moveLayer(doc, 0, 1); mMoveLayer(m, 0, 1);
    syncModel(doc, m);
  }
  { // remove every layer/frame down to the last one is guarded
    const { doc } = buildDoc(2, 2);
    ops.removeLayer(doc, 1);
    ok("remove down to one layer", doc.layers.length === 1);
    ops.removeFrame(doc, 0);
    ok("remove frame keeps >=1", doc.frames.length === 1);
  }
  { // mergeLayerDown: top layer merged into bottom across frames
    const doc = new Doc(3, 3, "t");
    ops.addLayer(doc, 1); ops.addFrame(doc, 1);
    const top = doc.ensureCel(1, 0); const bot = doc.ensureCel(0, 0);
    top.data.fill(0); top.data[0] = 200; top.data[3] = 255;
    bot.data.fill(0); bot.data[0] = 30;
    const merge = (dst: { data: Uint8ClampedArray }, src: { data: Uint8ClampedArray }) => {
      for (let i = 0; i < dst.data.length; i += 4) { if (src.data[i + 3] > 0) { dst.data[i] = src.data[i]; dst.data[i + 1] = src.data[i + 1]; dst.data[i + 2] = src.data[i + 2]; dst.data[i + 3] = 255; } }
    };
    ops.mergeLayerDown(doc, 1, merge as never);
    ok("merge removes top layer", doc.layers.length === 1);
    const r = doc.celAt(0, 0)!;
    ok("merge wrote pixel", r.data[0] === 200 && r.data[3] === 255);
  }
  { // canvas resize keeps content anchored (copy region intact)
    const doc = new Doc(4, 4, "t");
    const c = doc.ensureCel(0, 0);
    c.data[(1 * 4 + 1) * 4] = 77; c.data[(1 * 4 + 1) * 4 + 3] = 255;
    ops.resizeDocCanvas(doc, 8, 8, 2, 2);
    ok("resize dims", doc.w === 8 && doc.h === 8);
    const c2r = doc.celAt(0, 0)!;
    ok("content anchored at +2", c2r.data[(3 * 8 + 3) * 4] === 77, "got " + c2r.data[(3 * 8 + 3) * 4]);
  }
  { // sprite scale nearest neighbour
    const doc = new Doc(2, 2, "t");
    const c = doc.ensureCel(0, 0);
    c.data[(0 * 2 + 1) * 4] = 55; c.data[(0 * 2 + 1) * 4 + 3] = 255;
    ops.scaleDocSprite(doc, 4, 4);
    const c4 = doc.celAt(0, 0)!;
    ok("scaled dims", doc.w === 4 && doc.h === 4);
    ok("nearest duplicated", c4.data[(0 * 4 + 2) * 4] === 55 && c4.data[(0 * 4 + 3) * 4] === 55 && c4.data[(0 * 4 + 3) * 4 + 3] === 255);
  }
}