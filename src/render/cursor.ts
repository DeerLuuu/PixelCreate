// Mouse cursor per tool (pure, unit tested).
//
// PC sessions get a cursor that says what the next click will do: a crosshair
// for anything that draws, an eyedropper for the picker, a hand while panning
// and a "no" sign on a locked layer. Touch ignores all of this.
export type CursorId = "draw" | "pick" | "grab" | "grabbing" | "lock" | "move";

/** tools that paint or drag out a shape — everything else keeps the default */
const DRAW_TOOLS = new Set([
  "pencil", "eraser", "airbrush", "bucket", "line", "rect", "ellipse", "circle",
  "polygon", "polyline", "curve", "outline", "select", "lasso", "wand",
]);

export function cursorFor(opts: {
  tool: string;
  locked: boolean;
  panning?: boolean;
  /** Alt is held: the next click samples the colour (eyedropper cursor) */
  altPick?: boolean;
  picking?: boolean;
}): CursorId {
  // panning wins over everything (it is an explicit temporary mode)
  if (opts.panning) return "grabbing";
  // Alt+click samples whatever is under the cursor, whatever the tool is
  if (opts.altPick) return "pick";
  if (opts.locked) return "lock";
  if (opts.picking || opts.tool === "picker") return "pick";
  return DRAW_TOOLS.has(opts.tool) ? "draw" : "move";
}

/** CSS rule data attribute value: <html> carries it on the canvas host */
export function cursorAttr(id: CursorId): string {
  return id;
}
