// Bridge to the Android WebView shell (window.PixelBridge) with web fallbacks.
declare global {
  interface Window {
    PixelBridge?: {
      saveFile: (name: string, mime: string, base64: string, reqId: string) => void;
      openFile: (mime: string) => void;
      toast: (msg: string) => void;
      vibrate: (ms: number) => void;
      keepAwake: (on: boolean) => void;
    };
  }
}

function b64FromBytes(bytes: Uint8Array): string {
  const CH = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH) as unknown as number[]);
  return btoa(bin);
}
function bytesFromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}


export function toast(msg: string): void {
  if (window.PixelBridge) {
    try {
      window.PixelBridge.toast(String(msg));
      return;
    } catch {
      /* fall through */
    }
  }
  const ev = new CustomEvent("pc-toast", { detail: msg });
  window.dispatchEvent(ev);
}

export function vibrate(ms: number): void {
  window.PixelBridge?.vibrate?.(Math.max(5, Math.min(60, Math.round(ms))));
}

export function saveBytes(name: string, mime: string, bytes: Uint8Array, onDone?: (ok: boolean) => void): void {
  const b = window.PixelBridge;
  if (b) {
    const h = (e: Event) => {
      window.removeEventListener("pcsave", h);
      const d = (e as CustomEvent).detail;
      onDone?.(!!d && d.ok);
    };
    window.addEventListener("pcsave", h);
    b.saveFile(name, mime, b64FromBytes(bytes), "");
  } else {
    const a = document.createElement("a");
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 600);
    onDone?.(true);
  }
}

export interface OpenedFile {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export function openFile(mime = "*/*"): Promise<OpenedFile | null> {
  return new Promise((resolve) => {
    const b = window.PixelBridge;
    if (b) {
      const h = (e: Event) => {
        window.removeEventListener("pcopen", h);
        const d = (e as CustomEvent).detail;
        if (d && d.ok && d.data) {
          resolve({ name: d.name || "file", mime: d.mime || mime, bytes: bytesFromB64(d.data) });
        } else resolve(null);
      };
      window.addEventListener("pcopen", h);
      b.openFile(mime);
    } else {
      const inp = document.createElement("input");
      inp.type = "file";
      inp.accept = mime;
      inp.onchange = () => {
        const f = inp.files?.[0];
        if (!f) return resolve(null);
        const fr = new FileReader();
        fr.onload = () => resolve({ name: f.name, mime: f.type || "application/octet-stream", bytes: new Uint8Array(fr.result as ArrayBuffer) });
        fr.onerror = () => resolve(null);
        fr.readAsArrayBuffer(f);
      };
      inp.click();
    }
  });
}

export { b64FromBytes, bytesFromB64 };
