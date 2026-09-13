// 像素重采样（高级缩放）——纯函数、无 DOM，可在 node 里直接跑。
//
// 六个算法：
//   nearest   最近邻：与老版 `ops.scaleDocSprite` 逐像素一致（默认，向后兼容）
//   bilinear  双线性：平滑
//   bicubic   双三次（Catmull-Rom）：更平滑，边界按钳制取值
//   area      区域平均：**缩小**时最好，每个目标像素对源区域做 alpha 加权平均
//   scale2x   Scale2x / EPX：像素画专用 2× 放大，保留硬边（其余比例安全降级）
//   scale3x   Scale3x：像素画专用 3× 放大（其余比例安全降级）
//
// 两条硬规则：
//   1. **颜色插值一律在预乘 alpha 空间做**。直接对 R/G/B 求平均会把透明像素
//      （RGB 常常是 0 或旧颜色）也平均进去，于是透明边缘周围出现黑边 / 彩边；
//      先乘 alpha 再插值、最后除回去，边缘才干净。`cleanTransparent` 是额外的
//      一道保险：把 alpha===0 的像素 RGB 直接清零，导出 / 再缩放都不会串色。
//   2. **输入缓冲区绝不被修改**：所有函数只读 src，结果写进新分配的数组。

/** 重采样算法 id */
export type ResampleAlgo = "nearest" | "bilinear" | "bicubic" | "area" | "scale2x" | "scale3x";

export interface AlgoMeta {
  id: ResampleAlgo;
  /** 像素画专用算法（scale2x / scale3x）——只支持整数倍，其它比例降级到最近邻 */
  pixelArt: boolean;
  /** 只在这些整数倍下可用；null = 任意比例都行 */
  onlyExactFactor: number | null;
  /** i18n 键：算法名；UI 用 t(meta.nameKey) 生成选项，不在 UI 里硬编码算法分支 */
  nameKey: string;
  /** i18n 键：一句话说明（选中项下面显示） */
  descKey: string;
}

/** 供 UI 生成选项的算法清单（顺序＝对话框里的显示顺序，nearest 是默认项） */
export const SCALE_ALGOS: readonly AlgoMeta[] = [
  { id: "nearest", pixelArt: false, onlyExactFactor: null, nameKey: "scaleAlgoNearest", descKey: "scaleNearestDesc" },
  { id: "bilinear", pixelArt: false, onlyExactFactor: null, nameKey: "scaleAlgoBilinear", descKey: "scaleBilinearDesc" },
  { id: "bicubic", pixelArt: false, onlyExactFactor: null, nameKey: "scaleAlgoBicubic", descKey: "scaleBicubicDesc" },
  { id: "area", pixelArt: false, onlyExactFactor: null, nameKey: "scaleAlgoArea", descKey: "scaleAreaDesc" },
  { id: "scale2x", pixelArt: true, onlyExactFactor: 2, nameKey: "scaleAlgo2x", descKey: "scale2xDesc" },
  { id: "scale3x", pixelArt: true, onlyExactFactor: 3, nameKey: "scaleAlgo3x", descKey: "scale3xDesc" },
];

const META_OF: Record<ResampleAlgo, AlgoMeta> = {
  nearest: SCALE_ALGOS[0], bilinear: SCALE_ALGOS[1], bicubic: SCALE_ALGOS[2],
  area: SCALE_ALGOS[3], scale2x: SCALE_ALGOS[4], scale3x: SCALE_ALGOS[5],
};

/** 该算法在这一组尺寸下能不能用（scale2x/scale3x 只接受 2×/3× 整数倍） */
export function algoSupported(algo: ResampleAlgo, sw: number, sh: number, dw: number, dh: number): boolean {
  const meta = META_OF[algo];
  if (!meta) return false;
  if (meta.onlyExactFactor === null) return true;
  const k = meta.onlyExactFactor;
  return dw === sw * k && dh === sh * k;
}

