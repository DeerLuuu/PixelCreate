/** Minimal base64 for byte arrays (pure: works in the browser and in Node). */
const T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToB64(bytes: Uint8Array | Uint8ClampedArray): string {
  let out = "";
  const n = bytes.length;
  for (let i = 0; i < n; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < n ? bytes[i + 1] : 0;
    const b2 = i + 2 < n ? bytes[i + 2] : 0;
    out += T[b0 >> 2] + T[((b0 & 3) << 4) | (b1 >> 4)] + (i + 1 < n ? T[((b1 & 15) << 2) | (b2 >> 6)] : "=") + (i + 2 < n ? T[b2 & 63] : "=");
  }
  return out;
}

const IDX = (() => {
  const m = new Int16Array(128).fill(-1);
  for (let i = 0; i < T.length; i++) m[T.charCodeAt(i)] = i;
  return m;
})();

export function b64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, "");
  const len = Math.floor((clean.length * 3) / 4);
  const out = new Uint8Array(len);
  let p = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = IDX[clean.charCodeAt(i)] ?? 0;
    const c1 = IDX[clean.charCodeAt(i + 1)] ?? 0;
    const c2 = IDX[clean.charCodeAt(i + 2)] ?? 0;
    const c3 = IDX[clean.charCodeAt(i + 3)] ?? 0;
    if (p < len) out[p++] = (c0 << 2) | (c1 >> 4);
    if (p < len) out[p++] = ((c1 & 15) << 4) | (c2 >> 2);
    if (p < len) out[p++] = ((c2 & 3) << 6) | c3;
  }
  return out;
}
