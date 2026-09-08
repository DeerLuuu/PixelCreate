import { Doc, Sel } from "../src/engine/doc";
import { selOps } from "../src/tools/select";
import { eq, ok } from "./common";

function maskOf(doc: Doc): string {
  const m = doc.sel ? doc.sel.mask : new Uint8Array(doc.w * doc.h);
  let s = "";
  for (let i = 0; i < m.length; i++) s += m[i] ? "1" : "0";
  return s;
}

export function testSel(): void {
  // --- invert on an EMPTY selection selects everything ---
  {
    const doc = new Doc(4, 3, "t");
    doc.sel = new Sel(doc.w, doc.h);
    selOps.invert(doc);
    eq("sel.invert.empty-becomes-all", maskOf(doc), "1".repeat(12));
    ok("sel.invert.all-has-any", !!doc.sel && doc.sel.hasAny());
  }

  // --- invert flips an existing mask pixel by pixel ---
  {
    const doc = new Doc(4, 3, "t");
    doc.sel = new Sel(doc.w, doc.h);
    // select the left half of the first two rows: (0,0)(1,0)(0,1)(1,1)
    doc.sel.set(0, 0, 1); doc.sel.set(1, 0, 1);
    doc.sel.set(0, 1, 1); doc.sel.set(1, 1, 1);
    selOps.invert(doc);
    eq("sel.invert.flips", maskOf(doc), "0011" + "0011" + "1111");
  }

  // --- inverting twice restores the original mask ---
  {
    const doc = new Doc(4, 3, "t");
    doc.sel = new Sel(doc.w, doc.h);
    doc.sel.set(2, 2, 1);
    const before = maskOf(doc);
    selOps.invert(doc);
    selOps.invert(doc);
    eq("sel.invert.twice-identity", maskOf(doc), before);
  }

  // --- selectAll still works (regression) ---
  {
    const doc = new Doc(3, 2, "t");
    selOps.selectAll(doc);
    eq("sel.select-all", maskOf(doc), "111111");
  }

  // --- invert on a full selection clears it ---
  {
    const doc = new Doc(3, 2, "t");
    selOps.selectAll(doc);
    selOps.invert(doc);
    eq("sel.invert.full-becomes-empty", maskOf(doc), "000000");
    ok("sel.invert.empty-has-none", !!doc.sel && !doc.sel.hasAny());
  }
}
