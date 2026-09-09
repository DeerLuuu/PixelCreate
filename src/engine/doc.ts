import { Cel } from "./cel";
import type { BlendMode, RGBA } from "./types";
import { uid } from "./types";

export interface LayerMeta {
  id: string;
  name: string;
  visible: boolean;
  opacity: number; // 0..100
  blend: BlendMode;
  locked: boolean;
  /** id of ANOTHER canvas this layer mirrors live (null = a normal layer).
   *  The layer stores no pixels of its own while the link is active. */
  ref?: string | null;
}

export interface FrameMeta {
  id: string;
  durationMs: number;
}

export class Sel {
  readonly w: number;
  readonly h: number;
  mask: Uint8Array;
  /** bumped on every mask change: the view caches the selection tint on it, so
   *  a live stroke never has to rebuild the tint image */
  ver = 0;

  constructor(w: number, h: number, all = false) {
    this.w = w;
    this.h = h;
    this.mask = new Uint8Array(w * h);
    if (all) this.mask.fill(1);
  }

  get(x: number, y: number): number {
    return x >= 0 && y >= 0 && x < this.w && y < this.h ? this.mask[y * this.w + x] : 0;
  }
  set(x: number, y: number, v: number): void {
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.mask[y * this.w + x] = v ? 1 : 0;
    this.ver++;
  }
  /** call after writing to `mask` directly (bulk operations) */
  bump(): void {
    this.ver++;
  }
  hasAny(): boolean {
    for (let i = 0; i < this.mask.length; i++) if (this.mask[i]) return true;
    return false;
  }
  clear(): void {
    this.mask.fill(0);
    this.ver++;
  }
  fillAll(): void {
    this.mask.fill(1);
    this.ver++;
  }
  clone(): Sel {
    const s = new Sel(this.w, this.h);
    s.mask.set(this.mask);
    return s;
  }
  bounds(): { x: number; y: number; w: number; h: number } | null {
    let x0 = this.w, y0 = this.h, x1 = -1, y1 = -1;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (this.mask[y * this.w + x]) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }
}

export interface DocSnapshot {
  w: number;
  h: number;
  name: string;
  layers: LayerMeta[];
  frames: FrameMeta[];
  cels: Map<string, Cel>;
  bg: RGBA | null;
  palette: RGBA[];
  sel: Sel | null;
}

export class Doc {
  w: number;
  h: number;
  name: string;
  layers: LayerMeta[];
  frames: FrameMeta[];
  cels: Map<string, Cel> = new Map();
  bg: RGBA | null = null; // null = transparent
  palette: RGBA[] = [];
  sel: Sel | null = null;
  /** bumped whenever the pixels (or frame/layer content) change: reference
   *  layers and the other-canvas composite cache key off it */
  pixelRev = 0;

  constructor(w: number, h: number, name: string) {
    this.w = Math.max(1, Math.min(1024, w | 0));
    this.h = Math.max(1, Math.min(1024, h | 0));
    this.name = name || "untitled";
    this.layers = [{ id: uid(), name: "Layer 1", visible: true, opacity: 100, blend: "normal", locked: false }];
    this.frames = [{ id: uid(), durationMs: 100 }];
  }

  key(li: number, fi: number): string {
    return li + ":" + fi;
  }
  celAt(li: number, fi: number): Cel | null {
    return this.cels.get(this.key(li, fi)) ?? null;
  }
  ensureCel(li: number, fi: number): Cel {
    const k = this.key(li, fi);
    let c = this.cels.get(k);
    if (!c) {
      c = new Cel(this.w, this.h);
      this.cels.set(k, c);
    }
    return c;
  }

  selectionActive(): boolean {
    return !!this.sel && this.sel.hasAny();
  }
  selAt(x: number, y: number): number {
    return this.sel ? this.sel.get(x, y) : 1;
  }

  /** Deep copy incl. every cel pixel buffer — used by structural history. */
  capture(): DocSnapshot {
    const cels = new Map<string, Cel>();
    for (const [k, cel] of this.cels) cels.set(k, cel.clone());
    return {
      w: this.w, h: this.h, name: this.name,
      layers: this.layers.map((l) => ({ ...l })),
      frames: this.frames.map((f) => ({ ...f })),
      cels,
      bg: this.bg ? ([...this.bg] as RGBA) : null,
      palette: this.palette.map((c) => [...c] as RGBA),
      sel: this.sel ? this.sel.clone() : null,
    };
  }

  restore(s: DocSnapshot): void {
    this.w = s.w; this.h = s.h; this.name = s.name;
    this.layers = s.layers.map((l) => ({ ...l }));
    this.frames = s.frames.map((f) => ({ ...f }));
    this.cels = new Map();
    for (const [k, cel] of s.cels) this.cels.set(k, cel.clone());
    this.bg = s.bg ? ([...s.bg] as RGBA) : null;
    this.palette = s.palette.map((c) => [...c] as RGBA);
    this.sel = s.sel ? s.sel.clone() : null;
  }

  static fromSnapshot(s: DocSnapshot): Doc {
    const d = new Doc(s.w, s.h, s.name);
    d.restore(s);
    return d;
  }
}
