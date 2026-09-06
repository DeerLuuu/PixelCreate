/* Engine unit-ish assertions (pure logic, no DOM). */
const assert = require("assert");
const path = require("path");
const BASE = __dirname + "/engtest/engine";
const { Doc } = require(path.join(BASE, "doc.js"));
const { History } = require(path.join(BASE, "history.js"));
const { Cel } = require(path.join(BASE, "cel.js"));
const { Stroke } = require(path.join(__dirname, "engtest/tools/stroke.js"));
const { selOps } = require(path.join(__dirname, "engtest/tools/select.js"));
const ops = require(path.join(BASE, "ops.js"));
const { defaultPalette } = require(path.join(BASE, "palette.js"));

function countPx(cel) {
  let n = 0;
  if (!cel) return 0;
  for (let i = 3; i < cel.data.length; i += 4) if (cel.data[i] > 0) n++;
  return n;
}

let passed = 0;
function ok(name, cond) {
  if (!cond) throw new Error("FAIL: " + name);
  passed++;
  console.log("ok -", name);
}

// 1. stroke & history
{
  const doc = new Doc(32, 32, "t");
  doc.palette = defaultPalette();
  const h = new History();
  const brush = { color: [200, 30, 40, 255], size: 2, alpha: 100, pressure: 1 };
  const st = new Stroke(doc, 0, 0, "pencil", brush, false);
  st.startAt(4, 4);
  st.moveTo(9, 4, 1);
  st.commit(h, "tools.pencil");
  const cel0 = doc.celAt(0, 0);
  ok("pencil painted pixels", countPx(cel0) >= 6);
  ok("undo available", h.canUndo());
  h.undo();
  ok("undo clears pixels", doc.celAt(0, 0) === null || countPx(doc.celAt(0, 0)) === 0);
  h.redo();
  ok("redo repaints", countPx(doc.celAt(0, 0)) >= 6);
}

// 2. rectfill + erase + bucket
{
  const doc = new Doc(16, 16, "t2");
  const h = new History();
  const brush = { color: [10, 20, 30, 255], size: 1, alpha: 100, pressure: 1 };
  let s = new Stroke(doc, 0, 0, "rectfill", brush, false);
  s.startAt(2, 2);
  s.moveTo(5, 5, 1);
  s.commit(h, "r");
  ok("rectfill fills 16 px", countPx(doc.celAt(0, 0)) === 16);
  s = new Stroke(doc, 0, 0, "eraser", brush, false);
  s.startAt(2, 2);
  s.commit(h, "e");
  ok("eraser removes one px", countPx(doc.celAt(0, 0)) === 15);
  // bucket over empty region with mask off fills huge area (flood) -> fills to edges
  s = new Stroke(doc, 0, 0, "bucket", { ...brush, color: [1, 2, 3, 255] }, false);
  s.startAt(15, 15);
  s.commit(h, "b");
  ok("bucket fills remaining region", countPx(doc.celAt(0, 0)) === 16 * 16 - 15 + 15);
}

// 3. layers ops integrity
{
  const doc = new Doc(8, 8, "t3");
  const h = new History();
  ops.addLayer(doc, 1);
  ops.addLayer(doc, 1);
  ok("layers added", doc.layers.length === 3);
  // draw on middle layer frame0
  const cel = doc.ensureCel(1, 0);
  cel.setPixel(0, 0, [9, 9, 9, 255]);
  ops.duplicateLayer(doc, 1);
  ok("dupe keeps pixel on copy", countPx(doc.celAt(2, 0)) === 1 && countPx(doc.celAt(1, 0)) === 1);
  ops.moveLayer(doc, 2, 0);
  ok("move layer keeps cel", countPx(doc.celAt(0, 0)) === 1);
  ops.removeLayer(doc, 0);
  ok("remove reindexes", doc.layers.length === 2 && countPx(doc.celAt(0, 0)) === 1);
  // struct history undo restores removal
  h.pushStruct("rm", doc, () => ops.removeLayer(doc, 0));
  ok("struct removal applied", doc.layers.length === 1);
  h.undo();
  ok("struct undo restores", doc.layers.length === 2 && countPx(doc.celAt(0, 0)) === 1);
}

// 4. frame ops
{
  const doc = new Doc(8, 8, "t4");
  const h = new History();
  doc.ensureCel(0, 0).setPixel(0, 0, [5, 5, 5, 255]);
  ops.addFrame(doc, 1);
  ops.duplicateFrame(doc, 0);
  ok("dup frame copies cel", countPx(doc.celAt(0, 1)) === 1 && doc.frames.length === 3);
  ops.removeFrame(doc, 1);
  ok("remove frame reindexes", doc.frames.length === 2 && countPx(doc.celAt(0, 1)) === 1);
  ops.moveFrame(doc, 0, 1);
  ok("frame order swapped", doc.frames.length === 2);
  h.pushStruct("fdur", doc, () => ops.removeFrame(doc, 0));
  h.undo();
  ok("frame struct undo", doc.frames.length === 2);
}

// 5. selection ops
{
  const doc = new Doc(10, 10, "t5");
  const h = new History();
  const li = 0, fi = 0;
  // draw 3x3 block at 1,1
  const cel = doc.ensureCel(li, fi);
  for (let y = 1; y < 4; y++) for (let x = 1; x < 4; x++) cel.setPixel(x, y, [100, 0, 0, 255]);
  selOps.setRect(doc, 1, 1, 3, 3);
  const grab = selOps.grab(doc, li, fi);
  ok("grab returns 3x3", !!grab && grab.w === 3 && grab.h === 3);
  // move by +3,+2
  const before = new Uint8ClampedArray(cel.data);
  selOps.move(doc, li, fi, 3, 2, before, { x: 1, y: 1, w: 3, h: 3 });
  const moved = selOps.grab(doc, li, fi);
  ok("sel moved with content", !!moved && moved.x === undefined && countPx(cel) === 9);
  ok("old area cleared", cel.data[cel.idx(1, 1) + 3] === 0);
  ok("new area painted", cel.data[cel.idx(4, 3) + 3] > 0);
  // copy/cut/paste
  selOps.setRect(doc, 4, 3, 6, 5);
  const clip = selOps.copy(doc, li, fi);
  ok("copy works", !!clip && countPx(clip) === 9);
  // flip selection
  selOps.flip(doc, h, li, fi, true);
  ok("flip ran without error", h.canUndo());
  selOps.paste(doc, h, li, fi, clip, { x: 0, y: 0 });
  ok("paste adds pixels", countPx(cel) >= 9);
  h.undo();
  ok("paste undo works", h.canUndo());
}

console.log("\nALL ENGINE TESTS PASSED (" + passed + ")");
