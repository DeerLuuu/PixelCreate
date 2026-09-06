/* PixelCraft files: bridge IO, project serialization, PNG/GIF/sheet export */
(function () {
  const PX = window.PX = window.PX || {};

  const bridge = () => (window.PixelBridge ? window.PixelBridge : null);

  function b64FromBytes(bytes) {
    // base64 encode binary string via FileReader is async; use manual chunk loop
    const CH = 0x8000;
    let bin = "";
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(bin);
  }
  function bytesFromB64(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesFromDataURL(dataURL) {
    const i = dataURL.indexOf(",");
    return bytesFromB64(dataURL.slice(i + 1));
  }
  function dataURLFromBytes(bytes, mime) {
    return "data:" + mime + ";base64," + b64FromBytes(bytes);
  }

  PX.files = {
    isAndroid() { return !!bridge(); },
    bridge,

    // Save Uint8Array through SAF (Android) or download (web)
    saveBytes(name, mime, bytes, onDone) {
      const b = bridge();
      if (b) {
        PX.files._once("pcsave", (d) => { onDone && onDone(d && d.ok, d || {}); });
        try {
          b.saveFile(name, mime, b64FromBytes(bytes), "");
        } catch (e) { onDone && onDone(false, { err: "js" }); }
      } else {
        // web fallback download
        const a = document.createElement("a");
        a.href = dataURLFromBytes(bytes, mime);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => a.remove(), 500);
        onDone && onDone(true, {});
      }
    },
    _once(name, cb) {
      const h = (e) => { window.removeEventListener(name, h); cb(e.detail || {}); };
      window.addEventListener(name, h);
      return { name, h };
    },

    // Open file via SAF (Android) or <input> (web). Returns Promise<{name,bytes,mime}>
    open(mime) {
      return new Promise((resolve, reject) => {
        const b = bridge();
        if (b) {
          const h = (e) => {
            window.removeEventListener("pcopen", h);
            const d = e.detail || {};
            if (d.ok && d.data) {
              resolve({ name: d.name || "file", mime: d.mime || mime, bytes: bytesFromB64(d.data) });
            } else resolve(null);
          };
          window.addEventListener("pcopen", h);
          try { b.openFile(mime || "*/*"); } catch (e) { resolve(null); }
        } else {
          const inp = document.createElement("input");
          inp.type = "file";
          inp.accept = mime || "*/*";
          inp.onchange = () => {
            const f = inp.files && inp.files[0];
            if (!f) return resolve(null);
            const fr = new FileReader();
            fr.onload = () => resolve({ name: f.name, mime: f.type || "application/octet-stream", bytes: new Uint8Array(fr.result) });
            fr.onerror = () => resolve(null);
            fr.readAsArrayBuffer(f);
          };
          inp.click();
        }
      });
    },

    toast(msg) { const b = bridge(); if (b) b.toast(String(msg)); }
  };

  // ---------- pixel<->canvas helpers ----------
  PX.pix = {
    canvasFromCel(cel) {
      const c = document.createElement("canvas");
      c.width = cel.w; c.height = cel.h;
      c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(cel.data), cel.w, cel.h), 0, 0);
      return c;
    },
    pngBytes(canvas) {
      return new Promise((res) => canvas.toBlob((bl) => {
        if (!bl) return res(null);
        bl.arrayBuffer().then((ab) => res(new Uint8Array(ab)));
      }, "image/png"));
    },
    // compose a frame (optionally with background color, scale)
    composeFrame(doc, fi, opts) {
      opts = opts || {};
      const w = doc.w, h = doc.h;
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const x = c.getContext("2d");
      if (opts.background) {
        x.fillStyle = PX.U.cssColor(opts.background);
        x.fillRect(0, 0, w, h);
      }
      for (let li = 0; li < doc.layers.length; li++) {
        const L = doc.layers[li];
        if (!L.visible) continue;
        const cel = doc.celAt(li, fi);
        if (!cel) continue;
        x.globalAlpha = L.opacity / 100;
        x.globalCompositeOperation = PX.blendToCanvas(L.blend);
        x.drawImage(PX.pix.canvasFromCel(cel), 0, 0);
      }
      x.globalAlpha = 1; x.globalCompositeOperation = "source-over";
      let out = c;
      const sc = opts.scale || 1;
      if (sc > 1) {
        out = document.createElement("canvas");
        out.width = w * sc; out.height = h * sc;
        const ox = out.getContext("2d");
        ox.imageSmoothingEnabled = false;
        ox.drawImage(c, 0, 0, out.width, out.height);
      }
      return out;
    },
    frameRGBA(doc, fi, opts) {
      const c = PX.pix.composeFrame(doc, fi, opts);
      return { w: c.width, h: c.height, data: c.getContext("2d").getImageData(0, 0, c.width, c.height).data };
    }
  };

  // ---------- project serialize / parse ----------
  PX.proj = {
    async encodeCelPNG(cel) {
      // returns dataURL
      let any = false;
      for (let i = 3; i < cel.data.length; i += 4) if (cel.data[i]) { any = true; break; }
      if (!any) return null;
      const bytes = await PX.pix.pngBytes(PX.pix.canvasFromCel(cel));
      if (!bytes) return null;
      return dataURLFromBytes(bytes, "image/png");
    },
    async serialize(doc) {
      const cels = [];
      for (const [k, cel] of doc.cels) {
        if (!cel) continue;
        const png = await PX.proj.encodeCelPNG(cel);
        if (png) cels.push([k, png]);
      }
      return JSON.stringify({
        app: "PixelCraft", v: 1,
        name: doc.name, w: doc.w, h: doc.h,
        background: doc.background ? doc.background.slice() : null,
        layers: doc.layers.map((l) => ({ name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend, locked: l.locked })),
        frames: doc.frames.map((f) => ({ duration: f.duration })),
        palette: doc.palette.map((c) => c.slice()),
        cels
      });
    },
    async decodeCelPNG(dataURL, w, h) {
      return new Promise((res) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement("canvas");
          c.width = img.naturalWidth || w; c.height = img.naturalHeight || h;
          const x = c.getContext("2d");
          x.clearRect(0, 0, c.width, c.height);
          x.drawImage(img, 0, 0);
          try {
            const d = x.getImageData(0, 0, c.width, c.height).data;
            res({ w: c.width, h: c.height, data: new Uint8ClampedArray(d) });
          } catch (e) { res(null); }
        };
        img.onerror = () => res(null);
        img.src = dataURL;
      });
    },
    async parse(text) {
      const o = JSON.parse(text);
      if (o.app !== "PixelCraft" || !o.w || !o.h) return null;
      const doc = new PX.Doc(o.w, o.h, o.name || "untitled");
      doc.layers = (o.layers || []).map((l) => Object.assign({ id: PX.U.uid(), name: "Layer", visible: true, opacity: 100, blend: "normal", locked: false }, l));
      doc.frames = (o.frames || []).map((f) => Object.assign({ id: PX.U.uid(), duration: 100 }, f));
      if (!doc.layers.length) doc.layers.push({ id: PX.U.uid(), name: "Layer 1", visible: true, opacity: 100, blend: "normal", locked: false });
      if (!doc.frames.length) doc.frames.push({ id: PX.U.uid(), duration: 100 });
      doc.background = o.background ? o.background.slice() : null;
      doc.palette = (o.palette || []).map((c) => c.slice());
      doc.cels = new Map();
      for (const [k, png] of o.cels || []) {
        const px = await PX.proj.decodeCelPNG(png, doc.w, doc.h);
        if (px) {
          const cel = new PX.Cel(doc.w, doc.h);
          cel.data.set(px.data.length >= cel.data.length ? px.data.subarray(0, cel.data.length) : px.data);
          doc.cels.set(k, cel);
        }
      }
      return doc;
    }
  };

  // ---------- exports ----------
  PX.exportFn = {
    async png(doc, opts) {
      const c = PX.pix.composeFrame(doc, opts.frame || 0, { background: opts.background || null, scale: opts.scale || 1 });
      return { bytes: await PX.pix.pngBytes(c), name: (doc.name || "art").replace(/[^\w\u4e00-\u9fa5-]+/g, "_") + "_f" + ((opts.frame || 0) + 1) + ".png" };
    },
    async gif(doc, opts) {
      const frames = [];
      for (let fi = 0; fi < doc.frames.length; fi++) {
        const f = PX.pix.composeFrame(doc, fi, { background: opts.background || null });
        const d = f.getContext("2d").getImageData(0, 0, f.width, f.height).data;
        frames.push({ data: d, delayMs: doc.frames[fi].duration || 100 });
      }
      let bytes;
      if (opts.scale && opts.scale > 1) {
        const raw = PX.encodeGIF(frames, doc.w, doc.h, { transparent: opts.background == null });
        // decode into image then scale & re-encode for simplicity
        const blob = new Blob([raw], { type: "image/gif" });
        const url = URL.createObjectURL(blob);
        const img = await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = url; });
        URL.revokeObjectURL(url);
        if (!img) return { bytes: raw, name: gifName(doc) };
        const c = document.createElement("canvas");
        c.width = doc.w * opts.scale; c.height = doc.h * opts.scale;
        const x = c.getContext("2d");
        x.imageSmoothingEnabled = false;
        // draw each frame manually to re-encode at scale
        const frames2 = [];
        const g = new Image();
        for (let fi = 0; fi < doc.frames.length; fi++) {
          const src = PX.pix.composeFrame(doc, fi, { background: opts.background || null });
          const c2 = document.createElement("canvas");
          c2.width = c.width; c2.height = c.height;
          const x2 = c2.getContext("2d");
          x2.imageSmoothingEnabled = false;
          x2.drawImage(src, 0, 0, c2.width, c2.height);
          frames2.push({ data: x2.getImageData(0, 0, c2.width, c2.height).data, delayMs: doc.frames[fi].duration || 100 });
        }
        bytes = PX.encodeGIF(frames2, c.width, c.height, { transparent: opts.background == null });
      } else {
        bytes = PX.encodeGIF(frames, doc.w, doc.h, { transparent: opts.background == null });
      }
      return { bytes, name: gifName(doc) };
    },
    async sheet(doc, opts) {
      const cols = Math.min(doc.frames.length, Math.max(1, opts.cols || doc.frames.length));
      const rows = Math.ceil(doc.frames.length / cols);
      const sc = opts.scale || 1;
      const c = document.createElement("canvas");
      c.width = doc.w * cols * sc; c.height = doc.h * rows * sc;
      const x = c.getContext("2d");
      x.imageSmoothingEnabled = false;
      for (let fi = 0; fi < doc.frames.length; fi++) {
        const fr = PX.pix.composeFrame(doc, fi, { background: opts.background || null, scale: sc });
        const col = fi % cols, row = Math.floor(fi / cols);
        x.drawImage(fr, col * doc.w * sc, row * doc.h * sc);
      }
      const frames = [];
      for (let fi = 0; fi < doc.frames.length; fi++) {
        frames.push({
          filename: (doc.name || "art").replace(/[^\w\u4e00-\u9fa5-]+/g, "_") + "_" + (fi + 1) + ".png",
          frame: { x: (fi % cols) * doc.w * sc, y: Math.floor(fi / cols) * doc.h * sc, w: doc.w * sc, h: doc.h * sc },
          duration: doc.frames[fi].duration
        });
      }
      const meta = { frames, meta: { app: "PixelCraft", version: "1.0", image: (doc.name || "art") + "_sheet.png", size: { w: c.width, h: c.height }, scale: sc, frameTags: [] } };
      const base = (doc.name || "art").replace(/[^\w\u4e00-\u9fa5-]+/g, "_");
      return { png: await PX.pix.pngBytes(c), json: new TextEncoder().encode(JSON.stringify(meta, null, 1)), name: base + "_sheet.png", jsonName: base + "_sheet.json" };
    }
  };
  function gifName(doc) { return (doc.name || "art").replace(/[^\w\u4e00-\u9fa5-]+/g, "_") + ".gif"; }
})();