/** 实际会用的算法：不支持的自动降级到 nearest（UI 提示用同一个函数判断） */
export function effectiveAlgo(algo: ResampleAlgo, sw: number, sh: number, dw: number, dh: number): ResampleAlgo {
  return algoSupported(algo, sw, sh, dw, dh) ? algo : "nearest";
}

/** 缩放倍率（预览里标注用；不整除就返回小数） */
export function scaleFactor(sw: number, sh: number, dw: number, dh: number): { fx: number; fy: number } {
  return { fx: sw > 0 ? dw / sw : 1, fy: sh > 0 ? dh / sh : 1 };
}

export interface ResampleOpts {
  /** alpha === 0 的像素把 RGB 清零（避免导出 / 半透明缩放时出现黑边、彩边） */
  cleanTransparent?: boolean;
}

/** 尺寸上限沿用全项目约定 1..1024 */
export const MAX_SIZE = 1024;

function clampInt(v: number, lo: number, hi: number): number {
  const n = Math.round(v);
  return n < lo ? lo : n > hi ? hi : n;
}

/** 目标尺寸与源尺寸都合法才继续（非法输入返回一个安全的空结果） */
function dimsOk(sw: number, sh: number, dw: number, dh: number, srcLen: number): boolean {
  return sw > 0 && sh > 0 && dw > 0 && dh > 0
    && sw <= MAX_SIZE && sh <= MAX_SIZE && dw <= MAX_SIZE && dh <= MAX_SIZE
    && srcLen >= sw * sh * 4;
}

/** alpha===0 的像素把 RGB 清零（原地，只动 dst） */
function cleanRgb(data: Uint8ClampedArray, n: number): void {
  for (let i = 0; i < n; i += 4) {
    if (data[i + 3] === 0) { data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; }
  }
}

/** nearest 的映射：与 `ops.scaleDocSprite` 完全一致（floor 映射 + 末尾钳制），
 *  写成表是为了避免在 dw*dh 的双重循环里重复做浮点除法。 */
function nearestAxisMap(sn: number, dn: number, out: Int32Array): void {
  for (let i = 0; i < dn; i++) {
    const v = Math.floor((i * sn) / dn);
    out[i] = v < 0 ? 0 : v > sn - 1 ? sn - 1 : v;
  }
}

function nearestTo(src: Uint8ClampedArray, sw: number, sh: number, dw: number, dh: number, dst: Uint8ClampedArray): void {
  const xm = new Int32Array(dw);
  nearestAxisMap(sw, dw, xm);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / dh));
    const srow = sy * sw;
    const drow = y * dw;
    for (let x = 0; x < dw; x++) {
      const si = (srow + xm[x]) * 4;
      const di = (drow + x) * 4;
      dst[di] = src[si];
      dst[di + 1] = src[si + 1];
      dst[di + 2] = src[si + 2];
      dst[di + 3] = src[si + 3];
    }
  }
}

/**
 * 双线性：目标像素中心（i+0.5 映射回源空间）周围 4 个源像素按距离加权。
 * 颜色在**预乘 alpha** 空间加权（见文件头注释 1），alpha 单独加权。
 * 源坐标越界时钳到边缘像素。
 */
