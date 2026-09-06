/* Headless boot test: stub DOM enough to run all www scripts and catch errors. */
const fs = require("fs");
const path = require("path");

const WWW = "/storage/emulated/0/Download/ds文件夹/pixelcraft/app/www";

function makeEl(tag) {
  const cls = new Set();
  const listeners = {};
  const elObj = {
    tagName: (tag || "div").toUpperCase(),
    children: [],
    style: {},
    dataset: {},
    parentNode: null,
    _text: "",
    attrs: {},
    clientWidth: 800,
    clientHeight: 640,
    value: "",
    selected: false,
    checked: false,
    type: "",
    get className() { return [...cls].join(" "); },
    set className(v) { cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => cls.add(c)); },
    classList: {
      add: (...cs) => cs.forEach((c) => cls.add(c)),
      remove: (...cs) => cs.forEach((c) => cls.delete(c)),
      toggle: (c, force) => { const on = force === undefined ? !cls.has(c) : !!force; on ? cls.add(c) : cls.delete(c); return on; },
      contains: (c) => cls.has(c),
    },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    replaceChildren() { this.children.length = 0; },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { if (listeners[t]) listeners[t] = listeners[t].filter((f) => f !== fn); },
    dispatchEvent(ev) {
      ev.target = this;
      if (listeners[ev.type]) for (const f of listeners[ev.type].slice()) f.call(this, ev);
      return true;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    scrollIntoView() { },
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === "class") this.className = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    focus() { },
    click() { this.dispatchEvent({ type: "click", stopPropagation() { }, preventDefault() { }, target: this }); },
    set innerHTML(v) { this.children.length = 0; this._html = String(v); },
    get innerHTML() { return this._html || ""; },
    set textContent(v) { this._text = String(v); },
    get textContent() { return this._text; },
    title: "",
    id: "",
  };
  elObj.getContext = () => ctxStub(elObj);
  elObj.toBlob = (cb) => cb(new (require("buffer").Blob ? require("buffer").Blob : (typeof Blob!=="undefined"?Blob:Object))([new Uint8Array([1,2,3])], { type: "image/png" }));
  elObj.toDataURL = () => "data:image/png;base64,";
  return elObj;
}

function ctxStub(canvas) {
  const c = {
    canvas,
    globalAlpha: 1, globalCompositeOperation: "source-over", fillStyle: "", strokeStyle: "", lineWidth: 1, lineDashOffset: 0,
    imageSmoothingEnabled: false,
    setLineDash() { }, beginPath() { }, moveTo() { }, lineTo() { }, stroke() { }, fill() { }, fillRect() { }, strokeRect() { },
    clearRect() { }, drawImage() { }, save() { }, restore() { }, translate() { }, scale() { }, rotate() { },
    arc() { }, rect() { }, closePath() { },
    putImageData() { }, createPattern() { return "pat"; },
    createImageData() { return { data: new Uint8ClampedArray(4), width: 1, height: 1 }; },
    getImageData() { return { data: new Uint8ClampedArray([0, 0, 0, 255]), width: 1, height: 1 }; },
    setTransform() { }, resetTransform() { },
    measureText() { return { width: 0 }; },
    fillText() { }, strokeText() { },
  };
  return c;
}

