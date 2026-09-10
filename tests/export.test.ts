// Export option helpers: the frame range has to clamp and auto-swap so a
// typed-in range can never produce an empty or out-of-bounds export.
import { encodeGIF, exportBudgetError, frameRange, MAX_IMAGE_PIXELS, MAX_LAYER_FILES } from "../src/io/exporters";
import { eq, ok } from "./common";

declare const require: (m: string) => {
  readFileSync: (p: string, enc: string) => string;
  resolve: (...p: string[]) => string;
  existsSync?: (p: string) => boolean;
};
declare const __dirname: string;

/** the real omggif writer + reader from app2/www (the stub writer hid bugs) */
function realGif(): { GifWriter: unknown; GifReader: new (b: Uint8Array) => {
  numFrames(): number;
  frameInfo(i: number): { width: number; height: number };
  decodeAndBlitFrameRGBA(i: number, px: Uint8Array | Uint8ClampedArray): void;
} } | null {
  const fs = require("fs");
  const path = require("path");
  // walk up from the compiled test dir until app2/www/js/lib/omggif.js is found,
  // so the same test works in the repo and in the container build copy
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const p = path.resolve(dir, "app2/www/js/lib/omggif.js");
    if (fs.existsSync ? fs.existsSync(p) : false) {
      const src = fs.readFileSync(p, "utf8");
      // eslint-disable-next-line no-new-func
      return new Function(src + "\n;return { GifWriter: GifWriter, GifReader: GifReader };")();
    }
    dir = path.resolve(dir, "..");
  }
  return null;
}

