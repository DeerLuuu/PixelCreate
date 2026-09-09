import { Doc, type DocSnapshot } from "./doc";
import { Cel } from "./cel";
import type { ScalarData } from "../app/history-io";

export interface PixelChange {
  li: number;
  fi: number;
  before: Uint8ClampedArray | null; // null = cel did not exist before the edit
  after: Uint8ClampedArray | null;  // null = cel removed by the edit
}

interface Entry {
  label: string;
  fwd: () => void;
  back: () => void;
  /** raw material kept for project-file serialization */
  enc?: EncChange[];
  snap?: { before: DocSnapshot; after: DocSnapshot };
  data?: ScalarData;
  /** the document this step edited (history is shared by every canvas) */
  doc?: Doc;
}

/** one serializable history step (raw typed arrays / snapshots, not base64) */
export interface HistoryDumpEntry {
  label: string;
  kind: "pixels" | "struct" | "scalar";
  enc?: EncChange[];
  before?: DocSnapshot;
  after?: DocSnapshot;
  data?: ScalarData;
  /** id of the canvas this step belongs to (history is project-wide) */
  docId?: string;
}

export interface HistoryDump {
  /** how many entries of `entries` are currently applied */
  index: number;
  entries: HistoryDumpEntry[];
}

/** host hooks needed to rebuild steps after a reload */
export interface HistoryHost {
  /** fallback document (the focused canvas) */
  doc: Doc;
  /** resolve a stored canvas id back to its document (shared history) */
  docFor?: (docId: string | undefined) => Doc | null;
  scalarActions: (data: ScalarData, doc?: Doc) => { apply: () => void; unapply: () => void };
}

/** Compact per-cel pixel change. idx is a list of PIXEL indices (not byte
 * offsets); pre/post hold 4 bytes per changed pixel and may be null when those
 * pixels are simply zeroed (all transparent). fullB/fullA are whole-cel
 * buffers used as a fallback when most of the cel changed at once. */
interface EncChange {
  li: number;
  fi: number;
  born: boolean;   // cel did not exist before (undo removes it)
  remove: boolean; // cel is removed by the edit (redo deletes it)
  idx: number[] | null;
  pre: Uint8ClampedArray | null;
  post: Uint8ClampedArray | null;
  fullB: Uint8ClampedArray | null; // undo restores this whole buffer
  fullA: Uint8ClampedArray | null; // redo writes this whole buffer
}

function ensureCel(doc: Doc, li: number, fi: number): Cel {
  const k = doc.key(li, fi);
  let cel = doc.cels.get(k);
  if (!cel) {
    cel = new Cel(doc.w, doc.h);
    doc.cels.set(k, cel);
  }
  return cel;
}

function writeSparse(cel: Cel, idx: number[] | null, vals: Uint8ClampedArray | null): void {
  if (!idx) return;
  const d = cel.data;
  if (vals) {
    for (let n = 0; n < idx.length; n++) {
      const p = idx[n] * 4, q = n * 4;
      d[p] = vals[q]; d[p + 1] = vals[q + 1]; d[p + 2] = vals[q + 2]; d[p + 3] = vals[q + 3];
    }
  } else {
    for (let n = 0; n < idx.length; n++) {
      const p = idx[n] * 4;
      d[p] = 0; d[p + 1] = 0; d[p + 2] = 0; d[p + 3] = 0;
    }
  }
}

function applyFwd(doc: Doc, e: EncChange): void {
  doc.pixelRev++; // the view keys its other-canvas cache on this
  if (e.remove) { doc.cels.delete(doc.key(e.li, e.fi)); return; }
  const cel = ensureCel(doc, e.li, e.fi);
  if (e.fullA) cel.data.set(e.fullA);
  else writeSparse(cel, e.idx, e.post);
}
function applyBack(doc: Doc, e: EncChange): void {
  doc.pixelRev++; // the view keys its other-canvas cache on this
  const k = doc.key(e.li, e.fi);
  if (e.born) { doc.cels.delete(k); return; }
  if (e.remove) { // edit removed the cel -> undo brings it back (whole buffer)
    if (e.fullB) { const cel = ensureCel(doc, e.li, e.fi); cel.data.set(e.fullB); }
    return;
  }
  const cel = doc.cels.get(k);
  if (!cel) return;
  if (e.fullB) cel.data.set(e.fullB);
  else writeSparse(cel, e.idx, e.pre);
}

