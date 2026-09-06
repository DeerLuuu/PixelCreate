// Best-effort system clipboard integration (web Clipboard API).
// Android WebView under file:// has no async clipboard API -> callers fall back
// to the internal in-app clipboard and stay functional.

export async function writeClipboardPng(canvas: HTMLCanvasElement): Promise<boolean> {
  try {
    if (!navigator.clipboard || typeof ClipboardItem === "undefined") return false;
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob((b) => res(b), "image/png"));
    if (!blob) return false;
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob }) as ClipboardItem]);
    return true;
  } catch {
    return false;
  }
}

export async function readClipboardImage(): Promise<{ w: number; h: number; px: Uint8ClampedArray } | null> {
  try {
    if (!navigator.clipboard || !navigator.clipboard.read) return null;
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const t = it.types.find((x) => x.startsWith("image/"));
      if (!t) continue;
      const blob = await it.getType(t);
      const url = URL.createObjectURL(blob);
      try {
        const img = await new Promise<HTMLImageElement>((res, rej) => {
          const im = new Image();
          im.onload = () => res(im);
          im.onerror = () => rej(new Error("decode"));
          im.src = url;
        });
        const w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) return null;
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0);
        return { w, h, px: new Uint8ClampedArray(ctx.getImageData(0, 0, w, h).data) };
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    return null;
  } catch {
    return null;
  }
}
