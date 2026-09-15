// Bridge to the Android WebView shell (window.PixelBridge) with web fallbacks.
declare global {
  interface Window {
    PixelBridge?: {
      saveFile: (name: string, mime: string, base64: string, reqId: string) => void;
      hasVibrator?: () => boolean;
      openFile: (mime: string) => void;
      toast: (msg: string) => void;
      vibrate: (ms: number) => boolean;
      keepAwake: (on: boolean) => void;
      /** "top,bottom,left,right" in CSS px (0s when the ROM reports nothing) */
      insets?: () => string;
      /** hide (true) / show (false) the system status + navigation bars */
      setImmersive?: (on: boolean) => void;
      /** C3 本地 AI 端口服务（android/AiServer.java）：只绑 127.0.0.1。
       *  @returns 新生成的 token（16 字节十六进制）；绑定失败返回 "" */
      aiServerStart?: (port: number) => string;
      /** 停掉端口服务（没起也是空操作） */
      aiServerStop?: () => void;
      /** `'{"running":bool,"port":N,"token":"..."}'`（Java 侧的实况） */
      aiServerStatus?: () => string;
      /** 交付一条**异步**响应（Java 侧 worker 挂起等的那次）。
       *  @returns 只有第一次交付为 true；超时 / 重复交付为 false */
      aiRespond?: (requestId: string, json: string) => boolean;
    };
    /** 原生侧把一条 HTTP 请求转发进来：envelope 是
     *  `'{"method":"POST","path":"/ai","body":"<原始 body 文本>"}'`（**两个参数**）。
     *  @returns 一行 JSON 字符串（快路径）；**空串 = 挂起**，等 `PixelBridge.aiRespond` 交付 */
    __pc_ai_call?: (envelopeJson: string, requestId: string) => string;
  }
}

/** true when the page runs inside the Android WebView shell (the APK), false
 *  in a real browser tab or an installed PWA. Used to hide chrome the native
 *  shell already provides (e.g. the fullscreen toggle). */
export function isNativeShell(): boolean {
  try {
    return typeof window !== "undefined" && !!window.PixelBridge;
  } catch {
    return false;
  }
}

/** window insets in CSS px; falls back to the CSS env() safe-area values, so
 *  the browser build and ROMs without the native probe still work. */
export function insets(): { top: number; bottom: number; left: number; right: number } {
  try {
    const raw = window.PixelBridge?.insets?.();
    if (typeof raw === "string") {
      const n = raw.split(",").map((v) => Number(v) || 0);
      if (n.length >= 4) return { top: n[0], bottom: n[1], left: n[2], right: n[3] };
    }
  } catch { /* fall through */ }
  return envInsets();
}

/** read the CSS env(safe-area-inset-*) values through a probe element */
export function envInsets(): { top: number; bottom: number; left: number; right: number } {
  try {
    const el = document.createElement("div");
    el.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;" +
      "padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
    document.body.appendChild(el);
    const cs = getComputedStyle(el);
    const out = {
      top: parseFloat(cs.paddingTop) || 0,
      right: parseFloat(cs.paddingRight) || 0,
      bottom: parseFloat(cs.paddingBottom) || 0,
      left: parseFloat(cs.paddingLeft) || 0,
    };
    el.remove();
    return out;
  } catch {
    return { top: 0, bottom: 0, left: 0, right: 0 };
  }
}

