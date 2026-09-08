// Export option helpers: the frame range has to clamp and auto-swap so a
// typed-in range can never produce an empty or out-of-bounds export.
import { frameRange } from "../src/io/exporters";
import { eq } from "./common";

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
}
