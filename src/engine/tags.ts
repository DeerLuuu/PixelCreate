// Frame tags (animation tags), like Aseprite's: a named range of frames.
//
// Pure helpers on plain arrays so both the document model, the structural ops
// and the file formats can share them. A tag is stored as a frame RANGE
// (`from`..`to`, 0-based inclusive), exactly like the .aseprite tag chunk, so
// importing/exporting never has to guess.
import type { FrameTag } from "./doc";

/** tag colours offered by the editor (Aseprite-ish, readable on both themes) */
export const TAG_COLORS = ["#f24a5e", "#e88b2c", "#f2d42c", "#5ad07a", "#3ad6e8", "#a85af0"];

/** the tag covering frame `fi` (null when the frame is untagged) */
export function tagAt(tags: FrameTag[], fi: number): FrameTag | null {
  for (const t of tags) if (fi >= t.from && fi <= t.to) return t;
  return null;
}

export function tagById(tags: FrameTag[], id: string): FrameTag | null {
  return tags.find((t) => t.id === id) ?? null;
}

/** first free "… 1 / … 2" name, so two tags never share a label */
export function nextTagName(tags: FrameTag[], base: string): string {
  const used = new Set(tags.map((t) => t.name));
  for (let i = 1; i < 1000; i++) {
    const name = base + " " + i;
    if (!used.has(name)) return name;
  }
  return base + " " + Date.now();
}

/** clamp a range to `count` frames; null when it holds no frame at all */
export function clampRange(from: number, to: number, count: number): { from: number; to: number } | null {
  if (count <= 0) return null;
  let a = Math.min(from, to);
  let b = Math.max(from, to);
  a = Math.max(0, Math.min(count - 1, Math.round(a)));
  b = Math.max(0, Math.min(count - 1, Math.round(b)));
  return a > b ? null : { from: a, to: b };
}

/**
 * Drop tags that no longer hold a frame, clamp the rest into range and keep
 * the list (and frame order) sorted. Call this after any structural edit.
 */
export function normalizeTags(tags: FrameTag[], count: number): FrameTag[] {
  const out: FrameTag[] = [];
  for (const t of tags) {
    const r = clampRange(t.from, t.to, count);
    if (!r) continue;
    out.push({ ...t, from: r.from, to: r.to });
  }
  return out.sort((a, b) => (a.from - b.from) || (a.to - b.to));
}

/**
 * A frame was inserted at index `at`: tags after it shift, a tag containing
 * the insertion point grows (the new frame joins that animation), tags that
 * end before it are untouched.
 */
export function tagsAfterInsert(tags: FrameTag[], at: number): void {
  for (const t of tags) {
    if (t.to >= at) t.to += 1;
    if (t.from >= at) t.from += 1;
  }
}

/** A frame was removed at index `fi`: tags shrink, a one-frame tag disappears. */
export function tagsAfterRemove(tags: FrameTag[], fi: number, count: number): FrameTag[] {
  const kept: FrameTag[] = [];
  for (const t of tags) {
    const from = t.from > fi ? t.from - 1 : t.from;
    const to = t.to >= fi ? t.to - 1 : t.to;
    if (from > to) continue;
    kept.push({ ...t, from, to });
  }
  return normalizeTags(kept, count);
}

/** human-readable range, e.g. "3–7" (1-based, like the timeline) */
export function tagRangeLabel(t: { from: number; to: number }): string {
  return t.from === t.to ? String(t.from + 1) : t.from + 1 + "–" + (t.to + 1);
}