function bilinearTo(src: Uint8ClampedArray, sw: number, sh: number, dw: number, dh: number, dst: Uint8ClampedArray): void {
  for (let y = 0; y < dh; y++) {
    const fy = ((y + 0.5) * sh) / dh - 0.5;
    const y0f = Math.floor(fy);
    const ty = fy - y0f;
    const y0 = y0f < 0 ? 0 : y0f > sh - 1 ? sh - 1 : y0f;
    const y1 = y0f + 1 < 0 ? 0 : y0f + 1 > sh - 1 ? sh - 1 : y0f + 1;
    const r0 = y0 * sw * 4, r1 = y1 * sw * 4;
    for (let x = 0; x < dw; x++) {
      const fx = ((x + 0.5) * sw) / dw - 0.5;
      const x0f = Math.floor(fx);
      const tx = fx - x0f;
      const x0 = x0f < 0 ? 0 : x0f > sw - 1 ? sw - 1 : x0f;
      const x1 = x0f + 1 < 0 ? 0 : x0f + 1 > sw - 1 ? sw - 1 : x0f + 1;
      const a0 = r0 + x0 * 4, a1 = r0 + x1 * 4, b0 = r1 + x0 * 4, b1 = r1 + x1 * 4;
      // premultiplied samples
      const pa0 = src[a0 + 3], pa1 = src[a1 + 3], pb0 = src[b0 + 3], pb1 = src[b1 + 3];
      const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
      const a = src[a0 + 3] * w00 + src[a1 + 3] * w10 + src[b0 + 3] * w01 + src[b1 + 3] * w11;
      const pr = src[a0] * pa0 * w00 + src[a1] * pa1 * w10 + src[b0] * pb0 * w01 + src[b1] * pb1 * w11;
      const pg = src[a0 + 1] * pa0 * w00 + src[a1 + 1] * pa1 * w10 + src[b0 + 1] * pb0 * w01 + src[b1 + 1] * pb1 * w11;
      const pb = src[a0 + 2] * pa0 * w00 + src[a1 + 2] * pa1 * w10 + src[b0 + 2] * pb0 * w01 + src[b1 + 2] * pb1 * w11;
      const di = (y * dw + x) * 4;
      if (a <= 0) {
        dst[di] = 0; dst[di + 1] = 0; dst[di + 2] = 0; dst[di + 3] = 0;
      } else {
        dst[di] = pr / a; dst[di + 1] = pg / a; dst[di + 2] = pb / a; dst[di + 3] = a;
      }
    }
  }
}

/** Catmull-Rom 三次核（a = -0.5） */
function cubic(t: number): number {
  const at = t < 0 ? -t : t;
  if (at < 1) return 1.5 * at * at * at - 2.5 * at * at + 1;
  if (at < 2) return -0.5 * at * at * at + 2.5 * at * at - 4 * at + 2;
  return 0;
}

/**
 * 双三次（Catmull-Rom 样条）：4×4 邻域，权重和恒为 1（纯色下逐字节恒等）。
 * 每个源坐标越界时**钳制到边缘**（不是补零——补零会让画布边缘出现一圈暗边）。
 * 同样在预乘 alpha 空间做加权。
 */
function bicubicTo(src: Uint8ClampedArray, sw: number, sh: number, dw: number, dh: number, dst: Uint8ClampedArray): void {
  // 权重表：每个目标下标只需要 4 个权重 + 4 个源下标
  const wx = new Float64Array(dw * 4);
  const ix = new Int32Array(dw * 4);
  const wy = new Float64Array(dh * 4);
  const iy = new Int32Array(dh * 4);
  const axis = (sn: number, dn: number, w: Float64Array, ixOut: Int32Array): void => {
    for (let i = 0; i < dn; i++) {
      const f = ((i + 0.5) * sn) / dn - 0.5;
      const base = Math.floor(f);
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        const wk = cubic(f - (base - 1 + k));
        w[i * 4 + k] = wk;
        sum += wk;
      }
      for (let k = 0; k < 4; k++) {
        w[i * 4 + k] /= sum; // 归一化，保证纯色恒等
        const sx = base - 1 + k;
        ixOut[i * 4 + k] = sx < 0 ? 0 : sx > sn - 1 ? sn - 1 : sx;
      }
    }
  };
  axis(sw, dw, wx, ix);
  axis(sh, dh, wy, iy);
  for (let y = 0; y < dh; y++) {
    const drow = y * dw * 4;
    for (let x = 0; x < dw; x++) {
      let a = 0, pr = 0, pg = 0, pb = 0;
      for (let j = 0; j < 4; j++) {
        const wyj = wy[y * 4 + j];
        if (wyj === 0) continue;
        const srow = iy[y * 4 + j] * sw * 4;
        for (let k = 0; k < 4; k++) {
          const w = wyj * wx[x * 4 + k];
          if (w === 0) continue;
          const si = srow + ix[x * 4 + k] * 4;
          const sa = src[si + 3];
          const sw2 = w * sa; // premultiplied weight
          a += sa * w;
          pr += src[si] * sw2;
          pg += src[si + 1] * sw2;
          pb += src[si + 2] * sw2;
        }
      }
      const di = drow + x * 4;
      if (a <= 0) {
        dst[di] = 0; dst[di + 1] = 0; dst[di + 2] = 0; dst[di + 3] = 0;
      } else {
        dst[di] = pr / a; dst[di + 1] = pg / a; dst[di + 2] = pb / a; dst[di + 3] = a;
      }
    }
  }
}

