// Incremental-rendering tests: the pure rect helpers, the dirty region a live
// stroke reports, and the selection version the tint cache hangs on.
import { Doc, Sel } from "../src/engine/doc";
import { Stroke } from "../src/tools/stroke";
import type { BrushState, SymMode } from "../src/tools/registry";
import { clampRect, coversAll, screenRectOf, unionRect } from "../src/render/rect";
import { growSelection, selOps, shrinkSelection } from "../src/tools/select";
import { onionGhosts } from "../src/render/onion";
import { eq, ok } from "./common";

const brush = (size = 1, color: [number, number, number, number] = [255, 0, 0, 255]): BrushState => ({
  color, size, alpha: 255, pressure: 1,
} as BrushState);

function strokeOn(doc: Doc, kind: "pencil" | "eraser" | "line" | "bucket", size = 1, sym: SymMode = "off"): Stroke {
  return new Stroke(doc, 0, 0, kind, brush(size), false, sym, 6, true, 0, 0, 90, false, false);
}

/** true when the rect contains every non-transparent pixel of the doc */
function coversPainted(doc: Doc, r: { x: number; y: number; w: number; h: number }): boolean {
  const cel = doc.celAt(0, 0);
  if (!cel) return false;
  for (let y = 0; y < doc.h; y++) {
    for (let x = 0; x < doc.w; x++) {
      if (cel.data[cel.idx(x, y) + 3] === 0) continue;
      if (x < r.x || y < r.y || x >= r.x + r.w || y >= r.y + r.h) return false;
    }
  }
  return true;
}

