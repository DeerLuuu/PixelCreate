// HSL adjustment (mirrors Aseprite's Hue/Saturation/Lightness dialog, standard
// RGB<->HSL conversion; hue/sat applied before lightness). Pure functions.

export interface HslAdj {
  /** hue rotation in degrees (-180..180) */
  hue: number;
  /** saturation multiplier (0..2, 1 = unchanged) */
  satMul: number;
  /** lightness add (-1..1 of full scale) */
  lightAdd: number;
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return [h, s, l];
}

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hn = ((h % 360) + 360) % 360 / 360;
  return [
    Math.round(hue2rgb(p, q, hn + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, hn) * 255),
    Math.round(hue2rgb(p, q, hn - 1 / 3) * 255),
  ];
}

export function adjustPixel(r: number, g: number, b: number, a: number, adj: HslAdj): [number, number, number] {
  if (a === 0) return [r, g, b];
  const [h0, s0, l0] = rgbToHsl(r, g, b);
  let h = h0 + adj.hue;
  let s = s0 * Math.max(0, adj.satMul);
  let l = l0 + Math.max(-1, Math.min(1, adj.lightAdd));
  s = Math.max(0, Math.min(1, s));
  l = Math.max(0, Math.min(1, l));
  return hslToRgb(h, s, l);
}