/**
 * 区域平均（盒式 / area）。做法是通用的「覆盖率加权」：
 * 目标像素在源空间里覆盖 [x*sw/dw, (x+1)*sw/dw)，与每个源像素的重叠长度就是权重。
 * 缩小（一个目标像素盖住多个源像素）＝真正的面积平均，不会像最近邻那样丢细节；
 * 放大时一个源像素被拆到多个目标像素上，退化成块状平铺，与直觉一致。
 * 权重里再乘源像素的 alpha（预乘空间平均），所以透明区域的 RGB 不会污染结果。
 */
function areaTo(src: Uint8ClampedArray, sw: number, sh: number, dw: number, dh: number, dst: Uint8ClampedArray): void {
  // 权重按「每个目标下标一段连续区间」存放：缩小 100 倍也不会溢出，
  // 表里没有对象、没有每像素分配（只有两个数组 + 一个 offset 表）。
  const axis = (sn: number, dn: number): { off: Int32Array; n: Int32Array; idx: Int32Array; w: Float64Array } => {
    const off = new Int32Array(dn + 1);
    const n = new Int32Array(dn);
    const scale = sn / dn;
    let total = 0;
    for (let i = 0; i < dn; i++) {
      const s = i * scale, e = s + scale;
      let a = Math.floor(s);
      let b = Math.ceil(e);
      if (a < 0) a = 0;
      if (b > sn) b = sn;
      if (b <= a) b = Math.min(sn, a + 1);
      n[i] = b - a;
      off[i] = total;
      total += b - a;
    }
    off[dn] = total;
    const idx = new Int32Array(total);
    const w = new Float64Array(total);
    for (let i = 0; i < dn; i++) {
      const s = i * scale, e = s + scale;
      let a = Math.floor(s);
      if (a < 0) a = 0;
      const cnt = n[i];
      let sum = 0;
      for (let k = 0; k < cnt; k++) {
        const sIdx = a + k;
        const cov = Math.min(e, sIdx + 1) - Math.max(s, sIdx);
        idx[off[i] + k] = sIdx;
        w[off[i] + k] = cov > 0 ? cov : 0;
        sum += w[off[i] + k];
      }
      // 极端比例（dn > sn）时重叠可能算出 0：兜底给最近的一个源像素全权重
      if (sum <= 0) {
        const nearest = Math.min(sn - 1, Math.max(0, Math.floor(s)));
        idx[off[i]] = nearest;
        w[off[i]] = 1;
      }
    }
    return { off, n, idx, w };
  };
  const ax = axis(sw, dw);
  const ay = axis(sh, dh);
  for (let y = 0; y < dh; y++) {
    const yo = ay.off[y], yn = ay.n[y];
    for (let x = 0; x < dw; x++) {
      const xo = ax.off[x], xn = ax.n[x];
      let wsum = 0, aSum = 0, pr = 0, pg = 0, pb = 0;
      for (let j = 0; j < yn; j++) {
        const wy = ay.w[yo + j];
        if (wy <= 0) continue;
        const srow = ay.idx[yo + j] * sw * 4;
        for (let k = 0; k < xn; k++) {
          const wx = ax.w[xo + k];
          if (wx <= 0) continue;
          const sx = ax.idx[xo + k];
          const si = srow + sx * 4;
          const w = wx * wy;
          const sa = src[si + 3];
          wsum += w;
          aSum += sa * w;
          const pw = w * sa; // premultiplied
          pr += src[si] * pw;
          pg += src[si + 1] * pw;
          pb += src[si + 2] * pw;
        }
      }
      const di = (y * dw + x) * 4;
      if (wsum <= 0 || aSum <= 0) {
        dst[di] = 0; dst[di + 1] = 0; dst[di + 2] = 0; dst[di + 3] = 0;
      } else {
        dst[di] = pr / aSum;
        dst[di + 1] = pg / aSum;
        dst[di + 2] = pb / aSum;
        dst[di + 3] = aSum / wsum;
      }
    }
  }
}