export function testRender(): void {
  // ---------------------------------------------------------------- rects
  eq("rect.union.both", unionRect({ x: 2, y: 3, w: 4, h: 5 }, { x: 0, y: 6, w: 2, h: 2 }), { x: 0, y: 3, w: 6, h: 5 });
  eq("rect.union.left-null", unionRect(null, { x: 1, y: 1, w: 2, h: 2 }), { x: 1, y: 1, w: 2, h: 2 });
  eq("rect.union.both-null", unionRect(null, null), null);
  eq("rect.union.inside", unionRect({ x: 0, y: 0, w: 9, h: 9 }, { x: 3, y: 3, w: 1, h: 1 }), { x: 0, y: 0, w: 9, h: 9 });

  eq("rect.clamp.inside", clampRect({ x: -3, y: -3, w: 5, h: 5 }, 16, 16), { x: 0, y: 0, w: 2, h: 2 });
  eq("rect.clamp.fractional", clampRect({ x: 1.4, y: 2.6, w: 3.2, h: 1.2 }, 16, 16), { x: 1, y: 2, w: 4, h: 2 });
  eq("rect.clamp.outside", clampRect({ x: 20, y: 20, w: 4, h: 4 }, 16, 16), null);

  // doc -> screen: 8x zoom at (100,50), 2px pad
  eq("rect.screen.basic", screenRectOf({ x: 2, y: 1, w: 4, h: 3 }, 100, 50, 8), { x: 114, y: 56, w: 36, h: 28 });
  eq("rect.screen.pad0", screenRectOf({ x: 0, y: 0, w: 1, h: 1 }, 0, 0, 1, 0), { x: 0, y: 0, w: 1, h: 1 });
  ok("rect.covers", coversAll({ x: 0, y: 0, w: 16, h: 16 }, 16, 16));
  ok("rect.covers.no", !coversAll({ x: 1, y: 0, w: 15, h: 16 }, 16, 16));

  // ------------------------------------------------- stroke dirty region
  {
    const doc = new Doc(32, 32, "t");
    const st = strokeOn(doc, "pencil", 1);
    st.startAt(10, 10);
    const first = st.takeDirty();
    eq("render.dirty.first-dot", first, { x: 10, y: 10, w: 1, h: 1 });
    eq("render.dirty.after-take", st.takeDirty(), null);
    st.moveTo(14, 10, 1);
    const seg = st.takeDirty();
    ok("render.dirty.segment", !!seg && seg.x <= 10 && seg.x + seg.w >= 15 && seg.y === 10 && seg.h === 1, JSON.stringify(seg));
    ok("render.dirty.covers-paint", !!seg && coversPainted(doc, seg));
  }

  // a wider brush must report the whole stamp, not just the centre cell
  {
    const doc = new Doc(32, 32, "t");
    const st = strokeOn(doc, "pencil", 5);
    st.startAt(16, 16);
    const r = st.takeDirty();
    ok("render.dirty.brush-radius", !!r && r.w >= 3 && r.h >= 3 && r.x <= 15 && r.y <= 15, JSON.stringify(r));
    ok("render.dirty.brush-covers", !!r && coversPainted(doc, r));
  }

  // symmetry paints mirrored cells: both sides have to be inside the region
  {
    const doc = new Doc(32, 32, "t");
    const st = strokeOn(doc, "pencil", 1, "on");
    st.startAt(4, 8);
    const r = st.takeDirty();
    ok("render.dirty.symmetry", !!r && coversPainted(doc, r), JSON.stringify(r));
    ok("render.dirty.symmetry-wide", !!r && r.w >= 24, JSON.stringify(r));
  }

  // eraser reports the erased area too
  {
    const doc = new Doc(16, 16, "t");
    const p = strokeOn(doc, "pencil", 3);
    p.startAt(8, 8);
    p.takeDirty();
    const e = strokeOn(doc, "eraser", 3);
    e.startAt(8, 8);
    const r = e.takeDirty();
    ok("render.dirty.eraser", !!r && r.x <= 7 && r.y <= 7 && r.w >= 3 && r.h >= 3, JSON.stringify(r));
  }

  // shapes redraw from scratch: the previous outline must stay in the region
  {
    const doc = new Doc(32, 32, "t");
    const st = strokeOn(doc, "line", 1);
    st.startAt(2, 2);
    st.takeDirty();
    st.moveTo(30, 2, 1); // long line
    const big = st.takeDirty();
    st.moveTo(4, 2, 1); // short line: the old long line has to be repainted
    const back = st.takeDirty();
    ok("render.dirty.shape-grow", !!big && big.w >= 28, JSON.stringify(big));
    ok("render.dirty.shape-shrink-keeps-old", !!back && back.w >= 28, JSON.stringify(back));
    ok("render.dirty.shape-covers", !!back && coversPainted(doc, back));
  }

  // flood fill can touch the whole layer: the region must be the full frame
  {
    const doc = new Doc(16, 16, "t");
    const st = strokeOn(doc, "bucket", 1);
    st.startAt(8, 8);
    eq("render.dirty.bucket-full", st.takeDirty(), { x: 0, y: 0, w: 16, h: 16 });
  }

  // ------------------------------------------------------- selection ver
  {
    const sel = new Sel(8, 8);
    const v0 = sel.ver;
    sel.set(1, 1, 1);
    ok("render.sel.ver-set", sel.ver > v0, "v0=" + v0 + " now=" + sel.ver);
    const v1 = sel.ver;
    sel.clear();
    ok("render.sel.ver-clear", sel.ver > v1);
    const v2 = sel.ver;
    sel.fillAll();
    ok("render.sel.ver-fill", sel.ver > v2);
    const v3 = sel.ver;
    sel.bump();
    ok("render.sel.ver-bump", sel.ver > v3);
  }

  // -------------------------------------------------------- onion ghosts
  {
    const shape = (g: ReturnType<typeof onionGhosts>): unknown => g.map((x) => [x.f, x.k, x.prev, x.wrapped]);
    // without wrapping only the plain neighbourhood is ghosted
    eq("onion.plain", shape(onionGhosts(1, 5, 1, 1, false)), [[0, 1, true, false], [2, 1, false, false]]);
    // on the first frame the "before" ghost comes from the end and is flagged
    eq("onion.wrap.start", shape(onionGhosts(0, 5, 1, 1, true)), [[1, 1, false, false], [4, 1, true, true]]);
    // on the last frame the "after" ghost comes from the start and is flagged
    eq("onion.wrap.end", shape(onionGhosts(4, 5, 1, 1, true)), [[0, 1, false, true], [3, 1, true, false]]);
    // far ghosts are listed first so the nearest one stays readable on top
    eq("onion.order", onionGhosts(2, 7, 2, 2, false).map((g) => g.k), [2, 2, 1, 1]);
    // a single frame has nothing to ghost, wrapping or not
    eq("onion.single", onionGhosts(0, 1, 3, 3, true), []);
    // wrapping never ghosts the current frame and collapses duplicates
    const tight = onionGhosts(0, 2, 3, 3, true);
    ok("onion.no-self", tight.every((g) => g.f !== 0), JSON.stringify(tight));
    eq("onion.dedupe", tight.map((g) => g.f), [1]);
    // without wrapping nothing is drawn past the ends
    eq("onion.plain.ends", onionGhosts(0, 3, 3, 3, false).map((g) => g.f), [2, 1]);
    eq("onion.plain.ends.last", onionGhosts(2, 3, 3, 3, false).map((g) => g.f), [0, 1]);
  }

  // bulk selection operations rewrite the mask array: they must bump the
  // version too, otherwise the cached tint image would go stale
  {
    const doc = new Doc(8, 8, "t");
    doc.sel = new Sel(8, 8);
    const s0 = doc.sel;
    selOps.selectAll(doc);
    const v0 = s0.ver;
    selOps.invert(doc);
    ok("render.selop.invert", s0.ver > v0, "v0=" + v0 + " now=" + s0.ver);
    const v1 = s0.ver;
    selOps.clear(doc);
    ok("render.selop.clear", s0.ver > v1);
    s0.set(2, 2, 1);
    const v2 = s0.ver;
    growSelection(doc, 1);
    ok("render.selop.grow", s0.ver > v2);
    const v3 = s0.ver;
    shrinkSelection(doc, 1);
    ok("render.selop.shrink", s0.ver > v3);
    // invert on an empty selection selects everything and bumps as well
    selOps.clear(doc);
    const v4 = s0.ver;
    selOps.invert(doc);
    ok("render.selop.invert-empty", s0.ver > v4 && s0.hasAny());
  }
}
