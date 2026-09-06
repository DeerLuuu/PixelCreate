/* PixelCraft renderer: composite + viewport presentation + overlays */
(function () {
  const PX = window.PX = window.PX || {};

  PX.Renderer = class Renderer {
    constructor(doc, els, prefs) {
      this.doc = doc;
      this.els = els; // {pix, ov, viewport}
      this.prefs = prefs; // {grid, checker(always), onion, showSel, ...}
      this.zoom = 8;
      this.ox = 0; this.oy = 0; // screen css coords of doc origin
      this.composite = null; // canvas of current doc pixels
      this.compKey = "";
      this.dpr = Math.min(2.5, window.devicePixelRatio || 1);
      this.cursor = null; // {x,y} doc px
      this.cursorTool = null;
      this._ants = 0;
      this._anim = null;
      const self = this;
      this.resize();
    }

    resize() {
      const vp = this.els.viewport;
      const w = vp.clientWidth, h = vp.clientHeight;
      if (w <= 0 || h <= 0) return;
      for (const id of ["pix", "ov"]) {
        const c = this.els[id];
        c.style.width = w + "px"; c.style.height = h + "px";
        c.width = Math.round(w * this.dpr); c.height = Math.round(h * this.dpr);
      }
      this.fit();
      this.refresh(true);
    }

    resetTransform() {
      const vp = this.els.viewport;
      this.ox = vp.clientWidth / 2; this.oy = vp.clientHeight / 2;
      this.zoom = 1;
    }

    fit() {
      const vp = this.els.viewport, d = this.doc;
      const availW = Math.max(24, vp.clientWidth - 16), availH = Math.max(24, vp.clientHeight - 16);
      const zx = availW / d.w, zy = availH / d.h;
      let z = Math.min(zx, zy);
      // snap to integer if it fits nicely
      const zi = Math.floor(z);
      if (zi >= 1 && Math.abs(z - zi) < 0.15) z = zi;
      this.zoom = Math.max(0.05, Math.min(32, z));
      this.ox = (vp.clientWidth - d.w * this.zoom) / 2;
      this.oy = (vp.clientHeight - d.h * this.zoom) / 2;
    }

    screenToPixel(sx, sy) { return { x: Math.floor((sx - this.ox) / this.zoom), y: Math.floor((sy - this.oy) / this.zoom) }; }

    // ---- composition ----
    _tint(canvas, rgba, alpha) {
      const c = document.createElement("canvas");
      c.width = canvas.width; c.height = canvas.height;
      const x = c.getContext("2d");
      x.globalAlpha = alpha;
      x.drawImage(canvas, 0, 0);
      x.globalCompositeOperation = "source-in";
      x.globalAlpha = 1;
      x.fillStyle = rgba;
      x.fillRect(0, 0, c.width, c.height);
      return c;
    }

    buildComposite(force) {
      const d = this.doc;
      const onion = this.prefs.onion || 0;
      const curFi = this.curFrame != null ? this.curFrame : 0;
      const key = curFi + "|" + JSON.stringify(d.layers.map(l => [l.visible, l.opacity, l.blend, l.locked])) + "|on" + onion + "|bg" + (d.background ? d.background.join(",") : "x");
      if (!force && this.composite && this.compKey === key) return;
      this.compKey = key;
      const c = document.createElement("canvas");
      c.width = d.w; c.height = d.h;
      const ctx = c.getContext("2d");
      const drawLayers = (fi, tint, alphaMul) => {
        for (let li = 0; li < d.layers.length; li++) {
          const L = d.layers[li];
          if (!L.visible) continue;
          const cel = d.celAt(li, fi);
          if (!cel) continue;
          const tc = this._celCanvas(cel);
          ctx.globalAlpha = (L.opacity / 100) * (alphaMul == null ? 1 : alphaMul);
          ctx.globalCompositeOperation = PX.blendToCanvas(L.blend);
          if (tint) {
            const t = this._tint(tc, tint, 1);
            ctx.drawImage(t, 0, 0);
          } else {
            ctx.drawImage(tc, 0, 0);
          }
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
      };
      ctx.clearRect(0, 0, d.w, d.h);
      // background color layer
      if (d.background) {
        ctx.fillStyle = PX.U.cssColor(d.background);
        ctx.fillRect(0, 0, d.w, d.h);
      }
      // onion previous frames (behind current), tinted red family
      if (onion >= 1) {
        for (let k = 1; k <= Math.min(onion, 3); k++) {
          const fi = curFi - k;
          if (fi < 0) break;
          drawLayers(fi, "rgba(255,70,80,0.85)", 0.5 / k);
          ctx.globalAlpha = 1;
        }
      }
      // current frame
      drawLayers(curFi, null, 1);
      // onion next frames (ahead), tinted green family
      if (onion >= 2) {
        for (let k = 1; k <= Math.min(onion, 3); k++) {
          const fi = curFi + k;
          if (fi >= d.frames.length) break;
          drawLayers(fi, "rgba(80,220,120,0.9)", 0.5 / k);
          ctx.globalAlpha = 1;
        }
      }
      this.composite = c;
    }

    _celCanvas(cel) {
      if (cel._cv && cel._cvW === cel.w) return cel._cv;
      const c = document.createElement("canvas");
      c.width = cel.w; c.height = cel.h;
      const ctx = c.getContext("2d");
      ctx.putImageData(new ImageData(new Uint8ClampedArray(cel.data), cel.w, cel.h), 0, 0);
      cel._cv = c; cel._cvW = cel.w;
      return c;
    }

    refresh(force) {
      const d = this.doc;
      if (!d) return;
      this.buildComposite(force === true || d.dirty);
      d.dirty = false;
      const pix = this.els.pix.getContext("2d");
      const dpr = this.dpr;
      pix.setTransform(dpr, 0, 0, dpr, 0, 0);
      pix.clearRect(0, 0, this.els.viewport.clientWidth, this.els.viewport.clientHeight);
      pix.imageSmoothingEnabled = false;
      const z = this.zoom;
      // checker under transparent area
      if (!d.background) {
        const chk = document.createElement("canvas");
        chk.width = 2; chk.height = 2;
        const cc = chk.getContext("2d");
        cc.fillStyle = "#8d8f9c"; cc.fillRect(0, 0, 1, 1);
        cc.fillStyle = "#b9bac4"; cc.fillRect(1, 0, 1, 1);
        cc.fillRect(0, 1, 1, 1);
        cc.fillStyle = "#8d8f9c"; cc.fillRect(1, 1, 1, 1);
        const pat = pix.createPattern(chk, "repeat");
        pix.fillStyle = pat;
        pix.save();
        pix.translate(this.ox, this.oy);
        pix.scale(z, z);
        pix.fillRect(0, 0, d.w, d.h);
        pix.restore();
      }
      pix.drawImage(this.composite, this.ox, this.oy, d.w * z, d.h * z);
      // grid
      if (this.prefs.grid && z >= 6) {
        pix.save();
        pix.translate(this.ox, this.oy);
        pix.scale(z, z);
        pix.beginPath();
        pix.lineWidth = 1 / (z * dpr) * (z >= 16 ? 2 : 1);
        pix.strokeStyle = z >= 16 ? "rgba(60,64,80,0.55)" : "rgba(80,84,110,0.4)";
        for (let x = 0; x <= d.w; x++) { pix.moveTo(x, 0); pix.lineTo(x, d.h); }
        for (let y = 0; y <= d.h; y++) { pix.moveTo(0, y); pix.lineTo(d.w, y); }
        pix.stroke();
        pix.restore();
      }
      this.drawOverlay();
    }

    // overlay canvas (screen space) - selection + cursor
    drawOverlay() {
      const ov = this.els.ov.getContext("2d");
      const dpr = this.dpr;
      ov.setTransform(dpr, 0, 0, dpr, 0, 0);
      ov.clearRect(0, 0, this.els.viewport.clientWidth, this.els.viewport.clientHeight);
      const d = this.doc;
      if (!d) return;
      const z = this.zoom, ox = this.ox, oy = this.oy;
      // selection
      if (this.prefs.showSel && d.sel && d.sel.hasAny()) {
        ov.save();
        ov.translate(ox, oy); ov.scale(z, z);
        ov.imageSmoothingEnabled = false;
        const sc = document.createElement("canvas");
        sc.width = d.w; sc.height = d.h;
        const sctx = sc.getContext("2d");
        const img = sctx.createImageData(d.w, d.h);
        const m = d.sel.mask;
        for (let i = 0; i < m.length; i++) {
          if (m[i]) { img.data[i * 4 + 3] = 90; img.data[i * 4] = 90; img.data[i * 4 + 1] = 162; img.data[i * 4 + 2] = 240; }
        }
        sctx.putImageData(img, 0, 0);
        ov.drawImage(sc, 0, 0);
        ov.restore();
        // ants around bounds
        const b = d.sel.bounds();
        if (b) {
          const lx = ox + b.x * z, ly = oy + b.y * z, lw = b.w * z, lh = b.h * z;
          const off = (this._ants % 16);
          ov.save();
          ov.lineWidth = 2 / dpr * 2;
          ov.strokeStyle = "#e8ecff";
          ov.setLineDash([10, 8]);
          ov.lineDashOffset = -off;
          ov.strokeRect(lx, ly, lw, lh);
          ov.restore();
        }
      }
      // cursor
      const cu = this.cursor;
      if (cu && cu.tool) {
        const t = cu.tool;
        const x = ox + (cu.x + (t.cursorOffset ? t.cursorOffset.x : 0)) * z;
        const y = oy + (cu.y + (t.cursorOffset ? t.cursorOffset.y : 0)) * z;
        const s = (t.size != null ? t.size : 1) * z;
        ov.save();
        ov.lineWidth = 1.2 / dpr * 2;
        ov.strokeStyle = "rgba(255,255,255,0.9)";
        ov.fillStyle = "rgba(0,0,0,0.35)";
        const half = s / 2;
        ov.strokeRect(x, y, Math.max(2, s), Math.max(2, s));
        ov.restore();
      }
    }

    startAnts() {
      if (this._anim) return;
      const self = this;
      this._anim = setInterval(() => { self._ants++; self.drawOverlay(); }, 140);
    }
    stopAnts() { if (this._anim) { clearInterval(this._anim); this._anim = null; } }
  };

  PX.blendToCanvas = function (m) {
    const map = { normal: "source-over", multiply: "multiply", screen: "screen", overlay: "overlay", darken: "darken", lighten: "lighten", dodge: "color-dodge", burn: "color-burn", hardlight: "hard-light", softlight: "soft-light", difference: "difference", exclusion: "exclusion" };
    return map[m] || "source-over";
  };
})();