/** 把 RGBA 读成一个可直接比较的整数（邻域比较不用每像素开数组） */
function loadPx(d: Uint8ClampedArray, i: number): number {
  return d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24);
}
function storePx(d: Uint8ClampedArray, i: number, v: number): void {
  d[i] = v & 255;
  d[i + 1] = (v >>> 8) & 255;
  d[i + 2] = (v >>> 16) & 255;
  d[i + 3] = (v >>> 24) & 255;
}

/**
 * Scale2x（2×）——公开规则（Andrea Mazzoleni 的 Scale2x；与 Eric 的 EPX 等价）：
 *   E0 = D == B && B != F && D != H ? D : E
 *   E1 = B == F && B != D && F != H ? F : E
 *   E2 = D == H && D != B && H != F ? D : E
 *   E3 = H == F && D != H && B != F ? F : E
 * 其中 E 是当前像素，B/D/F/H 是上下左右（画布外按边缘钳制，等于把边界像素自己当邻居）。
 *
 * **关键在于「先相等才改」**：只有当某个邻居和另一个邻居相等、且和当前像素不同
 * 时，那一格才改成邻居的颜色；否则一律保留当前像素。所以
 *   - 孤立像素（上下左右四色各不相同）会原样长成 2×2 实心块，绝不被邻居瓜分掉；
 *   - 1 像素宽的斜线不会长毛刺；纯色块内部也不会有任何变化。
 * 曾经写成「B!=H && D!=F 就把四格全换成邻居」是错的：那会让孤立像素整个消失
 * （四格分别被四个邻居占掉），tests/scale.test.ts 里有专门钉这个 case 的断言。
 *
 * 全部用整数比较（含 alpha，全透明算同色），**不做任何颜色混合**——硬边原样保留。
 * 只在 dw===sw*2 && dh===sh*2 时调用（调度层已保证）。
 */
function scale2xTo(src: Uint8ClampedArray, sw: number, sh: number, dst: Uint8ClampedArray): void {
  const dw = sw * 2;
  for (let y = 0; y < sh; y++) {
    const ym = y > 0 ? y - 1 : y;
    const yp = y < sh - 1 ? y + 1 : y;
    const rm = ym * sw * 4, rc = y * sw * 4, rp = yp * sw * 4;
    const dm0 = y * 2 * dw * 4, dm1 = dm0 + dw * 4;
    for (let x = 0; x < sw; x++) {
      const xm = x > 0 ? x - 1 : x;
      const xp = x < sw - 1 ? x + 1 : x;
      const e = loadPx(src, rc + x * 4);
      const b = loadPx(src, rm + x * 4);
      const h = loadPx(src, rp + x * 4);
      const d = loadPx(src, rc + xm * 4);
      const f = loadPx(src, rc + xp * 4);
      const c0 = d === b && b !== f && d !== h;
      const c1 = b === f && b !== d && f !== h;
      const c2 = d === h && d !== b && h !== f;
      const c3 = h === f && d !== h && b !== f;
      const o = x * 2 * 4;
      storePx(dst, dm0 + o, c0 ? d : e);
      storePx(dst, dm0 + o + 4, c1 ? f : e);
      storePx(dst, dm1 + o, c2 ? d : e);
      storePx(dst, dm1 + o + 4, c3 ? f : e);
    }
  }
}

