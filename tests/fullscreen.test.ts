// Fullscreen toggle decision (src/io/fullscreen.ts) — pure parts only.
//
// The button must exist for a browser session and must NOT exist inside the
// Android shell (the APK hides the system bars itself), so the two inputs that
// decide it are checked here for every combination.
import { fullscreenIcon, showFullscreenToggle } from "../src/io/fullscreen";
import { eq, ok } from "./common";

export function testFullscreen(): void {
  // browser tab / installed PWA: the API works, so the toggle is shown
  eq("full.browser", showFullscreenToggle(false, true), true);
  // APK shell: hidden even though a WebView may advertise the API
  eq("full.native-shell", showFullscreenToggle(true, true), false);
  // iOS Safari (iPhone) and old browsers: no element fullscreen at all
  eq("full.unsupported", showFullscreenToggle(false, false), false);
  eq("full.native-and-unsupported", showFullscreenToggle(true, false), false);

  eq("full.icon.off", fullscreenIcon(false), "i-full");
  eq("full.icon.on", fullscreenIcon(true), "i-full-exit");

  // the icons must exist in the sprite the app ships. The container build only
  // mirrors src/ and tests/, so walk up from here and use the file when it is
  // reachable (the repo checkout and <app>/app2/www both work).
  const fs = require("fs") as { readFileSync: (p: string, e: string) => string; existsSync: (p: string) => boolean };
  const path = require("path") as { resolve: (...p: string[]) => string; join: (...p: string[]) => string; dirname: (p: string) => string };
  const findUp = (rel: string): string | null => {
    let dir = path.resolve(__dirname);
    for (let i = 0; i < 6; i++) {
      const p = path.join(dir, rel);
      if (fs.existsSync(p)) return p;
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    return null;
  };
  const spriteFile = findUp("app2/www/index.html");
  ok("full.sprite.reachable", !!spriteFile, "sprite=" + spriteFile);
  if (spriteFile) {
    const html = fs.readFileSync(spriteFile, "utf8");
    ok("full.sprite.enter", html.indexOf('id="i-full"') >= 0);
    ok("full.sprite.exit", html.indexOf('id="i-full-exit"') >= 0);
  }
  // …and the toggle is gated in the UI, never rendered unconditionally
  const appFile = findUp("src/ui/App.tsx");
  ok("full.ui.source", !!appFile, "app=" + appFile);
  if (appFile) {
    const app = fs.readFileSync(appFile, "utf8");
    // 工具栏按钮现在由注册表驱动，全屏项必须在渲染前被过滤掉（而不是无条件渲染）
    ok("full.ui.gated", app.indexOf("fullscreenToggleVisible()") >= 0 &&
      (app.indexOf("{fsShow && (") >= 0 || app.indexOf('a.id !== "fullscreen" || fsShow') >= 0));
  }
}

declare const require: (m: string) => unknown;
declare const __dirname: string;
