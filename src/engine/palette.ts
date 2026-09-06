import type { RGBA } from "./types";
import { hexToRgba } from "./color";

export const DEFAULT_PALETTE_HEX: string[] = [
  "#000000", "#1d2b53", "#7e2553", "#008751", "#ab5236", "#5f574f", "#c2c3c7", "#fff1e8",
  "#ff004d", "#ffa300", "#ffec27", "#00e436", "#29adff", "#83769c", "#ff77a8", "#ffccaa",
  "#ffffff", "#9badb7", "#6a5acd", "#ff6347", "#ffd700", "#00fa9a", "#40e0d0", "#ff69b4",
];

export function defaultPalette(): RGBA[] {
  return DEFAULT_PALETTE_HEX.map((h) => hexToRgba(h));
}
