/* GIF encoder built on omggif (lib/omggif.js) + own median-cut palette */
(function () {
  const PX = window.PX = window.PX || {};

  // median-cut quantization of [r,g,b] pixels into maxColors
  function medianCut(colors, maxColors) {
    const boxes = [colors];
    const split = (box) => {
      if (box.length < 2) return null;
      let r0 = 255, r1 = 0, g0 = 255, g1 = 0, b0 = 255, b1 = 0;
      for (const c of box) {
        if (c[0] < r0) r0 = c[0]; if (c[0] > r1) r1 = c[0];
        if (c[1] < g0) g0 = c[1]; if (c[1] > g1) g1 = c[1];
        if (c[2] < b0) b0 = c[2]; if (c[2] > b1) b1 = c[2];
      }
      const rl = r1 - r0, gl = g1 - g0, bl = b1 - b0;
      let axis = rl >= gl && rl >= bl ? 0 : gl >= bl ? 1 : 2;
      box.sort((a, b) => a[axis] - b[axis]);
      const half = box.length >> 1;
      if (half === 0) return null;
      return [box.slice(0, half), box.slice(half)];
    };
    while (boxes.length < maxColors) {
      let bi = -1, blen = -1;
      for (let i = 0; i < boxes.length; i++) if (boxes[i].length > blen) { blen = boxes[i].length; bi = i; }
      if (bi < 0) break;
      const parts = split(boxes[bi]);
      if (!parts) break;
      boxes.splice(bi, 1, parts[0], parts[1]);
    }
    return boxes.map((b) => {
      let r = 0, g = 0, gg = 0, bb = 0;
      for (const c of b) { r += c[0]; g += c[1]; bb += c[2]; }
      return [r / b.length | 0, g / b.length | 0, bb / b.length | 0];
    });
  }

  // frames: [{data: RGBA Uint8ClampedArray, delayMs}], opts {transparent}
  // returns Uint8Array GIF bytes (palette sized <=256 incl transparent slot)
  PX.encodeGIF = function (frames, w, h, opts) {
    opts = opts || {};
    const useTrans = opts.transparent !== false;
    const hasT = useTrans && frames.some((f) => { const d = f.data; for (let i = 3; i < d.length; i += 4) if (d[i] < 128) return true; return false; });

    const seen = new Set();
    const colors = [];
    const keyOf = (r, g, b) => (r << 16) | (g << 8) | b;
    const addColor = (r, g, b) => { const k = keyOf(r, g, b); if (!seen.has(k)) { seen.add(k); colors.push([r, g, b]); } };

    for (const f of frames) {
      const d = f.data;
      for (let i = 0; i < d.length; i += 4) {
        if (useTrans && d[i + 3] < 128) continue;
        addColor(d[i], d[i + 1], d[i + 2]);
      }
    }
    let palette;
    const cap = hasT ? 255 : 256;
    if (colors.length <= cap) palette = colors;
    else palette = medianCut(colors, cap);

    // nearest-color map using 5-5-5 lattice + refinement
    const table = new Int16Array(1 << 15).fill(-1);
    const fillNeighbors = (i, c) => {
      const r5 = c[0] >> 3, g5 = c[1] >> 3, b5 = c[2] >> 3;
      for (let dr = -1; dr <= 1; dr++) for (let dg = -1; dg <= 1; dg++) for (let db = -1; db <= 1; db++) {
        const rr = r5 + dr, gg = g5 + dg, bb = b5 + db;
        if (rr < 0 || rr > 31 || gg < 0 || gg > 31 || bb < 0 || bb > 31) continue;
        const ci = (rr << 10) | (gg << 5) | bb;
        if (table[ci] < 0) table[ci] = i;
      }
    };
    for (let i = 0; i < palette.length; i++) fillNeighbors(i, palette[i]);
    const mapFn = (r, g, b) => {
      let best = table[((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)];
      if (best < 0) best = 0;
      const pc = palette[best];
      let dmin = (pc[0] - r) * (pc[0] - r) + (pc[1] - g) * (pc[1] - g) + (pc[2] - b) * (pc[2] - b);
      const n = Math.min(palette.length, 64);
      for (let i = 0; i < n; i++) {
        const c = palette[i];
        const dr = c[0] - r, dg = c[1] - g, db = c[2] - b;
        const d = dr * dr + dg * dg + db * db;
        if (d < dmin) { dmin = d; best = i; }
      }
      return best;
    };

    const palInt = palette.map((c) => (c[0] << 16) | (c[1] << 8) | c[2]);
    const TI = hasT ? palette.length : undefined; // transparent slot
    if (hasT) palInt.push(0);

    // rough capacity: header+gct+ per-frame overhead + indexes with LZW inflation
    const perFrame = w * h * 2 + 64;
    const buf = new Uint8Array(4096 + perFrame * frames.length);
    const g = new GifWriter(buf, w, h, { palette: palInt, loop: 0 });
    for (const f of frames) {
      const d = f.data;
      const idx = new Uint8Array(w * h);
      for (let i = 0, j = 0; i < d.length; i += 4, j++) {
        if (hasT && d[i + 3] < 128) idx[j] = TI;
        else idx[j] = mapFn(d[i], d[i + 1], d[i + 2]);
      }
      g.addFrame(0, 0, w, h, idx, {
        delay: Math.max(1, Math.min(6553, Math.round((f.delayMs || 100) / 10))),
        transparent: TI,
        disposal: 2
      });
    }
    const len = g.end();
    return buf.subarray(0, len);
  };
})();
