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

/**
 * Smooth a polyline with a Catmull-Rom spline (endpoints duplicated), then
 * sample it into a dense integer polyline ready for rasterization. Used by the
 * curve tool: the user taps a few points, the spline passes through all of them.
 */
export function splinePoints(pts: Array<[number, number]>, samples = 12): Array<[number, number]> {
  if (pts.length < 3) return pts.map((p) => [p[0], p[1]] as [number, number]);
  const P = (i: number): [number, number] => pts[Math.max(0, Math.min(pts.length - 1, i))];
  const out: Array<[number, number]> = [[pts[0][0], pts[0][1]]];
  const n = Math.max(4, Math.round(samples));
  for (let i = 0; i + 1 < pts.length; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    for (let s = 1; s <= n; s++) {
      const t = s / n, t2 = t * t, t3 = t2 * t;
      const x = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t +
        (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
        (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const y = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t +
        (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
        (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      const cx = Math.round(x), cy = Math.round(y);
      const last = out[out.length - 1];
      if (last[0] !== cx || last[1] !== cy) out.push([cx, cy]);
    }
  }
  return out;
}