function isZero4(d: Uint8ClampedArray, p: number): boolean {
  return d[p] === 0 && d[p + 1] === 0 && d[p + 2] === 0 && d[p + 3] === 0;
}

/** Encode one caller PixelChange into the sparse fallback form. */
function encodeChange(doc: Doc, c: PixelChange): EncChange | null {
  const area = doc.w * doc.h;
  const base: EncChange = {
    li: c.li, fi: c.fi,
    born: c.before === null, remove: c.after === null,
    idx: null, pre: null, post: null, fullB: null, fullA: null,
  };
  if (c.after === null) {
    if (c.before === null) return null;            // nothing at all happened
    base.fullB = c.before;                          // undo restores the whole cel
    return base;
  }
  const after = c.after;
  if (c.before === null) {
    // cel created: undo deletes it, so we only need the pixels that differ
    // from an empty cel
    const idx: number[] = [];
    let any = false;
    for (let n = 0; n < area; n++) if (!isZero4(after, n * 4)) { idx.push(n); any = true; }
    if (!any) return null;
    if (idx.length * 3 > area) { base.fullA = after; return base; } // dense: keep buffer
    const post = new Uint8ClampedArray(idx.length * 4);
    for (let n = 0; n < idx.length; n++) post.set(after.subarray(idx[n] * 4, idx[n] * 4 + 4), n * 4);
    base.idx = idx; base.post = post;
    return base;
  }
  const before = c.before;
  const idx: number[] = [];
  const pre: number[] = [];
  const post: number[] = [];
  for (let n = 0; n < area; n++) {
    const p = n * 4;
    if (before[p] === after[p] && before[p + 1] === after[p + 1] &&
        before[p + 2] === after[p + 2] && before[p + 3] === after[p + 3]) continue;
    idx.push(n);
    pre.push(before[p], before[p + 1], before[p + 2], before[p + 3]);
    post.push(after[p], after[p + 1], after[p + 2], after[p + 3]);
  }
  if (!idx.length) return null;
  if (idx.length * 3 > area) { base.fullB = before; base.fullA = after; return base; }
  base.idx = idx;
  base.pre = Uint8ClampedArray.from(pre);
  base.post = Uint8ClampedArray.from(post);
  return base;
}

export class History {
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private cap = 60;

