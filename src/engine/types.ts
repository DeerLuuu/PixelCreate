// Core pixel types shared across the engine

export type RGBA = [number, number, number, number];

export type BlendMode =
  | "normal" | "multiply" | "screen" | "overlay" | "darken" | "lighten"
  | "dodge" | "burn" | "hardlight" | "softlight" | "difference" | "exclusion";

export const BLEND_MODES: BlendMode[] = [
  "normal", "multiply", "screen", "overlay", "darken", "lighten",
  "dodge", "burn", "hardlight", "softlight", "difference", "exclusion",
];

export function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
