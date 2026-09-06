/* PixelCraft main: app controller, gestures, panels, dialogs */
(function () {
  "use strict";
  const PX = window.PX = window.PX || {};
  const el = (id) => document.getElementById(id);
  const NS = "http://www.w3.org/2000/svg";
  function icon(id, cls) {
    const svg = document.createElementNS(NS, "svg");
    if (cls) svg.setAttribute("class", cls);
    const use = document.createElementNS(NS, "use");
    use.setAttribute("href", "#" + id);
    svg.appendChild(use);
    return svg;
  }
  function b(tag, props, kids) {
    const e = document.createElement(tag);
    if (props) for (const k in props) {
      if (k === "class") e.className = props[k];
      else if (k === "text") e.textContent = props[k];
      else if (k === "html") e.innerHTML = props[k];
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), props[k]);
      else e.setAttribute(k, props[k]);
    }
    if (kids) for (const k of kids) e.appendChild(typeof k === "string" ? document.createTextNode(k) : k);
    return e;
  }
  function button(cls, children, onclick) {
    const btn = b("button", { class: cls }, children);
    if (onclick) btn.addEventListener("click", onclick);
    return btn;
  }
  function toPx(v) { return v + "px"; }

  // ============================================================ APP
  const App = function () {
    this.doc = null;
    this.history = new PX.History();
    this.prefs = { grid: true, onion: 0, showSel: true, lang: "zh", autosave: true, checker: true };
    this.curLayerIdx = 0;
    this.curFrameIdx = 0;
    this.tool = "pencil";
    this.brushSize = 1;
    this.brushAlpha = 100;
    this.color = [32, 32, 32, 255];
    this.clip = null;
    this.playing = false;
    this._playTimer = null;
    this._autosaveT = null;
    this._selCache = null;
    this._longT = null;
    this._longMoved = false;
    this._lastTap = 0;
    this._lastTapXY = null;
    const self = this;
    this.els = {
      pix: el("pixcanvas"), ov: el("ovcanvas"), viewport: el("viewport"),
      toolrail: el("toolrail"), rightrail: el("rightrail"),
      framestrip: el("framestrip"), docTitle: el("doc-title"),
      zoomhud: el("zoomhud"), statusbar: el("statusbar"),
      colorchip: el("colorchip"), brushsize: el("brushsize"), bsLabel: el("brushsize-label"),
      panel: el("panel"), panelMask: el("panel-mask"), dlg: el("dlg"), dlgMask: el("dlg-mask"),
      btnUndo: el("btn-undo"), btnRedo: el("btn-redo"), btnSave: el("btn-save"), btnMenu: el("btn-menu"),
      btnPalette: el("btn-palette"), btnLayers: el("btn-layers"), layerBadge: el("layer-badge"),
      tlPlay: el("tl-play"), tlFirst: el("tl-first"), tlNext: el("tl-next"),
      tlAdd: el("tl-add"), tlDupe: el("tl-dupe"), tlDel: el("tl-del"), tlOnion: el("tl-onion")
    };
    this.toastEl = null;
    this.applyPrefs();
  };

  App.prototype.applyPrefs = function () {
    try {
      const saved = JSON.parse(localStorage.getItem("pc.prefs") || "{}");
      Object.assign(this.prefs, saved);
      PX.setLang(this.prefs.lang);
    } catch (e) { }
  };
  App.prototype.savePrefs = function () {
    try { localStorage.setItem("pc.prefs", JSON.stringify(this.prefs)); } catch (e) { }
    if (window.PixelBridge) { window.PixelBridge.keepAwake(true); }
  };

  // ---------- doc lifecycle ----------
  App.prototype.newDoc = function (w, h, name, background) {
    this.doc = new PX.Doc(w, h, name);
    if (background) this.doc.background = background.slice();
    this.doc.palette = PX.DEFAULT_PALETTE.map((hx) => PX.U.hexToRgba(hx));
    this.curLayerIdx = 0;
    this.curFrameIdx = 0;
    this.history.clear();
    this.clip = null;
    this.playing = false;
    this.stopPlayback();
    this.view = new PX.Renderer(this.doc, { pix: this.els.pix, ov: this.els.ov, viewport: this.els.viewport }, this.prefs);
    this.view.curFrame = 0;
    this.view.prefs = this.prefs;
    this.view.prefs.showSel = true;
    this.doc.dirty = true;
    this.syncEverything(true);
  };

  App.prototype.curLayer = function () { return Math.max(0, Math.min(this.doc.layers.length - 1, this.curLayerIdx)); };
  App.prototype.curFrame = function () { return Math.max(0, Math.min(this.doc.frames.length - 1, this.curFrameIdx)); };

  App.prototype.setCurFrame = function (fi, quiet) {
    this.curFrameIdx = Math.max(0, Math.min(this.doc.frames.length - 1, fi));
    if (this.view) { this.view.curFrame = this.curFrameIdx; this.doc.dirty = true; }
    this.invalidate();
    if (!quiet) { this.syncTimelineUI(); this.syncTitleUI(); }
  };
  App.prototype.setCurLayer = function (li, quiet) {
    this.curLayerIdx = Math.max(0, Math.min(this.doc.layers.length - 1, li));
    if (!quiet) this.syncLayerPanel();
  };

  // ---------- rendering/state ----------
  App.prototype.invalidate = function () {
    if (this.view) this.view.refresh(false);
  };
  App.prototype.forceRedraw = function () {
    if (this.view) this.view.refresh(true);
    this.syncAll();
  };
  App.prototype.afterStroke = function (stroke) {
    this.doc.dirty = true;
    this.invalidate();
    this.syncDirtyUI();
    this.scheduleAutosave();
  };
  App.prototype.syncDirtyUI = function () {
    this.syncHistoryUI();
    this.syncTitleUI();
    if (this._layerPanelOpen) this.renderLayers();
    if (this._frameDlgOpen) { /* noop */ }
  };
  App.prototype.syncEverything = function (redraw) {
    if (this.view) { if (redraw) this.view.refresh(true); else this.invalidate(); }
    this.syncToolUI();
    this.syncHistoryUI();
    this.syncTitleUI();
    this.syncTimelineUI();
    this.syncLayerBadge();
    this.syncColorUI();
    this.syncZoomUI();
    this.syncStatusUI();
    if (this._layerPanelOpen) this.renderLayers();
    if (this._paletteOpen) this.renderPalette();
    if (this._timelinePanel) this.syncTimelineUI();
  };

  // ---------- color ----------
  App.prototype.setColor = function (rgba) {
    this.color = [Math.round(rgba[0]), Math.round(rgba[1]), Math.round(rgba[2]), Math.round(rgba[3] === undefined ? 255 : rgba[3])];
    this.syncColorUI();
    if (this._paletteOpen) this.hilitePalette();
  };
  App.prototype.syncColorUI = function () {
    const c = this.color;
    const a = c[3] === undefined ? 255 : c[3];
    // solid color under a small alpha indicator: compose over checkerboard? chip background solid rgba
    this.els.colorchip.style.background = PX.U.cssColor([c[0], c[1], c[2], 255]);
    this.els.colorchip.dataset.hex = PX.U.rgbaToHex(c);
    this.els.bsLabel.textContent = this.brushSize;
    this.els.brushsize.value = this.brushSize;
  };

  // ---------- undo/redo ----------
  App.prototype.undo = function () {
    if (!this.history.canUndo()) return;
    this.history.undo();
    this.afterUndoRedo();
  };
  App.prototype.redo = function () {
    if (!this.history.canRedo()) return;
    this.history.redo();
    this.afterUndoRedo();
  };
  App.prototype.afterUndoRedo = function () {
    const d = this.doc;
    this.curLayerIdx = Math.min(this.curLayerIdx, d.layers.length - 1);
    this.curFrameIdx = Math.min(this.curFrameIdx, d.frames.length - 1);
    if (this.view) this.view.curFrame = this.curFrameIdx;
    d.dirty = true;
    this.syncEverything(true);
    this.scheduleAutosave();
  };

  // ---------- toast ----------
  App.prototype.toast = function (msg) {
    if (window.PixelBridge) { try { window.PixelBridge.toast(String(msg)); } catch (e) { } return; }
    let t = this.toastEl;
    if (!t) {
      t = b("div", { class: "toast" });
      document.body.appendChild(t);
      this.toastEl = t;
    }
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => t.classList.remove("show"), 1800);
  };

  // ---------- playback ----------
  App.prototype.togglePlay = function () {
    if (this.playing) this.stopPlayback();
    else this.startPlayback();
  };
  App.prototype.startPlayback = function () {
    if (this.playing) return;
    this.playing = true;
    this.syncPlayUI();
    this._tickPlay();
  };
  App.prototype.stopPlayback = function () {
    this.playing = false;
    if (this._playTimer) { clearTimeout(this._playTimer); this._playTimer = null; }
    this.syncPlayUI();
  };
  App.prototype._tickPlay = function () {
    if (!this.playing) return;
    const fi = this.curFrame();
    const next = fi + 1;
    if (next >= this.doc.frames.length) {
      this.stopPlayback();
      this.toast(PX.t("ui.help"));
      return;
    }
    const self = this;
    this._playTimer = setTimeout(() => {
      self.setCurFrame(next, true);
      self._tickPlay();
    }, Math.max(10, this.doc.frames[fi].duration || 100));
  };
  App.prototype.syncPlayUI = function () {
    const p = this.els.tlPlay.querySelector("use");
    if (p) p.setAttribute("href", "#" + (this.playing ? "i-pause" : "i-play"));
  };

  // ---------- autosave ----------
  App.prototype.scheduleAutosave = function () {
    if (!this.prefs.autosave) return;
    clearTimeout(this._autosaveT);
    const self = this;
    this._autosaveT = setTimeout(() => self.doSaveLocal(), 900);
  };
  App.prototype.doSaveLocal = function () {
    if (!this.doc) return;
    const self = this;
    PX.proj.serialize(this.doc).then((txt) => {
      try {
        if (txt.length < 4 * 1024 * 1024) localStorage.setItem("pc.autosave", txt);
      } catch (e) { self.toast(PX.t("toasts.autosaveFail")); }
    }).catch(() => { });
  };

  // ============================================================ boot & bind
  const app = new App();
  PX.app = app;
  window.__pc_back = function () {
    if (!el("panel").classList.contains("hidden")) { app.closePanel(); return true; }
    if (!el("dlg").classList.contains("hidden")) { app.closeDlg(); return true; }
    return false;
  };

  // defaults created inside boot() (after all prototype methods are defined)
  void app;

  // ---------- tools rail ----------
  function buildToolRail() {
    const rail = app.els.toolrail;
    rail.innerHTML = "";
    let first = true;
    for (const t of PX.TOOLS) {
      const btn = button("rail-btn" + (t.id === "select" ? "" : ""), [icon(t.icon)], () => app.setTool(t.id));
      btn.dataset.tool = t.id;
      btn.title = PX.t("tools." + t.id);
      rail.appendChild(btn);
    }
  }
  App.prototype.setTool = function (id) {
    this.tool = id;
    this.syncToolUI();
    if (id === "select") this.syncSelUI();
  };
  App.prototype.syncToolUI = function () {
    const rail = this.els.toolrail;
    for (const btn of rail.children) {
      btn.classList.toggle("active", btn.dataset.tool === this.tool);
    }
    this.syncStatusUI();
  };

  // ---------- zoom & status ----------
  App.prototype.setZoom = function (z, cx, cy) {
    if (!this.view) return;
    const v = this.view;
    z = Math.max(0.05, Math.min(32, z));
    const vp = this.els.viewport;
    cx = cx === undefined ? vp.clientWidth / 2 : cx;
    cy = cy === undefined ? vp.clientHeight / 2 : cy;
    const k = z / v.zoom;
    v.ox = cx - (cx - v.ox) * k;
    v.oy = cy - (cy - v.oy) * k;
    v.zoom = z;
    this.invalidate();
    this.syncZoomUI();
  };
  App.prototype.fitView = function () { if (this.view) { this.view.fit(); this.invalidate(); this.syncZoomUI(); } };
  App.prototype.syncZoomUI = function () {
    if (this.view) this.els.zoomhud.textContent = Math.round(this.view.zoom * 100) + "%";
  };
  App.prototype.syncStatusUI = function () {
    const d = this.doc;
    if (!d) return;
    const p = this.els.statusbar;
    p.textContent = PX.t("tools." + this.tool) + " · " + d.w + "×" + d.h + " · " + PX.t("toasts.layerCount") + " " + d.layers.length + " · " + PX.t("toasts.frameCount") + " " + d.frames.length;
  };
  App.prototype.syncTitleUI = function () {
    this.els.docTitle.textContent = (this.doc ? this.doc.name : "") + " — " + PX.t("appName");
    document.title = (this.doc ? this.doc.name + " — " : "") + PX.t("appName");
  };

  // ---------- history buttons ----------
  App.prototype.syncHistoryUI = function () {
    this.els.btnUndo.classList.toggle("off", !this.history.canUndo());
    this.els.btnRedo.classList.toggle("off", !this.history.canRedo());
  };

  // ---------- timeline ----------
  App.prototype.syncTimelineUI = function () {
    const d = this.doc, strip = this.els.framestrip;
    strip.innerHTML = "";
    for (let fi = 0; fi < d.frames.length; fi++) {
      const f = d.frames[fi];
      const box = b("div", { class: "framebox" + (fi === this.curFrame() ? " cur" : ""), "data-fi": fi });
      box.appendChild(b("span", { text: String(fi + 1) }));
      const dur = b("span", { class: "fdur", text: String(f.duration || 100) + "ms" });
      box.appendChild(dur);
      box.addEventListener("click", (ev) => { ev.stopPropagation(); this.setCurFrame(fi, false); });
      box.addEventListener("pointerdown", (ev) => { ev.stopPropagation(); ev.preventDefault(); });
      let lp = 0;
      box.addEventListener("pointerdown", () => { lp = Date.now(); });
      box.addEventListener("pointerup", (ev) => {
        ev.stopPropagation();
        if (Date.now() - lp > 450) this.openFrameDlg(fi);
        else this.setCurFrame(fi, false);
      });
      strip.appendChild(box);
    }
    // scroll to current WITHOUT touching page scroll (manual, strip-local only)
    const cur = strip.querySelector(".cur");
    if (cur) {
      const sr = strip.getBoundingClientRect();
      const cr = cur.getBoundingClientRect();
      if (cr.left < sr.left || cr.right > sr.right) {
        strip.scrollLeft += cr.left - sr.left - (sr.width - cr.width) / 2;
      }
    }
    this.syncPlayUI();
  };
  App.prototype.syncLayerBadge = function () {
    this.els.layerBadge.textContent = this.doc ? this.doc.layers.length : 1;
  };

  // frame ops (structural via history.struct)
  App.prototype.frameOp = function (op, fi) {
    const d = this.doc;
    fi = fi === undefined ? this.curFrame() : fi;
    const self = this;
    this.history.struct(PX.t(op), d, () => {
      if (op === "frameAdd") {
        d.frames.splice(fi + 1, 0, { id: PX.U.uid(), duration: d.frames[fi] ? d.frames[fi].duration : 100 });
      } else if (op === "frameDupe") {
        const src = d.frames[fi] ? d.frames[fi].duration : 100;
        d.frames.splice(fi + 1, 0, { id: PX.U.uid(), duration: src });
        for (let li = 0; li < d.layers.length; li++) {
          const cel = d.celAt(li, fi);
          if (cel) {
            const c2 = cel.clone();
            d.cels.set(d.celKey(li, fi + 1), c2);
          }
        }
        self.curFrameIdx = Math.min(d.frames.length - 1, fi + 1);
      } else if (op === "frameDel") {
        if (d.frames.length <= 1) return;
        d.frames.splice(fi, 1);
        for (const k of Array.from(d.cels.keys())) {
          const m = k.split(":");
          const li = +m[0], f = +m[1];
          if (f === fi) d.cels.delete(k);
          else if (f > fi) { const cel = d.cels.get(k); d.cels.delete(k); d.cels.set(d.celKey(li, f - 1), cel); }
        }
        self.curFrameIdx = Math.min(d.frames.length - 1, fi);
      } else if (op === "frameLeft" && fi > 0) {
        d.frames.splice(fi - 1, 0, d.frames.splice(fi, 1)[0]);
        for (const k of Array.from(d.cels.keys())) {
          const m = k.split(":"), li = +m[0], f = +m[1];
          if (f === fi - 1 || f === fi) {
            const cel = d.cels.get(k); d.cels.delete(k);
            d.cels.set(d.celKey(li, f === fi ? fi - 1 : fi), cel);
          }
        }
        self.curFrameIdx = fi - 1;
      } else if (op === "frameRight" && fi < d.frames.length - 1) {
        d.frames.splice(fi + 2, 0, d.frames.splice(fi, 1)[0]);
        for (const k of Array.from(d.cels.keys())) {
          const m = k.split(":"), li = +m[0], f = +m[1];
          if (f === fi || f === fi + 1) {
            const cel = d.cels.get(k); d.cels.delete(k);
            d.cels.set(d.celKey(li, f === fi ? fi + 1 : fi), cel);
          }
        }
        self.curFrameIdx = fi + 1;
      } else if (op === "frameDur") {
        const v = fi; // not used
        void v;
      }
    });
    this.syncEverything(true);
    this.scheduleAutosave();
  };
  App.prototype.setFrameDur = function (fi, ms) {
    const d = this.doc;
    const before = JSON.parse(JSON.stringify(d.frames));
    d.frames[fi].duration = Math.max(10, Math.min(60000, Math.round(ms)));
    const after = JSON.parse(JSON.stringify(d.frames));
    this.history.push({
      label: PX.t("frameDur"),
      applyFwd: () => { d.frames = JSON.parse(JSON.stringify(after)); d.dirty = true; },
      applyBack: () => { d.frames = JSON.parse(JSON.stringify(before)); d.dirty = true; }
    });
    this.syncTimelineUI();
  };

  // layer ops
  App.prototype.layerOp = function (op, li) {
    const d = this.doc;
    li = li === undefined ? this.curLayer() : li;
    const self = this;
    this.history.struct(PX.t("layer" + (op[0].toUpperCase() + op.slice(1))), d, () => {
      if (op === "add") {
        d.layers.splice(li + 1, 0, { id: PX.U.uid(), name: PX.t("layers") + " " + (d.layers.length + 1), visible: true, opacity: 100, blend: "normal", locked: false });
        self.curLayerIdx = Math.min(d.layers.length - 1, li + 1);
      } else if (op === "dupe") {
        const L = d.layers[li];
        d.layers.splice(li + 1, 0, JSON.parse(JSON.stringify(Object.assign({ id: PX.U.uid() }, L))));
        for (let fi = 0; fi < d.frames.length; fi++) {
          const cel = d.celAt(li, fi);
          if (cel) d.cels.set(d.celKey(li + 1, fi), cel.clone());
        }
        self.curLayerIdx = Math.min(d.layers.length - 1, li + 1);
      } else if (op === "del") {
        if (d.layers.length <= 1) return;
        d.layers.splice(li, 1);
        for (const k of Array.from(d.cels.keys())) {
          const m = k.split(":");
          const l2 = +m[0], f = +m[1];
          if (l2 === li) d.cels.delete(k);
          else if (l2 > li) { const cel = d.cels.get(k); d.cels.delete(k); d.cels.set(d.celKey(l2 - 1, f), cel); }
        }
        self.curLayerIdx = Math.max(0, Math.min(d.layers.length - 1, li - 1 < 0 ? 0 : li - 1));
      } else if (op === "up" && li > 0) {
        const [L] = d.layers.splice(li, 1);
        d.layers.splice(li - 1, 0, L);
        this._moveCelKeyRange(li, li - 1);
        self.curLayerIdx = li - 1;
      } else if (op === "down" && li < d.layers.length - 1) {
        const [L] = d.layers.splice(li, 1);
        d.layers.splice(li + 1, 0, L);
        this._moveCelKeyRange(li, li + 1);
        self.curLayerIdx = li + 1;
      } else if (op === "merge") {
        if (li <= 0) return;
        const dst = d.celAt(li - 1, this.curFrame());
        const src = d.celAt(li, this.curFrame());
        const self2 = this;
        if (dst || src) {
          // merge current frame only into dst layer at all frames? keep per-frame
          for (let fi = 0; fi < d.frames.length; fi++) {
            const a = d.celAt(li - 1, fi);
            const b = d.celAt(li, fi);
            if (!b) continue;
            if (!a) d.cels.set(d.celKey(li - 1, fi), b.clone());
            else {
              // composite b over a using dst layer settings
              const c = a.clone();
              const srcL = d.layers[li], dstL = d.layers[li - 1];
              const ca = document.createElement("canvas"); ca.width = d.w; ca.height = d.h;
              const xa = ca.getContext("2d");
              xa.putImageData(new ImageData(new Uint8ClampedArray(c.data), c.w, c.h), 0, 0);
              const cb2 = document.createElement("canvas"); cb2.width = d.w; cb2.height = d.h;
              const xb = cb2.getContext("2d");
              xb.putImageData(new ImageData(new Uint8ClampedArray(b.data), b.w, b.h), 0, 0);
              xa.globalAlpha = srcL.opacity / 100;
              xa.globalCompositeOperation = PX.blendToCanvas(srcL.blend);
              xa.drawImage(cb2, 0, 0);
              const out = xa.getImageData(0, 0, d.w, d.h).data;
              c.data.set(out);
              d.cels.set(d.celKey(li - 1, fi), c);
            }
          }
        }
        d.layers.splice(li, 1);
        for (const k of Array.from(d.cels.keys())) {
          const m = k.split(":"), l2 = +m[0], f = +m[1];
          if (l2 === li) d.cels.delete(k);
          else if (l2 > li) { const cel = d.cels.get(k); d.cels.delete(k); d.cels.set(d.celKey(l2 - 1, f), cel); }
        }
        self.curLayerIdx = Math.max(0, Math.min(d.layers.length - 1, li - 1));
        void self2;
      }
    });
    this.syncEverything(true);
    this.scheduleAutosave();
  };
  App.prototype._moveCelKeyRange = function (fromLi, toLi) {
    const d = this.doc;
    const swaps = [];
    for (const [k, cel] of d.cels) {
      const m = k.split(":");
      const l2 = +m[0], f = +m[1];
      if (l2 === fromLi || l2 === toLi) swaps.push([k, l2, f, cel]);
    }
    for (const [k, l2, f, cel] of swaps) {
      const nl = l2 === fromLi ? toLi : fromLi;
      d.cels.delete(k);
      d.cels.set(d.celKey(nl, f), cel);
    }
  };

  // onion
  App.prototype.cycleOnion = function () {
    this.prefs.onion = (this.prefs.onion + 1) % 3; // 0 off, 1 prev, 2 both
    this.els.tlOnion.classList.toggle("active", this.prefs.onion > 0);
    this.doc.dirty = true;
    this.invalidate();
    this.savePrefs();
  };

  // ============================================================ GESTURES
  function bindGestures() {
    const vp = app.els.viewport;
    const pointers = new Map();
    let gesture = null; // {mode:'panzoom'|'stroke', ...}
    let stroke = null;
    let pinchBase = null; // {midx,midy,dist,ox,oy,zoom}
    let longT = null;

    function pxPoint(e) {
      const r = vp.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    function cancelLong() { if (longT) { clearTimeout(longT); longT = null; } }

    vp.addEventListener("contextmenu", (e) => e.preventDefault());
    vp.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      vp.setPointerCapture && vp.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, pxPoint(e));
      cancelLong();
      if (pointers.size === 2) {
        // cancel any stroke -> pinch zoom
        if (stroke) { stroke.cancel(); stroke = null; }
        const [a, b] = [...pointers.values()];
        const v = app.view;
        pinchBase = {
          midx: (a.x + b.x) / 2, midy: (a.y + b.y) / 2,
          dist: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
          ox: v.ox, oy: v.oy, zoom: v.zoom
        };
        return;
      }
      const p = pxPoint(e);
      const pp = app.view.screenToPixel(p.x, p.y);
      const d = app.doc;

      if (app.tool === "hand") {
        gesture = { mode: "pan", lastX: p.x, lastY: p.y };
        return;
      }
      if (app.tool === "select") {
        handleSelectDown(p, pp, e);
        return;
      }
      if (pp.x < 0 || pp.y < 0 || pp.x >= d.w || pp.y >= d.h) {
        gesture = { mode: "pan", lastX: p.x, lastY: p.y };
        return;
      }
      // normal drawing tool
      stroke = new PX.Stroke(app, app.tool, pp.x, pp.y);
      if (stroke.dead) { app.toast(PX.t("layers") + " 🔒"); stroke = null; return; }
      stroke.mark(pp.x, pp.y, e.pressure);
      // long press = pipette
      const sx0 = pp.x, sy0 = pp.y;
      longT = setTimeout(() => {
        longT = null;
        if (!stroke) return;
        const oldTool = app.tool;
        const h = PX.ToolHandlers.picker;
        const temp = Object.create(stroke);
        h._pick.call(h, temp, sx0, sy0);
        stroke.cancel();
        stroke = null;
        app.toast(PX.U.rgbaToHex(app.color));
        void oldTool;
      }, 600);
    });

    vp.addEventListener("pointermove", (e) => {
      const pt = pxPoint(e);
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, pt);
      const v = app.view;
      // hover (no buttons, no gesture)
      const activeCount = pointers.size;

      if (activeCount >= 2 && pinchBase) {
        const [a, b] = [...pointers.values()];
        const midx = (a.x + b.x) / 2, midy = (a.y + b.y) / 2;
        const dist = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
        const k = dist / pinchBase.dist;
        const z = Math.max(0.05, Math.min(32, pinchBase.zoom * k));
        const s = z / pinchBase.zoom;
        v.ox = midx - (pinchBase.midx - pinchBase.ox) * s + (pinchBase.midx - midx) * 0; // keep mid-anchor + pan handled via midx shift
        v.ox = midx - (pinchBase.midx - pinchBase.ox) * s;
        v.oy = midy - (pinchBase.midy - pinchBase.oy) * s;
        v.zoom = z;
        app.invalidate();
        app.syncZoomUI();
        return;
      }
      if (gesture && gesture.mode === "pan") {
        v.ox += pt.x - gesture.lastX;
        v.oy += pt.y - gesture.lastY;
        gesture.lastX = pt.x; gesture.lastY = pt.y;
        app.invalidate();
        return;
      }
      if (activeCount >= 1 && pointers.has(e.pointerId)) {
        const p0 = pointers.get(e.pointerId);
        // pan with extra finger if 2nd arrives handled above; nothing else
        if (stroke) {
          const pp = v.screenToPixel(pt.x, pt.y);
          const dx = Math.abs(pp.x - (stroke.last ? stroke.last[0] : pp.x));
          const dy = Math.abs(pp.y - (stroke.last ? stroke.last[1] : pp.y));
          if (stroke.last && (dx > 0 || dy > 0)) cancelLong();
          stroke.mark(pp.x, pp.y, e.pointerType === "pen" && e.pressure ? e.pressure : 1);
          cancelLong();
        } else if (app.tool === "select" && app._selDrag) {
          handleSelectMove(pt);
        }
        void p0;
        return;
      }
      // pure hover cursor
      const pp = v.screenToPixel(pt.x, pt.y);
      const drawish = ["pencil", "eraser", "bucket", "line", "rect", "rectfill", "ellipse", "ellipsefill"].indexOf(app.tool) >= 0;
      v.cursor = drawish && pp.x >= 0 && pp.y >= 0 && pp.x < app.doc.w && pp.y < app.doc.h
        ? { x: pp.x, y: pp.y, tool: app.tool, size: app.brushSize } : null;
      v.drawOverlay();
    });

    function endPointer(e) {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchBase = null;
      if (pointers.size === 0) {
        if (gesture) { gesture = null; }
        if (stroke) {
          cancelLong();
          stroke.commit();
          stroke = null;
        }
        if (app.tool === "select" && app._selDrag) endSelectDrag();
        if (longT) { clearTimeout(longT); longT = null; }
      }
    }
    vp.addEventListener("pointerup", endPointer);
    vp.addEventListener("pointercancel", (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size === 0 && stroke) { stroke.cancel(); stroke = null; }
      app._selDrag = null;
    });
    // double-tap zoom in
    vp.addEventListener("pointerup", (e) => {
      const now = Date.now();
      const p = pxPoint(e);
      if (now - app._lastTap < 300 && app._lastTapXY && Math.hypot(p.x - app._lastTapXY.x, p.y - app._lastTapXY.y) < 48) {
        app.setZoom(app.view.zoom * 2, p.x, p.y);
        app._lastTap = 0;
        return;
      }
      app._lastTap = now;
      app._lastTapXY = p;
    });
    // hide cursor after leaving
    vp.addEventListener("pointerleave", () => {
      if (pointers.size === 0 && app.view) { app.view.cursor = null; app.view.drawOverlay(); }
    });
  }

  // ---- select tool logic ----
  function handleSelectDown(p, pp, e) {
    const d = app.doc;
    const inside = d.sel && d.sel.get(pp.x, pp.y);
    const li = app.curLayer();
    const cel = d.celAt(li, app.curFrame());
    const hasAlpha = cel && inside && cel.data[(pp.y * d.w + pp.x) * 4 + 3] > 0;
    if (inside && (hasAlpha || (e.shiftKey))) {
      // start content move
      const b = d.sel.bounds();
      if (!b) { startNewSel(pp); return; }
      app._selDrag = { kind: "move", sx: pp.x, sy: pp.y, cel, before: cel ? new Uint8ClampedArray(cel.data) : null, b, moved: false };
      return;
    }
    if (inside && !hasAlpha) { startNewSel(pp); return; }
    // new selection (or clear when tap same pixel)
    app._selDrag = { kind: "rect", x0: pp.x, y0: pp.y, x1: pp.x, y1: pp.y, started: false };
  }
  function startNewSel(pp) {
    app._selDrag = { kind: "rect", x0: pp.x, y0: pp.y, x1: pp.x, y1: pp.y, started: false };
  }
  function handleSelectMove(pt) {
    const v = app.view;
    const pp = v.screenToPixel(pt.x, pt.y);
    const g = app._selDrag;
    if (!g) return;
    if (g.kind === "rect") {
      if (Math.abs(pp.x - g.x0) + Math.abs(pp.y - g.y0) > 0) g.started = true;
      g.x1 = pp.x; g.y1 = pp.y;
      applySelRect(g);
      return;
    }
    if (g.kind === "move") {
      const dx = pp.x - g.sx, dy = pp.y - g.sy;
      if (dx || dy) g.moved = true;
      if (g.moved) {
        moveSelContent(g, dx, dy);
      }
    }
  }
  function applySelRect(g) {
    const d = app.doc;
    if (!d.sel) d.sel = new PX.Sel(d.w, d.h, false);
    d.sel.clear();
    const xa = Math.min(g.x0, g.x1), xb = Math.max(g.x0, g.x1);
    const ya = Math.min(g.y0, g.y1), yb = Math.max(g.y0, g.y1);
    for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
      if (x >= 0 && y >= 0 && x < d.w && y < d.h) d.sel.set(x, y, 1);
    }
    app.invalidate();
  }
  function moveSelContent(g, dx, dy) {
    const d = app.doc;
    const li = app.curLayer();
    const cel = d.celAt(li, app.curFrame());
    const b = g.b;
    if (!cel || !b) return;
    // restore
    if (g.before) cel.data.set(g.before);
    else cel.data.fill(0);
    const nx = b.x + dx, ny = b.y + dy;
    // move: copy selected content to new pos
    const content = PX.selOps.grab(app);
    if (!content) { app.doc.dirty = true; app.invalidate(); return; }
    for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) {
      const si = (y * b.w + x) * 4;
      if (!content.data[si + 3]) continue;
      const tx = nx + x, ty = ny + y;
      if (tx < 0 || ty < 0 || tx >= cel.w || ty >= cel.h) continue;
      const di = (ty * cel.w + tx) * 4;
      cel.data[di] = content.data[si]; cel.data[di + 1] = content.data[si + 1];
      cel.data[di + 2] = content.data[si + 2]; cel.data[di + 3] = content.data[si + 3];
    }
    // update selection
    if (!d.sel) d.sel = new PX.Sel(d.w, d.h, false);
    d.sel.clear();
    for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) {
      const tx = nx + x, ty = ny + y;
      if (tx >= 0 && ty >= 0 && tx < d.w && ty < d.h) d.sel.set(tx, ty, 1);
    }
    app.doc.dirty = true;
    app.invalidate();
  }
  function endSelectDrag() {
    const g = app._selDrag;
    app._selDrag = null;
    const d = app.doc;
    if (!g) return;
    if (g.kind === "rect") {
      if (!g.started) {
        // tap outside content → clear selection
        if (d.sel && d.sel.hasAny() && !(g.x0 >= 0 && g.y0 >= 0 && d.sel.get(g.x0, g.y0))) {
          d.sel.clear();
        }
        applySelRect(g); // ensure tap keeps 1px sel? no: clear
        if (!g.started) d.sel.clear();
      }
      app.invalidate();
      app.syncSelUI();
      return;
    }
    if (g.kind === "move") {
      const li = app.curLayer();
      const cel = d.celAt(li, app.curFrame());
      if (g.moved && cel && g.before) {
        let changed = false;
        const a = cel.data, bb = g.before;
        for (let i = 0; i < a.length; i++) if (a[i] !== bb[i]) { changed = true; break; }
        if (changed) {
          app.history.pixelChanges(PX.t("sel.move"), [{ doc: d, li, fi: app.curFrame(), before: g.before, after: new Uint8ClampedArray(cel.data) }]);
          app.scheduleAutosave();
        }
      }
      app.invalidate();
    }
  }

  app.syncSelUI = function () {
    // visual state only
  };

  // ============================================================ PANELS
  const panelBody = b("div", { class: "panel-body" });
  function openPanel(title, builder) {
    const p = el("panel");
    const mask = el("panel-mask");
    p.innerHTML = "";
    const head = b("div", { class: "panel-head" },
      [b("span", { text: title }), b("span", { class: "tb-spacer" }),
      button("tb-btn", [icon("i-x")], () => app.closePanel())]);
    p.appendChild(head);
    const body = b("div", { class: "panel-body" });
    p.appendChild(body);
    mask.classList.remove("hidden");
    p.classList.remove("hidden");
    builder(body);
    return body;
  }
  App.prototype.closePanel = function () {
    el("panel").classList.add("hidden");
    el("panel-mask").classList.add("hidden");
    app._layerPanelOpen = false;
    app._paletteOpen = false;
  };
  el("panel-mask").addEventListener("click", () => app.closePanel());

  // ---------- Layers panel ----------
  function openLayersPanel() {
    app._layerPanelOpen = true;
    const body = openPanel(PX.t("layers"), (bd) => {
      app.renderLayers(bd);
      const foot = b("div", { class: "panel-actions" });
      foot.appendChild(button("pbtn primary", [icon("i-plus"), PX.t("layerAdd")], () => app.layerOp("add")));
      bd.appendChild(foot);
      const tip = b("div", { class: "row-note", html: "· " + PX.t("newLayerNote") });
      bd.appendChild(tip);
    });
    void body;
  }
  App.prototype.renderLayers = function (bd) {
    const d = this.doc;
    if (!d) return;
    const body = bd || this._layerPanelBody;
    if (!body) return;
    body.innerHTML = "";
    const list = b("div", {});
    const n = d.layers.length;
    for (let ri = n - 1; ri >= 0; ri--) {
      const li = ri;
      const L = d.layers[li];
      const row = b("div", { class: "row" + (li === app.curLayer() ? " active" : "") });
      // eye
      row.appendChild(button("mini-btn" + (L.visible ? "" : " off"), [icon(L.visible ? "i-eye" : "i-eyeoff")], () => {
        app.history.struct(PX.t("visible"), d, () => { L.visible = !L.visible; });
        app.invalidate();
        app.renderLayers();
      }));
      const nameBox = b("div", { class: "row-main" });
      const nm = b("div", { class: "rname", text: L.name });
      nameBox.appendChild(nm);
      const sub = b("div", { class: "rsub", text: (L.blend !== "normal" ? PX.t("blendModes." + L.blend) + " · " : "") + (L.opacity < 100 ? L.opacity + "% · " : "") + (L.locked ? "🔒" : "") });
      nameBox.appendChild(sub);
      row.appendChild(nameBox);
      row.appendChild(button("mini-btn", [icon("i-dupe")], (e) => { e.stopPropagation(); app.layerOp("dupe", li); }));
      row.appendChild(button("mini-btn", [icon("i-up")], (e) => { e.stopPropagation(); app.layerOp("up", li); }));
      row.appendChild(button("mini-btn", [icon("i-down")], (e) => { e.stopPropagation(); app.layerOp("down", li); }));
      row.appendChild(button("mini-btn danger", [icon("i-trash")], (e) => {
        e.stopPropagation();
        if (n <= 1) return app.toast(PX.t("layerDel") + "!");
        app.layerOp("del", li);
      }));
      row.addEventListener("click", () => app.setCurLayer(li, true));
      list.appendChild(row);
      const self = this;
      const openEditor = () => {
        app.setCurLayer(li, true);
        self._layerEditor(li);
      };
      nm.addEventListener("dblclick", openEditor);
      row.addEventListener("contextmenu", (e) => { e.preventDefault(); openEditor(); });
    }
    body.appendChild(list);
    this._layerPanelBody = body;
    // editor for current layer
    this._layerEditor(app.curLayer(), body);
    this.syncLayerBadge();
  };
  App.prototype._layerEditor = function (li, bodyEl) {
    const d = this.doc;
    const body = bodyEl || this._layerPanelBody;
    if (!d || !body) return;
    // remove previous editor node if flagged
    const old = body.querySelector(".layer-editor");
    if (old) old.remove();
    const L = d.layers[li];
    const ed = b("div", { class: "layer-editor" });
    const nameRow = b("div", { class: "row" });
    const inp = b("input", { type: "text", value: L.name, placeholder: PX.t("name") });
    inp.style.flex = "1";
    inp.addEventListener("change", () => {
      if (inp.value && inp.value !== L.name) {
        const before = JSON.parse(JSON.stringify(d.layers));
        L.name = inp.value;
        const after = JSON.parse(JSON.stringify(d.layers));
        app.history.push({ label: PX.t("name"), applyFwd: () => { d.layers = JSON.parse(JSON.stringify(after)); }, applyBack: () => { d.layers = JSON.parse(JSON.stringify(before)); } });
        app.renderLayers();
      }
    });
    nameRow.appendChild(b("span", { text: PX.t("name") + ":" }));
    nameRow.appendChild(inp);
    ed.appendChild(nameRow);
    // opacity
    const opRow = b("div", { class: "slider-row" });
    opRow.appendChild(b("span", { text: PX.t("opacity") + ":" }));
    const op = b("input", { type: "range", min: "0", max: "100", value: String(L.opacity) });
    op.style.flex = "1";
    op.addEventListener("input", () => {
      const before = JSON.parse(JSON.stringify(d.layers));
      L.opacity = +op.value;
      const after = JSON.parse(JSON.stringify(d.layers));
      app.history.push({ label: PX.t("opacity"), applyFwd: () => { d.layers = JSON.parse(JSON.stringify(after)); }, applyBack: () => { d.layers = JSON.parse(JSON.stringify(before)); } });
      d.dirty = true; app.invalidate();
    });
    opRow.appendChild(op);
    ed.appendChild(opRow);
    // blend select
    const blRow = b("div", { class: "slider-row" });
    blRow.appendChild(b("span", { text: PX.t("blend") + ":" }));
    const sel = b("select", {});
    for (const m of PX.MIX_MODES) {
      const o = b("option", { value: m, text: PX.t("blendModes." + m) });
      if (m === L.blend) o.selected = true;
      sel.appendChild(o);
    }
    sel.style.flex = "1";
    sel.addEventListener("change", () => {
      const before = JSON.parse(JSON.stringify(d.layers));
      L.blend = sel.value;
      const after = JSON.parse(JSON.stringify(d.layers));
      app.history.push({ label: PX.t("blend"), applyFwd: () => { d.layers = JSON.parse(JSON.stringify(after)); }, applyBack: () => { d.layers = JSON.parse(JSON.stringify(before)); } });
      d.dirty = true; app.invalidate();
    });
    blRow.appendChild(sel);
    ed.appendChild(blRow);
    // lock toggle + merge
    const actRow = b("div", { class: "panel-actions" });
    actRow.appendChild(button("pbtn small" + (L.locked ? " primary" : ""), [b("span", { text: L.locked ? "🔒" : "🔓" })], () => {
      const before = JSON.parse(JSON.stringify(d.layers));
      L.locked = !L.locked;
      const after = JSON.parse(JSON.stringify(d.layers));
      app.history.push({ label: PX.t("locked"), applyFwd: () => { d.layers = JSON.parse(JSON.stringify(after)); }, applyBack: () => { d.layers = JSON.parse(JSON.stringify(before)); } });
      app.renderLayers();
    }));
    actRow.appendChild(button("pbtn small", [icon("i-down"), PX.t("layerMerge")], () => app.layerOp("merge", li)));
    ed.appendChild(actRow);
    body.appendChild(ed);
    this._layerPanelBody = body;
  };

  // ---------- Palette panel ----------
  function openPalettePanel() {
    app._paletteOpen = true;
    const body = openPanel(PX.t("palette"), (bd) => {
      app.renderPalette(bd);
    });
    void body;
  }
  App.prototype.renderPalette = function (bd) {
    const d = this.doc;
    const body = bd || this._paletteBody;
    if (!d || !body) return;
    body.innerHTML = "";
    this._paletteBody = body;
    // color editor
    const cur = app.color;
    const ce = b("div", { class: "row" });
    const sw = b("div", { class: "swatch long" });
    sw.style.background = PX.U.cssColor(cur);
    const pick = b("input", { type: "color", value: PX.U.rgbaToHex([cur[0], cur[1], cur[2], 255]) });
    pick.addEventListener("input", () => { const c = PX.U.hexToRgba(pick.value); app.setColor([c[0], c[1], c[2], cur[3]]); });
    const hex = b("input", { type: "text", class: "hexinput", value: PX.U.rgbaToHex(cur) });
    hex.addEventListener("change", () => {
      const c = PX.U.hexToRgba(hex.value);
      app.setColor([c[0], c[1], c[2], c[3]]);
    });
    ce.appendChild(sw);
    const box = b("div", { style: "flex:1;min-width:0" });
    box.appendChild(pick);
    const alphaRow = b("div", { class: "alpha-wrap" });
    const alpha = b("input", { type: "range", min: "0", max: "255", value: String(cur[3]) });
    alpha.style.flex = "1";
    alpha.addEventListener("input", () => { app.setColor([cur[0], cur[1], cur[2], +alpha.value]); });
    alphaRow.appendChild(b("span", { text: "α" }));
    alphaRow.appendChild(alpha);
    box.appendChild(hex);
    box.appendChild(alphaRow);
    ce.appendChild(box);
    body.appendChild(ce);
    const act = b("div", { class: "panel-actions" });
    act.appendChild(button("pbtn small", [icon("i-plus")], () => {
      d.palette.push(app.color.slice());
      app.renderPalette();
    }));
    act.appendChild(button("pbtn small danger", [icon("i-trash")], () => {
      if (app._palSelIdx != null && d.palette[app._palSelIdx]) {
        d.palette.splice(app._palSelIdx, 1);
        app._palSelIdx = null;
        app.renderPalette();
      }
    }));
    body.appendChild(act);
    // swatches
    const grid = b("div", { class: "swatches" });
    d.palette.forEach((c, i) => {
      const s = b("div", { class: "swatch" + (app._palSelIdx === i ? " cur" : "") });
      s.style.background = PX.U.cssColor(c);
      s.title = PX.U.rgbaToHex(c);
      s.addEventListener("click", () => {
        app.setColor(c.slice());
        app._palSelIdx = i;
        app.renderPalette();
      });
      s.addEventListener("contextmenu", (e) => { e.preventDefault(); d.palette.splice(i, 1); app.renderPalette(); });
      grid.appendChild(s);
    });
    body.appendChild(grid);
    this.hilitePalette();
  };
  App.prototype.hilitePalette = function () { };

  // ---------- Selection panel ----------
  function openSelPanel() {
    const body = openPanel(PX.t("sel.active"), (bd) => {
      const row = (label, iconId, fn) => {
        const r = b("div", { class: "row" });
        r.appendChild(button("pbtn", [icon(iconId), label], fn));
        bd.appendChild(r);
      };
      row(PX.t("sel.all"), "i-select", () => { PX.selOps.selectAll(app); app.toast(PX.t("sel.all")); });
      row(PX.t("sel.clear"), "i-x", () => { PX.selOps.clearMask(app); });
      row(PX.t("sel.fill"), "i-bucket", () => PX.selOps.fill(app));
      row(PX.t("sel.clear") + " (α=0)", "i-eraser", () => PX.selOps.clear(app));
      row(PX.t("sel.copy"), "i-dupe", () => PX.selOps.copy(app));
      row(PX.t("sel.cut"), "i-trash", () => PX.selOps.cut(app));
      row(PX.t("sel.paste"), "i-import", () => PX.selOps.paste(app));
      row(PX.t("sel.fliph"), "i-fliph", () => PX.selOps.flip(app, true));
      row(PX.t("sel.flipv"), "i-flipv", () => PX.selOps.flip(app, false));
    });
    void body;
  }

  // ---------- generic dialog ----------
  function showDlg(title, bodyBuilder, footButtons) {
    const dlg = el("dlg"), mask = el("dlg-mask");
    dlg.innerHTML = "";
    const head = b("div", { class: "dlg-head" },
      [b("span", { text: title }), b("span", { class: "tb-spacer" }),
      button("tb-btn", [icon("i-x")], () => app.closeDlg())]);
    dlg.appendChild(head);
    const body = b("div", { class: "dlg-body" });
    bodyBuilder(body);
    dlg.appendChild(body);
    const foot = b("div", { class: "dlg-foot" });
    for (const fb of footButtons || []) {
      foot.appendChild(button("pbtn" + (fb.primary ? " primary" : "") + (fb.danger ? " danger" : ""), [b("span", { text: fb.label })], fb.onClick));
    }
    dlg.appendChild(foot);
    mask.classList.remove("hidden");
    dlg.classList.remove("hidden");
    return body;
  }
  App.prototype.closeDlg = function () {
    el("dlg").classList.add("hidden");
    el("dlg-mask").classList.add("hidden");
  };
  el("dlg-mask").addEventListener("click", () => app.closeDlg());

  // ---------- New document ----------
  function openNewDocDlg() {
    let w = 64, h = 64, bg = null;
    const body = showDlg(PX.t("newDoc"), (bd) => {
      const preset = b("div", { class: "two-col" }, []);
      bd.appendChild(b("label", { class: "flabel", text: PX.t("width") + "/" + PX.t("height") }));
      const row2 = b("div", { class: "two-col" });
      const iw = b("input", { type: "number", min: "1", max: "1024", value: "64" });
      const ih = b("input", { type: "number", min: "1", max: "1024", value: "64" });
      row2.appendChild(iw); row2.appendChild(ih);
      bd.appendChild(row2);
      bd.appendChild(b("label", { class: "flabel", text: "Presets" }));
      const chips = b("div", { class: "panel-actions" });
      for (const s of [16, 32, 48, 64, 96, 128, 256]) {
        chips.appendChild(button("pbtn small" + (s === 64 ? " primary" : ""), [b("span", { text: String(s) })], () => {
          iw.value = s; ih.value = s;
        }));
      }
      bd.appendChild(chips);
      bd.appendChild(b("label", { class: "flabel", text: PX.t("name") }));
      const nm = b("input", { type: "text", value: "art-" + Date.now().toString(36).slice(-4) });
      bd.appendChild(nm);
      bd.appendChild(b("label", { class: "flabel", text: PX.t("transparentBg") }));
      const bt = b("div", { class: "tabrow" });
      const opt1 = b("button", { class: "tab active", text: PX.t("transparentBg") });
      const opt2 = b("button", { class: "tab", text: PX.t("includeBg") });
      bt.appendChild(opt1); bt.appendChild(opt2);
      opt1.onclick = () => { bg = null; opt1.classList.add("active"); opt2.classList.remove("active"); };
      opt2.onclick = () => { bg = [255, 255, 255, 255]; opt2.classList.add("active"); opt1.classList.remove("active"); };
      bd.appendChild(bt);
      bd.__get = () => {
        w = Math.max(1, Math.min(1024, parseInt(iw.value, 10) || 1));
        h = Math.max(1, Math.min(1024, parseInt(ih.value, 10) || 1));
        return { w, h, name: nm.value || "art", bg };
      };
    }, [{
      label: PX.t("confirm"), primary: true,
      onClick: () => {
        const o = body.__get();
        app.newDoc(o.w, o.h, o.name, o.bg);
        app.toast(PX.t("toasts.newDocCreated"));
        app.closeDlg();
        app.syncEverything(true);
      }
    }]);
  }

  // ---------- Save / Open project ----------
  App.prototype.saveProject = function (name) {
    const self = this;
    this.toast("…");
    PX.proj.serialize(this.doc).then((txt) => {
      const bytes = new TextEncoder().encode(txt);
      PX.files.saveBytes((name || this.doc.name || "art") + ".pxc", "application/json", bytes, (ok) => {
        self.toast(ok ? PX.t("toasts.saved") : PX.t("toasts.saveCancel"));
      });
    });
  };
  App.prototype.loadDoc = function (doc, name) {
    doc.name = name || doc.name || "art";
    this.doc = doc;
    this.curLayerIdx = 0;
    this.curFrameIdx = 0;
    this.history.clear();
    this.stopPlayback();
    this.view = new PX.Renderer(this.doc, { pix: this.els.pix, ov: this.els.ov, viewport: this.els.viewport }, this.prefs);
    this.view.curFrame = 0;
    this.view.prefs = this.prefs;
    this.view.prefs.showSel = true;
    this.doc.dirty = true;
    this.syncEverything(true);
    this.toast(PX.t("toasts.docLoaded"));
  };

  function openFileFlow() {
    PX.files.open("*/*").then((f) => {
      if (!f) { app.toast(PX.t("toasts.openCancel")); return; }
      const ext = (f.name || "").split(".").pop().toLowerCase();
      const head = String.fromCharCode.apply(null, f.bytes.subarray(0, Math.min(8, f.bytes.length)));
      const isPng = ext === "png" || head.startsWith("\x89PNG");
      const isGif = ext === "gif" || head.startsWith("GIF8");
      const isJpg = ext === "jpg" || ext === "jpeg" || head.startsWith("\xFF\xD8\xFF");
      const isWebp = ext === "webp";
      if (ext === "pxc" || ext === "json" || f.name.toLowerCase().endsWith(".pxc")) {
        const txt = new TextDecoder().decode(f.bytes);
        try {
          PX.proj.parse(txt).then((doc) => {
            if (doc) app.loadDoc(doc, f.name.replace(/\.pxc$/i, ""));
            else app.toast(PX.t("toasts.emptyProj"));
          });
        } catch (e) { app.toast(PX.t("toasts.badFile")); }
        return;
      }
      if (isPng || isGif || isJpg || isWebp) {
        // ask import mode
        showDlg(PX.t("importImg"), (bd) => {
          bd.appendChild(b("div", { class: "check-row", html: "<input type='radio' name='imp' value='new' checked><label>" + PX.t("importImg") + " (new)" + "</label>" }));
          bd.appendChild(b("div", { class: "check-row", html: "<input type='radio' name='imp' value='layer'><label>" + PX.t("toasts.layerCount") + " (+layer)</label>" }));
        }, [{
          label: PX.t("ok"), primary: true,
          onClick: () => {
            app.closeDlg();
            const mode = (document.querySelector("input[name=imp]:checked") || {}).value || "new";
            importImageBytes(f.bytes, f.name, mode);
          }
        }]);
      } else app.toast(PX.t("toasts.badFile"));
    });
  }
  function importImageBytes(bytes, fname, mode) {
    const blob = new Blob([bytes], { type: "image/png" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const w = img.naturalWidth, h = img.naturalHeight;
      if (mode === "new" || true) {
        if (mode === "layer") {
          // add as layer only if same size
          const d = app.doc;
          if (w !== d.w || h !== d.h) {
            app.toast(PX.t("toasts.importFail"));
            return;
          }
          const li = d.layers.length;
          app.history.struct(PX.t("importImg"), d, () => {
            d.layers.push({ id: PX.U.uid(), name: (fname || "img").replace(/\.[^.]+$/, ""), visible: true, opacity: 100, blend: "normal", locked: false });
            const cel = d.ensureCel(li, app.curFrame());
            const c2 = document.createElement("canvas");
            c2.width = w; c2.height = h;
            const x2 = c2.getContext("2d");
            x2.drawImage(img, 0, 0);
            const dd = x2.getImageData(0, 0, w, h).data;
            cel.data.set(dd);
            app.setCurLayer(li, true);
          });
          app.syncEverything(true);
          app.toast(PX.t("toasts.importOk"));
          return;
        }
        // new doc from image
        const doc = new PX.Doc(w, h, (fname || "img").replace(/\.[^.]+$/, ""));
        doc.layers = [{ id: PX.U.uid(), name: "Layer 1", visible: true, opacity: 100, blend: "normal", locked: false }];
        doc.frames = [{ id: PX.U.uid(), duration: 100 }];
        doc.palette = app.doc.palette.map((c) => c.slice());
        doc.background = null;
        doc.cels = new Map();
        const cel = doc.ensureCel(0, 0);
        const c2 = document.createElement("canvas");
        c2.width = w; c2.height = h;
        const x2 = c2.getContext("2d");
        x2.drawImage(img, 0, 0);
        const dd = x2.getImageData(0, 0, w, h).data;
        cel.data.set(dd);
        app.loadDoc(doc, doc.name);
        app.toast(PX.t("toasts.importOk"));
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); app.toast(PX.t("toasts.importFail")); };
    img.src = url;
  }

  // ---------- Export dialog ----------
  function openExportDlg() {
    let tab = "png", opts = { scale: 1, background: null, cols: 1 };
    const body = showDlg(PX.t("exportMenu"), (bd) => {
      const tabs = b("div", { class: "tabrow" });
      const mk = (id, label) => {
        const t = b("button", { class: "tab" + (id === tab ? " active" : ""), text: label });
        t.onclick = () => { tab = id; rerender(); };
        tabs.appendChild(t);
        return t;
      };
      mk("png", "PNG"); mk("gif", "GIF"); mk("sheet", PX.t("exportSheet"));
      bd.appendChild(tabs);
      function rerender() {
        const optsArea = bd.querySelector(".exp-opts");
        if (optsArea) optsArea.remove();
        const oa = b("div", { class: "exp-opts" });
        oa.appendChild(b("label", { class: "flabel", text: PX.t("scaleExport") }));
        const sc = b("select", {});
        for (const s of [1, 2, 4, 8]) sc.appendChild(b("option", { value: String(s), text: s + "×" }));
        sc.value = String(opts.scale);
        sc.onchange = () => { opts.scale = +sc.value; };
        oa.appendChild(sc);
        if (tab === "gif" || tab === "sheet") {
          oa.appendChild(b("label", { class: "flabel", text: PX.t("transparentBg") }));
          const bgRow = b("div", { class: "tabrow" });
          const o1 = b("button", { class: "tab active", text: PX.t("transparentBg") });
          const o2 = b("button", { class: "tab", text: PX.t("includeBg") });
          o1.onclick = () => { opts.background = null; o1.classList.add("active"); o2.classList.remove("active"); };
          o2.onclick = () => { opts.background = [255, 255, 255, 255]; o2.classList.add("active"); o1.classList.remove("active"); };
          bgRow.appendChild(o1); bgRow.appendChild(o2);
          oa.appendChild(bgRow);
        }
        if (tab === "sheet") {
          oa.appendChild(b("label", { class: "flabel", text: "Columns" }));
          const cols = b("input", { type: "number", min: "1", max: "64", value: String(Math.min(8, app.doc.frames.length)) });
          cols.onchange = () => { opts.cols = Math.max(1, +cols.value || 1); };
          oa.appendChild(cols);
        }
        if (tab === "gif") oa.appendChild(b("div", { class: "dlg-note", text: PX.t("gifNote") }));
        bd.appendChild(oa);
        const btn = bd.querySelector(".exp-do");
        if (btn) btn.remove();
        const doBtn = button("pbtn primary", [icon("i-export"), b("span", { text: PX.t("exportMenu") })], () => doExport());
        doBtn.className += " exp-do";
        bd.appendChild(doBtn);
      }
      function doExport() {
        const doc = app.doc;
        const bg = opts.background;
        if (tab === "png") {
          PX.exportFn.png(doc, { frame: app.curFrame(), background: bg, scale: opts.scale }).then((r) => {
            PX.files.saveBytes(r.name, "image/png", r.bytes, (ok) => app.toast(ok ? PX.t("toasts.exportDone") : PX.t("toasts.saveCancel")));
          });
        } else if (tab === "gif") {
          PX.exportFn.gif(doc, { background: bg, scale: opts.scale }).then((r) => {
            PX.files.saveBytes(r.name, "image/gif", r.bytes, (ok) => app.toast(ok ? PX.t("toasts.exportDone") : PX.t("toasts.saveCancel")));
          });
        } else {
          PX.exportFn.sheet(doc, { background: bg, scale: opts.scale, cols: opts.cols }).then((r) => {
            PX.files.saveBytes(r.name, "image/png", r.png, (ok1) => {
              if (ok1) PX.files.saveBytes(r.jsonName, "application/json", r.json, (ok2) => app.toast(ok2 ? PX.t("toasts.exportDone") : PX.t("toasts.saveCancel")));
              else app.toast(PX.t("toasts.saveCancel"));
            });
          });
        }
      }
      rerender();
    }, [{ label: PX.t("close"), onClick: () => app.closeDlg() }]);
    void body;
  }

  // ---------- Frame duration dialog (long press frame) ----------
  App.prototype.openFrameDlg = function (fi) {
    const d = this.doc;
    const f = d.frames[fi];
    showDlg(PX.t("frames") + " " + (fi + 1), (bd) => {
      bd.appendChild(b("label", { class: "flabel", text: PX.t("frameDur") + " (" + PX.t("durMs") + ")" }));
      const dur = b("input", { type: "number", min: "10", max: "60000", step: "10", value: String(f.duration || 100) });
      bd.appendChild(dur);
      bd.appendChild(b("label", { class: "flabel", text: PX.t("fps") }));
      const fps = Math.round(1000 / (f.duration || 100) * 10) / 10;
      bd.appendChild(b("div", { class: "dlg-note", text: "≈ " + fps + " fps" }));
      const act = b("div", { class: "panel-actions" });
      act.appendChild(button("pbtn small", [icon("i-minus")], () => { if (d.frames.length > 1) { app.frameOp("frameDel", fi); app.closeDlg(); } }));
      act.appendChild(button("pbtn small", [icon("i-dupe")], () => { app.frameOp("frameDupe", fi); app.closeDlg(); }));
      act.appendChild(button("pbtn small", [icon("i-prev")], () => { app.frameOp("frameLeft", fi); app.closeDlg(); }));
      act.appendChild(button("pbtn small", [icon("i-next")], () => { app.frameOp("frameRight", fi); app.closeDlg(); }));
      bd.appendChild(act);
      void dur;
    }, [{
      label: PX.t("confirm"), primary: true,
      onClick: () => {
        const inp = el("dlg").querySelector("input[type=number]");
        app.setFrameDur(fi, inp ? parseInt(inp.value, 10) : 100);
        app.closeDlg();
      }
    }]);
  };

  // ---------- Settings ----------
  function openSettingsDlg() {
    showDlg(PX.t("settings"), (bd) => {
      bd.appendChild(b("label", { class: "flabel", text: PX.t("lang") }));
      const langRow = b("div", { class: "tabrow" });
      const lz = b("button", { class: "tab" + (app.prefs.lang === "zh" ? " active" : ""), text: PX.t("langZh") });
      const le = b("button", { class: "tab" + (app.prefs.lang === "en" ? " active" : ""), text: PX.t("langEn") });
      lz.onclick = () => { app.prefs.lang = "zh"; app.savePrefs(); reloadI18n(); };
      le.onclick = () => { app.prefs.lang = "en"; app.savePrefs(); reloadI18n(); };
      langRow.appendChild(lz); langRow.appendChild(le);
      bd.appendChild(langRow);
      bd.appendChild(b("label", { class: "flabel", text: PX.t("view") }));
      const ck = (label, key) => {
        const row = b("div", { class: "check-row" });
        const cb = b("input", { type: "checkbox" });
        cb.checked = !!app.prefs[key];
        cb.onchange = () => { app.prefs[key] = cb.checked; app.savePrefs(); if (key === "grid") { app.doc.dirty = true; app.invalidate(); } };
        row.appendChild(cb); row.appendChild(b("span", { text: label }));
        bd.appendChild(row);
      };
      ck(PX.t("grid"), "grid");
      ck(PX.t("autosaveNote"), "autosave");
      bd.appendChild(b("div", { class: "dlg-note", text: PX.t("appName") + " v1.0.0 · " + PX.t("appSub") }));
      bd.appendChild(b("div", { class: "dlg-note", html: PX.t("helpText").replace(/\n/g, "<br>") }));
    }, [{ label: PX.t("close"), onClick: () => app.closeDlg() }]);
  }
  function reloadI18n() {
    // refresh all static labels by rebuilding chrome
    document.documentElement.lang = app.prefs.lang;
    app.closePanel();
    app.syncEverything(true);
    rebuildChrome();
  }

  // ---------- menu ----------
  function openMenu() {
    const body = openPanel(PX.t("menu"), (bd) => {
      const mk = (label, iconId, fn, primary) => {
        const r = b("div", { class: "row" });
        r.appendChild(button("pbtn" + (primary ? " primary" : ""), [icon(iconId), b("span", { text: label })], () => { fn(); app.closePanel(); }));
        bd.appendChild(r);
      };
      mk(PX.t("newDoc"), "i-new", openNewDocDlg, true);
      mk(PX.t("save"), "i-save", () => app.saveProject());
      mk(PX.t("open"), "i-open", openFileFlow);
      mk(PX.t("exportMenu"), "i-export", openExportDlg);
      mk(PX.t("layers"), "i-layers", openLayersPanel);
      mk(PX.t("palette"), "i-palette", openPalettePanel);
      mk(PX.t("importImg"), "i-import", openFileFlow);
      mk(PX.t("settings"), "i-gear", openSettingsDlg);
      if (app.doc.selectionActive()) mk(PX.t("sel.active"), "i-select", openSelPanel);
      const clearRow = b("div", { class: "row" });
      clearRow.appendChild(button("pbtn danger", [icon("i-eraser"), b("span", { text: PX.t("clearDoc") })], () => {
        const li = app.curLayer(), fi = app.curFrame();
        const cel = app.doc.celAt(li, fi);
        if (!cel) { app.toast(PX.t("clearDoc")); return; }
        const before = new Uint8ClampedArray(cel.data);
        cel.data.fill(0);
        app.history.pixelChanges(PX.t("clearDoc"), [{ doc: app.doc, li, fi, before, after: new Uint8ClampedArray(cel.data) }]);
        app.invalidate();
        app.closePanel();
      }));
      bd.appendChild(clearRow);
      const helpRow = b("div", { class: "row" });
      helpRow.appendChild(button("pbtn", [icon("i-eye"), b("span", { text: PX.t("helpSheet") })], () => {
        app.closePanel();
        showDlg(PX.t("helpSheet"), (hbd) => hbd.appendChild(b("div", { class: "sheet-tip", text: PX.t("helpText") })), [{ label: PX.t("ok"), primary: true, onClick: () => app.closeDlg() }]);
      }));
      bd.appendChild(helpRow);
    });
    void body;
  }

  // ============================================================ CHROME BUILD
  function rebuildChrome() {
    buildToolRail();
    // right rail
    const rr = app.els.rightrail;
    rr.innerHTML = "";
    const rbtn = (iconId, title, fn, active) => {
      const b2 = button("rr-btn" + (active ? " active" : ""), [icon(iconId)], fn);
      b2.title = title;
      rr.appendChild(b2);
      return b2;
    };
    rbtn("i-layers", PX.t("layers"), openLayersPanel);
    rbtn("i-palette", PX.t("palette"), openPalettePanel);
    rbtn("i-export", PX.t("exportMenu"), openExportDlg);
    if (app._chromeBound) {
      app.syncEverything(true);
      return;
    }
    app._chromeBound = true;
    // color chip button opens palette
    app.els.colorchip.addEventListener("click", openPalettePanel);
    // brush size
    app.els.brushsize.addEventListener("input", () => {
      app.brushSize = Math.max(1, +app.els.brushsize.value);
      app.els.bsLabel.textContent = app.brushSize;
      if (app.view) { app.view.drawOverlay(); }
    });
    // top bar
    const A = app;
    A.els.btnMenu.addEventListener("click", openMenu);
    A.els.btnUndo.addEventListener("click", () => A.undo());
    A.els.btnRedo.addEventListener("click", () => A.redo());
    A.els.btnSave.addEventListener("click", () => A.saveProject());
    A.els.btnLayers.addEventListener("click", openLayersPanel);
    A.els.btnPalette.addEventListener("click", openPalettePanel);
    // timeline buttons
    A.els.tlPlay.addEventListener("click", () => A.togglePlay());
    A.els.tlFirst.addEventListener("click", () => A.setCurFrame(0));
    A.els.tlNext.addEventListener("click", () => {
      const fi = A.curFrame() + 1;
      if (fi < A.doc.frames.length) A.setCurFrame(fi);
    });
    A.els.tlAdd.addEventListener("click", () => A.frameOp("frameAdd"));
    A.els.tlDupe.addEventListener("click", () => A.frameOp("frameDupe"));
    A.els.tlDel.addEventListener("click", () => { if (A.doc.frames.length > 1) A.frameOp("frameDel"); });
    A.els.tlOnion.addEventListener("click", () => A.cycleOnion());
    A.els.tlOnion.classList.toggle("active", A.prefs.onion > 0);
    // view resize
    const doResize = () => { if (A.view) { A.view.resize(); A.syncZoomUI(); } };
    window.addEventListener("resize", doResize);
    window.addEventListener("orientationchange", () => setTimeout(doResize, 250));
    // gestures
    bindGestures();
    A.syncEverything(true);
    // layout settle: canvas must get real dimensions after bars/fonts lay out
    const doLayout = () => {
      try { window.scrollTo(0, 0); document.documentElement.scrollLeft = 0; document.body.scrollLeft = 0; } catch (e) { }
      if (A.view) { A.view.curFrame = A.curFrame(); A.view.resize(); A.syncZoomUI(); }
    };
    [40, 120, 400, 1000].forEach((t) => setTimeout(doLayout, t));
    window.addEventListener("load", doLayout);
  }

  // boot
  function boot() {
    window.addEventListener("error", (e) => {
      try {
        const msg = "JS: " + (e.message || String(e.error || "error")).slice(0, 140);
        if (window.PX && PX.app) { PX.app.toast(msg); }
        else { console.error(msg); }
        try {
          const prev = JSON.parse(localStorage.getItem("pc.errlog") || "[]");
          prev.push({ t: Date.now(), m: msg });
          localStorage.setItem("pc.errlog", JSON.stringify(prev.slice(-5)));
        } catch (err) { }
      } catch (err) { }
    });
    const lang = (navigator.language || "").startsWith("zh") ? "zh" : "en";
    if (!app.prefs.lang) { app.prefs.lang = lang; PX.setLang(lang); }
    document.documentElement.lang = app.prefs.lang === "zh" ? "zh-CN" : "en";
    // default document (all prototype methods are defined by now)
    app.newDoc(64, 64, "untitled", null);
    rebuildChrome();
    // autosave restore
    try {
      const saved = localStorage.getItem("pc.autosave");
      if (saved && saved.length > 100) {
        PX.proj.parse(saved).then((doc) => {
          if (doc) {
            app.loadDoc(doc, doc.name || "untitled");
            app.toast(PX.t("toasts.docLoaded") + " (auto)");
          }
        }).catch(() => { });
      }
    } catch (e) { }
  }
  boot();
  window.__tel && window.__tel("boot-done", "main.js finished");
})();