export function testExport(): void {
  eq("exp.range.default", frameRange({}, 5), { from: 0, to: 4, n: 5 });
  eq("exp.range.null", frameRange({ range: null }, 5), { from: 0, to: 4, n: 5 });
  eq("exp.range.sub", frameRange({ range: [2, 4] }, 5), { from: 2, to: 4, n: 3 });
  eq("exp.range.single", frameRange({ range: [1, 1] }, 5), { from: 1, to: 1, n: 1 });
  eq("exp.range.swapped", frameRange({ range: [4, 2] }, 5), { from: 2, to: 4, n: 3 });
  eq("exp.range.clamped", frameRange({ range: [-3, 99] }, 5), { from: 0, to: 4, n: 5 });
  eq("exp.range.over", frameRange({ range: [9, 12] }, 5), { from: 4, to: 4, n: 1 });
  eq("exp.range.one-frame", frameRange({ range: [3, 3] }, 1), { from: 0, to: 0, n: 1 });
  eq("exp.range.rounded", frameRange({ range: [1.4, 2.6] }, 5), { from: 1, to: 3, n: 3 });

  // --- ⑧ 导出预算闸门：超大导出必须在点之前就被拦住 ---
  // （旧版没有这道闸：8× 放大的精灵表会去 new 一个上亿像素的 canvas，把系统拖死）
  ok("exp.budget.cap", MAX_IMAGE_PIXELS === 16 * 1024 * 1024 && MAX_LAYER_FILES === 12);
  eq("exp.budget.image-ok", exportBudgetError(512, 512, 4, 1, "image"), null);
  eq("exp.budget.image-too-big", exportBudgetError(1024, 1024, 8, 1, "image"), "tooBigImage");
  eq("exp.budget.anim-ok", exportBudgetError(64, 64, 8, 30, "anim"), null);
  eq("exp.budget.anim-too-big", exportBudgetError(512, 512, 8, 20, "anim"), "tooBigAnim");
  // 单帧图片超限优先报图片（而不是动画）那条
  eq("exp.budget.image-first", exportBudgetError(4096, 4096, 2, 10, "anim"), "tooBigImage");
  eq("exp.budget.scale-floor", exportBudgetError(64, 64, 0, 1, "image"), null);

  // --- GIF 端到端（真 omggif）：调色板长度必须是 2 的幂，否则 GifWriter 直接抛
  //     "Invalid code/color length"——以前 3 / 5 / 7 个颜色的图都导不出来 ---
  {
    const g = globalThis as unknown as { window: Record<string, unknown> };
    const prev = g.window.GifWriter;
    const mod = realGif();
    if (!mod) {
      // 构建副本里没有 app2/www 时跳过（真机/仓库里总会跑到）
      ok("gif.palette.skipped", true, "app2/www/js/lib/omggif.js not reachable");
      return;
    }
    g.window.GifWriter = mod.GifWriter;
    try {
      // 16×16：每个像素按顺序取一种颜色，保证 n 种颜色**真的都出现在图里**
      // （4×4 只能容纳 4 种，5/7/9/200 会退化成 4 种而漏测）
      const W16 = 16;
      const frame = (cols: number[][]): Uint8ClampedArray => {
        const d = new Uint8ClampedArray(W16 * W16 * 4);
        for (let y = 0; y < W16; y++) {
          for (let x = 0; x < W16; x++) {
            const c = cols[(y * W16 + x) % cols.length];
            const i = (y * W16 + x) * 4;
            d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
          }
        }
        return d;
      };
      // 1 / 2 / 3 / 5 / 7 / 9 / 200 种颜色：全部都要能导出并解回来
      for (const n of [1, 2, 3, 5, 7, 9, 200]) {
        const cols: number[][] = [];
        for (let i = 0; i < n; i++) cols.push([(i * 11) & 255, (i * 37) & 255, (i * 71) & 255]);
        let bytes: Uint8Array | null = null;
        let err = "";
        try { bytes = encodeGIF([{ data: frame(cols), delayMs: 100 }], W16, W16, { transparent: false }); }
        catch (e) { err = e instanceof Error ? e.message : String(e); }
        ok("gif.palette." + n + ".encodes", !!bytes && !err, err);
        if (!bytes) continue;
        const rd = new mod.GifReader(bytes);
        eq("gif.palette." + n + ".frames", rd.numFrames(), 1);
        const px = new Uint8ClampedArray(W16 * W16 * 4);
        rd.decodeAndBlitFrameRGBA(0, px);
        // 第一行的颜色必须原样回来（调色板是精确色，量化不该改动它）
        eq("gif.palette." + n + ".pixel", [px[0], px[1], px[2]], cols[0]);
      }
      // 带透明：透明像素必须保持 alpha=0
      const withAlpha = frame([[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255]]);
      for (let i = 0; i < W16; i++) withAlpha[i * 4 + 3] = 0;      // 第一行透明
      const tb = encodeGIF([{ data: withAlpha, delayMs: 100 }], W16, W16, { transparent: true });
      const trd = new mod.GifReader(tb);
      const tpx = new Uint8ClampedArray(W16 * W16 * 4);
      trd.decodeAndBlitFrameRGBA(0, tpx);
      eq("gif.transparent.alpha", tpx[3], 0);
      ok("gif.transparent.opaque", tpx[(1 * W16 + 0) * 4 + 3] > 0);
    } finally {
      if (prev === undefined) delete g.window.GifWriter;
      else g.window.GifWriter = prev;
    }
  }

  // --- ⑧ GIF：调色板映射走 5bit 洪水填充表（不再逐像素扫描调色板）---
  {
    const seen: number[][] = [];
    const g = globalThis as unknown as { window: Record<string, unknown> };
    const prev = g.window.GifWriter;
    g.window.GifWriter = class {
      constructor(_buf: Uint8Array, _w: number, _h: number, _o?: unknown) { /* stub */ }
      addFrame(_x: number, _y: number, _w: number, _h: number, indexed: Uint8Array): void {
        seen.push(Array.from(indexed));
      }
      end(): number { return 32; }
    };
    try {
      // 4×4，左右两半分别是两个精确的调色板颜色
      const data = new Uint8ClampedArray(4 * 4 * 4);
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
          const i = (y * 4 + x) * 4;
          const c = x < 2 ? [255, 0, 0] : [0, 0, 255];
          data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
        }
      }
      const out = encodeGIF([{ data, delayMs: 100 }], 4, 4, { transparent: false });
      eq("exp.gif.bytes", out.length, 32);
      eq("exp.gif.frames", seen.length, 1);
      // 精确色必须原样映射（表里就种着这两个颜色），且左右两半各自一致
      const row = seen[0].slice(0, 4);
      ok("exp.gif.mapped", row[0] === row[1] && row[2] === row[3] && row[0] !== row[2], JSON.stringify(row));
    } finally {
      if (prev === undefined) delete g.window.GifWriter;
      else g.window.GifWriter = prev;
    }
  }
}
