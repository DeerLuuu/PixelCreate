// Canvas hit testing in the multi-canvas space (src/app/canvas-space.ts).
//
// The palette fan's drag & drop and View.canvasAtScreen both rely on this: the
// view transform is anchored on the FOCUSED canvas, so a screen point has to be
// mapped into space coordinates before it can pick a canvas and a pixel.
import { canvasAtScreen, screenToCanvas, type SpaceCanvas } from "../src/app/canvas-space";
import { eq, ok } from "./common";

export function testCanvasSpace(): void {
  // two 64x64 canvases side by side with the 8px snap gap; #0 is focused
  const docs: SpaceCanvas[] = [
    { x: 0, y: 0, w: 64, h: 64 },
    { x: 72, y: 0, w: 64, h: 64 },
  ];
  // view: anchored on #0 at origin, zoom 2 -> #0 covers 0..128px, #1 144..272px
  const ox = 0, oy = 0, z = 2;
  eq("space.hit.first", canvasAtScreen(docs, 0, ox, oy, z, 10, 10), 0);
  eq("space.hit.second", canvasAtScreen(docs, 0, ox, oy, z, 150, 10), 1);
  eq("space.hit.gap", canvasAtScreen(docs, 0, ox, oy, z, 136, 10), -1);
  eq("space.hit.outside", canvasAtScreen(docs, 0, ox, oy, z, -20, 10), -1);

  const p = screenToCanvas(docs, 0, ox, oy, z, 150, 10);
  eq("space.pixel.second", p, { index: 1, x: 3, y: 5 });
  eq("space.pixel.first", screenToCanvas(docs, 0, ox, oy, z, 10, 10), { index: 0, x: 5, y: 5 });
  eq("space.pixel.miss", screenToCanvas(docs, 0, ox, oy, z, 136, 10), null);

  // panning the view shifts which pixel is under the same screen point
  eq("space.pan", screenToCanvas(docs, 0, -8, -8, z, 10, 10), { index: 0, x: 9, y: 9 });
  // zooming in: the same screen point now lands deeper inside the first canvas
  eq("space.zoom.first", screenToCanvas(docs, 0, ox, oy, 4, 150, 10), { index: 0, x: 37, y: 2 });
  // …and the second canvas starts at 72 * 4 = 288 screen px
  eq("space.zoom.second", screenToCanvas(docs, 0, ox, oy, 4, 300, 10), { index: 1, x: 3, y: 2 });

  // focusing the SECOND canvas re-anchors the view on it (its rect is 0,0..w,h)
  eq("space.focus.second.self", screenToCanvas(docs, 1, ox, oy, z, 10, 10), { index: 1, x: 5, y: 5 });
  eq("space.focus.second.other", screenToCanvas(docs, 1, ox, oy, z, -140, 10), { index: 0, x: 2, y: 5 });

  // overlapping canvases: the later one (drawn on top) wins
  const over: SpaceCanvas[] = [
    { x: 0, y: 0, w: 64, h: 64 },
    { x: 32, y: 0, w: 64, h: 64 },
  ];
  eq("space.overlap.top-wins", canvasAtScreen(over, 0, ox, oy, 1, 40, 10), 1);
  eq("space.overlap.left-part", canvasAtScreen(over, 0, ox, oy, 1, 10, 10), 0);

  // edge pixels belong to the canvas, the pixel after it does not
  eq("space.edge.last-pixel", screenToCanvas(docs, 0, ox, oy, 1, 63, 63), { index: 0, x: 63, y: 63 });
  eq("space.edge.one-past", screenToCanvas(docs, 0, ox, oy, 1, 64, 63), null);

  // degenerate input never throws
  eq("space.empty", screenToCanvas([], 0, 0, 0, 1, 10, 10), null);
  eq("space.bad-focus", screenToCanvas(docs, 9, 0, 0, 1, 10, 10), null);
  ok("space.bad-zoom", screenToCanvas(docs, 0, 0, 0, 0, 10, 10) === null);
}
