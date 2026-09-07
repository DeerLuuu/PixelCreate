import { Doc } from "../src/engine/doc";
import { Stroke } from "../src/tools/stroke";
import { rgba } from "../src/engine/color";
import { eq } from "./common";

function px(d: Uint8ClampedArray, w: number, x: number, y: number): number {
  const i = (y * w + x) * 4;
  return d[i + 3]; // alpha is enough: 0 = untouched, 255 = painted
}
function paintStroke(doc: Doc, sym: "lr" | "tb" | "both", qx: number, qy: number, pts: [number, number][]): Uint8ClampedArray {
  const c = doc.ensureCel(0, 0);
  const st = new Stroke(doc, 0, 0, "pencil", { color: rgba(200, 30, 60, 255), size: 1, alpha: 100, pressure: 1 }, false, sym, 6, true, qx, qy);
  for (const [x, y] of pts) st.startAt(x, y);
  return c.data;
}

export function testSym(): void {
  { // default centred lr axis keeps the classic w-1-x mapping
    const doc = new Doc(12, 12, "t");
    const d = paintStroke(doc, "lr", 0, 0, [[2, 4], [5, 7]]);
    eq("s.lr.center.pairs", px(d, 12, 9, 4) === 255 && px(d, 12, 6, 7) === 255, true);
  }
  { // shifted vertical axis: partner of x is w-1-x+qx (axis at (w+qx)/2)
    const doc = new Doc(12, 12, "t");
    const d = paintStroke(doc, "lr", 2, 0, [[2, 5], [3, 5]]);
    eq("s.lr.q2.partner", px(d, 12, 11, 5) === 255 && px(d, 12, 10, 5) === 255, true);
    eq("s.lr.q2.no.leftover", px(d, 12, 0, 5) === 0, true);
  }
  { // shifted horizontal axis works the same way in tb mode
    const doc = new Doc(12, 12, "t");
    const d = paintStroke(doc, "tb", 0, -3, [[6, 2]]);
    // y2 = 11 - 2 - 3 = 6
    eq("s.tb.qy.partner", px(d, 12, 6, 6) === 255, true);
    eq("s.tb.qy.no.top", px(d, 12, 6, 0) === 0, true);
  }
  { // four-way: both axes shift independently
    const doc = new Doc(12, 12, "t");
    const d = paintStroke(doc, "both", -2, 1, [[1, 1]]);
    // x2 = 11-1-2 = 8 ; y2 = 11-1+1 = 11
    eq("s.both.cross", px(d, 12, 1, 1) === 255 && px(d, 12, 8, 1) === 255 && px(d, 12, 1, 11) === 255 && px(d, 12, 8, 11) === 255, true);
  }
  { // erasing mirrors to the shifted partner too
    const doc = new Doc(12, 12, "t");
    const c = doc.ensureCel(0, 0);
    const st = new Stroke(doc, 0, 0, "pencil", { color: rgba(200, 30, 60, 255), size: 1, alpha: 100, pressure: 1 }, false, "lr", 6, true, 2, 0);
    st.startAt(2, 5); // paints (2,5) + partner (11,5)
    const er = new Stroke(doc, 0, 0, "eraser", { color: rgba(0, 0, 0, 0), size: 1, alpha: 0, pressure: 1 }, false, "lr", 6, true, 2, 0);
    er.startAt(11, 5); // erase lands on the partner -> mirror erases both
    eq("s.lr.q2.erase.both", px(c.data, 12, 2, 5) === 0 && px(c.data, 12, 11, 5) === 0, true);
  }
}
