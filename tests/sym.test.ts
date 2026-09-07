import { Doc } from "../src/engine/doc";
import { Stroke } from "../src/tools/stroke";
import { rgba } from "../src/engine/color";
import { eq } from "./common";

function px(d: Uint8ClampedArray, w: number, x: number, y: number): number {
  const i = (y * w + x) * 4;
  return d[i + 3]; // alpha is enough: 0 = untouched, 255 = painted
}
/** paint with a pencil; geometry = pivot offset from doc centre (ox,oy) + axis angle (deg) */
function paintStroke(doc: Doc, sym: "lr" | "tb" | "both", ox: number, oy: number, ang: number, pts: [number, number][]): Uint8ClampedArray {
  const c = doc.ensureCel(0, 0);
  const st = new Stroke(doc, 0, 0, "pencil", { color: rgba(200, 30, 60, 255), size: 1, alpha: 100, pressure: 1 }, false, sym, 6, true, ox, oy, ang);
  for (const [x, y] of pts) st.startAt(x, y);
  return c.data;
}

export function testSym(): void {
  { // default centred lr axis (vertical, 90deg) keeps the classic w-1-x mapping
    const doc = new Doc(12, 12, "t");
    const d = paintStroke(doc, "lr", 0, 0, 90, [[2, 4], [5, 7]]);
    eq("s.lr.center.pairs", px(d, 12, 9, 4) === 255 && px(d, 12, 6, 7) === 255, true);
  }
  { // shifted vertical axis: pivot +1 to the right of centre
    const doc = new Doc(12, 12, "t");
    const d = paintStroke(doc, "lr", 1, 0, 90, [[2, 5], [3, 5]]);
    eq("s.lr.offset.partner", px(d, 12, 11, 5) === 255 && px(d, 12, 10, 5) === 255, true);
    eq("s.lr.offset.no.leftover", px(d, 12, 0, 5) === 0, true);
  }
  { // tb mode = horizontal axis (0deg), pivot shifted up 1.5 cells: y' = 2py-1-y
    const doc = new Doc(12, 12, "t");
    const d = paintStroke(doc, "tb", 0, -1.5, 0, [[6, 2]]);
    // py = 6-1.5 = 4.5, so y' = 8-y -> 2 -> 6
    eq("s.tb.offset.partner", px(d, 12, 6, 6) === 255, true);
    eq("s.tb.offset.no.top", px(d, 12, 6, 0) === 0, true);
  }
  { // four-way cross: pivot (-1, +0.5), vertical axis -> four images per cell
    const doc = new Doc(12, 12, "t");
    const d = paintStroke(doc, "both", -1, 0.5, 90, [[1, 1]]);
    // vertical axis x' = 2*(6-1)-1-x = 9-x  ; horizontal y' = 2*(6.5)-1-y = 12-y
    eq("s.both.cross", px(d, 12, 1, 1) === 255 && px(d, 12, 8, 1) === 255 && px(d, 12, 1, 11) === 255 && px(d, 12, 8, 11) === 255, true);
  }
  { // rotated diagonal axis (45deg through centre) mirrors across y=x
    const doc = new Doc(12, 12, "t");
    const d = paintStroke(doc, "lr", 0, 0, 45, [[1, 2]]);
    eq("s.angle45.partner", px(d, 12, 2, 1) === 255, true);
    eq("s.angle45.diag.pb", px(d, 12, 1, 2) === 255, true);
  }
  { // erasing mirrors to the offset partner too
    const doc = new Doc(12, 12, "t");
    const c = doc.ensureCel(0, 0);
    const st = new Stroke(doc, 0, 0, "pencil", { color: rgba(200, 30, 60, 255), size: 1, alpha: 100, pressure: 1 }, false, "lr", 6, true, 1, 0, 90);
    st.startAt(2, 5); // paints (2,5) + partner (11,5)
    const er = new Stroke(doc, 0, 0, "eraser", { color: rgba(0, 0, 0, 0), size: 1, alpha: 0, pressure: 1 }, false, "lr", 6, true, 1, 0, 90);
    er.startAt(11, 5); // erase lands on the partner -> mirror erases both
    eq("s.lr.offset.erase.both", px(c.data, 12, 2, 5) === 0 && px(c.data, 12, 11, 5) === 0, true);
  }
}
