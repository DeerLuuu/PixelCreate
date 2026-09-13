// Static checks for the in-app release notes (更新日志).
//
// The changelog dialog renders every item as plain text — `<li>{x.zh}</li>`, no
// markdown pass at all. So a `**bold**` marker or a backtick does not style
// anything, it shows up verbatim in front of the user; those markers piled up
// over several releases until 1.1.1.7 cleaned them out. Reading the source is
// the only way to catch them (there is no DOM in this runner), and it also lets
// us compare the version number with AndroidManifest.xml, which used to be a
// manual "remember to sync it" step (see AGENTS.md §7).
import { eq, ok } from "./common";

declare const require: (m: string) => any;
declare const __dirname: string;
const fs = require("fs");
const path = require("path");

/** one `it("kind", "zh", "en"),` line, exactly as the array is written */
const ITEM = /^\s*it\("(add|imp|fix)", "(.*)", "(.*)"\),\s*$/;

export function testChangelog(): void {
  const root = path.resolve(__dirname, "../../..");
  const src = fs.readFileSync(path.join(root, "src/ui/changelog.tsx"), "utf8");
  const manifest = fs.readFileSync(path.join(root, "android/AndroidManifest.xml"), "utf8");

  const appVersion = (src.match(/export const APP_VERSION = "([^"]+)"/) || [])[1];
  const buildTag = (src.match(/export const BUILD_TAG = "([^"]+)"/) || [])[1];
  const verName = (manifest.match(/android:versionName="([^"]+)"/) || [])[1];
  const verCode = (manifest.match(/android:versionCode="([^"]+)"/) || [])[1];
  ok("changelog.version-parsed", !!appVersion && !!verName, "app=" + appVersion + " manifest=" + verName);
  eq("changelog.manifest-version-sync", verName, appVersion);
  ok("changelog.version-code-numeric", /^[0-9]+$/.test(verCode || ""), "code=" + verCode);
  ok("changelog.build-tag", /^[0-9a-f]{7,}$/.test(buildTag || ""), "tag=" + buildTag);

  // walk the array: version / date lines plus item lines
  const versions: { v: string; date: string; items: number; zh: string[]; en: string[] }[] = [];
  const bad: string[] = [];
  let cur: (typeof versions)[number] | null = null;
  for (const line of src.split(/\r?\n/)) {
    const vm = /^    v: "([^"]+)",$/.exec(line);
    if (vm) { cur = { v: vm[1], date: "", items: 0, zh: [], en: [] }; versions.push(cur); continue; }
    const dm = /^    date: "([^"]+)",$/.exec(line);
    if (dm && cur) { cur.date = dm[1]; continue; }
    if (!/^\s*it\(/.test(line)) continue;
    const m = ITEM.exec(line);
    if (!m || !cur) { bad.push(line.trim().slice(0, 60)); continue; }
    cur.items++;
    cur.zh.push(m[2]);
    cur.en.push(m[3]);
  }

  ok("changelog.items-parse", bad.length === 0, "unparsed=" + bad.length + " " + bad.slice(0, 3).join(" | "));
  ok("changelog.versions", versions.length >= 40, "versions=" + versions.length);
  eq("changelog.top-is-current", versions[0] && versions[0].v, appVersion);
  eq("changelog.unique-versions", new Set(versions.map((x) => x.v)).size, versions.length);
  ok("changelog.every-version-has-items", versions.every((x) => x.items > 0));
  ok("changelog.total-items", versions.reduce((a, x) => a + x.items, 0) >= 250);
  ok("changelog.version-format", versions.every((x) => /^[0-9]+(\.[0-9]+){1,3}$/.test(x.v)));
  ok("changelog.date-format", versions.every((x) => /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(x.date)),
    versions.filter((x) => !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(x.date)).map((x) => x.v).join(","));

  // the dialog draws these strings as-is: no markdown, no stray spacing
  const all = versions.flatMap((x) => x.zh.concat(x.en));
  const marked = all.filter((s) => s.includes("**") || s.includes("`"));
  ok("changelog.plain-text", marked.length === 0, "marked=" + marked.length + " " + (marked[0] || "").slice(0, 40));
  ok("changelog.no-double-space", all.every((s) => !/\s{2}/.test(s)));
  ok("changelog.trimmed", all.every((s) => s === s.trim()));
  ok("changelog.no-newline-escape", all.every((s) => !s.includes("\\n")));
  ok("changelog.zh-is-chinese", versions.every((x) => x.zh.every((s) => /[\u4e00-\u9fff]/.test(s))));
  ok("changelog.en-is-latin", versions.every((x) => x.en.every((s) => !/[\u4e00-\u9fff]/.test(s))));
  ok("changelog.zh-not-too-long", all.filter((s) => /[\u4e00-\u9fff]/.test(s)).every((s) => s.length <= 300));
  ok("changelog.items-are-one-line", src.split(/\r?\n/).filter((l) => /^\s*it\(/.test(l)).length ===
    versions.reduce((a, x) => a + x.items, 0) + bad.length);
}
