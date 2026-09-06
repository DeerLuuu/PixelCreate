// Read GIF animation frames via the vendored omggif GifReader.
declare global {
  interface Window {
    GifReader: new (buf: Uint8Array) => {
      width: number;
      height: number;
      numFrames(): number;
      frameInfo(i: number): { delay: number };
      decodeAndBlitFrameRGBA(i: number, pixels: Uint8Array): void;
    };
  }
}

export interface GifData {
  w: number;
  h: number;
  delays: number[];
  frames: Uint8Array[]; // RGBA buffers per frame
}

export function tryReadGif(bytes: Uint8Array): GifData | null {
  const Reader = window.GifReader;
  if (!Reader) return null;
  try {
    const head = String.fromCharCode.apply(null, bytes.subarray(0, 6) as unknown as number[]);
    if (head !== "GIF89a" && head !== "GIF87a") return null;
    const r = new Reader(bytes);
    const w = r.width, h = r.height;
    const n = r.numFrames();
    if (!n || w <= 0 || h <= 0 || w * h * 4 > 1 << 28) return null;
    const frames: Uint8Array[] = [];
    const delays: number[] = [];
    for (let i = 0; i < n; i++) {
      const buf = new Uint8Array(w * h * 4);
      r.decodeAndBlitFrameRGBA(i, buf);
      frames.push(buf);
      delays.push(r.frameInfo(i)?.delay ? r.frameInfo(i).delay * 10 : 100);
    }
    return { w, h, delays, frames };
  } catch {
    return null;
  }
}