  /** change the step limit; Infinity keeps every entry (full recording) */
  setCap(n: number): void {
    this.cap = n;
  }
  /** current step limit (Infinity = full recording mode) */
  limit(): number {
    return this.cap;
  }
  /** drop the oldest entries so the stack fits the current cap */
  trimToCap(): void {
    if (!Number.isFinite(this.cap)) return;
    while (this.undoStack.length > this.cap) this.undoStack.shift();
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
  canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  private push(entry: Entry): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > this.cap) this.undoStack.shift();
    this.redoStack = [];
  }

  /**
   * Generic command entry for any already-applied mutation with a cheap
   * inverse. Prefer this over pushStruct (deep snapshot) whenever the inverse
   * can be expressed directly.
   */
  record(label: string, actions: { apply: () => void; unapply: () => void }, data?: ScalarData, doc?: Doc): void {
    this.push({ label, fwd: () => actions.apply(), back: () => actions.unapply(), data, doc });
  }

  /** Pixel-level change. The caller must have ALREADY applied "after" to the doc. */
  pushPixels(label: string, doc: Doc, changes: PixelChange[]): void {
    const enc: EncChange[] = [];
    for (const c of changes) {
      const e = encodeChange(doc, c);
      if (e) enc.push(e);
    }
    if (!enc.length) return; // no visible change -> no undo step
    this.push({
      label,
      fwd: () => { for (const e of enc) applyFwd(doc, e); },
      back: () => { for (let i = enc.length - 1; i >= 0; i--) applyBack(doc, enc[i]); },
      enc,
      doc,
    });
  }

  /** Structural change: call fn(doc); before/after snapshots are deep copies. */
  pushStruct(label: string, doc: Doc, fn: () => void): void {
    const before = doc.capture();
    fn();
    const after = doc.capture();
    const restore = (s: DocSnapshot) => {
      doc.restore(s);
    };
    this.push({
      label,
      fwd: () => restore(after),
      back: () => restore(before),
      snap: { before, after },
      doc,
    });
  }

  /** forget every step that edited `doc` (a canvas was closed) */
  dropByDoc(doc: Doc): void {
    this.undoStack = this.undoStack.filter((e) => e.doc !== doc);
    this.redoStack = this.redoStack.filter((e) => e.doc !== doc);
  }

  /** Export the stack for a project file. Steps that have no serializable
   *  payload stop the export: everything older than the newest such step is
   *  dropped so the remaining history stays correct. */
  dump(docIdOf?: (doc: Doc) => string | undefined): HistoryDump {
    const all = [...this.undoStack, ...this.redoStack];
    let start = 0;
    for (let i = 0; i < all.length; i++) {
      if (!all[i].enc && !all[i].snap && !all[i].data) start = i + 1;
    }
    const entries: HistoryDumpEntry[] = [];
    for (let i = start; i < all.length; i++) {
      const e = all[i];
      const docId = e.doc && docIdOf ? docIdOf(e.doc) : undefined;
      if (e.enc) entries.push({ label: e.label, kind: "pixels", enc: e.enc, docId });
      else if (e.snap) entries.push({ label: e.label, kind: "struct", before: e.snap.before, after: e.snap.after, docId });
      else if (e.data) entries.push({ label: e.label, kind: "scalar", data: e.data, docId });
    }
    return { index: Math.max(0, this.undoStack.length - start), entries };
  }

  /** Rebuild a stack previously written by dump() + the project encoder. */
  loadDump(dump: HistoryDump, host: HistoryHost): void {
    this.clear();
    const doc = host.doc;
    const built: Entry[] = [];
    for (const e of dump.entries) {
      const target = (e.docId && host.docFor?.(e.docId)) || doc;
      if (e.kind === "pixels" && e.enc) {
        const enc = e.enc;
        built.push({
          label: e.label,
          fwd: () => { for (const c of enc) applyFwd(target, c); },
          back: () => { for (let i = enc.length - 1; i >= 0; i--) applyBack(target, enc[i]); },
          enc,
          doc: target,
        });
      } else if (e.kind === "struct" && e.before && e.after) {
        const before = e.before, after = e.after;
        built.push({
          label: e.label,
          fwd: () => target.restore(after),
          back: () => target.restore(before),
          snap: { before, after },
          doc: target,
        });
      } else if (e.kind === "scalar" && e.data) {
        const acts = host.scalarActions(e.data, target);
        built.push({ label: e.label, fwd: () => acts.apply(), back: () => acts.unapply(), data: e.data, doc: target });
      }
    }
    const idx = Math.max(0, Math.min(built.length, dump.index));
    this.undoStack = built.slice(0, idx);
    this.redoStack = built.slice(idx);
  }

  undo(): string | null {
    const e = this.undoStack.pop();
    if (!e) return null;
    e.back();
    this.redoStack.push(e);
    return e.label;
  }

  redo(): string | null {
    const e = this.redoStack.pop();
    if (!e) return null;
    e.fwd();
    this.undoStack.push(e);
    return e.label;
  }

  /** chronological labels (oldest -> newest) with the applied-step index. */
  list(): { labels: string[]; index: number } {
    const future: string[] = [];
    for (let i = this.redoStack.length - 1; i >= 0; i--) future.push(this.redoStack[i].label);
    return { labels: [...this.undoStack.map((x) => x.label), ...future], index: this.undoStack.length };
  }

  /** jump so exactly "index" steps are applied; index may equal total (latest). */
  jumpTo(index: number): void {
    const total = this.undoStack.length + this.redoStack.length;
    if (index < 0 || index > total) return;
    while (this.undoStack.length < index && this.redoStack.length > 0) this.redo();
    while (this.undoStack.length > index && this.undoStack.length > 0) this.undo();
  }
}