/** hide / show the Android system bars (no-op in the browser) */
export function setImmersive(on: boolean): void {
  try {
    window.PixelBridge?.setImmersive?.(on);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------- C3 本地 AI 端口服务
// 这四个是 android/AiServer.java 的声明面（浏览器 / PWA / Node 里全都没有 → 一律降级 null / false）。
// 注意 `aiServerStart` 是**同步**返回 token 的：Java 侧绑定成功才回一个非空串，失败回 ""。
// 生命周期（何时调、token 怎么用）在 src/app/ai-serve.ts；这里只管「安全地调一次桥接」。

/** 起端口服务；返回 Java 生成的新 token，失败（或没有桥接）返回 "" */
export function aiServerStart(port: number): string {
  try {
    const t = window.PixelBridge?.aiServerStart?.(Math.round(port));
    return typeof t === "string" ? t : "";
  } catch {
    return "";
  }
}

/** 停端口服务（没有桥接时是空操作） */
export function aiServerStop(): void {
  try {
    window.PixelBridge?.aiServerStop?.();
  } catch { /* ignore */ }
}

/** Java 侧的实况 JSON 原文；没有桥接时返回 "" */
export function aiServerStatus(): string {
  try {
    const raw = window.PixelBridge?.aiServerStatus?.();
    return typeof raw === "string" ? raw : "";
  } catch {
    return "";
  }
}

/** 交付一条异步响应；false = 超时 / 已经交付过（调用方应记进诊断，不要重试） */
export function aiRespond(requestId: string, json: string): boolean {
  try {
    return window.PixelBridge?.aiRespond?.(String(requestId), String(json)) === true;
  } catch {
    return false;
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

/** short haptic tick. Uses the native bridge first, then the WebView's own
 *  navigator.vibrate (both need android.permission.VIBRATE, which the app
 *  declares). Failures are silent: vibration is only a nicety.
 *  `tag` names the call site so the diagnostics line can show which gesture
 *  actually reached the vibrator (and with which duration). */
export function vibrate(ms: number, tag = "调用"): boolean {
  const d = Math.max(10, Math.min(200, Math.round(ms)));
  let ok = false;
  try {
    const b = window.PixelBridge;
    if (b?.vibrate) ok = b.vibrate(d) === true; // native answer, synchronously
  } catch { ok = false; }
  if (!ok) {
    try {
      const nav = navigator as Navigator & { vibrate?: (p: number | number[]) => boolean };
      if (nav.vibrate) ok = nav.vibrate(d);
    } catch { /* ignore */ }
  }
  lastVibrateResult = ok;
  lastVibrateTag = tag;
  hapticLog.push({ tag, ms: d, ok });
  if (hapticLog.length > 12) hapticLog.shift();
  return ok;
}

/** result of the most recent vibrate() call (diagnostics) */
export let lastVibrateResult: boolean | null = null;
export let lastVibrateTag = "";

export interface HapticEvent { tag: string; ms: number; ok: boolean }
/** newest-last ring of the last haptic calls (diagnostics) */
export const hapticLog: HapticEvent[] = [];

/** the recent haptic calls as one short string, newest last */
export function hapticLogText(): string {
  if (!hapticLog.length) return "无";
  return hapticLog.slice(-4).map((e) => e.tag + ":" + e.ms + (e.ok ? "" : "✗")).join(" / ");
}

/** one-line report of the vibration-related environment (diagnostics).
 *  `pref` carries the live setting so the line also proves the switch state. */
export function hapticReport(pref?: { on: boolean; len: number }): string {
  const hasBridge = !!window.PixelBridge;
  const hasVib = !!(window.PixelBridge && typeof window.PixelBridge.vibrate === "function");
  const motor = canVibrate();
  return (pref ? "开关=" + (pref.on ? "ON" : "OFF") + " · 时长=" + pref.len + "ms · " : "") +
    "桥接=" + (hasBridge ? "有" : "无") +
    " · 震动接口=" + (hasVib ? "有" : "无") +
    " · 马达=" + (motor === null ? "未知" : String(motor)) +
    " · 调用=" + hapticLog.length + " 次（最近 " + hapticLogText() + "）";
}

/** true when the device reports a usable vibrator (null = unknown) */
export function canVibrate(): boolean | null {
  try {
    const b = window.PixelBridge;
    if (b?.hasVibrator) return !!b.hasVibrator();
  } catch { /* ignore */ }
  try {
    return typeof (navigator as Navigator & { vibrate?: unknown }).vibrate === "function";
  } catch { /* ignore */ }
  return null;
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