/**
 * Scale3x（3×）——公开规则（scale2x 项目 `scale3x.c` 的 C 实现直译）：
 *   A B C        输出 3×3：E0 E1 E2 / E3 E4 E5 / E6 E7 E8（E4 永远是 E）
 *   D E F
 *   G H I        先判外层条件 guard = (B != H && D != F)：
 *
 *   guard 为假 → 九格全部保留 E（和 Scale2x 一样：没有"对角冲突"就不动）
 *   guard 为真 → E0 = D == B                             ? D : E
 *                E1 = (D==B && E!=C) || (F==B && E!=A)   ? B : E
 *                E2 = F == B                             ? F : E
 *                E3 = (D==B && E!=G) || (D==H && E!=A)   ? D : E
 *                E5 = (F==B && E!=I) || (F==H && E!=C)   ? F : E
 *                E6 = D == H                             ? D : E
 *                E7 = (D==H && E!=I) || (F==H && E!=G)   ? H : E
 *                E8 = F == H                             ? F : E
 *
 * E1/E3/E5/E7 里的 `E!=<对角>` 项不能漏：斜角邻居只有"顺着边接过来"时才补，
 * 漏掉就变成"只要 guard 成立就把邻居糊进四边"，孤立像素会被糊掉、线条会长毛刺。
 * 画布外邻居按边缘钳制（第一行 B:=E、最后一行 H:=E、最左列 D:=E、最右列 F:=E），
 * 与 C 实现里对首末像素的特判逐字节等价。
 * 同样只做整数比较、不混合颜色。只在 dw===sw*3 && dh===sh*3 时调用。
 */
function scale3xTo(src: Uint8ClampedArray, sw: number, sh: number, dst: Uint8ClampedArray): void {
  const dw = sw * 3;
  for (let y = 0; y < sh; y++) {
    const ym = y > 0 ? y - 1 : y;
    const yp = y < sh - 1 ? y + 1 : y;
    const rm = ym * sw * 4, rc = y * sw * 4, rp = yp * sw * 4;
    const d0 = y * 3 * dw * 4;
    const d1 = d0 + dw * 4;
    const d2 = d1 + dw * 4;
    for (let x = 0; x < sw; x++) {
      const xm = x > 0 ? x - 1 : x;
      const xp = x < sw - 1 ? x + 1 : x;
      // 3x3 neighbourhood: A B C / D E F / G H I
      const e = loadPx(src, rc + x * 4);
      const b = loadPx(src, rm + x * 4);
      const d = loadPx(src, rc + xm * 4);
      const f = loadPx(src, rc + xp * 4);
      const h = loadPx(src, rp + x * 4);
      const a = loadPx(src, rm + xm * 4);
      const c = loadPx(src, rm + xp * 4);
      const g = loadPx(src, rp + xm * 4);
      const i2 = loadPx(src, rp + xp * 4);
      const o = x * 3 * 4;
      const db = d === b, fb = f === b, dh = d === h, fh = f === h;
      let e0 = e, e1 = e, e2 = e, e3 = e, e5 = e, e6 = e, e7 = e, e8 = e;
      if (b !== h && d !== f) {
        e0 = db ? d : e;
        e1 = (db && e !== c) || (fb && e !== a) ? b : e;
        e2 = fb ? f : e;
        e3 = (db && e !== g) || (dh && e !== a) ? d : e;
        e5 = (fb && e !== i2) || (fh && e !== c) ? f : e;
        e6 = dh ? d : e;
        e7 = (dh && e !== i2) || (fh && e !== g) ? h : e;
        e8 = fh ? f : e;
      }
      storePx(dst, d0 + o, e0);
      storePx(dst, d0 + o + 4, e1);
      storePx(dst, d0 + o + 8, e2);
      storePx(dst, d1 + o, e3);
      storePx(dst, d1 + o + 4, e);
      storePx(dst, d1 + o + 8, e5);
      storePx(dst, d2 + o, e6);
      storePx(dst, d2 + o + 4, e7);
      storePx(dst, d2 + o + 8, e8);
    }
  }
}

