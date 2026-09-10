// Design-token contract (docs/UI.md §3).
//
// There is no browser here, so the tokens are checked statically against
// src/ui/style.css:
//   1. every size token and theme token exists in :root
//   2. the light theme overrides *every* theme token and nothing else
//      (a fixed token re-declared there would drift between themes)
//   3. app-shell rules never hard-code a colour — they must use a token
//   4. every var(--x) that rules reference is actually defined
import { eq, ok } from "./common";

declare const require: (m: string) => any;
declare const __dirname: string;
const fs = require("fs");
const path = require("path");

/** geometry tokens: same value in both themes */
const SIZE_TOKENS = [
  "--sp-1", "--sp-2", "--sp-3", "--sp-4", "--sp-5", "--sp-6", "--sp-7", "--sp-8",
  "--r-1", "--r-2", "--r-3", "--r-4", "--r-5", "--r-6", "--r-pill", "--r-round",
  "--fs-1", "--fs-2", "--fs-3", "--fs-4", "--fs-5", "--fs-6",
  "--ctl-h", "--tap",
  "--sh-1", "--sh-2", "--sh-2b", "--sh-3", "--sh-4", "--sh-panel", "--sh-ring",
  "--z-mask", "--z-dlg", "--z-panel-mask", "--z-panel", "--z-pop", "--z-toast", "--z-tip", "--z-top",
];
/** colour tokens the light theme must override */
const THEME_TOKENS = [
  "--bg", "--bg2", "--bg3", "--bg4", "--ws-bg", "--line", "--line-2",
  "--text", "--dim", "--text-2", "--text-3", "--text-4",
  "--dim-2", "--dim-3", "--dim-4", "--disabled",
  "--input-bg", "--input-line", "--input-text",
  "--surface-card", "--surface-pop", "--surface-toast",
  "--surface-anchor", "--surface-anchor-on", "--anchor-dot",
  "--accent", "--accent-2", "--accent-3", "--accent-4",
  "--accent-soft", "--accent-faint", "--accent-glow", "--on-accent",
  "--danger", "--danger-1", "--danger-2", "--danger-3", "--danger-4",
  "--link", "--mask",
  "--set-item-bg", "--set-item-line", "--set-group-bg", "--set-head-bg",
  "--ctl-bg-soft", "--ctl-line-soft",
];
/** selectors that belong to the app shell: no raw colour literals allowed */
const SHELL = [
  ".viewport", ".btn", ".dlg", ".rowlabel", ".row-note", ".row-actions", ".chips", ".chip",
  ".tabs", ".tab", ".sw", ".dropmenu", ".tabbar", ".panel", ".set-", ".hist-", ".menuitem",
  ".blend-", ".fp-", ".ref-mode", ".anchor", ".a-dot", ".size-note", ".textinput", ".calcpad",
  ".cp-key", ".cp-eq", ".cp-back", ".toast", ".tl-name", ".tl-blend", ".tl-edit", ".ase-", ".preset-", ".iconbtn",
  ".clg-", ".empty-canvas", ".ec-", ".prev-menu", ".guide-bubble", ".guide-meta", ".guide-title",
  ".guide-body", ".guide-foot", ".cfm-msg", ".fsel-", ".holdbtn", ".hb-text", ".swatch",
  ".repl-line", ".replay-", ".rh-", "input",
];

const BANNER = "   2/5  base";

function matches(p: string, s: string): boolean {
  if (s.endsWith("-")) return p.startsWith(s);
  if (!p.startsWith(s)) return false;
  const rest = p.slice(s.length);
  return rest === "" || ":. -[>+~(".indexOf(rest[0]) >= 0;
}
const isShell = (sel: string): boolean =>
  sel.replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(",")
    .some((part) => SHELL.some((s) => matches(part.trim(), s)));

/** flat list of {sel, decls} for every declaration block (recurses into @media) */
function rules(css: string): Array<{ sel: string; decls: string }> {
  const out: Array<{ sel: string; decls: string }> = [];
  const walk = (text: string): void => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf("{", i);
      if (open < 0) return;
      const sel = text.slice(i, open);
      let depth = 1;
      let k = open + 1;
      while (depth > 0 && k < text.length) {
        if (text[k] === "{") depth++;
        else if (text[k] === "}") depth--;
        k++;
      }
      const inner = text.slice(open + 1, k - 1);
      if (inner.indexOf("{") >= 0) walk(inner);
      else out.push({ sel: sel.replace(/\/\*[\s\S]*?\*\//g, " ").trim(), decls: inner });
      i = k;
    }
  };
  walk(css);
  return out;
}

export function testUiTokens(): void {
  const css = fs.readFileSync(path.resolve(__dirname, "../../../src/ui/style.css"), "utf8");
  const rootStart = css.indexOf(":root{");
  const lightStart = css.indexOf('\n[data-theme="light"]{');
  ok("uitoken.sections", rootStart >= 0 && lightStart > rootStart, "root=" + rootStart + " light=" + lightStart);
  const root = css.slice(rootStart, lightStart);
  const light = css.slice(lightStart, css.indexOf(BANNER));
  const keys = (s: string): Set<string> =>
    new Set([...s.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const rk = keys(root);
  const lk = keys(light);
  eq("uitoken.size+theme defined", [...SIZE_TOKENS, ...THEME_TOKENS].filter((k) => !rk.has(k)), []);
  eq("uitoken.light covers theme", THEME_TOKENS.filter((k) => !lk.has(k)), []);
  eq("uitoken.light has no fixed token", [...lk].filter((k) => THEME_TOKENS.indexOf(k) < 0), []);
  ok("uitoken.count", rk.size >= 100, "tokens=" + rk.size);

  const body = css.slice(css.indexOf(BANNER));
  const all = rules(body);
  ok("uitoken.rules", all.length > 300, "rules=" + all.length);

  // 3) no raw colour in app-shell rules
  const raw: string[] = [];
  for (const r of all) {
    if (!isShell(r.sel)) continue;
    const hit = r.decls.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/);
    if (hit) raw.push(r.sel + " -> " + hit[0]);
  }
  eq("uitoken.no-raw-colour-in-shell", raw, []);

  // 4) every referenced token is defined
  const used = new Set([...body.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]));
  eq("uitoken.all-referenced-defined", [...used].filter((k) => !rk.has(k)).sort(), []);

  // the switch added for boolean settings must be theme-aware: every colour it
  // paints comes from a token (accent when on, the surface colour when off)
  const sw = all.filter((r) => /^\.sw(?![a-zA-Z])/.test(r.sel));
  const swDecls = sw.map((r) => r.decls).join(";");
  const swRaw = swDecls.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/);
  ok("uitoken.switch-styled", sw.length >= 4 && !swRaw
    && /background:var\(--accent\)/.test(swDecls) && /var\(--on-accent\)/.test(swDecls),
    "rules=" + sw.length + " raw=" + (swRaw ? swRaw[0] : "none"));
}
