// Static i18n key check.
//
// makeT() returns the key itself when a lookup fails, so a typo such as
// t("loop.once") (the dict only has loopModes.once) silently renders
// "loop.once" in the UI. There is no DOM here, so instead of rendering we scan
// the sources for every key we can find statically and prove each one resolves
// in BOTH languages:
//
//   1. literal keys used as t("...")
//   2. dotted string literals whose first segment is a dictionary key
//      (skipping setting paths and guide step ids, which share that shape)
//   3. dynamic lookups t("prefix." + x): the prefix must resolve to a nested
//      dictionary, i.e. at least one prefix.child key must resolve
//   4. zh and en must declare exactly the same top-level keys
import { makeT, type Lang } from "../src/ui/i18n";
import { eq, ok } from "./common";

declare const require: (m: string) => any;
declare const __dirname: string;
const fs = require("fs");
const path = require("path");

export function testI18n(): void {
  const uiDir = path.resolve(__dirname, "../../../src/ui");
  const appDir = path.resolve(__dirname, "../../../src/app");
  const files = fs.readdirSync(uiDir).filter((f) => /\.(ts|tsx)$/.test(f) && f !== "i18n.ts");
  const text = files.map((f) => fs.readFileSync(path.join(uiDir, f), "utf8")).join("\n")
    + fs.readdirSync(appDir).filter((f) => /\.(ts|tsx)$/.test(f))
      .map((f) => fs.readFileSync(path.join(appDir, f), "utf8")).join("\n");
  ok("i18n.sources", files.length > 10, "files=" + files.length);

  const dictText = fs.readFileSync(path.join(uiDir, "i18n.ts"), "utf8");
  const langs: Lang[] = ["zh", "en"];
  const trs = langs.map((l) => ({ l, t: makeT(l) }));
  /** a lookup resolved when it no longer echoes the key back */
  const resolves = (key: string): boolean => trs.every(({ t }) => t(key) !== key);

  // 1) literal keys used directly: t("someKey")
  const keys = new Set<string>();
  for (const m of text.matchAll(/\bt\(\s*"([A-Za-z0-9_.]+)"\s*\)/g)) keys.add(m[1]);
  ok("i18n.literal-keys-found", keys.size > 200, "keys=" + keys.size);
  eq("i18n.literal-keys-resolve", [...keys].filter((k) => !resolves(k)), []);

  // 2) dotted literals (label maps etc.), minus setting paths / guide step ids
  const topKeys = new Set([...dictText.matchAll(/^\s{2}([A-Za-z0-9_]+):/gm)].map((m) => m[1]));
  const settingPaths = new Set([...fs.readFileSync(path.join(appDir, "settings.ts"), "utf8")
    .matchAll(/path:\s*"([^"]+)"/g)].map((m) => m[1]));
  const guideIds = new Set([...fs.readFileSync(path.join(appDir, "guide.ts"), "utf8")
    .matchAll(/\bid:\s*"([^"]+)"/g)].map((m) => m[1]));
  // history step labels are ids mapped through modals.tsx's H_ZH / H_EN tables
  const histLabels = new Set([...fs.readFileSync(path.join(uiDir, "modals.tsx"), "utf8")
    .matchAll(/"([a-z][A-Za-z0-9_.-]*)":\s*"/g)].map((m) => m[1]));
  const dotted = new Set<string>();
  for (const m of text.matchAll(/"([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)"/g)) dotted.add(m[1]);
  const badDotted = [...dotted].filter((k) =>
    topKeys.has(k.split(".")[0]) && !settingPaths.has(k) && !guideIds.has(k)
    && !histLabels.has(k) && !resolves(k));
  eq("i18n.dotted-literals-resolve", badDotted, []);

  // 3) dynamic lookups t("prefix." + x) need a nested dictionary
  const prefixes = new Set<string>();
  for (const m of text.matchAll(/\bt\(\s*"([A-Za-z0-9_]+)\."\s*\+/g)) prefixes.add(m[1]);
  // probe with every identifier that appears as a key anywhere in the dict
  const allKeys = [...dictText.matchAll(/([A-Za-z0-9_]+):\s*(?:"|\{)/g)].map((m) => m[1]);
  const badPrefix = [...prefixes].filter((p) => !allKeys.some((k) => resolves(p + "." + k)));
  eq("i18n.dynamic-prefixes-resolve", badPrefix, []);

  // 4) zh / en parity on the top-level keys
  const top = (name: string): string[] => {
    const start = dictText.indexOf("const " + name + ": Dict = {");
    const end = dictText.indexOf("\n};", start);
    return [...dictText.slice(start, end).matchAll(/^\s{2}([A-Za-z0-9_]+):/gm)].map((m) => m[1]);
  };
  const zhKeys = top("zh");
  const enKeys = top("en");
  ok("i18n.zh-keys", zhKeys.length > 120, "zh=" + zhKeys.length);
  eq("i18n.zh-only", zhKeys.filter((k) => !enKeys.includes(k)), []);
  eq("i18n.en-only", enKeys.filter((k) => !zhKeys.includes(k)), []);
}
