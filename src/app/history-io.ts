// Scalar history steps: the cheap operations (visibility, opacity, rename, …)
// are stored as small JSON payloads instead of closures, so a saved project can
// rebuild them after a reload.
import type { Doc } from "../engine/doc";
import type { BlendMode, RGBA } from "../engine/types";

export type ScalarData =
  | { k: "layer-visible"; li: number; on: boolean; prev: boolean }
  | { k: "layer-lock"; li: number; on: boolean; prev: boolean }
  | { k: "layer-rename"; li: number; name: string; prev: string }
  | { k: "layer-opacity"; li: number; v: number; prev: number }
  | { k: "layer-blend"; li: number; b: BlendMode; prev: BlendMode }
  | { k: "frame-duration"; fi: number; ms: number; prev: number }
  | { k: "frames-duration"; list: number[]; v: number; olds: number[] }
  | { k: "frame-switch"; fi: number; prev: number }
  | { k: "palette-add"; idx: number; color: RGBA }
  | { k: "palette-remove"; idx: number; color: RGBA };

export interface ScalarCtx {
  doc: Doc;
  /** switch the visible frame without recording a history step */
  showFrame: (fi: number) => void;
}

/** rebuild the apply/unapply pair of a scalar step from its payload */
export function scalarActions(d: ScalarData, ctx: ScalarCtx): { apply: () => void; unapply: () => void } {
  const { doc } = ctx;
  const L = (li: number): Doc["layers"][number] | undefined => doc.layers[li];
  const F = (fi: number): Doc["frames"][number] | undefined => doc.frames[fi];
  switch (d.k) {
    case "layer-visible":
      return {
        apply: () => { const l = L(d.li); if (l) l.visible = d.on; },
        unapply: () => { const l = L(d.li); if (l) l.visible = d.prev; },
      };
    case "layer-lock":
      return {
        apply: () => { const l = L(d.li); if (l) l.locked = d.on; },
        unapply: () => { const l = L(d.li); if (l) l.locked = d.prev; },
      };
    case "layer-rename":
      return {
        apply: () => { const l = L(d.li); if (l) l.name = d.name; },
        unapply: () => { const l = L(d.li); if (l) l.name = d.prev; },
      };
    case "layer-opacity":
      return {
        apply: () => { const l = L(d.li); if (l) l.opacity = d.v; },
        unapply: () => { const l = L(d.li); if (l) l.opacity = d.prev; },
      };
    case "layer-blend":
      return {
        apply: () => { const l = L(d.li); if (l) l.blend = d.b; },
        unapply: () => { const l = L(d.li); if (l) l.blend = d.prev; },
      };
    case "frame-duration":
      return {
        apply: () => { const f = F(d.fi); if (f) f.durationMs = d.ms; },
        unapply: () => { const f = F(d.fi); if (f) f.durationMs = d.prev; },
      };
    case "frames-duration":
      return {
        apply: () => { for (const fi of d.list) { const f = F(fi); if (f) f.durationMs = d.v; } },
        unapply: () => { d.list.forEach((fi, i) => { const f = F(fi); if (f) f.durationMs = d.olds[i] ?? 100; }); },
      };
    case "frame-switch":
      return {
        apply: () => ctx.showFrame(d.fi),
        unapply: () => ctx.showFrame(d.prev),
      };
    case "palette-add":
      return {
        apply: () => { if (doc.palette.length <= d.idx) doc.palette.push([...d.color] as RGBA); },
        unapply: () => { if (doc.palette[d.idx]) doc.palette.splice(d.idx, 1); },
      };
    case "palette-remove":
      return {
        apply: () => { if (doc.palette.length > d.idx) doc.palette.splice(d.idx, 1); },
        unapply: () => { doc.palette.splice(Math.min(d.idx, doc.palette.length), 0, [...d.color] as RGBA); },
      };
  }
}

const KINDS = [
  "layer-visible", "layer-lock", "layer-rename", "layer-opacity", "layer-blend",
  "frame-duration", "frames-duration", "frame-switch", "palette-add", "palette-remove",
];

/** validate a payload read from a project file */
export function isScalarData(v: unknown): v is ScalarData {
  if (!v || typeof v !== "object") return false;
  const k = (v as { k?: unknown }).k;
  return typeof k === "string" && KINDS.includes(k);
}
