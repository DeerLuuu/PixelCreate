// Export option helpers: the frame range has to clamp and auto-swap so a
// typed-in range can never produce an empty or out-of-bounds export.
import { encodeGIF, exportBudgetError, frameRange, MAX_IMAGE_PIXELS, MAX_LAYER_FILES } from "../src/io/exporters";
import { eq, ok } from "./common";

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
