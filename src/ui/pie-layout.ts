// Radial quick menu ("pie") geometry — pure, unit tested.
//
// PC only: hold F with an equipped ball and the ball's entries are laid out in a
// ring around the middle of the screen with the cursor hidden. The item whose
// direction the pointer points at gets focused; releasing the key activates it
// (Blender's quick-pie behaviour). Everything spatial lives here so the React
// side only has to render what these functions return.

export interface PiePoint {
  x: number;
  y: number;
}

/** how much of the radius is a dead zone (no item focused while inside) */
export const PIE_DEAD = 0.34;

/** diameter of one pie entry (`.pie-item` in style.css) */
export const PIE_ITEM = 58;

/** ring radius for a viewport: big enough for 24 items, never off-screen */
export function pieRadius(vw: number, vh: number): number {
  return Math.max(150, Math.min(380, Math.round(Math.min(vw, vh) * 0.36)));
}

/**
 * Evenly spaced slots, the first one straight up and going clockwise.
 * (@param idx 0..count-1)
 */
export function pieSlot(index: number, count: number, cx: number, cy: number, radius: number): PiePoint {
  const n = Math.max(1, count);
  const a = -Math.PI / 2 + (index % n) * ((Math.PI * 2) / n);
  return { x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius };
}

/** all slots of a pie */
export function pieSlots(count: number, cx: number, cy: number, radius: number): PiePoint[] {
  const out: PiePoint[] = [];
  for (let i = 0; i < Math.max(0, count); i++) out.push(pieSlot(i, count, cx, cy, radius));
  return out;
}

/**
 * Which slot the pointer points at, or -1 inside the dead zone.
 * The mapping is purely angular (like Blender): the pointer only has to point in
 * the item's direction, its distance beyond the dead zone does not matter.
 */
export function pieFocusIndex(px: number, py: number, cx: number, cy: number, count: number, radius: number): number {
  if (count <= 0) return -1;
  const dx = px - cx, dy = py - cy;
  const d = Math.hypot(dx, dy);
  if (d < radius * PIE_DEAD) return -1;
  // angle measured from "up", clockwise, normalised to 0..1
  let t = (Math.atan2(dy, dx) + Math.PI / 2) / (Math.PI * 2);
  t = ((t % 1) + 1) % 1;
  return Math.round(t * count) % count;
}

/**
 * Ring radius that both fits the screen and keeps `count` items of `item` px
 * apart, so a 24-entry tool pie never overlaps on a small window.
 */
export function pieRadiusFor(vw: number, vh: number, count: number, item = PIE_ITEM): number {
  const base = pieRadius(vw, vh);
  if (count <= 2) return base;
  const need = (item + 6) / (2 * Math.sin(Math.PI / count));
  const max = Math.min(vw, vh) / 2 - item / 2 - 12;   // must stay on screen
  return Math.round(Math.max(base, Math.min(need, Math.max(base, max))));
}

/** smallest gap between two neighbouring slots (used to keep items apart) */
export function pieSlotGap(count: number, radius: number): number {
  if (count <= 1) return Infinity;
  return 2 * radius * Math.sin(Math.PI / count);
}
