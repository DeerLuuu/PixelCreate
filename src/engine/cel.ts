// A Cel is one layer × one frame: a full-size RGBA pixel buffer.
import { writePixel } from "./color";

export class Cel {
  readonly w: number;
  readonly h: number;
  data: Uint8ClampedArray;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.data = new Uint8ClampedArray(w * h * 4);
  }

  idx(x: number, y: number): number {
    return (y * this.w + x) * 4;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  setPixel(x: number, y: number, c: [number, number, number, number]): void {
    if (!this.inBounds(x, y)) return;
    writePixel(this.data, this.idx(x, y), c);
  }

  hasAnyOpaque(): boolean {
    const d = this.data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
    return false;
  }

  clone(): Cel {
    const c = new Cel(this.w, this.h);
    c.data.set(this.data);
    return c;
  }

  equals(other: Cel): boolean {
    return this.data.length === other.data.length && this.data.every((v, i) => v === other.data[i]);
  }
}
