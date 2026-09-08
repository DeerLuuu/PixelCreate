// Placement maths for the onboarding spotlight bubble (pure + unit-tested).
export interface GuideRect { x: number; y: number; w: number; h: number }
export type GuidePlace = "top" | "bottom" | "left" | "right";

/** keep the card this far from the viewport edge */
export const GUIDE_MARGIN = 12;
/** gap between the highlighted control and the card */
export const GUIDE_GAP = 14;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(Math.max(lo, hi), v));
}

/** preferred side, or the one with the most room when unset/auto */
export function pickPlace(pref: GuidePlace | "auto" | undefined, r: GuideRect, vw: number, vh: number): GuidePlace {
  if (pref && pref !== "auto") return pref;
  const space: Record<GuidePlace, number> = {
    top: r.y,
    bottom: vh - (r.y + r.h),
    left: r.x,
    right: vw - (r.x + r.w),
  };
  return (Object.keys(space) as GuidePlace[]).reduce((a, b) => (space[b] > space[a] ? b : a), "bottom");
}

/**
 * Position a bubble of size bw×bh next to the highlighted rect. The preferred
 * side is flipped when it has no room, then the result is clamped on BOTH axes
 * so the card can never leave the viewport — even for a very tall bubble or a
 * target hugging an edge.
 */
export function guideBubblePos(
  rect: GuideRect | null,
  bw: number,
  bh: number,
  vw: number,
  vh: number,
  pref?: GuidePlace | "auto",
): { left: number; top: number } {
  if (!rect) {
    return {
      left: clamp((vw - bw) / 2, GUIDE_MARGIN, vw - bw - GUIDE_MARGIN),
      top: clamp(vh * 0.3, GUIDE_MARGIN, vh - bh - GUIDE_MARGIN),
    };
  }
  const place = pickPlace(pref, rect, vw, vh);
  const midX = rect.x + rect.w / 2;
  const midY = rect.y + rect.h / 2;
  let left: number, top: number;
  if (place === "bottom") { left = midX - bw / 2; top = rect.y + rect.h + GUIDE_GAP; }
  else if (place === "top") { left = midX - bw / 2; top = rect.y - GUIDE_GAP - bh; }
  else if (place === "left") { left = rect.x - GUIDE_GAP - bw; top = midY - bh / 2; }
  else { left = rect.x + rect.w + GUIDE_GAP; top = midY - bh / 2; }

  if (place === "bottom" && top + bh > vh - GUIDE_MARGIN) top = rect.y - GUIDE_GAP - bh;
  else if (place === "top" && top < GUIDE_MARGIN) top = rect.y + rect.h + GUIDE_GAP;
  else if (place === "left" && left < GUIDE_MARGIN) left = rect.x + rect.w + GUIDE_GAP;
  else if (place === "right" && left + bw > vw - GUIDE_MARGIN) left = rect.x - GUIDE_GAP - bw;

  return {
    left: clamp(left, GUIDE_MARGIN, vw - bw - GUIDE_MARGIN),
    top: clamp(top, GUIDE_MARGIN, vh - bh - GUIDE_MARGIN),
  };
}

/** when the highlighted element is huge (the whole canvas, a panel) a card can
 *  never sit outside it, so the hole is shrunk around its centre — the card
 *  then sits outside the (smaller) highlighted area and nothing being taught
 *  is hidden. Elements smaller than ~45% of the viewport are left untouched. */
export const HOLE_SHRINK_RATIO = 0.45;

export function shrinkHole(r: GuideRect, vw: number, vh: number, maxRatio = HOLE_SHRINK_RATIO): GuideRect {
  const area = r.w * r.h;
  const max = vw * vh * maxRatio;
  if (area <= max || r.w <= 0 || r.h <= 0) return r;
  const k = Math.sqrt(max / area);
  const w = Math.max(48, Math.round(r.w * k));
  const h = Math.max(48, Math.round(r.h * k));
  return { x: Math.round(r.x + (r.w - w) / 2), y: Math.round(r.y + (r.h - h) / 2), w, h };
}

const OPPOSITE: Record<GuidePlace, GuidePlace> = { top: "bottom", bottom: "top", left: "right", right: "left" };
const ALL_PLACES: GuidePlace[] = ["top", "bottom", "left", "right"];

function rawPlace(rect: GuideRect, place: GuidePlace, bw: number, bh: number): { left: number; top: number } {
  const midX = rect.x + rect.w / 2;
  const midY = rect.y + rect.h / 2;
  if (place === "bottom") return { left: midX - bw / 2, top: rect.y + rect.h + GUIDE_GAP };
  if (place === "top") return { left: midX - bw / 2, top: rect.y - GUIDE_GAP - bh };
  if (place === "left") return { left: rect.x - GUIDE_GAP - bw, top: midY - bh / 2 };
  return { left: rect.x + rect.w + GUIDE_GAP, top: midY - bh / 2 };
}

function overlapArea(p: { left: number; top: number }, bw: number, bh: number, r: GuideRect, pad: number): number {
  const w = Math.min(p.left + bw, r.x + r.w + pad) - Math.max(p.left, r.x - pad);
  const h = Math.min(p.top + bh, r.y + r.h + pad) - Math.max(p.top, r.y - pad);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Like guideBubblePos, but it also refuses to cover the highlighted area: it
 * tries the preferred side, the opposite one, then the remaining two, and only
 * falls back to the least-overlapping position when nothing else fits.
 */
export function guideBubblePosAvoiding(
  rect: GuideRect | null,
  bw: number,
  bh: number,
  vw: number,
  vh: number,
  pref?: GuidePlace | "auto",
): { left: number; top: number; overlaps: boolean } {
  if (!rect) return { ...guideBubblePos(null, bw, bh, vw, vh, pref), overlaps: false };
  const first = pickPlace(pref, rect, vw, vh);
  const order: GuidePlace[] = [first, OPPOSITE[first], ...ALL_PLACES.filter((p) => p !== first && p !== OPPOSITE[first])];
  let best: { left: number; top: number } | null = null;
  let bestOverlap = Infinity;
  for (const place of order) {
    const raw = rawPlace(rect, place, bw, bh);
    const pos = {
      left: clamp(raw.left, GUIDE_MARGIN, vw - bw - GUIDE_MARGIN),
      top: clamp(raw.top, GUIDE_MARGIN, vh - bh - GUIDE_MARGIN),
    };
    const ov = overlapArea(pos, bw, bh, rect, 6);
    if (ov === 0) return { ...pos, overlaps: false };
    if (ov < bestOverlap) { bestOverlap = ov; best = pos; }
  }
  return { ...(best ?? { left: GUIDE_MARGIN, top: GUIDE_MARGIN }), overlaps: bestOverlap > 0 };
}
