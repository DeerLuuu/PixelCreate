/* PixelCraft core: document model, history, selection utilities */
(function () {
  const PX = window.PX = window.PX || {};

  const U = PX.U = {
    clamp(v, a, b) { return v < a ? a : v > b ? b : v; },
    cloneArr(a) { return a.slice(0); },
    // color helpers: css style from rgba array
    cssColor: function (c) { return "rgba(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + "," + ((c[3] === undefined ? 255 : c[3]) / 255).toFixed(3) + ")"; },
    hexToRgba(hex) {
      hex = String(hex).replace("#", "").trim();
      if (hex.length === 3) hex = hex.replace(/(.)/g, "$1$1");
      const n = parseInt(hex, 16);
      if (isNaN(n)) return [0, 0, 0, 255];
      if (hex.length >= 8) return [(n >> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
    },
    rgbaToHex(c) {
      const h = (v) => ("0" + v.toString(16)).slice(-2);
      const a = c[3] === undefined ? 255 : c[3];
      return "#" + h(c[0]) + h(c[1]) + h(c[2]) + (a < 255 ? h(a) : "");
    },
    blendOver(dst, src) { // dst 4-byte array idx, src rgba
      const a = src[3] / 255, ia = 1 - a;
      const r = src[0] * a + dst[0] * ia, g = src[1] * a + dst[1] * ia, b = src[2] * a + dst[2] * ia;
      const aa = src[3] + dst[3] * ia;
      dst[0] = r; dst[1] = g; dst[2] = b; dst[3] = aa;
    },
    eqColor(a, b, tol) {
      return Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol && Math.abs((a[3] === undefined ? 255 : a[3]) - (b[3] === undefined ? 255 : b[3])) <= tol;
    },
    uid() { return (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)); }
  };

  // ---------- Cel ----------
  PX.Cel = class Cel {
    constructor(w, h) { this.w = w; this.h = h; this.data = new Uint8ClampedArray(w * h * 4); }
    clone() { const c = new Cel(this.w, this.h); c.data.set(this.data); return c; }
  };

  // ---------- Selection mask ----------
  PX.Sel = class Sel {
    constructor(w, h, all) {
      this.w = w; this.h = h; this.mask = new Uint8Array(w * h);
      if (all) this.mask.fill(1);
    }
    get(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h ? this.mask[y * this.w + x] : 0; }
    set(x, y, v) { if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.mask[y * this.w + x] = v; }
    hasAny() { for (let i = 0; i < this.mask.length; i++) if (this.mask[i]) return true; return false; }
    clear() { this.mask.fill(0); }
    fillAll() { this.mask.fill(1); }
    clone() { const s = new Sel(this.w, this.h); s.mask.set(this.mask); return s; }
    bounds() {
      let x0 = this.w, y0 = this.h, x1 = -1, y1 = -1;
      for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) if (this.mask[y * this.w + x]) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    }
  };

  // ---------- Document ----------
  PX.Doc = class Doc {
    constructor(w, h, name) {
      this.w = Math.max(1, Math.min(1024, w | 0));
      this.h = Math.max(1, Math.min(1024, h | 0));
      this.name = name || "untitled";
      this.layers = [{ id: U.uid(), name: "Layer 1", visible: true, opacity: 100, blend: "normal", locked: false }];
      this.frames = [{ id: U.uid(), duration: 100 }];
      this.cels = new Map(); // "li:fi" -> Cel
      this.background = null; // {r,g,b} or null = transparent
      this.palette = [];
      this.sel = null; // PX.Sel or null
      this.dirty = true;
    }
    celKey(li, fi) { return li + ":" + fi; }
    celAt(li, fi) { return this.cels.get(this.celKey(li, fi)) || null; }
    ensureCel(li, fi) {
      const k = this.celKey(li, fi);
      let c = this.cels.get(k);
      if (!c) { c = new PX.Cel(this.w, this.h); this.cels.set(k, c); }
      return c;
    }
    layerMeta(li) { return this.layers[li]; }
    frameMeta(fi) { return this.frames[fi]; }

    // Selection helpers
    selectionActive() { return this.sel && this.sel.hasAny(); }
    selAt(x, y) { return this.sel ? this.sel.get(x, y) : 1; } // no selection = everything allowed

    // ---- deep snapshot for structural history ----
    capture() {
      const cels = new Map();
      this.cels.forEach((cel, k) => { const c = new PX.Cel(cel.w, cel.h); c.data.set(cel.data); cels.set(k, c); });
      return {
        layers: JSON.parse(JSON.stringify(this.layers)),
        frames: JSON.parse(JSON.stringify(this.frames)),
        cels, background: this.background ? this.background.slice() : null,
        w: this.w, h: this.h, name: this.name,
        palette: this.palette.map(c => c.slice()),
        sel: this.sel ? this.sel.clone() : null
      };
    }
    restore(snap) {
      this.layers = JSON.parse(JSON.stringify(snap.layers));
      this.frames = JSON.parse(JSON.stringify(snap.frames));
      this.cels = new Map();
      snap.cels.forEach((cel, k) => { const c = new PX.Cel(cel.w, cel.h); c.data.set(cel.data); this.cels.set(k, c); });
      this.background = snap.background ? snap.background.slice() : null;
      this.w = snap.w; this.h = snap.h; this.name = snap.name;
      this.palette = snap.palette.map(c => c.slice());
      this.sel = snap.sel ? snap.sel.clone() : null;
      this.dirty = true;
    }
  };

  // ---------- History ----------
  PX.History = class History {
    constructor() {
      this.stack = [];
      this.idx = -1; // index of last applied
      this.cap = 60;
    }
    clear() { this.stack = []; this.idx = -1; }
    canUndo() { return this.idx >= 0; }
    canRedo() { return this.idx < this.stack.length - 1; }
    push(entry) {
      if (this.idx < this.stack.length - 1) this.stack.length = this.idx + 1;
      this.stack.push(entry);
      if (this.stack.length > this.cap) this.stack.shift(); else this.idx++;
    }
    _apply(dir) {
      const e = dir === "undo" ? this.stack[this.idx] : this.stack[this.idx + 1];
      if (!e) return null;
      if (dir === "undo") this.idx--; else this.idx++;
      return e;
    }
    undo() {
      const e = this._apply("undo");
      if (!e) return null;
      e.applyBack && e.applyBack();
      return e.label;
    }
    redo() {
      const e = this._apply("redo");
      if (!e) return null;
      e.applyFwd && e.applyFwd();
      return e.label;
    }

    // Pixel edit: before/after whole-cel buffers per affected cel.
    // before/after may be null (cel created/removed by the edit)
    pixelChanges(label, changes) {
      const doc = changes.length ? changes[0].doc : null;
      const setCel = (li, fi, data) => {
        if (data == null) {
          doc.cels.delete(doc.celKey(li, fi));
        } else {
          const c = doc.ensureCel(li, fi);
          c.data.set(data);
          if (c._cv) c._cv = null;
        }
      };
      this.push({
        label,
        applyFwd: () => { for (const ch of changes) setCel(ch.li, ch.fi, ch.after); for (const ch of changes) if (ch.afterOp) ch.afterOp(); if (doc) doc.dirty = true; },
        applyBack: () => { for (const ch of changes) setCel(ch.li, ch.fi, ch.before); for (const ch of changes) if (ch.afterOp) ch.afterOp(); if (doc) doc.dirty = true; }
      });
    }

    // Structural snapshot edit: fn(doc) mutates, capture before/after
    struct(label, doc, fn) {
      const before = doc.capture();
      fn();
      const after = doc.capture();
      this.push({
        label,
        applyFwd: () => { doc.restore(after); },
        applyBack: () => { doc.restore(before); }
      });
    }
  };

  // color helpers exposed
  PX.colStr = function (c) { return U.cssColor(c); };
  PX.rgb = function (hex) { return U.hexToRgba(hex); };
  PX.MIX_MODES = ["normal", "multiply", "screen", "overlay", "darken", "lighten", "dodge", "burn", "hardlight", "softlight", "difference", "exclusion"];
  PX.DEFAULT_PALETTE = [
    "#000000", "#1d2b53", "#7e2553", "#008751", "#ab5236", "#5f574f", "#c2c3c7", "#fff1e8",
    "#ff004d", "#ffa300", "#ffec27", "#00e436", "#29adff", "#83769c", "#ff77a8", "#ffccaa",
    "#ffffff", "#9badb7", "#6a5acd", "#ff6347", "#ffd700", "#00fa9a", "#40e0d0", "#ff69b4"
  ];
})();
