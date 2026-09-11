// Encode / decode a history dump for project files (base64 for every buffer).
import type { DocSnapshot } from "../engine/doc";
import { Cel } from "../engine/cel";
import { Sel } from "../engine/doc";
import type { RGBA } from "../engine/types";
import { b64ToBytes, bytesToB64 } from "../engine/b64";
import type { HistoryDump, HistoryDumpEntry } from "../engine/history";
import { isScalarData } from "../app/history-io";

const encBytes = (b: Uint8ClampedArray | null): string | null => (b ? bytesToB64(b) : null);
const decBytes = (s: unknown): Uint8ClampedArray | null =>
  typeof s === "string" ? new Uint8ClampedArray(b64ToBytes(s)) : null;

function encSnapshot(s: DocSnapshot): unknown {
  return {
    w: s.w, h: s.h, name: s.name,
    layers: s.layers,
    frames: s.frames,
    tags: s.tags,
    cels: [...s.cels].map(([k, cel]) => [k, bytesToB64(cel.data)]),
    bg: s.bg,
    palette: s.palette,
    sel: s.sel ? bytesToB64(s.sel.mask) : null,
  };
}

function decSnapshot(v: unknown, w: number, h: number): DocSnapshot | null {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return null;
  // a snapshot knows its own size: history is shared by canvases of any size
  w = Math.max(1, Math.min(1024, Number(o.w) || w));
  h = Math.max(1, Math.min(1024, Number(o.h) || h));
  const cels = new Map<string, Cel>();
  for (const pair of (o.cels as unknown[]) ?? []) {
    const [k, data] = pair as [string, string];
    const bytes = b64ToBytes(String(data));
    const cel = new Cel(w, h);
    const n = Math.min(cel.data.length, bytes.length);
    for (let i = 0; i < n; i++) cel.data[i] = bytes[i];
    cels.set(String(k), cel);
  }
  let sel: Sel | null = null;
  if (typeof o.sel === "string") {
    sel = new Sel(w, h);
    const m = b64ToBytes(o.sel);
    const n = Math.min(sel.mask.length, m.length);
    for (let i = 0; i < n; i++) sel.mask[i] = m[i] ? 1 : 0;
  }
  return {
    w, h,
    name: String(o.name ?? "untitled"),
    layers: (o.layers as DocSnapshot["layers"]) ?? [],
    frames: (o.frames as DocSnapshot["frames"]) ?? [],
    tags: (o.tags as DocSnapshot["tags"]) ?? [],
    cels,
    bg: (o.bg as RGBA | null) ?? null,
    palette: ((o.palette as number[][]) ?? []).map((c) => [c[0], c[1], c[2], c[3]] as RGBA),
    sel,
  };
}

/** JSON-safe history payload (or null when there is nothing worth storing) */
export function encodeHistory(dump: HistoryDump): unknown | null {
  if (!dump.entries.length) return null;
  const entries = dump.entries.map((e) => {
    if (e.kind === "pixels") {
      return {
        label: e.label, kind: e.kind, docId: e.docId,
        enc: (e.enc ?? []).map((c) => ({
          li: c.li, fi: c.fi, born: c.born, remove: c.remove,
          idx: c.idx, pre: encBytes(c.pre), post: encBytes(c.post),
          fullB: encBytes(c.fullB), fullA: encBytes(c.fullA),
        })),
      };
    }
    if (e.kind === "struct") {
      return { label: e.label, kind: e.kind, docId: e.docId, before: encSnapshot(e.before!), after: encSnapshot(e.after!) };
    }
    return { label: e.label, kind: e.kind, docId: e.docId, data: e.data };
  });
  return { v: 1, index: dump.index, entries };
}

/** rebuild a dump read from a project file (null when malformed) */
export function decodeHistory(raw: unknown): HistoryDump | null {
  const o = raw as { w?: number; h?: number; index?: number; entries?: unknown[] } | null;
  if (!o || !Array.isArray(o.entries)) return null;
  // v1 payloads had one size for the whole stack; each snapshot now carries its
  // own, and every entry names the canvas it belongs to
  const w = Math.max(1, Math.min(1024, Number(o.w) || 1));
  const h = Math.max(1, Math.min(1024, Number(o.h) || 1));
  const entries: HistoryDumpEntry[] = [];
  for (const raw2 of o.entries) {
    const e = raw2 as Record<string, unknown>;
    const label = String(e.label ?? "step");
    const docId = typeof e.docId === "string" ? e.docId : undefined;
    if (e.kind === "pixels" && Array.isArray(e.enc)) {
      const enc = (e.enc as Record<string, unknown>[]).map((c) => ({
        li: Number(c.li) || 0,
        fi: Number(c.fi) || 0,
        born: !!c.born,
        remove: !!c.remove,
        idx: Array.isArray(c.idx) ? (c.idx as number[]) : null,
        pre: decBytes(c.pre),
        post: decBytes(c.post),
        fullB: decBytes(c.fullB),
        fullA: decBytes(c.fullA),
      }));
      entries.push({ label, kind: "pixels", enc, docId });
    } else if (e.kind === "struct") {
      const before = decSnapshot(e.before, w, h);
      const after = decSnapshot(e.after, w, h);
      if (before && after) entries.push({ label, kind: "struct", before, after, docId });
    } else if (e.kind === "scalar" && isScalarData(e.data)) {
      entries.push({ label, kind: "scalar", data: e.data, docId });
    }
  }
  if (!entries.length) return null;
  return { index: Math.max(0, Math.min(entries.length, Number(o.index) || 0)), entries };
}
