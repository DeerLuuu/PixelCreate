// Incremental-rendering tests: the pure rect helpers, the dirty region a live
// stroke reports, and the selection version the tint cache hangs on.
import { Doc, Sel } from "../src/engine/doc";
import { Stroke } from "../src/tools/stroke";
import type { BrushState, SymMode } from "../src/tools/registry";
import { clampRect, coversAll, screenRectOf, unionRect, tileRect, TILE_OFFSETS } from "../src/render/rect";
import { growSelection, selOps, shrinkSelection } from "../src/tools/select";
import { onionGhosts } from "../src/render/onion";
import { compositeIsStale } from "../src/render/view";
import { brushStamp } from "../src/engine/paint";
import { mirrorCells, mirrorMaskInPlace } from "../src/engine/symmetry";
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

  // ------------------------------------------- composite rebuild decision
  // regression: a full dirty (compRect === null, e.g. FX / selection edits)
  // must count as stale, otherwise the view blits the OLD composite and the
  // canvas looks frozen while the preview box is already correct
  ok("composite.stale.full-dirty", compositeIsStale(true, true, null));
  ok("composite.stale.no-composite", compositeIsStale(false, true, { x: 0, y: 0, w: 1, h: 1 }));
  ok("composite.stale.key-changed", compositeIsStale(true, false, { x: 0, y: 0, w: 1, h: 1 }));
  ok("composite.fresh.partial", !compositeIsStale(true, true, { x: 2, y: 3, w: 4, h: 5 }));

  // ------------------------------------------------- tiled preview rects
  eq("tile.offsets", TILE_OFFSETS.length, 9);
  // plain repeat: a rect at the right edge maps to the left edge of the right copy
  eq("tile.repeat.right", tileRect({ x: 14, y: 2, w: 2, h: 3 }, 16, 16, 1, 0, false), { x: 30, y: 2, w: 2, h: 3 });
  eq("tile.repeat.diag", tileRect({ x: 0, y: 0, w: 1, h: 1 }, 16, 16, -1, -1, false), { x: -16, y: -16, w: 1, h: 1 });
  // mirror: the same rect lands on the mirrored side of the neighbour
  eq("tile.mirror.right", tileRect({ x: 14, y: 2, w: 2, h: 3 }, 16, 16, 1, 0, true), { x: 16, y: 2, w: 2, h: 3 });
  eq("tile.mirror.left", tileRect({ x: 0, y: 2, w: 2, h: 3 }, 16, 16, -1, 0, true), { x: -2, y: 2, w: 2, h: 3 });
  eq("tile.mirror.diag", tileRect({ x: 1, y: 4, w: 2, h: 2 }, 16, 16, 1, 1, true), { x: 29, y: 26, w: 2, h: 2 });
  // mirror leaves the untouched axis alone
  eq("tile.mirror.axis-kept", tileRect({ x: 3, y: 1, w: 2, h: 2 }, 16, 16, 0, -1, true), { x: 3, y: -3, w: 2, h: 2 });

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

  // ------------------------------------------------- symmetry maths
  {
    const ax = { on: true, four: false, ox: 0, oy: 0, angDeg: 90 };
    // vertical axis through the centre of an 8-wide doc: x -> 7-x
    eq("sym.mirror.h", mirrorCells(1, 3, 8, 8, ax), [[1, 3], [6, 3]]);
    const ax0 = { on: true, four: false, ox: 0, oy: 0, angDeg: 0 };
    eq("sym.mirror.v", mirrorCells(3, 1, 8, 8, ax0), [[3, 1], [3, 6]]);
    eq("sym.mirror.off", mirrorCells(1, 3, 8, 8, { ...ax, on: false }), [[1, 3]]);
    const four = mirrorCells(1, 1, 8, 8, { on: true, four: true, ox: 0, oy: 0, angDeg: 90 });
    eq("sym.mirror.four", four.length, 4);
    ok("sym.mirror.four.set", new Set(four.map(([x, y]) => x + "," + y)).size === 4, JSON.stringify(four));

    // mask mirroring: one cell becomes its mirror partner
    const m = new Uint8Array(8 * 8);
    m[3 * 8 + 1] = 1;
    ok("sym.mask.changed", mirrorMaskInPlace(m, 8, 8, ax));
    eq("sym.mask.pair", [m[3 * 8 + 1], m[3 * 8 + 6]], [1, 1]);
    // idempotent: mirroring again adds nothing
    ok("sym.mask.idempotent", !mirrorMaskInPlace(m, 8, 8, ax));
    // off = untouched
    const m2 = new Uint8Array(4);
    m2[0] = 1;
    ok("sym.mask.off", !mirrorMaskInPlace(m2, 2, 2, { ...ax, on: false }) && m2[1] === 0);
  }

  // ------------------------------------------------- brush tip shapes
  {
    const round = brushStamp(5, "circle");
    const square = brushStamp(5, "square");
    eq("brush.square.cells", square.cells.length, 25);
    ok("brush.round.less", round.cells.length < 25, "round=" + round.cells.length);
    eq("brush.square.outline", square.outline.length, 16);
    eq("brush.square.cache", brushStamp(5, "square"), square);
    ok("brush.shapes.differ", JSON.stringify(round.cells) !== JSON.stringify(square.cells));
    const one = brushStamp(1, "square");
    eq("brush.square.one", one.cells, [[0, 0]]);
  }

  // ------------------------------------------------- shapes from the centre
  {
    const doc = new Doc(32, 32, "t");
    const st = new Stroke(doc, 0, 0, "rect", brush(1), false, "off", 6, true, 0, 0, 90, false, false, "circle", true);
    st.startAt(16, 16);
    st.moveTo(20, 18, 1); // radius 4 x 2 -> box 12..20 x 14..18
    const cel = doc.celAt(0, 0)!;
    ok("shape.center.sym-x", cel.data[cel.idx(12, 16) + 3] > 0 && cel.data[cel.idx(20, 16) + 3] > 0);
    ok("shape.center.sym-y", cel.data[cel.idx(16, 14) + 3] > 0 && cel.data[cel.idx(16, 18) + 3] > 0);
    ok("shape.center.outside", cel.data[cel.idx(11, 16) + 3] === 0 && cel.data[cel.idx(16, 13) + 3] === 0);
    // the same drag from a corner stays a corner box
    const doc2 = new Doc(32, 32, "t");
    const st2 = new Stroke(doc2, 0, 0, "rect", brush(1), false, "off", 6, true, 0, 0, 90, false, false, "circle", false);
    st2.startAt(16, 16);
    st2.moveTo(20, 18, 1);
    const c2 = doc2.celAt(0, 0)!;
    ok("shape.corner.keeps", c2.data[c2.idx(16, 16) + 3] > 0 && c2.data[c2.idx(12, 12) + 3] === 0);
  }

  // ------------------------------------------------- square brush tip
  {
    const doc = new Doc(16, 16, "t");
    const st = new Stroke(doc, 0, 0, "pencil", brush(3), false, "off", 6, true, 0, 0, 90, false, false, "square", false);
    st.startAt(8, 8);
    const cel = doc.celAt(0, 0)!;
    let n = 0;
    for (let i = 3; i < cel.data.length; i += 4) if (cel.data[i] > 0) n++;
    eq("brush.square.paints", n, 9);
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
