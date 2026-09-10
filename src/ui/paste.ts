// Clipboard paste flows, shared by the keyboard shortcuts and the selection orb.
//
// Three flavours exist:
//   inPlace  Ctrl+V            into the focused canvas (or every picked frame)
//   layer    Ctrl+Shift+V      paste as a brand-new layer
//   canvas   Ctrl+Alt+V        paste as a brand-new canvas
//
// The system clipboard is preferred over the in-app one, and its image is
// turned into a REAL Cel: the paste path indexes clips with `cel.idx()`, so a
// plain `{ w, h, data }` object used to throw and make Ctrl+V silently do
// nothing (fixed here, with a toast if anything else goes wrong).
import { Cel } from "../engine/cel";
import { selOps } from "../tools/select";
import * as bridge from "../io/bridge";
import { SESSION } from "./singleton";
import { makeT } from "./i18n";
import type { Lang } from "./i18n";

export type PasteMode = "inPlace" | "layer" | "canvas";

/** read an image out of the system clipboard (null when there is none) */
export async function readClipboardImage(): Promise<{ clip: Cel | null; fromSystem: boolean }> {
  try {
    const items = await navigator.clipboard?.read?.();
    for (const it of items ?? []) {
      const type = it.types.find((x) => x.startsWith("image/"));
      if (!type) continue;
      const blob = await it.getType(type);
      const bmp = await createImageBitmap(blob);
      const cv = document.createElement("canvas");
      cv.width = bmp.width;
      cv.height = bmp.height;
      const cx = cv.getContext("2d");
      if (!cx) continue;
      cx.drawImage(bmp, 0, 0);
      const px = cx.getImageData(0, 0, bmp.width, bmp.height).data;
      const cel = new Cel(bmp.width, bmp.height);
      cel.data.set(px);
      return { clip: cel, fromSystem: true };
    }
  } catch { /* the browser may refuse clipboard access: fall back in-app */ }
  return { clip: SESSION.clip, fromSystem: false };
}

/** run one of the three paste flavours; always leaves a toast behind */
export async function pasteClipboard(mode: PasteMode): Promise<void> {
  const t = makeT(SESSION.prefs.lang as Lang);
  try {
    const { clip, fromSystem } = await readClipboardImage();
    if (!clip) { bridge.toast(t("pasteEmpty")); return; }
    SESSION.clip = clip;
    if (mode === "layer") {
      bridge.toast(SESSION.pasteAsNewLayer(clip) ? t("pasteAsLayer") : t("pasteEmpty"));
      return;
    }
    if (mode === "canvas") {
      bridge.toast(SESSION.pasteAsNewCanvas(clip) >= 0 ? t("pasteAsCanvas") : t("pasteEmpty"));
      return;
    }
    const li = SESSION.curLayer();
    const picked = SESSION.frameSelOn ? SESSION.frameSelList() : [];
    if (picked.length) {
      bridge.toast(SESSION.pasteIntoFrames(clip, li, picked) ? t("pasteFrames") : t("pasteEmpty"));
      return;
    }
    selOps.paste(SESSION.doc, SESSION.history, li, SESSION.curFrame(), clip);
    SESSION.repaint();
    bridge.toast(t(fromSystem ? "pasteFromSystem" : "sel.paste"));
  } catch {
    bridge.toast(t("pasteEmpty"));
  }
}
