// Static anchor check for the onboarding guide.
//
// The spotlight points at real controls by CSS selector, but there is no DOM in
// the test runner — so instead of querying the page this test reads the UI
// sources and proves that every anchor the guide asks for is actually rendered.
// It catches the one class of bug the other guide tests cannot see: a selector
// that no longer matches anything (the step would silently be skipped at
// runtime, or worse, spot an empty hole).
import { GUIDE, guideActionsOf } from "../src/app/guide";
import { CORE_TOOLS, SHAPE_TOOLS, SELECT_TOOLS } from "../src/tools/registry";
import { eq, ok } from "./common";

declare const require: (m: string) => any;
declare const __dirname: string;
const fs = require("fs");
const path = require("path");

export function testGuideAnchors(): void {
  // compiled to <app>/tests/.ts-out/tests → the UI sources live at <app>/src/ui
  const uiDir = path.resolve(__dirname, "../../../src/ui");
  const files = fs.readdirSync(uiDir).filter((f) => /\.(ts|tsx)$/.test(f));
  ok("guideanchor.ui-sources", files.length > 10, "files=" + files.length);
  const text = files.map((f) => fs.readFileSync(path.join(uiDir, f), "utf8")).join("\n");

  // anchors rendered as a literal attribute, plus the ones built from ids
  const anchors = new Set<string>();
  const collect = (re: RegExp) => {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) anchors.add(m[1]);
  };
  // rendered directly as an attribute, and passed as a `guide="..."` prop /
  // helper argument (Btn and the menu builder both take the anchor that way)
  collect(/data-guide=["']([A-Za-z0-9_-]+)["']/g);
  collect(/data-guide=\{["']([A-Za-z0-9_-]+)["']\}/g);
  collect(/guide:\s*"([A-Za-z0-9_-]+)"/g);
  collect(/["']((?:btn|menu|orb|tool|pal-mode|dlg)-[A-Za-z0-9_-]+)["']/g);
  // ids assembled at runtime: tool ring items, orb balls, palette mode chips
  for (const t of [...CORE_TOOLS, ...SHAPE_TOOLS, ...SELECT_TOOLS]) anchors.add("tool-" + t.id);
  for (const g of ["tool-shape-group", "tool-select-group", "tool-back"]) anchors.add(g);
  for (const o of ["orb-main", "orb-sel", "orb-pal", "orb-fx"]) anchors.add(o);
  ok("guideanchor.anchors-found", anchors.size >= 25, "anchors=" + anchors.size);

  // every [data-guide="x"] the guide uses must exist in the UI sources
  const missing: string[] = [];
  for (const step of GUIDE) {
    for (const sel of [step.target, step.click, step.closeClick]) {
      if (!sel) continue;
      const m = /^\[data-guide="([A-Za-z0-9_-]+)"\]$/.exec(sel);
      if (m && !anchors.has(m[1])) missing.push(step.id + " -> " + sel);
      // a class selector must at least appear somewhere in the UI sources
      const c = /^\.([A-Za-z0-9_-]+)$/.exec(sel);
      if (c && !text.includes(c[1])) missing.push(step.id + " -> " + sel);
    }
  }
  eq("guideanchor.all-resolve", missing, []);

  // the dialogs the tour really opens are addressed by an anchor, not a class
  for (const [id, anchor] of [["files.menuSettings", "dlg-settings"], ["files.menuChangelog", "dlg-changelog"]] as const) {
    const step = GUIDE.find((s) => s.id === id);
    eq("guideanchor." + id, step?.target, '[data-guide="' + anchor + '"]');
    ok("guideanchor." + anchor + "-rendered", anchors.has(anchor));
  }
  // every action id the registry declares must be implemented by the host app:
  // a typo would otherwise silently do nothing at runtime
  {
    const appSrc = fs.readFileSync(path.join(uiDir, "App.tsx"), "utf8");
    const used = GUIDE.flatMap((s) => [...guideActionsOf(s.before), ...guideActionsOf(s.after)]);
    eq("guideanchor.actions-implemented", used.filter((a) => !new RegExp("\\b" + a + "\\s*[,:]").test(appSrc)), []);
  }

  // the palette demo taps the colour-source chip of the open fan for real
  ok("guideanchor.pal-chip", anchors.has("pal-mode-chip"));
  // the palette panel keeps anchors of its own for future steps
  ok("guideanchor.pal-panel-chips", anchors.has("pal-mode-palette") && anchors.has("pal-mode-doc"));
}
