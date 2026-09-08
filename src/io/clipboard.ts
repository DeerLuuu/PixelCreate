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

