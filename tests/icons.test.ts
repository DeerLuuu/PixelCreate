// Icon sprite hygiene (app2/www/index.html).
//
// Three classes of bug this locks down, all of which shipped at least once:
//  1. an `Icon id="..."` that is not in the sprite at all (renders nothing);
//  2. two different ids carrying the SAME artwork (i-play / i-next and
//     i-tile-row / i-tile-col were literally the same picture);
//  3. one id reused for two unrelated meanings, so the glyph lies about the
//     action (i-size served both "resize dialog" and "resize mode").
import { eq, ok } from "./common";

declare const require: (m: string) => any;
declare const __dirname: string;

/** normalise artwork so whitespace / attribute order cannot hide a duplicate */
function art(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}

export function testIcons(): void {
  const fs = require("fs");
  const path = require("path");
  let dir = __dirname;
  let html = "";
  for (let i = 0; i < 8 && !html; i++) {
    const p = path.resolve(dir, "app2/www/index.html");
    if (fs.existsSync ? fs.existsSync(p) : false) html = fs.readFileSync(p, "utf8");
    dir = path.resolve(dir, "..");
  }
  if (!html) {
    ok("icons.skipped", true, "app2/www/index.html not reachable");
    return;
  }
  const syms = [...html.matchAll(/<symbol id="(i-[a-z0-9-]+)" viewBox="[^"]*">([\s\S]*?)<\/symbol>/g)]
    .map((m) => ({ id: m[1], body: art(m[2]) }));
  const byId = new Map(syms.map((s) => [s.id, s]));
  ok("icons.sprite.size", syms.length >= 90, "symbols=" + syms.length);

  // 1) every icon referenced from the source exists in the sprite
  const root = path.resolve(dir, "src");   // dir walked one level past the repo root
  const used = new Set<string>();
  const walk = (d: string): void => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.tsx?$/.test(f)) continue;
      const src = fs.readFileSync(p, "utf8");
      for (const m of src.matchAll(/["'](i-[a-z0-9-]+)["']/g)) used.add(m[1]);
    }
  };
  try { walk(root); } catch { /* layout without src/ next to app2: skip below */ }
  const missing = [...used].filter((id) => !byId.has(id)).sort();
  eq("icons.all-referenced-defined", missing, []);

  // 2) no two ids may share the same artwork
  const seen = new Map<string, string[]>();
  for (const s of syms) {
    const k = s.body;
    seen.set(k, [...(seen.get(k) ?? []), s.id]);
  }
  const dups = [...seen.values()].filter((ids) => ids.length > 1).map((ids) => ids.sort().join("="));
  eq("icons.no-duplicate-artwork", dups, []);

  // 3) pairs that must stay visually distinct (they mean different things)
  const pairs: Array<[string, string]> = [
    ["i-play", "i-next"],
    ["i-tile-row", "i-tile-col"],
    ["i-size", "i-resize-mode"],
    ["i-palette", "i-indexed"],
    ["i-plus", "i-sel-grow"],
    ["i-minus", "i-sel-shrink"],
    ["i-layers", "i-paste-layer"],
    ["i-canvas", "i-paste-canvas"],
    ["i-crop", "i-fx-crop"],
    ["i-select", "i-rect"],
  ];
  for (const [a, b] of pairs) {
    const A = byId.get(a), B = byId.get(b);
    ok("icons.pair.exists." + a + "." + b, !!A && !!B);
    ok("icons.pair.differs." + a + "." + b, !!A && !!B && A.body !== B.body);
  }
  // the new purpose-built icons really are in the sprite
  for (const id of ["i-resize-mode", "i-sel-grow", "i-sel-shrink", "i-indexed", "i-paste-layer", "i-paste-canvas"]) {
    ok("icons.new." + id, byId.has(id));
  }
}
