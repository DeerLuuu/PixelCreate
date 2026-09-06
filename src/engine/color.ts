import type { RGBA } from "./types";

export function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

export function rgba(r: number, g: number, b: number, a = 255): RGBA {
  return [clampByte(r), clampByte(g), clampByte(b), clampByte(a)];
}

export function cssColor(c: RGBA): string {
  return `rgba(${c[0]},${c[1]},${c[2]},${(c[3] / 255).toFixed(3)})`;
}

/**
 * Swatch background that HONESTLY shows alpha: colour painted over a checkerboard,
 * so a transparent slot reads as checker (never as black over dark chrome).
 */
export function chipCss(c: RGBA): string {
  const a = Math.max(0, Math.min(255, c[3] === undefined ? 255 : Math.round(c[3])));
  const al = (a / 255).toFixed(3);
  return "linear-gradient(rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + al + "), rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + al + ")), conic-gradient(#d6d6d6 25%, #ffffff 0 50%, #d6d6d6 0 75%, #ffffff 0) 0 0 / 8px 8px";
}

export function hexToRgba(hex: string): RGBA {
  let s = String(hex).replace("#", "").trim();
  if (s.length === 3) s = s.replace(/(.)/g, "$1$1");
  const n = parseInt(s, 16);
  if (Number.isNaN(n) || s.length < 6) return [0, 0, 0, 255];
  if (s.length >= 8) return [(n >> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}

export function rgbaToHex(c: RGBA): string {
  const h = (v: number) => ("0" + clampByte(v).toString(16)).slice(-2);
  return "#" + h(c[0]) + h(c[1]) + h(c[2]) + (c[3] < 255 ? h(c[3]) : "");
}

/** source-over blend a source color into dst (4-byte view) */
export function blendOver(dst: Uint8ClampedArray, i: number, src: RGBA): void {
  const a = src[3] / 255;
  const ia = 1 - a;
  dst[i] = src[0] * a + dst[i] * ia;
  dst[i + 1] = src[1] * a + dst[i + 1] * ia;
  dst[i + 2] = src[2] * a + dst[i + 2] * ia;
  dst[i + 3] = src[3] + dst[i + 3] * ia;
}

export function writePixel(data: Uint8ClampedArray, i: number, c: RGBA): void {
  data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = c[3];
}