function main() {
  const listeners = {};
  const windowObj = {
    PX: undefined,
    PixelBridge: { toast: (m) => { console.log("[bridge toast]", m); }, saveFile() { }, openFile() { }, keepAwake() { }, vibrate() { } },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener() { },
    dispatchEvent() { },
    localStorage: { _s: {}, getItem(k) { return k in this._s ? this._s[k] : null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } },
    navigator: { language: "zh-CN" },
    devicePixelRatio: 1,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = (opts || {}).detail; } },
    ImageData: class { constructor(d, w, h) { this.data = d || new Uint8ClampedArray(4); this.width = w; this.height = h; } },
    Image: class { set src(v) { } addEventListener() { } },
    Blob: (function(){ class B { constructor(parts,opts){ this._p=parts; } arrayBuffer(){ return Promise.resolve(new Uint8Array([1,2,3]).buffer); } } return B; })(),
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() { } },
    btoa, atob,
    TextEncoder, TextDecoder,
    FileReader: class { },
    console,
  };
  // ids referenced by main.js
  const ids = "brushsize brushsize-label btn-layers btn-menu btn-palette btn-redo btn-save btn-undo colorchip dlg dlg-mask doc-title framestrip layer-badge ovcanvas panel panel-mask pixcanvas rightrail statusbar tl-add tl-del tl-dupe tl-first tl-next tl-onion tl-play toolrail viewport zoomhud".split(" ");
  const store = {};
  const getEl = (id) => (store[id] = store[id] || Object.assign(makeEl("div"), { id }));
  const documentObj = {
    getElementById: getEl,
    createElement(tag) { return makeEl(tag); },
    createElementNS: (ns, tag) => makeEl(tag),
    documentElement: { lang: "", style: {} },
    body: makeEl("body"),
    title: "",
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
  };

  // expose to running scripts as globals
  for (const k of ["window", "document", "localStorage", "navigator", "ImageData", "Image", "Blob", "URL", "FileReader", "btoa", "atob", "TextEncoder", "TextDecoder", "CustomEvent", "requestAnimationFrame", "console", "devicePixelRatio"])
    global[k] = windowObj[k] || documentObj[k] || global[k];
  global.window = windowObj;
  global.document = documentObj;
  global.devicePixelRatio = 1;
  global.CustomEvent = windowObj.CustomEvent;
  global.ImageData = windowObj.ImageData;
  global.Image = windowObj.Image;
  global.localStorage = windowObj.localStorage;
  global.navigator = windowObj.navigator;

  // track window error handler to re-raise
  windowObj.onerrorCapture = null;
  const origAdd = windowObj.addEventListener;
  windowObj.addEventListener = function (t, fn) { if (t === "error") windowObj.onerrorCapture = fn; origAdd.call(this, t, fn); };

  process.on("uncaughtException", (e) => { console.error("UNCAUGHT:", e && e.stack || e); process.exit(3); });

  const order = ["js/i18n.js", "js/core.js", "js/lib/omggif.js", "js/gifenc.js", "js/render.js", "js/tools.js", "js/files.js", "js/main.js"];
  for (const f of order) {
    const code = fs.readFileSync(path.join(WWW, f), "utf8");
    try {
      require(path.join(WWW, f)); // direct require works since scripts use globals set above? they reference window/document -> global window set -> ok
    } catch (e) {
      console.error("SCRIPT FAILED [" + f + "]:", e && e.stack || e);
      process.exit(2);
    }
    void code;
  }
  // omggif declares a bare global; make it visible for encodeGIF in node
  if (typeof global.GifWriter === "undefined") {
    const vm = require("vm");
    vm.runInThisContext(fs.readFileSync("/storage/emulated/0/Download/ds文件夹/pixelcraft/app/www/js/lib/omggif.js", "utf8"));
  }
  // wait timers (doLayout etc)
  setTimeout(() => {
    const app = windowObj.PX && windowObj.PX.app;
    if (!app) { console.error("PX.app missing"); process.exit(4); }
    const rail = getEl("toolrail");
    console.log("boot OK: toolrail children =", rail.children.length, "| doc =", app.doc.w + "x" + app.doc.h, "| layers =", app.doc.layers.length);
    // simulate clicking top menu button & palette & undo
    for (const id of ["btn-menu", "btn-palette", "btn-undo", "tl-add"]) {
      try {
        getEl(id).click();
        console.log("click", id, "OK (no throw)");
      } catch (e) {
        console.error("click", id, "THREW:", e.stack || e);
      }
    }
    try { app.setColor([255, 0, 0, 255]); console.log("setColor OK"); } catch (e) { console.error("setColor THREW", e); }
    // simulate a stroke (no gesture wiring possible via stubs; call internals directly)
    try {
      const st = new windowObj.PX.Stroke(app, "pencil", 10, 10);
      st.mark(20, 20, 1);
      st.commit();
      const cel = app.doc.celAt(0, 0);
      let n = 0; if (cel) for (let i = 3; i < cel.data.length; i += 4) if (cel.data[i]) n++;
      console.log("stroke painted pixels:", n, "| history:", app.history.canUndo() ? "undoable" : "empty");
      if (n === 0) console.error("!! stroke produced no pixels");
      // undo / redo
      app.undo();
      const afterUndo = app.doc.celAt(0, 0);
      let n2 = 0; if (afterUndo) for (let i = 3; i < afterUndo.data.length; i += 4) if (afterUndo.data[i]) n2++;
      console.log("after undo painted pixels:", n2);
      app.redo();
      console.log("after redo history:", app.history.canUndo() ? "ok" : "!empty", "| undo-stack:", app.history.stack.length);
      // shape tool via Stroke
      const st2 = new windowObj.PX.Stroke(app, "rectfill", 5, 5);
      st2.mark(12, 12, 1);
      st2.commit();
      console.log("rectfill committed, stack len:", app.history.stack.length);
    } catch (e) { console.error("stroke THREW", e.stack || e); }

    // structural ops
    try {
      app.frameOp("frameAdd");
      app.frameOp("frameDupe");
      app.setCurFrame(1, true);
      const st3 = new windowObj.PX.Stroke(app, "pencil", 3, 3);
      st3.mark(4, 4, 1); st3.commit();
      console.log("frames now:", app.doc.frames.length, "| cur:", app.curFrame());
      app.layerOp("add");
      app.layerOp("dupe");
      console.log("layers now:", app.doc.layers.length);
      app.layerOp("up", 2);
      console.log("layer order ok:", app.doc.layers.map(l => l.name).join(","));
      app.layerOp("merge", 1);
      console.log("layers after merge:", app.doc.layers.length);
      app.undo(); app.undo(); app.redo(); // exercise struct undo path
      console.log("struct undo/redo OK, stack:", app.history.stack.length);
    } catch (e) { console.error("struct THREW", e.stack || e); }

    const PX = windowObj.PX;
    // selection
    try {
      const d = app.doc;
      if (!d.sel) d.sel = new windowObj.PX.Sel(d.w, d.h, false);
      for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) d.sel.set(x, y, 1);
      const b = PX.selOps.bounds(app);
      console.log("sel bounds:", b && (b.x + "," + b.y + " " + b.w + "x" + b.h));
      PX.selOps.fill(app);
      PX.selOps.copy(app);
      console.log("clip present:", !!app.clip);
      PX.selOps.cut(app);
      PX.selOps.paste(app);
      PX.selOps.flip(app, true);
      PX.selOps.clearMask(app);
      app.invalidate();
      console.log("selection ops OK");
    } catch (e) { console.error("selection THREW", e.stack || e); }

    // gif + project roundtrip
    (async () => {
      try {
        const g = PX.encodeGIF([{ data: app.doc.celAt(0, 0) ? app.doc.celAt(0, 0).data : new Uint8ClampedArray(4), delayMs: 100 }], app.doc.w, app.doc.h, { transparent: true });
        console.log("GIF bytes:", g && g.length, g && g[0], g && g[1], g && g[2]);
        const ser = await PX.proj.serialize(app.doc);
        console.log("serialize len:", ser.length);
        const doc2 = await PX.proj.parse(ser);
        console.log("parse roundtrip ok:", !!doc2, doc2 && doc2.w + "x" + doc2.h, "cels:", doc2 && doc2.cels.size);
        const pngRes = await PX.exportFn.png(app.doc, { frame: app.curFrame(), scale: 2 });
        console.log("png export bytes:", pngRes && pngRes.bytes && pngRes.bytes.length, pngRes && pngRes.name);
      } catch (e) { console.error("async THREW", e.stack || e); }
      process.exit(0);
    })();
  }, 300);
}
main();
