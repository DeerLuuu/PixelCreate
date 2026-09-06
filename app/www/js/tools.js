/* PixelCraft tools: stroke engine + tool implementations + selection ops */
(function () {
  const PX = window.PX = window.PX || {};

  const TOOLS = PX.TOOLS = [
    { id: "pencil", icon: "i-pencil" }, { id: "eraser", icon: "i-eraser" }, { id: "bucket", icon: "i-bucket" },
    { id: "picker", icon: "i-picker" }, { id: "line", icon: "i-line" }, { id: "rect", icon: "i-rect" },
    { id: "rectfill", icon: "i-rectfill" }, { id: "ellipse", icon: "i-ellipse" }, { id: "ellipsefill", icon: "i-ellipsefill" },
    { id: "select", icon: "i-select" }, { id: "hand", icon: "i-hand" }
  ];

  function dotCells(x, y, r) {
    const cells = [];
    const R = Math.max(0, Math.round(r));
    const rr = R * R;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dy * dy <= rr) cells.push([x + dx, y + dy]);
    }
    return cells;
  }
  function paintAt(cel, x, y, color, maskSel) {
    if (x < 0 || y < 0 || x >= cel.w || y >= cel.h) return false;
    if (maskSel && !maskSel(x, y)) return false;
    const i = (y * cel.w + x) * 4;
    const d = cel.data;
    const a = color[3];
    if (a >= 255) {
      d[i] = color[0]; d[i + 1] = color[1]; d[i + 2] = color[2]; d[i + 3] = 255;
    } else if (a > 0) {
      PX.U.blendOver(d.subarray(i, i + 4), color);
    }
    return true;
  }
  function eraseAt(cel, x, y, maskSel) {
    if (x < 0 || y < 0 || x >= cel.w || y >= cel.h) return false;
    if (maskSel && !maskSel(x, y)) return false;
    const i = (y * cel.w + x) * 4;
    cel.data[i] = 0; cel.data[i + 1] = 0; cel.data[i + 2] = 0; cel.data[i + 3] = 0;
    return true;
  }
  function drawLineCells(x0, y0, x1, y1, fn) {
    let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (; ;) {
      fn(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
  function fillRegion(cel, sx, sy, color, tolerance, maskSel) {
    const w = cel.w, h = cel.h, d = cel.data;
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return;
    const bi = (sy * w + sx) * 4;
    const isMatch = (x, y) => {
      const i = (y * w + x) * 4;
      return Math.abs(d[i] - d[bi]) <= tolerance && Math.abs(d[i + 1] - d[bi + 1]) <= tolerance &&
        Math.abs(d[i + 2] - d[bi + 2]) <= tolerance && Math.abs(d[i + 3] - d[bi + 3]) <= tolerance;
    };
    if (!isMatch(sx, sy)) return;
    const stack = [[sx, sy]];
    const visited = new Uint8Array(w * h);
    while (stack.length) {
      const [x, y] = stack.pop();
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const vi = y * w + x;
      if (visited[vi]) continue;
      visited[vi] = 1;
      if (!isMatch(x, y)) continue;
      if (maskSel && !maskSel(x, y)) continue;
      const i = vi * 4;
      if (color[3] >= 255) { d[i] = color[0]; d[i + 1] = color[1]; d[i + 2] = color[2]; d[i + 3] = 255; }
      else if (color[3] > 0) PX.U.blendOver(d.subarray(i, i + 4), color);
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
  }

  // ------------- Stroke engine -------------
  PX.Stroke = class Stroke {
    constructor(app, tool, px, py) {
      this.app = app;
      this.doc = app.doc;
      this.tool = tool;
      this.li = app.curLayer();
      this.fi = app.curFrame();
      if (this.doc.layerMeta(this.li).locked && tool !== "picker") { this.dead = true; return; }
      this.maskFn = this.doc.selectionActive() ? (x, y) => this.doc.selAt(x, y) : null;
      const cel = this.doc.celAt(this.li, this.fi);
      this.before = cel ? new Uint8ClampedArray(cel.data) : null;
      this._wasCreated = !cel;
      if (!cel) this.doc.ensureCel(this.li, this.fi);
      this.cel = this.doc.celAt(this.li, this.fi);
      this.color = app.color.slice();
      this.color[3] = Math.round((app.brushAlpha / 100) * 255);
      this.size = Math.max(1, Math.round(app.brushSize));
      this.last = null;
      this.startPt = [px, py];
      this.changed = false;
      const h = PX.ToolHandlers[tool];
      if (h && h.onStart) h.onStart(this, px, py);
    }
    mark(x, y, pressure) {
      if (this.dead) return;
      if (!this.last) this.last = [x, y];
      const h = PX.ToolHandlers[this.tool];
      if (h && h.doStroke) h.doStroke.call(h, this, x, y, pressure);
      this.doc.dirty = true;
      this.app.invalidate();
    }
    commit() {
      if (this.dead) { this.app.afterStroke(this); return; }
      // single-shot tools already committed changes during start/move
      const cel = this.doc.celAt(this.li, this.fi);
      let changed = false;
      if (cel) {
        if (this.before) {
          const a = cel.data, b = this.before;
          for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { changed = true; break; }
        } else {
          for (let i = 3; i < cel.data.length; i += 4) if (cel.data[i]) { changed = true; break; }
        }
      }
      if (changed) {
        this.app.history.pixelChanges(this.label(), [{
          doc: this.doc, li: this.li, fi: this.fi,
          before: this.before, after: new Uint8ClampedArray(cel.data)
        }]);
      } else if (!this.before && cel) {
        // nothing drawn on a cel that we created -> remove empty cel
        this.doc.cels.delete(this.doc.celKey(this.li, this.fi));
      }
      this.app.afterStroke(this);
    }
    label() {
      const map = { pencil: "tools.pencil", eraser: "tools.eraser", bucket: "tools.bucket", line: "tools.line", rect: "tools.rect", rectfill: "tools.rectfill", ellipse: "tools.ellipse", ellipsefill: "tools.ellipsefill" };
      return PX.t(map[this.tool] || this.tool);
    }
    cancel() {
      if (this.dead) { this.app.afterStroke(this); return; }
      const cel = this.doc.celAt(this.li, this.fi);
      if (cel) {
        if (this.before) cel.data.set(this.before);
        else this.doc.cels.delete(this.doc.celKey(this.li, this.fi));
        this.doc.dirty = true;
      }
      this.app.afterStroke(this);
    }
  };

  // ------------- Tool handlers -------------
  const H = PX.ToolHandlers = {};

  H.pencil = {
    _paint(s, x, y, size) {
      const r = size - 1;
      for (const [dx, dy] of dotCells(x, y, r)) {
        if (paintAt(s.cel, dx, dy, s.color, s.maskFn)) s.changed = true;
      }
    },
    onStart(s, px, py) { s.last = [px, py]; this._paint(s, px, py, s.size); },
    doStroke(s, px, py, pres) {
      let size = s.size;
      if (pres > 0 && pres < 1) size = Math.max(1, Math.round(s.size * (0.4 + pres * 0.9)));
      const self = this;
      drawLineCells(s.last[0], s.last[1], px, py, (x, y) => self._paint(s, x, y, size));
      s.last = [px, py];
    }
  };

  H.eraser = {
    _paint(s, x, y) {
      for (const [dx, dy] of dotCells(x, y, s.size - 1)) {
        if (eraseAt(s.cel, dx, dy, s.maskFn)) s.changed = true;
      }
    },
    onStart(s, px, py) { s.last = [px, py]; this._paint(s, px, py); },
    doStroke(s, px, py) {
      const self = this;
      drawLineCells(s.last[0], s.last[1], px, py, (x, y) => self._paint(s, x, y));
      s.last = [px, py];
    }
  };

  H.picker = {
    onStart(s, px, py) { this._pick(s, px, py); },
    doStroke(s, px, py) { this._pick(s, px, py); },
    _pick(s, px, py) {
      const app = s.app, d = app.doc;
      if (px < 0 || py < 0 || px >= d.w || py >= d.h) return;
      const c = document.createElement("canvas");
      c.width = d.w; c.height = d.h;
      const cx = c.getContext("2d");
      for (let li = 0; li < d.layers.length; li++) {
        const L = d.layers[li];
        if (!L.visible) continue;
        const cel = d.celAt(li, s.fi);
        if (!cel) continue;
        const tc = document.createElement("canvas");
        tc.width = d.w; tc.height = d.h;
        tc.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(cel.data), cel.w, cel.h), 0, 0);
        cx.globalAlpha = L.opacity / 100;
        cx.globalCompositeOperation = PX.blendToCanvas(L.blend);
        cx.drawImage(tc, 0, 0);
      }
      cx.globalAlpha = 1;
      const px2 = Math.max(0, Math.min(d.w - 1, px)), py2 = Math.max(0, Math.min(d.h - 1, py));
      try {
        const dd = cx.getImageData(px2, py2, 1, 1).data;
        if (dd[3] > 0) app.setColor([dd[0], dd[1], dd[2], dd[3]]);
      } catch (e) { }
    }
  };

  H.bucket = {
    onStart(s, px, py) {
      fillRegion(s.cel, px, py, s.color, 0, s.maskFn);
    },
    doStroke() { }
  };

  // shapes ------------------------------------------------------------------
  function makeShape(kind, filled) {
    return {
      onStart(s, px, py) { s.startPt = [px, py]; this._apply(s, px, py); },
      doStroke(s, px, py) {
        // restore pristine start state, then redraw full shape
        if (s.before) s.cel.data.set(s.before);
        else s.cel.data.fill(0);
        this._apply(s, px, py);
        s.doc.dirty = true;
      },
      _apply(s, x, y) {
        const [x0, y0] = s.startPt;
        const xa = Math.min(x0, x), xb = Math.max(x0, x), ya = Math.min(y0, y), yb = Math.max(y0, y);
        const paint = (X, Y) => { if (paintAt(s.cel, X, Y, s.color, s.maskFn)) s.changed = true; };
        if (kind === "line") {
          drawLineCells(x0, y0, x, y, paint);
          return;
        }
        if (kind === "rect" || kind === "rectfill") {
          if (filled) {
            for (let yy = ya; yy <= yb; yy++) for (let xx = xa; xx <= xb; xx++) paint(xx, yy);
          } else {
            for (let xx = xa; xx <= xb; xx++) { paint(xx, ya); paint(xx, yb); }
            for (let yy = ya; yy <= yb; yy++) { paint(xa, yy); paint(xb, yy); }
          }
          return;
        }
        // ellipse
        const cx = (xa + xb) / 2, cy = (ya + yb) / 2;
        const rx = (xb - xa) / 2, ry = (yb - ya) / 2;
        if (rx < 0.1 || ry < 0.1) { paint(xa, ya); return; }
        if (filled) {
          for (let yy = ya; yy <= yb; yy++) {
            const v = (yy - cy) / ry;
            const half = Math.sqrt(Math.max(0, 1 - v * v)) * rx;
            for (let xx = Math.round(cx - half); xx <= Math.round(cx + half); xx++) paint(xx, yy);
          }
          return;
        }
        const draw4 = (ex, ey) => {
          paint(Math.round(cx + ex), Math.round(cy + ey));
          paint(Math.round(cx - ex), Math.round(cy + ey));
          paint(Math.round(cx + ex), Math.round(cy - ey));
          paint(Math.round(cx - ex), Math.round(cy - ey));
        };
        let ex = rx, ey = 0;
        const rx2 = rx * rx, ry2 = ry * ry;
        let err = rx2 - 2 * rx * ry2 + ry2;
        while (ex >= 0) {
          draw4(ex, ey);
          if (ex === 0) break;
          if (err < 0) { err += 2 * ry2 * (2 * ey + 3); }
          else { err += 2 * ry2 * (2 * ey + 3) - 4 * rx2 * (ex - 1) + 2 * rx2; ex -= 1; }
          ey += 1;
        }
        // simple fallback: ensure endpoints
        paint(xa, ya); paint(xb, yb);
      }
    };
  }
  H.line = makeShape("line", false);
  H.rect = makeShape("rect", false);
  H.rectfill = makeShape("rectfill", true);
  H.ellipse = makeShape("ellipse", false);
  H.ellipsefill = makeShape("ellipsefill", true);

  PX.dotCells = dotCells;
  PX.drawLineCells = drawLineCells;
  PX.fillRegion = fillRegion;
  PX.paintAt = paintAt;
  PX.eraseAt = eraseAt;

  // ---------------- Selection ops (active layer) ----------------
  function sAt(app, x, y) { return app.doc.selAt(x, y); }

  PX.selOps = {
    bounds(app) {
      const d = app.doc;
      if (!d.sel || !d.sel.hasAny()) return null;
      return d.sel.bounds();
    },
    fill(app) {
      const b = this.bounds(app); if (!b) return;
      const li = app.curLayer();
      if (app.doc.layerMeta(li).locked) return;
      const cel = app.doc.ensureCel(li, app.curFrame());
      const before = new Uint8ClampedArray(cel.data);
      for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) {
        if (sAt(app, x, y)) paintAt(cel, x, y, app.color, null);
      }
      app.history.pixelChanges(PX.t("sel.fill"), [{ doc: app.doc, li, fi: app.curFrame(), before, after: new Uint8ClampedArray(cel.data) }]);
      app.invalidate();
    },
    clear(app) {
      const b = this.bounds(app); if (!b) return;
      const li = app.curLayer();
      if (app.doc.layerMeta(li).locked) return;
      const cel = app.doc.ensureCel(li, app.curFrame());
      const before = new Uint8ClampedArray(cel.data);
      for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) {
        if (sAt(app, x, y)) eraseAt(cel, x, y, null);
      }
      app.history.pixelChanges(PX.t("sel.clear"), [{ doc: app.doc, li, fi: app.curFrame(), before, after: new Uint8ClampedArray(cel.data) }]);
      app.invalidate();
    },
    grab(app) {
      const b = this.bounds(app); if (!b) return null;
      const li = app.curLayer();
      const cel = app.doc.celAt(li, app.curFrame());
      if (!cel) return null;
      const d = app.doc;
      const out = new PX.Cel(b.w, b.h);
      for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) {
        const sx = b.x + x, sy = b.y + y;
        if (sAt(app, sx, sy)) {
          const si = (sy * d.w + sx) * 4, oi = (y * b.w + x) * 4;
          out.data[oi] = cel.data[si]; out.data[oi + 1] = cel.data[si + 1];
          out.data[oi + 2] = cel.data[si + 2]; out.data[oi + 3] = cel.data[si + 3];
        }
      }
      return out;
    },
    copy(app) { app.clip = this.grab(app); app.toast(PX.t("toasts.copied")); },
    cut(app) {
      const b = this.bounds(app); if (!b) return;
      const li = app.curLayer();
      if (app.doc.layerMeta(li).locked) return;
      const cel = app.doc.ensureCel(li, app.curFrame());
      const before = new Uint8ClampedArray(cel.data);
      this.copy(app);
      for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) {
        if (sAt(app, x, y)) eraseAt(cel, x, y, null);
      }
      app.history.pixelChanges(PX.t("sel.cut"), [{ doc: app.doc, li, fi: app.curFrame(), before, after: new Uint8ClampedArray(cel.data) }]);
      app.invalidate();
    },
    paste(app) {
      if (!app.clip) { app.toast(PX.t("toasts.noSelArea")); return; }
      const d = app.doc;
      const clip = app.clip;
      const b = this.bounds(app);
      // destination: center on document when no selection, else at selection top-left
      const px = b ? b.x : Math.max(0, Math.floor((d.w - clip.w) / 2));
      const py = b ? b.y : Math.max(0, Math.floor((d.h - clip.h) / 2));
      // clip inside canvas
      const ox = Math.max(0, px), oy = Math.max(0, py);
      const ow = Math.min(clip.w, d.w - ox), oh = Math.min(clip.h, d.h - oy);
      const li = app.curLayer();
      if (app.doc.layerMeta(li).locked) { app.toast("locked"); return; }
      const cel = app.doc.ensureCel(li, app.curFrame());
      const before = new Uint8ClampedArray(cel.data);
      for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
        const si = (y * clip.w + x) * 4;
        if (clip.data[si + 3] > 0) {
          const c = [clip.data[si], clip.data[si + 1], clip.data[si + 2], clip.data[si + 3]];
          PX.U.blendOver(cel.data.subarray(((oy + y) * d.w + (ox + x)) * 4, ((oy + y) * d.w + (ox + x)) * 4 + 4), c);
        }
      }
      if (!d.sel) d.sel = new PX.Sel(d.w, d.h, false);
      d.sel.clear();
      for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) d.sel.set(ox + x, oy + y, 1);
      app.history.pixelChanges(PX.t("sel.paste"), [{ doc: d, li, fi: app.curFrame(), before, after: new Uint8ClampedArray(cel.data) }]);
      app.invalidate();
      app.toast(PX.t("toasts.pasted"));
    },
    flip(app, horizontal) {
      const b = this.bounds(app); if (!b) return;
      const li = app.curLayer();
      const cel = app.doc.celAt(li, app.curFrame());
      if (!cel) return;
      const d = app.doc;
      const before = new Uint8ClampedArray(cel.data);
      const swap = (x1, y1, x2, y2) => {
        const i = (y1 * d.w + x1) * 4, j = (y2 * d.w + x2) * 4;
        for (let k = 0; k < 4; k++) { const t = cel.data[i + k]; cel.data[i + k] = cel.data[j + k]; cel.data[j + k] = t; }
      };
      const w = b.w, h = b.h;
      if (horizontal) {
        for (let y = 0; y < h; y++) for (let x = 0; x < Math.floor(w / 2); x++) {
          const x1 = b.x + x, x2 = b.x + w - 1 - x;
          if (sAt(app, x1, b.y + y) || sAt(app, x2, b.y + y)) swap(x1, b.y + y, x2, b.y + y);
        }
      } else {
        for (let x = 0; x < w; x++) for (let y = 0; y < Math.floor(h / 2); y++) {
          const y1 = b.y + y, y2 = b.y + h - 1 - y;
          if (sAt(app, b.x + x, y1) || sAt(app, b.x + x, y2)) swap(b.x + x, y1, b.x + x, y2);
        }
      }
      app.history.pixelChanges(PX.t(horizontal ? "sel.fliph" : "sel.flipv"), [{ doc: app.doc, li, fi: app.curFrame(), before, after: new Uint8ClampedArray(cel.data) }]);
      app.invalidate();
    },
    clearMask(app) { if (app.doc.sel) { app.doc.sel.clear(); app.invalidate(); } },
    selectAll(app) {
      const d = app.doc;
      if (!d.sel) d.sel = new PX.Sel(d.w, d.h, false);
      d.sel.fillAll();
      app.invalidate();
    }
  };
})();
