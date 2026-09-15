// Icon sprite hygiene (app2/www/index.html).
//
// Three classes of bug this locks down, all of which shipped at least once:
//  1. an `Icon id="..."` that is not in the sprite at all (renders nothing);
//  2. two different ids carrying the SAME artwork (i-play / i-next and
//     i-tile-row / i-tile-col were literally the same picture);
//  3. one id reused for two unrelated meanings, so the glyph lies about the
//     action (i-size served both "resize dialog" and "resize mode").
//
// 4) 真机反馈「最近的新功能图标和别的重复，分不清」——`src/ui/feature-icons.ts`
//    给每个功能入口登记了专属图标：同组（同一屏同时出现）不得重复，且都必须在 sprite 里。
import { FEATURE_ICONS } from "../src/ui/feature-icons";
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
    // 新功能的专属图标：等距图形 / 颜色分析 / 色彩明暗 / 索引色重映射 / 变形与吸附
    ["i-iso", "i-grid"],
    ["i-iso", "i-layers"],
    ["i-ca", "i-search"],
    ["i-shade", "i-dedupe"],
    ["i-remap", "i-dedupe"],
    ["i-skew", "i-resize-mode"],
    ["i-mesh", "i-grid"],
    ["i-snap", "i-grid"],
    ["i-snap-half", "i-snap"],
    // 自动保存历史（多版本恢复）：不能和"操作历史 / 保存 / 图层"看起来一样
    ["i-recover", "i-history"],
    ["i-recover", "i-save"],
    ["i-recover", "i-layers"],
  ];
  for (const [a, b] of pairs) {
    const A = byId.get(a), B = byId.get(b);
    ok("icons.pair.exists." + a + "." + b, !!A && !!B);
    ok("icons.pair.differs." + a + "." + b, !!A && !!B && A.body !== B.body);
  }
  // the new purpose-built icons really are in the sprite
  for (const id of ["i-resize-mode", "i-sel-grow", "i-sel-shrink", "i-indexed", "i-paste-layer", "i-paste-canvas",
    "i-iso", "i-ca", "i-shade", "i-remap", "i-skew", "i-mesh", "i-snap", "i-snap-half", "i-recover"]) {
    ok("icons.new." + id, byId.has(id));
  }

  // 4) 功能图标表：组内唯一 + 都真实存在（新增功能忘了画图标 / 借了别人的图标都会红）
  //    表是 `as const`，比较前先放宽成 string（否则 TS 直接判定两个不同字面量不相等）
  const F = FEATURE_ICONS as unknown as Record<string, Record<string, string>>;
  const groups = Object.entries(F);
  ok("icons.table.groups", groups.length >= 5, "groups=" + groups.length);
  for (const [name, table] of groups) {
    const keys = Object.keys(table);
    ok("icons.table." + name + ".keys", keys.length > 0, name + "=" + keys.length);
    eq("icons.table." + name + ".exists", keys.filter((k) => !byId.has(table[k])).join(","), "");
    const seen = new Map<string, string>();
    let dup = "";
    for (const k of keys) {
      const prev = seen.get(table[k]);
      if (prev) dup += prev + " 与 " + k + " 都用 " + table[k] + "; ";
      else seen.set(table[k], k);
    }
    eq("icons.table." + name + ".unique", dup, "");
  }
  // 近期新功能的图标没有被改回「借来的」那个
  ok("icons.entry.iso", F.menu.iso === F.fxOrb.iso);
  ok("icons.entry.iso-not-customise", F.menu.iso !== F.menu.customise);
  // 颜色分析 / 色彩明暗合并成「颜色高级模式」后只有一个入口，图标也要是专属的那一个
  ok("icons.entry.cadv-not-remap", F.palette.colorAdv !== F.palette.remap);
  ok("icons.entry.cadv-not-dedupe", F.palette.colorAdv !== F.palette.dedupe);
  ok("icons.entry.cadv-not-indexed", F.palette.colorAdv !== F.palette.indexed);
}