/**
 * 统一入口：把 sw×sh 的 RGBA 缓冲区重采样成 dw×dh。
 *
 * - `src` 只读，绝不被修改；返回新分配的 Uint8ClampedArray（长度 dw*dh*4，行主序）。
 * - 不支持的算法（scale2x/scale3x 遇到非整数倍）**安全降级到 nearest**，
 *   想知道有没有降级请先用 `effectiveAlgo()` / `algoSupported()`。
 * - 尺寸非法（0 / 超 1024 / 缓冲区不够长）时不抛异常，返回全透明结果，调用方好收尾。
 */
export function resamplePixels(
  src: Uint8ClampedArray,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
  algo: ResampleAlgo = "nearest",
  opts?: ResampleOpts,
): Uint8ClampedArray {
  // 尺寸校验放在分配之前：越界的 dw/dh 一律先钳进 1..1024，
  // 免得一个手滑的入参（比如 10 万）先吃掉一大块内存再报错。
  const W = clampInt(dw, 0, MAX_SIZE);
  const H = clampInt(dh, 0, MAX_SIZE);
  if (W <= 0 || H <= 0) return new Uint8ClampedArray(0);
  const dst = new Uint8ClampedArray(W * H * 4);
  if (!dimsOk(sw, sh, W, H, src.length)) return dst;
  const use = effectiveAlgo(algo, sw, sh, W, H);
  if (use === "bilinear") bilinearTo(src, sw, sh, W, H, dst);
  else if (use === "bicubic") bicubicTo(src, sw, sh, W, H, dst);
  else if (use === "area") areaTo(src, sw, sh, W, H, dst);
  // scale2x / scale3x 的写入尺寸就是 sw*2 / sh*3，只在这一组尺寸下调用
  // （effectiveAlgo 已经保证了 W===sw*k && H===sh*k）
  else if (use === "scale2x" && W === sw * 2 && H === sh * 2) scale2xTo(src, sw, sh, dst);
  else if (use === "scale3x" && W === sw * 3 && H === sh * 3) scale3xTo(src, sw, sh, dst);
  else nearestTo(src, sw, sh, W, H, dst);
  if (opts?.cleanTransparent) cleanRgb(dst, dst.length);
  return dst;
}

/**
 * 在**同一张画布内**重采样一块矩形（选区缩放用）：把 src 的 (sx, sy, rw, rh)
 * 区域重采样到同尺寸缓冲区，供调用方贴回选区位置。
 * 选区外的内容由调用方决定（本函数只看这一块）。
 */
export function resampleRegion(
  src: Uint8ClampedArray,
  sw: number,
  sh: number,
  sx: number,
  sy: number,
  rw: number,
  rh: number,
  dw: number,
  dh: number,
  algo: ResampleAlgo = "nearest",
  opts?: ResampleOpts,
): Uint8ClampedArray {
  const rwI = clampInt(rw, 1, MAX_SIZE);
  const rhI = clampInt(rh, 1, MAX_SIZE);
  const patch = new Uint8ClampedArray(rwI * rhI * 4);
  for (let y = 0; y < rhI; y++) {
    for (let x = 0; x < rwI; x++) {
      const sxp = clampInt(sx + x, 0, sw - 1);
      const syp = clampInt(sy + y, 0, sh - 1);
      const si = (syp * sw + sxp) * 4;
      const di = (y * rwI + x) * 4;
      patch[di] = src[si];
      patch[di + 1] = src[si + 1];
      patch[di + 2] = src[si + 2];
      patch[di + 3] = src[si + 3];
    }
  }
  return resamplePixels(patch, rwI, rhI, dw, dh, algo, opts);
}
