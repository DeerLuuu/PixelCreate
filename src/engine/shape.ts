// Axis-aligned ellipse rasterization ported 1:1 from Aseprite's doc/algo.cpp
// (algo_ellipse / algo_ellipsefill, based on Alois Zingl's work, MIT license).

/** Emit every pixel of a 1px ellipse outline fitting the inclusive rect. */
export function ellipseOutline(
  x0: number, y0: number, x1: number, y1: number,
  emit: (x: number, y: number) => void,
): void {
  if (x0 > x1) { const t = x0; x0 = x1; x1 = t; }
  if (y0 > y1) { const t = y0; y0 = y1; y1 = t; }
  const h = y1 - y0 + 1;
  let a = Math.abs(x1 - x0);
  let b = Math.abs(y1 - y0);
  let b1 = b & 1;
  let dx = 4 * (1 - a) * b * b;
  let dy = 4 * (b1 + 1) * a * a;
  let err = dx + dy + b1 * a * a;
  let e2: number;
  y0 += (b + 1) >> 1;
  y1 = y0 - b1;
  a = 8 * a * a;
  b1 = 8 * b * b;
  const initialY0 = y0;
  const initialY1 = y1;
  const initialX0 = x0;
  const initialX1 = x1;
  do {
    emit(x1, y0); emit(x0, y0);
    emit(x0, y1); emit(x1, y1);
    e2 = 2 * err;
    if (e2 <= dy) { y0++; y1--; err += dy += a; }
    if (e2 >= dx || 2 * err > dy) { x0++; x1--; err += dx += b1; }
  } while (x0 <= x1);
  while (y0 - y1 + 1 <= h) {
    emit(x0 - 1, y0); emit(x1 + 1, y0++);
    emit(x0 - 1, y1); emit(x1 + 1, y1--);
  }
}

/** Fill the ellipse inside the inclusive rect by emitting horizontal spans. */
export function ellipseFill(
  x0: number, y0: number, x1: number, y1: number,
  row: (x0: number, y: number, x1: number) => void,
): void {
  if (x0 > x1) { const t = x0; x0 = x1; x1 = t; }
  if (y0 > y1) { const t = y0; y0 = y1; y1 = t; }
  const h = y1 - y0 + 1;
  let a = Math.abs(x1 - x0);
  let b = Math.abs(y1 - y0);
  let b1 = b & 1;
  let dx = 4 * (1 - a) * b * b;
  let dy = 4 * (b1 + 1) * a * a;
  let err = dx + dy + b1 * a * a;
  let e2: number;
  y0 += (b + 1) >> 1;
  y1 = y0 - b1;
  a = 8 * a * a;
  b1 = 8 * b * b;
  const initialY0 = y0;
  const initialY1 = y1;
  const initialX0 = x0;
  const initialX1 = x1;
  do {
    row(x0, y0, x1); row(x0, y1, x1);
    e2 = 2 * err;
    if (e2 <= dy) { y0++; y1--; err += dy += a; }
    if (e2 >= dx || 2 * err > dy) { x0++; x1--; err += dx += b1; }
  } while (x0 <= x1);
  while (y0 - y1 + 1 <= h) {
    row(x0 - 1, y0, x0 - 1); row(x1 + 1, y0++, x1 + 1);
    row(x0 - 1, y1, x0 - 1); row(x1 + 1, y1--, x1 + 1);
  }
}